/**
 * Swarm Arena: a flat neon top-down auto-battler. Drag to move, tap to dash, the ship fires itself; gems level you
 * into a build, a warden ends the run, and what you did unlocks ships, arenas, weapons and harder tiers.
 *
 * Owns: the presentation - scene, instanced crowds, effects, sound, HUD, the level-up screen, the hangar (ship,
 *       arena and threat selection, trophies) and the game's registration.
 * Does not own: the rules (games/arena-sim.js steps a plain-data run and reports events through `cues`), the numbers
 *       and the depth plan (games/arena-data.js: read its header for what is real at seconds, minutes and hours),
 *       the look of the HTML (games/arena-theme.js) or the bots (games/arena-bots.js).
 *
 * How a frame flows: read the stick and the dash request, `Arena.sim.step` advances the run, each cue it fires is
 * answered here with effects, then the world is drawn from its plain data.
 *
 * Art direction: everything is unlit colour on an orthographic camera. Glow is spent on the hero, shots, gems, kill
 * flashes and tells; the swarm stays crisp outlines so it is always readable.
 */
(() => {
  const { rand, damp, clamp } = Kit.math;
  const { data: D, sim, meta, bots, theme } = window.Arena;
  const { CAPACITY, ENEMIES, BOSS, LEVEL_UP, MINE } = D;
  const { times } = sim;

  // =====================================================================================================================
  // Presentation tunables. (Rules live in games/arena-data.js.)
  // =====================================================================================================================

  /** World units the camera shows: across the screen in portrait, top to bottom in landscape. */
  const VIEW = { portrait: 15, landscape: 21 };

  /** Palette, 0xRRGGBB. Enemy, affix, ship, arena and upgrade colours sit on their own rows. */
  const COLORS = { heroCore: 0x05211d, white: 0xffffff, shot: 0xffd866, lance: 0x8fe9ff, gem: 0x58e6ff, bigGem: 0xffd34d, blade: 0xdff3ff, mine: 0xffb347, tell: 0xff5d73, shield: 0xcfe4ff, space: 0x04050d, gridMinor: 0x2a3aa0, gridMajor: 0x5f7dff };

  /** The hero's drawn shape, world units. `thickness` is shared by every flat prism in the game. */
  const HERO_SHAPE = { ringRadius: 0.74, coreRadius: 0.5, noseRadius: 0.44, noseOffset: 0.66, thickness: 0.1, roundSides: 28, glowSize: 5.5, glowOpacity: 0.22, magnetRingWidth: 0.015, magnetOpacity: 0.2, dashStretch: 0.5, focusGlow: 0.5 };

  /** Camera follow: it leads a little in the direction of travel so you see more of where you are going. */
  const CAMERA = { height: 30, leadDistance: 1.2, leadDamping: 3, followDamping: 5 };

  /** How enemies, gems, shots and blades are drawn. */
  const LOOK = {
    enemyGrowInSeconds: 0.25,
    enemyPulseRate: 8,
    enemyPulseAmount: 0.06,
    enemyCoreScale: 0.66, // the dark inset, as a fraction of the outline
    eliteHaloScale: 1.45, // the elite's ring, as a multiple of its radius
    shieldWidth: 1.9, // the bulwark's plate, as multiples of its radius...
    shieldDepth: 0.16, // ...and its thickness in world units
    tellWidth: 0.45, // width of a charge line, world units
    gemSize: 0.3,
    bigGemSize: 0.5,
    gemPulseRate: 6,
    gemPulseAmount: 0.15,
    gemSpinRate: 2,
    gemAspect: 0.75,
    bladeWidth: 0.32,
    bladeLength: 1.05,
    mineSize: 0.34,
    mineSpinRate: 3,
    flickerFrames: 5, // while invulnerable the body is hidden one frame in this many
    heroTrailFrames: 2,
    heroTrailOffset: 0.6,
    bladeTrailFrames: 3,
    gemTrailFrames: 3,
    muzzleFlashDistance: 1.1,
  };

  /** Parallax layers under the grid: parallax 1 would be glued to the camera (infinitely far), 0 is the arena floor. */
  const BACKDROP = {
    spread: 48, // stars are scattered over a square this far each way, world units
    stars: [
      { count: 170, pixels: 1.5, color: 0x5468d8, opacity: 0.55, parallax: 0.82, y: -6 },
      { count: 70, pixels: 2.6, color: 0xc4d2ff, opacity: 0.8, parallax: 0.62, y: -6 },
    ],
    nebulae: { parallax: 0.72, y: -5, size: 34, opacity: 0.1, clouds: [{ x: -14, z: -18, color: 0x5b2cff }, { x: 16, z: 6, color: 0x0d8f9c }, { x: -6, z: 22, color: 0x2448ff }] },
  };

  /** The floor grid. It breathes slowly and kicks brighter on kills (`kick` is 0..1 and decays). */
  const GRID = {
    minor: { step: 2, color: COLORS.gridMinor, opacity: 0.18, kickOpacity: 0.3 },
    major: { step: 10, color: COLORS.gridMajor, opacity: 0.32, kickOpacity: 0.5, breatheRate: 1.8, breatheAmount: 0.08 },
    kickPerKill: 0.16,
    kickPerHeavyKill: 0.8,
    kickDamping: 4,
  };

  /**
   * The wall: a hairline rim plus additive bands that fade to nothing on both sides, brighter as you approach.
   * Built at radius 1 and scaled to the arena's radius every frame, so a closing wall costs nothing.
   */
  const ARENA_WALL = {
    bands: [
      { inner: 0.8, outer: 1, innerShade: 0, outerShade: 0.55 },
      { inner: 1, outer: 1.12, innerShade: 0.55, outerShade: 0 },
      { inner: 0.998, outer: 1.002, innerShade: 1.6, outerShade: 1.6 },
    ],
    segments: 96,
    idleOpacity: 0.35,
    warnDistance: 9, // the wall starts brightening this far from the edge
  };

  /** Draw heights of each flat layer, world units above the floor (the camera looks straight down, so this is z-order). */
  const HEIGHT = { wall: 0.02, marks: 0.06, gems: 0.1, mines: 0.12, enemyRim: 0.2, enemyCore: 0.26, shots: 0.32, hero: 0.4, sparks: 0.6, lowSparks: 0.3, trail: 0.2, flash: 1 };

  /** How far past 1 each colour is pushed. Only colours above the bloom threshold glow, so this is the glow budget. */
  const BRIGHT = { heroRing: 2.2, heroNose: 2.6, blade: 1.7, shot: 2.6, gem: 1.6, mine: 1.4, enemyRim: 1.1, enemyHit: 2, enemyCoreCold: 0.07, enemyCoreHeat: 0.55, eliteHalo: 1.8, shield: 1.5, tellStart: 0.35, tellEnd: 2.2, killSparks: 1.5, nova: 1.6 };

  /** Bloom and vignette. Neon is the art direction here, but only colours pushed past 1 bloom. */
  const POST = { bloomStrength: 0.6, bloomRadius: 0.55, bloomThreshold: 0.9, vignette: 0.32, vignetteAtZeroHp: 0.45 };

  /**
   * @typedef {Object} SoundCue
   * @property {string} name  Kit.sfx preset
   * @property {number} gap   least seconds between two plays of the preset, so a dense swarm does not turn into noise
   * @property {number} vol   0..1
   */

  /** @type {Object<string, SoundCue>} The sounds that can fire many times a frame. */
  const SOUNDS = {
    enemyHit: { name: 'hit', gap: 0.05, vol: 0.35 },
    enemyDown: { name: 'hit', gap: 0.03, vol: 0.5 },
    killChime: { name: 'tap', gap: 0.03, vol: 0.55 },
    gem: { name: 'coin', gap: 0.045, vol: 0.3 },
    shoot: { name: 'shoot', gap: 0.06, vol: 0.28 },
    blocked: { name: 'click', gap: 0.08, vol: 0.8 },
    graze: { name: 'tap', gap: 0.05, vol: 0.5 },
    tell: { name: 'whoosh', gap: 0.2, vol: 0.6 },
    burn: { name: 'hit', gap: 0.3, vol: 0.4 },
  };

  /** Chained kills and pickups climb in pitch by these steps. */
  const PITCH = { killStep: 0.075, gemStep: 0.06, grazeBase: 1.6, tell: 1.6, wave: 0.7, lance: 1.5 };

  /** Effect sizes per event. Ring, shake and hitstop are saved for heavy kills and the hero's own moments, so they stay an event. */
  const FEEDBACK = {
    kill: { sparks: 10, speed: 6.5, life: 0.5, size: 0.2, flashScale: 4.5, flashLife: 0.18 },
    heavyKill: { sparks: 36, speed: 10, life: 0.5, size: 0.3, flashScale: 4.5, flashLife: 0.18, ringScale: 3.4, ringLife: 0.45, ringWidth: 0.1, hitstopMs: 70, shake: 0.5, boomVolume: 0.7 },
    hurt: { shake: 0.6, flashColor: '#ff2d55', flashMs: 200, flashStrength: 0.22, sparks: 14, speed: 7 },
    burn: { flashColor: '#ff7a2d', flashMs: 160, flashStrength: 0.12, gap: 0.35 },
    death: { slowmoScale: 0.25, slowmoHold: 0.5, slowmoRecover: 0.6, sparks: 70, speed: 10, life: 1.1, size: 0.26, ringSize: 12, ringLife: 0.7, ringWidth: 0.07, flashSize: 14, flashLife: 0.5, shake: 0.8, bannerDelay: 0.8 },
    clear: { slowmoScale: 0.3, slowmoHold: 0.7, slowmoRecover: 0.8, flashColor: '#ffffff', flashMs: 500, flashStrength: 0.5, bannerDelay: 1.4 },
    nova: { ringLife: 0.5, ringWidth: 0.07, sparks: 30, sparkSpeed: 11, sparkLife: 0.6, sparkSize: 0.22, labelLift: 1.6, labelSize: 22 },
    pulse: { ringLife: 0.35, ringWidth: 0.05, color: 0xc9a1ff },
    dash: { ringSize: 1.8, ringLife: 0.25, ringWidth: 0.08, sparks: 8, speed: 5, life: 0.3, size: 0.16 },
    dashNova: { ringLife: 0.3, ringWidth: 0.08, color: 0x7fd0ff },
    mine: { ringLife: 0.3, ringWidth: 0.1, sparks: 12, speed: 7, life: 0.4, size: 0.2 },
    blast: { ringLife: 0.3, ringWidth: 0.16, sparks: 18, speed: 8, life: 0.4, size: 0.22, shake: 0.25 },
    blocked: { sparks: 3, speed: 4, life: 0.2, size: 0.12 },
    graze: { sparks: 3, speed: 3, life: 0.25, size: 0.12, labelSize: 12 },
    muzzle: { sparks: 2, speed: 3, life: 0.16, size: 0.13 },
    heroTrail: { speed: 0.6, life: 0.4, size: 0.2 },
    bladeTrail: { speed: 0.5, life: 0.25, size: 0.16 },
    gemTrail: { speed: 0.4, life: 0.3, size: 0.13 },
    bossArrival: { shake: 0.5, pitch: 0.6 },
    killPulseEvery: 10, // the Kills readout pulses on every tenth kill
  };

  /** The hull gauge in the HUD: how many cells it has and when it turns to its alert colour. */
  const HULL_GAUGE = { cells: 10, lowFraction: 0.3 };

  /** Most instances of the two shared mark batches: rings (elite halos, blast circles) and bars (shields, charge lines). */
  const MARK_CAPACITY = { rings: 64, bars: 48 };

  // =====================================================================================================================
  // Pure helpers.
  // =====================================================================================================================

  /**
   * How many cells of a gauge are lit. Any hit points at all keep one cell lit, so "one cell" never reads as dead.
   * @param {number} fraction 0..1
   * @param {number} cells
   * @returns {number}
   */
  const litCellCount = (fraction, cells) => Math.ceil(clamp(fraction) * cells);

  /**
   * What taking a row would do for the build's synergies, as a line for its card ('' when nothing).
   * @param {Object} run an Arena.sim Run
   * @param {Object} row an ArenaUpgrade of the rolled hand
   * @returns {string} e.g. 'Completes Battery (3 kinetic: +20% fire rate)' or 'Kinetic 2/3 toward Battery'
   */
  const synergyNoteOf = (run, row) => {
    if (run.upgrades.level(row.id) > 0) return ''; // synergies count rows owned, so another level adds nothing
    const notes = run.synergies
      .progress()
      .filter((entry) => !entry.active)
      .map((entry) => {
        const tagsHelped = row.tags.filter((tag) => entry.row.needs[tag] > entry.have[tag]);
        if (!tagsHelped.length) return null;
        const missingAfter = Object.keys(entry.row.needs).reduce((missing, tag) => missing + entry.row.needs[tag] - entry.have[tag] - (tagsHelped.includes(tag) ? 1 : 0), 0);
        const tag = tagsHelped[0];
        return missingAfter === 0 ? `Completes ${entry.row.name} (${entry.row.desc})` : `${tag} ${entry.have[tag] + 1}/${entry.row.needs[tag]} toward ${entry.row.name}`;
      })
      .filter(Boolean);
    // A completion is the news; otherwise the first step is enough to hint at the set.
    return notes.find((note) => note.startsWith('Completes')) || notes[0] || '';
  };

  /**
   * The card of one upgrade in a level-up hand.
   * @param {Object} run
   * @param {Object} row
   * @returns {{ title: string, desc: string, tag: string, color: string }} a ui.choose option
   */
  const upgradeCardOf = (run, row) => {
    const level = run.upgrades.level(row.id);
    const note = synergyNoteOf(run, row);
    return {
      title: row.name,
      desc: run.upgrades.desc(row.id, level + 1) + (note ? `. ${note}` : ''),
      tag: row.kind === 'evolution' ? 'evolution' : `${row.tags[0]} ${level ? 'Lv ' + (level + 1) : 'new'}`,
      color: row.color,
    };
  };

  /** The text that says how a locked ship, arena or tier is opened. */
  const unlockTextOf = (row) => {
    if (row.rank) return `Clear ${D.TIERS[row.rank - 2].name}`;
    const achievement = D.ACHIEVEMENTS.find((each) => each.unlocks === row.unlock);
    return achievement ? achievement.text : 'Locked';
  };

  // =====================================================================================================================
  // The game.
  // =====================================================================================================================

  /**
   * Builds the game inside a shell context: the profile and hangar first, then the run and its scene.
   * @param {Object} ctx the live game context (see kit/shell.js)
   * @returns {{ update: function(number): void }}
   */
  function create(ctx) {
    const { make, input, fx, sfx, ui, save, THREE, scene } = ctx;
    const profile = meta.createProfile(save);
    let loadout = meta.validLoadout(profile, save.get('loadout', D.DEFAULT_LOADOUT));
    /** Set once a run is launched: advances and draws one frame. */
    let stepFrame = null;

    /**
     * Fills the hangar sheet: three racks of keys (ship, arena, threat) and the trophy log. Re-renders itself on
     * every choice, so the pressed state always matches the loadout.
     * @param {HTMLElement} body the sheet's scrolling body (ui.panel)
     */
    const renderHangar = (body) => {
      const rack = (title, rows, isOpen, loadoutKey, describe) => {
        const element = ui.h('div', 'hangar-rack');
        element.append(ui.h('h3', null, title));
        rows.forEach((row) => {
          const isAvailable = isOpen(profile, row);
          const key = ui.h('button', 'hangar-key');
          key.type = 'button';
          key.disabled = !isAvailable;
          key.setAttribute('aria-pressed', String(loadout[loadoutKey] === row.id));
          key.append(ui.h('b', null, row.name), ui.h('span', null, describe(row)));
          if (!isAvailable) key.append(ui.h('em', null, `Locked: ${unlockTextOf(row)}`));
          key.addEventListener('click', () => {
            loadout = { ...loadout, [loadoutKey]: row.id };
            save.set('loadout', loadout);
            sfx.play('click');
            renderHangar(body);
          });
          element.append(key);
        });
        return element;
      };
      const trophies = ui.h('div', 'hangar-rack');
      trophies.append(ui.h('h3', null, `Trophies. Account level ${profile.level}: ${meta.startingRerolls(profile)} reroll(s) a run`));
      profile.achievements().forEach(({ row, progress, done }) => {
        const line = ui.h('div', done ? 'trophy done' : 'trophy');
        line.append(ui.h('span', null, `${row.text}: ${row.reward}`), ui.h('b', null, done ? 'done' : `${Kit.fmt(progress)} / ${Kit.fmt(row.target)}`));
        trophies.append(line);
      });
      body.replaceChildren(
        rack('Ship', D.SHIPS, meta.isUnlocked, 'shipId', (ship) => `${ship.desc} ${ship.passive}.`),
        rack('Arena', D.ARENAS, meta.isUnlocked, 'arenaId', (arena) => arena.desc),
        rack('Threat', D.TIERS, meta.isTierOpen, 'tierId', (tier) => tier.desc),
        trophies
      );
    };

    /**
     * Launches a run with the current loadout: builds the scene and the HUD and installs the frame function.
     * Everything below is created per run, so each arena and ship gets its own scene.
     */
    const launch = () => {
      const run = meta.createRunFor(profile, loadout);
      const { world, ship, arena, tier } = run;

      // ---- camera: straight down. Screen-up is -z, so stick.y (down the screen) maps to +z. ----
      const camera = ctx.ortho((size) => (size.portrait ? VIEW.portrait : VIEW.landscape * size.aspect), 'width');
      camera.position.set(0, CAMERA.height, 0);
      camera.up.set(0, 0, -1);
      camera.lookAt(0, 0, 0);
      scene.background = make.color(COLORS.space);
      ctx.post.bloom(POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);

      // ---- backdrop: star points and nebula glows that slide with the camera at their layer's parallax ----
      const buildStarLayer = (layer) => {
        const positions = new Float32Array(times(layer.count, () => [rand(-BACKDROP.spread, BACKDROP.spread), 0, rand(-BACKDROP.spread, BACKDROP.spread)]).flat());
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({ color: make.color(layer.color), size: layer.pixels, sizeAttenuation: false, transparent: true, opacity: layer.opacity, depthWrite: false, toneMapped: false });
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false; // the layer slides under the camera, so its bounds are never a useful test
        points.position.y = layer.y;
        points.userData.parallax = layer.parallax;
        scene.add(points);
        return points;
      };
      const buildNebulae = ({ parallax, y, size, opacity, clouds }) => {
        const haze = make.group({ at: [0, y, 0] });
        haze.userData.parallax = parallax;
        clouds.forEach((cloud) => make.glow(cloud.color, size, { parent: haze, at: [cloud.x, 0, cloud.z], opacity }));
        return haze;
      };
      const parallaxLayers = [...BACKDROP.stars.map(buildStarLayer), buildNebulae(BACKDROP.nebulae)];

      // ---- floor: a grid clipped to the arena's opening radius, so it reads as a lit platform over the stars ----
      const floorRadius = arena.radius(0);
      const buildGridLines = ({ step, color, opacity }) => {
        const lineCount = Math.ceil((2 * floorRadius) / step) - 1;
        const vertices = times(lineCount, (index) => {
          const offset = -floorRadius + step * (index + 1);
          // Half the length of the chord of the disc at this offset: each line stops exactly at the rim.
          const halfChord = Math.sqrt(Math.max(0, floorRadius * floorRadius - offset * offset));
          // One line along z and one along x per offset.
          return [offset, 0, -halfChord, offset, 0, halfChord, -halfChord, 0, offset, halfChord, 0, offset];
        }).flat();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const material = new THREE.LineBasicMaterial({ color: make.color(color), transparent: true, opacity, toneMapped: false });
        scene.add(new THREE.LineSegments(geometry, material));
        return material;
      };
      const minorGridMaterial = buildGridLines(GRID.minor);
      const majorGridMaterial = buildGridLines(GRID.major);

      // ---- wall: additive rings whose brightness is baked per vertex (inner edge to outer edge) ----
      const wallMaterial = new THREE.MeshBasicMaterial({ color: make.color(arena.color), vertexColors: true, transparent: true, opacity: ARENA_WALL.idleOpacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const wallGroup = make.group({ at: [0, HEIGHT.wall, 0] });
      ARENA_WALL.bands.forEach(({ inner, outer, innerShade, outerShade }) => {
        const geometry = new THREE.RingGeometry(inner, outer, ARENA_WALL.segments, 1).rotateX(-Math.PI / 2);
        const vertexCount = geometry.attributes.position.count;
        // RingGeometry lists the inner edge's vertices first, then the outer edge's: one grey level for each half.
        const shades = times(vertexCount, (index) => (index < vertexCount / 2 ? innerShade : outerShade)).flatMap((shade) => [shade, shade, shade]);
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(shades), 3));
        make.mesh(geometry, wallMaterial, { shadow: false, parent: wallGroup });
      });

      // ---- hero: glowing ring in the ship's colour, dark core, white nose that points where it shoots (+z at rotation 0) ----
      const heroGroup = make.group({ at: [0, HEIGHT.hero, 0] });
      const heroBody = make.group({ parent: heroGroup });
      make.prism(HERO_SHAPE.roundSides, HERO_SHAPE.ringRadius, HERO_SHAPE.thickness, make.unlit(ship.color, { bright: BRIGHT.heroRing }), { parent: heroBody, shadow: false });
      make.prism(HERO_SHAPE.roundSides, HERO_SHAPE.coreRadius, HERO_SHAPE.thickness, make.unlit(COLORS.heroCore), { parent: heroBody, shadow: false, at: [0, HERO_SHAPE.thickness / 2, 0] });
      make.prism(3, HERO_SHAPE.noseRadius, HERO_SHAPE.thickness, make.unlit(COLORS.white, { bright: BRIGHT.heroNose }), { parent: heroBody, shadow: false, at: [0, HERO_SHAPE.thickness, HERO_SHAPE.noseOffset] });
      const heroGlow = make.glow(ship.color, HERO_SHAPE.glowSize, { parent: heroGroup, opacity: HERO_SHAPE.glowOpacity, depthTest: false });
      // A unit hairline ring scaled to the magnet radius each frame, so the pickup range is always visible.
      const magnetRing = make.mesh(new THREE.RingGeometry(1 - HERO_SHAPE.magnetRingWidth, 1, 64).rotateX(-Math.PI / 2), make.unlit(COLORS.gem, { additive: true, opacity: HERO_SHAPE.magnetOpacity }), { parent: heroGroup, shadow: false });
      const bladeGroup = make.group({ parent: heroGroup });
      const bladeMaterial = make.unlit(COLORS.blade, { bright: BRIGHT.blade });
      /** @type {THREE.Mesh[]} one mesh per owned blade, grown on demand */
      const bladeMeshes = [];

      // ---- crowds: one instanced batch (one draw call) per layer, re-listed every frame from the world's plain objects ----
      const whiteMaterial = make.unlit(COLORS.white);
      const prismGeometry = (sides) => make.prism(sides, 1, HERO_SHAPE.thickness, whiteMaterial, { parent: null, shadow: false }).geometry;
      const boxGeometry = make.box(1, HERO_SHAPE.thickness, 1, whiteMaterial, { parent: null, shadow: false }).geometry;
      /** Each enemy type draws as a bright outline with a dark inset on top that heats up as it takes damage. */
      const enemyLooks = ENEMIES.reduce(
        (looks, type) => ({
          ...looks,
          [type.id]: {
            color: make.color(type.color),
            rim: make.batch(prismGeometry(type.sides), CAPACITY.enemies, { y: HEIGHT.enemyRim }),
            core: make.batch(prismGeometry(type.sides), CAPACITY.enemies, { y: HEIGHT.enemyCore }),
          },
        }),
        {}
      );
      const gemBatch = make.batch(prismGeometry(4), CAPACITY.gems, { y: HEIGHT.gems });
      const mineBatch = make.batch(prismGeometry(3), CAPACITY.mines, { y: HEIGHT.mines });
      const shotBatch = make.batch(boxGeometry, CAPACITY.shots, { y: HEIGHT.shots });
      // Marks: flat rings (elite halos, blast circles) and bars (bulwark plates, charge lines) share two batches.
      const ringBatch = make.batch(new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2), MARK_CAPACITY.rings, { y: HEIGHT.marks, material: make.unlit(COLORS.white, { additive: true, fresh: true }) });
      ringBatch.mesh.material.side = THREE.DoubleSide;
      const barBatch = make.batch(boxGeometry, MARK_CAPACITY.bars, { y: HEIGHT.marks, material: make.unlit(COLORS.white, { additive: true }) });
      const batches = [gemBatch, mineBatch, shotBatch, ringBatch, barBatch, ...Object.values(enemyLooks).flatMap((look) => [look.rim, look.core])];
      /** Linear-space colours for the batches (make.color converts from sRGB once, here). */
      const linear = Object.keys(COLORS).reduce((colors, name) => ({ ...colors, [name]: make.color(COLORS[name]) }), {});
      const affixColors = D.AFFIXES.reduce((colors, affix) => ({ ...colors, [affix.id]: make.color(affix.color) }), {});

      // ---- HUD ----
      const hullGauge = ui.pips('Hull', { total: HULL_GAUGE.cells });
      const killsStat = ui.stat('Kills', 0);
      const timeStat = ui.stat('Time', '0:00');
      const xpGauge = ui.progress('Level 1');
      const waveTag = ui.el('div', 'wave-tag', `${tier.name} / Wave 1`);
      const synergyRow = ui.el('div', 'synergy-row');
      const bossBar = ui.el('div', 'boss-bar');
      const bossFill = ui.h('i');
      bossBar.append(bossFill, ui.h('span', null, 'Warden'));
      bossBar.hidden = true;
      const hint = ui.hint('Drag to move. Tap or press Dash to dodge.');
      let wantsDash = false;
      const dashBar = ui.actions([{ id: 'dash', label: 'Dash', sub: 'Ready', onClick: () => (wantsDash = true) }]);
      const dashKey = dashBar.el('dash');
      input.useStick();
      // A tap anywhere (or Space) is the dash; a drag is the stick.
      input.onTap(() => (wantsDash = true));

      // ---- presentation state: things only the eye cares about ----
      const cameraLead = { x: 0, z: 0 };
      let gridKick = 0; // 0..1, bumped by kills, decays
      let isChoosing = false; // a level-up screen is open or queued
      let shownDashText = 'Ready';

      /** One reused point for fx calls (they copy it at once), so effects fired many times a frame allocate nothing. */
      const scratchPoint = { x: 0, y: 0, z: 0 };
      const groundPoint = (x, z, y = HEIGHT.sparks) => {
        scratchPoint.x = x;
        scratchPoint.y = y;
        scratchPoint.z = z;
        return scratchPoint;
      };
      /** Plays one of the SOUNDS at a pitch; the cue's gap keeps repeats from piling up. */
      const playSound = (sound, pitch = 1) => sfx.play(sound.name, { pitch, vol: sound.vol, gap: sound.gap });
      /** One drifting spark of a trail (thruster, blade, pulled gem). */
      const trailSpark = (x, z, color, trail) => fx.burst(groundPoint(x, z, HEIGHT.trail), { flat: true, count: 1, color, speed: trail.speed, life: trail.life, size: trail.size });
      /** A flat burst of sparks from a FEEDBACK row. */
      const sparks = (x, z, colors, feedback, bright = 1) => fx.burst(groundPoint(x, z), { flat: true, count: feedback.sparks, colors, speed: feedback.speed, life: feedback.life, size: feedback.size, bright });
      /** A hairline shockwave on the floor from a FEEDBACK row; `size` is its final radius. */
      const shockwave = (x, z, color, size, feedback, bright = 1) => fx.ring(groundPoint(x, z, HEIGHT.lowSparks), { color, size, life: feedback.ringLife, width: feedback.ringWidth, bright });
      const bumpGrid = (amount) => (gridKick = Math.min(1, gridKick + amount));
      const isDue = Kit.math.rateLimiter(() => world.seconds);

      const showHp = () => {
        const fraction = world.hp / world.build.maxHp;
        hullGauge.set(litCellCount(fraction, HULL_GAUGE.cells));
        hullGauge.el.classList.toggle('low', fraction <= HULL_GAUGE.lowFraction);
      };
      const showXp = () => {
        xpGauge.set(world.xp / D.XP_TO_NEXT_LEVEL(world.level));
        xpGauge.label('Level ' + world.level);
      };
      const showSynergies = () => {
        synergyRow.replaceChildren(
          ...run.synergies.active().map((synergy) => {
            const chip = ui.h('span', 'synergy-chip', synergy.name);
            chip.style.setProperty('--c', synergy.color);
            chip.title = synergy.desc;
            return chip;
          })
        );
      };
      /** The dash key fills as the dash recharges and lights when it is ready. */
      const showDash = () => {
        const { hero, build } = world;
        const isReady = hero.dashCooldown <= 0;
        dashKey.style.setProperty('--charge', String(1 - clamp(hero.dashCooldown / build.dashCooldown)));
        dashKey.classList.toggle('ready', isReady);
        const text = isReady ? 'Ready' : hero.dashCooldown.toFixed(1);
        if (text === shownDashText) return;
        shownDashText = text;
        dashBar.set('dash', { sub: text });
      };
      const showBoss = () => {
        bossBar.hidden = world.bossesAlive <= 0;
        if (bossBar.hidden) return;
        const wardens = world.enemies.filter((enemy) => enemy.type.isBoss);
        const hp = wardens.reduce((sum, warden) => sum + Math.max(0, warden.hp), 0);
        const maxHp = wardens.reduce((sum, warden) => sum + warden.maxHp, 0) || 1;
        bossFill.style.width = clamp(hp / maxHp) * 100 + '%';
      };

      /**
       * Ends the run on screen and on the record: the profile takes the summary, and the readout says what it unlocked.
       * @param {{ title: string, feedback: Object }} ending
       */
      const showEnding = ({ title, feedback }) => {
        const summary = sim.summarize(run);
        const tierBefore = profile.stat('tier');
        const result = meta.recordRun(profile, summary);
        const rewards = result.unlocked.map((id) => D.ACHIEVEMENTS.find((achievement) => achievement.unlocks === id).reward);
        if (profile.stat('tier') > tierBefore && tier.rank < D.TIERS.length) rewards.push(`${D.TIERS[tier.rank].name} is open`);
        if (result.levelsGained) rewards.push(`Account level ${profile.level}`);
        ctx.after(feedback.bannerDelay, () => {
          ui.banner({
            title,
            text: rewards.length ? `Unlocked: ${rewards.join('. ')}.` : 'Nothing new this time. The trophy log in the hangar says what is close.',
            // The first row is the headline of the readout (see games/arena-theme.js).
            stats: [['Survived', ctx.fmtTime(world.seconds)], ['Kills', world.kills], ['Level', world.level], ['Threat', tier.name], ['Best', ctx.fmtTime(profile.stat('bestSeconds'))]],
            button: 'Hangar',
          }).then(() => ctx.restart());
        });
      };

      const showDeath = () => {
        const { hero } = world;
        const death = FEEDBACK.death;
        heroGroup.visible = false;
        sfx.play('lose');
        sfx.play('boom');
        fx.slowmo(death.slowmoScale, death.slowmoHold, death.slowmoRecover);
        sparks(hero.x, hero.z, [ship.color, COLORS.white], death);
        shockwave(hero.x, hero.z, ship.color, death.ringSize, death);
        fx.pop(groundPoint(hero.x, hero.z, HEIGHT.flash), { color: ship.color, size: death.flashSize, life: death.flashLife });
        fx.shake(death.shake);
        showEnding({ title: 'Overrun', feedback: death });
      };

      const showClear = () => {
        const clear = FEEDBACK.clear;
        sfx.play('win');
        fx.slowmo(clear.slowmoScale, clear.slowmoHold, clear.slowmoRecover);
        fx.flash(clear.flashColor, clear.flashMs, clear.flashStrength);
        showEnding({ title: 'Arena cleared', feedback: clear });
      };

      /** How each simulation event looks and sounds (see the `fire(cues, ...)` calls in games/arena-sim.js). */
      const cues = {
        enemyHit: () => playSound(SOUNDS.enemyHit, rand(0.9, 1.4)),
        enemyKilled(enemy, killCombo) {
          const type = enemy.type;
          const isBig = type.isHeavy || enemy.isElite;
          const feedback = isBig ? FEEDBACK.heavyKill : FEEDBACK.kill;
          sparks(enemy.x, enemy.z, [type.color, type.color, COLORS.white], feedback, BRIGHT.killSparks);
          fx.pop(groundPoint(enemy.x, enemy.z, HEIGHT.flash), { color: type.color, size: enemy.size * feedback.flashScale, life: feedback.flashLife });
          if (isBig) {
            shockwave(enemy.x, enemy.z, type.color, enemy.size * feedback.ringScale, feedback);
            fx.hitstop(feedback.hitstopMs);
            fx.shake(feedback.shake);
            sfx.play('boom', { pitch: rand(0.9, 1.1), vol: feedback.boomVolume });
          }
          if (enemy.isElite) fx.floater('+1 reroll', groundPoint(enemy.x, enemy.z, HEIGHT.flash), { size: FEEDBACK.nova.labelSize });
          playSound(SOUNDS.enemyDown, rand(0.7, 0.9));
          playSound(SOUNDS.killChime, 0.7 + killCombo * PITCH.killStep); // chained kills climb in pitch
          bumpGrid(isBig ? GRID.kickPerHeavyKill : GRID.kickPerKill);
          killsStat.set(world.kills);
          if (world.kills % FEEDBACK.killPulseEvery === 0) killsStat.pulse();
        },
        waveStarted(wave) {
          waveTag.textContent = `${tier.name} / Wave ${wave}`;
          sfx.play('whoosh', { pitch: PITCH.wave });
        },
        eliteArrived(elite) {
          ui.toast(elite.affixes.length ? `${elite.affixes.map((affix) => affix.name).join(' ')} elite` : 'Elite');
          sfx.play('whoosh', { pitch: FEEDBACK.bossArrival.pitch });
        },
        bossWarned() {
          ui.toast('Warden inbound');
          sfx.play('lose', { pitch: FEEDBACK.bossArrival.pitch });
        },
        bossArrived() {
          fx.shake(FEEDBACK.bossArrival.shake);
          sfx.play('boom', { pitch: FEEDBACK.bossArrival.pitch });
        },
        bossSummoned: () => sfx.play('whoosh', { pitch: PITCH.wave }),
        chargeTold: () => playSound(SOUNDS.tell, PITCH.tell),
        blastPlaced: () => playSound(SOUNDS.tell, PITCH.wave),
        blastBurst(blast) {
          const feedback = FEEDBACK.blast;
          shockwave(blast.x, blast.z, COLORS.tell, blast.radius, feedback, BRIGHT.nova);
          sparks(blast.x, blast.z, [COLORS.tell, COLORS.white], feedback);
          fx.shake(feedback.shake);
          sfx.play('thud');
        },
        shotBlocked(enemy) {
          playSound(SOUNDS.blocked);
          sparks(enemy.x, enemy.z, [COLORS.shield], FEEDBACK.blocked);
        },
        volleyFired(heading) {
          const { hero, build, shotLook } = world;
          const muzzle = FEEDBACK.muzzle;
          playSound(SOUNDS.shoot, rand(0.9, 1.15) * (shotLook.isLance ? PITCH.lance : 1));
          fx.burst(groundPoint(hero.x + Math.sin(heading) * LOOK.muzzleFlashDistance, hero.z + Math.cos(heading) * LOOK.muzzleFlashDistance), { flat: true, count: muzzle.sparks + build.multishot, color: shotLook.isLance ? COLORS.lance : COLORS.shot, speed: muzzle.speed, life: muzzle.life, size: muzzle.size });
        },
        pulsed: (radius) => shockwave(world.hero.x, world.hero.z, FEEDBACK.pulse.color, radius, FEEDBACK.pulse, BRIGHT.nova),
        mineBurst(mine, radius) {
          shockwave(mine.x, mine.z, COLORS.mine, radius, FEEDBACK.mine, BRIGHT.nova);
          sparks(mine.x, mine.z, [COLORS.mine, COLORS.white], FEEDBACK.mine);
          playSound(SOUNDS.enemyDown, rand(0.5, 0.6));
        },
        dashed() {
          const { hero } = world;
          shockwave(hero.x, hero.z, ship.color, FEEDBACK.dash.ringSize, FEEDBACK.dash);
          sparks(hero.x, hero.z, [ship.color, COLORS.white], FEEDBACK.dash);
          sfx.play('whoosh', { pitch: PITCH.lance });
        },
        dashNova: (radius) => shockwave(world.hero.x, world.hero.z, FEEDBACK.dashNova.color, radius, FEEDBACK.dashNova, BRIGHT.nova),
        grazed(enemy) {
          playSound(SOUNDS.graze, PITCH.grazeBase);
          sparks(enemy.x, enemy.z, [COLORS.white], FEEDBACK.graze);
          fx.floater('graze', groundPoint(enemy.x, enemy.z, HEIGHT.flash), { size: FEEDBACK.graze.labelSize });
        },
        gemCollected: (gem, gemStreak) => playSound(SOUNDS.gem, 0.9 + gemStreak * PITCH.gemStep),
        xpChanged: showXp,
        hpChanged: showHp,
        heroHurt() {
          const hurt = FEEDBACK.hurt;
          hullGauge.pulse();
          fx.shake(hurt.shake);
          fx.flash(hurt.flashColor, hurt.flashMs, hurt.flashStrength);
          sfx.play('thud');
          fx.burst(groundPoint(world.hero.x, world.hero.z), { flat: true, count: hurt.sparks, colors: [COLORS.tell, COLORS.white], speed: hurt.speed });
        },
        wallBurned() {
          // The wall burns every frame; flash and hiss at a steady, readable beat instead.
          if (!isDue('burn', FEEDBACK.burn.gap)) return;
          fx.flash(FEEDBACK.burn.flashColor, FEEDBACK.burn.flashMs, FEEDBACK.burn.flashStrength);
          playSound(SOUNDS.burn, 0.6);
        },
        heroDied: showDeath,
        runCleared: showClear,
      };

      /** The visible half of a pick: the nova lands on the hero in the upgrade's colour, with its name floating up. */
      const showPick = ({ row, gained }) => {
        const { hero } = world;
        const nova = FEEDBACK.nova;
        shockwave(hero.x, hero.z, row.color, LEVEL_UP.nova.radius, nova, BRIGHT.nova);
        fx.burst(groundPoint(hero.x, hero.z), { flat: true, count: nova.sparks, colors: [row.color, COLORS.white], speed: nova.sparkSpeed, life: nova.sparkLife, size: nova.sparkSize, bright: BRIGHT.nova });
        fx.floater(row.name, groundPoint(hero.x, hero.z - nova.labelLift, HEIGHT.flash), { color: row.color, size: nova.labelSize });
        sfx.play(row.kind === 'evolution' ? 'win' : 'perfect');
        gained.forEach((synergy) => ui.toast(`${synergy.name} online`));
        gridKick = 1;
        showSynergies();
        showHp();
      };

      /**
       * Shows a hand and resolves the choice. A reroll (when one is left) is the last card; taking it draws a new
       * hand and asks again.
       * @param {Object[]} hand ArenaUpgrade rows
       */
      const chooseFrom = (hand) => {
        const rerollCard = world.rerolls > 0 ? [{ title: 'Reroll', desc: `Draw a new hand. ${world.rerolls} left; elites drop more`, tag: 'reroll', color: 'var(--amber)' }] : [];
        const slotsLine = ['weapon', 'passive'].map((slot) => `${slot}s ${run.upgrades.slotUse(slot)}/${ship.slots[slot]}`).join(' / ');
        return ui.choose({ title: 'Level ' + world.level, sub: slotsLine, options: [...hand.map((row) => upgradeCardOf(run, row)), ...rerollCard] }).then((index) => (index < hand.length ? hand[index] : chooseFrom(sim.rerollHand(run))));
      };

      /** Opens the level-up screen for one pending level; picks earned together are offered one after another. */
      const offerUpgrade = () => {
        if (world.outcome) return;
        const hand = sim.rollHand(run);
        if (!hand.length) {
          // Every row is maxed or blocked: nothing to choose, so stop asking.
          world.pendingLevels = 0;
          return;
        }
        isChoosing = true;
        sfx.play('up');
        chooseFrom(hand).then((row) => {
          showPick(sim.takeUpgrade(run, row.id, cues));
          if (!world.pendingLevels) return void (isChoosing = false);
          // Stay "choosing" through the pause so the frame loop does not open the next hand on top of this nova.
          ctx.after(LEVEL_UP.chainDelay, offerUpgrade);
        });
      };

      /** Tells the simulation what is on screen. camera.right / top are kept fitted to the screen by the shell. */
      const syncView = () => {
        const { view } = world;
        view.x = camera.position.x;
        view.z = camera.position.z;
        view.halfWidth = camera.right;
        view.halfHeight = camera.top;
      };

      /** Follows the hero with the camera and slides the backdrop. */
      const stepCamera = (dt, stick) => {
        const { hero } = world;
        if (!world.outcome) {
          cameraLead.x = damp(cameraLead.x, stick.x * CAMERA.leadDistance, CAMERA.leadDamping, dt);
          cameraLead.z = damp(cameraLead.z, stick.y * CAMERA.leadDistance, CAMERA.leadDamping, dt);
        }
        camera.position.x = damp(camera.position.x, hero.x + cameraLead.x, CAMERA.followDamping, dt);
        camera.position.z = damp(camera.position.z, hero.z + cameraLead.z, CAMERA.followDamping, dt);
        parallaxLayers.forEach((layer) => layer.position.set(camera.position.x * layer.userData.parallax, layer.position.y, camera.position.z * layer.userData.parallax));
        syncView();
      };

      /** Grid, wall and vignette react to kills, to how close the hero is to the edge and to how hurt it is. */
      const drawAtmosphere = (dt) => {
        const { hero, seconds, arenaRadius } = world;
        gridKick = damp(gridKick, 0, GRID.kickDamping, dt);
        minorGridMaterial.opacity = GRID.minor.opacity + gridKick * GRID.minor.kickOpacity;
        majorGridMaterial.opacity = GRID.major.opacity + Math.sin(seconds * GRID.major.breatheRate) * GRID.major.breatheAmount + gridKick * GRID.major.kickOpacity;
        wallGroup.scale.set(arenaRadius, 1, arenaRadius);
        const distanceInsideWarning = Math.hypot(hero.x, hero.z) - (arenaRadius - ARENA_WALL.warnDistance);
        wallMaterial.opacity = ARENA_WALL.idleOpacity + (1 - ARENA_WALL.idleOpacity) * clamp(distanceInsideWarning / ARENA_WALL.warnDistance);
        ctx.post.vignette(POST.vignette + POST.vignetteAtZeroHp * (1 - clamp(world.hp / world.build.maxHp)));
      };

      /** Places the hero, its blades and their trails. */
      const drawHero = (stick) => {
        const { hero, build, frame } = world;
        const isLive = !world.outcome;
        heroGroup.position.set(hero.x, HEIGHT.hero, hero.z);
        // A quick flicker while invulnerable: hidden one frame in every few.
        heroBody.visible = hero.invulnerableFor <= 0 || frame % LOOK.flickerFrames !== 0;
        const dashStretch = hero.dashFor > 0 ? HERO_SHAPE.dashStretch : 0;
        heroBody.scale.set(1 + hero.recoil - dashStretch * 0.5, 1, 1 + hero.recoil + dashStretch);
        // While dashing the body points along the dash, so the stretch reads as speed.
        heroBody.rotation.y = hero.dashFor > 0 ? Math.atan2(hero.dashX, hero.dashZ) : hero.aim;
        // Focus (the Prism): the glow swells as the standing-still bonus charges.
        heroGlow.scale.setScalar(HERO_SHAPE.glowSize * (1 + (build.focusRate ? hero.focus * HERO_SHAPE.focusGlow : 0)));
        magnetRing.scale.setScalar(build.magnet);
        const isMoving = stick.x !== 0 || stick.y !== 0;
        if (isLive && (isMoving || hero.dashFor > 0) && frame % LOOK.heroTrailFrames === 0) trailSpark(hero.x - hero.headingX * LOOK.heroTrailOffset, hero.z - hero.headingZ * LOOK.heroTrailOffset, ship.color, FEEDBACK.heroTrail);
        times(build.blades - bladeMeshes.length, () => {
          const blade = make.prism(4, 1, HERO_SHAPE.thickness, bladeMaterial, { parent: bladeGroup, shadow: false });
          blade.scale.set(LOOK.bladeWidth, 1, LOOK.bladeLength);
          bladeMeshes.push(blade);
        });
        sim.bladeOffsets(world.bladeAngle, bladeMeshes.length, build.bladeRadius).forEach((offset, index) => {
          bladeMeshes[index].position.set(offset.x, 0, offset.z);
          bladeMeshes[index].rotation.y = -offset.angle; // long axis along the orbit
          if (isLive && frame % LOOK.bladeTrailFrames === 0) trailSpark(hero.x + offset.x, hero.z + offset.z, COLORS.blade, FEEDBACK.bladeTrail);
        });
      };

      /** Draws one enemy and the marks that explain it: an elite's halo, a bulwark's plate, a charge line. */
      const drawEnemy = (enemy, seconds) => {
        const type = enemy.type;
        const look = enemyLooks[type.id];
        const isFlashing = enemy.flashFor > 0;
        const growIn = Math.min(1, enemy.age / LOOK.enemyGrowInSeconds);
        const size = enemy.size * growIn * (1 + Math.sin(seconds * LOOK.enemyPulseRate + enemy.phase) * LOOK.enemyPulseAmount);
        const length = size * (type.stretch || 1);
        const color = isFlashing ? linear.white : look.color;
        // The core starts almost black and brightens toward the rim colour as hp drops: damage you can read at a glance.
        const coreBright = BRIGHT.enemyCoreCold + (1 - enemy.hp / enemy.maxHp) * BRIGHT.enemyCoreHeat;
        look.rim.put(enemy.x, enemy.z, enemy.angle, size, length, color, isFlashing ? BRIGHT.enemyHit : BRIGHT.enemyRim);
        look.core.put(enemy.x, enemy.z, enemy.angle, size * LOOK.enemyCoreScale, length * LOOK.enemyCoreScale, color, isFlashing ? BRIGHT.enemyHit : coreBright);
        if (enemy.isElite) ringBatch.put(enemy.x, enemy.z, 0, size * LOOK.eliteHaloScale, size * LOOK.eliteHaloScale, enemy.affixes.length ? affixColors[enemy.affixes[0].id] : linear.white, BRIGHT.eliteHalo);
        if (type.frontArmor !== undefined) {
          // The plate sits on the side facing the hero: that is the side shots arrive from.
          barBatch.put(enemy.x + Math.sin(enemy.angle) * size, enemy.z + Math.cos(enemy.angle) * size, enemy.angle, size * LOOK.shieldWidth, LOOK.shieldDepth, linear.shield, BRIGHT.shield);
        }
        if (enemy.mode !== 'tell') return;
        // The charge line: as long as the dash will travel, brightening as the tell runs out.
        const charge = type.charge;
        const reach = charge.dashSpeed * charge.dashSeconds;
        const progress = 1 - clamp(enemy.modeFor / charge.tellSeconds);
        barBatch.put(enemy.x + enemy.dirX * reach * 0.5, enemy.z + enemy.dirZ * reach * 0.5, enemy.angle, LOOK.tellWidth, reach, linear.tell, BRIGHT.tellStart + progress * (BRIGHT.tellEnd - BRIGHT.tellStart));
      };

      /** Re-lists every enemy, shot, gem, mine and mark into its instanced batch. */
      const drawCrowds = () => {
        const { enemies, shots, gems, mines, blasts, seconds, frame, shotLook } = world;
        const isLive = !world.outcome;
        batches.forEach((batch) => batch.begin());
        // Hot path (hundreds of instances every frame): for-of loops, no allocation.
        for (const enemy of enemies) drawEnemy(enemy, seconds);
        const shotColor = shotLook.isLance ? linear.lance : linear.shot;
        for (const shot of shots) {
          // Drawn trailing behind its position, so the leading tip is where the hit test is.
          shotBatch.put(shot.x - shot.directionX * shotLook.length * 0.5, shot.z - shot.directionZ * shotLook.length * 0.5, shot.angle, shotLook.width, shotLook.length, shotColor, BRIGHT.shot);
        }
        for (const gem of gems) {
          const isBig = gem.value > 1;
          const size = (isBig ? LOOK.bigGemSize : LOOK.gemSize) * (1 + Math.sin(seconds * LOOK.gemPulseRate + gem.phase) * LOOK.gemPulseAmount);
          gemBatch.put(gem.x, gem.z, seconds * LOOK.gemSpinRate + gem.phase, size * LOOK.gemAspect, size, isBig ? linear.bigGem : linear.gem, BRIGHT.gem);
          // A caught gem leaves a trail on its way in.
          if (isLive && gem.pullSpeed > 0 && frame % LOOK.gemTrailFrames === 0) trailSpark(gem.x, gem.z, isBig ? COLORS.bigGem : COLORS.gem, FEEDBACK.gemTrail);
        }
        for (const mine of mines) {
          // An unarmed mine is dim; it lights when it can go off.
          mineBatch.put(mine.x, mine.z, seconds * LOOK.mineSpinRate, LOOK.mineSize, LOOK.mineSize, linear.mine, mine.age < MINE.armSeconds ? BRIGHT.enemyCoreHeat : BRIGHT.mine);
        }
        for (const blast of blasts) {
          // Two rings: the fixed outer one is where it will hit, the inner one grows to meet it as the fuse burns.
          const progress = 1 - clamp(blast.fuse / blast.total);
          const bright = BRIGHT.tellStart + progress * (BRIGHT.tellEnd - BRIGHT.tellStart);
          ringBatch.put(blast.x, blast.z, 0, blast.radius, blast.radius, linear.tell, bright);
          ringBatch.put(blast.x, blast.z, 0, blast.radius * progress, blast.radius * progress, linear.tell, bright);
        }
        batches.forEach((batch) => batch.end());
      };

      showHp();
      showXp();
      showSynergies();
      syncView();

      stepFrame = (dt) => {
        const stick = input.stick;
        if (stick.active || wantsDash) hint.hide();
        sim.step(run, dt, { x: stick.x, y: stick.y, dash: wantsDash }, cues);
        wantsDash = false;
        if (world.pendingLevels && !isChoosing && !world.outcome) offerUpgrade();
        stepCamera(dt, stick);
        drawAtmosphere(dt);
        drawHero(stick);
        drawCrowds();
        showDash();
        showBoss();
        timeStat.set(ctx.fmtTime(world.seconds));
      };
    };

    // A first-time player flies at once. From the second run on, the hangar opens first: one tap launches the same loadout.
    if (profile.runCount === 0) launch();
    else ui.panel({ title: 'Hangar', closeLabel: 'Launch', build: renderHangar }).then(launch);

    return {
      /** @param {number} dt seconds of game time since the last frame */
      update(dt) {
        if (stepFrame) stepFrame(dt);
      },
    };
  }

  Kit.register({
    id: 'arena',
    name: 'Swarm Arena',
    tagline: 'Drag to dodge, tap to dash, the ship fires itself',
    hook: 'Build fans, lances and blade halos; unlock ships, arenas and threats',
    color: '#ff5d73',
    order: 1,
    theme,
    headless: { data: D, sim, meta, bots, progression: bots.progression },
    create,
  });
})();
