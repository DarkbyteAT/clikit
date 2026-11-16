/**
 * Kit creator slots: several named characters kept between visits, as plain data over any key-value store.
 * A slot holds the character's share code (not the recipe), so a saved character survives changes to the
 * catalogue the way a shared one does: it either decodes or says in words why it cannot.
 *
 * Owns:  `Kit.creator.slots(store, options)` (list, save, update, rename, remove, open a slot) and
 *        `Kit.creator.chipColors` (the few colours that stand in for a character in a list).
 * Does not own: the store (`ctx.save` or `Kit.store(name)`), the share code (kit/creator-session.js), or the
 *        list's interface (kit/creator-sheets.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-creator.js.
 */
(() => {
  /** The store key the slot list lives under. */
  const STORAGE_KEY = 'slots';
  /** The most characters kept. */
  const MOST_SLOTS = 12;
  /** The colour channels whose middle tone stands in for a character in a list, first match first. */
  const CHIP_CHANNELS = Object.freeze(['skin', 'hair', 'top', 'bottom', 'outerwear', 'accent']);
  /** How many colour chips a slot shows. */
  const CHIP_COUNT = 4;
  /** The tone of a ramp a chip shows: the middle one. */
  const CHIP_TONE_FRACTION = 0.5;

  /**
   * @typedef {Object} Slot
   * @property {string} id unique within the list
   * @property {string} name
   * @property {string} code the character's share code
   * @property {number} savedAt milliseconds since 1970
   */

  /**
   * Colours standing in for a character: the middle tone of a few of its colour channels.
   * @param {Object} editor from `Kit.body.editor`
   * @param {Object} recipe
   * @returns {string[]} CSS colours, at most four
   * @complexity O(controls)
   * @example Kit.creator.chipColors(editor, recipe) // ['#c2a996', '#3b2a1a', '#6c8ebf', '#444']
   */
  const chipColors = (editor, recipe) => {
    const { colors } = editor.schema(recipe);
    const preferred = CHIP_CHANNELS.map((channel) => colors.find((color) => color.id === channel)).filter(Boolean);
    const rest = colors.filter((color) => !preferred.includes(color));
    return [...preferred, ...rest].slice(0, CHIP_COUNT).map((color) => {
      const { shades } = color.ramps[color.value];
      return shades[Math.min(shades.length - 1, Math.floor(shades.length * CHIP_TONE_FRACTION))];
    });
  };

  /**
   * @typedef {Object} SlotList
   * @property {function(): Slot[]} list every saved character, newest first
   * @property {function(string): ?Slot} find
   * @property {function(string, string): {ok: boolean, slot?: Slot, message?: string}} save a new slot from a name and a share code; refused when full
   * @property {function(string, string): ?Slot} update replace a slot's code; null when there is no such slot
   * @property {function(string, string): ?Slot} rename
   * @property {function(string): boolean} remove false when there was nothing to remove
   * @property {function(): boolean} isFull
   * @property {number} most
   */

  /**
   * The list of saved characters in a store.
   * @param {{get: function(string, *): *, set: function(string, *): *}} store `ctx.save` or `Kit.store(name)`
   * @param {{now?: function(): number, most?: number}} [options] `now` a clock in milliseconds (injectable for tests)
   * @returns {SlotList}
   * @complexity O(slots) per call
   * @example
   * const slots = Kit.creator.slots(ctx.save);
   * const { slot } = slots.save('Mara Oak', session.code());
   */
  const slots = (store, { now = Date.now, most = MOST_SLOTS } = {}) => {
    /** The saved rows, newest first; anything that is not a row with text in it is ignored (a store can hold anything). */
    const read = () => {
      const saved = store.get(STORAGE_KEY, []);
      return (Array.isArray(saved) ? saved : []).filter((row) => row && typeof row.id === 'string' && typeof row.code === 'string' && typeof row.name === 'string');
    };
    const write = (rows) => store.set(STORAGE_KEY, rows);
    const nextId = (rows) => {
      const taken = new Set(rows.map((row) => row.id));
      let counter = rows.length + 1;
      while (taken.has(`c${counter}`)) counter += 1;
      return `c${counter}`;
    };
    const change = (id, edit) => {
      const rows = read();
      const at = rows.findIndex((row) => row.id === id);
      if (at < 0) return null;
      rows[at] = { ...rows[at], ...edit, savedAt: now() };
      write(rows);
      return rows[at];
    };
    const self = {
      most,
      list: () => read().sort((first, second) => second.savedAt - first.savedAt),
      find: (id) => read().find((row) => row.id === id) || null,
      isFull: () => read().length >= most,
      save(name, code) {
        const rows = read();
        if (rows.length >= most) return { ok: false, message: `You can keep ${most} characters. Delete one to make room.` };
        const slot = { id: nextId(rows), name: Kit.creator.cleanName(name) || 'Unnamed', code, savedAt: now() };
        write([...rows, slot]);
        return { ok: true, slot };
      },
      update: (id, code) => change(id, { code }),
      rename: (id, name) => change(id, { name: Kit.creator.cleanName(name) || 'Unnamed' }),
      remove(id) {
        const rows = read();
        const kept = rows.filter((row) => row.id !== id);
        if (kept.length === rows.length) return false;
        write(kept);
        return true;
      },
    };
    return self;
  };

  Kit.creator = Object.assign(Kit.creator || {}, { slots, chipColors, MOST_SLOTS });
})();
