/**
 * Kit figure layout: what a renderer draws for one body bake, decided as plain data. A layout lists the
 * pieces (one per bone that has a surface, plus any extension pieces), which ramp of the individual paints each
 * one, which ink group it belongs to, and what has to change when the bake changes. It also measures the body
 * at rest, so a figure can stand on the ground and a camera can be fitted to it.
 *
 * Owns:  `Kit.figure.layout` (bake -> pieces), `resolveRamps` (bones that name no paint), `inkKeyOf` /
 *        `inkGroupOf` / `INK_GROUPS` (which pieces share an outline), `planUpdate` (old layout + new layout ->
 *        what to keep, add, remove and recolour), `measureRest` (lowest point and extent of the body at rest,
 *        props left out) and `fitView` (a camera window that holds a measured body).
 * Does not own: surfaces (kit/figure-shapes.js), THREE objects (kit/figure.js), bakes and what changed in the
 *        individual (kit/body-recipe.js, `editor.changes` in kit/body-edit.js), or colours (kit/palette.js).
 *
 * Two extension points are left open on purpose (see `layout`): surface features (eyes, a mouth) arrive as
 * extra pieces per bone, and surface regions (clothing, hair) as a lookup that splits a piece's triangles by
 * ramp. Neither is implemented here; each says exactly what it expects.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-figure.js.
 */
