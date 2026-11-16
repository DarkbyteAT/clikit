// Kit craft: the pure logic behind build-crafting screens. No DOM, no THREE - runs in node (see tools/test-kit.js).
// Loads after model.js and loot.js (it reads Kit.upgrades / Kit.loot models and adds Kit.loot.augment).
//
//   treeLayout   - a Kit.upgrades model whose rows carry `row` and `col` -> placed nodes with a status, plus prerequisite edges
//   nodeStatus   - 'locked' | 'short' | 'available' | 'owned' | 'maxed' for one upgrade
//   reel         - a slot-machine strip over a weighted table that lands on a winner chosen beforehand
//   pity         - a chance roll that cannot miss more than `limit` times in a row (first-drop guarantees)
//   compareLines - stat deltas (Kit.inventory.compare) -> signed, labelled lines that know which direction is better
//   Kit.loot.augment - add one more affix (a curse, an enchant, a socket) to an item that was already rolled
//
// Owns: the decisions those screens show. Does not own: drawing them (kit/views.js), the models themselves
//       (kit/model.js, kit/loot.js) or any game's meaning of a power, an item or a fusion.
(() => {
  /**
   * How one upgrade stands for the player right now, most restrictive first:
   *   locked    - a prerequisite is missing
   *   maxed     - at its level cap
   *   available - can be bought now (whether or not some levels are already owned)
   *   owned     - has at least one level, but the next one cannot be afforded
   *   short     - unlocked with no levels yet, and the first one cannot be afforded
   * @typedef {'locked'|'maxed'|'available'|'owned'|'short'} NodeStatus
   */

  /**
   * @param {Object} upgrades  a Kit.upgrades model
   * @param {string} id        row id
   * @returns {NodeStatus}
   */
  function nodeStatus(upgrades, id) {
    if (!upgrades.unlocked(id)) return 'locked';
    if (upgrades.maxed(id)) return 'maxed';
    if (upgrades.canBuy(id)) return 'available';
    return upgrades.level(id) > 0 ? 'owned' : 'short';
  }

  /**
   * @typedef {Object} TreeNode
   * @property {string} id
   * @property {Object} row        the upgrade row itself (name, desc, your own fields)
   * @property {number} column     0-based, from the row's `col`
   * @property {number} tier       0-based, from the row's `row` (0 is the top of the tree)
   * @property {number} level      levels owned
   * @property {number} cost       price of the next level
   * @property {NodeStatus} status
   *
   * @typedef {Object} TreeEdge
   * @property {string} from       id of the prerequisite
   * @property {string} to         id of the node that needs it
   * @property {boolean} isActive  the prerequisite is owned, so this link is "lit"
   *
   * @typedef {Object} TreeLayout
   * @property {number} columns    how many columns the tree spans
   * @property {number} tiers      how many tiers the tree spans
   * @property {TreeNode[]} nodes  in table order
   * @property {TreeEdge[]} edges  one per (prerequisite, node) pair
   */

  /**
   * Reads a skill tree out of a Kit.upgrades model. The tree is data: each row says where it sits (`row`, `col`) and
   * what it needs (`requires`), and this turns that into everything a view has to draw.
   * @param {Object} upgrades  a Kit.upgrades model whose rows all carry integer `row` and `col`
   * @returns {TreeLayout}
   * @throws {Error} naming the first row without a position
   * @example
   * const TREE = [{ id: 'edge', row: 0, col: 0, cost: 2 }, { id: 'reap', row: 1, col: 0, cost: 5, requires: ['edge'] }];
   * Kit.craft.treeLayout(Kit.upgrades(TREE)).edges; // [{ from: 'edge', to: 'reap', isActive: false }]
   * @complexity O(rows + edges) time and space per call.
   */
  function treeLayout(upgrades) {
    const nodes = upgrades.table.map((row) => {
      if (!Number.isInteger(row.row) || !Number.isInteger(row.col)) {
        throw new Error(`Kit.craft.treeLayout: row "${row.id}" needs integer row and col fields to be placed`);
      }
      return { id: row.id, row, column: row.col, tier: row.row, level: upgrades.level(row.id), cost: upgrades.cost(row.id), status: nodeStatus(upgrades, row.id) };
    });
    const edges = upgrades.table.flatMap((row) =>
      [].concat(row.requires || []).map((requiredId) => ({ from: requiredId, to: row.id, isActive: upgrades.level(requiredId) > 0 }))
    );
    const spanOf = (key) => nodes.reduce((widest, node) => Math.max(widest, node[key] + 1), 0);
    return { columns: spanOf('column'), tiers: spanOf('tier'), nodes, edges };
  }

  /** How many rows of a reel pass the window before it stops, when the caller does not say. */
  const DEFAULT_REEL_LENGTH = 24;
  /** Rows shown after the winner, so the row below the window's centre is never empty when the reel stops. */
  const REEL_TAIL = 2;

  /**
   * Builds the strip a slot-style reel scrolls through. The outcome is decided before the animation: the strip is
   * weighted filler (so likely entries flash by more often, which reads as honest odds) with the winner at `landIndex`.
   * @param {Object[]} entries   the weighted table; rows may carry `weight` (default 1)
   * @param {Object} winner      the entry the reel must stop on (one of `entries`)
   * @param {{ length?: number, rng?: Object }} [options]  length: rows before the winner; rng: a Kit.rng (default: a fresh one)
   * @returns {{ strip: Object[], landIndex: number }} strip[landIndex] === winner
   * @throws {Error} when `winner` is not one of `entries`
   * @example const { strip, landIndex } = Kit.craft.reel(pool, rng.weighted(pool), { length: 20, rng });
   */
  function reel(entries, winner, options = {}) {
    if (!entries.includes(winner)) throw new Error('Kit.craft.reel: the winner must be one of the entries');
    const length = options.length === undefined ? DEFAULT_REEL_LENGTH : options.length;
    const rng = options.rng || Kit.rng();
    const fill = (count) => Array.from({ length: count }, () => rng.weighted(entries));
    return { strip: [...fill(length), winner, ...fill(REEL_TAIL)], landIndex: length };
  }

  /**
   * A chance roll with a floor: after `limit` misses in a row the next roll always hits. Makes "a drop within the
   * first few kills" a guarantee instead of a hope, without touching the drop rates.
   * @param {number} limit  most consecutive misses allowed (0 means every roll hits)
   * @returns {{ roll: (chance: number, rng: Object) => boolean, misses: () => number }} roll: chance is 0..1, rng a Kit.rng
   * @example const dropPity = Kit.craft.pity(3); if (dropPity.roll(zombie.dropChance, rng)) spawnDrop();
   */
  function pity(limit) {
    let misses = 0;
    return {
      roll(chance, rng) {
        // The rng is always consumed, so adding or removing the guarantee does not shift later rolls of a seeded run.
        const isHit = rng.chance(chance) || misses >= limit;
        misses = isHit ? 0 : misses + 1;
        return isHit;
      },
      misses: () => misses,
    };
  }

  /** Plain deltas print with one decimal place: values are multiplied by this, rounded, and divided again. */
  const ONE_DECIMAL = 10;
  /** Deltas smaller than this are rounding noise and print as nothing. */
  const NEGLIGIBLE_DELTA = 0.005;

  /**
   * Turns stat deltas into lines a player can judge at a glance.
   * @param {Record<string, number>} deltas   stat name -> change (what Kit.inventory.compare returns)
   * @param {Object} [options]
   * @param {Record<string, string>} [options.labels]  stat name -> display name (default: the stat name)
   * @param {string[]} [options.percent]       stats that are fractions or multipliers: 0.12 prints as "12%"
   * @param {string[]} [options.lowerIsBetter] stats where a drop is good news (cooldowns, costs)
   * @returns {{ stat: string, text: string, isBetter: boolean }[]} one line per stat that really changes
   * @example Kit.craft.compareLines({ damage: 2.5, cooldown: -0.4 }, { lowerIsBetter: ['cooldown'] })
   *          // [{ stat: 'damage', text: '+2.5 damage', isBetter: true }, { stat: 'cooldown', text: '-0.4 cooldown', isBetter: true }]
   * @complexity O(stats in `deltas`).
   */
  function compareLines(deltas, options = {}) {
    const { labels = {}, percent = [], lowerIsBetter = [] } = options;
    return Object.keys(deltas)
      .filter((stat) => Math.abs(deltas[stat]) >= NEGLIGIBLE_DELTA)
      .map((stat) => {
        const delta = deltas[stat];
        const amount = percent.includes(stat) ? `${Math.round(Math.abs(delta) * 100)}%` : String(Math.round(Math.abs(delta) * ONE_DECIMAL) / ONE_DECIMAL);
        return { stat, text: `${delta > 0 ? '+' : '-'}${amount} ${labels[stat] || stat}`, isBetter: delta > 0 !== lowerIsBetter.includes(stat) };
      });
  }

  /**
   * Adds one more affix to an item that was already rolled, returning a new item (the original is not changed). The
   * affix's mods merge into the item's, its `prefix` or `suffix` joins the name, and any `flags` it carries are copied
   * onto the item so views and rules can tell ("cursed", "socketed").
   * @param {Object} item      a Kit.loot item
   * @param {Object} affix     { id, mods, prefix?, suffix?, flags? } - mods may mix bonuses and drawbacks
   * @param {number} [strength=1]  scales the affix's mods (Kit.stats.power), e.g. the loot generator's power at the item's level
   * @returns {Object} the augmented item, with the same uid
   * @example const cursed = Kit.loot.augment(item, { id: 'hollow', prefix: 'Hollow', flags: { isCursed: true }, mods: { damage: { mul: 1.6 }, maxHp: { add: -30 } } });
   */
  function augment(item, affix, strength = 1) {
    return {
      ...item,
      ...affix.flags,
      affixes: [...item.affixes, affix.id],
      name: [affix.prefix, item.name, affix.suffix].filter(Boolean).join(' '),
      mods: Kit.stats.merge([item.mods, Kit.stats.power(affix.mods, strength)]),
    };
  }

  Kit.craft = { nodeStatus, treeLayout, reel, pity, compareLines };
  Kit.loot.augment = augment;
})();
