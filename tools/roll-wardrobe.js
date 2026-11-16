#!/usr/bin/env node
/**
 * Rolls characters from the wardrobe catalogue and reports what a creator's "randomise" button would give:
 *
 *   node tools/roll-wardrobe.js [count=1000] [seed=2026]
 *
 * Owns:  the report: validity (every roll validates, bakes, and has its required sockets filled and its face
 *        placed), distinctness (distinct look hashes and outfits), and the share of rolls in which each option of
 *        every socket appears, each colour ramp is used, and each dial lands in the low, middle or high third.
 * Does not own: the catalogue (kit/body-wardrobe.js) or the code it exercises (kit/body-*.js), loaded into this
 *        context exactly as tools/bench-body.js does. Exits 1 when any roll is invalid.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const KIT_FILES = [
  'core',
  'blend',
  'lineage',
  'flags',
  'columns',
  'seeded',
  'pack',
  'palette',
  'surface',
  'region',
  'rig',
  'reach',
  'dynamics',
  'body-plan',
  'body-parts',
  'body-surface',
  'body-recipe',
  'body-edit',
  'body-wardrobe',
];
const DEFAULTS = { count: 1000, seed: 2026 };
/** Features every face must have placed. */
const FACE_FEATURES = ['eye', 'nose', 'mouth', 'ear'];
const THIRDS = ['low', 'mid', 'high'];
const PERCENT = 100;
const COLUMN = 24;

const loadKit = () => {
  global.window = global;
  KIT_FILES.forEach((name) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), { filename: `${name}.js` }));
  return global.Kit;
};

const percent = (part, whole) => `${((PERCENT * part) / Math.max(1, whole)).toFixed(1)}%`;
const countInto = (counts, key) => counts.set(key, (counts.get(key) || 0) + 1);

/** Rolls `count` recipes and gathers every tally the report prints. */
const rollAll = (Kit, catalog, count, seed) => {
  const table = catalog.table(catalog.speciesIds().map((species) => ({ species })));
  const bakery = catalog.bakery({ capacity: 8 });
  const tallies = { species: new Map(), problems: [], hashes: new Set(), outfits: new Set(), sockets: new Map(), colors: new Map(), dials: new Map(), seconds: 0 };
  const startedAt = performance.now();
  for (let index = 0; index < count; index++) {
    const recipe = table.roll(seed, index);
    countInto(tallies.species, recipe.species);
    const problems = catalog.validate(recipe);
    if (problems.length) tallies.problems.push({ index, problems });
    const individual = catalog.resolve(recipe);
    const kind = catalog.species(recipe.species);
    const bake = bakery.bakeRecipe(recipe);
    const placed = new Set(bake.surface.features.map((feature) => feature.id));
    const missingFace = FACE_FEATURES.filter((id) => !placed.has(id));
    if (missingFace.length) tallies.problems.push({ index, problems: [{ code: 'face', message: `no ${missingFace.join(', ')} placed` }] });
    const emptyRequired = catalog.socketsOf(individual).filter((socket) => socket.required && !socket.part);
    if (emptyRequired.length) tallies.problems.push({ index, problems: [{ code: 'socket-required', message: emptyRequired.map((socket) => socket.path).join(', ') }] });
    tallies.hashes.add(catalog.hash(individual));
    tallies.outfits.add(JSON.stringify(individual.fills));
    catalog.socketsOf(individual).forEach((socket) => countInto(tallies.sockets, `${socket.path}\t${socket.part || 'none'}`));
    kind.colorIds.forEach((channel, at) => countInto(tallies.colors, `${channel}\t${kind.palettes[at][individual.colors[at]].id}`));
    kind.dialIds.forEach((id, at) => {
      const share = (individual.dials[at] - kind.dialMin[at]) / (kind.dialMax[at] - kind.dialMin[at] || 1);
      countInto(tallies.dials, `${id}\t${THIRDS[Math.min(THIRDS.length - 1, Math.floor(share * THIRDS.length))]}`);
    });
  }
  tallies.seconds = (performance.now() - startedAt) / 1000;
  return tallies;
};

/** Groups "a\tb" tallies by a, keeping b -> count. */
const byFirst = (counts) => {
  const groups = new Map();
  counts.forEach((value, key) => {
    const [first, second] = key.split('\t');
    if (!groups.has(first)) groups.set(first, new Map());
    groups.get(first).set(second, value);
  });
  return groups;
};

function main() {
  const count = Number(process.argv[2]) || DEFAULTS.count;
  const seed = Number(process.argv[3]) || DEFAULTS.seed;
  const Kit = loadKit();
  const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const tallies = rollAll(Kit, catalog, count, seed);
  console.log(`roll-wardrobe: ${count} characters from table seed ${seed}, ${tallies.seconds.toFixed(2)} s (resolve + validate + bake each)`);
  console.log(`\nspecies: ${[...tallies.species].map(([species, number]) => `${species} ${number}`).join(', ')}`);
  console.log(`valid: ${count - new Set(tallies.problems.map((problem) => problem.index)).size} of ${count}`);
  tallies.problems.slice(0, 5).forEach(({ index, problems }) => console.log(`  roll ${index}: ${problems.map((problem) => `[${problem.code}] ${problem.message}`).join('; ')}`));
  console.log(`distinct looks (hash): ${tallies.hashes.size} of ${count}; distinct outfits (socket fills): ${tallies.outfits.size}`);

  // A socket's shares are of the rolls that HAVE the socket (nested sockets exist only under some parts).
  console.log('\nsockets: share of rolls with each option (of rolls that have the socket)');
  byFirst(tallies.sockets).forEach((options, socket) => {
    const total = [...options.values()].reduce((sum, value) => sum + value, 0);
    const shares = [...options].sort((first, second) => second[1] - first[1]).map(([option, number]) => `${option} ${percent(number, total)}`);
    console.log(`  ${socket.padEnd(COLUMN)} ${String(options.size).padStart(2)} options  ${shares.join(', ')}`);
  });
  console.log('\ncolour channels: ramps used, and the most common one');
  byFirst(tallies.colors).forEach((ramps, channel) => {
    const [top, number] = [...ramps].sort((first, second) => second[1] - first[1])[0];
    const total = [...ramps.values()].reduce((sum, value) => sum + value, 0);
    console.log(`  ${channel.padEnd(COLUMN)} ${String(ramps.size).padStart(2)} ramps used  most common ${top} ${percent(number, total)}`);
  });
  console.log('\ndials: share of rolls in the low / middle / high third of the range');
  byFirst(tallies.dials).forEach((thirds, id) => {
    const total = [...thirds.values()].reduce((sum, value) => sum + value, 0);
    console.log(`  ${id.padEnd(COLUMN)} ${THIRDS.map((third) => percent(thirds.get(third) || 0, total).padStart(6)).join(' ')}`);
  });
  if (tallies.problems.length) process.exit(1);
}

if (require.main === module) main();
