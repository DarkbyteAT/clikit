#!/usr/bin/env bun
/**
 * Release freezer: publish from a verified snapshot, never from the live tree.
 *
 * Why: many agents edit ROOT at once, so at any instant some file may be half-written. This tool copies the tree,
 * verifies the copy, drops any game that fails in the copy, and leaves a publishable folder plus a manifest.
 *
 *   make release            (or: bun tools/release.js [--secs 5] [--only id,id])
 *
 * Output: ../release/ (index.html, kit/, games/) and ../release/manifest.json
 *   { files: { "kit/core.js": "kit/core.js", ... }, games: [{ id, ok, reason }], tests: "118 tests passed" }
 * Exit code 1 if the unit tests or the menu fail in the snapshot (nothing should be published then).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.resolve(ROOT, '..', 'release');
/** Folders copied into the snapshot. tools/ and vendor/ are needed to verify it but are never published. */
const SNAPSHOT_DIRS = ['kit', 'games', 'tools', 'vendor'];
const PUBLISHED_DIRS = ['kit', 'games'];
const RUNTIME = process.execPath;

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : fallback);
const SMOKE_SECONDS = option('secs', '5');
const ONLY = option('only', '');

/** Run a tool inside the snapshot and capture its output. @returns {{ ok: boolean, output: string }} */
function run(script, scriptArgs = []) {
  const result = spawnSync(RUNTIME, [path.join(RELEASE, 'tools', script), ...scriptArgs], { cwd: RELEASE, encoding: 'utf8', timeout: 240000 });
  return { ok: result.status === 0, output: (result.stdout || '') + (result.stderr || '') };
}

/** Last non-empty line of a tool's output: its verdict. */
const verdict = (output) => output.trim().split('\n').filter(Boolean).pop() || '';

/** Every .js file under a snapshot folder, as a path relative to the snapshot root. */
const scriptsIn = (dir) =>
  fs.existsSync(path.join(RELEASE, dir)) ? fs.readdirSync(path.join(RELEASE, dir)).filter((name) => name.endsWith('.js')).map((name) => `${dir}/${name}`) : [];

/** Does the file parse? A half-written file is the commonest reason a snapshot is unusable. */
const parses = (file) => spawnSync('node', ['--check', path.join(RELEASE, file)]).status === 0;

/** Remove the <script> tags for the given files from the snapshot's page, so a broken game cannot break the menu. */
function dropScripts(files) {
  const pagePath = path.join(RELEASE, 'index.html');
  const page = files.reduce((html, file) => html.replace(new RegExp(`\\s*<script src="${file.replace(/[.\/]/g, '\\$&')}"></script>`), ''), fs.readFileSync(pagePath, 'utf8'));
  fs.writeFileSync(pagePath, page);
}

// 1. Freeze: copy the tree in one go so the snapshot is as close to a single instant as a copy can be.
fs.rmSync(RELEASE, { recursive: true, force: true });
fs.mkdirSync(RELEASE, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(RELEASE, 'index.html'));
SNAPSHOT_DIRS.forEach((dir) => fs.cpSync(path.join(ROOT, dir), path.join(RELEASE, dir), { recursive: true }));
fs.mkdirSync(path.join(RELEASE, 'shots'), { recursive: true });

// 2. Files that do not parse are dropped (games) or fatal (kit: everything depends on it).
const unparsable = PUBLISHED_DIRS.flatMap(scriptsIn).filter((file) => !parses(file));
const brokenKit = unparsable.filter((file) => file.startsWith('kit/'));
if (brokenKit.length) {
  console.log(`FROZEN COPY UNUSABLE: kit files caught mid-edit: ${brokenKit.join(', ')}. Run again in a moment.`);
  process.exit(1);
}
dropScripts(unparsable);

// 3. Unit tests and the menu must pass in the snapshot.
const tests = run('test-kit.js');
const menu = run('smoke.js', ['menu']);
if (!tests.ok || !menu.ok) {
  console.log(`FROZEN COPY UNUSABLE: ${!tests.ok ? 'unit tests failed: ' + verdict(tests.output) : 'menu failed: ' + menu.output.trim().split('\n').slice(-3).join(' | ')}`);
  process.exit(1);
}

// 4. Smoke every registered game; a game that fails is removed from the snapshot rather than blocking the rest.
const registered = (menu.output.match(/games registered = \[(.*)\]/) || ['', ''])[1].split(',').map((id) => id.trim()).filter(Boolean);
const wanted = ONLY ? registered.filter((id) => ONLY.split(',').includes(id)) : registered;
const games = wanted.map((id) => {
  const smoke = run('smoke.js', [id, '--secs', SMOKE_SECONDS]);
  const errorLine = smoke.output.split('\n').find((line) => line.includes('ERROR')) || verdict(smoke.output);
  return { id, ok: smoke.ok, reason: smoke.ok ? '' : errorLine.trim() };
});
const failedIds = games.filter((game) => !game.ok).map((game) => game.id);
// A game may be several files (cozy.js, cozy-data.js ...): drop every file that starts with the failed id.
dropScripts(scriptsIn('games').filter((file) => failedIds.some((id) => path.basename(file).startsWith(id))));

// 5. The manifest lists exactly what the page still references and that exists.
const page = fs.readFileSync(path.join(RELEASE, 'index.html'), 'utf8');
const referenced = [...page.matchAll(/<script src="((?:kit|games)\/[^"]+)"/g)].map((match) => match[1]);
const missing = referenced.filter((file) => !fs.existsSync(path.join(RELEASE, file)));
dropScripts(missing);
const files = Object.fromEntries(referenced.filter((file) => !missing.includes(file)).map((file) => [file, file]));
fs.writeFileSync(path.join(RELEASE, 'manifest.json'), JSON.stringify({ files, games, tests: verdict(tests.output), missing, unparsable }, null, 2));

console.log(`tests: ${verdict(tests.output)}`);
games.forEach((game) => console.log(`  ${game.ok ? 'ok  ' : 'DROP'} ${game.id}${game.reason ? '  ' + game.reason : ''}`));
if (missing.length) console.log(`  not yet written (tags removed): ${missing.join(', ')}`);
console.log(`staged ${Object.keys(files).length} files in ${RELEASE}`);
