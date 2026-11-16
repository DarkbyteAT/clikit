#!/usr/bin/env bun
/**
 * Unit tests for the pure parts of the dev tools (tools/dev/*.js, tools/bench.js). Run: node tools/test-dev.js
 *
 * Owns:  cases that would fail if the lint, the docs generator, the play step language, the script-tag
 *        editing, the scaffolder, the simulator, the check parsers or the metrics maths were wrong.
 * Does not own: anything that needs a browser (exercised by `node tools/dev.js check` and `play`).
 */
'use strict';

const assert = require('assert');
const { tokenize, readSource, kitExports, parseJsdoc } = require('./dev/source');
const { RULES, lintSource, summarize } = require('./dev/lint');
const { describeModule, renderApi } = require('./dev/docs');
const { parseStep, parseScript, resolvePoint, editDistance } = require('./dev/play');
const { scriptSources, insertScriptTag, removeScriptTag, compareTags, belongsToGame } = require('./dev/project');
const scaffold = require('./dev/scaffold');
const { POLICIES, simulate, analyze, seededRandom, formatClock } = require('./dev/simulate');
const { parseSmokeOutput, parseBiomeOutput, renderTable, scopedRows } = require('./dev/check');
const { checkBudgets, checkSculptBudgets, BUDGETS, SCREEN_BUDGETS, SCULPT_BUDGETS } = require('./dev/budgets');
const { parseTscOutput, countByFile, compareWithBaseline } = require('./dev/typecheck');
const { reuseRatio, appendLedgerRow, tokensByTier } = require('./dev/metrics');
const { judge } = require('./bench');
const { parseArgs } = require('./dev');
const { parseSize } = require('./dev/browser');

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log('  ok  ' + name);
};
/** The rules a snippet breaks, as a sorted, comma-joined list. */
const rulesBroken = (file, text) => [...new Set(lintSource(file, text).map((finding) => finding.rule))].sort().join(',');
const HEADER = '/** Demo file: owns nothing much, and does not own the rest. */\n';

test('tokenize tells regex from division and keeps strings, templates and comments whole', () => {
  const types = (text) => tokenize(text).map((token) => token.type).join(' ');
  assert.strictEqual(types('a / b'), 'ident punct ident');
  assert.strictEqual(types('x = /a\\/[/]b/g;'), 'ident punct regex punct');
  assert.strictEqual(types('`a ${`b ${c}`} d` // done'), 'template comment');
  assert.strictEqual(tokenize('a\n\n  b')[1].line, 3, 'lines are counted across blank lines');
  assert.strictEqual(tokenize("'it\\'s' + 1").length, 3, 'an escaped quote does not end the string');
});

test('kitExports finds assignments, namespace members, shorthand resolved to declarations and factory members', () => {
  const source = readSource(`
    /** Adds. */
    const add = (first, second) => first + second;
    const hidden = 5;
    Kit.math = { add, hidden, /** Doubles. */ twice: (value) => value * 2 };
    /** Makes a counter. */
    Kit.counter = (start) => {
      function bump(step) { return start += step; }
      return { bump, read() { return start; } };
    };
  `);
  const names = kitExports(source).map((entry) => `${entry.name}(${entry.params})`);
  assert.deepStrictEqual(names, ['Kit.math.add(first, second)', 'Kit.math.twice(value)', 'Kit.counter(start)']);
  const counter = kitExports(source).find((entry) => entry.name === 'Kit.counter');
  assert.deepStrictEqual(counter.members.map((member) => member.name), ['.bump', '.read']);
  assert.ok(kitExports(source)[0].jsdoc.includes('Adds'), 'the JSDoc of the declaration is attached to the export');
});

test('parseJsdoc reads summary, nested-brace types, optional params, returns, examples and complexity', () => {
  const parsed = parseJsdoc(`/**
   * Rolls an item.
   * second line.
   * @param {{level: number, tags: Object<string, number>}} [options={}] what to roll
   * @returns {Item} the item
   * @complexity O(n) time
   * @example
   * loot.roll({ level: 3 });
   */`);
  assert.strictEqual(parsed.summary, 'Rolls an item.\nsecond line.');
  assert.deepStrictEqual(parsed.params[0], { type: '{level: number, tags: Object<string, number>}', name: '[options={}]', description: 'what to roll' });
  assert.deepStrictEqual(parsed.returns, { type: 'Item', description: 'the item' });
  assert.strictEqual(parsed.complexity, 'O(n) time');
  assert.strictEqual(parsed.examples[0], 'loot.roll({ level: 3 });');
});

