/**
 * Ferry Lines - data tables, the pure harbour simulation and the rules of the long arc. Runs in node (no THREE, no DOM):
 * tools/test-kit.js tests it and scratch/ferry/pacing.js plays it for hours with bots.
 *
 * Owns: goods, boat classes, order kinds, archipelagos, shipyard rows, commissions; the world as plain data and the step
 *       functions that advance it; what a watch writes into the player's permanent record.
 * Does not own: stroke clean-up and travel along a route (Kit.route / Kit.follow), countdowns (Kit.timer), costs and coins
 *       (Kit.upgrades / Kit.wallet / Kit.stats), the permanent record itself (Kit.profile), or anything drawn (games/ferry.js).
 *
 * DEPTH PLAN (games/README.md: deep at three timescales)
 *   Seconds - mastery of the stroke. A route is a shape, and the shape is the skill:
 *     - shorter is faster, but a route that crosses another makes the younger boat give way at every meeting;
 *     - a route drawn through several docks is a hub line (one boat serves them all) but each dock has one berth, so boats queue;
 *     - a stroke that returns to its first dock is a circuit: the boat never turns back, and in a tide race or a gyre a
 *       circuit drawn the right way round rides the current on every leg while a there-and-back route fights it half the time;
 *     - speed pays: every order carries a bonus for patience left, and rush orders cannot be met by a slow line at all.
 *   Minutes - decisions with trade-offs, from rules that interact:
 *     - boat classes (Packet / Cutter / Barge): speed against hold against time at the berth. Production is slow, so a Barge
 *       on a short line sails half empty while a Cutter on a bulk line starves a festival; refitting costs coins;
 *     - processing chains: a sawmill or foundry only makes crates from crates delivered to it, so supply lines feed
 *       delivery lines and a chain is as fast as its slowest leg;
 *     - the shipyard's cards compete for the same coins (another boat, sails, hold, crane, the next chart), and scrapping
 *       a route to redraw it loses its cargo;
 *     - tides turn on a schedule, so a line that was fast becomes slow: draw across the race, or time the circuit.
 *   Hours - a long arc that changes how you play (Kit.profile):
 *     - commissions (permanent goals) unlock the Cutter, the Barge, the Crane card, and two more archipelagos with new
 *       rules: The Narrows (a tide race that reverses, towns that only buy sawn planks) and Storm Reach (a two-way gyre,
 *       two chains, two lifebuoys);
 *     - takings become rank (Deckhand to Harbour Master) and every chart keeps a best watch to beat;
 *     - demand, patience and queue length ramp for as long as a watch lasts, so every watch ends and better play ends later.
 *   Pacing is proved by scratch/ferry/pacing.js (bots playing this file's rules for hours); its curve is in the report.
 *
 * Simulation points are { x, y } where y is the world's z axis (the ground plane), matching Kit.line.
 */
