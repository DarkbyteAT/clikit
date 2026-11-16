/**
 * Kit look settings: the look as data and small pure functions. What a tone band is, how dither thresholds are
 * laid out, how a figure sits on a texel grid, and the three presets with the knobs each exposes.
 *
 * Owns:  the band lookup, the light value and the ordered-dither tables the shaders mirror (`bandOf`, `lightOf`,
 *        `edgesFor`, `bayerAt`); the grid
 *        helpers of pixel mode (`snapToTexel`, `stepYaw`, `texelScale`); how big a texel is where a thing is drawn and
 *        what a stamp does about it (`texelSlope`, `texelWorldAt`, `stampGrowth`); smooth outline normals (`weldNormals`);
 *        the lights and how kinds of surface answer them (`LIGHTING`, `RESPONSES`); and the presets and knobs
 *        (`PRESETS`, `KNOBS`, `settings`).
 * Does not own: colour (kit/palette.js: ramps, tones and the packed atlas), textures, materials or passes
 *        (look-toon.js, look-ink.js), or the frame (look-view.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { MIN_TONES, MAX_TONES } = Kit.palette;

  /**
   * Band edges on the light value n.L (-1 facing away .. 1 facing the light), by tone count. A pixel's tone is
   * the number of edges at or below its light. The edges are placed by what they leave of a ball under the key
   * light of `LIGHTING`: about an eighth of its disc in highlight, a fifth in shadow (a crescent, with the deeper
   * tones of higher counts nested inside it) and the rest, well over half, in the ramp's own colour: two or
   * three clean tones on a large form. The second-lightest band (the ramp's own colour) always contains
   * `LIGHTING.fillCap`, which is what lets the fill light lift a face to its own colour and no further.
   * tools/test-looks.js measures both.
   * @type {Record<number, number[]>}
   */
  const BAND_EDGES = {
    2: [0.1],
    3: [0.1, 0.91],
    4: [-0.25, 0.1, 0.91],
    5: [-0.3, 0, 0.3, 0.91],
    6: [-0.35, -0.1, 0.1, 0.32, 0.91],
  };

  /**
   * The lights of the look, in view space (x right, y up, z toward the viewer), so they keep their place on
   * screen as the camera or a figure turns: a figure is lit the same from all eight directions.
   *  - `key`: from the upper left and well in front, so what faces the viewer is lit and the shadow is a
   *    crescent down the right and under overhangs, never a half.
   *  - `fill`: almost the viewer's own direction. It never brightens past `fillCap` (a light value inside the
   *    ramp's own colour band), so it can lift a shadow off a surface but cannot add a highlight. How much of it
   *    a surface takes is the surface's response (`RESPONSES`).
   *  - `back`: from behind, to the right and a little below. With `bounce` on, shadowed surface that faces it
   *    (the far-side silhouette) is lifted one tone, which keeps a figure's dark side off a dark backdrop.
   *  - `rim`: with `rim` on, lit surface seen edge-on is lifted one tone.
   */
  const LIGHTING = Object.freeze({
    key: Object.freeze([-0.44, 0.52, 0.73]),
    fill: Object.freeze([0.08, 0.16, 0.98]),
    fillCap: 0.5,
    back: Object.freeze([0.74, -0.18, -0.65]),
    bounceEdge: 0.3,
    rim: Object.freeze({ maxFacing: 0.3, minLight: 0.3 }),
  });

  /**
   * @typedef {Object} LightResponse
   * How a kind of surface answers the light.
   * @property {number} fillGain how strongly the fill light follows the surface turning to the viewer
   * @property {number} fillBias added to that; the fill's light value is `fillGain * (n . fill) + fillBias`, capped
   *   at `LIGHTING.fillCap`, and a fragment takes the brighter of key and fill
   * @property {number} dither share of the look's dither the surface takes, 0..1
   */

  /**
   * Responses by name (`LookPart.response`). `form` is everything by default: key light only. `face` is bare
   * skin that carries features: wherever it is turned toward the viewer the fill holds it at its own colour, so
   * eyes, brows and a mouth always sit on a readable tone; only the last sliver before the far silhouette can
   * take the shadow, which keeps the head round. A face is never dithered: a checker of two tones across a
   * cheek reads as stubble.
   * @type {Record<string, LightResponse>}
   */
  const RESPONSES = Object.freeze({
    form: Object.freeze({ fillGain: 0, fillBias: -2, dither: 1 }),
    face: Object.freeze({ fillGain: 2, fillBias: -0.55, dither: 0 }),
  });
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

  const unit = (vector) => {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    return vector.map((component) => component / length);
  };
  const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];

  /**
   * The light value of a surface: the brighter of the key light's n.L and what the surface's response takes of
   * the capped fill light. The fragment shader's `lightOf` is this function.
   * @param {number[]} normal unit normal in view space [right, up, toward the viewer]
   * @param {LightResponse} [response] a row of `RESPONSES` (default: a form)
   * @returns {number} -1..1; pass it to `bandOf`
   * @example Kit.look.bandOf(Kit.look.lightOf([0, 0, 1], Kit.look.RESPONSES.face), Kit.look.edgesFor(3)) // 1: a face seen head-on is its own colour
   */
  const lightOf = (normal, response = RESPONSES.form) =>
    Math.max(dot(normal, unit(LIGHTING.key)), Math.min(response.fillGain * dot(normal, unit(LIGHTING.fill)) + response.fillBias, LIGHTING.fillCap));

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
   * How fast a texel grows with distance under a perspective camera: world units one target texel covers per
   * unit of depth in front of the lens. An orthographic camera has one texel size (`slope` 0); a perspective one
   * has none of its own, only this slope, so anything sized in texels asks at the depth it is drawn.
   * @param {number} fieldOfView the camera's vertical angle, radians
   * @param {number} rows the target's height in texels
   * @returns {number} world units per texel per unit of depth
   * @example Kit.look.texelSlope(Math.PI / 2, 400) * 10 // 0.05: at 10 m a texel of a 400-row picture is 5 cm
   */
  const texelSlope = (fieldOfView, rows) => (2 * Math.tan(fieldOfView / 2)) / rows;

  /**
   * The world size of a target texel at a depth: what the stamp shader (kit/look-toon.js `stampGrowth`) measures a layer in.
   * @param {number} texelWorld the size under an orthographic camera; 0 under a perspective one
   * @param {number} slope `texelSlope` under a perspective camera; 0 under an orthographic one
   * @param {number} depth world units in front of the camera
   * @returns {number} world units; 0 when unknown (both zero) or at the lens
   */
  const texelWorldAt = (texelWorld, slope, depth) => texelWorld + slope * Math.max(0, depth);

  /** A stamp layer below its least size is grown about its centre, but never by more than this: a face must not swallow the head. */
  const STAMP_MOST_GROWTH = 2.5;

  /**
   * How much a stamp layer (an eye, a glint, a mouth) is scaled about its centre so it survives a small sprite:
   * the rule the stamp shader runs per vertex, kept here so it can be tested. A positive `sizeRule` is a least
   * size in texels (the layer is grown until its smaller side covers that many, up to `STAMP_MOST_GROWTH`); a
   * negative one drops the layer below that size (0: it collapses to its centre); 0 leaves it alone.
   * @param {number} halfExtent the layer's smaller half extent, world units (after the model's scale)
   * @param {number} sizeRule texels: positive a least size, negative a size to vanish under
   * @param {number} texelWorld world units a texel covers where the layer is (`texelWorldAt`); 0 when unknown
   * @returns {number} the scale about the centre: 0, or 1..`STAMP_MOST_GROWTH`
   * @example Kit.look.stampGrowth(0.01, 2, 0.02) // 2: a 2 cm eye on 2 cm texels is one texel, and is grown to two
   */
  const stampGrowth = (halfExtent, sizeRule, texelWorld) => {
    const texels = (2 * halfExtent) / Math.max(texelWorld, 1e-9);
    if (sizeRule < 0) return texelWorld > 0 && texels < -sizeRule ? 0 : 1;
    return Math.min(STAMP_MOST_GROWTH, Math.max(1, sizeRule / Math.max(texels, 1e-5)));
  };

  /**
   * How much of a look's dither a frame draws, by the world size of a texel. Dither trades resolution for an
   * extra apparent tone, which pays on a figure large enough to hold the pattern; on a small sprite a 4 x 4
   * checker along every band edge is speckle. It is whole while a texel is finer than `full` world units (a
   * person about 140 texels tall or more) and gone at `none` (about 70 texels tall).
   */
  const DITHER_TEXEL_FADE = Object.freeze({ full: 0.012, none: 0.024 });

  /**
   * The dither strength to draw with.
   * @param {number} dither the look's dither strength (`LookSettings.dither`)
   * @param {number} texelWorld world units one target texel covers; 0 when unknown (a perspective camera): no fade
   * @returns {number} 0..dither
   * @example Kit.look.ditherAt(0.07, 0.018) // 0.035: half way through the fade
   */
  const ditherAt = (dither, texelWorld) => dither * Math.min(1, Math.max(0, (DITHER_TEXEL_FADE.none - texelWorld) / (DITHER_TEXEL_FADE.none - DITHER_TEXEL_FADE.full)));

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
   * @property {number} dither strength of the ordered dither on the light value, 0 (off) .. 0.3; a frame draws less of
   *   it as its texels grow against the figures (`ditherAt`), and none on faces or tightly curved forms
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
   * @property {boolean} bounce lift the shadowed far-side silhouette one tone (a back light)
   */

  /**
   * Hull line width of the native-resolution presets, CSS pixels: one weight, so a character's outline does not
   * change when the look does. (Below native resolution a line is one texel by definition.)
   */
  const LINE_WIDTH = 2;

  /**
   * The three looks, as data. `label` and `about` are for an editor; the rest are LookSettings.
   * @type {Record<string, LookSettings & {label: string, about: string}>}
   */
  const PRESETS = {
    toon: {
      label: 'Toon',
      about: 'Three flat tones and a hull line: classic cel shading.',
      toneCount: 3,
      dither: 0,
      ditherSpace: 'screen',
      softness: 0,
      outline: 'hull',
      inkWidth: LINE_WIDTH,
      pixelRows: 0,
      snap: false,
      yawSteps: 0,
      rim: false,
      bounce: true,
    },
    pixel: {
      label: 'Pixel',
      about: 'Four tones at low resolution, dithered edges and one-texel ink.',
      toneCount: 4,
      dither: 0.07,
      ditherSpace: 'anchored',
      softness: 0,
      outline: 'ink',
      inkWidth: 1,
      pixelRows: 195,
      snap: true,
      yawSteps: 24,
      rim: true,
      bounce: true,
    },
    soft: {
      label: 'Soft toon',
      about: 'Five tones with softened edges, the same line and a rim.',
      toneCount: 5,
      dither: 0,
      ditherSpace: 'screen',
      softness: 0.045,
      outline: 'hull',
      inkWidth: LINE_WIDTH,
      pixelRows: 0,
      snap: false,
      yawSteps: 0,
      rim: true,
      bounce: true,
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
    { id: 'bounce', label: 'Back light', type: 'toggle' },
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

  Kit.look = { MAX_EDGES, BAND_EDGES, LIGHTING, RESPONSES, DITHER_TEXEL_FADE, ditherAt, texelSlope, texelWorldAt, STAMP_MOST_GROWTH, stampGrowth, lightOf, BAYER_4, PRESETS, KNOBS, bandOf, edgesFor, bayerAt, snapToTexel, stepYaw, texelScale, weldNormals, settings };
})();
