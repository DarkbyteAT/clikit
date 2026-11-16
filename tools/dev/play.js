/**
 * Dev tools playtest runner: plays a game from a short readable script, so nobody hand-writes Playwright.
 *
 * Owns:  the step language (the STEPS table: what each step means, how it is written as text or as an object,
 *        and how it runs), parsing a script into normalised steps (pure), and running them against a browser
 *        session with a pass / fail line per step.
 * Does not own: the browser (browser.js), the game's debug state (kit/dev.js `Kit.debug.state()`), or the
 *        command line (dev.js).
 *
 * A script is a list of steps. Each step is a line of text ("tap center x5") or an object ({ tap: 'center',
 * times: 5 }). Predicates are JavaScript expressions over `state` (the game's debugState()), `hud` (stat label
 * -> value), `time` (game seconds), `modal` (open modal's title or null) and `kit` (all of Kit.debug.state()).
 */
'use strict';

const path = require('path');

/** Named points, as fractions of the viewport. They sit inside the play area, clear of the HUD bands. */
const NAMED_POINTS = { center: [0.5, 0.5], left: [0.2, 0.5], right: [0.8, 0.5], top: [0.5, 0.25], bottom: [0.5, 0.75] };
/** Unit offsets of each swipe direction (screen space: y grows downward). */
const SWIPE_OFFSETS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
/** Tunables of the simulated thumb. Distances in CSS pixels, times in seconds unless named otherwise. */
const THUMB = {
  swipePixels: 90, // well past the kit's swipe threshold
  swipeMoves: 4,
  dragMovesPerLeg: 8,
  dragSeconds: 0.4,
  tapGapSeconds: 0.15, // between repeated taps: a fast but human rate
};
/** Real-time limits, in seconds. Headless game time runs slower than real time on a shared machine. */
const LIMITS = {
  untilSeconds: 60,
  chooseSeconds: 15,
  pressSeconds: 5,
  waitBaseSeconds: 15, // a wait of N game seconds may take this long plus N times the stretch below
  waitStretch: 20,
  pollMs: 100,
};
const MOST_STATE_CHARACTERS = 400;

// ---- pure helpers: points and text forms -----------------------------------------------------------------------------

/**
 * Turns a point as written in a script into pixels.
 * @param {string|number[]} spec a name ('center', 'left', 'right', 'top', 'bottom'), '0.5,0.4', or [x, y];
 *   numbers from 0 to 1 are fractions of the viewport, larger ones are pixels
 * @param {{width: number, height: number}} size the viewport
 * @returns {{x: number, y: number}} pixels
 * @throws {Error} naming the bad point and the accepted forms
 * @example resolvePoint('center', { width: 390, height: 780 }) // { x: 195, y: 390 }
 */
function resolvePoint(spec, size) {
  const pair = Array.isArray(spec) ? spec : NAMED_POINTS[spec] || String(spec).split(',').map(Number);
  const isPair = pair.length === 2 && pair.every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!isPair) throw new Error(`"${spec}" is not a point. Use ${Object.keys(NAMED_POINTS).join(' / ')}, or x,y as fractions (0.5,0.4) or pixels (195,300).`);
  const isFraction = pair.every((value) => value >= 0 && value <= 1);
  return isFraction ? { x: pair[0] * size.width, y: pair[1] * size.height } : { x: pair[0], y: pair[1] };
}

/** Is this word a number? */
const isNumeric = (word) => word !== undefined && word !== '' && Number.isFinite(Number(word));

/** Reads the points at the start of a list of words: a name is one point, two numbers are one point. Returns the points and the words left over. */
const takePoints = (words) => {
  const points = [];
  let index = 0;
  while (index < words.length) {
    if (NAMED_POINTS[words[index]]) points.push(words[index++]);
    else if (words[index].includes(',')) points.push(words[index++].split(',').map(Number));
    else if (isNumeric(words[index]) && isNumeric(words[index + 1])) points.push([Number(words[index++]), Number(words[index++])]);
    else break;
  }
  return { points, rest: words.slice(index) };
};

