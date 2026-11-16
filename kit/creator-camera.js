/**
 * Kit creator camera: where the stage camera looks and how it gets there, as plain numbers. The character is
 * framed by two numbers, the share of the body's height in view (`span`, 1 is the whole body) and the height
 * at the middle of the view (`anchor`, as a share of the body's height); a turn is a `yaw`. Choosing a group of
 * controls moves the target to the body area that group edits, and the real camera eases toward it.
 *
 * Owns:  `Kit.creator.camera.director(options)` (the state, `focus`, `zoomBy`, `zoomTo`, `turnBy`, `step`,
 *        `windowFor`), the table `GROUP_FOCUS` (group id -> the body area it edits) and the gesture maths
 *        (`pinchFactor`, `yawFromDrag`).
 * Does not own: the camera object (the screen sets an orthographic camera from the window this returns), the
 *        measuring of the body (`figure.measured`), or pointer events (kit/creator.js reads those).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-creator.js.
 */
(() => {
  /** The whole body in view, centred. */
  const FULL = Object.freeze({ anchor: 0.5, span: 1 });
  /** Head and shoulders. */
  const CLOSE = Object.freeze({ anchor: 0.9, span: 0.3 });
  /**
   * The body area each editor group works on. A group the table does not name is shown whole, so a group the
   * catalogue adds later still gets a sensible view with no change here.
   * @type {Object<string, {anchor: number, span: number}>}
   */
  const GROUP_FOCUS = Object.freeze({
    head: { anchor: 0.9, span: 0.32 },
    face: { anchor: 0.91, span: 0.2 },
    hair: { anchor: 0.91, span: 0.3 },
    body: { anchor: 0.62, span: 0.62 },
    arms: { anchor: 0.62, span: 0.66 },
    legs: { anchor: 0.3, span: 0.62 },
    outfit: { anchor: 0.56, span: 0.88 },
    accessories: { anchor: 0.6, span: 0.88 },
    traits: { anchor: 0.6, span: 0.88 },
    colors: FULL,
  });
  /** The smallest share of the body's height the camera zooms in to. */
  const MIN_SPAN = 0.16;
  const MAX_SPAN = 1;
  /** Space round what the span covers, so a hat or an outstretched hand is never on the edge. */
  const FRAME_PADDING = 1.16;
  /** Below this span the body's width never limits the view (zoomed in, only height matters). */
  const WIDTH_FIT_FROM_SPAN = 0.6;
  /** How quickly the camera closes the gap to its target, per second (the gap shrinks by 1 - e^(-rate * dt) each frame). */
  const EASE_RATE = 9;
  /** A zoom button multiplies the span by this (zooming out divides by it). */
  const ZOOM_STEP = 0.7;
  /** A turn button or arrow key turns the character this far, radians. */
  const TURN_STEP = Math.PI / 8;
  /** A finger or mouse dragged this many pixels turns the character a radian. */
  const PIXELS_PER_RADIAN = 90;
  /** The opening angle: a little off front-on, so the first look shows the body has depth. */
  const OPENING_YAW = 0.35;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const lerp = (from, to, fraction) => from + (to - from) * fraction;

  /**
   * By what factor a pinch changes the span: fingers moving apart (a larger distance) zoom in.
   * @param {number} previousDistance pixels between the two fingers a moment ago
   * @param {number} distance pixels between them now
   * @returns {number} multiply the span by this; 1 when either distance is not positive
   * @example Kit.creator.camera.pinchFactor(100, 200) // 0.5: twice as far apart, half the span
   */
  const pinchFactor = (previousDistance, distance) => (previousDistance > 0 && distance > 0 ? previousDistance / distance : 1);

  /**
   * The turn a horizontal drag makes.
   * @param {number} pixels the drag, positive to the right
   * @returns {number} radians
   */
  const yawFromDrag = (pixels) => pixels / PIXELS_PER_RADIAN;

  /**
   * The anchor a free zoom uses: the middle of the body when out, the head when close, so zooming in finds the face.
   * @param {number} span
   * @returns {number}
   */
  const anchorForSpan = (span) => lerp(CLOSE.anchor, FULL.anchor, clamp((span - CLOSE.span) / (FULL.span - CLOSE.span), 0, 1));

  /**
   * The orthographic camera bounds that put a window's centre in the middle of a screen area, so the character
   * can stand in the free part of the screen (above a panel, beside it) while the canvas fills the whole page.
   * @param {{centerX: number, centerY: number, halfWidth: number, halfHeight: number}} window from `windowFor`
   * @param {{left: number, top: number, width: number, height: number}} area the free area, CSS pixels from the screen's top left
   * @param {{w: number, h: number}} size the whole screen, CSS pixels
   * @returns {{left: number, right: number, top: number, bottom: number}} world units about the camera's axis
   * @example Object.assign(camera, Kit.creator.camera.boundsFor(window, area, ctx.size)); camera.updateProjectionMatrix();
   */
  const boundsFor = (window, area, size) => {
    const worldPerPixel = (2 * window.halfHeight) / area.height;
    const centerX = area.left + area.width / 2;
    const centerY = area.top + area.height / 2;
    return { left: -centerX * worldPerPixel, right: (size.w - centerX) * worldPerPixel, top: centerY * worldPerPixel, bottom: -(size.h - centerY) * worldPerPixel };
  };

  /**
   * @typedef {Object} CameraDirector
   * @property {function(string): void} focus aim at the body area of an editor group (an unknown group aims at the whole body)
   * @property {function(number): void} zoomBy multiply the span (below 1 zooms in); the anchor follows unless a group fixed it
   * @property {function(('full'|'close')): void} zoomTo jump the target to the whole body or to head and shoulders
   * @property {function(number): void} turnBy turn the character by radians, instantly (a drag)
   * @property {function(number): void} turnTo ease the character to a yaw (a button or key)
   * @property {function(number, boolean=): void} step move toward the target by `dt` seconds; `instant` jumps there
   * @property {function(Object, number): {centerX: number, centerY: number, halfWidth: number, halfHeight: number}} windowFor
   *   the camera window for a measured body and a screen area of an aspect
   * @property {function(): {yaw: number, anchor: number, span: number}} state the values in view now
   * @property {function(): {yaw: number, anchor: number, span: number}} target the values being eased to
   */

  /**
   * Makes the camera director.
   * @param {{yaw?: number}} [options] `yaw` the opening angle in radians
   * @returns {CameraDirector}
   * @complexity O(1) per call
   * @example
   * const director = Kit.creator.camera.director();
   * director.focus('face'); director.step(1 / 60);          // each frame
   * const window = director.windowFor(figure.measured, width / height);
   */
  const director = ({ yaw: openingYaw = OPENING_YAW } = {}) => {
    /** @type {{yaw: number, anchor: number, span: number}} */
    const shown = { yaw: openingYaw, anchor: FULL.anchor, span: FULL.span };
    /** @type {{yaw: number, anchor: number, span: number}} */
    const target = { yaw: openingYaw, anchor: FULL.anchor, span: FULL.span };
    let isAnchorFixed = false;

    const self = {
      focus(groupId) {
        const area = GROUP_FOCUS[groupId] || FULL;
        Object.assign(target, { anchor: area.anchor, span: area.span });
        isAnchorFixed = true;
      },
      zoomBy(factor) {
        target.span = clamp(target.span * factor, MIN_SPAN, MAX_SPAN);
        if (!isAnchorFixed) target.anchor = anchorForSpan(target.span);
      },
      zoomTo(which) {
        const area = which === 'close' ? CLOSE : FULL;
        Object.assign(target, { anchor: area.anchor, span: area.span });
        isAnchorFixed = true;
      },
      turnBy(radians) {
        target.yaw += radians;
        shown.yaw += radians;
      },
      turnTo(yaw) {
        target.yaw = yaw;
      },
      step(dt, instant = false) {
        const fraction = instant ? 1 : 1 - Math.exp(-EASE_RATE * dt);
        ['yaw', 'anchor', 'span'].forEach((field) => (shown[field] = lerp(shown[field], target[field], fraction)));
      },
      windowFor(measured, aspect) {
        const height = Math.max(measured.highestY - measured.lowestY, Number.EPSILON);
        const neededHalfWidth = measured.reach * FRAME_PADDING;
        // Zoomed out, the body's reach decides the width; zoomed in, the span decides the height. The width
        // requirement fades in over the last stretch of zoom so the view never jumps.
        const widthNeed = (neededHalfWidth / aspect) * clamp((shown.span - WIDTH_FIT_FROM_SPAN) / (MAX_SPAN - WIDTH_FIT_FROM_SPAN), 0, 1);
        const halfHeight = Math.max((shown.span * height * FRAME_PADDING) / 2, widthNeed);
        return { centerX: 0, centerY: measured.lowestY + shown.anchor * height, halfWidth: halfHeight * aspect, halfHeight };
      },
      state: () => ({ ...shown }),
      target: () => ({ ...target }),
    };
    return self;
  };

  Kit.creator = Object.assign(Kit.creator || {}, { camera: { director, boundsFor, pinchFactor, yawFromDrag, GROUP_FOCUS, FULL, CLOSE, MIN_SPAN, MAX_SPAN, ZOOM_STEP, TURN_STEP } });
})();
