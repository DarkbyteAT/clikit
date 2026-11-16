/**
 * Unit tests for cloth (kit/drape.js) and for how the sculpt lays draped garments on bodies (kit/figure-sculpt.js
 * `wornSteps`): what is under a cloth, how far it swings, thin shells, settling, shared skin weights, the order
 * garments are laid in, and that a garment's hang depends only on itself and the body under it. Loaded by
 * tools/test-kit.js after tools/test-sculpt.js, which has put the sculpt and the catalogues in the sandbox.
 *
 * Owns:  the cases, each beside a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), or pictures (the coverage sheets of tools/dev.js proof).
 */
'use strict';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const VECTOR = 3;
const OWNERS = 4;
const MATRIX = 16;
const TURN = Math.PI * 2;
/** Rays per ray allowed to see a skirt through the tails of a coat laid round it (a slit between two coarse vertices; without `Kit.drape.round` the skirt shows in broad patches). */
const MOST_GRAZING_ROUND = 50;
/** A layer shows through a drape when it is seen first within this many metres in front of it. */
const SHOWS_WITHIN = 0.08;

/** A flat panel in the plane z = `z`: `width` across x, hanging from y = 0 down to -`length`, `depth` thick, as a built shape (closed box). */
const panel = (width, length, depth, z) => {
  const [halfWidth, halfDepth] = [width / 2, depth / 2];
  const corners = [];
  for (const y of [0, -length]) for (const offset of [-halfDepth, halfDepth]) for (const x of [-halfWidth, halfWidth]) corners.push(x, y, z + offset);
  // Corners: 0..3 at the top (back-left, back-right, front-left, front-right), 4..7 at the bottom. Wound outward.
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { positions: Float32Array.from(corners), indices: Uint32Array.from(indices) };
};

