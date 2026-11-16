/**
 * Unit tests for faces and hair as data: relief (kit/sculpt-relief.js), named anchors, lean and carve on features
 * (kit/body-surface.js), the face and hair vocabularies (kit/body-face.js, kit/body-hair.js), the dials that
 * move them in the catalogues, a plan that extends another (kit/body-recipe.js), swept bounds
 * (kit/figure-layout.js) and narrowing a proof sheet (kit/body-proof.js). Loaded by tools/test-kit.js after
 * tools/test-sculpt.js, which has already put the kernel and the body system in the sandbox.
 *
 * Owns:  the cases, each beside a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), or how a face looks (the coverage sheets of
 *        tools/dev.js proof show that).
 */
'use strict';

const VECTOR = 3;
const RADIUS = 0.1;
/** Sockets of the wardrobe that a face or a head of hair is chosen in. */
const FACE_SOCKETS = ['eyes', 'brows', 'nose', 'mouth', 'ears', 'hair', 'facialHair'];

module.exports = ({ Kit, sandbox, test, assert }) => {
  const { sculpt, figure } = Kit;
  const { face } = Kit.body;
  /** Values made in the sandbox compared as plain values (another realm's arrays are not deep-equal to ours). */
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const ball = (radius, at) => sculpt.solid({ kind: 'sphere', radius, at: [0, 0, 0] }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1], { owner: 0 });
  const skull = () => ball(RADIUS, [0, 0, 0]);
  /** A small ball half sunk in the skull's front: a nose. */
  const bump = () => ball(0.02, [0, 0, RADIUS]);

  test('relief: a mark pressed on raises the surface there and nowhere else; the whole is one solid with the bounds of both', () => {
    const head = sculpt.relief(skull(), [{ solid: bump(), blend: 0.01 }]);
    assert.ok(head.distance(0, 0, RADIUS + 0.015) < 0, 'the tip of the nose is inside the head');
    assert.ok(skull().distance(0, 0, RADIUS + 0.015) > 0, 'the control: it is outside the bare skull');
    assert.strictEqual(head.distance(0, 0, -RADIUS - 0.03), skull().distance(0, 0, -RADIUS - 0.03), 'the back of the head is untouched');
    assert.ok(head.max[2] > skull().max[2] && head.min[2] === skull().min[2], 'the bounds grow to hold the mark, on its side only');
    assert.strictEqual(head.owner, 0, 'what the base carries is kept');
    assert.ok(head.plain(0, 0, RADIUS + 0.015) > 0.01, '`plain` still measures the bare base, so cloth can tell how proud a mark stands');
    const bare = skull();
    assert.strictEqual(sculpt.relief(bare, []), bare, 'no marks: the base itself');
    assert.throws(() => sculpt.relief(skull(), [{ blend: 0.01 }]), /mark 0 needs a `solid`/);
  });

  test('relief: a mark pressed in takes its shape out of the base, rounds the rim, and leaves the bounds alone', () => {
    const socket = ball(0.03, [0, 0, RADIUS + 0.01]);
    const head = sculpt.relief(skull(), [{ solid: socket, blend: 0.008, carve: true }]);
    assert.ok(head.distance(0, 0, RADIUS - 0.01) > 0, 'a point just under the skull is outside the dented head');
    assert.ok(skull().distance(0, 0, RADIUS - 0.01) < 0, 'the control: it is inside the bare skull');
    assert.deepStrictEqual([plain(head.min), plain(head.max)], [plain(skull().min), plain(skull().max)], 'a dent never widens the bounds');
    assert.ok(Math.abs(sculpt.smoothMax(-0.01, -0.01, 0.04)) < 1e-12, 'the rim of a dent is rounded off by a quarter of the fillet');
    assert.strictEqual(sculpt.smoothMax(0.3, -0.2, 0), 0.3, 'no fillet: a plain maximum');
  });

  test('relief: skipping the marks out of reach never changes the answer', () => {
    const marks = [
      { solid: bump(), blend: 0.012 },
      { solid: ball(0.025, [0.06, 0.03, 0.07]), blend: 0.02 },
      { solid: ball(0.02, [0.03, 0.03, RADIUS]), blend: 0.01, carve: true },
    ];
    const head = sculpt.relief(skull(), marks);
    /** The same modelling with every mark measured at every point. */
    const slow = (x, y, z) =>
      marks.reduce((nearest, mark) => {
        const own = mark.solid.distance(x, y, z);
        return mark.carve ? sculpt.smoothMax(nearest, -own, mark.blend) : sculpt.smoothMin(nearest, own, mark.blend);
      }, skull().distance(x, y, z));
    let worst = 0;
    let compared = 0;
    for (let x = -0.16; x <= 0.16; x += 0.02)
      for (let y = -0.16; y <= 0.16; y += 0.02)
        for (let z = -0.16; z <= 0.16; z += 0.02) {
          // Where a surface could be drawn: near the zero of the field. Deep inside or far outside only the sign matters.
          const expected = slow(x, y, z);
          if (Math.abs(expected) > 0.02) {
            assert.strictEqual(Math.sign(head.distance(x, y, z)), Math.sign(expected), `the sign at ${[x, y, z]}`);
            continue;
          }
          worst = Math.max(worst, Math.abs(head.distance(x, y, z) - expected));
          compared++;
        }
    assert.ok(compared > 100, `the surface was sampled (${compared} points)`);
    assert.ok(worst < 1e-9, `the skipped marks would not have moved the surface (worst ${worst})`);
  });

  test('anchors: a feature on a named anchor sits there, steps away from it, and takes its spacing and bone unless it states its own', () => {
    const anchors = face.anchors('head', { nose: { elevation: -20 } });
    assert.deepStrictEqual(plain(Object.keys(anchors)).sort(), plain(face.ANCHOR_NAMES).sort(), 'every anchor a face is hung on is stated');
    assert.strictEqual(anchors.nose.elevation, -20, 'an override replaces the usual place');
    assert.strictEqual(anchors.nose.bone, 'head');
    const nose = Kit.body.anchoredSpec({ id: 'nose', anchor: 'nose', elevation: 2 }, anchors, 'test');
    assert.strictEqual(nose.elevation, -18, 'its own elevation is a step from the anchor');
    assert.strictEqual(nose.bone, 'head');
    const eye = Kit.body.anchoredSpec({ id: 'eye', anchor: 'eye' }, anchors, 'test');
    assert.strictEqual(eye.spacing, anchors.eye.spacing, 'a pair takes the anchor\'s spacing');
    assert.strictEqual(Kit.body.anchoredSpec({ id: 'eye', anchor: 'eye', spacing: 30 }, anchors, 'test').spacing, 30, 'unless it states its own');
    const free = { id: 'scar', azimuth: 10 };
    assert.strictEqual(Kit.body.anchoredSpec(free, anchors, 'test'), free, 'a feature without an anchor is left as it is');
    assert.throws(() => Kit.body.anchoredSpec({ id: 'horn', anchor: 'temple' }, anchors, 'test'), /temple/);
  });

  test('face vocabulary: every nose and ear style, and every other builder, makes features on anchors at any head size', () => {
    Object.keys(face.NOSES).forEach((style) => {
      const features = face.nose(style);
      assert.ok(features.length > 0 && features.every((feature) => feature.id === 'nose' && feature.anchor === 'nose' && feature.shape), `nose ${style}`);
    });
    Object.keys(face.EARS).forEach((style) => {
      const features = face.ears(style);
      assert.ok(features.every((feature) => feature.anchor === 'ear' && feature.shape && ['ear', 'earTip'].includes(feature.id)), `ears ${style}`);
      assert.strictEqual(features.some((feature) => feature.id === 'earTip'), Boolean(face.EARS[style].point), `ears ${style}: a point when the row has one`);
    });
    assert.throws(() => face.nose('beak'), /beak/);
    assert.throws(() => face.ears('fan'), /fan/);
    const [small] = face.nose('straight');
    const [large] = face.nose('straight', { scale: 2 });
    assert.ok(Math.abs(large.shape.radius - small.shape.radius * 2) < 1e-12, 'a scale of 2 doubles the solid');
    const others = { browRidge: face.browRidge(), cheeks: face.cheeks(), chin: face.chin(), lips: face.lips([0.04, 0.012]), eyeSockets: face.eyeSockets([0.03, 0.03]), dotEyes: face.dotEyes(0.02), lineMouth: face.lineMouth([0.04, 0.012]), nosePad: face.nosePad([0.04, 0.03]) };
    Object.keys(others).forEach((name) => assert.ok(others[name].length > 0 && others[name].every((feature) => face.ANCHOR_NAMES.includes(feature.anchor) && (feature.shape || feature.frames)), name));
    assert.ok(others.eyeSockets.every((feature) => feature.carve === true), 'a socket is pressed in');
    assert.ok(others.lips.every((feature) => !feature.carve), 'the control: lips are pressed on');
  });

  test('hair vocabulary: every primitive makes bones that sit on the head it was given', () => {
    const hair = Kit.body.hair.on();
    const made = {
      mass: hair.mass('crown', [0, 0.6, 0], [0.05, 0.03, 0.05]),
      lock: hair.lock('lock', [40, 0.5, 0], [60, -0.2, 0.01], 0.02),
      fringe: hair.fringe('fringe', { from: -50, to: 50, count: 5 }),
      parting: hair.parting('part', { side: 0.3 }),
      bun: hair.bun('bun', [180, 0.5, 0], 0.04),
      tail: hair.tail('tail', [180, 0.3, 0.02], [[0, -0.05, -0.03], [0, -0.08, 0]], [0.03, 0.02]),
      braid: hair.braid('braid', [120, -0.1, 0], [0, -0.04, 0], 4, 0.016),
      sideburns: hair.sideburns('burn'),
      fall: hair.fall('fall', { length: 0.3 }),
    };
    assert.deepStrictEqual(Object.keys(made).sort(), plain(Kit.body.hair.PRIMITIVES).sort(), 'every primitive of the vocabulary is covered here');
    Object.keys(made).forEach((name) => {
      const bones = made[name];
      assert.ok(bones.length > 0, name);
      bones.forEach((bone) => {
        assert.ok(typeof bone.name === 'string' && bone.shape && bone.at.every(Number.isFinite), `${name}: ${JSON.stringify(bone)}`);
      });
      assert.strictEqual(new Set(bones.map((bone) => bone.name)).size, bones.length, `${name}: bone names are distinct`);
    });
    assert.strictEqual(made.fringe.length, 5, 'a fringe of five locks');
    assert.strictEqual(made.braid.length, 4, 'a braid of four beads');
    assert.deepStrictEqual([made.fall[0].wear, plain(made.fall[0].hangs)], ['drape', ['head', 'neck', 'spine']], 'long hair hangs as a drape from the head down the upper spine');
    const [front, back] = [hair.at([0, 0, 0]), hair.at([180, 0, 0])];
    assert.ok(front[2] > 0 && back[2] < 0 && Math.abs(front[0]) < 1e-9, 'azimuth 0 is the front of the head, 180 the back');
    assert.ok(hair.at([0, 1, 0])[1] > hair.at([0, 0, 0])[1], 'a rise of 1 is the crown');
    const wide = Kit.body.hair.on({ halves: [0.2, 0.106, 0.097] });
    assert.ok(wide.at([90, 0, 0])[0] > hair.at([90, 0, 0])[0], 'the same place on a wider head lies further out');
  });

  const wardrobe = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const samples = Kit.body.catalog(Kit.body.samples.CATALOG);
  const editor = Kit.body.editor(wardrobe);
  const bakery = wardrobe.bakery({ capacity: 8 });
  const person = { species: 'person', seed: 1 };
  /** A recipe's placed features as plain rows, by id. */
  const featuresOf = (recipe) => plain(bakery.bakeRecipe(recipe).surface.features);

  test('face dials: each moves the features it names and no other', () => {
    const schema = editor.schema(person);
    const dials = ['noseLength', 'noseWidth', 'noseTip', 'earAngle', 'earFlare', 'earPoint', 'browDepth', 'cheekFullness', 'chinLength', 'lips'].map((id) => {
      const dial = schema.dials.find((control) => control.id === id);
      assert.ok(dial, `the wardrobe has a dial "${id}"; it has ${schema.dials.map((control) => control.id).join(', ')}`);
      return dial;
    });
    dials.forEach((dial) => {
      const moved = new Set(dial.affects.map((effect) => effect.feature));
      assert.ok(!moved.has(undefined), `${dial.id} addresses features only`);
      const [least, most] = [featuresOf(editor.setDial(person, dial.id, dial.min)), featuresOf(editor.setDial(person, dial.id, dial.max))];
      const present = least.filter((feature) => moved.has(feature.id));
      // An ear's point belongs to pointed ears: a dial that draws it out has nothing to move on a round ear.
      if (!present.length) return;
      least.forEach((feature, index) => {
        const isSame = JSON.stringify(feature) === JSON.stringify(most[index]);
        if (!moved.has(feature.id)) assert.ok(isSame, `${dial.id} leaves "${feature.id}" alone`);
      });
      assert.ok(least.some((feature, index) => moved.has(feature.id) && JSON.stringify(feature) !== JSON.stringify(most[index])), `${dial.id} moves ${[...moved].join(', ')}`);
    });
  });

  test('face dials: an ear flares out from the head, and its point is drawn out, by the dial that says so', () => {
    const pointed = editor.schema(person).sockets.find((socket) => socket.path === 'ears').choices.find((choice) => /point|long/i.test(choice.id || ''));
    assert.ok(pointed, 'the wardrobe offers a pointed ear');
    const elf = editor.setSocket(person, 'ears', pointed.id);
    /** How far the ears' solids reach from the middle of the head, and how high, in the head's own space. */
    const reach = (recipe) => {
      const bake = bakery.bakeRecipe(recipe);
      let [out, up] = [0, -Infinity];
      figure
        .layout(bake, { level: 'low' })
        .pieces.filter((piece) => piece.isFeature && !piece.stamps && !piece.carve && bake.plan.boneNames[piece.bone] === 'head')
        .forEach((piece) => {
          const { positions } = figure.buildShape(piece.shape, 'low');
          for (let offset = 0; offset < positions.length; offset += VECTOR) {
            out = Math.max(out, Math.abs(positions[offset]));
            up = Math.max(up, positions[offset + 1]);
          }
        });
      return { out, up };
    };
    const dial = (id) => editor.schema(elf).dials.find((control) => control.id === id);
    const [flat, flared] = [reach(editor.setDial(elf, 'earFlare', dial('earFlare').min)), reach(editor.setDial(elf, 'earFlare', dial('earFlare').max))];
    assert.ok(flared.out > flat.out + 0.005, `a flared ear stands further out (${flat.out} -> ${flared.out})`);
    const [short, long] = [reach(editor.setDial(elf, 'earPoint', dial('earPoint').min)), reach(editor.setDial(elf, 'earPoint', dial('earPoint').max))];
    assert.ok(long.up > short.up + 0.005 || long.out > short.out + 0.005, `a drawn-out point reaches further (${JSON.stringify(short)} -> ${JSON.stringify(long)})`);
  });

  test('catalogues: every choice of every face and hair socket lays out, and its relief is modelled out of the head', () => {
    const schema = editor.schema(person);
    const sockets = schema.sockets.filter((socket) => FACE_SOCKETS.includes(socket.path));
    assert.deepStrictEqual(plain(sockets.map((socket) => socket.path)).sort(), [...FACE_SOCKETS].sort(), 'the wardrobe has every face and hair socket');
    wardrobe.speciesIds().forEach((species) => {
      const subject = { species, seed: 1 };
      editor
        .schema(subject)
        .sockets.filter((socket) => FACE_SOCKETS.includes(socket.path))
        .forEach((socket) =>
          socket.choices.forEach((choice) => {
            const bake = bakery.bakeRecipe(editor.setSocket(subject, socket.path, choice.id));
            const layout = figure.layout(bake, { level: 'low' });
            layout.pieces.forEach((piece) => {
              if (!piece.shape.layers) assert.ok(figure.buildShape(piece.shape, 'low').positions.every(Number.isFinite), `${species} ${socket.path}: ${choice.id}, piece ${piece.id}`);
            });
          })
        );
    });
    // At full detail: a coarser grid cannot hold lips, and leaves what is too thin for it a rigid piece.
    const bake = bakery.bakeRecipe(person);
    const layout = figure.layout(bake, { level: 'high' });
    const sculpted = figure.sculptLayers(bake, layout);
    const marks = layout.pieces.filter((piece) => piece.isFeature && !piece.stamps && Kit.body.isReliefMark(piece, bake.boneRamp[piece.bone]));
    assert.ok(marks.length >= 8, `a person's face has relief marks (${marks.length})`);
    marks.forEach((mark) => assert.ok(sculpted.replaced.has(mark.id), `${mark.id} is part of the head's surface, not a piece of its own`));
    assert.ok(marks.some((mark) => mark.carve), 'eye sockets are pressed in');
    assert.strictEqual(Kit.body.isReliefMark({ ramp: bake.boneRamp[0] + 1 }, bake.boneRamp[0]), false, 'the control: a solid of another paint (a moustache) is no mark');
  });

  test('catalogues: a plan that extends another keeps its skeleton and adds its face; a bad `extends` is refused by name', () => {
    const raw = Kit.body.samples.CATALOG;
    ['biped', 'quadruped', 'fish'].forEach((id) => {
      const [bare, faced] = [samples.plans[id], samples.plans[`${id}Faced`]];
      assert.deepStrictEqual(plain(faced.boneNames), plain(bare.boneNames), `${id}: the same bones`);
      assert.ok(raw.plans[`${id}Faced`].features.length > 0 && !raw.plans[id].features, `${id}: the face is stated once, on the plan that extends`);
    });
    samples.speciesIds().forEach((species) => {
      const features = plain(samples.bakery({ capacity: 2 }).bakeRecipe({ species, seed: 1 }).surface.features);
      assert.ok(features.some((feature) => feature.id === 'eye'), `${species} has eyes`);
    });
    const withPlans = (plans) => () => Kit.body.catalog({ ...raw, plans: { ...raw.plans, ...plans } });
    assert.throws(withPlans({ ghost: { extends: 'spectre' } }), /"ghost" extends "spectre", which is not a plan/);
    assert.throws(withPlans({ twice: { extends: 'bipedFaced' } }), /itself extends "biped"/);
  });

  test('swept bounds: what a figure sweeps when it turns, and the ball of some of its pieces', () => {
    const bake = samples.bakery({ capacity: 2 }).bakeRecipe({ species: 'hound', seed: 1 });
    const layout = figure.layout(bake, { level: 'low' });
    const world = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
    const positions = (piece) => figure.buildShape(piece.shape, 'low').positions;
    const isSkull = (piece) => !piece.isFeature && bake.plan.boneNames[piece.bone] === 'head';
    const [all, head] = [figure.measureSwept(layout, world, positions), figure.measureSwept(layout, world, positions, isSkull)];
    // The same measures the slow way, for the skull alone.
    const matrix = new Float32Array(16);
    const skull = layout.pieces.find(isSkull);
    figure.writeBoneMatrix(world, skull.bone, matrix);
    const points = [];
    const local = positions(skull);
    for (let offset = 0; offset < local.length; offset += VECTOR) {
      const [x, y, z] = [local[offset], local[offset + 1], local[offset + 2]];
      points.push([matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]]);
    }
    const sweep = Math.max(...points.map(([x, _y, z]) => Math.hypot(x, z)));
    assert.ok(Math.abs(head.sweep - sweep) < 1e-9, `the sweep is the furthest point from the axis the figure turns about (${head.sweep}, ${sweep})`);
    assert.ok(Math.abs(head.highestY - Math.max(...points.map((point) => point[1]))) < 1e-9);
    assert.ok(points.every((point) => Math.hypot(point[0] - head.center[0], point[1] - head.center[1], point[2] - head.center[2]) <= head.radius + 1e-9), 'the ball holds every point');
    assert.ok(head.center[2] > all.center[2] + 0.2, 'a hound carries its head in front of its middle');
    assert.ok(head.radius < all.radius / 2 && all.sweep >= head.sweep, 'the control: the whole hound is far larger than its head');
    assert.strictEqual(
      figure.measureSwept(layout, world, positions, () => false),
      null,
      'nothing included: nothing measured'
    );
  });

  test('proof: a sheet can be narrowed to the sockets or dials under review', () => {
    const { proof } = Kit.body;
    const all = proof.suite('options', wardrobe, { species: ['person'] }).cells;
    const hair = proof.suite('options', wardrobe, { species: ['person'], only: ['hair'] }).cells;
    assert.ok(hair.length > 0 && hair.length < all.length, `only the hair (${hair.length} of ${all.length} cells)`);
    assert.ok(hair.every((cell) => cell.label.startsWith('person hair:')));
    const dials = proof.suite('extremes', wardrobe, { species: ['person'], only: ['noseTip', 'earFlare'] }).cells;
    assert.deepStrictEqual(plain(dials.map((cell) => cell.label)), ['person noseTip least', 'person noseTip most', 'person earFlare least', 'person earFlare most']);
  });

  void sandbox;
};
