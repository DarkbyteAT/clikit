/**
 * Kit dynamics: the two small simulations behind secondary motion - a damped spring (a value that chases a
 * target with weight: body bob, lean, a camera, a bar that overshoots) and a chain of points held together by
 * fixed lengths (a tail, a rope, hair, a cape's edge). Both advance on a fixed clock inside, so the result is
 * the same at 20 frames a second as at 60.
 *
 * Owns:  `Kit.dynamics.FIXED_STEP`, `stepsDue` (the fixed-step accumulator), `criticalDamping`, `spring` /
 *        `stepSpring`, `chain` / `placeChain` / `stepChain`.
 * Does not own: rigid bodies, collisions or constraints between bodies (kit/physics.js wraps cannon.js for
 *        those, with its own accumulator at 1/60 s), smoothing without momentum (`Kit.math.damp`), or what the
 *        numbers drive: nothing here knows about bodies or rendering. To turn a chain's points into joint
 *        rotations use `Kit.reach.follow`.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Seconds per simulation step. 120 Hz keeps a stiff spring stable and divides evenly into 60 and 30 fps frames. */
  const FIXED_STEP = 1 / 120;
  /** Most steps taken in one update (0.1 s of simulation). A longer frame slows the simulation instead of spiralling. */
  const MOST_STEPS_PER_UPDATE = 12;
  /**
   * The integrator is stable while (natural frequency x step) stays well under 2; a spring stiffer than this
   * fraction of that bound is refused at creation rather than left to explode in play.
   */
  const STABILITY_LIMIT = 1;
  const VECTOR_STRIDE = 3;
  const SPRING_DEFAULTS = Object.freeze({ stiffness: 120, mass: 1 });
  const CHAIN_DEFAULTS = Object.freeze({ gravity: Object.freeze([0, -9.8, 0]), drag: 3, stiffness: 0, iterations: 4, grip: 0.5 });

  /**
   * How many fixed steps are due after `dt` more seconds, for anything that must simulate on a fixed clock.
   * The remainder is kept in `carrier.carry` for the next call, so no time is lost between frames.
   * @param {{carry: number}} carrier any object with a numeric `carry` (seconds not yet simulated)
   * @param {number} dt seconds since the last call
   * @returns {number} whole steps to run now, 0 to 12; time beyond 12 steps is dropped
   * @complexity O(1), no allocation
   * @example for (let step = Kit.dynamics.stepsDue(world, dt); step > 0; step--) simulate(Kit.dynamics.FIXED_STEP);
   */
  const stepsDue = (carrier, dt) => {
    carrier.carry += Math.max(0, dt);
    // The small epsilon keeps a frame of exactly n steps from rounding down to n - 1.
    const due = Math.floor(carrier.carry / FIXED_STEP + 1e-9);
    const taken = Math.min(due, MOST_STEPS_PER_UPDATE);
    carrier.carry = due > MOST_STEPS_PER_UPDATE ? 0 : Math.max(0, carrier.carry - taken * FIXED_STEP);
    return taken;
  };

  /**
   * The damping that settles a spring fastest without overshoot.
   * @param {number} stiffness spring constant (force per unit of stretch)
   * @param {number} [mass=1]
   * @returns {number} damping coefficient (force per unit of speed): 2 x sqrt(stiffness x mass)
   * @complexity O(1)
   * @example Kit.dynamics.spring({ stiffness: 200, damping: 0.4 * Kit.dynamics.criticalDamping(200) })   // bouncy
   */
  const criticalDamping = (stiffness, mass = 1) => 2 * Math.sqrt(stiffness * mass);

  /**
   * @typedef {Object} Spring
   * Plain state; change `target` (and `stiffness`, `damping`) whenever you like.
   * @property {number} value where the spring is now
   * @property {number} velocity units per second
   * @property {number} target where it is pulled to
   * @property {number} stiffness force per unit of stretch
   * @property {number} damping force per unit of speed
   * @property {number} mass
   * @property {number} carry seconds not yet simulated (owned by `stepSpring`)
   */

  /**
   * Makes a damped spring: one number with momentum. For a point in space use one spring per axis.
   * @param {{value?: number, velocity?: number, target?: number, stiffness?: number, damping?: number, mass?: number}} [options]
   *   starts at rest at `value` (default 0) with `target` = value; stiffness defaults to 120, mass to 1 and
   *   damping to critical for those
   * @returns {Spring}
   * @throws {Error} when the spring is too stiff for the fixed step to simulate stably
   * @complexity O(1)
   * @example
   * const bob = Kit.dynamics.spring({ stiffness: 180 });
   * bob.target = footIsDown ? -0.04 : 0;
   * hipHeight += Kit.dynamics.stepSpring(bob, dt);
   */
  const spring = ({ value = 0, velocity = 0, target = value, stiffness = SPRING_DEFAULTS.stiffness, mass = SPRING_DEFAULTS.mass, damping = criticalDamping(stiffness, mass) } = {}) => {
    const stiffest = (STABILITY_LIMIT / FIXED_STEP) ** 2 * mass;
    if (!(stiffness >= 0 && mass > 0) || stiffness > stiffest)
      throw new Error(
        `Kit.dynamics.spring: stiffness ${stiffness} with mass ${mass} cannot be simulated stably at ${Math.round(1 / FIXED_STEP)} steps a second. Keep stiffness between 0 and ${stiffest} (or raise the mass).`
      );
    return { value, velocity, target, stiffness, damping, mass, carry: 0 };
  };

  /**
   * Advances a spring by `dt` seconds in fixed steps (semi-implicit Euler: velocity first, then position, which
   * keeps energy bounded where the plain method gains it).
   * @param {Spring} state
   * @param {number} dt seconds since the last call, any frame rate
   * @returns {number} the spring's new value
   * @complexity O(dt / FIXED_STEP) time, at most 12 steps; no allocation
   * @example sprite.y = Kit.dynamics.stepSpring(bounce, dt);
   */
  const stepSpring = (state, dt) => {
    for (let step = stepsDue(state, dt); step > 0; step--) {
      const acceleration = (state.stiffness * (state.target - state.value) - state.damping * state.velocity) / state.mass;
      state.velocity += acceleration * FIXED_STEP;
      state.value += state.velocity * FIXED_STEP;
    }
    return state.value;
  };

  /**
   * @typedef {Object} PointChain
   * @property {number} count points in the chain; point 0 is pinned to the anchor
   * @property {Float32Array} positions 3 per point, world units: read these after `stepChain`
   * @property {Float32Array} previous 3 per point: where each point was one step ago (its velocity, in effect)
   * @property {Float32Array} lengths 1 per link: the fixed distance between point i and point i + 1
   * @property {number[]} gravity acceleration, world units per second squared
   * @property {number} drag how fast motion dies away, per second (0 = never)
   * @property {number} stiffness how strongly each link straightens towards the one before it, per second (0 = limp rope)
   * @property {number} iterations constraint passes per step: more keeps the lengths tighter under fast motion
   * @property {number} carry seconds not yet simulated (owned by `stepChain`)
   * @property {number} floor the height no point may go below (-Infinity: no floor); the owner sets it
   * @property {number} thickness how far a point's surface is from its centre: what keeps it off the floor and the balls
   * @property {Float32Array} balls solids the points are pushed out of: x, y, z, radius each; the owner fills
   *   them every frame (a body's bones as balls) and sets `ballCount`
   * @property {number} ballCount how many of `balls` are in use
   * @property {number} grip 0..1: how much of a point's sliding a touch takes away each step (cloth drags on what it lies on)
   */

  /**
   * Makes a chain of points joined by links of fixed length, hanging from an anchor: Verlet integration (each
   * point's velocity is implied by where it was a step ago) with position-based length constraints.
   * @param {{count: number, lengths: (number|ArrayLike<number>), gravity?: ReadonlyArray<number>, drag?: number, stiffness?: number, iterations?: number, balls?: number, thickness?: number, grip?: number}} options
   *   `count` points (2 or more); `lengths` one number for every link or a list of count - 1; gravity defaults
   *   to [0, -9.8, 0], drag to 3, stiffness to 0, iterations to 4; `balls` is room for that many solids to
   *   collide with (default 0), `thickness` and `grip` as on `PointChain`
   * @returns {PointChain} laid out straight down from the origin; call `placeChain` to put it where it belongs
   * @throws {Error} for fewer than 2 points or the wrong number of lengths
   * @complexity O(count) time and space
   * @example
   * const tail = Kit.dynamics.chain({ count: 4, lengths: 0.2, stiffness: 8 });
   * Kit.dynamics.placeChain(tail, hip.x, hip.y, hip.z, 0, 0, -1);
   */
  const chain = ({ count, lengths, gravity = CHAIN_DEFAULTS.gravity, drag = CHAIN_DEFAULTS.drag, stiffness = CHAIN_DEFAULTS.stiffness, iterations = CHAIN_DEFAULTS.iterations, balls = 0, thickness = 0, grip = CHAIN_DEFAULTS.grip }) => {
    if (!Number.isInteger(count) || count < 2) throw new Error(`Kit.dynamics.chain: a chain needs 2 or more points, got ${count}.`);
    const linkLengths = typeof lengths === 'number' ? new Float32Array(count - 1).fill(lengths) : Float32Array.from(lengths || []);
    if (linkLengths.length !== count - 1)
      throw new Error(`Kit.dynamics.chain: ${count} points have ${count - 1} links, but ${linkLengths.length} lengths were given. Pass one number or a list of ${count - 1}.`);
    const state = {
      count,
      positions: new Float32Array(count * VECTOR_STRIDE),
      previous: new Float32Array(count * VECTOR_STRIDE),
      lengths: linkLengths,
      gravity: [...gravity],
      drag,
      stiffness,
      iterations,
      carry: 0,
      floor: -Infinity,
      thickness,
      balls: new Float32Array(balls * BALL_STRIDE),
      ballCount: 0,
      grip,
    };
    return placeChain(state, 0, 0, 0, 0, -1, 0);
  };

  /**
   * Lays a chain out straight from an anchor along a direction and stops it dead: use it when the chain is
   * made, and whenever its owner teleports.
   * @param {PointChain} state
   * @param {number} anchorX where point 0 goes, world units
   * @param {number} anchorY
   * @param {number} anchorZ
   * @param {number} directionX which way the chain runs from the anchor (any length but zero)
   * @param {number} directionY
   * @param {number} directionZ
   * @returns {PointChain} `state`
   * @complexity O(count) time, no allocation
   * @example Kit.dynamics.placeChain(tail, hip.x, hip.y, hip.z, 0, 0, -1);
   */
  const placeChain = (state, anchorX, anchorY, anchorZ, directionX, directionY, directionZ) => {
    const length = Math.hypot(directionX, directionY, directionZ) || 1;
    let along = 0;
    for (let point = 0; point < state.count; point++) {
      const at = point * VECTOR_STRIDE;
      state.positions[at] = anchorX + (directionX / length) * along;
      state.positions[at + 1] = anchorY + (directionY / length) * along;
      state.positions[at + 2] = anchorZ + (directionZ / length) * along;
      along += point < state.count - 1 ? state.lengths[point] : 0;
    }
    state.previous.set(state.positions);
    state.carry = 0;
    return state;
  };

  /** Numbers per ball of a chain's `balls`: x, y, z, radius. */
  const BALL_STRIDE = 4;

  /** Pushes a chain's free points out of its floor and its balls; a point that touched loses some of its slide. */
  const collideChain = (state) => {
    const { positions, previous, balls, count, thickness } = state;
    const lowest = state.floor + thickness;
    for (let point = 1; point < count; point++) {
      const at = point * VECTOR_STRIDE;
      let hasTouched = false;
      if (positions[at + 1] < lowest) {
        positions[at + 1] = lowest;
        hasTouched = true;
      }
      for (let ball = 0; ball < state.ballCount; ball++) {
        const ballAt = ball * BALL_STRIDE;
        const offsetX = positions[at] - balls[ballAt];
        const offsetY = positions[at + 1] - balls[ballAt + 1];
        const offsetZ = positions[at + 2] - balls[ballAt + 2];
        const clear = balls[ballAt + VECTOR_STRIDE] + thickness;
        const distanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
        if (distanceSquared >= clear * clear || distanceSquared === 0) continue;
        const push = clear / Math.sqrt(distanceSquared);
        positions[at] = balls[ballAt] + offsetX * push;
        positions[at + 1] = Math.max(lowest, balls[ballAt + 1] + offsetY * push);
        positions[at + 2] = balls[ballAt + 2] + offsetZ * push;
        hasTouched = true;
      }
      // A link is long: its middle is kept out of the balls too, by swinging its far end (twice the push, as a lever).
      const before = at - VECTOR_STRIDE;
      for (let ball = 0; ball < state.ballCount; ball++) {
        const ballAt = ball * BALL_STRIDE;
        const offsetX = (positions[at] + positions[before]) / 2 - balls[ballAt];
        const offsetY = (positions[at + 1] + positions[before + 1]) / 2 - balls[ballAt + 1];
        const offsetZ = (positions[at + 2] + positions[before + 2]) / 2 - balls[ballAt + 2];
        const clear = balls[ballAt + VECTOR_STRIDE] + thickness;
        const distanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
        if (distanceSquared >= clear * clear || distanceSquared === 0) continue;
        const push = (2 * (clear - Math.sqrt(distanceSquared))) / Math.sqrt(distanceSquared);
        positions[at] += offsetX * push;
        positions[at + 1] = Math.max(lowest, positions[at + 1] + offsetY * push);
        positions[at + 2] += offsetZ * push;
        hasTouched = true;
      }
      if (hasTouched) for (let axis = 0; axis < VECTOR_STRIDE; axis++) previous[at + axis] += (positions[at + axis] - previous[at + axis]) * state.grip;
    }
  };

  /** One fixed step of a chain whose point 0 has already been moved to this step's anchor. */
  const stepChainOnce = (state, directionX, directionY, directionZ) => {
    const { positions, previous, lengths, count } = state;
    const keep = Math.exp(-state.drag * FIXED_STEP);
    const straighten = 1 - Math.exp(-state.stiffness * FIXED_STEP);
    const stepSquared = FIXED_STEP * FIXED_STEP;
    // Hot path: index loops over the points, no allocation.
    for (let point = 1; point < count; point++) {
      const at = point * VECTOR_STRIDE;
      for (let axis = 0; axis < VECTOR_STRIDE; axis++) {
        const now = positions[at + axis];
        positions[at + axis] = now + (now - previous[at + axis]) * keep + state.gravity[axis] * stepSquared;
        previous[at + axis] = now;
      }
    }
    for (let pass = 0; pass < state.iterations; pass++) {
      for (let point = 1; point < count; point++) {
        const at = point * VECTOR_STRIDE;
        const before = at - VECTOR_STRIDE;
        if (straighten > 0) {
          // Where this point would be if its link carried straight on from the link before (or from the anchor's direction).
          let aheadX = point === 1 ? directionX : positions[before] - positions[before - VECTOR_STRIDE];
          let aheadY = point === 1 ? directionY : positions[before + 1] - positions[before - VECTOR_STRIDE + 1];
          let aheadZ = point === 1 ? directionZ : positions[before + 2] - positions[before - VECTOR_STRIDE + 2];
          const aheadLength = Math.hypot(aheadX, aheadY, aheadZ);
          if (aheadLength > 0) {
            const reach = (lengths[point - 1] / aheadLength) * (straighten / state.iterations);
            aheadX *= reach;
            aheadY *= reach;
            aheadZ *= reach;
            const blend = straighten / state.iterations;
            positions[at] += positions[before] * blend + aheadX - positions[at] * blend;
            positions[at + 1] += positions[before + 1] * blend + aheadY - positions[at + 1] * blend;
            positions[at + 2] += positions[before + 2] * blend + aheadZ - positions[at + 2] * blend;
          }
        }
        // Length constraint: the anchor never moves; other links share the correction between their two ends.
        const offsetX = positions[at] - positions[before];
        const offsetY = positions[at + 1] - positions[before + 1];
        const offsetZ = positions[at + 2] - positions[before + 2];
        const distance = Math.hypot(offsetX, offsetY, offsetZ) || 1;
        const error = (distance - lengths[point - 1]) / distance;
        const shareBefore = point === 1 ? 0 : 0.5;
        positions[before] += offsetX * error * shareBefore;
        positions[before + 1] += offsetY * error * shareBefore;
        positions[before + 2] += offsetZ * error * shareBefore;
        positions[at] -= offsetX * error * (1 - shareBefore);
        positions[at + 1] -= offsetY * error * (1 - shareBefore);
        positions[at + 2] -= offsetZ * error * (1 - shareBefore);
      }
      if (state.ballCount > 0 || state.floor > -Infinity) collideChain(state);
    }
  };

  /**
   * Advances a chain by `dt` seconds in fixed steps, dragging point 0 to a new anchor. The anchor is moved
   * there in equal parts across the steps of this call, so a low frame rate does not turn into a yank.
   * @param {PointChain} state
   * @param {number} dt seconds since the last call, any frame rate
   * @param {number} anchorX where point 0 is now, world units
   * @param {number} anchorY
   * @param {number} anchorZ
   * @param {number} [directionX=0] which way the first link should point when `stiffness` is above 0 (the
   *   direction of whatever the chain grows from); all zeros leaves the first link free
   * @param {number} [directionY=0]
   * @param {number} [directionZ=0]
   * @returns {Float32Array} `state.positions`
   * @complexity O(steps x iterations x count) time, at most 12 steps; no allocation
   * @example
   * Kit.dynamics.stepChain(tail, dt, hip.x, hip.y, hip.z, 0, 0, -1);
   * Kit.reach.follow(plan.parent, pose, world, tailBones, tail.positions);   // points -> bone rotations
   */
  const stepChain = (state, dt, anchorX, anchorY, anchorZ, directionX = 0, directionY = 0, directionZ = 0) => {
    const steps = stepsDue(state, dt);
    const { positions } = state;
    const fromX = positions[0];
    const fromY = positions[1];
    const fromZ = positions[2];
    for (let step = 1; step <= steps; step++) {
      const part = step / steps;
      positions[0] = fromX + (anchorX - fromX) * part;
      positions[1] = fromY + (anchorY - fromY) * part;
      positions[2] = fromZ + (anchorZ - fromZ) * part;
      stepChainOnce(state, directionX, directionY, directionZ);
    }
    return positions;
  };

  Kit.dynamics = { BALL_STRIDE, FIXED_STEP, MOST_STEPS_PER_UPDATE, SPRING_DEFAULTS, CHAIN_DEFAULTS, stepsDue, criticalDamping, spring, stepSpring, chain, placeChain, stepChain };
})();