test('lint: each hard rule fires on its mistake and stays quiet on clean code', () => {
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'const speed = 4;'), '', 'control: clean code has no findings');
  assert.strictEqual(rulesBroken('games/demo.js', 'const speed = 4;'), 'header');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + '// TODO tidy\nconst speed = 4;'), 'todo');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + 'console.log(4);'), 'console-log');
  assert.strictEqual(rulesBroken('tools/demo.js', HEADER + 'console.log(4);'), '', 'tools print on purpose');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + "const text = 'console.log(4) TODO';"), '', 'strings are not code');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'setTimeout(spawn, 100);'), 'raw-timer');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + 'setTimeout(spawn, 100);'), '', 'the kit may use timers');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + "window.addEventListener('resize', fit);"), 'raw-listener');
});

test('lint: heuristic rules', () => {
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + 'Kit.grow = (value) => value + 1;'), 'jsdoc');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + '/** Grows. @param {number} value */\nKit.grow = (value) => value + 1;'), '');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + '/** Grows. */\nKit.grow = (value) => value + 1;'), 'jsdoc-params');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + '/** Sums. @param {number[]} values */\nKit.sum = (values) => values.reduce((total, value) => total + value, 0);'), 'complexity');
  assert.strictEqual(rulesBroken('kit/demo.js', HEADER + '/** Sums. @param {number[]} values @complexity O(n) */\nKit.sum = (values) => values.reduce((total, value) => total + value, 0);'), '');
  const factory = HEADER + '/** Makes a bag. @returns {Object} with `add` */\nKit.bag = () => { const items = []; return { add(item) { items.push(item); }, drop() { items.pop(); } }; };';
  assert.deepStrictEqual(lintSource('kit/demo.js', factory).map((finding) => finding.message.split(',')[0]), ['Kit.bag().drop()'], 'a member named in the factory JSDoc is covered; one that is not is flagged');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'const e = 4; let x = 1; for (let i = 0; i < 3; i++) run((v) => v + e + x);'), 'short-name', 'e is flagged');
  assert.strictEqual(lintSource('games/demo.js', HEADER + 'const e = 4; let x = 1; for (let i = 0; i < 3; i++) run((v) => v);').length, 1, 'x, the loop index and the arrow parameter are allowed');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'function hit(e, { a, size: s }) { try { e(); } catch (q) { return a + s; } }'), 'short-name');
  assert.strictEqual(lintSource('games/demo.js', HEADER + 'function hit(e, { a, size: s }) { try { e(); } catch (q) { return a + s; } }').length, 4, 'e, a, s and q; `size:` is a key, not a name');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'run();\n// const old = 5;\n// stop();\n'), 'commented-code');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'run();\n// Stop when the wave ends; the boss comes next.\n'), '', 'prose is not code');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'move(0.35); turn(0.35);'), 'magic-number');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'const SPEED = 0.35; const TABLE = [0.35, 0.35]; const row = { speed: 0.35, turn: 0.35 }; move(1); turn(1);'), '', 'named, tabled and ordinary numbers pass');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'const tint = new THREE.Color(0xff0000);'), 'raw-color');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'const scratch = new THREE.Color(); const good = new THREE.Color(0xff0000).convertSRGBToLinear();'), '');
  assert.strictEqual(rulesBroken('games/demo.js', HEADER + 'Kit.register({ id: "demo" });'), 'depth-plan');
  assert.strictEqual(rulesBroken('games/demo.js', '/** Demo. Seconds: timing. Minutes: builds. Hours: unlocks. Owns it all. */\nKit.register({ id: "demo" });'), '');
  assert.strictEqual(rulesBroken('games/demo-data.js', HEADER + 'const ROWS = [];'), '', 'only the file that registers needs the depth plan');
  const counts = summarize(lintSource('games/demo.js', 'console.log(1);'), ['games/demo.js', 'games/clean.js']);
  assert.deepStrictEqual(counts.map((row) => [row.file, row.total, row.errors]), [['games/demo.js', 2, 2], ['games/clean.js', 0, 0]]);
  assert.ok(Object.keys(RULES).every((rule) => RULES[rule].fix && RULES[rule].about), 'every rule explains itself and its fix');
});