/** Edges of a mesh walked a different number of times each way (holes) and more than once each way (pinches). */
const brokenEdges = ({ positions, indices }) => {
  const count = positions.length / VECTOR;
  const seen = new Map();
  for (let face = 0; face < indices.length; face += VECTOR)
    for (let corner = 0; corner < VECTOR; corner++) {
      const key = indices[face + corner] * count + indices[face + ((corner + 1) % VECTOR)];
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  let broken = 0;
  seen.forEach((times, key) => {
    const from = Math.floor(key / count);
    if (times !== 1 || seen.get((key - from * count) * count + from) !== 1) broken++;
  });
  return broken;
};

/** The area of a mesh. */
const areaOf = ({ positions, indices }) => {
  let sum = 0;
  for (let face = 0; face < indices.length; face += VECTOR) {
    const [a, b, c] = [indices[face] * VECTOR, indices[face + 1] * VECTOR, indices[face + 2] * VECTOR];
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const v = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
};

module.exports = ({ Kit, test, assert }) => {
  const { drape, sculpt, figure } = Kit;
  const ball = (radius, at = [0, 0, 0]) => sculpt.solid({ kind: 'sphere', radius, at }, IDENTITY, { owner: 0 });

  test('drape: what is under a cloth is the union of the solids, each grown by what is worn on it; its slope points out of it', () => {
    const under = drape.under([{ ...ball(0.2), lift: 0.01 }, ball(0.1, [0.5, 0, 0])]);
    assert.ok(Math.abs(under.distance(0, 0.3, 0) - 0.09) < 1e-6, 'the lifted ball is a centimetre nearer');
    assert.ok(Math.abs(under.distance(0.5, 0.15, 0) - 0.05) < 1e-6, 'the other ball is not lifted');
    const out = [0, 0, 0];
    assert.ok(Math.abs(under.slope(0, 0, -0.25, out) - 0.04) < 1e-6, 'a slope returns the distance too');
    assert.ok(Math.abs(out[2] + 1) < 1e-2 && Math.abs(out[0]) < 1e-2, `behind the ball the way out is back: ${out}`);
    assert.strictEqual(under.distance(5, 5, 5), drape.FAR, 'out of every solid\'s reach');
    under.slope(5, 5, 5, out);
    assert.deepStrictEqual(out, [0, 0, 0], 'and no way out is claimed there');
  });

  test('drape: a cloth already laid is a solid for the next, by its vertices', () => {
    const laid = drape.cloud([0, 0, 0, 0.02, 0, 0], 0.015);
    assert.ok(Math.abs(laid.distance(0.01, 0.05, 0) - (Math.hypot(0.01, 0.05) - 0.015)) < 1e-9);
    assert.ok(laid.distance(0.01, 0, 0) < 0, 'between two neighbouring vertices the balls overlap: no gap in the surface');
    assert.strictEqual(laid.distance(1, 1, 1), drape.FAR);
    assert.ok(laid.min[0] === -0.015 && Math.abs(laid.max[0] - 0.035) < 1e-12);
  });

  test('drape: a cloth hung all round a line is, for the next cloth, everything it encloses, not only its wall', () => {
    // A cone's wall as vertices: radius 0.1 at the top growing to 0.2 half a metre down, 48 round and 26 down.
    const points = [];
    for (let row = 0; row <= 25; row++) for (let turn = 0; turn < 48; turn++) points.push((0.1 + row * 0.004) * Math.cos((turn / 48) * TURN), 1 - row * 0.02, (0.1 + row * 0.004) * Math.sin((turn / 48) * TURN));
    const cone = drape.round(points, [0, 1, 0], [0, -1, 0], 0.02);
    assert.ok(cone.distance(0, 0.75, 0) < -0.1, `the middle of what it encloses is deep inside (${cone.distance(0, 0.75, 0)})`);
    assert.ok(Math.abs(cone.distance(0.15, 0.75, 0)) < 0.012, `its wall is its surface, to within a bin (${cone.distance(0.15, 0.75, 0)})`);
    assert.ok(Math.abs(cone.distance(0.25, 0.75, 0) - 0.1) < 0.012, 'outside it the distance is how far out');
    assert.ok(Math.abs(cone.distance(0, 0.4, 0) - 0.1) < 1e-6 && cone.distance(0, 1.1, 0) > 0.09, 'beyond its ends it is not there');
    [0, 1, 2].forEach((axis) => assert.ok(cone.min[axis] <= Math.min(...points.filter((_value, at) => at % VECTOR === axis)) && cone.max[axis] >= Math.max(...points.filter((_value, at) => at % VECTOR === axis)), 'its bounds hold it'));
    // Control: the same vertices as a cloud are a hollow wall; the middle is outside it.
    assert.strictEqual(drape.cloud(points, 0.015).distance(0, 0.75, 0), drape.FAR, 'control: a cloud of the wall encloses nothing');
  });

  test('drape: a thing worn over cloth is moved out until no cloth is in front of it, and not at all when none is', () => {
    // A sheet of cloth 5 cm behind a pack's back face, as a cloud; the pack's corners at z = -0.1.
    const sheet = [];
    for (let row = -10; row <= 10; row++) for (let column = -10; column <= 10; column++) sheet.push(column * 0.02, row * 0.02, -0.15);
    const cloth = drape.under([drape.cloud(sheet, 0.015)]);
    const corners = [-0.1, -0.1, -0.1, 0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1, 0.1, -0.1];
    const shift = drape.seat(corners, [0, 0, -1], cloth);
    assert.ok(shift > 0.05 && shift < 0.075, `out past the sheet and its thickness, and no further than a step more (${shift})`);
    assert.ok(corners.every((_value, at) => at % VECTOR !== 2 || cloth.distance(corners[at - 2], corners[at - 1], corners[at] - shift) >= 0), 'it is out of the cloth there');
    assert.strictEqual(drape.seat(corners, [0, 0, 1], cloth), 0, 'no cloth in front of it the other way: it stays');
    assert.strictEqual(drape.seat([1, 1, -0.1], [0, 0, -1], cloth), 0, 'nor beside the sheet');
    assert.strictEqual(drape.seat(corners, [0, 0, -1], cloth, { mostSeat: 0.02 }), 0.02, 'never further than allowed');
  });

  test('drape: a hanging panel swings out just far enough to rest on the body, and not at all when nothing is in its way', () => {
    // A ball of 20 cm at the origin; a panel hung from a point above and just behind its middle passes through it.
    const under = drape.under([ball(0.2)]);
    const hanging = drape.shell(panel(0.3, 0.6, 0.01, -0.1), 0.04);
    const joint = [0, 0.3, -0.1];
    for (let at = 1; at < hanging.positions.length; at += VECTOR) hanging.positions[at] += 0.3;
    const axis = drape.swingAxis([0, -1, 0], [0, 0, -1]);
    assert.strictEqual(axis.map((value) => Math.round(value)).join(), '1,0,0', 'it swings about the line across the back');
    const angle = drape.hangAngle(hanging.positions, joint, axis, under, 0.01);
    // Straight down it is 10 cm from the centre of a 20 cm ball: 10 cm deep. It must swing out to within `restDepth` of clear.
    assert.ok(angle > 0.15 && angle < 0.6, `it swings out, and no further than it must: ${angle}`);
    const swung = drape.turnAbout(Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.1, 1]), 0, 1, joint, axis, angle);
    // The bone's own point (0, 0, -0.1) is 0.3 below the joint: it has swung back, away from the ball.
    assert.ok(swung[14] < -0.14, `turnAbout carries the bone with it: z ${swung[14]}`);
    let deepest = 0;
    const turned = (x, y, z) => [x, joint[1] + (y - joint[1]) * Math.cos(angle) - (z - joint[2]) * Math.sin(angle), joint[2] + (y - joint[1]) * Math.sin(angle) + (z - joint[2]) * Math.cos(angle)];
    // Asked of the points a swing can clear: those beyond `swingFrom` of the way from the joint to the far corners.
    const reach = Math.hypot(0.15, 0.6) * drape.DRAPE.swingFrom;
    for (let at = 0; at < hanging.positions.length; at += VECTOR) {
      const point = [hanging.positions[at], hanging.positions[at + 1], hanging.positions[at + 2]];
      if (Math.hypot(point[0] - joint[0], point[1] - joint[1], point[2] - joint[2]) >= reach) deepest = Math.max(deepest, 0.01 - under.distance(...turned(...point)));
    }
    assert.ok(deepest <= drape.DRAPE.restDepth + 0.02, `what is left buried is about what settling lays over the body: ${deepest}`);
    assert.ok(deepest > 0.005, `and it has not swung clear of the body altogether: ${deepest}`);
    assert.strictEqual(drape.hangAngle(hanging.positions, joint, axis, drape.under([ball(0.05)]), 0.01), 0, 'the control: a small ball is not in its way');
    assert.strictEqual(drape.swingAxis([0, -1, 0], [0, -2, 0]), null, 'a piece that hangs straight away from the body has nothing to swing about');
  });

  test('drape: a shell is the built shape welded, closed, as thin as authored, with no edge longer than asked', () => {
    const built = panel(0.4, 0.5, 0.012, 0);
    // A built shape repeats vertices along hard edges: here every triangle gets its own three.
    const split = { positions: Float32Array.from(Array.from(built.indices).flatMap((index) => Array.from(built.positions.subarray(index * 3, index * 3 + 3)))), indices: Uint32Array.from(built.indices, (_index, corner) => corner) };
    [0.2, 0.06, 0.03].forEach((edge) => {
      const cloth = drape.shell(split, edge);
      assert.strictEqual(brokenEdges(cloth), 0, `closed, every edge shared by two triangles, at ${edge}`);
      let longest = 0;
      for (let face = 0; face < cloth.indices.length; face += VECTOR)
        for (let corner = 0; corner < VECTOR; corner++) {
          const [a, b] = [cloth.indices[face + corner] * VECTOR, cloth.indices[face + ((corner + 1) % VECTOR)] * VECTOR];
          longest = Math.max(longest, Math.hypot(cloth.positions[a] - cloth.positions[b], cloth.positions[a + 1] - cloth.positions[b + 1], cloth.positions[a + 2] - cloth.positions[b + 2]));
        }
      assert.ok(longest <= edge + 1e-6, `no edge longer than ${edge}: ${longest}`);
      assert.ok(Math.abs(areaOf(cloth) - areaOf(built)) < 1e-6, 'splitting adds no area');
      assert.ok(cloth.positions.every((value, index) => index % VECTOR !== 2 || Math.abs(value) <= 0.006 + 1e-6), 'every vertex is within the authored thickness: exactly as thin as authored');
    });
    assert.ok(drape.shell(split, 0.03).indices.length > drape.shell(split, 0.06).indices.length * 2, 'a finer edge is a finer mesh');
    assert.strictEqual(drape.shell(split, 1).positions.length / VECTOR, 8, 'welded: a box has eight corners');
    assert.throws(() => drape.shell(split, 0), /edge length must be positive/);
  });

  test('drape: settling lays a sheet over what pushes through it, keeps its thickness there, hands the push on down the hang, and leaves the rest as authored', () => {
    // A ball pushes 4 cm through a panel 1.2 cm thick that hangs just behind its middle.
    const under = drape.under([ball(0.1, [0, -0.2, 0])]);
    const mesh = drape.shell(panel(0.5, 0.8, 0.012, -0.06), 0.025);
    mesh.normals = drape.smoothNormals(mesh.positions, mesh.indices);
    const authored = Float32Array.from(mesh.positions);
    const options = { gap: 0.004, thickness: 0.012, hang: { joint: [0, 0, -0.06], along: [0, -1, 0], outward: [0, 0, -1] } };
    const moved = drape.settle(mesh, under, options);
    assert.ok(moved > 0);
    let [nearest, furthestOnBall, sideways, lowestMove, upperMove] = [Infinity, 0, 0, 0, 0];
    for (let at = 0; at < mesh.positions.length; at += VECTOR) {
      const away = under.distance(mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]);
      nearest = Math.min(nearest, away);
      const move = Math.hypot(mesh.positions[at] - authored[at], mesh.positions[at + 1] - authored[at + 1], mesh.positions[at + 2] - authored[at + 2]);
      // Over the ball's middle: the two sides lie `gap` and `gap + thickness` off it.
      if (Math.abs(authored[at]) < 0.02 && Math.abs(authored[at + 1] + 0.2) < 0.02) furthestOnBall = Math.max(furthestOnBall, away);
      sideways = Math.max(sideways, Math.abs(mesh.positions[at + 1] - authored[at + 1]));
      if (authored[at + 1] < -0.75 && Math.abs(authored[at]) < 0.03) lowestMove = Math.max(lowestMove, move);
      if (authored[at + 1] > -0.05) upperMove = Math.max(upperMove, move);
    }
    assert.ok(nearest >= 0.004 - 1e-4, `nothing is left nearer than the gap: ${nearest}`);
    assert.ok(Math.abs(furthestOnBall - 0.016) < 0.003, `the seen side lies gap + thickness off the ball: ${furthestOnBall}`);
    assert.ok(sideways < 1e-6, 'a hanging cloth is pushed across its hang, never along it');
    assert.strictEqual(upperMove, 0, 'above the ball, where nothing is in its way, it is exactly as authored');
    assert.ok(lowestMove > 0.004 && lowestMove < 0.05, `below the ball it still stands out, less and less: ${lowestMove}`);
    assert.ok(mesh.normals.every(Number.isFinite));
    // The control: with nothing under it, nothing moves.
    const free = { ...drape.shell(panel(0.5, 0.8, 0.012, -0.06), 0.025) };
    free.normals = drape.smoothNormals(free.positions, free.indices);
    assert.strictEqual(drape.settle(free, drape.under([ball(0.02, [0, -0.2, 0.3])]), options), 0);
    assert.deepStrictEqual(Array.from(free.positions), Array.from(authored));
  });

  test('drape: cloth on the body is carried by the body, cloth hanging free rides its own bone, and the shares sum to 1', () => {
    const positions = Float32Array.from([0, 0, 0.105, 0, 0, 0.14, 0, 0, 0.4]);
    const skin = { owners: Uint16Array.from([1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 3, 4]), weights: Float32Array.from([0.75, 0.25, 0, 0, 0.75, 0.25, 0, 0, 0.4, 0.3, 0.2, 0.1]) };
    drape.ride(skin, positions, 9, ball(0.1).distance, { contact: 0.006, clings: 0.06 });
    assert.deepStrictEqual(Array.from(skin.weights.subarray(0, 4)), [0.75, 0.25, 0, 0], 'in contact: the body alone');
    assert.strictEqual(skin.owners[7], 9, 'further out the own bone takes the last slot');
    assert.ok(skin.weights[7] > 0.3 && skin.weights[7] < 0.9 && Math.abs(skin.weights[4] / skin.weights[5] - 3) < 1e-5, `and the body's bones keep their proportions: ${Array.from(skin.weights.subarray(4, 8))}`);
    assert.deepStrictEqual([skin.owners[11], skin.weights[11], skin.weights[8]], [9, 1, 0], 'hanging free: the own bone alone');
    for (let vertex = 0; vertex < 3; vertex++) assert.ok(Math.abs(skin.weights.subarray(vertex * 4, vertex * 4 + 4).reduce((sum, share) => sum + share, 0) - 1) < 1e-6);
  });

  // ---- garments on bodies -------------------------------------------------------------------------------------------------

  const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const editor = Kit.body.editor(catalog);
  const wearing = (species, sockets) => Object.keys(sockets).reduce((recipe, path) => editor.setSocket(recipe, path, sockets[path]), { species, seed: 1 });
  const bakery = catalog.bakery({ capacity: 16 });
  /** A recipe sculpted at a level, with its rest matrices. */
  const sculptedOf = (recipe, level, options) => {
    const bake = bakery.bakeRecipe(recipe);
    const layout = figure.layout(bake, { level });
    return { bake, layout, sculpted: figure.sculptLayers(bake, layout, options), rest: figure.restMatrices(bake) };
  };
  /** A layer's vertices skinned from the pose it was made in to another (bone matrices, 16 per bone). */
  const skinnedTo = (layer, bind, to) => {
    const inverses = Array.from({ length: bind.length / MATRIX }, (_unused, bone) => sculpt.invertAffine(bind.subarray(bone * MATRIX, bone * MATRIX + MATRIX)));
    const out = new Float32Array(layer.positions.length);
    for (let vertex = 0; vertex < out.length / VECTOR; vertex++) {
      const [x, y, z] = [layer.positions[vertex * 3], layer.positions[vertex * 3 + 1], layer.positions[vertex * 3 + 2]];
      for (let slot = 0; slot < OWNERS; slot++) {
        const share = layer.weights[vertex * OWNERS + slot];
        if (!share) continue;
        const owner = layer.owners[vertex * OWNERS + slot];
        const back = inverses[owner];
        const local = [back[0] * x + back[1] * y + back[2] * z + back[3], back[4] * x + back[5] * y + back[6] * z + back[7], back[8] * x + back[9] * y + back[10] * z + back[11]];
        for (let axis = 0; axis < VECTOR; axis++) out[vertex * 3 + axis] += share * (to[owner * MATRIX + axis] * local[0] + to[owner * MATRIX + 4 + axis] * local[1] + to[owner * MATRIX + 8 + axis] * local[2] + to[owner * MATRIX + 12 + axis]);
      }
    }
    return out;
  };
  /** The body's own solids placed by bone matrices: what cloth lies on. */
  const bodySolids = ({ layout }, matrices) =>
    layout.pieces.filter((piece) => !piece.isProp && !piece.stamps && !piece.shell && piece.tone === undefined && sculpt.KINDS[piece.shape.kind]).map((piece) => sculpt.solid(piece.shape, matrices.subarray(piece.bone * MATRIX, piece.bone * MATRIX + MATRIX), { owner: piece.bone }));
  /** The lowest, widest and rearmost reach of a layer's vertices at rest: [lowest y, widest |x|, rearmost z]. */
  const reachOf = (layer, { sculpted, rest }) => {
    const at = skinnedTo(layer, sculpted.matrices, rest);
    const reach = [Infinity, 0, Infinity];
    for (let offset = 0; offset < at.length; offset += VECTOR) {
      reach[0] = Math.min(reach[0], at[offset + 1]);
      reach[1] = Math.max(reach[1], Math.abs(at[offset]));
      reach[2] = Math.min(reach[2], at[offset + 2]);
    }
    return reach.map((value) => Number(value.toFixed(5)));
  };
  const wornLayer = (made, socket) => made.sculpted.layers.find((layer) => layer.id.startsWith(`worn:${socket}|`));

  /** Rays per row and column of the frame a figure is looked at through, from each direction. */
  const RAY_GRID = [13, 27];
  /** One ray in this many may show something laid under a drape (a graze along its rim at the coarsest level of detail). */
  const MOST_GRAZING = 200;
  /** How strictly a hit counts as the seen side of a cloth: the cosine between its face and the way out of the body. */
  const SEEN_SIDE = 0.3;

  /**
   * Looks at a sculpted figure at rest along level rays from eight directions and counts the rays on which a
   * drape's seen side (a face turned to the eye and out of the body) is not the first thing hit: something laid
   * under it shows through there. Arms and what is worn on them are left out: they hang beside a cloak, not under it.
   * @returns {{covering: number, shownThrough: number, worst: string}}
   */
  const lookAt = (made) => {
    const { bake, sculpted, rest } = made;
    const armMask = Kit.body.roleMask(['arm']) | Kit.body.roleMask(['hand']);
    const under = drape.under(bodySolids(made, rest));
    let drapeRank = 0;
    const layers = sculpted.layers
      .map((layer) => ({ layer, positions: skinnedTo(layer, sculpted.matrices, rest), rank: layer.id.endsWith('|drape') ? ++drapeRank : layer.id.startsWith('worn:') ? Infinity : 0 }))
      .map((entry) => ({ ...entry, isDrape: entry.rank > 0 && entry.rank < Infinity }));
    const triangles = [];
    layers.forEach((entry, index) => {
      const { layer, positions } = entry;
      for (let face = 0; face < layer.indices.length; face += VECTOR) {
        const corners = [layer.indices[face], layer.indices[face + 1], layer.indices[face + 2]];
        if (corners.every((vertex) => (bake.plan.roles[layer.owners[vertex * OWNERS]] & armMask) !== 0)) continue;
        triangles.push({ index, a: corners[0] * 3, b: corners[1] * 3, c: corners[2] * 3, positions });
      }
    });
    const bounds = { low: [Infinity, Infinity, Infinity], high: [-Infinity, -Infinity, -Infinity] };
    layers.forEach(({ positions }) => positions.forEach((value, index) => {
      bounds.low[index % 3] = Math.min(bounds.low[index % 3], value);
      bounds.high[index % 3] = Math.max(bounds.high[index % 3], value);
    }));
    const radius = Math.max(bounds.high[0] - bounds.low[0], bounds.high[2] - bounds.low[2]);
    const slope = [0, 0, 0];
    const result = { covering: 0, shownThrough: 0, worst: '' };
    for (let view = 0; view < 8; view++) {
      const yaw = (view / 8) * TURN;
      // The eye looks along -`toEye`; `across` is to its right.
      const toEye = [Math.sin(yaw), 0, Math.cos(yaw)];
      const across = [Math.cos(yaw), 0, -Math.sin(yaw)];
      // Triangles turned to this eye, with their edges ready for the ray test (the ray's direction is the same for all).
      const facing = [];
      triangles.forEach((triangle) => {
        const { positions, a, b, c } = triangle;
        const edge1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
        const edge2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
        const normal = [edge1[1] * edge2[2] - edge1[2] * edge2[1], edge1[2] * edge2[0] - edge1[0] * edge2[2], edge1[0] * edge2[1] - edge1[1] * edge2[0]];
        const turned = normal[0] * toEye[0] + normal[2] * toEye[2];
        if (turned > 0) facing.push({ triangle, edge1, edge2, normal, turned });
      });
      for (let column = 0; column < RAY_GRID[0]; column++) {
        for (let row = 0; row < RAY_GRID[1]; row++) {
          const side = ((column + 0.5) / RAY_GRID[0] - 0.5) * radius;
          const height = bounds.low[1] + ((row + 0.5) / RAY_GRID[1]) * (bounds.high[1] - bounds.low[1]);
          const origin = [across[0] * side + toEye[0] * 3, height, across[2] * side + toEye[2] * 3];
          let first = null;
          const firstOfDrape = new Map();
          facing.forEach(({ triangle, edge1, edge2, normal, turned }) => {
            const { positions, a } = triangle;
            // Where the ray origin - t x toEye meets the triangle's plane, and whether that is inside the triangle.
            const from = [origin[0] - positions[a], origin[1] - positions[a + 1], origin[2] - positions[a + 2]];
            const distance = (from[0] * normal[0] + from[1] * normal[1] + from[2] * normal[2]) / turned;
            const hit = [from[0] - toEye[0] * distance, from[1], from[2] - toEye[2] * distance];
            const d11 = edge1[0] * edge1[0] + edge1[1] * edge1[1] + edge1[2] * edge1[2];
            const d12 = edge1[0] * edge2[0] + edge1[1] * edge2[1] + edge1[2] * edge2[2];
            const d22 = edge2[0] * edge2[0] + edge2[1] * edge2[1] + edge2[2] * edge2[2];
            const h1 = hit[0] * edge1[0] + hit[1] * edge1[1] + hit[2] * edge1[2];
            const h2 = hit[0] * edge2[0] + hit[1] * edge2[1] + hit[2] * edge2[2];
            const scale = d11 * d22 - d12 * d12;
            const u = (d22 * h1 - d12 * h2) / scale;
            const v = (d11 * h2 - d12 * h1) / scale;
            if (!(u >= 0 && v >= 0 && u + v <= 1)) return;
            if (!first || distance < first.distance) first = { distance, index: triangle.index };
            const entry = layers[triangle.index];
            if (!entry.isDrape || (firstOfDrape.has(triangle.index) && firstOfDrape.get(triangle.index).distance <= distance)) return;
            firstOfDrape.set(triangle.index, { distance, normal, point: [hit[0] + positions[a], hit[1] + positions[a + 1], hit[2] + positions[a + 2]] });
          });
          firstOfDrape.forEach((seen, index) => {
            // Its seen side: turned out of the body as well as to the eye (the lining of a cloak faces the eye from the front).
            under.slope(seen.point[0], seen.point[1], seen.point[2], slope);
            const length = Math.hypot(...seen.normal);
            if ((seen.normal[0] * slope[0] + seen.normal[1] * slope[1] + seen.normal[2] * slope[2]) / length < SEEN_SIDE) return;
            result.covering += 1;
            if (layers[first.index].rank >= layers[index].rank || first.distance > seen.distance - 1e-6) return;
            // What stands well in front of the drape is another part of the figure passing before it (a skirt's side before a cloak's rim), not something coming through it.
            if (seen.distance - first.distance > SHOWS_WITHIN) return;
            result.shownThrough += 1;
            result.worst = result.worst || `${layers[first.index].layer.id} shows through ${layers[index].layer.id} from ${view * 45} degrees at height ${height.toFixed(2)}, ${side.toFixed(2)} across`;
          });
        }
      }
    }
    return result;
  };

  test('drape: garments are laid in their declared order: from eight directions, wherever a drape covers, nothing laid under it is seen first', () => {
    ['person', 'stout', 'lanky', 'hornkin'].forEach((species) => {
      const made = sculptedOf(wearing(species, { top: 'tee', bottom: 'skirt', outerwear: 'cloak' }), 'low');
      const drapes = made.sculpted.layers.filter((layer) => layer.id.endsWith('|drape')).map((layer) => layer.id.split('|')[0]);
      assert.strictEqual(drapes.join(), 'worn:bottom,worn:outerwear', `${species}: laid in rising rank, the skirt before the cloak over it`);
      const seen = lookAt(made);
      assert.ok(seen.covering > 150, `${species}: the drapes cover a good part of the figure (${seen.covering} rays)`);
      // At the coarsest level a ray may graze the rim where a skirt's waist comes out from under a top: one ray in 200 is allowed that.
      assert.ok(seen.shownThrough * MOST_GRAZING <= seen.covering, `${species}: ${seen.shownThrough} of ${seen.covering} rays: ${seen.worst}`);
    });
    // A coat's tails hang all round the hips, as the skirt under them does: they clear what the skirt encloses.
    ['person', 'stout', 'lanky', 'hornkin'].forEach((species) => {
      const seen = lookAt(sculptedOf(wearing(species, { top: 'tee', bottom: 'skirt', outerwear: 'longCoat' }), 'low'));
      assert.ok(seen.covering > 150, `${species}: the tails cover the skirt (${seen.covering} rays)`);
      assert.ok(seen.shownThrough * MOST_GRAZING_ROUND <= seen.covering, `${species} in a long coat: ${seen.shownThrough} of ${seen.covering} rays: ${seen.worst}`);
    });
    // The control: the same cloak left where it was authored hangs inside a stout body and its top, and they show through it.
    const { hangAngle, settle } = drape;
    Object.assign(drape, { hangAngle: () => 0, settle: () => 0 });
    figure.sculptCache.clear();
    try {
      const unlaid = lookAt(sculptedOf(wearing('stout', { top: 'tee', bottom: 'skirt', outerwear: 'cloak' }), 'low'));
      assert.ok(unlaid.shownThrough > 10, `as authored the body shows through (${unlaid.shownThrough} rays)`);
    } finally {
      Object.assign(drape, { hangAngle, settle });
      figure.sculptCache.clear();
    }
  });

  test('drape: how a garment hangs depends on its own dials and the body under it: an unrelated dial changes nothing, a height scales it once', () => {
    const outfit = { top: 'tee', bottom: 'skirt', outerwear: 'cloak' };
    const base = wearing('person', outfit);
    const dialled = (id, pick) => {
      const dial = editor.schema(base).dials.find((candidate) => candidate.id === id);
      return editor.setDial(base, id, dial[pick]);
    };
    // The order matters: a short figure is sculpted first, as on an extremes sheet, and must not lend its cloth to the rest.
    figure.sculptCache.clear();
    const short = sculptedOf(dialled('height', 'min'), 'low');
    const plain = sculptedOf(base, 'low');
    const nosed = sculptedOf(dialled('noseSize', 'max'), 'low');
    const eyed = sculptedOf(dialled('eyeTilt', 'max'), 'low');
    assert.notStrictEqual(short.sculpted.signature, plain.sculpted.signature, 'a height is part of what a sculpt depends on');
    ['bottom', 'outerwear'].forEach((socket) => {
      const reach = reachOf(wornLayer(plain, socket), plain);
      assert.deepStrictEqual(reachOf(wornLayer(nosed, socket), nosed), reach, `${socket}: a nose dial does not change it`);
      assert.deepStrictEqual(reachOf(wornLayer(eyed, socket), eyed), reach, `${socket}: an eye dial does not change it`);
      assert.notDeepStrictEqual(reachOf(wornLayer(short, socket), short), reach, `${socket}: the control, a height does`);
    });
    // A worn part is sized by the body it hangs on, once: its own root bone is not the body's root.
    const ratio = short.bake.rest.uniform[0] / plain.bake.rest.uniform[0];
    assert.ok(ratio < 0.9, `the short figure is shorter (${ratio})`);
    ['bottom/skirt', 'outerwear/cloak'].forEach((name) => assert.strictEqual(short.bake.rest.uniform[short.bake.plan.boneIndex(name)], 1, `${name} is not sized again by the height dial`));
    const widths = [reachOf(wornLayer(short, 'bottom'), short)[1], reachOf(wornLayer(plain, 'bottom'), plain)[1]];
    assert.ok(Math.abs(widths[0] / widths[1] - ratio) < 0.06, `a skirt on a body ${ratio.toFixed(2)} as tall is about that much narrower, not that squared: ${(widths[0] / widths[1]).toFixed(3)}`);
  });

  test('drape: thin cloth is a thin shell at every level of detail, never a rigid board, and is carried by its own bone where it hangs free', () => {
    ['high', 'medium', 'low', 'far'].forEach((level) => {
      const made = sculptedOf(wearing('person', { top: 'tee', bottom: 'trousers', outerwear: 'cloak' }), level);
      const { plan } = made.bake;
      const bone = plan.boneIndex('outerwear/cloak');
      const piece = made.layout.pieces.find((candidate) => candidate.bone === bone);
      const cloak = wornLayer(made, 'outerwear');
      assert.ok(cloak && made.sculpted.replaced.has(piece.id), `${level}: the cloak is sculpted cloth, not the rigid piece`);
      assert.strictEqual(brokenEdges(cloak), 0, `${level}: closed`);
      // Skinned to rest and measured against the authored panel swung with it: both faces lie within its own thickness of each other.
      const at = skinnedTo(cloak, made.sculpted.matrices, made.rest);
      let [lowest, highest, ownShare, hemShare, hemCount] = [Infinity, -Infinity, 0, 0, 0];
      for (let offset = 1; offset < at.length; offset += VECTOR) [lowest, highest] = [Math.min(lowest, at[offset]), Math.max(highest, at[offset])];
      for (let vertex = 0; vertex < at.length / VECTOR; vertex++) {
        let own = 0;
        for (let slot = 0; slot < OWNERS; slot++) if (cloak.owners[vertex * OWNERS + slot] === bone) own += cloak.weights[vertex * OWNERS + slot];
        ownShare += own;
        if (at[vertex * 3 + 1] < lowest + (highest - lowest) * 0.25) [hemShare, hemCount] = [hemShare + own, hemCount + 1];
      }
      assert.ok(highest - lowest > 0.35, `${level}: it keeps its length (${(highest - lowest).toFixed(3)} m)`);
      // At far the whole cloak is a few dozen vertices and its lowest quarter takes in the row above the hem, which the back shares.
      const mostlyOwn = level === 'far' ? 0.8 : 0.9;
      assert.ok(hemShare / hemCount > mostlyOwn, `${level}: its hem rides its own bone (${(hemShare / hemCount).toFixed(2)}), which a movement may simulate`);
      assert.ok(ownShare / (at.length / VECTOR) < 0.999, `${level}: where it lies on the back the body carries it`);
      // Thin: the volume it encloses is that of a sheet about as thick as authored (1.9 cm), not of a slab a grid cell or two thick.
      let sixVolumes = 0;
      for (let face = 0; face < cloak.indices.length; face += VECTOR) {
        const [a, b, c] = [cloak.indices[face] * 3, cloak.indices[face + 1] * 3, cloak.indices[face + 2] * 3];
        sixVolumes += at[a] * (at[b + 1] * at[c + 2] - at[b + 2] * at[c + 1]) + at[a + 1] * (at[b + 2] * at[c] - at[b] * at[c + 2]) + at[a + 2] * (at[b] * at[c + 1] - at[b + 1] * at[c]);
      }
      const thickness = sixVolumes / 6 / (areaOf({ positions: at, indices: cloak.indices }) / 2);
      assert.ok(thickness > 0.008 && thickness < 0.03, `${level}: about as thick as authored: ${thickness.toFixed(4)} m`);
    });
  });

  test('drape: hair sunk in the head is not drawn where the head hides it, but a plait that swings on its own bone is drawn whole', () => {
    // Dense: simplified, a budget spends elsewhere what the cut saves, and the count says nothing.
    const made = sculptedOf(wearing('person', { hair: 'hairBraids' }), 'medium', { simplify: false });
    const whole = sculptedOf(wearing('person', { hair: 'hairBraids' }), 'medium', { cull: false, simplify: false });
    const { plan } = made.bake;
    const hair = wornLayer(made, 'hair');
    assert.ok(hair.indices.length < wornLayer(whole, 'hair').indices.length * 0.85, `the sunk part is gone: ${hair.indices.length / VECTOR} of ${wornLayer(whole, 'hair').indices.length / VECTOR} triangles`);
    const swings = (bone) => {
      for (let at = bone; at > 0; at = plan.parent[at]) if (plan.stiffness[at] < Kit.body.PHYSICAL_DEFAULTS.stiffness) return true;
      return false;
    };
    const count = hair.positions.length / VECTOR;
    const seen = new Map();
    for (let face = 0; face < hair.indices.length; face += VECTOR)
      for (let corner = 0; corner < VECTOR; corner++) {
        const [from, to] = [hair.indices[face + corner], hair.indices[face + ((corner + 1) % VECTOR)]];
        const key = Math.min(from, to) * count + Math.max(from, to);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    let [open, openOnPlait, plaitVertices] = [0, 0, 0];
    for (let vertex = 0; vertex < count; vertex++) if (swings(hair.owners[vertex * OWNERS])) plaitVertices++;
    seen.forEach((times, key) => {
      if (times !== 1) return;
      open++;
      if (swings(hair.owners[Math.floor(key / count) * OWNERS]) && swings(hair.owners[(key % count) * OWNERS])) openOnPlait++;
    });
    assert.ok(plaitVertices > 20, `the control: part of the hair swings (${plaitVertices} vertices)`);
    assert.ok(open > 0, 'the control: the hair is open where it is sunk');
    assert.strictEqual(openOnPlait, 0, 'no hole in what swings out of the place it was made in');
  });

  test('drape: a lifted thigh pushes a skirt out instead of coming through it, and a swung cloak bone carries its cloak', () => {
    // With every vertex the grid made: the depths below are read at vertices, and a surface made lighter keeps a
    // subset of them, each where it was with the weights it had, so what holds here holds for it; but it has too
    // few to show how deep a rigid skirt would be run through (the control).
    const made = sculptedOf(wearing('person', { top: 'tee', bottom: 'longSkirt', outerwear: 'cloak' }), 'medium', { simplify: false });
    const { bake, sculpted } = made;
    const { plan } = bake;
    const skirt = wornLayer(made, 'bottom');
    /** The deepest any vertex of a layer lies inside the body in a pose, metres. */
    const deepestIn = (layer, pose) => {
      const matrices = figure.restMatrices(bake, pose);
      const body = drape.under(bodySolids(made, matrices), { reach: 0.05 });
      const at = skinnedTo(layer, sculpted.matrices, matrices);
      let deepest = 0;
      // The skirt's top is inside the hips by design (its cone's cap); what matters is the cloth below the seat.
      const seat = matrices[plan.boneIndex('thighLeft') * MATRIX + 13] - 0.03;
      for (let offset = 0; offset < at.length; offset += VECTOR) if (at[offset + 1] < seat) deepest = Math.max(deepest, -body.distance(at[offset], at[offset + 1], at[offset + 2]));
      return deepest;
    };
    const lifted = Kit.rig.copy(bake.rest, Kit.body.createPose(plan));
    Kit.rig.turn(lifted.rotation, lifted.rotation, plan.boneIndex('thighLeft'), 0, -1.1);
    const knee = (pose) => figure.restMatrices(bake, pose)[plan.boneIndex('shinLeft') * MATRIX + 14];
    assert.ok(Math.abs(knee(lifted) - knee(bake.rest)) > 0.05, 'the control: the knee has moved a good way');
    assert.ok(deepestIn(skirt, bake.rest) < 0.004, `at rest the skirt is outside the legs (${deepestIn(skirt, bake.rest)})`);
    assert.ok(deepestIn(skirt, lifted) < 0.02, `with a thigh lifted 63 degrees the cloth stays on the leg's outside, within a grid cell: ${deepestIn(skirt, lifted)}`);
    // The control: the same cloth moved by the pelvis alone (a rigid skirt) is run through by the thigh.
    const rigid = { ...skirt, owners: skirt.owners.map(() => plan.boneIndex('pelvis')), weights: skirt.weights.map((_share, slot) => (slot % OWNERS === 0 ? 1 : 0)) };
    assert.ok(deepestIn(rigid, lifted) > 0.04, `a rigid skirt would be run through (${deepestIn(rigid, lifted)})`);
    // A cloak bone turned by a movement (a loose bone trailing in a dive): the hem goes with it.
    const cloakBone = plan.boneIndex('outerwear/cloak');
    const cloak = wornLayer(made, 'outerwear');
    const trailing = Kit.rig.copy(bake.rest, Kit.body.createPose(plan));
    Kit.rig.turn(trailing.rotation, trailing.rotation, cloakBone, 0, 1);
    const [still, flown] = [skinnedTo(cloak, sculpted.matrices, made.rest), skinnedTo(cloak, sculpted.matrices, figure.restMatrices(bake, trailing))];
    let [lowest, hem] = [Infinity, 0];
    for (let vertex = 0; vertex < still.length / VECTOR; vertex++) if (still[vertex * 3 + 1] < lowest) [lowest, hem] = [still[vertex * 3 + 1], vertex];
    const travelled = Math.hypot(flown[hem * 3] - still[hem * 3], flown[hem * 3 + 1] - still[hem * 3 + 1], flown[hem * 3 + 2] - still[hem * 3 + 2]);
    assert.ok(travelled > 0.3, `a radian's swing of the bone carries the hem ${travelled.toFixed(2)} m`);
  });
};
