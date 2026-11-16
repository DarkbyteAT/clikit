/**
 * Dev tools contact sheets: one picture of every game (`sheet`), or of one game under every skin (`skins`).
 *
 * Owns:  playing each game briefly, taking one screenshot each, and tiling them into a labelled sheet.
 * Does not own: the browser session (browser.js) or where shots live (shots/, shared with tools/smoke.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./project');
const { openArcade } = require('./browser');

const SHOTS = path.join(ROOT, 'shots');
/** How the thumb warms a game up before its picture: a few taps and a drag, enough to leave the title state. */
const WARM_UP = { taps: 3, tapGapMs: 250, dragPixels: 120, settleMs: 900 };
/** Layout of the sheet, in CSS pixels. */
const SHEET = { columns: 4, tileWidth: 260, gap: 12, labelHeight: 22 };

/** Plays the running game for a moment so the picture shows play, not the first frame. */
async function warmUp(session) {
  const { page, size } = session;
  const centre = { x: size.width / 2, y: size.height * 0.55 };
  for (let count = 0; count < WARM_UP.taps; count++) {
    await session.pointer.tap(centre.x, centre.y);
    await page.waitForTimeout(WARM_UP.tapGapMs);
  }
  await session.pointer.down(centre.x, centre.y);
  await session.pointer.move(centre.x + WARM_UP.dragPixels / 2, centre.y - WARM_UP.dragPixels / 4);
  await session.pointer.move(centre.x + WARM_UP.dragPixels, centre.y - WARM_UP.dragPixels / 2);
  await session.pointer.up();
  await page.waitForTimeout(WARM_UP.settleMs);
}

/** The HTML of a contact sheet: a grid of labelled images (as data URIs, so the page needs no server). */
const sheetHtml = (title, tiles) => {
  const cells = tiles
    .map(({ label, file }) => {
      const image = fs.existsSync(file) ? `<img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}">` : '<div class="missing">failed</div>';
      return `<figure>${image}<figcaption>${label}</figcaption></figure>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: ${SHEET.gap}px; background: #10131f; color: #dfe6ff; font: 13px system-ui, sans-serif; }
    h1 { font-size: 15px; margin: 0 0 ${SHEET.gap}px; }
    main { display: grid; grid-template-columns: repeat(${SHEET.columns}, ${SHEET.tileWidth}px); gap: ${SHEET.gap}px; }
    figure { margin: 0; } img, .missing { width: ${SHEET.tileWidth}px; display: block; border-radius: 6px; }
    .missing { aspect-ratio: 1 / 2; display: grid; place-items: center; background: #3a1220; }
    figcaption { height: ${SHEET.labelHeight}px; line-height: ${SHEET.labelHeight}px; text-align: center; }
  </style><h1>${title}</h1><main>${cells}</main>`;
};

/**
 * Makes a contact sheet.
 * @param {{ids?: string[], skinsOf?: string, landscape?: boolean}} options `ids`: the games to include (default
 *   all registered); `skinsOf`: instead, one game under every kit skin
 * @returns {Promise<{file: string, problems: string[]}>} the sheet's path and anything that went wrong on the way
 * @example await makeSheet({ skinsOf: 'miner' }); // shots/skins-miner.png
 */
async function makeSheet({ ids = [], skinsOf, landscape = false } = {}) {
  const session = await openArcade({ landscape });
  const problems = [];
  try {
    const subjects = skinsOf
      ? (await session.skinNames()).map((skin) => ({ id: skinsOf, skin, label: skin, file: path.join(SHOTS, 'sheet', `${skinsOf}-${skin}.png`) }))
      : (ids.length ? ids : await session.gameIds()).map((id) => ({ id, label: id, file: path.join(SHOTS, 'sheet', `${id}.png`) }));
    for (const subject of subjects) {
      try {
        fs.rmSync(subject.file, { force: true });
        await session.launchGame(subject.id, subject.skin);
        await warmUp(session);
        await session.shot(subject.file);
      } catch (error) {
        problems.push(`${subject.label}: ${error.message.split('\n')[0]}`);
      }
      await session.page.evaluate(() => Kit.menu());
    }
    problems.push(...session.errors);
    const file = path.join(SHOTS, skinsOf ? `skins-${skinsOf}.png` : 'sheet.png');
    const rows = Math.ceil(subjects.length / SHEET.columns);
    await session.page.setViewportSize({ width: SHEET.columns * (SHEET.tileWidth + SHEET.gap) + SHEET.gap, height: Math.max(1, rows) * (SHEET.tileWidth * 2 + SHEET.labelHeight + SHEET.gap) + 60 });
    await session.page.setContent(sheetHtml(skinsOf ? `${skinsOf} under every skin` : 'Every game', subjects));
    await session.page.screenshot({ path: file, fullPage: true });
    return { file, problems };
  } finally {
    await session.close();
  }
}

module.exports = { makeSheet };