test('the scaffolded game and module pass the lint with no findings', () => {
  const context = { files: [], indexHtml: '<script src="kit/core.js"></script>\n<script src="kit/shell.js"></script>\n', skins: ['glass', 'neon'] };
  const game = scaffold.planGame('sky-garden', { ...context, skin: 'neon' });
  assert.deepStrictEqual(lintSource('games/sky-garden.js', game.writes['games/sky-garden.js']), []);
  assert.ok(game.writes['games/sky-garden.js'].includes("skin: 'neon'") && game.writes['games/sky-garden.js'].includes("name: 'Sky Garden'"));
  assert.ok(!/__[A-Z]+__/.test(Object.values(game.writes).join('')), 'no placeholder is left unfilled');
  assert.ok(game.writes['index.html'].indexOf('games/sky-garden.js') < game.writes['index.html'].indexOf('kit/shell.js'), 'the game loads before the shell');
  assert.ok(game.writes['scratch/sky-garden/PLAN.md'].includes('Tier') && JSON.parse(game.writes['scratch/sky-garden/play.json']).steps.length > 3);
  assert.throws(() => scaffold.planGame('Sky Garden', context), /lowercase/);
  assert.throws(() => scaffold.planGame('sky', { ...context, skin: 'chrome' }), /unknown skin "chrome". Skins: glass, neon/);
  assert.throws(() => scaffold.planGame('sky', { ...context, files: ['games/sky-data.js'] }), /already exists/);
  const testKit = "const a = 1;\npending.then(() => console.log('done'));\n";
  const module = scaffold.planModule('wave-field', { ...context, testKit });
  assert.deepStrictEqual(lintSource('kit/wave-field.js', module.writes['kit/wave-field.js']), []);
  assert.ok(module.writes['kit/wave-field.js'].includes('Kit.waveField = { toWholeCount }'));
  assert.ok(module.writes['tools/test-kit.js'].indexOf('wave-field: toWholeCount') < module.writes['tools/test-kit.js'].indexOf('pending.then('), 'the stub goes above the footer');
  const undone = scaffold.planRemoveModule('wave-field', { moduleSource: module.writes['kit/wave-field.js'], indexHtml: module.writes['index.html'], testKit: module.writes['tools/test-kit.js'] });
  assert.strictEqual(undone.writes['tools/test-kit.js'], testKit, 'remove restores the test file exactly');
  assert.strictEqual(undone.writes['index.html'], context.indexHtml, 'and the page');
  assert.throws(() => scaffold.planRemoveModule('wave-field', { moduleSource: 'edited', indexHtml: '', testKit }), /edited since/);
  assert.throws(() => scaffold.planRemoveGame('real', { gameSource: '/** A real game. */', indexHtml: '' }), /no longer a scaffold/);
});

test('script tags: insert in the right place, remove cleanly, report mismatches', () => {
  const page = ['kit/core.js', 'kit/ui.js', 'games/a.js', 'kit/shell.js'].map((src) => `<script src="${src}"></script>`).join('\n') + '\n';
  assert.deepStrictEqual(scriptSources(insertScriptTag(page, 'games/b.js')), ['kit/core.js', 'kit/ui.js', 'games/a.js', 'games/b.js', 'kit/shell.js']);
  assert.deepStrictEqual(scriptSources(insertScriptTag(page, 'kit/waves.js')), ['kit/core.js', 'kit/ui.js', 'kit/waves.js', 'games/a.js', 'kit/shell.js']);
  assert.strictEqual(insertScriptTag(page, 'games/a.js'), page, 'an existing tag is not duplicated');
  assert.strictEqual(removeScriptTag(insertScriptTag(page, 'games/b.js'), 'games/b.js'), page);
  assert.throws(() => insertScriptTag('<script src="kit/core.js"></script>', 'games/b.js'), /no .*kit\/shell.js/);
  assert.deepStrictEqual(compareTags(page, ['kit/core.js', 'kit/ui.js', 'kit/shell.js', 'games/c.js']), { missingFiles: ['games/a.js'], untagged: ['games/c.js'] });
  assert.ok(belongsToGame('games/cozy-data.js', 'cozy') && belongsToGame('games/cozy.js', 'cozy') && !belongsToGame('games/cozyland.js', 'cozy'));
});

