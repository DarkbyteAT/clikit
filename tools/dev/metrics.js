/**
 * Dev tools metrics: appends a row to the METRICS.md ledger and computes the quality signals that can be
 * measured instead of remembered.
 *
 * Owns:  the reuse ratio (kit calls against lines of game code), formatting a ledger row, and inserting it
 *        after the last row of the ledger table (pure string functions).
 * Does not own: tokens, minutes and load (only the agent that did the work knows them: pass them as flags),
 *        or running lint, tests and smoke (dev.js gathers those and hands them in).
 */
'use strict';

const { readSource, valueAt } = require('./source');

const LEDGER_HEADING = '## Ledger';
const KIT_ROOTS = new Set(['Kit', 'ctx', 'make', 'ui', 'fx', 'sfx', 'input', 'save', 'post']);

/**
 * How much of a game is the kit doing the work: calls into the kit per hundred lines of game code.
 * A call is `Kit.x(...)`, `Kit.x.y(...)` or a call on one of the ctx helpers (make, ui, fx, sfx, input, save, post).
 * @param {string} text a game file's source (or several joined)
 * @returns {{lines: number, kitCalls: number, per100Lines: number}} lines are non-blank lines that are not only comment
 * @complexity O(tokens) time and space
 * @example reuseRatio("Kit.fsm({});\nmake.box(1, 1, 1);").kitCalls // 2
 */
function reuseRatio(text) {
  const { code } = readSource(text);
  const lines = new Set(code.map((token) => token.line)).size;
  const kitCalls = code.filter((token, index) => {
    if (token.type !== 'ident' || !KIT_ROOTS.has(token.value) || valueAt(code, index - 1) === '.' || valueAt(code, index + 1) !== '.') return false;
    // Walk the dotted path; it is a call when the path ends in `(`.
    let cursor = index + 1;
    while (valueAt(code, cursor) === '.' && code[cursor + 1] && code[cursor + 1].type === 'ident') cursor += 2;
    return valueAt(code, cursor) === '(';
  }).length;
  return { lines, kitCalls, per100Lines: lines ? Math.round((kitCalls / lines) * 1000) / 10 : 0 };
}

/**
 * Adds a row to the ledger table.
 * @param {string} markdown contents of METRICS.md
 * @param {{work: string, kind: string, model: string, tokens: string, minutes: string, load: string, bar: string, rework: string, notes: string}} row
 * @returns {string} the new contents, with the row numbered after the last one
 * @throws {Error} when the ledger table cannot be found
 * @complexity O(lines) time and space
 */
function appendLedgerRow(markdown, row) {
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === LEDGER_HEADING);
  if (headingIndex === -1) throw new Error(`METRICS.md has no "${LEDGER_HEADING}" section to add a row to.`);
  // The table is the run of `|` lines after the heading; the new row goes after its last line.
  let lastRowIndex = -1;
  for (let index = headingIndex + 1; index < lines.length && (lastRowIndex === -1 || lines[index].startsWith('|')); index++) {
    if (lines[index].startsWith('|')) lastRowIndex = index;
  }
  if (lastRowIndex === -1) throw new Error('METRICS.md has a Ledger heading but no table under it.');
  const lastNumber = Number((/^\|\s*(\d+)\s*\|/.exec(lines[lastRowIndex]) || [0, 0])[1]);
  const cells = [lastNumber + 1, row.work, row.kind, row.model, row.tokens, row.minutes, row.load, row.bar, row.rework, row.notes].map((cell) => String(cell || '?').replace(/\|/g, '/'));
  lines.splice(lastRowIndex + 1, 0, `| ${cells.join(' | ')} |`);
  return lines.join('\n');
}

/** Multipliers of the suffixes used in the Tokens column. */
const TOKEN_SUFFIXES = { k: 1000, m: 1000000 };

/** '120k' -> 120000; anything unreadable counts as 0. */
const parseTokens = (cell) => {
  const match = /^([\d.]+)\s*([km]?)/i.exec(String(cell).trim());
  return match ? Number(match[1]) * (TOKEN_SUFFIXES[match[2].toLowerCase()] || 1) : 0;
};

/**
 * Totals the ledger's tokens per model tier, so the saving from routing work to cheaper tiers is visible.
 * @param {string} markdown contents of METRICS.md
 * @returns {Array<{model: string, rows: number, tokens: number}>} one entry per tier, largest total first
 * @complexity O(rows) time, O(tiers) space
 * @example tokensByTier(ledger) // [{ model: 'fable', rows: 8, tokens: 1994000 }, { model: 'sonnet', rows: 5, tokens: 662000 }]
 */
function tokensByTier(markdown) {
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === LEDGER_HEADING);
  const totals = new Map();
  lines
    .slice(headingIndex + 1)
    .map((line) => line.split('|').map((cell) => cell.trim()))
    // A data row starts with its number; cells are offset by one because the line opens with a pipe.
    .filter((cells) => /^\d+$/.test(cells[1] || ''))
    .forEach((cells) => {
      // The tier is the first word of the Model cell: notes after it ("fable (no leaves)") do not make a new tier.
      const model = cells[4].toLowerCase().split(/[^a-z0-9.-]/)[0] || '?';
      const total = totals.get(model) || { model, rows: 0, tokens: 0 };
      totals.set(model, { model, rows: total.rows + 1, tokens: total.tokens + parseTokens(cells[5]) });
    });
  return [...totals.values()].sort((first, second) => second.tokens - first.tokens);
}

module.exports = { reuseRatio, appendLedgerRow, tokensByTier, parseTokens };
