/**
 * Dev tools check: everything that must be green before a change is done, as one table.
 *
 * Owns:  running each check (unit tests, script tags, the code-standard lint, Biome, the type ratchet, the
 *        smoke runs with their frame budgets), turning each tool's output into rows (pure parsers), scoping
 *        (`check miner` fails only on miner's own files; problems elsewhere are shown as warnings) and the table.
 * Does not own: the checks themselves (lint.js, typecheck.js, budgets.js, tools/smoke.js, tools/test-kit.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, compareTags, belongsToGame, listPageFiles, listScripts, readProjectFile } = require('./project');
const { RULES, lintSource } = require('./lint');
const { runTypecheck } = require('./typecheck');
const { checkBudgets } = require('./budgets');

const BIOME = path.join(ROOT, 'node_modules', '.bin', 'biome');
/** Seconds each game is played in a check: long enough to leave the title state and exercise restart. */
const DEFAULT_SMOKE_SECONDS = 6;
/** Real-time allowance per smoked target before the run is abandoned (the machine is shared and slow). */
const SMOKE_TIMEOUT_MS_PER_TARGET = 150000;
const DETAIL_WIDTH = 100;
const MOST_FILES_NAMED = 3;

/**
 * @typedef {Object} CheckRow
 * @property {string} name what was checked
 * @property {'PASS'|'WARN'|'FAIL'|'SKIP'} status only FAIL makes `check` exit non-zero
 * @property {string} detail the reason, in one line
 */

/** Runs a project script with the runtime this process runs on (Bun or Node) and captures its output. */
const runTool = (script, args, timeout) => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
};

/** The last non-empty line of some output: a tool's verdict. */
const lastLine = (output) => output.trim().split('\n').filter(Boolean).pop() || '(no output)';

/** Names a few files and counts the rest, so a detail stays one line. */
const nameSome = (files) => files.slice(0, MOST_FILES_NAMED).join(', ') + (files.length > MOST_FILES_NAMED ? ` and ${files.length - MOST_FILES_NAMED} more` : '');

/** Is this file inside what was asked to be checked? With no ids, everything is. */
const inScopeOf = (ids) => (file) => !ids.length || ids.some((id) => belongsToGame(file, id));

/**
 * Splits problems into the caller's own (a failure) and other people's (a warning), as rows.
 * @param {string} name
 * @param {Array<{file: string, text: string}>} problems
 * @param {function(string): boolean} inScope
 * @param {string} passDetail the detail when there is no problem at all
 * @returns {CheckRow[]}
 */
