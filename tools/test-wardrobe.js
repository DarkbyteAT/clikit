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
const FILES = ['body-wardrobe', 'figure-shapes', 'figure-layout'];

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
    assert.ok(Kit.surface.distance(cone, legFrame, 0.04, 0.05, 0) < 0, 'a lathe runs up its positive axis even on a bone that hangs down (the renderer convention)');
    assert.ok(
      Kit.surface.distance(
        {
          kind: 'lathe',
          profile: [
            [0.1, 0],
            [0, -0.2],
          ],
        },
        legFrame,
        0.04,
        -0.05,
        0
      ) < 0,
      'so a hanging cone states negative heights'
    );
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
    // The sample biped states a drawn shape for every bone, so the default capsule is tried on a copy whose waist states none.
    const bare = body.plan({ ...plan, id: 'bareWaist', bones: plan.bones.map(({ shape, ...bone }) => (bone.name === 'waist' ? bone : { ...bone, ...(shape ? { shape } : {}) })) });
    throwsWith(() => body.dials(bare, [{ id: 'fat', min: 0.5, max: 2, affects: [{ bones: ['waist'], shape: 'radius' }] }]), /is the default capsule; give the bone a `shape`/);
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

  // ---- required sockets on rolls ----
  const withLantern = (required, edit = () => {}) =>
    sampleVariant((spec) => {
      spec.parts.lantern = {
        fits: ['grip'],
        bones: [{ name: 'cage', roles: ['root'], tail: [0, -0.2, 0], shape: { kind: 'box', size: [0.1, 0.2, 0.1] } }],
        sockets: [{ name: 'flame', bone: 'cage', type: 'flame', at: [0, -0.1, 0], required }],
      };
      spec.parts.candle = { fits: ['flame'], bones: [{ name: 'wick', roles: ['root'], shape: { kind: 'sphere', radius: 0.02 } }] };
      spec.parts.wisp = { fits: ['flame'], bones: [{ name: 'glow', roles: ['root'], shape: { kind: 'sphere', radius: 0.03 } }] };
      spec.nodes.humanoid.set.fills.handLeft = { lantern: 1, none: 1 };
      edit(spec);
    });

  test('required sockets: a rolled part with a required socket always gets it filled (control: not required, left empty)', () => {
    const required = body.catalog(withLantern(true));
    const optional = body.catalog(withLantern(false));
    const lanterns = (catalog) => Array.from({ length: 60 }, (_unused, seed) => catalog.resolve({ species: 'human', seed })).filter((individual) => individual.fills.handLeft === 'lantern');
    const lit = lanterns(required);
    assert.ok(lit.length > 10, 'enough lanterns rolled to judge');
    assert.ok(
      lit.every((individual) => ['candle', 'wisp'].includes(individual.fills['handLeft/flame'])),
      'every lantern is lit'
    );
    same(new Set(lit.map((individual) => individual.fills['handLeft/flame'])).size, 2, 'both flames are rolled: a seeded pick, not the first part');
    assert.ok(
      lanterns(optional).every((individual) => !individual.fills['handLeft/flame']),
      'control: an optional socket with no declared fill stays empty'
    );
    const editor = body.editor(required);
    const handed = required.resolve(editor.setSocket({ species: 'human', seed: 1 }, 'handRight', 'lantern'));
    assert.ok(handed.fills['handRight/flame'], 'an override that puts the lantern in the other hand lights it too');
    assert.deepStrictEqual(Object.keys(handed.fills), [...Object.keys(handed.fills)].sort(body.compareSocketPaths), 'fills stay in canonical order');
    throwsWith(() => editor.setSocket(editor.setSocket({ species: 'human', seed: 1 }, 'handRight', 'lantern'), 'handRight/flame', null), /\[socket-required\]/);
    const recipe = editor.setSocket({ species: 'human', seed: 1 }, 'handRight', 'lantern');
    same(required.decode(required.encode(recipe)), required.normalize(recipe), 'round trip');
    assert.strictEqual(required.hash(required.resolve(recipe)), required.hash(required.resolve(required.decode(required.encode(recipe)))), 'same look after a round trip');
  });
  test('required sockets: a declared none for a required nested socket and an unfillable required socket are load errors', () => {
    throwsWith(
      () => body.catalog(withLantern(true, (spec) => (spec.nodes.humanoid.set.fills['handLeft/flame'] = { candle: 1, none: 1 }))),
      /fills.handLeft\/flame offers 'none', but the part "lantern" marks that socket required/
    );
    body.catalog(withLantern(true, (spec) => (spec.nodes.humanoid.set.fills['handLeft/flame'] = { candle: 1 }))); // control
    throwsWith(
      () =>
        body.catalog(
          withLantern(true, (spec) => {
            delete spec.parts.candle;
            delete spec.parts.wisp;
          })
        ),
      /the part "lantern" has the required socket "flame" \(type flame\), but no part in `parts` fits a flame socket/
    );
  });

  // ---- surface features and regions ----
  const eyeFrames = (openHeight) => ({
    open: [
      { outline: Kit.surface.ellipse(0, 0, 1, openHeight, 10), paint: { channel: 'cloth', shade: 4 } },
      { outline: Kit.surface.ellipse(0, 0, 0.4, 0.4, 8), paint: { channel: 'skin', shade: 99 } },
    ],
    half: [{ outline: Kit.surface.ellipse(0, -0.2, 1, openHeight / 2, 10), paint: { channel: 'cloth', shade: 4 } }],
    closed: [{ outline: Kit.surface.ellipse(0, -0.3, 1, 0.12, 10, { from: 180, to: 360 }), paint: { channel: 'skin', shade: 0 } }],
  });
  const SURFACED = sampleVariant((spec) => {
    spec.plans.biped.sockets.push({ name: 'eyes', bone: 'head', type: 'eyes' }, { name: 'top', bone: 'chest', type: 'top' }, { name: 'hair', bone: 'head', type: 'hair' });
    spec.parts.roundEyes = { fits: ['eyes'], bones: [], features: [{ id: 'eye', azimuth: 0, elevation: 4, spacing: 50, size: [0.03, 0.025], rotation: 8, frames: eyeFrames(0.8) }] };
    spec.parts.nose = { fits: ['eyes'], bones: [], features: [{ id: 'nose', elevation: -12, shape: { kind: 'sphere', radius: 0.012 }, lift: 0.004, paint: 'skin' }] };
    spec.parts.tee = {
      fits: ['top'],
      bones: [],
      regions: [
        { id: 'body', roles: ['spine'], where: { band: { s: [0, 1] } }, paint: 'cloth', layer: 2 },
        { id: 'sleeve', roles: ['arm'], except: ['hand'], where: { band: { s: [0, 0.6] } }, paint: 'cloth', layer: 2 },
      ],
    };
    spec.parts.crop = {
      fits: ['hair'],
      bones: [{ name: 'fringe', roles: ['root'], tail: [0, 0, 0.05], shape: { kind: 'box', size: [0.16, 0.03, 0.04] } }],
      regions: [{ id: 'cap', bones: ['@host'], where: { edge: { front: 0.75, back: 0.35, jag: 0.03, count: 7 } }, paint: 'metal', layer: 4 }],
    };
    spec.nodes.humanoid.set.fills.eyes = { roundEyes: 1 };
    spec.nodes.humanoid.set.dials.eyeSpacing = { min: 0.7, max: 1.4, affects: [{ feature: 'eye', param: 'spacing' }] };
    spec.nodes.humanoid.set.dials.eyeSize = { sided: true, min: 0.7, max: 1.4, affects: [{ feature: 'eye', param: 'size' }] };
    spec.nodes.humanoid.set.dials.eyeHeight = { min: -10, max: 10, default: 0, affects: [{ feature: 'eye', param: 'elevation', mode: 'offset' }] };
  });
  const FACE = { 'dial:eyeSpacing': 1, 'dial:eyeSize@left': 1, 'dial:eyeSize@right': 1, 'dial:eyeHeight': 0 };

  test('features: a surface-only part places a mirrored pair on the head surface, with frames painted by ramp and shade', () => {
    const faced = body.catalog(SURFACED);
    const bake = faced.bakery().bakeRecipe({ species: 'human', seed: 2, overrides: FACE });
    assert.strictEqual(
      bake.plan.boneNames.some((name) => name.startsWith('eyes/')),
      false,
      'a surface-only part adds no bones'
    );
    const eyes = bake.surface.features.filter((feature) => feature.id === 'eye');
    same(
      eyes.map((eye) => [eye.side, eye.flip]),
      [
        ['left', false],
        ['right', true],
      ]
    );
    const head = bake.plan.boneIndex('head');
    assert.ok(
      eyes.every((eye) => eye.bone === head),
      'on the bone of the socket the part sits in'
    );
    assert.ok(eyes[0].point[0] > 0.04 && eyes[1].point[0] < -0.04, 'left eye at +X, right at -X');
    close(eyes[0].point[0], -eyes[1].point[0], 1e-6, 'mirrored');
    const frame = { end: [0, 0.22, 0] };
    close(Kit.surface.distance(bake.shapes[head], frame, ...eyes[0].point), 0, 1e-5, 'on the surface of the head');
    assert.ok(eyes[0].normal[2] > 0.7, 'facing forward');
    close(eyes[0].rotation, -eyes[1].rotation, 1e-9, 'the right copy turns the other way');
    const skin = faced.species('human').colorIds.indexOf('skin');
    same(
      eyes[0].frames.open.map((layer) => [layer.ramp, layer.shade]),
      [
        [faced.species('human').colorIds.indexOf('cloth'), 4],
        [skin, 4],
      ],
      'channels become ramp indices; shade 99 is clamped to the ramp'
    );
    same([Object.keys(eyes[0].frames), eyes[0].rest], [['open', 'half', 'closed'], 'open'], 'blink frames, resting open');
    same(body.FRAME_SETS.blink, ['open', 'half', 'closed']);
  });
  test('features: dials move them (spacing, one side only, height in degrees); they follow a reshaped head (control: no eyes, no features)', () => {
    const faced = body.catalog(SURFACED);
    const bakery = faced.bakery();
    const eyesOf = (overrides) => bakery.bakeRecipe({ species: 'human', seed: 2, overrides: { ...FACE, ...overrides } }).surface.features.filter((feature) => feature.id === 'eye');
    const plain = eyesOf({});
    assert.ok(eyesOf({ 'dial:eyeSpacing': 1.4 })[0].point[0] > plain[0].point[0] + 0.01, 'wider spacing');
    const oneBig = eyesOf({ 'dial:eyeSize@left': 1.4 });
    const editor = body.editor(faced);
    const base = { species: 'human', seed: 2, overrides: FACE };
    same(editor.changes(bakery.bakeRecipe(base), bakery.bakeRecipe(editor.setDial(base, 'eyeSize@left', 1.4))).features, ['eye'], 'changes names the feature to re-stamp');
    same(editor.changes(bakery.bakeRecipe(base), bakery.bakeRecipe(editor.setDial(base, 'legLength', 1.1))).features, [], 'control: a leg dial re-stamps nothing');
    same(
      oneBig.map((eye) => Math.round((eye.size[0] / 0.03) * 100) / 100),
      [1.4, 1],
      'a sided size dial grows the left eye only'
    );
    assert.ok(eyesOf({ 'dial:eyeHeight': 10 })[0].point[1] > plain[0].point[1] + 0.01, 'an offset dial raises both eyes');
    // A wider head (the sphere scaled in x) pushes the eyes outwards: placement follows the surface.
    const wide = sampleVariant((spec) => (spec.plans.biped.bones.find((bone) => bone.name === 'head').shape.scale = [1.3, 1, 1]), SURFACED);
    const wideEyes = body
      .catalog(wide)
      .bakery()
      .bakeRecipe({ species: 'human', seed: 2, overrides: FACE })
      .surface.features.filter((feature) => feature.id === 'eye');
    assert.ok(wideEyes[0].point[0] > plain[0].point[0] + 0.0015, 'eyes ride the wider head');
    const noFace = sampleVariant((spec) => (spec.nodes.humanoid.set.fills.eyes = { none: 1 }), SURFACED);
    same(body.catalog(noFace).bakery().bakeRecipe({ species: 'human', seed: 2 }).surface.features, [], 'control: nothing in the socket, no features');
    const nose = bakery.bakeRecipe({ species: 'human', seed: 2, overrides: { ...FACE, 'fill:eyes': 'nose' } }).surface.features;
    same(
      nose.map((feature) => [feature.id, feature.side, feature.shape.kind, feature.ramp]),
      [['nose', null, 'sphere', faced.species('human').colorIds.indexOf('skin')]],
      'a single solid feature'
    );
  });
  test('regions: parts paint the wearer by role and their host bone; the topmost layer wins; none falls back to the bone (-1)', () => {
    const faced = body.catalog(SURFACED);
    const bakery = faced.bakery();
    const dressed = bakery.bakeRecipe({ species: 'human', seed: 2, overrides: { ...FACE, 'fill:top': 'tee', 'fill:hair': 'crop' } });
    const at = (bake, bone, along, angleDegrees = 0) => bake.surface.regionAt(bake.plan.boneIndex(bone), along, (angleDegrees * Math.PI) / 180, 0, 0, 1);
    const kind = faced.species('human');
    const [cloth, metal] = ['cloth', 'metal'].map((channel) => kind.colorIds.indexOf(channel));
    same([at(dressed, 'chest', 0.5), at(dressed, 'upperArmLeft', 0.3), at(dressed, 'upperArmLeft', 0.8), at(dressed, 'handLeft', 0.2)], [cloth, cloth, -1, -1], 'shirt, sleeve, bare elbow, bare hand');
    same([at(dressed, 'head', 0.9, 0), at(dressed, 'head', 0.5, 0), at(dressed, 'head', 0.5, 180)], [metal, -1, metal], 'a hairline high at the front, low at the back');
    assert.strictEqual(dressed.plan.boneNames.includes('hair/fringe'), true, 'a hair part can bring bones too');
    const bare = bakery.bakeRecipe({ species: 'human', seed: 2, overrides: { ...FACE, 'fill:top': null, 'fill:hair': null } });
    same([at(bare, 'chest', 0.5), at(bare, 'head', 0.9)], [-1, -1], 'control: nothing worn, nothing painted');
    const layered = sampleVariant((spec) => {
      spec.plans.biped.sockets.push({ name: 'outer', bone: 'chest', type: 'outer' });
      spec.parts.vest = {
        fits: ['outer'],
        bones: [],
        regions: [{ id: 'vest', roles: ['spine'], where: { mask: { keep: { all: true }, cut: { band: { angle: [-25, 25] } } } }, paint: 'metal', layer: 3 }],
      };
    }, SURFACED);
    const vested = body
      .catalog(layered)
      .bakery()
      .bakeRecipe({ species: 'human', seed: 2, overrides: { ...FACE, 'fill:top': 'tee', 'fill:outer': 'vest' } });
    same([at(vested, 'chest', 0.5, 0), at(vested, 'chest', 0.5, 90)], [cloth, metal], 'the vest (layer 3) covers the tee (layer 2) except where it is open');
  });
  test('surface: mistakes in features and regions are named at catalogue load', () => {
    const broken = (edit) => () => body.catalog(sampleVariant(edit, SURFACED));
    throwsWith(
      broken((spec) => (spec.parts.roundEyes.features[0].frames.open[0].paint = null)),
      /part "roundEyes": the feature "eye" of|frame "open": every layer needs/
    );
    throwsWith(
      broken((spec) => (spec.parts.tee.regions[1].where = { ring: {} })),
      /the region "sleeve".*unknown predicate "ring"/
    );
    throwsWith(
      broken((spec) => delete spec.parts.nose.features[0].shape),
      /neither `frames` \(a stamp\) nor a `shape`/
    );
    throwsWith(
      broken((spec) => (spec.parts.roundEyes.sockets = [{ name: 'tear', bone: 'surface', type: 'gem' }])),
      /a part with no bones cannot offer sockets/
    );
    throwsWith(
      broken((spec) => (spec.parts.tee.regions[0].paint = undefined)),
      /the region "body".*needs `paint`/
    );
    throwsWith(
      () => body.surfaceLayout(body.plan({ id: 'blob', bones: [{ name: 'core' }], features: [{ id: 'spot', bone: 'shell', shape: { kind: 'sphere', radius: 0.01 } }] })),
      /names the bone "shell", which this plan does not have/
    );
    body.catalog(SURFACED); // control
  });

  // ---- control metadata as data ----
  const LABELLED = sampleVariant((spec) => {
    spec.nodes.humanoid.set.controls = {
      'dial:height': { label: 'Stature', group: 'shape', order: 2, hint: 'Overall size, feet to crown.', icon: 'ruler', step: 0.01 },
      'dial:handSize': { label: 'Hands', group: 'shape', order: 1 },
      'color:cloth': { label: 'Fabric', group: 'outfit', icon: 'swatch' },
      'fill:headTop': { label: 'Hat', group: 'outfit', order: 0 },
    };
    spec.nodes.humanoid.set.groups = { outfit: { label: 'Outfit', order: 2, icon: 'shirt' }, shape: { label: 'Shape', order: 1 } };
    spec.parts.hat.label = 'Wide hat';
    spec.parts.hat.icon = 'hat';
  }, SIDED);

  test('control metadata: labels, groups, order, hints, steps and icons come from data rows (control: unlabelled ones are generated)', () => {
    const labelled = body.catalog(LABELLED);
    const editor = body.editor(labelled);
    const schema = editor.schema({ species: 'human', seed: 7 });
    const height = schema.dials.find((dial) => dial.id === 'height');
    same([height.label, height.group, height.order, height.hint, height.icon, height.step], ['Stature', 'shape', 2, 'Overall size, feet to crown.', 'ruler', 0.01]);
    same(
      schema.dials.filter((dial) => dial.base === 'handSize').map((dial) => [dial.label, dial.group, dial.order]),
      [
        ['Hands', 'shape', 1],
        ['Hands', 'shape', 1],
      ],
      'a base row labels both sides'
    );
    const legs = schema.dials.find((dial) => dial.id === 'legLength');
    same([legs.label, legs.group, legs.hint, legs.icon], ['Leg length', 'legs', null, null], 'control: a dial with no row keeps its generated label and group');
    assert.ok(legs.order >= 1e6, 'and sorts after the ordered ones');
    close(legs.step, 0.35 / 255, 1e-9, 'and its step is one stored step');
    const cloth = schema.colors.find((color) => color.id === 'cloth');
    same([cloth.label, cloth.group, cloth.icon, schema.colors.find((color) => color.id === 'skin').group], ['Fabric', 'outfit', 'swatch', 'colors']);
    const hat = schema.sockets.find((socket) => socket.path === 'headTop');
    same(
      [hat.label, hat.group, hat.order, hat.choices],
      [
        'Hat',
        'outfit',
        0,
        [
          { id: null, label: 'None', icon: null, hint: null },
          { id: 'hat', label: 'Wide hat', icon: 'hat', hint: null },
        ],
      ]
    );
    same(
      schema.groups.slice(0, 2).map((group) => [group.id, group.label, group.icon]),
      [
        ['shape', 'Shape', null],
        ['outfit', 'Outfit', 'shirt'],
      ],
      'groups sorted by their rows'
    );
    assert.ok(
      schema.groups.some((group) => group.id === 'legs' && group.label === 'Legs'),
      'a group with no row is listed with a generated label'
    );
  });
  test('control metadata: a row for a field the species lacks, or an unknown field, is named when the editor is made', () => {
    const broken = (edit) => () => body.editor(body.catalog(sampleVariant(edit, LABELLED)));
    throwsWith(
      broken((spec) => (spec.nodes.humanoid.set.controls['dial:wingspan'] = { label: 'Wings' })),
      /controls has a row for "dial:wingspan", which is not a dial or colour/
    );
    throwsWith(
      broken((spec) => (spec.nodes.humanoid.set.controls['dial:height'].colour = 'red')),
      /sets "colour"; a control row sets label, group, order, hint, step, icon/
    );
    throwsWith(
      broken((spec) => (spec.nodes.humanoid.set.controls['dial:height'].step = -1)),
      /step = -1 is not a valid step/
    );
    throwsWith(
      broken((spec) => (spec.nodes.humanoid.set.groups.shape.colour = 'red')),
      /groups.shape sets "colour"/
    );
    body.editor(body.catalog(LABELLED)); // control
  });

  // ---- the wardrobe catalogue ----
  const wardrobe = body.catalog(body.wardrobe.CATALOG);

  test('wardrobe: four species load; every part is offered somewhere; variants hold their ranges (control: the base is wider)', () => {
    same(wardrobe.speciesIds(), ['person', 'stout', 'lanky', 'hornkin']);
    const offered = new Set(wardrobe.speciesIds().flatMap((id) => wardrobe.species(id).fillFields.flatMap((field) => field.options.map((option) => option.part))));
    // Flames are filled through the lantern's required socket; wings are a trait no shipped species uses yet.
    const unoffered = Object.keys(body.wardrobe.PARTS).filter((id) => !offered.has(id));
    same(unoffered, ['candle', 'glowstone', 'featherWings'], 'every other part can be rolled');
    const heights = (species) => Array.from({ length: 80 }, (_unused, seed) => wardrobe.describe(wardrobe.resolve({ species, seed })).dials.height);
    assert.ok(
      heights('stout').every((height) => height >= 0.82 && height <= 0.95),
      'stout stays short'
    );
    assert.ok(
      heights('lanky').every((height) => height >= 1.05),
      'lanky stays tall'
    );
    assert.ok(heights('person').some((height) => height < 0.95) && heights('person').some((height) => height > 1.05), 'control: the base species spans both');
    const traits = (species) => Array.from({ length: 40 }, (_unused, seed) => wardrobe.resolve({ species, seed }).fills);
    assert.ok(
      traits('hornkin').every((fills) => fills.horns && fills.tail && ['earsPointed', 'earsLong'].includes(fills.ears)),
      'every hornkin has horns, a tail and pointed or long ears'
    );
    assert.ok(
      traits('person').every((fills) => !fills.horns && !fills.tail),
      'control: people have neither'
    );
    throwsWith(
      () => body.catalog(sampleVariant((spec) => (spec.nodes.lanky.set.dials.legLength = { min: 1.1, max: 1.3, default: 1.2 }), body.wardrobe.CATALOG)),
      /"lanky" has dials.legLength.max = 1.3, outside the limit \[0.85, 1.2\] owned by "humanoid"/
    );
  });
  test('wardrobe: every roll is valid, with eyes, a nose, a mouth and ears placed; a face blinks and talks', () => {
    const bakery = wardrobe.bakery();
    const table = wardrobe.table(wardrobe.speciesIds().map((species) => ({ species })));
    for (let index = 0; index < 60; index++) {
      const recipe = table.roll(11, index);
      same(wardrobe.validate(recipe), [], `roll ${index}`);
      const ids = bakery.bakeRecipe(recipe).surface.features.map((feature) => feature.id);
      ['eye', 'nose', 'mouth', 'ear'].forEach((id) => assert.ok(ids.includes(id), `roll ${index} has a placed ${id}`));
    }
    const face = bakery.bakeRecipe({ species: 'person', seed: 5 }).surface.features;
    same(Object.keys(face.find((feature) => feature.id === 'eye').frames), body.FRAME_SETS.blink);
    same(Object.keys(face.find((feature) => feature.id === 'mouth').frames), body.FRAME_SETS.talk);
  });
  test('wardrobe: editor round trip (schema -> edits -> encode -> decode -> equal), and the look survives it', () => {
    const editor = body.editor(wardrobe);
    let recipe = { species: 'hornkin', seed: 99 };
    const controls = editor.schema(recipe);
    same(
      controls.groups.map((group) => group.id),
      ['head', 'face', 'body', 'arms', 'legs', 'hair', 'outfit', 'accessories', 'traits', 'colors']
    );
    // One edit of each kind, driven only by what the schema says.
    controls.dials.forEach((dial, index) => {
      if (index % 3 === 0) recipe = editor.setDial(recipe, dial.id, dial.min + ((dial.max - dial.min) * (index % 7)) / 6);
    });
    recipe = editor.setDial(recipe, 'eyeSize@left', 1.3);
    recipe = editor.setColor(recipe, 'skin', controls.colors.find((color) => color.id === 'skin').ramps.length - 1);
    recipe = editor.setSocket(recipe, 'handLeft', 'lantern');
    recipe = editor.setSocket(recipe, 'handLeft/flame', 'glowstone');
    recipe = editor.setSocket(recipe, 'hat', 'circlet');
    recipe = editor.mirror(recipe, 'left');
    const decoded = wardrobe.decode(wardrobe.encode(recipe));
    same(decoded, wardrobe.normalize(recipe), 'decode(encode(recipe)) equals the normalised recipe');
    same(wardrobe.describe(wardrobe.resolve(decoded)), wardrobe.describe(wardrobe.resolve(recipe)), 'every field equal');
    assert.strictEqual(wardrobe.hash(wardrobe.resolve(decoded)), wardrobe.hash(wardrobe.resolve(recipe)), 'same look');
    const described = wardrobe.describe(wardrobe.resolve(decoded));
    same(
      [described.fills.handRight, described.fills['handRight/flame'], described.dials['eyeSize@right']],
      ['lantern', 'glowstone', described.dials['eyeSize@left']],
      'mirror copied the lantern, its flame and the eye'
    );
    assert.ok(wardrobe.encode(recipe).length < 200, `a heavily edited character is still small: ${wardrobe.encode(recipe).length} bytes`);
  });

  test('debug: drawSurface outlines dialled shapes, tints region spans and marks features (control: an undressed bake has fewer spans)', () => {
    const calls = {};
    const recorder = Object.fromEntries(body.debug.CONTEXT_METHODS.map((method) => [method, () => (calls[method] = (calls[method] || 0) + 1)]));
    const bakery = wardrobe.bakery();
    const view = { centerX: 100, groundY: 300, scale: 100 };
    const drawn = (overrides) => {
      const bake = bakery.bakeRecipe({ species: 'person', seed: 4, overrides });
      const world = body.worldTransforms(bake.plan, bake.rest, body.createPose(bake.plan));
      return { bake, counts: body.debug.drawSurface(recorder, bake, world, view) };
    };
    const dressed = drawn({ 'fill:top': 'longSleeve', 'fill:bottom': 'trousers', 'fill:hair': 'hairCrop' });
    const drawable = dressed.bake.shapes.filter((shape) => !shape || shape.kind !== 'none').length;
    same(dressed.counts.outlines, drawable, 'one outline per drawable bone');
    same(dressed.counts.marks, dressed.bake.surface.features.length, 'one mark per placed feature');
    assert.ok(dressed.counts.spans > 40, `tinted spans along the clothed bones (${dressed.counts.spans})`);
    const bare = drawn({
      'fill:top': 'cropTop',
      'fill:bottom': 'shorts',
      'fill:hair': null,
      'fill:outerwear': null,
      'fill:footwear': null,
      'fill:gloves': null,
      'fill:hat': null,
      'fill:marks': null,
      'fill:facialHair': null,
    });
    assert.ok(bare.counts.spans < dressed.counts.spans, 'control: less clothing, fewer spans');
  });

  // ---- the figure renderer's extension points, and the two renderer edits they needed ----
  test('figure hooks: solids become pieces, every stamp layer of a bone one polygon of a single stamps piece; regionOf paints by bone-local point', () => {
    const bakery = wardrobe.bakery();
    const bake = bakery.bakeRecipe({ species: 'person', seed: 4, overrides: { 'fill:top': 'longSleeve', 'fill:eyes': 'eyesRound', 'fill:hat': null, 'fill:glasses': null } });
    const hooks = body.figureHooks(bake);
    const head = bake.plan.boneIndex('head');
    const pieces = hooks.featuresOf(bake.plan, head);
    const onHead = bake.surface.features.filter((feature) => feature.bone === head);
    const solids = onHead.filter((feature) => feature.shape).length;
    const layerCount = onHead.reduce((sum, feature) => sum + (feature.frames[feature.rest] || []).filter((layer) => layer.ramp >= 0).length, 0);
    same(pieces.length, solids + 1, 'one piece per solid, and one for all the stamps');
    const stamps = pieces.find((piece) => piece.stamps);
    same(stamps.shape.layers.length, layerCount, 'every layer of every rest frame is a polygon of it');
    assert.ok(stamps.glow, 'stamps are never outlined');
    const frame = body.surfaceLayout(bake.plan).frames[head];
    const farthest = Math.max(
      ...stamps.shape.layers.flatMap((layer) => Array.from({ length: layer.points.length / 3 }, (_unused, vertex) => Math.abs(Kit.surface.distance(bake.shapes[head], frame, ...layer.points.slice(vertex * 3, vertex * 3 + 3)))))
    );
    assert.ok(farthest < 0.012, `every stamp vertex hugs the head surface (farthest ${farthest})`);
    const sclera = wardrobe.species('person').colorIds.indexOf('sclera');
    assert.ok(stamps.shape.layers.some((layer) => layer.slot === sclera && layer.tone === 1), 'an eye white keeps its channel and its lightest shade');
    assert.ok(pieces.filter((piece) => !piece.stamps).every((piece) => Math.abs(Kit.surface.distance(bake.shapes[head], frame, ...piece.shape.at)) < 0.06), 'every solid sits at the head surface');
    same(hooks.featuresOf(bake.plan, bake.plan.boneIndex('chest')), [], 'nothing on a bone without features');
    const layout = Kit.figure.layout(bake, { featuresOf: hooks.featuresOf });
    assert.ok(layout.pieces.filter((piece) => piece.id.startsWith('head#')).length === pieces.length, 'the renderer takes them as head pieces');
    const chest = bake.plan.boneIndex('chest');
    const top = wardrobe.species('person').colorIds.indexOf('top');
    same(hooks.regionOf(bake.plan, chest, 0, 0.08, 0.09), top, 'the shirt paints the chest front');
    const bare = bakery.bakeRecipe({ species: 'person', seed: 4, overrides: { 'fill:top': 'cropTop', 'fill:outerwear': null } });
    same(body.figureHooks(bare).regionOf(bare.plan, bare.plan.boneIndex('waist'), 0, 0.05, 0.08), null, 'control: a crop top leaves the waist to the skin (null)');
    same(hooks.regionOf(bare.plan, chest, 0, 0.08, 0.09), null, "another bake's plan gets no answer");
  });
  test("figure renderer: it draws a bake's dialled shapes and honours scale (controls: an undialled bone keeps its key; no scale, no stretch)", () => {
    const bakery = wardrobe.bakery();
    const base = { species: 'person', seed: 4, overrides: { 'dial:jaw': 1, 'dial:legLength': 1 } };
    const keyOf = (bake, name) => Kit.figure.layout(bake).pieces.find((piece) => piece.id === name).key;
    const plain = bakery.bakeRecipe(base);
    const wideJaw = bakery.bakeRecipe({ ...base, overrides: { ...base.overrides, 'dial:jaw': 1.25 } });
    assert.notStrictEqual(keyOf(wideJaw, 'head'), keyOf(plain, 'head'), 'the jaw dial reaches the drawn head');
    same(keyOf(wideJaw, 'chest'), keyOf(plain, 'chest'), 'control: the chest is the same piece');
    const sphere = { kind: 'sphere', radius: 0.1, at: [0, 0, 0] };
    const widest = (shape) => Math.max(...Kit.figure.buildShape(shape, 'low').positions.filter((_value, index) => index % 3 === 0));
    close(widest({ ...sphere, scale: [0.5, 1, 1] }), widest(sphere) / 2, 1e-6, 'scale stretches the built surface');
    const normals = Kit.figure.buildShape({ ...sphere, scale: [0.5, 1, 2] }, 'low').normals;
    for (let index = 0; index < normals.length; index += 3) close(Math.hypot(normals[index], normals[index + 1], normals[index + 2]), 1, 1e-5, 'normals stay unit');
  });
  test('region maps: a region reaches its ramp slot per texel; a pattern keeps the line class beneath; a raised region gets a shell (controls: outside stays the bone own)', () => {
    const lower = Kit.region.compile({ band: { s: [0, 0.5] } });
    const stripe = Kit.region.compile({ band: { s: [0.1, 0.2] } });
    const map = Kit.region.bake([
      { test: lower, slot: 6, raise: 0.01, occludes: true },
      { test: stripe, slot: 9, ink: false },
    ]);
    same([map.width, map.height, map.data.length], [Kit.region.MAP_SIZE.width, Kit.region.MAP_SIZE.height, Kit.region.MAP_SIZE.width * Kit.region.MAP_SIZE.height * 4]);
    same(map.shells, [0.01], 'one distinct raise, one shell');
    const inLower = Kit.region.sample(map, 0.3, 0);
    same([inLower.slot, inLower.inkSlot, inLower.shell, inLower.occludes], [6, 6, 1, true], 'the region paints its slot, draws lines as itself, on shell 1, and hides what is under it');
    const inStripe = Kit.region.sample(map, 0.15, 1);
    same([inStripe.slot, inStripe.inkSlot], [9, 6], 'a pattern changes the colour and keeps the line class of the garment it is printed on');
    const outside = Kit.region.sample(map, 0.8, 0);
    same([outside.slot, outside.shell, outside.occludes], [Kit.region.NONE, 0, false], 'control: above the region the bone keeps its own ramp, flush and uncovered');
    same(Kit.region.bake([]).shells, [], 'control: no layers, no shells');
  });
  test('surface features: a body dial reuses the placed face, a face dial places it again, and the renderer keeps its pieces to match', () => {
    const bakery = wardrobe.bakery();
    const editor = body.editor(wardrobe);
    const person = body.wardrobe.DEFAULT_PERSON;
    const plain = bakery.bakeRecipe(person);
    const taller = bakery.bakeRecipe(editor.setDial(person, 'height', editor.schema(person).dials.find((dial) => dial.id === 'height').max));
    const jawed = bakery.bakeRecipe(editor.setDial(person, 'jaw', editor.schema(person).dials.find((dial) => dial.id === 'jaw').max));
    assert.notStrictEqual(taller, plain, 'control: the height dial made another bake');
    assert.strictEqual(taller.surface.features, plain.surface.features, 'a height change reuses the placed features');
    assert.notStrictEqual(jawed.surface.features, plain.surface.features, 'a jaw change places them again');
    const head = plain.plan.boneIndex('head');
    const hooks = body.FIGURE_HOOKS;
    assert.strictEqual(hooks.featuresOf(taller.plan, head, taller.shapes[head], taller), hooks.featuresOf(plain.plan, head, plain.shapes[head], plain), 'and the renderer gets the same pieces back');
    assert.notStrictEqual(hooks.featuresOf(jawed.plan, head, jawed.shapes[head], jawed), hooks.featuresOf(plain.plan, head, plain.shapes[head], plain), 'control: new pieces for the new jaw');
    assert.strictEqual(hooks.regionMapOf(taller.plan, head, taller).data, hooks.regionMapOf(plain.plan, head, plain).data, 'region maps depend on the outfit, not on dials: one baked map');
    const capped = bakery.bakeRecipe(editor.setSocket(person, 'hair', 'hairBuzz'));
    assert.notStrictEqual(hooks.regionMapOf(capped.plan, head, capped).data, hooks.regionMapOf(plain.plan, head, plain).data, 'control: another haircut, another map');
  });
  test('bakery: outfits that differ only in a surface part share a skeleton (control: a hat brings bones and a new one)', () => {
    const bakery = wardrobe.bakery();
    const editor = body.editor(wardrobe);
    const person = body.wardrobe.DEFAULT_PERSON;
    const first = bakery.bakeRecipe(person);
    const otherEyes = bakery.bakeRecipe(editor.setSocket(person, 'eyes', 'eyesAlmond'));
    same([bakery.stats().outfits, bakery.skeletons()], [2, 1], 'two outfits, one skeleton');
    assert.notStrictEqual(otherEyes.plan, first.plan, 'the plans differ');
    assert.strictEqual(otherEyes.plan.bonePaint, first.plan.bonePaint, 'and share their compiled bones');
    assert.strictEqual(otherEyes.plan.filled.eyes, 'eyesAlmond');
    const whole = body.assemble(wardrobe.species('person').plan, otherEyes.individual.fills, wardrobe.parts);
    same(otherEyes.plan.id, whole.id, 'the shared plan has the id a full assemble gives');
    same(otherEyes.plan.filled, whole.filled);
    same((otherEyes.plan.spec.features || []).map((feature) => feature.id).sort(), (whole.spec.features || []).map((feature) => feature.id).sort(), 'and the same features');
    same((otherEyes.plan.spec.regions || []).map((region) => region.id).sort(), (whole.spec.regions || []).map((region) => region.id).sort(), 'and regions');
    bakery.bakeRecipe(editor.setSocket(person, 'hat', 'beanie'));
    same([bakery.stats().outfits, bakery.skeletons()], [3, 2], 'control: a hat is bones');
  });
  test('figure shapes: smooth profiles pass through their points, stamps carry paint rules and order, a falling lathe faces out', () => {
    const profile = [
      [0.05, 0],
      [0.1, 0.1],
      [0.04, 0.2],
    ];
    const smooth = Kit.figure.smoothProfile(profile, 4);
    assert.ok(smooth.length > profile.length, 'more points');
    profile.forEach((point) => assert.ok(smooth.some((made) => Math.hypot(made[0] - point[0], made[1] - point[1]) < 1e-9), `the curve passes through ${point}`));
    same(Kit.figure.smoothProfile(profile, 1), profile, 'control: one step leaves the profile alone');
    const square = [-0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, 0.01, 0, -0.01, 0.01, 0];
    const layer = (extra) => ({ points: square, normal: [0, 0, 1], slot: 3, tone: 0.5, ...extra });
    const stamps = Kit.figure.buildShape({ kind: 'stamps', at: [0, 0, 0], layers: [layer({ least: 2 }), layer({ drop: 3 }), layer({})] }, 'high');
    same(stamps.paint.length, (stamps.positions.length / 3) * 4, 'four paint floats per vertex');
    same([0, 4, 8].map((vertex) => [stamps.paint[vertex * 4 + 2], stamps.paint[vertex * 4 + 3]]), [[2, 0], [-3, 1], [0, 2]], 'least is positive, drop negative, none zero; layers are numbered in order');
    close(stamps.centres[3], 0.01, 1e-6, 'the half extent of the smaller side');
    const outward = (lathe) => {
      const built = Kit.figure.buildShape(lathe, 'low');
      let agree = 0;
      for (let index = 0; index < built.indices.length; index += 3) {
        const [a, b, c] = [0, 1, 2].map((corner) => built.indices[index + corner] * 3);
        const edge = (from, to) => [0, 1, 2].map((axis) => built.positions[to + axis] - built.positions[from + axis]);
        const [u, v] = [edge(a, b), edge(a, c)];
        const face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        agree += Math.sign(face[0] * built.normals[a] + face[1] * built.normals[a + 1] + face[2] * built.normals[a + 2]);
      }
      return agree;
    };
    const skirtUp = { kind: 'lathe', profile: [[0.1, 0], [0.06, 0.2]], at: [0, 0, 0], axis: 1 };
    const skirtDown = { kind: 'lathe', profile: [[0.06, 0], [0.1, -0.2]], at: [0, 0, 0], axis: 1 };
    assert.ok(outward(skirtUp) > 0, 'control: a rising profile winds outward');
    assert.ok(outward(skirtDown) > 0, 'a falling profile winds outward too');
  });
  test('palette atlas: a freed block is used again (control: without free the next load takes new rows)', () => {
    const atlas = Kit.palette.atlas({ rows: 64 });
    const first = atlas.load(Kit.palette.SETS.ember);
    const second = atlas.load(Kit.palette.SETS.tide);
    assert.notStrictEqual(second.offset, first.offset, 'control: two loads, two blocks');
    atlas.free(first);
    same(atlas.load(Kit.palette.SETS.tide).offset, first.offset, 'the freed rows are taken by the next load of that size');
  });
};
