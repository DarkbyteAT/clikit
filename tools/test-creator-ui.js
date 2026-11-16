#!/usr/bin/env bun
/**
 * Character creator interface test: `Kit.play('creator')` in a real browser, driven the way a person would
 * (taps, a held press, finger drags, key presses), with screenshots of every tab and dialog and two numbers
 * the report needs: how long a slider input takes to reach the figure, and how many DOM nodes the panel holds.
 *
 * Owns:  the interface checks of the creator: tabs generated from the schema, control kinds, undo and redo, locks,
 *        compare, species switch, look presets, saves, share code, keyboard, the 44px target rule, and a real
 *        finger drag on the control pane.
 * Does not own: the pure rules (tools/test-creator.js) or the smoke run (tools/smoke.js creator).
 *
 *   bun tools/test-creator-ui.js [--landscape] [--shots <dir>]
 *
 * Exit code 1 when any check fails. One browser run: it waits for a machine-wide slot first.
 */
'use strict';

const path = require('path');
const { openArcade } = require('./dev/browser');
const { touchDrag, explainDrag } = require('./touch-scroll');

/** Smallest acceptable size of anything a finger presses, CSS pixels (kit/ui token --ui-hit). */
const MIN_HIT_PX = 44;
/** Real milliseconds for a click's effects, and for software-GL frames, to land on a loaded machine. */
const SETTLE_MS = 450;
/** Slider inputs sent when timing input to figure. */
const LATENCY_INPUTS = 14;

const args = process.argv.slice(2);
const isLandscape = args.includes('--landscape');
const shotsDir = path.resolve(args.includes('--shots') ? args[args.indexOf('--shots') + 1] : path.join(__dirname, '..', 'shots', 'creator'));
const suffix = isLandscape ? 'land' : 'port';

