/**
 * __NAME__: tap when the orb fills the ring.
 * Scaffolded by `node tools/dev.js new game __ID__` - a working starting shape. Replace the rules, the tables,
 * the theme and this header with your own game, and delete this line when you do.
 *
 * Depth plan (games/README.md: deep at three timescales; `make sim GAME=__ID__` checks the pacing over hours):
 *   Seconds (mastery):  timing. A tap only pays inside the hit window, and a streak of clean taps pays more.
 *   Minutes (decisions): two upgrades pull against each other: Steady widens the window, Stakes pays more per
 *                        hit but speeds the pulse up, so a greedy build needs a steadier hand.
 *   Hours (the long arc): lifetime hits (Kit.profile) unlock the combo rule, which changes what a miss costs.
 *
 * Owns:  the tuning tables, the round simulation (plain data, no THREE, no DOM), the persistent models
 *        (stats <- upgrades <- wallet, profile), the headless model `headless` that tools simulate, the scene,
 *        the HUD theme and the ready -> playing -> over phase flow.
 * Does not own: anything generic. Phases are Kit.fsm, costs and levels are Kit.upgrades, the long arc is
 *        Kit.profile, timers are ctx.after / ctx.tween, input is ctx.input and every mesh comes from ctx.make.
 *        If you write something another game could use, put it in the kit (`node tools/dev.js new module <name>`).
 */
