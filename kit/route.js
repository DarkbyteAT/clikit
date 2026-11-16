// Kit route: drawn routes and the things that travel along them. Pure, no DOM, no THREE - runs in node (see tools/test-kit.js).
//
//   route  - a finger stroke becomes a clean polyline between anchors:   Kit.route.capture(stroke, { anchors, snapRadius })
//   follow - a position travelling along a polyline, ping-pong or loop:  Kit.follow.advance(follower, distance, track)
//
// Owns: stroke clean-up, anchor snapping, stop detection, ribbon outlines and follower stepping.
// Does not own: the polyline maths itself (Kit.line in space.js), rendering, input, or what a stop means to a game.
// Points are { x, y } exactly like Kit.line (use the ground plane's x / z as x / y).
(() => {
  const line = Kit.line;

  /** Distances below this count as "already there", so a follower resting on a mark does not hit it again. */
  const EPSILON = 1e-6;
  /** Chaikin corner cutting replaces each corner with two points this far (as a fraction) along its two segments. */
  const CORNER_CUT = 0.25;

  /**
   * @typedef {Object} Point
   * @property {number} x
   * @property {number} y
   */
  /**
   * A named place a route can start, end or call at (a dock, a station, a socket).
   * @typedef {Object} Anchor
   * @property {string|number} id
   * @property {number} x
   * @property {number} y
   */
  /**
   * Where a route passes an anchor.
   * @typedef {Object} Stop
   * @property {string|number} id  the anchor's id
   * @property {number} along      distance from the start of the route, in world units
   */
  /**
   * @typedef {Object} CaptureResult
   * @property {boolean} ok
   * @property {string} [reason]   when not ok: 'too-short' | 'no-start' | 'no-end' | 'blocked'
   * @property {Point[]} [points]  when ok: the cleaned polyline, first and last point exactly on their anchors
   * @property {number} [length]   when ok: length of `points` in world units
   * @property {boolean} [isLoop]  when ok: the stroke came back to the anchor it started from
   * @property {Stop[]} [stops]    when ok: every anchor the route calls at, ordered by distance along it
   */

  const mix = (from, to, amount) => ({ x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount });
  const toPoint = ({ x, y }) => ({ x, y });

  /**
   * The anchor closest to a point, if any is within reach.
   * @param {Point} point
   * @param {Anchor[]} anchors
   * @param {number} radius  maximum snapping distance, world units
   * @returns {Anchor|null}
   * @complexity O(anchors) time, O(1) space
   */
  const snap = (point, anchors, radius) =>
    anchors.reduce((best, anchor) => (line.dist(point, anchor) <= radius && (!best || line.dist(point, anchor) < line.dist(point, best)) ? anchor : best), null);

  /** One pass of Chaikin corner cutting that keeps both end points fixed. */
  const smoothOnce = (points) => {
    if (points.length < 3) return points.slice();
    const cuts = points.slice(0, -1).flatMap((point, index) => [mix(point, points[index + 1], CORNER_CUT), mix(point, points[index + 1], 1 - CORNER_CUT)]);
    return [points[0], ...cuts, points[points.length - 1]];
  };

  /**
   * Round the corners of a polyline without moving its ends.
   * @param {Point[]} points
   * @param {number} [passes=1]  each pass doubles the point count and halves the sharpness of every corner
   * @returns {Point[]}
   */
  const smooth = (points, passes = 1) => (passes <= 0 ? points.slice() : smooth(smoothOnce(points), passes - 1));

  /**
   * Kit.line.simplify that also works on closed strokes. Ramer-Douglas-Peucker measures distance to the chord between the two
   * ends, which has no length when a stroke returns to its start, so a loop is split at its farthest point and each half simplified.
   */
  const simplifyStroke = (points, tolerance) => {
    const isClosed = line.dist(points[0], points[points.length - 1]) <= EPSILON;
    if (!isClosed || points.length < 4) return line.simplify(points, tolerance);
    const farthest = points.reduce((best, point, index) => (line.dist(points[0], point) > line.dist(points[0], points[best]) ? index : best), 0);
    return line.simplify(points.slice(0, farthest + 1), tolerance).slice(0, -1).concat(line.simplify(points.slice(farthest), tolerance));
  };

  /**
   * Turn a shaky stroke into an evenly spaced, gently curved polyline: drop jitter, round corners, resample.
   * @param {Point[]} stroke
   * @param {Object} [options]
   * @param {number} [options.tolerance=0.2]  jitter smaller than this (world units) is removed
   * @param {number} [options.smoothPasses=2] corner-rounding passes
   * @param {number} [options.step=0.3]       spacing of the output points, world units
   * @returns {Point[]}
   */
  const clean = (stroke, { tolerance = 0.2, smoothPasses = 2, step = 0.3 } = {}) => line.resample(smooth(simplifyStroke(stroke, tolerance), smoothPasses), step);

  /**
   * Every anchor a polyline passes within `radius` of, ordered along the line.
   * @param {Point[]} points
   * @param {Anchor[]} anchors
   * @param {number} radius  world units
   * @returns {Stop[]}
   * @complexity O(anchors x points) time, O(anchors) space
   */
  const stops = (points, anchors, radius) =>
    anchors
      .map((anchor) => ({ id: anchor.id, nearest: line.nearest(points, anchor) }))
      .filter(({ nearest }) => nearest.d <= radius)
      .map(({ id, nearest }) => ({ id, along: nearest.along }))
      .sort((first, second) => first.along - second.along);

  const fail = (reason) => ({ ok: false, reason });

  /** Distance along a polyline at each of its points (first entry 0). @complexity O(points) */
  const cumulativeLengths = (points) => points.reduce((lengths, point, index) => lengths.concat(index ? lengths[index - 1] + line.dist(points[index - 1], point) : 0), []);

  /**
   * Cut a stroke into sections at the anchors it passes, each section pinned to an anchor at both ends. Cleaning the
   * sections one by one keeps the route exactly on every dock it was drawn through; smoothing the whole stroke at once
   * would round those corners off and the route would sail past the dock.
   * @param {Point[]} pinned  the stroke with its first and last point already on their anchors
   * @param {Stop[]} vias     anchors passed in between, ordered along the stroke (see `stops`)
   * @param {Anchor[]} anchors
   * @returns {Point[][]}
   * @complexity O(points x (vias + 1))
   */
  const sectionsBetween = (pinned, vias, anchors) => {
    const lengths = cumulativeLengths(pinned);
    const anchorPoint = (id) => toPoint(anchors.find((anchor) => anchor.id === id));
    const cuts = [{ along: 0, point: pinned[0] }, ...vias.map((via) => ({ along: via.along, point: anchorPoint(via.id) })), { along: lengths[lengths.length - 1], point: pinned[pinned.length - 1] }];
    return cuts.slice(0, -1).map((from, index) => {
      const to = cuts[index + 1];
      return [from.point, ...pinned.filter((_, pointIndex) => lengths[pointIndex] > from.along && lengths[pointIndex] < to.along), to.point];
    });
  };

  /**
   * Capture a drag as a route between anchors: both ends snap to an anchor, the route is pinned to every anchor the stroke
   * passes on the way, each section is cleaned, and the result is refused (with a reason the game can show) when it is
   * too short, starts or ends nowhere, or crosses blocked ground.
   * @param {Point[]} stroke  raw drag samples in world units, in the order they were drawn
   * @param {Object} options
   * @param {Anchor[]} options.anchors
   * @param {number} options.snapRadius                 how close an end must be to an anchor, world units
   * @param {number} [options.stopRadius=snapRadius]     how close the stroke must pass an anchor to call there
   * @param {(point: Point) => boolean} [options.isBlocked]  true where a route may not go (land, walls)
   * @param {number} [options.minLength=0]               shortest allowed route, world units
   * @param {number} [options.minLoopLength=minLength]   shortest allowed route that returns to its own start
   * @param {number} [options.tolerance] @param {number} [options.smoothPasses] @param {number} [options.step]  see Kit.route.clean
   * @returns {CaptureResult}
   * @complexity O(points x anchors) time, O(points) space
   * @example
   *   const route = Kit.route.capture(stroke, { anchors: docks, snapRadius: 1, isBlocked: isLand });
   *   if (route.ok) launchBoat(route.points, route.stops); else ui.toast(REASONS[route.reason]);
   */
  function capture(stroke, options) {
    const { anchors, snapRadius, stopRadius = snapRadius, isBlocked = () => false, minLength = 0, minLoopLength = minLength } = options;
    if (stroke.length < 2) return fail('too-short');
    const startAnchor = snap(stroke[0], anchors, snapRadius);
    if (!startAnchor) return fail('no-start');
    const endAnchor = snap(stroke[stroke.length - 1], anchors, snapRadius);
    if (!endAnchor) return fail('no-end');
    const isLoop = startAnchor.id === endAnchor.id;
    const pinned = [toPoint(startAnchor), ...stroke.slice(1, -1), toPoint(endAnchor)];
    const vias = stops(pinned, anchors.filter((anchor) => anchor.id !== startAnchor.id && anchor.id !== endAnchor.id), stopRadius);
    const sections = sectionsBetween(pinned, vias, anchors).map((section) => clean(section, options));
    // Each section starts on the point the previous one ended on; keep that joint once.
    const points = sections.reduce((joined, section) => joined.concat(section.slice(1)), sections[0].slice(0, 1));
    const length = line.length(points);
    if (length < (isLoop ? minLoopLength : minLength)) return fail('too-short');
    if (points.some(isBlocked)) return fail('blocked');
    // Stops sit exactly on the joints: the running length of the cleaned sections up to each one.
    const jointLengths = sections.reduce((lengths, section) => lengths.concat(lengths[lengths.length - 1] + line.length(section)), [0]);
    const ids = [startAnchor.id, ...vias.map((via) => via.id), ...(isLoop ? [] : [endAnchor.id])];
    return { ok: true, points, length, isLoop, stops: ids.map((id, index) => ({ id, along: jointLengths[index] })) };
  }

  /**
   * The two edges of a ribbon of the given width centred on a polyline, for building a flat mesh strip.
   * @param {Point[]} points
   * @param {number} width  world units
   * @returns {{ left: Point, right: Point }[]}  one pair per input point, left / right of the direction of travel
   * @complexity O(points) time and space
   */
  const ribbon = (points, width) =>
    points.map((point, index) => {
      const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
      const span = line.dist(before, after) || 1;
      // The normal is the neighbour-to-neighbour direction turned a quarter turn, which mitres corners for free.
      const normal = { x: (-(after.y - before.y) / span) * (width / 2), y: ((after.x - before.x) / span) * (width / 2) };
      return { left: { x: point.x + normal.x, y: point.y + normal.y }, right: { x: point.x - normal.x, y: point.y - normal.y } };
    });

  Kit.route = { snap, smooth, clean, stops, capture, ribbon };

  /**
   * A position on a track: how far along it is and which way it is heading.
   * @typedef {Object} Follower
   * @property {number} along      distance from the start of the track, world units
   * @property {1|-1} direction    1 = toward the end, -1 = back toward the start
   */
  /**
   * @typedef {Object} Track
   * @property {number} length              total length, world units
   * @property {'pingpong'|'loop'} [mode]   pingpong (default) turns round at each end; loop wraps from the end to the start
   * @property {number[]} [marks]           distances along the track where the follower must stop (stations, docks)
   */
  /**
   * @typedef {Object} Advance
   * @property {number} along
   * @property {1|-1} direction
   * @property {number} hit   index into track.marks of the mark it stopped on, or -1
   * @property {number} left  distance it did not travel because it stopped on a mark
   */

  const wrap = (value, length) => ((value % length) + length) % length;

  /** Distance from the follower to a mark in its direction of travel; a mark it is resting on counts as a whole lap away (loop) or behind (pingpong). */
  const gapToMark = (follower, mark, { length, mode }) => {
    const ahead = (mark - follower.along) * follower.direction;
    if (mode !== 'loop') return ahead;
    const wrapped = wrap(ahead, length);
    return wrapped <= EPSILON ? length : wrapped;
  };

  /** The closest mark strictly ahead of the follower, as { index, gap }, or null. */
  const nextMark = (follower, track) =>
    (track.marks || [])
      .map((mark, index) => ({ index, gap: gapToMark(follower, mark, track) }))
      .filter(({ gap }) => gap > EPSILON)
      .reduce((best, candidate) => (!best || candidate.gap < best.gap ? candidate : best), null);

  /**
   * Move a follower along its track. It stops on the first mark it reaches (so the caller can dwell there) and reports it;
   * otherwise it travels the whole distance, turning round (pingpong) or wrapping (loop) at the ends.
   * @param {Follower} follower
   * @param {number} distance  how far to travel this step, world units (speed * dt)
   * @param {Track} track
   * @returns {Advance}
   * @example
   *   const moved = Kit.follow.advance(boat.follower, speed * dt, { length, mode: 'pingpong', marks: stops.map((stop) => stop.along) });
   *   if (moved.hit >= 0) unloadAt(stops[moved.hit]);
   */
  function advance(follower, distance, track) {
    const { length, mode = 'pingpong', marks = [] } = track;
    const { along, direction } = follower;
    if (!(length > 0) || distance <= 0) return { along, direction, hit: -1, left: 0 };
    const mark = nextMark(follower, { length, mode, marks });
    if (mark && mark.gap <= distance) return { along: marks[mark.index], direction, hit: mark.index, left: distance - mark.gap };
    if (mode === 'loop') return { along: wrap(along + direction * distance, length), direction, hit: -1, left: 0 };
    const toEnd = direction > 0 ? length - along : along;
    if (distance <= toEnd) return { along: along + direction * distance, direction, hit: -1, left: 0 };
    // Bounce off the end. With no marks whole laps change nothing, so drop them to keep the recursion to two legs.
    const remaining = marks.length ? distance - toEnd : (distance - toEnd) % (2 * length);
    return advance({ along: direction > 0 ? length : 0, direction: -direction }, remaining, track);
  }

  /**
   * World position and heading of a follower on a polyline.
   * @param {Point[]} points
   * @param {Follower} follower
   * @param {boolean} [isLoop=false]  wrap `along` instead of clamping it
   * @returns {{ x: number, y: number, tx: number, ty: number }}  position plus unit heading (already reversed on the way back)
   */
  const pose = (points, follower, isLoop = false) => {
    const at = line.at(points, follower.along, isLoop);
    return { x: at.x, y: at.y, tx: at.tx * follower.direction, ty: at.ty * follower.direction };
  };

  /**
   * A follower at the start of its track (or anywhere on it).
   * @param {number} [along=0]     distance from the start, world units
   * @param {1|-1} [direction=1]   1 = toward the end
   * @returns {Follower}
   */
  const start = (along = 0, direction = 1) => ({ along, direction });

  Kit.follow = { start, advance, pose };
})();
