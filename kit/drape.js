/**
 * Kit drape: cloth that hangs on a body, as plain geometry. A hanging garment (a skirt, a cloak, a scarf's end)
 * is authored once, as a shape on a bone; a body under it may be any build. This module makes the authored
 * shape lie on the body it meets: it is swung out about the joint it hangs from until it is clear of what is
 * under it, what the body still pushes through it is laid over the body, thin cloth is meshed as a thin shell
 * at any level of detail, and every vertex is shared between the bone the cloth hangs from and the body bones
 * beneath it, so a knee pushes a skirt and a simulated cloak bone carries its cloak.
 *
 * Owns:  `Kit.drape.under` (solids -> the surface a cloth must stay outside of), `cloud` (a cloth already laid, as
 *        one of those solids), `hangAngle` and `turnAbout`
 *        (the least swing that clears it), `shell` (a built shape -> a welded, evenly fine, closed mesh),
 *        `settle` (vertices pushed out of what is under them), `ride` (skin weights shared with the cloth's own
 *        bone), `smoothNormals` and the `DRAPE` tunables.
 * Does not own: which bones are draped and in what order (catalogue data read by kit/figure-sculpt.js), the
 *        solids' distances (kit/sculpt.js), built shapes (kit/figure-shapes.js), movement (kit/motion.js) or THREE.
 *
 * Conventions: metres; points are in the space the solids were placed in (a body's rest pose); a mesh is
 * `{ positions, normals, indices }` with three numbers per vertex and triangles wound counter-clockwise seen
 * from outside.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-drape.js.
 */
