// Marble Works rules: every table and every rule of the game, and the marble simulation, with no DOM and no THREE.
// It runs in node, which is how the challenge boards and songs are proven solvable (scratch/marble/prove.js) and how
// the unlock curve is measured (scratch/marble/curve.js). Exposed as the global MARBLE_RULES.
//
// Owns: parts, marble kinds, wiring, the simulation (a layout in, events out), objectives, scoring, experience,
//       challenge boards, the song book, goals and achievements.
// Does not own: drawing, sound, input or the HUD (games/marble.js reacts to the events), or anything generic
//       (Kit.physics + kit/bodies.js for bodies, Kit.grid for cells, Kit.music for pitch, Kit.curve for numbers).
//
// DEPTH PLAN
//   Seconds (mastery). A part's cell and pose decide where a marble goes: one cell off and the marble misses the
//     bucket, so a board can be solved clumsily or with one well-placed ramp. Par is the designer's peg count and
//     stars are paid for matching it. Gates stay open for a moment and spinners turn, so tapping the hopper on the
//     right beat gets a marble through where the steady drop does not.
//   Minutes (decisions). Rules that interact, none strictly better:
//     - Pegs: every part costs pegs and a board (or the free-build bench) has a budget. A booster does what three
//       ramps do for the price of three ramps, in one cell.
//     - Marble kinds: glass, steel (heavy: bumpers, boosters and splitters barely move it; scores double) and rubber
//       (bounces off everything). The hopper deals them in a pattern, so a contraption that suits one kind fails
//       another: kick parts sort steel from glass, funnels tame rubber.
//     - Wiring by placement: a bell or a counter within two cells of a gate, spinner or splitter is wired to it.
//       Ringing the bell opens the gate for a moment (or shuts one that rests open), reverses the spinner, flips the
//       splitter. A counter does the same on every third marble. Where a part sits is also what it controls, so
//       routing and logic compete for the same cells.
//     - Chains and songs pull against efficiency: touching many kinds of part scores more but costs pegs.
//   Hours (the long arc).
//     - The workshop: nine challenge boards on three benches (Basics, Motion, Logic). Each has fixed pieces, a tray,
//       a peg budget, a hopper pattern and an objective; each is replayable for stars against par.
//     - Boards teach a part or marble before the free bench has it; finishing boards unlocks them for free build
//       (ACHIEVEMENTS). Free-build goals unlock the rest. The player on run ten is building counter-and-gate
//       machines for steel marbles; on run one they had a ramp, a bell and a bumper.
//     - The song book: eight melodies of three to five notes for one marble to play, each harder to route.
//     - Account level (experience from goals, new stars and songs, never from idle landings) raises the free
//       bench's peg budget.
//     - Free build keeps three saved inventions.
(() => {
  // ---------------------------------------------------------------------------------------------------------------
  // Tables. World units are board cells (one cell = 1 unit); angles are degrees; times are seconds.
  // ---------------------------------------------------------------------------------------------------------------

  /** The pegboard: a grid of cells centred on the world origin, row 0 at the top. */
  const BOARD = { cols: 7, rows: 8, cell: 1 };
  const HALF_WIDTH = (BOARD.cols * BOARD.cell) / 2;
  const HALF_HEIGHT = (BOARD.rows * BOARD.cell) / 2;

  /** Physics feel. maxSpeed / 60 must stay below marbleRadius, or a marble could cross a thin part in one step. */
  const TUNING = {
    gravity: -22,
    friction: 0.25, // world default; marbles override it through MARBLE_KINDS
    restitution: 0.35,
    marbleRadius: 0.24,
    maxSpeed: 13,
    partDepth: 0.5, // thickness of every part out of the board, also the collider depth
    dropInterval: 1.5, // seconds between hopper drops: the contraption's tempo
    maxMarbles: 10, // live marbles; the hopper waits when the board is full
    maxAge: 14, // seconds before a marble that never lands (a spinner orbit, a bumper loop) is recycled
    stuckSpeed: 0.35, // units per second below which a marble counts as resting
    stuckTime: 1.4, // seconds of rest before it is recycled, so nothing piles up
    touchCooldown: 0.3, // seconds before the same marble can trigger the same part again (rolling contact chatters)
    gateHold: 2.2, // seconds a pulsed gate stays switched: longer than one drop interval, shorter than two
    wireReach: 2, // cells (in either axis) within which an emitter is wired to a receiver
  };

  /** Where marbles enter and leave. The bucket scores; anything that falls past it elsewhere is simply recycled. */
  const HOPPER = { x: -2, y: HALF_HEIGHT + 0.45 };
  const BUCKET = { x: 1.5, halfWidth: 1.05, rimY: -HALF_HEIGHT - 0.3, floorY: -HALF_HEIGHT - 0.95, rimRadius: 0.1 };
  const WALL = { thickness: 0.3, height: 2 * HALF_HEIGHT + 3 };

  /** Strengths of the parts that change a marble's velocity (units per second, for a marble of impulseScale 1). */
  const FORCES = {
    bumperKick: 8,
    boosterSpeed: 10,
    splitterPush: 3.2,
    splitterHop: 2.2,
    // Half a turn per hopper drop: a four-armed spinner then shows every marble on the beat the same face, so a
    // contraption with a spinner is repeatable, and a marble tapped in off the beat meets it differently.
    spinnerRate: Math.PI / TUNING.dropInterval,
  };

  /**
   * @typedef {Object} MarbleKind
   * @property {string} id
   * @property {string} name
   * @property {number} mass          affects nothing under gravity alone; it is what makes steel shrug off spinners less.
   * @property {number} friction
   * @property {number} restitution   bounce off parts (see Kit.physics.surfaces).
   * @property {number} impulseScale  how much of a bumper kick, booster or splitter push it takes.
   * @property {number} value         score multiplier for landing it.
   * @property {number} octave        bells ring this many octaves away from their written note (steel rings low).
   */
  /** @type {MarbleKind[]} */
  const MARBLE_KINDS = [
    { id: 'glass', name: 'Glass', mass: 1, friction: 0.25, restitution: 0.35, impulseScale: 1, value: 1, octave: 0 },
    { id: 'steel', name: 'Steel', mass: 3, friction: 0.2, restitution: 0.12, impulseScale: 0.3, value: 2, octave: -1 },
    { id: 'rubber', name: 'Rubber', mass: 0.8, friction: 0.5, restitution: 0.8, impulseScale: 1.1, value: 1, octave: 0 },
  ];
  const KIND_TABLE = Kit.table(MARBLE_KINDS);

  /**
   * @typedef {Object} PartShape  One collider and one mesh piece of a part, in the part's own frame.
   * @property {number[]} [box]   [width, height] of a plank.
   * @property {number} [disc]    radius of a round piece.
   * @property {number[]} [at]    [x, y] offset from the cell centre.
   * @property {number} [angle]   tilt in degrees.
   *
   * @typedef {Object} PartPose   One state a tap cycles through.
   * @property {number} angle         tilt of the whole part in degrees.
   * @property {number} [spin]        radians per second (turning parts).
   * @property {boolean} [restsOpen]  gates: open until pulsed, instead of shut until pulsed.
   * @property {number} [every]       counters: pulse on every n-th marble.
   *
   * @typedef {Object} PartRow    One kind of part. Adding a row adds a part.
   * @property {string} id        also the key into BEHAVIOURS, PULSE_RESPONSES and the view's decoration tables.
   * @property {string} name
   * @property {number} color     paint colour (bells ignore it and take their note's colour).
   * @property {number} cost      pegs it takes from the budget.
   * @property {number} max       how many may be on the board at once.
   * @property {boolean} [starter] in the free-build tray from the first run; the rest are unlocked.
   * @property {boolean} [isSensor] marbles pass through it; it only reports the contact.
   * @property {boolean} [emits]  touching it sends a pulse down its wires.
   * @property {PartShape[]} shapes
   * @property {PartPose[]} poses
   */
  /** @type {PartRow[]} */
  const PARTS = [
    { id: 'ramp', name: 'Ramp', color: 0x2a9d8f, cost: 1, max: 8, starter: true, shapes: [{ box: [1.5, 0.2] }], poses: [{ angle: -20 }, { angle: 20 }, { angle: -45 }, { angle: 45 }, { angle: 0 }] },
    { id: 'bell', name: 'Bell bar', color: 0xd4a017, cost: 1, max: 7, starter: true, emits: true, shapes: [{ box: [0.95, 0.16] }], poses: [{ angle: -12 }, { angle: 12 }] },
    { id: 'bumper', name: 'Bumper', color: 0xe76f51, cost: 2, max: 4, starter: true, shapes: [{ disc: 0.32 }], poses: [{ angle: 0 }] },
    { id: 'spinner', name: 'Spinner', color: 0x457b9d, cost: 3, max: 3, shapes: [{ box: [1.3, 0.14] }, { box: [0.14, 1.3] }], poses: [{ angle: 0, spin: FORCES.spinnerRate }, { angle: 0, spin: -FORCES.spinnerRate }] },
    { id: 'funnel', name: 'Funnel', color: 0x6a994e, cost: 2, max: 3, shapes: [{ box: [0.9, 0.16], at: [-0.64, 0.1], angle: -50 }, { box: [0.9, 0.16], at: [0.64, 0.1], angle: 50 }], poses: [{ angle: 0 }, { angle: 15 }, { angle: -15 }] },
    { id: 'booster', name: 'Booster', color: 0xf4a261, cost: 3, max: 3, isSensor: true, shapes: [{ disc: 0.34 }], poses: [{ angle: 90 }, { angle: 45 }, { angle: 135 }, { angle: 0 }, { angle: 180 }] },
    { id: 'portal', name: 'Portal', color: 0x7b5ea7, cost: 3, max: 2, isSensor: true, shapes: [{ disc: 0.34 }], poses: [{ angle: 0 }] },
    { id: 'splitter', name: 'Splitter', color: 0xe9c46a, cost: 2, max: 3, shapes: [{ disc: 0.26 }], poses: [{ angle: 0 }] },
    { id: 'gate', name: 'Gate', color: 0x8d6e63, cost: 2, max: 4, shapes: [{ box: [1.0, 0.18] }], poses: [{ angle: 0 }, { angle: 0, restsOpen: true }, { angle: 90 }, { angle: 90, restsOpen: true }] },
    { id: 'counter', name: 'Counter', color: 0x3d405b, cost: 2, max: 3, emits: true, shapes: [{ disc: 0.22 }], poses: [{ angle: 0, every: 3 }, { angle: 0, every: 2 }] },
  ];
  const PART_TABLE = Kit.table(PARTS);

  /**
   * @typedef {Object} Piece  One placed part: plain, JSON-friendly data. A layout is an array of these.
   * @property {number} id    unique within the layout.
   * @property {string} kind  a PARTS id.
   * @property {number} x     column.
   * @property {number} y     row (0 = top).
   * @property {number} pose  index into the part's poses.
   * @property {boolean} [fixed] part of a challenge board: it cannot be moved, turned or removed, and costs no pegs.
   */
  /** The contraption free build opens with: every marble rings two bells, takes a bumper kick and lands (scratch/marble/tune.js). */
  const STARTER_LAYOUT = [
    { id: 1, kind: 'ramp', x: 1, y: 1, pose: 0 },
    { id: 2, kind: 'bell', x: 3, y: 3, pose: 0 },
    { id: 3, kind: 'bell', x: 5, y: 5, pose: 1 },
    { id: 4, kind: 'bumper', x: 5, y: 6, pose: 0 },
  ];

  /** Bells are tuned by column, left to right, like a xylophone. One colour per column so a tune can be read by eye. */
  const BELL_SCALE = Kit.music.scale('C5', 'pentatonic');
  const BELL_COLORS = [0xe63946, 0xf4a261, 0xe9c46a, 0x8ac926, 0x2ec4b6, 0x4d96ff, 0xb388eb];

  /** Points for one landed marble by how many different kinds of part it touched on the way down. */
  const CHAIN_POINTS = Kit.curve.of({ steps: [[0, 1], [2, 3], [3, 6], [4, 10], [5, 15], [6, 25]] });

  /**
   * Free-build goals: the first minutes. Each unlocks the part named in `reward` for the free-build tray.
   * `when` receives { chain, bells } for 'land' and 'ring'.
   */
  const GOALS = [
    { id: 'place', text: 'Drag a part onto the board', event: 'place', reward: 'spinner' },
    { id: 'land', text: 'Fill the bucket', event: 'land', target: 8, reward: 'funnel' },
    { id: 'bells', text: 'Ring 3 bells with one marble', event: 'ring', when: (payload) => payload.bells >= 3, reward: 'booster' },
    { id: 'chain', text: 'One marble, 4 kinds of part', event: 'land', when: (payload) => payload.chain >= 4, reward: 'portal' },
    { id: 'portal', text: 'Link two portals', event: 'portal', reward: 'splitter' },
  ];

  /**
   * The song book: ring these bell columns in this order with one marble (free build). Later songs are longer, so
   * the marble has to be steered back and forth. Every song has a recorded solution replayed by scratch/marble/prove.js.
   * @type {{ id: string, name: string, degrees: number[], bonus: number }[]}
   */
  const SONGS = [
    { id: 'echo', name: 'Echo', degrees: [3, 5, 4], bonus: 20 },
    { id: 'stairs', name: 'Stairs', degrees: [2, 4, 6], bonus: 30 },
    { id: 'skip', name: 'Skipping stone', degrees: [1, 3, 5], bonus: 40 },
    { id: 'return', name: 'There and back', degrees: [1, 3, 2], bonus: 50 },
    { id: 'lullaby', name: 'Workshop lullaby', degrees: [1, 2, 4, 5], bonus: 80 },
    { id: 'reel', name: 'Tinker reel', degrees: [1, 2, 4, 3], bonus: 100 },
    { id: 'cascade', name: 'Cascade', degrees: [1, 3, 2, 0, 0], bonus: 150 },
    { id: 'march', name: 'Marble march', degrees: [1, 2, 5, 5, 6], bonus: 200 },
  ];

  /**
   * @typedef {Object} OutcomeNeeds  What a marble must do to count toward a board's objective.
   * @property {string[]} [land]   marble kinds that must land in the bucket; every other kind must NOT land.
   * @property {number} [landEvery] only every n-th marble dropped (the 3rd, 6th, ... for 3) must land; the rest must NOT.
   *                               With neither `land` nor `landEvery`, every marble must land.
   * @property {number} [chain]    least number of different part kinds a landing marble must have touched.
   * @property {number} [bells]    least number of different bells a landing marble must have rung.
   * @property {string[]} [touch]  part kinds a landing marble must have touched.
   *
   * @typedef {Object} BoardRow    One challenge board (also a Kit.levels row: `par` is the peg count that earns every star).
   * @property {string} id
   * @property {string} name
   * @property {string} bench      which workbench it belongs to (BENCHES).
   * @property {string} brief      the objective in the player's words.
   * @property {string[]} pattern  marble kinds the hopper deals, in order, repeating.
   * @property {Piece[]} fixed     pieces that are part of the board.
   * @property {string[]} tray     part ids the player may place.
   * @property {number} budget     pegs available.
   * @property {number} par        pegs used by the recorded solution.
   * @property {number} streak     consecutive marbles that must satisfy `needs`.
   * @property {OutcomeNeeds} needs
   */
  const BENCHES = [
    { id: 'basics', name: 'Basics' },
    { id: 'motion', name: 'Motion' },
    { id: 'logic', name: 'Logic' },
  ];
  const fixedPiece = (id, kind, x, y, pose = 0) => ({ id, kind, x, y, pose, fixed: true });
  /** @type {BoardRow[]} */
  const BOARDS = [
    { id: 'drop', name: 'First drop', bench: 'basics', brief: 'Land 3 marbles in a row', pattern: ['glass'], fixed: [], tray: ['ramp', 'bell'], budget: 3, par: 1, streak: 3, needs: {} },
    { id: 'chimes', name: 'Two chimes', bench: 'basics', brief: 'Land 3 in a row, each ringing 2 bells', pattern: ['glass'], fixed: [], tray: ['ramp', 'bell', 'bumper'], budget: 4, par: 2, streak: 3, needs: { bells: 2 } },
    { id: 'detour', name: 'The long way', bench: 'basics', brief: 'Land 3 in a row past the shelf, each touching 3 kinds of part', pattern: ['glass'], fixed: [fixedPiece(1, 'ramp', 4, 5, 4), fixedPiece(2, 'ramp', 5, 5, 4)], tray: ['ramp', 'bell', 'bumper'], budget: 6, par: 4, streak: 3, needs: { chain: 3 } },
    { id: 'freight', name: 'Mixed freight', bench: 'motion', brief: 'Glass and steel take turns. Land 4 in a row, each off a bumper', pattern: ['glass', 'steel'], fixed: [], tray: ['ramp', 'bell', 'bumper', 'funnel'], budget: 8, par: 7, streak: 4, needs: { touch: ['bumper'] } },
    { id: 'whirl', name: 'Whirligig', bench: 'motion', brief: 'Land 3 in a row, each through the spinner', pattern: ['glass'], fixed: [fixedPiece(1, 'spinner', 3, 3, 0)], tray: ['ramp', 'bell', 'funnel', 'booster'], budget: 6, par: 3, streak: 3, needs: { touch: ['spinner'] } },
    { id: 'sorter', name: 'Sorting office', bench: 'motion', brief: 'Steel in the bucket, glass anywhere else: 6 in a row', pattern: ['glass', 'steel'], fixed: [], tray: ['ramp', 'bumper', 'funnel', 'booster'], budget: 6, par: 3, streak: 6, needs: { land: ['steel'] } },
    { id: 'doorbell', name: 'Doorbell', bench: 'logic', brief: 'A shelf covers the bucket and its gate is shut. Land 3 in a row', pattern: ['glass'], fixed: [fixedPiece(1, 'ramp', 3, 7, 4), fixedPiece(2, 'gate', 4, 7, 0), fixedPiece(3, 'gate', 5, 7, 0), fixedPiece(4, 'ramp', 6, 7, 4)], tray: ['ramp', 'bell', 'bumper', 'funnel'], budget: 5, par: 2, streak: 3, needs: {} },
    { id: 'third', name: 'Every third', bench: 'logic', brief: 'Only every third marble may land: 6 in a row', pattern: ['glass'], fixed: [], tray: ['ramp', 'bumper', 'funnel', 'gate', 'counter'], budget: 8, par: 7, streak: 6, needs: { landEvery: 3 } },
    { id: 'bounce', name: 'Rubber room', bench: 'logic', brief: 'Rubber and steel take turns. Land 4 in a row, each touching 3 kinds of part', pattern: ['rubber', 'steel'], fixed: [], tray: ['ramp', 'funnel', 'gate', 'counter', 'splitter'], budget: 9, par: 8, streak: 4, needs: { chain: 3 } },
  ];

  /**
   * Long-arc unlocks (Kit.profile achievements). `unlocks` is a PARTS id or a MARBLE_KINDS id made available in free
   * build, or 'slot2' / 'slot3' for more saved inventions.
   */
  const ACHIEVEMENTS = [
    { id: 'apprentice', text: 'Solve 2 boards', stat: 'boards', target: 2, unlocks: 'slot2' },
    { id: 'journeyman', text: 'Solve 4 boards', stat: 'boards', target: 4, unlocks: 'steel' },
    { id: 'gatekeeper', text: 'Solve 7 boards', stat: 'boards', target: 7, unlocks: 'gate' },
    { id: 'clockmaker', text: 'Solve 8 boards', stat: 'boards', target: 8, unlocks: 'counter' },
    { id: 'master', text: 'Solve all 9 boards', stat: 'boards', target: 9, unlocks: 'rubber' },
    { id: 'starred', text: 'Earn 18 stars', stat: 'stars', target: 18, unlocks: 'slot3' },
    { id: 'songsmith', text: 'Play 4 songs', stat: 'songs', target: 4 },
    { id: 'bucketful', text: 'Land 200 marbles', stat: 'landed', target: 200 },
  ];

  /**
   * Account level: experience needed per level, the experience each deed pays, and what a level is worth.
   * Experience comes only from deeds (a new star, a goal, a song), never from marbles simply landing, so leaving a
   * contraption running earns nothing: the level measures what the player has figured out.
   */
  const PROGRESS = {
    levelCurve: { base: 60, growth: 1.35 },
    experiencePerStar: 40,
    experiencePerGoal: 30,
    songReplayShare: 0.1, // a song already in the book pays this fraction of its bonus when played again
    freeBudget: Kit.curve.of({ base: 10, step: 2 }), // pegs on the free bench by levels gained
    inventionSlots: ['slot1', 'slot2', 'slot3'],
  };

  /**
   * What the free-build hopper can deal. A mix is offered once every kind in it is unlocked; glass always is.
   * @type {{ id: string, name: string, pattern: string[] }[]}
   */
  const HOPPER_MIXES = [
    { id: 'glass', name: 'Glass', pattern: ['glass'] },
    { id: 'freight', name: 'Glass and steel', pattern: ['glass', 'steel'] },
    { id: 'steel', name: 'Steel', pattern: ['steel'] },
    { id: 'trio', name: 'Glass, rubber, steel', pattern: ['glass', 'rubber', 'steel'] },
    { id: 'rubber', name: 'Rubber', pattern: ['rubber'] },
  ];

  const DEGREES = Math.PI / 180;

  // ---------------------------------------------------------------------------------------------------------------
  // Pure rules: layouts, wiring, objectives, scoring.
  // ---------------------------------------------------------------------------------------------------------------

  const grid = Kit.grid(BOARD.cols, BOARD.rows, { cell: BOARD.cell });
  /**
   * Centre of a cell on the board plane. Kit.grid maps rows to +z; on an upright board rows run down, so y = -z.
   * @param {{ x: number, y: number }} cell
   * @returns {{ x: number, y: number }} world position.
   */
  const cellCentre = (cell) => {
    const flat = grid.toWorld(cell.x, cell.y);
    return { x: flat.x, y: -flat.z };
  };
  /** @param {{ x: number, y: number }} point board-plane position. @returns {{ x: number, y: number }|null} the cell under it. */
  const cellAtPoint = (point) => grid.fromWorld(point.x, -point.y);

  const pieceAt = (layout, cell) => layout.find((piece) => piece.x === cell.x && piece.y === cell.y) || null;
  const countOfKind = (layout, kind) => layout.filter((piece) => piece.kind === kind && !piece.fixed).length;
  const nextPieceId = (layout) => layout.reduce((highest, piece) => Math.max(highest, piece.id), 0) + 1;
  const poseOf = (piece) => PART_TABLE.byId(piece.kind).poses[piece.pose];
  /** Pegs a layout has taken from the budget. Fixed pieces belong to the board and are free. */
  const pegsSpent = (layout) => layout.filter((piece) => !piece.fixed).reduce((total, piece) => total + PART_TABLE.byId(piece.kind).cost, 0);

  /**
   * Layout edits. Each returns a new layout and leaves its input untouched, so Kit.history snapshots stay valid.
   * @type {Object<string, (layout: Piece[], ...args: any[]) => Piece[]>}
   */
  const EDITS = {
    place: (layout, kind, cell) => layout.concat({ id: nextPieceId(layout), kind, x: cell.x, y: cell.y, pose: 0 }),
    move: (layout, id, cell) => layout.map((piece) => (piece.id === id ? { ...piece, x: cell.x, y: cell.y } : piece)),
    remove: (layout, id) => layout.filter((piece) => piece.id !== id),
    turn: (layout, id) => layout.map((piece) => (piece.id === id ? { ...piece, pose: (piece.pose + 1) % PART_TABLE.byId(piece.kind).poses.length } : piece)),
  };

  /**
   * Drop anything a saved layout should not contain (a part kind that no longer exists, a cell off the board).
   * @param {*} saved whatever ctx.save returned.
   * @returns {Piece[]|null} a usable layout, or null when nothing was saved.
   */
  const sanitizeLayout = (saved) =>
    Array.isArray(saved) ? saved.filter((piece) => piece && PART_TABLE.has(piece.kind) && grid.inside(piece.x, piece.y) && poseOf(piece)) : null;

  /** @returns {boolean} true when `sequence` ends with every element of `tail`, in order. */
  const endsWith = (sequence, tail) => tail.length <= sequence.length && tail.every((value, index) => sequence[sequence.length - tail.length + index] === value);

  /**
   * Which emitters are wired to which receivers: any emitter (bell, counter) within TUNING.wireReach cells of a part
   * that answers pulses (PULSE_RESPONSES). Placement is the wiring; there is nothing else to connect.
   * @param {Piece[]} layout
   * @returns {{ from: number, to: number }[]} piece ids.
   * @complexity O(emitters x receivers) time, at most 10 x 10 on a full board; O(wires) space.
   */
  const wiresOf = (layout) => {
    const emitters = layout.filter((piece) => PART_TABLE.byId(piece.kind).emits);
    const receivers = layout.filter((piece) => PULSE_RESPONSES[piece.kind]);
    const isInReach = (emitter, receiver) => Math.max(Math.abs(emitter.x - receiver.x), Math.abs(emitter.y - receiver.y)) <= TUNING.wireReach;
    return emitters.flatMap((emitter) => receivers.filter((receiver) => isInReach(emitter, receiver)).map((receiver) => ({ from: emitter.id, to: receiver.id })));
  };

  /**
   * @typedef {Object} Outcome  What became of one marble, as plain data.
   * @property {'landed'|'fell'|'stuck'|'old'} fate
   * @property {string} kind     MARBLE_KINDS id.
   * @property {number} ordinal  its place in the drop order, from 1.
   * @property {string[]} kinds  part kinds it touched.
   * @property {number[]} notes  bell columns it rang, in order.
   */
  const distinctCount = (values) => new Set(values).size;
  /**
   * Does one marble's outcome count toward an objective?
   * @param {OutcomeNeeds} needs
   * @param {Outcome} outcome
   * @returns {boolean}
   */
  const satisfiesNeeds = (needs, outcome) => {
    const hasLanded = outcome.fate === 'landed';
    const isItsTurn = !needs.landEvery || outcome.ordinal % needs.landEvery === 0;
    const shouldLand = isItsTurn && (!needs.land || needs.land.includes(outcome.kind));
    if (!shouldLand) return !hasLanded;
    return hasLanded && outcome.kinds.length >= (needs.chain || 0) && distinctCount(outcome.notes) >= (needs.bells || 0) && (needs.touch || []).every((kind) => outcome.kinds.includes(kind));
  };
  /**
   * Advance a board's streak by one finished marble: any marble that breaks the rule starts the count again.
   * @param {BoardRow} board
   * @param {number} streak count so far.
   * @param {Outcome} outcome
   * @returns {number} the new streak; the board is solved when it reaches board.streak.
   */
  const advanceStreak = (board, streak, outcome) => (satisfiesNeeds(board.needs, outcome) ? streak + 1 : 0);

  /**
   * Experience for playing a song: the whole bonus the first time, a small share for a replay.
   * @param {{ bonus: number }} song
   * @param {boolean} isFirstTime
   * @returns {number}
   */
  const songExperience = (song, isFirstTime) => Math.round(song.bonus * (isFirstTime ? 1 : PROGRESS.songReplayShare));

  /** Points for a landed marble: its chain, times what its kind is worth. */
  const pointsFor = (outcome) => CHAIN_POINTS(outcome.kinds.length) * KIND_TABLE.byId(outcome.kind).value;

  /**
   * Decide a marble's fate from plain numbers.
   * @param {{ x: number, y: number, age: number, restTime: number }} marble
   * @returns {'landed'|'fell'|'stuck'|'old'|null} null while it is still in play.
   */
  const judgeMarble = ({ x, y, age, restTime }) => {
    if (y < BUCKET.floorY) return Math.abs(x - BUCKET.x) < BUCKET.halfWidth ? 'landed' : 'fell';
    if (restTime > TUNING.stuckTime) return 'stuck';
    return age > TUNING.maxAge ? 'old' : null;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Simulation: a layout and a hopper pattern in, marbles and events out.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Marble
   * @property {number} id
   * @property {MarbleKind} kind
   * @property {CANNON.Body} body
   * @property {number} born        simulation time of the drop.
   * @property {number} restTime    seconds spent below TUNING.stuckSpeed.
   * @property {Set<string>} kinds  part kinds touched so far (the chain).
   * @property {number[]} notes     bell columns rung, in order.
   * @property {Object<number, number>} lastTouch  piece id -> simulation time of the last counted touch.
   *
   * @typedef {Object} LivePart
   * @property {Piece} piece
   * @property {PartRow} row
   * @property {CANNON.Body} body
   * @property {number} side          splitters: the side (+1 right, -1 left) the next marble is sent to.
   * @property {number} count         counters: marbles seen so far.
   * @property {number} lastCounted   counters: id of the marble counted most recently.
   * @property {number} pulsedUntil   gates: simulation time until which the last pulse holds it switched.
   * @property {boolean} isOpen       gates: whether marbles pass right now.
   * @property {LivePart[]} targets   emitters: the parts its pulse reaches.
   *
   * @typedef {Object} SimEvent
   * @property {'drop'|'touch'|'pulse'|'gate'|'landed'|'fell'|'stuck'|'old'} type
   * @property {Marble} [marble]    every type but pulse and gate.
   * @property {LivePart} [part]    the part touched, pulsing or switching.
   * @property {LivePart} [exit]    touch on a portal: the portal the marble came out of.
   * @property {Outcome} [outcome]  landed, fell, stuck, old: the marble's record.
   */

  /**
   * What a part does to a marble on contact, keyed by part id. Each mutates only the marble / part it is given and
   * returns extra fields for the touch event (a portal reports its `exit`), `false` to ignore the contact entirely, or nothing.
   * Velocity changes are scaled by the marble kind's impulseScale: that is the whole difference between kicking glass and steel.
   * @type {Object<string, (marble: Marble, part: LivePart, parts: LivePart[]) => (Partial<SimEvent>|false|void)>}
   */
  const BEHAVIOURS = {
    bell: (marble, part) => {
      marble.notes.push(part.piece.x);
    },
    // Kick straight away from the bumper's centre, whatever the incoming speed: predictable, so it can be aimed.
    bumper: (marble, part) => {
      const away = marble.body.position.vsub(part.body.position);
      away.normalize();
      const kick = FORCES.bumperKick * marble.kind.impulseScale;
      marble.body.velocity.set(away.x * kick, away.y * kick, 0);
    },
    booster: (marble, part) => {
      const heading = poseOf(part.piece).angle * DEGREES;
      const speed = FORCES.boosterSpeed * marble.kind.impulseScale;
      marble.body.velocity.set(Math.cos(heading) * speed, Math.sin(heading) * speed, 0);
    },
    // A lone portal is inert. With two, the marble keeps its velocity and the exit is put on cooldown so it does not bounce back in.
    portal: (marble, part, parts) => {
      const exit = parts.find((other) => other.row.id === 'portal' && other !== part);
      if (!exit) return false;
      marble.body.position.set(exit.body.position.x, exit.body.position.y, marble.body.position.z);
      marble.lastTouch[exit.piece.id] = marble.lastTouch[part.piece.id];
      return { exit };
    },
    // Alternate sides, with a small hop so the marble clears the peg instead of rolling round it.
    splitter: (marble, part) => {
      const scale = marble.kind.impulseScale;
      marble.body.velocity.set(part.side * FORCES.splitterPush * scale, Math.max(marble.body.velocity.y, FORCES.splitterHop * scale), 0);
      part.side = -part.side;
    },
    // A marble is counted once, however often it bounces on the peg: the count is of marbles, not of knocks.
    counter: (marble, part) => {
      const isNewMarble = part.lastCounted !== marble.id;
      part.lastCounted = marble.id;
      if (isNewMarble) part.count += 1;
      return { isCounted: isNewMarble };
    },
  };

  /** Does this touch send a pulse? Bells always; counters when the marble just counted was the n-th. */
  const EMITS_NOW = {
    bell: () => true,
    counter: (part, touch) => touch.isCounted && part.count % poseOf(part.piece).every === 0,
  };

  /**
   * What a wired part does when a pulse reaches it, keyed by part id. `time` is the simulation clock.
   * @type {Object<string, (part: LivePart, time: number) => void>}
   */
  const PULSE_RESPONSES = {
    gate: (part, time) => (part.pulsedUntil = time + TUNING.gateHold),
    spinner: (part) => (part.body.angularVelocity.z = -part.body.angularVelocity.z),
    splitter: (part) => (part.side = -part.side),
  };
  /** A gate rests shut (or open, by pose) and is the other way round while a pulse holds it. */
  const isGateOpen = (part, time) => !!poseOf(part.piece).restsOpen !== time < part.pulsedUntil;

  /** A PARTS row's 2D shapes as Kit.physics.compound colliders (depth added, degrees to radians). */
  const toColliders = (row) =>
    row.shapes.map((shape) => ({
      box: shape.box && [shape.box[0], shape.box[1], TUNING.partDepth],
      disc: shape.disc,
      at: shape.at && [shape.at[0], shape.at[1], 0],
      angle: (shape.angle || 0) * DEGREES,
    }));

  /**
   * Build the marble world for a layout.
   * @param {Piece[]} initialLayout
   * @param {Object} [options]
   * @param {string[]} [options.pattern=['glass']] marble kinds the hopper deals, in order, repeating.
   * @returns {{ setLayout: (layout: Piece[]) => void, setPattern: (pattern: string[]) => void, step: (dt: number) => SimEvent[],
   *            dropMarble: () => Marble|null, clearMarbles: () => Marble[], marbles: () => Marble[], parts: () => LivePart[] }}
   * @example
   * const simulation = MARBLE_RULES.createSimulation(MARBLE_RULES.STARTER_LAYOUT, { pattern: ['glass', 'steel'] });
   * simulation.step(1 / 60).forEach((event) => console.log(event.type));
   * @complexity step: O(marbles + parts + contacts) on top of cannon's own step; setLayout: O(parts + wires).
   */
  const createSimulation = (initialLayout, { pattern = ['glass'] } = {}) => {
    const phys = Kit.physics({ gravity: TUNING.gravity, friction: TUNING.friction, restitution: TUNING.restitution });
    // Marbles ignore each other: every marble of a kind then takes the same route, so a contraption plays the same tune each time.
    const layers = Kit.physics.layers(['marble', 'part']);
    const surfaces = Kit.physics.surfaces(phys, Object.fromEntries(MARBLE_KINDS.map((kind) => [kind.id, { friction: kind.friction, restitution: kind.restitution }])));
    const marbleRules = Kit.physics.stepRules(phys, [Kit.physics.keepInPlane('z'), Kit.physics.limitSpeed(TUNING.maxSpeed)]);
    const partsById = new Map();
    const marbleByBody = new Map();
    const pendingTouches = [];
    const pendingEvents = []; // everything that happened since the last step() call, in order
    let hopperPattern = pattern;
    // The clock counts whole physics steps, so the hopper's beat and the spinners' turning never drift apart.
    let stepCount = 0;
    let time = 0;
    let lastDropStep = -Infinity; // the first marble drops on the first step, so the board is never silent on arrival
    let dropCount = 0;

    const asPart = (body) => surfaces.scenery(layers.assign(body, 'part', ['marble']));
    const wallBox = { box: [WALL.thickness, WALL.height, TUNING.partDepth] };
    [-1, 1].forEach((side) => {
      asPart(Kit.physics.compound(phys, null, [wallBox], { at: [side * (HALF_WIDTH + WALL.thickness / 2), 0, 0] }));
      asPart(Kit.physics.compound(phys, null, [{ disc: BUCKET.rimRadius }], { at: [BUCKET.x + side * BUCKET.halfWidth, BUCKET.rimY, 0] }));
    });

    /** Open gates stop colliding; shut ones collide with marbles. Reports a change so the view can swing the bar. */
    const refreshGate = (part) => {
      const isOpen = isGateOpen(part, time);
      if (isOpen === part.isOpen) return [];
      part.isOpen = isOpen;
      part.body.collisionFilterMask = isOpen ? 0 : layers.mask(['marble']);
      return [{ type: 'gate', part }];
    };

    const addPart = (piece) => {
      const row = PART_TABLE.byId(piece.kind);
      const pose = row.poses[piece.pose];
      const centre = cellCentre(piece);
      // A turning part starts where it would be had it turned since the clock began, so when it was placed does not matter.
      const body = asPart(Kit.physics.compound(phys, null, toColliders(row), { at: [centre.x, centre.y, 0], angle: pose.angle * DEGREES + (pose.spin || 0) * time, spin: pose.spin || 0 }));
      if (row.isSensor) Kit.physics.sensor(body);
      const part = { piece, row, body, side: 1, count: 0, lastCounted: 0, pulsedUntil: -Infinity, isOpen: false, targets: [] };
      // Contacts are only queued here: changing velocities or teleporting mid-step would fight the solver.
      phys.onHit(body, (impactSpeed, otherBody) => pendingTouches.push({ part, otherBody }));
      partsById.set(piece.id, part);
    };
    const removePart = (part) => {
      partsById.delete(part.piece.id);
      Kit.physics.retire(phys, part.body);
    };
    /** Rebuild only the parts whose piece data changed, so untouched parts keep their state (a counter's count, a spinner's phase), then rewire. */
    const setLayout = (layout) => {
      const wanted = new Map(layout.map((piece) => [piece.id, JSON.stringify(piece)]));
      [...partsById.values()].filter((part) => wanted.get(part.piece.id) !== JSON.stringify(part.piece)).forEach(removePart);
      layout.filter((piece) => !partsById.has(piece.id)).forEach(addPart);
      partsById.forEach((part) => (part.targets = []));
      wiresOf(layout).forEach((wire) => partsById.get(wire.from).targets.push(partsById.get(wire.to)));
      pendingEvents.push(...[...partsById.values()].filter((part) => part.row.id === 'gate').flatMap(refreshGate));
    };

    const dropMarble = () => {
      if (marbleByBody.size >= TUNING.maxMarbles) return null;
      const kind = KIND_TABLE.byId(hopperPattern[dropCount++ % hopperPattern.length]);
      const body = phys.sphere(null, TUNING.marbleRadius, { at: [HOPPER.x, HOPPER.y, 0], mass: kind.mass });
      body.allowSleep = false; // a sleeping marble would hang in the air when the part under it is dragged away
      surfaces.assign(layers.assign(body, 'marble', ['part']), kind.id);
      marbleRules.add(body);
      const marble = { id: dropCount, kind, body, born: time, restTime: 0, kinds: new Set(), notes: [], lastTouch: {} };
      marbleByBody.set(body, marble);
      pendingEvents.push({ type: 'drop', marble });
      return marble;
    };
    const retireMarble = (marble) => {
      marbleByBody.delete(marble.body);
      Kit.physics.retire(phys, marble.body);
      return marble;
    };

    const sendPulse = (part) => {
      part.targets.forEach((target) => PULSE_RESPONSES[target.row.id](target, time));
      return [{ type: 'pulse', part }];
    };
    const resolveTouch = ({ part, otherBody }) => {
      const marble = marbleByBody.get(otherBody);
      const isLive = partsById.get(part.piece.id) === part;
      if (!marble || !isLive || time - (marble.lastTouch[part.piece.id] || -Infinity) < TUNING.touchCooldown) return [];
      marble.lastTouch[part.piece.id] = time;
      const behave = BEHAVIOURS[part.row.id];
      const outcome = behave ? behave(marble, part, [...partsById.values()]) : undefined;
      if (outcome === false) return [];
      marble.kinds.add(part.row.id);
      const emitsNow = part.row.emits && EMITS_NOW[part.row.id](part, outcome || {});
      return [{ type: 'touch', marble, part, ...outcome }, ...(emitsNow ? sendPulse(part) : [])];
    };

    const settleMarble = (marble, dt) => {
      marble.restTime = marble.body.velocity.norm() < TUNING.stuckSpeed ? marble.restTime + dt : 0;
      const fate = judgeMarble({ x: marble.body.position.x, y: marble.body.position.y, age: time - marble.born, restTime: marble.restTime });
      if (!fate) return [];
      retireMarble(marble);
      return [{ type: fate, marble, outcome: { fate, kind: marble.kind.id, ordinal: marble.id, kinds: [...marble.kinds], notes: marble.notes.slice() } }];
    };

    // Everything that reacts to contacts runs once per physics step, not once per frame: a frame may hold several
    // steps on a slow phone, and a bumper kick applied two steps late sends the marble somewhere else. Doing it here
    // makes a contraption behave the same at 20 fps as at 60 (scratch/marble/prove.js checks exactly that).
    phys.world.addEventListener('postStep', () => {
      stepCount += 1;
      time = stepCount * phys.world.dt;
      // When the board is full the beat is missed and the next marble drops the moment there is room.
      const isDropDue = stepCount - lastDropStep >= Math.round(TUNING.dropInterval / phys.world.dt);
      if (isDropDue && dropMarble()) lastDropStep = stepCount;
      pendingEvents.push(...pendingTouches.splice(0).flatMap(resolveTouch), ...[...partsById.values()].filter((part) => part.row.id === 'gate').flatMap(refreshGate));
    });

    const step = (dt) => {
      phys.step(dt);
      // Fates are judged per frame: a marble below the bucket floor touches nothing, so a frame's delay changes no outcome.
      return [...pendingEvents.splice(0), ...[...marbleByBody.values()].flatMap((marble) => settleMarble(marble, dt))];
    };

    setLayout(initialLayout);
    return {
      setLayout,
      /** Change what the hopper deals and start the pattern again from its first marble. */
      setPattern(nextPattern) {
        hopperPattern = nextPattern;
        dropCount = 0;
      },
      step,
      dropMarble,
      /** Take every marble off the board (changing board or mode). @returns {Marble[]} the marbles removed. */
      clearMarbles: () => [...marbleByBody.values()].map(retireMarble),
      marbles: () => [...marbleByBody.values()],
      parts: () => [...partsById.values()],
    };
  };

  window.MARBLE_RULES = {
    BOARD, HALF_WIDTH, HALF_HEIGHT, TUNING, HOPPER, BUCKET, WALL, FORCES, MARBLE_KINDS, KIND_TABLE, PARTS, PART_TABLE, STARTER_LAYOUT,
    BELL_SCALE, BELL_COLORS, CHAIN_POINTS, GOALS, SONGS, BENCHES, BOARDS, ACHIEVEMENTS, PROGRESS, HOPPER_MIXES, DEGREES,
    grid, cellCentre, cellAtPoint, pieceAt, countOfKind, poseOf, pegsSpent, EDITS, sanitizeLayout, endsWith, wiresOf,
    satisfiesNeeds, advanceStreak, pointsFor, songExperience, judgeMarble, isGateOpen, PULSE_RESPONSES, createSimulation,
  };
})();
