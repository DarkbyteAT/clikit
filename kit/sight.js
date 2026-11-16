// Kit sight: what can be seen from a cell, and how far apart cells are, on a Kit.grid. Pure: no DOM, no THREE.
//
// Owns:  Kit.sight   - field of view (fog of war) and line of sight between two cells
//        Kit.measure - grid distance rules for rulers, and cheapest routes through terrain for movement previews
// Does not own: what a cell is. Callers say which cells block sight, which can be walked and what they cost,
//               so the same functions serve walls, doors, smoke or deep water.
(() => {
  // ---- Kit.sight ---------------------------------------------------------------------------------------------------

  /**
   * @callback CellTest
   * @param {*} value   what the grid holds at the cell
   * @param {number} x  column
   * @param {number} y  row
   * @returns {boolean}
   */

  /**
   * The four quarter-planes around an origin. Each maps (depth, column), "depth steps away, column steps sideways",
   * to grid offsets, so one scanning routine covers every direction.
   */
  const QUADRANTS = [
    (depth, column) => [column, -depth], // north
    (depth, column) => [column, depth], // south
    (depth, column) => [depth, column], // east
    (depth, column) => [-depth, column], // west
  ];

  /** Half a cell: a sight radius reaches the centre of the last cell, so its rim is half a cell further out. */
  const HALF_CELL = 0.5;

  // A row of cells spans columns depth * startSlope .. depth * endSlope. A cell exactly on the boundary belongs to the row:
  // rounding half up at the start and half down at the end includes it on both sides.
  const firstColumn = (depth, startSlope) => Math.floor(depth * startSlope + HALF_CELL);
  const lastColumn = (depth, endSlope) => Math.ceil(depth * endSlope - HALF_CELL);
  /** Slope of the line from the origin to the near-side corner of a cell: where a shadow edge starts or ends. */
  const edgeSlope = (depth, column) => (2 * column - 1) / (2 * depth);

  /**
   * Scan one quadrant with symmetric shadowcasting (after Albert Ford): rows are visited outwards, each row is narrowed
   * by the shadows of the opaque cells before it. Floor cells are lit only when their centre is inside the lit span,
   * which makes sight symmetric: if A sees B then B sees A.
   *
   * Hot path (runs for every token on every move), so it uses index loops and an explicit stack instead of recursion.
   * @param {function(number, number): boolean} isOpaque  (depth, column) -> blocks sight; out of bounds counts as opaque
   * @param {function(number, number): void} light        (depth, column) -> mark visible
   * @param {number} radius                               deepest row to scan
   */
  function scanQuadrant(isOpaque, light, radius) {
    const pendingRows = [{ depth: 1, startSlope: -1, endSlope: 1 }];
    while (pendingRows.length) {
      const row = pendingRows.pop();
      if (row.depth > radius) continue;
      let { startSlope } = row;
      let wasOpaque = null; // null until the first cell of the row has been seen
      const last = lastColumn(row.depth, row.endSlope);
      for (let column = firstColumn(row.depth, startSlope); column <= last; column++) {
        const opaque = isOpaque(row.depth, column);
        const isCentreLit = column >= row.depth * startSlope && column <= row.depth * row.endSlope;
        if (opaque || isCentreLit) light(row.depth, column);
        // Leaving a wall: the lit span restarts at this cell's near corner.
        if (wasOpaque === true && !opaque) startSlope = edgeSlope(row.depth, column);
        // Entering a wall: everything lit so far continues into the next row, ending at this cell's near corner.
        if (wasOpaque === false && opaque) pendingRows.push({ depth: row.depth + 1, startSlope, endSlope: edgeSlope(row.depth, column) });
        wasOpaque = opaque;
      }
      if (wasOpaque === false) pendingRows.push({ depth: row.depth + 1, startSlope, endSlope: row.endSlope });
    }
  }

  /**
   * Cells visible from one cell. Opaque cells are visible themselves (you see the wall, not past it).
   * @complexity O(radius^2) time (each cell inside the radius is visited at most once per quadrant, independent of the
   *   board's size) and O(board cells) space for the mask, or none when `into` is passed. A radius of 8 is about 200
   *   cell visits, so recomputing for every token on every move is far inside a frame.
   * @param {Object} grid                     a Kit.grid
   * @param {number} originX                  column of the eye
   * @param {number} originY                  row of the eye
   * @param {Object} options
   * @param {number} options.radius           how far the eye sees, in cells
   * @param {CellTest} options.blocks         true for cells that stop sight
   * @param {Uint8Array} [options.into]       an existing mask to add to, so several eyes share one mask
   * @returns {Uint8Array} mask of grid.w * grid.h entries, 1 = visible; index = y * grid.w + x
   * @example
   * const mask = Kit.sight.fov(grid, 3, 4, { radius: 8, blocks: (cell) => cell === '#' });
   * if (mask[y * grid.w + x]) drawLit(x, y);
   */
  function fov(grid, originX, originY, { radius, blocks, into }) {
    const mask = into || new Uint8Array(grid.w * grid.h);
    if (!grid.inside(originX, originY)) return mask;
    mask[originY * grid.w + originX] = 1;
    const reachSquared = (radius + HALF_CELL) * (radius + HALF_CELL);
    QUADRANTS.forEach((toOffset) => {
      const cellAt = (depth, column) => {
        const [offsetX, offsetY] = toOffset(depth, column);
        return [originX + offsetX, originY + offsetY];
      };
      const isOpaque = (depth, column) => {
        const [x, y] = cellAt(depth, column);
        return !grid.inside(x, y) || blocks(grid.get(x, y), x, y);
      };
      const light = (depth, column) => {
        const [x, y] = cellAt(depth, column);
        if (grid.inside(x, y) && depth * depth + column * column <= reachSquared) mask[y * grid.w + x] = 1;
      };
      scanQuadrant(isOpaque, light, radius);
    });
    return mask;
  }

  /**
   * The cells a straight line passes through, from one cell centre to another (Bresenham), both ends included.
   * @complexity O(longer axis of the offset) time and space.
   * @param {{x: number, y: number}} from
   * @param {{x: number, y: number}} to
   * @returns {Array<{x: number, y: number}>}
   */
  function cellsBetween(from, to) {
    const stepX = Math.sign(to.x - from.x), stepY = Math.sign(to.y - from.y);
    const spanX = Math.abs(to.x - from.x), spanY = Math.abs(to.y - from.y);
    const cells = [];
    // `error` tracks how far the drawn cells have drifted from the true line; it decides whether to step in x, y or both.
    for (let x = from.x, y = from.y, error = spanX - spanY; ; ) {
      cells.push({ x, y });
      if (x === to.x && y === to.y) return cells;
      const doubled = 2 * error;
      if (doubled > -spanY) (error -= spanY), (x += stepX);
      if (doubled < spanX) (error += spanX), (y += stepY);
    }
  }

  /**
   * Is there a clear straight line between two cells? The end cells themselves never block (a token standing in a
   * doorway can be seen), only the cells strictly between them.
   * @param {Object} grid  a Kit.grid
   * @param {{x: number, y: number}} from
   * @param {{x: number, y: number}} to
   * @param {CellTest} blocks
   * @returns {boolean}
   * @complexity O(cells on the line) time and space.
   */
  const los = (grid, from, to, blocks) => cellsBetween(from, to).slice(1, -1).every((cell) => !blocks(grid.get(cell.x, cell.y), cell.x, cell.y));

  Kit.sight = { fov, los, cellsBetween };

  // ---- Kit.measure -------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} DistanceRule
   * @property {string} label                                   shown in a settings list
   * @property {function(number, number): number} between       distance in cells for a straight run of `straight` orthogonal
   *                                                            and `diagonal` diagonal steps
   */

  /**
   * How many cells a move counts as, by rule id. Each takes the number of orthogonal and diagonal steps of the move.
   * @type {Object<string, DistanceRule>}
   */
  const RULES = {
    /** Every second diagonal costs two cells: 5 ft, 10 ft, 5 ft... on a 5 ft grid. */
    alternating: { label: 'Diagonals 5-10-5', between: (straight, diagonal) => straight + diagonal + Math.floor(diagonal / 2) },
    /** Every diagonal costs one cell. */
    equal: { label: 'Diagonals count as one', between: (straight, diagonal) => straight + diagonal },
    /** Diagonals are two orthogonal steps. */
    manhattan: { label: 'No diagonals', between: (straight, diagonal) => straight + 2 * diagonal },
    /** True straight-line distance. */
    euclidean: { label: 'Straight line', between: (straight, diagonal) => Math.hypot(straight + diagonal, diagonal) },
  };

  const ruleOf = (ruleId) => RULES[ruleId] || fail(`unknown distance rule "${ruleId}" (known: ${Object.keys(RULES).join(', ')})`);
  /** @param {string} message @returns {never} */
  function fail(message) {
    throw new Error(`Kit.measure: ${message}`);
  }

  /**
   * Split a cell offset into the diagonal steps and the remaining orthogonal steps of the shortest king-move path.
   * @returns {{straight: number, diagonal: number}}
   */
  const splitSteps = (deltaX, deltaY) => {
    const longer = Math.max(Math.abs(deltaX), Math.abs(deltaY)), shorter = Math.min(Math.abs(deltaX), Math.abs(deltaY));
    return { straight: longer - shorter, diagonal: shorter };
  };

  /**
   * Distance in cells between two cells under a rule (a ruler from A to B).
   * @param {{x: number, y: number}} from
   * @param {{x: number, y: number}} to
   * @param {string} [ruleId='alternating']  a key of Kit.measure.RULES
   * @returns {number} cells (may be fractional for 'euclidean')
   * @example Kit.measure.between({ x: 0, y: 0 }, { x: 3, y: 4 }, 'alternating') // 5: three diagonals (4 cells) and one straight
   */
  function between(from, to, ruleId = 'alternating') {
    const { straight, diagonal } = splitSteps(to.x - from.x, to.y - from.y);
    return ruleOf(ruleId).between(straight, diagonal);
  }

  /**
   * Distance in cells along a path of adjacent cells (a walked route), under a rule. Diagonals are counted over the
   * whole path, so under 'alternating' the 5-10-5 rhythm carries across corners. `costOf` multiplies the step into a
   * cell (2 for difficult terrain).
   * @param {Array<{x: number, y: number}>} cells          each next to the one before
   * @param {string} [ruleId='alternating']
   * @param {function(number, number): number} [costOf]    (x, y) -> multiplier for entering that cell; default 1
   * @returns {number} cells
   * @complexity O(path length) time, O(1) space.
   */
  function along(cells, ruleId = 'alternating', costOf = () => 1) {
    const rule = ruleOf(ruleId);
    const walked = cells.slice(1).reduce(
      (tally, cell, index) => {
        const isDiagonal = cell.x !== cells[index].x && cell.y !== cells[index].y;
        const straight = tally.straight + (isDiagonal ? 0 : 1), diagonal = tally.diagonal + (isDiagonal ? 1 : 0);
        // The cost of this one step is how much the rule's running total grew by taking it.
        const stepLength = rule.between(straight, diagonal) - rule.between(tally.straight, tally.diagonal);
        return { straight, diagonal, total: tally.total + stepLength * costOf(cell.x, cell.y) };
      },
      { straight: 0, diagonal: 0, total: 0 }
    );
    return walked.total;
  }

  /**
   * Text for a distance: cells converted to table units.
   * @param {number} cells
   * @param {{unitsPerCell?: number, unitName?: string}} [scale]  defaults to 5 ft per cell
   * @returns {string}
   * @example Kit.measure.label(7) // "35 ft"
   */
  const label = (cells, { unitsPerCell = 5, unitName = 'ft' } = {}) => `${Math.round(cells * unitsPerCell)} ${unitName}`;

  /** A diagonal step is weighted as one and a half orthogonal steps while searching, the long-run average of 5-10-5. */
  const DIAGONAL_SEARCH_WEIGHT = 1.5;

  /**
   * A minimal binary min-heap of { priority, value } for the route search.
   * @returns {{push: function(number, *): void, pop: function(): *, size: function(): number}}
   */
  function minHeap() {
    const items = [];
    const swap = (first, second) => ([items[first], items[second]] = [items[second], items[first]]);
    return {
      size: () => items.length,
      push(priority, value) {
        items.push({ priority, value });
        // Sift the new item up until its parent is no larger.
        for (let index = items.length - 1; index > 0; ) {
          const parent = (index - 1) >> 1;
          if (items[parent].priority <= items[index].priority) break;
          swap(parent, index);
          index = parent;
        }
      },
      pop() {
        const top = items[0], last = items.pop();
        if (!items.length) return top.value;
        items[0] = last;
        // Sift the moved item down, always towards the smaller child.
        for (let index = 0; ; ) {
          const left = 2 * index + 1, right = left + 1;
          let smallest = index;
          if (left < items.length && items[left].priority < items[smallest].priority) smallest = left;
          if (right < items.length && items[right].priority < items[smallest].priority) smallest = right;
          if (smallest === index) break;
          swap(smallest, index);
          index = smallest;
        }
        return top.value;
      },
    };
  }

  /**
   * Cheapest walk between two cells (Dijkstra over eight directions). A diagonal step is refused when either cell
   * beside it is impassable, so routes never cut through wall corners.
   * @complexity O(n log n) time and O(n) space, n = cells cheaper to reach than the destination (at most the board,
   *   or the disc that `maxCost` allows). A path preview on a 40 x 40 board is a few thousand heap operations.
   * @param {Object} grid                     a Kit.grid
   * @param {{x: number, y: number}} from
   * @param {{x: number, y: number}} to
   * @param {Object} options
   * @param {CellTest} options.passable       true for cells that can be entered
   * @param {CellTest} [options.costOf]       multiplier for entering a cell (2 for difficult terrain); default 1
   * @param {number} [options.maxCost]        give up beyond this search cost (keeps previews cheap on big maps)
   * @returns {Array<{x: number, y: number}>|null} cells from `from` to `to` inclusive, or null when there is no way
   */
  function route(grid, from, to, { passable, costOf = () => 1, maxCost = Infinity }) {
    const indexOf = (x, y) => y * grid.w + x;
    const canEnter = (x, y) => grid.inside(x, y) && passable(grid.get(x, y), x, y);
    if (!canEnter(to.x, to.y)) return null;
    const bestCost = new Map([[indexOf(from.x, from.y), 0]]);
    const cameFrom = new Map();
    const frontier = minHeap();
    frontier.push(0, from);
    while (frontier.size()) {
      const cell = frontier.pop();
      const cellCost = bestCost.get(indexOf(cell.x, cell.y));
      if (cell.x === to.x && cell.y === to.y) {
        const cells = [];
        for (let index = indexOf(cell.x, cell.y); index !== undefined; index = cameFrom.get(index)) cells.unshift({ x: index % grid.w, y: Math.floor(index / grid.w) });
        return cells;
      }
      for (const [stepX, stepY] of grid.DIRS8) {
        const x = cell.x + stepX, y = cell.y + stepY;
        const isDiagonal = stepX !== 0 && stepY !== 0;
        if (!canEnter(x, y) || (isDiagonal && !(canEnter(cell.x + stepX, cell.y) && canEnter(cell.x, cell.y + stepY)))) continue;
        const cost = cellCost + (isDiagonal ? DIAGONAL_SEARCH_WEIGHT : 1) * costOf(grid.get(x, y), x, y);
        if (cost > maxCost || cost >= (bestCost.has(indexOf(x, y)) ? bestCost.get(indexOf(x, y)) : Infinity)) continue;
        bestCost.set(indexOf(x, y), cost);
        cameFrom.set(indexOf(x, y), indexOf(cell.x, cell.y));
        frontier.push(cost, { x, y });
      }
    }
    return null;
  }

  /**
   * @typedef {Object} AreaShape
   * @property {string} label
   * @property {function(number, number, number, DistanceRule): boolean} covers  (offsetX, offsetY, radius in cells, rule) -> inside?
   */
  /**
   * Area templates by id: which cells around a centre an effect of a given radius covers. Add a row to add a shape.
   * @type {Object<string, AreaShape>}
   */
  const AREAS = {
    /** Every cell within `radius` of the centre, measured with the table's distance rule. */
    circle: { label: 'Burst', covers: (offsetX, offsetY, radius, rule) => rule.between(splitSteps(offsetX, offsetY).straight, splitSteps(offsetX, offsetY).diagonal) <= radius },
    /** A square block of cells: `radius` cells out from the centre along each axis. */
    square: { label: 'Block', covers: (offsetX, offsetY, radius) => Math.max(Math.abs(offsetX), Math.abs(offsetY)) <= radius },
  };

  /**
   * The cells an area template covers. Cells are not clipped to any board; filter with grid.inside if needed.
   * @param {string} shapeId                 a key of Kit.measure.AREAS
   * @param {{x: number, y: number}} centre  cell the area is centred on
   * @param {number} radius                  in cells
   * @param {string} [ruleId='alternating']  distance rule used by shapes that measure
   * @returns {Array<{x: number, y: number}>}
   * @complexity O(radius^2) time and space.
   * @example Kit.measure.area('circle', { x: 5, y: 5 }, 2).length // 21 under 5-10-5
   */
  function area(shapeId, centre, radius, ruleId = 'alternating') {
    const shape = AREAS[shapeId] || fail(`unknown area shape "${shapeId}" (known: ${Object.keys(AREAS).join(', ')})`);
    const rule = ruleOf(ruleId), reach = Math.max(0, Math.floor(radius));
    const offsets = Array.from({ length: 2 * reach + 1 }, (unused, index) => index - reach);
    return offsets.flatMap((offsetY) => offsets.filter((offsetX) => shape.covers(offsetX, offsetY, radius, rule)).map((offsetX) => ({ x: centre.x + offsetX, y: centre.y + offsetY })));
  }

  Kit.measure = { RULES, AREAS, between, along, label, route, area };
})();
