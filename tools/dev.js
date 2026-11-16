#!/usr/bin/env bun
/**
 * dev: the one entry point for routine development jobs. `node tools/dev.js help` (or `make help`) lists them.
 *
 * Owns:  the command table (name, one-line summary, example, handler), argument parsing and exit codes.
 * Does not own: any of the work: each command calls a small module in tools/dev/ (lint, docs, play, check,
 *        sheet, scaffold, typecheck, metrics) or a sibling tool (tools/sim.js, tools/bench.js, tools/smoke.js).
 *
 * Runs on Bun or Node. Every command prints what it did and what to do next, and exits non-zero on failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const project = require('./dev/project');

const { ROOT } = project;
/** Flags that take no value; every other `--flag` consumes the next argument. */
const BOOLEAN_FLAGS = new Set(['landscape', 'summary', 'fast', 'force', 'fix', 'update', 'strict', 'all', 'smoke', 'totals', 'touch', 'rigid']);

/**
 * Splits command-line arguments into positionals and flags.
 * @param {string[]} args
 * @returns {{positionals: string[], flags: Object<string, (string|boolean)>}}
 * @example parseArgs(['miner', '--secs', '4', '--landscape']) // { positionals: ['miner'], flags: { secs: '4', landscape: true } }
 */
function parseArgs(args) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index].startsWith('--') ? args[index].slice(2) : null;
    if (name === null) positionals.push(args[index]);
    else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else flags[name] = args[++index];
  }
  return { positionals, flags };
}

/** Applies a scaffold plan: writes and deletes files, then lists what changed. */
const applyPlan = (plan) => {
  Object.keys(plan.writes).forEach((file) => project.writeProjectFile(file, plan.writes[file]));
  plan.deletes.forEach((file) => fs.rmSync(path.join(ROOT, file), { force: true }));
  Object.keys(plan.writes).forEach((file) => console.log(`  wrote   ${file}`));
  plan.deletes.forEach((file) => console.log(`  removed ${file}`));
};

/** Reads a project file, or null when it does not exist. */
const readIfPresent = (file) => (fs.existsSync(path.join(ROOT, file)) ? project.readProjectFile(file) : null);

/** Names of the kit's skins, read from kit/theme.js without loading it. */
const skinNames = () => {
  const { readSource, objectMembers } = require('./dev/source');
  const { code } = readSource(project.readProjectFile('kit/theme.js'));
  const declaration = code.findIndex((token, index) => token.value === 'SKINS' && code[index + 1] && code[index + 1].value === '=' && code[index + 2].value === '{');
  return declaration === -1 ? null : objectMembers(code, declaration + 2).map((member) => member.name);
};

/** Runs a sibling tool with this runtime, passing the terminal through; returns its exit code. */
const delegate = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { cwd: ROOT, stdio: 'inherit' }).status || 0;

// ---- commands --------------------------------------------------------------------------------------------------------

function commandNew({ positionals, flags }) {
  const scaffold = require('./dev/scaffold');
  const [kind, name] = positionals;
  const context = { files: project.listPageFiles(), indexHtml: project.readProjectFile('index.html') };
  if (kind === 'game') {
    applyPlan(scaffold.planGame(name, { ...context, skin: flags.skin, name: flags.name, skins: skinNames() }));
    console.log(`\nNext:\n  1. make it yours: games/${name}.js (rules, tables, theme, the depth plan in its header)\n  2. node tools/dev.js check ${name}            everything that must be green\n  3. node tools/dev.js play ${name} --script scratch/${name}/play.json   scripted playtest with screenshots\n  4. node tools/sim.js ${name} --hours 2          the long arc, simulated\n  5. node tools/dev.js skins ${name}              the game under every skin`);
    return 0;
  }
  if (kind === 'module') {
    applyPlan(scaffold.planModule(name, { ...context, testKit: project.readProjectFile('tools/test-kit.js') }));
    console.log(`\nNext:\n  1. replace the example function in kit/${name}.js and its test in tools/test-kit.js\n  2. node tools/test-kit.js                    the test stub already passes\n  3. node tools/dev.js docs                    regenerate kit/API.md`);
    return 0;
  }
  throw new Error('new what? Usage: node tools/dev.js new game <id> [--skin name] [--name "Title"]   or   new module <name>');
}

