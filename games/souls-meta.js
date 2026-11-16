// Soulwake meta: the build (everything that modifies the hero) and the long arc (what outlives a run), as one bundle
// of kit models. No DOM, no THREE: the game and the headless career simulation (scratch/souls/career.js) both drive
// exactly this code, so what the simulation proves about pacing is true of the game.
//
// Owns: wiring Kit.stats / wallet / upgrades / inventory / synergy / profile together, which tags a build holds,
// what a class and a tier do at the start of a run, and which lifetime statistics the run's events feed.
// Does not own: tables (games/souls-data.js), the run itself (games/souls-sim.js) or any screen (games/souls.js).
// Exposed as the global SOULWAKE_META.
(() => {
  const DATA = window.SOULWAKE_DATA;
  const baseRows = Kit.table(DATA.BASES);
  /** Affixes and curses share one id space on an item (`item.affixes`), so they are looked up together. */
  const affixRows = Kit.table([...DATA.AFFIXES, ...DATA.CURSES]);
  const tagsOf = (source) => source.tags || [];

  /**
   * The build tags an item carries: its base's and those of every affix and curse on it.
   * @param {Object} item  a Kit.loot item
   * @returns {string[]}
   */
  const itemTags = (item) => [baseRows.byId(item.base), ...item.affixes.map((affixId) => affixRows.byId(affixId))].flatMap(tagsOf);

  /**
   * Everything in a build that carries tags: held powers, owned tree nodes, the class, and each worn item.
   * @param {Object} build  from createBuild
   * @returns {{ tags?: string[] }[]}
   */
  function tagSources(build) {
    const worn = DATA.SLOTS.map((slot) => build.inventory.equipped(slot)).filter(Boolean);
    return [...build.powers.owned(), ...build.tree.owned(), build.classRow, ...worn.map((item) => ({ tags: itemTags(item) }))];
  }

  /**
   * The tags a build is attuned to: the few it holds most of (DATA.ATTUNED_TAGS of them). Ties go to the tag listed
   * first in DATA.TAG_LABELS, so the answer never flickers between equal counts.
   * @param {Record<string, number>} tagCounts  tag -> how many the build holds
   * @returns {string[]} attuned tag ids, strongest first
   * @complexity O(t log t) for t tags (five).
   */
  function attunedTags(tagCounts) {
    const order = Object.keys(DATA.TAG_LABELS);
    return order
      .filter((tag) => tagCounts[tag] > 0)
      .sort((first, second) => tagCounts[second] - tagCounts[first] || order.indexOf(first) - order.indexOf(second))
      .slice(0, DATA.ATTUNED_TAGS);
  }

  /**
   * @typedef {Object} Build
   * @property {Object} stats       Kit.stats of the hero; every other model here feeds it
   * @property {Object} wallet      Kit.wallet with the `souls` currency (saved)
   * @property {Object} tree        Kit.upgrades over DATA.TREE (saved): the soul tree
   * @property {Object} powers      Kit.upgrades over DATA.POWERS (this run only)
   * @property {Object} inventory   Kit.inventory (this run only)
   * @property {Object} synergies   Kit.synergy over DATA.SYNERGIES, kept current as the build changes
   * @property {Object} profile     Kit.profile (saved): lifetime statistics, achievements and unlocks
   * @property {string[]} attunement the tags the build is attuned to right now (see attunedTags)
   * @property {Object} classRow    the DATA.CLASSES row of this run
   * @property {Object} tier        the DATA.TIERS row of this run
   */

  /**
   * Creates the models of one run on top of what is saved, and wires them: any change to powers, tree or worn gear
   * re-counts the build's tags, re-decides its attunement, and switches synergies (and their stat mods) on and off.
   * @param {Object} [options]
   * @param {{ get: Function, set: Function }} [options.save]            persistence (ctx.save); omit for a throwaway build
   * @param {(row: Object) => void} [options.onAchievement]             an achievement was completed
   * @param {(unlockId: string) => void} [options.onUnlock]             something was unlocked ('class:...' or 'tier:...')
   * @param {(row: Object, isNew: boolean) => void} [options.onSynergy] a synergy woke; isNew: for the first time ever
   * @returns {Build}
   * @complexity every build change re-counts tags in O(sources x tags + synergies), a few dozen operations.
   */
  function createBuild({ save, onAchievement, onUnlock, onSynergy } = {}) {
    const stats = Kit.stats({ ...DATA.HERO_STATS });
    const wallet = Kit.wallet({ souls: 0 }, save);
    // Every tree node is paid for in souls; the rows say what, the wiring says with which currency.
    const tree = Kit.upgrades(DATA.TREE.map((row) => ({ ...row, currency: 'souls' })), { stats, wallet, save, key: 'tree' });
    const powers = Kit.upgrades(DATA.POWERS, { stats });
    const inventory = Kit.inventory({ slots: DATA.SLOTS, stats, size: DATA.LOOT.bagSize });
    // Synergy discoveries are not announced as unlocks: only classes and tiers are.
    const profile = Kit.profile({ save, achievements: DATA.ACHIEVEMENTS, onAchievement, onUnlock: (unlockId) => !unlockId.startsWith('synergy:') && onUnlock && onUnlock(unlockId) });
    const synergies = Kit.synergy(DATA.SYNERGIES, {
      stats,
      onChange(row, isActive) {
        if (!isActive) return;
        // A synergy counts toward "different synergies woken" the first time it is ever active.
        const isNew = profile.unlock(`synergy:${row.id}`);
        if (isNew) profile.count('synergiesFound');
        if (onSynergy) onSynergy(row, isNew);
      },
    });
    const build = { stats, wallet, tree, powers, inventory, synergies, profile, attunement: [], classRow: DATA.CLASSES[0], tier: DATA.TIERS[0] };
    build.refreshSynergies = () => {
      const sources = tagSources(build);
      build.attunement = attunedTags(synergies.countTags(sources, tagsOf));
      // Only attuned tags reach the synergies, so a build wakes the bonuses of what it has most of, not of everything.
      synergies.update(sources, (source) => tagsOf(source).filter((tag) => build.attunement.includes(tag)));
    };
    [tree, powers, inventory].forEach((model) => model.on(build.refreshSynergies));
    build.refreshSynergies();
    return build;
  }

  /** Rows of a table the profile has unlocked (rows without an `unlock` are always available). */
  const unlockedRows = (rows, profile) => rows.filter((row) => !row.unlock || profile.isUnlocked(row.unlock));
  /** @returns {Object[]} the DATA.CLASSES rows the player may pick */
  const availableClasses = (profile) => unlockedRows(DATA.CLASSES, profile);
  /** @returns {Object[]} the DATA.TIERS rows the player may pick */
  const availableTiers = (profile) => unlockedRows(DATA.TIERS, profile);

  /**
   * Starts a run as a class on a tier: the class's stat mods and starting powers are applied, and the world is told
   * how hard the night is. Call once, before the first simulation step.
   * @param {Build} build
   * @param {Object} world     from SOULWAKE_SIM.createWorld
   * @param {Object} classRow  a row of DATA.CLASSES
   * @param {Object} tier      a row of DATA.TIERS
   */
  function beginRun(build, world, classRow, tier) {
    Object.assign(build, { classRow, tier });
    world.tier = tier;
    build.stats.mod('class', classRow.mods);
    classRow.powers.forEach((powerId) => build.powers.grant(powerId));
    world.hero.hp = build.stats.get('maxHp');
    build.refreshSynergies();
  }

  /** Lifetime statistics fed by the simulation's events, keyed by event type. Each returns the statistic names to count. */
  const STATISTICS_OF_EVENT = {
    cleanse: () => ['cleansed'],
    // Kills are counted per kind (the bestiary), and again per tier above the first (tier-gated achievements).
    down: (event, tier) => [`down:${event.kind}`, ...(tier.unlock ? [`down:${event.kind}@${tier.id}`] : [])],
    pickup: (event) => [`found:${event.drop.item.rarity}`],
  };

  /**
   * Feeds one simulation event into the profile's lifetime statistics (which completes achievements and unlocks).
   * @param {Build} build
   * @param {{ type: string }} event  an entry of world.events
   */
  function recordRunEvent(build, event) {
    const statisticsOf = STATISTICS_OF_EVENT[event.type];
    if (statisticsOf) statisticsOf(event, build.tier).forEach((statistic) => build.profile.count(statistic));
  }

  /**
   * Can this power not be taken on a roll? True when it is at its level cap, or when it would be a new power and
   * every power slot is already filled: the first powers taken define the build, later rolls deepen it.
   * @param {Build} build
   * @param {string} powerId
   * @returns {boolean}
   */
  function isPowerBarred(build, powerId) {
    const { powers, stats } = build;
    const isHeld = powers.level(powerId) > 0;
    return powers.maxed(powerId) || (!isHeld && powers.owned().length >= stats.get('powerSlots'));
  }

  /** Counts one absorbed power toward the lifetime total. */
  const recordAbsorb = (build) => build.profile.count('absorbed');

  /**
   * Closes a run: personal bests (overall and for this tier) and a line in the run history.
   * @param {Build} build
   * @param {Object} world
   * @returns {{ time: number, cleansed: number, classId: string, tierId: string, synergies: string[] }} the summary stored
   */
  function finishRun(build, world) {
    const seconds = Math.floor(world.time);
    const summary = { time: seconds, cleansed: world.tally.cleansed, classId: build.classRow.id, tierId: build.tier.id, synergies: build.synergies.active().map((row) => row.id) };
    build.profile.best('bestTime', seconds);
    build.profile.best(`bestTime@${build.tier.id}`, seconds);
    build.profile.endRun(summary);
    return summary;
  }

  /**
   * Words for an unlock id, for toasts and the deeds list.
   * @param {string} unlockId  'class:<id>' or 'tier:<id>'
   * @returns {string} e.g. 'the Sexton' or 'Midnight'
   */
  function describeUnlock(unlockId) {
    const [kind, id] = unlockId.split(':');
    const describe = { class: () => `the ${Kit.table(DATA.CLASSES).byId(id).name}`, tier: () => Kit.table(DATA.TIERS).byId(id).name };
    return describe[kind] ? describe[kind]() : unlockId;
  }

  window.SOULWAKE_META = { createBuild, availableClasses, availableTiers, beginRun, isPowerBarred, recordRunEvent, recordAbsorb, finishRun, itemTags, describeUnlock };
})();
