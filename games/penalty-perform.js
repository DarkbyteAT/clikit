/**
 * Spot Kick Showdown performances: the one place the game asks a character to act. The game calls an actor's
 * `stand`, `ready`, `runUp`, `kick`, `dive`, `celebrate` and `slump`; this file turns each into a performance
 * of the kit (`Kit.act`: kick, keeperReady, the save family, celebrate, slump, with walking, breathing, blinking and
 * a gaze under them from `Kit.act.character`).
 *
 * Owns:  `SPOT_KICK_PERFORM.actor(figure)`: the adapter between the game and a figure. It says when a
 *        performance must meet the rules (the boot on the ball when the game strikes it, the hands on the rules'
 *        point when the rules' keeper arrives there) and the kit fits the lead-in to that moment
 *        (`Kit.act.play` with `reach: { mark: 'contact', in }`). A save is the kit's `save` family: the body
 *        catches, jumps, drops or dives by where the point is against its own reach.
 * Does not own: the performances themselves (kit/act*.js), where the keeper's hands are (games/penalty-sim.js:
 *        the body follows the rules, never the other way round), figures (kit/figure.js) or gaits (kit/gait.js).
 *
 * Units: the game speaks world metres; a figure is a kit character scaled up, and its motion runs in the
 * character's own metres, so every point is divided by the figure's scale on the way in.
 *
 * Needs THREE figures at call time, nothing at load time.
 * Exposed as the global SPOT_KICK_PERFORM.
 */
