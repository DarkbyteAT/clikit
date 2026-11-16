/**
 * Kit flow: how things change over time.
 *
 *   fsm        - states with enter / update / exit:    flow.go('fishing', { spot })
 *   spawnTable - "what appears now":                   table.pick(t) from rows with { from, until, weight }
 *   path       - composable 2D motion (t) => { x, y }: enemies, fish, moving platforms, camera rails
 *   envelope   - a number fired to a peak, held, then eased back to zero: camera pushes, recoil, glow pulses
 *
 * Owns:  the time-driven models above.
 * Does not own: the clock that drives them (Kit.clock in core.js, the frame loop in shell.js) or
 *        anything visual. A path only returns numbers; the game decides what moves along it.
 *
 * No DOM, no THREE: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { TAU, wrap, clamp, lerp, ease } = Kit.math;

  // ---- fsm -----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} FsmState
   * Every hook is optional.
   * @property {function(*, ?string): void} [enter] called with (data passed to go, previous state name)
   * @property {function(number, number): void} [update] called with (dt, seconds spent in this state)
   * @property {function(string): void} [exit] called with the next state's name
   */

  /**
   * Creates a finite state machine.
   * @param {Object<string, FsmState>} states state name to hooks
   * @param {string} [initial] state to enter straight away
   * @param {*} [data] passed to the initial state's `enter`
   * @returns {{state: ?string, time: number, is: function(string): boolean, go: function(string, *=): void,
   *   update: function(number): void, on: function(function({state: string, prev: ?string}): void): function(): boolean}}
   *   `state` and `time` (seconds in the current state) are read-only.
   * @throws {Error} from `go` when the state does not exist
   * @example
   * const flow = Kit.fsm({
   *   aim:  { update: (dt) => trackFinger(dt) },
   *   fly:  { enter: (shot) => launch(shot), update: (dt, t) => t > 3 && flow.go('aim') },
   * }, 'aim');
   * flow.go('fly', { power: 0.8 });
   */
  Kit.fsm = (states, initial, data) => {
    let currentName = null;
    let secondsInState = 0;
    const bus = Kit.bus();
    const machine = {
      get state() {
        return currentName;
      },
      get time() {
        return secondsInState;
      },
      is: (stateName) => currentName === stateName,
      go(nextName, enterData) {
        if (!states[nextName]) throw new Error(`Kit.fsm: no state "${nextName}"`);
        const previousName = currentName;
        // Exit runs before the switch and enter after it, so each hook sees its own state as current.
        if (previousName && states[previousName].exit) states[previousName].exit(nextName);
        currentName = nextName;
        secondsInState = 0;
        if (states[nextName].enter) states[nextName].enter(enterData, previousName);
        bus.emit('change', { state: nextName, prev: previousName });
      },
      update(dt) {
        secondsInState += dt;
        const current = states[currentName];
        if (current && current.update) current.update(dt, secondsInState);
      },
      on: (listener) => bus.on('change', listener),
    };
    if (initial) machine.go(initial, data);
    return machine;
  };

  // ---- spawnTable ----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} SpawnRow
   * Any extra fields are yours (enemy type, speed, colour).
   * @property {number} [weight=1] relative chance while active; 0 never spawns
   * @property {number} [from=0] first t (inclusive) at which the row is active
   * @property {number} [until=Infinity] t (exclusive) at which it stops being active
   */

  const isActiveAt = (row, t) => t >= (row.from || 0) && t < (row.until === undefined ? Infinity : row.until);
  // Unlike Kit.math.pickWeighted's default, an explicit weight of 0 is respected here.
  const spawnWeightOf = (row) => (row.weight === undefined ? 1 : row.weight);

  /**
   * Creates a spawn table: which rows may appear at a given time, level or depth `t`.
   * @param {SpawnRow[]} rows
   * @param {Object} [options]
   * @param {SpawnRow[]} [options.intro=[]] rows that `next` hands out first, in order, to teach patterns
   * @returns {{rows: SpawnRow[], served: number, next: function(number): ?SpawnRow, active: function(number): SpawnRow[],
   *   pick: function(number): ?SpawnRow}} `pick` is a weighted random active row (null when none is active);
   *   `next` is the intro rows in order, then `pick`; `served` counts intro rows handed out so far.
   * @complexity `active`, `pick` and `next` are O(rows) time per call; `active` allocates the filtered list
   * @example
   * const spawns = Kit.spawnTable([{ id: 'grunt' }, { id: 'brute', from: 30, weight: 0.3 }], { intro: [{ id: 'grunt' }] });
   * const enemyType = spawns.next(elapsedSeconds);
   */
  Kit.spawnTable = (rows, { intro = [] } = {}) => ({
    rows,
    served: 0,
    next(t) {
      if (this.served < intro.length) return intro[this.served++];
      return this.pick(t);
    },
    active: (t) => rows.filter((row) => isActiveAt(row, t)),
    pick(t) {
      const activeRows = this.active(t);
      return activeRows.length ? Kit.math.pickWeighted(activeRows, spawnWeightOf) : null;
    },
  });

  // ---- path ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {{x: number, y: number}} Point
   */

  /**
   * @typedef {function(number, Point=): Point} Path
   * Position at time t (seconds), in unit-ish space: generators stay within -1..1 on both axes.
   * Combinators take paths and return new ones, so they nest freely.
   *
   * Sampling allocates one point per call by default. A caller that samples every frame can pass
   * its own point as the second argument: every kit path then writes into it and returns it, so
   * sampling allocates nothing. Always use the RETURNED point: a hand-written `(t) => ({ x, y })`
   * path is still a valid Path and simply ignores the second argument.
   * @example
   * const position = { x: 0, y: 0 };                 // one object for the life of the enemy
   * const { x, y } = swim(elapsedSeconds, position);  // no allocation per frame
   */

  /**
   * A position: written into `out` when one is given, else a new object.
   * @returns {Point}
   */
  const point = (x, y, out) => {
    if (!out) return { x, y };
    out.x = x;
    out.y = y;
    return out;
  };

  /** A scratch point owned by one combinator instance, for sampling its inner paths without allocating. */
  const scratchPoint = () => ({ x: 0, y: 0 });

  /** Triangle wave with period TAU, range -1..1, starting at 0 and rising like sine. */
  const triangleWave = (angle) => 1 - 4 * Math.abs(wrap(angle / TAU + 0.25, 1) - 0.5);

  // wobble runs its x axis at a slightly different rate and phase than y, so the jitter never
  // settles into a visible circle.
  const WOBBLE_X_RATE = 1.3;
  const WOBBLE_X_PHASE = 1.7;

  const path = {
    /**
     * A path that stays put.
     * @param {number} [x=0]
     * @param {number} [y=0]
     * @returns {Path}
     */
    point: (x = 0, y = 0) => (t, out) => point(x, y, out),

    /**
     * Circular orbit round the origin.
     * @param {number} [radius=1]
     * @param {number} [speed=1] radians per second
     * @returns {Path}
     */
    circle: (radius = 1, speed = 1) => (t, out) => point(Math.cos(t * speed) * radius, Math.sin(t * speed) * radius, out),

    /**
     * Figure-eights and loops: frequencies 1:2 draw a figure-eight, 3:2 a pretzel.
     * @param {number} [frequencyX=1] radians per second on x
     * @param {number} [frequencyY=2] radians per second on y
     * @param {number} [phase=0] radians added to x, to rotate the figure
     * @returns {Path}
     */
    lissajous: (frequencyX = 1, frequencyY = 2, phase = 0) => (t, out) => point(Math.sin(t * frequencyX + phase), Math.sin(t * frequencyY), out),

    /**
     * Steady drift along x, wrapping from 1 back to -1, with a sine weave on y.
     * @param {number} [speed=0.5] units per second along x
     * @param {number} [amplitude=0.5] height of the weave
     * @param {number} [frequency=3] radians per second of the weave
     * @returns {Path}
     */
    weave: (speed = 0.5, amplitude = 0.5, frequency = 3) => (t, out) => point(wrap(t * speed + 1, 2) - 1, Math.sin(t * frequency) * amplitude, out),

    /**
     * Sharp triangle-wave zigzag between -1 and 1 on both axes.
     * @param {number} [frequencyX=1] radians per second on x
     * @param {number} [frequencyY=1.7] radians per second on y
     * @returns {Path}
     */
    zigzag: (frequencyX = 1, frequencyY = 1.7) => (t, out) => point(triangleWave(t * frequencyX), triangleWave(t * frequencyY), out),

    /**
     * Stop-and-dart: waits at a waypoint, then dashes (ease-out) to the next, looping through the list.
     * @param {Array<[number, number]>} points waypoints as [x, y]
     * @param {number} [hold=0.8] seconds waiting at each waypoint
     * @param {number} [dash=0.25] seconds travelling between waypoints
     * @returns {Path}
     * @example Kit.path.darts([[0, 0], [1, 1], [-1, 0.5]], 1, 0.2)
     */
    darts(points, hold = 0.8, dash = 0.25) {
      const legSeconds = hold + dash;
      return (t, out) => {
        const legIndex = Math.floor(t / legSeconds);
        // Both indices and the time within the leg are wrapped, so negative time loops backwards.
        const [fromX, fromY] = points[wrap(legIndex, points.length)];
        const [toX, toY] = points[wrap(legIndex + 1, points.length)];
        // Progress stays 0 during the hold, then runs 0..1 over the dash.
        const dashProgress = Math.max(0, (wrap(t, legSeconds) - hold) / dash);
        const eased = ease.outCubic(dashProgress);
        return point(lerp(fromX, toX, eased), lerp(fromY, toY, eased), out);
      };
    },

    /**
     * Small smooth jitter; add it to another path to give it life.
     * @param {number} [amplitude=0.1]
     * @param {number} [frequency=4] radians per second
     * @returns {Path}
     */
    wobble: (amplitude = 0.1, frequency = 4) => (t, out) =>
      point(Math.sin(t * frequency * WOBBLE_X_RATE + WOBBLE_X_PHASE) * amplitude, Math.cos(t * frequency) * amplitude, out),

    // --- combinators ---

    /**
     * Sum of several paths.
     * @param {...Path} paths
     * @returns {Path}
     * @complexity O(paths) time per sample; O(1) space (one scratch point per combinator, none per sample)
     * @example Kit.path.add(Kit.path.lissajous(1, 2), Kit.path.wobble(0.15, 5))
     */
    add: (...paths) => {
      const scratch = scratchPoint();
      return (t, out) => {
        // Hot path (sampled per entity per frame): a plain loop that keeps the running sum in two
        // numbers, so nothing is allocated however many paths are summed.
        let sumX = 0;
        let sumY = 0;
        for (const summand of paths) {
          const position = summand(t, scratch);
          sumX += position.x;
          sumY += position.y;
        }
        return point(sumX, sumY, out);
      };
    },

    /**
     * Stretches a path about the origin.
     * @param {Path} inner
     * @param {number} [scaleX=1]
     * @param {number} [scaleY=scaleX]
     * @returns {Path}
     */
    scale: (inner, scaleX = 1, scaleY = scaleX) => (t, out) => {
      // The inner path may write into `out`; both coordinates are read before `out` is rewritten.
      const position = inner(t, out);
      return point(position.x * scaleX, position.y * scaleY, out);
    },

    /**
     * Moves a path.
     * @param {Path} inner
     * @param {number} [offsetX=0]
     * @param {number} [offsetY=0]
     * @returns {Path}
     */
    offset: (inner, offsetX = 0, offsetY = 0) => (t, out) => {
      const position = inner(t, out);
      return point(position.x + offsetX, position.y + offsetY, out);
    },

    /**
     * Replaces a path's time.
     * @param {Path} inner
     * @param {function(number): number} timeMap
     * @returns {Path}
     * @example Kit.path.warp(swim, (t) => t * 1.5)                    // faster
     * @example Kit.path.warp(swim, (t) => t + Math.sin(t * 2) * 0.4)  // bursts
     */
    warp: (inner, timeMap) => (t, out) => inner(timeMap(t), out),

    /**
     * Plays each part in turn, looping. Boss patterns, multi-phase routes. Each part is evaluated
     * at the overall time t (not time since the part began), so periodic parts stay in phase.
     * @param {Array<[Path, number]>} parts [path, seconds] pairs (at least one)
     * @returns {Path}
     * @complexity O(parts) time per sample to find the active part, O(parts) space
     * @example Kit.path.sequence([[Kit.path.circle(), 4], [Kit.path.point(0, 0), 1]])
     */
    sequence(parts) {
      if (!parts.length) throw new Error('Kit.path.sequence: needs at least one [path, seconds] part');
      const totalSeconds = parts.reduce((sum, [, seconds]) => sum + seconds, 0);
      // Each part's end time within one loop, so the active part is the first whose end is ahead.
      const endTimes = parts.reduce((ends, [, seconds]) => ends.concat((ends[ends.length - 1] || 0) + seconds), []);
      return (t, out) => {
        const loopTime = wrap(t, totalSeconds);
        const activeIndex = endTimes.findIndex((endTime) => loopTime < endTime);
        // No match only through rounding at the very end of the loop: start over with the first part.
        const [activePath] = parts[Math.max(0, activeIndex)];
        return activePath(t, out);
      };
    },

    /**
     * Cross-fades from one path to another.
     * @param {Path} from position at weight 0
     * @param {Path} to position at weight 1
     * @param {number | function(number): number} weight 0..1 (clamped), fixed or as a function of t
     * @returns {Path}
     * @example Kit.path.blend(patrol, chase, (t) => t / 5) // hands over during the first five seconds
     */
    blend: (from, to, weight) => {
      const fromScratch = scratchPoint();
      const toScratch = scratchPoint();
      return (t, out) => {
        const amount = clamp(typeof weight === 'function' ? weight(t) : weight);
        const fromPosition = from(t, fromScratch);
        const toPosition = to(t, toScratch);
        return point(lerp(fromPosition.x, toPosition.x, amount), lerp(fromPosition.y, toPosition.y, amount), out);
      };
    },
  };
  Kit.path = path;

  /**
   * Envelope: a number that is fired up to a peak, held there, then eases back to zero. One small model for camera pushes,
   * recoil kicks, glow pulses and anything else that reacts to an event and then relaxes. Pure: advance it with any clock
   * (pass real seconds to ignore slow motion).
   * @param {{ rise?: number, fall?: number }} [rates] Smoothing rates per second toward the peak and back to zero.
   *   `rise: Infinity` snaps to the peak the moment it is fired.
   * @returns {{ value: number, fire(peak?: number, hold?: number): void, update(dt: number): number }}
   * @example
   * const push = Kit.envelope({ rise: 7, fall: 7 });
   * push.fire(1, 0.7);                       // on impact: lean in for 0.7s
   * camera.fov = 55 - 2 * push.update(dt);   // every frame
   */
  Kit.envelope = ({ rise = 8, fall = 6 } = {}) => {
    let value = 0, peak = 0, holdLeft = 0;
    return {
      get value() {
        return value;
      },
      fire(to = 1, hold = 0) {
        peak = to;
        holdLeft = hold;
        if (rise === Infinity) value = to;
      },
      update(dt) {
        const isHeld = holdLeft > 0;
        holdLeft -= dt;
        const target = isHeld ? peak : 0, rate = isHeld ? rise : fall;
        // An infinite rate times a zero dt is NaN inside damp, so the snap case is handled here.
        value = Number.isFinite(rate) ? Kit.math.damp(value, target, rate, dt) : target;
        return value;
      },
    };
  };
})();