test('play: steps parse from text and objects, with errors that name the fix', () => {
  assert.deepStrictEqual(parseStep('tap center x3'), { verb: 'tap', label: 'tap center x3', at: 'center', times: 3, every: 0.15 });
  assert.deepStrictEqual(parseStep('tap 0.5 0.4').at, [0.5, 0.4]);
  assert.deepStrictEqual(parseStep({ tap: [10, 20], times: 2 }).at, [10, 20]);
  assert.deepStrictEqual(parseStep('drag left 0.5,0.9 right in 0.8'), { verb: 'drag', label: 'drag left 0.5,0.9 right in 0.8', points: ['left', [0.5, 0.9], 'right'], seconds: 0.8 });
  assert.deepStrictEqual(parseStep('until state.depth >= 3 timeout 20'), { verb: 'until', label: 'until state.depth >= 3 timeout 20', test: 'state.depth >= 3', timeout: 20 });
  assert.strictEqual(parseStep('choose 1').option, 1);
  assert.strictEqual(parseStep('choose Bigger boat').option, 'Bigger boat');
  assert.strictEqual(parseStep('press Buy Pick').label, 'Buy Pick');
  assert.strictEqual(parseStep({ assert: 'hud.Score > 0', message: 'scored' }).message, 'scored');
  const predicate = (state) => state.lives > 0;
  assert.strictEqual(parseStep({ until: predicate }).test, predicate, 'a JS module may pass a function');
  assert.throws(() => parseStep('tpa center'), /unknown step "tpa". Did you mean "tap"\?/);
  assert.throws(() => parseStep('swipe sideways'), /direction \(left, right, up, down\)/);
  assert.throws(() => parseStep('drag left'), /at least two points/);
  assert.throws(() => parseStep('wait soon'), /number of game seconds/);
  assert.throws(() => parseScript(['tap center', 'wiat 2']), /step 2: unknown step "wiat". Did you mean "wait"/);
  assert.throws(() => parseScript([]), /needs steps/);
  assert.strictEqual(parseScript('tap center; wait 2\nshot start').steps.length, 3, 'inline text splits on ; and new lines');
  assert.deepStrictEqual(parseScript({ skin: 'neon', landscape: true, steps: ['restart'] }), { steps: [{ verb: 'restart', label: 'restart' }], skin: 'neon', landscape: true, touch: false });
  assert.deepStrictEqual(resolvePoint('center', { width: 390, height: 780 }), { x: 195, y: 390 });
  assert.deepStrictEqual(resolvePoint([100, 300], { width: 390, height: 780 }), { x: 100, y: 300 }, 'numbers above 1 are pixels');
  assert.throws(() => resolvePoint('middle', { width: 1, height: 1 }), /not a point/);
  assert.strictEqual(editDistance('tpa', 'tap'), 2);
});

