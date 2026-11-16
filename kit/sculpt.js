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
   * Grid cell size by level of detail, metres, and the fewest cells across the thinnest solid (a finer grid is
   * used when a solid would otherwise fall between samples, down to `finest`).
   */
  const DETAIL = Object.freeze({
    high: Object.freeze({ cell: 0.011, finest: 0.006 }),
    medium: Object.freeze({ cell: 0.018, finest: 0.012 }),
    low: Object.freeze({ cell: 0.03, finest: 0.03 }),
  });
  /** A solid thinner than this many cells is at risk of vanishing between samples. */
  const FEWEST_CELLS_ACROSS = 2.5;
  /** Most grid nodes of one field: a guard against a stray huge solid, not a tuning knob. */
  const MOST_NODES = 6e6;
  /** Two surfaces crossing at this cosine between their outward directions (60 degrees apart) or less get the full fillet. */
  const CROSSING_COSINE = 0.5;
  /** A group's join with the rest stays full within this many fillet widths of its anchor, and is gone at twice that. */
  const JOIN_REACH = 2.5;
  /** "Far outside": the value of a node no solid reached, metres. */
  const FAR = 1e3;
  /** Steps of bisection when a surface crossing is found along a grid edge through a cut (2^-7 of a cell). */
  const CUT_STEPS = 7;
  /** Points per run of a smooth lathe's profile when its distance is measured. */
  const LATHE_SMOOTH_STEPS = 4;
  const VECTOR = 3;
  /** Owners per vertex: what a skinned mesh can carry. */
  const OWNERS = 4;
  const EPSILON = 1e-9;

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
   * @returns {number}
   * @complexity O(1)
   * @example Kit.sculpt.smoothMin(0.01, 0.01, 0.04) // 0: two surfaces a centimetre away each are joined here
   */
  const smoothMin = (first, second, radius) => {
    const closeness = radius > 0 ? Math.max(radius - Math.abs(first - second), 0) / radius : 0;
    return Math.min(first, second) - closeness * closeness * radius * 0.25;
  };

  // ---- distance to one shape, in the shape's own space ----------------------------------------------------------------

  /** Distance from (u, v) to a closed polygon, negative inside: the even-odd rule for the sign, nearest edge for the size. */
  const polygonDistance = (points, u, v) => {
    let nearest = Infinity;
    let isInside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const [fromU, fromV] = points[previous];
      const [toU, toV] = points[index];
      const [edgeU, edgeV] = [toU - fromU, toV - fromV];
      const share = Math.max(0, Math.min(1, ((u - fromU) * edgeU + (v - fromV) * edgeV) / (edgeU * edgeU + edgeV * edgeV || 1)));
      nearest = Math.min(nearest, Math.hypot(u - fromU - edgeU * share, v - fromV - edgeV * share));
      if (fromV > v !== toV > v && u < fromU + ((v - fromV) / (toV - fromV)) * edgeU) isInside = !isInside;
    }
    return isInside ? -nearest : nearest;
  };

  /**
   * Distance functions by shape kind, each `(shape) -> (x, y, z) -> metres` in the shape's space with `at`
   * already taken off. Adding a kind of solid means adding a row here and a builder in kit/figure-shapes.js.
   */
  const KINDS = Object.freeze({
    /** A round cone: a ball of `radius` at the origin swept to a ball of `endRadius` at `end`. */
    capsule: ({ end, radius, endRadius = radius }) => {
      const [endX, endY, endZ] = end;
      const lengthSquared = endX * endX + endY * endY + endZ * endZ;
      const change = endRadius - radius;
      return (x, y, z) => {
        const share = lengthSquared > EPSILON ? Math.max(0, Math.min(1, (x * endX + y * endY + z * endZ) / lengthSquared)) : 0;
        return Math.hypot(x - endX * share, y - endY * share, z - endZ * share) - (radius + change * share);
      };
    },
    sphere:
      ({ radius }) =>
      (x, y, z) =>
        Math.hypot(x, y, z) - radius,
    box: ({ size }) => {
      const [halfX, halfY, halfZ] = size.map((value) => value / 2);
      return (x, y, z) => {
        const [overX, overY, overZ] = [Math.abs(x) - halfX, Math.abs(y) - halfY, Math.abs(z) - halfZ];
        return Math.hypot(Math.max(overX, 0), Math.max(overY, 0), Math.max(overZ, 0)) + Math.min(Math.max(overX, overY, overZ), 0);
      };
    },
    /** A profile turned about the long axis: the polygon it encloses with the axis, measured in (radius, along). */
    lathe: ({ profile: authored, axis, smooth }) => {
      // A smooth lathe is the curve through its points, exactly as kit/figure-shapes.js builds it.
      const profile = smooth ? Kit.figure.smoothProfile(authored, LATHE_SMOOTH_STEPS) : authored;
      const first = profile[0];
      const last = profile[profile.length - 1];
      const section = [[0, first[1]], ...profile, [0, last[1]]];
      const [sideA, sideB] = [(axis + 1) % VECTOR, (axis + 2) % VECTOR];
      return (x, y, z) => {
        const point = [x, y, z];
        return polygonDistance(section, Math.hypot(point[sideA], point[sideB]), point[axis]);
      };
    },
    /** A flat outline with thickness: the outline's distance in its plane, capped by the slab. */
    extrude: ({ outline, depth, axis, across }) => {
      const through = VECTOR - axis - across;
      const halfDepth = depth / 2;
      return (x, y, z) => {
        const point = [x, y, z];
        const inPlane = polygonDistance(outline, point[across], point[axis]);
        const overDepth = Math.abs(point[through]) - halfDepth;
        return Math.hypot(Math.max(inPlane, 0), Math.max(overDepth, 0)) + Math.min(Math.max(inPlane, overDepth), 0);
      };
    },
  });

  /**
   * The signed distance function of a shape descriptor (kit/figure-shapes.js `ShapeDescriptor`), honouring its
   * `at`, `scale`, `basis` and `inflate`. Under a stretch the distance is shrunk by the smallest stretch, so it
   * never overshoots the surface.
   * @param {Object} shape a `ShapeDescriptor`
   * @returns {function(number, number, number): number} metres, negative inside, in the descriptor's (bone) space
   * @throws {Error} for a kind with no distance function
   * @complexity O(1) to make; per call O(1), or O(points) for a lathe or extrude
   * @example Kit.sculpt.distanceOf({ kind: 'sphere', radius: 0.1, at: [0, 0.2, 0] })(0, 0.2, 0) // -0.1
   */
  const distanceOf = (shape) => {
    const make = KINDS[shape.kind];
    if (!make) fail('distanceOf', `no distance for the shape kind "${shape.kind}". Kinds: ${Object.keys(KINDS).join(', ')}.`);
    const measure = make(shape);
    const [atX, atY, atZ] = shape.at || [0, 0, 0];
    const [scaleX, scaleY, scaleZ] = shape.scale || [1, 1, 1];
    const shrink = Math.min(scaleX, scaleY, scaleZ);
    const inflate = shape.inflate || 0;
    const { basis } = shape;
    if (!basis) return (x, y, z) => measure((x - atX) / scaleX, (y - atY) / scaleY, (z - atZ) / scaleZ) * shrink - inflate;
    // The solid was built, stretched, then turned so its axes lie along the basis: undo the turn first.
    const [across, up, out] = basis;
    return (x, y, z) => {
      const [dx, dy, dz] = [x - atX, y - atY, z - atZ];
      return measure((dx * across[0] + dy * across[1] + dz * across[2]) / scaleX, (dx * up[0] + dy * up[1] + dz * up[2]) / scaleY, (dx * out[0] + dy * out[1] + dz * out[2]) / scaleZ) * shrink - inflate;
    };
  };

  // ---- solids: a shape placed in the field's space --------------------------------------------------------------------

  /**
   * @typedef {Object} Solid
   * @property {number} owner who moves it (a bone index): becomes the vertices' skin
   * @property {function(number, number, number): number} distance signed distance in the field's space
   * @property {number[]} min [x, y, z] of its bounds in the field's space
   * @property {number[]} max
   * @property {number} thinness its smallest half-thickness, metres (decides how fine the grid must be)
   * @property {number} blend how wide a fillet it makes where it meets other solids, metres
   * @property {number} [group=0] solids of one group blend with each other everywhere (the segments of an arm)
   * @property {number[]} [anchor] [x, y, z]: where the solid's group joins the groups sampled before it (a
   *   shoulder). The join's fillet fades to nothing `joinReach` away from here, so an arm hanging beside a
   *   torso stays a separate arm instead of melting into the ribs. Without it the group joins everywhere
   * @property {number} [join] the fillet where the solid's group joins the rest, metres (default: the group's widest `blend`)
   * @property {number} [joinReach] metres from `anchor` over which the join stays full (default: 2.5 x `blend`)
   */

  /** Inverts the upper 3 x 4 of a column-major 4 x 4 affine matrix; returns the 12 numbers row by row. */
  const invertAffine = (matrix) => {
    const [a, b, c, d, e, f, g, h, i] = [matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9], matrix[2], matrix[6], matrix[10]];
    const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(determinant) < EPSILON) fail('solid', 'the transform has no inverse (a scale of zero?).');
    const inverse = [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant, (f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant, (d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant];
    const [tx, ty, tz] = [matrix[12], matrix[13], matrix[14]];
    return [inverse[0], inverse[1], inverse[2], -(inverse[0] * tx + inverse[1] * ty + inverse[2] * tz), inverse[3], inverse[4], inverse[5], -(inverse[3] * tx + inverse[4] * ty + inverse[5] * tz), inverse[6], inverse[7], inverse[8], -(inverse[6] * tx + inverse[7] * ty + inverse[8] * tz)];
  };

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
    const local = distanceOf(shape);
    const inverse = invertAffine(matrix);
    // Distances measured in the shape's space are scaled back by the smallest stretch of the transform.
    const stretches = [0, 1, 2].map((column) => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
    const shrink = Math.min(...stretches);
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
    return {
      owner,
      blend,
      min,
      max,
      thinness,
      distance: (x, y, z) => local(inverse[0] * x + inverse[1] * y + inverse[2] * z + inverse[3], inverse[4] * x + inverse[5] * y + inverse[6] * z + inverse[7], inverse[8] * x + inverse[9] * y + inverse[10] * z + inverse[11]) * shrink,
    };
  };

  // ---- the field: blended distances on a grid -------------------------------------------------------------------------

  /**
   * @typedef {Object} Field
   * @property {Float32Array} values distance at each node, x fastest, then y, then z
   * @property {Int16Array} nearest index (into the solids sampled) of the solid nearest each node, -1 where none reached
   * @property {number[]} size nodes along [x, y, z]
   * @property {number[]} origin [x, y, z] of node (0, 0, 0)
   * @property {number} cell metres between nodes
   * @property {Solid[]} solids what was sampled
   */

  /**
   * Samples solids into a field: at every grid node near a solid, the blended distance to all of them. Each
   * solid is sampled only inside its own bounds (grown by its blend), so the cost follows the solids' volume,
   * not the whole grid's.
   * @param {Solid[]} solids
   * @param {{detail?: string, cell?: number, margin?: number}} [options] `detail`: a key of `DETAIL` (default
   *   'high'); `cell` overrides its cell size; `margin`: room kept round the solids, metres, for layers that
   *   will be pushed out of this field (default 0.04)
   * @returns {Field}
   * @throws {Error} with no solids, or when the grid would exceed `MOST_NODES`
   * @complexity O(sum over solids of the nodes in its bounds) distance evaluations; O(nodes) memory
   * @example const field = Kit.sculpt.sample(bodySolids, { detail: 'medium' });
   */
  const sample = (solids, { detail = 'high', cell: givenCell, margin = 0.04 } = {}) => {
    if (!solids.length) fail('sample', 'needs at least one solid.');
    const level = DETAIL[detail];
    if (!level) fail('sample', `no detail "${detail}". Details: ${Object.keys(DETAIL).join(', ')}.`);
    // Fine enough that the thinnest solid still spans a few cells, within the level's limit.
    const thinnest = Math.min(...solids.map((part) => part.thinness).filter((value) => value > 0), Infinity);
    const cell = givenCell || Math.max(level.finest, Math.min(level.cell, (thinnest * 2) / FEWEST_CELLS_ACROSS));
    const reach = Math.max(...solids.map((part) => part.blend)) + margin + cell * 2;
    const low = [0, 1, 2].map((axis) => Math.min(...solids.map((part) => part.min[axis])) - reach);
    const high = [0, 1, 2].map((axis) => Math.max(...solids.map((part) => part.max[axis])) + reach);
    const size = low.map((value, axis) => Math.ceil((high[axis] - value) / cell) + 1);
    const count = size[0] * size[1] * size[2];
    if (count > MOST_NODES) fail('sample', `the grid would have ${count} nodes (${size.join(' x ')} at ${cell} m); a solid is much larger than the rest, or the detail is too fine.`);
    const values = new Float32Array(count).fill(FAR);
    const nearest = new Int16Array(count).fill(-1);
    /** The plain (unblended) distance of the nearest solid so far, to decide `nearest`. */
    const nearestDistance = new Float32Array(count).fill(FAR);
    const [sizeX, sizeY] = size;
    /** One group's blended distances, before it joins the rest. */
    const own = new Float32Array(count);
    const second = new Float32Array(count);
    const ownIndex = new Int16Array(count);
    const secondIndex = new Int16Array(count);
    const slopeStep = cell * 0.5;
    const groupIds = [...new Set(solids.map((part) => part.group || 0))];
    groupIds.forEach((groupId, groupOrder) => {
      const members = solids.map((part, index) => ({ part, index })).filter(({ part }) => (part.group || 0) === groupId);
      const boxFrom = [Infinity, Infinity, Infinity];
      const boxTo = [-Infinity, -Infinity, -Infinity];
      const boxes = members.map(({ part }) => {
        const pad = part.blend + margin + cell;
        const from = [0, 1, 2].map((axis) => Math.max(0, Math.floor((part.min[axis] - pad - low[axis]) / cell)));
        const to = [0, 1, 2].map((axis) => Math.min(size[axis] - 1, Math.ceil((part.max[axis] + pad - low[axis]) / cell)));
        for (let axis = 0; axis < VECTOR; axis++) {
          boxFrom[axis] = Math.min(boxFrom[axis], from[axis]);
          boxTo[axis] = Math.max(boxTo[axis], to[axis]);
        }
        return { from, to };
      });
      for (let nodeZ = boxFrom[2]; nodeZ <= boxTo[2]; nodeZ++) {
        for (let nodeY = boxFrom[1]; nodeY <= boxTo[1]; nodeY++) {
          const [from, to] = [boxFrom[0] + sizeX * (nodeY + sizeY * nodeZ), boxTo[0] + 1 + sizeX * (nodeY + sizeY * nodeZ)];
          own.fill(FAR, from, to);
          second.fill(FAR, from, to);
        }
      }
      // First pass: the nearest and the second nearest solid of the group at every node.
      members.forEach(({ part, index }, member) => {
        const { from, to } = boxes[member];
        // Hot loop: one distance evaluation per node of the solid's bounds, written straight into the typed arrays.
        for (let nodeZ = from[2]; nodeZ <= to[2]; nodeZ++) {
          for (let nodeY = from[1]; nodeY <= to[1]; nodeY++) {
            let node = from[0] + sizeX * (nodeY + sizeY * nodeZ);
            for (let nodeX = from[0]; nodeX <= to[0]; nodeX++, node++) {
              const distance = part.distance(low[0] + nodeX * cell, low[1] + nodeY * cell, low[2] + nodeZ * cell);
              if (distance < nearestDistance[node]) {
                nearestDistance[node] = distance;
                nearest[node] = index;
              }
              if (distance < own[node]) {
                second[node] = own[node];
                secondIndex[node] = ownIndex[node];
                own[node] = distance;
                ownIndex[node] = index;
              } else if (distance < second[node]) {
                second[node] = distance;
                secondIndex[node] = index;
              }
            }
          }
        }
      });
      // Second pass: where two solids are about equally near, fillet them, but only as far as their surfaces
      // cross. Two surfaces that run side by side (a waist inside a chest) are left alone: a plain rounded
      // minimum would swell wherever they coincide and ripple the whole body.
      const band = margin + cell * 2;
      for (let nodeZ = boxFrom[2]; nodeZ <= boxTo[2]; nodeZ++) {
        for (let nodeY = boxFrom[1]; nodeY <= boxTo[1]; nodeY++) {
          let node = boxFrom[0] + sizeX * (nodeY + sizeY * nodeZ);
          for (let nodeX = boxFrom[0]; nodeX <= boxTo[0]; nodeX++, node++) {
            const [first, other] = [own[node], second[node]];
            if (other === FAR || first > band || first < -band) continue;
            const [partA, partB] = [solids[ownIndex[node]], solids[secondIndex[node]]];
            const radius = Math.min(partA.blend, partB.blend);
            if (other - first >= radius) continue;
            const [x, y, z] = [low[0] + nodeX * cell, low[1] + nodeY * cell, low[2] + nodeZ * cell];
            const [ax, ay, az] = [partA.distance(x + slopeStep, y, z) - first, partA.distance(x, y + slopeStep, z) - first, partA.distance(x, y, z + slopeStep) - first];
            const [bx, by, bz] = [partB.distance(x + slopeStep, y, z) - other, partB.distance(x, y + slopeStep, z) - other, partB.distance(x, y, z + slopeStep) - other];
            const alignment = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1);
            // Full fillet when the surfaces meet at `CROSSING_COSINE` or more steeply; none when they are parallel.
            const crossing = Math.max(0, Math.min(1, (1 - alignment) / (1 - CROSSING_COSINE)));
            own[node] = smoothMin(first, other, radius * crossing);
          }
        }
      }
      // The group joins what is already there: fully near its anchor, not at all far from it.
      const { part: lead } = members[0];
      const joinBlend = lead.join === undefined ? Math.max(...members.map(({ part }) => part.blend)) : lead.join;
      const reach = lead.joinReach || joinBlend * JOIN_REACH;
      const anchor = groupOrder > 0 ? lead.anchor : null;
      for (let nodeZ = boxFrom[2]; nodeZ <= boxTo[2]; nodeZ++) {
        for (let nodeY = boxFrom[1]; nodeY <= boxTo[1]; nodeY++) {
          let node = boxFrom[0] + sizeX * (nodeY + sizeY * nodeZ);
          for (let nodeX = boxFrom[0]; nodeX <= boxTo[0]; nodeX++, node++) {
            const distance = own[node];
            if (distance === FAR) continue;
            const before = values[node];
            if (before === FAR) {
              values[node] = distance;
              continue;
            }
            const away = anchor ? Math.hypot(low[0] + nodeX * cell - anchor[0], low[1] + nodeY * cell - anchor[1], low[2] + nodeZ * cell - anchor[2]) : 0;
            values[node] = smoothMin(before, distance, joinBlend * Math.max(0, Math.min(1, 2 - away / reach)));
          }
        }
      }
    });
    return { values, nearest, size, origin: low, cell, solids };
  };

  /**
   * The field's value at any point, by blending the eight nodes round it.
   * @param {Field} field
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} metres; `FAR`-like values where no solid reached
   * @complexity O(1)
   * @example Kit.sculpt.valueAt(field, 0, 1.2, 0) < 0 // inside the chest
   */
  const valueAt = (field, x, y, z) => {
    const { values, size, origin, cell } = field;
    const [gx, gy, gz] = [(x - origin[0]) / cell, (y - origin[1]) / cell, (z - origin[2]) / cell];
    const [ix, iy, iz] = [Math.max(0, Math.min(size[0] - 2, Math.floor(gx))), Math.max(0, Math.min(size[1] - 2, Math.floor(gy))), Math.max(0, Math.min(size[2] - 2, Math.floor(gz)))];
    const [fx, fy, fz] = [gx - ix, gy - iy, gz - iz];
    const node = ix + size[0] * (iy + size[1] * iz);
    const [stepY, stepZ] = [size[0], size[0] * size[1]];
    const alongX = (base) => values[base] + (values[base + 1] - values[base]) * fx;
    const low = alongX(node) + (alongX(node + stepY) - alongX(node)) * fy;
    const high = alongX(node + stepZ) + (alongX(node + stepZ + stepY) - alongX(node + stepZ)) * fy;
    return low + (high - low) * fz;
  };

  // ---- the surface: surface nets --------------------------------------------------------------------------------------

  /** The eight corners of a cell as node offsets (x, y, z), and its twelve edges as corner pairs. */
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

  /**
   * @typedef {Object} SurfaceArrays
   * @property {Float32Array} positions 3 per vertex, in the field's space
   * @property {Float32Array} normals 3 per vertex, unit length, outward
   * @property {Uint16Array|Uint32Array} indices 3 per triangle
   */

  /**
   * The surface of a field as a mesh, by surface nets: one vertex in every grid cell the surface passes
   * through, placed at the average of where the surface crosses the cell's edges, and one quad across every
   * grid edge it crosses. The mesh is closed, evenly tessellated and smooth where the field is.
   *
   * `offset` pushes the surface out (a layer of cloth over a body is the body's field at a positive offset).
   * `cut(x, y, z)` keeps only the part of the solid where it returns true; the cut's edge is found by bisection
   * along each grid edge, so a hem or a hairline is as crisp as the predicate, not as coarse as the grid.
   * `keep(value)` drops triangles whose three corners all fail it, given the field's own value there (a layer
   * drops what is buried inside the body it lies on). `walls: false` drops the faces a cut makes through the
   * thickness, leaving an open sheet that lies on the surface (paint, not cloth).
   * @param {Field} field
   * @param {{offset?: number, cut?: function(number, number, number): boolean, keep?: function(number): boolean, walls?: boolean}} [options]
   * @returns {SurfaceArrays}
   * @complexity O(nodes) time to scan, O(surface cells) memory for the mesh
   * @example const skin = Kit.sculpt.surface(field); const sleeve = Kit.sculpt.surface(field, { offset: 0.008, cut: isSleeve });
   */
  const surface = (field, { offset = 0, cut = null, keep = null, walls = true } = {}) => {
    const { values, size, origin, cell } = field;
    const [sizeX, sizeY, sizeZ] = size;
    const [stepY, stepZ] = [sizeX, sizeX * sizeY];
    /** The solid's value at a node: the field pushed out, and "outside" wherever the cut says so. */
    const inside = new Uint8Array(values.length);
    for (let nodeZ = 0, node = 0; nodeZ < sizeZ; nodeZ++) {
      for (let nodeY = 0; nodeY < sizeY; nodeY++) {
        for (let nodeX = 0; nodeX < sizeX; nodeX++, node++) {
          inside[node] = values[node] - offset < 0 && (!cut || cut(origin[0] + nodeX * cell, origin[1] + nodeY * cell, origin[2] + nodeZ * cell)) ? 1 : 0;
        }
      }
    }
    /** Where along a grid edge (0 at `from`, 1 at `to`) the solid's surface crosses it. */
    const crossing = (from, to, fromX, fromY, fromZ, toX, toY, toZ) => {
      const [first, second] = [values[from] - offset, values[to] - offset];
      // Both ends inside the pushed-out field: the cut alone decides, so find its edge by bisection.
      if (cut && first < 0 && second < 0) {
        let [low, high] = [0, 1];
        const startsInside = inside[from] === 1;
        for (let step = 0; step < CUT_STEPS; step++) {
          const middle = (low + high) / 2;
          const isIn = cut(fromX + (toX - fromX) * middle, fromY + (toY - fromY) * middle, fromZ + (toZ - fromZ) * middle);
          if (isIn === startsInside) low = middle;
          else high = middle;
        }
        return (low + high) / 2;
      }
      const span = first - second;
      return Math.abs(span) > EPSILON ? Math.max(0, Math.min(1, first / span)) : 0.5;
    };

    const positions = [];
    /** Vertex index per cell, -1 where the surface does not pass; cells are indexed like their lowest node. */
    const vertexOf = new Int32Array(values.length).fill(-1);
    const corner = new Int32Array(8);
    for (let cellZ = 0; cellZ < sizeZ - 1; cellZ++) {
      for (let cellY = 0; cellY < sizeY - 1; cellY++) {
        for (let cellX = 0; cellX < sizeX - 1; cellX++) {
          const base = cellX + stepY * cellY + stepZ * cellZ;
          let mask = 0;
          for (let index = 0; index < 8; index++) {
            corner[index] = base + CORNERS[index][0] + CORNERS[index][1] * stepY + CORNERS[index][2] * stepZ;
            mask |= inside[corner[index]] << index;
          }
          if (mask === 0 || mask === 255) continue;
          let [sumX, sumY, sumZ, crossings] = [0, 0, 0, 0];
          for (let edge = 0; edge < EDGES.length; edge++) {
            const [a, b] = EDGES[edge];
            if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
            const [ax, ay, az] = [origin[0] + (cellX + CORNERS[a][0]) * cell, origin[1] + (cellY + CORNERS[a][1]) * cell, origin[2] + (cellZ + CORNERS[a][2]) * cell];
            const [bx, by, bz] = [origin[0] + (cellX + CORNERS[b][0]) * cell, origin[1] + (cellY + CORNERS[b][1]) * cell, origin[2] + (cellZ + CORNERS[b][2]) * cell];
            const share = crossing(corner[a], corner[b], ax, ay, az, bx, by, bz);
            sumX += ax + (bx - ax) * share;
            sumY += ay + (by - ay) * share;
            sumZ += az + (bz - az) * share;
            crossings += 1;
          }
          vertexOf[base] = positions.length / VECTOR;
          positions.push(sumX / crossings, sumY / crossings, sumZ / crossings);
        }
      }
    }

    const indices = [];
    /** A quad across the grid edge leaving `node` along `axis`, joining the four cells that share the edge. */
    const quad = (node, startsInside, stepA, stepB) => {
      const [first, second, third, fourth] = [vertexOf[node - stepA - stepB], vertexOf[node - stepB], vertexOf[node], vertexOf[node - stepA]];
      if (first < 0 || second < 0 || third < 0 || fourth < 0) return;
      if (startsInside) indices.push(first, second, third, first, third, fourth);
      else indices.push(first, third, second, first, fourth, third);
    };
    for (let nodeZ = 1; nodeZ < sizeZ - 1; nodeZ++) {
      for (let nodeY = 1; nodeY < sizeY - 1; nodeY++) {
        for (let nodeX = 1; nodeX < sizeX - 1; nodeX++) {
          const node = nodeX + stepY * nodeY + stepZ * nodeZ;
          const here = inside[node];
          // Along x the edge is shared by the cells at (y - 1, z - 1), (y, z - 1), (y, z), (y - 1, z); likewise y and z.
          if (here !== inside[node + 1]) quad(node, here === 1, stepY, stepZ);
          if (here !== inside[node + stepY]) quad(node, here === 1, stepZ, 1);
          if (here !== inside[node + stepZ]) quad(node, here === 1, 1, stepY);
        }
      }
    }

    const vertexCount = positions.length / VECTOR;
    const placed = Float32Array.from(positions);
    const unburied = keep ? dropBuried(field, placed, indices, keep) : indices;
    const kept = walls ? unburied : dropWalls(field, placed, unburied);
    const normals = normalsOf(placed, kept);
    settle(field, placed, normals, offset, !walls);
    return { positions: placed, normals, indices: vertexCount > 65535 ? Uint32Array.from(kept) : Uint16Array.from(kept) };
  };

  /** A vertex is on the smooth part of a surface (not on a cut's wall) when the field there is within this share of a cell of the surface. */
  const ON_SURFACE_SHARE = 0.6;
  /** A triangle normal further than this from the field's slope (as a cosine) marks a cut's wall: it keeps its own normal. */
  const WALL_COSINE = 0.5;

  /**
   * How far either side of a vertex the field's slope is measured, in cells. Wider than one cell on purpose: the
   * normal then follows the form and not the grid's last wobble, which banded shading would show as blotches.
   */
  const NORMAL_REACH = 2;

  /** The slope of the field at a point (not unit length), measured `step` either side. */
  const slopeAt = (field, x, y, z, step) => [valueAt(field, x + step, y, z) - valueAt(field, x - step, y, z), valueAt(field, x, y + step, z) - valueAt(field, x, y - step, z), valueAt(field, x, y, z + step) - valueAt(field, x, y, z - step)];

  /** Triangles that lie along the field's surface: those whose own normal is within `WALL_COSINE` of the field's slope. */
  const dropWalls = (field, positions, indices) => {
    const kept = [];
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      const [a, b, c] = [indices[corner] * VECTOR, indices[corner + 1] * VECTOR, indices[corner + 2] * VECTOR];
      const [ux, uy, uz] = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const [vx, vy, vz] = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const slope = slopeAt(field, (positions[a] + positions[b] + positions[c]) / VECTOR, (positions[a + 1] + positions[b + 1] + positions[c + 1]) / VECTOR, (positions[a + 2] + positions[b + 2] + positions[c + 2]) / VECTOR, field.cell);
      const facing = (nx * slope[0] + ny * slope[1] + nz * slope[2]) / ((Math.hypot(nx, ny, nz) || 1) * (Math.hypot(...slope) || 1));
      if (facing > WALL_COSINE) kept.push(indices[corner], indices[corner + 1], indices[corner + 2]);
    }
    return kept;
  };

  /**
   * Moves each vertex of the smooth surface onto the field's true surface and gives it the field's slope as
   * its normal. Surface nets place a vertex at an average inside its cell, which leaves a faint faceting that
   * banded shading turns into blotches; the field itself is smooth, so its slope is the better normal. Vertices
   * on a cut's wall (a hem's thickness) are left as they are.
   */
  const settle = (field, positions, normals, offset, everyVertex) => {
    const step = field.cell * NORMAL_REACH;
    for (let vertex = 0; vertex < positions.length; vertex += VECTOR) {
      const [x, y, z] = [positions[vertex], positions[vertex + 1], positions[vertex + 2]];
      const error = valueAt(field, x, y, z) - offset;
      if (!everyVertex && Math.abs(error) > field.cell * ON_SURFACE_SHARE) continue;
      const slopeX = valueAt(field, x + step, y, z) - valueAt(field, x - step, y, z);
      const slopeY = valueAt(field, x, y + step, z) - valueAt(field, x, y - step, z);
      const slopeZ = valueAt(field, x, y, z + step) - valueAt(field, x, y, z - step);
      const length = Math.hypot(slopeX, slopeY, slopeZ);
      if (length < EPSILON) continue;
      const [nx, ny, nz] = [slopeX / length, slopeY / length, slopeZ / length];
      if (!everyVertex && nx * normals[vertex] + ny * normals[vertex + 1] + nz * normals[vertex + 2] < WALL_COSINE) continue;
      positions[vertex] = x - nx * error;
      positions[vertex + 1] = y - ny * error;
      positions[vertex + 2] = z - nz * error;
      normals[vertex] = nx;
      normals[vertex + 1] = ny;
      normals[vertex + 2] = nz;
    }
  };

  /** Triangles with at least one corner where `keep(field value)` holds. */
  const dropBuried = (field, positions, indices, keep) => {
    const isKept = new Uint8Array(positions.length / VECTOR);
    for (let vertex = 0; vertex < isKept.length; vertex++) isKept[vertex] = keep(valueAt(field, positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2])) ? 1 : 0;
    const kept = [];
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      if (isKept[indices[corner]] || isKept[indices[corner + 1]] || isKept[indices[corner + 2]]) kept.push(indices[corner], indices[corner + 1], indices[corner + 2]);
    }
    return kept;
  };

  /** Smooth vertex normals: each triangle's area-weighted normal added to its corners. */
  const normalsOf = (positions, indices) => {
    const normals = new Float32Array(positions.length);
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      const [a, b, c] = [indices[corner] * VECTOR, indices[corner + 1] * VECTOR, indices[corner + 2] * VECTOR];
      const [ux, uy, uz] = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const [vx, vy, vz] = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const vertex of [a, b, c]) {
        normals[vertex] += nx;
        normals[vertex + 1] += ny;
        normals[vertex + 2] += nz;
      }
    }
    for (let vertex = 0; vertex < normals.length; vertex += VECTOR) {
      const length = Math.hypot(normals[vertex], normals[vertex + 1], normals[vertex + 2]) || 1;
      normals[vertex] /= length;
      normals[vertex + 1] /= length;
      normals[vertex + 2] /= length;
    }
    return normals;
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
   * @param {{spread?: number}} [options] metres over which ownership fades from one solid to the next (default 0.03)
   * @returns {SkinArrays}
   * @complexity O(vertices x solids whose bounds are near)
   * @example const { owners, weights } = Kit.sculpt.weights(skin.positions, field.solids);
   */
  const weights = (positions, solids, { spread = 0.03 } = {}) => {
    const count = positions.length / VECTOR;
    const owners = new Uint16Array(count * OWNERS);
    const shares = new Float32Array(count * OWNERS);
    /** Per owner, this vertex's summed share; reset through `touched` so the loop allocates nothing per vertex. */
    const shareOf = new Float32Array(Math.max(...solids.map((part) => part.owner)) + 1);
    const distances = new Float32Array(solids.length);
    const touched = [];
    for (let vertex = 0; vertex < count; vertex++) {
      const [x, y, z] = [positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2]];
      let closest = Infinity;
      for (let index = 0; index < solids.length; index++) {
        const part = solids[index];
        const isNear = x > part.min[0] - spread && x < part.max[0] + spread && y > part.min[1] - spread && y < part.max[1] + spread && z > part.min[2] - spread && z < part.max[2] + spread;
        distances[index] = isNear ? part.distance(x, y, z) : Infinity;
        closest = Math.min(closest, distances[index]);
      }
      touched.length = 0;
      for (let index = 0; index < solids.length; index++) {
        const nearness = 1 - (distances[index] - closest) / spread;
        if (!(nearness > 0)) continue;
        const { owner } = solids[index];
        if (shareOf[owner] === 0) touched.push(owner);
        shareOf[owner] += nearness * nearness;
      }
      // Strongest four owners, then made to sum to one.
      touched.sort((first, second) => shareOf[second] - shareOf[first]);
      let total = 0;
      for (let slot = 0; slot < Math.min(OWNERS, touched.length); slot++) total += shareOf[touched[slot]];
      for (let slot = 0; slot < OWNERS; slot++) {
        owners[vertex * OWNERS + slot] = slot < touched.length ? touched[slot] : 0;
        shares[vertex * OWNERS + slot] = slot < touched.length && total > 0 ? shareOf[touched[slot]] / total : 0;
      }
      if (!touched.length) shares[vertex * OWNERS] = 1;
      for (let index = 0; index < touched.length; index++) shareOf[touched[index]] = 0;
    }
    return { owners, weights: shares };
  };

  Kit.sculpt = { DETAIL, KINDS, FAR, invertAffine, smoothMin, polygonDistance, distanceOf, solid, sample, valueAt, surface, weights };
})();
