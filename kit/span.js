// Kit span: one-dimensional extents (a centre and a size on one axis). Pure, no DOM, no THREE - runs in node (see tools/test-kit.js).
//
//   span.edges   - { min, max } of a span:                 span.edges({ center: 0, size: 4 })
//   span.overlap - the shared part of two spans, or null:  span.overlap(a, b)
//   span.slice   - drop a piece onto a base and cut it:    span.slice(piece, base, { tolerance })   (stackers, trimmers, timing bars)
//   span.wrap    - fold a value into [0, length):          span.wrap(scroll, 48)                    (endless scrolling layers)
//
// Owns interval arithmetic only. It knows nothing about axes, meshes or scores: a caller maps its own x or z onto a span.
(() => {
  /** Overhangs thinner than this are rounding noise from the edge arithmetic, not real cuts. */
  const EPSILON = 1e-9;

  /**
   * A stretch of one axis.
   * @typedef {{ center: number, size: number }} Span
   */

  /**
   * One part of a sliced piece that hangs past the base.
   * @typedef {{ center: number, size: number, side: -1 | 1 }} SpanCut  side: which end of the base it fell off (-1 = low, 1 = high)
   */

  /**
   * The result of dropping a piece onto a base.
   * @typedef {Object} SpanSlice
   * @property {Span | null} kept          the part that stays (null on a miss)
   * @property {SpanCut[]} cuts            the overhanging parts, low side first (empty on a perfect drop)
   * @property {boolean} isPerfect         the piece was within `tolerance` of the base centre and snapped onto it whole
   * @property {boolean} isMiss            nothing worth keeping overlapped the base
   * @property {number} keptFraction       kept size / piece size, 0..1
   */

  /**
   * Builds a span from its two ends.
   * @param {number} min lower end
   * @param {number} max upper end
   * @returns {Span}
   */
  const between = (min, max) => ({ center: (min + max) / 2, size: max - min });

  /**
   * The two ends of a span.
   * @param {Span} span
   * @returns {{ min: number, max: number }}
   */
  const edges = (span) => ({ min: span.center - span.size / 2, max: span.center + span.size / 2 });

  /**
   * The part two spans share.
   * @param {Span} first
   * @param {Span} second
   * @returns {Span | null} null when they do not overlap (touching ends count as no overlap)
   */
  function overlap(first, second) {
    const a = edges(first), b = edges(second);
    const min = Math.max(a.min, b.min), max = Math.min(a.max, b.max);
    return max > min ? between(min, max) : null;
  }

  /**
   * Drops `piece` onto `base` and cuts off whatever hangs over the ends of the base.
   * Within `tolerance` of the base centre the piece is forgiven: it snaps to the centre and keeps its full size, even if it is wider than the base.
   * @param {Span} piece the moving piece where it was released
   * @param {Span} base what it lands on
   * @param {{ tolerance?: number, minKeep?: number }} [options] tolerance: centre distance that still counts as perfect (same units as the spans);
   *   minKeep: an overlap this small or smaller counts as a miss, so a sliver never becomes a floor
   * @returns {SpanSlice}
   * @complexity O(1) time and space.
   * @example
   * span.slice({ center: 1, size: 4 }, { center: 0, size: 4 })   // kept { center: 0.5, size: 3 }, cuts [{ center: 2.5, size: 1, side: 1 }]
   */
  function slice(piece, base, { tolerance = 0, minKeep = 0 } = {}) {
    if (Math.abs(piece.center - base.center) <= tolerance) {
      return { kept: { center: base.center, size: piece.size }, cuts: [], isPerfect: true, isMiss: false, keptFraction: 1 };
    }
    const shared = overlap(piece, base);
    if (!shared || shared.size <= minKeep) {
      const side = piece.center < base.center ? -1 : 1;
      return { kept: null, cuts: [{ center: piece.center, size: piece.size, side }], isPerfect: false, isMiss: true, keptFraction: 0 };
    }
    const pieceEdges = edges(piece), sharedEdges = edges(shared);
    // A piece wider than its base can overhang both ends at once, so each end is checked on its own.
    const cuts = [
      { ...between(pieceEdges.min, sharedEdges.min), side: -1 },
      { ...between(sharedEdges.max, pieceEdges.max), side: 1 },
    ].filter((cut) => cut.size > EPSILON);
    return { kept: shared, cuts, isPerfect: false, isMiss: false, keptFraction: shared.size / piece.size };
  }

  /**
   * Folds a value into [0, length), also for negative values (plain % keeps the sign in JavaScript).
   * @param {number} value
   * @param {number} length period, > 0
   * @returns {number}
   */
  const wrap = (value, length) => ((value % length) + length) % length;

  Kit.span = { between, edges, overlap, slice, wrap };
})();
