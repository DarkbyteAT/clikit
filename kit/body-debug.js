/**
 * Kit body debug: a stick figure of any posed body plan on a 2D canvas, with its sockets marked. It exists so a
 * person can see that a plan, a pose, an attachment or a dial does what the numbers say, and as the smallest
 * possible example of a renderer: project the world transforms, draw the bones.
 *
 * Owns:  `Kit.body.debug.project` (orthographic projection of a world point for a view angle),
 *        `Kit.body.debug.draw` (bones as lines, bone ends, joints, socket markers) and
 *        `Kit.body.debug.drawSurface` (a bake's dialled shapes as outlines, its painted regions as tinted spans
 *        along each bone, and its surface features as marks), enough to check shapes, faces and outfits by eye.
 * Does not own: real rendering (solids, shading, stamps: the pixel and 3D renderers read the same bake), the
 *        canvas or its size, or posing.
 *
 * Runs in node too: `draw` only calls the 2D-context methods listed in CONTEXT_METHODS, so a test passes a
 * recorder object instead of a canvas.
 */
(() => {
  /** Drawing tunables, in CSS pixels unless noted. */
  const STYLE = Object.freeze({
    boneColor: '#e8ecf4',
    propColor: '#f2c14e',
    jointColor: '#8fa3c8',
    openSocketColor: '#5ad1a0',
    filledSocketColor: '#f2788a',
    thinnestBone: 1.5,
    thickestBone: 9,
    jointRadius: 2,
    socketRadius: 4,
    socketLineWidth: 1.5,
  });
  /** The 2D-context methods `draw` uses; a stand-in context needs exactly these plus the three style properties. */
  const CONTEXT_METHODS = ['beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'closePath'];
  const VECTOR_STRIDE = 3;
  const FULL_TURN = Math.PI * 2;
  const GIRTH_TO_WIDTH = 0.5;

  /** Scratch points reused by every draw call, so drawing allocates nothing. */
  const worldPoint = new Float32Array(VECTOR_STRIDE);
  const screenFrom = new Float32Array(2);
  const screenTo = new Float32Array(2);

  /**
   * @typedef {Object} DebugView
   * @property {number} centerX canvas x of the world origin's vertical axis, pixels
   * @property {number} groundY canvas y of world height 0, pixels
   * @property {number} scale pixels per metre
   * @property {number} [turn=0] radians the camera is turned about +Y: 0 looks at the body's front, a quarter
   *   turn looks at its side
   */

  /**
   * Orthographic projection: a world point to canvas pixels for a view. Depth is dropped, which is all a 2D
   * style needs from the 3D skeleton.
   * @param {number} x world metres
   * @param {number} y
   * @param {number} z
   * @param {DebugView} view
   * @param {Float32Array|number[]} out receives canvas x, y
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.body.debug.project(0, 1.7, 0, { centerX: 100, groundY: 300, scale: 120 }, point) // [100, 96]
   */
  const project = (x, y, z, view, out) => {
    const turn = view.turn || 0;
    out[0] = view.centerX + (x * Math.cos(turn) - z * Math.sin(turn)) * view.scale;
    out[1] = view.groundY - y * view.scale;
    return out;
  };

  /** Line width for a bone: half its girth on screen, kept between the thinnest and thickest a stick figure reads at. */
  const boneWidth = (bodyPlan, world, view, bone) => Math.min(STYLE.thickestBone, Math.max(STYLE.thinnestBone, bodyPlan.girth[bone] * world.uniform[bone] * view.scale * GIRTH_TO_WIDTH));

  const strokeLine = (context, from, to, color, width) => {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(from[0], from[1]);
    context.lineTo(to[0], to[1]);
    context.stroke();
  };

  /**
   * Draws a posed body as a stick figure: a line from each bone's parent joint to its own joint, a line along
   * each bone that has an extent, a dot on every joint and a diamond on every socket (one colour when empty,
   * another when filled). Bones of attached parts are drawn in their own colour.
   * @param {Object} context a CanvasRenderingContext2D (or a recorder with the same methods)
   * @param {Object} bodyPlan a `BodyPlan`
   * @param {Object} world the `out` of `Kit.body.worldTransforms`
   * @param {DebugView} view
   * @param {{boneColor?: string, showSockets?: boolean}} [options] the colour of the body's own bones (default
   *   pale), and whether sockets are marked (default true)
   * @returns {void}
   * @complexity O(bones + sockets) time, no allocation
   * @example
   * Kit.body.worldTransforms(plan, pose, world);
   * Kit.body.debug.draw(canvas.getContext('2d'), plan, world, { centerX: 195, groundY: 600, scale: 220, turn: 0.6 });
   */
  const draw = (context, bodyPlan, world, view, { boneColor = STYLE.boneColor, showSockets = true } = {}) => {
    const propMask = Kit.body.roleMask(['prop']);
    const position = world.translation;
    // Index loops on purpose: this runs per body per frame in the gallery.
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) {
      const at = bone * VECTOR_STRIDE;
      const parentBone = bodyPlan.parent[bone];
      const color = bodyPlan.roles[bone] & propMask ? STYLE.propColor : boneColor;
      const width = boneWidth(bodyPlan, world, view, bone);
      project(position[at], position[at + 1], position[at + 2], view, screenTo);
      // The ground bone at the origin is a reference point, not a limb: nothing is drawn to it or from it.
      if (parentBone > 0) {
        const parentAt = parentBone * VECTOR_STRIDE;
        project(position[parentAt], position[parentAt + 1], position[parentAt + 2], view, screenFrom);
        strokeLine(context, screenFrom, screenTo, color, boneWidth(bodyPlan, world, view, parentBone));
      }
      if (bodyPlan.tail[at] !== 0 || bodyPlan.tail[at + 1] !== 0 || bodyPlan.tail[at + 2] !== 0) {
        Kit.body.tailPosition(bodyPlan, world, bone, worldPoint);
        project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenFrom);
        strokeLine(context, screenTo, screenFrom, color, width);
      }
      context.fillStyle = STYLE.jointColor;
      context.beginPath();
      context.arc(screenTo[0], screenTo[1], STYLE.jointRadius, 0, FULL_TURN);
      context.fill();
    }
    if (!showSockets) return;
    for (let socket = 0; socket < bodyPlan.socketCount; socket++) {
      Kit.body.socketPosition(bodyPlan, world, socket, worldPoint);
      project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenTo);
      const isFilled = Boolean(bodyPlan.filled[bodyPlan.socketNames[socket]]);
      context.strokeStyle = isFilled ? STYLE.filledSocketColor : STYLE.openSocketColor;
      context.lineWidth = STYLE.socketLineWidth;
      context.beginPath();
      context.moveTo(screenTo[0], screenTo[1] - STYLE.socketRadius);
      context.lineTo(screenTo[0] + STYLE.socketRadius, screenTo[1]);
      context.lineTo(screenTo[0], screenTo[1] + STYLE.socketRadius);
      context.lineTo(screenTo[0] - STYLE.socketRadius, screenTo[1]);
      context.closePath();
      context.stroke();
    }
  };

  /** Surface drawing tunables: outline points per curve, region spans per bone, mark sizes in CSS pixels. */
  const SURFACE_STYLE = Object.freeze({ curvePoints: 16, spansPerBone: 10, spanWidthShare: 0.4, markRadius: 2.2, outlineWidth: 1, outlineShade: 1, fillShade: 2, unpainted: '#5b6787' });
  const FRONT_ANGLE = 0;

  /** The shade of the bake's ramp `index`, or a neutral colour when there is none. */
  const colorOf = (bake, rampIndex, shade) => {
    const ramp = bake.ramps[rampIndex];
    return ramp ? ramp.shades[Math.min(shade, ramp.shades.length - 1)] : SURFACE_STYLE.unpainted;
  };

  /**
   * A shape's outline as bone-space points in the bone's XY plane (its silhouette seen from the front): enough
   * to see a profile dial work. Allocates; this is a debug view.
   */
  const outlineOf = (shape, end) => {
    const at = shape.at || [0, 0, 0];
    const scale = shape.scale || [1, 1, 1];
    const axisSizes = end.map(Math.abs);
    const axis = axisSizes.indexOf(Math.max(...axisSizes));
    const direction = end[axis] < 0 ? -1 : 1;
    const placed = (x, y, z = 0) => [at[0] + x * scale[0], at[1] + y * scale[1], at[2] + z * scale[2]];
    /** A point at `across` sideways and `along` the long axis. Across is x, or y when the bone lies along x. */
    const alongAxis = (across, along) => {
      const point = [0, 0, 0];
      point[axis === 0 ? 1 : 0] = across;
      point[axis] = along * direction;
      return placed(...point);
    };
    const circle = (radius) =>
      Array.from({ length: SURFACE_STYLE.curvePoints }, (_unused, index) =>
        placed(Math.cos((index / SURFACE_STYLE.curvePoints) * FULL_TURN) * radius, Math.sin((index / SURFACE_STYLE.curvePoints) * FULL_TURN) * radius)
      );
    if (shape.kind === 'sphere') return circle(shape.radius);
    if (shape.kind === 'box')
      return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([x, y]) => placed((x * shape.size[0]) / 2, (y * shape.size[1]) / 2));
    if (shape.kind === 'lathe') return [...shape.profile.map(([radius, along]) => alongAxis(radius, along)), ...[...shape.profile].reverse().map(([radius, along]) => alongAxis(-radius, along))];
    if (shape.kind === 'extrude') return shape.outline.map(([across, along]) => alongAxis(across, along));
    if (shape.kind === 'capsule') {
      const length = Math.hypot(...end) || 1;
      const radius = shape.radius === undefined ? 0 : shape.radius;
      const taper = shape.taper === undefined ? 1 : shape.taper;
      // Sideways in the XY plane, across the bone; a bone along z (a foot) goes sideways along x.
      const side = Math.hypot(end[0], end[1]) > 0 ? [-end[1] / Math.hypot(end[0], end[1]), end[0] / Math.hypot(end[0], end[1]), 0] : [1, 0, 0];
      const edge = (sign, radiusAt, along) => placed(end[0] * along + side[0] * radiusAt * sign, end[1] * along + side[1] * radiusAt * sign, end[2] * along);
      return length ? [edge(1, radius, 0), edge(1, radius * taper, 1), edge(-1, radius * taper, 1), edge(-1, radius, 0)] : [];
    }
    return [];
  };

  /** Strokes a closed polyline of bone-space points carried into the world and projected. */
  const strokeOutline = (context, world, bone, points, view, color) => {
    if (points.length < 2) return;
    context.strokeStyle = color;
    context.lineWidth = SURFACE_STYLE.outlineWidth;
    context.beginPath();
    points.forEach((point, index) => {
      Kit.rig.carryPoint(world, bone, point, 0, worldPoint);
      project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenTo);
      if (index) context.lineTo(screenTo[0], screenTo[1]);
      else context.moveTo(screenTo[0], screenTo[1]);
    });
    context.closePath();
    context.stroke();
  };

  /**
   * Draws what a bake puts on its bones, over (or instead of) the stick figure: every bone's dialled shape as an
   * outline in its paint colour, a row of spans along each bone tinted by the region that paints its front
   * (none: nothing drawn, the outline shows the bone's own paint), and a dot at every placed surface feature in
   * the colour of its first stamp layer or solid.
   * @param {Object} context a CanvasRenderingContext2D (or a recorder with `CONTEXT_METHODS`)
   * @param {Object} bake from a catalogue's bakery: `plan`, `shapes`, `surface`, `ramps`, `boneRamp`
   * @param {Object} world the `out` of `Kit.body.worldTransforms` for the bake's plan
   * @param {DebugView} view
   * @param {{shapes?: boolean, regions?: boolean, features?: boolean}} [options] what to draw (default all)
   * @returns {{outlines: number, spans: number, marks: number}} how many of each were drawn (for tests)
   * @complexity O(bones x outline points + bones x spans x region nodes + features); allocates (debug only)
   * @example Kit.body.debug.drawSurface(context, bake, world, { centerX: 120, groundY: 400, scale: 200 });
   */
  const drawSurface = (context, bake, world, view, { shapes = true, regions = true, features = true } = {}) => {
    const { plan, surface } = bake;
    const counts = { outlines: 0, spans: 0, marks: 0 };
    const layout = Kit.body.surfaceLayout(plan);
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const end = layout.frames[bone].end;
      const shape = bake.shapes[bone] || { kind: 'capsule', radius: (plan.girth[bone] || 0) / 2 };
      if (shapes && shape.kind !== 'none') {
        strokeOutline(context, world, bone, outlineOf(shape, end), view, colorOf(bake, bake.boneRamp[bone], SURFACE_STYLE.outlineShade));
        counts.outlines += 1;
      }
      if (!regions || !surface.regions[bone].length) continue;
      // Spans up the bone's axis, each the colour of the region covering the front at its middle.
      for (let span = 0; span < SURFACE_STYLE.spansPerBone; span++) {
        const middle = (span + 0.5) / SURFACE_STYLE.spansPerBone;
        const rampIndex = surface.regionAt(bone, middle, FRONT_ANGLE, 0, 0, 1);
        if (rampIndex < 0) continue;
        const from = [0, 1, 2].map((axis) => (end[axis] * span) / SURFACE_STYLE.spansPerBone);
        const to = [0, 1, 2].map((axis) => (end[axis] * (span + 1)) / SURFACE_STYLE.spansPerBone);
        Kit.rig.carryPoint(world, bone, from, 0, worldPoint);
        project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenFrom);
        Kit.rig.carryPoint(world, bone, to, 0, worldPoint);
        project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenTo);
        strokeLine(
          context,
          screenFrom,
          screenTo,
          colorOf(bake, rampIndex, SURFACE_STYLE.fillShade),
          Math.max(STYLE.thinnestBone, plan.girth[bone] * world.uniform[bone] * view.scale * SURFACE_STYLE.spanWidthShare)
        );
        counts.spans += 1;
      }
    }
    if (features)
      surface.features.forEach((feature) => {
        const frame = feature.frames[feature.rest] || [];
        const rampIndex = frame.length ? frame[0].ramp : feature.ramp;
        const shade = frame.length ? frame[frame.length > 1 ? 1 : 0].shade : SURFACE_STYLE.fillShade;
        Kit.rig.carryPoint(world, feature.bone, feature.point, 0, worldPoint);
        project(worldPoint[0], worldPoint[1], worldPoint[2], view, screenTo);
        context.fillStyle = colorOf(bake, frame.length > 1 ? frame[1].ramp : rampIndex, shade);
        context.beginPath();
        context.arc(screenTo[0], screenTo[1], SURFACE_STYLE.markRadius, 0, FULL_TURN);
        context.fill();
        counts.marks += 1;
      });
    return counts;
  };

  Kit.body = Object.assign(Kit.body || {}, { debug: { STYLE, SURFACE_STYLE, CONTEXT_METHODS, project, draw, drawSurface } });
})();
