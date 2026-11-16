// Kit bodies: the pieces Kit.physics (kit/physics.js) needs for built contraptions and 2D-in-3D games. Each helper takes
// the `phys` object that Kit.physics() returns, so it composes with everything already there.
//
//   compound   - one static or kinematic body from several rotated boxes and discs:   Kit.physics.compound(phys, mesh, shapes, { at, angle })
//   stepRules  - per-body rules enforced after every physics step:                    Kit.physics.stepRules(phys, [keepInPlane('z'), limitSpeed(14)])
//   keepInPlane / limitSpeed - the two rules a flat marble, pinball or platform game needs
//   layers     - named collision groups:                                              layers.assign(body, 'marble', ['part'])
//   sensor     - a body that reports contacts but pushes nothing (triggers, portals, boost pads)
//   surfaces   - named materials with their own bounce and grip against the scenery:    surfaces.assign(ballBody, 'rubber')
//   retire     - remove a body safely, even from inside a collision callback
//
// Owns: body construction beyond a single axis-aligned box, planar and speed constraints, contact filtering and safe removal.
// Does not own: the world, stepping or mesh sync (kit/physics.js), or what a contact means (the game's onHit handlers).
// Needs the CANNON global (cannon.js 0.6.2). Unit-tested against real cannon in tools/test-kit.js.
(() => {
  const AXES = ['x', 'y', 'z'];
  /** cannon.js collision groups are bits of a 32-bit integer; the sign bit is left alone. */
  const MAX_LAYERS = 31;

  /**
   * @typedef {Object} CompoundShape  One collider of a compound body, in the body's own frame.
   * @property {number[]} [box]     full size [width, height, depth] in world units. Give either `box` or `disc`.
   * @property {number} [disc]      radius of a round collider (a sphere: in a planar game it behaves as a disc).
   * @property {number[]} [at]      offset [x, y, z] from the body origin; defaults to the origin.
   * @property {number} [angle]     rotation in radians about the body's turn axis; defaults to 0.
   */

  const axisVector = (axis) => new CANNON.Vec3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const axisRotation = (axis, angle) => {
    const rotation = new CANNON.Quaternion();
    rotation.setFromAxisAngle(axisVector(axis), angle); // returns nothing in cannon.js 0.6.2, so it cannot be chained
    return rotation;
  };
  const toShape = (spec) => {
    if (spec.box) return new CANNON.Box(new CANNON.Vec3(spec.box[0] / 2, spec.box[1] / 2, spec.box[2] / 2));
    if (spec.disc) return new CANNON.Sphere(spec.disc);
    throw new Error('Kit.physics.compound: a shape needs `box: [w, h, d]` or `disc: radius`, got ' + JSON.stringify(spec));
  };

  /**
   * Add an immovable body built from several colliders, optionally rotated, optionally spinning. Ramps, funnels,
   * paddles, pegs: anything a dynamic body should bounce off but never push.
   * @param {Object} phys the object returned by Kit.physics().
   * @param {THREE.Object3D|null} mesh kept in sync with the body (position and rotation), or null for an invisible collider.
   * @param {CompoundShape[]} shapes the colliders.
   * @param {Object} [options]
   * @param {number[]} [options.at=[0,0,0]] world position [x, y, z] of the body origin.
   * @param {number} [options.angle=0] rotation in radians about `axis`.
   * @param {'x'|'y'|'z'} [options.axis='z'] the turn axis for `angle`, `spin` and each shape's own angle.
   * @param {number} [options.spin=0] radians per second about `axis`. Non-zero makes the body kinematic: it turns
   *        for ever and shoves dynamic bodies, but nothing can slow it.
   * @returns {CANNON.Body}
   * @example
   * // A funnel: two planks leaning toward each other, tilted as a whole by 10 degrees.
   * Kit.physics.compound(phys, funnelMesh, [
   *   { box: [1, 0.2, 0.5], at: [-0.6, 0, 0], angle: -0.7 },
   *   { box: [1, 0.2, 0.5], at: [0.6, 0, 0], angle: 0.7 },
   * ], { at: [0, 4, 0], angle: 0.17 });
   */
  const compound = (phys, mesh, shapes, { at = [0, 0, 0], angle = 0, axis = 'z', spin = 0 } = {}) => {
    const body = new CANNON.Body({ mass: 0, type: spin ? CANNON.Body.KINEMATIC : CANNON.Body.STATIC, position: new CANNON.Vec3(at[0], at[1], at[2]) });
    shapes.forEach((spec) => body.addShape(toShape(spec), new CANNON.Vec3(...(spec.at || [0, 0, 0])), axisRotation(axis, spec.angle || 0)));
    body.quaternion.copy(axisRotation(axis, angle));
    body.angularVelocity[axis] = spin;
    return phys.add(mesh, body);
  };

  /**
   * A step rule that pins a body to the plane it was in when the rule first saw it: no drift along `axis`, and
   * rotation only about `axis`. cannon.js 0.6.2 has no linearFactor / angularFactor, so this is how a 3D world plays 2D.
   * @param {'x'|'y'|'z'} [axis='z'] the plane's normal.
   * @returns {(body: CANNON.Body) => void}
   */
  const keepInPlane = (axis = 'z') => {
    const homes = new WeakMap();
    const inPlaneAxes = AXES.filter((name) => name !== axis);
    return (body) => {
      if (!homes.has(body)) homes.set(body, body.position[axis]);
      body.position[axis] = homes.get(body);
      body.velocity[axis] = 0;
      inPlaneAxes.forEach((name) => (body.angularVelocity[name] = 0));
    };
  };

  /**
   * A step rule that caps linear speed. Keeping a body's travel per step below the thickness of the thinnest
   * collider it can meet is what stops it tunnelling: at 60 Hz, maxSpeed must be under 60 x that thickness.
   * @param {number} maxSpeed world units per second.
   * @returns {(body: CANNON.Body) => void}
   */
  const limitSpeed = (maxSpeed) => (body) => {
    const speed = body.velocity.norm();
    if (speed > maxSpeed) body.velocity.scale(maxSpeed / speed, body.velocity);
  };

  /**
   * Enforce rules on a set of bodies after every physics step (a frame may run several steps, so doing this from the
   * game's update would let a body break the rule in between). Bodies that have left the world are forgotten.
   * @param {Object} phys the object returned by Kit.physics().
   * @param {Array<(body: CANNON.Body) => void>} rules for example [Kit.physics.keepInPlane('z'), Kit.physics.limitSpeed(14)].
   * @returns {{ add: (body: CANNON.Body) => CANNON.Body, remove: (body: CANNON.Body) => void, size: () => number }}
   * @complexity O(bodies x rules) per physics step; O(bodies) memory.
   */
  const stepRules = (phys, rules) => {
    const bodies = new Set();
    const applyAll = (body) => rules.forEach((rule) => rule(body));
    phys.world.addEventListener('postStep', () =>
      // Measured hot path (every body, every step): one Set walk, pruning as it goes.
      bodies.forEach((body) => (body.world === phys.world ? applyAll(body) : bodies.delete(body)))
    );
    return {
      add(body) {
        bodies.add(body);
        applyAll(body); // records the home plane and clamps before the first step
        return body;
      },
      remove: (body) => bodies.delete(body),
      size: () => bodies.size,
    };
  };

  /**
   * Named collision layers. A body collides with another only when each one's layer is in the other's `collidesWith`.
   * @param {string[]} names up to 31 layer names.
   * @returns {{ bit: (name: string) => number, mask: (names: string[]) => number,
   *            assign: (body: CANNON.Body, layer: string, collidesWith: string[]) => CANNON.Body }}
   * @example
   * const layers = Kit.physics.layers(['marble', 'part']);
   * layers.assign(marbleBody, 'marble', ['part']);   // marbles pass through each other
   * layers.assign(rampBody, 'part', ['marble']);
   */
  const layers = (names) => {
    if (names.length > MAX_LAYERS) throw new Error(`Kit.physics.layers: ${names.length} layers asked for, cannon.js supports ${MAX_LAYERS}`);
    const bit = (name) => {
      const index = names.indexOf(name);
      if (index < 0) throw new Error(`Kit.physics.layers: no layer "${name}" (known: ${names.join(', ')})`);
      return 1 << index;
    };
    const mask = (layerNames) => layerNames.reduce((bits, name) => bits | bit(name), 0);
    const assign = (body, layer, collidesWith) => {
      body.collisionFilterGroup = bit(layer);
      body.collisionFilterMask = mask(collidesWith);
      return body;
    };
    return { bit, mask, assign };
  };

  /**
   * Turn a body into a sensor: it still raises `collide` events (phys.onHit) when something enters it, but applies
   * no force. Trigger zones, portals, boost pads, goal lines.
   * @param {CANNON.Body} body
   * @returns {CANNON.Body} the same body.
   */
  const sensor = (body) => {
    body.collisionResponse = false;
    return body;
  };

  /**
   * Remove a body safely from anywhere, including inside a phys.onHit handler or a step rule. cannon.js walks its
   * body list with a cached length during a step, so removing mid-step (even from its postStep event) crashes it.
   * The body stops colliding at once; it leaves the world, and its mesh pairing, in a microtask, which runs as soon as
   * the current frame's code has returned and therefore never inside a step.
   * @param {Object} phys the object returned by Kit.physics().
   * @param {CANNON.Body} body
   * @returns {Promise<void>} resolves once the body is out of the world (tests await it; games can ignore it).
   */
  const retire = (phys, body) => {
    body.collisionFilterMask = 0;
    return Promise.resolve().then(() => phys.remove(body));
  };

  /**
   * @typedef {Object} SurfaceRow  How one kind of moving thing meets the scenery.
   * @property {number} friction     0 = ice, 1 = sandpaper.
   * @property {number} restitution  0 = dead stop, 1 = keeps all its bounce.
   */

  /**
   * Named surfaces: give bodies of different kinds (glass, steel, rubber balls) their own bounce and grip against the
   * scenery, instead of the one world-wide default. Bodies with no surface keep the world default.
   * @param {Object} phys the object returned by Kit.physics().
   * @param {Object<string, SurfaceRow>} rows one row per kind of moving thing.
   * @returns {{ scenery: (body: CANNON.Body) => CANNON.Body, assign: (body: CANNON.Body, name: string) => CANNON.Body }}
   *   `scenery(body)` marks what the named things bounce off (floors, ramps, pegs); `assign(body, name)` gives a body its surface.
   * @example
   * const surfaces = Kit.physics.surfaces(phys, { rubber: { friction: 0.6, restitution: 0.8 }, steel: { friction: 0.2, restitution: 0.1 } });
   * surfaces.scenery(floorBody);
   * surfaces.assign(ballBody, 'rubber');
   * @complexity O(rows) contact materials created once; each contact then costs one table lookup inside cannon.
   */
  const surfaces = (phys, rows) => {
    const sceneryMaterial = new CANNON.Material('scenery');
    const materials = Object.keys(rows).reduce((byName, name) => {
      byName[name] = new CANNON.Material(name);
      phys.world.addContactMaterial(new CANNON.ContactMaterial(byName[name], sceneryMaterial, { friction: rows[name].friction, restitution: rows[name].restitution }));
      return byName;
    }, {});
    const withMaterial = (body, material) => {
      body.material = material;
      return body;
    };
    return {
      scenery: (body) => withMaterial(body, sceneryMaterial),
      assign(body, name) {
        if (!materials[name]) throw new Error(`Kit.physics.surfaces: no surface "${name}" (known: ${Object.keys(materials).join(', ')})`);
        return withMaterial(body, materials[name]);
      },
    };
  };

  Object.assign(Kit.physics, { compound, stepRules, keepInPlane, limitSpeed, layers, sensor, retire, surfaces });
})();
