/**
 * Kit core: the foundation every other kit file and every game builds on.
 *
 * Owns:  the `Kit` global and game registry, `Kit.math` (scalar helpers, easing, unseeded random),
 *        number / time formatting, the event bus, the object pool, the game clock (timers and
 *        tweens that run on game time) and the per-game persistent store.
 * Does not own: anything that touches the DOM, THREE or the frame loop (see shell.js), seeded
 *        randomness (Kit.rng in loot.js) or progression models (model.js).
 *
 * Pure enough to run in node: the only browser global it reads is `localStorage`, and it copes
 * when that is missing or blocked. Unit-tested by tools/test-kit.js.
 */
(() => {
  const Kit = (window.Kit = { games: [] });

  // ---- math ----------------------------------------------------------------------------------------------------------

  /** One full turn in radians. */
  const TAU = Math.PI * 2;

  /**
   * Limits a value to a range.
   * @param {number} value
   * @param {number} [min=0]
   * @param {number} [max=1]
   * @returns {number} `value`, or the nearer bound when it lies outside [min, max].
   */
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

  /**
   * Wraps a value into [0, size), also for negatives (the `%` operator alone keeps the sign).
   * @param {number} value
   * @param {number} size length of the cycle (must not be 0)
   * @returns {number}
   * @example wrap(-1, 4) // 3
   */
  const wrap = (value, size) => ((value % size) + size) % size;

  /**
   * Linear interpolation.
   * @param {number} from value at amount 0
   * @param {number} to value at amount 1
   * @param {number} amount 0..1 (not clamped, so it also extrapolates)
   * @returns {number}
   */
  const lerp = (from, to, amount) => from + (to - from) * amount;

  /**
   * Frame-rate independent smoothing: moves `current` toward `target` by the same fraction per
   * second whatever the frame time, because the remaining distance decays as e^(-rate * dt).
   * @param {number} current
   * @param {number} target
   * @param {number} rate decay rate per second (about 5 is lazy, 20 is snappy)
   * @param {number} dt frame time in seconds
   * @returns {number} the new current value
   * @example camera.position.x = damp(camera.position.x, player.x, 6, dt);
   */
  const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));

  /**
   * Uniform random number. `rand()` is 0..1, `rand(max)` is 0..max, `rand(min, max)` is min..max.
   * @param {number} [minOrMax=1] the upper bound when called with one argument, else the lower bound
   * @param {number} [max] exclusive upper bound
   * @returns {number}
   */
  const rand = (minOrMax = 1, max) => {
    if (max === undefined) return Math.random() * minOrMax;
    return minOrMax + Math.random() * (max - minOrMax);
  };

  /**
   * Uniform random integer with both ends included.
   * @param {number} min
   * @param {number} max
   * @returns {number} integer in [min, max]
   */
  const randInt = (min, max) => Math.floor(rand(min, max + 1));

  /**
   * Maps a value from one range onto another, clamped to the output range.
   * @param {number} value
   * @param {number} inMin
   * @param {number} inMax
   * @param {number} outMin
   * @param {number} outMax
   * @returns {number}
   * @example remap(speed, 0, 20, 0.8, 1.4) // engine pitch from speed
   */
  const remap = (value, inMin, inMax, outMin, outMax) => outMin + (outMax - outMin) * clamp((value - inMin) / (inMax - inMin));

  // Constants of the standard "back" easing: how far it overshoots before settling.
  const BACK_OVERSHOOT = 1.70158;
  // Constants of the standard "bounce" easing: parabola steepness and the number of bounce segments.
  const BOUNCE_STRENGTH = 7.5625;
  const BOUNCE_SEGMENTS = 2.75;
  /**
   * The four parabolic arcs of outBounce, in order. Each row is the arc's end (in segment units),
   * the centre of its parabola and the height it bounces back up to.
   */
  const BOUNCE_ARCS = [
    { end: 1, centre: 0, floor: 0 },
    { end: 2, centre: 1.5, floor: 0.75 },
    { end: 2.5, centre: 2.25, floor: 0.9375 },
    { end: Infinity, centre: 2.625, floor: 0.984375 },
  ];
  // outElastic: how fast the oscillation dies away, and its period as a fraction of a turn.
  const ELASTIC_DECAY = 10;
  const ELASTIC_PERIOD = TAU / 3;
  const ELASTIC_PHASE = 0.75;

  /**
   * Easing functions: each maps progress 0..1 to eased progress, with f(0) = 0 and f(1) = 1.
   * The `out*` shapes start fast and settle; outBack, outBounce and outElastic overshoot or bounce.
   * @type {Object<string, function(number): number>}
   */
  const ease = {
    linear: (progress) => progress,
    outCubic: (progress) => 1 - Math.pow(1 - progress, 3),
    inCubic: (progress) => progress * progress * progress,
    inOutQuad: (progress) => (progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2),
    outBack: (progress) => 1 + (BACK_OVERSHOOT + 1) * Math.pow(progress - 1, 3) + BACK_OVERSHOOT * Math.pow(progress - 1, 2),
    outBounce: (progress) => {
      // The last arc has no end, so it also catches progress past 1 (and NaN, which matches no arc).
      const finalArc = BOUNCE_ARCS[BOUNCE_ARCS.length - 1];
      const arc = BOUNCE_ARCS.find((candidate) => progress < candidate.end / BOUNCE_SEGMENTS) || finalArc;
      const offset = progress - arc.centre / BOUNCE_SEGMENTS;
      return BOUNCE_STRENGTH * offset * offset + arc.floor;
    },
    outElastic: (progress) => {
      // The end points are returned exactly: the decaying sine only approaches them.
      if (progress === 0 || progress === 1) return progress;
      return Math.pow(2, -ELASTIC_DECAY * progress) * Math.sin((progress * ELASTIC_DECAY - ELASTIC_PHASE) * ELASTIC_PERIOD) + 1;
    },
  };

  /**
   * @typedef {Object} RandomTools
   * @property {function(Array): *} pick uniform random element (undefined for an empty list)
   * @property {function(Array, function(*): number): *} pickWeighted random row with chance weight / total weight
   * @property {function(Array): Array} shuffle shuffled copy; the input is not changed
   */

  /**
   * Builds the list-randomising helpers over any source of random numbers, so the unseeded
   * Kit.math versions and the seeded Kit.rng versions (loot.js) share one implementation.
   * @param {function(): number} random returns a number in [0, 1)
   * @returns {RandomTools}
   * @complexity `pick` is O(1); `pickWeighted` is O(rows) time (two passes: total, then walk), O(1) space;
   *   `shuffle` is O(n) time and space
   * @example const { shuffle } = Kit.math.randomTools(Kit.rng(42).next);
   */
  const randomTools = (random) => ({
    pick: (items) => items[Math.floor(random() * items.length)],

    pickWeighted(rows, weightOf) {
      const totalWeight = rows.reduce((sum, row) => sum + weightOf(row), 0);
      // Walk the rows, spending the roll on each weight; the row that uses it up is the pick.
      let roll = random() * totalWeight;
      for (const row of rows) {
        roll -= weightOf(row);
        if (roll <= 0) return row;
      }
      // Only reachable through floating-point drift (or an empty list): fall back to the last row.
      return rows[rows.length - 1];
    },

    shuffle(items) {
      const shuffled = items.slice();
      // Fisher-Yates, so every order is equally likely. Index loop on purpose: each step swaps
      // the last unplaced item with a random item at or before it.
      for (let last = shuffled.length - 1; last > 0; last--) {
        const other = Math.floor(random() * (last + 1));
        [shuffled[last], shuffled[other]] = [shuffled[other], shuffled[last]];
      }
      return shuffled;
    },
  });

  // Math.random is looked up on every call (not captured), so a test that stubs it still takes effect.
  const unseeded = randomTools(() => Math.random());

  /**
   * Uniform random element of a list.
   * @template T
   * @param {T[]} items
   * @returns {T} undefined when the list is empty
   */
  const pick = (items) => unseeded.pick(items);

  /**
   * Weighted random row, for spawn and loot tables. A row's chance is its weight over the total.
   * @template T
   * @param {T[]} rows
   * @param {function(T): number} [weightOf] defaults to `row.weight`, or 1 when that is missing or 0
   * @returns {T} undefined when `rows` is empty
   * @example pickWeighted(ENEMIES, (enemy) => enemy.weight)
   */
  const pickWeighted = (rows, weightOf = (row) => row.weight || 1) => unseeded.pickWeighted(rows, weightOf);

  /**
   * Shuffled copy of a list. The input is not changed.
   * @template T
   * @param {T[]} items
   * @returns {T[]}
   */
  const shuffle = (items) => unseeded.shuffle(items);

  Kit.math = { TAU, clamp, wrap, lerp, damp, rand, randInt, pick, pickWeighted, shuffle, randomTools, remap, ease };

  /**
   * Draws up to `count` different rows, each draw weighted: the "pick 3 of these, rarer ones less often" of offers and loot.
   * A row is never drawn twice, and rows whose weight is 0 or less are never drawn at all.
   * @template T
   * @param {T[]} rows the input is not changed
   * @param {number} count how many to draw; fewer come back when fewer rows have a positive weight
   * @param {function(T): number} [weightOf] defaults to `row.weight`, or 1 when that is missing
   * @returns {T[]} in draw order (heavier rows tend to come first)
   * @example Kit.math.sampleWeighted(UPGRADES, 3, (row) => (row.rare ? 0.2 : 1))
   */
  Kit.math.sampleWeighted = (rows, count, weightOf = (row) => (row.weight === undefined ? 1 : row.weight)) => {
    const remaining = rows.filter((row) => weightOf(row) > 0);
    const drawn = [];
    // Draw without replacement: each pick leaves the pool, so the next one is weighted among what is left.
    while (drawn.length < count && remaining.length) {
      const row = Kit.math.pickWeighted(remaining, weightOf);
      remaining.splice(remaining.indexOf(row), 1);
      drawn.push(row);
    }
    return drawn;
  };

  /**
   * Makes a per-key rate limiter: `isReady(key, gap)` answers "has at least `gap` passed since this key last got a yes?"
   * and, when it says yes, starts that key's gap again. Sounds, toasts and hit sparks use it to stay readable in a crowd.
   * @param {function(): number} now the clock, in any unit (seconds of game time, performance.now() milliseconds)
   * @returns {function(string, number): boolean} `gap` is in the clock's unit; a gap of 0 or less always passes
   * @example
   * const isReady = Kit.math.rateLimiter(() => world.seconds);
   * if (isReady('hit', 0.05)) sfx.play('hit');
   */
  Kit.math.rateLimiter = (now) => {
    const lastPassedAt = new Map();
    return (key, gap) => {
      const time = now();
      // A key that never passed has no entry, so its first request always goes through.
      if (lastPassedAt.has(key) && time - lastPassedAt.get(key) < gap) return false;
      lastPassedAt.set(key, time);
      return true;
    };
  };

  // ---- formatting ----------------------------------------------------------------------------------------------------

  const SECONDS_PER_MINUTE = 60;

  /**
   * Formats a duration as minutes and two-digit seconds.
   * @param {number} seconds
   * @returns {string}
   * @example Kit.fmtTime(75) // "1:15"
   */
  Kit.fmtTime = (seconds) => {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    const remainder = Math.floor(seconds % SECONDS_PER_MINUTE);
    return minutes + ':' + String(remainder).padStart(2, '0');
  };

  /** Suffixes for each power of a thousand above the first. */
  const THOUSAND_UNITS = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
  const SIGNIFICANT_DIGITS = 3;

  /**
   * Formats a number for a HUD: exact (one decimal at most) below 1000, then three significant
   * digits with a unit suffix.
   * @param {number} value
   * @returns {string}
   * @example Kit.fmt(1234) // "1.23K"
   * @example Kit.fmt(12.5) // "12.5"
   */
  Kit.fmt = (value) => {
    if (!isFinite(value)) return '∞';
    const magnitude = Math.abs(value);
    if (magnitude < 1000) return String(Math.round(value * 10) / 10).replace(/\.0$/, '');
    // Groups of three digits above the thousands, capped at the largest unit we have a name for.
    const unitIndex = Math.min(THOUSAND_UNITS.length - 1, Math.floor(Math.log10(magnitude) / 3) - 1);
    const scaled = value / Math.pow(1000, unitIndex + 1);
    return scaled.toPrecision(SIGNIFICANT_DIGITS).replace(/\.?0+$/, '') + THOUSAND_UNITS[unitIndex];
  };

  // ---- event bus -----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Bus
   * @property {function(string, function(*): void): function(): boolean} on subscribe; returns an unsubscribe function
   * @property {function(string, *=): void} emit call every listener of the event with one payload
   * @property {function(): void} clear drop every listener
   */

  /**
   * Creates a tiny synchronous event bus.
   * @returns {Bus}
   * @complexity `on` and unsubscribe are O(1); `emit` is O(listeners of that event) time and space (it copies the
   *   listener set so listeners may subscribe or unsubscribe during delivery)
   * @example
   * const bus = Kit.bus();
   * const off = bus.on('hit', (damage) => console.log(damage));
   * bus.emit('hit', 3); off();
   */
  Kit.bus = () => {
    const listenersByEvent = new Map();
    return {
      on(eventName, listener) {
        if (!listenersByEvent.has(eventName)) listenersByEvent.set(eventName, new Set());
        listenersByEvent.get(eventName).add(listener);
        return () => listenersByEvent.get(eventName).delete(listener);
      },
      emit(eventName, payload) {
        const listeners = listenersByEvent.get(eventName);
        if (!listeners) return;
        // Iterate a copy so a listener may subscribe or unsubscribe while the event is being delivered.
        [...listeners].forEach((listener) => listener(payload));
      },
      clear: () => listenersByEvent.clear(),
    };
  };

  // ---- object pool ---------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Pool
   * @property {Set<*>} live the objects currently handed out
   * @property {function(...*): *} get take an object (reused if one is free); extra arguments go to `onGet`
   * @property {function(*): void} release hand an object back; a no-op for objects that are not live
   * @property {function(function(*): void): void} each visit every live object (safe to release inside)
   * @property {function(): void} clear release every live object
   */

  /** Default pool hook: THREE objects are shown while live and hidden while free. */
  const setVisibleIfObject3D = (item, isVisible) => {
    if (item && item.isObject3D) item.visible = isVisible;
  };

  /**
   * Creates an object pool, so things spawned repeatedly (bullets, particles, pickups) are reused
   * instead of allocated and garbage-collected.
   * @param {function(): *} create builds a new object when none is free
   * @param {function(*, ...*): void} [onGet] prepares an object for use; without it THREE objects are made visible
   * @param {function(*): void} [onRelease] retires an object; without it THREE objects are hidden
   * @returns {Pool}
   * @complexity `get` and `release` are O(1); `each` and `clear` are O(live) time and space (they copy the live set
   *   so objects may be released during the pass). Memory is the high-water mark of live objects.
   * @example
   * const bullets = Kit.pool(() => make.sphere(0.1, 0xffee88), (bullet, origin) => bullet.position.copy(origin));
   * const bullet = bullets.get(player.position); bullets.release(bullet);
   */
  Kit.pool = (create, onGet, onRelease) => {
    const free = [];
    const live = new Set();
    const pool = {
      live,
      get(...args) {
        const item = free.pop() || create();
        live.add(item);
        if (onGet) onGet(item, ...args);
        else setVisibleIfObject3D(item, true);
        return item;
      },
      release(item) {
        // Releasing twice (or releasing a stranger) must not put the same object in `free` twice.
        if (!live.delete(item)) return;
        if (onRelease) onRelease(item);
        else setVisibleIfObject3D(item, false);
        free.push(item);
      },
      each(visit) {
        [...live].forEach((item) => visit(item));
      },
      clear() {
        [...live].forEach((item) => pool.release(item));
      },
    };
    return pool;
  };

  // ---- slot ring -----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} SlotRing
   * @property {function(): number} claim the next slot index, recycling the oldest slot once every slot has been used
   * @property {function(function(number): void): void} forEach visit every slot in the live window, oldest first
   * @property {function(function(number): boolean): void} trim shrink the window past the oldest slots that
   *   `isFree(slot)` reports as finished
   * @property {number} span how many slots the live window covers (read-only)
   */

  /**
   * Hands out the slots of a fixed-size buffer in a circle and remembers the stretch that may still
   * be in use, so a per-frame pass visits only that stretch instead of the whole buffer. Made for
   * short-lived things stored in pre-allocated arrays or instanced meshes (particles, trails, decals).
   * @param {number} capacity number of slots (a positive whole number)
   * @returns {SlotRing}
   * @throws {Error} when capacity is not a positive whole number
   * @complexity `claim` is O(1); `forEach` is O(span); `trim` is O(slots released). The window runs from the
   *   oldest unfinished slot to the newest, so a pass costs what is in use, not the capacity. O(1) space.
   * @example
   * const ring = Kit.slotRing(900);
   * const slot = ring.claim();                         // on spawn: write the particle into particles[slot]
   * ring.forEach((slot) => advance(particles[slot]));  // every frame
   * ring.trim((slot) => particles[slot].life <= 0);    // then let the window shrink
   */
  Kit.slotRing = (capacity) => {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`Kit.slotRing: capacity must be a positive whole number, got ${capacity}`);
    /** The slot handed out most recently; -1 before the first claim. */
    let newestSlot = -1;
    /** Length of the live window, which ends at `newestSlot` and extends backwards. */
    let span = 0;
    const slotBehindNewest = (stepsBack) => wrap(newestSlot - stepsBack, capacity);
    return {
      claim() {
        newestSlot = (newestSlot + 1) % capacity;
        // A full window means the slot being recycled was its oldest, so its length stays at capacity.
        span = Math.min(capacity, span + 1);
        return newestSlot;
      },
      forEach(visit) {
        // Hot path: an index loop over the window, oldest first, with no allocation.
        for (let stepsBack = span - 1; stepsBack >= 0; stepsBack--) visit(slotBehindNewest(stepsBack));
      },
      trim(isFree) {
        // Only the oldest end can shrink: a finished slot between live ones stays inside the window.
        while (span > 0 && isFree(slotBehindNewest(span - 1))) span -= 1;
      },
      get span() {
        return span;
      },
    };
  };

  // ---- game clock ----------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Clock
   * @property {function(number, function(): void): function(): boolean} after run once after N game seconds; returns a cancel function
   * @property {function(number, function(): void): function(): boolean} every run every N game seconds; returns a cancel function
   * @property {function(Object, Object<string, number>, number=, (string|function(number): number)=): Promise<void>} tween
   *   animate numeric properties of an object to target values; resolves when it finishes
   * @property {function(number): void} update advance by `dt` game seconds (the shell calls this)
   * @property {function(): void} clear drop every timer and tween
   */

  /** Advances a timer job; fires it when its time is up and re-arms it if it repeats. */
  const advanceTimer = (job, dt) => {
    job.remaining -= dt;
    if (job.remaining > 0) return;
    job.callback();
    // Adding the interval (rather than resetting to it) carries the overshoot forward, so a
    // repeating timer keeps its average rate even when frames are long.
    if (job.interval) job.remaining += job.interval;
    else job.isDead = true;
  };

  /** Advances a tween job: writes the eased in-between value of every animated property. */
  const advanceTween = (job, dt) => {
    job.elapsed += dt;
    const progress = clamp(job.elapsed / job.duration);
    const eased = job.easing(progress);
    Object.keys(job.to).forEach((property) => {
      job.target[property] = lerp(job.from[property], job.to[property], eased);
    });
    if (progress < 1) return;
    job.isDead = true;
    job.resolve();
  };

  /**
   * Creates a game clock: timers and tweens that advance only when `update` is called, so pause,
   * hitstop and slow motion freeze or stretch them along with the game.
   * @returns {Clock}
   * @complexity scheduling is O(1); `update` is O(jobs) time per frame and allocates one array of the surviving jobs
   * @example
   * clock.after(2, spawnBoss);
   * const stop = clock.every(0.5, spawnGrunt);
   * await clock.tween(mesh.scale, { x: 1.4, y: 0.7 }, 0.12, 'outBack'); // target can be any object with numeric fields
   */
  Kit.clock = () => {
    let jobs = [];
    const schedule = (job) => {
      jobs.push(job);
      return () => (job.isDead = true);
    };
    return {
      after: (seconds, callback) => schedule({ remaining: seconds, callback }),
      every: (seconds, callback) => schedule({ remaining: seconds, callback, interval: seconds }),
      tween: (target, to, duration = 0.3, easing = 'outCubic') =>
        new Promise((resolve) => {
          // Remember where each property starts, so the tween is a pure function of elapsed time.
          const from = Object.keys(to).reduce((start, property) => ({ ...start, [property]: target[property] }), {});
          const easingFunction = typeof easing === 'function' ? easing : ease[easing] || ease.outCubic;
          schedule({ isTween: true, target, from, to, duration, elapsed: 0, easing: easingFunction, resolve });
        }),
      update(dt) {
        // Per-frame hot path: a plain loop over the live array, so jobs scheduled by a callback
        // during this pass are also advanced in it.
        for (const job of jobs) {
          if (job.isDead) continue;
          if (job.isTween) advanceTween(job, dt);
          else advanceTimer(job, dt);
        }
        jobs = jobs.filter((job) => !job.isDead);
      },
      clear: () => (jobs = []),
    };
  };

  // ---- persistent store ----------------------------------------------------------------------------------------------

  /** localStorage key under which every game's save lives, as one JSON object keyed by namespace. */
  const STORAGE_KEY = 'five-loop-lab';

  /** Reads the saved data, or an empty object when storage is missing, blocked or corrupt. */
  const loadSavedData = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  };

  let savedData = loadSavedData();

  /** Writes the saved data back. Failure (private mode, quota) is ignored: the game keeps working in memory. */
  const flushSavedData = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData));
    } catch (error) {
      // Storage is unavailable; `savedData` still serves reads for this session.
    }
  };

  /**
   * @typedef {Object} Store
   * @property {function(string, *=): *} get the saved value, or the given default when the key was never set
   * @property {function(string, *): *} set save a JSON-serialisable value; returns it
   */

  /**
   * Opens a persistent key-value store for one namespace (the shell gives each game its own as `ctx.save`).
   * @param {string} namespace usually the game id
   * @returns {Store}
   * @example
   * const save = Kit.store('runner');
   * save.set('best', Math.max(score, save.get('best', 0)));
   */
  Kit.store = (namespace) => ({
    get(key, fallback) {
      const values = savedData[namespace];
      return values && key in values ? values[key] : fallback;
    },
    set(key, value) {
      if (!savedData[namespace]) savedData[namespace] = {};
      savedData[namespace][key] = value;
      flushSavedData();
      return value;
    },
  });

  // ---- development aids ----------------------------------------------------------------------------------------------

  /** Host names that mean a developer is running the page locally (the smoke and dev tools serve on 127.0.0.1; '' is file://). */
  const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', ''];
  /** Most warnings kept in Kit.warnings; the oldest are dropped, so a mistake inside a loop cannot grow the list without bound. */
  const MAX_KEPT_WARNINGS = 50;

  /**
   * Is this page running for a developer (as opposed to the published page a player opens)? Development-time
   * warnings and checks only run when it is, so they cost a player nothing.
   * Set `window.KIT_DEV = true` or `false` before the kit loads to force the answer either way.
   * @returns {boolean} the forced value, else whether the page is served from this machine
   * @example if (Kit.isDevelopment()) installExpensiveChecks();
   */
  Kit.isDevelopment = () => {
    if (window.KIT_DEV !== undefined) return Boolean(window.KIT_DEV);
    return Boolean(window.location) && LOCAL_HOSTNAMES.includes(window.location.hostname);
  };

  /**
   * The development warnings raised so far, oldest first. Tools read this (`node tools/dev.js play` prints it).
   * @type {string[]}
   */
  Kit.warnings = [];

  /**
   * Tells the developer about a likely mistake that would otherwise only show up as odd behaviour. Each distinct
   * message is reported once, as a console warning, and only in development (see Kit.isDevelopment).
   * @param {string} message names the cause and the fix
   * @returns {boolean} true when the warning was reported, false when it was a repeat or the page is published
   * @example Kit.warn(`runner: 4 stats in the top row; three fit a phone. Move one into ui.progress.`);
   */
  Kit.warn = (message) => {
    if (!Kit.isDevelopment() || Kit.warnings.includes(message)) return false;
    Kit.warnings.push(message);
    if (Kit.warnings.length > MAX_KEPT_WARNINGS) Kit.warnings.shift();
    console.warn('[kit] ' + message);
    return true;
  };

  /** Names a value's type the way a person would: 'array', 'null' and 'NaN' instead of 'object' and 'number'. */
  const describeType = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
    return typeof value;
  };

  /**
   * Development check of one argument: warns (Kit.warn) when its type is obviously wrong. A kit function calls
   * this at its entry so the mistake is named where it was made, not three frames later.
   * @param {string} where the call as the developer wrote it, e.g. 'ui.stat(label)'
   * @param {*} value the argument received
   * @param {string} expected accepted type names separated by `|`: string, number, boolean, function, object,
   *   array, undefined (for an optional argument), null
   * @param {string} example a correct call, shown in the warning
   * @returns {boolean} whether the value has an accepted type
   * @example Kit.expectType('ui.stat(label)', label, 'string', "ui.stat('Coins', 0)");
   */
  Kit.expectType = (where, value, expected, example) => {
    const actual = describeType(value);
    if (expected.split('|').includes(actual)) return true;
    const shown = ['string', 'number', 'boolean'].includes(actual) ? ` (${JSON.stringify(value)})` : '';
    Kit.warn(`${where} expects ${expected.split('|').join(' or ')} but got ${actual}${shown}. Example: ${example}`);
    return false;
  };

  // ---- game registry -------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} GameInstance
   * @property {function(number, number): void} update called every frame with (dt, t) in game seconds
   * @property {function(): void} [dispose] called when the game is left or restarted
   * @property {function(): Object} [debugState] plain data describing the run right now (score, phase, positions);
   *   surfaced as `Kit.debug.state().state` to the developer overlay and to `node tools/dev.js play` predicates
   */

  /**
   * @typedef {Object} GameDefinition
   * @property {string} id unique id; also the save namespace and the smoke-test name
   * @property {string} name title on the menu
   * @property {string} tagline one line under the title
   * @property {string} hook the progression hook, shown on the menu card
   * @property {number} color accent colour as a hex number
   * @property {number} order menu position, ascending
   * @property {function(Object): GameInstance} create builds the game from the shell's `ctx`
   * @property {Object} [theme] the game's HUD theme (kit/theme.js); a game without one gets a development warning
   * @property {Object} [headless] the game's pure rules and data, usable without THREE or the DOM (tests, tools). Add
   *   `headless.progression` (`createState`, `actions`, `apply`, `summary`; see tools/sim.js) and `make sim GAME=<id>`
   *   plays the game's long arc for simulated hours. Read it with Kit.headlessOf, which also accepts the older
   *   names `model` and `lab`
   */

  /** A game id is a lowercase word: it becomes a save namespace, an element id (`card-<id>`) and a command-line argument. */
  const GAME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

  /**
   * Checks a game definition before it is registered. Pure: it reports problems and changes nothing.
   * @param {GameDefinition} definition
   * @param {Object} [known] what the definition is checked against
   * @param {GameDefinition[]} [known.games=Kit.games] the games already registered
   * @param {?string[]} [known.skins] valid `theme.skin` names; defaults to the skins of kit/theme.js when that is
   *   loaded, and null (skip the skin check) when it is not
   * @returns {{errors: string[], warnings: string[]}} each message names the cause and the fix; any error means
   *   the game cannot run
   * @complexity O(games) time for the duplicate-id scan, O(1) space
   * @example Kit.checkGame({ id: 'orbit', create: 5 }).errors // ['`create` must be a function ...']
   */
  Kit.checkGame = (definition, { games = Kit.games, skins = Kit.theme ? Object.keys(Kit.theme.SKINS) : null } = {}) => {
    if (!definition || typeof definition !== 'object') {
      return { errors: [`expected a definition object like { id: 'orbit', name: 'Orbit', create(ctx) { ... } } but got ${describeType(definition)}.`], warnings: [] };
    }
    const { id, name, create, theme } = definition;
    const hasId = typeof id === 'string' && id !== '';
    const sameId = hasId && games.find((game) => game.id === id);
    const skin = theme && theme.skin;
    const errorChecks = [
      [!hasId, "`id` is missing. Give the game a unique lowercase id, e.g. id: 'orbit' (it names the save slot, the menu card and the smoke test)."],
      [hasId && !GAME_ID_PATTERN.test(id), `id "${id}" must be lowercase letters, digits and dashes, starting with a letter (e.g. 'sky-stack').`],
      [sameId, `id "${id}" is already registered${sameId && sameId.name ? ` by "${sameId.name}"` : ''}. Pick another id, or remove the duplicate script tag if the file is loaded twice.`],
      [typeof create !== 'function', `\`create\` must be a function (ctx) => ({ update(dt, t) { ... } }) but got ${describeType(create)}.`],
      [skin !== undefined && skins && !skins.includes(skin), `theme.skin "${skin}" is not a skin. Use one of: ${(skins || []).join(', ')} (kit/theme.js), or leave skin out.`],
    ];
    const label = hasId ? `game "${id}"` : 'this game';
    const warningChecks = [
      [typeof name !== 'string' || !name, `${label} has no \`name\`, so its menu card has no title. Add name: 'Sky Stack'.`],
      [!theme, `${label} has no \`theme\`, so its HUD looks like every other default. Add theme: { skin, fonts, tokens } (see kit/theme.js).`],
    ];
    const messagesOf = (checks) => checks.filter(([isWrong]) => isWrong).map(([, message]) => message);
    return { errors: messagesOf(errorChecks), warnings: messagesOf(warningChecks) };
  };

  /** Property names a definition may carry its headless handle under, in order of preference (`headless` is the standard). */
  const HEADLESS_NAMES = ['headless', 'model', 'lab'];

  /**
   * The headless handle of a game: its pure rules and data, for tests and tools that never open a page.
   * @param {GameDefinition | string} game a definition, or the id of a registered game
   * @returns {?Object} the handle (`headless`, or the older `model` / `lab`), or null when the game has none
   * @complexity O(games) time when given an id (a scan of the registry), O(1) when given a definition
   * @example const { progression } = Kit.headlessOf('miner');
   */
  Kit.headlessOf = (game) => {
    const definition = typeof game === 'string' ? Kit.games.find((candidate) => candidate.id === game) : game;
    const name = definition ? HEADLESS_NAMES.find((candidate) => definition[candidate]) : undefined;
    return name ? definition[name] : null;
  };

  /**
   * Registers a game with the menu. Each game file calls this once at load. The definition is checked first
   * (Kit.checkGame): a definition that cannot run throws here, at the mistake, instead of failing later.
   * @param {GameDefinition} definition
   * @returns {number} how many games are now registered
   * @throws {Error} naming every problem and its fix (missing or duplicate id, `create` not a function, unknown skin)
   * @example Kit.register({ id: 'orbit', name: 'Orbit', theme: { skin: 'neon' }, create: (ctx) => ({ update(dt, t) {} }) });
   */
  Kit.register = (definition) => {
    const { errors, warnings } = Kit.checkGame(definition);
    if (errors.length) throw new Error(`Kit.register: ${errors.join(' Also: ')}`);
    warnings.forEach(Kit.warn);
    return Kit.games.push(definition);
  };
})();
