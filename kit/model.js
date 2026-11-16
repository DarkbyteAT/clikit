/**
 * Kit model: progression as small, pure, composable pieces.
 *
 *   curve    - numbers from data:               Kit.curve.of({ base: 10, growth: 1.5 })(level)
 *   table    - rows with unique ids:            Kit.table(ROWS).byId('gold')
 *   stats    - base values + keyed modifiers:   stats.get('damage')
 *   wallet   - currencies:                      wallet.spend(25)
 *   upgrades - table x curve x stats x wallet:  upgrades.buy('pick')
 *   goals    - progress from game events:       goals.track('catch', 1, fish)
 *   persist  - the load / save / notify plumbing the stateful models share
 *
 * Owns:  the data models above. Each is useful alone; `upgrades` is only the composition of the others.
 * Does not own: how they are drawn (ui.shop / ui.offer / ui.checklist in ui.js), random items
 *        (loot.js) or where saves are stored (any `{ get(key, fallback), set(key, value) }`, usually ctx.save).
 *
 * No DOM, no THREE: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { lerp } = Kit.math;

  /**
   * @typedef {Object} Save
   * Any persistent key-value store; `ctx.save` and `Kit.store(namespace)` both fit.
   * @property {function(string, *=): *} get saved value, or the fallback when the key was never set
   * @property {function(string, *): *} set stores a JSON-serialisable value
   */

  // ---- persist: saved state plus a change event, shared by wallet, upgrades, goals and inventory ---------------------

  /**
   * @typedef {Object} ChangeTracker
   * @property {function(function(*): void): function(): boolean} on subscribe to changes; returns an unsubscribe function
   * @property {function(): void} persist write the current state to the save (no-op without a save)
   * @property {function(*=): void} notify tell subscribers something changed
   * @property {function(*=): void} commit persist, then notify
   */

  Kit.persist = {
    /**
     * Reads a model's saved state.
     * @param {Save} [save] omitted for a model that lives only in memory
     * @param {string} key
     * @param {*} fallback returned when there is no save or nothing was saved under `key`
     * @returns {*}
     */
    load: (save, key, fallback) => (save ? save.get(key, fallback) : fallback),

    /**
     * Creates the "state changed" plumbing of a model: one change event and an optional save.
     * @param {Save} [save]
     * @param {string} [key] where `readState()` is saved
     * @param {function(): *} [readState] returns the JSON-serialisable state to save
     * @returns {ChangeTracker}
     * @example
     * const changes = Kit.persist.tracker(save, 'wallet', () => balances);
     * balances.coins += 5; changes.commit('coins');
     */
    tracker(save, key, readState) {
      const bus = Kit.bus();
      const persist = () => {
        if (save) save.set(key, readState());
      };
      const notify = (payload) => bus.emit('change', payload);
      return {
        on: (listener) => bus.on('change', listener),
        persist,
        notify,
        // Save before notifying, so a listener that reads the save sees the new state.
        commit(payload) {
          persist();
          notify(payload);
        },
      };
    },
  };

  // ---- curve: every tunable number is either a constant or one of these ----------------------------------------------

  /**
   * @typedef {number | Array<[number, number]> | {base: number, growth: number} | {base: number, step: number}
   *   | {steps: Array<[number, number]>} | function(number): number} CurveSpec
   * Plain-data description of a curve, so tables stay JSON-like:
   *   `5` constant, `[[0, 1], [10, 3]]` piecewise-linear ramp, `{ base, growth }` geometric,
   *   `{ base, step }` linear, `{ steps: [[0, 1], [3, 1.5]] }` staircase, or a function used as is.
   *   Any of them can be wrapped as `{ of: spec, every, times, offset }` (see curve.periodic) for "every fifth one is a boss".
   */

  /** Copy of [x, y] points in ascending x order; refuses an empty list because a curve needs a value. */
  const sortPointsByX = (points, owner) => {
    if (!points.length) throw new Error(`${owner}: needs at least one [x, y] point`);
    return points.slice().sort((pointA, pointB) => pointA[0] - pointB[0]);
  };

  const curve = {
    /**
     * Piecewise-linear curve through the points, flat beyond both ends. Difficulty ramps, speed by
     * floor, spawn rate by time.
     * @param {Array<[number, number]>} points [x, y] pairs in any order (at least one)
     * @returns {function(number): number}
     * @complexity building sorts once, O(n log n); each evaluation scans for its segment, O(n) time, O(1) space
     *   (n = points; curves have a handful, so a binary search would not pay for itself)
     * @example Kit.curve.points([[0, 2], [10, 4]])(5) // 3
     */
    points(points) {
      const sorted = sortPointsByX(points, 'Kit.curve.points');
      const lastPoint = sorted[sorted.length - 1];
      return (x) => {
        // The first point at or beyond x ends the segment that x falls in.
        const upperIndex = sorted.findIndex(([pointX]) => x <= pointX);
        if (upperIndex === -1) return lastPoint[1];
        if (upperIndex === 0) return sorted[0][1];
        const [lowerX, lowerY] = sorted[upperIndex - 1];
        const [upperX, upperY] = sorted[upperIndex];
        return lerp(lowerY, upperY, (x - lowerX) / (upperX - lowerX));
      };
    },

    /**
     * Staircase: the y of the last point whose x is at or below the input (the first point's y
     * before that). Multiplier by streak, tier by depth.
     * @param {Array<[number, number]>} points [x, y] pairs in any order (at least one)
     * @returns {function(number): number}
     * @example Kit.curve.steps([[0, 1], [3, 1.5], [6, 2]])(5) // 1.5
     */
    steps(points) {
      const sorted = sortPointsByX(points, 'Kit.curve.steps');
      return (x) => sorted.reduce((value, [pointX, pointY]) => (x >= pointX ? pointY : value), sorted[0][1]);
    },

    /**
     * Geometric growth, the classic idle-game cost: base * growth^n.
     * @param {number} base value at n = 0
     * @param {number} growth factor per step
     * @returns {function(number): number}
     */
    geometric: (base, growth) => (n) => base * Math.pow(growth, n),

    /**
     * Linear growth: base + step * n.
     * @param {number} base value at n = 0
     * @param {number} step amount added per step
     * @returns {function(number): number}
     */
    linear: (base, step) => (n) => base + step * n,

    /**
     * Wraps a curve so that every `every`-th whole step is multiplied by `times`: boss floors, core ores,
     * jackpot rounds. Steps in between (and fractional inputs, which are never "the fifth one") pass through.
     * @param {function(number): number} inner the curve being wrapped
     * @param {number} every period in steps (a positive whole number)
     * @param {number} times factor applied on the periodic steps
     * @param {number} [offset=0] shifts which steps count: step n is periodic when (n + offset) is a multiple of `every`,
     *   so offset 1 with every 5 marks n = 4, 9, 14 (the fifth, tenth, fifteenth item of a 0-based curve)
     * @returns {function(number): number}
     * @throws {Error} when `every` is not a positive whole number (a period of 0 would mark nothing or everything)
     * @example Kit.curve.periodic(Kit.curve.geometric(10, 2), 5, 3, 1)(4) // 480: the fifth step, tripled
     */
    periodic(inner, every, times, offset = 0) {
      if (!Number.isInteger(every) || every < 1) throw new Error(`Kit.curve.periodic: every must be a positive whole number, got ${every}`);
      return (n) => inner(n) * (Number.isInteger(n) && (n + offset) % every === 0 ? times : 1);
    },

    /**
     * Builds a curve from plain data.
     * @param {CurveSpec} spec
     * @returns {function(number): number}
     * @throws {Error} when the spec matches none of the forms
     * @example Kit.curve.of({ base: 10, growth: 2 })(3) // 80
     */
    of(spec) {
      if (typeof spec === 'function') return spec;
      if (typeof spec === 'number') return () => spec;
      if (Array.isArray(spec)) return curve.points(spec);
      // Checked before the plain forms: a periodic spec wraps one of them under `of`.
      if (spec && spec.every !== undefined) return curve.periodic(curve.of(spec.of), spec.every, spec.times, spec.offset);
      if (spec && spec.steps) return curve.steps(spec.steps);
      if (spec && spec.growth !== undefined) return curve.geometric(spec.base, spec.growth);
      if (spec && spec.step !== undefined) return curve.linear(spec.base, spec.step);
      throw new Error('Kit.curve.of: unrecognised spec ' + JSON.stringify(spec));
    },
  };
  Kit.curve = curve;

  // ---- table: an array of rows with unique ids -----------------------------------------------------------------------

  /**
   * Wraps rows in a table: a copy of the array (so map / filter / indexOf still work) plus id lookup.
   * @template {{id: (string|number)}} Row
   * @param {Row[]} rows
   * @returns {Row[] & {has: function(*): boolean, byId: function(*): Row}}
   * @throws {Error} on a row without an id or on a duplicate id; `byId` throws on an unknown id
   * @complexity O(rows) time and space to build; `has` and `byId` are O(1) (a Map by id)
   * @example Kit.table([{ id: 'gold', value: 5 }]).byId('gold').value // 5
   */
  Kit.table = (rows) => {
    const rowsById = new Map();
    rows.forEach((row) => {
      if (row.id === undefined) throw new Error('Kit.table: row without id');
      if (rowsById.has(row.id)) throw new Error(`Kit.table: duplicate id "${row.id}"`);
      rowsById.set(row.id, row);
    });
    const table = rows.slice();
    table.has = (id) => rowsById.has(id);
    table.byId = (id) => {
      if (!rowsById.has(id)) throw new Error(`Kit.table: no row "${id}"`);
      return rowsById.get(id);
    };
    return table;
  };

  // ---- stats: value = (base + sum of adds) * product of muls ---------------------------------------------------------

  /**
   * @typedef {Object} Modifier
   * @property {number} [add] flat amount added to the base (default 0)
   * @property {number} [mul] factor applied after the adds (default 1)
   */

  /**
   * @typedef {Object<string, Modifier>} ModSpec
   * Modifiers by stat name, e.g. `{ speed: { mul: 1.2 }, damage: { add: 3 } }`.
   */

  /**
   * Fills in a modifier's defaults.
   * @param {Modifier} modifier
   * @returns {{add: number, mul: number}}
   */
  const normalize = (modifier) => ({
    add: modifier.add || 0,
    mul: modifier.mul === undefined ? 1 : modifier.mul,
  });

  /**
   * Transforms every modifier of a spec; the building block of scale (below) and power (loot.js).
   * @param {ModSpec} spec
   * @param {function({add: number, mul: number}, string): Modifier} transform gets the normalised modifier and its stat name
   * @returns {ModSpec} a new spec with the same stat names
   */
  const mapSpec = (spec, transform) =>
    Object.keys(spec).reduce((mapped, statName) => {
      mapped[statName] = transform(normalize(spec[statName]), statName);
      return mapped;
    }, {});

  /**
   * Creates a stat block: base values plus modifiers keyed by where they come from, so applying a
   * source again replaces its earlier contribution instead of stacking on it.
   * @param {Object<string, number>} base stat name to base value
   * @param {Object} [options]
   * @param {Object<string, [number, number]>} [options.limits] stat name to [min, max]; `get` never returns a value
   *   outside it however the modifiers stack (a crit chance stays in 0..1, a cooldown never reaches 0). Use
   *   -Infinity / Infinity for an open end. Stats without a limit are unbounded, as before.
   * @returns {{base: Object<string, number>, get: function(string): number, mod: function(string, ?ModSpec): void,
   *   preview: function(string, string, ?ModSpec): number,
   *   clear: function(): void, on: function(function(string=): void): function(): boolean}}
   *   `preview(statName, source, spec)` is what `get(statName)` would return if `source` contributed `spec`
   *   (null = nothing) instead of its current modifiers; nothing is changed and nobody is notified.
   * @example
   * const stats = Kit.stats({ speed: 4 });
   * stats.mod('upg:boots', { speed: { mul: 1.5 } });
   * stats.get('speed'); // 6
   * stats.mod('upg:boots', null); // removes that source
   * @example
   * const stats = Kit.stats({ crit: 0.9 }, { limits: { crit: [0, 1] } });
   * stats.preview('crit', 'upg:luck', { crit: { add: 0.3 } }); // 1 (clamped), and stats.get('crit') is still 0.9
   */
  Kit.stats = (base, { limits = {} } = {}) => {
    const specsBySource = new Map();
    const changes = Kit.persist.tracker();
    /**
     * Combined modifiers per stat name, filled on first read and emptied whenever a source changes.
     * Only the modifier totals are cached, never the final value, so writing to `base` directly
     * still shows on the next read.
     * @type {Map<string, {add: number, mul: number}>}
     */
    const totalsByStat = new Map();

    /** Sums the adds and multiplies the muls that every source contributes to one stat. O(sources). */
    const combineModifiers = (statName) => {
      let totalAdd = 0;
      let totalMul = 1;
      for (const spec of specsBySource.values()) {
        const modifier = spec[statName];
        if (!modifier) continue;
        const { add, mul } = normalize(modifier);
        totalAdd += add;
        totalMul *= mul;
      }
      return { add: totalAdd, mul: totalMul };
    };

    return {
      base,
      /**
       * The stat's current value.
       * @complexity O(1) time after the first read of a stat since the last mod() / clear(); that first read is
       *   O(sources). O(stats read) space for the cache. Games read stats every frame and change them rarely.
       */
      get(statName) {
        let totals = totalsByStat.get(statName);
        if (!totals) {
          totals = combineModifiers(statName);
          totalsByStat.set(statName, totals);
        }
        // Adds before muls, so "+5 damage" and "x2 damage" combine the same way in any order.
        const value = ((base[statName] || 0) + totals.add) * totals.mul;
        const limit = limits[statName];
        return limit ? Kit.math.clamp(value, limit[0], limit[1]) : value;
      },
      preview(statName, source, spec) {
        // A throwaway copy with one source swapped, so the answer comes from the same `get` and can never drift from it.
        const whatIf = Kit.stats(base, { limits });
        specsBySource.forEach((otherSpec, otherSource) => {
          if (otherSource !== source) whatIf.mod(otherSource, otherSpec);
        });
        if (spec) whatIf.mod(source, spec);
        return whatIf.get(statName);
      },
      /**
       * Sets (or with null removes) the modifiers one source contributes. The spec is read when stats are next
       * computed and then cached: to change a source's effect, call mod() again rather than editing the spec object.
       */
      mod(source, spec) {
        if (spec) specsBySource.set(source, spec);
        else specsBySource.delete(source);
        totalsByStat.clear();
        changes.notify(source);
      },
      clear() {
        specsBySource.clear();
        totalsByStat.clear();
        changes.notify();
      },
      on: changes.on,
    };
  };

  Kit.stats.normalize = normalize;
  Kit.stats.mapSpec = mapSpec;

  /**
   * Scales a per-level modifier spec to a level: adds stack linearly, muls compound.
   * @param {ModSpec} spec the effect of one level
   * @param {number} level
   * @returns {ModSpec}
   * @example Kit.stats.scale({ damage: { add: 2, mul: 1.1 } }, 3) // { damage: { add: 6, mul: 1.331 } }
   */
  Kit.stats.scale = (spec, level) => mapSpec(spec, ({ add, mul }) => ({ add: add * level, mul: Math.pow(mul, level) }));

  // ---- wallet: one or more currencies --------------------------------------------------------------------------------

  const DEFAULT_CURRENCY = 'coins';

  /**
   * Creates a wallet. Saved balances win over the initial ones, so `initial` is the starting
   * money of a fresh save.
   * @param {Object<string, number>} [initial={ coins: 0 }] currency name to starting balance
   * @param {Save} [save] omit for a wallet that resets every run
   * @param {string} [key='wallet'] save key
   * @returns {{get: function(string=): number, can: function(number, string=): boolean, add: function(number, string=): number,
   *   spend: function(number, string=): boolean, on: function(function(string): void): function(): boolean}}
   *   `spend` returns false and changes nothing when the balance is too low; every currency argument defaults to 'coins'.
   *   Also `canAll(costs)` / `spendAll(costs)` for a price in several currencies at once (a recipe, an alloy): `costs` maps
   *   currency name to amount; `spendAll` pays every part or, when any part is short, nothing (and returns false).
   * @example
   * const wallet = Kit.wallet({ coins: 10, gems: 0 }, ctx.save);
   * if (wallet.spend(4)) wallet.add(1, 'gems');
   * @example
   * if (wallet.spendAll({ copper: 6, silver: 2 })) forgeBronze(); // all or nothing
   */
  Kit.wallet = (initial = { coins: 0 }, save, key = 'wallet') => {
    const balances = { ...initial, ...Kit.persist.load(save, key, {}) };
    const changes = Kit.persist.tracker(save, key, () => balances);
    const balanceOf = (currency) => balances[currency] || 0;
    return {
      get: (currency = DEFAULT_CURRENCY) => balanceOf(currency),
      can: (amount, currency = DEFAULT_CURRENCY) => balanceOf(currency) >= amount,
      add(amount, currency = DEFAULT_CURRENCY) {
        balances[currency] = balanceOf(currency) + amount;
        changes.commit(currency);
        return balances[currency];
      },
      spend(amount, currency = DEFAULT_CURRENCY) {
        if (balanceOf(currency) < amount) return false;
        balances[currency] -= amount;
        changes.commit(currency);
        return true;
      },
      /** @complexity O(currencies in `costs`) */
      canAll: (costs) => Object.keys(costs).every((currency) => balanceOf(currency) >= costs[currency]),
      /** @complexity O(currencies in `costs`); one save and one change event per currency paid */
      spendAll(costs) {
        // Check every part before paying any, so a recipe is never half paid.
        if (!Object.keys(costs).every((currency) => balanceOf(currency) >= costs[currency])) return false;
        Object.keys(costs).forEach((currency) => {
          balances[currency] -= costs[currency];
          changes.commit(currency);
        });
        return true;
      },
      on: changes.on,
    };
  };

  // ---- upgrades: rows + levels. Composes table, curve, stats and wallet; every dependency is optional ----------------

  /**
   * @typedef {Object} UpgradeRow
   * Any extra fields (color, tag, icon) are yours and are passed through untouched.
   * @property {string} id
   * @property {string} [name]
   * @property {string | function(number): string} [desc] text, or text for a given level
   * @property {number} [max] highest level (default: no limit)
   * @property {CurveSpec} [cost] price of the next level as a curve of the current level; omitted = free
   *   (use grant / offer for level-up picks)
   * @property {string} [currency] wallet currency (default 'coins')
   * @property {ModSpec | function(number): ModSpec} [mods] effect of ONE level (scaled by Kit.stats.scale), or a
   *   function giving the whole effect at a level; pushed into `stats` automatically
   * @property {string | string[]} [requires] id(s) that must be at level 1+ first: enough to describe a skill tree
   * @property {function(number, UpgradeRow): void} [onLevel] for effects stats cannot express (spawn an orbiting blade)
   * @property {string | string[]} [requiresMax] id(s) that must be at their max level first: an evolution of two maxed rows
   * @property {string | string[]} [excludes] id(s) this row cannot be owned together with (checked both ways): an either-or choice
   * @property {string} [slot] the limited slot the row occupies once owned (capacities come from `options.slots`)
   * @property {number | function(number, UpgradeRow): number} [weight] how often `offer` shows the row, relative to the
   *   others (default 1; 0 never); a function gets the row's current level, e.g. `(level) => (level ? 1 : 3)` favours new rows
   */

  /** Source-key prefix under which an upgrade's modifiers are registered in stats. */
  const UPGRADE_SOURCE_PREFIX = 'upg:';

  /**
   * Creates upgrade state over a table of rows.
   * @param {UpgradeRow[]} rows
   * @param {Object} [options]
   * @param {ReturnType<typeof Kit.stats>} [options.stats] receives each row's `mods`
   * @param {ReturnType<typeof Kit.wallet>} [options.wallet] pays for `buy`; without it everything is affordable
   * @param {Save} [options.save] persists levels
   * @param {string} [options.key='upgrades'] save key
   * @param {Object<string, number>} [options.slots] slot name to how many different rows with that `slot` may be owned
   *   at once, e.g. `{ weapon: 3 }`; a full slot stops new rows of it from being bought or offered (owned ones still level)
   * @returns {Object} `{ table, level(id), maxed(id), cost(id), unlocked(id), canBuy(id), buy(id), grant(id),
   *   offer(n, filter), desc(id, level), preview(id, statName, level), owned(), available(), affordable(), reset(),
   *   restore(), on(listener) }`
   * @complexity `level`, `cost`, `maxed`, `canBuy`, `buy` and `grant` are O(1) per call (plus O(requires) for the
   *   unlock check); `offer`, `owned`, `available`, `affordable`, `reset` and `restore` are O(rows). O(rows) space.
   * @example
   * const upgrades = Kit.upgrades(UPGRADES, { stats, wallet, save: ctx.save });
   * if (upgrades.buy('pick')) sfx.play('coin');     // pays, levels up, updates stats
   * const choices = upgrades.offer(3);              // three random rows for a level-up screen
   * upgrades.on(({ id, level, row }) => redrawShop());
   */
  Kit.upgrades = (rows, { stats, wallet, save, key = 'upgrades', slots = {} } = {}) => {
    const table = Kit.table(rows);
    const levels = { ...Kit.persist.load(save, key, {}) };
    const changes = Kit.persist.tracker(save, key, () => levels);

    const level = (id) => levels[id] || 0;
    const maxLevelOf = (row) => (row.max === undefined ? Infinity : row.max);
    const maxed = (id) => level(id) >= maxLevelOf(table.byId(id));
    const cost = (id) => {
      const row = table.byId(id);
      // Prices are whole numbers so the HUD never shows fractions of a coin.
      return row.cost === undefined ? 0 : Math.ceil(Kit.curve.of(row.cost)(level(id)));
    };
    // `requires` may be one id or a list; concat normalises both (and a missing value) to a list.
    const unlocked = (id) => [].concat(table.byId(id).requires || []).every((requiredId) => level(requiredId) > 0);
    /** How many rows of a slot are owned (level 1 or above). O(rows). */
    const slotUse = (slot) => table.filter((row) => row.slot === slot && level(row.id) > 0).length;
    /**
     * The optional gates of a row, each a rule about OTHER rows: `requiresMax` (every listed row is at its max level:
     * evolutions), `excludes` (no listed row is owned, and no owned row lists this one: either-or choices) and `slot`
     * (a row not yet owned needs a free place in its slot when `options.slots` gives that slot a capacity).
     * A row with none of these fields passes, so tables that never use them behave as before.
     */
    const passesGates = (row) => {
      const allMaxed = [].concat(row.requiresMax || []).every((requiredId) => maxed(requiredId));
      const isExcluded = [].concat(row.excludes || []).some((otherId) => level(otherId) > 0) || table.some((other) => level(other.id) > 0 && [].concat(other.excludes || []).includes(row.id));
      const hasSlotRoom = row.slot === undefined || slots[row.slot] === undefined || level(row.id) > 0 || slotUse(row.slot) < slots[row.slot];
      return allMaxed && !isExcluded && hasSlotRoom;
    };
    const canLevel = (row) => unlocked(row.id) && !maxed(row.id) && passesGates(row);
    const canBuy = (id) => canLevel(table.byId(id)) && (!wallet || wallet.can(cost(id), table.byId(id).currency));

    /** The modifiers a row contributes at a level, or null (no contribution) at level 0. */
    const modsAtLevel = (row, rowLevel) => {
      if (!rowLevel) return null;
      return typeof row.mods === 'function' ? row.mods(rowLevel) : Kit.stats.scale(row.mods, rowLevel);
    };

    /** Pushes a row's current contribution into stats, replacing its previous one. */
    const applyMods = (row) => {
      if (stats && row.mods) stats.mod(UPGRADE_SOURCE_PREFIX + row.id, modsAtLevel(row, level(row.id)));
    };

    /** Sets a level and brings stats, the save and listeners up to date. `silent` skips the row's onLevel hook. */
    const setLevel = (id, newLevel, silent) => {
      const row = table.byId(id);
      levels[id] = newLevel;
      applyMods(row);
      changes.persist();
      if (!silent && row.onLevel) row.onLevel(newLevel, row);
      changes.notify({ id, level: newLevel, row });
    };

    const levelUp = (id) => setLevel(id, level(id) + 1);

    // Restore the stat effects of saved levels (onLevel hooks wait for an explicit restore()).
    table.forEach(applyMods);

    return {
      table,
      level,
      maxed,
      cost,
      unlocked,
      canBuy,
      /** Pays and levels up. Returns false (and changes nothing) if locked, maxed or unaffordable. */
      buy(id) {
        if (!canBuy(id)) return false;
        if (wallet && cost(id) > 0) wallet.spend(cost(id), table.byId(id).currency);
        levelUp(id);
        return true;
      },
      /** How many different owned rows occupy a slot, for "2 / 3 weapons" readouts. */
      slotUse,
      /** Levels up without paying (level-up choices, milestone rewards). Ignores `requires`; false when maxed. */
      grant(id) {
        if (maxed(id)) return false;
        levelUp(id);
        return true;
      },
      /**
       * Up to `count` random rows that can still be levelled, for "pick 1 of 3". Rows may carry `weight` (a number, or
       * `(level, row) => number` of the row's current level; default 1) to show up more or less often; 0 hides a row.
       * With no weights anywhere every row is equally likely, exactly as before.
       */
      offer(count = 3, filter = () => true) {
        const candidates = table.filter((row) => canLevel(row) && filter(row));
        if (!candidates.some((row) => row.weight !== undefined)) return Kit.math.shuffle(candidates).slice(0, count);
        const weightOf = (row) => (typeof row.weight === 'function' ? row.weight(level(row.id), row) : row.weight === undefined ? 1 : row.weight);
        return Kit.math.sampleWeighted(candidates, count, weightOf);
      },
      /** A row's description text at a level (default: its current level). */
      desc(id, atLevel = level(id)) {
        const description = table.byId(id).desc;
        return typeof description === 'function' ? description(atLevel) : description || '';
      },
      /**
       * The value `statName` would have with this row at `atLevel` (default: one level up) and everything else as it
       * is now: the "next level gives" line of a shop card. Needs `stats`; changes nothing.
       * @example `${fmt(stats.get('damage'))} -> ${fmt(upgrades.preview('pick', 'damage'))}`
       */
      preview(id, statName, atLevel = level(id) + 1) {
        if (!stats) throw new Error('Kit.upgrades.preview: needs the `stats` option to compute a stat value');
        const row = table.byId(id);
        // A row without mods (an onLevel-only upgrade) contributes nothing at any level.
        return stats.preview(statName, UPGRADE_SOURCE_PREFIX + id, row.mods ? modsAtLevel(row, atLevel) : null);
      },
      /** Rows at level 1 or above. */
      owned: () => table.filter((row) => level(row.id) > 0),
      /** Rows that can still be levelled, in table order (shops, "what can I afford" text). */
      available: () => table.filter(canLevel),
      /** Rows the wallet can pay for right now. */
      affordable: () => table.filter((row) => canBuy(row.id)),
      /** Sets every level back to 0 without firing onLevel. */
      reset() {
        table.forEach((row) => setLevel(row.id, 0, true));
      },
      on: changes.on,
      /** Re-fires onLevel for saved levels; call once after creating the things onLevel touches. */
      restore() {
        table.filter((row) => level(row.id) && row.onLevel).forEach((row) => row.onLevel(level(row.id), row));
      },
    };
  };

  // ---- goals: short objectives driven by game events -----------------------------------------------------------------

  /**
   * @typedef {Object} GoalRow
   * @property {string} id
   * @property {string} text what the player reads
   * @property {string} event the tracked event that advances this goal
   * @property {number} [target=1] amount needed
   * @property {function(*): boolean} [when] only payloads that pass count
   * @property {*} [reward] yours to read in onDone
   */

  /**
   * Creates goal state over a table of rows.
   * @param {GoalRow[]} rows
   * @param {Object} [options]
   * @param {Save} [options.save] persists progress
   * @param {string} [options.key='goals'] save key
   * @param {function(GoalRow): void} [options.onDone] fires once, when a goal reaches its target
   * @complexity `track`, `list` and `allDone` are O(rows) time; `done` and `progress` are O(1). O(rows) space.
   * @returns {Object} `{ table, done(id), progress(id), list(), allDone(), track(event, amount, payload), on(listener) }`;
   *   `list()` gives `{ row, progress, target, done }` per goal for drawing.
   * @example
   * const goals = Kit.goals([{ id: 'three', text: 'Catch 3', event: 'catch', target: 3 }], { onDone: (goal) => ui.toast(goal.text) });
   * goals.track('catch', 1, fish);
   */
  Kit.goals = (rows, { save, key = 'goals', onDone } = {}) => {
    const table = Kit.table(rows);
    const progressById = { ...Kit.persist.load(save, key, {}) };
    const changes = Kit.persist.tracker(save, key, () => progressById);

    const targetOf = (row) => row.target || 1;
    const rawProgress = (id) => progressById[id] || 0;
    const done = (id) => rawProgress(id) >= targetOf(table.byId(id));
    // Reported progress stops at the target, so an overshoot never draws as "4 / 3".
    const progress = (id) => Math.min(rawProgress(id), targetOf(table.byId(id)));
    const counts = (row, event, payload) => row.event === event && !done(row.id) && (!row.when || row.when(payload));

    return {
      table,
      done,
      progress,
      list: () => table.map((row) => ({ row, progress: progress(row.id), target: targetOf(row), done: done(row.id) })),
      allDone: () => table.every((row) => done(row.id)),
      track(event, amount = 1, payload) {
        // Rows are checked one at a time, in table order, because an onDone hook may change what counts next.
        table.forEach((row) => {
          if (!counts(row, event, payload)) return;
          progressById[row.id] = rawProgress(row.id) + amount;
          changes.commit(row);
          if (done(row.id) && onDone) onDone(row);
        });
      },
      on: changes.on,
    };
  };
})();