(() => {
  /** Tunables, metres unless noted. */
  const DRAPE = Object.freeze({
    /** Cloth stands at least this far off what is under it, so two layers never share a surface. */
    gap: 0.004,
    /** The furthest a vertex is moved out of what is under it: deeper than this it is buried, and left buried. */
    mostPush: 0.14,
    /** Times a pushed vertex is measured again and moved the rest of the way (a curved surface is not reached in one step). */
    settleSteps: 10,
    /** The slope under a hanging cloth is a way out when at least this much of it (a cosine) lies across the hang; else the hang's own outward is. */
    leastAcross: 0.3,
    /** A move is handed down an edge that drops at least this share of its length along the hang. */
    leastDrop: 0.4,
    /** Times a settled cloth's normals are averaged with their neighbours': it is lit as one sheet, not by the small steps between its vertices. */
    normalPasses: 3,
    /** A move handed down a hanging cloth is gone this many metres further down. */
    fall: 0.5,
    /** The step a slope is measured over. */
    slopeStep: 0.002,
    /** A solid is not measured from further than this outside its bounds: the cloth is then far off it. */
    reach: 0.12,
    /** A hanging piece swings out by at most this (radians), tried in `swingSteps` steps and then narrowed `swingHalvings` times. */
    mostSwing: 0.9,
    swingSteps: 18,
    swingHalvings: 6,
    /** About how many of a piece's points a swing is decided by. */
    swingPoints: 240,
    /** A swing answers for the points further from the joint than this share of the furthest. */
    swingFrom: 0.3,
    /** A thing set on cloth is moved out in steps of this, */
    seatStep: 0.005,
    /** by at most this, */
    mostSeat: 0.3,
    /** and is clear when no cloth lies within this far in front of it, looked for at steps of `seatProbe`. */
    seatReach: 0.24,
    seatProbe: 0.008,
    /** A swung piece may stay buried this deep: `settle` lays that much over the body. */
    restDepth: 0.02,
    /** A swing is far enough when what is still buried is within this of the least any swing leaves, mean metres per point. */
    swingSlack: 0.0002,
    /** A piece whose joint is nearer the bone it hangs from than this (to the side) hangs round the body and is not swung. */
    midline: 0.02,
    /** A shell's edges are split until none is longer than its target; never more passes than this. */
    mostSplits: 12,
    /** Positions nearer than this are one vertex when a built shape is welded. */
    weld: 1e-5,
    /** How far past contact a cloth still shares in the body's movement, when `ride` is not told. */
    clings: 0.1,
    /** Cloth this near the body beneath it is carried by the body alone; `clings` further out it rides its own bone alone. */
    contact: 0.006,
  });
  const VECTOR = 3;
  const HALF = 0.5;
  const TURN = Math.PI * 2;
  /** The fewest and the most bins round a cloth hung all round (`round`). */
  const MOST_FEW_TURNS = 8;
  const MOST_TURNS = 64;
  const unit = (vector) => {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  };
  /** A vertex within this of where it should be rests there (float rounding in a distance). */
  const RESTING = 1e-5;
  const OWNERS = 4;
  const MATRIX = 16;
  /** In a column-major 4 x 4: numbers per column, and where the fourth column (the move) starts. */
  const MATRIX_COLUMN = 4;
  const MATRIX_MOVE = 12;
  /** "Out of every solid's reach": the distance `under` gives there, metres. */
  const FAR = 1e3;
  /** A length below which a direction is not one. */
  const TINY = 1e-6;
  /** A measured slope longer than this many times a true distance's is a crease between two solids, not a direction. */
  const STEEPEST_SLOPE = 4;

  const fail = (where, message) => {
    throw new Error(`Kit.drape.${where}: ${message}`);
  };

  /**
   * @typedef {Object} UnderSolid
   * A solid a cloth lies over.
   * @property {function(number, number, number): number} distance signed distance, negative inside (a `Solid` of kit/sculpt.js)
   * @property {number[]} min [x, y, z] of its bounds
   * @property {number[]} max
   * @property {number} [lift=0] metres the layers already on it stand off it: the cloth clears the solid grown by this
   */

  /**
   * @typedef {Object} Under
   * What a cloth must stay outside of: the union of solids, each grown by its `lift`.
   * @property {function(number, number, number): number} distance metres to that union, negative inside; `Kit.drape.FAR` beyond every solid's reach
   * @property {function(number, number, number, number[]): number} slope writes the unit direction out of the union (zero where none) and returns the distance there
   */

  /**
   * The surface under a cloth: the union of the solids beneath it, each grown by what is already worn on it.
   * Distances are the solids' own (not a grid's), so a cloth is placed as exactly as the body is described.
   * @param {UnderSolid[]} solids
   * @param {{reach?: number, slopeStep?: number}} [options] see `DRAPE`
   * @returns {Under}
   * @complexity O(solids) per distance (a bounds test each, a distance for those near); a slope is one distance and three more of one solid
   * @example const under = Kit.drape.under(bodySolids.map((part) => ({ ...part, lift: 0.009 }))); under.distance(0, 1, -0.2) // > 0: behind the back
   */
  const under = (solids, options = {}) => {
    const reach = options.reach === undefined ? DRAPE.reach : options.reach;
    const step = options.slopeStep || DRAPE.slopeStep;
    const count = solids.length;
    /** The solid that gave the last distance (-1: none in reach): a slope is that solid's alone. */
    let nearestSolid = -1;
    const distance = (x, y, z) => {
      let nearest = FAR;
      nearestSolid = -1;
      // Hot loop (several calls per cloth vertex): bounds first, a distance only for the solids near.
      for (let index = 0; index < count; index++) {
        const part = solids[index];
        if (x < part.min[0] - reach || x > part.max[0] + reach || y < part.min[1] - reach || y > part.max[1] + reach || z < part.min[2] - reach || z > part.max[2] + reach) continue;
        const away = part.distance(x, y, z) - (part.lift || 0);
        if (away < nearest) {
          nearest = away;
          nearestSolid = index;
        }
      }
      return nearest;
    };
    const slope = (x, y, z, out) => {
      const here = distance(x, y, z);
      if (nearestSolid < 0) {
        out[0] = out[1] = out[2] = 0;
        return here;
      }
      // The union's slope at a point is that of the solid nearest there: three more of its distances, not of all.
      const part = solids[nearestSolid];
      const own = here + (part.lift || 0);
      const dx = part.distance(x + step, y, z) - own;
      const dy = part.distance(x, y + step, z) - own;
      const dz = part.distance(x, y, z + step) - own;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // The middle of a solid, or a crease of its distance: no direction.
      const scale = length > TINY * TINY && length < step * STEEPEST_SLOPE ? 1 / length : 0;
      out[0] = dx * scale;
      out[1] = dy * scale;
      out[2] = dz * scale;
      return here;
    };
    return { distance, slope };
  };

  /**
   * A cloth hung all round a line (a skirt round the hips) as something a later cloth lies over: everything
   * nearer the line than the cloth is, where the cloth reaches along it. The cloth itself is hollow, and so is
   * the shape it was built from; a coat's tails laid over a skirt must clear the space the skirt encloses, not
   * only its wall.
   *
   * The cloth's vertices are binned by how far along the line and which way round it they lie; a bin keeps
   * the furthest of them from the line, or of its neighbours'. The distance of a point is how far outside that radius it is, read
   * between the four bins round it (negative inside), or how far beyond the cloth's ends it is, if that is more.
   * @param {ArrayLike<number>} points x, y, z each: the cloth's vertices as laid
   * @param {number[]} joint a point of the line
   * @param {number[]} along the line's unit direction
   * @param {number} edge metres: the cloth's longest edge (a bin is twice that long, so none is empty inside the cloth)
   * @returns {UnderSolid}
   * @complexity O(points) to make; O(1) per distance
   * @example laid.push(Kit.drape.round(skirt.positions, hips, [0, -1, 0], 0.03));
   */
  const round = (points, joint, along, edge) => {
    // Two directions across the line, to tell the way round it.
    const seed = Math.abs(along[1]) < HALF ? [0, 1, 0] : [1, 0, 0];
    const first = unit([along[1] * seed[2] - along[2] * seed[1], along[2] * seed[0] - along[0] * seed[2], along[0] * seed[1] - along[1] * seed[0]]);
    const second = [along[1] * first[2] - along[2] * first[1], along[2] * first[0] - along[0] * first[2], along[0] * first[1] - along[1] * first[0]];
    /** How far along the line, how far from it and which way round it (0..1) a point lies. */
    const placeOf = (x, y, z, out) => {
      const from = [x - joint[0], y - joint[1], z - joint[2]];
      const [acrossFirst, acrossSecond] = [from[0] * first[0] + from[1] * first[1] + from[2] * first[2], from[0] * second[0] + from[1] * second[1] + from[2] * second[2]];
      out[0] = from[0] * along[0] + from[1] * along[1] + from[2] * along[2];
      out[1] = Math.hypot(acrossFirst, acrossSecond);
      out[2] = Math.atan2(acrossSecond, acrossFirst) / TURN + HALF;
      return out;
    };
    const place = [0, 0, 0];
    let [start, end, widest] = [Infinity, -Infinity, 0];
    for (let at = 0; at < points.length; at += VECTOR) {
      placeOf(points[at], points[at + 1], points[at + 2], place);
      [start, end, widest] = [Math.min(start, place[0]), Math.max(end, place[0]), Math.max(widest, place[1])];
    }
    const step = edge * 2;
    const rows = Math.max(1, Math.ceil((end - start) / step));
    const turns = Math.max(MOST_FEW_TURNS, Math.min(MOST_TURNS, Math.floor((TURN * widest) / step)));
    const radii = new Float32Array((rows + 1) * turns);
    for (let at = 0; at < points.length; at += VECTOR) {
      placeOf(points[at], points[at + 1], points[at + 2], place);
      const bin = Math.round((place[0] - start) / step) * turns + (Math.round(place[2] * turns) % turns);
      radii[bin] = Math.max(radii[bin], place[1]);
    }
    // Each bin takes the furthest of its neighbours' too: between two bins the cloth may bulge past both of their own.
    const own = Float32Array.from(radii);
    for (let row = 0; row <= rows; row++) {
      for (let turn = 0; turn < turns; turn++) {
        for (let rowStep = -1; rowStep <= 1; rowStep++) {
          if (row + rowStep < 0 || row + rowStep > rows) continue;
          for (let turnStep = -1; turnStep <= 1; turnStep++) radii[row * turns + turn] = Math.max(radii[row * turns + turn], own[(row + rowStep) * turns + ((turn + turnStep + turns) % turns)]);
        }
      }
    }
    const distance = (x, y, z) => {
      placeOf(x, y, z, place);
      const beyond = Math.max(start - place[0], place[0] - end);
      const row = Math.max(0, Math.min(rows, (place[0] - start) / step));
      const turn = place[2] * turns;
      const [rowLow, turnLow] = [Math.min(rows - 1, Math.floor(row)), Math.floor(turn)];
      const [rowShare, turnShare] = [row - rowLow, turn - turnLow];
      const at = (rowAt, turnAt) => radii[rowAt * turns + (turnAt % turns)];
      const radius =
        (at(rowLow, turnLow) * (1 - turnShare) + at(rowLow, turnLow + 1) * turnShare) * (1 - rowShare) + (at(rowLow + 1, turnLow) * (1 - turnShare) + at(rowLow + 1, turnLow + 1) * turnShare) * rowShare;
      return Math.max(place[1] - radius, beyond);
    };
    // Bounds: the cylinder's box, loosely (a box of its widest radius round every point of its length).
    const ends = [joint.map((value, axis) => value + along[axis] * start), joint.map((value, axis) => value + along[axis] * end)];
    const min = ends[0].map((value, axis) => Math.min(value, ends[1][axis]) - widest);
    const max = ends[0].map((value, axis) => Math.max(value, ends[1][axis]) + widest);
    return { distance, min, max };
  };

  /**
   * Points as something a cloth lies over: the union of a ball round each (a cloth already laid, by its
   * vertices, for the cloth laid on top of it). The balls of neighbouring vertices must overlap: give a radius
   * of at least 0.6 of the mesh's longest edge. Outside every ball's reach the distance is `Kit.drape.FAR`.
   * @param {ArrayLike<number>} points x, y, z each
   * @param {number} radius metres
   * @returns {UnderSolid}
   * @complexity O(points) to make; O(points in the 27 cells round a point) per distance
   * @example const skirtAsLaid = Kit.drape.cloud(skirt.positions, 0.012);
   */
  const cloud = (points, radius) => {
    const size = radius * 2;
    const cells = new Map();
    const keyOf = (cellX, cellY, cellZ) => `${cellX},${cellY},${cellZ}`;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let at = 0; at < points.length; at += VECTOR) {
      const key = keyOf(Math.floor(points[at] / size), Math.floor(points[at + 1] / size), Math.floor(points[at + 2] / size));
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(at);
      for (let axis = 0; axis < VECTOR; axis++) {
        min[axis] = Math.min(min[axis], points[at + axis] - radius);
        max[axis] = Math.max(max[axis], points[at + axis] + radius);
      }
    }
    const distance = (x, y, z) => {
      const [cellX, cellY, cellZ] = [Math.floor(x / size), Math.floor(y / size), Math.floor(z / size)];
      let nearest = Infinity;
      for (let stepX = -1; stepX <= 1; stepX++) {
        for (let stepY = -1; stepY <= 1; stepY++) {
          for (let stepZ = -1; stepZ <= 1; stepZ++) {
            const held = cells.get(keyOf(cellX + stepX, cellY + stepY, cellZ + stepZ));
            if (!held) continue;
            for (let item = 0; item < held.length; item++) {
              const at = held[item];
              const squared = (points[at] - x) ** 2 + (points[at + 1] - y) ** 2 + (points[at + 2] - z) ** 2;
              if (squared < nearest) nearest = squared;
            }
          }
        }
      }
      return nearest === Infinity ? FAR : Math.sqrt(nearest) - radius;
    };
    return { distance, min, max, lift: 0 };
  };

  /** A point turned by `angle` about the axis through `joint` along the unit vector `axis` (Rodrigues); written to `out` at `at`. */
  const turnPoint = (x, y, z, joint, axis, cos, sin, out, at) => {
    const [px, py, pz] = [x - joint[0], y - joint[1], z - joint[2]];
    const along = (axis[0] * px + axis[1] * py + axis[2] * pz) * (1 - cos);
    out[at] = joint[0] + px * cos + (axis[1] * pz - axis[2] * py) * sin + axis[0] * along;
    out[at + 1] = joint[1] + py * cos + (axis[2] * px - axis[0] * pz) * sin + axis[1] * along;
    out[at + 2] = joint[2] + pz * cos + (axis[0] * py - axis[1] * px) * sin + axis[2] * along;
  };

  /**
   * The axis a hanging piece swings about: across both the way it hangs and the way out of the body, so a
   * positive turn carries its free end outward. Null when it hangs straight out already or has no way out.
   * @param {number[]} along unit [x, y, z]: from the joint towards the piece's free end
   * @param {number[]} outward [x, y, z]: away from what it hangs on
   * @returns {?number[]} unit [x, y, z]
   * @complexity O(1)
   * @example Kit.drape.swingAxis([0, -1, 0], [0, 0, -1]) // [1, 0, 0]: a cloak down a back swings about the shoulders' line
   */
  const swingAxis = (along, outward) => {
    const axis = [along[1] * outward[2] - along[2] * outward[1], along[2] * outward[0] - along[0] * outward[2], along[0] * outward[1] - along[1] * outward[0]];
    const length = Math.hypot(...axis);
    return length > TINY ? axis.map((value) => value / length) : null;
  };

  /**
   * The least angle a hanging piece must swing out, about its joint, to rest on the body instead of passing
   * through it: the smallest swing after which nothing of it is buried deeper than `restDepth` (what `settle`
   * then lays over the body), or, when no swing does that (its top, at the joint, never moves), the smallest
   * that leaves about as little buried deeper as any swing can. A cloak then lies down the back of a slight
   * body and of a stout one alike, and how it hangs depends on nothing but the piece and what is under it.
   * @param {ArrayLike<number>} points x, y, z of points of the piece, as authored (its built surface)
   * @param {number[]} joint [x, y, z] it hangs from
   * @param {number[]} axis unit [x, y, z] to swing about (`swingAxis`)
   * @param {Under} below what it must clear
   * @param {number} need metres every point should stand off `below`
   * @param {{mostSwing?: number, swingSteps?: number, swingHalvings?: number, swingSlack?: number, restDepth?: number, swingFrom?: number}} [options] see `DRAPE`
   * @returns {number} radians, 0 .. `mostSwing`
   * @complexity O((swingSteps + swingHalvings) x min(points, swingPoints) x solids)
   * @example const angle = Kit.drape.hangAngle(cloakPoints, shoulders, [1, 0, 0], under, 0.01);
   */
  const hangAngle = (points, joint, axis, below, need, options = {}) => {
    const tune = { ...DRAPE, ...options };
    const turned = [0, 0, 0];
    // A point near the joint hardly moves however far the piece swings: only what a swing can clear is asked of it.
    let furthest = 0;
    for (let at = 0; at < points.length; at += VECTOR) furthest = Math.max(furthest, Math.hypot(points[at] - joint[0], points[at + 1] - joint[1], points[at + 2] - joint[2]));
    const nearest = furthest * tune.swingFrom;
    /** Every `stride`-th point is asked: a swing is decided by a few hundred points as well as by thousands. */
    const stride = Math.max(1, Math.floor(points.length / VECTOR / tune.swingPoints)) * VECTOR;
    /** Mean metres by which the points are buried deeper than `restDepth` under `need`, at an angle. */
    const buried = (angle) => {
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      let sum = 0;
      for (let at = 0; at < points.length; at += stride) {
        if (Math.hypot(points[at] - joint[0], points[at + 1] - joint[1], points[at + 2] - joint[2]) < nearest) continue;
        turnPoint(points[at], points[at + 1], points[at + 2], joint, axis, cos, sin, turned, 0);
        sum += Math.max(0, need - tune.restDepth - below.distance(turned[0], turned[1], turned[2]));
      }
      return sum / (points.length / stride || 1);
    };
    const angles = Array.from({ length: tune.swingSteps + 1 }, (_unused, step) => (tune.mostSwing * step) / tune.swingSteps);
    const depths = angles.map(buried);
    const enough = Math.min(...depths) + tune.swingSlack;
    const first = depths.findIndex((depth) => depth <= enough);
    if (first <= 0) return 0;
    // Between the last step that was not enough and the first that was: halve to where it becomes enough.
    let [low, high] = [angles[first - 1], angles[first]];
    for (let step = 0; step < tune.swingHalvings; step++) {
      const middle = (low + high) / 2;
      if (buried(middle) <= enough) high = middle;
      else low = middle;
    }
    return high;
  };

  /**
   * Turns bone matrices about an axis through a point, in place: a piece (and whatever hangs from it) swung to
   * where `hangAngle` says it rests.
   * @param {Float32Array} matrices column-major 4 x 4 per bone
   * @param {number} from the first bone to turn
   * @param {number} to one past the last
   * @param {number[]} joint [x, y, z]
   * @param {number[]} axis unit [x, y, z]
   * @param {number} angle radians
   * @returns {Float32Array} `matrices`
   * @complexity O(bones turned)
   * @example Kit.drape.turnAbout(matrices, cloak, plan.subtreeEnd[cloak], shoulders, [1, 0, 0], 0.2);
   */
  const turnAbout = (matrices, from, to, joint, axis, angle) => {
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const origin = [0, 0, 0];
    for (let bone = from; bone < to; bone++) {
      const at = bone * MATRIX;
      // The three axes are directions (turned about the origin); the fourth column is a point (turned about the joint).
      for (let column = at; column < at + MATRIX_MOVE; column += MATRIX_COLUMN) turnPoint(matrices[column], matrices[column + 1], matrices[column + 2], origin, axis, cos, sin, matrices, column);
      const move = at + MATRIX_MOVE;
      turnPoint(matrices[move], matrices[move + 1], matrices[move + 2], joint, axis, cos, sin, matrices, move);
    }
    return matrices;
  };

  /**
   * Vertex normals of a mesh: each triangle's area-weighted normal added to its corners, so the surface shades
   * as one smooth cloth, round its edges too.
   * @param {Float32Array} positions
   * @param {ArrayLike<number>} indices
   * @param {Float32Array} [out] receives the normals (default: a new array)
   * @param {number} [passes] times each normal is then replaced by the mean of its triangles' corners' normals (default 0)
   * @returns {Float32Array} unit normals, 3 per vertex
   * @complexity O((vertices + triangles) x (1 + passes))
   * @example mesh.normals = Kit.drape.smoothNormals(mesh.positions, mesh.indices);
   */
  const smoothNormals = (positions, indices, out = new Float32Array(positions.length), passes = 0) => {
    out.fill(0);
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      const [first, second, third] = [indices[corner] * VECTOR, indices[corner + 1] * VECTOR, indices[corner + 2] * VECTOR];
      const [ux, uy, uz] = [positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]];
      const [vx, vy, vz] = [positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]];
      const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const vertex of [first, second, third]) {
        out[vertex] += nx;
        out[vertex + 1] += ny;
        out[vertex + 2] += nz;
      }
    }
    for (let vertex = 0; vertex < out.length; vertex += VECTOR) {
      const length = Math.hypot(out[vertex], out[vertex + 1], out[vertex + 2]) || 1;
      out[vertex] /= length;
      out[vertex + 1] /= length;
      out[vertex + 2] /= length;
    }
    for (let pass = 0; pass < passes; pass++) {
      const sums = new Float32Array(out.length);
      for (let corner = 0; corner < indices.length; corner += VECTOR) {
        const [first, second, third] = [indices[corner] * VECTOR, indices[corner + 1] * VECTOR, indices[corner + 2] * VECTOR];
        for (let axis = 0; axis < VECTOR; axis++) {
          const sum = out[first + axis] + out[second + axis] + out[third + axis];
          sums[first + axis] += sum;
          sums[second + axis] += sum;
          sums[third + axis] += sum;
        }
      }
      for (let vertex = 0; vertex < out.length; vertex += VECTOR) {
        const length = Math.hypot(sums[vertex], sums[vertex + 1], sums[vertex + 2]);
        if (length > 0) for (let axis = 0; axis < VECTOR; axis++) out[vertex + axis] = sums[vertex + axis] / length;
      }
    }
    return out;
  };

  /**
   * A built shape as cloth: its vertices welded where they coincide (a built shape repeats a vertex wherever
   * its faces meet in a hard edge), and its edges split until none is longer than `edge`, so the surface is one
   * closed skin fine enough to bend and to be laid over a body. A thin panel stays exactly as thin as it was
   * authored, at any level of detail, where a grid would have to thicken it to hold it at all.
   *
   * Every edge longer than the target is split at its middle, and each triangle is cut by which of its edges
   * were split (one, two or three); a split is decided per edge, so both triangles on an edge agree and the
   * mesh stays closed.
   * @param {{positions: ArrayLike<number>, indices: ArrayLike<number>}} arrays a built shape (`Kit.figure.buildShape`), or any triangle mesh
   * @param {number} edge metres: the longest an edge may stay
   * @returns {{positions: Float32Array, indices: Uint32Array}}
   * @throws {Error} for an edge that is not positive
   * @complexity O(surface area / edge^2) vertices and triangles; at most `DRAPE.mostSplits` passes over them
   * @example const cloth = Kit.drape.shell(Kit.figure.buildShape(panel, 'low'), 0.03);
   */
  const shell = (arrays, edge) => {
    if (!(edge > 0)) fail('shell', `the edge length must be positive, got ${edge}.`);
    const welded = new Map();
    const points = [];
    const renumbered = new Uint32Array(arrays.positions.length / VECTOR);
    for (let vertex = 0; vertex < renumbered.length; vertex++) {
      const at = vertex * VECTOR;
      const key = `${Math.round(arrays.positions[at] / DRAPE.weld)},${Math.round(arrays.positions[at + 1] / DRAPE.weld)},${Math.round(arrays.positions[at + 2] / DRAPE.weld)}`;
      if (!welded.has(key)) {
        welded.set(key, points.length / VECTOR);
        points.push(arrays.positions[at], arrays.positions[at + 1], arrays.positions[at + 2]);
      }
      renumbered[vertex] = welded.get(key);
    }
    let triangles = [];
    for (let corner = 0; corner < arrays.indices.length; corner += VECTOR) {
      const [first, second, third] = [renumbered[arrays.indices[corner]], renumbered[arrays.indices[corner + 1]], renumbered[arrays.indices[corner + 2]]];
      // A triangle whose corners were welded together has no area.
      if (first !== second && second !== third && third !== first) triangles.push(first, second, third);
    }
    const lengthSquared = (from, to) => (points[from * VECTOR] - points[to * VECTOR]) ** 2 + (points[from * VECTOR + 1] - points[to * VECTOR + 1]) ** 2 + (points[from * VECTOR + 2] - points[to * VECTOR + 2]) ** 2;
    const mostSquared = edge * edge;
    for (let pass = 0; pass < DRAPE.mostSplits; pass++) {
      /** The new vertex at the middle of each edge split in this pass, by the edge's two ends. */
      const middles = new Map();
      const middleOf = (from, to) => {
        if (lengthSquared(from, to) <= mostSquared) return -1;
        const key = from < to ? `${from},${to}` : `${to},${from}`;
        if (!middles.has(key)) {
          middles.set(key, points.length / VECTOR);
          points.push((points[from * VECTOR] + points[to * VECTOR]) / 2, (points[from * VECTOR + 1] + points[to * VECTOR + 1]) / 2, (points[from * VECTOR + 2] + points[to * VECTOR + 2]) / 2);
        }
        return middles.get(key);
      };
      const next = [];
      for (let corner = 0; corner < triangles.length; corner += VECTOR) {
        const corners = [triangles[corner], triangles[corner + 1], triangles[corner + 2]];
        const split = [middleOf(corners[0], corners[1]), middleOf(corners[1], corners[2]), middleOf(corners[2], corners[0])];
        const splits = split.filter((middle) => middle >= 0).length;
        if (splits === 0) next.push(...corners);
        else if (splits === VECTOR) next.push(corners[0], split[0], split[2], split[0], corners[1], split[1], split[2], split[1], corners[2], split[0], split[1], split[2]);
        else {
          // Turn the triangle so its first edge is a split one (and, with two, the unsplit one is last or second).
          const lead = splits === 1 ? split.findIndex((middle) => middle >= 0) : split.findIndex((middle, index) => middle >= 0 && split[(index + 2) % VECTOR] < 0);
          const [first, second, third] = [corners[lead], corners[(lead + 1) % VECTOR], corners[(lead + 2) % VECTOR]];
          const [firstMiddle, secondMiddle] = [split[lead], split[(lead + 1) % VECTOR]];
          if (splits === 1) next.push(first, firstMiddle, third, firstMiddle, second, third);
          else next.push(first, firstMiddle, third, firstMiddle, secondMiddle, third, firstMiddle, second, secondMiddle);
        }
      }
      triangles = next;
      if (!middles.size) break;
    }
    return { positions: Float32Array.from(points), indices: Uint32Array.from(triangles) };
  };

  /** For each vertex, the vertices it shares a triangle edge with: `starts[v] .. starts[v + 1]` in `items` (each listed once per shared triangle). */
  const neighboursOf = (vertexCount, indices) => {
    const starts = new Uint32Array(vertexCount + 1);
    for (let corner = 0; corner < indices.length; corner++) starts[indices[corner] + 1] += 2;
    for (let vertex = 0; vertex < vertexCount; vertex++) starts[vertex + 1] += starts[vertex];
    const filled = starts.slice(0, vertexCount);
    const items = new Uint32Array(indices.length * 2);
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      for (let index = 0; index < VECTOR; index++) {
        const vertex = indices[corner + index];
        items[filled[vertex]++] = indices[corner + ((index + 1) % VECTOR)];
        items[filled[vertex]++] = indices[corner + ((index + 2) % VECTOR)];
      }
    }
    return { starts, items };
  };

  /**
   * Lays a cloth over what is under it, as cloth lies: pushed out where the body is in its way, and hanging
   * straight on down from there.
   *
   * 1. Each vertex nearer `below` than it should be is moved out until it is not, by at most `mostPush`. The
   *    way out is the slope of `below`; for a cloth that hangs (`hang`), only the part of it across the hang,
   *    so a skirt's waist is pushed outwards level and never up the body, and a cloak inside a skirt's cone
   *    comes out through its side, not its bottom. Where the slope has almost nothing across the hang, the
   *    hang's own `outward` is the way, or with none (a cloth hung all round the body) straight away from the
   *    line it hangs along. A thin sheet (`thickness` above 0) has two sides: the side whose
   *    normal points out comes to rest `gap + thickness` off what is under it and the lining `gap` off it, so
   *    a panel the body pushes through keeps its thickness where it lies on the body.
   * 2. With `hang`, a move is handed on down the cloth: a vertex further along the way the cloth hangs takes
   *    its neighbours' move from above, less `1 / fall` of it per metre, across the hang only. A cloak pushed
   *    out by a seat then falls from the seat instead of folding back under it.
   * The normals are made again afterwards, and averaged over neighbours `normalPasses` times: a move differs a
   * little from vertex to vertex, and a toon ramp would show each step as a patch. Where nothing is in the cloth's way it keeps its authored shape
   * exactly, so how a garment hangs depends only on the garment and the body under it.
   * @param {{positions: Float32Array, normals: Float32Array, indices: ArrayLike<number>}} mesh changed in place
   * @param {Under} below
   * @param {{gap?: number, thickness?: number, mostPush?: number, settleSteps?: number, normalPasses?: number, hang?: {joint: number[], along: number[], outward?: number[]}, fall?: number}} [options]
   *   `thickness`: metres between the cloth's two sides (default 0: one side); `hang`: the point the cloth hangs
   *   from, the unit direction it hangs in and, for a cloth that hangs to one side of the body, the unit
   *   direction away from the body across that; the rest as `DRAPE`
   * @returns {number} how many vertices were moved
   * @complexity O(vertices x settleSteps x solids + (vertices + triangles) x normalPasses + vertices log vertices)
   * @example const moved = Kit.drape.settle(cloak, under, { thickness: 0.018, hang: { joint: shoulders, along: [0, -1, 0] } });
   */
  const settle = (mesh, below, options = {}) => {
    const tune = { ...DRAPE, thickness: 0, ...options };
    const { positions, normals, indices } = mesh;
    const count = positions.length / VECTOR;
    const moves = new Float32Array(positions.length);
    /** Per vertex: 1 when its move brought it out (it rests on what is under it), 0 when it is still buried or was not moved. */
    const rests = new Uint8Array(count);
    const out = [0, 0, 0];
    const hang = tune.hang || null;
    let pushed = 0;
    for (let at = 0; at < positions.length; at += VECTOR) {
      let [x, y, z] = [positions[at], positions[at + 1], positions[at + 2]];
      let target = -1;
      let moved = 0;
      for (let step = 0; step < tune.settleSteps && moved < tune.mostPush; step++) {
        // Most of a cloth is clear of everything: one distance says so, and only a buried vertex asks the way out.
        const away = below.distance(x, y, z);
        if (away >= (target < 0 ? tune.gap + tune.thickness : target) - RESTING) {
          rests[at / VECTOR] = moved > 0 ? 1 : 0;
          break;
        }
        below.slope(x, y, z, out);
        if (hang) {
          const lengthwise = out[0] * hang.along[0] + out[1] * hang.along[1] + out[2] * hang.along[2];
          const across = [out[0] - hang.along[0] * lengthwise, out[1] - hang.along[1] * lengthwise, out[2] - hang.along[2] * lengthwise];
          const length = Math.hypot(...across);
          let way = length >= tune.leastAcross ? across.map((value) => value / length) : hang.outward || null;
          if (!way) {
            // A cloth that hangs all round the body (a skirt, a coat's tails) has no one outward: away from the line it hangs along.
            const from = [x - hang.joint[0], y - hang.joint[1], z - hang.joint[2]];
            const down = from[0] * hang.along[0] + from[1] * hang.along[1] + from[2] * hang.along[2];
            const radial = from.map((value, axis) => value - hang.along[axis] * down);
            const reach = Math.hypot(...radial);
            if (reach < RESTING) break;
            way = radial.map((value) => value / reach);
          }
          [out[0], out[1], out[2]] = way;
        } else if (out[0] === 0 && out[1] === 0 && out[2] === 0) break;
        // Which side of the cloth this vertex is on, decided once, where it was authored.
        if (target < 0) target = tune.gap + (tune.thickness * (1 + normals[at] * out[0] + normals[at + 1] * out[1] + normals[at + 2] * out[2])) / 2;
        if (away >= target - RESTING) break;
        // A distance changes by no more than the move made, so a move of what is missing never goes too far; a
        // way out that is not straight up the slope takes more of them.
        const move = Math.min(target - away, tune.mostPush - moved);
        x += out[0] * move;
        y += out[1] * move;
        z += out[2] * move;
        moved += move;
        // The last step allowed: measured once more, so a vertex that has just come out is known to rest.
        if (step === tune.settleSteps - 1 && below.distance(x, y, z) >= target - RESTING) rests[at / VECTOR] = 1;
      }
      if (moved > 0) {
        moves[at] = x - positions[at];
        moves[at + 1] = y - positions[at + 1];
        moves[at + 2] = z - positions[at + 2];
        pushed += 1;
      }
    }
    if (!pushed) return 0;
    const { starts, items } = neighboursOf(count, indices);
    const lengthSquaredAt = (values, at) => values[at] * values[at] + values[at + 1] * values[at + 1] + values[at + 2] * values[at + 2];
    if (tune.hang) {
      const { joint, along } = tune.hang;
      const fallen = Float32Array.from({ length: count }, (_unused, vertex) => (positions[vertex * VECTOR] - joint[0]) * along[0] + (positions[vertex * VECTOR + 1] - joint[1]) * along[1] + (positions[vertex * VECTOR + 2] - joint[2]) * along[2]);
      const order = Uint32Array.from({ length: count }, (_unused, vertex) => vertex).sort((first, second) => fallen[first] - fallen[second]);
      // From the top down, so a move is handed on as far as the cloth goes in one sweep.
      for (let rank = 0; rank < count; rank++) {
        const vertex = order[rank];
        const at = vertex * VECTOR;
        let longest = lengthSquaredAt(moves, at);
        for (let item = starts[vertex]; item < starts[vertex + 1]; item++) {
          const above = items[item] * VECTOR;
          const drop = fallen[vertex] - fallen[items[item]];
          // Handed on only by cloth that rests on something (or was itself handed a move), down an edge that runs
          // mostly along the hang: what is still buried, and the flat top of a cone, hand nothing on.
          if (!rests[items[item]] || drop <= 0) continue;
          const run = Math.hypot(positions[at] - positions[above], positions[at + 1] - positions[above + 1], positions[at + 2] - positions[above + 2]);
          if (drop < run * tune.leastDrop) continue;
          const kept = Math.max(0, 1 - drop / tune.fall);
          // Across the hang only: a cloth pushed out falls straight; it is not stretched along itself.
          const lengthwise = moves[above] * along[0] + moves[above + 1] * along[1] + moves[above + 2] * along[2];
          const handed = [(moves[above] - along[0] * lengthwise) * kept, (moves[above + 1] - along[1] * lengthwise) * kept, (moves[above + 2] - along[2] * lengthwise) * kept];
          const length = handed[0] * handed[0] + handed[1] * handed[1] + handed[2] * handed[2];
          if (length <= longest) continue;
          longest = length;
          rests[vertex] = 1;
          moves[at] = handed[0];
          moves[at + 1] = handed[1];
          moves[at + 2] = handed[2];
        }
      }
    }
    let moved = 0;
    for (let at = 0; at < positions.length; at += VECTOR) {
      if (moves[at] === 0 && moves[at + 1] === 0 && moves[at + 2] === 0) continue;
      positions[at] += moves[at];
      positions[at + 1] += moves[at + 1];
      positions[at + 2] += moves[at + 2];
      moved += 1;
    }
    smoothNormals(positions, indices, normals, tune.normalPasses);
    return moved;
  };

  /**
   * How far out a thing worn over cloth must be moved to sit on it: the least move along `outward` after which
   * no cloth is in front of any of its points (inside it or behind it is where cloth under a pack belongs). A
   * pack authored against the back then sits on the cloak laid over that back instead of showing through it.
   * @param {ArrayLike<number>} points x, y, z of the thing (its corners will do)
   * @param {number[]} outward unit direction away from the body
   * @param {Under} cloth the cloth laid so far (`Kit.drape.under` of its solids)
   * @param {{seatStep?: number, mostSeat?: number, seatReach?: number, seatProbe?: number}} [options] see `DRAPE`
   * @returns {number} metres, 0 when nothing is in front of it; never more than `mostSeat`
   * @complexity O(mostSeat / seatStep x points x seatReach / seatProbe x solids) at worst
   * @example const shift = Kit.drape.seat(packCorners, [0, 0, -1], Kit.drape.under(cloakSolids)); // 0.05: the cloak's back is 5 cm behind the pack's
   */
  const seat = (points, outward, cloth, options = {}) => {
    const tune = { ...DRAPE, ...options };
    const probes = Math.ceil(tune.seatReach / tune.seatProbe);
    /** The first point with cloth in front of it once the thing is moved out by `shift`, from `from` on; -1 when none. */
    const covered = (shift, from) => {
      for (let turn = 0; turn < points.length; turn += VECTOR) {
        const at = (from + turn) % points.length;
        for (let probe = 0; probe <= probes; probe++) {
          const along = shift + probe * tune.seatProbe;
          if (cloth.distance(points[at] + outward[0] * along, points[at + 1] + outward[1] * along, points[at + 2] + outward[2] * along) < 0) return at;
        }
      }
      return -1;
    };
    let shift = 0;
    // The point that was covered last is asked first: it is most often the one still covered.
    for (let last = covered(0, 0); last >= 0 && shift < tune.mostSeat; last = covered(shift, last)) shift = Math.min(tune.mostSeat, shift + tune.seatStep);
    return shift;
  };

  /**
   * Shares a cloth's vertices between the body bones beneath it and the bone it hangs from. Where the cloth
   * lies on the body (within `contact`) the body carries it, so a knee pushes a skirt; further off it rides
   * its own bone more, and `clings` beyond contact it rides its own bone alone, so a bone that is simulated (a
   * loose cloak, a swaying hem) carries the cloth that hangs free.
   * @param {{owners: Uint16Array, weights: Float32Array}} skin the body's share (`Kit.sculpt.weights`); changed in place
   * @param {Float32Array} positions the cloth's vertices
   * @param {ArrayLike<number>|number} own the cloth's own bone: one for all, or one per vertex
   * @param {function(number, number, number): number} bodyDistance metres from a point to the body that carries the cloth
   * @param {{contact?: number, clings?: number}} [options] `clings`: metres (default `DRAPE.clings`); `contact` as `DRAPE`
   * @returns {{owners: Uint16Array, weights: Float32Array}} `skin`
   * @complexity O(vertices x the cost of `bodyDistance`)
   * @example Kit.drape.ride(skin, cloak.positions, cloakBone, bodyUnder.distance, { clings: 0.03 });
   */
  const ride = (skin, positions, own, bodyDistance, options = {}) => {
    const contact = options.contact === undefined ? DRAPE.contact : options.contact;
    const clings = Math.max(TINY, options.clings === undefined ? DRAPE.clings : options.clings);
    const { owners, weights } = skin;
    for (let vertex = 0; vertex < positions.length / VECTOR; vertex++) {
      const off = (bodyDistance(positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2]) - contact) / clings;
      const free = Math.max(0, Math.min(1, off));
      // Eased at both ends, so the cloth leaves the body and joins its own bone without a crease.
      const share = free * free * (3 - 2 * free);
      if (share <= 0) continue;
      const bone = typeof own === 'number' ? own : own[vertex];
      const at = vertex * OWNERS;
      // The own bone takes the weakest slot (the last: owners are strongest first); the rest keep their proportions.
      let kept = 0;
      for (let slot = 0; slot < OWNERS - 1; slot++) kept += weights[at + slot];
      for (let slot = 0; slot < OWNERS - 1; slot++) weights[at + slot] = kept > 0 ? (weights[at + slot] / kept) * (1 - share) : 0;
      owners[at + OWNERS - 1] = bone;
      weights[at + OWNERS - 1] = kept > 0 ? share : 1;
    }
    return skin;
  };

  Kit.drape = { DRAPE, FAR, under, cloud, swingAxis, hangAngle, turnAbout, shell, round, settle, seat, smoothNormals, ride };
})();