(() => {
  // ---- tunables -------------------------------------------------------------------------------------------------------

  /**
   * Ink groups of the body's regions. Screen-space ink draws a line where two groups meet, so the segments of
   * one limb share a group (no seam at the elbow) while an arm in front of the chest is outlined. Group 0 is
   * never outlined (eyes, glows). Parts (a hat, a sword) get a group from `PART_GROUPS` by their socket path.
   */
  const INK_GROUPS = Object.freeze({
    glow: 0,
    body: 1,
    head: 2,
    'arms-left': 3,
    'arms-right': 4,
    'legs-left': 5,
    'legs-right': 6,
    'legs-front-left': 7,
    'legs-front-right': 8,
    'legs-hind-left': 9,
    'legs-hind-right': 10,
    'wings-left': 11,
    'wings-right': 12,
    tail: 13,
    fins: 14,
    'fins-left': 15,
    'fins-right': 16,
    arms: 17,
    legs: 18,
    wings: 19,
  });
  /** Parts take a group in [first, first + count) from a hash of their key, so the group of a hat never depends on what else is worn. */
  const PART_GROUPS = Object.freeze({ first: 64, count: 190 });
  /** A ramp index for a body whose bones all lack paint (should not happen with a real catalogue). */
  const FALLBACK_RAMP = 0;
  /** Paint channels drawn with the look's glint (they mirror the light); a bone that inherits its paint inherits this too. */
  const SHINY_CHANNELS = Object.freeze(['metal']);
  /** Roles whose bones are told apart by side and end in ink keys. */
  const SIDE_ROLES = ['left', 'right'];
  const END_ROLES = ['front', 'hind'];
  const NO_RAMP = -1;
  const VECTOR = 3;

  const fail = (where, message) => {
    throw new Error(`Kit.figure.${where}: ${message}`);
  };

  // ---- types ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} FigurePiece
   * One drawn surface: a mesh in the meshes binding, a run of triangles in a merged one.
   * @property {string} id stable across rebuilds: the bone's name, plus '#<n>' for an extension piece
   * @property {number} bone bone index in the layout's plan (changes when the outfit changes; `id` does not)
   * @property {Object} shape a `ShapeDescriptor` of kit/figure-shapes.js, in the bone's space
   * @property {string} key `shapeKey(shape, level)`: equal keys share one geometry
   * @property {number} ramp index into the bake's `ramps` (never -1: see `resolveRamps`)
   * @property {number} inkGroup 0..255
   * @property {boolean} isProp the bone belongs to an attached part (left out of grounding and framing)
   * @property {boolean} [shiny] passed to the look (`LookPart.shiny`)
   * @property {boolean} [emissive] passed to the look
   * @property {number} [tone] passed to the look: a fixed tone 0..1
   */

  /**
   * @typedef {Object} FeaturePiece
   * EXTENSION POINT (surface features: eyes, a mouth, a nose, horns). Returned by `options.featuresOf(plan,
   * bone, shape)` for a bone; becomes one extra piece riding on that bone. The feature system decides where
   * on the surface it sits (azimuth and elevation over `shape`) and hands over the result in bone space.
   * @property {Object} shape a `ShapeDescriptor` in the bone's space (already placed on the surface: its `at`)
   * @property {number} [ramp] index into the bake's `ramps`; default the bone's own
   * @property {boolean} [glow] true for eyes and glows: ink group 0, never outlined
   * @property {boolean} [shiny]
   * @property {boolean} [emissive]
   * @property {number} [tone]
   */

  /**
   * @typedef {function(Object, number, number, number, number): ?number} RegionLookup
   * EXTENSION POINT (surface regions: clothing, hair as predicates over bone-local coordinates). Called as
   * `regionOf(plan, bone, x, y, z)` for a triangle's centroid in bone space; returns the index into the bake's
   * `ramps` that paints it, or null for the piece's own ramp. Where it plugs in: kit/figure.js
   * `buildPieceGeometry` would split the piece's index buffer by the returned ramp into one sub-piece per ramp
   * (one material each, as the look requires); per-fragment lookups would instead need a ramp attribute and a
   * small addition to the toon shader. Not implemented: passing it today throws, so nobody relies on a no-op.
   */

  /**
   * @typedef {Object} FigureLayout
   * @property {Object} plan the bake's assembled `BodyPlan`
   * @property {string} level the level of detail of every key
   * @property {Int16Array} boneRamp per bone: the resolved ramp index (see `resolveRamps`)
   * @property {Array<?string>} boneChannel per bone: the paint channel it is drawn with, inherited like its ramp
   * @property {FigurePiece[]} pieces in bone order
   * @property {number} rampCount how many ramps the bake has
   */

  // ---- ramps ----------------------------------------------------------------------------------------------------------

  /**
   * Gives every bone a ramp. A bone that names no paint channel (`bake.boneRamp` -1: a quadruped's legs, a
   * part's mount, wings) is painted like its nearest painted ancestor, so a limb takes its body's colour and a
   * ruby takes its sword's. A body with no painted bone at all falls back to ramp 0.
   * @param {Object} plan a `BodyPlan`
   * @param {Int16Array|number[]} boneRamp per bone: a ramp index or -1
   * @returns {Int16Array} per bone: a ramp index, never -1
   * @complexity O(bones): parents come before children, so one forward pass
   * @example Kit.figure.resolveRamps(bake.plan, bake.boneRamp)
   */
  const resolveRamps = (plan, boneRamp) => {
    const resolved = new Int16Array(plan.boneCount);
    const firstPainted = Array.from(boneRamp).find((ramp) => ramp !== NO_RAMP);
    const rootRamp = firstPainted === undefined ? FALLBACK_RAMP : firstPainted;
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const parentBone = plan.parent[bone];
      resolved[bone] = boneRamp[bone] !== NO_RAMP ? boneRamp[bone] : parentBone >= 0 ? resolved[parentBone] : rootRamp;
    }
    return resolved;
  };

  // ---- ink groups -----------------------------------------------------------------------------------------------------

  /** FNV-1a of a string, 32 bits: a part's ink group must not depend on what else is worn. */
  const hashText = (text) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    return hash;
  };

  /**
   * The ink key of a bone: which region of the body it is drawn as one outlined piece with. Body bones go by
   * editor group (kit/body-plan.js `groupOf`) plus end and side, so each limb is its own region; a part's bones
   * go by the top socket they hang from plus side ('part:back-left' for one wing).
   * @param {Object} plan a `BodyPlan`
   * @param {number} bone
   * @returns {string}
   * @complexity O(roles)
   * @example Kit.figure.inkKeyOf(plan, plan.boneIndex('forearmLeft')) // 'arms-left'
   */
  const inkKeyOf = (plan, bone) => {
    const roles = plan.roles[bone];
    const has = (name) => (roles & Kit.body.roleMask([name])) !== 0;
    const side = SIDE_ROLES.find(has);
    const end = END_ROLES.find(has);
    const name = plan.boneNames[bone];
    if (has('prop')) return ['part:' + name.split(Kit.body.SOCKET_PATH_SEPARATOR)[0], side].filter(Boolean).join('-');
    const group = Kit.body.groupOf(roles);
    if (group === 'body' || group === 'head' || group === 'tail') return group;
    return [group, end, side].filter(Boolean).join('-');
  };

  /**
   * The ink group number of an ink key.
   * @param {string} key from `inkKeyOf`, or 'glow'
   * @returns {number} 0..255
   * @complexity O(key length)
   * @example Kit.figure.inkGroupOf('arms-left') // 3
   */
  const inkGroupOf = (key) => (key in INK_GROUPS ? INK_GROUPS[key] : PART_GROUPS.first + (hashText(key) % PART_GROUPS.count));

  // ---- the layout -----------------------------------------------------------------------------------------------------

  /** An extension piece riding on a bone (see `FeaturePiece`): the bone's ramp and region unless it says otherwise. */
  const featurePiece = (feature, id, base, boneGroup, level) => ({
    ...base,
    id,
    shape: feature.shape,
    key: Kit.figure.shapeKey(feature.shape, level),
    ramp: feature.ramp === undefined ? base.ramp : feature.ramp,
    inkGroup: feature.glow ? INK_GROUPS.glow : boneGroup,
    shiny: Boolean(feature.shiny),
    emissive: feature.emissive,
    tone: feature.tone,
  });

  /**
   * Lays out a bake as pieces.
   * @param {{plan: Object, boneRamp: Int16Array, ramps: ReadonlyArray<Object>}} bake from a bakery (kit/body-recipe.js);
   *   a part alone works too: `{ plan: part.plan, boneRamp: new Int16Array(n).fill(-1), ramps: [ramp] }`
   * @param {{level?: string, featuresOf?: function(Object, number, ?Object): FeaturePiece[], regionOf?: RegionLookup}} [options]
   *   `level`: a key of `Kit.figure.LEVELS` (default 'high'). `featuresOf` and `regionOf` are the two extension
   *   points described by `FeaturePiece` and `RegionLookup`.
   * @returns {FigureLayout}
   * @throws {Error} when `regionOf` is given (not implemented yet, see `RegionLookup`)
   * @complexity O(bones x subtree) to find capsule ends (at most O(bones^2), a few hundred steps for a body), plus O(shape size) per piece
   * @example const layout = Kit.figure.layout(bakery.bakeRecipe({ species: 'human', seed: 1 }));
   */
  const layout = (bake, options = {}) => {
    if (!bake || !bake.plan || !bake.boneRamp) fail('layout', 'needs a bake from a bakery: { plan, boneRamp, ramps }.');
    if (options.regionOf) fail('layout', 'surface regions (`regionOf`) are an extension point that is not implemented yet; see the RegionLookup typedef in kit/figure-layout.js.');
    const { plan } = bake;
    const level = options.level || Kit.figure.DEFAULT_LEVEL;
    const boneRamp = resolveRamps(plan, bake.boneRamp);
    const boneChannel = [];
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const own = plan.bonePaint[bone] ? plan.paintChannels[plan.bonePaint[bone] - 1] : null;
      boneChannel.push(own || (plan.parent[bone] >= 0 ? boneChannel[plan.parent[bone]] : null));
    }
    const propMask = Kit.body.roleMask(['prop']);
    const isProp = (bone) => (plan.roles[bone] & propMask) !== 0;
    const mountSuffix = `${Kit.body.SOCKET_PATH_SEPARATOR}${Kit.body.MOUNT_BONE}`;
    const isHidden = (bone) => plan.boneNames[bone].endsWith(mountSuffix);
    const inkKeys = Array.from({ length: plan.boneCount }, (_unused, bone) => inkKeyOf(plan, bone));
    // A limb narrows into its next segment; a chest keeps its width up to the neck (another region).
    const taperInto = (bone, child) => inkKeys[bone] === inkKeys[child] && Kit.body.groupOf(plan.roles[bone]) !== 'body';
    const pieces = [];
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const shape = Kit.figure.describeShape(plan, bone, { isHidden, skipChild: (from, child) => isProp(child) !== isProp(from) || isHidden(child), taperInto });
      const base = { bone, ramp: boneRamp[bone], isProp: isProp(bone), shiny: SHINY_CHANNELS.includes(boneChannel[bone]) };
      if (shape) pieces.push({ ...base, id: plan.boneNames[bone], shape, key: Kit.figure.shapeKey(shape, level), inkGroup: inkGroupOf(inkKeys[bone]) });
      const features = options.featuresOf ? options.featuresOf(plan, bone, shape) || [] : [];
      features.forEach((feature, index) => pieces.push(featurePiece(feature, `${plan.boneNames[bone]}#${index}`, base, inkGroupOf(inkKeys[bone]), level)));
    }
    return { plan, level, boneRamp, boneChannel, pieces, rampCount: bake.ramps ? bake.ramps.length : 0 };
  };

  // ---- incremental updates --------------------------------------------------------------------------------------------

  /** What makes a drawn piece the same piece: its identity, its surface and everything its material reads. */
  const pieceSignature = (piece) => [piece.id, piece.key, piece.ramp, piece.inkGroup, piece.shiny ? 1 : 0, piece.emissive ? 1 : 0, piece.tone === undefined ? '' : piece.tone].join('|');

  /**
   * @typedef {Object} FigureUpdate
   * @property {Array<{from: FigurePiece, to: FigurePiece}>} keep pieces drawn as they are; only their bone index may move
   * @property {FigurePiece[]} add pieces to build (a geometry from the cache or new, two new materials)
   * @property {FigurePiece[]} remove pieces to take down
   * @property {boolean} recolor the palette rows must be rewritten (a colour changed)
   * @property {boolean} remeasure the rest pose changed, so grounding and framing must be measured again
   */

  /**
   * Plans the smallest update from one layout to the next, given what `editor.changes` reported. A dial drag
   * keeps every piece (shapes live in bone space, so the new rest pose re-shapes them through the matrices); a
   * colour change keeps every piece and rewrites palette rows; a socket change adds or removes exactly the
   * part's pieces; a species change rebuilds what no longer matches.
   * @param {FigureLayout} previous
   * @param {FigureLayout} next
   * @param {{colors?: string[], bones?: number[], rebuild?: boolean}} [changes] from `editor.changes(previousBake, nextBake)`;
   *   without it every colour is rewritten and the body is measured again
   * @returns {FigureUpdate}
   * @complexity O(pieces) time and space
   * @example const update = Kit.figure.planUpdate(shownLayout, Kit.figure.layout(nextBake), editor.changes(shownBake, nextBake));
   */
  const planUpdate = (previous, next, changes) => {
    const before = new Map(previous.pieces.map((piece) => [pieceSignature(piece), piece]));
    const keep = [];
    const add = [];
    next.pieces.forEach((piece) => {
      const signature = pieceSignature(piece);
      const from = before.get(signature);
      if (!from) return void add.push(piece);
      before.delete(signature);
      keep.push({ from, to: piece });
    });
    const report = changes || {};
    return {
      keep,
      add,
      remove: [...before.values()],
      recolor: !changes || (report.colors || []).length > 0 || previous.rampCount !== next.rampCount,
      remeasure: !changes || Boolean(report.rebuild) || (report.bones || []).length > 0,
    };
  };

  // ---- grounding and framing ------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} RestMeasure
   * @property {number} lowestY the lowest point of any body surface, metres (props left out: a sword held low does not lift the body)
   * @property {number} highestY the highest point of any body surface
   * @property {number} centerX the middle of the body's footprint across X, so a long body (a hound) can turn about its middle
   * @property {number} centerZ the middle of the footprint along Z
   * @property {number} reach how far the body's footprint reaches from that middle (half its diagonal), metres:
   *   a figure turning about the middle stays inside it
   * @property {number} lowestPropY the lowest point of a prop, or Infinity when none is worn
   */

  /**
   * Measures the body's surfaces at rest, props left out.
   * @param {FigureLayout} figureLayout
   * @param {{translation: Float32Array, rotation: Float32Array, scale: Float32Array}} world the rest pose's world
   *   transforms (`Kit.body.worldTransforms(plan, bake.rest, world)`)
   * @param {function(FigurePiece): Float32Array} positionsOf the bone-space positions of a piece's surface
   *   (`Kit.figure.buildShape(piece.shape, level).positions`, or a cached geometry's position array)
   * @returns {RestMeasure}
   * @complexity O(vertices of the pieces), no allocation per vertex; once per bake, not per frame
   * @example const { lowestY } = Kit.figure.measureRest(layout, restWorld, (piece) => cache.positions(piece));
   */
  const measureRest = (figureLayout, world, positionsOf) => {
    const matrix = new Float32Array(16);
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    let lowestPropY = Infinity;
    figureLayout.pieces.forEach((piece) => {
      Kit.figure.writeBoneMatrix(world, piece.bone, matrix);
      const positions = positionsOf(piece);
      // Measured hot loop over a typed array (thousands of vertices): plain index arithmetic.
      for (let offset = 0; offset < positions.length; offset += VECTOR) {
        const [x, y, z] = [positions[offset], positions[offset + 1], positions[offset + 2]];
        const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        if (piece.isProp) {
          lowestPropY = Math.min(lowestPropY, worldY);
          continue;
        }
        const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        box.minX = Math.min(box.minX, worldX);
        box.maxX = Math.max(box.maxX, worldX);
        box.minY = Math.min(box.minY, worldY);
        box.maxY = Math.max(box.maxY, worldY);
        box.minZ = Math.min(box.minZ, worldZ);
        box.maxZ = Math.max(box.maxZ, worldZ);
      }
    });
    if (box.minY === Infinity) return { lowestY: 0, highestY: 0, centerX: 0, centerZ: 0, reach: 0, lowestPropY };
    return {
      lowestY: box.minY,
      highestY: box.maxY,
      centerX: (box.minX + box.maxX) / 2,
      centerZ: (box.minZ + box.maxZ) / 2,
      reach: Math.hypot(box.maxX - box.minX, box.maxZ - box.minZ) / 2,
      lowestPropY,
    };
  };

  /**
   * @typedef {Object} ViewWindow
   * An orthographic camera's window onto a figure: the world point at its centre and its half extents.
   * @property {number} centerX world units across the camera (0: the figure's vertical axis)
   * @property {number} centerY world height of the centre
   * @property {number} halfWidth
   * @property {number} halfHeight
   */

  /**
   * Fits a window round a measured body standing on the ground, for a screen area of a given aspect. Fitted to
   * the body alone (`measureRest` leaves props out), so putting on a hat or picking up a sword never rescales
   * the view; it rescales only when the body itself changes (a height dial).
   * @param {RestMeasure} measured with the figure grounded (`lowestY` 0) or not: the window sits on `lowestY`
   * @param {number} aspect width / height of the screen area
   * @param {{margin?: number, headroom?: number}} [options] `margin`: share of the body's size added on every
   *   side (default 0.12); `headroom`: extra share above, for a hat (default 0.2)
   * @returns {ViewWindow}
   * @complexity O(1)
   * @example const window = Kit.figure.fitView(figure.measured, width / height);
   */
  const fitView = (measured, aspect, options = {}) => {
    const margin = options.margin === undefined ? 0.12 : options.margin;
    const headroom = options.headroom === undefined ? 0.2 : options.headroom;
    const height = Math.max(measured.highestY - measured.lowestY, Number.EPSILON);
    const bottom = measured.lowestY - height * margin;
    const top = measured.highestY + height * (margin + headroom);
    const neededHalfWidth = measured.reach * (1 + margin);
    const halfHeight = Math.max((top - bottom) / 2, neededHalfWidth / aspect);
    // When the width decides, the body stays on the ground of the window: extra room goes above, not below.
    return { centerX: 0, centerY: bottom + halfHeight, halfWidth: halfHeight * aspect, halfHeight };
  };

  Kit.figure = Object.assign(Kit.figure || {}, { INK_GROUPS, PART_GROUPS, SHINY_CHANNELS, resolveRamps, inkKeyOf, inkGroupOf, layout, planUpdate, measureRest, fitView });
})();
