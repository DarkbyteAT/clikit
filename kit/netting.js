/**
 * Kit netting: a sheet of knots joined by cords (a goal net, a hammock, a banner, a trampoline), simulated as
 * points held together by distance links. A ball pushed into it makes it bulge; it swings back and settles.
 *
 * Owns:  `Kit.netting.sheet` (a rectangular grid of knots between two edge vectors, with any knots pinned),
 *        `Kit.netting.step` (one fixed step: inertia, gravity, the pull home, then the links), `Kit.netting.push`
 *        (move every knot out of a ball) and `DEFAULTS`.
 * Does not own: what the ball does when it meets the net (the caller slows it; `push` reports the contact),
 *        chains of bones (`Kit.dynamics.chain`), the fixed clock (`Kit.dynamics.stepsDue`) or drawing: `links`
 *        is a list of knot pairs, which is exactly the index buffer of line segments.
 *
 * Why position-based (Verlet) and not springs: links are satisfied directly, so a hard shot cannot make the
 * net explode whatever the step, and there is no stiffness to tune against the frame rate.
 *
 * Conventions: metres, seconds, +Y up; positions are x, y, z per knot, row by row from the `origin` corner.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** @typedef {{x: number, y: number, z: number}} Vector */

  /**
   * @typedef {Object} NettingOptions
   * @property {number} gravity metres per second squared; small, because a net hangs taut
   * @property {number} keep share of a knot's motion kept each step (the rest is lost to the air and the cords)
   * @property {number} home how strongly a knot is pulled back to where it hangs at rest, per second squared
   * @property {number} passes times the links are satisfied per step; more is stiffer
   */

  /** A taut goal net: it bulges about half a metre for a hard shot and is still again within a second. */
  const DEFAULTS = Object.freeze({ gravity: 2, keep: 0.94, home: 60, passes: 2 });
  const STRIDE = 3;

  const fail = (where, message) => {
    throw new Error(`Kit.netting.${where}: ${message}`);
  };

  /**
   * @typedef {Object} Netting
   * @property {number} columns knots across
   * @property {number} rows knots down
   * @property {Float32Array} positions 3 per knot: where each is now
   * @property {Float32Array} previous 3 per knot: where each was a step ago (its velocity, implicitly)
   * @property {Float32Array} rest 3 per knot: where each hangs at rest
   * @property {Uint8Array} pinned 1 per knot: 1 for a knot tied to the frame
   * @property {Uint16Array} links 2 per cord: the two knots it joins (the index buffer of the net's line segments)
   * @property {Float32Array} lengths 1 per cord: its rest length
   */

  /**
   * Makes a rectangular net: `columns x rows` knots spread evenly from `origin` along `across` and `down`.
   * @param {{origin: Vector, across: Vector, down: Vector, columns: number, rows: number,
   *   isPinned?: function(number, number): boolean}} spec `across` and `down` are the full edge vectors;
   *   `isPinned(column, row)` says which knots are tied to the frame (default: the whole rim)
   * @returns {Netting}
   * @throws {Error} for fewer than 2 columns or rows
   * @complexity O(columns x rows) time and space
   * @example
   * const back = Kit.netting.sheet({ origin: { x: -3, y: 2.4, z: -1.5 }, across: { x: 6, y: 0, z: 0 }, down: { x: 0, y: -2.4, z: 0 }, columns: 13, rows: 7 });
   */
  const sheet = ({ origin, across, down, columns, rows, isPinned = (column, row) => column === 0 || row === 0 || column === columns - 1 || row === rows - 1 }) => {
    if (!(columns >= 2 && rows >= 2)) fail('sheet', `a net needs at least 2 columns and 2 rows, got ${columns} x ${rows}.`);
    const count = columns * rows;
    const rest = new Float32Array(count * STRIDE);
    const pinned = new Uint8Array(count);
    const linkPairs = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const knot = row * columns + column;
        const [shareAcross, shareDown] = [column / (columns - 1), row / (rows - 1)];
        rest[knot * STRIDE] = origin.x + across.x * shareAcross + down.x * shareDown;
        rest[knot * STRIDE + 1] = origin.y + across.y * shareAcross + down.y * shareDown;
        rest[knot * STRIDE + 2] = origin.z + across.z * shareAcross + down.z * shareDown;
        pinned[knot] = isPinned(column, row) ? 1 : 0;
        if (column + 1 < columns) linkPairs.push(knot, knot + 1);
        if (row + 1 < rows) linkPairs.push(knot, knot + columns);
      }
    }
    const links = Uint16Array.from(linkPairs);
    const lengths = new Float32Array(links.length / 2);
    lengths.forEach((_unused, cord) => {
      const [first, second] = [links[cord * 2] * STRIDE, links[cord * 2 + 1] * STRIDE];
      lengths[cord] = Math.hypot(rest[first] - rest[second], rest[first + 1] - rest[second + 1], rest[first + 2] - rest[second + 2]);
    });
    return { columns, rows, positions: Float32Array.from(rest), previous: Float32Array.from(rest), rest, pinned, links, lengths };
  };

  /** Pulls the two knots of every cord back to the cord's length, sharing the correction (a pinned knot takes none). */
  const satisfyLinks = (net) => {
    const { positions, pinned, links, lengths } = net;
    for (let cord = 0; cord < lengths.length; cord++) {
      const [firstKnot, secondKnot] = [links[cord * 2], links[cord * 2 + 1]];
      const [first, second] = [firstKnot * STRIDE, secondKnot * STRIDE];
      const offsetX = positions[second] - positions[first];
      const offsetY = positions[second + 1] - positions[first + 1];
      const offsetZ = positions[second + 2] - positions[first + 2];
      const distance = Math.hypot(offsetX, offsetY, offsetZ);
      // A cord resists stretching only: a net is slack under compression.
      if (distance <= lengths[cord] || distance === 0) continue;
      const [firstFree, secondFree] = [1 - pinned[firstKnot], 1 - pinned[secondKnot]];
      if (firstFree + secondFree === 0) continue;
      const correction = (distance - lengths[cord]) / distance / (firstFree + secondFree);
      positions[first] += offsetX * correction * firstFree;
      positions[first + 1] += offsetY * correction * firstFree;
      positions[first + 2] += offsetZ * correction * firstFree;
      positions[second] -= offsetX * correction * secondFree;
      positions[second + 1] -= offsetY * correction * secondFree;
      positions[second + 2] -= offsetZ * correction * secondFree;
    }
  };

  /**
   * Advances a net by one step. Call it on a fixed clock (`Kit.dynamics.stepsDue`); the net is changed in place.
   * @param {Netting} net
   * @param {number} dt seconds
   * @param {Partial<NettingOptions>} [options]
   * @returns {number} the largest distance any knot is from its rest place, metres (0 for a net at rest: skip drawing it)
   * @complexity O(knots + passes x cords) time, no allocation
   * @example if (Kit.netting.step(net, 1 / 60) > 0.001) lines.geometry.attributes.position.needsUpdate = true;
   */
  const step = (net, dt, options) => {
    const { gravity, keep, home, passes } = options ? { ...DEFAULTS, ...options } : DEFAULTS;
    const { positions, previous, rest, pinned } = net;
    const dtSquared = dt * dt;
    let farthest = 0;
    // Hot path: index loops over typed arrays.
    for (let knot = 0; knot < pinned.length; knot++) {
      if (pinned[knot]) continue;
      for (let axis = 0; axis < STRIDE; axis++) {
        const at = knot * STRIDE + axis;
        const pull = (rest[at] - positions[at]) * home - (axis === 1 ? gravity : 0);
        const next = positions[at] + (positions[at] - previous[at]) * keep + pull * dtSquared;
        previous[at] = positions[at];
        positions[at] = next;
      }
    }
    for (let pass = 0; pass < passes; pass++) satisfyLinks(net);
    for (let at = 0; at < positions.length; at++) farthest = Math.max(farthest, Math.abs(positions[at] - rest[at]));
    return farthest;
  };

  /**
   * Moves every free knot inside a ball out to its surface: the ball pushing the net. Call it after `step`.
   * @param {Netting} net
   * @param {number} x centre of the ball
   * @param {number} y
   * @param {number} z
   * @param {number} radius metres
   * @returns {number} how many knots the ball is touching (0: no contact)
   * @complexity O(knots) time, no allocation
   * @example if (Kit.netting.push(net, ball.x, ball.y, ball.z, 0.11) > 0) slowTheBall();
   */
  const push = (net, x, y, z, radius) => {
    const { positions, pinned } = net;
    let touching = 0;
    for (let knot = 0; knot < pinned.length; knot++) {
      if (pinned[knot]) continue;
      const at = knot * STRIDE;
      const offsetX = positions[at] - x;
      const offsetY = positions[at + 1] - y;
      const offsetZ = positions[at + 2] - z;
      const distance = Math.hypot(offsetX, offsetY, offsetZ);
      if (distance >= radius || distance === 0) continue;
      const scale = radius / distance;
      positions[at] = x + offsetX * scale;
      positions[at + 1] = y + offsetY * scale;
      positions[at + 2] = z + offsetZ * scale;
      touching += 1;
    }
    return touching;
  };

  Kit.netting = { DEFAULTS, sheet, step, push };
})();
