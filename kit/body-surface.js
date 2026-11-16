/**
 * Kit body surface: what is drawn ON a body's bones rather than as bones. Surface features (eyes, brows, a nose,
 * a mouth, ears, freckles, a scar) are placed on a bone's shape by azimuth and elevation, alone or as a mirrored
 * pair, with a flat stamp (frames of outlines: open, half, closed) and / or a small solid; regions (a sleeve, a
 * hairline, stripes, a belly patch) are predicate trees over a bone's along / around coordinates that paint the
 * bone with another colour channel. Both are data on a plan or a part; this file lays them out for a bake.
 *
 * Owns:  `Kit.body.surfaceLayout(plan)` (validate and index a plan's features and regions; cached per plan) and
 *        `Kit.body.surfaceOf(...)` (one individual's placements and painted layers, with `regionAt`), plus the
 *        `FeatureSpec` and `RegionSpec` shapes and `FRAME_SETS`.
 * Does not own: the maths of placing on a solid (kit/surface.js), the predicates (kit/region.js), how features
 *        and regions travel with parts (kit/body-parts.js), or drawing them (renderers; kit/body-debug.js marks them).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const VECTOR_STRIDE = 3;
  /** Feature defaults: a 3 cm stamp straight ahead, flat on the surface, turned not at all. */
  const FEATURE_DEFAULTS = Object.freeze({ azimuth: 0, elevation: 0, size: 0.03, rotation: 0, lift: 0 });
  /** The numbers of a feature that dials may drive, so a misspelt `param` is caught when the bake is laid out. */
  const FEATURE_PARAMS = Object.freeze(['azimuth', 'elevation', 'spacing', 'size', 'rotation', 'lift']);
  /**
   * Named frame sets an animator steps through, set -> frame names in order. A feature lists the frames it has;
   * `blink` and `talk` are the two a face needs. Adding a set means adding a row.
   */
  const FRAME_SETS = Object.freeze({ blink: Object.freeze(['open', 'half', 'closed']), talk: Object.freeze(['rest', 'smile', 'open']) });
  const SIDES = Object.freeze(['left', 'right']);
  const NO_RAMP = -1;
  const PROP_ROLE = 'prop';
  /** Solids that run along an axis, and so need a feature solid to say where it ends. */
  const SOLIDS_WITH_AN_AXIS = Object.freeze(['capsule', 'lathe', 'extrude']);

  const fail = (where, message) => {
    throw new Error(`Kit.body.${where}: ${message}`);
  };

  /**
   * @typedef {Object} StampLayer
   * @property {number[][]} outline [[u, v], ...] in the stamp's own square, -1 to 1 each way (`Kit.surface.ellipse`
   *   draws one); u runs across (towards the body's left on a front-facing stamp), v up
   * @property {{channel: string, shade: number}} paint a colour channel of the species and a shade of its ramp
   *   (0 is the darkest); the shade is clamped to the ramp
   */

  /**
   * @typedef {Object} FeatureSpec
   * @property {string} id what dials and animators call it ('eye', 'mouth'); several features may share an id
   * @property {string} [bone] the bone it sits on (a part's features default to the bone of the socket it is in)
   * @property {number} [azimuth=0] degrees about the bone's +Y from its +Z (the front) towards +X (its left)
   * @property {number} [elevation=0] degrees above the middle of the bone's shape
   * @property {number} [spacing] degrees between the two copies of a mirrored pair (left at +spacing/2); omit for one copy
   * @property {(number|number[])} [size=0.03] metres across the stamp, or [width, height]
   * @property {number} [rotation=0] degrees about the surface normal (the right copy of a pair turns the other way)
   * @property {number} [lift=0] metres out along the normal (a nose tip stands proud)
   * @property {Object<string, StampLayer[]>} [frames] frame name -> the stamp's layers, bottom first
   * @property {string} [rest] the frame shown when nothing animates it (default: the first frame)
   * @property {Object} [shape] a solid in the feature's own frame, metres at the authored size (`Kit.body.SHAPES`
   *   row: +X across, +Y along `up`, +Z out along the normal), for a nose or an ear that has a silhouette. A
   *   capsule, lathe or extrude states `end` [x, y, z], the far end of its long axis (a nose runs down: [0, -0.03, 0.01])
   * @property {string} [paint] the colour channel of the solid (default 'skin')
   * @property {boolean} [glow] draw it as a glow (eyes): a renderer leaves it out of outlines
   */

  /**
   * @typedef {Object} RegionSpec
   * @property {string} id what it is ('sleeve', 'hairline')
   * @property {string[]} [roles] paint every bone of the body carrying ALL of these roles (never a prop's bone)
   * @property {string[]} [except] ...but not a bone carrying any of these (['hand'] keeps a sleeve off the hand)
   * @property {string[]} [bones] paint these bones by name
   * @property {Object} where a `Kit.region` predicate tree over the bone's along / around coordinates
   * @property {string} paint the colour channel it paints with
   * @property {number} [layer=0] stacking order: higher covers lower (skin marks 1, clothes 2, outerwear 3, hair 4)
   */

  /**
   * @typedef {Object} FeaturePlacement
   * One copy of a feature on an individual: everything a renderer needs to stamp or build it.
   * @property {string} id
   * @property {number} bone bone index in the assembled plan
   * @property {?string} side 'left' or 'right' for a copy of a pair, else null
   * @property {boolean} flip true for the right copy: mirror the stamp's u (and the solid's x)
   * @property {number[]} point [x, y, z] on the bone's (dialled) shape, in the bone's space, lifted by `lift`
   * @property {number[]} normal unit, out of the surface
   * @property {number[]} up unit, in the tangent plane; across = up x normal
   * @property {number[]} size [width, height] metres
   * @property {number} rotation radians about the normal
   * @property {Object<string, Array<{outline: number[][], ramp: number, shade: number}>>} frames frame name ->
   *   layers with their paint resolved to (index into the bake's `ramps`, shade); ramp -1 when the species lacks the channel
   * @property {?string} rest
   * @property {?Object} shape
   * @property {number[]} scale [across, up] the solid's stretch: this copy's size over the authored size (dials)
   * @property {number} ramp the solid's ramp index (-1 when none)
   * @property {?string} part the part it came from, null for the plan's own
   * @property {boolean} glow the feature asked to be drawn as a glow (eyes): never outlined
   */

  /** The far end of a bone in its own space: its tail, else its first child's offset, else straight up its length. */
  const boneEnd = (plan, bone) => {
    const vector = bone * VECTOR_STRIDE;
    const tail = [0, 1, 2].map((axis) => plan.tail[vector + axis]);
    if (tail.some((value) => value !== 0)) return tail;
    const child = plan.parent.indexOf(bone);
    if (child >= 0) return [0, 1, 2].map((axis) => plan.restTranslation[child * VECTOR_STRIDE + axis]);
    const end = [0, 0, 0];
    end[plan.axis[bone]] = plan.length[bone];
    return end;
  };

  const ownerOf = (what, spec) => `the ${what} "${spec.id}"${spec.part ? ` of the part "${spec.part}"` : ''}`;
  const compileRegion = (where, owner, tree) => {
    try {
      return Kit.region.compile(tree);
    } catch (error) {
      return fail(where, `${owner}: ${error.message}`);
    }
  };

  /**
   * Checks the features and regions of a plan or part spec without placing them: ids, frames and their
   * layers, solids, paints and predicates. A catalogue calls it for every plan and part at load, so a mistake in
   * a content table is named before anything is rolled. Bone names are checked when a plan is laid out.
   * @param {{id: string, features?: FeatureSpec[], regions?: RegionSpec[]}} spec a plan or part spec
   * @param {string} [where] who is asking, for the message (default the spec's id)
   * @returns {void}
   * @throws {Error} naming the spec and the feature or region at fault
   * @complexity O(features x frame layers + region nodes)
   * @example Kit.body.checkSurface({ id: 'eyesRound', features: [eye] });
   */
  const checkSurface = (spec, where = `checkSurface("${spec.id}")`) => {
    (spec.features || []).forEach((feature) => {
      if (typeof feature.id !== 'string' || !feature.id) fail(where, `every feature needs a string \`id\`, got ${JSON.stringify(feature)}.`);
      const owner = ownerOf('feature', feature);
      Object.keys(feature.frames || {}).forEach((frame) =>
        feature.frames[frame].forEach((layer) => {
          if (!Array.isArray(layer.outline) || layer.outline.length < 3 || !layer.paint || typeof layer.paint.channel !== 'string')
            fail(where, `${owner}, frame "${frame}": every layer needs an \`outline\` of 3 or more [u, v] points and a \`paint\` { channel, shade }.`);
        })
      );
      if (feature.rest !== undefined && !(feature.frames || {})[feature.rest])
        fail(where, `${owner} rests on the frame "${feature.rest}", which it does not have. Frames: ${Object.keys(feature.frames || {}).join(', ') || '(none)'}.`);
      if (feature.shape && !Kit.surface.KINDS[feature.shape.kind])
        fail(where, `${owner} has a solid of kind ${JSON.stringify(feature.shape.kind)}; use one of ${Object.keys(Kit.surface.KINDS).join(', ')}.`);
      if (feature.shape && SOLIDS_WITH_AN_AXIS.includes(feature.shape.kind) && !Array.isArray(feature.shape.end))
        fail(where, `${owner} has a ${feature.shape.kind} solid, which needs \`end\` [x, y, z]: where its long axis ends.`);
      if (!feature.shape && !Object.keys(feature.frames || {}).length) fail(where, `${owner} has neither \`frames\` (a stamp) nor a \`shape\` (a solid), so nothing would be drawn.`);
    });
    (spec.regions || []).forEach((region) => {
      const owner = ownerOf('region', region);
      if (typeof region.paint !== 'string' || !region.paint) fail(where, `${owner} needs \`paint\`, the colour channel it paints with.`);
      if (!region.roles && !region.bones) fail(where, `${owner} names neither \`roles\` nor \`bones\`, so it would paint nothing.`);
      compileRegion(where, owner, region.where);
    });
  };

  /** Layouts by plan: a plan is frozen, so its features and regions are checked and indexed once. */
  const layouts = new WeakMap();

  /**
   * Checks and indexes a plan's features and regions: every name resolved to a bone index, every region
   * predicate compiled, every bone's region layers in stacking order. Cached per plan, so an outfit pays once.
   * @param {Object} plan a `BodyPlan` (bare or assembled)
   * @returns {{features: Array<{spec: FeatureSpec, bone: number}>, regionsByBone: Array<Array<{spec: RegionSpec, test: Function}>>, frames: Array<{end: number[], axis: number, girth: number}>}}
   * @throws {Error} naming the plan and the feature or region: an unknown bone, a missing id, a bad predicate, a
   *   frame layer without an outline or paint, a region that selects no bones by neither roles nor names
   * @complexity O(features + regions x bones) once per plan; O(1) after
   * @example Kit.body.surfaceLayout(catalog.plans.humanoid).features.length
   */
  const surfaceLayout = (plan) => {
    const known = layouts.get(plan);
    if (known) return known;
    const where = `surfaceLayout("${plan.id}")`;
    const boneIndexOf = (owner, name) => {
      if (!plan.boneNames.includes(name)) fail(where, `${owner} names the bone "${name}", which this plan does not have. Bones: ${plan.boneNames.join(', ')}.`);
      return plan.boneIndex(name);
    };
    checkSurface(plan.spec, where);
    const features = (plan.spec.features || []).map((spec) => {
      const owner = ownerOf('feature', spec);
      if (spec.bone === undefined) fail(where, `${owner} names no \`bone\` to sit on.`);
      return { spec, bone: boneIndexOf(owner, spec.bone) };
    });
    const propMask = Kit.body.roleMask([PROP_ROLE]);
    const regionsByBone = plan.boneNames.map(() => []);
    const ordered = (plan.spec.regions || []).map((spec, order) => ({ spec, order })).sort((first, second) => (first.spec.layer || 0) - (second.spec.layer || 0) || first.order - second.order);
    ordered.forEach(({ spec }) => {
      const owner = ownerOf('region', spec);
      const test = compileRegion(where, owner, spec.where);
      const exceptMask = spec.except ? Kit.body.roleMask(spec.except) : 0;
      const byRole = spec.roles ? Kit.body.bonesWithRoles(plan, Kit.body.roleMask(spec.roles)).filter((bone) => !(plan.roles[bone] & propMask) && !(plan.roles[bone] & exceptMask)) : [];
      const byName = (spec.bones || []).map((name) => boneIndexOf(owner, name));
      [...new Set([...byRole, ...byName])].forEach((bone) => regionsByBone[bone].push({ spec, test }));
    });
    const frames = plan.boneNames.map((_name, bone) => ({ end: boneEnd(plan, bone), axis: plan.axis[bone], girth: plan.girth[bone] }));
    const layout = Object.freeze({ features, regionsByBone, frames });
    layouts.set(plan, layout);
    return layout;
  };

  /** A copy of a feature's numbers that dials may write, per copy of the feature. */
  const featureNumbers = (spec) => {
    const size = spec.size === undefined ? FEATURE_DEFAULTS.size : spec.size;
    return {
      azimuth: spec.azimuth === undefined ? FEATURE_DEFAULTS.azimuth : spec.azimuth,
      elevation: spec.elevation === undefined ? FEATURE_DEFAULTS.elevation : spec.elevation,
      spacing: spec.spacing === undefined ? 0 : spec.spacing,
      size: Array.isArray(size) ? [...size] : [size, size],
      rotation: spec.rotation === undefined ? FEATURE_DEFAULTS.rotation : spec.rotation,
      lift: spec.lift === undefined ? FEATURE_DEFAULTS.lift : spec.lift,
    };
  };

  /** Applies the feature dials that name this feature (and this side, when they name one) to its numbers. */
  const applyFeatureDials = (numbers, featureId, side, dialSet, values) => {
    dialSet.featureOps.forEach(({ dial, feature, path, amount, mode, side: opSide }) => {
      if (feature !== featureId || (opSide && opSide !== side)) return;
      if (!FEATURE_PARAMS.includes(String(path[0]))) fail('surfaceOf', `a dial drives "${path.join('.')}" of the feature "${featureId}"; a feature's numbers are ${FEATURE_PARAMS.join(', ')}.`);
      const value = Math.min(dialSet.max[dial], Math.max(dialSet.min[dial], values[dial]));
      // 'size' alone scales both sides of the stamp; 'size.0' or 'size.1' one of them.
      const targets =
        path[0] === 'size' && path.length === 1
          ? [
              ['size', 0],
              ['size', 1],
            ]
          : [path];
      targets.forEach((target) => {
        const holder = Kit.body.numberAtPath(numbers, target.slice(0, -1));
        const key = target[target.length - 1];
        holder[key] = Kit.body.PARAM_MODES[mode](holder[key], value, dialSet.defaults[dial], amount);
      });
    });
    return numbers;
  };

  /**
   * One individual's surface: every feature copy placed on its dialled bone shape, every bone's painted layers
   * with channels resolved to the individual's ramps, and `regionAt` to ask which ramp paints a point.
   * @param {Object} plan the assembled `BodyPlan` of the bake
   * @param {ReadonlyArray<?Object>} shapes per bone, from `Kit.body.shapesWithDials`
   * @param {Object} dialSet the `DialSet` compiled against `plan` (its `featureOps` are applied here)
   * @param {ArrayLike<number>} values the individual's dial values
   * @param {ReadonlyArray<string>} channels the species' colour channel ids, in the order of the bake's `ramps`
   * @param {ReadonlyArray<{shades: string[]}>} ramps the individual's ramp per channel, for clamping shades
   * @returns {{features: FeaturePlacement[], regions: ReadonlyArray<ReadonlyArray<{id: string, ramp: number, test: Function}>>, regionAt: function(number, number, number, number, number, number): number}}
   *   `regionAt(bone, along, angle, normalX, normalY, normalZ)` returns the index in `ramps` of the topmost region
   *   painting that point, or -1 when none does (the bone keeps its own paint, `bake.boneRamp`)
   * @complexity O(feature copies x a placement, about 40 distance evaluations) + O(regions); about a hundred
   *   microseconds for a full face, once per bake
   * @example
   * const surface = Kit.body.surfaceOf(bake.plan, bake.shapes, dialSet, individual.dials, kind.colorIds, bake.ramps);
   * surface.features.filter((feature) => feature.id === 'eye').length // 2
   */
  const surfaceOf = (plan, shapes, dialSet, values, channels, ramps) => {
    const layout = surfaceLayout(plan);
    const rampOf = (channel) => channels.indexOf(channel);
    const paintOf = (paint) => {
      const ramp = rampOf(paint.channel);
      const darkest = 0;
      const lightest = ramp === NO_RAMP ? 0 : ramps[ramp].shades.length - 1;
      return { ramp, shade: Math.max(darkest, Math.min(lightest, paint.shade || 0)) };
    };
    const features = layout.features.flatMap(({ spec, bone }) => {
      const sides = spec.spacing === undefined ? [null] : SIDES;
      const resolvedFrames = Object.fromEntries(Object.keys(spec.frames || {}).map((frame) => [frame, spec.frames[frame].map((layer) => ({ outline: layer.outline, ...paintOf(layer.paint) }))]));
      return sides.flatMap((side) => {
        const numbers = applyFeatureDials(featureNumbers(spec), spec.id, side, dialSet, values);
        const [leftAzimuth, rightAzimuth] = Kit.surface.pair(numbers.azimuth, numbers.spacing);
        const azimuth = side === 'right' ? rightAzimuth : side === 'left' ? leftAzimuth : numbers.azimuth;
        const placed = Kit.surface.place(shapes[bone], layout.frames[bone], azimuth, numbers.elevation);
        if (!placed) return [];
        const isFlipped = side === 'right';
        const authored = featureNumbers(spec).size;
        return [
          {
            id: spec.id,
            bone,
            side,
            flip: isFlipped,
            point: placed.point.map((value, axis) => value + placed.normal[axis] * numbers.lift),
            normal: placed.normal,
            up: placed.up,
            size: numbers.size,
            rotation: (isFlipped ? -numbers.rotation : numbers.rotation) * DEGREES_TO_RADIANS,
            frames: resolvedFrames,
            rest: spec.rest || Object.keys(spec.frames || {})[0] || null,
            shape: spec.shape || null,
            scale: [numbers.size[0] / authored[0], numbers.size[1] / authored[1]],
            ramp: spec.shape ? rampOf(spec.paint || 'skin') : NO_RAMP,
            part: spec.part || null,
            glow: Boolean(spec.glow),
          },
        ];
      });
    });
    const regions = layout.regionsByBone.map((layers) => layers.map(({ spec, test }) => ({ id: spec.id, ramp: rampOf(spec.paint), test, part: spec.part || null })));
    const regionAt = (bone, along, angle, normalX, normalY, normalZ) => {
      const layers = regions[bone];
      const layer = Kit.region.at(layers, along, angle, normalX, normalY, normalZ);
      return layer === Kit.region.NONE ? NO_RAMP : layers[layer].ramp;
    };
    return Object.freeze({ features: Object.freeze(features), regions: Object.freeze(regions), regionAt });
  };

  // ---- adapters for the figure renderer (kit/figure-layout.js extension points) -------------------------------------

  /** Most stamp layers turned into solids per feature (freckles are ten dots; more is noise at figure scale). */
  const MOST_STAMP_LAYERS = 12;
  /** A stamp layer becomes a flattened ellipsoid this thick (share of its width), sunk so only a cap shows... */
  const STAMP = Object.freeze({ thickness: 0.45, sink: 0.62, raisePerLayer: 0.14 });
  const LAST_SHADE = 4;
  const SMALLEST_RADIUS = 1e-4;

  const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
  const combine = (origin, terms) => origin.map((value, axis) => terms.reduce((sum, [vector, amount]) => sum + vector[axis] * amount, value));
  /**
   * A stretch given along a feature's own axes, moved onto the bone's axes: each feature axis gives its stretch
   * to the bone axis it points along most. Exact for features facing straight along a bone axis (eyes, a nose,
   * ears); an approximation in between, because the renderer's `scale` is per bone axis.
   */
  const alignedScale = (stretch, axes) => {
    const out = [1, 1, 1];
    axes.forEach((vector, index) => {
      const sizes = vector.map(Math.abs);
      out[sizes.indexOf(Math.max(...sizes))] = stretch[index];
    });
    return out;
  };

  /** One placed feature as the renderer's `FeaturePiece`s: its solid, and each stamp layer as a shallow cap. */
  const piecesOf = (feature, ramps) => {
    const flip = feature.flip ? -1 : 1;
    const across0 = cross(feature.up, feature.normal).map((value) => value * flip);
    const [cosine, sine] = [Math.cos(feature.rotation), Math.sin(feature.rotation)];
    const across = combine(
      [0, 0, 0],
      [
        [across0, cosine],
        [feature.up, sine],
      ]
    );
    const up = combine(
      [0, 0, 0],
      [
        [across0, -sine],
        [feature.up, cosine],
      ]
    );
    const { normal, point, size } = feature;
    const toBone = ([x, y, z]) =>
      combine(
        [0, 0, 0],
        [
          [across, x],
          [up, y],
          [normal, z],
        ]
      );
    const pieces = [];
    if (feature.shape) {
      const solid = feature.shape;
      const solidScale = [feature.scale[0], feature.scale[1], feature.scale[0]];
      const offset = toBone((solid.at || [0, 0, 0]).map((value, axis) => value * solidScale[axis]));
      const at = combine(point, [[offset, 1]]);
      const base = { ramp: feature.ramp < 0 ? undefined : feature.ramp, glow: feature.glow };
      if (solid.kind === 'sphere')
        pieces.push({
          ...base,
          shape: {
            kind: 'sphere',
            radius: solid.radius,
            at,
            scale: alignedScale(
              (solid.scale || [1, 1, 1]).map((value, axis) => value * solidScale[axis]),
              [across, up, normal]
            ),
          },
        });
      else if (solid.kind === 'box')
        pieces.push({
          ...base,
          shape: {
            kind: 'box',
            size: alignedScale(
              solid.size.map((value, axis) => value * solidScale[axis]),
              [across, up, normal]
            ),
            at,
          },
        });
      else {
        // A capsule, lathe or extrude solid runs from its origin to `end`; the renderer's capsule can point anywhere.
        const end = toBone(solid.end.map((value, axis) => value * solidScale[axis]));
        const radius = solid.kind === 'capsule' ? solid.radius : solid.kind === 'lathe' ? Math.max(...solid.profile.map(([radial]) => radial)) : solid.depth;
        const taper = solid.kind === 'capsule' ? (solid.taper === undefined ? 1 : solid.taper) : SMALLEST_RADIUS;
        pieces.push({ ...base, shape: { kind: 'capsule', end, radius: radius * solidScale[0], endRadius: Math.max(SMALLEST_RADIUS, radius * solidScale[0] * taper), at } });
      }
    }
    const frame = (feature.frames[feature.rest] || []).slice(0, MOST_STAMP_LAYERS);
    frame.forEach((layer, index) => {
      const us = layer.outline.map(([across0Value]) => across0Value);
      const vs = layer.outline.map(([, upValue]) => upValue);
      const [centreU, centreV] = [(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2];
      const halfU = Math.max(SMALLEST_RADIUS, ((Math.max(...us) - Math.min(...us)) / 2) * (size[0] / 2));
      const halfV = Math.max(SMALLEST_RADIUS, ((Math.max(...vs) - Math.min(...vs)) / 2) * (size[1] / 2));
      const radius = Math.max(halfU, halfV);
      // Later layers sit a little prouder, so a pupil shows over an iris over a white.
      const depth = radius * (STAMP.sink - STAMP.raisePerLayer * index);
      const at = combine(point, [
        [across, (centreU * size[0]) / 2],
        [up, (centreV * size[1]) / 2],
        [normal, -depth],
      ]);
      const shades = layer.ramp >= 0 && ramps[layer.ramp] ? ramps[layer.ramp].shades.length - 1 : LAST_SHADE;
      pieces.push({
        shape: { kind: 'sphere', radius, at, scale: alignedScale([halfU / radius, halfV / radius, STAMP.thickness], [across, up, normal]) },
        ramp: layer.ramp < 0 ? undefined : layer.ramp,
        tone: shades > 0 ? layer.shade / shades : 0,
        glow: feature.glow,
      });
    });
    return pieces;
  };

  /**
   * The two extension points of the figure renderer (kit/figure-layout.js), for one bake: `featuresOf` turns
   * the bake's placed features into `FeaturePiece`s in bone space (a solid stays a solid; each stamp layer of
   * the rest frame becomes a shallow coloured cap, later layers prouder), and `regionOf` answers which ramp
   * paints a point of a bone, from bone-local coordinates (s and angle from `Kit.surface.along`, the normal from
   * the bone's dialled shape). Both answer only for the bake's own plan.
   * @param {Object} bake from a catalogue's bakery
   * @returns {{featuresOf: function(Object, number): Object[], regionOf: function(Object, number, number, number, number): ?number}}
   * @complexity building: O(feature copies x stamp layers); `regionOf` per call: O(regions on the bone) plus
   *   six distance evaluations for the normal
   * @example const figure = Kit.figure.build(view, bake, { featuresOf: Kit.body.figureHooks(bake).featuresOf });
   */
  const figureHooks = (bake) => {
    const byBone = new Map();
    bake.surface.features.forEach((feature) => byBone.set(feature.bone, [...(byBone.get(feature.bone) || []), ...piecesOf(feature, bake.ramps)]));
    const layout = surfaceLayout(bake.plan);
    const sample = [0, 0];
    const STEP = 1e-4;
    const regionOf = (plan, bone, x, y, z) => {
      if (plan !== bake.plan || !bake.surface.regions[bone].length) return null;
      const frame = layout.frames[bone];
      const shape = bake.shapes[bone];
      const at = (dx, dy, dz) => Kit.surface.distance(shape, frame, x + dx, y + dy, z + dz);
      const normal = [at(STEP, 0, 0) - at(-STEP, 0, 0), at(0, STEP, 0) - at(0, -STEP, 0), at(0, 0, STEP) - at(0, 0, -STEP)];
      const length = Math.hypot(...normal) || 1;
      Kit.surface.along(frame, x, y, z, sample);
      const ramp = bake.surface.regionAt(bone, sample[0], sample[1], normal[0] / length, normal[1] / length, normal[2] / length);
      return ramp < 0 ? null : ramp;
    };
    return { featuresOf: (plan, bone) => (plan === bake.plan ? byBone.get(bone) || [] : []), regionOf };
  };

  Kit.body = Object.assign(Kit.body || {}, { checkSurface, surfaceLayout, surfaceOf, figureHooks, FRAME_SETS, FEATURE_PARAMS, FEATURE_DEFAULTS });
})();
