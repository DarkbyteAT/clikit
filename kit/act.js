/**
 * Kit act: performances. A performance is DATA - timed keys of a few body channels, plus the points a hand, a
 * foot or the body itself must reach - and this module runs it as a `Kit.motion` stage on any body that has
 * the parts. Channels address the body by role (the arms, the spine, the head, the feet), never by bone name,
 * and in units of the body's own size (leg lengths, arm lengths, radians), so a wave authored once plays on a
 * person, an elf with wings and a stout dwarf, and a body without arms simply cannot be asked to wave.
 *
 * QUICK USE (what a game calls):
 *   const motion = Kit.motion.state(bake, Kit.act.character());       // walks, breathes, blinks, looks about
 *   Kit.motion.advance(motion, dt, x, 0, z, heading);                 // every frame, as for any motion
 *   Kit.act.play(motion, 'wave');                                     // a one-shot over whatever it is doing
 *   Kit.act.play(motion, 'kick', { target: [ballX, ballY, ballZ] });  // the foot swings through that world point
 *   Kit.act.play(motion, 'dive', { target: [x, y, z] });              // dives to the side the point is on, hands to it
 *   Kit.act.aim(motion, 'target', x, y, z);                           // the point moved (a ball in flight)
 *   Kit.act.marks('dive').contact                                     // seconds into a dive that the hands arrive
 *   Kit.act.play(motion, 'dive', { target, reach: { mark: 'contact', in: 0.3 } }); // hands there in 0.3 s; landing as authored
 *   Kit.act.play(motion, 'save', { target, reach: { mark: 'contact', in: 0.4 } }); // a FAMILY: the form that gets there
 *   Kit.act.playing(motion)                                           // 'dive' (or the form a family chose) until it has finished
 *   Kit.act.takeRootMotion(motion, offset)                            // after a kick or a dive: where the body ended up
 *   Kit.act.base(motion, 'keeperReady');                              // the loop it returns to between one-shots
 *   Kit.act.lookAt(motion, x, y, z);                                  // head and gaze follow a point (kit/act-life.js)
 *   figure.face(Kit.act.face(motion));                                // show the blink / talk frames it chose
 * `Kit.act.REPERTOIRE` lists what can be played (kit/act-moves.js, kit/act-sport.js); `Kit.act.refusal(id, plan)`
 * says why a body cannot do one. `Kit.act.FAMILIES` lists the jobs that have several forms (`save`), and
 * `Kit.act.choose(motion, familyId, { target })` says which form a body would use for a point.
 *
 * Owns:  `CHANNELS` and `EASES` (the vocabulary of a performance), `performance` (check and compile a spec),
 *        `REPERTOIRE` / `define` (the performances by id), `FAMILIES` / `defineFamily` / `choose` (several
 *        performances for one job, chosen by where the point is against the body's own reach), `rig` (what a plan's roles are, measured once),
 *        `stage` (one performance as a stage, for `Kit.motion.sequence` / `layer` / `blend`), `performer` (a
 *        stage that plays whatever `play` asks, cross-fading, with a seeded schedule of idle fidgets) and its
 *        controls (`play`, `marks`, `stop`, `base`, `aim`, `point`, `playing`, `progress`, `rootMotion`, `keepInPlace`,
 *        `takeRootMotion`, `cast`), `refusal`,
 *        and the pieces other act modules share (`turnHead`, `turnShared`, `lookAngles`, `face`).
 * Does not own: the stage machinery (kit/motion.js), how legs walk (kit/gait.js; a performance that moves the
 *        body solves the legs with `Kit.gait.reachLeg`), the solvers (kit/reach.js), always-on life such as
 *        breathing and blinking (kit/act-life.js), the repertoire's rows, or drawing a face frame (the figure).
 *
 * How a performance reaches the pose: keys are interpolated in CHANNEL space with an easing per key (so
 * anticipation, overshoot and settle are a choice of curve, and two performances cross-fade without popping),
 * then each channel is applied by kinematics: the carrier bone is shifted and turned and every leg is solved
 * back to its foot (a crouch bends the knees because the feet stay where they are; a body thrown higher than
 * its legs reach lifts its feet), hands are placed by two-bone inverse kinematics, the spine and neck share a
 * turn between their bones. A `reach` pulls a hand or a foot to a world point given at call time; a `travel`
 * carries the body towards one.
 *
 * Rules every performance gets without asking (each a few lines in `poseActing`, tuned in `TUNING`): an arm
 * moved far between two keys goes round in front of the body, not out through a T; a keyed hand stays outside
 * the head; a hand pulled to a point leads the head there (the trunk tips off the line on a short-armed body)
 * and the body closes the last of the distance its arm cannot; a leg hanging in the air is drawn up by its
 * foot's keyed lift; a travel longer than its `stride` is run in steps.
 *
 * Conventions (kit/motion.js): metres, seconds, radians; +Y up; heading 0 faces +Z; "body frame" is left, up,
 * forward. A turn is [pitch, yaw, tilt]: pitch positive leans forward (nods down), yaw positive turns to the
 * body's left, tilt positive leans to the body's left.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-act.js.
 */
