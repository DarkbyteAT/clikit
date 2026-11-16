/**
 * Neon Run: a three-lane endless runner about how much heat you dare to carry.
 *
 * Owns:  the tuning tables, the run simulation (plain data, no THREE, no DOM: `createRun` / `advanceRun` and the pure
 *        helpers they compose), the career that outlives a run (`createCareer`), the scene and runner model that draw a
 *        run, the synthwave racing-dashboard HUD theme, and the run -> crashed -> garage phase flow.
 * Does not own: anything generic. Lane reachability is Kit.lanes, game-time toasts and floaters are Kit.scrub, instancing
 *        and canvas textures are ctx.make, costs / wallet / perks / spawn order are the Kit models, lifetime goals and
 *        set bonuses are Kit.profile and Kit.synergy, their screens are Kit.views.
 *
 * World convention: the runner never moves forward. It stays at z = 0 and the world streams toward the camera, so every
 * world object carries an absolute `distance` (metres from the start line) and is drawn at z = run.distance - distance
 * (negative z is ahead of the runner, positive z is behind it).
 *
 * DEPTH PLAN (what is real at each timescale, and the rules that make it so)
 *   Seconds - mastery. Every obstacle can be passed safely or passed well. Leaving the dodge until the near-miss window
 *     is a close call; clearing a barrier with a jump launched out of a slide, or passing a beam in a slide that began
 *     as a mid-air dive, are technique tricks (TRICKS). Tricks raise HEAT, and heat is the coin multiplier, so a
 *     skilled run is visibly worth several times a careful one. Tricks only score against an obstacle or a coin trail.
 *   Minutes - decisions. Coins go into a pot at the current multiplier. A gold bank pad sits in one lane under each
 *     distance gate: run over it and the pot is safe but the heat resets to zero; pass it in another lane and the
 *     multiplier lives on with the pot at risk (a crash keeps half). In the garage the build is a second decision:
 *     perks and the runner type carry tags, tags complete SYNERGIES, and every runner type pays for its ability
 *     (RUNNERS), so there is no best build, only one that suits how you take the pads.
 *   Hours - the long arc. ACHIEVEMENTS (Kit.profile) unlock two perks and three runner types that change how a run is
 *     played (a second jump in the air, a free shield, wider close calls). The road has ZONES whose rules raise the
 *     stakes of the heat game rather than only the speed, and perk prices climb 10 to 20 times per level because the
 *     multiplier makes income climb with skill.
 *   Measured, not asserted: scratch/runner/pacing.js plays the pure rules for three hours per bot policy. First perk
 *     after about one minute for every policy; everything bought and every goal done after about 35 minutes for the
 *     expert bot and 95 for the regular one; the novice bot buys its last perk at about 165 minutes with four goals
 *     still open; the beginner bot is still buying at three hours. So a strong player runs out of new things in
 *     under an hour: the arc needs more rows (zones, runner types, goals) before it carries several hours for them.
 *   Not built: branching routes, perk slots that force leaving a perk at home, and a visual identity per runner type.
 */
