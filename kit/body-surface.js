/**
 * Kit body surface: what is drawn ON a body's bones rather than as bones. Surface features (eyes, brows, a nose,
 * a mouth, ears, freckles, a scar) are placed on a bone's shape by azimuth and elevation, alone or as a mirrored
 * pair, with a flat stamp (frames of outlines: open, half, closed) and / or a small solid; regions (a sleeve, a
 * hairline, stripes, a belly patch) are predicate trees over a bone's along / around coordinates that paint the
 * bone with another colour channel. Both are data on a plan or a part; this file lays them out for a bake.
 *
 * Owns:  `Kit.body.surfaceLayout(plan)` (validate and index a plan's features and regions; cached per plan) and
 *        `Kit.body.surfaceOf(...)` (one individual's placements and painted layers, with `regionAt`), plus the
 *        `FeatureSpec` and `RegionSpec` shapes and `FRAME_SETS`; and the figure renderer's two hooks for a bake,
 *        `Kit.body.FIGURE_HOOKS` (`featuresOf`: a bone's face as one stamps piece plus feature solids, kept per
 *        placed list; `regionMapOf`: a bone's regions baked to a small map, kept per outfit).
 * Does not own: the maths of placing on a solid (kit/surface.js), the predicates (kit/region.js), how features
 *        and regions travel with parts (kit/body-parts.js), or drawing them (renderers; kit/body-debug.js marks them).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const VECTOR_STRIDE = 3;
  /** Feature defaults: a 3 cm stamp straight ahead, flat on the surface, turned not at all. */
  const FEATURE_DEFAULTS = Object.freeze({ azimuth: 0, elevation: 0, size: 0.03, rotation: 0, lift: 0, lean: Object.freeze([0, 0]) });
  /** The numbers of a feature that dials may drive, so a misspelt `param` is caught when the bake is laid out. */
  const FEATURE_PARAMS = Object.freeze(['azimuth', 'elevation', 'spacing', 'size', 'rotation', 'lift', 'lean']);
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
   * @property {number} [least] the fewest target texels the layer's smaller side may cover: a renderer grows a
   *   layer that would be smaller (a glint, a pupil), so it survives a low-resolution target
   * @property {number} [drop] the layer is left out while its smaller side covers fewer target texels than this:
   *   detail (the white of an eye, a pupil) that would only be noise on a small sprite. Not with `least`.
   * @property {boolean} [fixed] the layer is not mirrored on the right copy of a pair: a glint sits on the lit
   *   side of both eyes
   */

  /**
   * @typedef {Object} FeatureSpec
   * @property {string} id what dials and animators call it ('eye', 'mouth'); several features may share an id
   * @property {string} [bone] the bone it sits on (a part's features default to the bone of the socket it is in)
   * @property {string} [anchor] a named place of the plan (`AnchorSpec`, `plan.spec.anchors`): the feature sits
   *   there. Its own `azimuth` and `elevation` are then steps away from the anchor, and it takes the anchor's
   *   `spacing` (and, on a plan, its `bone`) unless it states its own. A nose made for one head then sits right on
   *   any head that says where its nose is
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
   * @property {string} [paint] the colour channel of the solid (default 'skin'). A solid painted as its bone is
   *   modelled out of the bone's own surface (a relief mark, kit/sculpt-relief.js); one with another paint (a
   *   moustache) is a solid of its own lying on it
   * @property {number} [blend] metres: how wide a fillet joins the solid to the surface it is modelled out of
   *   (default: from its thickness)
   * @property {boolean} [carve=false] the solid is pressed in, not on: the bone's surface loses what it holds (an
   *   eye socket, a gill line). Never drawn as a piece of its own
   * @property {number[]} [lean=[0, 0]] degrees the solid is tipped out of the surface: [about its across axis
   *   (a nose tip turned up is positive), about its up axis (an ear standing off the head)]. The right copy of
   *   a pair leans the mirrored way
   * @property {boolean} [glow] draw it as a glow (eyes): a renderer leaves it out of outlines
   * @property {number} [under=0] stamps of a feature with a higher `under` are drawn beneath the others on its
   *   bone whatever order the parts were attached in: blush and freckles go under the eyes
   * @property {boolean} [outlined=true] false for a solid that should not get an outline of its own (a nose
   *   inside the face's silhouette), while still shading and inking as part of its bone
   * @property {string} [part] set by kit/body-parts.js: the part that brought it
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
   * @property {boolean} [ink=true] false for a pattern inside a garment (stripes, stipple): a renderer draws no line round it
   * @property {number} [raise=0] metres the painted area stands proud of the bone's surface: a renderer draws it
   *   on a shell of the bone's own (dialled) shape, so cloth and hair have thickness and follow every dial
   * @property {boolean} [occludes=false] the area hides face stamps beneath it (hair over a brow); a beard or
   *   stubble leaves it false so the mouth still shows
   * @property {string} [part] set by kit/body-parts.js: the part that brought it
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
   * @property {boolean} outlined false when the solid should get no outline of its own
   * @property {number} lift metres `point` stands off the surface (already applied to it)
   * @property {number[]} lean radians [about across, about up] the solid is tipped by
   * @property {?number} blend metres, the solid's fillet when it is a relief mark; null: from its thickness
   * @property {boolean} carve the solid is pressed into the bone's surface
   */

  /**
   * @typedef {Object} AnchorSpec
   * A named place on a plan's surface (`plan.spec.anchors[name]`): where this body keeps its nose, its ears, its
   * brow. Features name an anchor instead of repeating angles, so one face vocabulary fits every head.
   * @property {string} bone the bone it is on
   * @property {number} [azimuth=0] degrees, as a feature's
   * @property {number} [elevation=0] degrees
   * @property {number} [spacing] degrees between the two places of a mirrored pair (ears, eyes)
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

  /**
   * A feature spec with its anchor worked in: the anchor's angles plus the feature's own steps, the anchor's
   * spacing and bone where the feature states none. A feature without an anchor is returned as it is.
   * @param {FeatureSpec} spec
   * @param {Object<string, AnchorSpec>} anchors the plan's
   * @param {string} [where] who is asking, for the message
   * @returns {FeatureSpec}
   * @throws {Error} naming the feature and the plan's anchors when the anchor is unknown
   * @complexity O(1)
   * @example Kit.body.anchoredSpec({ id: 'nose', anchor: 'nose', elevation: 2 }, { nose: { bone: 'head', elevation: -13 } }).elevation // -11
   */
  const anchoredSpec = (spec, anchors, where = 'anchoredSpec') => {
    if (spec.anchor === undefined) return spec;
    const anchor = anchors[spec.anchor];
    if (!anchor) fail(where, `${ownerOf('feature', spec)} sits on the anchor "${spec.anchor}", which this plan does not have. Anchors: ${Object.keys(anchors).join(', ') || '(none; add `anchors` to the plan)'}.`);
    const spacing = spec.spacing === undefined ? anchor.spacing : spec.spacing;
    return {
      ...spec,
      bone: spec.bone === undefined ? anchor.bone : spec.bone,
      azimuth: (anchor.azimuth || 0) + (spec.azimuth || 0),
      elevation: (anchor.elevation || 0) + (spec.elevation || 0),
      ...(spacing === undefined ? {} : { spacing }),
    };
  };

  /** Layouts by plan: a plan is frozen, so its features and regions are checked and indexed once. */
  const layouts = new WeakMap();

  /**
   * Checks and indexes a plan's features and regions: every name resolved to a bone index, every region
   * predicate compiled, every bone's region layers in stacking order. Cached per plan, so an outfit pays once.
   * @param {Object} plan a `BodyPlan` (bare or assembled)
   * @returns {{features: Array<{spec: FeatureSpec, bone: number}>, regionsByBone: Array<Array<{spec: RegionSpec, test: Function, key: string}>>, frames: Array<{end: number[], axis: number, girth: number}>, featureBones: number[], featureDials: function(Object): number[], placed: Map<string, ReadonlyArray<Object>>}}
   *   `key` says what a region's predicate is (equal keys bake to equal maps); `featureBones`, `featureDials` and
   *   `placed` are what the placed-feature cache of `surfaceOf` is keyed and kept by
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
    const anchors = plan.spec.anchors || {};
    const features = (plan.spec.features || []).map((authored) => {
      const spec = anchoredSpec(authored, anchors, where);
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
      // The key says what the predicate is, so equal regions of different outfits share one baked map (`regionMapOf`).
      const key = JSON.stringify(spec.where);
      [...new Set([...byRole, ...byName])].forEach((bone) => regionsByBone[bone].push({ spec, test, key }));
    });
    const frames = plan.boneNames.map((_name, bone) => ({ end: boneEnd(plan, bone), axis: plan.axis[bone], girth: plan.girth[bone] }));
    const featureBones = [...new Set(features.map((feature) => feature.bone))];
    // The dials that drive a feature, per dial set compiled against this plan (a bakery makes one per outfit).
    const dialsBySet = new WeakMap();
    const featureDials = (dialSet) => {
      if (!dialsBySet.has(dialSet)) dialsBySet.set(dialSet, [...new Set(dialSet.featureOps.map((operation) => operation.dial))]);
      return dialsBySet.get(dialSet);
    };
    const layout = Object.freeze({ features, regionsByBone, frames, featureBones, featureDials, placed: new Map() });
    layouts.set(plan, layout);
    return layout;
  };

  /** Placed feature lists kept per plan, by signature. A drag revisits a handful of values; rolls each bring their own. */
  const MOST_PLACED_LISTS = 32;

  /**
   * What the placed features of an individual depend on, as a string: the dialled shape of every bone that
   * carries a feature, the value of every dial that drives a feature, and each ramp's shade count (stamp
   * shades are clamped to it). Equal signatures place equal features.
   */
  const featureSignature = (layout, shapes, dialSet, values, ramps) =>
    `${layout.featureBones.map((bone) => JSON.stringify(shapes[bone])).join('|')}#${layout.featureDials(dialSet).map((dial) => values[dial]).join(',')}#${ramps.map((ramp) => ramp.shades.length).join('')}`;
  const rememberPlaced = (layout, signature, features) => {
    layout.placed.set(signature, features);
    // A Map remembers insertion order, so its first key is the oldest list.
    if (layout.placed.size > MOST_PLACED_LISTS) layout.placed.delete(layout.placed.keys().next().value);
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
      lean: [...(spec.lean || FEATURE_DEFAULTS.lean)],
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
   * @returns {{features: ReadonlyArray<Object>, regions: ReadonlyArray<ReadonlyArray<Object>>, regionAt: function(number, number, number, number, number, number): number}}
   *   `features` are `FeaturePlacement`s; each region row is { id, ramp, test, part }
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
    // Placing features is the expensive half of a bake (a bisection per copy). They depend only on the shapes of
    // the bones they sit on, the dials that drive them and how many shades each ramp has, so a slider that moves
    // none of those (height, a leg, a colour) reuses the placed list, and the renderer its pieces.
    const signature = featureSignature(layout, shapes, dialSet, values, ramps);
    const placedBefore = layout.placed.get(signature);
    const features = placedBefore || layout.features.flatMap(({ spec, bone }) => {
      const sides = spec.spacing === undefined ? [null] : SIDES;
      const resolvedFrames = Object.fromEntries(
        Object.keys(spec.frames || {}).map((frame) => [frame, spec.frames[frame].map((layer) => ({ outline: layer.outline, ...paintOf(layer.paint), ...(layer.least ? { least: layer.least } : {}), ...(layer.drop ? { drop: layer.drop } : {}), ...(layer.fixed ? { fixed: true } : {}) }))])
      );
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
            outlined: spec.outlined !== false,
            under: spec.under || 0,
            lift: numbers.lift,
            lean: numbers.lean.map((degrees) => degrees * DEGREES_TO_RADIANS),
            blend: spec.blend === undefined ? null : spec.blend,
            carve: Boolean(spec.carve),
          },
        ];
      });
    });
    if (!placedBefore) rememberPlaced(layout, signature, Object.freeze(features));
    const regions = layout.regionsByBone.map((layers) =>
      layers.map(({ spec, test, key }) => ({ id: spec.id, ramp: rampOf(spec.paint), test, part: spec.part || null, key, ink: spec.ink !== false, raise: spec.raise || 0, occludes: Boolean(spec.occludes) }))
    );
    const regionAt = (bone, along, angle, normalX, normalY, normalZ) => {
      const layers = regions[bone];
      const layer = Kit.region.at(layers, along, angle, normalX, normalY, normalZ);
      return layer === Kit.region.NONE ? NO_RAMP : layers[layer].ramp;
    };
    return Object.freeze({ features, regions: Object.freeze(regions), regionAt });
  };

  // ---- adapters for the figure renderer (kit/figure-layout.js extension points) -------------------------------------

  /** Most stamp layers drawn per feature (freckles are ten dots; more is noise at figure scale). */
  const MOST_STAMP_LAYERS = 16;
  /**
   * How a stamp sits on the surface, metres: the first layer is lifted clear of the tessellated surface (a
   * smoothed lathe bulges a few millimetres past its authored profile), each later layer a little more so a
   * pupil shows over an iris over a white, and each later feature a hair more so overlapping features (freckles
   * across a nose shadow) never share a depth. A feature's own `lift` is for its solid; its stamp stays on the skin.
   */
  /**
   * A stamp follows the relief modelled out of its bone (it lies in an eye's socket and on a lip), but only
   * `mostRelief` metres either way from the bone's own surface: a corner of an eye that reaches under the bridge
   * of the nose stays on the face, buried by the bridge, instead of being carried out onto it.
   */
  const STAMP = Object.freeze({ lift: 0.004, liftPerLayer: 0.0008, liftPerFeature: 0.0001, settleSteps: 3, mostRelief: 0.012 });
  const LAST_SHADE = 4;
  /** Region maps kept, by what they were baked from: an outfit's maps are shared by everyone who wears it. */
  const MOST_REGION_MAPS = 256;

  const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
  const combine = (origin, terms) => origin.map((value, axis) => terms.reduce((sum, [vector, amount]) => sum + vector[axis] * amount, value));
  const unit = (vector) => {
    const size = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return vector.map((value) => value / size);
  };

  /**
   * The frame of one placed feature in its bone's space: `across` and `up` span the surface (turned by the
   * feature's rotation), `normal` points out. Right-handed (across x up = normal) for both copies of a pair, so
   * a solid built in it is never inside out; the right copy is mirrored through its data instead (`mirror`).
   */
  const frameOf = (feature) => {
    const flat = cross(feature.up, feature.normal);
    const [cosine, sine] = [Math.cos(feature.rotation), Math.sin(feature.rotation)];
    return {
      across: combine([0, 0, 0], [[flat, cosine], [feature.up, sine]]),
      up: combine([0, 0, 0], [[flat, -sine], [feature.up, cosine]]),
      normal: feature.normal,
      mirror: feature.flip ? -1 : 1,
    };
  };

  /**
   * A feature's frame tipped out of the surface by its `lean`: about `up` first (the solid's across axis swings
   * outward: an ear stands off the head), then about `across` (its outward axis swings towards up: a nose tip
   * turns up). The right copy of a pair has its across axis mirrored, so it leans the mirrored way.
   */
  const leaned = (frame, lean) => {
    if (!lean || (lean[0] === 0 && lean[1] === 0)) return frame;
    const { mirror } = frame;
    const turn = (first, second, angle) => [combine([0, 0, 0], [[first, Math.cos(angle)], [second, Math.sin(angle)]]), combine([0, 0, 0], [[second, Math.cos(angle)], [first, -Math.sin(angle)]])];
    const [swungAcross, swungNormal] = turn(frame.across.map((value) => value * mirror), frame.normal, lean[1]);
    const [normal, up] = turn(swungNormal, frame.up, lean[0]);
    return { across: swungAcross.map((value) => value * mirror), up, normal, mirror };
  };

  /** A feature's solid as a renderer shape: built along the feature's own axes, then turned onto the surface. */
  const solidPiece = (feature, flatFrame) => ({ ...solidShape(feature, leaned(flatFrame, feature.lean)), ...(feature.carve ? { carve: true } : {}), ...(feature.blend === null || feature.blend === undefined ? {} : { blend: feature.blend }) });
  const solidShape = (feature, frame) => {
    const solid = feature.shape;
    const stretch = [feature.scale[0], feature.scale[1], feature.scale[0]];
    const { across, up, normal, mirror } = frame;
    /** A vector of the solid's own frame (mirrored for the right copy), in bone space. */
    const toBone = ([x, y, z]) => combine([0, 0, 0], [[across, x * mirror * stretch[0]], [up, y * stretch[1]], [normal, z * stretch[2]]]);
    const at = combine(feature.point, [[toBone(solid.at || [0, 0, 0]), 1]]);
    const scale = (solid.scale || [1, 1, 1]).map((value, axis) => value * stretch[axis]);
    const base = { ramp: feature.ramp < 0 ? undefined : feature.ramp, glow: feature.glow, outlined: feature.outlined };
    if (solid.kind === 'sphere') return { ...base, shape: { kind: 'sphere', radius: solid.radius, at, scale, basis: [across, up, normal] } };
    if (solid.kind === 'box') return { ...base, shape: { kind: 'box', size: solid.size.slice(), at, scale, basis: [across, up, normal] } };
    const end = toBone(solid.end);
    if (solid.kind === 'capsule') {
      const taper = solid.taper === undefined ? 1 : solid.taper;
      return { ...base, shape: { kind: 'capsule', end, radius: solid.radius * stretch[0], endRadius: solid.radius * stretch[0] * taper, at } };
    }
    // A lathe or an extrude runs along its `end`: its own +Y is turned onto that direction, its +Z kept as near the surface normal as it can be.
    const along = unit(end);
    const side = unit(cross(along, normal));
    const basis = [side, along, cross(side, along)];
    return solid.kind === 'lathe'
      ? { ...base, shape: { kind: 'lathe', profile: solid.profile.map((point) => point.slice()), axis: 1, at, scale, basis, ...(solid.smooth ? { smooth: true } : {}) } }
      : { ...base, shape: { kind: 'extrude', outline: solid.outline.map((point) => point.slice()), depth: solid.depth, axis: 1, across: 0, at, scale, basis } };
  };

  /**
   * The rest frame of a placed feature as flat polygons on the surface (`StampLayer`s of kit/figure-shapes.js):
   * each outline point (u, v) goes `u x width / 2` across and `v x height / 2` up from the feature's point, and
   * is then walked back onto the bone's surface along the feature's normal (a few steps of the signed distance),
   * so a wide stamp (blush, freckles) hugs the curve of whatever head the dials have made.
   */
  const stampLayers = (feature, frame, ramps, surfaceDistance, reliefDistance, featureOrder) => {
    const { across, up, normal, mirror } = frame;
    // A layer is a flat polygon between its own points, so over a dent (an eye socket) it bridges the dent like a
    // lid. A layer above it is kept at least as far out as the highest point of the layers under it, or the white
    // of an eye would cover the iris lying on the socket's floor.
    let lid = -Infinity;
    return (feature.frames[feature.rest] || [])
      .slice(0, MOST_STAMP_LAYERS)
      .filter((layer) => layer.ramp >= 0)
      .map((layer, index) => {
        const shades = ramps[layer.ramp] ? ramps[layer.ramp].shades.length - 1 : LAST_SHADE;
        const lift = STAMP.lift + STAMP.liftPerLayer * index + STAMP.liftPerFeature * featureOrder;
        let highest = lid;
        const points = layer.outline.flatMap(([u, v]) => {
          let vertex = combine(feature.point, [[across, (u * (layer.fixed ? 1 : mirror) * feature.size[0]) / 2], [up, (v * feature.size[1]) / 2], [normal, -feature.lift]]);
          for (let step = 0; step < STAMP.settleSteps; step++) vertex = combine(vertex, [[normal, -surfaceDistance(vertex)]]);
          // From the bone's own surface, in or out to the relief, no further than `mostRelief`.
          let relief = 0;
          for (let step = 0; step < STAMP.settleSteps; step++) relief = Math.max(-STAMP.mostRelief, Math.min(STAMP.mostRelief, relief - reliefDistance(combine(vertex, [[normal, relief]]))));
          relief = Math.max(relief, lid);
          highest = Math.max(highest, relief);
          return combine(vertex, [[normal, relief + lift]]);
        });
        lid = highest;
        return { points, normal: normal.slice(), slot: layer.ramp, tone: shades > 0 ? layer.shade / shades : 0, least: layer.least || 0, drop: layer.drop || 0 };
      });
  };

  const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const EVERYWHERE = Object.freeze({ min: Object.freeze([-Infinity, -Infinity, -Infinity]), max: Object.freeze([Infinity, Infinity, Infinity]) });

  /**
   * Is a feature's solid a relief mark of its bone: painted as the bone is (or pressed into it), so modelled out
   * of the bone's surface instead of lying on it as a solid of its own?
   * @param {{ramp?: number, carve?: boolean}} piece a feature's solid piece (`solidPiece`); `ramp` undefined means the bone's own
   * @param {number} boneRamp the ramp the bone is drawn with
   * @returns {boolean}
   * @complexity O(1)
   * @example Kit.body.isReliefMark({ ramp: 2 }, 2) // true: a skin nose on a skin head
   */
  const isReliefMark = (piece, boneRamp) => Boolean(piece.carve) || piece.ramp === undefined || piece.ramp === boneRamp;

  /**
   * The signed distance to a bone's surface in the bone's space with its relief marks worked in (the same
   * modelling the sculpt does, kit/sculpt-relief.js). Without the sculpt kernel loaded, the bone's own shape.
   */
  const modelledDistance = (bake, bone, frame, solidPieces) => {
    const plain = (x, y, z) => Kit.surface.distance(bake.shapes[bone], frame, x, y, z);
    if (!Kit.sculpt || !Kit.sculpt.relief || !Kit.figure || !Kit.figure.buildShape) return plain;
    const boneRamp = Kit.figure.resolveRamps ? Kit.figure.resolveRamps(bake.plan, bake.boneRamp)[bone] : bake.boneRamp[bone];
    const marks = solidPieces.filter((piece) => isReliefMark(piece, boneRamp)).map((piece) => ({ solid: Kit.sculpt.solid(piece.shape, IDENTITY), blend: piece.blend, carve: piece.carve }));
    return Kit.sculpt.relief({ ...EVERYWHERE, distance: plain }, marks).distance;
  };

  /** Pieces by bone for a list of placed features; kept per list, so a bake whose face did not change reuses them. */
  const piecesByFeatures = new WeakMap();
  const piecesFor = (bake) => {
    const known = piecesByFeatures.get(bake.surface.features);
    if (known) return known;
    const frames = surfaceLayout(bake.plan).frames;
    const solids = new Map();
    const layers = new Map();
    // Deepest first (a stable sort keeps the attach order among equals): later stamps draw over earlier ones.
    const drawOrder = [...bake.surface.features].sort((first, second) => (second.under || 0) - (first.under || 0));
    drawOrder.forEach((feature) => {
      if (feature.shape) solids.set(feature.bone, [...(solids.get(feature.bone) || []), solidPiece(feature, frameOf(feature))]);
    });
    /** Per bone: the distance to its surface with its relief marks worked in, so a stamp lies in a socket and on a lip. */
    const distances = new Map();
    const distanceOn = (bone) => {
      if (!distances.has(bone)) distances.set(bone, modelledDistance(bake, bone, frames[bone], solids.get(bone) || []));
      return distances.get(bone);
    };
    drawOrder.forEach((feature, featureOrder) => {
      const sofar = layers.get(feature.bone) || [];
      const measure = distanceOn(feature.bone);
      const surfaceDistance = (vertex) => Kit.surface.distance(bake.shapes[feature.bone], frames[feature.bone], vertex[0], vertex[1], vertex[2]);
      const reliefDistance = (vertex) => measure(vertex[0], vertex[1], vertex[2]);
      layers.set(feature.bone, [...sofar, ...stampLayers(feature, frameOf(feature), bake.ramps, surfaceDistance, reliefDistance, featureOrder)]);
    });
    const byBone = new Map();
    new Set([...solids.keys(), ...layers.keys()]).forEach((bone) => {
      const stamps = (layers.get(bone) || []).length ? [{ shape: freezeDeep({ kind: 'stamps', layers: layers.get(bone), at: [0, 0, 0] }), stamps: true, glow: true }] : [];
      byBone.set(bone, Object.freeze([...(solids.get(bone) || []), ...stamps]));
    });
    piecesByFeatures.set(bake.surface.features, byBone);
    return byBone;
  };
  const freezeDeep = (value) => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  };
  const NO_PIECES = Object.freeze([]);

  /**
   * The figure renderer's features hook: the placed features of a bone as `FeaturePiece`s in bone space. A
   * solid stays a solid, turned onto the surface (`basis`); every stamp layer of the bone becomes one polygon
   * of a single `stamps` piece, so a whole face is one draw call. Works for any bake of any catalogue: the
   * renderer hands over the bake it is laying out.
   * @param {Object} _plan the bake's plan (unused: the bake says it all)
   * @param {number} bone
   * @param {?Object} _shape the bone's own surface (unused)
   * @param {Object} bake from a bakery
   * @returns {ReadonlyArray<Object>} `FeaturePiece`s (kit/figure-layout.js)
   * @complexity O(1) after the first call for a bake's features, which is O(feature copies x outline points)
   * @example Kit.figure.build(view, bake, { featuresOf: Kit.body.FIGURE_HOOKS.featuresOf })   // the default
   */
  const featuresOf = (_plan, bone, _shape, bake) => (bake && bake.surface ? piecesFor(bake).get(bone) || NO_PIECES : NO_PIECES);

  /** @type {Map<string, Object>} baked maps by key, oldest first */
  const regionMaps = new Map();

  /**
   * The figure renderer's regions hook: the painted layers of a bone baked into a `RegionMap` (kit/region.js)
   * over the bone's along / around coordinates, with the frame those are measured in. Dials never change it
   * (regions are stated in s and angle, not metres), so the map depends only on what is worn and is shared by
   * every individual wearing it.
   * @param {Object} plan the bake's plan
   * @param {number} bone
   * @param {Object} bake from a bakery
   * @returns {?{key: string, width: number, height: number, data: Uint8Array, shells: number[], end: number[], front: number, side: number}}
   *   null when nothing paints the bone; `end` is the bone's far end, `front` and `side` the axes (0 = x, 1 = y,
   *   2 = z) the angle is measured from and towards (`Kit.surface.AROUND`)
   * @complexity O(layers) for the key on every call; O(map texels x layers x nodes) the first time a key is seen
   * @example Kit.body.FIGURE_HOOKS.regionMapOf(bake.plan, bake.plan.boneIndex('chest'), bake).shells // [0.012]
   */
  const regionMapOf = (plan, bone, bake) => {
    const layers = bake && bake.surface && plan === bake.plan ? bake.surface.regions[bone].filter((layer) => layer.ramp >= 0) : [];
    if (!layers.length) return null;
    const frame = surfaceLayout(plan).frames[bone];
    const [front, side] = Kit.surface.AROUND[frame.axis];
    const key = `${front}${side}:${layers.map((layer) => `${layer.key}>${layer.ramp}${layer.ink === false ? 'p' : ''}${layer.raise ? `^${layer.raise}` : ''}${layer.occludes ? 'o' : ''}`).join('+')}`;
    let map = regionMaps.get(key);
    if (!map) {
      map = Object.freeze({ key, ...Kit.region.bake(layers.map((layer) => ({ test: layer.test, slot: layer.ramp, ink: layer.ink, raise: layer.raise, occludes: layer.occludes })), { front, side }) });
      regionMaps.set(key, map);
      if (regionMaps.size > MOST_REGION_MAPS) regionMaps.delete(regionMaps.keys().next().value);
    }
    return { ...map, end: frame.end, front, side };
  };

  /**
   * The two extension points of the figure renderer (kit/figure-layout.js) for the body system, for any bake:
   * `featuresOf(plan, bone, shape, bake)` and `regionMapOf(plan, bone, bake)`. `Kit.figure.build` uses them by
   * default for a bake that has a `surface`.
   */
  const FIGURE_HOOKS = Object.freeze({ featuresOf, regionMapOf });

  /**
   * The renderer's hooks bound to one bake (the earlier form of `FIGURE_HOOKS`, kept for callers that hold it):
   * `featuresOf` answers for the bake the renderer passes, or for this one when it passes none; `regionOf`
   * answers which ramp paints a point of a bone given in bone space.
   * @param {Object} bake from a catalogue's bakery
   * @returns {{featuresOf: function(Object, number, ?Object=, Object=): ReadonlyArray<Object>, regionMapOf: function(Object, number, Object=): ?Object, regionOf: function(Object, number, number, number, number): ?number}}
   * @complexity `regionOf` per call: O(regions on the bone) plus six distance evaluations for the normal
   * @example const figure = Kit.figure.build(view, bake, { featuresOf: Kit.body.figureHooks(bake).featuresOf });
   */
  const figureHooks = (bake) => {
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
    return {
      featuresOf: (plan, bone, shape, current = bake) => featuresOf(plan, bone, shape, current),
      regionMapOf: (plan, bone, current = bake) => regionMapOf(plan, bone, current),
      regionOf,
    };
  };

  Kit.body = Object.assign(Kit.body || {}, { anchoredSpec, isReliefMark, checkSurface, surfaceLayout, surfaceOf, figureHooks, FIGURE_HOOKS, FRAME_SETS, FEATURE_PARAMS, FEATURE_DEFAULTS });
})();
