/**
 * Sky Stack: one-tap precision stacking in true isometric 2.5D (orthographic camera on the (1, 1, 1) diagonal).
 *
 * Owns: how the game looks, sounds and is operated - the tower, debris, sky, camera and HUD views, the feel tables, the theme,
 *       and the glue that plays one run by handing every tap to the rules.
 * Does not own: the rules and their tables (games/stack-rules.js, where the depth plan is written down), interval slicing
 *       (Kit.span), row blending (Kit.blend), outline pulses and markers (fx.frame, make.frame), scrolling dot fields (make.dots),
 *       modifiers / blueprints / profile / phases as models (Kit.stats, Kit.upgrades, Kit.profile, Kit.fsm).
 *
 * Layout of this file: presentation tables, small helpers, views (THREE and DOM), the theme, then Kit.register.
 */
(() => {
  const {
    SLAB, SLIDE, STREAK, BASE_MODIFIERS, SLAB_KINDS, BLUEPRINTS, BLUEPRINTS_OFFERED, CHARTERS, ZONES, PALETTE, AXES,
    multiplierAt, lookAt, zoneIndexAt, createModifierStats, readModifiers, kindForFloor, createBaseFloor, createSlider, stepSlider, rewindSlider,
    isLinedUp, createTally, settleDrop, applyBlueprintPick, createProfile, isAvailableTo, charterFor, recordRun, upcomingUnlocks,
  } = Kit.skyStack;

  // ================================================== PRESENTATION TABLES ==================================================

  /** Feel of a landing and a perfect drop. Durations in seconds, glows as emissive intensity. */
  const FEEL = {
    SQUASH: { WIDEN: 1.07, FLATTEN: 0.45, SECS: 0.36 }, // the slab lands wide and flat, then springs back
    THUD_PITCH: { SMALL: 1.5, FULL: 0.85 }, // bigger slabs thud deeper
    DUST: { count: 2, spread: 0.7, speed: 1.6, gravity: 2.5, life: 0.45, size: 0.1 }, // per edge of the landed slab
    DUST_PUSH: 1.4, // outward speed bias of the dust
    DUST_LIFT: 0.25, // upward bias, so it puffs rather than sprays
    DUST_WHITEN: 0.75,
    CAMERA_DIP: 0.28, // units the camera drops on a landing before easing back
    SLIDER_GLOW: 0.08,
    CUE_GLOW: 0.55, // added while the slab is inside the perfect window, scaled by the difficulty cue
    TOP_GLOW: 0.1, // resting glow of the newest floor
    TOP_GLOW_SETTLE_SECS: 0.55,
    PERFECT_GLOW: { BASE: 0.3, PER_LEVEL: 0.05 },
    RIM: { REST: 0.3, FLARE: 0.5, FLARE_PER_LEVEL: 0.05, FADE_RATE: 4, BRIGHT: 1.6, BRACED_REST: 0.6, BRACED_COLOR: 0xffa62e }, // a deeper gold than the HUD's: at this brightness a pale one reads as white
    PULSE: { GAP_SECS: 0.1, GROW: 0.35, GROW_STEP: 0.3, LIFE_SECS: 0.55, BRIGHT: 2.4, WHITEN: 0.5 },
    CELEBRATION: { CAP: 10, PULSES_EVERY: 3, MAX_EXTRA_PULSES: 2 }, // pitch, glow and pulses escalate with the streak up to CAP; one more pulse per PULSES_EVERY
    CHIME_SCALE: [0, 2, 4, 7, 9], // pentatonic steps in semitones: any order of notes sounds consonant
    STREAK_TONE: { freq: 1176, dur: 0.3, type: 'sine', vol: 0.08, delay: 0.1 }, // a soft fifth above the chime once the streak starts paying out
    BRACE_PULSE_GROW: -0.25, // the gold outline closes inward: the slab is being pulled back
    BEST_MARKER: { MARGIN: 2.4, OPACITY: 0.55 },
    OVERLAY_LIFT: 0.02, // outlines sit this far above a surface so they never z-fight with it
    CUT_FLASH: { THICKNESS: 0.08, MARGIN: 0.06, SECS: 0.3, BRIGHT: 2.5 },
    CHUNK: { GRAVITY: 20, PUSH: [1.2, 2.2], SPIN: [2.5, 4.5], HOP: 0.5, LIFE_SECS: 1.7, FADE_SECS: 0.5, WHITEN: 0.18 },
    SHATTER: { count: 22, speed: 4.5, life: 0.7, gravity: 9, size: 0.13 },
    TERRACE_BURST: { count: 36, speed: 5, life: 0.9, gravity: 5, size: 0.15 },
    GAME_OVER: { SLOWMO: [0.4, 0.2, 0.5], ZOOM_SECS: 1.3, BANNER_DELAY_SECS: 2.1, FILL: 0.6, PADDING: 6, MIN_ZOOM: 0.1 },
  };

  /** Isometric camera: fixed constants of the (1, 1, 1) view and how the rig rides the tower. */
  const CAMERA = {
    OFFSET: 35, // distance along each axis from the look-at point
    HEIGHT_ON_SCREEN: 0.816, // cos(35.264 deg): screen units per world unit of height
    DEPTH_RISE: 0.577, // sin(35.264 deg): screen rise per unit moved along the view diagonal on the ground
    SPAN: { PORTRAIT: 16, LANDSCAPE_PER_ASPECT: 20 }, // visible world width
    RIDE: { PORTRAIT: 0.1, LANDSCAPE: -0.14 }, // tower top sits this fraction of the view height above centre (below it in landscape, where the HUD fills the top third)
    FOLLOW_RATE: 3,
    CLIMB_RATE: 3.5,
    OVERVIEW_RATE: 2.5,
    DIP_RECOVER_RATE: 9,
  };

  /** Tower bookkeeping: the newest floors are real meshes, older ones live in one instanced mesh used as a ring buffer. */
  const TOWER = { LIVE_FLOORS: 6, RING_SIZE: 160, SLAB_ROUGHNESS: 0.45, PEDESTAL_DEPTH: 80, PEDESTAL_MARGIN: 1, LIP_MARGIN: 1.6, LIP_HEIGHT: 0.4, PEDESTAL_COLOR: 0x454a92, LIP_COLOR: 0x8d93dc };

  /** Scenery. Sky layers live in a camera-aligned group SKY.HEIGHT tall that wraps as the tower climbs. */
  const SKY = {
    HEIGHT: 48, // wrap period of every scrolling layer, taller than the tallest view
    DESIGN_HALF_WIDTH: 9, // layers are authored for a view this wide and stretched for wider ones
    ALTITUDE_RATE: 3, // how quickly the look follows the tower top
    VISIBLE_ABOVE: 0.02, // layers fainter than this are hidden outright instead of drawn nearly transparent
    CLOUDS: { COUNT: 11, SIZE: [6, 11], DEPTH: [14, 45], DRIFT: [0.15, 0.5], HALF_WIDTH: 13, WRAP_AT: 17, PARALLAX: [0.9, 0.4], OPACITY: 0.92, TINT: 0.25 },
    STARS: { count: 170, depth: [46, 70], color: 0xffffff, size: 2.2, bright: 1.8, parallax: 0.25, twinkle: { rate: 2.3, amount: 0.4 } },
    MOTES: { count: 60, depth: [-18, 12], color: 0xffe3a0, size: 3.2, bright: 1, parallax: 1.1, driftPerSec: 0.6 },
    // MOON.Y is [hidden, risen]: the moon climbs in from below the frame as its zone blends in, so it is never a half-faded disc.
    MOON: { RADIUS: 1.3, COLOR: 0xfff2cf, BRIGHT: 1.05, X: 5.2, Y: [-20, 10.5], DEPTH: 62, GLOW_COLOR: 0xaec4ff, GLOW_SIZE: 7, GLOW_OPACITY: 0.35 },
    AURORA: {
      WIDTH: 34, HEIGHT: 9, SEGMENTS: 34, DEPTH: 58, TILT: 0.12, OPACITY: 0.3, BRIGHT: 1.2,
      RIBBONS: [{ color: 0x4dffb0, y: 9, phase: 0 }, { color: 0x45d6ff, y: 5, phase: 2 }, { color: 0xb07cff, y: 12, phase: 4 }],
      // Two travelling sines of different wavelength and direction ripple each ribbon: perColumn = radians per segment, perSec = radians per second.
      WAVES: [{ perColumn: 0.33, perSec: 0.6, height: 1.4 }, { perColumn: 0.12, perSec: -0.35, height: 0.9 }],
      HEM_SWAY: 0.6, // the lower hem moves this fraction as far, so the curtain appears to hang
    },
  };

  /** The city far below: world-fixed blocks, so it sinks away as the tower climbs. Positions are authored in screen terms. */
  const CITY = {
    COUNT: 18,
    FRONT_EVERY: 6, // every sixth block stands in front of the tower, low in the frame
    SIDEWAYS: 14, // half-width of the spread across the screen
    BACK: { DEPTH: [7, 32], ROOF: [-13, 2], ROOF_NEAR_TOWER: -3, NEAR_TOWER: 5 }, // blocks behind the tower stay low near its centre line
    FRONT: { DEPTH: [7, 13], ROOF: [-15, -9] },
    SIZE: [3, 5.5],
    BLOCK_DEPTH: 70, // how far each block extends downward, well below the frame
    TINTS: [0x34346e, 0x443a7c, 0x2c3a72],
    FACE_SHADE: [0.85, 0.3, 1.15, 0.3, 0.55, 0.3], // baked light per box face (+x -x +y -y +z -z): no lighting cost
    WINDOWS: { EACH: 7, COLOR: 0xffc66e, BRIGHT: 2.6, WIDTH: 0.34, HEIGHT: 0.5, THICKNESS: 0.06, INSET: 0.4, DROP: [0.7, 12] },
  };

  /** HUD: copy and the altitude gauge. */
  const HUD = {
    HINT: 'Tap when the slab lines up',
    GAUGE_FLOORS: 40, // the gauge spans floors 0..this; the marker rests at the top beyond it
    TOAST_MS: 1600,
  };

  /** Floating notes above the tower top. lift: world units above it, so several notes from one drop stack instead of overlapping; size in px. */
  const NOTES = {
    perfect: { lift: 0.6, color: '#ffffff', size: 21 },
    landed: { lift: 0.6, color: '#c8d4ff', size: 15 },
    shattered: { lift: 1.2, color: '#c8d4ff', size: 15 },
    braced: { lift: 1.4, color: '#ffd27a', size: 21 },
    regrow: { lift: 1.6, color: '#9fe8ff', size: 15 },
    kindAppears: { lift: 2.2, color: '#9fe8ff', size: 15 },
    braceEarned: { lift: 2.4, color: '#ffd27a', size: 15 },
    newBest: { lift: 3.2, color: '#ffd27a', size: 21 },
  };

  /** Sounds per event: [kit preset, { pitch, vol }] pairs played together. Landing thuds and perfect chimes are pitched in code (see FEEL). */
  const SOUNDS = {
    kindAppears: [['tap', { pitch: 1.4, vol: 0.5 }]],
    zoneChange: [['up', { pitch: 0.75, vol: 0.7 }], ['whoosh', { pitch: 0.6 }]],
    slice: [['hit', { pitch: 1.5, vol: 0.5 }], ['whoosh', { vol: 0.6 }]],
    milestone: [['win', {}]],
    newBest: [['coin', {}]],
    shatter: [['hit', { pitch: 2.2, vol: 0.6 }], ['coin', { pitch: 1.8, vol: 0.35 }]],
    brace: [['whoosh', { pitch: 1.3 }], ['up', { pitch: 0.6, vol: 0.5 }]],
    gameOver: [['lose', {}]],
  };

  /** Lighting, fog and post-processing of the scene (make.stage and ctx.post arguments). */
  const STAGE = {
    FOG: [62, 135], // near / far in world units: the city fades out, the tower never does
    SUN: [7, 15, 4],
    SHADOW_HALF_EXTENT: 12,
    BLOOM: [0.3, 0.5, 1], // strength, radius, threshold: a soft halo on the few HDR things (pulses, rim, stars, windows) only
  };

  // ================================================== HELPERS ==================================================

  /**
   * Plays every sound of a SOUNDS row.
   * @param {{ play(preset: string, options: Object): void }} sfx ctx.sfx
   * @param {string} event key of SOUNDS
   */
  const playSounds = (sfx, event) => SOUNDS[event].forEach(([preset, options]) => sfx.play(preset, options));

  /**
   * Chime pitch for the n-th perfect in a row: climbs the pentatonic scale, an octave per five steps.
   * @param {number} step 0-based
   * @returns {number} playback rate (1 = base pitch)
   */
  const chimePitch = (step) => Math.pow(2, (FEEL.CHIME_SCALE[step % FEEL.CHIME_SCALE.length] + 12 * Math.floor(step / FEEL.CHIME_SCALE.length)) / 12);

  /**
   * Where the city blocks stand, authored in screen terms and converted to world space for the fixed isometric view.
   * @param {(min: number, max: number) => number} random uniform random in [min, max)
   * @returns {{ x: number, z: number, roofY: number, size: number }[]}
   */
  function layOutCity(random) {
    return Array.from({ length: CITY.COUNT }, (_, index) => {
      const isFront = index % CITY.FRONT_EVERY === CITY.FRONT_EVERY - 1;
      const sideways = random(-CITY.SIDEWAYS, CITY.SIDEWAYS);
      // depth runs along the view diagonal: positive is toward the camera, negative behind the tower.
      const depth = isFront ? random(...CITY.FRONT.DEPTH) : -random(...CITY.BACK.DEPTH);
      const backRoofMax = Math.abs(sideways) < CITY.BACK.NEAR_TOWER ? CITY.BACK.ROOF_NEAR_TOWER : CITY.BACK.ROOF[1];
      const roofOnScreen = isFront ? random(...CITY.FRONT.ROOF) : random(CITY.BACK.ROOF[0], backRoofMax);
      return {
        x: (depth + sideways) * Math.SQRT1_2,
        z: (depth - sideways) * Math.SQRT1_2,
        // Moving toward the camera lowers a point on screen, so the roof is raised to land at the authored screen height.
        roofY: (roofOnScreen + depth * CAMERA.DEPTH_RISE) / CAMERA.HEIGHT_ON_SCREEN,
        size: random(...CITY.SIZE),
      };
    });
  }

  // ================================================== VIEWS ==================================================

  /**
   * The isometric camera rig: rides the tower top, dips on landings and pulls back to frame the whole tower at the end.
   * @param {Object} ctx game context
   * @returns {{ camera: Object, target: Object, dip(): void, snapTo(focus: Object, topY: number): void,
   *   follow(dt: number, focus: { x: number, z: number }, topY: number): void, overview(dt: number, focus: Object, lowY: number, topY: number): void,
   *   frameTower(lowY: number, topY: number): void }}
   */
  function createCameraRig(ctx) {
    const { math } = ctx;
    const camera = ctx.ortho((size) => (size.portrait ? CAMERA.SPAN.PORTRAIT : CAMERA.SPAN.LANDSCAPE_PER_ASPECT * size.aspect), 'width');
    const target = new ctx.THREE.Vector3();
    let dipOffset = 0, appliedZoom = camera.zoom;
    const viewHeight = () => camera.top - camera.bottom; // world units before zoom
    /** Look-at height that puts `topY` above the screen centre, clear of the bottom HUD. */
    const rideHeight = (topY) => topY - (viewHeight() * (ctx.size.portrait ? CAMERA.RIDE.PORTRAIT : CAMERA.RIDE.LANDSCAPE)) / CAMERA.HEIGHT_ON_SCREEN;
    function place(dt) {
      dipOffset = math.damp(dipOffset, 0, CAMERA.DIP_RECOVER_RATE, dt);
      camera.position.set(target.x + CAMERA.OFFSET, target.y + dipOffset + CAMERA.OFFSET, target.z + CAMERA.OFFSET);
      camera.lookAt(target.x, target.y + dipOffset, target.z);
      // A tween changes camera.zoom behind our back; the projection only needs rebuilding when it actually moved.
      if (camera.zoom !== appliedZoom) {
        camera.updateProjectionMatrix();
        appliedZoom = camera.zoom;
      }
    }
    function moveToward(dt, x, y, z, heightRate) {
      target.x = math.damp(target.x, x, CAMERA.FOLLOW_RATE, dt);
      target.z = math.damp(target.z, z, CAMERA.FOLLOW_RATE, dt);
      target.y = math.damp(target.y, y, heightRate, dt);
      place(dt);
    }
    return {
      camera,
      target,
      dip: () => (dipOffset = -FEEL.CAMERA_DIP),
      snapTo(focus, topY) {
        target.set(focus.x, rideHeight(topY), focus.z);
        place(0);
      },
      follow: (dt, focus, topY) => moveToward(dt, focus.x, rideHeight(topY), focus.z, CAMERA.CLIMB_RATE),
      // Half way between the tower top and its axis keeps a leaning tower inside the frame.
      overview: (dt, focus, lowY, topY) => moveToward(dt, focus.x / 2, (lowY + topY) / 2, focus.z / 2, CAMERA.OVERVIEW_RATE),
      frameTower(lowY, topY) {
        const towerOnScreen = (topY - lowY + FEEL.GAME_OVER.PADDING) * CAMERA.HEIGHT_ON_SCREEN;
        const zoom = math.clamp((viewHeight() * FEEL.GAME_OVER.FILL) / towerOnScreen, FEEL.GAME_OVER.MIN_ZOOM, 1);
        ctx.tween(camera, { zoom }, FEEL.GAME_OVER.ZOOM_SECS, 'inOutQuad');
      },
    };
  }

  /**
   * The tower: pooled slab meshes for the floors still in play, one instanced ring buffer for everything below (so a long run
   * never grows the scene) and the rooftop pedestal, which rises under the lowest floor still shown once the ring wraps.
   * @param {Object} ctx game context
   * @param {number} ringSize floors the ring buffer holds
   * @complexity bake: O(1) time per landed floor. Memory: O(ringSize) instances plus TOWER.LIVE_FLOORS pooled meshes, however long the run.
   * @returns {{ show(slab: Footprint & { y: number, color: number, kind: SlabKind }): Object, fit(mesh: Object, footprint: Footprint): void,
   *   paint(mesh: Object, color: number): void, release(mesh: Object): void, bake(floor: Floor): void, lowestY(): number, liveCount(): number }}
   */
  function createTowerView(ctx, ringSize) {
    const { make, THREE } = ctx;
    const slabGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); // origin on the bottom face, so scale.y squashes downward
    const slabMaterial = () => make.mat(PALETTE.WHITE, { fresh: true, rough: TOWER.SLAB_ROUGHNESS });
    const paint = (mesh, color) => {
      mesh.material.color.copy(make.color(color));
      mesh.material.emissive.copy(mesh.material.color); // slabs glow in their own colour; intensity is animated elsewhere
    };
    const slabs = ctx.pool(() => make.mesh(slabGeometry, slabMaterial()), (mesh, color, kind) => {
      mesh.visible = true;
      paint(mesh, color);
      Object.assign(mesh.material, { emissiveIntensity: 0, opacity: kind.opacity, transparent: kind.opacity < 1 });
    });
    const fit = (mesh, footprint) => {
      mesh.position.x = footprint.centerX;
      mesh.position.z = footprint.centerZ;
      mesh.scale.set(footprint.sizeX, SLAB.HEIGHT, footprint.sizeZ);
    };

    const ring = make.instanced(slabGeometry, slabMaterial(), ringSize, { shadow: true });
    const ringFloors = new Array(ringSize).fill(null); // plain data mirror of the ring, used to find the lowest floor still shown
    const transform = new THREE.Object3D();
    let lowestShownY = 0;

    const pedestal = make.group();
    const column = make.mesh(slabGeometry, TOWER.PEDESTAL_COLOR, { rough: 0.85, parent: pedestal, at: [0, -TOWER.PEDESTAL_DEPTH - TOWER.LIP_HEIGHT, 0] });
    column.scale.set(BASE_MODIFIERS.baseWidth + TOWER.PEDESTAL_MARGIN, TOWER.PEDESTAL_DEPTH, BASE_MODIFIERS.baseWidth + TOWER.PEDESTAL_MARGIN);
    const lip = make.mesh(slabGeometry, TOWER.LIP_COLOR, { rough: 0.6, parent: pedestal, at: [0, -TOWER.LIP_HEIGHT, 0] });
    lip.scale.set(BASE_MODIFIERS.baseWidth + TOWER.LIP_MARGIN, TOWER.LIP_HEIGHT, BASE_MODIFIERS.baseWidth + TOWER.LIP_MARGIN);

    return {
      fit,
      paint,
      show(slab) {
        const mesh = slabs.get(slab.color, slab.kind);
        mesh.position.y = slab.y;
        fit(mesh, slab);
        return mesh;
      },
      release: (mesh) => slabs.release(mesh),
      bake(floor) {
        const slot = floor.index % ringSize;
        transform.position.set(floor.centerX, floor.y, floor.centerZ);
        transform.scale.set(floor.sizeX, SLAB.HEIGHT, floor.sizeZ);
        transform.updateMatrix();
        ring.setMatrixAt(slot, transform.matrix);
        ring.setColorAt(slot, make.color(floor.color));
        ring.instanceMatrix.needsUpdate = ring.instanceColor.needsUpdate = true;
        ringFloors[slot] = floor;
        slabs.release(floor.mesh);
        // Once the ring is full this write replaced the oldest floor; the next slot now holds the lowest one left, and the
        // pedestal moves up under it so the tower never appears to float.
        const lowest = ringFloors[(slot + 1) % ringSize];
        if (floor.index < ringSize || !lowest) return;
        pedestal.position.set(lowest.centerX, lowest.y, lowest.centerZ);
        lowestShownY = lowest.y;
      },
      lowestY: () => lowestShownY,
      liveCount: () => slabs.live.size,
    };
  }

  /**
   * Things that fall off: the sliced overhang tumbling away and the bright flash along a fresh cut.
   * @param {Object} ctx game context
   * @complexity update: O(live chunks) per frame; at most two chunks are born per drop and each lives FEEL.CHUNK.LIFE_SECS, so a handful. Pooled: no allocation after warm-up.
   * @returns {{ spawnChunk(cut: Footprint & { side: -1 | 1 }, y: number, color: number, axis: 'x'|'z'): void,
   *   flashCut(cut: Footprint & { side: -1 | 1 }, y: number, axis: 'x'|'z'): void, update(dt: number): void, liveCount(): number }}
   */
  function createDebrisView(ctx) {
    const { make, math, THREE } = ctx;
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    // Opacity just under 1 makes the materials transparent from the start, so fading them later needs no shader recompile.
    const chunks = ctx.pool(() => make.mesh(boxGeometry, make.mat(PALETTE.WHITE, { fresh: true, opacity: 0.99, rough: TOWER.SLAB_ROUGHNESS }), { shadow: false }));
    const flashes = ctx.pool(() => make.mesh(boxGeometry, make.unlit(PALETTE.WHITE, { fresh: true, opacity: 0.99, bright: FEEL.CUT_FLASH.BRIGHT }), { shadow: false }));
    return {
      spawnChunk(cut, y, color, axis) {
        const { unitX, unitZ } = AXES[axis], chunk = chunks.get();
        chunk.material.color.copy(make.color(Kit.blend.hex(color, PALETTE.WHITE, FEEL.CHUNK.WHITEN)));
        chunk.position.set(cut.centerX, y + SLAB.HEIGHT / 2, cut.centerZ);
        chunk.rotation.set(0, 0, 0);
        chunk.scale.set(cut.sizeX, SLAB.HEIGHT, cut.sizeZ);
        const push = cut.side * math.rand(...FEEL.CHUNK.PUSH), spin = -cut.side * math.rand(...FEEL.CHUNK.SPIN);
        // It drifts outward along the slide axis and tips over the edge it was cut from (rotation about the other ground axis).
        chunk.userData = { velocityX: unitX * push, velocityY: FEEL.CHUNK.HOP, velocityZ: unitZ * push, spinX: -unitZ * spin, spinZ: unitX * spin, life: FEEL.CHUNK.LIFE_SECS };
      },
      flashCut(cut, y, axis) {
        const { center, size, unitX, unitZ } = AXES[axis], flash = flashes.get(), { THICKNESS, MARGIN, SECS } = FEEL.CUT_FLASH;
        const cutFace = cut[center] - (cut.side * cut[size]) / 2; // the inner end of the fallen part is the new face of the slab
        flash.position.set(unitX ? cutFace : cut.centerX, y + SLAB.HEIGHT / 2, unitZ ? cutFace : cut.centerZ);
        flash.scale.set(unitX ? THICKNESS : cut.sizeX + MARGIN, SLAB.HEIGHT + MARGIN, unitZ ? THICKNESS : cut.sizeZ + MARGIN);
        flash.material.opacity = 0.99;
        ctx.tween(flash.material, { opacity: 0 }, SECS, 'linear').then(() => flashes.release(flash));
      },
      update(dt) {
        chunks.each((chunk) => {
          const motion = chunk.userData;
          motion.life -= dt;
          motion.velocityY -= FEEL.CHUNK.GRAVITY * dt;
          chunk.position.x += motion.velocityX * dt;
          chunk.position.y += motion.velocityY * dt;
          chunk.position.z += motion.velocityZ * dt;
          chunk.rotation.x += motion.spinX * dt;
          chunk.rotation.z += motion.spinZ * dt;
          chunk.material.opacity = Math.min(0.99, motion.life / FEEL.CHUNK.FADE_SECS);
          if (motion.life <= 0) chunks.release(chunk);
        });
      },
      liveCount: () => chunks.live.size,
    };
  }

  /**
   * The city below the tower: one instanced mesh of blocks with face shading baked into vertex colours, one of glowing windows.
   * @param {Object} ctx game context
   */
  function buildCity(ctx) {
    const { make, math, THREE } = ctx;
    const VERTICES_PER_FACE = 4, FACES = 6;
    const blockGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const shades = Array.from({ length: FACES * VERTICES_PER_FACE }, (_, vertex) => CITY.FACE_SHADE[Math.floor(vertex / VERTICES_PER_FACE)]);
    blockGeometry.setAttribute('color', new THREE.Float32BufferAttribute(shades.flatMap((shade) => [shade, shade, shade]), 3));
    const blockMaterial = make.unlit(PALETTE.WHITE, { fresh: true });
    blockMaterial.vertexColors = true;
    const windows = CITY.WINDOWS;
    const blocks = make.instanced(blockGeometry, blockMaterial, CITY.COUNT);
    const lights = make.instanced(new THREE.BoxGeometry(1, 1, 1), make.unlit(windows.COLOR, { bright: windows.BRIGHT }), CITY.COUNT * windows.EACH);
    const transform = new THREE.Object3D();
    const placeBox = (mesh, slot, x, y, z, sizeX, sizeY, sizeZ) => {
      transform.position.set(x, y, z);
      transform.scale.set(sizeX, sizeY, sizeZ);
      transform.updateMatrix();
      mesh.setMatrixAt(slot, transform.matrix);
    };
    layOutCity(math.rand).forEach((block, blockIndex) => {
      placeBox(blocks, blockIndex, block.x, block.roofY - CITY.BLOCK_DEPTH, block.z, block.size, CITY.BLOCK_DEPTH, block.size);
      blocks.setColorAt(blockIndex, make.color(CITY.TINTS[blockIndex % CITY.TINTS.length]));
      const half = block.size / 2;
      Array.from({ length: windows.EACH }).forEach((_, windowIndex) => {
        // Windows alternate between the two faces turned toward the camera (+x and +z), pressed flat against the wall.
        const isOnXFace = windowIndex % 2 === 0, along = math.rand(-half + windows.INSET, half - windows.INSET);
        placeBox(
          lights, blockIndex * windows.EACH + windowIndex,
          block.x + (isOnXFace ? half : along), block.roofY - math.rand(...windows.DROP), block.z + (isOnXFace ? along : half),
          isOnXFace ? windows.THICKNESS : windows.WIDTH, windows.HEIGHT, isOnXFace ? windows.WIDTH : windows.THICKNESS
        );
      });
    });
    blocks.commit();
    lights.commit();
  }

  /**
   * The sky: a camera-aligned group of clouds, stars, motes, a moon and aurora ribbons that scroll with altitude and fade by zone.
   * @param {Object} ctx game context
   * @param {{ sun: Object, hemi: Object, setSky(top: number, bottom: number): void }} stage from make.stage
   * @complexity update: O(clouds + ribbon vertices) per frame (11 sprites, 210 vertices while the aurora shows); the two dot fields scroll in O(1).
   * @returns {{ update(look: Zone, altitudeY: number, focus: Object, dt: number, time: number): void }}
   *   look: blended zone row; altitudeY: smoothed height of the tower top in world units; focus: the camera's look-at point
   */
  function createSkyView(ctx, stage) {
    const { make, math, THREE } = ctx;
    const sky = make.group();
    const softDot = (g, x, y, radius) => {
      const gradient = g.createRadialGradient(x, y, 0, x, y, radius);
      [[0, 0.95], [0.55, 0.6], [1, 0]].forEach(([stop, alpha]) => gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`));
      g.fillStyle = gradient;
      g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };
    const CLOUD_PUFFS = [[36, 40, 22], [62, 30, 27], [90, 38, 22], [50, 44, 19], [76, 45, 19]]; // x, y, radius on a 128 x 64 canvas
    const cloudMaterial = new THREE.SpriteMaterial({
      transparent: true, depthWrite: false, fog: false, toneMapped: false,
      map: make.canvasTexture(128, 64, (g) => CLOUD_PUFFS.forEach(([x, y, radius]) => softDot(g, x, y, radius))),
    });
    const cloudRules = SKY.CLOUDS;
    const clouds = Array.from({ length: cloudRules.COUNT }, (_, index) => {
      const sprite = new THREE.Sprite(cloudMaterial), width = math.rand(...cloudRules.SIZE), depth = math.rand(...cloudRules.DEPTH);
      sprite.scale.set(width, width / 2, 1);
      sky.add(sprite);
      return {
        sprite, depth,
        x: math.rand(-cloudRules.HALF_WIDTH, cloudRules.HALF_WIDTH),
        startY: math.rand(0, SKY.HEIGHT),
        drift: math.rand(...cloudRules.DRIFT) * (index % 2 ? 1 : -1),
        parallax: math.remap(depth, ...cloudRules.DEPTH, ...cloudRules.PARALLAX), // nearer clouds slide past faster
      };
    });
    const dotField = (rules) => make.dots(rules.count, { ...rules, width: cloudRules.HALF_WIDTH * 2, height: SKY.HEIGHT, parent: sky });
    const stars = dotField(SKY.STARS), motes = dotField(SKY.MOTES);

    const moonRules = SKY.MOON;
    const moonMaterial = make.unlit(moonRules.COLOR, { fresh: true, bright: moonRules.BRIGHT });
    moonMaterial.fog = false;
    const moon = make.sphere(moonRules.RADIUS, moonMaterial, { parent: sky, shadow: false });
    const moonGlow = make.glow(moonRules.GLOW_COLOR, moonRules.GLOW_SIZE, { parent: moon, opacity: moonRules.GLOW_OPACITY });

    const auroraRules = SKY.AURORA;
    const RIBBON_FADE = [[0, 0], [0.55, 0.35], [0.86, 1], [1, 0]]; // alpha down the ribbon: a bright lower hem that feathers out upward
    const ribbonTexture = make.canvasTexture(1, 64, (g) => {
      const gradient = g.createLinearGradient(0, 0, 0, 64);
      RIBBON_FADE.forEach(([stop, alpha]) => gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`));
      g.fillStyle = gradient;
      g.fillRect(0, 0, 1, 64);
    });
    const ribbons = auroraRules.RIBBONS.map((row) => {
      const material = make.unlit(row.color, { fresh: true, additive: true, opacity: auroraRules.OPACITY, bright: auroraRules.BRIGHT });
      Object.assign(material, { map: ribbonTexture, fog: false, side: THREE.DoubleSide });
      const mesh = make.mesh(new THREE.PlaneGeometry(auroraRules.WIDTH, auroraRules.HEIGHT, auroraRules.SEGMENTS, 1), material, { parent: sky, shadow: false, at: [0, row.y, -auroraRules.DEPTH] });
      mesh.rotation.z = auroraRules.TILT;
      mesh.frustumCulled = false;
      return { mesh, phase: row.phase };
    });
    /** Ripples every ribbon with the AURORA.WAVES sines. */
    function waveRibbons(time) {
      const columns = auroraRules.SEGMENTS + 1, halfHeight = auroraRules.HEIGHT / 2;
      ribbons.forEach(({ mesh, phase }) => {
        const positions = mesh.geometry.attributes.position;
        // Index loop: this rewrites 70 vertices per ribbon every frame while the aurora shows (measured hot path).
        for (let column = 0; column < columns; column++) {
          const wave = auroraRules.WAVES.reduce((sum, row) => sum + Math.sin(column * row.perColumn + time * row.perSec + phase) * row.height, 0);
          positions.setY(column, halfHeight + wave);
          positions.setY(column + columns, -halfHeight + wave * auroraRules.HEM_SWAY);
        }
        positions.needsUpdate = true;
      });
    }

    const isVisible = (weight) => weight > SKY.VISIBLE_ABOVE;
    let paintedSky = '';
    return {
      update(look, altitudeY, focus, dt, time) {
        // Repainting the gradient uploads a texture, so it is skipped while the blended colours stand still.
        const skyKey = look.skyTop + '|' + look.skyBottom;
        if (skyKey !== paintedSky) {
          paintedSky = skyKey;
          stage.setSky(look.skyTop, look.skyBottom);
        }
        stage.hemi.intensity = look.ambient;
        stage.sun.intensity = look.sun;
        stage.sun.color.copy(make.color(look.sunColor));

        // The group sits on the look-at point facing the camera; dividing by zoom keeps it filling the frame during the game-over pull back.
        const { camera } = ctx, halfWidth = (camera.right - camera.left) / 2;
        sky.position.copy(focus);
        sky.quaternion.copy(camera.quaternion);
        sky.scale.set(Math.max(1, halfWidth / SKY.DESIGN_HALF_WIDTH) / camera.zoom, 1 / camera.zoom, 1);

        cloudMaterial.opacity = cloudRules.OPACITY * Math.min(1, look.clouds);
        cloudMaterial.color.copy(make.color(Kit.blend.hex(PALETTE.WHITE, look.skyBottom, cloudRules.TINT)));
        clouds.forEach((cloud) => {
          cloud.x += cloud.drift * dt;
          if (Math.abs(cloud.x) > cloudRules.WRAP_AT) cloud.x = -Math.sign(cloud.x) * cloudRules.WRAP_AT;
          cloud.sprite.position.set(cloud.x, Kit.span.wrap(cloud.startY - altitudeY * cloud.parallax, SKY.HEIGHT) - SKY.HEIGHT / 2, -cloud.depth);
          cloud.sprite.visible = isVisible(look.clouds);
        });
        stars.material.size = SKY.STARS.size + Math.sin(time * SKY.STARS.twinkle.rate) * SKY.STARS.twinkle.amount;
        stars.scroll(-altitudeY * SKY.STARS.parallax);
        stars.fade(look.stars);
        motes.scroll(-(altitudeY + time * SKY.MOTES.driftPerSec) * SKY.MOTES.parallax);
        motes.fade(look.motes);
        moon.visible = isVisible(look.moon);
        moon.position.set(moonRules.X, math.lerp(...moonRules.Y, look.moon), -moonRules.DEPTH);
        moonGlow.material.opacity = moonRules.GLOW_OPACITY * look.moon;
        ribbons.forEach(({ mesh }) => {
          mesh.visible = isVisible(look.aurora);
          mesh.material.opacity = auroraRules.OPACITY * look.aurora;
        });
        if (isVisible(look.aurora)) waveRibbons(time);
      },
    };
  }

  /**
   * The HUD, built for this game's world: one large floor numeral, the streak as a row of pips that fill toward the next brace,
   * braces as gold bars, the blueprints held, and an altitude gauge down the right edge that names the zones.
   * @param {Object} ctx game context
   * @param {number} bestFloor best height from earlier runs
   * @returns {{ hint: { hide(): void }, setFloor(floor: number): void, setScore(score: number, multiplier: number): void,
   *   setStreak(streak: number, braces: number, perfectsPerBrace: number, braceCapacity: number): void,
   *   setBuild(blueprintNames: string[]): void, announce(text: string): void }}
   */
  function createHud(ctx, bestFloor) {
    const { ui, math } = ctx;
    const floorStat = ui.stat('Floors', 0);
    const meter = ui.el('div', 'sky-meter');
    const scoreLine = ui.el('div', 'sky-score', '');
    const buildLine = ui.el('div', 'sky-build', '');
    let meterShape = '', pips = [], braceBars = [];
    /** Rebuilds the pips and brace bars; their counts change when a blueprint alters the brace rules. */
    function shapeMeter(pipCount, braceCount) {
      const marks = (count, className) => Array.from({ length: count }, () => ui.h('i', className));
      pips = marks(pipCount, 'sky-pip');
      braceBars = marks(braceCount, 'sky-brace');
      meter.replaceChildren(...pips, ...braceBars);
    }

    const gauge = ui.el('div', 'sky-gauge');
    const gaugePosition = (floor) => math.clamp(floor / HUD.GAUGE_FLOORS) * 100 + '%';
    const zoneTicks = ZONES.map((zone) => {
      const tick = gauge.appendChild(ui.h('span', 'sky-zone', zone.name));
      tick.style.bottom = gaugePosition(zone.from);
      return tick;
    });
    if (bestFloor > 0) gauge.appendChild(ui.h('i', 'sky-best')).style.bottom = gaugePosition(bestFloor); // a gold notch at the height to beat
    const marker = gauge.appendChild(ui.h('i', 'sky-marker'));

    return {
      hint: ui.hint(HUD.HINT),
      setFloor(floor) {
        floorStat.set(floor);
        floorStat.pulse();
        marker.style.bottom = gaugePosition(floor);
        zoneTicks.forEach((tick, index) => tick.classList.toggle('reached', floor >= ZONES[index].from));
      },
      setStreak(streak, braces, perfectsPerBrace, braceCapacity) {
        const shape = perfectsPerBrace + '|' + braceCapacity;
        if (shape !== meterShape) shapeMeter(perfectsPerBrace, braceCapacity);
        meterShape = shape;
        // The row shows progress toward the next brace; a completed set stays full until the next drop.
        const intoSet = streak % perfectsPerBrace, filled = streak > 0 && intoSet === 0 ? perfectsPerBrace : intoSet;
        pips.forEach((pip, index) => pip.classList.toggle('on', index < filled));
        braceBars.forEach((bar, index) => bar.classList.toggle('on', index < braces));
      },
      setScore(score, multiplier) {
        scoreLine.textContent = `${ctx.fmt(score)}  x${multiplier}`;
      },
      setBuild(blueprintNames) {
        buildLine.textContent = blueprintNames.join('  /  ');
      },
      announce: (text) => ui.toast(text, HUD.TOAST_MS),
    };
  }

  /**
   * The HUD theme: the minimal 'air' skin taken toward architectural signage - a thin geometric face, hairlines instead of panels,
   * diamonds that echo the isometric slabs.
   */
  const THEME = {
    skin: 'air',
    fonts: ['Josefin Sans:wght@200;400;600'],
    tokens: {
      '--display': '"Josefin Sans", "Century Gothic", system-ui, sans-serif',
      '--body': '"Josefin Sans", "Century Gothic", system-ui, sans-serif',
      '--accent': '#ffd27a',
      '--accent-ink': '#ffd27a',
      '--accent-edge': 'transparent',
      '--dim': 'rgba(255, 255, 255, 0.66)',
      '--scrim': 'rgba(12, 14, 48, 0.5)',
      '--floater': '#ffffff',
      '--label-spacing': '0.34em',
      '--sky-hairline': 'rgba(255, 255, 255, 0.42)',
    },
    layout: { stats: 'top-center', actions: 'bottom-right' },
    components: {
      // One numeral, large and light, with its label beneath: the height is the only number that matters while playing.
      stat: ({ label, value, h }) => {
        const box = h('div', 'stat sky-height');
        box.append(value, h('span', null, label));
        return box;
      },
    },
    css: `
      & #stats { position: absolute; left: 0; right: 0; top: calc(env(safe-area-inset-top, 0px) + 6px); justify-content: center; margin: 0; }
      & .sky-height { align-items: center; padding: 0; }
      & #stats, & #hud-layer { text-shadow: 0 1px 12px rgba(10, 12, 50, 0.75), 0 0 2px rgba(10, 12, 50, 0.5); } /* white type must hold over the Cloud Deck */
      & .sky-meter { filter: drop-shadow(0 1px 4px rgba(10, 12, 50, 0.6)); }
      & .sky-height b { font: 200 68px/0.95 var(--display); letter-spacing: -0.02em; }
      & .sky-height span { font-size: 10px; margin-top: 2px; padding-left: var(--label-spacing); }
      & .sky-height.pulse { animation: sky-rise 0.3s ease-out; }
      @keyframes sky-rise { 35% { transform: translateY(-5px); } }
      & .chip { font-weight: 400; color: var(--dim); }
      & #hud-layer { padding-top: 62px; gap: 9px; }
      & .sky-meter { display: flex; align-items: center; gap: 9px; height: 12px; }
      & .sky-pip { width: 7px; height: 7px; transform: rotate(45deg); border: 1px solid var(--sky-hairline); transition: background 0.18s, box-shadow 0.18s; }
      & .sky-pip.on { background: #fff; border-color: #fff; box-shadow: 0 0 8px rgba(255, 255, 255, 0.8); }
      & .sky-brace { width: 2px; height: 12px; background: var(--sky-hairline); transition: background 0.2s, box-shadow 0.2s; }
      & .sky-pip + .sky-brace { margin-left: 8px; }
      & .sky-brace.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
      & .sky-score { font: 400 11px var(--display); letter-spacing: 0.3em; color: var(--dim); font-variant-numeric: tabular-nums; white-space: pre; }
      & .sky-gauge { position: absolute; right: 0; top: 96px; bottom: 9%; width: 1px; background: linear-gradient(var(--sky-hairline), rgba(255, 255, 255, 0.12)); }
      & .sky-zone { position: absolute; right: 0; padding-right: 9px; transform: translateY(50%); white-space: nowrap;
        font: 400 8px var(--display); letter-spacing: 0.26em; text-transform: uppercase; color: rgba(255, 255, 255, 0.4); transition: color 0.6s; }
      & .sky-zone::after { content: ''; position: absolute; right: 0; top: 50%; width: 5px; height: 1px; background: currentColor; }
      & .sky-zone.reached { color: #fff; }
      & .sky-best { position: absolute; left: 0; width: 9px; height: 1px; background: var(--accent); }
      & .sky-marker { position: absolute; left: -4px; width: 7px; height: 7px; margin-bottom: -4px; background: var(--accent); transform: rotate(45deg);
        box-shadow: 0 0 10px var(--accent); transition: bottom 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }
      & .sky-build { font: 400 9px var(--display); letter-spacing: 0.3em; text-transform: uppercase; color: var(--accent); min-height: 10px; }
      & .action { flex: 0 0 auto; min-width: 0; padding: 9px 16px 7px; background: transparent; border: 1px solid var(--sky-hairline); border-radius: 999px; }
      & .action b { font: 400 11px var(--display); letter-spacing: 0.26em; text-transform: uppercase; }
      & .action span { font-size: 8px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--dim); }
      & .choice { background: transparent; border: 0; border-left: 2px solid var(--c); border-radius: 0; }
      & .choice b { font: 400 16px var(--display); letter-spacing: 0.14em; text-transform: uppercase; }
      & .toast { top: 30%; font: 200 25px var(--display); letter-spacing: 0.42em; text-transform: uppercase; text-shadow: 0 1px 16px rgba(10, 12, 50, 0.6); padding-left: 0.42em; }
      & .hint { font: 400 11px var(--display); letter-spacing: 0.3em; text-transform: uppercase; }
      & .floater { font-weight: 400; letter-spacing: 0.12em; text-shadow: 0 1px 10px rgba(10, 12, 50, 0.7); }
      & .modal-card { background: rgba(16, 18, 58, 0.72); border: 1px solid var(--sky-hairline); padding: 26px 22px; backdrop-filter: blur(10px); text-align: center; }
      & .modal-card h2 { font: 200 30px var(--display); letter-spacing: 0.2em; text-transform: uppercase; }
      & .modal-card p { letter-spacing: 0.06em; }
      & .rows { border-top: 1px solid var(--sky-hairline); border-bottom: 1px solid var(--sky-hairline); padding: 12px 4px; text-align: left; letter-spacing: 0.08em; }
      & .rows b { font-weight: 600; }
      & .primary { background: transparent; border: 1px solid var(--accent); border-radius: 999px; font: 600 13px var(--display); letter-spacing: 0.34em; text-transform: uppercase; padding: 15px 14px 12px; }
    `,
  };

  // ================================================== GAME ==================================================

  Kit.register({
    id: 'stack', name: 'Sky Stack', tagline: 'Tap to drop. Stack it straight.', hook: 'Blueprints shape each tower; charters change the climb', color: '#6ea8ff', order: 5,
    theme: THEME,
    /**
     * Builds one run.
     * @param {Object} ctx game context; ctx.def.tune = { ringSize } lets a playtest shrink the ring buffer to reach the recycling path quickly
     * @returns {{ update(dt: number, time: number): void }}
     */
    create(ctx) {
      const { make, input, fx, sfx, ui, save, math } = ctx;
      const tune = ctx.def.tune || {};

      // ---- models: the permanent record, this run's charter, its modifiers and the blueprints that change them ----
      const profile = createProfile(save);
      const charter = charterFor(profile, save.get('charter', 'standard'));
      const modifierStats = createModifierStats(charter);
      const modifiers = () => readModifiers(modifierStats);
      const blueprints = Kit.upgrades(BLUEPRINTS.filter(isAvailableTo(profile)), { stats: modifierStats });

      // ---- views ----
      const rig = createCameraRig(ctx);
      const stage = make.stage({ sky: [ZONES[0].skyTop, ZONES[0].skyBottom], fog: STAGE.FOG, sun: STAGE.SUN, shadow: STAGE.SHADOW_HALF_EXTENT });
      ctx.post.bloom(...STAGE.BLOOM);
      const tower = createTowerView(ctx, tune.ringSize || TOWER.RING_SIZE);
      const debris = createDebrisView(ctx);
      buildCity(ctx);
      const sky = createSkyView(ctx, stage);

      const bestBefore = profile.stat('bestFloor');
      const hud = createHud(ctx, bestBefore);
      // The rim outlines the landing footprint on the tower top; it turns gold while a brace is in hand.
      const rim = make.frame(PALETTE.WHITE, { bright: FEEL.RIM.BRIGHT, opacity: FEEL.RIM.REST });
      const bestMarker = bestBefore > 0 ? make.frame(PALETTE.GOLD, { bright: FEEL.RIM.BRIGHT, opacity: FEEL.BEST_MARKER.OPACITY, at: [0, (bestBefore + 1) * SLAB.HEIGHT, 0] }) : null;
      if (bestMarker) bestMarker.scale.set(modifiers().baseWidth + FEEL.BEST_MARKER.MARGIN, 1, modifiers().baseWidth + FEEL.BEST_MARKER.MARGIN);

      /** Everything that changes during a run. `floors` holds only the live (un-baked) floors, newest last; `tally` is the rules' score sheet. */
      const run = { floors: [], slider: null, tally: createTally(modifiers()), zoneIndex: -1, rimFlare: 0, altitudeY: 0 };
      const topFloor = () => run.floors[run.floors.length - 1];
      const topCentre = (floor) => ({ x: floor.centerX, y: floor.y + SLAB.HEIGHT, z: floor.centerZ });

      /**
       * Floats a line of text above the tower top.
       * @param {string} kind key of NOTES (lift, colour, size)
       * @param {string} text
       */
      function note(kind, text) {
        const above = topCentre(topFloor()), { lift, color, size } = NOTES[kind];
        fx.floater(text, { ...above, y: above.y + lift }, { color, size });
      }

      function addFloor(floor) {
        run.floors.push(floor);
        if (run.floors.length > TOWER.LIVE_FLOORS) tower.bake(run.floors.shift());
        return floor;
      }

      function placeSlider(slider) {
        const { unitX, unitZ } = AXES[slider.axis], top = topFloor();
        slider.mesh.position.x = top.centerX + unitX * slider.offset;
        slider.mesh.position.z = top.centerZ + unitZ * slider.offset;
        slider.mesh.material.emissiveIntensity = FEEL.SLIDER_GLOW + (isLinedUp(slider) ? FEEL.CUE_GLOW * slider.difficulty.cue : 0);
      }

      function spawnSlider(kind) {
        const slider = createSlider(topFloor(), kind, modifiers());
        slider.mesh = tower.show(slider);
        run.slider = slider;
        placeSlider(slider);
        if (!kind.label) return;
        note('kindAppears', kind.label);
        playSounds(sfx, 'kindAppears');
      }

      function refreshHud() {
        const { streak, braces, score } = run.tally, { perfectsPerBrace, braceCapacity } = modifiers();
        hud.setStreak(streak, braces, Math.round(perfectsPerBrace), Math.round(braceCapacity));
        hud.setScore(score, multiplierAt(streak));
        hud.setBuild(blueprints.owned().map((blueprint) => blueprint.name));
        rim.material.color.copy(make.color(braces > 0 ? FEEL.RIM.BRACED_COLOR : PALETTE.WHITE)).multiplyScalar(FEEL.RIM.BRIGHT);
      }

      function announceZone(floorIndex) {
        const zoneIndex = zoneIndexAt(floorIndex);
        if (zoneIndex === run.zoneIndex) return;
        const isFirst = run.zoneIndex < 0;
        run.zoneIndex = zoneIndex;
        hud.announce(ZONES[zoneIndex].name);
        if (!isFirst) playSounds(sfx, 'zoneChange');
      }

      /** Weight of a landing: squash, a thud that deepens with slab area, a puff of dust off each edge and a small camera dip. No shake. */
      function playLanding(floor) {
        const { WIDEN, FLATTEN, SECS } = FEEL.SQUASH, fullArea = BASE_MODIFIERS.baseWidth * BASE_MODIFIERS.baseWidth;
        floor.mesh.scale.set(floor.sizeX * WIDEN, SLAB.HEIGHT * FLATTEN, floor.sizeZ * WIDEN);
        ctx.tween(floor.mesh.scale, { x: floor.sizeX, y: SLAB.HEIGHT, z: floor.sizeZ }, SECS, 'outBack');
        sfx.play('thud', { pitch: math.remap(floor.sizeX * floor.sizeZ, 1, fullArea, FEEL.THUD_PITCH.SMALL, FEEL.THUD_PITCH.FULL) });
        const dustColor = Kit.blend.hex(floor.color, PALETTE.WHITE, FEEL.DUST_WHITEN);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([edgeX, edgeZ]) =>
          fx.burst(
            { x: floor.centerX + (edgeX * floor.sizeX) / 2, y: floor.y, z: floor.centerZ + (edgeZ * floor.sizeZ) / 2 },
            { ...FEEL.DUST, dir: [edgeX * FEEL.DUST_PUSH, FEEL.DUST_LIFT, edgeZ * FEEL.DUST_PUSH], color: dustColor }
          )
        );
        rig.dip();
      }

      /** A perfect drop is the one celebration: a chime that climbs, outline pulses that ripple outward, a warm slab and a flaring rim. */
      function celebrate(floor, streak) {
        const { CAP, PULSES_EVERY, MAX_EXTRA_PULSES } = FEEL.CELEBRATION;
        const level = Math.min(streak, CAP), pitch = chimePitch(level - 1);
        sfx.play('perfect', { pitch });
        if (streak >= STREAK.REGROW_FROM) sfx.tone({ ...FEEL.STREAK_TONE, freq: FEEL.STREAK_TONE.freq * pitch });
        const pulses = 1 + Math.min(MAX_EXTRA_PULSES, Math.floor(streak / PULSES_EVERY));
        Array.from({ length: pulses }).forEach((_, index) =>
          fx.frame(topCentre(floor), {
            width: floor.sizeX, depth: floor.sizeZ, color: Kit.blend.hex(floor.color, PALETTE.WHITE, FEEL.PULSE.WHITEN), bright: FEEL.PULSE.BRIGHT,
            delay: index * FEEL.PULSE.GAP_SECS, grow: FEEL.PULSE.GROW + index * FEEL.PULSE.GROW_STEP, life: FEEL.PULSE.LIFE_SECS,
          })
        );
        floor.mesh.material.emissiveIntensity = FEEL.PERFECT_GLOW.BASE + level * FEEL.PERFECT_GLOW.PER_LEVEL;
        run.rimFlare = FEEL.RIM.FLARE + level * FEEL.RIM.FLARE_PER_LEVEL;
      }

      /** The words for a landing: how well it was placed, whether it was swift, the streak and the points. */
      function praise(judged, streak, points) {
        if (!judged.isPerfect) return '+' + points;
        const placement = judged.isFlawless ? 'Flawless' : 'Perfect';
        return `${judged.isSwift ? 'Swift ' : ''}${placement}${streak > 1 ? ' x' + streak : ''}  +${points}`;
      }

      /** Replaces the waiting slab with one made under the current modifiers (a blueprint was just picked). */
      function respawnSlider() {
        tower.release(run.slider.mesh);
        spawnSlider(kindForFloor(topFloor().index + 1, modifiers()));
      }

      /** A milestone terrace: gold burst, then the choice of one blueprint for the rest of this tower (the game pauses while it is open). */
      function playMilestone(floor, milestone) {
        playSounds(sfx, 'milestone');
        fx.burst(topCentre(floor), { ...FEEL.TERRACE_BURST, colors: [PALETTE.GOLD, PALETTE.WHITE] });
        const title = `Floor ${milestone.floor}: ${milestone.name}`;
        ui.offer(blueprints, { n: BLUEPRINTS_OFFERED, title, sub: 'Keep one blueprint for this tower' }).then((picked) => {
          if (!picked) return hud.announce(title); // every available blueprint is already held
          run.tally = applyBlueprintPick(run.tally, picked, modifiers());
          respawnSlider();
          refreshHud();
          hud.announce(picked.name);
        });
      }

      /** What each resolution of a drop looks and sounds like. Keyed like the rules' settlements; the tally is already updated. */
      const RESOLUTION_VIEWS = {
        land(slider, result) {
          const { judged, floor: landed, points, milestone } = result, streak = run.tally.streak;
          judged.cuts.forEach((cut) => {
            debris.spawnChunk(cut, slider.y, slider.color, slider.axis);
            debris.flashCut(cut, slider.y, slider.axis);
          });
          if (judged.cuts.length) playSounds(sfx, 'slice');

          topFloor().mesh.material.emissiveIntensity = 0;
          const floor = addFloor({ ...landed, mesh: slider.mesh });
          tower.fit(floor.mesh, floor);
          tower.paint(floor.mesh, floor.color);
          playLanding(floor);
          if (judged.isPerfect) celebrate(floor, streak);
          ctx.tween(floor.mesh.material, { emissiveIntensity: FEEL.TOP_GLOW }, FEEL.TOP_GLOW_SETTLE_SECS);

          note(judged.isPerfect ? 'perfect' : 'landed', praise(judged, streak, points));
          if (result.hasRegrown && !milestone) note('regrow', 'Regrow');
          if (result.bracesEarned > 0) note('braceEarned', 'Brace earned');
          if (bestMarker && bestMarker.visible && floor.index > bestBefore) {
            bestMarker.visible = false;
            note('newBest', 'New best');
            playSounds(sfx, 'newBest');
          }
          hud.setFloor(floor.index);
          announceZone(floor.index);
          spawnSlider(kindForFloor(floor.index + 1, modifiers()));
          if (milestone) playMilestone(floor, milestone);
        },
        /** A fragile slab dropped badly breaks up and chips the floor below; a plain slab replaces it. */
        shatter(slider, result) {
          const top = Object.assign(topFloor(), result.chippedTop);
          tower.fit(top.mesh, top);
          tower.release(slider.mesh);
          fx.burst({ x: slider.mesh.position.x, y: slider.y + SLAB.HEIGHT / 2, z: slider.mesh.position.z }, { ...FEEL.SHATTER, colors: [slider.color, PALETTE.WHITE] });
          playSounds(sfx, 'shatter');
          note('shattered', 'Shattered');
          spawnSlider(SLAB_KINDS.byId('plain'));
        },
        /** A brace catches a slab that missed entirely: it swings back to the start of its slide for another try. */
        brace(slider) {
          run.slider = rewindSlider(slider);
          placeSlider(run.slider);
          const top = topFloor();
          fx.frame(topCentre(top), { width: top.sizeX, depth: top.sizeZ, color: PALETTE.GOLD, bright: FEEL.PULSE.BRIGHT, grow: FEEL.BRACE_PULSE_GROW, life: FEEL.PULSE.LIFE_SECS });
          playSounds(sfx, 'brace');
          note('braced', 'Braced: try again');
        },
        /** No overlap and no brace: the slab falls past the tower and the run ends. */
        fall(slider, result) {
          tower.release(slider.mesh);
          result.judged.cuts.forEach((cut) => debris.spawnChunk(cut, slider.y, slider.color, slider.axis));
          phases.go('over');
        },
      };

      function drop() {
        if (!phases.is('play') || run.slider.age < SLIDE.TAP_LOCKOUT_SECS) return;
        hud.hint.hide();
        const slider = run.slider, result = settleDrop(run.tally, topFloor(), slider, modifiers());
        run.tally = result.tally;
        RESOLUTION_VIEWS[result.resolution](slider, result);
        refreshHud();
      }

      /** Lets the player pick a charter for the next tower; shown only once a second charter is unlocked. */
      function offerCharters(charters) {
        ui.actions([{
          id: 'charter', label: charter.name, sub: 'Charter',
          onClick: () =>
            ui.choose({
              title: 'Charter', sub: 'Starts a new tower',
              options: charters.map((row) => ({ title: row.name, desc: row.desc, tag: row.id === charter.id ? 'Current' : `Experience x${row.experienceScale}` })),
            }).then((index) => {
              save.set('charter', charters[index].id);
              ctx.restart();
            }),
        }]);
      }

      /** Run phases (Kit.fsm). 'over' records the run, pulls the camera back until the whole tower fits, then offers a retry. */
      const phases = Kit.fsm({
        play: {
          update(dt) {
            run.slider = stepSlider(run.slider, dt);
            placeSlider(run.slider);
          },
        },
        over: {
          enter() {
            this.record = recordRun(profile, run.tally, charter);
            playSounds(sfx, 'gameOver');
            fx.slowmo(...FEEL.GAME_OVER.SLOWMO);
            rim.visible = false;
            if (bestMarker) bestMarker.visible = false;
            rig.frameTower(tower.lowestY(), topFloor().y);
          },
          update(dt, secondsInPhase) {
            if (secondsInPhase < FEEL.GAME_OVER.BANNER_DELAY_SECS || this.isBannerShown) return;
            this.isBannerShown = true;
            const { floors, longestStreak, score } = run.tally, { experience, unlocked } = this.record;
            const sentences = [
              `${floors} floors, reached ${ZONES[run.zoneIndex].name}.`,
              ...unlocked.map((row) => `Unlocked: ${row.type} - ${row.name}.`),
              ...upcomingUnlocks(profile).slice(0, 1).map((line) => `Next: ${line}.`),
            ];
            ui.banner({
              title: floors > bestBefore ? 'New best tower' : 'Tower complete',
              text: sentences.join(' '),
              stats: [['Height', floors], ['Best', profile.stat('bestFloor')], ['Longest streak', longestStreak], ['Score', score], ['Experience', '+' + ctx.fmt(experience)], ['Level', profile.level]],
              button: 'Stack again',
            }).then(() => ctx.restart());
          },
        },
      });

      // ---- boot ----
      const baseFloor = createBaseFloor(modifiers().baseWidth);
      addFloor({ ...baseFloor, mesh: tower.show(baseFloor) }).mesh.material.emissiveIntensity = FEEL.TOP_GLOW;
      spawnSlider(kindForFloor(1, modifiers()));
      rig.snapTo(topCentre(topFloor()), SLAB.HEIGHT);
      hud.setFloor(0);
      announceZone(0);
      refreshHud();
      const charters = CHARTERS.filter(isAvailableTo(profile));
      if (charters.length > 1) offerCharters(charters);
      phases.go('play');
      input.onTap(drop);

      /** Playtest hook: scripted runs read the live state and drop through Kit.current.debug (see scratch/stack/play.js). */
      ctx.debug = {
        drop,
        snapshot: () => ({
          phase: phases.state, floor: topFloor().index, ...run.tally, zone: run.zoneIndex, charter: charter.id, level: profile.level,
          blueprints: blueprints.owned().map((blueprint) => blueprint.id).join('+'),
          offset: run.slider.offset, age: run.slider.age, kind: run.slider.kind.id, sliderWidth: run.slider[AXES[run.slider.axis].size],
          topWidth: topFloor()[AXES[run.slider.axis].size], ...run.slider.difficulty,
          liveSlabs: tower.liveCount(), chunks: debris.liveCount(), sceneObjects: ctx.scene.children.length, zoom: rig.camera.zoom, lowestY: tower.lowestY(),
        }),
      };

      return {
        update(dt, time) {
          phases.update(dt);
          debris.update(dt);

          // The rim follows the top floor's mesh (not its data) so it squashes and springs with the landing.
          const top = topFloor(), focus = topCentre(top);
          run.rimFlare = math.damp(run.rimFlare, 0, FEEL.RIM.FADE_RATE, dt);
          rim.position.set(focus.x, focus.y + FEEL.OVERLAY_LIFT, focus.z);
          rim.scale.set(top.mesh.scale.x, 1, top.mesh.scale.z);
          const rimRest = run.tally.braces > 0 ? FEEL.RIM.BRACED_REST : FEEL.RIM.REST;
          rim.material.opacity = rimRest + (1 - rimRest) * Math.min(1, run.rimFlare);

          if (phases.is('over')) rig.overview(dt, focus, tower.lowestY(), top.y);
          else rig.follow(dt, focus, focus.y);
          stage.follow(rig.target);

          run.altitudeY = math.damp(run.altitudeY, top.y, SKY.ALTITUDE_RATE, dt);
          sky.update(lookAt(run.altitudeY / SLAB.HEIGHT), run.altitudeY, rig.target, dt, time);
        },
      };
    },
  });
})();
