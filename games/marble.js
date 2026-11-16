// Marble Works: a build-and-watch marble contraption on an upright pegboard. The making game of the batch.
//
// Depth (the full plan, with every rule and table, opens games/marble-rules.js):
//   seconds - where a part sits and how it is turned decides whether a marble lands; par pegs and stars show the
//             difference between a clumsy solution and a clean one; tapping the hopper on the beat beats a timed gate.
//   minutes - a peg budget, three marble kinds that respond differently to the same parts, and wiring by placement
//             (bells and counters drive gates, spinners and splitters), so parts compete for cells and pegs.
//   hours   - nine challenge boards on three benches, an eight-song book, parts and marble kinds earned through
//             Kit.profile, an account level that grows the free bench, and three saved inventions.
//
// Owns: the pegboard view (meshes for parts, marbles, wires, tray), input, the two modes (free build and challenge
//       boards), the workshop HUD and its theme.
// Does not own: any rule or tunable of play (games/marble-rules.js, which also runs headless), or anything generic:
//       the tray-to-grid gesture is Kit.placement, undo is Kit.history, goals / levels / profile are Kit.goals,
//       Kit.levels and Kit.profile.
(() => {
  const RULES = window.MARBLE_RULES;
  const { BOARD, HALF_WIDTH, HALF_HEIGHT, TUNING, HOPPER, BUCKET, WALL, PARTS, PART_TABLE, BELL_SCALE, BELL_COLORS, DEGREES } = RULES;
  const { grid, cellCentre, poseOf, pegsSpent, EDITS } = RULES;

  // ---------------------------------------------------------------------------------------------------------------
  // View tables.
  // ---------------------------------------------------------------------------------------------------------------

  /** A struck bar: the fundamental rings on, a quiet inharmonic partial gives the metallic attack. */
  const BELL_VOICE = { ring: 0.7, volume: 0.26, partialRatio: 2.76, partialRing: 0.16, partialVolume: 0.07 };

  /** How each marble kind is drawn. Glass cycles through `colors` so neighbours differ; `jar` is its dot in the HUD jar. */
  const MARBLE_LOOKS = {
    glass: { colors: [0x3fa7d6, 0xee6352, 0x59cd90, 0xfac05e, 0xc17ecf], rough: 0.12, metal: 0.25 },
    steel: { colors: [0xc3cad6], rough: 0.22, metal: 0.95 },
    rubber: { colors: [0x2b2d42], rough: 0.95, metal: 0 },
  };

  /** The drawn hopper and bucket (their colliders and positions are RULES.HOPPER / RULES.BUCKET). */
  const HOPPER_LOOK = { box: { width: 1.3, height: 0.6, lift: 0.55 }, spout: { width: 0.7, height: 0.3, lift: 0.12 }, depth: 0.6, tapReach: { x: 0.9, y: 0.7 } };
  const BUCKET_LOOK = { wall: 0.18, depth: 0.6 };

  /** View framing. `reserve` is the screen height (px) the HUD needs at the top and bottom in each orientation. */
  const TRAY = { y: BUCKET.floorY - 1.15, width: 2 * HALF_WIDTH + 0.4, height: 1.25, maxSpacing: 0.9, miniFill: 0.62, reach: 0.6 };
  const VIEW = {
    top: HOPPER.y + 1,
    bottom: TRAY.y - TRAY.height / 2 - 0.15,
    width: 2 * HALF_WIDTH + 1.2,
    reserve: { portrait: { top: 128, bottom: 84 }, landscape: { top: 16, bottom: 16 } },
    cameraDistance: 30,
    cameraRise: 3, // the camera sits slightly above its target, so parts show their top faces (the 2.5D look)
  };

  const LOOK = {
    wall: [0x7a5a3c, 0x2f2118],
    birch: '#e6c690',
    pegHole: '#b98f57',
    frame: 0x8a5a2b,
    trayWood: 0xb07a3f,
    locked: 0x6d4b28,
    fixed: 0x5b4636, // board pieces the player cannot move are dark walnut, whatever their kind
    bucket: 0xf59e0b,
    hopper: 0x9c6b35,
    validCell: 0x8ac926,
    invalidCell: 0xe63946,
    wire: 0xfff4dc,
    wireWidth: 0.05,
    wireFlash: 0.25, // seconds a wire stays lit after a pulse
    gateOpenScale: 0.15, // an open gate's bar retracts to this fraction of its length
    carryLift: 0.7, // how far a carried part floats in front of the board
    pulseScale: 1.22, // squash applied to a part when a marble touches it
    jarCapacity: 12, // marbles shown in the HUD jar before it is emptied
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Meshes.
  // ---------------------------------------------------------------------------------------------------------------

  /** Sensors are drawn as thin pads at the back of the part layer so marbles visibly pass over them. */
  const SENSOR_PAD = { depth: 0.12, z: -0.18 };
  const CAP_COLOR = 0xfff1d6;
  const faceOutward = (mesh) => {
    // Cylinders stand along y; on the board their axis must point out of the wall.
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  };

  /**
   * Extra, purely visual pieces per part id. Each receives (make, group, paint, pose) and may tag group.userData.
   * @type {Object<string, (make: Object, group: THREE.Group, paint: THREE.Material, pose: Object) => void>}
   */
  const DECORATIONS = {
    bumper: (make, group) => faceOutward(make.cyl(0.2, 0.2, 0.08, CAP_COLOR, { parent: group, at: [0, 0, TUNING.partDepth / 2] })),
    spinner: (make, group) => faceOutward(make.cyl(0.16, 0.16, TUNING.partDepth + 0.1, CAP_COLOR, { parent: group })),
    // The arrow points along the part's local +x, which the pose angle turns into the boost heading.
    booster: (make, group) => (make.cone(0.17, 0.4, CAP_COLOR, { parent: group, at: [0.04, 0, 0] }).rotation.z = -Math.PI / 2),
    portal: (make, group, paint) => {
      make.mesh(new THREE.TorusGeometry(0.36, 0.07, 10, 28), paint, { parent: group });
      faceOutward(make.cyl(0.3, 0.3, 0.05, make.unlit(0x1b1030), { parent: group, at: [0, 0, SENSOR_PAD.z] }));
    },
    splitter: (make, group) => (group.userData.flag = make.box(0.12, 0.46, 0.2, CAP_COLOR, { parent: group, at: [0, 0.1, TUNING.partDepth / 2] })),
    // One pip per marble the counter waits for; they light as it counts.
    counter: (make, group, paint, pose) => {
      const pipX = (index) => (index - (pose.every - 1) / 2) * 0.13;
      group.userData.pips = Array.from({ length: pose.every }, (unused, index) => faceOutward(make.cyl(0.05, 0.05, 0.06, CAP_COLOR, { parent: group, at: [pipX(index), 0, TUNING.partDepth / 2] })));
    },
    // Two posts so a retracted (open) gate still shows where it is.
    gate: (make, group) => [-1, 1].forEach((side) => faceOutward(make.cyl(0.07, 0.07, TUNING.partDepth, CAP_COLOR, { parent: group, at: [side * 0.5, 0, 0] }))),
  };

  /**
   * Build a part's mesh from the same shapes its collider uses, so what is seen is what marbles hit.
   * @param {Object} make ctx.make.
   * @param {Object} row a RULES.PARTS row.
   * @param {number} color paint colour.
   * @param {Object} pose the pose being shown (counters draw one pip per count).
   * @returns {THREE.Group} unparented group centred on the part's origin; userData.bars holds the collider meshes.
   */
  const buildPartMesh = (make, row, color, pose) => {
    const group = new THREE.Group();
    const paint = make.mat(color, { rough: 0.45 });
    const depth = row.isSensor ? SENSOR_PAD.depth : TUNING.partDepth;
    const z = row.isSensor ? SENSOR_PAD.z : 0;
    group.userData.bars = row.shapes.map((shape) => {
      const [x, y] = shape.at || [0, 0];
      if (shape.disc) return faceOutward(make.cyl(shape.disc, shape.disc, depth, paint, { parent: group, at: [x, y, z] }));
      const plank = make.box(shape.box[0], shape.box[1], depth, paint, { parent: group, at: [x, y, z] });
      plank.rotation.z = (shape.angle || 0) * DEGREES;
      return plank;
    });
    if (DECORATIONS[row.id]) DECORATIONS[row.id](make, group, paint, pose);
    return group;
  };
  /** Paint colour of a piece: fixed board pieces are walnut, bells take their column's note colour. */
  const pieceColor = (row, column, isFixed) => (isFixed ? LOOK.fixed : row.id === 'bell' ? BELL_COLORS[column] : row.color);
  /** Remove a group and free its geometries (materials are shared through make.mat, so they stay). */
  const discardGroup = (group) => {
    group.traverse((object) => object.geometry && object.geometry.dispose());
    group.removeFromParent();
  };

  /** Paint the birch pegboard: one peg hole per cell so parts read as hung on it. */
  const paintPegboard = (context, width, height) => {
    const cellPixels = width / BOARD.cols;
    context.fillStyle = LOOK.birch;
    context.fillRect(0, 0, width, height);
    context.fillStyle = LOOK.pegHole;
    grid.each((value, column, row) => {
      context.beginPath();
      context.arc((column + 0.5) * cellPixels, (row + 0.5) * cellPixels, cellPixels * 0.07, 0, Math.PI * 2);
      context.fill();
    });
  };

  /** Build the static workshop: wall light, pegboard, frame, hopper, bucket and the empty tray. Returns the bucket for landing feedback. */
  const buildWorkshop = (ctx) => {
    const { make } = ctx;
    const stage = make.stage({ sky: LOOK.wall, sun: [-5, 8, 14], ambient: 0.8, shadow: 9 });
    stage.follow({ x: 0, y: (VIEW.top + VIEW.bottom) / 2, z: 0 });
    const backZ = -TUNING.partDepth / 2 - 0.1;
    const pegboard = make.box(2 * HALF_WIDTH, 2 * HALF_HEIGHT, 0.1, make.mat(0xffffff, { fresh: true, rough: 0.85 }), { at: [0, 0, backZ] });
    pegboard.material.map = make.canvasTexture(64 * BOARD.cols, 64 * BOARD.rows, paintPegboard);
    const frameWood = make.mat(LOOK.frame, { rough: 0.7 });
    [-1, 1].forEach((side) => make.box(WALL.thickness, 2 * HALF_HEIGHT + 2 * WALL.thickness, TUNING.partDepth + 0.2, frameWood, { at: [side * (HALF_WIDTH + WALL.thickness / 2), 0, 0] }));
    make.box(2 * HALF_WIDTH, WALL.thickness, 0.3, frameWood, { at: [0, HALF_HEIGHT + WALL.thickness / 2, backZ] });
    make.box(HOPPER_LOOK.box.width, HOPPER_LOOK.box.height, HOPPER_LOOK.depth, LOOK.hopper, { at: [HOPPER.x, HOPPER.y + HOPPER_LOOK.box.lift, 0] });
    make.box(HOPPER_LOOK.spout.width, HOPPER_LOOK.spout.height, HOPPER_LOOK.depth, LOOK.frame, { at: [HOPPER.x, HOPPER.y + HOPPER_LOOK.spout.lift, 0] });
    // Bucket: two sides and a floor, drawn around the scoring gap (its rims are real colliders in the simulation).
    const bucket = make.group({ at: [BUCKET.x, BUCKET.rimY, 0] });
    const bucketDepth = BUCKET.rimY - BUCKET.floorY;
    [-1, 1].forEach((side) => make.box(BUCKET_LOOK.wall, bucketDepth, BUCKET_LOOK.depth, LOOK.bucket, { parent: bucket, at: [side * BUCKET.halfWidth, -bucketDepth / 2, 0] }));
    make.box(2 * BUCKET.halfWidth + BUCKET_LOOK.wall, BUCKET_LOOK.wall, BUCKET_LOOK.depth, LOOK.bucket, { parent: bucket, at: [0, -bucketDepth, 0] });
    make.box(TRAY.width, TRAY.height, 0.3, LOOK.trayWood, { at: [0, TRAY.y, -TUNING.partDepth / 2] });
    return { bucket };
  };

  /**
   * The parts tray: one miniature per offered part kind in a wooden box below the board; locked kinds show a knot.
   * @param {Object} ctx
   * @returns {{ show: (slots: { row: Object, isLocked: boolean }[]) => void, kindAt: (point: { x: number, y: number }) => string|null,
   *            slotOf: (kind: string) => { x: number, y: number }|null }}
   */
  const buildTray = (ctx) => {
    const { make } = ctx;
    let slots = [];
    const show = (wanted) => {
      const spacing = Math.min(TRAY.maxSpacing, (TRAY.width - 0.4) / wanted.length);
      const wasShown = new Set(slots.filter((slot) => !slot.isLocked).map((slot) => slot.row.id));
      slots.forEach((slot) => discardGroup(slot.group));
      slots = wanted.map(({ row, isLocked }, index) => {
        const x = (index - (wanted.length - 1) / 2) * spacing;
        const group = isLocked ? new THREE.Group() : buildPartMesh(make, row, pieceColor(row, index % BELL_COLORS.length, false), row.poses[0]);
        if (isLocked) faceOutward(make.cyl(0.14, 0.14, 0.06, LOOK.locked, { parent: group, at: [0, 0, -0.1] }));
        else group.rotation.z = row.poses[0].angle * DEGREES;
        group.position.set(x, TRAY.y, 0.1);
        // Miniatures shrink with the spacing so a full tray of ten still fits the board's width.
        const scale = isLocked ? 1 : spacing * TRAY.miniFill;
        group.scale.setScalar(scale);
        // A part that was not on offer a moment ago pops into its slot.
        if (!isLocked && slots.length && !wasShown.has(row.id)) ctx.tween(group.scale.setScalar(0.01), { x: scale, y: scale, z: scale }, 0.5, 'outBack');
        ctx.scene.add(group);
        return { row, isLocked, group, x, reach: spacing / 2 };
      });
    };
    const kindAt = (point) => {
      const slot = slots.find((candidate) => Math.abs(candidate.x - point.x) < candidate.reach && Math.abs(TRAY.y - point.y) < TRAY.reach);
      return slot && !slot.isLocked ? slot.row.id : null;
    };
    const slotOf = (kind) => {
      const slot = slots.find((candidate) => candidate.row.id === kind);
      return slot ? { x: slot.x, y: TRAY.y } : null;
    };
    return { show, kindAt, slotOf };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // HUD theme: a wooden toy workshop. Painted wood tags, a chalk slate for goals, a glass jar for the score.
  // ---------------------------------------------------------------------------------------------------------------

  const JAR_LABEL = 'Jar';
  const WOOD = 'linear-gradient(180deg, #ecc98f 0%, #d9ad6c 100%)';
  const THEME = {
    skin: 'toy',
    fonts: ['Londrina Solid:wght@400;900', 'Gochi Hand', 'Nunito:wght@700;800'],
    tokens: {
      '--display': '"Londrina Solid", "Trebuchet MS", sans-serif',
      '--body': '"Nunito", system-ui, sans-serif',
      '--chalk': '"Gochi Hand", "Comic Sans MS", cursive',
      '--panel': WOOD,
      '--ink': '#4a2f17',
      '--dim': '#8a6a45',
      '--line': '#a8743c',
      '--accent': '#d9482b',
      '--accent-ink': '#fff4dc',
      '--accent-edge': '#8f2a16',
      '--scrim': 'rgba(46, 28, 12, 0.6)',
      '--radius': '7px',
      '--radius-lg': '9px',
      '--border': '2px',
      '--shadow': '0 3px 0 #96652f, 0 6px 10px rgba(46, 28, 12, 0.35)',
      '--stat-size': '20px',
      '--label-spacing': '0.04em',
      '--floater': '#fff4dc',
    },
    layout: { stats: 'top-right', actions: 'bottom-right' },
    components: {
      // The score is a glass jar that fills with the marbles that landed; every other stat is a painted wooden tag.
      stat: ({ label, value, h }) => {
        if (label !== JAR_LABEL) return null;
        const jar = h('div', 'stat jar');
        const glass = h('div', 'jar-glass');
        glass.append(h('div', 'jar-marbles'));
        jar.append(h('div', 'jar-lid'), glass, value);
        return jar;
      },
    },
    css: `
      & #stats { align-items: flex-start; }
      & .stat { transform: rotate(1.5deg); letter-spacing: 0.02em; }
      & .stat.jar { transform: none; background: none; border: 0; box-shadow: none; padding: 0; min-width: 0; align-items: center; gap: 0; }
      & .jar-lid { width: 34px; height: 7px; border-radius: 3px 3px 0 0; background: #d9482b; box-shadow: inset 0 -2px 0 #8f2a16; }
      & .jar-glass { width: 46px; height: 42px; border: 2px solid rgba(255, 255, 255, 0.75); border-radius: 5px 5px 13px 13px; background: linear-gradient(90deg, rgba(255,255,255,0.32), rgba(190,225,255,0.12) 40%, rgba(255,255,255,0.2)); display: flex; align-items: flex-end; padding: 2px; }
      & .jar-marbles { display: flex; flex-wrap: wrap-reverse; gap: 1px; justify-content: center; width: 100%; }
      & .jar-marbles i { width: 9px; height: 9px; border-radius: 50%; box-shadow: inset -2px -2px 0 rgba(0, 0, 0, 0.22), inset 1px 1px 0 rgba(255, 255, 255, 0.6); animation: jar-drop 0.3s cubic-bezier(.3, 1.6, .5, 1); }
      @keyframes jar-drop { from { transform: translateY(-34px); } }
      & .stat.jar b { margin-top: 3px; padding: 0 8px; border-radius: 4px; background: #fff4dc; color: #4a2f17; font-size: 17px; box-shadow: 0 2px 0 rgba(46, 28, 12, 0.3); }
      & .chip { font-family: var(--display); font-weight: 400; letter-spacing: 0.03em; }
      & .checklist { position: absolute; left: 0; top: -26px; max-width: 58%; padding: 7px 11px; gap: 3px; background: #33413a; color: #f4efe0; border: 5px solid #a8743c; border-radius: 4px; box-shadow: inset 0 0 14px rgba(0, 0, 0, 0.45), 0 3px 0 #7d5425; font: 15px/1.1 var(--chalk); }
      & .checklist .done, & .checklist div:not(.done) ~ div:not(.done) ~ div:not(.done) { display: none; }
      & .checklist i { flex: none; width: 11px; height: 11px; border: 1.5px solid rgba(244, 239, 224, 0.75); border-radius: 2px; }
      & .tune-card { position: absolute; right: 0; top: 6px; padding: 5px 9px 6px; background: #fff4dc; color: #4a2f17; border-radius: 3px; transform: rotate(-2deg); box-shadow: 0 2px 5px rgba(46, 28, 12, 0.45); font: 800 11px var(--body); display: flex; flex-direction: column; gap: 4px; align-items: center; }
      & .checklist[hidden] { display: none; }
      & .board-slate .tally { font-size: 21px; letter-spacing: 0.08em; }
      & .tune-card .par { font-weight: 700; color: #8a6a45; }
      & .tune-card::before { content: ''; position: absolute; top: -5px; width: 9px; height: 9px; border-radius: 50%; background: #d9482b; box-shadow: 0 1px 0 #8f2a16; }
      & .tune-card div { display: flex; gap: 4px; }
      & .tune-card i { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font: 400 11px var(--display); color: #fff; text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45); box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.2); }
      & .action { flex: 0 1 auto; min-width: 0; padding: 7px 11px 5px; border-color: var(--line); }
      & .action b { font: 400 16px var(--display); letter-spacing: 0.03em; white-space: nowrap; }
      & .action span:empty { display: none; }
      & .hint { left: 128px; top: 44px; bottom: auto; box-sizing: border-box; max-width: 140px; padding: 6px 10px; background: #fff4dc; border: 0; border-radius: 3px; font: 14px/1.1 var(--chalk); color: #4a2f17; }
      & .toast { font-weight: 900; color: #fff4dc; text-shadow: 0 3px 0 #4a2f17; }
      & .modal-card { padding: 20px 18px 18px; background: ${WOOD}; border: 3px solid #a8743c; border-radius: 10px; box-shadow: 0 6px 0 #7d5425, 0 14px 30px rgba(0, 0, 0, 0.5); }
      & .modal-card h2 { font-weight: 900; color: #4a2f17; }
      & .modal-card .rows { background: #33413a; color: #f4efe0; border: 4px solid #a8743c; border-radius: 4px; box-shadow: inset 0 0 14px rgba(0, 0, 0, 0.45); font: 17px var(--chalk); }
      & .modal-card .rows span { color: rgba(244, 239, 224, 0.75); }
      & .modal-card .rows b { font-family: var(--chalk); }
      & .primary { font-weight: 400; letter-spacing: 0.05em; }
      & .choice { background: #fff4dc; border: 0; border-left: 6px solid #d9482b; border-radius: 4px; box-shadow: 0 2px 0 rgba(46, 28, 12, 0.3); color: #4a2f17; }
      & .choice b { font-weight: 400; letter-spacing: 0.03em; }
      & .choice em { color: #b8860b; font-size: 15px; letter-spacing: 0.1em; }
      & .choice:disabled { border-left-color: #8a6a45; }
    `,
  };

  /** Hex colour number -> CSS colour. */
  const cssColor = (hex) => '#' + hex.toString(16).padStart(6, '0');

  // ---------------------------------------------------------------------------------------------------------------
  // Game: wires simulation, view, input, modes and HUD together.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * World height the camera must show so the board, bucket and tray fit between the HUD bands.
   * @param {{ w: number, h: number, aspect: number, portrait: boolean }} size
   * @returns {number} world units visible top to bottom.
   */
  const viewSpan = (size) => {
    const reserve = VIEW.reserve[size.portrait ? 'portrait' : 'landscape'];
    const usableFraction = 1 - (reserve.top + reserve.bottom) / size.h;
    return Math.max((VIEW.top - VIEW.bottom) / usableFraction, VIEW.width / size.aspect);
  };

  const create = (ctx) => {
    const { make, input, fx, sfx, ui, save, scene } = ctx;
    ctx.ortho(viewSpan, 'height');
    ctx.post.bloom(0); // painted wood and brass: nothing in this workshop glows
    const aimCamera = () => {
      const reserve = VIEW.reserve[ctx.size.portrait ? 'portrait' : 'landscape'];
      // Shift the framing down by half the difference between the HUD bands so the play area sits between them.
      const centreY = (VIEW.top + VIEW.bottom) / 2 + (((reserve.top - reserve.bottom) / 2) * viewSpan(ctx.size)) / ctx.size.h;
      ctx.camera.position.set(0, centreY + VIEW.cameraRise, VIEW.cameraDistance);
      ctx.camera.lookAt(0, centreY, 0);
    };
    aimCamera();
    ctx.on('resize', aimCamera);

    // ---- models: what persists and what mode we are in ----
    const profile = Kit.profile({
      save,
      achievements: RULES.ACHIEVEMENTS,
      levelCurve: RULES.PROGRESS.levelCurve,
      onUnlock: (id) => announceUnlock(id),
      onLevel: (level) => ui.toast(`Level ${level}: more pegs`),
    });
    const boards = Kit.levels(RULES.BOARDS, { save, key: 'boards' });
    const history = Kit.history();
    /** The challenge board being played, or null in free build. */
    let board = null;
    let layout = RULES.sanitizeLayout(save.get('layout')) || RULES.STARTER_LAYOUT;
    let streak = 0;
    let isBoardSolved = false;
    let score = 0;
    let songIndex = save.get('song', 0) % RULES.SONGS.length;
    let mixIndex = save.get('mix', 0);

    const isInFreeTray = (row) => !!row.starter || profile.isUnlocked(row.id);
    const availableMixes = () => RULES.HOPPER_MIXES.filter((mix) => mix.pattern.every((kind) => kind === 'glass' || profile.isUnlocked(kind)));
    const currentMix = () => availableMixes()[mixIndex % availableMixes().length];
    const budget = () => (board ? board.budget : RULES.PROGRESS.freeBudget(profile.level - 1));
    const pattern = () => (board ? board.pattern : currentMix().pattern);
    const traySlots = () => (board ? board.tray.map((id) => ({ row: PART_TABLE.byId(id), isLocked: false })) : PARTS.map((row) => ({ row, isLocked: !isInFreeTray(row) })));
    const saveKey = () => (board ? `attempt:${board.id}` : 'layout');
    const simulation = RULES.createSimulation(layout, { pattern: pattern() });

    // ---- view ----
    const { bucket } = buildWorkshop(ctx);
    const tray = buildTray(ctx);
    const partViews = new Map(); // piece id -> { signature, group }
    const wireGroup = make.group();
    const wireMaterials = { idle: make.unlit(LOOK.wire, { opacity: 0.35 }), lit: make.unlit(LOOK.wire, { bright: 1.6 }) };
    const marbleMaterials = Object.fromEntries(Object.entries(MARBLE_LOOKS).map(([kind, look]) => [kind, look.colors.map((color) => make.mat(color, { rough: look.rough, metal: look.metal }))]));
    const marbleMeshes = ctx.pool(() => make.sphere(TUNING.marbleRadius, marbleMaterials.glass[0]));
    const marbleViews = new Map(); // marble id -> mesh
    const cellMarker = make.box(BOARD.cell * 0.94, BOARD.cell * 0.94, 0.04, make.unlit(LOOK.validCell, { opacity: 0.4, fresh: true }), { shadow: false, at: [0, 0, -TUNING.partDepth / 2] });
    cellMarker.visible = false;

    const pulse = (group) => {
      group.scale.setScalar(LOOK.pulseScale);
      ctx.tween(group.scale, { x: 1, y: 1, z: 1 }, 0.28, 'outBack');
    };
    const ringBell = (column, octave = 0) => {
      const frequency = BELL_SCALE(column) * Math.pow(2, octave);
      sfx.tone({ freq: frequency, dur: BELL_VOICE.ring, type: 'sine', vol: BELL_VOICE.volume });
      sfx.tone({ freq: frequency * BELL_VOICE.partialRatio, dur: BELL_VOICE.partialRing, type: 'sine', vol: BELL_VOICE.partialVolume });
    };
    const showPiece = (piece) => {
      const row = PART_TABLE.byId(piece.kind);
      const group = buildPartMesh(make, row, pieceColor(row, piece.x, piece.fixed), poseOf(piece));
      const centre = cellCentre(piece);
      group.position.set(centre.x, centre.y, 0);
      group.rotation.z = poseOf(piece).angle * DEGREES;
      scene.add(group);
      partViews.set(piece.id, { signature: JSON.stringify(piece), group });
      pulse(group);
    };
    /** Draw one thin line per wire, behind the parts, so the player can see what a bell or counter drives. */
    const showWires = () => {
      [...wireGroup.children].forEach(discardGroup);
      const pieceById = new Map(layout.map((piece) => [piece.id, piece]));
      RULES.wiresOf(layout).forEach((wire) => {
        const from = cellCentre(pieceById.get(wire.from)), to = cellCentre(pieceById.get(wire.to));
        const line = make.box(Math.hypot(to.x - from.x, to.y - from.y), LOOK.wireWidth, 0.02, wireMaterials.idle, { parent: wireGroup, shadow: false, at: [(from.x + to.x) / 2, (from.y + to.y) / 2, -TUNING.partDepth / 2] });
        line.rotation.z = Math.atan2(to.y - from.y, to.x - from.x);
        line.userData.from = wire.from;
      });
    };
    /** Bring meshes, wires and colliders in line with `layout` (only pieces whose data changed are rebuilt). */
    const syncBoard = () => {
      const wanted = new Map(layout.map((piece) => [piece.id, JSON.stringify(piece)]));
      [...partViews]
        .filter(([id, view]) => wanted.get(id) !== view.signature)
        .forEach(([id, view]) => {
          discardGroup(view.group);
          partViews.delete(id);
        });
      layout.filter((piece) => !partViews.has(piece.id)).forEach(showPiece);
      showWires();
      simulation.setLayout(layout);
    };

    // ---- HUD ----
    const jarStat = ui.stat(JAR_LABEL, 0);
    const jarMarbles = jarStat.el.querySelector('.jar-marbles');
    const pegStat = ui.stat('Pegs', '');
    const levelStat = ui.stat('Level', profile.level);
    const hint = ui.hint('Drag a part up from the tray. Tap one to turn it.');
    const card = ui.el('div', 'tune-card');
    const boardSlate = ui.el('div', 'checklist board-slate');
    const noteDot = (column) => Object.assign(ui.h('i', null, BELL_SCALE.noteName(column).charAt(0)), { style: `background:${cssColor(BELL_COLORS[column])}` });
    /** The pinned card: the current song in free build, the board's name and par on a challenge board. */
    const showCard = () => {
      if (board) return card.replaceChildren(ui.h('span', null, board.name), ui.h('span', 'par', `Par ${board.par} pegs`));
      const song = RULES.SONGS[songIndex];
      const dots = ui.h('div');
      dots.append(...song.degrees.map(noteDot));
      return card.replaceChildren(ui.h('span', null, `Song ${songIndex + 1}: ${song.name}`), dots);
    };
    const showSlate = () => {
      boardSlate.hidden = !board;
      goalList.el.hidden = !!board;
      if (board) boardSlate.replaceChildren(ui.h('div', null, board.brief), ui.h('div', 'tally', `${Math.min(streak, board.streak)} / ${board.streak}`));
    };
    const showPegs = () => pegStat.set(`${pegsSpent(layout)}/${budget()}`);
    const addToJar = (color) => {
      // A full jar is tipped out so the row of marbles keeps meaning "recent landings".
      if (jarMarbles.childElementCount >= LOOK.jarCapacity) jarMarbles.replaceChildren();
      jarMarbles.append(Object.assign(ui.h('i'), { style: `background:${cssColor(color)}` }));
    };
    const addScore = (points) => {
      score += points;
      jarStat.set(score);
      jarStat.pulse();
    };
    const gainExperience = (amount) => {
      profile.gainExperience(amount);
      levelStat.set(profile.level);
      showPegs();
    };
    const nameOfUnlock = (id) => (PART_TABLE.has(id) ? PART_TABLE.byId(id).name : RULES.KIND_TABLE.has(id) ? `${RULES.KIND_TABLE.byId(id).name} marbles` : 'Invention slot');
    const announceUnlock = (id) => {
      sfx.play('up');
      ui.toast(`New: ${nameOfUnlock(id)}`);
      if (board) return;
      tray.show(traySlots());
      const slot = tray.slotOf(id);
      if (slot) fx.burst({ x: slot.x, y: slot.y, z: 0.5 }, { count: 14, colors: [CAP_COLOR, PART_TABLE.byId(id).color], speed: 3 });
    };

    const goals = Kit.goals(RULES.GOALS, {
      save,
      onDone: (goal) => {
        profile.unlock(goal.reward);
        gainExperience(RULES.PROGRESS.experiencePerGoal);
      },
    });
    const goalList = ui.checklist(goals);

    // ---- modes ----
    /**
     * Switch bench: a challenge board, or free build when `nextBoard` is null. Each keeps its own saved layout.
     * @param {Object|null} nextBoard a RULES.BOARDS row.
     */
    const openBench = (nextBoard) => {
      board = nextBoard;
      const saved = RULES.sanitizeLayout(save.get(saveKey()));
      // A board attempt stores only the player's pieces: the fixed ones always come from the board row.
      layout = board ? board.fixed.concat((saved || []).filter((piece) => !piece.fixed)) : saved || RULES.STARTER_LAYOUT;
      history.reset(layout);
      simulation.clearMarbles().forEach(releaseMarble);
      simulation.setPattern(pattern());
      streak = 0;
      isBoardSolved = false;
      tray.show(traySlots());
      syncBoard();
      showCard();
      showSlate();
      showPegs();
      bar.set('undo', { disabled: true });
      bar.set('bench', { label: board ? 'Free build' : 'Shelf' });
      if (board) hint.hide();
    };
    const starLine = (earned) => Kit.levels.starText(earned, boards.maxStars);
    /** The board's streak is complete: record pegs against par, pay stars, and offer the next board. */
    const solveBoard = () => {
      isBoardSolved = true;
      const solved = board;
      const starsBefore = boards.stars(solved.id);
      const isFirstSolve = boards.best(solved.id) === null;
      const pegs = pegsSpent(layout);
      const result = boards.complete(solved.id, pegs);
      if (isFirstSolve) profile.count('boards');
      profile.best('stars', boards.totalStars());
      gainExperience(Math.max(0, boards.stars(solved.id) - starsBefore) * RULES.PROGRESS.experiencePerStar);
      sfx.play('win');
      const next = RULES.BOARDS[RULES.BOARDS.indexOf(solved) + 1];
      ui.banner({
        title: `${solved.name} solved`,
        text: pegs <= solved.par ? 'Clean work: at or under par.' : 'It works. Fewer pegs would earn more stars.',
        stats: [['Stars', starLine(result.stars)], ['Pegs used', pegs], ['Par', solved.par]],
        button: next ? `Next: ${next.name}` : 'Back to free build',
      }).then(() => openBench(next || null));
    };
    const chooseBoard = () =>
      Kit.levels.select(ui, boards, { title: 'Workshop boards', current: board ? board.id : undefined, unit: 'pegs' }).then((id) => id && openBench(RULES.BOARDS.find((row) => row.id === id)));

    /** The shelf (free build): saved inventions and what the hopper deals. */
    const openShelf = () =>
      ui.panel({
        title: 'Shelf',
        build(body, close) {
          const addChoice = (title, detail, onPick) => {
            const button = ui.h('button', 'choice');
            button.type = 'button';
            button.append(ui.h('b', null, title), ui.h('span', null, detail));
            button.addEventListener('click', () => {
              onPick();
              close();
            });
            body.append(button);
          };
          const mixes = availableMixes();
          addChoice(`Hopper: ${currentMix().name}`, mixes.length > 1 ? 'Tap to deal the next mix of marbles' : 'Solve boards to earn steel and rubber marbles', () => {
            mixIndex = save.set('mix', (mixIndex + 1) % mixes.length);
            simulation.setPattern(pattern());
          });
          RULES.PROGRESS.inventionSlots
            .filter((slot, index) => index === 0 || profile.isUnlocked(slot))
            .forEach((slot, index) => {
              const stored = RULES.sanitizeLayout(save.get(slot));
              addChoice(`Save to slot ${index + 1}`, stored ? `Replaces an invention of ${stored.length} parts` : 'Empty', () => save.set(slot, layout));
              if (stored) addChoice(`Load slot ${index + 1}`, `${stored.length} parts, ${pegsSpent(stored)} pegs`, () => edit(stored));
            });
        },
      });

    // ---- editing ----
    const commit = (nextLayout) => {
      layout = nextLayout;
      save.set(saveKey(), layout);
      // Any change to the contraption starts the board's count again: a streak must belong to one machine.
      streak = 0;
      isBoardSolved = false;
      syncBoard();
      showPegs();
      showSlate();
      bar.set('undo', { disabled: !history.canUndo() });
    };
    const edit = (nextLayout) => {
      history.push(nextLayout);
      commit(nextLayout);
    };
    const bar = ui.actions([
      { id: 'undo', label: 'Undo', onClick: () => history.canUndo() && commit(history.undo()) },
      { id: 'clear', label: 'Clear', onClick: () => edit(board ? board.fixed : RULES.STARTER_LAYOUT) },
      { id: 'boards', label: 'Boards', onClick: chooseBoard },
      { id: 'bench', label: 'Shelf', onClick: () => (board ? openBench(null) : openShelf()) },
    ]);

    const canAfford = (kind) => pegsSpent(layout) + PART_TABLE.byId(kind).cost <= budget();
    /**
     * What each finished gesture does, keyed by Kit.placement's action type.
     * @type {Object<string, (action: Object) => void>}
     */
    const APPLY = {
      place: ({ held, cell }) => {
        edit(EDITS.place(layout, held.kind, cell));
        sfx.play('thud', { vol: 0.5, pitch: 1.6 });
        if (held.kind === 'bell') ringBell(cell.x);
        goals.track('place');
      },
      move: ({ held, cell }) => {
        edit(EDITS.move(layout, held.piece.id, cell));
        sfx.play('thud', { vol: 0.5, pitch: 1.6 });
        if (held.kind === 'bell') ringBell(cell.x);
      },
      remove: ({ held }) => {
        const centre = cellCentre(held.from);
        fx.burst({ x: centre.x, y: centre.y, z: 0.4 }, { count: 8, color: PART_TABLE.byId(held.kind).color, speed: 2.5 });
        edit(EDITS.remove(layout, held.piece.id));
        sfx.play('whoosh');
      },
      tap: ({ held }) => {
        edit(EDITS.turn(layout, held.piece.id));
        sfx.play('click', { pitch: 1.4 });
      },
      cancel: ({ held }) => {
        sfx.play('click', { pitch: 0.7 });
        // The usual reason a tray part is refused is the budget; say so where the player is looking.
        if (held.source === 'tray' && !canAfford(held.kind)) ui.toast('Not enough pegs');
      },
    };

    const boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const boardPoint = (info) => Kit.placement.pointerOnPlane(ctx.camera, info.nx, info.ny, boardPlane);
    const drag = Kit.placement({
      cellAt: RULES.cellAtPoint,
      trayKindAt: tray.kindAt,
      pieceAt: (cell) => RULES.pieceAt(layout, cell),
      canLift: (piece) => !piece.fixed,
      // Moving a piece never changes stock or pegs; a new piece needs both.
      canPlace: (kind, cell, held) => held.source === 'board' || (RULES.countOfKind(layout, kind) < PART_TABLE.byId(kind).max && canAfford(kind)),
    });
    let carried = null; // { group, column } - the mesh following the finger
    const dropCarried = () => {
      if (carried) discardGroup(carried.group);
      carried = null;
      cellMarker.visible = false;
      partViews.forEach((view) => (view.group.visible = true));
    };
    /** Show the held part under the finger. Bells are rebuilt (and sounded) when the column changes: placing one is already playing. */
    const carry = (hover) => {
      const { held, point, cell, isValid } = hover;
      const row = PART_TABLE.byId(held.kind);
      const pose = held.piece ? poseOf(held.piece) : row.poses[0];
      const column = cell ? cell.x : held.from ? held.from.x : 0;
      const needsRebuild = !carried || (row.id === 'bell' && carried.column !== column);
      if (needsRebuild) {
        if (carried && cell) ringBell(column);
        if (carried) discardGroup(carried.group);
        carried = { group: buildPartMesh(make, row, pieceColor(row, column, false), pose), column };
        carried.group.rotation.z = pose.angle * DEGREES;
        scene.add(carried.group);
      }
      carried.group.position.set(point.x, point.y, LOOK.carryLift);
      if (held.piece) partViews.get(held.piece.id).group.visible = false;
      cellMarker.visible = !!cell;
      if (!cell) return;
      const centre = cellCentre(cell);
      cellMarker.position.set(centre.x, centre.y, cellMarker.position.z);
      cellMarker.material.color.copy(make.color(isValid ? LOOK.validCell : LOOK.invalidCell));
    };
    input.onDrag((info) => {
      const point = boardPoint(info);
      if (!point) return;
      if (info.phase === 'start') {
        if (drag.begin(point)) hint.hide();
        return;
      }
      if (info.phase === 'move') {
        const hover = drag.move(point);
        if (hover && hover.isDragging) carry(hover);
        return;
      }
      const action = drag.end(point);
      dropCarried();
      if (action) APPLY[action.type](action);
    });
    // The hopper is a button too: tap it for an extra marble, to play along or to catch a gate while it is open.
    input.onTap((info) => {
      const point = boardPoint(info);
      const isOnHopper = point && Math.abs(point.x - HOPPER.x) < HOPPER_LOOK.tapReach.x && Math.abs(point.y - (HOPPER.y + HOPPER_LOOK.box.lift)) < HOPPER_LOOK.tapReach.y;
      if (isOnHopper && simulation.dropMarble()) sfx.play('tap', { pitch: 0.8 });
    });

    // ---- feedback for simulation events ----
    const viewOf = (part) => partViews.get(part.piece.id);
    function releaseMarble(marble) {
      marbleMeshes.release(marbleViews.get(marble.id));
      marbleViews.delete(marble.id);
    }
    const marbleColorIndex = (marble) => marble.id % MARBLE_LOOKS[marble.kind.id].colors.length;
    /** A song is played when one marble's notes end with it: replay it an octave up, pay the bonus, turn the page. */
    const checkSong = (marble, position) => {
      const song = RULES.SONGS[songIndex];
      if (board || !RULES.endsWith(marble.notes, song.degrees)) return;
      song.degrees.forEach((column, index) => sfx.tone({ freq: BELL_SCALE(column) * 2, dur: 0.3, type: 'triangle', vol: 0.2, delay: 0.25 + index * 0.13 }));
      fx.floater(`${song.name}! +${song.bonus}`, position, { size: 24 });
      addScore(song.bonus);
      profile.count('songs');
      const songsPlayed = save.get('songsPlayed', []);
      gainExperience(RULES.songExperience(song, !songsPlayed.includes(song.id)));
      save.set('songsPlayed', [...new Set(songsPlayed.concat(song.id))]);
      songIndex = save.set('song', (songIndex + 1) % RULES.SONGS.length);
      showCard();
      marble.notes.length = 0; // the same marble cannot score the same run of notes twice
    };
    /**
     * Sound and motion for a part being touched, keyed by part id; parts without a row get the wooden tock.
     * @type {Object<string, (event: Object) => void>}
     */
    const TOUCH_FEEDBACK = {
      bell: ({ marble, part }) => {
        ringBell(part.piece.x, marble.kind.octave);
        fx.burst(part.body.position, { count: 5, color: BELL_COLORS[part.piece.x], speed: 2, size: 0.09, life: 0.4 });
        if (!board) goals.track('ring', 1, { bells: new Set(marble.notes).size });
        checkSong(marble, part.body.position);
      },
      bumper: () => sfx.play('tap', { pitch: 0.7, vol: 0.8 }),
      booster: () => sfx.play('whoosh', { pitch: 1.5 }),
      portal: ({ part, exit }) => {
        sfx.tone({ freq: 300, to: 900, dur: 0.18, type: 'sine', vol: 0.2 });
        pulse(viewOf(exit).group);
        fx.burst(exit.body.position, { count: 8, color: part.row.color, speed: 2.5, gravity: 0 });
        if (!board) goals.track('portal');
      },
      splitter: () => sfx.play('click', { pitch: 1.1 }),
      counter: ({ part }) => {
        const every = poseOf(part.piece).every;
        // Counts run 1..every and then start again; the pips show how close the next pulse is.
        const shown = ((part.count - 1) % every) + 1;
        sfx.tone({ freq: 500 + shown * 120, dur: 0.06, type: 'square', vol: 0.1 });
        fx.floater(String(shown), part.body.position, { size: 14 });
      },
    };
    const finishMarble = (event) => {
      if (board && !isBoardSolved) {
        streak = RULES.advanceStreak(board, streak, event.outcome);
        showSlate();
        if (streak >= board.streak) solveBoard();
      }
      releaseMarble(event.marble);
    };
    /** @type {Object<string, (event: Object) => void>} */
    const EVENT_FEEDBACK = {
      drop: ({ marble }) => {
        const mesh = marbleMeshes.get();
        mesh.material = marbleMaterials[marble.kind.id][marbleColorIndex(marble)];
        marbleViews.set(marble.id, mesh);
      },
      touch: (event) => {
        const view = viewOf(event.part);
        if (view) pulse(view.group);
        (TOUCH_FEEDBACK[event.part.row.id] || (() => sfx.play('click', { pitch: 0.55, vol: 0.5 })))(event);
      },
      // A pulse lights the emitter's wires for a moment, so cause and effect can be followed by eye.
      pulse: ({ part }) => {
        const wires = wireGroup.children.filter((line) => line.userData.from === part.piece.id);
        wires.forEach((line) => (line.material = wireMaterials.lit));
        ctx.after(LOOK.wireFlash, () => wires.forEach((line) => (line.material = wireMaterials.idle)));
      },
      gate: ({ part }) => {
        const view = viewOf(part);
        if (!view) return;
        ctx.tween(view.group.userData.bars[0].scale, { x: part.isOpen ? LOOK.gateOpenScale : 1 }, 0.15);
        sfx.play('click', { pitch: part.isOpen ? 1.8 : 0.9, vol: 0.6 });
      },
      landed: (event) => {
        const { marble, outcome } = event;
        const chain = outcome.kinds.length;
        const points = RULES.pointsFor(outcome);
        addScore(points);
        addToJar(MARBLE_LOOKS[marble.kind.id].colors[marbleColorIndex(marble)]);
        fx.floater(chain > 1 ? `Chain x${chain}  +${points}` : `+${points}`, { x: BUCKET.x, y: BUCKET.rimY + 0.4, z: 0 }, { size: chain > 2 ? 18 : 15 });
        sfx.play('coin', { pitch: 0.8 + chain * 0.1, vol: 0.6 });
        bucket.scale.set(1.12, 0.86, 1);
        ctx.tween(bucket.scale, { x: 1, y: 1 }, 0.3, 'outBack');
        profile.count('landed');
        profile.best('chain', chain);
        if (!board) goals.track('land', 1, { chain, bells: new Set(outcome.notes).size });
        finishMarble(event);
      },
      fell: finishMarble,
      // A marble that was recycled where it sat gets a small puff, so it never just blinks out.
      stuck: (event) => {
        fx.burst(event.marble.body.position, { count: 6, color: CAP_COLOR, speed: 1.5, gravity: 0, life: 0.35 });
        finishMarble(event);
      },
      old: (event) => EVENT_FEEDBACK.stuck(event),
    };

    /** Per-frame poses that follow simulation state rather than events: spinner angle, splitter flag, counter pips. */
    const POSE_PART = {
      spinner: (part, group) => group.quaternion.copy(part.body.quaternion),
      // The flag leans toward the side the next marble will take.
      splitter: (part, group, dt) => (group.userData.flag.rotation.z = ctx.math.damp(group.userData.flag.rotation.z, -part.side * 0.7, 14, dt)),
      counter: (part, group) => group.userData.pips.forEach((pip, index) => pip.scale.setScalar(index < part.count % poseOf(part.piece).every ? 1.5 : 0.8)),
    };

    openBench(null);
    hint.show();

    return {
      update(dt) {
        simulation.step(dt).forEach((event) => EVENT_FEEDBACK[event.type](event));
        simulation.marbles().forEach((marble) => marbleViews.get(marble.id).position.copy(marble.body.position));
        simulation.parts().forEach((part) => {
          const view = viewOf(part);
          if (view && POSE_PART[part.row.id]) POSE_PART[part.row.id](part, view.group, dt);
        });
      },
    };
  };

  Kit.register({
    id: 'marble',
    name: 'Marble Works',
    tagline: 'Build a contraption, hear it play',
    hook: 'Boards, songs and new parts to earn',
    color: '#f59e0b',
    order: 8,
    theme: THEME,
    create,
    /**
     * Headless handle for tools: the rules and simulation the game runs, usable without a browser. `rules` is the
     * whole of MARBLE_RULES; the four named fields are kept for tools written against the first version.
     */
    lab: { rules: RULES, TUNING, STARTER_LAYOUT: RULES.STARTER_LAYOUT, createSimulation: RULES.createSimulation, endsWith: RULES.endsWith },
  });
})();