function commandRemove({ positionals, flags }) {
  const scaffold = require('./dev/scaffold');
  const [kind, name] = positionals;
  const indexHtml = project.readProjectFile('index.html');
  if (kind === 'game') applyPlan(scaffold.planRemoveGame(name, { gameSource: readIfPresent(`games/${name}.js`), indexHtml, force: flags.force }));
  else if (kind === 'module') applyPlan(scaffold.planRemoveModule(name, { moduleSource: readIfPresent(`kit/${name}.js`), indexHtml, testKit: project.readProjectFile('tools/test-kit.js'), force: flags.force }));
  else throw new Error('remove what? Usage: node tools/dev.js remove game <id>   or   remove module <name>   (only untouched scaffolds, unless --force)');
  return 0;
}

function commandCheck({ positionals, flags }) {
  const { runCheck, renderTable } = require('./dev/check');
  const { rows, passed } = runCheck({ ids: positionals, seconds: flags.secs ? Number(flags.secs) : undefined, withSmoke: !flags.fast });
  console.log(renderTable(rows));
  console.log(passed ? 'CHECK OK' : `CHECK FAILED: ${rows.filter((row) => row.status === 'FAIL').map((row) => row.name).join(', ')}`);
  return passed ? 0 : 1;
}

/** Loads a play script from a .json file or a .js module. */
const loadScript = (file) => {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`no script at ${file}. A script is a JSON array of steps, e.g. ["tap center", "wait 2", "shot start"].`);
  return absolute.endsWith('.json') ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : require(absolute);
};

async function commandPlay({ positionals, flags }) {
  const { parseScript, runSteps, STEPS } = require('./dev/play');
  const { openArcade, parseSize, parseDensity } = require('./dev/browser');
  const [id, ...inlineSteps] = positionals;
  if (!id) throw new Error(`which game? Usage: node tools/dev.js play <id> --script <file>   or   play <id> "tap center" "wait 2" "shot start"\nSteps:\n${Object.keys(STEPS).map((verb) => `  ${STEPS[verb].usage.padEnd(42)} ${STEPS[verb].about}`).join('\n')}`);
  const source = flags.script ? loadScript(flags.script) : flags.do || inlineSteps;
  const script = parseScript(source);
  const session = await openArcade({ landscape: Boolean(flags.landscape) || script.landscape, touch: Boolean(flags.touch) || script.touch, size: flags.size ? parseSize(flags.size) : undefined, density: flags.dpr ? parseDensity(flags.dpr) : undefined });
  try {
    session.outDir = path.resolve(flags.out || path.join(ROOT, 'scratch', id));
    await session.launchGame(id, flags.skin || script.skin);
    const result = await runSteps(session, script.steps);
    console.log(`play ${id}${flags.landscape ? ' (landscape)' : ''}${flags.skin ? ` (skin ${flags.skin})` : ''}`);
    console.log(result.lines.join('\n'));
    return result.passed ? 0 : 1;
  } finally {
    await session.close();
  }
}

async function commandSheet({ positionals, flags }, skinsOf) {
  const { makeSheet } = require('./dev/sheet');
  if (skinsOf === true && !positionals[0]) throw new Error('which game? Usage: node tools/dev.js skins <id>');
  const { file, problems } = await makeSheet(skinsOf === true ? { skinsOf: positionals[0], landscape: Boolean(flags.landscape) } : { ids: positionals, landscape: Boolean(flags.landscape) });
  problems.forEach((problem) => console.log(`  ERROR ${problem}`));
  console.log(`sheet: ${path.relative(ROOT, file)}`);
  return problems.length ? 1 : 0;
}

