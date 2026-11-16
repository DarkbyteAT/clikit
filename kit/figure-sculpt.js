/**
 * Kit figure sculpt: a body bake as a few smooth, skinned surfaces instead of one rigid solid per bone. The
 * body's own solids are blended into one skin per paint (kit/sculpt.js), so limbs run into the torso and a
 * head into its neck; every painted region (a sleeve, trousers, hair) becomes a layer of its own, the same
 * surface pushed out and cut along the region's edge, so cloth has thickness and a hem instead of being a
 * colour on the skin. Each layer's vertices carry bone weights, so one mesh bends with the rig.
 *
 * Owns:  `Kit.figure.sculptLayers` (a bake and its layout -> the layers as plain arrays, and which layout
 *        pieces they replace), `SCULPT` (its tunables) and `restMatrices` (a bake's rest pose as bone matrices).
 * Does not own: the blending and meshing (kit/sculpt.js), what pieces a bake has (kit/figure-layout.js), the
 *        regions' predicates (kit/region.js, kit/body-surface.js), or THREE (kit/figure.js binds the arrays
 *        to skinned meshes).
 *
 * What is sculpted: the solids of the body itself and of its solid features (a nose, an ear). What stays rigid:
 * attached parts (a sword, a hat: thin and hard-edged, which a grid would blur) and flat stamps (a face).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-sculpt.js.
 */