/** Splits the text after a verb into words. */
const wordsOf = (text) => text.split(/\s+/).filter(Boolean);

/** How many single-character edits turn one word into another (for "did you mean"). */
const editDistance = (from, to) => {
  const row = [...Array(to.length + 1).keys()];
  [...from].forEach((letter, fromIndex) => {
    let diagonal = row[0];
    row[0] = fromIndex + 1;
    [...to].forEach((other, toIndex) => {
      const substituted = diagonal + (letter === other ? 0 : 1);
      diagonal = row[toIndex + 1];
      row[toIndex + 1] = Math.min(substituted, row[toIndex] + 1, row[toIndex + 1] + 1);
    });
  });
  return row[to.length];
};

// ---- running helpers -------------------------------------------------------------------------------------------------

/** Evaluates a predicate (expression text or a function's source) in the page against the live debug state. */
const evaluateTest = (session, test) =>
  session.page.evaluate(
    ({ source, isFunction }) => {
      const kit = Kit.debug.state();
      const state = kit.state || {};
      const show = (value) => {
        try {
          return typeof value === 'string' ? value : JSON.stringify(value);
        } catch {
          return String(value);
        }
      };
      try {
        const value = isFunction
          ? new Function(`return (${source});`)()(state, kit.hud, kit)
          : new Function('state', 'hud', 'time', 'modal', 'kit', `return (${source});`)(state, kit.hud, kit.time, kit.modal, kit);
        return { passed: Boolean(value), shown: show(value), hasState: Boolean(kit.state) };
      } catch (error) {
        return { passed: false, error: error.message, hasState: Boolean(kit.state) };
      }
    },
    { source: String(test), isFunction: typeof test === 'function' }
  );

/** Explains a predicate that did not hold: its error or value, and the usual cause when the game exposes no state. */
const explainTest = (result) => {
  const outcome = result.error ? `threw "${result.error}"` : `was ${result.shown}`;
  const hint = result.hasState ? '' : ' This game returns no debugState(): add one to the object create() returns, or test hud.* instead.';
  return outcome + hint;
};

/** The kit-level debug state, for timeouts and the final report. */
const readKitState = (session) => session.page.evaluate(() => Kit.debug.state());

/** Waits for game time (not wall-clock time) to advance, so a wait means the same on a fast or a slow machine. */
async function waitGameSeconds(session, seconds) {
  const deadline = Date.now() + (LIMITS.waitBaseSeconds + seconds * LIMITS.waitStretch) * 1000;
  let elapsed = 0;
  let last = (await readKitState(session)).time;
  while (elapsed < seconds) {
    if (Date.now() > deadline) {
      const kit = await readKitState(session);
      const why = kit.modal ? `a modal is open ("${kit.modal}"): add a \`choose\` step` : kit.paused ? 'the game is paused' : 'the machine is too slow right now';
      throw new Error(`game time advanced only ${elapsed.toFixed(1)}s of ${seconds}s; ${why}.`);
    }
    await session.page.waitForTimeout(LIMITS.pollMs);
    const now = (await readKitState(session)).time;
    // A restart sets game time back to zero: count from there instead of losing the wait.
    elapsed += now >= last ? now - last : now;
    last = now;
  }
}

/** Polls an in-page action until it reports `done`, or throws its last complaint when the time is up. */
async function retryInPage(session, seconds, action, argument) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = await session.page.evaluate(action, argument);
    if (result.done) return result;
    if (Date.now() > deadline) throw new Error(result.complaint);
    await session.page.waitForTimeout(LIMITS.pollMs);
  }
}

