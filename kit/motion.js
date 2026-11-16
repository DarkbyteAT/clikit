/**
 * Kit motion: movement as small stages that compose. A stage is a pair of functions of the same shape,
 * `(motion, plan, dt)`: `step` advances what must be simulated on the fixed clock (phases, footfalls), `pose`
 * writes this frame's pose from that state. Combinators turn stages into bigger stages, so a new body or a new
 * behaviour is a new composition of the same parts, not new code. A motion state is one instance's movement:
 * where it is, how fast it is going, and the pose buffers it owns.
 *
 * Owns:  `Kit.motion.stage` and the combinators `sequence`, `blend`, `layer`, `when`, `byDetail`; `refusal` /
 *        `requireFit` (can this plan run this stage, and if not, what is missing); `state` (a per-instance
 *        motion state), `advance` (one frame: fixed steps, then the pose, then the world transforms), `place`
 *        (teleport), `advanceStore` (every instance of a `Kit.body.store`); `turnBody` / `restFrames` (turn a
 *        bone about the body's axes, whichever way a plan's bones point); the stages every kind of
 *        movement shares, `lean` (tilt into acceleration and turns), `trail` (tails and wings follow by
 *        simulation) and `loose` (so does everything a plan declares loose: hair, a cloak, ears); and `course` /
 *        `drive` (a body steered along a table of speeds and turns).
 * Does not own: how legs walk (kit/gait.js) or bodies swim (kit/swim.js), the fixed clock (`Kit.dynamics.stepsDue`),
 *        kinematics (kit/rig.js, kit/reach.js), plans (kit/body-plan.js), where an instance should go (the
 *        caller moves it; this reads the movement), or drawing.
 *
 * Conventions (kit/body-plan.js): metres, seconds, radians; +Y up; heading 0 faces +Z and grows towards +X, the
 * body's left. "Body frame" means left, up, forward.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-gait.js.
 */
