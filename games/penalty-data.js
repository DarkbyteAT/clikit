/**
 * Spot Kick Showdown data: every tunable, table and progression rule of the game. No DOM, no THREE: it runs in
 * node (tools/sim.js and tools/test-kit.js read it).
 *
 * Owns:  the pitch and goal geometry, how a slingshot aim becomes a launch, the keeper's and the taker's base
 *        numbers, balls, perks, kits, cups with their grounds and rivals, the endless road's rival generator,
 *        the scouting sentences, rewards and prices, and the player's long arc (`createProgress`).
 * Does not own: the rules of a kick or a shootout (games/penalty-sim.js), bots and the headless arc
 *        (games/penalty-bots.js), performances (games/penalty-perform.js) or anything seen or heard.
 *
 * Conventions: metres, seconds, radians. The penalty spot is the origin, the goal line is at z = -FIELD.distance,
 * +X is the taker's right (so the keeper's left as the keeper faces the taker), +Y is up.
 * Exposed as the global SPOT_KICK_DATA.
 */
(() => {
  const { clamp, lerp } = Kit.math;

  // =================================================== the field ===================================================

  /**
   * A small-sided goal and a short spot: a phone held upright shows the whole goal mouth and still leaves the
   * characters large enough to read. `keeperLine` is how far in front of the goal line the keeper stands.
   */
  const FIELD = Object.freeze({
    distance: 8,
    goal: Object.freeze({ halfWidth: 2.5, height: 2.1, postRadius: 0.06, depth: 1.3, postBounce: 0.55 }),
    keeperLine: 0.5,
    ballRadius: 0.11,
    /** A kick is over this long after the ball is struck, whatever it is doing. */
    mostSeconds: 3.2,
    /** Beyond these the ball has left the picture: wide, or behind the stand. */
    out: Object.freeze({ side: 7, behind: 4, height: 9 }),
  });

  /** The simulation's fixed step, seconds. */
  const STEP = 1 / 120;

  // ================================================ shooting and saving ================================================

  /**
   * Aim to launch. Pull sets speed and loft together, so the hardest shots are also the highest: full power
   * clears the bar, and the top corners sit in a narrow band just under it. `[at no pull, at full pull]`.
   */
  const SHOT = Object.freeze({
    speed: Object.freeze([9, 19.5]),
    loft: Object.freeze([0, 0.405]),
    /** Above 1 the loft rises slowly at first and steeply near full pull. */
    loftCurve: 1.1,
    /** Launch yaw per radian of aim angle. */
    yawPerAngle: 0.78,
    /** Spin (radians per second about the vertical) of a full flick. */
    spin: 95,
    /** A curled shot is struck across the ball and loses this share of its speed at full curl. */
    curlCost: 0.08,
  });

  /**
   * The nerves of a decisive kick: the aim sways like a held breath, more as the kick matters more. The sway is
   * two sines (so it never quite repeats) on the aim angle; `amplitude` is radians at pressure 1.
   */
  const SWAY = Object.freeze({ amplitude: 0.11, rates: Object.freeze([2.1, 3.4]), mix: 0.35 });

  /** How much each situation weighs on the kicker, 0..1 in sum (clamped). */
  const PRESSURE = Object.freeze({ toWin: 0.45, toSurvive: 0.75, suddenDeath: 0.2, perStreakAgainst: 0.08 });

  /** The player's own numbers before perks (Kit.stats base). Speeds in m/s, radii in metres, times in seconds. */
  const PLAYER_STATS = Object.freeze({
    shotPower: 1, // multiplies launch speed
    shotCurl: 1, // multiplies spin
    sway: 1, // multiplies the nerves
    preview: 0.55, // share of the flight the aim preview shows
    diveSpeed: 6.6,
    reach: 0.46, // how far from the hands' centre a ball is still touched
    holdSpeed: 17, // a ball slower than this, met near the middle of the hands, is held
    windup: 0.06, // from the tap to leaving the ground
    tellHint: 0, // 1: the taker's tell is drawn as an arrow
    coinShare: 1,
  });

  /** A keeper at rest: where the hands are, where a dive may end, and how contact is judged. */
  const KEEPER = Object.freeze({
    hands: Object.freeze({ x: 0, y: 1.0 }),
    /** Dives end inside this box (hands' centre): a keeper cannot reach past the post by much or under the turf. */
    box: Object.freeze({ halfWidth: 2.55, low: 0.18, high: 2.05 }),
    /** The body trails the hands: a ball that meets it is blocked. Share of the way from stance to hands, and its radius. */
    body: Object.freeze({ share: 0.45, radius: 0.24 }),
    /** A ball within this share of the reach from the hands' centre is met cleanly (held if slow enough). */
    cleanShare: 0.6,
    /** A parry keeps this share of the ball's speed and adds the hands' own push. */
    parryBounce: 0.32,
    /** Share of the dive's speed the hands add to a parried ball. */
    parryPush: 0.6,
    /** Easing of a dive: most of the distance is covered early, as a jump is. */
    ease: (share) => 1 - (1 - share) * (1 - share),
  });

  /** The run-up of a kick, shared by both roles so the rhythm is learnable. Seconds before the strike. */
  const RUN_UP = Object.freeze({ seconds: 1.5, tellAt: 0.55, startDistance: 3.2 });

  // ====================================================== balls ======================================================

  /**
   * @typedef {Object} BallRow
   * @property {string} id
   * @property {string} name
   * @property {string} blurb what it does, in the player's words
   * @property {number} cost coins (0: owned from the start)
   * @property {number} power multiplies launch speed
   * @property {number} curl multiplies spin lift
   * @property {number} drag multiplies air drag (and so how much wind moves it)
   * @property {number} wobble metres per second squared of unsteady sideways force (a knuckling ball)
   * @property {number[]} colors [panel, patch] 0xRRGGBB
   */

  /** Both sides kick the ball you bring, so each one helps and hurts: a fast ball is harder for you to save too. */
  const BALLS = Kit.table([
    { id: 'classic', name: 'Match Ball', blurb: 'Honest. Goes where you send it.', cost: 0, power: 1, curl: 1, drag: 1, wobble: 0, colors: [0xf4f1e8, 0x2b2f3a] },
    { id: 'feather', name: 'Featherlight', blurb: 'Curls like a kite and hangs in the air. So do their shots, and the wind loves it.', cost: 180, power: 0.9, curl: 1.75, drag: 1.7, wobble: 0, colors: [0xfff2a8, 0xe8663c] },
    { id: 'cannon', name: 'Cannonball', blurb: 'Leaves the boot like a brick: fast, straight, hard to hold. Theirs too.', cost: 320, power: 1.12, curl: 0.4, drag: 0.8, wobble: 0, colors: [0x39404f, 0xd8dde8] },
    { id: 'wobbler', name: 'Wobbler', blurb: 'Dances in flight. Nobody, you included, knows quite where it ends.', cost: 460, power: 1.02, curl: 0.55, drag: 1, wobble: 16, colors: [0x7be0d2, 0x7a3fd0] },
  ]);

  // ====================================================== perks ======================================================

  /**
   * @typedef {Object} PerkRow
   * @property {string} id
   * @property {('taker'|'keeper')} role which slot it fills (one perk per role)
   * @property {string} name
   * @property {string} blurb gain and price, in the player's words
   * @property {number} cost coins
   * @property {Object} mods a `Kit.stats` mod spec over PLAYER_STATS
   */

  /** Abilities. Each buys one strength with one weakness, so the right one depends on the rival in front of you. */
  const PERKS = Kit.table([
    { id: 'iceVeins', role: 'taker', name: 'Ice Veins', blurb: 'Your aim barely sways under pressure. A little power is the price of calm.', cost: 150, mods: { sway: { mul: 0.35 }, shotPower: { mul: 0.95 } } },
    { id: 'rocket', role: 'taker', name: 'Rocket Boot', blurb: 'One tenth more pace. The nerves shake harder with it.', cost: 240, mods: { shotPower: { mul: 1.1 }, sway: { mul: 1.4 } } },
    { id: 'bender', role: 'taker', name: 'Bender', blurb: 'Flicks bite much harder. Straight shots lose a little zip.', cost: 300, mods: { shotCurl: { mul: 1.6 }, shotPower: { mul: 0.96 } } },
    { id: 'longLook', role: 'taker', name: 'Long Look', blurb: 'The aim line runs all the way to the goal. Staring that long, your nerves show.', cost: 200, mods: { preview: { add: 0.45 }, sway: { mul: 1.2 } } },
    { id: 'catReflex', role: 'keeper', name: 'Cat Reflexes', blurb: 'You fly across the goal. Smaller gloves, though.', cost: 150, mods: { diveSpeed: { mul: 1.18 }, reach: { mul: 0.9 } } },
    { id: 'longArms', role: 'keeper', name: 'Long Arms', blurb: 'A quarter more reach, a slower spring.', cost: 240, mods: { reach: { mul: 1.25 }, diveSpeed: { mul: 0.92 } } },
    { id: 'stickyGloves', role: 'keeper', name: 'Sticky Gloves', blurb: 'Hold shots others can only parry. You set yourself a beat longer.', cost: 200, mods: { holdSpeed: { mul: 1.5 }, windup: { add: 0.035 } } },
    { id: 'eyeReader', role: 'keeper', name: 'Eye Reader', blurb: 'An arrow shows where the taker is looking. Liars still lie, and study costs spring.', cost: 300, mods: { tellHint: { add: 1 }, diveSpeed: { mul: 0.95 } } },
  ]);

  // ======================================================= kits =======================================================

  /** Index of each dye in the wardrobe catalogue's `dyes` palette (kit/body-wardrobe.js), by name. */
  const DYE = Object.freeze({ navy: 0, crimson: 1, forest: 2, mustard: 3, plum: 4, teal: 5, rust: 6, charcoal: 7, cream: 8, sky: 9, olive: 10, coral: 11 });

  /**
   * @typedef {Object} KitRow
   * @property {string} id
   * @property {string} name
   * @property {number} cost coins (0: owned from the start)
   * @property {?number} shirt dye index, or null for "wear what the character came in"
   * @property {?number} shorts dye index
   * @property {number} keeper dye index of the keeper's long-sleeved top
   */

  /** Strips for the player's side. `own` keeps a Character Maker character exactly as it was made. */
  const KITS = Kit.table([
    { id: 'own', name: 'Own Clothes', cost: 0, shirt: null, shorts: null, keeper: DYE.mustard },
    { id: 'home', name: 'Home Teal', cost: 0, shirt: DYE.teal, shorts: DYE.cream, keeper: DYE.mustard },
    { id: 'coral', name: 'Away Coral', cost: 120, shirt: DYE.coral, shorts: DYE.navy, keeper: DYE.forest },
    { id: 'night', name: 'Night Plum', cost: 220, shirt: DYE.plum, shorts: DYE.charcoal, keeper: DYE.sky },
    { id: 'sun', name: 'Sunday Mustard', cost: 340, shirt: DYE.mustard, shorts: DYE.forest, keeper: DYE.crimson },
    { id: 'sky', name: 'Skyline', cost: 520, shirt: DYE.sky, shorts: DYE.navy, keeper: DYE.rust },
    { id: 'ink', name: 'Ink and Cream', cost: 760, shirt: DYE.charcoal, shorts: DYE.cream, keeper: DYE.coral },
    { id: 'grove', name: 'Olive Grove', cost: 1100, shirt: DYE.olive, shorts: DYE.cream, keeper: DYE.plum },
  ]);

  /**
   * Medals: lifetime milestones that pay coins, so a player stuck on one rival still earns something new.
   * @type {ReadonlyArray<{stat: string, name: string, steps: number[], coins: number}>} `steps`: the counts of the
   *   profile stat that earn the medal's next grade; `coins`: paid per grade, times the grade
   */
  const MEDALS = Object.freeze([
    { stat: 'goals', name: 'Marksman', steps: [5, 15, 30, 50, 80, 120, 170, 230, 300, 400], coins: 20 },
    { stat: 'saves', name: 'Safe Hands', steps: [3, 10, 20, 35, 55, 80, 110, 150, 200, 260], coins: 20 },
    { stat: 'matches', name: 'Regular', steps: [3, 8, 15, 25, 40, 60, 85, 115, 150], coins: 15 },
  ]);
  /** The grade of a medal for a count: how many of its steps have been reached. */
  const medalGrade = (medal, count) => medal.steps.filter((step) => count >= step).length;

  // ================================================= cups, grounds, rivals =================================================

  /**
   * @typedef {Object} KeeperTraits How a rival keeper plays when the player shoots.
   * @property {number} reaction seconds after the strike before a read keeper moves
   * @property {number} diveSpeed metres per second
   * @property {number} reach metres
   * @property {number} holdSpeed m/s: slower balls met cleanly are held
   * @property {number} guess 0..1: how often they gamble on a side at the strike instead of reading the ball
   * @property {number} bias -1..1: which side a gamble favours (+ is the taker's right)
   * @property {number} adapt 0..1: how far a gamble follows where the player has been shooting this match
   * @property {number} readNoise metres of error in a read
   */

  /**
   * @typedef {Object} TakerTraits How a rival taker shoots when the player keeps.
   * @property {number} side -1..1: which side they favour (+ is the taker's right, the keeper's left)
   * @property {number} high 0..1: how often they go high
   * @property {number[]} pull [least, most] power, 0..1
   * @property {number} curl 0..1: how often and how hard they bend it
   * @property {number} spray radians of aim error (doubled by full pressure when `nerve` is 0)
   * @property {number} nerve 0..1: how well they keep their aim under pressure
   * @property {number} switchWindow seconds before the strike in which they can no longer change their mind
   * @property {number} eyesUp 0..1: how often they punish a keeper who moves before that window
   * @property {number} honesty 0..1: how often their tell points where they shoot
   */

  /**
   * @typedef {Object} RivalRow
   * @property {string} id
   * @property {string} name
   * @property {number} seed rolls the two characters
   * @property {number} shirt dye index of the strip
   * @property {number} shorts dye index
   * @property {number} keeperShirt dye index of their keeper's top
   * @property {KeeperTraits} keeper
   * @property {TakerTraits} taker
   */

  /**
   * @typedef {Object} CupRow
   * @property {string} id
   * @property {string} name
   * @property {string} ground the stadium's name
   * @property {string} blurb the ground's rule, in the player's words
   * @property {number} wind most crosswind, metres per second (it changes every kick)
   * @property {number} pressure added to every kick's pressure (a loud ground)
   * @property {string} look a key of the stage's ground looks (games/penalty-stage.js)
   * @property {number} prize coins for lifting the cup
   * @property {RivalRow[]} rivals in ladder order
   */

  const keeperOf = (reaction, diveSpeed, reach, guess, bias, adapt, holdSpeed = 17, readNoise = 0.25) => ({ reaction, diveSpeed, reach, holdSpeed, guess, bias, adapt, readNoise });
  const takerOf = (side, high, pull, curl, spray, nerve, switchWindow, eyesUp, honesty) => ({ side, high, pull, curl, spray, nerve, switchWindow, eyesUp, honesty });
  const rival = (id, name, seed, colors, keeper, taker) => ({ id, name, seed, shirt: colors[0], shorts: colors[1], keeperShirt: colors[2], keeper, taker });

  /**
   * The ladder. Each cup teaches one thing and its last rival examines it: the Park Cup teaches placement and
   * timing against slow, honest sides; the Harbour Shield adds wind and keepers who gamble (so vary your side);
   * the Floodlight Trophy adds a loud ground and takers who lie and punish an early dive.
   */
  const CUPS = Kit.table([
    {
      id: 'park', name: 'Park Cup', ground: 'Marsh Lane Rec', blurb: 'Jumpers for goalposts, nearly. Still air, patient crowds.', wind: 0, pressure: 0, look: 'park', prize: 120,
      rivals: [
        rival('marsh', 'Marsh Lane', 101, [DYE.olive, DYE.cream, DYE.rust], keeperOf(0.36, 3.8, 0.4, 0.05, 0, 0), takerOf(0.6, 0.1, [0.5, 0.66], 0, 0.085, 0.3, 0.05, 0, 1)),
        rival('whistle', 'Tin Whistle', 102, [DYE.crimson, DYE.charcoal, DYE.sky], keeperOf(0.32, 4.1, 0.42, 0.3, 0.7, 0), takerOf(-0.7, 0.25, [0.55, 0.74], 0, 0.075, 0.4, 0.08, 0.2, 0.9)),
        rival('oldmill', 'Old Mill', 103, [DYE.navy, DYE.cream, DYE.coral], keeperOf(0.3, 4.3, 0.44, 0.15, -0.3, 0.3), takerOf(0.3, 0.45, [0.58, 0.8], 0.2, 0.07, 0.5, 0.1, 0.35, 0.85)),
        rival('ferry', 'Ferry Road', 104, [DYE.mustard, DYE.navy, DYE.plum], keeperOf(0.28, 4.5, 0.45, 0.3, 0, 0.5), takerOf(0, 0.45, [0.62, 0.84], 0.3, 0.06, 0.6, 0.14, 0.5, 0.8)),
      ],
    },
    {
      id: 'harbour', name: 'Harbour Shield', ground: 'Breakwater Ground', blurb: 'A crosswind off the sea, new every kick. Watch the flags.', wind: 12, pressure: 0.05, look: 'harbour', prize: 220,
      rivals: [
        rival('saltwind', 'Saltwind', 201, [DYE.sky, DYE.navy, DYE.coral], keeperOf(0.27, 4.5, 0.45, 0.5, 0.5, 0.2), takerOf(0.7, 0.35, [0.6, 0.82], 0.5, 0.065, 0.5, 0.12, 0.4, 0.8)),
        rival('gullrock', 'Gull Rock', 202, [DYE.cream, DYE.charcoal, DYE.teal], keeperOf(0.25, 4.7, 0.46, 0.2, 0, 0.7), takerOf(-0.3, 0.6, [0.64, 0.86], 0.2, 0.06, 0.6, 0.15, 0.55, 0.7)),
        rival('lantern', 'Lantern Quay', 203, [DYE.rust, DYE.cream, DYE.navy], keeperOf(0.24, 4.8, 0.47, 0.55, -0.6, 0.4), takerOf(0, 0.4, [0.62, 0.86], 0.7, 0.055, 0.65, 0.16, 0.6, 0.6)),
        rival('breakwater', 'Breakwater', 204, [DYE.navy, DYE.sky, DYE.mustard], keeperOf(0.23, 5.0, 0.48, 0.4, 0, 0.8), takerOf(0.3, 0.55, [0.68, 0.87], 0.5, 0.05, 0.7, 0.18, 0.7, 0.6)),
      ],
    },
    {
      id: 'lights', name: 'Floodlight Trophy', ground: 'The Crown Yard', blurb: 'A full house under the lights. Every kick weighs more here.', wind: 0, pressure: 0.25, look: 'lights', prize: 360,
      rivals: [
        rival('nightshift', 'Night Shift', 301, [DYE.charcoal, DYE.mustard, DYE.coral], keeperOf(0.23, 4.8, 0.47, 0.3, 0.4, 0.6), takerOf(-0.5, 0.5, [0.66, 0.87], 0.3, 0.055, 0.3, 0.16, 0.6, 0.5)),
        rival('ironbridge', 'Ironbridge', 302, [DYE.rust, DYE.charcoal, DYE.sky], keeperOf(0.22, 4.9, 0.47, 0.15, 0, 0.5), takerOf(0.4, 0.3, [0.72, 0.87], 0.1, 0.045, 0.8, 0.18, 0.7, 0.75)),
        rival('comet', 'Comet Works', 303, [DYE.plum, DYE.cream, DYE.forest], keeperOf(0.21, 4.9, 0.47, 0.6, 0, 0.9), takerOf(0, 0.6, [0.68, 0.87], 0.8, 0.045, 0.7, 0.2, 0.8, 0.35)),
        rival('crown', 'Crown Yard', 304, [DYE.crimson, DYE.navy, DYE.mustard], keeperOf(0.2, 5.0, 0.48, 0.45, 0, 0.9), takerOf(0, 0.5, [0.72, 0.88], 0.5, 0.04, 0.9, 0.22, 0.9, 0.5)),
      ],
    },
  ]);

  /** The endless road after the last cup: each rival a little sharper than the last, on a ground that rotates. */
  const ROAD = Object.freeze({
    id: 'road', name: "Champions' Road", blurb: 'No trophy at the end. Just a harder rival, every time.',
    /** How far a road rival's numbers move per rung, towards these limits. */
    growth: 0.08,
    best: Object.freeze({ keeper: keeperOf(0.18, 5.4, 0.5, 0.5, 0, 1, 19, 0.15), taker: takerOf(0, 0.5, [0.76, 0.88], 0.6, 0.03, 1, 0.26, 1, 0.4) }),
    names: Object.freeze(['Vagabonds', 'Long Shadows', 'Tall Order', 'Last Bus', 'Paper Lions', 'Second Wind', 'Loose Cannons', 'Quiet Storm']),
    winPrize: 90,
  });

  const mixNumber = (from, to, share) => (Array.isArray(from) ? from.map((value, index) => lerp(value, to[index], share)) : lerp(from, to, share));
  const mixTraits = (from, to, share) => Object.fromEntries(Object.keys(from).map((key) => [key, mixNumber(from[key], to[key], share)]));

  /**
   * The rival at a rung of the endless road: the last cup's champions drifting towards `ROAD.best`, with a side
   * bias, a kit and a ground that depend only on the rung, so the road is the same for every player.
   * @param {number} rung 0 for the first road match
   * @returns {RivalRow & {cup: CupRow}} the rival and the ground it is played on
   * @complexity O(1)
   * @example SPOT_KICK_DATA.roadRival(3).name // 'Last Bus IV'
   */
  const roadRival = (rung) => {
    const champion = CUPS[CUPS.length - 1].rivals[3];
    const share = clamp(1 - Math.pow(1 - ROAD.growth, rung + 1));
    const rng = Kit.rng(9000 + rung);
    const dyes = Object.values(DYE);
    const keeper = { ...mixTraits(champion.keeper, ROAD.best.keeper, share), bias: rng.range(-0.7, 0.7), guess: rng.range(0.15, 0.65) };
    const taker = { ...mixTraits(champion.taker, ROAD.best.taker, share), side: rng.range(-0.8, 0.8), high: rng.range(0.25, 0.7), honesty: rng.range(0.3, 0.9) };
    const name = `${ROAD.names[rung % ROAD.names.length]} ${romanOf(Math.floor(rung / ROAD.names.length) + 1)}`;
    return { ...rival(`road${rung}`, name, 9000 + rung, [rng.pick(dyes), rng.pick(dyes), rng.pick(dyes)], keeper, taker), cup: { ...CUPS[rung % CUPS.length], id: ROAD.id, name: ROAD.name } };
  };

  /** @type {Array<[number, string]>} */
  const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  /** A small whole number in Roman numerals (road rivals come round again as "II", "III"). */
  const romanOf = (value) => ROMAN.reduce(({ left, text }, [worth, mark]) => ({ left: left % worth, text: text + mark.repeat(Math.floor(left / worth)) }), { left: value, text: '' }).text;

  // ===================================================== scouting =====================================================

  /** Thresholds that turn a trait into a word. One place, so the report can never disagree with the numbers. */
  const SCOUT = Object.freeze({ strongSide: 0.35, gambler: 0.4, slowReaction: 0.3, sharpReaction: 0.22, liar: 0.55, hunter: 0.55, highShare: 0.55, lowShare: 0.25, curler: 0.45, shaky: 0.45, learner: 0.6 });

  /**
   * What the bench knows about a rival, as short sentences generated from its traits.
   * Sides are given as the player sees them in each role: shooting, +X is the player's right; keeping, the
   * camera faces the taker, so the taker's right is the player's left.
   * @param {RivalRow} row
   * @returns {{keeper: string[], taker: string[]}} notes on their keeper (for when you shoot) and their taker (for when you keep)
   * @complexity O(1)
   * @example SPOT_KICK_DATA.scoutOf(CUPS[0].rivals[1]).keeper // ['Gambles now and then, usually to your right', ...]
   */
  const scoutOf = ({ keeper, taker }) => {
    const sideWord = (value, flip) => ((flip ? -value : value) > 0 ? 'right' : 'left');
    const keeperNotes = [
      keeper.guess >= SCOUT.gambler ? `Gambles early${Math.abs(keeper.bias) >= SCOUT.strongSide ? `, usually to your ${sideWord(keeper.bias)}` : ''}` : Math.abs(keeper.bias) >= SCOUT.strongSide ? `When guessing, goes to your ${sideWord(keeper.bias)}` : 'Waits and reads the ball',
      keeper.reaction >= SCOUT.slowReaction ? 'Slow off the line: power beats them' : keeper.reaction <= SCOUT.sharpReaction ? 'Sharp reactions: place it or bend it' : 'Decent reactions',
      keeper.adapt >= SCOUT.learner ? 'Remembers where you shot: do not repeat yourself' : null,
    ];
    const takerNotes = [
      Math.abs(taker.side) >= SCOUT.strongSide ? `Favours your ${sideWord(taker.side, true)}` : 'Uses both sides',
      taker.high >= SCOUT.highShare ? 'Likes it high' : taker.high <= SCOUT.lowShare ? 'Keeps it low' : null,
      taker.curl >= SCOUT.curler ? 'Bends it: read the ball, not the run' : null,
      taker.honesty <= SCOUT.liar ? 'Their eyes lie' : 'An honest run-up: watch the shoulders',
      taker.eyesUp >= SCOUT.hunter ? 'Punishes an early dive' : null,
      taker.nerve <= SCOUT.shaky ? 'Cracks under pressure' : null,
    ];
    return { keeper: keeperNotes.filter(Boolean), taker: takerNotes.filter(Boolean) };
  };

  // ================================================== rules and rewards ==================================================

  /** A shootout: five each, then pairs until one side is ahead after both have kicked. */
  const RULES = Object.freeze({ kicks: 5 });

  /** Coins. A streak is consecutive successes of the player (goals scored, shots kept out) within a match. */
  const REWARDS = Object.freeze({
    goal: 8,
    save: 12,
    held: 6, // extra for holding it instead of parrying
    corner: 6, // extra for a goal within `cornerReach` metres of a top corner
    cornerReach: 0.6,
    perStreak: 0.25, // each success in a row adds this share to the next reward
    mostStreak: 4,
    win: 40,
    perRung: 10, // added to the win prize per rung climbed so far
    loss: 10,
  });

  /** What the map says is locked, and why. */
  const cupUnlockId = (cup) => `cup:${cup.id}`;

  /** Total rungs of the cups, in ladder order: [{ cup, rival, rung, index }], index counting from 0 across cups. */
  const LADDER = CUPS.flatMap((cup) => cup.rivals.map((row, rung) => ({ cup, rival: row, rung }))).map((entry, index) => ({ ...entry, index }));

  // ================================================== the player's long arc ==================================================

  /** How many past shots per rival the scouting sheet remembers. */
  const MOST_SHOTS_REMEMBERED = 12;

  /**
   * The player's long arc as one model: coins (Kit.wallet), owned balls, perks and kits and lifetime numbers
   * (Kit.profile), what is equipped (feeding Kit.stats), the ladder position, and what has been seen of each
   * rival's shots. Pure: pass any { get, set } as `save`, or none to keep it in memory (tests, simulation).
   * @param {{save?: {get: Function, set: Function}}} [options]
   * @returns {Object} see the returned object
   * @complexity every call is O(table rows) or better
   * @example
   * const progress = SPOT_KICK_DATA.createProgress({ save: ctx.save });
   * const { rival, cup } = progress.next();
   * progress.recordMatch({ won: true, coins: 96 });   // climbs a rung; returns what it opened
   */
  const createProgress = ({ save } = {}) => {
    const stats = Kit.stats({ ...PLAYER_STATS });
    const wallet = Kit.wallet({ coins: 0 }, save);
    const profile = Kit.profile({ save });
    const load = (key, fallback) => (save ? save.get(key, fallback) : fallback);
    const keep = (key, value) => (save ? save.set(key, value) : value);
    let equipped = { ball: 'classic', kit: 'home', taker: null, keeper: null, ...load('equipped', {}) };
    let rungsWon = load('rungs', 0);
    const scouting = { ...load('scouting', {}) };

    const isOwned = (kind, row) => row.cost === 0 || profile.isUnlocked(`${kind}:${row.id}`);
    const applyPerks = () => ['taker', 'keeper'].forEach((role) => stats.mod(`perk:${role}`, equipped[role] ? PERKS.byId(equipped[role]).mods : null));
    applyPerks();

    /** The match a rung number stands for: a cup rival, or a road rival past the last cup. */
    const matchAt = (index) => (index < LADDER.length ? { ...LADDER[index], isRoad: false } : { rival: roadRival(index - LADDER.length), cup: roadRival(index - LADDER.length).cup, rung: index - LADDER.length, index, isRoad: true });

    return {
      stats,
      wallet,
      profile,
      isOwned,
      matchAt,
      /** What is equipped: `{ ball, kit, taker, keeper }` (ids; a perk slot may be null). */
      equipped: () => ({ ...equipped }),
      ball: () => BALLS.byId(equipped.ball),
      kit: () => KITS.byId(equipped.kit),
      /** Rungs won so far (also the index of the next match). */
      rungsWon: () => rungsWon,
      /** The next match on the ladder. */
      next: () => matchAt(rungsWon),
      isCupOpen: (cup) => rungsWon >= LADDER.find((entry) => entry.cup.id === cup.id).index,
      isRoadOpen: () => rungsWon >= LADDER.length,
      /**
       * Buys a ball, perk or kit.
       * @param {('ball'|'perk'|'kit')} kind @param {string} id
       * @returns {boolean} false when it is owned already or the coins are short
       */
      buy(kind, id) {
        const row = { ball: BALLS, perk: PERKS, kit: KITS }[kind].byId(id);
        if (isOwned(kind, row) || !wallet.spend(row.cost)) return false;
        profile.unlock(`${kind}:${id}`);
        return true;
      },
      /**
       * Equips something owned. A perk goes in its role's slot; passing the perk already there empties the slot.
       * @param {('ball'|'perk'|'kit')} kind @param {string} id
       * @returns {boolean} false when it is not owned
       */
      equip(kind, id) {
        const row = { ball: BALLS, perk: PERKS, kit: KITS }[kind].byId(id);
        if (!isOwned(kind, row)) return false;
        const slot = kind === 'perk' ? row.role : kind;
        equipped = keep('equipped', { ...equipped, [slot]: kind === 'perk' && equipped[slot] === id ? null : id });
        applyPerks();
        return true;
      },
      /**
       * Banks a finished match: coins, lifetime numbers, and a rung when it was won.
       * @param {{won: boolean, coins: number, goals?: number, saves?: number, index?: number}} result `index`: the
       *   rung played (default the next one); replaying an earlier rung pays but does not climb
       * @returns {{climbed: boolean, opened: string[], prize: number}} `opened`: sentences for what the match opened (medals, cups)
       */
      recordMatch({ won, coins, goals = 0, saves = 0, index = rungsWon }) {
        const played = matchAt(index);
        const climbed = won && index === rungsWon;
        const isCupFinal = climbed && !played.isRoad && played.rung === played.cup.rivals.length - 1;
        const prize = isCupFinal ? played.cup.prize : 0;
        wallet.add(Math.round((coins + prize) * stats.get('coinShare')));
        const gradesBefore = MEDALS.map((medal) => medalGrade(medal, profile.stat(medal.stat)));
        profile.count('matches');
        profile.count('goals', goals);
        profile.count('saves', saves);
        if (won) profile.count('wins');
        profile.endRun({ rival: played.rival.id, won, coins });
        // Medals: each new grade pays, and is named in what the match opened.
        const opened = MEDALS.flatMap((medal, index) => {
          const grade = medalGrade(medal, profile.stat(medal.stat));
          if (grade === gradesBefore[index]) return [];
          wallet.add(medal.coins * grade);
          return [`${medal.name} ${romanOf(grade)} medal (+${medal.coins * grade} C)`];
        });
        if (!climbed) return { climbed, opened, prize };
        rungsWon = keep('rungs', rungsWon + 1);
        profile.best('rungs', rungsWon);
        const nextUp = matchAt(rungsWon);
        if (isCupFinal) {
          profile.unlock(cupUnlockId(played.cup));
          opened.push(`${played.cup.name} won`, nextUp.isRoad ? `${ROAD.name} opens` : `${nextUp.cup.name} opens at ${nextUp.cup.ground}`);
        }
        return { climbed, opened, prize };
      },
      /**
       * Remembers where a rival's taker put a shot, for the scouting sheet.
       * @param {string} rivalId @param {{x: number, y: number}} point where it crossed the keeper's line
       */
      noteShot(rivalId, point) {
        scouting[rivalId] = [...(scouting[rivalId] || []), [Math.round(point.x * 100) / 100, Math.round(point.y * 100) / 100]].slice(-MOST_SHOTS_REMEMBERED);
        keep('scouting', scouting);
      },
      /** Past shots of a rival's takers: `[[x, y], ...]`, oldest first. */
      shotsSeen: (rivalId) => scouting[rivalId] || [],
      /** Everything for sale that is not owned: `[{ kind, row }]`. */
      forSale: () => [...BALLS.map((row) => ({ kind: 'ball', row })), ...PERKS.map((row) => ({ kind: 'perk', row })), ...KITS.map((row) => ({ kind: 'kit', row }))].filter(({ kind, row }) => !isOwned(kind, row)),
    };
  };

  // ===================================================== the cast =====================================================

  /** Index of the leathers the strips use (kit/body-wardrobe.js `leathers`): boots are black, gloves are pale canvas. */
  const LEATHER = Object.freeze({ boots: 2, gloves: 5 });
  /** How often each body type of the wardrobe catalogue turns out for a side. */
  const SQUAD_MIX = Object.freeze([{ species: 'person', weight: 3 }, { species: 'stout', weight: 1 }, { species: 'lanky', weight: 1 }, { species: 'hornkin', weight: 1 }]);
  /** Things nobody takes onto a pitch: recipe overrides that empty the hands, the back and the coat pegs. */
  const BARE = Object.freeze({ 'fill:outerwear': null, 'fill:back': null, 'fill:handLeft': null, 'fill:handRight': null });
  /** Which roll of a rival's seed is its taker and which its keeper. */
  const ROLL_OF = Object.freeze({ taker: 0, keeper: 1 });
  /** The seed of the player's side when no Character Maker character is saved. */
  const HOME_SEED = 2024;

  /**
   * The recipe overrides that put a character in a strip: a tee and shorts in the side's colours, or a long
   * sleeve in the keeper's colour with gloves.
   * @param {{shirt: number, shorts: number, keeper: number}} colors dye indices
   * @param {('taker'|'keeper')} role
   * @returns {Object<string, (string|number|null)>}
   */
  const stripOf = ({ shirt, shorts, keeper }, role) => ({
    ...BARE,
    'fill:top': role === 'keeper' ? 'longSleeve' : 'tee',
    'fill:bottom': 'shorts',
    'fill:footwear': 'shoes',
    'fill:hat': null,
    'fill:gloves': role === 'keeper' ? 'gloves' : null,
    'color:top': role === 'keeper' ? keeper : shirt,
    'color:bottom': shorts,
    'color:footwear': LEATHER.boots,
    'color:gloves': LEATHER.gloves,
  });

  const withOverrides = (recipe, overrides) => ({ ...recipe, overrides: { ...recipe.overrides, ...overrides } });

  /**
   * The recipe of a rival's taker or keeper: an individual rolled from the wardrobe catalogue by the rival's
   * seed, in the rival's strip. The two roles of one rival are different people in the same colours.
   * @param {Object} catalog `Kit.body.catalog(Kit.body.wardrobe.CATALOG)`
   * @param {RivalRow} row
   * @param {('taker'|'keeper')} role
   * @returns {Object} a `Recipe` of kit/body-recipe.js
   * @example bakery.bakeRecipe(SPOT_KICK_DATA.rivalRecipe(catalog, rival, 'keeper'))
   */
  const rivalRecipe = (catalog, row, role) => withOverrides(catalog.table(SQUAD_MIX).roll(row.seed, ROLL_OF[role]), stripOf({ shirt: row.shirt, shorts: row.shorts, keeper: row.keeperShirt }, role));

  /**
   * The recipe of the player's character for a role. A saved Character Maker character plays both roles and
   * keeps its own clothes under the `own` kit (hands emptied, gloves on in goal); any other kit dresses it in
   * that strip. With no saved character a home player is rolled.
   * @param {Object} catalog
   * @param {?Object} saved the saved character's recipe, or null
   * @param {KitRow} kitRow
   * @param {('taker'|'keeper')} role
   * @returns {Object} a `Recipe`
   */
  const playerRecipe = (catalog, saved, kitRow, role) => {
    const base = saved || catalog.table(SQUAD_MIX).roll(HOME_SEED, 0);
    const strip = kitRow.shirt === null ? (saved ? null : KITS.byId('home')) : kitRow;
    if (strip) return withOverrides(base, stripOf(strip, role));
    return withOverrides(base, { ...BARE, ...(role === 'keeper' ? { 'fill:gloves': 'gloves', 'color:gloves': LEATHER.gloves } : {}) });
  };

  window.SPOT_KICK_DATA = { FIELD, STEP, SHOT, SWAY, PRESSURE, PLAYER_STATS, KEEPER, RUN_UP, BALLS, PERKS, DYE, KITS, MEDALS, medalGrade, CUPS, ROAD, LADDER, RULES, REWARDS, SCOUT, roadRival, scoutOf, cupUnlockId, createProgress, stripOf, rivalRecipe, playerRecipe };
})();
