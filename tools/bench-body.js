#!/usr/bin/env node
/**
 * The two measurements Kit.body is held to, printed with the machine load at the time.
 *
 *   node tools/bench-body.js            (node --expose-gc tools/bench-body.js also reports heap per individual)
 *
 * Owns:  (1) recipes generated from one species table: nanoseconds per recipe for each stage (roll, resolve,
 *        encode) and bytes per recipe; (2) instances posed per frame: milliseconds per frame for a crowd drawn
 *        from a few recipes, with the number of bakes that crowd cost (it must equal the number of recipes).
 *        (3) instances moved per frame by Kit.motion: milliseconds per frame for the same crowd walking (and
 *        the fish swimming) at each level of detail, and the heap growth per frame when run with --expose-gc.
 *        from a few recipes, with the number of bakes that crowd cost (it must equal the number of recipes);
 *        (3) editor calls as a slider drag makes them: nanoseconds per schema, per edit and per re-bake.
 * Does not own: regression tracking against a baseline (tools/bench.js has rows for the same hot paths), or
 *        the code being measured (kit/*.js, loaded into a node sandbox exactly as the unit tests do).
 *
 * Read the numbers with the load line: the machine is shared, and each figure is the FASTEST of several rounds
 * because other processes can only slow a round down.
 */
'use strict';

const fs = require('fs');
const os = require('os');
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
  'body-store',
  'body-face',
  'body-hair',
  'body-samples',
  'motion',
  'gait',
  'swim',
  'body-wardrobe',
];
/** Sizes of the two measurements, as the brief states them. */
const SIZES = { recipes: 10000, instances: 500, distinctRecipes: 20, frames: 120, rounds: 7, tableSeed: 7, editSteps: 2000 };
const SPECIES_TABLE = [
  { species: 'human', weight: 4 },
  { species: 'elf', weight: 2 },
  { species: 'seraph', weight: 1 },
  { species: 'hound', weight: 2 },
  { species: 'carp', weight: 2 },
];
/** The stand-in pose: every limb root swings this far (radians) through the instance's phase. */
const SWING = 0.6;
const FRAME_SECONDS = 1 / 60;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const FULL_TURN = Math.PI * 2;

/**
 * Loads the kit into THIS context, not a vm sandbox: every global the kit reads (Kit, Math, Float32Array) goes
 * through an interceptor inside a sandbox, which measured about ten times slower than a page runs the same code.
 */
const loadKit = () => {
  global.window = global;
  KIT_FILES.forEach((name) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), { filename: `${name}.js` }));
  return global.Kit;
};

/** The fastest of `rounds` timings of an action, in milliseconds. */
const fastest = (rounds, action) => {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const startedAt = performance.now();
    action();
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
};

/** Measurement 1: recipes from one table. */
const measureRecipes = (Kit, catalog) => {
  const table = catalog.table(SPECIES_TABLE);
  const count = SIZES.recipes;
  const recipes = new Array(count);
  const individuals = new Array(count);
  const encoded = new Array(count);
  const perRecipe = (milliseconds) => Math.round((milliseconds * NANOSECONDS_PER_MILLISECOND) / count);
  const roll = fastest(SIZES.rounds, () => {
    for (let index = 0; index < count; index++) recipes[index] = table.roll(SIZES.tableSeed, index);
  });
  const resolve = fastest(SIZES.rounds, () => {
    for (let index = 0; index < count; index++) individuals[index] = catalog.resolve(recipes[index]);
  });
  const encode = fastest(SIZES.rounds, () => {
    for (let index = 0; index < count; index++) encoded[index] = catalog.encode(recipes[index]);
  });
  const hash = fastest(SIZES.rounds, () => {
    for (let index = 0; index < count; index++) catalog.hash(individuals[index]);
  });
  let heapPerIndividual = null;
  if (typeof global.gc === 'function') {
    individuals.fill(null);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < count; index++) individuals[index] = catalog.resolve(recipes[index]);
    global.gc();
    heapPerIndividual = Math.round((process.memoryUsage().heapUsed - before) / count);
  }
  const bytes = encoded.reduce((sum, packed) => sum + packed.length, 0) / count;
  const distinctLooks = new Set(individuals.map((individual) => catalog.hash(individual))).size;
  return {
    roll: perRecipe(roll),
    resolve: perRecipe(resolve),
    encode: perRecipe(encode),
    hash: perRecipe(hash),
    bytes,
    textLength: Kit.pack.toText(encoded[0]).length,
    heapPerIndividual,
    distinctLooks,
  };
};

/**
 * Measurement 3: what one slider step costs a character editor: the schema it rebuilds, the edit itself, and the
 * bake a renderer asks for afterwards (every step is a new dial value, so every bake is a cache miss).
 * @param {Object} Kit
 * @param {Object} catalog
 * @param {{species: string, dial: string, channel: string, socket: string, part: ?string}} target what to edit
 * @returns {{schema: number, setDial: number, setColor: number, setSocket: number, bake: number}} nanoseconds per call
 */
