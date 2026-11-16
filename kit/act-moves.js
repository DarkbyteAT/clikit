/**
 * Kit act moves: the everyday repertoire, as data. Each row is a performance spec of kit/act.js: timed keys of
 * role channels, so the same row plays on every body that has the parts it uses.
 *
 * Owns:  the rows `wave`, `cheer`, `bow`, `think`, `shrug`, `jump`, `sit`, `dance`, and the small
 *        fidgets a standing body plays on its own (`glance`, `shiftWeight`, `stretch`, `wag`), defined into
 *        `Kit.act.REPERTOIRE`; `Kit.act.FIDGETS` (the ids of the fidgets).
 * Does not own: how a performance is run (kit/act.js), sport moves (kit/act-sport.js), or always-on life such
 *        as breathing and blinking (kit/act-life.js).
 *
 * Reading a row (see `Kit.act.CHANNELS`): `shift` is [left, up, forward] in leg lengths; turns are
 * [pitch, yaw, tilt] in radians (forward, to the left, to the left); an arm is [raise, front, extend, elbowOut]
 * (raise from hanging: pi / 2 level, pi overhead; front: 0 out to the side, pi / 2 ahead, more across the
 * body); a foot is [out, up, forward, pitch] in leg lengths. A one-shot starts and ends at the standing body
 * without saying so. Timing is the craft: a key's `ease` is how the body arrives at it, so 'anticipate' pulls
 * back first, 'settle' overshoots and returns, 'out' decelerates against gravity and 'in' falls with it.
 *
 * Pure (no DOM, no THREE): data only; unit-tested by tools/test-act.js.
 */
