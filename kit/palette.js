/**
 * Kit palette: colour ramps as data. A ramp is a short ordered list of shades of one colour, dark to light, with
 * the hue drifting a little along the way (shadows cooler, highlights warmer), which is what makes flat-shaded,
 * toon and pixel art read as lit instead of as one colour with grey mixed in. A renderer picks a shade by how
 * lit a surface is; a character stores only which ramp it uses.
 *
 * Owns:  `Kit.palette.ramp` (build a ramp from a hue), `Kit.palette.shade` (the shade of a ramp for a light
 *        level) and `Kit.palette.toCss`.
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

  Kit.palette = { RAMP_DEFAULTS, toCss, ramp, shade };
})();
