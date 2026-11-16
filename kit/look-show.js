/**
 * Kit look show: the showcase screen of the stylised look (`Kit.play('look')`): two stand-in figures built from
 * primitives, each with its own palette, slowly turning, with controls for the preset, the palettes and every knob.
 *
 * Owns:  the `look` screen; the stand-in figures as data (`PARTS`, `FIGURES`); the control panel generated from
 *        `Kit.look.KNOBS`; and the measurements a tool can ask for (`Kit.currentGame.measure()`): exact-colour
 *        readback, cost per look, shimmer under rotation and motion, skinned and instanced meshes.
 * Does not own: the look itself (look-palette.js, look-toon.js, look-ink.js, look-view.js) or real characters
 *        (the body system builds those; this screen only needs something with a head, limbs and a held prop).
 *
 * It is registered like a game, so the shell gives it a HUD, a back button and clean-up, and the smoke and
 * play tools reach it like any other. It draws its own frame (see `render` in kit/shell.js).
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, signal, computed, effect, css, ScrollPane, Button, Cluster, Toggle, Slider } = Kit.ui;
  const look = Kit.look;

  // ---- tunables --------------------------------------------------------------------------------------------------------

  /** Flat backdrop behind the figures (sRGB, written to the screen as is). */
  const BACKDROP_COLOR = 0x6a7399;
  /** Share of the screen the control panel takes: the bottom in portrait, the right side in landscape. */
  const PANEL_SHARE = 0.46;
  /** Height of the shell's top bar the figures must stay clear of, CSS pixels. */
  const TOP_BAR_PIXELS = 52;
  /** The world rectangle that must fit in the free part of the screen, world units. */
  const STAGE = { width: 3.7, height: 2.75, centerY: 1.08 };
  const CAMERA = { pitchDegrees: 10, distance: 8, near: 0.1, far: 30 };
  /** How fast the figures turn, radians per second. */
  const TURN_RATE = 0.45;
  const SWAY = { rate: 0.7, reach: 0.35 };
  const HALF_TURN = Math.PI / 2;

  const SEGMENTS = { around: 20, rings: 14, cap: 6, tube: 8 };
  /** Geometry builders, by the `shape` of a part row; `size` is the list each one reads. */
  const SHAPES = {
    sphere: ([radius]) => new THREE.SphereGeometry(radius, SEGMENTS.around, SEGMENTS.rings),
    capsule: ([radius, length]) => new THREE.CapsuleGeometry(radius, length, SEGMENTS.cap, SEGMENTS.around),
    cylinder: ([topRadius, bottomRadius, height]) => new THREE.CylinderGeometry(topRadius, bottomRadius, height, SEGMENTS.around),
    box: ([width, height, depth]) => new THREE.BoxGeometry(width, height, depth),
    torus: ([radius, tube]) => new THREE.TorusGeometry(radius, tube, SEGMENTS.tube, SEGMENTS.around),
    /** The top of a sphere, down to `sweep` of the way from pole to pole: a hair cap. */
    cap: ([radius, sweep]) => new THREE.SphereGeometry(radius, SEGMENTS.around, SEGMENTS.rings, 0, Math.PI * 2, 0, Math.PI * sweep),
    gem: ([radius]) => new THREE.OctahedronGeometry(radius, 0),
  };

  /**
   * @typedef {Object} PartRow
   * One primitive of a figure. Lengths are world units; the figure stands on y = 0 and faces +z.
   * @property {string} shape a key of SHAPES
   * @property {number[]} size what that shape reads
   * @property {number[]} at centre, [x, y, z]
   * @property {number[]} [turn] rotation, [x, y, z] radians
   * @property {number[]} [stretch] scale along the part's own axes
   * @property {string} ramp ramp name in the figure's palette
   * @property {number} [group] ink group (default 1; 0 is never outlined)
   * @property {boolean} [shiny]
   * @property {boolean} [emissive]
   * @property {number} [tone] fixed tone 0..1
   */

  const INK = { none: 0, skin: 1, cloth: 2, belt: 3, head: 4, boots: 5, collar: 6, hair: 7, prop: 8 };
  /** Mirrors a row across the figure's middle (x and the turns about y and z change sign). */
  const mirrored = (row) => ({ ...row, at: [-row.at[0], row.at[1], row.at[2]], turn: row.turn && [row.turn[0], -row.turn[1], -row.turn[2]] });
  const bothSides = (rows) => rows.flatMap((row) => [row, mirrored(row)]);

  /** @type {Record<string, PartRow[]>} */
  const PARTS = {
    body: [
      { shape: 'cylinder', size: [0.62, 0.62, 0.02], at: [0, 0.01, 0], ramp: 'ground', tone: 0, group: INK.none },
      ...bothSides([
        { shape: 'sphere', size: [0.17], at: [-0.17, 0.11, 0.05], stretch: [1, 0.65, 1.45], ramp: 'leather', group: INK.boots },
        { shape: 'capsule', size: [0.105, 0.3], at: [-0.17, 0.42, 0], ramp: 'skin', group: INK.skin },
        { shape: 'sphere', size: [0.075], at: [-0.16, 1.64, 0.355], stretch: [0.8, 1.25, 0.45], ramp: 'eye', tone: 0, group: INK.none },
      ]),
      { shape: 'cylinder', size: [0.3, 0.43, 0.34], at: [0, 0.72, 0], stretch: [1, 1, 0.82], ramp: 'cloth', group: INK.cloth },
      { shape: 'capsule', size: [0.3, 0.26], at: [0, 1.0, 0], stretch: [1, 1, 0.8], ramp: 'cloth', group: INK.cloth },
      { shape: 'torus', size: [0.33, 0.05], at: [0, 0.86, 0], turn: [HALF_TURN, 0, 0], stretch: [1, 0.82, 1], ramp: 'leather', group: INK.belt },
      { shape: 'box', size: [0.1, 0.1, 0.04], at: [0, 0.86, 0.29], ramp: 'trim', shiny: true, group: INK.belt },
      { shape: 'torus', size: [0.2, 0.075], at: [0, 1.27, 0], turn: [HALF_TURN, 0, 0], stretch: [1, 0.85, 1], ramp: 'trim', group: INK.collar },
      // The left arm hangs; the right arm reaches forward to hold the prop.
      { shape: 'capsule', size: [0.095, 0.3], at: [-0.44, 0.98, 0], turn: [0, 0, -0.22], ramp: 'cloth', group: INK.cloth },
      { shape: 'sphere', size: [0.11], at: [-0.5, 0.74, 0], ramp: 'skin', group: INK.skin },
      { shape: 'capsule', size: [0.095, 0.3], at: [0.42, 1.02, 0.14], turn: [-0.9, 0, 0.15], ramp: 'cloth', group: INK.cloth },
      { shape: 'sphere', size: [0.11], at: [0.46, 0.93, 0.36], ramp: 'skin', group: INK.skin },
      { shape: 'sphere', size: [0.42], at: [0, 1.66, 0], stretch: [1, 0.94, 0.96], ramp: 'skin', group: INK.head },
      // Glints sit toward the light on both eyes; the mouth is a sliver of the skin ramp's darkest tone.
      { shape: 'sphere', size: [0.024], at: [-0.185, 1.685, 0.375], ramp: 'eye', emissive: true },
      { shape: 'sphere', size: [0.024], at: [0.135, 1.685, 0.375], ramp: 'eye', emissive: true },
      { shape: 'box', size: [0.1, 0.03, 0.03], at: [0, 1.49, 0.395], ramp: 'skin', tone: 0, group: INK.none },
    ],
    tuftHair: [
      { shape: 'cap', size: [0.455, 0.56], at: [0, 1.69, -0.02], turn: [-0.38, 0, 0], ramp: 'hair', shiny: true, group: INK.hair },
      { shape: 'cylinder', size: [0, 0.12, 0.3], at: [0.06, 2.1, 0.08], turn: [0.5, 0, -0.3], ramp: 'hair', group: INK.hair },
      { shape: 'sphere', size: [0.17], at: [0, 1.5, -0.42], stretch: [1, 1.5, 1], ramp: 'hair', shiny: true, group: INK.hair },
    ],
    bunHair: [
      { shape: 'cap', size: [0.455, 0.5], at: [0, 1.69, -0.02], turn: [-0.22, 0, 0], ramp: 'hair', shiny: true, group: INK.hair },
      { shape: 'sphere', size: [0.2], at: [0, 2.1, -0.1], ramp: 'hair', shiny: true, group: INK.hair },
      ...bothSides([{ shape: 'capsule', size: [0.085, 0.3], at: [-0.39, 1.5, 0.05], ramp: 'hair', group: INK.hair }]),
    ],
    staff: [
      { shape: 'cylinder', size: [0.035, 0.035, 1.7], at: [0.47, 0.95, 0.42], ramp: 'leather', group: INK.prop },
      { shape: 'torus', size: [0.1, 0.03], at: [0.47, 1.8, 0.42], turn: [HALF_TURN, 0, 0], ramp: 'metal', shiny: true, group: INK.prop },
      { shape: 'gem', size: [0.14], at: [0.47, 1.95, 0.42], ramp: 'glow', emissive: true },
    ],
    blade: [
      { shape: 'box', size: [0.12, 0.95, 0.035], at: [0.47, 1.52, 0.42], ramp: 'metal', shiny: true, group: INK.prop },
      { shape: 'box', size: [0.34, 0.07, 0.08], at: [0.47, 1.03, 0.42], ramp: 'trim', shiny: true, group: INK.prop },
      { shape: 'cylinder', size: [0.035, 0.035, 0.3], at: [0.47, 0.86, 0.42], ramp: 'leather', group: INK.prop },
      { shape: 'sphere', size: [0.06], at: [0.47, 0.69, 0.42], ramp: 'trim', shiny: true, group: INK.prop },
    ],
  };

  /** The two figures: where each stands, which way it turns, what it is made of and its starting palette. */
  const FIGURES = [
    { id: 'wanderer', label: 'Left figure', at: -0.86, facing: 0.35, spin: 1, palette: 'ember', parts: ['body', 'tuftHair', 'staff'] },
    { id: 'sentinel', label: 'Right figure', at: 0.86, facing: -0.35, spin: -1, palette: 'tide', parts: ['body', 'bunHair', 'blade'] },
  ];

  // Measurement settings (see `measure`).
  const TIMED_FRAMES = 10;
  const SHIMMER = { frames: 24, yawStep: 0.0087, startYaw: 0.6, moveTexels: 0.23, moveFrames: 16, maxShift: 6 };
  const RGBA = 4;

  // ---- figures ---------------------------------------------------------------------------------------------------------

  /**
   * Builds one figure from part rows and dresses every mesh in the view's look.
   * @param {ReturnType<typeof Kit.look.view>} view
   * @param {typeof FIGURES[number]} figure
   * @returns {{root: THREE.Group, block: Object, dressed: Array<{entry: Object, ramp: string}>}}
   * @complexity O(parts)
   */
  const buildFigure = (view, figure) => {
    const root = new THREE.Group();
    root.position.x = figure.at;
    const anchor = view.add(root);
    const block = view.atlas.load(look.PALETTES[figure.palette]);
    const dressed = figure.parts
      .flatMap((name) => PARTS[name])
      .map((row) => {
        const mesh = new THREE.Mesh(SHAPES[row.shape](row.size));
        mesh.position.set(...row.at);
        if (row.turn) mesh.rotation.set(...row.turn);
        if (row.stretch) mesh.scale.set(...row.stretch);
        root.add(mesh);
        const entry = view.shading.dress(mesh, { ramp: block.rows[row.ramp], inkGroup: row.group, shiny: row.shiny, emissive: row.emissive, tone: row.tone, anchor });
        return { entry, ramp: row.ramp };
      });
    return { root, block, dressed };
  };

  /**
   * Fits the orthographic camera so the stage rectangle fills the part of the screen the panel leaves free.
   * The frustum is off-centre: the world point (0, STAGE.centerY) lands in the middle of the free area.
   */
  const frameStage = (camera, size, isPanelShown) => {
    const panelWidth = isPanelShown && !size.portrait ? size.w * PANEL_SHARE : 0;
    const panelHeight = isPanelShown && size.portrait ? size.h * PANEL_SHARE : 0;
    const free = { width: size.w - panelWidth, height: size.h - panelHeight - TOP_BAR_PIXELS };
    const worldPerPixel = Math.max(STAGE.width / free.width, STAGE.height / free.height);
    const centerX = free.width / 2;
    const centerY = TOP_BAR_PIXELS + free.height / 2;
    Object.assign(camera, { left: -centerX * worldPerPixel, right: (size.w - centerX) * worldPerPixel, top: centerY * worldPerPixel, bottom: -(size.h - centerY) * worldPerPixel });
    camera.updateProjectionMatrix();
  };

  // ---- controls --------------------------------------------------------------------------------------------------------

  /** A labelled row of exclusive buttons. `idPrefix` makes each button addressable by tools. */
  const Choice = ({ label, options, value, onPick, idPrefix }) =>
    html`<div class="look-row">
      <span class="ui-label">${label}</span>
      <${Cluster} gap="6px">
        ${options.map((option) => html`<${Button} key=${option.value} id=${`${idPrefix}-${option.value}`} class="look-chip" pressed=${computed(() => value.value === option.value)} onClick=${() => onPick(option.value)}>${option.label}<//>`)}
      <//>
    </div>`;

  /** One editor control for a knob row of Kit.look.KNOBS, bound to that knob's signal. */
  const KnobControl = ({ knob, value, onChange }) => {
    if (knob.type === 'choice') return html`<${Choice} label=${knob.label} options=${knob.options} value=${value} onPick=${onChange} idPrefix=${`look-${knob.id}`} />`;
    if (knob.type === 'toggle') return html`<${Toggle} id=${`look-${knob.id}`} label=${knob.label} checked=${value} onChange=${onChange} />`;
    return html`<${Slider} id=${`look-${knob.id}`} label=${knob.label} value=${value} min=${knob.min} max=${knob.max} step=${knob.step} format=${(amount) => String(Math.round(amount * 1000) / 1000)} onInput=${onChange} />`;
  };

  css(`
    .look-panel { position: fixed; left: 0; right: 0; bottom: 0; height: ${PANEL_SHARE * 100}%; display: flex; flex-direction: column; pointer-events: auto;
      background: var(--panel); border-top: var(--border) solid var(--line); backdrop-filter: blur(var(--blur)); color: var(--ink); font-family: var(--body); }
    .look-panel-inner { display: flex; flex-direction: column; gap: 12px; padding: 12px max(14px, env(safe-area-inset-right, 0px)) calc(env(safe-area-inset-bottom, 0px) + 16px) max(14px, env(safe-area-inset-left, 0px)); }
    .look-row { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .look-chip { min-height: 40px; padding: 4px 11px; font-size: 13px; }
    .look-note { margin: 0; font-size: 12px; color: var(--dim); }
    .look-hidden { display: none; }
    .look-show-button { position: fixed; pointer-events: auto; right: max(12px, env(safe-area-inset-right, 0px)); bottom: calc(env(safe-area-inset-bottom, 0px) + 12px); }
    @media (orientation: landscape) {
      .look-panel { left: auto; top: 0; width: ${PANEL_SHARE * 100}%; height: auto; border-top: 0; border-left: var(--border) solid var(--line); }
      .look-panel-inner { padding-top: ${TOP_BAR_PIXELS}px; }
    }
  `);

  // ---- measurements ----------------------------------------------------------------------------------------------------

  /** How many texels of two equal-sized RGBA images differ. */
  const countDifferent = (first, second) => {
    let different = 0;
    // A measured hot loop over typed arrays: index arithmetic instead of slices.
    for (let offset = 0; offset < first.length; offset += RGBA) {
      if (first[offset] !== second[offset] || first[offset + 1] !== second[offset + 1] || first[offset + 2] !== second[offset + 2] || first[offset + 3] !== second[offset + 3]) different += 1;
    }
    return different;
  };
  const countFilled = (texels) => {
    let filled = 0;
    for (let offset = 3; offset < texels.length; offset += RGBA) if (texels[offset]) filled += 1;
    return filled;
  };
  /** Texels that changed and then changed straight back over three frames (A, B, A): flicker, as opposed to motion. */
  const countFlipFlops = (before, middle, after) => {
    let flips = 0;
    for (let offset = 0; offset < middle.length; offset += RGBA) {
      const isChanged = before[offset] !== middle[offset] || before[offset + 1] !== middle[offset + 1] || before[offset + 2] !== middle[offset + 2];
      const isBack = before[offset] === after[offset] && before[offset + 1] === after[offset + 1] && before[offset + 2] === after[offset + 2];
      if (isChanged && isBack) flips += 1;
    }
    return flips;
  };
  /** How many texels of `image` differ from `reference` moved `shift` texels to the right. */
  const countDifferentShifted = (image, reference, width, shift) => {
    let different = 0;
    const height = image.length / RGBA / width;
    for (let row = 0; row < height; row++) {
      for (let column = Math.max(0, shift); column < Math.min(width, width + shift); column++) {
        const offset = (row * width + column) * RGBA;
        const source = offset - shift * RGBA;
        if (image[offset] !== reference[source] || image[offset + 1] !== reference[source + 1] || image[offset + 2] !== reference[source + 2]) different += 1;
      }
    }
    return different;
  };
  const percent = (part, whole) => Math.round((1000 * part) / Math.max(1, whole)) / 10;

  // ---- the screen ------------------------------------------------------------------------------------------------------

  /**
   * Builds the showcase: view, figures, camera, panel and the object the shell runs.
   * @param {Object} ctx the shell context
   * @returns {Object} `{ update, render, dispose, debugState, apply, measure }`
   */
  const createShowcase = (ctx) => {
    const { renderer, size } = ctx;
    const view = look.view({ renderer, preset: 'toon' });
    const figures = FIGURES.map((figure) => ({ ...figure, ...buildFigure(view, figure) }));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);
    const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
    camera.position.set(0, STAGE.centerY + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
    camera.lookAt(0, STAGE.centerY, 0);

    // Signals behind the panel: the preset, one per knob, one palette per figure, and the motion switches.
    const preset = signal('toon');
    const knobs = Object.fromEntries(look.KNOBS.map((knob) => [knob.id, signal(look.PRESETS.toon[knob.id])]));
    const palettes = figures.map((figure) => signal(figure.palette));
    const isTurning = signal(true);
    const isSwaying = signal(false);
    const isPanelShown = signal(true);
    const readout = signal('');
    let yaw = 0;
    let swayOffset = 0;
    /** A fixed sideways shift set by tools (world units), to study sub-texel positions. */
    let nudge = 0;
    let governedPixelRatio = renderer.getPixelRatio();

    const knobValues = () => Object.fromEntries(look.KNOBS.map((knob) => [knob.id, knobs[knob.id].value]));
    const choosePreset = (presetId) => {
      preset.value = presetId;
      look.KNOBS.forEach((knob) => (knobs[knob.id].value = look.PRESETS[presetId][knob.id]));
    };
    const choosePalette = (index, name) => {
      palettes[index].value = name;
      // The figure's rows are rewritten in place: no material changes, and the other figure's rows are untouched.
      view.atlas.write(figures[index].block, look.PALETTES[name]);
    };
    const stopSettingsEffect = effect(() => void view.use(preset.value, knobValues()));

    const paletteOptions = Object.keys(look.PALETTES).map((name) => ({ value: name, label: name[0].toUpperCase() + name.slice(1) }));
    const presetOptions = Object.keys(look.PRESETS).map((id) => ({ value: id, label: look.PRESETS[id].label }));
    const panel = html`<div class=${computed(() => (isPanelShown.value ? 'look-panel' : 'look-panel look-hidden'))}>
        <${ScrollPane} fill id="look-scroll" label="Look controls">
          <div class="look-panel-inner">
            <${Choice} label="Preset" options=${presetOptions} value=${preset} onPick=${choosePreset} idPrefix="look-preset" />
            <p class="look-note">${computed(() => look.PRESETS[preset.value].about)} ${readout}</p>
            ${figures.map((figure, index) => html`<${Choice} key=${figure.id} label=${`${figure.label} palette`} options=${paletteOptions} value=${palettes[index]} onPick=${(name) => choosePalette(index, name)} idPrefix=${`look-${figure.id}`} />`)}
            ${look.KNOBS.map((knob) => html`<${KnobControl} key=${knob.id} knob=${knob} value=${knobs[knob.id]} onChange=${(value) => (knobs[knob.id].value = value)} />`)}
            <${Cluster}>
              <${Toggle} id="look-turn" label="Turn" checked=${isTurning} />
              <${Toggle} id="look-sway" label="Walk side to side" checked=${isSwaying} />
              <${Button} id="look-hide" onClick=${() => (isPanelShown.value = false)}>Hide controls<//>
            <//>
          </div>
        <//>
      </div>
      <div class=${computed(() => (isPanelShown.value ? 'look-hidden' : 'look-show-button'))}><${Button} id="look-show" onClick=${() => (isPanelShown.value = true)}>Controls<//></div>`;
    ctx.ui.mount(panel);

    const poseFigures = () => {
      const { yawSteps } = view.settings();
      figures.forEach((figure) => {
        figure.root.rotation.y = look.stepYaw(figure.facing + figure.spin * yaw, yawSteps);
        figure.root.position.x = figure.at + swayOffset + nudge;
      });
    };
    const drawFrame = () => {
      frameStage(camera, size, isPanelShown.value);
      poseFigures();
      view.render(camera, { clearColor: BACKDROP_COLOR });
    };

    // ---- measurements: run on request by a tool, never in the frame loop ----

    const gl = renderer.getContext();
    /** Reads one screen pixel under a world point, as [red, green, blue]. */
    const readScreenAt = (worldPoint) => {
      const projected = worldPoint.clone().project(camera);
      const pixel = new Uint8Array(RGBA);
      gl.readPixels(Math.floor((projected.x * 0.5 + 0.5) * gl.drawingBufferWidth), Math.floor((projected.y * 0.5 + 0.5) * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel.subarray(0, 3));
    };
    /** Blocks until the GPU has finished: reading a pixel back is the one call a browser cannot defer. */
    const waitForGpu = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(RGBA));
    const largestGap = (seen, wanted) => Math.max(...seen.map((channel, index) => Math.abs(channel - wanted[index])));
    /** Adds a temporary dressed mesh in front of the figures, runs `read`, and removes it again. */
    const withProbeMesh = (mesh, part, read) => {
      view.scene.add(mesh);
      const entry = view.shading.dress(mesh, part);
      drawFrame();
      const result = read();
      view.scene.remove(mesh);
      view.shading.undress(entry);
      mesh.geometry.dispose();
      return result;
    };
    const inFront = (x, y) => new THREE.Vector3(x, y, 2.5);

    /** A flat emissive swatch must come back from the screen as the palette's own bytes. */
    const measureSwatch = () => {
      const row = figures[0].block.rows.cloth;
      const swatch = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6));
      swatch.position.copy(inFront(0, STAGE.centerY));
      return withProbeMesh(swatch, { ramp: row, emissive: true }, () => {
        const seen = readScreenAt(swatch.position);
        const wanted = view.atlas.colorAt(row, view.settings().toneCount - 1);
        return { seen: look.hexOf(seen), wanted: look.hexOf(wanted), gap: largestGap(seen, wanted) };
      });
    };

    /** Instanced spheres with a ramp per instance, and a skinned bar bent at its middle bone, must both draw. */
    const measureMeshKinds = () => {
      const rows = figures[0].block.rows;
      const spots = [-0.5, 0, 0.5].map((x) => inFront(x, 2.2));
      const geometry = new THREE.SphereGeometry(0.12, SEGMENTS.around, SEGMENTS.rings);
      // Offsets from the cloth row to the cloth, trim and leather rows of the same block.
      const offsets = [0, rows.trim - rows.cloth, rows.leather - rows.cloth];
      geometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 1));
      const instanced = new THREE.InstancedMesh(geometry, undefined, spots.length);
      spots.forEach((spot, index) => instanced.setMatrixAt(index, new THREE.Matrix4().setPosition(spot)));
      const instancedGaps = withProbeMesh(instanced, { ramp: rows.cloth, emissive: true, instanceRamp: true }, () =>
        spots.map((spot, index) => largestGap(readScreenAt(spot), view.atlas.colorAt(rows.cloth + offsets[index], view.settings().toneCount - 1)))
      );

      // A bar along +y with two bones; bending the upper bone a quarter turn swings the top half to point along -x.
      const bar = new THREE.BoxGeometry(0.1, 0.8, 0.1, 1, 8, 1);
      const heights = bar.attributes.position.array.filter((_, index) => index % 3 === 1);
      bar.setAttribute(
        'skinIndex',
        new THREE.Uint16BufferAttribute(
          Array.from(heights).flatMap((height) => [height > 0 ? 1 : 0, 0, 0, 0]),
          4
        )
      );
      bar.setAttribute(
        'skinWeight',
        new THREE.Float32BufferAttribute(
          Array.from(heights).flatMap(() => [1, 0, 0, 0]),
          4
        )
      );
      const [lower, upper] = [new THREE.Bone(), new THREE.Bone()];
      lower.add(upper);
      const skinned = new THREE.SkinnedMesh(bar);
      skinned.add(lower);
      skinned.bind(new THREE.Skeleton([lower, upper]));
      skinned.position.copy(inFront(0, 0.5));
      upper.rotation.z = HALF_TURN;
      const wanted = () => view.atlas.colorAt(rows.trim, view.settings().toneCount - 1);
      const skinnedResult = withProbeMesh(skinned, { ramp: rows.trim, emissive: true }, () => ({
        bentTipGap: largestGap(readScreenAt(inFront(-0.3, 0.5)), wanted()),
        straightTipGap: largestGap(readScreenAt(inFront(0, 0.8)), wanted()),
      }));
      return { instancedGaps, ...skinnedResult };
    };

    /** Draw calls, triangles and milliseconds per frame of the current look (the time includes a GPU flush). */
    const measureCost = () => {
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
      const stats = view.stats();
      return { calls, triangles, ms: Math.round(((performance.now() - startedAt) / TIMED_FRAMES) * 10) / 10, path: stats.path, scale: stats.scale, targets: stats.targets };
    };

    const texelsNow = () => {
      drawFrame();
      return view.readTexels();
    };
    /** Share of filled texels that flicker (A, B, A) per frame while the figures turn in half-degree steps. */
    const measureTurnFlicker = () => {
      const frames = Array.from({ length: SHIMMER.frames }, (_, index) => {
        yaw = SHIMMER.startYaw + index * SHIMMER.yawStep;
        return texelsNow().data;
      });
      const flips = frames.slice(2).reduce((total, after, index) => total + countFlipFlops(frames[index], frames[index + 1], after), 0);
      const changes = frames.slice(1).reduce((total, after, index) => total + countDifferent(frames[index], after), 0);
      const filled = countFilled(frames[0]);
      return { flickerPercent: percent(flips, filled * (frames.length - 2)), changePercent: percent(changes, filled * (frames.length - 1)) };
    };
    /**
     * Share of filled texels that differ from the first frame slid along by whole texels, while the figures
     * move sideways a fraction of a texel per frame. 0 means the sprite keeps one shape as it moves.
     */
    const measureMoveDrift = () => {
      const first = texelsNow();
      const texelWorld = (camera.top - camera.bottom) / first.height;
      const filled = countFilled(first.data);
      const worst = Array.from({ length: SHIMMER.moveFrames }, (_, index) => {
        swayOffset = (index + 1) * SHIMMER.moveTexels * texelWorld;
        const moved = texelsNow().data;
        const shifts = Array.from({ length: SHIMMER.maxShift * 2 + 1 }, (_unused, shiftIndex) => shiftIndex - SHIMMER.maxShift);
        return Math.min(...shifts.map((shift) => countDifferentShifted(moved, first.data, first.width, shift)));
      });
      swayOffset = 0;
      return {
        driftPercent: percent(
          worst.reduce((total, count) => total + count, 0),
          filled * worst.length
        ),
        worstPercent: percent(Math.max(...worst), filled),
      };
    };

    /**
     * Runs every measurement and returns plain data. Slow (hundreds of frames): for tools, not for play.
     * @returns {Object} `{ webgl2, swatch, cost, meshKinds, turnFlicker, moveDrift, degrade }`, each keyed by the look measured
     * @complexity O(looks x frames x texels)
     */
    const measure = () => {
      const saved = { preset: preset.value, knobs: knobValues(), yaw, isTurning: isTurning.value };
      const wear = (presetId, overrides) => view.use(presetId, overrides);
      const looks = {
        toon: () => wear('toon'),
        'toon + ink at native': () => wear('toon', { outline: 'ink' }),
        pixel: () => wear('pixel'),
        'pixel + hull': () => wear('pixel', { outline: 'hull' }),
        soft: () => wear('soft'),
      };
      const each = (names, read) =>
        Object.fromEntries(
          names.map((name) => {
            looks[name]();
            return [name, read()];
          })
        );
      /** Wears the pixel look with each row's overrides in turn and measures it. */
      const eachPixelVariant = (variants, read) =>
        Object.fromEntries(
          variants.map(([name, overrides]) => {
            wear('pixel', overrides);
            yaw = SHIMMER.startYaw;
            return [name, read()];
          })
        );
      yaw = SHIMMER.startYaw;
      const report = {
        webgl2: renderer.capabilities.isWebGL2,
        swatch: each(['toon', 'pixel', 'soft'], measureSwatch),
        cost: each(Object.keys(looks), measureCost),
        meshKinds: each(['toon', 'pixel'], measureMeshKinds),
        turnFlicker: eachPixelVariant(
          [
            ['no dither', { dither: 0, yawSteps: 0 }],
            ['dither fixed to screen', { ditherSpace: 'screen', yawSteps: 0 }],
            ['dither fixed to figure', { ditherSpace: 'anchored', yawSteps: 0 }],
            ['dither fixed to surface', { ditherSpace: 'object', yawSteps: 0 }],
            ['24 facings, dither fixed to figure', { ditherSpace: 'anchored', yawSteps: 24 }],
          ],
          measureTurnFlicker
        ),
        moveDrift: eachPixelVariant(
          [
            ['no snap, dither fixed to screen', { snap: false, ditherSpace: 'screen' }],
            ['no snap, dither fixed to figure', { snap: false, ditherSpace: 'anchored' }],
            ['snap, dither fixed to screen', { snap: true, ditherSpace: 'screen' }],
            ['snap, dither fixed to figure', { snap: true, ditherSpace: 'anchored' }],
            ['snap, no dither', { snap: true, dither: 0 }],
          ],
          measureMoveDrift
        ),
      };
      yaw = saved.yaw;
      view.use(saved.preset, saved.knobs);
      return report;
    };

    return {
      update(dt, time) {
        if (isTurning.value) yaw += dt * TURN_RATE;
        swayOffset = isSwaying.value ? Math.sin(time * SWAY.rate) * SWAY.reach : 0;
        // The shell's quality governor lowers the pixel ratio on a slow device: follow it down to the cheaper look.
        if (renderer.getPixelRatio() < governedPixelRatio) {
          governedPixelRatio = renderer.getPixelRatio();
          view.degrade();
        }
        const stats = view.stats();
        readout.value = stats.path === 'indexed' ? `Drawn as ${stats.targets[0].split(' ')[1]} texels, ${stats.scale} px each.` : 'Drawn at native resolution.';
      },
      render: drawFrame,
      dispose() {
        stopSettingsEffect();
        view.dispose();
        figures.forEach((figure) => figure.root.traverse((object) => object.geometry && object.geometry.dispose()));
      },
      debugState: () => ({ preset: preset.value, settings: view.settings(), stats: view.stats(), palettes: palettes.map((name) => name.value), yaw }),
      /**
       * Sets the screen's state in one call, for scripted captures.
       * @param {{preset?: string, knobs?: Object, palettes?: string[], yaw?: number, turning?: boolean, swaying?: boolean, nudge?: number, panel?: boolean}} state
       * @example Kit.currentGame.apply({ preset: 'pixel', yaw: 0.8, turning: false })
       */
      apply(state) {
        if (state.preset) choosePreset(state.preset);
        Object.keys(state.knobs || {}).forEach((id) => (knobs[id].value = state.knobs[id]));
        (state.palettes || []).forEach((name, index) => choosePalette(index, name));
        if (state.yaw !== undefined) yaw = state.yaw;
        if (state.turning !== undefined) isTurning.value = state.turning;
        if (state.swaying !== undefined) isSwaying.value = state.swaying;
        if (state.nudge !== undefined) nudge = state.nudge;
        if (state.panel !== undefined) isPanelShown.value = state.panel;
        return true;
      },
      measure,
    };
  };

  Kit.register({
    id: 'look',
    name: 'Look',
    tagline: 'Palette, toon and pixel-art shading for 3D characters',
    hook: 'Switch preset and palette; watch it turn',
    color: '#e07a9a',
    order: 998,
    theme: { skin: 'glass' },
    create: createShowcase,
  });
})();