async function commandProof({ positionals, flags }) {
  const { makeProof } = require('./dev/proof');
  if (!positionals.length) throw new Error('which suites? Usage: node tools/dev.js proof turn rolls options worn extremes acts saves heads faces [--catalog wardrobe|samples] [--preset toon|pixel|soft] [--species person,stout] [--acts walk,wave] [--sockets bottom,outerwear] [--only hair,nose] [--framing head|body] [--pages 2] [--count 64] [--rigid] [--level high|medium|low]');
  const { files, problems } = await makeProof({ suites: positionals, catalog: flags.catalog, preset: flags.preset, species: flags.species ? String(flags.species).split(',') : [], acts: flags.acts ? String(flags.acts).split(',') : undefined, only: flags.only ? String(flags.only).split(',') : [], framing: flags.framing ? String(flags.framing) : undefined, out: flags.out ? path.resolve(flags.out) : undefined, pages: flags.pages ? Number(flags.pages) : undefined, count: flags.count ? Number(flags.count) : undefined, rigid: Boolean(flags.rigid), level: flags.level ? String(flags.level) : undefined, sockets: flags.sockets ? String(flags.sockets).split(',') : undefined });
  files.forEach((file) => console.log(`proof: ${path.relative(ROOT, file)}`));
  problems.forEach((problem) => console.log(`  ${problem}`));
  return problems.some((problem) => problem.startsWith('ERROR')) ? 1 : 0;
}

/** Expands lint targets (files or folders, default kit/ and games/) into root-relative .js files. */
const lintTargets = (paths) =>
  (paths.length ? paths : ['kit', 'games']).flatMap((target) => {
    const relative = path.relative(ROOT, path.resolve(target)).replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, relative))) throw new Error(`nothing to lint at ${target}.`);
    return fs.statSync(path.join(ROOT, relative)).isDirectory() ? project.listScriptsDeep(relative) : [relative];
  });

function commandLint({ positionals, flags }) {
  const { RULES, lintSource, formatFindings, summarize } = require('./dev/lint');
  if (positionals[0] === 'rules') {
    Object.keys(RULES).forEach((rule) => console.log(`${rule.padEnd(15)} ${RULES[rule].tier.padEnd(6)} ${RULES[rule].about}`));
    return 0;
  }
  const files = lintTargets(positionals);
  const findings = files.flatMap((file) => lintSource(file, project.readProjectFile(file)));
  if (flags.summary) {
    summarize(findings, files).forEach((row) => console.log(`${row.file.padEnd(28)} ${String(row.total).padStart(4)}  ${Object.keys(row.byRule).map((rule) => `${rule} ${row.byRule[rule]}`).join(', ')}`));
  } else console.log(formatFindings(findings).join('\n'));
  const errors = findings.filter((finding) => RULES[finding.rule].tier === 'error').length;
  console.log(`${findings.length} findings in ${files.length} files (${errors} from hard rules). \`lint rules\` explains each rule.`);
  return findings.length ? 1 : 0;
}

