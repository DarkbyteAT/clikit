/**
 * Kit sculpt: smooth surfaces from simple solids. Several solids (capsules, balls, boxes, turned profiles, flat
 * outlines) are blended into one distance field, like clay pressed together, and the field's surface is turned
 * into one mesh whose every vertex knows which solids it belongs to. A limb then runs into a torso without a
 * seam, a layer of cloth is the same surface pushed out and cut along a hem, and a rig can bend the result by
 * its weights instead of moving rigid pieces that overlap.
 *
 * Owns:  `Kit.sculpt.distanceOf` (a shape descriptor of kit/figure-shapes.js -> a signed distance function),
 *        `solid` (a descriptor placed by a transform, with its bounds), `sample` (solids -> a `Field`: distances on
 *        a grid, blended), `surface` (a field -> positions, normals and triangles by surface nets; a `cut` trims
 *        it along any boundary, found exactly), `weights` (vertices -> the up to four owners that move each),
 *        `smoothMin` and the `DETAIL` table.
 * Does not own: what the solids are (a body's bones, a part), which layers a figure has (kit/figure-sculpt.js),
 *        THREE, or drawing.
 *
 * Conventions: metres; a field's grid is axis-aligned in the space the solids were placed in (a body's rest
 * pose). Distances are negative inside. Triangles wind counter-clockwise seen from outside.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-sculpt.js.
 */
