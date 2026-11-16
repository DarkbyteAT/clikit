/**
 * Dev tools progression simulator: plays a game's headless progression model with a bot policy for a span of
 * simulated time and analyses the curve that comes out.
 *
 * Owns:  the progression interface (below), the built-in policies, the simulation loop, the analysis (dead
 *        stretches, running out of new things, runaway growth) and the text report. All pure.
 * Does not own: loading the game (headless.js) or the command line (tools/sim.js).
 *
 * The interface a game exposes as `headless.progression` (four functions over the game's own state):
 *   createState()                  -> a fresh player (plain data or the game's Kit models)
 *   actions(state)                 -> [{ id, kind: 'play' | 'buy' | 'unlock', label?, cost?, affordable? }]
 *                                     everything the player could want now; `affordable: false` rows are shown
 *                                     to policies (a saver saves toward them) but never applied
 *   apply(state, action, random)   -> { seconds, state?, unlocked? }: does it; `seconds` of play it took,
 *                                     the next state when state is immutable, ids unlocked as a side effect
 *   summary(state)                 -> { currency, owned, remaining }: one number each for the curve
 */
'use strict';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
/** A run stops after this many actions even if simulated time has not run out: a model whose actions take no time would never end. */
const MAX_STEPS = 2000000;
/** Rows of the currency curve in the report. */
const CURVE_ROWS = 12;
const CURVE_BAR_WIDTH = 40;
const MOST_ACQUISITIONS_LISTED = 40;

/** Defaults of the analysis; each can be overridden from the command line. */
const ANALYSIS_DEFAULTS = {
  deadMinutes: 10, // longer than this with nothing new while something is still to get is a dead stretch
  runawayFactor: 20, // holding this many times the dearest price on offer means prices no longer bind
  earlyExhaustion: 0.5, // running out of new things before this fraction of the span is worth a warning
};

/**
 * Makes a seeded random source (mulberry32), so a simulation can be repeated exactly.
 * @param {number} seed any integer
 * @returns {function(): number} numbers in [0, 1)
 */
const seededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const isPlay = (action) => action.kind === 'play';
const isAffordable = (action) => action.affordable !== false;
const costOf = (action) => action.cost || 0;
/** The dearest of some actions, or undefined for none. */
const dearestOf = (actions) => actions.reduce((dearest, action) => (!dearest || costOf(action) > costOf(dearest) ? action : dearest), undefined);

/**
 * @typedef {function(Object[], function(): number): Object} Policy
 * Chooses one of the actions on offer. Receives every action (affordable or not) and a random source; must
 * return an affordable one.
 */

/** The built-in bot policies, by name. Adding a policy means adding a row. @type {Object<string, Policy>} */
const POLICIES = {
  /** Spends as soon as it can, on the dearest thing it can afford: the impatient player. */
  greedy: (actions) => dearestOf(actions.filter((action) => !isPlay(action) && isAffordable(action))) || actions.find(isPlay),
  /** Picks uniformly among what it can do: a lower bound on sensible play. */
  random: (actions, random) => {
    const possible = actions.filter(isAffordable);
    return possible[Math.floor(random() * possible.length)];
  },
  /** Saves for the dearest thing on offer and buys nothing else until it has it: the patient player. */
  saver: (actions) => {
    const target = dearestOf(actions.filter((action) => !isPlay(action)));
    return target && isAffordable(target) ? target : actions.find(isPlay) || dearestOf(actions.filter((action) => !isPlay(action) && isAffordable(action)));
  },
};

/**
 * @typedef {Object} RunLog
 * @property {Array<{time: number, id: string, kind: string, cost: number}>} acquisitions every purchase and unlock, in order
 * @property {Array<{time: number, currency: number, owned: number, remaining: number}>} samples the curve at even intervals
 * @property {number} seconds simulated time actually covered
 * @property {number} steps actions applied
 * @property {string} endedBecause 'time' | 'no actions' | 'step limit'
 * @property {number} dearestOnOffer price of the dearest thing still on offer at the end (0 when nothing is)
 */

