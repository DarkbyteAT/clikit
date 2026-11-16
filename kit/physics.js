/**
 * Kit physics: a thin wrapper over cannon.js (global CANNON).
 *
 * Owns:  one physics world with sensible defaults (fixed 60 Hz timestep, sleeping on), rigid
 *        bodies paired with the meshes that show them, mesh <- body syncing after each step,
 *        impact callbacks, static scenery, bounds, pushes and blasts.
 * Does not own: the meshes themselves (make.js), projectile and blast maths as plain data
 *        (ballistics.js) or the frame loop: the game calls `phys.step(dt)` from its update.
 *
 * Needs cannon.js, so it is exercised by tools/smoke.js rather than unit tests.
 *
 * @example
 * const phys = Kit.physics({ gravity: -20 });
 * const body = phys.box(mesh, [width, height, depth], { mass: 1 });   // or phys.sphere(mesh, radius, { mass }) / phys.add(mesh, body)
 * phys.onHit(body, (speed, other, event) => speed > 4 && sfx.play('thud'));
 * // in update(dt): phys.step(dt);
 */
(() => {
  // ---- tunables ------------------------------------------------------------------------------------------------------

  /** The simulation always advances in steps of this many seconds, whatever the frame rate, so it behaves the same on every device. */
  const FIXED_STEP_SECONDS = 1 / 60;
  /** Most steps simulated in one frame. Beyond this the simulation slows down instead of spiralling after a long frame. */
  const MAX_STEPS_PER_FRAME = 4;
  /** Contact solver passes per step: enough for small stacks to stand without jitter. */
  const SOLVER_ITERATIONS = 8;
  /** A body slower than this (units / s) for SLEEP_AFTER_SECONDS stops being simulated until something touches it. */
  const SLEEP_SPEED_LIMIT = 0.25;
  const SLEEP_AFTER_SECONDS = 0.6;
  const DEFAULT_MASS = 1;
  /** A little air drag on spheres, so a rolling ball eventually comes to rest. */
  const DEFAULT_SPHERE_DAMPING = 0.01;

  /**
   * @typedef {Object} BodyOptions
   * @property {number} [mass=1] 0 makes the body immovable
   * @property {[number, number, number]} [at] starting position (default: the mesh's position)
   * @property {number} [damping=0.01] linear damping 0..1 (spheres only)
   */

  /**
   * Creates a physics world.
   * @param {Object} [options]
   * @param {number} [options.gravity=-20] acceleration along y, units / s^2 (negative is down)
   * @param {number} [options.friction=0.5] default contact friction
   * @param {number} [options.restitution=0.15] default bounciness, 0..1
   * @returns {Object} `{ world, pairs, add(mesh, body), box(mesh, size, options), sphere(mesh, radius, options), remove(body),
   *   onHit(body, listener), step(dt), fixed(size, { at }), floor(height), bounds(body), push(body, velocityChange),
   *   blast(centre, options, bodies), wakeWhere(shouldWake, bodies) }`; `world` is the CANNON.World and `pairs` the live
   *   list of `{ mesh, body }` being synced
   */
  Kit.physics = ({ gravity = -20, friction = 0.5, restitution = 0.15 } = {}) => {
    const world = new CANNON.World();
    world.gravity.set(0, gravity, 0);
    // Sweep-and-prune finds candidate pairs faster than the default all-against-all check.
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.solver.iterations = SOLVER_ITERATIONS;
    world.defaultContactMaterial.friction = friction;
    world.defaultContactMaterial.restitution = restitution;
    /** Mesh / body pairs kept in sync by step(). */
    const pairs = [];
    /** Frame time not yet simulated, seconds. */
    let unsimulatedSeconds = 0;

    /**
     * Adds a body you built yourself to the world, optionally tied to a mesh.
     * @param {?THREE.Object3D} mesh follows the body after every step; null for a body with nothing to show
     * @param {CANNON.Body} body
     * @returns {CANNON.Body}
     */
    function add(mesh, body) {
      body.sleepSpeedLimit = SLEEP_SPEED_LIMIT;
      body.sleepTimeLimit = SLEEP_AFTER_SECONDS;
      world.addBody(body);
      if (mesh) pairs.push({ mesh, body });
      return body;
    }

    const massOf = (options) => (options.mass === undefined ? DEFAULT_MASS : options.mass);
    /** Where a new body starts: the `at` option, else wherever its mesh already is. */
    const startPosition = (mesh, options) => {
      const [x, y, z] = options.at || [mesh.position.x, mesh.position.y, mesh.position.z];
      return new CANNON.Vec3(x, y, z);
    };

    /**
     * Adds a box body for a mesh.
     * @param {THREE.Object3D} mesh
     * @param {[number, number, number]} size full width, height and depth
     * @param {BodyOptions} [options]
     * @returns {CANNON.Body}
     */
    const box = (mesh, [width, height, depth], options = {}) => {
      // Cannon boxes are described by half-extents.
      const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
      return add(mesh, new CANNON.Body({ mass: massOf(options), shape, position: startPosition(mesh, options) }));
    };

    /**
     * Adds a sphere body for a mesh.
     * @param {THREE.Object3D} mesh
     * @param {number} radius
     * @param {BodyOptions} [options]
     * @returns {CANNON.Body}
     */
    const sphere = (mesh, radius, options = {}) =>
      add(
        mesh,
        new CANNON.Body({
          mass: massOf(options),
          shape: new CANNON.Sphere(radius),
          position: startPosition(mesh, options),
          linearDamping: options.damping || DEFAULT_SPHERE_DAMPING,
        })
      );

    /**
     * Takes a body out of the world and stops syncing its mesh (the mesh itself is left alone).
     * @param {CANNON.Body} body
     */
    function remove(body) {
      world.removeBody(body);
      const pairIndex = pairs.findIndex((pair) => pair.body === body);
      if (pairIndex >= 0) pairs.splice(pairIndex, 1);
    }

    /**
     * Calls back whenever a body starts touching another.
     * @param {CANNON.Body} body
     * @param {function(number, CANNON.Body, Object): void} listener gets (impact speed along the contact normal in
     *   units / s, the other body, the raw cannon event)
     */
    const onHit = (body, listener) =>
      body.addEventListener('collide', (event) => listener(Math.abs(event.contact.getImpactVelocityAlongNormal()), event.body, event));

    /** Copies a body's position and rotation onto its mesh. */
    const syncMesh = ({ mesh, body }) => {
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    };

    /**
     * Advances the simulation and moves every paired mesh. Call once per frame from the game's update.
     * @param {number} dt frame time in seconds
     */
    function step(dt) {
      // Fixed-timestep accumulator: bank the frame time, then spend it in whole steps. The cap
      // drops time the device cannot keep up with, so a slow frame does not cause a burst of steps.
      unsimulatedSeconds = Math.min(unsimulatedSeconds + dt, FIXED_STEP_SECONDS * MAX_STEPS_PER_FRAME);
      while (unsimulatedSeconds >= FIXED_STEP_SECONDS) {
        world.step(FIXED_STEP_SECONDS);
        unsimulatedSeconds -= FIXED_STEP_SECONDS;
      }
      pairs.forEach(syncMesh);
    }

    // ---- Additions (nothing above changes): static scenery, bounds, pushes and blasts. Vectors are plain { x, y, z }. ----
    /**
     * Immovable box (platforms, walls). It has no mesh to sync: draw it yourself with make.box at the same place.
     * @param {[number, number, number]} size Full width, height and depth.
     * @param {{ at: [number, number, number] }} options Centre position.
     * @returns {CANNON.Body}
     */
    const fixed = ([width, height, depth], { at: [x, y, z] }) =>
      add(null, new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)), position: new CANNON.Vec3(x, y, z) }));
    /**
     * Infinite horizontal floor facing up.
     * @param {number} [height] World y of the surface.
     * @returns {CANNON.Body}
     */
    const floor = (height = 0) => {
      const body = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
      // A cannon plane faces +z; turn it to face +y.
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
      body.position.y = height;
      return add(null, body);
    };
    /**
     * A body's current world-space bounding box as plain data (the Box shape Kit.ballistics.sphereTouchesBox takes).
     * @param {CANNON.Body} body
     * @returns {{ min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } }}
     */
    const bounds = (body) => {
      body.computeAABB(); // sleeping bodies do not refresh their box by themselves
      const { lowerBound, upperBound } = body.aabb;
      return { min: { x: lowerBound.x, y: lowerBound.y, z: lowerBound.z }, max: { x: upperBound.x, y: upperBound.y, z: upperBound.z } };
    };
    /**
     * Wake a body and add to its velocity (a mass-independent shove; sleeping bodies ignore velocity until woken).
     * @param {CANNON.Body} body
     * @param {{ x: number, y: number, z: number }} velocityChange Units per second.
     * @returns {CANNON.Body}
     */
    const push = (body, velocityChange) => {
      body.wakeUp();
      body.velocity.set(body.velocity.x + velocityChange.x, body.velocity.y + velocityChange.y, body.velocity.z + velocityChange.z);
      return body;
    };
    /**
     * Explosion: pushes every dynamic body within reach away from the centre (falloff from Kit.ballistics.blastKick).
     * @param {{ x: number, y: number, z: number }} centre
     * @param {{ radius: number, kick: number, lift?: number, spin?: number }} options `spin` is the largest random tumble
     *   (radians per second per axis) given to each pushed body; the rest is passed to blastKick.
     * @param {CANNON.Body[]} [bodies] Candidates; defaults to every body in the world.
     * @returns {CANNON.Body[]} The bodies that were pushed, so the caller can break, score or light them.
     * @example phys.blast(bomb.position, { radius: 3, kick: 16, lift: 0.3, spin: 6 }).forEach((body) => shatter(body));
     */
    const blast = (centre, options, bodies = world.bodies) => {
      const { spin = 0 } = options;
      return bodies
        .filter((body) => body.mass > 0)
        .map((body) => ({ body, velocityChange: Kit.ballistics.blastKick(centre, body.position, options) }))
        .filter((hit) => hit.velocityChange)
        .map(({ body, velocityChange }) => {
          push(body, velocityChange);
          if (spin) body.angularVelocity.set(Kit.math.rand(-spin, spin), Kit.math.rand(-spin, spin), Kit.math.rand(-spin, spin));
          return body;
        });
    };
    /**
     * Wake the sleeping bodies a predicate picks. Cannon only wakes sleepers on contact with a moving body, so anything
     * resting on a body you removed or teleported hangs in the air until woken by hand.
     * @param {(body: CANNON.Body) => boolean} shouldWake
     * @param {CANNON.Body[]} [bodies] Candidates; defaults to every body in the world.
     */
    const wakeWhere = (shouldWake, bodies = world.bodies) =>
      bodies.filter((body) => body.sleepState === CANNON.Body.SLEEPING && shouldWake(body)).forEach((body) => body.wakeUp());

    // ---- Additions: named surfaces, so chosen pairs of bodies can be bouncier or slicker than the world default. ----
    const surfaces = new Map();
    const surfaceNamed = (name) => {
      if (!surfaces.has(name)) surfaces.set(name, new CANNON.Material(name));
      return surfaces.get(name);
    };
    /**
     * Give a body a named surface. On its own this changes nothing: declare how two surfaces meet with `contact`.
     * @param {CANNON.Body} body
     * @param {string} name Any label, e.g. 'rubber', 'ice', 'bumper'.
     * @returns {CANNON.Body}
     */
    const surface = (body, name) => {
      body.material = surfaceNamed(name);
      return body;
    };
    /**
     * Declare how two named surfaces behave when they touch. Pairs you do not declare, and any contact where one body
     * has no surface, keep the world's default friction and restitution.
     * @param {string} nameA
     * @param {string} nameB May equal nameA.
     * @param {{ friction?: number, restitution?: number }} [options] Each defaults to the world default.
     *   restitution 0 = no bounce, 1 = loses no speed.
     * @example
     * phys.surface(ball, 'ball'); phys.surface(pad, 'bumper');
     * phys.contact('ball', 'bumper', { restitution: 0.85 });   // balls spring off pads, everything else is unchanged
     */
    const contact = (nameA, nameB, { friction = world.defaultContactMaterial.friction, restitution = world.defaultContactMaterial.restitution } = {}) =>
      world.addContactMaterial(new CANNON.ContactMaterial(surfaceNamed(nameA), surfaceNamed(nameB), { friction, restitution }));

    return { world, add, box, sphere, remove, onHit, step, pairs, fixed, floor, bounds, push, blast, wakeWhere, surface, contact };
  };
})();