const measureEditor = (Kit, catalog, target) => {
  const editor = Kit.body.editor(catalog);
  const bakery = catalog.bakery({ capacity: 4 });
  const recipe = { species: target.species, seed: SIZES.tableSeed, overrides: {} };
  const control = editor.schema(recipe).dials.find((dial) => dial.id === target.dial);
  const calls = SIZES.editSteps;
  const perCall = (milliseconds) => Math.round((milliseconds * NANOSECONDS_PER_MILLISECOND) / calls);
  // A drag sweeps the slider across its range, one step per call.
  const valueAt = (step) => control.min + ((control.max - control.min) * (step % Kit.body.DIAL_STEPS)) / Kit.body.DIAL_STEPS;
  let sink = 0;
  const timings = {
    schema: fastest(SIZES.rounds, () => {
      for (let step = 0; step < calls; step++) sink += editor.schema(recipe).dials.length;
    }),
    setDial: fastest(SIZES.rounds, () => {
      for (let step = 0; step < calls; step++) sink += Object.keys(editor.setDial(recipe, target.dial, valueAt(step)).overrides).length;
    }),
    setColor: fastest(SIZES.rounds, () => {
      for (let step = 0; step < calls; step++) sink += Object.keys(editor.setColor(recipe, target.channel, step % 2).overrides).length;
    }),
    setSocket: fastest(SIZES.rounds, () => {
      for (let step = 0; step < calls; step++) sink += Object.keys(editor.setSocket(recipe, target.socket, step % 2 ? target.part : null).overrides).length;
    }),
    bake: fastest(SIZES.rounds, () => {
      for (let step = 0; step < calls; step++) sink += bakery.bakeRecipe(editor.setDial(recipe, target.dial, valueAt(step))).plan.boneCount;
    }),
  };
  if (!Number.isFinite(sink)) throw new Error('bench-body: editor measurement produced nothing.');
  return Object.fromEntries(Object.keys(timings).map((name) => [name, perCall(timings[name])]));
};

/** Prints one editor measurement. */
const printEditor = (title, timings) => {
  console.log(`\n3. ${title}: ${SIZES.editSteps} calls each, one slider step per call`);
  console.log(`   schema    ${String(timings.schema).padStart(7)} ns   (every dial, colour and socket as data)`);
  console.log(`   setDial   ${String(timings.setDial).padStart(7)} ns   (a new value, normalised)`);
  console.log(`   setColor  ${String(timings.setColor).padStart(7)} ns`);
  console.log(`   setSocket ${String(timings.setSocket).padStart(7)} ns`);
  console.log(`   setDial + bake ${String(timings.bake).padStart(7)} ns   (the edit, then the renderer's new bake: a cache miss)`);
};

