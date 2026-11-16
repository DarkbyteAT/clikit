/**
 * Unit tests for what a rich character creator needs from the body system: the generic surface and region
 * modules, shape and feature dials, sided dials and the symmetry lock, required sockets on rolls, surface
 * features and regions on bakes, control metadata, and the wardrobe catalogue. Loaded by tools/test-body.js
 * (which has already loaded the body files into the sandbox), so these count in the one suite.
 *
 * Owns:  the cases, each with a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), the core body tests (tools/test-body.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Kit files these tests add to the sandbox, in load order; those that do not exist yet are skipped. */
const FILES = ['surface', 'region'];

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const throwsWith = (action, pattern, message) => assert.throws(action, (error) => pattern.test(error.message) || assert.fail(`${message || 'wrong error'}: ${error.message}`));

  // ---- Kit.surface ----
  test('surface: signed distance per primitive (inside negative, outside positive) and an unknown kind named', () => {
    const frame = { end: [0, 0.4, 0], girth: 0.1 };
    close(Kit.surface.distance({ kind: 'sphere', radius: 0.1, at: [0, 0.2, 0] }, frame, 0, 0.2, 0), -0.1, 1e-9, 'sphere centre');
    close(Kit.surface.distance({ kind: 'box', size: [0.2, 0.2, 0.2] }, frame, 0.3, 0, 0), 0.2, 1e-9, 'box side');
    close(Kit.surface.distance(null, frame, 0.05, 0.2, 0), 0, 1e-9, 'a null shape is a capsule of the girth');
    close(Kit.surface.distance({ kind: 'capsule', taper: 0 }, frame, 0.05, 0.4, 0), 0.05, 1e-9, 'a taper of 0 closes the far end');
    // A cone-ish lathe: radius 0.1 at the bottom, 0 at the top.
    const cone = {
      kind: 'lathe',
      profile: [
        [0.1, 0],
        [0, 0.2],
      ],
    };
    assert.ok(Kit.surface.distance(cone, frame, 0.04, 0.05, 0) < 0, 'inside the cone low down');
    assert.ok(Kit.surface.distance(cone, frame, 0.04, 0.18, 0) > 0, 'control: the same radius near the tip is outside');
    const legFrame = { end: [0, -0.4, 0] };
    assert.ok(Kit.surface.distance(cone, legFrame, 0.04, -0.05, 0) < 0, 'a lathe runs the way its bone runs (down a leg)');
    const blade = {
      kind: 'extrude',
      outline: [
        [-0.02, 0],
        [0.02, 0],
        [0, 0.3],
      ],
      depth: 0.01,
    };
    assert.ok(Kit.surface.distance(blade, frame, 0, 0.1, 0) < 0 && Kit.surface.distance(blade, frame, 0, 0.1, 0.02) > 0, 'extrude: inside the outline, outside past the depth');
    close(Kit.surface.distance({ kind: 'sphere', radius: 0.1, scale: [2, 1, 1] }, frame, 0.19, 0, 0), -0.005, 1e-9, 'scale stretches the solid (distance shrunk by the smallest stretch)');
    throwsWith(() => Kit.surface.distance({ kind: 'torus' }, frame, 0, 0, 0), /unknown shape kind "torus"/);
  });
  test('surface: place finds the surface point and normal at an azimuth and elevation; it follows a reshaped solid', () => {
    const frame = { end: [0, 0.24, 0] };
    const head = { kind: 'sphere', radius: 0.1, at: [0, 0.12, 0] };
    const front = Kit.surface.place(head, frame, 0, 0);
    same(
      front.point.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 0.12, 0.1],
      'straight ahead'
    );
    same(
      front.normal.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 0, 1]
    );
    same(
      front.up.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 1, 0],
      'up is +Y in the tangent plane'
    );
    const left = Kit.surface.place(head, frame, 90, 0);
    close(left.point[0], 0.1, 1e-6, 'azimuth 90 is the left (+X)');
    const above = Kit.surface.place(head, frame, 0, 90);
    close(above.point[1], 0.22, 1e-6, 'elevation 90 is the top');
    same(above.up.map(Math.round), [0, 0, -1], 'on a surface facing up, up falls back to the back');
    // The same eye spot on a head whose front is pushed out: the placement moves with the surface.
    const pushed = Kit.surface.place({ ...head, scale: [1, 1, 1.3] }, frame, 30, 5);
    const plain = Kit.surface.place(head, frame, 30, 5);
    assert.ok(pushed.point[2] > plain.point[2] + 0.012, 'a deeper head puts the eye further forward');
    const lathe = {
      kind: 'lathe',
      profile: [
        [0.06, 0],
        [0.1, 0.1],
        [0.08, 0.2],
        [0, 0.24],
      ],
    };
    const onLathe = Kit.surface.place(lathe, frame, 0, 0);
    close(Kit.surface.distance(lathe, frame, ...onLathe.point), 0, 1e-6, 'the point is on the lathe surface');
    assert.strictEqual(Kit.surface.place({ kind: 'none' }, frame, 0, 0), null, 'nothing to place on');
  });
  test('surface: pairs mirror about their centre; along gives s and the angle around the long axis', () => {
    same(Kit.surface.pair(0, 50), [25, -25]);
    same(Kit.surface.pair(10, 20), [20, 0], 'an off-centre pair');
    const down = { end: [0, -0.4, 0] };
    const sample = Kit.surface.along(down, 0.05, -0.2, 0);
    close(sample[0], 0.5, 1e-9, 'half-way down a leg');
    close(sample[1], Math.PI / 2, 1e-9, 'its left side');
    close(Kit.surface.along(down, 0, -0.1, 0.05)[1], 0, 1e-9, 'its front');
    close(Kit.surface.along({ end: [0, 0, 0.3] }, 0, 0.05, 0.1)[1], 0, 1e-9, 'a bone along z faces up');
    close(Kit.surface.along(down, 0, 0.5, 0)[0], 0, 1e-9, 'clamped above the joint');
    const ring = Kit.surface.ellipse(0, 0, 1, 0.5, 8);
    same([ring.length, ring[0], ring[2].map(Math.round)], [8, [1, 0], [0, 1]]);
    same(Kit.surface.ellipse(0, 0, 1, 1, 4, { from: 180, to: 360 }).length, 5, 'an arc keeps both ends');
  });

  // ---- Kit.region ----
  test('region: bands, stripes, edges and facing tests combine; the topmost layer wins; mistakes are named', () => {
    const FRONT = [0, 0, 1];
    const at = (region, along, angleDegrees = 0, normal = FRONT) => Kit.region.compile(region)(along, (angleDegrees * Math.PI) / 180, ...normal);
    assert.ok(at({ band: { s: [0, 0.6] } }, 0.3) && !at({ band: { s: [0, 0.6] } }, 0.7), 'a sleeve band');
    assert.ok(at({ band: { angle: [150, -150] } }, 0.5, 180) && !at({ band: { angle: [150, -150] } }, 0.5, 0), 'an angle band wraps through the back');
    const stripes = { stripe: { along: 's', count: 4 } };
    assert.ok(at(stripes, 0.1) && !at(stripes, 0.2) && at(stripes, 0.3), 'four stripes, half painted');
    const hairline = { edge: { front: 0.8, back: 0.3, jag: 0.04, count: 6 } };
    assert.ok(!at(hairline, 0.5, 0) && at(hairline, 0.5, 180), 'a hairline sits high at the front, low at the back');
    assert.ok(at({ edge: { front: 0.8, back: 0.3, below: true } }, 0.5, 0), 'below keeps the other side');
    const belly = { facing: { toward: [0, -1, 1], above: 0.5 } };
    assert.ok(at(belly, 0.5, 0, [0, -0.6, 0.8]) && !at(belly, 0.5, 0, [0, 0.6, 0.8]), 'facing forward and down');
    const vest = { mask: { keep: { band: { s: [0, 1] } }, cut: { band: { angle: [-20, 20], s: [0.6, 1] } } } };
    assert.ok(!at(vest, 0.8, 0) && at(vest, 0.8, 90) && at(vest, 0.3, 0), 'a vest is open at the front of the chest only');
    assert.ok(at({ union: [{ band: { s: [0, 0.1] } }, { band: { s: [0.9, 1] } }] }, 0.95) && !at({ intersect: [{ band: { s: [0, 0.5] } }, { band: { s: [0.4, 1] } }] }, 0.3));
    assert.ok(at({ not: { all: true } }, 0.5) === false && at({ checker: { s: 2, angle: 2 } }, 0.1, -170) !== at({ checker: { s: 2, angle: 2 } }, 0.6, -170), 'not, and a checker alternates');
    const layers = [{ test: Kit.region.compile({ all: true }) }, { test: Kit.region.compile({ band: { s: [0, 0.6] } }) }];
    same([Kit.region.at(layers, 0.3, 0, 0, 0, 1), Kit.region.at(layers, 0.8, 0, 0, 0, 1), Kit.region.at([], 0.3, 0, 0, 0, 1)], [1, 0, -1], 'topmost wins; none is -1');
    throwsWith(() => Kit.region.compile({ ring: {} }), /unknown predicate "ring"/);
    throwsWith(() => Kit.region.compile({ band: { s: [0] } }), /"band.s" needs a \[from, to\] pair/);
    throwsWith(() => Kit.region.compile({ band: {}, all: true }), /one \{ predicate: argument \} object/);
    throwsWith(() => Kit.region.compile({ union: [] }), /"union" needs a non-empty list/);
  });

  test('dials: the default is exactly reachable and survives encode and decode (control: the neighbouring step is not the default)', () => {
    const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
    const kind = catalog.species('human');
    const legs = kind.dialIds.indexOf('legLength');
    const recipe = { species: 'human', seed: 5, overrides: { 'dial:legLength': 1 } };
    assert.strictEqual(catalog.resolve(recipe).dials[legs], 1, 'resolves to exactly 1');
    assert.strictEqual(catalog.decode(catalog.encode(recipe)).overrides['dial:legLength'], 1, 'and decodes to exactly 1');
    const nextStep = kind.dialMin[legs] + ((kind.dialDefaultSteps[legs] + 1) * (kind.dialMax[legs] - kind.dialMin[legs])) / Kit.body.DIAL_STEPS;
    assert.notStrictEqual(Math.fround(catalog.resolve({ ...recipe, overrides: { 'dial:legLength': nextStep } }).dials[legs]), 1, 'control');
  });

  // ---- a test catalogue: the samples with a lathe head, shape dials, a posture dial and a dial on the hat ----
  const body = Kit.body;
  /** A fresh, writable copy of the sample catalogue, changed by `edit`. */
  const sampleVariant = (edit, base = body.samples.CATALOG) => {
    const copy = JSON.parse(JSON.stringify(base));
    edit(copy);
    return copy;
  };
  const HEAD_PROFILE = [
    [0.05, 0],
    [0.09, 0.05],
    [0.1, 0.13],
    [0.07, 0.21],
    [0, 0.24],
  ];
  const SHAPED = sampleVariant((spec) => {
    spec.plans.biped.bones.find((bone) => bone.name === 'head').shape = { kind: 'lathe', profile: HEAD_PROFILE, scale: [1, 1, 0.9] };
    spec.nodes.humanoid.set.dials.jawWidth = { min: 0.8, max: 1.25, affects: [{ roles: ['head'], shape: 'profile.1.0' }] };
    spec.nodes.humanoid.set.dials.headDepth = { min: 0.85, max: 1.2, affects: [{ bones: ['head'], shape: 'scale.2' }] };
    spec.nodes.humanoid.set.dials.posture = { min: -1, max: 1, default: 0, affects: [{ roles: ['spine'], channel: 'pitch', amount: 10 }] };
    spec.nodes.humanoid.set.dials.brimWidth = { min: 0.8, max: 1.5, affects: [{ part: 'hat', bones: ['brim'], shape: 'profile.0.0' }] };
    spec.nodes.humanoid.limits['dials.jawWidth'] = { min: 0.7, max: 1.3 };
  });

  test('shape dials: a dial drives a number in a bone shape without moving any bone (control: a length dial moves them)', () => {
    const shaped = body.catalog(SHAPED);
    const bakery = shaped.bakery();
    const base = { species: 'human', seed: 3, overrides: { 'dial:jawWidth': 1, 'dial:headDepth': 1, 'dial:posture': 0, 'fill:headTop': null } };
    const plain = bakery.bakeRecipe(base);
    const wide = bakery.bakeRecipe({ ...base, overrides: { ...base.overrides, 'dial:jawWidth': 1.25, 'dial:headDepth': 1.2 } });
    const head = plain.plan.boneIndex('head');
    close(plain.shapes[head].profile[1][0], 0.09, 1e-9, 'the default value is exact: the profile as drawn');
    close(wide.shapes[head].profile[1][0], 0.09 * 1.25, 1e-3, 'the jaw point widened');
    close(wide.shapes[head].scale[2], 0.9 * 1.2, 1e-3, 'the head deepened');
    same([...wide.rest.scale], [...plain.rest.scale], 'no bone scale changed');
    same([...wide.rest.translation], [...plain.rest.translation], 'no bone moved');
    close(shaped.plans.biped.shapes[head].profile[1][0], 0.09, 1e-9, 'the plan itself is never written');
    assert.strictEqual(wide.shapes[0], plain.shapes[0], 'untouched bones share the plan row');
    const editor = body.editor(shaped);
    const report = editor.changes(plain, wide);
    same([report.rebuild, report.bones, report.shapes.map((bone) => plain.plan.boneNames[bone])], [false, [], ['head']], 'changes: reshape the head mesh only');
    const longLegs = bakery.bakeRecipe({ ...base, overrides: { ...base.overrides, 'dial:legLength': 1.2 } });
    assert.notDeepStrictEqual([...longLegs.rest.scale], [...plain.rest.scale], 'control: a length dial does change bone scale');
    same(editor.schema(base).dials.find((dial) => dial.id === 'jawWidth').affects, [{ channel: 'shape', param: 'profile.1.0', bones: ['head'] }]);
  });
  test('shape dials: a part dial reshapes the part wherever it sits; posture pitches the spine; limits are the species own', () => {
    const shaped = body.catalog(SHAPED);
    const bakery = shaped.bakery();
    const hatted = bakery.bakeRecipe({ species: 'human', seed: 3, overrides: { 'fill:headTop': 'hat', 'dial:brimWidth': 1.5 } });
    const brim = hatted.plan.boneIndex('headTop/brim');
    close(hatted.shapes[brim].profile[0][0], 0.17 * 1.5, 1e-3, 'the brim of the worn hat widened');
    close(shaped.parts.hat.spec.bones[0].shape.profile[0][0], 0.17, 1e-9, 'the part itself is untouched');
    const bare = bakery.bakeRecipe({ species: 'human', seed: 3, overrides: { 'fill:headTop': null, 'dial:brimWidth': 1.5 } });
    assert.strictEqual(bare.plan.boneNames.includes('headTop/brim'), false, 'control: no hat, nothing to widen, no error');
    const upright = bakery.bakeRecipe({ species: 'human', seed: 3, overrides: { 'dial:posture': 0 } });
    const slouched = bakery.bakeRecipe({ species: 'human', seed: 3, overrides: { 'dial:posture': 1 } });
    const waist = upright.plan.boneIndex('waist');
    same([...upright.rest.rotation.slice(waist * 4, waist * 4 + 4)], [0, 0, 0, 1], 'the default posture is exactly the rest rotation');
    close(2 * Math.asin(slouched.rest.rotation[waist * 4]), (10 * Math.PI) / 180, 1e-5, 'posture 1 leans each spine bone 10 degrees about x');
    throwsWith(
      () => body.catalog(sampleVariant((spec) => (spec.nodes.human.set.dials = { jawWidth: { max: 1.4 } }), SHAPED)),
      /"human" has dials.jawWidth.max = 1.4, outside the limit \[0.7, 1.3\] owned by "humanoid"/
    );
    body.catalog(sampleVariant((spec) => (spec.nodes.human.set.dials = { jawWidth: { max: 1.3 } }), SHAPED)); // control: inside the limit
  });
  test('shape dials: mistakes are named (no such number in the shape, a default capsule, a bad mode, a feature without param)', () => {
    const plan = body.samples.PLANS.biped;
    const biped = body.plan({ ...plan, id: 'biped' });
    throwsWith(
      () => body.dials(biped, [{ id: 'jaw', min: 0.5, max: 2, affects: [{ bones: ['head'], shape: 'profile.1.0' }] }]),
      /shape.profile.1.0 of bone "head", whose shape \(sphere\) has no number there/
    );
    throwsWith(() => body.dials(biped, [{ id: 'fat', min: 0.5, max: 2, affects: [{ bones: ['waist'], shape: 'radius' }] }]), /is the default capsule; give the bone a `shape`/);
    throwsWith(() => body.dials(biped, [{ id: 'jaw', min: 0.5, max: 2, affects: [{ bones: ['head'], shape: 'radius', mode: 'twist' }] }]), /has the mode "twist"/);
    throwsWith(() => body.dials(biped, [{ id: 'eyes', min: 0.5, max: 2, affects: [{ feature: 'eye' }] }]), /needs a `param`/);
    const fine = body.dials(biped, [{ id: 'headRound', min: 0.5, max: 2, affects: [{ bones: ['head'], shape: 'radius' }] }]);
    same([fine.shapeOps.length, fine.unused], [1, []], 'control: a sphere radius is a number');
  });

  // ---- sided dials, the symmetry lock and mirror ----
  const SIDED = sampleVariant((spec) => {
    spec.nodes.humanoid.set.dials.handSize = { sided: true, min: 0.8, max: 1.3, affects: [{ roles: ['hand'], channel: 'size' }] };
    // Wings that carry a charm socket on each wing bone: sided sockets inside a part that sits in the middle.
    spec.parts.wings.sockets = [
      { name: 'charmLeft', bone: 'wingLeftTip', type: 'charm' },
      { name: 'charmRight', bone: 'wingRightTip', type: 'charm' },
    ];
    spec.parts.charm = { fits: ['charm'], bones: [{ name: 'bead', roles: ['root'], shape: { kind: 'sphere', radius: 0.02 } }] };
    spec.nodes.humanoid.set.fills.back = { wings: 1, none: 1 };
  });

  test('sided dials: one field draws both sides (linked); a side set alone unlinks; link joins them again', () => {
    const sided = body.catalog(SIDED);
    const editor = body.editor(sided);
    const kind = sided.species('human');
    const [left, right] = ['handSize@left', 'handSize@right'].map((id) => kind.dialIds.indexOf(id));
    assert.ok(left >= 0 && right >= 0, 'two dials, one per side');
    for (let seed = 0; seed < 30; seed++) {
      const rolled = sided.resolve({ species: 'human', seed });
      assert.strictEqual(rolled.dials[left], rolled.dials[right], `seed ${seed}: a roll is symmetric`);
    }
    const start = { species: 'human', seed: 4 };
    const controls = editor.schema(start).dials.filter((dial) => dial.base === 'handSize');
    same(
      controls.map((dial) => [dial.key, dial.side, dial.linked, dial.mirror]),
      [
        ['dial:handSize@left', 'left', true, 'dial:handSize@right'],
        ['dial:handSize@right', 'right', true, 'dial:handSize@left'],
      ]
    );
    const both = editor.setDial(start, 'handSize', 1.3);
    same([both.overrides['dial:handSize@left'], both.overrides['dial:handSize@right']], [1.3, 1.3], 'the base id moves both sides');
    const unlinked = editor.setDial(both, 'handSize@left', 0.8);
    same(
      editor
        .schema(unlinked)
        .dials.filter((dial) => dial.base === 'handSize')
        .map((dial) => [Math.round(dial.value * 100) / 100, dial.linked]),
      [
        [0.8, false],
        [1.3, false],
      ],
      'one side alone'
    );
    const bakery = sided.bakery();
    const bake = bakery.bakeRecipe(unlinked);
    const [handLeft, handRight] = ['handLeft', 'handRight'].map((name) => bake.plan.boneIndex(name));
    same(
      [bake.rest.uniform[handLeft], bake.rest.uniform[handRight]].map((value) => Math.round(value * 100) / 100),
      [0.8, 1.3],
      'only the left hand shrank'
    );
    same(
      editor.changes(bakery.bakeRecipe(both), bake).bones.map((bone) => bake.plan.boneNames[bone]),
      ['handLeft'],
      'control: the right hand did not change'
    );
    const relinked = editor.link(unlinked, 'handSize', 'right');
    same([relinked.overrides['dial:handSize@left'], relinked.overrides['dial:handSize@right']], [1.3, 1.3], 'link copies the chosen side');
    same(sided.decode(sided.encode(unlinked)), sided.normalize(unlinked), 'sided overrides survive encode and decode');
    throwsWith(() => editor.link(start, 'height'), /\[unknown-field\] "human" has no sided dial "height". Sided dials: handSize/);
  });
  test('sided dials: mistakes are named (a sided effect by bone name, an id with @)', () => {
    throwsWith(() => body.sidedDials([{ id: 'grip', sided: true, min: 0.5, max: 2, affects: [{ bones: ['handLeft'], channel: 'size' }] }]), /picks bones by name or part/);
    throwsWith(() => body.sidedDials([{ id: 'grip@left', min: 0.5, max: 2, affects: [] }]), /contains '@'/);
    same(
      body.sidedDials([{ id: 'plain', min: 0.5, max: 2, affects: [] }]).map((row) => row.id),
      ['plain'],
      'control: an unsided row passes through'
    );
  });
  test('mirror: the target side ends up exactly the mirror of the source, nested and inside a centred part', () => {
    const sided = body.catalog(SIDED);
    const editor = body.editor(sided);
    const fillsOf = (recipe) => sided.resolve(recipe).fills;
    const winged = { species: 'human', seed: 4, overrides: { 'fill:back': 'wings', 'fill:back/charmRight': 'charm', 'fill:back/charmLeft': null } };
    same(
      editor
        .schema(winged)
        .sockets.filter((socket) => socket.path.startsWith('back/'))
        .map((socket) => [socket.path, socket.side, socket.mirror]),
      [
        ['back/charmLeft', 'left', 'fill:back/charmRight'],
        ['back/charmRight', 'right', 'fill:back/charmLeft'],
      ],
      'sockets inside the wings know their side'
    );
    assert.strictEqual(fillsOf(editor.mirror(winged, 'left'))['back/charmRight'], undefined, 'the right charm is cleared: the left has none');
    assert.strictEqual(fillsOf(editor.mirror(winged, 'right'))['back/charmLeft'], 'charm', 'control: mirroring the other way copies it');
    const armed = { species: 'human', seed: 7, overrides: { 'fill:handRight': 'sword', 'fill:handRight/gem': 'ruby', 'fill:handLeft': null } };
    const mirrored = editor.mirror(armed, 'left');
    same(fillsOf(mirrored), {}, 'an empty left hand empties the right hand and its gem');
    same(
      Object.keys(mirrored.overrides).filter((key) => key.startsWith('fill:')),
      ['fill:handLeft', 'fill:handRight'],
      'no override is left for a socket that no longer exists'
    );
    const handSizes = editor.mirror(editor.setDial({ species: 'human', seed: 4 }, 'handSize@left', 0.8), 'left');
    same([handSizes.overrides['dial:handSize@left'], handSizes.overrides['dial:handSize@right']], [0.8, 0.8], 'sided dials mirror too');
  });
};
