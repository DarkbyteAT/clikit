/**
 * Kit creator: the `creator` screen (`Kit.play('creator')`, "Character Maker" in the menu). A character editor for
 * the wardrobe catalogue, generated from data: the 3D character on a stage (drag to turn, pinch or buttons to
 * zoom, the camera moves to the body area being edited), and a panel of tabs whose controls are built from
 * `editor.schema` (sliders for dials, swatches for colours, option cards for parts).
 *
 * Owns:  the screen: which pieces are composed and how (session, control host, camera director, figure, look,
 *        saves), the per-frame loop (apply queued slider values, update the figure with the fewest changes, fit the
 *        camera, draw), the layout stylesheet, the draft that survives leaving the screen, and the measurements a
 *        tool can read (`debugState`).
 * Does not own: any piece it composes: edits and history (kit/creator-session.js), the rows and controls
 *        (kit/creator-rows.js, creator-controls.js), the stage (kit/creator-stage.js), dialogs and the Setup tab
 *        (kit/creator-panels.js), saves (kit/creator-slots.js), the camera maths (kit/creator-camera.js), the
 *        look (kit/look-*.js), the figure (kit/figure*.js) and what a character is (kit/body-*.js).
 *
 * Layout: portrait puts the stage above the panel; landscape puts the stage left and the panel right. Both are
 * one CSS grid, so the screen has no layout code. The 3D canvas fills the page and the camera is fitted to the
 * stage element's box, so it follows the layout.
 *
 * Registered like a game, so the shell gives it a HUD, a back button and clean-up. It draws its own frame (`render`).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.body || !Kit.body.wardrobe || !Kit.figure || !Kit.figure.build || !Kit.creator || !Kit.creator.ControlTabs || !Kit.creator.SetupView || !Kit.creator.THEME) return;
  const { html, signal, css } = Kit.ui;
  const { lookControls } = Kit.look.panel;
  const creator = Kit.creator;

  /**
   * The character a first visit opens on: the catalogue's default person with every dial at its default (a
   * dressed, friendly character rather than a random roll), or the first body type when there is none.
   * @param {Object} catalog
   * @param {Object} editor from `Kit.body.editor(catalog)`
   * @returns {Object} a recipe
   * @complexity O(dials)
   */
  const openingRecipe = (catalog, editor) => {
    const base = Kit.body.wardrobe.DEFAULT_PERSON;
    if (!base) return { species: catalog.speciesIds()[0], ...OPENING_RECIPE };
    return editor.schema(base).dials.reduce((recipe, dial) => editor.setDial(recipe, dial.id, dial.default), base);
  };

  // ---- tunables -------------------------------------------------------------------------------------------------------

  /** The stage's backdrop: a calm mid slate that the toon tones read well against. */
  const BACKDROP_COLOR = 0x353c4b;
  /** The camera looks slightly down, orthographic, from this far (metres) in front of the figure. */
  const CAMERA = Object.freeze({ pitchDegrees: 8, distance: 12, near: 0.1, far: 40 });
  /** Height of the shell's top bar the character must stay clear of, and the room the look chips take under it, CSS pixels. */
  const STAGE_INSET = Object.freeze({ top: 52, bottom: 56 });
  /** The preset a first visit starts in. */
  const OPENING_PRESET = 'toon';
  /** The character a first visit starts with when the catalogue names no default person: the first body type, seed 1. */
  const OPENING_RECIPE = Object.freeze({ seed: 1 });
  /** The key the screen's own save holds the draft under (the character, its name and its look), so leaving does not lose it. */
  const DRAFT_KEY = 'draft';
  /** A change is written to the draft after this many seconds of quiet. */
  const DRAFT_DELAY_SECONDS = 1.5;
  /** Seconds without an edit before the body's sculpted surfaces are made again (during a drag the skeleton bends them). */
  const SCULPT_DELAY_SECONDS = 0.18;
  /**
   * Sculpting takes this share of a frame's time, within [least, most] milliseconds: 6 ms of a 16 ms frame, and
   * more of a frame that is slow anyway (a software renderer), so the work ends in about the same wall time.
   */
  const SCULPT_SLICE = Object.freeze({ share: 0.4, least: 6, most: 60 });
  /** Walking in place: how fast the treadmill runs, metres per second. */
  const WALK_SPEED = 1.3;
  /** Share of the screen the panel takes: the height in portrait, the width in landscape (CSS clamp bounds). */
  const PANEL_SIZE = Object.freeze({ portraitHeight: 'clamp(300px, 50dvh, 520px)', landscapeWidth: 'clamp(320px, 44vw, 460px)' });
  /** Slider-to-figure latencies kept for the report (the newest this many). */
  const LATENCY_SAMPLES = 60;

  css(`
    .cr-root { position: fixed; inset: 0; display: grid; grid-template-rows: minmax(0, 1fr) ${PANEL_SIZE.portraitHeight}; grid-template-columns: minmax(0, 1fr); pointer-events: none; color: var(--ink); font-family: var(--body); }
    .cr-failed { place-items: center; padding: 72px 24px 24px; pointer-events: auto; }
    .cr-panel { pointer-events: auto; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--panel); border-top: var(--border) solid var(--line); padding-bottom: env(safe-area-inset-bottom, 0px); }
    @media (orientation: landscape) {
      .cr-root { grid-template-rows: minmax(0, 1fr); grid-template-columns: minmax(0, 1fr) ${PANEL_SIZE.landscapeWidth}; }
      .cr-panel { border-top: 0; border-left: var(--border) solid var(--line); padding-top: 8px; }
    }
  `);

  /**
   * Reads the draft a visit left behind: a character code, a name and a look preset. Anything damaged is ignored.
   * @param {Object} save `ctx.save`
   * @param {Object} catalog
   * @returns {{recipe: ?Object, name: ?string, preset: string}}
   */
  const restoreDraft = (save, catalog) => {
    const draft = save.get(DRAFT_KEY, null);
    const parsed = draft && typeof draft.code === 'string' ? creator.parseShareCode(catalog, draft.code) : { ok: false };
    const preset = draft && Kit.look.PRESETS[draft.preset] ? draft.preset : OPENING_PRESET;
    return { recipe: parsed.ok ? parsed.recipe : null, name: draft && typeof draft.name === 'string' ? draft.name : null, preset };
  };

  /** The root of the screen: the stage on one side, the panel on the other. */
  const CreatorRoot = ({ app }) =>
    html`<div class="cr-root" id="cr-root">
      <section class="cr-stage" aria-label="Character stage" ref=${(element) => (app.stageElement = element)}>
        <${creator.StageGestures} director=${app.director} label="Character preview" />
        <${creator.StageTitle} status=${app.status} held=${app.held} />
        <${creator.StageRails} director=${app.director} status=${app.status} held=${app.held} walking=${app.walking} onUndo=${app.actions.undo} onRedo=${app.actions.redo} />
        <${creator.LookChips} controls=${app.look} />
      </section>
      <section class="cr-panel" id="cr-panel" aria-label="Character controls">
        <${creator.ControlTabs}
          host=${app.host}
          selected=${app.tab}
          onSelect=${app.actions.selectTab}
          onRandomize=${app.actions.randomizeGroup}
          setupView=${() => html`<${creator.SetupView} app=${app} />`}
        />
      </section>
    </div>`;

  /**
   * Builds the screen, or a message saying why it could not start.
   * @param {Object} ctx the shell context
   * @returns {Object} `{ update, render, dispose, debugState, session, host, director }` (only `update` and `dispose` when it could not start)
   */
  const createCreator = (ctx) => {
    try {
      return buildCreator(ctx);
    } catch (error) {
      // A broken catalogue or a missing piece must not leave a blank screen: say what happened and let the person go back.
      ctx.ui.mount(html`<div class="cr-root cr-failed"><${Kit.ui.Empty} title="Character Maker could not start" text=${error.message} /></div>`);
      return { update() {}, dispose() {} };
    }
  };

  /** Builds the working screen; `createCreator` wraps it so a failure shows as a message. */
  const buildCreator = (ctx) => {
    const { renderer, size } = ctx;
    const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
    const editor = Kit.body.editor(catalog);
    const bakery = catalog.bakery();
    const draft = restoreDraft(ctx.save, catalog);
    const session = creator.session({ catalog, editor, recipe: draft.recipe || openingRecipe(catalog, editor), name: draft.name || undefined });
    const slots = creator.slots(ctx.save);
    const director = creator.camera.director();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // ---- the 3D view ----
    const view = Kit.look.view({ renderer, preset: draft.preset });
    const look = lookControls(view, draft.preset);
    const cache = Kit.figure.geometryCache();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);
    let drawnRecipe = session.recipe();
    let bake = bakery.bakeRecipe(drawnRecipe);
    // Faces and clothes come through the figure's default hooks (`Kit.body.FIGURE_HOOKS`), which read the bake being drawn.
    const figure = Kit.figure.build(view, bake, { cache, sculpt: 'steps' });

    // ---- state the interface reads ----
    const held = signal(false);
    const tab = signal(creator.SETUP_TAB);
    const speciesSignal = signal(session.recipe().species);
    const nameSignal = signal(session.name());
    const canWalk = Boolean(Kit.motion && Kit.gait && Kit.gait.walk);
    const walking = canWalk ? signal(false) : null;
    const titleCase = (id) => id.charAt(0).toUpperCase() + id.slice(1);
    const statusNow = () => {
      const { canUndo, canRedo, isChanged } = session.summary();
      return { canUndo, canRedo, isChanged, name: session.name(), speciesLabel: titleCase(session.recipe().species) };
    };
    const status = signal(statusNow());
    const latencies = [];
    const measurement = { applyMs: 0, flushMs: 0, inputToApplyMs: 0, applied: 0, sculptMs: 0, sculpted: 0, longestSliceMs: 0 };
    let lastInputAt = 0;
    let isDraftDirty = false;
    let quietSeconds = SCULPT_DELAY_SECONDS;
    /** Time spent so far in the slices of the sculpt under way. */
    let sculptingMs = 0;

    const afterEdit = () => {
      status.value = statusNow();
      speciesSignal.value = session.recipe().species;
      isDraftDirty = true;
      quietSeconds = 0;
      if (!lastInputAt) lastInputAt = performance.now();
    };
    const host = creator.controlHost({ session, onEdit: afterEdit, onInput: () => (lastInputAt = lastInputAt || performance.now()) });

    // ---- what the buttons do ----
    const describeSlot = (slot) => {
      const parsed = creator.parseShareCode(catalog, slot.code);
      return parsed.ok ? { chips: creator.chipColors(editor, parsed.recipe), speciesLabel: titleCase(parsed.recipe.species), problem: null } : { chips: [], speciesLabel: '', problem: parsed.message };
    };
    const openSlot = (slot) => {
      const parsed = creator.parseShareCode(catalog, slot.code);
      if (!parsed.ok) return Kit.ui.notify(parsed.message, { tone: 'bad' });
      host.act(() => session.load(parsed.recipe, slot.name));
      nameSignal.value = session.name();
      return Kit.ui.notify(`Opened ${session.name()}.`, { tone: 'good' });
    };
    const importCode = (text) => {
      let result = { ok: false, message: '' };
      host.act(() => (result = session.importCode(text)));
      if (result.ok) Kit.ui.notify('Character loaded from the code.', { tone: 'good' });
      return result;
    };
    const actions = {
      selectTab(id) {
        tab.value = id;
        director.focus(id);
      },
      randomizeGroup: (groupId) => host.act(() => session.randomizeGroup(groupId)),
      randomizeAll: () => host.act(() => session.randomizeAll()),
      mirror: (from) => host.act(() => session.mirror(from)),
      undo: () => host.act(() => session.undo()),
      redo: () => host.act(() => session.redo()),
      setSpecies(speciesId) {
        let result = { kept: 0, dropped: [] };
        host.act(() => (result = session.setSpecies(speciesId)));
        if (result.dropped.length) Kit.ui.notify(`Kept ${result.kept} choices; ${result.dropped.length} did not fit a ${speciesId} and were dropped.`, { tone: 'warn' });
      },
      setName(text) {
        session.setName(text);
        status.value = statusNow();
        isDraftDirty = true;
        quietSeconds = 0;
      },
      openSaves: () =>
        Kit.ui.openDialog({
          title: 'Saved characters',
          variant: 'sheet',
          body: (close) => html`<${creator.SavesBody} slots=${slots} describe=${describeSlot} current=${() => ({ name: session.name(), code: session.code() })} onOpen=${openSlot} close=${close} />`,
        }),
      openShare: () => Kit.ui.openDialog({ title: 'Share code', body: (close) => html`<${creator.ShareBody} code=${() => session.code()} onImport=${importCode} close=${close} />` }),
    };
    const app = { session, catalog, host, director, status, held, walking, tab, look, speciesSignal, nameSignal, actions, stageElement: null, watched: false };
    ctx.ui.mount(html`<${CreatorRoot} app=${app} />`);

    // ---- the frame ----
    /** The part of the screen the character is framed in: the stage box less the top bar and the look chips. */
    let stageBox = { left: 0, top: 0, width: size.w, height: size.h };
    const measureStage = () => {
      if (!app.stageElement) return;
      const box = app.stageElement.getBoundingClientRect();
      stageBox = { left: box.left, top: box.top + STAGE_INSET.top, width: box.width, height: Math.max(1, box.height - STAGE_INSET.top - STAGE_INSET.bottom) };
    };
    const stageWatcher = new ResizeObserver(measureStage);
    const watchStage = () => {
      if (app.stageElement && !app.watched) {
        app.watched = true;
        stageWatcher.observe(app.stageElement);
        measureStage();
      }
    };

    /** Draws a recipe with the fewest changes, and records what it cost. */
    const showRecipe = (recipe) => {
      const startedAt = performance.now();
      const next = bakery.bakeRecipe(recipe);
      // `settle: false`: a dial drag bends the sculpted surfaces at once; `update` sculpts them when the drag rests.
      figure.setBake(next, editor.changes(bake, next), { settle: false });
      bake = next;
      drawnRecipe = recipe;
      const finishedAt = performance.now();
      measurement.applyMs = finishedAt - startedAt;
      measurement.applied += 1;
      if (lastInputAt) {
        measurement.inputToApplyMs = finishedAt - lastInputAt;
        latencies.push(measurement.inputToApplyMs);
        if (latencies.length > LATENCY_SAMPLES) latencies.shift();
        lastInputAt = 0;
      }
    };

    /** The treadmill: a walking motion state for the bake on stage, made again when the body changes. */
    let walk = null;
    const advanceWalk = (dt) => {
      if (!walk || walk.bake !== bake) {
        const problem = Kit.motion.refusal(Kit.gait.walk(), bake.plan, bake.rest);
        if (problem) {
          walking.value = false;
          Kit.ui.notify('This body cannot walk.', { tone: 'warn' });
          walk = null;
          return;
        }
        walk = { bake, motion: Kit.motion.state(bake, Kit.gait.walk()), z: walk ? walk.z : 0 };
      }
      walk.z += WALK_SPEED * dt;
      Kit.motion.advance(walk.motion, dt, 0, 0, walk.z, 0);
      // The motion's pose is relative to the body, so copied into the figure it walks on the spot.
      Kit.rig.copy(walk.motion.pose, figure.local);
      figure.pose();
    };
    let lastFrameAt = performance.now();
    let wasWalking = false;

    const fitCamera = () => {
      const window3d = director.windowFor(figure.measured, stageBox.width / stageBox.height);
      Object.assign(camera, creator.camera.boundsFor(window3d, stageBox, size));
      camera.updateProjectionMatrix();
      const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
      camera.position.set(window3d.centerX, window3d.centerY + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
      camera.lookAt(window3d.centerX, window3d.centerY, 0);
    };

    const saveDraft = () => {
      ctx.save.set(DRAFT_KEY, { code: session.code(), name: session.name(), preset: look.preset.value });
      isDraftDirty = false;
    };

    return {
      update(dt) {
        director.step(dt, reducedMotion.matches);
        quietSeconds += dt;
        if (isDraftDirty && quietSeconds >= DRAFT_DELAY_SECONDS) saveDraft();
        if (quietSeconds >= SCULPT_DELAY_SECONDS && !figure.isSettled()) {
          // A slice a frame: the first sculpt of a page (cold code, about a second in all) never holds input.
          const startedAt = performance.now();
          const isDone = figure.settle(Math.min(SCULPT_SLICE.most, Math.max(SCULPT_SLICE.least, dt * 1000 * SCULPT_SLICE.share)));
          const sliceMs = performance.now() - startedAt;
          measurement.longestSliceMs = Math.max(measurement.longestSliceMs, sliceMs);
          sculptingMs += sliceMs;
          if (isDone) {
            measurement.sculptMs = sculptingMs;
            measurement.sculpted += 1;
            sculptingMs = 0;
          }
        }
      },
      render() {
        watchStage();
        // Slider values queued since the last frame become one edit each, then the figure follows: input to pixels in one frame.
        const flushStartedAt = performance.now();
        if (host.flush()) measurement.flushMs = performance.now() - flushStartedAt;
        const wanted = held.value ? session.baseline() : session.recipe();
        if (wanted !== drawnRecipe) showRecipe(wanted);
        const now = performance.now();
        const dt = Math.min((now - lastFrameAt) / 1000, 0.1);
        lastFrameAt = now;
        const isWalking = Boolean(walking && walking.value);
        if (isWalking) advanceWalk(dt);
        else if (wasWalking) {
          figure.rest();
          figure.pose();
        }
        wasWalking = isWalking;
        figure.root.rotation.y = Kit.look.stepYaw(director.state().yaw, view.settings().yawSteps);
        fitCamera();
        view.render(camera, { clearColor: BACKDROP_COLOR });
      },
      dispose() {
        if (isDraftDirty) saveDraft();
        stageWatcher.disconnect();
        look.stop();
        figure.dispose();
        view.dispose();
        cache.dispose();
      },
      session,
      host,
      director,
      slots,
      debugState: () => ({
        recipe: session.recipe(),
        name: session.name(),
        species: session.recipe().species,
        tab: tab.value,
        preset: look.preset.value,
        isComparing: held.value,
        isWalking: Boolean(walking && walking.value),
        canUndo: session.canUndo(),
        canRedo: session.canRedo(),
        camera: director.state(),
        cameraTarget: director.target(),
        drawnIsCurrent: drawnRecipe === (held.value ? session.baseline() : session.recipe()),
        measurement: { ...measurement, recentInputToApplyMs: latencies.slice() },
        stats: view.stats(),
        figure: figure.counters(),
      }),
    };
  };

  Kit.register({
    id: 'creator',
    kind: 'maker',
    name: 'Character Maker',
    tagline: 'Build a 3D character from head to hem, then share its code',
    hook: 'Sliders, swatches and parts generated from the catalogue; randomise, lock, save and share',
    color: '#86d9c3',
    order: 990,
    theme: creator.THEME,
    create: createCreator,
  });
})();
