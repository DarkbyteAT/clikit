// Kit ballistics: the maths of thrown things. Pure: plain { x, y, z } objects in, plain data out; no DOM, THREE or cannon
// (unit-tested in tools/test-kit.js).
//
//   direction   - unit aim vector from a yaw and a loft angle:    Kit.ballistics.direction(0.2, 0.5)
//   trace       - the flight path a physics body will follow:     Kit.ballistics.trace({ origin, velocity, acceleration, stopWhen })
//   sphereTouchesBox - cheap obstacle test for a trace:           Kit.ballistics.sphereTouchesBox(point, radius, box)
//   blastKick   - velocity change an explosion gives a point:     Kit.ballistics.blastKick(centre, point, { radius, kick, lift })
//
// Owns: aim geometry, trajectory prediction and explosion falloff. Does not own: bodies, collisions or rendering
// (Kit.physics applies blastKick to cannon bodies; the game decides how to draw a trace).
(() => {
  /**
   * @typedef {{ x: number, y: number, z: number }} Vector A point, velocity or acceleration in world units (metres, seconds).
   * @typedef {{ min: Vector, max: Vector }} Box An axis-aligned box given by its two opposite corners.
   */

  /** Shortest distance at which a blast still has a direction; closer than this the point is "at" the centre. */
  const BLAST_EPSILON = 1e-6;

  /**
   * Unit vector for an aim given as two angles. Yaw 0 looks down -z (away from a camera on +z), like the kit's stages.
   * @param {number} yaw Radians around the vertical axis; positive turns toward +x.
   * @param {number} loft Radians above the horizon.
   * @returns {Vector} Unit direction.
   */
  const direction = (yaw, loft) => ({
    x: Math.sin(yaw) * Math.cos(loft),
    y: Math.sin(loft),
    z: -Math.cos(yaw) * Math.cos(loft),
  });

  /**
   * One semi-implicit Euler step (velocity first, then position): the integrator cannon.js and most game physics use, so
   * a trace built from it lands exactly where an undamped body will.
   * @param {{ position: Vector, velocity: Vector }} state
   * @param {Vector} acceleration Units per second squared (gravity plus any wind).
   * @param {number} step Seconds.
   * @returns {{ position: Vector, velocity: Vector }} The next state (a new object).
   */
  const advance = ({ position, velocity }, acceleration, step) => {
    const next = { x: velocity.x + acceleration.x * step, y: velocity.y + acceleration.y * step, z: velocity.z + acceleration.z * step };
    return { velocity: next, position: { x: position.x + next.x * step, y: position.y + next.y * step, z: position.z + next.z * step } };
  };

  /**
   * Predicts a flight path by stepping the launch state until `stopWhen` says the point has hit something.
   * @param {object} options
   * @param {Vector} options.origin Launch point.
   * @param {Vector} options.velocity Launch velocity, units per second.
   * @param {Vector} [options.acceleration] Constant acceleration; defaults to gravity of -20 on y (the Kit.physics default).
   * @param {number} [options.step] Seconds per step; match the physics step (1/60) for an exact preview.
   * @param {number} [options.maxSteps] Upper bound on steps, so a shot into the sky still ends.
   * @param {(point: Vector, index: number) => boolean} [options.stopWhen] True when the point is inside an obstacle.
   * @returns {{ points: Vector[], end: Vector, isBlocked: boolean }} `points` are the free-flight positions after each step,
   *   `end` is the blocked point (or the last free one when nothing was hit), `isBlocked` says which.
   * @complexity O(maxSteps) calls of `stopWhen` and O(maxSteps) points of memory; with an obstacle list the caller's
   *   `stopWhen` makes it O(maxSteps x obstacles).
   * @example
   * const flight = Kit.ballistics.trace({ origin, velocity, stopWhen: (point) => point.y < ballRadius });
   * flight.points.filter((_, index) => index % 3 === 0).forEach(placeDot);
   */
  const trace = ({ origin, velocity, acceleration = { x: 0, y: -20, z: 0 }, step = 1 / 60, maxSteps = 120, stopWhen = () => false }) => {
    const points = [];
    let state = { position: origin, velocity };
    // A plain loop, not a reduce: the walk has to stop early at the first blocked point.
    for (let index = 0; index < maxSteps; index++) {
      state = advance(state, acceleration, step);
      if (stopWhen(state.position, index)) return { points, end: state.position, isBlocked: true };
      points.push(state.position);
    }
    return { points, end: points.length ? points[points.length - 1] : origin, isBlocked: false };
  };

  /**
   * Whether a sphere overlaps an axis-aligned box, tested as "centre inside the box grown by the radius". That rounds the
   * box corners outward slightly, which is the right bias for a preview: it never draws a path through a corner.
   * @param {Vector} point Sphere centre.
   * @param {number} radius Sphere radius.
   * @param {Box} box
   * @returns {boolean}
   * @complexity O(1): three axis comparisons.
   */
  const sphereTouchesBox = (point, radius, box) =>
    ['x', 'y', 'z'].every((axis) => point[axis] > box.min[axis] - radius && point[axis] < box.max[axis] + radius);

  /**
   * Velocity change an explosion gives something at `point`: pushed straight away from the centre, strongest at the centre
   * and fading linearly to nothing at `radius`, plus an optional upward share so debris arcs instead of sliding.
   * @param {Vector} centre Where the blast is.
   * @param {Vector} point Where the affected thing is.
   * @param {object} blast
   * @param {number} blast.radius Reach in world units; at or beyond it nothing happens.
   * @param {number} blast.kick Speed change at the centre, units per second.
   * @param {number} [blast.lift] Extra upward speed as a fraction of the falloff-scaled kick (0.3 = 30%).
   * @returns {Vector | null} The velocity to add, or null when the point is out of reach.
   */
  const blastKick = (centre, point, { radius, kick, lift = 0 }) => {
    const offset = { x: point.x - centre.x, y: point.y - centre.y, z: point.z - centre.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    if (distance >= radius) return null;
    const strength = kick * (1 - distance / radius);
    // Dead centre has no "away" direction: push it straight up rather than divide by zero.
    const away = distance < BLAST_EPSILON ? { x: 0, y: 1, z: 0 } : { x: offset.x / distance, y: offset.y / distance, z: offset.z / distance };
    return { x: away.x * strength, y: away.y * strength + strength * lift, z: away.z * strength };
  };

  Kit.ballistics = { direction, advance, trace, sphereTouchesBox, blastKick };
})();
