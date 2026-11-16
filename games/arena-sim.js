/**
 * Swarm Arena, simulation: a run as plain data, stepped by pure-ish functions (they change the run they are given
 * and nothing else).
 *
 * Owns: `Arena.sim` - creating a run from a loadout, stepping it one frame, rolling and taking level-up hands,
 *       summarising it; and `Arena.meta` - the permanent profile (Kit.profile) and what a finished run adds to it.
 * Does not own: the numbers (games/arena-data.js), anything visible or audible (games/arena.js answers the `cues`
 *       this file fires), or the bots that play it headlessly (games/arena-bots.js).
 *       No THREE, no DOM: runs in node.
 *
 * How a frame flows: `step(run, dt, control, cues)` files every enemy in a spatial hash, then advances the hero, the
 * director (spawns, elites, boss), the weapons, the enemies, the shots, the blasts, the mines and the gems. Whatever
 * the player could see or hear is reported through `cues`, a table of callbacks; missing cues are simply not fired.
 */
(() => {
  const { rand, damp, clamp, shuffle, pick, TAU } = Kit.math;
  const DATA = window.Arena.data;
  const { CAPACITY, HERO, DASH, GRAZE, FOCUS, SHOT, BLADE, PULSE, MINE, GEM, CHAIN, ENEMIES, AFFIXES, ELITE, BOSS, PACE, ENEMY, LEVEL_UP } = DATA;
  const SPAWN_TABLE = Kit.spawnTable(ENEMIES);

  // =====================================================================================================================
  // Pure helpers: numbers in, numbers out.
  // =====================================================================================================================

  /**
   * Calls `make(index)` `count` times and collects the results; the functional stand-in for a counting loop.
   * @template T
   * @param {number} count negative counts are treated as 0
   * @param {function(number): T} make
   * @returns {T[]}
   */
  const times = (count, make) => Array.from({ length: Math.max(0, Math.floor(count)) }, (unused, index) => make(index));

  /**
   * The signed shortest turn from one heading to another, so the ship never spins the long way round.
   * @param {number} from radians
   * @param {number} to radians
   * @returns {number} radians in [-PI, PI)
   */
  const shortestTurn = (from, to) => ((((to - from + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

  /**
   * The headings of a fan of shots centred on `centre`.
   * @param {number} centre radians
   * @param {number} count shots in the fan
   * @param {number} spread radians between neighbours
   * @returns {number[]}
   */
  const fanAngles = (centre, count, spread) => times(count, (index) => centre + (index - (count - 1) / 2) * spread);

  /**
   * @typedef {Object} ShotLook
   * @property {number} width   world units
   * @property {number} length  world units
   * @property {number} speed   world units per second
   * @property {boolean} isLance piercing shots are drawn (and coloured) as beams
   */

  /**
   * What a shot looks like is derived from the build: damage fattens it, pierce turns it into a long lance.
   * @param {Object} build a HeroBuild
   * @returns {ShotLook}
   */
  const shotLookOf = (build) => {
    const isLance = build.pierce > 0;
    return {
      // Area, not width, tracks damage: doubling damage should not double the apparent size.
      width: SHOT.width * Math.sqrt(build.damage / DATA.HERO_BASE.damage) * build.shotWidth,
      length: isLance ? Math.min(SHOT.mostLanceLength, SHOT.lanceLength + build.pierce * SHOT.lanceLengthPerPierce) : SHOT.length,
      speed: isLance ? SHOT.lanceSpeed : SHOT.speed,
      isLance,
    };
  };

  /**
   * Adds experience and works out how many levels that crosses.
   * @param {number} level current level
   * @param {number} xp experience already banked toward the next level
   * @param {number} gained experience to add
   * @returns {{ level: number, xp: number, levelsGained: number }}
   */
  const addExperience = (level, xp, gained) => {
    let reached = level;
    let banked = xp + gained;
    // One big gem can cross several levels at once; each crossing pays that level's own price.
    while (banked >= DATA.XP_TO_NEXT_LEVEL(reached)) {
      banked -= DATA.XP_TO_NEXT_LEVEL(reached);
      reached++;
    }
    return { level: reached, xp: banked, levelsGained: reached - level };
  };

  /**
   * A random point just outside the visible rectangle, for spawning out of sight.
   * @param {{ x: number, z: number, halfWidth: number, halfHeight: number }} view what the camera shows, world units
   * @param {number} margin how far outside the edge
   * @returns {{ x: number, z: number }}
   */
  const pointBeyondView = (view, margin) => {
    const halfWidth = view.halfWidth + margin;
    const halfHeight = view.halfHeight + margin;
    const along = rand(-1, 1);
    const side = rand() < 0.5 ? -1 : 1;
    // Pick a left/right edge in proportion to its length, so spawns are even around the perimeter.
    const isOnSideEdge = rand(halfWidth + halfHeight) < halfHeight;
    return {
      x: view.x + (isOnSideEdge ? side * halfWidth : along * halfWidth),
      z: view.z + (isOnSideEdge ? along * halfHeight : side * halfHeight),
    };
  };

  /**
   * Where each orbiting blade is, relative to the hero.
   * @param {number} ringAngle radians the ring has turned
   * @param {number} count blades, evenly spaced
   * @param {number} radius world units
   * @returns {{ x: number, z: number, angle: number }[]}
   */
  const bladeOffsets = (ringAngle, count, radius) =>
    times(count, (index) => {
      const angle = ringAngle + (index / count) * TAU;
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, angle };
    });

  /** Fires a cue if the presentation (or a bot) listens for it. */
  const fire = (cues, name, first, second) => {
    if (cues[name]) cues[name](first, second);
  };

  // =====================================================================================================================
  // The run: models (stats, upgrades, synergies) plus the world's plain data.
  // =====================================================================================================================

  /**
   * @typedef {Object} Enemy
   * @property {Object} type            its EnemyType row
   * @property {number} serial          unique per run; orders a pair so separation handles each pair once
   * @property {number} x
   * @property {number} z               position, world units
   * @property {number} pushX
   * @property {number} pushZ           knockback velocity, decays
   * @property {number} hp
   * @property {number} maxHp
   * @property {number} size            radius (elites are larger than their type)
   * @property {number} speed
   * @property {number} touch           contact damage
   * @property {number} xp
   * @property {number} [armorCap]      most damage one hit can do (armoured elites)
   * @property {Object} [blast]         left where it dies (volatile elites)
   * @property {boolean} isElite
   * @property {Object[]} affixes       Affix rows
   * @property {boolean} isDead         set on death; the list is compacted at the end of the frame
   * @property {number} flashFor        seconds its hit flash still shows
   * @property {number} age             seconds alive
   * @property {number} angle           drawn rotation, radians
   * @property {number} phase           per-enemy offset into its steer path and pulse
   * @property {number} bladeCooldown   seconds until a blade may hit it again
   * @property {boolean} isGrazing      inside the graze band, having entered while the hero was vulnerable
   * @property {'approach'|'tell'|'dash'|'recover'} mode  charge state ('approach' for everything that never charges)
   * @property {number} modeFor         seconds left in the mode
   * @property {number} dirX
   * @property {number} dirZ            the locked direction of a charge
   * @property {number} attackIn        seconds until the boss's next attack
   * @property {number} attackIndex     where the boss is in its attack cycle
   * @property {number} lastRamDash     id of the last dash that rammed it, so one dash hits it once
   */

  /**
   * @typedef {Object} World
   * The whole run as plain data.
   * @property {number} seconds        run time; stops when the run is decided
   * @property {number} frame          frames stepped, for every-Nth-frame effects
   * @property {number} wave
   * @property {number} level
   * @property {number} xp
   * @property {number} kills
   * @property {number} elites         elites destroyed
   * @property {number} bossKills
   * @property {number} gemsCollected
   * @property {number} grazes
   * @property {number} evolutions
   * @property {number} pendingLevels  level-ups earned but not yet chosen
   * @property {number} handsRolled
   * @property {number} rerolls        rerolls left
   * @property {number} hp
   * @property {?('dead'|'cleared')} outcome  null while the run is live
   * @property {Object} build          a HeroBuild, refreshed whenever the stats change
   * @property {ShotLook} shotLook     derived from build
   * @property {Object} hero           position, aim, recoil and the dash / focus / invulnerability timers
   * @property {number} arenaRadius    the wall's radius this frame
   * @property {number} fireCooldown
   * @property {number} spawnCooldown
   * @property {number} eliteIn        seconds until the next elite
   * @property {boolean} hasBossArrived
   * @property {boolean} hasBossWarned
   * @property {number} bossesAlive
   * @property {number} bladeAngle     where the blade ring has turned to, radians
   * @property {number} pulseIn        seconds until the next pulse
   * @property {number} mineIn         seconds until the next mine drop
   * @property {number} killCombo
   * @property {number} killComboTimer
   * @property {number} gemStreak
   * @property {number} sinceHurt      seconds since anything last hit the hero
   * @property {number} nextSerial
   * @property {{ x: number, z: number, halfWidth: number, halfHeight: number }} view what the camera shows; the
   *   presentation (or a bot) keeps it current, the spawner reads it
   * @property {Enemy[]} enemies
   * @property {Object[]} shots
   * @property {Object[]} gems
   * @property {Object[]} blasts       delayed area hits: { x, z, radius, fuse, total, damage }
   * @property {Object[]} mines        { x, z, age }
   * @property {Object} hash           Kit.spatialHash over the live enemies, rebuilt every frame
   * @property {number} largestEnemyRadius the largest live body this frame; spatial queries are padded by it
   */

  /**
   * @typedef {Object} Run
   * @property {World} world
   * @property {Object} ship      Ship row
   * @property {Object} arena     ArenaRules row
   * @property {Object} tier      Tier row
   * @property {Object} stats     Kit.stats over the hero's numbers
   * @property {Object} upgrades  Kit.upgrades over the rows this profile has unlocked
   * @property {Object} synergies Kit.synergy over SYNERGIES
   */

  /**
   * @typedef {Object} Control
   * @property {number} x      -1..1, right is positive
   * @property {number} y      -1..1, down the screen (+z) is positive
   * @property {boolean} dash  true on the frame a dash is asked for
   */

  /** @returns {Object} a HeroBuild: a plain snapshot of the stats, so the hot loops read properties, not a Map. */
  const readBuild = (stats) => Object.keys(DATA.HERO_BASE).reduce((build, name) => ({ ...build, [name]: stats.get(name) }), {});

  /**
   * Re-reads the build after the stats changed and keeps hit points inside the new maximum.
   * @param {Run} run
   */
  const refreshBuild = (run) => {
    const { world } = run;
    world.build = readBuild(run.stats);
    world.shotLook = shotLookOf(world.build);
    world.hp = Math.min(world.hp, world.build.maxHp);
  };

  /**
   * Starts a run.
   * @param {Object} [options]
   * @param {string} [options.shipId]   a SHIPS id (default: the Dart)
   * @param {string} [options.arenaId]  an ARENAS id (default: the Proving Ring)
   * @param {string} [options.tierId]   a TIERS id (default: Threat I)
   * @param {string[]} [options.unlocked] unlock ids the profile holds; rows gated on others are left out of the pool
   * @param {number} [options.rerolls]  rerolls to start with
   * @returns {Run}
   * @throws {Error} on an unknown ship, arena or tier id (Kit.table names the id)
   * @example const run = Arena.sim.createRun({ shipId: 'anvil', unlocked: profile.unlocked() });
   */
  const createRun = ({ shipId = DATA.DEFAULT_LOADOUT.shipId, arenaId = DATA.DEFAULT_LOADOUT.arenaId, tierId = DATA.DEFAULT_LOADOUT.tierId, unlocked = [], rerolls = 0 } = {}) => {
    const ship = DATA.SHIPS.byId(shipId);
    const arena = DATA.ARENAS.byId(arenaId);
    const tier = DATA.TIERS.byId(tierId);
    const stats = Kit.stats({ ...DATA.HERO_BASE, ...ship.base }, { limits: DATA.HERO_LIMITS });
    const isOpen = (row) => !row.unlock || unlocked.includes(row.unlock);
    // An evolution is only in the pool when both of its parents are: Kit.upgrades refuses rules about rows it does not hold.
    const pool = DATA.UPGRADES.filter((row) => isOpen(row) && [].concat(row.requiresMax || []).every((parentId) => isOpen(DATA.UPGRADES.find((parent) => parent.id === parentId))));
    const upgrades = Kit.upgrades(pool, { stats, slots: ship.slots });
    const synergies = Kit.synergy(DATA.SYNERGIES, { stats });
    const build = readBuild(stats);
    const world = {
      seconds: 0, frame: 0, wave: 1,
      level: 1, xp: 0, kills: 0, elites: 0, bossKills: 0, gemsCollected: 0, grazes: 0, evolutions: 0,
      pendingLevels: 0, handsRolled: 0, rerolls,
      hp: build.maxHp, outcome: null, build, shotLook: shotLookOf(build),
      hero: { x: 0, z: 0, aim: 0, aimTarget: 0, headingX: 0, headingZ: 1, recoil: 0, invulnerableFor: 0, dashFor: 0, dashX: 0, dashZ: 0, dashCooldown: 0, dashId: 0, focus: 0 },
      arenaRadius: arena.radius(0),
      fireCooldown: HERO.firstShotDelay, spawnCooldown: 0, eliteIn: ELITE.firstAt,
      hasBossArrived: false, hasBossWarned: false, bossesAlive: 0,
      bladeAngle: 0, pulseIn: PULSE.interval, mineIn: MINE.interval,
      killCombo: 0, killComboTimer: 0, gemStreak: 0, sinceHurt: 99, nextSerial: 0,
      view: { x: 0, z: 0, halfWidth: 7.5, halfHeight: 15 },
      enemies: [], shots: [], gems: [], blasts: [], mines: [],
      hash: Kit.spatialHash(DATA.HASH_CELL_SIZE), largestEnemyRadius: 0,
    };
    const run = { world, ship, arena, tier, stats, upgrades, synergies };
    ship.startUpgrades.forEach((id) => upgrades.grant(id));
    synergies.update(upgrades.owned());
    refreshBuild(run);
    world.hp = world.build.maxHp;
    spawnOpening(run);
    return run;
  };

  // =====================================================================================================================
  // Spawning.
  // =====================================================================================================================

  /**
   * Adds an enemy unless the arena is full.
   * @param {Run} run
   * @param {Object} type an EnemyType row
   * @param {number} x
   * @param {number} z
   * @param {{ hpScale?: number, affixes?: Object[], isElite?: boolean }} [options]
   * @returns {?Enemy} null when the arena is at capacity
   */
  const spawnEnemy = (run, type, x, z, { hpScale = 1, affixes = [], isElite = false } = {}) => {
    const { world, tier } = run;
    if (world.enemies.length >= CAPACITY.enemies) return null;
    const elite = isElite ? ELITE : { hpScale: 1, sizeScale: 1, xpScale: 1, touchScale: 1 };
    // Bosses ignore the time curve: they always arrive at the same moment, so only the tier scales them.
    const timeScale = type.isBoss ? 1 : PACE.hpScale(world.seconds);
    const hp = type.hp * timeScale * tier.hpScale * hpScale * elite.hpScale;
    const affixValue = (name, combine, start) => affixes.filter((affix) => affix[name] !== undefined).reduce((value, affix) => combine(value, affix[name]), start);
    const enemy = {
      type, serial: world.nextSerial++, x, z, pushX: 0, pushZ: 0, hp, maxHp: hp,
      size: type.size * elite.sizeScale,
      speed: type.speed * tier.speedScale * affixValue('speedScale', (value, scale) => value * scale, 1),
      touch: type.touch * tier.touchScale * elite.touchScale,
      xp: type.xp * elite.xpScale,
      armorCap: affixValue('armorCap', Math.min, Infinity),
      blast: affixValue('blast', (value, blast) => blast, null),
      isElite, affixes, isDead: false, flashFor: 0, age: 0, angle: rand(TAU), phase: rand(TAU), bladeCooldown: 0, isGrazing: false,
      mode: 'approach', modeFor: 0, dirX: 0, dirZ: 1, attackIn: BOSS.attackSeconds, attackIndex: 0, lastRamDash: -1,
    };
    world.enemies.push(enemy);
    return enemy;
  };

  /**
   * The opening ring: weak grunts already closing in at second 0, so there is something to shoot at once.
   * @param {Run} run
   */
  const spawnOpening = (run) => {
    const { count, typeId, hpScale, ringRadius, nearZ, farZ, angleOffset } = PACE.opening;
    times(count, (index) => {
      const angle = (index / count) * TAU + angleOffset;
      // Stretched along z because a portrait screen is taller than it is wide.
      spawnEnemy(run, ENEMIES.byId(typeId), Math.cos(angle) * ringRadius, Math.sin(angle) * rand(nearZ, farZ), { hpScale });
    });
  };

  /**
   * Spawns `count` enemies scattered around a point.
   * @param {Run} run
   * @param {function(): Object} typeOf picks the EnemyType of each
   * @param {number} count
   * @param {{ x: number, z: number }} centre
   * @param {number} scatter world units each way
   */
  const spawnPack = (run, typeOf, count, centre, scatter) => times(count, () => spawnEnemy(run, typeOf(), centre.x + rand(-scatter, scatter), centre.z + rand(-scatter, scatter)));

  /**
   * The director: tops the swarm up toward the pacing target, opens each wave with a pack, sends elites on the
   * arena's clock and the boss at its appointed second.
   * @param {Run} run
   * @param {number} dt seconds
   * @param {Object} cues
   */
  const stepDirector = (run, dt, cues) => {
    const { world, arena, tier } = run;
    world.spawnCooldown -= dt;
    if (world.spawnCooldown <= 0) {
      world.spawnCooldown = PACE.tickSeconds;
      const trickle = arena.trickleScale * (world.bossesAlive ? BOSS.trickleScale : 1);
      // Spawn what is missing, but no more than perTick at once: after a big clear the swarm refills as a stream, not a wall.
      const missing = Math.ceil(PACE.targetCount(world.seconds) * trickle - world.enemies.length);
      times(Math.min(PACE.perTick(world.seconds), missing), () => {
        const point = pointBeyondView(world.view, PACE.spawnMargin);
        spawnEnemy(run, SPAWN_TABLE.pick(world.seconds), point.x, point.z);
      });
    }
    const wave = 1 + Math.floor(world.seconds / arena.waveSeconds);
    if (wave !== world.wave) {
      world.wave = wave;
      fire(cues, 'waveStarted', wave);
      const pack = PACE.wavePack;
      const typeOf = arena.hasMixedPacks ? () => SPAWN_TABLE.pick(world.seconds) : () => ENEMIES.byId(pack.typeId);
      // Wave numbers count faster in arenas with short waves; the pack is sized by elapsed time so arenas compare.
      spawnPack(run, typeOf, pack.count(1 + world.seconds / 20) * arena.packScale, pointBeyondView(world.view, pack.margin), pack.scatter);
    }
    world.eliteIn -= dt;
    if (world.eliteIn <= 0) {
      world.eliteIn = arena.eliteSeconds;
      const point = pointBeyondView(world.view, ELITE.spawnMargin);
      const affixes = shuffle(AFFIXES).slice(0, tier.affixCount);
      const elite = spawnEnemy(run, SPAWN_TABLE.pick(world.seconds), point.x, point.z, { isElite: true, affixes });
      if (elite) fire(cues, 'eliteArrived', elite);
    }
    if (!world.hasBossWarned && world.seconds >= BOSS.at - BOSS.warnSeconds) {
      world.hasBossWarned = true;
      fire(cues, 'bossWarned');
    }
    if (!world.hasBossArrived && world.seconds >= BOSS.at) {
      world.hasBossArrived = true;
      times(tier.bossCount, () => {
        const point = pointBeyondView(world.view, BOSS.spawnMargin);
        // Capacity is checked by spawnEnemy; a boss that could not spawn must not be waited for.
        if (spawnEnemy(run, ENEMIES.byId(BOSS.typeId), point.x, point.z)) world.bossesAlive++;
      });
      fire(cues, 'bossArrived');
    }
  };

  // =====================================================================================================================
  // Damage, death and experience.
  // =====================================================================================================================

  /**
   * Banks experience (scaled by the arena and the threat tier) and records any level-ups for the presentation to offer.
   * @param {Run} run
   * @param {number} amount
   * @param {Object} cues
   */
  const gainExperience = (run, amount, cues) => {
    const { world } = run;
    const result = addExperience(world.level, world.xp, amount * run.arena.xpScale * run.tier.xpScale);
    world.level = result.level;
    world.xp = result.xp;
    world.pendingLevels += result.levelsGained;
    fire(cues, 'xpChanged');
  };

  /**
   * Drops one gem with a random scatter. When the arena is full of gems the experience is banked directly instead,
   * so a huge clear never loses XP.
   */
  const dropGem = (run, x, z, value, cues) => {
    const { world } = run;
    if (world.gems.length >= CAPACITY.gems) return gainExperience(run, value, cues);
    const heading = rand(TAU);
    const speed = rand(GEM.scatterSpeedMin, GEM.scatterSpeedMax);
    world.gems.push({ x, z, driftX: Math.cos(heading) * speed, driftZ: Math.sin(heading) * speed, value, pullSpeed: 0, phase: rand(TAU) });
  };

  /**
   * Schedules a delayed area hit: the circle shows for `fuse` seconds, then hurts the hero if it is still inside.
   * @param {Run} run
   * @param {number} x
   * @param {number} z
   * @param {{ fuse: number, radius: number, damage: number }} blast
   * @param {Object} cues
   */
  const addBlast = (run, x, z, blast, cues) => {
    const { world } = run;
    if (world.blasts.length >= CAPACITY.blasts) return;
    const placed = { x, z, radius: blast.radius, fuse: blast.fuse, total: blast.fuse, damage: blast.damage * run.tier.touchScale };
    world.blasts.push(placed);
    fire(cues, 'blastPlaced', placed);
  };

  /**
   * Marks an enemy dead, scores it and leaves what it leaves: gems, its split, its blast. A dead boss may clear the run.
   * @param {Run} run
   * @param {Enemy} enemy
   * @param {Object} cues
   */
  const killEnemy = (run, enemy, cues) => {
    const { world } = run;
    if (enemy.isDead) return;
    enemy.isDead = true;
    world.killCombo = Math.min(CHAIN.maxKillCombo, world.killCombo + 1);
    world.killComboTimer = CHAIN.killWindowSeconds;
    world.kills++;
    if (enemy.isElite) {
      world.elites++;
      world.rerolls = Math.min(LEVEL_UP.mostRerolls, world.rerolls + ELITE.rerollsGranted);
    }
    fire(cues, 'enemyKilled', enemy, world.killCombo);
    times(Math.ceil(enemy.xp / GEM.maxValue), (gemIndex) => dropGem(run, enemy.x, enemy.z, Math.min(GEM.maxValue, enemy.xp - gemIndex * GEM.maxValue), cues));
    const split = enemy.type.splitsInto;
    if (split) spawnPack(run, () => ENEMIES.byId(split.typeId), split.count, enemy, split.scatter);
    if (enemy.blast) addBlast(run, enemy.x, enemy.z, enemy.blast, cues);
    if (!enemy.type.isBoss) return;
    world.bossKills++;
    world.bossesAlive--;
    if (world.bossesAlive > 0) return;
    world.outcome = 'cleared';
    fire(cues, 'runCleared');
  };

  /**
   * Damages one enemy and knocks it back; kills it at 0 hp.
   * @param {Run} run
   * @param {Enemy} enemy
   * @param {number} damage before the enemy's armour cap
   * @param {number} pushX
   * @param {number} pushZ direction (and relative strength) of the knockback
   * @param {Object} cues
   */
  const damageEnemy = (run, enemy, damage, pushX, pushZ, cues) => {
    if (enemy.isDead) return;
    const knockback = ENEMY.knockbackPerHit * (enemy.type.knockbackScale === undefined ? 1 : enemy.type.knockbackScale);
    enemy.hp -= Math.min(damage, enemy.armorCap);
    enemy.flashFor = ENEMY.hitFlashSeconds;
    enemy.pushX += pushX * knockback;
    enemy.pushZ += pushZ * knockback;
    if (enemy.hp <= 0) return killEnemy(run, enemy, cues);
    fire(cues, 'enemyHit', enemy);
  };

  /**
   * Hits every live enemy whose body reaches into a circle: the level-up nova, the pulse, mines, the dash shockwave
   * and (with no damage) the recoil shove when the hero is hurt.
   * @param {Run} run
   * @param {number} x
   * @param {number} z
   * @param {number} radius world units
   * @param {number} force speed added away from the centre, world units per second
   * @param {number} damage 0 for a pure shove
   * @param {Object} cues
   * @complexity O(enemies in the cells the circle touches) through the spatial hash, not O(all enemies)
   */
  const blastEnemies = (run, x, z, radius, force, damage, cues) => {
    run.world.hash.query(x, z, radius + run.world.largestEnemyRadius, (enemy) => {
      if (enemy.isDead) return;
      const awayX = enemy.x - x;
      const awayZ = enemy.z - z;
      const distance = Math.hypot(awayX, awayZ) || 1; // an enemy exactly on the centre still gets a finite push
      if (distance > radius + enemy.size) return;
      const scale = (force * (enemy.type.knockbackScale === undefined ? 1 : enemy.type.knockbackScale)) / distance;
      enemy.pushX += awayX * scale;
      enemy.pushZ += awayZ * scale;
      if (damage) damageEnemy(run, enemy, damage, 0, 0, cues);
    });
  };

  /**
   * Changes hit points, clamped to 0..maxHp.
   * @param {Run} run
   * @param {number} amount negative to hurt
   * @param {Object} cues
   */
  const healHero = (run, amount, cues) => {
    const { world } = run;
    world.hp = clamp(world.hp + amount, 0, world.build.maxHp);
    fire(cues, 'hpChanged');
  };

  /** Ends the run if the hero has no hit points left. */
  const checkDeath = (run, cues) => {
    const { world } = run;
    if (world.hp > 0 || world.outcome) return;
    world.outcome = 'dead';
    fire(cues, 'heroDied');
  };

  /**
   * Something hit the hero: lose hp, gain a moment of invulnerability and shove the crowd back so one touch is one hit.
   * @param {Run} run
   * @param {number} damage
   * @param {Object} cues
   */
  const hurtHero = (run, damage, cues) => {
    const { world } = run;
    const { hero } = world;
    if (hero.invulnerableFor > 0 || world.outcome) return;
    healHero(run, -damage, cues);
    hero.invulnerableFor = HERO.hurtInvulnerableSeconds;
    world.sinceHurt = 0;
    fire(cues, 'heroHurt');
    blastEnemies(run, hero.x, hero.z, HERO.hurtShove.radius, HERO.hurtShove.force, 0, cues);
    checkDeath(run, cues);
  };

  // =====================================================================================================================
  // The hero: movement, dash, graze, focus.
  // =====================================================================================================================

  /**
   * Starts a dash if one is ready: along the stick, or along the last heading when the stick is at rest.
   * @param {Run} run
   * @param {Control} control
   * @param {Object} cues
   */
  const startDash = (run, control, cues) => {
    const { hero, build } = run.world;
    if (hero.dashCooldown > 0 || hero.dashFor > 0) return;
    const deflection = Math.hypot(control.x, control.y);
    hero.dashX = deflection > HERO.stillSpeed ? control.x / deflection : hero.headingX;
    hero.dashZ = deflection > HERO.stillSpeed ? control.y / deflection : hero.headingZ;
    hero.dashFor = DASH.seconds;
    hero.dashCooldown = build.dashCooldown;
    hero.dashId++;
    // Invulnerable through the dash and a breath after it, so landing next to something is not an instant hit.
    hero.invulnerableFor = Math.max(hero.invulnerableFor, DASH.seconds + DASH.graceSeconds);
    fire(cues, 'dashed');
  };

  /**
   * Carries the hero through a dash: rams what it passes (Anvil) and releases the Capacitor's shockwave where it ends.
   */
  const stepDash = (run, dt, cues) => {
    const { world } = run;
    const { hero, build } = world;
    hero.x += hero.dashX * DASH.speed * dt;
    hero.z += hero.dashZ * DASH.speed * dt;
    hero.dashFor -= dt;
    if (build.dashDamage) {
      world.hash.query(hero.x, hero.z, DASH.ramReach + world.largestEnemyRadius, (enemy) => {
        // lastRamDash makes one dash hit each enemy once, however many frames they overlap.
        if (enemy.lastRamDash === hero.dashId || Math.hypot(enemy.x - hero.x, enemy.z - hero.z) > DASH.ramReach + enemy.size) return;
        enemy.lastRamDash = hero.dashId;
        damageEnemy(run, enemy, build.dashDamage * build.damage, hero.dashX, hero.dashZ, cues);
      });
    }
    if (hero.dashFor > 0 || !build.dashNova) return;
    blastEnemies(run, hero.x, hero.z, DASH.novaRadius, DASH.novaForce, build.damage * DASH.novaDamageScale * build.dashNova, cues);
    fire(cues, 'dashNova', DASH.novaRadius);
  };

  /**
   * Moves the hero (stick or dash), holds it inside the wall, and runs its timers, regeneration and focus.
   * @param {Run} run
   * @param {number} dt seconds
   * @param {Control} control
   * @param {Object} cues
   */
  const stepHero = (run, dt, control, cues) => {
    const { world, arena } = run;
    const { hero, build } = world;
    const deflection = Math.hypot(control.x, control.y);
    const isMoving = deflection > HERO.stillSpeed;
    if (isMoving) {
      hero.headingX = control.x / deflection;
      hero.headingZ = control.y / deflection;
    }
    hero.dashCooldown = Math.max(0, hero.dashCooldown - dt);
    if (control.dash) startDash(run, control, cues);
    if (hero.dashFor > 0) stepDash(run, dt, cues);
    else {
      hero.x += control.x * build.speed * dt;
      hero.z += control.y * build.speed * dt;
    }
    const distanceFromCentre = Math.hypot(hero.x, hero.z);
    if (distanceFromCentre > world.arenaRadius) {
      // Soft wall: you can lean into it; the overshoot decays exponentially, so it eases you back instead of stopping you dead.
      const eased = world.arenaRadius + (distanceFromCentre - world.arenaRadius) * Math.exp(-HERO.wallSoftness * dt);
      hero.x *= eased / distanceFromCentre;
      hero.z *= eased / distanceFromCentre;
      if (arena.wallDamage) {
        // A burning wall ignores invulnerability: it is a place you must leave, not a hit you can dodge.
        healHero(run, -arena.wallDamage * dt, cues);
        fire(cues, 'wallBurned');
        checkDeath(run, cues);
      }
    }
    // Focus builds while the ship holds still and is lost the moment it moves.
    hero.focus = isMoving || hero.dashFor > 0 ? 0 : Math.min(1, hero.focus + dt / FOCUS.rampSeconds);
    if (build.regen && world.hp < build.maxHp) {
      const before = Math.ceil(world.hp);
      world.hp = Math.min(build.maxHp, world.hp + build.regen * dt);
      // Regeneration ticks every frame; only tell the HUD when the number it shows changes.
      if (Math.ceil(world.hp) !== before) fire(cues, 'hpChanged');
    }
    hero.invulnerableFor = Math.max(0, hero.invulnerableFor - dt);
    hero.recoil = damp(hero.recoil, 0, HERO.recoilDamping, dt);
    hero.aim += shortestTurn(hero.aim, hero.aimTarget) * (1 - Math.exp(-HERO.aimTurnRate * dt));
    world.sinceHurt += dt;
    world.killComboTimer -= dt;
    if (world.killComboTimer <= 0) world.killCombo = 0;
    world.gemStreak = Math.max(0, world.gemStreak - dt * CHAIN.gemStreakDecay);
  };

  // =====================================================================================================================
  // Weapons.
  // =====================================================================================================================

  /** Scratch record for the nearest-enemy search, so the hash visitor allocates nothing. */
  const nearest = { enemy: null, distanceSquared: 0, x: 0, z: 0 };
  const visitNearest = (enemy) => {
    if (enemy.isDead) return;
    const distanceSquared = (enemy.x - nearest.x) ** 2 + (enemy.z - nearest.z) ** 2;
    if (distanceSquared >= nearest.distanceSquared) return;
    nearest.enemy = enemy;
    nearest.distanceSquared = distanceSquared;
  };

  /**
   * The live enemy nearest the hero within shot range, or null.
   * @param {World} world
   * @returns {?Enemy}
   * @complexity O(enemies in the cells within range) through the spatial hash
   */
  const nearestEnemyInRange = (world) => {
    nearest.enemy = null;
    nearest.distanceSquared = SHOT.range * SHOT.range;
    nearest.x = world.hero.x;
    nearest.z = world.hero.z;
    world.hash.query(nearest.x, nearest.z, SHOT.range, visitNearest);
    return nearest.enemy;
  };

  /** A shot leaving the hero on a heading. */
  const createShot = (world, angle) => {
    const directionX = Math.sin(angle);
    const directionZ = Math.cos(angle);
    return { x: world.hero.x + directionX * HERO.muzzleDistance, z: world.hero.z + directionZ * HERO.muzzleDistance, directionX, directionZ, angle, life: SHOT.life, pierce: world.build.pierce, struck: [], isSpent: false };
  };

  /**
   * Fires a volley at the nearest enemy whenever the cooldown allows. Focus (standing still) shortens the cooldown.
   */
  const stepGun = (run, dt, cues) => {
    const { world } = run;
    const { hero, build } = world;
    world.fireCooldown -= dt;
    if (world.fireCooldown > 0) return;
    const target = nearestEnemyInRange(world);
    if (!target) {
      // Nothing in range: look again very soon instead of waiting out a full fire interval.
      world.fireCooldown = HERO.retargetSeconds;
      return;
    }
    world.fireCooldown = 1 / (build.fireRate * (1 + build.focusRate * hero.focus));
    const heading = Math.atan2(target.x - hero.x, target.z - hero.z);
    hero.aimTarget = heading;
    hero.recoil = HERO.recoilScale;
    const headings = [...fanAngles(heading, build.multishot, SHOT.spread), ...(build.rearFan ? fanAngles(heading + Math.PI, build.multishot, SHOT.spread) : [])];
    // A volley never exceeds the shot capacity: the last shots of the list are the ones dropped.
    world.shots.push(...headings.slice(0, CAPACITY.shots - world.shots.length).map((angle) => createShot(world, angle)));
    fire(cues, 'volleyFired', heading);
  };

  /** Turns the blade ring and cuts every enemy a blade overlaps (wisps slip through). */
  const stepBlades = (run, dt, cues) => {
    const { world } = run;
    const { hero, build } = world;
    world.bladeAngle += dt * build.bladeSpin;
    bladeOffsets(world.bladeAngle, build.blades, build.bladeRadius).forEach((blade) => {
      const bladeX = hero.x + blade.x;
      const bladeZ = hero.z + blade.z;
      world.hash.query(bladeX, bladeZ, BLADE.hitPadding + world.largestEnemyRadius, (enemy) => {
        const offsetX = enemy.x - bladeX;
        const offsetZ = enemy.z - bladeZ;
        const reach = enemy.size + BLADE.hitPadding;
        if (enemy.isDead || enemy.type.isBladeImmune || enemy.bladeCooldown > 0 || offsetX * offsetX + offsetZ * offsetZ > reach * reach) return;
        enemy.bladeCooldown = BLADE.cooldown;
        damageEnemy(run, enemy, build.damage * BLADE.damageScale, Math.sign(offsetX) * BLADE.knockback, Math.sign(offsetZ) * BLADE.knockback, cues);
      });
    });
  };

  /** Pulse Coil: a radial hit on a fixed beat. The Gravity Well evolution also catches every gem. */
  const stepPulse = (run, dt, cues) => {
    const { world } = run;
    const { hero, build } = world;
    world.pulseIn -= dt;
    if (world.pulseIn > 0) return;
    world.pulseIn = PULSE.interval;
    blastEnemies(run, hero.x, hero.z, build.pulseRadius, PULSE.force, build.damage * PULSE.damageScale * build.pulse, cues);
    if (build.pulseVacuum) world.gems.forEach((gem) => (gem.pullSpeed = Math.max(gem.pullSpeed, GEM.pullAcceleration * dt)));
    fire(cues, 'pulsed', build.pulseRadius);
  };

  /** Wake Mines: dropped behind a moving ship; an armed mine bursts when an enemy reaches it. */
  const stepMines = (run, dt, control, cues) => {
    const { world } = run;
    const { hero, build, mines } = world;
    const isMoving = Math.hypot(control.x, control.y) > HERO.stillSpeed;
    world.mineIn -= dt;
    if (build.mines && isMoving && world.mineIn <= 0 && mines.length < CAPACITY.mines) {
      world.mineIn = MINE.interval / build.mines;
      mines.push({ x: hero.x, z: hero.z, age: 0, isSpent: false });
    }
    mines.forEach((mine) => {
      mine.age += dt;
      if (mine.age > MINE.lifetime) mine.isSpent = true;
      if (mine.isSpent || mine.age < MINE.armSeconds) return;
      world.hash.query(mine.x, mine.z, MINE.triggerPadding + world.largestEnemyRadius, (enemy) => {
        if (mine.isSpent || enemy.isDead || Math.hypot(enemy.x - mine.x, enemy.z - mine.z) > enemy.size + MINE.triggerPadding) return;
        mine.isSpent = true;
        blastEnemies(run, mine.x, mine.z, build.mineRadius, MINE.force, build.damage * MINE.damageScale, cues);
        fire(cues, 'mineBurst', mine, build.mineRadius);
      });
    });
    world.mines = mines.filter((mine) => !mine.isSpent);
  };

  /** Scratch record for the swept shot test, so the hash visitor allocates nothing. */
  const sweep = { run: null, shot: null, travel: 0, cues: null };
  const visitShotCandidate = (enemy) => {
    const { shot, run } = sweep;
    if (shot.isSpent || enemy.isDead) return;
    const build = run.world.build;
    // Swept test: find the point on this frame's segment of travel closest to the enemy, so fast lances cannot
    // tunnel through an enemy at low frame rates.
    const along = clamp((enemy.x - shot.x) * shot.directionX + (enemy.z - shot.z) * shot.directionZ, 0, sweep.travel);
    const offsetX = enemy.x - (shot.x + shot.directionX * along);
    const offsetZ = enemy.z - (shot.z + shot.directionZ * along);
    const reach = enemy.size + SHOT.hitPadding * build.shotWidth;
    if (offsetX * offsetX + offsetZ * offsetZ > reach * reach || shot.struck.includes(enemy)) return;
    shot.struck.push(enemy);
    // Frontal armour: the enemy always faces the hero, so every shot meets it. Only a piercing shot gets through whole.
    const isBlocked = enemy.type.frontArmor !== undefined && shot.pierce <= 0;
    const damage = isBlocked ? build.damage * enemy.type.frontArmor : build.damage;
    const knockback = isBlocked ? ENEMY.blockedShotKnockback : 1;
    if (isBlocked) fire(sweep.cues, 'shotBlocked', enemy);
    damageEnemy(run, enemy, damage, shot.directionX * knockback, shot.directionZ * knockback, sweep.cues);
    // A shot with no pierce left is spent by this hit; otherwise it carries on with one pierce fewer.
    if (shot.pierce <= 0) shot.isSpent = true;
    shot.pierce--;
  };

  /**
   * Flies every shot and resolves its hits.
   * @complexity O(shots x enemies near each shot's path) through the spatial hash; all-pairs would be O(shots x enemies)
   */
  const stepShots = (run, dt, cues) => {
    const { world } = run;
    const travel = world.shotLook.speed * dt;
    sweep.run = run;
    sweep.travel = travel;
    sweep.cues = cues;
    // Hot path (every shot, every frame): a for-of loop and a shared visitor, no allocation.
    for (const shot of world.shots) {
      shot.life -= dt;
      if (shot.life <= 0) shot.isSpent = true;
      sweep.shot = shot;
      // One query centred on the middle of this frame's travel covers the whole swept segment.
      world.hash.query(shot.x + shot.directionX * travel * 0.5, shot.z + shot.directionZ * travel * 0.5, travel * 0.5 + world.largestEnemyRadius + SHOT.hitPadding * world.build.shotWidth, visitShotCandidate);
      shot.x += shot.directionX * travel;
      shot.z += shot.directionZ * travel;
    }
    world.shots = world.shots.filter((shot) => !shot.isSpent);
  };

  // =====================================================================================================================
  // Enemies: behaviours, separation, touch and graze.
  // =====================================================================================================================

  /** Scratch point for sampling a steer path without allocating. */
  const steerSample = { x: 0, y: 0 };
  /** The velocity a behaviour decided on this frame, world units per second. */
  const intent = { x: 0, z: 0 };

  /** Charges straight at the hero, bent by the type's steer path. */
  const chase = (run, enemy, forwardX, forwardZ, speedScale = 1) => {
    // The steer path gives a forward factor (x) and a sideways factor (y) in the enemy's own frame: forward is the
    // line to the hero, sideways is that line turned a quarter (-z, x).
    const steer = enemy.type.steer ? enemy.type.steer(run.world.seconds + enemy.phase, steerSample) : null;
    const forwardSpeed = (1 + (steer ? steer.x : 0)) * enemy.speed * speedScale;
    const sideSpeed = (steer ? steer.y : 0) * enemy.speed * speedScale;
    intent.x = forwardX * forwardSpeed - forwardZ * sideSpeed;
    intent.z = forwardZ * forwardSpeed + forwardX * sideSpeed;
  };

  /** Puts an enemy into a charge mode for its duration. */
  const enterMode = (enemy, mode, seconds) => {
    enemy.mode = mode;
    enemy.modeFor = seconds;
  };

  /** Starts the tell of a charge: the direction is locked now, so stepping off the line during the tell dodges it. */
  const startChargeTell = (enemy, forwardX, forwardZ, cues) => {
    enemy.dirX = forwardX;
    enemy.dirZ = forwardZ;
    enterMode(enemy, 'tell', enemy.type.charge.tellSeconds);
    fire(cues, 'chargeTold', enemy);
  };

  /**
   * The charge cycle after 'approach': each mode sets this frame's velocity and names the mode that follows it.
   * @type {Object<string, {next: string, seconds: function(Object): number, move: function(Run, Enemy, number, number): void}>}
   */
  const CHARGE_MODES = {
    tell: {
      next: 'dash',
      seconds: (charge) => charge.dashSeconds,
      move: () => {
        intent.x = 0;
        intent.z = 0;
      },
    },
    dash: {
      next: 'recover',
      seconds: (charge) => charge.recoverSeconds,
      move: (run, enemy) => {
        intent.x = enemy.dirX * enemy.type.charge.dashSpeed;
        intent.z = enemy.dirZ * enemy.type.charge.dashSpeed;
      },
    },
    recover: {
      next: 'approach',
      seconds: () => 0,
      move: (run, enemy, forwardX, forwardZ) => chase(run, enemy, forwardX, forwardZ, enemy.type.charge.recoverSpeedScale),
    },
  };

  /** Runs the tell / dash / recover part of a charge. Returns false while the enemy is simply approaching. */
  const stepChargeMode = (run, enemy, forwardX, forwardZ, dt) => {
    const mode = CHARGE_MODES[enemy.mode];
    if (!mode) return false;
    mode.move(run, enemy, forwardX, forwardZ);
    enemy.modeFor -= dt;
    if (enemy.modeFor <= 0) enterMode(enemy, mode.next, mode.seconds(enemy.type.charge));
    return true;
  };

  /** The boss's attacks, by name (BOSS.attacks cycles through them). */
  const BOSS_ATTACKS = {
    charge: (run, enemy, forwardX, forwardZ, cues) => startChargeTell(enemy, forwardX, forwardZ, cues),
    slam: (run, enemy, forwardX, forwardZ, cues) => {
      const { hero } = run.world;
      const { count, scatter } = BOSS.slam;
      // The first circle lands on the hero; the rest are scattered around it to cut off the easy step aside.
      times(count, (index) => addBlast(run, hero.x + (index ? rand(-scatter, scatter) : 0), hero.z + (index ? rand(-scatter, scatter) : 0), BOSS.slam, cues));
    },
    summon: (run, enemy, forwardX, forwardZ, cues) => {
      spawnPack(run, () => ENEMIES.byId(BOSS.summon.typeId), BOSS.summon.count, enemy, BOSS.summon.scatter);
      fire(cues, 'bossSummoned', enemy);
    },
  };

  /**
   * How each kind of enemy decides its velocity (written into `intent`). A new movement style is a new entry.
   * @type {Object<string, function(Run, Enemy, number, number, number, number, Object): void>}
   */
  const BEHAVIORS = {
    chase: (run, enemy, forwardX, forwardZ) => chase(run, enemy, forwardX, forwardZ),
    charge(run, enemy, forwardX, forwardZ, distance, dt, cues) {
      if (stepChargeMode(run, enemy, forwardX, forwardZ, dt)) return;
      chase(run, enemy, forwardX, forwardZ);
      if (distance < enemy.type.charge.range) startChargeTell(enemy, forwardX, forwardZ, cues);
    },
    boss(run, enemy, forwardX, forwardZ, distance, dt, cues) {
      if (stepChargeMode(run, enemy, forwardX, forwardZ, dt)) return;
      chase(run, enemy, forwardX, forwardZ);
      enemy.attackIn -= dt;
      if (enemy.attackIn > 0) return;
      const isEnraged = enemy.hp < enemy.maxHp * BOSS.enrageBelow;
      enemy.attackIn = BOSS.attackSeconds * (isEnraged ? BOSS.enragedScale : 1);
      BOSS_ATTACKS[BOSS.attacks[enemy.attackIndex % BOSS.attacks.length]](run, enemy, forwardX, forwardZ, cues);
      enemy.attackIndex++;
    },
  };

  /** Scratch record for separation, so the hash visitor allocates nothing. */
  const crowding = { enemy: null };
  const visitNeighbour = (other) => {
    const enemy = crowding.enemy;
    // Each pair is handled once, by its later-spawned member, and each of the two moves half of the correction.
    if (other.isDead || other.serial >= enemy.serial) return;
    const apartX = enemy.x - other.x;
    const apartZ = enemy.z - other.z;
    const minimumGap = (enemy.size + other.size) * ENEMY.overlapAllowed;
    const gapSquared = apartX * apartX + apartZ * apartZ;
    // Coincident bodies have no direction to separate along; leave them for their steering to split.
    if (gapSquared >= minimumGap * minimumGap || gapSquared < 1e-6) return;
    const push = (minimumGap / Math.sqrt(gapSquared) - 1) * ENEMY.separationShare;
    enemy.x += apartX * push;
    enemy.z += apartZ * push;
    other.x -= apartX * push;
    other.z -= apartZ * push;
  };

  /**
   * Awards a graze when an enemy that slipped into the band just outside touching range leaves it again without the
   * hero having been hit. Entering only counts while the hero is vulnerable, so dashing through a crowd earns nothing.
   */
  const stepGraze = (run, enemy, distance, touchReach, cues) => {
    const { world } = run;
    const { hero, build } = world;
    const isInBand = distance < touchReach + GRAZE.band;
    if (isInBand && !enemy.isGrazing) {
      enemy.isGrazing = hero.invulnerableFor <= 0;
      return;
    }
    if (isInBand || !enemy.isGrazing) return;
    enemy.isGrazing = false;
    if (world.sinceHurt < GRAZE.quietSeconds) return;
    world.grazes++;
    hero.dashCooldown = Math.max(0, hero.dashCooldown - build.grazeRefund);
    fire(cues, 'grazed', enemy);
  };

  /**
   * Moves every enemy by its behaviour, keeps neighbours apart and lets it touch (or graze) the hero.
   * @complexity O(enemies x neighbours in adjacent cells) through the spatial hash; the all-pairs version was O(enemies^2)
   */
  const stepEnemies = (run, dt, cues) => {
    const { world } = run;
    const { hero, enemies } = world;
    const pushKept = Math.exp(-ENEMY.knockbackDrag * dt);
    // Hot path (every enemy, every frame): a for-of loop and shared scratch records, no allocation.
    for (const enemy of enemies) {
      if (enemy.isDead) continue;
      const type = enemy.type;
      enemy.age += dt;
      enemy.flashFor -= dt;
      enemy.bladeCooldown -= dt;
      const toHeroX = hero.x - enemy.x;
      const toHeroZ = hero.z - enemy.z;
      const distance = Math.hypot(toHeroX, toHeroZ) || 1;
      const forwardX = toHeroX / distance;
      const forwardZ = toHeroZ / distance;
      BEHAVIORS[type.behavior || 'chase'](run, enemy, forwardX, forwardZ, distance, dt, cues);
      enemy.pushX *= pushKept;
      enemy.pushZ *= pushKept;
      enemy.x += (intent.x + enemy.pushX) * dt;
      enemy.z += (intent.z + enemy.pushZ) * dt;
      // A charging enemy points along its locked line (that is the tell); a spinner spins; the rest face the hero.
      if (enemy.mode === 'tell' || enemy.mode === 'dash') enemy.angle = Math.atan2(enemy.dirX, enemy.dirZ);
      else enemy.angle = type.spin ? enemy.angle + type.spin * dt : Math.atan2(forwardX, forwardZ);
      // Push overlapping neighbours apart so the swarm reads as bodies, not a blob.
      crowding.enemy = enemy;
      world.hash.query(enemy.x, enemy.z, enemy.size + world.largestEnemyRadius, visitNeighbour);
      if (world.outcome) continue;
      const touchReach = enemy.size * ENEMY.touchReachScale + ENEMY.touchReachPadding;
      if (enemy.age > ENEMY.touchGraceSeconds && distance < touchReach) hurtHero(run, enemy.touch, cues);
      stepGraze(run, enemy, distance, touchReach, cues);
    }
  };

  /** Burns down every blast's fuse; a blast that goes off hurts the hero if it is still inside the circle. */
  const stepBlasts = (run, dt, cues) => {
    const { world } = run;
    world.blasts.forEach((blast) => {
      blast.fuse -= dt;
      if (blast.fuse > 0) return;
      fire(cues, 'blastBurst', blast);
      if (Math.hypot(world.hero.x - blast.x, world.hero.z - blast.z) < blast.radius) hurtHero(run, blast.damage, cues);
    });
    world.blasts = world.blasts.filter((blast) => blast.fuse > 0);
  };

  /** Drifts gems, pulls the ones the magnet has caught and collects the ones that reach the hero. */
  const stepGems = (run, dt, cues) => {
    const { world } = run;
    const { hero, build } = world;
    const driftKept = Math.exp(-GEM.drag * dt);
    // Hot path (up to CAPACITY.gems every frame): a for-of loop, no allocation until a gem is collected.
    for (const gem of world.gems) {
      const toHeroX = hero.x - gem.x;
      const toHeroZ = hero.z - gem.z;
      const distance = Math.hypot(toHeroX, toHeroZ) || 1;
      gem.x += gem.driftX * dt;
      gem.z += gem.driftZ * dt;
      gem.driftX *= driftKept;
      gem.driftZ *= driftKept;
      if (world.outcome === 'dead') continue;
      // Once caught a gem stays caught even if you outrun the magnet radius, and it accelerates, so it always arrives.
      if (gem.pullSpeed > 0 || distance < build.magnet) {
        gem.pullSpeed = Math.min(GEM.maxPullSpeed, gem.pullSpeed + GEM.pullAcceleration * dt);
        const stride = Math.min(distance, gem.pullSpeed * dt); // never overshoot the hero
        gem.x += (toHeroX / distance) * stride;
        gem.z += (toHeroZ / distance) * stride;
      }
      if (distance > HERO.pickupRadius) continue;
      gem.isCollected = true;
      world.gemsCollected++;
      world.gemStreak = Math.min(CHAIN.maxGemStreak, world.gemStreak + 1);
      hero.recoil = Math.max(hero.recoil, HERO.pickupRecoilScale);
      fire(cues, 'gemCollected', gem, world.gemStreak);
      gainExperience(run, gem.value, cues);
    }
    world.gems = world.gems.filter((gem) => !gem.isCollected);
  };

  /**
   * Files every live enemy in the spatial hash for this frame's queries.
   * @complexity O(enemies)
   */
  const rebuildHash = (world) => {
    world.hash.clear();
    // Queries are padded by the largest body alive, not the largest possible one: with no warden on the floor a
    // query touches about half as many cells.
    world.largestEnemyRadius = 0;
    for (const enemy of world.enemies) {
      world.hash.insert(enemy, enemy.x, enemy.z);
      if (enemy.size > world.largestEnemyRadius) world.largestEnemyRadius = enemy.size;
    }
  };

  /**
   * Advances the whole run by one frame. Once the run is decided the hero, director and weapons stop, but the swarm,
   * shots and gems keep moving, so the ending plays out over a living scene.
   * @param {Run} run
   * @param {number} dt seconds
   * @param {Control} control
   * @param {Object} [cues] callbacks by event name; see the `fire(cues, ...)` calls for the names and payloads
   * @complexity O(enemies + shots + gems) plus the hash queries; see stepEnemies and stepShots
   */
  const step = (run, dt, control, cues = {}) => {
    const { world } = run;
    world.frame++;
    world.arenaRadius = run.arena.radius(world.seconds);
    rebuildHash(world);
    if (!world.outcome) {
      world.seconds += dt;
      stepHero(run, dt, control, cues);
      stepDirector(run, dt, cues);
      stepGun(run, dt, cues);
      if (world.build.blades) stepBlades(run, dt, cues);
      if (world.build.pulse) stepPulse(run, dt, cues);
      if (world.build.mines || world.mines.length) stepMines(run, dt, control, cues);
    }
    stepEnemies(run, dt, cues);
    stepShots(run, dt, cues);
    stepBlasts(run, dt, cues);
    stepGems(run, dt, cues);
    world.enemies = world.enemies.filter((enemy) => !enemy.isDead);
  };

  // =====================================================================================================================
  // Level-ups.
  // =====================================================================================================================

  /**
   * Rolls the hand for a level-up. The very first hand always holds one weapon: the first pick is where the build
   * starts, and a hand of three passives there is a dud roll. Slots, exclusions and evolutions are enforced by
   * Kit.upgrades, so whatever is offered can be taken.
   * @param {Run} run
   * @returns {Object[]} up to LEVEL_UP.choices ArenaUpgrade rows; empty when nothing can be levelled any more
   */
  const rollHand = (run) => {
    const { world, upgrades } = run;
    const isFirstHand = world.handsRolled === 0;
    world.handsRolled++;
    if (!isFirstHand) return upgrades.offer(LEVEL_UP.choices);
    const weapons = upgrades.offer(1, (row) => row.kind === 'weapon');
    const others = upgrades.offer(LEVEL_UP.choices - weapons.length, (row) => !weapons.includes(row));
    // Shuffled so the guaranteed weapon is not always the top card.
    return shuffle([...weapons, ...others]);
  };

  /**
   * Spends a reroll for a fresh hand.
   * @param {Run} run
   * @returns {?Object[]} the new hand, or null when no reroll is left
   */
  const rerollHand = (run) => {
    if (run.world.rerolls <= 0) return null;
    run.world.rerolls--;
    return rollHand(run);
  };

  /**
   * Takes one upgrade for a pending level: levels the row, re-evaluates synergies, heals what the row and the tier
   * allow, and releases the nova that clears breathing room, so choosing always improves the situation you return to.
   * @param {Run} run
   * @param {string} id an upgrade id from the rolled hand
   * @param {Object} [cues]
   * @returns {{ row: Object, gained: Object[] }} the row taken and the synergies it switched on
   */
  const takeUpgrade = (run, id, cues = {}) => {
    const { world, upgrades, synergies, tier } = run;
    const row = upgrades.table.byId(id);
    const before = synergies.active();
    upgrades.grant(id);
    const gained = synergies.update(upgrades.owned()).filter((synergy) => !before.includes(synergy));
    refreshBuild(run);
    if (row.kind === 'evolution') world.evolutions++;
    world.pendingLevels = Math.max(0, world.pendingLevels - 1);
    healHero(run, (row.heal || 0) + LEVEL_UP.heal * tier.levelHealScale, cues);
    world.hero.invulnerableFor = Math.max(world.hero.invulnerableFor, LEVEL_UP.invulnerableSeconds);
    blastEnemies(run, world.hero.x, world.hero.z, LEVEL_UP.nova.radius, LEVEL_UP.nova.force, world.build.damage * LEVEL_UP.nova.damageScale, cues);
    return { row, gained };
  };

  /**
   * A finished (or abandoned) run as plain data, for the profile and for analysis.
   * @param {Run} run
   * @returns {{ seconds: number, kills: number, elites: number, bosses: number, gems: number, grazes: number,
   *   evolutions: number, level: number, isCleared: boolean, tierRank: number, shipId: string, arenaId: string,
   *   tierId: string, build: Object<string, number>, synergies: string[] }}
   */
  const summarize = (run) => {
    const { world, upgrades, synergies } = run;
    return {
      seconds: Math.round(world.seconds),
      kills: world.kills,
      elites: world.elites,
      bosses: world.bossKills,
      gems: world.gemsCollected,
      grazes: world.grazes,
      evolutions: world.evolutions,
      level: world.level,
      isCleared: world.outcome === 'cleared',
      tierRank: run.tier.rank,
      shipId: run.ship.id,
      arenaId: run.arena.id,
      tierId: run.tier.id,
      build: upgrades.owned().reduce((levels, row) => ({ ...levels, [row.id]: upgrades.level(row.id) }), {}),
      synergies: synergies.active().map((synergy) => synergy.id),
    };
  };

  // =====================================================================================================================
  // Meta: the permanent profile.
  // =====================================================================================================================

  /**
   * Opens the player's permanent profile for this game.
   * @param {{ get: Function, set: Function }} [save] ctx.save; omit for an in-memory profile (tests, bots)
   * @param {Object} [hooks] Kit.profile hooks: onAchievement, onUnlock, onLevel
   * @returns {Object} a Kit.profile
   */
  const createProfile = (save, hooks = {}) => Kit.profile({ save, achievements: DATA.ACHIEVEMENTS, levelCurve: DATA.ACCOUNT.levelCurve, ...hooks });

  /** Is a ship, arena or upgrade row available to this profile? */
  const isUnlocked = (profile, row) => !row.unlock || profile.isUnlocked(row.unlock);
  /** Is a tier open? Tier N opens when tier N - 1 has been cleared. */
  const isTierOpen = (profile, tier) => tier.rank <= profile.stat('tier') + 1;
  /** Rerolls a run starts with: one per account level above the first, up to the cap. */
  const startingRerolls = (profile) => clamp(profile.level - 1, 0, DATA.ACCOUNT.mostStartingRerolls);

  /**
   * The loadout a profile may actually fly: any part that is locked (or unknown, from an old save) falls back to the default.
   * @param {Object} profile
   * @param {{ shipId?: string, arenaId?: string, tierId?: string }} [wanted]
   * @returns {{ shipId: string, arenaId: string, tierId: string }}
   */
  const validLoadout = (profile, wanted = {}) => {
    const choose = (table, id, isOpen, fallback) => (table.some((row) => row.id === id && isOpen(profile, row)) ? id : fallback);
    return {
      shipId: choose(DATA.SHIPS, wanted.shipId, isUnlocked, DATA.DEFAULT_LOADOUT.shipId),
      arenaId: choose(DATA.ARENAS, wanted.arenaId, isUnlocked, DATA.DEFAULT_LOADOUT.arenaId),
      tierId: choose(DATA.TIERS, wanted.tierId, isTierOpen, DATA.DEFAULT_LOADOUT.tierId),
    };
  };

  /**
   * Adds a finished run to the profile: lifetime counters, bests, account experience and the run history.
   * Achievements complete (and unlock content) as the statistics they watch move.
   * @param {Object} profile a Kit.profile from createProfile
   * @param {Object} summary from summarize
   * @returns {{ unlocked: string[], levelsGained: number, experience: number }} what this run newly unlocked and earned
   */
  const recordRun = (profile, summary) => {
    const before = profile.unlocked();
    const { ACCOUNT } = DATA;
    ['kills', 'elites', 'bosses', 'gems', 'grazes', 'evolutions'].forEach((name) => profile.count(name, summary[name]));
    profile.best('bestLevel', summary.level);
    profile.best('bestSeconds', summary.seconds);
    if (summary.isCleared) profile.best('tier', summary.tierRank);
    const experience = Math.round(summary.kills * ACCOUNT.experiencePerKill + summary.seconds * ACCOUNT.experiencePerSecond + (summary.isCleared ? ACCOUNT.experiencePerClearedRank * summary.tierRank : 0));
    const levelsGained = profile.gainExperience(experience);
    profile.endRun(summary);
    return { unlocked: profile.unlocked().filter((id) => !before.includes(id)), levelsGained, experience };
  };

  /**
   * Creates the run a profile's loadout describes.
   * @param {Object} profile
   * @param {{ shipId?: string, arenaId?: string, tierId?: string }} [wanted]
   * @returns {Run}
   */
  const createRunFor = (profile, wanted) => createRun({ ...validLoadout(profile, wanted), unlocked: profile.unlocked(), rerolls: startingRerolls(profile) });

  /** Picks a random element; exported for the bots so they share the kit's random source. */
  const pickRandom = (items) => pick(items);

  Object.assign(window.Arena, {
    sim: { createRun, step, rollHand, rerollHand, takeUpgrade, summarize, spawnEnemy, damageEnemy, bladeOffsets, shotLookOf, addExperience, times, pickRandom },
    meta: { createProfile, isUnlocked, isTierOpen, startingRerolls, validLoadout, recordRun, createRunFor },
  });
})();
