/**
 * Kit hash: a uniform spatial hash for "what is near this point?" among many moving things.
 *
 * Owns:  `Kit.spatialHash(cellSize)` - buckets of items by the square cell their centre falls in, rebuilt each frame.
 * Does not own: what "near" means exactly (the caller tests the true distance of each candidate), the items
 *        themselves, or fixed tile worlds (`Kit.grid` in kit/space.js). Pure: no DOM, no THREE; unit-tested in
 *        tools/test-kit.js.
 *
 * Use it instead of comparing every pair: with n things spread over an area, all-pairs is O(n^2) per frame while
 * insert-everything-then-query-each is O(n + n * k), k being the few things that share the queried cells.
 */
(() => {
  /**
   * Cell coordinates are packed into one number as (column + OFFSET) * SPAN + (row + OFFSET), which is exact for
   * columns and rows within +/-OFFSET: at a cell size of 1 that is a world 65 536 units across.
   */
  const KEY_SPAN = 65536;
  const KEY_OFFSET = KEY_SPAN / 2;
  /** Empty buckets are kept for reuse between frames; past this many the map is dropped so a roaming world cannot grow it forever. */
  const MOST_BUCKETS_KEPT = 4096;

  /**
   * @typedef {Object} SpatialHash
   * @property {function(): void} clear  forget every item (start of a frame); keeps the buckets' memory for reuse
   * @property {function(*, number, number): void} insert  insert(item, x, y): file an item under the cell holding (x, y)
   * @property {function(number, number, number, function(*): void): void} query  query(x, y, radius, visit): call
   *   `visit(item)` for every item filed in a cell that the square of half-side `radius` around (x, y) touches.
   *   That is a superset of the items within `radius`: test the exact distance in `visit`. To catch big items by
   *   their edge rather than their centre, add the largest item radius to `radius`.
   * @property {function(): number} size  items currently filed
   */

  /**
   * Makes a spatial hash over an unbounded plane.
   * @param {number} cellSize side of a cell in world units. Choose about the usual query diameter: much smaller and
   *   one query walks many cells, much larger and each cell holds many items.
   * @returns {SpatialHash}
   * @throws {Error} when cellSize is not a positive number
   * @complexity clear O(buckets used), insert O(1), query O(cells touched + items in them); O(items + buckets) space.
   *   Nothing is allocated per frame once the buckets exist.
   * @example
   * const near = Kit.spatialHash(2);
   * near.clear();
   * enemies.forEach((enemy) => near.insert(enemy, enemy.x, enemy.z));
   * near.query(hero.x, hero.z, 3, (enemy) => { if (distance(enemy, hero) < 3) hit(enemy); });
   */
  Kit.spatialHash = (cellSize) => {
    if (!(cellSize > 0)) throw new Error(`Kit.spatialHash: cellSize must be a positive number of world units, got ${cellSize}. Pass about the diameter of a typical query.`);
    /** @type {Map<number, Array>} cell key to the items filed there */
    const buckets = new Map();
    let itemCount = 0;
    const cellOf = (coordinate) => Math.floor(coordinate / cellSize);
    const keyOf = (column, row) => (column + KEY_OFFSET) * KEY_SPAN + (row + KEY_OFFSET);

    return {
      clear() {
        itemCount = 0;
        if (buckets.size > MOST_BUCKETS_KEPT) return buckets.clear();
        // Emptied in place: the arrays are reused next frame, so a steady crowd allocates nothing.
        buckets.forEach((bucket) => (bucket.length = 0));
      },
      insert(item, x, y) {
        const key = keyOf(cellOf(x), cellOf(y));
        const bucket = buckets.get(key);
        if (bucket) bucket.push(item);
        else buckets.set(key, [item]);
        itemCount++;
      },
      query(x, y, radius, visit) {
        const lastColumn = cellOf(x + radius);
        const lastRow = cellOf(y + radius);
        // Index loops on purpose: this runs for every entity every frame and must not allocate.
        for (let column = cellOf(x - radius); column <= lastColumn; column++) {
          for (let row = cellOf(y - radius); row <= lastRow; row++) {
            const bucket = buckets.get(keyOf(column, row));
            if (!bucket) continue;
            for (let index = 0; index < bucket.length; index++) visit(bucket[index]);
          }
        }
      },
      size: () => itemCount,
    };
  };
})();
