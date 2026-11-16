/**
 * Kit gait: walking, trotting and running for a body with any number of legs, as `Kit.motion` stages. Nothing
 * here is an animation: a clock turns speed and leg length into a stride, a table says when each leg is on the
 * ground, feet are planted in the world and stay there until they lift, legs are solved by inverse kinematics,
 * and the body rides on the legs that carry it.
 *
 * Owns:  `Kit.gait.GAITS` (walk, trot, run: duty factor and per-leg phase offsets, with rows for two and four
 *        legs and a rule for any other count), `strideLength` and `froude` (the physics the clock runs on),
 *        `legs` (what a plan's legs are, measured from its data), the stages `plant` (full detail: planted
 *        feet, inverse kinematics, a pelvis held where the legs can reach, a sprung bob and a shift over the
 *        support), `swing` (level of detail 1: the same clock driving joint angles, no solving) and `arms`
 *        (arms swing against the legs, as far as the stride is long, folded at a run); the trunk over the legs
 *        (hips and shoulders counter-rotate, a trunk on two rows of legs rocks), a heel strike, the tucked
 *        swing and the flight of a run; `reachLeg` / `levelFoot` (one leg solved to a point, for other
 *        stages); the ready composition `walk`, and `feet` / `support` (read where the
 *        feet are and whether the centre of mass is over them).
 * Does not own: the stage machinery, lean, trailing chains or the fixed clock (kit/motion.js, kit/dynamics.js),
 *        the solvers (kit/reach.js), plans and which way a knee bends (kit/body-plan.js), where the body goes
 *        (the caller moves it; a gait reads the movement), uneven ground (the ground is flat at `motion.y`),
 *        or swimming (kit/swim.js).
 *
 * Conventions (kit/motion.js): metres, seconds, radians; heading 0 faces +Z and grows towards +X, the body's
 * left; "body frame" is left, up, forward. A leg's phase runs 0..1: on the ground for the first `duty` of it.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-gait.js.
 */
