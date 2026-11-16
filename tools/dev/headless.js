/**
 * Dev tools headless loader: loads the kit and one game in node, without a page, and hands back the game's
 * registration so tools can drive its pure rules (tools/sim.js).
 *
 * Owns:  the node sandbox that stands in for `window`, loading kit files in page order, loading a game's files.
 * Does not own: what is done with the rules (simulate.js), or the browser (browser.js).
 *
 * Kit files that need the DOM or THREE at load time simply fail to load here and are skipped; a game's own files
 * must load without them (keep THREE and document use inside create(ctx)).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, SHELL_SRC, scriptSources, belongsToGame, readProjectFile } = require('./project');

/** Kit files that only make sense in a page; never loaded headlessly. */
const PAGE_ONLY = [SHELL_SRC, 'kit/dev.js'];

/** A fresh sandbox that looks enough like a browser global for the pure kit modules. */
const createSandbox = () => {
  const stored = {};
  const sandbox = {
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: (key) => stored[key] || null, setItem: (key, value) => (stored[key] = value) },
  };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
};

/** Runs one project file in the sandbox. */
const runFile = (sandbox, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });

/**
 * Loads the kit and one game without a page.
 * @param {string} id the game's id
 * @returns {{Kit: Object, definition: Object, headless: ?Object, skipped: string[]}} the sandbox's Kit, the game's
 *   registration, its headless handle (Kit.headlessOf) and the kit files that could not load without a page
 * @throws {Error} when the game has no script tag, cannot load without the DOM, or did not register
 * @complexity O(total size of the kit and the game's files) time; one sandbox of memory
 * @example const { headless } = loadGame('miner');
 */
function loadGame(id) {
  const sources = scriptSources(readProjectFile('index.html')).filter((source) => fs.existsSync(path.join(ROOT, source)));
  const gameFiles = sources.filter((source) => belongsToGame(source, id));
  if (!gameFiles.length) throw new Error(`no script tag in index.html loads games/${id}.js. Check the id, or run \`node tools/dev.js tags\`.`);
  const sandbox = createSandbox();
  const skipped = sources
    .filter((source) => source.startsWith('kit/') && !PAGE_ONLY.includes(source))
    .filter((source) => {
      try {
        runFile(sandbox, source);
        return false;
      } catch {
        return true;
      }
    });
  gameFiles.forEach((file) => {
    try {
      runFile(sandbox, file);
    } catch (error) {
      throw new Error(`${file} cannot load without a page: ${error.message}. Keep THREE and document use inside create(ctx), so the rules above it stay headless.`);
    }
  });
  const definition = sandbox.Kit.games.find((game) => game.id === id);
  if (!definition) throw new Error(`${gameFiles.join(', ')} loaded but no game registered the id "${id}".`);
  return { Kit: sandbox.Kit, definition, headless: sandbox.Kit.headlessOf(definition), skipped };
}

module.exports = { loadGame };