/**
 * Plays a progression model with one policy.
 * @param {Object} progression the game's `headless.progression`
 * @param {Policy} policy
 * @param {{seconds: number, seed?: number, samples?: number}} options span of simulated play; seed; curve points
 * @returns {RunLog}
 * @throws {Error} when the model or the policy breaks the interface, naming which part and how
 * @complexity O(steps x actions on offer) time; O(acquisitions + samples) space
 * @example simulate(headless.progression, POLICIES.greedy, { seconds: 2 * 3600 }).acquisitions.length
 */
function simulate(progression, policy, { seconds, seed = 1, samples = CURVE_ROWS * 4 }) {
  const random = seededRandom(seed);
  const sampleEvery = seconds / samples;
  const log = { acquisitions: [], samples: [], seconds: 0, steps: 0, endedBecause: 'time', dearestOnOffer: 0 };
  let state = progression.createState();
  let time = 0;
  let nextSampleAt = sampleEvery;
  const sample = () => log.samples.push({ time, ...progression.summary(state) });
  sample();
  while (time < seconds) {
    const actions = progression.actions(state);
    if (!actions.length) {
      log.endedBecause = 'no actions';
      break;
    }
    if (log.steps >= MAX_STEPS) {
      log.endedBecause = 'step limit';
      break;
    }
    const action = policy(actions, random);
    if (!action || !isAffordable(action)) throw new Error(`the policy chose ${action ? `"${action.id}", which is not affordable` : 'nothing'}; a policy must return one of the affordable actions.`);
    const result = progression.apply(state, action, random) || {};
    if (!(result.seconds >= 0)) throw new Error(`progression.apply("${action.id}") must return { seconds } (0 or more), got ${JSON.stringify(result.seconds)}.`);
    if (result.state !== undefined) state = result.state;
    time += result.seconds;
    log.steps += 1;
    if (!isPlay(action)) log.acquisitions.push({ time, id: action.id, kind: action.kind, cost: costOf(action) });
    (result.unlocked || []).forEach((id) => log.acquisitions.push({ time, id, kind: 'unlock', cost: 0 }));
    // At most one sample per action, taken when a sampling interval has been crossed, so a long action is not sampled twice.
    if (time >= nextSampleAt) {
      sample();
      nextSampleAt = (Math.floor(time / sampleEvery) + 1) * sampleEvery;
    }
  }
  log.seconds = time;
  log.dearestOnOffer = costOf(dearestOf(progression.actions(state).filter((action) => !isPlay(action))) || {});
  sample();
  return log;
}

/** Formats simulated seconds as h:mm:ss. */
const formatClock = (seconds) => {
  const whole = Math.floor(seconds);
  const pad = (value) => String(value).padStart(2, '0');
  return `${Math.floor(whole / SECONDS_PER_HOUR)}:${pad(Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE))}:${pad(whole % SECONDS_PER_MINUTE)}`;
};

/**
 * @typedef {Object} RunAnalysis
 * @property {?number} exhaustedAt simulated seconds at which nothing new remained, or null if something still does
 * @property {{from: number, to: number}} longestGap the longest wait between two new things
 * @property {string[]} warnings each names what happened, when, and what to look at
 */

/**
 * Reads a run for the three things that make a long arc feel wrong: nothing new for a long time, nothing new
 * ever again, and money that no longer means anything.
 * @param {RunLog} log
 * @param {Partial<typeof ANALYSIS_DEFAULTS>} [options]
 * @returns {RunAnalysis}
 * @complexity O(acquisitions + samples) time and space
 */
