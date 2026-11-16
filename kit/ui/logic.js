/**
 * Kit ui logic: the decisions the components make, as pure functions.
 *
 * Owns:  `Kit.uiLogic`: the notice queue (what is showing, what waits), roving focus (which item an arrow key
 *        lands on), selection (single and multiple), text search over rows, fraction clamping and where a popover goes.
 * Does not own: any element or event (the component files beside this one apply these decisions to the DOM).
 *
 * Pure: runs in node and is unit-tested by tools/test-kit.js. It loads before kit/ui.js and needs nothing.
 */
(() => {
  /**
   * @typedef {Object} NoticeQueue
   * @property {Object[]} showing notices on screen, oldest first (at most `limit`)
   * @property {Object[]} waiting notices held back until a slot frees, in arrival order
   * @property {number} limit how many may show at once
   */

  /**
   * An empty notice queue.
   * @param {number} [limit=1] how many notices may be on screen together
   * @returns {NoticeQueue}
   */
  const createQueue = (limit = 1) => ({ showing: [], waiting: [], limit });

  /**
   * Adds a notice: it shows at once if a slot is free, otherwise it waits its turn.
   * @param {NoticeQueue} queue
   * @param {Object} notice anything with a unique `id`
   * @returns {NoticeQueue} a new queue; the input is not changed
   * @complexity O(showing + waiting) time and space (the lists are copied)
   */
  const enqueue = (queue, notice) =>
    queue.showing.length < queue.limit ? { ...queue, showing: [...queue.showing, notice] } : { ...queue, waiting: [...queue.waiting, notice] };

  /**
   * Removes a notice by id (shown or still waiting) and promotes the longest-waiting notice into any freed slot.
   * @param {NoticeQueue} queue
   * @param {string|number} id
   * @returns {NoticeQueue} a new queue
   * @complexity O(showing + waiting) time and space
   */
  const dismiss = (queue, id) => {
    const showing = queue.showing.filter((notice) => notice.id !== id);
    const waiting = queue.waiting.filter((notice) => notice.id !== id);
    const freeSlots = queue.limit - showing.length;
    return { ...queue, showing: [...showing, ...waiting.slice(0, freeSlots)], waiting: waiting.slice(freeSlots) };
  };

  /** Keys that move focus within a row or column of items, as steps; Home and End are handled by name. */
  const FOCUS_STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

  /**
   * Where focus goes when a key is pressed in a tab list, list or grid: arrows step and wrap around, Home and
   * End jump, and disabled items are skipped.
   * @param {string} key a KeyboardEvent.key
   * @param {number} index the focused item
   * @param {number} count how many items there are
   * @param {function(number): boolean} [isDisabled] items focus must skip
   * @returns {number} the new index, or -1 when the key is not a focus key (or every other item is disabled)
   * @complexity O(count) time in the worst case (a run of disabled items), O(1) space
   * @example rovingIndex('ArrowRight', 2, 3) // 0: wraps to the first tab
   */
  const rovingIndex = (key, index, count, isDisabled = () => false) => {
    if (count <= 0) return -1;
    const isJump = key === 'Home' || key === 'End';
    const step = isJump ? (key === 'Home' ? 1 : -1) : FOCUS_STEPS[key];
    if (!step) return -1;
    // A jump starts one step before the end it is heading for, so the scan below lands on that end first.
    const start = isJump ? (key === 'Home' ? -1 : count) : index;
    const candidates = Array.from({ length: count }, (_, offset) => (((start + step * (offset + 1)) % count) + count) % count);
    const target = candidates.find((candidate) => !isDisabled(candidate) && (isJump || candidate !== index));
    return target === undefined ? -1 : target;
  };

  /**
   * The selection after an item is picked. Single selection replaces; multiple selection toggles.
   * @param {*|Array} selected the current selection: one id (or null), or an array of ids when `multiple`
   * @param {*} id the picked item
   * @param {boolean} [multiple=false]
   * @returns {*|Array} the new selection, in the same shape
   * @example toggleSelection(['a'], 'b', true) // ['a', 'b'];  toggleSelection('a', 'b') // 'b'
   */
  const toggleSelection = (selected, id, multiple = false) => {
    if (!multiple) return id;
    const current = Array.isArray(selected) ? selected : [];
    return current.includes(id) ? current.filter((each) => each !== id) : [...current, id];
  };

  /** Is this id part of the selection (either shape)? */
  const isSelected = (selected, id) => (Array.isArray(selected) ? selected.includes(id) : selected === id);

  /**
   * Rows whose text contains every word of a query, ignoring case. An empty query keeps every row.
   * @param {Object[]} rows
   * @param {string} query what the person typed
   * @param {string[]} fields the row properties to search
   * @returns {Object[]} matching rows, in their original order
   * @complexity O(rows x words x text length) time, O(rows) space
   * @example searchRows(games, 'neon run', ['name', 'tagline'])
   */
  const searchRows = (rows, query, fields) => {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    const textOf = (row) => fields.map((field) => row[field] || '').join(' ').toLowerCase();
    return rows.filter((row) => words.every((word) => textOf(row).includes(word)));
  };

  /** A meter's value as a fraction 0..1; anything that is not a finite number counts as empty. */
  const clampFraction = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

  /** Space kept between a popover and the screen edge, and between it and its button, CSS pixels. */
  const EDGE_MARGIN_PX = 8;

  /**
   * Where a panel goes: under its anchor (above when there is no room below), kept on screen sideways.
   * Pure geometry: boxes in, a position out.
   * @param {{left: number, top: number, bottom: number, width: number}} anchor the button's box
   * @param {{width: number, height: number}} panel the panel's size
   * @param {{width: number, height: number}} viewport
   * @returns {{left: number, top: number}} viewport coordinates of the panel's top-left corner
   */
  const placePanel = (anchor, panel, viewport) => {
    const centred = anchor.left + anchor.width / 2 - panel.width / 2;
    const left = Math.max(EDGE_MARGIN_PX, Math.min(centred, viewport.width - panel.width - EDGE_MARGIN_PX));
    const below = anchor.bottom + EDGE_MARGIN_PX;
    const fitsBelow = below + panel.height <= viewport.height - EDGE_MARGIN_PX;
    return { left, top: fitsBelow ? below : Math.max(EDGE_MARGIN_PX, anchor.top - EDGE_MARGIN_PX - panel.height) };
  };

  Kit.uiLogic = { createQueue, enqueue, dismiss, rovingIndex, toggleSelection, isSelected, searchRows, clampFraction, placePanel };
})();
