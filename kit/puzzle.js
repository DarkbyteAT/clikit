// Kit puzzle: the rule-free parts of a turn-based board puzzle. Pure, no THREE; runs in node (see tools/test-kit.js).
//
//   beam   - light travelling over a Kit.grid:   Kit.beam.trace(grid, emitters, { optics, lights }) -> { segments, lit, passes }
//   search - fewest-moves solution of any puzzle: Kit.search.shortest({ start, keyOf, movesOf, isGoal }) -> { moves, explored }
//            how hard that was:                   Kit.search.difficulty(solution)
//            generate-and-verify:                 Kit.search.generate({ propose, solve, accept }) -> { puzzle, solution }
//   levels - progress through a list of levels:   Kit.levels(rows, { save }).complete('fork', 4, ['tidy']) -> { stars, isBest, newMedals }
//
// Owns: how light moves between cells and what the stock optics do to it, state-space search, star maths, unlock order.
// Does not own: what a level contains, which moves a game allows, or how anything is drawn. The one function that touches
// the DOM is Kit.levels.select, and it only does so through the ctx.ui object passed to it.
(() => {
  const { DIRS4 } = Kit.grid;

  // ---- beam: light over a grid -------------------------------------------------------------------------------------------

  /**
   * A ray of light leaving a cell.
   * @typedef {object} Beam
   * @property {number} x - column of the cell the light leaves from
   * @property {number} y - row of the cell the light leaves from
   * @property {number} dir - index into Kit.grid.DIRS4 (0 east, 1 south, 2 west, 3 north)
   * @property {*} color - opaque colour value; only filters and the `lights` test give it meaning
   */

  /**
   * One straight run of light, in the order the tracer found it.
   * @typedef {object} BeamSegment
   * @property {{x: number, y: number}} from - cell the run leaves from (an emitter or the optic that produced it)
   * @property {{x: number, y: number}} to - last cell the run reaches: the optic that stopped it, or the last cell on the board
   * @property {number} dir - index into Kit.grid.DIRS4
   * @property {*} color - colour carried along the run
   * @property {number} start - cells travelled from the emitter before this run begins (for animating in route order)
   * @property {number} length - cells covered by the run, `from` to `to`
   * @property {boolean} leaves - true when the run ended by leaving the board rather than at an optic
   */

  /**
   * What an optic does to light that enters its cell: the rays that leave it. An empty list absorbs the light.
   * @callback Optic
   * @param {object} cell - the grid value of the optic's cell
   * @param {Beam} beam - the incoming ray (its x, y are where the ray started, not the optic's cell)
   * @returns {{dir: number, color: *}[]}
   */

  /**
   * Direction of light after bouncing off a diagonal mirror.
   * @param {number} dir - incoming DIRS4 index
   * @param {number} slant - 0 for a "/" mirror (rises to the east), 1 for a "\" mirror (falls to the east)
   * @returns {number} outgoing DIRS4 index
   * @example Kit.beam.reflect(0, 0) // 3: light heading east leaves a "/" mirror heading north
   *
   * With rows growing downward, "/" swaps east with north and south with west (0<->3, 1<->2, i.e. 3 - dir);
   * "\" swaps east with south and west with north (0<->1, 2<->3, i.e. flip the lowest bit).
   */
  const reflect = (dir, slant) => (slant === 0 ? 3 - dir : dir ^ 1);

  /**
   * Stock optics, keyed by the names a game is likely to use as `cell.kind`. Compose a game's own table from these.
   * mirror and splitter read `cell.slant` (see reflect); filter reads `cell.color`; oneWay reads `cell.dir`.
   * @type {Object<string, Optic>}
   */
  const optics = {
    mirror: (cell, beam) => [{ dir: reflect(beam.dir, cell.slant), color: beam.color }],
    splitter: (cell, beam) => [{ dir: beam.dir, color: beam.color }, { dir: reflect(beam.dir, cell.slant), color: beam.color }],
    filter: (cell, beam) => [{ dir: beam.dir, color: cell.color }],
    // One-way glass: light heading `cell.dir` passes unchanged, light from any other side is absorbed.
    oneWay: (cell, beam) => (beam.dir === cell.dir ? [{ dir: beam.dir, color: beam.color }] : []),
    block: () => [],
  };

  /**
   * Follow light from its emitters across a grid until every ray is absorbed, leaves the board or repeats itself.
   * Cells whose kind has no optic are transparent, so targets may sit in the path of a ray.
   * @param {object} grid - a Kit.grid
   * @param {Beam[]} emitters - rays to start with (light begins in the cell after the emitter's own)
   * @param {object} [options]
   * @param {Object<string, Optic>} [options.optics] - optic per cell kind; kinds not listed let light through
   * @param {(cell: *) => string} [options.kindOf] - how to read a cell's kind (default `cell.kind`)
   * @param {(cell: *, color: *) => boolean} [options.lights] - does light of this colour light this cell? (default: nothing is a target)
   * @returns {{segments: BeamSegment[], lit: {x: number, y: number, color: *, distance: number}[], passes: {x: number, y: number, color: *, distance: number}[]}}
   *   `lit` lists each lit cell once, with the cells travelled from the emitter when light first reached it.
   *   `passes` lists every distinct (cell, colour) pair that lit a cell, for targets that need several colours at once.
   * @complexity O(cells x headings x colours) time and space: each (cell, heading, colour) ray is walked at most once,
   *   and a walk is at most max(width, height) cells. A 6 x 7 board with three colours traces in a few microseconds.
   * @example
   *   const grid = Kit.grid.parse(['>./', '..*'], { '/': { kind: 'mirror', slant: 1 }, '*': { kind: 'target' } });
   *   Kit.beam.trace(grid, [{ x: 0, y: 0, dir: 0, color: 'white' }], { optics: Kit.beam.optics, lights: (cell) => !!cell && cell.kind === 'target' });
   */
  function trace(grid, emitters, options = {}) {
    const { optics: opticByKind = {}, kindOf = (cell) => cell && cell.kind, lights = () => false } = options;
    const segments = [];
    const litByCell = new Map();
    const passByCellAndColor = new Map();
    // A ray is fully described by where it starts, its heading and its colour. Tracing each such ray only once is what
    // makes mirror loops terminate: there are finitely many of them.
    const tracedRays = new Set();
    const pending = emitters.map((emitter) => ({ ...emitter, distance: 0 }));
    // Index loop on purpose: `pending` grows while it is being walked (optics add outgoing rays).
    for (let next = 0; next < pending.length; next++) {
      const ray = pending[next];
      const rayKey = [ray.x, ray.y, ray.dir, ray.color].join(',');
      if (tracedRays.has(rayKey)) continue;
      tracedRays.add(rayKey);
      const [stepX, stepY] = DIRS4[ray.dir];
      let outgoing = null; // stays null when the ray runs off the board without meeting an optic
      const end = grid.ray(ray.x, ray.y, stepX, stepY, (cell, x, y, steps) => {
        const cellKey = x + ',' + y;
        if (lights(cell, ray.color)) {
          const pass = { x, y, color: ray.color, distance: ray.distance + steps };
          const passKey = cellKey + ',' + ray.color;
          if (!litByCell.has(cellKey)) litByCell.set(cellKey, pass);
          if (!passByCellAndColor.has(passKey)) passByCellAndColor.set(passKey, pass);
        }
        const optic = opticByKind[kindOf(cell)];
        if (!optic) return true;
        outgoing = optic(cell, ray);
        return false;
      });
      const leaves = outgoing === null;
      // grid.ray reports the first cell outside the board when it runs off the edge; step back so `to` is on the board.
      const length = leaves ? end.steps - 1 : end.steps;
      segments.push({
        from: { x: ray.x, y: ray.y },
        to: { x: ray.x + stepX * length, y: ray.y + stepY * length },
        dir: ray.dir,
        color: ray.color,
        start: ray.distance,
        length,
        leaves,
      });
      (outgoing || []).forEach((out) => pending.push({ x: end.x, y: end.y, dir: out.dir, color: out.color, distance: ray.distance + end.steps }));
    }
    return { segments, lit: [...litByCell.values()], passes: [...passByCellAndColor.values()] };
  }

  Kit.beam = { trace, reflect, optics };

  // ---- search: fewest moves from a state to a goal -----------------------------------------------------------------------

  /** States explored before shortest() gives up, so a hint button can never freeze a phone. */
  const DEFAULT_SEARCH_LIMIT = 20000;

  /**
   * Breadth-first search for the shortest list of moves that reaches a goal. Works for any puzzle whose states can be
   * given a string key: sliding blocks, light routing, sokoban, lights-out.
   * @param {object} problem
   * @param {*} problem.start - the state to search from (treated as immutable)
   * @param {(state: *) => string} problem.keyOf - equal states must give equal keys
   * @param {(state: *) => {move: *, state: *}[]} problem.movesOf - every legal move from a state and the state it leads to
   * @param {(state: *) => boolean} problem.isGoal
   * @param {number} [problem.limit] - give up after exploring this many distinct states
   * @returns {{moves: *[], explored: number} | null} the moves in order (empty when `start` is already a goal),
   *   or null when no goal is reachable within the limit
   * @complexity O(states x moves per state) time, O(states) space, both capped by `limit`: breadth-first search visits
   *   every state closer than the goal. Keep `movesOf` tight (list only moves that can matter) before raising the limit.
   * @example
   *   Kit.search.shortest({ start: 1, keyOf: String, isGoal: (n) => n === 10,
   *     movesOf: (n) => [{ move: '+1', state: n + 1 }, { move: 'x2', state: n * 2 }] }).moves // ['+1', 'x2', '+1', 'x2']
   */
  function shortest({ start, keyOf, movesOf, isGoal, limit = DEFAULT_SEARCH_LIMIT }) {
    // Each visited state remembers the move that first reached it and the state it came from, so the path can be read back.
    const visited = [{ state: start, move: null, parent: -1 }];
    const seenKeys = new Set([keyOf(start)]);
    const movesTo = (index) => (visited[index].parent < 0 ? [] : movesTo(visited[index].parent).concat([visited[index].move]));
    // Index loop on purpose: `visited` doubles as the breadth-first queue and grows while it is walked.
    for (let index = 0; index < visited.length && index < limit; index++) {
      if (isGoal(visited[index].state)) return { moves: movesTo(index), explored: index + 1 };
      movesOf(visited[index].state).forEach(({ move, state }) => {
        const key = keyOf(state);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        visited.push({ state, move, parent: index });
      });
    }
    return null;
  }

  /**
   * How hard a solved puzzle is, as one number: the moves a perfect player needs plus the base-2 logarithm of the states
   * a blind search had to look at (how much there is to consider). A one-tap tutorial rates about 2, a bed with a
   * dozen interacting pieces about 15.
   * @param {{moves: *[], explored: number}} solution - a result of shortest()
   * @returns {number}
   * @example Kit.search.difficulty({ moves: ['a', 'b', 'c'], explored: 64 }) // 9
   */
  const difficulty = (solution) => solution.moves.length + Math.log2(solution.explored);

  /** Candidates generate() tries before settling for the hardest solvable one it has seen. */
  const DEFAULT_GENERATE_ATTEMPTS = 24;

  /**
   * Generate-and-verify: propose puzzles until one is proven solvable and good enough. Nothing unverified ever comes back.
   * @param {object} recipe
   * @param {(attempt: number) => *} recipe.propose - a candidate puzzle for this attempt (0, 1, 2, ...), or null to skip it
   * @param {(puzzle: *) => ({moves: *[], explored: number} | null)} recipe.solve - usually a call to shortest()
   * @param {(solution: object, puzzle: *) => boolean} [recipe.accept] - is this one good enough? Default: any puzzle that needs a move
   * @param {number} [recipe.attempts]
   * @returns {{puzzle: *, solution: object, attempt: number, isAccepted: boolean} | null} the first accepted candidate; failing
   *   that the hardest one that needs at least one move (by difficulty()) with isAccepted false; null when every
   *   candidate was unsolvable or already solved
   * @complexity O(attempts x cost of solve). With shortest() as the solver that is attempts x its state limit at worst.
   * @example
   *   Kit.search.generate({ propose: (attempt) => scramble(rng), solve: (board) => Kit.search.shortest(problemFor(board)),
   *     accept: (solution) => solution.moves.length >= 4 })
   */
  function generate({ propose, solve, accept = () => true, attempts = DEFAULT_GENERATE_ATTEMPTS }) {
    const harder = (best, candidate) => (!best || difficulty(candidate.solution) > difficulty(best.solution) ? candidate : best);
    let fallback = null;
    // Index loop on purpose: the search stops at the first accepted candidate, so later proposals are never built.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const puzzle = propose(attempt);
      const solution = puzzle === null ? null : solve(puzzle);
      if (!solution || solution.moves.length === 0) continue; // unsolvable, or not a puzzle at all
      if (accept(solution, puzzle)) return { puzzle, solution, attempt, isAccepted: true };
      fallback = harder(fallback, { puzzle, solution, attempt, isAccepted: false });
    }
    return fallback;
  }

  Kit.search = { shortest, difficulty, generate };

  // ---- levels: stars, unlock order and persistence -------------------------------------------------------------------------

  /**
   * A level as the progress model sees it; games add their own fields (rows, tips, ...).
   * @typedef {object} LevelRow
   * @property {string} id
   * @property {string} name - shown in the level-select sheet
   * @property {number} par - the score (moves, strokes, seconds: lower is better) that earns every star
   */

  /** Extra score allowed over par for each star above the first: [0, 2] = three stars at par, two within 2 of it. */
  const DEFAULT_STAR_SLACK = [0, 2];
  const STAR_FILLED = '★', STAR_EMPTY = '☆';

  /**
   * Stars earned by a lower-is-better score: one for finishing, plus one per slack threshold met.
   * @param {number} score - what the player took
   * @param {number} par - the target
   * @param {number[]} [slack] - allowed excess over par per extra star
   * @returns {number} 1 .. slack.length + 1
   * @example Kit.levels.rate(6, 5) // 2
   */
  const rate = (score, par, slack = DEFAULT_STAR_SLACK) => 1 + slack.filter((extra) => score <= par + extra).length;

  /**
   * Stars as text, e.g. two of three as one filled, one filled, one hollow star.
   * @param {number} earned
   * @param {number} [outOf]
   * @returns {string}
   */
  const starText = (earned, outOf = DEFAULT_STAR_SLACK.length + 1) => STAR_FILLED.repeat(earned) + STAR_EMPTY.repeat(Math.max(0, outOf - earned));

  /**
   * Progress through an ordered list of levels: best score and stars per level, each level unlocked by finishing the one before.
   * @param {LevelRow[]} rows - in play order
   * @param {object} [options]
   * @param {{get: Function, set: Function}} [options.save] - persistence such as ctx.save
   * @param {string} [options.key] - save key
   * @param {number[]} [options.slack] - star thresholds, see rate()
   * @returns {object} { table, maxStars, best(id), stars(id), medals(id), isUnlocked(id), complete(id, score, medals), totalStars(), firstOpen(), on(fn) }
   * @complexity every call is O(1) except totalStars and firstOpen, which are O(levels).
   */
  function levels(rows, { save, key = 'levels', slack = DEFAULT_STAR_SLACK } = {}) {
    const table = Kit.table(rows);
    const bestScores = { ...(save ? save.get(key, {}) : {}) }; // level id -> lowest score so far
    const medalKey = key + ':medals';
    const medalsByLevel = { ...(save ? save.get(medalKey, {}) : {}) }; // level id -> ids of optional goals ever met there
    const medals = (id) => (medalsByLevel[id] || []).slice();
    const bus = Kit.bus();
    const best = (id) => (bestScores[id] === undefined ? null : bestScores[id]);
    const stars = (id) => (best(id) === null ? 0 : rate(best(id), table.byId(id).par, slack));
    const isUnlocked = (id) => {
      const index = table.indexOf(table.byId(id));
      return index === 0 || best(table[index - 1].id) !== null;
    };
    return {
      table,
      maxStars: slack.length + 1,
      best,
      stars,
      /** @returns {string[]} ids of the medals (optional goals a game defines) ever earned on a level */
      medals,
      isUnlocked,
      /**
       * Record a finished level. Only a better score replaces the stored one; medals accumulate across attempts.
       * @param {string} id
       * @param {number} score
       * @param {string[]} [earnedMedals] - optional goals met on this attempt (the game decides what they are)
       * @returns {{stars: number, isBest: boolean, newMedals: string[]}} stars for this attempt, whether it beat (or set)
       *   the record, and the medals earned now for the first time
       */
      complete(id, score, earnedMedals = []) {
        const row = table.byId(id); // throws for an unknown id before anything is stored
        const isBest = best(id) === null || score < best(id);
        const newMedals = earnedMedals.filter((medal) => !medals(id).includes(medal));
        if (isBest) {
          bestScores[id] = score;
          if (save) save.set(key, bestScores);
        }
        if (newMedals.length) {
          medalsByLevel[id] = medals(id).concat(newMedals);
          if (save) save.set(medalKey, medalsByLevel);
        }
        if (isBest || newMedals.length) bus.emit('change', id);
        return { stars: rate(score, row.par, slack), isBest, newMedals };
      },
      totalStars: () => table.reduce((sum, row) => sum + stars(row.id), 0),
      /** @returns {string} id of the first level not yet finished, or the last level when all are */
      firstOpen: () => (table.find((row) => best(row.id) === null) || table[table.length - 1]).id,
      on: (fn) => bus.on('change', fn),
    };
  }

  /**
   * Level-select sheet for a Kit.levels model: one row per level with its stars and best score; locked levels are disabled.
   * @param {object} ui - a game's ctx.ui (uses ui.panel and ui.h only)
   * @param {object} progress - a Kit.levels model
   * @param {object} [options]
   * @param {string} [options.title]
   * @param {string} [options.current] - id of the level being played, marked in the list
   * @param {string} [options.unit] - what the score counts, for the "Par 4 moves" line
   * @param {(earned: number, outOf: number, row: LevelRow) => (Node | string)} [options.stars] - how to show a level's stars;
   *   default starText. Return an element to draw them in the game's own style (hearts, gems, buds).
   * @param {(row: LevelRow) => (string | undefined)} [options.heading] - chapter name of a row; a heading is drawn wherever it changes
   * @param {(body: HTMLElement, close: (value: *) => void) => void} [options.before] - add your own rows above the list
   *   (other modes, a daily challenge); call close(value) to resolve the sheet with any value
   * @returns {Promise<string | undefined>} the chosen level id, or undefined when the sheet was closed
   * @example Kit.levels.select(ctx.ui, progress, { title: 'Gardens', current: 'fork' }).then((id) => id && open(id));
   */
  function select(ui, progress, { title = 'Levels', current, unit = 'moves', stars = starText, heading = () => undefined, before } = {}) {
    const describe = (row) => {
      if (!progress.isUnlocked(row.id)) return 'Locked';
      const target = `Par ${row.par} ${unit}`;
      return progress.best(row.id) === null ? target : `Best ${progress.best(row.id)} · ${target}`;
    };
    return ui.panel({
      title,
      build(body, close) {
        if (before) before(body, close);
        progress.table.forEach((row, index) => {
          const isNewChapter = heading(row) !== undefined && (index === 0 || heading(row) !== heading(progress.table[index - 1]));
          if (isNewChapter) body.append(ui.h('h3', 'chapter', heading(row)));
          const button = ui.h('button', 'choice');
          button.type = 'button';
          button.disabled = !progress.isUnlocked(row.id);
          if (button.disabled) button.style.opacity = '0.45';
          const top = ui.h('div', 'choice-top');
          const badge = ui.h('em');
          badge.append(row.id === current ? 'Playing' : stars(progress.stars(row.id), progress.maxStars, row));
          top.append(ui.h('b', null, `${index + 1}. ${row.name}`), badge);
          button.append(top, ui.h('span', null, describe(row)));
          button.addEventListener('click', () => close(row.id));
          body.append(button);
        });
      },
    });
  }

  const MILLISECONDS_PER_DAY = 86400000;
  /**
   * Whole days since 1 January 1970 (UTC) for a timestamp: a seed that is the same for every player on the same day.
   * @param {number} timestampMs - e.g. Date.now()
   * @returns {number}
   * @example const dailyRng = Kit.rng(Kit.levels.dayNumber(Date.now()));
   */
  const dayNumber = (timestampMs) => Math.floor(timestampMs / MILLISECONDS_PER_DAY);

  Kit.levels = Object.assign(levels, { rate, starText, select, dayNumber });
})();
