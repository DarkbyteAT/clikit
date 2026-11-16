/**
 * Spot Kick Showdown: a penalty shootout played from both ends. Drag back from the ball and let go to shoot;
 * when it is their turn you are in goal, and you tap where to dive.
 *
 * DEPTH PLAN (AGENTS.md principle 5)
 *   Seconds - mastery of one kick. Shooting: one drag sets the side and the power, and power is also height, so
 *     the top corners sit in a narrow band just under "over the bar". A sideways flick as you let go bends the
 *     ball, and the keeper reads the ball's first line, not its bend. Under pressure the aim sways like a held
 *     breath and the release has to be timed. Keeping: one tap sends the keeper to that spot. Go before the
 *     taker's window closes and a good one rolls it the other way; go late and you do not arrive. The run-up
 *     shows a tell; the hands must be where the ball is, when it is, and a clean take holds it.
 *   Minutes - one shootout. Five each, then sudden death. Their keeper has habits (gambles to one side, slow to
 *     read, or remembers where you have been shooting, so repeating a corner gets read); their taker has a
 *     favourite side, a height, and a tell that may be a lie. The bench's notes say which, and each kick tests
 *     them. Kicks that decide the match weigh on both sides: your aim sways, and a rival with poor nerve sprays.
 *     Goals and saves in a row build a streak that multiplies coins. Before the match you choose a ball both
 *     sides will kick (a fast ball beats their keeper and yours), one taker perk and one keeper perk.
 *   Hours - the ladder. Three cups of four rivals, each ground with its own rule (still air; a crosswind that
 *     changes every kick; a loud ground that raises the pressure), then the endless Champions' Road. Coins buy
 *     four balls with different flight, eight perks that each trade a strength for a weakness, and kits. What
 *     you have seen of each rival's takers stays on the scouting sheet between visits. Rivals get sharper faster
 *     than perks can cover, so the climb is mostly the player's own hands.
 *   Proof: `make sim GAME=penalty` plays the ladder for simulated hours with stand-in players who shoot and dive
 *     through the same rules (games/penalty-bots.js).
 *
 * This file owns: the match flow, input, the HUD and the clubhouse, and all feedback (sound, shake, callouts).
 * It does not own: tables and the long arc (games/penalty-data.js), the rules of a kick (games/penalty-sim.js),
 * the scene (games/penalty-stage.js), how characters act (games/penalty-perform.js: the adapter onto `Kit.act`),
 * the theme (games/penalty-theme.js), or generic pieces (Kit.flight, Kit.slingshot, Kit.netting, Kit.look).
 */
