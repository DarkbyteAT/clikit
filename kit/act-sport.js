/**
 * Kit act sport: the moves a ball game needs, as data. Where a foot or a hand must meet a ball, the point is a
 * parameter given when the move is played, never a baked direction: the same kick swings through wherever the
 * ball is, with whichever foot is on that side; the same dive goes left or right, low or high.
 *
 * Owns:  the rows `kick` (a step up, the plant, a swing through the point, the follow-through), `keeperReady`
 *        (a goalkeeper's stance, a loop), `dive` (a dive to the side the point is on, hands to it, the landing
 *        and getting up there), `diveStep` (the same dive after a step, for a ball further off), `catch` (both
 *        hands to the point, the ball gathered in), `catchHigh` (a jump for a ball overhead), `smother` (down
 *        onto a ball at the feet), `parry` (one hand punched to it), `celebrate` and `slump`, defined into
 *        `Kit.act.REPERTOIRE`; and the family `save` (whichever of the five gets the hands to the ball).
 * Does not own: how a performance is run (kit/act.js), the ball, or when a game plays a move.
 *
 * Playing one (kit/act.js):
 *   Kit.act.play(motion, 'kick', { target: [ballX, ballY, ballZ] });   // contact at half way: Kit.act.progress(motion) >= 0.5
 *   Kit.act.play(motion, 'dive', { target: [x, y, z] });               // hands on the point at 0.4 of the way
 *   Kit.act.play(motion, 'save', { target: [x, y, z], reach: { mark: 'contact', in: seconds } });  // the form is chosen
 *   Kit.act.playing(motion);                                           // 'catch', 'catchHigh', 'smother', 'dive' or 'diveStep'
 *   Kit.act.takeRootMotion(motion, offset);                            // afterwards: the kick stepped, the dive flew
 * The moment of contact of each move is `Kit.act.CONTACT[id]`, 0..1 through it, and `Kit.act.marks(id).contact`
 * in seconds; `Kit.act.play(motion, 'dive', { target, reach: { mark: 'contact', in: seconds } })` meets it on time.
 *
 * Pure (no DOM, no THREE): data only; unit-tested by tools/test-act.js.
 */
