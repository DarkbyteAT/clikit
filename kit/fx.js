/**
 * Kit fx: juice.
 *
 * Owns:  short-lived feedback effects - particle bursts (one instanced mesh), shockwave rings,
 *        rectangular frame pulses, glow pops, camera shake, screen flash, floating text, hitstop
 *        and slow motion.
 * Does not own: the frame loop (shell.js calls `update`, `applyShake` and `undoShake`), sound
 *        (sfx.js), post-processing such as bloom (post.js) or lasting scene objects (make.js).
 *
 * Needs the DOM and THREE, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  // ---- tunables ------------------------------------------------------------------------------------------------------

  /** Particle slots in the one instanced mesh. Bursts recycle the oldest slots when all are in use. */
  const MAX_PARTICLES = 900;
  /** Particle fall acceleration (world units / s^2) and upward launch (fraction of speed) for 3D bursts; both 0 for flat ones. */
  const DEFAULT_GRAVITY = 10;
  const DEFAULT_UP_KICK = 0.6;
  // Per-particle random ranges, as multipliers of the burst's speed / life / size, so a burst looks organic.
  const SPEED_JITTER = [0.35, 1];
  const LIFE_JITTER = [0.6, 1.2];
  const SIZE_JITTER = [0.6, 1.4];
  /** Largest tumble rate of a particle, radians over its lifetime per axis. */
  const MAX_SPIN = 8;
  /** The second tumble axis turns a little slower, so the spin does not look like a flat roll. */
  const SPIN_AXIS_RATIO = 0.7;
  /** Fraction of vertical speed kept (reversed) and of horizontal speed kept when a particle hits its floor. */
  const BOUNCE_RESTITUTION = 0.45;
  const BOUNCE_FRICTION = 0.7;
  /** A particle is full size until 1 / 2.2 of its life remains, then shrinks to nothing. */
  const SHRINK_SLOPE = 2.2;

  const RING_SEGMENTS = 40;
  const DEFAULT_RING_WIDTH = 0.18;
  /** A ring starts at this scale (so it is visible on its first frame) and grows by its `size`. */
  const RING_START_SCALE = 0.2;
  /** Lift above the surface, in world units, so a flat effect does not z-fight with the floor. */
  const FLOOR_CLEARANCE = 0.03;

  /** Trauma lost per second: a full shake dies away in about 0.6 s. */
  const TRAUMA_DECAY = 1.6;
  /** Camera offset, in world units, at full trauma. */
  const MAX_SHAKE_OFFSET = 0.7;
  /** Shake along the view depth is halved: it reads as blur rather than impact. */
  const SHAKE_DEPTH_RATIO = 0.5;

  /** Lifetime of floating text; must match the `rise` CSS animation in index.html. */
  const FLOATER_SECONDS = 0.9;
  const MS_PER_SECOND = 1000;

  /**
   * @typedef {{x: number, y: number, z: number}} WorldPoint
   * A position in world units; a THREE.Vector3 fits.
   */

  /**
   * @typedef {Object} BurstOptions
   * @property {number} [count=12] particles
   * @property {number} [color=0xffffff] 0xRRGGBB for every particle
   * @property {number[]} [colors] pick each particle's colour from this list instead
   * @property {number} [bright=1] multiplies the colour; above 1 it passes the bloom threshold and glows
   * @property {number} [speed=4] launch speed, world units / s (each particle gets 35-100% of it)
   * @property {number} [life=0.6] seconds (each particle gets 60-120% of it)
   * @property {number} [size=0.14] cube edge, world units (each particle gets 60-140% of it)
   * @property {number} [gravity] fall acceleration, world units / s^2 (default 10, or 0 when flat)
   * @property {number} [up] extra upward launch as a fraction of speed (default 0.6, or 0 when flat)
   * @property {[number, number, number]} [dir] launch direction; particles fan out around it
   * @property {number} [spread=1] how wide the fan around `dir` is (0 = a jet)
   * @property {number} [floor=-Infinity] height particles bounce on
   * @property {boolean} [flat=false] keep particles in the horizontal plane with no gravity (top-down 2D games)
   */

  /**
   * @typedef {Object} RingOptions
   * @property {number} [color=0xffffff] 0xRRGGBB
   * @property {number} [size=2.5] how much the radius grows, world units
   * @property {number} [life=0.35] seconds
   * @property {number} [y] height to draw at (default: just above pos.y)
   * @property {number} [width=0.18] band thickness as a fraction of the radius (0.04 = a hairline)
   * @property {number} [bright=1] above 1 pushes the colour past the bloom threshold
   * @property {'ground'|'camera'} [facing='ground'] 'ground' lies flat; 'camera' stands the ring up to face
   *   ctx.camera, for side-on and 2D views where a flat ring is seen edge-on and vanishes
   */

  /**
   * @typedef {Object} FloaterOptions
   * @property {boolean} [screen] `pos` is { x, y } in screen pixels instead of a world point
   * @property {string} [color] CSS colour
   * @property {number} [size] font size, pixels
   * @property {boolean} [gameTime] play on the game clock (Kit.scrub), so it freezes with pause and
   *   hitstop and stretches in slow motion
   */

  /**
   * Creates the effects layer for a game. The shell does this and exposes it as `ctx.fx`.
   * @param {Object} ctx the shell context (uses scene, camera, size, make, tween, after, timeScale)
   * @returns {Object} `{ burst(pos, options), ring(pos, options), pop(pos, options), frame(pos, options), shake(amount),
   *   flash(color, ms, strength), floater(text, pos, options), hitstop(ms), slowmo(scale, hold, recover) }` for games,
   *   plus `update(dt)`, `applyShake()`, `undoShake()` and `dispose()` for the shell.
   * @example
   * fx.burst(enemy.position, { count: 20, colors: [0xff5d73, 0xffc145], speed: 6 });
   * fx.ring(player.position, { color: 0x6ea8ff, size: 4 });
   * fx.shake(0.5); fx.hitstop(70); fx.floater('+5', coin.position, { color: '#ffc145' });
   */
  Kit.fx = (ctx) => {
    // The camera is read from ctx on every use, never captured: a game may swap it (ctx.ortho).
    const { scene } = ctx;
    const { rand, clamp, lerp, TAU, ease } = Kit.math;

    /** Marks an object as a kit effect, so the shell's scene disposal and games' own traversals can tell it apart. */
    const markAsEffect = (object) => {
      object.userData.kitFx = true;
      return object;
    };

    /** Scratch colour: an sRGB hex converted to the renderer's linear space and scaled by a brightness. */
    const scratchColor = new THREE.Color();
    const linearColor = (hex, bright) => scratchColor.set(hex).convertSRGBToLinear().multiplyScalar(bright);

    // ---- particles ----

    const particleMesh = markAsEffect(
      new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_PARTICLES)
    );
    // Instances are spread across the world, so the mesh's own bounding sphere says nothing useful.
    particleMesh.frustumCulled = false;
    const scratchTransform = new THREE.Object3D();
    /** A zero-scale matrix: how a dead particle slot is hidden without removing the instance. */
    const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
    const particles = Array.from({ length: MAX_PARTICLES }, (_, slot) => {
      particleMesh.setMatrixAt(slot, HIDDEN_MATRIX);
      particleMesh.setColorAt(slot, scratchColor.set(0xffffff));
      return { life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0.1, gravity: 0, spin: 0, floor: -Infinity };
    });
    scene.add(particleMesh);
    /** Hands out particle slots in a circle and tracks the stretch still in flight, so idle slots cost nothing per frame. */
    const particleSlots = Kit.slotRing(MAX_PARTICLES);

    /**
     * A random unit direction: uniform over the sphere, or over the horizontal circle when flat.
     * (Uniform height plus uniform angle is uniform on a sphere - Archimedes' hat-box theorem.)
     */
    const randomDirection = (isFlat) => {
      const angle = rand(TAU);
      const height = rand(-1, 1);
      const ringRadius = isFlat ? 1 : Math.sqrt(1 - height * height);
      return { x: Math.cos(angle) * ringRadius, y: isFlat ? 0 : height, z: Math.sin(angle) * ringRadius };
    };

    /**
     * Throws out a burst of small cubes.
     * @param {WorldPoint} pos where they start
     * @param {BurstOptions} [options]
     * @complexity O(count) time, O(1) space: particles are written into pre-allocated slots
     */
    function burst(pos, options = {}) {
      const { count = 12, speed = 4, life = 0.6, size = 0.14, spread = 1, dir, floor = -Infinity, flat = false } = options;
      const defaultGravity = flat ? 0 : DEFAULT_GRAVITY;
      const defaultUpKick = flat ? 0 : DEFAULT_UP_KICK;
      const gravity = options.gravity === undefined ? defaultGravity : options.gravity;
      const upKick = options.up === undefined ? defaultUpKick : options.up;
      const bright = options.bright === undefined ? 1 : options.bright;
      const plainColor = options.color === undefined ? 0xffffff : options.color;
      // Hot path: bursts fire many times a second, so this fills pre-allocated slots in a plain loop.
      for (let spawned = 0; spawned < count; spawned++) {
        const slot = particleSlots.claim();
        const particle = particles[slot];
        const scatter = randomDirection(flat);
        // With a direction, the random vector only fans the jet out; without one it is the direction.
        const heading = dir ? { x: dir[0] + scatter.x * spread, y: dir[1] + scatter.y * spread, z: dir[2] + scatter.z * spread } : scatter;
        const launchSpeed = speed * rand(...SPEED_JITTER);
        particle.x = pos.x;
        particle.y = pos.y;
        particle.z = pos.z;
        particle.vx = heading.x * launchSpeed;
        particle.vy = heading.y * launchSpeed + upKick * speed;
        particle.vz = heading.z * launchSpeed;
        particle.life = particle.maxLife = life * rand(...LIFE_JITTER);
        particle.size = size * rand(...SIZE_JITTER);
        particle.gravity = gravity;
        particle.floor = floor;
        particle.spin = rand(-MAX_SPIN, MAX_SPIN);
        const hex = options.colors ? Kit.math.pick(options.colors) : plainColor;
        particleMesh.setColorAt(slot, linearColor(hex, bright));
      }
      particleMesh.instanceColor.needsUpdate = true;
    }

    /** Moves one live particle by `dt` and writes its matrix; hides it when its life runs out. */
    const advanceParticle = (particle, slot, dt) => {
      particle.life -= dt;
      if (particle.life <= 0) {
        particleMesh.setMatrixAt(slot, HIDDEN_MATRIX);
        return;
      }
      particle.vy -= particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      if (particle.y < particle.floor) {
        // Bounce: put it back on the floor, reverse and damp the fall, and scrub off some slide.
        particle.y = particle.floor;
        particle.vy *= -BOUNCE_RESTITUTION;
        particle.vx *= BOUNCE_FRICTION;
        particle.vz *= BOUNCE_FRICTION;
      }
      const lifeLeft = particle.life / particle.maxLife;
      scratchTransform.position.set(particle.x, particle.y, particle.z);
      scratchTransform.rotation.set(particle.spin * lifeLeft, particle.spin * lifeLeft * SPIN_AXIS_RATIO, 0);
      scratchTransform.scale.setScalar(particle.size * Math.min(1, lifeLeft * SHRINK_SLOPE));
      scratchTransform.updateMatrix();
      particleMesh.setMatrixAt(slot, scratchTransform.matrix);
    };

    const isParticleDead = (slot) => particles[slot].life <= 0;

    /**
     * Advances the particles in flight.
     * @complexity O(slots between the oldest live particle and the newest) time per frame, which is 0 when
     *   nothing is in flight and at most MAX_PARTICLES; O(1) space
     */
    const updateParticles = (dt) => {
      let anyAlive = false;
      // Hot path: runs every frame, so it visits only the ring's live window and allocates nothing.
      particleSlots.forEach((slot) => {
        const particle = particles[slot];
        if (particle.life <= 0) return;
        anyAlive = true;
        advanceParticle(particle, slot, dt);
      });
      particleSlots.trim(isParticleDead);
      // Uploading 900 matrices is the costly part, so skip it on frames where nothing moved.
      if (anyAlive) particleMesh.instanceMatrix.needsUpdate = true;
    };

    // ---- rings (flat expanding shockwaves) ----

    /** Live rings: { mesh, elapsed, life, size }. */
    let rings = [];
    const makeRingGeometry = (width) => new THREE.RingGeometry(1 - width, 1, RING_SEGMENTS).rotateX(-Math.PI / 2);
    const ringGeo = makeRingGeometry(DEFAULT_RING_WIDTH);
    /** Turns the ground-plane ring (normal +y) to look along +z; composed with the camera's rotation it faces the viewer. */
    const RING_UPRIGHT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    /** Ring geometries by band width, so every ring of one width shares a buffer (the default width uses ringGeo). */
    const ringGeometriesByWidth = new Map();
    /**
     * The shared geometry of a ring whose band is `width` of its radius thick.
     * @param {number} width band thickness as a fraction of the outer radius, 0..1 (0.18 = the classic shockwave, 0.04 = a hairline)
     * @returns {THREE.RingGeometry}
     */
    const ringGeometryOf = (width) => {
      if (width === DEFAULT_RING_WIDTH) return ringGeo;
      if (!ringGeometriesByWidth.has(width)) ringGeometriesByWidth.set(width, makeRingGeometry(clamp(width)));
      return ringGeometriesByWidth.get(width);
    };

    /**
     * Sends out an expanding, fading shockwave ring.
     * @param {WorldPoint} pos centre
     * @param {RingOptions} [options]
     */
    function ring(pos, options = {}) {
      const { color = 0xffffff, size = 2.5, life = 0.35, y, width = DEFAULT_RING_WIDTH, bright = 1 } = options;
      const material = new THREE.MeshBasicMaterial({
        color: linearColor(color, bright).clone(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const mesh = markAsEffect(new THREE.Mesh(ringGeometryOf(width), material));
      const isFacingCamera = options.facing === 'camera';
      // The lift only exists to clear a floor, so a ring standing up to face the camera does not get it.
      const defaultHeight = isFacingCamera ? pos.y : pos.y + FLOOR_CLEARANCE;
      mesh.position.set(pos.x, y === undefined ? defaultHeight : y, pos.z);
      if (isFacingCamera) mesh.quaternion.copy(ctx.camera.quaternion).multiply(RING_UPRIGHT);
      scene.add(mesh);
      rings.push({ mesh, elapsed: 0, life, size });
    }

    /** Grows and fades one ring; returns false (after removing it) once its life is over. */
    const advanceRing = (activeRing, dt) => {
      activeRing.elapsed += dt;
      const progress = activeRing.elapsed / activeRing.life;
      if (progress >= 1) {
        scene.remove(activeRing.mesh);
        // The geometry is shared; only the per-ring material is ours to free.
        activeRing.mesh.material.dispose();
        return false;
      }
      activeRing.mesh.scale.setScalar(RING_START_SCALE + ease.outCubic(progress) * activeRing.size);
      activeRing.mesh.material.opacity = 1 - progress;
      return true;
    };

    // ---- shake ----

    /** Shake energy, 0..1. Hits add to it (by taking the larger), time drains it. */
    let trauma = 0;
    const shakeOffset = new THREE.Vector3();

    /**
     * Shakes the camera. Calls do not stack: the strongest recent hit wins.
     * @param {number} [amount=0.4] 0..1
     * @returns {number} the trauma now
     */
    const shake = (amount = 0.4) => (trauma = clamp(Math.max(trauma, amount)));

    /**
     * Offsets the camera for this frame's render. The shell calls this just before rendering and
     * `undoShake` just after, so the shake never drifts the camera the game is steering.
     */
    function applyShake() {
      // Trauma squared: small hits barely move the camera while big ones kick hard, and the
      // shake eases out smoothly as trauma drains linearly.
      const reach = trauma * trauma * MAX_SHAKE_OFFSET;
      shakeOffset.set(rand(-reach, reach), rand(-reach, reach), rand(-reach, reach) * SHAKE_DEPTH_RATIO);
      ctx.camera.position.add(shakeOffset);
    }
    const undoShake = () => ctx.camera.position.sub(shakeOffset);

    // ---- flash ----

    const flashElement = document.getElementById('flash');

    /**
     * Flashes the whole screen and fades it out.
     * @param {string} [color='#fff'] CSS colour
     * @param {number} [ms=140] fade time, milliseconds
     * @param {number} [strength=0.5] starting opacity, 0..1
     */
    function flash(color = '#fff', ms = 140, strength = 0.5) {
      if (!flashElement) return;
      // Jump to the flash colour with no transition, force a reflow so the browser commits that
      // state, then transition back to transparent. Without the reflow the two changes merge and nothing shows.
      flashElement.style.transition = 'none';
      flashElement.style.background = color;
      flashElement.style.opacity = strength;
      void flashElement.offsetWidth;
      flashElement.style.transition = `opacity ${ms}ms ease-out`;
      flashElement.style.opacity = 0;
    }

    // ---- time: hitstop and slow motion ----

    /**
     * Freezes the game for a moment (the shell skips game updates while `ctx._freeze` is positive).
     * Overlapping calls keep the longer freeze.
     * @param {number} [ms=60] milliseconds
     * @returns {number} the freeze now pending, seconds
     */
    const hitstop = (ms = 60) => (ctx._freeze = Math.max(ctx._freeze || 0, ms / MS_PER_SECOND));

    /** The slow-motion effect in progress: { scale, hold, recover, elapsed } in real seconds, or null. */
    let slowMotion = null;

    /**
     * Drops game speed, holds it, then eases back to normal. Timed in real seconds.
     * @param {number} [scale=0.3] game speed while held (1 = normal)
     * @param {number} [hold=0.35] seconds at that speed
     * @param {number} [recover=0.4] seconds to ramp back to 1
     */
    const slowmo = (scale = 0.3, hold = 0.35, recover = 0.4) => {
      slowMotion = { scale, hold, recover, elapsed: 0 };
      ctx.timeScale = scale;
    };

    const updateSlowMotion = (realDt) => {
      if (!slowMotion) return;
      slowMotion.elapsed += realDt;
      // Negative during the hold, 0..1 across the recovery.
      const recovery = (slowMotion.elapsed - slowMotion.hold) / slowMotion.recover;
      ctx.timeScale = lerp(slowMotion.scale, 1, clamp(recovery));
      if (recovery >= 1) slowMotion = null;
    };

    // ---- floaters ----

    const floaterLayer = document.getElementById('floaters');
    const scratchPoint = new THREE.Vector3();

    /** Screen pixels of a world point through the current camera, or null when it is beyond the far plane. */
    const projectToScreen = (pos) => {
      scratchPoint.set(pos.x, pos.y, pos.z).project(ctx.camera);
      if (scratchPoint.z > 1) return null;
      return { x: (scratchPoint.x * 0.5 + 0.5) * ctx.size.w, y: (-scratchPoint.y * 0.5 + 0.5) * ctx.size.h };
    };

    /**
     * Shows a short text that rises and fades ("+5", "MISS").
     * @param {string} text
     * @param {WorldPoint | {x: number, y: number}} pos world point, or screen pixels with `options.screen`
     * @param {FloaterOptions} [options]
     */
    function floater(text, pos, options = {}) {
      if (!floaterLayer) return;
      const screenPosition = options.screen ? pos : projectToScreen(pos);
      if (!screenPosition) return;
      const element = document.createElement('div');
      element.className = 'floater';
      element.textContent = text;
      element.style.left = screenPosition.x + 'px';
      element.style.top = screenPosition.y + 'px';
      if (options.color) element.style.color = options.color;
      if (options.size) element.style.fontSize = options.size + 'px';
      floaterLayer.appendChild(element);
      // The CSS animation runs on wall-clock time by default; Kit.scrub drives it from the game clock instead.
      if (options.gameTime) Kit.scrub(ctx.tween, element, FLOATER_SECONDS).then(() => element.remove());
      else setTimeout(() => element.remove(), FLOATER_SECONDS * MS_PER_SECOND);
    }

    // ---- frame loop hook ----

    /**
     * Advances every effect. The shell calls this once per frame with REAL seconds, so effects keep
     * playing through hitstop and slow motion.
     * @param {number} dt seconds
     */
    function update(dt) {
      updateParticles(dt);
      rings = rings.filter((activeRing) => advanceRing(activeRing, dt));
      trauma = Math.max(0, trauma - dt * TRAUMA_DECAY);
      updateSlowMotion(dt);
    }

    /**
     * An expanding, fading rectangular outline lying flat: the square cousin of ring() for box-shaped things (slabs, tiles, cards).
     * It runs on game time through ctx.tween, so pause and hitstop freeze it with everything else.
     * @param {{ x: number, y: number, z: number }} pos centre in world units (drawn just above pos.y)
     * @param {{ width?: number, depth?: number, color?: number, grow?: number, life?: number, delay?: number, bright?: number, thickness?: number }} [o]
     *   width / depth: starting footprint in world units (depth defaults to width); grow: how much larger it ends, as a fraction (0.4 = +40%);
     *   life / delay: seconds; color: 0xRRGGBB; bright > 1 blooms; thickness: border as a fraction of the side (see make.frame)
     * @example
     * fx.frame(slabTop, { width: 4, depth: 3, color: 0x9fe8ff, bright: 2.4 });
     */
    function frame(pos, o = {}) {
      const { width = 1, depth = width, color = 0xffffff, grow = 0.4, life = 0.5, delay = 0, bright = 1, thickness } = o;
      const outline = ctx.make.frame(color, { bright, thickness, opacity: 0, at: [pos.x, pos.y + 0.03, pos.z] });
      outline.userData.kitFx = true;
      // The tween drives one number; this setter turns it into size and opacity, so the pulse needs no per-frame hook of its own.
      const pulse = {
        elapsed: 0,
        get progress() {
          return this.elapsed;
        },
        set progress(k) {
          this.elapsed = k;
          const size = 1 + grow * Kit.math.ease.outCubic(k);
          outline.scale.set(width * size, 1, depth * size);
          outline.material.opacity = 1 - k;
        },
      };
      const play = () =>
        ctx.tween(pulse, { progress: 1 }, life, 'linear').then(() => {
          scene.remove(outline);
          outline.material.dispose();
        });
      if (delay > 0) ctx.after(delay, play);
      else play();
    }

    /** Pooled glow sprites behind pop(); created on first use so games that never pop pay nothing. */
    let popSprites = null;
    /** How small a pop starts, as a fraction of its final size: it swells from a hot point, it does not blink on at full size. */
    const POP_START_SCALE = 0.3;
    /**
     * A soft additive flash that swells and fades: the bloom-friendly "pop" of a kill, a pickup or a muzzle. Sprites are pooled,
     * and it runs on game time through ctx.tween, so pause and hitstop freeze it with everything else.
     * @param {{ x: number, y: number, z: number }} pos centre in world units
     * @param {{ color?: number, size?: number, life?: number, bright?: number, opacity?: number }} [o]
     *   color: 0xRRGGBB; size: final diameter in world units; life: seconds; bright > 1 blooms (default 1.5); opacity: starting alpha 0..1
     * @example
     * fx.pop(enemy.position, { color: 0xff5d73, size: 3 });
     */
    function pop(pos, o = {}) {
      const { color = 0xffffff, size = 2, life = 0.22, bright = 1.5, opacity = 0.7 } = o;
      if (!popSprites) {
        popSprites = Kit.pool(() => {
          // Not depth-tested: a flash at floor level would otherwise be cut in half by the floor.
          const fresh = ctx.make.glow(0xffffff, 1, { depthTest: false });
          fresh.userData.kitFx = true;
          return fresh;
        });
      }
      const sprite = popSprites.get();
      sprite.position.set(pos.x, pos.y, pos.z);
      sprite.scale.setScalar(size * POP_START_SCALE);
      sprite.material.color.set(color).convertSRGBToLinear().multiplyScalar(bright);
      sprite.material.opacity = opacity;
      ctx.tween(sprite.scale, { x: size, y: size }, life);
      ctx.tween(sprite.material, { opacity: 0 }, life, 'inCubic').then(() => popSprites.release(sprite));
    }

    /** Clears floating text when the game is left (the scene's meshes are disposed by the shell). */
    const dispose = () => {
      if (floaterLayer) floaterLayer.textContent = '';
    };

    return { burst, ring, pop, frame, shake, flash, floater, hitstop, slowmo, update, applyShake, undoShake, dispose };
  };
})();
