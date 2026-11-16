#!/usr/bin/env bun
/**
 * Component tests: the behaviour of kit/ui/ in a real browser, driven the way a person would (finger drags,
 * key presses, clicks), on the menu and on the component gallery.
 *
 * Owns:  the checks a pure unit test cannot make: an element scrolls under a finger, focus stays inside a dialog
 *        and returns to its opener, arrow keys move between tabs and options, queues hold back a burst, every
 *        control is at least 44px, and the legacy `ctx.ui` modals still behave on top of the native dialog.
 * Does not own: the pure rules (tools/test-kit.js covers kit/ui/logic.js) or game smoke (tools/smoke.js).
 *
 *   bun tools/test-ui.js                 run every check (one browser; waits for a machine-wide slot)
 *   bun tools/test-ui.js --shots <dir>   also save screenshots of the states it passes through
 *
 * Exit code 1 when any check fails. A check prints `ok` or `FAIL` with what was seen.
 */
'use strict';

const path = require('path');
const { openArcade } = require('./dev/browser');
const { touchDrag, explainDrag, MENU_SCROLLER } = require('./touch-scroll');

/** Smallest acceptable size of anything a finger presses, CSS pixels (kit/ui token --ui-hit). */
const MIN_HIT_PX = 44;
/** Real milliseconds for a click's effects (a re-render, a dialog opening) to land on a loaded machine. */
const SETTLE_MS = 250;

const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;

