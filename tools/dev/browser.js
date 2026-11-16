/**
 * Dev tools browser session: serves the page locally and opens it in headless Chromium, the way tools/smoke.js
 * does, so `play` and `sheet` never repeat that setup.
 *
 * Owns:  the local server (CDN libraries swapped for vendor copies), the browser and page lifetime, error and
 *        warning capture, launching a game by id, and exact-moment screenshots.
 * Does not own: what is done with the page (play.js, sheet.js). tools/smoke.js keeps its own copy of the server
 *        on purpose: running agents depend on that file staying as it is.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./project');

const PORTRAIT = { width: 390, height: 780 };
const LANDSCAPE = { width: 780, height: 390 };
/** The largest viewport side `--size` accepts, CSS pixels: software GL takes seconds per frame beyond it. */
const MOST_VIEWPORT_PIXELS = 2400;
const LEAST_VIEWPORT_PIXELS = 100;

/**
 * Reads a viewport size written as `<width>x<height>` (the `--size` flag of `play`).
 * @param {string} text e.g. '1200x900'
 * @returns {{width: number, height: number}} CSS pixels
 * @throws {Error} naming the bad text and the accepted form and range
 * @example parseSize('1200x900') // { width: 1200, height: 900 }
 */
function parseSize(text) {
  const match = /^(\d+)x(\d+)$/.exec(String(text).trim());
  const size = match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  const isInRange = size && [size.width, size.height].every((side) => side >= LEAST_VIEWPORT_PIXELS && side <= MOST_VIEWPORT_PIXELS);
  if (!isInRange) throw new Error(`"${text}" is not a viewport size. Write <width>x<height> in CSS pixels, each from ${LEAST_VIEWPORT_PIXELS} to ${MOST_VIEWPORT_PIXELS}, e.g. --size 1200x900.`);
  return size;
}

const CONTENT_TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png' };
/** CDN URLs in index.html and the local copies that stand in for them (tests have no network). */
const VENDOR_SWAPS = [
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.147\.0\//g, 'vendor/three/'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/cannon\.js\/0\.6\.2\/cannon\.min\.js/g, 'vendor/cannon.min.js'],
  // The component library's runtime (kit/ui/): Preact, hooks, htm and signals.
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/preact\/10\.24\.3\//g, 'vendor/ui/'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/preact@10\.24\.3\/hooks\/dist\//g, 'vendor/ui/'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/htm@3\.1\.1\/dist\//g, 'vendor/ui/'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/@preact\/signals-core@1\.8\.0\/dist\//g, 'vendor/ui/'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/@preact\/signals@1\.3\.0\/dist\//g, 'vendor/ui/'],
];
const BROWSER_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/** Real milliseconds: for the page to settle after load, for a game to build, and for bloom to render before a screenshot. */
const SETTLE_MS = 400;
const LAUNCH_MS = 600;
const BLOOM_MS = 350;
const PAGE_SHELL = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>';

/**
 * The machine-wide browser limit, shared with tools/smoke.js (same folder, same protocol): a run takes one of a
 * few slots - a directory, created atomically - before launching a browser, and waits its turn when none is free.
 */
const SLOTS = {
  count: Number(process.env.KIT_BROWSER_SLOTS || 3),
  folder: path.join(os.tmpdir(), 'kit-browser-slots'),
  staleMs: 6 * 60 * 1000, // a slot older than this belongs to a run that died without releasing it
  retryMs: 1500,
  heartbeatMs: 60 * 1000, // a long run refreshes its slot so it is not mistaken for a dead one
};

/**
 * Waits for a free browser slot and takes it.
 * @returns {Promise<function(): void>} call it to give the slot back (also done automatically when the process exits)
 */
