/**
 * Kit surface: where things sit on the surface of a simple solid. A solid is a primitive described as data
 * (capsule, sphere, box, lathe, extrude) in its own local frame; this module answers "how far is this point from
 * its surface", "where does a ray from its centre at this azimuth and elevation leave it, and which way does the
 * surface face there", and "what are the along / around coordinates of a point", which is what a face feature,
 * a decal, a pattern or a sticker needs, whatever it is stuck on.
 *
 * Owns:  `Kit.surface.distance` (an approximate signed distance per primitive kind), `place` (azimuth and
 *        elevation -> surface point, normal and up tangent), `pair` (two mirrored placements), `along` (the
 *        along / around / height coordinates of a point), `ellipse` (an outline polygon for stamps), and the
 *        `KINDS` and `AROUND` tables.
 * Does not own: what the solids belong to (kit/body-surface.js puts features on bones), drawing, or the region
 *        predicates evaluated at those coordinates (kit/region.js).
 *
 * The frame: a solid lives in a space whose long axis is `axis` (0 = x, 1 = y, 2 = z) and whose far end is `end`
 * [x, y, z] (a capsule runs from the origin to `end`; a lathe's profile and an extrude's outline run along the
 * positive long axis, as kit/figure-shapes.js builds them: a skirt hanging down states negative heights). Azimuth turns about +Y from +Z towards +X; elevation rises towards +Y.
 * Every primitive may add `at` (an offset) and `scale` ([x, y, z], about `at`).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const VECTOR_STRIDE = 3;
  /** Bisection steps when a ray leaves a solid: 2^-28 of the search span, far below a pixel. */
  const BISECTION_STEPS = 28;
  /** The search span grows by this factor until the ray is outside; a solid is never larger than this many doublings of its first guess. */
  const GROWTH_FACTOR = 2;
  const MOST_GROWTH_STEPS = 24;
  /** Central-difference step for normals, metres: small next to any feature, large next to float error. */
  const NORMAL_STEP = 1e-4;
  /** Default girth when a frame gives none, metres (the same default as a body bone). */
  const DEFAULT_GIRTH = 0.06;
  const DEFAULT_ELLIPSE_POINTS = 12;
  const NOWHERE = Infinity;

  /**
   * Which two axes the around-angle is measured in, per long axis: [front, side]. Angle 0 faces the front axis
   * and grows towards the side axis. A bone along y or x faces +z; a bone along z (a forward-pointing head or
   * tail) faces +y, its top.
   */
  const AROUND = Object.freeze({ 0: [2, 1], 1: [2, 0], 2: [1, 0] });

  /**
   * @typedef {Object} SurfaceFrame
   * @property {number[]} end [x, y, z] the far end of the solid's long axis in its own space (a bone's tail)
   * @property {number} [axis] the long axis, 0 = x, 1 = y, 2 = z (default: the largest component of `end`)
   * @property {number} [girth] thickness for a capsule that states no radius, metres (default 0.06)
   */

  /**
   * @typedef {Object} Placement
   * @property {number[]} point [x, y, z] on the surface, in the solid's space
   * @property {number[]} normal unit [x, y, z], pointing out of the solid
   * @property {number[]} up unit [x, y, z] in the surface's tangent plane, as close to +Y as the surface allows
   *   (a stamp's v axis); the u axis is up x normal
   */

  const axisOf = (frame) => {
    if (frame.axis !== undefined) return frame.axis;
    // Asked per point by `along` (thousands of times per sculpted layer): no allocation. Ties go to the lower axis.
    const [sizeX, sizeY, sizeZ] = [Math.abs(frame.end[0]), Math.abs(frame.end[1]), Math.abs(frame.end[2])];
    if (sizeX === 0 && sizeY === 0 && sizeZ === 0) return 1;
    return sizeX >= sizeY && sizeX >= sizeZ ? 0 : sizeY >= sizeZ ? 1 : 2;
  };
  /**
   * The direction a lathe's profile and an extrude's outline run along the long axis: always the positive way,
   * as the figure renderer (kit/figure-shapes.js) builds them; a skirt that hangs down has negative `along`s.
   */
  const directionOf = (_frame, _axis) => 1;
  /** The extrude convention of kit/figure-shapes.js `ACROSS_AXIS`: long axis -> the axis an outline's first coordinate lies along. */
  const ACROSS = Object.freeze({ 0: 1, 1: 0, 2: 1 });
  /** Component `index` of (x, y, z) without building an array. */
  const componentOf = (index, x, y, z) => (index === 0 ? x : index === 1 ? y : z);
  const lengthOf = (frame) => Math.hypot(frame.end[0], frame.end[1], frame.end[2]);

  /**
   * Signed distance from a point to a closed 2D polygon, negative inside (even-odd inside test).
   * @param {ReadonlyArray<number[]>} points [[u, v], ...] in order; the last joins the first
   * @param {number} u the point
   * @param {number} v
   * @returns {number} same units as the points
   * @complexity O(points) time, no allocation
   * @example Kit.surface.polygonDistance([[0, 0], [1, 0], [0, 1]], 0.2, 0.2) // -0.2
   */
  const polygonDistance = (points, u, v) => {
    let nearest = Infinity;
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      // Indexed reads and a squared distance (one root at the end): this loop is most of what placing a face costs.
      const ua = points[previous][0];
      const va = points[previous][1];
      const ub = points[index][0];
      const vb = points[index][1];
      const edgeU = ub - ua;
      const edgeV = vb - va;
      const lengthSquared = edgeU * edgeU + edgeV * edgeV || 1;
      const along = Math.max(0, Math.min(1, ((u - ua) * edgeU + (v - va) * edgeV) / lengthSquared));
      const gapU = u - ua - edgeU * along;
      const gapV = v - va - edgeV * along;
      nearest = Math.min(nearest, gapU * gapU + gapV * gapV);
      // Even-odd crossing of a horizontal ray towards +u.
      if (va > v !== vb > v && u < ((ub - ua) * (v - va)) / (vb - va) + ua) inside = !inside;
    }
    return inside ? -Math.sqrt(nearest) : Math.sqrt(nearest);
  };

  /** Lathe sections built so far, by profile: a placement measures the same profile about a hundred times. */
  const sections = new WeakMap();
  /** A lathe's profile and its mirror across the axis, so the axis is inside the solid rather than an edge of it. */
  const latheSection = (profile) => {
    const known = sections.get(profile);
    if (known) return known;
    const section = [...profile, ...profile.map(([radius, alongAxis]) => [-radius, alongAxis]).reverse()];
    sections.set(profile, section);
    return section;
  };

  /**
   * Signed distance per primitive kind, from a point already moved into the primitive's own space (offset and
   * scale undone). Each takes (shape, frame, axis, direction, x, y, z). Exact for sphere, box and capsule; the
   * lathe and extrude are exact in their 2D section and good enough to bisect on.
   */
  const KINDS = Object.freeze({
    sphere: (shape, _frame, _axis, _direction, x, y, z) => Math.hypot(x, y, z) - shape.radius,
    box: (shape, _frame, _axis, _direction, x, y, z) => {
      const outX = Math.abs(x) - shape.size[0] / 2;
      const outY = Math.abs(y) - shape.size[1] / 2;
      const outZ = Math.abs(z) - shape.size[2] / 2;
      return Math.hypot(Math.max(outX, 0), Math.max(outY, 0), Math.max(outZ, 0)) + Math.min(Math.max(outX, outY, outZ), 0);
    },
    capsule: (shape, frame, _axis, _direction, x, y, z) => {
      const [endX, endY, endZ] = frame.end;
      const lengthSquared = endX * endX + endY * endY + endZ * endZ || 1;
      const along = Math.max(0, Math.min(1, (x * endX + y * endY + z * endZ) / lengthSquared));
      const radius = shape.radius === undefined ? (frame.girth === undefined ? DEFAULT_GIRTH : frame.girth) / 2 : shape.radius;
      // A taper narrows the far end: the radius slides from `radius` to `radius x taper` along the segment.
      const taper = shape.taper === undefined ? 1 : shape.taper;
      return Math.hypot(x - endX * along, y - endY * along, z - endZ * along) - radius * (1 + (taper - 1) * along);
    },
    lathe: (shape, _frame, axis, direction, x, y, z) => {
      const point = [x, y, z];
      const height = point[axis] * direction;
      const radial = Math.hypot(point[(axis + 1) % VECTOR_STRIDE], point[(axis + 2) % VECTOR_STRIDE]);
      // The section is the profile and its mirror across the axis, so the axis is inside the solid, not an edge of it.
      return polygonDistance(latheSection(shape.profile), radial, height);
    },
    extrude: (shape, _frame, axis, direction, x, y, z) => {
      const point = [x, y, z];
      // The outline lies in the plane of the long axis and the across axis; depth runs along the third axis.
      const across = shape.across === undefined ? ACROSS[axis] : 'xyz'.indexOf(shape.across);
      const through = VECTOR_STRIDE - axis - across;
      const inPlane = polygonDistance(shape.outline, point[across], point[axis] * direction);
      const outOfPlane = Math.abs(point[through]) - shape.depth / 2;
      return Math.hypot(Math.max(inPlane, 0), Math.max(outOfPlane, 0)) + Math.min(Math.max(inPlane, outOfPlane), 0);
    },
    none: () => NOWHERE,
  });

  /**
   * The approximate signed distance from a point to a solid's surface: negative inside, positive outside.
   * @param {?Object} shape `{ kind, ...fields, at?, scale? }`; null means a capsule along the frame
   * @param {SurfaceFrame} frame
   * @param {number} x point in the solid's space, metres
   * @param {number} y
   * @param {number} z
   * @returns {number} metres (Infinity for `none`)
   * @throws {Error} for an unknown kind
   * @complexity O(1) for sphere, box and capsule; O(points) for a lathe or extrude
   * @example Kit.surface.distance({ kind: 'sphere', radius: 0.1 }, { end: [0, 0.2, 0] }, 0, 0.1, 0) // -0.1
   */
  const distance = (shape, frame, x, y, z) => {
    const solid = shape || { kind: 'capsule' };
    const measure = KINDS[solid.kind];
    if (!measure) throw new Error(`Kit.surface.distance: unknown shape kind ${JSON.stringify(solid.kind)}; use one of ${Object.keys(KINDS).join(', ')}.`);
    const axis = axisOf(frame);
    const offset = solid.at || [0, 0, 0];
    const scale = solid.scale || [1, 1, 1];
    // Undo the offset and the stretch; the distance is then shrunk by the smallest stretch so it never overshoots.
    const smallestScale = Math.min(scale[0], scale[1], scale[2]);
    return measure(solid, frame, axis, directionOf(frame, axis), (x - offset[0]) / scale[0], (y - offset[1]) / scale[1], (z - offset[2]) / scale[2]) * smallestScale;
  };

  /** The middle of a solid, where placement rays start: half-way along what it spans, plus its offset. */
  const centreOf = (shape, frame) => {
    const solid = shape || { kind: 'capsule' };
    const axis = axisOf(frame);
    const centre = [...(solid.at || [0, 0, 0])];
    const scale = solid.scale || [1, 1, 1];
    const spanOf = (pairs, index) => {
      const values = pairs.map((pair) => pair[index]);
      return (Math.min(...values) + Math.max(...values)) / 2;
    };
    if (solid.kind === 'capsule') return frame.end.map((value, index) => centre[index] + value / 2);
    if (solid.kind === 'lathe') centre[axis] += spanOf(solid.profile, 1) * directionOf(frame, axis) * scale[axis];
    if (solid.kind === 'extrude') centre[axis] += spanOf(solid.outline, 1) * directionOf(frame, axis) * scale[axis];
    return centre;
  };

  /** Unit direction for an azimuth and elevation in degrees: azimuth about +Y from +Z towards +X, elevation towards +Y. */
  const directionFor = (azimuthDegrees, elevationDegrees) => {
    const azimuth = azimuthDegrees * DEGREES_TO_RADIANS;
    const elevation = elevationDegrees * DEGREES_TO_RADIANS;
    return [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
  };

  const normalize = (vector) => {
    const size = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return vector.map((value) => value / size);
  };

  /**
   * Where a ray from the solid's centre at an azimuth and elevation leaves the solid: the point, the outward
   * normal there, and the tangent closest to +Y. This is how a face feature finds its spot on any head shape:
   * change the head's profile and the eyes follow the new surface.
   * @param {?Object} shape as `distance`
   * @param {SurfaceFrame} frame
   * @param {number} azimuth degrees about +Y from +Z (the front) towards +X (the solid's left)
   * @param {number} elevation degrees above the centre, towards +Y
   * @returns {?Placement} null for `none`, or when the ray starts outside the solid (a thin extrude seen edge-on)
   * @complexity O(cost of `distance` x about 40): a few microseconds for a lathe; call it when a shape changes, not per frame
   * @example
   * const eye = Kit.surface.place({ kind: 'sphere', radius: 0.1 }, { end: [0, 0.2, 0] }, 30, 5);
   * eye.point   // about [0.05, 0.009, 0.086]
   */
  const place = (shape, frame, azimuth, elevation) => {
    const centre = centreOf(shape, frame);
    const direction = directionFor(azimuth, elevation);
    const at = (distanceAlong) => distance(shape, frame, centre[0] + direction[0] * distanceAlong, centre[1] + direction[1] * distanceAlong, centre[2] + direction[2] * distanceAlong);
    if (!(at(0) < 0)) return null;
    // Grow the span until the ray is outside, then bisect the crossing.
    let inside = 0;
    let outside = Math.max(lengthOf(frame), frame.girth || DEFAULT_GIRTH) / 2 || DEFAULT_GIRTH;
    for (let step = 0; at(outside) < 0 && step < MOST_GROWTH_STEPS; step++) {
      inside = outside;
      outside *= GROWTH_FACTOR;
    }
    for (let step = 0; step < BISECTION_STEPS; step++) {
      const middle = (inside + outside) / 2;
      if (at(middle) < 0) inside = middle;
      else outside = middle;
    }
    const reach = (inside + outside) / 2;
    const point = centre.map((value, index) => value + direction[index] * reach);
    // The outward normal is the gradient of the distance, by central differences.
    const gradient = [0, 1, 2].map((index) => {
      const ahead = [...point];
      const behind = [...point];
      ahead[index] += NORMAL_STEP;
      behind[index] -= NORMAL_STEP;
      return distance(shape, frame, ahead[0], ahead[1], ahead[2]) - distance(shape, frame, behind[0], behind[1], behind[2]);
    });
    const normal = normalize(gradient);
    // Up: +Y with its normal component removed; on a surface facing straight up, fall back to -Z (towards the back).
    const towardsY = normal[1];
    const up = Math.abs(towardsY) > 0.999 ? normalize([0, 0, -Math.sign(towardsY)]) : normalize([-normal[0] * towardsY, 1 - towardsY * towardsY, -normal[2] * towardsY]);
    return { point, normal, up };
  };

  /**
   * The two azimuths of a mirrored pair: `spacing` degrees apart, centred on `azimuth`. The first is the one on
   * the solid's left (+X), the second its mirror on the right.
   * @param {number} azimuth degrees; 0 for a pair centred on the front
   * @param {number} spacing degrees between the two
   * @returns {number[]} [left, right] in degrees
   * @complexity O(1)
   * @example Kit.surface.pair(0, 50) // [25, -25]
   */
  const pair = (azimuth, spacing) => [azimuth + spacing / 2, azimuth - spacing / 2];

  /**
   * The coordinates of a point that region predicates read: how far along the solid's long axis it is (0 at the
   * origin, 1 at `end`), the angle around that axis (radians, 0 at the front axis of `AROUND`, growing towards
   * its side axis).
   * @param {SurfaceFrame} frame
   * @param {number} x point in the solid's space
   * @param {number} y
   * @param {number} z
   * @param {number[]} [out] receives [along, angle]; a new array when omitted
   * @returns {number[]} `out`: along in [0, 1] (clamped), angle in (-pi, pi]
   * @complexity O(1)
   * @example Kit.surface.along({ end: [0, -0.4, 0] }, 0.05, -0.2, 0) // [0.5, ~1.571]: half-way down, at the left side
   */
  const along = (frame, x, y, z, out = [0, 0]) => {
    const around = AROUND[axisOf(frame)];
    const endX = frame.end[0];
    const endY = frame.end[1];
    const endZ = frame.end[2];
    const lengthSquared = endX * endX + endY * endY + endZ * endZ;
    const front = around[0];
    const side = around[1];
    // Hot for a renderer that samples many points: no allocation when `out` is passed.
    out[0] = lengthSquared > 0 ? Math.max(0, Math.min(1, (x * endX + y * endY + z * endZ) / lengthSquared)) : 0;
    out[1] = Math.atan2(componentOf(side, x, y, z), componentOf(front, x, y, z));
    return out;
  };

  /**
   * An ellipse as an outline polygon, for stamps drawn as data (an eye, a pupil, a freckle).
   * @param {number} centreU
   * @param {number} centreV
   * @param {number} radiusU
   * @param {number} radiusV
   * @param {number} [points=12]
   * @param {{from?: number, to?: number}} [arc] degrees of the arc to keep (default the whole ellipse), for a lid or a smile
   * @returns {number[][]} [[u, v], ...] counter-clockwise
   * @complexity O(points)
   * @example Kit.surface.ellipse(0, 0, 1, 0.6) // an almond-ish eye white
   */
  const ellipse = (centreU, centreV, radiusU, radiusV, points = DEFAULT_ELLIPSE_POINTS, { from = 0, to = 360 } = {}) => {
    // A whole ellipse closes itself; an arc keeps both of its end points.
    const count = to - from >= 360 ? points : points + 1;
    return Array.from({ length: count }, (_unused, index) => {
      const angle = (from + ((to - from) * index) / points) * DEGREES_TO_RADIANS;
      return [centreU + Math.cos(angle) * radiusU, centreV + Math.sin(angle) * radiusV];
    });
  };

  Kit.surface = { KINDS, AROUND, distance, place, pair, along, ellipse, polygonDistance };
})();
