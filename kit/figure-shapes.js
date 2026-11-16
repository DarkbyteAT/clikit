/**
 * Kit figure shapes: the surface of one bone, as plain arrays. Each body shape primitive (capsule, sphere, box,
 * lathe, extrude; kit/body-plan.js `SHAPES`) has one builder from the shape's data to positions, normals and
 * triangle indices in the bone's own space, at a chosen level of detail, plus a key that is equal exactly when
 * two shapes would build the same surface (so identical shapes share one geometry).
 *
 * Owns:  `Kit.figure.LEVELS` (segment counts per level of detail), `Kit.figure.ACROSS_AXIS` (the extrude
 *        convention), `describeShapes` (a bone of a plan -> its canonical shape descriptors), `shapeKey`,
 *        `buildShape` and the builders behind it (`BUILDERS`, including `stamps`: the flat polygons of a face),
 *        the three things any built solid may then have done to it (`scale`, `basis`, `inflate`),
 *        `smoothProfile`, `triangulate` (ear clipping for extrude and stamp outlines) and `writeBoneMatrix` (a
 *        bone's world transform as a column-major 4 x 4 matrix).
 * Does not own: the shape data (kit/body-plan.js and a catalogue's plans and parts), which bones get drawn and
 *        in what colour (kit/figure-layout.js), or anything THREE (kit/figure.js wraps these arrays in
 *        BufferGeometry).
 *
 * Conventions: the bone's own space of kit/body-plan.js (metres, +Y up, +Z forward, +X left). A shape lives
 * in that space, so the bone's three-axis scale (the dials) stretches it with no rebuild. Triangles wind
 * counter-clockwise seen from outside; normals are unit length and point out.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-figure.js.
 */