/** In-page: clicks the HUD button whose label matches (the bottom action bar, or the back / restart chips). */
const pressInPage = (label) => {
  const wanted = label.toLowerCase();
  const chips = { back: '#back', restart: '#restart' };
  const buttons = chips[wanted] ? [document.querySelector(chips[wanted])] : [...document.querySelectorAll('#actions button, #hud-layer button')];
  const labelOf = (button) => (button.querySelector('b') || button).textContent.trim();
  const match = buttons.find((button) => labelOf(button).toLowerCase() === wanted) || buttons.find((button) => button.textContent.toLowerCase().includes(wanted));
  const available = buttons.map((button) => `"${labelOf(button)}"${button.disabled ? ' (disabled)' : ''}`).join(', ') || 'none';
  if (!match) return { done: false, complaint: `no HUD button labelled "${label}". Buttons now: ${available}.` };
  if (match.disabled) return { done: false, complaint: `the "${labelOf(match)}" button stayed disabled. Buttons now: ${available}. Wait for it with an \`until\` step.` };
  match.click();
  return { done: true };
};

/** In-page: clicks an option of the open modal, by index or by label. */
const chooseInPage = (option) => {
  const buttons = [...document.querySelectorAll('#modal:not([hidden]) button')];
  const labelOf = (button) => (button.querySelector('b') || button).textContent.trim();
  if (!buttons.length) return { done: false, complaint: `no modal opened to choose "${option}" from. Wait for it with \`until modal\`.` };
  const match = typeof option === 'number' ? buttons[option] : buttons.find((button) => button.textContent.toLowerCase().includes(String(option).toLowerCase()));
  if (!match) return { done: false, complaint: `the modal has no option "${option}". Options: ${buttons.map((button, index) => `${index} "${labelOf(button)}"`).join(', ')}.` };
  match.click();
  return { done: true };
};

// ---- the step language -----------------------------------------------------------------------------------------------

/**
 * @typedef {Object} StepKind
 * @property {string} usage the text form
 * @property {string} about one line on what the step does
 * @property {function(string): Object} fromText parses the text after the verb into the object form's fields
 * @property {function(*, Object): Object} normalize builds the step's fields from the object form (verb value, other keys)
 * @property {function(Object, Object): Promise<(string|void)>} run performs the step; may return a note for the report
 */

