/**
 * Kit flags: a set of up to 32 named yes/no facts packed into one number, and "does this thing have everything
 * that needs?" answered by one AND and compare, with a failure that names what is missing.
 *
 * Owns:  `Kit.flags(names, label)` - name <-> bit, `mask`, `namesOf`, and requirements (`requirement`, `fits`,
 *        `missing`): a required mask plus optional minimum counts per flag.
 * Does not own: what the flags mean. `Kit.body` uses one set for bone roles and one for capabilities; collision
 *        layers, unlock sets, damage types or status effects fit the same shape. (`Kit.physics.layers` in
 *        kit/bodies.js keeps its own name -> bit table because it also writes cannon.js bodies; it could be
 *        rebuilt on this.)
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Bitwise operators work on 32-bit integers, so that is the most flags one set can hold. */
  const MOST_FLAGS = 32;

  /**
   * @typedef {Object} FlagRequirementSpec
   * @property {string[]} [needs] flags that must be set
   * @property {Object<string, number>} [atLeast] flag -> smallest count that will do ({ legs: 4 }); a flag listed
   *   here is needed even when `needs` leaves it out
   */

  /**
   * @typedef {Object} FlagRequirement
   * @property {number} mask bits that must all be set
   * @property {Uint8Array} countBits bits that have a minimum count
   * @property {Uint8Array} minimums the minimum for each entry of `countBits`
   */

  /**
   * @typedef {Object} FlagSet
   * @property {ReadonlyArray<string>} names bit index -> name
   * @property {function(string): number} bit name -> bit index (0..31); throws naming the known flags
   * @property {function(string[]): number} mask names -> unsigned 32-bit mask
   * @property {function(number): string[]} namesOf mask -> the names set in it, in bit order
   * @property {function(FlagRequirementSpec=): FlagRequirement} requirement compile what a consumer needs, once
   * @property {function(number, ArrayLike<number>, FlagRequirement): boolean} fits fits(mask, counts, requirement):
   *   is every needed bit set and every counted flag numerous enough? `counts` is indexed by bit (pass an empty
   *   list when nothing is counted)
   * @property {function(number, ArrayLike<number>, FlagRequirement): string[]} missing what is lacking, in words:
   *   'legs', or 'legs (has 2, needs 4)'; empty when it fits
   */

  /**
   * Makes a set of named flags.
   * @param {string[]} names the flags, in bit order; at most 32, no repeats
   * @param {string} [label='flag'] what one of these is called in error messages ('role', 'capability')
   * @returns {FlagSet}
   * @throws {Error} for more than 32 names or a repeated name; its methods throw for an unknown name
   * @complexity `bit` and `mask` are O(names given x flags); `fits` is O(1) for the mask plus O(counted flags);
   *   `namesOf` and `missing` are O(flags). `fits` allocates nothing.
   * @example
   * const abilities = Kit.flags(['legs', 'wings', 'tail'], 'ability');
   * const WALK = abilities.requirement({ atLeast: { legs: 2 } });
   * abilities.fits(abilities.mask(['wings', 'tail']), [0, 2, 5], WALK)      // false
   * abilities.missing(abilities.mask(['wings', 'tail']), [0, 2, 5], WALK)   // ['legs']
   */
  Kit.flags = (names, label = 'flag') => {
    if (names.length > MOST_FLAGS) throw new Error(`Kit.flags: ${names.length} ${label}s asked for; one set holds ${MOST_FLAGS}. Split them into two sets.`);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined) throw new Error(`Kit.flags: the ${label} "${repeated}" is listed twice.`);

    const bit = (name) => {
      const index = names.indexOf(name);
      if (index < 0) throw new Error(`Kit.flags: unknown ${label} "${name}". Known ${label}s: ${names.join(', ')}.`);
      return index;
    };
    const mask = (wanted) => wanted.reduce((bits, name) => (bits | (1 << bit(name))) >>> 0, 0);
    const namesOf = (bits) => names.filter((_name, index) => bits & (1 << index));

    const requirement = ({ needs = [], atLeast = {} } = {}) => {
      const counted = Object.keys(atLeast);
      return Object.freeze({ mask: mask([...needs, ...counted]), countBits: Uint8Array.from(counted, bit), minimums: Uint8Array.from(counted, (name) => atLeast[name]) });
    };

    const fits = (bits, counts, needed) => {
      if ((bits & needed.mask) >>> 0 !== needed.mask) return false;
      for (let index = 0; index < needed.countBits.length; index++) {
        if (counts[needed.countBits[index]] < needed.minimums[index]) return false;
      }
      return true;
    };

    const missing = (bits, counts, needed) => {
      const absent = namesOf((needed.mask & ~bits) >>> 0);
      const tooFew = [...needed.countBits]
        .map((countedBit, index) => ({ name: names[countedBit], has: counts[countedBit], needs: needed.minimums[index] }))
        .filter((row) => !absent.includes(row.name) && row.has < row.needs);
      return [...absent, ...tooFew.map((row) => `${row.name} (has ${row.has}, needs ${row.needs})`)];
    };

    return Object.freeze({ names: Object.freeze([...names]), bit, mask, namesOf, requirement, fits, missing });
  };
})();