(() => {
  // =====================================================================================================================
  // DATA TABLES - add content by adding a row
  // =====================================================================================================================

  /**
   * @typedef {Object} GoodRow
   * @property {string} id
   * @property {string} name
   * @property {number} color   crate colour (sRGB hex)
   * @property {string} shape   key of the view's crate geometry table and the CSS class of its order icon
   * @property {number} price   coins an order for one crate pays before multipliers
   */
  /** What islands make and towns ask for. Refined goods (planks, ingots) pay for the extra leg their chain needs. */
  const GOODS = Kit.table([
    { id: 'timber', name: 'Timber', color: 0x8f4a1e, shape: 'log', price: 6 },
    { id: 'citrus', name: 'Citrus', color: 0xff9d1c, shape: 'ball', price: 8 },
    { id: 'salt', name: 'Salt', color: 0xf4f7fb, shape: 'cone', price: 10 },
    { id: 'ore', name: 'Ore', color: 0x8f6bff, shape: 'gem', price: 10 },
    { id: 'planks', name: 'Planks', color: 0xe7c27a, shape: 'slab', price: 13 },
    { id: 'ingots', name: 'Ingots', color: 0xff6f59, shape: 'bar', price: 17 },
  ]);

  /**
   * @typedef {Object} BoatClassRow
   * @property {string} id
   * @property {string} name
   * @property {number} speed      multiplier on the fleet's speed
   * @property {number} hold       crates it carries before Hold upgrades
   * @property {number} dwell      multiplier on time spent at a berth
   * @property {number} refitCost  coins to convert a route's boat to this class
   * @property {string|null} unlock  Kit.profile unlock id that makes it available; null = from the start
   * @property {string} blurb      one line for the shipyard log
   */
  /** Boat classes. None is best everywhere: speed, hold and berth time pull against each other and against slow production. */
  const BOAT_CLASSES = Kit.table([
    { id: 'packet', name: 'Packet', speed: 1, hold: 2, dwell: 1, refitCost: 4, unlock: null, blurb: 'Even-handed: two crates at a steady clip.' },
    { id: 'cutter', name: 'Cutter', speed: 1.6, hold: 1, dwell: 0.6, refitCost: 8, unlock: 'cutter', blurb: 'One crate, very fast: rush orders and speed bonuses.' },
    { id: 'barge', name: 'Barge', speed: 0.7, hold: 5, dwell: 1.4, refitCost: 12, unlock: 'barge', blurb: 'Five crates, slowly: bulk lines and festivals.' },
  ]);

  /**
   * @typedef {Object} IslandRow
   * @property {string} id         unique within its archipelago
   * @property {string} name
   * @property {number} x          centre, world units
   * @property {number} z          centre, world units (positive = toward the bottom of a portrait screen)
   * @property {number} radius     shore radius, world units
   * @property {number} dockAngle  radians from the centre to the dock (0 = +x, PI / 2 = +z)
   * @property {string} [produces] good id made here
   * @property {string} [needs]    good id it must be supplied with to make `produces` (a sawmill, a foundry)
   * @property {string[]} [accepts] good ids bought here (a town)
   * @property {number|null} revealAt  seconds into the watch when it leaves the fog; null = only by the Chart card
   * @property {string} landmark   key of the view's landmark table
   */
  /**
   * A stretch of moving water. Boats inside it gain speed sailing with the flow and lose it sailing against.
   * @typedef {Object} CurrentRow
   * @property {string} id
   * @property {number} x @property {number} z            centre of the rectangle, world units
   * @property {number} halfWidth @property {number} halfLength  half extents along x and z, world units
   * @property {number} flowX @property {number} flowZ    unit direction of the flow at the start of a watch
   * @property {number} strength   share of speed gained running with it (and lost against it)
   * @property {number} period     seconds between reversals (a tide); 0 = it never turns (a gyre)
   */
  /**
   * @typedef {Object} ArchipelagoRow
   * @property {string} id
   * @property {string} name
   * @property {string} blurb        what is different here, for the chart picker
   * @property {string|null} unlock  Kit.profile unlock id; null = open from the first watch
   * @property {number} hearts       timed-out orders the harbour survives
   * @property {number} demand       multiplier on the seconds between orders (below 1 = busier)
   * @property {IslandRow[]} islands the first two rows are the opening pair the first-play hint traces
   * @property {CurrentRow[]} currents
   */
  const TOWN_TASTES = { sound: ['timber', 'citrus', 'salt', 'ore'], narrows: ['planks', 'citrus', 'salt'], reach: ['ingots', 'planks', 'citrus'] };
  /** The charts. Docks face the central channel so routes are tempted to cross, and so the currents matter. */
  const ARCHIPELAGOS = [
    {
      id: 'sound', name: 'Home Sound', blurb: 'Still water and raw goods. Learn the lines.', unlock: null, hearts: 3, demand: 1.3, currents: [],
      islands: [
        { id: 'pinewick', name: 'Pinewick', x: -3.2, z: 5.2, radius: 1.5, dockAngle: -1.2, produces: 'timber', revealAt: 0, landmark: 'pines' },
        { id: 'harrow', name: 'Harrow Bay', x: 3.1, z: 1.6, radius: 1.6, dockAngle: Math.PI, accepts: TOWN_TASTES.sound, revealAt: 0, landmark: 'town' },
        { id: 'saffron', name: 'Saffron Cay', x: 3.3, z: 6.6, radius: 1.3, dockAngle: Math.PI + 0.5, produces: 'citrus', revealAt: 16, landmark: 'grove' },
        { id: 'gullrock', name: 'Gull Rock', x: -3.2, z: -1.9, radius: 1.5, dockAngle: 0.5, accepts: TOWN_TASTES.sound, revealAt: 32, landmark: 'town' },
        { id: 'saltpan', name: 'Saltpan', x: 3.3, z: -4.2, radius: 1.3, dockAngle: Math.PI - 0.4, produces: 'salt', revealAt: 75, landmark: 'pans' },
        { id: 'ironholt', name: 'Ironholt', x: -2.9, z: -7.0, radius: 1.3, dockAngle: 0.2, produces: 'ore', revealAt: null, landmark: 'crag' },
      ],
    },
    {
      id: 'narrows', name: 'The Narrows', blurb: 'A tide race that turns. Towns buy sawn planks, not logs.', unlock: 'narrows', hearts: 3, demand: 0.9,
      currents: [{ id: 'race', x: 0, z: -0.5, halfWidth: 1.1, halfLength: 8.2, flowX: 0, flowZ: -1, strength: 0.5, period: 20 }],
      islands: [
        { id: 'alderholm', name: 'Alderholm', x: -3.2, z: 5.6, radius: 1.4, dockAngle: -0.9, produces: 'timber', revealAt: 0, landmark: 'pines' },
        { id: 'kettle', name: 'Kettle Mill', x: 3.2, z: 3.2, radius: 1.3, dockAngle: Math.PI + 0.2, produces: 'planks', needs: 'timber', revealAt: 0, landmark: 'mill' },
        { id: 'marrow', name: 'Marrow', x: -3.1, z: 0.2, radius: 1.5, dockAngle: 0.3, accepts: TOWN_TASTES.narrows, revealAt: 0, landmark: 'town' },
        { id: 'limeshoal', name: 'Lime Shoal', x: 3.3, z: -2.6, radius: 1.3, dockAngle: Math.PI - 0.3, produces: 'citrus', revealAt: 20, landmark: 'grove' },
        { id: 'candlewick', name: 'Candlewick', x: -3.0, z: -5.6, radius: 1.4, dockAngle: 0.4, accepts: TOWN_TASTES.narrows, revealAt: 45, landmark: 'town' },
        { id: 'brinehook', name: 'Brinehook', x: 3.0, z: -7.0, radius: 1.2, dockAngle: Math.PI - 0.2, produces: 'salt', revealAt: null, landmark: 'pans' },
      ],
    },
    {
      id: 'reach', name: 'Storm Reach', blurb: 'A gyre: south on the west side, north on the east. Two chains, two lifebuoys.', unlock: 'reach', hearts: 2, demand: 0.8,
      currents: [
        { id: 'west', x: -0.95, z: -0.5, halfWidth: 0.75, halfLength: 8.2, flowX: 0, flowZ: 1, strength: 0.45, period: 0 },
        { id: 'east', x: 0.95, z: -0.5, halfWidth: 0.75, halfLength: 8.2, flowX: 0, flowZ: -1, strength: 0.45, period: 0 },
      ],
      islands: [
        { id: 'slagrock', name: 'Slag Rock', x: -3.3, z: 6.2, radius: 1.3, dockAngle: -0.7, produces: 'ore', revealAt: 0, landmark: 'crag' },
        { id: 'emberquay', name: 'Ember Quay', x: 3.2, z: 5.4, radius: 1.3, dockAngle: Math.PI + 0.5, produces: 'ingots', needs: 'ore', revealAt: 0, landmark: 'mill' },
        { id: 'thornmouth', name: 'Thornmouth', x: 3.3, z: 0.4, radius: 1.5, dockAngle: Math.PI, accepts: TOWN_TASTES.reach, revealAt: 0, landmark: 'town' },
        { id: 'greywood', name: 'Greywood', x: -3.3, z: 1.0, radius: 1.4, dockAngle: 0.2, produces: 'timber', revealAt: 25, landmark: 'pines' },
        { id: 'millrace', name: 'Millrace', x: -3.0, z: -3.8, radius: 1.3, dockAngle: 0.4, produces: 'planks', needs: 'timber', revealAt: 25, landmark: 'mill' },
        { id: 'farhaven', name: 'Farhaven', x: 3.1, z: -5.0, radius: 1.5, dockAngle: Math.PI - 0.3, accepts: TOWN_TASTES.reach, revealAt: 50, landmark: 'town' },
        { id: 'sunmere', name: 'Sunmere', x: -3.0, z: -7.6, radius: 1.1, dockAngle: 0.3, produces: 'citrus', revealAt: null, landmark: 'grove' },
      ],
    },
  ];

  /**
   * @typedef {Object} OrderKindRow
   * @property {string} id
   * @property {number} size      how many different goods the order needs at once
   * @property {number} pay       multiplier on the summed crate prices
   * @property {number} patience  multiplier on the patience curve
   * @property {number} weight    spawn weight (Kit.spawnTable)
   * @property {number} from      seconds into the watch when it starts to appear
   * @property {boolean} costsHeart does letting it time out cost a lifebuoy? (a rush is an opportunity, not a duty)
   */
  /** Kinds of order. The first row is the fallback when a bigger kind cannot be filled yet. */
  const ORDER_KINDS = Kit.table([
    { id: 'single', size: 1, pay: 1, patience: 1, weight: 1, from: 0, costsHeart: true },
    { id: 'festival', size: 2, pay: 3, patience: 1.6, weight: 0.4, from: 40, costsHeart: true },
    { id: 'rush', size: 1, pay: 2.2, patience: 0.45, weight: 0.45, from: 75, costsHeart: false },
  ]);

  /**
   * The shipyard: Kit.upgrades rows bought during a watch. `reveals: true` marks the card that charts the next fog-bound
   * island (its `max` is filled in per archipelago); `unlock` is a Kit.profile unlock id the card waits for.
   */
  const SHIPYARD = [
    { id: 'boat', name: 'Boat', max: 3, cost: { base: 16, growth: 2.4 }, mods: { fleet: { add: 1 } } },
    { id: 'sails', name: 'Sails', max: 4, cost: { base: 14, growth: 2.2 }, mods: { speed: { mul: 1.2 } } },
    { id: 'hold', name: 'Hold', max: 3, cost: { base: 12, growth: 2.2 }, mods: { holdBonus: { add: 1 } } },
    { id: 'chart', name: 'Chart', cost: { base: 45, growth: 2 }, reveals: true },
    { id: 'crane', name: 'Crane', max: 2, cost: { base: 30, growth: 2.5 }, mods: { dwellScale: { mul: 0.65 } }, unlock: 'crane' },
  ];

  /** Starting values the shipyard modifies (Kit.stats base): boats, world units per second, extra crates, berth-time multiplier. */
  const BASE_STATS = { fleet: 2, speed: 2.4, holdBonus: 0, dwellScale: 1 };

  /**
   * Commissions: Kit.profile achievement rows. Statistics are written by RECORDERS and finishWatch below.
   * `deliveries:<chart>` counts orders filled on a chart, `best:<chart>` is the most in one watch there, `crates:<good>`
   * counts crates landed on orders. Lifetime totals gate the unlocks (everyone gets there); bests are the skill goals.
   */
  const COMMISSIONS = [
    { id: 'first-fete', text: 'Fill a festival order', stat: 'festivals', target: 1, unlocks: 'cutter' },
    { id: 'sound-hand', text: 'Land 60 deliveries on Home Sound', stat: 'deliveries:sound', target: 60, unlocks: 'narrows' },
    { id: 'ledger', text: 'Take 3,000 coins in all', stat: 'takings', target: 3000, unlocks: 'barge' },
    { id: 'sawyer', text: 'Land 60 crates of planks', stat: 'crates:planks', target: 60, unlocks: 'crane' },
    { id: 'narrows-hand', text: 'Land 150 deliveries in The Narrows', stat: 'deliveries:narrows', target: 150, unlocks: 'reach' },
    { id: 'sound-pilot', text: 'Land 40 deliveries in one watch on Home Sound', stat: 'best:sound', target: 40 },
    { id: 'narrows-pilot', text: 'Land 80 deliveries in one watch in The Narrows', stat: 'best:narrows', target: 80 },
    { id: 'rush-hand', text: 'Fill 25 rush orders', stat: 'rushes', target: 25 },
    { id: 'reach-master', text: 'Land 70 deliveries in one watch on Storm Reach', stat: 'best:reach', target: 70, unlocks: 'pennant' },
  ];

  /** What each unlock id is called when it is announced. */
  const UNLOCK_NAMES = { cutter: 'Cutter class', barge: 'Barge class', crane: 'Crane card', narrows: 'Chart: The Narrows', reach: 'Chart: Storm Reach', pennant: 'Gold pennant' };

  /** Rank by account level (Kit.profile), first row = level 1. Takings are the experience. */
  const RANKS = ['Deckhand', 'Boatswain', 'Mate', 'Pilot', 'Master', 'Commodore', 'Harbour Master'];
  /** Kit.profile level curve: coins of takings for each next rank. */
  const RANK_CURVE = { base: 500, growth: 2.2 };

  /** Difficulty over watch time (seconds in, value out), read through Kit.curve. They never flatten into safety: every watch ends. */
  const CURVES = {
    orderInterval: Kit.curve.of([[0, 6], [60, 4.2], [180, 2.8], [360, 1.9], [600, 1.3]]), // seconds between new orders
    patience: Kit.curve.of([[0, 40], [120, 30], [300, 22], [600, 14]]), // seconds a town waits for an ordinary order
    ordersPerTown: Kit.curve.of({ steps: [[0, 2], [150, 3], [330, 4]] }), // how many orders one town queues
  };

  /** Simulation tunables. Distances are world units, durations seconds. */
  const RULES = {
    startingStock: 2, // crates on a raw producer's dock when it appears, so the first boat never leaves empty
    stockCap: 4, // crates a dock can hold (and the number of crate slots drawn on a pier)
    inputCap: 4, // crates a mill or foundry can hold waiting to be worked
    produceSeconds: 2.6, // per crate, raw or refined
    dwellSeconds: 0.7, // time a Packet spends at a berth before the Crane
    marketPrice: 1, // coins for a crate a town accepts but did not order: keeps holds from clogging
    supplyPrice: 2, // coins for a crate delivered to a mill or foundry: the supply leg shows up in the ledger
    speedBonus: 0.5, // extra share of the reward for an order filled instantly, fading to 0 as patience runs out
    firstOrderDelay: 0.6, // the first order appears almost at once so the hint has something to point at
    giveWayRadius: 1.2, // a boat slows when an older boat is this close ahead of it
    giveWaySlowdown: 0.3, // share of its speed a yielding boat keeps (never 0, so two boats cannot deadlock)
    currentFloor: 0.45, // slowest a current can make a boat, as a share of its speed (it always makes headway)
    dockReach: 1.35, // how far beyond the shore a dock's mooring point sits
    shoreMargin: 0.15, // routes must stay this far off every shore
    snapRadius: 1.2, // a finger this close to a dock counts as on it
    stopRadius: 0.6, // a route passing this close to a dock calls there
    minRouteLength: 1,
    minLoopLength: 4, // shorter round trips are almost certainly a tap on a dock, not a circuit
  };

  /** Options for Kit.route.clean shared by every drawn route. */
  const STROKE_CLEANUP = { tolerance: 0.25, smoothPasses: 2, step: 0.3 };

  /** How many route colours the view has: the largest fleet the shipyard can reach. */
  const MAX_FLEET = BASE_STATS.fleet + SHIPYARD.find((row) => row.id === 'boat').max;

  // =====================================================================================================================
  // CHARTS - archipelago rows prepared for lookup
  // =====================================================================================================================

  const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
  const centreOf = (island) => ({ x: island.x, y: island.z });

  /** Mooring point of an island's dock, as a Kit.route anchor carrying the island's id. */
  const dockOf = (island) => ({
    id: island.id,
    x: island.x + Math.cos(island.dockAngle) * (island.radius + RULES.dockReach),
    y: island.z + Math.sin(island.dockAngle) * (island.radius + RULES.dockReach),
  });

  /**
   * An archipelago with its islands and docks as Kit.tables.
   * @typedef {ArchipelagoRow & { islands: IslandRow[], docks: Object[] }} Chart
   */
  const CHARTS = Kit.table(ARCHIPELAGOS.map((row) => ({ ...row, islands: Kit.table(row.islands), docks: Kit.table(row.islands.map(dockOf)) })));

  /** @returns {Chart} the chart a world is played on */
  const chartOf = (world) => CHARTS.byId(world.chartId);

  /** True on or too near any island of the chart, fog-bound ones included: nobody sails through uncharted shoals. */
  const isLand = (chart, point) => chart.islands.some((island) => distance(point, centreOf(island)) < island.radius + RULES.shoreMargin);

  // =====================================================================================================================
  // SIMULATION - plain data in, plain data out. No randomness except through context.random.
  // =====================================================================================================================

  /**
   * @typedef {Object} DockState
   * @property {boolean} isRevealed
   * @property {number} stock        crates waiting on the pier
   * @property {number} input        crates delivered to a mill or foundry and not yet worked
   * @property {Object} production   Kit.timer that makes one crate each time it cycles
   */
  /**
   * @typedef {Object} Order
   * @property {number} id
   * @property {string} islandId
   * @property {string} kindId   ORDER_KINDS id
   * @property {string[]} goods  everything it asked for
   * @property {string[]} needs  what is still missing (shrinks as boats call)
   * @property {Object} timer    Kit.timer of the town's patience
   */
  /**
   * @typedef {Object} Route
   * @property {number} id
   * @property {{x: number, y: number}[]} points
   * @property {number} length
   * @property {boolean} isLoop  a circuit: the boat keeps going round instead of turning back
   * @property {{id: string, along: number}[]} stops  island ids in order along the route
   * @property {number} colorIndex  which of the view's route colours it wears
   */
  /**
   * @typedef {Object} Boat
   * @property {number} id        older boats (lower ids) have right of way
   * @property {number} routeId
   * @property {string} classId   BOAT_CLASSES id
   * @property {{along: number, direction: number}} follower  Kit.follow state
   * @property {string[]} cargo   good ids in the hold
   * @property {number} dwell     seconds left at a berth
   * @property {string|null} mooredAt  island whose berth it occupies
   * @property {string|null} queuedAt  island whose berth it is waiting for
   * @property {boolean} isYielding    slowed for another boat this step
   */
  /**
   * @typedef {Object} World
   * @property {string} chartId
   * @property {number} time     seconds of harbour time
   * @property {number} hearts
   * @property {number} nextId   next unused id for orders, routes and boats
   * @property {Object<string, DockState>} docks  by island id
   * @property {Order[]} orders
   * @property {Route[]} routes
   * @property {Boat[]} boats
   * @property {Object} orderTimer  Kit.timer until the next order is placed
   */
  /**
   * What a step needs from outside the world (see contextOf).
   * @typedef {Object} StepContext
   * @property {number} dt          seconds of harbour time to advance
   * @property {number} speed       a Packet's speed, world units per second
   * @property {number} holdBonus   crates added to every class's hold
   * @property {number} dwellScale  multiplier on berth time
   * @property {() => number} random  uniform 0..1
   * @property {(time: number) => OrderKindRow|null} pickKind  which kind of order to place now
   */
  /** @typedef {{ world: World, events: Object[] }} StepState  events are { type, ... } for the view and the record */

  /**
   * @param {string} [chartId='sound']
   * @returns {World} a fresh watch on that chart
   */
  const createWorld = (chartId = ARCHIPELAGOS[0].id) => {
    const chart = CHARTS.byId(chartId);
    const freshDock = (island) => ({ isRevealed: island.revealAt === 0, stock: island.produces && !island.needs ? RULES.startingStock : 0, input: 0, production: Kit.timer.start(RULES.produceSeconds) });
    return {
      chartId,
      time: 0,
      hearts: chart.hearts,
      nextId: 1,
      docks: Object.fromEntries(chart.islands.map((island) => [island.id, freshDock(island)])),
      orders: [],
      routes: [],
      boats: [],
      orderTimer: Kit.timer.start(RULES.firstOrderDelay),
    };
  };

  const withDock = (world, islandId, patch) => ({ ...world, docks: { ...world.docks, [islandId]: { ...world.docks[islandId], ...patch } } });
  const withBoat = (world, boat) => ({ ...world, boats: world.boats.map((other) => (other.id === boat.id ? boat : other)) });

  /** @returns {World} the world with one island out of the fog */
  const revealIsland = (world, islandId) => withDock(world, islandId, { isRevealed: true });

  /** @returns {IslandRow|undefined} the next island only the Chart card can reveal */
  const nextUnchartedIsland = (world) => chartOf(world).islands.find((island) => island.revealAt === null && !world.docks[island.id].isRevealed);

  /** Which way a current is running: 1 = as its row says, -1 = reversed. Tides turn every `period` seconds; gyres never do. */
  const tideSign = (current, time) => (current.period > 0 && Math.floor(time / current.period) % 2 === 1 ? -1 : 1);

  /**
   * How a chart's currents change a boat's speed at a point: faster with the flow, slower against, unchanged across it.
   * @param {Chart} chart
   * @param {{x: number, y: number, tx: number, ty: number}} pose  position and unit heading
   * @param {number} time  seconds of harbour time (for the tide)
   * @returns {number} multiplier on speed, never below RULES.currentFloor
   * @complexity O(currents on the chart)
   */
  const currentFactor = (chart, pose, time) => {
    const isInside = (current) => Math.abs(pose.x - current.x) <= current.halfWidth && Math.abs(pose.y - current.z) <= current.halfLength;
    const push = chart.currents.filter(isInside).reduce((sum, current) => sum + current.strength * tideSign(current, time) * (pose.tx * current.flowX + pose.ty * current.flowZ), 0);
    return Math.max(RULES.currentFloor, 1 + push);
  };

  // ---- steps: each is (state, context) => state --------------------------------------------------------------------

  const advanceClock = ({ world, events }, { dt }) => ({ world: { ...world, time: world.time + dt }, events });

  /** Islands whose scheduled time has come leave the fog. */
  const revealDueIslands = ({ world, events }) => {
    const due = chartOf(world).islands.filter((island) => island.revealAt !== null && island.revealAt <= world.time && !world.docks[island.id].isRevealed);
    return { world: due.reduce((next, island) => revealIsland(next, island.id), world), events: events.concat(due.map((island) => ({ type: 'revealed', islandId: island.id }))) };
  };

  /** A tide that reversed during this step is announced, so the view can turn its arrows and the player can re-plan. */
  const turnTides = ({ world, events }, { dt }) => {
    const turned = chartOf(world).currents.filter((current) => tideSign(current, world.time) !== tideSign(current, world.time - dt));
    return { world, events: events.concat(turned.map((current) => ({ type: 'tide', currentId: current.id }))) };
  };

  /**
   * One dock's production over dt. Raw producers make a crate per cycle; mills and foundries only while they hold input,
   * using one input crate per crate made, and their clock rests at full while they are starved.
   * @returns {DockState}
   */
  const produceAt = (island, dock, dt) => {
    if (!island.produces || !dock.isRevealed) return dock;
    if (island.needs && dock.input <= 0) return { ...dock, production: Kit.timer.start(RULES.produceSeconds) };
    const { timer, fired } = Kit.timer.cycle(dock.production, dt);
    const made = Math.min(fired, RULES.stockCap - dock.stock, island.needs ? dock.input : Infinity);
    return { ...dock, production: timer, stock: dock.stock + made, input: island.needs ? dock.input - made : dock.input };
  };

  const produceGoods = ({ world, events }, { dt }) => ({
    world: { ...world, docks: Object.fromEntries(chartOf(world).islands.map((island) => [island.id, produceAt(island, world.docks[island.id], dt)])) },
    events,
  });

  /** Patience runs down; every order that runs out costs a heart, unless its kind forgives it. */
  const expireOrders = ({ world, events }, { dt }) => {
    const { running, expired } = Kit.timer.tickAll(world.orders, dt);
    const heartsLost = expired.filter((order) => ORDER_KINDS.byId(order.kindId).costsHeart).length;
    return {
      world: { ...world, orders: running, hearts: Math.max(0, world.hearts - heartsLost) },
      events: events.concat(expired.map((order) => ({ type: 'expired', order }))),
    };
  };

  /** Can a good reach a dock today: its maker is out of the fog and, for a refined good, so is the whole chain behind it. */
  const isMakeable = (world, goodId) => {
    const maker = chartOf(world).islands.find((island) => island.produces === goodId);
    return Boolean(maker) && world.docks[maker.id].isRevealed && (!maker.needs || isMakeable(world, maker.needs));
  };

  /** Goods a town buys that can actually be shipped: nobody orders what cannot be made yet. */
  const goodsOnOfferAt = (world, island) => (island.accepts || []).filter((goodId) => isMakeable(world, goodId));

  /** `count` different items chosen with `random`, without mutating `items`. */
  const drawDistinct = (items, count, random) => {
    if (count <= 0 || !items.length) return [];
    const chosen = Math.floor(random() * items.length);
    return [items[chosen], ...drawDistinct(items.filter((_, index) => index !== chosen), count - 1, random)];
  };

  /**
   * Decide the next order: a random town with a free slot, a kind from the schedule, goods that can be shipped today.
   * @param {World} world
   * @param {StepContext} context
   * @returns {Order|null} null when every town's queue is full or nothing can be shipped
   */
  const planOrder = (world, { random, pickKind }) => {
    const queueLimit = CURVES.ordersPerTown(world.time);
    const hasRoom = (island) => world.orders.filter((order) => order.islandId === island.id).length < queueLimit;
    const towns = chartOf(world).islands.filter((island) => world.docks[island.id].isRevealed && hasRoom(island) && goodsOnOfferAt(world, island).length);
    if (!towns.length) return null;
    const town = towns[Math.floor(random() * towns.length)];
    const onOffer = goodsOnOfferAt(world, town);
    const wished = pickKind(world.time) || ORDER_KINDS[0];
    // A festival wants two different goods; until two can be shipped it shrinks to an ordinary order.
    const kind = onOffer.length >= wished.size ? wished : ORDER_KINDS[0];
    const goods = drawDistinct(onOffer, kind.size, random);
    return { id: world.nextId, islandId: town.id, kindId: kind.id, goods, needs: goods, timer: Kit.timer.start(CURVES.patience(world.time) * kind.patience) };
  };

  /** When the order timer runs out, place an order (if any town can take one) and re-arm it from the demand curve. */
  const placeOrders = ({ world, events }, context) => {
    const orderTimer = Kit.timer.tick(world.orderTimer, context.dt);
    if (!Kit.timer.isExpired(orderTimer)) return { world: { ...world, orderTimer }, events };
    const rearmed = { ...world, orderTimer: Kit.timer.start(CURVES.orderInterval(world.time) * chartOf(world).demand) };
    const order = planOrder(world, context);
    if (!order) return { world: rearmed, events };
    return { world: { ...rearmed, nextId: world.nextId + 1, orders: world.orders.concat(order) }, events: events.concat({ type: 'ordered', order }) };
  };

  const withoutFirst = (items, item) => items.filter((_, index) => index !== items.indexOf(item));

  /** Give one crate to the oldest order at this island still missing it. Returns the new orders, or null if nobody wants it. */
  const handOver = (orders, islandId, goodId) => {
    const taker = orders.find((order) => order.islandId === islandId && order.needs.includes(goodId));
    return taker ? orders.map((order) => (order === taker ? { ...order, needs: withoutFirst(order.needs, goodId) } : order)) : null;
  };

  /**
   * Coins for a completed order: crate prices x the kind's multiplier, plus the speed bonus for patience left over.
   * @param {Order} order
   * @returns {number} whole coins
   */
  const orderReward = (order) => {
    const base = order.goods.reduce((sum, goodId) => sum + GOODS.byId(goodId).price, 0) * ORDER_KINDS.byId(order.kindId).pay;
    return Math.round(base * (1 + RULES.speedBonus * Kit.timer.fraction(order.timer)));
  };

  /**
   * Empty a hold at an island, crate by crate. A crate goes, in this order of preference: to a waiting order; into a mill
   * or foundry that works that good and has room; to market if the town accepts it; otherwise it stays aboard.
   * @param {string[]} cargo
   * @param {Order[]} orders   every open order in the world
   * @param {IslandRow} island
   * @param {number} input     crates the island already holds waiting to be worked
   * @returns {{ cargo: string[], orders: Order[], delivered: { order: Order, coins: number }[], sold: number, supplied: number }}
   * @complexity O(cargo x orders); both are small (a hold, a few queues)
   */
  const unloadCargo = (cargo, orders, island, input = 0) => {
    const accepted = island.accepts || [];
    const emptied = cargo.reduce(
      (hold, goodId) => {
        const handed = handOver(hold.orders, island.id, goodId);
        if (handed) return { ...hold, orders: handed };
        if (island.needs === goodId && input + hold.supplied < RULES.inputCap) return { ...hold, supplied: hold.supplied + 1 };
        return accepted.includes(goodId) ? { ...hold, sold: hold.sold + 1 } : { ...hold, cargo: hold.cargo.concat(goodId) };
      },
      { cargo: [], orders, sold: 0, supplied: 0 }
    );
    const isComplete = (order) => order.islandId === island.id && order.needs.length === 0;
    return {
      cargo: emptied.cargo,
      sold: emptied.sold,
      supplied: emptied.supplied,
      orders: emptied.orders.filter((order) => !isComplete(order)),
      delivered: emptied.orders.filter(isComplete).map((order) => ({ order, coins: orderReward(order) })),
    };
  };

  /** Goods some other stop on this route takes (a town buys them or a mill works them): the only crates worth loading. */
  const goodsWantedOnRoute = (chart, route, fromIslandId) =>
    route.stops.filter((stop) => stop.id !== fromIslandId).flatMap((stop) => (chart.islands.byId(stop.id).accepts || []).concat(chart.islands.byId(stop.id).needs || []));

  /**
   * Fill a hold from a pier, but only with a good another stop on the route takes.
   * @returns {{ cargo: string[], stock: number, loaded: number }}
   */
  const loadCargo = (chart, cargo, stock, island, route, capacity) => {
    const isWanted = Boolean(island.produces) && goodsWantedOnRoute(chart, route, island.id).includes(island.produces);
    const loaded = isWanted ? Math.max(0, Math.min(stock, capacity - cargo.length)) : 0;
    return { cargo: cargo.concat(Array(loaded).fill(island.produces)), stock: stock - loaded, loaded };
  };

  const capacityOf = (boat, context) => BOAT_CLASSES.byId(boat.classId).hold + context.holdBonus;

  /**
   * A boat takes a berth: unload, then load, and start its dwell.
   * @returns {{ state: StepState, boat: Boat }} the boat is returned separately; the caller stores it in the world
   */
  const callAtStop = ({ world, events }, boat, route, stop, context) => {
    const chart = chartOf(world), island = chart.islands.byId(stop.id), dock = world.docks[island.id];
    const unloaded = unloadCargo(boat.cargo, world.orders, island, dock.input);
    const loaded = loadCargo(chart, unloaded.cargo, dock.stock, island, route, capacityOf(boat, context));
    const coinsOnTheSide = unloaded.sold * RULES.marketPrice + unloaded.supplied * RULES.supplyPrice;
    const callEvents = [
      ...unloaded.delivered.map(({ order, coins }) => ({ type: 'delivered', order, coins })),
      ...(coinsOnTheSide ? [{ type: 'sold', islandId: island.id, coins: coinsOnTheSide }] : []),
      ...(loaded.loaded ? [{ type: 'loaded', islandId: island.id }] : []),
    ];
    return {
      state: { world: withDock({ ...world, orders: unloaded.orders }, island.id, { stock: loaded.stock, input: dock.input + unloaded.supplied }), events: events.concat(callEvents) },
      boat: { ...boat, cargo: loaded.cargo, dwell: RULES.dwellSeconds * BOAT_CLASSES.byId(boat.classId).dwell * context.dwellScale, mooredAt: island.id, queuedAt: null },
    };
  };

  /** One berth per dock: is it free for this boat? */
  const isBerthFree = (world, islandId, boatId) => !world.boats.some((other) => other.id !== boatId && other.mooredAt === islandId);

  /** Take the berth at a stop if it is free, otherwise wait off the dock until it is. */
  const berthOrQueue = (state, boat, route, stop, context) =>
    isBerthFree(state.world, stop.id, boat.id) ? callAtStop(state, boat, route, stop, context) : { state, boat: { ...boat, queuedAt: stop.id } };

  const trackOf = (route) => ({ length: route.length, mode: route.isLoop ? 'loop' : 'pingpong', marks: route.stops.map((stop) => stop.along) });

  /** @returns {{x: number, y: number, tx: number, ty: number}} where a boat is and which way it points */
  const poseOf = (boat, route) => Kit.follow.pose(route.points, boat.follower, route.isLoop);

  /**
   * Right of way: a boat slows when an older boat under way is close and ahead of its bow. Boats at or waiting for a berth
   * neither yield nor block, and the slowdown is never a full stop, so crossings cost time but can never deadlock.
   * @param {Boat} boat
   * @param {{x: number, y: number, tx: number, ty: number}} pose  the boat's own pose
   * @param {{ id: number, isUnderWay: boolean, pose: Object }[]} traffic  every boat in the world
   * @returns {number} multiplier on the boat's speed, 1 or RULES.giveWaySlowdown
   * @complexity O(boats) per boat, so O(boats squared) per step; a fleet is at most MAX_FLEET boats, far below where a spatial hash pays
   */
  const giveWayFactor = (boat, pose, traffic) => {
    const isInTheWay = (other) =>
      other.id < boat.id && other.isUnderWay && distance(pose, other.pose) < RULES.giveWayRadius && (other.pose.x - pose.x) * pose.tx + (other.pose.y - pose.y) * pose.ty > 0;
    return traffic.some(isInTheWay) ? RULES.giveWaySlowdown : 1;
  };

  const isUnderWay = (boat) => boat.dwell <= 0 && !boat.queuedAt;

  /**
   * Advance one boat by one step: wait for a berth, sit out its dwell, or sail until the next stop on its route.
   * @returns {{ state: StepState, boat: Boat }}
   */
  const sailBoat = (state, boat, traffic, context) => {
    const route = state.world.routes.find((candidate) => candidate.id === boat.routeId);
    if (boat.queuedAt) return berthOrQueue(state, boat, route, route.stops.find((stop) => stop.id === boat.queuedAt), context);
    if (boat.dwell > 0) {
      const dwell = Math.max(0, boat.dwell - context.dt);
      return { state, boat: { ...boat, dwell, mooredAt: dwell > 0 ? boat.mooredAt : null } };
    }
    const pose = poseOf(boat, route);
    const yielding = giveWayFactor(boat, pose, traffic);
    const speed = context.speed * BOAT_CLASSES.byId(boat.classId).speed * yielding * currentFactor(chartOf(state.world), pose, state.world.time);
    const moved = Kit.follow.advance(boat.follower, speed * context.dt, trackOf(route));
    const sailed = { ...boat, follower: { along: moved.along, direction: moved.direction }, isYielding: yielding < 1 };
    return moved.hit >= 0 ? berthOrQueue(state, sailed, route, route.stops[moved.hit], context) : { state, boat: sailed };
  };

  /** Every boat takes its turn, oldest first. Right of way is judged on where boats were at the start of the step. */
  const sailBoats = (state, context) => {
    const routeOf = (boat) => state.world.routes.find((route) => route.id === boat.routeId);
    const traffic = state.world.boats.map((boat) => ({ id: boat.id, isUnderWay: isUnderWay(boat), pose: poseOf(boat, routeOf(boat)) }));
    return state.world.boats.reduce((current, boat) => {
      // Read the boat from the running state: an earlier boat leaving a berth this step must be visible to a later one.
      const sailed = sailBoat(current, current.world.boats.find((other) => other.id === boat.id), traffic, context);
      return { world: withBoat(sailed.state.world, sailed.boat), events: sailed.state.events };
    }, state);
  };

  /** The order of a harbour tick. Insert a rule by inserting a step. */
  const STEPS = [advanceClock, revealDueIslands, turnTides, produceGoods, expireOrders, placeOrders, sailBoats];

  /**
   * Advance the harbour by context.dt.
   * @param {World} world
   * @param {StepContext} context
   * @returns {StepState} the next world plus what happened
   * @complexity O(islands + orders + boats squared) per step; all three are a handful
   */
  const step = (world, context) => STEPS.reduce((state, runStep) => runStep(state, context), { world, events: [] });

  /** @returns {boolean} is there a boat without a route? */
  const canLaunch = (world, fleet) => world.routes.length < fleet;

  /**
   * Kit.route.capture options for drawing on a world: revealed docks as anchors, the chart's land as the obstacle.
   * @param {World} world
   * @returns {Object}
   */
  const captureOptions = (world) => {
    const chart = chartOf(world);
    return {
      ...STROKE_CLEANUP,
      anchors: chart.islands.filter((island) => world.docks[island.id].isRevealed).map((island) => chart.docks.byId(island.id)),
      snapRadius: RULES.snapRadius,
      stopRadius: RULES.stopRadius,
      minLength: RULES.minRouteLength,
      minLoopLength: RULES.minLoopLength,
      isBlocked: (point) => isLand(chart, point),
    };
  };

  /**
   * Open a route from a successful Kit.route.capture and put a new boat on its first stop, where it trades at once
   * (or queues, if another boat has the berth).
   * @param {World} world
   * @param {{ points: Object[], length: number, isLoop: boolean, stops: Object[] }} captured
   * @param {StepContext} context
   * @param {string} [classId] BOAT_CLASSES id of the new boat
   * @returns {StepState}
   */
  const addRoute = (world, captured, context, classId = BOAT_CLASSES[0].id) => {
    const usedColors = new Set(world.routes.map((route) => route.colorIndex));
    const colorIndex = Array.from({ length: MAX_FLEET }, (_, index) => index).find((index) => !usedColors.has(index));
    const route = { id: world.nextId, points: captured.points, length: captured.length, isLoop: captured.isLoop, stops: captured.stops, colorIndex };
    const boat = { id: world.nextId + 1, routeId: route.id, classId, follower: Kit.follow.start(), cargo: [], dwell: 0, mooredAt: null, queuedAt: null, isYielding: false };
    const launched = { ...world, nextId: world.nextId + 2, routes: world.routes.concat(route), boats: world.boats.concat(boat) };
    const berthed = berthOrQueue({ world: launched, events: [] }, boat, route, route.stops[0], context);
    return { world: withBoat(berthed.state.world, berthed.boat), events: berthed.state.events };
  };

  /** @returns {World} the world without a route or its boat (cargo aboard is lost) */
  const removeRoute = (world, routeId) => ({ ...world, routes: world.routes.filter((route) => route.id !== routeId), boats: world.boats.filter((boat) => boat.routeId !== routeId) });

  /** @returns {World} the world with a route's boat converted to another class (cargo beyond the new hold stays until unloaded) */
  const refitBoat = (world, routeId, classId) => ({ ...world, boats: world.boats.map((boat) => (boat.routeId === routeId ? { ...boat, classId } : boat)) });

  // =====================================================================================================================
  // THE LONG ARC - what is unlocked, what a watch writes into the permanent record
  // =====================================================================================================================

  /** Boat classes and charts open to a player. @param {(id: string) => boolean} isUnlocked  e.g. profile.isUnlocked */
  const availableClasses = (isUnlocked) => BOAT_CLASSES.filter((row) => !row.unlock || isUnlocked(row.unlock));
  const availableCharts = (isUnlocked) => CHARTS.filter((chart) => !chart.unlock || isUnlocked(chart.unlock));

  /** The class a Refit moves a boat to: the next unlocked one after its own, wrapping round. */
  const nextClass = (classId, isUnlocked) => {
    const classes = availableClasses(isUnlocked);
    return classes[(classes.findIndex((row) => row.id === classId) + 1) % classes.length];
  };

  /**
   * The per-watch economy: stats, wallet and the shipyard cards this player may buy on this chart.
   * @param {string} chartId
   * @param {(id: string) => boolean} isUnlocked
   * @returns {{ stats: Object, wallet: Object, shipyard: Object }} Kit.stats, Kit.wallet, Kit.upgrades
   */
  const createYard = (chartId, isUnlocked) => {
    const uncharted = CHARTS.byId(chartId).islands.filter((island) => island.revealAt === null).length;
    const cards = SHIPYARD.filter((row) => !row.unlock || isUnlocked(row.unlock)).map((row) => (row.reveals ? { ...row, max: uncharted } : row));
    const stats = Kit.stats(BASE_STATS), wallet = Kit.wallet({ coins: 0 });
    return { stats, wallet, shipyard: Kit.upgrades(cards, { stats, wallet }) };
  };

  /**
   * A step context from the yard's current stats.
   * @param {Object} stats  Kit.stats from createYard
   * @param {{ dt: number, random: () => number, pickKind: Function }} rest
   * @returns {StepContext}
   */
  const contextOf = (stats, rest) => ({ speed: stats.get('speed'), holdBonus: stats.get('holdBonus'), dwellScale: stats.get('dwellScale'), ...rest });

  /** @returns {Object} a Kit.profile for this game. @param {Object} [options] save and callbacks, passed through */
  const createProfile = (options = {}) => Kit.profile({ achievements: COMMISSIONS, levelCurve: RANK_CURVE, ...options });

  /** What each simulation event adds to the lifetime record, by event type. */
  const RECORDERS = {
    delivered: (profile, { order, coins }, chartId) => {
      profile.count('deliveries');
      profile.count('deliveries:' + chartId);
      profile.count('takings', coins);
      if (order.kindId === 'festival') profile.count('festivals');
      if (order.kindId === 'rush') profile.count('rushes');
      order.goods.forEach((goodId) => profile.count('crates:' + goodId));
    },
    sold: (profile, { coins }) => profile.count('takings', coins),
  };

  /** Write a step's events into the permanent record (commissions complete from here). */
  const recordEvents = (profile, chartId, events) => events.forEach((event) => RECORDERS[event.type] && RECORDERS[event.type](profile, event, chartId));

  /**
   * Close a watch: best deliveries for the chart, takings as rank experience, and a line in the run history.
   * @param {Object} profile  Kit.profile
   * @param {{ chartId: string, deliveries: number, earned: number, time: number }} watch
   * @returns {{ best: number, ranksGained: number }}
   */
  const finishWatch = (profile, watch) => {
    const best = profile.best('best:' + watch.chartId, watch.deliveries);
    const ranksGained = profile.gainExperience(watch.earned);
    profile.endRun(watch);
    return { best, ranksGained };
  };

  /** @returns {string} the rank title for an account level */
  const rankOf = (level) => RANKS[Math.min(level, RANKS.length) - 1];

  window.FERRY_SIM = {
    GOODS, BOAT_CLASSES, ORDER_KINDS, CHARTS, COMMISSIONS, UNLOCK_NAMES, RULES, CURVES, MAX_FLEET,
    createWorld, chartOf, step, isLand, captureOptions, canLaunch, addRoute, removeRoute, refitBoat, revealIsland, nextUnchartedIsland,
    planOrder, orderReward, unloadCargo, loadCargo, giveWayFactor, currentFactor, tideSign, poseOf, isBerthFree,
    availableClasses, availableCharts, nextClass, createYard, contextOf, createProfile, recordEvents, finishWatch, rankOf,
  };
})();