/** Every step a script may use, keyed by verb. Adding a step means adding a row. @type {Object<string, StepKind>} */
const STEPS = {
  tap: {
    usage: 'tap <point> [xN]',
    about: 'tap a point, N times (points: center left right top bottom, or x,y as fractions or pixels)',
    fromText: (text) => {
      const repeat = /\bx(\d+)\s*$/.exec(text);
      const { points } = takePoints(wordsOf(text.replace(/\bx\d+\s*$/, '')));
      return { tap: points[0] || 'center', times: repeat ? Number(repeat[1]) : 1 };
    },
    normalize: (at, { times = 1, every = THUMB.tapGapSeconds }) => ({ at: at === true ? 'center' : at, times, every }),
    async run(session, { at, times, every }) {
      const point = resolvePoint(at, session.size);
      for (let count = 0; count < times; count++) {
        await session.pointer.tap(point.x, point.y);
        if (count < times - 1) await session.page.waitForTimeout(every * 1000);
      }
    },
  },
  drag: {
    usage: 'drag <point> <point> [...] [in <seconds>]',
    about: 'press at the first point, move through the others, release',
    fromText: (text) => {
      const duration = /\bin\s+([\d.]+)\s*$/.exec(text);
      return { drag: takePoints(wordsOf(text.replace(/\bin\s+[\d.]+\s*$/, ''))).points, seconds: duration ? Number(duration[1]) : THUMB.dragSeconds };
    },
    normalize: (points, { seconds = THUMB.dragSeconds }) => {
      if (!Array.isArray(points) || points.length < 2) throw new Error('drag needs at least two points, e.g. "drag left right" or { drag: ["left", "right"] }.');
      return { points, seconds };
    },
    async run(session, { points, seconds }) {
      const [start, ...rest] = points.map((point) => resolvePoint(point, session.size));
      const pauseMs = (seconds * 1000) / (rest.length * THUMB.dragMovesPerLeg);
      await session.pointer.down(start.x, start.y);
      let from = start;
      for (const to of rest) {
        for (let move = 1; move <= THUMB.dragMovesPerLeg; move++) {
          const progress = move / THUMB.dragMovesPerLeg;
          await session.pointer.move(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress);
          await session.page.waitForTimeout(pauseMs);
        }
        from = to;
      }
      await session.pointer.up();
    },
  },
  swipe: {
    usage: 'swipe <left|right|up|down>',
    about: 'a quick flick from the middle of the play area',
    fromText: (text) => ({ swipe: wordsOf(text)[0] }),
    normalize: (direction, { at = 'center' }) => {
      if (!SWIPE_OFFSETS[direction]) throw new Error(`swipe needs a direction (${Object.keys(SWIPE_OFFSETS).join(', ')}), got "${direction}".`);
      return { direction, at };
    },
    async run(session, { direction, at }) {
      const start = resolvePoint(at, session.size);
      const [offsetX, offsetY] = SWIPE_OFFSETS[direction];
      await session.pointer.down(start.x, start.y);
      for (let move = 1; move <= THUMB.swipeMoves; move++) {
        const reach = (THUMB.swipePixels * move) / THUMB.swipeMoves;
        await session.pointer.move(start.x + offsetX * reach, start.y + offsetY * reach);
      }
      await session.pointer.up();
    },
  },
  hold: {
    usage: 'hold <point> <seconds>',
    about: 'press a point and keep it down for some game seconds',
    fromText: (text) => {
      const { points, rest } = takePoints(wordsOf(text));
      return { hold: points[0] || 'center', seconds: Number(rest[0] || 1) };
    },
    normalize: (at, { seconds = 1 }) => ({ at: at === true ? 'center' : at, seconds }),
    async run(session, { at, seconds }) {
      const point = resolvePoint(at, session.size);
      await session.pointer.down(point.x, point.y);
      // The release must happen even when the wait times out, or the next step starts with the pointer down.
      await waitGameSeconds(session, seconds).finally(() => session.pointer.up());
    },
  },
  key: {
    usage: 'key <name>',
    about: 'press a keyboard key (ArrowLeft, Space, a ...)',
    fromText: (text) => ({ key: text.trim() }),
    normalize: (key) => ({ key: String(key) }),
    run: (session, { key }) => session.page.keyboard.press(key),
  },
  press: {
    usage: 'press <label>',
    about: 'press a HUD button by its label (also: back, restart)',
    fromText: (text) => ({ press: text.trim() }),
    normalize: (label, { timeout = LIMITS.pressSeconds }) => ({ label: String(label), timeout }),
    run: async (session, { label, timeout }) => void (await retryInPage(session, timeout, pressInPage, label)),
  },
  choose: {
    usage: 'choose <index|label>',
    about: 'pick an option of the open modal (waits for the modal to open)',
    fromText: (text) => ({ choose: /^\d+$/.test(text.trim()) ? Number(text) : text.trim() }),
    normalize: (option, { timeout = LIMITS.chooseSeconds }) => ({ option, timeout }),
    run: async (session, { option, timeout }) => void (await retryInPage(session, timeout, chooseInPage, option)),
  },
  wait: {
    usage: 'wait <seconds>',
    about: 'let the game run for some seconds of game time',
    fromText: (text) => ({ wait: Number(text) }),
    normalize: (seconds) => {
      if (!(seconds >= 0)) throw new Error(`wait needs a number of game seconds, got "${seconds}".`);
      return { seconds };
    },
    run: (session, { seconds }) => waitGameSeconds(session, seconds),
  },
  until: {
    usage: 'until <predicate> [timeout <seconds>]',
    about: 'wait until a predicate over the debug state is true (timeout in real seconds, default 60)',
    fromText: (text) => {
      const limit = /\btimeout\s+([\d.]+)\s*$/.exec(text);
      return { until: text.replace(/\btimeout\s+[\d.]+\s*$/, '').trim(), timeout: limit ? Number(limit[1]) : LIMITS.untilSeconds };
    },
    normalize: (test, { timeout = LIMITS.untilSeconds }) => ({ test, timeout }),
    async run(session, { test, timeout }) {
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        const result = await evaluateTest(session, test);
        if (result.passed) return;
        if (Date.now() > deadline) throw new Error(`still false after ${timeout}s: it ${explainTest(result)}`);
        await session.page.waitForTimeout(LIMITS.pollMs);
      }
    },
  },
  assert: {
    usage: 'assert <predicate>',
    about: 'fail the playtest unless a predicate over the debug state is true',
    fromText: (text) => ({ assert: text.trim() }),
    normalize: (test, { message = '' }) => ({ test, message }),
    async run(session, { test, message }) {
      const result = await evaluateTest(session, test);
      if (!result.passed) throw new Error(`${message ? message + ': ' : ''}it ${explainTest(result)}`);
    },
  },
  log: {
    usage: 'log <expression>',
    about: 'print the value of an expression over the debug state (try: log kit)',
    fromText: (text) => ({ log: text.trim() || 'kit' }),
    normalize: (test) => ({ test }),
    async run(session, { test }) {
      const result = await evaluateTest(session, test);
      return result.error ? `threw "${result.error}"` : String(result.shown).slice(0, MOST_STATE_CHARACTERS);
    },
  },
  timescale: {
    usage: 'timescale <factor>',
    about: 'run game time faster or slower (applies to the current run)',
    fromText: (text) => ({ timescale: Number(text) }),
    normalize: (scale) => {
      if (!(scale > 0)) throw new Error(`timescale needs a positive number, got "${scale}".`);
      return { scale };
    },
    run: (session, { scale }) => session.page.evaluate((factor) => void (Kit.current.timeScale = factor), scale),
  },
  shot: {
    usage: 'shot <name>',
    about: 'save a screenshot of this moment as scratch/<id>/<name>.png',
    fromText: (text) => ({ shot: text.trim() }),
    normalize: (name) => {
      if (!/^[\w.-]+$/.test(String(name))) throw new Error(`shot needs a file-safe name (letters, digits, - _ .), got "${name}".`);
      return { name: String(name).replace(/\.png$/, '') };
    },
    async run(session, { name }) {
      const file = path.join(session.outDir, `${name}.png`);
      await session.shot(file);
      return file;
    },
  },
  restart: {
    usage: 'restart',
    about: 'press the restart chip (works even while a modal is open)',
    fromText: () => ({ restart: true }),
    normalize: () => ({}),
    run: async (session) => {
      await session.page.evaluate(() => document.getElementById('restart').click());
      await session.page.waitForTimeout(LIMITS.pollMs);
    },
  },
};

