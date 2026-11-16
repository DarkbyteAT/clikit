/**
 * Kit act life: what a body does when it is doing nothing, as small `Kit.motion` stages to sequence with
 * anything - a walk, a swim, a performance. A figure that only moves when told to looks switched off; these
 * keep it breathing, shifting its weight, blinking and looking about, each from a little physics or a seeded
 * schedule, so two instances with different seeds never move in step and the same seed always moves the same.
 *
 * Owns:  the stages `breathe` (the chest swells and the spine gives, faster when the body works), `sway` (a
 *        standing body's weight drifts over its feet), `blink` (drives the blink frames of a face on a seeded
 *        schedule), `gaze` (the head follows a point, or wanders, on a spring), their controls `lookAt` /
 *        `lookAhead`, and `character` (the ready composition a game or the Character Maker uses: walk or swim,
 *        life, a performer with fidgets, and trailing chains).
 * Does not own: performances and the performer (kit/act.js), walking (kit/gait.js), swimming (kit/swim.js),
 *        the springs (kit/dynamics.js), or drawing a face frame (`figure.face`).
 *
 * Where each goes in a sequence: `breathe` and `sway` move the body over its feet, so they go BEFORE the stage
 * that solves the legs (`Kit.gait.walk({ before })`); `gaze` and `blink` go after whatever poses the head.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-act.js.
 */
