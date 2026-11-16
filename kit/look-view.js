/**
 * Kit look view: the thin composition that draws a scene of dressed meshes in a chosen look. It joins the
 * palette atlas, the shading and the indexed pipeline, and decides per frame which path a look needs.
 *
 * Owns:  `Kit.look.view`: a scene for the figures, the current settings (preset plus knob overrides), the
 *        choice between the direct path (colour straight to the screen, hull outlines, anti-aliased) and the
 *        indexed path (look-ink.js), texel snapping and dither anchoring of figures, the depth range fitted
 *        round them, and the cheaper fallback for slow devices (`degrade`).
 * Does not own: the pieces it composes (kit/palette.js, look-settings.js, look-toon.js, look-ink.js), the camera, animation
 *        (a caller rounds a turn with Kit.look.stepYaw), or the background behind the figures.
 *
 * Colour: the view writes palette bytes straight to the screen, so it must be drawn outside the kit's HDR
 * post chain (a game does that by returning `render` from create(); see kit/shell.js).
 * Needs THREE and WebGL, so it is exercised in the browser (Kit.play('look')) rather than by unit tests.
 */
(() => {
  /** The fitted depth range is widened by this share of the figures' radius, for limbs that swing past the rest pose. */
  const DEPTH_MARGIN = 0.15;

  /**
   * @typedef {Object} LookView
   * @property {THREE.Scene} scene add figures here (through `add`); only dressed meshes belong in it
   * @property {boolean} isWebGL2 whether the renderer is WebGL2 (a sculpted crowd needs it)
   * @property {ReturnType<typeof Kit.palette.atlas>} atlas the palette table; `atlas.load(palette)` gives a figure its rows
   * @property {Object} shading from Kit.look.shading: `shading.dress(mesh, part)`
   * @property {function(THREE.Object3D): Object} add put a figure's root in the scene; returns its dither anchor (pass as part.anchor)
   * @property {function(THREE.Object3D): void} remove take a figure's root out of the scene and drop its dither anchor
   * @property {function(string, Object=): Object} use switch to a preset, with optional knob overrides; returns the settings
   * @property {function(string, *): Object} set change one knob; returns the settings
   * @property {function(): Object} settings the settings in force (after any degrade)
   * @property {function(THREE.Camera, {clearColor?: number}=): void} render draw one frame onto the current target
   * @property {function(): boolean} degrade drop to the cheaper variant of the current look; false when there is none
   * @property {function(): Object} stats `{ path, scale, targets }` of the last frame
   * @property {function(): {width: number, height: number, data: Uint8Array}|null} readTexels the indexed path's resolved
   *   texels (bottom row first), or null on the direct path
   * @property {function(): void} dispose
   */

  /**
   * Creates a view.
   * @param {{renderer: THREE.WebGLRenderer, preset?: string, atlasRows?: number}} options
   * @returns {LookView}
   * @complexity render: O(figures + meshes) on the CPU (snapping and the depth fit) plus one scene draw on the
   *   direct path, or one scene draw and two full-target passes on the indexed path
   * @example
   * const view = Kit.look.view({ renderer: ctx.renderer, preset: 'pixel' });
   * const rows = view.atlas.load(Kit.palette.SETS.ember).rows;
   * const anchor = view.add(figureRoot);
   * view.shading.dress(headMesh, { ramp: rows.skin, anchor });
   * return { render: () => view.render(camera, { clearColor: 0x2a3050 }) };   // from a game's create()
   */
  const view = ({ renderer, preset = 'toon', atlasRows }) => {
    let chosen = Kit.look.settings(preset);
    let isReduced = false;
    const atlas = Kit.palette.atlas({ rows: atlasRows, toneCount: chosen.toneCount });
    const shading = Kit.look.shading({ atlas });
    const ink = Kit.look.inkPass(shading);
    const scene = new THREE.Scene();
    let lastStats = { path: 'direct', scale: 1, targets: [] };

    // Scratch objects, so a frame allocates nothing.
    const bufferSize = new THREE.Vector2();
    const bounds = new THREE.Box3();
    const sphere = new THREE.Sphere();
    const point = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const savedClearColor = new THREE.Color();

    /** The settings actually drawn: on a slow device, native-resolution ink falls back to hulls and soft edges to hard ones. */
    const effective = () => {
      if (!isReduced) return chosen;
      const outline = chosen.outline === 'ink' && !chosen.pixelRows ? 'hull' : chosen.outline;
      return Kit.look.settings(chosen.preset, { ...chosen, outline, softness: 0 });
    };

    /** View-space depths [near, far] that bracket everything in the scene, for the index target's depth byte. */
    const fitDepthRange = (camera) => {
      bounds.setFromObject(scene);
      if (bounds.isEmpty()) return [camera.near, camera.far];
      bounds.getBoundingSphere(sphere);
      const centerDepth = -point.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse).z;
      const reach = sphere.radius * (1 + DEPTH_MARGIN);
      return [centerDepth - reach, centerDepth + reach];
    };

    /**
     * Moves each figure onto the texel grid for this frame and sets its dither anchor; returns the undo.
     * A figure's place is measured along the camera's right and up axes; rounding both to whole texels makes
     * the figure cross the screen in texel steps, so its outline is the same set of texels every frame.
     * Only an orthographic camera has one texel size for the whole scene, so snapping is skipped otherwise.
     */
    const placeFigures = (camera, settings, target) => {
      const texelWorld = camera.isOrthographicCamera ? ((camera.top - camera.bottom) / camera.zoom) * (target.scale / target.bufferHeight) : 0;
      const shouldSnap = settings.snap && settings.isIndexed && texelWorld > 0;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      const moved = shading.anchors.map((anchor) => {
        const { root } = anchor;
        root.getWorldPosition(point).sub(camera.position);
        const [across, along] = [point.dot(right), point.dot(up)];
        const shiftAcross = shouldSnap ? Kit.look.snapToTexel(across, texelWorld) - across : 0;
        const shiftAlong = shouldSnap ? Kit.look.snapToTexel(along, texelWorld) - along : 0;
        root.position.addScaledVector(right, shiftAcross).addScaledVector(up, shiftAlong);
        if (settings.ditherSpace !== 'anchored') anchor.value.set(0, 0);
        // On the grid the anchor is the figure's whole-texel coordinate; off it, the nearest pixel of its projection.
        else if (shouldSnap) anchor.value.set(Math.round((across + shiftAcross) / texelWorld), Math.round((along + shiftAlong) / texelWorld));
        else {
          root.getWorldPosition(point).project(camera);
          anchor.value.set(Math.round((point.x * 0.5 + 0.5) * target.width), Math.round((point.y * 0.5 + 0.5) * target.height));
        }
        return () => root.position.addScaledVector(right, -shiftAcross).addScaledVector(up, -shiftAlong);
      });
      return () => moved.forEach((undo) => undo());
    };

    return {
      scene,
      /** Whether the renderer is WebGL2 (a sculpted crowd needs it: a bone texture indexed by instance). */
      isWebGL2: Boolean(renderer.capabilities && renderer.capabilities.isWebGL2),
      atlas,
      shading,
      add(root) {
        scene.add(root);
        return shading.follow(root);
      },
      remove(root) {
        scene.remove(root);
        // Anchors are snapped every frame; a figure that has left must not be moved or counted any more.
        const index = shading.anchors.findIndex((anchor) => anchor.root === root);
        if (index >= 0) shading.anchors.splice(index, 1);
      },
      use(presetId, overrides) {
        chosen = Kit.look.settings(presetId, overrides);
        return effective();
      },
      set(knobId, value) {
        chosen = Kit.look.settings(chosen.preset, { ...chosen, [knobId]: value });
        return effective();
      },
      settings: effective,
      render(camera, options = {}) {
        const settings = effective();
        if (atlas.toneCount !== settings.toneCount) atlas.retone(settings.toneCount);
        renderer.getDrawingBufferSize(bufferSize);
        const pixelRatio = renderer.getPixelRatio();
        const scale = settings.isIndexed ? Kit.look.texelScale(bufferSize.y, settings.pixelRows) : 1;
        const target = { width: Math.ceil(bufferSize.x / scale), height: Math.ceil(bufferSize.y / scale), scale, bufferHeight: bufferSize.y };
        camera.updateMatrixWorld();
        // Below native resolution a hull line is one texel; at native resolution it is the knob's width in device pixels.
        const lineWidth = scale > 1 ? 1 : settings.inkWidth * pixelRatio;
        shading.apply(settings, { width: target.width, height: target.height, lineWidth, depthRange: fitDepthRange(camera) });
        // Stamps (the layers of a face) keep a least size in target texels; only an orthographic camera has one texel size.
        shading.uniforms.uTexelWorld.value = camera.isOrthographicCamera ? ((camera.top - camera.bottom) / camera.zoom) * (scale / bufferSize.y) : 0;
        // Dither pays only while a figure is large enough to hold the pattern; below native resolution it fades with the texel.
        if (scale > 1) shading.uniforms.uDither.value = Kit.look.ditherAt(settings.dither, shading.uniforms.uTexelWorld.value);
        const restoreFigures = placeFigures(camera, settings, target);
        scene.updateMatrixWorld();

        renderer.getClearColor(savedClearColor);
        const savedClearAlpha = renderer.getClearAlpha();
        const hadAutoClear = renderer.autoClear;
        if (options.clearColor !== undefined) {
          renderer.setClearColor(options.clearColor, 1);
          renderer.clear();
        }
        if (settings.isIndexed) {
          ink.resize(bufferSize.x, bufferSize.y, scale);
          // The small target is rounded up to whole texels, so it covers a little more than the screen (to the
          // right and above). The camera must see exactly that area, or texels would be a hair wider than tall
          // and a snapped figure would still drift against the grid.
          const isViewFree = !camera.view || !camera.view.enabled;
          if (isViewFree) camera.setViewOffset(bufferSize.x, bufferSize.y, 0, bufferSize.y - target.height * scale, target.width * scale, target.height * scale);
          ink.draw(renderer, scene, camera, settings);
          if (isViewFree) camera.clearViewOffset();
          lastStats = { path: 'indexed', scale, targets: [`index ${target.width}x${target.height} RGBA8 + depth`, `colour ${target.width}x${target.height} RGBA8`] };
        } else {
          // Figures are drawn over whatever is already on the target, with a fresh depth buffer of their own.
          renderer.autoClear = false;
          renderer.clearDepth();
          renderer.render(scene, camera);
          lastStats = { path: 'direct', scale: 1, targets: [] };
        }
        renderer.autoClear = hadAutoClear;
        renderer.setClearColor(savedClearColor, savedClearAlpha);
        restoreFigures();
      },
      degrade() {
        const before = JSON.stringify(effective());
        isReduced = true;
        return JSON.stringify(effective()) !== before;
      },
      stats: () => lastStats,
      readTexels: () => (lastStats.path === 'indexed' ? { ...ink.size(), data: ink.readTexels(renderer) } : null),
      dispose() {
        ink.dispose();
        shading.dispose();
      },
    };
  };

  Kit.look.view = view;
})();