(() => {
  const { lerp, clamp } = Kit.math;

  /**
   * Timings, seconds. `strikeAt`: from `kick()` to the boot meeting the ball. `settle`: the cross-fade into a
   * performance. `leastSave`: the quickest a save's lead-in is played, however little time the rules leave (a
   * body thrown faster than this no longer reads as a dive).
   */
  const TIMING = Object.freeze({ strikeAt: 0.4, settle: 0.12, leastSave: 0.16 });
  /** Numbers per bone position in a pose's `translation`. */
  const STRIDE = Kit.rig.VECTOR_STRIDE;
  /** The family of performances a keeper stops a ball with (kit/act-sport.js), and the moment of each the rules time. */
  const SAVE = Object.freeze({ family: 'save', mark: 'contact' });
  /** Where a taker looks to show a side: this far across and ahead of them, at this height, world metres. */
  const TELL_LOOK = Object.freeze({ across: 2.4, ahead: 8, height: 0.8, from: 0.45 });

  /**
   * Makes the actor of a figure.
   * @param {Object} figure from `SPOT_KICK_STAGE.addFigure` (a kit `Figure`, its root scaled)
   * @returns {Object} the actor: `stand`, `ready`, `runUp`, `kick`, `dive`, `celebrate`, `slump`, `update`,
   *   `mode`, and `STRIKE_SECONDS` (how long after `kick()` the boot meets the ball)
   * @complexity update: one `Kit.motion.advance` and one `figure.pose()`
   * @example
   * const taker = SPOT_KICK_PERFORM.actor(stage.addFigure(recipe));
   * taker.runUp({ from, to, seconds: 1.1 });   // then taker.kick({ x: 0, y: 0.11, z: 0 }) when it arrives
   */
  const actor = (figure) => {
    const scale = figure.root.scale.x;
    const motion = Kit.act.cast(Kit.motion.state(figure.bake, Kit.act.character({ fidgets: [] })), figure.bake.seed || 1);
    const place = { x: 0, z: 0, heading: 0 };
    /** What the actor is doing, as the game named it; `run`: the run-up under way; `queued`: a reaction waiting for a save to finish; `form`: the save being played. */
    const state = { mode: 'stand', seconds: 0, run: null, pendingDive: null, queued: null, form: null };
    const rootOffset = [0, 0];
    const footing = (figure.footing = { x: 0, z: 0 });
    const inFigure = (value) => value / scale;
    const playAt = (id, point, options) => Kit.act.play(motion, id, { target: [inFigure(point.x), inFigure(point.y), inFigure(point.z)], ...options });
    /** The play options that put a performance's moment of contact `seconds` from now; what follows the contact runs as authored. */
    const contactIn = (seconds) => ({ reach: { mark: SAVE.mark, in: Math.max(seconds, TIMING.leastSave) } });
    const hands = ['handLeft', 'handRight'].map((name) => figure.bake.plan.boneIndex(name));
    const headBone = figure.bake.plan.boneIndex('head');
    const handPoint = { x: 0, y: 0, z: 0 };
    /** Where a bone (a hand, the head) is in the world now, metres (written into `handPoint`). */
    const handAt = (bone) => {
      const { translation } = figure.world;
      const [sine, cosine] = [Math.sin(place.heading), Math.cos(place.heading)];
      const [x, y, z] = [translation[bone * STRIDE] * scale, translation[bone * STRIDE + 1] * scale, translation[bone * STRIDE + 2] * scale];
      return Object.assign(handPoint, { x: place.x + x * cosine + z * sine, y, z: place.z - x * sine + z * cosine });
    };
    /** How far the nearer hand is from the point the rules sent the hands to, world metres across the keeper's plane; smallest seen in this save. */
    const reach = { target: null, shortfall: Infinity };
    const measureReach = () => {
      hands.forEach((bone) => {
        const hand = handAt(bone);
        reach.shortfall = Math.min(reach.shortfall, Math.hypot(hand.x - reach.target.x, hand.y - reach.target.y));
      });
    };

    /** Takes up whatever a finished kick or dive moved the body by, so the next thing starts where it ended. */
    const collectTravel = () => {
      if (!Kit.act.takeRootMotion(motion, rootOffset)) return;
      place.x += rootOffset[0] * scale;
      place.z += rootOffset[1] * scale;
      Kit.motion.place(motion, inFigure(place.x), 0, inFigure(place.z), place.heading);
    };

    const startDive = ({ target, seconds }) => {
      Object.assign(reach, { target, shortfall: Infinity });
      playAt(SAVE.family, { x: target.x, y: target.y, z: place.z }, { ...contactIn(seconds), fade: Math.min(TIMING.settle, seconds / 2) });
      state.form = Kit.act.playing(motion);
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
        Object.assign(place, { x, z, heading });
        Object.assign(state, { mode: 'stand', seconds: 0, run: null, pendingDive: null, queued: null, form: null });
        reach.target = null;
        Kit.act.base(motion, null);
        Kit.act.stop(motion, 0);
        Kit.act.takeRootMotion(motion, rootOffset);
        Kit.act.lookAhead(motion);
        Kit.motion.place(motion, inFigure(x), 0, inFigure(z), heading);
      },
      /** The keeper's stance: knees bent, arms out, on the toes. */
      ready() {
        state.mode = 'ready';
        Kit.act.base(motion, 'keeperReady');
      },
      /**
       * Jogs from one spot to another, showing a tell on the way.
       * @param {{from: {x: number, z: number}, to: {x: number, z: number}, seconds: number, tell?: number}} run
       *   `tell`: -1, 0 or 1, the side (world x) the taker looks towards in the last strides
       */
      runUp({ from, to, seconds, tell = 0 }) {
        place.heading = Math.atan2(to.x - from.x, to.z - from.z);
        Object.assign(state, { mode: 'runUp', seconds: 0, run: { from, to, seconds, tell } });
      },
      /**
       * Swings a leg through the ball; the boot arrives `STRIKE_SECONDS` later.
       * @param {{x: number, y: number, z: number}} ball the ball's centre, world metres
       */
      kick(ball) {
        Object.assign(state, { mode: 'kick', seconds: 0, run: null });
        Kit.act.lookAhead(motion);
        playAt('kick', ball, { ...contactIn(TIMING.strikeAt), fade: TIMING.settle });
      },
      /**
       * Saves so that the hands are on a point of the keeper's plane at a moment the rules chose: caught standing,
       * jumped for, dropped onto or dived at, as the point lies against this body's reach.
       * @param {{target: {x: number, y: number}, delay?: number, seconds: number}} dive `target`: world x and
       *   height; `delay`: seconds before the keeper moves at all (a keeper still reading the ball);
       *   `seconds`: from the first movement to the hands arriving
       */
      dive({ target, delay = 0, seconds }) {
        Object.assign(state, { mode: 'dive', seconds: 0, pendingDive: { target, delay, seconds }, queued: null });
      },
      /**
       * Moves the moment (and the point) of a save already asked for: the ball has been struck, and where it
       * will be when is now known. A save still waiting to begin is simply asked for again.
       * @param {{target: {x: number, y: number}, delay?: number, seconds: number}} dive as `dive` takes it
       */
      retime(dive) {
        if (state.pendingDive || state.form === null || Kit.act.playing(motion) !== state.form) return this.dive(dive);
        reach.target = dive.target;
        Kit.act.aim(motion, 'target', inFigure(dive.target.x), inFigure(dive.target.y), inFigure(place.z));
        return Kit.act.meet(motion, SAVE.mark, Math.max(dive.seconds, TIMING.leastSave));
      },
      /** Arms up: now, or as soon as a dive has finished. */
      celebrate() {
        state.queued = 'celebrate';
      },
      /** Head down: now, or as soon as a dive has finished. */
      slump() {
        state.queued = 'slump';
      },
      /**
       * Advances the performance and poses the figure.
       * @param {number} dt seconds
       */
      update(dt) {
        state.seconds += dt;
        const { run, pendingDive } = state;
        if (run) {
          const share = clamp(state.seconds / run.seconds);
          // Ease in: the first steps are short, the last are quick.
          const eased = share * share * (2 - share);
          place.x = lerp(run.from.x, run.to.x, eased);
          place.z = lerp(run.from.z, run.to.z, eased);
          // The tell: in the last strides the head turns towards a side of the goal.
          if (run.tell && share > TELL_LOOK.from) Kit.act.lookAt(motion, inFigure(place.x + run.tell * TELL_LOOK.across), inFigure(TELL_LOOK.height), inFigure(place.z + Math.cos(place.heading) * TELL_LOOK.ahead));
        }
        if (pendingDive && state.seconds >= pendingDive.delay) {
          startDive(pendingDive);
          state.pendingDive = null;
        }
        const isDiving = Boolean(state.pendingDive) || (state.form !== null && Kit.act.playing(motion) === state.form);
        if (state.queued && !isDiving) {
          collectTravel();
          Kit.act.base(motion, null);
          Kit.act.play(motion, state.queued, { fade: TIMING.settle * 2 });
          state.mode = state.queued;
          state.queued = null;
        }
        Kit.motion.advance(motion, dt, inFigure(place.x), 0, inFigure(place.z), place.heading);
        Kit.rig.copy(motion.pose, figure.local);
        figure.root.position.set(place.x, 0, place.z);
        figure.root.rotation.set(0, place.heading, 0);
        // A kick's step and a dive's flight carry the body off its root: the shadow follows the body.
        Kit.act.rootMotion(motion, rootOffset);
        footing.x = place.x + rootOffset[0] * scale;
        footing.z = place.z + rootOffset[1] * scale;
        figure.face(Kit.act.face(motion));
        figure.pose();
        if (reach.target && isDiving) measureReach();
      },
      /**
       * How close the hands got to the point of the last save (for the contact sheet of a playtest).
       * @returns {{target: ?{x: number, y: number}, shortfall: number, form: ?string}} `shortfall`: world metres,
       *   across the keeper's plane; `form`: the performance of the save family that was played
       */
      handsOff: () => ({ target: reach.target, shortfall: reach.shortfall, form: state.form }),
      /**
       * How far the nearer hand is from a point now, across the keeper's plane (what the rules judge a save in).
       * @param {{x: number, y: number}} point world metres
       * @returns {number} metres
       */
      handsFrom: (point) => Math.min(...hands.map((bone) => Math.hypot(handAt(bone).x - point.x, handAt(bone).y - point.y))),
      /**
       * Where a ball held in the gloves is now: beyond the point half way between the hands, along the line the
       * arms reach on (from the head out through the hands), so the ball leads, then the gloves, then the head.
       * @param {number} lead how far beyond the hands the ball's centre sits, world metres (about its radius)
       * @returns {{x: number, y: number, z: number}} world metres (a new object)
       */
      holding(lead) {
        const first = { ...handAt(hands[0]) };
        const second = { ...handAt(hands[1]) };
        const head = handAt(headBone);
        const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, z: (first.z + second.z) / 2 };
        const [alongX, alongY, alongZ] = [middle.x - head.x, middle.y - head.y, middle.z - head.z];
        const length = Math.hypot(alongX, alongY, alongZ) || 1;
        return { x: middle.x + (alongX / length) * lead, y: middle.y + (alongY / length) * lead, z: middle.z + (alongZ / length) * lead };
      },
      /** Which performance is on (for the flow and the debug state). */
      mode: () => state.mode,
    };
  };

  window.SPOT_KICK_PERFORM = { TIMING, actor };
})();
