#!/usr/bin/env bun
/**
 * Micro-benchmarks for the kit's hot paths, with a saved baseline to flag regressions against.
 *
 *   make bench                      (or: node tools/bench.js [name...] [--save] [--strict])
 *
 * Owns:  the benchmark table (what is measured and at what size), the timing loop, the baseline file
 *        (tools/bench-baseline.json) and the comparison with it.
 * Does not own: the code being measured (kit/*.js, loaded into a node sandbox exactly as the unit tests do).
 *
 * How to read it: each line is operations per second, and the same number relative to a calibration loop run
 * in the same process. The machine is shared and its speed swings by several times, so regressions are judged
 * on the RELATIVE score (the fastest sample of the operation over the fastest sample of the calibration,
 * taken in alternating rounds), which cancels most of the machine's load. It does not cancel the runtime:
 * Bun and Node optimise differently (measured: relative scores differ by 2-3x), so each has its own baseline.
 * A benchmark is flagged when its relative score falls more than TOLERANCE below the baseline. `--save` records
 * the current scores as the baseline (do it after a deliberate change, on a quiet machine if you can);
 * `--strict` makes a flagged regression exit non-zero.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'bench-baseline.json');
/** Pure kit files the benchmarks need, in load order. */
const KIT_FILES = [
  'core',
  'model',
  'flow',
  'space',
  'loot',
  'net',
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
  'body-store',
  'body-face',
  'body-hair',
  'body-samples',
  'figure-shapes',
  'figure-layout',
  'sculpt',
  'figure-detail',
  'figure-sculpt',
];
/** Timing: each sample runs the operation in batches for about this long; each benchmark takes ROUNDS rounds. */
const SAMPLE_MS = 80;
const ROUNDS = 7;
const WARM_UP_SAMPLES = 3;
/**
 * A relative score this far below its baseline is flagged (0.5 = half the speed). Measured noise on this shared
 * machine is up to about 40% between identical runs, so only a change of algorithmic size is trusted.
 */
const TOLERANCE = 0.5;
const MS_PER_SECOND = 1000;

/** Sizes of the benchmark inputs, chosen to match what games actually build. */
const SIZES = { gridSide: 32, wallChance: 0.2, linePoints: 200, statModifiers: 40, netKeys: 50, seed: 7 };

/** A samples human and its layout at a level of detail: what the sculpt benchmarks sculpt. */
const sculptCase = (Kit, level) => {
  const bake = Kit.body.catalog(Kit.body.samples.CATALOG).bakery({ capacity: 4 }).bakeRecipe({ species: 'human', seed: SIZES.seed });
  return { bake, layout: Kit.figure.layout(bake, { level }) };
};

