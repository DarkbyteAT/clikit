/**
 * Kit space: discrete and drawn space.
 *
 *   grid    - 2D cell board: get / set, neighbours, rays, flood fill, shortest path, text-level parsing, world mapping
 *   line    - polylines from a finger: length, point-at-distance, resample, simplify, nearest point, lasso tests
 *   history - undo / redo over plain-data snapshots
 *
 * Owns:  the geometry and bookkeeping of boards and drawn lines, as plain data.
 * Does not own: meshes for cells or lines (make.js), turning a touch into a ground point
 *        (input.ground in input.js) or continuous physics (physics.js).
 *
 * No DOM, no THREE: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  // ---- grid ----------------------------------------------------------------------------------------------------------

  /**
   * The four orthogonal steps as [dx, dy]: east, south, west, north. The index is a direction
   * number, and `(direction + 2) % 4` is its opposite.
   */
  const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  /** DIRS4 followed by the four diagonals. */
  const DIRS8 = DIRS4.concat([[1, 1], [-1, 1], [-1, -1], [1, -1]]);

  /**
   * @typedef {{x: number, y: number}} Cell
   * Column x (0 at the left) and row y (0 at the top).
   */

  /**
   * @typedef {function(*, number, number): boolean} CellTest
   * Called with (value, x, y); true when the cell passes.
   */

  /**
   * @typedef {Object} GridOptions
   * @property {number} [cell=1] cell size in world units
   * @property {* | function(number, number): *} [fill=null] initial value, or a function (x, y) => value.
   *   A plain object is shared by every cell; use a function to give each cell its own.
   */

  /** Deep copy of JSON-friendly data, so snapshots never alias live state. */
  const cloneData = (value) => JSON.parse(JSON.stringify(value));

  /**
   * Creates a w x h board whose cells hold any value. World mapping centres the board on the
   * origin with x to the right and z down the screen.
   * @param {number} w columns
   * @param {number} h rows
   * @param {GridOptions} [options]
   * @returns {Object} `{ w, h, cell, DIRS4, DIRS8, inside(x, y), get(x, y), set(x, y, value), each(visit), find(test),
   *   neighbors(x, y, diagonal), ray(x, y, dx, dy, visit), flood(x, y, passable, diagonal), path(from, to, passable, diagonal),
   *   toWorld(x, y), fromWorld(worldX, worldZ), snapshot(), restore(snapshot) }`
   * @example
   * const board = Kit.grid(8, 8, { cell: 1.2, fill: (x, y) => ({ gem: (x + y) % 3 }) });
   * board.neighbors(3, 3).filter((cell) => cell.v.gem === 0);
   * board.path({ x: 0, y: 0 }, { x: 7, y: 7 }, (value) => !value.wall); // [{ x, y }, ...] or null
   */
  function grid(w, h, options = {}) {
    const cellSize = options.cell || 1;
    const columnOf = (index) => index % w;
    const rowOf = (index) => Math.floor(index / w);
    const indexOf = (x, y) => y * w + x;
    const cellAt = (index) => ({ x: columnOf(index), y: rowOf(index) });
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

    const initialValue = (index) => {
      if (typeof options.fill === 'function') return options.fill(columnOf(index), rowOf(index));
      return options.fill === undefined ? null : options.fill;
    };
    // Row-major storage: the cell at (x, y) lives at index y * w + x.
    let values = Array.from({ length: w * h }, (_, index) => initialValue(index));

    /**
     * Breadth-first search outward from a start cell through passable cells.
     * @param {number} startIndex
     * @param {CellTest} passable
     * @param {boolean} diagonal also step diagonally
     * @param {function(number): boolean} [isGoal] stop as soon as this index is reached
     * @returns {{order: number[], cameFrom: Map<number, number>, goalIndex: number}} cells in the order reached,
     *   each cell's predecessor (-1 for the start) and the goal's index (-1 when not reached)
     * @complexity O(cells reached) time and space: each cell is queued once and looks at 4 (or 8) neighbours.
     *   Nothing is allocated per neighbour, and the queue is read by index, never shifted.
     */
    const breadthFirst = (startIndex, passable, diagonal, isGoal = () => false) => {
      const directions = diagonal ? DIRS8 : DIRS4;
      const cameFrom = new Map([[startIndex, -1]]);
      const order = [startIndex];
      // Hot path (pathfinding may run every frame). Index loops on purpose: `order` doubles as the
      // queue and grows while it is being read, and neighbours are visited as plain numbers.
      for (let head = 0; head < order.length; head++) {
        const currentIndex = order[head];
        if (isGoal(currentIndex)) return { order, cameFrom, goalIndex: currentIndex };
        const x = columnOf(currentIndex);
        const y = rowOf(currentIndex);
        for (let direction = 0; direction < directions.length; direction++) {
          const neighborX = x + directions[direction][0];
          const neighborY = y + directions[direction][1];
          if (!inside(neighborX, neighborY)) continue;
          const neighborIndex = indexOf(neighborX, neighborY);
          if (cameFrom.has(neighborIndex) || !passable(values[neighborIndex], neighborX, neighborY)) continue;
          cameFrom.set(neighborIndex, currentIndex);
          order.push(neighborIndex);
        }
      }
      return { order, cameFrom, goalIndex: -1 };
    };

    /** Follows predecessor links back from a cell to the start; returns the cells start-first. O(route length). */
    const traceBack = (cameFrom, endIndex) => {
      const route = [];
      // Collected goal-first and reversed once: unshifting each cell would cost O(length) per step.
      for (let index = endIndex; index !== -1; index = cameFrom.get(index)) route.push(cellAt(index));
      return route.reverse();
    };

    const board = {
      w,
      h,
      cell: cellSize,
      DIRS4,
      DIRS8,
      /** Is (x, y) on the board? */
      inside,
      /** The value at (x, y), or undefined off the board. */
      get: (x, y) => (inside(x, y) ? values[indexOf(x, y)] : undefined),
      /** Sets the value at (x, y); ignored off the board. Returns the grid, for chaining. */
      set(x, y, value) {
        if (inside(x, y)) values[indexOf(x, y)] = value;
        return board;
      },
      /** Calls visit(value, x, y) for every cell, row by row. O(w * h) time, O(1) space. */
      each(visit) {
        values.forEach((value, index) => visit(value, columnOf(index), rowOf(index)));
      },
      /** Every cell that passes test(value, x, y), as { x, y, v }. O(w * h) time and space. */
      find(test) {
        return values.map((value, index) => ({ x: columnOf(index), y: rowOf(index), v: value })).filter((cell) => test(cell.v, cell.x, cell.y));
      },
      /**
       * The on-board neighbours of (x, y) as { x, y, v }: four orthogonal, or all eight with diagonal = true.
       * @complexity O(1) time; allocates the result list and one object per neighbour (flood and path do not use it)
       */
      neighbors(x, y, diagonal = false) {
        return (diagonal ? DIRS8 : DIRS4).reduce((found, [dx, dy]) => {
          const neighborX = x + dx;
          const neighborY = y + dy;
          if (inside(neighborX, neighborY)) found.push({ x: neighborX, y: neighborY, v: values[indexOf(neighborX, neighborY)] });
          return found;
        }, []);
      },
      /**
       * Walks from (x, y) in direction (dx, dy), calling visit(value, x, y, step) on each cell after
       * the start. Beams, slides, line of sight.
       * @returns {{x: number, y: number, steps: number}} where the walk stopped: the cell whose visit
       *   returned false, or the first position off the board
       */
      ray(x, y, dx, dy, visit) {
        for (let step = 1; ; step++) {
          const cellX = x + dx * step;
          const cellY = y + dy * step;
          const isBlocked = !inside(cellX, cellY) || visit(values[indexOf(cellX, cellY)], cellX, cellY, step) === false;
          if (isBlocked) return { x: cellX, y: cellY, steps: step };
        }
      },
      /**
       * All cells reachable from (x, y) through passable cells, nearest first. The start is always included.
       * @complexity O(cells reached) time and space
       */
      flood(x, y, passable, diagonal = false) {
        return breadthFirst(indexOf(x, y), passable, diagonal).order.map(cellAt);
      },
      /**
       * Shortest path as [{ x, y }, ...] including both ends, or null when `to` cannot be reached.
       * @complexity O(cells reached before the goal) time and space; at worst every passable cell, O(w * h)
       */
      path(from, to, passable, diagonal = false) {
        const goalIndex = indexOf(to.x, to.y);
        // Breadth-first search reaches cells in order of step count, so the first route found is a shortest one.
        const search = breadthFirst(indexOf(from.x, from.y), passable, diagonal, (index) => index === goalIndex);
        return search.goalIndex === -1 ? null : traceBack(search.cameFrom, search.goalIndex);
      },
      /** Centre of cell (x, y) in world units, as { x, z }. */
      toWorld: (x, y) => ({ x: (x - (w - 1) / 2) * cellSize, z: (y - (h - 1) / 2) * cellSize }),
      /** The cell under a world point, or null off the board. */
      fromWorld(worldX, worldZ) {
        const x = Math.round(worldX / cellSize + (w - 1) / 2);
        const y = Math.round(worldZ / cellSize + (h - 1) / 2);
        return inside(x, y) ? { x, y } : null;
      },
      /** Plain-data copy of every cell (pairs with Kit.history). Cell values must be JSON-friendly. */
      snapshot: () => cloneData(values),
      /** Replaces every cell from a snapshot. Returns the grid. */
      restore(snapshot) {
        values = cloneData(snapshot);
        return board;
      },
    };
    return board;
  }

  /** Legend entry to cell value: functions are called, objects copied (one per cell), the rest used as is. */
  const cellFromLegend = (entry, x, y, character) => {
    if (entry === undefined) return null;
    if (typeof entry === 'function') return entry(x, y, character);
    if (typeof entry === 'object' && entry !== null) return { ...entry };
    return entry;
  };

  /**
   * Builds a grid from text rows and a legend. The widest row sets the width; characters missing
   * from the legend become null.
   * @param {string[]} rows one string per board row (at least one)
   * @param {Object<string, * | function(number, number, string): *>} [legend] character to cell value
   * @param {GridOptions} [options]
   * @returns {ReturnType<typeof grid>}
   * @example Kit.grid.parse(['#..', '.A.'], { '#': { wall: true }, A: (x, y) => ({ start: true }) })
   */
  grid.parse = (rows, legend = {}, options = {}) => {
    if (!rows.length) throw new Error('Kit.grid.parse: needs at least one row');
    const board = grid(Math.max(...rows.map((row) => row.length)), rows.length, options);
    rows.forEach((row, y) => [...row].forEach((character, x) => board.set(x, y, cellFromLegend(legend[character], x, y, character))));
    return board;
  };
  grid.DIRS4 = DIRS4;
  grid.DIRS8 = DIRS8;
  Kit.grid = grid;

  // ---- line ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {{x: number, y: number}} Point
   * Polylines are arrays of these. For a route on the ground plane, use world x / z as x / y.
   */

  /** Stand-in length for a zero-length chord, so distances to it stay finite. */
  const TINY_LENGTH = 1e-9;

  const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

  /** The point a fraction of the way from one point to another. */
  const pointBetween = (from, to, fraction) => ({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction });

  const requirePoints = (points, owner) => {
    if (!points.length) throw new Error(`${owner}: needs at least one point`);
  };

  /** Perpendicular distance from a point to the infinite line through chordStart and chordEnd. */
  const distanceToChord = (candidate, chordStart, chordEnd, chordLength) =>
    Math.abs((chordEnd.x - chordStart.x) * (chordStart.y - candidate.y) - (chordStart.x - candidate.x) * (chordEnd.y - chordStart.y)) / chordLength;

  const line = {
    /**
     * Distance between two points.
     * @param {Point} from
     * @param {Point} to
     * @returns {number}
     */
    dist: distance,

    /**
     * Total length of a polyline (0 for fewer than two points).
     * @param {Point[]} points
     * @returns {number}
     * @complexity O(n) time, O(1) space
     */
    length: (points) => points.reduce((total, point, index) => (index === 0 ? 0 : total + distance(points[index - 1], point)), 0),

    /**
     * Point and unit tangent at a distance along the line.
     * @param {Point[]} points at least one
     * @param {number} along distance from the start; clamped to the line, or wrapped when `loop` is true
     * @param {boolean} [loop=false]
     * @returns {{x: number, y: number, tx: number, ty: number}} position and direction of travel. A line with no
     *   length gives its first point with the tangent (1, 0).
     * @complexity O(n) time per call (it measures the line, then walks it), O(1) space. For repeated lookups on
     *   a line that is not changing (a follower each frame), measure once with Kit.line.measured: O(log n) per lookup.
     * @example const { x, y, tx, ty } = Kit.line.at(route, speed * t, true);
     */
    at(points, along, loop = false) {
      requirePoints(points, 'Kit.line.at');
      const total = line.length(points);
      if (points.length < 2 || total === 0) return { x: points[0].x, y: points[0].y, tx: 1, ty: 0 };
      let remaining = loop ? Kit.math.wrap(along, total) : Kit.math.clamp(along, 0, total);
      // Hot path (followers call this every frame): walk the segments, spending the distance as we go.
      for (let index = 1; index < points.length; index++) {
        const start = points[index - 1];
        const end = points[index];
        const segmentLength = distance(start, end);
        const isLastSegment = index === points.length - 1;
        if (remaining <= segmentLength || isLastSegment) {
          // The last segment absorbs any rounding left over, hence the cap at its end.
          const fraction = segmentLength ? Math.min(1, remaining / segmentLength) : 0;
          // A zero-length segment has no direction; report the default tangent rather than NaN.
          const tangentX = segmentLength ? (end.x - start.x) / segmentLength : 1;
          const tangentY = segmentLength ? (end.y - start.y) / segmentLength : 0;
          return { ...pointBetween(start, end, fraction), tx: tangentX, ty: tangentY };
        }
        remaining -= segmentLength;
      }
    },

    /**
     * Measures a line once so that many points along it can be looked up cheaply: followers on a
     * rail, a train of segments, resampling. The result describes the points as they were when
     * measured; measure again after changing them.
     * @param {Point[]} points at least one
     * @returns {{points: Point[], total: number, at: function(number, boolean=): {x: number, y: number, tx: number, ty: number}}}
     *   `total` is the line's length; `at(along, loop = false)` answers exactly as Kit.line.at(points, along, loop)
     * @complexity O(n) time and space to measure; each `at` is O(log n) time (binary search over the running
     *   lengths), O(1) space
     * @example
     * const rail = Kit.line.measured(route);                               // once
     * carts.forEach((cart) => place(cart, rail.at(cart.distance, true)));  // every frame
     */
    measured(points) {
      requirePoints(points, 'Kit.line.measured');
      // lengthUpTo[i] is the distance along the line from its start to points[i].
      const lengthUpTo = points.reduce((lengths, point, index) => {
        lengths.push(index === 0 ? 0 : lengths[index - 1] + distance(points[index - 1], point));
        return lengths;
      }, []);
      const total = lengthUpTo[lengthUpTo.length - 1];

      /** Index of the point ending the segment that holds `along`: the first whose running length reaches it. */
      const segmentEndFor = (along) => {
        let low = 1;
        let high = points.length - 1;
        // Binary search for the lower bound; the invariant is that the answer lies in [low, high].
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (lengthUpTo[middle] >= along) high = middle;
          else low = middle + 1;
        }
        return low;
      };

      return {
        points,
        total,
        at(along, loop = false) {
          if (points.length < 2 || total === 0) return { x: points[0].x, y: points[0].y, tx: 1, ty: 0 };
          const target = loop ? Kit.math.wrap(along, total) : Kit.math.clamp(along, 0, total);
          const endIndex = segmentEndFor(target);
          const start = points[endIndex - 1];
          const end = points[endIndex];
          // Recomputed rather than read from the running lengths, whose difference carries rounding error.
          const segmentLength = distance(start, end);
          const fraction = segmentLength ? Math.min(1, (target - lengthUpTo[endIndex - 1]) / segmentLength) : 0;
          // A zero-length segment has no direction; report the default tangent rather than NaN.
          const tangentX = segmentLength ? (end.x - start.x) / segmentLength : 1;
          const tangentY = segmentLength ? (end.y - start.y) / segmentLength : 0;
          return { ...pointBetween(start, end, fraction), tx: tangentX, ty: tangentY };
        },
      };
    },

    /**
     * Evenly spaced points along the line, both ends included. Turns a shaky drag into a clean route.
     * @param {Point[]} points at least one
     * @param {number} step target spacing in the line's units (the real spacing divides the length evenly)
     * @returns {Point[]} at least two points
     * @complexity O(n + k log n) time, O(n + k) space (n = points in, k = points out)
     */
    resample(points, step) {
      // Measured once: each of the k samples is then a binary search instead of a walk from the start.
      const measuredLine = line.measured(points);
      const intervalCount = Math.max(1, Math.round(measuredLine.total / step));
      return Array.from({ length: intervalCount + 1 }, (_, index) => {
        const { x, y } = measuredLine.at((measuredLine.total * index) / intervalCount);
        return { x, y };
      });
    },

    /**
     * Drops points that lie within `tolerance` of the line through their neighbours
     * (Ramer-Douglas-Peucker).
     * @param {Point[]} points
     * @param {number} tolerance largest sideways error allowed, in the line's units
     * @returns {Point[]} a new array that reuses the kept point objects
     * @complexity O(n log n) time typically, O(n^2) when every split is lopsided; O(n) space
     */
    simplify(points, tolerance) {
      if (points.length < 3) return points.slice();
      const first = points[0];
      const last = points[points.length - 1];
      const chordLength = distance(first, last) || TINY_LENGTH;
      // Find the interior point farthest from the chord between the two ends.
      const farthest = points.slice(1, -1).reduce(
        (worst, candidate, offset) => {
          const deviation = distanceToChord(candidate, first, last, chordLength);
          return deviation > worst.deviation ? { deviation, index: offset + 1 } : worst;
        },
        { deviation: 0, index: 0 }
      );
      // Everything is close enough to the chord: the chord alone represents this stretch.
      if (farthest.deviation <= tolerance) return [first, last];
      // Otherwise keep the farthest point and simplify each side of it; it ends the left half and
      // starts the right half, so drop one copy.
      const leftHalf = line.simplify(points.slice(0, farthest.index + 1), tolerance);
      const rightHalf = line.simplify(points.slice(farthest.index), tolerance);
      return leftHalf.slice(0, -1).concat(rightHalf);
    },

    /**
     * Closest point on the line to a target.
     * @param {Point[]} points at least one
     * @param {Point} target
     * @returns {{x: number, y: number, d: number, along: number}} the point, its distance from the target
     *   and its distance along the line
     * @complexity O(n) time, O(1) space
     */
    nearest(points, target) {
      requirePoints(points, 'Kit.line.nearest');
      let best = { x: points[0].x, y: points[0].y, d: distance(points[0], target), along: 0 };
      let lengthSoFar = 0;
      // Hot path (called per drag event or per frame against long drawn lines): one pass, and an
      // object is only made when a segment beats the best so far.
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        const segmentLength = distance(from, to);
        // Project the target onto the segment (dot product over squared length), clamped to its ends.
        const projection = ((target.x - from.x) * (to.x - from.x) + (target.y - from.y) * (to.y - from.y)) / (segmentLength * segmentLength);
        const fraction = segmentLength ? Kit.math.clamp(projection) : 0;
        const closestX = from.x + (to.x - from.x) * fraction;
        const closestY = from.y + (to.y - from.y) * fraction;
        const gap = Math.hypot(closestX - target.x, closestY - target.y);
        if (gap < best.d) best = { x: closestX, y: closestY, d: gap, along: lengthSoFar + segmentLength * fraction };
        lengthSoFar += segmentLength;
      }
      return best;
    },

    /**
     * Is the drawn line a closed loop: more than three points whose ends meet within `tolerance`?
     * @param {Point[]} points
     * @param {number} tolerance
     * @returns {boolean}
     */
    closed: (points, tolerance) => points.length > 3 && distance(points[0], points[points.length - 1]) <= tolerance,

    /**
     * Is a point inside the polygon the line outlines (the last point joins the first)? Lasso and net mechanics.
     * @param {Point[]} points
     * @param {Point} target
     * @returns {boolean}
     */
    contains(points, target) {
      // Even-odd rule: cast a ray from the target toward +x; an odd number of edge crossings means inside.
      const crossesRay = (edgeStart, edgeEnd) => {
        const straddlesRay = edgeStart.y > target.y !== edgeEnd.y > target.y;
        if (!straddlesRay) return false;
        const crossingX = ((edgeEnd.x - edgeStart.x) * (target.y - edgeStart.y)) / (edgeEnd.y - edgeStart.y) + edgeStart.x;
        return target.x < crossingX;
      };
      const previousOf = (index) => points[(index + points.length - 1) % points.length];
      return points.reduce((isInside, point, index) => (crossesRay(point, previousOf(index)) ? !isInside : isInside), false);
    },
  };
  Kit.line = line;

  // ---- history -------------------------------------------------------------------------------------------------------

  const DEFAULT_HISTORY_LIMIT = 200;

  /**
   * Creates an undo / redo stack of plain-data snapshots. Push the state after every move; `undo`
   * and `redo` return the state to restore (a copy), or null when there is nothing to step to.
   * @param {Object} [options]
   * @param {number} [options.max=200] snapshots kept; the oldest is dropped beyond this
   * @returns {{push: function(*): void, canUndo: function(): boolean, canRedo: function(): boolean, undo: function(): *,
   *   redo: function(): *, reset: function(*=): void, length: number}} `length` is the number of undo steps available.
   * @example
   * const moves = Kit.history();
   * moves.push(board.snapshot());                      // initial state
   * moves.push(board.snapshot());                      // after a move
   * if (moves.canUndo()) board.restore(moves.undo());  // back to the initial state
   */
  Kit.history = ({ max = DEFAULT_HISTORY_LIMIT } = {}) => {
    let snapshots = [];
    // Index of the current state in `snapshots`; -1 while empty.
    let cursor = -1;
    const history = {
      push(state) {
        // A new move after an undo starts a new branch: the undone states can no longer be redone.
        snapshots = snapshots.slice(0, cursor + 1);
        snapshots.push(cloneData(state));
        if (snapshots.length > max) snapshots.shift();
        cursor = snapshots.length - 1;
      },
      canUndo: () => cursor > 0,
      canRedo: () => cursor < snapshots.length - 1,
      undo() {
        if (!history.canUndo()) return null;
        cursor -= 1;
        return cloneData(snapshots[cursor]);
      },
      redo() {
        if (!history.canRedo()) return null;
        cursor += 1;
        return cloneData(snapshots[cursor]);
      },
      /** Forgets everything; with an argument, starts again from that state. */
      reset(state) {
        snapshots = [];
        cursor = -1;
        if (state !== undefined) history.push(state);
      },
      get length() {
        return cursor;
      },
    };
    return history;
  };
})();
