/**
 * Dev tools safe replace: rewrite a shared file without losing what another agent changed in the meantime.
 * Promoted from the kit steward's scratch scripts (install.sh, merge-tail.py) so every agent has it.
 *
 * Owns:  the snapshot store (scratch/snapshots/), and the decision of what to do with a rewrite given the
 *        snapshot it was based on and the file as it is now (pure: `planReplace`, `mergeTail`).
 * Does not own: producing the rewrite, or resolving a real conflict (it prints what changed and stops).
 *
 * The flow: `snapshot <file>` before you start rewriting; work on a copy; `replace <file> --with <copy>`.
 * The replace only happens if the file still equals the snapshot and the copy parses; if someone appended
 * lines just before the file's closing line (the usual kit edit), those lines are carried into the copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./project');

const SNAPSHOTS = path.join(ROOT, 'scratch', 'snapshots');
/** The line that closes a kit or game file's wrapper; appended code goes just above it. */
const CLOSING_LINE = '})();';

const snapshotPathOf = (file) => path.join(SNAPSHOTS, file);

/** Does this JavaScript parse? Returns the syntax error's message, or null. */
const syntaxErrorOf = (text) => {
  try {
    new vm.Script(text);
    return null;
  } catch (error) {
    return error.message;
  }
};

/**
 * Carries lines that were appended to a file (just above its closing line) into a rewrite of that file.
 * @param {string} snapshot the file as it was when the rewrite started
 * @param {string} current the file as it is now
 * @param {string} replacement the rewrite
 * @returns {?string} the rewrite with the appended lines inserted above its closing line, or null when the
 *   change is anything other than a pure insertion above the closing line
 * @complexity O(lines) time and space
 * @example mergeTail('a\n})();\n', 'a\nb\n})();\n', 'A\n})();\n') // 'A\nb\n})();\n'
 */
function mergeTail(snapshot, current, replacement) {
  const [base, now, next] = [snapshot, current, replacement].map((text) => text.replace(/\n$/, '').split('\n'));
  const closesProperly = (lines) => lines[lines.length - 1].startsWith(CLOSING_LINE);
  if (![base, now, next].every(closesProperly)) return null;
  const body = base.slice(0, -1);
  const isPureInsert = now.length > base.length && body.every((line, index) => now[index] === line) && now[now.length - 1] === base[base.length - 1];
  if (!isPureInsert) return null;
  const appended = now.slice(body.length, -1);
  return [...next.slice(0, -1), ...appended, next[next.length - 1]].join('\n') + '\n';
}

/**
 * Decides what a replace should do.
 * @param {{snapshot: ?string, current: string, replacement: string}} texts `snapshot` is null when none was taken
 * @returns {{action: 'install'|'merge'|'refuse', text?: string, reason?: string}} `text` is what to write
 * @example planReplace({ snapshot: same, current: same, replacement: rewrite }).action // 'install'
 */
function planReplace({ snapshot, current, replacement }) {
  if (snapshot === null) return { action: 'refuse', reason: 'no snapshot was taken before the rewrite: run `node tools/dev.js snapshot <file>` first, then redo the change on top of the current file.' };
  const merged = current === snapshot ? null : mergeTail(snapshot, current, replacement);
  const text = current === snapshot ? replacement : merged;
  if (text === null) return { action: 'refuse', reason: 'the file changed since the snapshot in a way that is not a plain append: merge by hand (diff the snapshot with the file), then snapshot again.' };
  const syntaxError = syntaxErrorOf(text);
  if (syntaxError) return { action: 'refuse', reason: `the rewrite does not parse: ${syntaxError}` };
  return { action: current === snapshot ? 'install' : 'merge', text };
}

/** Saves a copy of a project file as the base of an upcoming rewrite. */
function takeSnapshot(file) {
  fs.mkdirSync(path.dirname(snapshotPathOf(file)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), snapshotPathOf(file));
}

/**
 * Replaces a project file with a rewrite, if that is safe (see planReplace), and advances the snapshot.
 * @param {string} file root-relative path of the shared file
 * @param {string} replacementFile path of the rewrite
 * @returns {{action: string, reason?: string}}
 */
function replaceFile(file, replacementFile) {
  const target = path.join(ROOT, file);
  const snapshot = fs.existsSync(snapshotPathOf(file)) ? fs.readFileSync(snapshotPathOf(file), 'utf8') : null;
  const plan = planReplace({ snapshot, current: fs.readFileSync(target, 'utf8'), replacement: fs.readFileSync(replacementFile, 'utf8') });
  if (plan.action === 'refuse') return plan;
  // Write beside the target and rename over it: a reader never sees a half-written file.
  fs.writeFileSync(`${target}.replace-tmp`, plan.text);
  fs.renameSync(`${target}.replace-tmp`, target);
  takeSnapshot(file);
  return plan;
}

module.exports = { mergeTail, planReplace, takeSnapshot, replaceFile };
