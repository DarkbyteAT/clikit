/**
 * Kit body face: a face as relief, as data. A nose, a pair of ears, a brow ridge, cheeks, a chin, lips and eye
 * sockets are each a few small solids (`FeatureSpec` rows of kit/body-surface.js) that sit on a head's named
 * anchors and are modelled out of its surface when the body is sculpted (kit/sculpt-relief.js). A style is a
 * row of numbers (`NOSES`, `EARS`); a builder turns a row into features at any head size. A catalogue lists
 * them on a plan (a ridge, cheeks, a chin: every individual has them) or on a part (a nose to choose).
 *
 * Owns:  `Kit.body.face`: the style tables `NOSES` and `EARS`, the builders `nose`, `ears`, `browRidge`,
 *        `cheeks`, `chin`, `lips`, `eyeSockets`, `dotEyes`, `lineMouth` and `nosePad`, `anchors` (where a head of a given shape keeps
 *        its features) and `ANCHOR_NAMES`.
 * Does not own: placing features or dials (kit/body-surface.js), the modelling (kit/sculpt-relief.js), eye and
 *        mouth stamps of a full creator (kit/body-wardrobe.js), or any species (the catalogues).
 *
 * Conventions: lengths are metres on the reference head (`REFERENCE`: 0.21 m tall, a grown person's); every
 * builder takes `scale` for another size. A feature's solid is stated in its own frame: +X across (towards the
 * back of the head for an ear), +Y up the face, +Z out of the surface. Every solid is original and generic.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-faces.js.
 */
