#!/usr/bin/env bun
/**
 * Progression simulator: plays a game's headless model for hours of simulated time and prints the curve.
 *
 *   make sim GAME=<id> [HOURS=2] [POLICY=greedy,random,saver]
 *   node tools/sim.js <id> [--hours 2] [--policy greedy,saver | --policy ./scratch/<id>/policy.js]
 *                          [--seed 1] [--dead 10] [--all] [--strict]
 *
 * Owns:  the command line: loading the game without a page, choosing policies, printing each policy's report.
 * Does not own: the simulation or its analysis (tools/dev/simulate.js), or loading (tools/dev/headless.js).
 *
 * A game takes part by registering `headless: { progression: { createState, actions, apply, summary } }`
 * (the interface is described at the top of tools/dev/simulate.js; `node tools/dev.js new game` scaffolds one).
 * A custom policy file exports `(actions, random) => action`. Exit code 1 when the game cannot be simulated,
 * or, with --strict, when any policy's run raises a warning.
 */
'use strict';

const path = require('path');
const { loadGame } = require('./dev/headless');
const { POLICIES, simulate, analyze, report } = require('./dev/simulate');

const SECONDS_PER_HOUR = 3600;
const DEFAULT_HOURS = 2;
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : fallback);
const id = args[0] && !args[0].startsWith('--') ? args[0] : null;

/** Stops with a message that says what to do next. */
const fail = (message) => {
  console.error(`sim: ${message}`);
  process.exit(1);
};

/** Resolves a policy name to [name, policy]: a built-in, or a module path exporting the policy function. */
const resolvePolicy = (name) => {
  if (POLICIES[name]) return [name, POLICIES[name]];
  if (!/[./]/.test(name)) fail(`unknown policy "${name}". Built in: ${Object.keys(POLICIES).join(', ')}; or give a path to a module exporting (actions, random) => action.`);
  return [path.basename(name), require(path.resolve(name))];
};

if (!id) fail('which game? Usage: node tools/sim.js <id> [--hours 2] [--policy greedy,random,saver]');
let game;
try {
  game = loadGame(id);
} catch (error) {
  fail(error.message);
}
const progression = game.headless && game.headless.progression;
if (!progression) {
  const has = game.headless ? `its headless handle has ${Object.keys(game.headless).join(', ')} but no \`progression\`` : 'it registers no `headless` handle';
  fail(`game "${id}" cannot be simulated yet: ${has}. Add headless: { progression: { createState, actions, apply, summary } } to its Kit.register call (interface: tools/dev/simulate.js; working example: \`node tools/dev.js new game demo\`).`);
}
const missing = ['createState', 'actions', 'apply', 'summary'].filter((name) => typeof progression[name] !== 'function');
if (missing.length) fail(`game "${id}": headless.progression is missing ${missing.join(', ')} (each must be a function; see tools/dev/simulate.js).`);

const seconds = Number(option('hours', DEFAULT_HOURS)) * SECONDS_PER_HOUR;
const policies = option('policy', Object.keys(POLICIES).join(',')).split(',').map(resolvePolicy);
console.log(`sim ${id}: ${seconds / SECONDS_PER_HOUR} h of simulated play per policy, seed ${option('seed', 1)}`);
let warningCount = 0;
policies.forEach(([name, policy]) => {
  try {
    const log = simulate(progression, policy, { seconds, seed: Number(option('seed', 1)) });
    const analysis = analyze(log, args.includes('--dead') ? { deadMinutes: Number(option('dead')) } : {});
    warningCount += analysis.warnings.length;
    console.log(report(name, log, analysis, { listAll: args.includes('--all') }).join('\n'));
  } catch (error) {
    fail(`policy ${name}: ${error.message}`);
  }
});
console.log(warningCount ? `${warningCount} warning(s)` : 'no warnings');
process.exit(args.includes('--strict') && warningCount ? 1 : 0);
