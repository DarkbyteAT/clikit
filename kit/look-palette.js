/**
 * Kit look palette: the colour model behind the stylised look. Shading never invents RGB: a pixel is
 * (ramp, tone), and colour appears only when that pair is looked up in a small table.
 *
 * Owns:  OKLCH conversion; building a ramp of 2-6 tones from one base colour with hue-shifted shadows and
 *        highlights (`Kit.look.ramp`); named palettes of ramps (`Kit.look.palette`, `Kit.look.PALETTES`); the
 *        packed tone x ramp table that becomes the palette texture (`Kit.look.atlas`); the band lookup and
 *        ordered-dither tables the shaders mirror (`bandOf`, `edgesFor`, `bayerAt`); the grid helpers of pixel
 *        mode (`snapToTexel`, `stepYaw`, `texelScale`); smooth outline normals (`weldNormals`); and the presets
 *        and knobs as data (`PRESETS`, `KNOBS`, `settings`).
 * Does not own: textures, materials or passes (look-toon.js, look-ink.js), the frame (look-view.js), or what a
 *        ramp is used for (the caller names its ramps: skin, cloth, blade).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  // ---- tunables --------------------------------------------------------------------------------------------------------

  /** Width of the packed table in texels: six tone columns, one spare, and the ink column last. A power of two. */
  const TONE_SLOTS = 8;
  /** Column that holds a ramp's outline colour. */
  const INK_COLUMN = 7;
  const MIN_TONES = 2;
  const MAX_TONES = 6;
  const CHANNELS = 4;
  const BYTE_MAX = 255;
  const FULL_TURN = 360;
  const DEFAULT_ATLAS_ROWS = 64;
  /** Bisection steps when pulling a colour back into the sRGB gamut: 2^-14 of the chroma is below one byte. */
  const GAMUT_STEPS = 14;
  /** A linear channel may leave 0..1 by this much before the colour counts as out of gamut (rounding noise). */
  const GAMUT_SLACK = 0.0005;

  /**
   * @typedef {Object} RampShape
   * How a ramp departs from its base colour. Angles are OKLCH hue degrees (blue is near 264, yellow near 100).
   * @property {number} shadowDepth share of the base lightness the darkest tone loses, 0..1
   * @property {number} shadowCurve exponent of the darkening: below 1 spends the darkness early, above 1 late
   * @property {number} highlightLift share of the distance to white the lightest tone climbs, 0..1
   * @property {number} highlightMaxStep most lightness the highlight gains, so a dark base does not get a chalk-white glint
   * @property {number} shadowHue hue the shadows lean toward
   * @property {number} shadowHueShift most degrees the darkest tone turns toward `shadowHue`
   * @property {number} highlightHue hue the highlight leans toward
   * @property {number} highlightHueShift most degrees the highlight turns toward `highlightHue`
   * @property {number} shadowChroma chroma multiplier of the darkest tone (above 1: richer shadows)
   * @property {number} highlightChroma chroma multiplier of the highlight (below 1: paler highlights)
   * @property {number} neutralChroma chroma given to the ends of a ramp whose base is a grey, so greys still lean cool and warm
   * @property {number} inkDepth lightness of the ink colour as a share of the darkest tone
   * @property {number} inkFloor lowest ink lightness, so ink on a black ramp is still a colour and not a hole
   */

  /**
   * Defaults chosen by eye against the linear formula this replaces (shadow = base * 0.66 + violet * 0.16):
   * equal lightness steps in OKLCH read as equal steps, where equal RGB steps crush the darks.
   * @type {RampShape}
   */
  const RAMP_SHAPE = {
    shadowDepth: 0.5,
    shadowCurve: 0.9,
    highlightLift: 0.42,
    highlightMaxStep: 0.13,
    shadowHue: 285,
    shadowHueShift: 26,
    highlightHue: 95,
    highlightHueShift: 14,
    shadowChroma: 1.12,
    highlightChroma: 0.7,
    neutralChroma: 0.02,
    inkDepth: 0.55,
    inkFloor: 0.12,
  };
  /** Below this chroma a colour has no usable hue of its own. */
  const NEUTRAL_CHROMA = 0.015;
  /** The highlight is always at least this much lighter than the base (OKLCH lightness), even for near-white bases. */
  const MIN_HIGHLIGHT_STEP = 0.03;

  // Björn Ottosson's OKLab matrices (https://bottosson.github.io/posts/oklab/): linear sRGB -> cone response -> Lab, and back.
  const RGB_TO_CONE = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
  ];
  const CONE_TO_LAB = [
    [0.2104542553, 0.793617785, -0.0040720468],
    [1.9779984951, -2.428592205, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.808675766],
  ];
  const LAB_TO_CONE = [
    [1, 0.3963377774, 0.2158037573],
    [1, -0.1055613458, -0.0638541728],
    [1, -0.0894841775, -1.291485548],
  ];
  const CONE_TO_RGB = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
  ];
  // The sRGB transfer curve (IEC 61966-2-1): a linear toe below the knee, a 2.4 power above it.
  const SRGB = { knee: 0.04045, linearKnee: 0.0031308, slope: 12.92, offset: 0.055, gamma: 2.4 };

  /**
   * Band edges on the light value n.L (-1 facing away .. 1 facing the light), by tone count. A pixel's tone is
   * the number of edges at or below its light. The top edge is high so the highlight stays a small accent.
   * @type {Record<number, number[]>}
   */
  const BAND_EDGES = {
    2: [0.1],
    3: [0.1, 0.62],
    4: [-0.2, 0.1, 0.62],
    5: [-0.35, -0.05, 0.25, 0.66],
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

  // ---- colour space ----------------------------------------------------------------------------------------------------

  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const multiply = (matrix, vector) => matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
  const toLinear = (encoded) => (encoded <= SRGB.knee ? encoded / SRGB.slope : ((encoded + SRGB.offset) / (1 + SRGB.offset)) ** SRGB.gamma);
  const toEncoded = (linear) => (linear <= SRGB.linearKnee ? linear * SRGB.slope : (1 + SRGB.offset) * linear ** (1 / SRGB.gamma) - SRGB.offset);
  const toByte = (encoded) => Math.round(clamp01(encoded) * BYTE_MAX);

  /**
   * Reads a colour as three sRGB bytes.
   * @param {string|number|number[]} color '#rrggbb', 0xRRGGBB, or [red, green, blue] bytes
   * @returns {number[]} [red, green, blue], 0..255
   * @example Kit.look.rgbOf('#ff8000') // [255, 128, 0]
   */
  const rgbOf = (color) => {
    if (Array.isArray(color)) return color.slice(0, 3);
    const packed = typeof color === 'string' ? Number.parseInt(color.replace('#', ''), 16) : color;
    if (!Number.isFinite(packed)) throw new Error(`Kit.look.rgbOf: "${color}" is not a colour. Use '#rrggbb', 0xRRGGBB or [red, green, blue].`);
    return [(packed >> 16) & BYTE_MAX, (packed >> 8) & BYTE_MAX, packed & BYTE_MAX];
  };

  /**
   * Writes three sRGB bytes as '#rrggbb'.
   * @param {number[]} rgb [red, green, blue], 0..255
   * @returns {string}
   */
  const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

  /**
   * Converts sRGB bytes to OKLCH: perceptual lightness, chroma and hue.
   * @param {number[]} rgb [red, green, blue], 0..255
   * @returns {{lightness: number, chroma: number, hue: number}} lightness 0..1, chroma 0..about 0.4, hue in degrees 0..360
   */
  const toOklch = (rgb) => {
    const cone = multiply(
      RGB_TO_CONE,
      rgb.map((channel) => toLinear(channel / BYTE_MAX))
    ).map(Math.cbrt);
    const [lightness, greenRed, blueYellow] = multiply(CONE_TO_LAB, cone);
    const hue = (Math.atan2(blueYellow, greenRed) * (FULL_TURN / 2)) / Math.PI;
    return { lightness, chroma: Math.hypot(greenRed, blueYellow), hue: (hue + FULL_TURN) % FULL_TURN };
  };

  /** OKLCH to linear sRGB channels, which may lie outside 0..1 when the colour is out of gamut. */
  const oklchToLinear = ({ lightness, chroma, hue }) => {
    const radians = (hue * Math.PI * 2) / FULL_TURN;
    const cone = multiply(LAB_TO_CONE, [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)]).map((root) => root ** 3);
    return multiply(CONE_TO_RGB, cone);
  };
  const isInGamut = (linear) => linear.every((channel) => channel >= -GAMUT_SLACK && channel <= 1 + GAMUT_SLACK);

  /**
   * Converts OKLCH to sRGB bytes. A colour the screen cannot show keeps its lightness and hue and gives up
   * chroma until it fits (bisection), so a ramp's lightness steps survive the conversion.
   * @param {{lightness: number, chroma: number, hue: number}} color
   * @returns {number[]} [red, green, blue], 0..255
   * @complexity O(1): at most 14 bisection steps
   */
  const fromOklch = (color) => {
    const bounded = { ...color, lightness: clamp01(color.lightness) };
    let linear = oklchToLinear(bounded);
    if (!isInGamut(linear)) {
      let [inside, outside] = [0, bounded.chroma];
      for (let step = 0; step < GAMUT_STEPS; step++) {
        const middle = (inside + outside) / 2;
        if (isInGamut(oklchToLinear({ ...bounded, chroma: middle }))) inside = middle;
        else outside = middle;
      }
      linear = oklchToLinear({ ...bounded, chroma: inside });
    }
    return linear.map((channel) => toByte(toEncoded(clamp01(channel))));
  };

  /** Turns `hue` toward `target` by at most `degrees`, the short way round, never past the target. */
  const turnHue = (hue, target, degrees) => {
    const gap = ((target - hue + FULL_TURN * 1.5) % FULL_TURN) - FULL_TURN / 2;
    return (hue + Math.sign(gap) * Math.min(Math.abs(gap), degrees) + FULL_TURN) % FULL_TURN;
  };

  // ---- ramps -----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} RampSpec
   * One ramp: either generated from a base colour, or authored tone by tone.
   * @property {string|number} [base] the colour of an ordinarily lit surface; the ramp is built around it
   * @property {Array<string|number>} [tones] authored tones, darkest first (2 or more); resampled to the tone count asked for
   * @property {string|number} [ink] outline colour; derived from the darkest tone when left out
   * @property {Partial<RampShape>} [shape] overrides of RAMP_SHAPE for this ramp
   */

  /**
   * @typedef {Object} Ramp
   * @property {number[][]} tones [red, green, blue] bytes, darkest first
   * @property {number[]} ink [red, green, blue] bytes of the outline colour
   */

  /** Index of the base colour in a ramp: the second-lightest tone, so exactly one tone is a highlight. */
  const baseToneIndex = (toneCount) => Math.max(1, toneCount - 2);

  /** The ink colour of a ramp: its darkest tone, darker still and turned further toward the shadow hue. */
  const inkOf = (darkest, shape) => {
    const tone = toOklch(darkest);
    return fromOklch({
      lightness: Math.max(Math.min(shape.inkFloor, tone.lightness), tone.lightness * shape.inkDepth),
      chroma: tone.chroma,
      hue: turnHue(tone.hue, shape.shadowHue, shape.shadowHueShift / 2),
    });
  };

  /** One generated tone: `shade` is 0 at the base and 1 at the darkest tone; `shine` is 1 at the highlight. */
  const toneAround = (base, shape, shade, shine) => {
    const isNeutral = base.chroma < NEUTRAL_CHROMA;
    if (shade > 0) {
      return fromOklch({
        lightness: base.lightness * (1 - shape.shadowDepth * shade ** shape.shadowCurve),
        // A grey has no hue to turn, so it takes the shadow hue outright and a trace of chroma.
        chroma: isNeutral ? base.chroma + shape.neutralChroma * shade : base.chroma * (1 + (shape.shadowChroma - 1) * shade),
        hue: isNeutral ? shape.shadowHue : turnHue(base.hue, shape.shadowHue, shape.shadowHueShift * shade),
      });
    }
    return fromOklch({
      lightness: Math.min(1, Math.max(base.lightness + MIN_HIGHLIGHT_STEP, base.lightness + Math.min(shape.highlightMaxStep, (1 - base.lightness) * shape.highlightLift) * shine)),
      chroma: isNeutral ? base.chroma + shape.neutralChroma * shine : base.chroma * (1 + (shape.highlightChroma - 1) * shine),
      hue: isNeutral ? shape.highlightHue : turnHue(base.hue, shape.highlightHue, shape.highlightHueShift * shine),
    });
  };

  /**
   * Builds a ramp of tones, darkest first, plus its ink colour. From a base colour the shadows darken in
   * equal perceptual steps while turning toward a cool hue and gaining a little chroma, and the highlight
   * lightens, warms and pales; the base itself is kept byte-exact. Authored tones are used as given and
   * resampled (nearest) when a different count is asked for.
   * @param {RampSpec|string|number} spec a ramp spec, or just the base colour
   * @param {number} [toneCount=4] 2..6
   * @returns {Ramp}
   * @complexity O(toneCount) time and space
   * @example Kit.look.ramp('#c8453a', 4).tones.map(Kit.look.hexOf) // four reds, from wine shadow to a warm highlight
   */
  const ramp = (spec, toneCount = 4) => {
    if (!Number.isInteger(toneCount) || toneCount < MIN_TONES || toneCount > MAX_TONES)
      throw new Error(`Kit.look.ramp: toneCount must be a whole number from ${MIN_TONES} to ${MAX_TONES}, got ${toneCount}.`);
    /** @type {RampSpec} */
    const rampSpec = spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? /** @type {RampSpec} */ (spec) : { base: /** @type {string|number} */ (spec) };
    const shape = { ...RAMP_SHAPE, ...rampSpec.shape };
    const tones = rampSpec.tones ? resampleTones(rampSpec.tones, toneCount) : generateTones(rampSpec.base, shape, toneCount);
    return { tones, ink: rampSpec.ink === undefined ? inkOf(tones[0], shape) : rgbOf(rampSpec.ink) };
  };

  const resampleTones = (authored, toneCount) => {
    if (!Array.isArray(authored) || authored.length < MIN_TONES) throw new Error(`Kit.look.ramp: "tones" needs at least ${MIN_TONES} colours, darkest first.`);
    return Array.from({ length: toneCount }, (_, index) => rgbOf(authored[Math.round((index * (authored.length - 1)) / (toneCount - 1))]));
  };

  const generateTones = (baseColor, shape, toneCount) => {
    if (baseColor === undefined) throw new Error("Kit.look.ramp: a ramp needs a base colour or a list of tones, e.g. Kit.look.ramp('#c8453a') or { tones: ['#222', '#888'] }.");
    const baseRgb = rgbOf(baseColor);
    const base = toOklch(baseRgb);
    const baseIndex = baseToneIndex(toneCount);
    return Array.from({ length: toneCount }, (_, index) => {
      if (index === baseIndex) return baseRgb;
      return index < baseIndex ? toneAround(base, shape, (baseIndex - index) / baseIndex, 0) : toneAround(base, shape, 0, (index - baseIndex) / (toneCount - 1 - baseIndex));
    });
  };

  // ---- palettes and the packed table -----------------------------------------------------------------------------------

  /**
   * @typedef {Object} Palette
   * A named set of ramps. Palettes with the same ramp names in the same order are interchangeable.
   * @property {string} name
   * @property {string[]} rampIds ramp names, in row order
   * @property {Record<string, RampSpec|string|number>} ramps ramp name -> spec or base colour
   */

  /**
   * Makes a palette from named ramps.
   * @param {string} name
   * @param {Record<string, RampSpec|string|number>} ramps ramp name -> spec or base colour; the key order is the row order
   * @returns {Palette}
   * @example const ember = Kit.look.palette('ember', { skin: '#e9b48c', cloth: '#c8453a', eye: { tones: ['#1b1626', '#f4f0ff'] } });
   */
  const palette = (name, ramps) => {
    const rampIds = Object.keys(ramps || {});
    if (!rampIds.length) throw new Error(`Kit.look.palette("${name}"): a palette needs at least one ramp, e.g. { skin: '#e9b48c' }.`);
    return { name, rampIds, ramps: { ...ramps } };
  };

  /**
   * @typedef {Object} PaletteBlock
   * The rows one palette occupies in an atlas. A material stores `rows[rampId]` and nothing else about colour.
   * @property {number} offset first row
   * @property {string[]} rampIds ramp names in row order
   * @property {Record<string, number>} rows ramp name -> absolute row in the atlas
   */

  /**
   * @typedef {Object} PaletteAtlas
   * The packed table: `width` tone columns by `height` ramp rows of RGBA bytes, ready to be a texture.
   * @property {number} width texels per row (8: tones 0..5, a spare, ink)
   * @property {number} height rows
   * @property {Uint8Array} data RGBA bytes, row by row
   * @property {number} toneCount tones currently written per ramp
   * @property {number} version rises with every write, so a texture knows when to upload again
   * @property {function(Palette): PaletteBlock} load reserve rows for a palette and write them
   * @property {function(PaletteBlock, Palette): void} write replace a block's colours with another palette of the same ramps
   * @property {function(PaletteBlock, string, RampSpec|string|number): void} writeRamp replace one ramp of a block
   * @property {function(number): void} retone rebuild every loaded block at a new tone count
   * @property {function(number, number): number[]} colorAt (row, column) -> [red, green, blue]
   */

  /**
   * Creates the packed palette table. Each loaded palette gets a block of rows; a character's materials point
   * at rows, so recolouring a character is rewriting its rows (no material is touched), and two characters
   * with different palettes are two blocks of one table.
   * @param {{rows?: number, toneCount?: number}} [options] `rows` is the capacity in ramps (default 64); `toneCount` 2..6 (default 4)
   * @returns {PaletteAtlas}
   * @complexity load / write: O(ramps in the palette); writeRamp: O(1); retone: O(rows in use); space O(rows)
   * @example
   * const atlas = Kit.look.atlas();
   * const hero = atlas.load(Kit.look.PALETTES.ember);   // hero.rows.skin is the row a skin material stores
   * atlas.write(hero, Kit.look.PALETTES.tide);          // the hero is recoloured; nothing else changes
   */
  const atlas = (options = {}) => {
    const height = options.rows || DEFAULT_ATLAS_ROWS;
    const data = new Uint8Array(TONE_SLOTS * height * CHANNELS);
    const loaded = [];
    let rowsInUse = 0;

    const writeTexel = (row, column, rgb) => data.set([rgb[0], rgb[1], rgb[2], BYTE_MAX], (row * TONE_SLOTS + column) * CHANNELS);
    const writeRow = (row, spec) => {
      const built = ramp(spec, table.toneCount);
      // Columns past the tone count repeat the lightest tone, so a stale tone index can never read garbage.
      for (let column = 0; column < INK_COLUMN; column++) writeTexel(row, column, built.tones[Math.min(column, built.tones.length - 1)]);
      writeTexel(row, INK_COLUMN, built.ink);
    };
    const requireSameRamps = (block, source) => {
      if (source.rampIds.join() !== block.rampIds.join())
        throw new Error(
          `Kit.look.atlas.write: palette "${source.name}" has ramps [${source.rampIds}], but the block was loaded with [${block.rampIds}]. Interchangeable palettes list the same ramps in the same order.`
        );
    };

    const table = {
      width: TONE_SLOTS,
      height,
      data,
      toneCount: options.toneCount || 4,
      version: 0,
      load(source) {
        if (rowsInUse + source.rampIds.length > height)
          throw new Error(`Kit.look.atlas.load: no room for "${source.name}" (${rowsInUse} of ${height} rows used). Create the atlas with more rows: Kit.look.atlas({ rows: ${height * 2} }).`);
        const block = { offset: rowsInUse, rampIds: source.rampIds.slice(), rows: Object.fromEntries(source.rampIds.map((id, index) => [id, rowsInUse + index])) };
        rowsInUse += source.rampIds.length;
        loaded.push({ block, source });
        table.write(block, source);
        return block;
      },
      write(block, source) {
        requireSameRamps(block, source);
        source.rampIds.forEach((id) => writeRow(block.rows[id], source.ramps[id]));
        loaded.find((entry) => entry.block === block).source = source;
        table.version += 1;
      },
      writeRamp(block, rampId, spec) {
        if (!(rampId in block.rows)) throw new Error(`Kit.look.atlas.writeRamp: the block has no ramp "${rampId}" (it has ${block.rampIds}).`);
        const entry = loaded.find((candidate) => candidate.block === block);
        // The source is copied before it changes, so a shared named palette is never edited in place.
        entry.source = { ...entry.source, ramps: { ...entry.source.ramps, [rampId]: spec } };
        writeRow(block.rows[rampId], spec);
        table.version += 1;
      },
      retone(toneCount) {
        table.toneCount = toneCount;
        loaded.forEach(({ block, source }) => source.rampIds.forEach((id) => writeRow(block.rows[id], source.ramps[id])));
        table.version += 1;
      },
      colorAt: (row, column) => Array.from(data.subarray((row * TONE_SLOTS + column) * CHANNELS, (row * TONE_SLOTS + column) * CHANNELS + 3)),
    };
    return table;
  };

  /** The contact shadow under a figure: one flat colour whatever the tone. */
  const GROUND = { tones: ['#3f4870', '#3f4870'] };
  /** @type {Array<[string, Record<string, RampSpec|string>]>} */
  const PALETTE_ROWS = [
    [
      'ember',
      { skin: '#e9b48c', hair: '#8a3b2a', cloth: '#c8453a', trim: '#f0c05a', leather: '#6b4630', metal: '#a9b4c2', eye: { tones: ['#1b1626', '#3a2f4a', '#f6f1ff'] }, glow: '#ffd76a', ground: GROUND },
    ],
    [
      'tide',
      { skin: '#c98f6b', hair: '#2f3e63', cloth: '#2f8f9d', trim: '#e8e2c6', leather: '#3d4a5c', metal: '#c7b98f', eye: { tones: ['#101a2b', '#24405c', '#eafcff'] }, glow: '#7ff5e1', ground: GROUND },
    ],
    [
      'moss',
      { skin: '#f0cfa8', hair: '#d9c27a', cloth: '#5f8f4a', trim: '#b5562f', leather: '#4f3b2c', metal: '#8f9a8a', eye: { tones: ['#1c2416', '#3c4a2c', '#fbffe8'] }, glow: '#c9f27a', ground: GROUND },
    ],
    [
      'dusk',
      { skin: '#a9795f', hair: '#e6e1f0', cloth: '#5b4a8c', trim: '#e07a9a', leather: '#2e2a3d', metal: '#d6a85c', eye: { tones: ['#160f24', '#3b2a5c', '#fff0fa'] }, glow: '#ff9ad1', ground: GROUND },
    ],
  ];
  /**
   * Named palettes for a humanoid: the same nine ramps in the same order, so any of them recolours any character.
   * `eye` is authored (a dark pupil tone and a light glint); `ground` is the contact shadow under a figure, one
   * flat colour whatever the tone.
   * @type {Record<string, Palette>}
   */
  const PALETTES = Object.fromEntries(PALETTE_ROWS.map(([name, ramps]) => [name, palette(name, ramps)]));

  // ---- bands and dither (the shaders in look-toon.js compute exactly these) ---------------------------------------------

  /**
   * The tone of a light value: how many band edges lie at or below it.
   * @param {number} light n.L, -1..1 (plus any dither offset)
   * @param {number[]} edges ascending band edges
   * @returns {number} tone index, 0 (darkest) .. edges.length
   * @complexity O(edges)
   * @example Kit.look.bandOf(0.1, [0.1, 0.62]) // 1: a value on an edge belongs to the lighter band
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

  Kit.look = {
    TONE_SLOTS,
    INK_COLUMN,
    MAX_EDGES,
    RAMP_SHAPE,
    BAND_EDGES,
    BAYER_4,
    PALETTES,
    PRESETS,
    KNOBS,
    rgbOf,
    hexOf,
    toOklch,
    fromOklch,
    ramp,
    palette,
    atlas,
    bandOf,
    edgesFor,
    bayerAt,
    snapToTexel,
    stepYaw,
    texelScale,
    weldNormals,
    settings,
  };
})();
