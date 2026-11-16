/**
 * Swarm Arena, bots: simple players that fly and pick upgrades, so the game's pacing and build variety can be
 * measured over thousands of headless runs instead of asserted.
 *
 * Owns: `Arena.bots` - movement policies (`MOVERS`), upgrade-pick policies (`PICKERS`), `playRun` (one whole run,
 *       headless) and `progression` (the long arc as the interface tools/sim.js plays for simulated hours).
 * Does not own: the rules (games/arena-sim.js) or the numbers (games/arena-data.js). No THREE, no DOM: runs in node.
 *
 * A bot is a measuring stick, not a player: `idle` is the floor (no skill at all), `kite` circles blindly, `evade`
 * reads tells and dashes. The gap between them is how much the game rewards skill.
 */
(() => {
  const D = window.Arena.data;
  const { sim, meta } = window.Arena;
  const { clamp } = Kit.math;

  /** How the evading bot weighs what it sees. Distances in world units. */
  const EVADE = {
    lookRadius: 7, // enemies further than this are ignored
    softening: 0.25, // added to squared distance so a touching enemy is a strong, finite push
    circleShare: 0.55, // fraction of the push turned sideways, so the bot circles the swarm instead of fleeing to the wall
    tellSidestep: 3, // weight of stepping off a charge line
    tellCorridor: 2.2, // half-width of the corridor around a charge line that counts as "on the line"
    blastMargin: 0.7, // stay this far outside a blast circle
    blastWeight: 6,
    gemRadius: 9,
    gemWeight: 1,
    bossStandoff: 7, // close in on a warden further away than this, so the guns stay in range
    bossWeight: 0.6,
    wallMargin: 4, // start turning back this far from the wall
    wallWeight: 2.5,
    dashWhenWithin: 0.5, // dash when a body is this close to touching
    dashBlastFuse: 0.3, // dash out of a blast about to burst
  };

  /** Circle-strafing rate of the kiting bot, radians per second, and when it starts moving. */
  const KITE = { turnRate: 0.85, startAt: 1.2 };

  /** Half extents of a portrait phone's view in world units; headless runs have no camera to ask. */
  const HEADLESS_VIEW = { halfWidth: 7.5, halfHeight: 15 };

  /** Frame length of headless runs, seconds. Coarser than a phone's 1/60 for speed; the swept shot test keeps hits honest. */
  const HEADLESS_DT = 1 / 30;
  /** A headless run is cut off here: a bot that neither dies nor wins must not run forever. */
  const MOST_RUN_SECONDS = 300;

  /**
   * @typedef {function(Object): {x: number, y: number, dash: boolean}} Mover
   * Reads a Run and returns this frame's Control.
   */

  /** Sums the pushes an evading pilot feels and decides whether to dash. */
  const evade = (run) => {
    const { world } = run;
    const { hero } = world;
    let pushX = 0;
    let pushZ = 0;
    let shouldDash = false;
    world.hash.query(hero.x, hero.z, EVADE.lookRadius, (enemy) => {
      if (enemy.isDead) return;
      const awayX = hero.x - enemy.x;
      const awayZ = hero.z - enemy.z;
      const distance = Math.hypot(awayX, awayZ) || 1;
      const gap = Math.max(0, distance - enemy.size);
      const weight = 1 / (gap * gap + EVADE.softening);
      pushX += (awayX / distance) * weight;
      pushZ += (awayZ / distance) * weight;
      if (gap < EVADE.dashWhenWithin + D.ENEMY.touchReachPadding) shouldDash = true;
      if (enemy.mode !== 'tell' && enemy.mode !== 'dash') return;
      // On a charge line: step sideways off it, to whichever side the hero already is.
      const along = awayX * enemy.dirX + awayZ * enemy.dirZ;
      const across = awayX * -enemy.dirZ + awayZ * enemy.dirX;
      if (along < 0 || Math.abs(across) > EVADE.tellCorridor) return;
      const side = across >= 0 ? 1 : -1;
      pushX += -enemy.dirZ * side * EVADE.tellSidestep;
      pushZ += enemy.dirX * side * EVADE.tellSidestep;
      if (enemy.mode === 'dash') shouldDash = true;
    });
    // Circle rather than flee: turn part of the push a quarter turn.
    const circledX = pushX - pushZ * EVADE.circleShare;
    const circledZ = pushZ + pushX * EVADE.circleShare;
    let x = circledX;
    let z = circledZ;
    world.blasts.forEach((blast) => {
      const awayX = hero.x - blast.x;
      const awayZ = hero.z - blast.z;
      const distance = Math.hypot(awayX, awayZ) || 1;
      if (distance > blast.radius + EVADE.blastMargin) return;
      x += (awayX / distance) * EVADE.blastWeight;
      z += (awayZ / distance) * EVADE.blastWeight;
      if (blast.fuse < EVADE.dashBlastFuse) shouldDash = true;
    });
    world.gems.forEach((gem) => {
      const toX = gem.x - hero.x;
      const toZ = gem.z - hero.z;
      const distance = Math.hypot(toX, toZ) || 1;
      if (distance > EVADE.gemRadius) return;
      x += (toX / distance / distance) * EVADE.gemWeight;
      z += (toZ / distance / distance) * EVADE.gemWeight;
    });
    world.enemies.forEach((enemy) => {
      if (!enemy.type.isBoss || enemy.isDead) return;
      const toX = enemy.x - hero.x;
      const toZ = enemy.z - hero.z;
      const distance = Math.hypot(toX, toZ) || 1;
      if (distance < EVADE.bossStandoff) return;
      x += (toX / distance) * EVADE.bossWeight;
      z += (toZ / distance) * EVADE.bossWeight;
    });
    const fromCentre = Math.hypot(hero.x, hero.z);
    const overWall = fromCentre - (world.arenaRadius - EVADE.wallMargin);
    if (overWall > 0) {
      x -= (hero.x / fromCentre) * overWall * EVADE.wallWeight;
      z -= (hero.z / fromCentre) * overWall * EVADE.wallWeight;
    }
    const length = Math.hypot(x, z);
    return { x: length > 1e-6 ? x / length : 0, y: length > 1e-6 ? z / length : 0, dash: shouldDash && hero.dashCooldown <= 0 };
  };

  /** @type {Object<string, Mover>} Movement policies, weakest first. */
  const MOVERS = {
    /** Never moves: the floor. What the game gives a player who does nothing. */
    idle: () => ({ x: 0, y: 0, dash: false }),
    /** Circle-strafes blindly: a beginner who has learned to keep moving. */
    kite: (run) => {
      const time = run.world.seconds;
      return time < KITE.startAt ? { x: 0, y: 0, dash: false } : { x: Math.cos(time * KITE.turnRate), y: Math.sin(time * KITE.turnRate), dash: false };
    },
    /** Reads the swarm, steps off tells and out of blasts, dashes when cornered: a practised player. */
    evade,
    /** The evading pilot without the dash, to measure what the dash alone is worth. */
    evadeNoDash: (run) => ({ ...evade(run), dash: false }),
  };

  /**
   * @typedef {function(Object, Object[]): Object} Picker
   * Chooses one row of a rolled hand for a Run.
   */

  /** Picks the first row of the hand that appears in a priority list of ids, else an evolution, else at random. */
  const byPriority = (priority) => (run, hand) => {
    const wanted = priority.map((id) => hand.find((row) => row.id === id)).find(Boolean);
    return wanted || hand.find((row) => row.kind === 'evolution') || sim.pickRandom(hand);
  };

  /** How many more synergy requirements a row would fill, given the tags the build already holds. */
  const synergyGain = (run, row) => {
    if (run.upgrades.level(row.id) > 0) return 0; // synergies count rows owned, so a second level adds nothing
    return run.synergies.progress().reduce((gain, entry) => gain + (row.tags || []).filter((tag) => !entry.active && entry.row.needs[tag] > (entry.have[tag] || 0)).length, 0);
  };

  /** @type {Object<string, Picker>} Upgrade-pick policies: one per play style a person might follow. */
  const PICKERS = {
    random: (run, hand) => sim.pickRandom(hand),
    gunner: byPriority(['storm', 'multi', 'rate', 'dmg', 'mines', 'speed']),
    beam: byPriority(['rail', 'pierce', 'dmg', 'reactor', 'pulse', 'rate']),
    orbit: byPriority(['halo', 'blade', 'speed', 'magnet', 'vit', 'multi']),
    tank: byPriority(['plating', 'vit', 'blade', 'pulse', 'dmg', 'rate']),
    pulse: byPriority(['nova', 'pulse', 'magnet', 'capacitor', 'reactor', 'pierce']),
    miner: byPriority(['cluster', 'mines', 'capacitor', 'speed', 'rate', 'multi']),
    /** Takes whatever fills the most synergy requirements; ties go to an evolution, then at random. */
    synergist: (run, hand) => {
      const best = Math.max(...hand.map((row) => synergyGain(run, row)));
      return best > 0 ? hand.find((row) => synergyGain(run, row) === best) : hand.find((row) => row.kind === 'evolution') || sim.pickRandom(hand);
    },
  };

  /**
   * Plays one whole run without a page.
   * @param {Object} run from Arena.sim.createRun / Arena.meta.createRunFor
   * @param {Object} [options]
   * @param {Mover} [options.mover] default MOVERS.evade
   * @param {Picker} [options.picker] default PICKERS.random
   * @param {number} [options.dt] frame length, seconds
   * @param {number} [options.mostSeconds] cut-off for a run that neither dies nor clears
   * @param {function(Object): void} [options.onFrame] called after each frame with the run (for sampling curves)
   * @returns {Object} Arena.sim.summarize(run), plus `firstLevelAt` (seconds of the first level-up, or null)
   * @complexity O(frames x cost of a frame); about 3000 frames for a 100 second run at the default dt
   * @example const summary = Arena.bots.playRun(Arena.sim.createRun(), { mover: Arena.bots.MOVERS.kite });
   */
  const playRun = (run, { mover = MOVERS.evade, picker = PICKERS.random, dt = HEADLESS_DT, mostSeconds = MOST_RUN_SECONDS, onFrame } = {}) => {
    const { world } = run;
    let firstLevelAt = null;
    while (!world.outcome && world.seconds < mostSeconds) {
      Object.assign(world.view, HEADLESS_VIEW, { x: world.hero.x, z: world.hero.z });
      sim.step(run, dt, mover(run));
      // Level-ups are taken at once, as a player would: the game pauses for the choice.
      while (world.pendingLevels > 0 && !world.outcome) {
        const hand = sim.rollHand(run);
        if (!hand.length) {
          world.pendingLevels = 0; // everything is maxed or blocked; nothing left to choose
          break;
        }
        if (firstLevelAt === null) firstLevelAt = world.seconds;
        sim.takeUpgrade(run, picker(run, hand).id);
      }
      if (onFrame) onFrame(run);
    }
    return { ...sim.summarize(run), firstLevelAt };
  };

  /** Everything a profile can unlock: gated rows of ships, arenas and upgrades, and the tiers above the first. */
  const allUnlockIds = () => [...D.SHIPS, ...D.ARENAS, ...D.UPGRADES].filter((row) => row.unlock).map((row) => row.unlock);
  const UNLOCKABLE_COUNT = new Set(allUnlockIds()).size + D.TIERS.length - 1;

  /**
   * The long arc for tools/sim.js (`make sim GAME=arena`): the only action is "fly another run", and what it
   * unlocks is the curve. The simulated player flies the hardest tier it has opened, a random ship and arena it
   * owns, as the evading pilot with a random pick style.
   */
  const progression = {
    createState: () => ({ profile: meta.createProfile() }),
    actions: () => [{ id: 'run', kind: 'play', label: 'Fly a run' }],
    apply(state, action, random) {
      // The simulation reads Math.random through the kit; point it at the simulator's seeded source for this run.
      const realRandom = Math.random;
      Math.random = random;
      try {
        const { profile } = state;
        const open = (table, isOpen) => table.filter((row) => isOpen(profile, row));
        const tiers = open(D.TIERS, meta.isTierOpen);
        const loadout = { shipId: sim.pickRandom(open(D.SHIPS, meta.isUnlocked)).id, arenaId: sim.pickRandom(open(D.ARENAS, meta.isUnlocked)).id, tierId: tiers[tiers.length - 1].id };
        const tierBefore = profile.stat('tier');
        const summary = playRun(meta.createRunFor(profile, loadout), { picker: PICKERS[sim.pickRandom(Object.keys(PICKERS))] });
        const { unlocked } = meta.recordRun(profile, summary);
        const tierUnlocks = profile.stat('tier') > tierBefore && profile.stat('tier') < D.TIERS.length ? ['tier' + (profile.stat('tier') + 1)] : [];
        return { seconds: Math.max(1, summary.seconds), unlocked: [...unlocked, ...tierUnlocks] };
      } finally {
        Math.random = realRandom;
      }
    },
    summary({ profile }) {
      const owned = profile.unlocked().length + clamp(profile.stat('tier'), 0, D.TIERS.length - 1);
      return { currency: profile.level, owned, remaining: UNLOCKABLE_COUNT - owned };
    },
  };

  window.Arena.bots = { MOVERS, PICKERS, playRun, progression, HEADLESS_DT };
})();