(() => {
  const AHEAD = Math.PI / 2;
  const ARMS_NEEDED = { atLeast: { arms: 2 } };

  /** @type {Object[]} `PerformanceSpec`s of kit/act.js */
  const MOVES = [
    {
      id: 'wave',
      label: 'Wave',
      seconds: 2.3,
      needs: { atLeast: { arms: 1 } },
      side: 'right',
      keys: [
        // The hand dips back before it comes up, and overshoots the top: anticipation and settle.
        { at: 0.09, ease: 'out', armRight: [0.12, -0.5, 0.95, 0], spine: [0, 0.04, 0] },
        { at: 0.27, ease: 'settle', armRight: [2.35, 0.1, 0.8, 0.7], spine: [0, -0.05, 0.05], head: [-0.05, -0.12, 0.08], face: { talk: 'smile' } },
        { at: 0.4, armRight: [2.75, 0.1, 0.76, 0.7], spine: [0, -0.05, 0.05], head: [-0.05, -0.12, 0.08] },
        { at: 0.53, armRight: [2.1, 0.1, 0.84, 0.7], spine: [0, -0.05, 0.05], head: [-0.05, -0.12, 0.08] },
        { at: 0.66, armRight: [2.75, 0.1, 0.76, 0.7], spine: [0, -0.05, 0.05], head: [-0.05, -0.12, 0.08] },
        { at: 0.79, armRight: [2.15, 0.1, 0.84, 0.7], spine: [0, -0.04, 0.04], head: [-0.03, -0.1, 0.05], face: { talk: 'rest' } },
      ],
    },
    {
      id: 'cheer',
      label: 'Cheer',
      seconds: 2,
      needs: ARMS_NEEDED,
      keys: [
        { at: 0.16, ease: 'out', shift: [0, -0.16, 0], turn: [0.1, 0, 0], spine: [0.12, 0, 0], arms: [0.5, -0.4, 0.6, 0.5], head: [0.1, 0, 0] },
        { at: 0.34, ease: 'settle', shift: [0, 0.1, 0], spine: [-0.08, 0, 0], arms: [2.85, 0.5, 1, 0.3], head: [-0.14, 0, 0], face: { talk: 'open' } },
        { at: 0.48, ease: 'in', shift: [0, -0.07, 0], spine: [-0.05, 0, 0], arms: [2.6, 0.4, 0.82, 0.6], head: [-0.15, 0, 0] },
        { at: 0.62, ease: 'settle', shift: [0, 0.08, 0], spine: [-0.08, 0, 0], arms: [2.9, 0.5, 1, 0.3], head: [-0.14, 0, 0] },
        { at: 0.78, ease: 'in', shift: [0, -0.05, 0], spine: [-0.04, 0, 0], arms: [2.5, 0.4, 0.85, 0.6], head: [-0.1, 0, 0], face: { talk: 'smile' } },
      ],
    },
    {
      id: 'bow',
      label: 'Bow',
      seconds: 2.6,
      needs: { needs: ['spine', 'head'] },
      keys: [
        { at: 0.12, ease: 'out', spine: [-0.07, 0, 0], head: [-0.05, 0, 0] },
        // The hips go back as the chest goes forward, or the body would topple; one hand across the middle, one behind.
        {
          at: 0.42,
          shift: [0, -0.03, -0.1],
          turn: [0.36, 0, 0],
          spine: [0.4, 0, 0],
          head: [0.12, 0, 0],
          armRight: [0.75, AHEAD + 0.75, 0.55, 0.3],
          armLeft: [0.45, -AHEAD - 0.55, 0.6, 0.2],
          face: { blink: 'closed' },
        },
        { at: 0.66, shift: [0, -0.035, -0.1], turn: [0.38, 0, 0], spine: [0.42, 0, 0], head: [0.14, 0, 0], armRight: [0.75, AHEAD + 0.75, 0.55, 0.3], armLeft: [0.45, -AHEAD - 0.55, 0.6, 0.2] },
        { at: 0.9, ease: 'settle', spine: [-0.03, 0, 0], face: { blink: 'open' } },
      ],
    },
    {
      id: 'think',
      label: 'Think',
      seconds: 3.4,
      needs: ARMS_NEEDED,
      side: 'right',
      keys: [
        // A hand to the chin, the other arm folded under it, the weight on one leg and the head tipped.
        {
          at: 0.2,
          shift: [-0.035, -0.01, 0],
          turn: [0, 0.05, -0.04],
          spine: [0.04, 0.06, 0.05],
          head: [0.1, 0.18, -0.1],
          armRight: [1.95, AHEAD + 0.55, 0.42, -0.1],
          armLeft: [0.95, AHEAD + 0.95, 0.5, 0.1],
        },
        {
          at: 0.5,
          shift: [-0.035, -0.01, 0],
          turn: [0, 0.05, -0.04],
          spine: [0.05, 0.06, 0.05],
          head: [0.02, 0.28, -0.14],
          armRight: [2, AHEAD + 0.55, 0.42, -0.1],
          armLeft: [0.95, AHEAD + 0.95, 0.5, 0.1],
        },
        {
          at: 0.8,
          shift: [-0.035, -0.01, 0],
          turn: [0, 0.05, -0.04],
          spine: [0.04, 0.06, 0.05],
          head: [0.12, 0.1, -0.08],
          armRight: [1.95, AHEAD + 0.55, 0.42, -0.1],
          armLeft: [0.95, AHEAD + 0.95, 0.5, 0.1],
        },
      ],
    },
    {
      id: 'shrug',
      label: 'Shrug',
      seconds: 1.7,
      needs: ARMS_NEEDED,
      keys: [
        { at: 0.1, ease: 'out', shift: [0, -0.02, 0], arms: [0.25, 0.9, 0.85, 0.2] },
        { at: 0.32, ease: 'settle', shift: [0, 0.02, 0], spine: [-0.06, 0, 0], head: [0.05, 0, 0.2], arms: [0.95, 0.55, 0.7, 0.5] },
        { at: 0.6, shift: [0, 0.015, 0], spine: [-0.05, 0, 0], head: [0.05, 0, 0.2], arms: [0.92, 0.55, 0.7, 0.5] },
      ],
    },
    {
      id: 'jump',
      label: 'Jump',
      seconds: 1.4,
      needs: { atLeast: { legs: 2 } },
      keys: [
        // Crouch (anticipation), drive up against gravity, hang, fall with it, absorb the landing, settle.
        { at: 0.24, ease: 'out', shift: [0, -0.3, 0], turn: [0.22, 0, 0], spine: [0.2, 0, 0], head: [-0.15, 0, 0], arms: [0.7, -0.9, 0.9, 0], wings: [0.75, -0.2, 0] },
        { at: 0.34, ease: 'in', shift: [0, 0.04, 0], turn: [0.02, 0, 0], spine: [-0.05, 0, 0], arms: [1.7, AHEAD, 0.9, 0.2], wings: [-0.55, 0.1, 0], feet: [0, 0, 0, 0.5] },
        {
          at: 0.52,
          ease: 'out',
          shift: [0, 0.62, 0],
          turn: [-0.05, 0, 0],
          spine: [-0.1, 0, 0],
          head: [-0.1, 0, 0],
          arms: [2.85, 0.7, 1, 0.2],
          feet: [0, 0.74, -0.05, 0.6],
          tail: [-0.4, 0, 0],
          wings: [0.7, 0, 0],
        },
        { at: 0.68, ease: 'in', shift: [0, 0, 0], turn: [0.05, 0, 0], arms: [1.5, 0.6, 0.9, 0.3], wings: [-0.4, 0, 0], feet: [0, 0, 0, 0.3] },
        { at: 0.78, ease: 'out', shift: [0, -0.24, 0], turn: [0.18, 0, 0], spine: [0.16, 0, 0], head: [-0.1, 0, 0], wings: [0.3, -0.1, 0], arms: [0.8, 0.9, 0.8, 0.3] },
        { at: 0.92, ease: 'settle', shift: [0, 0.01, 0] },
      ],
    },
    {
      id: 'sit',
      label: 'Sit',
      seconds: 1.9,
      hold: true,
      needs: { atLeast: { legs: 2 } },
      keys: [
        // Down onto the ground: the hips go back and down, the feet slide forward, the hands prop behind.
        { at: 0.3, ease: 'out', shift: [0, -0.3, -0.12], turn: [0.3, 0, 0], spine: [0.15, 0, 0], arms: [0.9, AHEAD, 0.85, 0.2] },
        { at: 0.72, ease: 'in', shift: [0, -0.86, -0.3], turn: [-0.16, 0, 0], spine: [0.16, 0, 0], head: [0.04, 0, 0], arms: [0.5, -AHEAD + 0.4, 0.92, 0.3], feet: [0.04, 0, 0.42, -0.25] },
        { at: 0.86, ease: 'out', shift: [0, -0.84, -0.3], turn: [-0.2, 0, 0], spine: [0.22, 0, 0], head: [0.02, 0, 0], arms: [0.5, -AHEAD + 0.4, 0.92, 0.3], feet: [0.04, 0, 0.42, -0.25] },
        { at: 1, shift: [0, -0.86, -0.3], turn: [-0.18, 0, 0], spine: [0.2, 0, 0], head: [0.02, 0, 0], arms: [0.5, -AHEAD + 0.4, 0.92, 0.3], feet: [0.04, 0, 0.42, -0.25] },
      ],
    },
    {
      id: 'dance',
      label: 'Dance',
      seconds: 2,
      loop: true,
      needs: { atLeast: { legs: 2 } },
      keys: [
        // Four beats: the hips drop on each, sway side to side, the free foot taps out, the arms pump in turn.
        {
          at: 0,
          ease: 'in',
          shift: [0.16, -0.16, 0],
          turn: [0, 0.26, 0.14],
          spine: [0.04, -0.2, -0.12],
          head: [0, 0.08, 0.1],
          armLeft: [0.9, 1.2, 0.55, 0.5],
          armRight: [1.9, 0.9, 0.6, 0.6],
          footRight: [0.42, 0, 0.1, 0],
        },
        {
          at: 0.125,
          ease: 'out',
          shift: [0.06, 0.01, 0],
          turn: [0, 0.05, 0.03],
          spine: [0, -0.06, -0.04],
          armLeft: [1.2, 1.1, 0.6, 0.5],
          armRight: [1.5, 1, 0.6, 0.6],
          footRight: [0.3, 0.34, 0.12, 0.5],
        },
        {
          at: 0.25,
          ease: 'in',
          shift: [-0.16, -0.16, 0],
          turn: [0, -0.26, -0.14],
          spine: [0.04, 0.2, 0.12],
          head: [0, -0.08, -0.1],
          armLeft: [1.9, 0.9, 0.6, 0.6],
          armRight: [0.9, 1.2, 0.55, 0.5],
          footLeft: [0.42, 0, 0.1, 0],
        },
        {
          at: 0.375,
          ease: 'out',
          shift: [-0.06, 0.01, 0],
          turn: [0, -0.05, -0.03],
          spine: [0, 0.06, 0.04],
          armLeft: [1.5, 1, 0.6, 0.6],
          armRight: [1.2, 1.1, 0.6, 0.5],
          footLeft: [0.3, 0.34, 0.12, 0.5],
        },
        {
          at: 0.5,
          ease: 'in',
          shift: [0.16, -0.2, 0],
          turn: [0.06, 0.26, 0.14],
          spine: [0.08, -0.2, -0.12],
          head: [0.05, 0.08, 0.1],
          armLeft: [0.7, 0.6, 0.7, 0.5],
          armRight: [2.6, 0.5, 0.9, 0.4],
          footRight: [0.42, 0, 0.1, 0],
        },
        {
          at: 0.625,
          ease: 'out',
          shift: [0.06, 0.01, 0],
          turn: [0, 0.05, 0.03],
          spine: [0, -0.06, -0.04],
          armLeft: [1, 0.9, 0.6, 0.5],
          armRight: [2.2, 0.7, 0.75, 0.5],
          footRight: [0.3, 0.34, 0.12, 0.5],
        },
        {
          at: 0.75,
          ease: 'in',
          shift: [-0.16, -0.2, 0],
          turn: [0.06, -0.26, -0.14],
          spine: [0.08, 0.2, 0.12],
          head: [0.05, -0.08, -0.1],
          armLeft: [2.6, 0.5, 0.9, 0.4],
          armRight: [0.7, 0.6, 0.7, 0.5],
          footLeft: [0.42, 0, 0.1, 0],
        },
        {
          at: 0.875,
          ease: 'out',
          shift: [-0.06, 0.01, 0],
          turn: [0, -0.05, -0.03],
          spine: [0, 0.06, 0.04],
          armLeft: [2.2, 0.7, 0.75, 0.5],
          armRight: [1, 0.9, 0.6, 0.5],
          footLeft: [0.3, 0.34, 0.12, 0.5],
        },
      ],
    },
    // ---- fidgets: small one-shots a standing body plays on its own ----
    {
      id: 'glance',
      label: 'Glance',
      seconds: 2.6,
      needs: { needs: ['head'] },
      keys: [
        { at: 0.18, ease: 'snap', head: [0.03, 0.5, 0.04], spine: [0, 0.08, 0] },
        { at: 0.45, head: [0.02, 0.46, 0.04], spine: [0, 0.07, 0] },
        { at: 0.62, ease: 'snap', head: [-0.04, -0.4, -0.03], spine: [0, -0.06, 0] },
        { at: 0.85, head: [-0.03, -0.36, -0.03], spine: [0, -0.05, 0] },
      ],
    },
    {
      id: 'shiftWeight',
      label: 'Shift weight',
      seconds: 3.2,
      needs: { atLeast: { legs: 2 } },
      side: 'left',
      keys: [
        { at: 0.25, shift: [0.07, -0.02, 0], turn: [0, 0.05, 0.07], spine: [0, -0.04, -0.1], head: [0, 0, 0.04], footRight: [0.03, 0, 0.03, 0.12] },
        { at: 0.75, shift: [0.07, -0.022, 0], turn: [0, 0.05, 0.07], spine: [0, -0.04, -0.1], head: [0, 0, 0.04], footRight: [0.03, 0, 0.03, 0.12] },
      ],
    },
    {
      id: 'stretch',
      label: 'Stretch',
      seconds: 3,
      needs: ARMS_NEEDED,
      keys: [
        { at: 0.3, ease: 'out', shift: [0, 0.02, 0], spine: [-0.16, 0, 0], head: [-0.2, 0, 0], arms: [2.9, 0.4, 0.98, 0.5], face: { blink: 'closed' } },
        { at: 0.6, shift: [0, 0.025, 0], spine: [-0.2, 0, 0.04], head: [-0.22, 0, 0], arms: [2.95, 0.3, 1, 0.5] },
        { at: 0.85, ease: 'in', spine: [0.04, 0, 0], arms: [0.5, 0.3, 0.9, 0.4], face: { blink: 'open' } },
      ],
    },
    {
      id: 'wag',
      label: 'Wag',
      seconds: 1.6,
      needs: { needs: ['tail'] },
      keys: [
        { at: 0.125, tail: [-0.2, 0.6, 0] },
        { at: 0.375, tail: [-0.2, -0.6, 0] },
        { at: 0.625, tail: [-0.2, 0.6, 0] },
        { at: 0.875, tail: [-0.2, -0.6, 0] },
      ],
    },
  ];
  MOVES.forEach(Kit.act.define);

  /** The fidgets: what `Kit.act.character` lets a standing body do on its own now and then. */
  Kit.act.FIDGETS = Object.freeze(['glance', 'shiftWeight', 'stretch', 'wag']);
})();
