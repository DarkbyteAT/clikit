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

const FILES = ['sculpt', 'figure-detail', 'figure-sculpt'];
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

/** The 26 directions to the faces, edges and corners of a cube, unit length. */
const DIRECTIONS = [-1, 0, 1]
  .flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => [x, y, z])))
  .filter(([x, y, z]) => x || y || z)
  .map((direction) => direction.map((value) => value / Math.hypot(...direction)));

/**
 * What a viewer far away along `direction` sees of some meshes: the depth of the nearest surface through each
 * pixel of a `size` x `size` picture that frames `bounds` (parallel rays, one through each pixel's centre).
 * @param {Array<{positions: ArrayLike<number>, indices: ArrayLike<number>}>} meshes
 * @param {number[]} direction unit [x, y, z], the way the rays travel
 * @param {{centre: number[], radius: number}} bounds a ball round everything drawn
 * @param {number} size pixels along a side
 * @returns {Float64Array} depth per pixel, Infinity where nothing is hit
 */
const depthsAlong = (meshes, direction, bounds, size) => {
  const [dx, dy, dz] = direction;
  // Two axes square to the rays.
  const seed = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const across = [dy * seed[2] - dz * seed[1], dz * seed[0] - dx * seed[2], dx * seed[1] - dy * seed[0]];
  const acrossLength = Math.hypot(...across);
  const [ux, uy, uz] = across.map((value) => value / acrossLength);
  const [vx, vy, vz] = [dy * uz - dz * uy, dz * ux - dx * uz, dx * uy - dy * ux];
  const scale = size / (2 * bounds.radius);
  const depths = new Float64Array(size * size).fill(Infinity);
  const corner = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  meshes.forEach(({ positions, indices }) => {
    for (let face = 0; face < indices.length; face += VECTOR) {
      for (let index = 0; index < VECTOR; index++) {
        const at = indices[face + index] * VECTOR;
        const [x, y, z] = [positions[at] - bounds.centre[0], positions[at + 1] - bounds.centre[1], positions[at + 2] - bounds.centre[2]];
        corner[index * VECTOR] = (x * ux + y * uy + z * uz + bounds.radius) * scale;
        corner[index * VECTOR + 1] = (x * vx + y * vy + z * vz + bounds.radius) * scale;
        corner[index * VECTOR + 2] = x * dx + y * dy + z * dz;
      }
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = corner;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const fromX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const toX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
      const fromY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const toY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let pixelY = fromY; pixelY <= toY; pixelY++) {
        for (let pixelX = fromX; pixelX <= toX; pixelX++) {
          const [x, y] = [pixelX + 0.5, pixelY + 0.5];
          const shareB = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area;
          const shareC = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
          if (shareB < 0 || shareC < 0 || shareB + shareC > 1) continue;
          const depth = az + (bz - az) * shareB + (cz - az) * shareC;
          if (depth < depths[pixelX + size * pixelY]) depths[pixelX + size * pixelY] = depth;
        }
      }
    }
  });
  return depths;
};

