/**
 * Dev tools scaffolder: `new game`, `new module` and their undo, `remove`.
 *
 * Owns:  filling the templates in tools/dev/templates/, validating the requested name, and the plan of file
 *        changes each command makes (pure: `planGame` / `planModule` return what to write, they write nothing).
 * Does not own: writing the plan to disk or printing next steps (dev.js), or script-tag placement (project.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { insertScriptTag, removeScriptTag } = require('./project');

const TEMPLATES = path.join(__dirname, 'templates');
/** Same shape Kit.register accepts for an id (kit/core.js GAME_ID_PATTERN); also a safe file name. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** New games sort after the existing ones on the menu until their author picks a place. */
const NEW_GAME_ORDER = 99;
const DEFAULT_SKIN = 'glass';
/** The line every scaffolded game carries until its author makes it their own; `remove game` refuses files without it. */
const SCAFFOLD_MARK = 'Scaffolded by `node tools/dev.js new game';
/** The last line of tools/test-kit.js: test stubs are inserted just above it. */
const TEST_FOOTER_PATTERN = /\npending\.then\(/;

const readTemplate = (name) => fs.readFileSync(path.join(TEMPLATES, name), 'utf8');

/** Replaces every `__KEY__` placeholder of a template. */
const fill = (template, values) => Object.keys(values).reduce((text, key) => text.split(`__${key}__`).join(String(values[key])), template);

/** 'sky-stack' -> 'Sky Stack'. */
const titleOf = (id) => id.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
/** 'wave-field' -> 'waveField' (the property name under Kit). */
const camelOf = (name) => name.replace(/-([a-z0-9])/g, (_match, letter) => letter.toUpperCase());

/** Throws unless the name is usable as an id and a file name. */
const requireValidName = (kind, name) => {
  if (!name) throw new Error(`which ${kind}? Usage: node tools/dev.js new ${kind} <name>   (lowercase letters, digits and dashes, e.g. ${kind === 'game' ? 'sky-stack' : 'waves'})`);
  if (!NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a usable ${kind} name: use lowercase letters, digits and dashes, starting with a letter (e.g. ${kind === 'game' ? 'sky-stack' : 'waves'}).`);
};

/**
 * @typedef {Object} FilePlan
 * @property {Object<string, string>} writes root-relative path -> new contents
 * @property {string[]} deletes root-relative paths to remove
 */

/**
 * Plans a new game: its file, its script tag, a starter playtest script and the lead's plan template.
 * @param {string} id
 * @param {{skin?: string, name?: string, skins?: string[], files: string[], indexHtml: string}} context the skin
 *   and title asked for, the valid skin names, every existing kit and game file, and the page
 * @returns {FilePlan}
 * @throws {Error} naming the problem and the fix (bad id, id taken, unknown skin)
 */
function planGame(id, { skin = DEFAULT_SKIN, name, skins, files, indexHtml }) {
  requireValidName('game', id);
  const taken = files.find((file) => file === `games/${id}.js` || file.startsWith(`games/${id}-`));
  if (taken) throw new Error(`a game "${id}" already exists (${taken}). Pick another id, or remove it first with \`node tools/dev.js remove game ${id}\`.`);
  if (skins && !skins.includes(skin)) throw new Error(`unknown skin "${skin}". Skins: ${skins.join(', ')}.`);
  const values = { ID: id, NAME: name || titleOf(id), SKIN: skin, ORDER: NEW_GAME_ORDER };
  return {
    writes: {
      [`games/${id}.js`]: fill(readTemplate('game.js.tpl'), values),
      [`scratch/${id}/play.json`]: fill(readTemplate('play.json.tpl'), values),
      [`scratch/${id}/PLAN.md`]: fill(readTemplate('plan.md.tpl'), values),
      'index.html': insertScriptTag(indexHtml, `games/${id}.js`),
    },
    deletes: [],
  };
}

/**
 * Plans a new pure kit module: its file, its script tag and a test stub in tools/test-kit.js.
 * @param {string} name
 * @param {{files: string[], indexHtml: string, testKit: string}} context existing files, the page, the test file
 * @returns {FilePlan}
 * @throws {Error} naming the problem and the fix
 */
function planModule(name, { files, indexHtml, testKit }) {
  requireValidName('module', name);
  if (files.includes(`kit/${name}.js`)) throw new Error(`kit/${name}.js already exists. Add to it, or pick another name.`);
  if (!TEST_FOOTER_PATTERN.test(testKit)) throw new Error('tools/test-kit.js no longer ends with its `pending.then(...)` line, so the test stub has nowhere to go. Add the test by hand.');
  const values = { NAME: name, CAMEL: camelOf(name) };
  const stub = fill(readTemplate('module-test.js.tpl'), values);
  return {
    writes: {
      [`kit/${name}.js`]: fill(readTemplate('module.js.tpl'), values),
      'tools/test-kit.js': testKit.replace(TEST_FOOTER_PATTERN, (footer) => `\n${stub.trimEnd()}${footer}`),
      'index.html': insertScriptTag(indexHtml, `kit/${name}.js`),
    },
    deletes: [],
  };
}

/**
 * Plans the removal of a scaffolded game that was never made into a real one.
 * @param {string} id
 * @param {{gameSource: ?string, indexHtml: string, force?: boolean}} context the game file's text (null if absent)
 * @returns {FilePlan}
 * @throws {Error} when the file is missing, or is no longer a scaffold and `force` is not set
 */
function planRemoveGame(id, { gameSource, indexHtml, force = false }) {
  if (gameSource === null) throw new Error(`games/${id}.js does not exist.`);
  if (!gameSource.includes(SCAFFOLD_MARK) && !force) throw new Error(`games/${id}.js is no longer a scaffold (its "Scaffolded by" line is gone), so it is not removed. Pass --force if you are sure.`);
  return { writes: { 'index.html': removeScriptTag(indexHtml, `games/${id}.js`) }, deletes: [`games/${id}.js`, `scratch/${id}/play.json`, `scratch/${id}/PLAN.md`] };
}

/**
 * Plans the removal of a scaffolded kit module that is still exactly as generated.
 * @param {string} name
 * @param {{moduleSource: ?string, indexHtml: string, testKit: string, force?: boolean}} context
 * @returns {FilePlan}
 * @throws {Error} when the module was edited since it was scaffolded and `force` is not set
 */
function planRemoveModule(name, { moduleSource, indexHtml, testKit, force = false }) {
  const values = { NAME: name, CAMEL: camelOf(name) };
  if (moduleSource === null) throw new Error(`kit/${name}.js does not exist.`);
  if (moduleSource !== fill(readTemplate('module.js.tpl'), values) && !force) throw new Error(`kit/${name}.js has been edited since it was scaffolded, so it is not removed. Pass --force if you are sure.`);
  const stub = fill(readTemplate('module-test.js.tpl'), values).trimEnd();
  return { writes: { 'index.html': removeScriptTag(indexHtml, `kit/${name}.js`), 'tools/test-kit.js': testKit.replace(`\n${stub}`, '') }, deletes: [`kit/${name}.js`] };
}

module.exports = { planGame, planModule, planRemoveGame, planRemoveModule, titleOf, camelOf, SCAFFOLD_MARK };
