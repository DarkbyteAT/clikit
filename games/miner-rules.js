/**
 * Core Miner rules: every table, curve and rule of the game's economy and progression, with no DOM and no THREE, so the
 * same code runs in the page (games/miner.js draws it) and in node (scratch/miner/sim.js plays it for hours with bots,
 * tools/test-kit.js checks its edges). Exposed as the global CORE_MINER_RULES.
 *
 * Owns: ore stats by depth, heat and overheating, weak-point and strike damage, shafts, biomes, upgrades, the forge
 *       (ore chunks -> alloy gear -> tag synergies), prestige and its tree, achievements and relics, and `createModel`,
 *       which wires the kit's models (wallet, stats, upgrades, inventory, synergy, profile) into one saved game.
 * Does not own: anything drawn, heard or tapped, real time (callers pass seconds in), or the kit models themselves.
 *
 * DEPTH PLAN (AGENTS.md principle 5)
 *   Seconds - mastery. (1) A weak point glows on the ore and moves; striking it multiplies the hit (WEAK_POINT), so aim
 *     beats mashing. (2) Fast tapping builds heat, which multiplies tap damage, but a full bar overheats the pick: heat
 *     is lost and taps are feeble while it vents (HEAT). The best play rides just under the top. Both are measured: the
 *     simulation's skilled bot (aims, eases off before overheating) out-damages the masher with the same upgrades.
 *   Minutes - decisions. (1) After every core the shaft forks (SHAFTS): richer but tougher, drill-friendly but
 *     tap-hostile, a gallery that doubles weak-point hits and halves drills, a gas pocket that doubles heat. Which is
 *     right depends on the build and on skill. (2) Ores drop chunks of their tier; two tiers alloy into gear (GEAR), one
 *     piece per slot (kept through collapses, swapped freely), and gear tags form set bonuses (SYNERGIES through Kit.synergy): a spark / ember tap build, a bore
 *     drill crew, a lode income build. (3) Coins go to power now (Pick, Drill, Luck) or to income later (Cart).
 *   Hours - the long arc. (1) Biomes change the rules, not just the numbers (BIOMES): living rock regrows, so burst and
 *     drills matter; magma keeps the pick warm, so overheating is a constant risk. (2) Collapsing the shaft (PRESTIGE)
 *     resets coins, upgrades and depth for shards, spent in a three-branch tree (TREE) that cannot all be afforded early: Striker,
 *     Foreman or Prospector. (3) Achievements (Kit.profile) unlock relics (RELICS), permanent and some rule-changing
 *     (a third shaft at each fork).
 *   What unlocks when is measured, not asserted: see scratch/miner/sim.js and its report.
 *
 * Not built (said plainly): timed strikes, drill types as separate units (gear bits stand in), a separate smelting
 * step (an alloy is the two-ore recipe of a gear piece), random cave events and offline earnings.
 */