/** A ball round every vertex of some meshes. */
const boundsOf = (meshes) => {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  meshes.forEach(({ positions }) => {
    for (let at = 0; at < positions.length; at++) {
      low[at % VECTOR] = Math.min(low[at % VECTOR], positions[at]);
      high[at % VECTOR] = Math.max(high[at % VECTOR], positions[at]);
    }
  });
  return { centre: low.map((value, axis) => (value + high[axis]) / 2), radius: Math.hypot(...high.map((value, axis) => value - low[axis])) / 2 };
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

  test('sculpt: every species of both catalogues sculpts to closed skins and non-empty layers that replace the pieces they were made from', () => {
    assert.strictEqual(catalogs.length, 2, 'both catalogues are loaded');
    catalogs.forEach(({ name, catalog }) => {
      const bakery = catalog.bakery({ capacity: 4 });
      catalog.speciesIds().forEach((species) => {
        const where = `${name}/${species}`;
        const bake = bakery.bakeRecipe({ species, seed: 1 });
        const layout = figure.layout(bake, { level: 'low' });
        const sculpted = figure.sculptLayers(bake, layout);
        // What a garment hides of a skin is not meshed, so a skin is closed only when it is sculpted whole.
        const whole = figure.sculptLayers(bake, layout, { cull: false });
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
          if (layer.id.startsWith('skin:') || layer.id.startsWith('worn:')) {
            const closed = whole.layers.find((other) => other.id === layer.id);
            assert.deepStrictEqual(edgesOf(closed), { open: 0, pinched: 0 }, `${where} ${layer.id}: closed, every edge shared by exactly two triangles`);
            assert.ok(sixVolumes(closed) > 0, `${where} ${layer.id}: wound outward`);
          }
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

  test('sculpt: worn objects follow their data: a skirt is draped on the legs and hangs as authored at rest, a hat is a solid on its own bone, a sword stays rigid', () => {
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
    assert.ok(skirt.owners.every((owner, slot) => skirt.weights[slot] === 0 || (plan.roles[owner] & legMask) !== 0), 'every owner of the skirt is a leg bone');
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
    let worstAtRest = 0;
    let worstUnmoved = 0;
    for (let vertex = 0; vertex < skirt.positions.length / 3; vertex++) {
      worstAtRest = Math.max(worstAtRest, Math.abs(authored.distance(...moved(rest, skirt, vertex))));
      worstUnmoved = Math.max(worstUnmoved, Math.abs(authored.distance(skirt.positions[vertex * 3], skirt.positions[vertex * 3 + 1], skirt.positions[vertex * 3 + 2])));
    }
    assert.ok(worstAtRest < 0.012, `at rest the skirt hangs as authored (thickened to the grid): off by ${worstAtRest}`);
    assert.ok(worstUnmoved > worstAtRest * 2, `the control: in the sculpting pose it is spread with the legs (${worstUnmoved})`);
    // A held thing has no wear: it is the rigid piece it was.
    const armed = catalog.bakery({ capacity: 4 }).bakeRecipe(editor.setSocket({ species, seed: 1 }, 'handRight', 'shortBlade'));
    const armedLayout = figure.layout(armed, { level: 'medium' });
    const blade = armedLayout.pieces.find((candidate) => armed.plan.boneNames[candidate.bone] === 'handRight/blade');
    const withBlade = figure.sculptLayers(armed, armedLayout);
    assert.ok(blade && !withBlade.replaced.has(blade.id));
    // It is drawn in the one surface all the same, as it is: every triangle its shape was built with, moved by its bone alone.
    assert.ok(withBlade.joined.has(blade.id), 'the blade rides in the surface');
    const run = withBlade.surface.ranges.find((range) => range.id === `piece:${blade.id}`);
    assert.strictEqual(run.indexCount, figure.buildShape(blade.shape, armedLayout.level).indices.length, 'none of its triangles is simplified away');
    for (let vertex = run.vertexStart; vertex < run.vertexStart + run.vertexCount; vertex++) {
      if (withBlade.surface.owners[vertex * OWNERS] !== blade.bone || withBlade.surface.weights[vertex * OWNERS] !== 1) assert.fail(`vertex ${vertex} of the blade is not its bone's alone`);
    }
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

  // ---- cost: fewer triangles, hidden surface, one mesh, a level by size ----

  /** A bent arm: two capsules meeting at an elbow, each with its own owner, as one closed skin with weights. */
  const bentArm = (detail) => {
    const solids = [capsule([0, 0, 0], [0.3, 0, 0], 0.05, { owner: 0, blend: 0.03 }), capsule([0.3, 0, 0], [0.5, 0.2, 0], 0.045, { owner: 1, blend: 0.03 })];
    const mesh = sculpt.surface(sculpt.sample(solids, { detail }));
    return { ...mesh, ...sculpt.weights(mesh.positions, solids) };
  };
  /** The most of the ownership that changes along any edge of a skinned mesh (0: every edge within one owner's part). */
  const widestShareStep = ({ indices, owners, weights }) => {
    const step = (first, second) => {
      let common = 0;
      for (let slot = 0; slot < OWNERS; slot++) for (let other = 0; other < OWNERS; other++) if (owners[first * OWNERS + slot] === owners[second * OWNERS + other]) common += Math.min(weights[first * OWNERS + slot], weights[second * OWNERS + other]);
      return 1 - common;
    };
    let widest = 0;
    for (let face = 0; face < indices.length; face += VECTOR) for (let corner = 0; corner < VECTOR; corner++) widest = Math.max(widest, step(indices[face + corner], indices[face + ((corner + 1) % VECTOR)]));
    return widest;
  };

  test('sculpt: simplifying keeps a closed skin closed and wound outward, moves no vertex, and stays within its tolerance', () => {
    const arm = bentArm('medium');
    const tolerance = 0.0015;
    const light = sculpt.simplify(arm, { tolerance, skin: arm });
    assert.ok(light.indices.length < arm.indices.length * 0.6, `far fewer triangles: ${light.indices.length / VECTOR} of ${arm.indices.length / VECTOR}`);
    assert.deepStrictEqual(edgesOf(light), { open: 0, pinched: 0 }, 'closed, every edge shared by exactly two triangles');
    assert.deepStrictEqual(edgesOf(arm), { open: 0, pinched: 0 }, 'the control: it was closed to begin with');
    close(sixVolumes(light) / sixVolumes(arm), 1, 0.02, 'the same volume, wound the same way');
    assert.ok(light.error <= tolerance && light.distance <= light.error, `no collapse cost more than the tolerance: ${light.error}`);
    // Every kept vertex is one of the mesh's own, where it was, with its own normal.
    for (let vertex = 0; vertex < light.kept.length; vertex++) {
      for (let axis = 0; axis < VECTOR; axis++) {
        if (light.positions[vertex * VECTOR + axis] !== arm.positions[light.kept[vertex] * VECTOR + axis]) assert.fail(`vertex ${vertex} was moved`);
        if (light.normals[vertex * VECTOR + axis] !== arm.normals[light.kept[vertex] * VECTOR + axis]) assert.fail(`the normal of vertex ${vertex} was changed`);
      }
    }
    assert.ok(Array.from(light.kept).every((vertex, index, kept) => index === 0 || vertex > kept[index - 1]), 'kept vertices keep their order');
    // The control: no tolerance and no budget removes nothing that costs anything, a ball loses none of its roundness for free.
    const round = sculpt.surface(sculpt.sample([ball()], { detail: 'low' }));
    assert.ok(sculpt.simplify(round, { tolerance: 0 }).indices.length > round.indices.length * 0.9, 'a curved surface gives nothing up at no tolerance');
  });

  test('sculpt: simplified skin weights are the kept vertices own (each sums to 1), and a joint keeps the loops it bends on', () => {
    const arm = bentArm('medium');
    const light = sculpt.simplify(arm, { tolerance: 0.004, skin: arm });
    const weights = sculpt.pick(arm.weights, OWNERS, light.kept);
    const owners = sculpt.pick(arm.owners, OWNERS, light.kept);
    assert.strictEqual(weights.length, light.kept.length * OWNERS);
    for (let vertex = 0; vertex < light.kept.length; vertex++) {
      let sum = 0;
      for (let slot = 0; slot < OWNERS; slot++) sum += weights[vertex * OWNERS + slot];
      if (Math.abs(sum - 1) > 1e-5) assert.fail(`weights of vertex ${vertex} sum to ${sum}`);
    }
    const guarded = widestShareStep({ indices: light.indices, owners, weights });
    assert.ok(guarded <= sculpt.SIMPLIFY.mostShareStep + 1e-6, `no edge spans more than half a change of owner: ${guarded}`);
    // The control: simplified as a form alone, some edge runs from one bone's part straight into the other's.
    const blind = sculpt.simplify(arm, { tolerance: 0.004 });
    const unguarded = widestShareStep({ indices: blind.indices, owners: sculpt.pick(arm.owners, OWNERS, blind.kept), weights: sculpt.pick(arm.weights, OWNERS, blind.kept) });
    assert.ok(unguarded > sculpt.SIMPLIFY.mostShareStep, `without the skin an edge crosses the joint: ${unguarded}`);
  });

  test('sculpt: a triangle budget is met cheapest first; an open sheet keeps its edge; simplifying in steps gives the same mesh', () => {
    const round = sculpt.surface(sculpt.sample([ball()], { detail: 'medium' }));
    const few = sculpt.simplify(round, { most: 200 });
    assert.ok(few.indices.length / VECTOR <= 200 && few.indices.length / VECTOR > 150, `the budget is met and not overshot: ${few.indices.length / VECTOR}`);
    assert.deepStrictEqual(edgesOf(few), { open: 0, pinched: 0 });
    close(sixVolumes(few) / sixVolumes(round), 1, 0.08, 'still the ball');
    // A cap of the ball (an open sheet): its rim stays a circle at the cut's height.
    const field = sculpt.sample([ball()], { detail: 'medium' });
    const cap = sculpt.surface(field, { cut: (_x, y) => y > 0.05, walls: false });
    const lightCap = sculpt.simplify(cap, { tolerance: 0.003 });
    assert.ok(lightCap.indices.length < cap.indices.length * 0.7);
    const lowest = (mesh) => mesh.positions.reduce((least, value, index) => (index % VECTOR === 1 ? Math.min(least, value) : least), Infinity);
    close(lowest(lightCap), lowest(cap), 0.004, 'the rim is where it was');
    assert.strictEqual(edgesOf(lightCap).pinched, 0);
    const steps = sculpt.simplifySteps(round, { most: 200 });
    let step = steps.next();
    let pauses = 0;
    while (!step.done) {
      pauses++;
      step = steps.next();
    }
    assert.ok(pauses >= 2, 'the work can be paused');
    assert.deepStrictEqual(Array.from(step.value.indices), Array.from(few.indices));
  });

  test('sculpt: what a layer hides is not meshed, and nothing that can be seen from 26 directions is missing', () => {
    const { catalog } = catalogs[0];
    const bake = catalog.bakery({ capacity: 4 }).bakeRecipe({ species: catalog.speciesIds()[0], seed: 12 });
    // At medium: a garment must be several cells wide before anything under it is far enough from its hem to go.
    const layout = figure.layout(bake, { level: 'medium' });
    const whole = figure.sculptLayers(bake, layout, { cull: false, simplify: false });
    const culled = figure.sculptLayers(bake, layout, { simplify: false });
    const count = (sculpted) => sculpted.surface.indices.length / VECTOR;
    assert.ok(whole.layers.some((layer) => layer.id.startsWith('region:')), 'the control: the body wears something');
    assert.ok(count(culled) < count(whole) * 0.92, `hidden triangles are gone: ${count(culled)} of ${count(whole)}`);
    const bounds = boundsOf([whole.surface]);
    const SIZE = 72;
    DIRECTIONS.forEach((direction) => {
      const seen = depthsAlong([whole.surface], direction, bounds, SIZE);
      const left = depthsAlong([culled.surface], direction, bounds, SIZE);
      let missing = 0;
      for (let pixel = 0; pixel < seen.length; pixel++) if (seen[pixel] !== left[pixel]) missing++;
      assert.strictEqual(missing, 0, `from ${direction.map((value) => value.toFixed(2))}: ${missing} pixels show something else`);
    });
    // The control: the same comparison does see a layer that is taken away.
    const without = whole.layers.filter((layer) => !layer.id.startsWith('region:'));
    const bare = depthsAlong(without, DIRECTIONS[0], bounds, SIZE);
    const dressed = depthsAlong([whole.surface], DIRECTIONS[0], bounds, SIZE);
    assert.ok(bare.some((depth, pixel) => depth !== dressed[pixel]), 'a missing garment shows');
  });

  test('sculpt: the layers of a bake are one surface: each layer a run of it, painted per vertex, within the level budget', () => {
    const { catalog } = catalogs[0];
    const bake = catalog.bakery({ capacity: 4 }).bakeRecipe({ species: catalog.speciesIds()[0], seed: 12 });
    ['low', 'far'].forEach((level) => {
      const { surface, layers, bytes } = figure.sculptLayers(bake, figure.layout(bake, { level }));
      const vertexCount = surface.positions.length / VECTOR;
      assert.ok(surface.indices.length / VECTOR <= sculpt.DETAIL[level].triangles, `${level}: ${surface.indices.length / VECTOR} triangles`);
      assert.strictEqual(surface.paint.length, vertexCount * 3);
      assert.strictEqual(surface.ranges.reduce((sum, range) => sum + range.vertexCount, 0), vertexCount, 'the runs cover every vertex');
      assert.strictEqual(surface.ranges.reduce((sum, range) => sum + range.indexCount, 0), surface.indices.length, 'and every triangle');
      layers.forEach((layer) => {
        const range = surface.ranges.find((row) => row.id === layer.id);
        assert.strictEqual(layer.positions.buffer === surface.positions.buffer, true, 'a layer is a view of the surface, not a copy');
        assert.strictEqual(layer.indices.length, range.indexCount);
        for (let corner = 0; corner < range.indexCount; corner++) {
          const vertex = surface.indices[range.indexStart + corner];
          if (vertex - range.vertexStart !== layer.indices[corner]) assert.fail(`${level} ${layer.id}: triangle corner ${corner} names another vertex`);
          if (surface.paint[vertex * 3] !== layer.ramp || surface.paint[vertex * 3 + 1] !== layer.inkGroup) assert.fail(`${level} ${layer.id}: vertex ${vertex} is painted as another layer`);
        }
      });
      for (let slot = 0; slot < surface.weights.length; slot += OWNERS) {
        const sum = surface.weights[slot] + surface.weights[slot + 1] + surface.weights[slot + 2] + surface.weights[slot + 3];
        if (Math.abs(sum - 1) > 1e-4) assert.fail(`${level}: weights of vertex ${slot / OWNERS} sum to ${sum}`);
      }
      assert.ok(bytes > 0 && bytes < 400e3, `${level}: ${bytes} bytes`);
    });
  });

  test('sculpt: a dressed person is within the budget of every level: triangles, one skinned mesh, bytes', () => {
    const { SCULPT_BUDGETS, checkSculptBudgets } = require('./dev/budgets');
    const { catalog } = catalogs[0];
    const bakery = catalog.bakery({ capacity: 4 });
    assert.deepStrictEqual(Object.keys(SCULPT_BUDGETS).sort(), Object.keys(sculpt.DETAIL).sort(), 'every level has a budget');
    // Seeds 12 and 6: eight layers each; 6 wears a wide hat and a long coat, the dearest things in the wardrobe to mesh.
    [12, 6].forEach((seed) => {
      const bake = bakery.bakeRecipe({ species: catalog.speciesIds()[0], seed });
      Object.keys(SCULPT_BUDGETS).forEach((level) => {
        figure.sculptCache.clear();
        const { surface, bytes } = figure.sculptLayers(bake, figure.layout(bake, { level }));
        assert.deepStrictEqual(checkSculptBudgets(level, { triangles: surface.indices.length / VECTOR, meshes: 1, bytes }), [], `seed ${seed}`);
      });
    });
    figure.sculptCache.clear();
    // The control: the same person sculpted as before (nothing culled, nothing simplified) is far over.
    const bake = bakery.bakeRecipe({ species: catalog.speciesIds()[0], seed: 12 });
    const dense = figure.sculptLayers(bake, figure.layout(bake, { level: 'low' }), { cull: false, simplify: false });
    assert.ok(checkSculptBudgets('low', { triangles: dense.surface.indices.length / VECTOR, meshes: 1, bytes: dense.bytes }).length >= 2);
    figure.sculptCache.clear();
  });

  test('sculpt: kept bakes are bounded by bytes as well as by count, and what they take is known', () => {
    const { catalog } = catalogs[1];
    const editor = Kit.body.editor(catalog);
    const bakery = catalog.bakery({ capacity: 4 });
    const recipe = { species: catalog.speciesIds()[0], seed: 1 };
    const dial = editor.schema(recipe).dials.find((control) => control.affects.some((effect) => effect.channel === 'girth'));
    figure.sculptCache.clear();
    assert.strictEqual(figure.sculptCache.bytes(), 0);
    const made = [];
    for (let step = 0; step < figure.SCULPT.kept + 6; step++) {
      const bake = bakery.bakeRecipe(editor.setDial(recipe, dial.id, dial.min + ((dial.max - dial.min) * step) / (figure.SCULPT.kept + 6)));
      made.push(figure.sculptLayers(bake, figure.layout(bake, { level: 'far' })));
    }
    assert.ok(new Set(made.map((sculpted) => sculpted.signature)).size > figure.SCULPT.kept, 'the control: more distinct bakes than may be kept');
    assert.strictEqual(figure.sculptCache.size(), figure.SCULPT.kept, 'no more than the count');
    const held = made.slice(-figure.SCULPT.kept).reduce((sum, sculpted) => sum + sculpted.bytes, 0);
    assert.strictEqual(figure.sculptCache.bytes(), held, 'the bytes are those of the bakes kept, the oldest gone');
    assert.ok(figure.sculptCache.bytes() <= figure.SCULPT.keptBytes);
    assert.strictEqual(figure.sculptCache.has(made[0].signature), false);
    assert.strictEqual(figure.sculptCache.has(made[made.length - 1].signature), true);
    figure.sculptCache.clear();
    assert.strictEqual(figure.sculptCache.bytes(), 0);
  });

  test('figure detail: the level follows the height drawn, far included, and does not flicker at a band edge', () => {
    assert.deepStrictEqual([20, 64, 65, 150, 151, 330, 331, 2000].map((pixels) => figure.detailFor(pixels)), ['far', 'far', 'low', 'low', 'medium', 'medium', 'high', 'high']);
    assert.ok(figure.DETAIL_BANDS.every((row) => sculpt.DETAIL[row.level] && figure.LEVELS[row.level]), 'every band is a level of the shapes and of the sculpt');
    // A figure bobbing 6 pixels either side of an edge: without memory it changes level every time it crosses.
    const bob = Array.from({ length: 40 }, (_unused, frame) => 150 + 6 * Math.sin(frame));
    const changes = (levels) => levels.filter((level, index) => index > 0 && level !== levels[index - 1]).length;
    assert.ok(changes(bob.map((pixels) => figure.detailFor(pixels))) > 8, 'the control: the bare bands do flicker');
    let shown = figure.detailFor(bob[0]);
    const held = bob.map((pixels) => (shown = figure.detailFor(pixels, shown)));
    assert.strictEqual(changes(held), 0, 'with the level shown, it holds');
    // It does change once the height is clearly in another band, both ways, and can skip a band.
    assert.strictEqual(figure.detailFor(150 * (1 + figure.DETAIL_HYSTERESIS) + 1, 'low'), 'medium');
    assert.strictEqual(figure.detailFor(150 * (1 - figure.DETAIL_HYSTERESIS) - 1, 'medium'), 'low');
    assert.strictEqual(figure.detailFor(155, 'medium'), 'medium');
    assert.strictEqual(figure.detailFor(800, 'far'), 'high');
    assert.throws(() => figure.detailFor(100, 'tiny'), /no level "tiny"/);
  });

  test('figure detail: a height in pixels is measured on the target, so a pixel look counts its texels', () => {
    close(figure.pixelsTall({ height: 1.1, targetHeight: 180, viewHeight: 2.2 }), 90, 1e-9, 'an orthographic camera');
    close(figure.pixelsTall({ height: 1, targetHeight: 800, depth: 4, fieldOfView: Math.PI / 2 }), 100, 1e-9, 'a perspective camera');
    assert.strictEqual(figure.pixelsTall({ height: 1, targetHeight: 800, depth: 0, fieldOfView: 1 }), Infinity);
    // The same figure on the same screen: 720 pixels tall drawn directly, 180 texels in a pixel look of a quarter the rows.
    assert.strictEqual(figure.detailFor(figure.pixelsTall({ height: 1.1, targetHeight: 1440, viewHeight: 2.2 })), 'high');
    assert.strictEqual(figure.detailFor(figure.pixelsTall({ height: 1.1, targetHeight: 360, viewHeight: 2.2 })), 'medium');
  });
};
