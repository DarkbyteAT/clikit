#!/usr/bin/env node
// Smoke test: serves the page locally (CDN libs swapped for vendor copies), opens it at phone size,
// launches a game, plays it with scripted gestures, and reports JS errors, crash toasts and frame rate.
//
//   node tools/smoke.js <gameId|menu|all|id,id,...> [--secs 8] [--gesture drag|tap|swipe|mix] [--skin glass|neon|pixel|paper|stone|toy|air|parchment]
//
// `all` plays the menu and then every game the page registered (Kit.games); a comma list plays several in one browser.
// Each game also prints a PROBE line (frame-time percentiles, draw calls, triangles, live meshes from Kit.debug.probe)
// and a WARN line per kit development warning; `node tools/dev.js check` reads both (budgets: tools/dev/budgets.js).
// Screenshots land in shots/<id>-mid.png and shots/<id>-end.png. Exit code 1 on any error.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const target = args[0] && !args[0].startsWith('--') ? args[0] : 'menu';
const SECS = Number(flag('secs', 8));
const GESTURE = flag('gesture', 'mix');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png' };
const VENDOR = [
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.147\.0\//g, 'vendor/three/'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/cannon\.js\/0\.6\.2\/cannon\.min\.js/g, 'vendor/cannon.min.js'],
];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') {
    let body = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<link[^>]+fonts\.googleapis[^>]+>/, '');
    for (const [re, to] of VENDOR) body = body.replace(re, to);
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page);
  }
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function gestures(page, secs, kind) {
  const W = 390, H = 780;
  const end = Date.now() + secs * 1000;
  let i = 0;
  while (Date.now() < end) {
    // Dismiss any modal (upgrade choice, game over) by pressing its first button, like a player would.
    const btn = page.locator('#modal:not([hidden]) button').first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000, force: true }).catch(() => {});
      await page.waitForTimeout(150);
      continue;
    }
    const k = kind === 'mix' ? ['drag', 'tap', 'swipe'][i % 3] : kind;
    const x = 80 + Math.random() * (W - 160), y = 260 + Math.random() * (H - 460);
    if (k === 'tap') {
      await page.mouse.click(x, y);
      await page.waitForTimeout(180);
    } else if (k === 'swipe') {
      const [dx, dy] = [[90, 0], [-90, 0], [0, -90], [0, 90]][i % 4];
      await page.mouse.move(W / 2, H * 0.6);
      await page.mouse.down();
      await page.mouse.move(W / 2 + dx, H * 0.6 + dy, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(220);
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let s = 0; s < 6; s++) await page.mouse.move(x + (Math.random() - 0.5) * 160, y + (Math.random() - 0.5) * 160, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(120);
    }
    // Press a random bottom-bar action now and then (shops, abilities).
    if (i % 5 === 4) {
      const acts = page.locator('#actions button:not([disabled])');
      const n = await acts.count();
      if (n) await acts.nth((Math.random() * n) | 0).click({ timeout: 500 }).catch(() => {});
    }
    i++;
  }
}

