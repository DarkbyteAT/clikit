/**
 * Spot Kick Showdown rules: one kick from strike to outcome, the minds of a rival keeper and a rival taker, and
 * the shootout around them. No DOM, no THREE: the page and the headless bots run exactly this code, so a save,
 * a parry, a post and a goal mean the same thing everywhere.
 *
 * Owns:  aim -> launch (`launchOf`), the nerves (`swayAt`), a dive as a function of time (`diveOf`, `keeperAt`),
 *        a kick (`createKick`, `stepKick`: flight through `Kit.flight`, the keeper's hands and body, the goal
 *        frame, the line, the net), a rival keeper's decision (`rivalDive`), a rival taker's (`takerIntent`,
 *        `takerAnswer`), aiming at a point (`solveAim`, for takers and bots), the shootout (`createShootout`,
 *        `kickerOf`, `recordKick`, `statusOf`, `pressureOf`) and what a kick pays (`rewardOf`).
 * Does not own: numbers and tables (games/penalty-data.js), ball flight itself (kit/flight.js), bots and the
 *        long arc (games/penalty-bots.js), or anything seen or heard.
 *
 * Time within a kick is seconds since the strike: a dive that starts early has a negative start.
 * Exposed as the global SPOT_KICK_SIM.
 */
(() => {
  const DATA = window.SPOT_KICK_DATA;
  const { FIELD, SHOT, SWAY, PRESSURE, KEEPER, RULES, REWARDS } = DATA;
  const { clamp, lerp } = Kit.math;
  const { goal } = FIELD;

  /** z of the goal line, of the plane the keeper works in, and of the plane a ball must wholly cross to score. */
  const LINE_Z = -FIELD.distance;
  const KEEPER_Z = LINE_Z + FIELD.keeperLine;
  const SCORED_Z = LINE_Z - FIELD.ballRadius;

  /** The goal frame as bars for `Kit.flight`. */
  const FRAME = Object.freeze([
    Kit.flight.bar('post', { x: -goal.halfWidth, y: 0, z: LINE_Z }, { x: -goal.halfWidth, y: goal.height, z: LINE_Z }, goal.postRadius, goal.postBounce),
    Kit.flight.bar('post', { x: goal.halfWidth, y: 0, z: LINE_Z }, { x: goal.halfWidth, y: goal.height, z: LINE_Z }, goal.postRadius, goal.postBounce),
    Kit.flight.bar('bar', { x: -goal.halfWidth, y: goal.height, z: LINE_Z }, { x: goal.halfWidth, y: goal.height, z: LINE_Z }, goal.postRadius, goal.postBounce),
  ]);

  /** What the net does to a ball: it keeps `keep` of the speed along the netting and `bounce` back out of it, and drags. */
  const NET = Object.freeze({ keep: 0.3, bounce: 0.12, drag: 3 });
  /** A kick's outcome stays on show this long before the kick is over, seconds. */
  const AFTER = Object.freeze({ goal: 1.3, save: 0.9, other: 0.8 });
  /** A parried or rebounding ball this far back up the pitch (metres from the keeper's plane) is no longer a threat. */
  const CLEAR_DISTANCE = 1.6;
  /** A knuckling ball's sideways force swings at about this rate, radians per second. */
  const WOBBLE_RATE = 13;

  // ===================================================== aim to launch =====================================================

  /**
   * @typedef {{pull: number, angle: number, curve: number}} Aim `pull` 0..1, `angle` radians (+ to the taker's
   *   right), `curve` -1..1 (+ bends to the taker's right)
   */

  /**
   * Turns an aim into the ball's launch.
   * @param {Aim} aim
   * @param {Object} ballRow a `BallRow` of the data
   * @param {{power?: number, curl?: number}} [boot] the kicker's multipliers (the player's stats; 1 for rivals)
   * @returns {{velocity: Object, spin: Object}} vectors for `Kit.flight.ball`
   * @complexity O(1)
   * @example Kit.flight.ball({ position: SPOT, ...SPOT_KICK_SIM.launchOf({ pull: 0.8, angle: 0.2, curve: 0 }, ball) })
   */
  const launchOf = ({ pull, angle, curve }, ballRow, { power = 1, curl = 1 } = {}) => {
    const speed = lerp(SHOT.speed[0], SHOT.speed[1], pull) * ballRow.power * power * (1 - Math.abs(curve) * SHOT.curlCost);
    const loft = lerp(SHOT.loft[0], SHOT.loft[1], Math.pow(pull, SHOT.loftCurve));
    const yaw = angle * SHOT.yawPerAngle;
    const flat = speed * Math.cos(loft);
    // Spin about +Y bends a ball flying along -Z towards -X, so a curve to the right is a negative spin.
    return { velocity: { x: Math.sin(yaw) * flat, y: speed * Math.sin(loft), z: -Math.cos(yaw) * flat }, spin: { x: 0, y: -curve * SHOT.spin * curl, z: 0 } };
  };

  /**
   * How far the nerves push the aim off at a moment, radians.
   * @param {number} seconds since the aim began
   * @param {number} pressure 0..1
   * @param {number} [swayStat=1] the kicker's sway multiplier
   * @returns {number}
   * @example aim.angle + SPOT_KICK_SIM.swayAt(heldSeconds, pressure, stats.get('sway'))
   */
  const swayAt = (seconds, pressure, swayStat = 1) => SWAY.amplitude * pressure * swayStat * ((1 - SWAY.mix) * Math.sin(seconds * SWAY.rates[0] * Math.PI) + SWAY.mix * Math.sin(seconds * SWAY.rates[1] * Math.PI));

  /** The air a ball of a row flies through, with this kick's crosswind. */
  const airOf = (ballRow, wind = 0) => ({ ...Kit.flight.AIR, drag: Kit.flight.AIR.drag * ballRow.drag, lift: Kit.flight.AIR.lift * ballRow.curl, wind: { x: wind, y: 0, z: 0 } });

  const SPOT = Object.freeze({ x: 0, y: FIELD.ballRadius, z: 0 });
  const ballAtSpot = (launch) => Kit.flight.ball({ position: SPOT, velocity: launch.velocity, spin: launch.spin, radius: FIELD.ballRadius });

  // ======================================================= the keeper =======================================================

  /**
   * @typedef {Object} Dive
   * @property {{x: number, y: number}} target where the hands end, in the keeper's plane (clamped to the keeper's box)
   * @property {number} start seconds since the strike when the keeper commits (negative: before it)
   * @property {number} windup seconds between committing and moving
   * @property {number} duration seconds the hands take to arrive once moving
   */

  /**
   * Plans a dive from the stance to a point.
   * @param {{x: number, y: number}} target in the keeper's plane
   * @param {number} start seconds since the strike
   * @param {{diveSpeed: number, windup?: number}} keeper
   * @returns {Dive}
   * @example const dive = SPOT_KICK_SIM.diveOf({ x: -1.8, y: 0.6 }, -0.1, { diveSpeed: 5.6, windup: 0.07 });
   */
  const diveOf = (target, start, { diveSpeed, windup = 0.07 }) => {
    const clamped = { x: clamp(target.x, -KEEPER.box.halfWidth, KEEPER.box.halfWidth), y: clamp(target.y, KEEPER.box.low, KEEPER.box.high) };
    const distance = Math.hypot(clamped.x - KEEPER.hands.x, clamped.y - KEEPER.hands.y);
    return { target: clamped, start, windup, duration: Math.max(0.1, distance / diveSpeed) };
  };

  /**
   * Where a keeper is at a moment: the hands, the hips that trail them, how far through the dive, and the
   * hands' velocity. With no dive the keeper stands in the stance.
   * @param {?Dive} dive
   * @param {number} time seconds since the strike
   * @returns {{hands: {x: number, y: number}, hips: {x: number, y: number}, share: number, velocity: {x: number, y: number}}}
   * @complexity O(1)
   */
  const keeperAt = (dive, time) => {
    const stance = KEEPER.hands;
    if (!dive) return { hands: { ...stance }, hips: { x: stance.x, y: KEEPER.box.low }, share: 0, velocity: { x: 0, y: 0 } };
    const share = clamp((time - dive.start - dive.windup) / dive.duration);
    const eased = KEEPER.ease(share);
    const hands = { x: lerp(stance.x, dive.target.x, eased), y: lerp(stance.y, dive.target.y, eased) };
    // Derivative of the ease-out: fastest at take-off, zero on arrival.
    const rate = share > 0 && share < 1 ? (2 * (1 - share)) / dive.duration : 0;
    // The body lays out behind the hands: the hips cover part of the way across and rise towards a high ball.
    const hips = { x: lerp(stance.x, hands.x, KEEPER.body.share), y: lerp(KEEPER.box.low, Math.max(KEEPER.box.low, hands.y - 0.35), eased * KEEPER.body.share * 2) };
    return { hands, hips, share, velocity: { x: (dive.target.x - stance.x) * rate, y: (dive.target.y - stance.y) * rate } };
  };

  // ========================================================= a kick =========================================================

  /**
   * @typedef {Object} Kick
   * @property {Object} ball the `FlightBall`
   * @property {number} time seconds since the strike
   * @property {?Dive} dive the keeper's dive, if one has been committed to
   * @property {{reach: number, holdSpeed: number}} keeper the keeper's hands
   * @property {?('goal'|'save'|'parry'|'post'|'miss')} outcome null while the kick is live
   * @property {boolean} isOver the outcome has been on show long enough
   * @property {{keeper: boolean, wood: boolean, held: boolean, net: boolean}} touched what the ball has met
   * @property {?{x: number, y: number}} crossed where the ball crossed the keeper's plane (for scouting and bonuses)
   */

  /**
   * Starts a kick at the moment of the strike.
   * @param {{launch: {velocity: Object, spin: Object}, ballRow: Object, keeper: {reach: number, holdSpeed: number},
   *   dive?: ?Dive, wind?: number, wobblePhase?: number}} spec `wobblePhase`: radians, any number (a seed for a knuckling ball)
   * @returns {Kick}
   */
  const createKick = ({ launch, ballRow, keeper, dive = null, wind = 0, wobblePhase = 0 }) => ({
    ball: ballAtSpot(launch),
    time: 0,
    dive,
    keeper,
    outcome: null,
    isOver: false,
    touched: { keeper: false, wood: false, held: false, net: false },
    crossed: null,
    world: { air: airOf(ballRow, wind), bars: FRAME },
    wobble: ballRow.wobble,
    wobblePhase,
    outcomeAt: 0,
  });

  /** Is a point of the goal line's plane inside the goal mouth? */
  const isInMouth = (point) => Math.abs(point.x) < goal.halfWidth && point.y < goal.height;

  /** Turns the ball off a round thing at `centre` moving at `push`; returns the speed it came in at (0: not approaching). */
  const deflect = (ball, centre, bounce, push) => {
    const { position, velocity } = ball;
    const offset = { x: position.x - centre.x, y: position.y - centre.y, z: position.z - centre.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z) || 1;
    const normal = { x: offset.x / distance, y: offset.y / distance, z: offset.z / distance };
    const speedIn = -(velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z);
    if (speedIn <= 0) return 0;
    const turn = speedIn * (1 + bounce);
    velocity.x += normal.x * turn + push.x * KEEPER.parryPush;
    velocity.y += normal.y * turn + push.y * KEEPER.parryPush;
    velocity.z += normal.z * turn;
    return speedIn;
  };

  /** The keeper against the ball for one step: held, parried by the hands, blocked by the body, or nothing. */
  const meetKeeper = (kick, events) => {
    const { ball, keeper } = kick;
    const pose = keeperAt(kick.dive, kick.time);
    const hands = { x: pose.hands.x, y: pose.hands.y, z: KEEPER_Z };
    const fromHands = Math.hypot(ball.position.x - hands.x, ball.position.y - hands.y, ball.position.z - hands.z);
    if (fromHands < keeper.reach + ball.radius) {
      const speed = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z);
      // Clean means the ball is coming into the palms: how far off the hands' centre it is across the goal, not
      // how deep it has got (it meets the edge of the reach first whichever way it comes).
      const offCentre = Math.hypot(ball.position.x - hands.x, ball.position.y - hands.y);
      if (offCentre < keeper.reach * KEEPER.cleanShare && speed < keeper.holdSpeed && ball.velocity.z < 0) {
        kick.touched.keeper = kick.touched.held = true;
        events.push({ type: 'held', speed, point: { ...ball.position } });
        return;
      }
      const speedIn = deflect(ball, hands, KEEPER.parryBounce, pose.velocity);
      if (speedIn > 0) {
        kick.touched.keeper = true;
        events.push({ type: 'parry', speed: speedIn, point: { ...ball.position } });
      }
      return;
    }
    // The body: a capsule from the hips to the hands. The nearest point of its axis stands in for a ball there.
    const axis = { x: pose.hands.x - pose.hips.x, y: pose.hands.y - pose.hips.y };
    const along = clamp(((ball.position.x - pose.hips.x) * axis.x + (ball.position.y - pose.hips.y) * axis.y) / (axis.x * axis.x + axis.y * axis.y || 1));
    const nearest = { x: pose.hips.x + axis.x * along, y: pose.hips.y + axis.y * along, z: KEEPER_Z };
    if (Math.hypot(ball.position.x - nearest.x, ball.position.y - nearest.y, ball.position.z - nearest.z) >= KEEPER.body.radius + ball.radius) return;
    const speedIn = deflect(ball, nearest, KEEPER.parryBounce, { x: 0, y: 0 });
    if (speedIn > 0) {
      kick.touched.keeper = true;
      events.push({ type: 'block', speed: speedIn, point: { ...ball.position } });
    }
  };

  /** Keeps a scored ball inside the net: the back, the sides and the roof each stop it and swallow its speed. */
  const holdInNet = (kick, dt, events) => {
    const { position, velocity, radius } = kick.ball;
    const walls = [
      ['z', LINE_Z - goal.depth + radius, 1],
      ['x', -goal.halfWidth + radius, 1],
      ['x', goal.halfWidth - radius, -1],
      ['y', goal.height - radius, -1],
    ];
    walls.forEach(([axis, limit, inward]) => {
      if ((position[axis] - limit) * inward >= 0) return;
      position[axis] = limit;
      if (!kick.touched.net) events.push({ type: 'net', speed: Math.hypot(velocity.x, velocity.y, velocity.z), point: { ...position } });
      kick.touched.net = true;
      ['x', 'y', 'z'].forEach((each) => (velocity[each] *= each === axis ? -NET.bounce : NET.keep));
    });
    if (!kick.touched.net) return;
    const kept = Math.max(0, 1 - NET.drag * dt);
    velocity.x *= kept;
    velocity.z *= kept;
  };

  /** What a kick that never scored and was never held was: named for the last thing that stopped it. */
  const failedOutcome = (kick) => (kick.touched.keeper ? 'parry' : kick.touched.wood ? 'post' : 'miss');

  const decide = (kick, outcome, events) => {
    kick.outcome = outcome;
    kick.outcomeAt = kick.time;
    events.push({ type: 'outcome', outcome });
  };

  /**
   * Advances a kick by one step and reports what happened in it.
   * @param {Kick} kick changed in place
   * @param {number} dt seconds (use `SPOT_KICK_DATA.STEP`)
   * @returns {Array<{type: string, speed?: number, point?: Object, outcome?: string}>} events of this step, in order:
   *   'ground', 'post', 'bar', 'parry', 'block', 'held', 'crossed', 'net', and 'outcome' once
   * @complexity O(substeps of Kit.flight.step); allocates the before-position and any events
   * @example
   * while (!kick.isOver) SPOT_KICK_SIM.stepKick(kick, SPOT_KICK_DATA.STEP).forEach(react);
   * kick.outcome // 'goal' | 'save' | 'parry' | 'post' | 'miss'
   */
  const stepKick = (kick, dt) => {
    const events = [];
    if (kick.isOver) return events;
    const { ball } = kick;
    kick.time += dt;
    if (kick.touched.held) {
      // A held ball goes where the hands go.
      const pose = keeperAt(kick.dive, kick.time);
      Object.assign(ball.position, { x: pose.hands.x, y: pose.hands.y, z: KEEPER_Z + ball.radius });
      Object.assign(ball.velocity, { x: 0, y: 0, z: 0 });
      if (!kick.outcome) decide(kick, 'save', events);
    } else {
      const before = { ...ball.position };
      if (kick.wobble && !kick.touched.keeper && !kick.outcome) ball.velocity.x += kick.wobble * Math.sin(kick.wobblePhase + kick.time * WOBBLE_RATE) * dt;
      Kit.flight.step(ball, dt, kick.world).forEach((hit) => {
        if (hit.kind === 'bar') kick.touched.wood = true;
        events.push({ type: hit.kind === 'bar' ? hit.id : 'ground', speed: hit.speed, point: hit.point });
      });
      if (kick.outcome !== 'goal') meetKeeper(kick, events);
      if (!kick.crossed) {
        const atKeeper = Kit.flight.crossing(before, ball.position, 'z', KEEPER_Z);
        if (atKeeper) {
          kick.crossed = { x: atKeeper.x, y: atKeeper.y };
          events.push({ type: 'crossed', point: atKeeper });
        }
      }
      const over = !kick.outcome && before.z > SCORED_Z ? Kit.flight.crossing(before, ball.position, 'z', SCORED_Z) : null;
      if (over) decide(kick, isInMouth(over) && !kick.touched.held ? 'goal' : failedOutcome(kick), events);
      if (kick.outcome === 'goal') holdInNet(kick, dt, events);
    }
    if (!kick.outcome) {
      const isCleared = kick.touched.keeper || kick.touched.wood ? ball.velocity.z > 0 && ball.position.z > KEEPER_Z + CLEAR_DISTANCE : false;
      const isGone = Math.abs(ball.position.x) > FIELD.out.side || ball.position.y > FIELD.out.height || ball.position.z < LINE_Z - FIELD.out.behind;
      if (isCleared || isGone || ball.isResting || kick.time > FIELD.mostSeconds) decide(kick, failedOutcome(kick), events);
    }
    if (kick.outcome) kick.isOver = kick.time - kick.outcomeAt >= (AFTER[kick.outcome] || AFTER.other) || kick.time > FIELD.mostSeconds + AFTER.goal;
    return events;
  };

  /**
   * Flies a kick to its end at the fixed step.
   * @param {Kick} kick changed in place
   * @param {function(Kick): void} [eachStep] called before every step (a bot's late tap: `kick.dive = ...`)
   * @returns {Kick} the same kick, over
   * @complexity O(seconds / STEP) steps, a few hundred
   */
  const playKick = (kick, eachStep) => {
    while (!kick.isOver) {
      if (eachStep) eachStep(kick);
      stepKick(kick, DATA.STEP);
    }
    return kick;
  };

  // ===================================================== aiming at a point =====================================================

  /** Where a launch crosses the keeper's plane with nothing in its way, or null when it never gets there. */
  const crossingOf = (launch, ballRow, wind = 0) => {
    const path = Kit.flight.trace(ballAtSpot(launch), { air: airOf(ballRow, wind), step: 1 / 60, maxSteps: 150, stopWhen: (now) => now.position.z <= KEEPER_Z });
    const { end } = path;
    if (end.position.z > KEEPER_Z) return null;
    const before = path.points.length > 1 ? path.points[path.points.length - 2] : SPOT;
    return { ...Kit.flight.crossing(before, end.position, 'z', KEEPER_Z), seconds: end.seconds };
  };

  const SOLVE = Object.freeze({ passes: 4, probe: 0.05 });

  /**
   * The aim angle that sends a shot of a given pull and curve across the keeper's plane at `targetX` (takers and
   * bots aim with this; the player aims by hand). Solved by a few secant passes over the real flight.
   * @param {number} targetX metres
   * @param {{pull: number, curve?: number}} shot
   * @param {Object} ballRow
   * @param {{power?: number, curl?: number}} [boot]
   * @param {number} [wind=0] the crosswind the kicker allows for, metres per second
   * @returns {Aim}
   * @complexity O(passes x trace)
   * @example const aim = SPOT_KICK_SIM.solveAim(-1.9, { pull: 0.8, curve: 0.6 }, ball);
   */
  const solveAim = (targetX, { pull, curve = 0 }, ballRow, boot, wind = 0) => {
    const missAt = (angle) => {
      const crossed = crossingOf(launchOf({ pull, angle, curve }, ballRow, boot), ballRow, wind);
      // A shot too weak to arrive is judged by its straight line, so the solver still has a slope to follow.
      return (crossed ? crossed.x : Math.tan(angle * SHOT.yawPerAngle) * (FIELD.distance - FIELD.keeperLine)) - targetX;
    };
    let angle = Math.atan2(targetX, FIELD.distance - FIELD.keeperLine) / SHOT.yawPerAngle;
    let miss = missAt(angle);
    for (let pass = 0; pass < SOLVE.passes; pass++) {
      const probed = missAt(angle + SOLVE.probe);
      const slope = (probed - miss) / SOLVE.probe;
      if (Math.abs(slope) < 1e-6) break;
      angle -= miss / slope;
      miss = missAt(angle);
    }
    return { pull, angle, curve };
  };

  // ==================================================== a rival keeper's mind ====================================================

  /** Where a gambling keeper throws themselves: how far across, and the heights they choose between. */
  const GAMBLE = Object.freeze({ across: [1.5, 2.2], heights: [0.45, 1.05, 1.6], sideWeight: 0.8 });

  /**
   * A rival keeper's dive for a shot, decided at the strike. A gamble picks a side from habit and from where
   * the player has shot this match, and goes at once. A read watches the ball for the keeper's reaction time,
   * then goes where its line then points: straight on, as if it had no spin, which is how a bent shot beats it.
   * @param {Object} traits a `KeeperTraits`
   * @param {{launch: Object, ballRow: Object, wind?: number, history?: number[]}} shot `history`: the x of the
   *   player's earlier shots this match (where they crossed the keeper's plane)
   * @param {Object} rng a `Kit.rng`
   * @returns {Dive & {kind: ('gamble'|'read')}}
   * @complexity O(reaction / step) for a read
   */
  const rivalDive = (traits, { launch, ballRow, wind = 0, history = [] }, rng) => {
    if (rng.chance(traits.guess)) {
      const rightShare = history.length ? history.filter((x) => x > 0).length / history.length : 0.5;
      const lean = clamp(traits.bias * GAMBLE.sideWeight + traits.adapt * (rightShare - 0.5) * 2 * GAMBLE.sideWeight, -1, 1);
      const side = rng.chance(0.5 + 0.5 * lean) ? 1 : -1;
      return { ...diveOf({ x: side * rng.range(...GAMBLE.across), y: rng.pick(GAMBLE.heights) }, 0, traits), kind: 'gamble' };
    }
    const seen = Kit.flight.trace(ballAtSpot(launch), { air: airOf(ballRow, wind), step: 1 / 60, maxSteps: Math.max(1, Math.round(traits.reaction * 60)) }).end;
    // From what has been seen, the ball is carried on without spin or wind: gravity and drag only.
    const guessed = Kit.flight.trace({ ...seen, spin: { x: 0, y: 0, z: 0 } }, { air: airOf({ ...ballRow, curl: 0 }), step: 1 / 60, maxSteps: 150, stopWhen: (now) => now.position.z <= KEEPER_Z }).end;
    const target = { x: guessed.position.x + rng.range(-traits.readNoise, traits.readNoise), y: guessed.position.y + rng.range(-traits.readNoise, traits.readNoise) };
    return { ...diveOf(target, traits.reaction, traits), kind: 'read' };
  };

  // ==================================================== a rival taker's mind ====================================================

  /** Where takers aim: how far across for a corner, how often down the middle, and how nerves widen the spray. */
  const TAKER = Object.freeze({ across: [1.35, 2.2], middleChance: 0.08, middle: 0.5, highPull: 0.78, pressureSpray: 1.5, pullSprayShare: 0.5, curlAmount: [0.5, 1] });

  /** A bell-shaped random number around 0 with about unit spread, from three uniform draws. */
  const bell = (rng) => rng.range(-1, 1) + rng.range(-1, 1) + rng.range(-1, 1);

  /**
   * @typedef {Object} TakerIntent
   * @property {number} targetX where they mean to put it (metres across the keeper's plane)
   * @property {number} pull the power they mean to use (which sets the height)
   * @property {number} curve -1..1
   * @property {number} tell -1, 0 or 1: the side their run-up points to (the truth, or a lie)
   */

  /**
   * What a rival taker means to do with a kick, decided as the run-up begins.
   * @param {Object} traits a `TakerTraits`
   * @param {Object} rng a `Kit.rng`
   * @returns {TakerIntent}
   */
  const takerIntent = (traits, rng) => {
    const isMiddle = rng.chance(TAKER.middleChance);
    const side = rng.chance(0.5 + 0.5 * traits.side) ? 1 : -1;
    const targetX = isMiddle ? rng.range(-TAKER.middle, TAKER.middle) : side * rng.range(...TAKER.across);
    const [least, most] = traits.pull;
    // Going high means pulling harder: the top of their range when it reaches, else as hard as they dare.
    const pull = rng.chance(traits.high) ? rng.range(Math.max(least, Math.min(TAKER.highPull, most - 0.03)), most) : rng.range(least, Math.min(most, TAKER.highPull));
    // A bent shot starts inside and swings out to the corner, so the curve goes the way of the target.
    const curve = rng.chance(traits.curl) ? Math.sign(targetX || 1) * rng.range(...TAKER.curlAmount) * traits.curl : 0;
    const truth = Math.sign(targetX);
    return { targetX, pull, curve, tell: rng.chance(traits.honesty) ? truth : -truth || side };
  };

  /**
   * The taker's answer to a keeper who has already committed: one who moved before the taker's window closed,
   * facing a taker who looks up, sees the ball go the other way.
   * @param {TakerIntent} intent
   * @param {Object} traits a `TakerTraits`
   * @param {?Dive} dive the keeper's dive, if committed before the strike
   * @param {Object} rng
   * @returns {TakerIntent} the same intent, or one mirrored away from the dive
   */
  const takerAnswer = (intent, traits, dive, rng) => {
    const wasSeen = dive && dive.start < -traits.switchWindow && Math.sign(dive.target.x) === Math.sign(intent.targetX);
    if (!wasSeen || !rng.chance(traits.eyesUp)) return intent;
    return { ...intent, targetX: -intent.targetX, curve: -intent.curve };
  };

  /**
   * The aim a taker actually strikes: the intent solved for the ball, plus the spray of their accuracy and nerve.
   * @param {TakerIntent} intent
   * @param {Object} traits
   * @param {Object} ballRow
   * @param {number} pressure 0..1
   * @param {Object} rng
   * @returns {Aim}
   */
  const takerAim = (intent, traits, ballRow, pressure, rng) => {
    const spray = traits.spray * (1 + pressure * (1 - traits.nerve) * TAKER.pressureSpray);
    const pull = clamp(intent.pull + bell(rng) * spray * TAKER.pullSprayShare);
    const aim = solveAim(intent.targetX, { pull, curve: intent.curve }, ballRow);
    return { ...aim, angle: aim.angle + bell(rng) * spray };
  };

  // ======================================================= the shootout =======================================================

  /** @typedef {{first: ('you'|'them'), you: boolean[], them: boolean[]}} Shootout each side's kicks so far: true for a goal */

  const OTHER = Object.freeze({ you: 'them', them: 'you' });
  const goalsOf = (kicks) => kicks.filter(Boolean).length;

  /**
   * @param {('you'|'them')} [first='you'] who kicks first
   * @returns {Shootout}
   */
  const createShootout = (first = 'you') => ({ first, you: [], them: [] });

  /** Whose kick is next. */
  const kickerOf = (shootout) => ((shootout.you.length + shootout.them.length) % 2 === 0 ? shootout.first : OTHER[shootout.first]);

  /** A new shootout with the next kick recorded. */
  const recordKick = (shootout, didScore) => {
    const side = kickerOf(shootout);
    return { ...shootout, [side]: [...shootout[side], didScore] };
  };

  /**
   * Where a shootout stands.
   * @param {Shootout} shootout
   * @returns {{winner: ?('you'|'them'), isSuddenDeath: boolean, score: {you: number, them: number}, round: number}}
   *   `round` counts from 1; sudden death begins once both have taken `RULES.kicks`
   * @example SPOT_KICK_SIM.statusOf({ first: 'you', you: [true, true, true], them: [false, false, false] }).winner // 'you'
   */
  const statusOf = (shootout) => {
    const score = { you: goalsOf(shootout.you), them: goalsOf(shootout.them) };
    const left = { you: Math.max(0, RULES.kicks - shootout.you.length), them: Math.max(0, RULES.kicks - shootout.them.length) };
    const isLevelOnKicks = shootout.you.length === shootout.them.length;
    const isSuddenDeath = shootout.you.length >= RULES.kicks && shootout.them.length >= RULES.kicks;
    // In the five, a side has won once the other cannot catch it; in sudden death, once a pair of kicks splits them.
    const leader = score.you > score.them ? 'you' : score.them > score.you ? 'them' : null;
    const isSettled = leader && (isSuddenDeath ? isLevelOnKicks : score[leader] > score[OTHER[leader]] + left[OTHER[leader]]);
    return { winner: isSettled ? leader : null, isSuddenDeath, score, round: Math.min(shootout.you.length, shootout.them.length) + 1 };
  };

  /**
   * How much the next kick weighs on its kicker, 0..1: it would win the shootout, or a miss would lose it,
   * plus sudden death, plus the ground.
   * @param {Shootout} shootout
   * @param {number} [ground=0] the cup's own pressure
   * @returns {number}
   */
  const pressureOf = (shootout, ground = 0) => {
    const side = kickerOf(shootout);
    const ifScored = statusOf(recordKick(shootout, true)).winner === side;
    const ifMissed = statusOf(recordKick(shootout, false)).winner === OTHER[side];
    return clamp(ground + (ifMissed ? PRESSURE.toSurvive : ifScored ? PRESSURE.toWin : 0) + (statusOf(shootout).isSuddenDeath ? PRESSURE.suddenDeath : 0));
  };

  /**
   * Coins the player earns for a kick.
   * @param {Kick} kick a finished kick
   * @param {('taker'|'keeper')} role the player's role in it
   * @param {number} streak the player's successes in a row before this kick
   * @returns {{coins: number, isSuccess: boolean, isCorner: boolean}}
   */
  const rewardOf = (kick, role, streak) => {
    const isSuccess = role === 'taker' ? kick.outcome === 'goal' : kick.outcome !== 'goal';
    if (!isSuccess) return { coins: 0, isSuccess, isCorner: false };
    const isCorner = role === 'taker' && Boolean(kick.crossed) && goal.halfWidth - Math.abs(kick.crossed.x) < REWARDS.cornerReach && goal.height - kick.crossed.y < REWARDS.cornerReach;
    const base = role === 'taker' ? REWARDS.goal + (isCorner ? REWARDS.corner : 0) : kick.touched.keeper ? REWARDS.save + (kick.touched.held ? REWARDS.held : 0) : 0;
    return { coins: Math.round(base * (1 + Math.min(streak, REWARDS.mostStreak) * REWARDS.perStreak)), isSuccess, isCorner };
  };

  window.SPOT_KICK_SIM = {
    LINE_Z, KEEPER_Z, SPOT, FRAME, launchOf, swayAt, airOf, diveOf, keeperAt, createKick, stepKick, playKick, crossingOf, solveAim,
    rivalDive, takerIntent, takerAnswer, takerAim, createShootout, kickerOf, recordKick, statusOf, pressureOf, rewardOf,
  };
})();
