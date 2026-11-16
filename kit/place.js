// Kit place: drag pieces from a tray onto a grid, move them, tap them, drag them off again. Builders, puzzles, decorators.
//
//   placement      - the gesture as a pure state machine: points in, one resolved action out
//                    const drag = Kit.placement({ cellAt, trayKindAt, pieceAt, canPlace });
//                    drag.begin(point); drag.move(point); const action = drag.end(point);
//   pointerOnPlane - where the pointer ray meets any plane (upright boards, tilted tables); needs THREE at call time
//
// Owns: deciding what a press-drag-release means (place / move / remove / tap / cancel) and which cell is hovered.
// Does not own: the board contents (the game applies the returned action to its own layout, e.g. a Kit.grid plus
// Kit.history), hit-testing of the tray, or any drawing of ghosts and highlights. `placement` is unit-tested in
// tools/test-kit.js; `pointerOnPlane` is the only function here that touches THREE.
(() => {
  /**
   * @typedef {{ x: number, y: number }} PlacePoint  A pointer position in whatever space the game's callbacks understand.
   * @typedef {{ x: number, y: number }} PlaceCell   A grid cell (column, row).
   * @typedef {Object} PlaceHeld                     What the finger is carrying.
   * @property {'tray'|'board'} source  where the drag started.
   * @property {*} kind                 the tray kind picked up, or the kind of the board piece.
   * @property {*} piece                the board piece being moved (null for a tray pick).
   * @property {PlaceCell|null} from    the cell the board piece came from (null for a tray pick).
   * @typedef {Object} PlaceHover                    Live feedback while dragging.
   * @property {PlaceHeld} held
   * @property {PlacePoint} point
   * @property {PlaceCell|null} cell    the cell under the pointer, or null when off the board.
   * @property {boolean} isValid        true when releasing here would place or move the piece.
   * @property {boolean} isDragging     false until the pointer has travelled further than tapSlop.
   * @typedef {Object} PlaceAction                   The meaning of a finished gesture.
   * @property {'place'|'move'|'remove'|'tap'|'cancel'} type
   * @property {PlaceHeld} held
   * @property {PlaceCell|null} cell    the target cell for place / move, the piece's own cell for tap, else null.
   */

  const sameCell = (first, second) => !!first && !!second && first.x === second.x && first.y === second.y;

  /**
   * Classify a release. Pure: everything it needs is in its arguments.
   * @param {PlaceHeld} held
   * @param {PlaceCell|null} cell cell under the release point.
   * @param {boolean} isDragging whether the pointer left the tap radius during the gesture.
   * @param {boolean} isValid whether `cell` accepts the held piece.
   * @returns {PlaceAction['type']}
   */
  const classifyRelease = (held, cell, isDragging, isValid) => {
    const isFromBoard = held.source === 'board';
    if (isFromBoard && !isDragging) return 'tap';
    // Dropping a board piece back on its own cell is a change of mind, not a move.
    if (isFromBoard && sameCell(cell, held.from)) return 'cancel';
    if (isFromBoard && !cell) return 'remove';
    if (!isValid) return 'cancel';
    return isFromBoard ? 'move' : 'place';
  };

  /**
   * A tray-to-grid drag gesture as a state machine. Feed it pointer positions; it answers with hover feedback and,
   * on release, the single action the game should apply.
   * @param {Object} options
   * @param {(point: PlacePoint) => PlaceCell|null} options.cellAt     grid cell under a point, null when off the board.
   * @param {(point: PlacePoint) => *} options.trayKindAt              tray kind under a point, null / undefined when none.
   * @param {(cell: PlaceCell) => *} options.pieceAt                   the piece on a cell, null / undefined when empty.
   * @param {(kind: *, cell: PlaceCell, held: PlaceHeld) => boolean} [options.canPlace]
   *        extra rule for a target cell (stock limits, terrain). The cell being empty is always required.
   * @param {(piece: *) => *} [options.kindOf]                         kind of a board piece; defaults to piece.kind.
   * @param {(piece: *) => boolean} [options.canLift]                  false for pieces that are part of the level and
   *        must stay put: pressing one holds nothing, and its cell still counts as occupied. Defaults to every piece.
   * @param {number} [options.tapSlop=0.2]                             travel (same units as the points) below which a
   *        press on a board piece counts as a tap.
   * @returns {{ begin: (point: PlacePoint) => PlaceHeld|null, move: (point: PlacePoint) => PlaceHover|null,
   *            end: (point: PlacePoint) => PlaceAction|null, cancel: () => void, held: PlaceHeld|null }}
   * @example
   * const drag = Kit.placement({
   *   cellAt: (point) => grid.fromWorld(point.x, point.y),
   *   trayKindAt: (point) => traySlots.find((slot) => Math.abs(slot.x - point.x) < 0.5 && point.y > trayTop),
   *   pieceAt: (cell) => grid.get(cell.x, cell.y),
   * });
   * input.onDrag((info) => {
   *   const point = boardPoint(info);
   *   if (info.phase === 'start') drag.begin(point);
   *   else if (info.phase === 'move') showGhost(drag.move(point));
   *   else applyAction(drag.end(point));     // { type: 'place', held: { kind }, cell } ...
   * });
   */
  const placement = ({ cellAt, trayKindAt, pieceAt, canPlace = () => true, kindOf = (piece) => piece.kind, canLift = () => true, tapSlop = 0.2 }) => {
    let held = null;
    let startPoint = null;
    let isDragging = false;

    const pickUp = (point) => {
      const cell = cellAt(point);
      const piece = cell ? pieceAt(cell) : null;
      if (piece && !canLift(piece)) return null;
      if (piece) return { source: 'board', kind: kindOf(piece), piece, from: cell };
      const kind = trayKindAt(point);
      return kind === null || kind === undefined ? null : { source: 'tray', kind, piece: null, from: null };
    };
    // A piece may land on an empty cell, or on the cell it was lifted from (that case is filtered out as 'cancel' later).
    const accepts = (cell) => !!cell && (!pieceAt(cell) || sameCell(cell, held.from)) && canPlace(held.kind, cell, held);
    const hoverAt = (point) => {
      // Latch: once the pointer has left the tap radius the gesture stays a drag even if it returns to the start.
      isDragging = isDragging || Math.hypot(point.x - startPoint.x, point.y - startPoint.y) > tapSlop;
      const cell = cellAt(point);
      return { held, point, cell, isValid: accepts(cell), isDragging };
    };

    return {
      /** What is being carried right now, or null between gestures. */
      get held() {
        return held;
      },
      /** Start a gesture. Returns what was picked up, or null when the press hit neither a piece nor the tray. */
      begin(point) {
        held = pickUp(point);
        startPoint = point;
        isDragging = false;
        return held;
      },
      /** Pointer moved. Returns hover feedback, or null when nothing is held. */
      move: (point) => (held ? hoverAt(point) : null),
      /** Pointer released. Returns the action to apply, or null when nothing was held. */
      end(point) {
        if (!held) return null;
        const hover = hoverAt(point);
        const type = classifyRelease(held, hover.cell, hover.isDragging, hover.isValid);
        const cell = type === 'place' || type === 'move' ? hover.cell : type === 'tap' ? held.from : null;
        const action = { type, held, cell };
        held = null;
        return action;
      },
      /** Abandon the gesture without an action (pointer cancelled, game paused). */
      cancel() {
        held = null;
      },
    };
  };

  /**
   * World point where the pointer ray meets a plane. Kit.input.ground() covers horizontal floors; this covers
   * upright boards and tilted tables, with perspective or orthographic cameras.
   * @param {THREE.Camera} camera the camera the scene is drawn with (ctx.camera).
   * @param {number} normalisedX pointer x in -1..1 (input.pointer.nx or a drag event's nx).
   * @param {number} normalisedY pointer y in -1..1, up positive (ny).
   * @param {THREE.Plane} plane the surface, e.g. new THREE.Plane(new THREE.Vector3(0, 0, 1), 0) for the z = 0 wall.
   * @returns {THREE.Vector3|null} the hit point, or null when the ray is parallel to or points away from the plane.
   */
  const pointerOnPlane = (camera, normalisedX, normalisedY, plane) => {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(normalisedX, normalisedY), camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  };

  Kit.placement = placement;
  Kit.placement.pointerOnPlane = pointerOnPlane;
})();
