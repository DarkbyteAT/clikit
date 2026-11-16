/**
 * Kit flight: the flight of a spinning ball. Gravity, air drag, the sideways force of spin (the Magnus effect:
 * what bends a curled shot), wind, bounces off the ground and off round bars (posts, rims, rails), all on a
 * fixed step, as plain numbers.
 *
 * Owns:  `Kit.flight.ball` (a ball's state), `Kit.flight.step` (advance it, reporting what it struck),
 *        `Kit.flight.trace` (the path a ball will take, for an aim preview or a headless rule),
 *        `Kit.flight.crossing` (where a step crossed a plane, for goal lines and nets), `Kit.flight.bar`
 *        (a round obstacle between two points) and the default air and ground (`AIR`, `GROUND`).
 * Does not own: rigid bodies that push each other (Kit.physics, on cannon.js), simple unspun arcs
 *        (`Kit.ballistics.trace`), what a bounce means in a game, or drawing.
 *
 * Why not cannon.js: a body there has no drag or lift, tunnels through a thin post at shot speed unless the
 * whole world is sub-stepped, and cannot be copied to ask "where would this shot go". One ball against a few
 * fixed bars is a dozen lines of exact maths, runs in node, and is the same code for the preview and the shot.
 *
 * Conventions: metres, seconds; +Y up. Spin is an angular velocity vector in radians per second (right-hand
 * rule), and the bend is `lift x (spin x velocity)`: spin about +Y bends a ball flying along -Z towards -X.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** @typedef {{x: number, y: number, z: number}} Vector */

  /**
   * @typedef {Object} FlightBall
   * @property {Vector} position centre of the ball
   * @property {Vector} velocity metres per second
   * @property {Vector} spin angular velocity, radians per second
   * @property {number} radius metres
   * @property {number} seconds flight time so far
   * @property {boolean} isResting true once it lies still on the ground
   */

  /**
   * @typedef {Object} FlightAir
   * @property {number} gravity metres per second squared, downwards
   * @property {number} drag per metre: the ball loses `drag x speed` of its speed each second
   * @property {number} lift how strongly spin bends the path: acceleration = lift x (spin x velocity)
   * @property {number} spinDecay share of the spin lost per second
   * @property {Vector} wind velocity of the air, metres per second
   */

  /**
   * @typedef {Object} FlightGround
   * @property {number} height y of the surface
   * @property {number} bounce share of the vertical speed kept by a bounce, 0..1
   * @property {number} grip share of the sideways speed lost at each bounce, 0..1
   * @property {number} roll deceleration of a rolling ball, metres per second squared
   * @property {number} settleSpeed a bounce slower than this (m/s, vertical) becomes a roll
   */

  /**
   * @typedef {Object} FlightBar
   * @property {string} id what a hit reports
   * @property {Vector} from one end of the axis
   * @property {Vector} to the other end (equal to `from` for a ball-shaped obstacle)
   * @property {number} radius metres
   * @property {number} bounce share of the speed into the bar that comes back out, 0..1
   */

  /** @typedef {{kind: ('ground'|'bar'), id: string, speed: number, point: Vector}} FlightHit `speed`: metres per second into the surface */

  /** Air for a football: a 25 m/s shot loses about a tenth of its speed over 11 metres, and a hard side spin bends it about a metre. */
  const AIR = Object.freeze({ gravity: 9.81, drag: 0.012, lift: 0.0045, spinDecay: 0.25, wind: Object.freeze({ x: 0, y: 0, z: 0 }) });
  /** Short grass. */
  const GROUND = Object.freeze({ height: 0, bounce: 0.55, grip: 0.25, roll: 2.2, settleSpeed: 0.9 });
  /** A step never moves the ball further than this share of its radius, so a thin bar cannot be skipped over. */
  const MOST_TRAVEL_PER_STEP = 0.5;
  /** A ball slower than this (m/s) on the ground has stopped. */
  const REST_SPEED = 0.05;
  const TRACE_DEFAULTS = Object.freeze({ step: 1 / 120, maxSteps: 360 });

  const fail = (where, message) => {
    throw new Error(`Kit.flight.${where}: ${message}`);
  };
  const vectorOf = (given = {}) => ({ x: given.x || 0, y: given.y || 0, z: given.z || 0 });

  /**
   * Makes a ball.
   * @param {{position?: Vector, velocity?: Vector, spin?: Vector, radius?: number}} [given] radius defaults to 0.11 (a football)
   * @returns {FlightBall}
   * @throws {Error} when the radius is not a positive number
   * @example const ball = Kit.flight.ball({ position: { x: 0, y: 0.11, z: 0 }, velocity: { x: 2, y: 6, z: -22 }, spin: { x: 0, y: 40, z: 0 } });
   */
  const ball = ({ position, velocity, spin, radius = 0.11 } = {}) => {
    if (!(radius > 0)) fail('ball', `radius must be a positive number of metres, got ${radius}.`);
    return { position: vectorOf(position), velocity: vectorOf(velocity), spin: vectorOf(spin), radius, seconds: 0, isResting: false };
  };

  /**
   * Makes a round bar (a capsule) for `step` to bounce the ball off.
   * @param {string} id what a hit on it reports
   * @param {Vector} from one end of its axis
   * @param {Vector} to the other end
   * @param {number} radius metres
   * @param {number} [bounce=0.6] share of the speed into the bar that comes back out
   * @returns {FlightBar}
   * @example const leftPost = Kit.flight.bar('post', { x: -3.66, y: 0, z: 0 }, { x: -3.66, y: 2.44, z: 0 }, 0.06);
   */
  const bar = (id, from, to, radius, bounce = 0.6) => Object.freeze({ id, from: Object.freeze(vectorOf(from)), to: Object.freeze(vectorOf(to)), radius, bounce });

  /** Applies drag, spin lift and gravity to the velocity, then moves the ball: one semi-implicit Euler step. */
  const integrate = (state, dt, air) => {
    const { position, velocity, spin } = state;
    // Drag and lift act on the ball's speed through the air, so wind pushes a slow ball more than a fast one.
    const airX = velocity.x - air.wind.x;
    const airY = velocity.y - air.wind.y;
    const airZ = velocity.z - air.wind.z;
    const drag = air.drag * Math.hypot(airX, airY, airZ);
    velocity.x += (-drag * airX + air.lift * (spin.y * airZ - spin.z * airY)) * dt;
    velocity.y += (-drag * airY + air.lift * (spin.z * airX - spin.x * airZ) - air.gravity) * dt;
    velocity.z += (-drag * airZ + air.lift * (spin.x * airY - spin.y * airX)) * dt;
    position.x += velocity.x * dt;
    position.y += velocity.y * dt;
    position.z += velocity.z * dt;
    const keptSpin = Math.max(0, 1 - air.spinDecay * dt);
    spin.x *= keptSpin;
    spin.y *= keptSpin;
    spin.z *= keptSpin;
  };

  /** Bounces or rolls the ball on the ground; returns the hit when it bounced, else null. @returns {?FlightHit} */
  const meetGround = (state, dt, ground) => {
    const { position, velocity } = state;
    const floor = ground.height + state.radius;
    if (position.y > floor) return null;
    position.y = floor;
    const speedIn = -velocity.y;
    if (speedIn > ground.settleSpeed) {
      velocity.y = speedIn * ground.bounce;
      velocity.x *= 1 - ground.grip;
      velocity.z *= 1 - ground.grip;
      return { kind: 'ground', id: 'ground', speed: speedIn, point: { x: position.x, y: ground.height, z: position.z } };
    }
    // Too slow to bounce: it rolls, slowed at a steady rate until it stops.
    velocity.y = 0;
    const speed = Math.hypot(velocity.x, velocity.z);
    const kept = speed > 0 ? Math.max(0, speed - ground.roll * dt) / speed : 0;
    velocity.x *= kept;
    velocity.z *= kept;
    state.isResting = speed * kept < REST_SPEED;
    return null;
  };

  /** Bounces the ball off one bar when they overlap; returns the hit, else null. @returns {?FlightHit} */
  const meetBar = (state, obstacle) => {
    const { position, velocity } = state;
    const { from, to } = obstacle;
    const axisX = to.x - from.x;
    const axisY = to.y - from.y;
    const axisZ = to.z - from.z;
    const axisSquared = axisX * axisX + axisY * axisY + axisZ * axisZ;
    // The nearest point of the axis to the ball's centre (the end itself for a ball-shaped obstacle).
    const along = axisSquared > 0 ? Math.min(1, Math.max(0, ((position.x - from.x) * axisX + (position.y - from.y) * axisY + (position.z - from.z) * axisZ) / axisSquared)) : 0;
    const nearX = from.x + axisX * along;
    const nearY = from.y + axisY * along;
    const nearZ = from.z + axisZ * along;
    const offsetX = position.x - nearX;
    const offsetY = position.y - nearY;
    const offsetZ = position.z - nearZ;
    const distance = Math.hypot(offsetX, offsetY, offsetZ);
    const reach = state.radius + obstacle.radius;
    if (distance >= reach || distance === 0) return null;
    const normalX = offsetX / distance;
    const normalY = offsetY / distance;
    const normalZ = offsetZ / distance;
    const speedIn = -(velocity.x * normalX + velocity.y * normalY + velocity.z * normalZ);
    // Moved out to the surface whatever its direction, so it cannot sink in; only an approaching ball is turned.
    position.x = nearX + normalX * reach;
    position.y = nearY + normalY * reach;
    position.z = nearZ + normalZ * reach;
    if (speedIn <= 0) return null;
    const turn = speedIn * (1 + obstacle.bounce);
    velocity.x += normalX * turn;
    velocity.y += normalY * turn;
    velocity.z += normalZ * turn;
    return { kind: 'bar', id: obstacle.id, speed: speedIn, point: { x: nearX + normalX * obstacle.radius, y: nearY + normalY * obstacle.radius, z: nearZ + normalZ * obstacle.radius } };
  };

  /**
   * Advances a ball by `dt` seconds, in as many equal sub-steps as keep it from skipping over a bar.
   * The ball is changed in place.
   * @param {FlightBall} state
   * @param {number} dt seconds, more than 0
   * @param {{air?: FlightAir, ground?: ?FlightGround, bars?: FlightBar[]}} [world] `ground: null` for none
   * @returns {FlightHit[]} what it struck during the step, in order (empty for free flight)
   * @complexity O(substeps x bars), substeps = speed x dt / (radius / 2); allocates only when something is hit
   * @example
   * const hits = Kit.flight.step(ball, 1 / 60, { bars: [leftPost, rightPost, crossbar] });
   * if (hits.some((hit) => hit.id === 'post')) playClang();
   */
  const step = (state, dt, { air = AIR, ground = GROUND, bars = [] } = {}) => {
    /** @type {FlightHit[]} */
    const hits = [];
    if (state.isResting) return hits;
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    const substeps = Math.max(1, Math.ceil((speed * dt) / (state.radius * MOST_TRAVEL_PER_STEP)));
    const slice = dt / substeps;
    // Hot path: index loops, no allocation unless something is hit.
    for (let index = 0; index < substeps && !state.isResting; index++) {
      integrate(state, slice, air);
      for (let each = 0; each < bars.length; each++) {
        const hit = meetBar(state, bars[each]);
        if (hit) hits.push(hit);
      }
      const bounce = ground ? meetGround(state, slice, ground) : null;
      if (bounce) hits.push(bounce);
    }
    state.seconds += dt;
    return hits;
  };

  /**
   * A copy of a ball that can be flown without changing the original.
   * @param {FlightBall} state
   * @returns {FlightBall}
   */
  const copy = (state) => ({ ...state, position: { ...state.position }, velocity: { ...state.velocity }, spin: { ...state.spin } });

  /**
   * The path a ball will take: its position after each step, until it stops, `stopWhen` says so or `maxSteps` pass.
   * The ball given is not changed.
   * @param {FlightBall} state
   * @param {{air?: FlightAir, ground?: ?FlightGround, bars?: FlightBar[], step?: number, maxSteps?: number,
   *   stopWhen?: function(FlightBall, FlightHit[], FlightBall): boolean}} [options] `stopWhen(now, hits, before)`
   *   is asked after every step; defaults: 1/120 s steps, 360 of them (three seconds)
   * @returns {{points: Vector[], hits: FlightHit[], end: FlightBall}} `end`: the ball as it was when the trace stopped
   * @complexity O(steps x the cost of `step`) time, O(steps) space
   * @example
   * const path = Kit.flight.trace(ball, { bars, stopWhen: (now) => now.position.z < goalLineZ });
   * drawDots(path.points);
   */
  const trace = (state, options = {}) => {
    const { step: seconds = TRACE_DEFAULTS.step, maxSteps = TRACE_DEFAULTS.maxSteps, stopWhen = () => false } = options;
    const flying = copy(state);
    const points = [];
    /** @type {FlightHit[]} */
    const hits = [];
    for (let index = 0; index < maxSteps && !flying.isResting; index++) {
      const before = copy(flying);
      const stepHits = step(flying, seconds, options);
      hits.push(...stepHits);
      points.push({ ...flying.position });
      if (stopWhen(flying, stepHits, before)) break;
    }
    return { points, hits, end: flying };
  };

  /**
   * Where the straight move from one point to another crossed a plane of constant x, y or z.
   * @param {Vector} before where the move began
   * @param {Vector} after where it ended
   * @param {('x'|'y'|'z')} axis
   * @param {number} value the plane's place on that axis
   * @returns {?Vector} the crossing point, or null when both ends are on the same side (a point on the plane counts as the far side)
   * @complexity O(1)
   * @example const over = Kit.flight.crossing(previous, ball.position, 'z', goalLineZ);   // null until the step that crosses the line
   */
  const crossing = (before, after, axis, value) => {
    const [fromSide, toSide] = [before[axis] - value, after[axis] - value];
    if (fromSide > 0 === toSide > 0) return null;
    const share = fromSide / (fromSide - toSide);
    return { x: before.x + (after.x - before.x) * share, y: before.y + (after.y - before.y) * share, z: before.z + (after.z - before.z) * share };
  };

  Kit.flight = { AIR, GROUND, ball, bar, step, trace, copy, crossing };
})();
