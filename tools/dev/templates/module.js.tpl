/**
 * Kit __NAME__: say in one line what this module is for.
 * Scaffolded by `node tools/dev.js new module __NAME__`; replace the example function and this line.
 *
 * Owns:  what this module is responsible for.
 * Does not own: what it leaves to other modules (name them).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * Example of the documented shape every kit function has; replace it with the module's first real function.
   * Rounds a count down to a whole number that is never negative.
   * @param {number} value any number
   * @returns {number} a whole number, 0 or more
   * @complexity O(1) time and space
   * @example Kit.__CAMEL__.toWholeCount(2.7) // 2
   */
  const toWholeCount = (value) => Math.max(0, Math.floor(value));

  Kit.__CAMEL__ = { toWholeCount };
})();
