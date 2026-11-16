/**
 * Unit tests for the pure half of Kit.figure: shape builders and keys (kit/figure-shapes.js) and the layout,
 * ink groups, update planning, grounding and framing (kit/figure-layout.js). Loaded by tools/test-kit.js after
 * tools/test-body.js, which has already put the body system and the palette in the sandbox.
 *
 * Owns:  the cases, each beside a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), or the THREE half (kit/figure.js, exercised by
 *        the `figures` screen's probe in the browser).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['figure-shapes', 'figure-layout'];

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const figure = Kit.figure;
  const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
  const bakery = catalog.bakery();
  const editor = Kit.body.editor(catalog);
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const HUMAN = { species: 'human', seed: 11, overrides: { 'fill:handRight': 'sword', 'fill:headTop': null } };
  const SHAPES = {
    capsule: { kind: 'capsule', end: [0.1, -0.3, 0.05], radius: 0.04, endRadius: 0.03, at: [0, 0, 0] },
    sphere: { kind: 'sphere', radius: 0.12, at: [0, 0.11, 0] },
    box: { kind: 'box', size: [0.09, 0.06, 0.22], at: [0, 0, 0.07] },
    lathe: { kind: 'lathe', profile: Kit.body.samples.PARTS.hat.bones[1].shape.profile.map((point) => point.slice()), axis: 1, at: [0, 0, 0] },
    extrude: {
      kind: 'extrude',
      outline: Kit.body.samples.PLANS.fish.bones.find((bone) => bone.name === 'tailFin').shape.outline.map((point) => point.slice()),
      depth: 0.01,
      axis: 2,
      across: 1,
      at: [0, 0, 0],
    },
  };

  /** For every triangle with area: does its winding agree with the vertex normals (counter-clockwise from outside)? */
  const windingAgreement = ({ positions, normals, indices }) => {
    let agree = 0;
    let disagree = 0;
    for (let corner = 0; corner < indices.length; corner += 3) {
      const [a, b, c] = [indices[corner], indices[corner + 1], indices[corner + 2]].map((index) => index * 3);
      const edge1 = [0, 1, 2].map((axis) => positions[b + axis] - positions[a + axis]);
      const edge2 = [0, 1, 2].map((axis) => positions[c + axis] - positions[a + axis]);
      const face = [edge1[1] * edge2[2] - edge1[2] * edge2[1], edge1[2] * edge2[0] - edge1[0] * edge2[2], edge1[0] * edge2[1] - edge1[1] * edge2[0]];
      if (Math.hypot(...face) < 1e-12) continue;
      const vertexNormal = [0, 1, 2].map((axis) => normals[a + axis] + normals[b + axis] + normals[c + axis]);
      if (face[0] * vertexNormal[0] + face[1] * vertexNormal[1] + face[2] * vertexNormal[2] > 0) agree += 1;
      else disagree += 1;
    }
    return { agree, disagree };
  };

  test('figure shapes: every builder gives unit outward normals, indices in range, and outward winding at every level', () => {
    Object.entries(SHAPES).forEach(([kind, shape]) =>
      Object.keys(figure.LEVELS).forEach((level) => {
        const arrays = figure.buildShape(shape, level);
        const vertexCount = arrays.positions.length / 3;
        assert.strictEqual(arrays.normals.length, arrays.positions.length, `${kind} ${level}: a normal per vertex`);
        for (let offset = 0; offset < arrays.normals.length; offset += 3)
          close(Math.hypot(arrays.normals[offset], arrays.normals[offset + 1], arrays.normals[offset + 2]), 1, 1e-5, `${kind} ${level} normal length`);
        assert.ok(
          Array.from(arrays.indices).every((index) => index < vertexCount),
          `${kind} ${level}: indices in range`
        );
        const { agree, disagree } = windingAgreement(arrays);
        assert.strictEqual(disagree, 0, `${kind} ${level}: ${disagree} of ${agree + disagree} triangles wind inwards`);
      })
    );
    // Control: the same check catches a mesh turned inside out.
    const inverted = figure.buildShape(SHAPES.sphere, 'low');
    const flipped = { ...inverted, indices: inverted.indices.map((_index, corner) => inverted.indices[corner - (corner % 3) + [0, 2, 1][corner % 3]]) };
    assert.strictEqual(windingAgreement(flipped).agree, 0, 'a flipped sphere disagrees everywhere');
  });

  test('figure shapes: round shapes get fewer segments at lower levels and on smaller radii; a box does not change', () => {
    const vertices = (shape, level) => figure.buildShape(shape, level).positions.length / 3;
    ['capsule', 'sphere', 'lathe'].forEach((kind) => {
      assert.ok(vertices(SHAPES[kind], 'high') > vertices(SHAPES[kind], 'medium'), `${kind}: high > medium`);
      assert.ok(vertices(SHAPES[kind], 'medium') > vertices(SHAPES[kind], 'low'), `${kind}: medium > low`);
    });
    assert.strictEqual(vertices(SHAPES.box, 'high'), vertices(SHAPES.box, 'low'), 'a box is a box');
    assert.ok(figure.segmentsFor('high', 0.12).around > figure.segmentsFor('high', 0.02).around, 'a head is rounder than a finger');
    assert.strictEqual(figure.segmentsFor('high', 5).around, figure.LEVELS.high.maxAround, 'capped');
    assert.throws(() => figure.segmentsFor('ultra', 0.1), /no level "ultra"/);
  });

  test('figure shapes: a capsule runs from a cap below the joint to a cap past its end, whatever its direction', () => {
    const { positions } = figure.buildShape(SHAPES.capsule, 'high');
    const { end, radius, endRadius } = SHAPES.capsule;
    const length = Math.hypot(...end);
    const along = end.map((value) => value / length);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const projection = positions[offset] * along[0] + positions[offset + 1] * along[1] + positions[offset + 2] * along[2];
      lowest = Math.min(lowest, projection);
      highest = Math.max(highest, projection);
    }
    close(lowest, -radius, 1e-5, 'round cap behind the joint');
    close(highest, length + endRadius, 1e-5, 'round cap past the end');
  });

  test('figure shapes: ear clipping covers a concave outline exactly and refuses one that crosses itself', () => {
    const outline = SHAPES.extrude.outline;
    const triangles = figure.triangulate(outline);
    const areaOf = (points) => Math.abs(points.reduce((sum, [x, y], index) => sum + x * points[(index + 1) % points.length][1] - points[(index + 1) % points.length][0] * y, 0)) / 2;
    let covered = 0;
    for (let corner = 0; corner < triangles.length; corner += 3) covered += areaOf([outline[triangles[corner]], outline[triangles[corner + 1]], outline[triangles[corner + 2]]]);
    close(covered, areaOf(outline), 1e-9, 'the notched fin is covered, the notch is not');
    // Control: a fan from the second point (fine for a convex outline) also covers the notch, and the sum shows it.
    const fanArea = areaOf([outline[1], outline[2], outline[3]]) + areaOf([outline[1], outline[3], outline[0]]);
    assert.ok(fanArea > areaOf(outline) + 1e-6, 'the area check can tell a wrong triangulation');
    assert.throws(
      () =>
        figure.triangulate([
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ]),
      /crosses itself/
    );
  });

  test('figure shapes: keys are equal exactly when surfaces are, so identical shapes share one geometry', () => {
    const keysOf = (recipe) => new Map(figure.layout(bakery.bakeRecipe(recipe)).pieces.map((piece) => [piece.id, piece.key]));
    const first = keysOf({ species: 'human', seed: 1 });
    const second = keysOf({ species: 'human', seed: 2, overrides: { 'dial:legLength': 1.2 } });
    assert.strictEqual(first.get('forearmLeft'), second.get('forearmLeft'), 'dials stretch through the bone, not the geometry');
    assert.strictEqual(first.get('thighLeft'), first.get('thighRight'), 'mirrored limbs share a surface');
    const sphere = SHAPES.sphere;
    assert.strictEqual(figure.shapeKey(sphere), figure.shapeKey({ ...sphere, radius: sphere.radius + 1e-7 }), 'float noise does not split the cache');
    assert.notStrictEqual(figure.shapeKey(sphere), figure.shapeKey({ ...sphere, radius: 0.13 }), 'a bigger head is another surface');
    assert.notStrictEqual(figure.shapeKey(sphere, 'high'), figure.shapeKey(sphere, 'low'), 'and so is another level');
  });

  test('figure shapes: writeBoneMatrix writes rotation, three-axis scale and translation column by column', () => {
    const half = Math.SQRT1_2;
    const world = { translation: new Float32Array([1, 2, 3]), rotation: new Float32Array([0, 0, half, half]), scale: new Float32Array([2, 1, 1]) };
    const matrix = figure.writeBoneMatrix(world, 0, new Array(16).fill(NaN));
    // A quarter turn about +Z carries +X to +Y; the bone's own X is stretched twice first.
    const apply = (x, y, z) => [0, 1, 2].map((row) => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
    apply(1, 0, 0).forEach((value, axis) => close(value, [1, 4, 3][axis], 1e-6, `x axis ${axis}`));
    apply(0, 1, 0).forEach((value, axis) => close(value, [0, 2, 3][axis], 1e-6, `y axis ${axis}`));
    assert.deepStrictEqual([matrix[3], matrix[7], matrix[11], matrix[15]], [0, 0, 0, 1]);
  });

  test('figure layout: unpainted bones take their painted ancestor`s ramp; a part`s mount draws nothing', () => {
    const hound = bakery.bakeRecipe({ species: 'hound', seed: 3 });
    const legBone = hound.plan.boneIndex('frontLeftLower');
    assert.strictEqual(hound.boneRamp[legBone], -1, 'the sample data leaves the leg unpainted');
    const resolved = figure.resolveRamps(hound.plan, hound.boneRamp);
    assert.strictEqual(resolved[legBone], resolved[hound.plan.boneIndex('hips')], 'so it takes the body`s colour');
    assert.ok(Array.from(resolved).every((ramp) => ramp >= 0));
    const armed = bakery.bakeRecipe({ species: 'human', seed: 11, overrides: { 'fill:handRight': 'sword', 'fill:handRight/gem': 'ruby' } });
    const pieces = figure.layout(armed).pieces;
    const rampOf = (id) => pieces.find((piece) => piece.id === id).ramp;
    assert.strictEqual(rampOf('handRight/gem/stone'), rampOf('handRight/blade'), 'the ruby takes the sword`s metal');
    assert.notStrictEqual(rampOf('handRight/blade'), rampOf('handRight'), 'control: painted bones keep their own');
    assert.ok(pieces.find((piece) => piece.id === 'handRight/blade').shiny, 'metal is shiny');
    assert.ok(!pieces.some((piece) => piece.id.endsWith('@mount')), 'mounts are not drawn');
    assert.ok(!pieces.find((piece) => piece.id === 'chest').shiny, 'cloth is not');
  });

  test('figure layout: a hub bone draws a link to every continuing child, so no stretch of a body is left bare', () => {
    const carp = figure.layout(bakery.bakeRecipe({ species: 'carp', seed: 8 }));
    const link = carp.pieces.find((piece) => piece.id === 'trunk>rear');
    assert.ok(link, 'the trunk reaches its rear as well as its head');
    assert.deepStrictEqual(
      Array.from(link.shape.end).map((value) => Number(value.toFixed(3))),
      [0, 0, -0.24],
      'ending at the rear joint'
    );
    assert.ok(link.shape.endRadius < link.shape.radius, 'narrowing into the rear (same region)');
    const human = figure.layout(bakery.bakeRecipe({ species: 'human', seed: 4 }));
    const shoulder = human.pieces.find((piece) => piece.id === 'chest>upperArmLeft');
    assert.ok(shoulder && shoulder.shape.endRadius >= shoulder.shape.radius * 0.6 - 1e-9, 'a shoulder is part of the torso');
    assert.strictEqual(human.pieces.find((piece) => piece.id === 'chest').shape.endRadius, human.pieces.find((piece) => piece.id === 'chest').shape.radius, 'the chest keeps its width up to the neck');
    assert.ok(!human.pieces.some((piece) => piece.id.startsWith('handRight>')), 'control: a tailed bone draws only itself');
    assert.ok(!human.pieces.some((piece) => piece.id.includes('>headTop')), 'and a part is never a link');
  });

  test('figure layout: a limb`s segments share an ink group, sides and parts do not, and a part keeps its group', () => {
    // The sample human has a face now: its stamps (eyes, a mouth) are glows, which is what group 0 is for.
    const groupsOf = (recipe) =>
      new Map(
        figure
          .layout(bakery.bakeRecipe(recipe))
          .pieces.filter((piece) => !piece.stamps)
          .map((piece) => [piece.id, piece.inkGroup])
      );
    const bare = groupsOf({ species: 'human', seed: 4, overrides: { 'fill:headTop': 'hat', 'fill:handRight': null } });
    const armed = groupsOf({ species: 'human', seed: 4, overrides: { 'fill:headTop': 'hat', 'fill:handRight': 'sword' } });
    assert.strictEqual(bare.get('upperArmLeft'), bare.get('forearmLeft'));
    assert.strictEqual(bare.get('forearmLeft'), bare.get('handLeft'));
    assert.notStrictEqual(bare.get('handLeft'), bare.get('handRight'), 'left and right arms are outlined against each other');
    assert.notStrictEqual(bare.get('chest'), bare.get('upperArmLeft'), 'an arm in front of the chest is outlined');
    assert.strictEqual(bare.get('headTop/brim'), bare.get('headTop/crown'), 'one hat');
    assert.notStrictEqual(bare.get('headTop/brim'), bare.get('head'));
    assert.strictEqual(armed.get('headTop/brim'), bare.get('headTop/brim'), 'picking up a sword does not renumber the hat');
    assert.ok(
      [...armed.values()].every((group) => group >= 1 && group <= 255),
      'nothing but glows is in group 0'
    );
    const glowing = figure.layout(bakery.bakeRecipe({ species: 'human', seed: 4 }), {
      featuresOf: (plan, bone) =>
        plan.boneNames[bone] === 'head' ? [{ shape: { kind: 'sphere', radius: 0.02, at: [0.04, 0.12, 0.1] }, glow: true }, { shape: { kind: 'sphere', radius: 0.02, at: [0, 0.05, 0.11] } }] : [],
    });
    const [eye, nose] = ['head#0', 'head#1'].map((id) => glowing.pieces.find((piece) => piece.id === id));
    assert.strictEqual(eye.inkGroup, 0, 'a glowing feature is never outlined');
    assert.strictEqual(nose.inkGroup, groupsOf({ species: 'human', seed: 4 }).get('head'), 'a plain feature belongs to its bone`s region');
    assert.throws(() => figure.layout(bakery.bakeRecipe({ species: 'human', seed: 4 }), { regionOf: () => null }), /pass `regionMapOf`/, 'a point lookup is refused and the map hook named');
  });

  test('figure layout: planUpdate keeps everything for a dial or a colour, and adds or removes only a part`s pieces', () => {
    const shown = bakery.bakeRecipe(HUMAN);
    const shownLayout = figure.layout(shown);
    const known = new Set(shownLayout.pieces.map((piece) => piece.key));
    const step = (recipe) => {
      const next = bakery.bakeRecipe(recipe);
      const update = figure.planUpdate(shownLayout, figure.layout(next), editor.changes(shown, next));
      return { ...update, newGeometries: new Set(update.add.map((piece) => piece.key).filter((key) => !known.has(key))).size, added: update.add.map((piece) => piece.id).join() };
    };
    const dial = step(editor.setDial(HUMAN, 'legLength', 1.19));
    assert.deepStrictEqual([dial.add.length, dial.remove.length, dial.recolor, dial.remeasure, dial.newGeometries], [0, 0, false, true, 0], 'a dial drag moves bones only');
    const color = step(editor.setColor(HUMAN, 'cloth', (bakery.bakeRecipe(HUMAN).individual.colors[1] + 1) % 4));
    assert.deepStrictEqual([color.add.length, color.remove.length, color.recolor, color.remeasure], [0, 0, true, false], 'a colour change rewrites rows only');
    const hat = step(editor.setSocket(HUMAN, 'headTop', 'hat'));
    assert.deepStrictEqual([hat.added, hat.remove.length, hat.newGeometries, hat.recolor], ['headTop/brim,headTop/crown', 0, 2, false], 'a hat adds the hat');
    const unarmed = step(editor.setSocket(HUMAN, 'handRight', null));
    assert.deepStrictEqual([unarmed.add.length, unarmed.remove.map((piece) => piece.id).join()], [0, 'handRight/blade'], 'dropping the sword removes the sword');
    assert.ok(
      hat.keep.some(({ from, to }) => from.id === 'thighLeft' && from.bone !== to.bone),
      'control: kept pieces may move to other bone indices'
    );
    // Control: another species keeps almost nothing.
    const hound = step({ species: 'hound', seed: 3 });
    assert.ok(hound.add.length > 15 && hound.recolor, `a hound is mostly new (${hound.add.length} added)`);
  });

  test('figure layout: grounding leaves props out, and framing ignores a hat but follows the body', () => {
    const measure = (recipe) => {
      const bake = bakery.bakeRecipe(recipe);
      const pieceLayout = figure.layout(bake);
      const world = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
      return figure.measureRest(pieceLayout, world, (piece) => figure.buildShape(piece.shape, pieceLayout.level).positions);
    };
    const plain = measure({ species: 'human', seed: 6, overrides: { 'fill:headTop': null, 'fill:handRight': null } });
    const dressed = measure({ species: 'human', seed: 6, overrides: { 'fill:headTop': 'hat', 'fill:handRight': 'sword' } });
    assert.strictEqual(dressed.lowestY, plain.lowestY, 'the body stands where it stood');
    assert.strictEqual(dressed.highestY, plain.highestY, 'a hat does not make the body taller');
    assert.ok(Number.isFinite(dressed.lowestPropY) && plain.lowestPropY === Infinity, 'control: the props were measured, separately');
    assert.ok(plain.lowestY < 0, `the sample foot box reaches below its joint (${plain.lowestY.toFixed(3)})`);
    const longLegs = measure({ species: 'human', seed: 6, overrides: { 'fill:headTop': null, 'fill:handRight': null, 'dial:legLength': 1.2 } });
    assert.ok(longLegs.lowestY < plain.lowestY - 0.05, 'longer legs reach lower: the figure is lifted more');
    const aspect = 0.6;
    assert.deepStrictEqual(figure.fitView(dressed, aspect), figure.fitView(plain, aspect), 'a hat and a sword never rescale the view');
    const tall = measure({ species: 'human', seed: 6, overrides: { 'fill:headTop': null, 'fill:handRight': null, 'dial:height': 1.4 } });
    assert.ok(figure.fitView(tall, aspect).halfHeight > figure.fitView(plain, aspect).halfHeight, 'control: a taller body does');
    const window = figure.fitView(plain, aspect);
    assert.ok(window.centerY - window.halfHeight < plain.lowestY && window.centerY + window.halfHeight > plain.highestY, 'the body fits');
    close(window.halfWidth / window.halfHeight, aspect, 1e-9, 'at the screen`s aspect');
  });
};
