/**
 * Spot Kick Showdown performances: the one place the game asks a character to act. The game calls an actor's
 * `stand`, `ready`, `runUp`, `kick`, `dive`, `celebrate` and `slump`; this file decides how the body does it.
 *
 * Owns:  `SPOT_KICK_PERFORM.actor(figure)`: the adapter between the game and a figure, and the stand-in
 *        performances behind it: poses as rows of joint angles (`POSES`) blended over time, a run-up on
 *        `Kit.gait.walk` through `Kit.motion`, a leg swung through the ball, and a dive laid out along the line
 *        from the hips to the hands that the rules give.
 * Does not own: where the keeper's hands are at any moment (games/penalty-sim.js `keeperAt`: the body follows
 *        the rules, never the other way round), figures (kit/figure.js), gaits (kit/gait.js) or kinematics.
 *
 * This is a stand-in until the kit's performance layer (`Kit.act`: kick, ready stance, dive, catch, celebration,
 * slump, idle life) lands. Swapping it in means rewriting the bodies of the actor's methods in this file; the
 * game does not change. It is deliberately not a second animation system: a handful of pose rows and one blend.
 *
 * Needs THREE figures at call time, nothing at load time.
 * Exposed as the global SPOT_KICK_PERFORM.
 */
(() => {
  const { clamp, lerp, damp } = Kit.math;
  /** Axes of `Kit.rig.turn`: pitch swings a limb forward (negative) and back, roll swings it sideways. */
  const PITCH = 0, YAW = 1, ROLL = 2;

  /**
   * @typedef {Object} PoseRow Joint angles in radians from the rest pose; anything left out stays at rest.
   * @property {number} [lean] the spine pitched forward (shared between waist and chest)
   * @property {number} [twist] the chest turned to the body's left
   * @property {number[]} [thighs] [left, right] pitch: negative lifts the knee forward
   * @property {number[]} [shins] [left, right] knee bend, 0 or more
   * @property {number[]} [arms] [left, right] pitch: negative raises the arm forward and up
   * @property {number} [spread] both arms raised sideways by this much
   * @property {number[]} [elbows] [left, right] bend, 0 or less
   * @property {number} [head] the head pitched forward
   * @property {number} [sink] how far the body drops because the legs are bent, as a share of the leg length
   */

  /** The poses the stand-in blends between. */
  const POSES = Object.freeze({
    stand: {},
    ready: { lean: 0.32, thighs: [-0.55, -0.55], shins: [1.0, 1.0], arms: [-0.5, -0.5], spread: 0.75, elbows: [-0.5, -0.5], sink: 0.2 },
    plant: { lean: 0.1, twist: 0.35, thighs: [-0.35, 0.75], shins: [0.3, 1.3], arms: [0.5, -0.7], spread: 0.5, elbows: [-0.3, -0.3], sink: 0.06 },
    strike: { lean: -0.12, twist: -0.3, thighs: [0.15, -1.05], shins: [0.15, 0.1], arms: [-0.6, 0.6], spread: 0.6, elbows: [-0.4, -0.2], sink: 0.02 },
    follow: { lean: -0.05, twist: -0.45, thighs: [0.2, -1.4], shins: [0.2, 0.6], arms: [-0.3, 0.7], spread: 0.5, elbows: [-0.5, -0.3] },
    dive: { lean: -0.15, thighs: [0.2, -0.25], shins: [0.3, 0.5], arms: [-2.75, -2.75], spread: 0.12, elbows: [-0.08, -0.08], head: -0.25 },
    cheer: { lean: -0.12, thighs: [-0.1, -0.1], shins: [0.2, 0.2], arms: [-2.6, -2.6], spread: 0.45, elbows: [-0.25, -0.25], head: -0.3 },
    slump: { lean: 0.5, thighs: [-0.1, -0.1], shins: [0.15, 0.15], arms: [0.05, 0.05], spread: 0.05, head: 0.5, sink: 0.03 },
  });

  /** Timings of the stand-in, seconds. `strikeAt`: from the start of `kick` to the boot meeting the ball. */
  const TIMING = Object.freeze({ blendRate: 14, plant: 0.14, strikeAt: 0.22, follow: 0.5, breathRate: 1.6, breath: 0.025, readySway: 2.4, hopRate: 9, hop: 0.16, landRate: 5 });
  /** How far the shoulders and the head open towards the side a taker is showing, radians. */
  const TELL = Object.freeze({ twist: 0.45, head: 0.5 });

  /**
   * Makes the actor of a figure.
   * @param {Object} figure from `SPOT_KICK_STAGE.addFigure` (a kit `Figure`, its root scaled)
   * @returns {Object} the actor: `stand`, `ready`, `runUp`, `kick`, `dive`, `celebrate`, `slump`, `update`, and
   *   `STRIKE_SECONDS` (how long after `kick()` the boot meets the ball)
   * @complexity update: O(bones) (one pose row, one blend, one forward pass)
   * @example
   * const taker = SPOT_KICK_PERFORM.actor(stage.addFigure(recipe));
   * taker.runUp({ from, to, seconds: 1.5, heading: Math.PI });   // then taker.kick() when it arrives
   */
  const actor = (figure) => {
    const { plan, rest } = figure.bake;
    const scale = figure.root.scale.x;
    const bone = (name) => plan.boneIndex(name);
    const joints = {
      waist: bone('waist'), chest: bone('chest'), head: bone('head'),
      thighs: [bone('thighLeft'), bone('thighRight')], shins: [bone('shinLeft'), bone('shinRight')],
      arms: [bone('upperArmLeft'), bone('upperArmRight')], elbows: [bone('forearmLeft'), bone('forearmRight')],
    };
    const legLength = plan.length[joints.thighs[0]] + plan.length[joints.shins[0]];
    const wanted = Kit.body.createPose(plan);
    /** Height of the raised hands above the feet in the dive pose, world metres: the hands are put where the rules say. */
    const handsHeight = (() => {
      const posed = Kit.rig.copy(rest, Kit.body.createPose(plan));
      writeRow(posed, POSES.dive);
      const world = Kit.body.worldTransforms(plan, posed, Kit.body.createPose(plan));
      return world.translation[bone('handLeft') * 3 + 1] * scale;
    })();

    /** Writes a pose row over the rest pose into `pose`. */
    function writeRow(pose, row) {
      Kit.rig.copy(rest, pose);
      const turn = (joint, axis, radians) => radians && Kit.rig.turn(pose.rotation, pose.rotation, joint, axis, radians);
      turn(joints.waist, PITCH, (row.lean || 0) * 0.6);
      turn(joints.chest, PITCH, (row.lean || 0) * 0.4);
      turn(joints.chest, YAW, row.twist || 0);
      turn(joints.head, PITCH, row.head || 0);
      [0, 1].forEach((side) => {
        turn(joints.thighs[side], PITCH, row.thighs ? row.thighs[side] : 0);
        turn(joints.shins[side], PITCH, row.shins ? row.shins[side] : 0);
        turn(joints.arms[side], PITCH, row.arms ? row.arms[side] : 0);
        // Sideways is +roll for the left arm and -roll for the right.
        turn(joints.arms[side], ROLL, (row.spread || 0) * (side === 0 ? 1 : -1));
        turn(joints.elbows[side], PITCH, row.elbows ? row.elbows[side] : 0);
      });
    }

    const place = { x: 0, y: 0, z: 0, heading: 0, roll: 0 };
    const state = { mode: 'stand', row: POSES.stand, seconds: 0, sink: 0, extra: null, walk: null };
    const setMode = (mode, row, extra = null) => Object.assign(state, { mode, row, seconds: 0, extra });

    /** Blends the figure's pose towards the wanted row and writes the root's place. */
    const settle = (dt, rate = TIMING.blendRate) => {
      writeRow(wanted, state.row);
      Kit.rig.mix(figure.local, wanted, clamp(rate * dt), figure.local);
      state.sink = damp(state.sink, (state.row.sink || 0) * legLength * scale, rate, dt);
    };
    const writeRoot = (lift = 0) => {
      figure.root.position.set(place.x, place.y - state.sink + lift, place.z);
      figure.root.rotation.set(0, place.heading, place.roll);
    };

    /** What each mode does per frame. Every one ends by leaving `figure.local` and the root ready to draw. */
    const MODES = {
      stand(dt, time) {
        settle(dt);
        // Idle life: the chest rises and falls.
        Kit.rig.turn(figure.local.rotation, figure.local.rotation, joints.chest, PITCH, Math.sin(time * TIMING.breathRate) * TIMING.breath * dt * 8);
        writeRoot();
      },
      ready(dt, time) {
        settle(dt);
        writeRoot(Math.abs(Math.sin(time * TIMING.readySway)) * 0.03);
      },
      runUp(dt) {
        const { from, to, seconds, tell } = state.extra;
        const share = clamp(state.seconds / seconds);
        // Ease in: the first steps are short, the last are quick.
        const eased = share * share * (3 - 2 * share) * 0.5 + share * share * 0.5;
        place.x = lerp(from.x, to.x, eased);
        place.z = lerp(from.z, to.z, eased);
        // The gait reads the body's movement in its own scale: a scaled figure covers scaled ground.
        Kit.motion.advance(state.walk, dt, place.x / scale, 0, place.z / scale, place.heading);
        Kit.rig.copy(state.walk.pose, figure.local);
        // The tell: in the last strides the shoulders and the eyes open towards a side.
        const shown = clamp((share - 0.45) / 0.3) * tell;
        Kit.rig.turn(figure.local.rotation, figure.local.rotation, joints.chest, YAW, shown * TELL.twist);
        Kit.rig.turn(figure.local.rotation, figure.local.rotation, joints.head, YAW, shown * TELL.head);
        state.sink = 0;
        writeRoot();
      },
      kick(dt) {
        state.row = state.seconds < TIMING.plant ? POSES.plant : state.seconds < TIMING.follow ? (state.seconds < TIMING.strikeAt + 0.05 ? POSES.strike : POSES.follow) : POSES.stand;
        settle(dt, state.seconds < TIMING.follow ? 22 : 6);
        writeRoot();
      },
      dive(dt) {
        const { sample } = state.extra;
        const { hands, share } = sample();
        state.row = share > 0 ? POSES.dive : POSES.ready;
        settle(dt, 18);
        // The body lies along the line from the stance's feet to the hands, more fully as the dive goes on.
        const angle = Math.atan2(hands.x - place.homeX, Math.max(0.2, hands.y)) * clamp(share * 1.6);
        const reach = lerp(hands.y, handsHeight, clamp(share * 1.6));
        place.roll = -angle * Math.cos(place.heading);
        place.x = hands.x - Math.sin(angle) * reach;
        // Once the hands have arrived the body comes down to the turf.
        state.extra.drop = share >= 1 ? Math.min(1, (state.extra.drop || 0) + dt * TIMING.landRate) : 0;
        const feetY = Math.max(0, hands.y - Math.cos(angle) * reach);
        place.y = lerp(feetY, Math.min(feetY, Math.max(0, 0.25 - Math.abs(Math.cos(angle)) * 0.25)), state.extra.drop);
        state.sink = share > 0 ? 0 : state.sink;
        writeRoot();
      },
      celebrate(dt, time) {
        settle(dt);
        writeRoot(Math.abs(Math.sin(time * TIMING.hopRate)) * TIMING.hop);
      },
      slump(dt) {
        settle(dt, 5);
        writeRoot();
      },
    };

    return {
      figure,
      STRIKE_SECONDS: TIMING.strikeAt,
      /**
       * Stands the character somewhere, facing a way, at rest.
       * @param {number} x @param {number} z world metres
       * @param {number} heading radians; 0 faces +Z, PI faces the goal from the spot
       */
      stand(x, z, heading) {
        Object.assign(place, { x, y: 0, z, heading, roll: 0, homeX: x });
        setMode('stand', POSES.stand);
      },
      /** The keeper's stance: knees bent, arms out, on the toes. */
      ready() {
        place.roll = 0;
        place.y = 0;
        place.x = place.homeX;
        setMode('ready', POSES.ready);
      },
      /**
       * Jogs from one spot to another, showing a tell on the way.
       * @param {{from: {x: number, z: number}, to: {x: number, z: number}, seconds: number, tell?: number}} run
       *   `tell`: -1, 0 or 1, the side (world x) the shoulders open towards
       */
      runUp({ from, to, seconds, tell = 0 }) {
        place.heading = Math.atan2(to.x - from.x, to.z - from.z);
        state.walk = Kit.motion.state(figure.bake, Kit.gait.walk(), { x: from.x / scale, z: from.z / scale, heading: place.heading });
        // A positive chest yaw turns to the body's left, which is world -x for a body running towards -z.
        setMode('runUp', POSES.stand, { from, to, seconds, tell: tell * Math.sign(Math.cos(place.heading) || 1) });
      },
      /** Swings the right leg through the ball; the boot arrives `STRIKE_SECONDS` later. */
      kick() {
        setMode('kick', POSES.plant);
      },
      /**
       * Dives where the rules say the hands are.
       * @param {function(): {hands: {x: number, y: number}, share: number}} sample called every frame: the
       *   keeper's hands in the keeper's plane (world x, height) and how far through the dive, 0..1
       */
      dive(sample) {
        setMode('dive', POSES.ready, { sample, drop: 0 });
      },
      celebrate() {
        place.roll = 0;
        place.y = 0;
        setMode('celebrate', POSES.cheer);
      },
      slump() {
        if (state.mode === 'dive') return; // a beaten keeper stays down
        setMode('slump', POSES.slump);
      },
      /**
       * Advances the performance and poses the figure.
       * @param {number} dt seconds
       * @param {number} time seconds, for the idle rhythms
       */
      update(dt, time) {
        state.seconds += dt;
        MODES[state.mode](dt, time);
        figure.pose();
      },
      /** Which performance is on (for tests and the debug state). */
      mode: () => state.mode,
    };
  };

  window.SPOT_KICK_PERFORM = { POSES, TIMING, actor };
})();