(() => {
  const AHEAD = Math.PI / 2;
  const STANDING = { atLeast: { legs: 2 } };
  const ARMS_NEEDED = { atLeast: { arms: 2, legs: 2 } };

  /** A keeper's stance, shared by the loop and by the start of a dive. */
  const READY = { shift: [0, -0.17, 0.04], turn: [0.24, 0, 0], spine: [0.12, 0, 0], head: [-0.32, 0, 0], arms: [0.95, 0.95, 0.78, 0.5], feet: [0.2, 0, 0, 0] };

  /** The dive, authored to the left; `diveStep` is the same dive after a step, its times moved later by `STEP_LEAD`. */
  const DIVE_MARKS = { takeoff: 0.2, contact: 0.4, land: 0.54 };
  const DIVE_KEYS = [
    { at: 0, ...READY },
    // Loaded onto the legs, the body dipping away from the point first.
    { at: 0.1, ease: 'out', shift: [-0.06, -0.3, 0.02], turn: [0.2, 0.06, -0.1], spine: [0.1, 0, 0.1], head: [-0.25, 0.2, 0], arms: [0.6, 0.9, 0.7, 0.4], feet: [0.2, 0, 0, 0] },
    // The push: the legs drive straight while the body is still nearly upright, the arms starting up.
    {
      at: 0.2,
      ease: 'in',
      shift: [0.1, 0.06, 0],
      turn: [0.1, 0.1, 0.4],
      spine: [0, 0, 0.14],
      head: [-0.2, 0.2, 0.1],
      armLeft: [1.7, 0.5, 0.9, 0.2],
      armRight: [1.3, 1.2, 0.8, 0.3],
      feet: [0.2, 0, 0, 0.5],
    },
    // Thrown: laid out along the line to the point, arms long (the hands are on the point by a reach).
    // The upper leg is drawn up bent, the lower one trails.
    {
      at: 0.4,
      ease: 'out',
      turn: [0.08, 0.2, 1.1],
      spine: [0, 0, 0.24],
      head: [-0.1, 0.2, 0.2],
      armLeft: [2.95, 0.6, 1, 0],
      armRight: [2.5, 1.5, 1, 0.2],
      footLeft: [0.2, 0.12, 0, 0.6],
      footRight: [0.2, 0.42, 0.1, 0.6],
    },
    // Landed on the side, and the give of the landing.
    {
      at: 0.54,
      ease: 'in',
      shift: [0, -0.68, 0],
      turn: [0.05, 0.3, 1.45],
      spine: [0, 0, 0.1],
      head: [-0.1, 0.2, 0.3],
      armLeft: [2.9, 0.5, 0.95, 0],
      armRight: [2.2, 1.6, 0.85, 0.3],
      feet: [0.2, 0, 0, 0.6],
    },
    {
      at: 0.6,
      ease: 'out',
      shift: [0, -0.62, 0],
      turn: [0.05, 0.3, 1.38],
      spine: [0, 0, 0.14],
      head: [-0.05, 0.2, 0.2],
      armLeft: [2.8, 0.5, 0.9, 0],
      armRight: [2.1, 1.6, 0.8, 0.3],
      feet: [0.2, 0, 0, 0.6],
    },
    {
      at: 0.72,
      shift: [0, -0.68, 0],
      turn: [0.05, 0.3, 1.45],
      spine: [0, 0, 0.1],
      head: [-0.05, 0.2, 0.25],
      armLeft: [2.7, 0.5, 0.85, 0],
      armRight: [1.9, 1.6, 0.75, 0.3],
      feet: [0.2, 0, 0, 0.6],
    },
    // Up again where it landed: the feet come under the body, a crouch, then standing.
    { at: 0.88, shift: [0, -0.42, 0], turn: [0.35, 0.05, 0.25], spine: [0.2, 0, 0], arms: [0.7, 1.1, 0.8, 0.4], feet: [0.1, 0, 0, 0], carry: 1 },
    { at: 1, ease: 'settle', carry: 1 },
  ];
  const DIVE_REACHES = [
    { limb: 'hands', target: 'target', offset: [0.08, 0, 0], in: [0.2, 0.39], out: [0.46, 0.56] },
    { limb: 'head', target: 'target', in: [0, 0.12], out: [0.46, 0.6] },
  ];
  const DIVE_TRAVEL = { target: 'target', start: 0.16, arrive: 0.4, land: 0.54, keep: 0.95, most: 1.6, mostUp: 0.85, axes: [1, 1, 0.5] };
  /** The share of `diveStep` its step takes before the dive begins. */
  const STEP_LEAD = 0.16;
  const afterStep = (at) => STEP_LEAD + at * (1 - STEP_LEAD);
  const spanAfterStep = (span) => span.map(afterStep);

  /** @type {Object[]} `PerformanceSpec`s of kit/act.js */
  const MOVES = [
    {
      // Authored for the right foot; played mirrored when the ball is on the left.
      id: 'kick',
      marks: { plant: 0.32, contact: 0.5 },
      label: 'Kick',
      seconds: 1.5,
      needs: STANDING,
      side: 'right',
      sideBy: 'target',
      defaultsIn: 'legs',
      defaults: { target: [-0.25, 0.25, 1.4] },
      keys: [
        // The step up: the plant foot lifts and goes to the ball's side while the arms take the opposite swing.
        { at: 0.14, ease: 'out', shift: [0, -0.05, 0], turn: [0.06, 0.05, 0], footLeft: [0, 0.14, 0.15, 0.25], armRight: [0.55, 1.35, 0.9, 0.1], armLeft: [0.5, -1, 0.9, 0.1] },
        // Wound up: the kicking foot high behind, the hip opened, the chest turned against it, the far arm out for balance.
        {
          at: 0.37,
          ease: 'out',
          shift: [0, -0.07, 0],
          turn: [0.16, -0.32, 0.04],
          spine: [0.08, 0.36, 0],
          head: [0, -0.1, 0],
          footRight: [0.06, 0.4, -0.62, 0.95],
          armLeft: [1.45, 0.9, 0.92, 0.2],
          armRight: [0.75, -1.1, 0.9, 0.2],
        },
        // Contact: the foot is on the point (a reach), the hip has come through.
        {
          at: 0.5,
          ease: 'in',
          shift: [0, -0.04, 0],
          turn: [0.02, 0.2, -0.03],
          spine: [0.1, -0.12, 0],
          footRight: [0, 0.1, 0.4, -0.25],
          armLeft: [1.2, 0.3, 0.92, 0.2],
          armRight: [0.6, 0.2, 0.9, 0.2],
          carry: 1,
        },
        // Follow-through: the leg carries on up and across, the body rises onto the plant foot and leans back.
        {
          at: 0.64,
          ease: 'out',
          shift: [0, 0.03, 0],
          turn: [-0.14, 0.38, -0.05],
          spine: [-0.04, -0.3, 0],
          head: [-0.1, -0.1, 0],
          footRight: [-0.1, 0.52, 0.78, -0.55],
          armLeft: [1, -0.5, 0.9, 0.2],
          armRight: [1.3, 1.2, 0.85, 0.3],
          carry: 1,
        },
        {
          at: 0.84,
          ease: 'in',
          shift: [0, -0.06, 0],
          turn: [0.06, 0.08, 0],
          spine: [0.05, -0.05, 0],
          footRight: [0, 0.05, 0.12, 0],
          armLeft: [0.5, 0.2, 0.9, 0.2],
          armRight: [0.6, 0.6, 0.9, 0.2],
          carry: 1,
        },
        { at: 1, ease: 'settle', carry: 1 },
      ],
      reaches: [
        // The plant foot goes beside the ball and a little behind it, and stays there through the swing.
        { limb: 'footLeft', target: 'target', offset: [0.3, 0, -0.15], ground: true, in: [0.12, 0.32], out: [0.84, 0.98] },
        { limb: 'footRight', target: 'target', in: [0.39, 0.49], out: [0.52, 0.6] },
        { limb: 'head', target: 'target', in: [0.05, 0.3], out: [0.6, 0.8] },
      ],
      // The hips are carried to a short swing behind the ball: the step is as long as the ball is far, up to a stride.
      travel: { target: 'target', start: 0.1, arrive: 0.44, keep: 0.24, most: 1.6, stride: 1.1, axes: [0.7, 0, 1] },
    },
    {
      id: 'keeperReady',
      label: 'Keeper ready',
      seconds: 1.1,
      loop: true,
      needs: ARMS_NEEDED,
      keys: [
        { at: 0, ease: 'in', ...READY },
        { at: 0.5, ease: 'out', ...READY, shift: [0, -0.21, 0.04], arms: [0.9, 0.95, 0.74, 0.5] },
      ],
    },
    {
      // Authored to the left; played mirrored when the point is on the right.
      id: 'dive',
      marks: DIVE_MARKS,
      label: 'Dive',
      seconds: 2.7,
      needs: ARMS_NEEDED,
      side: 'left',
      sideBy: 'target',
      defaults: { target: [1.25, 0.9, 0.15] },
      keys: DIVE_KEYS,
      reaches: DIVE_REACHES,
      travel: DIVE_TRAVEL,
    },
    {
      // A ball too far for a dive from the stance: a step out onto the near leg first, then the same dive from it.
      id: 'diveStep',
      marks: Object.fromEntries(Object.entries(DIVE_MARKS).map(([name, at]) => [name, afterStep(at)])),
      label: 'Step and dive',
      seconds: 3.1,
      needs: ARMS_NEEDED,
      side: 'left',
      sideBy: 'target',
      defaults: { target: [2.4, 0.9, 0.15] },
      keys: [
        { at: 0, ...READY },
        { at: 0.07, ease: 'out', ...READY, shift: [0.3, -0.12, 0.04], footLeft: [0.6, 0.2, 0, 0.2] },
        { at: 0.14, ease: 'in', ...READY, shift: [0.8, -0.3, 0.02], turn: [0.2, 0.06, 0.12], footLeft: [1.15, 0, 0, 0] },
        ...DIVE_KEYS.filter((key) => key.at >= DIVE_MARKS.takeoff).map((key) => ({ ...key, at: afterStep(key.at) })),
      ],
      reaches: DIVE_REACHES.map((reach) => ({ ...reach, in: spanAfterStep(reach.in), out: spanAfterStep(reach.out) })),
      travel: { ...DIVE_TRAVEL, start: afterStep(DIVE_TRAVEL.start), arrive: afterStep(DIVE_TRAVEL.arrive), land: afterStep(DIVE_TRAVEL.land), most: 2.5 },
    },
    {
      // A ball overhead: a jump off both feet, both hands up to it, and the landing gives.
      id: 'catchHigh',
      marks: { takeoff: 0.26, contact: 0.44, land: 0.64 },
      label: 'High catch',
      seconds: 1.7,
      needs: ARMS_NEEDED,
      defaults: { target: [0.05, 1.45, 0.15] },
      keys: [
        { at: 0.14, ease: 'out', shift: [0, -0.3, 0.02], turn: [0.18, 0, 0], spine: [0.14, 0, 0], head: [-0.3, 0, 0], arms: [0.5, 0.2, 0.7, 0.3] },
        { at: 0.26, ease: 'in', shift: [0, 0.05, 0], turn: [-0.04, 0, 0], spine: [-0.06, 0, 0], head: [-0.35, 0, 0], arms: [1.9, 1.35, 0.8, 0.3], feet: [0, 0, 0, 0.5] },
        // At the top: stretched, the knees drawn up a little under it.
        { at: 0.44, ease: 'out', turn: [-0.1, 0, 0], spine: [-0.14, 0, 0], head: [-0.45, 0, 0], arms: [2.95, 1.2, 1, 0.1], footLeft: [0, 0.3, 0.05, 0.6], footRight: [0, 0.16, -0.05, 0.6] },
        { at: 0.64, ease: 'in', shift: [0, -0.24, 0], turn: [0.16, 0, 0], spine: [0.16, 0, 0], head: [0.1, 0, 0], arms: [1.2, AHEAD + 0.4, 0.45, 0.6], carry: 1 },
        { at: 0.8, ease: 'out', shift: [0, -0.1, 0], turn: [0.08, 0, 0], spine: [0.12, 0, 0], head: [0.1, 0, 0], arms: [1.1, AHEAD + 0.45, 0.42, 0.6], carry: 1 },
        { at: 1, ease: 'settle', carry: 1 },
      ],
      reaches: [
        { limb: 'hands', target: 'target', offset: [0.09, 0, 0], in: [0.24, 0.44], out: [0.5, 0.64] },
        { limb: 'head', target: 'target', in: [0, 0.2], out: [0.5, 0.66] },
      ],
      travel: { target: 'target', start: 0.24, arrive: 0.44, land: 0.64, keep: 0.8, most: 0.6, mostUp: 1, axes: [1, 1, 0.6] },
    },
    {
      // A ball on the ground in front: down onto it, hands behind it and the chest over it.
      id: 'smother',
      marks: { contact: 0.4 },
      label: 'Smother',
      seconds: 1.8,
      needs: ARMS_NEEDED,
      defaults: { target: [0.06, 0.1, 0.3] },
      keys: [
        { at: 0.14, ease: 'out', shift: [0, -0.2, 0], turn: [0.2, 0, 0], spine: [0.2, 0, 0], arms: [0.5, 1.2, 0.8, 0.4] },
        // Down: one knee dropped behind, the trunk folded over the ball.
        {
          at: 0.4,
          ease: 'in',
          shift: [0, -0.74, 0.1],
          turn: [0.7, 0, 0],
          spine: [0.7, 0, 0],
          head: [-0.4, 0, 0],
          arms: [0.5, AHEAD, 0.95, 0.5],
          footRight: [0.05, 0, -0.5, 0.9],
          footLeft: [0.1, 0, 0.15, 0],
        },
        {
          at: 0.56,
          ease: 'out',
          shift: [0, -0.76, 0.06],
          turn: [0.72, 0, 0],
          spine: [0.74, 0, 0],
          head: [-0.1, 0, 0],
          arms: [0.7, AHEAD + 0.3, 0.5, 0.7],
          footRight: [0.05, 0, -0.5, 0.9],
          footLeft: [0.1, 0, 0.15, 0],
        },
        { at: 0.72, shift: [0, -0.74, 0.06], turn: [0.66, 0, 0], spine: [0.7, 0, 0], arms: [0.75, AHEAD + 0.35, 0.45, 0.7], footRight: [0.05, 0, -0.5, 0.9], footLeft: [0.1, 0, 0.15, 0] },
        { at: 0.88, ease: 'in', shift: [0, -0.25, 0], turn: [0.2, 0, 0], spine: [0.2, 0, 0], arms: [1, AHEAD + 0.4, 0.45, 0.6], carry: 1 },
        { at: 1, ease: 'settle', carry: 1 },
      ],
      reaches: [
        { limb: 'hands', target: 'target', offset: [0.09, 0, 0], in: [0.16, 0.4], out: [0.46, 0.58] },
        { limb: 'head', target: 'target', in: [0, 0.2], out: [0.5, 0.7] },
      ],
      travel: { target: 'target', start: 0.12, arrive: 0.4, keep: 0.55, most: 0.5, axes: [1, 0, 1] },
    },
    {
      // Authored for a point a little to the left: the body leans under it by how far aside it is.
      id: 'catch',
      marks: { contact: 0.42 },
      label: 'Catch',
      seconds: 1.3,
      needs: ARMS_NEEDED,
      side: 'left',
      sideBy: 'target',
      leanBySide: true,
      defaults: { target: [0.08, 0.8, 0.22] },
      keys: [
        { at: 0.16, ease: 'out', shift: [0, -0.08, 0], spine: [0.06, 0, 0], arms: [0.8, 1.2, 0.5, 0.5] },
        { at: 0.42, ease: 'out', shift: [0.4, 0.02, 0.03], turn: [0, 0, 0.12], spine: [-0.04, 0, 0.1], arms: [1.6, 1.3, 0.92, 0.3] },
        // Gathered into the chest, the body giving with it.
        { at: 0.62, ease: 'settle', shift: [0, -0.1, -0.02], turn: [0.1, 0, 0], spine: [0.2, 0, 0], head: [0.2, 0, 0], arms: [1.15, AHEAD + 0.45, 0.42, 0.6] },
        { at: 0.82, shift: [0, -0.06, 0], turn: [0.06, 0, 0], spine: [0.14, 0, 0], head: [0.1, 0, 0], arms: [1.1, AHEAD + 0.45, 0.42, 0.6] },
      ],
      reaches: [
        { limb: 'hands', target: 'target', offset: [0.09, 0, 0], in: [0.18, 0.42], out: [0.46, 0.6] },
        { limb: 'head', target: 'target', in: [0, 0.2], out: [0.46, 0.62] },
      ],
    },
    {
      // Authored for the left hand; the hand on the point's side is the one that goes.
      id: 'parry',
      marks: { contact: 0.36 },
      label: 'Parry',
      seconds: 1,
      needs: ARMS_NEEDED,
      side: 'left',
      sideBy: 'target',
      leanBySide: true,
      defaults: { target: [0.3, 0.86, 0.12] },
      keys: [
        { at: 0.14, ease: 'out', shift: [-0.03, -0.12, 0], turn: [0, 0, -0.05], armLeft: [0.9, 1.1, 0.45, 0.6], armRight: [0.7, 0.8, 0.7, 0.4] },
        { at: 0.36, ease: 'snap', shift: [0.1, 0.05, 0], turn: [0, 0.1, 0.16], spine: [-0.04, 0.1, 0.2], armLeft: [2.5, 0.5, 1, 0.1], armRight: [0.8, -0.3, 0.9, 0.3], footRight: [0, 0.04, 0, 0.3] },
        { at: 0.56, shift: [0.07, -0.03, 0], turn: [0, 0.06, 0.1], spine: [0, 0.06, 0.12], armLeft: [2, 0.6, 0.85, 0.2], armRight: [0.7, 0.2, 0.9, 0.3] },
      ],
      reaches: [
        { limb: 'handLeft', target: 'target', in: [0.16, 0.36], out: [0.4, 0.56] },
        { limb: 'head', target: 'target', in: [0, 0.16], out: [0.4, 0.6] },
      ],
    },
    {
      id: 'celebrate',
      label: 'Celebrate',
      seconds: 2.6,
      needs: ARMS_NEEDED,
      side: 'right',
      keys: [
        // A leap with one fist punched up, the landing, then both arms thrown wide and the head back.
        { at: 0.1, ease: 'out', shift: [0, -0.26, 0], turn: [0.18, 0, 0], spine: [0.15, 0, 0], armRight: [0.7, 1.2, 0.45, 0.5], armLeft: [0.7, 1, 0.6, 0.5] },
        {
          at: 0.26,
          ease: 'out',
          shift: [0, 0.5, 0],
          turn: [-0.08, 0.2, 0],
          spine: [-0.12, 0.1, 0],
          head: [-0.25, 0, 0],
          armRight: [3, 0.7, 1, 0.1],
          armLeft: [1, 1.3, 0.5, 0.6],
          feet: [0, 0.6, -0.12, 0.6],
          face: { talk: 'open' },
        },
        { at: 0.4, ease: 'in', shift: [0, -0.2, 0], turn: [0.12, 0.05, 0], spine: [0.12, 0, 0], armRight: [2.2, 0.9, 0.6, 0.5], armLeft: [0.9, 1.2, 0.55, 0.6] },
        { at: 0.56, ease: 'settle', shift: [0, 0.03, 0], turn: [-0.06, 0, 0], spine: [-0.2, 0, 0], head: [-0.35, 0, 0], arms: [2.3, 0.15, 1, 0.3] },
        { at: 0.72, shift: [0, -0.04, 0], spine: [-0.14, 0, 0.05], head: [-0.3, 0, 0.05], arms: [2.45, 0.2, 0.96, 0.3] },
        { at: 0.86, ease: 'in', shift: [0, -0.03, 0], spine: [-0.04, 0, 0], arms: [1.2, 0.4, 0.8, 0.4], face: { talk: 'smile' } },
      ],
    },
    {
      id: 'slump',
      label: 'Slump',
      seconds: 1.8,
      hold: true,
      needs: { atLeast: { legs: 2 }, needs: ['spine', 'head'] },
      keys: [
        // The air goes out: a small rise first, then the chest, head and arms drop and the knees give.
        { at: 0.14, ease: 'out', shift: [0, 0.015, 0], spine: [-0.06, 0, 0], head: [-0.12, 0, 0] },
        { at: 0.5, ease: 'in', shift: [0, -0.1, -0.03], turn: [0.1, 0, 0], spine: [0.42, 0, 0], head: [0.5, 0, 0.05], arms: [0.3, AHEAD, 0.97, 0], face: { blink: 'half' } },
        { at: 0.68, ease: 'out', shift: [0, -0.075, -0.03], turn: [0.08, 0, 0], spine: [0.36, 0, 0], head: [0.44, 0, 0.05], arms: [0.22, AHEAD, 0.97, 0] },
        { at: 1, shift: [0, -0.09, -0.03], turn: [0.09, 0, 0.02], spine: [0.4, 0, 0.03], head: [0.5, 0.06, 0.06], arms: [0.26, AHEAD, 0.97, 0], face: { blink: 'closed' } },
      ],
    },
  ];
  MOVES.forEach(Kit.act.define);
  /**
   * Stopping a ball, whichever way gets the hands to it: caught standing when it comes at the body, jumped for
   * overhead, dropped onto at the feet, dived at to the side and stepped-and-dived at beyond that. Spans are in
   * the body's own arm spans aside and hand-reach heights up, so a short-armed body dives sooner than a long one.
   * `LOW`: under this share of its hand-reach height a ball in front is dropped onto, not caught standing.
   */
  const LOW = 0.3;
  Kit.act.defineFamily({
    id: 'save',
    label: 'Save',
    forms: [
      { play: 'smother', aside: [0, 1], up: [0, LOW] },
      { play: 'catch', aside: [0, 0.5], up: [LOW, 1] },
      { play: 'catchHigh', aside: [0, 1.5], up: [1, Infinity] },
      { play: 'dive', aside: [0, 4.4] },
      { play: 'diveStep' },
    ],
  });
  /**
   * When each move meets its point, 0..1 through it: the frame a game launches the ball or stops it. The same
   * moments, in seconds, are `Kit.act.marks(id).contact`; `Kit.act.play` can be asked to meet one at a given time.
   */
  Kit.act.CONTACT = Object.freeze(Object.fromEntries(MOVES.filter((move) => move.marks && 'contact' in move.marks).map((move) => [move.id, move.marks.contact])));
})();