test('docs: a module renders signatures, params, returns, complexity, examples, members and gaps', () => {
  const module = describeModule('demo.js', `/**
 * Kit demo: a tiny module. More detail here.
 */
(() => {
  /**
   * @typedef {Object} Bag a bag of things
   * @property {number} size how many
   */
  /**
   * Makes a bag.
   * @param {number} [size=3] capacity
   * @returns {Bag} the bag
   * @complexity O(1)
   * @example Kit.bag(4)
   */
  Kit.bag = (size = 3) => ({ /** Empties it. */ clear() {} });
  Kit.loose = () => 1;
})();`);
  const markdown = renderApi([module]);
  ['# Kit API reference', '- [demo.js](#demojs) (2) - Kit demo: a tiny module.', '### `Kit.bag(size = 3)`', '- `[size=3]` *number* - capacity', '**Returns** *Bag* the bag', '**Complexity** O(1)', '```js\nKit.bag(4)\n```', '#### `Kit.bag().clear()`', 'Empties it.', '### `Kit.loose()`', '_Undocumented', '- **Bag** - a bag of things', '  - `size` *number* - how many'].forEach(
    (expected) => assert.ok(markdown.includes(expected), `the reference should contain: ${expected}`)
  );
});

test('simulate: policies differ, time advances, and the analysis flags dead stretches, exhaustion and runaway growth', () => {
  // A toy economy: each play earns `income`; two things to buy, the dear one doubles income.
  const toy = (prices) => ({
    createState: () => ({ coins: 0, income: 1, owned: [] }),
    actions: (state) => [{ id: 'play', kind: 'play' }, ...Object.keys(prices).filter((id) => !state.owned.includes(id)).map((id) => ({ id, kind: 'buy', cost: prices[id], affordable: state.coins >= prices[id] }))],
    apply(state, action) {
      if (action.kind === 'play') return { seconds: 60, state: { ...state, coins: state.coins + state.income } };
      return { seconds: 0, state: { coins: state.coins - prices[action.id], income: action.id === 'engine' ? state.income * 2 : state.income, owned: [...state.owned, action.id] } };
    },
    summary: (state) => ({ currency: state.coins, owned: state.owned.length, remaining: Object.keys(prices).length - state.owned.length }),
  });
  const prices = { hat: 5, engine: 20 };
  const greedy = simulate(toy(prices), POLICIES.greedy, { seconds: 3600 });
  const saver = simulate(toy(prices), POLICIES.saver, { seconds: 3600 });
  assert.deepStrictEqual(greedy.acquisitions.map((bought) => [bought.id, bought.time]), [['hat', 300], ['engine', 1500]], 'greedy buys the hat as soon as it can');
  assert.deepStrictEqual(saver.acquisitions.map((bought) => [bought.id, bought.time]), [['engine', 1200], ['hat', 1380]], 'the saver waits for the engine first');
  assert.strictEqual(greedy.seconds, 3600);
  assert.ok(greedy.samples.length > 10 && greedy.samples[0].currency === 0);
  const analysis = analyze(greedy, { deadMinutes: 10 });
  assert.strictEqual(analysis.exhaustedAt, 1500);
  assert.ok(analysis.warnings.some((warning) => warning.startsWith('dead stretch: nothing new from 0:05:00 to 0:25:00')), analysis.warnings.join(' | '));
  assert.ok(analysis.warnings.some((warning) => warning.startsWith('out of new things at 0:25:00')));
  assert.ok(analysis.warnings.some((warning) => warning.startsWith('currency keeps growing')));
  assert.deepStrictEqual(analyze(simulate(toy({ hat: 5, engine: 20, moon: 80 }), POLICIES.greedy, { seconds: 3600 }), { deadMinutes: 45 }).warnings, [], 'control: a paced economy raises nothing');
  const runaway = analyze(simulate(toy({ hat: 1, moon: 1e9 }), POLICIES.greedy, { seconds: 36000 }), { deadMinutes: 1e6, runawayFactor: 0.0000001 });
  assert.ok(runaway.warnings.some((warning) => warning.startsWith('runaway growth')));
  assert.throws(() => simulate(toy(prices), () => ({ id: 'engine', kind: 'buy', affordable: false }), { seconds: 60 }), /not affordable/);
  assert.throws(() => simulate({ ...toy(prices), apply: () => ({}) }, POLICIES.greedy, { seconds: 60 }), /must return \{ seconds \}/);
  const first = seededRandom(5), second = seededRandom(5);
  assert.strictEqual(first(), second(), 'the same seed gives the same run');
  assert.strictEqual(formatClock(3725), '1:02:05');
});

