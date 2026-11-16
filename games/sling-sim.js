// Tower Smash simulation: one level as a physics world plus the rules that turn contacts into breaks, blasts, chains
// and score. No DOM, no THREE: with cannon.js loaded it runs in node (scratch/sling/solve.js searches aims with it).
//
// Owns: bodies for blocks and balls, launching, tap abilities, wind, break scheduling, explosions, chain counting,
// when a shot is over and when the rubble has settled, flight prediction, and the event stream that tells a presenter
// what just happened. Does not own: any tunable (games/sling-data.js), meshes, sound, HUD or the level flow
// (games/sling.js). Exposed as the global TOWER_SMASH_SIM.
//
// Shape: createSim(options) returns the live world. Mutation in place is deliberate (it wraps a physics engine);
// collide callbacks only schedule, and step() applies what they scheduled, so the world never changes mid-solve.
(() => {
  const DATA = window.TOWER_SMASH_DATA;
  const { WORLD, PREVIEW, FLIGHT, SETTLE, BLOCK_BODY, WAKE, CHAIN_FUSE, BOUNCE, PALETTE, MATERIALS, STATS_BASE } = DATA;
  const { direction, trace, sphereTouchesBox, blastKick } = Kit.ballistics;

  /** @typedef {{ x: number, y: number, z: number }} Vector */

  const SOLID_SURFACE = 'solid';
  const scaleVector = (vector, factor) => ({ x: vector.x * factor, y: vector.y * factor, z: vector.z * factor });
  const copyVector = (vector) => ({ x: vector.x, y: vector.y, z: vector.z });
  const blockColor = (material, index) => (material.color === undefined ? PALETTE[index % PALETTE.length] : material.color);

  /**
   * Velocities for a splitter's fragments: the parent velocity fanned around the vertical axis, outer fragments lifted.
   * @param {Vector} velocity @param {number} count @param {{ spread: number, fanLift: number }} split
   * @returns {Vector[]}
   */
  const fanVelocities = (velocity, count, { spread, fanLift }) =>
    Array.from({ length: count }, (_, index) => {
      const angle = (index - (count - 1) / 2) * spread, cos = Math.cos(angle), sin = Math.sin(angle);
      return { x: velocity.x * cos - velocity.z * sin, y: velocity.y + Math.abs(angle) * fanLift, z: velocity.x * sin + velocity.z * cos };
    });

  /**
   * Predicate factory: is a body resting close enough to `point` (beside or above it) to lose its support?
   * @param {Vector} point
   * @returns {(body: { position: Vector }) => boolean}
   */
  const restsNear = (point) => (body) =>
    Math.abs(body.position.x - point.x) < WAKE.reach && Math.abs(body.position.z - point.z) < WAKE.reach && body.position.y > point.y - WAKE.below;

  /**
   * @typedef {object} SimOptions
   * @property {object} level A Level from TOWER_SMASH_DATA.levelAt.
   * @property {(name: string) => number} [stat] Upgrade-driven numbers (see STATS_BASE); defaults to a new player's.
   * @property {object} [rng] Kit.rng stream for the only randomness (blast tumble); pass a seed for repeatable runs.
   * @property {{ block?: Function, ball?: Function }} [views] Mesh factories `block(spec, material, color)` and
   *   `ball(ballType, radius)`; a returned mesh is kept in step with its body. Omit to run headless.
   * @property {{ blocks: { index: number, position: number[], quaternion: number[] }[] }} [startFrom] Start from a
   *   settled state captured by `snapshot()` instead of the pristine level.
   */

  /**
   * Build the simulation of one level.
   * @param {SimOptions} options
   * @returns {object} The simulation API (see the returned object).
   * @example
   * const sim = TOWER_SMASH_SIM.createSim({ level: TOWER_SMASH_DATA.levelAt('toybox', 0) });
   * sim.on('break', ({ block, chain }) => console.log(block.material.id, chain));
   * sim.launch(TOWER_SMASH_DATA.BALLS.byId('heavy'), TOWER_SMASH_DATA.aimFromPull(0.6, 0));
   * while (sim.isShotLive() || !sim.isCalm()) sim.step(1 / 60);
   * @complexity step: one cannon step plus O(blocks + balls) rule checks. predict: O(steps x blocks). Memory: O(blocks).
   */
  function createSim({ level, stat = (name) => STATS_BASE[name], rng = Kit.rng(1), views = {}, startFrom = null }) {
    const { platform } = WORLD;
    const bus = Kit.bus();
    const phys = Kit.physics({ gravity: WORLD.gravity, friction: WORLD.friction, restitution: WORLD.restitution });
    phys.world.solver.iterations = WORLD.solverIterations;
    phys.surface(phys.floor(0), SOLID_SURFACE);
    const platformBody = phys.surface(phys.fixed([platform.halfWidth * 2, platform.top, platform.halfDepth * 2], { at: [0, platform.top / 2, platform.z] }), SOLID_SURFACE);
    const platformBox = phys.bounds(platformBody);
    BOUNCE.forEach((pair) => phys.contact(pair.ball, pair.scenery, { restitution: pair.restitution }));

    const launchPoint = WORLD.launchPoint;
    /** What a ball in the air feels: gravity plus the level's crosswind. The preview integrates exactly this. */
    const flightAcceleration = { x: level.windX, y: WORLD.gravity, z: 0 };

    const state = { time: 0, score: 0, bestChain: 0, shotsFired: 0, blocks: [], balls: [], fusedBalls: [] };
    /** The shot in flight: `chain` counts every break it caused. */
    const shot = { isLive: false, chain: 0, hasImpacted: false, idleSeconds: 0, seconds: 0 };

    // Wind is a force on balls only (towers are too heavy to feel it), applied before every physics step so it
    // integrates the same way gravity does and the preview stays exact.
    phys.world.addEventListener('preStep', () => state.balls.forEach((ball) => (ball.body.force.x += ball.body.mass * level.windX)));

    const targetsLeft = () => state.blocks.filter((block) => block.material.isTarget).length;
    const wakeAround = (point) => phys.wakeWhere(restsNear(point));

    // ---------------------------------------------- blocks and balls ----------------------------------------------

    function addBlock(spec, index, placement) {
      const [width, height, depth] = spec.size;
      const material = MATERIALS.byId(spec.materialId), color = blockColor(material, index);
      const mesh = views.block ? views.block(spec, material, color) : null;
      const mass = material.isStatic ? 0 : width * height * depth * level.density * material.density;
      const body = phys.box(mesh, spec.size, { mass, at: [spec.x, platform.top + spec.y, platform.z + spec.z] });
      phys.surface(body, material.surface || SOLID_SURFACE);
      Object.assign(body, BLOCK_BODY);
      if (placement) {
        body.position.set(...placement.position);
        body.quaternion.set(...placement.quaternion);
      }
      body.sleep(); // towers stay perfectly still until something hits them
      // breakAt: simulation time at which the block breaks; set by scheduleBreak, acted on in step().
      const block = { kind: 'block', index, spec, body, mesh, material, color, breakAt: Infinity };
      body.owner = block;
      phys.onHit(body, (speed, otherBody) => onBlockHit(block, speed, otherBody));
      state.blocks.push(block);
      bus.emit('blockAdded', { block });
    }

    function removeBlock(block) {
      phys.remove(block.body);
      state.blocks = state.blocks.filter((other) => other !== block);
      bus.emit('blockRemoved', { block });
    }

    /** @param {object} ballType @param {{ radius: number, mass: number, position: Vector, velocity: Vector, isFragment?: boolean }} launch */
    function spawnBall(ballType, { radius, mass, position, velocity, isFragment = false }) {
      const mesh = views.ball ? views.ball(ballType, radius) : null;
      const body = phys.sphere(mesh, radius, { mass, at: [position.x, position.y, position.z] });
      phys.surface(body, ballType.surface);
      body.linearDamping = 0; // free flight must match the undamped preview exactly
      body.velocity.set(velocity.x, velocity.y, velocity.z);
      const ball = { kind: 'ball', body, mesh, ballType, radius, isFragment, hasUsedAbility: false, firstHitAt: -1, isFused: false, isDead: false };
      body.owner = ball;
      phys.onHit(body, (speed, otherBody) => onBallHit(ball, speed, otherBody));
      state.balls.push(ball);
      bus.emit('ballAdded', { ball });
      return ball;
    }

    function removeBall(ball, withPuff = false) {
      if (ball.isDead) return;
      ball.isDead = true;
      phys.remove(ball.body);
      state.balls = state.balls.filter((other) => other !== ball);
      bus.emit('ballRemoved', { ball, withPuff });
    }

    const massOf = (ballType) => ballType.mass * (ballType.massStat ? stat(ballType.massStat) : 1);
    const launchVelocity = (aim) => scaleVector(direction(aim.yaw, aim.loft), aim.speed);

    /**
     * Fire a ball from the launch point.
     * @param {object} ballType A BALLS row.
     * @param {{ yaw: number, loft: number, speed: number }} aim From aimFromDrag / aimFromPull.
     */
    function launch(ballType, aim) {
      Object.assign(shot, { isLive: true, chain: 0, hasImpacted: false, idleSeconds: 0, seconds: 0 });
      state.shotsFired += 1;
      const ball = spawnBall(ballType, { radius: ballType.radius, mass: massOf(ballType), position: launchPoint, velocity: launchVelocity(aim) });
      bus.emit('launch', { ball });
    }

    // -------------------------------------------------- abilities --------------------------------------------------

    /** Replace a splitter with its fan of fragments. */
    function splitBall(ball) {
      const { ballType } = ball, { split } = ballType;
      const position = copyVector(ball.body.position), radius = ballType.radius * split.scale;
      const velocities = fanVelocities(ball.body.velocity, stat('splitCount'), split);
      removeBall(ball);
      const fragments = velocities.map((velocity) => spawnBall(ballType, { radius, mass: ballType.mass * split.massShare * stat('splitMass'), position, velocity, isFragment: true }));
      bus.emit('split', { position, ballType, fragments });
    }

    /** What a tap in flight does, keyed by BallType.ability.kind. */
    const ABILITIES = {
      split: splitBall,
      slam(ball) {
        ball.body.velocity.set(0, -ball.ballType.slam.speed, 0);
        bus.emit('slam', { position: copyVector(ball.body.position), ball });
      },
      detonate: (ball) => fuseBall(ball),
    };

    const hasAbility = (ballType) => !!ballType.ability && (!ballType.ability.needsStat || stat(ballType.ability.needsStat) > 0);
    const canUseAbility = (ball) => hasAbility(ball.ballType) && !ball.isFragment && !ball.hasUsedAbility && ball.firstHitAt < 0;

    /**
     * The player tapped during a shot: the first ball that still has its ability uses it.
     * @returns {boolean} whether anything happened.
     */
    function tap() {
      const ball = state.balls.find(canUseAbility);
      if (!ball) return false;
      ball.hasUsedAbility = true;
      ABILITIES[ball.ballType.ability.kind](ball);
      return true;
    }

    const shouldAutoSplit = (ball) => ball.ballType.split && canUseAbility(ball) && ball.body.position.z < platform.z + ball.ballType.split.autoDistance;

    // ------------------------------------------------ contacts ------------------------------------------------

    /** Mark a block to break `delay` seconds from now. Safe inside a collide callback: the world changes in step(). */
    const scheduleBreak = (block, delay = 0) => (block.breakAt = Math.min(block.breakAt, state.time + delay));

    /** Queue a bomb to explode on the next step (the world must not change inside a collide callback). */
    function fuseBall(ball) {
      if (ball.isFused) return;
      ball.isFused = true;
      state.fusedBalls.push(ball);
    }

    function onBlockHit(block, speed, otherBody) {
      const striker = otherBody.owner;
      const isBallContact = !!striker && striker.kind === 'ball';
      // A ball's breakPower scales how hard its hit counts: light fragments glance off crystal, rubber cracks it.
      if (speed * (isBallContact ? striker.ballType.breakPower : 1) > block.material.breakSpeed) scheduleBreak(block);
      if (!isBallContact) bus.emit('blockHit', { block, speed }); // ball contacts are voiced by 'ballHit'
    }

    function onBallHit(ball, speed, otherBody) {
      if (ball.isDead) return;
      if (ball.firstHitAt < 0) {
        ball.firstHitAt = state.time;
        ball.body.linearDamping = ball.body.angularDamping = FLIGHT.spentDamping; // spent balls stop rolling soon
      }
      if (ball.ballType.blast) fuseBall(ball);
      const struck = otherBody.owner && otherBody.owner.kind === 'block' ? otherBody.owner : null;
      const isHard = !!struck && speed >= FLIGHT.hardHitSpeed;
      if (struck) wakeAround(otherBody.position);
      bus.emit('ballHit', { ball, speed, struck, isHard, point: copyVector(ball.body.position) });
      if (isHard) markFirstImpact(ball.body.position);
    }

    /** The first hard block contact or blast of a shot: the presenter's one big moment. */
    function markFirstImpact(point) {
      if (shot.hasImpacted) return;
      shot.hasImpacted = true;
      bus.emit('firstImpact', { point: copyVector(point) });
    }

    /**
     * An explosion: shoves every movable block in reach (scaled by its material's blastScale) and breaks the breakable
     * ones that are not blast-proof. Kegs caught in it go off a beat later, which is what makes a chain readable.
     * @param {Vector} centre @param {{ radius: number, kick: number, lift: number, spin: number }} blast
     */
    function detonate(centre, blast) {
      state.blocks
        .filter((block) => !block.material.isStatic)
        .map((block) => ({ block, kick: blastKick(centre, block.body.position, blast) }))
        .filter((hit) => hit.kick)
        .forEach(({ block, kick }) => {
          const { material } = block;
          phys.push(block.body, scaleVector(kick, material.blastScale === undefined ? 1 : material.blastScale));
          block.body.angularVelocity.set(rng.range(-blast.spin, blast.spin), rng.range(-blast.spin, blast.spin), rng.range(-blast.spin, blast.spin));
          if (material.onBreak && !material.isBlastProof) scheduleBreak(block, material.onBreak === 'blast' ? CHAIN_FUSE : 0);
        });
      wakeAround(centre);
      bus.emit('blast', { centre: copyVector(centre), radius: blast.radius });
      markFirstImpact(centre);
    }

    function explodeBall(ball) {
      const centre = copyVector(ball.body.position), { blast } = ball.ballType;
      removeBall(ball);
      detonate(centre, { ...blast, radius: blast.radius * stat('blastRadius') });
    }

    /** What breaking does beyond removing the block, keyed by BlockMaterial.onBreak. Each returns the points scored. */
    const BREAK_RULES = {
      score: (block) => block.material.points * shot.chain,
      shatter: () => 0,
      blast(block, position) {
        detonate(position, block.material.blast);
        return 0;
      },
    };

    /** Remove a block that reached its break time, extend the shot's chain and apply its material's rule. */
    function breakBlock(block) {
      const position = copyVector(block.body.position);
      shot.chain += 1;
      state.bestChain = Math.max(state.bestChain, shot.chain);
      removeBlock(block); // before the rule, so a keg's blast does not shove the keg itself
      wakeAround(position);
      const points = BREAK_RULES[block.material.onBreak](block, position);
      state.score += points;
      bus.emit('break', { block, position, chain: shot.chain, points });
    }

    // -------------------------------------------------- stepping --------------------------------------------------

    const hasLeftPlatform = (block) => block.material.isTarget && block.body.position.y < platform.top - WORLD.offPlatformDrop;
    const isBallLive = (ball) => {
      const { position } = ball.body;
      const isSpent = ball.firstHitAt >= 0 && state.time - ball.firstHitAt >= ball.ballType.linger;
      return !isSpent && position.z > FLIGHT.farZ && Math.abs(position.x) < FLIGHT.sideX;
    };

    /** End the shot once no ball is live (or it has simply taken too long): the next ball never waits on rubble. */
    function updateShot(dt) {
      if (!shot.isLive) return;
      shot.seconds += dt;
      shot.idleSeconds = state.balls.some(isBallLive) ? 0 : shot.idleSeconds + dt;
      if (shot.idleSeconds < FLIGHT.idleGrace && shot.seconds < FLIGHT.maxSeconds) return;
      state.balls.forEach((ball) => removeBall(ball, true));
      shot.isLive = false;
      bus.emit('shotEnd', { chain: shot.chain });
    }

    /**
     * Advance the world and apply everything the collide callbacks only scheduled: detonations, breaks, auto-splits.
     * @param {number} dt Seconds (use multiples of 1/60 for repeatable runs).
     */
    function step(dt) {
      state.time += dt;
      phys.step(dt);
      state.fusedBalls.splice(0).filter((ball) => !ball.isDead).forEach(explodeBall);
      state.blocks.filter(hasLeftPlatform).forEach((block) => scheduleBreak(block));
      state.blocks.filter((block) => block.breakAt <= state.time).forEach(breakBlock);
      state.balls.filter(shouldAutoSplit).forEach((ball) => {
        ball.hasUsedAbility = true;
        splitBall(ball);
      });
      updateShot(dt);
    }

    const isBlockCalm = (block) => block.body.sleepState === CANNON.Body.SLEEPING || block.body.velocity.length() < SETTLE.calmSpeed;

    /**
     * The path a ball would fly for an aim, stopped at the floor, the platform or the first block in the way.
     * @param {object} ballType @param {{ yaw: number, loft: number, speed: number }} aim
     * @returns {{ points: Vector[], end: Vector, isBlocked: boolean }}
     */
    function predict(ballType, aim) {
      const obstacles = [platformBox, ...state.blocks.map((block) => phys.bounds(block.body))];
      const { radius } = ballType;
      return trace({
        origin: launchPoint,
        velocity: launchVelocity(aim),
        acceleration: flightAcceleration,
        step: PREVIEW.step,
        maxSteps: PREVIEW.maxSteps,
        // Slightly under the true radius, so a shot that just grazes a corner is still drawn as passing it.
        stopWhen: (point) => point.y < radius || obstacles.some((box) => sphereTouchesBox(point, radius * PREVIEW.clearance, box)),
      });
    }

    /** Capture where every surviving block rests, to rebuild this state later with createSim({ startFrom }). */
    const snapshot = () => ({
      blocks: state.blocks.map((block) => ({ index: block.index, position: block.body.position.toArray(), quaternion: block.body.quaternion.toArray() })),
    });

    // Build the level: either pristine, or only the blocks a snapshot says survived, where they came to rest.
    if (startFrom) startFrom.blocks.forEach((placement) => addBlock(level.blocks[placement.index], placement.index, placement));
    else level.blocks.forEach((spec, index) => addBlock(spec, index));

    return {
      level, state, shot, launchPoint,
      on: bus.on,
      launch, tap, step, predict, snapshot,
      targetsLeft,
      hasAbility,
      /** Whether a tap would do something right now (for the "tap to ..." prompt). */
      canTap: () => state.balls.some(canUseAbility),
      isShotLive: () => shot.isLive,
      /** Whether every block has come to rest. */
      isCalm: () => state.blocks.every(isBlockCalm),
      /** Tear the world down, announcing every removal so a presenter can release its meshes. */
      dispose() {
        state.blocks.forEach(removeBlock);
        state.balls.forEach((ball) => removeBall(ball));
      },
    };
  }

  window.TOWER_SMASH_SIM = { createSim, fanVelocities };
})();
