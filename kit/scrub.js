/**
 * Kit scrub: play a CSS animation on game time instead of wall-clock time.
 *
 * A CSS animation normally runs on the browser's clock, so it keeps going while the game is paused, frozen by hitstop
 * or in slow motion. Kit.scrub pauses the animation and moves its playhead from a game-clock tween instead, so the
 * same keyframes freeze and stretch with the game.
 *
 * Owns:  driving one element's animation playhead from a tween function.
 * Does not own: the keyframes (the stylesheet), the clock (pass ctx.tween or Kit.clock().tween), or removing the element.
 *
 * Touches only `element.style`, so it runs in node with a stand-in element and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * Drives `element`'s CSS animation from a game clock.
   * @param {function(Object, Object<string, number>, number, string): Promise<void>} tween a game-time tween, e.g. `ctx.tween`
   * @param {{ style: Object }} element an element whose stylesheet rule already gives it an animation
   * @param {number} seconds game seconds the whole animation should take
   * @returns {Promise<void>} resolves when the animation has reached its end (remove the element then)
   * @throws {Error} when `tween` is not a function or `seconds` is not positive
   * @example
   * Kit.scrub(ctx.tween, toastElement, 1.2).then(() => toastElement.remove());
   */
  Kit.scrub = (tween, element, seconds) => {
    if (typeof tween !== 'function') throw new Error('Kit.scrub: the first argument must be a game-time tween such as ctx.tween');
    if (!(seconds > 0)) throw new Error(`Kit.scrub: seconds must be a positive number of game seconds (got ${seconds}); toasts take milliseconds, so divide by 1000`);
    element.style.animationPlayState = 'paused';
    element.style.animationDuration = seconds + 's';
    // A paused animation shows the frame at (-delay) seconds, so writing a negative delay is how the playhead is moved.
    // The tween only ever writes `progress`; this setter turns it into that delay.
    const playhead = {
      elapsedFraction: 0,
      get progress() {
        return this.elapsedFraction;
      },
      set progress(fraction) {
        this.elapsedFraction = fraction;
        element.style.animationDelay = -(fraction * seconds) + 's';
      },
    };
    playhead.progress = 0;
    return tween(playhead, { progress: 1 }, seconds, 'linear');
  };
})();
