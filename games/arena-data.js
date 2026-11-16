/**
 * Swarm Arena, data: every rule of the game as a table or a curve. Adding content means adding a row here.
 *
 * Owns: `Arena.data` - the hero's base numbers, upgrades (weapons, passives, evolutions), synergies, enemy types,
 *       elite affixes, the boss, ships, arenas, threat tiers, achievements and the tuning of each mechanic.
 * Does not own: what the rows do (games/arena-sim.js reads them), how anything looks or sounds (games/arena.js,
 *       games/arena-theme.js). Pure: needs only the Kit models (table, curve, path, spawnTable); runs in node.
 *
 * DEPTH PLAN (what is real at each timescale, and which rules interact)
 *
 * Seconds - mastery.
 *   - Dash: a short burst with invulnerability on a cooldown (tap, Space or the Dash button). Used well it crosses a
 *     charge line or leaves a slam circle; used badly it is on cooldown when the lancer fires.
 *   - Graze: an enemy that comes within a hair of the hull and leaves without hitting refunds dash cooldown. Flying
 *     close is how a good pilot dashes more often; flying close badly is how a poor one dies.
 *   - Tells: lancers stop and draw their line before they charge, volatile elites and the boss paint a circle
 *     before it bursts. Every big hit can be read and stepped out of.
 *   - Enemies that ask for something: bulwarks shrug off plain shots from the front, wisps slip through blades,
 *     splitters punish single-target fire, armoured elites cap the damage of one hit.
 * Minutes - decisions.
 *   - Slots: a ship carries a limited number of weapons and passives, so every new row closes a door.
 *   - Trade-offs: no passive is free (Rapid Fire costs damage, Heavy Rounds costs fire rate, Plating costs speed,
 *     Glass Reactor costs hull) and Plating and Glass Reactor exclude each other.
 *   - Synergies (Kit.synergy): each upgrade carries a tag; three kinetic, three energy, three orbit or two hull
 *     rows switch on a set bonus, so the second and third pick of a colour is worth more than the first.
 *   - Evolutions: maxing a weapon and its partner passive unlocks a transformed weapon. Going deep (evolution) and
 *     going wide (synergies) compete for the same dozen picks, and the gun evolves only once: Storm Array (a fan
 *     both ways) or Rail Lance (one beam through everything), never both.
 *   - Counters: the enemy mix shifts with time, so a build is tested by what it cannot handle (see above).
 *   - Rerolls: elites drop one; spend it on a hand that does not fit the build.
 * Hours - the long arc (Kit.profile).
 *   - Ships with different kits and passives: Dart (grazes refund more), Anvil (blades from the start, rams with
 *     its dash, two weapon slots but five passives), Prism (lance from the start, fires faster while standing still).
 *   - Arenas with different rules: the open Proving Ring, the Collapse (the wall closes in and burns), the Surge
 *     (little trickle, huge mixed waves, twice the elites).
 *   - Threat tiers: clearing a tier's boss opens the next; higher tiers add elite affixes, cut the level-up heal
 *     and finally send two wardens.
 *   - Achievements unlock mechanics, not numbers: two more weapons (Pulse Coil, Wake Mines), two more passives
 *     (Capacitor, Glass Reactor) and with them two more evolutions, plus the ships and arenas above. Account level
 *     grants starting rerolls.
 * Pacing and build variety are checked by simulation, not asserted: scratch/arena/simulate.js and `make sim GAME=arena`.
 */
