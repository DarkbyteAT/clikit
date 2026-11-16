/**
 * Kit seeded: values that depend only on (seed, field name), not on how many values were read before them. Where
 * `Kit.rng` (kit/loot.js) is a stream - the third number depends on the first two having been drawn - this is a
 * lookup: add a field to a record next month and every old seed keeps its old value for every old field.
 *
 * Owns:  `Kit.seeded.hashText` (a stable 32-bit id for a name), `bits` / `unit` (the counter-based hash),
 *        `SHAPES` and `field` (a named, shaped draw), `pick` (a weighted row for a unit) and `hasher` (a 53-bit
 *        content hash of a list of whole numbers, for cache keys).
 * Does not own: sequences of random numbers (`Kit.rng`), what the fields mean (kit/body-recipe.js derives body
 *        recipes with it; generated items, levels, names or daily challenges fit the same shape), or security:
 *        these hashes are for variety and cache keys, never for secrets.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const UINT32_RANGE = 4294967296;
  /** FNV-1a, 32-bit: the offset basis and prime of the published algorithm. */
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  /** The finaliser constants of MurmurHash3 (fmix32) and the 32-bit golden ratio, for decorrelating inputs. */
  const MIX_MULTIPLIER_A = 0x85ebca6b;
  const MIX_MULTIPLIER_B = 0xc2b2ae35;
  const GOLDEN_RATIO_32 = 0x9e3779b9;
  /** The xor-shift distances of the same finaliser. */
  const MIX_SHIFT_OUTER = 16;
  const MIX_SHIFT_INNER = 13;
  /** The second lane of the content hash starts from a different basis so the two lanes are independent. */
  const SECOND_LANE_BASIS = 0x6a09e667;
  /** A content hash is a whole number below 2^53 (exact in a double): 21 bits of one lane above 32 of the other. */
  const HIGH_LANE_MASK = 0x1fffff;

  /** MurmurHash3's 32-bit finaliser: every input bit affects every output bit. */
  const mix32 = (value) => {
    let mixed = value >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> MIX_SHIFT_OUTER), MIX_MULTIPLIER_A);
    mixed = Math.imul(mixed ^ (mixed >>> MIX_SHIFT_INNER), MIX_MULTIPLIER_B);
    return (mixed ^ (mixed >>> MIX_SHIFT_OUTER)) >>> 0;
  };

  /**
   * The stable 32-bit id of a name (FNV-1a). The same text gives the same number on every machine, forever, so
   * it can key a derivation and name a field in saved data. Renaming the text changes the id.
   * @param {string} text e.g. 'dial:legLength'
   * @returns {number} unsigned 32-bit, never 0 (so 0 is free to mean "none")
   * @complexity O(characters)
   * @example Kit.seeded.hashText('dial:legLength')
   */
  const hashText = (text) => {
    let hash = FNV_OFFSET_BASIS;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
    return hash >>> 0 || 1;
  };

  /**
   * 32 well-mixed bits for (seed, field, counter).
   * @param {number} seed unsigned 32-bit
   * @param {number} fieldId from `hashText`
   * @param {number} [counter=0] for several independent draws of one field, or the index of a row in a generated list
   * @returns {number} unsigned 32-bit
   * @complexity O(1), no allocation
   * @example const childSeed = Kit.seeded.bits(worldSeed, Kit.seeded.hashText('villager'), index);
   */
  const bits = (seed, fieldId, counter = 0) => mix32((seed ^ mix32(fieldId + Math.imul(counter + 1, GOLDEN_RATIO_32))) >>> 0);

  /**
   * A number in [0, 1) for (seed, field, counter): the counter-based replacement for "the next random number".
   * @param {number} seed unsigned 32-bit
   * @param {number} fieldId from `hashText`
   * @param {number} [counter=0]
   * @returns {number} in [0, 1)
   * @complexity O(1), no allocation
   * @example const height = Kit.math.lerp(0.9, 1.2, Kit.seeded.unit(seed, Kit.seeded.hashText('height')));
   */
  const unit = (seed, fieldId, counter = 0) => bits(seed, fieldId, counter) / UINT32_RANGE;

  /**
   * How a draw is spread over [0, 1), name -> (seed, field id) -> number. `uniform`: every value equally likely.
   * `bell`: the mean of two draws, so the middle is common and the extremes rare. Adding a spread means adding a row.
   */
  const SHAPES = Object.freeze({
    uniform: (seed, fieldId) => unit(seed, fieldId, 0),
    bell: (seed, fieldId) => (unit(seed, fieldId, 0) + unit(seed, fieldId, 1)) / 2,
  });

  /**
   * A named field of a seeded record: a function from a seed to that field's draw, with the name hashed once.
   * @param {string} name the field's stable name
   * @param {string} [shape='uniform'] a `SHAPES` name
   * @returns {function(number): number} seed -> a number in [0, 1); it also carries `id` (the field's hash) and `field` (its name)
   * @throws {Error} for an unknown shape
   * @complexity building is O(characters); each draw is O(1) with no allocation
   * @example
   * const drawHeight = Kit.seeded.field('height', 'bell');
   * drawHeight(42) === drawHeight(42)   // true, whatever other fields exist
   */
  const field = (name, shape = 'uniform') => {
    const spread = SHAPES[shape];
    if (!spread) throw new Error(`Kit.seeded.field: unknown shape ${JSON.stringify(shape)} for "${name}". Shapes: ${Object.keys(SHAPES).join(', ')}.`);
    const id = hashText(name);
    return Object.assign((seed) => spread(seed, id), { id, field: name });
  };

  // One weighted-pick implementation for the whole kit (Kit.math.randomTools); the "random" source is a variable
  // set just before each pick, so a hash can drive it without a closure per call.
  let pickUnit = 0;
  const weightedPicker = Kit.math.randomTools(() => pickUnit);
  const weightOfRow = (row) => row.weight;

  /**
   * The weighted row for a unit number: `Kit.math.pickWeighted` driven by a hash instead of a random source.
   * @template T
   * @param {T[]} rows
   * @param {number} unitValue in [0, 1), e.g. from `unit` or a `field`
   * @param {function(T): number} [weightOf] defaults to `row.weight`
   * @returns {T} undefined when `rows` is empty
   * @complexity O(rows) time, no allocation
   * @example Kit.seeded.pick(ENEMIES, Kit.seeded.unit(seed, Kit.seeded.hashText('enemy'), wave))
   */
  const pick = (rows, unitValue, weightOf = weightOfRow) => {
    pickUnit = unitValue;
    return weightedPicker.pickWeighted(rows, weightOf);
  };

  /**
   * A content hash built up one whole number at a time: absorb the same numbers in the same order and get the
   * same result. Make one, keep it, and `reset` it for each thing hashed.
   * @returns {{reset: function(): void, absorb: function(number): void, value: function(): number}} `value` is a
   *   whole number below 2^53 (two independent 32-bit lanes, 53 bits kept): expect one false match in about
   *   10^15 pairs, which suits a cache key and nothing security-related
   * @complexity `absorb` and `value` are O(1) with no allocation
   * @example
   * const hasher = Kit.seeded.hasher();
   * hasher.reset(); [3, 1, 4].forEach(hasher.absorb); const key = hasher.value();
   */
  const hasher = () => {
    let low = FNV_OFFSET_BASIS;
    let high = SECOND_LANE_BASIS;
    return {
      reset() {
        low = FNV_OFFSET_BASIS;
        high = SECOND_LANE_BASIS;
      },
      absorb(value) {
        low = mix32(low ^ value);
        high = mix32(Math.imul(high, FNV_PRIME) + value);
      },
      value: () => (high & HIGH_LANE_MASK) * UINT32_RANGE + low,
    };
  };

  Kit.seeded = { hashText, bits, unit, SHAPES, field, pick, hasher, UINT32_RANGE };
})();
