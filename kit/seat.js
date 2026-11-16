/**
 * Kit seat: fixed camera seats as rules, and the promises a seat makes about its picture. A seat does not say
 * where the camera is; it says what must fit from edge to edge and what must sit just under the interface, and
 * `solve` finds the place and the lens for whatever screen it is given. A promise is a named check over screen
 * rectangles ("the goal is whole", "the hero never covers the ball"); a watch counts the frames that break one
 * and remembers the first, so a playtest can assert that none did on every screen shape.
 *
 * Owns:  `Kit.seat.solve` (rule + screen -> place, look-at point and field of view), `Kit.seat.span` (how
 *        tall a subject stands on screen from a solved seat), `Kit.seat.disc` and `Kit.seat.rect` (screen
 *        rectangles of things and what to ask of them), and `Kit.seat.watch` (promises counted per frame).
 * Does not own: the camera object (the caller copies `at`, `look` and `fov` onto its own), moving cameras
 *        (kit/camera-rigs.js), what is drawn, or the interface whose band a seat keeps clear (the caller states
 *        its height).
 *
 * Conventions: metres, +Y up; a seated camera looks along the z axis (`toward` -1 or 1) at x = 0, pitched
 * down or up. Screen rectangles are CSS pixels, y down: `{ left, top, right, bottom }`.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const RADIANS = Math.PI / 180;
  const { clamp } = Kit.math;

  /**
   * @typedef {Object} SeatLens
   * @property {number} [fov] vertical field of view, degrees (a seat that fits by distance)
   * @property {number} [height] the camera's height, metres (a seat that fits by distance)
   * @property {number[]} [fovRange] [least, most] vertical field of view, degrees (a seat with a fixed place)
   */

  /**
   * @typedef {Object} SeatRule
   * @property {number} toward -1 when the camera looks towards -z, 1 towards +z
   * @property {{z: number, halfWidth: number}} fit the plane across the view that must be seen this wide
   * @property {{y: number, z: number, at?: number}} anchor the point the tilt is set by: it sits just below the
   *   band the interface covers (the highest thing that matters), or, with `at`, that share of the screen's
   *   height down from the top
   * @property {number} [least] least distance from the fit plane, metres (fit by distance)
   * @property {number[]} [at] the camera's fixed place [x, y, z] (fit by opening the lens)
   * @property {SeatLens} portrait the lens on a screen taller than wide
   * @property {SeatLens} landscape the lens on a screen wider than tall
   */

  /**
   * @typedef {Object} SolvedSeat
   * @property {number[]} at the camera's place [x, y, z]
   * @property {number[]} look the point it looks at [x, y, z]
   * @property {number} fov vertical field of view, degrees
   */

  /**
   * Solves a seat for a screen.
   * @param {SeatRule} seat
   * @param {{w: number, h: number, aspect: number, portrait: boolean}} size the screen, CSS pixels (a game's `ctx.size`)
   * @param {number} [band=0] CSS pixels at the top of the screen that the interface covers
   * @returns {SolvedSeat}
   * @complexity O(1)
   * @example
   * const seat = Kit.seat.solve({ toward: -1, fit: { z: -11, halfWidth: 3 }, anchor: { y: 2.6, z: -11 }, least: 15,
   *   portrait: { fov: 50, height: 4 }, landscape: { fov: 42, height: 4 } }, ctx.size, 200);
   * camera.position.set(...seat.at); camera.fov = seat.fov; camera.updateProjectionMatrix(); camera.lookAt(...seat.look);
   */
  const solve = (seat, size, band = 0) => {
    const lens = seat[size.portrait ? 'portrait' : 'landscape'];
    let at, fov;
    if (seat.at) {
      // A fixed place: the lens opens until the fit plane is in from edge to edge.
      at = seat.at;
      const depth = Math.abs(seat.fit.z - at[2]);
      const halfAngle = Math.atan(seat.fit.halfWidth / depth) + Math.atan(Math.abs(at[0]) / depth);
      fov = clamp((2 * Math.atan(Math.tan(halfAngle) / size.aspect)) / RADIANS, lens.fovRange[0], lens.fovRange[1]);
    } else {
      // A fixed lens: the camera backs off until the fit plane is in from edge to edge.
      fov = lens.fov;
      const distance = Math.max(seat.least || 0, seat.fit.halfWidth / (Math.tan((fov / 2) * RADIANS) * size.aspect));
      at = [0, lens.height, seat.fit.z - seat.toward * distance];
    }
    // Tilt: the anchor sits just under the interface's band, or at its own share of the way down the screen.
    const halfFov = (fov / 2) * RADIANS;
    const anchorAngle = Math.atan((at[1] - seat.anchor.y) / Math.abs(seat.anchor.z - at[2]));
    const down = seat.anchor.at === undefined ? band / size.h : seat.anchor.at;
    const pitch = anchorAngle + Math.atan((1 - 2 * down) * Math.tan(halfFov));
    const lookDepth = Math.abs(seat.fit.z - at[2]);
    return { at, look: [0, at[1] - lookDepth * Math.tan(pitch), seat.fit.z], fov };
  };

  /**
   * How tall something upright stands on screen from a solved seat: the pixels between two heights above a
   * point of the centre line. This is what a pixel grid is fitted to (`Kit.pixelGrid.fit`).
   * @param {SolvedSeat} solved
   * @param {{z: number, from?: number, to: number}} subject where it stands, and the heights of its foot (0) and its top
   * @param {number} screenHeight pixels (CSS, or device pixels for a drawing buffer)
   * @returns {number} pixels; negative when the subject is behind the camera
   * @complexity O(1)
   * @example Kit.seat.span(seat, { z: 1.4, to: 1.75 }, renderer.domElement.height)
   */
  const span = (solved, { z, from = 0, to }, screenHeight) => {
    const [ahead, below] = [Math.abs(solved.at[2] - solved.look[2]), solved.at[1] - solved.look[1]];
    const reach = Math.hypot(ahead, below);
    const [sinPitch, cosPitch] = [below / reach, ahead / reach];
    const away = Math.abs(solved.at[2] - z);
    /** A height's share of the half screen above the centre. */
    const share = (height) => {
      const rise = height - solved.at[1];
      return (rise * cosPitch + away * sinPitch) / ((away * cosPitch - rise * sinPitch) * Math.tan((solved.fov / 2) * RADIANS));
    };
    return ((share(to) - share(from)) * screenHeight) / 2;
  };

  /**
   * The screen rectangle of a ball of a radius round a point given in the camera's space.
   * @param {{x: number, y: number, z: number}} viewPoint the point in the camera's space (-z is ahead)
   * @param {number} radius world units
   * @param {{fov: number, near: number}} camera vertical field of view in degrees, and the near plane
   * @param {{w: number, h: number}} size the screen, CSS pixels
   * @returns {?{left: number, top: number, right: number, bottom: number}} null when the point is behind the near plane
   * @complexity O(1)
   */
  const disc = (viewPoint, radius, camera, size) => {
    const depth = -viewPoint.z;
    if (depth <= camera.near) return null;
    const pixelsPerUnit = size.h / (2 * Math.tan((camera.fov / 2) * RADIANS) * depth);
    const [centreX, centreY] = [size.w / 2 + viewPoint.x * pixelsPerUnit, size.h / 2 - viewPoint.y * pixelsPerUnit];
    return { left: centreX - radius * pixelsPerUnit, top: centreY - radius * pixelsPerUnit, right: centreX + radius * pixelsPerUnit, bottom: centreY + radius * pixelsPerUnit };
  };

  /** Questions asked of screen rectangles; every one takes null (a thing that is not on screen) and answers false or null. */
  const rect = {
    /** The rectangle that holds two others, or the one that exists. */
    union: (first, second) => (!first ? second : !second ? first : { left: Math.min(first.left, second.left), top: Math.min(first.top, second.top), right: Math.max(first.right, second.right), bottom: Math.max(first.bottom, second.bottom) }),
    /** Do two rectangles share any area? */
    overlaps: (first, second) => Boolean(first && second) && first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom,
    /** Is the rectangle wholly inside the screen? */
    isWhole: (given, size) => Boolean(given) && given.left > 0 && given.top > 0 && given.right < size.w && given.bottom < size.h,
    /** The part of a rectangle that is on the screen; null when none of it is. */
    cut(given, size) {
      if (!given) return null;
      const kept = { left: Math.max(0, given.left), top: Math.max(0, given.top), right: Math.min(size.w, given.right), bottom: Math.min(size.h, given.bottom) };
      return kept.left < kept.right && kept.top < kept.bottom ? kept : null;
    },
  };

  /**
   * @typedef {Object} SeatWatch
   * @property {function(boolean=): void} start begin (or, with false, stop) checking, from a clean count
   * @property {function(): boolean} isWatching
   * @property {function(*, function(): Object=): void} check run every promise against what is seen now;
   *   the second argument is called only for a promise's first break, and what it returns is kept as the note
   * @property {function(): {frames: number, broken: Object<string, number>, first: Object<string, Object>}} report
   *   frames checked, frames each promise was broken in, and the note of each first break
   */

  /**
   * Watches a table of promises.
   * @param {Object<string, function(*): boolean>} promises name -> a check that returns false when the promise is broken
   * @returns {SeatWatch}
   * @complexity check: O(promises)
   * @example
   * const watch = Kit.seat.watch({ 'the door is whole': (seen) => Kit.seat.rect.isWhole(seen.door, ctx.size) });
   * watch.start(); // then each frame: watch.check({ door: doorRect }, () => ({ room: room.id }));
   */
  const watch = (promises) => {
    const names = Object.keys(promises);
    let isOn = false;
    let frames = 0;
    let broken = {};
    let first = {};
    return {
      start(isWanted = true) {
        isOn = isWanted;
        frames = 0;
        broken = {};
        first = {};
      },
      isWatching: () => isOn,
      check(seen, note) {
        frames += 1;
        for (let index = 0; index < names.length; index++) {
          const name = names[index];
          if (promises[name](seen)) continue;
          broken[name] = (broken[name] || 0) + 1;
          if (!first[name]) first[name] = note ? note() : {};
        }
      },
      report: () => ({ frames, broken: { ...broken }, first: { ...first } }),
    };
  };

  Kit.seat = { solve, span, disc, rect, watch };
})();
