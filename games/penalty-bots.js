/**
 * Spot Kick Showdown bots: stand-in players who play whole matches through the real rules, and the headless
 * progression that `make sim GAME=penalty` runs for simulated hours.
 *
 * Owns:  the stand-in player's hands (`BOT`: how accurately it aims and how quickly it dives, improving with
 *        matches played), `playMatch` (one shootout, every kick flown by games/penalty-sim.js) and `PROGRESSION`
 *        (the interface of tools/dev/simulate.js over `createProgress`).
 * Does not own: the rules (games/penalty-sim.js), the tables or the long arc's bookkeeping (games/penalty-data.js).
 *
 * The bot is a model of a person, not an optimal player: it cannot time the sway of a nervous aim, reacts in
 * human time, believes a taker's tell, and gets better with practice. Its win rates are what tune the ladder.
 * Exposed as the global SPOT_KICK_BOTS.
 */
(() => {
  const DATA = window.SPOT_KICK_DATA, SIM = window.SPOT_KICK_SIM;
  const { REWARDS } = DATA;
  const { clamp, lerp } = Kit.math;

  /**
   * The stand-in player. Pairs are [first match, with practice]; `practice` is the number of matches after which
   * about two thirds of the improvement has happened.
   */
  const BOT = Object.freeze({
    practice: 18,
    aimError: [0.085, 0.03], // radians of aim angle
    pullError: [0.09, 0.035], // share of the pull
    shot: { across: [1.55, 1.9], pull: [0.76, 0.82], curveChance: [0.1, 0.5], curve: 0.7 }, // a beginner aims well inside the post
    swayShare: [0.8, 0.35], // share of a nervous aim's sway the bot fails to time out
    windRead: [0, 0.7], // share of the crosswind it allows for
    reaction: [0.34, 0.26], // seconds from the strike to a tap when reading the ball
    readError: [0.7, 0.3], // metres between the tap and where the ball will be
    gamble: { chance: 0.55, early: 0.12, across: 1.8, heights: [0.5, 1.2] }, // diving on the tell just before the strike
    seconds: { shoot: 13, keep: 10, between: 30, shop: 8 }, // how long each thing takes a person
  });

  /** A bell-shaped random number around 0 with about unit spread. */
  const bell = (rng) => rng.range(-1, 1) + rng.range(-1, 1) + rng.range(-1, 1);
  /** How practised a player is after some matches, 0..1. */
  const practiceOf = (matches) => 1 - Math.exp(-matches / BOT.practice);
  /** A `[first match, with practice]` pair of `BOT` at a level of practice. @param {number[]} pair @param {number} practice 0..1 */
  const skilled = ([raw, practised], practice) => lerp(raw, practised, practice);

  /** The bot shoots: at a corner away from the keeper's habit, with a human's error and an untimed sway. */
  const botShot = ({ rival, ballRow, stats, pressure, practice, wind, history }, rng) => {
    const habit = rival.keeper.guess * rival.keeper.bias;
    const side = Math.abs(habit) > 0.1 ? -Math.sign(habit) : rng.pick([-1, 1]);
    const boot = { power: stats.get('shotPower'), curl: stats.get('shotCurl') };
    const curve = rng.chance(skilled(BOT.shot.curveChance, practice)) ? side * BOT.shot.curve : 0;
    const aim = SIM.solveAim(side * skilled(BOT.shot.across, practice), { pull: clamp(skilled(BOT.shot.pull, practice) + bell(rng) * skilled(BOT.pullError, practice)), curve }, ballRow, boot, wind * skilled(BOT.windRead, practice));
    const angle = aim.angle + bell(rng) * skilled(BOT.aimError, practice) + SIM.swayAt(rng.range(0, 10), pressure, stats.get('sway')) * skilled(BOT.swayShare, practice);
    const launch = SIM.launchOf({ ...aim, angle }, ballRow, boot);
    const dive = SIM.rivalDive(rival.keeper, { launch, ballRow, wind, history }, rng);
    return SIM.createKick({ launch, ballRow, keeper: rival.keeper, dive, wind, wobblePhase: rng.range(0, Math.PI * 2) });
  };

  /** The bot keeps: it gambles on the tell just before the strike, or reads the ball and taps late. */
  const botSave = ({ rival, ballRow, stats, pressure, practice, wind }, rng) => {
    const keeper = { reach: stats.get('reach'), holdSpeed: stats.get('holdSpeed'), diveSpeed: stats.get('diveSpeed'), windup: stats.get('windup') };
    const intent = SIM.takerIntent(rival.taker, rng);
    const isGamble = rng.chance(BOT.gamble.chance);
    const early = isGamble ? SIM.diveOf({ x: intent.tell * BOT.gamble.across, y: rng.pick(BOT.gamble.heights) }, -BOT.gamble.early, keeper) : null;
    const launch = SIM.launchOf(SIM.takerAim(SIM.takerAnswer(intent, rival.taker, early, rng), rival.taker, ballRow, pressure, rng), ballRow);
    const kick = SIM.createKick({ launch, ballRow, keeper, dive: early, wind, wobblePhase: rng.range(0, Math.PI * 2) });
    const tapAt = skilled(BOT.reaction, practice);
    const error = skilled(BOT.readError, practice);
    return SIM.playKick(kick, (live) => {
      if (live.dive || live.time < tapAt) return;
      // A person judges where the ball is going from where it is: the true line, seen imperfectly.
      const heading = Kit.flight.trace(live.ball, { air: live.world.air, step: 1 / 60, maxSteps: 120, stopWhen: (now) => now.position.z <= SIM.KEEPER_Z }).end.position;
      live.dive = SIM.diveOf({ x: heading.x + bell(rng) * error, y: heading.y + bell(rng) * error * 0.5 }, live.time, keeper);
    });
  };

  /**
   * Plays one whole shootout as the stand-in player.
   * @param {{rival: Object, cup: Object}} match from `progress.matchAt`
   * @param {{stats: Object, ballRow: Object, matches: number}} player the player's stats (Kit.stats), ball and matches played so far
   * @param {Object} rng a `Kit.rng`
   * @returns {{won: boolean, coins: number, goals: number, saves: number, kicks: number, seconds: number, score: {you: number, them: number}}}
   * @complexity O(kicks x steps per kick): a few thousand flight steps
   * @example SPOT_KICK_BOTS.playMatch(progress.next(), { stats: progress.stats, ballRow: progress.ball(), matches: 0 }, Kit.rng(1)).won
   */
  const playMatch = ({ rival, cup }, { stats, ballRow, matches }, rng) => {
    const practice = practiceOf(matches);
    const tally = { coins: 0, goals: 0, saves: 0, kicks: 0, seconds: BOT.seconds.between, streak: 0, history: [] };
    let shootout = SIM.createShootout();
    while (!SIM.statusOf(shootout).winner) {
      const role = SIM.kickerOf(shootout) === 'you' ? 'taker' : 'keeper';
      const scene = { rival, ballRow, stats, practice, pressure: SIM.pressureOf(shootout, cup.pressure), wind: rng.range(-cup.wind, cup.wind), history: tally.history };
      const kick = role === 'taker' ? SIM.playKick(botShot(scene, rng)) : botSave(scene, rng);
      const reward = SIM.rewardOf(kick, role, tally.streak);
      tally.coins += reward.coins;
      tally.streak = reward.isSuccess ? tally.streak + 1 : 0;
      tally.kicks += 1;
      tally.seconds += BOT.seconds[role === 'taker' ? 'shoot' : 'keep'];
      if (role === 'taker') {
        tally.goals += kick.outcome === 'goal' ? 1 : 0;
        if (kick.crossed) tally.history.push(kick.crossed.x);
      } else tally.saves += kick.outcome !== 'goal' ? 1 : 0;
      shootout = SIM.recordKick(shootout, kick.outcome === 'goal');
    }
    const status = SIM.statusOf(shootout);
    return { won: status.winner === 'you', goals: tally.goals, saves: tally.saves, kicks: tally.kicks, seconds: tally.seconds, score: status.score, coins: tally.coins };
  };

  /** Coins for the result of a match at a ladder index (the win prize grows with the rungs climbed). */
  const matchPrize = (won, index) => (won ? REWARDS.win + REWARDS.perRung * index : REWARDS.loss);

  /** The standard progression interface that tools/sim.js drives (see games/README.md "Headless model"). */
  const PROGRESSION = {
    createState: () => ({ progress: DATA.createProgress(), matches: 0, seed: 1 }),
    actions: ({ progress }) => [
      { id: 'match', kind: 'play', label: `Play ${progress.next().rival.name}` },
      ...progress.forSale().map(({ kind, row }) => ({ id: `${kind}:${row.id}`, kind: 'buy', label: row.name, cost: row.cost, affordable: progress.wallet.can(row.cost) })),
    ],
    apply(state, action, random) {
      const { progress } = state;
      if (action.kind === 'buy') {
        const [kind, id] = action.id.split(':');
        progress.buy(kind, id);
        // A person tries what they have just bought.
        progress.equip(kind, id);
        return { seconds: BOT.seconds.shop };
      }
      const index = progress.rungsWon();
      const result = playMatch(progress.next(), { stats: progress.stats, ballRow: progress.ball(), matches: state.matches }, Kit.rng(Math.floor(random() * 0xffffffff)));
      state.matches += 1;
      const banked = progress.recordMatch({ ...result, index, coins: result.coins + matchPrize(result.won, index) });
      return { seconds: result.seconds, unlocked: [...(banked.climbed ? [`beat ${progress.matchAt(index).rival.name}`] : []), ...banked.opened] };
    },
    summary: ({ progress }) => ({
      currency: progress.wallet.get(),
      owned: progress.rungsWon() + DATA.BALLS.length + DATA.PERKS.length + DATA.KITS.length - progress.forSale().length,
      // The road never ends, so there is always a next rival to beat.
      remaining: progress.forSale().length + Math.max(1, DATA.LADDER.length - progress.rungsWon()),
    }),
  };

  window.SPOT_KICK_BOTS = { BOT, practiceOf, playMatch, matchPrize, PROGRESSION };
})();
