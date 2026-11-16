/**
 * Kit figure show: the `figures` screen (`Kit.play('figures')`): the sample bodies of kit/body-samples.js (a
 * human, a winged variant, a hound, a carp and a sword on its own) drawn in 3D by Kit.figure through Kit.look,
 * slowly turning, with the shared look controls, the human's colour choices, a row of live edits that show
 * incremental updates (a dial, a colour, a hat, a sword), and a debug pose that raises an arm by Kit.reach.
 *
 * Owns:  the screen: the samples as rows (`SAMPLES`), the edits as rows (`EDITS`), the stage layout and the
 *        cost probe a tool can run (`Kit.currentGame.measure()`): draw calls and milliseconds per frame for
 *        1, 20 and 200 figures under three bindings (a mesh per piece, a skinned mesh per paint region, and
 *        instancing across figures that share a bake).
 * Does not own: anything it shows (kit/body-*.js, kit/figure*.js, kit/look-*.js) or the look's controls
 *        (kit/look-panel.js).
 *
 * Registered like a game, so the shell gives it a HUD, a back button and clean-up, and the smoke and play
 * tools reach it like any other. It draws its own frame (see `render` in kit/shell.js).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.figure || !Kit.figure.build) return;
  const { html, signal, computed, Cluster, Button, Toggle } = Kit.ui;
  const { Choice, LookControls, Panel, lookControls, freeArea } = Kit.look.panel;

  // ---- tunables -------------------------------------------------------------------------------------------------------

  const BACKDROP_COLOR = 0x6a7399;
  const CAMERA = { pitchDegrees: 10, distance: 12, near: 0.1, far: 40 };
  /** How fast the figures turn, radians per second (advanced on the fixed clock). */
  const TURN_RATE = 0.35;
  /** Room between two figures on the stage, metres. */
  const STAGE_GAP = 0.35;
  /** The contact shadow under each figure: flat, never outlined, a share of the figure's footprint. */
  const SHADOW = { share: 0.75, height: 0.01, segments: 24, tones: ['#3f4870', '#3f4870'] };
  /** The debug pose: the right hand reaches for a point that circles above the shoulder (metres from it, turns per second). */
  const RAISE = { up: 0.5, out: -0.12, forward: 0.18, radius: 0.08, rate: 0.25, hintBack: -0.6, hintDown: -0.2 };
  const RAISED_ARM = ['upperArmRight', 'forearmRight', 'handRight'];
  const FULL_TURN = Math.PI * 2;
  /** The sword alone is shown stood on its pommel: a quarter turn about X of its rest pose. */
  const STAND_UPRIGHT = -Math.PI / 2;

  /**
   * The samples on the stage, left to right. `recipe` goes through the catalogue's bakery; `part` shows a part
   * alone (its plan is a body plan) painted with one ramp of a catalogue palette.
   */
  const SAMPLES = [
    { id: 'human', label: 'Human', recipe: { species: 'human', seed: 11, overrides: { 'fill:handRight': 'sword', 'fill:handRight/gem': null, 'fill:headTop': null } }, facing: 0.5 },
    { id: 'seraph', label: 'Winged', recipe: { species: 'seraph', seed: 5, overrides: { 'fill:headTop': null } }, facing: -0.4 },
    { id: 'hound', label: 'Hound', recipe: { species: 'hound', seed: 3, overrides: { 'fill:mouth': null } }, facing: 1.1 },
    { id: 'carp', label: 'Carp', recipe: { species: 'carp', seed: 8 }, facing: 1.3 },
    { id: 'sword', label: 'Sword', part: 'sword', palette: 'metals', ramp: 0, facing: 0.6 },
  ];
  /** The figure the edits and colour choices act on. */
  const EDITED = 'human';

  /**
   * Live edits of the edited figure, each a pure recipe change through `Kit.body.editor`. Each flips between
   * two states (`isOn` is the state being entered), so pressing twice undoes it; `startsOn` is the first state.
   */
  const EDITS = [
    { id: 'legs', label: 'Long legs', apply: (editor, recipe, isOn) => editor.setDial(recipe, 'legLength', isOn ? 1.2 : 1) },
    { id: 'build', label: 'Heavy build', apply: (editor, recipe, isOn) => editor.setDial(recipe, 'build', isOn ? 1.3 : 0.9) },
    {
      id: 'color',
      label: 'Next cloth',
      apply: (editor, recipe, _isOn, schema) =>
        editor.setColor(recipe, 'cloth', (schema.colors.find((color) => color.id === 'cloth').value + 1) % schema.colors.find((color) => color.id === 'cloth').ramps.length),
    },
    { id: 'hat', label: 'Hat', apply: (editor, recipe, isOn) => editor.setSocket(recipe, 'headTop', isOn ? 'hat' : null) },
    { id: 'sword', label: 'Sword', startsOn: true, apply: (editor, recipe, isOn) => editor.setSocket(recipe, 'handRight', isOn ? 'sword' : null) },
  ];

  // Probe settings (see `measure`).
  const PROBE = { counts: [1, 20, 200], timedFrames: 6, spacing: 0.9, level: 'medium', presets: ['toon', 'pixel'] };
  const RGBA = 4;
  /** Floats per position or normal; skin indices and weights per vertex (three.js reads four influences). */
  const VECTOR = 3;
  const INFLUENCES = 4;
  /** A crowd member's place: x, y, z, heading. */
  const PLACE = 4;
  /** Decimals of the heights in the debug state (a tenth of a millimetre). */
  const DEBUG_DECIMALS = 4;
  /** Palette rows the screen's atlas holds: five figures of `Kit.figure.RAMP_SLOTS` rows, the stage row and the probe's block, with room for more. */
  const ATLAS_ROWS = 128;

  // ---- building the stage ---------------------------------------------------------------------------------------------

  /** A bake-shaped object for a part shown alone: its own plan, one ramp, a rest pose stood upright. */
  const partAlone = (catalog, sample) => {
    const { plan } = catalog.parts[sample.part];
    const rest = Kit.body.createPose(plan);
    Kit.rig.turn(rest.rotation, rest.rotation, 0, 0, STAND_UPRIGHT);
    return { species: sample.part, plan, rest, boneRamp: new Int16Array(plan.boneCount).fill(-1), ramps: [catalog.palettes[sample.palette][sample.ramp]] };
  };

  /** A flat disc under a figure, in the stage palette's one ramp, never outlined. */
  const addShadow = (view, figure, row) => {
    const radius = Math.max(figure.measured.reach * SHADOW.share, SHADOW.height);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, SHADOW.height, SHADOW.segments));
    disc.position.y = -SHADOW.height / 2;
    figure.root.add(disc);
    return view.shading.dress(disc, { ramp: row, tone: 0, inkGroup: 0 });
  };

  /** Places the visible figures side by side, each as wide as its turning footprint; returns the stage's half width. */
  const arrangeStage = (cast) => {
    const visible = cast.filter((member) => member.figure.root.visible);
    const widths = visible.map((member) => 2 * member.figure.measured.reach);
    const total = widths.reduce((sum, width) => sum + width, 0) + STAGE_GAP * Math.max(0, visible.length - 1);
    let left = -total / 2;
    visible.forEach((member, index) => {
      member.figure.root.position.x = left + widths[index] / 2;
      left += widths[index] + STAGE_GAP;
    });
    return { halfWidth: total / 2, highestY: Math.max(...visible.map((member) => member.figure.measured.highestY)) };
  };

  /**
   * Fits the orthographic camera to a window (`Kit.figure.fitView`), off-centre so the window's centre lands
   * in the middle of the screen area the panel leaves free.
   */
  const fitCamera = (camera, size, isPanelShown, window) => {
    const free = freeArea(size, isPanelShown);
    const worldPerPixel = Math.max((2 * window.halfWidth) / free.width, (2 * window.halfHeight) / free.height);
    Object.assign(camera, { left: -free.centerX * worldPerPixel, right: (size.w - free.centerX) * worldPerPixel, top: free.centerY * worldPerPixel, bottom: -(size.h - free.centerY) * worldPerPixel });
    camera.updateProjectionMatrix();
    const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
    camera.position.set(window.centerX, window.centerY + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
    camera.lookAt(window.centerX, window.centerY, 0);
  };

  // ---- the probe's other two bindings ---------------------------------------------------------------------------------

  /**
   * Binding (b), for measurement only: one SkinnedMesh per paint region (pieces with the same ramp and ink
   * group merged), each vertex bound to its bone with weight 1. Bones are flat children of the root whose
   * matrices are written from the pose, exactly like binding (a)'s meshes.
   */
  const buildSkinned = (view, bake, cache, block) => {
    const pieceLayout = Kit.figure.layout(bake, { level: PROBE.level });
    const root = new THREE.Group();
    view.scene.add(root);
    const bones = Array.from({ length: bake.plan.boneCount }, () => {
      const bone = new THREE.Bone();
      bone.matrixAutoUpdate = false;
      root.add(bone);
      return bone;
    });
    const skeleton = new THREE.Skeleton(
      bones,
      bones.map(() => new THREE.Matrix4())
    );
    const regions = new Map();
    pieceLayout.pieces.forEach((piece) => {
      const key = `${piece.ramp}|${piece.inkGroup}`;
      if (!regions.has(key)) regions.set(key, []);
      regions.get(key).push(piece);
    });
    const dressed = [...regions.values()].map((pieces) => {
      const parts = pieces.map((piece) => ({ piece, geometry: cache.acquire(piece) }));
      const vertexCount = parts.reduce((sum, { geometry }) => sum + geometry.attributes.position.count, 0);
      const [positions, normals, skinIndex, skinWeight] = [
        new Float32Array(vertexCount * VECTOR),
        new Float32Array(vertexCount * VECTOR),
        new Uint16Array(vertexCount * INFLUENCES),
        new Float32Array(vertexCount * INFLUENCES),
      ];
      const indices = [];
      let base = 0;
      parts.forEach(({ piece, geometry }) => {
        positions.set(geometry.attributes.position.array, base * VECTOR);
        normals.set(geometry.attributes.normal.array, base * VECTOR);
        for (let vertex = base; vertex < base + geometry.attributes.position.count; vertex++) {
          skinIndex[vertex * INFLUENCES] = piece.bone;
          skinWeight[vertex * INFLUENCES] = 1;
        }
        geometry.index.array.forEach((index) => indices.push(base + index));
        base += geometry.attributes.position.count;
      });
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(positions, VECTOR));
      merged.setAttribute('normal', new THREE.BufferAttribute(normals, VECTOR));
      merged.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, INFLUENCES));
      merged.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, INFLUENCES));
      merged.setIndex(indices);
      const mesh = new THREE.SkinnedMesh(merged);
      // The merged geometry is in bone space (every piece near the origin), so its own bounds would cull wrongly.
      mesh.frustumCulled = false;
      root.add(mesh);
      mesh.bind(skeleton, new THREE.Matrix4());
      return { mesh, parts, entry: view.shading.dress(mesh, { ramp: block.rows[pieces[0].ramp], inkGroup: pieces[0].inkGroup, shiny: pieces[0].shiny }) };
    });
    const local = Kit.rig.copy(bake.rest, Kit.body.createPose(bake.plan));
    const world = Kit.body.createPose(bake.plan);
    return {
      root,
      pose() {
        Kit.body.worldTransforms(bake.plan, local, world);
        for (let bone = 0; bone < bones.length; bone++) Kit.figure.writeBoneMatrix(world, bone, bones[bone].matrix.elements);
      },
      dispose() {
        dressed.forEach(({ mesh, parts, entry }) => {
          view.shading.undress(entry);
          mesh.geometry.dispose();
          parts.forEach(({ piece }) => cache.release(piece.key));
        });
        skeleton.dispose();
        view.scene.remove(root);
      },
    };
  };

  // ---- the screen -----------------------------------------------------------------------------------------------------

  /**
   * Builds the screen: view, figures, camera, panel and the object the shell runs.
   * @param {Object} ctx the shell context
   * @returns {Object} `{ update, render, dispose, debugState, apply, measure }`
   */
  const createFigureShow = (ctx) => {
    const { renderer, size } = ctx;
    const view = Kit.look.view({ renderer, preset: 'toon', atlasRows: ATLAS_ROWS });
    const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
    const bakery = catalog.bakery();
    const editor = Kit.body.editor(catalog);
    const cache = Kit.figure.geometryCache();
    const stageRow = view.atlas.load(Kit.palette.set('stage', { ground: { tones: SHADOW.tones } })).rows.ground;

    const cast = SAMPLES.map((sample) => {
      const bake = sample.part ? partAlone(catalog, sample) : bakery.bakeRecipe(sample.recipe);
      const figure = Kit.figure.build(view, bake, { cache });
      figure.root.rotation.y = sample.facing;
      return { sample, recipe: sample.recipe, figure, shadow: addShadow(view, figure, stageRow) };
    });
    const edited = cast.find((member) => member.sample.id === EDITED);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);

    const controls = lookControls(view, 'toon');
    const shown = signal('all');
    const isTurning = signal(true);
    const isRaised = signal(false);
    const isPanelShown = signal(true);
    const editStates = Object.fromEntries(EDITS.map((edit) => [edit.id, signal(Boolean(edit.startsOn))]));
    const colorSignals = Object.fromEntries(editor.schema(edited.recipe).colors.map((color) => [color.id, signal(color.value)]));
    const readout = signal('');
    const clock = { carry: 0 };
    let yaw = 0;
    let lastEdit = null;
    let governedPixelRatio = renderer.getPixelRatio();
    const reachTarget = new Float32Array(VECTOR);
    /** @type {?{plan: Object, bones: number[]}} the raised arm's bones in the plan drawn now */
    let armBones = null;
    /** What the stage was last arranged for; the stage is arranged again only when this changes (no per-frame allocation). */
    let stageKey = '';
    let editCount = 0;

    /** Draws the edited figure's next recipe with the fewest changes, and says what that cost. */
    const showRecipe = (recipe) => {
      const before = edited.figure.counters();
      const next = bakery.bakeRecipe(recipe);
      const result = edited.figure.setBake(next, editor.changes(edited.figure.bake, next));
      edited.recipe = recipe;
      editCount += 1;
      const after = edited.figure.counters();
      lastEdit = { ...result, geometriesCreated: after.geometriesCreated - before.geometriesCreated, materialsCreated: after.materialsCreated - before.materialsCreated };
      editor.schema(recipe).colors.forEach((color) => (colorSignals[color.id].value = color.value));
      readout.value = `Last edit: kept ${result.kept}, added ${result.added}, removed ${result.removed} meshes; ${lastEdit.geometriesCreated} new geometries, ${lastEdit.materialsCreated} new materials${result.recolored ? ', palette rows rewritten' : ''}.`;
    };
    const runEdit = (edit) => {
      const isOn = !editStates[edit.id].value;
      showRecipe(edit.apply(editor, edited.recipe, isOn, editor.schema(edited.recipe)));
      editStates[edit.id].value = isOn;
    };
    const chooseColor = (channel, rampIndex) => showRecipe(editor.setColor(edited.recipe, channel, rampIndex));

    const showOptions = [{ value: 'all', label: 'All' }, ...SAMPLES.map((sample) => ({ value: sample.id, label: sample.label }))];
    const colorRows = editor
      .schema(edited.recipe)
      .colors.map((color) => ({ ...color, options: color.ramps.map((ramp, index) => ({ value: index, label: ramp.id[0].toUpperCase() + ramp.id.slice(1) })) }));
    ctx.ui.mount(html`<${Panel} isShown=${isPanelShown} label="Figure controls">
      <${Choice} label="Show" options=${showOptions} value=${shown} onPick=${(id) => (shown.value = id)} idPrefix="figure-show" />
      <div class="look-row">
        <span class="ui-label">Live edits of the human</span>
        <${Cluster} gap="6px">
          ${EDITS.map((edit) => html`<${Button} key=${edit.id} id=${`figure-edit-${edit.id}`} class="look-chip" pressed=${computed(() => edit.id !== 'color' && editStates[edit.id].value)} onClick=${() => runEdit(edit)}>${edit.label}<//>`)}
        <//>
        <p class="look-note">${readout}</p>
      </div>
      <${Cluster}>
        <${Toggle} id="figure-raise" label="Debug pose: raise arm" checked=${isRaised} />
        <${Toggle} id="figure-turn" label="Turn" checked=${isTurning} />
      <//>
      <${LookControls} controls=${controls}>
        ${colorRows.map((color) => html`<${Choice} key=${color.id} label=${`Human ${color.label.toLowerCase()} palette`} options=${color.options} value=${colorSignals[color.id]} onPick=${(index) => chooseColor(color.id, index)} idPrefix=${`figure-color-${color.id}`} />`)}
      <//>
    <//>`);

    /** The edited figure's right hand reaches for a point circling above its shoulder (Kit.reach, two bones, exact). */
    const raiseArm = (figure, time) => {
      const { plan } = figure.bake;
      // Bone indices move when the outfit changes, so they are looked up once per bake, not per frame.
      if (!armBones || armBones.plan !== plan) armBones = { plan, bones: RAISED_ARM.map((name) => plan.boneIndex(name)) };
      const [upper, middle, end] = armBones.bones;
      Kit.body.worldTransforms(plan, figure.local, figure.world);
      const shoulder = upper * VECTOR;
      const angle = time * RAISE.rate * FULL_TURN;
      reachTarget[0] = figure.world.translation[shoulder] + RAISE.out + Math.cos(angle) * RAISE.radius;
      reachTarget[1] = figure.world.translation[shoulder + 1] + RAISE.up + Math.sin(angle) * RAISE.radius;
      reachTarget[2] = figure.world.translation[shoulder + 2] + RAISE.forward;
      Kit.reach.twoBone(
        plan.parent,
        figure.local,
        figure.world,
        upper,
        middle,
        end,
        reachTarget[0],
        reachTarget[1],
        reachTarget[2],
        reachTarget[0],
        reachTarget[1] + RAISE.hintDown,
        reachTarget[2] + RAISE.hintBack,
        plan.jointLimits
      );
    };

    let time = 0;
    const poseCast = () => {
      const { yawSteps } = view.settings();
      // Per-frame posing: an index loop, no closures or arrays made.
      for (let index = 0; index < cast.length; index++) {
        const member = cast[index];
        member.figure.root.visible = shown.value === 'all' || shown.value === member.sample.id;
        member.figure.root.rotation.y = Kit.look.stepYaw(member.sample.facing + yaw, yawSteps);
        member.figure.rest();
        if (member === edited && isRaised.value) raiseArm(member.figure, time);
        member.figure.pose();
      }
    };
    const frameCast = () => {
      const key = `${shown.value}|${isPanelShown.value}|${size.w}x${size.h}|${editCount}`;
      if (key === stageKey) return;
      stageKey = key;
      const stage = arrangeStage(cast);
      const free = freeArea(size, isPanelShown.value);
      // The stage is framed by the bodies alone (props never count), so a hat or a sword never rescales it.
      const window = Kit.figure.fitView({ lowestY: 0, highestY: stage.highestY, reach: stage.halfWidth }, free.width / free.height);
      fitCamera(camera, size, isPanelShown.value, window);
    };
    const drawFrame = () => {
      poseCast();
      frameCast();
      view.render(camera, { clearColor: BACKDROP_COLOR });
    };

    // ---- the probe: run on request by a tool, never in the frame loop ----

    const gl = renderer.getContext();
    /** Blocks until the GPU has finished: reading a pixel back is the one call a browser cannot defer. */
    const waitForGpu = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(RGBA));
    /** Grid positions for `count` figures, `PROBE.spacing` apart, centred. */
    const gridSpot = (index, count) => {
      const columns = Math.ceil(Math.sqrt(count));
      return [((index % columns) - (columns - 1) / 2) * PROBE.spacing, (Math.floor(index / columns) - (columns - 1) / 2) * PROBE.spacing];
    };
    const BINDINGS = {
      meshes: (bake, count, rows) => {
        const figures = Array.from({ length: count }, (_unused, index) => {
          const figure = Kit.figure.build(view, bake, { cache, rows, level: PROBE.level });
          const [x, z] = gridSpot(index, count);
          figure.root.position.set(x, 0, z);
          return figure;
        });
        return { pose: () => figures.forEach((figure) => figure.pose()), dispose: () => figures.forEach((figure) => figure.dispose()) };
      },
      skinned: (bake, count, rows) => {
        const figures = Array.from({ length: count }, (_unused, index) => {
          const figure = buildSkinned(view, bake, cache, rows);
          const [x, z] = gridSpot(index, count);
          figure.root.position.set(x, 0, z);
          return figure;
        });
        return { pose: () => figures.forEach((figure) => figure.pose()), dispose: () => figures.forEach((figure) => figure.dispose()) };
      },
      instanced: (bake, count, rows) => {
        const crowd = Kit.figure.crowd(view, bake, count, { cache, rows, level: PROBE.level });
        for (let index = 0; index < count; index++) {
          const [x, z] = gridSpot(index, count);
          crowd.places.set([x, 0, z, 0], index * PLACE);
        }
        return { pose: crowd.pose, dispose: crowd.dispose };
      },
    };

    /**
     * Draw calls, triangles and milliseconds per frame (posing included, GPU flushed) for each binding, figure
     * count and preset. The atlas is not freed between runs, so the probe is meant to run once per screen.
     * @param {string[]} [presetIds] the looks to measure (default toon and pixel)
     * @returns {string} one compact line per preset: `binding count: calls/triangles k/ms` (fits the play tool's log)
     * @complexity O(bindings x counts x presets x frames x figures)
     */
    const measure = (presetIds = PROBE.presets) => {
      const bake = bakery.bakeRecipe({ species: 'human', seed: 11, overrides: { 'fill:handRight': 'sword', 'fill:headTop': 'hat' } });
      // Every probed figure wears the same rows: hundreds of blocks would not fit the atlas, and colour is not what is measured.
      const rows = Kit.figure.loadRows(view, bake);
      const savedShown = shown.value;
      shown.value = 'none';
      stageKey = '';
      cast.forEach((member) => (member.figure.root.visible = false));
      const savedPreset = controls.preset.value;
      const lines = presetIds.map((presetId) => {
        controls.choosePreset(presetId);
        const cells = [];
        Object.entries(BINDINGS).forEach(([name, bind]) =>
          PROBE.counts.forEach((count) => {
            const bound = bind(bake, count, rows);
            const half = (Math.ceil(Math.sqrt(count)) * PROBE.spacing) / 2 + 1;
            fitCamera(camera, size, false, Kit.figure.fitView({ lowestY: 0, highestY: 2, reach: half }, size.w / size.h));
            const frame = () => {
              bound.pose();
              view.render(camera, { clearColor: BACKDROP_COLOR });
            };
            renderer.info.autoReset = false;
            renderer.info.reset();
            frame();
            const { calls, triangles } = renderer.info.render;
            renderer.info.autoReset = true;
            waitForGpu();
            const startedAt = performance.now();
            for (let index = 0; index < PROBE.timedFrames; index++) frame();
            waitForGpu();
            const ms = (performance.now() - startedAt) / PROBE.timedFrames;
            cells.push(`${name[0]}${count}:${calls}/${Math.round(triangles / 1000)}k/${ms.toFixed(1)}`);
            bound.dispose();
          })
        );
        return `${presetId} ${cells.join(' ')}`;
      });
      controls.choosePreset(savedPreset);
      shown.value = savedShown;
      stageKey = '';
      return lines.join(' | ');
    };

    return {
      update(dt) {
        // Game logic on the fixed clock: the turn advances in whole steps, whatever the frame rate.
        for (let step = Kit.dynamics.stepsDue(clock, dt); step > 0; step--) {
          time += Kit.dynamics.FIXED_STEP;
          if (isTurning.value) yaw += TURN_RATE * Kit.dynamics.FIXED_STEP;
        }
        // The shell's quality governor lowers the pixel ratio on a slow device: follow it down to the cheaper look.
        if (renderer.getPixelRatio() < governedPixelRatio) {
          governedPixelRatio = renderer.getPixelRatio();
          view.degrade();
        }
      },
      render: drawFrame,
      dispose() {
        controls.stop();
        cast.forEach((member) => {
          view.shading.undress(member.shadow);
          member.shadow.mesh.geometry.dispose();
          member.figure.dispose();
        });
        view.dispose();
        cache.dispose();
      },
      debugState: () => ({
        shown: shown.value,
        preset: controls.preset.value,
        stats: view.stats(),
        edited: { ...edited.figure.counters(), lastEdit, recipe: edited.recipe },
        figures: cast.map((member) => ({
          id: member.sample.id,
          meshes: member.figure.counters().meshes,
          lowestY: Number(member.figure.measured.lowestY.toFixed(DEBUG_DECIMALS)),
          highestY: Number(member.figure.measured.highestY.toFixed(DEBUG_DECIMALS)),
        })),
        geometries: cache.stats(),
      }),
      /**
       * Sets the screen's state in one call, for scripted captures.
       * @param {{shown?: string, preset?: string, knobs?: Object, yaw?: number, turning?: boolean, raised?: boolean, panel?: boolean, edit?: string}} state
       *   `edit` presses one of the live edits by id ('legs', 'build', 'color', 'hat', 'sword')
       * @returns {boolean}
       * @example Kit.currentGame.apply({ shown: 'human', preset: 'pixel', turning: false, edit: 'hat' })
       */
      apply(state) {
        if (state.shown) shown.value = state.shown;
        if (state.preset) controls.choosePreset(state.preset);
        Object.keys(state.knobs || {}).forEach((id) => (controls.knobs[id].value = state.knobs[id]));
        if (state.yaw !== undefined) yaw = state.yaw;
        if (state.turning !== undefined) isTurning.value = state.turning;
        if (state.raised !== undefined) isRaised.value = state.raised;
        if (state.panel !== undefined) isPanelShown.value = state.panel;
        if (state.edit) runEdit(EDITS.find((edit) => edit.id === state.edit));
        return true;
      },
      measure,
    };
  };

  Kit.register({
    id: 'figures',
    kind: 'workbench',
    name: 'Figures',
    tagline: 'Body samples drawn in 3D through the stylised look',
    hook: 'Turn them, restyle them, edit them live',
    color: '#9ad1b4',
    order: 998,
    theme: { skin: 'glass' },
    create: createFigureShow,
  });
})();