/** Loads the pure kit modules into a sandbox, as tools/test-kit.js does. */
const loadKit = () => {
  const stored = {};
  const sandbox = {
    console,
    performance,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: (key) => stored[key] || null, setItem: (key, value) => (stored[key] = value) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  KIT_FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  return sandbox.Kit;
};

/**
 * The benchmarks: name -> what it measures, its stated cost, and a setup that returns the operation to time.
 * Adding a benchmark means adding a row.
 * @type {Object<string, {about: string, cost: string, setup: function(Object): function(): *}>}
 */
const BENCHMARKS = {
  calibration: {
    about: 'fixed arithmetic loop; every other score is divided by this one',
    cost: 'O(1)',
    setup: () => {
      let total = 0;
      return () => {
        for (let step = 0; step < 100; step++) total = (total + Math.sqrt(step) * 1.0001) % 1000;
        return total;
      };
    },
  },
  'path.sample': {
    about: 'one sample of a composed Kit.path (lissajous + wobble)',
    cost: 'O(combinators)',
    setup: (Kit) => {
      const follow = Kit.path.add(Kit.path.lissajous(1, 2), Kit.path.wobble(0.15, 5));
      let time = 0;
      return () => follow((time += 0.016));
    },
  },
  'grid.path': {
    about: `shortest path corner to corner on a ${SIZES.gridSide}x${SIZES.gridSide} grid with scattered walls`,
    cost: 'O(cells log cells)',
    setup: (Kit) => {
      const { grid, isOpen } = buildGrid(Kit);
      const last = SIZES.gridSide - 1;
      return () => grid.path({ x: 0, y: 0 }, { x: last, y: last }, isOpen);
    },
  },
  'grid.flood': {
    about: `flood fill from a corner of the same ${SIZES.gridSide}x${SIZES.gridSide} grid`,
    cost: 'O(cells)',
    setup: (Kit) => {
      const { grid, isOpen } = buildGrid(Kit);
      return () => grid.flood(0, 0, isOpen);
    },
  },
  'line.nearest': {
    about: `closest point on a ${SIZES.linePoints}-point polyline`,
    cost: 'O(points)',
    setup: (Kit) => {
      const points = Array.from({ length: SIZES.linePoints }, (_unused, index) => ({ x: index, y: Math.sin(index / 9) * 20 }));
      const target = { x: SIZES.linePoints / 2, y: 30 };
      return () => Kit.line.nearest(points, target);
    },
  },
  'loot.roll': {
    about: 'one item from a three-rarity, three-base, two-affix table',
    cost: 'O(rarities + bases + affixes)',
    setup: (Kit) => {
      const loot = Kit.loot({
        rarities: [
          { id: 'common', name: 'Common', weight: 70, affixes: 0, mult: 1 },
          { id: 'rare', name: 'Rare', weight: 25, affixes: 1, mult: 1.5 },
          { id: 'epic', name: 'Epic', weight: 5, affixes: 2, mult: 2 },
        ],
        bases: [
          { id: 'cleaver', name: 'Cleaver', slot: 'weapon', mods: { damage: { add: 4 } } },
          { id: 'charm', name: 'Charm', slot: 'charm', mods: { speed: { mul: 1.1 } } },
          { id: 'staff', name: 'Staff', slot: 'weapon', mods: { damage: { add: 2 } } },
        ],
        affixes: [
          { id: 'vamp', prefix: 'Vampiric', mods: { leech: { add: 1 } }, slots: ['weapon'] },
          { id: 'ember', suffix: 'of Embers', mods: { damage: { mul: 1.2 } } },
        ],
        rng: Kit.rng(SIZES.seed),
      });
      return () => loot.roll({ level: 3 });
    },
  },
  'net.set+accept': {
    about: `one key written by a peer and delivered to another (loopback, ${SIZES.netKeys} keys in rotation)`,
    cost: 'O(1) per write',
    setup: (Kit) => {
      const hub = Kit.net.loopback();
      const sender = Kit.net.session(hub.join('sender'));
      const receiver = Kit.net.session(hub.join('receiver'));
      let count = 0;
      return () => {
        sender.set(`key/${count % SIZES.netKeys}`, count++);
        // One second of ticks refills the rate limiter and flushes the outbox, so every write is really delivered.
        sender.tick(1);
        receiver.tick(1);
      };
    },
  },
  'stats.get': {
    about: `one modifier changed, then the stat read, with ${SIZES.statModifiers} modifier sources (a bare read is cached and measures nothing)`,
    cost: 'O(sources) per read after a change',
    setup: (Kit) => {
      const stats = Kit.stats({ damage: 10 });
      for (let source = 0; source < SIZES.statModifiers; source++) stats.mod(`source-${source}`, { damage: { add: 1, mul: 1.01 } });
      let bonus = 0;
      return () => {
        stats.mod('source-0', { damage: { add: (bonus = (bonus + 1) % SIZES.statModifiers) } });
        return stats.get('damage');
      };
    },
  },
  'body.resolve': {
    about: 'one body recipe rolled from a species table and resolved (every dial, colour and socket fill); tools/bench-body.js reports it in ns and bytes',
    cost: 'O(fields of the species)',
    setup: (Kit) => {
      const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
      const table = catalog.table([{ species: 'human' }, { species: 'hound' }, { species: 'carp' }]);
      let index = 0;
      return () => catalog.resolve(table.roll(SIZES.seed, index++));
    },
  },
  'body.pose': {
    about: 'one 18-bone biped posed: copy the rest pose, swing four limbs, one forward-kinematics pass',
    cost: 'O(bones)',
    setup: (Kit) => {
      const plan = Kit.body.catalog(Kit.body.samples.CATALOG).plans.biped;
      const rest = Kit.body.createPose(plan);
      const pose = Kit.body.createPose(plan);
      const world = Kit.body.createPose(plan);
      const limbs = ['thighLeft', 'thighRight', 'upperArmLeft', 'upperArmRight'].map((name) => plan.boneIndex(name));
      let phase = 0;
      return () => {
        phase += 0.1;
        Kit.rig.copy(rest, pose);
        limbs.forEach((bone, index) => Kit.rig.turn(pose.rotation, rest.rotation, bone, 0, Math.sin(phase + index)));
        return Kit.body.worldTransforms(plan, pose, world, phase, 0, 0, phase);
      };
    },
  },
  'reach.twoBone': {
    about: 'one two-bone inverse-kinematics solve with joint limits (a leg of the same biped)',
    cost: 'O(1)',
    setup: (Kit) => {
      const plan = Kit.body.catalog(Kit.body.samples.CATALOG).plans.biped;
      const pose = Kit.body.createPose(plan);
      const world = Kit.body.worldTransforms(plan, pose, Kit.body.createPose(plan));
      const [hip, knee, ankle] = ['thighLeft', 'shinLeft', 'footLeft'].map((name) => plan.boneIndex(name));
      let phase = 0;
      return () => Kit.reach.twoBone(plan.parent, pose, world, hip, knee, ankle, 0.1, 0.2 + 0.1 * Math.sin((phase += 0.1)), 0.2, 0.1, 0.5, 2, plan.jointLimits);
    },
  },
  'sculpt.figure.low': {
    about: 'a samples human sculpted afresh at low detail: fields, layers, culling, one simplified surface',
    cost: 'O(surface area / cell^2) distance calls + O(vertices log vertices) to simplify',
    setup: (Kit) => {
      const { bake, layout } = sculptCase(Kit, 'low');
      return () => {
        Kit.figure.sculptCache.clear();
        return Kit.figure.sculptLayers(bake, layout);
      };
    },
  },
  'sculpt.figure.far': {
    about: 'the same human at far detail (the grid of low, simplified to a crowd member)',
    cost: 'as sculpt.figure.low',
    setup: (Kit) => {
      const { bake, layout } = sculptCase(Kit, 'far');
      return () => {
        Kit.figure.sculptCache.clear();
        return Kit.figure.sculptLayers(bake, layout);
      };
    },
  },
  'sculpt.simplify': {
    about: 'Kit.sculpt.simplify of that human meshed at medium (about 16 k triangles) to the medium tolerance, skin guarded',
    cost: 'O(vertices log vertices)',
    setup: (Kit) => {
      const { bake, layout } = sculptCase(Kit, 'medium');
      const { surface } = Kit.figure.sculptLayers(bake, layout, { simplify: false });
      const tolerance = Kit.sculpt.DETAIL.medium.cell * Kit.sculpt.DETAIL.medium.error;
      return () => Kit.sculpt.simplify(surface, { tolerance, skin: surface });
    },
  },
  'figure.detailFor': {
    about: 'the level of detail for a height in pixels, with the level shown (asked per figure per frame)',
    cost: 'O(bands)',
    setup: (Kit) => {
      let pixels = 40;
      let shown = 'low';
      return () => {
        pixels = pixels > 900 ? 40 : pixels + 7;
        shown = Kit.figure.detailFor(pixels, shown);
        return shown;
      };
    },
  },
};

/** A seeded grid with scattered walls and its "can walk here" test (the corners are kept open). */
function buildGrid(Kit) {
  const random = Kit.rng(SIZES.seed);
  const last = SIZES.gridSide - 1;
  const isCorner = (x, y) => (x === 0 && y === 0) || (x === last && y === last);
  const grid = Kit.grid(SIZES.gridSide, SIZES.gridSide, { fill: (x, y) => (!isCorner(x, y) && random.chance(SIZES.wallChance) ? '#' : '.') });
  return { grid, isOpen: (cell) => cell !== '#' };
}

/**
 * Times one sample of an operation.
 * @param {function(): *} operation
 * @returns {number} operations per second over about SAMPLE_MS
 * @complexity O(SAMPLE_MS) wall-clock time, O(1) space
 */
function sample(operation) {
  let calls = 0;
  let elapsed = 0;
  const startedAt = performance.now();
  // Batches of doubling size keep the clock reads from dominating a fast operation.
  for (let batch = 16; elapsed < SAMPLE_MS; batch *= 2) {
    for (let call = 0; call < batch; call++) operation();
    calls += batch;
    elapsed = performance.now() - startedAt;
  }
  return (calls / elapsed) * MS_PER_SECOND;
}

/**
 * Measures an operation against the calibration loop. Rounds alternate between the two, and the FASTEST sample
 * of each is kept: other processes can only slow a sample down, never speed it up, so the fastest one is the
 * least disturbed (the usual "minimum time" estimator). Their ratio is the relative score.
 * @param {function(): *} operation
 * @param {function(): *} calibrate the calibration operation
 * @returns {{opsPerSecond: number, relative: number}} the fastest sample, and its ratio to the fastest calibration
 * @complexity O(ROUNDS x SAMPLE_MS) wall-clock time, O(1) space
 */
function measure(operation, calibrate) {
  // Warm up by time, not by call count: the optimising tiers of both runtimes (JSC especially) only settle after
  // tens of milliseconds of running, and a baseline saved before that reads several times too slow.
  for (let warmUp = 0; warmUp < WARM_UP_SAMPLES; warmUp++) sample(operation);
  let fastestCalibration = 0;
  let fastest = 0;
  for (let round = 0; round < ROUNDS; round++) {
    fastestCalibration = Math.max(fastestCalibration, sample(calibrate));
    fastest = Math.max(fastest, sample(operation));
  }
  return { opsPerSecond: fastest, relative: fastest / fastestCalibration };
}

/**
 * Compares a relative score with its baseline.
 * @param {number} relative this run's score divided by the calibration score
 * @param {number|undefined} baseline the saved relative score, if any
 * @param {number} [tolerance=TOLERANCE]
 * @returns {{verdict: 'new'|'ok'|'SLOWER'|'faster', change: number}} `change` is the fractional difference (-0.4 = 40% slower)
 * @example judge(0.5, 1) // { verdict: 'SLOWER', change: -0.5 }
 */
function judge(relative, baseline, tolerance = TOLERANCE) {
  if (!baseline) return { verdict: 'new', change: 0 };
  const change = relative / baseline - 1;
  if (change < -tolerance) return { verdict: 'SLOWER', change };
  return { verdict: change > tolerance ? 'faster' : 'ok', change };
}

function main() {
  const args = process.argv.slice(2);
  const wanted = args.filter((arg) => !arg.startsWith('--'));
  const unknown = wanted.filter((name) => !BENCHMARKS[name]);
  if (unknown.length) {
    console.error(`bench: unknown benchmark ${unknown.join(', ')}. Benchmarks: ${Object.keys(BENCHMARKS).join(', ')}.`);
    process.exit(1);
  }
  const Kit = loadKit();
  const saved = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {};
  const runtimeName = typeof Bun === 'undefined' ? 'node' : 'bun';
  const baseline = { scores: (saved[runtimeName] && saved[runtimeName].scores) || {} };
  const calibrate = BENCHMARKS.calibration.setup(Kit);
  const calibration = sample(calibrate);
  const names = Object.keys(BENCHMARKS).filter((name) => name !== 'calibration' && (!wanted.length || wanted.includes(name)));
  const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
  console.log(`bench on ${runtime}; calibration about ${Math.round(calibration).toLocaleString('en')} ops/s (each score is relative to the calibration timed beside it)`);
  const scores = {};
  const slower = [];
  names.forEach((name) => {
    const { opsPerSecond, relative } = measure(BENCHMARKS[name].setup(Kit), calibrate);
    scores[name] = relative;
    const { verdict, change } = judge(scores[name], baseline.scores[name]);
    if (verdict === 'SLOWER') slower.push(name);
    const versus = verdict === 'new' ? 'no baseline' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}% vs baseline`;
    console.log(
      `  ${name.padEnd(16)} ${Math.round(opsPerSecond).toLocaleString('en').padStart(13)} ops/s  rel ${scores[name].toFixed(4)}  ${verdict.padEnd(6)} ${versus.padEnd(22)} ${BENCHMARKS[name].cost}  - ${BENCHMARKS[name].about}`
    );
  });
  if (args.includes('--save')) {
    const entry = { savedOn: runtime, note: 'relative scores (ops/s divided by the calibration loop of the same run)', scores: { ...baseline.scores, ...scores } };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ ...saved, [runtimeName]: entry }, null, 2) + '\n');
    console.log(`${runtimeName} baseline saved to ${path.relative(ROOT, BASELINE_FILE)}`);
  }
  console.log(
    slower.length
      ? `REGRESSION: ${slower.join(', ')} more than ${TOLERANCE * 100}% slower than the baseline. Re-run once to rule out machine noise, then look at the change.`
      : 'no regression against the baseline'
  );
  process.exit(slower.length && args.includes('--strict') ? 1 : 0);
}

if (require.main === module) main();
module.exports = { BENCHMARKS, measure, sample, judge };