function analyze(log, options = {}) {
  const { deadMinutes, runawayFactor, earlyExhaustion } = { ...ANALYSIS_DEFAULTS, ...options };
  const final = log.samples[log.samples.length - 1];
  const exhausted = final.remaining === 0 && log.acquisitions.length ? log.acquisitions[log.acquisitions.length - 1].time : final.remaining === 0 ? 0 : null;
  // The waits between new things: from the start to the first, between each pair, and (while something is left) to the end.
  const moments = [0, ...log.acquisitions.map((acquisition) => acquisition.time), ...(exhausted === null ? [log.seconds] : [])];
  const gaps = moments.slice(1).map((to, index) => ({ from: moments[index], to }));
  const longestGap = gaps.reduce((longest, gap) => (gap.to - gap.from > longest.to - longest.from ? gap : longest), { from: 0, to: 0 });
  const deadStretches = gaps.filter((gap) => gap.to - gap.from > deadMinutes * SECONDS_PER_MINUTE);
  const warnings = [
    ...deadStretches.map((gap) => `dead stretch: nothing new from ${formatClock(gap.from)} to ${formatClock(gap.to)} (${Math.round((gap.to - gap.from) / SECONDS_PER_MINUTE)} min). Add something to earn in between, or lower the price that follows.`),
    ...(exhausted !== null && exhausted < log.seconds * earlyExhaustion ? [`out of new things at ${formatClock(exhausted)}, ${Math.round((exhausted / log.seconds) * 100)}% into the span. The long arc ends there: add content or rules that unlock later.`] : []),
    ...(log.dearestOnOffer > 0 && final.currency >= runawayFactor * log.dearestOnOffer ? [`runaway growth: ${Math.round(final.currency)} currency against a dearest price of ${log.dearestOnOffer} (${Math.round(final.currency / log.dearestOnOffer)}x). Prices no longer bind: steepen the cost curves or add sinks.`] : []),
    ...(exhausted !== null && final.currency > 0 && log.samples.some((point) => point.time > exhausted && point.currency < final.currency) ? [`currency keeps growing after the last purchase (${Math.round(final.currency)} at the end) with nothing to spend it on.`] : []),
    ...(log.endedBecause !== 'time' ? [`the run stopped early (${log.endedBecause}) at ${formatClock(log.seconds)}.`] : []),
  ];
  return { exhaustedAt: exhausted, longestGap, warnings };
}

/**
 * Renders one policy's run as text: what was gained when, the currency curve, and the warnings.
 * @param {string} policyName
 * @param {RunLog} log
 * @param {RunAnalysis} analysis
 * @param {{listAll?: boolean}} [options]
 * @returns {string[]} report lines
 */
function report(policyName, log, analysis, { listAll = false } = {}) {
  const final = log.samples[log.samples.length - 1];
  const listed = listAll ? log.acquisitions : log.acquisitions.slice(0, MOST_ACQUISITIONS_LISTED);
  const peak = Math.max(1, ...log.samples.map((point) => point.currency));
  const stride = Math.max(1, Math.floor(log.samples.length / CURVE_ROWS));
  const curve = log.samples.filter((_point, index) => index % stride === 0 || index === log.samples.length - 1);
  return [
    `== policy: ${policyName} == ${formatClock(log.seconds)} simulated, ${log.steps} actions, ${log.acquisitions.length} new things, ${final.remaining} still to get`,
    '  time      new thing (cost)',
    ...listed.map((acquisition) => `  ${formatClock(acquisition.time)}   ${acquisition.kind} ${acquisition.id}${acquisition.cost ? ` (${acquisition.cost})` : ''}`),
    ...(listed.length < log.acquisitions.length ? [`  ... ${log.acquisitions.length - listed.length} more (--all lists them)`] : []),
    '  time      currency  owned',
    ...curve.map((point) => `  ${formatClock(point.time)}   ${String(Math.round(point.currency)).padStart(8)}  ${String(point.owned).padStart(5)}  ${'#'.repeat(Math.round((point.currency / peak) * CURVE_BAR_WIDTH))}`),
    `  longest wait for something new: ${formatClock(analysis.longestGap.from)} to ${formatClock(analysis.longestGap.to)}`,
    analysis.exhaustedAt === null ? '  never ran out of new things in this span' : `  ran out of new things at ${formatClock(analysis.exhaustedAt)}`,
    ...analysis.warnings.map((warning) => `  WARN ${warning}`),
  ];
}

module.exports = { POLICIES, ANALYSIS_DEFAULTS, seededRandom, simulate, analyze, report, formatClock };
