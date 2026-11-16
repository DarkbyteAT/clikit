// Kit touch: the pure models behind finger-skill moments. No DOM, no THREE - runs in node (see tools/test-kit.js).
//
//   trace  - follow a moving Kit.path target: catch meter, line tension, streak, accuracy   trace.step(state, dt, pointer)
//   stroke - a drawn polyline with a minimum step and a length budget (ropes, routes, ink)  stroke.add(point)
//   lasso  - which targets a drawn loop encloses                                            lasso(points, targets)
//   zone   - a sweet spot with graded bands around it                                       zone(0.6, [0.07, 0.18]).grade(v)
//   sweep  - a needle that swings 0..1 over time (stop-in-the-zone meters)                  sweep(0.5)(t)
//   walker - tap-to-walk: a point that walks to a target at a speed, inside a constraint    walker.goTo(p); walker.step(dt)
//
// Owns: the rules and numbers of these interactions. Does not own: input events, drawing or sound. Feed a model pointer
// positions and dt, then draw what it returns. A hold-and-release gauge is a zone plus any Kit.curve ramp of the held time.
(() => {
  const { clamp, damp } = Kit.math;
  const distance = Kit.line.dist;

  /**
   * @typedef {{ x: number, y: number }} Point
   *
   * @typedef {Object} TraceOptions
   * @property {(time: number) => Point} target  Kit.path the player has to follow.
   * @property {number} tolerance        Largest pointer-to-target distance that still counts as on target (path units).
   * @property {number} fillSeconds      Seconds on target, at boost 1, that fill the meter from empty.
   * @property {number} [drainRate=0.5]  Meter lost per second off target, as a fraction of the fill rate.
   * @property {number} [strainRate=0.4] Tension gained per second while touching but off target (tension runs 0..1).
   * @property {number} [looseRate=strainRate] Tension gained per second while not touching at all.
   * @property {number} [recoverRate=0.2] Tension shed per second on target.
   * @property {number} [smoothing=Infinity] Rate (1/s) at which the reported target chases its path point. A finite rate
   *                                     turns the teleports of a darting path into quick, readable bursts.
   * @property {(streakSeconds: number) => number} [boost] Fill-rate multiplier from the unbroken seconds on target.
   * @property {(state: TraceState) => number} [pace] Path-time multiplier, read every step (tiring, panicking targets).
   *
   * @typedef {Object} TraceState
   * @property {number} pathTime    Time fed to the target path (warped by pace).
   * @property {Point} target       Where the target is now (after smoothing).
   * @property {number} elapsed     Scored seconds so far.
   * @property {number} onSeconds   Scored seconds spent on target.
   * @property {number} streak      Unbroken seconds on target right now.
   * @property {number} progress    The catch meter, 0..1.
   * @property {number} tension     The fail meter, 0..1.
   * @property {boolean} isOnTarget Was the pointer within tolerance on the last step?
   * @property {null | 'won' | 'lost'} outcome  'won' when progress reaches 1, 'lost' when tension reaches 1.
   */

  /**
   * A trace-accuracy meter over a moving target: the model of "keep your finger on the swimming fish".
   * The state is plain data and every function returns a new state, so a fight can be simulated, replayed or tested.
   * @param {TraceOptions} options
   * @returns {{ start: (pathTime?: number) => TraceState, drift: (state: TraceState, dt: number) => TraceState,
   *             step: (state: TraceState, dt: number, pointer: Point | null) => TraceState,
   *             accuracy: (state: TraceState) => number }}
   * @example
   *   const trace = Kit.touch.trace({ target: Kit.path.lissajous(1, 2), tolerance: 0.3, fillSeconds: 4 });
   *   let fight = trace.start();
   *   fight = trace.step(fight, dt, isTouching ? { x, y } : null);   // every frame; drift() while the player gets ready
   *   if (fight.outcome === 'won') award(trace.accuracy(fight));
   */
  function trace(options) {
    const { target, tolerance, fillSeconds, drainRate = 0.5, strainRate = 0.4, recoverRate = 0.2, smoothing = Infinity } = options;
    const looseRate = options.looseRate === undefined ? strainRate : options.looseRate;
    const boost = options.boost || (() => 1);
    const pace = options.pace || (() => 1);

    /**
     * Advance the target only: the path keeps moving but nothing is scored (count-ins, grace periods).
     * @param {TraceState} state
     * @param {number} dt  Seconds.
     * @returns {TraceState}
     */
    const drift = (state, dt) => {
      const pathTime = state.pathTime + dt * pace(state);
      const goal = target(pathTime);
      const chase = (from, to) => (smoothing === Infinity ? to : damp(from, to, smoothing, dt));
      return { ...state, pathTime, target: { x: chase(state.target.x, goal.x), y: chase(state.target.y, goal.y) } };
    };

    /**
     * Advance the target and score this slice of time against the pointer.
     * @param {TraceState} state
     * @param {number} dt  Seconds.
     * @param {Point | null} pointer  Where the player is pointing, in the target's units; null when not touching.
     * @returns {TraceState}
     */
    const step = (state, dt, pointer) => {
      if (state.outcome) return state; // a finished fight stays finished
      const moved = drift(state, dt);
      const isOnTarget = !!pointer && distance(pointer, moved.target) <= tolerance;
      const streak = isOnTarget ? state.streak + dt : 0;
      const fillPerSecond = isOnTarget ? boost(streak) / fillSeconds : -drainRate / fillSeconds;
      const strainPerSecond = isOnTarget ? -recoverRate : pointer ? strainRate : looseRate;
      const progress = clamp(state.progress + fillPerSecond * dt);
      const tension = clamp(state.tension + strainPerSecond * dt);
      // Winning is checked first: filling the meter on the same step the line would give out still lands the catch.
      const outcome = progress >= 1 ? 'won' : tension >= 1 ? 'lost' : null;
      return { ...moved, elapsed: state.elapsed + dt, onSeconds: state.onSeconds + (isOnTarget ? dt : 0), streak, progress, tension, isOnTarget, outcome };
    };

    return {
      start: (pathTime = 0) => ({ pathTime, target: target(pathTime), elapsed: 0, onSeconds: 0, streak: 0, progress: 0, tension: 0, isOnTarget: false, outcome: null }),
      drift,
      step,
      /**
       * Share of the scored time spent on target (0 before anything was scored).
       * @param {TraceState} state
       * @returns {number} 0..1
       */
      accuracy: (state) => (state.elapsed > 0 ? state.onSeconds / state.elapsed : 0),
    };
  }

  /**
   * A polyline drawn by a finger, with a minimum spacing between points and a total length budget.
   * @param {{ minStep?: number, maxLength?: number }} [options] minStep: points closer than this to the last one are
   *        skipped (same units as the points); maxLength: the budget, after which add() refuses.
   * @returns {{ points: Point[], length: number, add: (point: Point) => boolean, isSpent: () => boolean,
   *             remaining: () => number, reset: () => void }} remaining() is the unused share of the budget, 1..0.
   * @example
   *   const rope = Kit.touch.stroke({ minStep: 0.15, maxLength: 7 });
   *   if (rope.add(pointer)) redraw(rope.points);
   *   if (rope.isSpent()) closeTheNet();
   */
  function stroke({ minStep = 0, maxLength = Infinity } = {}) {
    const api = {
      points: [],
      length: 0,
      add(point) {
        const last = api.points[api.points.length - 1];
        const gap = last ? distance(last, point) : 0;
        if (api.isSpent() || (last && gap < minStep)) return false;
        api.points.push({ x: point.x, y: point.y });
        api.length += gap;
        return true;
      },
      isSpent: () => api.length >= maxLength,
      remaining: () => (maxLength === Infinity ? 1 : clamp(1 - api.length / maxLength)),
      reset() {
        api.points.length = 0;
        api.length = 0;
      },
    };
    return api;
  }

  /**
   * Score a drawn loop: which targets does it enclose? The loop is shut by joining its two ends, so the player does
   * not have to land exactly on the starting point; closeTolerance says how big a gap that join may bridge.
   * @template T
   * @param {Point[]} points  The drawn line, in the same space as the targets.
   * @param {T[]} targets     Anything with a position.
   * @param {{ closeTolerance?: number, at?: (target: T) => Point }} [options] closeTolerance: largest end-to-end gap
   *        still treated as a loop (default: any); at: where a target is (default: the target itself).
   * @returns {{ isClosed: boolean, inside: T[], centre: Point }} centre is the mean of the drawn points.
   * @complexity O(p x t) time for p drawn points and t targets (one point-in-polygon test per target), O(t) space.
   * @example
   *   const { inside } = Kit.touch.lasso(rope.points, fish, { closeTolerance: 1.5, at: (f) => f.position });
   */
  function lasso(points, targets, { closeTolerance = Infinity, at = (target) => target } = {}) {
    const centre = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
    const isClosed = Kit.line.closed(points, closeTolerance);
    return { isClosed, inside: isClosed ? targets.filter((target) => Kit.line.contains(points, at(target))) : [], centre };
  }

  /**
   * A sweet spot on a 0..1 gauge with graded bands around it (watering to the right level, stopping a needle).
   * @param {number} centre         Where the sweet spot is.
   * @param {number[]} halfWidths   Half-width of each band, best (narrowest) first, e.g. [0.07, 0.18].
   * @returns {{ centre: number, bands: { from: number, to: number, grade: number }[], grade: (value: number) => number }}
   *          grade(value) is halfWidths.length + 1 inside the best band, one less per band outwards, and 1 outside all.
   * @complexity grade: O(b) for b bands (two or three in practice).
   * @example
   *   const sweet = Kit.touch.zone(0.6, [0.07, 0.18]);
   *   sweet.grade(0.62) === 3;  sweet.grade(0.75) === 2;  sweet.grade(0.1) === 1;
   */
  function zone(centre, halfWidths) {
    const best = halfWidths.length + 1;
    const bands = halfWidths.map((halfWidth, index) => ({ from: centre - halfWidth, to: centre + halfWidth, grade: best - index }));
    return {
      centre,
      bands,
      grade(value) {
        const hit = bands.find((band) => value >= band.from && value <= band.to);
        return hit ? hit.grade : 1;
      },
    };
  }

  /**
   * A needle that swings smoothly between 0 and 1: the moving part of a stop-in-the-zone meter.
   * @param {number} cyclesPerSecond  Full there-and-back swings per second.
   * @param {number} [phase=0]        Starting offset in cycles (0 starts mid-gauge, moving up).
   * @returns {(seconds: number) => number} Needle position 0..1 at a time.
   */
  const sweep = (cyclesPerSecond, phase = 0) => (seconds) => 0.5 + 0.5 * Math.sin((seconds * cyclesPerSecond + phase) * Kit.math.TAU);

  /**
   * Tap-to-walk movement on a plane: a point that walks toward a target at a fixed speed and gives up when blocked.
   * @param {Object} options
   * @param {Point} options.at             Starting position.
   * @param {number} options.speed         Units per second.
   * @param {(point: Point) => Point} [options.constrain] Pulls a point back into the walkable area (default: anywhere).
   * @param {number} [options.arriveWithin=0.06] Distance at which the walker counts as having arrived.
   * @param {number} [options.stuckSeconds=0.35] Seconds of being held back by `constrain` before it stops trying.
   * @returns {{ position: Point, target: Point, goTo: (point: Point) => void, stop: () => void,
   *             step: (dt: number) => { isMoving: boolean, heading: number, hasArrived: boolean } }}
   *          heading is the sign of the x movement this step (-1, 0, 1), for sprite facing; hasArrived is true only on
   *          the step that reaches the target.
   * @example
   *   const walker = Kit.touch.walker({ at: { x: 0, y: 0 }, speed: 4, constrain: keepOnShore });
   *   walker.goTo(tappedPoint);
   *   const { isMoving, heading } = walker.step(dt);   // then copy walker.position onto the sprite
   */
  function walker({ at, speed, constrain = (point) => point, arriveWithin = 0.06, stuckSeconds = 0.35 }) {
    const STUCK_SHARE = 0.25; // moving less than this share of the intended step means something is in the way
    const position = { x: at.x, y: at.y }, target = { x: at.x, y: at.y };
    let blockedFor = 0;
    const api = {
      position,
      target,
      goTo(point) {
        Object.assign(target, constrain({ x: point.x, y: point.y }));
        blockedFor = 0;
      },
      stop: () => api.goTo(position),
      step(dt) {
        const gap = distance(position, target);
        if (gap <= arriveWithin) return { isMoving: false, heading: 0, hasArrived: false };
        const stride = Math.min(gap, speed * dt);
        const next = constrain({ x: position.x + ((target.x - position.x) / gap) * stride, y: position.y + ((target.y - position.y) / gap) * stride });
        const heading = Math.sign(next.x - position.x);
        blockedFor = distance(position, next) < stride * STUCK_SHARE ? blockedFor + dt : 0;
        Object.assign(position, next);
        const hasArrived = distance(position, target) <= arriveWithin;
        if (blockedFor > stuckSeconds) api.stop(); // sliding along an edge it cannot cross: settle where it is, without "arriving"
        return { isMoving: true, heading, hasArrived };
      },
    };
    return api;
  }

  Kit.touch = { trace, stroke, lasso, zone, sweep, walker };
})();