async function run(browser, base, id) {
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push('console: ' + m.text()));
  await page.addInitScript(() => (window.KIT_LOCK_QUALITY = true)); // software GL is slow; keep bloom on for screenshots
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // Bloom is very slow in software GL: play with it off, switch it on just for the screenshots.
  await page.evaluate(() => Kit.post_ && Kit.post_.disable());
  const shot = async (name) => {
    await page.evaluate(() => Kit.post_ && Kit.post_.enable());
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(ROOT, 'shots', name) });
    await page.evaluate(() => Kit.post_ && Kit.post_.disable());
  };
  const ids = await page.evaluate(() => Kit.games.map((g) => g.id));
  if (id === 'menu') {
    await shot('menu.png');
    console.log(`menu: games registered = [${ids.join(', ')}]`);
  } else {
    if (!ids.includes(id)) errors.push(`game "${id}" is not registered (registered: ${ids.join(', ') || 'none'})`);
    else {
      // --skin <name>: preview a game under any kit skin without editing the game (see kit/theme.js SKINS).
      const skin = flag('skin', null);
      if (skin) await page.evaluate(([gameId, name]) => (Kit.games.find((g) => g.id === gameId).theme = { skin: name }), [id, skin]);
      // Started through the DOM, not a Playwright click: a card that layout has pushed out of reach must not block a test.
      await page.evaluate((gameId) => document.getElementById('card-' + gameId).click(), id);
      await page.waitForTimeout(600);
      await gestures(page, SECS / 2, GESTURE);
      await shot(`${id}-mid.png`);
      await gestures(page, SECS / 2, GESTURE);
      await shot(`${id}-end.png`);
      const crash = await page.evaluate(() => Kit.lastCrash || null);
      if (crash) errors.push('game crashed back to menu: ' + crash);
      const fps = await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); (function f() { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : r(n); })(); }));
      const hudText = await page.evaluate(() => document.getElementById('stats').innerText.replace(/\n/g, ' '));
      console.log(`${id}: ~${fps} fps (software GL, expect far higher on a phone) | hud: ${hudText}`);
      // Frame probe (kit/dev.js): the frame times are software-GL numbers and mean nothing for a phone; draw calls,
      // triangles and mesh counts are machine-independent and are what the budgets check.
      const probe = await page.evaluate(() => (window.Kit && Kit.debug && Kit.debug.probe && Kit.current ? Kit.debug.probe(1.5) : null)).catch(() => null);
      if (probe) console.log(`  PROBE [${id}] ${JSON.stringify(probe)}`);
      // Exit and re-enter to prove dispose/restart is clean.
      if (!crash) {
        // A run may end on a banner or upgrade choice at any moment: close modals right before every click.
        const clear = async () => {
          for (let n = 0; n < 8 && (await page.locator('#modal:not([hidden]) button').count()); n++) {
            await page.locator('#modal:not([hidden]) button').last().click({ timeout: 3000, force: true }).catch(() => {});
            await page.waitForTimeout(250);
          }
        };
        // Lifecycle controls are pressed through the DOM: on a slow machine Playwright's own click can time out after it has
        // already landed, which looked like the game quitting by itself.
        const press = async (sel) => {
          await clear();
          const ok = await page.evaluate((q) => {
            const el = document.querySelector(q);
            if (!el || el.closest('[hidden]')) return false;
            el.click();
            return true;
          }, sel);
          if (!ok) errors.push(`could not press ${sel}: ${await page.evaluate(() => Kit.lastCrash || 'control hidden or missing')}`);
        };
        await press('#back');
        await page.waitForTimeout(200);
        await press('#card-' + id);
        await page.waitForTimeout(500);
        await press('#restart');
        await page.waitForTimeout(300);
      }
    }
  }
  await page.close();
  const kitWarnings = await page.evaluate(() => (window.Kit && Kit.warnings ? Kit.warnings.slice() : [])).catch(() => []);
  for (const warning of kitWarnings) console.log(`  WARN [${id}] ${warning}`);
  for (const e of errors) console.log(`  ERROR [${id}] ${e}`);
  return errors.length;
}

// ---- machine-wide browser limit ---------------------------------------------------------------------------------
// Many agents share this machine. Unlimited headless browsers drove the load past 40 and got runs killed, so every
// smoke run first takes one of a few slots (an atomically created directory) and waits its turn if none is free.
const os = require('os');
const BROWSER_SLOTS = Number(process.env.KIT_BROWSER_SLOTS || 3);
const SLOT_DIR = path.join(os.tmpdir(), 'kit-browser-slots');
const STALE_SLOT_MS = 6 * 60 * 1000; // a slot older than this belongs to a run that died without releasing it
/** Wait for a free slot and take it. @returns {Promise<string>} the slot's path, to pass to releaseSlot. */
async function takeSlot() {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  for (;;) {
    for (let index = 0; index < BROWSER_SLOTS; index++) {
      const slot = path.join(SLOT_DIR, 'slot-' + index);
      try {
        fs.mkdirSync(slot); // atomic: exactly one process wins
        return slot;
      } catch (error) {
        const age = Date.now() - (fs.existsSync(slot) ? fs.statSync(slot).mtimeMs : Date.now());
        if (age > STALE_SLOT_MS) fs.rmSync(slot, { recursive: true, force: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));
  }
}
const releaseSlot = (slot) => fs.rmSync(slot, { recursive: true, force: true });

(async () => {
  const slot = await takeSlot();
  process.on('exit', () => releaseSlot(slot));
  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => process.exit(1)));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let bad = 0;
  // `all` asks the page which games exist, so a new game is covered the moment it registers.
  const registeredIds = async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'load' });
    const ids = await page.evaluate(() => Kit.games.map((game) => game.id));
    await page.close();
    return ids;
  };
  const list = target === 'all' ? ['menu', ...(await registeredIds())] : target.split(',');
  for (const id of list) bad += await run(browser, base, id);
  await browser.close();
  server.close();
  console.log(bad ? `FAILED with ${bad} error(s)` : 'OK');
  process.exit(bad ? 1 : 0);
})();
