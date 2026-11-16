// Soulwake simulation: the whole game as plain data advanced by small step functions. No DOM, no THREE: it runs in
// node (scratch/souls/sim-check.js plays a run headless to check pacing).
//
// Owns: the graveyard generator, zombies and their behaviours, the hero's attacks and powers, souls, drops, hazards,
// and the `events` list that tells the presenter what just happened. Does not own: any tunable (games/souls-data.js),
// drawing, sound, HUD, wallet, inventory or the absorb roll's screen (games/souls.js reacts to events for those).
// Exposed as the global SOULWAKE_SIM.
//
// Shape: createWorld(...) returns the world (plain objects and arrays); step(world, input, dt) advances it in place
// and appends to world.events. Mutation in place is deliberate: this is the per-frame hot path.
(() => {
  const DATA = window.SOULWAKE_DATA;
  const { HERO, SOULS, LOOT, ARENA, DIFFICULTY, SPAWN_DISTANCE, BOSS, ELITE } = DATA;
  const zombieRows = Kit.table(DATA.ZOMBIES);
  const weaponRows = Kit.table(DATA.WEAPON_BEHAVIOURS);
  const powerRows = Kit.table(DATA.POWERS);
  const curves = {
    spawnInterval: Kit.curve.of(DIFFICULTY.spawnInterval),
    maxAlive: Kit.curve.of(DIFFICULTY.maxAlive),
    health: Kit.curve.of(DIFFICULTY.health),
    damage: Kit.curve.of(DIFFICULTY.damage),
    lootLevel: Kit.curve.of(DIFFICULTY.lootLevel),
    lootPower: Kit.curve.of(LOOT.power),
    absorbNeed: Kit.curve.of(SOULS.absorbNeed),
    bankSouls: Kit.curve.of(SOULS.bankSouls),
  };

  // Constants of the simulation itself (feel that is not content, so it lives beside the code that uses it).
  /** Collision circles must stay under half a cell for Kit.crowd.slide; big zombies collide as if this wide. */
  const MAX_COLLISION_RADIUS = ARENA.cell * 0.45;
  /** Knockback fades by this factor per second (exponential decay rate). */
  const PUSH_DECAY = 6;
  /** A zombie hits when the gap between its circle and the hero's is under this. */
  const TOUCH_REACH = 0.25;
  /** How hard overlapping zombies push apart, in units per second per unit of overlap. */
  const SEPARATION_STRENGTH = 6;
  /** A shot hits a zombie whose circle comes within this of the shot's centre. */
  const SHOT_RADIUS = 0.25;
  const ACID_SHOT = { speed: 11, pierce: 1 };
  /** The chain weapon jumps to zombies within this distance of the last one hit. */
  const ARC_JUMP_RANGE = 3.2;
  /** Damage multiplier of the Reaping Arc capstone's sweep. */
  const REAP_POWER = 2;
  /** The hero opens a chest from this far away. */
  const CHEST_RADIUS = 1.3;
  /** Loot luck raises drop chance by this much per point (on top of shifting rarity). */
  const DROP_CHANCE_PER_LUCK = 0.5;
  /** A sprinter at rest between lunges crawls at this fraction of its speed. */
  const REST_SPEED_FACTOR = 0.3;
  /** A spitter backing away from the hero moves at this fraction of its speed. */
  const RETREAT_SPEED_FACTOR = 0.8;
  /** How far inside / outside its preferred distance a spitter tolerates before it moves. */
  const SPITTER_SLACK = { near: 1.5, far: 1 };
  /** How much of a wraith's heading is sideways sway at the widest point of its weave. */
  const SWAY_WEIGHT = 0.6;
  /** Bucket size of the zombie spatial hash: twice the largest zombie radius, so touching zombies are at most one bucket apart. */
  const NEIGHBOUR_BUCKET = 2 * Math.max(...DATA.ZOMBIES.map((row) => row.radius));
  /** Two zombies exactly on top of each other are treated as this far apart, so the push direction is never 0 / 0. */
  const MIN_GAP = 1e-6;
  const STILL = { x: 0, z: 0, speed: 0 };

  const isBlockedCell = (cell) => cell !== null;
  const isOpenCell = (cell) => cell === null;
  const distanceBetween = (from, to) => Math.hypot(to.x - from.x, to.z - from.z);

  /**
   * Unit direction and distance from one point to another on the ground plane.
   * @param {{ x: number, z: number }} from
   * @param {{ x: number, z: number }} to
   * @returns {{ x: number, z: number, distance: number }} (0, 0) when the points coincide
   */
  function headingTo(from, to) {
    const distance = distanceBetween(from, to);
    return distance > 0 ? { x: (to.x - from.x) / distance, z: (to.z - from.z) / distance, distance } : { x: 0, z: 0, distance: 0 };
  }

  // ---- world generation ------------------------------------------------------------------------------------------

  /**
   * The cells one feature run covers: a straight line from a random start, one obstacle every `stride` cells.
   * @param {Object} feature  a row of DATA.FEATURES
   * @param {Object} rng      a Kit.rng
   * @returns {{ x: number, y: number, kind: string }[]}
   */
  function featureCells(feature, rng) {
    const start = { x: rng.int(1, ARENA.size - 2), y: rng.int(1, ARENA.size - 2) };
    const [stepX, stepY] = rng.pick([[1, 0], [0, 1]]);
    const length = rng.int(feature.length[0], feature.length[1]);
    return Array.from({ length }, (_, index) => ({ x: start.x + stepX * index * feature.stride, y: start.y + stepY * index * feature.stride, kind: feature.kind }));
  }

  /**
   * Generates the graveyard for a seed: a walled square with scattered walls, grave rows and trees, a clear start in
   * the middle, and every open cell reachable from it (pockets the scatter sealed off are filled with trees, so a
   * zombie can never spawn somewhere it cannot leave).
   * @param {Object} rng  a Kit.rng
   * @returns {{ grid: Object, openCells: { x: number, z: number }[], chests: { id: string, x: number, z: number, isOpen: boolean }[] }}
   *          grid cells hold an obstacle kind ('wall' | 'tomb' | 'tree') or null; openCells and chests are in world units
   */
  function generateGraveyard(rng) {
    const { size, cell, clearRadius } = ARENA;
    const centre = (size - 1) / 2;
    const isBorder = (x, y) => x === 0 || y === 0 || x === size - 1 || y === size - 1;
    const ringFromCentre = (x, y) => Math.max(Math.abs(x - centre), Math.abs(y - centre));
    const grid = Kit.grid(size, size, { cell, fill: (x, y) => (isBorder(x, y) ? 'wall' : null) });
    DATA.FEATURES.flatMap((feature) => Array.from({ length: feature.count }, () => featureCells(feature, rng)))
      .flat()
      .filter(({ x, y }) => grid.inside(x, y) && grid.get(x, y) === null && ringFromCentre(x, y) > clearRadius)
      .forEach(({ x, y, kind }) => grid.set(x, y, kind));

    const reachable = new Set(grid.flood(centre, centre, isOpenCell).map(({ x, y }) => y * size + x));
    grid.find(isOpenCell).filter(({ x, y }) => !reachable.has(y * size + x)).forEach(({ x, y }) => grid.set(x, y, 'tree'));

    const open = grid.find(isOpenCell);
    const chests = rng
      .shuffle(open.filter(({ x, y }) => ringFromCentre(x, y) >= LOOT.chestRing[0] && ringFromCentre(x, y) <= LOOT.chestRing[1]))
      .slice(0, LOOT.chestCount)
      .map(({ x, y }, index) => ({ id: `chest${index}`, ...grid.toWorld(x, y), isOpen: false }));
    return { grid, openCells: open.map(({ x, y }) => grid.toWorld(x, y)), chests };
  }

  // ---- loot ------------------------------------------------------------------------------------------------------

  /**
   * Builds the item roller for a run: Kit.loot over the data tables, plus the chance of a curse on top.
   * @param {Object} rng    a Kit.rng (fork the run's rng so loot does not disturb the map)
   * @param {Object} stats  the hero's Kit.stats (for lootLuck)
   * @returns {(time: number, bonusLuck?: number) => Object} rolls one item for run time `time` (seconds)
   */
  function createDropRoller(rng, stats) {
    const loot = Kit.loot({ rarities: DATA.RARITIES, bases: DATA.BASES, affixes: DATA.AFFIXES, power: LOOT.power, rng });
    const roll = (time, bonusLuck = 0) => {
      const level = Math.floor(curves.lootLevel(time));
      const item = loot.roll({ level, luck: stats.get('lootLuck') + bonusLuck });
      return rng.chance(LOOT.curseChance) ? Kit.loot.augment(item, rng.pick(DATA.CURSES), curves.lootPower(level)) : item;
    };
    roll.loot = loot;
    return roll;
  }

  /** Soul points an item salvages for. */
  const salvageValue = (item) => Math.ceil(item.value * LOOT.salvageRate);

  // ---- absorb roll -----------------------------------------------------------------------------------------------

  /**
   * The weighted table for an absorb roll: every power the cleansed kinds can grant, weighted by how many souls of
   * that kind were cleansed since the last roll. Rare powers weigh less, and absorb luck buys that back.
   * @param {Record<string, number>} cleansedKinds  zombie id -> souls cleansed since the last roll
   * @param {(powerId: string) => boolean} isBarred powers that cannot be taken are left out (at their cap, or new while
   *                                                 every power slot is full)
   * @param {number} absorbLuck                     the hero's absorbLuck stat
   * @returns {{ power: Object, label: string, sub: string, color: string, weight: number }[]} Kit.views.roll entries
   */
  function buildAbsorbPool(cleansedKinds, isBarred, absorbLuck) {
    const rarityWeight = (power) => (power.tier > 0 ? SOULS.rareWeight * (1 + absorbLuck) : 1);
    const contributions = Object.keys(cleansedKinds).flatMap((kind) => {
      const zombie = zombieRows.byId(kind);
      return zombie.powers.filter((powerId) => !isBarred(powerId)).map((powerId) => ({ powerId, zombie, count: cleansedKinds[kind] }));
    });
    const byPower = contributions.reduce((pool, { powerId, zombie, count }) => {
      const power = powerRows.byId(powerId);
      const entry = pool.get(powerId) || { power, label: power.name, sub: `from ${zombie.name}`, color: power.color, weight: 0 };
      return pool.set(powerId, { ...entry, weight: entry.weight + count * rarityWeight(power) });
    }, new Map());
    return [...byPower.values()];
  }

  /** Souls needed for the next absorb roll. */
  const absorbNeed = (world) => Math.max(1, Math.ceil(curves.absorbNeed(world.absorb.rolls) * world.stats.get('absorbNeed')));
  /** Soul points paid for banking the next roll instead of taking its power. */
  const bankValue = (world) => Math.round(curves.bankSouls(world.absorb.rolls));

  /**
   * Closes the current absorb roll: the meter and the per-kind tally start again.
   * @param {Object} world
   */
  function finishAbsorbRoll(world) {
    world.absorb = { meter: 0, rolls: world.absorb.rolls + 1, cleansedKinds: {} };
  }

  // ---- world -----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} SimInput
   * @property {number} moveX      -1..1, world x
   * @property {number} moveZ      -1..1, world z (positive is toward the camera)
   * @property {boolean} wantsPulse the player tapped this frame
   */

  /**
   * Creates a run.
   * @param {Object} options
   * @param {Object} options.rng    a Kit.rng; the same seed gives the same graveyard and the same loot stream
   * @param {Object} options.stats  the hero's Kit.stats (read every frame, so powers and gear apply at once)
   * @param {Object} [options.tier] a row of DATA.TIERS: how hard the night is (default: the first, Dusk)
   * @returns {Object} the world: { hero, zombies, souls, drops, chests, shots, hazards, events, absorb, tally, time, ... }
   */
  function createWorld({ rng, stats, tier = DATA.TIERS[0] }) {
    const graveyard = generateGraveyard(rng);
    return {
      rng,
      stats,
      tier,
      neighbours: Kit.crowd.buckets(NEIGHBOUR_BUCKET), // spatial hash of zombies, refilled every frame for separation
      ...graveyard,
      rollDrop: createDropRoller(rng.fork(), stats),
      spawnTable: Kit.spawnTable(DATA.SPAWNS, { intro: DATA.INTRO_SPAWNS }),
      dropPity: Kit.craft.pity(LOOT.pityKills),
      field: null, // Kit.crowd flow field toward the hero; rebuilt when the hero changes cell
      fieldCellKey: -1,
      hero: {
        x: 0, z: 0, facingX: 0, facingZ: 1, hp: stats.get('maxHp'), isDead: false,
        attackTimer: 0, attackCount: 0, cooldownTimer: 0, acidTimer: HERO.acidInterval, graceTimer: 0, phaseTimer: 0, phaseCooldownTimer: 0, dash: null,
      },
      weaponId: 'unarmed',
      zombies: [], souls: [], drops: [], shots: [], hazards: [], events: [],
      absorb: { meter: 0, rolls: 0, cleansedKinds: {} },
      tally: { downed: 0, cleansed: 0, bestStreak: 0 },
      streak: { count: 0, timer: 0 },
      spawnCount: 0,
      nextBossAt: BOSS.at,
      time: 0,
      spawnTimer: 0,
      nextId: 1,
    };
  }

  const emit = (world, type, details) => world.events.push({ type, ...details });
  const newId = (world) => world.nextId++;
  const zombiesWithin = (world, centre, radius) => world.zombies.filter((zombie) => !zombie.isDown && distanceBetween(centre, zombie) <= radius + zombieRows.byId(zombie.kind).radius);

  /**
   * The closest living zombie to a point, within a range, skipping any in `excluded`.
   * @returns {Object|null}
   * @complexity O(n) for n zombies. Called a handful of times per frame (attack, acid, chain jumps), never per zombie.
   */
  function nearestZombie(world, centre, range, excluded = []) {
    return zombiesWithin(world, centre, range)
      .filter((zombie) => !excluded.includes(zombie))
      .reduce((best, zombie) => (!best || distanceBetween(centre, zombie) < distanceBetween(centre, best) ? zombie : best), null);
  }

  // ---- damage ----------------------------------------------------------------------------------------------------

  /**
   * Hurts the hero unless dashing, veiled or inside the grace window. Armour removes a flat amount but a hit always
   * costs at least 1. Being hit may raise the Veilwalk.
   */
  function damageHero(world, amount) {
    const { hero, stats } = world;
    if (hero.isDead || hero.dash || hero.phaseTimer > 0 || hero.graceTimer > 0) return;
    // The night's damage curve scales the blow first; armour then removes its flat amount.
    const taken = Math.max(1, amount * curves.damage(world.time) - stats.get('armour'));
    hero.hp = Math.max(0, hero.hp - taken);
    hero.graceTimer = HERO.hurtGrace;
    emit(world, 'hurt', { amount: taken });
    if (hero.hp === 0) {
      hero.isDead = true;
      emit(world, 'death');
      return;
    }
    if (stats.get('phaseTime') > 0 && hero.phaseCooldownTimer <= 0) {
      hero.phaseTimer = stats.get('phaseTime');
      hero.phaseCooldownTimer = HERO.phaseCooldown;
      emit(world, 'veil');
    }
  }

  /** What a downed zombie leaves behind besides its soul, keyed by behaviour. */
  const ON_DOWN = {
    // A bloater bursts where it fell, after its fuse: step away or take the blast.
    burst(world, zombie, row) {
      world.hazards.push({ id: newId(world), kind: 'burst', x: zombie.x, z: zombie.z, radius: row.tuning.burstRadius, damage: row.tuning.burstDamage, timer: row.tuning.fuse, duration: row.tuning.fuse });
    },
  };

  /**
   * Takes a zombie out of the fight: it leaves a soul, maybe an item, and triggers Death Bloom on its neighbours.
   * `isDown` is set first, so a chain of blooms can never revisit it.
   */
  function downZombie(world, zombie) {
    const row = zombieRows.byId(zombie.kind);
    const { stats } = world;
    zombie.isDown = true;
    world.tally.downed++;
    world.souls.push({ id: newId(world), kind: zombie.kind, isElite: zombie.isElite, x: zombie.x, z: zombie.z, life: SOULS.lifetime * world.tier.soulLife, progress: 0 });
    emit(world, 'down', { kind: zombie.kind, isElite: zombie.isElite, x: zombie.x, z: zombie.z });
    if (ON_DOWN[row.behaviour]) ON_DOWN[row.behaviour](world, zombie, row);
    const dropChance = zombie.isElite ? 1 : Math.min(1, row.dropChance * (1 + stats.get('lootLuck') * DROP_CHANCE_PER_LUCK));
    if (world.dropPity.roll(dropChance, world.rng)) spawnDrop(world, zombie, 0);
    if (stats.get('bloomDamage') > 0) {
      emit(world, 'bloom', { x: zombie.x, z: zombie.z, radius: HERO.bloomRadius });
      zombiesWithin(world, zombie, HERO.bloomRadius).forEach((other) => damageZombie(world, other, stats.get('bloomDamage'), 'bloom'));
    }
  }

  /**
   * Hurts a zombie; armour removes a flat amount but a hit always costs at least 1.
   * @param {string} source  what hit it ('weapon' | 'bolt' | 'acid' | 'bloom' | 'pulse' | 'dash'), for the presenter
   */
  function damageZombie(world, zombie, amount, source) {
    if (zombie.isDown) return;
    const taken = Math.max(1, amount - (zombieRows.byId(zombie.kind).armour || 0));
    zombie.hp -= taken;
    zombie.hitFlash = 1;
    emit(world, 'hit', { x: zombie.x, z: zombie.z, amount: taken, source });
    if (zombie.hp <= 0) downZombie(world, zombie);
  }

  function spawnDrop(world, at, bonusLuck) {
    const drop = { id: newId(world), x: at.x, z: at.z, item: world.rollDrop(world.time, bonusLuck) };
    world.drops.push(drop);
    emit(world, 'drop', { drop });
  }

  // ---- zombies ---------------------------------------------------------------------------------------------------

  /**
   * Adds a zombie of a kind at a point, with health scaled by the run's difficulty, its tier and whether it is an elite.
   * @returns {Object} the zombie
   */
  function spawnZombie(world, kind, at, isElite = false) {
    const hp = zombieRows.byId(kind).hp * curves.health(world.time) * world.tier.health * (isElite ? ELITE.health : 1);
    const zombie = {
      id: newId(world), kind, isElite, x: at.x, z: at.z, hp, maxHp: hp,
      pushX: 0, pushZ: 0, stun: 0, touchTimer: 0, mode: 'walk', modeTimer: 0, aimX: 0, aimZ: 0, age: 0, hitFlash: 0, facing: 0, isDown: false,
    };
    world.zombies.push(zombie);
    emit(world, 'spawn', { kind, x: at.x, z: at.z });
    return zombie;
  }

  /** An open point at spawning distance from the hero (any open point if the hero is cornered far from all of them). */
  function pickSpawnPoint(world, distance = SPAWN_DISTANCE) {
    const inBand = world.openCells.filter((point) => {
      const gap = distanceBetween(point, world.hero);
      return gap >= distance.min && gap <= distance.max;
    });
    return world.rng.pick(inBand.length ? inBand : world.openCells);
  }

  /** Brings the mini-boss onto the field (the spawner calls this on the BOSS schedule). */
  function spawnBoss(world) {
    const zombie = spawnZombie(world, BOSS.kind, pickSpawnPoint(world, { min: BOSS.distance, max: BOSS.distance + SPAWN_DISTANCE.max - SPAWN_DISTANCE.min }));
    zombie.modeTimer = zombieRows.byId(BOSS.kind).tuning.summonInterval;
    emit(world, 'boss', { x: zombie.x, z: zombie.z });
    return zombie;
  }

  /**
   * Which way a walking zombie should head: along the crowd's flow field around obstacles, and straight at the hero
   * once it shares the hero's cell or the field has no step for it.
   * @returns {{ x: number, z: number, distance: number }} unit direction; distance is to the hero
   */
  function steerToHero(world, zombie) {
    const toHero = headingTo(zombie, world.hero);
    const cell = world.grid.fromWorld(zombie.x, zombie.z);
    const nextCell = cell && world.field ? world.field.next(cell.x, cell.y) : null;
    if (!nextCell || world.field.distanceAt(nextCell.x, nextCell.y) === 0) return toHero;
    return { ...headingTo(zombie, world.grid.toWorld(nextCell.x, nextCell.y)), distance: toHero.distance };
  }

  function enterMode(zombie, mode, seconds = 0) {
    zombie.mode = mode;
    zombie.modeTimer = seconds;
  }

  /** The sprinter's cycle, one function per mode: walk in, wind up (the tell), lunge in a straight line, rest. */
  const LUNGE_MODES = {
    walk(world, zombie, row) {
      const steer = steerToHero(world, zombie);
      if (steer.distance < row.tuning.lungeRange) enterMode(zombie, 'windup', row.tuning.windup);
      return { ...steer, speed: row.speed };
    },
    windup(world, zombie, row) {
      if (zombie.modeTimer > 0) return STILL;
      // The lunge is aimed once, when it starts, so a sidestep during the windup dodges it.
      const aim = headingTo(zombie, world.hero);
      Object.assign(zombie, { aimX: aim.x, aimZ: aim.z });
      enterMode(zombie, 'lunge', row.tuning.lungeSeconds);
      return STILL;
    },
    lunge(world, zombie, row) {
      if (zombie.modeTimer <= 0) enterMode(zombie, 'rest', row.tuning.rest);
      return { x: zombie.aimX, z: zombie.aimZ, speed: row.tuning.lungeSpeed };
    },
    rest(world, zombie, row) {
      if (zombie.modeTimer <= 0) enterMode(zombie, 'walk');
      return { ...steerToHero(world, zombie), speed: row.speed * REST_SPEED_FACTOR };
    },
  };

  /**
   * How each kind of zombie decides where to go. Each returns the heading and speed it wants this frame; the shared
   * mover (stepZombie) applies slows, knockback and collision. `modeTimer` counts down before the behaviour runs.
   */
  const ZOMBIE_BEHAVIOURS = {
    chase: (world, zombie, row) => ({ ...steerToHero(world, zombie), speed: row.speed }),
    lunge: (world, zombie, row) => LUNGE_MODES[zombie.mode](world, zombie, row),
    // Keeps its distance and lobs a glob at where the hero stands; the marker on the ground is the warning.
    spit(world, zombie, row) {
      const { keepDistance, spitRange, spitInterval, telegraph, splashRadius, splashDamage } = row.tuning;
      const steer = steerToHero(world, zombie);
      if (zombie.modeTimer <= 0 && steer.distance < spitRange) {
        world.hazards.push({ id: newId(world), kind: 'spit', x: world.hero.x, z: world.hero.z, radius: splashRadius, damage: splashDamage, timer: telegraph, duration: telegraph });
        emit(world, 'spit', { x: zombie.x, z: zombie.z });
        zombie.modeTimer = spitInterval;
      }
      if (steer.distance > keepDistance + SPITTER_SLACK.far) return { ...steer, speed: row.speed };
      if (steer.distance < keepDistance - SPITTER_SLACK.near) {
        const away = headingTo(world.hero, zombie);
        return { ...away, speed: row.speed * RETREAT_SPEED_FACTOR };
      }
      return STILL;
    },
    // Walks up to the hero and goes down on its own, which lights its fuse (ON_DOWN.burst).
    burst(world, zombie, row) {
      const steer = steerToHero(world, zombie);
      if (steer.distance < row.tuning.triggerRange) downZombie(world, zombie);
      return { ...steer, speed: row.speed };
    },
    // Ignores the flow field: straight at the hero through anything, weaving from side to side.
    drift(world, zombie, row) {
      const toHero = headingTo(zombie, world.hero);
      const sway = Math.sin(zombie.age * row.tuning.swayRate) * row.tuning.swayWidth * SWAY_WEIGHT;
      // (-z, x) is the heading turned a quarter turn: the sideways axis of the weave.
      const weave = headingTo({ x: 0, z: 0 }, { x: toHero.x - toHero.z * sway, z: toHero.z + toHero.x * sway });
      return { x: weave.x, z: weave.z, speed: row.speed };
    },
    // The Gravelord: chases, and raises helpers around itself on a timer.
    summon(world, zombie, row) {
      const { summonInterval, summonCount, summonKind, summonRadius } = row.tuning;
      if (zombie.modeTimer <= 0) {
        zombie.modeTimer = summonInterval;
        Array.from({ length: summonCount }, () => ({ x: zombie.x + world.rng.range(-summonRadius, summonRadius), z: zombie.z + world.rng.range(-summonRadius, summonRadius) }))
          // A helper that would rise inside a wall rises at the Gravelord's feet instead.
          .map((point) => (Kit.crowd.isCircleBlocked(world.grid, isBlockedCell, point.x, point.z, MAX_COLLISION_RADIUS) ? zombie : point))
          .forEach((point) => spawnZombie(world, summonKind, point));
        emit(world, 'summon', { x: zombie.x, z: zombie.z, radius: summonRadius });
      }
      return { ...steerToHero(world, zombie), speed: row.speed };
    },
  };

  /** Advances one zombie: timers, its behaviour's wish, slow aura, knockback, collision, and its melee hit. */
  function stepZombie(world, zombie, dt) {
    const row = zombieRows.byId(zombie.kind);
    const { hero, stats } = world;
    zombie.age += dt;
    zombie.modeTimer -= dt;
    zombie.touchTimer -= dt;
    zombie.stun -= dt;
    zombie.hitFlash = Math.max(0, zombie.hitFlash - dt * 6);
    const wish = zombie.stun > 0 ? STILL : ZOMBIE_BEHAVIOURS[row.behaviour](world, zombie, row);
    if (zombie.isDown) return;
    const isInAura = distanceBetween(zombie, hero) < HERO.slowAuraRadius;
    const pace = wish.speed * world.tier.speed * (1 - (isInAura ? Math.min(HERO.maxSlow, stats.get('slowAura')) : 0));
    const delta = { x: (wish.x * pace + zombie.pushX) * dt, z: (wish.z * pace + zombie.pushZ) * dt };
    const moved = row.isGhost ? { x: zombie.x + delta.x, z: zombie.z + delta.z } : Kit.crowd.slide(world.grid, isBlockedCell, zombie, delta, Math.min(row.radius, MAX_COLLISION_RADIUS));
    const pushKept = Math.exp(-PUSH_DECAY * dt);
    Object.assign(zombie, moved, { pushX: zombie.pushX * pushKept, pushZ: zombie.pushZ * pushKept });
    if (wish.speed > 0) zombie.facing = Math.atan2(wish.x, wish.z);
    const isTouching = distanceBetween(zombie, hero) < row.radius + HERO.radius + TOUCH_REACH;
    if (row.touch > 0 && isTouching && zombie.touchTimer <= 0 && zombie.stun <= 0) {
      zombie.touchTimer = row.touchInterval;
      emit(world, 'bite', { x: zombie.x, z: zombie.z });
      damageHero(world, row.touch);
    }
  }

  /**
   * Pushes overlapping zombies apart so a crowd reads as bodies, not one blob. Each zombie asks the spatial hash for
   * the zombies in the buckets around it and handles every pair once (from the side of the lower id). Positions
   * shift a little during the pass while the hash still holds where they started; overlaps are small, so that
   * staleness never hides a neighbour that matters.
   * Hot path: plain loops, and the only allocation is the neighbour list per zombie.
   * @complexity O(n) expected time for an evenly spread crowd of n (O(n squared) only if all share one bucket); O(n) space.
   */
  function separateZombies(world, dt) {
    const { zombies, neighbours } = world;
    neighbours.fill(zombies);
    for (let index = 0; index < zombies.length; index++) {
      const zombie = zombies[index];
      const radius = zombieRows.byId(zombie.kind).radius;
      const nearby = neighbours.near(zombie.x, zombie.z, NEIGHBOUR_BUCKET);
      for (let nearIndex = 0; nearIndex < nearby.length; nearIndex++) {
        const other = nearby[nearIndex];
        if (other.id <= zombie.id) continue;
        const gapX = other.x - zombie.x, gapZ = other.z - zombie.z;
        const distance = Math.hypot(gapX, gapZ) || MIN_GAP;
        const overlap = radius + zombieRows.byId(other.kind).radius - distance;
        if (overlap <= 0) continue;
        // Each of the pair takes half of the correction, along the line between them.
        const shove = (overlap * SEPARATION_STRENGTH * dt) / distance / 2;
        zombie.x -= gapX * shove; zombie.z -= gapZ * shove;
        other.x += gapX * shove; other.z += gapZ * shove;
      }
    }
  }

  /** Spawns on the schedule: the mini-boss when its time comes, and one zombie per interval while the field is under its cap; on higher tiers every Nth is an elite. */
  function stepSpawner(world, dt) {
    if (world.time >= world.nextBossAt) {
      world.nextBossAt += BOSS.every;
      spawnBoss(world);
    }
    world.spawnTimer -= dt;
    if (world.spawnTimer > 0 || world.zombies.length >= Math.floor(curves.maxAlive(world.time))) return;
    world.spawnTimer = curves.spawnInterval(world.time);
    const pick = world.spawnTable.next(world.time);
    if (!pick) return;
    world.spawnCount++;
    const { eliteEvery } = world.tier;
    spawnZombie(world, pick.kind, pickSpawnPoint(world), eliteEvery > 0 && world.spawnCount % eliteEvery === 0);
  }

  // ---- hero ------------------------------------------------------------------------------------------------------

  /** The Ward Pulse: shoves and stuns every zombie in its radius, and hurts them if a power gave it damage. */
  function pulse(world) {
    const { hero, stats } = world;
    const radius = stats.get('pulseRadius');
    emit(world, 'pulse', { x: hero.x, z: hero.z, radius });
    zombiesWithin(world, hero, radius).forEach((zombie) => {
      const away = headingTo(hero, zombie);
      Object.assign(zombie, { pushX: away.x * stats.get('pulseKnock'), pushZ: away.z * stats.get('pulseKnock'), stun: HERO.pulseStun });
      if (stats.get('pulseDamage') > 0) damageZombie(world, zombie, stats.get('pulseDamage'), 'pulse');
    });
  }

  /** The tap ability: Quickstep first when the hero has it (the pulse then lands where the dash ends), else the pulse at once. */
  function useAbility(world) {
    const { hero, stats } = world;
    hero.cooldownTimer = stats.get('cooldown');
    const dashRange = stats.get('dashRange');
    if (dashRange <= 0) return pulse(world);
    const dashSpeed = dashRange / HERO.dashSeconds;
    hero.dash = { timeLeft: HERO.dashSeconds, velocityX: hero.facingX * dashSpeed, velocityZ: hero.facingZ * dashSpeed, burned: [] };
    emit(world, 'dash', { x: hero.x, z: hero.z });
  }

  /** Moves the dashing hero; Blightstep burns each zombie passed once; the pulse fires when the dash ends. */
  function stepDash(world, dt) {
    const { hero, stats } = world;
    const { dash } = hero;
    Object.assign(hero, Kit.crowd.slide(world.grid, isBlockedCell, hero, { x: dash.velocityX * dt, z: dash.velocityZ * dt }, HERO.radius));
    if (stats.get('dashAcid') > 0) {
      zombiesWithin(world, hero, HERO.dashHitRadius)
        .filter((zombie) => !dash.burned.includes(zombie))
        .forEach((zombie) => {
          dash.burned.push(zombie);
          damageZombie(world, zombie, stats.get('acidDamage') * HERO.dashAcidPower, 'dash');
        });
    }
    dash.timeLeft -= dt;
    if (dash.timeLeft > 0) return;
    hero.dash = null;
    pulse(world);
  }

  /** Advances the hero: timers, regeneration, walking or dashing, and the tap ability. */
  function stepHero(world, input, dt) {
    const { hero, stats } = world;
    ['attackTimer', 'cooldownTimer', 'acidTimer', 'graceTimer', 'phaseTimer', 'phaseCooldownTimer'].forEach((timer) => (hero[timer] = Math.max(0, hero[timer] - dt)));
    // Regeneration can be negative (a Ravenous curse); it drains but never finishes the hero off.
    hero.hp = Math.min(stats.get('maxHp'), Math.max(1, hero.hp + stats.get('regen') * dt));
    if (hero.dash) return stepDash(world, dt);
    const strength = Math.hypot(input.moveX, input.moveZ);
    if (strength > 0) {
      Object.assign(hero, { facingX: input.moveX / strength, facingZ: input.moveZ / strength });
      Object.assign(hero, Kit.crowd.slide(world.grid, isBlockedCell, hero, { x: input.moveX * stats.get('speed') * dt, z: input.moveZ * stats.get('speed') * dt }, HERO.radius));
    }
    if (input.wantsPulse && hero.cooldownTimer <= 0) useAbility(world);
  }

  /**
   * How a weapon delivers its hit, keyed by the weapon row's `pattern`.
   * Each takes (world, target, damage, weapon, reach) where target is the nearest zombie in reach.
   */
  const ATTACK_PATTERNS = {
    single: (world, target, damage) => damageZombie(world, target, damage, 'weapon'),
    sweep: (world, target, damage, weapon, reach) => zombiesWithin(world, world.hero, reach).forEach((zombie) => damageZombie(world, zombie, damage, 'weapon')),
    bolt(world, target, damage, weapon, reach) {
      const aim = headingTo(world.hero, target);
      world.shots.push({ id: newId(world), kind: 'bolt', x: world.hero.x, z: world.hero.z, velocityX: aim.x * weapon.speed, velocityZ: aim.z * weapon.speed, damage, life: reach / weapon.speed, pierce: 0, struck: [] });
    },
    // The chain: hit the target, then jump to the nearest zombie not yet hit, losing damage with every jump.
    arc(world, target, damage, weapon) {
      const chain = Array.from({ length: weapon.jumps }).reduce((links) => {
        const next = nearestZombie(world, links[links.length - 1], ARC_JUMP_RANGE, links);
        return next ? [...links, next] : links;
      }, [target]);
      emit(world, 'arc', { points: [world.hero, ...chain].map(({ x, z }) => ({ x, z })) });
      chain.forEach((zombie, jump) => damageZombie(world, zombie, damage * Math.pow(weapon.falloff, jump), 'weapon'));
    },
  };

  /** The automatic weapon attack on the nearest zombie in reach, and the Reaping Arc capstone's every-Nth sweep. */
  function stepAttack(world) {
    const { hero, stats } = world;
    if (hero.attackTimer > 0 || hero.dash) return;
    const weapon = weaponRows.byId(world.weaponId);
    const reach = weapon.reach * stats.get('reach');
    const target = nearestZombie(world, hero, reach);
    if (!target) return;
    hero.attackTimer = weapon.interval / stats.get('attackRate');
    hero.attackCount++;
    const reapEvery = stats.get('reapEvery');
    const isReap = reapEvery > 0 && hero.attackCount % reapEvery === 0;
    const aim = headingTo(hero, target);
    emit(world, 'attack', { pattern: isReap ? 'sweep' : weapon.pattern, isReap, x: hero.x, z: hero.z, aimX: aim.x, aimZ: aim.z, reach });
    ATTACK_PATTERNS[isReap ? 'sweep' : weapon.pattern](world, target, stats.get('damage') * weapon.power * (isReap ? REAP_POWER : 1), weapon, reach);
  }

  /** Acid Spit: a bolt at the nearest zombie on a fixed rhythm, once the power is held. */
  function stepAcid(world) {
    const { hero, stats } = world;
    if (stats.get('acidDamage') <= 0 || hero.acidTimer > 0) return;
    const target = nearestZombie(world, hero, HERO.acidRange);
    if (!target) return;
    hero.acidTimer = HERO.acidInterval;
    const aim = headingTo(hero, target);
    world.shots.push({ id: newId(world), kind: 'acid', x: hero.x, z: hero.z, velocityX: aim.x * ACID_SHOT.speed, velocityZ: aim.z * ACID_SHOT.speed, damage: stats.get('acidDamage'), life: HERO.acidRange / ACID_SHOT.speed, pierce: ACID_SHOT.pierce, struck: [] });
    emit(world, 'acid', { x: hero.x, z: hero.z });
  }

  /** Flies the hero's shots: each hurts the zombies it reaches (once each) until its pierce or its life runs out, and stops at walls. */
  function stepShots(world, dt) {
    world.shots.forEach((shot) => {
      shot.x += shot.velocityX * dt;
      shot.z += shot.velocityZ * dt;
      shot.life -= dt;
      zombiesWithin(world, shot, SHOT_RADIUS)
        .filter((zombie) => !shot.struck.includes(zombie))
        .slice(0, shot.pierce + 1 - shot.struck.length)
        .forEach((zombie) => {
          shot.struck.push(zombie);
          damageZombie(world, zombie, shot.damage, shot.kind);
        });
      const cell = world.grid.fromWorld(shot.x, shot.z);
      if (shot.struck.length > shot.pierce || !cell || isBlockedCell(world.grid.get(cell.x, cell.y))) shot.life = 0;
    });
    world.shots = world.shots.filter((shot) => shot.life > 0);
  }

  /** Counts down telegraphed blasts (spitter globs, bloater bursts); when one goes off it hurts the hero if still inside. */
  function stepHazards(world, dt) {
    world.hazards.forEach((hazard) => {
      hazard.timer -= dt;
      if (hazard.timer > 0) return;
      emit(world, 'blast', { kind: hazard.kind, x: hazard.x, z: hazard.z, radius: hazard.radius });
      if (distanceBetween(hazard, world.hero) < hazard.radius + HERO.radius) damageHero(world, hazard.damage);
    });
    world.hazards = world.hazards.filter((hazard) => hazard.timer > 0);
  }

  // ---- souls, drops, chests --------------------------------------------------------------------------------------

  /**
   * Grants a cleansed soul: points (more for elites, higher tiers and a running streak), absorb progress, Siphon's
   * heal and the Sanctum capstone's free pulse. A streak is souls cleansed within SOULS.streakWindow of each other:
   * every soul after the first pays a bonus, which rewards downing a group and then holding the ground to cleanse it.
   */
  function cleanseSoul(world, soul) {
    const { hero, stats, absorb, streak, tier } = world;
    streak.count = streak.timer > 0 ? streak.count + 1 : 1;
    streak.timer = SOULS.streakWindow;
    world.tally.bestStreak = Math.max(world.tally.bestStreak, streak.count);
    const worth = zombieRows.byId(soul.kind).souls * (soul.isElite ? ELITE.souls : 1) * stats.get('soulGain') * tier.souls;
    const points = Math.max(1, Math.round(worth)) + (streak.count > 1 ? SOULS.streakBonus : 0);
    absorb.meter++;
    absorb.cleansedKinds[soul.kind] = (absorb.cleansedKinds[soul.kind] || 0) + 1;
    world.tally.cleansed++;
    hero.hp = Math.min(stats.get('maxHp'), hero.hp + stats.get('cleanseHeal'));
    emit(world, 'cleanse', { x: soul.x, z: soul.z, kind: soul.kind, points, streak: streak.count });
    if (stats.get('cleansePulse') > 0) pulse(world);
  }

  /**
   * Ages souls and channels the nearest one in reach. Only one soul is channelled at a time; every other soul's
   * progress drains, so walking away interrupts a cleanse instead of banking it.
   */
  function stepSouls(world, dt) {
    const { hero, stats } = world;
    world.streak.timer = Math.max(0, world.streak.timer - dt);
    const channelled = hero.dash
      ? null
      : world.souls.reduce((best, soul) => {
          const gap = distanceBetween(soul, hero);
          return gap <= SOULS.cleanseRadius && (!best || gap < distanceBetween(best, hero)) ? soul : best;
        }, null);
    world.souls.forEach((soul) => {
      soul.life -= dt;
      const rate = soul === channelled ? stats.get('cleanseSpeed') / SOULS.cleanseSeconds : -SOULS.decayRate;
      soul.progress = Math.max(0, soul.progress + rate * dt);
    });
    world.souls.filter((soul) => soul.progress >= 1).forEach((soul) => cleanseSoul(world, soul));
    world.souls = world.souls.filter((soul) => soul.progress < 1 && soul.life > 0);
  }

  /** Picks up drops the hero walks over and opens chests the hero reaches. */
  function stepPickups(world) {
    const { hero } = world;
    const [taken, left] = world.drops.reduce((split, drop) => (split[distanceBetween(drop, hero) <= HERO.pickupRadius ? 0 : 1].push(drop), split), [[], []]);
    taken.forEach((drop) => emit(world, 'pickup', { drop }));
    world.drops = left;
    world.chests
      .filter((chest) => !chest.isOpen && distanceBetween(chest, hero) <= CHEST_RADIUS)
      .forEach((chest) => {
        chest.isOpen = true;
        emit(world, 'chest', { x: chest.x, z: chest.z });
        // The item lands a step toward the hero, so it is seen on the ground before it is picked up.
        const toward = headingTo(chest, hero);
        spawnDrop(world, { x: chest.x + toward.x * (CHEST_RADIUS + HERO.pickupRadius * 0.5), z: chest.z + toward.z * (CHEST_RADIUS + HERO.pickupRadius * 0.5) }, LOOT.chestLuck);
      });
  }

  /** Rebuilds the crowd's flow field when the hero has moved to another cell (one search per cell change, not per frame). */
  function refreshField(world) {
    const cell = world.grid.fromWorld(world.hero.x, world.hero.z);
    const key = cell ? cell.y * world.grid.w + cell.x : -1;
    if (!cell || key === world.fieldCellKey) return;
    world.fieldCellKey = key;
    world.field = Kit.crowd.flow(world.grid, [cell], isOpenCell);
  }

  /**
   * Advances the whole world by `dt` seconds and appends what happened to world.events.
   * @param {Object} world     from createWorld
   * @param {SimInput} input
   * @param {number} dt        seconds; keep it at or under 0.05 so nothing tunnels through a cell
   * @complexity O(n + s x n + h) per frame for n zombies, s shots in flight (a few) and h hazards: zombie steering reads
   *             the shared flow field in O(1) each, separation is O(n) expected through the spatial hash, and each shot
   *             scans the zombies once. The flow field itself is rebuilt in O(cells) only when the hero changes cell.
   */
  function step(world, input, dt) {
    if (world.hero.isDead) return;
    world.time += dt;
    refreshField(world);
    stepHero(world, input, dt);
    stepSpawner(world, dt);
    world.zombies.forEach((zombie) => stepZombie(world, zombie, dt));
    separateZombies(world, dt);
    stepAttack(world);
    stepAcid(world);
    stepShots(world, dt);
    stepHazards(world, dt);
    stepSouls(world, dt);
    stepPickups(world);
    world.zombies = world.zombies.filter((zombie) => !zombie.isDown);
  }

  window.SOULWAKE_SIM = { createWorld, step, generateGraveyard, buildAbsorbPool, absorbNeed, bankValue, finishAbsorbRoll, salvageValue, zombieRows, weaponRows };
})();
