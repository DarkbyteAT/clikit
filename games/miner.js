/**
 * Core Miner: a tap-and-idle miner drawn as a 2.5D side-on cutaway of a mine shaft.
 * Strike the ore (aim for the moving weak point, ride the heat without overheating), spend coins on power or income, pick a
 * shaft at every fork, forge alloy gear whose tags form set bonuses, and collapse the shaft for shards that grow a
 * three-branch tree. The depth plan (seconds / minutes / hours) is in the header of games/miner-rules.js.
 *
 * Owns: everything seen, heard and tapped: the shaft scenery, the ore, weak point, pickaxe, drill and debris views, the
 *       per-frame feel, and the wiring of taps and HUD (plaque, crates, slate, Camp sheet) to the game's model.
 * Does not own: any rule or number of the economy (games/miner-rules.js, which also runs headless in scratch/miner/sim.js),
 *       the theme (games/miner-theme.js), bookkeeping (the kit models), particles, sound, input or the HUD primitives.
 *
 * Layout of this file: view tables, view rules, view builders (stage, scenery, ore, pick, drills, debris), then Kit.register.
 */
(() => {
  const { clamp, damp, lerp, rand, randInt, pick, TAU } = Kit.math;
  const formatNumber = Kit.fmt;
  const RULES = window.CORE_MINER_RULES;
  const { THEME, PARTS } = window.CORE_MINER_THEME;

  // ---- VIEW TABLES (how things look, sound and move; what they are worth lives in games/miner-rules.js) ----------------------

  /** How a core is drawn compared with an ordinary ore. */
  const CORE_ART = {
    scale: 1.14, // drawn size relative to a normal ore
    gemChance: 0.32, // share of front facets that are pure glowing ore
    crystals: 11,
    bodyGlow: 0.4, // emissive strength of the rock body
    gemBoost: 1.35,
  };

  /** The same art numbers for an ordinary ore. */
  const PLAIN_ORE_ART = { scale: 1, gemChance: 0.17, crystals: 7, bodyGlow: 0.1, gemBoost: 1 };


  /** Semitone offsets (a major pentatonic ladder) the strike's clink climbs through as a combo grows. */
  const CLINK = { baseHz: 1400, semitones: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24], seconds: 0.09, volume: 0.14, detune: 0.02 };

  /** How a crack stage is drawn: crystals shed per stage, and the two jagged arms of each fissure. */
  const CRACK_ART = { crystalsPerStage: 2, segmentsPerArm: 4, width: 0.14 };

  /** The weak point's glow: a steady core and a halo that pulses so the eye finds it. */
  const WEAK_ART = { color: 0xfff6c8, coreSize: 0.9, haloSize: 2.2, pulsePerSecond: 5, frontZ: 3.1 };

  /** Drill bots: one hovers at each slot per Drill level (up to the slot count); together they deal the `dps` stat. */
  const DRILL = {
    slotAnglesDeg: [200, -20, 160, 20, 125, 55], // around the ore, lowest pairs first so early drills flank it
    peckSeconds: 0.55, // one recoil-and-lunge cycle
    lungeFrom: 0.85, // the cycle fraction at which a drill stops drifting back and lunges in
    recoil: 0.55, // how far a drill backs off after a peck, world units
    recoilRate: 9, // how fast it reaches that distance (exponential)
    parkedGap: 1.1, // distance held while there is no ore to drill
    flyInDistance: 8, // a newly bought drill starts this far out
    flyInRate: 5,
    surfaceInset: 0.95, // bits stop just inside the ore's nominal radius so they look like they bite
    bobAmount: 0.07,
    spinPerSecond: 26,
    sparkGap: 0.12, // seconds between drill click sounds, however many drills peck
  };

  /** The pickaxe: poses in radians, and how it grows and changes head colour with Pick levels. */
  const PICK = {
    strikeAngle: 0.7,
    restAngle: -0.4,
    swingDecay: 5.5, // per second: the swing relaxes from strike to rest in under 0.2s
    tip: { x: -1.3, y: 2.25 }, // where the head's point is, relative to the hand
    baseSize: 1.25,
    sizePerLevel: 0.05,
    sizeLevels: 8, // growth stops here so the pick never hides the ore
    levelsPerHead: 2, // a new head colour every two levels
    headColors: [0xd5deef, 0xffc145, 0x4de2c5, 0xc084fc],
    restPoint: { x: 1.5, y: 1.2, z: 2.6 }, // where the pick waits before the first tap
  };

  /** Shaft geometry in world units. The ore rests on a ledge; one stratum is the distance the shaft scrolls per ore. */
  const SHAFT = { ledgeY: -2.9, stratumHeight: 13, halfWidth: 4.7 };

  /** The ore boulder's shape: an icosphere pushed around by sine noise, stretched upward, flattened at the base and back. */
  const ORE_SHAPE = {
    radius: 2.9,
    stretchY: 1.1,
    squashZ: 0.9,
    baseCut: 0.93, // vertices below this fraction of the radius are clamped so the ore sits flat on the ledge
    sink: 0.06, // how far the flat base sinks into the planks
    frontNormalZ: -0.2, // facets whose normal points at least this far forward may be gem facets
    crystalInset: 0.86, // crystals are rooted this far in from the surface
  };

  /** Camera framing: an orthographic side view, slightly from above. Widths are world units across the screen. */
  const VIEW = { portraitWidth: 11.6, landscapeWidthPerAspect: 13.5, lookY: -0.5, rise: 4, distance: 30, top: 16, bottom: -17 };

  /** Squash-and-recoil "punch" (0..max) the ore takes from each kind of hit, and how it settles. */
  const PUNCH = { drill: 0.1, tap: 0.75, weak: 1, crit: 1.2, land: 1, max: 1.3, squash: 0.13, settleRate: 10 };

  /** The ore's entrance: it falls from above the screen and bounces on the ledge. */
  const DROP = {
    height: 17,
    seconds: 0.55,
    // Kit's outBounce touches down for the first time at 1/2.75 of the tween: that is when the ore becomes hittable.
    firstBounceAt: 1 / 2.75,
  };

  /** Shatter and descent timings and sizes; `core` and `plain` pick the row for the ore that broke. */
  const SHATTER = {
    plain: { chunks: 55, coins: 12, debris: 9, shake: 0.5, boomPitch: 1.1, payoutSound: 'coin', floaterSize: 30 },
    core: { chunks: 90, coins: 30, debris: 12, shake: 0.8, boomPitch: 0.75, payoutSound: 'win', floaterSize: 42 },
    descendAfter: 0.3, // a beat to watch the debris before the shaft moves
    forkAfter: 0.6, // the same beat before the fork's choice covers the scene
    descendSeconds: 0.65,
    gravity: 22,
  };

  /** Parallax layers, back to front. `scrollFactor` 1 moves with the shaft; less is further away, more is in front of it. */
  const LAYERS = [
    { id: 'far', z: -16, scrollFactor: 0.4, tileHeight: 16, contentStart: 0 },
    { id: 'caves', z: -8, scrollFactor: 0.7, tileHeight: 11, contentStart: 0 },
    { id: 'shaft', z: 0, scrollFactor: 1, tileHeight: SHAFT.stratumHeight, contentStart: -3 },
    { id: 'foreground', z: 7, scrollFactor: 1.4, tileHeight: 18, contentStart: 0 },
  ];

  /** Scenery colours (0xRRGGBB). Rock band lists are painted as wavy strata; glints are sparse mineral specks. */
  const PALETTE = {
    farBands: [0x1f1b52, 0x282263, 0x1a1646, 0x2f2976, 0x211c58],
    farGlints: [0x58e6d0, 0xb58bff],
    wallBands: [0x4f407a, 0x5f4e8c, 0x403268, 0x6b548c, 0x4b3c72, 0x775a80],
    wallGlints: [0xffd27a, 0x9be8ff],
    slabBands: [0x7a6aa6, 0x6a5a96, 0x8a79b3],
    slabGlints: [0xffd27a],
    caveRock: 0x3d3072,
    shaftRock: 0x7a66a8,
    pebble: 0x8a79b3,
    timber: 0x99653a,
    beam: 0x80532f,
    darkTimber: 0x4b2d19,
    flame: 0xffc46b,
    lanternGlow: 0xffb45e,
    foregroundDark: 0x1c1230,
    foregroundRim: 0x3a2858,
    mote: 0xffd9a0,
    teal: 0x4de2c5,
    violet: 0xc084fc,
    pink: 0xff7ac8,
    dust: [0xbfae9a, 0x8a79b3],
    coins: [0xffd24a, 0xfff2a8],
    critSparks: [0xffffff, 0xfff1c2],
    rimLight: 0x7fd8ff,
    bakedRim: 0x4fb6e6,
  };

  /** Floating text colours (CSS). */
  const TEXT = { hit: '#fff0c4', hot: '#ffb347', crit: '#ff7a9c', weak: '#fff6c8', vent: '#9fb4c8', coins: '#ffd24a' };

  // ---- VIEW RULES (pure: where things are and how they move) -----------------------------------------------------------------

  /** @param {number} combo @returns {number} pitch in Hz of the clink for that combo step (the ladder's top note repeats) */
  const clinkHz = (combo) => CLINK.baseHz * Math.pow(2, CLINK.semitones[Math.min(combo, CLINK.semitones.length - 1)] / 12);

  /**
   * @typedef {Object} DrillSlot
   * @property {number} dirX   unit direction from the ore centre to the slot
   * @property {number} dirY
   * @property {number} angle  the same direction in radians
   */

  /** @type {DrillSlot[]} */
  const DRILL_SLOTS = DRILL.slotAnglesDeg.map((degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return { dirX: Math.cos(angle), dirY: Math.sin(angle), angle };
  });

  /**
   * Distance from the ore centre to its surface along a slot. The ore is an ellipse in this view (stretched by
   * ORE_SHAPE.stretchY), so the radius along a direction is r / |(x, y / stretch)|.
   * @param {DrillSlot} slot
   * @param {number} oreScale 1 for a normal ore, CORE_ART.scale for a core
   * @returns {number} world units
   */
  const drillReach = (slot, oreScale) => (ORE_SHAPE.radius * oreScale * DRILL.surfaceInset) / Math.hypot(slot.dirX, slot.dirY / ORE_SHAPE.stretchY);

  /**
   * How far a drill's bit is from the ore surface at a point in its peck cycle: it springs back right after a peck (phase 0),
   * hangs there, then closes the gap linearly over the last stretch so it touches exactly when the next peck lands.
   * @param {number} phase 0..1 through the cycle
   * @param {boolean} isWorking false while there is no ore to drill
   * @returns {number} world units
   */
  const drillGap = (phase, isWorking) => {
    if (!isWorking) return DRILL.parkedGap;
    if (phase < DRILL.lungeFrom) return DRILL.recoil * (1 - Math.exp(-DRILL.recoilRate * phase));
    return DRILL.recoil * (1 - (phase - DRILL.lungeFrom) / (1 - DRILL.lungeFrom));
  };

  /** @param {number} level Pick level @returns {number} the pickaxe's scale */
  const pickSizeAt = (level) => PICK.baseSize + Math.min(level, PICK.sizeLevels) * PICK.sizePerLevel;

  /** @param {number} level Pick level @returns {number} 0xRRGGBB of the head (the last colour is kept past the table's end) */
  const pickHeadColorAt = (level) => PICK.headColors[Math.min(PICK.headColors.length - 1, Math.floor(level / PICK.levelsPerHead))];

  // ---- small generic helpers --------------------------------------------------------------------------------------------------

  /** Calls `make(index)` `count` times and returns the results. */
  const times = (count, make) => Array.from({ length: count }, (unused, index) => make(index));

  /** @param {number} hex 0xRRGGBB @returns {string} "#rrggbb" */
  const cssHex = (hex) => '#' + hex.toString(16).padStart(6, '0');

  /** Perceived brightness of a linear THREE.Color (Rec. 709 weights). */
  const luminance = (color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

  /**
   * How much to multiply a colour so it crosses the bloom threshold whatever its hue: dark hues (ruby, void) need more
   * than bright ones (gold).
   * @param {THREE.Color} color linear colour
   * @param {number} target brightness to reach
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  const glowBoost = (color, target, min, max) => clamp(target / luminance(color), min, max);

  // ---- VIEW BUILDERS (everything below draws; rules above decide) -------------------------------------------------------------

  /**
   * Sets up the camera, sky, lights and post-processing.
   * @param {Object} ctx the game context
   * @returns {{ camera: THREE.OrthographicCamera, setSky: function(number, number): void }}
   *   setSky(top, bottom): repaint the backdrop gradient (0xRRGGBB), used when the biome changes
   */
  function buildStage(ctx) {
    const { make, scene, THREE } = ctx;
    // Fit the shaft's width in portrait; in landscape widen the view with the aspect so the ore keeps its on-screen height.
    const camera = ctx.ortho((size) => (size.portrait ? VIEW.portraitWidth : VIEW.landscapeWidthPerAspect * size.aspect), 'width');
    const stage = make.stage({ sky: RULES.BIOMES[0].sky, sun: [-7, 10, 12], sunColor: 0xffc48a, sunIntensity: 1.05, ambient: 0.5, skyLight: 0x9a86ff, groundLight: 0x4a2c22, shadow: 9 });
    stage.follow({ x: 0, y: 0, z: 0 });
    stage.sun.shadow.mapSize.set(512, 512); // only the ore, tools and ledge cast shadows, so a small map is enough
    const rimLight = new THREE.DirectionalLight(make.color(PALETTE.rimLight), 1.3); // cool edge light from behind-right
    rimLight.position.set(9, 5, -4);
    scene.add(rimLight);
    ctx.post.bloom(0.3, 0.5, 0.95); // restrained: only crystals, lantern flames and crit sparks pass the threshold
    ctx.post.vignette(0.42);
    camera.position.set(0, VIEW.lookY + VIEW.rise, VIEW.distance);
    camera.lookAt(0, VIEW.lookY, 0);
    return { camera, setSky: stage.setSky };
  }

  /**
   * Paints wavy horizontal rock bands, light and dark speckles and a few mineral glints onto a canvas.
   * @param {CanvasRenderingContext2D} context2d
   * @param {number} width pixels
   * @param {number} height pixels
   * @param {number[]} bandColors 0xRRGGBB, cycled top to bottom
   * @param {number[]} glintColors 0xRRGGBB
   */
  function paintStrata(context2d, width, height, bandColors, glintColors) {
    const BAND = { firstTop: -10, minHeight: 20, maxHeight: 62, stepX: 8 };
    const SPECKLE_AREA = 170; // one speckle per this many pixels
    const GLINTS = 36;
    // Each band is filled from its wavy top edge down to the bottom, so later bands overpaint earlier ones.
    // The stride is random, so the band count is not known up front: a loop with a running top edge, not a map.
    for (let top = BAND.firstTop, band = 0; top < height; band++, top += rand(BAND.minHeight, BAND.maxHeight)) {
      const amplitude = rand(2, 7);
      // A whole number of waves across the width, so the texture tiles horizontally without a seam.
      const frequency = (TAU * randInt(1, 3)) / width;
      const phase = rand(TAU);
      context2d.fillStyle = cssHex(bandColors[band % bandColors.length]);
      context2d.beginPath();
      context2d.moveTo(0, height);
      times(Math.floor(width / BAND.stepX) + 1, (step) => step * BAND.stepX).forEach((x) => context2d.lineTo(x, top + amplitude * Math.sin(x * frequency + phase)));
      context2d.lineTo(width, height);
      context2d.fill();
    }
    times(Math.floor((width * height) / SPECKLE_AREA), () => {
      context2d.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.17)';
      context2d.fillRect(rand(width), rand(height), rand(1, 6), rand(1, 3));
    });
    times(GLINTS, () => {
      context2d.fillStyle = cssHex(pick(glintColors));
      context2d.fillRect(rand(width), rand(height), 2, 2);
    });
  }

  /**
   * Builds the four parallax layers of the shaft, the dust motes and the breathing glows.
   * @param {Object} ctx the game context
   * @returns {{ timberMaterial: THREE.Material, setScroll: function(number): void, spillOreLight: function(THREE.Color): void,
   *   update: function(number, number, number): void }}
   *   setScroll(distance): world units the shaft has descended; spillOreLight(glow): tint the unlit scenery toward the ore's
   *   glow; update(time, dt, riseSpeed): animate glows and motes (riseSpeed = how fast the shaft is scrolling, units/second)
   */
  function buildScenery(ctx) {
    const { make, THREE } = ctx;

    /** A material showing a painted strata texture; lit for surfaces the sun and ore light should shade, unlit otherwise. */
    const strataMaterial = (bandColors, glintColors, width, height, { isLit = false, repeatX = 1 } = {}) => {
      const material = isLit ? make.mat(0xffffff, { fresh: true, rough: 0.92 }) : make.unlit(0xffffff, { fresh: true });
      material.map = make.canvasTexture(width, height, (context2d) => paintStrata(context2d, width, height, bandColors, glintColors), { repeat: [repeatX, 1] });
      return material;
    };
    const materials = {
      far: strataMaterial(PALETTE.farBands, PALETTE.farGlints, 256, 512, { repeatX: 2 }),
      wall: strataMaterial(PALETTE.wallBands, PALETTE.wallGlints, 128, 512),
      slab: strataMaterial(PALETTE.slabBands, PALETTE.slabGlints, 256, 64, { isLit: true }),
      timber: make.mat(PALETTE.timber, { rough: 0.8 }),
      beam: make.unlit(PALETTE.beam),
      darkTimber: make.unlit(PALETTE.darkTimber),
      flame: make.unlit(PALETTE.flame, { bright: 2.6 }),
      foregroundDark: make.unlit(PALETTE.foregroundDark),
      foregroundRim: make.unlit(PALETTE.foregroundRim),
      // Boulders are unlit for speed: their facet shading is baked into vertex colours once (see addBakedRock).
      baked: Object.assign(make.unlit(0xffffff, { fresh: true }), { vertexColors: true }),
    };

    // Baked lighting: a warm key from the upper left and a cool rim from the right, matching the real lights on the ore.
    const BAKE = { ambient: 0.42, key: 0.8, rim: 0.35 };
    const keyDirection = new THREE.Vector3(-0.5, 0.7, 0.5).normalize();
    const rimDirection = new THREE.Vector3(0.85, 0.3, 0.1).normalize();
    const rimColor = make.color(PALETTE.bakedRim);

    /**
     * Adds a boulder with its shading baked in. The transform is applied to the geometry (not the mesh) so the baked
     * normals are the ones the viewer sees.
     * @param {THREE.Object3D} parent
     * @param {{ radius: number, color: number, at: number[], rotation: number[], scale: number[] }} rock
     */
    const addBakedRock = (parent, rock) => {
      const geometry = new THREE.IcosahedronGeometry(rock.radius, 0);
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rock.rotation));
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(), rotation, new THREE.Vector3(...rock.scale)));
      geometry.computeVertexNormals();
      const base = make.color(rock.color);
      const normals = geometry.attributes.normal;
      const normal = new THREE.Vector3();
      const colors = times(normals.count, (index) => {
        normal.fromBufferAttribute(normals, index);
        const key = BAKE.ambient + BAKE.key * Math.max(0, normal.dot(keyDirection));
        // Squared so the rim is a thin edge highlight rather than a second fill light.
        const rim = BAKE.rim * Math.pow(Math.max(0, normal.dot(rimDirection)), 2);
        return [base.r * key + rimColor.r * rim, base.g * key + rimColor.g * rim, base.b * key + rimColor.b * rim];
      }).flat();
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      make.mesh(geometry, materials.baked, { parent, at: rock.at, shadow: false });
    };

    /** Glow sprites whose opacity breathes: `{ sprite, baseOpacity, phase }`. */
    const breathingGlows = [];
    const addBreathingGlow = (parent, color, size, at, baseOpacity, phase) =>
      breathingGlows.push({ sprite: make.glow(color, size, { parent, at, opacity: baseOpacity }), baseOpacity, phase });

    const shardGeometry = new THREE.ConeGeometry(1, 1, 5);
    shardGeometry.translate(0, 0.5, 0); // base at the origin so shards grow out of whatever they sit on

    /**
     * Adds a fan of glowing crystal shards.
     * @param {THREE.Object3D} parent
     * @param {{ at: number[], color: number, shards: number, lean: number, size: number, hasHalo?: boolean }} cluster
     *   lean: radians the whole fan tilts; hasHalo adds a breathing glow sprite
     * @param {function(): number} random 0..1 source (seeded per tile)
     */
    const addCrystalCluster = (parent, cluster, random) => {
      const SHARD = { thickness: 0.22, minLength: 0.7, lengthRange: 0.9, fanStep: 0.5, fanJitter: 0.2 };
      const HALO = { size: 3, opacity: 0.22 };
      const group = make.group({ parent, at: cluster.at });
      group.rotation.z = cluster.lean;
      const material = make.unlit(cluster.color, { bright: glowBoost(make.color(cluster.color), 1.05, 1.1, 2.8) });
      times(cluster.shards, (index) => {
        const shard = make.mesh(shardGeometry, material, { parent: group, shadow: false });
        shard.scale.set(SHARD.thickness * cluster.size, cluster.size * (SHARD.minLength + random() * SHARD.lengthRange), SHARD.thickness * cluster.size);
        // Spread the shards evenly around the fan's centre line, with a little jitter.
        shard.rotation.z = (index - (cluster.shards - 1) / 2) * SHARD.fanStep + (random() - 0.5) * SHARD.fanJitter;
      });
      if (cluster.hasHalo) addBreathingGlow(group, cluster.color, HALO.size * cluster.size, [0, 0.5 * cluster.size, 0.4], HALO.opacity, random() * TAU);
    };

    const randomTurn = (random) => random() * TAU;
    const halfWidth = SHAFT.halfWidth;

    /**
     * What goes in one tile of each layer, keyed by LAYERS id. Positions are art layout in world units relative to the tile's
     * origin; in the shaft layer the origin is the top of the ledge the ore rests on.
     * @type {Object<string, function(THREE.Group, number, function(): number): void>}  (tile, tileHeight, random)
     */
    const tileBuilders = {
      // Far cavern wall: one textured plane and two dim crystal fans.
      far(tile, tileHeight, random) {
        make.mesh(new THREE.PlaneGeometry(18, tileHeight), materials.far, { parent: tile, at: [0, tileHeight / 2, 0], shadow: false });
        [
          { at: [-2.4, tileHeight * 0.3, 0.5], color: PALETTE.teal, shards: 2, lean: 0.2, size: 1.3 },
          { at: [2.2, tileHeight * 0.78, 0.5], color: PALETTE.violet, shards: 2, lean: -0.3, size: 1.1 },
        ].forEach((cluster) => addCrystalCluster(tile, cluster, random));
      },
      // Cave masses: two tall boulders either side and a pink crystal fan.
      caves(tile, tileHeight, random) {
        [
          { x: -4.4, heightFraction: 0.2, radius: 2.7 },
          { x: 4.7, heightFraction: 0.62, radius: 3 },
        ].forEach((mass) =>
          addBakedRock(tile, { radius: mass.radius, color: PALETTE.caveRock, at: [mass.x, mass.heightFraction * tileHeight, 0], rotation: [randomTurn(random), randomTurn(random), 0], scale: [1, 1.6, 0.6] })
        );
        addCrystalCluster(tile, { at: [2.9, tileHeight * 0.3, 1.5], color: PALETTE.pink, shards: 2, lean: 0.8, size: 1.2 }, random);
      },
      // The shaft itself: rock walls, timber frame, the ledge, a lantern and two crystal fans.
      shaft(tile, tileHeight, random) {
        [-1, 1].forEach((side) => {
          make.box(3.4, tileHeight, 4, materials.wall, { parent: tile, at: [side * (halfWidth + 1.7), tileHeight / 2 - 3, -1], shadow: false });
          // One wall boulder per side, at different heights so the shaft does not look mirrored.
          addBakedRock(tile, { radius: 1.15, color: PALETTE.shaftRock, at: [side * (halfWidth + 0.3), side > 0 ? 2.2 : 6.6, 0.9], rotation: [randomTurn(random), randomTurn(random), 0], scale: [0.8, 1.35, 0.8] });
          make.box(0.5, 9.8, 0.5, materials.darkTimber, { parent: tile, at: [side * (halfWidth - 0.45), 4.9, -1.7], shadow: false }); // post
          const brace = make.box(0.34, 2.6, 0.34, materials.darkTimber, { parent: tile, at: [side * 3.6, -1.7, 0.6], shadow: false });
          brace.rotation.z = -side * 0.75; // leans in under the ledge
        });
        make.box(2 * halfWidth + 0.2, 0.6, 0.7, materials.beam, { parent: tile, at: [0, 9.8, -1.7], shadow: false }); // crossbeam
        // The ledge: a stone slab under a plank deck. These two receive the ore's shadow.
        make.box(2 * halfWidth + 0.4, 0.9, 3.6, materials.slab, { parent: tile, at: [0, -0.63, -0.3] });
        make.box(2 * halfWidth + 0.2, 0.18, 3.7, materials.timber, { parent: tile, at: [0, -0.09, -0.3] });
        addBakedRock(tile, { radius: 0.42, color: PALETTE.pebble, at: [-3.9, 0.22, 0.9], rotation: [randomTurn(random), randomTurn(random), 0], scale: [1, 0.8, 1] });
        // Lantern hanging from the crossbeam: [width, height, depth, material, y], top to bottom.
        const LANTERN = { x: -3.1, z: -1.2, flameY: 8.22 };
        [
          [0.05, 1.1, 0.05, materials.darkTimber, 9.0], // cord
          [0.52, 0.12, 0.52, materials.darkTimber, 8.5], // cap
          [0.32, 0.44, 0.32, materials.flame, LANTERN.flameY],
          [0.52, 0.1, 0.52, materials.darkTimber, 7.95], // base
        ].forEach(([width, height, depth, material, y]) => make.box(width, height, depth, material, { parent: tile, at: [LANTERN.x, y, LANTERN.z], shadow: false }));
        addBreathingGlow(tile, PALETTE.lanternGlow, 5, [LANTERN.x, LANTERN.flameY, LANTERN.z + 0.6], 0.3, 1);
        [
          { at: [halfWidth - 0.1, 5.2, 0.9], color: PALETTE.teal, shards: 3, lean: 1.1, size: 1.1, hasHalo: true },
          { at: [-halfWidth + 0.1, 1.5, 0.9], color: PALETTE.violet, shards: 2, lean: -1.0, size: 0.9 },
        ].forEach((cluster) => addCrystalCluster(tile, cluster, random));
      },
      // Foreground framing: dark boulders at the screen edges, each with a slightly larger, lighter copy behind it for a soft
      // two-tone edge.
      foreground(tile, tileHeight, random) {
        const COPIES = [
          { material: materials.foregroundRim, grow: 1.07, z: -0.6 },
          { material: materials.foregroundDark, grow: 1, z: 0 },
        ];
        [
          { x: -7, heightFraction: 0.2, radius: 2.5 },
          { x: 7.1, heightFraction: 0.68, radius: 2.8 },
        ].forEach((boulder) => {
          const rotation = times(3, () => randomTurn(random));
          COPIES.forEach((copy) => {
            const mesh = make.ico(boulder.radius * copy.grow, 1, copy.material, { parent: tile, at: [boulder.x, boulder.heightFraction * tileHeight, copy.z], shadow: false });
            mesh.rotation.set(...rotation);
            mesh.scale.set(0.8, 1.5, 0.5);
          });
        });
      },
    };

    /**
     * Builds one parallax layer: enough copies of its tile to cover the view at any scroll position.
     * @returns {{ root: THREE.Group, scrollFactor: number, tileHeight: number }}
     */
    const TILE_SEED = 11; // any whole number: it only has to be the same for every tile of a layer
    const buildLayer = (layer, layerIndex) => {
      const root = make.group({ at: [0, 0, layer.z] });
      // Tile i sits at ledgeY + i * tileHeight and its content starts `contentStart` above that. Cover the visible band
      // plus one extra tile below, because the layer shifts up by up to one tile before it wraps.
      const firstTile = Math.floor((VIEW.bottom - SHAFT.ledgeY - layer.contentStart) / layer.tileHeight) - 1;
      const lastTile = Math.ceil((VIEW.top - SHAFT.ledgeY - layer.contentStart) / layer.tileHeight) - 1;
      times(lastTile - firstTile + 1, (offset) => firstTile + offset).forEach((tileIndex) => {
        const tile = make.group({ parent: root, at: [0, SHAFT.ledgeY + tileIndex * layer.tileHeight, 0] });
        // The same seed for every tile of a layer: identical tiles are what makes the wrap invisible.
        tileBuilders[layer.id](tile, layer.tileHeight, Kit.rng(TILE_SEED + layerIndex).next);
      });
      return { root, scrollFactor: layer.scrollFactor, tileHeight: layer.tileHeight };
    };
    const layers = LAYERS.map(buildLayer);

    // Dust motes: one instanced mesh of small additive quads drifting upward.
    const MOTES = { count: 36, halfHeight: 13, sway: 0.6, opacity: 0.6, quad: 0.1 };
    const moteMesh = make.instanced(new THREE.PlaneGeometry(MOTES.quad, MOTES.quad), make.unlit(PALETTE.mote, { additive: true, opacity: MOTES.opacity }), MOTES.count);
    const motes = times(MOTES.count, () => ({ x: rand(-5, 5), y: rand(-MOTES.halfHeight, MOTES.halfHeight), z: rand(-1, 5), size: rand(0.5, 1.7), phase: rand(TAU), riseSpeed: rand(0.15, 0.5) }));

    return {
      timberMaterial: materials.timber,
      setScroll(distance) {
        // Each layer moves at its own speed and wraps by one tile, so the shaft can descend for ever.
        layers.forEach((layer) => (layer.root.position.y = (distance * layer.scrollFactor) % layer.tileHeight));
      },
      spillOreLight(glow) {
        // The walls and boulders are unlit, so fake the ore's light on them by tinting their textures toward its glow.
        const SPILL = 0.22;
        materials.wall.color.setRGB(1, 1, 1).lerp(glow, SPILL);
        materials.baked.color.copy(materials.wall.color);
      },
      update(time, dt, riseSpeed) {
        // Per-frame hot path: plain loops, no allocation.
        for (const glow of breathingGlows) glow.sprite.material.opacity = glow.baseOpacity * (0.8 + 0.3 * Math.sin(time * 1.6 + glow.phase));
        for (let index = 0; index < motes.length; index++) {
          const mote = motes[index];
          // While the shaft descends the motes streak upward with it, which sells the speed.
          mote.y += (mote.riseSpeed + riseSpeed) * dt;
          if (mote.y > MOTES.halfHeight) mote.y -= 2 * MOTES.halfHeight;
          moteMesh.place(index, mote.x + Math.sin(time * 0.4 + mote.phase) * MOTES.sway, mote.y, mote.z, mote.size * (0.6 + 0.4 * Math.sin(time * 1.3 + mote.phase)));
        }
        moteMesh.commit();
      },
    };
  }

  /**
   * Builds the ore: a fresh faceted boulder per depth with glowing gem facets, crystal shards that snap off and fissures that
   * open as it takes damage, plus the lights and flashes that belong to it.
   * @param {Object} ctx the game context
   * @returns {Object} `{ root, rock, scale(), rebuild(spec), centre(out), openCrack(index), snapCrystal(), flashAt(point),
   *   flareNova(), showWeakPoint(point, radius), hideWeakPoint(), update(time, dt, feel) }` (each documented at its definition)
   */
  function createOreView(ctx) {
    const { make, scene, THREE } = ctx;
    const UP = new THREE.Vector3(0, 1, 0);
    const FORWARD = new THREE.Vector3(0, 0, 1);
    const WHITE = new THREE.Color(1, 1, 1);

    const root = make.group({ at: [0, SHAFT.ledgeY, 0] }); // pivots on the ledge so the squash stays grounded
    const rock = make.group({ parent: root }); // the part that is rebuilt per ore, wobbles and is hit-tested
    const bodyMaterial = Object.assign(make.mat(0xffffff, { fresh: true, flat: true, rough: 0.36, metal: 0.12 }), { vertexColors: true });
    const gemMaterial = make.mat(0xffffff, { fresh: true, flat: true, rough: 0.2 });
    const crackMaterial = make.unlit(0xffffff, { fresh: true });
    const shardGeometry = new THREE.ConeGeometry(1, 1, 5);
    shardGeometry.translate(0, 0.5, 0); // base at the origin so crystals grow out of the surface
    const segmentGeometry = new THREE.BoxGeometry(1, 1, 1);

    const backGlow = make.glow(0xffffff, 9, { parent: root, at: [0, ORE_SHAPE.radius, -1.5], opacity: 0.4 });
    const hitFlash = make.glow(0xffffff, 1, { opacity: 0, depthTest: false });
    const nova = make.glow(0xffffff, 1, { opacity: 0, depthTest: false, at: [0, SHAFT.ledgeY + ORE_SHAPE.radius, 2] });
    const chamberLight = new THREE.PointLight(0xffffff, 1, 18, 1.5); // the ore lights its own chamber
    chamberLight.position.set(0, SHAFT.ledgeY + 3.2, 4.5);
    scene.add(chamberLight);

    const raycaster = new THREE.Raycaster();
    /** Render-only state of the current ore. */
    const view = { scale: 1, gemGlow: 1, crystals: [], cracks: [], flash: 0, nova: 0, weakRadius: 0 };
    // The weak point: drawn over everything (no depth test) so facets and crystals never hide the thing to aim at.
    const weakCore = make.glow(WEAK_ART.color, WEAK_ART.coreSize, { opacity: 0, depthTest: false });
    const weakHalo = make.glow(WEAK_ART.color, WEAK_ART.haloSize, { opacity: 0, depthTest: false });

    /**
     * The rock-local point where a ray from outside, travelling toward the centre against `direction`, meets the boulder,
     * lifted slightly off the surface. Falls back to the nominal radius if the ray somehow misses.
     */
    const surfacePoint = (direction, solidMeshes) => {
      const RAY_START = 12;
      const LIFT = 0.04; // keeps cracks and crystals from z-fighting the facets
      raycaster.set(direction.clone().multiplyScalar(RAY_START), direction.clone().negate());
      const hit = raycaster.intersectObjects(solidMeshes, false)[0];
      return hit ? hit.point.clone().addScaledVector(direction, LIFT) : direction.clone().multiplyScalar(ORE_SHAPE.radius);
    };

    /** Pushes one icosphere vertex into the ore's lumpy, flat-based shape. `phases` are this ore's three noise offsets. */
    const deformVertex = (point, phases) => {
      point.multiplyScalar(1 + 0.1 * Math.sin(point.x * 1.3 + phases[0]) * Math.sin(point.y * 1.1 + phases[1]) + 0.07 * Math.sin(point.z * 1.7 + phases[2]));
      point.y = Math.max(point.y * ORE_SHAPE.stretchY, -ORE_SHAPE.radius * ORE_SHAPE.baseCut);
      point.z *= ORE_SHAPE.squashZ;
      return point;
    };

    /** A non-indexed geometry from faces (three corner points each); `shadeOf` adds a per-face grey vertex colour. */
    const geometryFromFaces = (faces, shadeOf) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flatMap((face) => face.corners.flatMap((corner) => [corner.x, corner.y, corner.z])), 3));
      if (shadeOf) geometry.setAttribute('color', new THREE.Float32BufferAttribute(faces.flatMap((face) => times(9, () => shadeOf(face))), 3));
      geometry.computeVertexNormals();
      return geometry;
    };

    /**
     * Builds the boulder's two meshes: a shaded rock body and the facets that are pure glowing ore.
     * @returns {{ body: THREE.Mesh, gems: THREE.Mesh, lowestY: number }}
     */
    const buildBoulder = (art) => {
      // Detail-1 icosphere positions are non-indexed: every three vertices are one triangle.
      const source = new THREE.IcosahedronGeometry(ORE_SHAPE.radius, 1).attributes.position;
      const phases = times(3, () => rand(TAU));
      const edgeA = new THREE.Vector3();
      const edgeB = new THREE.Vector3();
      const facesFront = (face) => face.normal.z > ORE_SHAPE.frontNormalZ;
      const faces = times(source.count / 3, (faceIndex) => {
        const corners = times(3, (corner) => deformVertex(new THREE.Vector3().fromBufferAttribute(source, faceIndex * 3 + corner), phases));
        const normal = new THREE.Vector3().crossVectors(edgeA.subVectors(corners[1], corners[0]), edgeB.subVectors(corners[2], corners[0])).normalize();
        // Random per-face grey, a touch lighter on upward faces, gives the rock its faceted look under one material.
        return { corners, normal, shade: rand(0.6, 1.15) + normal.y * 0.12 };
      });
      // Only facets the player can see become gems; if the dice give none, promote one so every ore shows what it is made of.
      const gemFaces = new Set(faces.filter((face) => facesFront(face) && Math.random() < art.gemChance));
      if (!gemFaces.size) gemFaces.add(faces.find(facesFront));
      const body = new THREE.Mesh(geometryFromFaces(faces.filter((face) => !gemFaces.has(face)), (face) => face.shade), bodyMaterial);
      const gems = new THREE.Mesh(geometryFromFaces([...gemFaces]), gemMaterial);
      body.castShadow = true;
      body.userData.ownsGeometry = gems.userData.ownsGeometry = true; // disposed on rebuild; shards and cracks share theirs
      return { body, gems, lowestY: Math.min(...faces.flatMap((face) => face.corners.map((corner) => corner.y))) };
    };

    /** Roots `count` crystal shards on the upper front of the boulder, pointing roughly outward. */
    const growCrystals = (solidMeshes, count) =>
      times(count, () => {
        const outward = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-0.1, 1)).normalize();
        const crystal = make.mesh(shardGeometry, gemMaterial, { parent: rock });
        crystal.position.copy(surfacePoint(outward, solidMeshes)).multiplyScalar(ORE_SHAPE.crystalInset);
        const tilt = new THREE.Vector3(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3));
        crystal.quaternion.setFromUnitVectors(UP, outward.clone().add(tilt).normalize());
        const thickness = rand(0.3, 0.55);
        crystal.scale.set(thickness, rand(1.1, 2.1), thickness);
        return crystal;
      });

    /**
     * Builds one hidden fissure: two jagged arms running opposite ways from a point on the front face, each segment a thin
     * glowing box laid along the surface.
     */
    const carveFissure = (solidMeshes) => {
      const fissure = make.group({ parent: rock });
      fissure.visible = false;
      const STEP = 0.2; // how far each segment moves across the face (in direction space)
      const TURN = 0.9; // max change of heading per segment, radians
      const start = new THREE.Vector3(rand(-0.55, 0.55), rand(-0.45, 0.6), 1).normalize();
      const startHeading = rand(TAU);
      [0, Math.PI].forEach((armTurn) => {
        const direction = start.clone();
        let heading = startHeading + armTurn;
        let previous = surfacePoint(direction, solidMeshes);
        // A random walk: each segment starts where the last one ended, so this is a loop with running state.
        for (let segmentIndex = 0; segmentIndex < CRACK_ART.segmentsPerArm; segmentIndex++) {
          heading += rand(-TURN, TURN);
          direction.x += Math.cos(heading) * STEP;
          direction.y += Math.sin(heading) * STEP;
          direction.normalize();
          const point = surfacePoint(direction, solidMeshes);
          const segment = make.mesh(segmentGeometry, crackMaterial, { parent: fissure, shadow: false });
          const width = CRACK_ART.width * (1 - segmentIndex / (CRACK_ART.segmentsPerArm + 1)); // arms taper toward their tips
          segment.position.lerpVectors(previous, point, 0.5);
          segment.quaternion.setFromUnitVectors(FORWARD, point.clone().sub(previous).normalize());
          segment.scale.set(width, width, previous.distanceTo(point) + width * 0.5); // slight overlap hides the joints
          previous = point;
        }
      });
      return fissure;
    };

    /** Recolours the shared materials and lights for a tier. */
    const tint = (spec, art) => {
      const glow = make.color(spec.tier.glow);
      const bodyColor = make.color(spec.tier.color);
      bodyMaterial.color.copy(bodyColor);
      bodyMaterial.emissive.copy(bodyColor);
      bodyMaterial.emissiveIntensity = art.bodyGlow;
      gemMaterial.color.copy(glow).multiplyScalar(0.5);
      gemMaterial.emissive.copy(glow);
      view.gemGlow = glowBoost(glow, 1, 1, 2.6) * art.gemBoost;
      crackMaterial.color.copy(glow).lerp(WHITE, 0.4).multiplyScalar(3); // white-hot, well past the bloom threshold
      backGlow.material.color.copy(glow);
      chamberLight.color.copy(glow);
      hitFlash.material.color.copy(glow).lerp(WHITE, 0.5);
      nova.material.color.copy(glow);
      return glow;
    };

    return {
      root,
      rock,
      /** @returns {number} the current ore's drawn scale (cores are larger) */
      scale: () => view.scale,
      /**
       * Replaces the boulder with a new one for `spec`.
       * @param {OreSpec} spec
       * @returns {THREE.Color} the tier's glow colour (linear), for anything else that should take the ore's light
       */
      rebuild(spec) {
        const art = spec.isCore ? CORE_ART : PLAIN_ORE_ART;
        rock.children.slice().forEach((child) => {
          rock.remove(child);
          if (child.userData.ownsGeometry) child.geometry.dispose();
        });
        const { body, gems, lowestY } = buildBoulder(art);
        // The meshes are raycast before they join `rock`, while their world matrix is still identity, so hits are rock-local.
        const solidMeshes = [body, gems];
        view.crystals = growCrystals(solidMeshes, art.crystals);
        view.cracks = times(RULES.CRACKS.stages, () => carveFissure(solidMeshes));
        rock.add(body, gems);
        rock.position.y = -lowestY - ORE_SHAPE.sink; // rest the flat base on the ledge
        view.scale = art.scale;
        return tint(spec, art);
      },
      /** Writes the ore's world-space centre into `out` (and returns it). */
      centre: (out) => out.set(0, SHAFT.ledgeY + rock.position.y * view.scale, 0),
      /** Shows the fissure of a crack stage (0-based). */
      openCrack(stageIndex) {
        view.cracks[stageIndex].visible = true;
      },
      /** Hides one remaining crystal. @returns {?THREE.Vector3} where it was (world space), or null when none are left */
      snapCrystal() {
        const crystal = view.crystals.pop();
        if (!crystal) return null;
        crystal.visible = false;
        return crystal.getWorldPosition(new THREE.Vector3());
      },
      /** Starts the white flash of a critical hit at a world point. */
      flashAt(point) {
        const FLASH_START = 1.4; // above 1 so the flash holds at full brightness for a moment
        view.flash = FLASH_START;
        hitFlash.position.copy(point).setZ(point.z + 0.3);
      },
      /** Starts the burst of light left behind when the ore shatters. */
      flareNova() {
        view.nova = 1;
      },
      /**
       * Shows the weak point at a world position.
       * @param {{ x: number, y: number }} point centre, world units
       * @param {number} radius how close a strike must land, world units (the halo is drawn at this size)
       */
      showWeakPoint(point, radius) {
        view.weakRadius = radius;
        weakCore.position.set(point.x, point.y, WEAK_ART.frontZ);
        weakHalo.position.copy(weakCore.position);
      },
      /** Hides the weak point (between ores). */
      hideWeakPoint() {
        view.weakRadius = 0;
      },
      /**
       * Per-frame animation.
       * @param {number} time game seconds
       * @param {number} dt frame seconds
       * @param {{ punch: number, heat: number, hurt: number }} feel  punch 0..PUNCH.max, heat 0..1, hurt = share of HP lost
       */
      update(time, dt, feel) {
        // Squash against the ledge and widen to keep the volume: scale y by s and x / z by 1 / sqrt(s).
        const squash = 1 - PUNCH.squash * feel.punch;
        const width = view.scale / Math.sqrt(squash);
        root.scale.set(width, view.scale * squash, width);
        rock.rotation.y = Math.sin(time * 0.5) * 0.2; // slow turn so the facets catch the light
        rock.rotation.z = Math.sin(time * 47) * 0.035 * feel.punch; // fast shudder that dies with the punch
        // The gems brighten as the ore heats up and breaks down: the player can read both without the HUD.
        gemMaterial.emissiveIntensity = view.gemGlow * (1 + 0.08 * Math.sin(time * 3) + 0.25 * feel.hurt + 0.2 * feel.punch + 0.3 * feel.heat);
        backGlow.material.opacity = 0.16 + 0.08 * feel.punch + 0.14 * feel.heat;
        view.nova = Math.max(0, view.nova - dt * 2.6);
        // While the ore is gone the chamber is lit only by the fading nova.
        chamberLight.intensity = root.visible ? 0.45 + 0.3 * feel.hurt + 0.7 * feel.punch + 0.35 * feel.heat : 3 * view.nova;
        nova.material.opacity = view.nova * 0.5;
        nova.scale.setScalar(lerp(14, 4, view.nova));
        view.flash = Math.max(0, view.flash - dt * 9);
        hitFlash.material.opacity = Math.min(1, view.flash);
        hitFlash.scale.setScalar(1.5 + (1.6 - view.flash) * 1.8);
        // The halo breathes between the hit radius and a little beyond, so its inner edge shows how close is close enough.
        const pulse = 0.5 + 0.5 * Math.sin(time * WEAK_ART.pulsePerSecond);
        weakCore.material.opacity = view.weakRadius ? 0.95 : 0;
        weakHalo.material.opacity = view.weakRadius ? 0.35 + 0.3 * pulse : 0;
        weakHalo.scale.setScalar(view.weakRadius * 2 * (1.5 + 0.5 * pulse));
      },
    };
  }

  /**
   * Builds the pickaxe, which snaps to its strike pose on a tap and then relaxes.
   * @param {Object} ctx the game context
   * @param {THREE.Material} handleMaterial shared with the mine's timber
   * @returns {{ strikeAt: function({x: number, y: number, z: number}, number): void, reskin: function(number): void, update: function(number): void }}
   *   strikeAt(point, side): swing so the tip lands on `point`, from the right (side 1) or left (-1); reskin(level): size and
   *   head colour for a Pick level; update(dt)
   */
  function createPickView(ctx, handleMaterial) {
    const { make } = ctx;
    const group = make.group();
    const headMaterial = make.mat(0xffffff, { fresh: true, metal: 0.45, rough: 0.3 });
    make.box(0.17, 2.3, 0.17, handleMaterial, { parent: group, at: [0, 1.15, 0] });
    make.box(1.5, 0.3, 0.26, headMaterial, { parent: group, at: [-0.1, PICK.tip.y, 0] });
    make.cone(0.17, 0.5, headMaterial, { parent: group, at: [-1.05, PICK.tip.y, 0], seg: 4 }).rotation.z = Math.PI / 2;
    const pose = { swing: 0, side: 1, size: 1 };
    const applyScale = () => group.scale.set(pose.side * pose.size, pose.size, pose.size); // a negative x scale mirrors the pick

    const pickView = {
      strikeAt(point, side) {
        // Solve for the hand position: rotate the tip offset by the strike angle and subtract it from the target,
        // so at full swing the tip is exactly on `point`.
        const angle = side * PICK.strikeAngle;
        const tipX = side * PICK.tip.x * pose.size;
        const tipY = PICK.tip.y * pose.size;
        group.position.set(point.x - (tipX * Math.cos(angle) - tipY * Math.sin(angle)), point.y - (tipX * Math.sin(angle) + tipY * Math.cos(angle)), point.z + 0.5);
        pose.side = side;
        pose.swing = 1;
        applyScale();
      },
      reskin(level) {
        pose.size = pickSizeAt(level);
        headMaterial.color.copy(make.color(pickHeadColorAt(level)));
        applyScale();
      },
      update(dt) {
        pose.swing = Math.max(0, pose.swing - dt * PICK.swingDecay);
        // Squaring the swing makes the recoil start fast and settle gently.
        group.rotation.z = pose.side * lerp(PICK.restAngle, PICK.strikeAngle, pose.swing * pose.swing);
      },
    };
    return pickView;
  }

  /**
   * Builds the drill bots: little thruster craft that hover at their slot around the ore and peck it.
   * @param {Object} ctx the game context
   * @returns {{ update: function(number, number, Object): void }}
   *   update(time, dt, { activeCount, isWorking, centre, oreScale, onPeck(slot) }): onPeck fires each time a drill's bit lands
   */
  function createDrillViews(ctx) {
    const { make, THREE } = ctx;
    const bitGeometry = new THREE.ConeGeometry(0.2, 0.7, 6);
    bitGeometry.rotateZ(-Math.PI / 2);
    bitGeometry.translate(-0.35, 0, 0); // tip at the origin pointing +x, so a drill's position is where its bit touches
    const bitMaterial = make.mat(0xe8f6ff, { metal: 0.5, rough: 0.25, flat: true, emissive: PALETTE.teal, emissiveIntensity: 0.4 });
    const drills = DRILL_SLOTS.map((slot, index) => {
      const group = make.group();
      group.visible = false;
      const bit = make.mesh(bitGeometry, bitMaterial, { parent: group });
      make.box(0.3, 0.56, 0.56, 0x232c4a, { parent: group, at: [-0.74, 0, 0] }); // collar
      make.box(0.8, 0.46, 0.46, 0x2fb7a3, { parent: group, at: [-1.2, 0, 0], metal: 0.3, rough: 0.4 }); // body
      make.box(0.14, 0.3, 0.3, make.unlit(0xff9d3c, { bright: 2.4 }), { parent: group, at: [-1.66, 0, 0], shadow: false }); // thruster
      group.rotation.z = slot.angle + Math.PI; // face the ore
      // phase: 0..1 through the peck cycle, staggered so the crew never pecks in unison. arrival: 0 (away) .. 1 (in place).
      return { group, bit, slot, phase: index / DRILL_SLOTS.length, arrival: 0, bobOffset: index * 1.7 };
    });

    return {
      update(time, dt, { activeCount, isWorking, centre, oreScale, onPeck }) {
        // Per-frame hot path: a plain loop over at most six drills.
        for (let index = 0; index < drills.length; index++) {
          const drill = drills[index];
          drill.arrival = damp(drill.arrival, index < activeCount ? 1 : 0, DRILL.flyInRate, dt);
          drill.group.visible = drill.arrival > 0.02;
          if (!drill.group.visible) continue;
          if (isWorking) {
            drill.phase += dt / DRILL.peckSeconds;
            if (drill.phase >= 1) {
              drill.phase -= 1;
              onPeck(drill.slot);
            }
          }
          const { dirX, dirY } = drill.slot;
          const distance = drillReach(drill.slot, oreScale) + drillGap(drill.phase, isWorking) + (1 - drill.arrival) * DRILL.flyInDistance;
          const bob = Math.sin(time * 3 + drill.bobOffset) * DRILL.bobAmount; // sideways, perpendicular to the slot direction
          drill.group.position.set(centre.x + dirX * distance - dirY * bob, centre.y + dirY * distance + dirX * bob, 0.5);
          drill.bit.rotation.x += dt * DRILL.spinPerSecond;
        }
      },
    };
  }

  /**
   * Builds the pooled chunks that tumble out of a shattered ore and bounce once on the ledge.
   * @param {Object} ctx the game context
   * @returns {{ scatter: function(THREE.Vector3, OreSpec, number): void, update: function(number): void }}
   *   scatter(origin, spec, count): throw `count` chunks in the ore's colours; update(dt)
   */
  function createDebris(ctx) {
    const { make, THREE } = ctx;
    // Two shared materials, alternated: rock-coloured chunks and glowing gem chunks.
    const materials = [make.mat(0xffffff, { fresh: true, flat: true, rough: 0.4 }), make.mat(0xffffff, { fresh: true, flat: true, rough: 0.2 })];
    let created = 0;
    const pool = ctx.pool(() => {
      const chunk = make.ico(1, 0, materials[created++ % materials.length], { shadow: false });
      chunk.userData = { velocity: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, size: 1, hasBounced: false };
      return chunk;
    });
    const BOUNCE = { height: 0.3, keepY: -0.4, keepX: 0.6 };

    return {
      scatter(origin, spec, count) {
        materials[0].color.copy(make.color(spec.tier.color));
        materials[1].color.copy(make.color(spec.tier.glow));
        materials[1].emissive.copy(make.color(spec.tier.glow));
        times(count, () => {
          const chunk = pool.get();
          const motion = chunk.userData;
          chunk.position.set(origin.x + rand(-1.2, 1.2), origin.y + rand(-1.2, 1.2), rand(0.5, 2.5));
          motion.velocity.set(rand(-9, 9), rand(3, 13), rand(-1, 2));
          motion.spin.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));
          motion.size = rand(0.3, 0.75);
          motion.life = rand(1.2, 1.7);
          motion.hasBounced = false;
        });
      },
      update(dt) {
        pool.each((chunk) => {
          const motion = chunk.userData;
          motion.velocity.y -= SHATTER.gravity * dt;
          chunk.position.addScaledVector(motion.velocity, dt);
          chunk.rotation.x += motion.spin.x * dt;
          chunk.rotation.y += motion.spin.y * dt;
          chunk.rotation.z += motion.spin.z * dt;
          // One bounce, and only for chunks that come down over the ledge: the rest fall on down the shaft.
          const isOverLedge = Math.abs(chunk.position.x) < SHAFT.halfWidth;
          if (!motion.hasBounced && motion.velocity.y < 0 && chunk.position.y < SHAFT.ledgeY + BOUNCE.height && isOverLedge) {
            motion.velocity.y *= BOUNCE.keepY;
            motion.velocity.x *= BOUNCE.keepX;
            motion.hasBounced = true;
          }
          chunk.scale.setScalar(motion.size * Math.min(1, motion.life * 4)); // shrink away over the last quarter second
          motion.life -= dt;
          if (motion.life <= 0) pool.release(chunk);
        });
      },
    };
  }

  // ---- THE CAMP SHEET: forge, shard tree, collapse and ledger, drawn from the model ---------------------------------------------

  /**
   * Builds one timber row of the Camp sheet.
   * @param {function(string, string=, string=): HTMLElement} h  ui.h
   * @param {{ title: string, lines: string[], state?: string, button?: { label: string, isEnabled: boolean, onPress: function(): void } }} row
   * @returns {HTMLElement}
   */
  function campRow(h, row) {
    const element = h('div', 'camp-row');
    if (row.state) element.dataset.state = row.state;
    const text = h('div');
    text.append(h('b', null, row.title), ...row.lines.map((line) => h('span', null, line)));
    element.append(text);
    if (row.button) {
      const button = h('button', null, row.button.label);
      button.type = 'button';
      button.disabled = !row.button.isEnabled;
      button.addEventListener('click', row.button.onPress);
      element.append(button);
    }
    return element;
  }

  /** "need (have)" for every chunk of a recipe, e.g. "6 Copper (4) + 2 Silver (0)". */
  const formatRecipeProgress = (cost, wallet) =>
    Object.keys(cost)
      .map((tierId) => `${cost[tierId]} ${RULES.ORE_TIERS.byId(tierId).name} (${formatNumber(wallet.get(tierId))})`)
      .join(' + ');

  /**
   * The Camp sheet's sections as elements, top to bottom. Each call reads the model afresh, so re-rendering is calling again.
   * @param {Object} model the game's model (RULES.createModel)
   * @param {function} h ui.h
   * @param {{ isCollapseArmed: boolean, onChange: function(): void, onArmCollapse: function(): void, onCollapse: function(): void, treeElement: HTMLElement }} camp
   *   onChange: something was forged or worn, render again; treeElement: the live Kit.views.tree element
   * @returns {HTMLElement[]}
   * @complexity O(gear + synergies + achievements) elements per render; the sheet is only rendered while the game is paused
   */
  function campSections(model, h, camp) {
    const { wallet, inventory, gear, synergies, profile } = model;
    const shards = model.shardsOnCollapse();
    const collapseLines = shards
      ? [`Deepest this run: ${model.run.deepest}. Yields ${shards} shard${shards === 1 ? '' : 's'}.`, 'Coins, coin upgrades and depth reset. Gear, chunks, tree and relics stay.']
      : [`Reach depth ${RULES.PRESTIGE.minDepth} to collapse the shaft for shards.`];
    const collapse = campRow(h, {
      title: 'Collapse the shaft',
      lines: collapseLines,
      // Two presses: the first arms it, so a stray thumb cannot wipe a run.
      button: { label: camp.isCollapseArmed ? 'Really?' : 'Collapse', isEnabled: shards > 0, onPress: camp.isCollapseArmed ? camp.onCollapse : camp.onArmCollapse },
    });

    const chunks = h('div', 'camp-chunks');
    chunks.append(
      ...RULES.ORE_TIERS.filter((tier) => wallet.get(tier.id) > 0).map((tier) => {
        const entry = h('span');
        const gem = h('i');
        gem.style.setProperty('--chunk', cssHex(tier.glow));
        entry.append(gem, `${tier.name} ${formatNumber(wallet.get(tier.id))}`);
        return entry;
      })
    );
    const gearRows = RULES.GEAR.map((piece) => {
      const isWorn = (inventory.equipped(piece.slot) || {}).uid === piece.uid;
      const isOwned = gear.isOwned(piece.uid);
      const act = (change) => () => {
        change(piece.uid);
        camp.onChange();
      };
      const button = isWorn ? { label: 'Worn', isEnabled: false, onPress: () => {} } : isOwned ? { label: 'Wear', isEnabled: true, onPress: act(gear.equip) } : { label: 'Forge', isEnabled: gear.canCraft(piece.uid), onPress: act(gear.craft) };
      return campRow(h, {
        title: `${piece.name} (${RULES.GEAR_SLOTS[piece.slot]})`,
        lines: [`${piece.desc}. Tags: ${piece.tags.join(', ')}`, isOwned ? piece.alloy : `${piece.alloy}: ${formatRecipeProgress(piece.cost, wallet)}`],
        state: isWorn ? 'worn' : '',
        button,
      });
    });
    const setRows = synergies.progress().map((entry) =>
      campRow(h, {
        title: entry.row.name,
        lines: [entry.row.desc, Object.keys(entry.row.needs).map((tag) => `${tag} ${entry.have[tag]}/${entry.row.needs[tag]}`).join(', ')],
        state: entry.active ? 'done' : '',
      })
    );
    const ledgerRows = profile.achievements().map((entry) => {
      const relic = RULES.RELICS.byId(entry.row.unlocks);
      return campRow(h, {
        title: entry.row.text,
        lines: [`${formatNumber(entry.progress)} / ${formatNumber(entry.row.target)}`, `Relic: ${relic.name}. ${relic.desc}`],
        state: entry.done ? 'done' : '',
      });
    });

    return [
      h('h3', null, 'Collapse'),
      collapse,
      h('h3', null, 'Shard tree'),
      h('p', 'camp-note', 'Permanent. Early shards cover one branch: pick the way you play.'),
      camp.treeElement,
      h('h3', null, 'Forge'),
      h('p', 'camp-note', 'Ore chunks alloy into gear. One piece per slot; matching tags form sets.'),
      chunks,
      ...gearRows,
      h('h3', null, 'Sets'),
      ...setRows,
      h('h3', null, 'Ledger'),
      ...ledgerRows,
    ];
  }

  // ---- THE GAME ---------------------------------------------------------------------------------------------------------------

  Kit.register({
    id: 'miner',
    name: 'Core Miner',
    tagline: 'Tap the ore, dig for the core',
    hook: 'Aim, forge, fork and collapse: a mine that deepens for hours',
    color: '#ffc145',
    order: 3,
    theme: THEME,
    create(ctx) {
      const { input, fx, sfx, ui, save, THREE } = ctx;
      const { HEAT, WEAK_POINT } = RULES;

      const stage = buildStage(ctx);
      const scenery = buildScenery(ctx);
      const oreView = createOreView(ctx);
      const pickView = createPickView(ctx, scenery.timberMaterial);
      const drillViews = createDrillViews(ctx);
      const debris = createDebris(ctx);

      // ---- model: games/miner-rules.js owns every rule; this file only shows and feeds it ---------------------------------------
      /** A relic or a set bonus arriving. Silent while the model is being restored from the save (game time is still 0). */
      const announce = (text) => {
        if (ctx.time === 0) return;
        ui.toast(text, 1800);
        sfx.play('perfect');
      };
      const model = RULES.createModel({
        save,
        onAchievement: (row) => announce('Relic: ' + RULES.RELICS.byId(row.unlocks).name),
        onSynergy: (row, isActive) => isActive && announce(row.name),
      });
      const { wallet, stats, upgrades, run } = model;
      const goals = Kit.goals(RULES.GOALS, {
        save,
        onDone(goal) {
          wallet.add(goal.reward);
          ui.toast('Goal +' + goal.reward);
          sfx.play('coin');
        },
      });

      /**
       * Everything that changes while playing and is not the model's to keep.
       * ore: the OreState being mined, or null between ores. punch: the ore's squash, 0..PUNCH.max. streak: combo, heat
       * and venting. weak: the weak point's offset from the ore's centre and when it next moves. scroll: world units the
       * shaft has descended (tweened). shownCoins: the coin counter's animated value. biomeId: the biome last announced.
       */
      const state = {
        ore: null,
        punch: 0,
        streak: RULES.restingStreak(model.heatRule()),
        lastTapTime: -Infinity,
        isNextCritGuaranteed: false,
        weak: { x: 0, y: 0, movesAt: 0 },
        scroll: (run.depth - 1) * SHAFT.stratumHeight,
        shownCoins: wallet.get(),
        biomeId: model.biome().id,
      };
      let lastScroll = state.scroll;
      scenery.setScroll(state.scroll);
      stage.setSky(...model.biome().sky);
      pickView.reskin(upgrades.level('pick'));
      pickView.strikeAt(PICK.restPoint, 1);

      const oreCentre = () => oreView.centre(new THREE.Vector3());
      const ledgeFloor = SHAFT.ledgeY; // particles that should land on the planks bounce here
      /** Drills on screen: one per Drill level, and at least one whenever anything (the tree's standing crew) drills. */
      const activeDrills = () => (stats.get('dps') > 0 ? clamp(upgrades.level('drill'), 1, DRILL_SLOTS.length) : 0);

      // ---- HUD ------------------------------------------------------------------------------------------------------------------
      const coinsSign = ui.stat('Coins', wallet.get());
      const depthSign = ui.stat('Depth', run.depth);
      const drillsSign = ui.stat('Drills', '0/s');
      const plaque = ui.progress('');
      // The themed parts are present with this game's theme and absent when another skin is previewed (tools/smoke.js
      // --skin), so every use below is guarded.
      const plaquePart = (className) => plaque.el.querySelector('.' + className);
      const plaqueName = plaquePart(PARTS.plaqueName);
      const plaqueWhere = plaquePart(PARTS.plaqueWhere);
      const heatGauge = plaquePart(PARTS.plaqueHeat);
      const tapHint = ui.hint('Tap the ore');
      ui.checklist(goals, { hideWhenDone: true });
      const campButton = ui.el('button', 'camp', 'Camp');
      campButton.type = 'button';
      let buyHint = null;

      /** Writes the ore's name and HP to the plaque (name on its own line when the theme provides one). */
      const showOreOnPlaque = (ore) => {
        plaque.set(clamp(ore.hp / ore.maxHp));
        if (plaqueName) plaqueName.textContent = RULES.oreTitle(ore.spec);
        plaque.label(plaqueName ? RULES.formatOreHp(ore) : RULES.oreTitle(ore.spec) + '  ' + RULES.formatOreHp(ore));
      };
      /** Writes where the player is digging: the shaft and the biome decide the rules in force. */
      const showWhere = () => plaqueWhere && (plaqueWhere.textContent = `${model.shaft().name} / ${model.biome().name}`);
      /** Heat gauge: its length is the heat, its state the warning (danger: about to overheat; vent: overheated). */
      const showHeat = (streak) => {
        if (!heatGauge) return;
        const isVenting = streak.ventLeft > 0;
        heatGauge.dataset.state = isVenting ? 'vent' : streak.heat > HEAT.dangerAbove ? 'danger' : 'warm';
        heatGauge.firstChild.style.width = (isVenting ? 1 : streak.heat) * 100 + '%';
      };

      /** What only this upgrade does when bought, beyond its stat mods. */
      const purchaseEffects = {
        pick: () => pickView.reskin(upgrades.level('pick')),
        drill: () => sfx.play('whoosh', { pitch: 1.3 }), // the new drill flying in
        luck: () => (state.isNextCritGuaranteed = true), // the purchase pays off on the very next tap
        cart: () => sfx.play('coin', { pitch: 0.8 }),
      };

      const shop = ui.shop(upgrades, {
        wallet,
        sound: null, // each row brings its own (UPGRADES.buySound)
        onBuy(row, level) {
          if (buyHint) buyHint.hide();
          const [soundName, pitch] = row.buySound;
          sfx.play(soundName, { pitch });
          purchaseEffects[row.id]();
          coinsSign.pulse();
          goals.track('buy', 1, row);
          const centre = oreCentre();
          // One upright ring around the ore in the upgrade's colour: the purchase visibly lands on the thing it improves.
          fx.ring({ x: centre.x, y: centre.y, z: 3 }, { color: row.color, size: 4.2, life: 0.45, width: 0.08, bright: 1.6, facing: 'camera' });
          const text = level === 1 ? row.boughtText : row.name + ' ' + row.formatStat(stats.get(row.stat));
          fx.floater(text, { x: 0, y: centre.y + ORE_SHAPE.radius + 1.2, z: 3 }, { color: row.color, size: 24 });
        },
      });

      /** Brings one upgrade crate's own parts (effect line, state, savings strip) up to date. */
      const refreshCrate = (row) => {
        const crate = shop.bar.el(row.id);
        const effectLine = crate && crate.querySelector('.' + PARTS.cardEffect);
        if (!effectLine) return; // another skin is being previewed: the kit's default button already shows the price
        const card = RULES.describeUpgradeCard(row, {
          isMaxed: upgrades.maxed(row.id),
          canBuy: upgrades.canBuy(row.id),
          cost: upgrades.cost(row.id),
          coins: wallet.get(),
          current: stats.get(row.stat),
          next: upgrades.preview(row.id, row.stat),
        });
        effectLine.textContent = card.effect;
        crate.dataset.state = card.state;
        crate.style.setProperty('--crate-color', row.color);
        crate.querySelector('.' + PARTS.cardStrip + ' i').style.width = card.progress * 100 + '%';
      };

      /** Everything in the HUD that depends on the wallet, the upgrade levels or the build. */
      const refreshHud = () => {
        upgrades.table.forEach(refreshCrate);
        drillsSign.set(formatNumber(model.drillDps()) + '/s');
        // The Camp tag lights up when the forge or the tree has something the player can take right now.
        campButton.dataset.alert = String(RULES.GEAR.some((piece) => model.gear.canCraft(piece.uid)) || model.tree.affordable().length > 0);
        // Point at the shop the first time something is affordable, until the first purchase.
        if (!buyHint && !upgrades.owned().length && upgrades.affordable().length) buyHint = ui.hint('Buy an upgrade');
      };
      // Registered after ui.shop so these run after its own refresh of the labels and prices.
      upgrades.on(refreshHud);
      wallet.on(refreshHud);
      refreshHud();
      showWhere();

      /** Opens the Camp sheet. The game is paused while it is open; collapsing restarts the scene from the saved model. */
      function openCamp() {
        const treeView = Kit.views.tree(model.tree, { wallet, currency: 'shards', pointsLabel: 'Shards', heads: RULES.TREE_HEADS });
        const camp = { isCollapseArmed: false, treeElement: treeView.element };
        ui.panel({
          title: 'Camp',
          closeLabel: 'Back to the shaft',
          build(body, close) {
            const render = () => {
              body.textContent = '';
              body.append(...campSections(model, ui.h, camp));
            };
            camp.onChange = () => {
              sfx.play('up');
              render();
            };
            camp.onArmCollapse = () => {
              camp.isCollapseArmed = true;
              render();
            };
            camp.onCollapse = () => {
              model.collapse();
              close();
              ctx.restart();
            };
            render();
          },
        }).then(() => {
          treeView.dispose();
          refreshHud();
        });
      }
      campButton.addEventListener('click', (event) => {
        event.stopPropagation(); // a press on the tag is not a strike on the ore
        sfx.play('click');
        openCamp();
      });

      // ---- the weak point -------------------------------------------------------------------------------------------------------

      const weakRadius = () => WEAK_POINT.radius * stats.get('weakSize') * oreView.scale();
      const weakPointWorld = () => {
        const centre = oreCentre();
        return { x: centre.x + state.weak.x, y: centre.y + state.weak.y };
      };
      /** Moves the weak point to a new spot on the ore's front face and restarts its timer. */
      function moveWeakPoint() {
        const angle = rand(TAU);
        const distance = rand(0.2, WEAK_POINT.reach) * ORE_SHAPE.radius * oreView.scale();
        state.weak = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, movesAt: ctx.time + WEAK_POINT.seconds };
        oreView.showWeakPoint(weakPointWorld(), weakRadius());
      }
      /** @returns {boolean} whether a strike at `point` lands on the weak point (judged in the screen plane) */
      const isOnWeakPoint = (point) => {
        const weak = weakPointWorld();
        return Math.hypot(point.x - weak.x, point.y - weak.y) <= weakRadius();
      };

      // ---- ore life cycle -------------------------------------------------------------------------------------------------------

      /** Announces a biome the first time the player digs into it this session, and repaints the backdrop for it. */
      function enterBiome(biome) {
        if (biome.id === state.biomeId) return;
        state.biomeId = biome.id;
        stage.setSky(...biome.sky);
        ui.toast(`${biome.name}: ${biome.rule}`, 2600);
      }

      /** Builds the ore for the current depth and drops it onto the ledge; it can be hit from its first bounce. */
      function spawnOre() {
        const spec = model.spec();
        enterBiome(model.biome());
        scenery.spillOreLight(oreView.rebuild(spec));
        state.ore = RULES.newOre(spec);
        plaque.color(cssHex(spec.tier.color));
        showOreOnPlaque(state.ore);
        showWhere();
        oreView.root.visible = true;
        oreView.root.position.y = SHAFT.ledgeY + DROP.height;
        ctx.tween(oreView.root.position, { y: SHAFT.ledgeY }, DROP.seconds, 'outBounce');
        ctx.after(DROP.seconds * DROP.firstBounceAt, () => {
          flow.go('live');
          moveWeakPoint();
          state.punch = PUNCH.land;
          sfx.play('thud', { pitch: spec.isCore ? 0.8 : 1.1 });
          fx.shake(spec.isCore ? 0.35 : 0.2);
          fx.burst({ x: 0, y: SHAFT.ledgeY + 0.2, z: 2 }, { count: 12, colors: PALETTE.dust, speed: 5, size: 0.16, up: 0.25, gravity: 5, life: 0.7 });
        });
        if (spec.isCore) ui.toast(RULES.oreTitle(spec));
        else if (spec.isNewTier) ui.toast(spec.tier.name + ' vein');
      }

      /** One crack stage opening: the fissure shows, crystals snap off as sparks, and the ore pays a little. */
      function openCrackStage(stageIndex) {
        const { spec } = state.ore;
        oreView.openCrack(stageIndex);
        const snapped = times(CRACK_ART.crystalsPerStage, () => oreView.snapCrystal()).filter(Boolean);
        snapped.forEach((position) => fx.burst(position, { count: 7, colors: [spec.tier.glow, 0xffffff], speed: 6, size: 0.24, life: 0.9, gravity: 18, floor: ledgeFloor }));
        const coins = model.payCrack(spec);
        const centre = oreCentre();
        fx.floater('+' + formatNumber(coins), snapped[0] || { x: centre.x, y: centre.y, z: 2 }, { color: TEXT.coins, size: 20 });
      }

      /**
       * Applies damage to the ore and plays what follows from it.
       * @param {number} amount
       * @param {'tap'|'weak'|'crit'|'drill'} source decides how hard the ore recoils
       */
      function hitOre(amount, source) {
        if (!flow.is('live')) return;
        const before = state.ore;
        state.ore = RULES.damageOre(before, amount);
        showOreOnPlaque(state.ore);
        state.punch = Math.min(PUNCH.max, state.punch + PUNCH[source]);
        if (state.ore.hp <= 0) {
          shatterOre();
          return;
        }
        const newStages = times(state.ore.crackStage - before.crackStage, (offset) => before.crackStage + offset);
        if (!newStages.length) return;
        newStages.forEach(openCrackStage);
        // One crunch per hit however many stages it opened; the pitch rises as the ore nears breaking.
        sfx.play('thud', { pitch: 1.1 + state.ore.crackStage * 0.15 });
        sfx.noise({ dur: 0.14, vol: 0.22, freq: 3200, type: 'highpass' });
        sfx.play('coin', { vol: 0.5, gap: 0.1 });
        fx.shake(0.22);
      }

      /** The ore breaks: debris, payout, one stratum deeper; after a core, the shaft forks. */
      function shatterOre() {
        const { spec } = state.ore;
        const { tier } = spec;
        const feel = spec.isCore ? SHATTER.core : SHATTER.plain;
        const origin = oreCentre().setZ(2);
        state.ore = null;
        oreView.root.visible = false;
        oreView.hideWeakPoint();
        plaque.set(0);
        fx.burst(origin, { count: feel.chunks, colors: [tier.color, tier.color, tier.glow], speed: 11, size: 0.26, life: 1.2, gravity: 20, floor: ledgeFloor });
        fx.burst(origin, { count: feel.coins, colors: PALETTE.coins, speed: 7, size: 0.14, up: 1.1, gravity: 16, life: 1, bright: 1.5 });
        debris.scatter(origin, spec, feel.debris);
        oreView.flareNova();
        fx.shake(feel.shake);
        if (spec.isCore) {
          // Cores get the two effects nothing else in the game uses, so they feel like an event.
          fx.flash(cssHex(tier.glow), 180, 0.4);
          fx.slowmo(0.3, 0.12, 0.35);
        }
        sfx.play('boom', { pitch: feel.boomPitch });
        sfx.play(feel.payoutSound);
        const result = model.breakOre(spec);
        fx.floater('+' + formatNumber(result.payout.coins), origin, { color: TEXT.coins, size: feel.floaterSize });
        if (result.payout.chunks > 0) fx.floater(`+${result.payout.chunks} ${tier.name}`, { x: origin.x, y: origin.y - 1.3, z: origin.z }, { color: cssHex(tier.glow), size: 16 });
        coinsSign.pulse();
        depthSign.set(run.depth);
        depthSign.pulse();
        goals.track('ore');
        if (spec.isCore) goals.track('core');
        flow.go(result.fork ? 'fork' : 'descend');
      }

      /** Shows the shafts on offer and digs into the one the player picks. */
      function offerFork() {
        const offers = run.forkOffers.map((shaftId) => RULES.SHAFTS.byId(shaftId));
        const biome = model.biome();
        ui.choose({
          title: 'The shaft forks',
          sub: `Until the next core. ${biome.name}: ${biome.rule}.`,
          options: offers.map((shaft) => ({ title: shaft.name, desc: shaft.desc, color: shaft.color, tag: shaft.id === run.shaftId ? 'Current' : '' })),
        }).then((index) => {
          model.chooseShaft(offers[index].id);
          // The new shaft may change the heat rule (a flooded drift has none): start its streak from rest.
          state.streak = RULES.restingStreak(model.heatRule());
          flow.go('descend');
        });
      }

      // drop: the ore falls in and bounces. live: it can be hit. fork: the player picks a shaft. descend: the shaft scrolls
      // down one stratum.
      const flow = Kit.fsm({
        drop: { enter: spawnOre },
        live: {},
        fork: { enter: () => ctx.after(SHATTER.forkAfter, offerFork) },
        descend: {
          enter: () =>
            ctx.after(SHATTER.descendAfter, () => {
              sfx.play('whoosh', { pitch: 0.7 });
              ctx.tween(state, { scroll: state.scroll + SHAFT.stratumHeight }, SHATTER.descendSeconds, 'inOutQuad').then(() => flow.go('drop'));
            }),
        },
      });

      // ---- input ----------------------------------------------------------------------------------------------------------------

      /**
       * Where a tap strikes the ore, in world space. A tap that misses still strikes: the nearest spot on the ore's front, so a
       * thumb that drifts never wastes a tap.
       * @param {{ nx: number, ny: number }} tap normalised device coordinates
       * @returns {THREE.Vector3}
       */
      function strikePointFor(tap) {
        const MIN_Z = 1.2; // keep the pick and sparks in front of the drills
        const hit = input.hit([oreView.rock], tap.nx, tap.ny);
        const point = new THREE.Vector3();
        if (hit) point.copy(hit.point);
        else {
          const centre = oreCentre();
          // Unproject the tap onto the ore's plane, then pull it inside the ore's silhouette.
          point.set(tap.nx, tap.ny, 0).unproject(stage.camera).sub(centre).setZ(0).clampLength(0, ORE_SHAPE.radius * 0.8).add(centre);
          point.z = ORE_SHAPE.radius * 0.7;
        }
        point.z = Math.max(point.z, MIN_Z);
        return point;
      }

      /** The words and colour of a strike's damage number, most notable first. */
      const strikeText = (strike) => {
        if (strike.isVenting) return { prefix: '', color: TEXT.vent };
        if (strike.isCrit) return { prefix: 'CRIT ', color: TEXT.crit };
        if (strike.isWeak) return { prefix: 'WEAK ', color: TEXT.weak };
        return { prefix: '', color: strike.heat > HEAT.hotAbove ? TEXT.hot : TEXT.hit };
      };

      /**
       * Feedback for one strike. Every tap gets the pick swing, the squash, a few chips that land on the ledge, a clink and a
       * number. A weak-point hit adds one tight ring and a bright ping; sparks, flash, shake and hitstop are kept for crits.
       * @param {THREE.Vector3} point where it landed
       * @param {number} side 1 from the right, -1 from the left
       * @param {number} damage
       * @param {{ heat: number, isVenting: boolean, isCrit: boolean, isWeak: boolean }} strike
       */
      function playStrike(point, side, damage, strike) {
        const { tier } = state.ore.spec;
        const { heat, isCrit, isWeak } = strike;
        const isBig = isCrit || isWeak;
        pickView.strikeAt(point, side);
        fx.burst(point, { count: isBig ? 16 : 5, colors: [tier.color, tier.color, tier.glow], speed: isBig ? 8 : 5.5, size: 0.18, life: 0.8, gravity: 20, dir: [side * 0.5, 0.5, 0.8], spread: 0.8, floor: ledgeFloor });
        const text = strikeText(strike);
        fx.floater(text.prefix + formatNumber(damage), { x: point.x + rand(-0.5, 0.5), y: point.y + 0.7, z: point.z }, { color: text.color, size: isBig ? 30 : 18 + heat * 5 });
        sfx.play('hit', { pitch: rand(0.9, 1.1) * (1 + heat * 0.35), vol: strike.isVenting ? 0.4 : 0.8 });
        sfx.tone({ freq: clinkHz(state.streak.combo) * rand(1 - CLINK.detune, 1 + CLINK.detune), dur: CLINK.seconds, vol: CLINK.volume });
        if (isWeak) {
          fx.ring(point, { color: WEAK_ART.color, size: 1.4, life: 0.3, width: 0.1, bright: 2, facing: 'camera' });
          sfx.play('tap', { pitch: 1.8 });
        }
        if (!isCrit) return;
        oreView.flashAt(point);
        fx.burst(point, { count: 14, colors: PALETTE.critSparks, speed: 13, size: 0.07, life: 0.25, gravity: 4, dir: [side * 0.7, 0.4, 0.6], spread: 1, bright: 2.2 });
        fx.shake(0.35);
        fx.hitstop(45);
        sfx.play('perfect');
      }

      /** The pick overheating: a hiss, a word, and the gauge takes over from there. */
      function playOverheat(point) {
        sfx.noise({ dur: 0.5, vol: 0.3, freq: 1800, type: 'highpass' });
        sfx.play('lose', { pitch: 1.6, vol: 0.5 });
        fx.floater('Overheated', { x: point.x, y: point.y + 1.6, z: point.z }, { color: TEXT.vent, size: 24 });
      }

      input.onTap((tap) => {
        tapHint.hide();
        if (!flow.is('live')) return;
        const point = strikePointFor(tap);
        const side = point.x >= 0 ? 1 : -1; // the pick comes in from the side of the ore that was tapped
        const isCrit = state.isNextCritGuaranteed || Math.random() < stats.get('crit');
        state.isNextCritGuaranteed = false;
        const streak = RULES.extendStreak(state.streak, ctx.time - state.lastTapTime, model.heatRule(), stats.get('ventSeconds'));
        state.streak = streak;
        state.lastTapTime = ctx.time;
        if (streak.didOverheat) playOverheat(point);
        const isWeak = isOnWeakPoint(point);
        const strike = { heat: streak.heat, isVenting: streak.ventLeft > 0, isCrit, isWeak };
        const damage = RULES.strikeDamage(model.power(), strike, model.shaft());
        playStrike(point, side, damage, strike);
        if (isWeak) {
          model.recordWeakHit();
          goals.track('weak');
          moveWeakPoint(); // a struck weak point jumps, so the next one has to be found again
        }
        hitOre(damage, isCrit ? 'crit' : isWeak ? 'weak' : 'tap');
      });

      /** One drill's bit landing: sparks at the contact point and that drill's share of the crew's damage. */
      function peck(slot, activeCount) {
        if (!state.ore) return;
        const centre = oreCentre();
        const reach = drillReach(slot, oreView.scale());
        const contact = { x: centre.x + slot.dirX * reach, y: centre.y + slot.dirY * reach, z: 1 };
        fx.burst(contact, { count: 4, colors: [0xffffff, state.ore.spec.tier.glow], speed: 5, size: 0.08, life: 0.25, gravity: 6, dir: [slot.dirX, slot.dirY, 0.4], spread: 0.7 });
        sfx.play('click', { pitch: rand(1.7, 2.3), vol: 0.35, gap: DRILL.sparkGap });
        // Each drill pecks once per cycle, so the crew's dps over one cycle is split evenly between the active drills.
        hitOre((model.drillDps() * DRILL.peckSeconds) / activeCount, 'drill');
      }

      /** Living rock: the ore regrows while it is being mined; the plaque follows only when a whole hit point changes. */
      function regrowOre(dt) {
        const before = state.ore;
        state.ore = RULES.regrowOre(before, dt, model.biome());
        if (Math.ceil(state.ore.hp) !== Math.ceil(before.hp)) showOreOnPlaque(state.ore);
      }

      // A save can hold a fork the player has not answered yet (the page was closed on the choice): ask again first.
      flow.go(run.forkOffers ? 'fork' : 'drop');

      return {
        update(dt, time) {
          const isLive = flow.is('live');
          state.streak = RULES.coolStreak(state.streak, dt, model.heatRule());
          showHeat(state.streak);
          state.punch = damp(state.punch, 0, PUNCH.settleRate, dt);
          if (isLive) {
            regrowOre(dt);
            if (time > state.weak.movesAt) moveWeakPoint();
          }
          oreView.update(time, dt, { punch: state.punch, heat: state.streak.heat, hurt: state.ore ? RULES.damageFraction(state.ore) : 0 });
          pickView.update(dt);

          const activeCount = activeDrills();
          drillViews.update(time, dt, { activeCount, isWorking: isLive, centre: oreCentre(), oreScale: oreView.scale(), onPeck: (slot) => peck(slot, activeCount) });
          debris.update(dt);

          const riseSpeed = dt > 0 ? (state.scroll - lastScroll) / dt : 0;
          lastScroll = state.scroll;
          scenery.setScroll(state.scroll);
          scenery.update(time, dt, riseSpeed);

          // The coin counter rolls up to the wallet after a payout, then snaps once it is within a coin.
          const coins = wallet.get();
          state.shownCoins = Math.abs(coins - state.shownCoins) < 0.6 ? coins : damp(state.shownCoins, coins, 9, dt);
          coinsSign.set(Math.round(state.shownCoins));
        },
      };
    },
  });
})();
