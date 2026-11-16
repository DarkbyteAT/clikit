// Soulwake data: every tunable of the game as plain tables and curves. Adding a zombie, power, fusion, tree node, item
// base, affix or curse means adding a row here.
//
// Owns: numbers, names, colours and descriptions. Does not own: behaviour (games/souls.js looks up strategies by the
// ids used here), the HUD look (games/souls-theme.js) or generic models (kit/). Exposed as the global SOULWAKE_DATA.
(() => {
  /** Whole-number percent for descriptions: 0.18 -> "18%". */
  const percent = (fraction) => `${Math.round(fraction * 100)}%`;

  // ---- hero ------------------------------------------------------------------------------------------------------

  /**
   * Base value of every stat the simulation reads (Kit.stats). Powers, fusions, tree nodes and worn items only ever
   * modify these, so a behaviour that does not exist yet is simply a stat at 0.
   */
  const HERO_STATS = {
    maxHp: 100, // health points
    regen: 0, // health per second
    armour: 0, // flat damage removed from every hit taken
    speed: 4.6, // world units per second
    damage: 6, // per weapon hit, before the weapon's power
    attackRate: 1, // multiplier on attacks per second
    reach: 1, // multiplier on the weapon's reach
    cleanseSpeed: 1, // multiplier on how fast a soul is cleansed
    soulGain: 1, // multiplier on soul points per cleanse
    lootLuck: 0, // shifts rarity rolls upward and raises drop chance (Kit.loot luck)
    absorbLuck: 0, // extra weight for rare powers on the absorb roll
    absorbNeed: 1, // multiplier on souls needed per absorb roll
    powerSlots: 4, // how many different powers can be held; once full, rolls only offer the powers already held
    cooldown: 6, // seconds between Ward Pulses (the tap ability)
    pulseRadius: 3, // world units
    pulseKnock: 5, // knockback speed given to zombies, units per second
    pulseDamage: 0, // damage of the pulse (0: it only shoves)
    dashRange: 0, // units dashed before the pulse (0: no dash)
    dashAcid: 0, // above 0: dashing through zombies burns them (Blightstep fusion)
    acidDamage: 0, // damage of the automatic acid bolt (0: none)
    bloomDamage: 0, // damage of the burst when a zombie you downed falls (0: none)
    slowAura: 0, // fraction of speed nearby zombies lose
    phaseTime: 0, // seconds of invulnerability after being hit (0: none)
    cleanseHeal: 0, // health restored per cleansed soul
    reapEvery: 0, // every Nth attack hits everything in reach (0: never)
    cleansePulse: 0, // above 0: every cleansed soul releases a free Ward Pulse
  };

  /** Display names for stats in item descriptions and compare lines. */
  const STAT_LABELS = {
    maxHp: 'Max health', regen: 'Health regen', armour: 'Armour', speed: 'Move speed', damage: 'Damage', attackRate: 'Attack speed',
    reach: 'Reach', cleanseSpeed: 'Cleanse speed', soulGain: 'Soul gain', lootLuck: 'Loot luck', absorbLuck: 'Absorb luck',
    cooldown: 'Pulse cooldown', pulseDamage: 'Pulse damage', pulseRadius: 'Pulse radius',
  };
  /** Stats compared in the inventory, the ones whose deltas print as percentages, and the ones where less is better. */
  const COMPARE = {
    stats: ['damage', 'attackRate', 'reach', 'maxHp', 'regen', 'armour', 'speed', 'cleanseSpeed', 'soulGain', 'lootLuck', 'absorbLuck', 'cooldown', 'pulseDamage'],
    percent: ['attackRate', 'reach', 'cleanseSpeed', 'soulGain', 'lootLuck', 'absorbLuck'],
    lowerIsBetter: ['cooldown'],
  };

  /** Tunables of the hero that are not stats. Distances in world units, times in seconds. */
  const HERO = {
    radius: 0.38, // collision circle
    dashSeconds: 0.16, // how long a Quickstep takes
    dashHitRadius: 1.2, // Blightstep burns zombies this close to the dash
    dashAcidPower: 2, // Blightstep damage, as a multiple of acidDamage
    pulseStun: 0.7, // zombies caught by a pulse stop for this long
    phaseCooldown: 8, // Veilwalk cannot trigger again for this long
    acidInterval: 2.4, // seconds between automatic acid bolts
    acidRange: 7,
    bloomRadius: 2.2,
    slowAuraRadius: 3.2,
    maxSlow: 0.6, // slows never stack past this fraction
    hurtGrace: 0.5, // invulnerability after any hit, so a crowd cannot delete the health bar in one frame
    pickupRadius: 1,
  };

  // ---- zombies ---------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} BodyPart  One mesh of a zombie's silhouette, in the zombie's own frame (y up, +z is its front).
   * @property {'box'|'ball'|'cone'} shape
   * @property {number[]} size   box: [width, height, depth]; ball: [radius]; cone: [radius, height]
   * @property {number[]} at     [x, y, z] of the part's centre
   * @property {number} color    0xRRGGBB
   * @property {number} [opacity] below 1 for see-through parts (the wraith)
   *
   * @typedef {Object} ZombieRow
   * @property {string} id
   * @property {string} name
   * @property {string} behaviour    key of ZOMBIE_BEHAVIOURS in games/souls.js
   * @property {number} hp           health at difficulty 1
   * @property {number} speed        world units per second
   * @property {number} radius       collision and separation circle
   * @property {number} touch        damage of its melee hit (0: it never hits)
   * @property {number} touchInterval seconds between melee hits
   * @property {number} [armour]     flat damage removed from every hit it takes
   * @property {boolean} [isGhost]   ignores walls
   * @property {number} souls        soul points its soul is worth
   * @property {number} dropChance   0..1 chance to drop an item when downed
   * @property {string[]} powers     ids of POWERS its soul can grant on the absorb roll
   * @property {number} soulColor    0xRRGGBB of its lingering soul
   * @property {number} eyeColor     0xRRGGBB of its glowing eyes (the main read in the dark)
   * @property {BodyPart[]} parts    its silhouette
   * @property {Object} [tuning]     numbers only its behaviour reads (documented per row)
   */
  /** @type {ZombieRow[]} */
  const ZOMBIES = [
    {
      id: 'shambler', name: 'Shambler', behaviour: 'chase', hp: 14, speed: 1.7, radius: 0.4, touch: 6, touchInterval: 1.1, souls: 1, dropChance: 0.12,
      powers: ['grit', 'mire'], soulColor: 0x9be7a8, eyeColor: 0xd9f99d,
      parts: [
        { shape: 'box', size: [0.6, 0.9, 0.4], at: [0, 0.6, 0], color: 0x5c6b52 },
        { shape: 'box', size: [0.38, 0.36, 0.36], at: [0, 1.25, 0.05], color: 0x8a9a78 },
        { shape: 'box', size: [0.16, 0.16, 0.6], at: [0.4, 0.85, 0.3], color: 0x8a9a78 },
        { shape: 'box', size: [0.16, 0.16, 0.6], at: [-0.4, 0.85, 0.3], color: 0x8a9a78 },
      ],
    },
    {
      // tuning: lunges from lungeRange after a windup the player can read, then rests.
      id: 'sprinter', name: 'Sprinter', behaviour: 'lunge', hp: 9, speed: 2.5, radius: 0.34, touch: 5, touchInterval: 0.9, souls: 1, dropChance: 0.12,
      powers: ['dash', 'frenzy'], soulColor: 0xfde68a, eyeColor: 0xfbbf24,
      tuning: { lungeRange: 4.5, windup: 0.5, lungeSpeed: 8, lungeSeconds: 0.42, rest: 1.1 },
      parts: [
        { shape: 'box', size: [0.4, 0.75, 0.36], at: [0, 0.55, 0.08], color: 0x7a6a3d },
        { shape: 'box', size: [0.3, 0.3, 0.34], at: [0, 1.05, 0.26], color: 0xb09a5a },
        { shape: 'box', size: [0.1, 0.5, 0.1], at: [0.28, 0.5, -0.1], color: 0xb09a5a },
        { shape: 'box', size: [0.1, 0.5, 0.1], at: [-0.28, 0.5, -0.1], color: 0xb09a5a },
      ],
    },
    {
      // tuning: holds at keepDistance and lobs a glob that lands where the hero stood after `telegraph` seconds.
      id: 'spitter', name: 'Spitter', behaviour: 'spit', hp: 11, speed: 1.5, radius: 0.4, touch: 0, touchInterval: 1, souls: 1, dropChance: 0.18,
      powers: ['acid'], soulColor: 0x5eead4, eyeColor: 0x2dd4bf,
      tuning: { keepDistance: 5.5, spitRange: 8, spitInterval: 2.8, telegraph: 1, splashRadius: 1.25, splashDamage: 8 },
      parts: [
        { shape: 'box', size: [0.5, 0.65, 0.5], at: [0, 0.45, 0], color: 0x3f6f68 },
        { shape: 'ball', size: [0.34], at: [0, 1.0, 0.1], color: 0x5fa39a },
        { shape: 'ball', size: [0.26], at: [0, 0.75, -0.32], color: 0x8fd6c8 },
      ],
    },
    {
      // tuning: swells and bursts when it reaches the hero or is downed; the fuse is the telegraph.
      id: 'bloater', name: 'Bloater', behaviour: 'burst', hp: 20, speed: 1.3, radius: 0.55, touch: 0, touchInterval: 1, souls: 2, dropChance: 0.3,
      powers: ['bloom', 'bulk'], soulColor: 0xf0abfc, eyeColor: 0xf5d0fe,
      tuning: { triggerRange: 1.5, fuse: 0.8, burstRadius: 2.3, burstDamage: 14 },
      parts: [
        { shape: 'ball', size: [0.62], at: [0, 0.68, 0], color: 0x7d5a80 },
        { shape: 'box', size: [0.3, 0.26, 0.3], at: [0, 1.36, 0.08], color: 0xa98aa8 },
      ],
    },
    {
      id: 'brute', name: 'Brute', behaviour: 'chase', hp: 46, speed: 1.25, radius: 0.6, touch: 13, touchInterval: 1.5, armour: 2, souls: 3, dropChance: 0.5,
      powers: ['slam', 'bulk'], soulColor: 0xfca5a5, eyeColor: 0xf87171,
      parts: [
        { shape: 'box', size: [0.95, 1.2, 0.65], at: [0, 0.75, 0], color: 0x4a4f5c },
        { shape: 'box', size: [1.4, 0.3, 0.55], at: [0, 1.35, 0], color: 0x767c8c },
        { shape: 'box', size: [0.36, 0.34, 0.34], at: [0, 1.62, 0.1], color: 0x8b8f9c },
      ],
    },
    {
      // tuning: drifts straight through walls with a sideways sway (swayWidth units, swayRate radians per second).
      id: 'wraith', name: 'Wraith', behaviour: 'drift', hp: 12, speed: 2, radius: 0.36, touch: 7, touchInterval: 1.1, isGhost: true, souls: 2, dropChance: 0.3,
      powers: ['veil', 'siphon'], soulColor: 0xbfdbfe, eyeColor: 0xe0f2fe,
      tuning: { swayWidth: 0.9, swayRate: 2.6 },
      parts: [
        { shape: 'cone', size: [0.45, 1.3], at: [0, 0.85, 0], color: 0x9db4d8, opacity: 0.55 },
        { shape: 'ball', size: [0.2], at: [0, 1.5, 0.05], color: 0xdbeafe, opacity: 0.8 },
      ],
    },
    {
      // The mini-boss. tuning: raises `summonCount` of `summonKind` every `summonInterval` seconds.
      id: 'gravelord', name: 'Gravelord', behaviour: 'summon', hp: 240, speed: 1.45, radius: 0.85, touch: 16, touchInterval: 1.6, armour: 2, souls: 8, dropChance: 1,
      powers: ['slam', 'bulk', 'grit'], soulColor: 0xfef08a, eyeColor: 0xfacc15,
      tuning: { summonInterval: 6, summonCount: 2, summonKind: 'shambler', summonRadius: 2 },
      parts: [
        { shape: 'box', size: [1.4, 1.9, 0.95], at: [0, 1.1, 0], color: 0x3b3550 },
        { shape: 'box', size: [2.0, 0.4, 0.8], at: [0, 2.0, 0], color: 0x6b6385 },
        { shape: 'box', size: [0.5, 0.48, 0.46], at: [0, 2.42, 0.12], color: 0x8f88a8 },
        { shape: 'cone', size: [0.3, 0.4], at: [0, 2.85, 0.12], color: 0xd6b34a },
      ],
    },
  ];

  /**
   * Spawn schedule for Kit.spawnTable: which kinds can appear at run time `from`..`until` (seconds) and how often.
   * The first rows of INTRO_SPAWNS are handed out in order, so every run opens with the same readable lesson.
   */
  const SPAWNS = [
    { kind: 'shambler', weight: 5 },
    { kind: 'sprinter', weight: 3, from: 10 },
    { kind: 'spitter', weight: 2.5, from: 20 },
    { kind: 'bloater', weight: 2, from: 30 },
    { kind: 'wraith', weight: 2, from: 40 },
    { kind: 'brute', weight: 1.5, from: 50 },
  ];
  const INTRO_SPAWNS = [{ kind: 'shambler' }, { kind: 'shambler' }, { kind: 'sprinter' }, { kind: 'shambler' }, { kind: 'spitter' }];

  /** Difficulty over run time (seconds), as Kit.curve specs. */
  const DIFFICULTY = {
    // Every curve keeps climbing to the ten-minute mark: a build that outgrows one stretch of the night meets the next.
    spawnInterval: [[0, 2.4], [30, 1.8], [60, 1.3], [150, 0.7], [600, 0.3]], // seconds between spawns
    maxAlive: [[0, 4], [30, 7], [60, 11], [150, 20], [600, 40]], // zombies on the field at once
    health: [[0, 1], [60, 1.5], [180, 3], [600, 14]], // multiplier on zombie hp
    damage: [[0, 1], [90, 1.2], [240, 2], [600, 5]], // multiplier on every hit the hero takes
    lootLevel: { base: 1, step: 1 / 25 }, // item level: one more every 25 seconds
  };

  /** The mini-boss arrives at `at` seconds of run time and again every `every` seconds, `distance` units from the hero. */
  const BOSS = { kind: 'gravelord', at: 55, every: 100, distance: 9 };
  /** New zombies appear between these distances from the hero: out of the lantern light, but soon in it. */
  const SPAWN_DISTANCE = { min: 7, max: 11 };

  // ---- souls and the absorb roll ---------------------------------------------------------------------------------

  /** Souls: lingering wisps left by downed zombies. Times in seconds, distances in world units. */
  const SOULS = {
    lifetime: 16, // a soul fades if nobody cleanses it
    cleanseRadius: 1.8, // stand this close to channel
    cleanseSeconds: 1.3, // channel time at cleanseSpeed 1
    decayRate: 2, // progress lost per second when the hero steps away (an interrupted channel is not kept)
    absorbNeed: { steps: [[0, 3], [1, 4], [3, 5]] }, // souls per absorb roll, by rolls already made
    bankSouls: { base: 3, step: 1 }, // soul points for banking a roll, by rolls already made
    rareWeight: 0.5, // absorb weight of a power with tier 1, before absorb luck
    streakWindow: 2.5, // cleansing again within this many seconds of the last soul keeps a streak going
    streakBonus: 1, // extra soul points per soul after the first of a streak: bunch the dead, then cleanse them together
  };

  /**
   * @typedef {Object} PowerRow  A Kit.upgrades row (granted, never bought) for a power absorbed from a zombie.
   * @property {string} id
   * @property {string} name
   * @property {number} tier       0 common, 1 rare on the absorb roll
   * @property {number} max        level cap; absorbing a duplicate levels the power up
   * @property {string[]} tags     build tags the power adds while held (see SYNERGIES)
   * @property {string} color      CSS colour on the reel
   * @property {(level: number) => string} desc
   * @property {Object|((level: number) => Object)} mods  Kit.stats modifiers per level
   */
  /** @type {PowerRow[]} */
  const POWERS = [
    { id: 'grit', name: 'Grave Grit', tier: 0, tags: ['grave'], max: 5, color: '#9be7a8', mods: { maxHp: { add: 20 }, regen: { add: 0.6 } }, desc: (level) => `+${20 * level} max health, ${(0.6 * level).toFixed(1)} health per second.` },
    { id: 'mire', name: 'Mire Aura', tier: 1, tags: ['veil'], max: 3, color: '#9be7a8', mods: { slowAura: { add: 0.18 } }, desc: (level) => `Zombies near you are ${percent(0.18 * level)} slower.` },
    { id: 'dash', name: 'Quickstep', tier: 0, tags: ['swift'], max: 4, color: '#fde68a', mods: (level) => ({ dashRange: { add: 2.4 + 0.8 * level } }), desc: (level) => `Tap: dash ${(2.4 + 0.8 * level).toFixed(1)} units, untouchable, then pulse.` },
    { id: 'frenzy', name: 'Frenzy', tier: 0, tags: ['swift', 'wrath'], max: 5, color: '#fde68a', mods: { attackRate: { mul: 1.18 } }, desc: (level) => `+${percent(1.18 ** level - 1)} attack speed.` },
    { id: 'acid', name: 'Acid Spit', tier: 0, tags: ['blight'], max: 5, color: '#5eead4', mods: { acidDamage: { add: 7 } }, desc: (level) => `Spits a bolt at the nearest zombie for ${7 * level} every ${HERO.acidInterval}s.` },
    { id: 'bloom', name: 'Death Bloom', tier: 0, tags: ['blight', 'wrath'], max: 5, color: '#f0abfc', mods: { bloomDamage: { add: 8 } }, desc: (level) => `Zombies you down burst for ${8 * level} around them.` },
    { id: 'bulk', name: 'Bulwark', tier: 0, tags: ['grave'], max: 4, color: '#fca5a5', mods: { armour: { add: 2 } }, desc: (level) => `Every hit you take is reduced by ${2 * level}.` },
    { id: 'slam', name: 'Slam', tier: 1, tags: ['wrath'], max: 4, color: '#fca5a5', mods: { pulseDamage: { add: 10 }, pulseKnock: { mul: 1.3 } }, desc: (level) => `Your pulse deals ${10 * level} and throws zombies further.` },
    { id: 'veil', name: 'Veilwalk', tier: 1, tags: ['veil'], max: 3, color: '#bfdbfe', mods: (level) => ({ phaseTime: { add: 0.9 + 0.3 * level } }), desc: (level) => `When hit, turn untouchable for ${(0.9 + 0.3 * level).toFixed(1)}s (every ${HERO.phaseCooldown}s).` },
    { id: 'siphon', name: 'Siphon', tier: 0, tags: ['veil', 'grave'], max: 5, color: '#bfdbfe', mods: { cleanseHeal: { add: 6 } }, desc: (level) => `Cleansing a soul heals ${6 * level}.` },
  ];

  /**
   * Build tags. Powers, soul-tree nodes, item bases, affixes and curses each carry tags; a synergy wakes while the
   * build holds enough of the tags it names (Kit.synergy), so the three systems feed one another.
   */
  const TAG_LABELS = { wrath: 'Wrath', swift: 'Swift', grave: 'Grave', veil: 'Veil', blight: 'Blight' };
  /**
   * A build is attuned to the tags it holds most of, this many of them, and only attuned tags count toward synergies.
   * With five tags and three attuned, a build can wake at most the synergies of three tag pairs: collecting
   * everything dilutes nothing, but it also wakes nothing new, so what to wear and absorb is a real choice.
   */
  const ATTUNED_TAGS = 3;

  /**
   * Kit.synergy rows. Every synergy needs two different tags, so no single system (one capstone, one weapon)
   * completes it, and each row is a different pair of tags: an attunement of three tags can wake at most three. `needs` counts tags across held powers, owned tree nodes, the class
   * and everything worn.
   */
  const SYNERGIES = [
    { id: 'blightstep', name: 'Blightstep', needs: { swift: 2, blight: 2 }, mods: { dashAcid: { add: 1 }, acidDamage: { add: 4 } }, desc: 'You spit acid, and Quickstep burns every zombie you dash through.' },
    { id: 'quakebloom', name: 'Quakebloom', needs: { wrath: 3, blight: 2 }, mods: { pulseDamage: { add: 8 }, pulseRadius: { mul: 1.3 } }, desc: 'Your pulse wounds, and reaches further.' },
    { id: 'coldveil', name: 'Cold Veil', needs: { veil: 2, grave: 2 }, mods: { slowAura: { add: 0.2 }, cleanseHeal: { add: 4 } }, desc: 'Zombies near you slow; souls mend you.' },
    { id: 'secondwind', name: 'Second Wind', needs: { grave: 2, swift: 2 }, mods: { regen: { add: 1.5 }, attackRate: { mul: 1.12 } }, desc: 'Faster strikes that knit your wounds.' },
    { id: 'hexweaver', name: 'Hexweaver', needs: { blight: 3, veil: 2 }, mods: { absorbLuck: { add: 1 }, bloomDamage: { add: 6 } }, desc: 'Rare powers come easier; the fallen burst.' },
    { id: 'executioner', name: 'Executioner', needs: { wrath: 4, swift: 1 }, mods: { damage: { mul: 1.25 } }, desc: 'A quarter more damage.' },
    { id: 'gravewarden', name: 'Gravewarden', needs: { grave: 4, wrath: 1 }, mods: { armour: { add: 2 }, maxHp: { add: 20 } }, desc: 'Thicker hide, deeper breath.' },
  ];

  // ---- the soul tree (meta progression, kept between runs) --------------------------------------------------------

  /** Branch names, one per column of the tree. */
  const TREE_BRANCHES = ['Reaper', 'Warden', 'Occult'];

  /**
   * @typedef {Object} TreeRow  A Kit.upgrades row bought with soul points and placed by Kit.views.tree.
   * @property {string} id
   * @property {string} name
   * @property {number} col       branch (index into TREE_BRANCHES)
   * @property {number} row       tier, 0 at the top
   * @property {number} max       level cap
   * @property {Object} cost      Kit.curve spec by current level
   * @property {string[]} [requires]
   * @property {boolean} [isCapstone]  the branch's last node: it changes how the game plays and carries a permanent cost,
   *                                   so it is a commitment, not an upgrade
   * @property {string[]} [tags]  build tags the node adds while owned (see SYNERGIES); only capstones carry one, so the
   *                              tree tilts a build without deciding it
   * @property {Object} mods      Kit.stats modifiers per level
   * @property {(level: number) => string} desc
   */
  /**
   * Soul prices by tier of the tree, as Kit.curve specs over the levels already owned. The first node of a branch is
   * within reach of a first run; a capstone is several good runs of saving, so it is a goal, not an impulse.
   */
  const TREE_COSTS = { first: { base: 6, growth: 1.9 }, second: { base: 14, growth: 1.9 }, third: { base: 30, growth: 2 }, capstone: 220 };

  /** @type {TreeRow[]} */
  const TREE = [
    { id: 'edge', name: 'Honed Edge', col: 0, row: 0, max: 3, cost: TREE_COSTS.first, mods: { damage: { mul: 1.1 } }, desc: (level) => `+${percent(1.1 ** level - 1)} damage` },
    { id: 'tempo', name: 'Tempo', col: 0, row: 1, max: 3, cost: TREE_COSTS.second, requires: ['edge'], mods: { attackRate: { mul: 1.08 } }, desc: (level) => `+${percent(1.08 ** level - 1)} attack speed` },
    { id: 'longarm', name: 'Long Arm', col: 0, row: 2, max: 2, cost: TREE_COSTS.third, requires: ['tempo'], mods: { reach: { mul: 1.12 } }, desc: (level) => `+${percent(1.12 ** level - 1)} reach` },
    { id: 'reap', name: 'Reaping Arc', col: 0, row: 3, tags: ['wrath'], max: 1, cost: TREE_COSTS.capstone, requires: ['longarm'], isCapstone: true, mods: { reapEvery: { add: 4 }, attackRate: { mul: 0.88 } }, desc: () => 'Every 4th attack hits all in reach twice as hard, but -12% attack speed' },

    { id: 'vigor', name: 'Vigor', col: 1, row: 0, max: 3, cost: TREE_COSTS.first, mods: { maxHp: { add: 15 } }, desc: (level) => `+${15 * level} max health` },
    { id: 'plate', name: 'Grave Plate', col: 1, row: 1, max: 3, cost: TREE_COSTS.second, requires: ['vigor'], mods: { armour: { add: 1 } }, desc: (level) => `-${level} damage per hit taken` },
    { id: 'rites', name: 'Swift Rites', col: 1, row: 2, max: 2, cost: TREE_COSTS.third, requires: ['plate'], mods: { cleanseSpeed: { mul: 1.25 } }, desc: (level) => `+${percent(1.25 ** level - 1)} cleanse speed` },
    { id: 'sanctum', name: 'Sanctum', col: 1, row: 3, tags: ['grave'], max: 1, cost: TREE_COSTS.capstone, requires: ['rites'], isCapstone: true, mods: { cleansePulse: { add: 1 }, cleanseSpeed: { mul: 0.8 } }, desc: () => 'Every cleansed soul releases a free pulse, but cleansing is 20% slower' },

    { id: 'focus', name: 'Focus', col: 2, row: 0, max: 3, cost: TREE_COSTS.first, mods: { cooldown: { mul: 0.9 } }, desc: (level) => `-${percent(1 - 0.9 ** level)} pulse cooldown` },
    { id: 'omen', name: 'Omen', col: 2, row: 1, max: 2, cost: TREE_COSTS.second, requires: ['focus'], mods: { absorbLuck: { add: 1 } }, desc: (level) => `Rare powers ${level + 1}x as likely` },
    { id: 'fortune', name: 'Fortune', col: 2, row: 2, max: 2, cost: TREE_COSTS.third, requires: ['omen'], mods: { lootLuck: { add: 0.5 } }, desc: (level) => `+${percent(0.5 * level)} loot luck` },
    { id: 'fifthvessel', name: 'Fifth Vessel', col: 2, row: 3, tags: ['blight'], max: 1, cost: TREE_COSTS.capstone, requires: ['fortune'], isCapstone: true, mods: { powerSlots: { add: 1 }, absorbNeed: { mul: 1.34 } }, desc: () => 'Hold a fifth power, but rolls need a third more souls' },
  ];

  // ---- loot ------------------------------------------------------------------------------------------------------

  /** Kit.loot rarities, common first. `beam` is the 0xRRGGBB of the drop's light; `color` the CSS colour of its name. */
  const RARITIES = [
    { id: 'worn', name: 'Worn', color: '#b8b3a7', beam: 0xb8b3a7, weight: 60, affixes: 0, mult: 1 },
    { id: 'blessed', name: 'Blessed', color: '#86efac', beam: 0x86efac, weight: 28, affixes: 1, mult: 1.25 },
    { id: 'hallowed', name: 'Hallowed', color: '#7dd3fc', beam: 0x7dd3fc, weight: 10, affixes: 2, mult: 1.6 },
    { id: 'mythic', name: 'Mythic', color: '#fcd34d', beam: 0xfcd34d, weight: 2.5, affixes: 3, mult: 2.1 },
  ];

  /** Equipment slots, in the order the inventory shows them, with their display names. */
  const SLOTS = ['weapon', 'charm', 'relic'];
  const SLOT_LABELS = { weapon: 'Weapon', charm: 'Charm', relic: 'Relic' };

  /** Kit.loot bases. A weapon's id is also its row in WEAPON_BEHAVIOURS; `from` is the item level it starts dropping at. */
  const BASES = [
    { id: 'knife', name: 'Grave Knife', slot: 'weapon', tags: ['swift'], weight: 3, mods: { damage: { add: 2 } } },
    { id: 'cleaver', name: "Sexton's Cleaver", slot: 'weapon', tags: ['wrath'], weight: 2, mods: { damage: { add: 5 } } },
    { id: 'crossbow', name: 'Pilgrim Crossbow', slot: 'weapon', tags: ['swift'], weight: 2, mods: { damage: { add: 3 } } },
    { id: 'chain', name: 'Censer Chain', slot: 'weapon', tags: ['blight'], weight: 2, from: 2, mods: { damage: { add: 3 } } },
    { id: 'wick', name: 'Wick Charm', slot: 'charm', tags: ['veil'], weight: 2, mods: { cleanseSpeed: { mul: 1.2 } } },
    { id: 'fang', name: 'Fang Charm', slot: 'charm', tags: ['wrath'], weight: 2, mods: { damage: { mul: 1.12 } } },
    { id: 'bell', name: 'Bell Charm', slot: 'charm', tags: ['veil'], weight: 1.5, from: 2, mods: { cooldown: { mul: 0.88 } } },
    { id: 'urn', name: 'Ash Urn', slot: 'relic', tags: ['grave'], weight: 2, mods: { maxHp: { add: 18 } } },
    { id: 'knot', name: 'Burial Knot', slot: 'relic', tags: ['grave'], weight: 2, mods: { armour: { add: 1.5 } } },
    { id: 'coin', name: "Ferryman's Coin", slot: 'relic', tags: ['blight'], weight: 1.5, from: 2, mods: { soulGain: { mul: 1.2 } } },
  ];

  /** Kit.loot affixes: a prefix or a suffix with stat mods; `from` gates by item level, `slots` by where it may roll. */
  const AFFIXES = [
    { id: 'keen', prefix: 'Keen', tags: ['wrath'], mods: { damage: { add: 2 } }, slots: ['weapon', 'charm'] },
    { id: 'swift', prefix: 'Swift', tags: ['swift'], mods: { attackRate: { mul: 1.12 } }, slots: ['weapon', 'charm'] },
    { id: 'stout', prefix: 'Stout', tags: ['grave'], mods: { maxHp: { add: 12 } } },
    { id: 'warded', prefix: 'Warded', tags: ['grave'], mods: { armour: { add: 1 } }, slots: ['charm', 'relic'] },
    { id: 'fleet', prefix: 'Fleet', tags: ['swift'], mods: { speed: { mul: 1.06 } }, from: 2 },
    { id: 'long', prefix: 'Long', tags: ['wrath'], mods: { reach: { mul: 1.1 } }, slots: ['weapon'], from: 2 },
    { id: 'lucky', prefix: 'Lucky', mods: { lootLuck: { add: 0.25 } }, from: 3 },
    { id: 'embers', suffix: 'of Embers', tags: ['wrath'], mods: { damage: { mul: 1.1 } } },
    { id: 'vigil', suffix: 'of the Vigil', tags: ['veil'], mods: { cleanseSpeed: { mul: 1.15 } } },
    { id: 'mending', suffix: 'of Mending', tags: ['grave'], mods: { regen: { add: 0.5 } } },
    { id: 'echoes', suffix: 'of Echoes', tags: ['veil'], mods: { cooldown: { mul: 0.92 } }, from: 2 },
    { id: 'harvest', suffix: 'of Harvest', tags: ['veil'], mods: { soulGain: { mul: 1.12 } }, from: 2 },
    { id: 'venomed', prefix: 'Venomed', tags: ['blight'], mods: { acidDamage: { add: 3 } }, from: 2 },
    { id: 'omens', suffix: 'of Omens', tags: ['blight'], mods: { absorbLuck: { add: 0.5 } }, from: 3 },
  ];

  /**
   * Curses: affixes added on top of a finished roll (Kit.loot.augment). Each pairs an upside no normal affix reaches
   * with a real drawback, so a cursed drop is a build decision, not an upgrade.
   */
  const CURSES = [
    { id: 'hollow', prefix: 'Hollow', tags: ['blight'], flags: { isCursed: true }, mods: { damage: { mul: 1.4 }, maxHp: { add: -25 } } },
    { id: 'ravenous', prefix: 'Ravenous', tags: ['blight'], flags: { isCursed: true }, mods: { attackRate: { mul: 1.4 }, regen: { add: -1.2 } } },
    { id: 'leaden', prefix: 'Leaden', tags: ['blight'], flags: { isCursed: true }, mods: { armour: { add: 4 }, speed: { mul: 0.85 } } },
    { id: 'grasping', prefix: 'Grasping', tags: ['blight'], flags: { isCursed: true }, mods: { soulGain: { mul: 1.6 }, cooldown: { mul: 1.35 } } },
  ];

  /** Loot rules that are not table rows. */
  const LOOT = {
    power: { base: 1, step: 0.12 }, // Kit.loot strength by item level
    curseChance: 0.22, // chance a drop is cursed
    pityKills: 4, // most kills in a row without a drop
    chestLuck: 1.5, // extra luck for items from chests
    chestCount: 2,
    chestRing: [4, 8], // chests sit between these many cells from the start (nearest, farthest)
    bagSize: 12,
    salvageRate: 0.08, // soul points per point of item value (rounded up)
    beamHeight: 3,
  };

  /**
   * @typedef {Object} WeaponBehaviourRow
   * @property {string} id       the base id of the weapon ('unarmed' when the weapon slot is empty)
   * @property {string} pattern  key of ATTACK_PATTERNS in games/souls.js
   * @property {number} reach    world units at reach stat 1
   * @property {number} interval seconds between attacks at attackRate 1
   * @property {number} power    multiplier on the damage stat
   * @property {number} [jumps]  'arc' pattern: extra zombies the hit jumps to
   * @property {number} [falloff] 'arc' pattern: damage kept per jump
   * @property {number} [speed]  'bolt' pattern: bolt speed, units per second
   */
  /** @type {WeaponBehaviourRow[]} */
  const WEAPON_BEHAVIOURS = [
    { id: 'unarmed', pattern: 'single', reach: 1.9, interval: 0.7, power: 1 },
    { id: 'knife', pattern: 'single', reach: 2, interval: 0.36, power: 0.7 },
    { id: 'cleaver', pattern: 'sweep', reach: 2.7, interval: 1.05, power: 1.5 },
    { id: 'crossbow', pattern: 'bolt', reach: 7, interval: 0.85, power: 1.1, speed: 14 },
    { id: 'chain', pattern: 'arc', reach: 3.3, interval: 0.8, power: 0.9, jumps: 2, falloff: 0.65 },
  ];

  // ---- the long arc (kept between runs in a Kit.profile) ---------------------------------------------------------

  /**
   * @typedef {Object} ClassRow  Who wakes. A class reshapes the opening of a run: stat mods, powers held from the
   *                             first second, and tags that pull the build toward certain synergies.
   * @property {string} id
   * @property {string} name
   * @property {string} desc
   * @property {string|null} unlock  Kit.profile unlock id that makes it selectable (null: always)
   * @property {Object} mods         Kit.stats modifiers for the whole run
   * @property {string[]} powers     ids of POWERS granted at the start
   * @property {string[]} tags       build tags
   */
  /** @type {ClassRow[]} */
  const CLASSES = [
    { id: 'pilgrim', name: 'Pilgrim', unlock: null, mods: {}, powers: [], tags: [], desc: 'No gifts, no debts.' },
    { id: 'sexton', name: 'Sexton', unlock: 'class:sexton', mods: { maxHp: { add: 30 }, speed: { mul: 0.92 } }, powers: ['bulk'], tags: ['grave'], desc: 'Starts with Bulwark and +30 health, but walks slower.' },
    { id: 'hexer', name: 'Hexer', unlock: 'class:hexer', mods: { maxHp: { add: -25 }, absorbLuck: { add: 0.5 } }, powers: ['acid'], tags: ['blight'], desc: 'Starts with Acid Spit and luckier rolls, but 25 less health.' },
    { id: 'revenant', name: 'Revenant', unlock: 'class:revenant', mods: { maxHp: { mul: 0.6 }, soulGain: { mul: 1.5 } }, powers: ['veil'], tags: ['veil'], desc: 'Starts with Veilwalk and half again the souls, on little more than half the health.' },
  ];

  /**
   * @typedef {Object} TierRow  How hard the night is. Higher tiers pay more souls and add rules, not only numbers.
   * @property {string} id
   * @property {string} name
   * @property {string} desc
   * @property {string|null} unlock   Kit.profile unlock id (null: always)
   * @property {number} health        multiplier on zombie health
   * @property {number} speed         multiplier on zombie speed
   * @property {number} souls         multiplier on soul points per cleanse
   * @property {number} soulLife      multiplier on how long a soul lingers (restless souls fade sooner)
   * @property {number} eliteEvery    every Nth spawn is an elite (0: never)
   */
  /** @type {TierRow[]} */
  const TIERS = [
    { id: 'dusk', name: 'Dusk', unlock: null, health: 1, speed: 1, souls: 1, soulLife: 1, eliteEvery: 0, desc: 'The graveyard as it is.' },
    { id: 'midnight', name: 'Midnight', unlock: 'tier:midnight', health: 1.4, speed: 1.08, souls: 1.5, soulLife: 0.7, eliteEvery: 6, desc: 'Tougher dead, restless souls, elites. Souls are worth half again as much.' },
    { id: 'witching', name: 'Witching Hour', unlock: 'tier:witching', health: 1.9, speed: 1.15, souls: 2, soulLife: 0.5, eliteEvery: 4, desc: 'Souls fade in moments and elites are common. Double souls.' },
  ];

  /** Elites: a tougher, larger zombie that always drops an item and leaves a soul worth more. */
  const ELITE = { health: 2.2, souls: 2, scale: 1.3 };

  /**
   * Kit.profile achievements: the goals that pull a player back, and what each unlocks. `stat` is a lifetime
   * statistic the game records (see recordRunEvent in games/souls-meta.js).
   */
  const ACHIEVEMENTS = [
    { id: 'rites', text: 'Cleanse 150 souls', stat: 'cleansed', target: 150, unlocks: 'class:sexton' },
    { id: 'vessel', text: 'Absorb 30 powers', stat: 'absorbed', target: 30, unlocks: 'class:hexer' },
    { id: 'lordslayer', text: 'Down 3 Gravelords', stat: 'down:gravelord', target: 3, unlocks: 'tier:midnight' },
    { id: 'weaver', text: 'Wake 4 different synergies', stat: 'synergiesFound', target: 4, unlocks: 'class:revenant' },
    { id: 'nightlord', text: 'Down 3 Gravelords at Midnight', stat: 'down:gravelord@midnight', target: 3, unlocks: 'tier:witching' },
    { id: 'vigil', text: 'Survive 5 minutes in one run', stat: 'bestTime', target: 300 },
    { id: 'gilded', text: 'Find a Mythic item', stat: 'found:mythic', target: 1 },
    { id: 'undying', text: 'Survive 4 minutes at the Witching Hour', stat: 'bestTime@witching', target: 240 },
  ];

  // ---- the graveyard ---------------------------------------------------------------------------------------------

  /** The arena: a square Kit.grid of `size` cells, each `cell` world units wide; `clearRadius` cells around the start stay open. */
  const ARENA = { size: 23, cell: 1.5, clearRadius: 2 };

  /**
   * What the generator scatters. Each feature is `count` runs of `length` [min, max] cells in a straight line, placing
   * an obstacle every `stride` cells (stride 2 makes rows of separate graves; stride 1 makes solid walls).
   */
  const FEATURES = [
    { kind: 'wall', count: 7, length: [2, 4], stride: 1 },
    { kind: 'tomb', count: 12, length: [2, 4], stride: 2 },
    { kind: 'tree', count: 14, length: [1, 1], stride: 1 },
  ];

  /** How each obstacle kind is drawn: one instanced shape per kind. Sizes in world units. */
  const OBSTACLES = {
    wall: { shape: 'box', size: [1.5, 0.95, 1.5], color: 0x57524b },
    tomb: { shape: 'box', size: [0.9, 1.05, 0.34], color: 0x8f8d86 },
    tree: { shape: 'cone', size: [0.85, 3.2], color: 0x24392c },
  };

  window.SOULWAKE_DATA = {
    HERO_STATS, STAT_LABELS, COMPARE, HERO, ZOMBIES, SPAWNS, INTRO_SPAWNS, DIFFICULTY, BOSS, SPAWN_DISTANCE, SOULS, POWERS, TAG_LABELS, ATTUNED_TAGS, SYNERGIES, CLASSES, TIERS, ELITE, ACHIEVEMENTS,
    TREE_BRANCHES, TREE, RARITIES, SLOTS, SLOT_LABELS, BASES, AFFIXES, CURSES, LOOT, WEAPON_BEHAVIOURS, ARENA, FEATURES, OBSTACLES,
  };
})();