(() => {
  const { clamp } = Kit.math;
  const formatNumber = Kit.fmt;

  // ---- ORES AND DEPTH ---------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} OreTier
   * @property {string} id     also the wallet currency its chunks are counted in
   * @property {string} name   shown on the plaque, in toasts and in forge prices
   * @property {number} color  0xRRGGBB of the faceted rock body
   * @property {number} glow   0xRRGGBB of the gem facets, crystals, cracks and the light the ore casts
   */

  /** Ore tiers, shallowest first. @type {OreTier[] & { byId: function(string): OreTier }} */
  const ORE_TIERS = Kit.table([
    { id: 'copper', name: 'Copper', color: 0xb8501f, glow: 0xff8f3a },
    { id: 'silver', name: 'Silver', color: 0x4674b8, glow: 0xa8e4ff },
    { id: 'gold', name: 'Gold', color: 0xd99a1c, glow: 0xffe066 },
    { id: 'emerald', name: 'Emerald', color: 0x1f9e63, glow: 0x5dffae },
    { id: 'ruby', name: 'Ruby', color: 0xb3243f, glow: 0xff6a7d },
    { id: 'void', name: 'Void crystal', color: 0x6b3fd1, glow: 0xc79bff },
  ]);

  /** Cores: every `every`-th ore is tougher and richer, drops more chunks and is followed by a fork in the shaft. */
  const CORE = { every: 5, hpTimes: 3, valueTimes: 4, chunks: 3 };

  /**
   * What an ore is at a depth. `tiersFound` is read by depth (1 = the first ore): how many tiers of ORE_TIERS occur by
   * then. `hp` and `value` are read by strata below the first (depth - 1), so the bases are the first ore's numbers, and
   * the periodic wrapper makes every CORE.every-th ore a core. HP grows faster than value: each stratum costs a little
   * more play than the last, which is the wall a collapse (PRESTIGE) then resets with a stronger miner.
   */
  const DEPTH_CURVES = {
    tiersFound: { steps: [[1, 1], [4, 2], [7, 3], [10, 4], [13, 5], [16, 6]] },
    hp: { of: { base: 10, growth: 1.6 }, every: CORE.every, times: CORE.hpTimes, offset: 1 },
    value: { of: { base: 12, growth: 1.42 }, every: CORE.every, times: CORE.valueTimes, offset: 1 },
  };

  // ---- STATS ------------------------------------------------------------------------------------------------------------------

  /**
   * Every number upgrades, gear, synergies, the tree and relics can change, with its value on a fresh save.
   * damage: per tap. dps: drills, per second. crit: chance 0..1. critMult / weakMult: multipliers of a crit / a weak-point
   * hit. heatBonus: extra tap damage at full heat (1 = +100%). value / chunks / shards: payout multipliers. weakSize:
   * multiplier of the weak point's radius. ventSeconds: how long an overheated pick is feeble. coreHp: multiplier of core
   * HP. shaftOffers: shafts shown at a fork. startDepth: where a run begins.
   */
  const BASE_STATS = { damage: 1, dps: 0, crit: 0.08, critMult: 4, weakMult: 2.5, heatBonus: 0.6, value: 1, chunks: 1, shards: 1, weakSize: 1, ventSeconds: 2.5, coreHp: 1, shaftOffers: 2, startDepth: 1 };
  /** A chance can never leave 0..1, and a vent can never become instant, however modifiers stack. */
  const STAT_LIMITS = { crit: [0, 1], ventSeconds: [0.5, Infinity], coreHp: [0.25, 1] };

  // ---- SECONDS: HEAT AND THE WEAK POINT ---------------------------------------------------------------------------------------

  /** Heat: quick taps warm the pick (0..1) and warm taps hit harder, but reaching 1 overheats it. */
  const HEAT = {
    comboWindow: 0.45, // seconds between taps that still count as one combo
    perTap: 0.085, // heat gained by each combo tap: about 3.5 taps a second holds it level, faster climbs
    decayPerSecond: 0.28,
    ventDamage: 0.4, // tap damage multiplier while the pick vents
    hotAbove: 0.6, // HUD cue: damage numbers and the gauge turn orange above this
    dangerAbove: 0.85, // HUD cue: the gauge turns red; the next few taps will overheat
  };

  /** The weak point: a glowing spot on the ore's face that relocates when struck or after `seconds`. */
  const WEAK_POINT = {
    radius: 0.62, // world units at weakSize 1; the ore's radius is 2.9
    seconds: 3.2, // how long it stays put if nobody hits it
    reach: 0.55, // it sits within this fraction of the ore's radius from the centre, so it is always on the front face
  };

  /** Crack stages: as HP falls the ore opens a fissure, sheds crystals and pays out a little, so a long ore still rewards. */
  const CRACKS = { stages: 3, payoutShare: 0.1 };

  // ---- MINUTES: UPGRADES, SHAFTS, GEAR AND SYNERGIES --------------------------------------------------------------------------

  /**
   * @typedef {Object} MinerUpgradeRow  A Kit.upgrades row plus what the shop card and purchase feedback need.
   * @property {string} id
   * @property {string} name
   * @property {string} color            CSS colour of the card's name and the purchase ring
   * @property {Object} cost             Kit.curve spec by current level
   * @property {number} [max]            highest level
   * @property {Object} mods             per-level Kit.stats modifiers
   * @property {string} stat             the stat this row is read by on its card
   * @property {function(number): string} formatStat  that stat as text, e.g. "12 dmg"
   * @property {function(number, number): string} formatGain  what one more level adds, from (current, next) stat values
   * @property {string} boughtText       floater on the first purchase
   * @property {[string, number]} buySound  Kit.sfx preset and pitch played on purchase
   */

  const percent = (fraction) => Math.round(fraction * 100) + '%';

  /** Coin upgrades. Pick, Drill and Luck are power now; Cart is income later (the "invest" choice). @type {MinerUpgradeRow[]} */
  const UPGRADES = [
    { id: 'pick', name: 'Pick', color: '#ffc145', cost: { base: 10, growth: 1.6 }, mods: { damage: { add: 1, mul: 1.12 } }, stat: 'damage', formatStat: (value) => formatNumber(value) + ' dmg', formatGain: (current, next) => '+' + formatNumber(next - current) + ' dmg', boughtText: 'Harder hits', buySound: ['up', 1] },
    { id: 'drill', name: 'Drill', color: '#4de2c5', cost: { base: 25, growth: 1.7 }, mods: { dps: { add: 1.5, mul: 1.15 } }, stat: 'dps', formatStat: (value) => formatNumber(value) + '/s', formatGain: (current, next) => '+' + formatNumber(next - current) + '/s', boughtText: 'Drill online', buySound: ['up', 0.8] },
    { id: 'luck', name: 'Luck', color: '#ff7a9c', cost: { base: 40, growth: 1.8 }, max: 8, mods: { crit: { add: 0.06 } }, stat: 'crit', formatStat: (value) => percent(value) + ' crit', formatGain: (current, next) => '+' + percent(next - current) + ' crit', boughtText: 'Next hit crits', buySound: ['up', 1.25] },
    { id: 'cart', name: 'Cart', color: '#b9e86a', cost: { base: 30, growth: 1.75 }, mods: { value: { mul: 1.15 } }, stat: 'value', formatStat: (value) => percent(value) + ' pay', formatGain: (current, next) => '+' + percent(next - current) + ' pay', boughtText: 'Ore pays more', buySound: ['up', 0.65] },
  ];

  /** First-session goals (Kit.goals rows); `reward` is coins. */
  const GOALS = [
    { id: 'ores', text: 'Break ores', event: 'ore', target: 3, reward: 15 },
    { id: 'weak', text: 'Hit the weak point', event: 'weak', target: 5, reward: 20 },
    { id: 'drill', text: 'Hire a drill', event: 'buy', when: (row) => row.id === 'drill', reward: 30 },
    { id: 'core', text: 'Crack a core', event: 'core', reward: 100 },
  ];

  /**
   * @typedef {Object} ShaftRow  The rules of the strata between two forks. Every multiplier defaults to 1.
   * @property {string} id
   * @property {string} name
   * @property {string} desc       the trade-off in one line, shown at the fork
   * @property {string} color      CSS colour of its card at the fork
   * @property {number} [hp]       ore HP
   * @property {number} [value]    coin payout
   * @property {number} [tap]      tap damage
   * @property {number} [drill]    drill damage
   * @property {number} [weak]     extra multiplier on weak-point hits
   * @property {number} [chunks]   ore chunks dropped
   * @property {number} [heatGain] heat per tap (0 = no heat at all in this shaft)
   */

  /** Shafts offered at a fork. No row is strictly better: each pays for its gift somewhere a build may or may not mind. */
  const SHAFTS = Kit.table([
    { id: 'main', name: 'Main shaft', desc: 'Steady rock. No surprises.', color: '#d0ad7c' },
    { id: 'rich', name: 'Rich seam', desc: 'Ore pays 70% more and is 60% tougher.', color: '#ffc145', value: 1.7, hp: 1.6 },
    { id: 'ironstone', name: 'Ironstone drift', desc: 'Taps -40%, drills +50%, double ore chunks.', color: '#9fb4c8', tap: 0.6, drill: 1.5, chunks: 2 },
    { id: 'gallery', name: 'Crystal gallery', desc: 'Weak-point hits count double. Drills -50%.', color: '#c084fc', weak: 2, drill: 0.5 },
    { id: 'gas', name: 'Gas pocket', desc: 'Heat builds twice as fast. Ore pays 25% more.', color: '#ff8f3a', heatGain: 2, value: 1.25 },
    { id: 'flooded', name: 'Flooded drift', desc: 'Soft ore (-35% HP, -25% pay). No heat at all.', color: '#4de2c5', hp: 0.65, value: 0.75, heatGain: 0 },
  ]);
  const STARTING_SHAFT = 'main';

  /** Reads a shaft multiplier with its default of 1. */
  const shaftFactor = (shaft, name) => (shaft[name] === undefined ? 1 : shaft[name]);

  /**
   * @typedef {Object} GearRow  A forged piece: one may be worn per slot. Shaped as a Kit.inventory item (uid, slot, mods).
   * @property {string} uid
   * @property {'head'|'bit'|'charm'} slot
   * @property {string} name
   * @property {string} alloy                 the alloy's name, e.g. 'Bronze'
   * @property {Object<string, number>} cost  ore chunks by tier id: the alloy's recipe
   * @property {string[]} tags                what Kit.synergy counts
   * @property {Object} mods                  Kit.stats modifiers while worn
   * @property {string} desc                  what it does, in a few words
   */

  /** Slot ids and their display names. */
  const GEAR_SLOTS = { head: 'Pick head', bit: 'Drill bit', charm: 'Charm' };

  /** Forge recipes. Tags: spark (crits), ember (heat and weak point), bore (drills), lode (income). @type {GearRow[]} */
  const GEAR = Kit.table([
    { uid: 'bronze-head', slot: 'head', name: 'Bronze head', alloy: 'Bronze', cost: { copper: 6, silver: 2 }, tags: ['spark'], mods: { damage: { mul: 1.4 } }, desc: 'Taps +40%' },
    { uid: 'electrum-head', slot: 'head', name: 'Electrum head', alloy: 'Electrum', cost: { silver: 14, gold: 8 }, tags: ['lode'], mods: { damage: { mul: 1.15 }, value: { mul: 1.3 } }, desc: 'Taps +15%, pay +30%' },
    { uid: 'rubysteel-head', slot: 'head', name: 'Rubysteel head', alloy: 'Rubysteel', cost: { emerald: 20, ruby: 14 }, tags: ['ember', 'spark'], mods: { damage: { mul: 1.5 }, heatBonus: { add: 0.6 } }, desc: 'Taps +50%, heat bonus +60%' },
    { uid: 'bronze-bit', slot: 'bit', name: 'Bronze bit', alloy: 'Bronze', cost: { copper: 8, silver: 3 }, tags: ['bore'], mods: { dps: { mul: 1.5 } }, desc: 'Drills +50%' },
    { uid: 'goldleaf-bit', slot: 'bit', name: 'Goldleaf bit', alloy: 'Rose gold', cost: { gold: 12, copper: 16 }, tags: ['lode', 'bore'], mods: { dps: { mul: 1.25 }, chunks: { mul: 2 } }, desc: 'Drills +25%, double chunks' },
    { uid: 'emerald-bit', slot: 'bit', name: 'Emerald bit', alloy: 'Voidsteel', cost: { emerald: 18, void: 10 }, tags: ['bore', 'ember'], mods: { dps: { mul: 2.4 } }, desc: 'Drills +140%' },
    { uid: 'rivet', slot: 'charm', name: 'Lucky rivet', alloy: 'Copper', cost: { copper: 10 }, tags: ['spark'], mods: { crit: { add: 0.06 } }, desc: 'Crit +6%' },
    { uid: 'lamp', slot: 'charm', name: 'Silver lamp', alloy: 'Sterling', cost: { silver: 10, copper: 6 }, tags: ['ember'], mods: { weakMult: { add: 1 } }, desc: 'Weak-point hits +1x' },
    { uid: 'whistle', slot: 'charm', name: 'Foreman whistle', alloy: 'Electrum', cost: { silver: 12, gold: 10 }, tags: ['bore'], mods: { dps: { mul: 1.35 } }, desc: 'Drills +35%' },
    { uid: 'idol', slot: 'charm', name: 'Gold idol', alloy: 'Greengold', cost: { gold: 16, emerald: 12 }, tags: ['lode'], mods: { value: { mul: 1.3 } }, desc: 'Pay +30%' },
  ].map((row) => ({ ...row, id: row.uid })));

  /** Set bonuses over the tags of worn gear (Kit.synergy rows). Two matching tags need two slots, so a set is a commitment. */
  const SYNERGIES = [
    { id: 'sparks', name: 'Sparks fly', needs: { spark: 2 }, mods: { critMult: { add: 2 } }, desc: 'Crits hit +2x harder' },
    { id: 'furnace', name: 'Furnace hands', needs: { ember: 2 }, mods: { heatBonus: { add: 0.5 }, ventSeconds: { mul: 0.6 } }, desc: 'Heat bonus +50%, vents 40% faster' },
    { id: 'crew', name: 'Night crew', needs: { bore: 2 }, mods: { dps: { mul: 1.6 } }, desc: 'Drills +60%' },
    { id: 'motherlode', name: 'Motherlode', needs: { lode: 2 }, mods: { value: { mul: 1.35 } }, desc: 'Pay +35%' },
    { id: 'forgelit', name: 'Forge-lit', needs: { spark: 1, ember: 1 }, mods: { weakMult: { add: 0.75 } }, desc: 'Weak-point hits +0.75x' },
  ];

  // ---- HOURS: BIOMES, PRESTIGE, THE TREE, RELICS ------------------------------------------------------------------------------

  /**
   * @typedef {Object} BiomeRow
   * @property {string} id
   * @property {string} name
   * @property {number} fromDepth        first depth of the biome
   * @property {string} rule             its rule in one line (toast and plaque)
   * @property {number} regenPerSecond   share of max HP an ore regrows each second
   * @property {number} heatFloor        heat never cools below this
   * @property {number} drill            drill damage multiplier
   * @property {number[]} sky            [top, bottom] 0xRRGGBB of the backdrop
   */

  /** Biomes by depth, shallowest first. Each adds a rule that interacts with heat, drills or burst. @type {BiomeRow[]} */
  const BIOMES = [
    { id: 'timber', name: 'Timber shaft', fromDepth: 1, rule: 'Sound rock', regenPerSecond: 0, heatFloor: 0, drill: 1, sky: [0x1b1436, 0x070510] },
    { id: 'hollows', name: 'Living hollows', fromDepth: 21, rule: 'Living rock regrows: keep hitting', regenPerSecond: 0.006, heatFloor: 0, drill: 1, sky: [0x0f2a2a, 0x04100f] },
    { id: 'magma', name: 'Magma vents', fromDepth: 41, rule: 'Always warm: easy to overheat. Drills soften', regenPerSecond: 0.003, heatFloor: 0.45, drill: 0.75, sky: [0x3a1206, 0x100402] },
  ];

  /**
   * Collapsing the shaft: allowed from `minDepth`, where it yields one shard; every `perStrata` deeper is worth more than
   * the last: shards = floor(((deepest - minDepth) / perStrata + 1) ^ power x the shards stat).
   */
  const PRESTIGE = { minDepth: 12, perStrata: 4, power: 1.2 };
  /** A run that starts below depth 1 (the tree's Head start) begins with this share of the coins the skipped ores would have paid. */
  const HEAD_START = { payShare: 0.6 };

  /**
   * The shard tree (Kit.upgrades rows with `requires`; `row` / `col` place them for Kit.views.tree). Three branches, and early
   * shards cover one of them: Striker rewards skilled tapping, Foreman idle drilling, Prospector income and faster reruns.
   */
  const TREE_HEADS = ['Striker', 'Foreman', 'Prospector'];
  const TREE = [
    { id: 'tempered', name: 'Tempered steel', col: 0, row: 0, max: 8, cost: { base: 1, growth: 1.7 }, mods: { damage: { mul: 1.5 } }, desc: 'Taps +50% per level' },
    { id: 'keen-eye', name: 'Keen eye', col: 0, row: 1, max: 4, requires: 'tempered', cost: { base: 3, growth: 2.2 }, mods: { weakSize: { mul: 1.2 }, weakMult: { add: 0.5 } }, desc: 'Bigger weak point, +0.5x on it' },
    { id: 'cool-hand', name: 'Cool hand', col: 0, row: 2, max: 3, requires: 'keen-eye', cost: { base: 8, growth: 2.5 }, mods: { ventSeconds: { mul: 0.7 }, heatBonus: { add: 0.4 } }, desc: 'Vents 30% faster, heat bonus +40%' },
    { id: 'crew', name: 'Seasoned crew', col: 1, row: 0, max: 8, cost: { base: 1, growth: 1.7 }, mods: { dps: { mul: 1.6 } }, desc: 'Drills +60% per level' },
    { id: 'standing-crew', name: 'Standing crew', col: 1, row: 1, max: 4, requires: 'crew', cost: { base: 3, growth: 2.2 }, mods: { dps: { add: 4 } }, desc: 'A drill from the first second' },
    { id: 'blast-caps', name: 'Blast caps', col: 1, row: 2, max: 3, requires: 'standing-crew', cost: { base: 8, growth: 2.5 }, mods: { coreHp: { mul: 0.8 } }, desc: 'Cores have 20% less HP' },
    { id: 'assay', name: 'Assay office', col: 2, row: 0, max: 8, cost: { base: 1, growth: 1.7 }, mods: { value: { mul: 1.4 } }, desc: 'Pay +40% per level' },
    { id: 'head-start', name: 'Head start', col: 2, row: 1, max: 4, requires: 'assay', cost: { base: 3, growth: 2.2 }, mods: { startDepth: { add: 4 } }, desc: 'Begin 4 strata deeper, with coins' },
    { id: 'shard-sense', name: 'Shard sense', col: 2, row: 2, max: 3, requires: 'head-start', cost: { base: 8, growth: 2.5 }, mods: { shards: { mul: 1.25 } }, desc: 'Collapses yield +25% shards' },
  ].map((row) => ({ ...row, currency: 'shards' }));

  /**
   * @typedef {Object} RelicRow  A permanent keepsake, unlocked by an achievement and active from then on.
   * @property {string} id
   * @property {string} name
   * @property {Object} mods  Kit.stats modifiers
   * @property {string} desc
   */

  /** @type {RelicRow[] & { byId: function(string): RelicRow }} */
  const RELICS = Kit.table([
    { id: 'canary', name: 'Brass canary', mods: { value: { mul: 1.15 } }, desc: 'Pay +15%' },
    { id: 'loupe', name: "Jeweller's loupe", mods: { weakMult: { add: 0.5 } }, desc: 'Weak-point hits +0.5x' },
    { id: 'fuse', name: 'Slow fuse', mods: { coreHp: { mul: 0.85 } }, desc: 'Cores have 15% less HP' },
    { id: 'old-drill', name: 'Grandfather drill', mods: { dps: { mul: 1.3 } }, desc: 'Drills +30%' },
    { id: 'map', name: "Surveyor's map", mods: { shaftOffers: { add: 1 } }, desc: 'A third shaft at every fork' },
    { id: 'lodestone', name: 'Lodestone', mods: { chunks: { mul: 2 } }, desc: 'Double ore chunks' },
    { id: 'ember-heart', name: 'Ember heart', mods: { heatBonus: { add: 0.4 } }, desc: 'Heat bonus +40%' },
    { id: 'void-shard', name: 'Void shard', mods: { damage: { mul: 1.5 }, dps: { mul: 1.5 } }, desc: 'Taps and drills +50%' },
  ]);

  /** Lifetime achievements (Kit.profile rows). `stat` names are the ones the model counts; each unlocks a relic. */
  const ACHIEVEMENTS = [
    { id: 'ores-100', text: 'Break 100 ores', stat: 'ores', target: 100, unlocks: 'canary' },
    { id: 'weak-150', text: 'Land 150 weak-point hits', stat: 'weakHits', target: 150, unlocks: 'loupe' },
    { id: 'cores-10', text: 'Crack 10 cores', stat: 'cores', target: 10, unlocks: 'fuse' },
    { id: 'depth-20', text: 'Reach depth 20', stat: 'deepest', target: 20, unlocks: 'old-drill' },
    { id: 'collapse-1', text: 'Collapse the shaft', stat: 'prestiges', target: 1, unlocks: 'map' },
    { id: 'gear-5', text: 'Forge 5 pieces of gear', stat: 'forged', target: 5, unlocks: 'lodestone' },
    { id: 'depth-35', text: 'Reach depth 35', stat: 'deepest', target: 35, unlocks: 'ember-heart' },
    { id: 'depth-45', text: 'Reach depth 45', stat: 'deepest', target: 45, unlocks: 'void-shard' },
  ];

  // ---- PURE RULES (plain data in, plain data out) -----------------------------------------------------------------------------

  /**
   * @typedef {Object} OreSpec
   * @property {number} depth
   * @property {OreTier} tier
   * @property {boolean} isCore     every CORE.every-th depth
   * @property {boolean} isNewTier  first ore of its tier (announced with a toast)
   * @property {number} hp          whole hit points, after the shaft's and the build's multipliers
   * @property {number} value       whole coins before the shaft's and the build's payout multipliers
   */

  /**
   * @typedef {Object} OreState  The ore being mined.
   * @property {OreSpec} spec
   * @property {number} hp          remaining hit points (may go below 0 on the killing blow)
   * @property {number} maxHp
   * @property {number} crackStage  fissures opened so far, 0..CRACKS.stages
   */

  /** @param {number} depth 1-based. @returns {boolean} */
  const isCoreDepth = (depth) => depth % CORE.every === 0;

  const tiersFoundAt = Kit.curve.of(DEPTH_CURVES.tiersFound);
  /** Depths at which a tier is met for the first time. */
  const TIER_DEBUT_DEPTHS = new Set(DEPTH_CURVES.tiersFound.steps.map(([depth]) => depth));

  /**
   * The tier of the ore at a depth. Once a tier has been found it keeps turning up: ordinary ores rotate through every
   * tier found so far (so the forge never runs dry of an early metal), while cores and a tier's debut depth are always
   * the newest tier.
   * @param {number} depth 1-based
   * @returns {OreTier}
   */
  const tierAt = (depth) => {
    const found = tiersFoundAt(depth);
    const isNewest = isCoreDepth(depth) || TIER_DEBUT_DEPTHS.has(depth);
    return ORE_TIERS[isNewest ? found - 1 : (depth - 1) % found];
  };
  const hpAt = Kit.curve.of(DEPTH_CURVES.hp);
  const valueAt = Kit.curve.of(DEPTH_CURVES.value);

  /**
   * The biome a depth lies in.
   * @param {number} depth 1-based
   * @returns {BiomeRow}
   * @complexity O(biomes)
   */
  const biomeAt = (depth) => BIOMES.reduce((found, biome) => (depth >= biome.fromDepth ? biome : found), BIOMES[0]);

  /**
   * The ore found at a depth.
   * @param {number} depth 1-based stratum number
   * @param {{ shaft?: ShaftRow, coreHp?: number }} [context]  the shaft being dug and the build's core-HP multiplier
   * @returns {OreSpec}
   * @example oreSpecAt(5).isCore // true; oreSpecAt(5, { shaft: SHAFTS.byId('rich') }).hp is 60% higher
   */
  const oreSpecAt = (depth, { shaft = SHAFTS.byId(STARTING_SHAFT), coreHp = 1 } = {}) => {
    const tier = tierAt(depth);
    const strataBelowFirst = depth - 1; // the hp / value curves start at the first ore
    const isCore = isCoreDepth(depth);
    return {
      depth,
      tier,
      isCore,
      // Depth 1 is a debut too, but the first ore of the game is not announced as a new vein.
      isNewTier: depth > 1 && TIER_DEBUT_DEPTHS.has(depth),
      hp: Math.ceil(hpAt(strataBelowFirst) * shaftFactor(shaft, 'hp') * (isCore ? coreHp : 1)),
      value: Math.ceil(valueAt(strataBelowFirst)),
    };
  };

  /** @param {OreSpec} spec @returns {OreState} a fresh, undamaged ore */
  const newOre = (spec) => ({ spec, hp: spec.hp, maxHp: spec.hp, crackStage: 0 });

  /**
   * How many fissures an ore shows at a share of its HP. The HP range is cut into stages + 1 equal bands: the first band is
   * intact, each later band opens one more fissure, so the last one appears with a quarter of the HP still to go.
   * @param {number} hpFraction remaining HP, 0..1
   * @returns {number} 0..CRACKS.stages
   */
  const crackStageAt = (hpFraction) => Math.min(CRACKS.stages, Math.floor((1 - hpFraction) * (CRACKS.stages + 1)));

  /**
   * An ore after taking damage. Crack stages only ever go up (regrowth does not close a fissure), and the killing blow
   * opens none (the ore shatters instead).
   * @param {OreState} ore
   * @param {number} amount
   * @returns {OreState}
   */
  const damageOre = (ore, amount) => {
    const hp = ore.hp - amount;
    const crackStage = hp <= 0 ? ore.crackStage : Math.max(ore.crackStage, crackStageAt(hp / ore.maxHp));
    return { ...ore, hp, crackStage };
  };

  /**
   * An ore after regrowing for `dt` seconds in a biome (never past its maximum).
   * @param {OreState} ore
   * @param {number} dt seconds
   * @param {BiomeRow} biome
   * @returns {OreState} the same object when the biome has no regrowth
   */
  const regrowOre = (ore, dt, biome) => (biome.regenPerSecond ? { ...ore, hp: Math.min(ore.maxHp, ore.hp + ore.maxHp * biome.regenPerSecond * dt) } : ore);

  /** @param {OreState} ore @returns {number} share of HP lost, 0..1 */
  const damageFraction = (ore) => clamp(1 - ore.hp / ore.maxHp);

  /**
   * What breaking an ore pays.
   * @param {OreSpec} spec
   * @param {ShaftRow} shaft
   * @param {{ value: number, chunks: number }} multipliers  the build's value and chunks stats
   * @returns {{ coins: number, chunks: number }} whole coins and whole chunks of the ore's tier
   */
  const payoutFor = (spec, shaft, multipliers) => ({
    coins: Math.ceil(spec.value * shaftFactor(shaft, 'value') * multipliers.value),
    chunks: Math.round((spec.isCore ? CORE.chunks : 1) * shaftFactor(shaft, 'chunks') * multipliers.chunks),
  });

  /** @param {number} coins the ore's full payout @returns {number} whole coins paid each time a crack stage opens */
  const crackPayout = (coins) => Math.ceil(coins * CRACKS.payoutShare);

  /**
   * @typedef {Object} HeatRule  How heat behaves where the player is digging.
   * @property {number} perTap  heat per combo tap (0 = heat is off)
   * @property {number} floor   heat never cools below this
   */

  /** @param {ShaftRow} shaft @param {BiomeRow} biome @returns {HeatRule} */
  const heatRuleFor = (shaft, biome) => {
    const gain = shaftFactor(shaft, 'heatGain');
    // A shaft with no heat (flooded) also drowns the biome's ambient warmth.
    return { perTap: HEAT.perTap * gain, floor: gain === 0 ? 0 : biome.heatFloor };
  };

  /**
   * @typedef {Object} TapStreak
   * @property {number} combo     taps in the current run of quick taps, not counting the first
   * @property {number} heat      0..1
   * @property {number} ventLeft  seconds of venting still to go (0 = the pick is usable at full strength)
   */

  /** @param {HeatRule} rule @returns {TapStreak} the streak at rest */
  const restingStreak = (rule) => ({ combo: 0, heat: rule.floor, ventLeft: 0 });

  /**
   * The streak after one more tap. A tap inside the combo window extends the combo and adds heat; a late tap restarts the
   * combo but keeps the heat that has not cooled. Reaching full heat overheats: heat drops to the floor and the pick vents.
   * @param {TapStreak} streak
   * @param {number} secondsSinceLastTap
   * @param {HeatRule} rule
   * @param {number} ventSeconds how long an overheat lasts (the ventSeconds stat)
   * @returns {TapStreak & { didOverheat: boolean }}
   */
  const extendStreak = (streak, secondsSinceLastTap, rule, ventSeconds) => {
    const isQuick = secondsSinceLastTap < HEAT.comboWindow;
    const heat = isQuick ? streak.heat + rule.perTap : streak.heat;
    if (heat >= 1) return { combo: 0, heat: rule.floor, ventLeft: ventSeconds, didOverheat: true };
    return { combo: isQuick ? streak.combo + 1 : 0, heat, ventLeft: streak.ventLeft, didOverheat: false };
  };

  /**
   * The streak after `dt` seconds without a tap landing: heat cools toward the floor and a vent runs down.
   * @param {TapStreak} streak
   * @param {number} dt seconds
   * @param {HeatRule} rule
   * @returns {TapStreak}
   */
  const coolStreak = (streak, dt, rule) => ({
    combo: streak.combo,
    heat: Math.max(rule.floor, streak.heat - HEAT.decayPerSecond * dt),
    ventLeft: Math.max(0, streak.ventLeft - dt),
  });

  /**
   * Damage of one pick strike.
   * @param {{ damage: number, critMult: number, weakMult: number, heatBonus: number }} power  current stat values
   * @param {{ heat: number, isVenting: boolean, isCrit: boolean, isWeak: boolean }} strike
   * @param {ShaftRow} shaft
   * @returns {number}
   */
  const strikeDamage = (power, strike, shaft) =>
    power.damage *
    shaftFactor(shaft, 'tap') *
    (strike.isVenting ? HEAT.ventDamage : 1 + strike.heat * power.heatBonus) *
    (strike.isCrit ? power.critMult : 1) *
    (strike.isWeak ? power.weakMult * shaftFactor(shaft, 'weak') : 1);

  /** @returns {number} the drill crew's damage per second where the player is digging */
  const drillDps = (dps, shaft, biome) => dps * shaftFactor(shaft, 'drill') * biome.drill;

  /**
   * Shards a collapse would yield.
   * @param {number} deepest the deepest depth reached this run
   * @param {number} shardsStat the shards multiplier stat
   * @returns {number} whole shards; 0 below PRESTIGE.minDepth
   * @example shardsFor(12, 1) // 1;  shardsFor(24, 1) // 5: floor(4 ^ 1.2)
   */
  const shardsFor = (deepest, shardsStat) =>
    deepest < PRESTIGE.minDepth ? 0 : Math.floor(Math.pow((deepest - PRESTIGE.minDepth) / PRESTIGE.perStrata + 1, PRESTIGE.power) * shardsStat);

  /**
   * Coins a run starts with when it begins below depth 1: a share of what the skipped ores would have paid, so a head
   * start never strands the player in front of an ore they cannot afford to fight.
   * @param {number} startDepth
   * @returns {number} whole coins (0 for a start at depth 1)
   * @complexity O(startDepth)
   */
  const headStartCoins = (startDepth) =>
    Math.floor(HEAD_START.payShare * Array.from({ length: startDepth - 1 }, (unused, index) => valueAt(index)).reduce((sum, value) => sum + value, 0));

  /**
   * The shafts shown at a fork: `count` different rows, in random order.
   * @param {number} count
   * @param {function(): number} random 0..1 source
   * @returns {ShaftRow[]}
   * @complexity O(shafts log shafts)
   */
  const offerShafts = (count, random) =>
    SHAFTS.map((shaft) => ({ shaft, order: random() }))
      .sort((left, right) => left.order - right.order)
      .slice(0, count)
      .map((entry) => entry.shaft);

  /**
   * @typedef {Object} UpgradeCardView
   * @property {string} effect   the card's effect line
   * @property {'maxed'|'ready'|'saving'} state
   * @property {number} progress 0..1 of the price already in the wallet
   */

  /**
   * What an upgrade card shows.
   * @param {MinerUpgradeRow} row
   * @param {{ isMaxed: boolean, canBuy: boolean, cost: number, coins: number, current: number, next: number }} facts
   *   current / next: the row's stat now and one level up
   * @returns {UpgradeCardView}
   */
  const describeUpgradeCard = (row, facts) => {
    if (facts.isMaxed) return { effect: row.formatStat(facts.current), state: 'maxed', progress: 1 };
    return {
      effect: row.formatGain(facts.current, facts.next),
      state: facts.canBuy ? 'ready' : 'saving',
      // A free upgrade (cost 0) is fully "saved for"; this also avoids dividing by zero.
      progress: facts.cost > 0 ? clamp(facts.coins / facts.cost) : 1,
    };
  };

  /** @param {OreSpec} spec @returns {string} e.g. "Silver core" */
  const oreTitle = (spec) => spec.tier.name + (spec.isCore ? ' core' : '');

  /** @param {OreState} ore @returns {string} e.g. "61 / 92" (never negative on the killing blow) */
  const formatOreHp = (ore) => formatNumber(Math.max(0, Math.ceil(ore.hp))) + ' / ' + formatNumber(ore.maxHp);

  /** @param {Object<string, number>} cost chunks by tier id @returns {string} e.g. "6 Copper + 2 Silver" */
  const formatRecipe = (cost) =>
    Object.keys(cost)
      .map((tierId) => cost[tierId] + ' ' + ORE_TIERS.byId(tierId).name)
      .join(' + ');

  // ---- THE MODEL: the kit's pieces wired into one saved game -------------------------------------------------------------------

  /**
   * @typedef {Object} RunState  What a collapse resets (saved under 'run').
   * @property {number} depth          the stratum being mined, 1-based
   * @property {number} deepest        the deepest stratum reached this run
   * @property {string} shaftId        the shaft being dug
   * @property {?string[]} forkOffers  shaft ids waiting for the player's choice, or null when there is no fork
   */

  /**
   * Creates the game's state and the operations on it. Everything a player can do that changes the economy goes through
   * here, so the page and the simulation cannot disagree about a rule.
   * @param {Object} [options]
   * @param {{ get: Function, set: Function }} [options.save]   persistence (ctx.save); omit for an in-memory game
   * @param {function(): number} [options.random]               0..1 source for shaft offers (default Math.random)
   * @param {function(Object): void} [options.onAchievement]    called with the achievement row when one completes
   * @param {function(Object, boolean): void} [options.onSynergy]  called when a set bonus switches on or off
   * @returns {Object} `{ wallet, stats, upgrades, tree, inventory, synergies, profile, run, shaft(), biome(),
   *   heatRule(), power(), spec(), payout(spec), payCrack(spec), drillDps(), breakOre(spec), chooseShaft(id), recordWeakHit(),
   *   gear: { isOwned, canCraft, craft, equip }, relics(), shardsOnCollapse(), canCollapse(), collapse() }`
   * @example
   * const model = CORE_MINER_RULES.createModel({ save: ctx.save });
   * const result = model.breakOre(model.spec());   // pays out, counts, moves one stratum down
   * if (result.fork) model.chooseShaft(result.fork[0].id);
   */
  function createModel({ save, random = Math.random, onAchievement, onSynergy } = {}) {
    const wallet = Kit.wallet({ coins: 0 }, save);
    const stats = Kit.stats(BASE_STATS, { limits: STAT_LIMITS });
    const upgrades = Kit.upgrades(UPGRADES, { stats, wallet, save });
    const tree = Kit.upgrades(TREE, { stats, wallet, save, key: 'tree' });
    const inventory = Kit.inventory({ slots: Object.keys(GEAR_SLOTS), stats, save, key: 'gear' });
    const synergies = Kit.synergy(SYNERGIES, { stats, onChange: onSynergy });

    /** Relics are plain stat sources: applying one twice just replaces it, so this is safe to call for saved unlocks. */
    const applyRelic = (relicId) => RELICS.has(relicId) && stats.mod('relic:' + relicId, RELICS.byId(relicId).mods);
    const profile = Kit.profile({ save, achievements: ACHIEVEMENTS, onAchievement, onUnlock: applyRelic });
    profile.unlocked().forEach(applyRelic);

    const wornGear = () => inventory.slots.map((slot) => inventory.equipped(slot)).filter(Boolean);
    const refreshSynergies = () => synergies.update(wornGear());
    refreshSynergies();

    /** @type {RunState} A save from before shafts existed only has `depth`; it resumes there in the main shaft. */
    const savedDepth = Math.max(1, save ? save.get('depth', 1) : 1);
    const run = { depth: savedDepth, deepest: savedDepth, shaftId: STARTING_SHAFT, forkOffers: null, ...(save ? save.get('run', {}) : {}) };
    const persistRun = () => save && save.set('run', run);

    const shaft = () => SHAFTS.byId(run.shaftId);
    const biome = () => biomeAt(run.depth);
    const payout = (spec) => payoutFor(spec, shaft(), { value: stats.get('value'), chunks: stats.get('chunks') });
    const shardsOnCollapse = () => shardsFor(run.deepest, stats.get('shards'));
    const isOwned = (uid) => wornGear().some((item) => item.uid === uid) || inventory.bag.some((item) => item.uid === uid);

    /** Puts the run back at its starting line (after a collapse): depth, shaft, coins for a head start. */
    const beginRun = () => {
      const startDepth = Math.round(stats.get('startDepth'));
      Object.assign(run, { depth: startDepth, deepest: startDepth, shaftId: STARTING_SHAFT, forkOffers: null });
      wallet.add(headStartCoins(startDepth));
      persistRun();
    };

    return {
      wallet,
      stats,
      upgrades,
      tree,
      inventory,
      synergies,
      profile,
      run,
      shaft,
      biome,
      heatRule: () => heatRuleFor(shaft(), biome()),
      /** The stat values a strike needs, read once per tap. */
      power: () => ({ damage: stats.get('damage'), critMult: stats.get('critMult'), weakMult: stats.get('weakMult'), heatBonus: stats.get('heatBonus') }),
      /** The ore at the current depth, in the current shaft, for the current build. @returns {OreSpec} */
      spec: () => oreSpecAt(run.depth, { shaft: shaft(), coreHp: stats.get('coreHp') }),
      payout,
      /** Pays one crack stage of an ore. @returns {number} the coins paid */
      payCrack(spec) {
        const coins = crackPayout(payout(spec).coins);
        wallet.add(coins);
        return coins;
      },
      drillDps: () => drillDps(stats.get('dps'), shaft(), biome()),
      /** Counts a weak-point hit toward the lifetime record. */
      recordWeakHit: () => profile.count('weakHits'),
      /**
       * The ore broke: pay out, count it, go one stratum down. A core is followed by a fork in the shaft.
       * @param {OreSpec} spec the ore that broke
       * @returns {{ payout: { coins: number, chunks: number }, fork: ?ShaftRow[], newBiome: ?BiomeRow }}
       *   fork: the shafts to choose from before the next ore (null when there is no fork); newBiome: set when the next
       *   stratum is the first of a biome
       */
      breakOre(spec) {
        const paid = payout(spec);
        const biomeBefore = biome();
        wallet.add(paid.coins);
        if (paid.chunks > 0) wallet.add(paid.chunks, spec.tier.id);
        run.depth += 1;
        run.deepest = Math.max(run.deepest, run.depth);
        run.forkOffers = spec.isCore ? offerShafts(Math.round(stats.get('shaftOffers')), random).map((row) => row.id) : null;
        persistRun();
        profile.count('ores');
        if (spec.isCore) profile.count('cores');
        profile.best('deepest', run.depth);
        return { payout: paid, fork: run.forkOffers && run.forkOffers.map(SHAFTS.byId), newBiome: biome() === biomeBefore ? null : biome() };
      },
      /** Takes one of the offered shafts; it lasts until the next core breaks. @throws {Error} when it was not offered */
      chooseShaft(shaftId) {
        if (!run.forkOffers || !run.forkOffers.includes(shaftId)) throw new Error(`Core Miner: shaft "${shaftId}" is not on offer (offers: ${run.forkOffers ? run.forkOffers.join(', ') : 'none, there is no fork'})`);
        run.shaftId = shaftId;
        run.forkOffers = null;
        persistRun();
      },
      gear: {
        isOwned,
        /** @returns {boolean} not yet forged and every chunk of the recipe is in the wallet */
        canCraft: (uid) => !isOwned(uid) && wallet.canAll(GEAR.byId(uid).cost),
        /** Forges a piece and puts it on. @returns {boolean} false (and nothing spent) when it cannot be forged */
        craft(uid) {
          if (isOwned(uid) || !wallet.spendAll(GEAR.byId(uid).cost)) return false;
          inventory.add(GEAR.byId(uid));
          inventory.equip(uid);
          refreshSynergies();
          profile.count('forged');
          return true;
        },
        /** Wears an owned piece; what was in its slot goes back to the bag. @returns {boolean} */
        equip(uid) {
          const didEquip = inventory.equip(uid);
          refreshSynergies();
          return didEquip;
        },
      },
      /** @returns {RelicRow[]} the relics unlocked so far */
      relics: () => RELICS.filter((relic) => profile.isUnlocked(relic.id)),
      shardsOnCollapse,
      canCollapse: () => shardsOnCollapse() > 0,
      /**
       * Collapses the shaft: banks the run's shards and resets what a run earns (coins, coin upgrades, depth, the shaft).
       * Shards, the tree, ore chunks, forged gear, relics and the lifetime record stay.
       * @returns {number} the shards gained (0 when the run is not deep enough, in which case nothing changes)
       */
      collapse() {
        const shards = shardsOnCollapse();
        if (!shards) return 0;
        profile.endRun({ depth: run.deepest, shards });
        wallet.spend(wallet.get());
        upgrades.reset();
        wallet.add(shards, 'shards');
        profile.count('prestiges');
        beginRun();
        return shards;
      },
    };
  }

  window.CORE_MINER_RULES = {
    ORE_TIERS, CORE, DEPTH_CURVES, BASE_STATS, STAT_LIMITS, HEAT, WEAK_POINT, CRACKS, UPGRADES, GOALS, SHAFTS, GEAR_SLOTS, GEAR, SYNERGIES,
    BIOMES, PRESTIGE, TREE, TREE_HEADS, RELICS, ACHIEVEMENTS,
    isCoreDepth, tierAt, biomeAt, oreSpecAt, newOre, crackStageAt, damageOre, regrowOre, damageFraction, payoutFor, crackPayout, heatRuleFor,
    restingStreak, extendStreak, coolStreak, strikeDamage, drillDps, shardsFor, headStartCoins, offerShafts, describeUpgradeCard,
    oreTitle, formatOreHp, formatRecipe, createModel,
  };
})();
