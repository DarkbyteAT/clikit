/**
 * Kit body hair: hair as a small vocabulary of shapes, as data. A style is a hairline (a painted, raised cap:
 * kit/region.js) plus a few primitives placed on the head by angle and height: a mass of volume, a lock, a
 * fringe of locks, a parting, a bun, a tail, a braid, sideburns, a fall of long hair. Each primitive is one or
 * more bone rows with a solid; a renderer that sculpts (kit/figure-sculpt.js) blends a style's solids into one
 * surface with creases between its clumps, and hangs a fall from the head, neck and spine.
 *
 * Owns:  `Kit.body.hair.on(head)` (the primitives, bound to a head's size and shape), `HEAD` (the reference
 *        head they default to) and `PRIMITIVES` (their names).
 * Does not own: hairlines (a part's region), which styles exist (a catalogue composes them: kit/body-wardrobe.js),
 *        how bones are sculpted or draped (`wear`, `hangs`: kit/figure-sculpt.js), or colours.
 *
 * Conventions: a place on the head is [azimuth, rise, out]: degrees round the head from the front towards the
 * body's left (180 is the back), `rise` from -1 (the chin) through 0 (the middle of the head) to 1 (the crown),
 * and metres out of the scalp. Rows are stated in the space of a socket at the middle of the head, in metres on
 * the reference head; a catalogue scales them with its other head-worn parts.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-faces.js.
 */
