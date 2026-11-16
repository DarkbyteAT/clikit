/**
 * Kit loot: randomness with structure.
 *
 *   rng         - seedable random source (same seed, same run): next / range / int / chance / pick / weighted / shuffle / fork
 *   stats.power, stats.merge - modifier-spec algebra used to build an item's stats
 *   loot        - item generator: base x rarity x affixes -> plain-data item whose `mods` plug straight into Kit.stats
 *   inventory   - a bag plus equipment slots; equipping pushes the item's mods into Kit.stats
 *
 * Owns:  seeded randomness, item rolling and the bag / equipment model.
 * Does not own: unseeded helpers (Kit.math in core.js), the stat block the mods feed (Kit.stats in
 *        model.js) or any inventory screen (ui.panel in ui.js).
 *
 * No DOM, no THREE: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  // ---- rng -----------------------------------------------------------------------------------------------------------

  /** 2^32: the size of the 32-bit state space, used to turn an integer state into a 0..1 fraction and back. */
  const UINT32_RANGE = 2 ** 32;
  // Constants of the mulberry32 generator (a published 32-bit mixer; do not tune).
  const MULBERRY_INCREMENT = 0x6d2b79f5;
  const MULBERRY_SHIFT_A = 15;
  const MULBERRY_SHIFT_B = 7;
  const MULBERRY_SHIFT_C = 14;
  const MULBERRY_OR_B = 61;

  const randomSeed = () => (Math.random() * UINT32_RANGE) >>> 0;
  // Unlike Kit.math.pickWeighted's default, a weight of 0 means "never" here.
  const weightOrOne = (row) => (row.weight === undefined ? 1 : row.weight);

  /**
   * @typedef {Object} Rng
   * @property {number} seed the seed in use (show it, save it, replay it)
   * @property {function(): number} next uniform number in [0, 1)
   * @property {function(number, number): number} range uniform number in [low, high)
   * @property {function(number, number): number} int uniform integer in [low, high], both included
   * @property {function(number): boolean} chance true with the given probability (0..1)
   * @property {function(Array): *} pick uniform random element
   * @property {function(Array, function(*): number=): *} weighted random row by weight (default `row.weight`, 1 when missing)
   * @property {function(Array): Array} shuffle shuffled copy
   * @property {function(): Rng} fork an independent stream derived from this one, so (say) loot rolls
   *   do not disturb level generation
   */

  /**
   * Creates a seedable random source (mulberry32): the same seed always gives the same sequence.
   * @param {number} [seed] 32-bit integer; omitted = a random one, readable back from `rng.seed`
   * @returns {Rng}
   * @complexity `next`, `range`, `int`, `chance` and `pick` are O(1); `weighted` is O(rows); `shuffle` is O(n) time and space
   * @example
   * const rng = Kit.rng(42);
   * const lootRng = rng.fork();
   * rng.int(1, 6); rng.pick(['red', 'green']); rng.weighted(ENEMIES);
   */
  Kit.rng = (seed = randomSeed()) => {
    let state = seed >>> 0;
    const next = () => {
      // mulberry32: step the state by a fixed odd increment, then scramble it with xor-shifts and
      // multiplies so consecutive states give unrelated outputs. `>>> 0` keeps values unsigned 32-bit.
      state = (state + MULBERRY_INCREMENT) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_A), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_B), mixed | MULBERRY_OR_B);
      return ((mixed ^ (mixed >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32_RANGE;
    };
    const tools = Kit.math.randomTools(next);
    return {
      seed,
      next,
      range: (low, high) => low + next() * (high - low),
      int: (low, high) => Math.floor(low + next() * (high - low + 1)),
      chance: (probability) => next() < probability,
      pick: tools.pick,
      weighted: (rows, weightOf = weightOrOne) => tools.pickWeighted(rows, weightOf),
      shuffle: tools.shuffle,
      fork: () => Kit.rng((next() * UINT32_RANGE) >>> 0),
    };
  };

  // ---- modifier-spec algebra (specs are what Kit.stats.mod takes: { stat: { add, mul } }) -----------------------------

  /**
   * Scales the strength of a modifier spec: adds scale directly, and a mul's bonus (its distance
   * from 1) scales, so strength 2 turns "x1.1" into "x1.2" and strength 0 into "x1".
   * @param {Object<string, {add?: number, mul?: number}>} spec
   * @param {number} strength multiplier (1 leaves the spec as it is)
   * @returns {Object<string, {add: number, mul: number}>}
   * @example Kit.stats.power({ damage: { add: 4, mul: 1.2 } }, 2) // { damage: { add: 8, mul: 1.4 } }
   */
  Kit.stats.power = (spec, strength) => Kit.stats.mapSpec(spec, ({ add, mul }) => ({ add: add * strength, mul: 1 + (mul - 1) * strength }));

  /**
   * Combines several modifier specs into one: adds sum, muls multiply.
   * @param {Array<Object<string, {add?: number, mul?: number}>>} specs
   * @returns {Object<string, {add: number, mul: number}>} one entry per stat named in any spec ({} for no specs)
   * @example Kit.stats.merge([{ damage: { add: 4 } }, { damage: { mul: 1.2 } }]) // { damage: { add: 4, mul: 1.2 } }
   */
  Kit.stats.merge = (specs) =>
    specs.reduce((merged, spec) => {
      Object.keys(spec).forEach((statName) => {
        const { add, mul } = Kit.stats.normalize(spec[statName]);
        const combined = merged[statName] || { add: 0, mul: 1 };
        merged[statName] = { add: combined.add + add, mul: combined.mul * mul };
      });
      return merged;
    }, {});

  // ---- loot ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} RarityRow
   * Listed from most common to best: luck favours rows further down the list.
   * @property {string} id
   * @property {string} [name]
   * @property {number} [color] hex colour copied onto the item
   * @property {number} weight relative chance at luck 0
   * @property {number} [affixes=0] how many affixes an item of this rarity rolls
   * @property {number} [mult=1] strength multiplier for the item's mods and value
   */

  /**
   * @typedef {Object} BaseRow
   * The item itself ("Rusty Cleaver", slot 'weapon').
   * @property {string} id
   * @property {string} name
   * @property {string} slot equipment slot it fits
   * @property {Object} [mods] modifier spec at strength 1
   * @property {number} [weight=1] relative chance
   * @property {number} [from=0] lowest level at which it can roll
   */

  /**
   * @typedef {Object} AffixRow
   * A named bonus: `prefix` reads "Vampiric ...", `suffix` reads "... of Embers".
   * @property {string} id
   * @property {string} [prefix]
   * @property {string} [suffix]
   * @property {Object} mods modifier spec at strength 1
   * @property {string[]} [slots] slots it may roll on (default: any)
   * @property {number} [weight=1] relative chance
   * @property {number} [from=0] lowest level at which it can roll
   */

  /**
   * @typedef {Object} LootItem
   * Plain data, safe to save.
   * @property {string} uid unique per rolled item
   * @property {string} base BaseRow id
   * @property {string} slot
   * @property {string} rarity RarityRow id
   * @property {number} [color] the rarity's colour
   * @property {number} level level it was rolled at
   * @property {string[]} affixes AffixRow ids, in roll order
   * @property {string} name e.g. "Vampiric Cleaver of Embers"
   * @property {Object<string, {add: number, mul: number}>} mods merged modifier spec, ready for Kit.stats.mod
   * @property {number} value sell price
   */

  /** Item strength by level when no `power` curve is given: 1 at level 0, +0.15 per level. */
  const DEFAULT_POWER_CURVE = { base: 1, step: 0.15 };
  /** Sell value of a strength-1 item with no affixes. */
  const BASE_ITEM_VALUE = 10;
  /** Smallest multiplier bonus worth a line in an item description. */
  const MUL_EPSILON = 1e-6;

  const isUnlockedAt = (level) => (row) => level >= (row.from || 0);
  const signPrefix = (isPositive) => (isPositive ? '+' : '');
  const roundToTenth = (value) => Math.round(value * 10) / 10;

  /**
   * Creates an item generator.
   * @param {Object} definition
   * @param {RarityRow[]} definition.rarities ordered common -> best
   * @param {BaseRow[]} definition.bases
   * @param {AffixRow[]} [definition.affixes=[]]
   * @param {*} [definition.power] curve spec (see Kit.curve.of): level -> strength multiplier (default 1 + 0.15 per level)
   * @param {Rng} [definition.rng] defaults to a randomly seeded one
   * @returns {{rarities: RarityRow[], bases: BaseRow[], affixes: AffixRow[], rng: Rng,
   *   roll: function({level?: number, luck?: number, slot?: string, rarity?: string}=): LootItem,
   *   describe: function(LootItem, Object<string, string>=): string[]}}
   * @complexity `roll` is O(bases + affixes * affixes rolled + stats on the item) time; an item is O(its stats) space
   * @example
   * const loot = Kit.loot({ rarities: RARITIES, bases: BASES, affixes: AFFIXES, rng: Kit.rng(7) });
   * const drop = loot.roll({ level: 3, luck: 1 });           // any slot, rarity by weight and luck
   * const reward = loot.roll({ slot: 'weapon', rarity: 'epic' });
   * loot.describe(drop, { damage: 'Damage' });               // ['+4 Damage', '+12% Fire rate']
   */
  Kit.loot = ({ rarities, bases, affixes = [], power = DEFAULT_POWER_CURVE, rng = Kit.rng() }) => {
    const rarityTable = Kit.table(rarities);
    const baseTable = Kit.table(bases);
    const affixTable = Kit.table(affixes);
    const strengthAtLevel = Kit.curve.of(power);
    let itemsRolled = 0;

    /**
     * Luck weighting: a rarity's weight grows by `luck` times its position in the table, so the
     * first (most common) row is untouched and each better row gains more. Luck 0 is the plain table.
     */
    const pickRarity = (luck) => rng.weighted(rarityTable, (row) => row.weight * (1 + luck * rarityTable.indexOf(row)));

    const pickBase = (level, slot) => {
      const candidates = baseTable.filter(isUnlockedAt(level)).filter((base) => !slot || base.slot === slot);
      if (!candidates.length) throw new Error(`Kit.loot.roll: no base item for slot "${slot}" at level ${level}`);
      return rng.weighted(candidates);
    };

    /**
     * Picks up to `count` distinct affixes from a pool, one at a time. Only one prefix and one
     * suffix fit in the name, so while either place is free an affix that fills it is preferred;
     * further affixes still count toward the item's mods.
     */
    const pickAffixes = (pool, count, picked = []) => {
      const options = pool.filter((affix) => !picked.includes(affix));
      if (picked.length >= count || !options.length) return picked;
      const hasPrefix = picked.some((affix) => affix.prefix);
      const hasSuffix = picked.some((affix) => affix.suffix);
      const fitsName = options.filter((affix) => (affix.prefix && !hasPrefix) || (affix.suffix && !hasSuffix));
      return pickAffixes(pool, count, picked.concat(rng.weighted(fitsName.length ? fitsName : options)));
    };

    /** Assembles the plain-data item from its rolled parts. */
    const buildItem = (base, rarity, pickedAffixes, level) => {
      const strength = strengthAtLevel(level) * (rarity.mult === undefined ? 1 : rarity.mult);
      const prefixAffix = pickedAffixes.find((affix) => affix.prefix);
      const suffixAffix = pickedAffixes.find((affix) => affix.suffix);
      const nameParts = [prefixAffix && prefixAffix.prefix, base.name, suffixAffix && suffixAffix.suffix];
      const modSpecs = [base.mods || {}, ...pickedAffixes.map((affix) => affix.mods)];
      return {
        // Time plus a counter: unique across sessions and within one millisecond.
        uid: `${Date.now().toString(36)}-${itemsRolled++}`,
        base: base.id,
        slot: base.slot,
        rarity: rarity.id,
        color: rarity.color,
        level,
        affixes: pickedAffixes.map((affix) => affix.id),
        name: nameParts.filter(Boolean).join(' '),
        mods: Kit.stats.merge(modSpecs.map((spec) => Kit.stats.power(spec, strength))),
        // Value rises with strength, with each affix, and again with rarity so rare finds feel rich.
        value: Math.round(BASE_ITEM_VALUE * strength * (1 + pickedAffixes.length) * (rarity.mult || 1)),
      };
    };

    return {
      rarities: rarityTable,
      bases: baseTable,
      affixes: affixTable,
      rng,
      /**
       * Rolls one item. `level` gates rows by their `from` and scales strength; `luck` (0 = none)
       * shifts chance toward better rarities; `slot` and `rarity` force those choices.
       */
      roll({ level = 1, luck = 0, slot, rarity } = {}) {
        // The order of these three draws is part of the seed contract: rarity, base, then affixes.
        const rolledRarity = rarity ? rarityTable.byId(rarity) : pickRarity(luck);
        const base = pickBase(level, slot);
        const affixPool = affixTable.filter(isUnlockedAt(level)).filter((affix) => !affix.slots || affix.slots.includes(base.slot));
        return buildItem(base, rolledRarity, pickAffixes(affixPool, rolledRarity.affixes || 0), level);
      },
      /** Human-readable lines for an item's mods; `labels` maps stat names to display names. */
      describe(item, labels = {}) {
        return Object.keys(item.mods).flatMap((statName) => {
          const { add, mul } = item.mods[statName];
          const label = labels[statName] || statName;
          const addLine = add ? [`${signPrefix(add > 0)}${roundToTenth(add)} ${label}`] : [];
          const mulLine = Math.abs(mul - 1) > MUL_EPSILON ? [`${signPrefix(mul > 1)}${Math.round((mul - 1) * 100)}% ${label}`] : [];
          return addLine.concat(mulLine);
        });
      },
    };
  };

  // ---- inventory -----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} InventoryItem
   * A LootItem fits; so does any object with these fields.
   * @property {string} uid
   * @property {string} slot
   * @property {Object} mods modifier spec applied while equipped
   */

  const DEFAULT_BAG_SIZE = 24;
  /** Source-key prefix under which an equipped item's modifiers are registered in stats. */
  const EQUIP_SOURCE_PREFIX = 'eq:';
  /** Smallest stat difference that `compare` reports. */
  const STAT_EPSILON = 1e-9;

  /**
   * Creates an inventory: a bag of items plus one equipped item per slot.
   * @param {Object} options
   * @param {string[]} options.slots equipment slot names
   * @param {ReturnType<typeof Kit.stats>} [options.stats] receives the mods of equipped items
   * @param {{get: function, set: function}} [options.save] persists bag and equipment
   * @param {string} [options.key='inventory'] save key
   * @param {number} [options.size=24] bag capacity (equipped items do not count)
   * @returns {Object} `{ slots, bag, equipped(slot), full(), add(item), remove(uid), equip(uid), unequip(slot),
   *   compare(item, statNames), clear(), on(listener) }`
   * @complexity `add` is O(1); `remove`, `equip` are O(bag) (find by uid); `compare` is O(stat names) stat reads;
   *   every change saves the whole inventory, O(bag) to serialise
   * @example
   * const inventory = Kit.inventory({ slots: ['weapon', 'charm'], stats, save: ctx.save });
   * if (inventory.add(drop)) inventory.equip(drop.uid);   // add is false when the bag is full
   * inventory.compare(otherItem, ['damage', 'speed']);     // { damage: 2.5, speed: -0.3 }
   */
  Kit.inventory = ({ slots, stats, save, key = 'inventory', size = DEFAULT_BAG_SIZE } = {}) => {
    if (!Array.isArray(slots)) throw new Error("Kit.inventory: `slots` must be a list of slot names, e.g. Kit.inventory({ slots: ['weapon', 'charm'] })");
    const saved = Kit.persist.load(save, key, null);
    let bag = saved ? saved.bag : [];
    const worn = saved ? saved.worn : {};
    const changes = Kit.persist.tracker(save, key, () => ({ bag, worn }));

    const isFull = () => bag.length >= size;

    /** Brings stats in line with what is worn in a slot (clears the source when the slot is empty). */
    const applySlot = (slot) => stats && stats.mod(EQUIP_SOURCE_PREFIX + slot, worn[slot] ? worn[slot].mods : null);

    /** Removes an item from the bag by uid and returns it, or null when it is not there. */
    const takeFromBag = (uid) => {
      const index = bag.findIndex((item) => item.uid === uid);
      return index < 0 ? null : bag.splice(index, 1)[0];
    };

    // Restore the stat effects of saved equipment.
    slots.forEach(applySlot);

    return {
      slots,
      /** The items not equipped, oldest first (a live array: treat as read-only). */
      get bag() {
        return bag;
      },
      /** The item worn in a slot, or null. */
      equipped: (slot) => worn[slot] || null,
      full: isFull,
      /** Adds to the bag. Returns false (and changes nothing) when it is full. */
      add(item) {
        if (isFull()) return false;
        bag.push(item);
        changes.commit();
        return true;
      },
      /** Takes an item out of the bag for good. Returns it, or null when it is not in the bag. */
      remove(uid) {
        const item = takeFromBag(uid);
        if (item) changes.commit();
        return item;
      },
      /** Equips an item from the bag; whatever was in its slot goes back to the bag. False when not in the bag. */
      equip(uid) {
        const item = takeFromBag(uid);
        if (!item) return false;
        // The swap cannot overflow the bag: taking the item out freed the place the old one needs.
        if (worn[item.slot]) bag.push(worn[item.slot]);
        worn[item.slot] = item;
        applySlot(item.slot);
        changes.commit();
        return true;
      },
      /** Moves a slot's item back to the bag. False when the slot is empty or the bag is full. */
      unequip(slot) {
        if (!worn[slot] || isFull()) return false;
        bag.push(worn[slot]);
        delete worn[slot];
        applySlot(slot);
        changes.commit();
        return true;
      },
      /**
       * Stat-by-stat difference if `item` replaced what is worn in its slot. Stats that would not
       * change are left out; without a stats block the result is {}.
       */
      compare(item, statNames) {
        if (!stats) return {};
        const readStats = () => statNames.map((statName) => stats.get(statName));
        const before = readStats();
        // Try the item on, read the result, then put the real equipment back.
        stats.mod(EQUIP_SOURCE_PREFIX + item.slot, item.mods);
        const after = readStats();
        applySlot(item.slot);
        return statNames.reduce((differences, statName, index) => {
          const difference = after[index] - before[index];
          if (Math.abs(difference) > STAT_EPSILON) differences[statName] = difference;
          return differences;
        }, {});
      },
      /** Empties the bag and every slot. */
      clear() {
        bag = [];
        slots.forEach((slot) => {
          delete worn[slot];
          applySlot(slot);
        });
        changes.commit();
      },
      on: changes.on,
    };
  };
})();