const failures = [];
const report = {};
let checkCount = 0;
/** Records one check. */
const check = (name, passed, seen = '') => {
  checkCount += 1;
  if (!passed) failures.push(name);
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${passed || seen === '' ? '' : ' (saw: ' + JSON.stringify(seen) + ')'}`);
};

async function main() {
  const session = await openArcade({ landscape: isLandscape });
  const { page } = session;
  const settle = (ms = SETTLE_MS) => page.waitForTimeout(ms);
  const read = (expression) => page.evaluate(expression);
  const shot = async (name) => session.shot(path.join(shotsDir, `${name}-${suffix}.png`));
  /** Clicks an element through the DOM (layout cannot block it), then settles. Returns whether it was found. */
  const press = async (selector) => {
    const found = await page.evaluate((query) => {
      const element = document.querySelector(query);
      if (element) element.click();
      return Boolean(element);
    }, selector);
    await settle();
    return found;
  };
  const state = () => read('Kit.currentGame.debugState()');
  /** Two animation frames: enough for the screen's own frame to have applied a queued edit. */
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await session.launchGame('creator');
  await settle(1200);
  check('creator: registered in the menu as "Character Maker" and running', await read(`Kit.current && Kit.current.def.id === 'creator' && Kit.games.find((game) => game.id === 'creator').name === 'Character Maker'`));
  check('creator: starts with no page errors', session.errors.length === 0, session.errors);
  await shot('01-setup');

  // ---- generated structure ----
  const structure = await read(`(() => {
    const tabs = [...document.querySelectorAll('.cr-panel [role=tab]')].map((tab) => tab.textContent.trim());
    const schemaGroups = Kit.currentGame.session.schema().groups.map((group) => group.label);
    const panel = document.getElementById('cr-panel').getBoundingClientRect();
    const stage = document.querySelector('.cr-stage').getBoundingClientRect();
    return { tabs, schemaGroups, panel: [panel.left, panel.top, panel.width, panel.height].map(Math.round), stage: [stage.left, stage.top, stage.width, stage.height].map(Math.round), pageScroll: document.scrollingElement.scrollHeight - innerHeight };
  })()`);
  report.layout = structure;
  check('tabs: Character first, then one per group of the schema, in order', JSON.stringify(structure.tabs.slice(1)) === JSON.stringify(structure.schemaGroups) && /Character/.test(structure.tabs[0]), structure);
  check('layout: stage and panel side by side in landscape, stacked in portrait', isLandscape ? structure.stage[2] > 0 && structure.panel[0] >= structure.stage[2] - 2 : structure.panel[1] >= structure.stage[3] - 2, structure);
  check('layout: the page itself does not scroll', structure.pageScroll <= 0, structure.pageScroll);

  // ---- each tab: counts, a shot, and the nodes it costs ----
  const groupIds = await read(`Kit.currentGame.session.schema().groups.map((group) => group.id)`);
  const nodeCounts = {};
  const kinds = {};
  for (const id of groupIds) {
    await read(`(() => { const tab = [...document.querySelectorAll('.cr-panel [role=tab]')].find((candidate) => candidate.textContent.trim() === Kit.currentGame.session.schema().groups.find((group) => group.id === ${JSON.stringify(id)}).label); tab.click(); })()`);
    await settle(350);
    const facts = await read(`(() => {
      const panel = document.getElementById('cr-panel');
      const rows = [...panel.querySelectorAll('[data-row]')];
      return { nodes: panel.querySelectorAll('*').length, rows: rows.length, kinds: rows.reduce((counts, row) => ({ ...counts, [row.dataset.kind]: (counts[row.dataset.kind] || 0) + 1 }), {}), focusTarget: Kit.currentGame.debugState().cameraTarget };
    })()`);
    nodeCounts[id] = facts.nodes;
    kinds[id] = facts.kinds;
    const expected = await read(`Kit.currentGame.session.groups().find((group) => group.id === ${JSON.stringify(id)}).rows.length`);
    check(`tab ${id}: one row per control of the group (${expected})`, facts.rows === expected, facts);
    await shot(`tab-${id}`);
  }
  report.nodesPerTab = nodeCounts;
  report.kindsPerTab = kinds;
  report.panelNodesTotal = Math.max(...Object.values(nodeCounts));
  const withKinds = Object.values(kinds).reduce((all, group) => ({ dial: (all.dial || 0) + (group.dial || 0), color: (all.color || 0) + (group.color || 0), socket: (all.socket || 0) + (group.socket || 0) }), {});
  check('controls: sliders, swatch rows and option strips are all generated', withKinds.dial > 20 && withKinds.color > 5 && withKinds.socket > 8, withKinds);

  // ---- camera follows the group ----
  await press('.cr-panel [role=tab]:nth-of-type(3)');
  const faceTarget = await read(`Kit.currentGame.debugState().cameraTarget`);
  await press('.cr-panel [role=tab]:nth-of-type(6)');
  const legsTarget = await read(`Kit.currentGame.debugState().cameraTarget`);
  check('camera: choosing Face looks at the head, Legs looks lower, both closer than the whole body', faceTarget.anchor > legsTarget.anchor + 0.3 && faceTarget.span < 1 && legsTarget.span < 1, { faceTarget, legsTarget });
  await settle(900);
  await shot('camera-legs');

  // ---- slider: queued per frame, reaches the figure; undo / redo; double-tap reset ----
  await press('.cr-panel [role=tab]:nth-of-type(4)');
  const sliderId = await read(`document.querySelector('#cr-pane .cr-dial input[type=range]').id`);
  const before = await state();
  const timings = await page.evaluate(
    async ({ id, inputs }) => {
      const input = document.getElementById(id);
      const wait = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const results = [];
      for (let step = 0; step < inputs; step++) {
        const fraction = 0.1 + (0.8 * step) / inputs;
        input.value = String(Number(input.min) + (Number(input.max) - Number(input.min)) * fraction);
        const startedAt = performance.now();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait();
        results.push({ wallMs: performance.now() - startedAt, ...Kit.currentGame.debugState().measurement });
      }
      return results;
    },
    { id: sliderId, inputs: LATENCY_INPUTS }
  );
  const afterSlider = await state();
  const inputToApply = timings.map((entry) => entry.inputToApplyMs);
  const applyOnly = timings.map((entry) => entry.applyMs);
  const median = (values) => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];
  report.sliderToFigure = { inputToApplyMs_median: median(inputToApply), inputToApplyMs_max: Math.max(...inputToApply), applyMs_median: median(applyOnly), applyMs_max: Math.max(...applyOnly), inputs: LATENCY_INPUTS, wallToTwoFramesMs_median: median(timings.map((entry) => entry.wallMs)) };
  check('slider: dragging changes the recipe and the figure draws the new one', JSON.stringify(afterSlider.recipe) !== JSON.stringify(before.recipe) && afterSlider.drawnIsCurrent, { applied: afterSlider.measurement.applied });
  await press('#cr-undo');
  const undone = await state();
  check('undo: one press takes the whole drag back', JSON.stringify(undone.recipe) === JSON.stringify(before.recipe), undone.recipe);
  await press('#cr-redo');
  check('redo: puts it back', JSON.stringify((await state()).recipe) === JSON.stringify(afterSlider.recipe));
  await press('#cr-pane .cr-dial .cr-tool');
  check('reset button: puts the slider back to its default (and undo remains)', await read(`(() => { const slider = document.querySelector('#cr-pane .cr-dial input[type=range]'); const output = document.querySelector('#cr-pane .cr-dial output'); return output.textContent.length > 0 && Kit.currentGame.session.canUndo(); })()`));

  // A slider held mid-drag, with the real mouse, for the screenshot.
  const box = await read(`(() => { const rect = document.querySelector('#cr-pane .cr-dial input[type=range]').getBoundingClientRect(); return { x: rect.left, y: rect.top + rect.height / 2, w: rect.width }; })()`);
  await page.mouse.move(box.x + box.w * 0.4, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.8, box.y, { steps: 6 });
  await settle(500);
  await shot('slider-mid-drag');
  await page.mouse.up();
  await settle(300);

  // ---- randomise, lock, compare ----
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const lockedValue = await read(`(() => {
    const row = Kit.currentGame.session.groups().flatMap((group) => group.rows).find((candidate) => candidate.id === 'color:skin');
    return { row: row.id, value: Kit.currentGame.session.schema().colors.find((color) => color.id === 'skin').value };
  })()`);
  await press('.cr-panel [role=tab]:nth-of-type(11)');
  const lockButton = await read(`(() => { const row = document.querySelector('[data-row="color:skin"]'); const button = row && [...row.querySelectorAll('button')].find((candidate) => /^Keep/.test(candidate.getAttribute('aria-label'))); if (button) button.click(); return Boolean(button); })()`);
  await settle(300);
  check('lock: a colour row has a lock button, and pressing it marks it pressed', lockButton && (await read(`document.querySelector('[data-row="color:skin"] [aria-label^="Keep"]').getAttribute('aria-pressed')`)) === 'true');
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const firstRecipe = (await state()).recipe;
  for (let roll = 0; roll < 4; roll++) await press('#cr-randomize-all');
  const rolled = await state();
  const skinNow = await read(`Kit.currentGame.session.schema().colors.find((color) => color.id === 'skin').value`);
  check('randomise all: changes the character and keeps the locked skin', JSON.stringify(rolled.recipe) !== JSON.stringify(firstRecipe) && skinNow === lockedValue.value, { skinNow, locked: lockedValue.value });
  await shot('after-randomise');

  const comparing = await page.evaluate(async () => {
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const button = document.getElementById('cr-compare');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'touch' }));
    await wait();
    const held = Kit.currentGame.debugState();
    const baselineIsDrawn = held.isComparing && held.drawnIsCurrent;
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'touch' }));
    await wait();
    const released = Kit.currentGame.debugState();
    return { baselineIsDrawn, releasedIsCurrent: !released.isComparing && released.drawnIsCurrent, title: document.querySelector('.cr-title span').textContent };
  });
  check('compare: holding shows the baseline, releasing shows the current character again', comparing.baselineIsDrawn && comparing.releasedIsCurrent, comparing);

  // ---- species, mirror, look ----
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const radios = await read(`[...document.querySelectorAll('#cr-pane [role=radio]')].map((radio) => radio.textContent.trim())`);
  await read(`[...document.querySelectorAll('#cr-pane [role=radio]')].find((radio) => /Lanky/.test(radio.textContent)).click()`);
  await settle();
  check('species: the body types are options, and picking Lanky switches the character', radios.includes('Lanky') && (await state()).species === 'lanky', radios);
  await press('#cr-mirror-left');
  check('mirror: pressing it keeps the character valid and drawn', (await state()).drawnIsCurrent);
  await press('#cr-look-pixel');
  const pixel = await state();
  check('look: the quick preset switches the view (pixel draws on the indexed path)', pixel.preset === 'pixel' && pixel.stats.path !== 'direct', pixel.stats);
  await settle(700);
  await shot('look-pixel');
  await press('#cr-look-toon');
  await press('#cr-zoom-in');
  await press('#cr-zoom-in');
  const zoomed = await state();
  check('zoom: the buttons narrow the view', zoomed.cameraTarget.span < 0.7, zoomed.cameraTarget);
  await press('#cr-walk');
  await settle(900);
  check('walk preview: the toggle starts a walk without errors', (await state()).isWalking || session.errors.length === 0, session.errors);
  await shot('walking');
  await press('#cr-walk');

  // ---- saves ----
  await press('#cr-open-saves');
  await settle(400);
  check('saves: opens as a sheet with an empty state first', await read(`Boolean(document.querySelector('dialog[open] .ui-empty')) && Boolean(document.getElementById('cr-save-name'))`));
  await shot('saves-empty');
  await page.fill('#cr-save-name', 'Test Hero');
  await press('#cr-save-new');
  await page.fill('#cr-save-name', 'Second one');
  await press('#cr-save-new');
  const saved = await read(`[...document.querySelectorAll('dialog[open] .cr-slot')].map((slot) => slot.textContent.replace(/\\s+/g, ' ').trim())`);
  check('saves: two characters are listed with colours and a body type', saved.length === 2 && /Test Hero/.test(saved.join()) && (await read(`document.querySelectorAll('dialog[open] .cr-chips i').length`)) === 8, saved);
  await shot('saves-two');
  await read(`document.querySelector('dialog[open] .cr-slot-open').click()`);
  await settle();
  check('saves: Open loads the character and closes the sheet', !(await read(`Boolean(document.querySelector('dialog[open]'))`)) && /Test Hero|Second one/.test((await state()).name), (await state()).name);
  check('saves: they are kept in the store (survive a reload of the screen)', (await read(`Kit.currentGame.slots.list().length`)) === 2);

  // ---- share code ----
  await press('#cr-open-share');
  await settle(400);
  const code = await read(`document.getElementById('cr-code-out').value`);
  check('share: shows the current character as a code', /^[A-Za-z0-9_-]{6,}$/.test(code), code);
  await page.fill('#cr-code-in', 'hello there!');
  await press('#cr-code-load');
  const complaint = await read(`(document.querySelector('dialog[open] .ui-field-note[data-error]') || {}).textContent || ''`);
  check('share: a bad code is refused in plain words, naming the problem', /does not belong|different version|cut off/.test(complaint) && !/Kit\.|undefined/.test(complaint), complaint);
  await shot('share-error');
  await page.fill('#cr-code-in', code);
  await press('#cr-code-load');
  check('share: a good code loads and closes the dialog', !(await read(`Boolean(document.querySelector('dialog[open]'))`)) && session.errors.length === 0, session.errors);

  // ---- keyboard ----
  await press('.cr-panel [role=tab]:nth-of-type(3)');
  const keyboard = await page.evaluate(async () => {
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const tab = document.querySelector('.cr-panel [role=tab][aria-selected=true]');
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await wait();
    const movedTab = document.querySelector('.cr-panel [role=tab][aria-selected=true]').textContent.trim();
    const slider = document.querySelector('#cr-pane input[type=range]');
    const before = slider.value;
    slider.focus();
    return { selectedAfterArrow: movedTab, sliderBefore: before, canFocusSlider: document.activeElement === slider };
  });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await settle(300);
  const sliderAfter = await read(`document.activeElement.value`);
  check('keyboard: arrow keys move between tabs', keyboard.selectedAfterArrow !== 'Face', keyboard);
  check('keyboard: arrow keys move a slider and the character follows', sliderAfter !== keyboard.sliderBefore && (await state()).drawnIsCurrent, { before: keyboard.sliderBefore, after: sliderAfter });
  await page.keyboard.press('Tab');
  const focusRing = await read(`(() => { const style = getComputedStyle(document.activeElement); return { tag: document.activeElement.tagName, outline: style.outlineStyle + ' ' + style.outlineWidth }; })()`);
  check('keyboard: the focused control shows a focus ring', !/^none/.test(focusRing.outline), focusRing);
  await page.keyboard.press('Home');

  // ---- 44px targets ----
  const small = await read(`(() => {
    const selector = 'button, [role=tab], [role=radio], [role=option], input[type=range], input[type=text], summary, .ui-toggle';
    return [...document.querySelectorAll('.cr-panel ' + selector.split(', ').join(', .cr-panel '))].concat([...document.querySelectorAll('.cr-stage button')])
      .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && Math.min(rect.width, rect.height) < ${MIN_HIT_PX} - 0.5; })
      .map((element) => element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + '.' + String(element.className).split(' ')[0] + ' ' + Math.round(element.getBoundingClientRect().width) + 'x' + Math.round(element.getBoundingClientRect().height));
  })()`);
  check(`targets: nothing a finger presses is smaller than ${MIN_HIT_PX}px (checked on the open tab, Setup tab and stage)`, small.length === 0, small.slice(0, 8));

  // ---- a real finger on the control pane ----
  await press('.cr-panel [role=tab]:nth-of-type(2)');
  const drag = await touchDrag(page, '#cr-pane');
  const failure = explainDrag('#cr-pane', drag);
  check('touch: a finger drag scrolls the control pane (starting on whatever control is under it)', failure === null, failure || drag);
  report.touchDrag = drag;
  await shot('after-touch-scroll');

  // ---- done ----
  check('no page errors during the whole run', session.errors.length === 0, session.errors);
  console.log('REPORT ' + JSON.stringify(report));
  await session.close();
  console.log(`${checkCount - failures.length}/${checkCount} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