(() => {
  // ---- tunables -------------------------------------------------------------------------------------------------------

  /**
   * Grid cell size by level of detail, metres, and the most cells along the longest side of what is sampled
   * (`cellFor`): a body twice as tall is meshed with cells twice as large, so its cost and its look on screen
   * stay those of a small one. A solid thinner than `FEWEST_CELLS_ACROSS` cells cannot be meshed (`isTooThin`);
   * what to do with it then (kit/figure-sculpt.js leaves it a rigid piece) is the caller's choice, so one
   * earring never makes a whole body's grid finer.
   */
  const DETAIL = Object.freeze({
    high: Object.freeze({ cell: 0.011, most: 120 }),
    medium: Object.freeze({ cell: 0.017, most: 80 }),
    low: Object.freeze({ cell: 0.028, most: 48 }),
  });
  /** A solid thinner than this many cells may fall between samples. */
  const FEWEST_CELLS_ACROSS = 1.6;
  /** Most grid nodes of one field: a guard against a stray huge solid, not a tuning knob. */
  const MOST_NODES = 6e6;
  /**
   * How two surfaces cross decides their fillet. Two rounds of half-thickness t whose outward directions are an
   * angle apart meet in a groove t x (1 - cos(angle / 2)) deep; a fillet fills a groove by a quarter of its
   * width, so the width that brings the groove just up to the line across the two rounds is `GROOVE_FILL` times
   * that depth. Stacked parts of a torso (a shallow groove) then run into each other without a roll standing
   * proud between them, and a limb leaving a trunk (a deep one) gets the solids' whole `blend`.
   */
  const GROOVE_FILL = 4;
  /** A group's join with the rest stays full within this many fillet widths of its anchor, and is gone at twice that. */
  const JOIN_REACH = 2.5;
  /** "Far outside": the value of a node nothing was measured at, metres (its negative: far inside). */
  const FAR = 1e3;
  /** Steps of bisection when a surface crossing is found along a grid edge through a cut (2^-7 of a cell). */
  const CUT_STEPS = 7;
  /** Points per run of a smooth lathe's profile when its distance is measured. */
  const LATHE_SMOOTH_STEPS = 4;
  /**
   * A flat section (a lathe's profile, an extrude's outline) is measured once into a table: its distance at
   * the nodes of a 2D grid of about `cells` nodes along its longer side (each between `finest` and `coarsest`
   * metres), reaching `pad` metres past the section. Further out the section is measured directly. The table's
   * step stays well under a grid cell: a blend of four nodes is smooth inside a step and creased between two,
   * and creases as far apart as the mesh's own vertices would show as rings round a torso.
   */
  const TABLE = Object.freeze({ cells: 120, finest: 0.001, coarsest: 0.003, pad: 0.07, mostKept: 256 });
  /** The widest block of nodes measured as one when a field is sampled (it is halved down to single nodes near a surface). */
  const BLOCK = 8;
  /**
   * A surface's normals are averaged with their neighbours' over the mesh, one pass per cell of `reach` metres
   * (within `least` and `most` passes). A vertex's first normal is that of the triangles round it, which is
   * true to the form but carries every wobble a few cells long (the grid's own, and the shallow rolls where
   * stacked solids meet), and banded shading would show those as blotches and rings. Averaging over the mesh
   * costs triangles; measuring the field's slope further out instead would cost a wider band of grid nodes.
   */
  const NORMAL_SMOOTHING = Object.freeze({ reach: 0.044, least: 1, most: 4 });
  /** Nodes are measured this many cells past the surfaces a field will be asked for: the cell a vertex is made in, and the one it may be moved into. */
  const BAND_CELLS = 2.25;
  /** The most a solid's distance may change per metre: 1 for a true distance, a little more for a stretched solid's estimate. */
  const STEEPEST = 1.2;
  const VECTOR = 3;
  /** Owners per vertex: what a skinned mesh can carry. */
  const OWNERS = 4;
  const EPSILON = 1e-9;
  const ROOT_THREE = Math.sqrt(3);
  /** Corners of a grid cell, and halves of a block. */
  const CORNER_COUNT = 8;

  const fail = (where, message) => {
    throw new Error(`Kit.sculpt.${where}: ${message}`);
  };

  // ---- blending -------------------------------------------------------------------------------------------------------

  /**
   * The smaller of two distances, rounded where they meet: within `radius` of each other the result dips below
   * both, which fills the crease between two solids with a fillet about that wide.
   * @param {number} first
   * @param {number} second
   * @param {number} radius metres; 0 is a plain minimum (a crisp crease)
   * @returns {number} never more than `radius / 4` below the smaller
   * @complexity O(1)
   * @example Kit.sculpt.smoothMin(0.01, 0.01, 0.04) // 0: two surfaces a centimetre away each are joined here
   */
  const smoothMin = (first, second, radius) => {
    const closeness = radius > 0 ? Math.max(radius - Math.abs(first - second), 0) / radius : 0;
    return Math.min(first, second) - closeness * closeness * radius * 0.25;
  };

  // ---- distance to one shape, in the shape's own space ----------------------------------------------------------------

  /**
   * Distance from (u, v) to a closed polygon, negative inside: the even-odd rule for the sign, nearest edge for the size.
   * @param {ArrayLike<number>|number[][]} points u, v per corner, flat; or [[u, v], ...]
   * @param {number} u
   * @param {number} v
   * @returns {number}
   * @complexity O(corners), no allocation for a flat array
   * @example Kit.sculpt.polygonDistance([[0, 0], [1, 0], [1, 1], [0, 1]], 0.5, 0.5) // -0.5
   */
  const polygonDistance = (points, u, v) => {
    const flat = typeof points[0] === 'number' ? /** @type {ArrayLike<number>} */ (points) : /** @type {number[][]} */ (points).flat();
    let nearest = Infinity;
    let isInside = false;
    // Hot loop (a table of a section is thousands of calls): index arithmetic over the flat corners.
    for (let index = 0, previous = flat.length - 2; index < flat.length; previous = index, index += 2) {
      const fromU = flat[previous];
      const fromV = flat[previous + 1];
      const edgeU = flat[index] - fromU;
      const edgeV = flat[index + 1] - fromV;
      const share = Math.max(0, Math.min(1, ((u - fromU) * edgeU + (v - fromV) * edgeV) / (edgeU * edgeU + edgeV * edgeV || 1)));
      const awayU = u - fromU - edgeU * share;
      const awayV = v - fromV - edgeV * share;
      nearest = Math.min(nearest, awayU * awayU + awayV * awayV);
      if (fromV > v !== flat[index + 1] > v && u < fromU + ((v - fromV) / edgeV) * edgeU) isInside = !isInside;
    }
    return isInside ? -Math.sqrt(nearest) : Math.sqrt(nearest);
  };

  /**
   * @typedef {Object} SectionTable
   * A flat section's distance, measured once on a 2D grid.
   * @property {Float32Array} values distance at each node, u fastest
   * @property {number} sizeU nodes along u
   * @property {number} sizeV
   * @property {number} fromU u of node 0
   * @property {number} fromV
   * @property {number} step metres between nodes
   * @property {Float64Array} corners the section, flat (for points off the table)
   */

  /** @type {Map<string, SectionTable>} tables by section, most recently used last */
  const tables = new Map();

  /**
   * The distance table of a closed flat section, shared by every shape with the same section (a dial that
   * stretches a torso keeps its profile, so it keeps its table).
   * @param {number[][]} section [[u, v], ...]
   * @param {number} leastU the table starts no lower than this along u (0 for a profile turned about its axis)
   * @returns {SectionTable}
   * @complexity O(table nodes x corners) the first time a section is seen (about 2000 x 30), O(corners) to look it up
   * @example const table = Kit.sculpt.sectionTable([[0, 0], [0.1, 0], [0.1, 0.3], [0, 0.3]], 0);
   */
  const sectionTable = (section, leastU = -Infinity) => {
    const key = `${leastU}|${section.map(([u, v]) => `${u.toFixed(5)},${v.toFixed(5)}`).join(' ')}`;
    const known = tables.get(key);
    if (known) {
      tables.delete(key);
      tables.set(key, known);
      return known;
    }
    const corners = Float64Array.from(section.flat());
    const us = section.map(([u]) => u);
    const vs = section.map(([, v]) => v);
    const fromU = Math.max(leastU, Math.min(...us) - TABLE.pad);
    const fromV = Math.min(...vs) - TABLE.pad;
    const [spanU, spanV] = [Math.max(...us) + TABLE.pad - fromU, Math.max(...vs) + TABLE.pad - fromV];
    const step = Math.max(TABLE.finest, Math.min(TABLE.coarsest, Math.max(spanU, spanV) / TABLE.cells));
    const [sizeU, sizeV] = [Math.ceil(spanU / step) + 1, Math.ceil(spanV / step) + 1];
    const values = new Float32Array(sizeU * sizeV);
    for (let nodeV = 0, node = 0; nodeV < sizeV; nodeV++) for (let nodeU = 0; nodeU < sizeU; nodeU++, node++) values[node] = polygonDistance(corners, fromU + nodeU * step, fromV + nodeV * step);
    const table = { values, sizeU, sizeV, fromU, fromV, step, corners };
    tables.set(key, table);
    if (tables.size > TABLE.mostKept) tables.delete(tables.keys().next().value);
    return table;
  };

  /**
   * The slope of the distance last measured by a kind that states one (`SLOPED`): a vector in the shape's own
   * space, pointing away from the solid (any length; zero when unknown). One shared scratch, read straight after the call.
   */
  const SLOPE = new Float64Array(VECTOR);
  /** A table lookup's slope in the section's plane, (du, dv); zero when the point was off the table. */
  const SECTION_SLOPE = new Float64Array(2);

  /** A section table's distance at (u, v), by blending the four nodes round it; off the table, measured directly. Writes `SECTION_SLOPE`. */
  const tableDistance = (table, u, v) => {
    const step = table.step;
    const gridU = (u - table.fromU) / step;
    const gridV = (v - table.fromV) / step;
    const sizeU = table.sizeU;
    if (!(gridU >= 0 && gridV >= 0 && gridU < sizeU - 1 && gridV < table.sizeV - 1)) {
      SECTION_SLOPE[0] = SECTION_SLOPE[1] = 0;
      return polygonDistance(table.corners, u, v);
    }
    // Hot path (once per node per lathe): plain locals, nothing allocated.
    const values = table.values;
    const nodeU = Math.floor(gridU);
    const nodeV = Math.floor(gridV);
    const shareU = gridU - nodeU;
    const shareV = gridV - nodeV;
    const node = nodeU + sizeU * nodeV;
    const low = values[node];
    const lowNext = values[node + 1];
    const high = values[node + sizeU];
    const highNext = values[node + sizeU + 1];
    SECTION_SLOPE[0] = ((lowNext - low) * (1 - shareV) + (highNext - high) * shareV) / step;
    SECTION_SLOPE[1] = ((high - low) * (1 - shareU) + (highNext - lowNext) * shareU) / step;
    return (low + (lowNext - low) * shareU) * (1 - shareV) + (high + (highNext - high) * shareU) * shareV;
  };

  /**
   * Distance functions by shape kind, each `(shape) -> (x, y, z) -> metres` in the shape's own space, before
   * its `at`, `scale` and `basis`. A kind listed in `SLOPED` also writes the distance's slope into `SLOPE`.
   * Adding a kind of solid means adding a row here and a builder in kit/figure-shapes.js.
   */
  const KINDS = Object.freeze({
    /** A round cone: a ball of `radius` at the origin swept to a ball of `endRadius` at `end`. */
    capsule: ({ end, radius, endRadius = radius }) => {
      const [endX, endY, endZ] = end;
      const lengthSquared = endX * endX + endY * endY + endZ * endZ;
      const change = endRadius - radius;
      return (x, y, z) => {
        const share = lengthSquared > EPSILON ? Math.max(0, Math.min(1, (x * endX + y * endY + z * endZ) / lengthSquared)) : 0;
        const awayX = x - endX * share;
        const awayY = y - endY * share;
        const awayZ = z - endZ * share;
        const away = Math.sqrt(awayX * awayX + awayY * awayY + awayZ * awayZ);
        const scale = away > EPSILON ? 1 / away : 0;
        SLOPE[0] = awayX * scale;
        SLOPE[1] = awayY * scale;
        SLOPE[2] = awayZ * scale;
        return away - (radius + change * share);
      };
    },
    sphere:
      ({ radius }) =>
      (x, y, z) => {
        const away = Math.sqrt(x * x + y * y + z * z);
        const scale = away > EPSILON ? 1 / away : 0;
        SLOPE[0] = x * scale;
        SLOPE[1] = y * scale;
        SLOPE[2] = z * scale;
        return away - radius;
      },
    box: ({ size }) => {
      const [halfX, halfY, halfZ] = size.map((value) => value / 2);
      return (x, y, z) => {
        const overX = Math.abs(x) - halfX;
        const overY = Math.abs(y) - halfY;
        const overZ = Math.abs(z) - halfZ;
        const [outX, outY, outZ] = [Math.max(overX, 0), Math.max(overY, 0), Math.max(overZ, 0)];
        return Math.sqrt(outX * outX + outY * outY + outZ * outZ) + Math.min(Math.max(overX, overY, overZ), 0);
      };
    },
    /** A profile turned about the long axis: the polygon it encloses with the axis, measured in (radius, along). */
    lathe: ({ profile: authored, axis, smooth }) => {
      // A smooth lathe is the curve through its points, exactly as kit/figure-shapes.js builds it.
      const profile = smooth ? Kit.figure.smoothProfile(authored, LATHE_SMOOTH_STEPS) : authored;
      const table = sectionTable([[0, profile[0][1]], ...profile, [0, profile[profile.length - 1][1]]], 0);
      const [sideA, sideB] = [(axis + 1) % VECTOR, (axis + 2) % VECTOR];
      const point = new Float64Array(VECTOR);
      return (x, y, z) => {
        point[0] = x;
        point[1] = y;
        point[2] = z;
        const radius = Math.sqrt(point[sideA] * point[sideA] + point[sideB] * point[sideB]);
        const distance = tableDistance(table, radius, point[axis]);
        const outward = radius > EPSILON ? SECTION_SLOPE[0] / radius : 0;
        SLOPE[sideA] = point[sideA] * outward;
        SLOPE[sideB] = point[sideB] * outward;
        SLOPE[axis] = SECTION_SLOPE[1];
        return distance;
      };
    },
    /** A flat outline with thickness: the outline's distance in its plane, capped by the slab. */
    extrude: ({ outline, depth, axis, across }) => {
      const through = VECTOR - axis - across;
      const halfDepth = depth / 2;
      const table = sectionTable(outline);
      const point = new Float64Array(VECTOR);
      return (x, y, z) => {
        point[0] = x;
        point[1] = y;
        point[2] = z;
        const inPlane = tableDistance(table, point[across], point[axis]);
        const overDepth = Math.abs(point[through]) - halfDepth;
        const [outPlane, outDepth] = [Math.max(inPlane, 0), Math.max(overDepth, 0)];
        return Math.sqrt(outPlane * outPlane + outDepth * outDepth) + Math.min(Math.max(inPlane, overDepth), 0);
      };
    },
  });
  /** Kinds whose distance function writes `SLOPE`. */
  const SLOPED = Object.freeze({ capsule: true, sphere: true, lathe: true });

  /** Where a column-major 4 x 4 keeps its 3 x 3 part, row by row, and its translation. */
  const AFFINE_ROWS = Object.freeze([0, 4, 8, 1, 5, 9, 2, 6, 10]);
  const AFFINE_MOVE = Object.freeze([12, 13, 14]);
  /** The identity as a column-major 4 x 4. */
  const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /**
   * Inverts the upper 3 x 4 of a column-major 4 x 4 affine matrix.
   * @param {ArrayLike<number>} matrix 16 numbers, column-major
   * @returns {number[]} the inverse's 12 numbers row by row (three rows of x, y, z, translation)
   * @throws {Error} when the matrix has no inverse
   * @complexity O(1)
   * @example Kit.sculpt.invertAffine([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 1]) // [0.5, 0, 0, -0.5, 0, 0.5, 0, 0, 0, 0, 0.5, 0]
   */
  const invertAffine = (matrix) => {
    const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = AFFINE_ROWS.map((index) => matrix[index]);
    const determinant = xx * (yy * zz - yz * zy) - xy * (yx * zz - yz * zx) + xz * (yx * zy - yy * zx);
    if (Math.abs(determinant) < EPSILON) fail('solid', 'the transform has no inverse (a scale of zero?).');
    const rows = [
      [(yy * zz - yz * zy) / determinant, (xz * zy - xy * zz) / determinant, (xy * yz - xz * yy) / determinant],
      [(yz * zx - yx * zz) / determinant, (xx * zz - xz * zx) / determinant, (xz * yx - xx * yz) / determinant],
      [(yx * zy - yy * zx) / determinant, (xy * zx - xx * zy) / determinant, (xx * yy - xy * yx) / determinant],
    ];
    const [moveX, moveY, moveZ] = AFFINE_MOVE.map((index) => matrix[index]);
    return rows.flatMap(([x, y, z]) => [x, y, z, -(x * moveX + y * moveY + z * moveZ)]);
  };

  /**
   * The map from the space a shape is placed in back to the shape's own (before `at`, `scale`, `basis`), as 12
   * numbers row by row: undo the placing matrix, then `at`, then the turn onto `basis`, then the stretch.
   */
  const inversePlacing = (shape, matrix) => {
    const outer = invertAffine(matrix);
    const [atX, atY, atZ] = shape.at || [0, 0, 0];
    const scale = shape.scale || [1, 1, 1];
    const basis = shape.basis || [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const rows = [];
    for (let row = 0; row < VECTOR; row++) {
      const [bx, by, bz] = basis[row];
      for (let column = 0; column < VECTOR; column++) rows.push((bx * outer[column] + by * outer[4 + column] + bz * outer[8 + column]) / scale[row]);
      rows.push((bx * (outer[3] - atX) + by * (outer[7] - atY) + bz * (outer[11] - atZ)) / scale[row]);
    }
    return rows;
  };

  /**
   * A shape's distance function in the space `matrix` places it in. Under a stretch (a `scale`, a bone's dial)
   * the shape's own distance is divided by how fast it changes in the placed space, which is exact at the
   * surface and close near it, so a layer pushed out of a flattened ball stays evenly thick; a kind that
   * states no slope is shrunk by the smallest stretch instead (never overshooting). `deepest`: the solid's
   * half-thickness when known, which bounds the estimate inside it.
   */
  const placedDistance = (shape, matrix, deepest = Infinity) => {
    const make = KINDS[shape.kind];
    if (!make) fail('distanceOf', `no distance for the shape kind "${shape.kind}". Kinds: ${Object.keys(KINDS).join(', ')}.`);
    const measure = make(shape);
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = inversePlacing(shape, matrix);
    const inflate = shape.inflate || 0;
    /** The smallest stretch of the placing: one over the longest row of its inverse. */
    const shrink = 1 / Math.sqrt(Math.max(m0 * m0 + m1 * m1 + m2 * m2, m4 * m4 + m5 * m5 + m6 * m6, m8 * m8 + m9 * m9 + m10 * m10));
    const isEven = Math.abs(m0 * m0 + m1 * m1 + m2 * m2 - (m4 * m4 + m5 * m5 + m6 * m6)) < EPSILON && Math.abs(m0 * m0 + m1 * m1 + m2 * m2 - (m8 * m8 + m9 * m9 + m10 * m10)) < EPSILON;
    if (isEven || !SLOPED[shape.kind]) return (x, y, z) => measure(m0 * x + m1 * y + m2 * z + m3, m4 * x + m5 * y + m6 * z + m7, m8 * x + m9 * y + m10 * z + m11) * shrink - inflate;
    return (x, y, z) => {
      const own = measure(m0 * x + m1 * y + m2 * z + m3, m4 * x + m5 * y + m6 * z + m7, m8 * x + m9 * y + m10 * z + m11);
      // The slope in the placed space is the inverse placing's transpose times the slope in the shape's.
      const sx = SLOPE[0];
      const sy = SLOPE[1];
      const sz = SLOPE[2];
      const px = m0 * sx + m4 * sy + m8 * sz;
      const py = m1 * sx + m5 * sy + m9 * sz;
      const pz = m2 * sx + m6 * sy + m10 * sz;
      // Only the slope's direction is used: a table's slope is short where its section's nearest edge changes.
      const steepness = Math.sqrt((px * px + py * py + pz * pz) / (sx * sx + sy * sy + sz * sz || 1));
      // No slope (the centre of a ball, a point off a section's table): fall back to the safe shrink.
      // Inside, the estimate can run past the solid's middle (a flat ball's slope there says nothing of how
      // thin it is): no point is deeper than the solid is thick.
      return Math.max(steepness > EPSILON ? own / steepness : own * shrink, -deepest) - inflate;
    };
  };

  /**
   * The signed distance function of a shape descriptor (kit/figure-shapes.js `ShapeDescriptor`), honouring its
   * `at`, `scale`, `basis` and `inflate`.
   * @param {Object} shape a `ShapeDescriptor`
   * @returns {function(number, number, number): number} metres, negative inside, in the descriptor's (bone) space
   * @throws {Error} for a kind with no distance function
   * @complexity O(1) to make (O(table) the first time a lathe's or an extrude's section is seen); O(1) per call
   * @example Kit.sculpt.distanceOf({ kind: 'sphere', radius: 0.1, at: [0, 0.2, 0] })(0, 0.2, 0) // -0.1
   */
  const distanceOf = (shape) => placedDistance(shape, IDENTITY);

  // ---- solids: a shape placed in the field's space --------------------------------------------------------------------

  /**
   * @typedef {Object} Solid
   * @property {number} owner who moves it (a bone index): becomes the vertices' skin
   * @property {function(number, number, number): number} distance signed distance in the field's space
   * @property {number[]} min [x, y, z] of its bounds in the field's space
   * @property {number[]} max
   * @property {number} thinness its smallest half-thickness, metres (see `isTooThin`)
   * @property {number} blend how wide a fillet it makes where it meets other solids, metres
   * @property {number} [group=0] solids of one group blend with each other everywhere (the segments of an arm)
   * @property {number[]} [anchor] [x, y, z]: where the solid's group joins the groups sampled before it (a
   *   shoulder). The join's fillet fades to nothing `joinReach` away from here, so an arm hanging beside a
   *   torso stays a separate arm instead of melting into the ribs. Without it the group joins everywhere
   * @property {number} [join] the fillet where the solid's group joins the rest, metres (default: the group's widest `blend`)
   * @property {number} [joinReach] metres from `anchor` over which the join stays full (default: 2.5 x `join`)
   */

  /**
   * Places a shape in the field's space.
   * @param {Object} shape a `ShapeDescriptor`
   * @param {Float32Array|number[]} matrix column-major 4 x 4 from the shape's space to the field's (a bone's rest
   *   transform, `Kit.figure.writeBoneMatrix`)
   * @param {{owner?: number, blend?: number, positions?: Float32Array}} [options] `positions`: points of the
   *   shape's surface in its own space (its built mesh), for the bounds; without them the shape is built at low detail
   * @returns {Solid}
   * @complexity O(surface points) for the bounds
   * @example const forearm = Kit.sculpt.solid({ kind: 'capsule', end: [0, -0.25, 0], radius: 0.04, endRadius: 0.03, at: [0, 0, 0] }, boneMatrix, { owner: 7 });
   */
  const solid = (shape, matrix, { owner = 0, blend = 0, positions } = {}) => {
    const stretches = [0, 1, 2].map((column) => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
    const points = positions || Kit.figure.buildShape(shape, 'low').positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const localMin = [Infinity, Infinity, Infinity];
    const localMax = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < points.length; offset += VECTOR) {
      const [x, y, z] = [points[offset], points[offset + 1], points[offset + 2]];
      for (let axis = 0; axis < VECTOR; axis++) {
        const placed = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        min[axis] = Math.min(min[axis], placed);
        max[axis] = Math.max(max[axis], placed);
        localMin[axis] = Math.min(localMin[axis], points[offset + axis]);
        localMax[axis] = Math.max(localMax[axis], points[offset + axis]);
      }
    }
    const thinness = (Math.min(...[0, 1, 2].map((axis) => (localMax[axis] - localMin[axis]) * stretches[axis])) || 0) / 2;
    return { owner, blend, min, max, thinness, distance: placedDistance(shape, matrix, thinness) };
  };

  /**
   * The grid cell for a set of solids at a level of detail: the level's own, or larger when the solids' longest
   * side would otherwise span more than the level's `most` cells.
   * @param {Solid[]} solids
   * @param {string} [detail='high'] a key of `DETAIL`
   * @returns {number} metres
   * @throws {Error} for an unknown detail
   * @complexity O(solids)
   * @example Kit.sculpt.cellFor(bodySolids, 'high') // 0.011 for a body up to 1.32 m on its longest side
   */
  const cellFor = (solids, detail = 'high') => {
    const level = DETAIL[detail];
    if (!level) fail('cellFor', `no detail "${detail}". Details: ${Object.keys(DETAIL).join(', ')}.`);
    const longest = Math.max(...[0, 1, 2].map((axis) => Math.max(...solids.map((part) => part.max[axis])) - Math.min(...solids.map((part) => part.min[axis]))));
    return Math.max(level.cell, longest / level.most);
  };

  /**
   * Is a solid too thin to be meshed on a grid of this cell (it could fall between the samples)?
   * @param {Solid} part
   * @param {number} cell metres (`cellFor`)
   * @returns {boolean}
   * @complexity O(1)
   * @example Kit.sculpt.isTooThin(earring, Kit.sculpt.cellFor(solids)) // true: draw it as a rigid piece instead
   */
  const isTooThin = (part, cell) => part.thinness * 2 < cell * FEWEST_CELLS_ACROSS;

  // ---- the field: blended distances on a grid -------------------------------------------------------------------------

  /**
   * @typedef {Object} Field
   * @property {Float32Array} values distance at each node, x fastest, then y, then z. Only nodes near a surface
   *   are measured (`band`); the rest hold `FAR` outside the solids and `-FAR` deep inside them
   * @property {Int16Array} nearest index (into the solids sampled) of the solid nearest each measured node, else -1
   * @property {Int32Array} band the measured nodes
   * @property {number} margin the furthest a surface may be pushed out of this field (`surface`'s `offset`), metres
   * @property {number[]} size nodes along [x, y, z]
   * @property {number[]} origin [x, y, z] of node (0, 0, 0)
   * @property {number} cell metres between nodes
   * @property {Solid[]} solids what was sampled
   */

  /** Work arrays of `sample`, kept between calls and grown when a grid needs more: a bake allocates only what it returns. */
  const scratch = { nodes: 0, isBusy: false };
  /** Fresh work arrays for a grid of `count` nodes. */
  const scratchOf = (count) => ({
    nodes: count,
    /** Per group: the nearest and second nearest member at a node, and which group last wrote them. */
    own: new Float32Array(count),
    second: new Float32Array(count),
    ownIndex: new Int16Array(count),
    secondIndex: new Int16Array(count),
    stamp: new Uint16Array(count),
    /** The plain distance of the nearest solid of any group so far, to decide `nearest`. */
    nearestDistance: new Float32Array(count),
    inside: new Uint8Array(count),
    isListed: new Uint8Array(count),
    vertexOf: new Int32Array(count),
  });
  /**
   * The work arrays for a grid of `count` nodes: the kept ones, grown when needed. While a sampling in steps
   * (`sampleSteps`) is under way they are its own, and anything else sampled meanwhile gets arrays of its own.
   */
  const scratchFor = (count, isSampling = false) => {
    if (isSampling && scratch.isBusy) return scratchOf(count);
    if (scratch.nodes < count) Object.assign(scratch, scratchOf(count));
    return scratch;
  };

  /**
   * A typed list that grows by doubling: `items[0, count)` are what was pushed.
   * @param {new (length: number) => any} Type a typed array constructor
   * @param {number} capacity items to start with room for
   * @returns {{items: Object, count: number, push: function(number): void, taken: function(): Object}} `taken`: a view of exactly what was pushed
   */
  const growingList = (Type, capacity) => {
    const list = {
      items: new Type(capacity),
      count: 0,
      push: (value) => {
        if (list.count === list.items.length) {
          const grown = new Type(list.items.length * 2);
          grown.set(list.items);
          list.items = grown;
        }
        list.items[list.count++] = value;
      },
      taken: () => list.items.subarray(0, list.count),
    };
    return list;
  };

  /**
   * Samples solids into a field: the blended distance to all of them at every grid node near a surface. The
   * grid is walked in blocks that are halved down to single nodes only where a surface can pass (a distance
   * changes by at most a metre per metre, so one measurement at a block's centre rules the whole block in or
   * out), and each block measures only the solids that can matter inside it: the cost follows the solids'
   * surface area, not the grid's volume.
   *
   * Solids of one `group` blend with a fillet where their surfaces cross, and not where they run side by side
   * (a waist inside a chest; a plain rounded minimum would swell there and ripple the body). A group then joins
   * the groups before it near its `anchor`.
   * @param {Solid[]} solids
   * @param {{detail?: string, cell?: number, margin?: number}} [options] `detail`: a key of `DETAIL` (default
   *   'high'); `cell` overrides the cell `cellFor` gives; `margin`: the furthest a surface will be pushed out of this field
   *   (`surface`'s `offset`), metres (default 0)
   * @returns {Generator<undefined, Field, undefined>} yields after every slab of blocks (a few milliseconds each), so a
   *   caller can spread the work over frames; its return value is the field
   * @throws {Error} with no solids, or when the grid would exceed `MOST_NODES`
   * @complexity O(surface area / cell^2 x band width in cells x solids near a node) distance evaluations;
   *   O(nodes) memory (one float and one short per node returned)
   * @example const steps = Kit.sculpt.sampleSteps(bodySolids, { margin: 0.03 }); let step = steps.next(); while (!step.done) step = steps.next(); const field = step.value;
   */
  function* sampleSteps(solids, { detail = 'high', cell: givenCell, margin = 0 } = {}) {
    if (!solids.length) fail('sample', 'needs at least one solid.');
    const cell = givenCell || cellFor(solids, detail);
    /** Values are wanted from `lowest` (inside) to `highest` (outside): the surfaces asked for, plus the nodes their normals read. */
    const lowest = -BAND_CELLS * cell;
    const highest = margin + BAND_CELLS * cell;
    const reach = highest + cell;
    const low = [0, 1, 2].map((axis) => Math.min(...solids.map((part) => part.min[axis])) - reach);
    const high = [0, 1, 2].map((axis) => Math.max(...solids.map((part) => part.max[axis])) + reach);
    const size = low.map((value, axis) => Math.ceil((high[axis] - value) / cell) + 1);
    const count = size[0] * size[1] * size[2];
    if (count > MOST_NODES) fail('sample', `the grid would have ${count} nodes (${size.join(' x ')} at ${cell} m); a solid is much larger than the rest, or the detail is too fine.`);
    const values = new Float32Array(count).fill(FAR);
    const nearest = new Int16Array(count).fill(-1);
    const work = scratchFor(count, true);
    const isOwner = work === scratch;
    if (isOwner) scratch.isBusy = true;
    const { own, second, ownIndex, secondIndex, stamp, nearestDistance } = work;
    stamp.fill(0, 0, count);
    try {
      const [sizeX, sizeY] = size;
      const [lowX, lowY, lowZ] = low;
      const band = growingList(Int32Array, 1 << 14);
      /** Candidate solids of the block being walked, one run per depth of the walk. */
      const candidates = new Int32Array(solids.length * (Math.ceil(Math.log2(BLOCK)) + 3));
      const centreDistance = new Float64Array(solids.length);
      const groupIds = [...new Set(solids.map((part) => part.group || 0))];

      for (let groupOrder = 0; groupOrder < groupIds.length; groupOrder++) {
        const groupId = groupIds[groupOrder];
        const members = solids.map((_part, index) => index).filter((index) => (solids[index].group || 0) === groupId);
        const lead = solids[members[0]];
        const joinBlend = lead.join === undefined ? Math.max(...members.map((index) => solids[index].blend)) : lead.join;
        const joinReach = lead.joinReach || joinBlend * JOIN_REACH;
        const anchor = groupOrder > 0 ? lead.anchor : null;
        // A fillet pulls a value down by at most a quarter of its width, which the band's own reach past the
        // surfaces (`BAND_CELLS`) already covers for the nodes a surface's position depends on.
        const groupHighest = highest;
        const mark = groupOrder + 1;
        const written = growingList(Int32Array, 1 << 12);

        /** Measures one node against the candidates in `candidates[from, to)`. */
        const measureNode = (nodeX, nodeY, nodeZ, from, to) => {
          const x = lowX + nodeX * cell;
          const y = lowY + nodeY * cell;
          const z = lowZ + nodeZ * cell;
          let first = FAR;
          let other = FAR;
          let firstIndex = -1;
          let otherIndex = -1;
          for (let slot = from; slot < to; slot++) {
            const index = candidates[slot];
            const distance = solids[index].distance(x, y, z);
            if (distance < first) {
              other = first;
              otherIndex = firstIndex;
              first = distance;
              firstIndex = index;
            } else if (distance < other) {
              other = distance;
              otherIndex = index;
            }
          }
          const node = nodeX + sizeX * (nodeY + sizeY * nodeZ);
          own[node] = first;
          second[node] = other;
          ownIndex[node] = firstIndex;
          secondIndex[node] = otherIndex;
          stamp[node] = mark;
          written.push(node);
        };

        /** Fills a block of nodes that lie deep inside the group. */
        const bury = (fromX, fromY, fromZ, toX, toY, toZ) => {
          for (let nodeZ = fromZ; nodeZ < toZ; nodeZ++) for (let nodeY = fromY; nodeY < toY; nodeY++) values.fill(-FAR, fromX + sizeX * (nodeY + sizeY * nodeZ), toX + sizeX * (nodeY + sizeY * nodeZ));
        };

        /**
         * Walks the block of nodes [from, to) on each axis: measures its centre, drops the block when no surface
         * of interest can pass through it, else halves it. `candidates[from, to)` are the solids that matter here.
         */
        const walk = (fromX, fromY, fromZ, toX, toY, toZ, from, to) => {
          const spanX = toX - fromX;
          const spanY = toY - fromY;
          const spanZ = toZ - fromZ;
          if (spanX === 1 && spanY === 1 && spanZ === 1) return measureNode(fromX, fromY, fromZ, from, to);
          const x = lowX + (fromX + (spanX - 1) / 2) * cell;
          const y = lowY + (fromY + (spanY - 1) / 2) * cell;
          const z = lowZ + (fromZ + (spanZ - 1) / 2) * cell;
          /** No distance at a node of the block differs from the centre's by more than this. */
          const halfDiagonal = (Math.sqrt((spanX - 1) * (spanX - 1) + (spanY - 1) * (spanY - 1) + (spanZ - 1) * (spanZ - 1)) * cell * STEEPEST) / 2;
          let closest = Infinity;
          for (let slot = from; slot < to; slot++) {
            const distance = solids[candidates[slot]].distance(x, y, z);
            centreDistance[candidates[slot]] = distance;
            if (distance < closest) closest = distance;
          }
          if (closest - halfDiagonal > groupHighest) return undefined;
          if (closest + halfDiagonal < lowest) return bury(fromX, fromY, fromZ, toX, toY, toZ);
          // A solid further than its fillet beyond the closest, anywhere in the block, changes nothing in it.
          let kept = to;
          for (let slot = from; slot < to; slot++) {
            const index = candidates[slot];
            if (centreDistance[index] - halfDiagonal <= Math.min(closest + halfDiagonal + solids[index].blend, groupHighest + solids[index].blend)) candidates[kept++] = index;
          }
          const midX = fromX + ((spanX + 1) >> 1);
          const midY = fromY + ((spanY + 1) >> 1);
          const midZ = fromZ + ((spanZ + 1) >> 1);
          for (let part = 0; part < CORNER_COUNT; part++) {
            const startX = part & 1 ? midX : fromX;
            const endX = part & 1 ? toX : midX;
            const startY = part & 2 ? midY : fromY;
            const endY = part & 2 ? toY : midY;
            const startZ = part & 4 ? midZ : fromZ;
            const endZ = part & 4 ? toZ : midZ;
            if (startX < endX && startY < endY && startZ < endZ) walk(startX, startY, startZ, endX, endY, endZ, to, kept);
          }
          return undefined;
        };

        // The group's own bounds, in nodes, walked block by block.
        const pad = groupHighest + cell;
        const boxFrom = [0, 1, 2].map((axis) => Math.max(0, Math.floor((Math.min(...members.map((index) => solids[index].min[axis])) - pad - low[axis]) / cell)));
        const boxTo = [0, 1, 2].map((axis) => Math.min(size[axis], Math.ceil((Math.max(...members.map((index) => solids[index].max[axis])) + pad - low[axis]) / cell) + 1));
        candidates.set(members, 0);
        for (let blockZ = boxFrom[2]; blockZ < boxTo[2]; blockZ += BLOCK) {
          for (let blockY = boxFrom[1]; blockY < boxTo[1]; blockY += BLOCK) {
            for (let blockX = boxFrom[0]; blockX < boxTo[0]; blockX += BLOCK)
              walk(blockX, blockY, blockZ, Math.min(blockX + BLOCK, boxTo[0]), Math.min(blockY + BLOCK, boxTo[1]), Math.min(blockZ + BLOCK, boxTo[2]), 0, members.length);
          }
          // A slab of blocks is a few milliseconds of work: a caller that must stay responsive pauses here.
          yield undefined;
        }

        /** A member's distance one node further along an axis: read from that node when it measured the member, else measured. */
        const beside = (index, node, step, x, y, z) => {
          const next = node + step;
          if (next < count && stamp[next] === mark) {
            if (ownIndex[next] === index) return own[next];
            if (secondIndex[next] === index) return second[next];
          }
          return solids[index].distance(x, y, z);
        };
        const stepZ = sizeX * sizeY;
        // Second pass over the nodes measured: fillet the two nearest members where their surfaces cross, then
        // join the group to what is already there (fully near its anchor, not at all far from it).
        for (let item = 0; item < written.count; item++) {
          const node = written.items[item];
          const first = own[node];
          if (nearest[node] < 0 || first < nearestDistance[node]) {
            nearestDistance[node] = first;
            nearest[node] = ownIndex[node];
          }
          if (values[node] === -FAR) continue;
          let distance = first;
          const other = second[node];
          const indexA = ownIndex[node];
          const indexB = secondIndex[node];
          const radius = indexB < 0 ? 0 : Math.min(solids[indexA].blend, solids[indexB].blend);
          const nodeZ = Math.floor(node / stepZ);
          const nodeY = Math.floor((node - nodeZ * stepZ) / sizeX);
          const x = lowX + (node - nodeZ * stepZ - nodeY * sizeX) * cell;
          const y = lowY + nodeY * cell;
          const z = lowZ + nodeZ * cell;
          if (other - first < radius) {
            const ax = beside(indexA, node, 1, x + cell, y, z) - first;
            const ay = beside(indexA, node, sizeX, x, y + cell, z) - first;
            const az = beside(indexA, node, stepZ, x, y, z + cell) - first;
            const bx = beside(indexB, node, 1, x + cell, y, z) - other;
            const by = beside(indexB, node, sizeX, x, y + cell, z) - other;
            const bz = beside(indexB, node, stepZ, x, y, z + cell) - other;
            const alignment = (ax * bx + ay * by + az * bz) / (Math.sqrt((ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz)) || 1);
            const grooveDepth = Math.min(solids[indexA].thinness, solids[indexB].thinness) * (1 - Math.sqrt(Math.max(0, 1 + alignment) / 2));
            distance = smoothMin(first, other, Math.min(radius, GROOVE_FILL * grooveDepth));
          }
          const before = values[node];
          if (before === FAR) {
            values[node] = distance;
            band.push(node);
            continue;
          }
          const away = anchor ? Math.sqrt((x - anchor[0]) * (x - anchor[0]) + (y - anchor[1]) * (y - anchor[1]) + (z - anchor[2]) * (z - anchor[2])) : 0;
          values[node] = smoothMin(before, distance, joinBlend * Math.max(0, Math.min(1, 2 - away / joinReach)));
        }
      }
      return { values, nearest, band: band.taken(), margin, size, origin: low, cell, solids };
    } finally {
      // Also when the caller gives the steps up half way.
      if (isOwner) scratch.isBusy = false;
    }
  }

  /**
   * `sampleSteps` run to its end in one go (see it for the method).
   * @param {Solid[]} solids
   * @param {{detail?: string, cell?: number, margin?: number}} [options] as `sampleSteps`
   * @returns {Field}
   * @throws {Error} with no solids, or when the grid would exceed `MOST_NODES`
   * @complexity as `sampleSteps`
   * @example const field = Kit.sculpt.sample(bodySolids, { detail: 'medium', margin: 0.03 });
   */
  const sample = (solids, options) => {
    const steps = sampleSteps(solids, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  };

  /**
   * The field's value at any point, by blending the eight nodes round it.
   * @param {Field} field
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} metres; meaningless (a blend with `FAR`) further than the field's band from its surfaces
   * @complexity O(1)
   * @example Kit.sculpt.valueAt(field, 0, 1.2, 0) < 0 // inside the chest
   */
  const valueAt = (field, x, y, z) => {
    // Called several times per vertex and per triangle: plain locals, nothing allocated.
    const values = field.values;
    const size = field.size;
    const origin = field.origin;
    const cell = field.cell;
    const gridX = (x - origin[0]) / cell;
    const gridY = (y - origin[1]) / cell;
    const gridZ = (z - origin[2]) / cell;
    const nodeX = Math.max(0, Math.min(size[0] - 2, Math.floor(gridX)));
    const nodeY = Math.max(0, Math.min(size[1] - 2, Math.floor(gridY)));
    const nodeZ = Math.max(0, Math.min(size[2] - 2, Math.floor(gridZ)));
    const shareX = gridX - nodeX;
    const shareY = gridY - nodeY;
    const stepY = size[0];
    const stepZ = size[0] * size[1];
    const node = nodeX + stepY * nodeY + stepZ * nodeZ;
    const lowNear = values[node] + (values[node + 1] - values[node]) * shareX;
    const lowFar = values[node + stepY] + (values[node + stepY + 1] - values[node + stepY]) * shareX;
    const highNear = values[node + stepZ] + (values[node + stepZ + 1] - values[node + stepZ]) * shareX;
    const highFar = values[node + stepZ + stepY] + (values[node + stepZ + stepY + 1] - values[node + stepZ + stepY]) * shareX;
    const low = lowNear + (lowFar - lowNear) * shareY;
    const high = highNear + (highFar - highNear) * shareY;
    return low + (high - low) * (gridZ - nodeZ);
  };

  /**
   * Which solid is nearest a point. A node knows its nearest solid; where the nodes round a point disagree (it
   * is near the border between two solids), the solids they name are measured at the point itself, so the
   * border is as smooth as the solids and not stepped like the grid.
   * @param {Field} field
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} index into `field.solids`, or -1 where no node round the point was measured
   * @complexity O(1): eight lookups, and up to eight distance evaluations near a border
   * @example const bone = field.solids[Kit.sculpt.nearestAt(field, x, y, z)].owner;
   */
  const nearestAt = (field, x, y, z) => {
    const nearest = field.nearest;
    const size = field.size;
    const origin = field.origin;
    const cell = field.cell;
    const nodeX = Math.max(0, Math.min(size[0] - 2, Math.floor((x - origin[0]) / cell)));
    const nodeY = Math.max(0, Math.min(size[1] - 2, Math.floor((y - origin[1]) / cell)));
    const nodeZ = Math.max(0, Math.min(size[2] - 2, Math.floor((z - origin[2]) / cell)));
    const stepY = size[0];
    const stepZ = size[0] * size[1];
    const node = nodeX + stepY * nodeY + stepZ * nodeZ;
    let best = -1;
    let bestDistance = Infinity;
    let isAgreed = true;
    for (let corner = 0; corner < CORNER_COUNT; corner++) {
      const index = nearest[node + (corner & 1) + ((corner >> 1) & 1) * stepY + (corner >> 2) * stepZ];
      if (index < 0 || index === best) continue;
      if (best < 0) {
        best = index;
        continue;
      }
      // A second solid is named: from here on every named solid is measured at the point.
      if (isAgreed) bestDistance = field.solids[best].distance(x, y, z);
      isAgreed = false;
      const distance = field.solids[index].distance(x, y, z);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  };

  /**
   * The slope of the field at a point: that of the blend of the eight nodes round it (`valueAt`), so it reads
   * no node `valueAt` would not. Not unit length.
   * @param {Field} field
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number[]|Float64Array} out receives [x, y, z], metres per metre
   * @returns {number[]|Float64Array} `out`
   * @complexity O(1)
   * @example Kit.sculpt.slopeAt(field, 0.2, 1.2, 0, [0, 0, 0]) // about [1, 0, 0] on the right side of a chest
   */
  const slopeAt = (field, x, y, z, out) => {
    const values = field.values;
    const size = field.size;
    const origin = field.origin;
    const cell = field.cell;
    const gridX = (x - origin[0]) / cell;
    const gridY = (y - origin[1]) / cell;
    const gridZ = (z - origin[2]) / cell;
    const nodeX = Math.max(0, Math.min(size[0] - 2, Math.floor(gridX)));
    const nodeY = Math.max(0, Math.min(size[1] - 2, Math.floor(gridY)));
    const nodeZ = Math.max(0, Math.min(size[2] - 2, Math.floor(gridZ)));
    const shareX = gridX - nodeX;
    const shareY = gridY - nodeY;
    const shareZ = gridZ - nodeZ;
    const stepY = size[0];
    const stepZ = size[0] * size[1];
    const node = nodeX + stepY * nodeY + stepZ * nodeZ;
    const v000 = values[node];
    const v100 = values[node + 1];
    const v010 = values[node + stepY];
    const v110 = values[node + stepY + 1];
    const v001 = values[node + stepZ];
    const v101 = values[node + stepZ + 1];
    const v011 = values[node + stepZ + stepY];
    const v111 = values[node + stepZ + stepY + 1];
    // Each component: the change along its axis, blended over the other two.
    out[0] = (((v100 - v000) * (1 - shareY) + (v110 - v010) * shareY) * (1 - shareZ) + ((v101 - v001) * (1 - shareY) + (v111 - v011) * shareY) * shareZ) / cell;
    out[1] = (((v010 - v000) * (1 - shareX) + (v110 - v100) * shareX) * (1 - shareZ) + ((v011 - v001) * (1 - shareX) + (v111 - v101) * shareX) * shareZ) / cell;
    out[2] = (((v001 - v000) * (1 - shareX) + (v101 - v100) * shareX) * (1 - shareY) + ((v011 - v010) * (1 - shareX) + (v111 - v110) * shareX) * shareY) / cell;
    return out;
  };

  // ---- the surface: surface nets --------------------------------------------------------------------------------------

  /** The eight corners of a cell as node offsets (x, y, z), and its twelve edges as corner pairs. */
  /** Most sweeps that part chequered faces of the grid; one nearly always does, and a later one mends what it made. */
  const CHEQUER_PASSES = 6;
  const CORNERS = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const FULL_MASK = (1 << CORNER_COUNT) - 1;

  /**
   * @typedef {Object} SurfaceArrays
   * @property {Float32Array} positions 3 per vertex, in the field's space
   * @property {Float32Array} normals 3 per vertex, unit length, outward
   * @property {Uint16Array|Uint32Array} indices 3 per triangle
   */

  /**
   * The surface of a field as a mesh, by surface nets: one vertex in every grid cell the surface passes
   * through, placed at the average of where the surface crosses the cell's edges and then moved onto the
   * field's true surface, and one quad across every grid edge it crosses. The mesh is closed, evenly
   * tessellated and smooth where the field is.
   *
   * `offset` pushes the surface out (a layer of cloth over a body is the body's field at a positive offset, at
   * most the field's `margin`). `cut(x, y, z)` keeps only the part of the solid where it returns true. The
   * cut's edge is found by bisection along each grid edge, and a vertex where the cut meets the surface (a hem,
   * a hairline) is placed on the cut itself, so an edge is as crisp as the predicate, not as coarse as the
   * grid. A cut solid is a shell: it reaches `depth` below the field's own surface and is hollow beneath, and
   * faces wholly deeper than that are dropped (a layer does not carry what is buried in the body it lies on).
   * `walls: false` also drops the faces a cut makes through the thickness, leaving an open sheet that lies on
   * the surface (paint, not cloth).
   * @param {Field} field
   * @param {{offset?: number, cut?: function(number, number, number): boolean, near?: ArrayLike<number>, depth?: number, walls?: boolean}} [options]
   *   `depth`: metres (default 0.002), used only with a `cut`; `near`: per solid of the field, non-zero when the
   *   cut can hold at points nearest that solid (a sleeve's cut holds only near the arm's solids): the cut is
   *   then not asked anywhere else, which is most of a body
   * @returns {SurfaceArrays}
   * @complexity O(nodes of the field's band) time (a `cut` is called once per band node within the shell, and 7
   *   times per grid edge it crosses); O(surface cells) memory for the mesh
   * @example const skin = Kit.sculpt.surface(field); const sleeve = Kit.sculpt.surface(field, { offset: 0.008, cut: isSleeve });
   */
  const surface = (field, { offset = 0, cut = null, near = null, depth = 0.002, walls = true } = {}) => {
    const { values, size, origin, cell, band, nearest } = field;
    if (offset > field.margin + EPSILON) fail('surface', `an offset of ${offset} m is past the field's margin of ${field.margin} m; sample the field with { margin: ${offset} } or more.`);
    const [sizeX, sizeY, sizeZ] = size;
    const [stepY, stepZ] = [sizeX, sizeX * sizeY];
    const [originX, originY, originZ] = origin;
    const count = values.length;
    const { inside, vertexOf, isListed } = scratchFor(count);
    /** A cut solid is hollow below this value of the field. */
    const floor = -depth - cell * ROOT_THREE;
    /** How far a node's value may be from that of a surface through one of its cells: a diagonal, with room for a blend steeper than a true distance. */
    const reach = cell * BAND_CELLS;
    /** Node offsets of a cell's corners from its lowest node, and each corner's place in the cell (0 or 1 per axis). */
    const cornerStep = Int32Array.from(CORNERS, ([x, y, z]) => x + y * stepY + z * stepZ);
    const cornerPlace = Float64Array.from(CORNERS.flat());
    const edgeEnds = Uint8Array.from(EDGES.flat());
    /** The cells a surface may pass through, by their lowest node (the same nodes are those whose edges it may cross). */
    const cells = growingList(Int32Array, 1 << 13);

    // Which nodes are inside the solid, and which cells can hold its surface. Uncut: the field pushed out, and
    // the cells within a diagonal of it. Cut: the nodes within the shell where the cut holds (it is called
    // only there), and the eight cells round each.
    if (cut) {
      inside.fill(0, 0, count);
      isListed.fill(0, 0, count);
      for (let item = 0; item < band.length; item++) {
        const node = band[item];
        const value = values[node];
        if (value >= offset || value < floor || (near && !near[nearest[node]])) continue;
        const nodeZ = Math.floor(node / stepZ);
        const nodeY = Math.floor((node - nodeZ * stepZ) / stepY);
        if (!cut(originX + (node - nodeZ * stepZ - nodeY * stepY) * cell, originY + nodeY * cell, originZ + nodeZ * cell)) continue;
        inside[node] = 1;
        for (let index = 0; index < CORNER_COUNT; index++) {
          const base = node - cornerStep[index];
          if (base < 0 || isListed[base]) continue;
          isListed[base] = 1;
          cells.push(base);
        }
      }
    } else {
      for (let node = 0; node < count; node++) inside[node] = values[node] < offset ? 1 : 0;
      for (let item = 0; item < band.length; item++) if (Math.abs(values[band[item]] - offset) <= reach) cells.push(band[item]);
    }

    // Two sheets of the surface through one face of a cell (its corners inside and outside in a chequer: a gap
    // or a web thinner than a cell) would meet in one edge shared by four triangles. The corner nearest the
    // surface changes side, which parts the sheets or joins them, whichever moves the surface least.
    const faceSteps = [1, stepY, stepY, stepZ, stepZ, 1];
    for (let pass = 0, changed = 1; pass < CHEQUER_PASSES && changed > 0; pass++) {
      changed = 0;
      for (let item = 0; item < cells.count; item++) {
        const base = cells.items[item];
        for (let face = 0; face < faceSteps.length; face += 2) {
          const far = base + faceSteps[face] + faceSteps[face + 1];
          if (far >= count || inside[base] !== inside[far]) continue;
          const sideA = base + faceSteps[face];
          const sideB = base + faceSteps[face + 1];
          if (inside[sideA] !== inside[sideB] || inside[sideA] === inside[base]) continue;
          let turned = base;
          if (Math.abs(values[far] - offset) < Math.abs(values[turned] - offset)) turned = far;
          if (Math.abs(values[sideA] - offset) < Math.abs(values[turned] - offset)) turned = sideA;
          if (Math.abs(values[sideB] - offset) < Math.abs(values[turned] - offset)) turned = sideB;
          inside[turned] = 1 - inside[turned];
          changed += 1;
          if (!cut) continue;
          for (let index = 0; index < CORNER_COUNT; index++) {
            const beside = turned - cornerStep[index];
            if (beside < 0 || isListed[beside]) continue;
            isListed[beside] = 1;
            cells.push(beside);
          }
        }
      }
    }

    /** Where along a grid edge (0 at `from`, 1 at `to`) the cut's boundary crosses it, by bisection. */
    const cutCrossing = (startsInside, fromX, fromY, fromZ, toX, toY, toZ) => {
      let low = 0;
      let high = 1;
      for (let step = 0; step < CUT_STEPS; step++) {
        const middle = (low + high) / 2;
        if (cut(fromX + (toX - fromX) * middle, fromY + (toY - fromY) * middle, fromZ + (toZ - fromZ) * middle) === startsInside) low = middle;
        else high = middle;
      }
      return (low + high) / 2;
    };

    const positions = growingList(Float32Array, 1 << 13);
    /** Per vertex: 1 when it sits where a cut meets the pushed-out surface (it is then moved onto that surface whatever its distance). */
    const rims = growingList(Uint8Array, 1 << 11);
    /** Vertex index per cell, -1 where the surface does not pass; cells are indexed like their lowest node. */
    vertexOf.fill(-1, 0, count);
    // Hot loop over the cells: index arithmetic over typed arrays, nothing allocated per cell.
    for (let item = 0; item < cells.count; item++) {
      const base = cells.items[item];
      const cellZ = Math.floor(base / stepZ);
      const cellY = Math.floor((base - cellZ * stepZ) / stepY);
      const cellX = base - cellZ * stepZ - cellY * stepY;
      if (cellX >= sizeX - 1 || cellY >= sizeY - 1 || cellZ >= sizeZ - 1) continue;
      let mask = 0;
      for (let index = 0; index < CORNER_COUNT; index++) mask |= inside[base + cornerStep[index]] << index;
      if (mask === 0 || mask === FULL_MASK) continue;
      // Crossings of the cut are averaged apart from the rest (the field's surface, or a shell's floor).
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let crossings = 0;
      let cutX = 0;
      let cutY = 0;
      let cutZ = 0;
      let cutCrossings = 0;
      let isOnSurface = false;
      for (let edge = 0; edge < edgeEnds.length; edge += 2) {
        const cornerA = edgeEnds[edge];
        const cornerB = edgeEnds[edge + 1];
        const valueA = values[base + cornerStep[cornerA]];
        const valueB = values[base + cornerStep[cornerB]];
        const first = valueA - offset;
        const second = valueB - offset;
        if (first >= 0 || second >= 0) isOnSurface = true;
        if (((mask >> cornerA) & 1) === ((mask >> cornerB) & 1)) continue;
        const ax = originX + (cellX + cornerPlace[cornerA * VECTOR]) * cell;
        const ay = originY + (cellY + cornerPlace[cornerA * VECTOR + 1]) * cell;
        const az = originZ + (cellZ + cornerPlace[cornerA * VECTOR + 2]) * cell;
        const bx = originX + (cellX + cornerPlace[cornerB * VECTOR]) * cell;
        const by = originY + (cellY + cornerPlace[cornerB * VECTOR + 1]) * cell;
        const bz = originZ + (cellZ + cornerPlace[cornerB * VECTOR + 2]) * cell;
        // Both ends inside the pushed-out field and above the shell's floor: only the cut can part them.
        if (cut && first < 0 && second < 0 && valueA >= floor && valueB >= floor) {
          const share = cutCrossing(((mask >> cornerA) & 1) === 1, ax, ay, az, bx, by, bz);
          cutX += ax + (bx - ax) * share;
          cutY += ay + (by - ay) * share;
          cutZ += az + (bz - az) * share;
          cutCrossings += 1;
          continue;
        }
        // The field's surface crosses where its value passes the offset; a shell's floor (both ends inside the field) is taken at the middle.
        const span = first - second;
        const share = first < 0 === second < 0 || Math.abs(span) < EPSILON ? 0.5 : Math.max(0, Math.min(1, first / span));
        sumX += ax + (bx - ax) * share;
        sumY += ay + (by - ay) * share;
        sumZ += az + (bz - az) * share;
        crossings += 1;
      }
      vertexOf[base] = rims.count;
      // A cell the cut passes through puts its vertex on the cut: a hem then follows the cut, not the grid.
      positions.push(cutCrossings ? cutX / cutCrossings : sumX / crossings);
      positions.push(cutCrossings ? cutY / cutCrossings : sumY / crossings);
      positions.push(cutCrossings ? cutZ / cutCrossings : sumZ / crossings);
      rims.push(cutCrossings && isOnSurface ? 1 : 0);
    }

    const indices = growingList(Uint32Array, 1 << 14);
    /** Per triangle: 1 when it lies along the field's surface, 0 when it is a cut's wall (or a shell's floor). */
    const alongs = growingList(Uint8Array, 1 << 12);
    /**
     * A quad across the grid edge leaving `node` along an axis (`step` to its other end), joining the four cells
     * that share the edge. It lies along the surface when the field itself puts the edge's outer end outside.
     */
    const quad = (node, step, stepA, stepB) => {
      const first = vertexOf[node - stepA - stepB];
      const second = vertexOf[node - stepB];
      const third = vertexOf[node];
      const fourth = vertexOf[node - stepA];
      if (first < 0 || second < 0 || third < 0 || fourth < 0) return;
      const startsInside = inside[node] === 1;
      indices.push(first);
      indices.push(startsInside ? second : third);
      indices.push(startsInside ? third : second);
      indices.push(first);
      indices.push(startsInside ? third : fourth);
      indices.push(startsInside ? fourth : third);
      const along = values[startsInside ? node + step : node] >= offset ? 1 : 0;
      alongs.push(along);
      alongs.push(along);
    };
    for (let item = 0; item < cells.count; item++) {
      const node = cells.items[item];
      const nodeZ = Math.floor(node / stepZ);
      const nodeY = Math.floor((node - nodeZ * stepZ) / stepY);
      const nodeX = node - nodeZ * stepZ - nodeY * stepY;
      if (nodeX < 1 || nodeY < 1 || nodeZ < 1 || nodeX >= sizeX - 1 || nodeY >= sizeY - 1 || nodeZ >= sizeZ - 1) continue;
      const here = inside[node];
      // Along x the edge is shared by the cells at (y - 1, z - 1), (y, z - 1), (y, z), (y - 1, z); likewise y and z.
      if (here !== inside[node + 1]) quad(node, 1, stepY, stepZ);
      if (here !== inside[node + stepY]) quad(node, stepY, stepZ, 1);
      if (here !== inside[node + stepZ]) quad(node, stepZ, 1, stepY);
    }

    // A cut layer keeps the faces that are not buried in what it lies on; paint keeps only those along the surface.
    const faces = cut ? keptFaces(field, positions.taken(), indices.taken(), alongs.taken(), -depth, walls) : { indices: indices.taken(), alongs: null };
    const mesh = compact(positions.taken(), rims.taken(), faces.indices);
    const isAlong = walls ? faces.alongs : null;
    settle(field, mesh.positions, offset, smoothVertices(mesh.positions.length / VECTOR, mesh.indices, isAlong), mesh.rims);
    const { normals, isSmooth } = normalsOf(mesh.positions, mesh.indices, isAlong);
    const passes = Math.max(NORMAL_SMOOTHING.least, Math.min(NORMAL_SMOOTHING.most, Math.round(NORMAL_SMOOTHING.reach / cell)));
    for (let pass = 0; pass < passes; pass++) smoothNormals(normals, mesh.indices, isSmooth);
    return { positions: mesh.positions, normals, indices: mesh.positions.length / VECTOR > MOST_SHORT_INDEX ? mesh.indices : Uint16Array.from(mesh.indices) };
  };

  /** A vertex off a cut's rim is on the smooth part of a surface when the field there is within this share of a cell of the surface. */
  const ON_SURFACE_SHARE = 0.9;
  /** Times a vertex is moved along its normal onto the surface (each step is exact for a flat field). */
  const SETTLE_STEPS = 2;
  /** A vertex's own share when its normal is averaged with its neighbours' (about a third of the sum on an even mesh). */
  const SELF_WEIGHT = 6;
  /** The largest vertex index a 16-bit index buffer can hold. */
  const MOST_SHORT_INDEX = 65535;

  /** Copies out the vertices some triangle uses, keeping their order, and renumbers the triangles. */
  const compact = (positions, rims, indices) => {
    const count = positions.length / VECTOR;
    const renumbered = new Int32Array(count).fill(-1);
    let used = 0;
    for (let corner = 0; corner < indices.length; corner++) renumbered[indices[corner]] = 0;
    for (let vertex = 0; vertex < count; vertex++) if (renumbered[vertex] === 0) renumbered[vertex] = used++;
    const packed = new Float32Array(used * VECTOR);
    const packedRims = new Uint8Array(used);
    for (let vertex = 0; vertex < count; vertex++) {
      const to = renumbered[vertex];
      if (to < 0) continue;
      packed[to * VECTOR] = positions[vertex * VECTOR];
      packed[to * VECTOR + 1] = positions[vertex * VECTOR + 1];
      packed[to * VECTOR + 2] = positions[vertex * VECTOR + 2];
      packedRims[to] = rims[vertex];
    }
    const renumberedIndices = new Uint32Array(indices.length);
    for (let corner = 0; corner < indices.length; corner++) renumberedIndices[corner] = renumbered[indices[corner]];
    return { positions: packed, rims: packedRims, indices: renumberedIndices };
  };

  /** Per vertex: 1 when some triangle along the surface uses it (every used vertex, without `isAlong`). */
  const smoothVertices = (count, indices, isAlong) => {
    const isSmooth = new Uint8Array(count);
    for (let corner = 0; corner < indices.length; corner++) if (!isAlong || isAlong[Math.floor(corner / VECTOR)]) isSmooth[indices[corner]] = 1;
    return isSmooth;
  };

  /** A triangle's normal, as long as twice its area, into `out`; `a`, `b`, `c` are its corners' offsets in `positions`. */
  const faceNormal = (positions, a, b, c, out) => {
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    out[0] = uy * vz - uz * vy;
    out[1] = uz * vx - ux * vz;
    out[2] = ux * vy - uy * vx;
  };

  /**
   * Moves each vertex of the smooth surface onto the field's true surface, along the field's slope. Surface
   * nets place a vertex at an average inside its cell, which leaves a faint faceting; the field itself is
   * smooth. Vertices on a cut's wall (a hem's thickness) are left as they are; those on its rim are moved up
   * onto the surface, which keeps them on the cut (a cut runs through the thickness, along the slope).
   */
  const settle = (field, positions, offset, isSmooth, rims) => {
    /** Never further than the band reaches: past it the field is not measured. */
    const most = field.cell * BAND_CELLS * 0.5;
    const slope = new Float64Array(VECTOR);
    for (let vertex = 0; vertex < positions.length; vertex += VECTOR) {
      if (!isSmooth[vertex / VECTOR]) continue;
      const isRim = rims[vertex / VECTOR] === 1;
      for (let pass = 0; pass < SETTLE_STEPS; pass++) {
        const error = valueAt(field, positions[vertex], positions[vertex + 1], positions[vertex + 2]) - offset;
        if (!isRim && Math.abs(error) > field.cell * ON_SURFACE_SHARE) break;
        slopeAt(field, positions[vertex], positions[vertex + 1], positions[vertex + 2], slope);
        const steepness = slope[0] * slope[0] + slope[1] * slope[1] + slope[2] * slope[2];
        if (steepness < EPSILON) break;
        // A step of error / steepness along the slope lands on the surface of a flat field.
        const move = Math.max(-most, Math.min(most, error / Math.sqrt(steepness))) / Math.sqrt(steepness);
        positions[vertex] -= slope[0] * move;
        positions[vertex + 1] -= slope[1] * move;
        positions[vertex + 2] -= slope[2] * move;
      }
    }
  };

  /**
   * One pass of averaging each smooth vertex's normal with those of the smooth vertices it shares a triangle
   * with (itself counted as much as all of them together would be on a flat grid). In place.
   */
  const smoothNormals = (normals, indices, isSmooth) => {
    const sums = new Float32Array(normals.length);
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      for (let from = 0; from < VECTOR; from++) {
        const source = indices[corner + from];
        if (!isSmooth[source]) continue;
        for (let to = 0; to < VECTOR; to++) {
          if (to === from) continue;
          const target = indices[corner + to] * VECTOR;
          sums[target] += normals[source * VECTOR];
          sums[target + 1] += normals[source * VECTOR + 1];
          sums[target + 2] += normals[source * VECTOR + 2];
        }
      }
    }
    for (let vertex = 0; vertex < isSmooth.length; vertex++) {
      if (!isSmooth[vertex]) continue;
      const at = vertex * VECTOR;
      // Each neighbour was added once per triangle shared with it (twice on a closed surface).
      const x = normals[at] * SELF_WEIGHT + sums[at];
      const y = normals[at + 1] * SELF_WEIGHT + sums[at + 1];
      const z = normals[at + 2] * SELF_WEIGHT + sums[at + 2];
      const length = Math.sqrt(x * x + y * y + z * z) || 1;
      normals[at] = x / length;
      normals[at + 1] = y / length;
      normals[at + 2] = z / length;
    }
  };

  /**
   * The triangles of a cut layer worth keeping: those with a corner where the field is above `least` (not
   * buried), and, when `withWalls` is false, only those along the surface.
   * @returns {{indices: Uint32Array, alongs: Uint8Array}} the kept triangles and, per kept triangle, whether it lies along the surface
   */
  const keptFaces = (field, positions, indices, alongs, least, withWalls) => {
    const isShallow = new Uint8Array(positions.length / VECTOR);
    for (let vertex = 0; vertex < isShallow.length; vertex++)
      isShallow[vertex] = valueAt(field, positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2]) > least ? 1 : 0;
    const kept = new Uint32Array(indices.length);
    const keptAlongs = new Uint8Array(alongs.length);
    let count = 0;
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      const along = alongs[corner / VECTOR];
      if ((!withWalls && !along) || (!isShallow[indices[corner]] && !isShallow[indices[corner + 1]] && !isShallow[indices[corner + 2]])) continue;
      keptAlongs[count / VECTOR] = along;
      kept[count++] = indices[corner];
      kept[count++] = indices[corner + 1];
      kept[count++] = indices[corner + 2];
    }
    return { indices: kept.subarray(0, count), alongs: keptAlongs.subarray(0, count / VECTOR) };
  };

  /**
   * Vertex normals: each triangle's area-weighted normal added to its corners. With `isAlong` (per triangle: 1
   * along the surface, 0 a cut's wall), a vertex with any triangle along the surface takes its normal from
   * those alone, so a hem's wall does not tilt the cloth's edge.
   * @returns {{normals: Float32Array, isSmooth: Uint8Array}} `isSmooth`: per vertex, 1 when on the smooth surface
   */
  const normalsOf = (positions, indices, isAlong) => {
    const normals = new Float32Array(positions.length);
    const wallNormals = isAlong ? new Float32Array(positions.length) : normals;
    const isSmooth = new Uint8Array(positions.length / VECTOR).fill(isAlong ? 0 : 1);
    const normal = new Float64Array(VECTOR);
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      faceNormal(positions, indices[corner] * VECTOR, indices[corner + 1] * VECTOR, indices[corner + 2] * VECTOR, normal);
      const along = !isAlong || isAlong[corner / VECTOR] === 1;
      const sums = along ? normals : wallNormals;
      for (let index = 0; index < VECTOR; index++) {
        const vertex = indices[corner + index] * VECTOR;
        sums[vertex] += normal[0];
        sums[vertex + 1] += normal[1];
        sums[vertex + 2] += normal[2];
        if (along) isSmooth[vertex / VECTOR] = 1;
      }
    }
    for (let vertex = 0; vertex < normals.length; vertex += VECTOR) {
      const from = isSmooth[vertex / VECTOR] ? normals : wallNormals;
      const length = Math.sqrt(from[vertex] * from[vertex] + from[vertex + 1] * from[vertex + 1] + from[vertex + 2] * from[vertex + 2]) || 1;
      normals[vertex] = from[vertex] / length;
      normals[vertex + 1] = from[vertex + 1] / length;
      normals[vertex + 2] = from[vertex + 2] / length;
    }
    return { normals, isSmooth };
  };

  // ---- weights: who moves each vertex ---------------------------------------------------------------------------------

  /**
   * @typedef {Object} SkinArrays
   * @property {Uint16Array} owners 4 per vertex: owner ids (bone indices), strongest first; unused slots are 0
   * @property {Float32Array} weights 4 per vertex: their shares, summing to 1
   */

  /**
   * Which owners move each vertex, and how much. A vertex belongs fully to the solid it lies on; near another
   * solid (within `spread` of being as close) it is shared, so the surface bends smoothly across a joint.
   * @param {Float32Array} positions 3 per vertex, in the field's space
   * @param {Solid[]} solids
   * @param {{spread?: number, reach?: number, sharpness?: number}} [options] `spread`: metres over which ownership fades from one
   *   solid to the next (default 0.03); `reach`: how far off the solids the vertices lie (a layer's offset), metres;
   *   `sharpness`: the power a solid's nearness is raised to (default 2): higher keeps a vertex with its nearest
   *   solid for longer across a wide `spread` (cloth right over a knee follows that knee, cloth between two is shared)
   * @returns {SkinArrays}
   * @complexity O(vertices x solids whose bounds are near)
   * @example const { owners, weights } = Kit.sculpt.weights(skin.positions, field.solids);
   */
  const weights = (positions, solids, { spread = 0.03, reach = 0, sharpness = 2 } = {}) => {
    const count = positions.length / VECTOR;
    const owners = new Uint16Array(count * OWNERS);
    const shares = new Float32Array(count * OWNERS);
    /** Per owner, this vertex's summed share; reset through `touched` so the loop allocates nothing per vertex. */
    const shareOf = new Float32Array(Math.max(...solids.map((part) => part.owner)) + 1);
    const distances = new Float32Array(solids.length);
    const touched = [];
    for (let vertex = 0; vertex < count; vertex++) {
      const x = positions[vertex * VECTOR];
      const y = positions[vertex * VECTOR + 1];
      const z = positions[vertex * VECTOR + 2];
      let closest = Infinity;
      // Only solids whose bounds are near are measured; a vertex near none (a layer pushed far out) is measured against all.
      for (let pass = 0; pass < 2 && closest === Infinity; pass++) {
        const pad = pass ? Infinity : spread + reach;
        for (let index = 0; index < solids.length; index++) {
          const part = solids[index];
          const isNear = x > part.min[0] - pad && x < part.max[0] + pad && y > part.min[1] - pad && y < part.max[1] + pad && z > part.min[2] - pad && z < part.max[2] + pad;
          distances[index] = isNear ? part.distance(x, y, z) : Infinity;
          closest = Math.min(closest, distances[index]);
        }
      }
      touched.length = 0;
      for (let index = 0; index < solids.length; index++) {
        const nearness = 1 - (distances[index] - closest) / spread;
        if (!(nearness > 0)) continue;
        const { owner } = solids[index];
        if (shareOf[owner] === 0) touched.push(owner);
        shareOf[owner] += sharpness === 2 ? nearness * nearness : nearness ** sharpness;
      }
      // Strongest four owners, then made to sum to one.
      touched.sort((first, second) => shareOf[second] - shareOf[first]);
      let total = 0;
      for (let slot = 0; slot < Math.min(OWNERS, touched.length); slot++) total += shareOf[touched[slot]];
      for (let slot = 0; slot < OWNERS; slot++) {
        owners[vertex * OWNERS + slot] = slot < touched.length ? touched[slot] : 0;
        shares[vertex * OWNERS + slot] = slot < touched.length && total > 0 ? shareOf[touched[slot]] / total : 0;
      }
      for (let index = 0; index < touched.length; index++) shareOf[touched[index]] = 0;
    }
    return { owners, weights: shares };
  };

  Kit.sculpt = {
    DETAIL,
    KINDS,
    FAR,
    invertAffine,
    smoothMin,
    polygonDistance,
    sectionTable,
    distanceOf,
    solid,
    cellFor,
    isTooThin,
    sample,
    sampleSteps,
    valueAt,
    slopeAt,
    nearestAt,
    surface,
    weights,
  };
})();
