/**
 * Kit swim: movement for bodies that are a chain - a fish's spine and tail, a snake - as `Kit.motion` stages.
 * A wave of bending travels down the chain from front to back; how fast it beats and how wide it swings
 * follow the body's speed by the two relations real swimmers keep to, so nothing is keyed by hand.
 *
 * Owns:  `Kit.swim.STYLES` (carangiform: a fish, the bend growing towards the tail; serpentine: a limbless
 *        body on the ground, the same bend all along), `axis` (which bones are the chain, measured from the
 *        plan), the stages `wave` (the travelling wave, bent into turns) and `fins` (paired fins paddle), and
 *        the ready composition `swim` (bank into turns, wave, fins).
 * Does not own: the stage machinery, banking (`Kit.motion.lean`) or the fixed clock (kit/motion.js), legs
 *        (kit/gait.js), plans (kit/body-plan.js), water (there is none: buoyancy, drag and thrust are the
 *        caller's; a swimmer here is moved, and its body answers), or flight.
 *
 * Conventions (kit/motion.js): metres, seconds, radians; a chain's joints bend about their own up axis (+Y), so
 * the chain's bones must not be rolled at rest.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-gait.js.
 */
(() => {
  const { VECTOR_STRIDE, AXES } = Kit.rig;
  const { memory } = Kit.motion;
  const { FIXED_STEP } = Kit.dynamics;
  const TAU = Math.PI * 2;

  /**
   * Swimming styles, name -> row. Lengths are in body lengths (the chain's), speeds in body lengths per second.
   *   restFrequency, frequencyPerSpeed: beats per second = restFrequency + frequencyPerSpeed x speed. For fish
   *     this is Bainbridge's line (speed = (3 x frequency - 4) / 4 body lengths a second). A snake's wave must
   *     travel back along its body as fast as the body goes forward, so its line starts at 0 with a slope of
   *     one over its wavelength.
   *   strouhal: beat frequency x tail swing (peak to peak) / speed. Efficient swimmers of every size cruise
   *     near 0.3, which is what sets how wide the tail swings at a speed.
   *   idleAmplitude, mostAmplitude: the tail tip's swing each side of the middle is held between these.
   *   waves: how many wavelengths lie along the body at once.
   *   envelope: how the bend is shared out: a joint's share is (its distance along the body)^envelope, so 0 bends
   *     every joint alike and higher values keep the front still and whip the tail.
   *   recoil: the front of the body counter-swings by this share of the tail's angle.
   *   turnBend: radians the whole chain curls into a turn, per radian per second of turning; mostBend caps it.
   *   amplitudeRate: per second, how fast the swing follows a change of speed.
   */
  const STYLES = Object.freeze({
    carangiform: Object.freeze({
      restFrequency: 4 / 3,
      frequencyPerSpeed: 4 / 3,
      strouhal: 0.3,
      idleAmplitude: 0.015,
      mostAmplitude: 0.1,
      waves: 0.9,
      envelope: 1.4,
      recoil: 0.25,
      turnBend: 0.45,
      mostBend: 0.7,
      amplitudeRate: 4,
    }),
    serpentine: Object.freeze({
      restFrequency: 0,
      frequencyPerSpeed: 1 / 0.7,
      strouhal: 0.42,
      idleAmplitude: 0,
      mostAmplitude: 0.15,
      waves: 1 / 0.7,
      envelope: 0,
      recoil: 0,
      turnBend: 0.6,
      mostBend: 1.2,
      amplitudeRate: 4,
    }),
  });
  /** Paired fins paddle: radians of sweep, beats per body beat, and the share of the sweep kept when the body is still. */
  const FINS = Object.freeze({ sweep: 0.35, beatsPerWave: 0.5, idleShare: 0.5 });
  /** The fewest joints a chain needs to carry a wave, per style. */
  const FEWEST_JOINTS = Object.freeze({ carangiform: 3, serpentine: 4 });

  const NAME = 'Kit.swim';
  const AXIAL_MASK = (Kit.body.roleMask(['spine']) | Kit.body.roleMask(['tail'])) >>> 0;
  const FIN_MASK = Kit.body.roleMask(['fin']);
  const LEFT_MASK = Kit.body.roleMask(['left']);
  const RIGHT_MASK = Kit.body.roleMask(['right']);
  const TAIL_NEEDS = Kit.body.requirement({ atLeast: { tail: 2 } });
  const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));

  /**
   * @typedef {Object} AxisRig
   * A plan's swimming chain, measured once from the plan and a proportioned rest pose.
   * @property {Int16Array} joints the chain from front to back, each the parent of the next
   * @property {Float32Array} along per joint: distance from the first joint along the chain, metres
   * @property {number} length the whole chain, including the last bone's own extent, metres
   * @property {Int16Array} fins the paired fin bones
   * @property {Int8Array} finSide per fin: +1 on the left, -1 on the right
   */

  /** The longest run of spine and tail bones, parent to child, ending at a bone with no such child: front to back. */
  const longestAxialChain = (plan) => {
    const isAxial = (bone) => (plan.roles[bone] & AXIAL_MASK) !== 0;
    const hasAxialChild = new Uint8Array(plan.boneCount);
    for (let bone = 1; bone < plan.boneCount; bone++) if (isAxial(bone) && plan.parent[bone] >= 0) hasAxialChild[plan.parent[bone]] = 1;
    let best = [];
    for (let bone = 0; bone < plan.boneCount; bone++) {
      if (!isAxial(bone) || hasAxialChild[bone]) continue;
      const chain = [];
      for (let link = bone; link >= 0 && isAxial(link); link = plan.parent[link]) chain.unshift(link);
      // Later chains win ties: plans list the tail after the trunk.
      if (chain.length >= best.length) best = chain;
    }
    return best;
  };

  /** @type {WeakMap<Object, AxisRig>} */
  const rigByRest = new WeakMap();
  const scratchPoint = new Float32Array(VECTOR_STRIDE);

  /**
   * Finds and measures a plan's swimming chain: the longest run of spine and tail bones, front to back, and
   * its paired fins. Remembered per rest pose, so every instance of a bake shares one.
   * @param {Object} plan a `BodyPlan`
   * @param {Object} rest its proportioned rest pose (a bake's `rest`)
   * @returns {AxisRig} frozen; `joints` is empty for a plan with no spine or tail
   * @complexity O(bones) time once per rest pose, O(1) after
   * @example Kit.swim.axis(carp.plan, carp.rest).joints.length // 5: trunk, rear and three tail bones
   */
  const axis = (plan, rest) => {
    const known = rigByRest.get(rest);
    if (known) return known;
    const chain = longestAxialChain(plan);
    const world = Kit.body.worldTransforms(plan, rest, Kit.rig.create(plan.boneCount));
    const along = new Float32Array(chain.length);
    chain.forEach((bone, index) => {
      if (index === 0) return;
      const from = chain[index - 1] * VECTOR_STRIDE;
      const to = bone * VECTOR_STRIDE;
      along[index] =
        along[index - 1] +
        Math.hypot(world.translation[to] - world.translation[from], world.translation[to + 1] - world.translation[from + 1], world.translation[to + 2] - world.translation[from + 2]);
    });
    let length = chain.length ? along[chain.length - 1] : 0;
    if (chain.length) {
      const last = chain[chain.length - 1];
      Kit.body.tailPosition(plan, world, last, scratchPoint);
      length += Math.hypot(
        scratchPoint[0] - world.translation[last * VECTOR_STRIDE],
        scratchPoint[1] - world.translation[last * VECTOR_STRIDE + 1],
        scratchPoint[2] - world.translation[last * VECTOR_STRIDE + 2]
      );
    }
    const fins = Kit.body.bonesWithRoles(plan, FIN_MASK).filter((bone) => plan.roles[bone] & (LEFT_MASK | RIGHT_MASK));
    const rig = Object.freeze({ joints: Int16Array.from(chain), along, length, fins: Int16Array.from(fins), finSide: Int8Array.from(fins, (bone) => (plan.roles[bone] & LEFT_MASK ? 1 : -1)) });
    rigByRest.set(rest, rig);
    return rig;
  };

  /** What a style needs of a plan, as stage needs. */
  const needsOf = (styleName) => [
    {
      consumer: `the ${styleName} swim`,
      requirement: styleName === 'carangiform' ? TAIL_NEEDS : undefined,
      check: (plan, rest) => {
        const { joints } = axis(plan, rest);
        return joints.length >= FEWEST_JOINTS[styleName]
          ? null
          : `its longest chain of spine and tail bones has ${joints.length} joint${joints.length === 1 ? '' : 's'}; a ${styleName} wave needs ${FEWEST_JOINTS[styleName]} or more.`;
      },
    },
  ];

  /**
   * @typedef {Object} SwimState
   * An instance's swimming, kept in `motion.memory.swim`. Read only.
   * @property {AxisRig} rig
   * @property {number} frequency beats per second now
   * @property {number} amplitude the tail tip's swing each side of the middle now, metres
   */

  /**
   * The stage that swims: a wave of bending travels down the body's chain. On the fixed clock, the beat
   * frequency follows the speed and the tail's swing follows from the Strouhal number (see `STYLES`), eased so
   * a change of speed does not snap. Each frame, every joint of the chain is turned about its up axis by its
   * share of the wave, the front counter-swings, and the whole chain curls into a turn.
   * @param {string} [styleName='carangiform'] a `STYLES` name
   * @returns {Object} a `Stage` of kit/motion.js; a carangiform wave needs a tail of two or more bones and a
   *   chain of three or more joints, a serpentine wave a chain of four or more
   * @throws {Error} for an unknown style, naming the known ones
   * @complexity per fixed step O(1); per frame O(chain joints); no allocation after an instance's first frame
   * @example const slither = Kit.motion.sequence(Kit.swim.wave('serpentine'));
   */
  const wave = (styleName = 'carangiform') => {
    const style = STYLES[styleName];
    if (!style) throw new Error(`${NAME}.wave: no style named "${styleName}". Styles: ${Object.keys(STYLES).join(', ')}.`);
    const amplitudeBlend = 1 - Math.exp(-style.amplitudeRate * FIXED_STEP);
    /** @returns {SwimState} */
    const create = (motion) => ({ rig: axis(motion.plan, motion.rest), frequency: 0, amplitude: 0 });
    return Kit.motion.stage({
      name: `swim.wave(${styleName})`,
      needs: needsOf(styleName),
      step(motion, _plan, dt) {
        const swimming = memory(motion, 'swim', create);
        const bodyLength = swimming.rig.length;
        swimming.frequency = style.restFrequency + (style.frequencyPerSpeed * motion.speed) / bodyLength;
        // Strouhal: frequency x (peak-to-peak swing) / speed; half of the swing is to each side.
        const swing = swimming.frequency > 0 ? (style.strouhal * motion.speed) / (2 * swimming.frequency) : 0;
        swimming.amplitude += (clamp(swing, style.idleAmplitude * bodyLength, style.mostAmplitude * bodyLength) - swimming.amplitude) * amplitudeBlend;
        motion.phase = (motion.phase + swimming.frequency * dt) % 1;
      },
      pose(motion) {
        const swimming = memory(motion, 'swim', create);
        const { joints, along, length } = swimming.rig;
        const { rotation } = motion.pose;
        // Scale the shares so that, were every joint at its peak together, the tail tip would swing by the amplitude.
        let leverage = 0;
        for (let index = 1; index < joints.length; index++) leverage += (along[index] / length) ** style.envelope * (length - along[index]);
        const peak = leverage > 0 ? swimming.amplitude / leverage : 0;
        const curl = -clamp(motion.turnRate * style.turnBend, -style.mostBend, style.mostBend) / Math.max(1, joints.length - 1);
        for (let index = 1; index < joints.length; index++) {
          const share = (along[index] / length) ** style.envelope;
          Kit.rig.turn(rotation, rotation, joints[index], AXES.y, peak * share * Math.sin(TAU * (motion.phase - (style.waves * along[index]) / length)) + curl);
        }
        Kit.rig.turn(rotation, rotation, joints[0], AXES.y, -style.recoil * Math.atan2(swimming.amplitude, length) * Math.sin(TAU * (motion.phase - style.waves)));
        motion.isWorldCurrent = false;
      },
    });
  };

  /**
   * The stage that paddles paired fins (bones carrying `fin` and `left` or `right`): each sweeps about the
   * body's long axis, the two sides in mirror image, in time with the body's wave. It reads the clock `wave`
   * runs, so put it after one; a body without paired fins is left alone.
   * @returns {Object} a `Stage`; needs nothing
   * @complexity O(fins) per frame, no allocation
   * @example const swim = Kit.motion.sequence(Kit.swim.wave(), Kit.swim.fins());
   */
  const fins = () =>
    Kit.motion.stage({
      name: 'swim.fins',
      pose(motion) {
        const swimming = motion.memory.swim;
        if (!swimming) return;
        const sweep = FINS.sweep * Math.sin(TAU * motion.phase * FINS.beatsPerWave * 2) * (FINS.idleShare + (1 - FINS.idleShare) * Math.min(1, motion.speed / swimming.rig.length));
        for (let fin = 0; fin < swimming.rig.fins.length; fin++) Kit.rig.turn(motion.pose.rotation, motion.pose.rotation, swimming.rig.fins[fin], AXES.z, swimming.rig.finSide[fin] * sweep);
        motion.isWorldCurrent = false;
      },
    });

  /**
   * Swimming, ready made: bank into turns, the travelling wave and paddling fins at full detail; the wave alone
   * at level of detail 1; nothing beyond.
   * @param {string} [styleName='carangiform'] a `STYLES` name
   * @returns {Object} a `Stage`
   * @complexity see `wave`
   * @example const motion = Kit.motion.state(carpBake, Kit.swim.swim());
   */
  const swim = (styleName = 'carangiform') => Kit.motion.byDetail([Kit.motion.sequence(Kit.motion.lean({ pitchShare: 0, rollShare: 1.2 }), wave(styleName), fins()), wave(styleName)]);

  Kit.swim = { STYLES, FINS, FEWEST_JOINTS, axis, wave, fins, swim };
})();
