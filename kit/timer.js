// Kit timer: countdowns as plain data. Pure, no DOM, no THREE - runs in node (see tools/test-kit.js).
//
//   Kit.timer.start(30)            a countdown: { duration, left }
//   Kit.timer.tick(timer, dt)      a new timer with dt less on it (never below zero)
//   Kit.timer.fraction(timer)      1 when fresh, 0 when expired (patience rings, cooldown wipes)
//   Kit.timer.tickAll(items, dt)   tick the timer on every item and split them into { running, expired }
//   Kit.timer.cycle(timer, dt)     a repeating timer: how many times it fired in dt, remainder carried over
//
// Owns: the arithmetic of patience, cooldowns and repeating production. Does not own: scheduling callbacks (ctx.after /
// ctx.every do that) or what happens on expiry - timers live inside a game's own state and the game decides.
(() => {
  /**
   * @typedef {Object} Timer
   * @property {number} duration  seconds it started with
   * @property {number} left      seconds remaining, 0 when expired
   */

  /**
   * @param {number} duration  seconds
   * @returns {Timer}
   */
  const start = (duration) => ({ duration, left: duration });

  /**
   * @param {Timer} timer
   * @param {number} dt  seconds elapsed
   * @returns {Timer}  a new timer; the input is not changed
   */
  const tick = (timer, dt) => ({ ...timer, left: Math.max(0, timer.left - dt) });

  /** @param {Timer} timer @returns {number} remaining share, 1 (fresh) down to 0 (expired) */
  const fraction = (timer) => (timer.duration > 0 ? timer.left / timer.duration : 0);

  /** @param {Timer} timer @returns {boolean} */
  const isExpired = (timer) => timer.left <= 0;

  /**
   * Tick the timer carried by each item and separate the ones that ran out.
   * @template Item
   * @param {Item[]} items  objects holding a Timer under `key`
   * @param {number} dt     seconds elapsed
   * @param {string} [key='timer']
   * @returns {{ running: Item[], expired: Item[] }}  copies with ticked timers, in their original order
   * @example
   *   const { running, expired } = Kit.timer.tickAll(orders, dt);
   *   expired.forEach(loseHeart);
   */
  const tickAll = (items, dt, key = 'timer') => {
    const ticked = items.map((item) => ({ ...item, [key]: tick(item[key], dt) }));
    return { running: ticked.filter((item) => !isExpired(item[key])), expired: ticked.filter((item) => isExpired(item[key])) };
  };

  /**
   * Advance a repeating timer. Large steps fire several times; the overshoot is carried so the rhythm never drifts.
   * @param {Timer} timer
   * @param {number} dt  seconds elapsed
   * @returns {{ timer: Timer, fired: number }}
   * @example
   *   const { timer, fired } = Kit.timer.cycle(dock.production, dt);   // fired crates were made during dt
   */
  const cycle = (timer, dt) => {
    if (!(timer.duration > 0)) return { timer, fired: 0 };
    const left = timer.left - dt;
    if (left > 0) return { timer: { ...timer, left }, fired: 0 };
    // `left` is zero or negative: one firing for reaching zero plus one per whole duration of overshoot.
    const fired = 1 + Math.floor(-left / timer.duration);
    return { timer: { ...timer, left: left + fired * timer.duration }, fired };
  };

  Kit.timer = { start, tick, fraction, isExpired, tickAll, cycle };
})();
