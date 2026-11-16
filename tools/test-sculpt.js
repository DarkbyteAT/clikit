/**
 * Unit tests for the sculpt kernel (kit/sculpt.js) and its use on bodies (kit/figure-sculpt.js): a body as one
 * blended, skinned surface per paint with its garments as layers. Loaded by tools/test-kit.js after
 * tools/test-figure.js, which has already put the body system, the shapes and the layout in the sandbox.
 *
 * Owns:  the cases, each beside a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), or the THREE half (kit/figure.js binds the
 *        layers to a skeleton; the coverage sheets of tools/dev.js proof show the result).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['sculpt', 'sculpt-relief', 'drape', 'figure-sculpt'];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const VECTOR = 3;
const OWNERS = 4;

/** Six times the volume a closed mesh encloses, positive when its triangles wind outward. */
const sixVolumes = ({ positions, indices }) => {
  let sum = 0;
  for (let face = 0; face < indices.length; face += VECTOR) {
    const [a, b, c] = [indices[face] * VECTOR, indices[face + 1] * VECTOR, indices[face + 2] * VECTOR];
    sum +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) +
      positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return sum;
};

/**
 * Edges of a mesh that leave a hole, and edges where two sheets touch. A surface is watertight when every edge
 * is walked as often one way as the other (`open` is 0); it is also a plain two-sided skin when each is walked
 * exactly once each way (`pinched` is 0 too). A net over a grid shares one vertex per cell, so two sheets passing
 * through one cell (the gap of an armpit narrower than a cell) meet in a pinched edge: closed, not a hole.
 * @returns {{open: number, pinched: number}}
 */
const edgesOf = ({ positions, indices }) => {
  const count = positions.length / VECTOR;
  const seen = new Map();
  for (let face = 0; face < indices.length; face += VECTOR) {
    for (let corner = 0; corner < VECTOR; corner++) {
      const from = indices[face + corner];
      const to = indices[face + ((corner + 1) % VECTOR)];
      seen.set(from * count + to, (seen.get(from * count + to) || 0) + 1);
    }
  }
  let open = 0;
  let pinched = 0;
  seen.forEach((times, key) => {
    const from = Math.floor(key / count);
    if (times !== (seen.get((key - from * count) * count + from) || 0)) open++;
    else if (times !== 1) pinched++;
  });
  return { open, pinched };
};

/** An open edge of a covered skin lies this near a vertex of the garment over it (metres: a low-detail cell and the garment's lift). */
const MOST_UNDER = 0.09;
const WELD = 1e5;

/** Several layers as one mesh, their vertices welded where they coincide (a paint and the surface it was cut out of). */
const welded = (layers) => {
  const numbers = new Map();
  const positions = [];
  const indices = [];
  layers.forEach((layer) => {
    layer.indices.forEach((vertex) => {
      const at = [0, 1, 2].map((axis) => layer.positions[vertex * VECTOR + axis]);
      const key = at.map((value) => Math.round(value * WELD)).join(',');
      if (!numbers.has(key)) {
        numbers.set(key, positions.length / VECTOR);
        positions.push(...at);
      }
      indices.push(numbers.get(key));
    });
  });
  return { positions, indices };
};

/** The middles of a mesh's open edges, and how many edges more than two triangles share. */
const openEdgesOf = ({ positions, indices }) => {
  const count = positions.length / VECTOR;
  const seen = new Map();
  for (let face = 0; face < indices.length; face += VECTOR) {
    for (let corner = 0; corner < VECTOR; corner++) {
      const from = indices[face + corner];
      const to = indices[face + ((corner + 1) % VECTOR)];
      if (from !== to) seen.set(from * count + to, (seen.get(from * count + to) || 0) + 1);
    }
  }
  const open = [];
  let pinched = 0;
  seen.forEach((times, key) => {
    const from = Math.floor(key / count);
    const to = key - from * count;
    if (times !== (seen.get(to * count + from) || 0)) open.push([0, 1, 2].map((axis) => (positions[from * VECTOR + axis] + positions[to * VECTOR + axis]) / 2));
    else if (times !== 1) pinched++;
  });
  return { open, pinched };
};

