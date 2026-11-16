/**
 * Kit region: areas of a surface as data. A region is a small tree of predicates over the coordinates of a
 * surface point: how far along its solid it is (`s`, 0 to 1), the angle around the solid's long axis (radians,
 * 0 at the front), and the outward normal. Bands, stripes, checks, wavy edges and facing tests combine with
 * union, intersect, mask and not. A sleeve is "s below 0.6"; a hairline is "s above a line that is low at the
 * back and high at the front, with a fringe"; a belly patch is "facing forward and down".
 *
 * Owns:  `Kit.region.compile` (tree -> a test function, checked once), `Kit.region.at` (which of several
 *        painted layers covers a point: the topmost wins) and the `OPS` table (one row per predicate).
 * Does not own: where the coordinates come from (kit/surface.js `along` works them out for a primitive; a body
 *        bone's are in kit/body-surface.js), what a layer paints, or drawing.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const FULL_TURN = Math.PI * 2;
  const FULL_TURN_DEGREES = 360;
  const DEFAULT_DUTY = 0.5;
  /** `at` returns this when no layer covers the point. */
  const NONE = -1;

  const fail = (message) => {
    throw new Error(`Kit.region.compile: ${message}`);
  };

  /**
   * @callback RegionTest
   * @param {number} along s, 0 at the solid's origin to 1 at its far end
   * @param {number} angle radians around the long axis, 0 at the front, in (-pi, pi]
   * @param {number} normalX outward unit normal in the solid's space
   * @param {number} normalY
   * @param {number} normalZ
   * @returns {boolean} true when the point is inside the region
   */

  /** The share of a full turn an angle is at, 0 at the back (-pi) to 1 at the back again: for stripes around. */
  const turnShareOf = (angle) => angle / FULL_TURN + 0.5;
  const fraction = (value) => value - Math.floor(value);
  /** Is an angle inside [from, to] degrees, going the positive way, wrapping past 180? */
  const angleWithin = (angle, fromDegrees, toDegrees) => {
    const from = fromDegrees * DEGREES_TO_RADIANS;
    // The arc's width in [0, 360); equal ends mean the whole turn.
    const width = ((((toDegrees - fromDegrees) % FULL_TURN_DEGREES) + FULL_TURN_DEGREES) % FULL_TURN_DEGREES || FULL_TURN_DEGREES) * DEGREES_TO_RADIANS;
    return fraction((angle - from) / FULL_TURN) * FULL_TURN <= width;
  };
  const requireRange = (op, range) => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) fail(`"${op}" needs a [from, to] pair of numbers, got ${JSON.stringify(range)}.`);
    return range;
  };
  const requireList = (op, list) => {
    if (!Array.isArray(list) || !list.length) fail(`"${op}" needs a non-empty list of regions, got ${JSON.stringify(list)}.`);
    return list;
  };

  /**
   * The predicates, name -> (argument, compile) -> test. Adding a predicate means adding a row.
   *   all:       true                                  every point
   *   band:      { s?: [from, to], angle?: [from, to] } s within a range and / or angle within degrees (wraps)
   *   facing:    { toward: [x, y, z], above: number }   normal . toward >= above (above in -1..1)
   *   stripe:    { along: 's'|'angle', count, duty?, phase? }  `count` stripes; `duty` the share painted (0.5)
   *   checker:   { s: count, angle: count }            alternating cells (scales, a harlequin knit)
   *   edge:      { front, back, jag?, count?, below? }   s above a line that runs from `front` (at angle 0) to
   *              `back` (at the back), plus jag x sin(count x angle); `below: true` keeps the other side
   *   union:     [region, ...]                         in any
   *   intersect: [region, ...]                         in all
   *   mask:      { keep: region, cut: region }         in keep and not in cut
   *   not:       region
   */
  const OPS = Object.freeze({
    all: () => () => true,
    band: (argument) => {
      const sRange = argument.s && requireRange('band.s', argument.s);
      const angleRange = argument.angle && requireRange('band.angle', argument.angle);
      if (!sRange && !angleRange) fail('"band" needs `s` and / or `angle`.');
      return (along, angle) => (!sRange || (along >= sRange[0] && along <= sRange[1])) && (!angleRange || angleWithin(angle, angleRange[0], angleRange[1]));
    },
    facing: ({ toward, above = 0 }) => {
      if (!Array.isArray(toward) || toward.length !== 3) fail(`"facing" needs \`toward\` [x, y, z], got ${JSON.stringify(toward)}.`);
      const size = Math.hypot(toward[0], toward[1], toward[2]) || 1;
      const [towardX, towardY, towardZ] = toward.map((value) => value / size);
      return (_along, _angle, normalX, normalY, normalZ) => normalX * towardX + normalY * towardY + normalZ * towardZ >= above;
    },
    stripe: ({ along: coordinate = 's', count, duty = DEFAULT_DUTY, phase = 0 }) => {
      if (!(count > 0)) fail(`"stripe" needs a positive \`count\`, got ${JSON.stringify(count)}.`);
      if (coordinate !== 's' && coordinate !== 'angle') fail(`"stripe" runs along 's' or 'angle', got ${JSON.stringify(coordinate)}.`);
      return coordinate === 's' ? (along) => fraction(along * count + phase) < duty : (_along, angle) => fraction(turnShareOf(angle) * count + phase) < duty;
    },
    checker:
      ({ s: alongCount = 1, angle: aroundCount = 1 }) =>
      (along, angle) =>
        (Math.floor(along * alongCount) + Math.floor(turnShareOf(angle) * aroundCount)) % 2 === 0,
    edge: ({ front, back, jag = 0, count = 0, below = false }) => {
      if (!Number.isFinite(front) || !Number.isFinite(back)) fail(`"edge" needs numbers \`front\` and \`back\` (s at the front and at the back), got ${JSON.stringify({ front, back })}.`);
      return (along, angle) => {
        // (1 - cos) / 2 is 0 at the front and 1 at the back, smoothly, on both sides.
        const line = front + ((back - front) * (1 - Math.cos(angle))) / 2 + jag * Math.sin(count * angle);
        return below ? along <= line : along >= line;
      };
    },
    union: (argument) => {
      const tests = requireList('union', argument).map(compile);
      return (along, angle, normalX, normalY, normalZ) => tests.some((test) => test(along, angle, normalX, normalY, normalZ));
    },
    intersect: (argument) => {
      const tests = requireList('intersect', argument).map(compile);
      return (along, angle, normalX, normalY, normalZ) => tests.every((test) => test(along, angle, normalX, normalY, normalZ));
    },
    mask: ({ keep, cut }) => {
      const [keepTest, cutTest] = [compile(keep), compile(cut)];
      return (along, angle, normalX, normalY, normalZ) => keepTest(along, angle, normalX, normalY, normalZ) && !cutTest(along, angle, normalX, normalY, normalZ);
    },
    not: (argument) => {
      const test = compile(argument);
      return (along, angle, normalX, normalY, normalZ) => !test(along, angle, normalX, normalY, normalZ);
    },
  });

  /**
   * Turns a region tree into a test function. Every node is checked here, so a mistake in a content table is
   * reported at load, naming the predicate.
   * @param {Object} region one-key object `{ <op>: argument }` per `OPS`
   * @returns {RegionTest}
   * @throws {Error} for a node with no key or several, an unknown predicate, or a bad argument
   * @complexity O(nodes) to compile; the test is O(nodes) per point, no allocation
   * @example
   * const sleeve = Kit.region.compile({ band: { s: [0, 0.6] } });
   * sleeve(0.3, 0, 0, 0, 1) // true
   */
  const compile = (region) => {
    const keys = region && typeof region === 'object' && !Array.isArray(region) ? Object.keys(region) : [];
    if (keys.length !== 1) fail(`a region is one { predicate: argument } object, got ${JSON.stringify(region)}. Predicates: ${Object.keys(OPS).join(', ')}.`);
    const op = OPS[keys[0]];
    if (!op) fail(`unknown predicate "${keys[0]}". Predicates: ${Object.keys(OPS).join(', ')}.`);
    return op(region[keys[0]]);
  };

  /**
   * Which of several layers covers a point: the last one (the topmost) whose test passes.
   * @param {ReadonlyArray<{test: RegionTest}>} layers in paint order, bottom first
   * @param {number} along s, 0 to 1
   * @param {number} angle radians, 0 at the front
   * @param {number} normalX
   * @param {number} normalY
   * @param {number} normalZ
   * @returns {number} the layer's index, or -1 (`NONE`) when none covers the point
   * @complexity O(layers x nodes) per point, no allocation; a renderer calls it per vertex or texel at bake
   *   time, not per frame
   * @example Kit.region.at([{ test: skinTest }, { test: sleeveTest }], 0.3, 0, 0, 0, 1) // 1
   */
  const at = (layers, along, angle, normalX, normalY, normalZ) => {
    // Topmost first: an index loop from the end, since this runs per sample point.
    for (let layer = layers.length - 1; layer >= 0; layer--) if (layers[layer].test(along, angle, normalX, normalY, normalZ)) return layer;
    return NONE;
  };

  Kit.region = { OPS, NONE, compile, at };
})();
