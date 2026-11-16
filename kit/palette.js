/**
 * Kit palette: colour ramps as data. A ramp is a short ordered list of shades of one colour, dark to light, with
 * the hue drifting a little along the way (shadows cooler, highlights warmer), which is what makes flat-shaded,
 * toon and pixel art read as lit instead of as one colour with grey mixed in. A renderer picks a shade by how
 * lit a surface is; a character stores only which ramp it uses.
 *
 * Owns:  `Kit.palette.ramp` (build a ramp from a hue), `Kit.palette.shade` (the shade of a ramp for a light
 *        level) and `Kit.palette.toCss`; OKLCH conversion and `Kit.palette.tones` (2-6 perceptually even tones
 *        plus a deep and an ink colour, from one base colour or from an existing ramp, and where along a graded
 *        ramp those tones sit: `TONE_POSITIONS`, `columnAt`); named sets of ramps
 *        (`Kit.palette.set`, `Kit.palette.SETS`); and `Kit.palette.atlas`, the packed tone x ramp table that
 *        becomes the palette texture of the look shaders (kit/look-toon.js). Shading never invents RGB: a pixel
 *        is (ramp row, tone column) and colour appears only when that pair is looked up in the table.
 * Does not own: blending two colours or rows (`Kit.blend`, whose `hsl` this is built on), a game's interface
 *        colours (`Kit.theme`), or which ramps exist (a catalogue's `palettes` table, kit/body-recipe.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Defaults of a generated ramp: five shades from deep shadow to highlight, the hue drifting 4% of the wheel. */
  const RAMP_DEFAULTS = Object.freeze({ saturation: 0.55, shades: 5, hueShift: 0.04, darkest: 0.2, lightest: 0.82 });
  const HEX_DIGITS = 6;
  const HEX_BASE = 16;

  /**
   * A colour number as CSS text.
   * @param {number} color 0xRRGGBB
   * @returns {string} '#rrggbb'
   * @example Kit.palette.toCss(0xff8800) // '#ff8800'
   */
  const toCss = (color) => `#${color.toString(HEX_BASE).padStart(HEX_DIGITS, '0')}`;

  /**
   * @typedef {Object} Ramp
   * @property {string} id name of the ramp ('umber', 'teal')
   * @property {string[]} shades CSS colours, darkest first
   */

  /**
   * Builds a ramp from a hue: evenly spaced lightness from `darkest` to `lightest`, the hue moving by `hueShift`
   * across the ramp (negative at the dark end, positive at the light end) and the saturation easing off towards
   * the highlights.
   * @param {string} id name for the ramp
   * @param {number} hue 0..1 around the colour wheel
   * @param {{saturation?: number, shades?: number, hueShift?: number, darkest?: number, lightest?: number}} [options]
   *   defaults: saturation 0.55, 5 shades, hue shift 0.04, lightness from 0.2 to 0.82
   * @returns {Ramp}
   * @throws {Error} for fewer than 2 shades
   * @complexity O(shades) time and space
   * @example Kit.palette.ramp('moss', 0.3).shades // five greens, dark to light
   */
  const ramp = (id, hue, options = {}) => {
    const { saturation, shades, hueShift, darkest, lightest } = { ...RAMP_DEFAULTS, ...options };
    if (!Number.isInteger(shades) || shades < 2) throw new Error(`Kit.palette.ramp: "${id}" needs 2 or more shades, got ${shades}.`);
    return {
      id,
      shades: Array.from({ length: shades }, (_unused, index) => {
        const along = index / (shades - 1);
        return toCss(Kit.blend.hsl(hue + (along - 0.5) * hueShift, saturation * (1 - along / 2), Kit.math.lerp(darkest, lightest, along)));
      }),
    };
  };

  /**
   * The shade of a ramp for a light level: the banding step of a toon or pixel shader, as data.
   * @param {Ramp} colorRamp
   * @param {number} light 0 (unlit) to 1 (fully lit); values outside are clamped
   * @returns {string} one of the ramp's shades
   * @complexity O(1)
   * @example Kit.palette.shade(skinRamp, 0.5) // the middle shade
   */
  const shade = (colorRamp, light) => colorRamp.shades[Math.min(colorRamp.shades.length - 1, Math.floor(Kit.math.clamp(light, 0, 1) * colorRamp.shades.length))];

  // ==== perceptual tones and the packed table (what the look shaders read) ==============================================

  /** Width of the packed table in texels: six tone columns, the deep column, and the ink column last. A power of two. */
  const TONE_SLOTS = 8;
  /**
   * Column that holds a ramp's deepest colour: the dark end that shading with few tones never reaches (see `TONE_POSITIONS`). Marks that
   * must read on any tone of the surface under them (a pupil, a lash line, the line of a mouth) are painted with it.
   */
  const DEEP_COLUMN = 6;
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
  const TONE_SHAPE = {
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
  /**
   * How much of `shadowDepth` a ramp uses, by its number of shadow tones: with one shadow tone the single step
   * must stay gentle (a face half in shadow should not look bearded); each further tone reaches deeper.
   */
  const SHADOW_REACH = { oneTone: 0.55, perExtraTone: 0.15 };
  /**
   * Where along a graded ramp (a `Ramp` of shades, 0 its darkest and 1 its lightest) each tone sits, by tone
   * count, darkest first. Three rules shape the table. The second-lightest tone is always the ramp's middle,
   * so a character keeps its colours when the tone count changes and a five-shade ramp's middle shade is drawn
   * byte for byte. With one shadow tone the step down from it stays gentle (the reasoning of `SHADOW_REACH`: a
   * face half in a deep shadow reads as half a face); each further tone reaches deeper, down to the ramp's
   * darkest. The lightest tone stops short of the ramp's end, so a highlight is a colour, not chalk.
   * @type {Record<number, number[]>}
   */
  const TONE_POSITIONS = Object.freeze({
    2: Object.freeze([0.28, 0.5]),
    3: Object.freeze([0.26, 0.5, 0.78]),
    4: Object.freeze([0.08, 0.28, 0.5, 0.78]),
    5: Object.freeze([0, 0.18, 0.34, 0.5, 0.8]),
    6: Object.freeze([0, 0.14, 0.27, 0.39, 0.5, 0.8]),
  });
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
   * @example Kit.palette.rgbOf('#ff8000') // [255, 128, 0]
   */
  const rgbOf = (color) => {
    if (Array.isArray(color)) return color.slice(0, 3);
    const packed = typeof color === 'string' ? Number.parseInt(color.replace('#', ''), 16) : color;
    if (!Number.isFinite(packed)) throw new Error(`Kit.palette.rgbOf: "${color}" is not a colour. Use '#rrggbb', 0xRRGGBB or [red, green, blue].`);
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
   * @property {Partial<RampShape>} [shape] overrides of TONE_SHAPE for this ramp
   */

  /**
   * @typedef {Object} ToneRamp
   * @property {number[][]} tones [red, green, blue] bytes, darkest first
   * @property {number[]} ink [red, green, blue] bytes of the outline colour
   * @property {number[]} deep [red, green, blue] bytes of the ramp's deepest colour (the `DEEP_COLUMN`)
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

  /** Reads any accepted ramp form as a RampSpec: a base colour, a spec, or a `Ramp` of CSS shades (a graded ramp, sampled at `TONE_POSITIONS`). */
  const toRampSpec = (spec) => {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return { base: spec };
    return spec.shades ? { graded: spec.shades } : spec;
  };

  /**
   * The colour at a position along a graded ramp: 0 is its darkest shade, 1 its lightest, and a position between
   * two shades blends them (channel by channel; neighbouring shades of one ramp are close enough for that to be even).
   * @param {Array<string|number|number[]>} shades darkest first, 2 or more
   * @param {number} position 0..1, clamped
   * @returns {number[]} [red, green, blue], 0..255
   * @complexity O(1)
   * @example Kit.palette.sampleRamp(Kit.palette.ramp('moss', 0.3).shades, 0.5) // the middle shade
   */
  const sampleRamp = (shades, position) => {
    const along = clamp01(position) * (shades.length - 1);
    const lower = Math.min(shades.length - 2, Math.floor(along));
    const [dark, light] = [rgbOf(shades[lower]), rgbOf(shades[lower + 1])];
    return dark.map((channel, index) => Math.round(channel + (light[index] - channel) * (along - lower)));
  };

  /**
   * The column of the packed table a fixed paint reads: a mark painted at a position of its ramp (0 darkest ..
   * 1 lightest) takes the nearest tone the ramp has at this tone count (the darker of two equally near), and a
   * position less than half way up to the darkest tone takes the deep column. The stamp shader in kit/look-toon.js computes exactly this.
   * @param {number} position 0..1 along the ramp
   * @param {number} toneCount 2..6
   * @returns {number} a tone column 0..toneCount - 1, or `DEEP_COLUMN`
   * @example Kit.palette.columnAt(0, 3) // 6: the deep column
   */
  const columnAt = (position, toneCount) => {
    const positions = TONE_POSITIONS[toneCount];
    if (position < positions[0] / 2) return DEEP_COLUMN;
    return positions.reduce((nearest, at, column) => (Math.abs(at - position) < Math.abs(positions[nearest] - position) ? column : nearest), 0);
  };

  /**
   * Builds a ramp of tones, darkest first, plus its ink colour. From a base colour the shadows darken in
   * equal perceptual steps while turning toward a cool hue and gaining a little chroma, and the highlight
   * lightens, warms and pales; the base itself is kept byte-exact. Authored tones (`{ tones }`) are used as given
   * and resampled (nearest) when a different count is asked for. A `Ramp` of shades is graded: its tones are
   * read at `TONE_POSITIONS`, so few tones give a gentle shadow, many reach the ramp's dark end, and the
   * second-lightest is the ramp's middle at every count.
   * @param {RampSpec|Ramp|string|number} spec a ramp spec, just the base colour, or a `Ramp` from `Kit.palette.ramp`
   *   (its shades are used as authored tones)
   * @param {number} [toneCount=4] 2..6
   * @returns {ToneRamp}
   * @complexity O(toneCount) time and space
   * @example Kit.palette.tones('#c8453a', 4).tones.map(Kit.palette.hexOf) // four reds, from wine shadow to a warm highlight
   */
  const tones = (spec, toneCount = 4) => {
    if (!Number.isInteger(toneCount) || toneCount < MIN_TONES || toneCount > MAX_TONES)
      throw new Error(`Kit.palette.tones: toneCount must be a whole number from ${MIN_TONES} to ${MAX_TONES}, got ${toneCount}.`);
    const rampSpec = toRampSpec(spec);
    const shape = { ...TONE_SHAPE, ...rampSpec.shape };
    const tones = rampSpec.graded ? gradeTones(rampSpec.graded, toneCount) : rampSpec.tones ? resampleTones(rampSpec.tones, toneCount) : generateTones(rampSpec.base, shape, toneCount);
    // The deepest colour is the full-depth shadow, so it (and the ink made from it) is the same whatever the tone count.
    const deep = rampSpec.graded ? rgbOf(rampSpec.graded[0]) : rampSpec.tones ? tones[0] : toneAround(toOklch(rgbOf(rampSpec.base)), shape, 1, 0);
    return { tones, deep, ink: rampSpec.ink !== undefined ? rgbOf(rampSpec.ink) : inkOf(deep, shape) };
  };

  const gradeTones = (shades, toneCount) => {
    if (!Array.isArray(shades) || shades.length < MIN_TONES) throw new Error(`Kit.palette.tones: a ramp's "shades" needs at least ${MIN_TONES} colours, darkest first.`);
    return TONE_POSITIONS[toneCount].map((position) => sampleRamp(shades, position));
  };

  const resampleTones = (authored, toneCount) => {
    if (!Array.isArray(authored) || authored.length < MIN_TONES) throw new Error(`Kit.palette.tones: "tones" needs at least ${MIN_TONES} colours, darkest first.`);
    return Array.from({ length: toneCount }, (_, index) => rgbOf(authored[Math.round((index * (authored.length - 1)) / (toneCount - 1))]));
  };

  const generateTones = (baseColor, shape, toneCount) => {
    if (baseColor === undefined) throw new Error("Kit.palette.tones: a ramp needs a base colour or a list of tones, e.g. Kit.palette.tones('#c8453a') or { tones: ['#222', '#888'] }.");
    const baseRgb = rgbOf(baseColor);
    const base = toOklch(baseRgb);
    const baseIndex = baseToneIndex(toneCount);
    const reach = Math.min(1, SHADOW_REACH.oneTone + SHADOW_REACH.perExtraTone * (baseIndex - 1));
    return Array.from({ length: toneCount }, (_, index) => {
      if (index === baseIndex) return baseRgb;
      return index < baseIndex ? toneAround(base, shape, (reach * (baseIndex - index)) / baseIndex, 0) : toneAround(base, shape, 0, (index - baseIndex) / (toneCount - 1 - baseIndex));
    });
  };

  // ---- palettes and the packed table -----------------------------------------------------------------------------------

  /**
   * @typedef {Object} PaletteSet
   * A named set of ramps. Palettes with the same ramp names in the same order are interchangeable.
   * @property {string} name
   * @property {string[]} rampIds ramp names, in row order
   * @property {Record<string, RampSpec|string|number>} ramps ramp name -> spec or base colour
   */

  /**
   * Makes a palette from named ramps.
   * @param {string} name
   * @param {Record<string, RampSpec|string|number>} ramps ramp name -> spec or base colour; the key order is the row order
   * @returns {PaletteSet}
   * @example const ember = Kit.palette.set('ember', { skin: '#e9b48c', cloth: '#c8453a', eye: { tones: ['#1b1626', '#f4f0ff'] } });
   */
  const set = (name, ramps) => {
    const rampIds = Object.keys(ramps || {});
    if (!rampIds.length) throw new Error(`Kit.palette.set("${name}"): a palette needs at least one ramp, e.g. { skin: '#e9b48c' }.`);
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
   * @property {number} width texels per row (8: tones 0..5, deep, ink)
   * @property {number} height rows
   * @property {Uint8Array} data RGBA bytes, row by row
   * @property {number} toneCount tones currently written per ramp
   * @property {number} version rises with every write, so a texture knows when to upload again
   * @property {function(PaletteSet|Ramp[]): PaletteBlock} load reserve rows for a palette and write them
   * @property {function(PaletteBlock): void} free give a block's rows back for the next load of the same size
   * @property {function(PaletteBlock, PaletteSet|Ramp[]): void} write replace a block's colours with another palette of the same ramps
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
   * const atlas = Kit.palette.atlas();
   * const hero = atlas.load(Kit.palette.SETS.ember);   // hero.rows.skin is the row a skin material stores
   * atlas.write(hero, Kit.palette.SETS.tide);          // the hero is recoloured; nothing else changes
   * const worn = atlas.load(bake.ramps);                // a body bake: bone i is drawn with row worn.rows[bake.boneRamp[i]]
   */
  const atlas = (options = {}) => {
    const height = options.rows || DEFAULT_ATLAS_ROWS;
    const data = new Uint8Array(TONE_SLOTS * height * CHANNELS);
    const loaded = [];
    /** @type {PaletteBlock[]} blocks given back by `free`, whose rows the next load of the same size takes */
    const freed = [];
    let rowsInUse = 0;

    const writeTexel = (row, column, rgb) => data.set([rgb[0], rgb[1], rgb[2], BYTE_MAX], (row * TONE_SLOTS + column) * CHANNELS);
    const writeRow = (row, spec) => {
      const built = tones(spec, table.toneCount);
      // Columns past the tone count repeat the lightest tone, so a stale tone index can never read garbage.
      for (let column = 0; column < DEEP_COLUMN; column++) writeTexel(row, column, built.tones[Math.min(column, built.tones.length - 1)]);
      writeTexel(row, DEEP_COLUMN, built.deep);
      writeTexel(row, INK_COLUMN, built.ink);
    };
    const requireSameRamps = (block, source) => {
      if (source.rampIds.join() !== block.rampIds.join())
        throw new Error(
          `Kit.palette.atlas.write: palette "${source.name}" has ramps [${source.rampIds}], but the block was loaded with [${block.rampIds}]. Interchangeable palettes list the same ramps in the same order.`
        );
    };

    /** A list of ramps (a body bake's `ramps`) is a set whose ramp names are the list indices. */
    const toSet = (given) => (Array.isArray(given) ? set('ramps', Object.fromEntries(given.map((entry, index) => [index, entry]))) : given);

    const table = {
      width: TONE_SLOTS,
      height,
      data,
      toneCount: options.toneCount || 4,
      version: 0,
      load(given) {
        const source = toSet(given);
        const reusable = freed.findIndex((block) => block.rampIds.length === source.rampIds.length);
        if (reusable >= 0) {
          const [{ offset }] = freed.splice(reusable, 1);
          const block = { offset, rampIds: source.rampIds.slice(), rows: Object.fromEntries(source.rampIds.map((id, index) => [id, offset + index])) };
          loaded.push({ block, source });
          table.write(block, source);
          return block;
        }
        if (rowsInUse + source.rampIds.length > height)
          throw new Error(`Kit.palette.atlas.load: no room for "${source.name}" (${rowsInUse} of ${height} rows used). Create the atlas with more rows: Kit.palette.atlas({ rows: ${height * 2} }).`);
        const block = { offset: rowsInUse, rampIds: source.rampIds.slice(), rows: Object.fromEntries(source.rampIds.map((id, index) => [id, rowsInUse + index])) };
        rowsInUse += source.rampIds.length;
        loaded.push({ block, source });
        table.write(block, source);
        return block;
      },
      write(block, given) {
        const source = toSet(given);
        requireSameRamps(block, source);
        source.rampIds.forEach((id) => writeRow(block.rows[id], source.ramps[id]));
        loaded.find((entry) => entry.block === block).source = source;
        table.version += 1;
      },
      writeRamp(block, rampId, spec) {
        if (!(rampId in block.rows)) throw new Error(`Kit.palette.atlas.writeRamp: the block has no ramp "${rampId}" (it has ${block.rampIds}).`);
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
      /**
       * Gives a block's rows back: the next `load` of a palette with as many ramps takes them. Materials still
       * pointing at the rows would be recoloured by that load, so free a block only once nothing draws with it.
       * @param {PaletteBlock} block from `load`; freeing it twice, or a block of another atlas, does nothing
       * @complexity O(blocks loaded)
       */
      free(block) {
        const index = loaded.findIndex((entry) => entry.block === block);
        if (index < 0) return;
        loaded.splice(index, 1);
        freed.push(block);
      },
      colorAt: (row, column) => Array.from(data.subarray((row * TONE_SLOTS + column) * CHANNELS, (row * TONE_SLOTS + column) * CHANNELS + 3)),
    };
    return table;
  };

  /** The contact shadow under a figure: one flat colour whatever the tone. */
  const GROUND = { tones: ['#3f4870', '#3f4870'] };
  /** @type {Array<[string, Record<string, RampSpec|string>]>} */
  const SET_ROWS = [
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
   * @type {Record<string, PaletteSet>}
   */
  const SETS = Object.fromEntries(SET_ROWS.map(([name, ramps]) => [name, set(name, ramps)]));

  Kit.palette = { RAMP_DEFAULTS, toCss, ramp, shade, TONE_SLOTS, INK_COLUMN, DEEP_COLUMN, TONE_POSITIONS, sampleRamp, columnAt, MIN_TONES, MAX_TONES, TONE_SHAPE, SETS, rgbOf, hexOf, toOklch, fromOklch, tones, set, atlas };
})();
