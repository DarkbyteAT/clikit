// Prism Garden model: the whole puzzle as plain data and pure functions. No DOM, no THREE: it runs in node, where
// scratch/prism/solve.js proves every bed and scratch/prism/pace.js simulates hours of play.
//
// Owns: the pieces and what light does at each, the moves a player can make, what counts as solved and which optional
//       goals were met, the campaign beds, the procedural bed forge with its difficulty tiers, and the garden's growth table.
// Does not own: how light travels (Kit.beam), the search itself (Kit.search), stars and medals storage (Kit.levels),
//       lifetime progress (Kit.profile), or anything drawn or heard (games/prism.js).
// Exposed as the global PRISM_MODEL.
//
// A "bed" is a level row (text rows + shelf + goals). A "state" is one position in a bed (see State); it is treated as
// immutable and every move returns a new state.
(() => {
  // ---- hues and pieces -----------------------------------------------------------------------------------------------------

  /**
   * A colour of light, or of a flower. `needs` lists the light hues a flower of this hue must be touched by at the
   * same time; an empty list means any light will do.
   * @typedef {{id: string, color: number, needs: string[]}} Hue
   */
  /** @type {Hue[] & {byId: (id: string) => Hue}} */
  const HUES = Kit.table([
    { id: 'dawn', color: 0xffe9a8, needs: [] }, // the lantern's own light
    { id: 'rose', color: 0xff5f96, needs: ['rose'] },
    { id: 'mint', color: 0x4df0b0, needs: ['mint'] },
    { id: 'twin', color: 0xb9a2ff, needs: ['rose', 'mint'] }, // only opens where a rose beam and a mint beam cross
  ]);
  const LANTERN_HUE = 'dawn';

  /**
   * One board cell or shelf item. Empty soil is null.
   * @typedef {object} Piece
   * @property {'hedge'|'lantern'|'mirror'|'splitter'|'filter'|'flower'|'oneway'|'switch'|'gate'} kind
   * @property {string} [id] - stable identity given at parse time, so the view can follow a piece that is carried
   * @property {number} [dir] - heading of a lantern, or the one heading a one-way glass lets through (Kit.grid.DIRS4 index)
   * @property {0|1} [slant] - mirror / splitter orientation: 0 is "/", 1 is "\"
   * @property {string} [color] - a HUES id: the tint a filter gives, or the hue of a flower
   * @property {boolean} [isBonus] - a moonbloom: a flower the bed does not need, wanted only by the "moon" goal
   * @property {boolean} [canTurn] - a tap flips its slant
   * @property {boolean} [canMove] - it can be carried to any empty cell
   * @property {boolean} [isFromShelf] - it came from the shelf and can be put back there
   */
  /** Bed-text legend: one character per piece. Anything not listed (use ".") is empty soil. @type {Object<string, Piece>} */
  const LEGEND = {
    '#': { kind: 'hedge' },
    '>': { kind: 'lantern', dir: 0 },
    v: { kind: 'lantern', dir: 1 },
    '<': { kind: 'lantern', dir: 2 },
    '^': { kind: 'lantern', dir: 3 },
    '/': { kind: 'mirror', slant: 0, canTurn: true },
    '\\': { kind: 'mirror', slant: 1, canTurn: true },
    '(': { kind: 'mirror', slant: 0, canTurn: true, canMove: true },
    ')': { kind: 'mirror', slant: 1, canTurn: true, canMove: true },
    '%': { kind: 'splitter', slant: 0, canTurn: true },
    '&': { kind: 'splitter', slant: 1, canTurn: true },
    r: { kind: 'filter', color: 'rose' },
    m: { kind: 'filter', color: 'mint' },
    '*': { kind: 'flower', color: 'dawn' },
    R: { kind: 'flower', color: 'rose' },
    M: { kind: 'flower', color: 'mint' },
    T: { kind: 'flower', color: 'twin' },
    o: { kind: 'flower', color: 'dawn', isBonus: true },
    e: { kind: 'oneway', dir: 0 },
    s: { kind: 'oneway', dir: 1 },
    w: { kind: 'oneway', dir: 2 },
    n: { kind: 'oneway', dir: 3 },
    S: { kind: 'switch' }, // a sunstone: while light touches every sunstone, every gate is open
    G: { kind: 'gate' },
  };
  /** What a shelf entry in a bed row turns into. Shelf pieces can always be carried and put back. @type {Object<string, Piece>} */
  const SHELF_PIECES = {
    mirror: { kind: 'mirror', slant: 0, canTurn: true },
    splitter: { kind: 'splitter', slant: 0, canTurn: true },
    rose: { kind: 'filter', color: 'rose' },
    mint: { kind: 'filter', color: 'mint' },
  };
  const SHELF_FLAGS = { canMove: true, isFromShelf: true };

  // ---- light ---------------------------------------------------------------------------------------------------------------

  /** Optics per piece kind while the gates are shut. Flowers and sunstones are absent on purpose: light passes through them. */
  const OPTICS_GATES_SHUT = {
    mirror: Kit.beam.optics.mirror,
    splitter: Kit.beam.optics.splitter,
    filter: Kit.beam.optics.filter,
    oneway: Kit.beam.optics.oneWay,
    hedge: Kit.beam.optics.block,
    lantern: Kit.beam.optics.block,
    gate: Kit.beam.optics.block,
  };
  /** The same with the gates sunk into the soil: without an optic, a gate cell is transparent. */
  const OPTICS_GATES_OPEN = Object.fromEntries(Object.entries(OPTICS_GATES_SHUT).filter(([kind]) => kind !== 'gate'));

  const isKind = (kind) => (cell) => !!cell && cell.kind === kind;
  const isFlower = isKind('flower');
  const isSwitch = isKind('switch');
  const cellKey = (cell) => `${cell.x},${cell.y}`;

  /**
   * The light in a state, with the puzzle's own rules applied on top of the raw trace.
   * @typedef {object} Light
   * @property {object[]} segments - Kit.beam segments, for drawing
   * @property {{x: number, y: number, distance: number, isBonus: boolean}[]} flowers - the open flowers; `distance` is
   *   the cells light travels before the flower has every hue it needs (when to open it in the animation)
   * @property {{x: number, y: number, distance: number}[]} switches - the lit sunstones
   * @property {boolean} areGatesOpen
   * @property {Set<string>} litCells - "x,y" of every cell light passes over or stops in
   */

  /**
   * The parts of a board that no move changes: where light starts and what it can open. Finding them means walking
   * every cell, so the solver does it once per bed instead of once per position.
   * @typedef {{emitters: object[], flowers: object[], sunstones: object[], neededFlowers: number, soil: {x: number, y: number}[]}} BedFacts
   * @param {object} grid - a Kit.grid of Piece | null
   * @returns {BedFacts} `soil` lists the cells with no fixed piece on them
   * @complexity O(cells)
   */
  const factsOf = (grid) => {
    const flowers = grid.find(isFlower);
    return {
      emitters: grid.find(isKind('lantern')).map(({ x, y, v }) => ({ x, y, dir: v.dir, color: LANTERN_HUE })),
      flowers,
      sunstones: grid.find(isSwitch),
      neededFlowers: flowers.filter((flower) => !flower.v.isBonus).length,
      soil: grid.find((cell) => cell === null).map(({ x, y }) => ({ x, y })),
    };
  };

  const traceGrid = (grid, facts, optics) => Kit.beam.trace(grid, facts.emitters, { optics, lights: (cell) => isFlower(cell) || isSwitch(cell) });

  /** When (in cells travelled) a flower has all the light it needs, or null while it lacks some. */
  const openDistance = (flower, passes) => {
    const here = passes.filter((pass) => pass.x === flower.x && pass.y === flower.y);
    const needs = HUES.byId(flower.v.color).needs;
    if (!here.length) return null;
    if (!needs.length) return Math.min(...here.map((pass) => pass.distance));
    const arrivals = needs.map((hue) => here.find((pass) => pass.color === hue));
    return arrivals.every(Boolean) ? Math.max(...arrivals.map((pass) => pass.distance)) : null;
  };

  /** Every cell a list of beam runs covers, as "x,y" keys. */
  const cellsUnder = (segments) =>
    new Set(segments.flatMap((segment) => Array.from({ length: segment.length }, (_, step) => `${segment.from.x + Kit.grid.DIRS4[segment.dir][0] * (step + 1)},${segment.from.y + Kit.grid.DIRS4[segment.dir][1] * (step + 1)}`)));

  /**
   * Trace a board. Sunstones make this a two-pass rule: light is traced with the gates shut; if that lights every
   * sunstone the gates open and light is traced again. Opening gates only ever lets light travel further, so the
   * sunstones stay lit in the second pass and two passes always settle.
   * @param {object} grid - a Kit.grid of Piece | null
   * @param {BedFacts} [facts] - factsOf(grid), passed in by callers that trace many positions of one bed
   * @returns {Light}
   * @complexity two Kit.beam.trace calls at most: O(cells x headings x hues).
   */
  const lightOf = (grid, facts = factsOf(grid)) => {
    const shut = traceGrid(grid, facts, OPTICS_GATES_SHUT);
    const litKeys = new Set(shut.passes.map(cellKey));
    const areGatesOpen = facts.sunstones.length > 0 && facts.sunstones.every((stone) => litKeys.has(cellKey(stone)));
    const traced = areGatesOpen ? traceGrid(grid, facts, OPTICS_GATES_OPEN) : shut;
    const firstLight = (cell) => traced.lit.find((lit) => lit.x === cell.x && lit.y === cell.y);
    return {
      segments: traced.segments,
      flowers: facts.flowers.map((flower) => ({ x: flower.x, y: flower.y, isBonus: !!flower.v.isBonus, distance: openDistance(flower, traced.passes) })).filter((flower) => flower.distance !== null),
      switches: facts.sunstones.filter(firstLight).map((stone) => ({ x: stone.x, y: stone.y, distance: firstLight(stone).distance })),
      areGatesOpen,
      litCells: cellsUnder(traced.segments),
    };
  };

  // ---- states and moves ----------------------------------------------------------------------------------------------------

  /**
   * One position in a bed. Treated as immutable: every move returns a new state.
   * The pieces a player can change are kept in a short list apart from the fixed board, because the solver makes
   * dozens of child states per position and most are duplicates: a child is then a copied list of a few pieces
   * (and its key a string built from that list), and the full grid is only assembled for positions that get explored.
   * Measured in scratch/prism/bench.js: 1.2 ms per explored state with a grid per child, about a tenth of that this way.
   * @typedef {object} State
   * @property {object} fixed - a Kit.grid of the pieces that never change (hedges, lanterns, flowers, fixed glass); null elsewhere
   * @property {(Piece & {x: number, y: number})[]} loose - the turnable and movable pieces on the bed, with their cells
   * @property {Piece[]} shelf - the pieces not yet planted
   *
   * @typedef {{type: 'turn', x: number, y: number}
   *   | {type: 'carry', from: {x: number, y: number}, to: {x: number, y: number}}
   *   | {type: 'place', kind: string, id?: string, to: {x: number, y: number}}
   *   | {type: 'stow', from: {x: number, y: number}}} Move
   *   turn flips a slant; carry moves a loose piece to an empty cell; place plants the first shelf piece of `kind`
   *   (a SHELF_PIECES key) on an empty cell; stow returns a shelf piece from the bed to the shelf.
   */

  /** Shelf key of a piece: which SHELF_PIECES row it was made from. */
  const shelfKindOf = (piece) => (piece.kind === 'filter' ? piece.color : piece.kind);
  const isLoose = (cell) => !!cell && (!!cell.canTurn || !!cell.canMove);
  const isAt = (cell) => (piece) => piece.x === cell.x && piece.y === cell.y;
  /** @returns {object} a new grid equal to `grid` except for the listed [cell, piece] replacements. @complexity O(cells) */
  const withCells = (grid, changes) => changes.reduce((next, [cell, piece]) => next.set(cell.x, cell.y, piece), Kit.grid(grid.w, grid.h, { fill: (x, y) => grid.get(x, y) }));

  /**
   * The starting state of a bed. Board pieces get an id from their starting cell, shelf pieces from their shelf slot.
   * @param {Bed} bed
   * @returns {State}
   */
  const parseBed = (bed) => {
    const parsed = Kit.grid.parse(bed.rows, Object.fromEntries(Object.entries(LEGEND).map(([char, piece]) => [char, (x, y) => ({ ...piece, id: `${x},${y}` })])));
    const loose = parsed.find(isLoose).map(({ x, y, v }) => ({ ...v, x, y }));
    return {
      fixed: withCells(parsed, loose.map((piece) => [piece, null])),
      loose,
      shelf: (bed.shelf || []).map((kind, slot) => {
        if (!SHELF_PIECES[kind]) throw new Error(`Prism bed "${bed.id}": unknown shelf piece "${kind}" (known: ${Object.keys(SHELF_PIECES).join(', ')})`);
        return { ...SHELF_PIECES[kind], ...SHELF_FLAGS, id: `shelf-${slot}` };
      }),
    };
  };

  // A state's full board and its light are asked for several times (is it solved, which goals, which moves matter);
  // states are immutable, so both are built once per state object. WeakMaps let abandoned search states be collected.
  const boardCache = new WeakMap(), lightCache = new WeakMap(), factsCache = new WeakMap();
  const cached = (cache, build) => (state) => {
    if (!cache.has(state)) cache.set(state, build(state));
    return cache.get(state);
  };
  /** @returns {object} the whole bed of a state as one Kit.grid of Piece | null. @complexity O(cells), once per state */
  const boardOf = cached(boardCache, (state) => withCells(state.fixed, state.loose.map((piece) => [piece, piece])));
  /** @returns {Light} the light of a state, traced once per state object */
  /** @returns {BedFacts} the unchanging facts of a state's bed, found once per bed (every state of a bed shares `fixed`) */
  const factsIn = (state) => cached(factsCache, factsOf)(state.fixed);
  const lightIn = cached(lightCache, (state) => lightOf(boardOf(state), factsIn(state)));
  /** @returns {{x: number, y: number}[]} the cells of a state with nothing on them. @complexity O(soil x loose pieces) */
  const emptyCellsOf = (state) => factsIn(state).soil.filter((cell) => !state.loose.some(isAt(cell)));
  const pieceAt = (state, cell) => boardOf(state).get(cell.x, cell.y);

  const replaceLoose = (state, cell, change) => ({ ...state, loose: state.loose.map((piece) => (isAt(cell)(piece) ? change(piece) : piece)) });
  /**
   * What each move type does to a state, the cells a hint should ring, and the words a hint uses.
   * `spots` returns { piece, target }: the cell of the piece to touch (null when it is on the shelf) and where it goes.
   */
  const MOVE_RULES = {
    turn: {
      apply: (state, move) => replaceLoose(state, move, (piece) => ({ ...piece, slant: 1 - piece.slant })),
      spots: (move) => ({ piece: move, target: null }),
      hint: 'Turn the ringed piece',
    },
    carry: {
      apply: (state, move) => replaceLoose(state, move.from, (piece) => ({ ...piece, x: move.to.x, y: move.to.y })),
      spots: (move) => ({ piece: move.from, target: move.to }),
      hint: 'Carry the ringed piece to the blue ring',
    },
    place: {
      apply(state, move) {
        // A player drags one particular shelf piece (move.id); the solver only names a kind and takes the first of it.
        const piece = state.shelf.find((candidate) => (move.id ? candidate.id === move.id : shelfKindOf(candidate) === move.kind));
        return { ...state, loose: state.loose.concat([{ ...piece, x: move.to.x, y: move.to.y }]), shelf: state.shelf.filter((candidate) => candidate !== piece) };
      },
      spots: (move) => ({ piece: null, target: move.to }),
      hint: 'Plant a shelf piece on the blue ring',
    },
    stow: {
      apply: (state, move) => ({ ...state, loose: state.loose.filter((piece) => !isAt(move.from)(piece)), shelf: state.shelf.concat(state.loose.filter(isAt(move.from))) }),
      spots: (move) => ({ piece: move.from, target: null }),
      hint: 'Put the ringed piece back on the shelf',
    },
  };
  /** @returns {State} the state after a move; the state passed in is untouched */
  const applyMove = (state, move) => MOVE_RULES[move.type].apply(state, move);

  const at = ({ x, y }) => ({ x, y });
  /** Moves of the four types for the given turnable pieces and landing cells; shared by the pruned and the full list. */
  const movesFor = (state, { turnable, landingsFor }) =>
    [].concat(
      turnable.map((piece) => ({ type: 'turn', x: piece.x, y: piece.y })),
      [...new Set(state.shelf.map(shelfKindOf))].flatMap((kind) => landingsFor(null).map((to) => ({ type: 'place', kind, to: at(to) }))),
      state.loose.filter((piece) => piece.isFromShelf).map((from) => ({ type: 'stow', from: at(from) })),
      state.loose.filter((piece) => piece.canMove).flatMap((from) => landingsFor(from).map((to) => ({ type: 'carry', from: at(from), to: at(to) })))
    );
  /**
   * The moves worth searching from a state. Any solution can be reordered so that each piece is touched while light
   * is on it (work outward from the lanterns), so the search only turns lit pieces and only sets pieces down on lit
   * cells; one unlit "parking" cell is kept so a piece that is in the way can be carried out of the light. This is the
   * difference between a hundred states and a thousand; scratch/prism/solve.js cross-checks it against listAllMoves.
   * @param {State} state
   * @returns {Move[]}
   * @complexity O(cells + loose pieces x lit cells)
   */
  const listUsefulMoves = (state) => {
    const { litCells } = lightIn(state);
    const isLit = (cell) => litCells.has(cellKey(cell));
    const emptyCells = emptyCellsOf(state);
    const landings = emptyCells.filter(isLit);
    const parking = emptyCells.filter((cell) => !isLit(cell)).slice(0, 1);
    return movesFor(state, {
      turnable: state.loose.filter((piece) => piece.canTurn && isLit(piece)),
      // A shelf piece in the way is stowed, so only pieces that cannot be stowed need the parking cell.
      landingsFor: (piece) => (piece && !piece.isFromShelf ? landings.concat(parking) : landings),
    });
  };
  /** Every legal move, for checking the pruning: all turns, and every empty cell as a destination. @returns {Move[]} */
  const listAllMoves = (state) => {
    const emptyCells = emptyCellsOf(state);
    return movesFor(state, { turnable: state.loose.filter((piece) => piece.canTurn), landingsFor: () => emptyCells });
  };

  /** A bed is solved when every flower it needs is open (moonblooms are optional). */
  const isSolved = (state) => lightIn(state).flowers.filter((flower) => !flower.isBonus).length === factsIn(state).neededFlowers;

  // A move changes one loose piece and shares the rest with its parent state, so each piece object's key is built once.
  const looseKeyCache = new WeakMap();
  const looseKey = cached(looseKeyCache, (piece) => `${piece.isFromShelf ? shelfKindOf(piece) : piece.id}@${piece.x},${piece.y}/${piece.slant}`);
  /**
   * Two states are the same position when every loose piece sits and slants the same and the shelf holds the same
   * kinds. Shelf pieces of one kind are interchangeable, so they are keyed by kind, not identity.
   * @complexity O(p log p) for p loose pieces; never touches the grid
   */
  const stateKey = (state) =>
    state.loose
      .map(looseKey)
      .sort()
      .concat(state.shelf.map(shelfKindOf).sort())
      .join(' ');

  /** States a hint or a forged bed may explore before giving up; keeps the worst case short on a phone. */
  const DEFAULT_SOLVE_LIMIT = 3000;
  /**
   * Fewest moves from a state to a goal.
   * @param {State} state
   * @param {object} [options]
   * @param {(state: State) => boolean} [options.isGoal] - default: the bed is solved
   * @param {number} [options.limit] - states to explore before giving up
   * @param {(state: State) => Move[]} [options.movesOf] - default listUsefulMoves
   * @returns {{moves: Move[], explored: number} | null}
   * @complexity O(explored states x moves per state); each explored state is traced once. See Kit.search.shortest.
   */
  const solve = (state, { isGoal = isSolved, limit = DEFAULT_SOLVE_LIMIT, movesOf = listUsefulMoves } = {}) =>
    Kit.search.shortest({ start: state, keyOf: stateKey, isGoal, limit, movesOf: (from) => movesOf(from).map((move) => ({ move, state: applyMove(from, move) })) });

  // ---- goals: three buds a bed ---------------------------------------------------------------------------------------------

  /**
   * An optional goal, checked on a solved state. Each one met (ever) is one bud.
   * @typedef {object} Goal
   * @property {string} id
   * @property {(bed: Bed) => string} text - what the player is asked to do
   * @property {(result: {state: State, moves: number, bed: Bed}) => boolean} isMet
   */
  /** @type {Goal[] & {byId: (id: string) => Goal}} */
  const GOALS = Kit.table([
    { id: 'bloom', text: () => 'Open every flower', isMet: () => true },
    { id: 'par', text: (bed) => `Finish in ${bed.par} ${bed.par === 1 ? 'move' : 'moves'}`, isMet: ({ moves, bed }) => moves <= bed.par },
    { id: 'moon', text: () => 'Wake the moonbloom too', isMet: ({ state }) => lightIn(state).flowers.some((flower) => flower.isBonus) },
    { id: 'tidy', text: () => 'Let no light leave the bed', isMet: ({ state }) => !lightIn(state).segments.some((segment) => segment.leaves) },
    { id: 'spare', text: (bed) => `Leave ${bed.spare} on the shelf`, isMet: ({ state, bed }) => state.shelf.length >= bed.spare },
  ]);
  /** @returns {string[]} the goal ids a bed offers, in bud order: bloom, par, then its laurel if it has one */
  const goalsOf = (bed) => ['bloom', 'par'].concat(bed.laurel ? [bed.laurel] : []);
  /** @returns {string[]} the goal ids met by finishing `bed` in `state` after `moves` moves */
  const goalsMet = (bed, state, moves) => goalsOf(bed).filter((id) => GOALS.byId(id).isMet({ state, moves, bed }));

  // ---- campaign ------------------------------------------------------------------------------------------------------------

  /**
   * A garden bed.
   * @typedef {object} Bed
   * @property {string} id
   * @property {string} name
   * @property {string} [chapter] - campaign beds only
   * @property {number} par - fewest moves that open every flower (proved by scratch/prism/solve.js, which fails if it drifts)
   * @property {string} [tip] - one line shown until the first move
   * @property {string[]} rows - board text, see LEGEND
   * @property {string[]} [shelf] - SHELF_PIECES keys the player may plant
   * @property {'moon'|'tidy'|'spare'} [laurel] - the bed's third goal (a GOALS id)
   * @property {number} [spare] - for the "spare" laurel: pieces that must stay on the shelf
   * @property {number} [rating] - forged beds only: Kit.search.difficulty of the solver's solution
   */
  /**
   * The campaign: four chapters, each adding a rule that interacts with the ones before it.
   * @type {Bed[]}
   */
  const BEDS = [
    // I. Mirrors: turning, chaining, hedges, splitting.
    { id: 'first-light', chapter: 'I. Mirrors', name: 'First Light', par: 1, laurel: 'tidy', tip: 'Tap the mirror to turn it', rows: ['..#..', '..*..', '>.\\..', '.....', '.....'] },
    { id: 'two-turns', chapter: 'I. Mirrors', name: 'Two Turns', par: 2, laurel: 'moon', tip: 'Light passes through flowers', rows: ['.....', '.\\*./', '.....', '.*...', '....*', '.^o.\\'] },
    { id: 'hedgerow', chapter: 'I. Mirrors', name: 'Hedgerow', par: 3, laurel: 'tidy', tip: 'Hedges swallow the light', rows: ['..\\.*\\', '..*...', '...##.', '>.\\..*', '..#...', '../.*\\'] },
    { id: 'fork', chapter: 'I. Mirrors', name: 'The Fork', par: 3, laurel: 'moon', tip: 'Glass splits the beam in two', rows: ['..*..', '.....', '>.&./', '..o..', '....*', '../*\\'] },
    // II. Colour: tinting, two hues from one beam, hues that must meet.
    { id: 'rose-glass', chapter: 'II. Colour', name: 'Rose Glass', par: 2, laurel: 'tidy', tip: 'Rose flowers need rose light', rows: ['..\\./.', '..r...', '/*\\.R#', '......', '....*.', '^.\\./.'] },
    { id: 'two-hues', chapter: 'II. Colour', name: 'Two Hues', par: 3, laurel: 'moon', tip: 'One beam, two colours', rows: ['..\\.M.', '......', '..m...', '>.&r./', '..o..R', '../*./'] },
    { id: 'twin-bloom', chapter: 'II. Colour', name: 'Twin Bloom', par: 3, laurel: 'moon', tip: 'The violet flower needs rose and mint at once', rows: ['..\\.*/', '......', '..m...', '>.&r.T', '.o...\\'] },
    // III. The Shelf: pieces you choose to spend.
    { id: 'carry', chapter: 'III. The Shelf', name: 'The Amber Mirror', par: 3, laurel: 'moon', tip: 'Drag the amber mirror onto the beam', rows: ['...\\o', '...*.', '>....', '.*...', '(\\.\\.'] },
    { id: 'potting-shelf', chapter: 'III. The Shelf', name: 'Potting Shelf', par: 1, laurel: 'moon', tip: 'Drag a piece from the shelf onto the bed', rows: ['o../.', '...*.', '>*...', '.....', '.....'], shelf: ['mirror'] },
    { id: 'spare-glass', chapter: 'III. The Shelf', name: 'Spare Glass', par: 2, laurel: 'spare', spare: 1, tip: 'You need not plant everything', rows: ['..\\../', '..*..*', '>..*..', '......'], shelf: ['splitter', 'mirror'] },
    // IV. Night: glass that passes one way, sunstones that open gates, more than one lantern.
    { id: 'moth-glass', chapter: 'IV. Night', name: 'Moth Glass', par: 3, laurel: 'moon', tip: 'Moth glass lets light through one way only', rows: ['..\\.*\\', '......', '>.\\w*\\', '......', '..*...', '../..o'] },
    { id: 'sunstone', chapter: 'IV. Night', name: 'Sunstone', par: 2, laurel: 'moon', tip: 'Light the sunstone to sink the gate', rows: ['....o.', '..S...', '>.&.G/', '.....*', '..*../'], shelf: ['mirror'] },
    { id: 'two-lanterns', chapter: 'IV. Night', name: 'Two Lanterns', par: 2, laurel: 'tidy', tip: 'Two lights, one violet flower', rows: ['>.*./.', '....r.', '......', '..\\.T#', '..m.R.', '>.\\./#'] },
    { id: 'night-garden', chapter: 'IV. Night', name: 'Night Garden', par: 4, laurel: 'moon', tip: 'Everything you have learned', rows: ['...mM\\', '.....*', '.#...#', '>.&.r/', '.#....', '.o...R', '(/.*.\\'] },
  ];

  // ---- the forge: procedural beds, proven by the solver --------------------------------------------------------------------

  /**
   * How a forged bed is built at one difficulty tier. The forge works backwards from a solved layout, so every bed has
   * a solution by construction; the solver then finds the real minimum and rates it.
   * @typedef {object} Tier
   * @property {string} id
   * @property {string} name - shown to the player
   * @property {number} width
   * @property {number} height
   * @property {number} bends - mirrors / splitters laid along the route
   * @property {number} flowers
   * @property {number} shelf - how many of the route's pieces are lifted onto the shelf
   * @property {number} decoys - turnable mirrors that the solution does not need
   * @property {number} hedges
   * @property {number} splitChance - 0..1 chance that one bend is a splitter
   * @property {number} tintChance - 0..1 chance that the route passes a filter
   * @property {number} minMoves - a proposal the solver finishes in fewer moves is rejected as too easy
   */
  /** @type {Tier[] & {byId: (id: string) => Tier}} */
  const TIERS = Kit.table([
    { id: 'seedling', name: 'Gentle', width: 5, height: 5, bends: 2, flowers: 2, shelf: 0, decoys: 1, hedges: 1, splitChance: 0, tintChance: 0, minMoves: 2 },
    { id: 'sapling', name: 'Winding', width: 5, height: 6, bends: 3, flowers: 3, shelf: 1, decoys: 1, hedges: 2, splitChance: 0.5, tintChance: 0.3, minMoves: 3 },
    { id: 'bramble', name: 'Tangled', width: 6, height: 6, bends: 4, flowers: 3, shelf: 1, decoys: 2, hedges: 2, splitChance: 0.6, tintChance: 0.7, minMoves: 4 },
    { id: 'thicket', name: 'Thorny', width: 6, height: 7, bends: 5, flowers: 4, shelf: 2, decoys: 2, hedges: 3, splitChance: 0.8, tintChance: 0.9, minMoves: 5 },
  ]);
  /** Which tier the nth wild bed uses (n counts wild beds already solved): difficulty grows with the player. */
  const WILD_TIER_AT = Kit.curve.of({ steps: [[0, 0], [3, 1], [8, 2], [16, 3]] });
  const FORGE = {
    attempts: 30, // proposals before settling for the hardest solvable one
    flipChance: 0.65, // chance that a route mirror left on the bed starts turned the wrong way
    minRun: 2, // a bend must send the light at least this many cells, so routes do not hug the edge
    wildSeed: 0x51ab, // offsets, so wild bed 3 and day 3 are different beds
    dailySeed: 0xda11,
    dailyTier: 'bramble',
    ratingDecimals: 1, // a bed's rating is shown to the player, so it is kept short
  };
  const WILD_NAMES = {
    first: ['Quiet', 'Mossy', 'Silver', 'Sleeping', 'Crooked', 'Hidden', 'Dewy', 'Moonlit'],
    second: ['Hollow', 'Terrace', 'Border', 'Corner', 'Walk', 'Plot', 'Arbour', 'Nook'],
  };

  /** The legend character of a piece: the entry whose every field the piece shares (ignoring its id). */
  const charOf = (piece) => {
    if (piece === null) return '.';
    const fields = (candidate) => JSON.stringify(Object.entries(candidate).filter(([name]) => name !== 'id').sort());
    return Object.keys(LEGEND).find((char) => fields(LEGEND[char]) === fields(piece));
  };
  /** @returns {string[]} bed text for a grid (the inverse of parsing) */
  const rowsOf = (grid) => Array.from({ length: grid.h }, (_, y) => Array.from({ length: grid.w }, (_, x) => charOf(grid.get(x, y))).join(''));

  /** The raw light on a grid, reporting the empty cells it crosses (the forge decides what to put on them). */
  const traceGridOver = (grid) => Kit.beam.trace(grid, factsOf(grid).emitters, { optics: OPTICS_GATES_SHUT, lights: (cell) => cell === null });
  /** Hue ids of the light crossing each empty cell of a grid: Map "x,y" -> { x, y, hues, distance (of the first light) }. */
  const lightOnSoil = (grid) =>
    traceGridOver(grid).passes.reduce((byCell, pass) => {
      const seen = byCell.get(cellKey(pass)) || { x: pass.x, y: pass.y, hues: [], distance: pass.distance };
      return byCell.set(cellKey(pass), { ...seen, hues: seen.hues.concat([pass.color]) });
    }, new Map());

  /** Which flower suits the light on a cell: violet where rose and mint cross, a tinted flower where only tinted light falls. */
  const flowerFor = (hues) => {
    if (hues.includes('rose') && hues.includes('mint')) return LEGEND.T;
    if (hues.includes(LANTERN_HUE)) return LEGEND['*'];
    return hues.includes('rose') ? LEGEND.R : LEGEND.M;
  };

  /**
   * Lay one bend on a free end of the light: a mirror (or splitter) on a cell of a run that currently leaves the bed,
   * slanted so the reflected light stays on the bed for at least FORGE.minRun cells.
   * @returns {object | null} the grid with the bend, or null when no cell and slant works
   */
  const addBend = (grid, rng, kind) => {
    const freeRuns = traceGridOver(grid).segments.filter((segment) => segment.leaves && segment.length > 1);
    const spots = rng.shuffle(
      freeRuns.flatMap((segment) =>
        // Skip the first cell of a run so two optics never touch, and try both slants in a random order.
        Array.from({ length: segment.length - 1 }, (_, step) => ({ x: segment.from.x + Kit.grid.DIRS4[segment.dir][0] * (step + 2), y: segment.from.y + Kit.grid.DIRS4[segment.dir][1] * (step + 2), dir: segment.dir }))
      )
    ).filter((spot) => grid.get(spot.x, spot.y) === null);
    const attempts = spots.flatMap((spot) => rng.shuffle([0, 1]).map((slant) => ({ spot, slant })));
    const runAfter = ({ spot, slant }, bent) => traceGridOver(bent).segments.find((segment) => segment.from.x === spot.x && segment.from.y === spot.y && segment.dir === Kit.beam.reflect(spot.dir, slant));
    const laid = attempts.map((attempt) => ({ attempt, bent: withCells(grid, [[attempt.spot, { kind, slant: attempt.slant, canTurn: true, id: cellKey(attempt.spot) }]]) })).find(({ attempt, bent }) => {
      const run = runAfter(attempt, bent);
      return !!run && run.length >= FORGE.minRun;
    });
    return laid ? laid.bent : null;
  };

  /** Put a piece on a random cell that passes `isFree`, or return the grid unchanged when there is none. */
  const scatter = (grid, rng, isFree, makePiece) => {
    const cells = grid.find((cell, x, y) => cell === null && isFree({ x, y }));
    if (!cells.length) return grid;
    const cell = rng.pick(cells);
    return withCells(grid, [[cell, { ...makePiece(cell), id: cellKey(cell) }]]);
  };
  const times = (count, step, start) => Array.from({ length: count }).reduce(step, start);

  /**
   * Propose one bed for a tier: build a solved layout, then scramble it. Not yet proven to need `minMoves`: forgeBed
   * solves each proposal and keeps the first that does.
   * @param {object} rng - a Kit.rng
   * @param {Tier} tier
   * @returns {{rows: string[], shelf: string[], changes: number} | null} `changes` counts the pieces lifted or turned, an
   *   upper bound on the moves needed; null when the layout came out without enough lit soil for its flowers
   * @complexity O(bends x cells) traces of O(cells) each: well under a millisecond per proposal.
   */
  const proposeBed = (rng, tier) => {
    // The lantern sits on the left or bottom edge, away from the corners, pointing into the bed.
    const isOnLeft = rng.chance(0.5);
    const lantern = isOnLeft ? { x: 0, y: rng.int(1, tier.height - 2), dir: 0 } : { x: rng.int(1, tier.width - 2), y: tier.height - 1, dir: 3 };
    const empty = withCells(Kit.grid(tier.width, tier.height), [[lantern, { kind: 'lantern', dir: lantern.dir, id: 'lantern' }]]);
    // 1. The route: bends, at most one of them a splitter, with a filter dropped on the light part-way through.
    const splitterAt = rng.chance(tier.splitChance) ? rng.int(0, tier.bends - 1) : -1;
    const tintAt = rng.chance(tier.tintChance) ? rng.int(1, tier.bends - 1) : -1;
    const route = times(
      tier.bends,
      (grid, _, bend) => {
        const tinted = bend === tintAt ? scatter(grid, rng, (cell) => lightOnSoil(grid).has(cellKey(cell)), () => ({ kind: 'filter', color: rng.pick(['rose', 'mint']) })) : grid;
        return addBend(tinted, rng, bend === splitterAt ? 'splitter' : 'mirror') || tinted;
      },
      empty
    );
    // 2. Flowers on lit soil, the farthest cell first so the whole route matters, each matching the light that falls on it.
    const soil = [...lightOnSoil(route).values()].sort((a, b) => b.distance - a.distance);
    if (soil.length < tier.flowers) return null;
    const flowerCells = soil.slice(0, 1).concat(rng.shuffle(soil.slice(1)).slice(0, tier.flowers - 1));
    const solved = withCells(route, flowerCells.map((cell) => [cell, { ...flowerFor(cell.hues), id: cellKey(cell) }]));
    // 3. Clutter where the solved light never falls, so it cannot break the known solution: hedges and decoy mirrors.
    const solvedLight = lightOf(solved).litCells;
    const isDark = (cell) => !solvedLight.has(cellKey(cell));
    const hedged = times(tier.hedges, (grid) => scatter(grid, rng, isDark, () => ({ kind: 'hedge' })), solved);
    const cluttered = times(tier.decoys, (grid) => scatter(grid, rng, isDark, () => ({ kind: 'mirror', slant: rng.int(0, 1), canTurn: true })), hedged);
    // 4. Scramble: lift some route pieces onto the shelf, and turn most of the rest the wrong way.
    const bends = rng.shuffle(cluttered.find((cell, x, y) => !!cell && cell.canTurn && !isDark({ x, y })));
    const lifted = bends.slice(0, tier.shelf);
    const flipped = bends.slice(tier.shelf).filter(() => rng.chance(FORGE.flipChance));
    const scrambled = withCells(cluttered, lifted.map((cell) => [cell, null]).concat(flipped.map((cell) => [cell, { ...cell.v, slant: 1 - cell.v.slant }])));
    return { rows: rowsOf(scrambled), shelf: lifted.map((cell) => cell.v.kind), changes: lifted.length + flipped.length };
  };

  /**
   * Forge a bed from a seed: the same seed and tier always give the same bed. Every bed returned has been solved by the
   * solver; `par` is its proven minimum and `rating` how hard the search found it.
   * @param {object} options
   * @param {number} options.seed
   * @param {string} options.tier - a TIERS id
   * @param {string} [options.id] - default "forged-<seed>"
   * @returns {Bed}
   * @complexity O(FORGE.attempts x solve), each solve capped at DEFAULT_SOLVE_LIMIT states. Measured by
   *   scratch/prism/solve.js; see its output for milliseconds per tier.
   * @example PRISM_MODEL.forgeBed({ seed: 7, tier: 'sapling' }) // { id: 'forged-7', name: 'Mossy Walk', par: 3, rating: 7.2, rows: [...], shelf: ['mirror'] }
   */
  const forgeBed = ({ seed, tier, id = `forged-${seed}` }) => {
    const rng = Kit.rng(seed);
    const tierRow = TIERS.byId(tier);
    const name = `${rng.pick(WILD_NAMES.first)} ${rng.pick(WILD_NAMES.second)}`;
    const forged = Kit.search.generate({
      attempts: FORGE.attempts,
      // Undoing the scramble solves the bed, so a proposal with fewer changes than the tier wants can never be hard
      // enough: drop it before paying for a search.
      propose: () => [proposeBed(rng, tierRow)].find((proposal) => !!proposal && proposal.changes >= tierRow.minMoves) || null,
      solve: (proposal) => solve(parseBed({ id, ...proposal })),
      accept: (solution) => solution.moves.length >= tierRow.minMoves,
    });
    if (!forged) throw new Error(`Prism forge: no solvable bed for seed ${seed} at tier "${tier}" in ${FORGE.attempts} attempts; raise FORGE.attempts or ease the tier`);
    return { id, name, tier, rows: forged.puzzle.rows, shelf: forged.puzzle.shelf, par: forged.solution.moves.length, rating: Number(Kit.search.difficulty(forged.solution).toFixed(FORGE.ratingDecimals)) };
  };
  /** The nth wild bed (n = wild beds already solved): tiers step up as the count grows. @returns {Bed} */
  const wildBed = (index) => forgeBed({ seed: FORGE.wildSeed + index, tier: TIERS[WILD_TIER_AT(index)].id, id: `wild-${index}` });
  /** The bed of a given day (see Kit.levels.dayNumber): the same for every player. @returns {Bed} */
  const dailyBed = (day) => forgeBed({ seed: FORGE.dailySeed + day, tier: FORGE.dailyTier, id: `daily-${day}` });

  // ---- the garden: what collecting buds changes ----------------------------------------------------------------------------

  /**
   * Milestones on the lifetime bud count, as Kit.profile achievement rows. `unlocks` names a mode or a part of the
   * garden around the bed; `news` is the line shown when it happens.
   */
  const GARDEN = [
    { id: 'daily', stat: 'buds', target: 4, unlocks: 'daily', text: 'Gather 4 buds', news: 'A daily bed now waits at the gate' },
    { id: 'wild', stat: 'buds', target: 9, unlocks: 'wild', text: 'Gather 9 buds', news: 'The wild beds beyond the wall are open' },
    { id: 'fireflies', stat: 'buds', target: 15, unlocks: 'fireflies', text: 'Gather 15 buds', news: 'Fireflies have found the garden' },
    { id: 'lilies', stat: 'buds', target: 27, unlocks: 'lilies', text: 'Gather 27 buds', news: 'Moon lilies open along the path' },
    { id: 'arbour', stat: 'buds', target: 40, unlocks: 'arbour', text: 'Gather 40 buds', news: 'The old arbour is in leaf again' },
    { id: 'pond', stat: 'buds', target: 60, unlocks: 'pond', text: 'Gather 60 buds', news: 'A still pond mirrors the night sky' },
    { id: 'moon', stat: 'buds', target: 85, unlocks: 'moon', text: 'Gather 85 buds', news: 'The moon has risen over the garden' },
  ];

  // ---- the long arc as a headless model (tools/sim.js, scratch/prism/pace.js) ---------------------------------------------

  /**
   * How long a person is assumed to take over one visit to a bed: a guess, not a playtest. A rating-2 tutorial comes
   * out near 40 seconds, a rating-11 bed near two minutes.
   */
  const PACE = { secondsBase: 22, secondsPerRating: 9, proofLimit: 400000 };

  /**
   * The solver's two routes through a bed: the par route and, when the bed has a laurel, the cheapest route that also
   * earns it. Each says how hard the search found it, how long a visit is assumed to take, and which goals it earns.
   * @param {Bed} bed
   * @returns {{par: {rating: number, seconds: number, goals: string[]}, laurel: ?{rating: number, seconds: number, goals: string[]}}}
   * @complexity two solves of the bed; cached per bed object by routesIn
   */
  const routesOf = (bed) => {
    const start = parseBed(bed);
    const routeTo = (isGoal) => {
      const solution = solve(start, { isGoal, limit: PACE.proofLimit });
      const end = solution.moves.reduce(applyMove, start);
      const rating = Kit.search.difficulty(solution);
      return { rating, seconds: PACE.secondsBase + PACE.secondsPerRating * rating, goals: goalsMet(bed, end, solution.moves.length) };
    };
    return { par: routeTo(isSolved), laurel: bed.laurel ? routeTo((state) => isSolved(state) && GOALS.byId(bed.laurel).isMet({ state, moves: 0, bed })) : null };
  };
  const routesCache = new WeakMap();
  const routesIn = cached(routesCache, routesOf);

  /**
   * The progression interface tools/sim.js plays (see tools/dev/simulate.js): a keen player who takes each campaign
   * bed's par route, comes back for its laurel, and then works through the wild beds. Buds are the currency; the
   * garden's milestones are what they unlock.
   */
  const progression = {
    createState: () => ({ profile: Kit.profile({ achievements: GARDEN }), progress: Kit.levels(BEDS), seen: new Set() }),
    /** The one thing a keen player does next: the first campaign goal still open, else the next wild bed. */
    actions({ profile, progress }) {
      const open = BEDS.find((bed) => goalsOf(bed).some((goal) => !progress.medals(bed.id).includes(goal)));
      if (open) return [{ id: `${open.id}:${progress.medals(open.id).includes('par') ? 'laurel' : 'par'}`, kind: 'play', label: open.name }];
      return profile.isUnlocked('wild') ? [{ id: `wild-${profile.stat('wildSolved')}:par`, kind: 'play', label: 'wild bed' }] : [];
    },
    /** Plays one route. What counts as new: garden milestones, the first bed of a chapter (a new rule) and a new wild tier. */
    apply({ profile, progress, seen }, action) {
      const [bedId, routeName] = action.id.split(':');
      const campaignBed = BEDS.find((bed) => bed.id === bedId);
      const bed = campaignBed || wildBed(profile.stat('wildSolved'));
      const route = routesIn(bed)[routeName];
      const unlockedBefore = profile.unlocked();
      const budsEarned = campaignBed ? progress.complete(bed.id, bed.par, route.goals).newMedals.length : route.goals.length;
      if (!campaignBed) profile.count('wildSolved');
      if (budsEarned) profile.count('buds', budsEarned);
      const firsts = [bed.chapter && `chapter ${bed.chapter}`, bed.tier && `wild tier ${bed.tier}`].filter((tag) => !!tag && !seen.has(tag));
      firsts.forEach((tag) => seen.add(tag));
      return { seconds: route.seconds, unlocked: firsts.concat(profile.unlocked().filter((id) => !unlockedBefore.includes(id))) };
    },
    summary: ({ profile, progress, seen }) => ({
      currency: profile.stat('buds'),
      owned: profile.unlocked().length + seen.size + BEDS.filter((bed) => progress.best(bed.id) !== null).length,
      remaining: GARDEN.length - profile.unlocked().length + BEDS.filter((bed) => progress.best(bed.id) === null).length,
    }),
  };

  window.PRISM_MODEL = {
    HUES, LANTERN_HUE, LEGEND, SHELF_PIECES, MOVE_RULES, GOALS, BEDS, TIERS, GARDEN, DEFAULT_SOLVE_LIMIT,
    parseBed, applyMove, listUsefulMoves, listAllMoves, boardOf, lightIn, isSolved, solve, stateKey, shelfKindOf,
    goalsOf, goalsMet, forgeBed, wildBed, dailyBed, PACE, routesOf: routesIn, progression,
  };
})();
