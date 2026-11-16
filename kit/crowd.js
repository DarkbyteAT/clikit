// Kit crowd: many things moving through a Kit.grid world at once. Pure: no DOM, no THREE - runs in node (see tools/test-kit.js).
//
//   flow    - one breadth-first search from the goal cells; every walker then reads its next cell from the result
//   slide   - move a circle through the grid's world space, sliding along blocked cells
//   buckets - a uniform spatial hash: "who is near this point" without comparing every pair
//   views   - keep a set of pooled views in step with a list of plain entities (acquire new, release gone, place all)
//
// Each function's docstring has a runnable example and its cost.
//
// Owns: crowd pathing, circle-versus-cell collision, neighbour queries and entity-to-view bookkeeping.
// Does not own: the grid (kit/space.js), single-walker routes (grid.path, Kit.measure), steering feel (speeds, separation,
//               knockback: the game's), or what a view is (the acquire / release callbacks decide).
(() => {
  /**
   * @callback CrowdCellTest
   * @param {*} value   what the grid holds at the cell
   * @param {number} x  column
   * @param {number} y  row
   * @returns {boolean}
   */

  /** @typedef {{ x: number, y: number }} CrowdCell  A grid cell (column, row). */
  /** @typedef {{ x: number, z: number }} CrowdPoint A point on the ground plane, in world units. */

  /** Distance reported for cells no walker can reach a goal from. */
  const UNREACHABLE = Infinity;

  /**
   * Where a circle is sampled for collision: its centre and the four corners of its bounding square, as multiples of the
   * radius. Enough while the radius is under half a cell, because a blocked cell cannot then fit between two samples.
   */
  const CIRCLE_SAMPLES = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  /**
   * @typedef {Object} FlowField
   * @property {(x: number, y: number) => number} distanceAt  steps from the cell to the nearest goal (Infinity when cut off or outside)
   * @property {(x: number, y: number) => CrowdCell|null} next the neighbouring cell one step closer to a goal; null at a goal,
   *                                                          outside the grid or when cut off
   */

  /**
   * Builds a flow field: the step distance from every reachable cell to the nearest goal. One search serves any number of
   * walkers, so a crowd of fifty costs the same as a crowd of one. Rebuild it only when a goal changes cell.
   * @param {Object} grid                  a Kit.grid
   * @param {CrowdCell[]} goals            cells walkers head for (goals outside the grid are ignored; a goal counts as open)
   * @param {CrowdCellTest} isPassable     true for cells a walker may stand on
   * @param {{ diagonal?: boolean }} [options]  diagonal: allow diagonal steps (default true)
   * @returns {FlowField}
   * @example
   * const field = Kit.crowd.flow(grid, [grid.fromWorld(hero.x, hero.z)], (cell) => !cell);
   * const step = field.next(zombieCell.x, zombieCell.y); // null means "walk straight at the goal" or "cut off"
   * @complexity build: O(cells) time and space, once per goal change. distanceAt: O(1). next: O(1) (at most 8 neighbours).
   *             A crowd of n walkers therefore costs O(cells + n) per goal change, against O(n x cells) for a search per walker.
   */
  function flow(grid, goals, isPassable, options = {}) {
    const directions = options.diagonal === false ? grid.DIRS4 : grid.DIRS8;
    const distances = new Array(grid.w * grid.h).fill(UNREACHABLE);
    const indexOf = (x, y) => y * grid.w + x;
    const isOpen = (x, y) => grid.inside(x, y) && (distances[indexOf(x, y)] === 0 || isPassable(grid.get(x, y), x, y));
    // A diagonal step is legal only when both cells it squeezes between are open, so walkers never clip a wall corner.
    const canStep = (x, y, dx, dy) => isOpen(x + dx, y + dy) && (dx === 0 || dy === 0 || (isOpen(x + dx, y) && isOpen(x, y + dy)));

    const queue = goals.filter((goal) => grid.inside(goal.x, goal.y));
    queue.forEach((goal) => (distances[indexOf(goal.x, goal.y)] = 0));
    // Breadth-first: the queue only grows, so reading it by index visits cells in order of distance without shifting an array.
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      const nextDistance = distances[indexOf(cell.x, cell.y)] + 1;
      directions
        .filter(([dx, dy]) => canStep(cell.x, cell.y, dx, dy) && distances[indexOf(cell.x + dx, cell.y + dy)] === UNREACHABLE)
        .forEach(([dx, dy]) => {
          distances[indexOf(cell.x + dx, cell.y + dy)] = nextDistance;
          queue.push({ x: cell.x + dx, y: cell.y + dy });
        });
    }

    const distanceAt = (x, y) => (grid.inside(x, y) ? distances[indexOf(x, y)] : UNREACHABLE);
    return {
      distanceAt,
      next(x, y) {
        const here = distanceAt(x, y);
        if (here === 0 || here === UNREACHABLE) return null;
        // The first strictly closer neighbour wins; directions list straight steps first, so ties prefer them over diagonals.
        const step = directions.find(([dx, dy]) => canStep(x, y, dx, dy) && distanceAt(x + dx, y + dy) < here);
        return step ? { x: x + step[0], y: y + step[1] } : null;
      },
    };
  }

  /**
   * Is a circle overlapping a blocked cell (or the outside of the grid)?
   * @param {Object} grid               a Kit.grid; its world mapping decides which cell a point is in
   * @param {CrowdCellTest} isBlocked   true for cells that stop movement
   * @param {number} x                  circle centre, world units
   * @param {number} z                  circle centre, world units
   * @param {number} radius             world units; keep it under half a cell (see CIRCLE_SAMPLES)
   * @returns {boolean}
   * @complexity O(1): five cell lookups.
   */
  function isCircleBlocked(grid, isBlocked, x, z, radius) {
    return CIRCLE_SAMPLES.some(([offsetX, offsetZ]) => {
      const cell = grid.fromWorld(x + offsetX * radius, z + offsetZ * radius);
      return !cell || isBlocked(grid.get(cell.x, cell.y), cell.x, cell.y);
    });
  }

  /**
   * Moves a circle by `delta`, one axis at a time, refusing only the axis that would end inside a blocked cell. Walking
   * diagonally into a wall therefore slides along it instead of stopping dead.
   * @param {Object} grid               a Kit.grid
   * @param {CrowdCellTest} isBlocked   true for cells that stop movement
   * @param {CrowdPoint} position       current centre, world units
   * @param {CrowdPoint} delta          wanted movement this step, world units (keep it under one cell so nothing tunnels)
   * @param {number} radius             world units, under half a cell
   * @returns {CrowdPoint} the new centre (a fresh object; `position` is not changed)
   * @example hero = { ...hero, ...Kit.crowd.slide(grid, (cell) => !!cell, hero, { x: stick.x * speed * dt, z: stick.y * speed * dt }, 0.4) };
   * @complexity O(1): ten cell lookups, whatever the size of the grid.
   */
  function slide(grid, isBlocked, position, delta, radius) {
    const x = isCircleBlocked(grid, isBlocked, position.x + delta.x, position.z, radius) ? position.x : position.x + delta.x;
    const z = isCircleBlocked(grid, isBlocked, x, position.z + delta.z, radius) ? position.z : position.z + delta.z;
    return { x, z };
  }

  /**
   * Keeps one view per entity: a simulation can stay plain data (arrays of `{ id, ... }`) while meshes, sprites or DOM nodes
   * come and go to match it.
   * @param {(entity: { id: * }) => *} acquire  makes or borrows the view for a new entity (for example pool.get)
   * @param {(view: *) => void} release         gives back the view of an entity that is gone (for example pool.release)
   * @returns {(entities: { id: * }[], place: (view: *, entity: *) => void) => void} sync: call once per frame; `place`
   *          runs for every living entity after views were acquired and released
   * @example
   * const syncSouls = Kit.crowd.views(() => soulPool.get(), (mesh) => soulPool.release(mesh));
   * syncSouls(world.souls, (mesh, soul) => mesh.position.set(soul.x, 0.6, soul.z));
   * @complexity sync: O(entities + views) time per call; O(views) space.
   */
  function views(acquire, release) {
    const viewsById = new Map();
    return (entities, place) => {
      const livingIds = new Set(entities.map((entity) => entity.id));
      [...viewsById.keys()]
        .filter((id) => !livingIds.has(id))
        .forEach((id) => {
          release(viewsById.get(id));
          viewsById.delete(id);
        });
      entities.forEach((entity) => {
        if (!viewsById.has(entity.id)) viewsById.set(entity.id, acquire(entity));
        place(viewsById.get(entity.id), entity);
      });
    };
  }

  /**
   * Bucket coordinates are packed into one integer key: (column + BUCKET_OFFSET) * BUCKET_STRIDE + (row + BUCKET_OFFSET).
   * The offset keeps negative coordinates positive; the stride keeps columns from colliding with rows. Worlds up to
   * BUCKET_OFFSET buckets either side of the origin are supported, far beyond any arena here.
   */
  const BUCKET_OFFSET = 32768;
  const BUCKET_STRIDE = 65536;

  /**
   * A uniform spatial hash over the ground plane: entities are dropped into square buckets, and a neighbour query
   * reads only the buckets a circle touches. Use it wherever every entity must look at its neighbours (separation,
   * area damage, flocking): the all-pairs loop it replaces grows with the square of the crowd.
   * @param {number} bucketSize  world units per bucket; pick about the largest query radius, so a query touches few buckets
   * @returns {{ fill: (entities: CrowdPoint[]) => void, near: (x: number, z: number, radius: number) => CrowdPoint[] }}
   *          fill: forget everything, then file each entity under its current position (call once per frame);
   *          near: every filed entity whose bucket touches the square around (x, z). It is a superset of the circle:
   *          the caller still checks the exact distance. Entities that moved since `fill` are found where they were.
   * @throws {Error} when bucketSize is not a positive number
   * @example
   * const hash = Kit.crowd.buckets(1.5);
   * hash.fill(zombies);
   * hash.near(hero.x, hero.z, 3).filter((zombie) => Math.hypot(zombie.x - hero.x, zombie.z - hero.z) <= 3);
   * @complexity fill: O(n) time, O(n) space. near: O(b + k) for b buckets touched and k entities in them, so a pass
   *             where each of n entities queries its neighbourhood is O(n) expected for evenly spread crowds, against
   *             O(n squared) for all pairs. Worst case (everyone in one bucket) degrades to O(n squared).
   */
  function buckets(bucketSize) {
    if (!(bucketSize > 0)) throw new Error(`Kit.crowd.buckets: bucketSize must be a positive number, got ${bucketSize}`);
    const filed = new Map();
    const coordinateOf = (value) => Math.floor(value / bucketSize);
    const keyOf = (column, row) => (column + BUCKET_OFFSET) * BUCKET_STRIDE + (row + BUCKET_OFFSET);
    return {
      fill(entities) {
        filed.clear();
        entities.forEach((entity) => {
          const key = keyOf(coordinateOf(entity.x), coordinateOf(entity.z));
          if (!filed.has(key)) filed.set(key, []);
          filed.get(key).push(entity);
        });
      },
      near(x, z, radius) {
        const found = [];
        // Hot path: plain loops over the few buckets the query square covers, appending without intermediate arrays.
        for (let column = coordinateOf(x - radius); column <= coordinateOf(x + radius); column++) {
          for (let row = coordinateOf(z - radius); row <= coordinateOf(z + radius); row++) {
            const bucket = filed.get(keyOf(column, row));
            if (bucket) for (let index = 0; index < bucket.length; index++) found.push(bucket[index]);
          }
        }
        return found;
      },
    };
  }

  Kit.crowd = { UNREACHABLE, flow, isCircleBlocked, slide, buckets, views };
})();