(() => {
  // ---- tunables -------------------------------------------------------------------------------------------------------

  /**
   * Segment counts by level of detail. A round surface gets `ceil(circumference / edge)` segments around,
   * clamped to [minAround, maxAround], so a head is smoother than a finger at the same level; a hemisphere or
   * a sphere's half gets a quarter of that in rings, at least `minRings`. Lengths are metres.
   *   high:   a figure a few hundred pixels tall (the creator, a close-up)
   *   medium: a figure on a game screen
   *   low:    the pixel look's low-resolution target, or a crowd
   */
  const LEVELS = Object.freeze({
    high: Object.freeze({ edge: 0.022, minAround: 8, maxAround: 32, minRings: 3, smoothSteps: 4 }),
    medium: Object.freeze({ edge: 0.045, minAround: 6, maxAround: 14, minRings: 2, smoothSteps: 2 }),
    low: Object.freeze({ edge: 0.09, minAround: 5, maxAround: 8, minRings: 1, smoothSteps: 1 }),
  });
  /** Floats per vertex of a stamp's paint (slot, tone, size rule, order) and of its centre (x, y, z, half extent). */
  const PAINT = 3;
  const CENTRE = 4;
  const DEFAULT_LEVEL = 'high';
  /** Rings of a sphere per segment around (a quarter turn of rings per quarter turn around). */
  const RINGS_PER_AROUND = 0.25;

  /**
   * The extrude convention: an outline's first coordinate ("across") lies along this axis of the bone, chosen
   * from the bone's long axis; the thickness lies along the third axis. A fish's tail fin (long axis z) stands
   * upright, and a sword along z is held edge-up with its flat to the sides. A shape may state `across` itself.
   */
  const ACROSS_AXIS = Object.freeze({ x: 'y', y: 'x', z: 'y' });
  const AXIS_NAMES = ['x', 'y', 'z'];
  /** Numbers in a shape key are rounded to this many decimals (a tenth of a millimetre), so float noise does not split the cache. */
  const KEY_DECIMALS = 4;
  /** Below this, a length is treated as zero (metres). */
  const EPSILON = 1e-9;
  const VECTOR = 3;
  const QUATERNION = 4;
  const TRIANGLE = 3;
  /** Two triangles per quad: corners 0 1 2 and 0 2 3 of four vertices added in order round the quad. */
  const QUAD_CORNERS = [0, 1, 2, 0, 2, 3];
  const FULL_TURN = Math.PI * 2;

  const fail = (where, message) => {
    throw new Error(`Kit.figure.${where}: ${message}`);
  };

  // ---- types ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} ShapeDescriptor
   * Everything that decides a bone's surface, in canonical form (no defaults left to fill in). Equal
   * descriptors build equal surfaces; `shapeKey` turns one into a cache key.
   * @property {('capsule'|'sphere'|'box'|'lathe'|'extrude')} kind
   * @property {number[]} [end] capsule: [x, y, z] of its far end in bone space (its start is the joint)
   * @property {number} [radius] capsule: radius at the joint; sphere: radius
   * @property {number} [endRadius] capsule: radius at the far end (a limb tapers into the next segment)
   * @property {number[]} [size] box: [x, y, z]
   * @property {number[][]} [profile] lathe: [[radius, along], ...]
   * @property {number[][]} [outline] extrude: [[across, along], ...]
   * @property {number} [depth] extrude: thickness
   * @property {number} [axis] lathe and extrude: the long axis, 0 = x, 1 = y, 2 = z
   * @property {number} [across] extrude: the axis the outline's first coordinate lies along
   * @property {number[]} at [x, y, z] offset in bone space
   * @property {number[]} [scale] [x, y, z] stretch about `at` (an egg-shaped head, a torso deeper than wide); absent = none
   * @property {number[][]} [basis] three unit vectors [across, up, out] in bone space: the solid, built and
   *   stretched along the bone's axes, is then turned about `at` so its x, y and z lie along them (an ear that
   *   leans back, a nose on a tilted face); absent = the bone's own axes
   * @property {number} [inflate] metres every vertex is pushed out along its normal after all of the above: the
   *   shell a raised region is drawn on (cloth over a limb, hair over a scalp); absent = none
   * @property {boolean} [smooth] lathe: round the authored profile (a curve through its points) instead of
   *   joining them with straight runs; `LEVELS[level].smoothSteps` points per run
   * @property {StampLayer[]} [layers] stamps: flat polygons lying on the bone's surface, drawn in order
   */

  /**
   * @typedef {Object} StampLayer
   * One flat polygon of a `stamps` shape: a layer of an eye, a brow, a lip, a freckle.
   * @property {number[]} points x, y, z per vertex, in bone space, counter-clockwise seen from outside
   * @property {number[]} normal unit [x, y, z], out of the surface
   * @property {number} slot which of the figure's ramps paints it
   * @property {number} tone a fixed tone, 0 (darkest) .. 1 (lightest) of that ramp
   * @property {number} [least=0] the fewest target texels its smaller side may cover: the look grows a layer
   *   that would be smaller (a glint, a pupil) so it survives a low-resolution target
   * @property {number} [drop=0] leave the layer out while its smaller side covers fewer target texels than this
   */

  /**
   * @typedef {Object} ShapeArrays
   * A surface as plain arrays, ready for a BufferGeometry.
   * @property {Float32Array} positions 3 per vertex, bone space, metres
   * @property {Float32Array} normals 3 per vertex, unit length, outward
   * @property {Uint16Array|Uint32Array} indices 3 per triangle, counter-clockwise from outside
   * @property {Float32Array} [paint] stamps only, 4 per vertex: ramp slot, tone 0..1, size rule in texels (positive: the least size, grow to it; negative: drop the layer below that size), order of the layer (later layers draw over earlier ones)
   * @property {Float32Array} [centres] stamps only, 4 per vertex: its layer's centre (x, y, z) and smaller half extent, metres
   */

  // ---- small vector helpers (allocation is fine here: shapes are built once per distinct key) -----------------------

  const round = (value) => Number(value.toFixed(KEY_DECIMALS)) + 0; // + 0 turns -0 into 0
  const length3 = (vector) => Math.hypot(vector[0], vector[1], vector[2]);
  const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
  const scaled = (vector, factor) => vector.map((value) => value * factor);
  const unitAxis = (axis) => [0, 1, 2].map((index) => (index === axis ? 1 : 0));

  /**
   * A right-handed frame whose second vector is `direction`: local (x, y, z) maps to x * across + y * along + z * out,
   * so a surface built along +Y points along `direction`, and its winding is kept.
   */
  const frameAlong = (direction) => {
    const along = scaled(direction, 1 / length3(direction));
    // Any helper not parallel to the direction will do; +Z unless the direction is nearly +-Z.
    const helper = Math.abs(along[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const side = cross(along, helper);
    const across = scaled(side, 1 / length3(side));
    return [across, along, cross(across, along)];
  };

  /** Writes arrays built in a local frame into bone space: positions turned by the frame and moved by `at`, normals turned. */
  const placeInFrame = (arrays, frame, at) => {
    const { positions, normals } = arrays;
    const [across, along, out] = frame;
    for (let offset = 0; offset < positions.length; offset += VECTOR) {
      const [px, py, pz] = [positions[offset], positions[offset + 1], positions[offset + 2]];
      const [nx, ny, nz] = [normals[offset], normals[offset + 1], normals[offset + 2]];
      for (let axis = 0; axis < VECTOR; axis++) {
        positions[offset + axis] = px * across[axis] + py * along[axis] + pz * out[axis] + at[axis];
        normals[offset + axis] = nx * across[axis] + ny * along[axis] + nz * out[axis];
      }
    }
    return arrays;
  };

  const indexArray = (indices, vertexCount) => (vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices));

  // ---- level of detail ------------------------------------------------------------------------------------------------

  /**
   * Segments around a round surface of a given radius at a level of detail.
   * @param {string} level a key of `LEVELS`
   * @param {number} radius metres
   * @returns {{around: number, rings: number}} `rings` is for a quarter turn (a hemisphere)
   * @throws {Error} for an unknown level
   * @complexity O(1)
   * @example Kit.figure.segmentsFor('high', 0.12) // { around: 24, rings: 6 }
   */
  const segmentsFor = (level, radius) => {
    const row = LEVELS[level];
    if (!row) fail('segmentsFor', `no level "${level}". Levels: ${Object.keys(LEVELS).join(', ')}.`);
    const around = Math.min(row.maxAround, Math.max(row.minAround, Math.ceil((FULL_TURN * radius) / row.edge)));
    return { around, rings: Math.max(row.minRings, Math.round(around * RINGS_PER_AROUND)) };
  };

  // ---- the surface of revolution every round shape is made of --------------------------------------------------------

  /**
   * Spins a profile about +Y. Each profile point is [radius, height, normalRadial, normalHeight]; a ring of
   * `around` vertices is made per point (a point on the axis makes a ring of one position, whose triangles have
   * no area). Ends with a non-zero radius are closed by flat discs with their own vertices, so the rim is crisp.
   * @param {number[][]} profile bottom to top
   * @param {number} around segments around
   * @returns {ShapeArrays}
   */
  const revolve = (profile, around) => {
    const positions = [];
    const normals = [];
    const indices = [];
    const ring = (radius, height, normalRadial, normalHeight) => {
      for (let segment = 0; segment < around; segment++) {
        const angle = (segment / around) * FULL_TURN;
        // x = r sin, z = r cos: walking the segments turns from +Z towards +X, which with rings rising in Y makes
        // the quads below counter-clockwise from outside.
        positions.push(radius * Math.sin(angle), height, radius * Math.cos(angle));
        normals.push(normalRadial * Math.sin(angle), normalHeight, normalRadial * Math.cos(angle));
      }
    };
    profile.forEach(([radius, height, normalRadial, normalHeight]) => ring(radius, height, normalRadial, normalHeight));
    for (let row = 0; row + 1 < profile.length; row++) {
      for (let segment = 0; segment < around; segment++) {
        const next = (segment + 1) % around;
        const [lowA, lowB, highA, highB] = [row * around + segment, row * around + next, (row + 1) * around + segment, (row + 1) * around + next];
        indices.push(lowA, lowB, highB, lowA, highB, highA);
      }
    }
    /** A flat disc closing one end; `facing` is +1 for the top, -1 for the bottom. */
    const disc = (radius, height, facing) => {
      if (radius <= EPSILON) return;
      const center = positions.length / VECTOR;
      positions.push(0, height, 0);
      normals.push(0, facing, 0);
      ring(radius, height, 0, facing);
      for (let segment = 0; segment < around; segment++) {
        const [first, second] = [center + 1 + segment, center + 1 + ((segment + 1) % around)];
        if (facing > 0) indices.push(center, first, second);
        else indices.push(center, second, first);
      }
    };
    disc(profile[0][0], profile[0][1], -1);
    disc(profile[profile.length - 1][0], profile[profile.length - 1][1], 1);
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: indexArray(indices, positions.length / VECTOR) };
  };

  /** Normals of an authored [radius, height] profile from the tangent at each point (central differences). */
  const profileWithNormals = (points) =>
    points.map(([radius, height], index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const [tangentRadial, tangentHeight] = [after[0] - before[0], after[1] - before[1]];
      const size = Math.hypot(tangentRadial, tangentHeight) || 1;
      // Outward is the tangent turned a quarter clockwise in the (radius, height) plane.
      return [radius, height, tangentHeight / size, -tangentRadial / size];
    });

  /** A circular arc of profile points about (0, centerHeight), from `fromAngle` to `toAngle` (radians, 0 = outward). */
  const arc = (radius, centerHeight, fromAngle, toAngle, steps) =>
    Array.from({ length: steps + 1 }, (_unused, step) => {
      const angle = fromAngle + ((toAngle - fromAngle) * step) / steps;
      return [radius * Math.cos(angle), centerHeight + radius * Math.sin(angle), Math.cos(angle), Math.sin(angle)];
    });

  // ---- builders, one per primitive ------------------------------------------------------------------------------------

  /**
   * A capsule from the joint to `end`, round at both ends, tapering from `radius` to `endRadius`.
   * @param {ShapeDescriptor} shape
   * @param {string} level
   * @returns {ShapeArrays}
   */
  const buildCapsule = (shape, level) => {
    const length = length3(shape.end);
    const { around, rings } = segmentsFor(level, Math.max(shape.radius, shape.endRadius));
    // A quarter turn below the joint, a quarter turn above the end; the straight run between them joins the two
    // equators (with unequal radii it is a slight cone and its normals are the arcs' equator normals).
    const profile = [...arc(shape.radius, 0, -Math.PI / 2, 0, rings), ...arc(shape.endRadius, length, 0, Math.PI / 2, rings)];
    return placeInFrame(revolve(profile, around), frameAlong(shape.end), shape.at);
  };

  /**
   * @param {ShapeDescriptor} shape
   * @param {string} level
   * @returns {ShapeArrays}
   */
  const buildSphere = (shape, level) => {
    const { around, rings } = segmentsFor(level, shape.radius);
    return placeInFrame(revolve(arc(shape.radius, 0, -Math.PI / 2, Math.PI / 2, rings * 2), around), frameAlong([0, 1, 0]), shape.at);
  };

  /** The six faces of a box as (normal axis, sign); each face gets four vertices of its own, so edges stay sharp. */
  const BOX_FACES = [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ];

  /**
   * A box centred on `at`, along the bone's axes. Flat faces at every level of detail.
   * @param {ShapeDescriptor} shape
   * @returns {ShapeArrays}
   */
  const buildBox = (shape) => {
    const half = shape.size.map((value) => value / 2);
    const positions = [];
    const normals = [];
    const indices = [];
    BOX_FACES.forEach(([axis, sign]) => {
      // Two axes spanning the face, ordered so (first x second) points along the outward normal.
      const first = (axis + (sign > 0 ? 1 : 2)) % VECTOR;
      const second = (axis + (sign > 0 ? 2 : 1)) % VECTOR;
      const base = positions.length / VECTOR;
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].forEach(([alongFirst, alongSecond]) => {
        const corner = [0, 0, 0];
        corner[axis] = sign * half[axis];
        corner[first] = alongFirst * half[first];
        corner[second] = alongSecond * half[second];
        positions.push(...corner.map((value, index) => value + shape.at[index]));
        normals.push(...unitAxis(axis).map((value) => value * sign));
      });
      indices.push(...QUAD_CORNERS.map((corner) => base + corner));
    });
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: indexArray(indices, positions.length / VECTOR) };
  };

  /**
   * An authored profile spun about the bone's long axis (a hat, a bottle, a torso); open ends are closed.
   * @param {ShapeDescriptor} shape
   * @param {string} level
   * @returns {ShapeArrays}
   */
  const buildLathe = (shape, level) => {
    const widest = Math.max(...shape.profile.map(([radius]) => radius));
    const { around } = segmentsFor(level, widest);
    // `revolve` wants the profile rising; one authored from the top down (a skirt that falls from its waist) is
    // read from its hem up, or its faces would wind inwards and be culled.
    const rising = shape.profile[0][1] <= shape.profile[shape.profile.length - 1][1] ? shape.profile : shape.profile.slice().reverse();
    const profile = shape.smooth ? smoothProfile(rising, LEVELS[level].smoothSteps) : rising;
    return placeInFrame(revolve(profileWithNormals(profile), around), frameAlong(unitAxis(shape.axis)), shape.at);
  };

  /**
   * A curve through the points of a profile (a uniform Catmull-Rom spline: it passes through every authored
   * point, so dials that move a point still move the surface there), sampled `steps` times per run.
   * @param {number[][]} points [[radius, height], ...]
   * @param {number} steps samples per run between two authored points; 1 returns the points themselves
   * @returns {number[][]} radii clamped at 0 (the curve may not cross the axis)
   * @complexity O(points x steps)
   * @example Kit.figure.smoothProfile([[0, 0], [0.1, 0.1], [0, 0.2]], 4).length // 9
   */
  const smoothProfile = (points, steps) => {
    if (steps <= 1 || points.length < 3) return points;
    const at = (index) => points[Math.max(0, Math.min(points.length - 1, index))];
    /** Catmull-Rom between `second` and `third` at `share` 0..1, for one coordinate. */
    const blend = (first, second, third, fourth, share) =>
      0.5 * (2 * second + (third - first) * share + (2 * first - 5 * second + 4 * third - fourth) * share * share + (3 * second - first - 3 * third + fourth) * share * share * share);
    const curve = [];
    for (let run = 0; run + 1 < points.length; run++) {
      const [before, from, to, after] = [at(run - 1), at(run), at(run + 1), at(run + 2)];
      for (let step = 0; step < steps; step++) curve.push([0, 1].map((coordinate) => blend(before[coordinate], from[coordinate], to[coordinate], after[coordinate], step / steps)));
    }
    curve.push(points[points.length - 1].slice());
    return curve.map(([radius, height]) => [Math.max(0, radius), height]);
  };

  /** Directions (over half a turn) a stamp layer's width is measured in to find its smaller side. */
  const WIDTH_DIRECTIONS = 8;

  /**
   * Flat polygons on a bone's surface (`StampLayer`s), as one surface: each layer triangulated by ear clipping,
   * its vertices carrying the layer's paint and centre so one draw call paints a whole face.
   * @param {ShapeDescriptor} shape
   * @returns {ShapeArrays} with `paint` and `centres`
   */
  const buildStamps = (shape) => {
    const positions = [];
    const normals = [];
    const paint = [];
    const centres = [];
    const indices = [];
    shape.layers.forEach((layer, order) => {
      const base = positions.length / VECTOR;
      const count = layer.points.length / VECTOR;
      const axes = [0, 1, 2].map((axis) => Array.from({ length: count }, (_unused, vertex) => layer.points[vertex * VECTOR + axis]));
      const centre = axes.map((values) => (Math.min(...values) + Math.max(...values)) / 2);
      // The two tangent axes of the layer's plane, to flatten it for triangulation and to measure its smaller side.
      const [across, , out] = frameAlong(layer.normal);
      const flat = Array.from({ length: count }, (_unused, vertex) => [0, 1, 2].reduce((sums, axis) => [sums[0] + (axes[axis][vertex] - centre[axis]) * out[axis], sums[1] + (axes[axis][vertex] - centre[axis]) * across[axis]], [0, 0]));
      // The smaller side is the narrowest width over a few directions: the plane's two axes are arbitrary, and
      // a thin shape lying diagonally in them would measure as wide as it is long.
      const halfExtent = Math.min(
        ...Array.from({ length: WIDTH_DIRECTIONS }, (_unused, step) => {
          const [cosine, sine] = [Math.cos((step * Math.PI) / WIDTH_DIRECTIONS), Math.sin((step * Math.PI) / WIDTH_DIRECTIONS)];
          const reaches = flat.map((point) => point[0] * cosine + point[1] * sine);
          return (Math.max(...reaches) - Math.min(...reaches)) / 2;
        })
      );
      for (let vertex = 0; vertex < count; vertex++) {
        positions.push(layer.points[vertex * VECTOR] + shape.at[0], layer.points[vertex * VECTOR + 1] + shape.at[1], layer.points[vertex * VECTOR + 2] + shape.at[2]);
        normals.push(...layer.normal);
        paint.push(layer.slot, layer.tone, layer.drop ? -layer.drop : layer.least || 0, order);
        centres.push(centre[0] + shape.at[0], centre[1] + shape.at[1], centre[2] + shape.at[2], halfExtent);
      }
      // `triangulate` returns counter-clockwise triangles in the flattened plane, whose axes (out x across = normal) keep that winding in space.
      triangulate(flat).forEach((corner) => indices.push(base + corner));
    });
    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: indexArray(indices, positions.length / VECTOR),
      paint: Float32Array.from(paint),
      centres: Float32Array.from(centres),
    };
  };

  /**
   * Twice the signed area of a polygon (positive when its points run counter-clockwise).
   * @param {number[][]} points [[x, y], ...]
   * @returns {number}
   */
  const signedArea2 = (points) => points.reduce((sum, [x, y], index) => sum + x * points[(index + 1) % points.length][1] - points[(index + 1) % points.length][0] * y, 0);

  /**
   * Triangulates a simple polygon (convex or not, no holes) by ear clipping.
   * @param {number[][]} points [[x, y], ...] in either winding
   * @returns {number[]} indices into `points`, 3 per triangle, counter-clockwise
   * @throws {Error} when the outline crosses itself (no ear is left, or the triangles cover more than the outline)
   * @complexity O(points^2) time; outlines are a handful of points
   * @example Kit.figure.triangulate([[0, 0], [1, 0], [1, 1], [0, 1]]) // two triangles
   */
  const triangulate = (points) => {
    const isCounterClockwise = signedArea2(points) > 0;
    const remaining = points.map((_point, index) => index);
    if (!isCounterClockwise) remaining.reverse();
    const triangles = [];
    /** Twice the signed area of the triangle (from, via, to): positive when it turns left. */
    const turnOf = (from, via, to) => (points[via][0] - points[from][0]) * (points[to][1] - points[from][1]) - (points[via][1] - points[from][1]) * (points[to][0] - points[from][0]);
    const isInside = (point, first, second, third) => turnOf(first, second, point) >= 0 && turnOf(second, third, point) >= 0 && turnOf(third, first, point) >= 0;
    while (remaining.length > TRIANGLE) {
      const count = remaining.length;
      const ear = remaining.findIndex((corner, position) => {
        const before = remaining[(position + count - 1) % count];
        const after = remaining[(position + 1) % count];
        if (turnOf(before, corner, after) <= EPSILON) return false; // a reflex or flat corner is not an ear
        return remaining.every((other) => other === before || other === corner || other === after || !isInside(other, before, corner, after));
      });
      if (ear < 0) fail('triangulate', `no ear found: the outline of ${points.length} points crosses itself; list its points in order round the edge.`);
      triangles.push(remaining[(ear + count - 1) % count], remaining[ear], remaining[(ear + 1) % count]);
      remaining.splice(ear, 1);
    }
    triangles.push(...remaining);
    // A crossing outline can still yield ears, but its triangles then cover more than its signed area.
    let covered = 0;
    for (let corner = 0; corner < triangles.length; corner += VECTOR) covered += Math.abs(turnOf(triangles[corner], triangles[corner + 1], triangles[corner + 2]));
    if (Math.abs(covered - Math.abs(signedArea2(points))) > EPSILON + 1e-6 * covered)
      fail('triangulate', `the outline of ${points.length} points crosses itself; list its points in order round the edge.`);
    return triangles;
  };

  /**
   * A flat outline given thickness (a blade, a fin): front and back faces, and a wall along every edge.
   * @param {ShapeDescriptor} shape
   * @returns {ShapeArrays}
   */
  const buildExtrude = (shape) => {
    // Work in the counter-clockwise order, so every wall's outward normal is to the right of its edge.
    const outline = signedArea2(shape.outline) > 0 ? shape.outline : shape.outline.slice().reverse();
    const halfDepth = shape.depth / 2;
    const faces = triangulate(outline);
    const positions = [];
    const normals = [];
    const indices = [];
    const addFace = (side) => {
      const base = positions.length / VECTOR;
      outline.forEach(([across, along]) => {
        positions.push(across, along, side * halfDepth);
        normals.push(0, 0, side);
      });
      for (let corner = 0; corner < faces.length; corner += VECTOR) {
        const [first, second, third] = faces.slice(corner, corner + VECTOR).map((index) => base + index);
        if (side > 0) indices.push(first, second, third);
        else indices.push(first, third, second);
      }
    };
    addFace(1);
    addFace(-1);
    outline.forEach(([fromX, fromY], index) => {
      const [toX, toY] = outline[(index + 1) % outline.length];
      const size = Math.hypot(toX - fromX, toY - fromY);
      if (size <= EPSILON) return;
      const [normalX, normalY] = [(toY - fromY) / size, -(toX - fromX) / size];
      const base = positions.length / VECTOR;
      [
        [fromX, fromY, -halfDepth],
        [toX, toY, -halfDepth],
        [toX, toY, halfDepth],
        [fromX, fromY, halfDepth],
      ].forEach((corner) => {
        positions.push(...corner);
        normals.push(normalX, normalY, 0);
      });
      indices.push(...QUAD_CORNERS.map((corner) => base + corner));
    });
    // Local x is across, y is along, z is thickness; the frame keeps it right-handed (thickness = across x along).
    const acrossVector = unitAxis(shape.across);
    const alongVector = unitAxis(shape.axis);
    const arrays = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: indexArray(indices, positions.length / VECTOR) };
    return placeInFrame(arrays, [acrossVector, alongVector, cross(acrossVector, alongVector)], shape.at);
  };

  /** Stretches built arrays about `at` by [x, y, z]; normals by the inverse stretch, then made unit again. */
  const stretch = (arrays, scale, at) => {
    const { positions, normals } = arrays;
    for (let offset = 0; offset < positions.length; offset += VECTOR) {
      for (let axis = 0; axis < VECTOR; axis++) {
        positions[offset + axis] = at[axis] + (positions[offset + axis] - at[axis]) * scale[axis];
        normals[offset + axis] /= scale[axis];
      }
      const size = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
      for (let axis = 0; axis < VECTOR; axis++) normals[offset + axis] /= size;
    }
    return arrays;
  };

  /** Builders by shape kind. `none` has none: nothing is drawn. */
  const BUILDERS = Object.freeze({ capsule: buildCapsule, sphere: buildSphere, box: buildBox, lathe: buildLathe, extrude: buildExtrude, stamps: buildStamps });

  /** Turns built arrays about `at` so the solid's x, y and z lie along the three vectors of `basis`. */
  const turn = (arrays, basis, at) => {
    const { positions, normals } = arrays;
    for (let offset = 0; offset < positions.length; offset += VECTOR) {
      const [px, py, pz] = [positions[offset] - at[0], positions[offset + 1] - at[1], positions[offset + 2] - at[2]];
      const [nx, ny, nz] = [normals[offset], normals[offset + 1], normals[offset + 2]];
      for (let axis = 0; axis < VECTOR; axis++) {
        positions[offset + axis] = at[axis] + px * basis[0][axis] + py * basis[1][axis] + pz * basis[2][axis];
        normals[offset + axis] = nx * basis[0][axis] + ny * basis[1][axis] + nz * basis[2][axis];
      }
    }
    return arrays;
  };

  /** Pushes every vertex out along its normal: the shell a raised region is drawn on. */
  const inflate = (arrays, distance) => {
    for (let offset = 0; offset < arrays.positions.length; offset++) arrays.positions[offset] += arrays.normals[offset] * distance;
    return arrays;
  };

  // ---- from a plan's bone to a descriptor ------------------------------------------------------------------------------

  /** The children of a bone that continue its surface (not skipped by `skipChild`), in plan order. */
  const continuingChildren = (plan, bone, skipChild) => {
    const children = [];
    for (let child = bone + 1; child < plan.subtreeEnd[bone]; child++) if (plan.parent[child] === bone && !skipChild(bone, child)) children.push(child);
    return children;
  };

  /** A bone that states no shape is a capsule. */
  const DEFAULT_SHAPE_ROW = Object.freeze({ kind: 'capsule' });
  /**
   * A side link (a chest to a shoulder, a pelvis to a hip) that leaves the bone's region narrows to at least this
   * share of the bone's own radius: shoulders read as the torso's, not as thin sticks out of its middle.
   */
  const SIDE_LINK_SHARE = 0.6;

  /**
   * The default capsule. A bone with a `tail` is one capsule from the joint to it. A bone without one is a
   * capsule to each continuing child's joint, so a hub (a chest with a neck and two shoulders, a fish's trunk
   * with a head in front and a rear behind) draws every link instead of only the first. Within one region a
   * link narrows to the child's girth (a limb into its next segment); out of it the first link keeps the bone's
   * width (a chest into its neck) and the others narrow by `SIDE_LINK_SHARE` at most. A child drawn as some
   * other shape (a head sphere, a foot box) is never tapered towards. Neither: a ball of the bone's girth.
   */
  const describeCapsules = (plan, bone, row, at, rules) => {
    // A row may state its own radius and taper (a plait that thins, a chin tuft); otherwise the bone's girth decides.
    const radius = row.radius === undefined ? plan.girth[bone] / 2 : row.radius;
    const tail = Array.from(plan.tail.subarray(bone * VECTOR, bone * VECTOR + VECTOR));
    if (length3(tail) > EPSILON) return [{ shape: { kind: 'capsule', end: tail, radius, endRadius: radius * (row.taper === undefined ? 1 : row.taper), at }, child: -1 }];
    const links = continuingChildren(plan, bone, rules.skipChild || (() => false)).filter((child) => length3(plan.restTranslation.subarray(child * VECTOR, child * VECTOR + VECTOR)) > EPSILON);
    if (!links.length) return [{ shape: { kind: 'sphere', radius, at }, child: -1 }];
    return links.map((child, index) => {
      const isCapsuleChild = !plan.shapes[child] || plan.shapes[child].kind === 'capsule';
      const childRadius = isCapsuleChild ? plan.girth[child] / 2 : radius;
      const isSameRegion = rules.isSameRegion ? rules.isSameRegion(bone, child) : false;
      const endRadius = isSameRegion ? childRadius : index === 0 ? radius : Math.max(childRadius, radius * SIDE_LINK_SHARE);
      return { shape: { kind: 'capsule', end: Array.from(plan.restTranslation.subarray(child * VECTOR, child * VECTOR + VECTOR)), radius, endRadius, at }, child: index === 0 ? -1 : child };
    });
  };

  /** One descriptor, not linked to a child. */
  const alone = (shape) => [{ shape, child: -1 }];

  /** Descriptor makers by shape kind: (plan, bone, row, at, rules) -> `BoneSurface`s. */
  const DESCRIBERS = Object.freeze({
    capsule: describeCapsules,
    none: () => [],
    sphere: (_plan, _bone, row, at) => alone({ kind: 'sphere', radius: row.radius, at }),
    box: (_plan, _bone, row, at) => alone({ kind: 'box', size: row.size.slice(), at }),
    lathe: (plan, bone, row, at) => alone({ kind: 'lathe', profile: row.profile.map((point) => point.slice()), axis: plan.axis[bone], at, ...(row.smooth ? { smooth: true } : {}) }),
    extrude: (plan, bone, row, at) =>
      alone({
        kind: 'extrude',
        outline: row.outline.map((point) => point.slice()),
        depth: row.depth,
        axis: plan.axis[bone],
        across: AXIS_NAMES.indexOf(row.across !== undefined ? row.across : ACROSS_AXIS[AXIS_NAMES[plan.axis[bone]]]),
        at,
      }),
  });

  /**
   * @typedef {Object} BoneSurface
   * @property {ShapeDescriptor} shape
   * @property {number} child -1 for the bone's own (first) surface; else the child bone an extra link reaches
   */

  /**
   * The canonical shape descriptors of a bone: its `shape` row with every default filled in, or the default
   * capsules (see `describeCapsules`: one per link to a continuing child). The rules say which bones draw
   * nothing (`isHidden`: a part's mount), which children do not continue a bone's surface (`skipChild`: a
   * sword's mount on a hand) and which children are in the bone's region (`isSameRegion`, for tapering).
   * @param {Object} plan a `BodyPlan`
   * @param {number} bone bone index
   * @param {{isHidden?: function(number): boolean, skipChild?: function(number, number): boolean, isSameRegion?: function(number, number): boolean, shapes?: ReadonlyArray<?Object>}} [rules]
   *   `shapes`: per bone, the rows to describe instead of `plan.shapes` (a bake's dialled shapes)
   * @returns {BoneSurface[]} empty for a `none` shape or a hidden bone
   * @complexity O(bones in the subtree) for default capsules (to find the children), else O(shape size)
   * @example Kit.figure.describeShapes(plan, plan.boneIndex('thighLeft'))[0].shape // { kind: 'capsule', end: [0, -0.45, 0], radius: 0.05, endRadius: 0.04, at: [0, 0, 0] } with a capsule shin in the same region
   */
  const describeShapes = (plan, bone, rules = {}) => {
    if (rules.isHidden && rules.isHidden(bone)) return [];
    // A bake's shapes carry its shape dials (Kit.body.shapesWithDials); the plan's are the shapes as drawn.
    const row = (rules.shapes ? rules.shapes[bone] : plan.shapes[bone]) || DEFAULT_SHAPE_ROW;
    const describe = DESCRIBERS[row.kind];
    if (!describe) fail('describeShapes', `bone ${plan.boneNames[bone]} has a shape of kind "${row.kind}", which has no builder. Kinds: ${Object.keys(BUILDERS).join(', ')}, none.`);
    const surfaces = describe(plan, bone, row, row.at ? row.at.slice() : [0, 0, 0], rules);
    return row.scale ? surfaces.map((surface) => ({ ...surface, shape: { ...surface.shape, scale: row.scale.slice() } })) : surfaces;
  };

  /**
   * The cache key of a shape at a level of detail: equal exactly when the two would build the same surface
   * (numbers compared to a tenth of a millimetre).
   * @param {ShapeDescriptor} shape
   * @param {string} [level='high']
   * @returns {string}
   * @complexity O(shape size)
   * @example Kit.figure.shapeKey({ kind: 'sphere', radius: 0.12, at: [0, 0.11, 0] }) // 'sphere|high|0.12|0,0.11,0'
   */
  const shapeKey = (shape, level = DEFAULT_LEVEL) => {
    // A frozen descriptor (a face's stamps, kept by the feature cache) is keyed once: its key is hundreds of numbers long.
    const known = Object.isFrozen(shape) ? frozenKeys.get(shape) : undefined;
    if (known && known.level === level) return known.key;
    const key = keyOf(shape, level);
    if (Object.isFrozen(shape)) frozenKeys.set(shape, { level, key });
    return key;
  };
  /** @type {WeakMap<Object, {level: string, key: string}>} */
  const frozenKeys = new WeakMap();
  const keyOf = (shape, level) => {
    const flat = (value) =>
      Array.isArray(value) ? value.map(flat).join(',') : typeof value === 'number' ? String(round(value)) : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((field) => `${field}:${flat(value[field])}`).join(';')}}` : String(value);
    const fields = Object.keys(shape)
      .filter((field) => field !== 'kind')
      .sort()
      .map((field) => `${field}=${flat(shape[field])}`);
    return [shape.kind, level, ...fields].join('|');
  };

  /**
   * Builds a shape's surface.
   * @param {ShapeDescriptor} shape
   * @param {string} [level='high'] a key of `LEVELS`
   * @returns {ShapeArrays}
   * @throws {Error} for an unknown kind or level
   * @complexity O(vertices): about around x (2 x rings + 2) for round shapes, 24 for a box, the outline points of every layer for stamps
   * @example const { positions, normals, indices } = Kit.figure.buildShape({ kind: 'sphere', radius: 0.1, at: [0, 0, 0] }, 'medium');
   */
  const buildShape = (shape, level = DEFAULT_LEVEL) => {
    const builder = BUILDERS[shape.kind];
    if (!builder) fail('buildShape', `no builder for the shape kind "${shape.kind}". Kinds: ${Object.keys(BUILDERS).join(', ')}.`);
    if (!LEVELS[level]) fail('buildShape', `no level "${level}". Levels: ${Object.keys(LEVELS).join(', ')}.`);
    const arrays = builder(shape, level);
    if (shape.scale) stretch(arrays, shape.scale, shape.at);
    if (shape.basis) turn(arrays, shape.basis, shape.at);
    return shape.inflate ? inflate(arrays, shape.inflate) : arrays;
  };

  // ---- matrices -------------------------------------------------------------------------------------------------------

  /**
   * Writes a bone's world transform (position, rotation, three-axis scale; kit/rig.js) as a column-major 4 x 4
   * matrix, the layout of THREE.Matrix4.elements and of an InstancedMesh's matrix buffer.
   * @param {{translation: Float32Array, rotation: Float32Array, scale: Float32Array}} world the `out` of `Kit.body.worldTransforms`
   * @param {number} bone bone index
   * @param {Float32Array|number[]} out receives 16 numbers
   * @param {number} [outAt=0] index in `out` of the first one
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.figure.writeBoneMatrix(world, bone, mesh.matrix.elements);
   */
  const writeBoneMatrix = (world, bone, out, outAt = 0) => {
    const vector = bone * VECTOR;
    const quaternion = bone * QUATERNION;
    const [x, y, z, scalar] = [world.rotation[quaternion], world.rotation[quaternion + 1], world.rotation[quaternion + 2], world.rotation[quaternion + QUATERNION - 1]];
    const [scaleX, scaleY, scaleZ] = [world.scale[vector], world.scale[vector + 1], world.scale[vector + 2]];
    const [x2, y2, z2] = [x + x, y + y, z + z];
    const [xx, xy, xz, yy, yz, zz, wx, wy, wz] = [x * x2, x * y2, x * z2, y * y2, y * z2, z * z2, scalar * x2, scalar * y2, scalar * z2];
    out[outAt] = (1 - (yy + zz)) * scaleX;
    out[outAt + 1] = (xy + wz) * scaleX;
    out[outAt + 2] = (xz - wy) * scaleX;
    out[outAt + VECTOR] = 0;
    out[outAt + 4] = (xy - wz) * scaleY;
    out[outAt + 5] = (1 - (xx + zz)) * scaleY;
    out[outAt + 6] = (yz + wx) * scaleY;
    out[outAt + 7] = 0;
    out[outAt + 8] = (xz + wy) * scaleZ;
    out[outAt + 9] = (yz - wx) * scaleZ;
    out[outAt + 10] = (1 - (xx + yy)) * scaleZ;
    out[outAt + 11] = 0;
    out[outAt + 12] = world.translation[vector];
    out[outAt + 13] = world.translation[vector + 1];
    out[outAt + 14] = world.translation[vector + 2];
    out[outAt + 15] = 1;
    return out;
  };

  Kit.figure = Object.assign(Kit.figure || {}, { LEVELS, DEFAULT_LEVEL, ACROSS_AXIS, BUILDERS, segmentsFor, smoothProfile, triangulate, describeShapes, shapeKey, buildShape, writeBoneMatrix });
})();
