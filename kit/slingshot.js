/**
 * Kit slingshot: the pull-back-and-release aim gesture as numbers. A finger goes down, drags back and lets go:
 * how far it was pulled is the power, the way it was pulled (mirrored) is the aim, and a quick sideways flick
 * in the last moment before release is a curve.
 *
 * Owns:  `Kit.slingshot.read` (a drag offset -> pull and angle), `Kit.slingshot.gesture` (one gesture over
 *        time: begin, move, release -> pull, angle and curve) and `DEFAULTS`.
 * Does not own: pointer events (`ctx.input.onDrag` feeds it), what pull, angle and curve mean in a game (a
 *        launch speed, a loft, a spin), the flight (`Kit.flight`, `Kit.ballistics`) or drawing the aim.
 *
 * Conventions: screen pixels, x to the right, y DOWN (as pointer events give them); times in milliseconds.
 * Angle 0 aims straight up the screen and grows to the right; pulling down and to the left aims to the right.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * @typedef {Object} SlingshotOptions
   * @property {number} maxDrag pixels of pull that count as full power
   * @property {number} minPull a release below this pull (0..1) is not armed: a cancelled shot, not a dribble
   * @property {number} maxAngle the widest aim either side, radians
   * @property {number} settleMs the flick window: sideways travel in the last this-many milliseconds is a curve
   * @property {number} flickDeadzone sideways travel below this share of `flickFull` is not a flick
   * @property {number} flickFull sideways travel, as a share of `maxDrag`, that gives the full curve
   */

  /** Sized for a thumb on a phone: 170 px is a comfortable pull, a tenth of a second is a deliberate flick. */
  const DEFAULTS = Object.freeze({ maxDrag: 170, minPull: 0.12, maxAngle: 0.6, settleMs: 110, flickDeadzone: 0.25, flickFull: 0.4 });
  /** Samples a gesture keeps: at 120 events a second this is a quarter of a second, more than twice the flick window. */
  const MOST_SAMPLES = 32;

  const clamp = (value, least, most) => Math.min(most, Math.max(least, value));

  /**
   * @typedef {Object} SlingshotAim
   * @property {number} pull 0 (no pull) .. 1 (full)
   * @property {number} angle radians; 0 straight ahead, positive to the right
   * @property {boolean} isArmed is the pull enough to launch?
   */

  /**
   * Reads a drag offset as an aim. Only a pull back (down the screen) counts: a drag up the screen is no pull.
   * @param {number} dx pixels the finger is right of where it went down
   * @param {number} dy pixels the finger is below where it went down
   * @param {Partial<SlingshotOptions>} [options]
   * @returns {SlingshotAim}
   * @complexity O(1)
   * @example Kit.slingshot.read(-40, 120) // { pull: 0.74, angle: 0.32, isArmed: true }: pulled down-left, aims right
   */
  const read = (dx, dy, options) => {
    const { maxDrag, minPull, maxAngle } = { ...DEFAULTS, ...options };
    if (dy <= 0) return { pull: 0, angle: 0, isArmed: false };
    const pull = clamp(Math.hypot(dx, dy) / maxDrag, 0, 1);
    return { pull, angle: clamp(Math.atan2(-dx, dy), -maxAngle, maxAngle), isArmed: pull >= minPull };
  };

  /**
   * @typedef {Object} SlingshotGesture
   * @property {function(number, number, number): void} begin (x, y, ms): the finger went down
   * @property {function(number, number, number): void} move (x, y, ms): it moved
   * @property {function(): SlingshotAim} aim the aim right now, for a live preview
   * @property {function(number=): (SlingshotAim & {curve: number})} release (ms): it let go; `curve` is -1 (full
   *   left) .. 1 (full right), 0 without a flick. With a flick, pull and angle are those held before it began.
   * @property {function(): boolean} isActive between `begin` and `release`
   */

  /**
   * Follows one slingshot gesture at a time.
   * @param {Partial<SlingshotOptions>} [options]
   * @returns {SlingshotGesture}
   * @complexity move: O(1); release: O(samples kept), at most 32
   * @example
   * const sling = Kit.slingshot.gesture();
   * input.onDrag(({ phase, x, y }) => {
   *   if (phase === 'start') sling.begin(x, y, performance.now());
   *   if (phase === 'move') sling.move(x, y, performance.now());
   *   if (phase === 'end') launch(sling.release(performance.now()));   // { pull, angle, curve, isArmed }
   * });
   */
  const gesture = (options) => {
    const settings = { ...DEFAULTS, ...options };
    /** @type {Array<{x: number, y: number, ms: number}>} oldest first */
    let samples = [];
    let origin = null;
    /** @returns {[number, number]} a sample's offset from where the drag began, pixels */
    const offsetOf = (sample) => [sample.x - origin.x, sample.y - origin.y];
    const last = () => samples[samples.length - 1];
    return {
      begin(x, y, ms) {
        origin = { x, y };
        samples = [{ x, y, ms }];
      },
      move(x, y, ms) {
        if (!origin) return;
        samples.push({ x, y, ms });
        if (samples.length > MOST_SAMPLES) samples.shift();
      },
      aim: () => (origin ? read(...offsetOf(last()), settings) : { pull: 0, angle: 0, isArmed: false }),
      release(ms = last() ? last().ms : 0) {
        if (!origin) return { pull: 0, angle: 0, curve: 0, isArmed: false };
        const final = last();
        // Where the finger was before the flick window opened: the aim the player was holding.
        const settled = samples.filter((sample) => sample.ms <= ms - settings.settleMs).pop() || samples[0];
        const held = read(...offsetOf(settled), settings);
        const [heldX, heldY] = offsetOf(settled);
        const heldLength = Math.hypot(heldX, heldY);
        // Sideways travel since then, measured across the pull (to the right as the player sees the aim line).
        const across = held.isArmed ? ((final.x - settled.x) * heldY - (final.y - settled.y) * heldX) / heldLength : 0;
        const flick = across / (settings.flickFull * settings.maxDrag);
        const curve = Math.abs(flick) < settings.flickDeadzone ? 0 : clamp(flick, -1, 1);
        const result = curve === 0 ? read(...offsetOf(final), settings) : held;
        origin = null;
        samples = [];
        return { ...result, curve };
      },
      isActive: () => origin !== null,
    };
  };

  Kit.slingshot = { DEFAULTS, read, gesture };
})();