(() => {
  const DATA = window.SPOT_KICK_DATA, SIM = window.SPOT_KICK_SIM, BOTS = window.SPOT_KICK_BOTS;
  const { FIELD, RUN_UP, BALLS, PERKS, KITS, CUPS, ROAD, LADDER, RULES } = DATA;
  const { clamp, lerp } = Kit.math;

  // =================================================== presentation tables ===================================================

  /** Where the characters stand, world metres. The player's taker waits where the camera seat says (games/penalty-stage.js `SEATS`). */
  const MARKS = Object.freeze({
    keeper: { x: 0, z: SIM.KEEPER_Z },
    playerTaker: { strike: { x: -0.3, z: 0.8 }, seconds: 0.3 },
    rivalTaker: { wait: { x: 0.9, z: RUN_UP.startDistance }, strike: { x: 0.3, z: 0.8 } },
  });
  const FACING = Object.freeze({ goal: Math.PI, taker: 0 });

  /** How the ball is drawn back while aiming, and how the aim line is sampled. */
  const AIM_FEEL = Object.freeze({ drawBack: 0.42, previewStep: 1 / 60, ratchetTicks: 10, powerLamps: 12, sweet: [0.8, 0.9], heartbeat: { least: 0.3, period: [0.9, 0.42] } });
  /** The drag-back gesture here: a flick is the sideways travel of the last `settleMs` before the finger lifts (a thumb's flick takes about that long). */
  const SLING = Object.freeze({ settleMs: 150 });
  /** Keyboard play: how fast the arrow keys move the aim, and where each direction key sends the keeper. */
  const KEYS = Object.freeze({ angleRate: 0.7, pullRate: 0.6, startPull: 0.7, dive: { left: { x: 1.9, y: 0.9 }, right: { x: -1.9, y: 0.9 }, up: { x: 0, y: 1.9 }, down: { x: 0, y: 0.4 } } });

  /** Seconds each beat of a kick lasts. */
  const PACE = Object.freeze({ afterOutcome: 1.15, betweenKicks: 0.6 });

  /** Callout, sounds and crowd for each outcome, by whether it is good for the player. */
  const CALLOUTS = Object.freeze({
    taker: { goal: ['GOAL!', true], save: ['HELD!', false], parry: ['SAVED!', false], post: ['WOODWORK!', false], miss: ['OFF TARGET', false] },
    keeper: { goal: ['GOAL', false], save: ['WHAT A CATCH!', true], parry: ['SAVED!', true], post: ['OFF THE POST!', true], miss: ['THEY MISSED!', true] },
  });

  /** Feedback strengths. Hit-stops are milliseconds; shakes are the kit's units. */
  const FEEL = Object.freeze({
    strike: { stop: 45, shake: 0.22 },
    wood: { stop: 80, shake: 0.5 },
    glove: { stop: 90, shake: 0.4 },
    held: { stop: 110, shake: 0.25 },
    net: { shake: 0.3 },
    fullSpeed: 20, // contact speed at which sounds and shakes are at their strongest
  });

  /** Longest time after the strike the ball may take to come into the flight seat's picture from under the lens (a wide screen has the shortest lens, so the longest wait). */
  const CUT_GRACE = 0.12;
  const WIND_ARROW_STEP = 4; // metres per second of crosswind per arrow on the wind chip

  // ====================================================== small helpers ======================================================

  /** The recipe of the character saved in the Character Maker (its newest slot, else its draft), or null. */
  const savedCharacter = (catalog) => {
    if (!Kit.creator || !Kit.creator.slots || !Kit.creator.parseShareCode) return null;
    const store = Kit.store('creator');
    const draft = store.get('draft', null);
    const codes = [...Kit.creator.slots(store).list().map((slot) => slot.code), draft && draft.code].filter((code) => typeof code === 'string');
    // Saved text is data from another screen: it either decodes into a recipe of this catalogue or is ignored.
    const parsed = codes.map((code) => Kit.creator.parseShareCode(catalog, code)).find((result) => result.ok);
    return parsed ? parsed.recipe : null;
  };

  /** Wind chip text: arrows point where the wind pushes as the player sees it in a role. */
  const windText = (wind, role) => {
    const towardScreenRight = role === 'taker' ? wind > 0 : wind < 0;
    return `WIND ${(towardScreenRight ? '>' : '<').repeat(clamp(Math.ceil(Math.abs(wind) / WIND_ARROW_STEP), 1, 3))}`;
  };

  /** The lamps of one side's row: its kicks so far, the one being taken, and the ones to come. */
  const lampsOf = (kicks, isKicking) => {
    const shown = Math.max(RULES.kicks, kicks.length + (isKicking ? 1 : 0));
    const states = Array.from({ length: shown }, (_unused, index) => (index < kicks.length ? (kicks[index] ? 'goal' : 'miss') : index === kicks.length && isKicking ? 'next' : 'todo'));
    // Sudden death can run long: the board keeps the newest five.
    return states.slice(-RULES.kicks);
  };

  // ========================================================= the game =========================================================

  /**
   * Builds one session of the game.
   * @param {Object} ctx the kit's game context
   * @returns {{update: function(number, number): void, render: function(): void, dispose: function(): void, debugState: function(): Object, tools: Object}}
   */
  const createGame = (ctx) => {
    const { input, fx, sfx, ui, save } = ctx;
    const { html, signal, Button, Card, Tabs } = Kit.ui;
    const stage = window.SPOT_KICK_STAGE.build(ctx);
    const PERFORM = window.SPOT_KICK_PERFORM;
    const progress = DATA.createProgress({ save });
    const saved = savedCharacter(stage.catalog);
    const sling = Kit.slingshot.gesture(SLING);
    const random = Kit.rng();

    // ------------------------------------------------------- state -------------------------------------------------------

    /** The match in play: its ladder entry, the shootout, the four actors and the running tallies. */
    let match = null;
    /** The kick in play: the rules' kick once struck, and what led up to it. */
    let play = { role: 'taker', kick: null, clock: 0, pressure: 0, wind: 0, intent: null, earlyDive: null, hasDived: false, aimSeconds: 0, carry: 0, lastOutcome: null };
    const keyAim = { isActive: false, angle: 0, pull: KEYS.startPull };
    let liveAim = { pull: 0, angle: 0, isArmed: false };
    let ratchetStep = 0;
    /** The camera's promises, counted per frame while a playtest watches them: frames checked, and frames each promise was broken. */
    const framing = { isWatched: false, frames: 0, broken: {}, first: {} };
    let heartbeatIn = 0;

    // -------------------------------------------------------- HUD --------------------------------------------------------

    const board = signal({ you: [], them: [], rival: '', kicker: 'you', score: { you: 0, them: 0 } });
    const strip = signal({ role: 'taker', round: 1, isSuddenDeath: false, pressure: 0, wind: 0, coins: 0, streak: 0 });
    const scout = signal(null);
    const power = signal(null);
    const Lamps = ({ states }) => html`<span class="sk-lamps">${states.map((state) => html`<i class="sk-lamp" data-state=${state}></i>`)}</span>`;
    const Hud = () => {
      const { you, them, rival, kicker, score } = board.value;
      const { role, round, isSuddenDeath, pressure, wind, coins, streak } = strip.value;
      const lamps = power.value === null ? [] : Array.from({ length: AIM_FEEL.powerLamps }, (_unused, index) => (index + 0.5) / AIM_FEEL.powerLamps);
      const zoneOf = (share) => (share > AIM_FEEL.sweet[1] ? 'over' : share >= AIM_FEEL.sweet[0] ? 'sweet' : null);
      return html`
        <div class="sk-top">
          <div class="sk-board" role="status" aria-label="Shootout score">
            <b data-side="you">YOU</b><${Lamps} states=${lampsOf(you, kicker === 'you')} /><output>${score.you}</output>
            <b>${rival}</b><${Lamps} states=${lampsOf(them, kicker === 'them')} /><output>${score.them}</output>
          </div>
          <div class="sk-strip">
            <span class="sk-chip" data-tone="live">${role === 'taker' ? 'YOUR KICK' : 'IN GOAL'}</span>
            <span class="sk-chip">${isSuddenDeath ? 'SUDDEN DEATH' : `KICK ${Math.min(round, RULES.kicks)}/${RULES.kicks}`}</span>
            <span class="sk-chip" data-tone="hot" hidden=${pressure < AIM_FEEL.heartbeat.least}>${pressure > 0.7 ? 'MUST SCORE' : 'BIG KICK'}</span>
            <span class="sk-chip" hidden=${wind === 0}>${windText(wind, role)}</span>
            <span class="sk-chip" hidden=${streak < 2}>${`STREAK x${streak}`}</span>
            <span class="sk-chip" title="Coins won this match">${`+${coins} C`}</span>
          </div>
        </div>
        <div class="sk-bottom">
          <div class="sk-power" hidden=${power.value === null} aria-hidden="true">${lamps.map((share) => html`<i data-on=${share <= power.value ? '' : null} data-zone=${zoneOf(share)}></i>`)}</div>
          <div class="sk-scout" hidden=${!scout.value}><small>THE BENCH SAYS</small>${scout.value}</div>
        </div>
      `;
    };
    ui.mount(html`<${Hud} />`);
    const hint = ui.hint('Drag back from the ball, let go to shoot');

    const refreshBoard = () => {
      const status = SIM.statusOf(match.shootout);
      board.value = { you: match.shootout.you, them: match.shootout.them, rival: match.rival.name.toUpperCase(), kicker: status.winner ? null : SIM.kickerOf(match.shootout), score: status.score };
      strip.value = { ...strip.value, role: play.role, round: status.round, isSuddenDeath: status.isSuddenDeath && !status.winner, pressure: play.pressure, wind: play.wind, streak: match.streak, coins: match.coins };
    };

    // ------------------------------------------------------ the cast ------------------------------------------------------

    /** Builds the four characters of a match, standing where they wait. */
    const castMatch = () => {
      stage.clearFigures();
      const actorOf = (recipe) => PERFORM.actor(stage.addFigure(recipe));
      match.cast = {
        you: { taker: actorOf(DATA.playerRecipe(stage.catalog, saved, progress.kit(), 'taker')), keeper: actorOf(DATA.playerRecipe(stage.catalog, saved, progress.kit(), 'keeper')) },
        them: { taker: actorOf(DATA.rivalRecipe(stage.catalog, match.rival, 'taker')), keeper: actorOf(DATA.rivalRecipe(stage.catalog, match.rival, 'keeper')) },
      };
      // The order the stage was given them in: the order of `stage.framing().figures`.
      match.order = [match.cast.you.taker, match.cast.you.keeper, match.cast.them.taker, match.cast.them.keeper];
    };
    /** The two actors of the kick in play: `[taker, keeper]`. */
    const onPitch = () => (play.role === 'taker' ? [match.cast.you.taker, match.cast.them.keeper] : [match.cast.them.taker, match.cast.you.keeper]);
    const showCast = () => {
      const [taker, keeper] = onPitch();
      match.order.forEach((each) => (each.figure.root.visible = each === taker || each === keeper));
      const takerMark = play.role === 'taker' ? stage.takerWait() : MARKS.rivalTaker.wait;
      taker.stand(takerMark.x, takerMark.z, FACING.goal);
      keeper.stand(MARKS.keeper.x, MARKS.keeper.z, FACING.taker);
      keeper.ready();
    };

    // ------------------------------------------------------ feedback ------------------------------------------------------

    const strength = (speed) => clamp(speed / FEEL.fullSpeed, 0.25, 1);
    /** The clang of a ball on the frame: two detuned square notes. */
    const clang = (speed) => [1180, 1730].forEach((freq) => sfx.tone({ freq, to: freq * 0.97, dur: 0.35, type: 'square', vol: 0.12 * strength(speed) }));
    const roar = (volume) => sfx.noise({ dur: 1.1, vol: 0.28 * volume, freq: 900, q: 0.6, type: 'bandpass' });
    const groan = () => sfx.tone({ freq: 220, to: 130, dur: 0.6, type: 'sawtooth', vol: 0.08 });

    /** What the presenter does for each event of the rules. */
    const ON_EVENT = {
      ground({ speed, point }) {
        sfx.play('thud', { vol: 0.5 * strength(speed), pitch: 1.3, gap: 0.05 });
        stage.burst(point, { count: 4, speed: 1.2, up: 1.4, colors: [3] });
      },
      post({ speed, point }) {
        clang(speed);
        fx.hitstop(FEEL.wood.stop);
        fx.shake(FEEL.wood.shake * strength(speed));
        stage.burst(point, { count: 8, speed: 2.5, up: 2, colors: [3] });
        sfx.buzz(30);
      },
      parry({ speed, point }) {
        sfx.play('hit', { vol: strength(speed), pitch: 0.8 });
        sfx.play('thud', { vol: strength(speed) });
        fx.hitstop(FEEL.glove.stop);
        fx.shake(FEEL.glove.shake * strength(speed));
        stage.burst(point, { count: 10, speed: 3, up: 2.5, colors: [3, 0] });
        sfx.buzz(25);
      },
      held({ speed, point }) {
        sfx.play('thud', { vol: strength(speed), pitch: 0.7 });
        fx.hitstop(FEEL.held.stop);
        fx.shake(FEEL.held.shake);
        stage.burst(point, { count: 6, speed: 1.5, up: 1.5, colors: [3] });
        sfx.buzz(35);
      },
      net({ speed }) {
        sfx.noise({ dur: 0.28, vol: 0.3 * strength(speed), freq: 2600, q: 0.8, type: 'highpass' });
        fx.shake(FEEL.net.shake * strength(speed));
      },
      crossed() {},
      outcome({ outcome }) {
        const [text, isGood] = CALLOUTS[play.role][outcome];
        ui.toast(text, 1100);
        const [taker, keeper] = onPitch();
        const didScore = outcome === 'goal';
        (didScore ? taker : keeper).celebrate();
        (didScore ? keeper : taker).slump();
        if (isGood) {
          roar(1);
          stage.cheer(1);
          sfx.play(didScore ? 'win' : 'perfect');
          stage.burst({ x: play.kick.ball.position.x, y: 1.6, z: SIM.LINE_Z + 0.5 }, { count: 36, speed: 5, up: 5 });
        } else {
          groan();
          stage.cheer(didScore ? 0.35 : 0);
        }
      },
    };
    ON_EVENT.bar = ON_EVENT.post;
    ON_EVENT.block = ON_EVENT.parry;

    // ----------------------------------------------------- match flow -----------------------------------------------------

    /** The keeper the rules use when the player is in goal: the player's stats now. */
    const playerKeeper = () => ({ reach: progress.stats.get('reach'), holdSpeed: progress.stats.get('holdSpeed'), diveSpeed: progress.stats.get('diveSpeed'), windup: progress.stats.get('windup') });
    const boot = () => ({ power: progress.stats.get('shotPower'), curl: progress.stats.get('shotCurl') });

    /** Sets up the next kick: whose it is, how much it weighs, the wind, and where everyone stands. */
    const beginKick = () => {
      const role = SIM.kickerOf(match.shootout) === 'you' ? 'taker' : 'keeper';
      play = { role, kick: null, clock: 0, pressure: SIM.pressureOf(match.shootout, match.cup.pressure), wind: match.cup.wind ? random.range(-match.cup.wind, match.cup.wind) : 0, intent: null, earlyDive: null, hasDived: false, aimSeconds: 0, carry: 0, lastOutcome: play.lastOutcome };
      stage.setSeat(role === 'taker' ? 'aim' : 'keeper');
      stage.setWind(play.wind);
      stage.ball.set(SIM.SPOT, { x: 0, y: 0, z: 0 }, 0);
      stage.aim.hide();
      stage.marker.hide();
      stage.tell.show(0, 0, 0);
      showCast();
      const notes = DATA.scoutOf(match.rival)[role === 'taker' ? 'keeper' : 'taker'];
      scout.value = notes[(match.shootout.you.length + match.shootout.them.length) % notes.length];
      refreshBoard();
      flow.go(role === 'taker' ? 'aiming' : 'facing');
    };

    /** Starts a match against a ladder entry. */
    const beginMatch = (index) => {
      const entry = progress.matchAt(index);
      match = { ...entry, shootout: SIM.createShootout(), cast: null, order: [], streak: 0, coins: 0, goals: 0, saves: 0, history: [] };
      stage.setLook(entry.cup.look, progress.ball().colors);
      castMatch();
      ui.toast(`${entry.rival.name} at ${entry.cup.ground}`, 1500);
      sfx.play('up');
      beginKick();
    };

    /** The strike: the rules take over from here. */
    const strike = (launch, dive) => {
      play.kick = SIM.createKick({ launch, ballRow: progress.ball(), keeper: play.role === 'taker' ? match.rival.keeper : playerKeeper(), dive, wind: play.wind, wobblePhase: random.range(0, Math.PI * 2) });
      const pace = Math.hypot(launch.velocity.x, launch.velocity.y, launch.velocity.z);
      sfx.play('hit', { pitch: 0.7 + strength(pace) * 0.4 });
      sfx.play('thud', { vol: strength(pace) });
      fx.hitstop(FEEL.strike.stop);
      fx.shake(FEEL.strike.shake * strength(pace));
      stage.burst(SIM.SPOT, { count: 7, speed: 2, up: 2, colors: [3] });
      sfx.buzz(18);
      // Their keeper moves when the rules say; the player's keeper is already moving if the player has tapped.
      if (play.role === 'taker' && dive) onPitch()[1].dive(diveShown(dive, 0));
      // The cut: at the strike the camera steps past the taker, so nothing stands between the lens and the flight.
      if (play.role === 'taker') stage.setSeat('flight');
      flow.go('flight');
    };

    /** The player's shot leaves the boot: their keeper decides, and the kick begins. */
    const strikeAsTaker = () => {
      const launch = SIM.launchOf(play.shot, progress.ball(), boot());
      strike(launch, SIM.rivalDive(match.rival.keeper, { launch, ballRow: progress.ball(), wind: play.wind, history: match.history }, random));
    };

    /** Their shot leaves the boot: the taker answers an early dive, sprays under pressure, and the kick begins. */
    const strikeAsKeeper = () => {
      const answered = SIM.takerAnswer(play.intent, match.rival.taker, play.earlyDive, random);
      strike(SIM.launchOf(SIM.takerAim(answered, match.rival.taker, progress.ball(), play.pressure, random), progress.ball()), play.earlyDive);
    };

    /** A dive of the rules as the actor is asked for it: where, how long until the body moves, and how long it then takes. */
    const diveShown = (dive, now) => ({ target: dive.target, delay: Math.max(0, dive.start - now), seconds: dive.windup + dive.duration - Math.max(0, now - dive.start) });

    /** Sends the player's keeper to a point of the keeper's plane: once per kick, before or after the strike. */
    const diveTo = (point) => {
      if (play.role !== 'keeper' || play.hasDived || !point) return;
      if (!flow.is('facing') && !flow.is('flight')) return;
      play.hasDived = true;
      hint.hide();
      const keeper = playerKeeper();
      const now = play.kick ? play.kick.time : play.clock - RUN_UP.seconds;
      const dive = SIM.diveOf(point, now, keeper);
      if (play.kick) play.kick.dive = dive;
      else play.earlyDive = dive;
      onPitch()[1].dive(diveShown(dive, now));
      stage.marker.show(dive.target);
      sfx.play('whoosh', { pitch: 1.2 });
      sfx.buzz(12);
    };

    /** Banks a finished kick and moves on. */
    const endKick = () => {
      const { kick, role } = play;
      const reward = SIM.rewardOf(kick, role, match.streak);
      match.streak = reward.isSuccess ? match.streak + 1 : 0;
      match.coins += reward.coins;
      if (reward.coins) fx.floater(`+${reward.coins}${reward.isCorner ? ' TOP BINS' : ''}`, kick.ball.position, { size: 22 });
      if (role === 'taker') {
        match.goals += kick.outcome === 'goal' ? 1 : 0;
        if (kick.crossed) match.history.push(kick.crossed.x);
      } else {
        match.saves += kick.outcome !== 'goal' ? 1 : 0;
        if (kick.crossed) progress.noteShot(match.rival.id, kick.crossed);
      }
      play.lastOutcome = kick.outcome;
      match.shootout = SIM.recordKick(match.shootout, kick.outcome === 'goal');
      refreshBoard();
      // Back behind the ball for the reactions: the taker and the keeper are both in the picture, whole.
      if (role === 'taker') stage.setSeat('aim');
      if (SIM.statusOf(match.shootout).winner) flow.go('result');
      else ctx.after(PACE.betweenKicks, beginKick);
    };

    // ------------------------------------------------------ clubhouse ------------------------------------------------------

    const SHOP_LABELS = { ball: 'BALLS (both sides kick it)', perk: 'PERKS (one for shooting, one for goal)', kit: 'KITS' };
    const isEquipped = (kind, row) => {
      const worn = progress.equipped();
      return kind === 'perk' ? worn[row.role] === row.id : worn[kind] === row.id;
    };

    /** The clubhouse: the ladder and the locker room. Resolves with the ladder index to play. */
    const openClubhouse = () => {
      const revision = signal(0);
      const Locker = () => {
        revision.value; // read so a purchase or a change of kit redraws the cards
        const shelf = (kind, rows) => html`
          <h3>${SHOP_LABELS[kind]}</h3>
          <div class="sk-cards">
            ${rows.filter((row) => kind !== 'kit' || row.id !== 'own' || saved).map((row) => {
              const isOwned = progress.isOwned(kind, row);
              const tag = isEquipped(kind, row) ? 'IN USE' : isOwned ? 'OWNED' : `${row.cost} C`;
              const press = () => {
                if (isOwned ? progress.equip(kind, row.id) : progress.buy(kind, row.id) && progress.equip(kind, row.id)) sfx.play(isOwned ? 'tap' : 'coin');
                revision.value += 1;
              };
              return html`<${Card} key=${row.id} id=${`sk-${kind}-${row.id}`} class=${isEquipped(kind, row) ? 'sk-on' : ''} title=${row.name} text=${row.blurb || (row.role ? '' : 'A strip for your side.')} tag=${tag} mark=${row.role ? (row.role === 'taker' ? 'S' : 'G') : undefined} disabled=${!isOwned && !progress.wallet.can(row.cost)} sound=${null} onClick=${press} />`;
            })}
          </div>`;
        return html`<div class="sk-club"><span class="sk-purse">${`${progress.wallet.get()} C`}</span>${shelf('ball', BALLS)}${shelf('perk', PERKS)}${shelf('kit', KITS)}</div>`;
      };
      const Ladder = ({ close }) => {
        const won = progress.rungsWon();
        const cupCards = (cup) => LADDER.filter((entry) => entry.cup.id === cup.id).map((entry) => {
          const state = entry.index < won ? 'done' : entry.index === won ? 'on' : 'locked';
          const notes = DATA.scoutOf(entry.rival);
          return html`<${Card} key=${entry.rival.id} id=${`sk-rival-${entry.rival.id}`} class=${`sk-${state}`} mark=${entry.index + 1} title=${entry.rival.name} tag=${state === 'done' ? 'BEATEN: REMATCH' : state === 'on' ? 'PLAY' : 'LOCKED'} text=${state === 'locked' ? '' : `Keeper: ${notes.keeper[0]}. Taker: ${notes.taker[0]}.`} disabled=${state === 'locked'} onClick=${() => close(entry.index)} />`;
        });
        const road = progress.matchAt(Math.max(won, LADDER.length));
        return html`<div class="sk-club">
          ${CUPS.map((cup) => html`<h3>${cup.name.toUpperCase()}</h3><p>${`${cup.ground}. ${cup.blurb}`}</p><div class="sk-cards">${cupCards(cup)}</div>`)}
          <h3>${ROAD.name.toUpperCase()}</h3><p>${ROAD.blurb}</p>
          <div class="sk-cards"><${Card} id="sk-rival-road" class=${progress.isRoadOpen() ? 'sk-on' : 'sk-locked'} mark=${road.index + 1} title=${road.rival.name} tag=${progress.isRoadOpen() ? 'PLAY' : 'WIN THE CUPS FIRST'} disabled=${!progress.isRoadOpen()} onClick=${() => close(road.index)} /></div>
        </div>`;
      };
      return ui.dialog({
        title: 'Clubhouse',
        variant: 'sheet',
        dismissable: false,
        body: (close) => html`<${Tabs} label="Clubhouse" tabs=${[{ id: 'ladder', label: 'Ladder', content: () => html`<${Ladder} close=${close} />` }, { id: 'locker', label: 'Locker', content: () => html`<${Locker} />` }]} />`,
        actions: (close) => html`<${Button} variant="primary" id="sk-play-next" onClick=${() => close(progress.rungsWon())}>${`Play ${progress.next().rival.name}`}<//>`,
      });
    };

    const showClubhouse = () => {
      flow.go('menu');
      return openClubhouse().then((index) => beginMatch(Number.isInteger(index) ? index : progress.rungsWon()));
    };

    /** The final whistle: bank the match, say what it opened, and offer the next thing. */
    const showResult = () => {
      const status = SIM.statusOf(match.shootout);
      const won = status.winner === 'you';
      const prize = BOTS.matchPrize(won, match.index);
      const banked = progress.recordMatch({ won, coins: match.coins + prize, goals: match.goals, saves: match.saves, index: match.index });
      sfx.play(won ? 'win' : 'lose');
      if (won) stage.cheer(1);
      const rows = [['Shootout', `${status.score.you} - ${status.score.them}`], ['Kicks and saves', `${match.coins} C`], [won ? 'Win prize' : 'For turning up', `${prize} C`], ...(banked.prize ? [['Cup prize', `${banked.prize} C`]] : []), ...banked.opened.map((text) => ['New', text])];
      const playedIndex = match.index;
      return ui.dialog({
        title: won ? 'You win!' : `${match.rival.name} win`,
        dismissable: false,
        body: () => html`<dl class="sk-club">${rows.map(([label, value]) => html`<p><b>${label}</b>${' '}${value}</p>`)}</dl>`,
        actions: (close) => html`
          <${Button} variant="primary" id="sk-again" onClick=${() => close('again')}>${won ? `Next: ${progress.next().rival.name}` : 'Rematch'}<//>
          <${Button} id="sk-clubhouse" onClick=${() => close('club')}>Clubhouse<//>`,
      }).then((choice) => (choice === 'club' ? showClubhouse() : beginMatch(won ? progress.rungsWon() : playedIndex)));
    };

    // ------------------------------------------------------- aiming -------------------------------------------------------

    /** The aim as it would be struck now: the hand's aim plus the sway of the moment. */
    const swayedAim = (aim) => ({ ...aim, angle: aim.angle + SIM.swayAt(play.aimSeconds, play.pressure, progress.stats.get('sway')) });

    /** Clicks as the pull crosses each notch, brighter in the sweet band. */
    const playRatchet = (pull) => {
      const step = Math.floor(pull * AIM_FEEL.ratchetTicks);
      if (step === ratchetStep) return;
      ratchetStep = step;
      sfx.play('click', { pitch: 0.8 + pull * 1.2, vol: 0.5 });
      sfx.buzz(4);
    };

    /** Draws the aim line for the live aim and pulls the ball back with it. */
    const showAim = (aim) => {
      const struck = swayedAim(aim);
      const launch = SIM.launchOf({ ...struck, curve: 0 }, progress.ball(), boot());
      const path = Kit.flight.trace(Kit.flight.ball({ position: SIM.SPOT, velocity: launch.velocity, radius: FIELD.ballRadius }), { air: SIM.airOf(progress.ball(), 0), step: AIM_FEEL.previewStep, maxSteps: 90, stopWhen: (now) => now.position.z <= SIM.KEEPER_Z });
      const shown = clamp(progress.stats.get('preview'));
      const reached = path.end.position.z <= SIM.KEEPER_Z;
      stage.aim.show(path.points.slice(0, Math.ceil(path.points.length * shown)), shown >= 1 && reached ? path.end.position : null, ctx.time);
      const yaw = struck.angle * DATA.SHOT.yawPerAngle;
      stage.ball.set({ x: -Math.sin(yaw) * aim.pull * AIM_FEEL.drawBack, y: FIELD.ballRadius, z: Math.cos(yaw) * aim.pull * AIM_FEEL.drawBack }, { x: 0, y: 0, z: 0 }, 0);
      power.value = aim.pull;
      playRatchet(aim.pull);
    };

    const hideAim = () => {
      stage.aim.hide();
      stage.ball.set(SIM.SPOT, { x: 0, y: 0, z: 0 }, 0);
      power.value = null;
    };

    /** Lets the shot go: the taker runs the last steps and strikes. */
    const releaseShot = (aim) => {
      hideAim();
      if (!aim.isArmed) return sfx.play('click', { pitch: 0.6 });
      hint.hide();
      play.shot = { ...swayedAim(aim), curve: aim.curve || 0 };
      const [taker] = onPitch();
      taker.runUp({ from: stage.takerWait(), to: MARKS.playerTaker.strike, seconds: MARKS.playerTaker.seconds });
      sfx.play('whoosh', { pitch: 0.9 });
      return flow.go('running');
    };

    /** The low double thump of a pulse, quicker as the kick matters more. */
    const beatHeart = (dt) => {
      if (play.pressure < AIM_FEEL.heartbeat.least) return;
      heartbeatIn -= dt;
      if (heartbeatIn > 0) return;
      heartbeatIn = lerp(AIM_FEEL.heartbeat.period[0], AIM_FEEL.heartbeat.period[1], play.pressure);
      [0, 0.14].forEach((delay) => sfx.tone({ freq: 62, to: 40, dur: 0.12, type: 'sine', vol: 0.5, delay }));
      sfx.buzz(8);
    };

    // `time` is when the finger was there, not when this frame got round to it: a flick is measured in milliseconds.
    input.onDrag(({ phase, x, y, nx, ny, time: now }) => {
      if (ctx.paused || !match) return;
      if (phase === 'start') {
        if (flow.is('aiming')) {
          keyAim.isActive = false;
          ratchetStep = 0;
          // The hint has done its job once a thumb is down; the power lamps take its place.
          hint.hide();
          sling.begin(x, y, now);
        } else diveTo(stage.pickKeeperPlane(nx, ny));
      } else if (phase === 'move') sling.move(x, y, now);
      else if (phase === 'end' && sling.isActive()) {
        const shot = sling.release(now);
        if (flow.is('aiming')) releaseShot(shot);
      }
    });
    // Keyboard: the arrows aim and Space shoots; in goal an arrow is a dive that way and Space stands tall.
    input.onSwipe((direction) => {
      if (ctx.paused || !match) return;
      if (flow.is('facing') || flow.is('flight')) diveTo(KEYS.dive[direction]);
    });
    input.onTap(() => {
      if (ctx.paused || !match || !keyAim.isActive || !flow.is('aiming')) return;
      keyAim.isActive = false;
      releaseShot({ ...Kit.slingshot.read(-Math.tan(keyAim.angle) * 100, 100), pull: keyAim.pull, angle: keyAim.angle, curve: 0, isArmed: true });
    });

    // -------------------------------------------------------- flow --------------------------------------------------------

    /** Steps the rules at their fixed rate and reacts to what happened. */
    const stepKick = (dt) => {
      play.carry += dt;
      while (play.carry >= DATA.STEP && !play.kick.isOver) {
        play.carry -= DATA.STEP;
        SIM.stepKick(play.kick, DATA.STEP).forEach((event) => ON_EVENT[event.type](event));
      }
    };

    const flow = Kit.fsm(
      {
        // A sheet is open.
        menu: {},
        aiming: {
          enter() {
            liveAim = { pull: 0, angle: 0, isArmed: false };
            heartbeatIn = 0;
          },
          update(dt) {
            play.aimSeconds += dt;
            beatHeart(dt);
            const { stick } = input;
            if (!sling.isActive() && (stick.x || stick.y)) {
              keyAim.isActive = true;
              keyAim.angle = clamp(keyAim.angle + stick.x * KEYS.angleRate * dt, -Kit.slingshot.DEFAULTS.maxAngle, Kit.slingshot.DEFAULTS.maxAngle);
              keyAim.pull = clamp(keyAim.pull - stick.y * KEYS.pullRate * dt, Kit.slingshot.DEFAULTS.minPull, 1);
            }
            liveAim = sling.isActive() ? sling.aim() : keyAim.isActive ? { pull: keyAim.pull, angle: keyAim.angle, isArmed: true } : { pull: 0, angle: 0, isArmed: false };
            if (liveAim.isArmed) showAim(liveAim);
            else hideAim();
          },
          exit: hideAim,
        },
        // The player's taker covers the last steps; the boot arrives a moment after the run-up ends.
        running: {
          update(dt, seconds) {
            const [taker] = onPitch();
            if (seconds >= MARKS.playerTaker.seconds && taker.mode() === 'runUp') taker.kick(SIM.SPOT);
            if (seconds >= MARKS.playerTaker.seconds + taker.STRIKE_SECONDS) strikeAsTaker();
          },
        },
        // Their taker comes in. The player may dive at any moment from here on.
        facing: {
          enter() {
            play.intent = SIM.takerIntent(match.rival.taker, random);
            onPitch()[0].runUp({ from: MARKS.rivalTaker.wait, to: MARKS.rivalTaker.strike, seconds: RUN_UP.seconds - PERFORM.TIMING.strikeAt, tell: play.intent.tell });
            hint.set('Tap where to dive. Not too early, not too late');
          },
          update(dt) {
            play.clock += dt;
            const [taker] = onPitch();
            const untilStrike = RUN_UP.seconds - play.clock;
            if (progress.stats.get('tellHint') > 0 && untilStrike < RUN_UP.tellAt) stage.tell.show(play.intent.tell, taker.figure.root.position.x, taker.figure.root.position.z);
            if (untilStrike <= taker.STRIKE_SECONDS && taker.mode() === 'runUp') taker.kick(SIM.SPOT);
            if (untilStrike <= 0) strikeAsKeeper();
          },
          exit: () => stage.tell.show(0, 0, 0),
        },
        flight: {
          update(dt) {
            stepKick(dt);
            if (play.kick.isOver) flow.go('settled');
          },
        },
        settled: { enter: endKick },
        result: { enter: () => ctx.after(PACE.afterOutcome, showResult) },
      },
      'menu'
    );

    ctx.on('resize', () => {
      stage.resize();
      // The taker waits where the picture has room for them; a turned screen has different room.
      if (match && flow.is('aiming')) showCast();
    });

    // ---------------------------------------------------- the camera's promises ----------------------------------------------------

    const overlaps = (first, second) => Boolean(first && second) && first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
    const isWhole = (rect) => Boolean(rect) && rect.left > 0 && rect.top > 0 && rect.right < ctx.size.w && rect.bottom < ctx.size.h;
    /**
     * What each seat promises, as checks over the screen rectangles of `stage.framing()`. A check that returns
     * false on a frame counts as broken on it. `cast` is `{ taker, keeper }`: the rectangles of the two on the pitch.
     * @type {Object<string, function(Object, {taker: ?Object, keeper: ?Object}): boolean>}
     */
    const PROMISES = {
      'the whole goal is on screen': ({ goal }) => isWhole(goal),
      'the taker never covers the goal': ({ goal }, { taker }) => play.role !== 'taker' || !overlaps(taker, goal),
      'the taker never covers their keeper': (_seen, { taker, keeper }) => play.role !== 'taker' || !overlaps(taker, keeper),
      // While the taker runs in and swings, the boot and the ball must meet: the promise holds before and after.
      'the taker never covers the ball': ({ ball }, { taker }) => play.role !== 'taker' || flow.is('running') || !overlaps(taker, ball),
      'the taker is seen whole while aiming': (_seen, { taker }) => !flow.is('aiming') || isWhole(taker),
      'their keeper is on screen': (_seen, { keeper }) => play.role !== 'taker' || Boolean(keeper),
      // The cut steps over the ball, so it enters the new picture from below a moment after the strike: it must be in
      // within the grace, never leave once it is in, and stay until it reaches the keeper's plane (a ball may then fly over the bar and out).
      'the ball is on screen': ({ ball }) => {
        if (flow.is('aiming') || flow.is('facing')) return Boolean(ball);
        if (!flow.is('flight') || play.kick.crossed || play.kick.outcome) return true;
        if (ball) framing.enteredKick = play.kick;
        return Boolean(ball) || (play.kick.time <= CUT_GRACE && framing.enteredKick !== play.kick);
      },
      'your keeper never covers the ball before the strike': ({ ball }, { keeper }) => !flow.is('facing') || !overlaps(keeper, ball),
      'your keeper is seen whole before the strike': (_seen, { keeper }) => !flow.is('facing') || play.hasDived || isWhole(keeper),
    };
    const checkFraming = () => {
      const seen = stage.framing();
      const [taker, keeper] = onPitch().map((each) => seen.figures[match.order.indexOf(each)]);
      framing.frames += 1;
      Object.keys(PROMISES)
        .filter((name) => !PROMISES[name](seen, { taker, keeper }))
        .forEach((name) => {
          framing.broken[name] = (framing.broken[name] || 0) + 1;
          // Where it first broke, so a failed run says which moment to look at.
          framing.first[name] = framing.first[name] || { phase: flow.state, role: play.role, seat: stage.seat(), kickTime: play.kick ? play.kick.time : 0, ball: play.kick ? { ...play.kick.ball.position } : null };
        });
    };

    // A first visit goes straight to the spot; a returning player starts in the clubhouse.
    if (progress.profile.stat('matches') === 0) beginMatch(0);
    else showClubhouse();

    const game = {
      update(dt, time) {
        flow.update(dt);
        if (match && match.cast) {
          onPitch().forEach((each) => each.update(dt, time));
          const kick = play.kick;
          if (kick) stage.ball.set(kick.ball.position, kick.ball.velocity, dt);
          const isNetted = stage.net.update(dt, kick ? kick.ball.position : null);
          if (isNetted && kick && !kick.touched.net) sfx.noise({ dur: 0.12, vol: 0.12, freq: 3000, type: 'highpass' });
        }
        stage.update(dt, time);
        if (framing.isWatched && match) checkFraming();
      },
      render: () => stage.render(),
      dispose: () => stage.dispose(),
      /**
       * Handles for scripted playtests (`Kit.debug.tools()` in a `node tools/dev.js play` step): play a kick
       * without a finger, jump the ladder, and measure the picture and its cost.
       */
      tools: {
        progress,
        shoot: (aim) => flow.is('aiming') && releaseShot({ curve: 0, isArmed: true, ...aim }),
        dive: (x, y) => diveTo({ x, y }),
        /** Ends the match in play at once, five kicks to none, for or against the player (to reach the result sheet). */
        finish(won) {
          match.shootout = { first: 'you', you: Array.from({ length: RULES.kicks }, () => won), them: Array.from({ length: RULES.kicks }, () => !won) };
          flow.go('result');
        },
        /** Jumps to a kick with the player in goal (a fresh shootout that the rival starts). */
        face() {
          match.shootout = SIM.createShootout('them');
          beginKick();
        },
        beginMatch,
        showClubhouse,
        /** Starts (or stops) checking the camera's promises every frame; `debugState().framing` reports the count. */
        watchFraming: (isWatched = true) => Object.assign(framing, { isWatched, frames: 0, broken: {}, first: {} }),
        framing: () => stage.framing(),
        /** The aim the player's last shot was struck with (pull, angle, curve). */
        lastShot: () => play.shot || null,
        budget: () => stage.budget(),
        handsOff: () => onPitch()[1].handsOff(),
        /**
         * Times the game's own work on the main thread: `frames` updates and renders run back to back.
         * @param {number} frames
         * @returns {{updateMs: number, renderMs: number}} mean milliseconds per frame (draw calls and triangles: `Kit.debug.probe()`)
         */
        measure(frames) {
          const timed = (work) => {
            const startedAt = performance.now();
            for (let frame = 0; frame < frames; frame++) work();
            return (performance.now() - startedAt) / frames;
          };
          return { updateMs: timed(() => game.update(DATA.STEP * 2, ctx.time)), renderMs: timed(() => game.render()) };
        },
      },
      /** Facts for the developer overlay and `node tools/dev.js play` ("until state.phase === 'aiming'"). */
      debugState: () => ({
        phase: flow.state,
        role: play.role,
        outcome: play.lastOutcome,
        kickTime: play.kick ? play.kick.time : 0,
        waited: play.role === 'taker' ? play.aimSeconds : play.clock,
        pull: liveAim.pull,
        angle: liveAim.angle,
        pressure: play.pressure,
        wind: play.wind,
        score: match ? SIM.statusOf(match.shootout).score : { you: 0, them: 0 },
        kicks: match ? match.shootout.you.length + match.shootout.them.length : 0,
        isSuddenDeath: match ? SIM.statusOf(match.shootout).isSuddenDeath : false,
        rival: match ? match.rival.id : null,
        streak: match ? match.streak : 0,
        coins: progress.wallet.get(),
        rungs: progress.rungsWon(),
        hasSavedCharacter: Boolean(saved),
        seat: stage.seat(),
        framing: { frames: framing.frames, broken: { ...framing.broken }, first: { ...framing.first } },
        ball: play.kick ? { ...play.kick.ball.position } : null,
      }),
    };
    return game;
  };

  Kit.register({
    id: 'penalty',
    name: 'Spot Kick Showdown',
    tagline: 'Drag back to shoot, tap to dive',
    hook: 'Read their keeper, read their taker, climb three cups',
    color: '#ffc445',
    order: 12,
    theme: window.SPOT_KICK_THEME.theme,
    headless: { DATA, SIM, BOTS, progression: BOTS.PROGRESSION },
    create: createGame,
  });
})();
