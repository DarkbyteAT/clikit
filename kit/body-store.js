/**
 * Kit body store: many body instances as columns - where each is, which way it faces, how far through its
 * movement cycle it is, how much detail it deserves and which recipe it wears.
 *
 * Owns:  `Kit.body.store(capacity)`: the body schema over `Kit.columns`, a `spawn` that places the instance, and
 *        `assignDetail` (level of detail by distance from an eye).
 * Does not own: slots, the free list and generations (kit/columns.js), what a recipe index points at (the caller
 *        keeps the list of recipes or bakes), moving instances (locomotion writes the columns), posing or
 *        drawing them, or finding neighbours (`Kit.spatialHash`).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** The columns of a body instance. Adding a fact about every instance means adding a row. */
  const BODY_COLUMNS = Object.freeze({
    positionX: Float32Array, // world metres
    positionY: Float32Array,
    positionZ: Float32Array,
    heading: Float32Array, // radians about +Y, 0 faces +Z
    phase: Float32Array, // where the instance is in its movement cycle; locomotion owns its meaning (0..1 by convention)
    detail: Uint8Array, // level of detail, 0 = full
    recipe: Int32Array, // index into the caller's list of recipes or bakes
  });

  /**
   * Makes a store for up to `capacity` body instances: a `Kit.columns` store with the columns `positionX`,
   * `positionY`, `positionZ`, `heading`, `phase`, `detail` and `recipe`, plus the two methods below.
   * @param {number} capacity a positive whole number
   * @returns {Object} the `ColumnStore` of kit/columns.js with the body columns, where
   *   `spawn(recipe, x = 0, y = 0, z = 0, heading = 0)` claims and places a slot (returns -1 when full) and
   *   `assignDetail(eyeX, eyeY, eyeZ, distances)` sets each live slot's `detail` to the number of distances
   *   (ascending, metres) it is beyond
   * @throws {Error} when capacity is not a positive whole number
   * @complexity `spawn` is O(1); `assignDetail` is O(liveEnd x distances); 32 bytes a slot; nothing allocates
   *   after creation
   * @example
   * const crowd = Kit.body.store(500);
   * const slot = crowd.spawn(recipeIndex, x, 0, z, heading);
   * for (let each = 0; each < crowd.liveEnd(); each++) {
   *   if (!crowd.alive[each]) continue;
   *   crowd.phase[each] = (crowd.phase[each] + dt) % 1;   // locomotion, renderers and game rules read the same columns
   * }
   * crowd.assignDetail(camera.x, camera.y, camera.z, [12, 30]);   // 0 near, 1 mid, 2 far
   */
  const store = (capacity) => {
    const columns = Kit.columns(capacity, BODY_COLUMNS);
    const claimSlot = columns.spawn;
    return Object.assign(columns, {
      spawn(recipe, x = 0, y = 0, z = 0, heading = 0) {
        const slot = claimSlot();
        if (slot < 0) return slot;
        columns.recipe[slot] = recipe;
        columns.positionX[slot] = x;
        columns.positionY[slot] = y;
        columns.positionZ[slot] = z;
        columns.heading[slot] = heading;
        return slot;
      },
      assignDetail(eyeX, eyeY, eyeZ, distances) {
        const liveEnd = columns.liveEnd();
        // Hot path: index loops, squared distances, no allocation.
        for (let slot = 0; slot < liveEnd; slot++) {
          if (!columns.alive[slot]) continue;
          const offsetX = columns.positionX[slot] - eyeX;
          const offsetY = columns.positionY[slot] - eyeY;
          const offsetZ = columns.positionZ[slot] - eyeZ;
          const distanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
          let level = 0;
          while (level < distances.length && distanceSquared > distances[level] * distances[level]) level += 1;
          columns.detail[slot] = level;
        }
      },
    });
  };

  Kit.body = Object.assign(Kit.body || {}, { store, STORE_COLUMNS: BODY_COLUMNS });
})();
