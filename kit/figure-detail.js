/**
 * Kit figure detail: which level of detail a figure needs for how large it is drawn, chosen so that nobody has
 * to pass one. A level is made for a band of on-screen heights (kit/figure-shapes.js `LEVEL_BY_PIXELS`, with
 * `far` below them for crowds); a figure moves to the next band only once it is clearly inside it, so one that
 * hovers at a boundary does not flicker between two meshes.
 *
 * Owns:  `Kit.figure.DETAIL_BANDS` (the bands, `far` included), `detailFor` (pixels and the level shown now ->
 *        the level to show) and `pixelsTall` (a height in the world and a camera -> target pixels).
 * Does not own: what a level is made of (kit/figure-shapes.js `LEVELS`, kit/sculpt.js `DETAIL`), measuring a
 *        figure or a camera (kit/look-view.js does, each frame), or swapping the meshes (kit/figure.js).
 *
 * Heights are in pixels of the target a look draws on: a pixel look's texels, not the screen's pixels, so a
 * figure 100 texels tall is drawn at the level of 100 pixels however large the texels are shown.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-sculpt.js.
 */
(() => {
  /** A figure up to this many target pixels tall is drawn at `far`: a face is then a few pixels and a hem under one. */
  const FAR_UP_TO = 64;
  /**
   * The level by how tall a figure is drawn, in rising order; the last has no limit. `far` and then the rows of
   * `Kit.figure.LEVEL_BY_PIXELS`, which stay the one statement of where low, medium and high meet.
   * @type {ReadonlyArray<{upTo: number, level: string}>}
   */
  const DETAIL_BANDS = Object.freeze([Object.freeze({ upTo: FAR_UP_TO, level: 'far' }), ...Kit.figure.LEVEL_BY_PIXELS]);
  /**
   * A figure leaves the band it is shown in only when it is this share past the band's edge (16% taller than
   * its upper edge, or as much shorter than its lower one). A walk toward the camera, a zoom or a bob of a
   * few pixels then changes level once, not every frame.
   */
  const HYSTERESIS = 0.16;

  const fail = (where, message) => {
    throw new Error(`Kit.figure.${where}: ${message}`);
  };

  /**
   * The level of detail to show a figure at.
   * @param {number} pixels the figure's height on the target, in target pixels (a pixel look's texels)
   * @param {string} [shown] the level it is shown at now; without it, the band the height falls in
   * @returns {string} a level of `DETAIL_BANDS`: `shown` while the height is inside its band or within
   *   `HYSTERESIS` of it, else the band the height falls in
   * @throws {Error} for a `shown` that is not a level
   * @complexity O(bands)
   * @example Kit.figure.detailFor(96) // 'low': a footballer on a phone pitch
   * @example Kit.figure.detailFor(160, 'low') // 'low' still: 150 is the edge, and 160 is within 16% of it
   */
  const detailFor = (pixels, shown) => {
    const wanted = DETAIL_BANDS.find((row) => pixels <= row.upTo).level;
    if (shown === undefined || shown === wanted) return wanted;
    const at = DETAIL_BANDS.findIndex((row) => row.level === shown);
    if (at < 0) fail('detailFor', `no level "${shown}". Levels: ${DETAIL_BANDS.map((row) => row.level).join(', ')}.`);
    const lowerEdge = at > 0 ? DETAIL_BANDS[at - 1].upTo : 0;
    const isNearBand = pixels > lowerEdge * (1 - HYSTERESIS) && pixels <= DETAIL_BANDS[at].upTo * (1 + HYSTERESIS);
    return isNearBand ? shown : wanted;
  };

  /**
   * How tall something is drawn, in pixels of the target.
   * @param {{height: number, targetHeight: number, viewHeight?: number, depth?: number, fieldOfView?: number}} view `height`: its
   *   height in the world, metres; `targetHeight`: the target's height in pixels (a pixel look's rows). Then
   *   either `viewHeight`: the world height an orthographic camera shows, or `depth` (metres in front of a
   *   perspective camera) with `fieldOfView` (its vertical angle, radians)
   * @returns {number} pixels; Infinity for something at or behind a perspective camera
   * @complexity O(1)
   * @example Kit.figure.pixelsTall({ height: 1.1, targetHeight: 180, viewHeight: 2.2 }) // 90
   */
  const pixelsTall = ({ height, targetHeight, viewHeight, depth, fieldOfView }) => {
    if (viewHeight !== undefined) return (height / viewHeight) * targetHeight;
    if (!(depth > 0)) return Infinity;
    return (height / (2 * depth * Math.tan(fieldOfView / 2))) * targetHeight;
  };

  Kit.figure = Object.assign(Kit.figure || {}, { DETAIL_BANDS, DETAIL_HYSTERESIS: HYSTERESIS, detailFor, pixelsTall });
})();