const failures = [];
let checkCount = 0;
/** Records one check. */
const check = (name, passed, seen = '') => {
  checkCount += 1;
  if (!passed) failures.push(name);
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${passed || seen === '' ? '' : ' (saw: ' + JSON.stringify(seen) + ')'}`);
};

async function main() {
  const session = await openArcade({ landscape: args.includes('--landscape') });
  const { page } = session;
  const settle = () => page.waitForTimeout(SETTLE_MS);
  const shot = async (name) => shotsDir && page.screenshot({ path: path.join(shotsDir, name + '.png') });
  /** Presses an element through the DOM (works for anything not hidden, wherever layout put it), then settles. */
  const press = async (selector) => {
    const found = await page.evaluate((query) => {
      const element = document.querySelector(query);
      if (element) element.click();
      return Boolean(element);
    }, selector);
    await settle();
    return found;
  };
  const read = (expression) => page.evaluate(expression);
  /** Checks a finger drag scrolls (or, with `expected` false, does not scroll) an element. */
  const checkDrag = async (name, selector, expected = true) => {
    const report = await touchDrag(page, selector);
    const failure = explainDrag(selector, report);
    check(name, (failure === null) === expected, failure || report);
    return report;
  };

  // ---- menu ----
  await shot('menu');
  await checkDrag('menu: the list of games scrolls under a finger', MENU_SCROLLER);
  const menuFacts = await read(`(() => {
    const cards = [...document.querySelectorAll('#cards .ui-card')];
    const tagline = cards[0] && cards[0].querySelector('.ui-card-body span');
    return { count: cards.length, listed: Kit.games.length, shortest: Math.min(...cards.map((card) => card.getBoundingClientRect().height)),
      taglineShown: Boolean(tagline && tagline.getBoundingClientRect().height > 0), gallery: Boolean(document.getElementById('card-gallery')), pageScroll: document.scrollingElement.scrollHeight - innerHeight };
  })()`);
  check('menu: one card per registered entry, the gallery among them', menuFacts.count === menuFacts.listed && menuFacts.gallery, menuFacts);
  check('menu: every card shows its tagline and is at least 44px tall', menuFacts.taglineShown && menuFacts.shortest >= MIN_HIT_PX, menuFacts);
  check('menu: the page itself does not scroll (one screen)', menuFacts.pageScroll <= 0, menuFacts.pageScroll);
  await page.fill('#menu-search', 'zzzz-no-such-game');
  await settle();
  check('menu: a search with no match shows the empty state', await read(`Boolean(document.querySelector('#menu-list .ui-empty')) && !document.querySelector('#cards')`));
  await press('#menu-list .ui-empty button');
  await page.fill('#menu-search', (await read(`Kit.games[0].name`)).slice(0, 4));
  await settle();
  const filtered = await read(`document.querySelectorAll('#cards .ui-card').length`);
  check('menu: search narrows the list', filtered >= 1 && filtered < menuFacts.count, filtered);
  await page.fill('#menu-search', '');
  await settle();

  // ---- gallery ----
  await press('#open-gallery');
  await page.waitForTimeout(700);
  check('gallery: opens from the menu footer', await read(`Kit.current && Kit.current.def.id === 'gallery' && Boolean(document.getElementById('gallery-scroll'))`));
  await shot('gallery-top');

  // scroll pane
  const paneStart = await read(`(() => { const pane = document.getElementById('gallery-pane'); return { after: pane.hasAttribute('data-more-after'), before: pane.hasAttribute('data-more-before'), tab: pane.tabIndex }; })()`);
  check('scroll pane: fades its far edge and takes keyboard focus when it overflows', paneStart.after && !paneStart.before && paneStart.tab === 0, paneStart);
  const outerBefore = await read(`document.getElementById('gallery-scroll').scrollTop`);
  await checkDrag('scroll pane: scrolls under a finger', '#gallery-pane');
  check('scroll pane: a drag inside does not move the pane around it', (await read(`document.getElementById('gallery-scroll').scrollTop`)) === outerBefore);
  check('scroll pane: the live readout followed the scroll', /Scrolled [1-9]/.test(await read(`document.querySelector('.gallery-demo .ui-label').textContent`)));
  await read(`(() => { const pane = document.getElementById('gallery-pane'); pane.scrollTop = pane.scrollHeight; })()`);
  await settle();
  const paneEnd = await read(`(() => { const pane = document.getElementById('gallery-pane'); return { after: pane.hasAttribute('data-more-after'), before: pane.hasAttribute('data-more-before') }; })()`);
  check('scroll pane: at the end the fade moves to the near edge', paneEnd.before && !paneEnd.after, paneEnd);
  await read(`(() => { const pane = document.getElementById('gallery-pane'); pane.scrollTop = 0; pane.focus(); })()`);
  await page.keyboard.press('PageDown');
  await settle();
  check('scroll pane: the keyboard scrolls it', (await read(`document.getElementById('gallery-pane').scrollTop`)) > 0);
  await checkDrag('scroll pane: the gallery page scrolls under a finger', '#gallery-scroll');
  await read(`document.getElementById('gallery-scroll').scrollTop = 0`);

  // hit targets (controls inside a closed dialog have no box and are skipped)
  const small = await read(`[...document.querySelectorAll('.gallery button, .gallery [role="tab"], .gallery [role="option"], .gallery .ui-input, .gallery .ui-toggle, .gallery input[type="range"]')]
    .map((element) => ({ what: (element.id || element.textContent.trim().slice(0, 20) || element.className), height: Math.round(element.getBoundingClientRect().height), width: Math.round(element.getBoundingClientRect().width) }))
    .filter((box) => box.height + box.width > 0 && (box.height < ${MIN_HIT_PX} || box.width < ${MIN_HIT_PX}))`);
  check('every control in the gallery is at least 44px in both directions', small.length === 0, small);

  // buttons
  await press('#gallery-toggle');
  check('button: a toggle reports pressed', (await read(`document.getElementById('gallery-toggle').getAttribute('aria-pressed')`)) === 'true');
  await press('#gallery-busy');
  check('button: busy is announced and shown', (await read(`document.getElementById('gallery-busy').getAttribute('aria-busy')`)) === 'true');

  // meters bound to signals
  const meterNow = `document.querySelector('.gallery [role="meter"]').getAttribute('aria-valuenow')`;
  const firstLevel = await read(meterNow);
  await page.waitForTimeout(900);
  check('meter: follows its signal while the game runs', (await read(meterNow)) !== firstLevel, firstLevel);
  await press('#gallery-animate');
  const heldLevel = await read(meterNow);
  await page.waitForTimeout(500);
  check('toggle: switching the animation off holds the meter still', (await read(meterNow)) === heldLevel);

  // dialog: focus trap, Escape, return focus
  await read(`document.getElementById('open-dialog').focus()`);
  await press('#open-dialog');
  check('dialog: opens as a modal with focus inside', await read(`(() => { const dialog = document.querySelector('.ui-dialog[open]'); return Boolean(dialog) && dialog.matches(':modal') && dialog.contains(document.activeElement); })()`));
  await shot('dialog');
  for (let presses = 0; presses < 6; presses++) await page.keyboard.press('Tab');
  check('dialog: Tab cannot leave it', await read(`document.querySelector('.ui-dialog[open]').contains(document.activeElement)`));
  await page.keyboard.press('Escape');
  await settle();
  check('dialog: Escape closes it and focus returns to the opener', await read(`!document.querySelector('.ui-dialog[open]') && document.activeElement.id === 'open-dialog'`), await read(`document.activeElement.id`));
  check('dialog: a dismissal is reported', (await read(`document.getElementById('gallery-answer').textContent`)).includes('dismissed'));
  await press('#open-required');
  await page.keyboard.press('Escape');
  await settle();
  check('dialog: one that needs an answer ignores Escape', await read(`Boolean(document.querySelector('.ui-dialog[open]'))`));
  await press('.ui-dialog[open] footer button');
  check('dialog: the answer reaches the caller', (await read(`document.getElementById('gallery-answer').textContent`)).includes('left') && !(await read(`Boolean(document.querySelector('.ui-dialog[open]'))`)));
  await press('#open-sheet');
  await page.waitForTimeout(400);
  const sheetBox = await read(`(() => { const card = document.querySelector('.ui-dialog[open] .ui-dialog-card').getBoundingClientRect(); return { bottom: Math.round(card.bottom), viewport: innerHeight, top: Math.round(card.top) }; })()`);
  check('sheet: sits on the bottom edge and leaves the top of the screen free', sheetBox.bottom === sheetBox.viewport && sheetBox.top > 0, sheetBox);
  await checkDrag('sheet: its body scrolls under a finger', '.ui-dialog[open] .ui-dialog-body');
  await shot('sheet');
  await page.keyboard.press('Escape');
  await settle();

  // tabs
  await read(`document.querySelector('.gallery [role="tab"][aria-selected="true"]').focus()`);
  await page.keyboard.press('ArrowRight');
  await settle();
  const secondTab = await read(`document.querySelector('.gallery [role="tab"][aria-selected="true"]').textContent.trim()`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await settle();
  const wrappedTab = await read(`document.querySelector('.gallery [role="tab"][aria-selected="true"]').textContent.trim()`);
  check('tabs: arrow keys move, skip the disabled tab and wrap', secondTab === 'Gear' && wrappedTab === 'Bag', [secondTab, wrappedTab]);
  check('tabs: the panel shows the selected tab', await read(`Boolean(document.querySelector('.gallery [role="tabpanel"] .ui-empty'))`));

  // list and grid
  const options = `[...document.querySelectorAll('.gallery [aria-label="Ore"] [role="option"]')]`;
  await read(`${options}[1].click()`);
  await settle();
  await read(`${options}[2].click()`);
  await settle();
  check('list: a click selects; a disabled item cannot be selected', (await read(`${options}.map((option) => option.getAttribute('aria-selected')).join()`)) === 'false,true,false,false');
  await read(`${options}[1].focus()`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settle();
  check('list: arrows skip the disabled item and Enter selects', (await read(`${options}.map((option) => option.getAttribute('aria-selected')).join()`)) === 'false,false,false,true');
  await read(`document.querySelectorAll('.gallery [aria-label="Seeds"] [role="option"]')[1].click()`);
  await settle();
  check('grid: multiple selection adds to the selection', (await read(`document.querySelectorAll('.gallery [aria-label="Seeds"] [aria-selected="true"]').length`)) === 3);

  // toasts and banners
  await press('.gallery-section:nth-of-type(7) .ui-cluster button:nth-child(2)');
  check('toasts: a burst of five shows three and queues the rest', (await read(`document.querySelectorAll('.ui-toast').length`)) === 3, await read(`document.querySelectorAll('.ui-toast').length`));
  await shot('toasts');
  await press('#gallery-banner');
  await press('#gallery-banner');
  check('banners: one at a time', (await read(`document.querySelectorAll('.ui-banner').length`)) === 1);
  await press('.ui-banner button:last-child');
  check('banners: dismissing one shows the next', (await read(`document.querySelectorAll('.ui-banner').length`)) === 1);
  await press('.ui-banner button:last-child');
  check('banners: the queue empties', (await read(`document.querySelectorAll('.ui-banner').length`)) === 0);

  // popover
  await read(`document.querySelector('.gallery [popovertarget]').scrollIntoView({ block: 'center' })`);
  await page.click('.gallery [popovertarget]');
  await settle();
  const popoverBox = await read(`(() => { const panel = document.querySelector('.ui-popover:popover-open'); if (!panel) return null; const box = panel.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }; })()`);
  check('popover: opens on screen next to its button', Boolean(popoverBox) && popoverBox.left >= 0 && popoverBox.right <= popoverBox.width && popoverBox.top >= 0 && popoverBox.bottom <= popoverBox.height, popoverBox);
  await shot('popover');
  await page.keyboard.press('Escape');
  await settle();
  check('popover: Escape closes it', !(await read(`Boolean(document.querySelector('.ui-popover:popover-open'))`)));

  // fields
  await page.fill('#gallery-name', '');
  await settle();
  check('text field: an error marks the field and is described', await read(`(() => { const input = document.getElementById('gallery-name'); const note = document.getElementById(input.getAttribute('aria-describedby')); return input.getAttribute('aria-invalid') === 'true' && Boolean(note) && note.textContent.includes('name'); })()`));
  await page.fill('#gallery-name', 'Wren');
  const volumeBefore = await read(`document.querySelector('output[for="gallery-volume"]').textContent`);
  await read(`document.getElementById('gallery-volume').focus()`);
  await page.keyboard.press('ArrowRight');
  await settle();
  check('slider: the keyboard moves it and the readout follows', (await read(`document.querySelector('output[for="gallery-volume"]').textContent`)) !== volumeBefore, volumeBefore);

  // skins and reduced motion
  await press('#skin-paper');
  check('skins: the switcher re-themes the page', (await read(`document.body.dataset.skin`)) === 'paper' && (await read(`document.getElementById('skin-paper').getAttribute('aria-pressed')`)) === 'true');
  await shot('gallery-paper');
  await press('#skin-neon');
  await shot('gallery-neon');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('reduced motion: transitions are switched off', (await read(`getComputedStyle(document.documentElement).getPropertyValue('--ui-speed').trim()`)) === '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ---- legacy ctx.ui on the native dialog ----
  await read(`(window.__panelResult = 'open', Kit.current.ui.panel({ title: 'Legacy sheet', build: (body) => { for (let row = 0; row < 40; row++) body.append(Kit.ui.h('div', 'rows', 'Row ' + row)); } }).then((value) => (window.__panelResult = value === undefined ? 'closed' : value)), true)`);
  await settle();
  check('ui.panel: opens in the native modal, pauses the game, focus on the card', await read(`(() => { const modal = document.getElementById('modal'); return modal.matches(':modal') && !modal.hidden && Kit.current.paused && document.activeElement.classList.contains('modal-card'); })()`));
  await checkDrag('ui.panel: the sheet body scrolls under a finger', '#modal .sheet-body');
  await shot('legacy-panel');
  await page.keyboard.press('Escape');
  await settle();
  check('ui.panel: Escape closes it and the game resumes', await read(`window.__panelResult === 'closed' && document.getElementById('modal').hidden && !Kit.current.paused`), await read(`window.__panelResult`));
  await read(`(window.__choice = 'open', Kit.current.ui.choose({ title: 'Legacy choice', options: [{ title: 'First' }, { title: 'Second' }] }).then((index) => (window.__choice = index)), true)`);
  await settle();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await settle();
  check('ui.choose: Escape and a held game key do not answer it', (await read(`window.__choice`)) === 'open');
  await press('#modal .choice:nth-of-type(2)');
  check('ui.choose: a pick resolves with its index', (await read(`window.__choice`)) === 1);

  // ---- leaving ----
  await read(`Kit.ui.notify('left behind'); Kit.current.ui.dialog({ title: 'Left open' }); true`);
  await settle();
  await press('#back');
  await page.waitForTimeout(500);
  check('leaving a game closes its dialogs and notices and returns to the menu', await read(`!document.getElementById('menu').hidden && !document.querySelector('dialog[open]') && !document.querySelector('.ui-toast')`));

  check('no page errors', session.errors.length === 0, session.errors);
  await session.close();
  console.log(failures.length ? `FAILED: ${failures.length} of ${checkCount} checks` : `${checkCount} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
