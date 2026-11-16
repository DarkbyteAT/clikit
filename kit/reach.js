/**
 * Kit reach: inverse kinematics over a `Kit.rig` - "put the end of this limb there" solved for the joint
 * rotations. An exact two-bone solver with a bend hint (arms, legs), a chain solver for any number of bones
 * (spines, tails, tentacles, cranes), and the two steps they are built from, usable alone: aim a joint along a
 * direction, and clamp a joint to its limits.
 *
 * Owns:  `Kit.reach.twoBone`, `Kit.reach.chain` (FABRIK), `Kit.reach.follow` (make a chain of joints pass through
 *        given points: the bridge from any point simulation, such as a `Kit.dynamics` chain, back to rotations),
 *        `Kit.reach.aim` and `Kit.reach.clamp`.
 * Does not own: the hierarchy or the forward pass (kit/rig.js), where targets come from (locomotion, input), or
 *        bodies: every function takes a `parents` array, transform sets and joint indices, nothing else.
 *
 * Every solver keeps `world` up to date for the joints of the chain it was given and for nothing else: after
 * solving, run `Kit.rig.worldTransforms` over whatever hangs from the chain (or over everything).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { VECTOR_STRIDE, QUATERNION_STRIDE, QUATERNION_W } = Kit.rig;
  /** Where the middle and end points of a two-bone solve sit in the scratch buffer (the root's slot comes first). */
  const MIDDLE_POINT = VECTOR_STRIDE;
  const END_POINT = 2 * VECTOR_STRIDE;
  const TWO_BONE_JOINTS = 3;
  /** Tunables of the chain solver. */
  const CHAIN_DEFAULTS = Object.freeze({ iterations: 12, tolerance: 0.001 });
  /** The longest chain the solver's scratch buffers hold. */
  const MOST_CHAIN_JOINTS = 64;
  /** Lengths and distances below this are treated as zero, to keep divisions finite. */
  const TINY = 1e-9;
  /** Radians a joint may sit past a limit before it is corrected: the rounding of a 32-bit quaternion, not a real excess. */
  const ANGLE_SLACK = 1e-4;
  /** A two-bone limb stops this fraction short of dead straight or fully folded, where its bend direction would be lost. */
  const REACH_MARGIN = 1e-4;

  /** Scratch buffers shared by the solvers; never handed out, so solving allocates nothing. */
  const scratchPoints = new Float32Array(MOST_CHAIN_JOINTS * VECTOR_STRIDE);
  const scratchLengths = new Float32Array(MOST_CHAIN_JOINTS);
  const scratchQuaternion = new Float32Array(QUATERNION_STRIDE);
  const scratchTwoBone = new Int32Array(TWO_BONE_JOINTS);

  /** Moves scratch point `moved` to sit `length` from scratch point `anchor`, on the line between them. */
  const pull = (moved, anchor, length) => {
    const points = scratchPoints;
    const offsetX = points[moved] - points[anchor];
    const offsetY = points[moved + 1] - points[anchor + 1];
    const offsetZ = points[moved + 2] - points[anchor + 2];
    const scale = length / (Math.hypot(offsetX, offsetY, offsetZ) || 1);
    points[moved] = points[anchor] + offsetX * scale;
    points[moved + 1] = points[anchor + 1] + offsetY * scale;
    points[moved + 2] = points[anchor + 2] + offsetZ * scale;
  };

  /**
   * @typedef {Object} JointLimits
   * How far each joint may turn from a base rotation, about its own x, then y, then z axis.
   * @property {ArrayLike<number>} min 3 per joint: lowest turn about x, y, z, radians
   * @property {ArrayLike<number>} max 3 per joint: highest turn about x, y, z, radians
   * @property {ArrayLike<number>} base 4 per joint: the rotation the limits are measured from (the rest pose's)
   */

  /** An angle held to a range; one within ANGLE_SLACK of the range is left alone, so clamping twice changes nothing. */
  const clampAngle = (angle, lowest, highest) => (angle < lowest - ANGLE_SLACK ? lowest : angle > highest + ANGLE_SLACK ? highest : angle);

  /** Refreshes one joint's world transform from its parent's (the joint must have a parent). */
  const refreshJoint = (parents, local, world, joint) => Kit.rig.worldTransforms(parents, local, world, 0, 0, 0, 0, joint, joint + 1);

  /**
   * Clamps a joint's local rotation to its limits: the rotation is taken apart into turns about the joint's own
   * x, y and z axes relative to the base rotation, each turn is clamped, and the rotation is put back together.
   * A rotation already inside its limits is left exactly as it was.
   * @param {Object} local the local `JointTransforms` to correct
   * @param {number} joint joint index
   * @param {JointLimits} limits
   * @returns {boolean} true when the rotation had to be changed
   * @complexity O(1), no allocation
   * @example if (Kit.reach.clamp(pose, knee, plan.jointLimits)) refreshWhatHangsFromIt();
   */
  const clamp = (local, joint, limits) => {
    const at = joint * QUATERNION_STRIDE;
    const limitAt = joint * VECTOR_STRIDE;
    const rotation = local.rotation;
    // Turn relative to the base: conjugate(base) * local.
    const baseX = -limits.base[at];
    const baseY = -limits.base[at + 1];
    const baseZ = -limits.base[at + 2];
    const baseW = limits.base[at + QUATERNION_W];
    const turnX = baseW * rotation[at] + baseX * rotation[at + QUATERNION_W] + baseY * rotation[at + 2] - baseZ * rotation[at + 1];
    const turnY = baseW * rotation[at + 1] - baseX * rotation[at + 2] + baseY * rotation[at + QUATERNION_W] + baseZ * rotation[at];
    const turnZ = baseW * rotation[at + 2] + baseX * rotation[at + 1] - baseY * rotation[at] + baseZ * rotation[at + QUATERNION_W];
    const turnW = baseW * rotation[at + QUATERNION_W] - baseX * rotation[at] - baseY * rotation[at + 1] - baseZ * rotation[at + 2];
    // Angles of the turn as x, then y, then z (the order `Kit.body` rest turns are written in).
    const angleX = Math.atan2(-2 * (turnY * turnZ - turnW * turnX), 1 - 2 * (turnX * turnX + turnY * turnY));
    const angleY = Math.asin(Math.max(-1, Math.min(1, 2 * (turnX * turnZ + turnW * turnY))));
    const angleZ = Math.atan2(-2 * (turnX * turnY - turnW * turnZ), 1 - 2 * (turnY * turnY + turnZ * turnZ));
    const clampedX = clampAngle(angleX, limits.min[limitAt], limits.max[limitAt]);
    const clampedY = clampAngle(angleY, limits.min[limitAt + 1], limits.max[limitAt + 1]);
    const clampedZ = clampAngle(angleZ, limits.min[limitAt + 2], limits.max[limitAt + 2]);
    if (clampedX === angleX && clampedY === angleY && clampedZ === angleZ) return false;
    const sinX = Math.sin(clampedX / 2);
    const cosX = Math.cos(clampedX / 2);
    const sinY = Math.sin(clampedY / 2);
    const cosY = Math.cos(clampedY / 2);
    const sinZ = Math.sin(clampedZ / 2);
    const cosZ = Math.cos(clampedZ / 2);
    const newX = sinX * cosY * cosZ + cosX * sinY * sinZ;
    const newY = cosX * sinY * cosZ - sinX * cosY * sinZ;
    const newZ = cosX * cosY * sinZ + sinX * sinY * cosZ;
    const newW = cosX * cosY * cosZ - sinX * sinY * sinZ;
    // local = base * clamped turn.
    const restX = limits.base[at];
    const restY = limits.base[at + 1];
    const restZ = limits.base[at + 2];
    const restW = limits.base[at + QUATERNION_W];
    rotation[at] = restW * newX + restX * newW + restY * newZ - restZ * newY;
    rotation[at + 1] = restW * newY - restX * newZ + restY * newW + restZ * newX;
    rotation[at + 2] = restW * newZ + restX * newY - restY * newX + restZ * newW;
    rotation[at + QUATERNION_W] = restW * newW - restX * newX - restY * newY - restZ * newZ;
    return true;
  };

  /**
   * Turns a joint by the smallest rotation that swings its child from where it is to a wanted point, clamps the
   * joint to its limits when given, and refreshes the child's world transform. This is one step of every solver.
   * @param {Int16Array|number[]} parents
   * @param {Object} local local `JointTransforms`; the joint's rotation is written
   * @param {Object} world world `JointTransforms`; the joint's and the child's entries are refreshed
   * @param {number} joint the joint to turn (must have a parent)
   * @param {number} child a direct child of `joint`: the thing being pointed
   * @param {number} towardX where the child should lie, world units (only the direction from the joint matters)
   * @param {number} towardY
   * @param {number} towardZ
   * @param {JointLimits} [limits]
   * @returns {void}
   * @complexity O(1), no allocation
   * @example Kit.reach.aim(parents, pose, world, neck, head, prey.x, prey.y, prey.z, limits);   // look at it
   */
  const aim = (parents, local, world, joint, child, towardX, towardY, towardZ, limits) => {
    const jointAt = joint * VECTOR_STRIDE;
    const childAt = child * VECTOR_STRIDE;
    const position = world.translation;
    Kit.rig.shortestArc(
      position[childAt] - position[jointAt],
      position[childAt + 1] - position[jointAt + 1],
      position[childAt + 2] - position[jointAt + 2],
      towardX - position[jointAt],
      towardY - position[jointAt + 1],
      towardZ - position[jointAt + 2],
      scratchQuaternion
    );
    Kit.rig.turnWorld(parents, local, world, joint, scratchQuaternion);
    // A clamp changes the local rotation only; the forward step below brings the world rotation back in line.
    if (limits && clamp(local, joint, limits)) refreshJoint(parents, local, world, joint);
    refreshJoint(parents, local, world, child);
  };

  /**
   * Makes a chain of joints pass through given points, as nearly as bone lengths and limits allow: each joint
   * in turn is aimed so its child lies towards the next point. This is how positions become rotations - the
   * last step of the chain solver, and the way to drive bones from a rope or tail simulation.
   * @param {Int16Array|number[]} parents
   * @param {Object} local local `JointTransforms`; the rotations of every joint but the last are written
   * @param {Object} world world `JointTransforms`, current on entry for the first joint; refreshed for the chain
   * @param {ArrayLike<number>} joints joint indices from the base outwards; each must be the parent of the next
   * @param {ArrayLike<number>} points 3 numbers per chain joint, world units; the first is ignored (a base does not move)
   * @param {JointLimits} [limits]
   * @returns {void}
   * @throws {Error} when a joint of the chain is not the parent of the next
   * @complexity O(joints) time, no allocation
   * @example Kit.reach.follow(plan.parent, pose, world, tailBones, rope.positions);
   */
  const follow = (parents, local, world, joints, points, limits) => {
    for (let link = 0; link + 1 < joints.length; link++) {
      const child = joints[link + 1];
      if (parents[child] !== joints[link])
        throw new Error(`Kit.reach.follow: joint ${child} is not a child of joint ${joints[link]}; a chain lists joints from the base outwards, each the parent of the next.`);
      const pointAt = (link + 1) * VECTOR_STRIDE;
      // Turning the joint before this one moved this joint but not yet its child: bring the child up to date.
      if (link > 0) refreshJoint(parents, local, world, child);
      aim(parents, local, world, joints[link], child, points[pointAt], points[pointAt + 1], points[pointAt + 2], limits);
    }
  };

  /**
   * Exact inverse kinematics for a limb of two bones: places the end joint on the target with the middle joint
   * (the knee, the elbow) bent towards a hint point. A target out of reach leaves the limb straight towards it;
   * a target too close folds it as far as it goes. Limits, when given, are applied to both joints after the
   * solve, so a limb whose limits forbid the exact answer stops at its limit short of the target.
   * @param {Int16Array|number[]} parents
   * @param {Object} local local `JointTransforms`; the rotations of `upper` and `middle` are written
   * @param {Object} world world `JointTransforms`, current on entry; refreshed for the three joints
   * @param {number} upper the joint at the body (hip, shoulder); must have a parent
   * @param {number} middle its child (knee, elbow)
   * @param {number} end the middle joint's child (ankle, wrist): the point that reaches
   * @param {number} targetX where the end should be, world units
   * @param {number} targetY
   * @param {number} targetZ
   * @param {number} hintX a point the middle joint should bend towards (in front of a knee, behind an elbow)
   * @param {number} hintY
   * @param {number} hintZ
   * @param {JointLimits} [limits]
   * @returns {boolean} true when the target was within the limb's reach (limits aside)
   * @complexity O(1) time (two square roots, no trigonometry beyond the limit clamp), no allocation, no iteration
   * @example
   * Kit.reach.twoBone(plan.parent, pose, world, hip, knee, ankle, foot.x, 0, foot.z, foot.x, 0.5, foot.z + 1, plan.jointLimits);
   */
  const twoBone = (parents, local, world, upper, middle, end, targetX, targetY, targetZ, hintX, hintY, hintZ, limits) => {
    const position = world.translation;
    const upperAt = upper * VECTOR_STRIDE;
    const middleAt = middle * VECTOR_STRIDE;
    const endAt = end * VECTOR_STRIDE;
    const rootX = position[upperAt];
    const rootY = position[upperAt + 1];
    const rootZ = position[upperAt + 2];
    const upperLength = Math.hypot(position[middleAt] - rootX, position[middleAt + 1] - rootY, position[middleAt + 2] - rootZ);
    const lowerLength = Math.hypot(position[endAt] - position[middleAt], position[endAt + 1] - position[middleAt + 1], position[endAt + 2] - position[middleAt + 2]);
    let alongX = targetX - rootX;
    let alongY = targetY - rootY;
    let alongZ = targetZ - rootZ;
    const distance = Math.hypot(alongX, alongY, alongZ);
    if (distance < TINY) {
      // A target on the root joint has no direction: keep the limb's current one.
      alongX = position[endAt] - rootX;
      alongY = position[endAt + 1] - rootY;
      alongZ = position[endAt + 2] - rootZ;
    }
    const alongLength = Math.hypot(alongX, alongY, alongZ) || 1;
    alongX /= alongLength;
    alongY /= alongLength;
    alongZ /= alongLength;
    const longest = (upperLength + lowerLength) * (1 - REACH_MARGIN);
    const shortest = Math.abs(upperLength - lowerLength) + (upperLength + lowerLength) * REACH_MARGIN;
    const reach = Math.max(shortest, Math.min(longest, distance));
    // The middle joint sits on the circle where the two bones' spheres meet: `ahead` along the line, `aside` off it.
    const ahead = (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach);
    const aside = Math.sqrt(Math.max(0, upperLength * upperLength - ahead * ahead));
    // The bend direction: the part of (hint - root) that is square to the line, else the limb's current bend.
    let bendX = hintX - rootX;
    let bendY = hintY - rootY;
    let bendZ = hintZ - rootZ;
    let onLine = bendX * alongX + bendY * alongY + bendZ * alongZ;
    bendX -= alongX * onLine;
    bendY -= alongY * onLine;
    bendZ -= alongZ * onLine;
    if (Math.hypot(bendX, bendY, bendZ) < TINY) {
      bendX = position[middleAt] - rootX;
      bendY = position[middleAt + 1] - rootY;
      bendZ = position[middleAt + 2] - rootZ;
      onLine = bendX * alongX + bendY * alongY + bendZ * alongZ;
      bendX -= alongX * onLine;
      bendY -= alongY * onLine;
      bendZ -= alongZ * onLine;
    }
    const bendLength = Math.hypot(bendX, bendY, bendZ);
    const bendScale = bendLength < TINY ? 0 : aside / bendLength;
    // Points for `follow`: (ignored root), the middle joint, then the end on the line at the clamped reach.
    scratchPoints[MIDDLE_POINT] = rootX + alongX * ahead + bendX * bendScale;
    scratchPoints[MIDDLE_POINT + 1] = rootY + alongY * ahead + bendY * bendScale;
    scratchPoints[MIDDLE_POINT + 2] = rootZ + alongZ * ahead + bendZ * bendScale;
    scratchPoints[END_POINT] = rootX + alongX * reach;
    scratchPoints[END_POINT + 1] = rootY + alongY * reach;
    scratchPoints[END_POINT + 2] = rootZ + alongZ * reach;
    scratchTwoBone[0] = upper;
    scratchTwoBone[1] = middle;
    scratchTwoBone[2] = end;
    follow(parents, local, world, scratchTwoBone, scratchPoints, limits);
    return distance <= upperLength + lowerLength && distance >= Math.abs(upperLength - lowerLength);
  };

  /**
   * Inverse kinematics for a chain of any length by FABRIK (forward and backward reaching): joint positions are
   * dragged to the target from the tip and back to the base along the bone lengths until the tip arrives, then
   * turned into joint rotations with `follow`. A target beyond the chain's length is answered at once with the
   * chain straight towards it. Limits, when given, are applied as the rotations are written, so a tightly
   * limited chain may stop short (see DECISIONS.md, "Kit.reach: chain solver").
   * @param {Int16Array|number[]} parents
   * @param {Object} local local `JointTransforms`; the rotations of every chain joint but the last are written
   * @param {Object} world world `JointTransforms`, current on entry; refreshed for the chain
   * @param {ArrayLike<number>} joints joint indices from the base outwards, each the parent of the next; 2 to 64
   * @param {number} targetX where the last joint should be, world units
   * @param {number} targetY
   * @param {number} targetZ
   * @param {{iterations?: number, tolerance?: number, limits?: JointLimits}} [options] most passes (default 12),
   *   how close counts as arrived in world units (default 0.001), joint limits
   * @returns {number} how far the last joint ended from the target, world units
   * @throws {Error} for a chain shorter than 2 or longer than 64 joints, or one whose joints are not parent and child
   * @complexity O(iterations x joints) time, no allocation. It typically arrives within the tolerance in 3 to 8
   *   passes; a nearly straight chain converges slowest, which the pass limit bounds.
   * @example
   * const miss = Kit.reach.chain(plan.parent, pose, world, tailBones, lure.x, lure.y, lure.z, { limits: plan.jointLimits });
   */
  const chain = (parents, local, world, joints, targetX, targetY, targetZ, options = CHAIN_DEFAULTS) => {
    const count = joints.length;
    if (count < 2 || count > MOST_CHAIN_JOINTS) throw new Error(`Kit.reach.chain: a chain has 2 to ${MOST_CHAIN_JOINTS} joints, got ${count}.`);
    const iterations = options.iterations === undefined ? CHAIN_DEFAULTS.iterations : options.iterations;
    const tolerance = options.tolerance === undefined ? CHAIN_DEFAULTS.tolerance : options.tolerance;
    const position = world.translation;
    const points = scratchPoints;
    let totalLength = 0;
    for (let link = 0; link < count; link++) {
      const from = joints[link] * VECTOR_STRIDE;
      points[link * VECTOR_STRIDE] = position[from];
      points[link * VECTOR_STRIDE + 1] = position[from + 1];
      points[link * VECTOR_STRIDE + 2] = position[from + 2];
      if (link > 0) {
        const previous = (link - 1) * VECTOR_STRIDE;
        scratchLengths[link - 1] = Math.hypot(points[previous + QUATERNION_W] - points[previous], points[previous + 4] - points[previous + 1], points[previous + 5] - points[previous + 2]);
        totalLength += scratchLengths[link - 1];
      }
    }
    const baseX = points[0];
    const baseY = points[1];
    const baseZ = points[2];
    const tip = (count - 1) * VECTOR_STRIDE;
    if (Math.hypot(targetX - baseX, targetY - baseY, targetZ - baseZ) >= totalLength) {
      // Out of reach: the answer is the chain laid straight towards the target; one outward pass lays it.
      for (let link = 1; link < count; link++) {
        points[link * VECTOR_STRIDE] = targetX;
        points[link * VECTOR_STRIDE + 1] = targetY;
        points[link * VECTOR_STRIDE + 2] = targetZ;
        pull(link * VECTOR_STRIDE, (link - 1) * VECTOR_STRIDE, scratchLengths[link - 1]);
      }
    } else {
      for (let pass = 0; pass < iterations; pass++) {
        if (Math.hypot(points[tip] - targetX, points[tip + 1] - targetY, points[tip + 2] - targetZ) <= tolerance) break;
        // Backward: put the tip on the target and drag each joint after it.
        points[tip] = targetX;
        points[tip + 1] = targetY;
        points[tip + 2] = targetZ;
        for (let link = count - 2; link >= 0; link--) pull(link * VECTOR_STRIDE, (link + 1) * VECTOR_STRIDE, scratchLengths[link]);
        // Forward: put the base back and drag each joint out again.
        points[0] = baseX;
        points[1] = baseY;
        points[2] = baseZ;
        for (let link = 1; link < count; link++) pull(link * VECTOR_STRIDE, (link - 1) * VECTOR_STRIDE, scratchLengths[link - 1]);
      }
    }
    follow(parents, local, world, joints, points, options.limits);
    const last = joints[count - 1] * VECTOR_STRIDE;
    return Math.hypot(position[last] - targetX, position[last + 1] - targetY, position[last + 2] - targetZ);
  };

  Kit.reach = { CHAIN_DEFAULTS, MOST_CHAIN_JOINTS, clamp, aim, follow, twoBone, chain };
})();