test('check: tool outputs parse into rows; scope separates my failures from other files', () => {
  const smoke = parseSmokeOutput(['menu: games registered = [miner, runner]', 'menu: finger drag moved the list 80px', 'miner: ~22 fps (software GL) | hud: DEPTH 3', '  PROBE [miner] {"frames":30,"frameMs":[40,60,90],"calls":120,"triangles":5000,"meshes":80}', '  WARN [miner] miner: 4 stats in the top row', '  ERROR [runner] pageerror: boom', 'FAILED with 1 error(s)'].join('\n'));
  assert.strictEqual(smoke.miner.probe.calls, 120);
  assert.deepStrictEqual(smoke.miner.warnings, ['miner: 4 stats in the top row']);
  assert.deepStrictEqual(smoke.runner.errors, ['pageerror: boom']);
  assert.strictEqual(smoke.menu.summary, 'games registered = [miner, runner] | finger drag moved the list 80px', 'a second menu line does not hide the registered list');
  assert.deepStrictEqual(checkBudgets({ calls: 10, triangles: 10, meshes: 10 }), []);
  assert.ok(checkBudgets({ calls: BUDGETS.calls.limit + 1, triangles: 10, meshes: 10 })[0].startsWith(`${BUDGETS.calls.limit + 1} draw calls (budget ${BUDGETS.calls.limit})`));
  // A screen with limits of its own is held to them; the same probe passes for any other screen.
  const maker = { calls: 19, triangles: 147920, meshes: 1 };
  assert.deepStrictEqual(checkBudgets(maker, 'miner'), []);
  assert.strictEqual(checkBudgets(maker, 'creator').length, 2);
  assert.ok(checkBudgets(maker, 'creator')[0].includes(`(budget ${SCREEN_BUDGETS.creator.calls})`));
  assert.deepStrictEqual(checkBudgets({ calls: 3, triangles: 39638, meshes: 1 }, 'creator'), []);
  assert.deepStrictEqual(checkSculptBudgets('low', { triangles: SCULPT_BUDGETS.low.triangles, meshes: 1, bytes: 1 }), []);
  assert.deepStrictEqual(checkSculptBudgets('low', { triangles: 9710, meshes: 8, bytes: 337570 }).map((message) => message.split(' ').slice(0, 3).join(' ')), ['low: 9710 triangles', 'low: 8 skinned', 'low: 337570 bytes']);
  const rows = scopedRows('lint', [{ file: 'games/miner.js', text: 'mine' }, { file: 'kit/ui.js', text: 'theirs' }], (file) => file.startsWith('games/miner'), 'clean');
  assert.deepStrictEqual(rows.map((row) => [row.name, row.status]), [['lint', 'FAIL'], ['lint (other files)', 'WARN']]);
  assert.deepStrictEqual(scopedRows('lint', [], () => true, 'clean'), [{ name: 'lint', status: 'PASS', detail: 'clean' }]);
  assert.ok(renderTable(rows).split('\n').length === 4 && renderTable(rows).includes('FAIL'));
  const tsc = parseTscOutput("kit/core.js(198,55): error TS2339: Property 'weight' does not exist.\nnoise\ngames/a.js(1,1): error TS1003: Identifier expected.\nkit/core.js(2,1): error TS1: x");
  assert.deepStrictEqual(countByFile(tsc), { 'kit/core.js': 2, 'games/a.js': 1 });
  assert.deepStrictEqual(compareWithBaseline({ 'kit/core.js': 2, 'games/new.js': 1, 'kit/ui.js': 1 }, { 'kit/core.js': 2, 'kit/ui.js': 4 }), { worse: [{ file: 'games/new.js', now: 1, allowed: 0 }], better: [{ file: 'kit/ui.js', now: 1, allowed: 4 }] });
  const biome = parseBiomeOutput(`::error title=lint/correctness/noUndeclaredVariables,file=${process.cwd()}/kit/model.js,line=474,endLine=474,col=53,endColumn=58::The slots variable is undeclared.`);
  assert.strictEqual(biome[0].rule, 'lint/correctness/noUndeclaredVariables');
  assert.strictEqual(biome[0].line, 474);
});