const nearestVertex = (positions, x, y, z) => {
  let nearest = Infinity;
  for (let offset = 0; offset < positions.length; offset += VECTOR) nearest = Math.min(nearest, Math.hypot(positions[offset] - x, positions[offset + 1] - y, positions[offset + 2] - z));
  return nearest;
};

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const { sculpt, figure } = Kit;
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const RADIUS = 0.2;
  const ball = () => sculpt.solid({ kind: 'sphere', radius: RADIUS, at: [0, 0, 0] }, IDENTITY, { owner: 0 });
  const capsule = (from, to, radius, options) => {
    const placed = sculpt.solid({ kind: 'capsule', end: [to[0] - from[0], to[1] - from[1], to[2] - from[2]], radius, endRadius: radius, at: [0, 0, 0] }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, from[0], from[1], from[2], 1], { owner: options.owner, blend: options.blend });
    return Object.assign(placed, options);
  };

  test('sculpt: a sphere is meshed on its radius at every detail, closed, wound outward, with outward unit normals', () => {
    Object.keys(sculpt.DETAIL).forEach((detail) => {
      const field = sculpt.sample([ball()], { detail });
      const mesh = sculpt.surface(field);
      assert.ok(mesh.positions.length > 0 && mesh.indices.length > 0, detail);
      let worst = 0;
      let leastOutward = 1;
      for (let vertex = 0; vertex < mesh.positions.length; vertex += VECTOR) {
        const [x, y, z] = [mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]];
        const length = Math.hypot(x, y, z);
        worst = Math.max(worst, Math.abs(length - RADIUS));
        leastOutward = Math.min(leastOutward, (x * mesh.normals[vertex] + y * mesh.normals[vertex + 1] + z * mesh.normals[vertex + 2]) / length);
        close(Math.hypot(mesh.normals[vertex], mesh.normals[vertex + 1], mesh.normals[vertex + 2]), 1, 1e-4, 'a normal has unit length');
      }
      assert.ok(worst < field.cell * 0.05, `${detail}: a vertex is ${worst} m off the sphere (cell ${field.cell})`);
      assert.ok(leastOutward > 0.97, `${detail}: a normal leans ${leastOutward} from outward`);
      assert.deepStrictEqual(edgesOf(mesh), { open: 0, pinched: 0 }, `${detail}: closed`);
      // Outward winding: the enclosed volume is positive, and that of the sphere less what flat triangles cut off.
      const volume = sixVolumes(mesh) / 6;
      const exact = (4 / 3) * Math.PI * RADIUS ** 3;
      assert.ok(volume > exact * 0.9 && volume <= exact, `${detail}: volume ${volume} against ${exact}`);
    });
    // Control: the same triangles wound the other way enclose a negative volume.
    const mesh = sculpt.surface(sculpt.sample([ball()], { detail: 'low' }));
    const flipped = Array.from(mesh.indices);
    for (let face = 0; face < flipped.length; face += VECTOR) [flipped[face], flipped[face + 1]] = [flipped[face + 1], flipped[face]];
    assert.ok(sixVolumes({ positions: mesh.positions, indices: flipped }) < 0);
    assert.strictEqual(edgesOf({ positions: mesh.positions, indices: mesh.indices.subarray(VECTOR) }).open, VECTOR, 'a missing triangle is seen as a hole');
  });

  test('sculpt: a field kept on a grid is a solid like any other (a baked source), and reads as the shape it was sampled from', () => {
    const baked = sculpt.sample([ball()], { detail: 'high', margin: 0.03 });
    // The band's far side holds a sentinel; a kept field is made true there by clamping to what the band measured.
    const reach = baked.cell * 2;
    const values = Float32Array.from(baked.values, (value) => Math.max(-reach, Math.min(reach, value)));
    const kept = sculpt.solid({ kind: 'grid', values, size: baked.size, origin: baked.origin, cell: baked.cell, at: [0, 0, 0] }, IDENTITY, { owner: 3 });
    close(kept.distance(RADIUS, 0, 0), 0, baked.cell * 0.1, 'on the surface');
    assert.ok(kept.distance(0, 0, 0) < 0 && kept.distance(RADIUS * 3, 0, 0) > RADIUS, 'inside is negative, far outside is far');
    const mesh = sculpt.surface(sculpt.sample([kept], { detail: 'medium' }));
    assert.ok(mesh.positions.length > 0);
    for (let vertex = 0; vertex < mesh.positions.length; vertex += VECTOR) close(Math.hypot(mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]), RADIUS, baked.cell * 0.5, 'the kept ball');
    assert.deepStrictEqual(edgesOf(mesh), { open: 0, pinched: 0 });
    // Control: an unknown kind is refused by name.
    assert.throws(() => sculpt.solid({ kind: 'cloud', at: [0, 0, 0] }, IDENTITY, { positions: [0, 0, 0] }), /kind "cloud"/);
  });

  test('sculpt: an offset surface lies that far off the solid, and an offset past the sampled margin is refused', () => {
    const field = sculpt.sample([ball()], { detail: 'medium', margin: 0.02 });
    const mesh = sculpt.surface(field, { offset: 0.02 });
    for (let vertex = 0; vertex < mesh.positions.length; vertex += VECTOR) close(Math.hypot(mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]), RADIUS + 0.02, field.cell * 0.05, 'on the offset sphere');
    assert.throws(() => sculpt.surface(field, { offset: 0.05 }), /margin/);
  });

  test('sculpt: a cut edge lies where the predicate says, within a fraction of a cell, however coarse the grid', () => {
    const HEM = 0.0437; // deliberately not on a grid plane
    Object.keys(sculpt.DETAIL).forEach((detail) => {
      const field = sculpt.sample([ball()], { detail, margin: 0.01 });
      const mesh = sculpt.surface(field, { offset: 0.01, cut: (_x, y) => y > HEM });
      let lowest = Infinity;
      for (let vertex = 1; vertex < mesh.positions.length; vertex += VECTOR) lowest = Math.min(lowest, mesh.positions[vertex]);
      close(lowest, HEM, field.cell * 0.1, `${detail}: the hem`);
      // The layer is a shell on the surface: its wall ends within two cells under the body, not at the centre.
      for (let vertex = 0; vertex < mesh.positions.length; vertex += VECTOR) assert.ok(Math.hypot(mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]) > RADIUS - 0.002 - field.cell * 2, detail);
      assert.ok(sixVolumes(mesh) > 0, `${detail}: wound outward`);
    });
    // Control: a cut that holds nowhere leaves no surface; `walls: false` drops the faces through the thickness.
    const field = sculpt.sample([ball()], { detail: 'medium', margin: 0.01 });
    assert.strictEqual(sculpt.surface(field, { offset: 0.01, cut: () => false }).indices.length, 0);
    const walled = sculpt.surface(field, { offset: 0.01, cut: (_x, y) => y > HEM });
    const sheet = sculpt.surface(field, { offset: 0.01, cut: (_x, y) => y > HEM, walls: false });
    assert.ok(sheet.indices.length > 0 && sheet.indices.length < walled.indices.length);
  });

  test('sculpt: skin weights sum to 1; a vertex far from a joint has one owner, one at the joint is shared', () => {
    const upper = capsule([0, 0, 0], [0, -0.3, 0], 0.05, { owner: 3, blend: 0.03 });
    const lower = capsule([0, -0.3, 0], [0, -0.6, 0], 0.045, { owner: 7, blend: 0.03 });
    const field = sculpt.sample([upper, lower], { detail: 'medium' });
    const mesh = sculpt.surface(field);
    const skin = sculpt.weights(mesh.positions, field.solids);
    assert.strictEqual(skin.owners.length, (mesh.positions.length / VECTOR) * OWNERS);
    let shared = 0;
    for (let vertex = 0; vertex < mesh.positions.length / VECTOR; vertex++) {
      const shares = Array.from(skin.weights.subarray(vertex * OWNERS, vertex * OWNERS + OWNERS));
      close(shares.reduce((sum, share) => sum + share, 0), 1, 1e-5, 'shares sum to 1');
      assert.ok(shares.every((share, slot) => share >= 0 && (slot === 0 || share <= shares[slot - 1])), 'strongest first');
      const y = mesh.positions[vertex * VECTOR + 1];
      if (y > -0.2) assert.deepStrictEqual([skin.owners[vertex * OWNERS], shares[0]], [3, 1], `the upper segment alone owns a vertex at y=${y}`);
      if (y < -0.4) assert.deepStrictEqual([skin.owners[vertex * OWNERS], shares[0]], [7, 1], `the lower segment alone owns a vertex at y=${y}`);
      if (Math.abs(y + 0.3) < 0.01) {
        assert.ok(shares[0] < 0.75 && shares[1] > 0.25, `a vertex at the joint is shared: ${shares}`);
        shared++;
      }
    }
    assert.ok(shared > 0, 'the control ring at the joint exists');
    // A layer lying off the body (a glove) still finds its owner rather than falling to bone 0.
    const glove = sculpt.weights(new Float32Array([0.5, -0.5, 0]), field.solids);
    assert.deepStrictEqual([glove.owners[0], glove.weights[0]], [7, 1]);
  });

  test('sculpt: parallel surfaces do not swell where they run side by side; crossing ones are filleted', () => {
    const options = { owner: 0, blend: 0.04 };
    // Two segments of one limb that overlap along their length: their sides coincide, facing the same way.
    const upper = capsule([0, -0.3, 0], [0, 0.1, 0], 0.04, options);
    const lower = capsule([0, -0.1, 0], [0, 0.3, 0], 0.04, options);
    const side = sculpt.sample([upper, lower], { detail: 'high' });
    // A plain smooth minimum would lift the shared side by a quarter of the blend (10 mm): the field stays the solids'.
    [0, 0.03, -0.07].forEach((y) =>
      [0.036, 0.04, 0.046].forEach((x) => close(sculpt.valueAt(side, x, y, 0.004), Math.min(upper.distance(x, y, 0.004), lower.distance(x, y, 0.004)), 5e-4, `no swelling at x=${x} y=${y}`))
    );
    const mesh = sculpt.surface(side);
    for (let vertex = 0; vertex < mesh.positions.length; vertex += VECTOR) assert.ok(Math.hypot(mesh.positions[vertex], mesh.positions[vertex + 2]) < 0.04 + 5e-4, 'no vertex stands proud of the radius');
    // Control: the same two solids crossing at a right angle are joined by a fillet in the corner.
    const across = capsule([-0.3, 0, 0], [0.3, 0, 0], 0.04, options);
    const upright = capsule([0, -0.3, 0], [0, 0.3, 0], 0.04, options);
    const crossed = sculpt.sample([across, upright], { detail: 'high' });
    const corner = [0.045, 0.045, 0];
    assert.ok(sculpt.valueAt(crossed, ...corner) < Math.min(across.distance(...corner), upright.distance(...corner)) - 0.002, 'a fillet fills the corner');
  });

  test('sculpt: a limb joins the trunk at its anchor and does not blend with it far from there', () => {
    const trunk = capsule([0, 0, 0], [0, 0.6, 0], 0.12, { owner: 0, blend: 0.04, group: 0 });
    // An arm hanging 15 mm off the trunk's side, anchored at its shoulder.
    const armOptions = { owner: 1, blend: 0.04, group: 1, anchor: [0.18, 0.55, 0], join: 0.04 };
    const arm = () => capsule([0.18, 0.55, 0], [0.18, 0.05, 0], 0.045, { ...armOptions });
    const field = sculpt.sample([trunk, arm()], { detail: 'high' });
    /** The furthest a vertex beside the hip (well below the shoulder) lies from the surface of either solid alone. */
    const bridging = (sampled) => {
      const { positions } = sculpt.surface(sampled);
      let worst = 0;
      for (let vertex = 0; vertex < positions.length; vertex += VECTOR) {
        const [x, y, z] = [positions[vertex], positions[vertex + 1], positions[vertex + 2]];
        if (y > 0.1 && y < 0.25) worst = Math.max(worst, Math.abs(Math.min(trunk.distance(x, y, z), sampled.solids[1].distance(x, y, z))));
      }
      return worst;
    };
    assert.ok(bridging(field) < 5e-4, `far from the shoulder the two stay apart: ${bridging(field)}`);
    const armpit = [0.1275, 0.52, 0];
    assert.ok(Math.min(trunk.distance(...armpit), field.solids[1].distance(...armpit)) > 0.007 && sculpt.valueAt(field, ...armpit) < 0, 'at the shoulder the gap between them is filled');
    // Control: without an anchor the group joins everywhere, and the gap by the hip fills too.
    const melted = sculpt.sample([trunk, Object.assign(arm(), { anchor: undefined })], { detail: 'high' });
    assert.ok(bridging(melted) > 0.002, `the control melts: ${bridging(melted)}`);
  });

  test('sculpt: one thin solid neither sets the grid nor is meshed; the cell grows with what is sampled', () => {
    const body = ball();
    const pin = capsule([0.3, 0, 0], [0.3, 0.05, 0], 0.002, { owner: 1, blend: 0 });
    assert.strictEqual(sculpt.cellFor([body, pin], 'high'), sculpt.cellFor([body], 'high'));
    assert.ok(sculpt.isTooThin(pin, sculpt.cellFor([body], 'high')) && !sculpt.isTooThin(body, sculpt.cellFor([body], 'high')));
    const giant = sculpt.solid({ kind: 'sphere', radius: 4, at: [0, 0, 0] }, IDENTITY);
    assert.ok(sculpt.cellFor([giant], 'high') >= 8 / sculpt.DETAIL.high.most);
  });

  const catalogs = ['wardrobe', 'samples'].filter((name) => Kit.body[name]).map((name) => ({ name, catalog: Kit.body.catalog(Kit.body[name].CATALOG) }));

  /** A flat sheet of `cells` x `cells` squares over the unit square at z = 0, facing +z, owned by bone 0 (left half) or 1. */
  const sheetOf = (cells) => {
    const side = cells + 1;
    const positions = [];
    const normals = [];
    const owners = [];
    const weights = [];
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        positions.push(column / cells, row / cells, 0);
        normals.push(0, 0, 1);
        owners.push(column / cells < 0.5 ? 0 : 1, 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
    }
    const indices = [];
    for (let row = 0; row < cells; row++) {
      for (let column = 0; column < cells; column++) {
        const corner = row * side + column;
        indices.push(corner, corner + 1, corner + side + 1, corner, corner + side + 1, corner + side);
      }
    }
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), owners: Uint16Array.from(owners), weights: Float32Array.from(weights), indices: Uint16Array.from(indices) };
  };
  const areaOfMesh = (mesh) => {
    let area = 0;
    for (let face = 0; mesh && face < mesh.indices.length; face += VECTOR) {
      const [first, second, third] = [0, 1, 2].map((corner) => mesh.indices[face + corner] * VECTOR);
      // Signed, about +z: a triangle turned over would take area away.
      area += ((mesh.positions[second] - mesh.positions[first]) * (mesh.positions[third + 1] - mesh.positions[first + 1]) - (mesh.positions[third] - mesh.positions[first]) * (mesh.positions[second + 1] - mesh.positions[first + 1])) / 2;
    }
    return area;
  };

  test('paint: a pattern parts a surface into a painted sheet and the rest along its exact edge, with no crack, overlap or turned triangle, at any coarseness', () => {
    // Hoops narrower than a triangle of the coarse sheet: 0.07 wide, every 0.2.
    const hoop = (_x, y) => (y + 0.031) % 0.2 < 0.07;
    [3, 8, 40].forEach((cells) => {
      const canvas = sheetOf(cells);
      const { painted, rest } = figure.paintedOn(canvas, hoop, () => true);
      assert.ok(painted && rest, `${cells}: both parts exist`);
      // The two parts tile the sheet: their signed areas sum to its area, and the painted share is the pattern's.
      assert.ok(Math.abs(areaOfMesh(painted) + areaOfMesh(rest) - 1) < 1e-5, `${cells}: the parts cover the canvas once (${areaOfMesh(painted) + areaOfMesh(rest)})`);
      const exact = 5 * 0.07;
      // A coarse sheet sees each hoop where its edges meet it, so the share is near, not exact; a fine one is exact.
      assert.ok(Math.abs(areaOfMesh(painted) - exact) < (cells >= 8 ? 0.004 : 0.12), `${cells}: painted share ${areaOfMesh(painted)} of ${exact}`);
      // Every vertex on the cut lies on a hoop's edge, to within the bisection (2^-7 of an edge).
      const edge = 1 / cells;
      const cutHeights = [];
      for (let vertex = 0; vertex < painted.positions.length / VECTOR; vertex++) {
        const y = painted.positions[vertex * VECTOR + 1];
        const within = (y + 0.031) % 0.2;
        assert.ok(within < 0.07 + edge / 64 || within > 0.2 - edge / 64, `${cells}: a painted vertex at y=${y} lies off the hoops`);
        cutHeights.push(Math.min(Math.abs(within), Math.abs(within - 0.07), Math.abs(within - 0.2)));
      }
      if (cells >= 8) assert.ok(cutHeights.filter((off) => off < edge / 64).length >= cells * 5, `${cells}: the cut runs the width of the sheet on both edges of each hoop`);
      // One surface: the sheet takes the canvas's normals and skin, and together the two parts are watertight inside the sheet.
      assert.ok(painted.normals.every((value, at) => (at % VECTOR === 2 ? value === 1 : value === 0)), `${cells}: the canvas's normals`);
      for (let vertex = 0; vertex < painted.owners.length / OWNERS; vertex++) {
        let sum = 0;
        for (let slot = 0; slot < OWNERS; slot++) sum += painted.weights[vertex * OWNERS + slot];
        assert.ok(Math.abs(sum - 1) < 1e-6, `${cells}: weights sum to one`);
        const x = painted.positions[vertex * VECTOR];
        if (Math.abs(x - 0.5) > edge) assert.strictEqual(painted.owners[vertex * OWNERS], x < 0.5 ? 0 : 1, `${cells}: the canvas's owner at x=${x}`);
      }
      const together = openEdgesOf(welded([painted, rest]));
      assert.strictEqual(together.pinched, 0, `${cells}: no doubled triangle`);
      together.open.forEach(([x, y]) => assert.ok(Math.min(x, 1 - x, y, 1 - y) < 1e-6, `${cells}: an open edge inside the sheet at ${x},${y}: a crack`));
    });
    // Nothing painted, everything painted, and bones the pattern cannot hold on.
    assert.strictEqual(figure.paintedOn(sheetOf(4), () => false, () => true).painted, null);
    assert.strictEqual(figure.paintedOn(sheetOf(4), () => true, () => true).rest, null);
    const half = figure.paintedOn(sheetOf(4), () => true, (bone) => bone === 1);
    assert.ok(Math.abs(areaOfMesh(half.painted) - 0.75) < 1e-6, 'only triangles with a vertex of a bone the pattern holds on are asked');
    // Control: read at the vertices alone (what a sheet meshed apart does), the coarse sheet's rows meet two of the
    // five hoops; the cut finds more paint than those two hold.
    const coarse = sheetOf(3);
    const rowsInHoops = [0, 1, 2, 3].filter((row) => hoop(0, row / 3)).length;
    assert.strictEqual(rowsInHoops, 2, 'control: two rows of vertices lie in hoops');
    assert.ok(areaOfMesh(figure.paintedOn(coarse, hoop, () => true).painted) > rowsInHoops * 0.07 + 0.05, 'hoops between the rows are painted too');
  });

  test('paint: what a garment covers is not drawn, but for a margin under its edge; what shows is untouched', () => {
    const canvas = sheetOf(10);
    const covers = (_x, y) => y < 0.55;
    const left = figure.uncovered(canvas, covers, () => true, 1);
    // Rows wholly under the cover go, but for one ring of triangles in from its edge.
    const lowest = Math.min(...Array.from({ length: left.positions.length / VECTOR }, (_unused, vertex) => left.positions[vertex * VECTOR + 1]));
    assert.ok(Math.abs(lowest - 0.4) < 1e-6, `kept down to one ring under the edge (${lowest})`);
    assert.ok(Math.abs(areaOfMesh(left) - 0.6) < 1e-6, 'whole triangles, as wound');
    assert.ok(figure.uncovered(canvas, covers, () => true, 2).indices.length > left.indices.length, 'a wider margin keeps more');
    assert.strictEqual(figure.uncovered(canvas, () => false, () => true), canvas, 'nothing covered: the layer itself');
    assert.strictEqual(figure.uncovered(canvas, () => true, () => true), null, 'all covered: nothing');
    assert.strictEqual(figure.uncovered(canvas, () => true, () => false), canvas, 'bones the cover is not on are not asked');
    // On a figure: a clothed body draws fewer skin triangles than a bare one, and from eight directions no ray reaches a hole.
    const { catalog } = catalogs[0];
    const editor = Kit.body.editor(catalog);
    const bakery = catalog.bakery({ capacity: 4 });
    const skinOf = (recipe) => {
      figure.sculptCache.clear();
      const bake = bakery.bakeRecipe(recipe);
      return figure.sculptLayers(bake, figure.layout(bake, { level: 'low' })).layers.filter((layer) => layer.id.startsWith('skin:')).reduce((sum, layer) => sum + layer.indices.length / VECTOR, 0);
    };
    const bare = ['top', 'bottom', 'footwear', 'outerwear', 'hair'].reduce((recipe, socket) => editor.setSocket(recipe, socket, 'none'), { species: 'person', seed: 1 });
    const clothed = [['top', 'longSleeve'], ['bottom', 'trousers'], ['footwear', 'boots']].reduce((recipe, [socket, choice]) => editor.setSocket(recipe, socket, choice), bare);
    assert.ok(skinOf(clothed) < skinOf(bare) * 0.7, `clothes hide skin: ${skinOf(clothed)} of ${skinOf(bare)} triangles drawn`);
  });

  test('sculpt: every species of both catalogues sculpts to closed skins and non-empty layers that replace the pieces they were made from', () => {
    assert.strictEqual(catalogs.length, 2, 'both catalogues are loaded');
    catalogs.forEach(({ name, catalog }) => {
      const bakery = catalog.bakery({ capacity: 4 });
      catalog.speciesIds().forEach((species) => {
        const where = `${name}/${species}`;
        const bake = bakery.bakeRecipe({ species, seed: 1 });
        const layout = figure.layout(bake, { level: 'low' });
        const sculpted = figure.sculptLayers(bake, layout);
        assert.ok(sculpted.layers.length > 0, `${where}: something is sculpted`);
        const boneCount = bake.plan.boneNames.length;
        sculpted.layers.forEach((layer) => {
          const vertexCount = layer.positions.length / VECTOR;
          assert.ok(vertexCount > 0 && layer.indices.length >= VECTOR, `${where} ${layer.id}: not empty`);
          assert.ok(layer.positions.every(Number.isFinite) && layer.normals.every(Number.isFinite), `${where} ${layer.id}: finite`);
          assert.ok(layer.indices.every((index) => index < vertexCount), `${where} ${layer.id}: indices in range`);
          assert.ok(layer.ramp >= 0 && layer.ramp < bake.ramps.length, `${where} ${layer.id}: a paint of the bake`);
          assert.strictEqual(layer.owners.length, vertexCount * OWNERS);
          for (let vertex = 0; vertex < vertexCount; vertex++) {
            let sum = 0;
            for (let slot = 0; slot < OWNERS; slot++) {
              sum += layer.weights[vertex * OWNERS + slot];
              assert.ok(layer.owners[vertex * OWNERS + slot] < boneCount, `${where} ${layer.id}: a bone of the plan`);
            }
            if (Math.abs(sum - 1) > 1e-4) assert.fail(`${where} ${layer.id}: weights of vertex ${vertex} sum to ${sum}`);
          }
          if (layer.id.startsWith('worn:')) {
            assert.deepStrictEqual(edgesOf(layer), { open: 0, pinched: 0 }, `${where} ${layer.id}: closed, every edge shared by exactly two triangles`);
            assert.ok(sixVolumes(layer) > 0, `${where} ${layer.id}: wound outward`);
          }
        });
        // A skin is closed but for what a garment covers: with the paint cut out of it put back, its open edges
        // all lie under a raised garment (within a cell or so of one), and nothing is pinched.
        const isRaised = (layer) => layer.id.startsWith('region:') && !layer.id.endsWith('|0');
        const raised = sculpted.layers.filter(isRaised);
        sculpted.layers
          .filter((layer) => layer.id.startsWith('skin:'))
          .forEach((skin) => {
            const whole = welded([skin, ...sculpted.layers.filter((layer) => layer.id.startsWith('region:') && !isRaised(layer) && layer.inkGroup === skin.inkGroup)]);
            const edges = openEdgesOf(whole);
            assert.strictEqual(edges.pinched, 0, `${where} ${skin.id}: no edge shared by more than two triangles`);
            assert.ok(sixVolumes(skin) > 0, `${where} ${skin.id}: wound outward`);
            edges.open.forEach(([x, y, z]) => {
              const nearest = Math.min(...raised.map((layer) => nearestVertex(layer.positions, x, y, z)));
              if (!(nearest < MOST_UNDER)) assert.fail(`${where} ${skin.id}: an open edge at ${[x, y, z].map((value) => value.toFixed(3))} is ${nearest} from any garment: the skin is open where it can be seen`);
            });
          });
        // What is replaced is exactly what was meshed: every such piece has a shape, and its bone owns vertices.
        const owning = new Set();
        sculpted.layers.forEach((layer) => layer.owners.forEach((owner, slot) => layer.weights[slot] > 0 && owning.add(owner)));
        const pieces = new Map(layout.pieces.map((piece) => [piece.id, piece]));
        assert.ok(sculpted.replaced.size > 0, where);
        sculpted.replaced.forEach((id) => {
          assert.ok(pieces.has(id), `${where}: ${id} is a piece of the layout`);
          // A draped object (a skirt) is moved by the body bones it hangs beside, not by its own bone.
          const isDraped = bake.plan.spec.bones.some((row) => row.name === bake.plan.boneNames[pieces.get(id).bone] && row.wear === 'drape');
          if (!pieces.get(id).shell && !isDraped) assert.ok(owning.has(pieces.get(id).bone), `${where}: the bone of ${id} moves part of a layer`);
        });
        assert.strictEqual(sculpted.matrices.length, boneCount * 16);
      });
    });
  });

  test('sculpt: worn objects follow their data: a skirt is draped on the legs and its own bone and hangs as authored where the body is not in its way, a hat is a solid on its own bone, a sword stays rigid', () => {
    const { catalog } = catalogs[0];
    const editor = Kit.body.editor(catalog);
    const [species] = catalog.speciesIds();
    const recipe = editor.setSocket(editor.setSocket({ species, seed: 1 }, 'bottom', 'skirt'), 'hat', 'wideBrim');
    const bake = catalog.bakery({ capacity: 4 }).bakeRecipe(recipe);
    const { plan } = bake;
    const layout = figure.layout(bake, { level: 'medium' });
    const sculpted = figure.sculptLayers(bake, layout);
    const skirt = sculpted.layers.find((layer) => layer.id.startsWith('worn:bottom'));
    const hat = sculpted.layers.find((layer) => layer.id.startsWith('worn:hat'));
    assert.ok(skirt && hat, `layers: ${sculpted.layers.map((layer) => layer.id).join(' ')}`);
    assert.ok(skirt.id.endsWith('drape') && hat.id.endsWith('solid'));
    const legMask = Kit.body.roleMask(['leg']);
    const ownBone = plan.boneIndex('bottom/skirt');
    assert.ok(skirt.owners.every((owner, slot) => skirt.weights[slot] === 0 || owner === ownBone || (plan.roles[owner] & legMask) !== 0), 'every owner of the skirt is a leg bone or the bone it hangs from');
    const legShare = skirt.weights.reduce((sum, share, slot) => sum + (skirt.owners[slot] === ownBone ? 0 : share), 0) / (skirt.positions.length / 3);
    assert.ok(legShare > 0.6 && legShare < 1, `the legs carry most of it, its own bone the rest: ${legShare}`);
    assert.ok(new Set(Array.from(skirt.owners).filter((_owner, slot) => skirt.weights[slot] > 0.5)).size >= 2, 'both legs carry it');
    assert.ok(hat.owners.every((owner, slot) => hat.weights[slot] === 0 || plan.boneNames[owner].startsWith('hat/')), 'the hat is moved by its own bones');
    // Skinned from the sculpting pose (legs spread) to rest, the skirt is the authored cone again: every vertex on its solid.
    const rest = figure.restMatrices(bake);
    const bone = plan.boneIndex('bottom/skirt');
    const piece = layout.pieces.find((candidate) => candidate.bone === bone);
    const authored = sculpt.solid(piece.shape, rest.subarray(bone * 16, bone * 16 + 16));
    const inverses = Array.from({ length: plan.boneCount }, (_unused, index) => sculpt.invertAffine(sculpted.matrices.subarray(index * 16, index * 16 + 16)));
    const moved = (matrices, layer, vertex) => {
      const out = [0, 0, 0];
      for (let slot = 0; slot < OWNERS; slot++) {
        const share = layer.weights[vertex * OWNERS + slot];
        if (!share) continue;
        const owner = layer.owners[vertex * OWNERS + slot];
        const back = inverses[owner];
        const [x, y, z] = [layer.positions[vertex * 3], layer.positions[vertex * 3 + 1], layer.positions[vertex * 3 + 2]];
        const local = [back[0] * x + back[1] * y + back[2] * z + back[3], back[4] * x + back[5] * y + back[6] * z + back[7], back[8] * x + back[9] * y + back[10] * z + back[11]];
        for (let axis = 0; axis < 3; axis++) out[axis] += share * (matrices[owner * 16 + axis] * local[0] + matrices[owner * 16 + 4 + axis] * local[1] + matrices[owner * 16 + 8 + axis] * local[2] + matrices[owner * 16 + 12 + axis]);
      }
      return out;
    };
    // Cloth is laid over the body (kit/drape.js): where the hips are in its way it is pushed outwards, never inwards.
    let [worstInside, worstOutside, asAuthored, worstInsideUnmoved] = [0, 0, 0, 0];
    for (let vertex = 0; vertex < skirt.positions.length / 3; vertex++) {
      const atRest = authored.distance(...moved(rest, skirt, vertex));
      worstInside = Math.max(worstInside, -atRest);
      worstOutside = Math.max(worstOutside, atRest);
      if (Math.abs(atRest) < 0.004) asAuthored += 1;
      worstInsideUnmoved = Math.max(worstInsideUnmoved, -authored.distance(skirt.positions[vertex * 3], skirt.positions[vertex * 3 + 1], skirt.positions[vertex * 3 + 2]));
    }
    assert.ok(worstInside < 0.012, `at rest no part of the skirt is inside the authored cone: ${worstInside}`);
    assert.ok(worstOutside < Kit.drape.DRAPE.mostPush + 0.012, `and none is pushed out of it further than cloth is ever pushed: ${worstOutside}`);
    assert.ok(asAuthored > 0, 'some of it is exactly where it was authored');
    assert.ok(worstInsideUnmoved > Math.max(worstInside, 0.012) * 2, `the control: in the sculpting pose it is spread with the legs (${worstInsideUnmoved})`);
    // A held thing has no wear: it is the rigid piece it was.
    const armed = catalog.bakery({ capacity: 4 }).bakeRecipe(editor.setSocket({ species, seed: 1 }, 'handRight', 'shortBlade'));
    const armedLayout = figure.layout(armed, { level: 'medium' });
    const blade = armedLayout.pieces.find((candidate) => armed.plan.boneNames[candidate.bone] === 'handRight/blade');
    assert.ok(blade && !figure.sculptLayers(armed, armedLayout).replaced.has(blade.id));
  });

  test('sculpt: a task does the same sculpt in steps of bounded time, and shares the cache', () => {
    const { catalog } = catalogs[0];
    const [species] = catalog.speciesIds();
    const bake = catalog.bakery({ capacity: 4 }).bakeRecipe({ species, seed: 3 });
    const layout = figure.layout(bake, { level: 'low' });
    figure.sculptCache.clear();
    const whole = figure.sculptLayers(bake, layout);
    figure.sculptCache.clear();
    // A clock that says a millisecond passes at every look: each step of 0 ms does exactly one piece of work.
    let clock = 0;
    const task = figure.sculptTask(bake, layout, { now: () => clock++ });
    assert.strictEqual(task.isDone(), false);
    let calls = 0;
    while (!task.step(0)) calls++;
    assert.ok(calls > 10, `the work is in many pieces: ${calls}`);
    assert.deepStrictEqual(task.result.layers.map((layer) => [layer.id, layer.positions.length, layer.indices.length]), whole.layers.map((layer) => [layer.id, layer.positions.length, layer.indices.length]));
    assert.deepStrictEqual(Array.from(task.result.layers[0].positions.subarray(0, 300)), Array.from(whole.layers[0].positions.subarray(0, 300)), 'the same surface');
    assert.strictEqual(figure.sculptLayers(bake, layout), task.result, 'the finished task is what the cache holds');
    assert.strictEqual(figure.sculptTask(bake, layout).isDone(), true, 'a bake seen before is done at once');
    // Something else sampled while a task is half way does not disturb it.
    figure.sculptCache.clear();
    const paused = figure.sculptTask(bake, layout, { now: () => clock++ });
    for (let step = 0; step < 5; step++) paused.step(0);
    sculpt.surface(sculpt.sample([ball()], { detail: 'low' }));
    assert.deepStrictEqual(Array.from(paused.finish().layers[0].positions.subarray(0, 300)), Array.from(whole.layers[0].positions.subarray(0, 300)));
  });

  test('sculpt: the level of detail follows how tall a figure is drawn', () => {
    assert.deepStrictEqual([40, 150, 151, 330, 331, 900].map(figure.levelFor), ['low', 'low', 'medium', 'medium', 'high', 'high']);
    assert.ok(figure.LEVEL_BY_PIXELS.every((row) => sculpt.DETAIL[row.level] && figure.LEVELS[row.level]));
  });

  test('sculpt: equal bakes share their layers; a colour does not change what is sculpted, a dial does', () => {
    const { catalog } = catalogs[0];
    const [species] = catalog.speciesIds();
    const editor = Kit.body.editor(catalog);
    const bakery = catalog.bakery({ capacity: 8 });
    const recipe = { species, seed: 1 };
    const bake = bakery.bakeRecipe(recipe);
    const layout = figure.layout(bake, { level: 'low' });
    figure.sculptCache.clear();
    const first = figure.sculptLayers(bake, layout);
    assert.strictEqual(figure.sculptLayers(bake, layout), first, 'the same bake is not sculpted twice');
    assert.strictEqual(figure.sculptCache.size(), 1);
    const schema = editor.schema(recipe);
    const [color] = schema.colors;
    const recoloured = bakery.bakeRecipe(editor.setColor(recipe, color.id, (color.value + 1) % color.ramps.length));
    assert.notDeepStrictEqual(Array.from(recoloured.individual.colors), Array.from(bake.individual.colors), 'the control: the colour did change');
    assert.ok(figure.sculptSignature(recoloured, figure.layout(recoloured, { level: 'low' })) === first.signature, 'a colour is not part of the signature');
    const dial = schema.dials.find((control) => control.affects.some((effect) => effect.channel === 'girth'));
    const reshaped = bakery.bakeRecipe(editor.setDial(recipe, dial.id, dial.max));
    assert.ok(figure.sculptSignature(reshaped, figure.layout(reshaped, { level: 'low' })) !== first.signature, 'a dial that changes a girth is');
    assert.ok(figure.sculptSignature(bake, layout, 'high') !== first.signature, 'so is the detail');
  });
};