/**
 * @typedef {Object} Step
 * @property {string} verb a key of STEPS
 * @property {string} label the step as it reads in the report
 */

/**
 * Normalises one step of a script.
 * @param {string|Object} step a text step ("wait 2") or an object step ({ wait: 2 })
 * @returns {Step} the verb, a label, and the verb's own fields
 * @throws {Error} naming the unknown verb (with the nearest known one) or the bad argument
 * @example parseStep('tap center x3') // { verb: 'tap', label: 'tap center x3', at: 'center', times: 3, every: 0.15 }
 */
function parseStep(step) {
  const isText = typeof step === 'string';
  const verb = isText ? wordsOf(step)[0] : Object.keys(step || {}).find((key) => STEPS[key]);
  const kind = STEPS[verb];
  if (!kind) {
    const written = isText ? wordsOf(step)[0] || '' : Object.keys(step || {})[0] || '';
    const nearest = Object.keys(STEPS).sort((first, second) => editDistance(written, first) - editDistance(written, second))[0];
    throw new Error(`unknown step "${written}". Did you mean "${nearest}"? Steps: ${Object.keys(STEPS).join(', ')}.`);
  }
  const fields = isText ? kind.fromText(step.trim().slice(verb.length).trim()) : step;
  const { [verb]: value, ...options } = fields;
  const label = isText ? step.trim() : `${verb} ${typeof value === 'function' ? value.toString() : JSON.stringify(value)}`;
  return { verb, label, ...kind.normalize(value, options) };
}

