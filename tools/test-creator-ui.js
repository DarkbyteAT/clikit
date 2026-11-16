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
/** How long a one-shot performance may take to hand back to idling: the page's clock runs on drawn frames, so a loaded machine plays it slower than the wall clock. */
const HANDBACK_DEADLINE_MS = 20000;
/** How often a waited-for state is read. */
const POLL_MS = 100;
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

/** The middle value of a list of numbers. */
const median = (values) => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

/** Adds up control kinds over groups: `{ head: { dial: 6 }, hair: { socket: 2 } }` -> `{ dial: 6, socket: 2 }`. */
const totalKinds = (kindsByGroup) =>
  Object.values(kindsByGroup)
    .flatMap((counts) => Object.entries(counts))
    .reduce((totals, [kind, count]) => Object.assign(totals, { [kind]: (totals[kind] || 0) + count }), {});

/** Real finger gestures on the stage: a one-finger drag turns the character, a two-finger spread zooms in, Home resets the view. */
async function fingerGestures({ page, press, state, settle, read }) {
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const yawBefore = (await state()).camera.yaw;
  const stageBox = await read(
    `(() => { const rect = document.getElementById('cr-view').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.55, w: rect.width }; })()`
  );
  const devtools = await page.context().newCDPSession(page);
  const touch = (type, points) => devtools.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ x: stageBox.x - 60, y: stageBox.y }]);
  for (let step = 1; step <= 6; step++) {
    await touch('touchMove', [{ x: stageBox.x - 60 + step * 20, y: stageBox.y }]);
    await page.waitForTimeout(20);
  }
  await touch('touchEnd', []);
  await settle(200);
  const yawAfter = (await state()).camera.yaw;
  check('touch: a one-finger drag across the stage turns the character', Math.abs(yawAfter - yawBefore) > 0.5, { yawBefore, yawAfter });
  const spanBefore = (await state()).cameraTarget.span;
  await touch('touchStart', [
    { x: stageBox.x - 20, y: stageBox.y },
    { x: stageBox.x + 20, y: stageBox.y },
  ]);
  for (let step = 1; step <= 6; step++) {
    await touch('touchMove', [
      { x: stageBox.x - 20 - step * 12, y: stageBox.y },
      { x: stageBox.x + 20 + step * 12, y: stageBox.y },
    ]);
    await page.waitForTimeout(20);
  }
  await touch('touchEnd', []);
  await settle(200);
  const spanAfter = (await state()).cameraTarget.span;
  check('touch: spreading two fingers zooms in', spanAfter < spanBefore * 0.8, { spanBefore, spanAfter });
  await read(`document.getElementById('cr-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
  await settle(200);
  check('keyboard: Home on the stage puts the view back to the whole body, facing front', (await state()).cameraTarget.span === 1);
}

async function main() {
  const session = await openArcade({ landscape: isLandscape });
  const { page } = session;
  const settle = (ms = SETTLE_MS) => page.waitForTimeout(ms);
  const read = (expression) => page.evaluate(expression);
  /** Waits until `isTrue()` holds, reading it every `POLL_MS`; false when `deadlineMs` passes first. */
  const until = async (isTrue, deadlineMs) => {
    for (let waited = 0; waited < deadlineMs; waited += POLL_MS) {
      if (await isTrue()) return true;
      await settle(POLL_MS);
    }
    return isTrue();
  };
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
  check(
    'creator: registered in the menu as "Character Maker" and running',
    await read(`Kit.current && Kit.current.def.id === 'creator' && Kit.games.find((game) => game.id === 'creator').name === 'Character Maker'`)
  );
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
  check(
    'tabs: Character first, then one per group of the schema, in order',
    JSON.stringify(structure.tabs.slice(1)) === JSON.stringify(structure.schemaGroups) && /Character/.test(structure.tabs[0]),
    structure
  );
  check(
    'layout: stage and panel side by side in landscape, stacked in portrait',
    isLandscape ? structure.stage[2] > 0 && structure.panel[0] >= structure.stage[2] - 2 : structure.panel[1] >= structure.stage[3] - 2,
    structure
  );
  check('layout: the page itself does not scroll', structure.pageScroll <= 0, structure.pageScroll);

  // ---- each tab: counts, a shot, and the nodes it costs ----
  const groupIds = await read(`Kit.currentGame.session.schema().groups.map((group) => group.id)`);
  const nodeCounts = {};
  const kinds = {};
  for (const id of groupIds) {
    await read(
      `(() => { const tab = [...document.querySelectorAll('.cr-panel [role=tab]')].find((candidate) => candidate.textContent.trim() === Kit.currentGame.session.schema().groups.find((group) => group.id === ${JSON.stringify(id)}).label); tab.click(); })()`
    );
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
  const withKinds = totalKinds(kinds);
  check('controls: sliders, swatch rows and option strips are all generated', withKinds.dial > 20 && withKinds.color > 5 && withKinds.socket > 8, withKinds);

  // ---- an option strip shows its checked card ----
  await press('.cr-panel [role=tab]:nth-of-type(8)');
  const hidden = await read(
    `[...document.querySelectorAll('#cr-pane .cr-strip')].map((strip) => { const card = strip.querySelector('[aria-checked=true]').getBoundingClientRect(); const box = strip.closest('.ui-scroll').getBoundingClientRect(); return card.left >= box.left - 1 && card.right <= box.right + 1; }).filter((isVisible) => !isVisible).length`
  );
  check('option strips: the checked card of every strip is fully in view', hidden === 0, hidden);

  // ---- camera follows the group ----
  await press('.cr-panel [role=tab]:nth-of-type(3)');
  const faceTarget = await read(`Kit.currentGame.debugState().cameraTarget`);
  await press('.cr-panel [role=tab]:nth-of-type(6)');
  const legsTarget = await read(`Kit.currentGame.debugState().cameraTarget`);
  check('camera: choosing Face looks at the head, Legs looks lower, both closer than the whole body', faceTarget.anchor > legsTarget.anchor + 0.3 && faceTarget.span < 1 && legsTarget.span < 1, {
    faceTarget,
    legsTarget,
  });
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
  report.sliderToFigure = {
    flushMs_last: timings[timings.length - 1].flushMs,
    inputToApplyMs_median: median(inputToApply),
    inputToApplyMs_max: Math.max(...inputToApply),
    applyMs_median: median(applyOnly),
    applyMs_max: Math.max(...applyOnly),
    inputs: LATENCY_INPUTS,
    wallToTwoFramesMs_median: median(timings.map((entry) => entry.wallMs)),
  };
  check('slider: dragging changes the recipe and the figure draws the new one', JSON.stringify(afterSlider.recipe) !== JSON.stringify(before.recipe) && afterSlider.drawnIsCurrent, {
    applied: afterSlider.measurement.applied,
  });
  await press('#cr-undo');
  const undone = await state();
  check('undo: one press takes the whole drag back', JSON.stringify(undone.recipe) === JSON.stringify(before.recipe), undone.recipe);
  await press('#cr-redo');
  check('redo: puts it back', JSON.stringify((await state()).recipe) === JSON.stringify(afterSlider.recipe));
  await press('#cr-pane .cr-dial .cr-tool');
  check(
    'reset button: puts the slider back to its default (and undo remains)',
    await read(
      `(() => { const slider = document.querySelector('#cr-pane .cr-dial input[type=range]'); const output = document.querySelector('#cr-pane .cr-dial output'); return output.textContent.length > 0 && Kit.currentGame.session.canUndo(); })()`
    )
  );

  // A slider held mid-drag, with the real mouse, for the screenshot.
  const box = await read(
    `(() => { const rect = document.querySelector('#cr-pane .cr-dial input[type=range]').getBoundingClientRect(); return { x: rect.left, y: rect.top + rect.height / 2, w: rect.width }; })()`
  );
  await page.mouse.move(box.x + box.w * 0.4, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.8, box.y, { steps: 6 });
  await settle(500);
  await shot('slider-mid-drag');
  await page.mouse.up();
  await settle(300);

  // Double tap on a moved slider puts it back to its default.
  await read(
    `(() => { const input = document.querySelector('#cr-pane .cr-dial input[type=range]'); input.value = String(Number(input.min) + (Number(input.max) - Number(input.min)) * 0.85); input.dispatchEvent(new Event('input', { bubbles: true })); })()`
  );
  await frames();
  await frames();
  const movedByDrag = await read(`document.querySelector('#cr-pane .cr-dial output').textContent`);
  await page.evaluate(() => {
    const wrapper = document.querySelector('#cr-pane .cr-dial .cr-slider');
    const rect = wrapper.getBoundingClientRect();
    const tap = (type) => wrapper.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, clientX: rect.left + 20, clientY: rect.top + 30 }));
    ['pointerdown', 'pointerup', 'pointerdown', 'pointerup'].forEach(tap);
  });
  await settle(300);
  const afterDoubleTap = await read(`(() => {
    const rowId = document.querySelector('#cr-pane .cr-dial').dataset.row;
    const row = Kit.currentGame.session.groups().flatMap((group) => group.rows).find((candidate) => candidate.id === rowId);
    const slider = row.sliders[0];
    const value = Kit.currentGame.session.schema().dials.find((dial) => dial.key === slider.valueKey).value;
    return { readout: document.querySelector('#cr-pane .cr-dial output').textContent, atDefault: Math.abs(value - slider.default) <= slider.step };
  })()`);
  check('double tap: a slider that was moved goes back to its default', movedByDrag !== afterDoubleTap.readout && afterDoubleTap.atDefault, { movedByDrag, afterDoubleTap });

  // ---- randomise, lock, compare ----
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const lockedValue = await read(`(() => {
    const row = Kit.currentGame.session.groups().flatMap((group) => group.rows).find((candidate) => candidate.id === 'color:skin');
    return { row: row.id, value: Kit.currentGame.session.schema().colors.find((color) => color.id === 'skin').value };
  })()`);
  await press('.cr-panel [role=tab]:nth-of-type(11)');
  const lockButton = await read(
    `(() => { const row = document.querySelector('[data-row="color:skin"]'); const button = row && [...row.querySelectorAll('button')].find((candidate) => /^Keep/.test(candidate.getAttribute('aria-label'))); if (button) button.click(); return Boolean(button); })()`
  );
  await settle(300);
  check(
    'lock: a colour row has a lock button, and pressing it marks it pressed',
    lockButton && (await read(`document.querySelector('[data-row="color:skin"] [aria-label^="Keep"]').getAttribute('aria-pressed')`)) === 'true'
  );
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  const firstRecipe = (await state()).recipe;
  for (let roll = 0; roll < 4; roll++) await press('#cr-randomize-all');
  const rolled = await state();
  const skinNow = await read(`Kit.currentGame.session.schema().colors.find((color) => color.id === 'skin').value`);
  check('randomise all: changes the character and keeps the locked skin', JSON.stringify(rolled.recipe) !== JSON.stringify(firstRecipe) && skinNow === lockedValue.value, {
    skinNow,
    locked: lockedValue.value,
  });
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
  // The character is never frozen: it idles until a performance is picked, and a one-shot hands back to idling.
  const standing = await state();
  check('performance: the character idles by default', standing.performance === 'idle', standing.performance);
  await press('#cr-perform');
  const offered = await read(`[...document.querySelectorAll('#cr-perform-list [role="option"]')].map((option) => option.textContent.trim())`);
  check(
    'performance picker: opens a list that starts with idle, walk and run and goes on to the repertoire',
    offered.length > 8 && /^Idle/.test(offered[0]) && /^Walk/.test(offered[1]) && /^Run/.test(offered[2]),
    offered
  );
  await press('#cr-perform-walk');
  await settle(900);
  check(
    'performance picker: picking walk starts a walk without errors and closes the list',
    (await state()).performance === 'walk' && session.errors.length === 0 && !(await read(`document.getElementById('cr-perform-list').matches(':popover-open')`)),
    session.errors
  );
  await shot('walking');
  await press('#cr-perform');
  await press('#cr-perform-wave');
  await settle(700);
  check('performance picker: a one-shot plays over what the character was doing', (await state()).performance === 'wave' && session.errors.length === 0, session.errors);
  await shot('waving');
  const handedBack = await until(async () => (await state()).performance === 'idle', HANDBACK_DEADLINE_MS);
  check('performance picker: when the one-shot is over the character idles again', handedBack, (await state()).performance);

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
  check(
    'saves: two characters are listed with colours and a body type',
    saved.length === 2 && /Test Hero/.test(saved.join()) && (await read(`document.querySelectorAll('dialog[open] .cr-chips i').length`)) === 8,
    saved
  );
  await shot('saves-two');
  await read(`document.querySelector('dialog[open] .cr-slot-open').click()`);
  await settle();
  check(
    'saves: Open loads the character and closes the sheet',
    !(await read(`Boolean(document.querySelector('dialog[open]'))`)) && /Test Hero|Second one/.test((await state()).name),
    (await state()).name
  );
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

  await fingerGestures({ page, press, state, settle, read });

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
  const focusRing = await read(
    `(() => { const style = getComputedStyle(document.activeElement); return { tag: document.activeElement.tagName, outline: style.outlineStyle + ' ' + style.outlineWidth }; })()`
  );
  check('keyboard: the focused control shows a focus ring', !/^none/.test(focusRing.outline), focusRing);
  await page.keyboard.press('Home');

  // ---- setup tab lower down, and the look settings ----
  await press('.cr-panel [role=tab]:nth-of-type(1)');
  report.nodesSetupTab = await read(`document.getElementById('cr-panel').querySelectorAll('*').length`);
  await read(`document.getElementById('cr-pane').scrollTop = 99999`);
  await settle(300);
  await shot('setup-bottom');
  await read(`document.getElementById('cr-look-details').open = true; document.getElementById('cr-pane').scrollTop = 99999`);
  await settle(400);
  await shot('setup-look-settings');

  // ---- reduced motion: the camera jumps instead of easing ----
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await press('.cr-panel [role=tab]:nth-of-type(6)');
  const reduced = await state();
  check(
    'reduced motion: the camera is at its target one moment after choosing a group (no easing)',
    Math.abs(reduced.camera.span - reduced.cameraTarget.span) < 1e-6 && Math.abs(reduced.camera.anchor - reduced.cameraTarget.anchor) < 1e-6,
    reduced
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });

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

  // ---- leaving and coming back keeps the character ----
  const lastSeen = await state();
  await press('#back');
  await settle(600);
  await session.launchGame('creator');
  await settle(1200);
  const returned = await state();
  check(
    'draft: leaving to the menu and coming back restores the character, its name and its look',
    JSON.stringify(returned.recipe) === JSON.stringify(lastSeen.recipe) && returned.name === lastSeen.name && returned.preset === lastSeen.preset,
    { lastSeen: lastSeen.name, returned: returned.name }
  );

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