test('metrics: reuse ratio, ledger rows and token totals per tier', () => {
  const ratio = reuseRatio("// comment only\nKit.fsm({});\nmake.box(1, 1, 1);\nconst wide = ctx.size.w;\nlocal.make.box();\n");
  assert.deepStrictEqual(ratio, { lines: 4, kitCalls: 2, per100Lines: 50 }, 'a property read and a method on another object are not kit calls');
  const ledger = '# Metrics\n\n## Ledger\n\n| # | Work | Kind | Model | Tokens |\n|---|---|---|---|---|\n| 1 | A | draft | sonnet | 120k |\n| 2 | B | rework | fable | 1.5M |\n\n## Next\n';
  const added = appendLedgerRow(ledger, { work: 'C | D', kind: 'piece', model: 'sonnet', tokens: '30k', minutes: '5', load: 'idle', bar: 'standard', rework: '0', notes: 'n' });
  assert.ok(added.includes('| 2 | B | rework | fable | 1.5M |\n| 3 | C / D | piece | sonnet | 30k | 5 | idle | standard | 0 | n |\n\n## Next'), 'the row is numbered and lands at the end of the table');
  assert.deepStrictEqual(tokensByTier(added), [{ model: 'fable', rows: 1, tokens: 1500000 }, { model: 'sonnet', rows: 2, tokens: 150000 }]);
  assert.strictEqual(tokensByTier(ledger.replace('| fable |', '| Fable (no leaves) |'))[0].model, 'fable', 'a note after the tier does not make a new tier');
  assert.throws(() => appendLedgerRow('# nothing', {}), /no "## Ledger"/);
});

test('safe replace: installs when unchanged, carries a plain append over, refuses anything else', () => {
  const { mergeTail, planReplace } = require('./dev/safewrite');
  const snapshot = '(() => {\n  const a = 1;\n})();\n';
  const rewrite = '(() => {\n  const alpha = 1;\n})();\n';
  const appended = '(() => {\n  const a = 1;\n  Kit.extra = 2;\n})();\n';
  assert.deepStrictEqual(planReplace({ snapshot, current: snapshot, replacement: rewrite }), { action: 'install', text: rewrite });
  assert.deepStrictEqual(planReplace({ snapshot, current: appended, replacement: rewrite }), { action: 'merge', text: '(() => {\n  const alpha = 1;\n  Kit.extra = 2;\n})();\n' });
  assert.strictEqual(mergeTail(snapshot, '(() => {\n  const a = 2;\n})();\n', rewrite), null, 'an edit inside the file is not a plain append');
  assert.match(planReplace({ snapshot, current: '(() => {\n  const a = 2;\n})();\n', replacement: rewrite }).reason, /merge by hand/);
  assert.match(planReplace({ snapshot, current: snapshot, replacement: '(() => {' }).reason, /does not parse/);
  assert.match(planReplace({ snapshot: null, current: snapshot, replacement: rewrite }).reason, /no snapshot/);
});

test('bench verdicts and argument parsing', () => {
  assert.strictEqual(judge(1, undefined).verdict, 'new');
  assert.strictEqual(judge(0.9, 1).verdict, 'ok');
  assert.strictEqual(judge(0.4, 1).verdict, 'SLOWER');
  assert.strictEqual(judge(3, 1).verdict, 'faster');
  assert.deepStrictEqual(parseArgs(['miner', '--secs', '4', '--landscape', 'x']), { positionals: ['miner', 'x'], flags: { secs: '4', landscape: true } });
});

test('play --size reads <width>x<height> and names what it rejects', () => {
  assert.deepStrictEqual(parseSize('1200x900'), { width: 1200, height: 900 });
  assert.deepStrictEqual(parseSize(' 390x780 '), { width: 390, height: 780 });
  assert.throws(() => parseSize('1200'), /not a viewport size/);
  assert.throws(() => parseSize('1200x'), /not a viewport size/);
  assert.throws(() => parseSize('50x900'), /from 100 to 2400/, 'too small to hold the page');
  assert.throws(() => parseSize('1200x9000'), /from 100 to 2400/, 'software GL would take seconds per frame');
});

console.log(`${passed} tests passed`);
