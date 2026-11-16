/**
 * Kit body portrait: the `portrait` screen (`Kit.play('portrait')`), the evidence sheet for how wardrobe
 * characters look. It shows the default person (`Kit.body.wardrobe.DEFAULT_PERSON`) and twelve seeded rolls
 * across the species, in three framings: `body` (everyone, head to toe, in a grid), `head` (head and shoulders,
 * a few to a page, with the camera really zoomed in rather than the figures scaled) and `compare` (the `look`
 * showcase's hand-built stand-ins beside the default person and one roll, in the same view and preset). The
 * look panel switches preset and knobs.
 *
 * Owns:  the screen: its cast, the three framings, the camera, and the numbers a tool can ask for
 *        (`Kit.currentGame.measure()`: draw calls, triangles and milliseconds per frame).
 * Does not own: the catalogue (kit/body-wardrobe.js), baking (kit/body-recipe.js), regions and faces
 *        (kit/body-surface.js), drawing (kit/figure*.js, kit/look-*.js) or the stand-ins (kit/look-show.js).
 *
 * Registered like a game, so the shell gives it a HUD, a back button and clean-up, and the play tool reaches it:
 *   node tools/dev.js play portrait --size 1400x800 "log (Kit.currentGame.apply({framing:'head',preset:'pixel'}),1)" "wait 1" "shot head-pixel"
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.body.wardrobe || !Kit.figure || !Kit.figure.build || !Kit.look.panel || !Kit.look.standIns) return;
  const { html, signal } = Kit.ui;
  const { Choice, LookControls, Panel, lookControls, freeArea } = Kit.look.panel;

  const BACKDROP_COLOR = 0x6a7399;
  /** The rolls are the wardrobe sheet's first twelve, so both screens show the same people. */
  const TABLE_SEED = 20261116;
  const ROLLS = 12;
  /** Atlas rows: one block of `Kit.figure.RAMP_SLOTS` per character and one palette set per stand-in. */
  const ATLAS_ROWS = 512;
  const CAMERA = Object.freeze({ pitchDegrees: 6, distance: 12, near: 0.1, far: 40 });
  /**
   * The framings, world units. `columns`: characters per row; `rows`: rows per page (0: as many as the cast
   * needs); `cellWidth` / `cellHeight`: the window each character gets; `top`: how far above the crown of the
   * head the window starts (room for a hat); `anchor`: what sits at a fixed height in every cell ('feet' or 'crown').
   */
  const FRAMINGS = Object.freeze({
    body: Object.freeze({ label: 'Full body', columns: 7, rows: 0, cellWidth: 0.92, cellHeight: 1.62, top: 0.2, anchor: 'feet' }),
    head: Object.freeze({ label: 'Head and shoulders', columns: 5, rows: 1, cellWidth: 0.72, cellHeight: 0.8, top: 0.17, anchor: 'crown' }),
    compare: Object.freeze({ label: 'Beside the stand-ins', columns: 4, rows: 1, cellWidth: 1.15, cellHeight: 2.5, top: 0.2, anchor: 'feet' }),
  });
  /** In `compare`: which cast members stand beside the stand-ins (the default person and one roll). */
  const COMPARED_MEMBERS = Object.freeze([0, 4]);
  const TIMED_FRAMES = 10;
  const RGBA = 4;

  /**
   * The characters of the sheet as recipes: the default person with every dial at its default, then the rolls.
   * @param {Object} catalog from `Kit.body.catalog`
   * @returns {Object[]} recipes
   * @complexity O(dials + rolls)
   * @example const recipes = castRecipes(Kit.body.catalog(Kit.body.wardrobe.CATALOG));
   */
  const castRecipes = (catalog) => {
    const editor = Kit.body.editor(catalog);
    const base = Kit.body.wardrobe.DEFAULT_PERSON;
    const person = editor.schema(base).dials.reduce((recipe, dial) => editor.setDial(recipe, dial.id, dial.default), base);
    const table = catalog.table(catalog.speciesIds().map((species) => ({ species })));
    return [person, ...Array.from({ length: ROLLS }, (_unused, index) => table.roll(TABLE_SEED, index))];
  };

  /**
   * Which page a slot is on and where in the page's grid, for a framing.
   * @param {typeof FRAMINGS[string]} framing
   * @param {number} slot index among the things shown in this framing
   * @param {number} count how many things the framing shows
   * @returns {{page: number, column: number, row: number, pages: number, rows: number}}
   * @complexity O(1)
   * @example slotPlace(FRAMINGS.head, 7, 13) // { page: 1, column: 2, row: 0, pages: 3, rows: 1 }
   */
  const slotPlace = (framing, slot, count) => {
    const rows = framing.rows || Math.ceil(count / framing.columns);
    const perPage = framing.columns * rows;
    const within = slot % perPage;
    return { page: Math.floor(slot / perPage), column: within % framing.columns, row: Math.floor(within / framing.columns), pages: Math.ceil(count / perPage), rows };
  };

  Kit.register({
    id: 'portrait',
    name: 'Portrait sheet',
    tagline: 'The default person and twelve rolls, full body and close up',
    hook: 'Judge wardrobe characters by eye in every preset',
    color: '#9ad6c0',
    order: 999,
    theme: { skin: 'glass' },
    create(ctx) {
      const { renderer, size } = ctx;
      const view = Kit.look.view({ renderer, preset: 'toon', atlasRows: ATLAS_ROWS });
      const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
      const bakery = catalog.bakery({ capacity: (ROLLS + 1) * 2 });
      const cache = Kit.figure.geometryCache();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);
      const cast = castRecipes(catalog).map((recipe) => {
        const figure = Kit.figure.build(view, bakery.bakeRecipe(recipe), { cache });
        return { recipe, figure, root: figure.root, crown: figure.measured.highestY };
      });
      const standIns = Kit.look.standIns.FIGURES.map((row) => {
        const built = Kit.look.standIns.build(view, row);
        const bounds = new THREE.Box3().setFromObject(built.root);
        return { root: built.root, crown: bounds.max.y, facing: row.facing };
      });

      const controls = lookControls(view, 'toon');
      const framingId = signal('body');
      const page = signal(0);
      const isPanelShown = signal(false);
      let yaw = 0;
      let governedPixelRatio = renderer.getPixelRatio();
      /** The world rectangle the camera shows now: `[centerX, centerY, width, height]`. */
      const windowNow = [0, 0, 1, 1];

      /** What a framing shows, in slot order. */
      const shownIn = (id) => (id === 'compare' ? [...standIns, ...COMPARED_MEMBERS.map((index) => cast[index])] : cast);
      /** Places every root for the framing and page, hides the rest, and sets the camera's window. */
      const arrange = () => {
        const framing = FRAMINGS[framingId.value];
        const shown = shownIn(framingId.value);
        const { pages, rows } = slotPlace(framing, 0, shown.length);
        page.value = Math.min(page.value, pages - 1);
        [...cast, ...standIns].forEach((member) => (member.root.visible = false));
        shown.forEach((member, slot) => {
          const place = slotPlace(framing, slot, shown.length);
          member.root.visible = place.page === page.value;
          const cellTop = (rows - place.row) * framing.cellHeight;
          member.root.position.x = (place.column - (framing.columns - 1) / 2) * framing.cellWidth;
          member.root.position.y = framing.anchor === 'crown' ? cellTop - framing.top - member.crown : cellTop - framing.cellHeight;
          member.root.position.z = 0;
        });
        windowNow[0] = 0;
        windowNow[1] = (rows * framing.cellHeight) / 2;
        windowNow[2] = framing.columns * framing.cellWidth;
        windowNow[3] = rows * framing.cellHeight;
      };
      const turn = () => {
        const { yawSteps } = view.settings();
        cast.forEach((member) => (member.root.rotation.y = Kit.look.stepYaw(yaw, yawSteps)));
        standIns.forEach((member) => (member.root.rotation.y = Kit.look.stepYaw(member.facing + yaw, yawSteps)));
      };
      /** Fits the window into the part of the screen the panel leaves free (an off-centre frustum, as in the `look` screen). */
      const fitCamera = () => {
        const free = freeArea(size, isPanelShown.value);
        const worldPerPixel = Math.max(windowNow[2] / free.width, windowNow[3] / free.height);
        Object.assign(camera, { left: -free.centerX * worldPerPixel, right: (size.w - free.centerX) * worldPerPixel, top: free.centerY * worldPerPixel, bottom: -(size.h - free.centerY) * worldPerPixel });
        camera.updateProjectionMatrix();
        const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
        camera.position.set(windowNow[0], windowNow[1] + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
        camera.lookAt(windowNow[0], windowNow[1], 0);
      };
      const drawFrame = () => {
        arrange();
        turn();
        fitCamera();
        // Index loop: per-frame posing of every visible figure, no allocation.
        for (let index = 0; index < cast.length; index++) {
          if (!cast[index].root.visible) continue;
          cast[index].figure.rest();
          cast[index].figure.pose();
        }
        view.render(camera, { clearColor: BACKDROP_COLOR });
      };

      const framingOptions = Object.keys(FRAMINGS).map((id) => ({ value: id, label: FRAMINGS[id].label }));
      const choose = (id) => {
        framingId.value = id;
        page.value = 0;
      };
      const nextPage = () => {
        const framing = FRAMINGS[framingId.value];
        page.value = (page.value + 1) % slotPlace(framing, 0, shownIn(framingId.value).length).pages;
      };
      ctx.ui.mount(html`<div style="position:absolute;inset:0" onClick=${nextPage} aria-label="Characters; tap for the next page"></div>
        <${Panel} isShown=${isPanelShown} label="Portrait controls">
          <${Choice} label="Framing" options=${framingOptions} value=${framingId} onPick=${choose} idPrefix="portrait-framing" />
          <${LookControls} controls=${controls} />
        <//>`);

      /** Draw calls, triangles and milliseconds per frame of what is shown now (the time includes a GPU flush). */
      const measure = () => {
        const gl = renderer.getContext();
        const waitForGpu = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(RGBA));
        const hadAutoReset = renderer.info.autoReset;
        renderer.info.autoReset = false;
        renderer.info.reset();
        drawFrame();
        const { calls, triangles } = renderer.info.render;
        renderer.info.autoReset = hadAutoReset;
        waitForGpu();
        const startedAt = performance.now();
        for (let frame = 0; frame < TIMED_FRAMES; frame++) drawFrame();
        waitForGpu();
        const shownCount = shownIn(framingId.value).filter((member) => member.root.visible).length;
        return { preset: controls.preset.value, framing: framingId.value, shown: shownCount, calls, triangles, ms: Math.round(((performance.now() - startedAt) / TIMED_FRAMES) * 10) / 10, path: view.stats().path, programs: renderer.info.programs.length };
      };

      return {
        update() {
          // The shell's quality governor lowers the pixel ratio on a slow device: follow it down to the cheaper look.
          if (renderer.getPixelRatio() < governedPixelRatio) {
            governedPixelRatio = renderer.getPixelRatio();
            view.degrade();
          }
        },
        render: drawFrame,
        dispose() {
          controls.stop();
          cast.forEach((member) => member.figure.dispose());
          standIns.forEach((member) => member.root.traverse((object) => object.geometry && object.geometry.dispose()));
          view.dispose();
          cache.dispose();
        },
        debugState: () => ({
          preset: controls.preset.value,
          framing: framingId.value,
          page: page.value,
          characters: cast.map((member) => `${member.recipe.species}#${member.recipe.seed}`),
          meshes: cast.reduce((sum, member) => sum + member.figure.counters().meshes, 0),
          stats: view.stats(),
        }),
        /**
         * Sets the screen's state in one call, for scripted captures.
         * @param {{preset?: string, knobs?: Object, framing?: string, page?: number, yaw?: number, panel?: boolean}} state
         * @example Kit.currentGame.apply({ framing: 'head', page: 1, preset: 'pixel' })
         */
        apply(state) {
          if (state.preset) controls.choosePreset(state.preset);
          Object.keys(state.knobs || {}).forEach((id) => (controls.knobs[id].value = state.knobs[id]));
          if (state.framing) choose(state.framing);
          if (state.page !== undefined) page.value = state.page;
          if (state.yaw !== undefined) yaw = state.yaw;
          if (state.panel !== undefined) isPanelShown.value = state.panel;
          return true;
        },
        measure,
      };
    },
  });

  Kit.body.portrait = { FRAMINGS, castRecipes, slotPlace };
})();
