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

  /** The rows whose `key` is in `only`, or all of them when nothing is named: how a sheet is narrowed to the sockets or dials under review. */
  const named = (rows, key, only) => (only && only.length ? rows.filter((row) => only.includes(row[key])) : rows);

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
      return { title: 'Rolls', columns: 8, framing: 'body', cells: Array.from({ length: count }, (_unused, index) => ({ label: `roll ${index}`, recipe: table.roll(ROLL_SEED, index), yaw: THREE_VIEWS[0] })) };
    },
    /** The same rolls close on the head. */
    faces: (catalog, editor, options) => ({ ...SUITES.rolls(catalog, editor, options), title: 'Faces', framing: 'head' }),
    /** Every choice of every socket of each species' subject (or only of the sockets named in `only`), from three directions. */
    options: (_catalog, editor, { species, only }) => ({
      title: 'Options',
      columns: THREE_VIEWS.length * 3,
      framing: 'body',
      cells: species.flatMap((id) =>
        named(editor.schema(subjectOf(id)).sockets, 'path', only).flatMap((socket) =>
          socket.choices.flatMap((choice) => THREE_VIEWS.map((yaw) => ({ label: `${id} ${socket.path}: ${choice.id || 'none'}`, recipe: editor.setSocket(subjectOf(id), socket.path, choice.id), yaw })))
        )
      ),
    }),
    /** Every dial of each species' subject (or only the dials named in `only`) at its least and its most. */
    extremes: (_catalog, editor, { species, only }) => ({
      title: 'Dial extremes',
      columns: 8,
      framing: 'body',
      cells: species.flatMap((id) =>
        named(editor.schema(subjectOf(id)).dials, 'id', only).flatMap((dial) => [
          { label: `${id} ${dial.id} least`, recipe: editor.setDial(subjectOf(id), dial.id, dial.min), yaw: THREE_VIEWS[0] },
          { label: `${id} ${dial.id} most`, recipe: editor.setDial(subjectOf(id), dial.id, dial.max), yaw: THREE_VIEWS[0] },
        ])
      ),
    }),
    /** Every movement each species can do, in eight phases, from a three-quarter view and from the front. */
    acts: (catalog, _editor, { species, acts = Object.keys(ACTS).filter((id) => id !== 'rest') }) => {
      const bakery = catalog.bakery({ capacity: species.length });
      const canDo = (id, act) => {
        const bake = bakery.bakeRecipe(subjectOf(id));
        return !Kit.motion.refusal(ACTS[act].stage(), bake.plan, bake.rest);
      };
      return {
        title: 'Movement',
        columns: PHASES,
        framing: 'body',
        cells: species.flatMap((id) =>
          acts
            .filter((act) => canDo(id, act))
            .flatMap((act) => [0.2, 0].flatMap((yaw) => Array.from({ length: PHASES }, (_unused, step) => ({ label: `${id} ${act} ${step}/${PHASES}`, recipe: subjectOf(id), yaw, act, phase: step / PHASES }))))
        ),
      };
    },
  });

  /**
   * The cells of a suite for a catalogue.
   * @param {string} name a key of `SUITES`
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {{species?: string[], count?: number, acts?: string[], only?: string[]}} [options] `species`: which (default all);
   *   `only`: the socket paths (options) or dial ids (extremes) to show, default all
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
   */

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
    const stage = act.stage();
    const refusal = Kit.motion.refusal(stage, bake.plan, bake.rest);
    if (refusal) {
      figure.pose();
      return refusal;
    }
    const speed = act.speed(bake);
    const until = WARM_UP + phase * act.cycle(bake, speed);
    const motion = Kit.motion.state(bake, stage);
    for (let time = 0; time < until; time += SIMULATION_STEP) Kit.motion.advance(motion, SIMULATION_STEP, 0, 0, speed * (time + SIMULATION_STEP), 0);
    Kit.rig.copy(motion.pose, figure.local);
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
  /** Palette rows: an options page of 36 figures at `Kit.figure.RAMP_SLOTS` rows each, with room to spare (the indexed looks address the first `Kit.look.INDEXED_ROWS`, a page of 32). */
  const ATLAS_ROWS = 1024;
  const CAMERA = Object.freeze({ pitchDegrees: 6, distance: 12, near: 0.1, far: 60 });
  /** The camera's pitch, radians. */
  const PITCH = (CAMERA.pitchDegrees * Math.PI) / 180;
  /**
   * Room round a figure in its cell. A body cell holds everything the figure sweeps when it turns (wings, a hat,
   * a staff), plus `sideMargin` and `topMargin` as shares of that; `floor` is the share of the cell left under
   * its feet. A head cell is a square `headMargin` times the ball that holds the head bone's own surface, so
   * every species' head is drawn the same size, with room for ears, hair, horns and a hat.
   * `figureShare`: about how tall a standing body is drawn, in cell widths (for choosing its level of detail);
   * `mostAspect`: the widest a long body is drawn, in body heights.
   */
  const CELL = Object.freeze({ sideMargin: 1.06, topMargin: 1.12, floor: 0.04, headMargin: 1.25, leastWidth: 0.5, figureShare: 1.3, mostAspect: 1.3 });

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
      /** @type {Array<{figure: Object, cell: ProofCell, refusal: ?string, scale?: number}>} */
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
       * @param {{catalog?: string, suite?: string, cells?: ProofCell[], species?: string[], only?: string[], columns?: number, framing?: string, preset?: string, page?: number, rows?: number, rigid?: boolean, level?: string, cellPixels?: number}} job
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
          const refusal = perform(figure, cell.act || 'rest', cell.phase || 0);
          if (refusal) refusals.push(`${cell.label}: ${refusal}`);
          figure.root.rotation.y = cell.yaw * TURN;
          return { figure, cell, refusal };
        });
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
        const rows = Math.max(1, Math.ceil(shown.length / columns));
        if (isHead) frameHeads(columns, rows);
        else frameBodies(columns, rows);
        labels.value = { columns, rows, texts: shown.map((entry) => (entry.refusal ? `${entry.cell.label} (cannot)` : entry.cell.label)) };
        return { pages, cells: shown.length, columns, rows, framing, aspect: (columns * grid.cellWidth) / (rows * grid.cellHeight), refusals };
      };

      const headMask = Kit.body.roleMask(['head']);
      /** Is a piece the head's own surface (its skull; not its ears or nose, nor what is worn on it)? */
      const isOfHead = (plan) => (piece) => !piece.isProp && !piece.isFeature && (plan.roles[piece.bone] & headMask) !== 0;

      /**
       * Body framing: every cell is as wide and as tall as the largest figure sweeps when it turns, so wings, a
       * brim or a held staff never reach into the next cell. Feet stand a little above the cell's floor.
       */
      const frameBodies = (columns, rows) => {
        const swept = shown.map((entry) => Kit.figure.measureSwept(entry.figure.layout, entry.figure.world, cache.positions) || { sweep: 0, lowestY: 0, highestY: 0 });
        const cellWidth = Math.max(CELL.leastWidth, ...swept.map((measure, index) => measure.sweep * 2 * shown[index].scale)) * CELL.sideMargin;
        const below = Math.max(0, ...swept.map((measure, index) => -measure.lowestY * shown[index].scale));
        const cellHeight = (Math.max(...swept.map((measure, index) => measure.highestY * shown[index].scale)) + below) * CELL.topMargin;
        grid = { columns, rows, cellWidth, cellHeight };
        shown.forEach((entry, index) => {
          const [column, row] = [index % columns, Math.floor(index / columns)];
          entry.figure.root.position.x = (column - (columns - 1) / 2) * cellWidth;
          entry.figure.root.position.y = (rows - 1 - row) * cellHeight + cellHeight * CELL.floor + below;
        });
      };

      /**
       * Head framing: each cell is centred on the ball that holds its figure's head, and every species' head is
       * drawn the same size (individuals of one species keep theirs against each other), so a hound's or a
       * fish's head fills its cell as a person's does. A body with no head bone is framed by its whole self.
       * The rest of a body may reach past its cell: see `solo`.
       */
      const frameHeads = (columns, rows) => {
        const heads = shown.map((entry) => {
          const all = () => Kit.figure.measureSwept(entry.figure.layout, entry.figure.world, cache.positions);
          return Kit.figure.measureSwept(entry.figure.layout, entry.figure.world, cache.positions, isOfHead(entry.figure.bake.plan)) || all() || { center: [0, 0, 0], radius: CELL.leastWidth };
        });
        const largest = new Map();
        shown.forEach((entry, index) => largest.set(entry.cell.recipe.species, Math.max(largest.get(entry.cell.recipe.species) || 0, heads[index].radius)));
        const radius = Math.max(...largest.values());
        const side = radius * 2 * CELL.headMargin;
        grid = { columns, rows, cellWidth: side, cellHeight: side };
        shown.forEach((entry, index) => {
          const [column, row] = [index % columns, Math.floor(index / columns)];
          entry.scale = radius / largest.get(entry.cell.recipe.species);
          entry.figure.root.scale.setScalar(entry.scale);
          // The head's middle, turned with the figure about its own axis, lands on the middle of the cell. The camera
          // looks a little down, so a head nearer the camera than the figure's axis is drawn lower: it is raised by that.
          const turn = entry.cell.yaw * TURN;
          const [x, y, z] = heads[index].center;
          const toCamera = (z * Math.cos(turn) - x * Math.sin(turn)) * entry.scale;
          entry.figure.root.position.x = (column - (columns - 1) / 2) * side - (x * Math.cos(turn) + z * Math.sin(turn)) * entry.scale;
          entry.figure.root.position.y = (rows - 1 - row + 0.5) * side - y * entry.scale + toCamera * Math.tan(PITCH);
        });
      };

      /**
       * Draws one cell of the page alone, or all of them again. A close-up of a head cannot hold the body behind
       * it, which reaches into the cells beside it (a hound's back, a fish's whole length); a picture of each cell
       * alone, cut to the cell, shows the head and nothing of its neighbours (tools/dev/proof.js does this).
       * @param {?number} index the cell to draw alone; null: every cell
       * @returns {number} how many cells the page holds
       */
      const solo = (index) => {
        shown.forEach((entry, at) => (entry.figure.root.visible = index === null || at === index));
        return shown.length;
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
          perform({ bake, local, rest: () => Kit.rig.copy(bake.rest, local), pose() {} }, job.act || 'walk', (member % PHASES) / PHASES);
          const [column, row] = [member % columns, Math.floor(member / columns)];
          gathered.places.set([(column - (columns - 1) / 2) * cellWidth, (rows - 1 - row) * cellHeight + cellHeight * 0.04, 0, ((member * 3) % 8) * (TURN / 8)], member * 4);
        }
        gathered.pose();
        grid = { columns, rows, cellWidth, cellHeight };
        labels.value = { columns, rows, texts: [] };
        return { count, columns, rows, aspect: (columns * cellWidth) / (rows * cellHeight), level, ...gathered.cost };
      };

      const fitCamera = () => {
        const [width, height] = [grid.columns * grid.cellWidth, grid.rows * grid.cellHeight];
        const worldPerPixel = Math.max(width / size.w, height / size.h);
        const [halfWidth, halfHeight] = [(size.w * worldPerPixel) / 2, (size.h * worldPerPixel) / 2];
        Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
        camera.updateProjectionMatrix();
        camera.position.set(0, height / 2 + Math.sin(PITCH) * CAMERA.distance, Math.cos(PITCH) * CAMERA.distance);
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
          if (gathered) gathered.dispose();
          view.dispose();
          cache.dispose();
        },
        debugState: () => ({ cells: shown.length, grid }),
        show,
        solo,
        crowd,
      };
    },
  });
})();