function commandDocs() {
  const { describeModule, renderApi } = require('./dev/docs');
  const loadOrder = project.scriptSources(project.readProjectFile('index.html')).filter((source) => source.startsWith('kit/'));
  // Modules appear in page load order (foundations first); kit files the page does not load come last.
  const files = [...loadOrder.filter((file) => fs.existsSync(path.join(ROOT, file))), ...project.listScriptsDeep('kit').filter((file) => !loadOrder.includes(file))];
  const modules = files.map((file) => describeModule(file.replace(/^kit\//, ''), project.readProjectFile(file)));
  project.writeProjectFile('kit/API.md', renderApi(modules));
  const entries = modules.reduce((sum, module) => sum + module.entries.length, 0);
  const undocumented = modules.reduce((sum, module) => sum + module.entries.filter((entry) => entry.kind === 'function' && !entry.jsdoc).length, 0);
  console.log(`docs: kit/API.md (${modules.length} modules, ${entries} entries, ${undocumented} without JSDoc)`);
  return 0;
}

function commandTags({ flags }) {
  const html = project.readProjectFile('index.html');
  const { missingFiles, untagged } = project.compareTags(html, project.listPageFiles());
  missingFiles.forEach((file) => console.log(`  MISSING FILE  index.html loads ${file}, which does not exist: remove the tag or add the file`));
  untagged.forEach((file) => console.log(`  NO TAG        ${file} is never loaded: add ${project.tagFor(file)}${flags.fix ? '' : ' (or run with --fix)'}`));
  if (flags.fix && untagged.length) {
    project.writeProjectFile('index.html', untagged.reduce((page, file) => project.insertScriptTag(page, file), html));
    console.log(`  added ${untagged.length} tag(s) to index.html`);
  }
  console.log(missingFiles.length || untagged.length ? `tags: ${missingFiles.length} missing file(s), ${untagged.length} untagged file(s)` : 'tags: OK');
  return missingFiles.length ? 1 : 0;
}

function commandTypes({ positionals, flags }) {
  const { runTypecheck, writeBaseline } = require('./dev/typecheck');
  const result = runTypecheck();
  if (!result.isInstalled) throw new Error('TypeScript is not installed: run `npm install` in the project root.');
  if (flags.update) {
    writeBaseline(result.counts);
    console.log(`types: baseline rewritten (${result.errors.length} errors in ${Object.keys(result.counts).length} files). Only lower it: a rise means new code broke its own docstrings.`);
    return 0;
  }
  result.errors.filter((error) => !positionals.length || positionals.includes(error.file)).forEach((error) => positionals.length && console.log(`${error.file}:${error.line}  ${error.code}  ${error.message}`));
  result.worse.forEach((row) => console.log(`  WORSE  ${row.file}: ${row.now} errors, ${row.allowed} allowed  (node tools/dev.js types ${row.file})`));
  result.better.forEach((row) => console.log(`  BETTER ${row.file}: ${row.now} errors, baseline ${row.allowed}`));
  console.log(`types: ${result.errors.length} errors; ${result.worse.length} files worse than the baseline, ${result.better.length} better${result.better.length ? ' (lock it in: types --update)' : ''}`);
  return result.worse.length ? 1 : 0;
}

function commandFormat({ positionals }) {
  if (!positionals.length) throw new Error('format which files? Usage: node tools/dev.js format games/mine.js   (only files you own: the tree is shared, so nothing is reformatted wholesale)');
  return spawnSync(path.join(ROOT, 'node_modules', '.bin', 'biome'), ['format', '--write', ...positionals], { cwd: ROOT, stdio: 'inherit' }).status || 0;
}

function commandSnapshot({ positionals }) {
  const { takeSnapshot } = require('./dev/safewrite');
  if (!positionals.length) throw new Error('snapshot which files? Usage: node tools/dev.js snapshot kit/ui.js   (before you start rewriting a shared file)');
  positionals.forEach((file) => {
    takeSnapshot(path.relative(ROOT, path.resolve(file)));
    console.log(`  snapshot of ${file} saved; when your rewrite is ready: node tools/dev.js replace ${file} --with <your copy>`);
  });
  return 0;
}

function commandReplace({ positionals, flags }) {
  const { replaceFile } = require('./dev/safewrite');
  if (!positionals[0] || !flags.with) throw new Error('Usage: node tools/dev.js replace kit/ui.js --with scratch/me/ui.js   (after `snapshot kit/ui.js`)');
  const result = replaceFile(path.relative(ROOT, path.resolve(positionals[0])), path.resolve(flags.with));
  const messages = { install: 'replaced (unchanged since the snapshot)', merge: 'replaced, carrying over lines another agent appended since the snapshot', refuse: `NOT replaced: ${result.reason}` };
  console.log(`replace ${positionals[0]}: ${messages[result.action]}`);
  return result.action === 'refuse' ? 1 : 0;
}

async function commandGallery({ flags }) {
  const { openArcade } = require('./dev/browser');
  const session = await openArcade({ landscape: Boolean(flags.landscape) });
  try {
    const ids = await session.gameIds();
    if (!ids.includes('gallery')) {
      console.log(`gallery: no screen is registered under the id "gallery" yet (registered: ${ids.join(', ')}). The UI lead is building it in kit/ui/; this command will photograph it once it exists.`);
      return 1;
    }
    const names = await session.skinNames();
    for (const skin of names) {
      await session.launchGame('gallery', skin);
      await session.shot(path.join(ROOT, 'shots', 'gallery', `${skin}.png`));
      await session.page.evaluate(() => Kit.menu());
    }
    console.log(`gallery: shots/gallery/<skin>.png for ${names.join(', ')}${session.errors.length ? `\n  ERROR ${session.errors.join('\n  ERROR ')}` : ''}`);
    return session.errors.length ? 1 : 0;
  } finally {
    await session.close();
  }
}

function commandMetrics({ flags }) {
  const { reuseRatio, appendLedgerRow, tokensByTier } = require('./dev/metrics');
  const { lintSource } = require('./dev/lint');
  const printTotals = () => tokensByTier(project.readProjectFile('METRICS.md')).forEach((tier) => console.log(`  ${tier.model.padEnd(8)} ${String(Math.round(tier.tokens / 1000)).padStart(6)}k tokens over ${tier.rows} rows`));
  if (flags.totals || !flags.work) {
    console.log('tokens per tier (METRICS.md ledger):');
    printTotals();
    if (!flags.work) console.log('\nAdd a row: node tools/dev.js metrics --work "Sky Stack: rules" --kind piece --model sonnet --effort low --tokens 40k --minutes 6 --load "3 agents" --bar "standard" --rework 0 [--game stack] [--smoke] [--notes "..."]');
    if (!flags.work) return 0;
  }
  const signals = [];
  if (flags.game) {
    const files = project.listScripts('games').filter((file) => project.belongsToGame(file, flags.game));
    if (!files.length) throw new Error(`no files for game "${flags.game}" in games/.`);
    const ratio = reuseRatio(files.map((file) => project.readProjectFile(file)).join('\n'));
    const findings = files.flatMap((file) => lintSource(file, project.readProjectFile(file)));
    signals.push(`${ratio.lines} lines`, `${ratio.kitCalls} kit calls (${ratio.per100Lines}/100 lines)`, `${findings.length} lint findings`);
    if (flags.smoke) signals.push(`smoke ${delegate('smoke.js', [flags.game, '--secs', '6']) === 0 ? 'OK' : 'FAILED'}`);
  }
  const tests = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-kit.js')], { cwd: ROOT, encoding: 'utf8' });
  signals.push((tests.stdout || '').trim().split('\n').pop() || 'tests: no output');
  const row = { work: flags.work, kind: flags.kind, model: flags.model, tokens: flags.tokens, minutes: flags.minutes, load: flags.load, bar: flags.bar, rework: flags.rework, notes: [flags.effort ? `effort ${flags.effort}` : '', flags.notes, ...signals].filter(Boolean).join('; ') };
  project.writeProjectFile('METRICS.md', appendLedgerRow(project.readProjectFile('METRICS.md'), row));
  console.log(`metrics: added a ledger row for "${flags.work}" (${signals.join('; ')})\ntokens per tier:`);
  printTotals();
  return 0;
}

/**
 * Every command: its usage, a one-line summary, an example and its handler.
 * @type {Object<string, {usage: string, about: string, example: string, run: function(Object): (number|Promise<number>)}>}
 */
const COMMANDS = {
  new: { usage: 'new game <id> [--skin s] | new module <name>', about: 'scaffold a game or a kit module that already meets the standard, with its script tag', example: 'node tools/dev.js new game sky-garden --skin paper', run: commandNew },
  remove: { usage: 'remove game <id> | remove module <name>', about: 'undo a scaffold that was never made real (file, tag, test stub)', example: 'node tools/dev.js remove game sky-garden', run: commandRemove },
  check: { usage: 'check [id...] [--fast] [--secs n]', about: 'tests, tags, lint, Biome, types, smoke and frame budgets as one pass / fail table', example: 'node tools/dev.js check miner', run: commandCheck },
  play: { usage: 'play <id> --script <file> [--landscape | --size WxH] [--dpr n] [--skin s] [--touch] [--out dir] | play <id> "step" ...', about: 'scripted playtest (tap, drag, press, choose, wait, until, assert, shot); `play` alone lists the steps', example: 'node tools/dev.js play miner "tap center x5" "wait 2" "assert hud.Depth >= 1" "shot dug"', run: commandPlay },
  sheet: { usage: 'sheet [id...] [--landscape]', about: 'contact sheet of every game into shots/sheet.png', example: 'node tools/dev.js sheet', run: (parsed) => commandSheet(parsed, false) },
  proof: { usage: 'proof <suite...> [--catalog c] [--preset p] [--species a,b] [--acts a,b] [--sockets a,b] [--only socket,dial] [--framing head|body] [--pages n] [--count n] [--rigid] [--level l]', about: 'coverage sheets of the body system (turn, heads, rolls, faces, options, worn, extremes, acts) into shots/proof/', example: 'node tools/dev.js proof turn acts --catalog samples', run: commandProof },
  skins: { usage: 'skins <id>', about: 'one game under every kit skin into shots/skins-<id>.png', example: 'node tools/dev.js skins miner', run: (parsed) => commandSheet(parsed, true) },
  lint: { usage: 'lint [paths] [--summary] | lint rules', about: 'the mechanical parts of the code standard: file:line, rule, fix', example: 'node tools/dev.js lint games/miner.js', run: commandLint },
  docs: { usage: 'docs', about: 'regenerate kit/API.md from the JSDoc in kit/*.js', example: 'node tools/dev.js docs', run: commandDocs },
  tags: { usage: 'tags [--fix]', about: 'compare the script tags in index.html with the files in kit/ and games/', example: 'node tools/dev.js tags', run: commandTags },
  types: { usage: 'types [file...] [--update]', about: 'tsc --checkJs over the JSDoc; a file may not exceed its baseline of errors', example: 'node tools/dev.js types games/miner.js', run: commandTypes },
  format: { usage: 'format <file...>', about: 'format the files you own with Biome (never the whole shared tree)', example: 'node tools/dev.js format games/miner.js', run: commandFormat },
  sim: { usage: 'sim <id> [--hours n] [--policy names]', about: "play a game's headless model for simulated hours and print the progression curve", example: 'node tools/dev.js sim miner --hours 3', run: ({ raw }) => delegate('sim.js', raw) },
  bench: { usage: 'bench [--save] [name...]', about: 'micro-benchmarks of kit hot paths against a saved baseline', example: 'node tools/dev.js bench', run: ({ raw }) => delegate('bench.js', raw) },
  snapshot: { usage: 'snapshot <file...>', about: 'save the base of a shared file before you rewrite it', example: 'node tools/dev.js snapshot kit/ui.js', run: commandSnapshot },
  replace: { usage: 'replace <file> --with <copy>', about: 'install your rewrite only if the file is unchanged since the snapshot (plain appends are carried over)', example: 'node tools/dev.js replace kit/ui.js --with scratch/me/ui.js', run: commandReplace },
  gallery: { usage: 'gallery [--landscape]', about: 'photograph the component gallery screen under every skin into shots/gallery/', example: 'node tools/dev.js gallery', run: commandGallery },
  metrics: { usage: 'metrics --work "..." [--game id] ...', about: 'append a row to the METRICS.md ledger with measured quality signals', example: 'node tools/dev.js metrics --work "Sky Garden" --kind "new game" --tokens 180k --minutes 22 --game sky-garden', run: commandMetrics },
};

/** Prints every command with its one line and example. */
const printHelp = () => {
  console.log('node tools/dev.js <command>     (every command is also a make target: `make help`)\n');
  Object.keys(COMMANDS).forEach((name) => console.log(`  ${COMMANDS[name].usage}\n      ${COMMANDS[name].about}\n      e.g. ${COMMANDS[name].example}\n`));
  console.log('Version control (make only; see AGENTS.md "Version control and worktrees"):\n  make worktree NAME=<branch>   a checkout of your own for a piece of work\n  make worktrees                list them\n  make land NAME=<branch>       merge a finished branch into main after its tests pass\nEvery command here works from any worktree: paths are relative to the checkout and servers pick a free port.');
};

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help') return printHelp();
  const command = COMMANDS[name];
  if (!command) {
    console.error(`dev: unknown command "${name}". Commands: ${Object.keys(COMMANDS).join(', ')}. \`node tools/dev.js help\` explains each.`);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await command.run({ ...parseArgs(rest), raw: rest });
  } catch (error) {
    console.error(`dev ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArgs, COMMANDS };
