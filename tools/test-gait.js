/**
 * Unit tests for movement: Kit.motion (stages, combinators, the motion state), Kit.gait (legs) and Kit.swim
 * (chains). Loaded by tools/test-kit.js after tools/test-body.js, which has already put the body system in the
 * sandbox.
 *
 * Owns:  the cases, each with a control that fails when the behaviour is absent (a level of detail that does
 *        slide beside the one that must not, a plan that is accepted beside the one that is refused).
 * Does not own: the sandbox or the runner (tools/test-kit.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['motion', 'gait', 'swim'];
/** Metres a planted foot's contact point may move during one stance: float rounding, nothing more. */
const PLANT_TOLERANCE = 0.001;
/** Metres the same footfall may differ between 60 and 20 frames a second. */
const FRAME_RATE_TOLERANCE = 0.03;

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const { motion, gait, swim, body } = Kit;
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const catalog = body.catalog(body.samples.CATALOG);
  const bakery = catalog.bakery();
  const bakeOf = (species, overrides) => bakery.bakeRecipe({ species, seed: 11, overrides });
  const STEADY_WALK = [{ seconds: 100, speed: 1.2 }];
  const START_TURN_STOP = [
    { seconds: 3, speed: 1.2 },
    { seconds: 2, speed: 1.2, turn: 0.7 },
    { seconds: 2, speed: 0 },
    { seconds: 50, speed: 0 },
  ];

  /**
   * Walks a body along a course and records what the tests need: every footfall, the furthest any planted
   * foot's contact point (the end of its foot bone) moved during a stance, and the worst balance figures.
   */
  const walkAlong = (bake, legs, { fps = 60, seconds = 8, detail = 0, controller = gait.walk() } = {}) => {
    const state = motion.state(bake, controller, { detail });
    const route = motion.course(legs);
    const rig = gait.legs(bake.plan, bake.rest);
    const tip = new Float32Array(3);
    const balance = { planted: 0, centerX: 0, centerY: 0, centerZ: 0, forwardOutside: 0, sideOutside: 0 };
    const stanceStarts = new Map();
    const footfalls = [];
    const worst = { slide: 0, outsideWhenCarried: 0, forwardOutside: 0, sideOutside: 0, fewestPlanted: Infinity, phaseSlide: 0 };
    /** For the lower detail, which keeps no feet: how far each foot bone moves while its leg's phase says "on the ground". */
    const phaseStarts = new Map();
    for (let frame = 0; frame < fps * seconds; frame++) {
      motion.drive(route, 1 / fps);
      motion.advance(state, 1 / fps, route.x, 0, route.z, route.heading);
      const feet = gait.feet(state);
      const clock = state.memory.gait;
      for (let leg = 0; leg < rig.count; leg++) {
        body.tailPosition(bake.plan, state.world, rig.end[leg], tip);
        const legPhase = (state.phase + clock.offsets[leg]) % 1;
        if (legPhase < clock.duty * 0.9 && legPhase > 0.05) {
          const start = phaseStarts.get(leg);
          if (start) worst.phaseSlide = Math.max(worst.phaseSlide, Math.hypot(tip[0] - start[0], tip[2] - start[2]));
          else phaseStarts.set(leg, Array.from(tip));
        } else phaseStarts.delete(leg);
        if (!feet || !feet.planted[leg]) continue;
        const key = `${leg}:${feet.plantCount[leg]}`;
        const start = stanceStarts.get(key);
        if (start) worst.slide = Math.max(worst.slide, Math.hypot(tip[0] - start[0], tip[1] - start[1], tip[2] - start[2]));
        else {
          stanceStarts.set(key, Array.from(tip));
          if (feet.plantCount[leg]) footfalls.push({ leg, x: feet.footX[leg], z: feet.footZ[leg] });
        }
      }
      if (!feet || state.time < 2) continue;
      gait.support(state, balance);
      worst.fewestPlanted = Math.min(worst.fewestPlanted, balance.planted);
      worst.forwardOutside = Math.max(worst.forwardOutside, balance.forwardOutside / rig.legLength);
      worst.sideOutside = Math.max(worst.sideOutside, balance.sideOutside / rig.legLength);
      if (balance.planted === rig.count || balance.planted >= 3) worst.outsideWhenCarried = Math.max(worst.outsideWhenCarried, balance.forwardOutside, balance.sideOutside);
    }
    return { state, rig, footfalls, worst };
  };

  /** A plan with any arrangement of three-bone legs under a level trunk, to prove nothing is special-cased. */
  const leggedPlan = (id, hips) =>
    body.plan({
      id,
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free' },
        { name: 'trunk', parent: 'ground', at: [0, 0.4, 0], roles: ['spine'], joint: 'free', girth: 0.2 },
        ...hips.flatMap(([x, z], index) => [
          { name: `upper${index}`, parent: 'trunk', at: [x, 0, z], roles: ['leg'] },
          { name: `lower${index}`, parent: `upper${index}`, at: [0, -0.2, 0], roles: ['leg'] },
          { name: `foot${index}`, parent: `lower${index}`, at: [0, -0.2, 0], tail: [0, 0, 0.05], roles: ['leg', 'foot', 'tip'] },
        ]),
      ],
    });

  // ---- stages and combinators ----
  test('motion: sequence runs steps on the fixed clock and poses once a frame, in order (control: the counts differ at 20 fps)', () => {
    const log = [];
    const first = motion.stage({ name: 'first', step: () => log.push('step1'), pose: () => log.push('pose1') });
    const second = (_state, _plan, dt) => log.push(`pose2:${dt.toFixed(3)}`);
    const state = motion.state({ plan: catalog.plans.fish }, motion.sequence(first, second));
    motion.advance(state, 1 / 60);
    assert.deepStrictEqual(log, ['step1', 'step1', 'pose1', 'pose2:0.017'], 'two 120 Hz steps, then the poses in order');
    log.length = 0;
    motion.advance(state, 1 / 20);
    assert.strictEqual(log.filter((entry) => entry === 'step1').length, 6, 'six steps in a 20 fps frame');
    assert.strictEqual(log.filter((entry) => entry === 'pose1').length, 1, 'still one pose');
  });
  test('motion: blend mixes a stage over the pose by weight, layer keeps it to some roles (controls: weight 0, and a bone outside the roles)', () => {
    const { biped } = catalog.plans;
    const head = biped.boneIndex('head');
    const hand = biped.boneIndex('handLeft');
    const nodAndWave = (state) => {
      Kit.rig.turn(state.pose.rotation, state.pose.rotation, head, 0, 1);
      Kit.rig.turn(state.pose.rotation, state.pose.rotation, hand, 0, 1);
    };
    const turnOf = (state, bone) => 2 * Math.asin(Math.min(1, Math.abs(state.pose.rotation[bone * 4])));
    const poseWith = (controller) => motion.advance(motion.state({ plan: biped }, controller), 1 / 60);
    close(turnOf(poseWith(nodAndWave), head), 1, 1e-3, 'the bare stage turns the head a radian');
    close(turnOf(poseWith(motion.blend(0.5, nodAndWave)), head), 0.5, 2e-2, 'half weight, half the turn');
    assert.strictEqual(turnOf(poseWith(motion.blend(0, nodAndWave)), head), 0, 'control: weight 0 leaves the pose alone');
    const layered = poseWith(motion.layer(['arm'], nodAndWave));
    close(turnOf(layered, hand), 1, 1e-3, 'the hand carries the arm role and keeps the change');
    assert.strictEqual(turnOf(layered, head), 0, 'control: the head does not, and is put back');
  });
  test('motion: when gates by capability and byDetail by level; a detail past the list is not evaluated at all', () => {
    const ran = [];
    const mark = (name) => motion.stage({ name, pose: () => ran.push(name) });
    const controller = motion.byDetail([motion.when({ atLeast: { legs: 2 } }, mark('legged'), mark('legless')), mark('cheap')]);
    const walker = motion.state({ plan: catalog.plans.biped }, controller);
    const swimmer = motion.state({ plan: catalog.plans.fish }, controller);
    motion.advance(walker, 1 / 60);
    motion.advance(swimmer, 1 / 60);
    walker.detail = 1;
    motion.advance(walker, 1 / 60);
    assert.deepStrictEqual(ran, ['legged', 'legless', 'cheap']);
    walker.detail = 2;
    const worldBefore = Array.from(walker.world.translation);
    motion.advance(walker, 1 / 60, 5, 0, 5, 1);
    assert.deepStrictEqual(ran, ['legged', 'legless', 'cheap'], 'nothing ran at detail 2');
    assert.deepStrictEqual(Array.from(walker.world.translation), worldBefore, 'and the world transforms were not recomputed');
    assert.strictEqual(walker.x, 5, 'though the state still knows where the body is');
  });
  test('motion: a fish is refused for walking and a biped for swimming, naming what is missing (controls: each accepted for the other)', () => {
    const { biped, fish } = catalog.plans;
    assert.match(motion.refusal(gait.walk(), fish), /the walk gait cannot move the plan "fish": it lacks legs/);
    assert.match(motion.refusal(swim.swim(), biped), /the carangiform swim cannot move the plan "biped": it lacks tail/);
    assert.throws(() => motion.state({ plan: fish }, gait.walk()), /lacks legs/);
    assert.strictEqual(motion.refusal(gait.walk(), biped), null, 'control: a biped may walk');
    assert.strictEqual(motion.refusal(swim.swim(), fish), null, 'control: a fish may swim');
    assert.strictEqual(motion.refusal(motion.when({ atLeast: { legs: 2 } }, gait.walk(), swim.swim()), fish), null, 'a gated stage asks nothing of the whole');
    const pegLegs = body.plan({
      id: 'pegs',
      bones: [
        { name: 'ground', roles: ['root'] },
        { name: 'trunk', parent: 'ground', at: [0, 1, 0] },
        ...[-1, 1].flatMap((side) => [
          { name: `hip${side}`, parent: 'trunk', at: [side * 0.1, 0, 0], roles: ['leg'] },
          { name: `peg${side}`, parent: `hip${side}`, at: [0, -1, 0], roles: ['leg'] },
        ]),
      ],
    });
    assert.match(motion.refusal(gait.walk(), pegLegs), /has 2 bones; a leg needs a hip, a knee and a foot/);
  });
  test('motion: lean tilts forward when speeding up and into a turn (control: nothing at a steady straight walk)', () => {
    const { biped } = catalog.plans;
    const head = biped.boneIndex('head');
    const state = motion.state({ plan: biped }, motion.lean());
    const headOffset = () => {
      const offsetX = state.world.translation[head * 3] - state.x;
      const offsetZ = state.world.translation[head * 3 + 2] - state.z;
      return { left: offsetX * Math.cos(state.heading) - offsetZ * Math.sin(state.heading), forward: offsetX * Math.sin(state.heading) + offsetZ * Math.cos(state.heading) };
    };
    let z = 0;
    let speed = 0;
    for (let frame = 0; frame < 40; frame++) motion.advance(state, 1 / 60, 0, 0, (z += (speed += 0.05) / 60));
    assert.ok(headOffset().forward > 0.02, `speeding up tips the head forward, got ${headOffset().forward}`);
    for (let frame = 0; frame < 240; frame++) motion.advance(state, 1 / 60, 0, 0, (z += speed / 60));
    close(headOffset().forward, 0, 0.005, 'control: steady and straight, upright again');
    const route = motion.course([{ seconds: 100, speed: 2, turn: 1 }], { acceleration: 100, turnAcceleration: 100 });
    motion.place(state, 0, 0, 0, 0);
    for (let frame = 0; frame < 120; frame++) motion.advance(state, 1 / 60, motion.drive(route, 1 / 60).x, 0, route.z, route.heading);
    assert.ok(headOffset().left > 0.05, `turning left leans the head left, got ${headOffset().left}`);
  });
  test('motion: trail makes a tail lag behind a body that starts moving, then settle (control: without the stage it stays rigid)', () => {
    const hound = bakeOf('hound');
    const tailEnd = hound.plan.boneIndex('tailEnd');
    const lagOf = (controller) => {
      const state = motion.state(hound, controller);
      const restOffset = state.world.translation[tailEnd * 3];
      let worstLag = 0;
      for (let frame = 0; frame < 30; frame++) {
        motion.advance(state, 1 / 60, frame * 0.05, 0, 0, 0);
        worstLag = Math.max(worstLag, Math.abs(state.world.translation[tailEnd * 3] - state.x - restOffset));
      }
      return worstLag;
    };
    assert.ok(lagOf(motion.trail()) > 0.05, 'a body shoved sideways leaves its tail behind');
    close(
      lagOf(() => {}),
      0,
      1e-5,
      'control: no trail stage, a rigid tail'
    );
  });
  test('motion: a course traces the same line at 60 and 20 frames a second', () => {
    const at = (fps) => {
      const route = motion.course(START_TURN_STOP);
      for (let frame = 0; frame < fps * 8; frame++) motion.drive(route, 1 / fps);
      return route;
    };
    close(at(60).x, at(20).x, 1e-6, 'x');
    close(at(60).z, at(20).z, 1e-6, 'z');
    assert.ok(Math.abs(at(60).heading) > 1, 'and it did turn');
  });

  // ---- legs ----
  test('gait: a planted foot does not slide, for two legs and four (control: level of detail 1 does slide)', () => {
    ['human', 'hound'].forEach((species) => {
      const full = walkAlong(bakeOf(species), START_TURN_STOP, { seconds: 9 });
      assert.ok(full.footfalls.length >= 8, `${species} took steps: ${full.footfalls.length}`);
      assert.ok(full.worst.slide < PLANT_TOLERANCE, `${species}: a planted foot moved ${full.worst.slide} m through starting, turning and stopping`);
      const cheap = walkAlong(bakeOf(species), STEADY_WALK, { detail: 1 });
      assert.strictEqual(gait.feet(cheap.state), null, 'control: detail 1 plants nothing');
      assert.ok(cheap.worst.phaseSlide > 0.02, `control: at detail 1 the ${species}'s feet do slide (${cheap.worst.phaseSlide} m), so the measure can fail`);
    });
  });
  test('gait: the same walk at 60 and 20 frames a second plants its feet in the same places', () => {
    ['human', 'hound'].forEach((species) => {
      const smooth = walkAlong(bakeOf(species), START_TURN_STOP, { fps: 60, seconds: 9 });
      const coarse = walkAlong(bakeOf(species), START_TURN_STOP, { fps: 20, seconds: 9 });
      assert.strictEqual(coarse.footfalls.length, smooth.footfalls.length, `${species}: the same number of footfalls`);
      smooth.footfalls.forEach((footfall, index) => {
        const other = coarse.footfalls[index];
        assert.strictEqual(other.leg, footfall.leg, `${species}: footfall ${index} is the same leg`);
        assert.ok(
          Math.hypot(other.x - footfall.x, other.z - footfall.z) < FRAME_RATE_TOLERANCE,
          `${species}: footfall ${index} differs by ${Math.hypot(other.x - footfall.x, other.z - footfall.z)} m`
        );
      });
      assert.ok(coarse.worst.slide < PLANT_TOLERANCE, `${species}: no slide at 20 fps either`);
    });
  });
  test('gait: stride length grows with the leg-length dial, and with speed (control: equal dials give equal strides)', () => {
    const strideWith = (legLength, speed = 1.4) => {
      const walked = walkAlong(bakeOf('human', { 'dial:legLength': legLength, 'dial:height': 1 }), [{ seconds: 100, speed }]);
      const own = walked.footfalls.filter((footfall) => footfall.leg === 0);
      return { stride: own[own.length - 1].z - own[own.length - 2].z, legLength: walked.rig.legLength };
    };
    const short = strideWith(0.85);
    const long = strideWith(1.2);
    assert.ok(long.legLength > short.legLength * 1.3, 'the dial changed the legs');
    assert.ok(long.stride > short.stride * 1.15, `longer legs, longer stride: ${short.stride} -> ${long.stride}`);
    close(strideWith(1.2).stride, long.stride, 1e-6, 'control: the same body strides the same');
    close(long.stride, gait.strideLength(1.4, long.legLength), 0.03, 'and it is the stride the physics asks for');
    assert.ok(strideWith(1, 2).stride > strideWith(1, 1).stride * 1.2, 'faster, longer');
  });
  test('gait: three legs and six legs built here walk with no special case; every leg steps and none slides', () => {
    const tripod = leggedPlan('tripod', [
      [0.15, 0.2],
      [-0.15, 0.2],
      [0, -0.2],
    ]);
    const hexapod = leggedPlan('hexapod', [
      [0.15, 0.3],
      [-0.15, 0.3],
      [0.15, 0],
      [-0.15, 0],
      [0.15, -0.3],
      [-0.15, -0.3],
    ]);
    [tripod, hexapod].forEach((plan) => {
      const walked = walkAlong({ plan, rest: body.createPose(plan) }, [{ seconds: 100, speed: 0.5 }], { seconds: 6 });
      const steps = Array.from(gait.feet(walked.state).plantCount);
      assert.ok(
        steps.every((count) => count >= 3),
        `${plan.id}: every leg stepped: ${steps}`
      );
      assert.ok(walked.worst.slide < PLANT_TOLERANCE, `${plan.id}: a planted foot moved ${walked.worst.slide} m`);
      assert.ok(walked.worst.fewestPlanted >= 2, `${plan.id}: never fewer than two feet down at a walk, got ${walked.worst.fewestPlanted}`);
    });
    const offsets = Array.from(gait.legs(hexapod, body.createPose(hexapod)).gaits[1].offsets);
    assert.deepStrictEqual(offsets, [0, 0.5, 0, 0.5, 0, 0.5], 'six legs trot as two tripods: left hind, middle, front, then right');
    assert.deepStrictEqual(
      Array.from(gait.legs(catalog.plans.quadruped, body.createPose(catalog.plans.quadruped)).gaits[1].offsets),
      [0, 0.5, 0.5, 0],
      'control: four legs use the written diagonal row'
    );
  });
  test('gait: at a walk the centre of mass is over the feet whenever they can hold it (control: at a run it is not)', () => {
    const hound = walkAlong(bakeOf('hound'), [{ seconds: 100, speed: 0.6 }]);
    assert.ok(hound.worst.fewestPlanted >= 3, `a walking quadruped keeps three feet down, got ${hound.worst.fewestPlanted}`);
    assert.strictEqual(hound.worst.forwardOutside + hound.worst.sideOutside, 0, 'and its centre of mass never leaves their span');
    const human = walkAlong(bakeOf('human'), [{ seconds: 100, speed: 1 }]);
    assert.strictEqual(human.worst.outsideWhenCarried, 0, 'a biped on both feet has its centre of mass between them');
    // On one foot a walker is falling forward onto the next: outside the foot, by a bounded amount.
    assert.ok(human.worst.forwardOutside < 0.4 && human.worst.sideOutside < 0.15, `on one foot: ${human.worst.forwardOutside} ahead, ${human.worst.sideOutside} aside (leg lengths)`);
    const runner = walkAlong(bakeOf('human'), [{ seconds: 100, speed: 4 }]);
    assert.ok(runner.worst.forwardOutside > 0.4, `control: a runner's centre of mass leaves that bound (${runner.worst.forwardOutside})`);
  });
  test('gait: gaits follow the Froude number, knees bend the way their limits allow, arms swing against legs', () => {
    const gaitAt = (species, speed) => gait.GAIT_NAMES[walkAlong(bakeOf(species), [{ seconds: 100, speed }], { seconds: 5 }).state.memory.gait.gait];
    assert.deepStrictEqual([gaitAt('human', 1.2), gaitAt('human', 3.5), gaitAt('human', 7)], ['walk', 'trot', 'run']);
    assert.strictEqual(gaitAt('hound', 1.2), 'walk');
    const human = bakeOf('human');
    const walked = walkAlong(human, STEADY_WALK);
    const { plan } = human;
    const at = (name, axis) => walked.state.world.translation[plan.boneIndex(name) * 3 + axis];
    ['Left', 'Right'].forEach((side) => {
      const kneeAhead = at(`shin${side}`, 2) - (at(`thigh${side}`, 2) + at(`foot${side}`, 2)) / 2;
      assert.ok(kneeAhead > -1e-3, `the ${side} knee is in front of the line from hip to ankle (${kneeAhead})`);
    });
    const footLead = at('footLeft', 2) - at('footRight', 2);
    const handLead = at('handLeft', 2) - at('handRight', 2);
    assert.ok(Math.abs(footLead) > 0.1 && footLead * handLead < 0, `the left hand is back when the left foot is forward: feet ${footLead}, hands ${handLead}`);
  });

  // ---- chains ----
  test('swim: the wave beats faster and the tail swings wider with speed, and the body curls into a turn (control: at rest it barely moves)', () => {
    const carp = bakeOf('carp');
    const tail = carp.plan.boneIndex('tailFin');
    const swimAt = (speed, turn = 0) => {
      const state = motion.state(carp, swim.swim());
      const route = motion.course([{ seconds: 100, speed, turn }], { acceleration: 100, turnAcceleration: 100 });
      let widest = 0;
      let leftSum = 0;
      for (let frame = 0; frame < 300; frame++) {
        motion.advance(state, 1 / 60, motion.drive(route, 1 / 60).x, 0, route.z, route.heading);
        const left = (state.world.translation[tail * 3] - state.x) * Math.cos(state.heading) - (state.world.translation[tail * 3 + 2] - state.z) * Math.sin(state.heading);
        if (frame >= 120) {
          widest = Math.max(widest, Math.abs(left));
          leftSum += left / 180;
        }
      }
      return { widest, leftMean: leftSum, frequency: state.memory.swim.frequency };
    };
    const still = swimAt(0);
    const cruising = swimAt(1);
    assert.ok(cruising.widest > still.widest * 2, `the tail swings wider at speed: ${still.widest} -> ${cruising.widest}`);
    assert.ok(still.widest < 0.03, 'control: a resting fish only idles');
    assert.ok(cruising.frequency > still.frequency * 1.5, 'and beats faster');
    assert.ok(swimAt(1, 1).leftMean > cruising.leftMean + 0.03, 'turning left, the tail curls to the left of the body line');
  });
  test('swim: a limbless chain slithers by the serpentine style; a body too short for it is refused by name', () => {
    const snake = body.plan({
      id: 'snake',
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free' },
        { name: 'head', parent: 'ground', at: [0, 0.05, 0.6], roles: ['spine', 'head'], joint: 'free' },
      ].concat(
        Array.from({ length: 7 }, (_unused, index) => ({
          name: `segment${index}`,
          parent: index ? `segment${index - 1}` : 'head',
          at: [0, 0, -0.15],
          roles: ['spine'],
          ...(index === 6 ? { tail: [0, 0, -0.15] } : {}),
        }))
      ),
    });
    assert.strictEqual(motion.refusal(swim.wave('serpentine'), snake), null);
    assert.match(motion.refusal(swim.wave('serpentine'), catalog.plans.biped), /has 3 joints; a serpentine wave needs 4 or more/);
    const state = motion.state({ plan: snake }, swim.wave('serpentine'));
    const middle = snake.boneIndex('segment3');
    let widest = 0;
    for (let frame = 0; frame < 240; frame++) {
      motion.advance(state, 1 / 60, 0, 0, frame / 60);
      if (frame > 120) widest = Math.max(widest, Math.abs(state.world.translation[middle * 3]));
    }
    assert.ok(widest > 0.02, `the middle of the body swings side to side: ${widest}`);
    close(state.memory.swim.frequency, 1 / (0.7 * swim.axis(snake, state.rest).length), 0.05, 'the wave runs back as fast as the body goes forward');
    assert.throws(() => swim.wave('butterfly'), /no style named "butterfly". Styles: carangiform, serpentine/);
  });
  test('motion: advanceStore drives every instance from the store columns and writes the phase back', () => {
    const crowd = body.store(4);
    const bake = bakeOf('human');
    const states = [0, 1].map((index) => motion.state(bake, gait.walk(), { x: index * 2 }));
    [0, 1].forEach((index) => crowd.spawn(0, index * 2, 0, 0, 0));
    crowd.detail[1] = 2;
    for (let frame = 0; frame < 120; frame++) {
      crowd.positionZ[0] += 1.2 / 60;
      crowd.positionZ[1] += 1.2 / 60;
      motion.advanceStore(crowd, states, 1 / 60);
    }
    assert.ok(crowd.phase[0] > 0 && states[0].memory.gait.feet.plantCount[0] > 0, 'the near instance walked');
    assert.strictEqual(states[1].memory.gait, undefined, 'control: the far one (detail 2) was never evaluated');
  });
};
