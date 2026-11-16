/**
 * Unit tests for Kit.body and the generic subsystems it is composed of (lineage, flags, columns, seeded, pack,
 * palette, rig, reach, dynamics). Loaded by tools/test-kit.js, which hands over its sandbox and `test` function,
 * so these count in the one suite while living in their own file (a shared test file is edited by everyone).
 *
 * Owns:  the cases, including a control beside each refusal (the same call that is accepted when the input is right).
 * Does not own: the sandbox or the runner (tools/test-kit.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Kit files these tests need, in load order (core, blend and loot are already in the sandbox). */
const FILES = [
  'lineage',
  'flags',
  'columns',
  'seeded',
  'pack',
  'palette',
  'rig',
  'reach',
  'dynamics',
  'body-plan',
  'body-parts',
  'body-recipe',
  'body-edit',
  'body-store',
  'body-samples',
  'body-debug',
];

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const body = Kit.body;
  // Values made in the sandbox belong to another realm, so structures are compared as JSON.
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const throwsWith = (action, pattern, message) => assert.throws(action, (error) => pattern.test(error.message) || assert.fail(`${message || 'wrong error'}: ${error.message}`));
  const catalog = body.catalog(body.samples.CATALOG);
  const { biped, quadruped, fish } = catalog.plans;
  const positionOf = (world, bone) => [0, 1, 2].map((axis) => world.translation[bone * 3 + axis]);
  const distance = (first, second) => Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);

  // ---- lineage ----
  const KINDS = {
    nodes: {
      creature: { set: { size: 1, tags: ['alive'], fills: { hand: 'none' } } },
      elf: { parent: 'creature', traits: ['keen', 'tall'], set: { size: 0.9 }, limits: { size: { min: 0.7, max: 1.1 } } },
      woodElf: { parent: 'elf', set: { size: 0.8 } },
      giantElf: { parent: 'elf', set: { size: 3 } },
      twoSwords: { parent: 'creature', traits: ['armed', 'duelist'] },
      oneSword: { parent: 'creature', traits: ['armed'] },
      loopA: { parent: 'loopB' },
      loopB: { parent: 'loopA' },
    },
    traits: { keen: { set: { sight: 12, size: 0.5 } }, tall: { set: { size: 1.05 } }, armed: { set: { fills: { hand: 'sword' } } }, duelist: { set: { fills: { hand: 'rapier' } } } },
  };
  test('lineage: folds root-first, traits in declared order, the node own set last; result frozen and memoised', () => {
    const kinds = Kit.lineage(KINDS);
    const woodElf = kinds.resolve('woodElf');
    same(woodElf.values, { size: 0.8, tags: ['alive'], fills: { hand: 'none' }, sight: 12 });
    same(woodElf.chain, ['creature', 'elf', 'woodElf']);
    assert.strictEqual(kinds.resolve('elf').values.size, 0.9, 'own set beats both traits (0.5 then 1.05)');
    assert.ok(Object.isFrozen(woodElf.values) && Object.isFrozen(woodElf.values.tags), 'deeply frozen');
    assert.ok(!Object.isFrozen(KINDS.nodes.creature.set.tags), "the caller's tables are not frozen");
    const folds = kinds.resolveCount();
    assert.strictEqual(kinds.resolve('woodElf'), woodElf, 'same object the second time');
    assert.strictEqual(kinds.resolveCount(), folds, 'no fold on a cache hit');
    same(kinds.childrenOf('elf'), ['woodElf', 'giantElf']);
  });
  test('lineage: a variant outside its species limit is rejected naming the owner (control: one inside passes)', () => {
    const kinds = Kit.lineage(KINDS);
    throwsWith(() => kinds.resolve('giantElf'), /"giantElf" has size = 3, outside the limit \[0.7, 1.1\] owned by "elf"/);
    assert.strictEqual(kinds.resolve('woodElf').values.size, 0.8, 'control: 0.8 is inside the limit');
    assert.strictEqual(kinds.resolve('woodElf').limits.size.maxOwner, 'elf');
  });
  test('lineage: two traits writing one exclusive slot throw (controls: one trait, and the same pair when not exclusive)', () => {
    const exclusive = Kit.lineage({ ...KINDS, exclusive: ['fills'] });
    throwsWith(() => exclusive.resolve('twoSwords'), /traits "armed" and "duelist" of node "twoSwords" both write "fills.hand"/);
    assert.strictEqual(exclusive.resolve('oneSword').values.fills.hand, 'sword', 'control: one trait is fine');
    assert.strictEqual(Kit.lineage(KINDS).resolve('twoSwords').values.fills.hand, 'rapier', 'control: without `exclusive` the later trait wins');
  });
  test('lineage: parent loops, unknown parents, traits and dotted keys are named errors', () => {
    throwsWith(() => Kit.lineage(KINDS).resolve('loopA'), /loops back/);
    throwsWith(() => Kit.lineage({ nodes: { orphan: { parent: 'nobody' } } }).resolve('orphan'), /unknown node "nobody"/);
    throwsWith(() => Kit.lineage({ nodes: { odd: { traits: ['nope'] } } }).resolve('odd'), /trait "nope"/);
    throwsWith(() => Kit.lineage({ nodes: { odd: { set: { 'a.b': 1 } } } }).resolve('odd'), /contains "\."/);
  });

  // ---- flags ----
  test('flags: masks, names and requirements with counts; a failure names what is missing', () => {
    const abilities = Kit.flags(['legs', 'wings', 'tail'], 'ability');
    assert.strictEqual(abilities.mask(['legs', 'tail']), 0b101);
    same(abilities.namesOf(0b110), ['wings', 'tail']);
    const walk = abilities.requirement({ atLeast: { legs: 2 } });
    assert.strictEqual(abilities.fits(0b001, [2, 0, 0], walk), true, 'control: two legs walk');
    assert.strictEqual(abilities.fits(0b110, [0, 2, 5], walk), false);
    same(abilities.missing(0b110, [0, 2, 5], walk), ['legs']);
    same(abilities.missing(0b001, [1, 0, 0], walk), ['legs (has 1, needs 2)']);
    throwsWith(() => abilities.mask(['gills']), /unknown ability "gills"/);
    throwsWith(() => Kit.flags(Array.from({ length: 33 }, (_unused, index) => `flag${index}`)), /holds 32/);
  });

  // ---- columns ----
  test('columns: slots are reused, generations tell old handles apart, the live range stays tight', () => {
    const store = Kit.columns(3, { x: Float32Array, kind: Uint8Array });
    const [first, second, third] = [store.spawn(), store.spawn(), store.spawn()];
    same([first, second, third, store.spawn()], [0, 1, 2, -1], 'full store returns -1');
    store.x[second] = 7;
    const generation = store.generation[second];
    assert.strictEqual(store.despawn(second), true);
    assert.strictEqual(store.despawn(second), false, 'despawning twice changes nothing');
    assert.strictEqual(store.isCurrent(second, generation), false);
    const reused = store.spawn();
    assert.strictEqual(reused, second, 'the freed slot is handed out again');
    assert.strictEqual(store.x[reused], 0, 'and its columns are zeroed');
    assert.strictEqual(store.isCurrent(reused, generation), false, 'the old handle is not the new record');
    store.despawn(third);
    store.despawn(reused);
    same([store.count(), store.liveEnd()], [1, 1], 'live range shrank past the dead tail');
    throwsWith(() => Kit.columns(4, { alive: Uint8Array }), /used by the store itself/);
    throwsWith(() => Kit.columns(0, {}), /positive whole number/);
  });

  // ---- seeded ----
  test('seeded: stable ids, independent fields, weighted picks and an order-sensitive content hash', () => {
    assert.strictEqual(Kit.seeded.hashText('a'), 0xe40c292c, 'FNV-1a of "a" (published test vector)');
    const height = Kit.seeded.field('height', 'bell');
    const weight = Kit.seeded.field('weight');
    assert.strictEqual(height(42), height(42));
    assert.notStrictEqual(height(42), height(43));
    assert.notStrictEqual(height(42), weight(42), 'fields of one seed are unrelated');
    let total = 0;
    for (let seed = 0; seed < 4000; seed++) {
      const draw = weight(seed);
      assert.ok(draw >= 0 && draw < 1);
      total += draw;
    }
    close(total / 4000, 0.5, 0.03, 'uniform draws average a half');
    const rows = [
      { id: 'common', weight: 3 },
      { id: 'rare', weight: 1 },
    ];
    assert.strictEqual(Kit.seeded.pick(rows, 0.1).id, 'common');
    assert.strictEqual(Kit.seeded.pick(rows, 0.9).id, 'rare');
    const hasher = Kit.seeded.hasher();
    const digest = (values) => {
      hasher.reset();
      values.forEach(hasher.absorb);
      return hasher.value();
    };
    assert.strictEqual(digest([1, 2, 3]), digest([1, 2, 3]));
    assert.notStrictEqual(digest([1, 2, 3]), digest([3, 2, 1]));
    assert.ok(Number.isSafeInteger(digest([1, 2, 3])));
    throwsWith(() => Kit.seeded.field('x', 'lumpy'), /unknown shape/);
  });

  // ---- pack ----
  test('pack: every value survives a round trip; cut data and bad codes are named errors', () => {
    const numbers = [0, 127, 128, 16383, 16384, 4294967295];
    const writer = Kit.pack.writer().byte(255);
    numbers.forEach((value) => writer.varint(value));
    const bytes = writer.uint32(4294967295).text('handRight/gem').bytes();
    const reader = Kit.pack.reader(bytes);
    assert.strictEqual(reader.byte(), 255);
    same(
      numbers.map(() => reader.varint()),
      numbers
    );
    assert.strictEqual(reader.uint32(), 4294967295);
    assert.strictEqual(reader.text(), 'handRight/gem');
    assert.strictEqual(reader.isDone(), true);
    throwsWith(() => Kit.pack.reader(bytes.slice(0, 3), 'test').uint32() || Kit.pack.reader(bytes.slice(0, 3), 'test').uint32(), /test: the data ends/);
    throwsWith(() => Kit.pack.writer().byte(256), /0 to 255/);
    for (let length = 0; length <= 7; length++) {
      const sample = Array.from({ length }, (_unused, index) => (index * 83 + 201) % 256);
      same([...Kit.pack.fromText(Kit.pack.toText(sample))], sample, `text round trip of ${length} bytes`);
    }
    assert.strictEqual(Kit.pack.toText([1, 2, 3]), 'AQID');
    throwsWith(() => Kit.pack.fromText('AQ*D'), /"\*" at position 2/);
  });

  // ---- palette ----
  test('palette: a ramp runs dark to light and shade() bands a light level', () => {
    const ramp = Kit.palette.ramp('moss', 0.3);
    assert.strictEqual(ramp.shades.length, 5);
    const brightness = ramp.shades.map((shade) => [1, 3, 5].reduce((sum, at) => sum + parseInt(shade.slice(at, at + 2), 16), 0));
    assert.ok(
      brightness.every((value, index) => index === 0 || value > brightness[index - 1]),
      `each shade brighter than the last: ${brightness}`
    );
    assert.strictEqual(Kit.palette.shade(ramp, 0), ramp.shades[0]);
    assert.strictEqual(Kit.palette.shade(ramp, 1), ramp.shades[4]);
    assert.strictEqual(Kit.palette.shade(ramp, 0.5), ramp.shades[2]);
    throwsWith(() => Kit.palette.ramp('flat', 0.1, { shades: 1 }), /2 or more shades/);
  });

  // ---- rig ----
  /** A straight three-joint arm along +Y: joint 0 at the origin's child position, each link 1 long. */
  const makeArm = (count = 3) => {
    const parents = Int16Array.from({ length: count + 1 }, (_unused, index) => index - 1);
    const local = Kit.rig.create(count + 1);
    for (let joint = 1; joint <= count; joint++) local.translation[joint * 3 + 1] = 1;
    return { parents, local, world: Kit.rig.worldTransforms(parents, local, Kit.rig.create(count + 1)) };
  };
  test('rig: one forward pass places joints; rotation, heading and the two kinds of scale behave as documented', () => {
    const { parents, local, world } = makeArm(2);
    same(positionOf(world, 2), [0, 2, 0], 'rest: two links up');
    Kit.rig.turn(local.rotation, local.rotation.slice(), 1, 0, Math.PI / 2);
    Kit.rig.worldTransforms(parents, local, world);
    const tip = positionOf(world, 2);
    close(tip[1], 1, 1e-6, 'a quarter pitch at joint 1 lays the second link flat');
    close(tip[2], 1, 1e-6, 'towards +Z');
    Kit.rig.worldTransforms(parents, local, world, 10, 0, 0, Math.PI / 2);
    close(positionOf(world, 2)[0], 11, 1e-6, 'heading a quarter turn swings +Z onto +X, origin moves the lot');
    // Non-inherited scale stretches the joint's own children only; uniform is inherited.
    local.scale[1 * 3 + 2] = 2;
    Kit.rig.worldTransforms(parents, local, world);
    close(positionOf(world, 2)[2], 1, 1e-6, "joint 1's Z stretch does not touch a child offset along Y");
    local.scale[1 * 3 + 1] = 2;
    Kit.rig.worldTransforms(parents, local, world);
    close(positionOf(world, 2)[2], 2, 1e-6, "joint 1's Y stretch doubles its child's reach");
    local.uniform[0] = 3;
    const whole = Kit.rig.worldTransforms(parents, local, Kit.rig.create(3));
    close(whole.uniform[2], 3, 1e-6, 'uniform size is inherited');
    close(whole.translation[1 * 3 + 1], 3, 1e-6, 'and scales offsets below it');
    // The three-axis scale stops at the joint's own children, on every axis: a grandchild keeps its own offset.
    const long = makeArm(3);
    for (let axis = 0; axis < 3; axis++) long.local.scale[1 * 3 + axis] = 2;
    long.local.translation[2 * 3] = 1;
    long.local.translation[3 * 3] = 1;
    Kit.rig.worldTransforms(long.parents, long.local, long.world);
    same(positionOf(long.world, 2), [2, 3, 0], "joint 1's stretch doubles its child's offset on X and Y");
    same(positionOf(long.world, 3), [3, 4, 0], 'and is not handed on to the grandchild');
    // A partial range gives what the full pass gives.
    local.translation[2 * 3] = 0.5;
    const partial = Kit.rig.worldTransforms(parents, local, whole, 0, 0, 0, 0, 2, 3);
    same([...partial.translation], [...Kit.rig.worldTransforms(parents, local, Kit.rig.create(3)).translation]);
  });
  test('rig: shortestArc turns one direction onto another, including exactly opposite ones', () => {
    const quaternion = Kit.rig.shortestArc(0, 1, 0, 0, -1, 0, new Float32Array(4));
    close(Math.hypot(...quaternion), 1, 1e-6, 'unit quaternion');
    close(quaternion[3], 0, 1e-6, 'a half turn');
    same([...Kit.rig.shortestArc(0, 0, 0, 1, 0, 0, new Float32Array(4))], [0, 0, 0, 1], 'no direction, no turn');
  });

  // ---- reach ----
  test('reach.twoBone: a reachable target is hit, the bend follows the hint, an unreachable one extends fully without NaN', () => {
    const { parents, local, world } = makeArm(3);
    const reached = Kit.reach.twoBone(parents, local, world, 1, 2, 3, 0.8, 1.9, 0.3, 0, 1.5, 5);
    assert.strictEqual(reached, true);
    assert.ok(distance(positionOf(world, 3), [0.8, 1.9, 0.3]) < 1e-4, `end on target: ${positionOf(world, 3)}`);
    assert.ok(positionOf(world, 2)[2] > 0.3, 'the middle joint bends towards the hint (+Z)');
    Kit.reach.twoBone(parents, local, world, 1, 2, 3, 0.8, 1.9, 0.3, 0, 1.5, -5);
    assert.ok(positionOf(world, 2)[2] < 0.3, 'control: the opposite hint bends it the other way');
    const fresh = makeArm(3);
    assert.strictEqual(Kit.reach.twoBone(fresh.parents, fresh.local, fresh.world, 1, 2, 3, 30, 1, 0, 0, 5, 5), false, 'out of reach');
    const end = positionOf(fresh.world, 3);
    assert.ok(end.every(Number.isFinite), `no NaN: ${end}`);
    close(distance(end, [0, 1, 0]), 2, 1e-3, 'fully extended: both links in a line');
    close(end[0], 2, 1e-3, 'towards the target along +X');
    // The solve survives the next full forward pass: rotations were written to the local pose.
    const again = Kit.rig.worldTransforms(fresh.parents, fresh.local, Kit.rig.create(4));
    assert.ok(distance(positionOf(again, 3), end) < 1e-5);
  });
  test('reach: joint limits are respected (control: the same target is reached without them)', () => {
    const limitsFor = (count) => ({ min: new Float32Array(count * 3).fill(-0.3), max: new Float32Array(count * 3).fill(0.3), base: Kit.rig.create(count).rotation });
    const target = [0, 1.2, 1.2];
    const free = makeArm(3);
    Kit.reach.twoBone(free.parents, free.local, free.world, 1, 2, 3, ...target, 0, 3, 3);
    assert.ok(distance(positionOf(free.world, 3), target) < 1e-4, 'control: unlimited arm reaches');
    const limited = makeArm(3);
    const limits = limitsFor(4);
    Kit.reach.twoBone(limited.parents, limited.local, limited.world, 1, 2, 3, ...target, 0, 3, 3, limits);
    assert.ok(distance(positionOf(limited.world, 3), target) > 0.1, 'the limited arm stops short');
    [1, 2].forEach((joint) => assert.strictEqual(Kit.reach.clamp(limited.local, joint, limits), false, `joint ${joint} is already inside its limits`));
    const pitch = 2 * Math.asin(limited.local.rotation[1 * 4]);
    assert.ok(Math.abs(pitch) <= 0.3 + 1e-5, `joint 1 pitch ${pitch} within 0.3 rad`);
  });
  test('reach.chain (FABRIK): reachable hit within tolerance, unreachable laid straight, limits respected, bad chains refused', () => {
    const tail = makeArm(6);
    const joints = [1, 2, 3, 4, 5, 6];
    const miss = Kit.reach.chain(tail.parents, tail.local, tail.world, joints, 2, 3, 1.5);
    assert.ok(miss <= 0.002, `tip within tolerance: ${miss}`);
    assert.ok(distance(positionOf(Kit.rig.worldTransforms(tail.parents, tail.local, Kit.rig.create(7)), 6), [2, 3, 1.5]) <= 0.002, 'and it survives a full forward pass');
    for (let joint = 2; joint <= 6; joint++) close(distance(positionOf(tail.world, joint), positionOf(tail.world, joint - 1)), 1, 1e-4, `link ${joint} kept its length`);
    const far = makeArm(6);
    const gap = Kit.reach.chain(far.parents, far.local, far.world, joints, 0, 1, 40);
    assert.ok(Number.isFinite(gap));
    const tip = positionOf(far.world, 6);
    assert.ok(tip.every(Number.isFinite));
    close(tip[2], 5, 1e-3, 'five links straight along +Z');
    close(tip[1], 1, 1e-3, 'level with the base');
    const stiff = makeArm(6);
    const limits = { min: new Float32Array(21).fill(-0.2), max: new Float32Array(21).fill(0.2), base: Kit.rig.create(7).rotation };
    assert.ok(Kit.reach.chain(stiff.parents, stiff.local, stiff.world, joints, 2, 3, 1.5, { limits }) > 0.1, 'a tightly limited chain stops short');
    joints.slice(0, -1).forEach((joint) => assert.strictEqual(Kit.reach.clamp(stiff.local, joint, limits), false, `joint ${joint} inside its limits`));
    throwsWith(() => Kit.reach.chain(tail.parents, tail.local, tail.world, [1, 3], 0, 0, 0), /not a child/);
    throwsWith(() => Kit.reach.chain(tail.parents, tail.local, tail.world, [1], 0, 0, 0), /2 to 64 joints/);
  });

  // ---- dynamics ----
  const simulate = (framesPerSecond, seconds, step) => {
    const frames = Math.round(framesPerSecond * seconds);
    for (let frame = 1; frame <= frames; frame++) step(1 / framesPerSecond, frame / framesPerSecond);
  };
  test('dynamics.spring: settles on its target, critical damping does not overshoot (control: light damping does)', () => {
    const critical = Kit.dynamics.spring({ stiffness: 200 });
    const bouncy = Kit.dynamics.spring({ stiffness: 200, damping: 0.2 * Kit.dynamics.criticalDamping(200) });
    critical.target = bouncy.target = 1;
    let highestCritical = 0;
    let highestBouncy = 0;
    simulate(60, 3, (dt) => {
      highestCritical = Math.max(highestCritical, Kit.dynamics.stepSpring(critical, dt));
      highestBouncy = Math.max(highestBouncy, Kit.dynamics.stepSpring(bouncy, dt));
    });
    close(critical.value, 1, 1e-3, 'settled');
    assert.ok(highestCritical <= 1.001, `no overshoot: ${highestCritical}`);
    assert.ok(highestBouncy > 1.2, `control: the under-damped spring overshoots: ${highestBouncy}`);
    throwsWith(() => Kit.dynamics.spring({ stiffness: 1e6 }), /cannot be simulated stably/);
  });
  test('dynamics: the same motion at 60 and at 20 frames a second (spring and chain)', () => {
    const runSpring = (framesPerSecond) => {
      const spring = Kit.dynamics.spring({ stiffness: 150, damping: 6 });
      simulate(framesPerSecond, 1.5, (dt, time) => {
        spring.target = time < 0.5 ? 1 : -0.5;
        Kit.dynamics.stepSpring(spring, dt);
      });
      return spring.value;
    };
    close(runSpring(60), runSpring(20), 0.02, 'spring value after 1.5 s');
    const runChain = (framesPerSecond) => {
      const chain = Kit.dynamics.chain({ count: 5, lengths: 0.25, stiffness: 6 });
      Kit.dynamics.placeChain(chain, 0, 2, 0, 0, 0, -1);
      simulate(framesPerSecond, 2, (dt, time) => Kit.dynamics.stepChain(chain, dt, Math.sin(time * 3) * 0.5, 2, 0, 0, 0, -1));
      return chain;
    };
    const [smooth, choppy] = [runChain(60), runChain(20)];
    const tipOf = (chain) => [...chain.positions.slice(12, 15)];
    assert.ok(distance(tipOf(smooth), tipOf(choppy)) < 0.08, `tips agree: ${tipOf(smooth)} vs ${tipOf(choppy)}`);
    assert.ok(tipOf(smooth).every(Number.isFinite));
    for (let link = 0; link < 4; link++)
      close(distance([...smooth.positions.slice(link * 3, link * 3 + 3)], [...smooth.positions.slice(link * 3 + 3, link * 3 + 6)]), 0.25, 0.01, `link ${link} length`);
    assert.strictEqual(Kit.dynamics.stepsDue({ carry: 0 }, 1 / 60), 2, 'a 60 fps frame is two 120 Hz steps');
    assert.strictEqual(Kit.dynamics.stepsDue({ carry: 0 }, 5), 12, 'a long frame is capped, not chased');
    throwsWith(() => Kit.dynamics.chain({ count: 3, lengths: [1] }), /2 links/);
  });

  // ---- body plans ----
  test('body.plan: three different plans compile to parent-first arrays with derived capabilities and counts', () => {
    same([biped.boneCount, quadruped.boneCount, fish.boneCount], [18, 22, 11]);
    [biped, quadruped, fish].forEach((plan) => plan.parent.forEach((parentBone, bone) => assert.ok(parentBone < bone, `${plan.id}: parent of ${bone} comes first`)));
    same(body.capabilityNames(biped.capabilities), ['legs', 'arms', 'spine', 'head', 'hands']);
    same(body.capabilityNames(fish.capabilities), ['fins', 'tail', 'spine', 'head', 'jaw']);
    same([biped.countOf('legs'), quadruped.countOf('legs'), fish.countOf('legs'), quadruped.countOf('tail'), fish.countOf('fins')], [2, 4, 0, 3, 3]);
    // Authored child-first, compiled parent-first; subtrees are single runs.
    const shuffled = body.plan({ id: 'shuffled', bones: [{ name: 'tip', parent: 'mid' }, { name: 'mid', parent: 'base' }, { name: 'other', parent: 'base' }, { name: 'base' }] });
    same(shuffled.boneNames, ['base', 'mid', 'tip', 'other']);
    same([...shuffled.subtreeEnd], [4, 3, 3, 4]);
    same(
      body.chains(biped, body.roleMask(['leg'])).map((chain) => chain.map((bone) => biped.boneNames[bone])),
      [
        ['thighLeft', 'shinLeft', 'footLeft'],
        ['thighRight', 'shinRight', 'footRight'],
      ]
    );
    assert.strictEqual(body.groupOf(biped.roles[biped.boneIndex('handLeft')]), 'arms');
  });
  test('body.plan: mistakes are named (unknown parent, role, loop, duplicate, derived capability, bad shape, dotted name)', () => {
    const bad =
      (bones, extra = {}) =>
      () =>
        body.plan({ id: 'bad', bones, ...extra });
    throwsWith(bad([{ name: 'a', parent: 'ghost' }]), /parent "ghost"/);
    throwsWith(bad([{ name: 'a', roles: ['antenna'] }]), /unknown role "antenna"/);
    throwsWith(bad([{ name: 'a' }, { name: 'b', parent: 'c' }, { name: 'c', parent: 'b' }]), /parent loop/);
    throwsWith(bad([{ name: 'a' }, { name: 'a' }]), /two bones are named "a"/);
    throwsWith(bad([{ name: 'a' }], { capabilities: ['legs'] }), /worked out from the "leg" role/);
    throwsWith(bad([{ name: 'a', shape: { kind: 'lathe' } }]), /lathe shape of bone "a" needs profile/);
    throwsWith(bad([{ name: 'hand.r' }]), /contains '\.'/);
    throwsWith(bad([{ name: 'a', joint: 'slider' }]), /joint "slider"/);
    assert.strictEqual(body.plan({ id: 'floaty', bones: [{ name: 'a' }], capabilities: ['hover'] }).countOf('hover'), 1, 'control: a declared capability is accepted');
  });
  test('body: a fish asked to walk is refused naming legs (controls: a biped walks; four legs are counted)', () => {
    const walk = body.requirement({ needs: ['legs'], atLeast: { legs: 2 } });
    const gallop = body.requirement({ atLeast: { legs: 4 } });
    throwsWith(() => body.requireFit(fish, walk, 'the walk gait'), /the walk gait cannot use the plan "fish": it lacks legs\./);
    assert.strictEqual(body.requireFit(biped, walk, 'the walk gait'), biped, 'control: a biped walks');
    assert.strictEqual(body.fits(quadruped, gallop), true);
    same(body.missing(biped, gallop), ['legs (has 2, needs 4)']);
  });
  test('body.dials: length moves what hangs below, size is inherited, mass follows volume', () => {
    const dials = body.dials(biped, [
      { id: 'legLength', min: 0.5, max: 2, affects: [{ roles: ['leg'], channel: 'length' }] },
      { id: 'headSize', min: 0.5, max: 2, affects: [{ roles: ['head'], channel: 'size' }] },
      { id: 'height', min: 0.5, max: 2, affects: [{ roles: ['root'], channel: 'size' }] },
      { id: 'antennae', min: 0.5, max: 2, affects: [{ bones: ['antennaLeft'], channel: 'length' }] },
    ]);
    same(dials.unused, ['antennae'], 'a dial that touches no bone is reported, not an error');
    const rest = body.worldTransforms(biped, body.createPose(biped), body.createPose(biped));
    const long = body.worldTransforms(biped, body.applyDials(biped, dials, [1.5, 1, 1, 1], body.createPose(biped)), body.createPose(biped));
    const [foot, head, hip] = ['footLeft', 'head', 'thighLeft'].map((name) => biped.boneIndex(name));
    close(positionOf(rest, hip)[1] - positionOf(long, foot)[1], 1.5 * (positionOf(rest, hip)[1] - positionOf(rest, foot)[1]), 1e-5, 'the leg is half as long again');
    close(positionOf(long, head)[1], positionOf(rest, head)[1], 1e-6, 'the head did not move');
    close(body.boneLength(biped, long, hip), 1.5 * body.boneLength(biped, rest, hip), 1e-6, 'bone length follows the dial');
    const bigHead = body.worldTransforms(biped, body.applyDials(biped, dials, [1, 2, 1, 1], body.createPose(biped)), body.createPose(biped));
    const top = biped.socketIndex('headTop');
    const hatHeight = (world) => body.socketPosition(biped, world, top, [])[1] - positionOf(world, head)[1];
    close(hatHeight(bigHead), 2 * hatHeight(rest), 1e-5, 'the hat socket rides the bigger head');
    const masses = new Float32Array(biped.boneCount);
    const restMass = body.boneMasses(biped, rest, masses);
    const tall = body.worldTransforms(biped, body.applyDials(biped, dials, [1, 1, 2, 1], body.createPose(biped)), body.createPose(biped));
    close(body.boneMasses(biped, tall, masses) / restMass, 8, 1e-4, 'twice the size is eight times the mass');
    assert.ok(restMass > 30 && restMass < 120, `a plausible body mass: ${restMass} kg`);
    const centre = body.centerOfMass(biped, tall, masses, []);
    close(centre[0], 0, 1e-4, 'a symmetric body balances on its midline');
    assert.ok(centre[1] > 1 && centre[1] < 2.6, `centre of mass inside the body: ${centre[1]}`);
    close(body.lowestY(biped, rest), 0, 0.03, 'the rest pose stands on the ground');
    throwsWith(() => body.dials(biped, [{ id: 'x', min: 2, max: 3, affects: [] }]), /min <= default <= max/);
  });

  // ---- parts ----
  test('body.assemble: parts become bones of a new plan, nested sockets appear, wings grant a capability', () => {
    const armed = body.assemble(biped, { handRight: 'sword', 'handRight/gem': 'ruby', back: 'wings' }, catalog.parts);
    assert.strictEqual(armed.boneCount, biped.boneCount + 2 + 2 + 5);
    same(body.openSockets(armed), ['headTop', 'handLeft']);
    assert.ok(body.capabilityNames(armed.capabilities).includes('wings'), 'wings come from the part');
    assert.ok(!body.capabilityNames(biped.capabilities).includes('wings'), 'control: the bare biped has none');
    // The sword's grip (its anchor) lands exactly on the hand socket.
    const world = body.worldTransforms(armed, body.createPose(armed), body.createPose(armed));
    const hand = body.socketPosition(armed, world, armed.socketIndex('handRight'), []);
    const blade = positionOf(world, armed.boneIndex('handRight/blade'));
    const grip = catalog.parts.sword.anchorPosition;
    assert.ok(
      distance(
        blade.map((value, axis) => value + grip[axis]),
        hand
      ) < 1e-6,
      'anchor on socket'
    );
    assert.strictEqual(body.assemble(biped, { handRight: null }, catalog.parts), biped, 'nothing to attach returns the host');
    assert.strictEqual(catalog.parts.sword.plan.boneCount, 1, 'a part alone is a one-bone plan');
  });
  test('body.assemble: a hat is refused on a grip socket (control: accepted on a head); other misuse is named', () => {
    throwsWith(() => body.assemble(biped, { handRight: 'hat' }, catalog.parts), /the part "hat" fits headTop sockets, but "handRight" is a grip socket/);
    assert.strictEqual(body.assemble(biped, { headTop: 'hat' }, catalog.parts).filled.headTop, 'hat', 'control');
    assert.strictEqual(body.canAttach(biped, 'handRight', catalog.parts.hat), false);
    assert.strictEqual(body.canAttach(biped, 'handRight', catalog.parts.sword), true);
    assert.strictEqual(body.assemble(quadruped, { mouth: 'sword' }, catalog.parts).filled.mouth, 'sword', 'a mouth is a grip: sockets are typed, not named');
    throwsWith(() => body.assemble(biped, { 'handRight/gem': 'ruby' }, catalog.parts), /no socket "handRight\/gem" \(a nested socket exists only once/);
    throwsWith(() => body.assemble(biped, { handRight: 'spoon' }, catalog.parts), /"spoon", which is not in `parts`/);
    throwsWith(() => body.assemble(body.assemble(biped, { handRight: 'sword' }, catalog.parts), { handRight: 'sword' }, catalog.parts), /already holds "sword"/);
  });

  // ---- recipes ----
  test('body.catalog: a recipe resolves the same way every time; overrides sit on top; individuals clamp', () => {
    const recipe = { species: 'human', seed: 42 };
    same(catalog.describe(catalog.resolve(recipe)), catalog.describe(catalog.resolve(recipe)));
    assert.notStrictEqual(JSON.stringify(catalog.describe(catalog.resolve({ species: 'human', seed: 43 }))), JSON.stringify(catalog.describe(catalog.resolve(recipe))));
    const dressed = catalog.resolve({ species: 'human', seed: 42, overrides: { 'dial:height': 9, 'color:skin': 1, 'fill:handRight': 'sword', 'fill:handRight/gem': 'ruby' } });
    const described = catalog.describe(dressed);
    close(described.dials.height, 1.2, 1e-6, 'an individual beyond its species range is clamped, not refused');
    assert.strictEqual(described.colors.skin, 'sand', 'colours are ramps of a palette, by index');
    same(described.fills, { handRight: 'sword', 'handRight/gem': 'ruby' });
    same(
      catalog.socketsOf(dressed).map((socket) => `${socket.path}:${socket.part}`),
      ['back:null', 'handLeft:null', 'handRight:sword', 'headTop:' + (described.fills.headTop || null), 'handRight/gem:ruby']
    );
  });
  test('body.catalog: every kind of bad recipe has a named error; resolve throws what validate lists', () => {
    const codes = (recipe) => catalog.validate(recipe).map((problem) => problem.code);
    same(codes({ species: 'human', seed: 1 }), [], 'control: a good recipe has no problems');
    same(codes({ species: 'dragon', seed: 1 }), ['unknown-species']);
    same(codes({ species: 'humanoid', seed: 1 }), ['abstract-species']);
    same(codes({ species: 'human', seed: -1 }), ['bad-seed']);
    same(
      codes({
        species: 'human',
        seed: 1,
        overrides: { 'dial:wingspan': 1, 'dial:height': 'tall', 'color:skin': 99, 'fill:handRight': 'spoon', 'fill:tail': 'sword', 'fill:headTop': 'sword', 'dial:build': 9, bogus: 1 },
      }),
      [
        'unknown-field', // bogus: not a field key at all
        'out-of-range', // dial:build
        'bad-value', // dial:height
        'unknown-field', // dial:wingspan
        'bad-color',
        'unknown-part', // fill:handRight
        'part-does-not-fit', // fill:headTop
        'no-such-socket', // fill:tail
      ]
    );
    throwsWith(() => catalog.resolve({ species: 'carp', seed: 1, overrides: { 'fill:handRight': 'sword' } }), /\[no-such-socket\] "carp" has no socket "handRight"/);
    throwsWith(() => catalog.species('humanoid'), /abstract/);
  });
  test('body.catalog: adding a dial later leaves every old field of every old seed unchanged', () => {
    const samples = JSON.parse(JSON.stringify(body.samples.CATALOG));
    samples.nodes.creature.set.dials.neckLength = { min: 0.8, max: 1.4, affects: [{ roles: ['neck'], channel: 'length' }] };
    samples.nodes.creature.set.colors.eyes = 'dyes';
    const grown = body.catalog(samples);
    for (let seed = 0; seed < 40; seed++) {
      ['human', 'seraph', 'hound', 'carp'].forEach((species) => {
        const before = catalog.describe(catalog.resolve({ species, seed }));
        const after = grown.describe(grown.resolve({ species, seed }));
        assert.ok('neckLength' in after.dials && 'eyes' in after.colors, 'control: the new fields exist');
        delete after.dials.neckLength;
        delete after.colors.eyes;
        same(after, before, `${species} seed ${seed}`);
      });
    }
  });
  test('body.catalog: decode(encode(recipe)) equals the normalised recipe; a bare recipe is 6 bytes', () => {
    const recipes = [
      { species: 'human', seed: 12345 },
      { species: 'carp', seed: 4294967295, overrides: { 'dial:finSize': 1.33, 'color:skin': 3 } },
      { species: 'seraph', seed: 9, overrides: { 'fill:handRight/gem': 'ruby', 'fill:handRight': 'sword', 'fill:headTop': null, 'dial:height': 5 } },
      { species: 'hound', seed: 0, overrides: { 'fill:mouth': 'none' } },
    ];
    recipes.forEach((recipe) => {
      const bytes = catalog.encode(recipe);
      same(catalog.decode(bytes), catalog.normalize(recipe), JSON.stringify(recipe));
      same(catalog.decode(Kit.pack.fromText(Kit.pack.toText(bytes))), catalog.normalize(recipe), 'and through a text code');
    });
    assert.strictEqual(catalog.encode(recipes[0]).length, 6);
    assert.strictEqual(Kit.pack.toText(catalog.encode(recipes[0])).length, 8, 'an eight-character share code');
    assert.strictEqual(catalog.encode(recipes[1]).length, 16, '6 + 5 per dial or colour override');
    same(Object.keys(catalog.normalize(recipes[2]).overrides), ['dial:height', 'fill:handRight', 'fill:headTop', 'fill:handRight/gem'], 'canonical order');
    throwsWith(() => catalog.decode(Uint8Array.of(9, 1, 0, 0, 0, 0)), /recipe format 9/);
    throwsWith(() => catalog.decode(Uint8Array.of(1, 77, 0, 0, 0, 0)), /no species has the code 77/);
    throwsWith(() => catalog.decode(catalog.encode(recipes[1]).slice(0, 9)), /cut short/);
  });
  test('body.catalog: the hash is of the look (same look, same hash; any change, another hash)', () => {
    const base = catalog.resolve({ species: 'human', seed: 7 });
    const description = catalog.describe(base);
    const spelled = catalog.resolve({
      species: 'human',
      seed: 99999,
      overrides: {
        ...Object.fromEntries(Object.keys(description.dials).map((id) => [`dial:${id}`, description.dials[id]])),
        ...Object.fromEntries(Object.keys(description.colors).map((id, index) => [`color:${id}`, base.colors[index]])),
        'fill:headTop': description.fills.headTop || null,
        'fill:handRight': description.fills.handRight || null,
        'fill:handRight/gem': description.fills['handRight/gem'] || null,
      },
    });
    assert.strictEqual(catalog.hash(spelled), catalog.hash(base), 'another seed overridden to the same look');
    assert.notStrictEqual(catalog.hash(catalog.resolve({ species: 'human', seed: 7, overrides: { 'color:skin': (base.colors[0] + 1) % 5 } })), catalog.hash(base));
    assert.notStrictEqual(catalog.hash(catalog.resolve({ species: 'human', seed: 7, overrides: { 'fill:handLeft': 'sword' } })), catalog.hash(base));
  });
  test('body.catalog: tables roll by weight, each index on its own; 500 instances of 20 recipes bake 20 times', () => {
    const villagers = catalog.table([{ species: 'human', weight: 5 }, { species: 'elf' }, { species: 'carp' }]);
    const counts = { human: 0, elf: 0, carp: 0 };
    for (let index = 0; index < 7000; index++) counts[villagers.roll(1, index).species] += 1;
    close(counts.human / 7000, 5 / 7, 0.03, 'weights are honoured');
    same(villagers.roll(1, 123), villagers.roll(1, 123), 'index 123 does not depend on the others');
    throwsWith(() => catalog.table([{ species: 'humanoid' }]), /abstract/);
    const bakery = catalog.bakery();
    const recipes = Array.from({ length: 20 }, (_unused, index) => ({ species: 'human', seed: 1000 + index, overrides: { 'dial:height': 0.85 + index * 0.01 } }));
    const crowd = body.store(500);
    for (let instance = 0; instance < 500; instance++) crowd.spawn(instance % 20, instance, 0, 0);
    for (let slot = 0; slot < crowd.liveEnd(); slot++) bakery.bakeRecipe(recipes[crowd.recipe[slot]]);
    same(bakery.stats(), { bakes: 20, hits: 480, size: 20, outfits: bakery.stats().outfits });
    assert.ok(bakery.stats().outfits <= 6, 'outfits (assembled plans) are shared between looks');
    const bake = bakery.bakeRecipe({ species: 'human', seed: 1, overrides: { 'fill:handRight': 'sword' } });
    assert.strictEqual(bake.ramps[bake.boneRamp[bake.plan.boneIndex('handRight/blade')]], bake.colors.metal, 'the blade is painted with the metal ramp, by index');
    assert.strictEqual(bake.boneRamp[bake.plan.boneIndex('ground')], -1);
  });
  test('body.catalog: table mistakes are caught at load (trait conflict, duplicate code, bad fill, limit)', () => {
    const variant = (change) => () => {
      const samples = JSON.parse(JSON.stringify(body.samples.CATALOG));
      change(samples);
      return body.catalog(samples);
    };
    throwsWith(
      variant((samples) => (samples.nodes.knight = { parent: 'humanoid', traits: ['armed', 'duelist'], set: { code: 9 } })),
      /traits "armed" and "duelist" of node "knight" both write "fills.handRight"/
    );
    assert.ok(variant((samples) => (samples.nodes.knight = { parent: 'humanoid', traits: ['armed'], set: { code: 9 } }))().species('knight'), 'control: one of the two traits is fine');
    throwsWith(
      variant((samples) => (samples.nodes.twin = { parent: 'human' })),
      /"human" and "twin" both have the code 1 \("twin" inherits it/
    );
    throwsWith(
      variant((samples) => (samples.nodes.carp.set.fills = { back: { sword: 1 } })),
      /fills.back offers "sword", which fits grip sockets, but "back" is a back socket/
    );
    throwsWith(
      variant((samples) => (samples.nodes.giant = { parent: 'humanoid', set: { code: 9, dials: { height: { max: 3 } } } })),
      /"giant" has dials.height.max = 3, outside the limit \[0.6, 1.4\] owned by "humanoid"/
    );
    throwsWith(
      variant((samples) => (samples.nodes.human.set.colors = { skin: 'neon' })),
      /names the palette "neon"/
    );
  });

  // ---- editing ----
  test('body.editor: the schema lists every dial, colour and socket as data, in a stable order', () => {
    const editor = body.editor(catalog);
    const schema = editor.schema({ species: 'human', seed: 7, overrides: { 'fill:handRight': 'sword' } });
    same(
      schema.dials.map((dial) => `${dial.group}/${dial.label}`),
      ['body/Height', 'body/Build', 'head/Head size', 'legs/Leg length', 'arms/Arm length']
    );
    const legs = schema.dials[3];
    same([legs.key, legs.min, legs.max, legs.affects[0].channel, legs.affects[0].bones.length], ['dial:legLength', 0.85, 1.2, 'length', 6]);
    close(legs.step, 0.35 / 255, 1e-9, 'step');
    same(
      schema.colors.map((color) => `${color.id}:${color.palette}:${color.ramps.length}`),
      ['skin:skinTones:5', 'cloth:dyes:4', 'metal:metals:2']
    );
    assert.ok(schema.colors[0].ramps[0].shades.length === 5, 'a ramp is shades, dark to light');
    same(
      schema.sockets.map((socket) => socket.path),
      ['back', 'handLeft', 'handRight', 'headTop', 'handRight/gem']
    );
    const right = schema.sockets[2];
    same([right.label, right.group, right.type, right.part, right.options, right.allowsEmpty, right.mirror], ['Hand right', 'arms', 'grip', 'sword', ['sword'], true, 'fill:handLeft']);
    assert.strictEqual(schema.sockets[3].label, 'Headwear', "a socket's own label wins");
    assert.strictEqual(schema.sockets[4].mirror, 'fill:handLeft/gem');
    same(editor.schema({ species: 'human', seed: 7, overrides: { 'fill:handRight': 'sword' } }), schema, 'stable');
  });
  test('body.editor: edits are pure, validated, and named when refused', () => {
    const editor = body.editor(catalog);
    const start = { species: 'human', seed: 7, overrides: { 'fill:handRight': 'sword', 'fill:handRight/gem': 'ruby' } };
    const frozen = JSON.stringify(start);
    const taller = editor.setDial(start, 'height', 99);
    assert.strictEqual(JSON.stringify(start), frozen, 'the input recipe is untouched');
    close(taller.overrides['dial:height'], 1.2, 1e-9, 'a slider value is clamped');
    assert.strictEqual(editor.setColor(start, 'cloth', 2).overrides['color:cloth'], 2);
    throwsWith(() => editor.setDial(start, 'wingspan', 1), /\[unknown-field\]/);
    throwsWith(() => editor.setColor(start, 'cloth', 44), /\[bad-color\]/);
    throwsWith(() => editor.setSocket(start, 'handLeft', 'hat'), /\[part-does-not-fit\]/);
    throwsWith(() => editor.setSocket(start, 'tail', 'sword'), /\[no-such-socket\]/);
    same(editor.setSocket(start, 'handRight', null).overrides, { 'fill:handRight': null }, 'emptying a socket takes what hung from its part');
    const mirrored = catalog.describe(catalog.resolve(editor.mirror(start, 'right')));
    same([mirrored.fills.handLeft, mirrored.fills['handLeft/gem']], ['sword', 'ruby'], 'the left hand now holds what the right holds');
    throwsWith(() => editor.mirror(start, 'up'), /'left' or 'right'/);
  });
  test('body.editor: randomize keeps locked fields; changes says what a renderer must update', () => {
    const editor = body.editor(catalog);
    const start = { species: 'human', seed: 7, overrides: { 'fill:handRight': 'sword', 'color:skin': 4 } };
    const before = catalog.describe(catalog.resolve(start));
    const rerolled = editor.randomize(start, 8, { locked: ['color:skin', 'dial:height', 'fill:handRight'] });
    const after = catalog.describe(catalog.resolve(rerolled));
    same([after.colors.skin, after.dials.height, after.fills.handRight], [before.colors.skin, before.dials.height, before.fills.handRight], 'locked fields kept');
    assert.notStrictEqual(after.dials.legLength, before.dials.legLength, 'control: an unlocked field re-rolled');
    assert.strictEqual(rerolled.seed, 8);
    const bakery = catalog.bakery();
    const shown = bakery.bakeRecipe(start);
    const legs = editor.changes(shown, bakery.bakeRecipe(editor.setDial(start, 'legLength', 1.2)));
    same([legs.rebuild, legs.dials, legs.colors, legs.sockets], [false, ['legLength'], [], []]);
    same(
      legs.bones.map((bone) => shown.plan.boneNames[bone]),
      ['thighLeft', 'shinLeft', 'footLeft', 'thighRight', 'shinRight', 'footRight'],
      'only the leg bones need re-posing'
    );
    const recoloured = editor.changes(shown, bakery.bakeRecipe(editor.setColor(start, 'cloth', (catalog.resolve(start).colors[1] + 1) % 4)));
    same([recoloured.rebuild, recoloured.colors, recoloured.bones], [false, ['cloth'], []], 'a colour change touches no bone');
    const hatted = editor.changes(shown, bakery.bakeRecipe(editor.setSocket(start, 'headTop', before.fills.headTop ? null : 'hat')));
    same([hatted.rebuild, hatted.sockets], [true, ['headTop']], 'a part change rebuilds the skeleton');
    same(editor.changes(shown, shown), { rebuild: false, species: false, dials: [], colors: [], sockets: [], bones: [] }, 'control: nothing changed');
  });

  // ---- instances and the debug renderer ----
  test('body.store: instances are placed columns; detail follows distance', () => {
    const crowd = body.store(4);
    const near = crowd.spawn(2, 1, 0, 0, 0.5);
    const far = crowd.spawn(3, 50, 0, 0);
    same([crowd.recipe[near], crowd.positionX[near], crowd.heading[near], crowd.count()], [2, 1, 0.5, 2]);
    crowd.assignDetail(0, 0, 0, [10, 30]);
    same([crowd.detail[near], crowd.detail[far]], [0, 2]);
    crowd.despawn(near);
    assert.strictEqual(crowd.spawn(9), near, 'the slot is reused');
    assert.strictEqual(crowd.heading[near], 0, 'with its columns reset');
  });
  test('body.debug: draws a line per bone link and a diamond per socket through any 2D context', () => {
    const calls = { stroke: 0, arc: 0, closePath: 0 };
    const recorder = Object.fromEntries(body.debug.CONTEXT_METHODS.map((method) => [method, () => (calls[method] = (calls[method] || 0) + 1)]));
    const world = body.worldTransforms(biped, body.createPose(biped), body.createPose(biped));
    body.debug.draw(recorder, biped, world, { centerX: 100, groundY: 300, scale: 100 });
    const links = biped.boneCount - 2; // every bone but the ground and the bone that hangs from it
    const tails = [...biped.length].filter((_length, bone) => [0, 1, 2].some((axis) => biped.tail[bone * 3 + axis] !== 0)).length;
    same([calls.arc, calls.closePath, calls.stroke], [biped.boneCount, biped.socketCount, links + tails + biped.socketCount]);
    same([...body.debug.project(0.5, 1.7, 0, { centerX: 100, groundY: 300, scale: 100 }, [])], [150, 130]);
    close(body.debug.project(0, 0, 1, { centerX: 100, groundY: 300, scale: 100, turn: Math.PI / 2 }, [])[0], 0, 1e-9, 'a quarter turn shows depth as width');
  });

  // The character-creator cases (surface, regions, features, sided dials, the wardrobe catalogue) live in their own file.
  require('./test-wardrobe.js')({ Kit, sandbox, test, assert });
};