(() => {
  const { damp, clamp, lerp, rand, pick } = Kit.math;

  // =====================================================================================================================
  // DATA TABLES
  // =====================================================================================================================

  /** World x of each lane centre, left to right (metres). The lane index is the position in this list. */
  const LANE_X = [-2.2, 0, 2.2];
  /** Lane the runner starts in (index into LANE_X). */
  const START_LANE = 1;

  /** How the runner's body moves. Speeds in m/s, accelerations in m/s^2, times in seconds, lengths in metres. */
  const RUNNER = {
    startSpeed: 13, // forward speed on the first frame; the speed curve takes over within a second
    gravity: 40,
    jumpSpeed: 11.5, // upward launch speed: about 1.65 m of clearance and 0.58 s of air time
    fastFallSpeed: -26, // swiping down in mid-air slams the runner to the floor
    hardLandingSpeed: -6, // landing faster than this gets a thud and a squash (a fast-fall, not a normal jump apex drop)
    slideSeconds: 0.6,
    laneSnapRate: 18, // damping rate of the sideways glide into the chosen lane (higher = snappier)
    jumpBufferSeconds: 0.2, // a jump swiped this long before landing still fires on touchdown
    slideBufferSeconds: 0.5, // longer than the jump buffer because the fast-fall it triggers lands within this time
    airborneAbove: 0.05, // feet higher than this count as in the air (avoids flicker from float error at ground level)
    standingHeight: 1.75,
    slidingHeight: 0.8,
    bodyHalfWidth: 0.28, // added to an obstacle's half width for the sideways overlap test
    contactMargin: 0.3, // added to an obstacle's half depth: the runner's own depth front to back
    airJumpPower: 0.85, // a mid-air jump (Glider) launches at this share of the ground jump speed
  };

  /** Rhythm and spawning. Distances in metres, times in seconds. */
  const PACING = {
    beatSeconds: 0.72, // pattern rows are written in beats; one beat is this much travel time at the current speed
    minBeatMetres: 12, // floor for a beat's length so slow early rows are never packed tighter than a jump arc
    spawnHorizon: 100, // patterns are laid out this far ahead (the fog hides everything beyond it)
    firstPatternAt: 25, // empty road before the first pattern: about two seconds to find the controls
    despawnBehind: 14, // objects this far behind the runner are out of the camera's view
    laneShiftsPerRow: 1, // lanes a thumb can cross between two consecutive rows (the fairness check's reach)
    coinSpacing: 2.3, // metres between coins of one trail
    minCoinSteps: 2, // even the shortest trail has three coins
    coinCapacity: 96, // most coins alive at once (the size of the instanced mesh)
    gateEvery: 100, // a neon arch marks every 100 m
    introRuns: 3, // the three teaching patterns open only the first runs; after that every retry starts fresh
    cueLeadSeconds: 1.5, // a teaching callout appears this long before its obstacle arrives
    speedResponse: 4, // damping rate toward the target speed while running
    stopResponse: 9, // damping rate to a standstill after a crash
  };

  /**
   * Difficulty is two curves over distance (metres): forward speed in m/s (about 28 after 30 s, capped where a thumb can
   * still read the rows) and the breathing room between patterns in beats.
   */
  const SPEED_BY_DISTANCE = Kit.curve.of([[0, 16], [150, 19.5], [400, 25], [800, 32]]);
  const GAP_BEATS_BY_DISTANCE = Kit.curve.of([[0, 2.4], [480, 1.6]]);

  /** What earns coins. Times in seconds, lengths in metres. */
  const SCORING = {
    coinHeight: 0.9, // default height of a coin above the track (chest height, so a ground run collects it)
    chestHeight: 0.9, // the point on the runner coins are measured against
    coinReachX: 1,
    coinReachY: 1.3,
    coinReachZ: 1,
    streakSeconds: 0.6, // coins picked up within this of each other continue a streak
    streakEvery: 10, // every tenth coin of a streak scores the `streak` trick
    nearMissSeconds: 0.24, // escaping an obstacle with less than this much travel time left is a close call (a trick)
  };

  /** How the perks behave once owned (their size per level is in PERKS). */
  const PERK_RULES = {
    dashSpeedBoost: 1.9, // forward speed multiplier during the opening dash
    dashMagnetRadius: 6, // the dash also sweeps up coins within this many metres
    dashExitGraceSeconds: 1.2, // invulnerability after the dash ends, so the first obstacle past it is never a blind hit
    shieldGraceSeconds: 1.1, // invulnerability after a shield absorbs a hit
    magnetPullRate: 12, // how fast a coin inside the magnet radius closes on the runner (fraction of the gap per second)
  };

  /**
   * Heat is the combo meter. Tricks add heat, heat is a coin multiplier (x1 at 0 heat, +1 per point), and every coin
   * earned goes into the pot at the current multiplier. Heat holds for a moment after each trick and then drains.
   */
  const HEAT = {
    max: 4, // heat points, so the multiplier tops out at x5
    holdSeconds: 2.5, // after a trick the heat does not drain for this long
    drainPerSecond: 0.35, // heat points lost per second once the hold runs out
    crashSalvage: 0.5, // share of the unbanked pot that survives a crash: banking protects the other half
  };

  /**
   * A scoring move.
   * @typedef {Object} Trick
   * @property {string} label   shown in the floater
   * @property {number} heat    heat points it adds (before the heatGain stat and the zone's multiplier)
   * @property {number} coins   coins it pays into the pot (before the heat multiplier)
   */

  /**
   * Every move that builds heat, keyed by trick id. All of them are tied to an obstacle or a coin trail, so heat cannot
   * be farmed on an empty road.
   * @type {Object<string, Trick>}
   */
  const TRICKS = {
    closeCall: { label: 'Close call', heat: 0.5, coins: 3 }, // escape an obstacle inside the near-miss window
    slideJump: { label: 'Slide jump', heat: 0.35, coins: 2 }, // clear a barrier with a jump launched out of a slide
    diveSlide: { label: 'Dive', heat: 0.35, coins: 2 }, // pass under a beam in a slide that began as a mid-air dive
    streak: { label: 'Streak', heat: 0.2, coins: 2 }, // every SCORING.streakEvery-th coin in a row
    smash: { label: 'Smash', heat: 0.1, coins: 1 }, // break an obstacle during the Head Start dash
  };

  /** Bank pads: a gold pad in one lane under every distance gate. Running over it banks the pot and resets the heat. */
  const PADS = {
    halfWidth: 1, // metres either side of the pad's centre line that count as on it
    clearance: 5, // a pad is never put in a lane with a lane-blocking obstacle this close (metres either way)
    length: 7, // metres of lane the plate covers, long enough to read at a grazing angle
    markerHeight: 3, // a gold arch over the pad's lane, so the pad is seen from far up the road
    hintWithin: 70, // metres before a pad at which a player who has never banked is told what it does
  };

  /**
   * A stretch of the road with its own rules.
   * @typedef {Object} Zone
   * @property {string} id
   * @property {string} name        announced on entry
   * @property {number} from        first metre of the zone
   * @property {number} heatGain    multiplier on heat from tricks
   * @property {number} heatDrain   multiplier on HEAT.drainPerSecond
   * @property {number} padEvery    a bank pad sits under every n-th gate
   * @property {number[]} sky       [top, horizon] sky colours, 0xRRGGBB
   */

  /**
   * Zones, in road order. Later zones raise the stakes of the heat game instead of only the speed: heat comes faster
   * and leaves faster, and in Overdrive the chances to bank are half as frequent.
   * @type {Zone[]}
   */
  const ZONES = [
    { id: 'strip', name: 'Sunset Strip', from: 0, heatGain: 1, heatDrain: 1, padEvery: 1, sky: [0x05021a, 0x4a1260] },
    { id: 'circuit', name: 'Night Circuit', from: 400, heatGain: 1.5, heatDrain: 1.4, padEvery: 1, sky: [0x020818, 0x0d3a6a] },
    { id: 'overdrive', name: 'Overdrive', from: 900, heatGain: 2, heatDrain: 1.8, padEvery: 2, sky: [0x1a0206, 0x7a1430] },
  ];

  /** Obstacle ids, used as cell values in PATTERNS rows. OPEN is an empty lane. */
  const BARRIER = 'barrier', BLOCK = 'block', BEAM = 'beam', OPEN = null;

  /**
   * One box of an obstacle's model.
   * @typedef {Object} ObstaclePart
   * @property {'body'|'neon'|'mark'} style  body: lit solid colour; neon: glowing type colour; mark: pale warning stripe
   * @property {number[]} size  [width, height, depth] in metres
   * @property {number[]} at    [x, y, z] centre, relative to the obstacle's foot on the lane centre line
   * @property {number} [roll]  rotation about z in radians (slanted stripes and chevrons)
   */

  /**
   * One kind of obstacle: one colour and one floor glyph per action the player must take.
   * @typedef {Object} ObstacleType
   * @property {'jump'|'dodge'|'slide'} action  what gets the runner past it
   * @property {'up'|'cross'|'down'} glyph      the chevron painted on the lane in front of it
   * @property {number} color                   0xRRGGBB
   * @property {boolean} blocksLane             true when no action in this lane avoids it (only a lane change does)
   * @property {number} halfWidth               metres from the lane centre to its side
   * @property {number} depth                   metres front to back
   * @property {number} hurtFrom                bottom of the vertical band that hits the runner (metres)
   * @property {number} hurtTo                  top of that band: jump above it or slide below hurtFrom
   * @property {ObstaclePart[]} parts
   */

  /** @returns {ObstaclePart} */
  const part = (style, size, at, roll = 0) => ({ style, size, at, roll });
  /** A pair of slanted neon strokes that form an arrow head above an obstacle: pointing up for "jump", down for "slide". */
  const arrowHead = (height, slant) => [part('neon', [0.62, 0.11, 0.08], [-0.2, height, 0], slant), part('neon', [0.62, 0.11, 0.08], [0.2, height, 0], -slant)];

  /** @type {Object<string, ObstacleType>} */
  const OBSTACLE_TYPES = {
    [BARRIER]: {
      action: 'jump', glyph: 'up', color: 0x19e04a, blocksLane: false, halfWidth: 0.95, depth: 0.5, hurtFrom: 0, hurtTo: 0.75,
      parts: [part('body', [1.9, 0.55, 0.34], [0, 0.3, 0]), part('neon', [1.96, 0.14, 0.4], [0, 0.68, 0]), ...arrowHead(1.5, 0.75)],
    },
    [BLOCK]: {
      action: 'dodge', glyph: 'cross', color: 0xff1f3a, blocksLane: true, halfWidth: 0.95, depth: 1, hurtFrom: 0, hurtTo: 3,
      parts: [
        part('body', [1.9, 2.9, 0.9], [0, 1.45, 0]), part('neon', [1.96, 0.12, 0.96], [0, 2.94, 0]),
        part('mark', [2.5, 0.14, 0.05], [0, 1.45, 0.47], 0.93), part('mark', [2.5, 0.14, 0.05], [0, 1.45, 0.47], -0.93),
      ],
    },
    [BEAM]: {
      action: 'slide', glyph: 'down', color: 0x1f8bff, blocksLane: false, halfWidth: 0.95, depth: 0.5, hurtFrom: 1.05, hurtTo: 1.9,
      parts: [
        part('neon', [2.0, 0.42, 0.34], [0, 1.5, 0]), part('body', [0.13, 1.75, 0.13], [-0.98, 0.87, 0]), part('body', [0.13, 1.75, 0.13], [0.98, 0.87, 0]),
        ...arrowHead(2.35, -0.75),
      ],
    },
  };

  /**
   * A line of obstacles across the track.
   * @typedef {Object} PatternRow
   * @property {number} at                 beats after the pattern's origin
   * @property {Array<?string>} lanes      one cell per lane, left to right: an obstacle id or OPEN
   */

  /**
   * A trail of coins along one lane.
   * @typedef {Object} CoinTrail
   * @property {number} lane      lane index
   * @property {number} from      beats relative to the pattern origin (may be negative: a lead-in before the first row)
   * @property {number} to        beats; the trail ends here
   * @property {number} [arc]     extra height at the middle of the trail in metres, tracing a jump
   * @property {number} [height]  base height in metres (default SCORING.coinHeight; low trails mark a slide)
   */

  /**
   * A hand-written chunk of track. Timing is in beats so a pattern stays equally readable as the run speeds up.
   * @typedef {Object} Pattern
   * @property {string} id
   * @property {PatternRow[]} rows
   * @property {CoinTrail[]} coins
   * @property {string} [teach]    callout shown before the pattern (intro patterns only)
   * @property {number} [from]     first metre at which the spawn table may pick it (Kit.spawnTable)
   * @property {number} [weight]   relative chance while active (Kit.spawnTable)
   */

  /** Coin trails reused by several patterns: an arc over a barrier and a low line under a beam, one per lane. */
  const JUMP_ARCS = LANE_X.map((_, lane) => ({ lane, from: -0.36, to: 0.36, arc: 1.5 }));
  const SLIDE_LINES = LANE_X.map((_, lane) => ({ lane, from: -0.5, to: 0.5, height: 0.55 }));
  const MIDDLE = 1;

  /** Teaching patterns, served in this order at the start of a player's first PACING.introRuns runs. @type {Pattern[]} */
  const INTRO_PATTERNS = [
    { id: 'teachDodge', teach: 'Swipe sideways', rows: [{ at: 0, lanes: [OPEN, BLOCK, OPEN] }], coins: [{ lane: 1, from: -1.6, to: -0.8 }, { lane: 2, from: -0.5, to: 0.8 }] },
    { id: 'teachJump', teach: 'Swipe up', rows: [{ at: 0, lanes: [BARRIER, BARRIER, BARRIER] }], coins: JUMP_ARCS },
    { id: 'teachSlide', teach: 'Swipe down', rows: [{ at: 0, lanes: [BEAM, BEAM, BEAM] }], coins: SLIDE_LINES },
  ];

  /** The random pool. Adding a pattern is adding a row; unfair rows are filtered out below. @type {Pattern[]} */
  const POOL_PATTERNS = [
    { id: 'wall', from: 0, weight: 3, rows: [{ at: 0, lanes: [BLOCK, BLOCK, OPEN] }], coins: [{ lane: 2, from: -0.8, to: 0.8 }] },
    { id: 'gate', from: 0, weight: 2, rows: [{ at: 0, lanes: [BARRIER, BARRIER, BARRIER] }], coins: [JUMP_ARCS[MIDDLE]] },
    { id: 'duck', from: 0, weight: 2, rows: [{ at: 0, lanes: [BEAM, BEAM, BEAM] }], coins: [SLIDE_LINES[MIDDLE]] },
    { id: 'choice', from: 0, weight: 3, rows: [{ at: 0, lanes: [BARRIER, BLOCK, BEAM] }], coins: [JUMP_ARCS[0], SLIDE_LINES[2]] },
    { id: 'zigzag', from: 0, weight: 2, rows: [], coins: [{ lane: 0, from: 0, to: 0.6 }, { lane: 1, from: 0.9, to: 1.5 }, { lane: 2, from: 1.8, to: 2.4 }] },
    {
      id: 'slalom', from: 150, weight: 3,
      rows: [{ at: 0, lanes: [BLOCK, OPEN, BLOCK] }, { at: 1, lanes: [OPEN, BLOCK, BLOCK] }, { at: 2, lanes: [BLOCK, OPEN, BLOCK] }],
      coins: [{ lane: 1, from: -0.3, to: 0.3 }, { lane: 0, from: 0.8, to: 1.2 }, { lane: 1, from: 1.8, to: 2.3 }],
    },
    {
      id: 'hurdles', from: 200, weight: 2,
      rows: [{ at: 0, lanes: [BARRIER, BARRIER, BARRIER] }, { at: 1.3, lanes: [BARRIER, BARRIER, BARRIER] }],
      coins: [JUMP_ARCS[MIDDLE], { lane: 1, from: 0.94, to: 1.66, arc: 1.5 }],
    },
    {
      id: 'mix', from: 250, weight: 3,
      rows: [{ at: 0, lanes: [BARRIER, OPEN, BLOCK] }, { at: 1.2, lanes: [BEAM, BEAM, OPEN] }],
      coins: [{ lane: 1, from: -0.4, to: 0.4 }, { lane: 2, from: 0.8, to: 1.6 }],
    },
    {
      id: 'stagger', from: 350, weight: 2,
      rows: [{ at: 0, lanes: [OPEN, BLOCK, BLOCK] }, { at: 1, lanes: [BLOCK, OPEN, BARRIER] }, { at: 2.2, lanes: [OPEN, BEAM, BEAM] }],
      coins: [{ lane: 0, from: -0.3, to: 0.3 }, { lane: 1, from: 0.7, to: 1.3 }, { lane: 0, from: 1.8, to: 2.5 }],
    },
  ];

  /**
   * Starting values of every stat a run reads. Perks, the chosen runner and active synergies all modify these through
   * one Kit.stats, so their effects stack and interact without knowing about each other.
   */
  const BASE_STATS = {
    magnet: 0, // coin pull radius in metres
    dash: 0, // opening dash length in metres
    shield: 0, // hits absorbed per run
    airJumps: 0, // extra jumps allowed in mid-air
    heatGain: 1, // multiplier on heat from tricks
    heatDrain: 1, // multiplier on how fast heat drains
    heatHold: 0, // extra seconds heat holds after a trick
    nearMissWindow: 1, // multiplier on SCORING.nearMissSeconds (wider = easier close calls)
    closeCallCoins: 0, // extra coins per close call
    bankBonus: 0, // extra share paid when a pot is banked (0.2 = +20%)
    shieldHeatKept: 0.5, // share of the heat that survives a shield hit
  };

  /**
   * A permanent perk (a Kit.upgrades row) bought in the garage with banked coins.
   * @typedef {Object} Perk
   * @property {string} id
   * @property {string} name
   * @property {number} max                         highest level
   * @property {number[][]} cost                     Kit.curve points [levels owned, price of the next level in coins]
   * @property {string} color                       CSS colour of its garage bay and loadout tag
   * @property {number} sparkColor                  the same colour as 0xRRGGBB, for the particle burst when it is fitted
   * @property {string[]} tags                      what kind of part it is; SYNERGIES count these
   * @property {string} [unlock]                    profile unlock id that puts it in the garage (omit: there from the start)
   * @property {Object} mods                        per-level modifiers for BASE_STATS (scaled by level by Kit.upgrades)
   * @property {function(number): string} desc      what the given level does, for the garage
   */

  /**
   * The first level of the starting perks is affordable after one or two runs. Later levels cost 10 to 20 times more:
   * the heat multiplier makes a skilled player's income grow that fast, and scratch/runner/pacing.js is how the prices
   * were set (see the depth plan in the file header for the measured curve). Vault and Hot Tyres arrive through ACHIEVEMENTS.
   * @type {Perk[]}
   */
  const PERKS = [
    { id: 'magnet', name: 'Magnet', max: 3, cost: [[0, 30], [1, 300], [2, 6000]], color: '#ffc145', sparkColor: 0xffc145, tags: ['pull'], mods: { magnet: { add: 2.5 } }, desc: (level) => `pulls coins in from ${level * 2.5} m` },
    { id: 'head', name: 'Head Start', max: 3, cost: [[0, 40], [1, 400], [2, 8000]], color: '#ff5d9e', sparkColor: 0xff5d9e, tags: ['speed'], mods: { dash: { add: 50 } }, desc: (level) => `${level * 50} m invincible dash` },
    { id: 'shield', name: 'Shield', max: 2, cost: [[0, 50], [1, 3000]], color: '#4de2c5', sparkColor: 0x4de2c5, tags: ['guard'], mods: { shield: { add: 1 } }, desc: (level) => `shrugs off ${level} hit${level > 1 ? 's' : ''}` },
    { id: 'vault', name: 'Vault', max: 3, cost: [[0, 200], [1, 1200], [2, 14000]], color: '#ffe08a', sparkColor: 0xffe08a, tags: ['bank'], unlock: 'perk:vault', mods: { bankBonus: { add: 0.15 } }, desc: (level) => `banked pots pay +${level * 15}%` },
    { id: 'tyres', name: 'Hot Tyres', max: 3, cost: [[0, 300], [1, 1800], [2, 20000]], color: '#ff8a4a', sparkColor: 0xff8a4a, tags: ['risk'], unlock: 'perk:tyres', mods: { heatHold: { add: 0.8 } }, desc: (level) => `heat holds ${(level * 0.8).toFixed(1)} s longer` },
  ];
  const PERK_BY_ID = PERKS.reduce((byId, perk) => ({ ...byId, [perk.id]: perk }), {});

  /**
   * A runner the player can pick in the garage. Each changes how a run is played and pays for it somewhere else.
   * @typedef {Object} RunnerType
   * @property {string} id
   * @property {string} name
   * @property {string[]} tags      counted by SYNERGIES together with the owned perks
   * @property {string} [unlock]    profile unlock id (omit: available from the start)
   * @property {Object} mods        Kit.stats modifiers applied while this runner is chosen
   * @property {string} desc        the ability and its price, for the garage
   */

  /** @type {RunnerType[]} */
  const RUNNERS = [
    { id: 'rookie', name: 'Rookie', tags: [], mods: {}, desc: 'no tricks up the sleeve' },
    { id: 'glider', name: 'Glider', tags: ['air', 'risk'], unlock: 'runner:glider', mods: { airJumps: { add: 1 }, heatDrain: { mul: 1.3 } }, desc: 'jumps again in mid-air; heat drains 30% faster' },
    { id: 'bruiser', name: 'Bruiser', tags: ['guard'], unlock: 'runner:bruiser', mods: { shield: { add: 1 }, heatGain: { mul: 0.7 } }, desc: 'one free shield; tricks give 30% less heat' },
    { id: 'ghost', name: 'Ghost', tags: ['risk'], unlock: 'runner:ghost', mods: { nearMissWindow: { mul: 1.6 }, bankBonus: { add: -0.25 } }, desc: 'close calls come easier; banked pots pay 25% less' },
  ];

  /**
   * Set bonuses (Kit.synergy rows): active while the build (owned perks plus the chosen runner) holds the tags in
   * `needs`. They are why the same perk is worth more to one build than another.
   */
  const SYNERGIES = [
    { id: 'daredevil', name: 'Daredevil', needs: { risk: 2 }, mods: { closeCallCoins: { add: 2 } }, desc: 'close calls pay +2' },
    { id: 'armoured', name: 'Armoured Van', needs: { guard: 2 }, mods: { shieldHeatKept: { add: 0.5 } }, desc: 'a shield hit keeps all your heat' },
    { id: 'slipstream', name: 'Slipstream', needs: { speed: 1, risk: 1 }, mods: { heatGain: { mul: 1.25 } }, desc: 'tricks give 25% more heat' },
    { id: 'moneyMagnet', name: 'Money Magnet', needs: { pull: 1, bank: 1 }, mods: { bankBonus: { add: 0.15 } }, desc: 'banked pots pay +15%' },
    { id: 'airShow', name: 'Air Show', needs: { air: 1, bank: 1 }, mods: { heatHold: { add: 1 } }, desc: 'heat holds 1 s longer' },
  ];

  /**
   * The long arc (Kit.profile achievement rows): lifetime goals whose rewards change how the game is played.
   * `stat` names a lifetime statistic recorded by createCareer().finishRun.
   */
  const ACHIEVEMENTS = [
    { id: 'firstBank', text: 'Bank a pot on a gold pad', stat: 'banks', target: 1, unlocks: 'perk:vault' },
    { id: 'reachCircuit', text: 'Reach the Night Circuit (400 m)', stat: 'bestDistance', target: 400, unlocks: 'perk:tyres' },
    { id: 'closeCalls', text: 'Make 40 close calls', stat: 'closeCalls', target: 40, unlocks: 'runner:glider' },
    { id: 'banked', text: 'Bank 5,000 coins in total', stat: 'coinsBanked', target: 5000, unlocks: 'runner:bruiser' },
    { id: 'heat', text: 'Reach x4 heat', stat: 'bestMultiplier', target: 4, unlocks: 'runner:ghost' },
    { id: 'reachOverdrive', text: 'Reach Overdrive (900 m)', stat: 'bestDistance', target: 900 },
    { id: 'bigPot', text: 'Bank a single pot of 400', stat: 'bestBank', target: 400 },
    { id: 'tricks', text: 'Land 1,500 tricks', stat: 'tricks', target: 1500 },
    { id: 'fortune', text: 'Bank 50,000 coins in total', stat: 'coinsBanked', target: 50000 },
    { id: 'reachFar', text: 'Reach 1,500 m', stat: 'bestDistance', target: 1500 },
  ];

  /** Keys in this game's save. `legacyBank` is the bare coin count the first draft stored before Kit.wallet existed. */
  const SAVE_KEYS = { best: 'best', runs: 'runs', perks: 'perks', runner: 'runner', legacyBank: 'bank' };

  /** Scene colours (0xRRGGBB). The HUD's CSS colours live in THEME. */
  const COLORS = {
    cyan: 0x4de2c5, pink: 0xff5d9e, gold: 0xffc145, violet: 0x8a6bff,
    fog: 0x2a0c4a, sunLight: 0xd8ccff, sunGlow: 0xff3d9a,
    suit: 0xcfe6f5, towerBody: 0x1b1245, towerGlow: 0x3a1a80, warningStripe: 0xffe3e8,
    coin: 0xffb400, coinGlow: 0xff9500, coinSpark: 0xffd86b, speedLine: 0xbfe6ff, white: 0xffffff,
  };
  const TOWER_NEON_COLORS = [COLORS.cyan, COLORS.pink, COLORS.violet, COLORS.gold];

  /** Backdrop layout. Lengths in metres. */
  const SCENERY = {
    trackWidth: 8.8, roadLength: 300, roadCentreZ: -130, // the road strip reaches from 20 m behind to 280 m ahead
    tileLength: 10, // one repeat of the track / grid texture, so textures scroll by distance / tileLength
    gridWidth: 400, gridDrop: -0.5, railX: 4.5,
    sunSize: 95, sunAt: [0, 22, -290], sunGlowSize: 230, sunGlowAt: [0, 16, -295],
    towerCount: 28, towerSpacing: 9, towerFirstAt: -10, towerRecycleBehind: 16,
    gateHalfWidth: 5, gateHeight: 7, gateBeam: 0.3,
    speedLineCount: 36, speedLineFromSpeed: 17, speedLineFullAfter: 15, // lines fade in between 17 and 32 m/s
  };

  /** Chase camera and garage showroom camera. Angles in degrees, lengths in metres, rates are damping rates. */
  const CAMERA = {
    portraitFov: 66, landscapeFov: 54, fovRate: 3,
    speedFovFrom: 16, speedFovRange: 20, speedFovGain: 15, // the view widens by up to 15 degrees between 16 and 36 m/s
    dashFovGain: 9,
    frameWidth: 5.4, // metres of track the camera must see across at the runner (keeps all three lanes on a narrow phone)
    minBackPortrait: 5.2, minBackLandscape: 6.5, maxBack: 9.5, crashBack: 6.2, startBack: 9,
    height: 3.3, heightPerJumpMetre: 0.3, followX: 0.62, lookAheadX: 0.85,
    lookYPortrait: 1.35, lookYLandscape: 0.3, // landscape looks lower so the runner clears the bottom HUD
    lookZ: -10, rollPerLean: 0.07, rateX: 7, rateY: 8, rateZ: 5,
    // Three-quarter view from behind, tilted down so the runner stands in the upper half of the screen, clear of the bays.
    garageAt: [2.4, 1.7, 5.8], garageLookAt: [-1, -1.6, -4], garageRate: 4,
  };

  /** Runner animation. Angles in radians. */
  const POSE = {
    strideRate: 0.62, // leg-swing radians per metre travelled, so the legs keep pace with the road
    squashRecovery: 12, leanRate: 16, leanPerMetre: 0.45, maxLean: 0.6, bumpLean: 0.3,
    jumpSquash: -0.6, slideSquash: 0.5, landSquash: 0.7, // negative stretches tall, positive flattens
    slideTilt: 1.25, airTilt: -0.25, runTilt: -0.16, tiltRate: 18, slideDrop: -0.5, bounce: 0.09,
    blinkHz: 24, // flicker rate while invulnerable
    crashSpin: 1.9, crashMaxRoll: 0.6, crashLift: 1.3, crashThrowBack: 2.4, crashSeconds: 0.22,
  };

  /** The garage backdrop: the runner jogs on an empty road. */
  const GARAGE = { cruiseSpeed: 7 };

  /** The bass pulse that quickens with the run, so the pace is audible. */
  const BASS = { notes: [110, 110, 130, 98], beatSeconds: 0.48, referenceSpeed: 16, dropTo: 45, seconds: 0.14, volume: 0.22 };

  /** Speedometer scale: the tach bar is empty at `from` m/s and full (redline) at `to`. */
  const TACH = { from: 10, to: 40, kmhPerMs: 3.6 };

  /** Game-time lengths of callouts, in milliseconds (ui.toast's unit). */
  const TOAST_MS = { cue: 1200, perk: 1100, shield: 900, zone: 1600 };

  // =====================================================================================================================
  // SIMULATION: plain data in, plain data out. Nothing below touches THREE, the DOM, sound or the save.
  // =====================================================================================================================

  /** Metres covered by one beat at a given forward speed. Rows are spaced by time, not distance: see layoutPattern. */
  const beatMetres = (speed) => Math.max(PACING.minBeatMetres, speed * PACING.beatSeconds);

  /** The lanes of a row a runner can get through: every lane except those holding an obstacle that blocks its lane. */
  const openLanesOf = (row) => Kit.lanes.open(row.lanes, (cell) => cell !== OPEN && OBSTACLE_TYPES[cell].blocksLane);

  /**
   * The fairness filter. A pattern is fair when one continuous route leads through all its rows, moving at most
   * PACING.laneShiftsPerRow lanes between consecutive rows. Barriers and beams never close a lane (a jump or slide
   * passes them where the runner stands); only blocks do. Kit.lanes walks the rows carrying the set of lanes the runner
   * could actually be in, so a pattern like [open left] -> [open left and right] -> [open right] is rejected even though
   * each neighbouring pair of rows looks compatible on its own.
   * @param {Pattern} pattern
   * @returns {boolean}
   */
  const isPatternFair = (pattern) => Kit.lanes.isPassable(pattern.rows.map(openLanesOf), { reach: PACING.laneShiftsPerRow });

  /**
   * Builds the pattern source for one run: teaching patterns first for a new player, then weighted picks by distance.
   * @param {number} runsPlayed completed runs in the save
   * @returns {{ next: function(number): ?Pattern }} Kit.spawnTable; `next(distance)` is the pattern to lay out next
   */
  const createPatternSource = (runsPlayed) =>
    Kit.spawnTable(POOL_PATTERNS.filter(isPatternFair), { intro: runsPlayed < PACING.introRuns ? INTRO_PATTERNS.filter(isPatternFair) : [] });

  /**
   * @typedef {Object} Obstacle
   * @property {string} type        key of OBSTACLE_TYPES
   * @property {number} x           lane centre in world metres
   * @property {number} distance    metres from the start line
   * @property {boolean} isThreat   the runner was on a collision course inside the near-miss window
   * @property {boolean} isResolved its near-miss outcome has been decided (so it is paid at most once)
   * @property {boolean} wasGhosted the runner passed through it while invulnerable (no near-miss credit for that)
   * @property {boolean} isGone     removed from play this frame; the view releases its mesh
   */

  /** @typedef {{ x: number, y: number, distance: number }} Coin  world metres; `distance` from the start line */

  /** Turns one coin trail into coins: evenly spaced along the lane, lifted along a half sine when the trail has an arc. */
  const layoutCoinTrail = (trail, origin, beat, laneAfterMirror) => {
    const steps = Math.max(PACING.minCoinSteps, Math.round(((trail.to - trail.from) * beat) / PACING.coinSpacing));
    return Array.from({ length: steps + 1 }, (_, step) => {
      const progress = step / steps;
      return {
        x: LANE_X[laneAfterMirror(trail.lane)],
        y: (trail.height || SCORING.coinHeight) + (trail.arc || 0) * Math.sin(Math.PI * progress),
        distance: origin + lerp(trail.from, trail.to, progress) * beat,
      };
    });
  };

  /**
   * Places a pattern on the road. Pure: the same inputs always give the same layout.
   *
   * Time-based spacing: rows and trails are written in beats and multiplied by `beat` (metres per beat at the speed the
   * runner will have there), so two rows one beat apart always arrive PACING.beatSeconds apart however fast the run is.
   * @param {Pattern} pattern
   * @param {{ startDistance: number, beat: number, isMirrored: boolean }} placement
   *   startDistance: nothing of the pattern lands before this metre; beat: metres per beat; isMirrored: flip left / right
   * @returns {{ origin: number, endDistance: number, obstacles: Obstacle[], coins: Coin[], cue: ?{ distance: number, text: string } }}
   *   origin: the metre of beat 0; endDistance: the metre of its last row or coin
   */
  function layoutPattern(pattern, { startDistance, beat, isMirrored }) {
    const laneAfterMirror = (lane) => (isMirrored ? LANE_X.length - 1 - lane : lane);
    // A trail may lead in before beat 0 (negative beats). Push the origin back by that lead so it starts at startDistance.
    const leadBeats = Math.max(0, ...pattern.coins.map((trail) => -trail.from));
    const origin = startDistance + leadBeats * beat;
    const obstacles = pattern.rows.flatMap((row) =>
      row.lanes
        .map((type, lane) => ({ type, x: LANE_X[laneAfterMirror(lane)], distance: origin + row.at * beat, isThreat: false, isResolved: false, wasGhosted: false, isGone: false }))
        .filter((obstacle) => obstacle.type !== OPEN)
    );
    const lastBeat = Math.max(0, ...pattern.rows.map((row) => row.at), ...pattern.coins.map((trail) => trail.to));
    return {
      origin,
      endDistance: origin + lastBeat * beat,
      obstacles,
      coins: pattern.coins.flatMap((trail) => layoutCoinTrail(trail, origin, beat, laneAfterMirror)),
      cue: pattern.teach ? { distance: origin, text: pattern.teach, isAnnounced: false } : null,
    };
  }

  /**
   * @typedef {Object} RunnerState
   * @property {number} lane               target lane index
   * @property {number} x                  current world x (glides toward the lane centre)
   * @property {number} height             feet above the track in metres
   * @property {number} verticalSpeed      m/s, positive up
   * @property {number} slideSecondsLeft
   * @property {?string} bufferedAction    'up' or 'down' swiped in mid-air, waiting for touchdown
   * @property {number} bufferSecondsLeft  the buffered action only fires while this is positive
   * @property {number} airJumps           extra mid-air jumps this runner type allows per jump
   * @property {number} airJumpsLeft       how many of those remain before the next landing
   * @property {boolean} isSlideJumping    the current jump was launched out of a slide (a trick if it clears a barrier)
   * @property {boolean} isDiveSliding     the current slide began as a mid-air dive (a trick if it passes a beam)
   */

  /**
   * Everything that defines a run in progress.
   * @typedef {Object} Run
   * @property {number} distance            metres travelled
   * @property {number} speed               m/s
   * @property {number} coinsCollected      coins earned this run before the heat multiplier (statistics only)
   * @property {number} heat                0..HEAT.max; the coin multiplier is 1 + heat
   * @property {number} heatHoldSeconds     heat does not drain while this is positive
   * @property {number} bestHeat            highest heat reached this run
   * @property {number} pot                 coins earned but not yet banked; a crash keeps only HEAT.crashSalvage of it
   * @property {number} banked              coins made safe on bank pads this run
   * @property {number} banks               pots banked this run
   * @property {number} bestBank            largest single pot banked this run
   * @property {number} tricks              tricks landed this run
   * @property {Object<string, number>} mods the stats the run started with (BASE_STATS keys), read-only
   * @property {Array<{ distance: number, x: number, isDecided: boolean, isUsed: boolean }>} pads bank pads on the road, nearest first
   * @property {number} nextPadGate         index (1-based) of the next gate that may get a pad
   * @property {string} zoneId              id of the ZONES row the runner is in
   * @property {number} coinStreak          coins picked up in the current unbroken streak
   * @property {number} streakSecondsLeft
   * @property {number} nearMisses
   * @property {number} shieldsLeft         hits the Shield perk can still absorb
   * @property {number} dashLength          metres of Head Start dash (0 without the perk)
   * @property {number} magnetRadius        metres of Magnet pull (0 without the perk)
   * @property {number} invulnerableSeconds obstacles pass through the runner while this is positive
   * @property {boolean} wasDashing         dash state on the previous frame, to detect the moment it ends
   * @property {boolean} isCrashed
   * @property {RunnerState} runner
   * @property {Obstacle[]} obstacles
   * @property {Coin[]} coins
   * @property {Array<{ distance: number, text: string, isAnnounced: boolean }>} cues teaching callouts, nearest first
   * @property {number} nextPatternAt       metre at which the next pattern may start
   * @property {number} nextGateAt          metre of the next distance gate
   */

  /**
   * Something that happened during one simulation step, for the presentation layer to react to.
   * @typedef {Object} RunEvent
   * @property {string} type  jump | slide | laneChange | bump | land | coin | trick | bank | zone | shieldHit | crash | gate | cue | dashEnd
   * @property {string} [trick] trick: key of TRICKS
   * @property {number} [coins] trick: coins paid before the multiplier; bank: coins made safe
   * @property {Zone} [zone] zone: the zone just entered
   * @property {number} [direction] laneChange / bump: -1 left, 1 right
   * @property {number} [x] coin: world x of the pickup
   * @property {number} [y] coin: world y of the pickup
   * @property {number} [streak] coin / streak: length of the streak
   * @property {Obstacle} [obstacle] smash / shieldHit / crash
   * @property {string} [text] cue
   */

  /**
   * Starts a run.
   * @param {Object<string, number>} loadout the stats the run starts with: a value for every BASE_STATS key
   * @returns {Run}
   */
  const createRun = (loadout) => ({
    distance: 0, speed: RUNNER.startSpeed, coinsCollected: 0, coinStreak: 0, streakSecondsLeft: 0, nearMisses: 0,
    heat: 0, heatHoldSeconds: 0, bestHeat: 0, pot: 0, banked: 0, banks: 0, bestBank: 0, tricks: 0,
    mods: loadout, shieldsLeft: loadout.shield, dashLength: loadout.dash, magnetRadius: loadout.magnet,
    invulnerableSeconds: 0, wasDashing: loadout.dash > 0, isCrashed: false,
    runner: {
      lane: START_LANE, x: LANE_X[START_LANE], height: 0, verticalSpeed: 0, slideSecondsLeft: 0, bufferedAction: null, bufferSecondsLeft: 0,
      airJumps: loadout.airJumps, airJumpsLeft: loadout.airJumps, isSlideJumping: false, isDiveSliding: false,
    },
    obstacles: [], coins: [], cues: [], pads: [], nextPatternAt: PACING.firstPatternAt, nextGateAt: PACING.gateEvery, nextPadGate: 1, zoneId: ZONES[0].id,
  });

  /** The stats of a player who owns nothing: what createRun gets on a first run. */
  const baseLoadout = () => ({ ...BASE_STATS });

  /** The zone a distance lies in: the last ZONES row that starts at or before it. @returns {Zone} */
  const zoneAt = (distance) => ZONES.reduce((current, zone) => (distance >= zone.from ? zone : current), ZONES[0]);

  /** The coin multiplier the heat gives right now. */
  const heatMultiplier = (run) => 1 + run.heat;

  /** Pays coins into the pot at the current multiplier. */
  const earnCoins = (run, coins) => {
    run.coinsCollected += coins;
    run.pot += coins * heatMultiplier(run);
  };

  /**
   * Scores a trick: pays its coins at the multiplier the player had going in, then raises the heat and restarts the
   * hold. Heat gain is scaled by the build (heatGain stat) and by the zone, so the same close call is worth more in the
   * Night Circuit with Slipstream active than on the Sunset Strip without.
   * @param {Run} run
   * @param {string} trickId key of TRICKS
   * @param {RunEvent[]} events
   * @param {Object} [details] extra fields for the event (for example the obstacle that was smashed)
   */
  function scoreTrick(run, trickId, events, details = {}) {
    const trick = TRICKS[trickId];
    const coins = trick.coins + (trickId === 'closeCall' ? run.mods.closeCallCoins : 0);
    earnCoins(run, coins);
    run.heat = Math.min(HEAT.max, run.heat + trick.heat * run.mods.heatGain * zoneAt(run.distance).heatGain);
    run.bestHeat = Math.max(run.bestHeat, run.heat);
    run.heatHoldSeconds = HEAT.holdSeconds + run.mods.heatHold;
    run.tricks += 1;
    events.push({ type: 'trick', trick: trickId, coins, ...details });
  }

  /** Drains the heat once its hold has run out. Mutates `run`. */
  function advanceHeat(run, dt) {
    run.heatHoldSeconds -= dt;
    if (run.heatHoldSeconds > 0) return;
    run.heat = Math.max(0, run.heat - HEAT.drainPerSecond * run.mods.heatDrain * zoneAt(run.distance).heatDrain * dt);
  }

  /** What a run pays out: everything banked plus the salvaged share of the pot still at risk. @returns {number} whole coins */
  const payoutOf = (run) => Math.round(run.banked + run.pot * HEAT.crashSalvage);

  const isDashing = (run) => !run.isCrashed && run.distance < run.dashLength;
  const isAirborne = (runner) => runner.height > RUNNER.airborneAbove;
  const isSliding = (runner) => runner.slideSecondsLeft > 0 && !isAirborne(runner);

  /** Remembers a swipe made in mid-air so it fires on landing (see advanceRunner). */
  const bufferAction = (runner, action, seconds) => Object.assign(runner, { bufferedAction: action, bufferSecondsLeft: seconds });

  /** Moves one lane sideways, or reports a bump when already at the edge of the track. @returns {RunEvent[]} */
  function shiftLane(runner, direction) {
    const targetLane = runner.lane + direction;
    if (targetLane < 0 || targetLane >= LANE_X.length) return [{ type: 'bump', direction }];
    runner.lane = targetLane;
    return [{ type: 'laneChange', direction }];
  }

  /**
   * What each swipe does to the runner: a strategy table keyed by swipe direction. Each entry mutates the runner it is
   * given and returns the events that caused. Jump and slide in mid-air are buffered to the landing instead of dropped.
   * @type {Object<string, function(RunnerState): RunEvent[]>}
   */
  const RUNNER_ACTIONS = {
    left: (runner) => shiftLane(runner, -1),
    right: (runner) => shiftLane(runner, 1),
    up(runner) {
      if (isAirborne(runner)) {
        // A runner type with air jumps spends one; everyone else buffers the jump to the landing.
        if (runner.airJumpsLeft > 0) {
          runner.airJumpsLeft -= 1;
          runner.verticalSpeed = RUNNER.jumpSpeed * RUNNER.airJumpPower;
          return [{ type: 'jump' }];
        }
        bufferAction(runner, 'up', RUNNER.jumpBufferSeconds);
        return [];
      }
      // Jumping cancels a slide; a jump launched out of one is remembered because clearing a barrier with it is a trick.
      Object.assign(runner, { verticalSpeed: RUNNER.jumpSpeed, isSlideJumping: runner.slideSecondsLeft > 0, slideSecondsLeft: 0 });
      return [{ type: 'jump' }];
    },
    down(runner) {
      if (isAirborne(runner)) {
        // Swiping down in the air dives to the floor and slides the moment it lands.
        runner.verticalSpeed = RUNNER.fastFallSpeed;
        bufferAction(runner, 'down', RUNNER.slideBufferSeconds);
        return [];
      }
      runner.slideSecondsLeft = RUNNER.slideSeconds;
      return [{ type: 'slide' }];
    },
  };

  /**
   * Advances the runner's body by one step: sideways glide, gravity, landing and the buffered action. Mutates `runner`.
   * @param {RunnerState} runner
   * @param {number} dt seconds
   * @returns {RunEvent[]}
   */
  function advanceRunner(runner, dt) {
    const events = [];
    runner.x = damp(runner.x, LANE_X[runner.lane], RUNNER.laneSnapRate, dt);
    runner.verticalSpeed -= RUNNER.gravity * dt;
    runner.height += runner.verticalSpeed * dt;
    if (runner.height <= 0) {
      if (runner.verticalSpeed < RUNNER.hardLandingSpeed) events.push({ type: 'land' });
      Object.assign(runner, { height: 0, verticalSpeed: 0, airJumpsLeft: runner.airJumps, isSlideJumping: false });
      // Touchdown: fire the swipe that was made in the air, if it is still fresh.
      if (runner.bufferedAction && runner.bufferSecondsLeft > 0) {
        const action = runner.bufferedAction;
        runner.bufferedAction = null;
        events.push(...RUNNER_ACTIONS[action](runner));
        runner.isDiveSliding = action === 'down'; // the slide that starts now came out of a dive
      }
    }
    runner.bufferSecondsLeft -= dt;
    runner.slideSecondsLeft = Math.max(0, runner.slideSecondsLeft - dt);
    if (runner.slideSecondsLeft === 0) runner.isDiveSliding = false;
    return events;
  }

  /** True when the runner's body overlaps an obstacle sideways and vertically (front-to-back is judged by encounterZone). */
  const isInPathOf = (obstacle, type, runner) => {
    const feet = runner.height;
    const head = feet + (isSliding(runner) ? RUNNER.slidingHeight : RUNNER.standingHeight);
    return Math.abs(obstacle.x - runner.x) < type.halfWidth + RUNNER.bodyHalfWidth && feet < type.hurtTo && head > type.hurtFrom;
  };

  /**
   * Classifies where an obstacle is relative to the runner. Pure.
   *
   * Near-miss detection works in three zones along the road. While the obstacle is still ahead but closer than
   * SCORING.nearMissSeconds of travel AND the runner's body is in its path, it is a "threat": doing nothing would be a
   * hit. Inside the obstacle's own depth it is "contact" when the body still overlaps (a hit) and "beside" when it does
   * not. Once it is "passed", an obstacle that had been a threat means the player escaped at the last moment.
   * @param {number} metresPast  run.distance - obstacle.distance: negative while the obstacle is ahead
   * @param {number} reach       half the obstacle's depth plus the runner's own depth (metres)
   * @param {boolean} isInPath   the runner's body overlaps the obstacle sideways and vertically
   * @param {number} speed       m/s
   * @param {number} [windowSeconds] the near-miss window (the build can widen it)
   * @returns {'contact'|'beside'|'threat'|'ahead'|'passed'}
   */
  function encounterZone(metresPast, reach, isInPath, speed, windowSeconds = SCORING.nearMissSeconds) {
    if (Math.abs(metresPast) <= reach) return isInPath ? 'contact' : 'beside';
    if (metresPast > 0) return 'passed';
    const metresToContact = -metresPast - reach;
    return isInPath && metresToContact < speed * windowSeconds ? 'threat' : 'ahead';
  }

  /**
   * What happens to the run in each zone that has consequences (zones without an entry do nothing).
   * Each rule mutates `run` / `obstacle` and appends to `events`.
   * @type {Object<string, function(Run, Obstacle, RunEvent[]): void>}
   */
  const ENCOUNTER_RULES = {
    contact(run, obstacle, events) {
      if (isDashing(run)) {
        // The Head Start dash ploughs through everything and pays a coin for each obstacle.
        obstacle.isGone = true;
        scoreTrick(run, 'smash', events, { obstacle });
        return;
      }
      if (run.invulnerableSeconds > 0) {
        // Ghosting through during a grace period is not a dodge: remember it so `passed` pays no close call.
        obstacle.wasGhosted = true;
        return;
      }
      if (run.shieldsLeft > 0) {
        run.shieldsLeft -= 1;
        run.invulnerableSeconds = PERK_RULES.shieldGraceSeconds;
        run.heat *= Math.min(1, run.mods.shieldHeatKept); // the hit costs heat, unless the build protects it
        obstacle.isGone = true;
        events.push({ type: 'shieldHit', obstacle });
        return;
      }
      run.isCrashed = true;
      events.push({ type: 'crash', obstacle });
    },
    threat(run, obstacle) {
      // Nothing is a threat during the dash, so smashing through rows never counts as a string of close calls.
      if (!isDashing(run)) obstacle.isThreat = true;
    },
    passed(run, obstacle, events) {
      if (obstacle.isResolved) return;
      obstacle.isResolved = true;
      if (obstacle.wasGhosted) return;
      const runner = run.runner;
      const wasInLane = Math.abs(obstacle.x - runner.x) < OBSTACLE_TYPES[obstacle.type].halfWidth;
      // Technique tricks: the runner went over or under this obstacle in its own lane using the harder move.
      if (wasInLane && obstacle.type === BARRIER && runner.isSlideJumping) scoreTrick(run, 'slideJump', events);
      if (wasInLane && obstacle.type === BEAM && runner.isDiveSliding) scoreTrick(run, 'diveSlide', events);
      if (!obstacle.isThreat) return;
      run.nearMisses += 1;
      scoreTrick(run, 'closeCall', events);
    },
  };

  /** Resolves every obstacle against the runner and drops the ones that are gone or far behind. Mutates `run`. */
  function advanceObstacles(run, events) {
    let keptCount = 0;
    // Per-frame hot path: an index loop that compacts the array in place instead of filter(), so no array is allocated.
    for (let index = 0; index < run.obstacles.length; index++) {
      const obstacle = run.obstacles[index];
      // After a crash the rest of the row is left exactly where it stands for the wreck shot.
      if (!run.isCrashed) {
        const type = OBSTACLE_TYPES[obstacle.type];
        const metresPast = run.distance - obstacle.distance;
        const zone = encounterZone(metresPast, type.depth / 2 + RUNNER.contactMargin, isInPathOf(obstacle, type, run.runner), run.speed, SCORING.nearMissSeconds * run.mods.nearMissWindow);
        const rule = ENCOUNTER_RULES[zone];
        if (rule) rule(run, obstacle, events);
        if (metresPast > PACING.despawnBehind) obstacle.isGone = true;
      }
      if (!obstacle.isGone) run.obstacles[keptCount++] = obstacle;
    }
    run.obstacles.length = keptCount;
  }

  /** Counts one collected coin, extends the streak and scores the streak trick on every SCORING.streakEvery-th coin. */
  function collectCoin(run, coin, events) {
    run.coinStreak += 1;
    run.streakSecondsLeft = SCORING.streakSeconds;
    earnCoins(run, 1);
    events.push({ type: 'coin', x: coin.x, y: coin.y, streak: run.coinStreak });
    if (run.coinStreak % SCORING.streakEvery === 0) scoreTrick(run, 'streak', events, { streak: run.coinStreak });
  }

  /** Pulls coins toward the runner (Magnet perk or dash), collects the ones in reach, drops the ones behind. Mutates `run`. */
  function advanceCoins(run, dt, events) {
    const runner = run.runner;
    const chestY = runner.height + SCORING.chestHeight;
    const pullRadius = isDashing(run) ? PERK_RULES.dashMagnetRadius : run.magnetRadius;
    const pullFraction = Math.min(1, dt * PERK_RULES.magnetPullRate);
    let keptCount = 0;
    // Per-frame hot path over up to PACING.coinCapacity coins: index loop with in-place compaction, no allocation.
    for (let index = 0; index < run.coins.length; index++) {
      const coin = run.coins[index];
      const offsetX = runner.x - coin.x, offsetY = chestY - coin.y, offsetZ = run.distance - coin.distance;
      if (pullRadius > 0 && Math.hypot(offsetX, offsetY, offsetZ) < pullRadius) {
        coin.x += offsetX * pullFraction;
        coin.y += offsetY * pullFraction;
        coin.distance += offsetZ * pullFraction;
      }
      const metresPast = run.distance - coin.distance;
      const isInReach = Math.abs(metresPast) < SCORING.coinReachZ && Math.abs(coin.x - runner.x) < SCORING.coinReachX && Math.abs(coin.y - chestY) < SCORING.coinReachY;
      if (isInReach) collectCoin(run, coin, events);
      else if (metresPast <= PACING.despawnBehind) run.coins[keptCount++] = coin;
    }
    run.coins.length = keptCount;
  }

  /** Lays out patterns until the road is filled to the spawn horizon. Mutates `run`. */
  function spawnAhead(run, patternSource, random) {
    while (run.nextPatternAt - run.distance < PACING.spawnHorizon) {
      const pattern = patternSource.next(run.distance);
      if (!pattern) return; // an empty pool would otherwise loop for ever
      // The beat is measured at the speed the runner will have when it gets there, not the speed it has now.
      const beat = beatMetres(SPEED_BY_DISTANCE(run.nextPatternAt));
      const layout = layoutPattern(pattern, { startDistance: run.nextPatternAt, beat, isMirrored: random() < 0.5 });
      run.obstacles.push(...layout.obstacles);
      run.coins.push(...layout.coins.slice(0, Math.max(0, PACING.coinCapacity - run.coins.length)));
      if (layout.cue) run.cues.push(layout.cue);
      run.nextPatternAt = layout.endDistance + GAP_BEATS_BY_DISTANCE(layout.origin) * beat;
    }
  }

  /**
   * Puts a bank pad under each gate that is due one (every zone.padEvery-th gate), as soon as the gate is inside the
   * spawn horizon. The patterns up to there are already laid out by then, so the pad can avoid lanes where a
   * lane-blocking obstacle stands within PADS.clearance: banking should cost heat, not a guaranteed crash.
   */
  function spawnPads(run, random) {
    const gateIndex = run.nextPadGate, gateDistance = gateIndex * PACING.gateEvery;
    if (gateDistance - run.distance >= PACING.spawnHorizon) return;
    run.nextPadGate += 1;
    if (gateIndex % zoneAt(gateDistance).padEvery !== 0) return;
    const isLaneBlocked = (x) => run.obstacles.some((obstacle) => obstacle.x === x && OBSTACLE_TYPES[obstacle.type].blocksLane && Math.abs(obstacle.distance - gateDistance) < PADS.clearance);
    const freeLanes = LANE_X.filter((x) => !isLaneBlocked(x));
    const candidates = freeLanes.length ? freeLanes : LANE_X;
    run.pads.push({ distance: gateDistance, x: candidates[Math.floor(random() * candidates.length)], isDecided: false, isUsed: false });
  }

  /**
   * The bank-or-push decision. When the runner crosses a pad's line while standing in its lane, the pot is banked (plus
   * the build's bank bonus) and the heat resets to zero: safe coins now, at the price of the multiplier. Running past
   * in another lane keeps the heat and leaves the pot at risk.
   */
  function advancePads(run, events) {
    const pad = run.pads[0];
    if (!pad) return;
    if (run.distance - pad.distance > PACING.despawnBehind) {
      run.pads.shift();
      return;
    }
    if (pad.isDecided || run.distance < pad.distance) return;
    pad.isDecided = true; // the choice is made on the frame the line is crossed, never afterwards
    if (Math.abs(run.runner.x - pad.x) >= PADS.halfWidth || run.pot <= 0) return;
    const banked = run.pot * (1 + run.mods.bankBonus);
    Object.assign(run, { banked: run.banked + banked, banks: run.banks + 1, bestBank: Math.max(run.bestBank, banked), pot: 0, heat: 0, heatHoldSeconds: 0 });
    pad.isUsed = true;
    events.push({ type: 'bank', coins: Math.round(banked) });
  }

  /** Announces a new zone when the runner crosses into it. */
  function advanceZone(run, events) {
    const zone = zoneAt(run.distance);
    if (zone.id === run.zoneId) return;
    run.zoneId = zone.id;
    events.push({ type: 'zone', zone });
  }

  /** Announces the nearest teaching cue once it is PACING.cueLeadSeconds away and retires it when its row is reached. */
  function advanceCues(run, events) {
    const cue = run.cues[0];
    if (!cue) return;
    if (run.distance >= cue.distance) run.cues.shift();
    else if (!cue.isAnnounced && cue.distance - run.distance < run.speed * PACING.cueLeadSeconds) {
      cue.isAnnounced = true;
      events.push({ type: 'cue', text: cue.text });
    }
  }

  /**
   * Advances a run by one step and reports what happened. Mutates `run` in place (it is the per-frame hot path, so no
   * copy is made); everything it needs comes in through its arguments.
   * @param {Run} run
   * @param {number} dt seconds of game time
   * @param {{ patternSource?: { next: function(number): ?Pattern }, speedLimit?: number, random?: function(): number }} [options]
   *   patternSource: where new patterns come from (omit for an empty road); speedLimit: cap on the target speed in m/s;
   *   random: 0..1 source for mirroring patterns
   * @returns {RunEvent[]} events of this step, in the order they happened
   * @complexity O(obstacles + coins) time per step, both bounded by the spawn horizon (a few dozen obstacles, at most
   *   PACING.coinCapacity coins); no allocation beyond the small events array. Spawning a pad is O(obstacles), once per gate.
   */
  function advanceRun(run, dt, { patternSource = null, speedLimit = Infinity, random = Math.random } = {}) {
    const events = [];
    const targetSpeed = run.isCrashed ? 0 : Math.min(speedLimit, SPEED_BY_DISTANCE(run.distance) * (isDashing(run) ? PERK_RULES.dashSpeedBoost : 1));
    run.speed = damp(run.speed, targetSpeed, run.isCrashed ? PACING.stopResponse : PACING.speedResponse, dt);
    if (run.isCrashed) return events;

    run.distance += run.speed * dt;
    run.invulnerableSeconds = Math.max(0, run.invulnerableSeconds - dt);
    run.streakSecondsLeft -= dt;
    if (run.streakSecondsLeft <= 0) run.coinStreak = 0;

    // The frame the dash runs out: grant a grace period, because the runner is still far above normal speed and the
    // next row was laid out for a slower approach.
    const dashing = isDashing(run);
    if (run.wasDashing && !dashing) {
      run.invulnerableSeconds = Math.max(run.invulnerableSeconds, PERK_RULES.dashExitGraceSeconds);
      events.push({ type: 'dashEnd' });
    }
    run.wasDashing = dashing;

    if (patternSource) {
      spawnAhead(run, patternSource, random);
      spawnPads(run, random);
    }
    advanceHeat(run, dt);
    advanceZone(run, events);
    advanceCues(run, events);
    events.push(...advanceRunner(run.runner, dt));
    advanceObstacles(run, events);
    advanceCoins(run, dt, events);
    advancePads(run, events);
    if (run.distance >= run.nextGateAt) {
      run.nextGateAt += PACING.gateEvery;
      events.push({ type: 'gate' });
    }
    return events;
  }

  /** Moves coins saved by the first draft (a bare number under `bank`) into the wallet, once. */
  function migrateLegacyBank(save, wallet) {
    const legacyCoins = save.get(SAVE_KEYS.legacyBank, 0);
    if (typeof legacyCoins !== 'number' || legacyCoins <= 0) return;
    wallet.add(legacyCoins);
    save.set(SAVE_KEYS.legacyBank, 0);
  }

  /**
   * The player's permanent state, composed from Kit models: wallet -> perks -> stats <- runner type <- synergies, and a
   * profile whose achievements unlock perks and runner types. No DOM and no THREE, so the pacing simulation in
   * scratch/runner/pacing.js drives exactly the economy the game does.
   * @param {{ get: function(string, *=): *, set: function(string, *): * }} save ctx.save, or any in-memory store
   * @returns {Object} `{ stats, wallet, perks, profile, synergies, runnerType(), availablePerks(), availableRunners(),
   *   cycleRunner(), loadout(), bestDistance(), runsPlayed(), nextGoal(), finishRun(run) }`
   * @example
   * const career = createCareer(ctx.save);
   * const run = createRun(career.loadout());
   * const result = career.finishRun(run); // { metres, payout, isBest, achievements }
   */
  function createCareer(save) {
    const stats = Kit.stats(BASE_STATS);
    const wallet = Kit.wallet({ coins: 0 }, save);
    migrateLegacyBank(save, wallet);
    const perks = Kit.upgrades(PERKS, { stats, wallet, save, key: SAVE_KEYS.perks });
    const synergies = Kit.synergy(SYNERGIES, { stats });
    /** Achievements completed by the finishRun call in progress. */
    let freshAchievements = [];
    const profile = Kit.profile({ save, achievements: ACHIEVEMENTS, onAchievement: (row) => freshAchievements.push(row) });
    const isAvailable = (row) => !row.unlock || profile.isUnlocked(row.unlock);
    const availableRunners = () => RUNNERS.filter(isAvailable);
    let runnerType = availableRunners().find((candidate) => candidate.id === save.get(SAVE_KEYS.runner, RUNNERS[0].id)) || RUNNERS[0];
    /** Re-derives everything that depends on the build: the runner's own modifiers and which synergies its tags complete. */
    const refreshBuild = () => {
      stats.mod('runner', runnerType.mods);
      synergies.update([...perks.owned(), runnerType]);
    };
    perks.on(refreshBuild);
    refreshBuild();

    return {
      stats, wallet, perks, profile, synergies, availableRunners,
      runnerType: () => runnerType,
      availablePerks: () => PERKS.filter(isAvailable),
      /** Switches to the next unlocked runner type (wrapping round) and returns it. */
      cycleRunner() {
        const choices = availableRunners();
        runnerType = choices[(choices.indexOf(runnerType) + 1) % choices.length];
        save.set(SAVE_KEYS.runner, runnerType.id);
        refreshBuild();
        return runnerType;
      },
      /** The current value of every stat, as the loadout for createRun. */
      loadout: () => Object.keys(BASE_STATS).reduce((loadout, statName) => ({ ...loadout, [statName]: stats.get(statName) }), {}),
      bestDistance: () => save.get(SAVE_KEYS.best, 0),
      runsPlayed: () => save.get(SAVE_KEYS.runs, 0),
      /** The first achievement still open, with its progress, or null when all are done. */
      nextGoal: () => profile.achievements().find((entry) => !entry.done) || null,
      /**
       * Settles a finished run: pays it out, records the lifetime statistics and returns what changed.
       * @param {Run} run
       * @returns {{ metres: number, payout: number, isBest: boolean, achievements: Object[] }} achievements: rows completed by this run
       */
      finishRun(run) {
        freshAchievements = [];
        const metres = Math.floor(run.distance), payout = payoutOf(run);
        const isBest = metres > save.get(SAVE_KEYS.best, 0);
        if (isBest) save.set(SAVE_KEYS.best, metres);
        save.set(SAVE_KEYS.runs, save.get(SAVE_KEYS.runs, 0) + 1);
        wallet.add(payout);
        profile.best('bestDistance', metres);
        profile.best('bestMultiplier', heatMultiplier({ heat: run.bestHeat }));
        profile.best('bestBank', Math.floor(run.bestBank));
        [['closeCalls', run.nearMisses], ['tricks', run.tricks], ['banks', run.banks], ['coinsBanked', payout]]
          .filter(([, amount]) => amount > 0)
          .forEach(([statName, amount]) => profile.count(statName, amount));
        profile.endRun({ metres, payout });
        return { metres, payout, isBest, achievements: freshAchievements };
      },
    };
  }

  /** What an unlock id from ACHIEVEMENTS gives, in words: the perk or runner type it names. */
  const describeUnlock = (unlockId) => {
    const row = [...PERKS, ...RUNNERS].find((candidate) => candidate.unlock === unlockId);
    return row ? `${row.name} unlocked` : unlockId;
  };

  // =====================================================================================================================
  // CANVAS PAINTERS: (context2d, width, height) => void, for ctx.make.canvasTexture
  // =====================================================================================================================

  /** Fills vertical bars `thickness` px wide centred on each fraction of the width. */
  const fillBarsAt = (context, fractions, width, thickness, top, height) =>
    fractions.forEach((fraction) => context.fillRect(fraction * width - thickness / 2, top, thickness, height));

  /** One track tile (trackWidth x tileLength): lane dividers, a dash in the middle of each lane, a pink cross line. */
  const paintTrack = (context, width, height) => {
    context.fillStyle = '#130b30';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#7d6bff';
    fillBarsAt(context, [0.375, 0.625], width, 4, 0, height);
    context.fillStyle = '#3a2b86';
    fillBarsAt(context, [0.185, 0.5, 0.815], width, 3, height * 0.3, height * 0.4);
    context.fillStyle = '#ff5d9e';
    context.fillRect(0, 0, width, 5);
  };

  /** One cell of the magenta grid that runs to the horizon on both sides of the track. */
  const paintGrid = (context, width, height) => {
    context.fillStyle = '#0a0420';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#c0309a';
    context.fillRect(0, 0, width, 3);
    context.fillRect(0, 0, 3, height);
  };

  /** The setting sun: a yellow-to-pink disc with horizontal slits cut out of its lower half. */
  const paintSun = (context, width, height) => {
    const SLITS = 6;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    [[0.1, '#fff0a0'], [0.5, '#ff8a4a'], [0.9, '#ff2d95']].forEach(([stop, color]) => gradient.addColorStop(stop, color));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(width / 2, height / 2, width / 2 - 2, 0, Kit.math.TAU);
    context.fill();
    // destination-out erases: each slit is a little thicker than the one above it, like the classic outrun sun.
    context.globalCompositeOperation = 'destination-out';
    Array.from({ length: SLITS }, (_, slit) => context.fillRect(0, height * (0.5 + slit * 0.075), width, 3 + slit * 2.2));
  };

  /**
   * How to stroke one floor glyph around the point (0, y) on a 64 px wide strip: a strategy table keyed by
   * ObstacleType.glyph. Up and down are chevrons; cross is an X.
   * @type {Object<string, function(CanvasRenderingContext2D, number): void>}
   */
  const GLYPH_STROKES = {
    up: (context, y) => [[12, y + 13], [32, y - 11], [52, y + 13]].forEach(([x, pointY], index) => (index ? context.lineTo(x, pointY) : context.moveTo(x, pointY))),
    down: (context, y) => [[12, y - 11], [32, y + 13], [52, y - 11]].forEach(([x, pointY], index) => (index ? context.lineTo(x, pointY) : context.moveTo(x, pointY))),
    cross(context, y) {
      context.moveTo(15, y - 14);
      context.lineTo(49, y + 14);
      context.moveTo(49, y - 14);
      context.lineTo(15, y + 14);
    },
  };

  /** Painter for the strip of fading glyphs on the lane in front of an obstacle. The canvas top touches the obstacle. */
  const paintGlyphStrip = (glyph) => (context, width, height) => {
    const GLYPH_COUNT = 5, FIRST_Y = 30, STEP_Y = 49, FADE_PER_GLYPH = 0.19;
    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, 'rgba(255,255,255,.4)');
    wash.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
    Object.assign(context, { strokeStyle: '#fff', lineWidth: 8, lineCap: 'round', lineJoin: 'round' });
    Array.from({ length: GLYPH_COUNT }, (_, index) => {
      context.globalAlpha = 1 - index * FADE_PER_GLYPH; // the glyph nearest the obstacle is the brightest
      context.beginPath();
      GLYPH_STROKES[glyph](context, FIRST_Y + index * STEP_Y);
      context.stroke();
    });
  };

  /** The bank pad: a gold plate with BANK lettered along the lane (read from behind, so the text runs away from the runner). */
  const paintBankPad = (context, width, height) => {
    context.fillStyle = 'rgba(255, 193, 69, 0.55)';
    context.fillRect(0, 0, width, height);
    Object.assign(context, { strokeStyle: '#fff3c4', lineWidth: 6, fillStyle: '#2b0638', font: 'italic 900 54px sans-serif', textAlign: 'center', textBaseline: 'middle' });
    context.strokeRect(3, 3, width - 6, height - 6);
    context.fillText('BANK', width / 2, height / 2);
  };

  // =====================================================================================================================
  // THEME: a synthwave racing dashboard. Leaning plates, chrome italic numerals, sunset yellow on violet, no outlines.
  // =====================================================================================================================

  /** Ids of the garage buttons that are not perks. */
  const GARAGE_ACTIONS = { go: 'go', runner: 'runner', log: 'log' };

  /** Stat labels the game creates; the theme's stat component switches on them. */
  const STAT_LABELS = { distance: 'Dist', heat: 'Heat', coins: 'Coins' };

  /**
   * Custom stat markup, keyed by stat label. Each builder receives the kit's live value element and must place it.
   * @type {Object<string, function({ value: HTMLElement, h: Function }): HTMLElement>}
   */
  const STAT_BUILDERS = {
    // The odometer: a large chrome number, a segmented tach bar under it, and a foot line with speed and best distance.
    [STAT_LABELS.distance]({ value, h }) {
      const root = h('div', 'stat odometer');
      const main = h('div', 'odo-main');
      main.append(value, h('span', 'odo-unit', 'm'));
      const tach = h('div', 'tach');
      tach.append(h('i', 'tach-fill'));
      const foot = h('div', 'odo-foot');
      const speed = h('span');
      speed.append(h('em', 'speed-value', '0'), ' km/h');
      const best = h('span');
      best.append('best ', h('em', 'best-value', '0'), ' m');
      foot.append(speed, best);
      root.append(main, tach, foot);
      return root;
    },
    // The heat chip: the coin multiplier, the pot it is building, and a bar that empties as the heat's hold runs out.
    [STAT_LABELS.heat]({ value, h }) {
      const root = h('div', 'stat heat-chip');
      const pot = h('span', 'pot');
      pot.append('pot ', h('em', 'pot-value', '0'));
      root.append(value, pot, h('i', 'heat-hold'));
      return root;
    },
    // Coins as one chip: a CSS-drawn coin, the coins made safe this run (or the bank, in the garage) and a label.
    [STAT_LABELS.coins]({ value, h }) {
      const root = h('div', 'stat coin-chip');
      root.append(h('i', 'coin'), value, h('span', 'bank-label', 'safe'));
      return root;
    },
  };

  const THEME = {
    fonts: ['Racing Sans One', 'Kanit:ital,wght@1,500;1,700'],
    tokens: {
      '--display': '"Racing Sans One", "Kanit", Impact, "Arial Narrow", sans-serif',
      '--body': '"Kanit", "Trebuchet MS", system-ui, sans-serif',
      '--ink': '#fff3e0',
      '--dim': '#f7a8d0',
      '--panel': 'linear-gradient(100deg, rgba(64, 14, 92, 0.94), rgba(22, 7, 50, 0.94))',
      '--line': 'rgba(255, 93, 158, 0.5)',
      '--accent': '#ffc145',
      '--accent-ink': '#2b0638',
      '--accent-edge': '#ff2d95',
      '--scrim': 'linear-gradient(180deg, rgba(8, 2, 26, 0.3), rgba(46, 8, 70, 0.9))',
      '--radius': '0px',
      '--radius-lg': '0px',
      '--border': '0px',
      '--blur': '0px',
      '--floater': '#ffc145',
      // Tokens of this game's own: the two sunset colours, the cool counter-colour and how far plates lean.
      '--sun': '#ffc145',
      '--hot': '#ff2d95',
      '--cool': '#4de2c5',
      '--slant': '10px',
      '--chrome': 'linear-gradient(180deg, #ffffff 18%, #ffe08a 47%, #ff6fb1 53%, #ffd9ec 88%)',
    },
    layout: { stats: 'top-right', actions: 'bottom' },
    components: {
      stat: ({ label, value, h }) => (STAT_BUILDERS[label] ? STAT_BUILDERS[label]({ value, h }) : null),
      // Garage bays: a perk's button gets its colour and a CSS glyph; the "run" button is the big sun-yellow plate.
      action({ id, label, sub, h }) {
        const perk = PERK_BY_ID[id];
        if (!perk) {
          // 'go' is the run plate; 'runner' and 'log' are plain bays without a glyph.
          const button = h('button', id === GARAGE_ACTIONS.go ? 'action go' : 'action bay plain');
          button.append(label, sub);
          return button;
        }
        const button = h('button', 'action bay');
        button.style.setProperty('--c', perk.color);
        const text = h('div', 'bay-text');
        text.append(label, sub);
        button.append(h('i', 'bay-glyph ' + id), text);
        return button;
      },
    },
    css: `
      /* Every surface is a plate leaning forward, like the slanted type on a race car. */
      & .chip, & .hint, & .action, & .stat.coin-chip, & .stat.heat-chip, & .loadout span, & #modal .primary {
        clip-path: polygon(var(--slant) 0, 100% 0, calc(100% - var(--slant)) 100%, 0 100%);
      }
      & .chip { font-style: italic; padding: 0 15px; border-bottom: 2px solid var(--hot); }

      /* Dashboard cluster, top right: odometer over tach over coin chip. */
      & #stats { display: grid; grid-template-columns: auto auto; justify-content: end; justify-items: end; align-items: center; gap: 5px 4px; }
      & .stat.odometer { grid-column: 1 / -1; }
      /* Heat chip: hot-pink multiplier, the pot at risk, and a hold bar along the bottom edge. */
      & .stat.heat-chip { position: relative; flex-direction: row; align-items: baseline; gap: 6px; min-width: 0; padding: 4px 14px 5px 16px; }
      & .heat-chip b { font: italic 400 21px var(--display); color: #ff7ab8; }
      & .heat-chip .pot { font: italic 500 10px var(--body); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
      & .heat-chip .pot em { font-style: inherit; font-weight: 700; color: var(--ink); }
      & .heat-hold { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--hot); }
      & .stat.odometer { background: none; border: 0; padding: 0; min-width: 0; align-items: flex-end; gap: 3px; -webkit-backdrop-filter: none; backdrop-filter: none; }
      & .odo-main { display: flex; align-items: baseline; gap: 3px; }
      & .odometer b {
        font: italic 400 46px/0.95 var(--display); padding: 0 6px 0 2px;
        background: var(--chrome); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
        filter: drop-shadow(2px 3px 0 rgba(43, 6, 56, 0.95));
      }
      & .odometer .odo-unit { font: italic 700 15px var(--body); color: var(--sun); text-transform: uppercase; letter-spacing: 0; text-shadow: 1px 2px 0 #2b0638; }
      & .tach { width: 138px; height: 8px; background: rgba(20, 6, 46, 0.85); transform: skewX(-28deg); overflow: hidden; }
      & .tach-fill {
        display: block; width: 0; height: 100%;
        background: linear-gradient(90deg, var(--cool), var(--sun) 62%, var(--hot) 86%) 0 0 / 138px 100% no-repeat;
        -webkit-mask: repeating-linear-gradient(90deg, #000 0 6px, transparent 6px 8px); mask: repeating-linear-gradient(90deg, #000 0 6px, transparent 6px 8px);
      }
      & .odo-foot { display: flex; gap: 10px; }
      & .odo-foot span { font: italic 500 11px var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); text-shadow: 0 1px 3px #14062e; }
      & .odo-foot em { font-style: inherit; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }

      & .stat.coin-chip { flex-direction: row; align-items: center; gap: 6px; min-width: 0; padding: 4px 16px 4px 14px; border-bottom: 2px solid var(--sun); }
      & .coin-chip b { font: italic 400 21px var(--display); color: var(--sun); }
      & .coin-chip .bank-label { font: italic 500 10px var(--body); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
      /* The coin glyph: a gold disc with a rim, a highlight and a slot, drawn entirely in CSS. */
      & .coin {
        position: relative; flex: none; width: 17px; height: 17px; border-radius: 50%;
        background: radial-gradient(circle at 34% 30%, #fff6c9 0 16%, #ffc145 42%, #e08a00 100%);
        box-shadow: inset 0 0 0 2px #ffdf7e, inset 0 0 0 3px #b36a00, 0 0 7px rgba(255, 193, 69, 0.7);
      }
      & .coin::after { content: ''; position: absolute; left: 7.5px; top: 5px; width: 2px; height: 7px; border-radius: 1px; background: #8a4f00; }

      /* Perks fitted for this run, as small coloured plates under the back button. */
      & .loadout { align-self: flex-start; display: flex; gap: 4px; }
      & .loadout span { --c: var(--ink); background: var(--c); color: #1a0530; padding: 2px 11px 2px 10px; font: italic 700 10px var(--body); letter-spacing: 0.1em; text-transform: uppercase; }

      & .toast { max-width: 100%; font: italic 400 30px/1.05 var(--display); text-transform: uppercase; letter-spacing: 0.02em; color: #fff; text-shadow: 3px 3px 0 var(--hot), 0 0 18px rgba(255, 45, 149, 0.55); }
      & .floater { font: italic 400 22px var(--display); text-shadow: 2px 2px 0 #2b0638; }
      & .hint { border-radius: 0; padding: 7px 24px; background: var(--sun); color: var(--accent-ink); font: italic 700 13px var(--body); letter-spacing: 0.05em; text-transform: uppercase; }

      /* The crash banner is a race result card: chequered flag strip, chrome distance, a timing sheet with dashed rules. */
      & #modal .modal-card { gap: 8px; padding: 0 20px 20px; background: linear-gradient(180deg, #3d0d5a 0%, #14062e 72%); box-shadow: 0 0 0 2px var(--hot), 9px 9px 0 var(--sun); }
      & #modal .modal-card::before { content: ''; flex: none; height: 18px; margin: 0 -20px 8px; background: repeating-conic-gradient(#fff3e0 0 25%, #14062e 0 50%) 0 0 / 18px 18px; }
      & #modal h2 {
        font: italic 400 44px/1 var(--display); text-transform: uppercase; padding-right: 6px;
        background: var(--chrome); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
        filter: drop-shadow(2px 3px 0 rgba(20, 6, 46, 0.9));
      }
      & #modal .modal-card p { font: italic 500 13px var(--body); letter-spacing: 0.1em; text-transform: uppercase; color: var(--cool); }
      & #modal .rows { background: none; padding: 2px 0; gap: 0; }
      & #modal .rows div { align-items: baseline; padding: 6px 0; border-bottom: 1px dashed rgba(255, 93, 158, 0.5); }
      & #modal .rows span { font: italic 500 12px var(--body); letter-spacing: 0.1em; text-transform: uppercase; }
      & #modal .rows b { font: italic 400 21px var(--display); color: var(--sun); }
      & #modal .primary { margin-top: 8px; font: italic 400 24px var(--display); text-transform: uppercase; border-bottom: 4px solid var(--hot); }

      /* The garage: a sign over a stack of bays, one per perk, then the run plate. */
      & .garage-sign { margin-top: auto; align-self: stretch; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      & .garage-sign b { font: italic 400 34px/1 var(--display); text-transform: uppercase; color: #fff; text-shadow: 3px 3px 0 var(--hot); }
      & .garage-sign span { font: italic 500 11px var(--body); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); text-shadow: 0 1px 3px #14062e; }
      /* Bays sit two abreast so six of them and the run plate still leave the runner in view. */
      & #actions { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
      & .action.bay { --c: var(--ink); flex-direction: row; align-items: center; gap: 9px; text-align: left; padding: 7px 16px 7px 14px; border-bottom: 2px solid var(--line); }
      & .action.bay.plain { flex-direction: column; align-items: flex-start; gap: 0; }
      & .action.bay:not(:disabled) { border-bottom-color: var(--sun); }
      & .bay-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      & .bay b { font: italic 400 16px var(--display); text-transform: uppercase; color: var(--c); }
      & .bay span { font: 500 11px/1.25 var(--body); color: var(--ink); }
      /* Perk glyphs in CSS: a horseshoe magnet, a double chevron, a shield. */
      & .bay-glyph { flex: none; width: 20px; height: 20px; background: var(--c); }
      & .bay-glyph.vault { border-radius: 3px; box-shadow: inset 0 0 0 4px var(--c), inset 0 0 0 7px #2b0638; }
      & .bay-glyph.tyres { border-radius: 50%; box-shadow: inset 0 0 0 5px var(--c), inset 0 0 0 20px #2b0638; }
      & .bay-glyph.magnet { background: none; border: 5px solid var(--c); border-bottom-color: transparent; border-radius: 50%; transform: rotate(180deg); }
      & .bay-glyph.head { clip-path: polygon(0 0, 22% 0, 50% 50%, 22% 100%, 0 100%, 28% 50%, 0 0, 50% 0, 72% 0, 100% 50%, 72% 100%, 50% 100%, 78% 50%, 50% 0); }
      & .bay-glyph.shield { clip-path: polygon(50% 0, 100% 16%, 92% 64%, 50% 100%, 8% 64%, 0 16%); }
      & .action.go { grid-column: 1 / -1; flex-direction: row; justify-content: center; align-items: baseline; gap: 8px; padding: 11px; background: var(--sun); color: var(--accent-ink); border-bottom: 4px solid var(--hot); }
      & .go b { font: italic 400 25px var(--display); text-transform: uppercase; }
      & .go span { font: italic 700 13px var(--body); text-transform: uppercase; color: inherit; }
      /* Landscape is short: the bays sit side by side and drop their glyphs. */
      @media (orientation: landscape) {
        & #actions { grid-template-columns: repeat(4, 1fr); }
        & .action.bay { padding: 5px 14px; }
        & .bay-glyph { display: none; }
        & .garage-sign b { font-size: 22px; }
        & .action.go { grid-column: auto; padding: 6px; }
      }
      /* The logbook sheet (Kit.views lists inside ui.panel) takes the card's own look. */
      & #modal .sheet-body { gap: 12px; }
    `,
  };

  // =====================================================================================================================
  // PRESENTATION: builders that turn a Run into scene objects, HUD and feedback. Each returns a small object the
  // frame loop calls; none of them changes the simulation.
  // =====================================================================================================================

  /**
   * Builds the backdrop (grid, track, rails, sun, towers, distance gates, speed lines) as a handful of draw calls.
   * @param {Object} ctx the kit context
   * @returns {{ update(run: Run, dt: number): void }} call once per frame
   */
  function buildScenery(ctx) {
    const { make, THREE } = ctx;
    const layFlat = (width, length, material, y, z) => {
      const plane = make.mesh(new THREE.PlaneGeometry(width, length), material, { at: [0, y, z] });
      plane.rotation.x = -Math.PI / 2;
      plane.castShadow = false;
      return plane;
    };
    const tilesAlongRoad = SCENERY.roadLength / SCENERY.tileLength;
    const trackTexture = make.canvasTexture(256, 256, paintTrack, { repeat: [1, tilesAlongRoad], anisotropy: 8 });
    const gridTexture = make.canvasTexture(128, 128, paintGrid, { repeat: [SCENERY.gridWidth / SCENERY.tileLength, tilesAlongRoad], anisotropy: 8 });
    const gridMaterial = Object.assign(make.unlit(COLORS.white, { bright: 1.3, fresh: true }), { map: gridTexture });
    layFlat(SCENERY.gridWidth, SCENERY.roadLength, gridMaterial, SCENERY.gridDrop, SCENERY.roadCentreZ).receiveShadow = false;
    // The track texture doubles as its own emissive map, so the lane lines glow while the dark asphalt takes shadows.
    const trackMaterial = make.mat(COLORS.white, { rough: 0.45, metal: 0.2, emissive: COLORS.white, emissiveIntensity: 1.5, fresh: true });
    layFlat(SCENERY.trackWidth, SCENERY.roadLength, Object.assign(trackMaterial, { map: trackTexture, emissiveMap: trackTexture }), 0, SCENERY.roadCentreZ);
    [-SCENERY.railX, SCENERY.railX].forEach((x) => make.box(0.2, 0.22, SCENERY.roadLength, make.unlit(COLORS.cyan, { bright: 1.5 }), { at: [x, 0.11, SCENERY.roadCentreZ], shadow: false }));

    const sunMaterial = Object.assign(make.unlit(COLORS.white, { fresh: true }), { map: make.canvasTexture(256, 256, paintSun), transparent: true, fog: false, depthWrite: false });
    make.mesh(new THREE.PlaneGeometry(SCENERY.sunSize, SCENERY.sunSize), sunMaterial, { at: SCENERY.sunAt, shadow: false });
    make.glow(COLORS.sunGlow, SCENERY.sunGlowSize, { at: SCENERY.sunGlowAt, opacity: 0.4 });

    // Towers: two instanced unit boxes per tower slot (the dark body and one neon accent), recycled ahead as they pass.
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const towerBodies = make.instanced(unitBox, make.mat(COLORS.towerBody, { rough: 0.5, emissive: COLORS.towerGlow, emissiveIntensity: 0.3 }), SCENERY.towerCount);
    const towerNeons = make.instanced(unitBox, make.unlit(COLORS.white, { bright: 1.5 }), SCENERY.towerCount);
    /** Gives a tower slot a new random shape and neon colour (on creation and each time it is recycled). */
    const dressTower = (tower) => {
      Object.assign(tower, { x: tower.side * rand(8, 15), width: rand(2.2, 4.5), height: rand(4, 17), hasBand: Math.random() < 0.5 });
      towerNeons.setColorAt(tower.slot, make.color(pick(TOWER_NEON_COLORS)));
      towerNeons.instanceColor.needsUpdate = true;
      return tower;
    };
    // Slots alternate sides of the road; each pair shares a distance.
    const towers = Array.from({ length: SCENERY.towerCount }, (_, slot) =>
      dressTower({ slot, side: slot % 2 ? 1 : -1, distance: Math.floor(slot / 2) * SCENERY.towerSpacing + SCENERY.towerFirstAt })
    );
    const towerLoopLength = (SCENERY.towerCount / 2) * SCENERY.towerSpacing;

    const gates = [COLORS.cyan, COLORS.pink].map((color, index) => {
      const gate = make.group();
      const neon = make.unlit(color, { bright: 1.5 });
      [-SCENERY.gateHalfWidth, SCENERY.gateHalfWidth].forEach((x) => make.box(SCENERY.gateBeam, SCENERY.gateHeight, SCENERY.gateBeam, neon, { at: [x, SCENERY.gateHeight / 2, 0], parent: gate, shadow: false }));
      make.box(SCENERY.gateHalfWidth * 2 + SCENERY.gateBeam, SCENERY.gateBeam, SCENERY.gateBeam, neon, { at: [0, SCENERY.gateHeight, 0], parent: gate, shadow: false });
      gate.userData.distance = PACING.gateEvery * (index + 1);
      return gate;
    });

    const speedLineMaterial = make.unlit(COLORS.speedLine, { additive: true, opacity: 0, fresh: true });
    const speedLineMesh = make.instanced(unitBox, speedLineMaterial, SCENERY.speedLineCount);
    const speedLines = Array.from({ length: SCENERY.speedLineCount }, () => ({ x: 0, y: 0, z: PACING.despawnBehind })); // start "behind" so each respawns ahead

    return {
      update(run, dt) {
        const scroll = (run.distance / SCENERY.tileLength) % 1;
        trackTexture.offset.y = scroll;
        gridTexture.offset.y = scroll;
        // Per-frame hot paths below: plain forEach over small fixed arrays writing instance matrices, no allocation.
        towers.forEach((tower) => {
          if (run.distance - tower.distance > SCENERY.towerRecycleBehind) {
            tower.distance += towerLoopLength;
            dressTower(tower);
          }
          const z = run.distance - tower.distance;
          const baseY = tower.height / 2 + SCENERY.gridDrop;
          towerBodies.placeBox(tower.slot, tower.x, baseY, z, tower.width, tower.height, tower.width);
          // The accent is either a band round the top or a strip down the road-facing corner.
          if (tower.hasBand) towerNeons.placeBox(tower.slot, tower.x, tower.height * 0.8, z, tower.width + 0.15, 0.3, tower.width + 0.15);
          else towerNeons.placeBox(tower.slot, tower.x - tower.side * (tower.width / 2 + 0.05), baseY, z + tower.width / 2, 0.16, tower.height, 0.16);
        });
        towerBodies.commit();
        towerNeons.commit();
        gates.forEach((gate) => {
          gate.position.z = run.distance - gate.userData.distance;
          if (gate.position.z > PACING.despawnBehind) gate.userData.distance += PACING.gateEvery * gates.length;
        });
        speedLineMaterial.opacity = clamp((run.speed - SCENERY.speedLineFromSpeed) / SCENERY.speedLineFullAfter) * 0.6;
        speedLines.forEach((line, slot) => {
          line.z += run.speed * 2 * dt; // twice road speed: streaks in the air read faster than the ground
          if (line.z > 12) Object.assign(line, { x: (Math.random() < 0.5 ? -1 : 1) * rand(2.2, 7), y: rand(0.3, 6), z: rand(-70, -25) });
          speedLineMesh.placeBox(slot, line.x, line.y, line.z, 0.035, 0.035, 1.5 + run.speed * 0.22);
        });
        speedLineMesh.commit();
      },
    };
  }

  /**
   * Builds the runner: a bright suit with neon shoes, gloves, backpack and scarf so the limbs read from behind, plus
   * the landing marker, shield bubble and magnet ring that follow it.
   * @param {Object} ctx the kit context
   * @returns {{ root: THREE.Group, lean: number, squash: number, chest(run: Run): {x: number, y: number, z: number},
   *   pose(run: Run, dt: number, time: number): void, tumble(): void }}
   *   lean / squash are cosmetic springs the feedback layer may kick; pose() relaxes them every frame.
   */
  function buildRunnerModel(ctx) {
    const { make, THREE } = ctx;
    const root = make.group(), body = make.group({ parent: root });
    const suit = make.mat(COLORS.suit, { rough: 0.45, emissive: COLORS.cyan, emissiveIntensity: 0.2 });
    const cyanNeon = make.unlit(COLORS.cyan, { bright: 1.6 }), pinkNeon = make.unlit(COLORS.pink, { bright: 1.6 });
    /** A limb hangs from a pivot at its joint, so rotating the pivot swings it; `tip` is the neon shoe or glove. */
    const buildLimb = (x, jointY, thickness, length, tip) => {
      const pivot = make.group({ at: [x, jointY, 0], parent: body });
      make.box(thickness, length, thickness, suit, { at: [0, -length / 2, 0], parent: pivot });
      make.box(thickness + 0.05, 0.2, thickness + 0.12, tip, { at: [0, -length, 0], parent: pivot, shadow: false });
      return pivot;
    };
    make.box(0.64, 0.72, 0.38, suit, { at: [0, 1.18, 0], parent: body }); // torso
    make.box(0.36, 0.42, 0.14, cyanNeon, { at: [0, 1.22, 0.24], parent: body, shadow: false }); // backpack light, facing the camera
    make.sphere(0.27, suit, { at: [0, 1.8, 0], parent: body }); // head
    make.box(0.5, 0.1, 0.5, pinkNeon, { at: [0, 1.84, 0], parent: body, shadow: false }); // headband
    const legs = [-0.18, 0.18].map((x) => buildLimb(x, 0.82, 0.24, 0.72, cyanNeon));
    const arms = [-0.44, 0.44].map((x) => buildLimb(x, 1.5, 0.17, 0.56, pinkNeon));
    const scarfTails = [-0.09, 0.09].map((x) => {
      const pivot = make.group({ at: [x, 1.58, 0.18], parent: body });
      make.box(0.11, 0.04, 0.8, pinkNeon, { at: [0, 0, 0.4], parent: pivot, shadow: false });
      return pivot;
    });
    const landingMarker = make.cyl(0.75, 0.75, 0.02, make.unlit(COLORS.cyan, { additive: true, opacity: 0.28 }), { at: [0, 0.03, 0], shadow: false });
    const shieldBubble = make.sphere(1.3, make.unlit(COLORS.cyan, { additive: true, opacity: 0.22, bright: 1.4 }), { at: [0, 1, 0], parent: root, shadow: false });
    // A unit-radius ring on the floor, scaled to the magnet's reach so the pull distance is visible.
    const magnetRing = make.mesh(new THREE.RingGeometry(0.93, 1, 48), make.unlit(COLORS.gold, { additive: true, opacity: 0.55, bright: 1.6 }), { at: [0, 0.05, 0], shadow: false });
    magnetRing.rotation.x = -Math.PI / 2;
    magnetRing.material.side = THREE.DoubleSide;
    let stride = 0;
    /** Crash tumble: `amount` runs 0..1 over the throw, `roll` is the sideways spin (radians) picked for this crash. */
    const tumble = { amount: 0, roll: 0 };

    const model = {
      root,
      lean: 0,
      squash: 0,
      chest: (run) => ({ x: run.runner.x, y: run.runner.height + 1, z: 0 }),
      pose(run, dt, time) {
        const runner = run.runner;
        const airborne = isAirborne(runner), sliding = isSliding(runner);
        model.squash = damp(model.squash, 0, POSE.squashRecovery, dt);
        // Lean into the lane change in proportion to how far the body still has to travel.
        model.lean = damp(model.lean, clamp((LANE_X[runner.lane] - runner.x) * POSE.leanPerMetre, -POSE.maxLean, POSE.maxLean), POSE.leanRate, dt);
        stride += dt * run.speed * POSE.strideRate;
        const swing = airborne ? 0.9 : sliding ? 0.2 : Math.sin(stride);
        legs[0].rotation.x = swing;
        legs[1].rotation.x = airborne ? -0.5 : -swing;
        arms[0].rotation.x = airborne ? -2.4 : -swing * 0.9;
        arms[1].rotation.x = airborne ? -2.4 : swing * 0.9;
        scarfTails.forEach((tail, index) => {
          tail.rotation.x = Math.sin(time * 14 + index * 1.7) * 0.18 - 0.1;
          tail.rotation.y = model.lean * 1.2 + Math.sin(time * 9 + index) * 0.12;
        });
        // The crash tumble blends the root from its running transform (amount 0) to thrown back and spun (amount 1).
        // It only applies to a crashed run, so a tumble that is still finishing can never tip over the next run's runner.
        const tumbleAmount = run.isCrashed ? tumble.amount : 0;
        root.position.set(runner.x, lerp(runner.height, POSE.crashLift, tumbleAmount), POSE.crashThrowBack * tumbleAmount);
        root.rotation.set(POSE.crashSpin * tumbleAmount, 0, lerp(-model.lean, tumble.roll, tumbleAmount));
        if (!run.isCrashed) {
          body.rotation.x = damp(body.rotation.x, sliding ? POSE.slideTilt : airborne ? POSE.airTilt : POSE.runTilt, POSE.tiltRate, dt);
          body.position.y = damp(body.position.y, sliding ? POSE.slideDrop : Math.abs(Math.sin(stride)) * POSE.bounce, POSE.tiltRate, dt);
          body.scale.set(1 + model.squash * 0.22, 1 - model.squash * 0.3, 1 + model.squash * 0.22);
        }
        // Blink while obstacles pass through, so the grace period is visible.
        root.visible = run.isCrashed || run.invulnerableSeconds <= 0 || Math.floor(time * POSE.blinkHz) % 2 === 0;
        shieldBubble.visible = run.shieldsLeft > 0;
        shieldBubble.scale.setScalar(1 + Math.sin(time * 6) * 0.04);
        landingMarker.visible = !run.isCrashed;
        landingMarker.position.x = runner.x;
        landingMarker.scale.setScalar(Math.max(0.35, 1 - runner.height * 0.35)); // shrinks as the runner rises, like a shadow
        magnetRing.visible = run.magnetRadius > 0;
        magnetRing.position.x = runner.x;
        magnetRing.scale.setScalar(run.magnetRadius * (0.94 + Math.sin(time * 5) * 0.06));
        magnetRing.rotation.z = time;
      },
      /** Throws the runner back toward the camera, spinning. The tween runs on game time, so it plays in the crash slow motion. */
      tumble() {
        Object.assign(tumble, { amount: 0, roll: rand(-POSE.crashMaxRoll, POSE.crashMaxRoll) });
        ctx.tween(tumble, { amount: 1 }, POSE.crashSeconds, 'outCubic');
      },
    };
    return model;
  }

  /**
   * Builds the light trail: a tapering ribbon behind the feet that replays the recent lane and jump path.
   * @param {Object} ctx the kit context
   * @returns {{ update(run: Run): void, clear(): void }}
   */
  function buildTrail(ctx) {
    const { make, THREE } = ctx;
    const SEGMENTS = 12, SEGMENT_LENGTH = 0.36, START_BEHIND = 0.15, HALF_WIDTH = 0.2, LIFT = 0.06, HISTORY = 80, FLOATS_PER_SEGMENT = 6;
    const positions = new Float32Array(SEGMENTS * FLOATS_PER_SEGMENT);
    // Vertex colour fades the ribbon out toward its tail (the material is additive, so darker means more transparent).
    const fades = Array.from({ length: SEGMENTS }, (_, segment) => Math.pow(1 - segment / (SEGMENTS - 1), 1.5));
    const colors = new Float32Array(fades.flatMap((fade) => [fade, fade, fade, fade, fade, fade]));
    // Two vertices per segment (left, right); each pair of neighbouring segments is joined by two triangles.
    const indices = Array.from({ length: SEGMENTS - 1 }, (_, segment) => segment * 2).flatMap((first) => [first, first + 1, first + 2, first + 1, first + 3, first + 2]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const material = Object.assign(make.unlit(COLORS.cyan, { additive: true, bright: 1.7, fresh: true }), { vertexColors: true, side: THREE.DoubleSide });
    const ribbon = make.mesh(geometry, material, { shadow: false });
    ribbon.frustumCulled = false; // its vertices are rewritten every frame, so its bounding sphere is never right
    const tint = { run: make.color(COLORS.cyan).multiplyScalar(1.1), dash: make.color(COLORS.pink).multiplyScalar(1.8) };
    /** Where the runner was, newest first: { distance, x, height }. */
    let history = [];

    return {
      update(run) {
        ribbon.visible = !run.isCrashed;
        if (run.isCrashed) return;
        material.color.copy(isDashing(run) ? tint.dash : tint.run);
        history.unshift({ distance: run.distance, x: run.runner.x, height: run.runner.height });
        if (history.length > HISTORY) history.pop();
        // Per-frame hot path: for each segment a fixed distance behind the runner, find where the runner was when it was
        // that far back. `sample` only ever moves forward because both the segments and the history run newest to oldest.
        for (let segment = 0, sample = 0; segment < SEGMENTS; segment++) {
          const behind = START_BEHIND + segment * SEGMENT_LENGTH;
          const halfWidth = HALF_WIDTH * (1 - segment / SEGMENTS);
          while (sample < history.length - 1 && history[sample].distance > run.distance - behind) sample++;
          const past = history[sample];
          positions.set([past.x - halfWidth, past.height + LIFT, behind, past.x + halfWidth, past.height + LIFT, behind], segment * FLOATS_PER_SEGMENT);
        }
        geometry.attributes.position.needsUpdate = true;
      },
      clear() {
        history = [];
      },
    };
  }

  /**
   * Builds the obstacle meshes (pooled per type) and keeps one mesh on every obstacle of the run.
   * @param {Object} ctx the kit context
   * @returns {{ update(run: Run): void, clear(): void }}
   */
  function buildObstacleViews(ctx) {
    const { make, THREE } = ctx;
    const DECAL_LENGTH = 9, DECAL_WIDTH = 1.9, DECAL_LIFT = 0.04;
    const pools = Object.keys(OBSTACLE_TYPES).reduce((byType, typeId) => {
      const type = OBSTACLE_TYPES[typeId];
      const materials = {
        body: make.mat(type.color, { rough: 0.5, emissive: type.color, emissiveIntensity: 0.25 }),
        neon: make.unlit(type.color, { bright: 1.5 }),
        mark: make.unlit(COLORS.warningStripe, { bright: 1.3 }),
      };
      const decalMaterial = Object.assign(make.unlit(type.color, { additive: true, bright: 1.5, fresh: true }), { map: make.canvasTexture(64, 256, paintGlyphStrip(type.glyph)) });
      const buildMesh = () => {
        const group = make.group();
        type.parts.forEach(({ style, size, at, roll }) => {
          make.box(size[0], size[1], size[2], materials[style], { at, parent: group, shadow: style === 'body' }).rotation.z = roll;
        });
        // The glyph strip lies on the lane on the runner's side of the obstacle, so the required action is read early.
        const decal = make.mesh(new THREE.PlaneGeometry(DECAL_WIDTH, DECAL_LENGTH), decalMaterial, { at: [0, DECAL_LIFT, DECAL_LENGTH / 2 + 0.1 + type.depth / 2], parent: group, shadow: false });
        decal.rotation.x = -Math.PI / 2;
        return group;
      };
      return { ...byType, [typeId]: ctx.pool(buildMesh) };
    }, {});
    /** Mesh currently showing each live obstacle. */
    const meshByObstacle = new Map();
    const release = (obstacle, mesh) => {
      pools[obstacle.type].release(mesh);
      meshByObstacle.delete(obstacle);
    };

    return {
      update(run) {
        // Per-frame hot path (a few dozen obstacles at most): hand back the meshes of obstacles the simulation dropped...
        meshByObstacle.forEach((mesh, obstacle) => {
          if (obstacle.isGone) release(obstacle, mesh);
        });
        // ...then take a mesh for each new obstacle and slide all of them along the road.
        run.obstacles.forEach((obstacle) => {
          if (!meshByObstacle.has(obstacle)) meshByObstacle.set(obstacle, pools[obstacle.type].get());
          meshByObstacle.get(obstacle).position.set(obstacle.x, 0, run.distance - obstacle.distance);
        });
      },
      clear() {
        meshByObstacle.forEach((mesh, obstacle) => release(obstacle, mesh));
      },
    };
  }

  /**
   * Builds the coins as one instanced mesh redrawn from run.coins every frame.
   * @param {Object} ctx the kit context
   * @returns {{ update(run: Run, time: number): void }}
   */
  function buildCoinViews(ctx) {
    const { make, THREE } = ctx;
    const geometry = new THREE.CylinderGeometry(0.36, 0.36, 0.1, 14).rotateX(Math.PI / 2); // a disc standing on edge, facing the runner
    const mesh = make.instanced(geometry, make.mat(COLORS.coin, { rough: 0.3, metal: 0.4, emissive: COLORS.coinGlow, emissiveIntensity: 0.6 }), PACING.coinCapacity);
    return {
      update(run, time) {
        // Per-frame hot path: one matrix write per live coin. Bob and spin are offset by distance so a trail ripples.
        run.coins.forEach((coin, slot) => mesh.place(slot, coin.x, coin.y + Math.sin(time * 4 + coin.distance) * 0.06, run.distance - coin.distance, 1, time * 5 + coin.distance * 0.4));
        mesh.count = run.coins.length;
        mesh.commit();
      },
    };
  }

  /**
   * Builds the camera rig: a chase camera that widens with speed, or a low showroom angle for the garage.
   * @param {Object} ctx the kit context
   * @returns {{ chase(run: Run, lean: number, dt: number): void, showroom(dt: number): void }}
   */
  function buildCameraRig(ctx) {
    const { camera } = ctx;
    camera.position.set(0, CAMERA.height, CAMERA.startBack);
    const baseFov = () => (ctx.size.portrait ? CAMERA.portraitFov : CAMERA.landscapeFov);
    const setFov = (target, dt) => {
      camera.fov = damp(camera.fov, target, CAMERA.fovRate, dt);
      camera.updateProjectionMatrix();
    };
    return {
      chase(run, lean, dt) {
        const isPortrait = ctx.size.portrait;
        setFov(baseFov() + clamp((run.speed - CAMERA.speedFovFrom) / CAMERA.speedFovRange) * CAMERA.speedFovGain + (isDashing(run) ? CAMERA.dashFovGain : 0), dt);
        // Sit just far enough back that all three lanes fit across the screen, within sensible limits.
        const back = clamp(ctx.distanceForWidth(CAMERA.frameWidth, baseFov()), isPortrait ? CAMERA.minBackPortrait : CAMERA.minBackLandscape, CAMERA.maxBack);
        camera.position.set(
          damp(camera.position.x, run.runner.x * CAMERA.followX, CAMERA.rateX, dt),
          damp(camera.position.y, CAMERA.height + run.runner.height * CAMERA.heightPerJumpMetre, CAMERA.rateY, dt),
          damp(camera.position.z, run.isCrashed ? CAMERA.crashBack : back, CAMERA.rateZ, dt)
        );
        camera.lookAt(camera.position.x * CAMERA.lookAheadX, isPortrait ? CAMERA.lookYPortrait : CAMERA.lookYLandscape, CAMERA.lookZ);
        camera.rotation.z += lean * CAMERA.rollPerLean; // roll into lane changes
      },
      showroom(dt) {
        setFov(baseFov(), dt);
        const [x, y, z] = CAMERA.garageAt;
        camera.position.set(damp(camera.position.x, x, CAMERA.garageRate, dt), damp(camera.position.y, y, CAMERA.garageRate, dt), damp(camera.position.z, z, CAMERA.garageRate, dt));
        camera.lookAt(...CAMERA.garageLookAt);
      },
    };
  }

  /**
   * Builds the dashboard: odometer with tach and best distance, the heat chip (multiplier, pot, hold bar) and the coin chip.
   * The extra readouts live inside the theme's stat components; if another theme is swapped in (smoke --skin) they
   * are missing, so each lookup falls back to a detached element and the game keeps running with the plain stats.
   * @param {Object} ui ctx.ui
   * @returns {{ setDistance(metres: number): void, setBest(metres: number): void, setSpeed(speed: number): void,
   *   setHeat(run: Run): void, setSafe(coins: number): void, showSpendable(coins: number): void,
   *   pulseDistance(): void, pulseHeat(): void, pulseCoins(): void }}
   */
  function buildDashboard(ui) {
    const odometer = ui.stat(STAT_LABELS.distance, '0');
    const heatChip = ui.stat(STAT_LABELS.heat, 'x1.0');
    const coinChip = ui.stat(STAT_LABELS.coins, 0);
    const partOf = (stat, selector) => stat.el.querySelector(selector) || ui.h('span');
    const tachFill = partOf(odometer, '.tach-fill'), speedValue = partOf(odometer, '.speed-value'), bestValue = partOf(odometer, '.best-value');
    const potValue = partOf(heatChip, '.pot-value'), heatHold = partOf(heatChip, '.heat-hold'), bankLabel = partOf(coinChip, '.bank-label');
    /** Writes text only when it changed, so the DOM is not touched on every frame. */
    const setText = (element, text) => {
      if (element.textContent !== text) element.textContent = text;
    };
    /** Sets a bar's width in whole percent, only when the percent changed. */
    const percentSetter = (element) => {
      let shownPercent = -1;
      return (fraction) => {
        const percent = Math.round(clamp(fraction) * 100);
        if (percent === shownPercent) return;
        shownPercent = percent;
        element.style.width = percent + '%';
      };
    };
    const setTach = percentSetter(tachFill), setHold = percentSetter(heatHold);
    return {
      setDistance: (metres) => odometer.set(String(Math.floor(metres))),
      setBest: (metres) => setText(bestValue, String(Math.floor(metres))),
      setSpeed(speed) {
        setText(speedValue, String(Math.round(speed * TACH.kmhPerMs)));
        setTach((speed - TACH.from) / (TACH.to - TACH.from));
      },
      setHeat(run) {
        heatChip.set('x' + heatMultiplier(run).toFixed(1));
        setText(potValue, String(Math.floor(run.pot)));
        setHold(run.heat > 0 ? run.heatHoldSeconds / (HEAT.holdSeconds + run.mods.heatHold) : 0);
      },
      setSafe(coins) {
        coinChip.set(Math.floor(coins));
        setText(bankLabel, 'safe');
      },
      /** Garage mode: the chip shows the bank itself, labelled as money to spend. */
      showSpendable(coins) {
        coinChip.set(coins);
        setText(bankLabel, 'to spend');
      },
      pulseDistance: () => odometer.pulse(),
      pulseHeat: () => heatChip.pulse(),
      pulseCoins: () => coinChip.pulse(),
    };
  }

  /**
   * Builds the bank pads: a pooled gold plate and arch on the lane for every pad of the run that has not been used.
   * @param {Object} ctx the kit context
   * @returns {{ update(run: Run): void }}
   */
  function buildPadViews(ctx) {
    const { make, THREE } = ctx;
    const material = Object.assign(make.unlit(COLORS.white, { bright: 1.4, fresh: true }), { map: make.canvasTexture(128, 256, paintBankPad), transparent: true, depthWrite: false });
    const gold = make.unlit(COLORS.gold, { bright: 1.8 });
    const POST = 0.12;
    const pool = ctx.pool(() => {
      const pad = make.group();
      const plate = make.mesh(new THREE.PlaneGeometry(PADS.halfWidth * 2, PADS.length), material, { parent: pad, shadow: false });
      plate.rotation.x = -Math.PI / 2;
      // The arch: two posts at the lane's edges and a bar across, all inside the big distance gate.
      [-PADS.halfWidth, PADS.halfWidth].forEach((x) => make.box(POST, PADS.markerHeight, POST, gold, { at: [x, PADS.markerHeight / 2, 0], parent: pad, shadow: false }));
      make.box(PADS.halfWidth * 2 + POST, POST * 2, POST, gold, { at: [0, PADS.markerHeight, 0], parent: pad, shadow: false });
      return pad;
    });
    const plateByPad = new Map();
    return {
      update(run) {
        // Per-frame hot path over at most two pads: release plates of pads that were banked on or left the road...
        plateByPad.forEach((plate, pad) => {
          if (!pad.isUsed && run.pads.includes(pad)) return;
          pool.release(plate);
          plateByPad.delete(pad);
        });
        // ...and keep a plate on each pad still waiting.
        run.pads.filter((pad) => !pad.isUsed).forEach((pad) => {
          if (!plateByPad.has(pad)) plateByPad.set(pad, pool.get());
          plateByPad.get(pad).position.set(pad.x, 0.05, run.distance - pad.distance);
        });
      },
    };
  }

  /** Builds the bass pulse. @returns {{ update(run: Run, dt: number): void }} */
  function buildBassPulse(sfx) {
    let secondsToBeat = 0, beatIndex = 0;
    return {
      update(run, dt) {
        if (run.isCrashed) return;
        // The countdown runs faster at higher speed, so the tempo follows the run.
        secondsToBeat -= dt * (run.speed / BASS.referenceSpeed);
        if (secondsToBeat > 0) return;
        secondsToBeat += BASS.beatSeconds;
        sfx.tone({ freq: BASS.notes[beatIndex++ % BASS.notes.length], to: BASS.dropTo, dur: BASS.seconds, type: 'sine', vol: BASS.volume });
      },
    };
  }

  // =====================================================================================================================
  // THE GAME
  // =====================================================================================================================

  Kit.register({
    id: 'runner', name: 'Neon Run', tagline: 'Swipe to dodge, jump and slide', hook: 'Bank coins, buy perks, go further', color: '#4de2c5', order: 2,
    theme: THEME,
    /** The pure rules, for headless tools (scratch/runner/pacing.js): no ctx needed. */
    rules: { createRun, advanceRun, createPatternSource, createCareer, baseLoadout, payoutOf, heatMultiplier, isPatternFair, RUNNER_ACTIONS, LANE_X, PATTERNS: { intro: INTRO_PATTERNS, pool: POOL_PATTERNS }, PERKS, RUNNERS, ZONES },
    create(ctx) {
      const { make, input, fx, sfx, ui, save } = ctx;
      const stage = make.stage({ sky: ZONES[0].sky, fog: [45, 125], fogColor: COLORS.fog, ambient: 0.75, sun: [3, 14, 6], sunColor: COLORS.sunLight, sunIntensity: 1.1, shadow: 14 });
      stage.follow({ x: 0, y: 0, z: -6 });
      ctx.post.bloom(0.3, 0.5, 1.0); // only the neon accents (unlit, bright > 1) glow; bodies and the runner stay crisp

      const career = createCareer(save);
      const patternSource = createPatternSource(career.runsPlayed());
      /** The run being simulated and drawn. Replaced by an empty cruising run when the garage opens. */
      let run = createRun(career.loadout());

      // ---- views ----
      const scenery = buildScenery(ctx);
      const runnerModel = buildRunnerModel(ctx);
      const trail = buildTrail(ctx);
      const obstacleViews = buildObstacleViews(ctx);
      const coinViews = buildCoinViews(ctx);
      const padViews = buildPadViews(ctx);
      const cameraRig = buildCameraRig(ctx);
      const bassPulse = buildBassPulse(sfx);
      const dashboard = buildDashboard(ui);
      dashboard.setBest(career.bestDistance());
      const hint = ui.hint('Swipe left / right to dodge, up to jump, down to slide');
      const IDLE_HINT_SECONDS = 7;
      // The build for this run, top left: runner type, then owned perks, then the synergies they complete.
      const loadoutTags = ui.el('div', 'loadout');
      const addTag = (text, color) => loadoutTags.appendChild(ui.h('span', null, text)).style.setProperty('--c', color);
      if (career.runnerType() !== RUNNERS[0]) addTag(career.runnerType().name, '#fff3e0');
      career.perks.owned().forEach((perk) => addTag(`${perk.name} ${career.perks.level(perk.id)}`, perk.color));
      career.synergies.active().forEach((synergy) => addTag(synergy.name, '#c9a6ff'));

      // Until the player has banked once, the hint explains the gold pad while one is coming up.
      const hasNeverBanked = career.profile.stat('banks') === 0;
      let isPadHintShowing = false;
      const teachPad = () => {
        const pad = run.pads[0];
        const shouldShow = hasNeverBanked && !!pad && !pad.isDecided && pad.distance - run.distance < PADS.hintWithin;
        if (shouldShow === isPadHintShowing) return;
        isPadHintShowing = shouldShow;
        if (!shouldShow) return hint.hide();
        hint.set('Gold lane banks your pot and cools your heat');
        hint.show();
      };

      const gameTime = { gameTime: true };
      const aboveRunner = (lift) => ({ x: run.runner.x, y: run.runner.height + lift, z: 0 });
      /** Breaks an obstacle into shards flying up the road. */
      const shatter = (obstacle, shardCount) => {
        const type = OBSTACLE_TYPES[obstacle.type];
        fx.burst({ x: obstacle.x, y: (type.hurtFrom + type.hurtTo) / 2, z: 0 }, { count: shardCount, colors: [type.color, COLORS.white], speed: 9, size: 0.2, life: 0.7, dir: [0, 0.4, -1], spread: 1 });
      };
      /** The floater every trick gets: its name and what it paid at the current multiplier. */
      const announceTrick = ({ trick, coins }, color) => fx.floater(`${TRICKS[trick].label}  +${Math.round(coins * heatMultiplier(run))}`, aboveRunner(2.5), { color, ...gameTime });

      /**
       * Extra feedback per trick, keyed by trick id. Close calls get the slow-motion beat; the dash smash gets shards.
       * @type {Object<string, function(RunEvent): void>}
       */
      const TRICK_FEEDBACK = {
        closeCall(event) {
          fx.slowmo(0.4, 0.07, 0.22);
          announceTrick(event, '#ff7ab8');
          sfx.play('perfect');
        },
        slideJump(event) {
          announceTrick(event, '#4de2c5');
          sfx.play('up', { pitch: 1.3, vol: 0.6 });
        },
        diveSlide(event) {
          announceTrick(event, '#4de2c5');
          sfx.play('up', { pitch: 0.8, vol: 0.6 });
        },
        streak(event) {
          announceTrick(event, '#ffc145');
          sfx.play('up', { pitch: 1 + event.streak / 60, vol: 0.7 });
        },
        smash({ obstacle }) {
          shatter(obstacle, 22);
          fx.shake(0.35);
          sfx.play('hit', { pitch: rand(0.8, 1.2) });
        },
      };

      /**
       * What the player sees and hears for each simulation event: a strategy table keyed by RunEvent.type.
       * Every action answers on the frame it happens with a sound and a pose; the trail shows the move.
       * @type {Object<string, function(RunEvent): void>}
       */
      const FEEDBACK = {
        jump() {
          runnerModel.squash = POSE.jumpSquash;
          sfx.play('tap', { pitch: 1.3 });
        },
        slide() {
          runnerModel.squash = POSE.slideSquash;
          sfx.play('whoosh', { pitch: 0.6, vol: 0.9 });
        },
        laneChange: ({ direction }) => sfx.play('whoosh', { pitch: direction > 0 ? 1.2 : 0.95, vol: 0.8 }),
        bump({ direction }) {
          runnerModel.lean = -direction * POSE.bumpLean; // rock away from the rail
          sfx.play('click');
        },
        land() {
          runnerModel.squash = POSE.landSquash;
          sfx.play('thud', { vol: 0.35 });
        },
        coin({ x, y, streak }) {
          sfx.play('coin', { pitch: 1 + 0.06 * Math.min(streak - 1, 14), vol: 0.7 }); // the pitch climbs with the streak
          fx.burst({ x, y, z: 0 }, { count: 6, color: COLORS.coinSpark, speed: 3.5, size: 0.1, life: 0.35, gravity: 3 });
        },
        trick(event) {
          dashboard.pulseHeat();
          TRICK_FEEDBACK[event.trick](event);
        },
        bank({ coins }) {
          dashboard.pulseCoins();
          fx.flash('#ffc145', 200, 0.3);
          fx.floater(`Banked  +${coins}`, aboveRunner(2.5), { color: '#ffc145', size: 26, ...gameTime });
          sfx.play('win', { pitch: 1.1, vol: 0.6 });
        },
        zone({ zone }) {
          stage.setSky(zone.sky[0], zone.sky[1], COLORS.fog);
          ui.toast(zone.name, TOAST_MS.zone, gameTime);
          sfx.play('whoosh', { pitch: 0.4, vol: 0.9 });
        },
        shieldHit({ obstacle }) {
          shatter(obstacle, 36);
          fx.shake(0.6);
          fx.flash('#4de2c5', 220, 0.35);
          sfx.play('hit');
          ui.toast(run.shieldsLeft ? 'Shield hit' : 'Shield broken', TOAST_MS.shield, gameTime);
        },
        dashEnd: () => sfx.play('whoosh', { pitch: 0.5, vol: 0.7 }),
        gate() {
          dashboard.pulseDistance();
          sfx.play('whoosh', { pitch: 1.6, vol: 0.6 });
        },
        cue: ({ text }) => ui.toast(text, TOAST_MS.cue, gameTime),
        crash: ({ obstacle }) => phases.go('crashed', obstacle),
      };
      const playFeedback = (events) => events.forEach((event) => FEEDBACK[event.type](event));

      /**
       * Offers the result card, then the garage when there is something to do there (a perk to afford or a runner type
       * to pick), otherwise straight into the next run.
       * @param {{ metres: number, payout: number, isBest: boolean, achievements: Object[] }} result from career.finishRun
       * @param {{ banked: number, lost: number }} pot what the run had banked and what the crash cost
       */
      function showResultCard(result, pot) {
        const openPerks = career.availablePerks().filter((perk) => !career.perks.maxed(perk.id));
        const canBuy = openPerks.some((perk) => career.perks.canBuy(perk.id));
        const hasGarageBusiness = canBuy || result.achievements.some((row) => row.unlocks);
        const goal = career.nextGoal();
        const news = result.achievements.map((row) => (row.unlocks ? describeUnlock(row.unlocks) : `Done: ${row.text}`));
        const headline = [result.isBest ? 'New track record' : 'Wrecked', ...news].join('  /  ');
        ui.banner({
          title: `${result.metres} m`,
          text: goal ? `${headline}  /  Next: ${goal.row.text} (${Kit.fmt(Math.floor(goal.progress))} of ${Kit.fmt(goal.row.target)})` : headline,
          button: hasGarageBusiness ? 'To the garage' : 'Run again',
          stats: [['Banked on pads', Math.round(pot.banked)], ['Pot lost in the crash', Math.round(pot.lost)], ['Paid out', '+' + result.payout], ['Bank', career.wallet.get()]],
        }).then(() => (hasGarageBusiness ? phases.go('garage') : ctx.restart()));
      }

      /** Opens the logbook: lifetime goals with what they unlock, and the set bonuses with the tags still missing. */
      const openLogbook = () =>
        ui.panel({
          title: 'Logbook',
          build(body) {
            body.append(Kit.views.deeds(career.profile, { describeUnlock }).element, Kit.views.synergies(career.synergies).element);
          },
        });

      /**
       * Run phases. run: the simulation plays and feeds the dashboard. crashed: the hit plays out in slow motion, the
       * run is paid out, then the result card. garage: the runner jogs on an empty road behind the bays.
       */
      const phases = Kit.fsm({
        run: {
          update(dt) {
            playFeedback(advanceRun(run, dt, { patternSource }));
            dashboard.setDistance(run.distance);
            dashboard.setHeat(run);
            dashboard.setSafe(run.banked);
            if (run.distance > career.bestDistance()) dashboard.setBest(run.distance);
            // A player who never touches the screen still loses the hint after a while; any input hides it at once.
            if (phases.time > IDLE_HINT_SECONDS && !isPadHintShowing) hint.hide();
            teachPad();
          },
        },
        crashed: {
          enter(obstacle) {
            const pot = { banked: run.banked, lost: run.pot * (1 - HEAT.crashSalvage) };
            const result = career.finishRun(run);
            hint.hide();
            fx.hitstop(90);
            fx.slowmo(0.2, 0.35, 0.25);
            fx.shake(1);
            fx.flash('#ff3b4e', 320, 0.6);
            fx.burst(runnerModel.chest(run), { count: 70, colors: [COLORS.cyan, COLORS.pink, COLORS.white, OBSTACLE_TYPES[obstacle.type].color], speed: 10, size: 0.2, life: 1, floor: 0.05 });
            sfx.play('boom');
            sfx.play('lose');
            runnerModel.tumble();
            ctx.after(POSE.crashSeconds, () => showResultCard(result, pot));
          },
          update: (dt) => advanceRun(run, dt), // only brakes: a crashed run changes nothing else
        },
        garage: {
          enter() {
            // Compose the backdrop: clear the wreck and let the runner jog on an empty road wearing its build.
            obstacleViews.clear();
            trail.clear();
            // A fresh run that keeps rolling from where the road is, wearing the current build (no dash: the road is empty).
            const showBuild = () => (run = Object.assign(createRun({ ...career.loadout(), dash: 0 }), { distance: run.distance, speed: run.speed }));
            showBuild();
            dashboard.showSpendable(career.wallet.get());
            career.wallet.on(() => dashboard.showSpendable(career.wallet.get()));
            const sign = ui.el('div', 'garage-sign');
            const synergyLine = ui.h('span');
            /** Under the sign: the set bonuses the build has switched on, or the standing reminder when there are none. */
            const showSynergies = () => (synergyLine.textContent = career.synergies.active().map((synergy) => synergy.name).join(' + ') || 'Perks are permanent');
            sign.append(ui.h('b', null, 'Garage'), synergyLine);
            showSynergies();
            ui.shop(career.perks, {
              wallet: career.wallet,
              ids: career.availablePerks().map((perk) => perk.id),
              describe: true,
              // No callout here: the bay's own label changes, and two quick purchases would stack two toasts.
              onBuy(perk) {
                showBuild(); // the new shield bubble or magnet ring appears on the runner at once
                showSynergies();
                fx.burst(runnerModel.chest(run), { count: 30, color: perk.sparkColor, speed: 6, size: 0.14, life: 0.6 });
                dashboard.pulseCoins();
              },
            });
            const describeRunner = () => ({ label: career.runnerType().name, sub: career.runnerType().desc });
            const garageBar = ui.actions([
              {
                id: GARAGE_ACTIONS.runner,
                ...describeRunner(),
                onClick() {
                  career.cycleRunner();
                  garageBar.set(GARAGE_ACTIONS.runner, describeRunner());
                  showBuild();
                  showSynergies();
                },
              },
              { id: GARAGE_ACTIONS.log, label: 'Logbook', sub: 'goals and set bonuses', onClick: openLogbook },
              { id: GARAGE_ACTIONS.go, label: 'Run', sub: 'again', onClick: () => ctx.restart() },
            ]);
          },
          update: (dt) => advanceRun(run, dt, { speedLimit: GARAGE.cruiseSpeed }), // no pattern source: an empty road
        },
      }, 'run');

      // ---- input: a swipe is applied on the frame it arrives; a tap is a jump ----
      const act = (direction) => {
        if (!phases.is('run') || run.isCrashed) return;
        if (!isPadHintShowing) hint.hide();
        playFeedback(RUNNER_ACTIONS[direction](run.runner));
      };
      input.onSwipe(act);
      input.onTap(() => act('up'));

      if (run.dashLength > 0) {
        ui.toast('Head start', TOAST_MS.perk, gameTime);
        sfx.play('win', { pitch: 1.2, vol: 0.6 });
      }

      /** Test hook for the scripted playtests in scratch/runner: a plain snapshot of the run. */
      ctx.debug = {
        state: () => ({
          dist: run.distance, speed: run.speed, lane: run.runner.lane, py: run.runner.height, coins: run.coinsCollected, bank: career.wallet.get(),
          phase: phases.state, dead: run.isCrashed, shields: run.shieldsLeft, nearMisses: run.nearMisses,
          heat: run.heat, pot: run.pot, banked: run.banked, pads: run.pads.map((pad) => ({ lane: LANE_X.indexOf(pad.x), z: run.distance - pad.distance, used: pad.isUsed })),
          dashing: isDashing(run), invulnerable: run.invulnerableSeconds > 0, patterns: patternSource.served,
          obstacles: run.obstacles.map((obstacle) => ({ type: obstacle.type, lane: LANE_X.indexOf(obstacle.x), z: run.distance - obstacle.distance })),
        }),
      };

      return {
        update(dt, time) {
          phases.update(dt); // simulate first...
          // ...then draw the result. Nothing below changes the run.
          runnerModel.pose(run, dt, time);
          trail.update(run);
          scenery.update(run, dt);
          obstacleViews.update(run);
          coinViews.update(run, time);
          padViews.update(run);
          if (phases.is('garage')) cameraRig.showroom(dt);
          else cameraRig.chase(run, runnerModel.lean, dt);
          bassPulse.update(run, dt);
          dashboard.setSpeed(run.speed);
        },
      };
    },
  });
})();
