/**
 * Sky Stack rules: every table and every rule of the game as plain data and pure functions. No DOM, no THREE - it runs in node,
 * which is how scratch/stack/sim.js plays hours of it headlessly to check the pacing.
 *
 * Owns: slab, slide, difficulty, scoring, streak, brace, slab-kind, blueprint, charter, milestone, zone and progression tables; the
 *       rules that read them (judge a drop, settle it into the run tally, pick a slab kind, record a run on the profile).
 * Does not own: anything drawn or heard (games/stack.js), interval slicing (Kit.span), row blending (Kit.blend), modifiers and
 *       blueprints as models (Kit.stats, Kit.upgrades), the permanent record (Kit.profile).
 *
 * DEPTH PLAN
 *   Seconds - mastery, shown three ways on one tap:
 *     accuracy  inside the perfect window the slab snaps, keeps its width and builds the streak (multiplier, regrowth, braces);
 *     precision the inner third of that window is FLAWLESS: more points and two steps of streak instead of one;
 *     nerve     a perfect drop on the slab's first pass is SWIFT (x1.5); waiting for another pass is safer and pays less.
 *   Minutes - decisions: every milestone terrace offers two BLUEPRINTS and the player keeps one for the run. Each trades something
 *     (faster slide for more points, fewer points for triple regrowth, glass slabs for triple points that can shatter and chip the tower) and they
 *     multiply or cover for each other through shared modifiers, so two towers of the same height are built differently.
 *   Hours - the long arc (Kit.profile): score becomes experience; levels and lifetime achievements unlock further blueprints (new
 *     rules to combine) and CHARTERS (ways to play a whole run: a gale, a glasshouse, a needle-thin spire) that are harder and pay
 *     more experience, so difficulty grows with the player. Unlock times are measured by scratch/stack/sim.js, not asserted.
 */
