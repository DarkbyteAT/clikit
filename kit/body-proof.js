/**
 * Kit body proof: coverage sheets for judging the body system by eye. One polished character proves nothing, so
 * a sheet is a grid of many cells, each one figure of some recipe, seen from some direction, at some moment of
 * some movement. Suites generate the grids that matter: every species turned through eight directions, every
 * option of every socket, every dial at both ends, seeded rolls, and every movement in eight phases.
 *
 * Owns:  `Kit.body.proof.SUITES` and `suite(name, catalog)` (pure: a catalogue -> the cells of a sheet), `ACTS`
 *        (the movements a cell can show, open for other modules to add to), `pose` / `sweep` (a figure at a
 *        moment of a movement, and the room the whole movement needs from a direction), `CATALOGS` (the catalogues a sheet
 *        can be made of) and the `proof` workbench screen that draws a sheet (`Kit.currentGame.show(job)`).
 * Does not own: the catalogues, baking, drawing or movement themselves; taking the pictures (tools/dev/proof.js).
 *
 * Used by `node tools/dev.js proof <suite> [--catalog wardrobe] [--preset toon]`, which writes shots/proof/*.png.
 * The suites are pure and unit-tested by tools/test-kit.js; the screen needs THREE.
 */
(() => {
  /** Directions of a turnaround, in turns of a full circle; 0 faces the camera and the figure turns to its left. */
  const DIRECTIONS = Object.freeze([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  /** The three directions that between them show a front, a side and a back. */
  const THREE_VIEWS = Object.freeze([0.07, 0.3, 0.55]);
  /** The sockets the `worn` suite turns all the way round unless told others: garments that hang, and what is carried behind. */
  const WORN_SOCKETS = Object.freeze(['bottom', 'outerwear', 'back']);
  const PHASES = 8;
  const { VECTOR_STRIDE } = Kit.rig;
  const TURN = Math.PI * 2;
  const ROLL_SEED = 20261116;
  const DEFAULT_SEED = 1;
  const GRAVITY = 9.81;
  /** Seconds a movement runs before its first phase is shown, so it has settled into its cycle. */
  const WARM_UP = 2;
  const SIMULATION_STEP = 1 / 60;
  /** Seconds of standing the idle act is shown over. */
  const IDLE_SECONDS = 6;

  const fail = (where, message) => {
    throw new Error(`Kit.body.proof.${where}: ${message}`);
  };

  /**
   * @typedef {Object} ProofCell
   * @property {string} label
   * @property {Object} recipe
   * @property {number} yaw turns of a full circle
   * @property {string} [act='rest'] a key of `ACTS`
   * @property {number} [phase=0] 0..1 through the act's cycle
   */

  /**
   * @typedef {Object} ProofSheet
   * @property {string} title
   * @property {number} columns cells per row
   * @property {('body'|'head'|'swept')} framing `body`: every figure at one scale, cells sized by the largest;
   *   `head`: close on the head; `swept`: each figure fills its own cell, fitted to everything its movement sweeps
   * @property {ProofCell[]} cells
   */

  /** The subject of a species: its default individual. */
  const subjectOf = (species) => ({ species, seed: DEFAULT_SEED });
  const turned = (label, recipe, extra = {}) => DIRECTIONS.map((yaw) => ({ label: `${label} ${Math.round(yaw * 360)}`, recipe, yaw, ...extra }));

  /**
   * The suites. Each is `(catalog, editor, options) -> ProofSheet`; `options.species` narrows a suite to one species.
   * Adding a suite here adds it to the tool.
   */
  const SUITES = Object.freeze({
    /** Every species through eight directions: the back and the sides are judged, not only the front. */
    turn: (_catalog, _editor, { species }) => ({ title: 'Turnaround', columns: DIRECTIONS.length, framing: 'body', cells: species.flatMap((id) => turned(id, subjectOf(id))) }),
    /** The same, close on the head. */
    heads: (_catalog, _editor, { species }) => ({ title: 'Heads', columns: DIRECTIONS.length, framing: 'head', cells: species.flatMap((id) => turned(id, subjectOf(id))) }),
    /** Seeded rolls across the species, three-quarter view: what random generation really gives. */
    rolls: (catalog, _editor, { species, count = 32 }) => {
      const table = catalog.table(species.map((id) => ({ species: id })));
      return {
        title: 'Rolls',
        columns: 8,
        framing: 'body',
        cells: Array.from({ length: count }, (_unused, index) => ({ label: `roll ${index}`, recipe: table.roll(ROLL_SEED, index), yaw: THREE_VIEWS[0] })),
      };
    },
    /** The same rolls close on the head. */
    faces: (catalog, editor, options) => ({ ...SUITES.rolls(catalog, editor, options), title: 'Faces', framing: 'head' }),
    /** Every choice of every socket of each species' subject, from three directions. */
    options: (_catalog, editor, { species }) => ({
      title: 'Options',
      columns: THREE_VIEWS.length * 3,
      framing: 'body',
      cells: species.flatMap((id) =>
        editor
          .schema(subjectOf(id))
          .sockets.flatMap((socket) =>
            socket.choices.flatMap((choice) =>
              THREE_VIEWS.map((yaw) => ({ label: `${id} ${socket.path}: ${choice.id || 'none'}`, recipe: editor.setSocket(subjectOf(id), socket.path, choice.id), yaw }))
            )
          )
      ),
    }),
    /**
     * Every choice of the sockets worn round the body (`options.sockets`, default `WORN_SOCKETS`), through eight
     * directions: what hangs behind a figure, or shows through from behind, is not judged from three views.
     */
    worn: (_catalog, editor, { species, sockets = WORN_SOCKETS }) => ({
      title: 'Worn, all round',
      columns: DIRECTIONS.length,
      framing: 'body',
      cells: species.flatMap((id) =>
        editor
          .schema(subjectOf(id))
          .sockets.filter((socket) => sockets.includes(socket.path))
          .flatMap((socket) => socket.choices.filter((choice) => choice.id).flatMap((choice) => turned(`${id} ${socket.path}: ${choice.id}`, editor.setSocket(subjectOf(id), socket.path, choice.id))))
      ),
    }),
    /** Every dial of each species' subject at its least and its most. */
    extremes: (_catalog, editor, { species }) => ({
      title: 'Dial extremes',
      columns: 8,
      framing: 'body',
      cells: species.flatMap((id) =>
        editor.schema(subjectOf(id)).dials.flatMap((dial) => [
          { label: `${id} ${dial.id} least`, recipe: editor.setDial(subjectOf(id), dial.id, dial.min), yaw: THREE_VIEWS[0] },
          { label: `${id} ${dial.id} most`, recipe: editor.setDial(subjectOf(id), dial.id, dial.max), yaw: THREE_VIEWS[0] },
        ])
      ),
    }),
    /** Every movement each species can do, in eight phases, from the two directions that show that movement best. */
    acts: (catalog, _editor, { species, acts = Object.keys(ACTS).filter((id) => ACTS[id] && !ACTS[id].isUnlisted) }) => {
      const unknown = acts.find((id) => !ACTS[id]);
      if (unknown) fail('suite', `no act "${unknown}". Acts: ${Object.keys(ACTS).join(', ')}.`);
      const bakery = catalog.bakery({ capacity: species.length });
      const canDo = (id, act) => !refusalOf(ACTS[act], bakery.bakeRecipe(subjectOf(id)));
      return {
        title: 'Movement',
        columns: PHASES,
        framing: 'swept',
        cells: species.flatMap((id) =>
          acts
            .filter((act) => canDo(id, act))
            .flatMap((act) =>
              (ACTS[act].views || DEFAULT_VIEWS).flatMap((yaw) =>
                Array.from({ length: PHASES }, (_unused, step) => ({ label: `${id} ${act} ${step}/${PHASES}`, recipe: subjectOf(id), yaw, act, phase: step / PHASES }))
              )
            )
        ),
      };
    },
    /**
     * A keeper's saves: the moment of contact for a grid of shots across a goal scaled to the body, seen from
     * behind (as the game sees its keeper) and from the front. Each label names the form the body chose.
     */
    saves: (catalog, _editor, { species }) => {
      if (!Kit.act || !Kit.act.FAMILIES.save) fail('suite', 'the saves suite needs the `save` family of kit/act-sport.js.');
      const bakery = catalog.bakery({ capacity: species.length });
      const able = species.filter((id) => !refusalOf(ACTS[saveActId(0, 0)], bakery.bakeRecipe(subjectOf(id))));
      return {
        title: 'Saves',
        columns: GOAL_GRID.across.length,
        framing: 'swept',
        cells: able.flatMap((id) =>
          SAVE_VIEWS.flatMap((view) =>
            GOAL_GRID.up.flatMap((_up, row) =>
              GOAL_GRID.across.map((_across, column) => ({
                label: `${id} ${view.name} ${savedBy(bakery.bakeRecipe(subjectOf(id)), column, row)}`,
                recipe: subjectOf(id),
                yaw: view.yaw,
                act: saveActId(column, row),
                phase: 1,
              }))
            )
          )
        ),
      };
    },
  });

  /**
   * The cells of a suite for a catalogue.
   * @param {string} name a key of `SUITES`
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {{species?: string[], count?: number, acts?: string[], sockets?: string[]}} [options] `species`: which (default all);
   *   `sockets`: which socket paths the `worn` suite turns round
   * @returns {ProofSheet}
   * @throws {Error} for an unknown suite or species
   * @complexity O(cells); the options and extremes suites call `editor.schema` once per species
   * @example Kit.body.proof.suite('turn', catalog).cells.length // 8 per species
   */
  const suite = (name, catalog, options = {}) => {
    const make = SUITES[name];
    if (!make) fail('suite', `no suite "${name}". Suites: ${Object.keys(SUITES).join(', ')}.`);
    const known = catalog.speciesIds();
    const species = options.species && options.species.length ? options.species : known;
    const unknown = species.find((id) => !known.includes(id));
    if (unknown) fail('suite', `no species "${unknown}" in this catalogue. Species: ${known.join(', ')}.`);
    return make(catalog, Kit.body.editor(catalog), { ...options, species });
  };

  /** A walking speed for a leg length at a Froude number (kit/gait.js): the same gait on any size of body. */
  const speedAt = (froude) => (bake) => Math.sqrt(froude * GRAVITY * Kit.gait.legs(bake.plan, bake.rest).legLength);

  /**
   * @typedef {Object} ProofAct
   * A movement a cell can show.
   * @property {function(): Object} stage makes the motion stage (kit/motion.js)
   * @property {function(Object): number} speed metres per second for a bake (0: on the spot)
   * @property {function(Object, number): number} cycle seconds of one cycle for a bake at that speed
   * @property {function(Object): void} [begin] called with the motion state once it has settled, before the
   *   cycle that is shown (a one-shot performance starts here)
   * @property {function(Object): ?string} [refusal] why a bake cannot do it, beyond what its stage needs
   * @property {function(Object, Object): void} [anchor] called with the motion state and the figure's local pose
   *   before it is drawn: a movement that carries the body away puts it back in its cell here
   * @property {function(Object, number[]): void} [travel] writes how far the movement has carried the body from
   *   where it began, [x, z] metres in the body's frame: the sheet draws it as a mark on the ground
   * @property {function(Object, number[]): boolean} [point] writes the point the movement is aimed at (a ball),
   *   [x, y, z] metres from where the body began; false when it has none
   * @property {number[]} [views] the two directions its phases are shown from, in turns (default `DEFAULT_VIEWS`)
   * @property {boolean} [isUnlisted] left out of the acts suite unless asked for by id
   */

  /** A three-quarter view and the front: what a movement is shown from unless its row says otherwise. */
  const DEFAULT_VIEWS = Object.freeze([0.2, 0]);
  /** Movements that go sideways are judged from the front; those that go forwards or fold forwards, from the side. */
  const SIDEWAYS_VIEWS = Object.freeze([0, 0.125]);
  const FORWARD_VIEWS = Object.freeze([0.25, 0.125]);
  /** The views of the performances that need other than the default, by id. */
  const VIEWS = Object.freeze({
    dive: SIDEWAYS_VIEWS,
    diveStep: SIDEWAYS_VIEWS,
    parry: SIDEWAYS_VIEWS,
    kick: FORWARD_VIEWS,
    bow: FORWARD_VIEWS,
    sit: FORWARD_VIEWS,
    smother: FORWARD_VIEWS,
    slump: FORWARD_VIEWS,
    catch: FORWARD_VIEWS,
    catchHigh: FORWARD_VIEWS,
  });

  /** Why a bake cannot do an act: the stage's refusal, or the act's own. */
  const refusalOf = (act, bake) => Kit.motion.refusal(act.stage(), bake.plan, bake.rest) || (act.refusal ? act.refusal(bake) : null);

  /** Where the far ball of the `kickRunUp` act lies, in leg lengths ahead. */
  const FAR_BALL_LEGS = 3.4;
  /** The low shot of the `diveLow` act, in statures: to the body's right, near the ground. */
  const LOW_SHOT = Object.freeze({ aside: 1.3, up: 0.16, ahead: 0.1 });
  /** A ball's middle above the ground and to the kicking side, in leg lengths (the kick's own default). */
  const BALL_LEGS = 0.25;

  /** A performance of `Kit.act.REPERTOIRE` as an act: a whole character standing on the spot, the performance played from its start; `pointOf` (an `ActRig` -> [x, y, z]) gives its target when the default is not wanted. */
  const performanceAct = (id, pointOf) => ({
    stage: () => Kit.act.character({ fidgets: [] }),
    speed: () => 0,
    cycle: () => Kit.act.REPERTOIRE[id].seconds,
    begin: (motion) => Kit.act.play(motion, id, pointOf ? { target: pointOf(Kit.act.rig(motion.plan, motion.rest)) } : undefined),
    refusal: (bake) => Kit.act.refusal(id, bake.plan, bake.rest),
    // A kick's step or a dive's flight would leave the cell: the body stays in it, and the ground mark shows the distance.
    anchor: (motion, local) => Kit.act.keepInPlace(motion, local),
    travel: (motion, out) => Kit.act.rootMotion(motion, out),
    point: (motion, out) => Kit.act.point(motion, 'target', out),
    views: VIEWS[id],
  });

  /**
   * The shots of the saves suite: fractions of half a goal's width to the keeper's left and of its height. The
   * goal is a football goal (7.32 m by 2.44 m for a 1.8 m keeper) scaled to the body's stature.
   */
  const GOAL_GRID = Object.freeze({ across: Object.freeze([0.95, 0.5, 0, -0.5, -0.95]), up: Object.freeze([0.95, 0.5, 0.08]), halfWidth: 3.66 / 1.8, height: 2.44 / 1.8, ahead: 0.15 });
  const SAVE_VIEWS = Object.freeze([
    { name: 'behind', yaw: 0.5 },
    { name: 'front', yaw: 0 },
  ]);
  const saveActId = (column, row) => `save:${column}:${row}`;
  /** Where shot (column, row) of the grid is for a measured body, from where it stands. */
  const shotAt = (measured, column, row) => [
    GOAL_GRID.across[column] * GOAL_GRID.halfWidth * measured.stature,
    GOAL_GRID.up[row] * GOAL_GRID.height * measured.stature,
    GOAL_GRID.ahead * measured.high,
  ];
  /** The form of the `save` family a bake chooses for a shot. */
  const savedBy = (bake, column, row) => {
    const motion = Kit.motion.state(bake, Kit.act.character({ fidgets: [] }));
    return Kit.act.choose(motion, 'save', { target: shotAt(Kit.act.rig(bake.plan, bake.rest), column, row) });
  };
  /** One shot of the grid as an act: the `save` family played at it, its cycle ending at the chosen form's contact. */
  const saveAct = (column, row) => ({
    ...performanceAct('dive'),
    cycle: (bake) => Kit.act.marks(savedBy(bake, column, row)).contact,
    begin: (motion) => Kit.act.play(motion, 'save', { target: shotAt(Kit.act.rig(motion.plan, motion.rest), column, row) }),
    refusal: (bake) => (savedBy(bake, column, row) ? null : 'this body can do no form of a save'),
    views: undefined,
    isUnlisted: true,
  });

  /**
   * The movements a cell can show, by id. Open: a module that adds a movement adds a row (`Kit.body.proof.ACTS.wave = ...`),
   * and the `acts` suite shows it for every species it fits. `rest` is the rest pose and needs no stage.
   * @type {Object<string, ?ProofAct>}
   */
  const ACTS = {
    rest: null,
    walk: { stage: () => Kit.gait.walk(), speed: speedAt(0.2), cycle: (bake, speed) => Kit.gait.strideLength(speed, Kit.gait.legs(bake.plan, bake.rest).legLength) / speed },
    run: { stage: () => Kit.gait.walk(), speed: speedAt(1.6), cycle: (bake, speed) => Kit.gait.strideLength(speed, Kit.gait.legs(bake.plan, bake.rest).legLength) / speed },
    swim: { stage: () => Kit.swim.swim(), speed: () => 1, cycle: () => 1 },
  };
  if (Kit.act) {
    // Standing with nothing asked of it: breathing, a weight shift, a gaze and blinks over six seconds.
    ACTS.idle = { stage: () => Kit.act.character({ fidgets: [] }), speed: () => 0, cycle: () => IDLE_SECONDS };
    // A wave laid over a walk: the legs keep walking, one arm is taken over.
    ACTS.walkWave = {
      ...ACTS.walk,
      stage: () => Kit.act.character({ fidgets: [] }),
      cycle: () => Kit.act.REPERTOIRE.wave.seconds,
      begin: (motion) => Kit.act.play(motion, 'wave'),
      refusal: (bake) => Kit.act.refusal('wave', bake.plan, bake.rest),
    };
    Object.keys(Kit.act.REPERTOIRE).forEach((id) => (ACTS[id] = performanceAct(id)));
    // The same rows with their point somewhere else: a ball three strides away is run up to, a low shot is dived at low.
    ACTS.kickRunUp = performanceAct('kick', (measured) => [-BALL_LEGS * measured.unit, BALL_LEGS * measured.unit, FAR_BALL_LEGS * measured.unit]);
    ACTS.diveLow = performanceAct('dive', (measured) => [-LOW_SHOT.aside * measured.stature, LOW_SHOT.up * measured.stature, LOW_SHOT.ahead * measured.stature]);
    if (Kit.act.FAMILIES.save) GOAL_GRID.up.forEach((_up, row) => GOAL_GRID.across.forEach((_across, column) => (ACTS[saveActId(column, row)] = saveAct(column, row))));
  }

  /**
   * Runs an act on a bake from a standing start to a phase of its cycle, so the same cell is the same picture
   * every time.
   * @param {Object} bake
   * @param {ProofAct} act
   * @param {number} phase 0..1
   * @param {function(Object): void} [each] called with the motion state after every step of the cycle shown
   * @returns {Object} the `MotionState` at that phase
   */
  const runAct = (bake, act, phase, each) => {
    const speed = act.speed(bake);
    const motion = Kit.motion.state(bake, act.stage());
    const simulate = (from, until, seen) => {
      for (let time = from; time < until; time += SIMULATION_STEP) {
        Kit.motion.advance(motion, SIMULATION_STEP, 0, 0, speed * (time + SIMULATION_STEP), 0);
        if (seen) seen(motion);
      }
    };
    simulate(0, WARM_UP);
    if (act.begin) act.begin(motion);
    if (each) each(motion);
    simulate(WARM_UP, WARM_UP + phase * act.cycle(bake, speed), each);
    return motion;
  };

  /**
   * @typedef {Object} ProofPose
   * @property {?string} refusal why the body cannot do the act (the figure is then at rest), or null
   * @property {number[]} travel [x, z]: how far the act has carried the body from where it began, metres in the
   *   body's frame; the figure itself is drawn in place
   * @property {?number[]} point [x, y, z]: what the act is aimed at, metres from where the body is DRAWN; or null
   * @property {number[]} origin [x, y, z]: where the bake's own origin (the ground under it) is in the figure's
   *   space - a figure is centred and grounded by its rest pose, a moving body stands by its legs
   */

  /**
   * Poses a figure at a phase of an act.
   * @param {Object} figure from `Kit.figure.build`
   * @param {string} actId a key of `ACTS`
   * @param {number} phase 0..1
   * @returns {ProofPose}
   * @complexity O(seconds simulated / SIMULATION_STEP) motion steps
   * @example Kit.body.proof.pose(figure, 'kick', 0.5).travel // [x, z] the kick has stepped by then
   */
  const pose = (figure, actId, phase) => {
    const act = ACTS[actId];
    const posed = { refusal: null, travel: [0, 0], point: null, origin: [0, 0, 0] };
    // The root bone has no parent: where the figure drew it, less where the pose has it, is where the figure put the origin.
    const locate = () => posed.origin.forEach((_unused, axis) => (posed.origin[axis] = figure.world.translation[axis] - figure.local.translation[axis]));
    figure.rest();
    if (!act) {
      figure.pose();
      locate();
      return posed;
    }
    const { bake } = figure;
    posed.refusal = refusalOf(act, bake);
    if (posed.refusal) {
      figure.pose();
      locate();
      return posed;
    }
    const motion = runAct(bake, act, phase);
    Kit.rig.copy(motion.pose, figure.local);
    if (act.anchor) act.anchor(motion, figure.local);
    if (act.travel) act.travel(motion, posed.travel);
    else posed.travel[1] = act.speed(bake) * phase * act.cycle(bake, act.speed(bake));
    const aimed = [0, 0, 0];
    if (act.point && act.point(motion, aimed)) posed.point = [aimed[0] - posed.travel[0], aimed[1], aimed[2] - posed.travel[1]];
    if (figure.face) figure.face(Kit.act ? Kit.act.face(motion) : null);
    figure.pose();
    locate();
    return posed;
  };

  /**
   * Poses a figure at a phase of an act by simulating it from a standing start.
   * @param {Object} figure from `Kit.figure.build`
   * @param {string} actId a key of `ACTS`
   * @param {number} phase 0..1
   * @returns {?string} why the body cannot do it (the stage's refusal), or null when posed
   * @complexity as `pose`
   * @example Kit.body.proof.perform(figure, 'walk', 0.25)
   */
  const perform = (figure, actId, phase) => pose(figure, actId, phase).refusal;

  /**
   * @typedef {Object} SweptBounds
   * Everything a body's joints pass through over a whole act, seen from one direction, with the body drawn in
   * place: metres in the bake's own space (the ground it stands on at 0), `left`..`right` across the view and
   * `bottom`..`top` up it. `restTop` and
   * `restHalf` are the same body's joints at rest (how far its surface goes beyond its joints is the caller's to add).
   * @property {number} left
   * @property {number} right
   * @property {number} bottom
   * @property {number} top
   * @property {number} restTop
   * @property {number} restHalf
   */

  /**
   * The bounds of an act's whole movement for a bake seen from a direction: what a cell must have room for so
   * that no phase spills out of it. The point the act is aimed at (a ball) is included while it is within a
   * stature of the body.
   * @param {Object} bake
   * @param {string} actId a key of `ACTS` (`rest`, or an act the body cannot do, gives the rest pose's bounds)
   * @param {number} yaw turns of a full circle, as a cell's
   * @returns {SweptBounds}
   * @complexity O(seconds of the act / SIMULATION_STEP * bones)
   * @example const { left, right, top } = Kit.body.proof.sweep(bake, 'dive', 0);
   */
  const sweep = (bake, actId, yaw) => {
    const act = ACTS[actId];
    const { plan, rest } = bake;
    const [cosine, sine] = [Math.cos(yaw * TURN), Math.sin(yaw * TURN)];
    const bounds = { left: Infinity, right: -Infinity, bottom: 0, top: -Infinity, restTop: 0, restHalf: 0 };
    const local = Kit.rig.create(plan.boneCount);
    const world = Kit.rig.create(plan.boneCount);
    const tail = [0, 0, 0];
    const widen = (x, y, z) => {
      const across = x * cosine + z * sine;
      bounds.left = Math.min(bounds.left, across);
      bounds.right = Math.max(bounds.right, across);
      bounds.top = Math.max(bounds.top, y);
    };
    const widenPose = (posed) => {
      Kit.body.worldTransforms(plan, posed, world);
      for (let bone = 0; bone < plan.boneCount; bone++) {
        widen(world.translation[bone * VECTOR_STRIDE], world.translation[bone * VECTOR_STRIDE + 1], world.translation[bone * VECTOR_STRIDE + 2]);
        Kit.body.tailPosition(plan, world, bone, tail);
        widen(tail[0], tail[1], tail[2]);
      }
    };
    widenPose(rest);
    bounds.restTop = bounds.top;
    bounds.restHalf = Math.max(-bounds.left, bounds.right);
    if (!act || refusalOf(act, bake)) return bounds;
    Object.assign(bounds, { left: Infinity, right: -Infinity, top: -Infinity });
    const travel = [0, 0];
    const aimed = [0, 0, 0];
    runAct(bake, act, 1, (motion) => {
      Kit.rig.copy(motion.pose, local);
      if (act.anchor) act.anchor(motion, local);
      widenPose(local);
      if (!act.point || !act.point(motion, aimed)) return;
      if (act.travel) act.travel(motion, travel);
      const [x, z] = [aimed[0] - travel[0], aimed[2] - travel[1]];
      if (Math.hypot(x, z) < bounds.restTop) widen(x, aimed[1], z);
    });
    return bounds;
  };

  /** The catalogues a sheet can be made of, by name; each value makes the raw catalogue data. */
  const CATALOGS = {
    wardrobe: () => Kit.body.wardrobe.CATALOG,
    samples: () => Kit.body.samples.CATALOG,
  };

  Kit.body.proof = { DIRECTIONS, THREE_VIEWS, WORN_SOCKETS, PHASES, DEFAULT_VIEWS, GOAL_GRID, SUITES, ACTS, CATALOGS, suite, perform, pose, sweep };

  // ---- the screen -------------------------------------------------------------------------------------------------------

  if (typeof THREE === 'undefined' || !Kit.ui || !Kit.ui.html || !Kit.look || !Kit.look.view || !Kit.figure || !Kit.figure.build) return;
  const { html, signal } = Kit.ui;

  const BACKDROP_COLOR = 0x6a7399;
  /** Palette rows: an options page of 36 figures at `Kit.figure.RAMP_SLOTS` rows each, with room to spare (the indexed looks address the first `Kit.look.INDEXED_ROWS`, a page of 32). */
  const ATLAS_ROWS = 1024;
  const CAMERA = Object.freeze({ pitchDegrees: 6, distance: 12, near: 0.1, far: 60 });
  const CAMERA_PITCH = (CAMERA.pitchDegrees * Math.PI) / 180;
  /** Room round a figure in its cell, as shares of the largest figure's size; `head` shows this share of the height, from the top. */
  /** `figureShare`: about how tall a standing body is drawn, in cell widths (for choosing its level of detail); `mostAspect`: the widest a cell is made for a long body, in body heights. */
  const CELL = Object.freeze({ sideMargin: 1.15, topMargin: 1.22, headShare: 0.42, headTop: 0.12, leastWidth: 0.5, figureShare: 1.3, mostAspect: 1.3 });
  /**
   * A `swept` cell: one unit high and `aspect` wide. The ground is `floor` up it (the label sits under), the
   * movement is fitted into what is left with `margin` to spare, and the cell is as wide as the widest movement
   * shown needs, within `aspects`. `ball` is the radius of the mark for what an act is aimed at, in statures.
   */
  const SWEPT = Object.freeze({ floor: 0.13, margin: 1.08, aspects: Object.freeze([0.8, 1.5]), ball: 0.09 });
  /** Cell units: the half-size of the cross where a body began, and the least travel worth marking. */
  const MARK_CROSS = 0.03;
  const MARK_LEAST = 0.02;
  /** The marks are drawn in thousandths of a cell's height. */
  const MARK_UNITS = 1000;
  const MARK_STYLE = 'fill:none;stroke:#fff;stroke-opacity:.8;stroke-width:5';

  Kit.register({
    id: 'proof',
    kind: 'workbench',
    name: 'Proof sheet',
    tagline: 'Coverage sheets of the body system',
    hook: 'Turnarounds, options, extremes, rolls and movement, judged by eye',
    color: '#9ad6c0',
    order: 997,
    theme: { skin: 'glass' },
    create(ctx) {
      const { renderer, size } = ctx;
      const view = Kit.look.view({ renderer, preset: 'toon', atlasRows: ATLAS_ROWS });
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);
      const cache = Kit.figure.geometryCache();
      const labels = signal({ columns: 1, rows: 1, texts: [] });
      /** Per cell of a swept sheet: the ground marks to draw over it, in cell units (x across 0..aspect, y down 0..1). */
      const marks = signal({ aspect: 1, cells: [] });
      const sweeps = new Map();
      const sweepOf = (cell, bake) => {
        const key = `${JSON.stringify(cell.recipe)}|${cell.act}|${cell.yaw}`;
        if (!sweeps.has(key)) sweeps.set(key, sweep(bake, cell.act || 'rest', cell.yaw));
        return sweeps.get(key);
      };
      /** @type {Array<{figure: Object, cell: ProofCell, refusal: ?string, posed: ProofPose, scale?: number}>} */
      let shown = [];
      let grid = { columns: 1, rows: 1, cellWidth: 1, cellHeight: 1 };
      const catalogs = new Map();
      const catalogOf = (name) => {
        if (!CATALOGS[name]) fail('show', `no catalogue "${name}". Catalogues: ${Object.keys(CATALOGS).join(', ')}.`);
        if (!catalogs.has(name)) {
          const catalog = Kit.body.catalog(CATALOGS[name]());
          catalogs.set(name, { catalog, bakery: catalog.bakery({ capacity: 256 }) });
        }
        return catalogs.get(name);
      };

      /**
       * Draws one page of a sheet.
       * @param {{catalog?: string, suite?: string, cells?: ProofCell[], species?: string[], sockets?: string[], columns?: number, framing?: string, preset?: string, page?: number, rows?: number, rigid?: boolean, level?: string, cellPixels?: number}} job
       *   `rigid`: draw one rigid piece per bone shape instead of sculpted surfaces (the before of a before / after pair);
       *   `level`: a level of detail, else chosen from `cellPixels` (a cell's width in target pixels) by `Kit.figure.levelFor`
       *   `suite` (with `catalog`) or explicit `cells`; `rows` per page (default 4)
       * @returns {{pages: number, cells: number, columns: number, rows: number, framing: string, aspect: number, refusals: string[]}} `aspect`:
       *   width / height the window should have for square pixels to fill the grid exactly
       */
      const show = (job) => {
        const { catalog, bakery } = catalogOf(job.catalog || 'wardrobe');
        const sheet = job.cells ? { columns: job.columns || 8, framing: job.framing || 'body', cells: job.cells } : suite(job.suite, catalog, job);
        const columns = job.columns || sheet.columns;
        const framing = job.framing || sheet.framing;
        const rowsPerPage = job.rows || 4;
        // A head close-up is drawn at full detail; a body in a cell by how many pixels tall the cell makes it.
        const level = job.level || (framing === 'head' || !job.cellPixels ? undefined : Kit.figure.levelFor(job.cellPixels * CELL.figureShare));
        const perPage = columns * rowsPerPage;
        const pages = Math.max(1, Math.ceil(sheet.cells.length / perPage));
        const cells = sheet.cells.slice((job.page || 0) * perPage, ((job.page || 0) + 1) * perPage);
        if (job.preset) view.use(job.preset);
        shown.forEach((entry) => entry.figure.dispose());
        if (gathered) gathered.dispose();
        gathered = null;
        const refusals = [];
        shown = cells.map((cell) => {
          const figure = Kit.figure.build(view, bakery.bakeRecipe(cell.recipe), { cache, level, sculpt: !job.rigid });
          const posed = pose(figure, cell.act || 'rest', cell.phase || 0);
          if (posed.refusal) refusals.push(`${cell.label}: ${posed.refusal}`);
          figure.root.rotation.y = cell.yaw * TURN;
          figure.root.scale.setScalar(1);
          return { figure, cell, refusal: posed.refusal, posed, scale: 1 };
        });
        if (framing === 'swept') return { pages, refusals, ...showSwept(columns) };
        marks.value = { aspect: 1, cells: [] };
        // Each species is framed to its own bounds: a hound is drawn as large in its cell as a person in theirs.
        // Individuals of one species keep their sizes against each other (a height dial still shows).
        const sizes = new Map();
        shown.forEach((entry) => {
          const size = sizes.get(entry.cell.recipe.species) || { height: 0.1, width: CELL.leastWidth };
          sizes.set(entry.cell.recipe.species, { height: Math.max(size.height, entry.figure.measured.highestY), width: Math.max(size.width, entry.figure.measured.reach * 2) });
        });
        const tallest = Math.max(...[...sizes.values()].map((size) => size.height));
        const widest = Math.min(Math.max(...[...sizes.values()].map((size) => size.width)), tallest * CELL.mostAspect);
        shown.forEach((entry) => {
          const size = sizes.get(entry.cell.recipe.species);
          entry.scale = Math.min(tallest / size.height, widest / size.width);
          entry.figure.root.scale.setScalar(entry.scale);
        });
        const isHead = framing === 'head';
        const cellHeight = isHead ? tallest * CELL.headShare : tallest * CELL.topMargin;
        const cellWidth = isHead ? cellHeight : widest * CELL.sideMargin;
        const rows = Math.max(1, Math.ceil(shown.length / columns));
        grid = { columns, rows, cellWidth, cellHeight };
        shown.forEach((entry, index) => {
          const [column, row] = [index % columns, Math.floor(index / columns)];
          const cellBottom = (rows - 1 - row) * cellHeight;
          entry.figure.root.position.x = (column - (columns - 1) / 2) * cellWidth;
          // Body: feet near the cell's floor. Head: the crown a little under the cell's top.
          entry.figure.root.position.y = isHead ? cellBottom + cellHeight * (1 - CELL.headTop) - entry.figure.measured.highestY * entry.scale : cellBottom + cellHeight * 0.04;
        });
        labels.value = { columns, rows, texts: shown.map((entry) => (entry.refusal ? `${entry.cell.label} (cannot)` : entry.cell.label)) };
        return { pages, cells: shown.length, columns, rows, framing, aspect: (columns * cellWidth) / (rows * cellHeight), refusals };
      };

      /** The crowd drawn by `crowd`, if any (a sheet replaces it and the reverse). */
      let gathered = null;
      /**
       * Draws many figures of one recipe as one `Kit.figure.crowd`, each at its own phase of an act and its own heading.
       * @param {{catalog?: string, recipe: Object, count?: number, columns?: number, act?: string, level?: string, rigid?: boolean, preset?: string, cellPixels?: number}} job
       * @returns {{count: number, columns: number, rows: number, aspect: number, level: string, triangles: number, meshes: number, isSculpted: boolean}}
       *   `triangles` per member; `meshes`: instanced meshes for the whole crowd
       */
      const crowd = (job) => {
        const { bakery } = catalogOf(job.catalog || 'wardrobe');
        const bake = bakery.bakeRecipe(job.recipe);
        const count = job.count || 100;
        const columns = job.columns || Math.ceil(Math.sqrt(count * 2));
        const rows = Math.ceil(count / columns);
        const level = job.level || Kit.figure.levelFor((job.cellPixels || 0) * CELL.figureShare || Infinity);
        if (job.preset) view.use(job.preset);
        shown.forEach((entry) => entry.figure.dispose());
        shown = [];
        if (gathered) gathered.dispose();
        const measure = Kit.figure.build(view, bake, { cache, level: 'low', sculpt: false });
        const [height, width] = [measure.measured.highestY, Math.max(CELL.leastWidth, measure.measured.reach * 2)];
        measure.dispose();
        gathered = Kit.figure.crowd(view, bake, count, { cache, level, sculpt: !job.rigid });
        const [cellWidth, cellHeight] = [Math.min(width, height * CELL.mostAspect) * CELL.sideMargin, height * CELL.topMargin];
        for (let member = 0; member < count; member++) {
          const local = gathered.locals[member];
          // A crowd member is a pose only: it is drawn where the crowd places it, so its local pose stands in for a world one.
          perform({ bake, local, world: local, rest: () => Kit.rig.copy(bake.rest, local), pose() {} }, job.act || 'walk', (member % PHASES) / PHASES);
          const [column, row] = [member % columns, Math.floor(member / columns)];
          gathered.places.set([(column - (columns - 1) / 2) * cellWidth, (rows - 1 - row) * cellHeight + cellHeight * 0.04, 0, ((member * 3) % 8) * (TURN / 8)], member * 4);
        }
        gathered.pose();
        grid = { columns, rows, cellWidth, cellHeight };
        labels.value = { columns, rows, texts: [] };
        return { count, columns, rows, aspect: (columns * cellWidth) / (rows * cellHeight), level, ...gathered.cost };
      };

      /**
       * Lays out the shown figures each in its own frame: scaled so that everything its movement sweeps fits
       * its cell, standing on the cell's floor, with the ground marks of its travel and of what it is aimed at.
       */
      const showSwept = (columns) => {
        const frames = shown.map((entry) => {
          const swept = sweepOf(entry.cell, entry.figure.bake);
          const { measured } = entry.figure;
          const { origin } = entry.posed;
          const [cosine, sine] = [Math.cos(entry.cell.yaw * TURN), Math.sin(entry.cell.yaw * TURN)];
          const beyond = Math.max(0, measured.reach - swept.restHalf);
          const middle = origin[0] * cosine + origin[2] * sine;
          // In the figure's space, the ground the moving body stands on at 0: its surface goes beyond its joints by what the rest pose shows.
          return {
            left: swept.left + middle - beyond,
            right: swept.right + middle + beyond,
            top: swept.top + Math.max(0, measured.highestY - origin[1] - swept.restTop),
            stature: swept.restTop,
            origin,
          };
        });
        const aspect = Math.min(SWEPT.aspects[1], Math.max(SWEPT.aspects[0], ...frames.map((frame) => (frame.right - frame.left) / (frame.top * (1 + SWEPT.floor)))));
        const rows = Math.max(1, Math.ceil(shown.length / columns));
        grid = { columns, rows, cellWidth: aspect, cellHeight: 1 };
        const tilt = Math.tan(CAMERA_PITCH);
        const drawn = shown.map((entry, index) => {
          const frame = frames[index];
          const [column, row] = [index % columns, Math.floor(index / columns)];
          const scale = Math.min(aspect / (frame.right - frame.left), (1 - SWEPT.floor) / frame.top) / SWEPT.margin;
          const { root } = entry.figure;
          const [cellLeft, cellBottom] = [(column - columns / 2) * aspect, rows - 1 - row];
          root.scale.setScalar(scale);
          root.position.x = cellLeft + aspect / 2 - (scale * (frame.left + frame.right)) / 2;
          root.position.y = cellBottom + SWEPT.floor - scale * frame.origin[1];
          // A point of the figure's own space (metres from where it stands) in cell units, as the camera sees it.
          const [cosine, sine] = [Math.cos(entry.cell.yaw * TURN), Math.sin(entry.cell.yaw * TURN)];
          const inCell = (x, y, z) => [
            root.position.x + scale * ((x + frame.origin[0]) * cosine + (z + frame.origin[2]) * sine) - cellLeft,
            1 - SWEPT.floor - scale * (y - (-(x + frame.origin[0]) * sine + (z + frame.origin[2]) * cosine) * tilt),
          ];
          const { travel, point } = entry.posed;
          const hasTravelled = Math.hypot(travel[0], travel[1]) * scale > MARK_LEAST;
          return {
            here: inCell(0, 0, 0),
            from: hasTravelled ? inCell(-travel[0], 0, -travel[1]) : null,
            ball: point ? [...inCell(point[0], point[1], point[2]), SWEPT.ball * frame.stature * scale] : null,
            metres: hasTravelled ? Math.hypot(travel[0], travel[1]) : 0,
          };
        });
        marks.value = { aspect, cells: drawn };
        labels.value = {
          columns,
          rows,
          texts: shown.map((entry, index) => (entry.refusal ? `${entry.cell.label} (cannot)` : drawn[index].metres ? `${entry.cell.label} +${drawn[index].metres.toFixed(2)}m` : entry.cell.label)),
        };
        return { cells: shown.length, columns, rows, framing: 'swept', aspect: (columns * aspect) / rows };
      };

      const fitCamera = () => {
        const [width, height] = [grid.columns * grid.cellWidth, grid.rows * grid.cellHeight];
        const worldPerPixel = Math.max(width / size.w, height / size.h);
        const [halfWidth, halfHeight] = [(size.w * worldPerPixel) / 2, (size.h * worldPerPixel) / 2];
        Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
        camera.updateProjectionMatrix();
        const pitch = CAMERA_PITCH;
        camera.position.set(0, height / 2 + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
        camera.lookAt(0, height / 2, 0);
      };

      const Labels = () => {
        const { columns, rows, texts } = labels.value;
        // Fixed to the window, which the canvas fills (the HUD layer is inset from it): a label sits at the foot of its own cell.
        return html`<div style=${`position:fixed;inset:0;display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(0,1fr));pointer-events:none`}>
          ${texts.map((text) => html`<span style="align-self:end;justify-self:center;font:500 11px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.45);padding:1px 5px;border-radius:4px;margin-bottom:2px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis">${text}</span>`)}
        </div>`;
      };
      /** Over each swept cell: a dashed line on the ground from where the body began to where it is, a cross at the start, a ring for the ball. */
      const Marks = () => {
        const { aspect, cells } = marks.value;
        const { columns, rows } = labels.value;
        if (!cells.length) return null;
        const cross = MARK_CROSS * MARK_UNITS;
        const at = (value) => value * MARK_UNITS;
        return html`<div style=${`position:fixed;inset:0;display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(0,1fr));pointer-events:none`}>
          ${cells.map(
            (cell) => html`<svg viewBox=${`0 0 ${aspect * MARK_UNITS} ${MARK_UNITS}`} preserveAspectRatio="none" style="display:block;width:100%;height:100%;overflow:hidden">
              ${
                cell.from &&
                html`<g style=${MARK_STYLE}>
                <line x1=${at(cell.from[0])} y1=${at(cell.from[1])} x2=${at(cell.here[0])} y2=${at(cell.here[1])} stroke-dasharray="16 12" />
                <line x1=${at(cell.from[0]) - cross} y1=${at(cell.from[1])} x2=${at(cell.from[0]) + cross} y2=${at(cell.from[1])} />
                <line x1=${at(cell.from[0])} y1=${at(cell.from[1]) - cross} x2=${at(cell.from[0])} y2=${at(cell.from[1]) + cross} />
              </g>`
              }
              ${cell.ball && html`<circle cx=${at(cell.ball[0])} cy=${at(cell.ball[1])} r=${at(cell.ball[2])} style=${`${MARK_STYLE};stroke:#ffd84a`} />`}
            </svg>`
          )}
        </div>`;
      };
      ctx.ui.mount(html`<${Marks} /><${Labels} />`);
      show({ suite: 'turn', species: [catalogOf('wardrobe').catalog.speciesIds()[0]] });

      return {
        update() {},
        render() {
          fitCamera();
          view.render(camera, { clearColor: BACKDROP_COLOR });
        },
        dispose() {
          shown.forEach((entry) => entry.figure.dispose());
          if (gathered) gathered.dispose();
          view.dispose();
          cache.dispose();
        },
        debugState: () => ({
          cells: shown.length,
          grid,
          marks: marks.value.cells,
          placed: shown.map((entry) => ({
            label: entry.cell.label,
            x: entry.figure.root.position.x,
            y: entry.figure.root.position.y,
            scale: entry.figure.root.scale.x,
            origin: entry.posed.origin,
            travel: entry.posed.travel,
          })),
        }),
        show,
        crowd,
      };
    },
  });
})();