(() => {
  const { FIXED_STEP } = Kit.dynamics;
  const { VECTOR_STRIDE, QUATERNION_STRIDE, QUATERNION_W, AXES } = Kit.rig;
  const TAU = Math.PI * 2;
  /** Metres per second squared. Leans, strides and tails are sized against it. */
  const GRAVITY = 9.81;

  /**
   * How quickly the measured facts of a movement settle, per second. The caller moves the body once a frame, so
   * the raw speed is a staircase; these rates turn it into something a stride and a lean can follow.
   */
  const SMOOTHING = Object.freeze({ velocity: 14, acceleration: 6, turn: 10 });
  /** Metres per second. A body that moved faster than this in one frame was teleported, not walked. */
  const TELEPORT_SPEED = 60;
  /** Tunables of `lean`. Angles in radians. */
  const LEAN_DEFAULTS = Object.freeze({
    pitchShare: 0.6, // of the angle that would balance the acceleration exactly (atan(a / g))
    pitchPerSpeed: 0, // radians of forward tilt per metre per second of forward speed (a runner leans into the run)
    rollShare: 0.8, // of the angle that would balance the turn exactly (atan(v w / g))
    mostPitch: 0.3,
    mostRoll: 0.45,
    stiffness: 60, // 1/s^2; critically damped, so the lean follows in about a third of a second
  });
  /** Tunables of `trail`. */
  const TRAIL_DEFAULTS = Object.freeze({
    roles: Object.freeze(['tail']),
    gravity: Object.freeze([0, -GRAVITY, 0]),
    drag: 2.5, // per second
    stiffnessScale: 2.2, // chain straightening rate (per second) per square root of the base bone's stiffness hint (1/s^2)
  });
  /** Tunables of `loose`. */
  const LOOSE_DEFAULTS = Object.freeze({
    below: 100, // 1/s^2: a bone whose stiffness hint is under this is loose (the default hint is 120; tails and hair state 20 to 40)
    except: Object.freeze(['leg', 'arm', 'tail', 'wing']), // roles other stages move: limbs are solved, tails and wings have `trail`
    gravity: Object.freeze([0, -GRAVITY, 0]),
    drag: 3, // per second
    stiffnessScale: 2.2, // as `trail`: straightening rate per square root of the base bone's stiffness hint
    shortestTip: 0.01, // metres: a last bone shorter than this has no end to swing
    solidGirth: 0.07, // metres: a stiff bone at least this thick is a solid the loose chains are kept out of
    solidShare: 0.85, // of a bone's half girth its balls take: drawn shapes are rounder than a cylinder
    mostBallsPerBone: 4,
    wornWithin: 1.25, // a chain whose rest points lie within this many radii of a solid's ball is worn round it and does not collide with it
    thickness: 0.1, // of the chain's own girth: how far its points keep from the floor and the solids
  });
  /** Tunables of `course`. */
  const COURSE_DEFAULTS = Object.freeze({ acceleration: 2.5, turnAcceleration: 4, x: 0, z: 0, heading: 0 });

  const NAME = 'Kit.motion';
  const fail = (where, message) => {
    throw new Error(`${NAME}.${where}: ${message}`);
  };
  /** The fraction of the way a smoothed value moves towards its target in one fixed step. */
  const blendPerStep = (ratePerSecond) => 1 - Math.exp(-ratePerSecond * FIXED_STEP);
  const VELOCITY_BLEND = blendPerStep(SMOOTHING.velocity);
  const ACCELERATION_BLEND = blendPerStep(SMOOTHING.acceleration);
  const TURN_BLEND = blendPerStep(SMOOTHING.turn);
  /** The signed smallest turn from one heading to another, radians in (-pi, pi]. */
  const shortestTurn = (from, to) => Kit.math.wrap(to - from + Math.PI, TAU) - Math.PI;
  const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));

  // ---- stages and combinators ---------------------------------------------------------------------------------------

  /**
   * @typedef {Object} StageNeed
   * One thing a stage needs from a plan before it can run on it.
   * @property {string} consumer who is asking, for the refusal ('the walk gait')
   * @property {Object} [requirement] capabilities, from `Kit.body.requirement`
   * @property {function(Object, Object): ?string} [check] (plan, rest pose) -> what is wrong, or null; for needs
   *   a capability mask cannot state ("every leg has three bones")
   */

  /**
   * @typedef {Object} Stage
   * @property {string} name what it is, for refusals and debugging
   * @property {?function(MotionState, Object, number): void} step (motion, plan, dt) on the fixed clock: `dt` is
   *   always `Kit.dynamics.FIXED_STEP`. Null when the stage simulates nothing.
   * @property {?function(MotionState, Object, number): void} pose (motion, plan, dt) once per `advance`: writes
   *   `motion.pose`; `dt` is the frame's. Null when the stage only simulates.
   * @property {ReadonlyArray<StageNeed>} needs
   * @property {number} detailLevels how many levels of detail it evaluates; at `motion.detail` equal or above,
   *   `advance` runs neither its pose nor the world transforms (Infinity unless made by `byDetail`)
   */

  /**
   * @typedef {Object} MotionState
   * One instance's movement. Read anything; write only `detail` (and the placement, through `advance` / `place`).
   * @property {Object} plan the `BodyPlan`
   * @property {Object} rest the proportioned rest pose every frame starts from (shared with the bake; never written)
   * @property {Object} pose the local pose this frame (`JointTransforms`), owned by this state
   * @property {Object} world the world transforms this frame, owned by this state
   * @property {boolean} isWorldCurrent false after a stage changed `pose` without refreshing `world`
   * @property {Stage} controller the stage `advance` runs
   * @property {number} x where the body stands, world metres
   * @property {number} y the height of the ground under it
   * @property {number} z
   * @property {number} heading radians about +Y
   * @property {number} velocityX smoothed, metres per second
   * @property {number} velocityZ
   * @property {number} speed metres per second, never negative
   * @property {number} forwardSpeed the part of the velocity along the heading (negative when backing up)
   * @property {number} acceleration change of `forwardSpeed`, smoothed, metres per second squared
   * @property {number} turnRate smoothed, radians per second, positive towards the body's left
   * @property {number} time seconds simulated
   * @property {number} phase 0..1, where the body is in its movement cycle; the stage that runs the cycle owns it
   * @property {number} detail level of detail, 0 = full (copy `store.detail[slot]` here, or use `advanceStore`)
   * @property {number} epoch counts teleports; a stage that keeps world positions starts again when it changes
   * @property {Float32Array} masses one per bone, kilograms
   * @property {number} totalMass kilograms
   * @property {Object<string, Object>} memory per-stage records, made on first use (`Kit.motion.memory`)
   * @property {number} carry seconds not yet simulated (owned by `advance`)
   * @property {number} pending seconds since the last fixed step ran (owned by `advance`)
   * @property {Object[]} spares pose buffers lent to `blend` and `layer` (owned by them)
   * @property {number} sparesUsed
   */

  /** A plain function is a stage that only poses. */
  const fromFunction = (pose) => Object.freeze({ name: pose.name || 'pose', step: null, pose, needs: Object.freeze([]), detailLevels: Infinity });

  /**
   * Makes a stage from its parts, or passes one through. Every combinator calls this on what it is given, so
   * a plain `(motion, plan, dt) => {}` function can be used anywhere a stage can.
   * @param {Stage|Function|Object} parts a stage, a function (motion, plan, dt), or { name?, step?, pose?, needs?, detailLevels? }
   * @returns {Stage} frozen
   * @throws {Error} when given neither a function nor an object with a `step` or a `pose`
   * @complexity O(1)
   * @example
   * const nod = Kit.motion.stage({ name: 'nod', pose: (motion, plan) => Kit.rig.turn(motion.pose.rotation, motion.pose.rotation, head, 0, 0.2) });
   */
  const stage = (parts) => {
    if (typeof parts === 'function') return fromFunction(parts);
    if (!parts || (typeof parts.step !== 'function' && typeof parts.pose !== 'function'))
      fail('stage', 'a stage is a function (motion, plan, dt), or an object with a `step` and / or a `pose` of that shape.');
    if (Object.isFrozen(parts) && Array.isArray(parts.needs) && typeof parts.detailLevels === 'number') return /** @type {Stage} */ (parts);
    return Object.freeze({
      name: parts.name || 'stage',
      step: parts.step || null,
      pose: parts.pose || null,
      needs: Object.freeze([...(parts.needs || [])]),
      detailLevels: parts.detailLevels === undefined ? Infinity : parts.detailLevels,
    });
  };

  /** Runs every function of a list with the same arguments; an index loop because it is on the per-frame path. */
  const runAll = (functions) => (motion, plan, dt) => {
    for (let index = 0; index < functions.length; index++) functions[index](motion, plan, dt);
  };

  /**
   * Stages run one after another: every `step` in order on the fixed clock, every `pose` in order each frame.
   * Later stages see what earlier ones wrote, so order is meaning: lean before the legs are solved, tails last.
   * @param {...(Stage|Function)} parts
   * @returns {Stage} needs everything its parts need
   * @complexity O(parts) per call on top of the parts' own cost; no allocation
   * @example const walk = Kit.motion.sequence(Kit.motion.lean(), Kit.gait.arms(), Kit.gait.plant(), Kit.motion.trail());
   */
  const sequence = (...parts) => {
    const stages = parts.map(stage);
    const steps = stages.map((part) => part.step).filter(Boolean);
    const poses = stages.map((part) => part.pose).filter(Boolean);
    return stage({
      name: `sequence(${stages.map((part) => part.name).join(', ')})`,
      step: steps.length ? runAll(steps) : undefined,
      pose: poses.length ? runAll(poses) : () => {},
      needs: stages.flatMap((part) => part.needs),
      detailLevels: Math.min(...stages.map((part) => part.detailLevels)),
    });
  };

  /** Lends a pose buffer of the state for the length of one combinator call; made the first time it is needed. */
  const borrowPose = (motion) => {
    if (motion.sparesUsed === motion.spares.length) motion.spares.push(Kit.rig.create(motion.plan.boneCount));
    return motion.spares[motion.sparesUsed++];
  };

  /**
   * A stage whose pose is mixed over what was there before it by a weight: 0 leaves the pose alone, 1 is the
   * stage outright. Its `step` always runs, so the stage is warm when its weight comes up. Mixing happens on
   * joint rotations, so a mixed walk no longer holds its feet exactly on their plants: blend to change
   * movement, not as a movement.
   * @param {number|function(MotionState, Object): number} weight 0..1, or a function giving it each frame
   * @param {Stage|Function} part
   * @returns {Stage}
   * @complexity O(joints) per frame when the weight is strictly between 0 and 1 (one copy, one mix); the first
   *   such frame of an instance allocates one pose buffer, none after
   * @example const wade = Kit.motion.sequence(walk, Kit.motion.blend((motion) => motion.memory.water.depth, swim));
   */
  const blend = (weight, part) => {
    const inner = stage(part);
    const weightOf = typeof weight === 'function' ? weight : () => weight;
    return stage({
      name: `blend(${inner.name})`,
      step: inner.step || undefined,
      needs: inner.needs,
      pose(motion, plan, dt) {
        const amount = weightOf(motion, plan);
        if (!inner.pose || amount <= 0) return;
        if (amount >= 1) {
          inner.pose(motion, plan, dt);
          return;
        }
        const before = Kit.rig.copy(motion.pose, borrowPose(motion));
        inner.pose(motion, plan, dt);
        Kit.rig.mix(before, motion.pose, amount, motion.pose);
        motion.sparesUsed -= 1;
        motion.isWorldCurrent = false;
      },
    });
  };

  /**
   * A stage confined to part of the body: it runs in full, then every bone that carries none of the given
   * roles is put back as it was. This is how an upper-body movement is laid over a walk.
   * @param {string[]} roles role names (`Kit.body.ROLES`); a bone carrying ANY of them keeps the stage's changes
   * @param {Stage|Function} part
   * @returns {Stage}
   * @throws {Error} for an unknown role
   * @complexity O(joints) per frame (one copy, one pass); the first frame of an instance allocates one pose buffer
   * @example const wave = Kit.motion.layer(['arm', 'hand'], greeting);   // legs keep walking
   */
  const layer = (roles, part) => {
    const inner = stage(part);
    const mask = Kit.body.roleMask(roles);
    return stage({
      name: `layer(${roles.join('+')}: ${inner.name})`,
      step: inner.step || undefined,
      needs: inner.needs,
      pose(motion, plan, dt) {
        if (!inner.pose) return;
        const before = Kit.rig.copy(motion.pose, borrowPose(motion));
        inner.pose(motion, plan, dt);
        const { pose } = motion;
        for (let bone = 0; bone < plan.boneCount; bone++) {
          if (plan.roles[bone] & mask) continue;
          const vector = bone * VECTOR_STRIDE;
          const quaternion = bone * QUATERNION_STRIDE;
          for (let axis = 0; axis < VECTOR_STRIDE; axis++) {
            pose.translation[vector + axis] = before.translation[vector + axis];
            pose.scale[vector + axis] = before.scale[vector + axis];
          }
          for (let part = 0; part < QUATERNION_STRIDE; part++) pose.rotation[quaternion + part] = before.rotation[quaternion + part];
          pose.uniform[bone] = before.uniform[bone];
        }
        motion.sparesUsed -= 1;
        motion.isWorldCurrent = false;
      },
    });
  };

  /**
   * A stage that runs only where it can, or only while something holds. Given a requirement (from
   * `Kit.body.requirement`, or a spec for one), the question is asked of the plan once and remembered: this is
   * capability gating, and it is how one controller serves bodies of different shapes. Given a function, it is
   * asked every time. A gated stage's needs are no longer needs of the whole.
   * @param {Object|function(MotionState, Object): boolean} condition a requirement, a requirement spec
   *   ({ needs, atLeast }), or a predicate (motion, plan)
   * @param {Stage|Function} part runs when the condition holds
   * @param {Stage|Function} [otherwise] runs when it does not
   * @returns {Stage}
   * @complexity O(1) per call beyond the chosen stage (a requirement costs one map lookup per plan)
   * @example
   * const move = Kit.motion.when({ atLeast: { legs: 2 } }, Kit.gait.walk(), Kit.swim.swim());   // legs walk, the rest swim
   */
  const when = (condition, part, otherwise) => {
    const inner = stage(part);
    const fallback = otherwise ? stage(otherwise) : null;
    /** @type {WeakMap<Object, boolean>} */
    const fitByPlan = new WeakMap();
    const requirement = typeof condition === 'function' ? null : condition.countBits ? condition : Kit.body.requirement(condition);
    const holds =
      typeof condition === 'function'
        ? condition
        : (_motion, plan) => {
            let fit = fitByPlan.get(plan);
            if (fit === undefined) fitByPlan.set(plan, (fit = Kit.body.fits(plan, requirement)));
            return fit;
          };
    const run = (phase) => (motion, plan, dt) => {
      const chosen = holds(motion, plan) ? inner : fallback;
      if (chosen && chosen[phase]) chosen[phase](motion, plan, dt);
    };
    return stage({ name: `when(${inner.name}${fallback ? `, else ${fallback.name}` : ''})`, step: run('step'), pose: run('pose') });
  };

  /**
   * One stage per level of detail: `levels[motion.detail]` runs, and a detail beyond the list runs nothing at
   * all (`advance` then skips the pose and the world transforms too, so a far instance costs a few additions).
   * @param {Array<Stage|Function>} levels the full stage first, cheaper ones after
   * @returns {Stage} needs what its first level needs
   * @complexity O(1) per call beyond the chosen stage
   * @example const walk = Kit.motion.byDetail([fullWalk, swingOnly]);   // detail 2 and up: not evaluated
   */
  const byDetail = (levels) => {
    const stages = levels.map(stage);
    if (!stages.length) fail('byDetail', 'needs at least one stage, for detail 0.');
    const run = (phase) => (motion, plan, dt) => {
      const chosen = stages[motion.detail];
      if (chosen && chosen[phase]) chosen[phase](motion, plan, dt);
    };
    return stage({ name: `byDetail(${stages.map((part) => part.name).join(' | ')})`, step: run('step'), pose: run('pose'), needs: stages[0].needs, detailLevels: stages.length });
  };

  /**
   * Why a plan cannot run a stage, in words, or null when it can: the capability gate with a named refusal.
   * @param {Stage|Function} part
   * @param {Object} plan a `BodyPlan`
   * @param {Object} [rest] its proportioned rest pose, for needs that measure the body (default: the plan's own)
   * @returns {?string} e.g. 'the walk gait cannot move the plan "fish": it lacks legs. This plan has: tail, spine, ...'
   * @complexity O(needs x capabilities); call it at setup, not per frame
   * @example Kit.motion.refusal(Kit.gait.walk(), fishPlan) // 'the walk gait cannot move the plan "fish": it lacks legs. ...'
   */
  const refusal = (part, plan, rest) => {
    const posed = rest || Kit.body.createPose(plan);
    for (const need of stage(part).needs) {
      const lacking = need.requirement ? Kit.body.missing(plan, need.requirement) : [];
      if (lacking.length)
        return `${need.consumer} cannot move the plan "${plan.id}": it lacks ${lacking.join(', ')}. This plan has: ${Kit.body.capabilityNames(plan.capabilities).join(', ') || '(nothing)'}.`;
      const problem = need.check ? need.check(plan, posed) : null;
      if (problem) return `${need.consumer} cannot move the plan "${plan.id}": ${problem}`;
    }
    return null;
  };

  /**
   * Throws unless the plan can run the stage.
   * @param {Stage|Function} part
   * @param {Object} plan a `BodyPlan`
   * @param {Object} [rest] its proportioned rest pose
   * @returns {Object} the plan
   * @throws {Error} with the text of `refusal`
   * @complexity as `refusal`
   * @example Kit.motion.requireFit(Kit.gait.walk(), bake.plan, bake.rest);
   */
  const requireFit = (part, plan, rest) => {
    const problem = refusal(part, plan, rest);
    return problem ? fail('requireFit', problem) : plan;
  };

  // ---- the motion state -----------------------------------------------------------------------------------------------

  /**
   * Makes one instance's motion state. It owns the instance's pose and world buffers (a bake is shared between
   * instances; a pose cannot be), so a renderer reads `motion.world` and nothing else needs allocating.
   * @param {{plan: Object, rest?: Object}} body a bake of kit/body-recipe.js, or any plan with an optional
   *   proportioned rest pose (default: the plan's own rest pose)
   * @param {Stage|Function} controller the stage to run, usually a composition
   * @param {{x?: number, y?: number, z?: number, heading?: number, detail?: number}} [placement] where it starts
   *   (default the origin, facing +Z, full detail)
   * @returns {MotionState}
   * @throws {Error} naming what the plan lacks when it cannot run the controller
   * @complexity O(bones) time and space, once per instance: two transform sets (88 bytes a bone) and a mass per bone
   * @example
   * const motion = Kit.motion.state(bake, Kit.gait.walk(), { x: 2, z: 5 });
   * Kit.motion.advance(motion, dt, x, 0, z, heading);     // every frame, with where the game moved it to
   * Kit.body.debug.draw(context, motion.plan, motion.world, view);
   */
  const state = (body, controller, { x = 0, y = 0, z = 0, heading = 0, detail = 0 } = {}) => {
    if (!body || !body.plan) fail('state', 'needs a body: a bake, or { plan, rest }.');
    const plan = body.plan;
    const rest = body.rest || Kit.body.createPose(plan);
    const stageToRun = stage(controller);
    requireFit(stageToRun, plan, rest);
    const world = Kit.body.worldTransforms(plan, rest, Kit.rig.create(plan.boneCount), x, y, z, heading);
    const masses = new Float32Array(plan.boneCount);
    return {
      plan,
      rest,
      pose: Kit.rig.copy(rest, Kit.rig.create(plan.boneCount)),
      world,
      isWorldCurrent: true,
      controller: stageToRun,
      x,
      y,
      z,
      heading,
      velocityX: 0,
      velocityZ: 0,
      speed: 0,
      forwardSpeed: 0,
      acceleration: 0,
      turnRate: 0,
      time: 0,
      phase: 0,
      detail,
      epoch: 0,
      masses,
      totalMass: Kit.body.boneMasses(plan, world, masses),
      memory: {},
      carry: 0,
      pending: 0,
      spares: [],
      sparesUsed: 0,
    };
  };

  /**
   * A stage's own record on a motion state, made the first time it is asked for. Stages keep their per-instance
   * state here (springs, planted feet, chains), so a state carries exactly what its controller uses.
   * @param {MotionState} motion
   * @param {string} key the stage's name for its record
   * @param {function(MotionState): Object} create makes the record; called once per state
   * @returns {Object}
   * @complexity O(1) after the first call; the first call allocates whatever `create` allocates
   * @example const springs = Kit.motion.memory(motion, 'lean', () => ({ pitch: Kit.dynamics.spring(), roll: Kit.dynamics.spring() }));
   */
  const memory = (motion, key, create) => motion.memory[key] || (motion.memory[key] = create(motion));

  /**
   * Brings `motion.world` up to date with `motion.pose` if a stage has changed the pose since. Stages that read
   * world positions call this first; `advance` calls it last.
   * @param {MotionState} motion
   * @returns {Object} `motion.world`
   * @complexity O(bones) when the world was stale, O(1) otherwise; no allocation
   * @example const hipHeight = Kit.motion.refreshWorld(motion).translation[hip * 3 + 1];
   */
  const refreshWorld = (motion) => {
    if (!motion.isWorldCurrent) Kit.body.worldTransforms(motion.plan, motion.pose, motion.world, motion.x, motion.y, motion.z, motion.heading);
    motion.isWorldCurrent = true;
    return motion.world;
  };

  /**
   * Puts a body somewhere without it having travelled there: speeds are cleared and `epoch` moves on, so stages
   * that hold world positions (planted feet, trailing chains) start again from the new place.
   * @param {MotionState} motion
   * @param {number} x world metres
   * @param {number} y the ground height there
   * @param {number} z
   * @param {number} [heading=motion.heading] radians
   * @returns {MotionState} `motion`
   * @complexity O(1)
   * @example Kit.motion.place(motion, spawn.x, 0, spawn.z, spawn.heading);
   */
  const place = (motion, x, y, z, heading = motion.heading) => {
    Object.assign(motion, { x, y, z, heading, velocityX: 0, velocityZ: 0, speed: 0, forwardSpeed: 0, acceleration: 0, turnRate: 0, pending: 0, isWorldCurrent: false });
    motion.epoch += 1;
    return motion;
  };

  /**
   * One frame of an instance. The caller says where the body is now; the movement between the last call and
   * this one is replayed in fixed steps (`Kit.dynamics.stepsDue`), so the controller's `step` sees the same
   * positions whether the game runs at 20 or 60 frames a second. Then the controller's `pose` writes the pose
   * from the rest pose, and the world transforms are brought up to date.
   * @param {MotionState} motion
   * @param {number} dt seconds since the last call, any frame rate
   * @param {number} [x=motion.x] where the body stands now, world metres
   * @param {number} [y=motion.y] the ground height under it
   * @param {number} [z=motion.z]
   * @param {number} [heading=motion.heading] radians
   * @returns {MotionState} `motion`; read `motion.world` (and `motion.pose`) after
   * @complexity O(steps x step cost + pose cost + bones) time, at most 12 steps; no allocation after an
   *   instance's first frames
   * @example Kit.motion.advance(motion, dt, player.x, groundHeight, player.z, player.heading);
   */
  const advance = (motion, dt, x = motion.x, y = motion.y, z = motion.z, heading = motion.heading) => {
    const { controller, plan } = motion;
    motion.pending += Math.max(0, dt);
    const steps = Kit.dynamics.stepsDue(motion, dt);
    if (steps > 0) {
      const elapsed = motion.pending;
      motion.pending = 0;
      const fromX = motion.x;
      const fromZ = motion.z;
      const fromHeading = motion.heading;
      const turn = shortestTurn(fromHeading, heading);
      const isPlaced = Math.hypot(x - fromX, z - fromZ) > TELEPORT_SPEED * elapsed;
      if (isPlaced) place(motion, x, y, z, heading);
      const rawVelocityX = isPlaced ? 0 : (x - fromX) / elapsed;
      const rawVelocityZ = isPlaced ? 0 : (z - fromZ) / elapsed;
      const rawTurnRate = isPlaced ? 0 : turn / elapsed;
      motion.y = y;
      for (let step = 1; step <= steps; step++) {
        // The caller's move, spread evenly over this call's steps (as `Kit.dynamics.stepChain` spreads its anchor).
        const part = step / steps;
        motion.x = isPlaced ? x : fromX + (x - fromX) * part;
        motion.z = isPlaced ? z : fromZ + (z - fromZ) * part;
        motion.heading = isPlaced ? heading : fromHeading + turn * part;
        motion.velocityX += (rawVelocityX - motion.velocityX) * VELOCITY_BLEND;
        motion.velocityZ += (rawVelocityZ - motion.velocityZ) * VELOCITY_BLEND;
        motion.turnRate += (rawTurnRate - motion.turnRate) * TURN_BLEND;
        motion.speed = Math.hypot(motion.velocityX, motion.velocityZ);
        const forwardSpeed = motion.velocityX * Math.sin(motion.heading) + motion.velocityZ * Math.cos(motion.heading);
        motion.acceleration += ((forwardSpeed - motion.forwardSpeed) / FIXED_STEP - motion.acceleration) * ACCELERATION_BLEND;
        motion.forwardSpeed = forwardSpeed;
        motion.time += FIXED_STEP;
        if (controller.step) controller.step(motion, plan, FIXED_STEP);
      }
    }
    if (motion.detail >= controller.detailLevels) return motion;
    Kit.rig.copy(motion.rest, motion.pose);
    motion.isWorldCurrent = false;
    motion.sparesUsed = 0;
    if (controller.pose) controller.pose(motion, plan, dt);
    refreshWorld(motion);
    return motion;
  };

  /**
   * Advances every live instance of a body store: reads each slot's position, heading and detail columns,
   * advances its motion state, and writes the phase column back.
   * @param {Object} store a `Kit.body.store`
   * @param {Array<?MotionState>} states slot -> its motion state (slots without one are skipped)
   * @param {number} dt seconds since the last call
   * @returns {void}
   * @complexity O(live slots x the cost of `advance`); no allocation
   * @example
   * states[slot] = Kit.motion.state(bakes[crowd.recipe[slot]], controller, { x, z });
   * Kit.motion.advanceStore(crowd, states, dt);      // after the game moved the columns
   */
  const advanceStore = (store, states, dt) => {
    const liveEnd = store.liveEnd();
    for (let slot = 0; slot < liveEnd; slot++) {
      const motion = states[slot];
      if (!store.alive[slot] || !motion) continue;
      motion.detail = store.detail[slot];
      advance(motion, dt, store.positionX[slot], store.positionY[slot], store.positionZ[slot], store.heading[slot]);
      store.phase[slot] = motion.phase;
    }
  };

  // ---- the bone a body is carried by ----------------------------------------------------------------------------------

  /** @type {WeakMap<Object, number>} */
  const carrierByPlan = new WeakMap();

  /**
   * The bone that carries the body: the child of the root bone with the most bones under it (a pelvis, a
   * quadruped's hips, a fish's trunk). Movement shifts and tilts this one bone and everything rides on it.
   * @param {Object} plan a `BodyPlan`
   * @returns {number} bone index; the root itself when it has no children
   * @complexity O(bones) the first time for a plan, O(1) after
   * @example const pelvis = Kit.motion.carrier(bipedPlan);
   */
  const carrier = (plan) => {
    const known = carrierByPlan.get(plan);
    if (known !== undefined) return known;
    let best = 0;
    let bestSize = 0;
    for (let bone = 1; bone < plan.boneCount; bone++) {
      const size = plan.subtreeEnd[bone] - bone;
      if (plan.parent[bone] === 0 && size > bestSize) {
        best = bone;
        bestSize = size;
      }
    }
    carrierByPlan.set(plan, best);
    return best;
  };

  // ---- turning a bone about the body's axes ------------------------------------------------------------------------------

  /** @type {WeakMap<Object, Float32Array>} */
  const framesByRest = new WeakMap();

  /**
   * For every bone of a body, the world rotation of its PARENT at rest: the frame `turnBody` needs to turn a
   * bone about the body's axes whichever way the plan's bones were authored to point.
   * @param {Object} plan a `BodyPlan`
   * @param {Object} rest its proportioned rest pose (a bake's `rest`)
   * @returns {Float32Array} 4 per bone (x, y, z, w); the identity for a root. Shared: do not write it
   * @complexity O(bones) the first time for a rest pose, O(1) after
   * @example const frames = Kit.motion.restFrames(motion.plan, motion.rest);
   */
  const restFrames = (plan, rest) => {
    const known = framesByRest.get(rest);
    if (known) return known;
    const world = Kit.body.worldTransforms(plan, rest, Kit.rig.create(plan.boneCount));
    const frames = new Float32Array(plan.boneCount * QUATERNION_STRIDE);
    for (let bone = 0; bone < plan.boneCount; bone++) {
      const parent = plan.parent[bone];
      if (parent < 0) frames[bone * QUATERNION_STRIDE + QUATERNION_W] = 1;
      else frames.set(world.rotation.subarray(parent * QUATERNION_STRIDE, (parent + 1) * QUATERNION_STRIDE), bone * QUATERNION_STRIDE);
    }
    framesByRest.set(rest, frames);
    return frames;
  };

  const scratchTurn = new Float32Array(QUATERNION_STRIDE);
  /** out = first * second for quaternions given as four numbers each (`out` may hold either). */
  const multiplyInto = (out, outAt, firstX, firstY, firstZ, firstW, secondX, secondY, secondZ, secondW) => {
    out[outAt] = firstW * secondX + firstX * secondW + firstY * secondZ - firstZ * secondY;
    out[outAt + 1] = firstW * secondY - firstX * secondZ + firstY * secondW + firstZ * secondX;
    out[outAt + 2] = firstW * secondZ + firstX * secondY - firstY * secondX + firstZ * secondW;
    out[outAt + QUATERNION_W] = firstW * secondW - firstX * secondX - firstY * secondY - firstZ * secondZ;
  };

  /**
   * Turns a bone by [pitch, yaw, tilt] about the BODY's axes (left, up, forward as they lie when its parent is
   * at rest), on top of the rotation it has. Unlike `Kit.rig.turn`, which turns about the bone's own axes, the
   * same numbers mean the same lean on any plan: a twist of the hips, a nod, a spine leaning into a step.
   * @param {Float32Array} rotation the pose's local rotations, 4 per bone; the bone's is rewritten
   * @param {Float32Array} frames from `Kit.motion.restFrames`
   * @param {number} bone
   * @param {number} pitch radians, positive forwards (a nod down)
   * @param {number} yaw radians, positive towards the body's left
   * @param {number} tilt radians, positive towards the body's left
   * @returns {void}
   * @complexity O(1), no allocation
   * @example Kit.motion.turnBody(motion.pose.rotation, Kit.motion.restFrames(plan, rest), headBone, 0.2, 0, 0);   // a nod
   */
  const turnBody = (rotation, frames, bone, pitch, yaw, tilt) => {
    const sinPitch = Math.sin(pitch / 2);
    const cosPitch = Math.cos(pitch / 2);
    const sinYaw = Math.sin(yaw / 2);
    const cosYaw = Math.cos(yaw / 2);
    // Leaning left is a negative turn about the forward axis.
    const sinRoll = Math.sin(-tilt / 2);
    const cosRoll = Math.cos(-tilt / 2);
    // yaw * (pitch * roll): the body turns, then nods, then tilts, each about the axis the last one left it.
    multiplyInto(scratchTurn, 0, 0, sinYaw, 0, cosYaw, sinPitch * cosRoll, -sinPitch * sinRoll, cosPitch * sinRoll, cosPitch * cosRoll);
    const at = bone * QUATERNION_STRIDE;
    const frameX = frames[at];
    const frameY = frames[at + 1];
    const frameZ = frames[at + 2];
    const frameW = frames[at + QUATERNION_W];
    // In the parent's own frame the turn is (frame^-1 * turn * frame); it goes before the bone's rotation.
    multiplyInto(scratchTurn, 0, -frameX, -frameY, -frameZ, frameW, scratchTurn[0], scratchTurn[1], scratchTurn[2], scratchTurn[QUATERNION_W]);
    multiplyInto(scratchTurn, 0, scratchTurn[0], scratchTurn[1], scratchTurn[2], scratchTurn[QUATERNION_W], frameX, frameY, frameZ, frameW);
    multiplyInto(rotation, at, scratchTurn[0], scratchTurn[1], scratchTurn[2], scratchTurn[QUATERNION_W], rotation[at], rotation[at + 1], rotation[at + 2], rotation[at + QUATERNION_W]);
  };

  // ---- shared stages --------------------------------------------------------------------------------------------------

  /**
   * A stage that tilts the body's carrier bone into what it is doing: forwards when it speeds up, back when it
   * brakes, and into a turn, by a share of the angle that would balance it exactly. Each angle rides a spring,
   * so the tilt has weight. Walkers lean and swimmers bank with the same stage.
   * @param {{pitchShare?: number, pitchPerSpeed?: number, rollShare?: number, mostPitch?: number, mostRoll?: number, stiffness?: number, pitchWeight?: function(MotionState, Object): number}} [options]
   *   see `Kit.motion.LEAN_DEFAULTS`; a share of 0 switches that tilt off. `pitchWeight` (motion, plan) scales
   *   the forward tilt per body: an upright body nods from its hips, a long level one must not
   * @returns {Stage}
   * @complexity O(1) per frame plus two springs' fixed steps; allocates two springs on an instance's first frame
   * @example const bank = Kit.motion.lean({ pitchShare: 0, rollShare: 1.2 });   // a fish rolls into turns and does not nod
   */
  const lean = (options = {}) => {
    const tune = { ...LEAN_DEFAULTS, ...options };
    const createSprings = () => ({ pitch: Kit.dynamics.spring({ stiffness: tune.stiffness }), roll: Kit.dynamics.spring({ stiffness: tune.stiffness }) });
    return stage({
      name: 'lean',
      pose(motion, plan, dt) {
        const springs = memory(motion, 'lean', createSprings);
        const pitchWeight = tune.pitchWeight ? tune.pitchWeight(motion, plan) : 1;
        springs.pitch.target = clamp((Math.atan2(motion.acceleration, GRAVITY) * tune.pitchShare + motion.forwardSpeed * tune.pitchPerSpeed) * pitchWeight, -tune.mostPitch, tune.mostPitch);
        // Turning left (heading growing) needs the body's top to go left, which is a negative turn about its forward axis.
        springs.roll.target = clamp(-Math.atan2(motion.speed * motion.turnRate, GRAVITY) * tune.rollShare, -tune.mostRoll, tune.mostRoll);
        const bone = carrier(plan);
        const { rotation } = motion.pose;
        Kit.rig.turn(rotation, rotation, bone, AXES.x, Kit.dynamics.stepSpring(springs.pitch, dt));
        Kit.rig.turn(rotation, rotation, bone, AXES.z, Kit.dynamics.stepSpring(springs.roll, dt));
        motion.isWorldCurrent = false;
      },
    });
  };

  /** Builds the simulated chains of a `trail` stage for one instance: one per limb that carries the roles. */
  const createTrails = (motion, tune) => {
    const { plan } = motion;
    const world = refreshWorld(motion);
    const chains = Kit.body
      .chains(plan, Kit.body.roleMask([...tune.roles]))
      .filter((joints) => joints.length >= 2 && plan.parent[joints[0]] >= 0)
      .map((joints) => {
        // Link lengths as the proportioned body has them: the distance between neighbouring joints does not change with the pose.
        const lengths = joints.slice(1).map((joint, link) => {
          const from = joints[link] * VECTOR_STRIDE;
          const to = joint * VECTOR_STRIDE;
          return Math.hypot(world.translation[to] - world.translation[from], world.translation[to + 1] - world.translation[from + 1], world.translation[to + 2] - world.translation[from + 2]);
        });
        return {
          joints: Int16Array.from(joints),
          points: Kit.dynamics.chain({ count: joints.length, lengths, gravity: tune.gravity, drag: tune.drag, stiffness: tune.stiffnessScale * Math.sqrt(plan.stiffness[joints[0]]) }),
        };
      });
    return { chains, epoch: -1 };
  };

  /**
   * A stage that lets loose limbs follow the body by simulation: each chain of bones carrying the given roles
   * (a tail by default) is shadowed by a `Kit.dynamics` chain of points dragged from its base, and the bones
   * are aimed along the points with `Kit.reach.follow`. Put it last, after whatever moves the body.
   * @param {{roles?: string[], gravity?: number[], drag?: number, stiffnessScale?: number}} [options] which
   *   limbs (`roles`, default ['tail']; a chain is a run of bones carrying ALL of them), and how they behave:
   *   see `Kit.motion.TRAIL_DEFAULTS`. How strongly a chain keeps its rest direction follows the `stiffness`
   *   hint of its base bone in the plan.
   * @returns {Stage} needs nothing: a body without such limbs is left alone
   * @complexity O(chain points x iterations x fixed steps) per frame; allocates the chains on an instance's first frame
   * @example const wings = Kit.motion.trail({ roles: ['wing'], gravity: [0, -2, 0] });
   */
  const trail = (options = {}) => {
    const tune = { ...TRAIL_DEFAULTS, ...options };
    const key = `trail:${tune.roles.join('+')}`;
    return stage({
      name: key,
      pose(motion, plan, dt) {
        const trails = memory(motion, key, (fresh) => createTrails(fresh, tune));
        const world = refreshWorld(motion);
        const position = world.translation;
        for (let index = 0; index < trails.chains.length; index++) {
          const { joints, points } = trails.chains[index];
          const base = joints[0] * VECTOR_STRIDE;
          const next = joints[1] * VECTOR_STRIDE;
          // The way the limb leaves the body this frame, before it is bent: the chain straightens towards it.
          const awayX = position[next] - position[base];
          const awayY = position[next + 1] - position[base + 1];
          const awayZ = position[next + 2] - position[base + 2];
          if (trails.epoch !== motion.epoch) Kit.dynamics.placeChain(points, position[base], position[base + 1], position[base + 2], awayX, awayY, awayZ);
          Kit.dynamics.stepChain(points, dt, position[base], position[base + 1], position[base + 2], awayX, awayY, awayZ);
          Kit.reach.follow(plan.parent, motion.pose, world, joints, points.positions, plan.jointLimits);
          // `follow` keeps the chain's own joints current; whatever else hangs from them is refreshed here.
          Kit.body.worldTransforms(plan, motion.pose, world, motion.x, motion.y, motion.z, motion.heading, joints[0] + 1, plan.subtreeEnd[joints[0]]);
        }
        trails.epoch = motion.epoch;
      },
    });
  };

  const scratchTip = new Float32Array(VECTOR_STRIDE);
  const scratchArc = new Float32Array(QUATERNION_STRIDE);

  /** The loose chains of a plan: runs of bones whose stiffness hint is low, each from the body outwards. */
  const looseChains = (plan, tune) => {
    const except = Kit.body.roleMask([...tune.except]);
    const isLoose = (bone) => bone > 0 && plan.stiffness[bone] < tune.below && !(plan.roles[bone] & except);
    const firstLooseChild = new Int16Array(plan.boneCount).fill(-1);
    for (let bone = plan.boneCount - 1; bone > 0; bone--) if (isLoose(bone)) firstLooseChild[plan.parent[bone]] = bone;
    const chains = [];
    for (let bone = 1; bone < plan.boneCount; bone++) {
      if (!isLoose(bone) || isLoose(plan.parent[bone])) continue;
      const joints = [];
      for (let link = bone; link >= 0; link = firstLooseChild[link]) joints.push(link);
      chains.push(joints);
    }
    return chains;
  };

  /**
   * The solids loose chains are kept out of: every stiff, thick bone that is not part of a loose chain, as a
   * row of balls from its joint to its end. Returns the bones, how many balls each has, and room for the balls.
   */
  const solidsOf = (plan, world, chains, tune) => {
    const isInChain = new Uint8Array(plan.boneCount);
    chains.forEach((joints) => {
      for (let bone = joints[0]; bone < plan.subtreeEnd[joints[0]]; bone++) isInChain[bone] = 1;
    });
    const bones = [];
    const perBone = [];
    for (let bone = 1; bone < plan.boneCount; bone++) {
      if (isInChain[bone] || plan.girth[bone] < tune.solidGirth || plan.stiffness[bone] < tune.below) continue;
      Kit.body.tailPosition(plan, world, bone, scratchTip);
      const at = bone * VECTOR_STRIDE;
      const length = Math.hypot(scratchTip[0] - world.translation[at], scratchTip[1] - world.translation[at + 1], scratchTip[2] - world.translation[at + 2]);
      bones.push(bone);
      perBone.push(Math.max(1, Math.min(tune.mostBallsPerBone, Math.round(length / (plan.girth[bone] * tune.solidShare)))));
    }
    const count = perBone.reduce((sum, each) => sum + each, 0);
    return { bones: Int16Array.from(bones), perBone: Uint8Array.from(perBone), radius: Float32Array.from(bones, (bone) => (plan.girth[bone] / 2) * tune.solidShare), count, balls: new Float32Array(count * Kit.dynamics.BALL_STRIDE) };
  };

  /** Writes where a body's solids are now into their balls: evenly along each bone, joint to end. */
  const writeBalls = (plan, world, solids) => {
    const { balls } = solids;
    let ball = 0;
    for (let index = 0; index < solids.bones.length; index++) {
      const bone = solids.bones[index];
      const at = bone * VECTOR_STRIDE;
      Kit.body.tailPosition(plan, world, bone, scratchTip);
      for (let part = 0; part < solids.perBone[index]; part++, ball++) {
        const along = (part + 0.5) / solids.perBone[index];
        const ballAt = ball * Kit.dynamics.BALL_STRIDE;
        for (let axis = 0; axis < VECTOR_STRIDE; axis++) balls[ballAt + axis] = world.translation[at + axis] + (scratchTip[axis] - world.translation[at + axis]) * along;
        balls[ballAt + VECTOR_STRIDE] = solids.radius[index];
      }
    }
  };

  /** Builds the simulated chains of a `loose` stage for one instance: a point per joint, and one more for the end of the last bone. */
  const createLoose = (motion, tune) => {
    const { plan } = motion;
    const world = refreshWorld(motion);
    const between = (from, to) =>
      Math.hypot(world.translation[to] - world.translation[from], world.translation[to + 1] - world.translation[from + 1], world.translation[to + 2] - world.translation[from + 2]);
    const found = looseChains(plan, tune);
    const solids = solidsOf(plan, world, found, tune);
    const chains = found
      .map((joints) => {
        const last = joints[joints.length - 1];
        Kit.body.tailPosition(plan, world, last, scratchTip);
        const tipLength = Math.hypot(
          scratchTip[0] - world.translation[last * VECTOR_STRIDE],
          scratchTip[1] - world.translation[last * VECTOR_STRIDE + 1],
          scratchTip[2] - world.translation[last * VECTOR_STRIDE + 2]
        );
        const hasTip = tipLength > tune.shortestTip;
        const lengths = [...joints.slice(1).map((joint, link) => between(joints[link] * VECTOR_STRIDE, joint * VECTOR_STRIDE)), ...(hasTip ? [tipLength] : [])];
        if (!lengths.length) return null;
        return {
          joints: Int16Array.from(joints),
          hasTip,
          points: Kit.dynamics.chain({
            count: lengths.length + 1,
            lengths,
            gravity: tune.gravity,
            drag: tune.drag,
            stiffness: tune.stiffnessScale * Math.sqrt(plan.stiffness[joints[0]]),
            balls: solids.count,
            thickness: plan.girth[last] * tune.thickness,
          }),
          tipLength,
          collides: null,
        };
      })
      .filter(Boolean);
    // A chain collides with every solid except the ones it is worn round: where its rest points already are.
    writeBalls(plan, world, solids);
    chains.forEach((chain) => {
      const used = [];
      for (let ball = 0; ball < solids.count; ball++) {
        const ballAt = ball * Kit.dynamics.BALL_STRIDE;
        const isWornRound = Array.from(chain.joints.slice(1))
          .map((joint) => world.translation.subarray(joint * VECTOR_STRIDE, joint * VECTOR_STRIDE + VECTOR_STRIDE))
          .concat(chain.hasTip ? [Kit.body.tailPosition(plan, world, chain.joints[chain.joints.length - 1], [0, 0, 0])] : [])
          .some((point) => Math.hypot(point[0] - solids.balls[ballAt], point[1] - solids.balls[ballAt + 1], point[2] - solids.balls[ballAt + 2]) < solids.balls[ballAt + VECTOR_STRIDE] * tune.wornWithin);
        if (!isWornRound) used.push(ball);
      }
      chain.collides = Int16Array.from(used);
    });
    return { chains, solids, epoch: -1 };
  };

  /**
   * A stage that lets everything a plan declares loose follow the body by simulation: hair strands, plaits, a
   * cloak, floppy ears - any bone whose `stiffness` hint is low (`Kit.motion.LOOSE_DEFAULTS.below`; the plan
   * default is stiff) and that no other stage moves. Each run of such bones is shadowed by a `Kit.dynamics`
   * chain dragged from its base, with a point at the END of the last bone too, so a single loose bone (a
   * cloak panel) swings like a pendulum. The chain steps on the fixed clock, so it behaves the same at any
   * frame rate. Its points are kept above the ground the body stands on and out of the body's own solids (every
   * stiff, thick bone, as a row of balls), except the solids a part is worn round. Put it last, after whatever
   * moves the body.
   * @param {{below?: number, except?: string[], gravity?: number[], drag?: number, stiffnessScale?: number}} [options]
   *   see `Kit.motion.LOOSE_DEFAULTS`
   * @returns {Stage} needs nothing: a body with nothing loose is left alone
   * @complexity O(chain points x iterations x fixed steps) per frame; allocates the chains on an instance's first frame
   * @example const walk = Kit.motion.sequence(Kit.gait.plant(), Kit.motion.trail(), Kit.motion.loose());
   */
  const loose = (options = {}) => {
    const tune = { ...LOOSE_DEFAULTS, ...options };
    return stage({
      name: 'loose',
      pose(motion, plan, dt) {
        const record = memory(motion, 'loose', (fresh) => createLoose(fresh, tune));
        if (!record.chains.length) return;
        const world = refreshWorld(motion);
        const position = world.translation;
        // The body's solids as they are this frame, before anything loose is moved; the floor is where the body stands.
        writeBalls(plan, world, record.solids);
        for (let index = 0; index < record.chains.length; index++) {
          const { joints, points, hasTip, collides } = record.chains[index];
          const stride = Kit.dynamics.BALL_STRIDE;
          for (let ball = 0; ball < collides.length; ball++) for (let part = 0; part < stride; part++) points.balls[ball * stride + part] = record.solids.balls[collides[ball] * stride + part];
          points.ballCount = collides.length;
          points.floor = motion.y;
          const last = joints[joints.length - 1];
          const base = joints[0] * VECTOR_STRIDE;
          // The way the chain leaves the body this frame, before it is bent: towards its second joint, or the end of its only bone.
          if (joints.length > 1) scratchTip.set(position.subarray(joints[1] * VECTOR_STRIDE, joints[1] * VECTOR_STRIDE + VECTOR_STRIDE));
          else Kit.body.tailPosition(plan, world, last, scratchTip);
          const awayX = scratchTip[0] - position[base];
          const awayY = scratchTip[1] - position[base + 1];
          const awayZ = scratchTip[2] - position[base + 2];
          if (record.epoch !== motion.epoch) Kit.dynamics.placeChain(points, position[base], position[base + 1], position[base + 2], awayX, awayY, awayZ);
          Kit.dynamics.stepChain(points, dt, position[base], position[base + 1], position[base + 2], awayX, awayY, awayZ);
          Kit.reach.follow(plan.parent, motion.pose, world, joints, points.positions, plan.jointLimits);
          if (hasTip) {
            // The last bone has no child joint to aim: turn it so its own end lies towards the chain's last point.
            const lastAt = last * VECTOR_STRIDE;
            const tipAt = (points.count - 1) * VECTOR_STRIDE;
            if (joints.length > 1) Kit.rig.worldTransforms(plan.parent, motion.pose, world, 0, 0, 0, 0, last, last + 1);
            Kit.body.tailPosition(plan, world, last, scratchTip);
            Kit.rig.shortestArc(
              scratchTip[0] - position[lastAt],
              scratchTip[1] - position[lastAt + 1],
              scratchTip[2] - position[lastAt + 2],
              points.positions[tipAt] - position[lastAt],
              points.positions[tipAt + 1] - position[lastAt + 1],
              points.positions[tipAt + 2] - position[lastAt + 2],
              scratchArc
            );
            Kit.rig.turnWorld(plan.parent, motion.pose, world, last, scratchArc);
            Kit.reach.clamp(motion.pose, last, plan.jointLimits);
          }
          Kit.body.worldTransforms(plan, motion.pose, world, motion.x, motion.y, motion.z, motion.heading, joints[0] + 1, plan.subtreeEnd[joints[0]]);
        }
        record.epoch = motion.epoch;
      },
    });
  };

  // ---- a course: a body steered by a table ---------------------------------------------------------------------------

  /**
   * @typedef {Object} CourseLeg
   * @property {number} seconds how long the leg lasts
   * @property {number} speed metres per second to settle at (0 stands still)
   * @property {number} [turn=0] radians per second to settle at, positive towards the left
   */

  /**
   * @typedef {Object} Course
   * Plain state; read `x`, `z`, `heading` after `drive`.
   * @property {ReadonlyArray<CourseLeg>} legs
   * @property {number} x world metres
   * @property {number} z
   * @property {number} heading radians
   * @property {number} speed metres per second now
   * @property {number} turn radians per second now
   * @property {number} leg index of the leg being travelled
   * @property {number} legTime seconds into that leg
   * @property {number} acceleration how fast speed changes, metres per second squared
   * @property {number} turnAcceleration how fast the turn rate changes, radians per second squared
   * @property {number} carry seconds not yet simulated (owned by `drive`)
   */

  /**
   * Makes a course: a looping table of legs, each a speed and a turn rate held for some seconds, with the body's
   * speed and turn easing from one to the next. It is the smallest thing that starts, stops and turns, for
   * demos, benchmarks and tests of movement; a game steers its own bodies.
   * @param {CourseLeg[]} legs
   * @param {{acceleration?: number, turnAcceleration?: number, x?: number, z?: number, heading?: number}} [options]
   *   see `Kit.motion.COURSE_DEFAULTS`
   * @returns {Course}
   * @throws {Error} for an empty table or a leg without a positive duration
   * @complexity O(legs)
   * @example
   * const course = Kit.motion.course([{ seconds: 3, speed: 1.4 }, { seconds: 2, speed: 1.4, turn: 0.8 }, { seconds: 1.5, speed: 0 }]);
   * Kit.motion.drive(course, dt);
   * Kit.motion.advance(motion, dt, course.x, 0, course.z, course.heading);
   */
  const course = (legs, options = {}) => {
    if (!Array.isArray(legs) || !legs.length) fail('course', 'needs at least one leg: { seconds, speed, turn }.');
    legs.forEach((leg, index) => {
      if (!(leg.seconds > 0) || !Number.isFinite(leg.speed)) fail('course', `leg ${index} needs positive \`seconds\` and a number \`speed\`, got ${JSON.stringify(leg)}.`);
    });
    const tune = { ...COURSE_DEFAULTS, ...options };
    return {
      legs: Object.freeze(legs.map((leg) => Object.freeze({ turn: 0, ...leg }))),
      x: tune.x,
      z: tune.z,
      heading: tune.heading,
      speed: 0,
      turn: 0,
      leg: 0,
      legTime: 0,
      acceleration: tune.acceleration,
      turnAcceleration: tune.turnAcceleration,
      carry: 0,
    };
  };

  /** Moves a value towards a target by at most `most`. */
  const approach = (value, target, most) => value + clamp(target - value, -most, most);

  /**
   * Advances a course by `dt` seconds on the fixed clock, so it traces the same line at any frame rate.
   * @param {Course} route
   * @param {number} dt seconds since the last call
   * @returns {Course} `route`
   * @complexity O(dt / FIXED_STEP) time, at most 12 steps; no allocation
   * @example Kit.motion.drive(course, dt);
   */
  const drive = (route, dt) => {
    for (let step = Kit.dynamics.stepsDue(route, dt); step > 0; step--) {
      const leg = route.legs[route.leg];
      route.speed = approach(route.speed, leg.speed, route.acceleration * FIXED_STEP);
      route.turn = approach(route.turn, leg.turn, route.turnAcceleration * FIXED_STEP);
      route.heading += route.turn * FIXED_STEP;
      route.x += Math.sin(route.heading) * route.speed * FIXED_STEP;
      route.z += Math.cos(route.heading) * route.speed * FIXED_STEP;
      route.legTime += FIXED_STEP;
      if (route.legTime >= leg.seconds) {
        route.legTime -= leg.seconds;
        route.leg = (route.leg + 1) % route.legs.length;
      }
    }
    return route;
  };

  Kit.motion = {
    GRAVITY,
    SMOOTHING,
    LEAN_DEFAULTS,
    TRAIL_DEFAULTS,
    LOOSE_DEFAULTS,
    COURSE_DEFAULTS,
    stage,
    sequence,
    blend,
    layer,
    when,
    byDetail,
    refusal,
    requireFit,
    state,
    memory,
    refreshWorld,
    place,
    advance,
    advanceStore,
    carrier,
    restFrames,
    turnBody,
    lean,
    trail,
    loose,
    course,
    drive,
    shortestTurn,
  };
})();
