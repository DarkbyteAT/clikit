// Plumwick Pond, data: every table and tunable of the cozy demo, plus the small pure functions that read them.
//
// Owns: the palette and sprite art, fish / tier / tackle / crop / goal rows, the village layout, the day phases, the
//       tuning of each activity, and `Cozy.rules` (pure functions over those tables: values, bites, crop stages, the shore).
// Does not own: anything that touches THREE, the DOM, input or sound - see cozy-theme.js (HUD look), cozy-world.js
//       (the diorama), cozy-fishing.js (the dock and its minigames) and cozy.js (models, HUD, roaming, farm, stall).
//
// Adding content is adding a row: a fish to FISH, an implement to TACKLE, a crop to CROPS, a goal to GOALS.
(() => {
  const { path, curve } = Kit;
  const { clamp, lerp } = Kit.math;

  // ================= ART =================
  /** Palette: one character per colour, so sprite rows read like the picture they draw. */
  const PALETTE = {
    k: 0x2b2233, w: 0xfffaf0, c: 0xf2e2c0, C: 0xe6cf9a, s: 0xf4c7a1, r: 0xe0564f, R: 0xa83a44, o: 0xf28c3a, y: 0xf9d45c, Y: 0xdba233,
    g: 0x84c552, G: 0x45954c, d: 0x2c6b4c, b: 0x5fb0e6, B: 0x3873b5, n: 0x293f6e, t: 0x48c4b2, T: 0x2b908b, a: 0xaee6f0,
    p: 0xf5a0b9, v: 0x9373d6, V: 0x5f479c, m: 0x9c6c47, M: 0x6b4630, l: 0xcd9b62, e: 0xaba9b8, E: 0x706d83, h: 0xdadae4,
  };
  /** The hero from the hat down to the hem; each walk frame adds its own legs. */
  const HERO_BODY = ['....yyyy....', '...yyyyyy...', '..yrrrrrry..', '.YYYYYYYYYYY', '..MMssssss..', '..Mssskssk..', '..Msssssps..', '...ssssss...', '..ggmggggg..', '.sgggmggggs.', '.sggggmgggs.', '..llgggggg..', '..llGGGGGG..'];
  const HERO_LEGS = { stand: ['..bbb..bbb..', '..bbb..bbb..', '..MMM..MMM..'], leftUp: ['..bbb..bbb..', '..bbb..MMM..', '..MMM.......'], rightUp: ['..bbb..bbb..', '..MMM..bbb..', '.......MMM..'] };

  /** Every sprite of the game. Fish face right; `wrap` tiles repeat seamlessly on surfaces. */
  const ART = Kit.pixel.sheet(PALETTE, {
    hero: { frames: [HERO_LEGS.stand, HERO_LEGS.leftUp, HERO_LEGS.rightUp].map((legs) => HERO_BODY.concat(legs)), anims: { walk: [1, 0, 2, 0] } },
    nan: ['....hhhh....', '...hhhhhh.hh', '..hhhhhhhhhh', '..hsssssshh.', '..sksssksh..', '..spssspsh..', '...ssrrss...', '..vvvvvvvv..', '.vvVvvvvVvv.', '.svvccccvvs.', '.svccccccvs.', '..vccccccv..', '..vccccccv..', '..VVVVVVVV..', '..VVVVVVVV..', '..MM....MM..'],
    // --- fish ---
    minnel: ['b...hhhhh...', 'bb.hhhhhhkh.', '.bbhhhhhhhhh', '.bbaaaaaaaa.', 'bb..aaaaa...', 'b...........'],
    dapple: ['......rr......', 'o....oooooo...', 'oo.oooyooooko.', '.ooooyoooyoooo', '.ooyoooyoooooo', 'oo.ccccccccc..', 'o....cccc.....', '......o.......'],
    reed: ['g......GGG......', 'gg..ggggggggg...', '.gggGgGgGggggkg.', '.ggyyyyyyyyyyyyy', 'gg..yyyyyyyyy...', 'g......G........'],
    bream: ['......YY.....', '.....yyyyy...', 'y...yyyyyyy..', 'yy.yyyyyyyky.', '.yyyywyyyyyyy', '.yyywwyyyyyyo', 'yy.yyyyyyyyy.', 'y...yyyyyyy..', '.....yyyyy...', '......YY.....'],
    gup: ['...........yy.', '......TT..t.y.', 't....tttttt...', 'tt..tttttttt..', '.ttttttttwkt..', '.tttatttttttt.', 'tt..taattttt..', 't....tttttt...', '......TT......'],
    silkeel: ['....vv......vv....', '..vvvvvv..vvvvvv..', 'vvvVvvvvvvvvVvvvkv', 'vv...vvvvvv...vvvv', '......pppp......p.'],
    carplet: ['.......hh......', 'a....wwwwww....', 'aa..wwwwwwww...', '.aawwwyywwwwkw.', '.aawwywwwwwwwww', '.aawwwyywwwwww.', 'aa..wwwwwwww...', 'a....aaaaaa....', '.......hh......'],
    pike: ['....R.R.R.R.R.....', 'r..rrrrrrrrrrrr...', 'rr.rrRrrRrrRrrkrr.', '.rrrrrrrrrrrrrrrrr', '.rrcccccccccccwww.', 'rr.ccccccccccc....', 'r....R....R.......'],
    mossjaw: ['........dd..dd........', '......GGGGGGGGGG......', 'G...GGGgGGGGgGGGGG....', 'GG.GGGGGGGGGGGGGGGGG..', 'GGGGGgGGGGGGGGGGyyGGG.', '.GGGGGGGGgGGGGGGykGGGG', '.GGGGGGGGGGGGGGGGGGGGG', 'GGGGGGGgGGGGGGGGGwkwk.', 'GG.ddddddddddddddd....', 'G...dddddddddddd......', '......dd....dd........'],
    sprat: ['a..hhhh.', 'aahhhhkh', 'aaaaaaaa', 'a..aaa..'],
    glowfry: ['y.yyy.', 'yyyyky', 'y.yyy.'],
    snapper: ['.......nn.......', 'n....nnnnnnn....', 'nn..nnnnnnnnnn..', '.nnnnnnnnnnryn..', '.nnnnnnnnnnnnnnn', '.nnnnnnnnnnwnwn.', 'nn..nnnnnnnnn...', 'n....nnnnnn.....'],
    // --- crops: seeds -> sprout -> leafy -> the crop's own sprite ---
    seeds: ['.m..m.', 'm.mm.m'],
    sprout: ['g...g.', 'gg.gg.', '.ggg..', '..g...'],
    leafy: ['.g....g.', '.gg..gg.', 'g.gggg.g', 'gg.gg.gg', '.gggggg.', '..GggG..', '...GG...'],
    beet: ['.g.gg.g.', '.gggggg.', '..gGGg..', '.pppppp.', 'pppwpppp', 'pppppppr', '.pppppr.', '..pppr..', '...pr...'],
    pea: ['..g.gg..', '.gg.g.g.', '.gygg.y.', '.yyg.yy.', '.yygGyy.', '.gy.Gy.g', 'gg..G.gg', '.g.GG.g.', '..gGGg..'],
    melon: ['....gG....', '...ggG....', '..tttttt..', '.ttttyttTt', 'ttttyyyttT', 'tttttytttT', '.tttttttT.', '..TTTTTT..'],
    // --- village ---
    tree: ['......gggg......', '....gggggggg....', '...ggggggggggg..', '..gggygggggggGg.', '.ggggggggggggGG.', '.gggggggyggggGGG', 'gggggggggggggGGG', 'ggyggggggggGGGGG', 'gggggggggggGGGGG', '.ggggggggGGGGGG.', '.GgggggGGGGGGGG.', '..GGGGGGGGGGGG..', '...GGGGGGGGGd...', '.....dGmmGd.....', '......mmM.......', '......mmM.......', '......mmM.......', '.....mmmMM......'],
    bush: ['...gggggg...', '.ggggrgggGg.', 'gggggggggGGG', 'ggrggggrgGGG', 'GggggggGGGGG', '.GGGGGGGGGG.'],
    flower: ['.p.p..', 'ppypp.', '.ppp..', '..g...', '.gg.g.', '..gg..'],
    reeds: ['..M.....', '..M..M..', '..M..M..', '..g..M..', '..g..g.M', 'g.g..g.M', 'g.g.gg.g', 'g.g.g..g', 'ggg.g.gg', '.gg.ggg.', '.gggggg.'],
    rock: ['...eee....', '.eeehee...', 'eeheeeeEe.', 'eeeeeeEEEE', 'eEeeeEEEEE', '.EEEEEEEE.'],
    fence: ['.l...l...l...l..', 'lll.lll.lll.lll.', 'lmlllmlllmlllml.', 'lml.lml.lml.lml.', 'lmlllmlllmlllml.', 'lml.lml.lml.lml.', 'lml.lml.lml.lml.'],
    cottage: { mirror: true, rows: ['..................RR', '................RRrr', '..............RRrrrr', '............RRrrrrrr', '..........RRrrrrrorr', '........RRrrrrrrrrrr', '......RRrrrorrrrrrrr', '....RRrrrrrrrrrrorrr', '..RRrrrrrrrorrrrrrrr', 'RRrrrorrrrrrrrrrrrrr', 'RRrrrrrrrrrrrorrrrrr', '.RRRRRRRRRRRRRRRRRRR', '...CCCCCCCCCCCCCCCCC', '...ccccccccccccccccc', '...ccccccccccccMMMMM', '...ccMMMMMMMccMMllll', '...ccMaaabbMccMlllll', '...ccMaabbbMccMlllll', '...ccMMMMMMMccMlllll', '...ccMabbbbMccMlllll', '...ccMbbbbaMccMlllll', '...ccMMMMMMMccMlllly', '...cgpgygpgpgcMlllll', '...cGGGGGGGGGcMlllll', '...cccccccccccMlllll', '...cccccccccccMlllll', '...cccccccccccMlllll', '...eeEeeeEeeeeMlllll', '...eEeeeEeeeEeMlllll'] },
    stall: { mirror: true, rows: ['..RRRRRRRRRR', '.rrwwrrwwrrw', 'rrrwwrrwwrrw', 'rrrwwrrwwrrw', 'rrrwwrrwwrrw', 'rr.w.r.w.r.w', '.M..........', '.M..........', '.M..........', '.M..........', '.M..........', '.M..........', '.M.......oo.', '.M.gg.yy.ooo', 'llllllllllll', 'mmmmmmmmmmmm', 'mMmmmmmMmmmm', 'mMmmmmmMmmmm', 'mMmmmmmMmmmm', 'mmmmmmmmmmmm', 'mmmmmmmmmmmm'] },
    bobber: ['..k..', '..k..', '.rrr.', 'rrrrr', 'wwwww', '.www.'],
    petal: ['pp', 'p.'],
    star: ['...y...', '...y...', 'yyyyyyy', '.yyyyy.', '..yyy..', '.yy.yy.', '.y...y.'],
    // --- tackle and HUD icons ---
    rod: ['.......lk', '......l.k', '.....l..k', '....l...k', '...l....k', '..l.....k', '.M......r', 'M.......w'],
    net: ['.kkkkkk..', 'kwkwkwkk.', 'kkwkwkwk.', 'kwkwkwkk.', '.kkkkkk..', '.....MM..', '......MM.', '.......MM'],
    lantern: ['..kkk..', '..k.k..', '.MMMMM.', '.MyyyM.', '.MywyM.', '.MywyM.', '.MyyyM.', '.MMMMM.'],
    pouch: ['..M...M..', '...MMM...', '...lll...', '..mmmmm..', '.mmmmmmm.', '.mmymmmm.', '.mmyymmm.', '.mmmmmmm.', '..mmmmm..'],
    // --- underwater theatre ---
    weed: ['..g...', '.gg...', '.gG...', '..gg..', '..Gg..', '.gg...', '.gG...', '..gg..', '..Gg.g', '.gg.gg', '.gG.g.', '..gggG', '..GgG.', '..GG..'],
    wave: ['..www......www..', '.waaaw....waaaw.', 'waaaaaw..waaaaaw', 'aaaaaaawwaaaaaaa', 'aaaaaaaaaaaaaaaa'],
    sand: ['...CCC.......CC.', '.CCCCCCC...CCCCC', 'CCCCCCCCCCCCCCCC', 'CCCCCCCCCCCCCCCC'],
    // --- seamless surfaces ---
    water: { wrap: true, rows: ['bbbbbbbbbbbbbbbb', 'bbaaabbbbbbbbbbb', 'bbbbbbbbbbbaabbb', 'bbbbbbbbbbbbbbbb', 'bbbbbbaaaabbbbbb', 'bbbbbbbbbbbbbbbb', 'abbbbbbbbbbbbaaa', 'bbbbbbbbbbbbbbbb'] },
    glint: { wrap: true, rows: ['................', '.........ww.....', '................', '..w.............', '................', '.............w..', '.....ww.........', '................'] },
    depths: { wrap: true, rows: [...'aaabbbbbbBBBBBBBnnnn'] }, // one pixel wide: a vertical gradient from the shallows down
    air: { wrap: true, rows: ['c'] },
    seabed: { wrap: true, rows: ['C'] },
  });
  /** How many times a strip sprite is repeated to span the theatre in any aspect ratio. */
  const STRIP_REPEATS = 16;
  Object.assign(ART, {
    blossom: Kit.pixel.recolor(ART.tree, { g: 0xf7b3c8, G: 0xe07fa3, y: 0xfffaf0, d: 0xb85d85 }),
    pine: Kit.pixel.recolor(ART.tree, { g: 0x4fa37a, G: 0x2f7a63, y: 0x84c552, d: 0x235a4c }),
    daisy: Kit.pixel.recolor(ART.flower, { p: 0xfffaf0 }),
    starDim: Kit.pixel.recolor(ART.star, { y: 0xd9c8a5 }),
    fenceRun: Kit.pixel.tile(ART.fence, 3),
    waves: Kit.pixel.tile(ART.wave, STRIP_REPEATS),
    sands: Kit.pixel.tile(ART.sand, STRIP_REPEATS),
  });

  // ================= DAY =================
  /**
   * @typedef {Object} DayPhase  A quarter of the day; the world blends from each phase into the next.
   * @property {string} id
   * @property {string} name      Shown when the phase begins.
   * @property {number} tint      Colour multiplied into every sprite, 0xRRGGBB.
   * @property {number} sun       Sun colour.
   * @property {number} sunIntensity
   * @property {number} ambient   Hemisphere light intensity.
   * @property {number} night     0..1: how much of the night dressing (fireflies, lit window) shows.
   */
  /** Seconds a whole day lasts, and its phases in order. Fish rows refer to phases by index ("hours" 0..4). */
  const DAY = {
    seconds: 72,
    phases: [
      { id: 'morning', name: 'Morning', tint: 0xfff2dc, sun: 0xffe6c0, sunIntensity: 1.1, ambient: 0.9, night: 0 },
      { id: 'noon', name: 'Midday', tint: 0xffffff, sun: 0xfff6e6, sunIntensity: 1.25, ambient: 0.95, night: 0 },
      { id: 'dusk', name: 'Dusk', tint: 0xffc9a2, sun: 0xff9d6b, sunIntensity: 0.9, ambient: 0.8, night: 0 },
      { id: 'night', name: 'Night', tint: 0x8c9be0, sun: 0x6f86d8, sunIntensity: 0.4, ambient: 0.62, night: 1 },
    ],
  };

  // ================= FISH =================
  // Swim behaviours are Kit.path compositions in panel space (-1..1 on both axes, y up).
  /** Waypoints the stop-and-dart fish visit, in panel space. */
  const WAYPOINTS = {
    hops: [[-0.7, -0.3], [0.6, 0.5], [-0.5, 0.6], [0.7, -0.5], [-0.65, 0.1], [0.5, -0.6]],
    lurks: [[-0.6, 0.5], [0.5, 0.1], [-0.2, -0.6], [0.65, -0.5], [-0.65, -0.1], [0.2, 0.6]],
    sweeps: [[-0.85, 0.4], [0.85, 0.4], [0.85, -0.3], [-0.85, -0.3], [-0.85, 0.6], [0.85, -0.55], [0.85, 0.1], [-0.85, 0.1]],
  };
  const figureEight = path.scale(path.lissajous(1, 2), 0.7, 0.48);
  /** A big loop with a smaller counter-rotating loop riding on it: ribbon-like curls. */
  const ribbon = path.scale(path.add(path.circle(0.6, 1), path.circle(0.3, -2.4)), 0.85, 0.75);
  const sweeps = (holdSeconds, dashSeconds) => path.darts(WAYPOINTS.sweeps, holdSeconds, dashSeconds);

  /** What a fish's tier means. Tiers run 1..5; every curve takes the tier. */
  const TIER = {
    /** Time warp on the swim path: higher tiers swim the same shape faster. */
    pace: curve.of([[1, 1], [3, 1.08], [5, 1.2]]),
    /** Seconds on target needed to land it. */
    fightSeconds: curve.of([[1, 3.2], [2, 4.4], [4, 6.2], [5, 9]]),
    /** Coins at the stall before stars and species worth. */
    value: curve.of({ steps: [[1, 6], [2, 12], [3, 22], [4, 40], [5, 150]] }),
    /** Bite weight: each tier up is this much rarer (takes tier - 1). */
    biteWeight: curve.of({ base: 10, growth: 0.62 }),
  };

  /**
   * @typedef {Object} Fish
   * @property {string} id      Also the name of its sprite in ART.
   * @property {string} name
   * @property {number} tier    1..5: drives pace, fight length, value and rarity through TIER.
   * @property {number} worth   Value multiplier within its tier.
   * @property {number} [size]  Body size: bigger fish are drawn larger and get a slightly wider ring.
   * @property {(time: number) => { x: number, y: number }} [swim]  Its path when hooked on a rod.
   * @property {string} [style] One line on how it swims, for the catch card.
   * @property {[number, number]} [hours]  Day phases it bites in, [from, until) as phase indices (0 morning .. 4).
   * @property {string} [water]  Id of the WATERS row it lives in.
   * @property {string} [likes]  Crop id that works as its bait (see BAIT).
   * @property {boolean} [needsBait]  It only bites when its liked bait is on the hook.
   * @property {string} [via]   Tackle id that catches it instead of a rod (school fish).
   */
  /** @type {Fish[] & { byId: (id: string) => Fish, has: (id: string) => boolean }} */
  const FISH = Kit.table([
    { id: 'minnel', name: 'Pond Minnel', tier: 1, size: 1, worth: 0.9, hours: [0, 4], water: 'shallows', style: 'Lazy circles', swim: path.add(path.scale(path.circle(1, 1.1), 0.6, 0.48), path.wobble(0.04, 2.5)) },
    { id: 'dapple', name: 'Dapplefin', tier: 1, size: 1.1, worth: 1.3, hours: [0, 2], water: 'shallows', likes: 'beet', style: 'Slow wide weaves', swim: path.scale(path.lissajous(0.6, 1.9), 0.75, 0.42) },
    { id: 'reed', name: 'Reedskipper', tier: 2, size: 1.1, worth: 0.9, hours: [1, 3], water: 'shallows', likes: 'pea', style: 'Restless hops', swim: path.darts(WAYPOINTS.hops, 0.5, 1) },
    { id: 'bream', name: 'Butterbream', tier: 2, size: 1.2, worth: 1.15, hours: [0, 2], water: 'shallows', likes: 'beet', style: 'Figure-eights', swim: path.warp(figureEight, (time) => time * 0.85) },
    { id: 'gup', name: 'Lantern Gup', tier: 3, size: 1.2, worth: 0.9, hours: [2, 4], water: 'shallows', likes: 'pea', style: 'Lurks, then darts', swim: path.add(path.darts(WAYPOINTS.lurks, 0.9, 0.5), path.wobble(0.025, 9)) },
    { id: 'silkeel', name: 'Silkeel', tier: 3, size: 1.3, worth: 1.1, hours: [2, 4], water: 'deep', likes: 'melon', style: 'Ribbon curls', swim: ribbon },
    { id: 'carplet', name: 'Moon Carplet', tier: 4, size: 1.3, worth: 0.9, hours: [2, 4], water: 'deep', likes: 'pea', style: 'Sharp zigzags', swim: path.scale(path.zigzag(1.3, 1.9), 0.8, 0.5) },
    { id: 'pike', name: 'Thornback Pike', tier: 4, size: 1.4, worth: 1.1, hours: [0, 3], water: 'deep', likes: 'beet', style: 'Long sweeps', swim: sweeps(0.6, 0.9) },
    // The boss is a sequence: it changes pattern every few seconds of the fight.
    { id: 'mossjaw', name: 'Old Mossjaw', tier: 5, size: 1.7, worth: 1, hours: [0, 4], water: 'deep', likes: 'melon', needsBait: true, style: 'Changes its mind', swim: path.sequence([[figureEight, 6], [sweeps(0.5, 0.8), 6.5], [path.warp(ribbon, (time) => time * 1.3), 6]]) },
    { id: 'sprat', name: 'Glimmer Sprat', tier: 1, worth: 0.6, via: 'net' },
    { id: 'glowfry', name: 'Glowfry', tier: 2, worth: 0.5, via: 'lantern' },
  ]);
  /** What can bite on a rod, as a spawn table over the hour of day. */
  const BITES = Kit.spawnTable(FISH.filter((fish) => fish.swim).map((fish) => ({ fish, from: fish.hours[0], until: fish.hours[1], weight: TIER.biteWeight(fish.tier - 1) })));

  /**
   * @typedef {Object} Water  A place to cast from the dock.
   * @property {string} id @property {string} name
   * @property {string} [requires]  Town project that opens it.
   * @property {number} strain      Multiplier on how fast the line frays there: deeper water pulls harder.
   * @property {string} blurb       One line for the tackle box.
   */
  /** @type {Water[] & { byId: (id: string) => Water }} */
  const WATERS = Kit.table([
    { id: 'shallows', name: 'The Shallows', strain: 1, blurb: 'Gentle water, familiar fish' },
    { id: 'deep', name: 'The Deep', requires: 'jetty', strain: 1.25, blurb: 'Rare fish that pull harder on the line' },
  ]);
  /**
   * Bait: a crop from the basket goes on the hook and is used up by the next bite. Fish that like it bite far more
   * often, the better the crop's stars the more so (index = stars; 0 unused). Some fish bite on nothing else.
   */
  const BAIT = { requires: 'tin', likedBoost: [0, 3, 5, 8] };

  // ================= TACKLE =================
  /** Starting value of every tackle stat; TACKLE rows modify them per level through Kit.stats. */
  const TACKLE_BASE = {
    ring: 1, // multiplier on the tracing ring's radius
    strain: 1, // multiplier on how fast the line frays off target
    reach: 2, // deepest fish tier a rod can hook
    foresight: 0.45, // seconds of the fish's upcoming path shown as bubbles
    rope: 7, // length of net rope per throw (panel units)
    throws: 2, // net throws per cast
    school: 7, // sprats in a school
    air: 12, // seconds of a lantern dive
    fry: 9, // glowfry in a dive
    sale: 1, // multiplier on every sale at the stall (the festival raises it)
  };
  const ROD_NAMES = ['Twig Rod', 'Willow Rod', 'Heron Rod'];
  /**
   * @typedef {Object} Tackle  A Kit.upgrades row. Level 0 of the rod is owned from the start; the others are bought.
   * @property {string} id      Also its icon sprite in ART.
   * @property {string} name    Short name for the stall shelf.
   * @property {'trace' | 'net' | 'lantern'} mode  Which minigame it plays (see cozy-fishing.js).
   * @property {(level: number) => string} title   Full name at a level.
   * @property {string} how     One line on how it plays.
   * @property {number} max @property {*} cost @property {Object} mods  As in Kit.upgrades.
   */
  /** @type {Tackle[]} */
  const TACKLE = [
    { id: 'rod', name: 'Rod', mode: 'trace', max: 2, cost: { steps: [[0, 120], [1, 2500]] }, mods: { ring: { mul: 1.12 }, strain: { mul: 0.72 }, reach: { add: 2 }, foresight: { add: 0.2 } }, title: (level) => ROD_NAMES[level], how: 'Keep the ring on the fish as it swims' },
    { id: 'net', name: 'Net', mode: 'net', max: 3, cost: { base: 35, growth: 2 }, mods: { rope: { add: 1.5 } }, title: () => 'Loop Net', how: 'Draw a loop around the school when it bunches up' },
    { id: 'lantern', name: 'Lantern', mode: 'lantern', requires: 'post', max: 3, cost: { base: 300, growth: 1.8 }, mods: { air: { add: 3 } }, title: () => 'Glow Lantern', how: 'Steer the light, lead glowfry past the snapper' },
  ];

  /** Rod tracing. Distances are panel world units unless marked px. */
  const TRACE = {
    /** Ring radius: base plus a little per unit of fish size, times the rod's ring stat. */
    tolerance: { base: 0.74, perSize: 0.16 },
    /** The ring floats this far above the fingertip (px), so a thumb never covers the fish it is tracing. */
    liftPx: 84,
    /** Seconds the fish swims unscored if the player has not touched yet. */
    graceSeconds: 3,
    /** Rate (1/s) at which the fish sprite chases its path point: darts become quick bursts instead of teleports. */
    smoothing: 8,
    /** Meter lost per second off target, as a share of the fill rate. */
    drainRate: 0.5,
    /** Line tension per second: touching but off the fish, not touching, and shed while on it. */
    strain: { off: 0.3, loose: 0.42, recover: 0.22 },
    /** Fill-rate multiplier from unbroken seconds on the fish: staying with it is worth more than dabbing at it. */
    streakBoost: [[0, 1], [1.2, 1], [3.5, 1.5]],
    /** Unbroken seconds on the fish that earn the "Steady" callout. */
    steadySeconds: 2.5,
    /** Share of its pace a fish keeps when the meter is full: it tires as you reel it in. */
    tiredPace: 0.6,
    /** A startled fish bolts: for how long, and how much faster. */
    panic: { seconds: 0.9, pace: 1.7 },
    /** Meter levels at which the fish startles. */
    startleAt: [0.4, 0.75],
    /** A jump of the path point bigger than this in one frame means a sequence changed pattern: startle. */
    patternJump: 1.2,
    /** Bubbles marking the upcoming path. */
    foresightDots: 5,
    /** Stars from accuracy (share of the fight spent on the fish). */
    stars: curve.of({ steps: [[0, 1], [0.62, 2], [0.82, 3]] }),
    /** Bonus coins per star above one, per fish tier, paid on the spot for a clean catch. */
    cleanBonus: 2,
  };
  /** Loop Net. */
  const NET = {
    seconds: 20, // time limit of a cast
    minStep: 0.16, // spacing of rope points
    closeTolerance: 2.2, // the net pulls shut a gap up to this wide between the rope's ends
    minPoints: 8, // fewer points than this is a tap or a scribble: no throw is spent
    herd: path.scale(path.circle(1, 0.6), 0.5, 0.5), // where the school's centre wanders
    spread: { tight: 0.38, swing: 0.85, breathing: 1.3 }, // the school breathes between tight and tight + swing (rad/s)
    scatter: { boost: 1.1, decay: 0.7 }, // a throw spooks the school apart for a moment
    stars: curve.of({ steps: [[0, 1], [0.55, 2], [1, 3]] }), // from the share of the school caught
    schoolByHour: curve.of({ steps: [[0, 1.3], [1, 1], [2, 0.7], [3, 0.55]] }), // sprats school up in the morning and thin out by night
    maxSchool: 9, // sprites kept for a school
  };
  /** Glow Lantern. */
  const LANTERN = {
    lampSpeed: 5.5, // how fast the lamp follows the finger
    liftShare: 0.6, // share of TRACE.liftPx the lamp floats above the finger
    lureRadius: 1.05, // glowfry this close to the lamp join the chain
    linkLength: 0.42, // spacing of the chain
    prowl: path.scale(path.lissajous(0.45, 1.5), 0.95, 0.8), // the snapper's patrol
    prowlPace: 0.8,
    bite: { lamp: 0.9, chain: 0.75, cooldown: 1.2, firstSafeSeconds: 1.5 }, // how close the snapper must come, and its rest
    scareSeconds: 1.8, // scattered fry ignore the lamp this long
    nightTint: [0.3, 0.36, 0.62], // RGB multiplier on the theatre during a dive
    stars: curve.of({ steps: [[0, 1], [0.44, 2], [0.77, 3]] }), // from the share of the fry led home
    hours: [2, 4], // glowfry only rise from dusk to dawn
  };
  /** The dock: casting and waiting for a bite. Seconds unless noted. */
  const DOCK_TIMING = {
    castSeconds: 0.55, schoolDelay: 1.1, // the bobber's flight; the pause before a net or lantern dive
    firstBite: [1.3, 2.4], nextBite: [0.9, 1.5], nibbleEvery: [0.5, 0.9], // random ranges
    hookWindow: 1.6, // how long a bite waits for the tap
    missedSeconds: 1.3, // how long the "it got away" message shows
    cardGuard: 0.6, // taps this soon after the catch card appears are ignored
  };

  // ================= FARM =================
  /**
   * @typedef {Object} Crop  A Kit.upgrades row too: its level counts the seed packets bought.
   * @property {string} id @property {string} name  Short name for the shelf. @property {string} full
   * @property {number} growSeconds  Watered seconds until ripe. @property {number} value  Coins at one star.
   */
  /** @type {Crop[]} */
  const CROPS = [
    { id: 'beet', name: 'Beet', full: 'Butterbeet', growSeconds: 45, value: 9, cost: 4 },
    { id: 'pea', name: 'Pea', full: 'Sunpea', requires: 'trellis', growSeconds: 100, value: 20, cost: 10 },
    { id: 'melon', name: 'Melon', full: 'Starmelon', requires: 'frame', growSeconds: 200, value: 44, cost: 24 },
  ];
  const CROP_TABLE = Kit.table(CROPS);
  const FARM = {
    seedsPerPacket: 2,
    pourSeconds: 1.5, // holding fills the watering gauge in this long
    sweetSpot: { range: [0.45, 0.78], bands: [0.07, 0.18] }, // where the sweet spot may sit; half-widths of gold and silver
    leafyFrom: 0.45, // share of growth at which a sprout becomes leafy
    tapReach: { harvest: 1.3, plant: 0.9 }, // how far from the row (z) a touch still counts
    tileHalfWidth: 0.5,
    pourGrades: ['', 'A bit off: bronze', 'Nice pour: silver', 'Perfect pour: gold'],
    floodedText: 'Flooded: bronze',
    pourChimes: [[0], [0], [2, 4], [2, 4, 7]], // NOTES indices rung for a pour of each star grade (index 0 unused)
  };
  /** Star ratings 1..3 (index 0 unused): sale multiplier, name and ink colour. */
  const STARS = { value: [0, 1, 1.25, 1.5], name: ['', 'Bronze', 'Silver', 'Gold'], ink: ['', '#b9713f', '#8d8a9c', '#c98a12'] };

  // ================= MARKET =================
  const MARKET = {
    orders: ['minnel', 'dapple', 'reed', 'bream', 'beet', 'pea', 'sprat'], // what Nan may ask for
    orderBonus: 2, // sale multiplier on the ordered item
    needleCyclesPerSecond: 0.48,
    sweetSpot: { range: [0.3, 0.7], bands: [0.07, 0.19] },
    /** Price multiplier and Nan's reaction by haggle grade 1..3 (index 0 unused). */
    haggle: [null, { mult: 1, text: 'Fair price' }, { mult: 1.2, text: 'Good deal: +20%' }, { mult: 1.5, text: 'Nan is delighted: +50%' }],
    soldSeconds: 1.4,
  };

  /**
   * @typedef {Object} Project  A town project: Nan collects fish, crops and coins for it, and it opens something new.
   *           Projects are Kit.upgrades rows (max 1, granted on delivery), so shop rows can `require` them.
   * @property {string} id @property {string} name
   * @property {Object<string, number>} needs  Item id (fish or crop) -> how many, of any star quality.
   * @property {number} coins     Coins it also costs.
   * @property {string} opens     What it changes, in a line.
   * @property {string} [requires]  The project that must be finished first.
   * @property {[string, number, number]} prop  What appears in the village when it is built: [sprite, x, z].
   * @property {Object} [mods]    Kit.stats modifiers it grants.
   */
  /** The long arc, in order. Each one changes how the game is played, not just a number. @type {Project[]} */
  const PROJECTS = [
    { id: 'tin', name: 'Bait Tin', max: 1, needs: { beet: 2 }, coins: 0, opens: 'Crops become bait: put one on the hook to draw the fish that like it', prop: ['rock', 1.75, 2.0] },
    { id: 'trellis', name: 'Pea Trellis', max: 1, requires: 'tin', needs: { minnel: 3, dapple: 3 }, coins: 40, opens: 'Nan stocks Sunpea seeds: bait for Reedskippers and Lantern Gups', prop: ['fence', 0.55, -2.4] },
    { id: 'post', name: 'Lantern Post', max: 1, requires: 'trellis', needs: { sprat: 12, pea: 4 }, coins: 200, opens: 'Nan stocks the Glow Lantern: a new way to fish, from dusk', prop: ['lantern', 1.45, 4.9] },
    { id: 'jetty', name: 'Long Jetty', max: 1, requires: 'post', needs: { bream: 4, reed: 4, gup: 3 }, coins: 700, opens: 'Cast into the Deep: rare fish, a harder pull', prop: ['bobber', -0.45, 4.9] },
    { id: 'frame', name: 'Melon Frame', max: 1, requires: 'jetty', needs: { pike: 3, glowfry: 16 }, coins: 2000, opens: 'Nan stocks Starmelon seeds: the only bait Old Mossjaw takes', prop: ['bush', -4.9, -2.4] },
    { id: 'bell', name: "Mossjaw's Bell", max: 1, requires: 'frame', needs: { mossjaw: 1, carplet: 3, silkeel: 3 }, coins: 6000, opens: 'The village festival: every sale pays a quarter more', prop: ['star', 0.5, -4.4], mods: { sale: { mul: 1.25 } } },
  ];
  /** Lifetime achievements (Kit.profile rows); rewards are coins. Statistics: species, goldSpecies, projects. */
  const ACHIEVEMENTS = [
    { id: 'species4', text: 'Catch 4 species', stat: 'species', target: 4, reward: 30 },
    { id: 'species8', text: 'Catch 8 species', stat: 'species', target: 8, reward: 80 },
    { id: 'species11', text: 'Catch every species', stat: 'species', target: 11, reward: 250 },
    { id: 'gold3', text: 'Land a gold-star catch of 3 species', stat: 'goldSpecies', target: 3, reward: 40 },
    { id: 'gold9', text: 'Land a gold-star catch of 9 species', stat: 'goldSpecies', target: 9, reward: 300 },
    { id: 'town', text: 'Finish every town project', stat: 'projects', target: 6, reward: 200 },
  ];

  /** The first minute's to-do list (Kit.goals rows); rewards are coins. */
  const GOALS = [
    { id: 'first', text: 'Catch a fish at the dock', event: 'catch', reward: 10 },
    { id: 'sell', text: 'Haggle a sale at the stall', event: 'sell', reward: 10 },
    { id: 'net', text: 'Buy the Loop Net', event: 'buy', when: (bought) => bought.id === 'net', reward: 15 },
    { id: 'three', text: 'Catch 3 species', event: 'catch', when: (caught) => caught.isNew, target: 3, reward: 20 },
    { id: 'order', text: "Bring Nan today's 2x order", event: 'sell', when: (sale) => sale.hadOrder, reward: 20 },
    { id: 'gold', text: 'Sell a gold-star crop', event: 'sell', when: (sale) => sale.hadGoldCrop, reward: 25 },
    { id: 'build', text: 'Bring Nan what the Bait Tin needs', event: 'project', reward: 15 },
  ];

  // ================= VILLAGE LAYOUT =================
  // World units; x is right, z is toward the camera, the pond lies in front of the village.
  const CAMERA = { fov: 30, pitch: 0.84, damping: 4, villageWidth: 10.6, depthShare: 0.62 };
  const HERO = { speed: 4.4, start: [0.5, 0.5], stepSeconds: 0.26, walkFps: 9, bounds: { minX: -5.3, maxX: 5.3, minZ: -4.6 } };
  const DOCK = { x: 0.5, width: 1.3, startZ: 1.9, endZ: 5.3, height: 0.17, planks: 7, edgeMargin: 0.1 };
  const POND = { x: 0.5, z: 7.2, radiusX: 5.8, radiusZ: 4.9, shoreMargin: 0.3 };
  const PLOT = { tilesX: [-3.9, -2.9, -1.9, -0.9], z: -2.4 };
  const STALL = { x: 2.9, z: -3 };
  /**
   * @typedef {Object} Spot  An activity spot in the village.
   * @property {string} id      The activity it starts (a state of the game's flow).
   * @property {string} tag     Text on its floating paper tag.
   * @property {string} verb    Label of its action button.
   * @property {[number, number]} at        Where the hero stands, [x, z].
   * @property {[number, number, number]} tagAt
   * @property {[number, number, number, number]} zone  [minX, maxX, minZ, maxZ]: tapping the ground here walks to `at`.
   * @property {{ width: number, focus: [number, number] }} view  Camera framing while the activity runs.
   */
  /** @type {Spot[]} */
  const SPOTS = [
    { id: 'fish', tag: 'FISH', verb: 'Cast line', at: [DOCK.x, 4.75], tagAt: [DOCK.x, 2.25, 5.0], zone: [-7, 7, 2.5, 14], view: { width: 8, focus: [DOCK.x, 5.4] } },
    { id: 'farm', tag: 'FARM', verb: 'Tend plot', at: [-2.4, -1.35], tagAt: [-2.4, 1.5, -2.7], zone: [-4.6, -0.2, -3.4, -1], view: { width: 7, focus: [-2.4, PLOT.z + 0.5] } },
    { id: 'market', tag: 'SHOP', verb: 'Trade', at: [STALL.x, -1.9], tagAt: [STALL.x, 2.25, STALL.z], zone: [1.5, 4.3, -5.4, -1.4], view: { width: 7, focus: [STALL.x - 0.4, STALL.z + 0.9] } },
  ];
  /** How close (world units) the hero must be to a spot for its button to show, and to start it on arrival. */
  const SPOT_REACH = { button: 0.6, arrive: 0.4 };
  /** Standing paper scenery: [sprite, x, z]. */
  const SCENERY = [
    ['tree', -5.2, -7.6], ['blossom', -0.1, -8.3], ['tree', 2.3, -7.8], ['pine', 4.7, -6.9], ['tree', 5.3, -4.2], ['blossom', -5.5, -4.4], ['tree', 5.2, 0.7],
    ['pine', -7.4, -1.6], ['tree', 7.8, -2.4], ['tree', -7.6, 2.6], ['blossom', 7.5, 2.4], ['pine', -8.6, -6], ['tree', 8.8, -6.4],
    ['cottage', -2.3, -6.1], ['fenceRun', -2.4, -3.3], ['stall', STALL.x, STALL.z],
    ['bush', -5, 0.5], ['bush', 1.3, -5.9], ['bush', 4.5, -1], ['rock', 2.7, 2.2], ['rock', -4.6, 2.9],
    ['reeds', -3.7, 3.6], ['reeds', -2.1, 2.7], ['reeds', 3.9, 3.1], ['reeds', 2.2, 2.55],
    ['flower', -4.6, -1], ['daisy', -0.4, -0.6], ['flower', 1.6, 0.9], ['daisy', 3.9, 1.7], ['flower', 4.6, -2.2], ['daisy', -3.2, 1.6], ['flower', -1.2, 1.5], ['daisy', 1.5, -4.3], ['flower', -5.2, -2.4],
  ];
  /** Flat ground discs for lighter grass and the dirt path: [x, z, radiusX, radiusZ, colour]. Later rows lie on top. */
  const GROUND = { grass: 0x86c35a, sand: 0xecd9a0, soilDry: 0xa87446, soilWet: 0x6f4a30, plotBed: 0xc79a62 };
  const PATCHES = [
    [-3, -5.2, 3.3, 1.5, 0x97d068], [3.7, 0.3, 2.3, 1.5, 0x97d068], [-3.9, 1.2, 1.9, 1.2, 0x7ab552], [3.5, -4.6, 2, 1.2, 0x7ab552],
    [-1.5, -4.5, 1.4, 0.55, 0xdcb984], [0.3, -3.8, 0.8, 0.9, 0xdcb984], [0.5, -2.1, 0.62, 1.3, 0xdcb984], [0.5, -0.1, 0.66, 1.3, 0xdcb984], [0.5, 1.4, 0.72, 0.9, 0xdcb984], [1.9, -1.7, 1.5, 0.5, 0xdcb984],
  ];
  /** Where the "biting now" board stands and how its fish icons are laid out. */
  const BITE_BOARD = { at: [-2.5, 0, 1.9], slots: 3, spacing: 0.72, labelUnit: 0.06, iconHeight: 0.62, iconUnit: 0.05 };

  /** Soft sounds: a pentatonic-ish run of sine notes (Hz) that chimes are picked from. */
  const NOTES = [392, 440, 523, 587, 659, 784, 880, 1047];

  // ================= RULES: pure functions over the tables =================

  /**
   * @typedef {{ kind: 'fish' | 'crop', id: string, stars: number }} Item   Something in the basket.
   * @typedef {{ crop: string, stars: number, age: number, isWet: boolean }} Tile  A planted plot tile (null when empty).
   */

  /** Coins a fish is worth at one star. @param {Fish} fish @returns {number} */
  const fishValue = (fish) => Math.round(TIER.value(fish.tier) * fish.worth);

  /**
   * Coins a basket item sells for before haggling.
   * @param {Item} item
   * @param {string} orderId  What Nan pays double for today.
   * @returns {number}
   */
  const itemValue = (item, orderId) => {
    const base = item.kind === 'fish' ? fishValue(FISH.byId(item.id)) : CROP_TABLE.byId(item.id).value;
    return Math.round(base * STARS.value[item.stars] * (item.id === orderId ? MARKET.orderBonus : 1));
  };

  /** Display name of anything Nan can order (a fish or a crop). @param {string} id @returns {string} */
  const orderName = (id) => (FISH.has(id) ? FISH.byId(id).name : CROP_TABLE.byId(id).full);

  /**
   * Where the day is at a time.
   * @param {number} seconds  Game time.
   * @returns {{ hour: number, phase: DayPhase, next: DayPhase, blend: number, night: number }} hour runs 0..4 (one per
   *          phase); blend is the eased 0..1 progress from phase to next; night is the blended night amount.
   */
  function dayAt(seconds) {
    const count = DAY.phases.length;
    const hour = ((seconds / DAY.seconds) % 1) * count;
    const index = Math.floor(hour) % count, linear = hour - Math.floor(hour);
    const blend = linear * linear * (3 - 2 * linear); // smoothstep: phases linger, then change over
    const phase = DAY.phases[index], next = DAY.phases[(index + 1) % count];
    return { hour, phase, next, blend, night: lerp(phase.night, next.night, blend) };
  }

  /**
   * @typedef {Object} Cast  The decisions behind one cast of a rod.
   * @property {number} hour    Day hour 0..4.
   * @property {number} reach   Deepest tier the rod hooks.
   * @property {string} [water='shallows']  WATERS id.
   * @property {{ id: string, stars: number } | null} [bait]  The crop on the hook, if any.
   */

  /**
   * The rod fish that can bite on a cast, rarest first, with their bite weights. This is where the systems meet:
   * the hour and the water decide who is there, the rod decides who it can hold, the bait decides who comes first.
   * @param {Cast} cast
   * @returns {{ fish: Fish, weight: number }[]} Empty when nothing there will take this rod.
   * @complexity O(f log f) for f rod fish (9): filter, map, sort.
   */
  function bitingAt({ hour, reach, water = 'shallows', bait = null }) {
    const isLiked = (fish) => !!bait && fish.likes === bait.id;
    return BITES.active(hour)
      .filter(({ fish }) => fish.water === water && fish.tier <= reach && (!fish.needsBait || isLiked(fish)))
      .map(({ fish, weight }) => ({ fish, weight: weight * (isLiked(fish) ? BAIT.likedBoost[bait.stars] : 1) }))
      .sort((a, b) => b.fish.tier - a.fish.tier);
  }

  /**
   * Roll the next bite.
   * @param {Cast} cast
   * @param {() => number} [random=Math.random]  Uniform 0..1 source (a seeded one makes simulations repeatable).
   * @returns {Fish | null} null when nothing can bite (for example a Twig Rod in the Deep).
   */
  function rollBite(cast, random = Math.random) {
    const bites = bitingAt(cast);
    const total = bites.reduce((sum, bite) => sum + bite.weight, 0);
    let roll = random() * total;
    // Walk the weights until the roll is used up; the last row also catches any floating-point remainder.
    return bites.length ? (bites.find((bite) => (roll -= bite.weight) <= 0) || bites[bites.length - 1]).fish : null;
  }

  /** Sprats in a school at an hour. @param {number} hour @param {number} schoolStat  The tackle's school stat. @returns {number} */
  const schoolSize = (hour, schoolStat) => Math.min(NET.maxSchool, Math.max(1, Math.round(schoolStat * NET.schoolByHour(hour))));

  /** Are the glowfry up at this hour? @param {number} hour @returns {boolean} */
  const isLanternHour = (hour) => hour >= LANTERN.hours[0] && hour < LANTERN.hours[1];

  /**
   * How a basket stands against a town project.
   * @param {Project} project
   * @param {Item[]} basket
   * @param {number} coins
   * @returns {{ lines: { id: string, need: number, have: number }[], isReady: boolean }} One line per needed item.
   */
  function projectStatus(project, basket, coins) {
    const lines = Object.entries(project.needs).map(([id, need]) => ({ id, need, have: Math.min(need, basket.filter((item) => item.id === id).length) }));
    return { lines, isReady: coins >= project.coins && lines.every((line) => line.have >= line.need) };
  }

  /**
   * Hand a project its items: the basket without them. The lowest-star copies go first, so the best stay to be sold.
   * @param {Project} project
   * @param {Item[]} basket
   * @returns {Item[]} A new basket.
   * @complexity O(b log b) for a basket of b items.
   */
  function deliver(project, basket) {
    const cheapestFirst = basket.map((item, index) => ({ id: item.id, stars: item.stars, index })).sort((a, b) => a.stars - b.stars);
    // Take items in that order until each need is met; `picked` remembers which basket slots were handed over.
    const picked = cheapestFirst.reduce((taken, candidate) => {
      const alreadyTaken = taken.filter((pick) => pick.id === candidate.id).length;
      return alreadyTaken < (project.needs[candidate.id] || 0) ? [...taken, candidate] : taken;
    }, []);
    const given = new Set(picked.map((pick) => pick.index));
    return basket.filter((_, index) => !given.has(index));
  }

  /**
   * Split a basket into what goes on Nan's counter and what stays with the player: the open project's needs (the
   * lowest-star copies, as deliver() will take them) and every copy of the crop chosen as bait are kept.
   * @param {Item[]} basket
   * @param {Project | null} project  The project being collected for, if any.
   * @param {string | null} baitId    Crop id set aside as bait.
   * @returns {{ toSell: Item[], kept: Item[] }}
   */
  function splitBasket(basket, project, baitId) {
    const afterProject = project ? deliver(project, basket) : basket; // what is left once the project took its share
    const toSell = afterProject.filter((item) => item.id !== baitId);
    return { toSell, kept: basket.filter((item) => !toSell.includes(item)) };
  }

  /** The town project being collected for: the first unbuilt one. @param {(id: string) => boolean} isBuilt @returns {Project | null} */
  const openProject = (isBuilt) => PROJECTS.find((project) => !isBuilt(project.id)) || null;

  /**
   * Coins for selling a basket.
   * @param {Item[]} basket
   * @param {string} orderId     What Nan pays double for.
   * @param {number} haggleGrade 1..3, from the haggle gauge.
   * @param {number} saleStat    The tackle stats' sale multiplier.
   * @returns {number}
   */
  const saleTotal = (basket, orderId, haggleGrade, saleStat) => Math.round(basket.reduce((sum, item) => sum + itemValue(item, orderId), 0) * MARKET.haggle[haggleGrade].mult * saleStat);

  /** Radius of the tracing ring for a fish. @param {Fish} fish @param {number} ringStat @returns {number} */
  const traceTolerance = (fish, ringStat) => (TRACE.tolerance.base + TRACE.tolerance.perSize * fish.size) * ringStat;

  /**
   * The Kit.touch.trace options of a rod fight: the fish's path on the panel, the ring, the meter and line rates for
   * the tackle in hand, and the fish's temper (it tires as the meter fills and bolts while it panics).
   * @param {Fish} fish
   * @param {(name: string) => number} tackleStat  Reads a tackle stat (ring, strain), e.g. stats.get.
   * @param {(point: { x: number, y: number }) => { x: number, y: number }} toPanel  Path space to panel units.
   * @param {() => boolean} isPanicking  Asked every step.
   * @param {Water} [water]  Where the cast went: deeper water frays the line faster.
   * @returns {Object} Options for Kit.touch.trace.
   */
  function traceOptions(fish, tackleStat, toPanel, isPanicking, water = WATERS.byId('shallows')) {
    return {
      target: (time) => toPanel(fish.swim(time)),
      tolerance: traceTolerance(fish, tackleStat('ring')),
      fillSeconds: TIER.fightSeconds(fish.tier),
      drainRate: TRACE.drainRate,
      strainRate: TRACE.strain.off * tackleStat('strain') * water.strain,
      looseRate: TRACE.strain.loose * tackleStat('strain') * water.strain,
      recoverRate: TRACE.strain.recover,
      smoothing: TRACE.smoothing,
      boost: curve.of(TRACE.streakBoost),
      pace: (state) => TIER.pace(fish.tier) * lerp(1, TRACE.tiredPace, state.progress * state.progress) * (isPanicking() ? TRACE.panic.pace : 1),
    };
  }

  /** Is a tile ready to harvest? @param {Tile | null} tile @returns {boolean} */
  const isRipe = (tile) => !!tile && tile.isWet && tile.age >= CROP_TABLE.byId(tile.crop).growSeconds;

  /**
   * Which sprite a plot tile shows.
   * @param {Tile | null} tile
   * @returns {string} '' for bare soil, else a key of ART: 'seeds' until watered, 'sprout', 'leafy', then the crop id.
   */
  function cropStage(tile) {
    if (!tile) return '';
    if (!tile.isWet) return 'seeds';
    if (isRipe(tile)) return tile.crop;
    return tile.age / CROP_TABLE.byId(tile.crop).growSeconds < FARM.leafyFrom ? 'sprout' : 'leafy';
  }

  /**
   * What the plot needs next, in priority order.
   * @param {(Tile | null)[]} plot
   * @param {boolean} hasSeeds
   * @returns {'harvest' | 'water' | 'plant' | 'idle'}
   */
  function nextChore(plot, hasSeeds) {
    if (plot.some(isRipe)) return 'harvest';
    if (plot.some((tile) => tile && !tile.isWet)) return 'water';
    return plot.includes(null) && hasSeeds ? 'plant' : 'idle';
  }

  /** Is a ground point on the dock's planks? @param {{ x: number, y: number }} point  y is world z. @returns {boolean} */
  const isOnDock = (point) => Math.abs(point.x - DOCK.x) < DOCK.width / 2 - DOCK.edgeMargin && point.y > DOCK.startZ - POND.shoreMargin && point.y < DOCK.endZ - DOCK.edgeMargin * 1.5;

  /**
   * Pull a ground point back to where the hero may stand: inside the village bounds and out of the water (the dock excepted).
   * @param {{ x: number, y: number }} point  Ground position; y is world z.
   * @returns {{ x: number, y: number }}
   */
  function keepOnLand(point) {
    const inBounds = { x: clamp(point.x, HERO.bounds.minX, HERO.bounds.maxX), y: Math.max(point.y, HERO.bounds.minZ) };
    if (isOnDock(inBounds)) return inBounds;
    // The pond is an ellipse; at this x its near shore is at z = centre - radiusZ * sqrt(1 - offset^2).
    const offset = clamp((inBounds.x - POND.x) / POND.radiusX, -0.999, 0.999);
    const shoreZ = POND.z - POND.radiusZ * Math.sqrt(1 - offset * offset) - POND.shoreMargin;
    return { x: inBounds.x, y: Math.min(inBounds.y, shoreZ) };
  }

  /** The spot whose tap zone contains a ground point, if any. @param {number} x @param {number} z @returns {Spot | undefined} */
  const spotInZone = (x, z) => SPOTS.find(({ zone: [minX, maxX, minZ, maxZ] }) => x > minX && x < maxX && z > minZ && z < maxZ);

  /** The spot within `reach` of a position, if any. @returns {Spot | undefined} */
  const spotNear = (x, z, reach) => SPOTS.find((spot) => Math.hypot(x - spot.at[0], z - spot.at[1]) < reach);

  window.Cozy = {
    data: {
      PALETTE, ART, DAY, TIER, FISH, BITES, WATERS, BAIT, PROJECTS, ACHIEVEMENTS, TACKLE_BASE, TACKLE, TRACE, NET, LANTERN, DOCK_TIMING, CROPS, CROP_TABLE, FARM, STARS, MARKET, GOALS,
      CAMERA, HERO, DOCK, POND, PLOT, STALL, SPOTS, SPOT_REACH, SCENERY, GROUND, PATCHES, BITE_BOARD, NOTES,
    },
    rules: { fishValue, itemValue, orderName, dayAt, bitingAt, rollBite, schoolSize, isLanternHour, projectStatus, deliver, splitBasket, openProject, saleTotal, traceTolerance, traceOptions, isRipe, cropStage, nextChore, isOnDock, keepOnLand, spotInZone, spotNear },
  };
})();