(() => {
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const QUARTER_TURN = Math.PI / 2;
  /**
   * The reference head as an ellipsoid: its half sizes [across, up, front to back] and where its middle is from
   * the socket the rows hang from, metres. Hair is placed on this, a little proud of the real head.
   */
  const HEAD = Object.freeze({ halves: Object.freeze([0.104, 0.106, 0.097]), center: Object.freeze([0, -0.009, 0]) });
  /** Hair that swings (a tail, a braid) is a loose bone of this kind (`Kit.body.SOFT_KINDS`, kit/body-plan.js). */
  const SWING = Object.freeze({ soft: 'plait' });
  /** How far towards an ear a parting's line may go, as a share of the head's half width. */
  const PARTING_REACH = 0.4;
  /** A lock's thickness out of the head as a share of its width, when a style does not say. */
  const LOCK_FLAT = 0.6;
  const PRIMITIVES = Object.freeze(['mass', 'lock', 'fringe', 'parting', 'bun', 'tail', 'braid', 'sideburns', 'fall']);

  const fail = (where, message) => {
    throw new Error(`Kit.body.hair.${where}: ${message}`);
  };
  const subtract = (first, second) => first.map((value, axis) => value - second[axis]);

  /**
   * How the primitives are proportioned, as shares of the size each is given unless a unit is named: a fringe
   * lock's taper; a bun's height, how far it stands off the head, and its tie (length, radius, taper); the end
   * of a tail whose last radius is not stated; a braid's bead as [across, along, deep]; a sideburn's lowest
   * point (rise below the middle of the head), how far it stands off (metres), its lean forward (degrees) and
   * taper; a fall's width (of the head's half width) and depth (of its own width).
   */
  const FORM = Object.freeze({ fringeTaper: 0.3, bunHeight: 0.9, bunOut: 0.7, tieLength: 0.6, tieRadius: 0.55, tieTaper: 0.9, tailEnd: 0.55, bead: [1, 0.82, 0.9], burnBottom: 0.3, burnOut: 0.002, burnLean: 4, burnTaper: 0.5, fallWidth: 0.9, fallDepth: 0.3 });

  /**
   * The hair primitives for a head. Each returns bone rows (`BoneSpec`, kit/body-plan.js) painted 'hair'; a
   * style is their concatenation. Names must be unique within a style: every primitive takes the name (or the
   * prefix of the names) of its rows first.
   * @param {{halves?: number[], center?: number[], paint?: string}} [head] the head's ellipsoid (default `HEAD`) and the paint channel (default 'hair')
   * @returns {{at: Function, mass: Function, lock: Function, fringe: Function, parting: Function, bun: Function, tail: Function, braid: Function, sideburns: Function, fall: Function}}
   * @complexity O(1) to bind; each primitive is O(rows it returns)
   * @example
   * const hair = Kit.body.hair.on();
   * const bob = [...hair.mass('crown', [0, 0.8, 0.004], [0.1, 0.05, 0.098]), ...hair.fringe('fringe', { from: -50, to: 50, count: 5 })];
   */
  const on = (head = {}) => {
    const halves = head.halves || HEAD.halves;
    const center = head.center || HEAD.center;
    const paint = head.paint || 'hair';

    /**
     * A place on the head as a point in the socket's space.
     * @param {number[]} place [azimuth degrees, rise -1..1, out metres]
     * @returns {number[]} [x, y, z] metres
     */
    const at = ([azimuth, rise, out = 0]) => {
      const turn = azimuth * DEGREES_TO_RADIANS;
      const climb = Math.max(-1, Math.min(1, rise)) * QUARTER_TURN;
      const direction = [Math.sin(turn) * Math.cos(climb), Math.sin(climb), Math.cos(turn) * Math.cos(climb)];
      return direction.map((value, axis) => center[axis] + value * (halves[axis] + out));
    };
    const row = (name, extra) => ({ name, roles: ['root'], paint, ...extra });

    /**
     * A mass of volume: a pressed ball on the scalp (the body of a bob, the back of a crop, a head of curls).
     * @param {string} name
     * @param {number[]} place where its middle is
     * @param {number[]} size half sizes [across, up, front to back], metres
     * @returns {Object[]} one row
     */
    const mass = (name, place, size) => {
      const radius = Math.max(...size);
      return [row(name, { at: at(place), girth: Math.min(...size) * 2, joint: 'fixed', shape: { kind: 'sphere', radius, scale: size.map((half) => half / radius) } })];
    };

    /**
     * A lock: one clump of hair from a place to a place, thick at its root and drawn to a point, pressed flat
     * against the head so it lies on it as a ribbon instead of hanging as a cone.
     * @param {string} name
     * @param {number[]} from
     * @param {number[]} to
     * @param {number} radius metres at the root, across the lock
     * @param {number} [taper=0.35] the tip's radius as a share of the root's
     * @param {number} [flat=0.6] its thickness out of the head as a share of its width
     * @returns {Object[]} one row
     */
    const lock = (name, from, to, radius, taper = 0.35, flat = LOCK_FLAT) => {
      const start = at(from);
      const along = subtract(at(to), start);
      // The bone is turned to face out of the head where the lock starts, so pressing its own Z presses it against the scalp.
      const turn = from[0] * DEGREES_TO_RADIANS;
      const [cosine, sine] = [Math.cos(turn), Math.sin(turn)];
      const tail = [along[0] * cosine - along[2] * sine, along[1], along[0] * sine + along[2] * cosine];
      return [row(name, { at: start, turn: [0, from[0], 0], tail, girth: radius * 2 * flat, joint: 'fixed', shape: { kind: 'capsule', radius, taper, scale: [1, 1, flat] } })];
    };

    /**
     * A fringe: a row of locks falling from the hairline, fanned round the head, alternately long and short so
     * the edge is clumped instead of cut straight.
     * @param {string} prefix
     * @param {{from: number, to: number, count: number, top?: number, bottom?: number, radius?: number, sweep?: number, ragged?: number, out?: number}} options
     *   `from`, `to`: azimuths of the first and last lock, degrees; `top`, `bottom`: rises of a lock's root and
     *   tip (default 0.78 and 0.3); `sweep`: degrees a tip is carried sideways (a swept fringe); `ragged`: how
     *   much shorter every other lock is, as a share (default 0.3); `out`: metres the locks stand off the scalp
     * @returns {Object[]} `count` rows
     * @throws {Error} for a count below 1
     */
    const fringe = (prefix, { from, to, count, top = 0.78, bottom = 0.3, radius = 0.02, sweep = 0, ragged = 0.3, out = 0.01 }) => {
      if (!(count >= 1)) fail('fringe', `needs a \`count\` of 1 or more locks, got ${count}.`);
      return Array.from({ length: count }, (_unused, index) => {
        const azimuth = count === 1 ? (from + to) / 2 : from + ((to - from) * index) / (count - 1);
        const reach = bottom + (top - bottom) * (index % 2 ? ragged : 0);
        return lock(`${prefix}${index + 1}`, [azimuth, top, out], [azimuth + sweep, reach, out], radius, FORM.fringeTaper);
      }).flat();
    };

    /**
     * A parting: the hair of the crown as two domes, each the head's own shape made a little smaller and set so
     * its top stands `lift` over the crown, then moved towards its side. A dome is therefore thickest on top,
     * runs into the scalp partway down the sides, and never stands off the face; the groove where the two meet
     * is the parting. Moved off the middle, the line is a side parting.
     * @param {string} prefix
     * @param {{side?: number, lift?: number, apart?: number, down?: number}} [options] `side`: degrees the line
     *   is off the middle, towards the body's left when positive (default 0, a centre parting); `lift`: metres
     *   the hair stands off the crown (default 0.012); `apart`: metres each dome is moved to its side (default
     *   0.014); `down`: a dome's size as a share of the head's (default 0.8): nearer 1 it comes further down the sides
     * @returns {Object[]} two rows
     */
    const parting = (prefix, { side = 0, lift = 0.012, apart = 0.014, down = 0.8 } = {}) => {
      const line = halves[0] * Math.sin(side * DEGREES_TO_RADIANS) * PARTING_REACH;
      const size = halves.map((half) => half * down);
      const radius = Math.max(...size);
      const half = (name, sign) =>
        row(`${prefix}${name}`, { at: [center[0] + line + sign * apart, center[1] + halves[1] * (1 - down) + lift, center[2]], girth: Math.min(...size) * 2, joint: 'fixed', shape: { kind: 'sphere', radius, scale: size.map((value) => value / radius) } });
      return [half('Left', 1), half('Right', -1)];
    };

    /**
     * A bun: a ball of hair gathered at a place, on a short neck of hair.
     * @param {string} name
     * @param {number[]} place where it sits on the scalp
     * @param {number} radius metres
     * @returns {Object[]} two rows
     */
    const bun = (name, place, radius) => [
      ...mass(name, [place[0], place[1], (place[2] || 0) + radius * FORM.bunOut], [radius, radius * FORM.bunHeight, radius]),
      ...lock(`${name}Tie`, [place[0], place[1], 0], [place[0], place[1], radius * FORM.tieLength], radius * FORM.tieRadius, FORM.tieTaper),
    ];

    /**
     * A tail: a chain of loose segments that swings, from a place on the scalp (a ponytail, a pigtail).
     * @param {string} prefix
     * @param {number[]} place where it is tied
     * @param {number[][]} steps each segment's [x, y, z] from the one before, metres
     * @param {number[]} radii one per segment, metres
     * @param {string[]} [roles] extra roles for every segment ('left')
     * @returns {Object[]} one row per segment, each the child of the one before
     */
    const tail = (prefix, place, steps, radii, roles = []) =>
      steps.map((step, index) => ({
        name: `${prefix}${index + 1}`,
        ...(index ? { parent: `${prefix}${index}` } : {}),
        at: index ? steps[index - 1] : at(place),
        ...(index === steps.length - 1 ? { tail: step } : {}),
        roles: [...(index ? [] : ['root']), ...roles],
        girth: radii[index] * 2,
        shape: { kind: 'capsule', radius: radii[index], taper: (radii[index + 1] || radii[index] * FORM.tailEnd) / radii[index] },
        ...SWING,
        paint,
      }));

    /**
     * A braid: a tail whose segments are beads, each a pressed ball overlapping the next, so it reads as plaited.
     * @param {string} prefix
     * @param {number[]} place where it starts
     * @param {number[]} step [x, y, z] from one bead to the next, metres
     * @param {number} beads how many
     * @param {number} radius of the first bead, metres; the last is 0.6 of it
     * @param {string[]} [roles]
     * @returns {Object[]} one row per bead
     */
    const braid = (prefix, place, step, beads, radius, roles = []) =>
      Array.from({ length: beads }, (_unused, index) => {
        const size = radius * (1 - (0.4 * index) / Math.max(1, beads - 1));
        return {
          name: `${prefix}${index + 1}`,
          ...(index ? { parent: `${prefix}${index}` } : {}),
          at: index ? step : at(place),
          tail: step,
          roles: [...(index ? [] : ['root']), ...roles],
          girth: size * 2,
          shape: { kind: 'sphere', radius: size, scale: FORM.bead, at: step.map((value) => value / 2) },
          ...SWING,
          paint,
        };
      });

    /**
     * Sideburns: a flat lock in front of each ear.
     * @param {string} prefix
     * @param {{azimuth?: number, top?: number, bottom?: number, radius?: number}} [options] `azimuth`: degrees
     *   from the front to each (default 66); `top`, `bottom`: rises (default 0.2 and -0.3)
     * @returns {Object[]} two rows
     */
    const sideburns = (prefix, { azimuth = 66, top = 0.2, bottom = -FORM.burnBottom, radius = 0.014 } = {}) => [
      ...lock(`${prefix}Left`, [azimuth, top, FORM.burnOut], [azimuth - FORM.burnLean, bottom, 0], radius, FORM.burnTaper),
      ...lock(`${prefix}Right`, [-azimuth, top, FORM.burnOut], [FORM.burnLean - azimuth, bottom, 0], radius, FORM.burnTaper),
    ];

    /**
     * A fall of long hair: one shaped mass down the back of the head and the upper spine, wide at the nape and
     * drawn in at its end. It is draped (`wear: 'drape'`): sculpted as it hangs, then moved by the head, neck
     * and spine bones beside it, so it follows a nod and lies on the back.
     * @param {string} name
     * @param {{top?: number, length: number, width?: number, depth?: number, taper?: number, back?: number}} options
     *   `top`: the rise of the middle of its rounded top on the back of the head (default -0.1); `length`: metres it hangs;
     *   `width`: its half width, metres (default 0.9 of the head's); `depth`: its thickness as a share of its
     *   width (default 0.3); `taper`: the end's width as a share (default 0.6); `back`: metres its end lies
     *   behind its start (default 0.02)
     * @returns {Object[]} one row
     */
    const fall = (name, { top = -0.1, length, width = halves[0] * FORM.fallWidth, depth = FORM.fallDepth, taper = 0.6, back = 0.02 }) => {
      const start = at([180, top, -width * depth * 0.5]);
      return [row(name, { at: start, tail: [0, -length, -back], girth: width * 2, wear: 'drape', hangs: ['head', 'neck', 'spine'], shape: { kind: 'capsule', radius: width, taper, scale: [1, 1, depth] } })];
    };

    return { at, mass, lock, fringe, parting, bun, tail, braid, sideburns, fall };
  };

  Kit.body = Object.assign(Kit.body || {}, { hair: Object.freeze({ HEAD, PRIMITIVES, on }) });
})();