async function takeBrowserSlot() {
  fs.mkdirSync(SLOTS.folder, { recursive: true });
  for (;;) {
    for (let index = 0; index < SLOTS.count; index++) {
      const slot = path.join(SLOTS.folder, `slot-${index}`);
      try {
        fs.mkdirSync(slot); // atomic: exactly one process wins
        const heartbeat = setInterval(() => fs.existsSync(slot) && fs.utimesSync(slot, new Date(), new Date()), SLOTS.heartbeatMs);
        heartbeat.unref();
        const release = () => {
          clearInterval(heartbeat);
          fs.rmSync(slot, { recursive: true, force: true });
        };
        process.on('exit', release);
        return release;
      } catch {
        const age = Date.now() - (fs.existsSync(slot) ? fs.statSync(slot).mtimeMs : Date.now());
        if (age > SLOTS.staleMs) fs.rmSync(slot, { recursive: true, force: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SLOTS.retryMs + Math.random() * SLOTS.retryMs));
  }
}

/**
 * @typedef {Object} Pointer one finger (or the mouse) on the page
 * @property {function(number, number): Promise<void>} down
 * @property {function(number, number): Promise<void>} move
 * @property {function(): Promise<void>} up
 * @property {function(number, number): Promise<void>} tap down and up at one point
 * @property {function(Array<{x: number, y: number}>): Promise<void>} flick moves the held pointer through points and lets go, all within a few hundredths of a second
 */

/**
 * Makes the pointer the play steps drive: the mouse, or a real touch (Chrome DevTools Protocol touch events,
 * which the page receives exactly as a finger: touchstart / touchend and pointer events with pointerType "touch").
 * Touch is what scroll panes and touch-only code need. It is not the default because Chromium delivers touch
 * input aligned to rendered frames: measured on this shared machine, a touch tap's pointerdown and pointerup
 * reached the page 1.2 s apart, far outside the 280 ms Kit.input allows a tap, so touch taps are only reliable
 * when frames are fast.
 * @param {import('playwright').Page} page
 * @param {boolean} useTouch
 * @returns {Promise<Pointer>}
 */
/** Milliseconds between the events of a flick, and the usual thousand. */
const FLICK_STEP_MS = 12;
const MS_PER_SECOND = 1000;

async function createPointer(page, useTouch) {
  if (!useTouch) {
    const flickMouse = async (points) => {
      for (const point of points) await page.mouse.move(point.x, point.y);
      await page.mouse.up();
    };
    return { down: (x, y) => page.mouse.move(x, y).then(() => page.mouse.down()), move: (x, y) => page.mouse.move(x, y), up: () => page.mouse.up(), tap: (x, y) => page.mouse.click(x, y), flick: flickMouse };
  }
  const devtools = await page.context().newCDPSession(page);
  const touch = (type, points) => devtools.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  // Chromium delivers touch input aligned to animation frames, so a release is only "done" once the page has
  // run two more frames; without this wait the next step can read the game before the tap has reached it.
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const down = (x, y) => touch('touchStart', [{ x, y }]);
  const up = () => touch('touchEnd', []).then(settle);
  // A flick is faster than frames arrive here, so its events carry their own times (the protocol's `timestamp`,
  // seconds): the page's event.timeStamp then says when the finger was there, as a real touch screen's does.
  const flick = async (points) => {
    const startedAt = Date.now() / MS_PER_SECOND;
    const stamped = (type, touchPoints, order) => devtools.send('Input.dispatchTouchEvent', { type, touchPoints, timestamp: startedAt + (order * FLICK_STEP_MS) / MS_PER_SECOND });
    for (const [order, point] of points.entries()) await stamped('touchMove', [point], order + 1);
    await stamped('touchEnd', [], points.length + 1).then(settle);
  };
  return { down, move: (x, y) => touch('touchMove', [{ x, y }]), up, tap: (x, y) => down(x, y).then(up), flick };
}

/** The page as the host would wrap it, with fonts dropped and CDN scripts pointed at vendor/. */
const renderPage = () => {
  const withoutFonts = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<link[^>]+fonts\.googleapis[^>]+>/, '');
  const body = VENDOR_SWAPS.reduce((html, [pattern, replacement]) => html.replace(pattern, replacement), withoutFonts);
  return `${PAGE_SHELL}${body}</body></html>`;
};

/** Answers one request: the page at `/`, any project file otherwise. */
const serve = (request, response) => {
  const url = request.url.split('?')[0];
  if (url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(renderPage());
  }
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
  return response.end(fs.readFileSync(file));
};

/**
 * @typedef {Object} ArcadeSession
 * @property {import('playwright').Page} page
 * @property {{width: number, height: number}} size the viewport
 * @property {string[]} errors page errors and console errors seen so far
 * @property {function(): Promise<string[]>} warnings the kit's development warnings so far (Kit.warnings)
 * @property {function(): Promise<string[]>} gameIds ids of the registered games, in menu order
 * @property {function(): Promise<string[]>} skinNames names of the kit's skins
 * @property {function(string, string=): Promise<void>} launchGame start a game by id, optionally under a skin
 * @property {function(string): Promise<void>} shot save a screenshot of this exact moment (bloom on, game frozen)
 * @property {Pointer} pointer what the play steps press with (the mouse, or a real touch when `touch` was asked for)
 * @property {function(): Promise<void>} close
 */

/**
 * Opens the arcade page in a headless browser.
 * @param {{landscape?: boolean, touch?: boolean, size?: {width: number, height: number}}} [options] `touch`: drive the page with real
 *   touch events instead of the mouse; `size`: a viewport of its own (from `parseSize`), instead of the phone's
 * @returns {Promise<ArcadeSession>} waits for a machine-wide browser slot first (a waiting run is not a hung run)
 * @example
 * const session = await openArcade({ landscape: true });
 * await session.launchGame('miner'); await session.shot('scratch/miner/start.png'); await session.close();
 */
async function openArcade({ landscape = false, touch = false, size: ownSize } = {}) {
  const { chromium } = require('playwright');
  const releaseSlot = await takeBrowserSlot();
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(0, resolve));
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  const size = ownSize || (landscape ? LANDSCAPE : PORTRAIT);
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
  page.on('console', (message) => message.type() === 'error' && !/favicon|404/.test(message.text()) && errors.push('console: ' + message.text()));
  // Software GL is slow: stop the quality governor from stepping down, and play with bloom off (shots turn it on).
  await page.addInitScript(() => (window.KIT_LOCK_QUALITY = true));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => Kit.post_ && Kit.post_.disable());

  const gameIds = () => page.evaluate(() => Kit.games.map((game) => game.id));

  const launchGame = async (id, skin) => {
    const ids = await gameIds();
    if (!ids.includes(id)) throw new Error(`game "${id}" is not registered (registered: ${ids.join(', ') || 'none'}). Check its script tag with \`node tools/dev.js tags\`.`);
    if (skin) await page.evaluate(([gameId, name]) => (Kit.games.find((game) => game.id === gameId).theme = { skin: name }), [id, skin]);
    // Through the DOM or Kit.play, never a Playwright click: layout must not be able to block a test.
    await page.evaluate((gameId) => {
      const card = document.getElementById('card-' + gameId);
      return card ? card.click() : Kit.play(gameId);
    }, id);
    await page.waitForTimeout(LAUNCH_MS);
    const crash = await page.evaluate(() => Kit.lastCrash || null);
    if (crash) throw new Error(`game "${id}" crashed while starting: ${crash}`);
  };

  const shot = async (file) => {
    // Freeze the game (unless a modal already has) so the bloom frame shows exactly this moment.
    const didFreeze = await page.evaluate(() => {
      const canFreeze = Kit.current && !Kit.current.paused;
      if (canFreeze) Kit.current.paused = true;
      if (Kit.post_) Kit.post_.enable();
      return Boolean(canFreeze);
    });
    await page.waitForTimeout(BLOOM_MS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A big software-GL canvas on a loaded machine takes longer to read back than the 30 s default.
    await page.screenshot({ path: file, timeout: 180000 });
    await page.evaluate((shouldResume) => {
      if (Kit.post_) Kit.post_.disable();
      if (shouldResume && Kit.current) Kit.current.paused = false;
    }, didFreeze);
  };

  return {
    page,
    size,
    errors,
    warnings: () => page.evaluate(() => (Kit.warnings || []).slice()),
    gameIds,
    skinNames: () => page.evaluate(() => Object.keys(Kit.theme.SKINS)),
    launchGame,
    shot,
    pointer: await createPointer(page, touch),
    close: async () => {
      await browser.close();
      server.close();
      releaseSlot();
    },
  };
}

module.exports = { openArcade, takeBrowserSlot, parseSize, PORTRAIT, LANDSCAPE };