/**
 * Normalises a whole script.
 * @param {Array|{steps: Array, skin?: string, landscape?: boolean, touch?: boolean}|string} script a list of steps, an object that
 *   wraps one with defaults, or inline text with steps separated by `;` or new lines
 * @returns {{steps: Step[], skin: (string|undefined), landscape: boolean, touch: boolean}}
 * @throws {Error} naming the step number of the first bad step
 * @example parseScript('tap center; wait 2; assert hud.Score > 0').steps.length // 3
 */
function parseScript(script) {
  const wrapper = Array.isArray(script) || typeof script === 'string' ? { steps: script } : script || {};
  const rawSteps = typeof wrapper.steps === 'string' ? wrapper.steps.split(/[;\n]/).map((line) => line.trim()).filter(Boolean) : wrapper.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length) throw new Error('a play script needs steps: a JSON array like ["tap center", "wait 2", "shot start"], or { "steps": [...] }.');
  const steps = rawSteps.map((step, index) => {
    try {
      return parseStep(step);
    } catch (error) {
      throw new Error(`step ${index + 1}: ${error.message}`);
    }
  });
  return { steps, skin: wrapper.skin, landscape: Boolean(wrapper.landscape), touch: Boolean(wrapper.touch) };
}

/**
 * @typedef {Object} PlayResult
 * @property {boolean} passed false when a step failed or the page reported an error
 * @property {string[]} lines the report, one line per step and per problem
 */

/**
 * Runs normalised steps against a game that is already launched.
 * @param {import('./browser').ArcadeSession & {outDir: string}} session `outDir` is where `shot` saves
 * @param {Step[]} steps from parseScript
 * @returns {Promise<PlayResult>}
 */
async function runSteps(session, steps) {
  const lines = [];
  let failure = null;
  for (const [index, step] of steps.entries()) {
    const number = String(index + 1).padStart(2);
    try {
      const note = await STEPS[step.verb].run(session, step);
      lines.push(`  ok   ${number}  ${step.label}${note ? `  ->  ${note}` : ''}`);
    } catch (error) {
      failure = `step ${index + 1} (${step.label}): ${error.message.split('\n')[0]}`;
      lines.push(`  FAIL ${number}  ${step.label}  ::  ${error.message.split('\n')[0]}`);
      // A picture of the moment it went wrong is usually the whole diagnosis.
      await session.shot(path.join(session.outDir, 'fail.png')).catch(() => {});
      lines.push(`       saw: ${path.join(session.outDir, 'fail.png')}`);
      break;
    }
  }
  const kit = await readKitState(session).catch(() => null);
  const crash = kit && kit.crash;
  const problems = [...session.errors, ...(crash ? [`game crashed: ${crash}`] : [])];
  problems.forEach((problem) => lines.push(`  ERROR ${problem}`));
  (await session.warnings().catch(() => [])).forEach((warning) => lines.push(`  WARN  ${warning}`));
  if (kit) lines.push(`  end state: ${JSON.stringify({ time: Number(kit.time.toFixed(1)), hud: kit.hud, modal: kit.modal, state: kit.state }).slice(0, MOST_STATE_CHARACTERS)}`);
  const passed = !failure && !problems.length;
  lines.push(passed ? 'OK' : `FAILED: ${failure || `${problems.length} page error(s)`}`);
  return { passed, lines };
}

module.exports = { STEPS, NAMED_POINTS, resolvePoint, parseStep, parseScript, runSteps, editDistance };
