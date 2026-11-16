/**
 * Kit figure shapes: the surface of one bone, as plain arrays. Each body shape primitive (capsule, sphere, box,
 * lathe, extrude; kit/body-plan.js `SHAPES`) has one builder from the shape's data to positions, normals and
 * triangle indices in the bone's own space, at a chosen level of detail, plus a key that is equal exactly when
 * two shapes would build the same surface (so identical shapes share one geometry).
 *
 * Owns:  `Kit.figure.LEVELS` (segment counts per level of detail), `Kit.figure.ACROSS_AXIS` (the extrude
 *        convention), `describeShape` (a bone of a plan -> a canonical shape descriptor), `shapeKey`,
 *        `buildShape` and the builders behind it (`BUILDERS`), `triangulate` (ear clipping for extrude
 *        outlines) and `writeBoneMatrix` (a bone's world transform as a column-major 4 x 4 matrix).
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
    high: Object.freeze({ edge: 0.022, minAround: 8, maxAround: 24, minRings: 3 }),
    medium: Object.freeze({ edge: 0.045, minAround: 6, maxAround: 14, minRings: 2 }),
    low: Object.freeze({ edge: 0.09, minAround: 5, maxAround: 8, minRings: 1 }),
  });
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
   */

  /**
   * @typedef {Object} ShapeArrays
   * A surface as plain arrays, ready for a BufferGeometry.
   * @property {Float32Array} positions 3 per vertex, bone space, metres
   * @property {Float32Array} normals 3 per vertex, unit length, outward
   * @property {Uint16Array|Uint32Array} indices 3 per triangle, counter-clockwise from outside
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
    return placeInFrame(revolve(profileWithNormals(shape.profile), around), frameAlong(unitAxis(shape.axis)), shape.at);
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

  /** Builders by shape kind. `none` has none: nothing is drawn. */
  const BUILDERS = Object.freeze({ capsule: buildCapsule, sphere: buildSphere, box: buildBox, lathe: buildLathe, extrude: buildExtrude });

  // ---- from a plan's bone to a descriptor ------------------------------------------------------------------------------

  /** The first child of a bone that continues its surface (not skipped by `skipChild`), or -1. */
  const firstContinuingChild = (plan, bone, skipChild) => {
    for (let child = bone + 1; child < plan.subtreeEnd[bone]; child++) {
      if (plan.parent[child] === bone && !skipChild(bone, child)) return child;
    }
    return -1;
  };

  /** A bone that states no shape is a capsule. */
  const DEFAULT_SHAPE_ROW = Object.freeze({ kind: 'capsule' });

  /** The default capsule: joint to tail, else to the first continuing child, else a ball of the bone's girth. */
  const describeCapsule = (plan, bone, _row, at, rules) => {
    const radius = plan.girth[bone] / 2;
    const tail = Array.from(plan.tail.subarray(bone * VECTOR, bone * VECTOR + VECTOR));
    const child = length3(tail) > EPSILON ? -1 : firstContinuingChild(plan, bone, rules.skipChild || (() => false));
    const end = child >= 0 ? Array.from(plan.restTranslation.subarray(child * VECTOR, child * VECTOR + VECTOR)) : tail;
    if (length3(end) <= EPSILON) return { kind: 'sphere', radius, at };
    const isTapered = child >= 0 && rules.taperInto && rules.taperInto(bone, child);
    return { kind: 'capsule', end, radius, endRadius: isTapered ? plan.girth[child] / 2 : radius, at };
  };

  /** Descriptor makers by shape kind: (plan, bone, row, at, rules) -> descriptor, or null for nothing drawn. */
  const DESCRIBERS = Object.freeze({
    capsule: describeCapsule,
    none: () => null,
    sphere: (_plan, _bone, row, at) => ({ kind: 'sphere', radius: row.radius, at }),
    box: (_plan, _bone, row, at) => ({ kind: 'box', size: row.size.slice(), at }),
    lathe: (plan, bone, row, at) => ({ kind: 'lathe', profile: row.profile.map((point) => point.slice()), axis: plan.axis[bone], at }),
    extrude: (plan, bone, row, at) => ({
      kind: 'extrude',
      outline: row.outline.map((point) => point.slice()),
      depth: row.depth,
      axis: plan.axis[bone],
      across: AXIS_NAMES.indexOf(row.across !== undefined ? row.across : ACROSS_AXIS[AXIS_NAMES[plan.axis[bone]]]),
      at,
    }),
  });

  /**
   * The canonical shape descriptor of a bone: its `shape` row with every default filled in, or the default
   * capsule. A capsule runs from the joint to the bone's `tail`, else to its first continuing child's joint; a
   * bone with neither is a ball of its girth. The rules say which bones draw nothing (`isHidden`: a part's
   * mount), which children do not continue a bone's surface (`skipChild`: a sword's mount on a hand), and
   * whether a capsule narrows to its child's girth (`taperInto`: a limb into its next segment) or keeps its own
   * (a chest into a neck).
   * @param {Object} plan a `BodyPlan`
   * @param {number} bone bone index
   * @param {{isHidden?: function(number): boolean, skipChild?: function(number, number): boolean, taperInto?: function(number, number): boolean}} [rules]
   * @returns {?ShapeDescriptor} null for a `none` shape or a hidden bone
   * @complexity O(bones in the subtree) for a default capsule (to find the first child), else O(shape size)
   * @example Kit.figure.describeShape(plan, plan.boneIndex('thighLeft')) // { kind: 'capsule', end: [0, -0.45, 0], radius: 0.05, endRadius: 0.04, at: [0, 0, 0] }
   */
  const describeShape = (plan, bone, rules = {}) => {
    if (rules.isHidden && rules.isHidden(bone)) return null;
    const row = plan.shapes[bone] || DEFAULT_SHAPE_ROW;
    const describe = DESCRIBERS[row.kind];
    if (!describe) fail('describeShape', `bone ${plan.boneNames[bone]} has a shape of kind "${row.kind}", which has no builder. Kinds: ${Object.keys(BUILDERS).join(', ')}, none.`);
    return describe(plan, bone, row, row.at ? row.at.slice() : [0, 0, 0], rules);
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
    const flat = (value) => (Array.isArray(value) ? value.map(flat).join(',') : typeof value === 'number' ? String(round(value)) : String(value));
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
   * @complexity O(vertices): about around x (2 x rings + 2) for round shapes, 24 for a box
   * @example const { positions, normals, indices } = Kit.figure.buildShape({ kind: 'sphere', radius: 0.1, at: [0, 0, 0] }, 'medium');
   */
  const buildShape = (shape, level = DEFAULT_LEVEL) => {
    const builder = BUILDERS[shape.kind];
    if (!builder) fail('buildShape', `no builder for the shape kind "${shape.kind}". Kinds: ${Object.keys(BUILDERS).join(', ')}.`);
    if (!LEVELS[level]) fail('buildShape', `no level "${level}". Levels: ${Object.keys(LEVELS).join(', ')}.`);
    return builder(shape, level);
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

  Kit.figure = Object.assign(Kit.figure || {}, { LEVELS, DEFAULT_LEVEL, ACROSS_AXIS, BUILDERS, segmentsFor, triangulate, describeShape, shapeKey, buildShape, writeBoneMatrix });
})();
