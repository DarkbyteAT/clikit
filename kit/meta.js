/**
 * Kit meta: progression that outlives a single run, and synergies between the things a player collects.
 *
 * Owns:  `Kit.profile` (lifetime statistics, permanent unlocks, achievements, account level, run history) and
 *        `Kit.synergy` (set bonuses that switch on when a build holds enough items with the right tags).
 * Does not own: per-run upgrades (`Kit.upgrades`), short goals (`Kit.goals`) or currencies (`Kit.wallet`) - it
 *        composes with them. Pure: no DOM, no THREE; unit-tested in tools/test-kit.js.
 *
 * Depth comes from three timescales. Upgrades and goals cover the session; this module covers the long arc
 * (what is different on run ten) and build identity (why two players' runs differ).
 */
(() => {
  /** How many finished runs the profile remembers for "recent runs" screens. */
  const RUN_HISTORY_LIMIT = 20;

  /**
   * @typedef {Object} AchievementRow
   * @property {string} id
   * @property {string} text            Shown to the player, e.g. 'Cleanse 100 souls'.
   * @property {string} stat            Lifetime statistic it watches (a name you pass to `count` or `best`).
   * @property {number} target          Value of that statistic at which it completes.
   * @property {string} [unlocks]       Id passed to `unlock` on completion (a character, a mode, a starting item).
   * @property {*} [reward]             Anything else; handed to `onAchievement`.
   */

  /**
   * A player's permanent record for one game.
   *
   * @param {Object} options
   * @param {{ get: Function, set: Function }} [options.save]  Persistence (ctx.save). Omit for an in-memory profile.
   * @param {AchievementRow[]} [options.achievements]
   * @param {*} [options.levelCurve]   Kit.curve spec: levels already gained (0 for a new player) -> experience needed for the next.
   * @param {(row: AchievementRow) => void} [options.onAchievement]
   * @param {(id: string) => void} [options.onUnlock]
   * @param {(level: number) => void} [options.onLevel]
   * @param {string} [options.key]     Save key. Default 'profile'.
   * @returns {Object} The profile API (see the returned object).
   *
   * @example
   * const profile = Kit.profile({ save: ctx.save, achievements: ACHIEVEMENTS, levelCurve: { base: 50, growth: 1.4 } });
   * profile.count('kills');                 // lifetime counter, also checks achievements
   * profile.best('distance', 412);          // keeps the maximum
   * if (profile.isUnlocked('crossbow')) ... // gate content on the long arc
   * profile.endRun({ time: 73, kills: 40 });
   *
   * @complexity count / best: O(a) where a = achievements watching that statistic. Memory: O(stats + unlocks + history).
   */
  Kit.profile = ({ save, achievements = [], levelCurve = { base: 100, growth: 1.5 }, onAchievement, onUnlock, onLevel, key = 'profile' } = {}) => {
    const table = Kit.table(achievements);
    // The curve is indexed by levels already gained, so the first level-up costs exactly the curve's base value.
    const experienceCurve = Kit.curve.of(levelCurve);
    const experienceFor = (level) => experienceCurve(level - 1);
    const state = { stats: {}, unlocked: {}, done: {}, level: 1, experience: 0, runs: [], runCount: 0, ...(save ? save.get(key, {}) : {}) };
    const bus = Kit.bus();

    // Achievements are indexed by the statistic they watch so a counter bump only checks the rows that can change.
    const watching = table.reduce((index, row) => {
      (index[row.stat] = index[row.stat] || []).push(row);
      return index;
    }, {});

    const persist = () => {
      if (save) save.set(key, state);
      bus.emit('change');
    };

    function unlock(id) {
      if (state.unlocked[id]) return false;
      state.unlocked[id] = true;
      persist();
      if (onUnlock) onUnlock(id);
      return true;
    }

    /** Complete every not-yet-done achievement whose statistic has reached its target. */
    function checkAchievements(statName) {
      (watching[statName] || [])
        .filter((row) => !state.done[row.id] && (state.stats[statName] || 0) >= row.target)
        .forEach((row) => {
          state.done[row.id] = true;
          if (row.unlocks) unlock(row.unlocks);
          if (onAchievement) onAchievement(row);
        });
    }

    function setStat(statName, value) {
      state.stats[statName] = value;
      checkAchievements(statName);
      persist();
      return value;
    }

    return {
      /** Lifetime value of a statistic (0 if never recorded). */
      stat: (statName) => state.stats[statName] || 0,
      /** Add to a lifetime counter. @returns {number} the new total. */
      count: (statName, amount = 1) => setStat(statName, (state.stats[statName] || 0) + amount),
      /** Record a personal best: keeps the larger of the stored and given value. @returns {number} the best. */
      best: (statName, value) => (value > (state.stats[statName] || 0) ? setStat(statName, value) : state.stats[statName] || 0),

      unlock,
      isUnlocked: (id) => !!state.unlocked[id],
      unlocked: () => Object.keys(state.unlocked),

      /** Every achievement with its live progress, for a trophy screen. */
      achievements: () => table.map((row) => ({ row, progress: Math.min(state.stats[row.stat] || 0, row.target), done: !!state.done[row.id] })),

      get level() {
        return state.level;
      },
      /** Progress through the current account level, 0..1. */
      levelProgress: () => state.experience / experienceFor(state.level),
      /**
       * Add account experience; may gain several levels at once.
       * @returns {number} how many levels were gained.
       */
      gainExperience(amount) {
        state.experience += amount;
        let gained = 0;
        // Loop rather than divide: each level may need a different amount, taken from the curve.
        while (state.experience >= experienceFor(state.level)) {
          state.experience -= experienceFor(state.level);
          state.level += 1;
          gained += 1;
          if (onLevel) onLevel(state.level);
        }
        persist();
        return gained;
      },

      get runCount() {
        return state.runCount;
      },
      /** Finished runs, newest first, capped at RUN_HISTORY_LIMIT. */
      runs: () => state.runs.slice(),
      /** Record a finished run (any plain-data summary). */
      endRun(summary) {
        state.runCount += 1;
        state.runs = [{ ...summary, run: state.runCount }, ...state.runs].slice(0, RUN_HISTORY_LIMIT);
        persist();
      },

      /** Subscribe to any change. @returns {() => void} unsubscribe. */
      on: (listener) => bus.on('change', listener),
    };
  };

  /**
   * @typedef {Object} SynergyRow
   * @property {string} id
   * @property {string} name                    e.g. 'Pyromancer'
   * @property {Record<string, number>} needs   Tag counts required, e.g. { fire: 2, blade: 1 }.
   * @property {Object} [mods]                  Kit.stats modifier spec applied while the synergy is active.
   * @property {string} [desc]
   */

  /**
   * Set bonuses: a synergy is active while the player's build holds at least `needs[tag]` items of every tag it names.
   * This is what makes two builds different: the same items are worth more together than apart.
   *
   * @param {SynergyRow[]} rows
   * @param {Object} [options]
   * @param {Object} [options.stats]  A Kit.stats instance; active synergies' `mods` are applied to it automatically.
   * @param {(row: SynergyRow, active: boolean) => void} [options.onChange]  Called when a synergy switches on or off.
   * @returns {{ update(items: Array, tagsOf?: Function): SynergyRow[], active(): SynergyRow[], progress(): Array, countTags: Function }}
   *
   * @example
   * const synergies = Kit.synergy(SYNERGIES, { stats });
   * synergies.update(ownedPowers, (power) => power.tags);   // call whenever the build changes
   * synergies.progress();  // [{ row, have: { fire: 1 }, active: false }] for "1 more fire item" hints
   *
   * @complexity update: O(items x tags + rows x needs). Memory: O(rows).
   */
  Kit.synergy = (rows, { stats, onChange } = {}) => {
    const table = Kit.table(rows);
    let activeIds = new Set();
    let tagCounts = {};

    /** Count how many items carry each tag. @returns {Record<string, number>} */
    const countTags = (items, tagsOf = (item) => item.tags || []) =>
      items.flatMap(tagsOf).reduce((counts, tag) => ({ ...counts, [tag]: (counts[tag] || 0) + 1 }), {});

    const isMet = (row) => Object.entries(row.needs).every(([tag, needed]) => (tagCounts[tag] || 0) >= needed);

    return {
      countTags,
      /** Recompute which synergies are active for the given build. @returns {SynergyRow[]} the active rows. */
      update(items, tagsOf) {
        tagCounts = countTags(items, tagsOf);
        const nowActive = new Set(table.filter(isMet).map((row) => row.id));
        // Only rows whose state flipped touch the stats or fire the callback.
        table
          .filter((row) => nowActive.has(row.id) !== activeIds.has(row.id))
          .forEach((row) => {
            const active = nowActive.has(row.id);
            if (stats && row.mods) stats.mod('synergy:' + row.id, active ? row.mods : null);
            if (onChange) onChange(row, active);
          });
        activeIds = nowActive;
        return table.filter((row) => activeIds.has(row.id));
      },
      active: () => table.filter((row) => activeIds.has(row.id)),
      /** Every synergy with how many of each needed tag the build has, for "one more to go" hints. */
      progress: () =>
        table.map((row) => ({
          row,
          active: activeIds.has(row.id),
          have: Object.fromEntries(Object.keys(row.needs).map((tag) => [tag, Math.min(tagCounts[tag] || 0, row.needs[tag])])),
        })),
    };
  };
})();
