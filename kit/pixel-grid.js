/**
 * Kit pixel grid: how fine a pixel-look picture should be, as a rule. A game names a grain (chunky, standard,
 * fine) and says how big its subject is on screen; the rule answers with whole device pixels per texel, so
 * every texel is the same size on any screen and the subject carries the same detail on a tall phone, a small
 * one or a phone on its side. With it: the look settings that go with a grain, and the texel grid under a
 * moving thing in a perspective picture (which has no one texel size: it grows with depth).
 *
 * Owns:  `Kit.pixelGrid.GRAINS` (the named steps), `Kit.pixelGrid.fit` (subject size -> texel size and rows),
 *        `Kit.pixelGrid.settings` (a fitted grid -> overrides for `LookView.use('pixel', ...)`),
 *        `Kit.pixelGrid.texelAt` and `Kit.pixelGrid.snapShift` (stand a moving thing on the grid).
 * Does not own: drawing at that size (kit/look-view.js and look-ink.js, through `pixelRows`), the whole-pixel
 *        upscale (`Kit.look.texelScale`), snapping under an orthographic camera (look-view.js does that itself),
 *        or how big a subject is on screen (the caller measures: `Kit.seat.span` for a seated camera).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const RADIANS = Math.PI / 180;

  /**
   * @typedef {Object} Grain
   * @property {number} subjectRows texel rows the subject (a standing character, usually) should get
   * @property {number} toneCount tones per ramp: more rows can carry more tones
   * @property {string} level the level of detail for figures at this size (kit/figure-shapes.js `LEVELS`)
   */

  /**
   * The named steps. `chunky` is a sprite of the 16-bit consoles, `standard` a detailed one, `fine` close to an
   * illustration that still shows its texels.
   * @type {Object<string, Grain>}
   */
  const GRAINS = Object.freeze({
    chunky: Object.freeze({ subjectRows: 72, toneCount: 4, level: 'low' }),
    standard: Object.freeze({ subjectRows: 112, toneCount: 5, level: 'low' }),
    fine: Object.freeze({ subjectRows: 160, toneCount: 6, level: 'medium' }),
  });

  /**
   * @typedef {Object} PixelGrid
   * @property {string} grain the grain it was fitted for
   * @property {number} texelPixels device pixels a texel is across: whole, 1 or more
   * @property {number} rows texel rows of the whole picture (`bufferHeight / texelPixels`)
   * @property {number} subjectRows the rows the subject really gets (as near the grain's as whole pixels allow)
   * @property {number} texelWorld world units a texel covers on the subject
   */

  /**
   * Fits the grid to a subject.
   * @param {string} grain a key of `GRAINS`
   * @param {{subjectPixels: number, subjectHeight: number, bufferHeight: number}} screen `subjectPixels`: the
   *   subject's height on screen, device pixels; `subjectHeight`: its height in world units; `bufferHeight`: the
   *   drawing buffer's height, device pixels
   * @returns {PixelGrid}
   * @throws {Error} for a grain that does not exist
   * @complexity O(1)
   * @example Kit.pixelGrid.fit('standard', { subjectPixels: 480, subjectHeight: 1.75, bufferHeight: 1688 }).texelPixels // 4
   */
  const fit = (grain, { subjectPixels, subjectHeight, bufferHeight }) => {
    if (!GRAINS[grain]) throw new Error(`Kit.pixelGrid.fit: no grain "${grain}". Grains: ${Object.keys(GRAINS).join(', ')}.`);
    const texelPixels = Math.max(1, Math.round(subjectPixels / GRAINS[grain].subjectRows));
    const subjectRows = subjectPixels / texelPixels;
    return { grain, texelPixels, rows: bufferHeight / texelPixels, subjectRows, texelWorld: subjectHeight / subjectRows };
  };

  /**
   * The look overrides that draw a fitted grid: its rows, the grain's tones, and as much of the pixel preset's
   * dither as texels of that size can carry (`Kit.look.ditherAt`).
   * @param {PixelGrid} grid from `fit`
   * @returns {{pixelRows: number, toneCount: number, dither: number}}
   * @example view.use('pixel', Kit.pixelGrid.settings(Kit.pixelGrid.fit('fine', screen)));
   */
  const settings = (grid) => ({ pixelRows: grid.rows, toneCount: GRAINS[grid.grain].toneCount, dither: Kit.look.ditherAt(Kit.look.PRESETS.pixel.dither, grid.texelWorld) });

  /**
   * World units one texel covers at a depth in front of a perspective camera.
   * @param {number} fov the camera's vertical field of view, degrees
   * @param {number} depth distance along the view, world units
   * @param {number} rows texel rows of the picture
   * @returns {number}
   */
  const texelAt = (fov, depth, rows) => (2 * Math.tan((fov / 2) * RADIANS) * depth) / rows;

  /**
   * How far to move a point, along the camera's right and up, to stand it on the texel grid at its own depth.
   * A body moved this way crosses the screen in whole texels, so it keeps one outline while it walks.
   * @param {{x: number, y: number, z: number}} viewPoint the point in the camera's space (-z is ahead)
   * @param {number} fov degrees
   * @param {number} rows texel rows of the picture
   * @returns {number[]} [right, up] world units; [0, 0] for a point behind the camera
   * @example
   * const [right, up] = Kit.pixelGrid.snapShift(point.copy(root.position).applyMatrix4(camera.matrixWorldInverse), camera.fov, grid.rows);
   */
  const snapShift = (viewPoint, fov, rows) => {
    const texel = texelAt(fov, -viewPoint.z, rows);
    if (!(texel > 0)) return [0, 0];
    return [Kit.look.snapToTexel(viewPoint.x, texel) - viewPoint.x, Kit.look.snapToTexel(viewPoint.y, texel) - viewPoint.y];
  };

  Kit.pixelGrid = { GRAINS, fit, settings, texelAt, snapShift };
})();
