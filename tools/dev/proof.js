/**
 * Dev tools proof sheets: pictures of the body system's coverage suites (kit/body-proof.js), one PNG per page.
 *
 * Owns:  opening the `proof` workbench screen, sizing the window to each page's grid, and saving the pictures.
 * Does not own: what a suite contains or how a cell is drawn (kit/body-proof.js), or the browser session (browser.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./project');
const { openArcade, SHOT_MS } = require('./browser');

/** Pixels per cell across (PROOF_CELL in the environment overrides it for bigger cells), the most rows per picture (a picture stays readable when scaled to a screen; PROOF_ROWS overrides it), and the waits for a page and for one cell of it to be drawn. */
const PAGE = { cellWidth: Number(process.env.PROOF_CELL) || 230, rows: Number(process.env.PROOF_ROWS) || 4, mostPages: 40, settleMs: 350, soloMs: 120 };
const OUT = path.join(ROOT, 'shots', 'proof');

/**
 * Joins PNG buffers into one picture on a 2D canvas in the page (no image library needed): top to bottom, or left
 * to right when `across`.
 * @returns {Promise<Buffer>} the PNG
 */
async function join(session, strips, across = false) {
  const encoded = await session.page.evaluate(async ({ sources, across }) => {
    const images = await Promise.all(
      sources.map(
        (source) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = source;
          })
      )
    );
    const [along, beside] = across ? ['width', 'height'] : ['height', 'width'];
    const canvas = document.createElement('canvas');
    canvas[beside] = Math.max(...images.map((image) => image[beside]));
    canvas[along] = images.reduce((sum, image) => sum + image[along], 0);
    const context = canvas.getContext('2d');
    images.reduce((start, image) => (context.drawImage(image, across ? start : 0, across ? 0 : start), start + image[along]), 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { sources: strips.map((strip) => `data:image/png;base64,${strip.toString('base64')}`), across });
  return Buffer.from(encoded, 'base64');
}

/** Stacks PNG buffers of equal width into one file, top to bottom. */
async function stack(session, strips, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await join(session, strips));
}

/**
 * One row of close-ups, each cell photographed alone and cut to its cell: the body behind a head reaches into the
 * cells beside it, and would cover its neighbours' heads if the row were photographed whole.
 * @returns {Promise<Buffer>} the row as one PNG
 */
async function soloRow(session, columns) {
  const cells = await session.page.evaluate(() => Kit.currentGame.solo(null));
  const { width, height } = session.page.viewportSize();
  const cellWidth = width / columns;
  const tiles = [];
  for (let cell = 0; cell < columns; cell++) {
    await session.page.evaluate((index) => Kit.currentGame.solo(index), cell < cells ? cell : -1);
    await session.page.waitForTimeout(PAGE.soloMs);
    tiles.push(await session.page.screenshot({ timeout: SHOT_MS, clip: { x: Math.round(cell * cellWidth), y: 0, width: Math.round(cellWidth), height } }));
  }
  await session.page.evaluate(() => Kit.currentGame.solo(null));
  return join(session, tiles, true);
}

/**
 * Photographs suites.
 * @param {{suites: string[], catalog?: string, preset?: string, species?: string[], acts?: string[], only?: string[], framing?: string, out?: string, pages?: number, count?: number, rigid?: boolean, level?: string, sockets?: string[]}} options
 *   `acts` narrows the acts suite to those movements (default: every one a body can do); `sockets`: the
 *   socket paths the worn suite turns round (its default when left out); `only`: the socket paths (options suite)
 *   or dial ids (extremes suite) to show, default all; `framing`: 'head' or 'body' instead of the suite's own
 *   (face options and dials are judged close up); `count`: how many
 *   individuals the rolls and faces suites roll (their default when left out); `rigid`: the rigid path (files are
 *   named `-rigid`), for a before / after pair; `level`: a level of detail instead of the one the cell size asks for
 * @returns {Promise<{files: string[], problems: string[]}>}
 * @example await makeProof({ suites: ['turn', 'rolls'], catalog: 'wardrobe', preset: 'pixel' });
 */
async function makeProof({ suites, catalog = 'wardrobe', preset = 'toon', species = [], acts, only = [], framing, out = OUT, pages: mostPages = PAGE.mostPages, count, rigid = false, level, sockets }) {
  const session = await openArcade({ size: { width: PAGE.cellWidth * 8, height: 1200 } });
  const files = [];
  const problems = [];
  try {
    await session.launchGame('proof');
    // The shell's HUD (back button, title) would cover the top row of cells.
    await session.page.addStyleTag({ content: '#hud-top { visibility: hidden !important; }' });
    for (const suite of suites) {
      /** Pictures of single rows waiting to be stacked into one file (close-ups are drawn one row at a time). */
      let strips = [];
      const flush = async (name) => {
        if (!strips.length) return;
        const file = path.join(out, name);
        await stack(session, strips, file);
        files.push(file);
        strips = [];
      };
      /** What every page of the suite is drawn with; `rigid` and `level` are the screen's own switches. */
      const job = { suite, catalog, preset, species, ...(acts ? { acts } : {}), only, framing, count, rigid, level, sockets, cellPixels: PAGE.cellWidth };
      // One row is drawn once to learn the suite's framing; every page after that is drawn exactly once.
      const probe = await session.page.evaluate((shown) => Kit.currentGame.show(shown), { ...job, page: 0, rows: 1 });
      const rows = probe.framing === 'head' ? 1 : PAGE.rows;
      for (let page = 0, pageCount = 1, filed = 0; page < Math.min(pageCount, mostPages); page++) {
        const first = await session.page.evaluate((shown) => Kit.currentGame.show(shown), { ...job, page, rows });
        pageCount = first.pages;
        await session.page.setViewportSize({ width: first.columns * PAGE.cellWidth, height: Math.round((first.columns * PAGE.cellWidth) / first.aspect) });
        await session.page.waitForTimeout(PAGE.settleMs);
        const numbered = (count) => `${catalog}-${suite}${framing ? `-${framing}` : ''}-${preset}${rigid ? '-rigid' : ''}${count > 1 ? `-${String(filed + 1).padStart(2, '0')}` : ''}.png`;
        if (rows === 1) {
          strips.push(await soloRow(session, first.columns));
          if (strips.length === PAGE.rows || page === Math.min(pageCount, mostPages) - 1) {
            await flush(numbered(Math.ceil(pageCount / PAGE.rows)));
            filed += 1;
          }
        } else {
          const file = path.join(out, numbered(pageCount));
          await session.shot(file);
          files.push(file);
          filed += 1;
        }
        first.refusals.forEach((refusal) => problems.push(`note: ${refusal.split('.')[0]}`));
      }
    }
    problems.push(...session.errors.map((error) => `ERROR ${error}`));
    return { files, problems: [...new Set(problems)] };
  } finally {
    await session.close();
  }
}

module.exports = { makeProof };
