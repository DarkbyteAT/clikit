/**
 * Kit sculpt relief: one solid modelled out of another. A base solid (a head) takes any number of marks, each a
 * small solid pressed on with its own fillet (a nose, a brow ridge, an ear) or pressed in (an eye socket, the
 * line of a gill), and the result is again one `Solid` of kit/sculpt.js: one distance, one owner, one set of
 * bounds. The sampler then sees a head, not a head and nine lumps, so every mark blends with every other where
 * they overlap (the sampler fillets only the two solids nearest a node), and a mark may be thinner than a grid
 * cell without being dropped.
 *
 * Owns:  `Kit.sculpt.relief` (a base and its marks -> a solid), `Kit.sculpt.smoothMax` and the `RELIEF` tunables.
 * Does not own: sampling or meshing (kit/sculpt.js), which features of a body are marks (kit/body-surface.js
 *        says so per feature; kit/figure-sculpt.js gathers them per bone), or what a face is (kit/body-face.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-faces.js.
 */
(() => {
  /** Tunables, metres. */
  const RELIEF = Object.freeze({
    /** A mark's fillet when it states none: this share of its own half-thickness, within [leastBlend, mostBlend]. */
    blendShare: 1.2,
    leastBlend: 0.004,
    mostBlend: 0.05,
    /** A pressed-in mark is not cut where the base is deeper than this: the nodes there are far inside either way. */
    deepest: 0.15,
  });

  const fail = (message) => {
    throw new Error(`Kit.sculpt.relief: ${message}`);
  };

  /**
   * The larger of two distances, rounded where they meet: the counterpart of `Kit.sculpt.smoothMin`, for what is
   * left of one solid when another is taken out of it (`smoothMax(base, -cutter, radius)`).
   * @param {number} first
   * @param {number} second
   * @param {number} radius metres; 0 is a plain maximum (a crisp edge)
   * @returns {number} never more than `radius / 4` above the larger
   * @complexity O(1)
   * @example Kit.sculpt.smoothMax(-0.01, -0.01, 0.04) // 0: the rim of a dent is rounded off
   */
  const smoothMax = (first, second, radius) => -Kit.sculpt.smoothMin(-first, -second, radius);

  /** The distance from a point to a box (0 inside it): never more than the distance to anything the box holds. */
  const boxDistance = (min, max, x, y, z) => {
    const overX = Math.max(min[0] - x, 0, x - max[0]);
    const overY = Math.max(min[1] - y, 0, y - max[1]);
    const overZ = Math.max(min[2] - z, 0, z - max[2]);
    return Math.sqrt(overX * overX + overY * overY + overZ * overZ);
  };

  /**
   * @typedef {Object} ReliefMark
   * @property {Object} solid a `Solid` of kit/sculpt.js in the base's space (`Kit.sculpt.solid`)
   * @property {number} [blend] metres: how wide a fillet joins it to what is there (default: from its thickness, `RELIEF`)
   * @property {boolean} [carve=false] pressed in: the base loses what the mark holds, with the same fillet round the rim
   */

  /**
   * A base solid with marks pressed on and in, as one solid. Marks are applied in order, each to the result of
   * those before it, so two marks that overlap blend with each other as well as with the base. A mark is only
   * measured where it can change the answer (nearer than the surface so far plus its fillet), so a face of a
   * dozen marks costs a few extra distances near each and none elsewhere.
   * @param {Object} base a `Solid`; its owner, group, fillet and anything else it carries are kept
   * @param {ReliefMark[]} marks
   * @returns {Object} a `Solid`: the base's fields with `distance`, `min` and `max` of the whole, and `plain`,
   *   the base's own distance (what lies on the base, like cloth, may ask how far a mark stands off it)
   * @throws {Error} when a mark has no solid
   * @complexity O(1) to make; each distance is the base's plus those of the marks whose bounds are within reach of the point
   * @example const head = Kit.sculpt.relief(skull, [{ solid: nose, blend: 0.012 }, { solid: socket, blend: 0.01, carve: true }]);
   */
  const relief = (base, marks) => {
    if (!marks.length) return base;
    const rows = marks.map((mark, index) => {
      if (!mark || !mark.solid || typeof mark.solid.distance !== 'function') fail(`mark ${index} needs a \`solid\` (Kit.sculpt.solid); got ${JSON.stringify(mark)}.`);
      const blend = mark.blend === undefined ? Math.max(RELIEF.leastBlend, Math.min(RELIEF.mostBlend, mark.solid.thinness * RELIEF.blendShare)) : mark.blend;
      return { distance: mark.solid.distance, min: mark.solid.min, max: mark.solid.max, blend, isCarved: Boolean(mark.carve) };
    });
    const raised = rows.filter((row) => !row.isCarved);
    const min = [0, 1, 2].map((axis) => Math.min(base.min[axis], ...raised.map((row) => row.min[axis])));
    const max = [0, 1, 2].map((axis) => Math.max(base.max[axis], ...raised.map((row) => row.max[axis])));
    const { smoothMin } = Kit.sculpt;
    const baseDistance = base.distance;
    const count = rows.length;
    // Hot path (once per grid node near the base): an index loop over the marks, no allocation.
    const distance = (x, y, z) => {
      let nearest = baseDistance(x, y, z);
      for (let index = 0; index < count; index++) {
        const row = rows[index];
        const away = boxDistance(row.min, row.max, x, y, z);
        if (row.isCarved) {
          // A dent changes the answer only where the mark is nearer than its fillet past the surface, going inward.
          if (nearest < -RELIEF.deepest || away >= row.blend - nearest) continue;
          nearest = -smoothMin(-nearest, row.distance(x, y, z), row.blend);
        } else {
          // A bump changes it only where the mark is nearer than the surface so far plus its fillet.
          if (away >= nearest + row.blend) continue;
          nearest = smoothMin(nearest, row.distance(x, y, z), row.blend);
        }
      }
      return nearest;
    };
    return { ...base, distance, min, max, plain: baseDistance };
  };

  Kit.sculpt = Object.assign(Kit.sculpt || {}, { relief, smoothMax, RELIEF });
})();
