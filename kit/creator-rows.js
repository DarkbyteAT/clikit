/**
 * Kit creator rows: turns what `Kit.body.editor(...).schema(recipe)` says is editable into the rows a character
 * creator shows, so no control is ever written per body part: a dial, a colour channel or a socket that the
 * catalogue gains next month appears in its group with no change here.
 *
 * Owns:  `Kit.creator.rows`: `groupsOf` (schema -> tab groups, each with its ordered rows), `valuesOf` (the
 *        current value of every field by key), `structureKey` (a string that changes only when the set of rows
 *        or their shape changes, so a view re-renders on that and merely updates values otherwise), and the small
 *        pure helpers a row's view needs (`dialReadout`, `isAtDefault`, `swatchGradient`).
 * Does not own: the schema (kit/body-edit.js), any element (kit/creator-controls.js draws these rows) or what an
 *        edit does (kit/creator-session.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-creator.js.
 */
(() => {
  /** The two sides of a sided dial, in the order their sliders are shown. */
  const SIDE_ORDER = Object.freeze(['left', 'right']);
  /** Label shown beside the slider of each side while a sided pair is unlinked. */
  const SIDE_CAPTIONS = Object.freeze({ left: 'Left', right: 'Right' });
  /** The readout of a dial is its place in its range, 0 (the minimum) to this (the maximum). */
  const READOUT_SCALE = 100;
  /** Two taps on one slider within this long, and this close together, are a double tap (reset to default). */
  const DOUBLE_TAP = Object.freeze({ milliseconds: 350, pixels: 24 });
  /** A swatch is cut into this many equal diagonal stripes at most, one per tone of the ramp. */
  const SWATCH_ANGLE_DEGREES = 135;

  /**
   * @typedef {Object} ControlRow
   * One thing a person can change, ready to draw.
   * @property {('dial'|'color'|'socket')} kind
   * @property {string} id stable and unique within the schema: a field key, or `dial:<base>` for a sided pair
   * @property {string[]} lockKeys the field keys a lock on this row protects from a randomise
   * @property {string[]} valueKeys the field keys whose current values the row shows
   * @property {string} label
   * @property {?string} hint a sentence for a tooltip
   * @property {?string} icon an icon name from the catalogue
   * @property {string} group
   * @property {number} order
   * @property {number} depth how deeply a socket is nested under another (0 for everything else)
   * @property {Array<DialSlider>} [sliders] dial rows: one slider while linked or unsided, two while unlinked
   * @property {boolean} [isSided] dial rows: is this a left / right pair?
   * @property {boolean} [isLinked] dial rows: do both sides move together?
   * @property {string} [base] dial rows of a sided pair: the shared id (what `editor.link` takes)
   * @property {Object[]} [ramps] colour rows: the ramps of the channel
   * @property {string} [channel] colour rows: the channel id
   * @property {Array<{id: ?string, label: string, icon: ?string, hint: ?string}>} [choices] socket rows: what fits, None first when allowed
   * @property {string} [path] socket rows: the socket path
   */

  /**
   * @typedef {Object} DialSlider
   * @property {string} setId what `editor.setDial` takes: the dial id, or the base id for a linked pair
   * @property {string} valueKey the field key whose value this slider shows
   * @property {string} caption 'Left' / 'Right' while a pair is unlinked, else ''
   * @property {number} min
   * @property {number} max
   * @property {number} step
   * @property {number} default
   */

  /** Common fields of every row, from a schema control. */
  const baseRow = (kind, control, extra) => ({ kind, label: control.label, hint: control.hint, icon: control.icon, group: control.group, order: control.order, depth: 0, ...extra });

  const sliderOf = (dial, setId, caption) => ({ setId, valueKey: dial.key, caption, min: dial.min, max: dial.max, step: dial.step, default: dial.default });

  /**
   * One row for a plain dial, one for each sided pair (the two schema entries of a pair become a single row).
   * @param {Object[]} dials `schema.dials`
   * @param {Set<string>} unlinked bases the person has chosen to move one side at a time
   * @returns {ControlRow[]}
   */
  const dialRows = (dials, unlinked) => {
    const pairs = new Map();
    const rows = [];
    dials.forEach((dial) => {
      if (!dial.base || !SIDE_ORDER.includes(dial.side)) {
        rows.push(baseRow('dial', dial, { id: dial.key, lockKeys: [dial.key], valueKeys: [dial.key], isSided: false, isLinked: false, sliders: [sliderOf(dial, dial.id, '')] }));
        return;
      }
      if (!pairs.has(dial.base)) {
        const placeholder = { pair: {}, at: rows.length };
        pairs.set(dial.base, placeholder);
        rows.push(null);
      }
      pairs.get(dial.base).pair[dial.side] = dial;
    });
    pairs.forEach(({ pair, at }, base) => {
      const sides = SIDE_ORDER.filter((side) => pair[side]).map((side) => pair[side]);
      const isLinked = sides.every((dial) => dial.linked) && !unlinked.has(base);
      const sliders = isLinked ? [sliderOf(sides[0], base, '')] : sides.map((dial) => sliderOf(dial, dial.id, SIDE_CAPTIONS[dial.side]));
      rows[at] = baseRow('dial', sides[0], {
        id: `dial:${base}`,
        base,
        lockKeys: sides.map((dial) => dial.key),
        valueKeys: sides.map((dial) => dial.key),
        isSided: true,
        isLinked,
        sliders,
      });
    });
    return rows;
  };

  /** One row per colour channel. */
  const colorRows = (colors) => colors.map((color) => baseRow('color', color, { id: color.key, channel: color.id, lockKeys: [color.key], valueKeys: [color.key], ramps: color.ramps }));

  /** One row per socket, nested ones carrying their depth. */
  const socketRows = (sockets) =>
    sockets.map((socket) =>
      baseRow('socket', socket, {
        id: socket.key,
        path: socket.path,
        lockKeys: [socket.key],
        valueKeys: [socket.key],
        choices: socket.choices,
        allowsEmpty: socket.allowsEmpty,
        depth: socket.path.split(Kit.body.SOCKET_PATH_SEPARATOR).length - 1,
      })
    );

  /**
   * Orders rows by their `order` (ties keep schema order), then moves each nested socket directly under its
   * parent socket, so a gem is listed with the sword it sits on whatever the sort put between them.
   * @param {ControlRow[]} rows the rows of one group, in schema order
   * @returns {ControlRow[]}
   * @complexity O(n log n) time, O(n) space
   */
  const arrange = (rows) => {
    const sequence = new Map(rows.map((row, index) => [row, index]));
    const topLevel = rows.filter((row) => row.depth === 0).sort((first, second) => first.order - second.order || sequence.get(first) - sequence.get(second));
    const nestedUnder = (row) =>
      row.kind === 'socket'
        ? rows.filter((candidate) => candidate.kind === 'socket' && candidate.depth === row.depth + 1 && candidate.path.startsWith(row.path + Kit.body.SOCKET_PATH_SEPARATOR))
        : [];
    const withChildren = (row) => [row, ...nestedUnder(row).flatMap(withChildren)];
    return topLevel.flatMap(withChildren);
  };

  /**
   * @typedef {Object} RowGroup
   * @property {string} id
   * @property {string} label
   * @property {?string} icon
   * @property {?string} hint
   * @property {ControlRow[]} rows
   */

  /**
   * Every group of a schema, in the catalogue's order, each with its rows in display order. A group with no
   * rows is dropped.
   * @param {Object} schema from `editor.schema(recipe)`
   * @param {{unlinked?: Set<string>}} [options] `unlinked`: sided dials shown as two sliders although their values are equal
   * @returns {RowGroup[]}
   * @complexity O(controls log controls) time and space
   * @example Kit.creator.rows.groupsOf(editor.schema(recipe)).map((group) => group.label) // ['Head', 'Face', ...]
   */
  const groupsOf = (schema, { unlinked = new Set() } = {}) => {
    const rows = [...dialRows(schema.dials, unlinked), ...colorRows(schema.colors), ...socketRows(schema.sockets)];
    return schema.groups
      .map((group) => ({ id: group.id, label: group.label, icon: group.icon, hint: group.hint, rows: arrange(rows.filter((row) => row.group === group.id)) }))
      .filter((group) => group.rows.length > 0);
  };

  /**
   * The current value of every field of a schema, by field key: a dial value, a ramp index, or a part id (null
   * when a socket is empty).
   * @param {Object} schema from `editor.schema(recipe)`
   * @returns {Object<string, (number|string|null)>}
   * @complexity O(controls)
   */
  const valuesOf = (schema) =>
    Object.fromEntries([...schema.dials.map((dial) => [dial.key, dial.value]), ...schema.colors.map((color) => [color.key, color.value]), ...schema.sockets.map((socket) => [socket.key, socket.part || null])]);

  /**
   * A string that is equal for two row sets exactly when a view built from one is right for the other: the same
   * rows, in the same order, with the same sliders and the same choices. Values are not part of it.
   * @param {RowGroup[]} groups
   * @returns {string}
   * @complexity O(rows)
   */
  const structureKey = (groups) =>
    groups
      .map((group) => `${group.id}[${group.rows.map((row) => `${row.id}${row.sliders ? `:${row.sliders.map((slider) => slider.setId).join('+')}` : ''}${row.choices ? `:${row.choices.length}` : ''}`).join(',')}]`)
      .join(';');

  /**
   * A dial's place in its range as a whole number, 0 to 100: a unit-free readout that means the same for a
   * height in metres and a tilt in radians.
   * @param {{min: number, max: number}} slider
   * @param {number} value
   * @returns {string}
   * @example Kit.creator.rows.dialReadout({ min: 0.8, max: 1.2 }, 1) // '50'
   */
  const dialReadout = (slider, value) => String(Math.round(((value - slider.min) / (slider.max - slider.min || 1)) * READOUT_SCALE));

  /**
   * Is a dial at its default, to within half a slider step (the stored value is snapped to 255 steps, so an exact
   * compare would call a default "changed")?
   * @param {{default: number, step: number}} slider
   * @param {number} value
   * @returns {boolean}
   */
  const isAtDefault = (slider, value) => Math.abs(value - slider.default) <= slider.step / 2;

  /**
   * A CSS gradient showing every tone of a ramp as a hard-edged diagonal stripe, dark to light: the swatch shows
   * the tones the shader will really use, not one flat colour.
   * @param {string[]} shades CSS colours, dark to light
   * @returns {string} a `linear-gradient(...)` value
   * @example Kit.creator.rows.swatchGradient(['#000', '#fff']) // 'linear-gradient(135deg, #000 0% 50%, #fff 50% 100%)'
   */
  const swatchGradient = (shades) => `linear-gradient(${SWATCH_ANGLE_DEGREES}deg, ${shades.map((shade, index) => `${shade} ${(index * 100) / shades.length}% ${((index + 1) * 100) / shades.length}%`).join(', ')})`;

  /**
   * Is the second tap the second half of a double tap? Both taps must be short (no drag between press and
   * release) and the second must land soon after, and near, the first.
   * @param {?{at: number, x: number, y: number}} previous the last tap, or null
   * @param {{at: number, x: number, y: number}} current this tap: time in milliseconds, position in pixels
   * @returns {boolean}
   * @example Kit.creator.rows.isDoubleTap({ at: 0, x: 10, y: 10 }, { at: 200, x: 12, y: 11 }) // true
   */
  const isDoubleTap = (previous, current) =>
    Boolean(previous) && current.at - previous.at <= DOUBLE_TAP.milliseconds && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP.pixels;

  Kit.creator = Object.assign(Kit.creator || {}, { rows: { groupsOf, valuesOf, structureKey, dialReadout, isAtDefault, swatchGradient, isDoubleTap, DOUBLE_TAP } });
})();
