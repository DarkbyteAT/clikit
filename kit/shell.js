/**
 * Kit shell: the renderer, the frame loop, the game lifecycle and the menu. Loaded last, after
 * every kit file and every game.
 *
 * Owns:  the one WebGL renderer and its size, building the `ctx` each game receives, launching,
 *        restarting and disposing games, the frame loop (game time, pause, hitstop, slow motion),
 *        crash recovery back to the menu, the quality governor, the idle backdrop behind the
 *        menu, the menu cards and the top-bar buttons (back, restart, mute).
 * Does not own: anything a game does with its ctx; the pieces of the ctx themselves (input.js,
 *        fx.js, ui.js, make.js, post.js, theme.js, core.js); page markup and styles (index.html).
 *
 * Public surface: `Kit.play(id)`, `Kit.menu()`, `Kit.current` (the live ctx, for tests and
 * tools), `Kit.lastCrash` and `Kit.post_` (test hook).
 * Needs the DOM and WebGL, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  // ---- tunables ------------------------------------------------------------------------------------------------------

  /** Device pixel ratios above this cost fill rate that phones cannot spare, for no visible gain. */
  const MAX_PIXEL_RATIO = 2;
  const CAMERA_FOV_DEGREES = 55;
  const CAMERA_NEAR = 0.1;
  const CAMERA_FAR = 400;
  /** Visible world units of ctx.ortho() when no span is given. */
  const DEFAULT_ORTHO_SPAN = 20;
  /** Longest frame the game is ever told about, seconds: after a stall it slows down instead of leaping ahead. */
  const MAX_FRAME_SECONDS = 0.05;
  const MS_PER_SECOND = 1000;
  /** How long the "game hit an error" notice stays up, milliseconds. */
  const CRASH_NOTICE_MS = 5000;
  /** Accent colour of a menu card whose game gives none. */
  const DEFAULT_CARD_COLOR = '#6ea8ff';

  // Quality governor (see `governQuality`).
  /** The frame time the governor assumes after each change, seconds. */
  const TARGET_FRAME_SECONDS = 1 / 60;
  /** Average frame time above which the device is judged too slow (below about 40 fps), seconds. */
  const SLOW_FRAME_SECONDS = 1 / 40;
  /** Weight of each new frame in the running average: low, so one hitch does not trigger a downgrade. */
  const FRAME_AVERAGE_WEIGHT = 0.05;
  /** Frames to watch after start-up and after each downgrade before judging again (2.5 s at 60 fps). */
  const GOVERNOR_SETTLE_FRAMES = 150;
  /** Pixel ratio of the first downgrade; the last downgrade goes to 1. */
  const REDUCED_PIXEL_RATIO = 1.5;

  /** The idle backdrop behind the menu: slowly tumbling shapes in the menu's accent colours. */
  const ATTRACT = {
    stage: { sky: [0x1a2452, 0x070a18], fog: [10, 38], sun: [4, 10, 6], ambient: 0.6 },
    colors: [0xff5d73, 0xffc145, 0x4de2c5, 0x6ea8ff, 0xc084fc],
    shapeCount: 26,
    /** Every Nth shape is a glowing gem; the rest are boxes. */
    gemEvery: 3,
    gemRadius: [0.4, 1],
    gemGlow: 0.25,
    boxSize: 0.8,
    boxRoughness: 0.35,
    /** Where shapes are scattered, as [min, max] per axis, in front of the camera. */
    spreadX: [-9, 9],
    spreadY: [-8, 9],
    spreadZ: [-22, -3],
    /** Tumble speed per shape, radians / s; it also sets how fast the shape bobs. */
    spinRate: [0.2, 0.9],
    /** The second tumble axis turns slower, so the motion does not look like a flat roll. */
    secondAxisRatio: 0.7,
    bobSpeed: 0.3,
    cameraDistance: 8,
    cameraSwayRate: 0.15,
    cameraSwayReach: 1.5,
    lookAtDepth: -10,
  };

  // ---- page elements and renderer ------------------------------------------------------------------------------------

  const query = (selector) => document.querySelector(selector);
  const { h } = Kit.ui;
  const canvas = query('#stage');
  const menu = query('#menu');
  const hud = query('#hud');
  const cards = query('#cards');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (error) {
    cards.textContent = 'This device could not start 3D graphics (WebGL).';
    return;
  }
  let pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const post = Kit.post(renderer);

  /**
   * @typedef {Object} ViewSize
   * The stage size, shared (as one live object) with every game through `ctx.size`.
   * @property {number} w width, CSS pixels
   * @property {number} h height, CSS pixels
   * @property {number} aspect w / h
   * @property {boolean} portrait is it at least as tall as it is wide?
   */
  /** @type {ViewSize} */
  const size = { w: 1, h: 1, aspect: 1, portrait: true };

  /**
   * The running game: `{ def, ctx, clock, bus, game }`, or null before the first launch. `game` is
   * what the definition's create() returned (null until it has).
   */
  let current = null;

  // ---- sizing --------------------------------------------------------------------------------------------------------

  /** Half-height, in world units, of what an orthographic camera shows, from its span and fit axis. */
  const orthoHalfHeight = (camera) => {
    const { span, fit } = camera.userData;
    const visibleSpan = typeof span === 'function' ? span(size) : span;
    // A span measured along the width is converted to the height it implies at this aspect ratio.
    return (fit === 'width' ? visibleSpan / size.aspect : visibleSpan) / 2;
  };

  /** Fits a camera's projection to the current stage size. */
  function fitCamera(camera) {
    if (camera.isOrthographicCamera) {
      const halfHeight = orthoHalfHeight(camera);
      const halfWidth = halfHeight * size.aspect;
      Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
    } else {
      camera.aspect = size.aspect;
    }
    camera.updateProjectionMatrix();
  }

  /** Re-reads the window size and brings the renderer, the post chain and the running game's camera in line. */
  function resize() {
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    size.aspect = size.w / size.h;
    size.portrait = size.h >= size.w;
    renderer.setPixelRatio(pixelRatio);
    // `false`: do not touch the canvas's CSS size; the stylesheet keeps it full-bleed.
    renderer.setSize(size.w, size.h, false);
    post.setSize(size.w, size.h, pixelRatio);
    if (!current) return;
    fitCamera(current.ctx.camera);
    current.bus.emit('resize', size);
  }
  window.addEventListener('resize', resize);

  // ---- lifecycle -----------------------------------------------------------------------------------------------------

  /** Frees the GPU memory of one scene object: its geometry, its material(s) and their colour textures. */
  const disposeObject = (object) => {
    if (object.geometry) object.geometry.dispose();
    // `material` may be one material, a list, or missing; concat normalises all three to a list.
    [].concat(object.material || []).forEach((material) => {
      if (material.map) material.map.dispose();
      material.dispose();
    });
  };

  /** Ends the running game: its own dispose hook, then everything the shell gave it. */
  function stop() {
    if (!current) return;
    const { ctx, game } = current;
    // Cleared first, so nothing a dispose hook triggers can reach a half-dismantled game.
    current = null;
    try {
      if (game && game.dispose) game.dispose();
    } catch (error) {
      // A broken dispose hook must not stop the rest of the clean-up.
      console.error(error);
    }
    ctx.input.dispose();
    ctx.ui.dispose();
    ctx.fx.dispose();
    ctx.scene.traverse(disposeObject);
    if (ctx.scene.background && ctx.scene.background.dispose) ctx.scene.background.dispose();
    renderer.renderLists.dispose();
  }

  /**
   * Builds the context handed to a game's create(). Timers and tweens come from the game's own
   * clock, so they stop with the game and follow pause, hitstop and slow motion.
   * @param {Object} def the game definition
   * @param {ReturnType<typeof Kit.clock>} clock
   * @param {ReturnType<typeof Kit.bus>} bus carries 'resize' (and any events the game emits itself)
   * @returns {Object} ctx: THREE, def, scene, camera, renderer, size, math, fmt, fmtTime, sfx, post, time, paused,
   *   timeScale, on, emit, after, every, tween, pool, restart, exit, ortho, distanceForWidth, save, input, fx, theme, ui, make
   */
  function createContext(def, clock, bus) {
    const ctx = {
      THREE,
      def,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, size.aspect, CAMERA_NEAR, CAMERA_FAR),
      renderer,
      size,
      math: Kit.math,
      fmt: Kit.fmt,
      fmtTime: Kit.fmtTime,
      sfx: Kit.sfx,
      post,
      /** Game seconds since launch (stops while paused or frozen, stretches in slow motion). */
      time: 0,
      paused: false,
      /** Game speed multiplier; fx.slowmo drives it. */
      timeScale: 1,
      on: bus.on,
      emit: bus.emit,
      after: clock.after,
      every: clock.every,
      tween: clock.tween,
      pool: Kit.pool,
      restart: () => launch(def),
      exit: showMenu,
    };

    /**
     * 2D / 2.5D: swaps ctx.camera for an orthographic one that the shell keeps fitted on resize.
     * Position and rotate it as usual; zoom with camera.zoom + updateProjectionMatrix().
     * @param {number | function(ViewSize): number} [span=20] visible world units along `fit`, or a function of
     *   the stage size so it can react to rotation
     * @param {'height'|'width'} [fit='height'] which screen axis the span is measured along
     * @returns {THREE.OrthographicCamera} the new ctx.camera
     * @example ctx.ortho((viewSize) => (viewSize.portrait ? 15 : 26), 'width');
     */
    ctx.ortho = (span = DEFAULT_ORTHO_SPAN, fit = 'height') => {
      // The frustum is a placeholder; fitCamera sets the real one from span and fit.
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
      camera.userData = { span, fit };
      fitCamera(camera);
      ctx.camera = camera;
      return camera;
    };

    /**
     * Distance at which a perspective camera sees `width` world units across the screen, for
     * portrait-safe framing.
     * @param {number} width world units that must fit across
     * @param {number} [fov=ctx.camera.fov] vertical field of view, degrees
     * @returns {number} world units
     */
    ctx.distanceForWidth = (width, fov = ctx.camera.fov) => {
      const halfFovRadians = (fov * Math.PI) / 360;
      // tan(half fov) is half the visible height per unit of distance; times aspect gives half the width.
      return width / 2 / (Math.tan(halfFovRadians) * size.aspect);
    };

    ctx.save = Kit.store(def.id);
    ctx.input = Kit.input(ctx);
    ctx.fx = Kit.fx(ctx);
    // The game's theme must be in place before the HUD is built: components read ctx.theme for overrides.
    ctx.theme = def === attract ? Kit.theme.resolve() : Kit.theme.apply(def.id, def.theme);
    ctx.ui = Kit.ui(ctx);
    ctx.make = Kit.make(ctx);
    return ctx;
  }

  /** Stops whatever is running and starts a game from its definition. A create() that throws returns to the menu. */
  function launch(def) {
    stop();
    const clock = Kit.clock();
    const bus = Kit.bus();
    const ctx = createContext(def, clock, bus);
    post.reset();
    current = { def, ctx, clock, bus, game: null };
    // create() may itself restart or exit, replacing `current`; the result belongs to this launch.
    const launched = current;
    try {
      launched.game = def.create(ctx) || {};
    } catch (error) {
      console.error(`[${def.id}] create failed`, error);
      if (def !== attract) crash(def, error);
    }
  }

  /** Records a game's error (Kit.lastCrash, read by tools/smoke.js), returns to the menu and shows a notice. */
  function crash(def, error) {
    Kit.lastCrash = `${def.id}: ${error.stack || error.message}`;
    showMenu();
    const notice = query('#crash');
    notice.textContent = `${def.name} hit an error: ${error.message}`;
    notice.hidden = false;
    setTimeout(() => (notice.hidden = true), CRASH_NOTICE_MS);
  }

  // ---- quality governor ----------------------------------------------------------------------------------------------

  let averageFrameSeconds = TARGET_FRAME_SECONDS;
  let framesSinceChange = 0;
  /** Downgrades still available, cheapest loss first: some resolution, then bloom, then the rest of the resolution. */
  const qualitySteps = [
    () => (pixelRatio = Math.min(pixelRatio, REDUCED_PIXEL_RATIO)),
    () => post.disable(),
    () => (pixelRatio = 1),
  ];

  /**
   * Keeps slow devices playable. It tracks a smoothed frame time and, when the device cannot hold
   * about 40 fps, takes the next downgrade, then waits a settle period before judging again so
   * each step is measured on its own. Downgrades are never undone: oscillating quality looks worse
   * than a steady lower setting. `window.KIT_LOCK_QUALITY` (set by the smoke test, whose software
   * renderer is always slow) switches it off.
   * @param {number} frameSeconds this frame's real duration
   */
  function governQuality(frameSeconds) {
    // Exponential moving average: each frame nudges the estimate a little toward its own time.
    averageFrameSeconds += (frameSeconds - averageFrameSeconds) * FRAME_AVERAGE_WEIGHT;
    framesSinceChange += 1;
    const isSettling = framesSinceChange < GOVERNOR_SETTLE_FRAMES;
    const isFastEnough = averageFrameSeconds < SLOW_FRAME_SECONDS;
    if (isSettling || isFastEnough || !qualitySteps.length || window.KIT_LOCK_QUALITY) return;
    qualitySteps.shift()();
    framesSinceChange = 0;
    averageFrameSeconds = TARGET_FRAME_SECONDS;
    resize();
  }

  // ---- frame loop ----------------------------------------------------------------------------------------------------

  /**
   * Advances the running game by one frame of game time.
   * @param {Object} running the `current` record this frame started with
   * @param {number} frameSeconds real seconds since the last frame
   * @returns {boolean} false when the game crashed (the menu is already showing)
   */
  function advanceGame(running, frameSeconds) {
    const { ctx, clock, game, def } = running;
    if (ctx._freeze > 0) {
      // Hitstop (fx.hitstop): real time burns the freeze down while game time stands still.
      ctx._freeze -= frameSeconds;
      return true;
    }
    const dt = frameSeconds * ctx.timeScale;
    ctx.time += dt;
    try {
      clock.update(dt);
      // A timer may have restarted or exited the game; only update the game this frame began with.
      const isStillRunning = current && current.game === game;
      if (isStillRunning && game && game.update) game.update(dt, ctx.time);
    } catch (error) {
      console.error(`[${def.id}] update failed`, error);
      if (def !== attract) {
        crash(def, error);
        return false;
      }
    }
    return true;
  }

  let lastFrameTime = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    const frameSeconds = Math.min(MAX_FRAME_SECONDS, (now - lastFrameTime) / MS_PER_SECOND);
    lastFrameTime = now;
    if (!current) return;
    const running = current;
    const { ctx } = running;
    if (!ctx.paused) {
      if (!advanceGame(running, frameSeconds)) return;
      // The game restarted or exited during its update: this ctx is disposed, so do not draw it.
      if (!current || current.ctx !== ctx) return;
      // Effects run on real time, so they keep playing through hitstop and slow motion.
      ctx.fx.update(frameSeconds);
    }
    // Shake is applied only for the render and removed straight after, so it never drifts the game's camera.
    ctx.fx.applyShake();
    post.render(ctx.scene, ctx.camera);
    ctx.fx.undoShake();
    governQuality(frameSeconds);
  }

  // ---- attract mode: the idle backdrop behind the menu, run as an ordinary (unlisted) game ---------------------------

  const attract = {
    id: '_attract',
    name: 'Attract',
    create(ctx) {
      const { make, camera, math } = ctx;
      make.stage(ATTRACT.stage);
      const shapes = Array.from({ length: ATTRACT.shapeCount }, (_, index) => {
        const hex = ATTRACT.colors[index % ATTRACT.colors.length];
        const isGem = index % ATTRACT.gemEvery === 0;
        const shape = isGem
          ? make.ico(math.rand(...ATTRACT.gemRadius), 0, hex, { emissive: hex, emissiveIntensity: ATTRACT.gemGlow })
          : make.box(ATTRACT.boxSize, ATTRACT.boxSize, ATTRACT.boxSize, hex, { rough: ATTRACT.boxRoughness });
        shape.position.set(math.rand(...ATTRACT.spreadX), math.rand(...ATTRACT.spreadY), math.rand(...ATTRACT.spreadZ));
        shape.userData.spinRate = math.rand(...ATTRACT.spinRate);
        return shape;
      });
      camera.position.set(0, 0, ATTRACT.cameraDistance);
      return {
        update(dt, t) {
          shapes.forEach((shape) => {
            const { spinRate } = shape.userData;
            shape.rotation.x += dt * spinRate;
            shape.rotation.y += dt * spinRate * ATTRACT.secondAxisRatio;
            // The bob's phase comes from the shape's x, so neighbours do not rise and fall together.
            shape.position.y += Math.sin(t * spinRate + shape.position.x) * dt * ATTRACT.bobSpeed;
          });
          camera.position.x = Math.sin(t * ATTRACT.cameraSwayRate) * ATTRACT.cameraSwayReach;
          camera.lookAt(0, 0, ATTRACT.lookAtDepth);
        },
      };
    },
  };

  // ---- menu and top bar ----------------------------------------------------------------------------------------------

  /** Leaves any game and shows the menu over the attract backdrop. */
  function showMenu() {
    Kit.theme.clear(); // the menu always wears the default look
    hud.hidden = true;
    menu.hidden = false;
    launch(attract);
  }

  /** Hides the menu and starts a game. */
  function play(def) {
    menu.hidden = true;
    hud.hidden = false;
    query('#game-name').textContent = def.name;
    launch(def);
  }

  /**
   * Starts a registered game by id.
   * @param {string} id
   * @returns {boolean} false when no game has that id
   */
  Kit.play = (id) => {
    const def = Kit.games.find((game) => game.id === id);
    if (def) play(def);
    return Boolean(def);
  };
  /** Returns to the menu. */
  Kit.menu = showMenu;
  /** Test hook: tools/smoke.js switches bloom off while playing and on for screenshots. */
  Kit.post_ = post;
  /** The live ctx of whatever is running (a game or the attract backdrop), for tests and tools. */
  Object.defineProperty(Kit, 'current', { get: () => current && current.ctx });
  /** What the running game's create() returned (its `update`, `dispose`, `debugState`), for kit/dev.js; null before it exists. */
  Object.defineProperty(Kit, 'currentGame', { get: () => current && current.game });

  /** Builds one menu card: its number, name, tagline and (when given) progression hook. */
  const menuCard = (def, index) => {
    const card = h('button', 'card');
    card.type = 'button';
    card.id = 'card-' + def.id;
    // The stylesheet reads --c for the card's accent colour.
    card.style.setProperty('--c', def.color || DEFAULT_CARD_COLOR);
    const body = h('div');
    body.append(h('b', null, def.name), h('span', null, def.tagline || ''));
    if (def.hook) body.append(h('em', null, def.hook));
    card.append(h('i', null, index + 1), body);
    card.addEventListener('click', () => {
      Kit.sfx.play('tap');
      play(def);
    });
    return card;
  };

  Kit.games.sort((gameA, gameB) => (gameA.order || 0) - (gameB.order || 0));
  cards.append(...Kit.games.map(menuCard));
  if (!Kit.games.length) cards.textContent = 'No games registered.';

  /** Wires a top-bar button: the standard click sound, then its action. */
  const onPress = (selector, action) =>
    query(selector).addEventListener('click', () => {
      Kit.sfx.play('click');
      action();
    });
  onPress('#back', showMenu);
  onPress('#restart', () => {
    if (current) launch(current.def);
  });

  const muteButton = query('#mute');
  const paintMuteButton = () => (muteButton.textContent = Kit.sfx.muted ? 'Sound off' : 'Sound on');
  // No click sound here: the button's whole point may be that sound is unwanted.
  muteButton.addEventListener('click', () => {
    Kit.sfx.setMuted(!Kit.sfx.muted);
    paintMuteButton();
  });
  paintMuteButton();

  resize();
  showMenu();
  requestAnimationFrame(frame);
})();