(() => {
  const { VECTOR_STRIDE } = Kit.rig;
  const { memory, refreshWorld, GRAVITY } = Kit.motion;
  const TAU = Math.PI * 2;
  const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));
  const lerp = (from, to, amount) => from + (to - from) * amount;
  const fieldOf = (name) => Kit.seeded.hashText(`act:${name}`);

  /** Tunables of `breathe`. */
  const BREATHE_DEFAULTS = Object.freeze({
    period: 3.6, // seconds a breath at rest, for a body with legs a metre long
    periodPerRootLength: 0.5, // share of the period that scales with the square root of the body's size (big bodies breathe slowly)
    workRate: 1.6, // breaths get this much faster per unit of Froude number (a runner pants)
    mostRate: 2.6,
    swell: 0.035, // the chest's depth grows by this share at the top of a breath
    widen: 0.018, // its width
    rise: 0.012, // its height (the shoulders and head ride up on it)
    arch: 0.022, // radians the spine straightens as the chest fills
    skew: 0.35, // breathing in is quicker than breathing out
  });
  /** Tunables of `sway`. */
  const SWAY_DEFAULTS = Object.freeze({
    shift: 0.03, // leg lengths the hips drift to each side
    periods: Object.freeze([7.3, 4.1]), // seconds: two slow waves that never line up the same way twice
    tilt: 0.035, // radians the hips drop on the unweighted side
    counter: 1.4, // of the hips' tilt the spine takes back, so the head stays over the feet
    turn: 0.03, // radians the hips turn with the drift
    stillSpeed: 0.25, // leg lengths per second: faster than this the body is walking and does not sway
  });
  /** Tunables of `blink`. Seconds. */
  const BLINK_DEFAULTS = Object.freeze({
    gap: Object.freeze([1.6, 5.2]), // between blinks, drawn per blink from the instance's seed
    closing: 0.05, // half-closed on the way down
    closed: 0.07,
    opening: 0.07, // half-closed on the way up
    doubleChance: 0.18, // of a second blink straight after
  });
  /** Tunables of `gaze`. */
  const GAZE_DEFAULTS = Object.freeze({
    stiffness: 70, // 1/s^2: the head arrives in about a third of a second
    damping: 0.75, // damping ratio: under 1, so it overshoots a little and settles
    wanderGap: Object.freeze([2.2, 6]), // seconds between idle looks
    wanderYaw: 0.38, // radians each way
    wanderPitch: 0.1,
    intoTurn: 0.3, // seconds of the body's turn the head looks ahead by
    mostYaw: 1.1,
  });

  // ---- breathing ------------------------------------------------------------------------------------------------------

  /**
   * A stage that breathes: the top of the spine swells and rises, the spine below it straightens a little as
   * it fills, in a cycle whose length follows the body's size and whose rate rises with how hard it is moving.
   * A body without a spine above its hips is left alone.
   * @param {Object} [options] see `Kit.act.BREATHE_DEFAULTS`
   * @returns {Object} a `Stage` of kit/motion.js; needs nothing
   * @complexity O(spine bones) per frame; allocates a small record on an instance's first frame
   * @example const alive = Kit.gait.walk({ before: [Kit.act.breathe(), Kit.act.sway()] });
   */
  const breathe = (options = {}) => {
    const tune = { ...BREATHE_DEFAULTS, ...options };
    const PHASE_FIELD = fieldOf('breathPhase');
    const create = (motion) => ({ phase: Kit.seeded.unit(Kit.act.seedOf(motion), PHASE_FIELD), rig: Kit.act.rig(motion.plan, motion.rest) });
    return Kit.motion.stage({
      name: 'act.breathe',
      step(motion, _plan, dt) {
        const record = memory(motion, 'breathe', create);
        const { unit } = record.rig;
        const period = tune.period * lerp(1, Math.sqrt(unit), tune.periodPerRootLength);
        const work = (motion.speed * motion.speed) / (GRAVITY * unit);
        record.phase = (record.phase + (dt / period) * Math.min(tune.mostRate, 1 + tune.workRate * work)) % 1;
      },
      pose(motion) {
        const record = memory(motion, 'breathe', create);
        const { spine } = record.rig;
        if (!spine.length) return;
        const angle = record.phase * TAU;
        // 0 breathed out, 1 full; the skew makes the way in shorter than the way out.
        const fill = 0.5 - 0.5 * Math.cos(angle + tune.skew * Math.sin(angle));
        const chest = spine[spine.length - 1] * VECTOR_STRIDE;
        const { scale, rotation } = motion.pose;
        scale[chest] *= 1 + tune.widen * fill;
        scale[chest + 1] *= 1 + tune.rise * fill;
        scale[chest + 2] *= 1 + tune.swell * fill;
        for (let index = 0; index < spine.length; index++) Kit.act.turnBody(rotation, record.rig, spine[index], (-tune.arch * (fill - 0.5)) / spine.length, 0, 0);
        motion.isWorldCurrent = false;
      },
    });
  };

  // ---- weight shift ---------------------------------------------------------------------------------------------------

  /**
   * A stage that lets a standing body's weight drift: the hips wander slowly from side to side on two waves
   * with seeded phases, drop a little on the unweighted side, and the spine leans back the other way so the
   * head stays over the feet. It fades out as the body starts to walk. Put it before the stage that solves the
   * legs, which then keeps the feet where they are.
   * @param {Object} [options] see `Kit.act.SWAY_DEFAULTS`
   * @returns {Object} a `Stage`; needs nothing (a body without legs is left alone)
   * @complexity O(spine bones) per frame; allocates a small record on an instance's first frame
   * @example const alive = Kit.gait.walk({ before: [Kit.act.sway()] });
   */
  const sway = (options = {}) => {
    const tune = { ...SWAY_DEFAULTS, ...options };
    const PHASE_FIELD = fieldOf('swayPhase');
    const create = (motion) => {
      const seed = Kit.act.seedOf(motion);
      return { rig: Kit.act.rig(motion.plan, motion.rest), phases: tune.periods.map((_period, index) => Kit.seeded.unit(seed, PHASE_FIELD, index) * TAU) };
    };
    return Kit.motion.stage({
      name: 'act.sway',
      pose(motion) {
        const record = memory(motion, 'sway', create);
        const { rig } = record;
        if (!rig.legs) return;
        const still = 1 - clamp(motion.speed / (tune.stillSpeed * rig.unit), 0, 1);
        if (still <= 0) return;
        let drift = 0;
        for (let index = 0; index < tune.periods.length; index++) drift += Math.sin((motion.time / tune.periods[index]) * TAU + record.phases[index]) / tune.periods.length;
        drift *= still;
        const carrier = rig.carrier * VECTOR_STRIDE;
        motion.pose.translation[carrier] += (drift * tune.shift * rig.unit) / rig.stretch[0];
        const { rotation } = motion.pose;
        // Weight on the left leg: the hips go left and the right side drops, a lean to the right; the spine leans back left.
        Kit.act.turnBody(rotation, rig, rig.carrier, 0, drift * tune.turn, -drift * tune.tilt);
        for (let index = 0; index < rig.spine.length; index++) Kit.act.turnBody(rotation, rig, rig.spine[index], 0, (-drift * tune.turn) / rig.spine.length, (drift * tune.tilt * tune.counter) / rig.spine.length);
        motion.isWorldCurrent = false;
      },
    });
  };

  // ---- blinking -------------------------------------------------------------------------------------------------------

  const FRAME = Object.freeze({ open: 0, half: 1, closed: 2 });

  /**
   * A stage that blinks: on a schedule drawn from the instance's seed it runs the face's blink frames (half,
   * closed, half, open), now and then twice in a row. It writes `Kit.act.face(motion).blink`; a renderer shows
   * it with `figure.face(Kit.act.face(motion))`. A performance may hold the eyes shut over it.
   * @param {Object} [options] see `Kit.act.BLINK_DEFAULTS`
   * @returns {Object} a `Stage`; needs nothing (a face without blink frames simply does not change)
   * @complexity O(1) per step; allocates a small record on an instance's first frame
   * @example const controller = Kit.motion.sequence(Kit.gait.walk(), Kit.act.blink());
   */
  const blink = (options = {}) => {
    const tune = { ...BLINK_DEFAULTS, ...options };
    const GAP_FIELD = fieldOf('blinkGap');
    const DOUBLE_FIELD = fieldOf('blinkDouble');
    const length = tune.closing + tune.closed + tune.opening;
    const gapOf = (seed, count) => (Kit.seeded.unit(seed, DOUBLE_FIELD, count) < tune.doubleChance ? tune.opening : lerp(tune.gap[0], tune.gap[1], Kit.seeded.unit(seed, GAP_FIELD, count)));
    const create = (motion) => ({ count: 0, wait: gapOf(Kit.act.seedOf(motion), 0), since: length });
    return Kit.motion.stage({
      name: 'act.blink',
      step(motion, _plan, dt) {
        const record = memory(motion, 'blink', create);
        record.since += dt;
        record.wait -= dt;
        if (record.wait > 0) return;
        record.count += 1;
        record.since = 0;
        record.wait = length + gapOf(Kit.act.seedOf(motion), record.count);
      },
      pose(motion) {
        const { since } = memory(motion, 'blink', create);
        Kit.act.face(motion).blink = since >= length ? FRAME.open : since < tune.closing || since >= tune.closing + tune.closed ? FRAME.half : FRAME.closed;
      },
    });
  };

  // ---- gaze -----------------------------------------------------------------------------------------------------------

  const createGaze = (tune) => (motion) => {
    const damping = tune.damping * Kit.dynamics.criticalDamping(tune.stiffness);
    return {
      rig: Kit.act.rig(motion.plan, motion.rest),
      yaw: Kit.dynamics.spring({ stiffness: tune.stiffness, damping }),
      pitch: Kit.dynamics.spring({ stiffness: tune.stiffness, damping }),
      hasPoint: false,
      point: new Float32Array(VECTOR_STRIDE),
      angles: new Float32Array(2),
      looks: 0,
      wait: 0,
      wanderYaw: 0,
      wanderPitch: 0,
    };
  };
  const GAZE_KEY = 'gaze';
  const createDefaultGaze = createGaze(GAZE_DEFAULTS);
  const gazeOf = (motion) => memory(motion, GAZE_KEY, createDefaultGaze);

  /**
   * A stage that turns the head to look: at the point given by `Kit.act.lookAt`, else into the body's turn
   * while it moves, else at a new idle direction every few seconds (seeded). The head rides two springs, so it
   * lags, overshoots a touch and settles. It adds to whatever posed the head before it.
   * @param {Object} [options] see `Kit.act.GAZE_DEFAULTS`
   * @returns {Object} a `Stage`; needs nothing (a body without a head is left alone)
   * @complexity O(1) per frame plus two springs' fixed steps; allocates the springs on an instance's first frame
   * @example const controller = Kit.motion.sequence(Kit.gait.walk(), Kit.act.gaze());
   */
  const gaze = (options = {}) => {
    const tune = { ...GAZE_DEFAULTS, ...options };
    const WAIT_FIELD = fieldOf('gazeWait');
    const YAW_FIELD = fieldOf('gazeYaw');
    const PITCH_FIELD = fieldOf('gazePitch');
    const create = createGaze(tune);
    return Kit.motion.stage({
      name: 'act.gaze',
      step(motion, _plan, dt) {
        const record = memory(motion, GAZE_KEY, create);
        record.wait -= dt;
        if (record.wait > 0) return;
        const seed = Kit.act.seedOf(motion);
        record.looks += 1;
        record.wait = lerp(tune.wanderGap[0], tune.wanderGap[1], Kit.seeded.unit(seed, WAIT_FIELD, record.looks));
        // Every other look comes back to straight ahead, as attention does.
        const isAway = record.looks % 2 === 1;
        record.wanderYaw = isAway ? (Kit.seeded.unit(seed, YAW_FIELD, record.looks) * 2 - 1) * tune.wanderYaw : 0;
        record.wanderPitch = isAway ? (Kit.seeded.unit(seed, PITCH_FIELD, record.looks) * 2 - 1) * tune.wanderPitch : 0;
      },
      pose(motion, _plan, dt) {
        const record = memory(motion, GAZE_KEY, create);
        if (record.rig.head < 0) return;
        if (record.hasPoint) {
          refreshWorld(motion);
          Kit.act.lookAngles(motion, record.point[0], record.point[1], record.point[2], record.angles);
          record.pitch.target = record.angles[0];
          record.yaw.target = record.angles[1];
        } else {
          record.pitch.target = record.wanderPitch;
          record.yaw.target = clamp(record.wanderYaw + motion.turnRate * tune.intoTurn, -tune.mostYaw, tune.mostYaw);
        }
        Kit.act.turnHead(motion.pose.rotation, record.rig, Kit.dynamics.stepSpring(record.pitch, dt), Kit.dynamics.stepSpring(record.yaw, dt), 0);
        motion.isWorldCurrent = false;
      },
    });
  };

  /**
   * Gives an instance a point to look at; its `gaze` stage turns the head there, as far as a neck goes.
   * @param {Object} motion a `MotionState` whose controller has a `Kit.act.gaze` (as `Kit.act.character` does)
   * @param {number} x world metres
   * @param {number} y
   * @param {number} z
   * @returns {void}
   * @complexity O(1)
   * @example Kit.act.lookAt(keeper, ball.x, ball.y, ball.z);   // every frame while the ball matters
   */
  const lookAt = (motion, x, y, z) => {
    const record = gazeOf(motion);
    record.hasPoint = true;
    record.point[0] = x;
    record.point[1] = y;
    record.point[2] = z;
  };

  /**
   * Takes the point back: the head returns to looking where the body goes, and to its idle looks.
   * @param {Object} motion a `MotionState`
   * @returns {void}
   * @complexity O(1)
   * @example Kit.act.lookAhead(keeper);
   */
  const lookAhead = (motion) => {
    gazeOf(motion).hasPoint = false;
  };

  // ---- the ready composition ------------------------------------------------------------------------------------------

  /**
   * A whole character, ready made: a body with legs walks and runs (kit/gait.js) with breathing and a weight
   * shift under it and, over it, a performer (`Kit.act.play`), a gaze and blinks, then tails, wings, hair and
   * cloaks trailing; a body without legs swims (kit/swim.js) and blinks. Standing still, it fidgets now and
   * then. This is the controller the Character Maker uses and the one a game should start from.
   * @param {{base?: string, fidgets?: string[], fidgetGap?: number[]}} [options] passed to `Kit.act.performer`
   *   (default fidgets: `Kit.act.FIDGETS`; pass [] for none)
   * @returns {Object} a `Stage`; it needs nothing (each body does what it can)
   * @throws {Error} for an unknown performance id
   * @complexity see `Kit.gait.walk` and `Kit.act.performer`
   * @example
   * const motion = Kit.act.cast(Kit.motion.state(bake, Kit.act.character()), recipe.seed);
   * Kit.motion.advance(motion, dt, x, 0, z, heading);
   * Kit.act.play(motion, 'wave');
   */
  const character = (options = {}) => {
    const walker = Kit.gait.walk({ before: [breathe(), sway()], after: [Kit.act.performer({ fidgets: Kit.act.FIDGETS, ...options }), gaze(), blink()] });
    const swimmer = Kit.motion.sequence(Kit.swim.swim(), blink());
    return Kit.motion.when((motion, plan) => Kit.act.rig(plan, motion.rest).legs !== null, walker, swimmer);
  };

  Object.assign(Kit.act, { BREATHE_DEFAULTS, SWAY_DEFAULTS, BLINK_DEFAULTS, GAZE_DEFAULTS, breathe, sway, blink, gaze, lookAt, lookAhead, character });
})();
