// Prism Garden: a calm, turn-based light-routing puzzle. Turn, carry and plant glass so the lanterns' light opens every
// crystal flower. This file is the presenter: the board view, input, feedback, HUD and the modes around a bed.
//
// DEPTH PLAN (games/README.md: deep at three timescales; the numbers behind it are proved by scratch/prism/solve.js and pace.js)
//   Seconds - mastery. Every bed has three buds: open every flower; do it in par (the solver's proven minimum); and a
//     laurel that asks for a harder route (wake the optional moonbloom, let no light leave the bed, or leave shelf
//     pieces unplanted). On most beds the laurel route costs more moves than par, so one visit cannot take all three:
//     the bud row shows live which goals the current position meets, and a skilled player reads two routes in a bed.
//   Minutes - decisions. From chapter III beds come with a shelf of pieces you choose to spend. Planting everything is
//     quick; sparing a piece means finding the route through the mirrors already in the soil. Rules interact rather
//     than stack: filters tint whatever passes, so loops re-colour a beam; violet flowers need a rose and a mint beam
//     to cross on them; moth glass passes light one way, which turns a blocked road into a return path; sunstones
//     sink every gate while lit, so one branch of a split beam can open the way for the other. A hint costs a move.
//   Hours - the long arc. Four chapters (14 beds) each add a rule. Buds are lifetime currency: 4 open the daily bed
//     (one seeded bed a day, the same for everyone), 9 open the wild beds (an endless forge whose tier rises with the
//     number you have solved, each bed proven and rated by the solver), and the garden around the bed grows with the
//     count: a sprout per bud, then fireflies, moon lilies, the arbour, a pond and the moon.
//   A solved bed ends at once when its laurel is settled; otherwise it waits for "Done", so the laurel can still be
//   chased from a solved position.
//
// Owns: how a bed looks, sounds and is touched; the modes (campaign, daily, wild) and what finishing a bed awards.
// Does not own: the rules, beds, forge and garden milestones (games/prism-model.js), the HUD look
//       (games/prism-theme.js), light travel and search (kit/puzzle.js), undo (Kit.history), the meaning of a
//       press-drag-release (Kit.placement), lifetime progress (Kit.profile) or pitch maths (Kit.music).
(() => {
  const MODEL = window.PRISM_MODEL;
  const { THEME, budRow } = window.PRISM_THEME;
  const { HUES, LANTERN_HUE, BEDS, GOALS, TIERS, GARDEN, MOVE_RULES } = MODEL;
  const { DIRS4 } = Kit.grid;
  const HALF_TURN = Math.PI, QUARTER_TURN = Math.PI / 2, FULL_TURN = Math.PI * 2;

  // ---- tunables ------------------------------------------------------------------------------------------------------------

  /** Camera and framing. Lengths are in cells (one cell is one world unit) unless a name says otherwise. */
  const VIEW = {
    pitch: (58 * Math.PI) / 180, // tilt above the horizon: steep enough that beams read as straight lines and cells stay thumb-sized
    distance: 30, // far enough that nothing clips; an orthographic camera does not shrink with distance
    margin: 1, // soil left around the bed
    pieceHeight: 1, // tallest piece, so its top is not cut off behind the HUD
    hudPx: { portrait: 250, landscape: 205 }, // screen height kept clear for the plaque, the bud row and the tool stakes
    pickHeight: 0.3, // pointer rays are intersected at about half a piece's height so a tap on a mirror's body picks its cell
    tapSlop: 0.35, // pointer travel, in cells, below which a press is a tap and not a carry
  };
  /** The potting shelf: a plank in front of the bed holding the pieces not yet planted. */
  const SHELF = { gap: 1.3, spacing: 1.15, depth: 1.5, reach: 0.6, plank: 0x6b4a2a };
  /** The beam is the art direction: these are the only bloom settings in the game. */
  const BEAM = {
    speed: 16, // cells per second the head of new light travels; a full route redraws in under a second
    height: 0.5, // light travels at the height of the flower heads and the middle of the mirrors
    thickness: 0.085,
    brightness: 2.6, // above the bloom threshold, so only beams, lit flowers and the lantern glow
    overrun: 0.6, // how far past the last cell centre a beam that leaves the bed is drawn
    bloom: [0.6, 0.55, 1], // strength, radius, threshold for ctx.post.bloom
    solidKinds: ['hedge', 'lantern', 'gate'], // pieces that fill their cell: light stops at their face, not their centre
  };
  /** Piece motion: every target is chased with math.damp, so rapid taps never fight a running tween. */
  const MOTION = { follow: 16, hop: 0.2, hopDecay: 9, carryLift: 0.45, flowerOpen: 7, closedScale: 0.72, spin: 0.6, gateSink: -0.72 };
  /** Notes: every bounce climbs one step of the scale, flowers answer an octave higher, a solved bed plays them together. */
  const SOUND = {
    scale: Kit.music.scale('C4', 'pentatonic'),
    highestStep: 12, // clamp so long routes do not become shrill
    flowerLift: 5, // scale steps a flower's note sits above its place in the bloom order (one octave in a pentatonic scale)
    bounce: { dur: 0.4, vol: 0.1, type: 'sine' },
    bloom: { dur: 0.9, vol: 0.13, type: 'triangle' },
    chord: { dur: 1.6, vol: 0.1, type: 'sine', strum: 0.07 }, // strum = seconds between chord notes
  };
  const HINT = { cost: 1, pulses: 3, pulseGap: 0.45, ring: { size: 0.75, life: 0.8 }, pieceColor: 0xffe9a8, targetColor: 0x7dd3fc };
  /** Shown on a solved bed whose laurel is still open. */
  const SOLVED_PROMPT = 'In bloom. Tap Done, or go on for the last bud';
  /** Seconds the finished bed is left glowing before the result card covers it. */
  const CLEAR_DELAY = 1.1;
  const SOIL = { ground: 0x0d1c1a, tileLight: 0x3f705e, tileDark: 0x366252, tileSize: 0.96, tileDepth: 0.1 };
  const MOONBLOOM_COLOR = 0xbfe4ff;
  /**
   * The garden beyond the bed. One sprout per lifetime bud (up to `maxSprouts`), scattered from a fixed seed so the
   * same garden greets the player every visit; the other parts appear when their GARDEN milestone is unlocked.
   */
  const GARDEN_VIEW = {
    seed: 0x6a2d,
    maxSprouts: 60,
    band: { near: 0.9, far: 3.3, side: 5.2 }, // sprouts stand this far behind the bed's back edge (short of the bud row), this far to either side
    sprout: { stem: 0x3f8a55, tip: 0x9ff3d0 },
    fireflies: { count: 9, color: 0xfff3a8, height: 1.1, drift: 0.5, speed: 0.6 },
    lilies: { count: 7, color: 0xdfe9ff },
    arbour: { wood: 0x5a4024, leaf: 0x3c8557, span: 2.2, height: 1.5 },
    pond: { color: 0x2f6f9a, radius: 1.1, at: [-2.7, 2.1] }, // [x, distance behind the bed]
    moon: { color: 0xdfe9ff, size: 2.6, at: [2.8, 1.3, 2.4] }, // [x, height, distance behind the bed]
  };

  // ---- view: one small builder per piece kind ------------------------------------------------------------------------------

  /** Yaw that lays a box's long axis along a "/" (slant 0) or "\" (slant 1) diagonal, with rows running toward the camera. */
  const slantYaw = (slant) => (slant === 0 ? 1 : -1) * (QUARTER_TURN / 2);
  /** Yaw that points a model's +x axis along a DIRS4 heading. */
  const headingYaw = (dir) => -dir * QUARTER_TURN;
  /** The angle equal to `yaw` modulo a half turn that is closest to `from`: a pane looks the same either way round, so it never spins further than a quarter turn. */
  const nearestHalfTurn = (yaw, from) => yaw + Math.round((from - yaw) / HALF_TURN) * HALF_TURN;
  /** Foot colour of a turnable pane: amber means "you can carry me", dull brass means it stays where it stands. */
  const footMaterial = (make, piece) => (piece.canMove ? make.mat(0xffb347, { emissive: 0xffb347, emissiveIntensity: 0.5 }) : make.mat(0x8a7440, { metal: 0.4, rough: 0.5 }));

  /** Upright pane on a round foot, shared by mirrors and splitters. */
  const buildPane = (make, root, { foot, glass }) => {
    make.cyl(0.3, 0.36, 0.1, foot, { parent: root, at: [0, 0.05, 0] });
    make.box(0.9, 0.78, 0.07, glass, { parent: root, at: [0, 0.5, 0] });
  };
  /** A hexagonal crystal column on a foot, shared by filters and sunstones. @returns {object} the crystal mesh */
  const buildCrystal = (make, root, material, foot) => {
    make.cyl(0.24, 0.3, 0.08, foot, { parent: root, at: [0, 0.04, 0] });
    return make.prism(6, 0.27, 0.8, material, { parent: root, at: [0, 0.5, 0] });
  };

  /**
   * Builders keyed by piece kind. Each fills `root` (a group standing on its cell) and returns the parts the view animates:
   * `spinner` turns slowly; `head`, `halo`, `facets` and `materials` belong to anything light can open or light up.
   * @type {Object<string, (make: object, root: object, piece: object) => object>}
   */
  const PIECE_BUILDERS = {
    hedge(make, root) {
      make.box(0.94, 0.62, 0.94, 0x2c6a45, { parent: root, at: [0, 0.31, 0], rough: 0.95 });
      make.box(0.8, 0.14, 0.8, 0x3c8557, { parent: root, at: [0, 0.69, 0], rough: 0.95 });
      return {};
    },
    gate(make, root) {
      // A trellis: dark iron with glowing rivets, so it reads as something that can open, unlike a hedge.
      make.box(0.9, 0.7, 0.9, 0x3a3f52, { parent: root, at: [0, 0.35, 0], metal: 0.5, rough: 0.5 });
      make.box(0.94, 0.06, 0.94, make.mat(0xffc46b, { emissive: 0xffc46b, emissiveIntensity: 0.9 }), { parent: root, at: [0, 0.55, 0], shadow: false });
      return {};
    },
    lantern(make, root, piece) {
      const light = HUES.byId(LANTERN_HUE).color;
      root.rotation.y = headingYaw(piece.dir);
      make.cyl(0.26, 0.34, 0.28, 0x6b5326, { parent: root, at: [0, 0.14, 0], metal: 0.4, rough: 0.5 });
      make.sphere(0.2, make.unlit(light, { bright: BEAM.brightness }), { parent: root, at: [0, BEAM.height, 0], shadow: false });
      make.box(0.24, 0.12, 0.12, 0x6b5326, { parent: root, at: [0.28, BEAM.height, 0], metal: 0.4, rough: 0.5 }); // spout: shows the heading
      make.glow(light, 1.5, { parent: root, at: [0, BEAM.height, 0], depthTest: false, opacity: 0.5 });
      return {};
    },
    mirror(make, root, piece) {
      buildPane(make, root, { foot: footMaterial(make, piece), glass: make.mat(0xd6ecff, { rough: 0.12, metal: 0.25, emissive: 0x33506e, emissiveIntensity: 0.5 }) });
      return {};
    },
    splitter(make, root, piece) {
      buildPane(make, root, { foot: piece.canMove ? footMaterial(make, piece) : make.mat(0x3d7f86, { rough: 0.5 }), glass: make.mat(0x9ff3ff, { opacity: 0.4, rough: 0.1, emissive: 0x2a8a9a, emissiveIntensity: 0.6 }) });
      make.ico(0.13, 0, 0xe8fbff, { parent: root, at: [0, BEAM.height, 0], emissive: 0x9ff3ff, emissiveIntensity: 0.8 }); // the facet that forks the light
      return {};
    },
    filter(make, root, piece) {
      const hue = HUES.byId(piece.color).color;
      const foot = piece.canMove ? footMaterial(make, piece) : make.mat(0x4a4f45);
      return { spinner: buildCrystal(make, root, make.mat(hue, { opacity: 0.62, rough: 0.15, emissive: hue, emissiveIntensity: 0.45 }), foot) };
    },
    oneway(make, root, piece) {
      // Moth glass: a dusky pane across the light's path with a bright chevron on the soil showing the way through.
      root.rotation.y = headingYaw(piece.dir);
      make.box(0.07, 0.78, 0.9, make.mat(0x8f7bd6, { opacity: 0.5, rough: 0.2, emissive: 0x4a3a8a, emissiveIntensity: 0.6 }), { parent: root, at: [0, 0.45, 0] });
      const chevron = make.cone(0.16, 0.34, make.unlit(0xd9ccff, { bright: 1.4 }), { parent: root, seg: 3, at: [0.22, 0.03, 0], shadow: false });
      chevron.rotation.z = -QUARTER_TURN; // lay the cone down with its tip along +x, the heading it lets through
      return {};
    },
    switch(make, root) {
      const closed = make.mat(0xb8862e, { rough: 0.35, emissive: 0x6b4a10, emissiveIntensity: 0.4 });
      const open = make.mat(0xffc46b, { emissive: 0xffc46b, emissiveIntensity: BEAM.brightness });
      const stone = buildCrystal(make, root, closed, make.mat(0x4a4f45));
      const halo = make.glow(0xffc46b, 1.6, { parent: root, at: [0, BEAM.height, 0], depthTest: false, opacity: 0 });
      return { head: stone, halo, facets: [stone], materials: { closed, open }, hue: 0xffc46b, restScale: 1 };
    },
    flower(make, root, piece) {
      const hue = piece.isBonus ? MOONBLOOM_COLOR : HUES.byId(piece.color).color;
      const PETALS = 6, PETAL_REACH = 0.19, PETAL_TILT = -QUARTER_TURN * 0.72; // petals lean outward, not flat
      make.cyl(0.035, 0.05, BEAM.height - 0.06, 0x3f8a55, { parent: root, at: [0, (BEAM.height - 0.06) / 2, 0] });
      // A moonbloom stands in a pale ring: it is the one flower the bed does not need.
      if (piece.isBonus) make.cyl(0.42, 0.42, 0.02, make.unlit(MOONBLOOM_COLOR, { opacity: 0.3 }), { parent: root, at: [0, 0.015, 0], shadow: false });
      const head = make.group({ parent: root, at: [0, BEAM.height, 0] });
      const closed = make.mat(hue, { rough: 0.7 });
      const open = make.mat(hue, { emissive: hue, emissiveIntensity: BEAM.brightness });
      const facets = [make.ico(0.16, 0, closed, { parent: head })].concat(
        Array.from({ length: PETALS }, (_, index) => {
          const angle = (index / PETALS) * FULL_TURN;
          const petal = make.cone(0.1, 0.36, closed, { parent: head, seg: 5, at: [Math.cos(angle) * PETAL_REACH, 0.02, Math.sin(angle) * PETAL_REACH] });
          petal.rotation.set(0, -angle, PETAL_TILT);
          return petal;
        })
      );
      const halo = make.glow(hue, 1.7, { parent: head, depthTest: false, opacity: 0 });
      return { head, halo, facets, materials: { closed, open }, hue, restScale: MOTION.closedScale };
    },
  };

  /**
   * Plant the garden beyond the bed: what the player's lifetime buds have grown.
   * @param {object} ctx - the game ctx
   * @param {object} garden
   * @param {number} garden.buds - lifetime bud count
   * @param {(id: string) => boolean} garden.isUnlocked - Kit.profile's isUnlocked
   * @param {number} garden.backEdge - world z of the bed's far edge; the garden grows behind it
   * @returns {(time: number) => void} per-frame update (fireflies drift), a no-op until they are unlocked
   * @complexity O(sprouts) once to place; two instanced draw calls for any number of sprouts. Per frame: O(fireflies).
   */
  const plantGarden = (ctx, { buds, isUnlocked, backEdge }) => {
    const { make, THREE } = ctx;
    const { band, sprout, fireflies, lilies, arbour, pond, moon } = GARDEN_VIEW;
    const rng = Kit.rng(GARDEN_VIEW.seed);
    const spot = () => ({ x: rng.range(-band.side, band.side), z: backEdge - rng.range(band.near, band.far) });
    // Every possible spot is drawn from the seed up front, so sprout n always stands in the same place.
    const sproutSpots = Array.from({ length: GARDEN_VIEW.maxSprouts }, spot).slice(0, buds);
    const stems = make.instanced(new THREE.ConeGeometry(0.07, 0.42, 5), sprout.stem, Math.max(1, sproutSpots.length));
    const tips = make.instanced(new THREE.IcosahedronGeometry(0.075, 0), make.unlit(sprout.tip, { bright: 1.5 }), Math.max(1, sproutSpots.length));
    sproutSpots.forEach((at, index) => {
      stems.place(index, at.x, 0.21 - SOIL.tileDepth, at.z);
      tips.place(index, at.x, 0.46 - SOIL.tileDepth, at.z);
    });
    stems.commit();
    tips.commit();
    if (isUnlocked('lilies')) {
      Array.from({ length: lilies.count }, spot).forEach((at) => make.ico(0.2, 0, make.mat(lilies.color, { emissive: lilies.color, emissiveIntensity: 0.9 }), { at: [at.x, 0.12, at.z], shadow: false }));
    }
    if (isUnlocked('arbour')) {
      const z = backEdge - band.near;
      [-1, 1].forEach((side) => make.box(0.14, arbour.height, 0.14, arbour.wood, { at: [(side * arbour.span) / 2, arbour.height / 2, z] }));
      make.box(arbour.span + 0.5, 0.14, 0.3, arbour.wood, { at: [0, arbour.height, z] });
      make.box(arbour.span + 0.2, 0.22, 0.5, arbour.leaf, { at: [0, arbour.height + 0.18, z], rough: 0.95 });
    }
    if (isUnlocked('pond')) make.cyl(pond.radius, pond.radius, 0.02, make.unlit(pond.color, { opacity: 0.75 }), { at: [pond.at[0], 0.01 - SOIL.tileDepth, backEdge - pond.at[1]], seg: 28, shadow: false });
    if (isUnlocked('moon')) make.glow(moon.color, moon.size, { at: [moon.at[0], moon.at[1], backEdge - moon.at[2]], depthTest: false, opacity: 0.85 });
    if (!isUnlocked('fireflies')) return () => {};
    const flies = Array.from({ length: fireflies.count }, (_, index) => ({ home: spot(), phase: index * 1.7, glow: make.glow(fireflies.color, 0.5, { depthTest: false, opacity: 0.8 }) }));
    return (time) =>
      flies.forEach(({ home, phase, glow }) =>
        glow.position.set(home.x + Math.sin(time * fireflies.speed + phase) * fireflies.drift, fireflies.height + Math.sin(time * fireflies.speed * 1.3 + phase) * 0.3, home.z + Math.cos(time * fireflies.speed * 0.8 + phase) * fireflies.drift)
      );
  };

  // ---- modes: where the current bed comes from and what finishing it is worth ----------------------------------------------

  /** Forged beds are kept in the save under this key, so each is forged (and its solver run paid for) once. */
  const FORGED_SAVE_KEY = 'forged';
  const today = () => Kit.levels.dayNumber(Date.now());

  /**
   * The three ways to play, as strategies over the same game. Each takes the shared services ({ save, profile,
   * progress }) and answers: which bed is this, what to call it on the plaque, what finishing it awards, and where
   * "Next" leads.
   * @type {Object<string, {unlock: (string | null), bed: Function, plaque: Function, award: Function, next: Function}>}
   */
  const MODES = {
    campaign: {
      unlock: null,
      bed: (services, session) => BEDS[Kit.math.clamp(session.index, 0, BEDS.length - 1)],
      plaque: (services, session) => `${session.index + 1}/${BEDS.length}`,
      /** @returns {number} buds newly earned: goals met here for the first time */
      award: ({ progress }, session, bed, met, moves) => progress.complete(bed.id, moves, met).newMedals.length,
      next: (services, session) => (session.index + 1 < BEDS.length ? { mode: 'campaign', index: session.index + 1 } : { mode: 'campaign', index: 0 }),
    },
    wild: {
      unlock: 'wild',
      bed: ({ profile }) => MODEL.wildBed(profile.stat('wildSolved')),
      plaque: ({ profile }) => `W${profile.stat('wildSolved') + 1}`,
      /** Every wild bed is new, so every goal met is a new bud; solving it moves the player on to the next one. */
      award({ profile }, session, bed, met) {
        profile.count('wildSolved');
        return met.length;
      },
      next: () => ({ mode: 'wild' }),
    },
    daily: {
      unlock: 'daily',
      bed: () => MODEL.dailyBed(today()),
      plaque: () => 'Day',
      /** The daily bed pays out once a day; replays are for practice. `dailyDay` keeps the last day paid. */
      award({ profile }, session, bed, met) {
        if (profile.stat('dailyDay') >= today()) return 0;
        profile.best('dailyDay', today());
        profile.count('dailySolved');
        return met.length;
      },
      next: ({ progress }) => ({ mode: 'campaign', index: BEDS.findIndex((bed) => bed.id === progress.firstOpen()) }),
    },
  };

  /**
   * The bed of a session, forging it at most once: forged beds are remembered in the save by id.
   * @returns {object} a Bed
   */
  const bedOf = (services, session) => {
    const mode = MODES[session.mode];
    if (session.mode === 'campaign') return mode.bed(services, session);
    const id = session.mode === 'wild' ? `wild-${services.profile.stat('wildSolved')}` : `daily-${today()}`;
    const kept = services.save.get(FORGED_SAVE_KEY, {});
    if (kept[id]) return kept[id];
    const bed = mode.bed(services, session);
    // Only the current wild and daily beds are worth keeping; older ones are dropped so the save stays small.
    services.save.set(FORGED_SAVE_KEY, { ...Object.fromEntries(Object.entries(kept).filter(([keptId]) => keptId.split('-')[0] !== session.mode)), [id]: bed });
    return bed;
  };

  // ---- the game -------------------------------------------------------------------------------------------------------------

  Kit.register({
    id: 'prism',
    name: 'Prism Garden',
    tagline: 'Turn mirrors, light every flower',
    hook: 'Three buds a bed, a garden that grows',
    color: '#7dd3fc',
    order: 7,
    theme: THEME,
    /**
     * The pure rules, for headless tools (scratch/prism/solve.js, pace.js, and `make sim GAME=prism` through
     * `progression`). The four aliases are the names this handle had before the model moved to its own file.
     */
    headless: { ...MODEL, LEVELS: BEDS, parseLevel: MODEL.parseBed, listMoves: MODEL.listUsefulMoves, traceBoard: MODEL.lightIn },
    create(ctx) {
      const { THREE, make, input, fx, sfx, ui, save, math } = ctx;
      const news = []; // lines for the next result card: what the garden gained
      const profile = Kit.profile({ save, achievements: GARDEN, onAchievement: (row) => news.push(row.news) });
      const progress = Kit.levels(BEDS, { save });
      const services = { save, profile, progress };
      const saved = save.get('session', { mode: 'campaign', index: 0 });
      // A saved mode that is not unlocked (an edited or older save) falls back to the campaign.
      const session = MODES[saved.mode] && (!MODES[saved.mode].unlock || profile.isUnlocked(MODES[saved.mode].unlock)) ? saved : { mode: 'campaign', index: 0 };
      const mode = MODES[session.mode];
      const bed = bedOf(services, session);
      const start = MODEL.parseBed(bed);
      const goalIds = MODEL.goalsOf(bed);
      const board = start.fixed; // only its size and world mapping are used: every state of a bed shares them
      const shelfSlots = new Map(start.shelf.map((piece, slot) => [piece.id, slot]));
      const shelfDepth = start.shelf.length ? SHELF.depth : 0;
      const cellWorld = (cell, y = 0) => new THREE.Vector3(board.toWorld(cell.x, cell.y).x, y, board.toWorld(cell.x, cell.y).z);
      const slotWorld = (pieceId) => new THREE.Vector3((shelfSlots.get(pieceId) - (shelfSlots.size - 1) / 2) * SHELF.spacing, 0, board.h / 2 + SHELF.gap - 0.5);

      // Mutable game state, changed only by commit(), restore() and resetBed() below.
      let state = start;
      let boardMoves = 0; // moves that led to this state (undo takes them back)
      let hintsUsed = 0; // hints are paid for in moves and cannot be undone
      const history = Kit.history();
      const remember = () => history.push({ loose: state.loose, shelf: state.shelf, moves: boardMoves });
      remember();
      const totalMoves = () => boardMoves + hintsUsed * HINT.cost;

      // ---- scene ----
      make.stage({ sky: [0x16263a, 0x0a1414], sun: [3, 9, 5], sunColor: 0xcfe0ff, sunIntensity: 0.85, ambient: 0.6, shadow: 7 });
      ctx.post.bloom(...BEAM.bloom);
      make.ground(60, SOIL.ground).position.y = -SOIL.tileDepth;
      const tileGeometry = new THREE.BoxGeometry(SOIL.tileSize, SOIL.tileDepth, SOIL.tileSize);
      const allCells = board.find(() => true);
      [SOIL.tileLight, SOIL.tileDark].forEach((color, parity) => {
        const cells = allCells.filter((cell) => (cell.x + cell.y) % 2 === parity);
        const tiles = make.instanced(tileGeometry, color, cells.length, { shadow: true, rough: 0.9 });
        cells.forEach((cell, index) => tiles.place(index, cellWorld(cell).x, -SOIL.tileDepth / 2, cellWorld(cell).z));
        tiles.commit();
      });
      if (shelfSlots.size) make.box(shelfSlots.size * SHELF.spacing + 0.3, 0.08, 1, SHELF.plank, { at: [0, -0.04, slotWorld(start.shelf[0].id).z], rough: 0.85 });
      const updateGarden = plantGarden(ctx, { buds: profile.stat('buds'), isUnlocked: profile.isUnlocked, backEdge: -board.h / 2 });

      // The bed and its shelf must fit between the plaque row and the tool row in either orientation.
      const camera = ctx.ortho((size) => {
        const clearFraction = (size.h - (size.portrait ? VIEW.hudPx.portrait : VIEW.hudPx.landscape)) / size.h;
        const depthOnScreen = (board.h + shelfDepth) * Math.sin(VIEW.pitch) + VIEW.pieceHeight * Math.cos(VIEW.pitch) + VIEW.margin;
        return Math.max(Math.max(board.w, shelfSlots.size * SHELF.spacing) + VIEW.margin, (depthOnScreen * size.aspect) / clearFraction);
      }, 'width');
      const focus = new THREE.Vector3(0, VIEW.pieceHeight / 3, shelfDepth / 2);
      camera.position.set(focus.x, focus.y + Math.sin(VIEW.pitch) * VIEW.distance, focus.z + Math.cos(VIEW.pitch) * VIEW.distance);
      camera.lookAt(focus);

      // ---- piece views: one per piece id, each chasing a target position and yaw ----
      const buildView = (piece, position) => {
        const root = make.group();
        root.position.copy(position);
        if (piece.slant !== undefined) root.rotation.y = slantYaw(piece.slant);
        const parts = PIECE_BUILDERS[piece.kind](make, root, piece);
        return [piece.id, { root, kind: piece.kind, target: position, targetYaw: root.rotation.y, hop: 0, lift: 0, height: 0, openness: 0, isOpen: false, ...parts }];
      };
      const fixedViews = board.find((cell) => !!cell).map(({ x, y, v: piece }) => {
        const [id, view] = buildView(piece, cellWorld({ x, y }));
        return [id, { ...view, cellKey: `${x},${y}` }];
      });
      const pieceViews = new Map(fixedViews.concat(start.loose.map((piece) => buildView(piece, cellWorld(piece))), start.shelf.map((piece) => buildView(piece, slotWorld(piece.id)))));
      const viewsOfKind = (kind) => [...pieceViews.values()].filter((view) => view.kind === kind);
      const flowerViews = viewsOfKind('flower'), switchViews = viewsOfKind('switch'), gateViews = viewsOfKind('gate');

      /** Point every loose and shelf piece view at where (and how) its piece now stands. */
      const syncPieces = () => {
        const settle = (piece, position) => {
          const view = pieceViews.get(piece.id);
          view.target = position;
          view.lift = 0;
          if (piece.slant !== undefined) view.targetYaw = nearestHalfTurn(slantYaw(piece.slant), view.root.rotation.y);
        };
        state.loose.forEach((piece) => settle(piece, cellWorld(piece)));
        state.shelf.forEach((piece) => settle(piece, slotWorld(piece.id)));
      };

      // ---- beam view: pooled bars that grow along the route from wherever it changed ----
      const beamGeometry = new THREE.BoxGeometry(1, BEAM.thickness, BEAM.thickness);
      const beamMaterials = Object.fromEntries(HUES.map((hue) => [hue.id, make.unlit(hue.color, { bright: BEAM.brightness })]));
      const beamBars = ctx.pool(() => make.mesh(beamGeometry, beamMaterials[LANTERN_HUE], { shadow: false }));
      /** @type {{runs: object[], head: number, end: number, opensAt: Map<string, number>, bounces: {distance: number, step: number}[], isSolved: boolean}} */
      let beam = { runs: [], head: 0, end: 0, opensAt: new Map(), bounces: [], isSolved: false };
      const runKey = (segment) => [segment.from.x, segment.from.y, segment.dir, segment.color, segment.start, segment.length].join(',');
      /** How far a run is drawn, in cells: to an optic's centre, to the near face of a solid piece, or a little past the bed's edge. */
      const drawLength = (segment, grid) => {
        if (segment.leaves) return segment.length + BEAM.overrun;
        return BEAM.solidKinds.includes(grid.get(segment.to.x, segment.to.y).kind) ? segment.length - 0.5 : segment.length;
      };

      /** Recompute the light for the current state and restart the animation at the first point where the route changed. */
      const showBeam = () => {
        const light = MODEL.lightIn(state);
        const grid = MODEL.boardOf(state);
        const keptKeys = new Set(beam.runs.map((run) => run.key));
        const changedStarts = light.segments.filter((segment) => !keptKeys.has(runKey(segment))).map((segment) => segment.start);
        const head = Math.min(beam.head, ...changedStarts);
        beamBars.clear();
        const runs = light.segments.map((segment) => {
          const bar = beamBars.get();
          bar.material = beamMaterials[segment.color];
          bar.rotation.y = headingYaw(segment.dir);
          return { key: runKey(segment), bar, origin: cellWorld(segment.from, BEAM.height), step: DIRS4[segment.dir], start: segment.start, reach: drawLength(segment, grid) };
        });
        // Every optic the light leaves plays one note; a splitter's two runs share a start, so de-duplicate by distance.
        const bounceDistances = [...new Set(light.segments.map((segment) => segment.start).filter((distance) => distance > 0))].sort((a, b) => a - b);
        beam = {
          runs,
          head,
          end: Math.max(0, ...runs.map((run) => run.start + run.reach)),
          opensAt: new Map(light.flowers.concat(light.switches).map((cell) => [`${cell.x},${cell.y}`, cell.distance])),
          bounces: bounceDistances.map((distance, step) => ({ distance, step })).filter((bounce) => bounce.distance >= head),
          isSolved: MODEL.isSolved(state),
        };
        gateViews.forEach((view) => (view.lift = light.areGatesOpen ? MOTION.gateSink : 0));
      };

      const playNote = (step, voice, delay = 0) => sfx.tone({ ...voice, freq: SOUND.scale(Math.min(step, SOUND.highestStep)), delay });
      /** Scale step of an open flower: its place in the order the light opens things, lifted above the bounce notes. */
      const bloomStep = (view) => SOUND.flowerLift + [...beam.opensAt.values()].filter((distance) => distance < beam.opensAt.get(view.cellKey)).length;

      /** Open or close a flower (or light or dim a sunstone): swap its material, and on opening play its note and shed a few petals. */
      const setOpen = (view, isOpen) => {
        view.isOpen = isOpen;
        view.facets.forEach((facet) => (facet.material = isOpen ? view.materials.open : view.materials.closed));
        if (!isOpen) return;
        playNote(bloomStep(view), SOUND.bloom);
        fx.burst({ x: view.root.position.x, y: BEAM.height, z: view.root.position.z }, { count: 9, color: view.hue, speed: 1.6, life: 0.7, size: 0.07, gravity: 1.5, up: 0.5 });
      };

      /** Advance the head of the light; grow the bars, sound the bounces it passes and open or close what it reaches. */
      const updateBeam = (dt) => {
        beam.head = Math.min(beam.end, beam.head + BEAM.speed * dt);
        beam.runs.forEach((run) => {
          const shown = math.clamp(beam.head - run.start, 0, run.reach);
          run.bar.visible = shown > 0;
          run.bar.scale.x = Math.max(shown, 1e-3); // a zero scale makes the matrix singular
          run.bar.position.set(run.origin.x + (run.step[0] * shown) / 2, BEAM.height, run.origin.z + (run.step[1] * shown) / 2);
        });
        beam.bounces.filter((bounce) => bounce.distance <= beam.head).forEach((bounce) => playNote(bounce.step, SOUND.bounce));
        beam.bounces = beam.bounces.filter((bounce) => bounce.distance > beam.head);
        flowerViews.concat(switchViews).forEach((view) => {
          const shouldOpen = beam.opensAt.has(view.cellKey) && beam.opensAt.get(view.cellKey) <= beam.head;
          if (shouldOpen !== view.isOpen) setOpen(view, shouldOpen);
        });
      };

      /** Ease every piece toward its target; hops and lifts are offsets on top of the resting height. */
      const updatePieces = (dt, time) =>
        pieceViews.forEach((view) => {
          const { root } = view;
          view.hop = math.damp(view.hop, 0, MOTION.hopDecay, dt);
          view.height = math.damp(view.height, view.lift, MOTION.follow, dt);
          root.position.x = math.damp(root.position.x, view.target.x, MOTION.follow, dt);
          root.position.z = math.damp(root.position.z, view.target.z, MOTION.follow, dt);
          root.position.y = view.height + view.hop;
          if (view.kind === 'mirror' || view.kind === 'splitter') root.rotation.y = math.damp(root.rotation.y, view.targetYaw, MOTION.follow, dt);
          if (view.spinner) view.spinner.rotation.y = time * MOTION.spin;
          if (view.head) {
            view.openness = math.damp(view.openness, view.isOpen ? 1 : 0, MOTION.flowerOpen, dt);
            view.head.scale.setScalar(math.lerp(view.restScale, 1, view.openness));
            view.halo.material.opacity = view.openness * 0.7;
          }
        });

      // ---- HUD ----
      ui.stat('Bed', mode.plaque(services, session));
      const movesStat = ui.stat('Moves', 0);
      ui.stat('Par', bed.par);
      const budHolder = ui.el('div', 'bud-row');
      const tierName = bed.tier ? `${TIERS.byId(bed.tier).name} · rated ${bed.rating}` : null;
      const tip = ui.hint(bed.tip || tierName);
      const laurelText = bed.laurel ? GOALS.byId(bed.laurel).text(bed) : tierName;
      /** Which goals the current position would earn if the bed were finished now ("bloom" only once it is solved). */
      const goalsMetNow = () => MODEL.goalsMet(bed, state, totalMoves()).filter((id) => id !== 'bloom' || MODEL.isSolved(state));
      const countOf = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
      const earnedBefore = () => (session.mode === 'campaign' ? progress.medals(bed.id) : []);
      /**
       * Buds show live which goals this position holds, so going over par or losing the laurel is felt as it happens:
       * "ahead" while the bed is still unsolved (the goal is on course, not yet won), "lit" once it is.
       */
      const budStates = (metNow) => goalIds.map((id) => (metNow.includes(id) ? (MODEL.isSolved(state) ? 'lit' : 'ahead') : earnedBefore().includes(id) ? 'kept' : 'bare'));
      /** The laurel no longer needs chasing: the bed has none, it was won on an earlier visit, or this position holds it. */
      const isLaurelSettled = () => !bed.laurel || earnedBefore().includes(bed.laurel) || goalsMetNow().includes(bed.laurel);
      const refreshHud = () => {
        movesStat.set(totalMoves());
        budHolder.replaceChildren(budRow(ui.h, budStates(goalsMetNow())), ui.h('small', null, bed.name), ui.h('em', null, laurelText));
        tools.set('undo', { disabled: !history.canUndo() });
        tools.set('redo', { disabled: !history.canRedo() });
        tools.set('reset', { disabled: boardMoves === 0 });
        // On a solved bed there is nothing to hint at: the same stake ends the visit instead.
        tools.set('hint', MODEL.isSolved(state) ? { label: 'Done', sub: '' } : { label: 'Hint', sub: `+${HINT.cost} move` });
      };
      /** Show the new state: pieces, light and numbers. Called after every change of `state`. */
      const refresh = () => {
        syncPieces();
        showBeam();
        refreshHud();
      };

      // ---- phases: play until every flower is open and the light has finished drawing, then celebrate ----
      const openSession = (next) => {
        save.set('session', next);
        ctx.restart();
      };
      /** The result card: a line per goal with its bud, the numbers on brass, and what the garden gained. */
      const showResult = () => {
        const met = MODEL.goalsMet(bed, state, totalMoves());
        const before = earnedBefore();
        const budsEarned = mode.award(services, session, bed, met, totalMoves());
        if (budsEarned > 0) profile.count('buds', budsEarned); // may complete GARDEN milestones, which push to `news`
        const nextStage = GARDEN.find((row) => profile.stat('buds') < row.target);
        ui.panel({
          title: `${bed.name} in bloom`,
          closeLabel: 'Next bed',
          build(body) {
            const card = ui.h('div', 'result');
            const goals = ui.h('div', 'goal-list');
            goalIds.forEach((id) => {
              const isMet = met.includes(id);
              const line = ui.h('div', isMet ? '' : 'missed');
              line.append(ui.h('i', `bud ${isMet ? 'lit' : before.includes(id) ? 'kept' : 'bare'}`), GOALS.byId(id).text(bed));
              if (isMet && !before.includes(id) && budsEarned > 0) line.append(ui.h('b', null, 'new bud'));
              goals.append(line);
            });
            const rows = ui.h('div', 'rows');
            [['Moves', totalMoves()], ['Par', bed.par], ['Buds in the garden', profile.stat('buds')]].forEach(([label, value]) => {
              const row = ui.h('div');
              row.append(ui.h('span', null, label), ui.h('b', null, String(value)));
              rows.append(row);
            });
            card.append(goals, rows, ...news.map((line) => ui.h('p', 'news', line)));
            if (nextStage) card.append(ui.h('p', 'garden-note', `${countOf(nextStage.target - profile.stat('buds'), 'more bud')}: ${nextStage.news.toLowerCase()}`));
            body.append(card);
          },
        }).then(() => openSession(mode.next(services, session)));
      };
      const flow = Kit.fsm(
        {
          play: {},
          cleared: {
            enter() {
              // The solved bed sounds as one chord: every open flower's note, strummed in the order the light reaches them.
              const openViews = flowerViews.filter((view) => view.isOpen);
              openViews.map(bloomStep).sort((a, b) => a - b).forEach((step, index) => playNote(step, SOUND.chord, index * SOUND.chord.strum));
              openViews.forEach((view) => fx.ring(view.root.position, { color: view.hue, size: 1.1, life: 0.9, y: 0.05 }));
              ctx.after(CLEAR_DELAY, showResult);
            },
          },
        },
        'play'
      );

      /**
       * The light has finished drawing on a solved bed. End the visit when nothing is left to chase; otherwise say so
       * once per position and leave the player to go on or press Done.
       */
      let promptedState = null;
      const settleSolved = () => {
        if (isLaurelSettled()) return flow.go('cleared');
        if (promptedState === state) return;
        promptedState = state;
        tip.set(SOLVED_PROMPT);
        tip.show();
      };

      // ---- moves ----
      /** The sound of each move type: glass clicks, soil thuds. */
      const MOVE_SOUNDS = { turn: ['click', { pitch: 1.5 }], carry: ['thud', { pitch: 1.7, vol: 0.45 }], place: ['thud', { pitch: 1.4, vol: 0.5 }], stow: ['click', { pitch: 0.8 }] };
      /** The piece a move touches, looked up before the move is applied. */
      const movedPiece = (move) => (move.type === 'place' ? state.shelf.find((piece) => piece.id === move.id) : MODEL.boardOf(state).get(MOVE_RULES[move.type].spots(move).piece.x, MOVE_RULES[move.type].spots(move).piece.y));
      const commit = (move) => {
        const moved = movedPiece(move);
        state = MODEL.applyMove(state, move);
        boardMoves += 1;
        remember();
        sfx.play(...MOVE_SOUNDS[move.type]);
        pieceViews.get(moved.id).hop = MOTION.hop;
        tip.hide(); // the bed's opening tip, or the words of the last hint
        refresh();
      };
      /** Jump to a remembered state (undo, redo). Does nothing when history has no such state. */
      const restore = (remembered) => {
        if (!remembered || !flow.is('play')) return;
        state = { fixed: start.fixed, loose: remembered.loose, shelf: remembered.shelf };
        boardMoves = remembered.moves;
        refresh();
      };
      /** Reset is itself a step in history, so one Undo brings the work back. */
      const resetBed = () => {
        if (!flow.is('play') || boardMoves === 0) return;
        state = start;
        boardMoves = 0;
        remember();
        refresh();
      };

      // ---- hint: ring the piece of the next move on a shortest solution, at the price of a move ----
      const dropMarker = make.mesh(new THREE.BoxGeometry(SOIL.tileSize, 0.02, SOIL.tileSize), make.unlit(HINT.targetColor, { opacity: 0.35 }), { shadow: false });
      dropMarker.visible = false;
      const ringAt = (position, color) => fx.ring(position, { ...HINT.ring, color, y: 0.06 });
      const showHint = () => {
        if (!flow.is('play')) return;
        if (MODEL.isSolved(state)) return flow.go('cleared'); // the stake reads "Done" on a solved bed
        const solution = MODEL.solve(state);
        if (!solution || !solution.moves.length) return ui.toast('No hint for this bed');
        const move = solution.moves[0];
        const rule = MOVE_RULES[move.type];
        const { piece, target } = rule.spots(move);
        // A shelf piece has no cell: ring it where it stands on the shelf instead.
        const hinted = piece ? MODEL.boardOf(state).get(piece.x, piece.y) : state.shelf.find((candidate) => MODEL.shelfKindOf(candidate) === move.kind);
        hintsUsed += 1;
        tip.set(rule.hint);
        tip.show();
        Array.from({ length: HINT.pulses }, (_, pulse) =>
          ctx.after(pulse * HINT.pulseGap, () => {
            ringAt(pieceViews.get(hinted.id).root.position, HINT.pieceColor);
            if (target) ringAt(cellWorld(target), HINT.targetColor);
          })
        );
        pieceViews.get(hinted.id).hop = MOTION.hop;
        refreshHud();
        movesStat.pulse();
      };

      // ---- bed list: the campaign by chapter, with the daily and wild beds above it ----
      /** One brass row for a mode above the campaign list; locked modes say how many buds open them. */
      const modeRow = (close, { modeId, title, note }) => {
        const stage = GARDEN.find((row) => row.unlocks === MODES[modeId].unlock);
        const isOpen = profile.isUnlocked(stage.unlocks);
        const button = ui.h('button', 'choice mode');
        button.type = 'button';
        button.disabled = !isOpen;
        if (!isOpen) button.style.opacity = '0.45';
        const heading = ui.h('div', 'choice-top');
        heading.append(ui.h('b', null, title), ui.h('em', null, session.mode === modeId ? 'Playing' : ''));
        button.append(heading, ui.h('span', null, isOpen ? note : `Opens at ${stage.target} buds`));
        button.addEventListener('click', () => close({ mode: modeId }));
        return button;
      };
      const showBeds = () =>
        Kit.levels
          .select(ui, progress, {
            title: 'Garden beds',
            current: session.mode === 'campaign' ? bed.id : undefined,
            heading: (row) => row.chapter,
            stars: (earned, outOf, row) => budRow(ui.h, MODEL.goalsOf(row).map((id) => (progress.medals(row.id).includes(id) ? 'lit' : 'bare'))),
            before(body, close) {
              body.append(
                ui.h('p', 'garden-note', `${countOf(profile.stat('buds'), 'bud')} in the garden`),
                modeRow(close, { modeId: 'daily', title: 'Daily bed', note: profile.stat('dailyDay') >= today() ? 'Done today; replay for practice' : 'One new bed a day, the same for everyone' }),
                modeRow(close, { modeId: 'wild', title: `Wild bed ${profile.stat('wildSolved') + 1}`, note: 'Forged beds that grow thornier as you solve them' })
              );
            },
          })
          .then((choice) => {
            if (choice === undefined) return;
            openSession(typeof choice === 'string' ? { mode: 'campaign', index: BEDS.findIndex((row) => row.id === choice) } : choice);
          });

      const tools = ui.actions([
        { id: 'undo', label: 'Undo', onClick: () => restore(history.undo()) },
        { id: 'redo', label: 'Redo', onClick: () => restore(history.redo()) },
        { id: 'reset', label: 'Rake', onClick: resetBed },
        { id: 'hint', label: 'Hint', sub: `+${HINT.cost} move`, onClick: showHint },
        { id: 'beds', label: 'Beds', onClick: showBeds },
      ]);

      // ---- input: Kit.placement decides whether a press was a tap (turn), a carry, a planting or a return to the shelf ----
      const pointerOnBed = (info) => {
        const hit = input.ground(VIEW.pickHeight, info.nx, info.ny);
        return hit ? { x: hit.x, y: hit.z } : { x: Infinity, y: Infinity };
      };
      const shelfPieceAt = (point) => state.shelf.find((piece) => Math.hypot(slotWorld(piece.id).x - point.x, slotWorld(piece.id).z - point.y) < SHELF.reach);
      const gesture = Kit.placement({
        cellAt: (point) => board.fromWorld(point.x, point.y),
        trayKindAt: (point) => (shelfPieceAt(point) || { id: null }).id, // the "kind" carried from the shelf is the piece's own id
        pieceAt: (cell) => MODEL.boardOf(state).get(cell.x, cell.y),
        canPlace: (kind, cell, held) => held.source === 'tray' || !!held.piece.canMove,
        tapSlop: VIEW.tapSlop,
      });
      const heldPiece = (held) => (held.source === 'tray' ? state.shelf.find((piece) => piece.id === held.kind) : held.piece);
      /** What a finished gesture means here. Taps on fixed pieces and drops on occupied cells do nothing. */
      const GESTURE_MOVES = {
        tap: ({ held, cell }) => (held.piece.canTurn ? { type: 'turn', x: cell.x, y: cell.y } : null),
        move: ({ held, cell }) => ({ type: 'carry', from: held.from, to: cell }),
        place: ({ held, cell }) => ({ type: 'place', kind: MODEL.shelfKindOf(heldPiece(held)), id: held.kind, to: cell }),
        remove: ({ held }) => (held.piece.isFromShelf ? { type: 'stow', from: held.from } : null), // dragged off the bed: back to the shelf
        cancel: () => null,
      };
      const GESTURE_PHASES = {
        start: (point) => gesture.begin(point),
        move(point) {
          const hover = gesture.move(point);
          if (!hover || !hover.isDragging) return;
          const piece = heldPiece(hover.held);
          if (hover.held.source === 'board' && !piece.canMove) return;
          const view = pieceViews.get(piece.id);
          view.target = new THREE.Vector3(point.x, 0, point.y);
          view.lift = MOTION.carryLift;
          const isOwnCell = !!hover.cell && !!hover.held.from && hover.cell.x === hover.held.from.x && hover.cell.y === hover.held.from.y;
          dropMarker.visible = hover.isValid && !isOwnCell;
          if (dropMarker.visible) dropMarker.position.copy(cellWorld(hover.cell, 0.02));
        },
        end(point) {
          const action = gesture.end(point);
          dropMarker.visible = false;
          if (!action) return;
          const move = GESTURE_MOVES[action.type](action);
          if (move) commit(move);
          else syncPieces(); // a carried piece that was not set down settles back where it stood
        },
      };
      input.onDrag((info) => {
        if (flow.is('play')) GESTURE_PHASES[info.phase](pointerOnBed(info));
      });

      refresh();

      return {
        update(dt, time) {
          updatePieces(dt, time);
          updateBeam(dt);
          updateGarden(time);
          if (flow.is('play') && beam.isSolved && beam.head >= beam.end) settleSolved();
        },
      };
    },
  });
})();