/** Measurement 2: a crowd of instances from a few recipes, posed and transformed every frame. */
const measureCrowd = (Kit, catalog, { withFeetIk }) => {
  const table = catalog.table(SPECIES_TABLE);
  const bakery = catalog.bakery();
  const crowd = Kit.body.store(SIZES.instances);
  const recipes = Array.from({ length: SIZES.distinctRecipes }, (_unused, index) => table.roll(SIZES.tableSeed, index));
  for (let instance = 0; instance < SIZES.instances; instance++) {
    const slot = crowd.spawn(instance % SIZES.distinctRecipes, (instance % 25) * 2, 0, Math.floor(instance / 25) * 2, instance * 0.1);
    crowd.phase[slot] = (instance * 0.37) % 1;
  }
  // Per distinct look: its bake, one pose and one world buffer shared by every instance of it, and the bones to swing.
  const looks = recipes.map((recipe) => {
    const bake = bakery.bakeRecipe(recipe);
    const limbRoots = ['leg', 'arm', 'wing', 'fin', 'tail'].flatMap((role) => Kit.body.chains(bake.plan, Kit.body.roleMask([role])).map((chain) => chain[0]));
    const legs = Kit.body.chains(bake.plan, Kit.body.roleMask(['leg'])).filter((chain) => chain.length === 3);
    return { bake, limbRoots, legs, pose: Kit.body.createPose(bake.plan), world: Kit.body.createPose(bake.plan) };
  });
  // Every instance asks the bakery again, as a renderer would on spawn: the count of real bakes must stay at the recipe count.
  for (let slot = 0; slot < crowd.liveEnd(); slot++) bakery.bakeRecipe(recipes[crowd.recipe[slot]]);
  let checksum = 0;
  const frame = () => {
    const liveEnd = crowd.liveEnd();
    for (let slot = 0; slot < liveEnd; slot++) {
      if (!crowd.alive[slot]) continue;
      const look = looks[crowd.recipe[slot]];
      const { plan, rest } = look.bake;
      crowd.phase[slot] = (crowd.phase[slot] + FRAME_SECONDS) % 1;
      const swing = Math.sin(crowd.phase[slot] * FULL_TURN) * SWING;
      Kit.rig.copy(rest, look.pose);
      for (let limb = 0; limb < look.limbRoots.length; limb++) Kit.rig.turn(look.pose.rotation, rest.rotation, look.limbRoots[limb], 0, limb % 2 ? swing : -swing);
      Kit.body.worldTransforms(plan, look.pose, look.world, crowd.positionX[slot], crowd.positionY[slot], crowd.positionZ[slot], crowd.heading[slot]);
      if (withFeetIk) {
        // Plant every foot on the ground under its hip, the way a gait would: one two-bone solve per leg.
        for (let leg = 0; leg < look.legs.length; leg++) {
          const [hip, knee, ankle] = look.legs[leg];
          const hipAt = hip * 3;
          const hipX = look.world.translation[hipAt];
          const hipZ = look.world.translation[hipAt + 2];
          Kit.reach.twoBone(plan.parent, look.pose, look.world, hip, knee, ankle, hipX, 0.1, hipZ + swing * 0.2, hipX, 0.5, hipZ + 1, plan.jointLimits);
        }
        Kit.body.worldTransforms(plan, look.pose, look.world, crowd.positionX[slot], crowd.positionY[slot], crowd.positionZ[slot], crowd.heading[slot]);
      }
      checksum += look.world.translation[look.world.translation.length - 2];
    }
  };
  for (let warmUp = 0; warmUp < SIZES.frames; warmUp++) frame();
  const perFrame =
    fastest(SIZES.rounds, () => {
      for (let count = 0; count < SIZES.frames; count++) frame();
    }) / SIZES.frames;
  const bones = looks.reduce((sum, look) => sum + look.bake.plan.boneCount, 0) / looks.length;
  if (!Number.isFinite(checksum)) throw new Error('bench-body: the posed crowd produced a non-finite position.');
  return { perFrame, stats: bakery.stats(), bones };
};

/** Metres per second each walker of measurement 3 travels at; a brisk walk for a person. */
const WALK_SPEED = 1.3;
const DETAIL_NOTES = [
  'full: planted feet, two-bone IK per leg, lean, arms, tails by simulation',
  'no IK: joints swung by the gait clock, one forward pass',
  'not evaluated: the position is tracked, nothing is posed',
];

/** Measurement 3: the crowd of measurement 2 moved by Kit.motion, every instance with its own motion state, at one level of detail. */
const measureMotion = (Kit, catalog, detail) => {
  const table = catalog.table(SPECIES_TABLE);
  const bakery = catalog.bakery();
  const crowd = Kit.body.store(SIZES.instances);
  const bakes = Array.from({ length: SIZES.distinctRecipes }, (_unused, index) => bakery.bakeRecipe(table.roll(SIZES.tableSeed, index)));
  // One controller for every body: legs walk, the rest swim. Capability gating picks per plan.
  const controller = Kit.motion.when({ atLeast: { legs: 2 } }, Kit.gait.walk(), Kit.swim.swim());
  const states = [];
  for (let instance = 0; instance < SIZES.instances; instance++) {
    const slot = crowd.spawn(instance % SIZES.distinctRecipes, (instance % 25) * 2, 0, Math.floor(instance / 25) * 2, instance * 0.1);
    crowd.detail[slot] = detail;
    states[slot] = Kit.motion.state(bakes[crowd.recipe[slot]], controller, { x: crowd.positionX[slot], z: crowd.positionZ[slot], heading: crowd.heading[slot] });
    states[slot].phase = (instance * 0.37) % 1;
  }
  const frame = () => {
    const liveEnd = crowd.liveEnd();
    for (let slot = 0; slot < liveEnd; slot++) {
      crowd.positionX[slot] += Math.sin(crowd.heading[slot]) * WALK_SPEED * FRAME_SECONDS;
      crowd.positionZ[slot] += Math.cos(crowd.heading[slot]) * WALK_SPEED * FRAME_SECONDS;
    }
    Kit.motion.advanceStore(crowd, states, FRAME_SECONDS);
  };
  // Long enough that every instance is up to speed and has made every buffer it will ever make.
  for (let warmUp = 0; warmUp < SIZES.frames * 3; warmUp++) frame();
  let heapPerFrame = null;
  if (typeof global.gc === 'function') {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let count = 0; count < SIZES.frames; count++) frame();
    heapPerFrame = Math.round((process.memoryUsage().heapUsed - before) / SIZES.frames);
  }
  const perFrame =
    fastest(SIZES.rounds, () => {
      for (let count = 0; count < SIZES.frames; count++) frame();
    }) / SIZES.frames;
  const walkers = states.filter((state) => state.memory.gait).length;
  if (!states.every((state) => Number.isFinite(state.world.translation[state.world.translation.length - 2]))) throw new Error('bench-body: the moving crowd produced a non-finite position.');
  return { perFrame, heapPerFrame, walkers, swimmers: states.filter((state) => state.memory.swim).length };
};