(() => {
  const path = Kit.path;

  /** Most live things of each kind: the sizes of the instanced batches, so also the hard caps of the simulation. */
  const CAPACITY = { enemies: 120, shots: 160, gems: 140, blasts: 12, mines: 18 };

  /**
   * @typedef {Object} HeroBuild
   * The hero's numbers after ship, upgrades and synergies: HERO_BASE pushed through Kit.stats.
   * @property {number} maxHp
   * @property {number} regen         hit points per second
   * @property {number} speed         world units per second
   * @property {number} magnet        gem pull radius, world units
   * @property {number} fireRate      volleys per second
   * @property {number} damage        per shot hit; every other weapon scales from it
   * @property {number} multishot     shots per volley
   * @property {number} pierce        extra enemies a shot passes through; any pierce also beats frontal armour
   * @property {number} shotWidth     multiplier on the shot's width and hit reach
   * @property {number} rearFan       1 = every volley is also fired backwards
   * @property {number} blades        orbiting blades
   * @property {number} bladeRadius   orbit radius, world units
   * @property {number} bladeSpin     radians per second
   * @property {number} pulse         Pulse Coil level; 0 = none
   * @property {number} pulseRadius   world units
   * @property {number} pulseVacuum   1 = each pulse also catches every gem in the arena
   * @property {number} mines         Wake Mines level; 0 = none
   * @property {number} mineRadius    blast radius, world units
   * @property {number} dashCooldown  seconds
   * @property {number} dashDamage    damage dealt to enemies dashed through; 0 = none
   * @property {number} dashNova      level of the shockwave released where a dash ends; 0 = none
   * @property {number} focusRate     extra fire rate (fraction) once the ship has stood still for FOCUS.rampSeconds
   * @property {number} grazeRefund   seconds of dash cooldown refunded per graze
   */

  /** @type {HeroBuild} The hero before ship, upgrades and synergies. */
  const HERO_BASE = {
    maxHp: 100, regen: 0, speed: 7, magnet: 4.2,
    fireRate: 3.2, damage: 1.5, multishot: 1, pierce: 0, shotWidth: 1, rearFan: 0,
    blades: 0, bladeRadius: 2.7, bladeSpin: 4.2,
    pulse: 0, pulseRadius: 4.4, pulseVacuum: 0,
    mines: 0, mineRadius: 2.4,
    dashCooldown: 2.4, dashDamage: 0, dashNova: 0, focusRate: 0, grazeRefund: 0.25,
  };

  /** Floors and ceilings no stack of modifiers may cross (Kit.stats limits). */
  const HERO_LIMITS = { maxHp: [20, Infinity], dashCooldown: [0.7, Infinity], speed: [3, Infinity] };

  /** Offer weights: a weapon the player does not own yet, and an evolution once it is unlocked, come up more often. */
  const OFFER_WEIGHT = { newWeapon: 2.5, evolution: 8 };
  /** Offer weight of weapon rows: heavy until owned, then ordinary. */
  const weaponWeight = (level) => (level === 0 ? OFFER_WEIGHT.newWeapon : 1);

  /**
   * @typedef {Object} ArenaUpgrade
   * A Kit.upgrades row (id, name, desc, max, mods, weight, slot, excludes, requiresMax: see UpgradeRow in
   * kit/model.js) plus this game's fields.
   * @property {'weapon'|'passive'|'evolution'} kind  weapons and passives occupy a slot of the same name
   * @property {string[]} tags       synergy tags (see SYNERGIES)
   * @property {string} color        CSS colour of the card and of the level-up nova
   * @property {string} [unlock]     id the profile must have unlocked before the row can be offered
   * @property {number} [heal]       hit points restored each time the row is taken
   */

  /** @type {ArenaUpgrade[]} Every level-up choice. */
  const UPGRADES = [
    // Weapons: change how the ship attacks. A ship has few weapon slots.
    { id: 'multi', kind: 'weapon', slot: 'weapon', tags: ['kinetic'], name: 'Multishot', desc: (level) => (level > 1 ? 'One more shot in the fan' : 'Two more shots fan out with every volley'), color: '#4de2c5', max: 3, mods: (level) => ({ multishot: { add: level + 1 } }), weight: weaponWeight },
    { id: 'pierce', kind: 'weapon', slot: 'weapon', tags: ['energy'], name: 'Lance Rounds', desc: 'Shots become beams that pierce 2 more enemies and punch through bulwark armour', color: '#8fe9ff', max: 3, mods: { pierce: { add: 2 } }, weight: weaponWeight },
    { id: 'blade', kind: 'weapon', slot: 'weapon', tags: ['orbit'], name: 'Orbit Blades', desc: (level) => (level > 1 ? 'One more blade in the ring' : 'Two blades circle you and shred anything close'), color: '#dff3ff', max: 3, mods: (level) => ({ blades: { add: level + 1 } }), weight: weaponWeight },
    { id: 'pulse', kind: 'weapon', slot: 'weapon', tags: ['energy'], unlock: 'pulse', name: 'Pulse Coil', desc: 'A shockwave bursts from the hull every few seconds; stronger each level', color: '#c9a1ff', max: 3, mods: { pulse: { add: 1 } }, weight: weaponWeight },
    { id: 'mines', kind: 'weapon', slot: 'weapon', tags: ['kinetic'], unlock: 'mines', name: 'Wake Mines', desc: 'Drop mines behind you while you move; they blast whatever follows', color: '#ffb347', max: 3, mods: { mines: { add: 1 } }, weight: weaponWeight },
    // Passives: every one costs something.
    { id: 'rate', kind: 'passive', slot: 'passive', tags: ['kinetic'], name: 'Rapid Fire', desc: 'Shoot 30% faster, each shot 6% weaker', color: '#ffc145', max: 3, mods: { fireRate: { mul: 1.3 }, damage: { mul: 0.94 } } },
    { id: 'dmg', kind: 'passive', slot: 'passive', tags: ['kinetic'], name: 'Heavy Rounds', desc: '+40% damage and fatter shots, 8% slower fire', color: '#ff5d73', max: 3, mods: { damage: { mul: 1.4 }, fireRate: { mul: 0.92 } } },
    { id: 'speed', kind: 'passive', slot: 'passive', tags: ['orbit'], name: 'Thrusters', desc: '+14% move speed, dash recharges 10% sooner', color: '#9bff7a', max: 3, mods: { speed: { mul: 1.14 }, dashCooldown: { mul: 0.9 } } },
    { id: 'magnet', kind: 'passive', slot: 'passive', tags: ['orbit'], name: 'Magnet', desc: 'Gems fly to you from 60% further away', color: '#b06bff', max: 3, mods: { magnet: { mul: 1.6 } } },
    { id: 'plating', kind: 'passive', slot: 'passive', tags: ['hull'], excludes: 'reactor', name: 'Plating', desc: '+30 max hull and repair 20, but 4% slower. Cannot be fitted with Glass Reactor', color: '#ff8fa0', max: 3, mods: { maxHp: { add: 30 }, speed: { mul: 0.96 } }, heal: 20 },
    { id: 'vit', kind: 'passive', slot: 'passive', tags: ['hull'], name: 'Nanoweave', desc: 'Hull repairs itself: +0.7 a second, and 15 now', color: '#7df0a6', max: 3, mods: { regen: { add: 0.7 } }, heal: 15 },
    { id: 'reactor', kind: 'passive', slot: 'passive', tags: ['energy'], excludes: 'plating', unlock: 'reactor', name: 'Glass Reactor', desc: '+35% damage for 18 max hull. Cannot be fitted with Plating', color: '#ffe38a', max: 3, mods: { damage: { mul: 1.35 }, maxHp: { add: -18 } } },
    { id: 'capacitor', kind: 'passive', slot: 'passive', tags: ['energy'], unlock: 'capacitor', name: 'Capacitor', desc: 'Dash recharges 20% sooner and ends in a shockwave', color: '#7fd0ff', max: 3, mods: { dashCooldown: { mul: 0.8 }, dashNova: { add: 1 } } },
    // Evolutions: offered once both parents are at their max level. They take no slot.
    { id: 'storm', kind: 'evolution', tags: [], requiresMax: ['multi', 'rate'], excludes: 'rail', name: 'Storm Array', desc: 'EVOLUTION of Multishot + Rapid Fire: every volley also fires behind you. The gun evolves once: not with Rail Lance', color: '#4de2c5', max: 1, mods: { rearFan: { add: 1 }, multishot: { add: 1 } }, weight: OFFER_WEIGHT.evolution },
    { id: 'rail', kind: 'evolution', tags: [], requiresMax: ['pierce', 'dmg'], name: 'Rail Lance', desc: 'EVOLUTION of Lance Rounds + Heavy Rounds: a wide beam that pierces everything. The gun evolves once: not with Storm Array', color: '#8fe9ff', max: 1, mods: { pierce: { add: 40 }, shotWidth: { mul: 2.2 } }, weight: OFFER_WEIGHT.evolution },
    { id: 'halo', kind: 'evolution', tags: [], requiresMax: ['blade', 'speed'], name: 'Saw Halo', desc: 'EVOLUTION of Orbit Blades + Thrusters: two more blades on a wider, faster ring', color: '#dff3ff', max: 1, mods: { blades: { add: 2 }, bladeRadius: { mul: 1.45 }, bladeSpin: { mul: 1.7 } }, weight: OFFER_WEIGHT.evolution },
    { id: 'nova', kind: 'evolution', tags: [], requiresMax: ['pulse', 'magnet'], name: 'Gravity Well', desc: 'EVOLUTION of Pulse Coil + Magnet: a far wider pulse that pulls in every gem', color: '#c9a1ff', max: 1, mods: { pulseRadius: { mul: 1.6 }, pulseVacuum: { add: 1 } }, weight: OFFER_WEIGHT.evolution },
    { id: 'cluster', kind: 'evolution', tags: [], requiresMax: ['mines', 'capacitor'], name: 'Cluster Wake', desc: 'EVOLUTION of Wake Mines + Capacitor: mines drop faster and blast far wider', color: '#ffb347', max: 1, mods: { mines: { add: 2 }, mineRadius: { mul: 1.6 } }, weight: OFFER_WEIGHT.evolution },
  ];

  /**
   * Set bonuses over upgrade tags (Kit.synergy): active while the build owns that many rows of each tag.
   * @type {Array<{id: string, name: string, needs: Object<string, number>, mods: Object, desc: string, color: string}>}
   */
  const SYNERGIES = [
    { id: 'battery', name: 'Battery', needs: { kinetic: 3 }, mods: { fireRate: { mul: 1.2 } }, desc: '3 kinetic: +20% fire rate', color: '#ffc145' },
    { id: 'overload', name: 'Overload', needs: { energy: 3 }, mods: { damage: { mul: 1.25 } }, desc: '3 energy: +25% damage', color: '#8fe9ff' },
    { id: 'gyre', name: 'Gyre', needs: { orbit: 3 }, mods: { magnet: { mul: 1.3 }, dashCooldown: { mul: 0.8 } }, desc: '3 orbit: wider magnet, dash recharges 20% sooner', color: '#9bff7a' },
    { id: 'fortress', name: 'Fortress', needs: { hull: 2 }, mods: { maxHp: { add: 25 }, regen: { add: 0.5 } }, desc: '2 hull: +25 max hull and steady repair', color: '#ff8fa0' },
    { id: 'crossfire', name: 'Crossfire', needs: { kinetic: 2, energy: 2 }, mods: { pierce: { add: 1 } }, desc: '2 kinetic + 2 energy: every shot pierces once more', color: '#ffffff' },
  ];

  /** The level-up screen and the nova that lands with every pick. */
  const LEVEL_UP = {
    choices: 3,
    heal: 8, // every pick patches you up a little (scaled by the threat tier)
    chainDelay: 0.5, // seconds between two picks earned at once, so the nova of the first is seen
    invulnerableSeconds: 1,
    nova: { radius: 7.5, force: 16, damageScale: 1.5 },
    mostRerolls: 5,
  };

  /**
   * XP needed to leave a level. The first pick comes within seconds, and a run that reaches the warden has made about
   * fourteen picks: enough to max one weapon and its partner (an evolution) or to spread across three synergies, not both.
   * Past level 15 the price climbs steeply, so a build that kills everything cannot also level without end.
   */
  const XP_TO_NEXT_LEVEL = Kit.curve.of([[1, 5], [2, 12], [3, 22], [4, 34], [5, 46], [10, 130], [15, 320], [20, 700], [30, 2400]]);

  /** Hero handling. Lengths in world units, times in seconds. */
  const HERO = {
    firstShotDelay: 0.2,
    retargetSeconds: 0.08, // how soon to look again when nothing is in range
    muzzleDistance: 0.9, // shots start this far ahead of the centre
    recoilScale: 0.22, // body swells by this fraction on a volley...
    pickupRecoilScale: 0.12, // ...and by this much on a gem
    recoilDamping: 14,
    aimTurnRate: 20, // exponential rate the nose turns to the last target
    pickupRadius: 0.9,
    hurtInvulnerableSeconds: 0.9,
    hurtShove: { radius: 4.5, force: 13 },
    wallSoftness: 12, // exponential rate the soft wall eases you back inside
    stillSpeed: 0.05, // stick deflection below this counts as standing still (for Focus)
  };

  /** Dash: a burst along the stick (or the last heading) with invulnerability. Cooldown is the `dashCooldown` stat. */
  const DASH = { speed: 24, seconds: 0.16, graceSeconds: 0.12, ramReach: 1.1, novaRadius: 3.4, novaDamageScale: 2, novaForce: 9 };

  /**
   * Graze: an enemy that enters the band just outside touching range while you are vulnerable, and leaves it without
   * anything having hit you in the last `quietSeconds`, refunds dash cooldown (the `grazeRefund` stat).
   */
  const GRAZE = { band: 0.9, quietSeconds: 0.4 };

  /** Focus (the Prism's passive): seconds of standing still before the `focusRate` bonus is fully in. */
  const FOCUS = { rampSeconds: 0.5 };

  /** Shots. `spread` is the angle between neighbours of a fan, radians. */
  const SHOT = { spread: 0.17, life: 0.55, range: 11, speed: 24, lanceSpeed: 36, hitPadding: 0.3, width: 0.17, length: 0.95, lanceLength: 2.2, lanceLengthPerPierce: 0.3, mostLanceLength: 4.5 };

  /** Orbiting blades. `cooldown` is per enemy, so one blade cannot hit the same enemy every frame. */
  const BLADE = { damageScale: 0.8, cooldown: 0.45, knockback: 1, hitPadding: 0.8 };

  /** Pulse Coil: a radial hit around the hull every `interval` seconds, `damageScale` x level x damage. */
  const PULSE = { interval: 2.2, damageScale: 2.2, force: 7 };

  /** Wake Mines: dropped every `interval / level` seconds while moving; armed after `armSeconds`, gone after `lifetime`. */
  const MINE = { interval: 1.5, armSeconds: 0.3, lifetime: 12, triggerPadding: 0.5, damageScale: 3, force: 6 };

  /** Gems. A kill's XP is split into gems of at most `maxValue`, so a brute bursts into several. */
  const GEM = { maxValue: 5, scatterSpeedMin: 1, scatterSpeedMax: 4, drag: 5, pullAcceleration: 70, maxPullSpeed: 32 };

  /** Chained kills and chained pickups climb in pitch; these bound the climb. */
  const CHAIN = { maxKillCombo: 14, killWindowSeconds: 0.9, maxGemStreak: 14, gemStreakDecay: 4 };

  /** A charge attack: stop and show the line (`tellSeconds`), dash along it, then recover slowly. */
  const CHARGE = {
    lancer: { range: 7.5, tellSeconds: 0.7, dashSpeed: 17, dashSeconds: 0.55, recoverSeconds: 0.9, recoverSpeedScale: 0.3 },
    warden: { range: 99, tellSeconds: 0.9, dashSpeed: 15, dashSeconds: 0.75, recoverSeconds: 0.6, recoverSpeedScale: 0.3 },
  };

  /**
   * @typedef {Object} EnemyType
   * A row of ENEMIES. `from` and `weight` are read by Kit.spawnTable (weight 0 = never spawned by the table).
   * @property {string} id
   * @property {number} sides     corners of its outline (3 = triangle, 6 = hexagon)
   * @property {number} size      radius, world units
   * @property {number} hp        hit points before the pacing curve and the threat tier
   * @property {number} speed     charge speed at the hero, world units per second
   * @property {number} touch     damage dealt to the hero on contact
   * @property {number} xp        experience dropped as gems
   * @property {number} color     0xRRGGBB
   * @property {number} from      first run second it may spawn
   * @property {number} weight    relative spawn odds once active
   * @property {number} [spin]    idle rotation, radians per second; without it the enemy faces the hero
   * @property {number} [stretch] length over width of its outline (default 1)
   * @property {boolean} [isHeavy] its death is an event: ring, shake, hitstop, boom
   * @property {boolean} [isBoss]
   * @property {function(number, Object=): {x: number, y: number}} [steer] a Kit.path sampled per enemy: x scales its
   *   charge at the hero (0 = steady, -1 = stalled), y pushes it sideways
   * @property {'chase'|'charge'|'boss'} [behavior] how it moves (default 'chase'); see BEHAVIORS in arena-sim.js
   * @property {Object} [charge]  a CHARGE row, for 'charge' and 'boss' behaviour
   * @property {number} [frontArmor] fraction of a non-piercing shot's damage that gets through (it always faces you)
   * @property {boolean} [isBladeImmune] orbit blades pass through it
   * @property {{typeId: string, count: number, scatter: number}} [splitsInto] spawned where it dies
   * @property {number} [knockbackScale] how much of a knockback it takes (default 1)
   */

  /** @type {EnemyType[]} Enemy types, in order of first appearance. */
  const ENEMIES = Kit.table([
    { id: 'grunt', sides: 6, size: 0.62, hp: 3, speed: 2.4, touch: 4, xp: 1, color: 0xff5d73, from: 0, weight: 6, spin: 1.6 },
    { id: 'runner', sides: 3, size: 0.6, hp: 1.5, speed: 4.3, touch: 3, xp: 1, color: 0xffc145, from: 8, weight: 3, steer: path.scale(path.lissajous(0, 5), 0, 0.7) },
    { id: 'brute', sides: 4, size: 1.2, hp: 18, speed: 1.7, touch: 10, xp: 5, color: 0xb06bff, from: 22, weight: 1, spin: 0.8, isHeavy: true, steer: path.scale(path.lissajous(1.6, 0), 0.7, 0) },
    { id: 'splitter', sides: 8, size: 0.8, hp: 7, speed: 2.1, touch: 5, xp: 2, color: 0xff8fd0, from: 28, weight: 1.5, spin: 1, splitsInto: { typeId: 'mote', count: 2, scatter: 0.7 } },
    { id: 'mote', sides: 3, size: 0.34, hp: 1.2, speed: 4.6, touch: 2, xp: 1, color: 0xff8fd0, from: 0, weight: 0, spin: 6 },
    { id: 'wasp', sides: 5, size: 0.48, hp: 2.5, speed: 3.2, touch: 3, xp: 2, color: 0x9bff7a, from: 34, weight: 2, spin: 5, steer: path.scale(path.zigzag(0, 2.6), 0, 1.3) },
    { id: 'bulwark', sides: 4, size: 0.9, hp: 12, speed: 1.6, touch: 8, xp: 4, color: 0x7fb2ff, from: 40, weight: 1, frontArmor: 0.25, stretch: 0.6 },
    { id: 'lancer', sides: 3, size: 0.7, hp: 6, speed: 2.6, touch: 9, xp: 3, color: 0xff9a3d, from: 46, weight: 1.2, stretch: 1.7, behavior: 'charge', charge: CHARGE.lancer },
    { id: 'wisp', sides: 10, size: 0.4, hp: 3, speed: 3.6, touch: 3, xp: 2, color: 0xe8fbff, from: 54, weight: 1.5, spin: 3, isBladeImmune: true, steer: path.scale(path.lissajous(0, 3.4), 0, 1.1) },
    { id: 'warden', sides: 8, size: 2.6, hp: 400, speed: 1.5, touch: 14, xp: 40, color: 0xff3355, from: 0, weight: 0, spin: 0.5, isHeavy: true, isBoss: true, behavior: 'boss', charge: CHARGE.warden, knockbackScale: 0.08 },
  ]);

  /**
   * @typedef {Object} Affix
   * A modifier an elite carries. Each asks something different of the build.
   * @property {string} id
   * @property {string} name
   * @property {number} color        0xRRGGBB of the elite's halo
   * @property {number} [speedScale] multiplier on its speed
   * @property {number} [armorCap]   most damage one hit can do to it
   * @property {{fuse: number, radius: number, damage: number}} [blast] left where it dies
   */

  /** @type {Affix[]} */
  const AFFIXES = Kit.table([
    { id: 'swift', name: 'Swift', color: 0xffe14d, speedScale: 1.5 },
    { id: 'armored', name: 'Armoured', color: 0x9fb4ff, armorCap: 2.2 },
    { id: 'volatile', name: 'Volatile', color: 0xff6a3d, blast: { fuse: 0.8, radius: 3.2, damage: 14 } },
  ]);

  /** Elites: a tougher, larger copy of an ordinary type. Killing one drops a pile of XP and a reroll. */
  const ELITE = { firstAt: 25, hpScale: 7, sizeScale: 1.55, xpScale: 8, touchScale: 1.5, rerollsGranted: 1, spawnMargin: 2.5 };

  /** The boss arrives at `at` seconds; killing it (every copy of it) clears the run. */
  const BOSS = {
    typeId: 'warden',
    at: 95,
    warnSeconds: 5,
    spawnMargin: 3,
    attackSeconds: 3.4,
    enrageBelow: 0.5, // fraction of its hp under which it attacks faster
    enragedScale: 0.65,
    attacks: ['charge', 'slam', 'summon', 'slam'], // cycled in order, so the pattern can be learned
    slam: { count: 3, scatter: 3.5, fuse: 1, radius: 3.1, damage: 16 },
    summon: { typeId: 'runner', count: 5, scatter: 2.5 },
    trickleScale: 0.5, // the ordinary swarm thins while a warden is alive
  };

  /**
   * Pacing shared by every arena, as curves over run seconds. The spawner tops the swarm up to `targetCount`, so the
   * screen gets dense however strong the build is; `perTick` caps how fast it refills after a big clear.
   */
  const PACE = {
    opening: { count: 7, typeId: 'grunt', hpScale: 0.5, ringRadius: 6.2, nearZ: 7, farZ: 10, angleOffset: 0.4 }, // one-shot grunts already closing in at second 0
    targetCount: Kit.curve.of([[0, 9], [45, 52], [106, 110]]),
    tickSeconds: 0.22,
    perTick: Kit.curve.of({ base: 1, step: 0.1 }),
    hpScale: Kit.curve.of([[0, 1], [30, 1.5], [60, 2.4], [120, 6]]),
    spawnMargin: 1.5, // how far outside the screen edge enemies appear, world units
    wavePack: { typeId: 'runner', count: Kit.curve.of({ base: 5, step: 3 }), margin: 3, scatter: 3 }, // each new wave opens with a pack from one side
  };

  /** Enemy body behaviour shared by every type. */
  const ENEMY = {
    knockbackPerHit: 3, // speed added along the hit direction, world units per second
    knockbackDrag: 6, // exponential decay of that speed
    hitFlashSeconds: 0.07,
    overlapAllowed: 0.9, // neighbours are pushed apart once closer than this fraction of their combined radii
    separationShare: 0.3, // fraction of an overlap resolved per frame: soft enough that the swarm jostles instead of popping
    touchGraceSeconds: 0.3, // a freshly spawned enemy cannot hurt you while it is still growing in
    touchReachScale: 0.8,
    touchReachPadding: 0.6,
    blockedShotKnockback: 0.3,
  };

  /** Cell size of the spatial hash over enemies, world units: about the diameter of the commonest queries. */
  const HASH_CELL_SIZE = 2.5;

  /**
   * @typedef {Object} Ship
   * @property {string} id
   * @property {string} name
   * @property {string} desc           one line for the hangar
   * @property {string} passive        the ship's own rule, in words
   * @property {Object<string, number>} base   HERO_BASE values this ship replaces
   * @property {string[]} startUpgrades        upgrade ids granted at launch
   * @property {{weapon: number, passive: number}} slots
   * @property {number} color          0xRRGGBB of the hull
   * @property {string} [unlock]       id the profile must have unlocked
   */

  /** @type {Ship[]} */
  const SHIPS = Kit.table([
    { id: 'dart', name: 'Dart', desc: 'Balanced. Three weapons, four passives.', passive: 'Slipstream: a graze refunds twice the dash', base: { grazeRefund: 0.5 }, startUpgrades: [], slots: { weapon: 3, passive: 4 }, color: 0x4de2c5 },
    { id: 'anvil', name: 'Anvil', desc: 'Heavy and slow. Starts with Orbit Blades. Two weapons, five passives.', passive: 'Ram: its dash damages what it passes through', base: { maxHp: 150, speed: 6.1, dashDamage: 6 }, startUpgrades: ['blade'], slots: { weapon: 2, passive: 5 }, color: 0xffb347, unlock: 'anvil' },
    { id: 'prism', name: 'Prism', desc: 'Fragile. Starts with Lance Rounds. Three weapons, four passives.', passive: 'Focus: fires 60% faster while standing still', base: { maxHp: 80, focusRate: 0.6 }, startUpgrades: ['pierce'], slots: { weapon: 3, passive: 4 }, color: 0xc9a1ff, unlock: 'prism' },
  ]);

  /**
   * @typedef {Object} ArenaRules
   * @property {string} id
   * @property {string} name
   * @property {string} desc
   * @property {function(number): number} radius  wall radius over run seconds, world units
   * @property {number} wallDamage    hit points per second lost while leaning on the wall (0 = harmless)
   * @property {number} xpScale       multiplier on every gem
   * @property {number} trickleScale  multiplier on the swarm's steady top-up
   * @property {number} waveSeconds   a wave pack arrives this often
   * @property {number} packScale     multiplier on the wave pack's size
   * @property {boolean} [hasMixedPacks] wave packs are drawn from the whole spawn table instead of runners
   * @property {number} eliteSeconds  an elite arrives this often
   * @property {number} color         0xRRGGBB of the wall
   * @property {string} [unlock]
   */

  /** @type {ArenaRules[]} */
  const ARENAS = Kit.table([
    { id: 'ring', name: 'Proving Ring', desc: 'Open floor, steady swarm.', radius: Kit.curve.of(30), wallDamage: 0, xpScale: 1, trickleScale: 1, waveSeconds: 20, packScale: 1, eliteSeconds: 25, color: 0xff5d73 },
    { id: 'rift', name: 'Collapse', desc: 'The wall closes in and burns. Gems are worth 30% more.', radius: Kit.curve.of([[0, 24], [100, 12]]), wallDamage: 8, xpScale: 1.3, trickleScale: 1, waveSeconds: 20, packScale: 1, eliteSeconds: 25, color: 0xff9a3d, unlock: 'rift' },
    { id: 'gauntlet', name: 'Surge', desc: 'Quiet, then huge mixed waves. Twice the elites.', radius: Kit.curve.of(26), wallDamage: 0, xpScale: 1.1, trickleScale: 0.3, waveSeconds: 9, packScale: 2.4, hasMixedPacks: true, eliteSeconds: 13, color: 0xb06bff, unlock: 'gauntlet' },
  ]);

  /**
   * @typedef {Object} Tier
   * A threat tier: tier N is playable once tier N - 1 has been cleared.
   * @property {string} id
   * @property {number} rank          1-based
   * @property {string} name
   * @property {string} desc
   * @property {number} hpScale       on every enemy's hit points
   * @property {number} xpScale       on every gem: tougher enemies pay more, so a higher tier does not starve the build of levels
   * @property {number} speedScale    on every enemy's speed
   * @property {number} touchScale    on contact and blast damage
   * @property {number} affixCount    affixes each elite carries
   * @property {number} levelHealScale multiplier on the heal of a level-up pick
   * @property {number} bossCount     wardens that arrive together
   */

  /** @type {Tier[]} */
  const TIERS = Kit.table([
    { id: 'tier1', rank: 1, name: 'Threat I', desc: 'Plain elites. One warden.', hpScale: 1, xpScale: 1, speedScale: 1, touchScale: 1, affixCount: 0, levelHealScale: 1, bossCount: 1 },
    { id: 'tier2', rank: 2, name: 'Threat II', desc: 'Elites carry an affix. Tougher swarm.', hpScale: 1.4, xpScale: 1.3, speedScale: 1.1, touchScale: 1.15, affixCount: 1, levelHealScale: 1, bossCount: 1 },
    { id: 'tier3', rank: 3, name: 'Threat III', desc: 'Two affixes. Level-ups heal half.', hpScale: 1.9, xpScale: 1.7, speedScale: 1.16, touchScale: 1.3, affixCount: 2, levelHealScale: 0.5, bossCount: 1 },
    { id: 'tier4', rank: 4, name: 'Threat IV', desc: 'Two wardens. Level-ups do not heal.', hpScale: 2.3, xpScale: 2, speedScale: 1.24, touchScale: 1.5, affixCount: 2, levelHealScale: 0, bossCount: 2 },
  ]);

  /**
   * Achievements (Kit.profile rows). Each watches one lifetime statistic; most unlock a mechanic.
   * Statistics: kills, elites, bosses, gems, grazes, evolutions (lifetime counters); bestLevel, tier (bests).
   */
  const ACHIEVEMENTS = [
    { id: 'first-hundred', text: 'Destroy 100 enemies', stat: 'kills', target: 100, unlocks: 'pulse', reward: 'Pulse Coil joins the upgrade pool' },
    { id: 'close-calls', text: 'Graze 250 enemies', stat: 'grazes', target: 250, unlocks: 'capacitor', reward: 'Capacitor joins the upgrade pool' },
    { id: 'hunter', text: 'Destroy 10 elites', stat: 'elites', target: 10, unlocks: 'anvil', reward: 'New ship: Anvil' },
    { id: 'veteran', text: 'Reach level 12 in one run', stat: 'bestLevel', target: 12, unlocks: 'rift', reward: 'New arena: Collapse' },
    { id: 'collector', text: 'Collect 6000 gems', stat: 'gems', target: 6000, unlocks: 'mines', reward: 'Wake Mines join the upgrade pool' },
    { id: 'warden-down', text: 'Defeat a warden', stat: 'bosses', target: 1, unlocks: 'prism', reward: 'New ship: Prism' },
    { id: 'evolved', text: 'Evolve a weapon', stat: 'evolutions', target: 1, unlocks: 'reactor', reward: 'Glass Reactor joins the upgrade pool' },
    { id: 'surge', text: 'Clear Threat III', stat: 'tier', target: 3, unlocks: 'gauntlet', reward: 'New arena: Surge' },
    { id: 'breaker', text: 'Destroy 5000 enemies', stat: 'kills', target: 5000, reward: 'Trophy' },
    { id: 'ace', text: 'Clear Threat IV', stat: 'tier', target: 4, reward: 'Trophy' },
  ];

  /** Account progression: each finished run earns experience; account levels grant rerolls to start a run with. */
  const ACCOUNT = {
    levelCurve: { base: 250, growth: 1.4 },
    experiencePerKill: 1,
    experiencePerSecond: 2,
    experiencePerClearedRank: 150,
    mostStartingRerolls: 3, // one per account level above the first
  };

  /** What a brand-new player flies: the first run starts at once, with no hangar. */
  const DEFAULT_LOADOUT = { shipId: 'dart', arenaId: 'ring', tierId: 'tier1' };

  window.Arena = {
    data: {
      CAPACITY, HERO_BASE, HERO_LIMITS, UPGRADES, SYNERGIES, LEVEL_UP, XP_TO_NEXT_LEVEL, HERO, DASH, GRAZE, FOCUS, SHOT, BLADE, PULSE, MINE, GEM, CHAIN,
      CHARGE, ENEMIES, AFFIXES, ELITE, BOSS, PACE, ENEMY, HASH_CELL_SIZE, SHIPS, ARENAS, TIERS, ACHIEVEMENTS, ACCOUNT, DEFAULT_LOADOUT,
    },
  };
})();
