// Tower Smash data: every tunable, piece of content and pure rule of the game. No DOM, no THREE, no cannon: it runs in
// node (scratch/sling/solve.js reads it to prove levels clearable and to simulate the progression curve).
//
// Owns: the stage and aim constants, block materials, ball types, level layouts, worlds, the level generator and its
// difficulty rating, the star rules, unlocks, upgrades and the daily challenge recipe.
// Does not own: the physics of a shot (games/sling-sim.js), or anything seen or heard (games/sling.js).
// Exposed as the global TOWER_SMASH_DATA.
(() => {
  const { clamp, lerp } = Kit.math;

  // ================================================ stage and aiming ================================================

  /** @typedef {{ x: number, y: number, z: number }} Vector World-space point, velocity or acceleration (metres, seconds). */
  /** @typedef {[number, number, number]} Size Full width, height and depth of a box. */

  /** The stage: gravity, the tight platform the tower stands on (a shoved block falls off it) and where balls launch from. */
  const WORLD = {
    gravity: -20,
    solverIterations: 16, // tall stacks sag visibly on wake-up with cannon's default of 8
    friction: 0.5,
    restitution: 0.1,
    platform: { z: -6, top: 0.8, halfWidth: 3.5, halfDepth: 1.6 },
    launchPoint: { x: 0, y: 1.35, z: 2.4 },
    offPlatformDrop: 0.15, // a gem this far below the platform top has left it for good
  };

  /**
   * Aiming. Dragging down adds power: speed and loft rise together, so the hit point climbs the tower with one gesture.
   * Dragging sideways turns the shot. `speed` and `loft` are [at no pull, at full pull].
   */
  const AIM = {
    maxDragPixels: 180, // a comfortable thumb travel on a phone
    minPull: 0.12, // below this a release is a cancelled shot, not a dribble
    maxYaw: 0.45, // radians either side
    speed: [14, 28], // metres per second
    loft: [0.16, 0.62], // radians above the horizon
  };

  /** The flight preview: one physics step per sample, stopped at the first obstacle. */
  const PREVIEW = { step: 1 / 60, maxSteps: 108, clearance: 0.9 };

  /**
   * When a shot is over. A ball is "spent" `linger` seconds after its first contact or once it leaves the play area.
   * A ball-on-block contact faster than `hardHitSpeed` (m/s) counts as a real impact (debris, the first-impact moment).
   */
  const FLIGHT = { linger: 1.1, idleGrace: 0.3, maxSeconds: 5, farZ: -30, sideX: 20, spentDamping: 0.35, hardHitSpeed: 6 };

  /** After a shot, the rubble counts as settled once every block is slower than `calmSpeed` (or `maxSeconds` pass). */
  const SETTLE = { calmSpeed: 0.4, minSeconds: 0.5, maxSeconds: 4 };

  /** Sleeping, damped block bodies: towers stay perfectly still until hit and rubble settles instead of jittering. */
  const BLOCK_BODY = { linearDamping: 0.05, angularDamping: 0.15, sleepSpeedLimit: 0.4 };

  /** Removing or blasting a block: what rests within `reach` sideways and no more than `below` under it must be woken. */
  const WAKE = { reach: 3.2, below: 0.7 };

  /** Seconds between a blast and the kegs it sets off, so a chain reaction reads as a sequence. */
  const CHAIN_FUSE = 0.12;

  /**
   * How pairs of surfaces bounce (restitution; anything not listed uses WORLD.restitution). Bumpers are what make bank
   * shots possible; the rubber ball springs off everything.
   */
  const BOUNCE = [
    { ball: 'ball', scenery: 'bumper', restitution: 0.85 },
    { ball: 'rubber', scenery: 'solid', restitution: 0.72 },
    { ball: 'rubber', scenery: 'bumper', restitution: 0.9 },
  ];

  // ==================================================== materials ====================================================

  const PALETTE = [0x5ec8ff, 0xffc145, 0x7cf0a8, 0xffa07a, 0xb69cff];
  const COLORS = { gem: 0xff4fa3, crystal: 0x7af7ff, glass: 0xd9f6ff, keg: 0xff8a1f, stone: 0x8d93a6, bumper: 0xa6ff4d };

  /**
   * @typedef {object} BlockMaterial What a block is made of.
   * @property {string} id
   * @property {string} name Shown in hints.
   * @property {number} density Mass multiplier on top of the level's density. 0 with `isStatic` (it never moves).
   * @property {number} breakSpeed Contact speed (m/s, times the ball's breakPower) above which it breaks; Infinity never.
   * @property {'score' | 'shatter' | 'blast' | null} onBreak What breaking does (the simulation's BREAK_RULES).
   * @property {boolean} [isTarget] Must be broken to clear the level; also breaks when it leaves the platform.
   * @property {number} [points] Score for breaking it (multiplied by the shot's chain).
   * @property {{ radius: number, kick: number, lift: number, spin: number }} [blast] For onBreak 'blast'.
   * @property {number} [blastScale] Share of a blast's push it feels (default 1). Stone shrugs most of it off.
   * @property {boolean} [isBlastProof] A blast pushes it but cannot break it.
   * @property {boolean} [isStatic] Fixed in place: a wall or a bumper.
   * @property {'solid' | 'bumper'} [surface] Which BOUNCE rows apply (default 'solid').
   * @property {number} [color] Fixed colour; bricks omit it and cycle PALETTE.
   */
  /**
   * Block materials. Every break of any kind adds one to the shot's chain, so the order things break in is worth
   * points. Counters: stone is too heavy for anything but the heavy ball and feels a third of a blast; crystal cannot
   * be blasted and needs a hard direct hit or a fall; glass and kegs reward fast, light, spread-out shots.
   * @type {BlockMaterial[] & { byId(id: string): BlockMaterial }}
   */
  const MATERIALS = Kit.table([
    { id: 'brick', name: 'Brick', density: 1, breakSpeed: Infinity, onBreak: null },
    { id: 'glass', name: 'Glass', density: 0.5, breakSpeed: 6, onBreak: 'shatter', color: COLORS.glass },
    { id: 'keg', name: 'Powder keg', density: 0.8, breakSpeed: 5, onBreak: 'blast', blast: { radius: 3, kick: 17, lift: 0.3, spin: 6 }, color: COLORS.keg },
    { id: 'gem', name: 'Gem', density: 1, breakSpeed: 4.5, onBreak: 'score', isTarget: true, points: 100, color: COLORS.gem },
    { id: 'stone', name: 'Stone', density: 2.6, breakSpeed: Infinity, onBreak: null, blastScale: 0.35, color: COLORS.stone },
    { id: 'crystal', name: 'Crystal', density: 1.2, breakSpeed: 14, onBreak: 'score', isTarget: true, isBlastProof: true, points: 150, color: COLORS.crystal },
    { id: 'bumper', name: 'Bumper', density: 0, breakSpeed: Infinity, onBreak: null, isStatic: true, surface: 'bumper', color: COLORS.bumper },
  ]);

  // ====================================================== balls ======================================================

  /**
   * @typedef {object} BallType
   * @property {string} id
   * @property {string} name
   * @property {string} description
   * @property {string} versus One line on what it is good and bad against (shown on the loadout card).
   * @property {number} cost Loadout points one of these takes.
   * @property {number} unlockStars Total stars at which it joins the collection (0 = from the start).
   * @property {number} radius Metres.
   * @property {number} mass
   * @property {string} [massStat] Upgrade stat that multiplies the mass.
   * @property {number} breakPower Multiplier on its contact speed when testing a block's breakSpeed.
   * @property {'ball' | 'rubber'} surface Which BOUNCE rows apply.
   * @property {number} linger Seconds it stays live after its first contact (FLIGHT.linger unless it keeps bouncing).
   * @property {number} color
   * @property {number} emissive
   * @property {number} trail Particle colour of its trail.
   * @property {{ kind: 'split' | 'slam' | 'detonate', needsStat?: string, prompt: string }} [ability] What a tap in flight
   *   does (the simulation's ABILITIES); `needsStat` names the upgrade stat that must be above zero to have it.
   * @property {{ spread: number, fanLift: number, scale: number, massShare: number, autoDistance: number }} [split]
   *   Fan geometry for 'split': fragments `spread` radians apart (outer ones lifted `fanLift` m/s per radian), each
   *   `scale` of the radius and `massShare` of the mass. Untapped, it splits `autoDistance` metres before the tower.
   * @property {{ radius: number, kick: number, lift: number, spin: number }} [blast] Explodes on first contact.
   * @property {{ speed: number }} [slam] Downward speed (m/s) of 'slam'.
   */
  /** @type {BallType[] & { byId(id: string): BallType }} */
  const BALLS = Kit.table([
    { id: 'heavy', name: 'Heavy ball', description: 'Dense iron. Plows straight through.', versus: 'The only ball that shifts stone.', cost: 1, unlockStars: 0, radius: 0.6, mass: 6, breakPower: 1, surface: 'ball', linger: FLIGHT.linger, color: 0x5d6480, emissive: 0x10131f, trail: 0x8f7ae0, massStat: 'heavyMass', ability: { kind: 'slam', needsStat: 'slam', prompt: 'Tap to slam' }, slam: { speed: 26 } },
    { id: 'splitter', name: 'Splitter', description: 'Tap in flight to fan out.', versus: 'Sweeps glass and gems. Bounces off stone and crystal.', cost: 2, unlockStars: 2, radius: 0.5, mass: 4, breakPower: 0.6, surface: 'ball', linger: FLIGHT.linger, color: 0x4de2c5, emissive: 0x0f7a66, trail: 0x4de2c5, ability: { kind: 'split', prompt: 'Tap to split' }, split: { spread: 0.17, fanLift: 4, scale: 0.74, massShare: 0.6, autoDistance: 3.4 } },
    { id: 'bomb', name: 'Bomb', description: 'Explodes on first contact.', versus: 'Wrecks brick and lights kegs. Stone shrugs, crystal survives.', cost: 3, unlockStars: 8, radius: 0.55, mass: 3, breakPower: 1, surface: 'ball', linger: FLIGHT.linger, color: 0xff6a4d, emissive: 0xb02a08, trail: 0xffc145, ability: { kind: 'detonate', needsStat: 'trigger', prompt: 'Tap to detonate' }, blast: { radius: 2.8, kick: 16, lift: 0.3, spin: 6 } },
    { id: 'bouncer', name: 'Bouncer', description: 'Rubber. Keeps ricocheting.', versus: 'Cracks crystal and reaches round corners. Too light for walls.', cost: 2, unlockStars: 16, radius: 0.5, mass: 2.5, breakPower: 1.3, surface: 'rubber', linger: 2.6, color: 0xb6f23c, emissive: 0x3d6b00, trail: 0xd8ff7a },
  ]);

  /** Upgrade-driven numbers the simulation reads through `stat(name)`; base values are a new player's. */
  const STATS_BASE = { heavyMass: 1, splitCount: 3, splitMass: 1, blastRadius: 1, slam: 0, trigger: 0, bonusBudget: 0, shardBonus: 1 };

  /**
   * Workshop upgrades, bought with shards (Kit.upgrades rows). The ones that matter most add a tap ability, which
   * changes how a ball is played, not just how hard it hits.
   */
  const UPGRADES = [
    { id: 'dense', name: 'Dense core', desc: 'Heavy ball: +15% mass per level.', ball: 'heavy', max: 3, cost: { base: 15, growth: 1.8 }, currency: 'shards', mods: { heavyMass: { mul: 1.15 } } },
    { id: 'slam', name: 'Slam', desc: 'Heavy ball: tap in flight to dive straight down.', ball: 'heavy', max: 1, cost: 40, currency: 'shards', requires: 'dense', mods: { slam: { add: 1 } } },
    { id: 'cluster', name: 'Cluster', desc: 'Splitter: fans into five instead of three.', ball: 'splitter', max: 1, cost: 35, currency: 'shards', mods: { splitCount: { add: 2 } } },
    { id: 'powder', name: 'Extra powder', desc: 'Bomb: +12% blast radius per level.', ball: 'bomb', max: 2, cost: { base: 30, growth: 2 }, currency: 'shards', mods: { blastRadius: { mul: 1.12 } } },
    { id: 'trigger', name: 'Trigger', desc: 'Bomb: tap in flight to detonate early.', ball: 'bomb', max: 1, cost: 50, currency: 'shards', requires: 'powder', mods: { trigger: { add: 1 } } },
    { id: 'weighted', name: 'Weighted shards', desc: 'Splitter: fragments keep 15% more mass per level.', ball: 'splitter', max: 2, cost: { base: 30, growth: 2 }, currency: 'shards', requires: 'cluster', mods: { splitMass: { mul: 1.15 } } },
    { id: 'pouch', name: 'Deeper pouch', desc: '+1 loadout point on every level.', max: 2, cost: { base: 60, growth: 2.5 }, currency: 'shards', mods: { bonusBudget: { add: 1 } } },
    { id: 'salvage', name: 'Salvage', desc: '+20% shards from every tower per level.', max: 3, cost: { base: 25, growth: 2.2 }, currency: 'shards', mods: { shardBonus: { mul: 1.2 } } },
  ];

  // ================================================== level layouts ==================================================

  /** @typedef {{ x: number, y: number, z: number, size: Size, materialId: string }} BlockSpec Centre relative to the platform top centre. */

  const SHAPES = { brick: [1.1, 0.7, 1], halfBrick: [0.54, 0.7, 1], post: [0.9, 0.8, 1], cube: [0.8, 0.8, 0.8], lintel: [4.6, 0.4, 1], beam: [2.2, 0.6, 0.9], slab: [1.3, 1.1, 0.3], backboard: [2.6, 2.6, 0.3] };
  /** Hairline gaps keep neighbouring boxes from starting in contact overlap, which makes cannon push them apart at wake-up. */
  const STACK_GAP = 0.001;
  const ROW_GAP = 0.02;

  /**
   * One block resting with its underside at `baseY`.
   * @param {number} x @param {number} baseY @param {number} z @param {Size} size @param {string} [materialId]
   * @returns {BlockSpec}
   */
  const piece = (x, baseY, z, size, materialId = 'brick') => ({ x, y: baseY + size[1] / 2, z, size, materialId });
  /** Height of `count` stacked blocks of `size` (the base height of the next one up). */
  const stackHeight = (size, count) => count * (size[1] + STACK_GAP);
  /** `count` blocks side by side, centred on x = 0. */
  const row = (baseY, count, size, materialId) => Array.from({ length: count }, (_, index) => piece((index - (count - 1) / 2) * (size[0] + ROW_GAP), baseY, 0, size, materialId));
  /** `count` blocks stacked at x; `materialIds[index]` overrides brick for that storey. */
  const column = (x, count, size, materialIds = []) => Array.from({ length: count }, (_, index) => piece(x, stackHeight(size, index), 0, size, materialIds[index]));
  /** A target cube resting at `baseY`. */
  const gem = (x, baseY, materialId = 'gem', z = 0) => piece(x, baseY, z, SHAPES.cube, materialId);
  /**
   * A powder keg raised on a post with a gem balanced on top. The post matters: a ball is wider than a keg is tall, so a
   * keg standing on the platform can only be clipped after the ball has already hit the platform edge.
   */
  const kegStand = (x, targetId = 'gem') => [
    piece(x, 0, 0, SHAPES.post),
    piece(x, stackHeight(SHAPES.post, 1), 0, SHAPES.cube, 'keg'),
    gem(x, stackHeight(SHAPES.post, 1) + stackHeight(SHAPES.cube, 1), targetId),
  ];
  /**
   * Log-cabin tower: pairs of beams, each storey turned a quarter turn. The +x beam of storey `gemStorey` is a gem.
   * @param {number} storeys @param {Size} size @param {number} offset Distance of each beam from the centre line. @param {number} gemStorey
   * @returns {BlockSpec[]}
   */
  const crib = (storeys, size, offset, gemStorey) =>
    Array.from({ length: storeys }, (_, storey) =>
      [-1, 1].map((side) => {
        const baseY = stackHeight(size, storey);
        const isCrosswise = storey % 2 === 1;
        if (!isCrosswise) return piece(0, baseY, side * offset, size);
        return piece(side * offset, baseY, 0, [size[2], size[1], size[0]], storey === gemStorey && side > 0 ? 'gem' : 'brick');
      })
    ).flat();
  /**
   * A target behind a stone slab with a bumper backboard behind it: bank a ball off the board, lob over the slab, or
   * topple the slab onto the target. The slab is lower than the target's marker, so the player can see what it hides.
   */
  const shieldedGem = (x, targetId = 'gem') => [
    piece(x, 0, 1.0, SHAPES.slab, 'stone'),
    gem(x, 0, targetId, -0.1),
    piece(x, 0, -1.3, SHAPES.backboard, 'bumper'),
  ];
  /** Shift a group of blocks sideways. */
  const shifted = (blocks, offsetX) => blocks.map((block) => ({ ...block, x: block.x + offsetX }));

  const { brick, halfBrick, post, lintel, beam } = SHAPES;

  /**
   * @typedef {object} LevelLayout A hand-made level before shots and budget are derived from its rating.
   * @property {string} id
   * @property {string} name
   * @property {string} ask The one question the level asks (shown as its opening toast).
   * @property {BlockSpec[]} blocks
   * @property {number} [windX] Sideways wind on balls, m/s squared (positive pushes toward +x).
   * @property {number} [shots] Overrides the shots derived from the rating (the opening level is deliberately generous).
   */
  /** @type {Record<string, LevelLayout[]>} Hand-made levels per world: each introduces at most one new idea. */
  const HAND_LEVELS = {
    toybox: [
      { id: 'wall', name: 'The Wall', ask: 'Smash the glowing gems', shots: 4, blocks: [...row(0, 5, brick), ...row(stackHeight(brick, 1), 4, brick), piece(-2.52, stackHeight(brick, 1), 0, halfBrick), piece(2.52, stackHeight(brick, 1), 0, halfBrick), ...row(stackHeight(brick, 2), 5, brick), ...[-2.24, 0, 2.24].map((x) => gem(x, stackHeight(brick, 3)))] },
      { id: 'gate', name: 'The Gate', ask: 'Glass shatters: drop the roof', blocks: [...column(-1.7, 3, post, ['brick', 'brick', 'glass']), ...column(1.7, 3, post, ['brick', 'brick', 'glass']), piece(0, stackHeight(post, 3), 0, lintel), gem(-1.1, stackHeight(post, 3) + lintel[1] + STACK_GAP), gem(1.1, stackHeight(post, 3) + lintel[1] + STACK_GAP), gem(0, 0)] },
      { id: 'twins', name: 'Twin Towers', ask: 'Kegs blow: start a chain', blocks: [...column(-2.5, 3, post), ...column(-1.58, 3, post), gem(-2.04, stackHeight(post, 3)), ...column(1.4, 6, post), ...column(2.32, 6, post), gem(1.86, stackHeight(post, 6)), ...kegStand(-0.1)] },
      { id: 'spire', name: 'The Spire', ask: 'Bring it all down', blocks: [...crib(8, beam, 0.55, 3), gem(0, stackHeight(beam, 8)), ...kegStand(-1.95), ...column(2.7, 1, post), gem(2.7, stackHeight(post, 1))] },
    ],
    quarry: [
      { id: 'ramparts', name: 'Ramparts', ask: 'Stone only moves for iron', blocks: [...row(0, 4, brick, 'stone'), ...row(stackHeight(brick, 1), 3, brick), ...[-1.12, 1.12].map((x) => gem(x, stackHeight(brick, 2))), gem(0, stackHeight(brick, 2), 'gem')] },
      { id: 'backboard', name: 'Backboard', ask: 'Bank it off the green board', blocks: [...shieldedGem(-1.6), ...shifted(column(0, 3, post), 1.5), gem(1.5, stackHeight(post, 3))] },
    ],
    ridge: [
      { id: 'vane', name: 'Weathervane', ask: 'Lean into the wind', windX: 4, blocks: [...column(-1.6, 4, post), gem(-1.6, stackHeight(post, 4)), ...column(1.6, 2, post), gem(1.6, stackHeight(post, 2), 'crystal')] },
    ],
  };

  // =================================================== generator ===================================================

  /**
   * @typedef {object} TowerModule A reusable chunk of tower the generator places side by side.
   * @property {string} id
   * @property {number} width Platform width it occupies, metres.
   * @property {number} minDifficulty Lowest difficulty (0..1) at which it may appear.
   * @property {(rng: object, difficulty: number) => BlockSpec[]} build Blocks centred on x = 0.
   */
  /** @type {TowerModule[]} */
  const MODULES = [
    { id: 'tower', width: 2.0, minDifficulty: 0, build: (rng, difficulty) => { const storeys = rng.int(2, 3 + Math.round(difficulty * 3)); return [...column(-0.46, storeys, post), ...column(0.46, storeys, post), gem(0, stackHeight(post, storeys))]; } },
    { id: 'steps', width: 2.4, minDifficulty: 0, build: (rng) => { const storeys = rng.int(1, 2); return [...row(0, 2, brick), ...Array.from({ length: storeys }, (_, storey) => piece(0, stackHeight(brick, storey + 1), 0, brick)), gem(0, stackHeight(brick, storeys + 1))]; } },
    { id: 'kegStand', width: 1.2, minDifficulty: 0.1, build: () => kegStand(0) },
    { id: 'arch', width: 2.6, minDifficulty: 0.15, build: (rng) => { const top = rng.chance(0.5) ? 'glass' : 'brick'; const span = [2.4, 0.4, 1]; return [...column(-0.75, 2, post, ['brick', top]), ...column(0.75, 2, post, ['brick', top]), piece(0, stackHeight(post, 2), 0, span), gem(0, stackHeight(post, 2) + span[1] + STACK_GAP), gem(0, 0)]; } },
    { id: 'crib', width: 2.6, minDifficulty: 0.3, build: (rng, difficulty) => { const storeys = 2 * rng.int(2, 2 + Math.round(difficulty * 2)); return [...crib(storeys, beam, 0.55, -1), gem(0, stackHeight(beam, storeys))]; } },
    { id: 'shield', width: 2.8, minDifficulty: 0.35, needs: 'bumper', build: () => shieldedGem(0) },
  ];

  /**
   * @typedef {object} WorldRow A place with its own materials and rules.
   * @property {string} id
   * @property {string} name
   * @property {string} blurb
   * @property {number} unlockStars Total stars needed to enter.
   * @property {number} levels How many levels it holds (hand-made ones first, generated after).
   * @property {[number, number]} difficulty Generator difficulty across the world's levels, first to last (0..1).
   * @property {Record<string, number>} swaps Chance per brick of becoming each material at full difficulty.
   * @property {number} crystalShare Chance per gem of being crystal at full difficulty.
   * @property {number} maxWind Strongest sideways wind (m/s squared) at full difficulty; 0 = still air.
   * @property {string[]} allows Material ids its generated levels may use beyond brick and gem.
   * @property {number} seed Generator seed for its levels.
   * @property {boolean} [isEndless] Levels never run out; difficulty keeps rising with `difficultyPerLevel`.
   */
  /** @type {WorldRow[] & { byId(id: string): WorldRow }} */
  const WORLDS = Kit.table([
    { id: 'toybox', name: 'Toy Box', blurb: 'Brick, glass and powder kegs.', unlockStars: 0, levels: 6, difficulty: [0.1, 0.4], swaps: { glass: 0.2 }, crystalShare: 0, maxWind: 0, allows: ['glass', 'keg'], seed: 1101 },
    { id: 'quarry', name: 'The Quarry', blurb: 'Stone walls and bank shots.', unlockStars: 9, levels: 6, difficulty: [0.3, 0.7], swaps: { stone: 0.5, glass: 0.1 }, crystalShare: 0, maxWind: 0, allows: ['glass', 'keg', 'stone', 'bumper'], seed: 2202 },
    { id: 'ridge', name: 'Gale Ridge', blurb: 'Crosswinds and blast-proof crystal.', unlockStars: 20, levels: 6, difficulty: [0.45, 0.9], swaps: { stone: 0.3, glass: 0.2 }, crystalShare: 0.6, maxWind: 7, allows: ['glass', 'keg', 'stone', 'bumper', 'crystal'], seed: 3303 },
    { id: 'skyline', name: 'Skyline', blurb: 'Endless towers. How high can you go?', unlockStars: 32, levels: Infinity, difficulty: [0.5, 1], swaps: { stone: 0.4, glass: 0.25 }, crystalShare: 0.5, maxWind: 8, allows: ['glass', 'keg', 'stone', 'bumper', 'crystal'], seed: 4404, isEndless: true, difficultyPerLevel: 0.05 },
  ]);

  /** Generator tunables. */
  const GENERATOR = { usableWidth: 6.6, gap: 0.25, maxModules: 3, windDeadZone: 0.25 };

  /** How a level's rating (see rateLevel) turns into shots, loadout budget and the chain needed for the third star. */
  const RATING = {
    perGem: 1, perCrystal: 1, heightWeight: 0.25, stoneWeight: 0.35, windWeight: 0.2, shieldWeight: 1.2, kegRelief: 0.6, glassRelief: 0.15,
    shotsBase: 0.6, shotsPerRating: 0.42, minShots: 2, maxShots: 5, budgetShare: 0.67, chainShare: 0.5, minChain: 2, maxChain: 6,
  };

  const countWhere = (blocks, isMatch) => blocks.filter(isMatch).length;
  const isTargetSpec = (block) => !!MATERIALS.byId(block.materialId).isTarget;
  const isBreakableSpec = (block) => MATERIALS.byId(block.materialId).onBreak !== null;

  /**
   * Difficulty rating of a layout: roughly "how many good shots this takes". Targets cost more the higher they sit and
   * if they are crystal or shielded; stone and wind add work; kegs and glass are help, so they subtract.
   * @param {{ blocks: BlockSpec[], windX?: number }} layout
   * @returns {number} At least 1.
   * @complexity O(blocks).
   */
  const rateLevel = ({ blocks, windX = 0 }) => {
    const targets = blocks.filter(isTargetSpec);
    const targetWork = targets.reduce((work, block) => work + RATING.perGem + (block.materialId === 'crystal' ? RATING.perCrystal : 0) + block.y * RATING.heightWeight, 0);
    const of = (materialId) => countWhere(blocks, (block) => block.materialId === materialId);
    const rating = targetWork + of('stone') * RATING.stoneWeight + of('bumper') * RATING.shieldWeight + Math.abs(windX) * RATING.windWeight - of('keg') * RATING.kegRelief - of('glass') * RATING.glassRelief;
    return Math.max(1, rating);
  };

  /**
   * @typedef {object} Level A level ready to play.
   * @property {string} key Stable id for records, e.g. 'toybox:2' or 'daily:20261116'.
   * @property {string} worldId
   * @property {number} index 0-based position in its world.
   * @property {string} name
   * @property {string} ask
   * @property {BlockSpec[]} blocks
   * @property {number} windX
   * @property {number} rating
   * @property {number} shots Slots in the loadout.
   * @property {number} budget Loadout points (before the 'pouch' upgrade).
   * @property {number} chainPar Longest chain in one shot needed for the third star.
   * @property {number} density Mass per cubic metre of brick.
   */

  /** Mass per cubic metre of brick: later worlds are a little denser so towers feel weightier. */
  const DENSITY = Kit.curve.of([[0, 3], [1, 4.2]]);

  /**
   * Derive the playable numbers of a layout from its rating: every shot may be a heavy ball (cost 1), and the budget
   * leaves about two thirds of a point per shot over for dearer balls, which is what makes the loadout a choice.
   * @param {LevelLayout & { key: string, worldId: string, index: number, difficulty: number }} layout
   * @returns {Level}
   */
  const finishLevel = (layout) => {
    const rating = rateLevel(layout);
    const shots = layout.shots || clamp(Math.round(RATING.shotsBase + rating * RATING.shotsPerRating), RATING.minShots, RATING.maxShots);
    const breakables = countWhere(layout.blocks, isBreakableSpec);
    return {
      key: layout.key, worldId: layout.worldId, index: layout.index, name: layout.name, ask: layout.ask, blocks: layout.blocks,
      windX: layout.windX || 0, rating, shots,
      budget: shots + Math.round(shots * RATING.budgetShare),
      chainPar: clamp(Math.round(breakables * RATING.chainShare), RATING.minChain, RATING.maxChain),
      density: DENSITY(layout.difficulty),
    };
  };

  const GENERATED_NAMES = { first: ['Crooked', 'Sleepy', 'Lofty', 'Brittle', 'Stubborn', 'Tipsy', 'Hollow', 'Proud'], second: ['Keep', 'Stack', 'Bastion', 'Folly', 'Lookout', 'Heap', 'Pile', 'Parapet'] };

  /** Swap some bricks and gems for the world's other materials; the chance of each swap scales with difficulty. */
  const dressBlocks = (blocks, world, difficulty, rng) =>
    blocks.map((block) => {
      if (block.materialId === 'gem') return rng.chance(world.crystalShare * difficulty) ? { ...block, materialId: 'crystal' } : block;
      if (block.materialId !== 'brick') return block;
      const swap = Object.keys(world.swaps).find((materialId) => rng.chance(world.swaps[materialId] * difficulty));
      return swap ? { ...block, materialId: swap } : block;
    });

  /**
   * Generate a tower: pick modules that fit side by side on the platform, lay them out left to right, dress them in the
   * world's materials and roll the wind. The same world, index and seed always give the same level.
   * @param {WorldRow} world
   * @param {number} difficulty 0..1
   * @param {object} rng A Kit.rng stream.
   * @returns {{ name: string, ask: string, blocks: BlockSpec[], windX: number }}
   * @complexity O(modules + blocks).
   */
  const generateLayout = (world, difficulty, rng) => {
    const isAllowed = (module) => module.minDifficulty <= difficulty && (!module.needs || world.allows.includes(module.needs)) && (module.id !== 'kegStand' || world.allows.includes('keg'));
    const candidates = MODULES.filter(isAllowed);
    // Greedy fill: keep drawing modules while the next one still fits the platform.
    const picked = Array.from({ length: GENERATOR.maxModules }).reduce((chosen) => {
      const usedWidth = chosen.reduce((width, module) => width + module.width + GENERATOR.gap, 0);
      const fitting = candidates.filter((module) => usedWidth + module.width <= GENERATOR.usableWidth && !(module.id === 'shield' && chosen.some((other) => other.id === 'shield')));
      return fitting.length ? [...chosen, rng.pick(fitting)] : chosen;
    }, []);
    const totalWidth = picked.reduce((width, module) => width + module.width, 0) + GENERATOR.gap * (picked.length - 1);
    const placed = picked.reduce(
      ({ blocks, left }, module) => ({ blocks: [...blocks, ...shifted(module.build(rng, difficulty), left + module.width / 2)], left: left + module.width + GENERATOR.gap }),
      { blocks: [], left: -totalWidth / 2 }
    );
    const windStrength = world.maxWind * difficulty * rng.range(0.5, 1);
    const windX = windStrength < GENERATOR.windDeadZone ? 0 : windStrength * (rng.chance(0.5) ? 1 : -1);
    return {
      name: `${rng.pick(GENERATED_NAMES.first)} ${rng.pick(GENERATED_NAMES.second)}`,
      ask: windX ? 'Mind the wind' : 'Find the weak point',
      blocks: dressBlocks(placed.blocks, world, difficulty, rng),
      windX,
    };
  };

  /** A world-and-index seed mix; the large odd multiplier keeps neighbouring levels on unrelated streams. */
  const LEVEL_SEED_STRIDE = 7919;

  /**
   * The level at a position in a world: a hand-made layout if the world has one there, otherwise a generated tower.
   * @param {string} worldId
   * @param {number} index 0-based.
   * @returns {Level}
   * @example levelAt('quarry', 3).shots
   */
  const levelAt = (worldId, index) => {
    const world = WORLDS.byId(worldId);
    const span = world.isEndless ? 1 / world.difficultyPerLevel : Math.max(1, world.levels - 1);
    const difficulty = world.isEndless ? Math.min(1.5, world.difficulty[0] + index * world.difficultyPerLevel) : lerp(world.difficulty[0], world.difficulty[1], Math.min(1, index / span));
    const hand = (HAND_LEVELS[worldId] || [])[index];
    const layout = hand || generateLayout(world, difficulty, Kit.rng(world.seed + index * LEVEL_SEED_STRIDE));
    return finishLevel({ ...layout, key: `${worldId}:${index}`, worldId, index, difficulty });
  };

  // ============================================= stars, unlocks, challenge =============================================

  /**
   * @typedef {{ cleared: boolean, shotsLeft: number, bestChain: number, score: number }} LevelResult
   * @typedef {{ id: string, describe(level: Level): string, isMet(result: LevelResult, level: Level): boolean }} StarRule
   */
  /** One star per rule met: clearing, clearing with a shot to spare, and landing a long enough chain in one shot. */
  const STAR_RULES = [
    { id: 'clear', describe: () => 'Clear the tower', isMet: (result) => result.cleared },
    { id: 'spare', describe: () => 'Leave a shot unused', isMet: (result) => result.cleared && result.shotsLeft >= 1 },
    { id: 'chain', describe: (level) => `Chain of ${level.chainPar} in one shot`, isMet: (result, level) => result.cleared && result.bestChain >= level.chainPar },
  ];

  /**
   * Which star rules a result meets.
   * @param {LevelResult} result @param {Level} level
   * @returns {{ stars: number, rules: { text: string, isMet: boolean }[] }}
   */
  const rateResult = (result, level) => {
    const rules = STAR_RULES.map((rule) => ({ text: rule.describe(level), isMet: rule.isMet(result, level) }));
    return { stars: rules.filter((rule) => rule.isMet).length, rules };
  };

  /** Shards (workshop currency): a share of the score every clear, plus a bounty for each star earned for the first time. */
  const SHARDS = { perScore: 1 / 100, perNewStar: 6 };
  const shardsFor = (score, newStars, bonus = 1) => Math.floor((score * SHARDS.perScore + newStars * SHARDS.perNewStar) * bonus);

  /** Unused shots pay this much score each. */
  const SHOT_BONUS = 250;

  /**
   * Everything total stars unlock, as Kit.profile achievement rows (stat 'stars'): balls from BALLS, worlds from WORLDS
   * and the daily challenge. One list, derived from the tables, so an unlock threshold lives in exactly one place.
   */
  const DAILY_UNLOCK_STARS = 5;
  const SKYLINE_MILESTONES = [{ floor: 3, shards: 40 }, { floor: 6, shards: 80 }, { floor: 10, shards: 150 }, { floor: 15, shards: 250 }, { floor: 25, shards: 400 }];
  const UNLOCKS = [
    ...BALLS.filter((ball) => ball.unlockStars > 0).map((ball) => ({ id: `ball:${ball.id}`, text: `New ball: ${ball.name}`, stat: 'stars', target: ball.unlockStars, unlocks: `ball:${ball.id}` })),
    ...WORLDS.filter((world) => world.unlockStars > 0).map((world) => ({ id: `world:${world.id}`, text: `New world: ${world.name}`, stat: 'stars', target: world.unlockStars, unlocks: `world:${world.id}` })),
    { id: 'mode:daily', text: 'New mode: Daily tower', stat: 'stars', target: DAILY_UNLOCK_STARS, unlocks: 'mode:daily' },
    // Skyline milestones: goals past the campaign, each paying a purse of shards (stat 'floors' = highest floor cleared).
    ...SKYLINE_MILESTONES.map(({ floor, shards }) => ({ id: `floor:${floor}`, text: `Skyline floor ${floor}: +${shards} shards`, stat: 'floors', target: floor, reward: { shards } })),
  ];

  /** Daily tower: one generated level a day with a dealt loadout, so everyone solves the same puzzle with the same balls. */
  const DAILY = { worldId: 'ridge', difficulty: 0.75, shots: 3 };

  /**
   * The daily challenge for a calendar day.
   * @param {number} dayNumber Days since the epoch (Math.floor(Date.now() / 86400000)).
   * @returns {{ level: Level, loadout: string[] }} The loadout is dealt from every ball, owned or not: a taste of what is ahead.
   */
  const dailyChallenge = (dayNumber) => {
    const rng = Kit.rng(dayNumber);
    const layout = generateLayout(WORLDS.byId(DAILY.worldId), DAILY.difficulty, rng.fork());
    const level = finishLevel({ ...layout, key: `daily:${dayNumber}`, worldId: 'daily', index: dayNumber, difficulty: DAILY.difficulty, name: 'Daily tower', shots: DAILY.shots });
    return { level, loadout: Array.from({ length: DAILY.shots }, () => rng.pick(BALLS).id) };
  };

  // ================================================= progression model =================================================

  /** Records of levels whose key starts with this are scores only: the daily tower does not feed the star total. */
  const DAILY_KEY_PREFIX = 'daily:';
  const MS_PER_DAY = 86400000;

  /**
   * The player's long arc as one model: stars per level, the unlocks they open (Kit.profile), shards (Kit.wallet) and
   * workshop upgrades (Kit.upgrades feeding Kit.stats). Pure: pass any { get, set } as `save`, or none to keep it in
   * memory, which is how scratch/sling/solve.js simulates hours of play.
   * @param {{ save?: { get: Function, set: Function } }} [options]
   * @returns {object} See the returned object.
   * @example
   * const progress = TOWER_SMASH_DATA.createProgress({ save: ctx.save });
   * const outcome = progress.recordResult(level, { cleared: true, shotsLeft: 1, bestChain: 3, score: 700 });
   * outcome.unlocked;   // ['New ball: Splitter']
   * @complexity recordResult and totalStars are O(levels played); everything else is O(1) or O(table rows).
   */
  const createProgress = ({ save } = {}) => {
    const stats = Kit.stats({ ...STATS_BASE });
    const wallet = Kit.wallet({ shards: 0 }, save);
    const upgrades = Kit.upgrades(UPGRADES, { stats, wallet, save });
    let freshUnlocks = []; // filled by the profile while recordResult runs, so the result can name what just opened
    const profile = Kit.profile({
      save,
      achievements: UNLOCKS,
      onAchievement(row) {
        freshUnlocks.push(row.text);
        if (row.reward) wallet.add(row.reward.shards, 'shards');
      },
    });
    const records = { ...(save ? save.get('records', {}) : {}) };

    const totalStars = () => Object.keys(records).filter((key) => !key.startsWith(DAILY_KEY_PREFIX)).reduce((total, key) => total + records[key].stars, 0);
    const isBallOwned = (ball) => ball.unlockStars === 0 || profile.isUnlocked(`ball:${ball.id}`);
    const isWorldOpen = (world) => world.unlockStars === 0 || profile.isUnlocked(`world:${world.id}`);
    const recordOf = (key) => records[key] || { stars: 0, score: 0 };
    // A level opens once the one before it has been cleared, so each world is played in order.
    const isLevelOpen = (worldId, index) => isWorldOpen(WORLDS.byId(worldId)) && (index === 0 || recordOf(`${worldId}:${index - 1}`).stars > 0);
    /** First level of `world` not yet cleared, or -1 when all are. Endless worlds always have one. */
    const firstUnclearedIn = (world) => {
      const played = Object.keys(records).filter((key) => key.startsWith(world.id + ':') && records[key].stars > 0).length;
      return world.isEndless || played < world.levels ? played : -1;
    };

    return {
      stats, wallet, upgrades, profile, totalStars, isBallOwned, isWorldOpen, isLevelOpen, recordOf, firstUnclearedIn,
      ownedBalls: () => BALLS.filter(isBallOwned),
      isDailyOpen: () => profile.isUnlocked('mode:daily'),
      today: () => Math.floor(Date.now() / MS_PER_DAY),
      /** Loadout points for a level, including the 'pouch' upgrade. */
      budgetFor: (level) => level.budget + stats.get('bonusBudget'),
      /**
       * The level to offer next: the first uncleared level of the first open world that has one, else a replay.
       * @returns {{ worldId: string, index: number }}
       */
      nextLevel() {
        const openWorlds = WORLDS.filter(isWorldOpen);
        const fresh = openWorlds.find((candidate) => firstUnclearedIn(candidate) >= 0);
        if (fresh) return { worldId: fresh.id, index: firstUnclearedIn(fresh) };
        // Everything open is cleared but the next world needs more stars: offer the level with the most stars still to win.
        return openWorlds
          .flatMap((world) => Array.from({ length: world.levels }, (_, index) => ({ worldId: world.id, index })))
          .reduce((weakest, candidate) => (recordOf(`${candidate.worldId}:${candidate.index}`).stars < recordOf(`${weakest.worldId}:${weakest.index}`).stars ? candidate : weakest));
      },
      /**
       * Bank a finished level: keep the best stars and score, pay shards and open whatever the new star total unlocks.
       * @param {Level} level @param {LevelResult} result
       * @returns {{ stars: number, rules: { text: string, isMet: boolean }[], newStars: number, shards: number, unlocked: string[] }}
       */
      recordResult(level, result) {
        const rated = rateResult(result, level), before = recordOf(level.key);
        const newStars = Math.max(0, rated.stars - before.stars);
        records[level.key] = { stars: Math.max(before.stars, rated.stars), score: Math.max(before.score, result.score) };
        if (save) save.set('records', records);
        const shards = result.cleared ? shardsFor(result.score, newStars, stats.get('shardBonus')) : 0;
        if (shards) wallet.add(shards, 'shards');
        freshUnlocks = [];
        profile.best('stars', totalStars());
        if (result.cleared) profile.count('clears');
        if (result.cleared && WORLDS.has(level.worldId) && WORLDS.byId(level.worldId).isEndless) profile.best('floors', level.index + 1);
        return { ...rated, newStars, shards, unlocked: freshUnlocks.slice() };
      },
    };
  };

  // ============================================ headless pacing model ============================================

  /**
   * Assumptions of the pacing model (tools/sim.js). It does not simulate physics: it models a player of middling skill
   * as chances that fall with a level's rating, to see how long each unlock takes and where the arc runs dry. The
   * numbers are guesses about people, not measurements; scratch/sling/solve.js is the physics-true check.
   */
  const PACING = { secondsPerShot: 14, secondsPerLevel: 25, secondsPerPurchase: 6, clearBase: 1.05, clearPerRating: 0.05, minClear: 0.25, spareChance: 0.45, chainChance: 0.3, scorePerTarget: 180 };

  /** A plausible result for one attempt at a level by the modelled player. */
  const modelAttempt = (level, random) => {
    const cleared = random() < Math.max(PACING.minClear, PACING.clearBase - level.rating * PACING.clearPerRating);
    const hasSpare = cleared && random() < PACING.spareChance, hasChain = cleared && random() < PACING.chainChance;
    const targets = countWhere(level.blocks, isTargetSpec);
    return { cleared, shotsLeft: hasSpare ? 1 : 0, bestChain: hasChain ? level.chainPar : 1, score: cleared ? targets * PACING.scorePerTarget + (hasSpare ? SHOT_BONUS : 0) : 0 };
  };

  /** The long arc in the shape tools/dev/simulate.js plays: state is a createProgress() model. */
  const progression = {
    createState: () => createProgress(),
    actions(progress) {
      const next = progress.nextLevel(), { upgrades } = progress;
      const purchases = UPGRADES.filter((row) => (!row.ball || progress.isBallOwned(BALLS.byId(row.ball))) && !upgrades.maxed(row.id) && upgrades.unlocked(row.id))
        .map((row) => ({ id: `buy:${row.id}`, kind: 'buy', label: row.name, cost: upgrades.cost(row.id), affordable: upgrades.canBuy(row.id) }));
      return [{ id: `play:${next.worldId}:${next.index}`, kind: 'play', label: `Play ${next.worldId} ${next.index + 1}` }, ...purchases];
    },
    apply(progress, action, random) {
      const [verb, first, second] = action.id.split(':');
      if (verb === 'buy') {
        progress.upgrades.buy(first);
        return { seconds: PACING.secondsPerPurchase, unlocked: [action.id] };
      }
      const level = levelAt(first, Number(second));
      const outcome = progress.recordResult(level, modelAttempt(level, random));
      return { seconds: PACING.secondsPerLevel + level.shots * PACING.secondsPerShot, unlocked: outcome.unlocked };
    },
    summary(progress) {
      const upgradeLevels = UPGRADES.reduce((total, row) => total + progress.upgrades.level(row.id), 0);
      const upgradeCap = UPGRADES.reduce((total, row) => total + row.max, 0);
      const owned = progress.profile.unlocked().length + upgradeLevels;
      return { currency: progress.wallet.get('shards'), owned, remaining: UNLOCKS.length + upgradeCap - owned };
    },
  };

  // ==================================================== aim rules ====================================================

  /**
   * Turn a drag (pixels from where the finger went down) into an aim.
   * @param {number} dragX Positive = finger moved right. @param {number} dragY Positive = finger moved down (pulling back).
   * @returns {{ pull: number, yaw: number, loft: number, speed: number }} pull 0..1; yaw and loft in radians; speed in m/s.
   */
  const aimFromDrag = (dragX, dragY) => aimFromPull(clamp(dragY / AIM.maxDragPixels), -clamp(dragX / AIM.maxDragPixels, -1, 1));

  /**
   * The aim for a pull and a turn, the two numbers a player (or a search) actually controls.
   * @param {number} pull 0..1 @param {number} turn -1..1, positive turns the shot toward +x.
   * @returns {{ pull: number, yaw: number, loft: number, speed: number }}
   */
  const aimFromPull = (pull, turn) => ({ pull, yaw: turn * AIM.maxYaw, loft: lerp(AIM.loft[0], AIM.loft[1], pull), speed: lerp(AIM.speed[0], AIM.speed[1], pull) });

  window.TOWER_SMASH_DATA = {
    WORLD, AIM, PREVIEW, FLIGHT, SETTLE, BLOCK_BODY, WAKE, CHAIN_FUSE, BOUNCE, PALETTE, COLORS, MATERIALS, BALLS, STATS_BASE, UPGRADES,
    SHAPES, HAND_LEVELS, MODULES, WORLDS, RATING, STAR_RULES, SHARDS, SHOT_BONUS, UNLOCKS, DAILY, DAILY_UNLOCK_STARS,
    rateLevel, finishLevel, generateLayout, levelAt, rateResult, shardsFor, dailyChallenge, createProgress, progression, aimFromDrag, aimFromPull,
  };
})();