function main() {
  const Kit = loadKit();
  const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
  const load = os
    .loadavg()
    .map((value) => value.toFixed(2))
    .join(' ');
  console.log(`bench-body on node ${process.version}, ${os.cpus().length} cores, load average ${load} (1, 5, 15 min)`);
  const recipes = measureRecipes(Kit, catalog);
  console.log(`\n1. ${SIZES.recipes.toLocaleString('en')} recipes from one species table (${SPECIES_TABLE.length} species)`);
  console.log(`   roll     ${String(recipes.roll).padStart(6)} ns per recipe   (table -> { species, seed })`);
  console.log(`   resolve  ${String(recipes.resolve).padStart(6)} ns per recipe   (recipe -> every dial, colour and socket fill)`);
  console.log(`   encode   ${String(recipes.encode).padStart(6)} ns per recipe   (recipe -> bytes)`);
  console.log(`   hash     ${String(recipes.hash).padStart(6)} ns per recipe   (individual -> bake-cache key)`);
  console.log(`   size     ${recipes.bytes.toFixed(1).padStart(6)} bytes per recipe encoded (${recipes.textLength} characters as a text code)`);
  console.log(`   heap     ${recipes.heapPerIndividual === null ? 'not measured (run with node --expose-gc)' : `${String(recipes.heapPerIndividual).padStart(6)} bytes per resolved individual`}`);
  console.log(`   looks    ${recipes.distinctLooks} distinct looks among ${SIZES.recipes} recipes`);
  [false, true].forEach((withFeetIk) => {
    const crowd = measureCrowd(Kit, catalog, { withFeetIk });
    console.log(
      `\n2${withFeetIk ? 'b' : 'a'}. ${SIZES.instances} instances from ${SIZES.distinctRecipes} recipes, posed per frame${withFeetIk ? ' with every foot planted by two-bone IK' : ' (swing every limb root, one forward pass)'}`
    );
    console.log(
      `   ${crowd.perFrame.toFixed(3)} ms per frame (${((crowd.perFrame / (FRAME_SECONDS * 1000)) * 100).toFixed(1)}% of a 60 fps frame), ${crowd.bones.toFixed(1)} bones per body on average`
    );
    console.log(`   distinct bakes ${crowd.stats.bakes} (must be ${SIZES.distinctRecipes}), cache hits ${crowd.stats.hits}, assembled outfits ${crowd.stats.outfits}`);
    if (crowd.stats.bakes !== SIZES.distinctRecipes) {
      console.error(`bench-body: ${crowd.stats.bakes} bakes for ${SIZES.distinctRecipes} recipes: instances are not sharing bakes.`);
      process.exit(1);
    }
  });
  console.log(`\n3. ${SIZES.instances} instances moved by Kit.motion (one motion state each, ${WALK_SPEED} m/s, 60 fps so two fixed steps a frame)`);
  DETAIL_NOTES.forEach((note, detail) => {
    const moved = measureMotion(Kit, catalog, detail);
    // The code makes no objects per frame; what grows is numbers the engine boxes when they cross a call (DECISIONS.md, "Kit.motion: allocation").
    const heap = moved.heapPerFrame === null ? 'heap not measured (run with node --expose-gc)' : `${moved.heapPerFrame} bytes of short-lived heap per frame`;
    console.log(`   detail ${detail}  ${moved.perFrame.toFixed(3)} ms per frame (${((moved.perFrame / (FRAME_SECONDS * 1000)) * 100).toFixed(1)}% of a 60 fps frame), ${heap}`);
    console.log(`             ${note}; ${moved.walkers} walking, ${moved.swimmers} swimming`);
  });
  printEditor('editor on the sample human', measureEditor(Kit, catalog, { species: 'human', dial: 'legLength', channel: 'cloth', socket: 'headTop', part: 'hat' }));
  const wardrobe = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  printEditor('editor on the wardrobe person (46 dials, 14 channels, 21 sockets, a face), a face dial (jaw: every feature is placed again)', measureEditor(Kit, wardrobe, { species: 'person', dial: 'jaw', channel: 'skin', socket: 'hat', part: 'beanie' }));
  printEditor('editor on the wardrobe person, a body dial (height: the placed face is reused)', measureEditor(Kit, wardrobe, { species: 'person', dial: 'height', channel: 'skin', socket: 'hat', part: 'beanie' }));
}

if (require.main === module) main();