function scopedRows(name, problems, inScope, passDetail) {
  const own = problems.filter((problem) => inScope(problem.file));
  const others = problems.filter((problem) => !inScope(problem.file));
  const describe = (list) => `${list.length}: ${list[0].text}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;
  return [
    own.length ? { name, status: 'FAIL', detail: describe(own) } : { name, status: 'PASS', detail: passDetail },
    ...(others.length ? [{ name: `${name} (other files)`, status: 'WARN', detail: describe(others) }] : []),
  ];
}

/** Unit tests: the kit's and the dev tools' own. */
const unitTestRows = () =>
  ['test-kit.js', 'test-dev.js']
    .filter((script) => fs.existsSync(path.join(ROOT, 'tools', script)))
    .map((script) => {
      const { status, output } = runTool(script, []);
      return { name: `unit tests (${script})`, status: status === 0 ? 'PASS' : 'FAIL', detail: status === 0 ? lastLine(output) : lastLine(output.split('\n').filter((line) => !/^\s+at /.test(line)).join('\n')) };
    });

/** Script tags: a tag without a file is a failure for whoever owns it; a file without a tag never runs in the page. */
const tagRows = (inScope) => {
  const { missingFiles, untagged } = compareTags(readProjectFile('index.html'), listPageFiles());
  const problems = missingFiles.map((file) => ({ file, text: `index.html loads ${file}, which does not exist (remove the tag or add the file)` }));
  return [
    ...scopedRows('script tags', problems, inScope, 'every script tag has its file'),
    // An untagged file may be deliberate (a node-only module or a headless model), so it is shown, not failed.
    ...(untagged.length ? [{ name: 'script tags (untagged)', status: 'WARN', detail: `never loaded by the page: ${nameSome(untagged)} (node tools/dev.js tags)` }] : []),
  ];
};

/** The code-standard lint: exact rules fail, heuristic rules warn. */
const lintRows = (inScope) => {
  const findings = [...listPageFiles(), ...listScripts('tools/dev')].flatMap((file) => lintSource(file, readProjectFile(file)));
  const asProblem = (finding) => ({ file: finding.file, text: `${finding.file}:${finding.line} ${finding.rule}: ${finding.message}` });
  const errors = findings.filter((finding) => RULES[finding.rule].tier === 'error').map(asProblem);
  const ownWarnings = findings.filter((finding) => RULES[finding.rule].tier === 'warn' && inScope(finding.file));
  const files = [...new Set(ownWarnings.map((finding) => finding.file))];
  return [
    ...scopedRows('lint: hard rules', errors, inScope, 'header, no TODO, no console.log, no raw timers or listeners'),
    ownWarnings.length
      ? { name: 'lint: code standard', status: 'WARN', detail: `${ownWarnings.length} findings in ${files.length} files (node tools/dev.js lint --summary)` }
      : { name: 'lint: code standard', status: 'PASS', detail: 'no findings' },
  ];
};

/**
 * Parses Biome's `--reporter=github` output.
 * @param {string} output
 * @returns {Array<{severity: string, rule: string, file: string, line: number, message: string}>} files are root-relative
 * @complexity O(lines) time and space
 */
const parseBiomeOutput = (output) =>
  output
    .split('\n')
    .map((line) => /^::(error|warning|notice) title=([^,]+),file=([^,]+),line=(\d+)[^:]*::(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ severity: match[1], rule: match[2], file: path.relative(ROOT, match[3]).replace(/\\/g, '/'), line: Number(match[4]), message: match[5] }));

/** Biome: generic correctness lint (unused and undeclared names, use before declaration, accidental O(n^2) spreads). */
const biomeRows = (inScope) => {
  if (!fs.existsSync(BIOME)) return [{ name: 'biome', status: 'SKIP', detail: 'not installed: run `npm install` in the project root' }];
  const result = spawnSync(BIOME, ['lint', '--max-diagnostics=none', '--reporter=github', 'kit', 'games', 'tools'], { cwd: ROOT, encoding: 'utf8' });
  const diagnostics = parseBiomeOutput((result.stdout || '') + (result.stderr || ''));
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => ({ file: diagnostic.file, text: `${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}: ${diagnostic.message}` }));
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== 'error' && inScope(diagnostic.file));
  return [...scopedRows('biome: errors', errors, inScope, 'no errors'), ...(warnings.length ? [{ name: 'biome: warnings', status: 'WARN', detail: `${warnings.length} (npx biome lint <file> shows them)` }] : [])];
};

/** The type ratchet: a file may not have more type errors than its baseline. */
const typeRows = (inScope) => {
  const result = runTypecheck();
  if (!result.isInstalled) return [{ name: 'types', status: 'SKIP', detail: 'TypeScript not installed: run `npm install` in the project root' }];
  const problems = result.worse.map((row) => ({ file: row.file, text: `${row.file} has ${row.now} type errors, ${row.allowed} allowed (node tools/dev.js types ${row.file})` }));
  const improved = result.better.length ? `; ${result.better.length} files beat their baseline (node tools/dev.js types --update)` : '';
  return scopedRows('types (tsc --checkJs ratchet)', problems, inScope, `${result.errors.length} known errors, none new${improved}`);
};

/**
 * @typedef {Object} SmokeResult
 * @property {string[]} errors the `ERROR [id]` lines
 * @property {string[]} warnings the `WARN [id]` lines (kit development warnings)
 * @property {?string} summary the `id: ~N fps | hud: ...` line (or the menu's line), without the id
 * @property {?Object} probe the frame probe printed as `PROBE [id] {...}`
 */

/**
 * Parses the output of tools/smoke.js.
 * @param {string} output
 * @returns {Object<string, SmokeResult>} keyed by target id ('menu' included)
 * @complexity O(lines) time and space
 */
function parseSmokeOutput(output) {
  const results = {};
  const resultOf = (id) => (results[id] = results[id] || { errors: [], warnings: [], summary: null, probe: null });
  output.split('\n').forEach((line) => {
    const tagged = /^\s+(ERROR|WARN|PROBE) \[([^\]]+)\] (.*)$/.exec(line);
    const summary = /^([a-z][a-z0-9-]*): (.*)$/.exec(line);
    if (tagged && tagged[1] === 'ERROR') resultOf(tagged[2]).errors.push(tagged[3]);
    if (tagged && tagged[1] === 'WARN') resultOf(tagged[2]).warnings.push(tagged[3]);
    if (tagged && tagged[1] === 'PROBE') resultOf(tagged[2]).probe = JSON.parse(tagged[3]);
    // The first line a target prints is its summary; later lines (the menu's scroll report) are appended to it.
    if (summary) resultOf(summary[1]).summary = resultOf(summary[1]).summary ? `${resultOf(summary[1]).summary} | ${summary[2]}` : summary[2];
  });
  return results;
}

/** One row per smoked target: page errors, crashes and frame budgets fail; kit warnings are noted. */
const smokeRows = (ids, seconds) => {
  const targets = ids.length ? ['menu', ...ids] : ['all'];
  const expectedCount = ids.length ? targets.length : listScripts('games').length + 1;
  const { status, output } = runTool('smoke.js', [targets.join(','), '--secs', String(seconds)], expectedCount * SMOKE_TIMEOUT_MS_PER_TARGET);
  const results = parseSmokeOutput(output);
  // With `all`, the games to expect are the ones the menu said it registered, so a run that died half-way
  // shows the games it never reached as failures instead of leaving them out.
  const registered = ((results.menu && /games registered = \[(.*)\]/.exec(results.menu.summary || '')) || [null, ''])[1].split(',').map((id) => id.trim()).filter(Boolean);
  const names = ids.length ? targets : results.menu ? ['menu', ...registered] : [];
  if (!names.length) return [{ name: 'smoke', status: 'FAIL', detail: `no result (exit ${status}): ${lastLine(output)}` }];
  const rows = names.map((id) => {
    const result = results[id];
    if (!result) return { name: `smoke ${id}`, status: 'FAIL', detail: `no result (exit ${status}): ${lastLine(output)}` };
    const breaches = result.probe ? checkBudgets(result.probe, id) : [];
    const problems = [...result.errors, ...breaches.map((breach) => `over budget: ${breach}`)];
    const notes = result.warnings.length ? ` | ${result.warnings.length} kit warning(s): ${result.warnings[0]}` : '';
    const cost = result.probe ? ` | ${result.probe.calls} calls, ${result.probe.triangles} tris, ${result.probe.meshes} meshes` : '';
    if (problems.length) return { name: `smoke ${id}`, status: 'FAIL', detail: problems.join(' | ') };
    return { name: `smoke ${id}`, status: result.warnings.length ? 'WARN' : 'PASS', detail: `${result.summary || 'ok'}${cost}${notes}` };
  });
  // A crash of the smoke tool itself (not a game) must not pass silently.
  return status === 0 || rows.some((row) => row.status === 'FAIL') ? rows : [...rows, { name: 'smoke', status: 'FAIL', detail: `exit ${status}: ${lastLine(output)}` }];
};

/**
 * Renders rows as a compact table.
 * @param {CheckRow[]} rows
 * @returns {string}
 * @example renderTable([{ name: 'unit tests', status: 'PASS', detail: '120 tests passed' }])
 */
function renderTable(rows) {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 'check'.length);
  const line = (name, status, detail) => `${name.padEnd(nameWidth)}  ${status.padEnd(4)}  ${detail.length > DETAIL_WIDTH ? detail.slice(0, DETAIL_WIDTH - 3) + '...' : detail}`;
  return [line('check', 'what', 'detail'), line('-'.repeat(nameWidth), '----', '------'), ...rows.map((row) => line(row.name, row.status, row.detail))].join('\n');
}

/**
 * Runs every check.
 * @param {{ids?: string[], seconds?: number, withSmoke?: boolean}} [options] `ids`: games to check (default all);
 *   `withSmoke: false` runs only the static checks (seconds instead of minutes)
 * @returns {{rows: CheckRow[], passed: boolean}}
 */
function runCheck({ ids = [], seconds = DEFAULT_SMOKE_SECONDS, withSmoke = true } = {}) {
  const inScope = inScopeOf(ids);
  const rows = [...unitTestRows(), ...tagRows(inScope), ...lintRows(inScope), ...biomeRows(inScope), ...typeRows(inScope), ...(withSmoke ? smokeRows(ids, seconds) : [{ name: 'smoke', status: 'SKIP', detail: 'skipped (--fast)' }])];
  return { rows, passed: !rows.some((row) => row.status === 'FAIL') };
}

module.exports = { runCheck, renderTable, parseSmokeOutput, parseBiomeOutput, scopedRows };
