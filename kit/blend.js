// Kit blend: in-between values from data. Pure, no DOM, no THREE - runs in node (see tools/test-kit.js). Loads after model.js (uses Kit.curve).
//
//   blend.hex      - mix two 0xRRGGBB colours:                 blend.hex(0x000000, 0xffffff, 0.5)
//   blend.hsl      - a 0xRRGGBB colour from hue / sat / light: blend.hsl(0.56, 0.66, 0.6)
//   blend.rows     - mix two table rows field by field:        blend.rows(dusk, night, 0.3, { colors: ['sky'] })
//   blend.position - where x sits in a table of thresholds:    blend.position(ZONES, { key: 'from', span: 3 })(altitude)
//   blend.along    - the two above composed:                   blend.along(ZONES, { key: 'from', span: 3, colors: ['sky'] })(altitude)
//
// Use it for anything that changes gradually between authored rows: biomes by distance, moods by time of day, difficulty looks by level.
// Owns the mixing only; what a row means (a sky, a light rig, a palette) stays with the caller.
(() => {
  const { lerp, clamp } = Kit.math;

  /**
   * Mixes two colours channel by channel in sRGB (the space the hex values are authored in).
   * @param {number} from 0xRRGGBB
   * @param {number} to 0xRRGGBB
   * @param {number} amount 0 = from, 1 = to (clamped)
   * @returns {number} 0xRRGGBB
   */
  function hex(from, to, amount) {
    const weight = clamp(amount);
    // Each channel is shifted down to 0..255, mixed, rounded and shifted back into place.
    return [16, 8, 0].reduce((mixed, shift) => mixed | (Math.round(lerp((from >> shift) & 255, (to >> shift) & 255, weight)) << shift), 0);
  }

  /**
   * Converts hue / saturation / lightness to a colour, so palettes can be walked by a number (a hue per floor, per level, per team).
   * @param {number} hue 0..1 around the colour wheel (wraps)
   * @param {number} saturation 0..1
   * @param {number} lightness 0..1
   * @returns {number} 0xRRGGBB
   */
  function hsl(hue, saturation, lightness) {
    const chroma = saturation * Math.min(lightness, 1 - lightness);
    // Standard HSL to RGB: each channel reads the same triangle wave, a third of a turn apart (offsets 0, 8, 4 of 12).
    const channel = (offset) => {
      const turn = (offset + (((hue % 1) + 1) % 1) * 12) % 12;
      return Math.round(255 * (lightness - chroma * Math.max(-1, Math.min(turn - 3, 9 - turn, 1))));
    };
    return (channel(0) << 16) | (channel(8) << 8) | channel(4);
  }

  /**
   * Mixes two rows into a new one: numbers are interpolated, fields named in `colors` are mixed as 0xRRGGBB,
   * anything else (ids, names, flags) is taken from whichever row is nearer.
   * @param {Object} from row at amount 0
   * @param {Object} to row at amount 1
   * @param {number} amount 0..1
   * @param {{ colors?: string[] }} [options] colors: field names holding 0xRRGGBB values
   * @returns {Object} a new row with every field of `from`
   */
  function rows(from, to, amount, { colors = [] } = {}) {
    const mixField = (key) => {
      if (colors.includes(key)) return hex(from[key], to[key], amount);
      if (typeof from[key] === 'number' && typeof to[key] === 'number') return lerp(from[key], to[key], amount);
      return amount < 0.5 ? from[key] : to[key];
    };
    return Object.keys(from).reduce((mixed, key) => ((mixed[key] = mixField(key)), mixed), {});
  }

  /**
   * Maps a running value (altitude, distance, time) to a fractional row index: flat while inside a row, then ramping to the next
   * index over `span` units starting at that row's threshold. Row 0 always starts the table, whatever its threshold says.
   * @param {Object[]} table rows in ascending threshold order
   * @param {{ key?: string, span?: number }} [options] key: the threshold field (default 'from'); span: how long each change takes (> 0)
   * @returns {(x: number) => number} 0 .. table.length - 1
   * @example
   * blend.position([{ from: 0 }, { from: 10 }], { span: 4 })(12)   // 0.5: half way through the change that starts at 10
   */
  function position(table, { key = 'from', span = 1 } = {}) {
    const points = table.slice(1).flatMap((row, index) => [[row[key], index], [row[key] + span, index + 1]]);
    return Kit.curve.points([[table[0][key], 0]].concat(points));
  }

  /** Smoothstep: eases a 0..1 amount in and out so a change neither starts nor stops abruptly. */
  const smooth = (amount) => amount * amount * (3 - 2 * amount);

  /**
   * A function from a running value to the blended row at that value: `position` picks the two neighbouring rows, `rows` mixes them.
   * @param {Object[]} table rows in ascending threshold order
   * @param {{ key?: string, span?: number, colors?: string[], ease?: (amount: number) => number }} [options] as for `position` and `rows`;
   *   ease shapes each change (default smoothstep)
   * @returns {(x: number) => Object}
   * @complexity building: O(rows log rows). Each call: O(rows) to find the position plus O(fields) to mix, and one new object.
   * @example
   * const lookAt = Kit.blend.along(ZONES, { key: 'from', span: 3, colors: ['skyTop', 'skyBottom'] });
   * stage.setSky(lookAt(floor).skyTop, lookAt(floor).skyBottom);
   */
  function along(table, { key = 'from', span = 1, colors = [], ease = smooth } = {}) {
    const positionAt = position(table, { key, span });
    return (x) => {
      const at = positionAt(x), index = Math.min(Math.floor(at), table.length - 1);
      return rows(table[index], table[Math.min(index + 1, table.length - 1)], ease(at - index), { colors });
    };
  }

  Kit.blend = { hex, hsl, rows, position, along, smooth };
})();
