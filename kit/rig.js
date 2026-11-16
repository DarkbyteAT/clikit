/**
 * Kit rig: a hierarchy of joints as flat typed arrays, and the one pass that turns each joint's transform
 * relative to its parent into a transform in the world (forward kinematics). It knows nothing about bodies: a
 * rig is a `parents` array (each joint's parent index, parents before children) plus a set of transforms.
 *
 * Owns:  `Kit.rig.create` / `copy` (transform sets), `worldTransforms` (the forward pass, whole or a range),
 *        `turn` (set one joint's rotation from a base and an angle), `carryPoint` (a joint-space point into
 *        the world) and the small quaternion helpers the solvers share (`shortestArc`, `turnWorld`).
 * Does not own: what the joints are (kit/body-plan.js compiles body plans into this shape; a crane, a rope, a
 *        solar system or a UI tree of nested panels fit it too), inverse kinematics (kit/reach.js), or motion
 *        over time (kit/dynamics.js).
 *
 * Conventions: +Y up, +Z forward, +X left (right-handed); rotations are unit quaternions stored x, y, z, w.
 *
 * The transform model (DECISIONS.md, "Kit.body: transforms"): a joint has a translation, a rotation, a
 * three-axis `scale` that stretches its own content (its children's offsets, points carried on it) but is NOT
 * inherited, and a one-number `uniform` scale that IS inherited by its whole subtree. Nothing ever shears.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Floats per joint in each transform array. */
  const VECTOR_STRIDE = 3;
  const QUATERNION_STRIDE = 4;
  const AXES = Object.freeze({ x: 0, y: 1, z: 2 });
  /** Where a quaternion's scalar part sits after its x, y, z. */
  const QUATERNION_W = 3;
  /** Two directions closer to opposite than this (as 1 + cosine) have no single shortest turn between them. */
  const OPPOSITE_EPSILON = 1e-6;

  /**
   * @typedef {Object} JointTransforms
   * One set of per-joint transforms. As a LOCAL set each joint is relative to its parent; as a WORLD result (the
   * `out` of `worldTransforms`) `translation` is the joint's world position, `rotation` its world rotation,
   * `scale` what its own content is stretched by and `uniform` the size it hands to its subtree.
   * @property {Float32Array} translation 3 per joint
   * @property {Float32Array} rotation 4 per joint: x, y, z, w
   * @property {Float32Array} scale 3 per joint
   * @property {Float32Array} uniform 1 per joint
   */

  /**
   * Allocates a transform set for `count` joints, all at the identity (no offset, no turn, scale 1).
   * @param {number} count
   * @returns {JointTransforms}
   * @complexity O(count) time and space
   * @example const local = Kit.rig.create(3), world = Kit.rig.create(3);
   */
  const create = (count) => {
    const rotation = new Float32Array(count * QUATERNION_STRIDE);
    for (let joint = 0; joint < count; joint++) rotation[joint * QUATERNION_STRIDE + QUATERNION_W] = 1;
    return { translation: new Float32Array(count * VECTOR_STRIDE), rotation, scale: new Float32Array(count * VECTOR_STRIDE).fill(1), uniform: new Float32Array(count).fill(1) };
  };

  /**
   * Copies one transform set over another of the same size, without allocating.
   * @param {JointTransforms} from
   * @param {JointTransforms} out
   * @returns {JointTransforms} `out`
   * @complexity O(joints) time, no allocation
   * @example Kit.rig.copy(restPose, pose);
   */
  const copy = (from, out) => {
    out.translation.set(from.translation);
    out.rotation.set(from.rotation);
    out.scale.set(from.scale);
    out.uniform.set(from.uniform);
    return out;
  };

  /**
   * Sets a joint's rotation to a base rotation turned by an angle about one of the joint's own axes: the
   * one-line building block of a procedural pose ("swing this hip forward").
   * @param {Float32Array} rotation the rotations to write, 4 per joint
   * @param {Float32Array} base the rotations to turn from, 4 per joint (usually the rest pose's)
   * @param {number} joint joint index
   * @param {number} axis 0 = x (pitch: swings forward and back), 1 = y (yaw), 2 = z (roll: swings sideways)
   * @param {number} radians
   * @returns {void}
   * @complexity O(1), no allocation
   * @example Kit.rig.turn(pose.rotation, rest.rotation, hip, 0, Math.sin(phase) * 0.6);
   */
  const turn = (rotation, base, joint, axis, radians) => {
    const at = joint * QUATERNION_STRIDE;
    const sine = Math.sin(radians / 2);
    const turnW = Math.cos(radians / 2);
    const turnX = axis === AXES.x ? sine : 0;
    const turnY = axis === AXES.y ? sine : 0;
    const turnZ = axis === AXES.z ? sine : 0;
    const baseX = base[at];
    const baseY = base[at + 1];
    const baseZ = base[at + 2];
    const baseW = base[at + QUATERNION_W];
    // base * turn: the turn happens in the joint's own frame, after its base rotation.
    rotation[at] = baseW * turnX + baseX * turnW + baseY * turnZ - baseZ * turnY;
    rotation[at + 1] = baseW * turnY - baseX * turnZ + baseY * turnW + baseZ * turnX;
    rotation[at + 2] = baseW * turnZ + baseX * turnY - baseY * turnX + baseZ * turnW;
    rotation[at + QUATERNION_W] = baseW * turnW - baseX * turnX - baseY * turnY - baseZ * turnZ;
  };

  /**
   * Forward kinematics: turns local transforms into world transforms in one pass. Parents come before children,
   * so there is no recursion; with an `out` allocated once there is no allocation.
   * @param {Int16Array|number[]} parents joint index -> parent joint index, -1 for a root; every parent has a lower index
   * @param {JointTransforms} local each joint relative to its parent
   * @param {JointTransforms} out receives the world transforms; must not be `local`
   * @param {number} [originX=0] where the roots stand, world units
   * @param {number} [originY=0]
   * @param {number} [originZ=0]
   * @param {number} [heading=0] radians about +Y applied to the roots; 0 faces +Z
   * @param {number} [firstJoint=0] refresh only the joints from this index...
   * @param {number} [endJoint=parents.length] ...up to but not including this one. A partial range that contains a
   *   root needs the same origin and heading as the full pass.
   * @returns {JointTransforms} `out`
   * @complexity O(joints in the range) time (about 60 multiplications a joint), no allocation, no recursion
   * @example
   * const world = Kit.rig.create(parents.length);                       // once
   * Kit.rig.worldTransforms(parents, local, world, x, 0, z, heading);     // per frame, per instance
   */
  const worldTransforms = (parents, local, out, originX = 0, originY = 0, originZ = 0, heading = 0, firstJoint = 0, endJoint = parents.length) => {
    const { translation, rotation, scale, uniform } = local;
    const outTranslation = out.translation;
    const outRotation = out.rotation;
    const outScale = out.scale;
    const outUniform = out.uniform;
    const headingY = Math.sin(heading / 2);
    const headingW = Math.cos(heading / 2);
    // Hot path: an index loop on purpose (measured in tools/bench.js, body.pose500).
    for (let joint = firstJoint; joint < endJoint; joint++) {
      const vector = joint * VECTOR_STRIDE;
      const quaternion = joint * QUATERNION_STRIDE;
      const parentJoint = parents[joint];
      // The frame this joint hangs in: its parent's world transform, or the origin and heading.
      let frameX = originX;
      let frameY = originY;
      let frameZ = originZ;
      let frameQx = 0;
      let frameQy = headingY;
      let frameQz = 0;
      let frameQw = headingW;
      let stretchX = 1;
      let stretchY = 1;
      let stretchZ = 1;
      let inherited = 1;
      if (parentJoint >= 0) {
        const parentVector = parentJoint * VECTOR_STRIDE;
        const parentQuaternion = parentJoint * QUATERNION_STRIDE;
        frameX = outTranslation[parentVector];
        frameY = outTranslation[parentVector + 1];
        frameZ = outTranslation[parentVector + 2];
        frameQx = outRotation[parentQuaternion];
        frameQy = outRotation[parentQuaternion + 1];
        frameQz = outRotation[parentQuaternion + 2];
        frameQw = outRotation[parentQuaternion + QUATERNION_W];
        stretchX = outScale[parentVector];
        stretchY = outScale[parentVector + 1];
        stretchZ = outScale[parentVector + 2];
        inherited = outUniform[parentJoint];
      }
      // The joint offset, stretched by the parent's own scale (which is why "longer thigh" moves the knee).
      const offsetX = translation[vector] * stretchX;
      const offsetY = translation[vector + 1] * stretchY;
      const offsetZ = translation[vector + 2] * stretchZ;
      // Rotate the offset by the frame quaternion: v + 2w(q x v) + 2 q x (q x v).
      const crossX = frameQy * offsetZ - frameQz * offsetY;
      const crossY = frameQz * offsetX - frameQx * offsetZ;
      const crossZ = frameQx * offsetY - frameQy * offsetX;
      outTranslation[vector] = frameX + offsetX + 2 * (frameQw * crossX + frameQy * crossZ - frameQz * crossY);
      outTranslation[vector + 1] = frameY + offsetY + 2 * (frameQw * crossY + frameQz * crossX - frameQx * crossZ);
      outTranslation[vector + 2] = frameZ + offsetZ + 2 * (frameQw * crossZ + frameQx * crossY - frameQy * crossX);
      // World rotation = frame * local.
      const localQx = rotation[quaternion];
      const localQy = rotation[quaternion + 1];
      const localQz = rotation[quaternion + 2];
      const localQw = rotation[quaternion + QUATERNION_W];
      outRotation[quaternion] = frameQw * localQx + frameQx * localQw + frameQy * localQz - frameQz * localQy;
      outRotation[quaternion + 1] = frameQw * localQy - frameQx * localQz + frameQy * localQw + frameQz * localQx;
      outRotation[quaternion + 2] = frameQw * localQz + frameQx * localQy - frameQy * localQx + frameQz * localQw;
      outRotation[quaternion + QUATERNION_W] = frameQw * localQw - frameQx * localQx - frameQy * localQy - frameQz * localQz;
      // The uniform size is handed down the tree; the three-axis scale is not, so nothing ever shears.
      const size = inherited * uniform[joint];
      outUniform[joint] = size;
      outScale[vector] = scale[vector] * size;
      outScale[vector + 1] = scale[vector + 1] * size;
      outScale[vector + 2] = scale[vector + 2] * size;
    }
    return out;
  };

  /**
   * Carries a point given in a joint's own space into the world: stretched by the joint's scale, turned by its
   * rotation, moved to its position. Sockets, bone ends and attachment points are all this.
   * @param {JointTransforms} world the `out` of `worldTransforms`
   * @param {number} joint joint index
   * @param {ArrayLike<number>} points joint-space points, 3 numbers each
   * @param {number} pointAt index in `points` of the point's x
   * @param {Float32Array|number[]} out receives x, y, z
   * @param {number} [outAt=0] index in `out` to write at
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.rig.carryPoint(world, hand, GRIP_OFFSET, 0, point);
   */
  const carryPoint = (world, joint, points, pointAt, out, outAt = 0) => {
    const vector = joint * VECTOR_STRIDE;
    const quaternion = joint * QUATERNION_STRIDE;
    const pointX = points[pointAt] * world.scale[vector];
    const pointY = points[pointAt + 1] * world.scale[vector + 1];
    const pointZ = points[pointAt + 2] * world.scale[vector + 2];
    const quaternionX = world.rotation[quaternion];
    const quaternionY = world.rotation[quaternion + 1];
    const quaternionZ = world.rotation[quaternion + 2];
    const quaternionW = world.rotation[quaternion + QUATERNION_W];
    const crossX = quaternionY * pointZ - quaternionZ * pointY;
    const crossY = quaternionZ * pointX - quaternionX * pointZ;
    const crossZ = quaternionX * pointY - quaternionY * pointX;
    out[outAt] = world.translation[vector] + pointX + 2 * (quaternionW * crossX + quaternionY * crossZ - quaternionZ * crossY);
    out[outAt + 1] = world.translation[vector + 1] + pointY + 2 * (quaternionW * crossY + quaternionZ * crossX - quaternionX * crossZ);
    out[outAt + 2] = world.translation[vector + 2] + pointZ + 2 * (quaternionW * crossZ + quaternionX * crossY - quaternionY * crossX);
    return out;
  };

  /**
   * The smallest rotation that turns one direction onto another, as a quaternion.
   * @param {number} fromX the direction to turn from (any length but zero)
   * @param {number} fromY
   * @param {number} fromZ
   * @param {number} toX the direction to turn to (any length but zero)
   * @param {number} toY
   * @param {number} toZ
   * @param {Float32Array|number[]} out receives x, y, z, w; the identity when either direction has no length
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.rig.shortestArc(0, 1, 0, 1, 0, 0, quaternion);   // a quarter turn from up to left
   */
  const shortestArc = (fromX, fromY, fromZ, toX, toY, toZ, out) => {
    const fromLength = Math.hypot(fromX, fromY, fromZ);
    const toLength = Math.hypot(toX, toY, toZ);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[QUATERNION_W] = 1;
    if (!(fromLength > 0 && toLength > 0)) return out;
    const unitFromX = fromX / fromLength;
    const unitFromY = fromY / fromLength;
    const unitFromZ = fromZ / fromLength;
    const unitToX = toX / toLength;
    const unitToY = toY / toLength;
    const unitToZ = toZ / toLength;
    // (from x to, 1 + from . to) is twice the half-angle quaternion; normalising it gives the rotation.
    let axisX = unitFromY * unitToZ - unitFromZ * unitToY;
    let axisY = unitFromZ * unitToX - unitFromX * unitToZ;
    let axisZ = unitFromX * unitToY - unitFromY * unitToX;
    let scalar = 1 + unitFromX * unitToX + unitFromY * unitToY + unitFromZ * unitToZ;
    if (scalar < OPPOSITE_EPSILON) {
      // Opposite directions: a half turn about any axis across `from`. Cross with whichever world axis is least aligned.
      scalar = 0;
      const useX = Math.abs(unitFromX) < Math.abs(unitFromY);
      axisX = useX ? 0 : -unitFromZ;
      axisY = useX ? unitFromZ : 0;
      axisZ = useX ? -unitFromY : unitFromX;
    }
    const length = Math.hypot(axisX, axisY, axisZ, scalar);
    out[0] = axisX / length;
    out[1] = axisY / length;
    out[2] = axisZ / length;
    out[QUATERNION_W] = scalar / length;
    return out;
  };

  /**
   * Turns a joint by a rotation given in world space, writing the joint's LOCAL rotation (so the change survives
   * the next forward pass) and its world rotation. Children are not refreshed: run `worldTransforms` over the
   * joints that hang from it.
   * @param {Int16Array|number[]} parents
   * @param {JointTransforms} local
   * @param {JointTransforms} world current world transforms of the joint and its parent
   * @param {number} joint joint index
   * @param {ArrayLike<number>} turnBy a world-space quaternion x, y, z, w (e.g. from `shortestArc`)
   * @returns {void}
   * @complexity O(1), no allocation
   * @example Kit.rig.turnWorld(parents, local, world, elbow, Kit.rig.shortestArc(0, -1, 0, 0, 0, 1, quaternion));
   */
  const turnWorld = (parents, local, world, joint, turnBy) => {
    const at = joint * QUATERNION_STRIDE;
    const oldX = world.rotation[at];
    const oldY = world.rotation[at + 1];
    const oldZ = world.rotation[at + 2];
    const oldW = world.rotation[at + QUATERNION_W];
    // New world rotation = turnBy * old world rotation.
    const newX = turnBy[QUATERNION_W] * oldX + turnBy[0] * oldW + turnBy[1] * oldZ - turnBy[2] * oldY;
    const newY = turnBy[QUATERNION_W] * oldY - turnBy[0] * oldZ + turnBy[1] * oldW + turnBy[2] * oldX;
    const newZ = turnBy[QUATERNION_W] * oldZ + turnBy[0] * oldY - turnBy[1] * oldX + turnBy[2] * oldW;
    const newW = turnBy[QUATERNION_W] * oldW - turnBy[0] * oldX - turnBy[1] * oldY - turnBy[2] * oldZ;
    world.rotation[at] = newX;
    world.rotation[at + 1] = newY;
    world.rotation[at + 2] = newZ;
    world.rotation[at + QUATERNION_W] = newW;
    // Local rotation = inverse(parent world rotation) * new world rotation; a unit quaternion's inverse is its conjugate.
    const parentJoint = parents[joint];
    const parentAt = parentJoint * QUATERNION_STRIDE;
    const frameX = parentJoint >= 0 ? -world.rotation[parentAt] : 0;
    const frameY = parentJoint >= 0 ? -world.rotation[parentAt + 1] : 0;
    const frameZ = parentJoint >= 0 ? -world.rotation[parentAt + 2] : 0;
    const frameW = parentJoint >= 0 ? world.rotation[parentAt + QUATERNION_W] : 1;
    local.rotation[at] = frameW * newX + frameX * newW + frameY * newZ - frameZ * newY;
    local.rotation[at + 1] = frameW * newY - frameX * newZ + frameY * newW + frameZ * newX;
    local.rotation[at + 2] = frameW * newZ + frameX * newY - frameY * newX + frameZ * newW;
    local.rotation[at + QUATERNION_W] = frameW * newW - frameX * newX - frameY * newY - frameZ * newZ;
  };

  Kit.rig = { VECTOR_STRIDE, QUATERNION_STRIDE, QUATERNION_W, AXES, create, copy, turn, worldTransforms, carryPoint, shortestArc, turnWorld };
})();
