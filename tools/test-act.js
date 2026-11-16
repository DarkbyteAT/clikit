/**
 * Unit tests for performances: Kit.act (kit/act.js, the repertoire of kit/act-moves.js and kit/act-sport.js, the
 * life stages of kit/act-life.js), the loose chains of Kit.motion, and the Character Maker's stage player
 * (kit/creator-perform.js). Loaded by tools/test-kit.js after tools/test-gait.js, which has put movement in the
 * sandbox, and before tools/test-proof.js, so the proof sheets see the repertoire.
 *
 * Owns:  the cases, each with a control that fails when the behaviour is absent.
 * Does not own: the sandbox or the runner (tools/test-kit.js), or how a performance looks (the proof sheets).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['act', 'act-moves', 'act-sport', 'act-life', 'creator-perform'];
const FRAME = 1 / 60;
/** Metres a foot or a punching hand may miss its point by at the moment of contact. */
const REACH_TOLERANCE = 0.01;
/** Metres each of two hands may be from the point they hold between them (half a ball). */
const HELD_TOLERANCE = 0.08;
/** Metres a loop's joints may differ from where they were one loop earlier. */
const LOOP_TOLERANCE = 0.002;
/** Metres a loose chain may differ between 60 and 20 frames a second after the same walk. */
const LOOSE_TOLERANCE = 0.02;
/** Metres a hanging panel's end may dip under the ground for a frame: about its own thickness (its joint limits are applied after the simulation). */
const HEM_TOLERANCE = 0.03;

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const { act, motion } = Kit;
  const { performanceChoices, stagePlayer } = Kit.creator;
  const wardrobe = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const samples = Kit.body.catalog(Kit.body.samples.CATALOG);
  const person = wardrobe.bakery().bakeRecipe({ species: 'person', seed: 1 });
  const hound = samples.bakery().bakeRecipe({ species: 'hound', seed: 1 });
  const everyBake = [wardrobe, samples].flatMap((catalog) => catalog.speciesIds().map((species) => catalog.bakery().bakeRecipe({ species, seed: 1 })));

  /** A whole character of a bake, without the fidgets unless asked. */
  const cast = (bake, options = { fidgets: [] }, seed = 1) => act.cast(motion.state(bake, act.character(options)), seed);
  /** Advances a state on the spot, or along z at a speed. */
  const run = (state, seconds, dt = FRAME, speed = 0) => {
    for (let time = 0; time < seconds - 1e-9; time += dt) {
      state.travelled = (state.travelled || 0) + speed * dt;
      motion.advance(state, dt, 0, 0, state.travelled, 0);
    }
  };
  const jointOf = (state, name) => {
    const at = state.plan.boneIndex(name) * 3;
    return Array.from(state.world.translation.subarray(at, at + 3));
  };
  const distance = (first, second) => Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
  const isFinitePose = (state) => state.pose.rotation.every(Number.isFinite) && state.pose.translation.every(Number.isFinite);
  /** A performance's default point for a bake, in metres from where it stands; `mirror` -1 puts it on the other side. */
  const defaultPoint = (bake, id, mirror = 1) => {
    const measured = act.rig(bake.plan, bake.rest);
    const high = act.REPERTOIRE[id].defaultsInLegs ? measured.unit : measured.high;
    const [left, up, forward] = act.REPERTOIRE[id].defaults;
    return [left * high * mirror, up * high, forward * high];
  };

  test('act: the same seed and time step give the same poses, fidgets and blinks included (control: another seed differs)', () => {
    const poses = (seed) => {
      const state = cast(person, {}, seed);
      const seen = [];
      for (let second = 0; second < 30; second++) {
        run(state, 1);
        seen.push(Array.from(state.pose.rotation), act.playing(state), act.face(state).blink);
      }
      return JSON.stringify(seen);
    };
    assert.strictEqual(poses(5), poses(5));
    assert.notStrictEqual(poses(5), poses(6), 'a different seed fidgets and blinks at different moments');
  });

  test('act: every performance plays on every body it does not refuse, without a NaN, and is refused in words by the rest', () => {
    let played = 0;
    let refused = 0;
    everyBake.forEach((bake) => {
      Object.keys(act.REPERTOIRE).forEach((id) => {
        const refusal = act.refusal(id, bake.plan, bake.rest);
        const state = cast(bake);
        run(state, 0.5);
        assert.strictEqual(act.play(state, id), refusal === null, `${bake.plan.id} ${id}: play agrees with refusal`);
        if (refusal) {
          refused += 1;
          assert.ok(refusal.includes(`"${id}"`) && /lacks|needs|fewer|only/.test(refusal), `${bake.plan.id} ${id}: ${refusal}`);
          assert.strictEqual(act.playing(state), null, 'a refused performance changes nothing');
        } else played += 1;
        run(state, act.REPERTOIRE[id].seconds + 0.5);
        assert.ok(isFinitePose(state), `${bake.plan.id} ${id}: the pose stays finite`);
      });
    });
    assert.ok(played > 40 && refused > 10, `both paths were exercised (${played} played, ${refused} refused)`);
  });

  test('act: joints are addressed by role: a wave lifts the hand of a person, and a hound without arms is told why it cannot', () => {
    const state = cast(person);
    run(state, 1);
    const before = jointOf(state, 'handRight')[1];
    assert.ok(act.play(state, 'wave'));
    run(state, act.REPERTOIRE.wave.seconds * 0.5);
    assert.ok(jointOf(state, 'handRight')[1] > before + 0.1, 'the waving hand is well above where it hung');
    assert.ok(Math.abs(jointOf(state, 'handLeft')[1] - before) < 0.05, 'control: the other hand still hangs');
    assert.match(act.refusal('wave', hound.plan, hound.rest), /"wave" performance cannot move the plan .*lacks arm/);
    assert.strictEqual(act.refusal('wag', hound.plan, hound.rest), null, 'a tail is all a wag needs');
    assert.match(act.refusal('wag', person.plan, person.rest), /tail/);
  });

  test('act: a bad request is refused by name: an unknown id lists the repertoire, a bad spec says which field', () => {
    const state = cast(person);
    assert.throws(() => act.play(state, 'moonwalk'), /moonwalk.*wave/s);
    assert.throws(() => act.performance({ id: 'broken', seconds: 1, keys: [{ at: 0.5, elbow: [1] }] }), /broken.*elbow/s);
    assert.throws(() => act.performance({ id: 'broken', seconds: 1, keys: [{ at: 0.5, head: [0, 0, 0] }], reaches: [{ limb: 'footLeft', in: [0, 1] }] }), /target/);
    assert.throws(() => act.performance({ id: 'broken', seconds: 0, keys: [{ at: 0.5, head: [0, 0, 0] }] }), /seconds/);
  });

  test("act: loops close: a dance and a keeper's stance are where they were one loop earlier (control: half a loop earlier they are not)", () => {
    ['dance', 'keeperReady'].forEach((id) => {
      const state = motion.state(person, act.performer({ base: id, fidgets: [] }));
      const { seconds } = act.REPERTOIRE[id];
      run(state, seconds * 2);
      const then = ['handLeft', 'footRight', 'head'].map((name) => jointOf(state, name));
      run(state, seconds * 0.5);
      const halfWay = ['handLeft', 'footRight', 'head'].map((name) => jointOf(state, name));
      run(state, seconds * 0.5);
      const now = ['handLeft', 'footRight', 'head'].map((name) => jointOf(state, name));
      then.forEach((joint, index) => assert.ok(distance(joint, now[index]) < LOOP_TOLERANCE, `${id}: joint ${index} moved ${distance(joint, now[index])}`));
      assert.ok(
        then.some((joint, index) => distance(joint, halfWay[index]) > 0.01),
        `${id}: it does move within the loop`
      );
    });
  });

  test('act: a kick puts the foot on the point given at call time, with the foot on that side, and steps there (control: no point there before)', () => {
    [1, -1].forEach((mirror) => {
      const state = cast(person);
      run(state, 1);
      const point = defaultPoint(person, 'kick', mirror);
      const kicking = mirror === 1 ? 'footRight' : 'footLeft';
      const planted = mirror === 1 ? 'footLeft' : 'footRight';
      assert.ok(distance(jointOf(state, kicking), point) > 0.3, 'control: standing, the foot is nowhere near the point');
      assert.ok(act.play(state, 'kick', { target: point }));
      run(state, act.REPERTOIRE.kick.seconds * act.CONTACT.kick);
      assert.ok(distance(jointOf(state, kicking), point) < REACH_TOLERANCE, `the ${kicking} is ${distance(jointOf(state, kicking), point)} m from the ball at contact`);
      assert.ok(jointOf(state, planted)[1] < 0.01 && Math.abs(jointOf(state, planted)[2] - point[2]) < 0.1, 'the plant foot is on the ground beside the ball');
      run(state, act.REPERTOIRE.kick.seconds);
      const offset = [0, 0];
      assert.strictEqual(act.playing(state), null);
      assert.ok(act.takeRootMotion(state, offset) && offset[1] > 0.2, `the body ended up a step forward (${offset})`);
      assert.strictEqual(act.takeRootMotion(state, offset), false, 'root motion is collected once');
    });
  });

  test('act: a dive goes to the side the point is on and the hands meet it; a catch and a parry reach theirs', () => {
    [1, -1].forEach((mirror) => {
      const diver = cast(person);
      run(diver, 1);
      const point = defaultPoint(person, 'dive', mirror);
      act.play(diver, 'dive', { target: point });
      run(diver, act.REPERTOIRE.dive.seconds * act.CONTACT.dive);
      const nearest = Math.min(distance(jointOf(diver, 'handLeft'), point), distance(jointOf(diver, 'handRight'), point));
      assert.ok(nearest < 0.03, `dive: the leading hand is ${nearest} m from the point`);
      assert.ok(Math.sign(jointOf(diver, 'pelvis')[0]) === mirror && Math.abs(jointOf(diver, 'pelvis')[0]) > 0.3, 'the body has flown to that side');
      run(diver, act.REPERTOIRE.dive.seconds);
      assert.ok(jointOf(diver, 'head')[1] > 0.5, 'and it has got up again');

      const keeper = cast(person);
      run(keeper, 1);
      const held = defaultPoint(person, 'catch', mirror);
      act.play(keeper, 'catch', { target: held });
      run(keeper, act.REPERTOIRE.catch.seconds * act.CONTACT.catch);
      ['handLeft', 'handRight'].forEach((hand) => assert.ok(distance(jointOf(keeper, hand), held) < HELD_TOLERANCE, `catch: ${hand} is ${distance(jointOf(keeper, hand), held)} m away`));

      const puncher = cast(person);
      run(puncher, 1);
      const punched = defaultPoint(person, 'parry', mirror);
      act.play(puncher, 'parry', { target: punched });
      run(puncher, act.REPERTOIRE.parry.seconds * act.CONTACT.parry);
      const fist = mirror === 1 ? 'handLeft' : 'handRight';
      assert.ok(distance(jointOf(puncher, fist), punched) < 0.03, `parry: ${fist} is ${distance(jointOf(puncher, fist), punched)} m away`);
    });
  });

  test('act: a play can meet a named mark at a given time: the lead-in is warped, what follows runs as authored (control: unwarped it takes its own time)', () => {
    const marks = act.marks('dive');
    assert.ok(marks.takeoff < marks.contact && marks.contact < marks.land, JSON.stringify(marks));
    assert.ok(Math.abs(marks.contact - act.REPERTOIRE.dive.seconds * act.CONTACT.dive) < 1e-6, 'marks are seconds at the authored speed');
    /** Seconds until the dive has reached its contact mark, and until it is over. */
    const timed = (params) => {
      const state = cast(person);
      run(state, 1);
      const point = defaultPoint(person, 'dive');
      act.play(state, 'dive', { target: point, ...params });
      let contactAt = -1;
      let seconds = 0;
      let reachedBy = -1;
      while (act.playing(state) === 'dive') {
        run(state, FRAME);
        seconds += FRAME;
        if (contactAt < 0 && act.progress(state) >= act.CONTACT.dive) {
          contactAt = seconds;
          reachedBy = Math.min(distance(jointOf(state, 'handLeft'), point), distance(jointOf(state, 'handRight'), point));
        }
      }
      return { contactAt, seconds, reachedBy };
    };
    const authored = timed({});
    assert.ok(Math.abs(authored.contactAt - marks.contact) < 2 * FRAME, `control: unhurried, contact comes at its mark (${authored.contactAt})`);
    [0.3, 2].forEach((wanted) => {
      const met = timed({ reach: { mark: 'contact', in: wanted } });
      assert.ok(Math.abs(met.contactAt - wanted) < 2 * FRAME, `contact asked for in ${wanted} s came at ${met.contactAt}`);
      assert.ok(Math.abs(met.seconds - met.contactAt - (authored.seconds - authored.contactAt)) < 2 * FRAME, 'the landing and getting up take as long as authored');
      assert.ok(met.reachedBy < 0.05, `the hands are still on the point at contact (${met.reachedBy} m)`);
    });
    const state = cast(person);
    assert.throws(() => act.play(state, 'dive', { reach: { mark: 'release', in: 1 } }), /no mark "release".*takeoff, contact, land/s);
    assert.throws(() => act.play(state, 'dive', { reach: { mark: 'contact', in: 0 } }), /greater than 0/);
    assert.throws(() => act.performance({ id: 'broken', seconds: 1, marks: { contact: 2 }, keys: [{ at: 0.5, head: [0, 0, 0] }] }), /mark "contact"/);
    assert.strictEqual(Object.keys(act.marks('wave')).length, 0, 'a performance without marks has none');
  });

  test('act: a dive reaches eight points spread over a goal-sized area, low and high, both sides, on a squat body and a tall one', () => {
    [person, samples.bakery().bakeRecipe({ species: 'human', seed: 1 })].forEach((bake) => {
      const { stature, high } = act.rig(bake.plan, bake.rest);
      // A goal is about four statures wide and one and a third high; the keeper stands in the middle of it.
      const points = [-2, -1, 1, 2].flatMap((across) => [0.16, 1.13].map((up) => [across * stature, up * stature, 0.1 * high]));
      points.forEach((point) => {
        const state = cast(bake);
        run(state, 1);
        act.play(state, 'dive', { target: point });
        run(state, act.marks('dive').contact);
        const nearest = Math.min(distance(jointOf(state, 'handLeft'), point), distance(jointOf(state, 'handRight'), point));
        assert.ok(nearest < 0.08 * stature, `${bake.plan.id}: the leading hand is ${nearest} m from ${point}`);
      });
    });
  });

  test('act: a save chooses its form by where the ball is against the body\'s own reach, says which, and gets a hand to a 5 by 3 goal of shots on four builds', () => {
    const builds = [...['person', 'stout', 'lanky'].map((species) => wardrobe.bakery().bakeRecipe({ species, seed: 1 })), samples.bakery().bakeRecipe({ species: 'human', seed: 1 })];
    builds.forEach((bake) => {
      const measured = act.rig(bake.plan, bake.rest);
      const { stature, high, headRadius } = measured;
      const chosen = [];
      [0.95, 0.5, 0.08].forEach((up) =>
        [-0.95, -0.5, 0, 0.5, 0.95].forEach((across) => {
          const point = [across * 2.03 * stature, up * 1.36 * stature, 0.15 * high];
          const state = cast(bake);
          run(state, 1);
          const form = act.choose(state, 'save', { target: point });
          assert.ok(act.play(state, 'save', { target: point, reach: { mark: 'contact', in: 0.5 } }));
          assert.strictEqual(act.playing(state), form, 'what is playing is the form that was chosen');
          run(state, 0.5);
          const nearest = Math.min(distance(jointOf(state, 'handLeft'), point), distance(jointOf(state, 'handRight'), point));
          assert.ok(nearest < 0.1 * Math.max(...measured.armLength), `${bake.plan.id} ${form}: the nearer hand is ${nearest} m from ${point}`);
          // Hands lead: the ball is met by a hand, not by the head.
          assert.ok(distance(jointOf(state, 'head'), point) > nearest + headRadius / 2, `${bake.plan.id} ${form}: the head is as near ${point} as the hand`);
          chosen.push(form);
        })
      );
      assert.strictEqual(
        chosen.join(' '),
        'diveStep dive catchHigh dive diveStep diveStep dive catch dive diveStep diveStep dive smother dive diveStep',
        `${bake.plan.id}: corners are stepped to and dived at, the middle is jumped for, caught or dropped onto`
      );
    });
    const state = cast(person);
    assert.strictEqual(act.choose(cast(hound), 'save', { target: [0, 1, 0] }), null, 'a body that can do no form is told so');
    assert.strictEqual(act.play(cast(hound), 'save', { target: [0, 1, 0] }), false);
    assert.throws(() => act.choose(state, 'save', {}), /chooses by its point: give \{ target: \[x, y, z\] \}/);
    assert.throws(() => act.marks('save'), /"save" is a family of performances.*Kit\.act\.choose/s);
    assert.throws(() => act.defineFamily({ id: 'broken', forms: [{ play: 'nope' }] }), /plays "nope", which is not in the repertoire/);
    assert.throws(() => act.defineFamily({ id: 'broken', forms: [{ play: 'wave' }] }), /takes no point named "target"/);
    assert.throws(() => act.defineFamily({ id: 'broken', forms: [{ play: 'dive', aside: [2, 1] }] }), /`aside`.*\[from, to\)/);
    // A family is data: a new one in a few lines picks between existing performances.
    act.defineFamily({ id: 'testStop', forms: [{ play: 'parry', aside: [0, 1.5] }, { play: 'dive' }] });
    assert.strictEqual(act.choose(state, 'testStop', { target: [0.2, 0.6, 0.1] }), 'parry');
    assert.strictEqual(act.choose(state, 'testStop', { target: [1.5, 0.6, 0.1] }), 'dive');
  });

  test('act: in the air a leg is drawn up by its foot\'s keyed lift: a dive\'s upper leg is bent, its lower one trails (control: standing, both are long)', () => {
    const state = cast(person);
    run(state, 1);
    const legs = Kit.gait.legs(person.plan, person.rest);
    const measured = act.rig(person.plan, person.rest);
    const folded = (side) => {
      const leg = measured.footLeg[side];
      const hip = legs.upper[leg] * 3;
      const foot = jointOf(state, side ? 'footRight' : 'footLeft');
      return distance(Array.from(state.world.translation.subarray(hip, hip + 3)), foot) / legs.length[leg];
    };
    assert.ok(folded(0) > 0.9 && folded(1) > 0.9, `control: standing, the legs are nearly straight (${folded(0)}, ${folded(1)})`);
    act.play(state, 'dive', { target: defaultPoint(person, 'dive') });
    run(state, act.marks('dive').contact);
    assert.ok(folded(1) < 0.75, `the upper leg is bent in flight (${folded(1)} of its length)`);
    assert.ok(folded(0) > folded(1) + 0.15, `the lower leg trails longer (${folded(0)})`);
  });

  test('act: an arm lowered from overhead comes down in front, not out through a T; a hand keyed inside the head is moved out of it (controls: a small move is direct, a long-armed body is untouched)', () => {
    const handOut = (bake, spec, at) => {
      const state = cast(bake);
      run(state, 0.5);
      act.play(state, act.performance(spec));
      run(state, spec.seconds * at);
      const shoulder = jointOf(state, 'upperArmLeft');
      const hand = jointOf(state, 'handLeft');
      return { aside: hand[0] - shoulder[0], ahead: hand[2] - shoulder[2], state };
    };
    const human = samples.bakery().bakeRecipe({ species: 'human', seed: 1 });
    const arm = act.rig(human.plan, human.rest).armLength[0];
    const lowering = { id: 'testLower', seconds: 1, keys: [{ at: 0.2, armLeft: [3, 0, 1, 0] }, { at: 0.8, armLeft: [0.2, 0, 1, 0] }] };
    const middle = handOut(human, lowering, 0.5);
    assert.ok(middle.ahead > 0.4 * arm, `half way down the hand is in front of the shoulder (${middle.ahead} m ahead, ${middle.aside} m aside)`);
    assert.ok(middle.aside < 0.75 * arm, 'and not out at arm\'s length to the side');
    const small = handOut(human, { id: 'testSmall', seconds: 1, keys: [{ at: 0.2, armLeft: [1.9, 0, 1, 0] }, { at: 0.8, armLeft: [1.2, 0, 1, 0] }] }, 0.5);
    assert.ok(small.aside > 0.9 * arm && Math.abs(small.ahead) < 0.2 * arm, `control: a small move at the side stays at the side (${small.aside}, ${small.ahead})`);
    // Straight up beside a big head on a short arm: the hand would be inside the head.
    const up = { id: 'testUp', seconds: 1, hold: true, keys: [{ at: 0.5, armLeft: [3.05, 0, 1, 0] }] };
    const measured = act.rig(person.plan, person.rest);
    const raised = handOut(person, up, 1).state;
    const head = jointOf(raised, 'head');
    const centre = [head[0], head[1] + measured.headRadius, head[2]];
    assert.ok(distance(jointOf(raised, 'handLeft'), centre) > 0.95 * measured.headRadius, `the hand is outside the head (${distance(jointOf(raised, 'handLeft'), centre)} m from its middle, radius ${measured.headRadius})`);
  });

  test('act: a ball further off than a step is run up to: both feet step in turn, the kick still lands on it (control: a near ball takes no run)', () => {
    const { unit } = act.rig(person.plan, person.rest);
    const kickAt = (ahead) => {
      const state = cast(person);
      run(state, 1);
      const point = [-0.25 * unit, 0.25 * unit, ahead * unit];
      act.play(state, 'kick', { target: point });
      const lifted = [0, 0];
      for (let time = 0; time < act.marks('kick').plant; time += FRAME) {
        run(state, FRAME);
        ['footLeft', 'footRight'].forEach((foot, side) => (lifted[side] = Math.max(lifted[side], jointOf(state, foot)[1] - person.rest.translation[1] * 0)));
      }
      run(state, act.marks('kick').contact - act.marks('kick').plant);
      const miss = distance(jointOf(state, 'footRight'), point);
      run(state, act.REPERTOIRE.kick.seconds);
      const offset = [0, 0];
      act.takeRootMotion(state, offset);
      return { lifted, miss, forward: offset[1] };
    };
    const standing = jointOf(run(cast(person), 1) || cast(person), 'footLeft')[1];
    const far = kickAt(3.4);
    const near = kickAt(1.2);
    assert.ok(far.miss < REACH_TOLERANCE, `the foot is ${far.miss} m from the far ball at contact`);
    assert.ok(far.forward > 2 * unit, `the body has run ${far.forward} m to it`);
    assert.ok(far.lifted[0] > standing + 0.1 * unit && far.lifted[1] > standing + 0.1 * unit, `both feet left the ground on the way (${far.lifted}, standing ${standing})`);
    assert.ok(near.forward < far.forward / 2, `control: the near ball takes a step, not a run (${near.forward} m)`);
  });

  test('act: a wave is layered over a walk: the feet land where they would have anyway (control: the hand does not)', () => {
    const plain = cast(person);
    const waving = cast(person);
    run(plain, 2, FRAME, 0.8);
    run(waving, 2, FRAME, 0.8);
    act.play(waving, 'wave');
    run(plain, 1, FRAME, 0.8);
    run(waving, 1, FRAME, 0.8);
    ['footLeft', 'footRight'].forEach((foot) =>
      assert.ok(distance(jointOf(plain, foot), jointOf(waving, foot)) < 0.005, `${foot} differs by ${distance(jointOf(plain, foot), jointOf(waving, foot))}`)
    );
    assert.ok(distance(jointOf(plain, 'handRight'), jointOf(waving, 'handRight')) > 0.1);
  });

  test('act: standing is never still: the chest breathes, the eyes blink through the face frames, the head follows a point with a lag', () => {
    const state = cast(person);
    run(state, 1);
    const chest = [];
    const blinks = new Set();
    for (let frame = 0; frame < 900; frame++) {
      run(state, FRAME);
      chest.push(jointOf(state, 'head')[1]);
      blinks.add(act.face(state).blink);
    }
    assert.ok(Math.max(...chest) - Math.min(...chest) > 0.001, 'the body rises and falls with the breath');
    assert.deepStrictEqual([...blinks].sort(), [0, 1, 2], 'open, half and closed were all shown');
    assert.strictEqual(Kit.body.FRAME_SETS.blink.length, 3);
    const headTurn = () => state.pose.rotation[state.plan.boneIndex('head') * 4 + 1];
    const ahead = headTurn();
    act.lookAt(state, 3, 0.6, 1);
    run(state, 2 * FRAME);
    const early = Math.abs(headTurn() - ahead);
    run(state, 1.5);
    const settled = Math.abs(headTurn() - ahead);
    assert.ok(settled > 0.1, `the head has turned to the point (${settled})`);
    assert.ok(early < settled * 0.5, 'but not at once: it lags like a spring');
  });

  test('motion: loose chains trail by simulation and land in the same place at 60 and 20 frames a second (control: they do move)', () => {
    const cloak = (dt, speed) => {
      const state = cast(person);
      run(state, 4, dt, speed);
      return jointOf(state, 'outerwear/cloak').map((value, axis) => value - jointOf(state, 'chest')[axis]);
    };
    assert.ok(distance(cloak(1 / 60, 0.8), cloak(1 / 20, 0.8)) < LOOSE_TOLERANCE, `${distance(cloak(1 / 60, 0.8), cloak(1 / 20, 0.8))}`);
    const swinging = motion.state(person, motion.sequence(motion.loose()));
    const rigid = motion.state(person, motion.sequence());
    const cloakTurn = (state) => Array.from(state.pose.rotation.subarray(state.plan.boneIndex('outerwear/cloak') * 4, state.plan.boneIndex('outerwear/cloak') * 4 + 4));
    [swinging, rigid].forEach((state) => {
      run(state, 0.5);
      run(state, 0.3, FRAME, 3);
    });
    assert.notDeepStrictEqual(cloakTurn(swinging), cloakTurn(rigid), 'a cloak swings behind a body that sets off');
  });

  test('dynamics: a chain is kept above its floor and out of its balls, its long links included (control: without them it falls through)', () => {
    const hang = (withSolids) => {
      const rope = Kit.dynamics.chain({ count: 3, lengths: 0.5, balls: 1, thickness: 0.02 });
      Kit.dynamics.placeChain(rope, 0, 1, 0, 1, 0, 0);
      if (withSolids) {
        rope.floor = 0.4;
        rope.balls.set([0.25, 0.75, 0, 0.2]);
        rope.ballCount = 1;
      }
      let deepest = Infinity;
      let nearest = Infinity;
      for (let frame = 0; frame < 240; frame++) {
        Kit.dynamics.stepChain(rope, FRAME, 0, 1, 0);
        for (let point = 1; point < 3; point++) {
          deepest = Math.min(deepest, rope.positions[point * 3 + 1]);
          nearest = Math.min(nearest, Math.hypot(rope.positions[point * 3] - 0.25, rope.positions[point * 3 + 1] - 0.75, rope.positions[point * 3 + 2]));
        }
      }
      return { deepest, nearest };
    };
    const kept = hang(true);
    assert.ok(kept.deepest >= 0.4 + 0.02 - 1e-4, `no point under the floor (${kept.deepest})`);
    assert.ok(kept.nearest >= 0.2 + 0.02 - 0.01, `no point inside the ball (${kept.nearest})`);
    const free = hang(false);
    assert.ok(free.deepest < 0.2 && free.nearest < 0.15, 'control: with no floor and no ball the rope swings through both places');
  });

  test('motion: a cloak lies on the ground behind a body that sits and stays behind a body that jumps; soft kinds come from the part data', () => {
    const cloak = person.plan.boneIndex('outerwear/cloak');
    const tipOf = (state) => Kit.body.tailPosition(state.plan, state.world, cloak, [0, 0, 0]);
    const sitter = cast(person);
    run(sitter, 1);
    act.play(sitter, 'sit');
    let lowest = Infinity;
    for (let frame = 0; frame < 240; frame++) {
      run(sitter, FRAME);
      lowest = Math.min(lowest, tipOf(sitter)[1]);
    }
    assert.ok(lowest > -HEM_TOLERANCE, `the cloak's hem never went under the ground by more than its own thickness (${lowest})`);
    assert.ok(jointOf(sitter, 'pelvis')[1] < 0.1 && tipOf(sitter)[2] < 0 && tipOf(sitter)[1] < 0.06, `sat down, the cloak is laid on the ground behind (${tipOf(sitter)} pelvis ${jointOf(sitter, 'pelvis')})`);
    const jumper = cast(person);
    run(jumper, 1);
    act.play(jumper, 'jump');
    for (let frame = 0; frame < 84; frame++) {
      run(jumper, FRAME);
      assert.ok(tipOf(jumper)[2] < jointOf(jumper, 'pelvis')[2], `frame ${frame}: the cloak stays behind the hips`);
    }
    assert.strictEqual(person.plan.stiffness[cloak], Kit.body.SOFT_KINDS.cloak.stiffness, 'the cloak is soft by its kind');
    const skirt = person.plan.boneIndex('bottom/skirt');
    assert.ok(person.plan.stiffness[skirt] < motion.LOOSE_DEFAULTS.below && person.plan.stiffness[person.plan.boneIndex('chest')] > motion.LOOSE_DEFAULTS.below, 'a hem is loose, a chest is not');
    assert.throws(() => Kit.body.plan({ id: 'bad', bones: [{ name: 'root', roles: ['root'] }, { name: 'lock', parent: 'root', soft: 'jelly' }] }), /soft.*jelly.*hair/s);
  });

  test('act: the per-frame path builds no typed arrays and calls no array-building methods (control: a stage that copies an array each frame is caught)', () => {
    const counter = vm.runInContext(
      `(() => {
        const counts = { built: 0 };
        const restore = [];
        const wrap = (owner, name) => {
          const original = owner[name];
          owner[name] = function (...args) { counts.built += 1; return new.target ? Reflect.construct(original, args, new.target) : original.apply(this, args); };
          Object.setPrototypeOf(owner[name], original);
          owner[name].prototype = original.prototype;
          restore.push(() => (owner[name] = original));
        };
        return { counts, start() { counts.built = 0; ['Float32Array', 'Int16Array', 'Int8Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Float64Array', 'Map', 'Set'].forEach((name) => wrap(globalThis, name)); ['map', 'filter', 'slice', 'concat', 'flatMap'].forEach((name) => wrap(Array.prototype, name)); ['keys', 'values', 'entries', 'assign', 'freeze'].forEach((name) => wrap(Object, name)); ['from', 'of'].forEach((name) => wrap(Array, name)); }, stop() { restore.splice(0).reverse().forEach((undo) => undo()); return counts.built; } };
      })()`,
      sandbox
    );
    const measure = (state, play) => {
      run(state, 3, FRAME, 0.5);
      if (play) play(state);
      run(state, 0.1);
      counter.start();
      try {
        run(state, 4, FRAME, 0.5);
      } finally {
        counter.stop();
      }
      return counter.counts.built;
    };
    assert.strictEqual(measure(cast(person, {})), 0, 'idling and walking with fidgets');
    assert.strictEqual(
      measure(cast(person), (state) => act.play(state, 'dive')),
      0,
      'through a dive'
    );
    assert.strictEqual(
      measure(cast(person), (state) => act.base(state, 'dance')),
      0,
      'dancing'
    );
    assert.strictEqual(measure(cast(hound, {})), 0, 'a hound');
    const wasteful = motion.state(person, motion.sequence(vm.runInContext(`({ name: 'wasteful', pose: (state) => new Float32Array(state.pose.rotation) })`, sandbox)));
    assert.ok(measure(wasteful) > 100, 'control: the counter sees a stage that copies an array each frame');
  });

  test('creator: the picker offers idle, walk and run, then the repertoire with a reason where a body cannot; the stage idles after a one-shot', () => {
    const choices = performanceChoices(person);
    assert.strictEqual(
      choices
        .slice(0, 3)
        .map((choice) => choice.id)
        .join(),
      'idle,walk,run'
    );
    assert.ok(['wave', 'dance', 'kick', 'dive', 'sit'].every((id) => choices.some((choice) => choice.id === id && choice.refusal === null)));
    assert.ok(!choices.some((choice) => act.FIDGETS.includes(choice.id)), 'the fidgets idling plays on its own are not offered');
    assert.match(performanceChoices(hound).find((choice) => choice.id === 'wave').refusal, /arm/);
    const player = stagePlayer();
    const advance = (wanted, seconds) => {
      let showing = wanted;
      for (let time = 0; time < seconds; time += FRAME) showing = player.advance(FRAME, person, showing);
      return showing;
    };
    assert.strictEqual(advance('idle', 0.5), 'idle');
    assert.strictEqual(advance('wave', 0.5), 'wave');
    assert.strictEqual(advance('wave', act.REPERTOIRE.wave.seconds), 'idle', 'a one-shot hands back to idling');
    assert.strictEqual(advance('dance', 5), 'dance', 'a loop goes on');
    assert.strictEqual(advance('sit', 6), 'sit', 'a held pose is held');
    assert.strictEqual(advance('walk', 2), 'walk');
    assert.strictEqual(advance('kick', act.REPERTOIRE.kick.seconds + 0.2), 'idle');
    const kept = Kit.rig.create(person.plan.boneCount);
    Kit.rig.copy(player.motion().pose, kept);
    act.keepInPlace(player.motion(), kept);
    const carrier = act.rig(person.plan, person.rest).carrier * 3;
    assert.ok(Math.abs(kept.translation[carrier + 2] - person.rest.translation[carrier + 2]) < 0.05, 'after a kick the stage is still on the character');
    assert.strictEqual(stagePlayer().advance(FRAME, hound, 'wave'), 'idle', 'a body that cannot is left idling');
  });
};
