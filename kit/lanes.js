/**
 * Kit lanes: "can a player get through this?" for anything laid out as rows of side-by-side lanes
 * (endless runners, rhythm highways, falling-block dodgers, river crossings).
 *
 *   lanes.open       - which lanes of one row are free:         lanes.open(['wall', null, 'wall'], (cell) => cell === 'wall')  // [1]
 *   lanes.reachable  - lanes of the last row a player can be in: lanes.reachable([[1], [0, 1], [0]])                            // [0]
 *   lanes.isPassable - is there any way through every row:       lanes.isPassable([[0], [0, 2], [2]])                           // false
 *
 * Owns:  the reachability arithmetic only. A row is just the list of lane indices that are open in it.
 * Does not own: what makes a lane open (the caller decides which obstacles block), timing, or anything visual.
 *
 * No DOM, no THREE: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * The open lanes of one row, as lane indices.
   * @typedef {number[]} OpenLanes
   */

  /**
   * @typedef {Object} LaneOptions
   * @property {number | function(number): number} [reach=1] how many lanes a player can shift between one row and the
   *   next: a constant, or a function of the index of the row being entered (so rows that are further apart can allow more)
   * @property {number[]} [from] lanes the player may be in before the first row (default: any lane, so every open lane
   *   of the first row counts as reached)
   */

  /**
   * Lists the open lanes of one row of cells.
   * @param {Array<*>} cells one entry per lane, left to right
   * @param {function(*, number): boolean} isBlocked called with (cell, laneIndex); true when the lane cannot be passed
   * @returns {OpenLanes}
   * @example Kit.lanes.open(['block', null, 'barrier'], (cell) => cell === 'block') // [1, 2]
   */
  const open = (cells, isBlocked) => cells.map((cell, laneIndex) => (isBlocked(cell, laneIndex) ? -1 : laneIndex)).filter((laneIndex) => laneIndex >= 0);

  /**
   * Walks the rows in order and returns the lanes of the last row the player can actually be standing in.
   * A lane counts only if it is open AND within `reach` of a lane that was reachable in the row before, so a row
   * whose only open lane is too far from where the player had to be makes everything after it unreachable.
   * @param {OpenLanes[]} rows first row first
   * @param {LaneOptions} [options]
   * @returns {number[]} reachable lanes of the last row (empty when the rows cannot be passed, or when there are no rows and no `from`)
   * @throws {Error} when a row is not an array (the likely mistake: passing raw cells instead of open lane indices)
   * @example Kit.lanes.reachable([[1], [0, 1, 2], [0, 2]], { reach: 1 }) // [0, 2]
   */
  const reachable = (rows, { reach = 1, from } = {}) => {
    const badRowIndex = rows.findIndex((openLanes) => !Array.isArray(openLanes));
    if (badRowIndex >= 0) throw new Error(`Kit.lanes: row ${badRowIndex} must be an array of open lane indices; build it with Kit.lanes.open(cells, isBlocked)`);
    const reachInto = typeof reach === 'function' ? reach : () => reach;
    return rows.reduce((reachedBefore, openLanes, rowIndex) => {
      // No starting constraint: the player may pick any open lane of the first row.
      if (reachedBefore === undefined) return openLanes;
      const maxShift = reachInto(rowIndex);
      return openLanes.filter((lane) => reachedBefore.some((previousLane) => Math.abs(lane - previousLane) <= maxShift));
    }, from) || [];
  };

  /**
   * True when at least one route leads through every row. Checking each neighbouring pair of rows on its own is not
   * enough: [[0], [0, 2], [2]] has a compatible lane in every pair but no single route, and this reports it as blocked.
   * @param {OpenLanes[]} rows first row first; no rows at all is trivially passable
   * @param {LaneOptions} [options]
   * @returns {boolean}
   * @example
   * const isFair = Kit.lanes.isPassable(pattern.rows.map((row) => Kit.lanes.open(row.cells, (cell) => cell === 'wall')));
   */
  const isPassable = (rows, options) => rows.length === 0 || reachable(rows, options).length > 0;

  Kit.lanes = { open, reachable, isPassable };
})();
