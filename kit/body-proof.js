/**
 * Kit body proof: coverage sheets for judging the body system by eye. One polished character proves nothing, so
 * a sheet is a grid of many cells, each one figure of some recipe, seen from some direction, at some moment of
 * some movement. Suites generate the grids that matter: every species turned through eight directions, every
 * option of every socket, every dial at both ends, seeded rolls, and every movement in eight phases.
 *
 * Owns:  `Kit.body.proof.SUITES` and `suite(name, catalog)` (pure: a catalogue -> the cells of a sheet), `ACTS`
 *        (the movements a cell can show, open for other modules to add to), `CATALOGS` (the catalogues a sheet
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
  const PHASES = 8;
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
   * @property {('body'|'head')} framing
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
    /** Every movement each species can do, in eight phases, from a three-quarter view and from the front. */
    acts: (catalog, _editor, { species, acts = Object.keys(ACTS).filter((id) => id !== 'rest') }) => {
      const unknown = acts.find((id) => !ACTS[id]);
      if (unknown) fail('suite', `no act "${unknown}". Acts: ${Object.keys(ACTS).join(', ')}.`);
      const bakery = catalog.bakery({ capacity: species.length });
      const canDo = (id, act) => !refusalOf(ACTS[act], bakery.bakeRecipe(subjectOf(id)));
      return {
        title: 'Movement',
        columns: PHASES,
        framing: 'body',
        cells: species.flatMap((id) =>
          acts
            .filter((act) => canDo(id, act))
            .flatMap((act) =>
              [0.2, 0].flatMap((yaw) => Array.from({ length: PHASES }, (_unused, step) => ({ label: `${id} ${act} ${step}/${PHASES}`, recipe: subjectOf(id), yaw, act, phase: step / PHASES })))
            )
        ),
      };
    },
  });

  /**
   * The cells of a suite for a catalogue.
   * @param {string} name a key of `SUITES`
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {{species?: string[], count?: number, acts?: string[]}} [options] `species`: which (default all)
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
   */

  /** Why a bake cannot do an act: the stage's refusal, or the act's own. */
  const refusalOf = (act, bake) => Kit.motion.refusal(act.stage(), bake.plan, bake.rest) || (act.refusal ? act.refusal(bake) : null);

  /** A performance of `Kit.act.REPERTOIRE` as an act: a whole character standing on the spot, the performance played from its start. */
  const performanceAct = (id) => ({
    stage: () => Kit.act.character({ fidgets: [] }),
    speed: () => 0,
    cycle: () => Kit.act.REPERTOIRE[id].seconds,
    begin: (motion) => Kit.act.play(motion, id),
    refusal: (bake) => Kit.act.refusal(id, bake.plan, bake.rest),
    // A kick's step or a dive's flight would leave the cell: the pose is shown, not the distance covered.
    anchor: (motion, local) => Kit.act.keepInPlace(motion, local),
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
  }

  /**
   * Poses a figure at a phase of an act by simulating it from a standing start, so the same cell is the same
   * picture every time.
   * @param {Object} figure from `Kit.figure.build`
   * @param {string} actId a key of `ACTS`
   * @param {number} phase 0..1
   * @returns {?string} why the body cannot do it (the stage's refusal), or null when posed
   * @complexity O(seconds simulated / SIMULATION_STEP) motion steps
   * @example Kit.body.proof.perform(figure, 'walk', 0.25)
   */
  const perform = (figure, actId, phase) => {
    const act = ACTS[actId];
    figure.rest();
    if (!act) {
      figure.pose();
      return null;
    }
    const { bake } = figure;
    const refusal = refusalOf(act, bake);
    if (refusal) {
      figure.pose();
      return refusal;
    }
    const speed = act.speed(bake);
    const motion = Kit.motion.state(bake, act.stage());
    const simulate = (from, until) => {
      for (let time = from; time < until; time += SIMULATION_STEP) Kit.motion.advance(motion, SIMULATION_STEP, 0, 0, speed * (time + SIMULATION_STEP), 0);
    };
    simulate(0, WARM_UP);
    if (act.begin) act.begin(motion);
    simulate(WARM_UP, WARM_UP + phase * act.cycle(bake, speed));
    Kit.rig.copy(motion.pose, figure.local);
    if (act.anchor) act.anchor(motion, figure.local);
    if (figure.face) figure.face(Kit.act ? Kit.act.face(motion) : null);
    figure.pose();
    return null;
  };

  /** The catalogues a sheet can be made of, by name; each value makes the raw catalogue data. */
  const CATALOGS = {
    wardrobe: () => Kit.body.wardrobe.CATALOG,
    samples: () => Kit.body.samples.CATALOG,
  };

  Kit.body.proof = { DIRECTIONS, THREE_VIEWS, PHASES, SUITES, ACTS, CATALOGS, suite, perform };

  // ---- the screen -------------------------------------------------------------------------------------------------------

  if (typeof THREE === 'undefined' || !Kit.ui || !Kit.ui.html || !Kit.look || !Kit.look.view || !Kit.figure || !Kit.figure.build) return;
  const { html, signal } = Kit.ui;

  const BACKDROP_COLOR = 0x6a7399;
  const ATLAS_ROWS = 1024;
  const CAMERA = Object.freeze({ pitchDegrees: 6, distance: 12, near: 0.1, far: 60 });
  /** Room round a figure in its cell, as shares of the largest figure's size; `head` shows this share of the height, from the top. */
  const CELL = Object.freeze({ sideMargin: 1.15, topMargin: 1.22, headShare: 0.42, headTop: 0.12, leastWidth: 0.5 });

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
      /** @type {Array<{figure: Object, cell: ProofCell, refusal: ?string}>} */
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
       * @param {{catalog?: string, suite?: string, cells?: ProofCell[], species?: string[], columns?: number, framing?: string, preset?: string, page?: number, rows?: number}} job
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
        const perPage = columns * rowsPerPage;
        const pages = Math.max(1, Math.ceil(sheet.cells.length / perPage));
        const cells = sheet.cells.slice((job.page || 0) * perPage, ((job.page || 0) + 1) * perPage);
        if (job.preset) view.use(job.preset);
        shown.forEach((entry) => entry.figure.dispose());
        const refusals = [];
        shown = cells.map((cell) => {
          const figure = Kit.figure.build(view, bakery.bakeRecipe(cell.recipe), { cache });
          const refusal = perform(figure, cell.act || 'rest', cell.phase || 0);
          if (refusal) refusals.push(`${cell.label}: ${refusal}`);
          figure.root.rotation.y = cell.yaw * TURN;
          return { figure, cell, refusal };
        });
        const tallest = Math.max(...shown.map((entry) => entry.figure.measured.highestY), 0.1);
        const widest = Math.max(...shown.map((entry) => entry.figure.measured.reach * 2), CELL.leastWidth);
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
          entry.figure.root.position.y = isHead ? cellBottom + cellHeight * (1 - CELL.headTop) - entry.figure.measured.highestY : cellBottom + cellHeight * 0.04;
        });
        labels.value = { columns, rows, texts: shown.map((entry) => (entry.refusal ? `${entry.cell.label} (cannot)` : entry.cell.label)) };
        return { pages, cells: shown.length, columns, rows, framing, aspect: (columns * cellWidth) / (rows * cellHeight), refusals };
      };

      const fitCamera = () => {
        const [width, height] = [grid.columns * grid.cellWidth, grid.rows * grid.cellHeight];
        const worldPerPixel = Math.max(width / size.w, height / size.h);
        const [halfWidth, halfHeight] = [(size.w * worldPerPixel) / 2, (size.h * worldPerPixel) / 2];
        Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
        camera.updateProjectionMatrix();
        const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
        camera.position.set(0, height / 2 + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
        camera.lookAt(0, height / 2, 0);
      };

      const Labels = () => {
        const { columns, rows, texts } = labels.value;
        return html`<div style=${`position:absolute;inset:0;display:grid;grid-template-columns:repeat(${columns},1fr);grid-template-rows:repeat(${rows},1fr);pointer-events:none`}>
          ${texts.map((text) => html`<span style="align-self:end;justify-self:center;font:500 11px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.45);padding:1px 5px;border-radius:4px;margin-bottom:2px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis">${text}</span>`)}
        </div>`;
      };
      ctx.ui.mount(html`<${Labels} />`);
      show({ suite: 'turn', species: [catalogOf('wardrobe').catalog.speciesIds()[0]] });

      return {
        update() {},
        render() {
          fitCamera();
          view.render(camera, { clearColor: BACKDROP_COLOR });
        },
        dispose() {
          shown.forEach((entry) => entry.figure.dispose());
          view.dispose();
          cache.dispose();
        },
        debugState: () => ({ cells: shown.length, grid }),
        show,
      };
    },
  });
})();