(() => {
  const { VECTOR_STRIDE, QUATERNION_STRIDE, QUATERNION_W, AXES } = Kit.rig;
  const { GRAVITY, memory, refreshWorld, shortestTurn } = Kit.motion;
  const { FIXED_STEP } = Kit.dynamics;
  const TAU = Math.PI * 2;

  // ---- tunables -------------------------------------------------------------------------------------------------------

  /**
   * Stride length from speed, by dynamic similarity: animals of any size moving at the same Froude number
   * (speed squared over gravity times leg length) move alike, and across walkers and runners the stride is
   * about `factor` x leg length x Froude^`exponent` (R. McNeill Alexander's fit). So a longer leg takes a longer,
   * slower stride at the same speed, with no table per body.
   */
  const STRIDE = Object.freeze({ factor: 2.3, exponent: 0.3 });

  /**
   * The gaits, slowest first. A body uses the first gait whose `fastestFroude` its Froude number does not
   * exceed (people break into a run near 0.5, horses into a gallop near 2.5). `duty` is the fraction of a
   * stride each foot spends on the ground; `offsets` are where in the stride each leg starts its stance, in
   * the order left legs hind to front, then right legs hind to front. `rows` are written out for two and four
   * legs (the gallop cannot be made by a rule); any other body uses `generic`, whose `rule` is 'sequence'
   * (legs take turns in that order, evenly spaced: a wave) or 'alternate' (neighbours in opposite halves of the
   * stride: a trot, an insect's tripod). `clearance` is how high a swinging foot lifts, in leg lengths.
   */
  const GAITS = Object.freeze({
    walk: {
      fastestFroude: 0.5,
      clearance: 0.08,
      rows: { 2: { duty: 0.62, offsets: [0, 0.5] }, 4: { duty: 0.76, offsets: [0, 0.25, 0.5, 0.75] } },
      generic: { duty: 0.76, rule: 'sequence' },
    },
    trot: {
      fastestFroude: 2.5,
      clearance: 0.16,
      rows: { 2: { duty: 0.42, offsets: [0, 0.5] }, 4: { duty: 0.45, offsets: [0, 0.5, 0.5, 0] } },
      generic: { duty: 0.5, rule: 'alternate' },
    },
    run: {
      fastestFroude: Infinity,
      clearance: 0.22,
      rows: { 2: { duty: 0.32, offsets: [0, 0.5] }, 4: { duty: 0.3, offsets: [0, 0.55, 0.1, 0.65] } },
      generic: { duty: 0.4, rule: 'alternate' },
    },
  });
  const GAIT_NAMES = Object.freeze(Object.keys(GAITS));
  /** How each generic rule spaces the legs: (index in order, leg count, row from the back, is it on the right or the middle) -> phase offset. */
  const OFFSET_RULES = Object.freeze({
    sequence: (index, count) => index / count,
    alternate: (_index, _count, row, sideStep) => ((row + sideStep) % 2) / 2,
  });

  /** The clock. Rates are per second; Froude numbers are dimensionless. */
  const CLOCK = Object.freeze({
    idleFroude: 0.0008, // slower than this is standing (about 8 cm a second for a person)
    gaitHysteresis: 0.12, // a gait is left only this fraction past its limit, so a speed on the limit does not flicker
    dutyRate: 5, // how fast the duty factor eases to a new gait's
    mostTravel: 0.95, // leg lengths the body may travel over a planted foot; caps the duty factor at speed
    settleSwings: 2, // strides per leg-pendulum period while standing feet step back under the body
  });
  /** A swing lasts between these fractions of the leg's pendulum period (2 pi sqrt(leg length / g)), whatever the stride asks. */
  const SWING = Object.freeze({ shortest: 0.08, longest: 0.33 });
  /** Standing and reaching, in leg lengths unless noted. */
  const STANCE = Object.freeze({
    crouch: 0.025, // how far below a straight-legged stand the body rides at a walk
    standCrouch: 0.004, // and standing still: a leg shortened by 2.5% already shows its knee a ninth of its length forward
    walkCrouchFull: 0.08, // the Froude number by which the walking crouch has come in
    runCrouch: 0.06, // how much further down it rides at a run: a running leg is a spring, loaded all through its stance
    runCrouchFrom: 0.4, // the Froude numbers between which the extra crouch comes in
    runCrouchFull: 1.4,
    stretch: 0.996, // the furthest a leg is allowed to straighten: a dead-straight limb has no bend direction
    landShare: 0.4, // of a stance's travel that lies ahead of the hip at touchdown; the rest is behind it, reached by rolling onto the toe
    riseRate: 0.14, // leg lengths per second the body may come back up after a leg pulled it down, so a dip has a rounded far side
    settleTolerance: 0.06, // a standing foot further than this from under its hip steps back
    forceStep: 0.8, // a planted foot left this far behind lifts at once, whatever the clock says
    mostHeelPitch: 0.75, // radians a foot may pitch about its toe at the end of a stance
    heelSearchSteps: 5, // bisection steps to find the smallest heel pitch that lets the leg reach
    shiftShare: 0.35, // of the way the body moves sideways towards the middle of the feet that carry it
    shiftStiffness: 45, // 1/s^2
    bobStiffness: 170, // 1/s^2: a little over two cycles a second, about a walker's step rate
    bobDamping: 0.45, // damping ratio
    bobKick: 0.11, // metres per second of downward speed a landing gives the body, per metre per second of travel
  });
  /** Level of detail 1: joint angles from the clock. Radians unless noted. */
  const SWING_ONLY = Object.freeze({ mostReach: 0.85, stanceKnee: 0.12, swingKnee: 0.95, fullSwingAt: 0.4, dipShare: 0.6 });
  /** Arms. Radians unless noted. */
  const ARMS = Object.freeze({
    swingPerStride: 0.34, // shoulder swing each way per leg length of stride: an arm swings as far as the leg it balances
    mostSwing: 1, // however long the stride
    elbowRest: 0.16, // a walker's arm hangs almost straight
    elbowRun: 1.45, // a runner's is folded to about a right angle
    elbowSwing: 0.3, // extra fold as the arm comes forward
  });
  /** How much of a run a movement is, from its Froude number: none at or below `from`, all at `full`. People break into a run near 0.5. */
  const RUN = Object.freeze({ from: 0.5, full: 1.3 });
  /**
   * The trunk over the legs. Radians per unit of stride size (half a stance over a leg length, at most 1) unless noted.
   */
  const TORSO = Object.freeze({
    twist: 0.36, // a girdle turns towards its leg that is forward (the hip follows the foot)
    list: 0.08, // and drops on the side of the leg that is in the air
    shoulders: 0.9, // of the hips' twist the shoulders show the OTHER way: the arms' swing starts in the chest
    steadyHead: 0.9, // of all that turning the neck takes back, so the eyes stay on where the body is going
    rock: 0.14, // a trunk on two rows of legs pitches towards the row that is on the ground (a gallop rocks)
    lean: 0.14, // radians of forward lean per unit of Froude number: almost nothing at a walk, a clear lean at a run
  });
  /** A swinging foot beyond the plain arc of its gait's clearance. In leg lengths unless noted. */
  const SWING_PATH = Object.freeze({
    tuck: 0.3, // at a run the heel comes up behind before the knee drives through
    tuckBy: 0.55, // fraction of the swing by which the tuck is over
    strike: 0.5, // radians the toes are held up as a walking foot reaches forward: it comes down heel first
    strikeFrom: 0.4, // fraction of the swing at which the toes start to lift; they are flat again as the weight comes on
  });
  /** With no foot on the ground a body is a projectile: it rises and falls on a parabola, drawn this many times taller so it reads. */
  const FLIGHT_BOOST = 2.5;
  /** How fast each leg's place in the stride eases to a new gait's, per second: a walk becomes a trot over a stride, not in a frame. */
  const OFFSET_RATE = 5;

  const NAME = 'Kit.gait';
  const SIDE = Object.freeze({ left: 0, middle: 1, right: 2 });
  /** Legs whose hips sit within this of the centre line (in leg lengths) count as on it. */
  const SIDE_TOLERANCE = 0.03;
  /** Hips within this of each other fore and aft (in leg lengths) are one row. */
  const ROW_TOLERANCE = 0.15;
  const TINY = 1e-6;
  /** A leg is a hip, a knee and a foot; with exactly these it is solved exactly, with more as a chain. */
  const FEWEST_LEG_BONES = 3;
  const WALK_NEEDS = Kit.body.requirement({ atLeast: { legs: 2 } });
  const LEG_MASK = Kit.body.roleMask(['leg']);
  const ARM_MASK = Kit.body.roleMask(['arm']);
  const SPINE_MASK = Kit.body.roleMask(['spine']);
  const NECK_MASK = Kit.body.roleMask(['neck']);
  const HEAD_MASK = Kit.body.roleMask(['head']);
  /** Rows of legs a trunk's turning is worked out for (a centipede's further rows ride rigidly). */
  const MOST_ROWS = 8;

  const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));
  const fraction = (value) => value - Math.floor(value);

  // ---- the physics the clock runs on --------------------------------------------------------------------------------

  /**
   * The Froude number of a body moving on legs: speed squared over gravity times leg length. Two bodies at the
   * same number move alike whatever their size, which is what lets one gait table serve every body.
   * @param {number} speed metres per second
   * @param {number} legLength metres, hip to ankle
   * @returns {number}
   * @complexity O(1)
   * @example Kit.gait.froude(1.4, 0.87) // 0.23: a person walking
   */
  const froude = (speed, legLength) => (speed * speed) / (GRAVITY * legLength);

  /**
   * How far a body travels in one full stride (until the same foot lands again) at a speed.
   * @param {number} speed metres per second
   * @param {number} legLength metres, hip to ankle
   * @returns {number} metres; 0 at a standstill
   * @complexity O(1)
   * @example Kit.gait.strideLength(1.4, 0.87) // 1.29; with legs a fifth longer, 1.47
   */
  const strideLength = (speed, legLength) => STRIDE.factor * legLength * froude(speed, legLength) ** STRIDE.exponent;

  /**
   * Where a foot is, fore and aft of its hip, through a stride: +1 as it lands in front, falling evenly to -1
   * as the body passes over it, then swung smoothly back to +1.
   * @param {number} legPhase 0..1
   * @param {number} duty the fraction of the stride spent on the ground
   * @returns {number} -1..1
   * @complexity O(1)
   * @example Kit.gait.footOffset(0, 0.6) // 1: just landed, out in front
   */
  const footOffset = (legPhase, duty) => (legPhase < duty ? 1 - (2 * legPhase) / duty : -1 + 2 * Kit.blend.smooth((legPhase - duty) / (1 - duty)));

  // ---- what a plan's legs are -----------------------------------------------------------------------------------------

  /**
   * @typedef {Object} LegRig
   * A plan's legs and arms, measured once from the plan and a proportioned rest pose. Per-leg arrays are in gait
   * order: left legs hind to front, then any on the centre line, then right legs hind to front.
   * @property {number} count legs
   * @property {Int16Array} upper per leg: the bone at the body (hip)
   * @property {Int16Array} middle per leg: its child (knee)
   * @property {Int16Array} end per leg: the last bone of the leg, whose joint is the ankle
   * @property {Array<?Int16Array>} longChains per leg: every joint from hip to ankle when the leg has more than
   *   three bones (solved as a chain), else null (solved as two bones)
   * @property {Float32Array} length per leg: hip to ankle along the bones, metres
   * @property {Float32Array} hipX per leg: the hip in the body frame at rest (left, up, forward), metres
   * @property {Float32Array} hipY
   * @property {Float32Array} hipZ
   * @property {Float32Array} homeX per leg: where the ankle rests in the body frame (left, forward)
   * @property {Float32Array} homeZ
   * @property {Float32Array} sole per leg: how high the ankle is above the lowest point of its foot
   * @property {Float32Array} toe 3 per leg: from the ankle to the end of the foot bone in the body frame at rest;
   *   zeros for a foot with no extent (it cannot roll onto its toe)
   * @property {Float32Array} footRotation 4 per leg: the foot bone's rotation in the body frame at rest
   * @property {Float32Array} bendX per leg: the way the knee points, in the body frame (left, forward), unit
   * @property {Float32Array} bendZ
   * @property {Int8Array} flexSign per leg: the sign of the knee's own X turn that folds it
   * @property {Uint8Array} side per leg: 0 left, 1 on the centre line, 2 right
   * @property {Uint8Array} row per leg: 0 for the hindmost row of hips, counting forwards
   * @property {number} legLength the mean leg length, metres: what the clock scales by
   * @property {number} pendulumPeriod seconds: 2 pi sqrt(legLength / g)
   * @property {number} standLift how far the carrier bone is raised from the rest pose so the lowest sole rests
   *   on the ground (dials that lengthen legs push the rest pose's feet below the root)
   * @property {number} upright 1 for a body whose hips are all in one row (it can lean from them), falling to 0 as
   *   the rows of hips spread a leg length apart (a level trunk on legs at both ends must not nod)
   * @property {number} carrier the bone the body is carried by (`Kit.motion.carrier`)
   * @property {number} rowCount rows of hips, at most `MOST_ROWS`
   * @property {Int16Array} rowLeft per row: a left leg of it, or -1
   * @property {Int16Array} rowRight per row: a right leg of it, or -1
   * @property {Int16Array} rowGirdle per row: the spine bone its hips hang from (a pelvis, a shoulder girdle)
   * @property {number} armGirdle the spine bone the arms hang from, or -1 when that is the carrier or there are no arms
   * @property {number} steadyBone the first bone of the neck (else the head), which keeps the head facing ahead; or -1
   * @property {Uint8Array} steadyUnder per row, then the arm girdle: 1 when the steady bone hangs from that girdle
   * @property {Float32Array} frames `Kit.motion.restFrames`: for turning bones about the body's axes
   * @property {number} stretchX how much the carrier's parent stretches offsets, left and up (for writing a
   *   world shift into the local pose)
   * @property {number} stretchY
   * @property {Array<{duty: number, offsets: Float32Array, clearance: number, fastestFroude: number}>} gaits one
   *   per `GAITS` row, in order: this body's duty factor and per-leg offsets
   * @property {number} armCount
   * @property {Int16Array} armUpper per arm: the bone at the shoulder
   * @property {Int16Array} armElbow per arm: its child, or -1
   * @property {Int8Array} elbowSign per arm: the sign of the elbow's own X turn that folds it
   * @property {Int16Array} armLeg per arm: the leg it swings with (the nearest on the other side)
   * @property {Float32Array} armShift per arm: phase added to that leg's (0.5 when no leg is on the other side)
   */

  /** What is wrong with a plan's legs for walking, or null. */
  const legProblem = (plan) => {
    const short = Kit.body.chains(plan, LEG_MASK).find((chain) => chain.length < FEWEST_LEG_BONES);
    if (short)
      return `its leg at "${plan.boneNames[short[0]]}" has ${short.length} bone${short.length === 1 ? '' : 's'}; a leg needs a hip, a knee and a foot (3 or more bones carrying the leg role).`;
    const body = Kit.motion.carrier(plan);
    const rootTurn = Math.hypot(plan.restRotation[0], plan.restRotation[1], plan.restRotation[2]);
    if (plan.parent[body] !== 0 || rootTurn > TINY) return 'its root bone must be bone 0, unturned, with the body hanging from it (as every sample plan has a "ground" bone).';
    return null;
  };

  /** What the walking stages need of a plan: two or more legs, each of three or more bones, under an unturned root. */
  const WALK_STAGE_NEEDS = Object.freeze([{ consumer: 'the walk gait', requirement: WALK_NEEDS, check: legProblem }]);

  /** The row of a gait this body uses: the written one when its legs are that many in matched pairs, else the generic rule. */
  const gaitRowFor = (gait, count, side, row) => {
    const lefts = side.filter((value) => value === SIDE.left).length;
    const isPaired = lefts * 2 === count && !side.includes(SIDE.middle);
    const written = isPaired ? gait.rows[count] : undefined;
    const offsets = written ? written.offsets : Array.from(side, (legSide, index) => OFFSET_RULES[gait.generic.rule](index, count, row[index], legSide === SIDE.left ? 0 : 1));
    return { duty: (written || gait.generic).duty, offsets: Float32Array.from(offsets), clearance: gait.clearance, fastestFroude: gait.fastestFroude };
  };

  /** @type {WeakMap<Object, LegRig>} */
  const rigByRest = new WeakMap();
  const scratchPoint = new Float32Array(VECTOR_STRIDE);

  /**
   * Measures a plan's legs (and arms) for walking: which bones they are, how long, where the hips and feet sit,
   * which way each knee bends (from its limits, by `Kit.body.bendDirection`; a joint with no preferred side
   * bends forwards, or backwards when the leg is in front of the body's middle, as elbows do), and when each
   * leg steps in each gait. Remembered per rest pose, so every instance of a bake shares one.
   * @param {Object} plan a `BodyPlan`
   * @param {Object} rest its proportioned rest pose (a bake's `rest`); dials change every length here
   * @returns {LegRig} frozen
   * @throws {Error} when the plan has a leg of fewer than three bones or no unturned root bone
   * @complexity O(bones x legs) time once per rest pose, O(1) after; O(legs) space
   * @example Kit.gait.legs(bake.plan, bake.rest).legLength // 0.87 for the sample biped
   */
  const legs = (plan, rest) => {
    const known = rigByRest.get(rest);
    if (known) return known;
    const problem = legProblem(plan);
    if (problem) throw new Error(`${NAME}.legs: the plan "${plan.id}" cannot walk: ${problem}`);
    const world = Kit.body.worldTransforms(plan, rest, Kit.rig.create(plan.boneCount));
    const at = (bone, axis) => world.translation[bone * VECTOR_STRIDE + axis];
    const between = (from, to) => Math.hypot(at(to, 0) - at(from, 0), at(to, 1) - at(from, 1), at(to, 2) - at(from, 2));
    const chains = Kit.body.chains(plan, LEG_MASK);
    if (!chains.length) throw new Error(`${NAME}.legs: the plan "${plan.id}" has no legs (no bone carries the leg role).`);
    const lengthOf = (chain) => chain.slice(1).reduce((sum, bone, link) => sum + between(chain[link], bone), 0);
    const legLength = chains.reduce((sum, chain) => sum + lengthOf(chain), 0) / chains.length;
    const middleZ = chains.reduce((sum, chain) => sum + at(chain[0], 2), 0) / chains.length;
    const sideOf = (x) => (x > SIDE_TOLERANCE * legLength ? SIDE.left : x < -SIDE_TOLERANCE * legLength ? SIDE.right : SIDE.middle);
    // Gait order: left legs hind to front, the centre line, right legs hind to front.
    const ordered = [...chains].sort((first, second) => sideOf(at(first[0], 0)) - sideOf(at(second[0], 0)) || at(first[0], 2) - at(second[0], 2));
    const count = ordered.length;
    // Rows of hips from the back: a new row starts wherever the next hip is clearly further forward.
    const hipsBackToFront = ordered.map((chain) => at(chain[0], 2)).sort((first, second) => first - second);
    const rowStarts = hipsBackToFront.filter((hipZ, index) => index === 0 || hipZ - hipsBackToFront[index - 1] > ROW_TOLERANCE * legLength);
    const direction = [0, 0, 0];
    const rig = {
      count,
      upper: Int16Array.from(ordered, (chain) => chain[0]),
      middle: Int16Array.from(ordered, (chain) => chain[1]),
      end: Int16Array.from(ordered, (chain) => chain[chain.length - 1]),
      longChains: ordered.map((chain) => (chain.length > FEWEST_LEG_BONES ? Int16Array.from(chain) : null)),
      length: Float32Array.from(ordered, lengthOf),
      hipX: Float32Array.from(ordered, (chain) => at(chain[0], 0)),
      hipY: Float32Array.from(ordered, (chain) => at(chain[0], 1)),
      hipZ: Float32Array.from(ordered, (chain) => at(chain[0], 2)),
      homeX: Float32Array.from(ordered, (chain) => at(chain[chain.length - 1], 0)),
      homeZ: Float32Array.from(ordered, (chain) => at(chain[chain.length - 1], 2)),
      sole: new Float32Array(count),
      toe: new Float32Array(count * VECTOR_STRIDE),
      footRotation: new Float32Array(count * QUATERNION_STRIDE),
      bendX: new Float32Array(count),
      bendZ: new Float32Array(count),
      flexSign: new Int8Array(count),
      side: Uint8Array.from(ordered, (chain) => sideOf(at(chain[0], 0))),
      row: Uint8Array.from(ordered, (chain) => rowStarts.filter((start) => start <= at(chain[0], 2) + TINY).length - 1),
      legLength,
      pendulumPeriod: TAU * Math.sqrt(legLength / GRAVITY),
      standLift: 0,
      upright: Math.max(0, 1 - (hipsBackToFront[count - 1] - hipsBackToFront[0]) / legLength),
      carrier: Kit.motion.carrier(plan),
      rowCount: 0,
      rowLeft: new Int16Array(0),
      rowRight: new Int16Array(0),
      rowGirdle: new Int16Array(0),
      armGirdle: -1,
      steadyBone: -1,
      steadyUnder: new Uint8Array(0),
      frames: new Float32Array(0),
      stretchX: world.scale[0],
      stretchY: world.scale[1],
      gaits: [],
      armCount: 0,
      armUpper: new Int16Array(0),
      armElbow: new Int16Array(0),
      elbowSign: new Int8Array(0),
      armLeg: new Int16Array(0),
      armShift: new Float32Array(0),
    };
    let lowestSole = Infinity;
    ordered.forEach((chain, leg) => {
      const foot = chain[chain.length - 1];
      Kit.body.tailPosition(plan, world, foot, scratchPoint);
      for (let axis = 0; axis < VECTOR_STRIDE; axis++) rig.toe[leg * VECTOR_STRIDE + axis] = scratchPoint[axis] - at(foot, axis);
      rig.sole[leg] = Math.max(0, -rig.toe[leg * VECTOR_STRIDE + 1]);
      lowestSole = Math.min(lowestSole, at(foot, 1) - rig.sole[leg]);
      rig.footRotation.set(world.rotation.subarray(foot * QUATERNION_STRIDE, (foot + 1) * QUATERNION_STRIDE), leg * QUATERNION_STRIDE);
      Kit.body.bendDirection(plan, chain[1], direction);
      const flat = Math.hypot(direction[0], direction[2]);
      // No preferred side (a ball joint): knees point forward, and the legs in front of the body's middle fold back like elbows.
      const isFront = at(chain[0], 2) > middleZ + ROW_TOLERANCE * legLength;
      rig.bendX[leg] = flat > TINY ? direction[0] / flat : 0;
      rig.bendZ[leg] = flat > TINY ? direction[2] / flat : isFront ? -1 : 1;
      rig.flexSign[leg] = rig.bendZ[leg] >= 0 ? 1 : -1;
    });
    rig.standLift = -lowestSole;
    rig.gaits = GAIT_NAMES.map((name) => gaitRowFor(GAITS[name], count, Array.from(rig.side), Array.from(rig.row)));

    const arms = Kit.body.chains(plan, ARM_MASK);
    const legWith = (armSide, armZ) => {
      // The nearest leg on the other side swings in step with this arm; with no such leg, the nearest at all, half a stride on.
      const candidates = Array.from(rig.side, (side, leg) => ({ leg, isOpposite: side !== armSide && side !== SIDE.middle && armSide !== SIDE.middle, gap: Math.abs(rig.hipZ[leg] - armZ) }));
      const opposite = candidates.filter((candidate) => candidate.isOpposite);
      const chosen = (opposite.length ? opposite : candidates).reduce((best, candidate) => (candidate.gap < best.gap ? candidate : best));
      return { leg: chosen.leg, shift: opposite.length ? 0 : 0.5 };
    };
    const partners = arms.map((chain) => legWith(sideOf(at(chain[0], 0)), at(chain[0], 2)));
    Object.assign(rig, {
      armCount: arms.length,
      armUpper: Int16Array.from(arms, (chain) => chain[0]),
      armElbow: Int16Array.from(arms, (chain) => (chain.length > 1 ? chain[1] : -1)),
      // An elbow folds whichever way its limits lean; with centred limits, forwards (a negative turn about X).
      elbowSign: Int8Array.from(arms, (chain) => (chain.length > 1 && plan.limitMin[chain[1] * VECTOR_STRIDE] + plan.limitMax[chain[1] * VECTOR_STRIDE] > 0 ? 1 : -1)),
      armLeg: Int16Array.from(partners, (partner) => partner.leg),
      armShift: Float32Array.from(partners, (partner) => partner.shift),
    });
    // The trunk: which spine bone each row of hips hangs from, and what the arms and the head hang from.
    const girdleOf = (bone) => {
      let above = plan.parent[bone];
      while (above > 0 && !(plan.roles[above] & SPINE_MASK)) above = plan.parent[above];
      return above > 0 ? above : rig.carrier;
    };
    const isUnder = (bone, ancestor) => {
      for (let above = bone; above >= 0; above = plan.parent[above]) if (above === ancestor) return true;
      return false;
    };
    const rowCount = Math.min(MOST_ROWS, rowStarts.length);
    const legOfRow = (row, side) => Array.from(rig.side).findIndex((legSide, leg) => rig.row[leg] === row && legSide === side);
    const rowGirdle = Int16Array.from({ length: rowCount }, (_unused, row) => girdleOf(rig.upper[Array.from(rig.row).indexOf(row)]));
    const armGirdle = arms.length ? girdleOf(arms[0][0]) : -1;
    const steadyBone = [...Kit.body.bonesWithRoles(plan, NECK_MASK), ...Kit.body.bonesWithRoles(plan, HEAD_MASK), -1][0];
    Object.assign(rig, {
      rowCount,
      rowLeft: Int16Array.from({ length: rowCount }, (_unused, row) => legOfRow(row, SIDE.left)),
      rowRight: Int16Array.from({ length: rowCount }, (_unused, row) => legOfRow(row, SIDE.right)),
      rowGirdle,
      armGirdle: armGirdle === rig.carrier || rowGirdle.includes(armGirdle) ? -1 : armGirdle,
      steadyBone,
      steadyUnder: Uint8Array.from([...rowGirdle, armGirdle], (girdle) => (steadyBone >= 0 && girdle >= 0 && isUnder(steadyBone, girdle) ? 1 : 0)),
      frames: Kit.motion.restFrames(plan, rest),
    });
    rigByRest.set(rest, Object.freeze(rig));
    return rig;
  };

  // ---- the clock: speed -> gait, stride, phase ----------------------------------------------------------------------

  /**
   * @typedef {Object} FeetState
   * Where an instance's feet are (full detail only). Arrays are per leg, in the rig's gait order. Read only.
   * @property {Uint8Array} planted 1 while the foot is on the ground
   * @property {Float32Array} footX where the ankle stands (planted) or last stood, world metres
   * @property {Float32Array} footZ
   * @property {Float32Array} footHeading the way the planted foot points, radians
   * @property {Float32Array} targetX where the ankle is asked to be this frame (in the air while swinging, raised
   *   over the toe at the end of a stance), world metres
   * @property {Float32Array} targetY
   * @property {Float32Array} targetZ
   * @property {Float32Array} pitch how far the foot is pitched about its toe, radians
   * @property {Float32Array} strike how far a swinging foot's toes are held up as it reaches forward, radians (zero or negative)
   * @property {number} air metres the body is off its standing height because no foot is down (a run's flight)
   * @property {Float32Array} swing 0..1 through the swing, for a foot in the air
   * @property {Uint32Array} plantCount how many times the foot has landed
   * @property {Object} bob the spring the body's height rides on (`Kit.dynamics` spring)
   * @property {Object} shift the spring the body's sideways shift rides on
   */

  /**
   * @typedef {Object} GaitClock
   * An instance's gait, kept in `motion.memory.gait`. Read only.
   * @property {LegRig} rig
   * @property {number} gait index into `Kit.gait.GAIT_NAMES`
   * @property {number} froude
   * @property {number} duty the fraction of a stride each foot is down (eased between gaits)
   * @property {number} stride metres per stride at this speed
   * @property {number} cadence strides per second
   * @property {number} halfStance metres a planted foot travels each side of its hip
   * @property {boolean} isMoving false while standing
   * @property {number} runShare 0 at a walk, 1 at a full run (`Kit.gait.RUN`)
   * @property {Float32Array} offsets per leg: where in the stride it starts its stance (eased from one gait's to the next's)
   * @property {?FeetState} feet made by the `plant` stage; null at lower detail
   */

  const DUTY_BLEND = 1 - Math.exp(-CLOCK.dutyRate * FIXED_STEP);
  const OFFSET_BLEND = 1 - Math.exp(-OFFSET_RATE * FIXED_STEP);

  /** @returns {GaitClock} */
  const createClock = (motion) => {
    const rig = legs(motion.plan, motion.rest);
    return { rig, gait: 0, froude: 0, duty: rig.gaits[0].duty, stride: 0, cadence: 0, halfStance: 0, isMoving: false, runShare: 0, offsets: Float32Array.from(rig.gaits[0].offsets), feet: null };
  };
  const clockOf = (motion) => memory(motion, 'gait', createClock);

  /** One fixed step of the clock: picks the gait for the speed, sizes the stride and moves the phase on. */
  const stepClock = (motion, clock, isSettling, dt) => {
    const { rig } = clock;
    clock.froude = froude(motion.speed, rig.legLength);
    // Leave a gait only when clearly past its limit either way.
    while (clock.gait < rig.gaits.length - 1 && clock.froude > rig.gaits[clock.gait].fastestFroude * (1 + CLOCK.gaitHysteresis)) clock.gait += 1;
    while (clock.gait > 0 && clock.froude < rig.gaits[clock.gait - 1].fastestFroude * (1 - CLOCK.gaitHysteresis)) clock.gait -= 1;
    const row = rig.gaits[clock.gait];
    // Each leg's place in the stride moves to the gait's the shorter way round the cycle.
    for (let leg = 0; leg < rig.count; leg++) {
      const apart = row.offsets[leg] - clock.offsets[leg];
      clock.offsets[leg] = fraction(clock.offsets[leg] + (apart - Math.round(apart)) * OFFSET_BLEND);
    }
    clock.isMoving = clock.froude > CLOCK.idleFroude;
    clock.runShare = Kit.blend.smooth(clamp((clock.froude - RUN.from) / (RUN.full - RUN.from), 0, 1));
    clock.stride = STRIDE.factor * rig.legLength * clock.froude ** STRIDE.exponent;
    // A foot can only stay down while the body travels about a leg length over it: at speed the duty factor falls below the table's.
    const reachDuty = clock.isMoving ? (CLOCK.mostTravel * rig.legLength) / clock.stride : 1;
    clock.duty += (Math.min(row.duty, reachDuty) - clock.duty) * DUTY_BLEND;
    // Standing, the clock only runs while a foot still has to step back under the body.
    clock.cadence = clock.isMoving ? motion.speed / clock.stride : isSettling ? CLOCK.settleSwings / rig.pendulumPeriod : 0;
    clock.halfStance = clock.isMoving ? (clock.duty * clock.stride) / 2 : 0;
    motion.phase = fraction(motion.phase + clock.cadence * dt);
  };

  // ---- full detail: planted feet ----------------------------------------------------------------------------------------

  /** Makes an instance's `FeetState`, plus the lift records and timers the stage keeps to itself. */
  const createFeet = (rig) => ({
    planted: new Uint8Array(rig.count),
    footX: new Float32Array(rig.count),
    footZ: new Float32Array(rig.count),
    footHeading: new Float32Array(rig.count),
    liftX: new Float32Array(rig.count),
    liftY: new Float32Array(rig.count),
    liftZ: new Float32Array(rig.count),
    liftPitch: new Float32Array(rig.count),
    liftHeading: new Float32Array(rig.count),
    targetX: new Float32Array(rig.count),
    targetY: new Float32Array(rig.count),
    targetZ: new Float32Array(rig.count),
    pitch: new Float32Array(rig.count),
    strike: new Float32Array(rig.count),
    swing: new Float32Array(rig.count),
    plantCount: new Uint32Array(rig.count),
    bob: Kit.dynamics.spring({ stiffness: STANCE.bobStiffness, damping: STANCE.bobDamping * Kit.dynamics.criticalDamping(STANCE.bobStiffness) }),
    shift: Kit.dynamics.spring({ stiffness: STANCE.shiftStiffness }),
    drop: 0,
    flightSeconds: 0,
    flightSpan: 0,
    air: 0,
    isSettling: false,
    epoch: -1,
    steppedAt: -1,
  });

  /** Stands every foot under its hip where the body is now: at the start, after a teleport, and on coming back from a lower detail. */
  const standFeet = (motion, rig, feet) => {
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    for (let leg = 0; leg < rig.count; leg++) {
      feet.planted[leg] = 1;
      feet.footX[leg] = motion.x + rig.homeX[leg] * cosine + rig.homeZ[leg] * sine;
      feet.footZ[leg] = motion.z - rig.homeX[leg] * sine + rig.homeZ[leg] * cosine;
      feet.footHeading[leg] = motion.heading;
      feet.targetX[leg] = feet.footX[leg];
      feet.targetY[leg] = motion.y + rig.sole[leg];
      feet.targetZ[leg] = feet.footZ[leg];
      feet.pitch[leg] = 0;
      feet.strike[leg] = 0;
      feet.swing[leg] = 0;
    }
    feet.flightSpan = 0;
    feet.air = 0;
    feet.bob.value = 0;
    feet.bob.velocity = 0;
    feet.shift.value = 0;
    feet.shift.velocity = 0;
    feet.drop = 0;
    feet.epoch = motion.epoch;
  };

  /** One fixed step of the feet: the clock, then each leg lifts when its turn comes, swings to where it will be needed, and plants. */
  const stepFeet = (motion, _plan, dt) => {
    const clock = clockOf(motion);
    const { rig } = clock;
    const feet = clock.feet || (clock.feet = createFeet(rig));
    // A gap in the steps means this stage was not running (a lower detail, a gated branch): the old plants mean nothing now.
    if (feet.epoch !== motion.epoch || motion.time - feet.steppedAt > 2.5 * dt) standFeet(motion, rig, feet);
    feet.steppedAt = motion.time;
    stepClock(motion, clock, feet.isSettling, dt);
    const { duty } = clock;
    const period = rig.pendulumPeriod;
    const swingSeconds = clamp(clock.cadence > 0 ? (1 - duty) / clock.cadence : Infinity, SWING.shortest * period, SWING.longest * period);
    const stanceSeconds = clock.isMoving ? duty / clock.cadence : 0;
    const clearance = rig.gaits[clock.gait].clearance * rig.legLength;
    const tuck = SWING_PATH.tuck * clock.runShare * rig.legLength;
    // Only a walking foot comes down heel first, and the toes lift further the longer the stride.
    const strike = -SWING_PATH.strike * (1 - clock.runShare) * Math.min(1, clock.halfStance / (SWING_ONLY.fullSwingAt * rig.legLength));
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    let stillSettling = false;
    let plantedCount = 0;
    let soonestLanding = Infinity;
    // Hot path: an index loop over the legs, no allocation.
    for (let leg = 0; leg < rig.count; leg++) {
      const legPhase = fraction(motion.phase + clock.offsets[leg]);
      if (feet.planted[leg]) {
        const homeX = motion.x + rig.homeX[leg] * cosine + rig.homeZ[leg] * sine;
        const homeZ = motion.z - rig.homeX[leg] * sine + rig.homeZ[leg] * cosine;
        const astray = Math.hypot(feet.footX[leg] - homeX, feet.footZ[leg] - homeZ);
        const isAstray = astray > STANCE.settleTolerance * rig.length[leg];
        // Its turn: the first half of its swing window (a foot that landed late does not lift again at once).
        const isItsTurn = legPhase >= duty && legPhase - duty < (1 - duty) / 2;
        if ((isItsTurn && (clock.isMoving || isAstray)) || astray > STANCE.forceStep * rig.length[leg]) {
          feet.planted[leg] = 0;
          feet.swing[leg] = 0;
          feet.liftX[leg] = feet.targetX[leg];
          feet.liftY[leg] = feet.targetY[leg] - motion.y - rig.sole[leg];
          feet.liftZ[leg] = feet.targetZ[leg];
          feet.liftPitch[leg] = feet.pitch[leg];
          feet.liftHeading[leg] = feet.footHeading[leg];
        } else if (isAstray) stillSettling = true;
      }
      if (feet.planted[leg]) {
        plantedCount += 1;
        continue;
      }
      stillSettling = true;
      feet.swing[leg] = Math.min(1, feet.swing[leg] + dt / swingSeconds);
      soonestLanding = Math.min(soonestLanding, (1 - feet.swing[leg]) * swingSeconds);
      // Land ahead of where the hip will be at touchdown by a share of the stance's travel, so the body passes over the foot.
      const lead = (1 - feet.swing[leg]) * swingSeconds + stanceSeconds * STANCE.landShare;
      const landHeading = motion.heading + motion.turnRate * lead;
      const landSine = Math.sin(landHeading);
      const landCosine = Math.cos(landHeading);
      const landX = motion.x + motion.velocityX * lead + rig.homeX[leg] * landCosine + rig.homeZ[leg] * landSine;
      const landZ = motion.z + motion.velocityZ * lead - rig.homeX[leg] * landSine + rig.homeZ[leg] * landCosine;
      if (feet.swing[leg] >= 1) {
        feet.planted[leg] = 1;
        feet.footX[leg] = landX;
        feet.footZ[leg] = landZ;
        feet.footHeading[leg] = motion.heading;
        feet.targetX[leg] = landX;
        feet.targetY[leg] = motion.y + rig.sole[leg];
        feet.targetZ[leg] = landZ;
        feet.pitch[leg] = 0;
        feet.strike[leg] = 0;
        feet.plantCount[leg] += 1;
        plantedCount += 1;
        // The body gives a little as the weight comes onto the new foot.
        feet.bob.velocity -= STANCE.bobKick * motion.speed;
        continue;
      }
      const eased = Kit.blend.smooth(feet.swing[leg]);
      feet.targetX[leg] = feet.liftX[leg] + (landX - feet.liftX[leg]) * eased;
      feet.targetZ[leg] = feet.liftZ[leg] + (landZ - feet.liftZ[leg]) * eased;
      // The gait's arc, and at a run the heel coming up behind in the first part of the swing.
      const tucked = feet.swing[leg] < SWING_PATH.tuckBy ? tuck * Math.sin((Math.PI * feet.swing[leg]) / SWING_PATH.tuckBy) : 0;
      feet.targetY[leg] = motion.y + rig.sole[leg] + feet.liftY[leg] * (1 - eased) + clearance * Math.sin(Math.PI * feet.swing[leg]) + tucked;
      feet.pitch[leg] = feet.liftPitch[leg] * (1 - eased);
      // Toes up through the reach, flat by the moment of landing: a planted foot never turns but about its toe.
      feet.strike[leg] = strike * Math.sin(Math.PI * clamp((feet.swing[leg] - SWING_PATH.strikeFrom) / (1 - SWING_PATH.strikeFrom), 0, 1)) ** 2;
      feet.footHeading[leg] = feet.liftHeading[leg] + shortestTurn(feet.liftHeading[leg], motion.heading) * eased;
    }
    feet.isSettling = stillSettling;
    // Flight: from the step the last foot leaves until the next one lands the body is a projectile, up and
    // down on the parabola gravity gives it over that time.
    if (plantedCount > 0 || !clock.isMoving) feet.flightSpan = 0;
    else if (feet.flightSpan === 0) {
      feet.flightSpan = Math.max(soonestLanding, dt);
      feet.flightSeconds = 0;
    } else feet.flightSeconds = Math.min(feet.flightSpan, feet.flightSeconds + dt);
    feet.air = feet.flightSpan > 0 ? FLIGHT_BOOST * (GRAVITY / 2) * feet.flightSeconds * (feet.flightSpan - feet.flightSeconds) : 0;
  };

  const rowYaw = new Float32Array(MOST_ROWS);
  const rowTilt = new Float32Array(MOST_ROWS);
  const rowLift = new Float32Array(MOST_ROWS);
  /** How far through its swing arc a leg is at a phase: 0 on the ground, 1 at mid swing. */
  const swingLift = (legPhase, duty) => (legPhase < duty ? 0 : Math.sin((Math.PI * (legPhase - duty)) / (1 - duty)));

  /**
   * Turns the trunk with the legs: each girdle (the spine bone a row of hips hangs from) turns towards its
   * leg that is forward and drops on the side of its leg that is in the air; the bone the arms hang from
   * turns the other way; a trunk on two rows of legs rocks towards the row that is down; and the neck takes
   * most of it back so the head keeps facing where the body goes. All from the clock, so it is smooth.
   */
  const poseTorso = (motion, clock) => {
    const { rig } = clock;
    const size = Math.min(1, clock.halfStance / rig.legLength);
    if (size <= 0) return;
    const { rotation } = motion.pose;
    const { frames } = rig;
    let carrierRow = -1;
    for (let row = 0; row < rig.rowCount; row++) {
      const left = rig.rowLeft[row];
      const right = rig.rowRight[row];
      rowYaw[row] = 0;
      rowTilt[row] = 0;
      rowLift[row] = 0;
      if (rig.rowGirdle[row] === rig.carrier) carrierRow = row;
      if (left < 0 || right < 0) continue;
      const leftPhase = fraction(motion.phase + clock.offsets[left]);
      const rightPhase = fraction(motion.phase + clock.offsets[right]);
      const leftLift = swingLift(leftPhase, clock.duty);
      const rightLift = swingLift(rightPhase, clock.duty);
      // The right foot forward brings the right hip forward: a turn to the left.
      rowYaw[row] = (TORSO.twist * size * (footOffset(rightPhase, clock.duty) - footOffset(leftPhase, clock.duty))) / 2;
      rowTilt[row] = TORSO.list * size * (leftLift - rightLift);
      rowLift[row] = (leftLift + rightLift) / 2;
    }
    const hipsYaw = carrierRow >= 0 ? rowYaw[carrierRow] : 0;
    const hipsTilt = carrierRow >= 0 ? rowTilt[carrierRow] : 0;
    // Nose down when the hindmost row is in the air and the foremost is down, and the other way about.
    const rock = rig.rowCount > 1 ? TORSO.rock * size * (rowLift[0] - rowLift[rig.rowCount - 1]) : 0;
    Kit.motion.turnBody(rotation, frames, rig.carrier, rock, hipsYaw, hipsTilt);
    let headYaw = hipsYaw;
    let headTilt = hipsTilt;
    for (let row = 0; row < rig.rowCount; row++) {
      if (row === carrierRow || rig.rowGirdle[row] === rig.carrier) continue;
      Kit.motion.turnBody(rotation, frames, rig.rowGirdle[row], 0, rowYaw[row] - hipsYaw, rowTilt[row] - hipsTilt);
      headYaw += rig.steadyUnder[row] * (rowYaw[row] - hipsYaw);
      headTilt += rig.steadyUnder[row] * (rowTilt[row] - hipsTilt);
    }
    if (rig.armGirdle >= 0) {
      const counter = -(1 + TORSO.shoulders);
      Kit.motion.turnBody(rotation, frames, rig.armGirdle, 0, hipsYaw * counter, hipsTilt * counter);
      headYaw += rig.steadyUnder[rig.rowCount] * hipsYaw * counter;
      headTilt += rig.steadyUnder[rig.rowCount] * hipsTilt * counter;
    }
    if (rig.steadyBone >= 0) Kit.motion.turnBody(rotation, frames, rig.steadyBone, -rock * TORSO.steadyHead, -headYaw * TORSO.steadyHead, -headTilt * TORSO.steadyHead);
  };

  /** Shifts the carrier bone, and so the whole body, by a world offset given in the body frame, in the local pose. */
  const shiftCarrierPose = (motion, rig, left, up) => {
    const at = rig.carrier * VECTOR_STRIDE;
    motion.pose.translation[at] += left / rig.stretchX;
    motion.pose.translation[at + 1] += up / rig.stretchY;
  };

  /** The same shift applied to world transforms that are already current: a pure move of everything the carrier carries. */
  const shiftCarrierWorld = (motion, rig, left, up) => {
    const { translation } = motion.world;
    const moveX = left * Math.cos(motion.heading);
    const moveZ = -left * Math.sin(motion.heading);
    const subtreeEnd = motion.plan.subtreeEnd[rig.carrier];
    for (let bone = rig.carrier; bone < subtreeEnd; bone++) {
      const at = bone * VECTOR_STRIDE;
      translation[at] += moveX;
      translation[at + 1] += up;
      translation[at + 2] += moveZ;
    }
  };

  /** Where the ankle of a planted foot is asked to be: flat on its plant, or raised over its toe by a pitch. Written to `scratchPoint`. */
  const ankleOfPlant = (motion, rig, feet, leg, pitch) => {
    const toeAt = leg * VECTOR_STRIDE;
    const toeUp = rig.toe[toeAt + 1];
    const toeForward = rig.toe[toeAt + 2];
    // The toe stays where it is; pitching the foot about it carries the ankle up and forward.
    const raise = toeUp - (toeUp * Math.cos(pitch) - toeForward * Math.sin(pitch));
    const advance = toeForward - (toeUp * Math.sin(pitch) + toeForward * Math.cos(pitch));
    scratchPoint[0] = feet.footX[leg] + advance * Math.sin(feet.footHeading[leg]);
    scratchPoint[1] = motion.y + rig.sole[leg] + raise;
    scratchPoint[2] = feet.footZ[leg] + advance * Math.cos(feet.footHeading[leg]);
    return scratchPoint;
  };

  /** How far beyond its allowed stretch a leg would have to reach from its hip to `scratchPoint`. */
  const overReach = (motion, rig, leg) => {
    const hip = rig.upper[leg] * VECTOR_STRIDE;
    const { translation } = motion.world;
    return Math.hypot(scratchPoint[0] - translation[hip], scratchPoint[1] - translation[hip + 1], scratchPoint[2] - translation[hip + 2]) - STANCE.stretch * rig.length[leg];
  };

  /**
   * The smallest heel pitch that lets a planted leg reach, 0 when it reaches flat or pitching would not help;
   * leaves the ankle for that pitch in `scratchPoint`.
   */
  const heelPitch = (motion, rig, feet, leg) => {
    ankleOfPlant(motion, rig, feet, leg, 0);
    const flatOver = overReach(motion, rig, leg);
    const toeAt = leg * VECTOR_STRIDE;
    const hip = rig.upper[leg] * VECTOR_STRIDE;
    const { translation } = motion.world;
    // Only a foot the body has already passed over rolls onto its toe; one out in front stays flat and the body comes down to it.
    const hipAhead = (translation[hip] - scratchPoint[0]) * Math.sin(feet.footHeading[leg]) + (translation[hip + 2] - scratchPoint[2]) * Math.cos(feet.footHeading[leg]);
    if (flatOver <= 0 || hipAhead <= 0 || Math.hypot(rig.toe[toeAt + 1], rig.toe[toeAt + 2]) < TINY) return 0;
    ankleOfPlant(motion, rig, feet, leg, STANCE.mostHeelPitch);
    const mostOver = overReach(motion, rig, leg);
    if (mostOver >= flatOver) {
      ankleOfPlant(motion, rig, feet, leg, 0);
      return 0;
    }
    if (mostOver > 0) return STANCE.mostHeelPitch;
    /** @type {number} */
    let reaching = STANCE.mostHeelPitch;
    let short = 0;
    for (let pass = 0; pass < STANCE.heelSearchSteps; pass++) {
      const middle = (reaching + short) / 2;
      ankleOfPlant(motion, rig, feet, leg, middle);
      if (overReach(motion, rig, leg) > 0) short = middle;
      else reaching = middle;
    }
    ankleOfPlant(motion, rig, feet, leg, reaching);
    return reaching;
  };

  /** Puts this frame's ankle target for a leg in `scratchPoint` (and its pitch in `feet.pitch`). */
  const ankleTarget = (motion, rig, feet, leg) => {
    if (feet.planted[leg]) {
      feet.pitch[leg] = heelPitch(motion, rig, feet, leg);
      return scratchPoint;
    }
    scratchPoint[0] = feet.targetX[leg];
    scratchPoint[1] = feet.targetY[leg];
    scratchPoint[2] = feet.targetZ[leg];
    return scratchPoint;
  };

  /** How far the body must come down for a leg to reach `scratchPoint` at its allowed stretch (0 when it already does). */
  const dropFor = (motion, rig, leg) => {
    if (overReach(motion, rig, leg) <= 0) return 0;
    const hip = rig.upper[leg] * VECTOR_STRIDE;
    const { translation } = motion.world;
    const reach = STANCE.stretch * rig.length[leg];
    const across = Math.min(Math.hypot(scratchPoint[0] - translation[hip], scratchPoint[2] - translation[hip + 2]), reach * STANCE.stretch);
    return Math.max(0, translation[hip + 1] - (scratchPoint[1] + Math.sqrt(reach * reach - across * across)));
  };

  const scratchQuaternion = new Float32Array(QUATERNION_STRIDE);

  /**
   * Holds a leg's foot level, facing a heading and pitched about its own left axis, whatever the shin is doing.
   * @param {Object} motion a `MotionState` whose world transforms are current for the leg
   * @param {LegRig} rig
   * @param {number} leg index in the rig's gait order
   * @param {number} heading the way the foot points, radians about +Y
   * @param {number} pitch radians; positive puts the toes down (a heel rising), negative lifts them (a heel strike)
   * @returns {void}
   * @complexity O(bones hanging from the foot), no allocation
   * @example Kit.gait.levelFoot(motion, rig, leg, motion.heading, 0);
   */
  const levelFoot = (motion, rig, leg, heading, pitch) => {
    const { plan, pose, world } = motion;
    const halfYaw = heading / 2;
    const halfPitch = pitch / 2;
    // yaw about +Y, then pitch about the foot's own left axis (+X): toes down as the heel comes up.
    const turnX = Math.cos(halfYaw) * Math.sin(halfPitch);
    const turnY = Math.sin(halfYaw) * Math.cos(halfPitch);
    const turnZ = -Math.sin(halfYaw) * Math.sin(halfPitch);
    const turnW = Math.cos(halfYaw) * Math.cos(halfPitch);
    const restAt = leg * QUATERNION_STRIDE;
    const restX = rig.footRotation[restAt];
    const restY = rig.footRotation[restAt + 1];
    const restZ = rig.footRotation[restAt + 2];
    const restW = rig.footRotation[restAt + QUATERNION_W];
    const foot = rig.end[leg];
    Kit.rig.faceWorld(
      plan.parent,
      pose,
      world,
      foot,
      turnW * restX + turnX * restW + turnY * restZ - turnZ * restY,
      turnW * restY - turnX * restZ + turnY * restW + turnZ * restX,
      turnW * restZ + turnX * restY - turnY * restX + turnZ * restW,
      turnW * restW - turnX * restX - turnY * restY - turnZ * restZ
    );
    if (plan.subtreeEnd[foot] > foot + 1) Kit.body.worldTransforms(plan, pose, world, motion.x, motion.y, motion.z, motion.heading, foot + 1, plan.subtreeEnd[foot]);
  };

  /**
   * Solves one leg so its ankle is at a world point: exactly for a leg of three bones (the knee hinted to the
   * side its limits bend to, turned by the body's heading), as a chain for a longer one. The foot's own
   * rotation is left to `levelFoot`. Usable by any stage that puts a foot somewhere (a kick, a crouch).
   * @param {Object} motion a `MotionState` whose world transforms are current down to the hip
   * @param {LegRig} rig from `Kit.gait.legs`
   * @param {number} leg index in the rig's gait order
   * @param {number} targetX where the ankle should be, world metres
   * @param {number} targetY
   * @param {number} targetZ
   * @returns {void}
   * @complexity O(leg bones), no allocation
   * @example Kit.gait.reachLeg(motion, rig, 0, footX, groundY + rig.sole[0], footZ);
   */
  const reachLeg = (motion, rig, leg, targetX, targetY, targetZ) => {
    const { plan, world } = motion;
    const chain = rig.longChains[leg];
    if (chain) {
      Kit.reach.chain(plan.parent, motion.pose, world, chain, targetX, targetY, targetZ);
      return;
    }
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    const hip = rig.upper[leg] * VECTOR_STRIDE;
    const bendX = rig.bendX[leg] * cosine + rig.bendZ[leg] * sine;
    const bendZ = -rig.bendX[leg] * sine + rig.bendZ[leg] * cosine;
    const reach = rig.length[leg];
    Kit.reach.twoBone(
      plan.parent,
      motion.pose,
      world,
      rig.upper[leg],
      rig.middle[leg],
      rig.end[leg],
      targetX,
      targetY,
      targetZ,
      (world.translation[hip] + targetX) / 2 + bendX * reach,
      (world.translation[hip + 1] + targetY) / 2,
      (world.translation[hip + 2] + targetZ) / 2 + bendZ * reach
    );
  };

  /** This frame's pose at full detail: the body set where its legs can carry it, then every leg solved to its foot. */
  const poseFeet = (motion, plan, dt) => {
    const clock = clockOf(motion);
    const { rig, feet } = clock;
    if (!feet) return;
    // The body's nominal place: a little below a straight-legged stand, on a spring the landings kick, and
    // drawn sideways towards the middle of the feet that are down.
    let plantedCount = 0;
    let supportLeft = 0;
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    for (let leg = 0; leg < rig.count; leg++) {
      if (!feet.planted[leg]) continue;
      plantedCount += 1;
      supportLeft += (feet.footX[leg] - motion.x) * cosine - (feet.footZ[leg] - motion.z) * sine;
    }
    feet.shift.target = plantedCount ? (supportLeft / plantedCount) * STANCE.shiftShare : 0;
    const left = Kit.dynamics.stepSpring(feet.shift, dt);
    const runShare = clamp((clock.froude - STANCE.runCrouchFrom) / (STANCE.runCrouchFull - STANCE.runCrouchFrom), 0, 1);
    const walkShare = clamp(clock.froude / STANCE.walkCrouchFull, 0, 1);
    const up = rig.standLift - (STANCE.standCrouch + (STANCE.crouch - STANCE.standCrouch) * walkShare + STANCE.runCrouch * runShare) * rig.legLength + Kit.dynamics.stepSpring(feet.bob, dt) + feet.air;
    poseTorso(motion, clock);
    shiftCarrierPose(motion, rig, left, up);
    motion.isWorldCurrent = false;
    const world = refreshWorld(motion);
    // No leg may be asked to reach further than it can: the body comes down by the most any leg needs.
    // Coming back up is rate-limited, so the far side of each dip is rounded instead of a corner.
    let drop = Math.max(0, feet.drop - STANCE.riseRate * rig.legLength * dt);
    for (let leg = 0; leg < rig.count; leg++) {
      ankleTarget(motion, rig, feet, leg);
      drop = Math.max(drop, dropFor(motion, rig, leg));
    }
    feet.drop = drop;
    if (drop > 0) {
      shiftCarrierPose(motion, rig, 0, -drop);
      shiftCarrierWorld(motion, rig, 0, -drop);
    }
    for (let leg = 0; leg < rig.count; leg++) {
      const target = ankleTarget(motion, rig, feet, leg);
      const targetX = target[0];
      const targetY = target[1];
      const targetZ = target[2];
      feet.targetX[leg] = targetX;
      feet.targetY[leg] = targetY;
      feet.targetZ[leg] = targetZ;
      reachLeg(motion, rig, leg, targetX, targetY, targetZ);
      levelFoot(motion, rig, leg, feet.footHeading[leg], feet.pitch[leg] + feet.strike[leg]);
    }
  };

  /**
   * The stage that walks at full detail. On the fixed clock: the gait clock, and for each leg the lift, the
   * swing towards where the hip will be half a stance after touchdown, and the plant. Each frame: the body is
   * set a little below a straight-legged stand (riding a spring that every landing kicks, shifted towards the
   * feet that are down), lowered as far as the most stretched leg needs, and every leg is solved to its foot
   * by `Kit.reach.twoBone` (`Kit.reach.chain` for a leg of more than three bones). A planted foot does not
   * move: at the end of a stance the foot pitches about its toe, so the ankle rises and the toe stays put.
   * @returns {Object} a `Stage` of kit/motion.js; needs two or more legs of three or more bones
   * @complexity per fixed step O(legs); per frame O(bones) for one forward pass plus O(legs) solves; no
   *   allocation after an instance's first frame
   * @example const legsOnly = Kit.motion.sequence(Kit.motion.lean(), Kit.gait.plant());
   */
  const plant = () => Kit.motion.stage({ name: 'gait.plant', step: stepFeet, pose: poseFeet, needs: WALK_STAGE_NEEDS });

  // ---- level of detail 1: the clock drives joint angles -------------------------------------------------------------

  const stepSwing = (motion, _plan, dt) => stepClock(motion, clockOf(motion), false, dt);

  const poseSwing = (motion) => {
    const clock = clockOf(motion);
    const { rig } = clock;
    const { rotation } = motion.pose;
    const reachShare = Math.min(SWING_ONLY.mostReach, clock.halfStance / rig.legLength);
    for (let leg = 0; leg < rig.count; leg++) {
      const legPhase = fraction(motion.phase + clock.offsets[leg]);
      const lift = legPhase < clock.duty ? 0 : Math.sin((Math.PI * (legPhase - clock.duty)) / (1 - clock.duty));
      const knee = SWING_ONLY.stanceKnee + SWING_ONLY.swingKnee * lift * Math.min(1, reachShare / SWING_ONLY.fullSwingAt);
      // A leg reaching forward is a negative turn of the hip about X; half the knee's fold is taken back at the hip so the foot stays under it.
      Kit.rig.turn(rotation, rotation, rig.upper[leg], AXES.x, -Math.asin(footOffset(legPhase, clock.duty) * reachShare) - (rig.flexSign[leg] * knee) / 2);
      Kit.rig.turn(rotation, rotation, rig.middle[leg], AXES.x, rig.flexSign[leg] * knee);
    }
    // The body rides lower the longer the stride, by a share of what a leg at full reach would need.
    shiftCarrierPose(motion, rig, 0, rig.standLift - rig.legLength * (STANCE.crouch + SWING_ONLY.dipShare * (1 - Math.sqrt(1 - reachShare * reachShare))));
    motion.isWorldCurrent = false;
  };

  /**
   * The stage that walks at level of detail 1: the same clock as `plant`, but each hip and knee is simply
   * turned through the stride. No feet are planted and nothing is solved, so feet slide a little and the cost
   * is a few turns and one forward pass. For bodies too far away for that to show.
   * @returns {Object} a `Stage`; needs what `plant` needs
   * @complexity per fixed step O(1); per frame O(legs); no allocation after an instance's first frame
   * @example const cheapWalk = Kit.motion.sequence(Kit.gait.swing(), Kit.gait.arms());
   */
  const swing = () => Kit.motion.stage({ name: 'gait.swing', step: stepSwing, pose: poseSwing, needs: WALK_STAGE_NEEDS });

  // ---- arms ---------------------------------------------------------------------------------------------------------------

  const poseArms = (motion) => {
    const clock = motion.memory.gait;
    if (!clock) return;
    const { rig } = clock;
    const { rotation } = motion.pose;
    // An arm swings as far as the leg it balances strides: twice as far at a run as at a walk.
    const reach = clock.isMoving ? Math.min(ARMS.mostSwing, (ARMS.swingPerStride * clock.stride) / rig.legLength) : 0;
    const carry = ARMS.elbowRest + (ARMS.elbowRun - ARMS.elbowRest) * clock.runShare;
    for (let arm = 0; arm < rig.armCount; arm++) {
      // +1 while the leg this arm swings with is out in front: the arm is forward with it.
      const forward = footOffset(fraction(motion.phase + clock.offsets[rig.armLeg[arm]] + rig.armShift[arm]), clock.duty);
      Kit.rig.turn(rotation, rotation, rig.armUpper[arm], AXES.x, -reach * forward);
      if (rig.armElbow[arm] >= 0)
        Kit.rig.turn(rotation, rotation, rig.armElbow[arm], AXES.x, rig.elbowSign[arm] * (carry + ARMS.elbowSwing * Math.max(0, forward) * Math.min(1, reach / ARMS.swingPerStride)));
    }
    motion.isWorldCurrent = false;
  };

  /**
   * The stage that swings arms against the legs: each arm goes forward with the nearest leg on the other side,
   * by an angle that grows with the stride, and its elbow folds more the faster the body goes. It reads the
   * clock that `plant` or `swing` runs, so put it in a sequence with one of them; a body without arms is left alone.
   * @returns {Object} a `Stage`; needs nothing
   * @complexity O(arms) per frame, no allocation
   * @example const walk = Kit.motion.sequence(Kit.gait.arms(), Kit.gait.plant());
   */
  const arms = () => Kit.motion.stage({ name: 'gait.arms', pose: poseArms });

  /** Turns `lean`'s forward tilt per metre per second into one per unit of Froude number, for an upright body only. */
  const leanPerSpeed = (motion, plan) => {
    const rig = legs(plan, motion.rest);
    return (rig.upright * Math.abs(motion.forwardSpeed)) / (GRAVITY * rig.legLength);
  };

  /**
   * Walking, ready made: lean, arms, planted feet, and tails, wings and everything loose trailing at full
   * detail; clock-driven swing at level of detail 1; nothing beyond. The same stage walks any plan with two or
   * more legs. Other stages join it at the two places where order matters: `before` the legs are solved
   * (whatever moves the body over its feet: breathing, a weight shift) and `after` (whatever poses the upper
   * body over the walk: a performance, a gaze), both ahead of the trailing chains.
   * @param {{before?: Array<Object|Function>, after?: Array<Object|Function>}} [options] stages of kit/motion.js
   * @returns {Object} a `Stage`
   * @complexity see `plant` (detail 0) and `swing` (detail 1)
   * @example
   * const motion = Kit.motion.state(bake, Kit.gait.walk());
   * Kit.motion.advance(motion, dt, x, 0, z, heading);
   */
  const walk = ({ before = [], after = [] } = {}) =>
    Kit.motion.byDetail([
      Kit.motion.sequence(
        Kit.motion.lean({ pitchPerSpeed: TORSO.lean, pitchWeight: leanPerSpeed }),
        ...before,
        arms(),
        plant(),
        ...after,
        Kit.motion.trail(),
        Kit.motion.trail({ roles: ['wing'], gravity: [0, -GRAVITY / 4, 0] }),
        Kit.motion.loose()
      ),
      Kit.motion.sequence(swing(), arms()),
    ]);

  // ---- reading the result ---------------------------------------------------------------------------------------------

  /**
   * An instance's feet: which are planted and where. Null until the `plant` stage has run for it.
   * @param {Object} motion a `MotionState`
   * @returns {?FeetState}
   * @complexity O(1)
   * @example const feet = Kit.gait.feet(motion); if (feet && feet.planted[0]) markFootprint(feet.footX[0], feet.footZ[0]);
   */
  const feet = (motion) => (motion.memory.gait ? motion.memory.gait.feet : null);

  /**
   * @typedef {Object} Support
   * @property {number} planted how many feet are down
   * @property {number} centerX the body's centre of mass, world metres
   * @property {number} centerY
   * @property {number} centerZ
   * @property {number} forwardOutside how far the centre of mass lies ahead of the foremost planted foot or
   *   behind the hindmost, along the heading, metres; 0 when it is between them
   * @property {number} sideOutside the same across the heading
   */

  /**
   * Measures balance: the centre of mass of the posed body against the span of its planted feet, along and
   * across the heading. A walker's centre of mass leaves the span while it vaults over one foot; how far is
   * the honest measure of how dynamic the gait is.
   * @param {Object} motion a `MotionState` that has been advanced
   * @param {Support} out receives the measurement
   * @returns {Support} `out`
   * @complexity O(bones + legs) time, no allocation
   * @example const balance = Kit.gait.support(motion, { planted: 0, centerX: 0, centerY: 0, centerZ: 0, forwardOutside: 0, sideOutside: 0 });
   */
  const support = (motion, out) => {
    const state = feet(motion);
    const rig = legs(motion.plan, motion.rest);
    Kit.body.centerOfMass(motion.plan, motion.world, motion.masses, scratchPoint);
    out.centerX = scratchPoint[0];
    out.centerY = scratchPoint[1];
    out.centerZ = scratchPoint[2];
    const sine = Math.sin(motion.heading);
    const cosine = Math.cos(motion.heading);
    let foremost = -Infinity;
    let hindmost = Infinity;
    let leftmost = -Infinity;
    let rightmost = Infinity;
    out.planted = 0;
    for (let leg = 0; state && leg < rig.count; leg++) {
      if (!state.planted[leg]) continue;
      out.planted += 1;
      const offsetX = state.footX[leg] - out.centerX;
      const offsetZ = state.footZ[leg] - out.centerZ;
      const forward = offsetX * sine + offsetZ * cosine;
      const left = offsetX * cosine - offsetZ * sine;
      foremost = Math.max(foremost, forward);
      hindmost = Math.min(hindmost, forward);
      leftmost = Math.max(leftmost, left);
      rightmost = Math.min(rightmost, left);
    }
    // The centre of mass is at 0 in these offsets: outside when every foot is on one side of it.
    out.forwardOutside = out.planted ? Math.max(0, hindmost, -foremost) : 0;
    out.sideOutside = out.planted ? Math.max(0, rightmost, -leftmost) : 0;
    return out;
  };

  Kit.gait = {
    STRIDE,
    GAITS,
    GAIT_NAMES,
    CLOCK,
    SWING,
    STANCE,
    SWING_ONLY,
    SWING_PATH,
    ARMS,
    RUN,
    TORSO,
    FLIGHT_BOOST,
    WALK_NEEDS,
    froude,
    strideLength,
    footOffset,
    legs,
    reachLeg,
    levelFoot,
    plant,
    swing,
    arms,
    walk,
    feet,
    support,
  };
})();
