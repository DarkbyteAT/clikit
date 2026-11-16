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
 * Two extension points (see `layout`): surface features (eyes, a mouth, a nose) arrive as extra pieces per
 * bone, and surface regions (clothing, hair) as a baked map per bone that the look reads per fragment, plus one
 * shell piece per raised layer. The body system fills both (`Kit.body.FIGURE_HOOKS`), and they are the default
 * for a bake that has a `surface`; anything else with the same shapes can fill them too.
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
  /** The role kit/body-parts.js gives every bone of an attached part. */
  const PROP_ROLE = 'prop';
  const VECTOR = 3;

  const fail = (where, message) => {
    throw new Error(`Kit.figure.${where}: ${message}`);
  };

  // ---- types ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} FigurePiece
   * One drawn surface: a mesh in the meshes binding, a run of triangles in a merged one.
   * @property {string} id stable across rebuilds: the bone's name; '<bone>><child>' for an extra link of a hub
   *   bone (a chest to a shoulder); '<bone>#<n>' for an extension piece
   * @property {number} bone bone index in the layout's plan (changes when the outfit changes; `id` does not)
   * @property {Object} shape a `ShapeDescriptor` of kit/figure-shapes.js, in the bone's space
   * @property {string} key `shapeKey(shape, level)`: equal keys share one geometry
   * @property {number} ramp index into the bake's `ramps` (never -1: see `resolveRamps`)
   * @property {number} inkGroup 0..255
   * @property {boolean} isProp the bone belongs to an attached part (left out of grounding and framing)
   * @property {boolean} [shiny] passed to the look (`LookPart.shiny`)
   * @property {boolean} [emissive] passed to the look
   * @property {number} [tone] passed to the look: a fixed tone 0..1
   * @property {RegionMapOnBone} [regions] the baked regions of the piece's bone: the look paints the piece from it
   * @property {number} [shell] 0 or absent: the bone's own surface; k: the shell of `regions.shells[k - 1]`,
   *   which shows only the texels raised that far (id '<bone>~<k>')
   * @property {boolean} [stamps] the piece is a `stamps` shape: each vertex carries its paint
   * @property {boolean} [outlined] false: no hull outline of its own
   */

  /**
   * @typedef {Object} RegionMapOnBone
   * EXTENSION POINT (surface regions: clothing and hair as predicates over bone-local coordinates). Returned by
   * `options.regionMapOf(plan, bone, bake)` for a bone that something paints, else null.
   * @property {string} key equal keys are equal maps (they share one texture)
   * @property {number} width texels around
   * @property {number} height texels along
   * @property {Uint8Array} data a `RegionMap` of kit/region.js: per texel [ramp slot or 255, line-class slot or 255, shell index, flags]
   * @property {number[]} shells raises in metres, ascending; shell index k in `data` is `shells[k - 1]`
   * @property {number[]} end [x, y, z] the far end of the bone's long axis in bone space: s runs 0 at the joint to 1 there
   * @property {number} front the axis (0 = x, 1 = y, 2 = z) the around-angle is measured from
   * @property {number} side the axis it grows towards
   */

  /**
   * @typedef {Object} FeaturePiece
   * EXTENSION POINT (surface features: eyes, a mouth, a nose, horns). Returned by `options.featuresOf(plan,
   * bone, shape, bake)` for a bone; becomes one extra piece riding on that bone. The feature system decides where
   * on the surface it sits (azimuth and elevation over `shape`) and hands over the result in bone space.
   * @property {Object} shape a `ShapeDescriptor` in the bone's space (already placed on the surface: its `at`)
   * @property {number} [ramp] index into the bake's `ramps`; default the bone's own
   * @property {boolean} [glow] true for eyes and glows: ink group 0, never outlined
   * @property {boolean} [shiny]
   * @property {boolean} [emissive]
   * @property {number} [tone]
   * @property {boolean} [stamps] the shape is of kind 'stamps' (flat polygons that carry their own paint): it is
   *   drawn in one call, never outlined, and hidden where the bone's regions occlude (hair over a brow)
   * @property {boolean} [outlined] false: the piece gets no hull outline of its own (a nose inside a face)
   */

  /**
   * @typedef {function(Object, number, number, number, number): ?number} RegionLookup
   * A point lookup `regionOf(plan, bone, x, y, z)` -> ramp index (`Kit.body.figureHooks(bake).regionOf`). The
   * renderer does not use it: regions are drawn from a map baked once per outfit (`RegionMapOnBone`), not from a
   * lookup per triangle or per fragment (DECISIONS.md, "Regions in 3D"). Passing it to `layout` throws and names
   * `regionMapOf`, so nobody relies on a no-op.
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

  /**
   * The paint channel each bone is drawn with, inherited exactly like its ramp (`resolveRamps`), so a ruby on a
   * sword is metal too.
   * @param {Object} plan a `BodyPlan`
   * @returns {Array<?string>} per bone: a channel name, or null when no ancestor is painted
   * @complexity O(bones)
   * @example Kit.figure.resolveChannels(plan)[plan.boneIndex('handRight/blade')] // 'metal'
   */
  const resolveChannels = (plan) => {
    const channels = [];
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const own = plan.bonePaint[bone] ? plan.paintChannels[plan.bonePaint[bone] - 1] : null;
      channels.push(own || (plan.parent[bone] >= 0 ? channels[plan.parent[bone]] : null));
    }
    return channels;
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
    if (has(PROP_ROLE)) return ['part:' + name.split(Kit.body.SOCKET_PATH_SEPARATOR)[0], side].filter(Boolean).join('-');
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
    // Only stamps read the bone's regions (to hide under hair); a solid (an ear, a nose) keeps its own paint.
    regions: feature.stamps ? base.regions : undefined,
    ...(feature.stamps ? { stamps: true } : {}),
    ...(feature.outlined === false ? { outlined: false } : {}),
  });

  /** The body system's hooks, when it is loaded and the bake carries a surface; else none. */
  const defaultHooks = (bake) => (bake.surface && Kit.body && Kit.body.FIGURE_HOOKS) || {};

  /**
   * Lays out a bake as pieces.
   * @param {{plan: Object, boneRamp: Int16Array, ramps: ReadonlyArray<Object>, shapes?: ReadonlyArray<?Object>}} bake from a bakery (kit/body-recipe.js);
   *   a part alone works too: `{ plan: part.plan, boneRamp: new Int16Array(n).fill(-1), ramps: [ramp] }`
   * @param {{level?: string, featuresOf?: ?function(Object, number, ?Object, Object): FeaturePiece[], regionMapOf?: ?function(Object, number, Object): ?RegionMapOnBone, regionOf?: RegionLookup}} [options]
   *   `level`: a key of `Kit.figure.LEVELS` (default 'high'). `featuresOf` and `regionMapOf` are the two
   *   extension points described by `FeaturePiece` and `RegionMapOnBone`; left out, a bake with a `surface` gets
   *   the body system's (`Kit.body.FIGURE_HOOKS`); pass null to draw the bare bones.
   * @returns {FigureLayout}
   * @throws {Error} when `regionOf` is given (see `RegionLookup`)
   * @complexity O(bones x subtree) to find capsule ends (at most O(bones^2), a few hundred steps for a body), plus O(shape size) per piece
   * @example const layout = Kit.figure.layout(bakery.bakeRecipe({ species: 'human', seed: 1 }));
   */
  const layout = (bake, options = {}) => {
    if (!bake || !bake.plan || !bake.boneRamp) fail('layout', 'needs a bake from a bakery: { plan, boneRamp, ramps }.');
    if (options.regionOf) fail('layout', 'regions are drawn from a baked map, not a point lookup: pass `regionMapOf` (Kit.body.FIGURE_HOOKS.regionMapOf, the default for a body bake) instead of `regionOf`.');
    const hooks = defaultHooks(bake);
    const featuresOf = options.featuresOf === undefined ? hooks.featuresOf : options.featuresOf;
    const regionMapOf = options.regionMapOf === undefined ? hooks.regionMapOf : options.regionMapOf;
    const { plan } = bake;
    const level = options.level || Kit.figure.DEFAULT_LEVEL;
    const boneRamp = resolveRamps(plan, bake.boneRamp);
    const boneChannel = resolveChannels(plan);
    const propMask = Kit.body.roleMask([PROP_ROLE]);
    const isProp = (bone) => (plan.roles[bone] & propMask) !== 0;
    const mountSuffix = `${Kit.body.SOCKET_PATH_SEPARATOR}${Kit.body.MOUNT_BONE}`;
    const isHidden = (bone) => plan.boneNames[bone].endsWith(mountSuffix);
    const inkKeys = Array.from({ length: plan.boneCount }, (_unused, bone) => inkKeyOf(plan, bone));
    const rules = { isHidden, skipChild: (from, child) => isProp(child) !== isProp(from) || isHidden(child), isSameRegion: (bone, child) => inkKeys[bone] === inkKeys[child], shapes: bake.shapes };
    const pieces = [];
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const surfaces = Kit.figure.describeShapes(plan, bone, rules);
      const regions = (surfaces.length && regionMapOf && regionMapOf(plan, bone, bake)) || undefined;
      const base = { bone, ramp: boneRamp[bone], isProp: isProp(bone), shiny: SHINY_CHANNELS.includes(boneChannel[bone]), ...(regions ? { regions } : {}) };
      // A bone's own surface is named after it; an extra link after the bone and the child it reaches ('chest>upperArmLeft').
      const idOf = (child) => (child < 0 ? plan.boneNames[bone] : `${plan.boneNames[bone]}>${plan.boneNames[child]}`);
      surfaces.forEach(({ shape, child }) => pieces.push({ ...base, id: idOf(child), shape, key: Kit.figure.shapeKey(shape, level), inkGroup: inkGroupOf(inkKeys[bone]) }));
      // A raised layer is drawn on a shell: the same surfaces pushed out along their normals, showing only that layer's texels.
      (regions ? regions.shells : []).forEach((raise, index) =>
        surfaces.forEach(({ shape, child }) => {
          const raised = { ...shape, inflate: raise };
          pieces.push({ ...base, id: `${idOf(child)}~${index + 1}`, shape: raised, key: Kit.figure.shapeKey(raised, level), inkGroup: inkGroupOf(inkKeys[bone]), shell: index + 1 });
        })
      );
      const shape = surfaces.length ? surfaces[0].shape : null;
      const features = featuresOf ? featuresOf(plan, bone, shape, bake) || [] : [];
      features.forEach((feature, index) => pieces.push(featurePiece(feature, `${plan.boneNames[bone]}#${index}`, base, inkGroupOf(inkKeys[bone]), level)));
    }
    return { plan, level, boneRamp, boneChannel, pieces, rampCount: bake.ramps ? bake.ramps.length : 0 };
  };

  // ---- incremental updates --------------------------------------------------------------------------------------------

  /** What makes a drawn piece the same piece: its identity, its surface and everything its material reads. */
  const pieceSignature = (piece) =>
    [piece.id, piece.key, piece.ramp, piece.inkGroup, piece.shiny ? 1 : 0, piece.emissive ? 1 : 0, piece.tone === undefined ? '' : piece.tone, piece.regions ? piece.regions.key : '', piece.shell || 0, piece.outlined === false ? 0 : 1].join('|');

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
    // When the width decides, the extra height is shared above and below: the body sits in the middle.
    return { centerX: 0, centerY: (bottom + top) / 2, halfWidth: halfHeight * aspect, halfHeight };
  };

  Kit.figure = Object.assign(Kit.figure || {}, { INK_GROUPS, PART_GROUPS, SHINY_CHANNELS, resolveRamps, resolveChannels, inkKeyOf, inkGroupOf, layout, planUpdate, measureRest, fitView });
})();
