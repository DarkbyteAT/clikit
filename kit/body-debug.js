/**
 * Kit body debug: a stick figure of any posed body plan on a 2D canvas, with its sockets marked. It exists so a
 * person can see that a plan, a pose, an attachment or a dial does what the numbers say, and as the smallest
 * possible example of a renderer: project the world transforms, draw the bones.
 *
 * Owns:  `Kit.body.debug.project` (orthographic projection of a world point for a view angle) and
 *        `Kit.body.debug.draw` (bones as lines, bone ends, joints, socket markers).
 * Does not own: real rendering (shapes, shading, palettes: the pixel and 3D renderers read the same plan and
 *        world transforms), the canvas or its size, or posing.
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
    jointRadius: 2,
    socketRadius: 4,
    socketLineWidth: 1.5,
  });
  /** The 2D-context methods `draw` uses; a stand-in context needs exactly these plus the three style properties. */
  const CONTEXT_METHODS = ['beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'closePath'];
  const VECTOR_STRIDE = 3;
  const FULL_TURN = Math.PI * 2;

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
      const width = Math.max(STYLE.thinnestBone, bodyPlan.girth[bone] * world.uniform[bone] * view.scale * 0.5);
      project(position[at], position[at + 1], position[at + 2], view, screenTo);
      // The ground bone at the origin is a reference point, not a limb: nothing is drawn to it or from it.
      if (parentBone > 0) {
        const parentAt = parentBone * VECTOR_STRIDE;
        project(position[parentAt], position[parentAt + 1], position[parentAt + 2], view, screenFrom);
        strokeLine(context, screenFrom, screenTo, color, Math.max(STYLE.thinnestBone, bodyPlan.girth[parentBone] * world.uniform[parentBone] * view.scale * 0.5));
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

  Kit.body = Object.assign(Kit.body || {}, { debug: { STYLE, CONTEXT_METHODS, project, draw } });
})();