(() => {
  const { VECTOR_STRIDE, QUATERNION_STRIDE, QUATERNION_W } = Kit.rig;
  const { memory, refreshWorld } = Kit.motion;
  const NAME = 'Kit.act';
  const fail = (where, message) => {
    throw new Error(`${NAME}.${where}: ${message}`);
  };
  const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));
  const lerp = (from, to, amount) => from + (to - from) * amount;

  // ---- the vocabulary -------------------------------------------------------------------------------------------------

  /** The parts of a body a performance can move; each fades in and out as a whole. */
  const GROUP_NAMES = Object.freeze(['body', 'spine', 'head', 'armLeft', 'armRight', 'tail', 'wings', 'jaw']);
  const GROUP = Object.freeze(Object.fromEntries(GROUP_NAMES.map((name, index) => [name, index])));

  /**
   * The channels of a key, in buffer order. `size` numbers each; `group` is the part of the body that fades
   * with it; `mirror` are the signs a left-right mirror applies (default: none); `swap` is the channel it
   * trades places with in a mirror; `rest: true` means a key that leaves it out holds the body's own rest
   * value rather than 0.
   *   shift      [left, up, forward] of the whole body, in leg lengths (a crouch is [0, -0.2, 0])
   *   turn       [pitch, yaw, tilt] of the whole body about its hips
   *   carry      0..1: how far the feet's standing places have followed a `travel` (1 once the body has arrived)
   *   spine      [pitch, yaw, tilt] shared between the spine's bones above the hips
   *   head       [pitch, yaw, tilt] shared between the neck and the head
   *   armLeft /  [raise, front, extend, elbowOut]: where the hand is from the shoulder. `raise` is the angle from
   *   armRight   hanging straight down (pi / 2 level, pi overhead); `front` turns that about the vertical (0 out to
   *              the side, pi / 2 straight ahead, beyond it across the body, negative behind); `extend` is the
   *              hand's distance in arm lengths (1 straight, 0.5 well bent); `elbowOut` pushes the elbow away from
   *              the body (0 hangs it down and back, 1 wings it out). The hand is put there by `Kit.reach.twoBone`.
   *   footLeft / [out, up, forward, pitch]: the foot's place from where it stands at rest, in leg lengths, and its
   *   footRight  pitch (positive: toes down). The leg is solved to it by `Kit.gait.reachLeg`.
   *   tail       [pitch, yaw, tilt] of the base of every tail (the rest of the tail follows by simulation)
   *   wings      [lift, sweep, pitch] of the base of every wing, mirrored for the right one
   *   jaw        [open] radians
   * A key may also say `arms` or `feet` (both sides at once) and `face` ({ blink, talk }: a frame name of
   * `Kit.body.FRAME_SETS`, held until a later key changes it).
   */
  const CHANNELS = Object.freeze({
    shift: { size: 3, group: 'body', mirror: [-1, 1, 1] },
    turn: { size: 3, group: 'body', mirror: [1, -1, -1] },
    carry: { size: 1, group: 'body' },
    spine: { size: 3, group: 'spine', mirror: [1, -1, -1] },
    head: { size: 3, group: 'head', mirror: [1, -1, -1] },
    armLeft: { size: 4, group: 'armLeft', swap: 'armRight', rest: true },
    armRight: { size: 4, group: 'armRight', swap: 'armLeft', rest: true },
    footLeft: { size: 4, group: 'body', swap: 'footRight' },
    footRight: { size: 4, group: 'body', swap: 'footLeft' },
    tail: { size: 3, group: 'tail', mirror: [1, -1, -1] },
    wings: { size: 3, group: 'wings' },
    jaw: { size: 1, group: 'jaw' },
  });
  const CHANNEL_NAMES = Object.freeze(Object.keys(CHANNELS));
  /** Where each channel starts in a values buffer, and the buffer's length. */
  const OFFSET = Object.freeze(Object.fromEntries(CHANNEL_NAMES.map((name, index) => [name, CHANNEL_NAMES.slice(0, index).reduce((sum, other) => sum + CHANNELS[other].size, 0)])));
  const VALUE_COUNT = CHANNEL_NAMES.reduce((sum, name) => sum + CHANNELS[name].size, 0);
  /** The values that are sideways: every part of a channel that a mirror negates (a lean, a yaw, a tilt). */
  const SIDEWAYS_VALUES = Object.freeze(CHANNEL_NAMES.flatMap((name) => (CHANNELS[name].mirror || []).map((sign, part) => (sign < 0 ? OFFSET[name] + part : -1)).filter((at) => at >= 0)));
  /** A key's shorthand for both sides at once. */
  const BOTH = Object.freeze({ arms: ['armLeft', 'armRight'], feet: ['footLeft', 'footRight'] });
  /** The limbs a `reach` can pull, and which sides each means. */
  const REACH_LIMBS = Object.freeze({ handLeft: { hand: [0] }, handRight: { hand: [1] }, hands: { hand: [0, 1] }, footLeft: { foot: [0] }, footRight: { foot: [1] }, head: { head: true } });
  const SIDES = Object.freeze(['left', 'right']);
  /** +1 for the left side, -1 for the right: the sign of "out" along the body's left axis. */
  const SIDE_SIGN = Object.freeze([1, -1]);
  /** The `front` of an arm channel that points straight ahead, radians. */
  const AHEAD = Math.PI / 2;
  /** Metres under which a flat offset has no direction. */
  const TINY = 1e-6;
  /** Joints an arm needs to be posed as an arm: shoulder, elbow, hand. */
  const ARM_JOINTS = 3;

  const BACK_OVERSHOOT = 1.70158;
  /**
   * The easings a key can arrive with, name -> (0..1) -> 0..1. Besides every curve of `Kit.math.ease`:
   * `smooth` (ease in and out; the default), `in` and `out` (a fall under gravity and a rise against it),
   * `anticipate` (pulls back before it goes), `settle` (overshoots and comes back: `Kit.math.ease.outBack`) and
   * `snap` (fast, with a small overshoot).
   */
  const EASES = Object.freeze({
    ...Kit.math.ease,
    smooth: Kit.blend.smooth,
    in: (progress) => progress * progress,
    out: (progress) => 1 - (1 - progress) * (1 - progress),
    anticipate: (progress) => progress * progress * ((BACK_OVERSHOOT + 1) * progress - BACK_OVERSHOOT),
    settle: Kit.math.ease.outBack,
    snap: (progress) => 1 + (BACK_OVERSHOOT / 2 + 1) * (progress - 1) ** 3 + (BACK_OVERSHOOT / 2) * (progress - 1) ** 2,
  });

  /** Tunables of running a performance. */
  const TUNING = Object.freeze({
    fadeSeconds: 0.22, // cross-fade between two performances
    /** The lowest a `travel` that rises takes the hips at its arrival, in half-widths of the body above the ground: a body flying flat, on its side, not yet landed. */
    lowestFlight: 1.2,
    legStretch: 0.985, // the furthest a leg is asked to straighten (a dead-straight limb has no bend direction)
    stepLift: 0.22, // leg lengths a foot rises at the middle of a step of a stepped travel
    arcFrom: 1.1, // radians of raise an arm must cover between two keys before its hand is routed on an arc in front
    arcFront: 0.75, // how far towards straight ahead the arc pulls the arm at its middle, 0..1
    arcBend: 0.3, // and how much shorter the reach is there (the elbow bends): the hand never sweeps out through a T
    headClear: 1.05, // a hand keyed inside the head is moved out to this many head radii from its middle
    handLead: 0.1, // arm lengths a reaching hand is kept ahead of the head's surface along its reach, where the body can
    leadMost: 1.2, // radians the trunk will tip up off a reach line to let the hands lead (a short-armed, big-headed body)
    closeMost: 0.6, // arm lengths the body is moved to bring a point its hand is pulled to within the arm's reach
    leadBack: 0.35, // how much of that tipping is backwards rather than upwards
    hangTuck: 0.6, // the most of its length a hanging leg is drawn up by its foot's keyed lift
    hangTuckOver: 0.2, // leg lengths clear of the ground over which that drawing-up comes on
    hangPitch: 2.4, // radians a foot's toes drop per leg length it has been lifted clear by the body
    mostHangPitch: 0.9,
    armShortest: 0.18, // arm lengths: a hand is never asked closer to its shoulder than this
    armLongest: 0.995,
    elbowDown: 0.7, // the elbow hint in the body frame: down, back, and out by `elbowOut`
    elbowBack: 0.6,
    elbowAside: 0.25,
    neckShare: 0.4, // of a head turn taken by the neck; the head takes the rest
    mostLookYaw: 1.2, // radians a head will turn to look at a point
    mostLookPitch: 0.42,
    stillSpeed: 0.12, // metres per second in leg lengths per second: slower than this is standing (fidgets run)
    mostTargets: 4, // named points a performance may be given
  });

  // ---- performances: checking and compiling a spec -------------------------------------------------------------------

  /**
   * @typedef {Object} PerformanceKey
   * @property {number} at 0..1 through the performance; keys are listed in order
   * @property {string} [ease='smooth'] how the body ARRIVES at this key: a name of `Kit.act.EASES`
   * @property {number[]} [shift] and any other channel of `Kit.act.CHANNELS`, or `arms` / `feet` for both sides
   * @property {{blink?: string, talk?: string}} [face] frames of `Kit.body.FRAME_SETS`, held from this key on
   */

  /**
   * @typedef {Object} PerformanceReach
   * A hand, a foot or the gaze pulled to a world point given when the performance is played.
   * @property {string} limb 'handLeft', 'handRight', 'hands', 'footLeft', 'footRight' or 'head'
   * @property {string} target the name of the point (`Kit.act.play(motion, id, { [target]: [x, y, z] })`)
   * @property {number[]} in [from, to]: the pull comes on between these fractions of the performance
   * @property {number[]} [out] [from, to]: and lets go between these (default: held to the end)
   * @property {number[]} [offset] [out, up, forward] added to the point, in the limb's own lengths, body frame
   * @property {boolean} [ground=false] a foot only: it stands on the ground under the point (a plant foot beside a ball)
   */

  /**
   * @typedef {Object} PerformanceTravel
   * The body carried towards a named point: sideways and forwards it goes and stays (the game collects the
   * move with `takeRootMotion`); upwards it rises to the point and falls back, as a thrown body does.
   * @property {string} target the name of the point
   * @property {number} start 0..1: when the body leaves
   * @property {number} arrive 0..1: when it is there (and at its highest)
   * @property {number} [land] 0..1: when it is back at the height its keys give (default: it does not rise)
   * @property {number} [keep=0] how far short of the point the hips stop, in `reach` lengths (hips to hand)
   * @property {number} [most=1] the furthest it goes sideways and forwards, in statures (the body's standing height)
   * @property {number} [mostUp=0.4] the highest it rises, in statures
   * @property {number[]} [axes=[1, 1, 1]] which of left, up, forward it travels along
   * @property {number} [stride] leg lengths one step covers: a travel longer than this is run in steps, the feet
   *   landing in turn ahead of the body, the last step taken by the foot a `ground` reach plants (default: one lunge)
   */

  /**
   * @typedef {Object} PerformanceSpec
   * @property {string} id
   * @property {string} [label] for a picker (default: the id)
   * @property {number} seconds how long one play (or one loop) lasts
   * @property {boolean} [loop=false] a loop wraps from its last key to its first
   * @property {boolean} [hold=false] a one-shot that stays on its last key until something else is played
   * @property {Object} [needs] a requirement spec for `Kit.body.requirement` ({ needs, atLeast })
   * @property {string} [side] 'left' or 'right': the side it is authored for; played mirrored for the other
   * @property {string} [sideBy] the name of a target: the side is the one that point is on
   * @property {boolean} [leanBySide=false] with `sideBy`: the sideways parts of its keys (the lean, yaw and tilt of the
   *   body, spine and head) play in proportion to how far to the side the point is, in full at an arm's length, so a
   *   point straight ahead is met squarely instead of leaning the shoulder away from it
   * @property {Object<string, number[]>} [defaults] target name -> [left, up, forward] from where the body stands, in
   *   units of how high its hands reach (`ActRig.high`; its standing height when it has no arms): where the
   *   point is when the caller gives none, so a default is within reach of a long body and a squat one alike
   * @property {Object<string, number>} [marks] named moments on its own timeline, each 0..1 through it (`contact`,
   *   `release`, `land`): a game reads them with `Kit.act.marks` and can ask `play` to meet one at a given time
   * @property {string} [defaultsIn='high'] what the defaults are measured in: 'high' (hand-reach heights) or 'legs'
   *   (leg lengths: for a point a foot must meet, such as a ball to kick)
   * @property {PerformanceKey[]} keys
   * @property {PerformanceReach[]} [reaches]
   * @property {PerformanceTravel} [travel]
   */

  const requireNumbers = (where, what, value, size) => {
    if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) fail(where, `${what} must be ${size} number${size === 1 ? '' : 's'}, got ${JSON.stringify(value)}.`);
    return value;
  };
  const requireSpan = (where, what, value) => {
    requireNumbers(where, what, value, 2);
    if (!(value[0] >= 0 && value[1] <= 1 && value[0] < value[1])) fail(where, `${what} must be [from, to] with 0 <= from < to <= 1, got ${JSON.stringify(value)}.`);
    return value;
  };

  /** One key's channels written into a row of the values buffer; a channel the key leaves out stays at its default. */
  const writeKey = (where, key, values, at, used) => {
    Object.keys(key).forEach((field) => {
      if (field === 'at' || field === 'ease' || field === 'face') return;
      const names = BOTH[field] || (CHANNELS[field] ? [field] : null);
      if (!names) fail(where, `a key has no channel "${field}". Channels: ${CHANNEL_NAMES.join(', ')}, arms, feet, face.`);
      names.forEach((name) => {
        const numbers = requireNumbers(where, `the "${field}" of the key at ${key.at}`, typeof key[field] === 'number' ? [key[field]] : key[field], CHANNELS[name].size);
        values.set(numbers, at + OFFSET[name]);
        used.add(name);
      });
    });
  };

  /** The frame a face set shows at each key: the index in the set, or -1 until a key first names one. */
  const faceTrack = (where, keys, set) => {
    let held = -1;
    return Int8Array.from(keys, (key) => {
      const name = key.face && key.face[set];
      if (name === undefined) return held;
      held = Kit.body.FRAME_SETS[set].indexOf(name);
      if (held < 0) fail(where, `the face set "${set}" has no frame "${name}". Frames: ${Kit.body.FRAME_SETS[set].join(', ')}.`);
      return held;
    });
  };

  /**
   * Checks a performance spec and compiles it to flat buffers, once. Everything a typo can break is refused
   * here with the fix, so a performance that compiles cannot fail while it plays.
   * @param {PerformanceSpec} spec
   * @returns {Object} the compiled performance, frozen: pass it to `Kit.act.stage`, `play` or `define`
   * @throws {Error} naming the key, channel, ease, limb or span that is wrong
   * @complexity O(keys x channels) time and space, once
   * @example
   * const nod = Kit.act.performance({ id: 'nod', seconds: 0.8, keys: [{ at: 0.4, ease: 'out', head: [0.35, 0, 0] }] });
   */
  const performance = (spec) => {
    if (!spec || typeof spec.id !== 'string' || !spec.id) fail('performance', 'a performance needs an `id`.');
    const where = `performance("${spec.id}")`;
    if (!(spec.seconds > 0)) fail(where, `\`seconds\` must be a positive number, got ${spec.seconds}.`);
    if (!Array.isArray(spec.keys) || !spec.keys.length) fail(where, 'needs at least one key: { at, ...channels }.');
    if (spec.side !== undefined && !SIDES.includes(spec.side)) fail(where, `\`side\` is 'left' or 'right', got ${JSON.stringify(spec.side)}.`);
    spec.keys.forEach((key, index) => {
      if (!(key.at >= 0 && key.at <= 1) || (index > 0 && key.at <= spec.keys[index - 1].at)) fail(where, `key ${index} is at ${key.at}; keys are listed in order with \`at\` rising from 0 to 1.`);
      if (key.ease !== undefined && !EASES[key.ease]) fail(where, `key ${index} arrives with the unknown ease "${key.ease}". Eases: ${Object.keys(EASES).join(', ')}.`);
    });
    // A one-shot starts from the body as it stands and (unless it holds) returns to it: those keys are implied.
    const first = spec.keys[0];
    const last = spec.keys[spec.keys.length - 1];
    const keys = spec.loop ? spec.keys : [...(first.at > 0 ? [{ at: 0 }] : []), ...spec.keys, ...(last.at < 1 ? [spec.hold ? { ...last, at: 1, ease: 'linear' } : { at: 1 }] : [])];
    const used = new Set();
    const values = new Float32Array(keys.length * VALUE_COUNT);
    // A key that leaves an arm out holds the body's rest arm, whatever that is on this body: marked NaN until it is played.
    const restAt = CHANNEL_NAMES.filter((name) => CHANNELS[name].rest).flatMap((name) => Array.from({ length: CHANNELS[name].size }, (_unused, index) => OFFSET[name] + index));
    keys.forEach((key, index) => {
      restAt.forEach((at) => (values[index * VALUE_COUNT + at] = Number.NaN));
      writeKey(where, key, values, index * VALUE_COUNT, used);
    });
    const targets = [];
    const targetIndex = (name) => {
      if (typeof name !== 'string' || !name) fail(where, 'a reach or a travel needs the name of its `target` point.');
      if (!targets.includes(name)) targets.push(name);
      if (targets.length > TUNING.mostTargets) fail(where, `uses more than ${TUNING.mostTargets} named points.`);
      return targets.indexOf(name);
    };
    const reaches = (spec.reaches || []).map((reach) => {
      const limb = REACH_LIMBS[reach.limb];
      if (!limb) fail(where, `a reach names the limb "${reach.limb}". Limbs: ${Object.keys(REACH_LIMBS).join(', ')}.`);
      requireSpan(where, `the \`in\` of the ${reach.limb} reach`, reach.in);
      if (reach.out) requireSpan(where, `the \`out\` of the ${reach.limb} reach`, reach.out);
      return Object.freeze({
        ...limb,
        target: targetIndex(reach.target),
        in: reach.in.slice(),
        out: reach.out ? reach.out.slice() : null,
        offset: requireNumbers(where, 'a reach `offset`', reach.offset || [0, 0, 0], VECTOR_STRIDE).slice(),
        ground: reach.ground === true,
      });
    });
    reaches.forEach((reach) => {
      if (reach.hand) reach.hand.forEach((side) => used.add(side ? 'armRight' : 'armLeft'));
      if (reach.foot) used.add('shift');
      if (reach.head) used.add('head');
    });
    const travelSpec = spec.travel;
    if (
      travelSpec &&
      !(travelSpec.start >= 0 && travelSpec.arrive > travelSpec.start && travelSpec.arrive <= 1 && (travelSpec.land === undefined || (travelSpec.land > travelSpec.arrive && travelSpec.land <= 1)))
    )
      fail(where, `a travel needs 0 <= start < arrive (< land) <= 1, got ${JSON.stringify(travelSpec)}.`);
    const travel = travelSpec
      ? Object.freeze({
          keep: 0,
          most: 1,
          mostUp: 0.4,
          land: -1,
          ...travelSpec,
          target: targetIndex(travelSpec.target),
          axes: requireNumbers(where, 'a travel `axes`', travelSpec.axes || [1, 1, 1], VECTOR_STRIDE).slice(),
        })
      : null;
    if (travel) used.add('shift');
    const defaults = new Float32Array(TUNING.mostTargets * VECTOR_STRIDE);
    targets.forEach((name, index) => {
      if (spec.sideBy !== undefined && !targets.includes(spec.sideBy)) fail(where, `\`sideBy\` names "${spec.sideBy}", which no reach or travel uses.`);
      defaults.set(
        requireNumbers(where, `the default of the point "${name}" (\`defaults.${name}\`: [left, up, forward] in hand-reach heights)`, (spec.defaults || {})[name], VECTOR_STRIDE),
        index * VECTOR_STRIDE
      );
    });
    const marks = {};
    Object.keys(spec.marks || {}).forEach((name) => {
      const at = spec.marks[name];
      if (!(at >= 0 && at <= 1)) fail(where, `the mark "${name}" must be a moment 0..1 through the performance, got ${JSON.stringify(at)}.`);
      marks[name] = at * spec.seconds;
    });
    const uses = new Uint8Array(GROUP_NAMES.length);
    used.forEach((name) => (uses[GROUP[CHANNELS[name].group]] = 1));
    const movesBody = uses[GROUP.body] === 1;
    // Legs are needed only by what works them: a foot channel, a foot pulled to a point, or a body carried somewhere.
    const standsOnLegs = used.has('footLeft') || used.has('footRight') || reaches.some((reach) => reach.foot) || Boolean(travel);
    return Object.freeze({
      id: spec.id,
      label: spec.label || spec.id,
      seconds: spec.seconds,
      loop: Boolean(spec.loop),
      hold: Boolean(spec.hold),
      needs: spec.needs ? Kit.body.requirement(spec.needs) : null,
      movesBody,
      standsOnLegs,
      side: spec.side ? SIDES.indexOf(spec.side) : -1,
      sideBy: spec.sideBy === undefined ? -1 : targets.indexOf(spec.sideBy),
      leanBySide: Boolean(spec.leanBySide) && spec.sideBy !== undefined,
      defaultsInLegs: spec.defaultsIn === 'legs',
      keyCount: keys.length,
      times: Float32Array.from(keys, (key) => key.at),
      eases: keys.map((key) => EASES[key.ease || 'smooth']),
      values,
      uses,
      blink: faceTrack(where, keys, 'blink'),
      talk: faceTrack(where, keys, 'talk'),
      reaches: Object.freeze(reaches),
      travel,
      targets: Object.freeze(targets),
      defaults,
      marks: Object.freeze(marks),
    });
  };

  /**
   * The performances that can be played by id. Open: `Kit.act.define(spec)` adds a row (kit/act-moves.js and
   * kit/act-sport.js fill it), and every row appears on the acts proof sheet for every body that can do it.
   * @type {Object<string, Object>}
   */
  const REPERTOIRE = {};

  /**
   * Compiles a performance spec and adds it to the repertoire under its id.
   * @param {PerformanceSpec} spec
   * @returns {Object} the compiled performance
   * @throws {Error} as `performance`, or when the id is already taken
   * @complexity as `performance`
   * @example Kit.act.define({ id: 'nod', seconds: 0.8, keys: [{ at: 0.4, head: [0.35, 0, 0] }] }); Kit.act.play(motion, 'nod');
   */
  const define = (spec) => {
    const compiled = performance(spec);
    if (REPERTOIRE[compiled.id]) fail('define', `the repertoire already has a performance "${compiled.id}".`);
    REPERTOIRE[compiled.id] = compiled;
    return compiled;
  };

  /**
   * @typedef {Object} FamilyForm
   * One way of doing a family's job, and where its point must be for it to be the way chosen.
   * @property {string} play the id of a performance of the repertoire that is given the family's point
   * @property {number[]} [aside=[0, Infinity]] [from, to): how far to the side of the body the point is, in arm
   *   spans (`ActRig.span`: the body's middle to the end of an arm held out sideways)
   * @property {number[]} [up=[0, Infinity]] [from, to): how high above the ground it is, in hand-reach heights
   *   (`ActRig.high`: as high as a hand goes with the feet on the ground)
   */

  /**
   * @typedef {Object} FamilySpec
   * Several performances that do one job (stop a ball), told apart by where the point is relative to the body's
   * own reach: a game names the family and the point, and the body does whichever form gets there.
   * @property {string} id
   * @property {string} [label=id]
   * @property {string} [target='target'] the named point the choice is made by
   * @property {FamilyForm[]} forms in order: the first whose spans hold the point is chosen, the last when none does
   */

  /** Families by id: `Kit.act.play` takes one wherever it takes a performance. Open: `Kit.act.defineFamily` adds a row. */
  const FAMILIES = {};
  const ANYWHERE = Object.freeze([0, Infinity]);

  /**
   * Checks a family and adds it under its id.
   * @param {FamilySpec} spec
   * @returns {Object} the family, frozen
   * @throws {Error} naming the first thing wrong with it: an id already taken, no forms, a form that is not a
   *   performance of the repertoire or does not take the family's point, a span that is not [from, to)
   * @complexity O(forms)
   * @example
   * Kit.act.defineFamily({ id: 'greet', forms: [{ play: 'bow', aside: [0, 1] }, { play: 'wave' }] });
   */
  const defineFamily = (spec) => {
    const where = 'defineFamily';
    if (!spec || typeof spec.id !== 'string' || !spec.id) fail(where, `a family needs an \`id\`, got ${JSON.stringify(spec && spec.id)}.`);
    if (FAMILIES[spec.id] || REPERTOIRE[spec.id]) fail(where, `"${spec.id}" is already ${FAMILIES[spec.id] ? 'a family' : 'a performance'}.`);
    if (!Array.isArray(spec.forms) || !spec.forms.length) fail(where, `the family "${spec.id}" needs \`forms\`: at least one { play: performanceId }.`);
    const target = spec.target || 'target';
    const forms = spec.forms.map((form, index) => {
      const compiled = REPERTOIRE[form && form.play];
      if (!compiled) fail(where, `form ${index} of "${spec.id}" plays ${JSON.stringify(form && form.play)}, which is not in the repertoire: ${Object.keys(REPERTOIRE).join(', ')}.`);
      if (!compiled.targets.includes(target)) fail(where, `form "${form.play}" of "${spec.id}" takes no point named "${target}" (it takes: ${compiled.targets.join(', ') || 'none'}).`);
      ['aside', 'up'].forEach((name) => {
        const span = form[name];
        if (span !== undefined && !(Array.isArray(span) && span.length === 2 && span[0] >= 0 && span[1] > span[0]))
          fail(where, `\`${name}\` of form "${form.play}" of "${spec.id}" must be [from, to) with 0 <= from < to, got ${JSON.stringify(span)}.`);
      });
      return Object.freeze({ play: form.play, compiled, aside: Object.freeze([...(form.aside || ANYWHERE)]), up: Object.freeze([...(form.up || ANYWHERE)]) });
    });
    const family = Object.freeze({ id: spec.id, label: spec.label || spec.id, target, forms: Object.freeze(forms) });
    FAMILIES[spec.id] = family;
    return family;
  };

  /** A compiled performance from an id, a spec or a compiled performance. */
  const resolve = (where, performanceOrId) => {
    if (typeof performanceOrId === 'string')
      return (
        REPERTOIRE[performanceOrId] ||
        fail(
          where,
          FAMILIES[performanceOrId]
            ? `"${performanceOrId}" is a family of performances: which one is played depends on the point. Ask \`Kit.act.choose(motion, "${performanceOrId}", { ${FAMILIES[performanceOrId].target}: [x, y, z] })\` for its id first.`
            : `no performance "${performanceOrId}". Repertoire: ${Object.keys(REPERTOIRE).join(', ')}. Families: ${Object.keys(FAMILIES).join(', ') || 'none'}.`
        )
      );
    if (performanceOrId && performanceOrId.values instanceof Float32Array) return performanceOrId;
    return performance(performanceOrId);
  };

  // ---- what a plan's roles are ------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} ActRig
   * A plan's parts as performances address them, measured once from the plan and a proportioned rest pose.
   * @property {number} carrier the bone the body is carried by (`Kit.motion.carrier`)
   * @property {?Object} legs the `LegRig` of kit/gait.js, or null for a body that cannot stand on legs
   * @property {number} unit metres a `shift` of 1 moves the body: its leg length (half its height without legs)
   * @property {number} stature metres from its lowest point to its highest at rest: what travel caps scale by
   * @property {number} headRadius metres: half the head bone's height, the ball a keyed hand is kept out of (0 without a head)
   * @property {number} high metres from its lowest point to as high as a hand reaches (the stature without arms): what default points scale by
   * @property {number} reach metres from the hips to the end of an outstretched arm (0 without arms)
   * @property {number} halfWidth metres from the body's middle to a shoulder (a tenth of the stature without arms): how high it lies on its side
   * @property {number} span metres from the body's middle to the end of an arm held out sideways (0 without arms)
   * @property {Int16Array} spine the spine's bones above the carrier
   * @property {Int16Array} neck
   * @property {number} head the head bone, or -1
   * @property {number} jaw the jaw bone, or -1
   * @property {Int16Array} tails the base bone of every tail
   * @property {Int16Array} wings the base bone of every wing
   * @property {Int8Array} wingSign per wing: +1 left, -1 right
   * @property {Int16Array} armUpper per side (left, right): the shoulder bone, or -1 without an arm of 3 bones there
   * @property {Int16Array} armMiddle per side: the elbow bone
   * @property {Int16Array} armEnd per side: the wrist bone
   * @property {Float32Array} armLength per side: shoulder to wrist along the bones, metres
   * @property {Float32Array} armRest 4 per side: the rest pose's hand as an arm channel
   * @property {Int16Array} footLeg per side: the leg (in the leg rig's order) the foot channel of that side moves
   * @property {Float32Array} frame 4 per bone: the rest world rotation of the bone's parent (`Kit.motion.restFrames`)
   * @property {Float32Array} stretch what the root stretches offsets by: left, up, forward
   * @property {Int16Array[]} groupBones per `GROUP`: the bones a fade of that group mixes
   */

  /** @type {WeakMap<Object, ActRig>} */
  const rigByRest = new WeakMap();
  const WALK_STAGE = Kit.gait.plant();

  /**
   * Measures a plan's parts for performing: which bones are its spine, neck, head, arms, tails and wings, how
   * long its arms are and where its hands rest. Remembered per rest pose, so every instance of a bake shares one.
   * @param {Object} plan a `BodyPlan`
   * @param {Object} rest its proportioned rest pose (a bake's `rest`)
   * @returns {ActRig} frozen
   * @complexity O(bones) time once per rest pose, O(1) after
   * @example Kit.act.rig(bake.plan, bake.rest).armLength[0] // the left arm, metres
   */
  const rig = (plan, rest) => {
    const known = rigByRest.get(rest);
    if (known) return known;
    const world = Kit.body.worldTransforms(plan, rest, Kit.rig.create(plan.boneCount));
    const at = (bone, axis) => world.translation[bone * VECTOR_STRIDE + axis];
    const between = (from, to) => Math.hypot(at(to, 0) - at(from, 0), at(to, 1) - at(from, 1), at(to, 2) - at(from, 2));
    const maskOf = (...roles) => Kit.body.roleMask(roles);
    const bonesOf = (...roles) => Kit.body.bonesWithRoles(plan, maskOf(...roles));
    const carrier = Kit.motion.carrier(plan);
    const legs = Kit.motion.refusal(WALK_STAGE, plan, rest) ? null : Kit.gait.legs(plan, rest);
    const heights = Array.from({ length: plan.boneCount }, (_unused, bone) => at(bone, 1));
    const sideOfBone = (bone) => (plan.roles[bone] & maskOf('left') ? 0 : plan.roles[bone] & maskOf('right') ? 1 : at(bone, 0) >= 0 ? 0 : 1);
    // One arm a side: the primary one when a body has several; it needs a shoulder, an elbow and a wrist to be placed.
    const primary = maskOf('primary');
    const armChains = Kit.body.chains(plan, maskOf('arm')).filter((chain) => chain.length >= ARM_JOINTS);
    const armOf = (side) => {
      const onSide = armChains.filter((chain) => sideOfBone(chain[0]) === side);
      return onSide.find((chain) => plan.roles[chain[0]] & primary) || onSide[0] || null;
    };
    const arms = SIDES.map((_side, side) => armOf(side));
    const armLength = Float32Array.from(arms, (chain) => (chain ? between(chain[0], chain[1]) + between(chain[1], chain[2]) : 0));
    const armRest = new Float32Array(SIDES.length * CHANNELS.armLeft.size);
    arms.forEach((chain, side) => {
      if (!chain) return;
      const offset = [0, 1, 2].map((axis) => at(chain[2], axis) - at(chain[0], axis));
      const distance = Math.hypot(...offset) || 1;
      armRest.set(
        [Math.acos(clamp(-offset[1] / distance, -1, 1)), Math.atan2(offset[2], offset[0] * SIDE_SIGN[side]), clamp(distance / armLength[side], TUNING.armShortest, TUNING.armLongest), 0],
        side * CHANNELS.armLeft.size
      );
    });
    const legOf = (side) => {
      if (!legs) return -1;
      const onSide = Array.from({ length: legs.count }, (_unused, leg) => leg).filter((leg) => legs.side[leg] === (side ? 2 : 0));
      const chosen = onSide.find((leg) => plan.roles[legs.upper[leg]] & primary);
      return chosen === undefined ? (onSide.length ? onSide[0] : -1) : chosen;
    };
    const frame = Kit.motion.restFrames(plan, rest);
    const spine = bonesOf('spine').filter((bone) => bone !== carrier);
    const neck = bonesOf('neck');
    const [head = -1] = bonesOf('head');
    const [jaw = -1] = bonesOf('jaw');
    const tails = Kit.body.chains(plan, maskOf('tail')).map((chain) => chain[0]);
    const wingChains = Kit.body.chains(plan, maskOf('wing'));
    const legBones = legs ? Array.from({ length: plan.boneCount }, (_unused, bone) => bone).filter((bone) => plan.roles[bone] & maskOf('leg')) : [];
    // How tall it stands: the highest joint or bone end above the lowest.
    const tops = heights.map((height, bone) => Math.max(height, Kit.body.tailPosition(plan, world, bone, [0, 0, 0])[1]));
    const shoulderHeight = arms.filter(Boolean).reduce((highest, chain) => Math.max(highest, at(chain[0], 1)), at(carrier, 1));
    const measured = Object.freeze({
      carrier,
      legs,
      unit: legs ? legs.legLength : (Math.max(...heights) - Math.min(...heights)) / 2 || 1,
      stature: Math.max(...tops) - Math.min(...heights, ...tops) || 1,
      headRadius: head >= 0 ? Math.max(0, tops[head] - heights[head]) / 2 : 0,
      high: Math.max(...armLength) > 0 ? shoulderHeight - Math.min(...heights, ...tops) + Math.max(...armLength) : Math.max(...tops) - Math.min(...heights, ...tops) || 1,
      reach: Math.max(...armLength) > 0 ? shoulderHeight - at(carrier, 1) + Math.max(...armLength) : 0,
      halfWidth: arms.reduce((widest, chain) => (chain ? Math.max(widest, Math.abs(at(chain[0], 0))) : widest), 0) || (Math.max(...tops) - Math.min(...heights, ...tops)) / 10 || 1,
      span: arms.reduce((widest, chain, side) => (chain ? Math.max(widest, Math.abs(at(chain[0], 0)) + armLength[side]) : widest), 0),
      spine: Int16Array.from(spine),
      neck: Int16Array.from(neck),
      head,
      jaw,
      tails: Int16Array.from(tails),
      wings: Int16Array.from(wingChains, (chain) => chain[0]),
      wingSign: Int8Array.from(wingChains, (chain) => SIDE_SIGN[sideOfBone(chain[0])]),
      armUpper: Int16Array.from(arms, (chain) => (chain ? chain[0] : -1)),
      armMiddle: Int16Array.from(arms, (chain) => (chain ? chain[1] : -1)),
      armEnd: Int16Array.from(arms, (chain) => (chain ? chain[2] : -1)),
      armLength,
      armRest,
      footLeg: Int16Array.from(SIDES, (_side, side) => legOf(side)),
      frame,
      stretch: Float32Array.from([world.scale[0], world.scale[1], world.scale[2]]),
      groupBones: GROUP_NAMES.map((name) =>
        Int16Array.from(
          {
            body: [carrier, ...legBones],
            spine,
            head: [...neck, ...(head >= 0 ? [head] : [])],
            armLeft: arms[0] ? arms[0].slice(0, 2) : [],
            armRight: arms[1] ? arms[1].slice(0, 2) : [],
            tail: tails,
            wings: wingChains.map((chain) => chain[0]),
            jaw: jaw >= 0 ? [jaw] : [],
          }[name]
        )
      ),
    });
    rigByRest.set(rest, measured);
    return measured;
  };

  /** What a performance needs of a plan, as stage needs (kit/motion.js): its own requirement, and legs to stand on when it works them (a body without legs still bows, turns and waves). */
  const needsOf = (compiled) => [
    ...(compiled.needs ? [{ consumer: `the "${compiled.id}" performance`, requirement: compiled.needs }] : []),
    ...(compiled.standsOnLegs ? WALK_STAGE.needs.map((need) => ({ ...need, consumer: `the "${compiled.id}" performance` })) : []),
  ];

  /**
   * Why a body cannot do a performance, in words, or null when it can.
   * @param {string|Object} performanceOrId an id of the repertoire, a spec or a compiled performance
   * @param {Object} plan a `BodyPlan`
   * @param {Object} [rest] its proportioned rest pose
   * @returns {?string} e.g. 'the "wave" performance cannot move the plan "quadruped": it lacks arms. This plan has: ...'
   * @throws {Error} for an unknown id
   * @complexity O(needs x capabilities); call it at setup, not per frame
   * @example Kit.act.refusal('wave', houndBake.plan) // '... it lacks arms. ...'
   */
  const refusal = (performanceOrId, plan, rest) => Kit.motion.refusal({ name: 'act', pose: () => {}, needs: needsOf(resolve('refusal', performanceOrId)) }, plan, rest);

  // ---- small kinematics -------------------------------------------------------------------------------------------------

  const scratchTurn = new Float32Array(QUATERNION_STRIDE);
  const scratchPoint = new Float32Array(VECTOR_STRIDE);
  const scratchAngles = new Float32Array(2);

  /** out = first * second for quaternions held as four numbers each (out may be either). */
  const multiplyInto = (out, outAt, firstX, firstY, firstZ, firstW, secondX, secondY, secondZ, secondW) => {
    out[outAt] = firstW * secondX + firstX * secondW + firstY * secondZ - firstZ * secondY;
    out[outAt + 1] = firstW * secondY - firstX * secondZ + firstY * secondW + firstZ * secondX;
    out[outAt + 2] = firstW * secondZ + firstX * secondY - firstY * secondX + firstZ * secondW;
    out[outAt + QUATERNION_W] = firstW * secondW - firstX * secondX - firstY * secondY - firstZ * secondZ;
  };

  /** `Kit.motion.turnBody` for a bone of a measured rig: [pitch, yaw, tilt] about the body's axes. */
  const turnBody = (rotation, measured, bone, pitch, yaw, tilt) => Kit.motion.turnBody(rotation, measured.frame, bone, pitch, yaw, tilt);

  /**
   * The same body-frame turn shared evenly between a list of bones: a spine bends along its length.
   * @param {Float32Array} rotation the pose's local rotations
   * @param {ActRig} measured from `Kit.act.rig`
   * @param {ArrayLike<number>} bones
   * @param {number} pitch radians in all, positive forwards
   * @param {number} yaw radians in all, positive towards the body's left
   * @param {number} tilt radians in all, positive towards the body's left
   * @returns {void}
   * @complexity O(bones), no allocation
   * @example Kit.act.turnShared(motion.pose.rotation, rig, rig.spine, 0.3, 0, 0);   // the spine curls forward
   */
  const turnShared = (rotation, measured, bones, pitch, yaw, tilt) => {
    for (let index = 0; index < bones.length; index++) turnBody(rotation, measured, bones[index], pitch / bones.length, yaw / bones.length, tilt / bones.length);
  };

  /**
   * A head turn, split between the neck's bones and the head, on top of what they have.
   * @param {Float32Array} rotation the pose's local rotations
   * @param {ActRig} measured from `Kit.act.rig`
   * @param {number} pitch radians, positive nods down
   * @param {number} yaw radians, positive towards the body's left
   * @param {number} tilt radians, positive towards the body's left
   * @returns {void}
   * @complexity O(neck bones), no allocation
   * @example Kit.act.turnHead(motion.pose.rotation, Kit.act.rig(plan, rest), 0, 0.4, 0);   // looks left
   */
  const turnHead = (rotation, measured, pitch, yaw, tilt) => {
    const neckShare = measured.neck.length && measured.head >= 0 ? TUNING.neckShare : measured.neck.length ? 1 : 0;
    turnShared(rotation, measured, measured.neck, pitch * neckShare, yaw * neckShare, tilt * neckShare);
    if (measured.head >= 0) turnBody(rotation, measured, measured.head, pitch * (1 - neckShare), yaw * (1 - neckShare), tilt * (1 - neckShare));
  };

  /** Rotates a vector by a quaternion held at an index of a buffer; writes `scratchPoint`. */
  const rotateBy = (rotations, at, x, y, z) => {
    const quaternionX = rotations[at];
    const quaternionY = rotations[at + 1];
    const quaternionZ = rotations[at + 2];
    const quaternionW = rotations[at + QUATERNION_W];
    const crossX = quaternionY * z - quaternionZ * y;
    const crossY = quaternionZ * x - quaternionX * z;
    const crossZ = quaternionX * y - quaternionY * x;
    scratchPoint[0] = x + 2 * (quaternionW * crossX + quaternionY * crossZ - quaternionZ * crossY);
    scratchPoint[1] = y + 2 * (quaternionW * crossY + quaternionZ * crossX - quaternionX * crossZ);
    scratchPoint[2] = z + 2 * (quaternionW * crossZ + quaternionX * crossY - quaternionY * crossX);
    return scratchPoint;
  };

  /**
   * The head turn that looks at a world point: yaw and pitch in the body frame, clamped to what a neck does.
   * @param {Object} motion a `MotionState` whose world transforms are current
   * @param {number} x the point, world metres
   * @param {number} y
   * @param {number} z
   * @param {Float32Array|number[]} out receives [pitch, yaw]
   * @returns {Float32Array|number[]} `out`; zeros for a body without a head
   * @complexity O(1), no allocation
   * @example const [pitch, yaw] = Kit.act.lookAngles(motion, ball.x, ball.y, ball.z, [0, 0]);
   */
  const lookAngles = (motion, x, y, z, out) => {
    const measured = rig(motion.plan, motion.rest);
    out[0] = 0;
    out[1] = 0;
    if (measured.head < 0) return out;
    const head = measured.head * VECTOR_STRIDE;
    const { translation } = motion.world;
    const offsetX = x - translation[head];
    const offsetZ = z - translation[head + 2];
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    const forward = offsetX * sine + offsetZ * cosine;
    const left = offsetX * cosine - offsetZ * sine;
    out[0] = clamp(-Math.atan2(y - translation[head + 1], Math.hypot(forward, left)), -TUNING.mostLookPitch, TUNING.mostLookPitch);
    out[1] = clamp(Math.atan2(left, forward), -TUNING.mostLookYaw, TUNING.mostLookYaw);
    return out;
  };

  // ---- one instance's performing state ------------------------------------------------------------------------------

  /**
   * @typedef {Object} FaceState
   * The face frames a motion state asks for: an index into each set of `Kit.body.FRAME_SETS` (0 is the rest frame).
   * @property {number} blink
   * @property {number} talk
   */

  const createFace = () => ({ blink: 0, talk: 0 });
  /**
   * The face frames a motion state asks for this frame. Stages write it (a blink, a cheer's open mouth); a
   * renderer reads it (`figure.face(Kit.act.face(motion))`).
   * @param {Object} motion a `MotionState`
   * @returns {FaceState} the state's own record; the same object every call
   * @complexity O(1); allocates the record on first use
   * @example figure.face(Kit.act.face(motion));
   */
  const face = (motion) => memory(motion, 'face', createFace);

  const createActing = (motion) => {
    const measured = rig(motion.plan, motion.rest);
    return {
      rig: measured,
      base: null,
      now: null,
      time: 0,
      rate: 1,
      leadUntil: 0,
      sideways: 1,
      steps: 1,
      lastFoot: 0,
      leadRate: 1,
      isMirrored: false,
      values: new Float32Array(VALUE_COUNT),
      weights: new Float32Array(GROUP_NAMES.length),
      target: new Float32Array(VALUE_COUNT),
      fromValues: new Float32Array(VALUE_COUNT),
      fromWeights: new Float32Array(GROUP_NAMES.length),
      fade: 1,
      fadeSeconds: TUNING.fadeSeconds,
      points: new Float32Array(TUNING.mostTargets * VECTOR_STRIDE),
      travel: new Float32Array(VECTOR_STRIDE),
      travelled: new Float32Array(VECTOR_STRIDE),
      carried: new Float32Array(2),
      before: Kit.rig.create(motion.plan.boneCount),
      plays: 0,
      seed: 1,
      idleSeconds: 0,
      fidgets: 0,
      fidgetAt: -1,
      refusals: new Map(),
    };
  };
  const actingOf = (motion, key = 'act') => memory(motion, key, createActing);

  /** Body-frame offsets (left, forward) from where the body stands, as a world point on the ground plane; writes `scratchPoint` x and z. */
  const toWorld = (motion, left, forward) => {
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    scratchPoint[0] = motion.x + left * cosine + forward * sine;
    scratchPoint[2] = motion.z - left * sine + forward * cosine;
    return scratchPoint;
  };

  /** Starts a performance on an acting record: where it was becomes what it fades from. */
  const begin = (motion, acting, compiled, params) => {
    acting.fromValues.set(acting.values);
    acting.fromWeights.set(acting.weights);
    acting.fade = 0;
    acting.fadeSeconds = params && params.fade !== undefined ? Math.max(params.fade, 1e-3) : TUNING.fadeSeconds;
    acting.now = compiled;
    acting.time = 0;
    acting.rate = params && params.rate > 0 ? params.rate : 1;
    // A mark to be met at a given moment: the lead-in up to it is time-warped, what follows runs as authored.
    const meeting = compiled && params && params.reach;
    acting.leadUntil = meeting ? compiled.marks[meeting.mark] : 0;
    acting.leadRate = meeting ? compiled.marks[meeting.mark] / meeting.in : 1;
    acting.travel.fill(0);
    acting.travelled.fill(0);
    if (!compiled) return;
    acting.plays += 1;
    // Named points: the caller's, or the performance's default placed in front of the body as it stands now.
    for (let index = 0; index < compiled.targets.length; index++) {
      const given = params && params[compiled.targets[index]];
      const at = index * VECTOR_STRIDE;
      if (given) {
        acting.points[at] = given[0];
        acting.points[at + 1] = given[1];
        acting.points[at + 2] = given[2];
        continue;
      }
      const high = compiled.defaultsInLegs ? acting.rig.unit : acting.rig.high;
      toWorld(motion, compiled.defaults[at] * high, compiled.defaults[at + 2] * high);
      acting.points[at] = scratchPoint[0];
      acting.points[at + 1] = motion.y + compiled.defaults[at + 1] * high;
      acting.points[at + 2] = scratchPoint[2];
    }
    acting.sideways = 1;
    // The side: asked for outright, or the one the named point is on; mirrored when it is not the authored one.
    let side = params && params.side ? SIDES.indexOf(params.side) : -1;
    if (side < 0 && compiled.sideBy >= 0) {
      const at = compiled.sideBy * VECTOR_STRIDE;
      const left = (acting.points[at] - motion.x) * Math.cos(motion.heading) - (acting.points[at + 2] - motion.z) * Math.sin(motion.heading);
      side = left >= 0 ? 0 : 1;
      const armsLength = Math.max(acting.rig.armLength[0], acting.rig.armLength[1]) || acting.rig.unit;
      acting.sideways = compiled.leanBySide ? clamp(Math.abs(left) / armsLength, 0, 1) : 1;
    }
    acting.isMirrored = compiled.side >= 0 && side >= 0 && side !== compiled.side;
  };

  /** Where a travel takes the hips: the body-frame offset to its point, stopped short, capped and masked. Writes `acting.travel` (metres). */
  const measureTravel = (motion, acting) => {
    const { travel } = acting.now;
    const measured = acting.rig;
    const at = travel.target * VECTOR_STRIDE;
    const offsetX = acting.points[at] - motion.x - acting.carried[0] * Math.cos(motion.heading) - acting.carried[1] * Math.sin(motion.heading);
    const offsetZ = acting.points[at + 2] - motion.z + acting.carried[0] * Math.sin(motion.heading) - acting.carried[1] * Math.cos(motion.heading);
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    let left = (offsetX * cosine - offsetZ * sine) * travel.axes[0];
    let forward = (offsetX * sine + offsetZ * cosine) * travel.axes[2];
    const hipHeight = motion.rest.translation[measured.carrier * VECTOR_STRIDE + 1] * measured.stretch[1] + (measured.legs ? measured.legs.standLift : 0);
    let up = (acting.points[at + 1] - motion.y - hipHeight) * travel.axes[1];
    const distance = Math.hypot(left, up, forward);
    const short = distance > 0 ? Math.max(0, 1 - (travel.keep * (measured.reach || measured.unit)) / distance) : 0;
    left *= short;
    up *= short;
    forward *= short;
    const flat = Math.hypot(left, forward);
    const cap = flat > travel.most * measured.stature ? (travel.most * measured.stature) / flat : 1;
    acting.travel[0] = left * cap;
    // A travel longer than a stride is run in steps; the foot that plants beside the point takes the last one.
    acting.steps = travel.stride > 0 && measured.legs ? Math.max(1, Math.round((Math.min(flat, travel.most * measured.stature)) / (travel.stride * measured.unit))) : 1;
    acting.lastFoot = 0;
    for (let index = 0; index < acting.now.reaches.length; index++) {
      const reach = acting.now.reaches[index];
      if (reach.foot && reach.ground) acting.lastFoot = acting.isMirrored ? 1 - reach.foot[0] : reach.foot[0];
    }
    // A low point is dived at low: the hips come down towards it, though never to the ground before the landing.
    acting.travel[1] = travel.land < 0 ? 0 : clamp(up, Math.min(0, TUNING.lowestFlight * measured.halfWidth - hipHeight), travel.mostUp * measured.stature);
    acting.travel[2] = forward * cap;
  };

  /** A span's ramp: 0 before `from`, 1 after `to`, smooth between. */
  const ramp = (progress, from, to) => Kit.blend.smooth(clamp((progress - from) / (to - from), 0, 1));

  /** Reads a performance at a moment into a values buffer: the two keys around it, eased; a mirror applied. */
  const sample = (acting, compiled, progress, out) => {
    const { times, values, keyCount } = compiled;
    const measured = acting.rig;
    let next = 0;
    while (next < keyCount && times[next] <= progress) next += 1;
    // A loop's last key leads back to its first; a one-shot's first and last keys are at 0 and 1.
    const from = next === 0 ? keyCount - 1 : next - 1;
    // Only a loop leads from its last key back to its first: a one-shot at its very end is its last key (a held pose stays).
    const to = next === keyCount ? (compiled.loop ? 0 : keyCount - 1) : next;
    const fromTime = next === 0 ? times[from] - 1 : times[from];
    const toTime = next === keyCount ? times[to] + 1 : times[to];
    const span = toTime - fromTime;
    const amount = span > 0 ? compiled.eases[to](clamp((progress - fromTime) / span, 0, 1)) : 1;
    const fromAt = from * VALUE_COUNT;
    const toAt = to * VALUE_COUNT;
    // Hot path: index loops over the channels, no allocation.
    for (let index = 0; index < VALUE_COUNT; index++) out[index] = values[fromAt + index] + (values[toAt + index] - values[fromAt + index]) * amount;
    for (let side = 0; side < SIDES.length; side++) {
      const channel = side ? OFFSET.armRight : OFFSET.armLeft;
      // The mirror swaps the sides afterwards, so a key's missing arm takes the rest of the side it will end up on.
      const restAt = (acting.isMirrored ? 1 - side : side) * CHANNELS.armLeft.size;
      for (let index = 0; index < CHANNELS.armLeft.size; index++) {
        const first = values[fromAt + channel + index];
        const second = values[toAt + channel + index];
        if (!Number.isNaN(first) && !Number.isNaN(second)) continue;
        const rest = measured.armRest[restAt + index];
        out[channel + index] = lerp(Number.isNaN(first) ? rest : first, Number.isNaN(second) ? rest : second, amount);
      }
      // An arm raised or lowered a long way goes by an arc in front of the body, elbow bent, not out through a T.
      const raiseFrom = Number.isNaN(values[fromAt + channel]) ? measured.armRest[restAt] : values[fromAt + channel];
      const raiseTo = Number.isNaN(values[toAt + channel]) ? measured.armRest[restAt] : values[toAt + channel];
      const arc = Math.sin(Math.PI * amount) * clamp((Math.abs(raiseTo - raiseFrom) - TUNING.arcFrom) / TUNING.arcFrom, 0, 1);
      if (arc > 0) {
        out[channel + 1] = lerp(out[channel + 1], AHEAD, arc * TUNING.arcFront);
        out[channel + 2] *= 1 - TUNING.arcBend * arc;
      }
    }
    if (acting.sideways < 1) for (let index = 0; index < SIDEWAYS_VALUES.length; index++) out[SIDEWAYS_VALUES[index]] *= acting.sideways;
    if (acting.isMirrored) mirrorValues(out);
    return next === 0 ? keyCount - 1 : next - 1;
  };

  /** Swaps a values buffer left for right, in place. */
  const mirrorValues = (values) => {
    for (let index = 0; index < CHANNEL_NAMES.length; index++) {
      const name = CHANNEL_NAMES[index];
      const channel = CHANNELS[name];
      const at = OFFSET[name];
      if (channel.mirror) for (let part = 0; part < channel.size; part++) values[at + part] *= channel.mirror[part];
      // Each pair is swapped once, from its left member.
      if (channel.swap && OFFSET[channel.swap] > at) {
        for (let part = 0; part < channel.size; part++) {
          const other = OFFSET[channel.swap] + part;
          const kept = values[at + part];
          values[at + part] = values[other];
          values[other] = kept;
        }
      }
    }
  };

  /** One fixed step of an acting record: time moves on, a finished one-shot hands over to the base, the cross-fade advances. */
  const stepActing = (motion, acting, dt) => {
    acting.fade = Math.min(1, acting.fade + dt / acting.fadeSeconds);
    const compiled = acting.now;
    if (!compiled) return;
    if (acting.time < acting.leadUntil) {
      // Up to the mark time runs at the lead-in's rate; a step that crosses it spends its remainder at the authored one.
      const needed = (acting.leadUntil - acting.time) / acting.leadRate;
      acting.time = dt < needed ? acting.time + dt * acting.leadRate : acting.leadUntil + (dt - needed) * acting.rate;
      if (dt >= needed) acting.leadUntil = 0;
    } else acting.time += dt * acting.rate;
    if (compiled.loop) {
      if (acting.time >= compiled.seconds) acting.time -= compiled.seconds;
      return;
    }
    if (acting.time < compiled.seconds) return;
    acting.time = compiled.seconds;
    if (compiled.hold) return;
    // What the body travelled sideways and forwards is now where it stands, until the game collects it.
    acting.carried[0] += acting.travelled[0];
    acting.carried[1] += acting.travelled[2];
    begin(motion, acting, compiled === acting.base ? null : acting.base, null);
  };

  // ---- applying channels to the pose ---------------------------------------------------------------------------------

  /** How strongly each reach of the playing performance pulls now; per side for hands and feet, and the gaze. Rewritten every frame. */
  const pulls = {
    hand: new Float32Array(2),
    handPoint: new Int8Array(2),
    handOffset: [null, null],
    foot: new Float32Array(2),
    footPoint: new Int8Array(2),
    footOffset: [null, null],
    footGround: [false, false],
    head: 0,
    headPoint: 0,
  };

  const measurePulls = (acting, progress) => {
    pulls.hand.fill(0);
    pulls.foot.fill(0);
    pulls.head = 0;
    const compiled = acting.now;
    if (!compiled) return;
    for (let index = 0; index < compiled.reaches.length; index++) {
      const reach = compiled.reaches[index];
      const weight = ramp(progress, reach.in[0], reach.in[1]) * (reach.out ? 1 - ramp(progress, reach.out[0], reach.out[1]) : 1) * Kit.blend.smooth(acting.fade);
      if (weight <= 0) continue;
      const sides = reach.hand || reach.foot;
      if (reach.head) {
        pulls.head = weight;
        pulls.headPoint = reach.target;
        continue;
      }
      for (let entry = 0; entry < sides.length; entry++) {
        const side = acting.isMirrored ? 1 - sides[entry] : sides[entry];
        const kind = reach.hand ? 'hand' : 'foot';
        pulls[kind][side] = weight;
        pulls[`${kind}Point`][side] = reach.target;
        pulls[`${kind}Offset`][side] = reach.offset;
        if (reach.foot) pulls.footGround[side] = reach.ground;
      }
    }
  };

  /** A reach's point with its offset (in the body frame, scaled by a length, mirrored for the right side); writes `scratchPoint`. */
  const reachPoint = (motion, acting, point, offset, side, length) => {
    const at = point * VECTOR_STRIDE;
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    const left = offset[0] * SIDE_SIGN[side] * length;
    const forward = offset[2] * length;
    scratchPoint[0] = acting.points[at] + left * cosine + forward * sine;
    scratchPoint[1] = acting.points[at + 1] + offset[1] * length;
    scratchPoint[2] = acting.points[at + 2] - left * sine + forward * cosine;
    return scratchPoint;
  };

  /** Shifts the carrier bone, and so the whole body, by a body-frame offset in metres, in the local pose. */
  const shiftCarrier = (motion, measured, left, up, forward) => {
    const at = measured.carrier * VECTOR_STRIDE;
    const { translation } = motion.pose;
    translation[at] += left / measured.stretch[0];
    translation[at + 1] += up / measured.stretch[1];
    translation[at + 2] += forward / measured.stretch[2];
  };

  const scratchLead = new Float32Array(QUATERNION_STRIDE);

  /**
   * Hands lead the head: while a hand is pulled to a point, the trunk tips up and back off the line to it (about the
   * middle of the shoulders, which stays where it was) until the head is behind the hand along that line - as
   * far as `TUNING.leadMost` allows. A long-armed body is left alone; a short-armed, big-headed one dives with
   * its body across the line and its arm out along it, instead of head first.
   * @returns {boolean} whether the pose changed (the world transforms are then stale)
   */
  const leadHands = (motion, acting) => {
    const measured = acting.rig;
    const pull = Math.max(pulls.hand[0], pulls.hand[1]);
    if (pull <= 0 || measured.head < 0 || measured.armUpper[0] < 0 || measured.armUpper[1] < 0) return false;
    const { translation, rotation } = motion.world;
    const left = measured.armUpper[0] * VECTOR_STRIDE;
    const right = measured.armUpper[1] * VECTOR_STRIDE;
    const head = measured.head * VECTOR_STRIDE;
    const point = (pulls.hand[0] >= pulls.hand[1] ? pulls.handPoint[0] : pulls.handPoint[1]) * VECTOR_STRIDE;
    const middleX = (translation[left] + translation[right]) / 2;
    const middleY = (translation[left + 1] + translation[right + 1]) / 2;
    const middleZ = (translation[left + 2] + translation[right + 2]) / 2;
    let lineX = acting.points[point] - middleX;
    let lineY = acting.points[point + 1] - middleY;
    let lineZ = acting.points[point + 2] - middleZ;
    const away = Math.hypot(lineX, lineY, lineZ);
    if (away < TINY) return false;
    lineX /= away;
    lineY /= away;
    lineZ /= away;
    // The head's middle: a head radius beyond its joint, along the neck.
    let headX = translation[head] - middleX;
    let headY = translation[head + 1] - middleY;
    let headZ = translation[head + 2] - middleZ;
    const neck = Math.hypot(headX, headY, headZ);
    if (neck < TINY) return false;
    const toMiddle = (neck + measured.headRadius) / neck;
    headX *= toMiddle;
    headY *= toMiddle;
    headZ *= toMiddle;
    const along = headX * lineX + headY * lineY + headZ * lineZ;
    // How far along the line the leading hand gets: to the point, or as far as its arm goes from its shoulder.
    const leadLeft = (translation[left] - middleX) * lineX + (translation[left + 1] - middleY) * lineY + (translation[left + 2] - middleZ) * lineZ;
    const arm = Math.max(measured.armLength[0], measured.armLength[1]);
    const most = Math.min(away, Math.abs(leadLeft) + arm) - TUNING.handLead * arm - measured.headRadius;
    if (along <= most) return false;
    // The way the head goes: up off the line and a little back from the way the body faces (straight back for a reach overhead).
    const backX = -Math.sin(motion.heading) * TUNING.leadBack;
    const backZ = -Math.cos(motion.heading) * TUNING.leadBack;
    const upAlong = backX * lineX + lineY + backZ * lineZ;
    const offX = backX - upAlong * lineX;
    const offY = 1 - upAlong * lineY;
    const offZ = backZ - upAlong * lineZ;
    const off = Math.hypot(offX, offY, offZ);
    const aside = (headX * offX + headY * offY + headZ * offZ) / off;
    const size = Math.hypot(along, aside);
    const angle = clamp(Math.acos(clamp(most / size, -1, 1)) - Math.atan2(aside, along), 0, TUNING.leadMost) * pull;
    if (!(angle > 0)) return false;
    // A turn about the axis line x off, in the world, laid on the carrier inside its parent's frame.
    const half = Math.sin(angle / 2) / off;
    const turnX = (lineY * offZ - lineZ * offY) * half;
    const turnY = (lineZ * offX - lineX * offZ) * half;
    const turnZ = (lineX * offY - lineY * offX) * half;
    const turnW = Math.cos(angle / 2);
    const parent = motion.plan.parent[measured.carrier];
    const parentAt = parent * QUATERNION_STRIDE;
    const parentX = parent < 0 ? 0 : rotation[parentAt];
    const parentY = parent < 0 ? Math.sin(motion.heading / 2) : rotation[parentAt + 1];
    const parentZ = parent < 0 ? 0 : rotation[parentAt + 2];
    const parentW = parent < 0 ? Math.cos(motion.heading / 2) : rotation[parentAt + QUATERNION_W];
    const local = motion.pose.rotation;
    const at = measured.carrier * QUATERNION_STRIDE;
    multiplyInto(scratchLead, 0, parentX, parentY, parentZ, parentW, local[at], local[at + 1], local[at + 2], local[at + QUATERNION_W]);
    multiplyInto(scratchLead, 0, turnX, turnY, turnZ, turnW, scratchLead[0], scratchLead[1], scratchLead[2], scratchLead[QUATERNION_W]);
    multiplyInto(local, at, -parentX, -parentY, -parentZ, parentW, scratchLead[0], scratchLead[1], scratchLead[2], scratchLead[QUATERNION_W]);
    // The shoulders stay where they were: the hips swing out under them.
    motion.isWorldCurrent = false;
    refreshWorld(motion);
    const movedX = middleX - (translation[left] + translation[right]) / 2;
    const movedY = middleY - (translation[left + 1] + translation[right + 1]) / 2;
    const movedZ = middleZ - (translation[left + 2] + translation[right + 2]) / 2;
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    shiftCarrier(motion, measured, movedX * cosine - movedZ * sine, movedY, movedX * sine + movedZ * cosine);
    return true;
  };

  /**
   * Hands reach: while a hand is pulled to a point its arm cannot get to from where the keys have put the
   * shoulder, the whole body is moved towards the point by what is missing, up to `TUNING.closeMost` arm lengths.
   * @returns {boolean} whether the pose changed (the world transforms are then stale)
   */
  const closeHands = (motion, acting) => {
    const measured = acting.rig;
    const side = pulls.hand[0] >= pulls.hand[1] ? 0 : 1;
    const pull = pulls.hand[side];
    if (pull <= 0 || measured.armUpper[side] < 0) return false;
    const length = measured.armLength[side];
    const shoulder = measured.armUpper[side] * VECTOR_STRIDE;
    const { translation } = motion.world;
    reachPoint(motion, acting, pulls.handPoint[side], pulls.handOffset[side], side, length);
    const offsetX = scratchPoint[0] - translation[shoulder];
    const offsetY = scratchPoint[1] - translation[shoulder + 1];
    const offsetZ = scratchPoint[2] - translation[shoulder + 2];
    const distance = Math.hypot(offsetX, offsetY, offsetZ);
    const missing = Math.min(distance - TUNING.armLongest * length, TUNING.closeMost * length) * pull;
    if (!(missing > 0)) return false;
    const share = missing / distance;
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    shiftCarrier(motion, measured, (offsetX * cosine - offsetZ * sine) * share, offsetY * share, (offsetX * sine + offsetZ * cosine) * share);
    return true;
  };

  /** Where each side's foot is in a stepped travel: how far along it its standing place has got, how high it is lifted, and whether a reach may take it yet. */
  const stepped = { carry: new Float32Array(2), lift: new Float32Array(2), gate: new Float32Array(2), keyed: 1 };

  /**
   * Fills `stepped` for a travel `along` (0..1, linear in time) its way. The travel's time is cut into as many
   * equal steps as it has; the feet take them in turn, each landing where the body will be when its step ends,
   * and the planting foot takes the last. With one step the feet are left to the `carry` channel.
   */
  const stepFeet = (acting, along) => {
    const { steps } = acting;
    if (steps <= 1) return;
    const step = Math.min(steps - 1, Math.floor(along * steps));
    const within = along >= 1 ? 1 : along * steps - step;
    for (let side = 0; side < SIDES.length; side++) {
      const isStepping = ((steps - 1 - step) % 2 === 0) === (side === acting.lastFoot);
      if (isStepping) {
        stepped.carry[side] = Kit.blend.smooth(lerp(Math.max(0, step - 1) / steps, (step + 1) / steps, Kit.blend.smooth(within)));
        stepped.lift[side] = Math.sin(Math.PI * within);
      } else stepped.carry[side] = Kit.blend.smooth(step / steps);
    }
    // The planting foot goes to its point on its last step, not before; and what the keys ask of the feet (a wind-up)
    // waits for that step too: until then they are running.
    stepped.gate[acting.lastFoot] = step === steps - 1 ? Kit.blend.smooth(within) : 0;
    stepped.keyed = stepped.gate[acting.lastFoot];
  };

  /** Solves every leg to its foot: where it stands at rest, moved by its side's foot channel, the travel it has followed and any reach. */
  const poseLegs = (motion, acting, values, travelLeft, travelForward) => {
    const measured = acting.rig;
    const { legs } = measured;
    const { translation } = motion.world;
    const keyedCarry = values[OFFSET.carry];
    for (let leg = 0; leg < legs.count; leg++) {
      const side = legs.side[leg] === 2 ? 1 : 0;
      const isMoved = measured.footLeg[side] === leg;
      const carry = Math.max(keyedCarry, stepped.carry[side]);
      const channel = side ? OFFSET.footRight : OFFSET.footLeft;
      const length = legs.length[leg];
      // While the body is still running up (a stepped travel before its last step) the keys' foot poses wait.
      const keyed = isMoved ? (keyedCarry < 1 ? stepped.keyed : 1) : 0;
      const out = values[channel] * SIDE_SIGN[side] * length * keyed;
      const forward = values[channel + 2] * length * keyed;
      toWorld(motion, legs.homeX[leg] + out + travelLeft * carry + acting.carried[0], legs.homeZ[leg] + forward + travelForward * carry + acting.carried[1]);
      let targetX = scratchPoint[0];
      let targetY = motion.y + legs.sole[leg] + values[channel + 1] * length * keyed + stepped.lift[side] * TUNING.stepLift * length * (1 - keyedCarry);
      let targetZ = scratchPoint[2];
      const pull = isMoved ? pulls.foot[side] * (acting.steps > 1 && pulls.footGround[side] && keyedCarry < 1 ? stepped.gate[side] : 1) : 0;
      if (pull > 0) {
        reachPoint(motion, acting, pulls.footPoint[side], pulls.footOffset[side], side, length);
        targetX = lerp(targetX, scratchPoint[0], pull);
        targetY = lerp(targetY, pulls.footGround[side] ? motion.y + legs.sole[leg] : Math.max(scratchPoint[1], motion.y + legs.sole[leg]), pull);
        targetZ = lerp(targetZ, scratchPoint[2], pull);
      }
      // A foot the body has been carried out of reach of leaves the ground: it hangs from the hip towards where it stood.
      const hip = legs.upper[leg] * VECTOR_STRIDE;
      const offsetX = targetX - translation[hip];
      const offsetY = targetY - translation[hip + 1];
      const offsetZ = targetZ - translation[hip + 2];
      const distance = Math.hypot(offsetX, offsetY, offsetZ);
      const longest = TUNING.legStretch * length;
      // A leg hanging clear is drawn up by its foot's keyed lift: the knee bends in the air instead of trailing straight.
      const clear = clamp((distance - longest) / (TUNING.hangTuckOver * length), 0, 1);
      const tuck = 1 - clear * clamp(values[channel + 1] * keyed, 0, TUNING.hangTuck);
      const pulledIn = distance > longest ? (longest * tuck) / distance : 1;
      Kit.gait.reachLeg(motion, legs, leg, translation[hip] + offsetX * pulledIn, translation[hip + 1] + offsetY * pulledIn, translation[hip + 2] + offsetZ * pulledIn);
      const lifted = Math.max(0, distance - longest) / length;
      Kit.gait.levelFoot(motion, legs, leg, motion.heading, values[channel + 3] * keyed + Math.min(TUNING.mostHangPitch, lifted * TUNING.hangPitch));
    }
  };

  /** Places one hand: the arm channel's point from the shoulder, in the frame of whatever the arm hangs from, pulled towards any reach. */
  const poseArm = (motion, acting, values, side) => {
    const measured = acting.rig;
    const upper = measured.armUpper[side];
    if (upper < 0) return;
    const { plan, world } = motion;
    const channel = side ? OFFSET.armRight : OFFSET.armLeft;
    const length = measured.armLength[side];
    const raise = values[channel];
    const front = values[channel + 1];
    const extend = clamp(values[channel + 2], TUNING.armShortest, TUNING.armLongest) * length;
    const elbowOut = values[channel + 3];
    const outSign = SIDE_SIGN[side];
    const level = Math.sin(raise);
    // The frame the arm hangs in: how its parent has turned from rest (rest^-1 first, then the parent's world rotation).
    const parentAt = plan.parent[upper] * QUATERNION_STRIDE;
    const frameAt = upper * QUATERNION_STRIDE;
    multiplyInto(
      scratchTurn,
      0,
      world.rotation[parentAt],
      world.rotation[parentAt + 1],
      world.rotation[parentAt + 2],
      world.rotation[parentAt + QUATERNION_W],
      -measured.frame[frameAt],
      -measured.frame[frameAt + 1],
      -measured.frame[frameAt + 2],
      measured.frame[frameAt + QUATERNION_W]
    );
    const frameX = scratchTurn[0];
    const frameY = scratchTurn[1];
    const frameZ = scratchTurn[2];
    const frameW = scratchTurn[QUATERNION_W];
    const shoulder = upper * VECTOR_STRIDE;
    const shoulderX = world.translation[shoulder];
    const shoulderY = world.translation[shoulder + 1];
    const shoulderZ = world.translation[shoulder + 2];
    scratchTurn[0] = frameX;
    scratchTurn[1] = frameY;
    scratchTurn[2] = frameZ;
    scratchTurn[QUATERNION_W] = frameW;
    rotateBy(scratchTurn, 0, outSign * Math.cos(front) * level * extend, -Math.cos(raise) * extend, Math.sin(front) * level * extend);
    let targetX = shoulderX + scratchPoint[0];
    let targetY = shoulderY + scratchPoint[1];
    let targetZ = shoulderZ + scratchPoint[2];
    if (measured.headRadius > 0) {
      // A keyed hand is kept out of the head: a short arm raised beside a big head goes up and out round it.
      const headAt = measured.head * VECTOR_STRIDE;
      const centreY = world.translation[headAt + 1] + measured.headRadius * measured.stretch[1];
      const clear = measured.headRadius * TUNING.headClear;
      const offX = targetX - world.translation[headAt];
      const offY = targetY - centreY;
      const offZ = targetZ - world.translation[headAt + 2];
      const inside = Math.hypot(offX, offY, offZ);
      if (inside < clear) {
        // Out sideways (or forwards), at its own height: the level circle of the ball there.
        const level = Math.sqrt(Math.max(0, clear * clear - offY * offY));
        const flat = Math.hypot(offX, offZ);
        const outX = flat > TINY ? offX / flat : Math.cos(motion.heading) * outSign;
        const outZ = flat > TINY ? offZ / flat : -Math.sin(motion.heading) * outSign;
        targetX = world.translation[headAt] + outX * level;
        targetZ = world.translation[headAt + 2] + outZ * level;
      }
    }
    const pull = pulls.hand[side];
    if (pull > 0) {
      reachPoint(motion, acting, pulls.handPoint[side], pulls.handOffset[side], side, length);
      targetX = lerp(targetX, scratchPoint[0], pull);
      targetY = lerp(targetY, scratchPoint[1], pull);
      targetZ = lerp(targetZ, scratchPoint[2], pull);
    }
    rotateBy(scratchTurn, 0, outSign * (TUNING.elbowAside + elbowOut) * length, -TUNING.elbowDown * length, -TUNING.elbowBack * length);
    Kit.reach.twoBone(
      plan.parent,
      motion.pose,
      world,
      upper,
      measured.armMiddle[side],
      measured.armEnd[side],
      targetX,
      targetY,
      targetZ,
      shoulderX + scratchPoint[0],
      shoulderY + scratchPoint[1],
      shoulderZ + scratchPoint[2]
    );
  };

  /** Mixes the bones of one group back towards the pose they had before the performance, by what is left of the group's weight. */
  const fadeGroup = (motion, acting, group) => {
    const weight = acting.weights[group];
    if (weight >= 1) return;
    const bones = acting.rig.groupBones[group];
    const { pose } = motion;
    const { before } = acting;
    for (let index = 0; index < bones.length; index++) {
      const quaternion = bones[index] * QUATERNION_STRIDE;
      const vector = bones[index] * VECTOR_STRIDE;
      const dot =
        before.rotation[quaternion] * pose.rotation[quaternion] +
        before.rotation[quaternion + 1] * pose.rotation[quaternion + 1] +
        before.rotation[quaternion + 2] * pose.rotation[quaternion + 2] +
        before.rotation[quaternion + QUATERNION_W] * pose.rotation[quaternion + QUATERNION_W];
      // q and -q are one rotation: mix the shorter way round, then renormalise.
      const toward = dot < 0 ? -weight : weight;
      let length = 0;
      for (let part = 0; part < QUATERNION_STRIDE; part++) {
        pose.rotation[quaternion + part] = before.rotation[quaternion + part] * (1 - weight) + pose.rotation[quaternion + part] * toward;
        length += pose.rotation[quaternion + part] * pose.rotation[quaternion + part];
      }
      length = Math.sqrt(length) || 1;
      for (let part = 0; part < QUATERNION_STRIDE; part++) pose.rotation[quaternion + part] /= length;
      for (let axis = 0; axis < VECTOR_STRIDE; axis++) pose.translation[vector + axis] = lerp(before.translation[vector + axis], pose.translation[vector + axis], weight);
    }
  };

  /** This frame's pose from an acting record: sample, cross-fade, apply each group that has weight, fade partial groups. */
  const poseActing = (motion, plan, acting) => {
    const measured = acting.rig;
    const compiled = acting.now;
    const { values, weights, target } = acting;
    const progress = compiled ? clamp(acting.time / compiled.seconds, 0, 1) : 0;
    let keyIndex = -1;
    if (compiled) keyIndex = sample(acting, compiled, progress, target);
    else target.fill(0);
    const fade = Kit.blend.smooth(acting.fade);
    // Cross-fade in channel space. A group that was not in use has nothing to fade from: it takes the new values and fades in by weight.
    for (let index = 0; index < CHANNEL_NAMES.length; index++) {
      const name = CHANNEL_NAMES[index];
      const group = GROUP[CHANNELS[name].group];
      const wasUsed = acting.fromWeights[group] > 0;
      const isUsed = compiled ? compiled.uses[group] === 1 : false;
      for (let part = 0, at = OFFSET[name]; part < CHANNELS[name].size; part++, at++)
        values[at] = !wasUsed ? target[at] : !isUsed ? acting.fromValues[at] : lerp(acting.fromValues[at], target[at], fade);
    }
    let isActive = acting.carried[0] !== 0 || acting.carried[1] !== 0;
    for (let group = 0; group < GROUP_NAMES.length; group++) {
      weights[group] = lerp(acting.fromWeights[group], compiled ? compiled.uses[group] : 0, fade);
      if (weights[group] > 0) isActive = true;
    }
    const faces = face(motion);
    if (compiled && keyIndex >= 0) {
      if (compiled.blink[keyIndex] >= 0) faces.blink = compiled.blink[keyIndex];
      faces.talk = Math.max(0, compiled.talk[keyIndex]);
    } else faces.talk = 0;
    if (!isActive) return;
    measurePulls(acting, progress);
    // Where a finished travel left the body is where it stands, whatever fades: it goes in before the pose is remembered.
    shiftCarrier(motion, measured, acting.carried[0], 0, acting.carried[1]);
    Kit.rig.copy(motion.pose, acting.before);
    const { rotation } = motion.pose;
    let travelLeft = 0;
    let travelForward = 0;
    stepped.carry.fill(0);
    stepped.lift.fill(0);
    stepped.gate.fill(1);
    stepped.keyed = 1;
    if (compiled && compiled.travel) {
      const { travel } = compiled;
      if (progress <= travel.start) measureTravel(motion, acting);
      const along = Kit.blend.smooth(clamp((progress - travel.start) / (travel.arrive - travel.start), 0, 1));
      stepFeet(acting, clamp((progress - travel.start) / (travel.arrive - travel.start), 0, 1));
      // Upwards a thrown body decelerates to its highest point and accelerates back down: two halves of a parabola.
      const rising = clamp((progress - travel.start) / (travel.arrive - travel.start), 0, 1);
      const falling = travel.land > 0 ? clamp((progress - travel.arrive) / (travel.land - travel.arrive), 0, 1) : 0;
      const up = acting.travel[1] * EASES.out(rising) * (1 - EASES.in(falling));
      travelLeft = acting.travel[0] * along;
      travelForward = acting.travel[2] * along;
      acting.travelled[0] = travelLeft;
      acting.travelled[2] = travelForward;
      shiftCarrier(motion, measured, travelLeft, up, travelForward);
    }
    const isBodyMoved = weights[GROUP.body] > 0;
    const isStanding = isBodyMoved && measured.legs !== null;
    if (isBodyMoved) {
      const { unit } = measured;
      // A locomotion stage that ran this frame has already stood the body on its feet; alone, this stage does it.
      const gaitFeet = isStanding ? Kit.gait.feet(motion) : null;
      const isStood = !isStanding || (gaitFeet !== null && gaitFeet.steppedAt === motion.time);
      shiftCarrier(motion, measured, values[OFFSET.shift] * unit, values[OFFSET.shift + 1] * unit + (isStood ? 0 : measured.legs.standLift), values[OFFSET.shift + 2] * unit);
      turnBody(rotation, measured, measured.carrier, values[OFFSET.turn], values[OFFSET.turn + 1], values[OFFSET.turn + 2]);
    }
    if (weights[GROUP.spine] > 0) turnShared(rotation, measured, measured.spine, values[OFFSET.spine], values[OFFSET.spine + 1], values[OFFSET.spine + 2]);
    if (weights[GROUP.head] > 0) turnHead(rotation, measured, values[OFFSET.head], values[OFFSET.head + 1], values[OFFSET.head + 2]);
    if (weights[GROUP.tail] > 0)
      for (let index = 0; index < measured.tails.length; index++) turnBody(rotation, measured, measured.tails[index], values[OFFSET.tail], values[OFFSET.tail + 1], values[OFFSET.tail + 2]);
    if (weights[GROUP.wings] > 0) {
      // Lifting a left wing's tip is a lean to the right about the forward axis; the right wing mirrors it.
      for (let index = 0; index < measured.wings.length; index++)
        turnBody(rotation, measured, measured.wings[index], values[OFFSET.wings + 2], values[OFFSET.wings + 1] * measured.wingSign[index], -values[OFFSET.wings] * measured.wingSign[index]);
    }
    if (weights[GROUP.jaw] > 0 && measured.jaw >= 0) turnBody(rotation, measured, measured.jaw, values[OFFSET.jaw], 0, 0);
    motion.isWorldCurrent = false;
    refreshWorld(motion);
    if (leadHands(motion, acting)) {
      motion.isWorldCurrent = false;
      refreshWorld(motion);
    }
    if (closeHands(motion, acting)) {
      motion.isWorldCurrent = false;
      refreshWorld(motion);
    }
    if (pulls.head > 0) {
      const at = pulls.headPoint * VECTOR_STRIDE;
      lookAngles(motion, acting.points[at], acting.points[at + 1], acting.points[at + 2], scratchAngles);
      turnHead(rotation, measured, scratchAngles[0] * pulls.head, scratchAngles[1] * pulls.head, 0);
    }
    if (isStanding) poseLegs(motion, acting, values, travelLeft, travelForward);
    if (weights[GROUP.armLeft] > 0) poseArm(motion, acting, values, 0);
    if (weights[GROUP.armRight] > 0) poseArm(motion, acting, values, 1);
    for (let group = 0; group < GROUP_NAMES.length; group++) if (weights[group] > 0) fadeGroup(motion, acting, group);
    motion.isWorldCurrent = false;
  };

  // ---- stages -----------------------------------------------------------------------------------------------------------

  let stageCount = 0;

  /**
   * One performance as a stage: a loop plays for as long as the stage runs; a one-shot plays once from the
   * instance's first frame (again every `every` seconds when that is given). Put it after whatever moves the
   * body, or confine it with `Kit.motion.layer` to lay it over a walk.
   * @param {string|Object} performanceOrId an id of the repertoire, a spec or a compiled performance
   * @param {{every?: number, rate?: number, side?: string}} [params] plus any named point: { target: [x, y, z] }
   * @returns {Object} a `Stage` of kit/motion.js; it needs what the performance needs
   * @throws {Error} for an unknown id or a spec that does not compile
   * @complexity per frame O(channels + bones of the groups it moves + legs and arms solved); no allocation after
   *   an instance's first frame
   * @example
   * const waveWalking = Kit.motion.sequence(Kit.gait.walk(), Kit.motion.layer(['arm'], Kit.act.stage('wave', { every: 3 })));
   */
  const stage = (performanceOrId, params = {}) => {
    const compiled = resolve('stage', performanceOrId);
    const key = `act:${compiled.id}:${stageCount++}`;
    const started = (motion) => {
      const acting = actingOf(motion, key);
      if (acting.plays === 0 || (params.every > 0 && !acting.now && acting.idleSeconds >= params.every - compiled.seconds)) {
        begin(motion, acting, compiled, params);
        acting.fade = 1;
        acting.idleSeconds = 0;
      }
      return acting;
    };
    return Kit.motion.stage({
      name: `act(${compiled.id})`,
      needs: needsOf(compiled),
      step(motion, _plan, dt) {
        const acting = started(motion);
        if (!acting.now) acting.idleSeconds += dt;
        stepActing(motion, acting, dt);
      },
      pose: (motion, plan) => poseActing(motion, plan, started(motion)),
    });
  };

  const FIDGET_FIELD = Kit.seeded.hashText('act:fidget');
  const FIDGET_PICK_FIELD = Kit.seeded.hashText('act:fidgetPick');

  /**
   * The stage that performs on request: it plays whatever `Kit.act.play` asks of the instance, cross-fading
   * from what it was doing, then returns to the instance's base loop (`Kit.act.base`, default: nothing, which
   * leaves the body to the stages before it). Only the parts a performance uses are taken over, so a wave
   * plays over a walk and a kick takes the whole body. With `fidgets`, a body standing still on its base now
   * and then plays one of them, on a schedule seeded per instance (`Kit.act.cast`).
   * @param {{base?: string, fidgets?: string[], fidgetGap?: number[]}} [options] `base`: the loop every
   *   instance starts on; `fidgets`: ids of small one-shots; `fidgetGap`: [least, most] seconds between them
   *   (default [4, 9])
   * @returns {Object} a `Stage`; it needs nothing (a performance a body cannot do is refused by `play`)
   * @throws {Error} for an unknown id
   * @complexity as `stage` for the performance playing; O(1) while nothing plays
   * @example const controller = Kit.motion.sequence(Kit.gait.walk(), Kit.act.performer({ fidgets: ['glance', 'shiftWeight'] }));
   */
  const performer = ({ base: baseId = null, fidgets = [], fidgetGap = [4, 9] } = {}) => {
    const baseLoop = baseId ? resolve('performer', baseId) : null;
    const fidgetRows = fidgets.map((id) => resolve('performer', id));
    const ready = (motion) => {
      const acting = actingOf(motion);
      if (acting.fidgetAt < 0) {
        acting.fidgetAt = 0;
        if (baseLoop && !acting.base) setBase(motion, baseLoop);
      }
      return acting;
    };
    /** Standing still on the base: count the seconds, and when the seeded gap is up, play a fidget this body can do. */
    const stepFidgets = (motion, acting, dt) => {
      const isIdle = acting.now === acting.base && motion.speed < TUNING.stillSpeed * acting.rig.unit;
      acting.idleSeconds = isIdle ? acting.idleSeconds + dt : 0;
      const gap = lerp(fidgetGap[0], fidgetGap[1], Kit.seeded.unit(acting.seed, FIDGET_FIELD, acting.fidgets));
      if (acting.idleSeconds < gap) return;
      const chosen = fidgetRows[Math.floor(Kit.seeded.unit(acting.seed, FIDGET_PICK_FIELD, acting.fidgets) * fidgetRows.length)];
      acting.fidgets += 1;
      acting.idleSeconds = 0;
      play(motion, chosen);
    };
    return Kit.motion.stage({
      name: 'act.performer',
      step(motion, _plan, dt) {
        const acting = ready(motion);
        if (fidgetRows.length) stepFidgets(motion, acting, dt);
        stepActing(motion, acting, dt);
      },
      pose: (motion, plan) => poseActing(motion, plan, ready(motion)),
    });
  };

  // ---- controls ---------------------------------------------------------------------------------------------------------

  /** Whether this instance's body can do a performance; asked once per performance and remembered. */
  const canPerform = (motion, acting, compiled) => {
    let problem = acting.refusals.get(compiled);
    if (problem === undefined) acting.refusals.set(compiled, (problem = Kit.motion.refusal({ name: 'act', pose: () => {}, needs: needsOf(compiled) }, motion.plan, motion.rest)));
    return problem === null;
  };

  /**
   * Which form of a family a body would play for a point: the first whose spans hold the point, measured against
   * this body's own reach, among the forms the body can do at all.
   * @param {Object} motion a `MotionState`
   * @param {string} familyId an id of `Kit.act.FAMILIES`
   * @param {Object} params the family's point in the world: { target: [x, y, z] }
   * @returns {?string} the id of a performance; null when the body can do none of the forms
   * @throws {Error} for an unknown family or a missing point
   * @complexity O(forms); O(needs) more the first time a body is asked about a form; no allocation after
   * @example
   * const form = Kit.act.choose(keeper, 'save', { target: [x, y, z] });   // 'catch', 'catchHigh', 'smother', 'dive' or 'diveStep'
   * Kit.act.play(keeper, 'save', { target: [x, y, z], reach: { mark: 'contact', in: Kit.act.marks(form).contact } });
   */
  const choose = (motion, familyId, params) => {
    const family = FAMILIES[familyId] || fail('choose', `no family "${familyId}". Families: ${Object.keys(FAMILIES).join(', ') || 'none'}.`);
    const point = params && params[family.target];
    if (!point || !(point.length >= VECTOR_STRIDE)) fail('choose', `the family "${familyId}" chooses by its point: give { ${family.target}: [x, y, z] }, got ${JSON.stringify(point)}.`);
    const acting = actingOf(motion);
    const measured = acting.rig;
    const left = (point[0] - motion.x) * Math.cos(motion.heading) - (point[2] - motion.z) * Math.sin(motion.heading);
    const aside = Math.abs(left) / (measured.span || measured.unit);
    const up = Math.max(0, point[1] - motion.y) / measured.high;
    let fallback = null;
    for (let index = 0; index < family.forms.length; index++) {
      const form = family.forms[index];
      if (!canPerform(motion, acting, form.compiled)) continue;
      if (aside >= form.aside[0] && aside < form.aside[1] && up >= form.up[0] && up < form.up[1]) return form.play;
      fallback = form.play;
    }
    return fallback;
  };

  /**
   * Plays a performance on an instance whose controller has a `Kit.act.performer` (as `Kit.act.character`
   * does): it cross-fades in over what the body was doing, and a one-shot hands back to the base when done.
   * @param {Object} motion a `MotionState`
   * @param {string|Object} performanceOrId an id of `Kit.act.REPERTOIRE` or of `Kit.act.FAMILIES` (the form that
   *   suits the point is played; `Kit.act.playing` then names it), or a compiled performance
   * @param {Object} [params] named world points ({ target: [x, y, z] }; a performance's own default otherwise),
   *   `side` ('left' or 'right': which hand waves, which foot kicks; default: the side its point is on, or the
   *   authored one), `rate` (speed, default 1), `fade` (seconds of cross-fade) and `reach` ({ mark, in }: meet
   *   the named mark of the performance `in` seconds from now - the lead-in up to the mark is sped up or slowed
   *   to fit, and everything after it runs at `rate`, so a dive hurried to a shot still lands and gets up as authored)
   * @returns {boolean} false, changing nothing, when this body cannot do it (`Kit.act.refusal` says why)
   * @throws {Error} for an unknown id, a mark the performance does not declare, or a time that is not positive
   * @complexity O(needs) the first time a body is asked for a performance, O(targets) after
   * @example
   * Kit.act.play(motion, 'kick', { target: [ball.x, ball.y, ball.z] });
   * Kit.act.play(keeper, 'dive', { target: [x, y, z], reach: { mark: 'contact', in: secondsUntilTheBallArrives } });
   */
  const play = (motion, performanceOrId, params) => {
    const form = typeof performanceOrId === 'string' && FAMILIES[performanceOrId] ? choose(motion, performanceOrId, params) : performanceOrId;
    if (form === null) return false;
    const compiled = resolve('play', form);
    if (params && params.reach) {
      const { mark, in: seconds } = params.reach;
      if (!(mark in compiled.marks)) fail('play', `the "${compiled.id}" performance has no mark "${mark}". Its marks: ${Object.keys(compiled.marks).join(', ') || 'none'}.`);
      if (!(compiled.marks[mark] > 0)) fail('play', `the mark "${mark}" of "${compiled.id}" is at its very start: there is no lead-in to fit to a time.`);
      if (!(seconds > 0)) fail('play', `\`reach.in\` must be seconds greater than 0, got ${JSON.stringify(seconds)}.`);
    }
    const acting = actingOf(motion);
    if (!canPerform(motion, acting, compiled)) return false;
    begin(motion, acting, compiled, params);
    return true;
  };

  /**
   * The named moments of a performance, in seconds from its start at the authored speed (`contact`, `land`...).
   * @param {string|Object} performanceOrId an id of `Kit.act.REPERTOIRE`, or a compiled performance
   * @returns {Object<string, number>} mark name -> seconds; frozen, empty when it declares none
   * @throws {Error} for an unknown id
   * @complexity O(1)
   * @example
   * const lead = Kit.act.marks('dive').contact;   // seconds a dive needs to get its hands there, unhurried
   * if (ballArrivesIn < lead) Kit.act.play(keeper, 'dive', { target, reach: { mark: 'contact', in: ballArrivesIn } });
   */
  const marks = (performanceOrId) => resolve('marks', performanceOrId).marks;

  const setBase = (motion, compiled) => {
    const acting = actingOf(motion);
    if (compiled && !canPerform(motion, acting, compiled)) return false;
    const wasOnBase = acting.now === acting.base;
    acting.base = compiled;
    if (wasOnBase) begin(motion, acting, compiled, null);
    return true;
  };

  /**
   * Sets the loop an instance returns to between one-shots (a keeper's ready stance, a dance); null for none.
   * If the instance is on its base now, it changes over at once.
   * @param {Object} motion a `MotionState`
   * @param {?(string|Object)} performanceOrId
   * @returns {boolean} false when this body cannot do it
   * @throws {Error} for an unknown id
   * @complexity as `play`
   * @example Kit.act.base(keeper, 'keeperReady');
   */
  const base = (motion, performanceOrId) => setBase(motion, performanceOrId ? resolve('base', performanceOrId) : null);

  /**
   * Stops whatever is playing and returns to the base loop (also how a held one-shot, such as sitting, is left).
   * @param {Object} motion a `MotionState`
   * @param {number} [fade] seconds of cross-fade (default `Kit.act.TUNING.fadeSeconds`)
   * @returns {void}
   * @complexity O(channels)
   * @example Kit.act.stop(motion);
   */
  const stop = (motion, fade) => {
    const acting = actingOf(motion);
    begin(motion, acting, acting.base, fade === undefined ? null : { fade });
  };

  /**
   * Moves a named point of the performance that is playing (a ball in flight). A reach follows it at once; a
   * travel follows it until the body has left the ground.
   * @param {Object} motion a `MotionState`
   * @param {string} name the point's name, as the performance's reaches use it (usually 'target')
   * @param {number} x world metres
   * @param {number} y
   * @param {number} z
   * @returns {boolean} false when nothing playing uses a point of that name
   * @complexity O(targets)
   * @example Kit.act.aim(keeper, 'target', ball.x, ball.y, ball.z);
   */
  const aim = (motion, name, x, y, z) => {
    const acting = actingOf(motion);
    const index = acting.now ? acting.now.targets.indexOf(name) : -1;
    if (index < 0) return false;
    acting.points[index * VECTOR_STRIDE] = x;
    acting.points[index * VECTOR_STRIDE + 1] = y;
    acting.points[index * VECTOR_STRIDE + 2] = z;
    return true;
  };

  /**
   * Where a named point of the performance that is playing is: the one it was given, its own default placed in
   * front of the body, or where `aim` last moved it. For drawing the ball a default kick is aimed at.
   * @param {Object} motion a `MotionState`
   * @param {string} name the point's name (usually 'target')
   * @param {Float32Array|number[]} out receives [x, y, z], world metres
   * @returns {boolean} false (leaving `out` alone) when nothing playing uses a point of that name
   * @complexity O(targets), no allocation
   * @example if (Kit.act.point(player, 'target', spot)) ball.position.set(spot[0], spot[1], spot[2]);
   */
  const point = (motion, name, out) => {
    const acting = actingOf(motion);
    const index = acting.now ? acting.now.targets.indexOf(name) : -1;
    if (index < 0) return false;
    for (let axis = 0; axis < VECTOR_STRIDE; axis++) out[axis] = acting.points[index * VECTOR_STRIDE + axis];
    return true;
  };

  /**
   * What an instance is playing: the id of a one-shot until it has finished (a held one stays), else null.
   * The base loop does not count.
   * @param {Object} motion a `MotionState`
   * @returns {?string}
   * @complexity O(1)
   * @example if (Kit.act.playing(player) !== 'kick') startNextMove();
   */
  const playing = (motion) => {
    const acting = actingOf(motion);
    return acting.now && acting.now !== acting.base ? acting.now.id : null;
  };

  /**
   * How far through its performance (or its base loop) an instance is.
   * @param {Object} motion a `MotionState`
   * @returns {number} 0..1; 0 when nothing plays
   * @complexity O(1)
   * @example if (Kit.act.playing(player) === 'kick' && Kit.act.progress(player) >= 0.5) launchBall();
   */
  const progress = (motion) => {
    const acting = actingOf(motion);
    return acting.now ? clamp(acting.time / acting.now.seconds, 0, 1) : 0;
  };

  /**
   * Where the body is right now relative to the instance's position: what finished performances left
   * uncollected plus the travel of the one playing. Reads only; a camera or a proof sheet follows the body by it.
   * @param {Object} motion a `MotionState`
   * @param {Float32Array|number[]} out receives [x, z], world metres
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1)
   * @example Kit.act.rootMotion(keeper.motion, offset); camera.lookAt(keeper.x + offset[0], 1, keeper.z + offset[1]);
   */
  const rootMotion = (motion, out) => {
    const acting = actingOf(motion);
    const left = acting.carried[0] + acting.travelled[0];
    const forward = acting.carried[1] + acting.travelled[2];
    out[0] = left * Math.cos(motion.heading) + forward * Math.sin(motion.heading);
    out[1] = -left * Math.sin(motion.heading) + forward * Math.cos(motion.heading);
    return out;
  };

  /**
   * Puts a body that a performance has carried away back over the instance's position in a copy of its pose:
   * the pose is kept, the distance covered is not. For a view that stays on the character (a maker's stage, a
   * proof sheet); a game moves the instance with `takeRootMotion` instead.
   * @param {Object} motion a `MotionState`
   * @param {Object} pose a copy of `motion.pose` (`Kit.rig.copy`); its carrier bone is moved back
   * @returns {void}
   * @complexity O(1), no allocation
   * @example Kit.rig.copy(motion.pose, figure.local); Kit.act.keepInPlace(motion, figure.local); figure.pose();
   */
  const keepInPlace = (motion, pose) => {
    const acting = actingOf(motion);
    const measured = acting.rig || rig(motion.plan, motion.rest);
    const at = measured.carrier * VECTOR_STRIDE;
    pose.translation[at] -= (acting.carried[0] + acting.travelled[0]) / measured.stretch[0];
    pose.translation[at + 2] -= (acting.carried[1] + acting.travelled[2]) / measured.stretch[2];
  };

  /**
   * Collects where a finished performance left the body (a kick's step, a dive's flight): the world offset
   * from the instance's position to where the body now stands. Until it is collected the body is drawn there
   * anyway; add the offset to the game's own position, and `Kit.motion.place` the instance there.
   * @param {Object} motion a `MotionState`
   * @param {Float32Array|number[]} out receives [x, z], world metres
   * @returns {boolean} false (and zeros) when there is nothing to collect
   * @complexity O(1)
   * @example
   * if (Kit.act.takeRootMotion(keeper.motion, offset)) { keeper.x += offset[0]; keeper.z += offset[1]; Kit.motion.place(keeper.motion, keeper.x, 0, keeper.z); }
   */
  const takeRootMotion = (motion, out) => {
    const acting = actingOf(motion);
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    out[0] = acting.carried[0] * cosine + acting.carried[1] * sine;
    out[1] = -acting.carried[0] * sine + acting.carried[1] * cosine;
    const hadAny = acting.carried[0] !== 0 || acting.carried[1] !== 0;
    acting.carried.fill(0);
    return hadAny;
  };

  /**
   * Gives an instance its own seed, so a crowd does not fidget and blink in step.
   * @param {Object} motion a `MotionState`
   * @param {number} seed unsigned 32-bit
   * @returns {Object} `motion`
   * @complexity O(1)
   * @example Kit.act.cast(Kit.motion.state(bake, controller), recipe.seed);
   */
  const cast = (motion, seed) => {
    actingOf(motion).seed = seed >>> 0;
    return motion;
  };

  /**
   * The seed of an instance (`Kit.act.cast`; 1 until it is cast).
   * @param {Object} motion a `MotionState`
   * @returns {number}
   * @complexity O(1)
   * @example const blinkGap = Kit.seeded.unit(Kit.act.seedOf(motion), BLINK_FIELD, count);
   */
  const seedOf = (motion) => actingOf(motion).seed;

  Kit.act = {
    CHANNELS,
    GROUP_NAMES,
    EASES,
    TUNING,
    REPERTOIRE,
    FAMILIES,
    performance,
    define,
    defineFamily,
    choose,
    rig,
    refusal,
    turnHead,
    turnShared,
    lookAngles,
    face,
    stage,
    performer,
    play,
    base,
    stop,
    aim,
    point,
    playing,
    marks,
    progress,
    rootMotion,
    keepInPlace,
    takeRootMotion,
    cast,
    seedOf,
  };
})();
