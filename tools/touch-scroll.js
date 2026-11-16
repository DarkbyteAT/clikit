#!/usr/bin/env bun
/**
 * Touch-scroll check: "does this element scroll under a real finger drag?"
 *
 * Why it exists: the main menu once could not be scrolled on a phone while every scripted check passed, because
 * `element.scrollTop = n` and mouse-wheel events take a different path through the browser than a finger does. A
 * finger goes touchstart -> hit test -> touch-action -> gesture recognition -> scroll; this tool sends exactly
 * that (Chrome DevTools Protocol `Input.dispatchTouchEvent`, one touch point moved in small steps) and then
 * measures how far the element, and the page behind it, actually moved.
 *
 * Owns:  the finger drag, the measurement, and a self-test that proves the check can both pass and fail.
 * Does not own: opening the page (tools/smoke.js and tools/dev/browser.js do that and hand a Playwright page in).
 *
 *   bun tools/touch-scroll.js --self-test       four control pages: one must scroll, three must not
 *   bun tools/touch-scroll.js <selector>        drag on the arcade page (default selector: the menu's scroller)
 *
 * From another tool:
 *   const { expectTouchScroll } = require('./touch-scroll');
 *   const failure = await expectTouchScroll(page, '#menu-list');   // null when it scrolled, else the reason
 */
'use strict';

/** The menu's scroll container, the element the smoke test drags (kit/ui/menu.js builds it). */
const MENU_SCROLLER = '#menu-list';
/** How far the finger travels, CSS pixels. Longer than any browser's touch slop (about 15 px) by a wide margin. */
const DRAG_DISTANCE_PX = 240;
/** The drag is sent as this many touchmove events, one per frame, like a finger moving at ordinary speed. */
const DRAG_STEPS = 12;
const FRAME_MS = 16;
/** Real milliseconds to let the compositor finish the scroll (and any fling) before measuring. */
const SETTLE_MS = 350;
/** A drag counts as a scroll when the content follows at least this fraction of the finger's travel. */
const MIN_FOLLOW_FRACTION = 0.4;
/** The finger stays this far inside the element's visible box, so it never lands on a neighbour or the screen edge. */
const EDGE_INSET_PX = 12;

/**
 * @typedef {Object} DragReport
 * @property {boolean} found was the selector matched?
 * @property {number} room pixels the element could still scroll in the drag's direction before the drag
 * @property {number} moved pixels the element itself scrolled
 * @property {number} pageMoved pixels the document scrolled instead (the drag leaked to the page)
 * @property {number} travel pixels the finger travelled
 * @property {string} underFinger what the finger landed on, as `tag#id.class`
 * @property {string} touchActions the `touch-action` of every element from the one under the finger up to the scroller
 * @property {boolean} prevented did a script call preventDefault on a touch event of this drag?
 */

/**
 * Runs in the page: where to put the finger, and everything worth knowing before it lands.
 * @param {string} selector
 * @param {{distance: number, inset: number}} drag
 */
const planDrag = (selector, { distance, inset }) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const describe = (node) => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.split(' ')[0] : '');
  // The document's scroller reports its box as the whole page; a finger can only use the part on screen.
  const isPageScroller = element === document.scrollingElement;
  const box = isPageScroller ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : element.getBoundingClientRect();
  const top = Math.max(box.top, 0) + inset;
  const bottom = Math.min(box.bottom, innerHeight) - inset;
  const x = (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2;
  const travel = Math.min(distance, bottom - top);
  const startY = bottom;
  const landed = document.elementFromPoint(x, startY);
  const chain = [];
  for (let node = landed; node; node = node.parentElement) {
    chain.push(describe(node) + ':' + getComputedStyle(node).touchAction);
    if (node === element) break;
  }
  // Recorded on window in the capture phase, so a handler anywhere in the page that cancels the touch is seen.
  window.__touchScrollPrevented = false;
  // Read after the dispatch has finished: defaultPrevented stays set on the event object.
  const watch = (event) => setTimeout(() => (window.__touchScrollPrevented = window.__touchScrollPrevented || event.defaultPrevented), 0);
  ['touchstart', 'touchmove'].forEach((type) => window.addEventListener(type, watch, { capture: true, passive: true }));
  return {
    x,
    startY,
    travel,
    room: element.scrollHeight - element.clientHeight - element.scrollTop,
    scrollTop: element.scrollTop,
    pageTop: document.scrollingElement.scrollTop,
    underFinger: landed ? describe(landed) : 'nothing',
    touchActions: chain.join(' > '),
  };
};

/** Runs in the page: where the element and the document ended up. */
const readScroll = (selector) => ({
  scrollTop: document.querySelector(selector).scrollTop,
  pageTop: document.scrollingElement.scrollTop,
  prevented: Boolean(window.__touchScrollPrevented),
});

/**
 * Drags one finger upward across an element (the gesture that scrolls content down) and reports what moved.
 * The page must have been opened with touch enabled (`hasTouch: true`).
 * @param {import('playwright').Page} page
 * @param {string} selector the scroll container; `html` for the document itself
 * @param {{distance?: number, steps?: number}} [options] finger travel in CSS pixels, and how many moves it is sent as
 * @returns {Promise<DragReport>}
 * @example const report = await touchDrag(page, '.sheet-body'); // report.moved is 0 when the finger did nothing
 */