(() => {
  // ================================================== TABLES ==================================================

  /** Slab dimensions, in world units. The base width is a modifier (a charter may narrow the tower). */
  const SLAB = {
    HEIGHT: 0.8,
    MAX_WIDTH: 4.9, // terraces and broad slabs may overhang up to here
    MIN_KEEP: 0.05, // an overlap thinner than this is a miss, so a sliver never becomes a floor
    MIN_WIDTH: 0.3, // chipping never narrows a floor below this
  };

  /** How the moving slab travels. */
  const SLIDE = {
    ROUNDING: 0.96, // 1 = pure triangle wave; lower rounds the turnaround so the slab eases at each end instead of snapping back
    START_PHASE: -Math.PI / 2, // every slab enters from the far side and slides toward the camera
    FIRST_TURN_PHASE: Math.PI / 2, // the near end of the slide: a drop before this is on the first pass
    TAP_LOCKOUT_SECS: 0.25, // ignore taps this soon after a spawn, so a double tap cannot throw the next slab away
  };

  /**
   * Difficulty by floor, as Kit.curve ramps: slide speed (units/s), slide half-range (units), perfect tolerance (units) and how strongly
   * the slab lights up while lined up (0..1, a timing cue that fades out as the player learns).
   * The perfect window is 2 * tolerance / speed seconds: about 330 ms at the start, 170 ms at floor 10, 90 ms at floor 40.
   * Until floor 10 the range stays below the standard base width, so a full-width slab cannot miss the tower outright.
   */
  const DIFFICULTY = {
    speed: [[0, 2.2], [4, 2.6], [10, 3.0], [20, 4.0], [30, 4.9], [40, 5.6], [80, 8.0]],
    range: [[0, 3.0], [4, 3.6], [10, 4.2], [20, 4.8], [40, 5.4]],
    tolerance: [[0, 0.36], [4, 0.31], [10, 0.26], [20, 0.21], [40, 0.17], [80, 0.14]],
    cue: [[0, 1], [4, 0.8], [10, 0.3], [20, 0]],
  };

  /** Points per landing by how well it was placed, and the multiplier tiers by perfect streak ([streak, multiplier] steps). */
  const SCORE = { LANDED: 10, PERFECT: 20, FLAWLESS: 35, SWIFT_SCALE: 1.5, MULTIPLIER: { steps: [[0, 1], [3, 1.5], [6, 2], [10, 3], [15, 4]] } };

  /** The second, tighter timing window. */
  const PRECISION = {
    FLAWLESS_SHARE: 0.35, // fraction of the perfect tolerance that counts as flawless
    FLAWLESS_STREAK: 2, // streak steps a flawless drop is worth (a perfect is worth 1)
  };

  /** Perfect-streak regrowth: streaks this long widen the slab back toward the base width, this many units per drop. */
  const STREAK = { REGROW_FROM: 3, REGROW_WIDTH: 0.25 };

  /**
   * The numbers blueprints and charters may change, with their standard values. Read through Kit.stats, so every change is a keyed
   * modifier. A brace is a second chance: a slab that misses the tower entirely swings back for another try instead of ending the run.
   * @typedef {Object} Modifiers
   * @property {number} baseWidth        width of the first floor and the limit of regrowth, world units
   * @property {number} difficultyShift  floors added to the floor index when reading DIFFICULTY
   * @property {number} initialBraces    braces in hand at the start (the first is free so the opening is forgiving)
   * @property {number} braceCapacity    most braces that can be held
   * @property {number} perfectsPerBrace streak steps that earn one brace
   * @property {number} slideSpeed       scale on slide speed
   * @property {number} slideRange       scale on slide half-range
   * @property {number} tolerance        scale on the perfect tolerance
   * @property {number} scoreScale       scale on all points
   * @property {number} landedScale      scale on points for an imperfect landing
   * @property {number} flawlessScale    scale on points for a flawless landing
   * @property {number} regrowWidth      scale on STREAK.REGROW_WIDTH
   * @property {number} broadEvery       a broad slab every this many floors
   * @property {number} glassEvery       a glass slab every this many floors
   */
  /** @type {Modifiers} */
  const BASE_MODIFIERS = {
    baseWidth: 4.2, difficultyShift: 0, initialBraces: 1, braceCapacity: 2, perfectsPerBrace: 5,
    slideSpeed: 1, slideRange: 1, tolerance: 1, scoreScale: 1, landedScale: 1, flawlessScale: 1, regrowWidth: 1,
    broadEvery: 6, glassEvery: 9,
  };

  /**
   * @typedef {Object} SlabKind
   * @property {string} id
   * @property {string} label        shown when the slab appears ('' = no announcement)
   * @property {number} from         first floor this kind may appear on
   * @property {?string} everyStat   name of the Modifiers field holding its rhythm (null = every floor); a rhythm, not a random
   *                                 roll, so the player can learn it and plan around it
   * @property {number} extraWidth   units added along the slide axis; kept only on a perfect drop
   * @property {number} scoreScale   points multiplier
   * @property {number} shatterBelow kept fraction (0..1) under which an imperfect drop breaks the slab instead of landing it
   * @property {number} shatterChip  units the floor below loses on the slide axis when the slab shatters on it: without a cost,
   *                                 fragile slabs would protect the tower from bad drops (the simulation showed exactly that)
   * @property {number} opacity      1 = solid
   * @property {number} whiten       0..1 mix of the floor colour toward white
   */
  /** Slab kinds; later rows win when two fall on the same floor. @type {SlabKind[]} */
  const SLAB_KINDS = Kit.table([
    { id: 'plain', label: '', from: 1, everyStat: null, extraWidth: 0, scoreScale: 1, shatterBelow: 0, shatterChip: 0, opacity: 1, whiten: 0 },
    { id: 'broad', label: 'Broad slab', from: 6, everyStat: 'broadEvery', extraWidth: 0.7, scoreScale: 1, shatterBelow: 0, shatterChip: 0, opacity: 1, whiten: 0.1 },
    { id: 'glass', label: 'Glass slab x3', from: 9, everyStat: 'glassEvery', extraWidth: 0, scoreScale: 3, shatterBelow: 0.75, shatterChip: 0.35, opacity: 0.62, whiten: 0.6 },
  ]);

  /**
   * Blueprints: run-long choices offered at milestones (Kit.upgrades rows; `mods` are Kit.stats modifier specs on Modifiers fields).
   * None is strictly better: each pays for what it gives. `isLocked` rows join the pool once the profile unlocks their id.
   * @typedef {Object} Blueprint
   * @property {string} id
   * @property {string} name
   * @property {string} desc
   * @property {number} max           copies that can be held (1: a run collects different blueprints, not stacks of one)
   * @property {Object} mods          Kit.stats modifier spec
   * @property {number} [grantBraces] braces handed over at once when picked
   * @property {boolean} [isLocked]
   * @property {string} color         CSS colour of the offer card's edge
   */
  /** @type {Blueprint[]} */
  const BLUEPRINTS = Kit.table([
    { id: 'gale', name: 'Gale lines', desc: 'Slide 15% faster. All points x1.5.', max: 1, color: '#9fe8ff', mods: { slideSpeed: { mul: 1.15 }, scoreScale: { mul: 1.5 } } },
    { id: 'calm', name: 'Still air', desc: 'Slide 12% slower. All points x0.8.', max: 1, color: '#c8d4ff', mods: { slideSpeed: { mul: 0.88 }, scoreScale: { mul: 0.8 } } },
    { id: 'mason', name: 'Master mason', desc: 'Regrowth tripled. All points x0.9.', max: 1, color: '#ffd27a', mods: { regrowWidth: { mul: 3 }, scoreScale: { mul: 0.9 } } },
    { id: 'rigger', name: 'Rigger', desc: 'One brace now and room for one more. Each brace takes 2 more perfects.', max: 1, color: '#ffa62e', isLocked: true, grantBraces: 1, mods: { braceCapacity: { add: 1 }, perfectsPerBrace: { add: 2 } } },
    { id: 'needle', name: 'Needlework', desc: 'Flawless drops pay double. Imperfect landings pay nothing.', max: 1, color: '#ffffff', isLocked: true, mods: { flawlessScale: { mul: 2 }, landedScale: { mul: 0 } } },
    // 9 * (4 / 9) = a glass slab every 4 floors instead of every 9.
    { id: 'glazier', name: 'Glazier', desc: 'Every fourth slab is glass: triple points, but a poor drop shatters it and chips the floor below.', max: 1, color: '#bfe9ff', isLocked: true, mods: { glassEvery: { mul: 4 / 9 } } },
    { id: 'cantilever', name: 'Cantilever', desc: 'Every third slab is broad. The slide runs 15% wider.', max: 1, color: '#b9a4ff', isLocked: true, mods: { broadEvery: { mul: 0.5 }, slideRange: { mul: 1.15 } } },
  ]);

  /**
   * Charters: ways to play a whole run, chosen before it starts. Later charters are harder and pay more experience.
   * @typedef {Object} Charter
   * @property {string} id
   * @property {string} name
   * @property {string} desc
   * @property {number} experienceScale  scale on the experience a run earns
   * @property {Partial<Modifiers>} modifiers  replaces the standard value of each field it names
   * @property {boolean} [isLocked]
   */
  /** @type {Charter[]} */
  const CHARTERS = Kit.table([
    { id: 'standard', name: 'Open Sky', desc: 'The classic climb.', experienceScale: 1, modifiers: {} },
    { id: 'galeSeason', name: 'Gale Season', desc: 'The slide starts twelve floors faster. Experience x1.6.', experienceScale: 1.6, isLocked: true, modifiers: { difficultyShift: 12 } },
    { id: 'glasshouse', name: 'Glasshouse', desc: 'Every second slab is glass for triple points. One brace at most, none to start. Experience x0.8.', experienceScale: 0.8, isLocked: true, modifiers: { glassEvery: 2, initialBraces: 0, braceCapacity: 1 } },
    { id: 'spire', name: 'Needle Spire', desc: 'A narrow tower and no free brace. Experience x1.5.', experienceScale: 1.5, isLocked: true, modifiers: { baseWidth: 3, initialBraces: 0 } },
  ]);

  /** Experience needed per account level (Kit.curve spec indexed by levels already gained). Tuned with scratch/stack/sim.js. */
  const LEVEL_CURVE = { base: 4000, growth: 1.3 };

  /** What reaching an account level unlocks (ids of BLUEPRINTS or CHARTERS rows). */
  const LEVEL_UNLOCKS = [
    { level: 3, unlocks: 'rigger' },
    { level: 6, unlocks: 'galeSeason' },
    { level: 9, unlocks: 'glasshouse' },
  ];

  /** Lifetime achievements (Kit.profile rows): each watches one statistic recorded by recordRun and unlocks a blueprint or charter. */
  const ACHIEVEMENTS = [
    { id: 'steadyHand', text: 'Land 150 flawless drops', stat: 'flawless', target: 150, unlocks: 'needle' },
    { id: 'glassworks', text: 'Land 120 glass slabs', stat: 'glassLanded', target: 120, unlocks: 'glazier' },
    { id: 'terraced', text: 'Build 120 terraces', stat: 'terraces', target: 120, unlocks: 'cantilever' },
    { id: 'highRise', text: 'Reach floor 60', stat: 'bestFloor', target: 60, unlocks: 'spire' },
  ];

  /** Milestone floors: the landed floor widens into a golden terrace that stays in the tower, and a blueprint is offered. */
  const MILESTONES = [
    { floor: 8, name: 'Sky terrace', widen: 0.7 },
    { floor: 16, name: 'Observation deck', widen: 0.7 },
    { floor: 26, name: 'Star dock', widen: 0.8 },
    { floor: 40, name: 'Halo ring', widen: 0.9 },
    { floor: 56, name: 'Zenith', widen: 1 },
  ];
  const BLUEPRINTS_OFFERED = 2;

  /**
   * @typedef {Object} Zone
   * @property {string} id
   * @property {string} name
   * @property {number} from       first floor of the zone; the look blends in over ZONE_BLEND_FLOORS from here
   * @property {number} skyTop     0xRRGGBB
   * @property {number} skyBottom  0xRRGGBB (also the fog colour)
   * @property {number} sunColor   0xRRGGBB
   * @property {number} clouds     0..1 opacity weights of each scenery layer
   * @property {number} stars
   * @property {number} motes
   * @property {number} moon
   * @property {number} aurora
   * @property {number} ambient    hemisphere light intensity
   * @property {number} sun        sun light intensity
   */
  /**
   * Altitude zones. A slab takes about 1.4 s, so the first two changes (floors 5 and 11) fall inside the first twenty seconds of play.
   * @type {Zone[]}
   */
  const ZONES = Kit.table([
    { id: 'dusk', name: 'Dusk City', from: 0, skyTop: 0x2b2c78, skyBottom: 0xf09a78, sunColor: 0xffc79a, clouds: 0, stars: 0.2, motes: 0.5, moon: 0, aurora: 0, ambient: 0.75, sun: 1.25 },
    { id: 'clouds', name: 'Cloud Deck', from: 5, skyTop: 0x4f9bea, skyBottom: 0xcfe6ff, sunColor: 0xfff3dd, clouds: 1, stars: 0, motes: 0.15, moon: 0, aurora: 0, ambient: 0.95, sun: 1.2 },
    { id: 'strato', name: 'Stratosphere', from: 11, skyTop: 0x0d1a52, skyBottom: 0x4274d0, sunColor: 0xe2eaff, clouds: 0.3, stars: 0.45, motes: 0.4, moon: 0, aurora: 0, ambient: 0.75, sun: 1.15 },
    { id: 'stars', name: 'Starfield', from: 19, skyTop: 0x03030f, skyBottom: 0x1c1656, sunColor: 0xc2c8ff, clouds: 0, stars: 1, motes: 0.9, moon: 1, aurora: 0, ambient: 0.6, sun: 1.05 },
    { id: 'aurora', name: 'Aurora Void', from: 29, skyTop: 0x040817, skyBottom: 0x145a5a, sunColor: 0xb4ffe4, clouds: 0, stars: 1, motes: 1, moon: 0.6, aurora: 1, ambient: 0.65, sun: 1 },
  ]);
  const ZONE_BLEND_FLOORS = 3;
  const ZONE_COLOR_FIELDS = ['skyTop', 'skyBottom', 'sunColor'];

  /** Slab colours: a slow hue walk up the tower, plus the accents. */
  const PALETTE = { HUE_START: 0.56, HUE_PER_FLOOR: 0.016, SATURATION: 0.66, LIGHTNESS: 0.6, GOLD: 0xffd27a, WHITE: 0xffffff };

  /** The slide axes: which footprint fields a slab moves and is cut along. */
  const AXES = {
    x: { center: 'centerX', size: 'sizeX', unitX: 1, unitZ: 0 },
    z: { center: 'centerZ', size: 'sizeZ', unitX: 0, unitZ: 1 },
  };

  // ================================================== RULES ==================================================

  /**
   * A rectangle on the ground plane.
   * @typedef {{ centerX: number, centerZ: number, sizeX: number, sizeZ: number }} Footprint
   */
  /**
   * A slab that has landed. `mesh` is attached by the view and ignored by the rules.
   * @typedef {Footprint & { index: number, y: number, color: number, kind: SlabKind, mesh?: Object }} Floor
   */
  /**
   * The slab in flight.
   * @typedef {Footprint & { index: number, y: number, color: number, kind: SlabKind, axis: 'x'|'z', phase: number, offset: number,
   *   age: number, difficulty: { speed: number, range: number, tolerance: number, cue: number }, mesh?: Object }} Slider
   */
  /**
   * The score sheet of a run: everything the rules need to carry from one drop to the next.
   * @typedef {{ floors: number, streak: number, longestStreak: number, score: number, braces: number, perfects: number, flawless: number,
   *   swift: number, glassLanded: number, terraces: number, isOver: boolean }} Tally
   */

  /** Applies `transform(value, key)` to every value of an object, keeping the keys. */
  const mapValues = (object, transform) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));

  const DIFFICULTY_CURVES = mapValues(DIFFICULTY, Kit.curve.of);

  /** @param {number} streak @returns {number} score multiplier for a streak of perfect drops */
  const multiplierAt = Kit.curve.of(SCORE.MULTIPLIER);

  /** @param {number} floors altitude in floors (fractional) @returns {Zone} the blended look at that altitude */
  const lookAt = Kit.blend.along(ZONES, { key: 'from', span: ZONE_BLEND_FLOORS, colors: ZONE_COLOR_FIELDS });

  /** @param {number} floorIndex @returns {number} index into ZONES of the zone that floor belongs to */
  const zoneIndexAt = (floorIndex) => ZONES.reduce((found, zone, index) => (floorIndex >= zone.from ? index : found), 0);

  /** @param {number} floorIndex @returns {number} 0xRRGGBB, one step further round the hue wheel per floor */
  const slabColor = (floorIndex) => Kit.blend.hsl(PALETTE.HUE_START + floorIndex * PALETTE.HUE_PER_FLOOR, PALETTE.SATURATION, PALETTE.LIGHTNESS);

  /** @param {number} floorIndex @returns {?Object} the MILESTONES row for that floor, if it is one */
  const milestoneAt = (floorIndex) => MILESTONES.find((milestone) => milestone.floor === floorIndex) || null;

  /**
   * The modifier model of a run: standard values, overridden by the charter; blueprints then add keyed modifiers on top.
   * @param {Charter} charter
   * @returns {Object} a Kit.stats model
   */
  const createModifierStats = (charter) => Kit.stats({ ...BASE_MODIFIERS, ...charter.modifiers });

  /**
   * Snapshots the current value of every modifier (rules take this plain object, never the model).
   * @param {{ get(name: string): number }} stats from createModifierStats
   * @returns {Modifiers}
   */
  const readModifiers = (stats) => mapValues(BASE_MODIFIERS, (_, name) => stats.get(name));

  /**
   * @param {number} floorIndex floor the slab is headed for
   * @param {Modifiers} modifiers
   * @returns {SlabKind} the last row whose rhythm lands on this floor
   */
  function kindForFloor(floorIndex, modifiers) {
    const isDue = (kind) => {
      const every = kind.everyStat ? Math.max(1, Math.round(modifiers[kind.everyStat])) : 1;
      return floorIndex >= kind.from && (floorIndex - kind.from) % every === 0;
    };
    return SLAB_KINDS.filter(isDue).pop() || SLAB_KINDS.byId('plain');
  }

  /**
   * Difficulty for the slab above `floorIndex`: the curves, shifted by the charter and scaled by the blueprints.
   * @param {number} floorIndex
   * @param {Modifiers} modifiers
   * @returns {{ speed: number, range: number, tolerance: number, cue: number }}
   */
  function difficultyAt(floorIndex, modifiers) {
    const base = mapValues(DIFFICULTY_CURVES, (curve) => curve(floorIndex + modifiers.difficultyShift));
    return { ...base, speed: base.speed * modifiers.slideSpeed, range: base.range * modifiers.slideRange, tolerance: base.tolerance * modifiers.tolerance };
  }

  /**
   * Position of the slab along its slide: a triangle wave between -range and +range whose turnarounds are rounded off.
   * asin(K sin(phase)) is a triangle wave for K = 1 and a sine for small K; dividing by asin(K) keeps the peaks at +-range.
   * @param {number} phase radians
   * @param {number} range half-width of the slide, world units
   * @returns {number} offset from the tower centre, world units
   */
  const slideOffset = (phase, range) => (range * Math.asin(SLIDE.ROUNDING * Math.sin(phase))) / Math.asin(SLIDE.ROUNDING);

  /**
   * Phase advance per second that makes the slab cross the centre at `speed` units per second (the derivative of slideOffset at 0).
   * @param {number} speed units/s
   * @param {number} range units
   * @returns {number} radians/s
   */
  const slidePhaseRate = (speed, range) => (speed * Math.asin(SLIDE.ROUNDING)) / (SLIDE.ROUNDING * range);

  /**
   * Seconds from a slab's spawn until it crosses the centre for the n-th time (a quarter period, then half a period per extra pass).
   * @param {{ speed: number, range: number }} difficulty
   * @param {number} pass 1 = the first crossing
   * @returns {number} seconds
   */
  const secondsToPass = (difficulty, pass) => ((pass - 0.5) * Math.PI) / slidePhaseRate(difficulty.speed, difficulty.range);

  /** @param {number} baseWidth world units @returns {Floor} the floor every tower starts on */
  const createBaseFloor = (baseWidth) => ({ index: 0, y: 0, color: slabColor(0), kind: SLAB_KINDS.byId('plain'), centerX: 0, centerZ: 0, sizeX: baseWidth, sizeZ: baseWidth });

  /**
   * The next slab, waiting at the far end of its slide above `top`.
   * @param {Floor} top
   * @param {SlabKind} kind
   * @param {Modifiers} modifiers
   * @returns {Slider}
   */
  function createSlider(top, kind, modifiers) {
    const index = top.index + 1, axis = index % 2 ? 'x' : 'z', difficulty = difficultyAt(top.index, modifiers);
    const { size } = AXES[axis];
    return {
      index, kind, axis, difficulty,
      y: top.y + SLAB.HEIGHT,
      color: Kit.blend.hex(slabColor(index), PALETTE.WHITE, kind.whiten),
      centerX: top.centerX, centerZ: top.centerZ, sizeX: top.sizeX, sizeZ: top.sizeZ,
      [size]: Math.min(SLAB.MAX_WIDTH, top[size] + kind.extraWidth),
      phase: SLIDE.START_PHASE, offset: slideOffset(SLIDE.START_PHASE, difficulty.range), age: 0,
    };
  }

  /**
   * Advances the slide by one frame.
   * @param {Slider} slider
   * @param {number} dt seconds
   * @returns {Slider} a new slider (the input is not changed)
   */
  function stepSlider(slider, dt) {
    const { speed, range } = slider.difficulty;
    const phase = slider.phase + slidePhaseRate(speed, range) * dt;
    return { ...slider, phase, offset: slideOffset(phase, range), age: slider.age + dt };
  }

  /** @param {Slider} slider @returns {Slider} the same slab back at the far end of its slide (a brace caught it) */
  const rewindSlider = (slider) => ({ ...slider, phase: SLIDE.START_PHASE, offset: slideOffset(SLIDE.START_PHASE, slider.difficulty.range), age: 0 });

  /** @param {Slider} slider @returns {boolean} true while a drop right now would be perfect */
  const isLinedUp = (slider) => Math.abs(slider.offset) <= slider.difficulty.tolerance;

  /**
   * How well the slider would land if released now: Kit.span.slice along the slide axis, mapped back to footprints, plus the
   * two extra timing judgements (flawless, swift).
   * @param {Floor} top
   * @param {Slider} slider
   * @returns {{ isPerfect: boolean, isFlawless: boolean, isSwift: boolean, isMiss: boolean, isShattered: boolean,
   *   footprint: Footprint | null, cuts: (Footprint & { side: -1 | 1 })[] }}
   *   footprint: where the kept part lands; cuts: the parts that fall away (the whole slab on a miss)
   */
  function judgeDrop(top, slider) {
    const { center, size } = AXES[slider.axis], { tolerance } = slider.difficulty;
    const piece = { center: top[center] + slider.offset, size: slider[size] };
    const sliced = Kit.span.slice(piece, { center: top[center], size: top[size] }, { tolerance, minKeep: SLAB.MIN_KEEP });
    // The cross axis is untouched by the cut: only the slide axis fields are replaced.
    const onSlideAxis = (span) => ({ centerX: slider.centerX, centerZ: slider.centerZ, sizeX: slider.sizeX, sizeZ: slider.sizeZ, [center]: span.center, [size]: span.size });
    const isShattered = !sliced.isPerfect && sliced.keptFraction < slider.kind.shatterBelow;
    return {
      isPerfect: sliced.isPerfect,
      isFlawless: Math.abs(slider.offset) <= tolerance * PRECISION.FLAWLESS_SHARE,
      isSwift: sliced.isPerfect && slider.phase < SLIDE.FIRST_TURN_PHASE,
      isShattered,
      isMiss: sliced.isMiss && !isShattered,
      footprint: sliced.kept && onSlideAxis(sliced.kept),
      cuts: sliced.cuts.map((cut) => ({ ...onSlideAxis(cut), side: cut.side })),
    };
  }

  /**
   * Widens a footprint evenly on both axes, never past `limit` and never shrinking what is already wider.
   * @param {Footprint} footprint
   * @param {number} amount units added to each size
   * @param {number} limit widest size this may grow to
   * @returns {Footprint}
   */
  function widen(footprint, amount, limit) {
    const grow = (size) => Math.max(size, Math.min(limit, size + amount));
    return { ...footprint, sizeX: grow(footprint.sizeX), sizeZ: grow(footprint.sizeZ) };
  }

  /**
   * @param {{ isPerfect: boolean, isFlawless: boolean, isSwift: boolean }} judged
   * @param {number} streak perfect streak including this drop
   * @param {SlabKind} kind
   * @param {Modifiers} modifiers
   * @returns {number} points for the landing
   */
  function pointsFor(judged, streak, kind, modifiers) {
    const placement = judged.isFlawless ? SCORE.FLAWLESS * modifiers.flawlessScale : judged.isPerfect ? SCORE.PERFECT : SCORE.LANDED * modifiers.landedScale;
    return Math.round(placement * kind.scoreScale * multiplierAt(streak) * modifiers.scoreScale * (judged.isSwift ? SCORE.SWIFT_SCALE : 1));
  }

  /**
   * @param {number} streakBefore
   * @param {number} streakAfter
   * @param {Modifiers} modifiers
   * @returns {number} braces earned by a streak rising from one value to the other (a flawless drop can cross a threshold mid-step)
   */
  function bracesEarnedBetween(streakBefore, streakAfter, modifiers) {
    const perBrace = Math.max(1, Math.round(modifiers.perfectsPerBrace));
    return Math.max(0, Math.floor(streakAfter / perBrace) - Math.floor(streakBefore / perBrace));
  }

  /** @param {Modifiers} modifiers @returns {Tally} the score sheet at the start of a run */
  const createTally = (modifiers) => ({
    floors: 0, streak: 0, longestStreak: 0, score: 0, braces: Math.min(modifiers.initialBraces, modifiers.braceCapacity),
    perfects: 0, flawless: 0, swift: 0, glassLanded: 0, terraces: 0, isOver: false,
  });

  /**
   * Names the consequence of a judged drop.
   * @param {{ isMiss: boolean, isShattered: boolean }} judged
   * @param {number} braces braces in hand
   * @returns {'shatter' | 'brace' | 'fall' | 'land'}
   */
  function resolutionOf(judged, braces) {
    if (judged.isShattered) return 'shatter';
    if (!judged.isMiss) return 'land';
    return braces > 0 ? 'brace' : 'fall';
  }

  /**
   * How each resolution changes the tally. Each returns the new tally plus what the landing produced (land only).
   * @type {Record<string, (tally: Tally, slider: Slider, judged: Object, modifiers: Modifiers) => Object>}
   */
  const SETTLEMENTS = {
    /** A fragile slab dropped badly breaks up: no new floor, the streak ends and the floor below is chipped narrower on the slide axis. */
    shatter(tally, slider, judged, modifiers, top) {
      const { size } = AXES[slider.axis];
      return { tally: { ...tally, streak: 0 }, chippedTop: { ...top, [size]: Math.max(SLAB.MIN_WIDTH, top[size] - slider.kind.shatterChip) } };
    },
    /** A brace catches a slab that missed entirely; it costs the brace and the streak. */
    brace: (tally) => ({ tally: { ...tally, braces: tally.braces - 1, streak: 0 } }),
    /** No overlap and no brace: the run ends. */
    fall: (tally) => ({ tally: { ...tally, isOver: true } }),
    land(tally, slider, judged, modifiers) {
      const streakSteps = judged.isFlawless ? PRECISION.FLAWLESS_STREAK : 1;
      const streak = judged.isPerfect ? tally.streak + streakSteps : 0;
      const braces = Math.min(modifiers.braceCapacity, tally.braces + bracesEarnedBetween(tally.streak, streak, modifiers));
      const milestone = milestoneAt(slider.index);
      const isRegrowing = judged.isPerfect && streak >= STREAK.REGROW_FROM;
      const regrown = isRegrowing ? widen(judged.footprint, STREAK.REGROW_WIDTH * modifiers.regrowWidth, modifiers.baseWidth) : judged.footprint;
      const footprint = milestone ? widen(regrown, milestone.widen, SLAB.MAX_WIDTH) : regrown;
      const points = pointsFor(judged, streak, slider.kind, modifiers);
      return {
        points,
        milestone,
        bracesEarned: braces - tally.braces,
        hasRegrown: regrown !== judged.footprint && regrown.sizeX + regrown.sizeZ > judged.footprint.sizeX + judged.footprint.sizeZ,
        floor: { ...footprint, index: slider.index, y: slider.y, kind: slider.kind, color: milestone ? PALETTE.GOLD : slider.color },
        tally: {
          ...tally, streak, braces,
          floors: slider.index,
          longestStreak: Math.max(tally.longestStreak, streak),
          score: tally.score + points,
          perfects: tally.perfects + (judged.isPerfect ? 1 : 0),
          flawless: tally.flawless + (judged.isPerfect && judged.isFlawless ? 1 : 0),
          swift: tally.swift + (judged.isSwift ? 1 : 0),
          glassLanded: tally.glassLanded + (slider.kind.id === 'glass' ? 1 : 0),
          terraces: tally.terraces + (milestone ? 1 : 0),
        },
      };
    },
  };

  /**
   * The whole rule of a tap: judge the drop and settle it into the run. Shared by the game and the headless simulation.
   * @param {Tally} tally
   * @param {Floor} top
   * @param {Slider} slider
   * @param {Modifiers} modifiers
   * @returns {{ resolution: 'shatter' | 'brace' | 'fall' | 'land', judged: Object, tally: Tally, floor?: Floor, chippedTop?: Floor, points?: number,
   *   milestone?: Object | null, bracesEarned?: number, hasRegrown?: boolean }}
   */
  function settleDrop(tally, top, slider, modifiers) {
    const judged = judgeDrop(top, slider), resolution = resolutionOf(judged, tally.braces);
    return { resolution, judged, ...SETTLEMENTS[resolution](tally, slider, judged, modifiers, top) };
  }

  /**
   * Applies the one-off part of picking a blueprint (its modifiers are applied by Kit.upgrades).
   * @param {Tally} tally
   * @param {Blueprint} blueprint
   * @param {Modifiers} modifiers as they stand after the pick
   * @returns {Tally}
   */
  const applyBlueprintPick = (tally, blueprint, modifiers) => ({ ...tally, braces: Math.min(modifiers.braceCapacity, tally.braces + (blueprint.grantBraces || 0)) });

  // ---- the long arc ----

  /** Every unlockable row by id, for names in unlock messages. */
  const UNLOCKABLES = Kit.table([...BLUEPRINTS, ...CHARTERS].filter((row) => row.isLocked).map((row) => ({ ...row, type: BLUEPRINTS.has(row.id) ? 'Blueprint' : 'Charter' })));

  /**
   * The player's permanent record, wired so that reaching a level unlocks its LEVEL_UNLOCKS rows.
   * @param {{ get: Function, set: Function }} [save] ctx.save; omit for an in-memory profile (simulation)
   * @returns {Object} a Kit.profile
   */
  function createProfile(save) {
    const profile = Kit.profile({
      save, achievements: ACHIEVEMENTS, levelCurve: LEVEL_CURVE,
      onLevel: (level) => LEVEL_UNLOCKS.filter((row) => row.level === level).forEach((row) => profile.unlock(row.unlocks)),
    });
    return profile;
  }

  /** @param {Object} profile @returns {(row: { id: string, isLocked?: boolean }) => boolean} true for rows this player may use */
  const isAvailableTo = (profile) => (row) => !row.isLocked || profile.isUnlocked(row.id);

  /**
   * @param {Object} profile
   * @param {string} wantedId the charter the player last chose
   * @returns {Charter} that charter if it is available, otherwise the standard one
   */
  const charterFor = (profile, wantedId) => CHARTERS.filter(isAvailableTo(profile)).find((charter) => charter.id === wantedId) || CHARTERS.byId('standard');

  /**
   * Writes a finished run into the profile: lifetime counters, bests, experience and the run history.
   * @param {Object} profile a Kit.profile from createProfile
   * @param {Tally} tally
   * @param {Charter} charter
   * @returns {{ experience: number, levelsGained: number, unlocked: Object[] }} unlocked: UNLOCKABLES rows this run opened
   */
  function recordRun(profile, tally, charter) {
    const before = new Set(profile.unlocked());
    ['floors', 'perfects', 'flawless', 'swift', 'glassLanded', 'terraces'].forEach((stat) => profile.count(stat, tally[stat]));
    profile.best('bestFloor', tally.floors);
    profile.best('bestStreak', tally.longestStreak);
    const experience = Math.round(tally.score * charter.experienceScale);
    const levelsGained = profile.gainExperience(experience);
    profile.endRun({ floors: tally.floors, score: tally.score, charter: charter.id });
    return { experience, levelsGained, unlocked: profile.unlocked().filter((id) => !before.has(id)).map((id) => UNLOCKABLES.byId(id)) };
  }

  /**
   * What the player is working toward, nearest first by kind: the next level unlock, then unfinished achievements.
   * @param {Object} profile
   * @returns {string[]} lines such as 'Level 4: Charter - Gale Season' or 'Land 25 glass slabs (12/25): Blueprint - Glazier'
   */
  function upcomingUnlocks(profile) {
    const describe = (id) => `${UNLOCKABLES.byId(id).type} - ${UNLOCKABLES.byId(id).name}`;
    const byLevel = LEVEL_UNLOCKS.filter((row) => row.level > profile.level).slice(0, 1).map((row) => `Level ${row.level}: ${describe(row.unlocks)}`);
    const byFeat = profile.achievements().filter((entry) => !entry.done).map((entry) => `${entry.row.text} (${entry.progress}/${entry.row.target}): ${describe(entry.row.unlocks)}`);
    return byLevel.concat(byFeat);
  }

  Kit.skyStack = {
    SLAB, SLIDE, DIFFICULTY, SCORE, PRECISION, STREAK, BASE_MODIFIERS, SLAB_KINDS, BLUEPRINTS, BLUEPRINTS_OFFERED, CHARTERS, LEVEL_CURVE, LEVEL_UNLOCKS,
    ACHIEVEMENTS, MILESTONES, ZONES, PALETTE, AXES, UNLOCKABLES,
    multiplierAt, lookAt, zoneIndexAt, slabColor, milestoneAt, createModifierStats, readModifiers, kindForFloor, difficultyAt, slideOffset,
    slidePhaseRate, secondsToPass, createBaseFloor, createSlider, stepSlider, rewindSlider, isLinedUp, judgeDrop, widen, pointsFor,
    bracesEarnedBetween, createTally, resolutionOf, settleDrop, applyBlueprintPick, createProfile, isAvailableTo, charterFor, recordRun, upcomingUnlocks,
  };
})();