(() => {
  const { clamp, lerp } = Kit.math;

  // =====================================================================================================================
  // DATA TABLES
  // =====================================================================================================================

  /** What upgrades modify. Times in seconds. */
  const BASE_STATS = {
    hitWindow: 0.16, // a tap this close to the peak (either side) counts
    period: 1.6, // one swell and shrink of the orb; slow enough to read on the first try
    coinsPerHit: 1,
  };

  /** The orb's size through a pulse, as multiples of its resting size; at its peak it exactly fills the ring. */
  const PULSE = { smallestScale: 0.35, peakScale: 1.5 };
  /** Where in a period the orb is at its peak, as a fraction of the period. */
  const PEAK_PHASE = 0.5;

  /** What a round is made of. */
  const RULES = { lives: 3, roundSeconds: 30 };

  /** The minutes-scale decision: each row is one side of a trade (see Kit.upgrades for the row shape). */
  const UPGRADES = [
    { id: 'steady', name: 'Steady', max: 5, cost: { base: 8, growth: 1.8 }, mods: { hitWindow: { add: 0.02 } }, desc: 'Wider window' },
    { id: 'stakes', name: 'Stakes', max: 5, cost: { base: 12, growth: 1.9 }, mods: { coinsPerHit: { add: 1 }, period: { mul: 0.9 } }, desc: 'More coins, faster pulse' },
  ];

  /** The hours-scale arc: lifetime statistics that unlock new rules (see Kit.profile for the row shape). */
  const ACHIEVEMENTS = [{ id: 'regular', text: 'Land 40 hits in total', stat: 'hits', target: 40, unlocks: 'combo' }];
  /** The combo rule, once unlocked: every hit in a streak pays a growing bonus, up to a cap. */
  const COMBO = { unlockId: 'combo', bonusPerStreak: 1, largestBonus: 4 };

  /** The stand-in player used by the headless model. Times in seconds. */
  const BOT = {
    timingError: 0.24, // how far from the peak a typical tap lands at the base pulse speed
    betweenRoundsSeconds: 6, // reading the result and starting again
    shopSeconds: 2, // choosing one upgrade
  };

  /** The scene's layout. Lengths in world units. */
  const SCENE = { orbRadius: 0.6, ringThickness: 0.06, cameraPosition: [0, 7, 6], burstCount: 14, missShake: 0.3 };
  const COLORS = { skyTop: 0x1b2440, skyBottom: 0x0b1020, floor: 0x1e2a4a, ring: 0x35466f, orb: 0xffb347, spark: 0xfff1c9 };

  /** HUD theme: start from a kit skin, then make it this game's own (fonts, tokens, layout, scoped css). */
  const THEME = { skin: '__SKIN__', tokens: { '--accent': '#ffb347', '--radius': '6px' }, layout: { stats: 'top-center' } };

  // =====================================================================================================================
  // RULES (pure: plain data in, plain data out)
  // =====================================================================================================================

  /**
   * @typedef {Object} Loadout what the player's build makes of the base stats
   * @property {number} hitWindow seconds either side of the peak that count
   * @property {number} period seconds per pulse
   * @property {number} coinsPerHit
   * @property {boolean} hasCombo is the combo rule unlocked?
   */

  /**
   * @typedef {Object} Round
   * @property {number} elapsed seconds played
   * @property {number} coins earned this round
   * @property {number} hits taps that landed
   * @property {number} streak hits in a row
   * @property {number} lives taps the player can still mistime
   */

  /**
   * Starts a round.
   * @returns {Round}
   */
  const createRound = () => ({ elapsed: 0, coins: 0, hits: 0, streak: 0, lives: RULES.lives });

  /**
   * How far the orb is through its swell-and-shrink cycle.
   * @param {number} elapsed seconds played
   * @param {number} period seconds per pulse
   * @returns {number} 0..1; PEAK_PHASE is the moment it fills the ring
   */
  const pulsePhase = (elapsed, period) => (elapsed % period) / period;

  /**
   * The orb's size at a moment: a triangle wave that peaks once per period.
   * @param {number} elapsed seconds played
   * @param {number} period seconds per pulse
   * @returns {number} scale, PULSE.smallestScale .. PULSE.peakScale
   */
  const pulseScale = (elapsed, period) => lerp(PULSE.smallestScale, PULSE.peakScale, 1 - Math.abs(pulsePhase(elapsed, period) - PEAK_PHASE) / PEAK_PHASE);

  /**
   * Would a tap at this moment count?
   * @param {number} elapsed seconds played
   * @param {Loadout} loadout
   * @returns {boolean}
   */
  const isOnBeat = (elapsed, loadout) => Math.abs(pulsePhase(elapsed, loadout.period) - PEAK_PHASE) * loadout.period <= loadout.hitWindow;

  /**
   * Coins for a hit that extends a streak.
   * @param {number} streakBefore hits in a row before this one
   * @param {Loadout} loadout
   * @returns {number}
   */
  const payoutOf = (streakBefore, loadout) => loadout.coinsPerHit + (loadout.hasCombo ? Math.min(streakBefore, COMBO.largestBonus) * COMBO.bonusPerStreak : 0);

  /**
   * Applies one tap: coins and a longer streak when it landed, a life and the streak lost when it did not.
   * @param {Round} round
   * @param {boolean} didLand
   * @param {Loadout} loadout
   * @returns {Round} a new round; the input is not changed
   */
  const scoreTap = (round, didLand, loadout) =>
    didLand
      ? { ...round, coins: round.coins + payoutOf(round.streak, loadout), hits: round.hits + 1, streak: round.streak + 1 }
      : { ...round, lives: round.lives - 1, streak: 0 };

  /**
   * Is the round finished (out of lives or out of time)?
   * @param {Round} round
   * @returns {boolean}
   */
  const isRoundOver = (round) => round.lives <= 0 || round.elapsed >= RULES.roundSeconds;

  // =====================================================================================================================
  // PERSISTENT MODELS (shared by the page and the headless model, so both play by the same rules)
  // =====================================================================================================================

  /**
   * Builds the player's persistent state.
   * @param {Object} [save] ctx.save in the page; omit for an in-memory player (tests and simulation)
   * @returns {{stats: Object, wallet: Object, upgrades: Object, profile: Object, newUnlocks: string[]}}
   *   `newUnlocks` collects unlock ids as they happen, for whoever wants to announce them
   */
  const createModels = (save) => {
    const newUnlocks = [];
    const stats = Kit.stats(BASE_STATS);
    const wallet = Kit.wallet({ coins: 0 }, save);
    const upgrades = Kit.upgrades(UPGRADES, { stats, wallet, save });
    const profile = Kit.profile({ save, achievements: ACHIEVEMENTS, onUnlock: (id) => newUnlocks.push(id) });
    return { stats, wallet, upgrades, profile, newUnlocks };
  };

  /**
   * The build as the round rules read it.
   * @param {ReturnType<typeof createModels>} models
   * @returns {Loadout}
   */
  const readLoadout = ({ stats, profile }) => ({
    hitWindow: stats.get('hitWindow'),
    period: stats.get('period'),
    coinsPerHit: stats.get('coinsPerHit'),
    hasCombo: profile.isUnlocked(COMBO.unlockId),
  });

  /**
   * Banks a finished round: coins to the wallet, hits to the lifetime record.
   * @param {ReturnType<typeof createModels>} models
   * @param {Round} round
   */
  const settleRound = ({ wallet, profile }, round) => {
    wallet.add(round.coins);
    profile.count('hits', round.hits);
    profile.best('bestRound', round.coins);
    profile.endRun({ coins: round.coins, hits: round.hits });
  };

  // =====================================================================================================================
  // HEADLESS MODEL (what `make sim GAME=__ID__` plays for hours; no THREE, no DOM)
  // =====================================================================================================================

  /**
   * Plays a whole round as the stand-in player: each pulse is one tap that lands with a chance set by how the
   * hit window compares with the bot's timing error at this pulse speed.
   * @param {Loadout} loadout
   * @param {function(): number} random returns a number in [0, 1)
   * @returns {Round} the finished round
   * @complexity O(taps) time, where taps = RULES.roundSeconds / period; O(1) space
   */
  const simulateRound = (loadout, random) => {
    const hitChance = clamp(loadout.hitWindow / (BOT.timingError * (BASE_STATS.period / loadout.period)));
    let round = createRound();
    while (!isRoundOver(round)) round = scoreTap({ ...round, elapsed: round.elapsed + loadout.period }, random() < hitChance, loadout);
    return round;
  };

  /** The standard progression interface that tools/sim.js drives (see games/README.md "Headless model"). */
  const PROGRESSION = {
    createState: () => createModels(),
    actions: ({ upgrades }) => [
      { id: 'round', kind: 'play', label: 'Play a round' },
      ...UPGRADES.filter((row) => !upgrades.maxed(row.id)).map((row) => ({ id: row.id, kind: 'buy', label: row.name, cost: upgrades.cost(row.id), affordable: upgrades.canBuy(row.id) })),
    ],
    apply(models, action, random) {
      if (action.kind === 'buy') {
        models.upgrades.buy(action.id);
        return { seconds: BOT.shopSeconds };
      }
      const round = simulateRound(readLoadout(models), random);
      settleRound(models, round);
      return { seconds: round.elapsed + BOT.betweenRoundsSeconds, unlocked: models.newUnlocks.splice(0) };
    },
    summary: ({ wallet, upgrades, profile }) => ({
      currency: wallet.get(),
      owned: UPGRADES.reduce((sum, row) => sum + upgrades.level(row.id), 0) + profile.unlocked().length,
      remaining: UPGRADES.reduce((sum, row) => sum + (row.max - upgrades.level(row.id)), 0) + ACHIEVEMENTS.filter((row) => !profile.isUnlocked(row.unlocks)).length,
    }),
  };

  // =====================================================================================================================
  // GAME
  // =====================================================================================================================

  Kit.register({
    id: '__ID__',
    name: '__NAME__',
    tagline: 'Tap when the orb fills the ring',
    hook: 'Trade a steadier hand against higher stakes',
    color: '#ffb347',
    order: __ORDER__,
    theme: THEME,
    headless: { BASE_STATS, UPGRADES, ACHIEVEMENTS, createRound, scoreTap, isOnBeat, simulateRound, progression: PROGRESSION },
    create(ctx) {
      const { make, input, fx, sfx, ui, save, camera } = ctx;

      // ---- scene ----
      make.stage({ sky: [COLORS.skyTop, COLORS.skyBottom] });
      make.ground(undefined, COLORS.floor);
      const ringRadius = SCENE.orbRadius * PULSE.peakScale;
      make.cyl(ringRadius, ringRadius, SCENE.ringThickness, COLORS.ring, { at: [0, SCENE.ringThickness, 0] });
      const orb = make.sphere(SCENE.orbRadius, COLORS.orb, { at: [0, SCENE.orbRadius, 0] });
      camera.position.set(...SCENE.cameraPosition);
      camera.lookAt(0, 0, 0);

      // ---- models and HUD (the shop binds to the upgrades and wallet and keeps itself up to date) ----
      const models = createModels(save);
      const coinStat = ui.stat('Coins', models.wallet.get());
      const roundStat = ui.stat('Round', 0);
      const livesPips = ui.pips('Lives', { total: RULES.lives });
      const timeBar = ui.progress('Time');
      ui.shop(models.upgrades, { wallet: models.wallet, describe: true });
      models.wallet.on(() => coinStat.set(models.wallet.get()));
      const hint = ui.hint('Tap when the orb fills the ring');

      let round = createRound();

      /** Draws the round: the orb's size and the HUD. */
      const draw = () => {
        orb.scale.setScalar(pulseScale(round.elapsed, models.stats.get('period')));
        roundStat.set(round.coins);
        livesPips.set(round.lives);
        timeBar.set(clamp(1 - round.elapsed / RULES.roundSeconds));
      };

      /** Feedback for a tap, chosen by whether it landed. */
      const react = (didLand) => {
        if (!didLand) {
          fx.shake(SCENE.missShake);
          sfx.play('thud');
          return;
        }
        fx.burst(orb.position, { color: COLORS.spark, count: SCENE.burstCount });
        sfx.play('coin');
        roundStat.pulse();
      };

      /** Ends the round: banks it, announces anything it unlocked and offers another go. */
      const showResult = () => {
        settleRound(models, round);
        models.newUnlocks.splice(0).forEach((id) => ui.toast(`Unlocked: ${id}`));
        sfx.play('lose');
        const rows = [['Coins', round.coins], ['Hits', round.hits], ['Lifetime hits', models.profile.stat('hits')]];
        ui.banner({ title: round.lives > 0 ? 'Time!' : 'Out of lives', stats: rows }).then(() => ctx.restart());
      };

      // ---- phases: each state owns its own update, so there are no "if playing" flags ----
      const flow = Kit.fsm(
        {
          ready: {},
          playing: {
            enter: () => hint.hide(),
            update(dt) {
              round = { ...round, elapsed: round.elapsed + dt };
              if (isRoundOver(round)) flow.go('over');
            },
          },
          over: { enter: showResult },
        },
        'ready'
      );
      /** What a tap means in each phase. */
      const TAP_BY_PHASE = {
        ready: () => flow.go('playing'),
        playing: () => {
          const loadout = readLoadout(models);
          const didLand = isOnBeat(round.elapsed, loadout);
          round = scoreTap(round, didLand, loadout);
          react(didLand);
          if (isRoundOver(round)) flow.go('over');
        },
        over: () => {},
      };
      input.onTap(() => TAP_BY_PHASE[flow.state]());

      draw();
      return {
        update(dt) {
          flow.update(dt);
          draw();
        },
        /** Facts about the run for the developer overlay and `node tools/dev.js play` ("assert state.hits >= 1"). */
        debugState: () => ({ phase: flow.state, ...round, isOnBeat: isOnBeat(round.elapsed, readLoadout(models)), wallet: models.wallet.get() }),
      };
    },
  });
})();