(() => {
  /** The head the numbers below were drawn for, metres. */
  const REFERENCE = Object.freeze({ height: 0.21, width: 0.2 });
  /** The anchors a face is hung on. A plan states each as an `AnchorSpec` (`anchors` makes the usual set). */
  const ANCHOR_NAMES = Object.freeze(['eye', 'brow', 'nose', 'mouth', 'ear', 'cheek', 'chin']);
  /**
   * How much of its radius an ear's point keeps at its end. A finer point is thinner than a cell of the sculpt
   * grid and is cut off short, or leaves a fleck of its tip floating over the ear.
   */
  const POINT_TAPER = 0.5;
  /**
   * How a nose is built from its row, as shares of the row's own lengths: where the bridge ends in the tip
   * (`bridgeEnd`, of the tip's radius), how far the wings hang under the tip (`wingsDrop`, of the tip's drop),
   * and a hump's half sizes and place on the bridge. `flare`: degrees between the wings when a row states none.
   */
  const NOSE_FORM = Object.freeze({ bridgeEnd: 0.8, wingsDrop: 0.4, flare: 14, humpWidth: 1.1, humpLength: 0.3, humpAlong: 0.55, humpDrop: 0.5, humpOut: 0.5 });
  /**
   * How an ear is built from its row: the plate's thickness when a row states none and the fillet that joins it
   * to the head (metres), then the lobe's half sizes and place as shares of the plate's.
   */
  const EAR_FORM = Object.freeze({ thickness: 0.011, blend: 0.006, lobeWidth: 0.5, lobeHeight: 0.34, lobeThickness: 0.6, lobeBack: 0.75, lobeDown: 0.8 });
  /** The swells of a face, metres at the reference head: [across, up, out] half sizes of a buried ball and the fillet that joins it; `elevation`: degrees from its anchor. */
  const SWELLS = Object.freeze({
    ridge: Object.freeze({ halves: [0.023, 0.0075, 0.0075], blend: 0.012, elevation: -5 }),
    cheek: Object.freeze({ halves: [0.024, 0.02, 0.0085], blend: 0.02 }),
    chin: Object.freeze({ halves: [0.019, 0.013, 0.011], blend: 0.014 }),
  });
  /**
   * Lips, metres at the reference head: each lip's half height and how far it sits above the mouth's line
   * (`upper`, `lower`: [halfHeight, up]), their half width as a share of the mouth stamp's, how far they stand
   * out and are sunk, and the fillet that joins them to the face.
   */
  const LIPS = Object.freeze({ upper: [0.0036, 0.0036], lower: [0.0044, -0.0042], width: 0.52, out: 0.0048, sunk: -0.0016, blend: 0.006 });
  /** An eye socket: its half sizes as shares of the eye stamp's [width, height], how deep the pressing ball is, and the fillet round its rim (metres). */
  const SOCKET = Object.freeze({ across: 0.78, up: 0.74, ball: 0.012, blend: 0.012 });
  /**
   * The plain stamps, in the stamp's own square (-1..1): how many sides a dot and its glint are drawn with, a
   * glint as [x, y, halfWidth, halfHeight] on an eye and on a nose pad, and a smile as two arcs of an ellipse
   * centred `smileUp` above the stamp's middle, between two angles (degrees).
   */
  const STAMPS = Object.freeze({ dotSides: 14, glintSides: 8, eyeGlint: [-0.3, 0.36, 0.3, 0.3], padGlint: [-0.25, 0.4, 0.3, 0.2], smileUp: 0.6, smileOuter: [1, 1.1], smileInner: [0.94, 0.8], smileFrom: 200, smileTo: 340 });
  /** The lightest shade of a ramp: a glint. */
  const LIGHTEST = 4;
  /** How much of a solid's radius is sunk into the surface it grows from, so its edge is a slope and not a step. */
  const SUNK = 0.3;

  const fail = (where, message) => {
    throw new Error(`Kit.body.face.${where}: ${message}`);
  };
  const scaled = (values, scale) => values.map((value) => value * scale);
  /** A ball pressed to [across, up, out] half-sizes, at a place in the feature's frame. */
  const pressed = (halves, at, scale) => {
    const radius = Math.max(...halves);
    return { kind: 'sphere', radius: radius * scale, scale: halves.map((half) => half / radius), at: scaled(at, scale) };
  };
  /** The rows a style table offers, for an error message. */
  const rowOf = (table, name, where) => (typeof name === 'string' ? table[name] || fail(where, `no style "${name}". Styles: ${Object.keys(table).join(', ')}.`) : name);

  /**
   * Where a head keeps its features, as the plan's `anchors`: degrees on the head bone (azimuth from the front
   * towards the body's left, elevation above the middle of the head's shape). The defaults suit an upright,
   * rounded head with a big face; a species states its own for a long muzzle or a low brow.
   * @param {string} bone the head bone's name
   * @param {Object<string, {azimuth?: number, elevation?: number, spacing?: number}>} [overrides] by anchor name
   * @returns {Object<string, Object>} `AnchorSpec`s by name
   * @complexity O(anchors)
   * @example plan.anchors = Kit.body.face.anchors('head', { ear: { elevation: 10, spacing: 150 } });
   */
  const anchors = (bone, overrides = {}) => {
    const usual = {
      eye: { elevation: -3, spacing: 50 },
      brow: { elevation: 17, spacing: 52 },
      nose: { elevation: -13 },
      mouth: { elevation: -30 },
      ear: { elevation: -6, spacing: 176 },
      cheek: { elevation: -19, spacing: 76 },
      chin: { elevation: -50 },
    };
    const unknown = Object.keys(overrides).find((name) => !ANCHOR_NAMES.includes(name));
    if (unknown) fail('anchors', `no anchor "${unknown}". Anchors: ${ANCHOR_NAMES.join(', ')}.`);
    return Object.fromEntries(ANCHOR_NAMES.map((name) => [name, { bone, ...usual[name], ...(overrides[name] || {}) }]));
  };

  /**
   * @typedef {Object} NoseRow
   * A nose as three masses: a bridge running down the face to the tip, the ball of the tip, and a wing each side.
   * @property {number} length metres the bridge runs up the face from the tip
   * @property {number} out metres the tip stands off the face
   * @property {number} [drop=0] metres the tip hangs below the nose's anchor (a hooked nose)
   * @property {number} bridge radius of the bridge where it starts, metres
   * @property {number[]} tip [across, up, out] half-sizes of the tip
   * @property {?number[]} [wings] [across, up, out] half-sizes of each wing; none for a nose too small to have them
   * @property {number} [flare=14] degrees between the two wings
   * @property {?number} [hump] metres a hump stands off the middle of the bridge
   */

  /** Nose styles. Adding a style means adding a row. @type {Object<string, NoseRow>} */
  const NOSES = Object.freeze({
    button: { length: 0.016, out: 0.0115, bridge: 0.005, tip: [0.0125, 0.0105, 0.0105], wings: null },
    straight: { length: 0.04, out: 0.018, bridge: 0.0056, tip: [0.0095, 0.0085, 0.0095], wings: [0.0064, 0.0055, 0.0055], flare: 15 },
    pointed: { length: 0.038, out: 0.025, drop: -0.003, bridge: 0.005, tip: [0.0068, 0.0066, 0.011], wings: [0.005, 0.0048, 0.0048], flare: 12 },
    broad: { length: 0.028, out: 0.014, bridge: 0.008, tip: [0.0155, 0.0098, 0.0105], wings: [0.0092, 0.007, 0.0068], flare: 23 },
    hooked: { length: 0.042, out: 0.02, drop: 0.007, bridge: 0.006, tip: [0.0088, 0.0092, 0.0095], wings: [0.006, 0.0055, 0.005], flare: 15, hump: 0.0075 },
  });


  /**
   * A nose's features: every one has the id 'nose' and sits on the 'nose' anchor, so one dial on 'nose' (its
   * size, its lift, its lean) moves the whole nose.
   * @param {string|NoseRow} style a key of `NOSES` or a row of the same shape
   * @param {{scale?: number, paint?: string, size?: number[]}} [options] `size`: the [width, height] dials scale
   *   from, metres (default the reference nose's)
   * @returns {Object[]} `FeatureSpec`s
   * @throws {Error} for an unknown style
   * @complexity O(1)
   * @example parts.noseHooked = { fits: ['nose'], bones: [], features: Kit.body.face.nose('hooked') };
   */
  const nose = (style, { scale = 1, paint = 'skin', size = [0.03, 0.036] } = {}) => {
    const row = rowOf(NOSES, style, 'nose');
    const drop = row.drop || 0;
    const tipRadius = Math.min(...row.tip);
    const common = { id: 'nose', anchor: 'nose', size: scaled(size, scale), paint, outlined: false, blend: 0.0055 * scale };
    // The bridge starts sunk in the face above the anchor and ends inside the tip.
    const start = [0, row.length, -row.bridge * SUNK];
    const tipAt = [0, -drop, row.out - tipRadius * SUNK];
    /** @type {Object[]} */
    const features = [
      { ...common, shape: { kind: 'capsule', at: scaled(start, scale), end: scaled([tipAt[0] - start[0], tipAt[1] - start[1], tipAt[2] - start[2]], scale), radius: row.bridge * scale, taper: (tipRadius * NOSE_FORM.bridgeEnd) / row.bridge } },
      { ...common, shape: pressed(row.tip, tipAt, scale) },
    ];
    if (row.wings) features.push({ ...common, spacing: row.flare === undefined ? NOSE_FORM.flare : row.flare, shape: pressed(row.wings, [0, -drop * NOSE_FORM.wingsDrop, row.wings[2] * (1 - SUNK)], scale) });
    if (row.hump) features.push({ ...common, shape: pressed([row.bridge * NOSE_FORM.humpWidth, row.length * NOSE_FORM.humpLength, row.bridge], [0, row.length * NOSE_FORM.humpAlong - drop * NOSE_FORM.humpDrop, row.out * NOSE_FORM.humpOut + row.hump - row.bridge], scale) });
    return features;
  };

  /**
   * @typedef {Object} EarRow
   * An ear as a plate standing off the head, with an optional lobe and point.
   * @property {number} height metres, top to bottom
   * @property {number} width metres, front to back
   * @property {number} [thickness=0.011] metres
   * @property {number} [flare=38] degrees the plate stands off the head (its back edge out)
   * @property {boolean} [lobe=true]
   * @property {?{length: number, back: number, radius: number}} [point] a tip drawn out of the top: metres up,
   *   metres towards the back of the head, and its radius where it leaves the plate
   */

  /** Ear styles. Adding a style means adding a row. @type {Object<string, EarRow>} */
  const EARS = Object.freeze({
    round: { height: 0.05, width: 0.03 },
    small: { height: 0.038, width: 0.024, flare: 30 },
    large: { height: 0.066, width: 0.04, flare: 48 },
    pointed: { height: 0.046, width: 0.029, lobe: false, point: { length: 0.04, back: 0.012, radius: 0.0085 } },
    long: { height: 0.04, width: 0.028, flare: 42, lobe: false, point: { length: 0.062, back: 0.062, radius: 0.0085 } },
  });

  /**
   * A pair of ears' features on the 'ear' anchor: the plate and its lobe have the id 'ear', a point has the id
   * 'earTip', so one dial sizes the ear and another draws out its point.
   * @param {string|EarRow} style a key of `EARS` or a row of the same shape
   * @param {{scale?: number, paint?: string}} [options]
   * @returns {Object[]} `FeatureSpec`s, each a mirrored pair
   * @throws {Error} for an unknown style
   * @complexity O(1)
   * @example parts.earsLong = { fits: ['ears'], bones: [], features: Kit.body.face.ears('long') };
   */
  const ears = (style, { scale = 1, paint = 'skin' } = {}) => {
    const row = rowOf(EARS, style, 'ears');
    const thickness = row.thickness || EAR_FORM.thickness;
    const flare = row.flare === undefined ? 38 : row.flare;
    const [halfWidth, halfHeight] = [row.width / 2, row.height / 2];
    const common = { anchor: 'ear', size: scaled([row.width, row.height], scale), paint, lean: [0, flare], blend: EAR_FORM.blend * scale };
    // The plate turns about its front edge, which stays sunk in the head at the anchor; the rest swings out by the flare.
    const plateAt = [halfWidth, 0, -thickness * SUNK];
    /** @type {Object[]} */
    const features = [{ ...common, id: 'ear', shape: pressed([halfWidth, halfHeight, thickness / 2], plateAt, scale) }];
    if (row.lobe !== false) features.push({ ...common, id: 'ear', shape: pressed([halfWidth * EAR_FORM.lobeWidth, halfHeight * EAR_FORM.lobeHeight, thickness * EAR_FORM.lobeThickness], [halfWidth * EAR_FORM.lobeBack, -halfHeight * EAR_FORM.lobeDown, plateAt[2]], scale) });
    if (row.point) {
      const from = [plateAt[0], halfHeight * 0.45, plateAt[2]];
      features.push({ ...common, id: 'earTip', size: scaled([row.width, row.point.length], scale), shape: { kind: 'capsule', at: scaled(from, scale), end: scaled([row.point.back, row.point.length, 0], scale), radius: row.point.radius * scale, taper: POINT_TAPER } });
    }
    return features;
  };

  /** A buried, pressed ball as a mirrored pair or a single mark on an anchor: the common shape of a brow, a cheek and a chin. */
  const swell = (id, anchor, halves, blend, { scale = 1, paint = 'skin' } = {}) => ({
    id,
    anchor,
    size: scaled([halves[0] * 2, halves[1] * 2], scale),
    paint,
    outlined: false,
    blend: blend * scale,
    shape: pressed(halves, [0, 0, -halves[2] * SUNK], scale),
  });

  /**
   * A brow ridge: a low bar over each eye on the 'brow' anchor, a little under where a brow is painted, so the
   * eyes lie in its shadow. Id 'ridge': a dial on its `lift` deepens or flattens the brow.
   * @param {{scale?: number, paint?: string}} [options]
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = [...Kit.body.face.browRidge({ scale: 2 }), ...Kit.body.face.cheeks({ scale: 2 })];
   */
  const browRidge = (options) => [{ ...swell('ridge', 'brow', SWELLS.ridge.halves, SWELLS.ridge.blend, options), elevation: SWELLS.ridge.elevation }];

  /**
   * Cheeks: a soft fullness each side on the 'cheek' anchor. Id 'cheek': a dial on its `size` fills or hollows them.
   * @param {{scale?: number, paint?: string}} [options]
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = Kit.body.face.cheeks();
   */
  const cheeks = (options) => [swell('cheek', 'cheek', SWELLS.cheek.halves, SWELLS.cheek.blend, options)];

  /**
   * A chin: a rounded point on the 'chin' anchor. Id 'chin': a dial on its `lift` draws it out or sets it back.
   * @param {{scale?: number, paint?: string}} [options]
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = Kit.body.face.chin({ scale: 1.3 });
   */
  const chin = (options) => [swell('chin', 'chin', SWELLS.chin.halves, SWELLS.chin.blend, options)];

  /**
   * Lips under a mouth stamp: an upper and a fuller lower lip on the 'mouth' anchor, as wide as the stamp. Id
   * 'mouth', so the dials that widen, raise or fill the painted mouth do the same to the lips beneath it.
   * @param {number[]} size [width, height] of the mouth's stamp, metres at the reference head
   * @param {{scale?: number, paint?: string, fullness?: number}} [options] `fullness`: 1 is an ordinary lip
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example mouthPart.features.push(...Kit.body.face.lips([0.04, 0.02]));
   */
  const lips = (size, { scale = 1, paint = 'skin', fullness = 1 } = {}) => {
    const halfWidth = size[0] * LIPS.width;
    const common = { id: 'mouth', anchor: 'mouth', size: scaled(size, scale), paint, outlined: false, blend: LIPS.blend * scale };
    const lip = (halfHeight, up) => ({ ...common, shape: pressed([halfWidth, halfHeight * fullness, LIPS.out * fullness], [0, up * fullness, LIPS.sunk], scale) });
    return [lip(...LIPS.upper), lip(...LIPS.lower)];
  };

  /**
   * Eye sockets: a shallow dent under each eye on the 'eye' anchor, sized to the eye's stamp. Id 'eye', so the
   * dials that size, space, raise and tilt the eyes move their sockets with them.
   * @param {number[]} size [width, height] of the eye's stamp, metres at the reference head
   * @param {{scale?: number, depth?: number}} [options] `depth`: metres the dent goes in (default 0.0032)
   * @returns {Object[]} `FeatureSpec`s (pressed in: `carve`)
   * @complexity O(1)
   * @example eyesPart.features.push(...Kit.body.face.eyeSockets([0.042, 0.038]));
   */
  const eyeSockets = (size, { scale = 1, depth = 0.0032 } = {}) => {
    const halves = [size[0] * SOCKET.across, size[1] * SOCKET.up, SOCKET.ball];
    return [{ id: 'eye', anchor: 'eye', size: scaled(size, scale), carve: true, blend: SOCKET.blend * scale, shape: pressed(halves, [0, 0, halves[2] - depth], scale) }];
  };

  /**
   * The plainest eyes that read at any size: a dark dot each side on the 'eye' anchor with one glint, painted
   * with shades of one colour channel. For a species sheet or a creature; a creator's eyes are richer stamps.
   * @param {number} width metres across one eye at the reference head
   * @param {{scale?: number, channel?: string}} [options] `channel`: the colour channel whose darkest and lightest shades are used (default 'skin')
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = [...Kit.body.face.dotEyes(0.02), ...Kit.body.face.eyeSockets([0.02, 0.022])];
   */
  const dotEyes = (width, { scale = 1, channel = 'skin' } = {}) => {
    const { ellipse } = Kit.surface;
    const frames = {
      open: [
        { outline: ellipse(0, 0, 1, 1, STAMPS.dotSides), paint: { channel, shade: 0 }, least: 2 },
        { outline: ellipse(...STAMPS.eyeGlint, STAMPS.glintSides), paint: { channel, shade: LIGHTEST }, least: 1, fixed: true },
      ],
      closed: [{ outline: ellipse(0, -0.1, 1, 0.16, 10), paint: { channel, shade: 0 } }],
    };
    return [{ id: 'eye', anchor: 'eye', size: scaled([width, width * 1.15], scale), frames, rest: 'open', glow: true }];
  };

  /**
   * The plainest mouth: one dark line on the 'mouth' anchor, a little turned up at its ends, painted with the
   * darkest shade of a colour channel. Id 'mouth'.
   * @param {number[]} size [width, height] metres at the reference head
   * @param {{scale?: number, channel?: string}} [options] `channel`: default 'skin'
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = [...Kit.body.face.lineMouth([0.036, 0.012]), ...Kit.body.face.lips([0.036, 0.012])];
   */
  const lineMouth = (size, { scale = 1, channel = 'skin' } = {}) => {
    const { ellipse } = Kit.surface;
    const arc = (halves) => ellipse(0, STAMPS.smileUp, halves[0], halves[1], STAMPS.glintSides, { from: STAMPS.smileFrom, to: STAMPS.smileTo });
    const smile = [...arc(STAMPS.smileOuter), ...arc(STAMPS.smileInner).reverse()];
    return [{ id: 'mouth', anchor: 'mouth', size: scaled(size, scale), frames: { rest: [{ outline: smile, paint: { channel, shade: 0 }, least: 1 }] }, rest: 'rest' }];
  };

  /**
   * A nose pad: a dark patch with one glint on the 'nose' anchor, for a muzzle whose end is already the nose's
   * shape (a hound, a cat). Painted with shades of one colour channel. Id 'nosePad'.
   * @param {number[]} size [width, height] metres at the reference head
   * @param {{scale?: number, channel?: string, elevation?: number}} [options] `channel`: default 'skin';
   *   `elevation`: degrees above the anchor (a pad sits on the upper half of a muzzle's end; default 0)
   * @returns {Object[]} `FeatureSpec`s
   * @complexity O(1)
   * @example plan.features = [...Kit.body.face.dotEyes(0.016), ...Kit.body.face.nosePad([0.04, 0.03], { elevation: 6 })];
   */
  const nosePad = (size, { scale = 1, channel = 'skin', elevation = 0 } = {}) => {
    const { ellipse } = Kit.surface;
    const layers = [
      { outline: ellipse(0, 0, 1, 1, STAMPS.dotSides), paint: { channel, shade: 0 }, least: 2 },
      { outline: ellipse(...STAMPS.padGlint, STAMPS.glintSides), paint: { channel, shade: LIGHTEST }, least: 1, fixed: true },
    ];
    return [{ id: 'nosePad', anchor: 'nose', elevation, size: scaled(size, scale), frames: { rest: layers }, rest: 'rest' }];
  };

  Kit.body = Object.assign(Kit.body || {}, { face: Object.freeze({ REFERENCE, ANCHOR_NAMES, NOSES, EARS, anchors, nose, ears, browRidge, cheeks, chin, lips, eyeSockets, dotEyes, lineMouth, nosePad }) });
})();
