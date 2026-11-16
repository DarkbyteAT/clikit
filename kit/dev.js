/**
 * Kit dev: what a developer sees that a player never does.
 *
 * Owns:  `Kit.debug.state()` (one plain snapshot of the running game for tools and the overlay),
 *        `Kit.debug.probe()` (frame-time percentiles and render cost), the development-time checks on HUD and
 *        helper calls (wrong argument type, a fourth stat, a HUD element pushed off-screen, a raw THREE.Color),
 *        and the developer overlay `Kit.dev` (frame time, live state, skin switcher, time scale, last error).
 * Does not own: registration checks (Kit.checkGame in core.js), Kit.warn / Kit.expectType themselves (core.js),
 *        or the command-line tools that read all this (tools/dev.js, tools/smoke.js).
 *
 * Cost: in a published page nothing here is installed except the two small `Kit.debug` readers and `Kit.dev`;
 * the checks wrap kit factories only when Kit.isDevelopment() is true, and the overlay builds its DOM and starts
 * its timers only while it is open. Loaded after the other kit modules and before the games and the shell.
 */
(() => {
  // ---- tunables --------------------------------------------------------------------------------------------------------

  /** Stats that fit the top row of a 390 px phone (tools/BRIEF.txt: "keep at most 3 stats"). */
  const MAX_STATS = 3;
  /** Real milliseconds after a game starts before its HUD is measured: fonts and the first layout have settled by then. */
  const HUD_CHECK_DELAY_MS = 1200;
  /** A HUD element may overhang the viewport by this many pixels (sub-pixel rounding, borders) before it is reported. */
  const OVERHANG_TOLERANCE_PX = 2;
  /** The overlay re-reads the game this often while open (real milliseconds). */
  const OVERLAY_REFRESH_MS = 250;
  /** Characters of debug state shown in the overlay before it is cut off. */
  const OVERLAY_STATE_LENGTH = 1400;
  /** Frames the overlay's frame-time meter remembers (about two seconds at 60 fps). */
  const METER_WINDOW_FRAMES = 120;
  const TIME_SCALES = [0.25, 0.5, 1, 2, 4];
  /** Menu entry of the skin switcher that puts the game's own theme back. */
  const OWN_THEME = "game's own";
  const OVERLAY_KEY = '`';
  const OVERLAY_TOUCHES = 3;
  const MS_PER_SECOND = 1000;
  /** Percentiles reported by the frame probe: the typical frame, the bad frame and the worst frame worth chasing. */
  const PROBE_PERCENTILES = [50, 95, 99];
  const DEFAULT_PROBE_SECONDS = 2;
  /** Frame times are reported to a tenth of a millisecond. */
  const TENTHS = 10;

  /**
   * Argument checks installed on kit helpers in development: helper name -> one row per checked argument,
   * `[position, name, accepted types, example]`. Adding a check means adding a row.
   */
  const ARGUMENT_RULES = {
    ui: {
      stat: [[0, 'label', 'string', "ui.stat('Coins', 0)"]],
      pips: [[0, 'label', 'string', "ui.pips('Lives', { total: 3 })"]],
      progress: [[0, 'label', 'string|undefined', "ui.progress('XP', '#7cf')"]],
      actions: [[0, 'list', 'array', "ui.actions([{ id: 'boom', label: 'Boom', onClick }])"]],
      choose: [[0, 'options', 'object', "ui.choose({ title: 'Level up', options: [{ title: 'Bigger' }] })"]],
      banner: [[0, 'options', 'object', "ui.banner({ title: 'Run over', stats: [['Score', 12]] })"]],
      hint: [[0, 'text', 'string', "ui.hint('Drag to move')"]],
      toast: [[0, 'text', 'string|number', "ui.toast('Wave 3')"]],
      panel: [[0, 'options', 'object', "ui.panel({ title: 'Bag', build(body, close) { ... } })"]],
    },
    make: {
      box: [[0, 'width', 'number', 'make.box(1, 1, 1, 0xffc145)'], [1, 'height', 'number', 'make.box(1, 1, 1, 0xffc145)'], [2, 'depth', 'number', 'make.box(1, 1, 1, 0xffc145)']],
      sphere: [[0, 'radius', 'number', 'make.sphere(0.5, 0xffc145)']],
    },
    clock: {
      after: [[0, 'seconds', 'number', 'ctx.after(2, spawnBoss)'], [1, 'callback', 'function', 'ctx.after(2, spawnBoss)']],
      every: [[0, 'seconds', 'number', 'ctx.every(0.5, spawnGrunt)'], [1, 'callback', 'function', 'ctx.every(0.5, spawnGrunt)']],
      tween: [[0, 'target', 'object', "ctx.tween(mesh.scale, { x: 1.4 }, 0.12, 'outBack')"], [1, 'to', 'object', "ctx.tween(mesh.scale, { x: 1.4 }, 0.12, 'outBack')"]],
    },
  };

  // ---- debug state -----------------------------------------------------------------------------------------------------

  /** Reads one box of the stats row as [label, value]: a number where the text is one, a pip count for pip rows. */
  const readStat = (box) => {
    const labelElement = box.querySelector('span');
    const label = (labelElement ? labelElement.textContent : box.dataset.pips || '').trim();
    if (box.querySelector('.pip-row')) return [label, box.querySelectorAll('.pip.on').length];
    const text = (box.querySelector('b') || box).textContent.trim();
    const plain = text.replace(/,/g, '');
    return [label, plain !== '' && Number.isFinite(Number(plain)) ? Number(plain) : text];
  };

  /** The title of the open modal or component dialog (`ui.dialog`), 'open' when it has none, or null when neither is open. */
  const readModalTitle = () => {
    const modal = document.querySelector('#modal:not([hidden])') || document.querySelector('dialog.ui-dialog[open]');
    if (!modal) return null;
    const title = modal.querySelector('h2');
    return title ? title.textContent : 'open';
  };

  /** What the game says about itself: `debugState()` on the object create() returned (or the older ctx.debug.state()). */
  const readGameState = (ctx, game) => {
    try {
      if (game && typeof game.debugState === 'function') return game.debugState();
      if (ctx.debug && typeof ctx.debug.state === 'function') return ctx.debug.state();
      return null;
    } catch (error) {
      return { error: `debugState() threw: ${error.message}` };
    }
  };

  /**
   * @typedef {Object} DebugState
   * @property {?string} id the running game's id ('_attract' on the menu), or null before the shell starts
   * @property {number} time game seconds since the game started
   * @property {boolean} paused
   * @property {number} timeScale
   * @property {?string} modal title of the open modal or `ui.dialog` sheet, or null
   * @property {Object<string, (number|string)>} hud the stats row as label -> value
   * @property {string[]} actions labels of the enabled bottom-bar buttons
   * @property {?Object} state what the game's own `debugState()` returned, or null when it has none
   * @property {?string} crash the last crash message (Kit.lastCrash), or null
   */

  /**
   * One snapshot of the running game, for the developer overlay and for `node tools/dev.js play` predicates.
   * A game adds its own facts by returning `debugState()` from create(), next to `update`.
   * @returns {DebugState}
   * @example
   * return { update(dt, t) { ... }, debugState: () => ({ phase: flow.state, score, lives }) };
   * Kit.debug.state().state.score // from the console, the overlay or a play script ("assert state.score > 3")
   */
  const readDebugState = () => {
    const ctx = Kit.current;
    if (!ctx) return { id: null, time: 0, paused: false, timeScale: 1, modal: null, hud: {}, actions: [], state: null, crash: Kit.lastCrash || null };
    return {
      id: ctx.def ? ctx.def.id : null,
      time: ctx.time,
      paused: Boolean(ctx.paused),
      timeScale: ctx.timeScale,
      modal: readModalTitle(),
      hud: Object.fromEntries([...document.querySelectorAll('#stats > *')].map(readStat)),
      actions: [...document.querySelectorAll('#actions button:not([disabled]):not([hidden])')].map((button) => (button.querySelector('b') || button).textContent.trim()),
      state: readGameState(ctx, Kit.currentGame),
      crash: Kit.lastCrash || null,
    };
  };

  // ---- frame probe -----------------------------------------------------------------------------------------------------

  /** The value at a percentile of an ascending list (nearest rank). */
  const percentileOf = (sorted, percentile) => sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))];

  /** Counts the visible meshes in a scene: each is at least one draw call unless it is instanced or batched. */
  const countLiveMeshes = (scene) => {
    let count = 0;
    scene.traverseVisible((object) => {
      if (object.isMesh || object.isPoints || object.isLine || object.isSprite) count += 1;
    });
    return count;
  };

  /**
   * @typedef {Object} FrameProbe
   * @property {number} frames frames measured
   * @property {number[]} frameMs frame time at the 50th, 95th and 99th percentile, milliseconds
   * @property {number} calls most draw calls in one frame
   * @property {number} triangles most triangles in one frame
   * @property {number} meshes visible meshes, points, lines and sprites in the scene at the end
   */

  /**
   * Measures the running game for a while: frame-time percentiles and what the renderer drew per frame.
   * Frame times under software GL (the headless tests) say nothing about a phone; draw calls, triangles and
   * mesh counts are the same on every machine and are what the budgets check.
   * @param {number} [seconds=2] real seconds to measure
   * @returns {Promise<FrameProbe>}
   * @complexity O(frames) time and space while measuring; O(scene objects) once at the end
   * @example Kit.debug.probe(3).then((probe) => console.table(probe));
   */
  const probeFrames = (seconds = DEFAULT_PROBE_SECONDS) =>
    new Promise((resolve) => {
      const { renderer, scene } = Kit.current;
      const frameTimes = [];
      let mostCalls = 0;
      let mostTriangles = 0;
      // The renderer normally zeroes its counters at every render call, and a post-processing chain renders
      // several times a frame; take over the reset so one reading covers one whole frame.
      const hadAutoReset = renderer.info.autoReset;
      renderer.info.autoReset = false;
      renderer.info.reset();
      const startedAt = performance.now();
      let previous = startedAt;
      const measure = (now) => {
        frameTimes.push(now - previous);
        previous = now;
        mostCalls = Math.max(mostCalls, renderer.info.render.calls);
        mostTriangles = Math.max(mostTriangles, renderer.info.render.triangles);
        renderer.info.reset();
        if (now - startedAt < seconds * MS_PER_SECOND) return requestAnimationFrame(measure);
        renderer.info.autoReset = hadAutoReset;
        const sorted = frameTimes.slice().sort((first, second) => first - second);
        const frameMs = PROBE_PERCENTILES.map((percentile) => Math.round(percentileOf(sorted, percentile) * TENTHS) / TENTHS);
        return resolve({ frames: frameTimes.length, frameMs, calls: mostCalls, triangles: mostTriangles, meshes: countLiveMeshes(Kit.current ? Kit.current.scene : scene) });
      };
      requestAnimationFrame(measure);
    });

  /**
   * The running game's playtest handles: the `tools` object it returned from create(), or an empty object.
   * State belongs in `debugState()`; this is for actions and measurements a script needs to call.
   * @returns {Object<string, *>}
   * @example node tools/dev.js play penalty "log Kit.debug.tools().measure(300)"
   */
  const readTools = () => (Kit.currentGame && Kit.currentGame.tools) || {};

  Kit.debug = { state: readDebugState, probe: probeFrames, tools: readTools };

  // ---- development checks ----------------------------------------------------------------------------------------------

  /** Wraps the listed functions of an api object so each call checks its arguments first (Kit.expectType). */
  const checkArguments = (namespace, api, rules) => {
    Object.keys(rules)
      .filter((name) => typeof api[name] === 'function')
      .forEach((name) => {
        const original = api[name];
        api[name] = (...args) => {
          rules[name].forEach(([position, argumentName, expected, example]) => Kit.expectType(`${namespace}.${name}(${argumentName})`, args[position], expected, example));
          return original(...args);
        };
      });
    return api;
  };

  /** Warns when a fourth stat joins the top row, naming all of them. */
  const watchStatCount = (ctx, ui) => {
    const labels = [];
    ['stat', 'pips'].forEach((name) => {
      const original = ui[name];
      ui[name] = (label, ...rest) => {
        labels.push(label);
        if (labels.length > MAX_STATS) {
          Kit.warn(`${ctx.def.id}: ${labels.length} stats in the top row (${labels.join(', ')}). ${MAX_STATS} fit a 390px phone: fold one into ui.progress, a ui.pips row or ui.el.`);
        }
        return original(label, ...rest);
      };
    });
  };

  /** Short description of a HUD element for a warning: its tag, class and the start of its text. */
  const describeElement = (element) => `<${element.tagName.toLowerCase()}${element.className ? ` class="${element.className}"` : ''}> "${element.textContent.trim().slice(0, 24)}"`;

  /** Warns about each HUD element that hangs past an edge of the viewport. */
  const reportOffscreenHud = (ctx) => {
    if (Kit.current !== ctx || document.getElementById('hud').hidden) return;
    const edges = [
      { edge: 'left', overhangOf: (box) => -box.left },
      { edge: 'top', overhangOf: (box) => -box.top },
      { edge: 'right', overhangOf: (box) => box.right - window.innerWidth },
      { edge: 'bottom', overhangOf: (box) => box.bottom - window.innerHeight },
    ];
    [...document.querySelectorAll('#stats > *, #actions > *, #hud-layer > *')]
      // Toasts animate through the layer and hidden hints are faded out, so neither says anything about layout.
      .filter((element) => element.getClientRects().length > 0 && !element.classList.contains('toast') && getComputedStyle(element).opacity !== '0')
      .forEach((element) => {
        const box = element.getBoundingClientRect();
        edges
          .filter(({ overhangOf }) => overhangOf(box) > OVERHANG_TOLERANCE_PX)
          .forEach(({ edge, overhangOf }) => {
            const where = `${Math.round(overhangOf(box))}px past the ${edge} edge at ${window.innerWidth}x${window.innerHeight}`;
            Kit.warn(`${ctx.def.id}: HUD element ${describeElement(element)} is ${where}. Shorten its text, drop a stat, or move it with theme.layout.`);
          });
      });
  };

  /** Wraps every scene helper so a THREE.Color passed where a hex number belongs is reported. */
  const watchRawColors = (make) => {
    Object.keys(make)
      .filter((name) => name !== 'color' && typeof make[name] === 'function')
      .forEach((name) => {
        const original = make[name];
        make[name] = (...args) => {
          if (args.some((argument) => argument && argument.isColor)) {
            Kit.warn(`make.${name} got a THREE.Color. Pass the hex number (make.${name}(..., 0xffc145)): the kit converts sRGB itself, and a raw Color looks washed out.`);
          }
          return original(...args);
        };
      });
    return make;
  };

  /** Installs the development checks by wrapping the factories the shell calls for every game. */
  const installChecks = () => {
    const originalUi = Kit.ui;
    const originalMake = Kit.make;
    const originalClock = Kit.clock;
    // Object.assign keeps what hangs off the factory itself (Kit.ui.h).
    Kit.ui = Object.assign((ctx) => {
      const ui = checkArguments('ui', originalUi(ctx), ARGUMENT_RULES.ui);
      watchStatCount(ctx, ui);
      setTimeout(() => reportOffscreenHud(ctx), HUD_CHECK_DELAY_MS);
      if (ctx.on) ctx.on('resize', () => reportOffscreenHud(ctx));
      return ui;
    }, originalUi);
    Kit.make = Object.assign((ctx) => watchRawColors(checkArguments('make', originalMake(ctx), ARGUMENT_RULES.make)), originalMake);
    Kit.clock = Object.assign(() => checkArguments('ctx', originalClock(), ARGUMENT_RULES.clock), originalClock);
  };

  // ---- developer overlay -----------------------------------------------------------------------------------------------

  const OVERLAY_CSS = `
    #kit-dev { position: fixed; left: 8px; bottom: 8px; z-index: 9; width: min(330px, calc(100vw - 16px)); max-height: 70vh; overflow: auto;
      padding: 8px 10px; border-radius: 8px; background: rgba(8, 10, 20, .92); color: #dfe6ff; border: 1px solid #44508a;
      font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace; pointer-events: auto; -webkit-user-select: text; user-select: text; }
    #kit-dev header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; color: #ffc145; }
    #kit-dev button, #kit-dev select { font: inherit; color: inherit; background: #1c2447; border: 1px solid #44508a; border-radius: 4px; padding: 2px 7px; margin-right: 4px; }
    #kit-dev button.on { background: #ffc145; color: #1a1205; }
    #kit-dev .row { display: flex; gap: 6px; align-items: baseline; margin-top: 4px; flex-wrap: wrap; }
    #kit-dev .row > span:first-child { color: #9aa6cf; min-width: 44px; }
    #kit-dev pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; color: #b9c4ee; }
    #kit-dev .bad { color: #ff8095; }`;

  /** Makes an element with an optional class and text. */
  const element = (tag, className, text) => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
  };

  /** A labelled row of the overlay; returns the row and the element that holds its value. */
  const overlayRow = (label) => {
    const row = element('div', 'row');
    const value = element('span');
    row.append(element('span', null, label), value);
    return { row, value };
  };

  /** The themes games had before the overlay swapped their skin, so "game's own" can put them back. */
  const ownThemes = new Map();
  /** The last uncaught error message seen by the page (development only), or ''. */
  let lastPageError = '';
  /** The open overlay: `{ root, timer, frameRequest }`, or null while closed. */
  let overlay = null;

  /** Restarts the running game under another skin (or its own theme again). */
  const wearSkin = (skinName) => {
    const ctx = Kit.current;
    if (!ctx || !ctx.def || !Kit.games.includes(ctx.def)) return;
    if (!ownThemes.has(ctx.def.id)) ownThemes.set(ctx.def.id, ctx.def.theme);
    ctx.def.theme = skinName === OWN_THEME ? ownThemes.get(ctx.def.id) : { skin: skinName };
    ctx.restart();
  };

  /** Builds the overlay's DOM and returns the functions that refresh it. */
  const buildOverlay = () => {
    const root = element('div');
    root.id = 'kit-dev';
    const style = element('style', null, OVERLAY_CSS);
    const header = element('header');
    const title = element('span');
    const closeButton = element('button', null, 'close');
    closeButton.addEventListener('click', () => Kit.dev.close());
    header.append(title, closeButton);

    const frame = overlayRow('frame');
    const scale = overlayRow('speed');
    const scaleButtons = TIME_SCALES.map((factor) => {
      const button = element('button', null, `${factor}x`);
      button.addEventListener('click', () => Kit.current && (Kit.current.timeScale = factor));
      return button;
    });
    scale.value.append(...scaleButtons);

    const theme = overlayRow('skin');
    const skinSelect = element('select');
    [OWN_THEME, ...Object.keys(Kit.theme.SKINS)].forEach((name) => skinSelect.append(element('option', null, name)));
    skinSelect.addEventListener('change', () => wearSkin(skinSelect.value));
    theme.value.append(skinSelect);

    const error = overlayRow('error');
    const state = element('pre');
    root.append(style, header, frame.row, scale.row, theme.row, error.row, state);

    const frameTimes = [];
    const refresh = () => {
      const snapshot = readDebugState();
      title.textContent = `dev: ${snapshot.id || 'no game'}  t=${snapshot.time.toFixed(1)}s${snapshot.paused ? ' (paused)' : ''}`;
      const average = frameTimes.reduce((sum, ms) => sum + ms, 0) / (frameTimes.length || 1);
      frame.value.textContent = `${average.toFixed(1)} ms avg (${Math.round(MS_PER_SECOND / (average || 1))} fps), worst ${Math.max(0, ...frameTimes).toFixed(1)} ms`;
      scaleButtons.forEach((button, index) => button.classList.toggle('on', TIME_SCALES[index] === snapshot.timeScale));
      const problem = snapshot.crash || lastPageError || Kit.warnings[Kit.warnings.length - 1] || '';
      error.value.textContent = problem ? problem.split('\n')[0] : 'none';
      error.value.className = snapshot.crash || lastPageError ? 'bad' : '';
      state.textContent = JSON.stringify({ hud: snapshot.hud, modal: snapshot.modal, state: snapshot.state }, null, 1).slice(0, OVERLAY_STATE_LENGTH);
    };
    const recordFrame = (milliseconds) => {
      frameTimes.push(milliseconds);
      if (frameTimes.length > METER_WINDOW_FRAMES) frameTimes.shift();
    };
    return { root, refresh, recordFrame };
  };

  /**
   * The developer overlay: frame time, live debug state, a skin switcher, time scale and the last error.
   * Open it with the backquote key or a three-finger tap (development only), or `Kit.dev.open()` from the
   * console anywhere. Closed, it has no DOM, no timers and no per-frame work.
   * @type {{open: function(): void, close: function(): void, toggle: function(): void, isOpen: function(): boolean}}
   * @example Kit.dev.toggle();
   */
  Kit.dev = {
    /** Is the overlay showing? */
    isOpen: () => Boolean(overlay),
    /** Shows the overlay and starts its frame meter and refresh timer. Does nothing when it is already open. */
    open() {
      if (overlay) return;
      const { root, refresh, recordFrame } = buildOverlay();
      document.body.append(root);
      let previous = performance.now();
      const meter = (now) => {
        recordFrame(now - previous);
        previous = now;
        if (overlay) overlay.frameRequest = requestAnimationFrame(meter);
      };
      overlay = { root, timer: setInterval(refresh, OVERLAY_REFRESH_MS), frameRequest: requestAnimationFrame(meter) };
      refresh();
    },
    /** Removes the overlay and stops everything it started. */
    close() {
      if (!overlay) return;
      clearInterval(overlay.timer);
      cancelAnimationFrame(overlay.frameRequest);
      overlay.root.remove();
      overlay = null;
    },
    /** Opens the overlay when it is closed and closes it when it is open. */
    toggle: () => (overlay ? Kit.dev.close() : Kit.dev.open()),
  };

  if (!Kit.isDevelopment()) return;
  installChecks();
  window.addEventListener('error', (event) => (lastPageError = event.message || String(event.error)));
  window.addEventListener('keydown', (event) => event.key === OVERLAY_KEY && Kit.dev.toggle());
  window.addEventListener('touchstart', (event) => event.touches.length === OVERLAY_TOUCHES && Kit.dev.toggle(), { passive: true });
})();
