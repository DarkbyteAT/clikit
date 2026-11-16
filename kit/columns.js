/**
 * Kit columns: many small records as typed-array columns (a struct of arrays) with slots that are reused through
 * a free list, so a population that churns allocates nothing after the store is made.
 *
 * Owns:  `Kit.columns(capacity, schema)` - the columns, `spawn` / `despawn`, generations (is this old handle
 *        still the same record?) and the live range to loop over.
 * Does not own: what the columns mean. `Kit.body.store` (kit/body-store.js) is this with a body schema; bullets,
 *        particles with long lives, pickups or network ghosts fit the same shape. For short-lived things that
 *        die in the order they were born, `Kit.slotRing` (kit/core.js) is simpler; for pooled objects rather
 *        than columns, `Kit.pool`.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** `spawn` returns this when every slot is taken. */
  const STORE_FULL = -1;
  /** Generations wrap at 16 bits: a handle would have to outlive 65 536 reuses of its slot to be mistaken. */
  const GENERATION_RANGE = 65536;
  /** Names the store itself uses; a schema may not take them. */
  const RESERVED = ['capacity', 'alive', 'generation', 'spawn', 'despawn', 'isCurrent', 'count', 'liveEnd', 'clear'];

  /**
   * @typedef {Object} ColumnStore
   * The returned object also carries one typed array per schema entry, under the schema's names.
   * @property {number} capacity most records it can hold
   * @property {Uint8Array} alive 1 when the slot holds a record
   * @property {Uint16Array} generation bumped every time a slot is freed, so a kept (slot, generation) pair can be checked
   * @property {function(): number} spawn claims a slot, zeroes its columns and returns it; -1 when the store is full
   * @property {function(number): boolean} despawn frees a slot; false (and nothing changes) when it was not live
   * @property {function(number, number): boolean} isCurrent isCurrent(slot, generation): is the slot live and still
   *   the record that had this generation?
   * @property {function(): number} count live records
   * @property {function(): number} liveEnd one past the highest live slot: loop `slot < liveEnd()` and skip `!alive[slot]`
   * @property {function(): void} clear frees every slot
   */

  /**
   * Makes a column store. Every column is allocated here, once.
   * @param {number} capacity a positive whole number of records
   * @param {Object<string, any>} schema column name -> typed-array constructor, e.g. { x: Float32Array, kind: Uint8Array }
   * @returns {ColumnStore & Object<string, any>}
   * @throws {Error} when capacity is not a positive whole number, or a column takes a reserved name
   * @complexity `spawn` is O(columns); `despawn`, `isCurrent`, `count` and `liveEnd` are O(1) (despawning the
   *   highest slot walks down past dead slots under it, each visited once per time it is freed); `clear` is
   *   O(capacity). Space is the columns plus 7 bytes a slot. Nothing allocates after creation.
   * @example
   * const shots = Kit.columns(256, { x: Float32Array, y: Float32Array, damage: Uint8Array });
   * const slot = shots.spawn();
   * if (slot >= 0) shots.x[slot] = 3;
   * for (let each = 0; each < shots.liveEnd(); each++) if (shots.alive[each]) shots.y[each] += dt;
   */
  Kit.columns = (capacity, schema) => {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`Kit.columns: capacity must be a positive whole number of records, got ${capacity}.`);
    const names = Object.keys(schema || {});
    const taken = names.find((name) => RESERVED.includes(name));
    if (taken) throw new Error(`Kit.columns: the column name "${taken}" is used by the store itself. Reserved names: ${RESERVED.join(', ')}.`);
    const columns = names.map((name) => new schema[name](capacity));
    /** Free slots as a stack; filled so that slot 0 is handed out first. */
    const freeSlots = new Int32Array(capacity);
    const alive = new Uint8Array(capacity);
    const generation = new Uint16Array(capacity);
    let freeCount = 0;
    let liveEnd = 0;

    const clear = () => {
      for (let slot = 0; slot < capacity; slot++) freeSlots[slot] = capacity - 1 - slot;
      freeCount = capacity;
      liveEnd = 0;
      alive.fill(0);
    };
    clear();

    return Object.assign(Object.fromEntries(names.map((name, index) => [name, columns[index]])), {
      capacity,
      alive,
      generation,
      spawn() {
        if (freeCount === 0) return STORE_FULL;
        const slot = freeSlots[--freeCount];
        for (let column = 0; column < columns.length; column++) columns[column][slot] = 0;
        alive[slot] = 1;
        if (slot >= liveEnd) liveEnd = slot + 1;
        return slot;
      },
      despawn(slot) {
        if (!alive[slot]) return false;
        alive[slot] = 0;
        generation[slot] = (generation[slot] + 1) % GENERATION_RANGE;
        freeSlots[freeCount++] = slot;
        // Keep the live range tight so per-frame loops do not walk a long dead tail.
        while (liveEnd > 0 && !alive[liveEnd - 1]) liveEnd -= 1;
        return true;
      },
      isCurrent: (slot, slotGeneration) => alive[slot] === 1 && generation[slot] === slotGeneration,
      count: () => capacity - freeCount,
      liveEnd: () => liveEnd,
      clear,
    });
  };
  Kit.columns.FULL = STORE_FULL;
})();
