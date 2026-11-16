/**
 * Kit loadout: a fixed row of slots filled from a collection under a point budget.
 *
 * Owns:  which id sits in which slot, what the picks cost in total and whether a swap still fits the budget.
 * Does not own: the collection (pass the ids you offer), what an id means, or any view (the game draws the slots).
 * Pure: no DOM, no THREE; unit-tested in tools/test-kit.js.
 *
 * This is the "decision with a trade-off" model: three shots and five points buy one bomb and two plain balls, or two
 * splitters and nothing else. The same shape fits ability bars, squad pickers and deck slots.
 */
(() => {
  /**
   * @typedef {Object} LoadoutOptions
   * @property {number} slots     How many slots there are (a positive whole number).
   * @property {number} budget    The most the picks may cost in total.
   * @property {(id: string) => number} costOf  Cost of one id (an empty slot is free).
   * @property {(string|null)[]} [initial]      Starting picks, slot by slot; missing entries are empty.
   */

  /**
   * Create a loadout.
   * @param {LoadoutOptions} options
   * @returns {{ picks(): (string|null)[], filled(): string[], spent(): number, left(): number,
   *   canPlace(slot: number, id: string|null): boolean, place(slot: number, id: string|null): boolean,
   *   cycle(slot: number, ids: string[]): string|null, on(listener: Function): Function }}
   * @example
   * const loadout = Kit.loadout({ slots: 3, budget: 5, costOf: (id) => BALLS.byId(id).cost, initial: ['heavy', 'heavy', 'heavy'] });
   * loadout.place(0, 'bomb');             // true: 3 + 1 + 1 = 5 fits
   * loadout.cycle(1, ['heavy', 'bomb']);  // 'heavy': a second bomb would cost 7, so the slot keeps the pick that fits
   * loadout.filled();                     // ['bomb', 'heavy', 'heavy'], the order the game uses them
   * @complexity every call is O(slots); `cycle` is O(slots x ids). Memory: O(slots).
   */
  Kit.loadout = ({ slots, budget, costOf, initial = [] }) => {
    if (!Number.isInteger(slots) || slots < 1) throw new Error(`Kit.loadout: \`slots\` must be a positive whole number, got ${slots}`);
    if (typeof costOf !== 'function') throw new Error('Kit.loadout: `costOf` must be a function (id) => cost');
    const picks = Array.from({ length: slots }, (_, slot) => (initial[slot] === undefined ? null : initial[slot]));
    const bus = Kit.bus();
    const costOfPick = (id) => (id === null ? 0 : costOf(id));
    const spent = () => picks.reduce((total, id) => total + costOfPick(id), 0);
    if (spent() > budget) throw new Error(`Kit.loadout: the initial picks cost ${spent()} but the budget is ${budget}; start with cheaper picks or empty slots`);

    const isSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < slots;
    // A swap frees what the slot held before it charges the new pick, so replacing a dear pick with a cheap one always fits.
    const canPlace = (slot, id) => isSlot(slot) && spent() - costOfPick(picks[slot]) + costOfPick(id) <= budget;

    function place(slot, id) {
      if (!canPlace(slot, id)) return false;
      picks[slot] = id;
      bus.emit('change', { slot, id });
      return true;
    }

    return {
      /** Every slot in order, `null` where empty. */
      picks: () => picks.slice(),
      /** The non-empty picks in slot order. */
      filled: () => picks.filter((id) => id !== null),
      spent,
      /** Budget still unspent. */
      left: () => budget - spent(),
      canPlace,
      /** Put `id` (or `null` to empty) in a slot. @returns {boolean} false, changing nothing, when it does not fit. */
      place,
      /**
       * Step a slot to the next id in `ids` that fits the budget, wrapping round: the one-tap way to edit a loadout.
       * @returns {string|null} the slot's pick afterwards (unchanged when nothing else fits).
       */
      cycle(slot, ids) {
        if (!isSlot(slot)) return null;
        const start = ids.indexOf(picks[slot]);
        // Walk the ring once, starting just after the current pick; the current pick itself is the last candidate.
        const next = ids.map((_, step) => ids[(start + 1 + step) % ids.length]).find((id) => canPlace(slot, id));
        if (next !== undefined) place(slot, next);
        return picks[slot];
      },
      /** Subscribe to changes. @returns {() => void} unsubscribe. */
      on: (listener) => bus.on('change', listener),
    };
  };
})();