async function touchDrag(page, selector, { distance = DRAG_DISTANCE_PX, steps = DRAG_STEPS } = {}) {
  const plan = await page.evaluate(`(${planDrag})(${JSON.stringify(selector)}, ${JSON.stringify({ distance, inset: EDGE_INSET_PX })})`);
  if (!plan) return { found: false, room: 0, moved: 0, pageMoved: 0, travel: 0, underFinger: 'nothing', touchActions: '', prevented: false };
  const devtools = await page.context().newCDPSession(page);
  const finger = (type, y) => devtools.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: plan.x, y }] });
  await finger('touchStart', plan.startY);
  for (let step = 1; step <= steps; step++) {
    await finger('touchMove', plan.startY - (plan.travel * step) / steps);
    await page.waitForTimeout(FRAME_MS);
  }
  await finger('touchEnd');
  await page.waitForTimeout(SETTLE_MS);
  await devtools.detach();
  const after = await page.evaluate(`(${readScroll})(${JSON.stringify(selector)})`);
  // When the element is the document's scroller its movement and the page's are the same number; count it once.
  const isPageScroller = await page.evaluate((query) => document.querySelector(query) === document.scrollingElement, selector);
  return {
    found: true,
    room: plan.room,
    moved: after.scrollTop - plan.scrollTop,
    pageMoved: isPageScroller ? 0 : after.pageTop - plan.pageTop,
    travel: plan.travel,
    underFinger: plan.underFinger,
    touchActions: plan.touchActions,
    prevented: after.prevented,
  };
}

/**
 * Why a drag did not count as a scroll, in words that point at the fix; null when it did.
 * @param {string} selector
 * @param {DragReport} report
 * @returns {?string}
 */
function explainDrag(selector, report) {
  if (!report.found) return `${selector} is not on the page`;
  if (report.room <= 0) return `${selector} has nothing to scroll (its content fits). Fill it, or point the check at the element that overflows.`;
  const needed = Math.min(report.room, report.travel) * MIN_FOLLOW_FRACTION;
  if (report.moved >= needed) return null;
  const cause = report.prevented
    ? 'a script called preventDefault on the touch'
    : report.pageMoved > 0
      ? `the page scrolled ${report.pageMoved}px instead (the element is not the finger's scroll container)`
      : `the browser did not start a scroll (finger on ${report.underFinger}; touch-action chain: ${report.touchActions})`;
  return `${selector} moved ${report.moved}px under a ${report.travel}px finger drag with ${report.room}px of room: ${cause}`;
}

/**
 * The check other tools call: drag, and say what went wrong.
 * @param {import('playwright').Page} page opened with `hasTouch: true`
 * @param {string} selector the scroll container
 * @param {{distance?: number, steps?: number}} [options] see touchDrag
 * @returns {Promise<?string>} null when the element scrolled under the finger, otherwise the reason
 * @example
 * const failure = await expectTouchScroll(page, '#menu-list');
 * if (failure) errors.push('touch scroll: ' + failure);
 */
async function expectTouchScroll(page, selector, options) {
  return explainDrag(selector, await touchDrag(page, selector, options));
}

// ---- self-test: the check is only worth trusting if it can go both ways -------------------------------------------

const FILLER = Array.from({ length: 40 }, (_, index) => `<p style="height:40px;margin:0">row ${index}</p>`).join('');
const pageWith = (style, script = '') =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="pane" style="height:400px;${style}">${FILLER}</div><script>${script}</script>`;

/** Control pages: the same tall content in a 400px box, differing only in the one thing that decides scrolling. */
const CONTROLS = [
  { name: 'overflow auto (must scroll)', html: pageWith('overflow-y:auto'), shouldScroll: true },
  { name: 'overflow hidden (must not)', html: pageWith('overflow:hidden'), shouldScroll: false },
  { name: 'touch-action none (must not)', html: pageWith('overflow-y:auto;touch-action:none'), shouldScroll: false },
  {
    name: 'touchmove preventDefault (must not)',
    html: pageWith('overflow-y:auto', `document.getElementById('pane').addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });`),
    shouldScroll: false,
  },
];

/**
 * Runs every control page and compares the verdict with what the page was built to do.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<string[]>} one line per control that gave the wrong verdict (empty when the check is sound)
 */
async function selfTest(browser) {
  const wrong = [];
  for (const control of CONTROLS) {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
    await page.setContent(control.html);
    const report = await touchDrag(page, '#pane');
    const failure = explainDrag('#pane', report);
    const scrolled = failure === null;
    console.log(`  ${scrolled === control.shouldScroll ? 'ok   ' : 'WRONG'} ${control.name}: moved ${report.moved}px of ${report.travel}px${failure ? ' (' + failure.split(': ').pop() + ')' : ''}`);
    if (scrolled !== control.shouldScroll) wrong.push(control.name);
    await page.close();
  }
  return wrong;
}

async function main() {
  const { openArcade, takeBrowserSlot } = require('./dev/browser');
  const wanted = process.argv[2] || MENU_SCROLLER;
  if (wanted === '--self-test') {
    const { chromium } = require('playwright');
    const releaseSlot = await takeBrowserSlot();
    const browser = await chromium.launch();
    const wrong = await selfTest(browser);
    await browser.close();
    releaseSlot();
    console.log(wrong.length ? `FAILED: the touch check gave the wrong verdict on: ${wrong.join('; ')}` : 'OK');
    process.exit(wrong.length ? 1 : 0);
  }
  const session = await openArcade();
  const failure = await expectTouchScroll(session.page, wanted);
  await session.close();
  console.log(failure ? `FAILED: ${failure}` : `OK: ${wanted} scrolls under a finger`);
  process.exit(failure ? 1 : 0);
}

if (require.main === module) main();

module.exports = { touchDrag, explainDrag, expectTouchScroll, selfTest, MENU_SCROLLER };
