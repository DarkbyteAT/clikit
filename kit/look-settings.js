/**
 * Kit look settings: the look as data and small pure functions. What a tone band is, how dither thresholds are
 * laid out, how a figure sits on a texel grid, and the three presets with the knobs each exposes.
 *
 * Owns:  the band lookup and ordered-dither tables the shaders mirror (`bandOf`, `edgesFor`, `bayerAt`); the grid
 *        helpers of pixel mode (`snapToTexel`, `stepYaw`, `texelScale`); smooth outline normals (`weldNormals`);
 *        and the presets and knobs (`PRESETS`, `KNOBS`, `settings`).
 * Does not own: colour (kit/palette.js: ramps, tones and the packed atlas), textures, materials or passes
 *        (look-toon.js, look-ink.js), or the frame (look-view.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { MIN_TONES, MAX_TONES } = Kit.palette;

  /**
   * Band edges on the light value n.L (-1 facing away .. 1 facing the light), by tone count. A pixel's tone is
   * the number of edges at or below its light. The top edge is high so the highlight stays a small accent, and
   * the shadow edges sit below zero so a face turned a little from the light is not half dark.
   * @type {Record<number, number[]>}
   */
  const BAND_EDGES = {
    2: [0],
    3: [-0.05, 0.62],
    4: [-0.3, 0.05, 0.62],
    5: [-0.4, -0.1, 0.25, 0.66],
    6: [-0.45, -0.2, 0.05, 0.3, 0.68],
  };
  /** An edge no light value reaches: pads the shader's fixed-length edge array. */
  const UNUSED_EDGE = 9;
  const MAX_EDGES = MAX_TONES - 1;

  /** The 4 x 4 ordered-dither matrix (thresholds 0..15), row by row. */
  const BAYER_4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const BAYER_SIZE = 4;
  const BAYER_LEVELS = 16;

  // ---- bands and dither (the shaders in look-toon.js compute exactly these) ---------------------------------------------

  /**
   * The tone of a light value: how many band edges lie at or below it.
   * @param {number} light n.L, -1..1 (plus any dither offset)
   * @param {number[]} edges ascending band edges
   * @returns {number} tone index, 0 (darkest) .. edges.length
   * @complexity O(edges)
   * @example Kit.look.bandOf(-0.05, [-0.05, 0.62]) // 1: a value on an edge belongs to the lighter band
   */
  const bandOf = (light, edges) => edges.reduce((tone, edge) => tone + (light >= edge ? 1 : 0), 0);

  /**
   * The default band edges for a tone count, padded to the shader's fixed length with an unreachable edge.
   * @param {number} toneCount 2..6
   * @returns {number[]} five numbers: `toneCount - 1` real edges, then padding
   */
  const edgesFor = (toneCount) => {
    if (!BAND_EDGES[toneCount]) throw new Error(`Kit.look.edgesFor: no band edges for ${toneCount} tones; use ${MIN_TONES}..${MAX_TONES}.`);
    return Array.from({ length: MAX_EDGES }, (_, index) => (index < toneCount - 1 ? BAND_EDGES[toneCount][index] : UNUSED_EDGE));
  };

  /**
   * The ordered-dither threshold of a pixel, 0..1, repeating every 4 pixels both ways.
   * @param {number} column pixel x (any integer)
   * @param {number} row pixel y (any integer)
   * @returns {number} one of 0, 1/16 .. 15/16
   * @example const adjusted = light + (Kit.look.bayerAt(x, y) - 0.5) * 0.12;
   */
  const bayerAt = (column, row) => BAYER_4[((row % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE][((column % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE] / BAYER_LEVELS;

  // ---- pixel-grid helpers ----------------------------------------------------------------------------------------------

  /**
   * Rounds a coordinate to the texel grid, so a sprite moves by whole texels and keeps one shape while it moves.
   * @param {number} value a coordinate along a screen axis, world units
   * @param {number} texelSize world units one texel covers
   * @returns {number} the nearest multiple of texelSize
   */
  const snapToTexel = (value, texelSize) => (texelSize > 0 ? Math.round(value / texelSize) * texelSize : value);

  /**
   * Rounds a turn to one of `steps` facings, like the 8 or 16 drawn directions of a sprite sheet.
   * @param {number} angle radians
   * @param {number} steps facings per full turn; 0 leaves the angle alone
   * @returns {number} radians
   */
  const stepYaw = (angle, steps) => (steps > 0 ? Math.round((angle * steps) / (Math.PI * 2)) * ((Math.PI * 2) / steps) : angle);

  /**
   * How many screen pixels one texel covers when a view is drawn at about `rows` texels tall: always a whole
   * number, because a fractional upscale makes texels of uneven size.
   * @param {number} bufferHeight height of the screen buffer, device pixels
   * @param {number} rows wanted internal height in texels; 0 means native resolution
   * @returns {number} whole pixels per texel, 1 or more
   */
  const texelScale = (bufferHeight, rows) => (rows > 0 ? Math.max(1, Math.round(bufferHeight / rows)) : 1);

  /**
   * Averages the normals of vertices that share a position. An inverted-hull outline pushes vertices along
   * their normals; where a mesh has hard edges (a box, a cylinder's cap) the copies of a corner would part
   * and open a gap in the line, so the hull uses these welded normals instead.
   * @param {ArrayLike<number>} positions x, y, z per vertex
   * @param {ArrayLike<number>} normals x, y, z per vertex
   * @param {number} [tolerance=1e-4] positions closer than this (per axis) count as the same point
   * @returns {Float32Array} x, y, z per vertex, unit length
   * @complexity O(vertices) time and space (one hash lookup per vertex)
   */
  const weldNormals = (positions, normals, tolerance = 1e-4) => {
    const vertexCount = positions.length / 3;
    const keyOf = (vertex) => [0, 1, 2].map((axis) => Math.round(positions[vertex * 3 + axis] / tolerance)).join(',');
    const sums = new Map();
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const key = keyOf(vertex);
      const sum = sums.get(key) || sums.set(key, [0, 0, 0]).get(key);
      for (let axis = 0; axis < 3; axis++) sum[axis] += normals[vertex * 3 + axis];
    }
    const welded = new Float32Array(positions.length);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const sum = sums.get(keyOf(vertex));
      // Opposite normals cancel to nothing (a paper-thin shape): keep the vertex's own normal there.
      const length = Math.hypot(sum[0], sum[1], sum[2]);
      for (let axis = 0; axis < 3; axis++) welded[vertex * 3 + axis] = length > tolerance ? sum[axis] / length : normals[vertex * 3 + axis];
    }
    return welded;
  };

  // ---- presets and knobs -----------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} LookSettings
   * Everything that decides how a view draws. Plain data: store it, diff it, send it.
   * @property {number} toneCount tones per ramp, 2..6 (the band count)
   * @property {number} dither strength of the ordered dither on the light value, 0 (off) .. 0.3
   * @property {'screen'|'anchored'|'object'} ditherSpace what the dither pattern is fixed to: the screen, the
   *   figure's snapped screen position, or the surface itself
   * @property {number} softness half-width of the blend across a band edge, in light units; 0 is a hard edge.
   *   Only drawn at native resolution without screen-space ink (tone indices cannot be blended)
   * @property {'none'|'hull'|'ink'} outline no lines, an inverted hull per mesh, or screen-space ink over an index target
   * @property {number} inkWidth hull line width, CSS pixels (screen-space ink is always one texel)
   * @property {number} pixelRows internal height in texels; 0 is native resolution
   * @property {boolean} snap move figures by whole texels when drawn below native resolution
   * @property {number} yawSteps facings per turn a caller should round a figure's turn to (see stepYaw); 0 is continuous
   * @property {boolean} rim lift grazing, lit edges one tone
   */

  /**
   * The three looks, as data. `label` and `about` are for an editor; the rest are LookSettings.
   * @type {Record<string, LookSettings & {label: string, about: string}>}
   */
  const PRESETS = {
    toon: {
      label: 'Toon',
      about: 'Three flat tones and a bold hull line: classic cel shading.',
      toneCount: 3,
      dither: 0,
      ditherSpace: 'screen',
      softness: 0,
      outline: 'hull',
      inkWidth: 2.5,
      pixelRows: 0,
      snap: false,
      yawSteps: 0,
      rim: false,
    },
    pixel: {
      label: 'Pixel',
      about: 'Four tones at low resolution, dithered edges and one-texel ink.',
      toneCount: 4,
      dither: 0.12,
      ditherSpace: 'anchored',
      softness: 0,
      outline: 'ink',
      inkWidth: 1,
      pixelRows: 195,
      snap: true,
      yawSteps: 24,
      rim: true,
    },
    soft: {
      label: 'Soft toon',
      about: 'Five tones with softened edges, a thin line and a rim.',
      toneCount: 5,
      dither: 0,
      ditherSpace: 'screen',
      softness: 0.045,
      outline: 'hull',
      inkWidth: 1.5,
      pixelRows: 0,
      snap: false,
      yawSteps: 0,
      rim: true,
    },
  };

  /**
   * @typedef {Object} LookKnob
   * @property {string} id the LookSettings field it edits
   * @property {string} label
   * @property {'choice'|'range'|'toggle'} type
   * @property {Array<{value: *, label: string}>} [options] for a choice
   * @property {number} [min] for a range
   * @property {number} [max] for a range
   * @property {number} [step] for a range
   */

  /** @type {function(Array<*>, function(*): string=): Array<{value: *, label: string}>} */
  const optionsOf = (values, labelOf = String) => values.map((value) => ({ value, label: labelOf(value) }));
  /**
   * The settings an editor can offer, in display order. Adding a knob is adding a row.
   * @type {LookKnob[]}
   */
  const KNOBS = [
    { id: 'toneCount', label: 'Bands', type: 'choice', options: optionsOf([2, 3, 4, 5, 6]) },
    { id: 'outline', label: 'Outline', type: 'choice', options: optionsOf(['none', 'hull', 'ink'], (mode) => ({ none: 'None', hull: 'Hull', ink: 'Ink' })[mode]) },
    { id: 'pixelRows', label: 'Resolution', type: 'choice', options: optionsOf([0, 260, 195, 130, 98], (rows) => (rows ? `${rows} rows` : 'Native')) },
    { id: 'dither', label: 'Dither', type: 'range', min: 0, max: 0.3, step: 0.02 },
    {
      id: 'ditherSpace',
      label: 'Dither fixed to',
      type: 'choice',
      options: optionsOf(['screen', 'anchored', 'object'], (space) => ({ screen: 'Screen', anchored: 'Figure', object: 'Surface' })[space]),
    },
    { id: 'softness', label: 'Edge softness', type: 'range', min: 0, max: 0.12, step: 0.005 },
    { id: 'inkWidth', label: 'Line width', type: 'range', min: 0.5, max: 5, step: 0.5 },
    { id: 'yawSteps', label: 'Facings', type: 'choice', options: optionsOf([0, 8, 16, 24], (steps) => (steps ? String(steps) : 'Smooth')) },
    { id: 'snap', label: 'Snap to texels', type: 'toggle' },
    { id: 'rim', label: 'Rim light', type: 'toggle' },
  ];

  /**
   * Resolves a preset plus overrides into complete settings.
   * @param {string} presetId a key of PRESETS
   * @param {Partial<LookSettings>} [overrides] knob values that differ from the preset
   * @returns {LookSettings & {preset: string, isIndexed: boolean}} `isIndexed`: the view draws tone indices into
   *   a target and resolves colour afterwards (needed for screen-space ink and for any resolution below native)
   * @example Kit.look.settings('pixel', { toneCount: 5 }).isIndexed // true
   */
  const settings = (presetId, overrides = {}) => {
    const preset = PRESETS[presetId];
    if (!preset) throw new Error(`Kit.look.settings: no preset "${presetId}". Presets: ${Object.keys(PRESETS).join(', ')}.`);
    const { label, about, ...defaults } = preset;
    const merged = { ...defaults, ...overrides };
    if (!BAND_EDGES[merged.toneCount]) throw new Error(`Kit.look.settings: toneCount must be ${MIN_TONES}..${MAX_TONES}, got ${merged.toneCount}.`);
    return { ...merged, preset: presetId, isIndexed: merged.outline === 'ink' || merged.pixelRows > 0 };
  };

  Kit.look = { MAX_EDGES, BAND_EDGES, BAYER_4, PRESETS, KNOBS, bandOf, edgesFor, bayerAt, snapToTexel, stepYaw, texelScale, weldNormals, settings };
})();