(() => {
  /** Tunables, metres unless noted. */
  const SCULPT = Object.freeze({
    /** A solid's fillet is this share of its half-thickness, within [leastBlend, mostBlend]. */
    blendShare: 0.85,
    leastBlend: 0.004,
    mostBlend: 0.09,
    /** The widest fillet where a limb (or a head) joins the trunk: a neck and a shoulder stay a neck and a shoulder. */
    mostJoin: 0.025,
    /** The least a painted layer stands off the surface below it, so two layers never share a surface. */
    leastRaise: 0.004,
    layerGap: 0.003,
    /** Paint (a region with no raise: stripes, a trim, a tattoo) lies this far above the surface it is on. */
    paintLift: 0.0012,
    /** Ownership of a vertex fades from one bone to the next over this share of the nearer solid's fillet. */
    weightSpread: 0.03,
    /** A layer keeps what lies within this distance inside the surface it sits on (its cut edges), and drops the rest. */
    buriedDepth: 0.002,
    /** The sculpting pose swings a limb this far (radians) from the trunk when its joint is `fullSpreadAt` or more to the side; less when nearer; not at all within `midline`. */
    spread: 0.75,
    fullSpreadAt: 0.1,
    midline: 0.02,
    /** A limb shorter than this is not swung. */
    leastLimb: 0.02,
    /** At rest a limb's joints stand at least this share of their own half-thickness clear of the trunk; it opens by up to `mostOpen` radians, tried in `clearSteps` steps, to get there. */
    clearShare: 0.9,
    mostOpen: 0.7,
    clearSteps: 14,
  });
  const MATRIX = 16;
  const VECTOR = 3;
  const QUATERNION = 4;

  /**
   * A bake's rest pose as one column-major 4 x 4 matrix per bone, in the bake's own space (no grounding).
   * @param {Object} bake from a bakery
   * @param {Object} [pose] local joint transforms to use instead of the bake's rest pose
   * @returns {Float32Array} 16 per bone
   * @complexity O(bones)
   * @example const matrices = Kit.figure.restMatrices(bake); // bone b at matrices.subarray(b * 16, b * 16 + 16)
   */
  const restMatrices = (bake, pose = bake.rest) => {
    const { plan } = bake;
    const world = Kit.body.worldTransforms(plan, pose || Kit.body.createPose(plan), Kit.body.createPose(plan));
    const matrices = new Float32Array(plan.boneCount * MATRIX);
    for (let bone = 0; bone < plan.boneCount; bone++) Kit.figure.writeBoneMatrix(world, bone, matrices, bone * MATRIX);
    return matrices;
  };

  /**
   * The pose a body is sculpted in: its rest pose with every limb swung away from the trunk, as a modeller
   * stands a figure with its arms out before skinning it. At rest an arm hangs against the ribs and a blended
   * surface would weld the two; apart, each limb is sculpted whole and joins the trunk only at its own joint,
   * and the skin weights then bring it back down. A limb is a run of bones with one ink key
   * (`Kit.figure.inkKeyOf`); one on the body's midline (a head, a tail) is left where it is.
   * @param {Object} bake from a bakery
   * @returns {Object} local joint transforms (a `JointTransforms` of kit/rig.js), a copy
   * @complexity O(limbs x bones)
   * @example const matrices = Kit.figure.restMatrices(bake, Kit.figure.spreadPose(bake));
   */
  const spreadPose = (bake) => openedPose(bake, limbsOf(bake), (limb) => SCULPT.spread * Math.min(1, limb.offset / SCULPT.fullSpreadAt)).local;

  /**
   * @typedef {Object} Limb
   * @property {number} lead the limb's first bone (the one whose parent belongs to something else)
   * @property {number[]} bones the bones further along it
   * @property {number[]} direction unit [x, y, z]: where it points at rest, from its joint
   * @property {number[]} outward unit [x, y, z]: away from the trunk
   * @property {number} offset metres its joint is to the side of the root
   * @property {string} key its ink key ('arms-left')
   */

  /**
   * The limbs of a body that sit to one side of it: runs of bones with one ink key whose joint is off the
   * midline (arms, legs, wings; not a head or a tail).
   * @param {Object} bake from a bakery
   * @returns {Limb[]}
   * @complexity O(bones x limb length)
   * @example Kit.figure.limbsOf(bake).map((limb) => limb.key) // ['arms-left', 'arms-right', 'legs-left', 'legs-right']
   */
  const limbsOf = (bake) => {
    const { plan } = bake;
    const world = Kit.body.worldTransforms(plan, bake.rest, Kit.body.createPose(plan));
    const keys = Array.from({ length: plan.boneCount }, (_unused, bone) => Kit.figure.inkKeyOf(plan, bone));
    const at = (bone) => [world.translation[bone * VECTOR], world.translation[bone * VECTOR + 1], world.translation[bone * VECTOR + 2]];
    const limbs = [];
    for (let lead = 1; lead < plan.boneCount; lead++) {
      if (plan.parent[lead] < 0 || keys[plan.parent[lead]] === keys[lead] || keys[lead].startsWith('part:')) continue;
      const bones = [];
      for (let bone = lead + 1; bone < plan.subtreeEnd[lead]; bone++) if (keys[bone] === keys[lead]) bones.push(bone);
      if (!bones.length) continue;
      // Where the limb points: from its joint to the middle of the joints further along it.
      const joint = at(lead);
      const along = [0, 1, 2].map((axis) => bones.reduce((sum, bone) => sum + at(bone)[axis], 0) / bones.length - joint[axis]);
      const length = Math.hypot(...along);
      // Only sideways counts as "away from the trunk": a limb in front of or behind it (a tail, a neck) is on the midline.
      const offset = Math.abs(joint[0] - world.translation[0]);
      if (length < SCULPT.leastLimb || offset < SCULPT.midline) continue;
      limbs.push({ lead, bones, direction: along.map((value) => value / length), outward: [Math.sign(joint[0] - world.translation[0]), 0, 0], offset, key: keys[lead] });
    }
    return limbs;
  };

  /**
   * A bake's rest pose with each limb swung outward by an angle.
   * @param {Object} bake
   * @param {Limb[]} limbs
   * @param {function(Limb): number} angleOf radians
   * @returns {{local: Object, world: Object, turns: Float32Array}} the pose, its world transforms, and per limb
   *   the turn that was applied, as a quaternion in the space of the lead bone's parent (4 per limb)
   */
  const openedPose = (bake, limbs, angleOf) => {
    const { plan } = bake;
    const local = Kit.rig.copy(bake.rest, Kit.body.createPose(plan));
    const world = Kit.body.worldTransforms(plan, local, Kit.body.createPose(plan));
    const turns = new Float32Array(limbs.length * QUATERNION);
    const arc = [0, 0, 0, 1];
    limbs.forEach((limb, index) => {
      const angle = angleOf(limb);
      const { direction, outward, lead } = limb;
      // Swing in the plane of the limb and the outward direction.
      const lean = direction[0] * outward[0];
      const side = [outward[0] - direction[0] * lean, -direction[1] * lean, -direction[2] * lean];
      const sideLength = Math.hypot(...side) || 1;
      const target = direction.map((value, axis) => value * Math.cos(angle) + (side[axis] / sideLength) * Math.sin(angle));
      Kit.rig.shortestArc(direction[0], direction[1], direction[2], target[0], target[1], target[2], arc);
      const before = Array.from(local.rotation.subarray(lead * QUATERNION, lead * QUATERNION + QUATERNION));
      Kit.rig.turnWorld(plan.parent, local, world, lead, arc);
      // turn = new local x inverse(old local): what to put in front of any pose's local rotation to open it the same way.
      const after = local.rotation.subarray(lead * QUATERNION, lead * QUATERNION + QUATERNION);
      multiply(after, [-before[0], -before[1], -before[2], before[3]], turns, index * QUATERNION);
      Kit.body.worldTransforms(plan, local, world);
    });
    return { local, world, turns };
  };

  /** Quaternion product first x second, written into `out` at `outAt`. */
  const multiply = (first, second, out, outAt = 0) => {
    const [ax, ay, az, aw] = [first[0], first[1], first[2], first[3]];
    const [bx, by, bz, bw] = [second[0], second[1], second[2], second[3]];
    out[outAt] = aw * bx + ax * bw + ay * bz - az * by;
    out[outAt + 1] = aw * by - ax * bz + ay * bw + az * bx;
    out[outAt + 2] = aw * bz + ax * by - ay * bx + az * bw;
    out[outAt + 3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  };

  /**
   * How far each arm-like limb must open from the rest pose so that it is not buried in the trunk: the least
   * angle at which the limb's joints stand clear of the trunk's surface by `clearShare` of their own
   * thickness. A wide chest or a thick arm (any dial) then opens the arms by itself, instead of the rest pose
   * being right for one build only. Legs are left alone: their feet are placed on the ground by the gait.
   * @param {Object} bake
   * @param {Limb[]} limbs
   * @param {function(number, number, number): number} trunkDistance signed distance to the trunk, rest space
   * @returns {{leads: Int16Array, turns: Float32Array}} per opened limb: its lead bone, and the quaternion to
   *   put in front of the lead's local rotation in any pose
   * @complexity O(limbs x steps x bones)
   * @example const { leads, turns } = Kit.figure.limbClearance(bake, Kit.figure.limbsOf(bake), trunkDistance);
   */
  const limbClearance = (bake, limbs, trunkDistance) => {
    const { plan } = bake;
    const free = limbs.filter((limb) => !limb.key.startsWith('legs'));
    const isClear = (limb, angle) => {
      const { world } = openedPose(bake, [limb], () => angle);
      return limb.bones.every((bone) => trunkDistance(world.translation[bone * VECTOR], world.translation[bone * VECTOR + 1], world.translation[bone * VECTOR + 2]) >= (plan.girth[bone] / 2) * world.scale[bone * VECTOR] * SCULPT.clearShare);
    };
    const angles = free.map((limb) => {
      for (let step = 0; step <= SCULPT.clearSteps; step++) if (isClear(limb, (SCULPT.mostOpen * step) / SCULPT.clearSteps)) return (SCULPT.mostOpen * step) / SCULPT.clearSteps;
      return SCULPT.mostOpen;
    });
    const { turns } = openedPose(bake, free, (limb) => angles[free.indexOf(limb)]);
    return { leads: Int16Array.from(free.map((limb) => limb.lead)), turns, angles };
  };

  /** Is this piece one the sculpt replaces: a solid of the body itself, shaded normally? */
  const isSculpted = (piece) => !piece.isProp && !piece.stamps && !piece.shell && !piece.emissive && piece.tone === undefined && piece.inkGroup !== Kit.figure.INK_GROUPS.glow && Boolean(Kit.sculpt.KINDS[piece.shape.kind]);

  /**
   * @typedef {Object} SculptLayer
   * @property {string} id 'skin:<ramp>' for a body surface, 'region:<id>' for a painted layer
   * @property {number} ramp index into the bake's ramps
   * @property {number} inkGroup
   * @property {number} inkClass which line class it draws as (its ramp)
   * @property {Float32Array} positions 3 per vertex, in the bake's rest space
   * @property {Float32Array} normals
   * @property {Uint16Array|Uint32Array} indices
   * @property {Uint16Array} owners 4 bone indices per vertex
   * @property {Float32Array} weights 4 shares per vertex
   */

  /**
   * Sculpts a bake.
   * @param {Object} bake from a bakery
   * @param {Object} figureLayout `Kit.figure.layout(bake)`
   * @param {{detail?: string}} [options] a key of `Kit.sculpt.DETAIL` (default: the layout's level)
   * @returns {{layers: SculptLayer[], replaced: Set<string>, matrices: Float32Array}} `replaced`: ids of the
   *   layout pieces the layers stand in for (do not draw them); `matrices`: the rest matrices the layers were
   *   made in (the bind pose)
   * @complexity O(sum of the body solids' volumes / cell^3) distance evaluations, once per bake
   * @example const { layers, replaced } = Kit.figure.sculptLayers(bake, Kit.figure.layout(bake));
   */
  const sculptLayers = (bake, figureLayout, options = {}) => {
    const { plan } = bake;
    const detail = options.detail || figureLayout.level;
    const matrices = restMatrices(bake, spreadPose(bake));
    const frames = bake.surface && Kit.body.surfaceLayout ? Kit.body.surfaceLayout(plan).frames : null;
    const regions = bake.surface ? bake.surface.regions : null;
    const replaced = new Set();
    /** Body solids by ramp: each paint of the body is one blended skin. */
    const groups = new Map();
    /** Ink group -> the first (nearest the root) bone of that limb. */
    const limbLead = new Map();
    figureLayout.pieces.filter(isSculpted).forEach((piece) => {
      const matrix = matrices.subarray(piece.bone * MATRIX, piece.bone * MATRIX + MATRIX);
      const placed = Kit.sculpt.solid(piece.shape, matrix, { owner: piece.bone });
      placed.blend = Math.max(SCULPT.leastBlend, Math.min(SCULPT.mostBlend, placed.thinness * SCULPT.blendShare));
      placed.inverse = Kit.sculpt.invertAffine(matrix);
      // One limb (an ink group of the layout) blends along its length; it joins the trunk at its first bone's joint.
      placed.group = piece.inkGroup;
      placed.join = Math.min(placed.blend, SCULPT.mostJoin);
      const lead = limbLead.get(piece.inkGroup) === undefined ? piece.bone : limbLead.get(piece.inkGroup);
      limbLead.set(piece.inkGroup, lead);
      placed.anchor = [matrices[lead * MATRIX + 12], matrices[lead * MATRIX + 13], matrices[lead * MATRIX + 14]];
      const group = groups.get(piece.ramp) || { ramp: piece.ramp, inkGroup: piece.inkGroup, solids: [] };
      group.solids.push(placed);
      groups.set(piece.ramp, group);
      replaced.add(piece.id);
    });
    // The shells the layout made for raised regions are replaced along with the surfaces they were copies of.
    figureLayout.pieces.filter((piece) => piece.shell && replaced.has(piece.id.split('~')[0])).forEach((piece) => replaced.add(piece.id));

    // The trunk: the solids of the limb the root bone belongs to, whatever their paint.
    const trunkGroup = Kit.figure.inkGroupOf(Kit.figure.inkKeyOf(plan, 0));
    const trunk = [...groups.values()].flatMap((group) => group.solids.filter((part) => part.group === trunkGroup));
    const trunkDistance = (x, y, z) => trunk.reduce((nearest, part) => Math.min(nearest, part.distance(x, y, z)), Infinity);
    const clearance = trunk.length ? limbClearance(bake, limbsOf(bake), trunkDistance) : { leads: new Int16Array(0), turns: new Float32Array(0) };

    const layers = [];
    groups.forEach((group) => {
      const field = Kit.sculpt.sample(group.solids, { detail });
      const skin = Kit.sculpt.surface(field);
      layers.push({ id: `skin:${group.ramp}`, ramp: group.ramp, inkGroup: group.inkGroup, inkClass: group.ramp, ...skin, ...Kit.sculpt.weights(skin.positions, group.solids, { spread: SCULPT.weightSpread }) });
      if (!regions || !frames) return;
      // Painted layers lie on this skin. The regions of one garment (its waist, chest and sleeves are separate
      // regions, one per bone) with one paint and one raise are one layer; a region with no raise (stripes, a
      // trim) is paint on its garment: it shares the garment's surface and is cut out of it.
      const bones = [...new Set(group.solids.map((part) => part.owner))];
      /** @type {Map<string, {key: string, part: ?string, ramp: number, raise: number, order: number, tests: Map<number, Function[]>}>} */
      const garments = new Map();
      bones.forEach((bone) =>
        regions[bone].forEach((region, index) => {
          if (region.ramp < 0) return;
          const key = `${region.part || ''}|${region.ramp}|${region.raise || 0}`;
          const garment = garments.get(key) || { key, part: region.part || null, ramp: region.ramp, raise: region.raise || 0, order: 0, tests: new Map() };
          garment.order = Math.max(garment.order, index);
          garment.tests.set(bone, [...(garment.tests.get(bone) || []), region.test]);
          garments.set(key, garment);
        })
      );
      const ordered = [...garments.values()].sort((first, second) => first.order - second.order);
      const along = [0, 0];
      /** Is a point of the field's space inside a garment? Asked of the bone whose solid is nearest. */
      const insideOf = (garment) => (x, y, z) => {
        const { size, origin, cell, nearest } = field;
        const node = Math.round((x - origin[0]) / cell) + size[0] * (Math.round((y - origin[1]) / cell) + size[1] * Math.round((z - origin[2]) / cell));
        const owner = nearest[node];
        if (owner < 0) return false;
        const part = group.solids[owner];
        const tests = garment.tests.get(part.owner);
        if (!tests) return false;
        const inverse = part.inverse;
        const [lx, ly, lz] = [inverse[0] * x + inverse[1] * y + inverse[2] * z + inverse[3], inverse[4] * x + inverse[5] * y + inverse[6] * z + inverse[7], inverse[8] * x + inverse[9] * y + inverse[10] * z + inverse[11]];
        const frame = frames[part.owner];
        Kit.surface.along(frame, lx, ly, lz, along);
        // The outward direction: away from the bone's long axis at this height.
        const [ex, ey, ez] = frame.end;
        const [nx, ny, nz] = [lx - ex * along[0], ly - ey * along[0], lz - ez * along[0]];
        const length = Math.hypot(nx, ny, nz) || 1;
        for (let index = 0; index < tests.length; index++) if (tests[index](along[0], along[1], nx / length, ny / length, nz / length)) return true;
        return false;
      };
      // Raised garments stack: each stands at least a gap above the last raised one of another part.
      let lastOffset = 0;
      const specs = [];
      ordered
        .filter((garment) => garment.raise > 0)
        .forEach((garment) => {
          const offset = Math.max(garment.raise, SCULPT.leastRaise, lastOffset + SCULPT.layerGap);
          lastOffset = offset;
          specs.push({ garment, offset, inside: insideOf(garment), isPaint: false });
        });
      ordered
        .filter((garment) => garment.raise <= 0)
        .forEach((garment) => {
          const host = specs.find((spec) => spec.garment.part && spec.garment.part === garment.part && spec.garment.raise > 0);
          const own = insideOf(garment);
          const inside = host ? (x, y, z) => own(x, y, z) && host.inside(x, y, z) : own;
          // Paint lies a hair above what it is painted on, as an open sheet: flush to the eye, never fighting for depth.
          specs.push({ garment, offset: (host ? host.offset : 0) + SCULPT.paintLift, inside, isPaint: true });
        });
      specs.forEach(({ garment, offset, inside, isPaint }) => {
        const cloth = Kit.sculpt.surface(field, { offset, cut: inside, keep: (value) => value > -SCULPT.buriedDepth, walls: !isPaint });
        if (!cloth.indices.length) return;
        layers.push({ id: `region:${garment.key}`, ramp: garment.ramp, inkGroup: group.inkGroup, inkClass: garment.ramp, ...cloth, ...Kit.sculpt.weights(cloth.positions, group.solids, { spread: SCULPT.weightSpread }) });
      });
    });
    return { layers, replaced, matrices, clearance };
  };

  Kit.figure = Object.assign(Kit.figure || {}, { SCULPT, restMatrices, limbsOf, spreadPose, limbClearance, sculptLayers });
})();
