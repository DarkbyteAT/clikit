/**
 * Spot Kick Showdown performances: the one place the game asks a character to act. The game calls an actor's
 * `stand`, `ready`, `runUp`, `kick`, `dive`, `celebrate` and `slump`; this file turns each into a performance
 * of the kit (`Kit.act`: kick, keeperReady, dive, catch, celebrate, slump, with walking, breathing, blinking and
 * a gaze under them from `Kit.act.character`).
 *
 * Owns:  `SPOT_KICK_PERFORM.actor(figure)`: the adapter between the game and a figure, and the timing that
 *        makes a performance meet the rules: a kick is played at the rate that puts the boot on the ball when
 *        the game strikes it, a dive at the rate that puts the hands on the rules' point when the rules' keeper
 *        arrives there.
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
   * performance. `leastDive`: the quickest a dive is played, however little time the rules leave (a body
   * thrown faster than this no longer reads as a dive).
   */
  const TIMING = Object.freeze({ strikeAt: 0.4, settle: 0.12, leastDive: 0.16 });
  /** A point closer to the standing keeper than this (world metres across) is gathered standing, not dived for. */
  const STANDING_REACH = 0.55;
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
    /** What the actor is doing, as the game named it; `run`: the run-up under way; `queued`: a reaction waiting for a dive to finish. */
    const state = { mode: 'stand', seconds: 0, run: null, pendingDive: null, queued: null };
    const rootOffset = [0, 0];
    const footing = (figure.footing = { x: 0, z: 0 });
    const inFigure = (value) => value / scale;
    const playAt = (id, point, options) => Kit.act.play(motion, id, { target: [inFigure(point.x), inFigure(point.y), inFigure(point.z)], ...options });
    /** A one-shot's rate so that its moment of contact comes `seconds` from now. */
    const rateFor = (id, seconds) => (Kit.act.REPERTOIRE[id].seconds * Kit.act.CONTACT[id]) / Math.max(seconds, TIMING.leastDive);

    /** Takes up whatever a finished kick or dive moved the body by, so the next thing starts where it ended. */
    const collectTravel = () => {
      if (!Kit.act.takeRootMotion(motion, rootOffset)) return;
      place.x += rootOffset[0] * scale;
      place.z += rootOffset[1] * scale;
      Kit.motion.place(motion, inFigure(place.x), 0, inFigure(place.z), place.heading);
    };

    const startDive = ({ target, seconds }) => {
      const id = Math.abs(target.x - place.x) < STANDING_REACH ? 'catch' : 'dive';
      playAt(id, { x: target.x, y: target.y, z: place.z }, { rate: rateFor(id, seconds), fade: Math.min(TIMING.settle, seconds / 2) });
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
        Object.assign(state, { mode: 'stand', seconds: 0, run: null, pendingDive: null, queued: null });
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
        playAt('kick', ball, { rate: rateFor('kick', TIMING.strikeAt), fade: TIMING.settle });
      },
      /**
       * Dives so that the hands are on a point of the keeper's plane at a moment the rules chose.
       * @param {{target: {x: number, y: number}, delay?: number, seconds: number}} dive `target`: world x and
       *   height; `delay`: seconds before the keeper moves at all (a keeper still reading the ball);
       *   `seconds`: from the first movement to the hands arriving
       */
      dive({ target, delay = 0, seconds }) {
        Object.assign(state, { mode: 'dive', seconds: 0, pendingDive: { target, delay, seconds }, queued: null });
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
        const oneShot = Kit.act.playing(motion);
        const isDiving = state.pendingDive || oneShot === 'dive' || oneShot === 'catch';
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
      },
      /** Which performance is on (for the flow and the debug state). */
      mode: () => state.mode,
    };
  };

  window.SPOT_KICK_PERFORM = { TIMING, actor };
})();
