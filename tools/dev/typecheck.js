/**
 * Dev tools type check: runs `tsc --checkJs` over the JSDoc in kit/ and games/ and holds each file to its
 * recorded error count, so docstrings are load-bearing for new code without failing on the backlog.
 *
 * Owns:  running tsc, parsing its output into per-file counts, and comparing them with the baseline
 *        (tools/dev/types-baseline.json): a file may never have more type errors than the baseline says, a
 *        file not in the baseline is allowed none.
 * Does not own: the compiler options (tsconfig.json), the loose ambient globals (tools/dev/types/globals.d.ts)
 *        or the decision to ratchet instead of fixing everything at once (DECISIONS.md, "Types").
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./project');

const BASELINE_FILE = path.join(ROOT, 'tools', 'dev', 'types-baseline.json');
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const ERROR_LINE_PATTERN = /^([^\s(]+)\((\d+),\d+\): error (TS\d+): (.*)$/;

/**
 * Parses tsc's output.
 * @param {string} output
 * @returns {Array<{file: string, line: number, code: string, message: string}>}
 * @complexity O(lines) time and space
 */
const parseTscOutput = (output) =>
  output
    .split('\n')
    .map((line) => ERROR_LINE_PATTERN.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ file: match[1].replace(/\\/g, '/'), line: Number(match[2]), code: match[3], message: match[4] }));

/**
 * Counts errors per file.
 * @param {Array<{file: string}>} errors
 * @returns {Object<string, number>}
 * @complexity O(errors) time, O(files) space
 */
const countByFile = (errors) => {
  const counts = {};
  errors.forEach((error) => (counts[error.file] = (counts[error.file] || 0) + 1));
  return counts;
};

/**
 * Compares current counts with the baseline.
 * @param {Object<string, number>} counts
 * @param {Object<string, number>} baseline
 * @returns {{worse: Array<{file: string, now: number, allowed: number}>, better: Array<{file: string, now: number, allowed: number}>}}
 *   `worse` fails the check; `better` means the baseline can be lowered (`node tools/dev.js types --update`)
 * @complexity O(files) time and space
 */
function compareWithBaseline(counts, baseline) {
  const files = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  const rows = files.map((file) => ({ file, now: counts[file] || 0, allowed: baseline[file] || 0 }));
  return { worse: rows.filter((row) => row.now > row.allowed), better: rows.filter((row) => row.now < row.allowed) };
}

const readBaseline = () => (fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {});

/**
 * Runs the type check.
 * @returns {{isInstalled: boolean, errors: Array<{file: string, line: number, code: string, message: string}>, counts: Object<string, number>,
 *   worse: Array<{file: string, now: number, allowed: number}>, better: Array<{file: string, now: number, allowed: number}>}}
 *   `isInstalled` is false when TypeScript is missing (run `npm install` in the project root)
 */
function runTypecheck() {
  if (!fs.existsSync(TSC)) return { isInstalled: false, errors: [], counts: {}, worse: [], better: [] };
  const result = spawnSync(TSC, ['-p', path.join(ROOT, 'tsconfig.json'), '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
  const errors = parseTscOutput((result.stdout || '') + (result.stderr || ''));
  const counts = countByFile(errors);
  return { isInstalled: true, errors, counts, ...compareWithBaseline(counts, readBaseline()) };
}

/** Records the current counts as the new baseline (sorted, so diffs stay small). */
const writeBaseline = (counts) => {
  const sorted = Object.keys(counts).sort().reduce((ordered, file) => Object.assign(ordered, { [file]: counts[file] }), {});
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + '\n');
};

module.exports = { parseTscOutput, countByFile, compareWithBaseline, runTypecheck, writeBaseline };
