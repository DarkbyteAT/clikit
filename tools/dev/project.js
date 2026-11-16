/**
 * Dev tools project map: where things live, and the script tags that load them.
 *
 * Owns:  the project root, listing kit and game files, and reading / inserting / removing / validating the
 *        `<script src="kit/...">` and `<script src="games/...">` tags of index.html (pure string functions).
 * Does not own: what the files contain (lint.js, docs.js) or running anything (check.js, browser.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Absolute path of the project root (the folder that holds index.html). */
const ROOT = path.resolve(__dirname, '..', '..');
/** The kit file that must load last: it builds the menu from every registered game. */
const SHELL_SRC = 'kit/shell.js';
const LOCAL_TAG_PATTERN = /<script src="((?:kit|games)\/[^"]+)"><\/script>/g;

/** The script tag that loads a local file. */
const tagFor = (src) => `<script src="${src}"></script>`;

/**
 * Lists the local scripts a page loads, in load order.
 * @param {string} html contents of index.html
 * @returns {string[]} e.g. ['kit/core.js', ..., 'games/miner.js', 'kit/shell.js']
 */
const scriptSources = (html) => [...html.matchAll(LOCAL_TAG_PATTERN)].map((match) => match[1]);

/**
 * Adds the script tag for a kit or game file in the right place: a kit module goes after the last kit module
 * (so everything it builds on is already loaded) and a game goes last before the shell.
 * @param {string} html contents of index.html
 * @param {string} src e.g. 'games/orbit.js' or 'kit/waves.js'
 * @returns {string} the new contents; unchanged when the tag is already there
 * @throws {Error} when the page has no kit/shell.js tag to anchor on
 */
function insertScriptTag(html, src) {
  const sources = scriptSources(html);
  if (sources.includes(src)) return html;
  if (!sources.includes(SHELL_SRC)) throw new Error(`index.html has no ${tagFor(SHELL_SRC)} tag to insert before; restore it first.`);
  const lastKitModule = sources.filter((source) => source.startsWith('kit/') && source !== SHELL_SRC).pop();
  const firstGame = sources.find((source) => source.startsWith('games/'));
  if (src.startsWith('kit/') && lastKitModule && (!firstGame || sources.indexOf(lastKitModule) < sources.indexOf(firstGame))) {
    return html.replace(tagFor(lastKitModule), `${tagFor(lastKitModule)}\n${tagFor(src)}`);
  }
  const anchor = src.startsWith('kit/') && firstGame ? firstGame : SHELL_SRC;
  return html.replace(tagFor(anchor), `${tagFor(src)}\n${tagFor(anchor)}`);
}

/**
 * Removes the script tag for a file (and its line).
 * @param {string} html
 * @param {string} src
 * @returns {string}
 */
const removeScriptTag = (html, src) => html.replace(new RegExp(`[ \\t]*${tagFor(src).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\r?\\n?`), '');

/**
 * Compares the page's script tags with the files on disk.
 * @param {string} html contents of index.html
 * @param {string[]} files every kit and game file that exists, e.g. ['kit/core.js', 'games/miner.js']
 * @returns {{missingFiles: string[], untagged: string[]}} tags whose file does not exist (the page gets a 404
 *   and the game never registers), and files no tag loads (the code never runs in the page)
 */
function compareTags(html, files) {
  const sources = scriptSources(html);
  return {
    missingFiles: sources.filter((source) => !files.includes(source)),
    untagged: files.filter((file) => !sources.includes(file)),
  };
}

/** Does this file belong to the game with this id? Games are `games/<id>.js` plus optional `games/<id>-<part>.js`. */
const belongsToGame = (file, id) => file === `games/${id}.js` || file.startsWith(`games/${id}-`);

/** Every .js file directly inside a project folder, as root-relative paths, sorted. */
const listScripts = (folder) =>
  fs
    .readdirSync(path.join(ROOT, folder))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `${folder}/${name}`);

/** Every .js file inside a project folder and its subfolders (kit/ui/ holds the component library). */
const listScriptsDeep = (folder) => [
  ...listScripts(folder),
  ...fs
    .readdirSync(path.join(ROOT, folder), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listScriptsDeep(`${folder}/${entry.name}`)),
];

/** Every kit and game file on disk, subfolders included. */
const listPageFiles = () => [...listScriptsDeep('kit'), ...listScriptsDeep('games')];

/** Reads a project file as text. */
const readProjectFile = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

/** Writes a project file, creating its folder if needed. */
const writeProjectFile = (relativePath, text) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, relativePath), text);
};

module.exports = { ROOT, SHELL_SRC, tagFor, scriptSources, insertScriptTag, removeScriptTag, compareTags, belongsToGame, listScripts, listScriptsDeep, listPageFiles, readProjectFile, writeProjectFile };
