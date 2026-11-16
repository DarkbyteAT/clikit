// Soulwake: a top-down roguelike in a moonlit graveyard. Down zombies, cleanse the souls they leave, absorb a power on
// a roll, spend soul points in a tree that outlives the run, and wear what the dead drop.
//
// Depth plan (what the player gets at each timescale; rules live in souls-sim.js / souls-meta.js, numbers in souls-data.js):
//   Seconds - mastery. Cleansing is a channel that only runs while you stand in the soul's light, so every soul is a
//     question of when the ground is safe. Telegraphs can be read and sidestepped (sprinter windup, spitter marker,
//     bloater fuse); the pulse is one cooldown that buys room, so its timing matters; souls cleansed in quick
//     succession pay a streak bonus, which rewards downing a group and then holding position.
//   Minutes - decisions. Take the rolled power or bank the roll for soul points (run strength against permanent
//     growth). The roll is weighted by which kinds you cleansed, so who you hunt shapes what you can become. Cursed
//     items pair a strong bonus with a real drawback. Powers, tree nodes, item bases, affixes, curses and the class
//     all carry tags; synergies (Kit.synergy) wake when the build holds enough of two tags, so the three systems
//     feed one another and builds get identities (Blightstep, Quakebloom, Cold Veil, ...).
//   Hours - the long arc (Kit.profile). Soul points buy tree nodes that persist; each branch ends in a capstone
//     that changes play at a permanent cost. Achievements unlock classes that reshape the opening (Sexton, Hexer,
//     Revenant) and harder tiers that add rules, not only numbers (restless souls that fade sooner, elites) and pay
//     more souls. The codex shows deeds, synergies with the tags still missing, and a bestiary of what each kind's
//     soul can grant. Pacing is checked by scratch/souls/career.js, which plays careers of runs headlessly.
//
// Owns: the scene, the views of the simulation's entities, sound and effects for its events, the HUD, the panels
// (soul tree, bag, codex, absorb roll, the choice of class and tier) and the run's phases. Does not own: rules or
// numbers (games/souls-sim.js steps the world, games/souls-meta.js wires the build and the long arc,
// games/souls-data.js holds every tunable), the HUD's look (games/souls-theme.js), or the generic models and views
// it composes (Kit.stats / wallet / upgrades / inventory / loot / synergy / profile / craft / crowd / views).
(() => {
  const DATA = window.SOULWAKE_DATA;
  const SIM = window.SOULWAKE_SIM;
  const META = window.SOULWAKE_META;
  const THEME = window.SOULWAKE_THEME;
  const { LOOT, ARENA, ELITE } = DATA;

  // ---- presentation tunables (how it looks and sounds; nothing here changes the rules) ---------------------------

  /** Camera: how many world units fit across the screen, its lean from straight-down (radians) and its follow rate. */
  const VIEW = { width: 10.5, tilt: 0.56, minDistance: 17, fov: 50, followRate: 5 };
  /** Fog starts just in front of the hero's depth and swallows the scene `depth` units behind it. */
  const FOG = { nearFactor: 0.9, depth: 16, color: 0x070b14 };
  const SKY = { top: 0x0d1428, bottom: 0x05070f };
  /** The moon is the one shadow-casting light: low and cool, so graves throw long soft shadows. */
  const MOON = { position: [-8, 11, 5], color: 0xb4c4e8, intensity: 0.6, ambient: 0.46, shadowExtent: 16 };
  /**
   * The lantern: a warm point light above the hero (`height`), plus the small glowing box the hero carries (`size`
   * at `at`, with a `glowSize` halo). `flicker` is the fraction the light's strength wavers by.
   */
  const LANTERN = { color: 0xffc58a, intensity: 2.4, reach: 11, decay: 1.6, height: 1.5, flicker: 0.08, flickerRate: 9, size: [0.14, 0.2, 0.14], at: [0.42, 0.8, 0.18], emissive: 2, glowSize: 2.4 };
  const GROUND = { color: 0x1d2a25, margin: 24, roughness: 0.95 };
  /** Graves and trees vary in size (`scale` range) and lean (`turn`, radians either way); walls never do. */
  const SCENERY_JITTER = { scale: [0.85, 1.15], turn: 0.25 };
  /** The hero's figure. `readyRing` is the mark at the hero's feet that shows the pulse is ready. */
  const HERO_LOOK = {
    cloak: { color: 0x34436b, radius: 0.42, height: 1.15, sides: 7 },
    face: { color: 0xe9d8b8, radius: 0.2, height: 1.3 },
    veilOpacity: 0.35,
    readyRing: { color: 0x7ef0c9, radius: 0.7, opacity: 0.6 },
  };
  /** Fireflies drift on Lissajous paths: `rateX` / `rateY` are the ranges their two frequencies are drawn from. */
  const FIREFLIES = { count: 36, color: 0xd9f99d, bright: 2, size: 0.07, height: [0.5, 1.8], driftWidth: 0.8, driftRate: 0.6, rateX: [0.6, 1.4], rateY: [1.2, 2.4], verticalShare: 0.3 };
  /** Chests: sizes are [width, height, depth] in world units. The lid swings to `lidOpenAngle` (radians) when opened. */
  const CHEST_LOOK = {
    base: { size: [0.85, 0.45, 0.6], color: 0x6b4a2a },
    lid: { size: [0.9, 0.16, 0.64], color: 0xd6b34a, metal: 0.4, roughness: 0.5 },
    glow: { color: 0xfcd34d, size: 1.8, height: 0.9 },
    lidOpenAngle: -1.2,
    openSeconds: 0.35,
  };
  /** Souls: a bobbing orb over a seal on the ground that fills as the soul is cleansed. */
  const SOUL_LOOK = { height: 0.7, bobHeight: 0.12, bobRate: 2.4, orbRadius: 0.2, glowSize: 1.7, sealRadius: 0.95, sealOpacity: 0.5, fillOpacity: 0.35, fadeSeconds: 3 };
  /** Drops: a spinning gem under a beam in the rarity's colour; a cursed item's halo takes `cursedGlow`. */
  const DROP_LOOK = { gemRadius: 0.22, gemHeight: 0.45, spinRate: 1.8, beamWidth: 0.07, beamOpacity: 0.5, glowSize: 1.5, cursedGlow: 0xc084fc };
  const SHOT_LOOK = { size: [0.12, 0.12, 0.5], height: 0.8, colors: { bolt: 0xe9e2cf, acid: 0x5eead4 } };
  /** Telegraphed blasts: a rim at the blast radius and a disc that grows to meet it. */
  const HAZARD_LOOK = { color: 0xff8a5c, rimOpacity: 0.9, fillOpacity: 0.35 };
  /** Particle colour of a hit, by what dealt it. */
  const HIT_COLORS = { weapon: 0xe9e2cf, bolt: 0xe9e2cf, acid: 0x5eead4, dash: 0x5eead4, bloom: 0xf0abfc, pulse: 0x7ef0c9 };
  /**
   * Zombies: a hit swells one by `hitSwell`; a winding-up sprinter leans back by `windupLean` (its tell); a ghost bobs.
   * Eyes are cubes of `eyeSize`, `eyeSpread` sizes either side of the face's centre and `eyeLift` above the head's centre.
   */
  const ZOMBIE_LOOK = { hitSwell: 0.22, windupLean: -0.4, ghostBob: 0.12, ghostBobRate: 3, roughness: 0.9, eyeSize: 0.07, eyeSpread: 1.4, eyeLift: 0.03, eyeBright: 2.2 };
  /** Ground rings are unit rings whose hole starts at `inner` of the radius. */
  const FLAT_RING = { inner: 0.9, segments: 40 };
  /** Marks that lie on the ground float this far above it, so the floor never cuts them. */
  const GROUND_MARK_HEIGHT = 0.05;
  /** A mesh is never scaled to exactly zero: that makes its matrix singular. */
  const MIN_SCALE = 0.001;
  /** Pooled views are built white and tinted when an entity takes them. */
  const UNTINTED = 0xffffff;
  /** Unlit colours are multiplied by this to pass the bloom threshold, so orbs, gems and shots glow a little. */
  const GLOW_BOOST = 1.8;
  /** How long the long-arc toasts stay up, in milliseconds (longer than a combat toast: they are read, not glanced at). */
  const TOAST_MS = { deed: 2200 };
  const MS_PER_SECOND = 1000;
  /** The seed is shown in hexadecimal: shorter to read out and to type back in. */
  const SEED_RADIX = 16;
  /** Font size of an item's name when it is picked up, in CSS pixels (smaller than a number: names are long). */
  const ITEM_FLOATER_SIZE = 15;
  /** World height that floating numbers and item names rise from. */
  const FLOATER_HEIGHT = 1.3;
  const HINTS = { move: 'Drag to walk · tap to pulse', cleanse: 'Stand in a soul’s light to cleanse it' };

  /** Geometry for one body part of a zombie, keyed by the part's `shape`. */
  const PART_GEOMETRY = {
    box: (THREE, [width, height, depth]) => new THREE.BoxGeometry(width, height, depth),
    ball: (THREE, [radius]) => new THREE.SphereGeometry(radius, 10, 8),
    cone: (THREE, [radius, height]) => new THREE.ConeGeometry(radius, height, 7),
  };
  /** Half of a part's extent along its front (z) axis, used to seat the eyes on the head's face. */
  const PART_FRONT = { box: (size) => size[2] / 2, ball: (size) => size[0], cone: (size) => size[0] * 0.5 };

  Kit.register({
    id: 'souls',
    name: 'Soulwake',
    tagline: 'Cleanse souls, absorb powers',
    hook: 'Absorb roll, soul tree, synergies, cursed loot',
    color: '#a3e635',
    order: 10,
    theme: THEME.theme,
    create(ctx) {
      const { THREE, scene, make, fx, sfx, ui, input, math, save } = ctx;

      // ---- models: the build and the long arc are wired in souls-meta.js; this file only reacts to them -----------
      /** True while the run is being set up, so synergies the saved tree already completes are not announced as news. */
      let isSettingUp = true;
      const build = META.createBuild({
        save,
        onAchievement: (row) => ui.toast(`Deed: ${row.text}`, TOAST_MS.deed),
        onUnlock: (unlockId) => ctx.after(TOAST_MS.deed / MS_PER_SECOND, () => ui.toast(`Unlocked: ${META.describeUnlock(unlockId)}`, TOAST_MS.deed)),
        onSynergy(row) {
          if (isSettingUp) return;
          ui.toast(`Synergy: ${row.name}`);
          sfx.play('win');
        },
      });
      const { stats, wallet, tree, powers, inventory, profile, synergies } = build;
      const rng = Kit.rng();
      const world = SIM.createWorld({ rng, stats });
      /** Cosmetic randomness (scenery jitter, reel filler) on its own stream, so it never shifts the run's rolls. */
      const cosmeticRng = Kit.rng(rng.seed + 1);
      const runTally = { powersAbsorbed: 0, bestItem: null };

      // ---- scene ------------------------------------------------------------------------------------------------
      /** A unit ring and a unit disc lying on the ground (scale them to a radius), shared by every ground mark in the game. */
      const flatRingGeometry = new THREE.RingGeometry(FLAT_RING.inner, 1, FLAT_RING.segments).rotateX(-Math.PI / 2);
      const flatDiscGeometry = new THREE.CircleGeometry(1, FLAT_RING.segments).rotateX(-Math.PI / 2);
      ctx.camera.fov = VIEW.fov;
      const stage = make.stage({ sky: [SKY.top, SKY.bottom], fog: [1, 2], fogColor: FOG.color, sun: MOON.position, sunColor: MOON.color, sunIntensity: MOON.intensity, ambient: MOON.ambient, shadow: MOON.shadowExtent });
      make.ground(ARENA.size * ARENA.cell + GROUND.margin, GROUND.color, { rough: GROUND.roughness });
      buildObstacles();
      const chestViews = new Map(world.chests.map((chest) => [chest.id, buildChest(chest)]));
      const heroView = buildHero();
      const fireflies = buildFireflies();
      const cameraFocus = { x: 0, z: 0 };
      let cameraDistance = 0;
      fitCamera();
      ctx.on('resize', fitCamera);

      /** Frames the hero so VIEW.width units span the screen (or VIEW.minDistance in landscape) and sets the fog to match. */
      function fitCamera() {
        ctx.camera.fov = VIEW.fov;
        ctx.camera.updateProjectionMatrix();
        cameraDistance = Math.max(ctx.distanceForWidth(VIEW.width), VIEW.minDistance);
        scene.fog.near = cameraDistance * FOG.nearFactor;
        scene.fog.far = cameraDistance + FOG.depth;
      }

      /** One instanced mesh per obstacle kind, placed from the generated grid with a little seeded jitter. */
      function buildObstacles() {
        Object.entries(DATA.OBSTACLES).forEach(([kind, look]) => {
          const cells = world.grid.find((cell) => cell === kind);
          const height = look.size[1]; // boxes and cones both keep their height second in `size`
          const mesh = make.instanced(PART_GEOMETRY[look.shape](THREE, look.size), make.mat(look.color, { flat: true, rough: GROUND.roughness }), cells.length, { shadow: true });
          cells.forEach(({ x, y }, index) => {
            const at = world.grid.toWorld(x, y);
            // Walls stay square to the grid so runs of them read as one wall; graves and trees lean and vary.
            const isWall = kind === 'wall';
            const scale = isWall ? 1 : cosmeticRng.range(...SCENERY_JITTER.scale);
            mesh.place(index, at.x, (height * scale) / 2, at.z, scale, isWall ? 0 : cosmeticRng.range(-SCENERY_JITTER.turn, SCENERY_JITTER.turn));
          });
          mesh.commit();
        });
      }

      /**
       * @param {{ x: number, z: number }} chest
       * @returns {{ lid: Object, glow: Object }} the parts that change when the chest opens
       */
      function buildChest(chest) {
        const { base, lid: lidLook, glow: glowLook } = CHEST_LOOK;
        const [, baseHeight, baseDepth] = base.size;
        const group = make.group({ at: [chest.x, 0, chest.z] });
        make.box(...base.size, base.color, { parent: group, at: [0, baseHeight / 2, 0] });
        // The lid hinges at its back edge: a pivot group there, with the lid mesh offset forward inside it.
        const lid = make.group({ parent: group, at: [0, baseHeight, -baseDepth / 2] });
        make.box(...lidLook.size, lidLook.color, { parent: lid, at: [0, lidLook.size[1] / 2, baseDepth / 2], metal: lidLook.metal, rough: lidLook.roughness });
        const glow = make.glow(glowLook.color, glowLook.size, { parent: group, at: [0, glowLook.height, 0] });
        return { lid, glow };
      }

      /**
       * The hero: a cloaked figure carrying the lantern that lights the scene.
       * @returns {{ group: Object, cloak: Object, lantern: Object, readyRing: Object }}
       */
      function buildHero() {
        const { cloak: cloakLook, face, readyRing: ringLook } = HERO_LOOK;
        const group = make.group();
        // A material of its own (never shared) because Veilwalk fades it.
        const cloakMaterial = make.mat(cloakLook.color, { flat: true, fresh: true });
        cloakMaterial.transparent = true;
        const cloak = make.cone(cloakLook.radius, cloakLook.height, cloakMaterial, { parent: group, at: [0, cloakLook.height / 2, 0], seg: cloakLook.sides });
        make.sphere(face.radius, face.color, { parent: group, at: [0, face.height, 0] });
        make.box(...LANTERN.size, LANTERN.color, { parent: group, at: LANTERN.at, emissive: LANTERN.color, emissiveIntensity: LANTERN.emissive, shadow: false });
        make.glow(LANTERN.color, LANTERN.glowSize, { parent: group, at: LANTERN.at });
        const lantern = new THREE.PointLight(make.color(LANTERN.color), LANTERN.intensity, LANTERN.reach, LANTERN.decay);
        lantern.position.set(0, LANTERN.height, 0);
        group.add(lantern);
        const readyRing = make.mesh(flatRingGeometry, make.unlit(ringLook.color, { additive: true, opacity: ringLook.opacity }), { parent: group, at: [0, GROUND_MARK_HEIGHT, 0], shadow: false });
        readyRing.scale.setScalar(ringLook.radius);
        return { group, cloak, lantern, readyRing };
      }

      /** Fireflies: one instanced mesh of specks, each drifting on its own Kit.path around a fixed home. */
      function buildFireflies() {
        const span = (ARENA.size * ARENA.cell) / 2;
        const mesh = make.instanced(new THREE.BoxGeometry(FIREFLIES.size, FIREFLIES.size, FIREFLIES.size), make.unlit(FIREFLIES.color, { bright: FIREFLIES.bright }), FIREFLIES.count);
        const flies = Array.from({ length: FIREFLIES.count }, () => ({
          home: { x: cosmeticRng.range(-span, span), y: cosmeticRng.range(FIREFLIES.height[0], FIREFLIES.height[1]), z: cosmeticRng.range(-span, span) },
          drift: Kit.path.scale(Kit.path.lissajous(cosmeticRng.range(...FIREFLIES.rateX), cosmeticRng.range(...FIREFLIES.rateY), cosmeticRng.range(0, math.TAU)), FIREFLIES.driftWidth),
        }));
        return {
          update(time) {
            flies.forEach((fly, index) => {
              const offset = fly.drift(time * FIREFLIES.driftRate);
              mesh.place(index, fly.home.x + offset.x, fly.home.y + offset.y * FIREFLIES.verticalShare, fly.home.z + offset.y);
            });
            mesh.commit();
          },
        };
      }

      // ---- entity views: pooled meshes kept in step with the simulation's plain data (Kit.crowd.views) -----------

      /**
       * Builds one zombie mesh from its row's parts, plus two glowing eyes on the face of its highest part.
       * Geometries and materials are made once per kind and shared by every zombie of that kind.
       * @param {Object} row  a ZombieRow
       * @returns {() => Object} a factory for Kit.pool
       */
      function zombieFactory(row) {
        const parts = row.parts.map((part) => ({
          geometry: PART_GEOMETRY[part.shape](THREE, part.size),
          material: make.mat(part.color, { flat: true, rough: ZOMBIE_LOOK.roughness, opacity: part.opacity }),
          at: part.at,
        }));
        const head = row.parts.reduce((highest, part) => (part.at[1] > highest.at[1] ? part : highest));
        const faceZ = head.at[2] + PART_FRONT[head.shape](head.size);
        const { eyeSize, eyeSpread, eyeLift, eyeBright } = ZOMBIE_LOOK;
        const eyeGeometry = new THREE.BoxGeometry(eyeSize, eyeSize, eyeSize);
        const eyeMaterial = make.unlit(row.eyeColor, { bright: eyeBright });
        return () => {
          const group = make.group();
          parts.forEach((part) => make.mesh(part.geometry, part.material, { parent: group, at: part.at }));
          [-1, 1].forEach((side) => make.mesh(eyeGeometry, eyeMaterial, { parent: group, at: [side * eyeSize * eyeSpread, head.at[1] + eyeLift, faceZ], shadow: false }));
          group.userData.kind = row.id;
          return group;
        };
      }
      const zombiePools = Object.fromEntries(DATA.ZOMBIES.map((row) => [row.id, ctx.pool(zombieFactory(row))]));
      const syncZombies = Kit.crowd.views((zombie) => zombiePools[zombie.kind].get(), (mesh) => zombiePools[mesh.userData.kind].release(mesh));

      function placeZombie(mesh, zombie) {
        const row = SIM.zombieRows.byId(zombie.kind);
        mesh.position.set(zombie.x, row.isGhost ? ZOMBIE_LOOK.ghostBob * (1 + Math.sin(zombie.age * ZOMBIE_LOOK.ghostBobRate)) : 0, zombie.z);
        mesh.rotation.set(zombie.mode === 'windup' ? ZOMBIE_LOOK.windupLean : 0, zombie.facing, 0);
        mesh.scale.setScalar((zombie.isElite ? ELITE.scale : 1) * (1 + zombie.hitFlash * ZOMBIE_LOOK.hitSwell));
      }

      const soulPool = ctx.pool(() => {
        const group = make.group();
        group.userData.orb = make.ico(SOUL_LOOK.orbRadius, 1, make.unlit(UNTINTED, { fresh: true }), { parent: group, shadow: false });
        group.userData.glow = make.glow(UNTINTED, SOUL_LOOK.glowSize, { parent: group });
        group.userData.seal = make.mesh(flatRingGeometry, make.unlit(UNTINTED, { additive: true, opacity: SOUL_LOOK.sealOpacity, fresh: true }), { parent: group, at: [0, GROUND_MARK_HEIGHT, 0], shadow: false });
        group.userData.fill = make.mesh(flatDiscGeometry, make.unlit(UNTINTED, { additive: true, opacity: SOUL_LOOK.fillOpacity, fresh: true }), { parent: group, at: [0, GROUND_MARK_HEIGHT, 0], shadow: false });
        group.userData.seal.scale.setScalar(SOUL_LOOK.sealRadius);
        return group;
      });
      const syncSouls = Kit.crowd.views((soul) => {
        const group = soulPool.get();
        const color = make.color(SIM.zombieRows.byId(soul.kind).soulColor);
        const { orb, glow, seal, fill } = group.userData;
        // Brighter than white so the orb blooms a little; the ground marks stay at the plain colour.
        orb.material.color.copy(color).multiplyScalar(GLOW_BOOST);
        [glow, seal, fill].forEach((part) => part.material.color.copy(color));
        return group;
      }, (group) => soulPool.release(group));

      function placeSoul(group, soul) {
        const { orb, glow, fill } = group.userData;
        const hover = SOUL_LOOK.height + Math.sin((world.time + soul.id) * SOUL_LOOK.bobRate) * SOUL_LOOK.bobHeight;
        // A soul about to fade shrinks, so the player can tell which one to run for first.
        const presence = math.clamp(soul.life / SOUL_LOOK.fadeSeconds);
        group.position.set(soul.x, 0, soul.z);
        orb.position.y = glow.position.y = hover;
        orb.scale.setScalar(presence);
        fill.scale.setScalar(Math.max(MIN_SCALE, soul.progress * SOUL_LOOK.sealRadius));
      }

      const dropPool = ctx.pool(() => {
        const group = make.group();
        group.userData.gem = make.ico(DROP_LOOK.gemRadius, 0, make.unlit(UNTINTED, { fresh: true }), { parent: group, at: [0, DROP_LOOK.gemHeight, 0], shadow: false });
        group.userData.beam = make.box(DROP_LOOK.beamWidth, LOOT.beamHeight, DROP_LOOK.beamWidth, make.unlit(UNTINTED, { additive: true, opacity: DROP_LOOK.beamOpacity, fresh: true }), { parent: group, at: [0, LOOT.beamHeight / 2, 0], shadow: false });
        group.userData.glow = make.glow(UNTINTED, DROP_LOOK.glowSize, { parent: group, at: [0, DROP_LOOK.gemHeight, 0] });
        return group;
      });
      const rarityRows = Kit.table(DATA.RARITIES);
      const syncDrops = Kit.crowd.views((drop) => {
        const group = dropPool.get();
        const rarityColor = make.color(rarityRows.byId(drop.item.rarity).beam);
        group.userData.gem.material.color.copy(rarityColor).multiplyScalar(GLOW_BOOST);
        group.userData.beam.material.color.copy(rarityColor);
        // The beam always tells the rarity; a cursed item's halo tells the catch.
        group.userData.glow.material.color.copy(drop.item.isCursed ? make.color(DROP_LOOK.cursedGlow) : rarityColor);
        return group;
      }, (group) => dropPool.release(group));
      const placeDrop = (group, drop) => {
        group.position.set(drop.x, 0, drop.z);
        group.userData.gem.rotation.y = world.time * DROP_LOOK.spinRate;
      };

      const shotGeometry = new THREE.BoxGeometry(...SHOT_LOOK.size);
      const shotPool = ctx.pool(() => make.mesh(shotGeometry, make.unlit(UNTINTED, { fresh: true }), { shadow: false }));
      const syncShots = Kit.crowd.views((shot) => {
        const mesh = shotPool.get();
        mesh.material.color.copy(make.color(SHOT_LOOK.colors[shot.kind])).multiplyScalar(GLOW_BOOST);
        return mesh;
      }, (mesh) => shotPool.release(mesh));
      const placeShot = (mesh, shot) => {
        mesh.position.set(shot.x, SHOT_LOOK.height, shot.z);
        mesh.rotation.y = Math.atan2(shot.velocityX, shot.velocityZ);
      };

      const hazardPool = ctx.pool(() => {
        const group = make.group();
        make.mesh(flatRingGeometry, make.unlit(HAZARD_LOOK.color, { additive: true, opacity: HAZARD_LOOK.rimOpacity }), { parent: group, shadow: false });
        group.userData.fill = make.mesh(flatDiscGeometry, make.unlit(HAZARD_LOOK.color, { additive: true, opacity: HAZARD_LOOK.fillOpacity }), { parent: group, shadow: false });
        return group;
      });
      const syncHazards = Kit.crowd.views(() => hazardPool.get(), (group) => hazardPool.release(group));
      const placeHazard = (group, hazard) => {
        group.position.set(hazard.x, GROUND_MARK_HEIGHT, hazard.z);
        group.scale.setScalar(hazard.radius);
        // The disc grows to the rim as the fuse burns: when it touches, the blast lands.
        group.userData.fill.scale.setScalar(Math.max(MIN_SCALE, 1 - hazard.timer / hazard.duration));
      };

      // ---- HUD --------------------------------------------------------------------------------------------------
      input.useStick();
      const soulsStat = ui.stat('Souls', wallet.get('souls'));
      const timeStat = ui.stat('Time', '0:00');
      const absorbGauge = ui.progress('Absorb');
      const vitals = THEME.buildVitals(ui, absorbGauge.el);
      const hint = ui.hint(HINTS.move);
      const lessons = { hasMoved: false, hasCleansed: false };
      const bar = ui.actions([
        { id: 'tree', label: 'Tree', onClick: openTree },
        { id: 'bag', label: 'Bag', onClick: openBag },
        { id: 'codex', label: 'Codex', onClick: openCodex },
      ]);

      /** Bottom-bar captions: what the tree can buy right now, how full the bag is, and how many deeds are done. */
      function refreshBar() {
        const affordable = tree.affordable().length;
        bar.set('tree', { sub: affordable ? `${affordable} to buy` : `${Kit.fmt(wallet.get('souls'))} souls` });
        bar.set('bag', { sub: `${inventory.bag.length}/${LOOT.bagSize}` });
        bar.set('codex', { sub: `${profile.achievements().filter((deed) => deed.done).length}/${DATA.ACHIEVEMENTS.length} deeds` });
        soulsStat.set(wallet.get('souls'));
      }
      wallet.on(refreshBar);
      tree.on(refreshBar);
      inventory.on(() => {
        const weapon = inventory.equipped('weapon');
        world.weaponId = weapon ? weapon.base : 'unarmed';
        refreshBar();
      });
      profile.on(refreshBar);
      refreshBar();

      /**
       * Adds soul points and shows them rising from a point in the world.
       * @param {number} points
       * @param {{ x: number, z: number }} [at]  where the number rises from (omit for gains made inside a panel)
       * @param {string} [note]                   extra words after the number (a streak)
       */
      function gainSouls(points, at, note = '') {
        wallet.add(points, 'souls');
        soulsStat.pulse();
        if (at) fx.floater(`+${points}${note}`, { x: at.x, y: FLOATER_HEIGHT, z: at.z });
      }

      // ---- panels -----------------------------------------------------------------------------------------------

      function openTree() {
        const view = Kit.views.tree(tree, { wallet, currency: 'souls', pointsLabel: 'Soul points', heads: DATA.TREE_BRANCHES, anchor: THEME.TREE_ANCHOR });
        ui.panel({ title: 'Soul Tree', closeLabel: 'Back to the hunt', build: (body) => body.append(view.element) }).then(view.dispose);
      }

      /** One line naming the class, the attunement, the powers held (with levels) and the synergies awake: the build at a glance, above the bag. */
      function describeBuild() {
        const held = powers.owned().map((row) => `${row.name} ${powers.level(row.id)}`);
        const awake = synergies.active().map((row) => row.name);
        const attuned = build.attunement.map((tagId) => DATA.TAG_LABELS[tagId]);
        return [build.classRow.name, attuned.length ? `Attuned: ${attuned.join(', ')}` : null, `Powers ${held.length}/${stats.get('powerSlots')}: ${held.join(', ') || 'none yet'}`, awake.length ? `Synergies: ${awake.join(', ')}` : null].filter(Boolean).join(' · ');
      }

      function openBag() {
        const view = Kit.views.inventory(inventory, {
          loot: world.rollDrop.loot,
          labels: DATA.STAT_LABELS,
          compareStats: DATA.COMPARE.stats,
          percent: DATA.COMPARE.percent,
          lowerIsBetter: DATA.COMPARE.lowerIsBetter,
          slotLabels: DATA.SLOT_LABELS,
          // Rarity, then the item's build tags (what it adds toward synergies), then the warning.
          tag: (item) => [rarityRows.byId(item.rarity).name, ...META.itemTags(item).map((tagId) => DATA.TAG_LABELS[tagId]), item.isCursed && 'Cursed'].filter(Boolean).join(' · '),
          decorate: (card, item) => (card.dataset.cursed = String(!!item.isCursed)),
          salvage: { label: (item) => `Salvage +${SIM.salvageValue(item)}`, onSalvage: (item) => gainSouls(SIM.salvageValue(item)) },
        });
        ui.panel({ title: 'Bag', closeLabel: 'Back to the hunt', build: (body) => body.append(ui.h('p', null, describeBuild()), view.element) }).then(view.dispose);
      }

      /**
       * The bestiary: every kind of zombie with how many were downed and, once one has been, what its soul can grant.
       * Knowing the pools is what lets a player hunt for a build.
       * @returns {Object[]} entries for Kit.views.progressList
       */
      function bestiaryEntries() {
        const powerRows = Kit.table(DATA.POWERS);
        return DATA.ZOMBIES.map((row) => {
          const downed = profile.stat(`down:${row.id}`);
          return {
            title: downed ? row.name : 'Unknown',
            counter: downed ? `${Kit.fmt(downed)} downed` : '',
            detail: downed ? `Soul grants: ${row.powers.map((powerId) => powerRows.byId(powerId).name).join(', ')}` : 'Down one to learn what its soul grants.',
            progress: 0,
            isDone: downed > 0,
          };
        });
      }

      function openCodex() {
        const sections = [
          ['Deeds', Kit.views.deeds(profile, { describeUnlock: META.describeUnlock })],
          ['Synergies', Kit.views.synergies(synergies, { tagLabels: DATA.TAG_LABELS })],
          ['Bestiary', Kit.views.progressList(bestiaryEntries, [])],
        ];
        const attuned = build.attunement.map((tagId) => DATA.TAG_LABELS[tagId]).join(', ') || 'nothing yet';
        const rule = `Your build is attuned to the ${DATA.ATTUNED_TAGS} tags it holds most of (now: ${attuned}). Only attuned tags count toward synergies.`;
        const fill = (body) => {
          body.append(ui.h('p', null, rule));
          sections.forEach(([heading, view]) => body.append(ui.h('h3', null, heading), view.element));
        };
        ui.panel({ title: 'Codex', closeLabel: 'Back to the hunt', build: fill })
          .then(() => sections.forEach(([, view]) => view.dispose()));
      }

      /**
       * The absorb roll: a reel over the powers of the kinds cleansed since the last roll. The winner is drawn first;
       * the player then takes it or banks the roll for soul points (the panel's close button).
       */
      function openAbsorbRoll() {
        const pool = SIM.buildAbsorbPool(world.absorb.cleansedKinds, (powerId) => META.isPowerBarred(build, powerId), stats.get('absorbLuck'));
        const bankSouls = SIM.bankValue(world);
        SIM.finishAbsorbRoll(world);
        // Nothing these kinds grant can be taken (all maxed, or new while every slot is full): the roll banks itself.
        if (!pool.length) return gainSouls(bankSouls, world.hero);
        const winner = rng.weighted(pool);
        const nextLevel = powers.level(winner.power.id) + 1;
        // A new power takes a slot for the rest of the run: say so, because that is the reason to bank instead.
        const slotNote = nextLevel === 1 ? ` Fills power slot ${powers.owned().length + 1} of ${stats.get('powerSlots')}.` : '';
        let closeRoll;
        const view = Kit.views.roll({
          entries: pool,
          winner,
          rng: cosmeticRng,
          describe: (entry) => `${entry.power.name} ${nextLevel}: ${entry.power.desc(nextLevel)}${slotNote}`,
          takeLabel: (entry) => `Absorb ${entry.power.name}`,
          onTake: () => closeRoll('take'),
        });
        ui.panel({
          title: 'Absorb',
          closeLabel: `Bank it: +${bankSouls} souls`,
          build: (body, close) => {
            closeRoll = close;
            body.append(view.element);
          },
        }).then((choice) => {
          view.dispose();
          if (choice === 'take') absorbPower(winner.power);
          else gainSouls(bankSouls, world.hero);
        });
      }

      /** Grants one level of a power and celebrates it. */
      function absorbPower(power) {
        powers.grant(power.id);
        runTally.powersAbsorbed++;
        META.recordAbsorb(build);
        ui.toast(`${power.name} ${powers.level(power.id)}`);
        fx.ring(heroView.group.position, { color: 0xa3e635, size: 4, life: 0.5 });
        sfx.play('up');
      }

      /** Takes an item off the ground: into the bag (worn at once if its slot is empty), or salvaged when the bag is full. */
      function collectItem(item, at) {
        if (!runTally.bestItem || item.value > runTally.bestItem.value) runTally.bestItem = item;
        sfx.play('coin');
        if (!inventory.add(item)) return gainSouls(SIM.salvageValue(item), at);
        const isWornNow = !inventory.equipped(item.slot) && inventory.equip(item.uid);
        fx.floater(isWornNow ? `Equipped ${item.name}` : item.name, { x: at.x, y: FLOATER_HEIGHT, z: at.z }, { color: item.color, size: ITEM_FLOATER_SIZE });
      }

      // ---- events: what the simulation reports, and how each one looks and sounds --------------------------------

      const lift = (at, height) => ({ x: at.x, y: height, z: at.z });
      const PRESENT = {
        hit: (event) => fx.burst(lift(event, 0.8), { count: 4, color: HIT_COLORS[event.source], speed: 2.4, life: 0.3, size: 0.09 }),
        attack(event) {
          sfx.play(event.pattern === 'bolt' ? 'shoot' : 'hit', { vol: 0.45, pitch: event.isReap ? 0.7 : 1 });
          if (event.pattern === 'sweep') fx.ring(lift(event, 0.1), { color: event.isReap ? 0xa3e635 : 0xe9e2cf, size: event.reach, life: 0.22 });
        },
        arc: (event) => event.points.slice(1).forEach((point) => fx.burst(lift(point, 0.9), { count: 5, color: 0xfcd34d, speed: 1.6, life: 0.25, size: 0.08 })),
        down(event) {
          fx.burst(lift(event, 0.7), { count: 10, color: SIM.zombieRows.byId(event.kind).soulColor, speed: 2.2, life: 0.5, size: 0.1, gravity: -2 });
          sfx.play('thud', { vol: 0.6 });
          if (lessons.hasMoved && !lessons.hasCleansed) {
            hint.set(HINTS.cleanse);
            hint.show();
          }
        },
        bloom: (event) => fx.ring(lift(event, 0.1), { color: 0xf0abfc, size: event.radius, life: 0.3 }),
        cleanse(event) {
          lessons.hasCleansed = true;
          hint.hide();
          fx.ring(lift(event, 0.1), { color: SIM.zombieRows.byId(event.kind).soulColor, size: 1.6, life: 0.4 });
          sfx.play('perfect');
          gainSouls(event.points, event, event.streak > 1 ? ` streak x${event.streak}` : '');
        },
        pulse(event) {
          fx.ring(lift(event, 0.1), { color: HERO_LOOK.readyRing.color, size: event.radius, life: 0.35 });
          sfx.play('whoosh');
        },
        dash: (event) => fx.burst(lift(event, 0.5), { count: 8, color: 0xfde68a, speed: 3, life: 0.3, size: 0.1, flat: true }),
        acid: () => sfx.play('shoot', { vol: 0.4, pitch: 0.6 }),
        spit: () => sfx.play('shoot', { vol: 0.5, pitch: 0.45 }),
        blast(event) {
          fx.ring(lift(event, 0.1), { color: HAZARD_LOOK.color, size: event.radius, life: 0.3 });
          fx.burst(lift(event, 0.3), { count: 14, color: HAZARD_LOOK.color, speed: 3.5, life: 0.4, size: 0.12 });
          sfx.play('boom', { vol: 0.5 });
        },
        hurt() {
          fx.shake(0.3);
          vitals.flinch();
          sfx.play('thud', { pitch: 0.7 });
        },
        veil: () => ui.toast('Veilwalk', 700),
        summon(event) {
          fx.ring(lift(event, 0.1), { color: 0xfacc15, size: event.radius * 1.5, life: 0.5 });
          sfx.play('lose', { vol: 0.5, pitch: 0.6 });
        },
        drop: () => sfx.play('tap', { vol: 0.7, pitch: 1.4 }),
        pickup: (event) => collectItem(event.drop.item, event.drop),
        chest(event) {
          const view = chestViews.get(world.chests.find((chest) => chest.x === event.x && chest.z === event.z).id);
          ctx.tween(view.lid.rotation, { x: CHEST_LOOK.lidOpenAngle }, CHEST_LOOK.openSeconds, 'outBack');
          view.glow.visible = false;
          sfx.play('up', { vol: 0.6 });
        },
        // The first Gravelord turns the hunt into the boss phase; later ones arrive inside it.
        boss: () => run.go('boss'),
        death: () => run.go('dead'),
      };
      /** Records every event the simulation queued this frame in the profile, plays it, then empties the queue. */
      const presentEvents = () =>
        world.events.splice(0).forEach((event) => {
          META.recordRunEvent(build, event);
          if (PRESENT[event.type]) PRESENT[event.type](event);
        });

      // ---- run phases -------------------------------------------------------------------------------------------
      let wantsPulse = false;
      input.onTap(() => {
        wantsPulse = true;
        // A tap during the cooldown still answers, so the player learns the pulse exists but is not ready.
        if (world.hero.cooldownTimer > 0) sfx.play('click', { vol: 0.6 });
      });

      /** One frame of play: feed input to the simulation, present what happened, and open the absorb roll when the meter fills. */
      function advance(dt) {
        const { stick } = input;
        if (stick.active && !lessons.hasMoved) {
          lessons.hasMoved = true;
          hint.hide();
        }
        SIM.step(world, { moveX: stick.x, moveZ: stick.y, wantsPulse }, dt);
        wantsPulse = false;
        presentEvents();
        if (!world.hero.isDead && world.absorb.meter >= SIM.absorbNeed(world)) openAbsorbRoll();
      }

      function showDeathBanner() {
        sfx.play('lose');
        META.finishRun(build, world);
        ui.banner({
          title: 'The lantern gutters',
          text: 'Your soul tree and your deeds endure. Powers and relics return to the earth.',
          stats: [
            ['Time', `${ctx.fmtTime(world.time)} (best ${ctx.fmtTime(profile.stat('bestTime'))})`],
            ['Woke as', `${build.classRow.name}, ${build.tier.name}`],
            ['Souls cleansed', `${world.tally.cleansed} (best streak ${world.tally.bestStreak})`],
            ['Powers absorbed', runTally.powersAbsorbed],
            ['Best item', runTally.bestItem ? runTally.bestItem.name : 'none'],
            ['Seed', rng.seed.toString(SEED_RADIX).toUpperCase()],
          ],
          button: 'Wake again',
        }).then(() => ctx.restart());
      }

      /**
       * Asks who wakes and on which night, but only once there is a choice: a first-time player goes straight in as a
       * Pilgrim at Dusk. Each question is skipped while it has a single answer.
       * @returns {Promise<void>} resolves when the run has begun
       */
      function chooseWake() {
        const askOne = (title, rows) =>
          rows.length < 2 ? Promise.resolve(rows[0]) : ui.choose({ title, options: rows.map((row) => ({ title: row.name, desc: row.desc })) }).then((index) => rows[index]);
        return askOne('Who wakes?', META.availableClasses(profile))
          .then((classRow) => askOne('Which night?', META.availableTiers(profile)).then((tier) => META.beginRun(build, world, classRow, tier)))
          .then(() => (isSettingUp = false));
      }

      const run = Kit.fsm(
        {
          hunt: { update: advance },
          boss: {
            enter() {
              ui.toast('The Gravelord wakes');
              sfx.play('lose', { pitch: 0.5 });
            },
            update: advance,
          },
          dead: { enter: showDeathBanner },
        },
        'hunt'
      );

      // ---- per-frame drawing ------------------------------------------------------------------------------------

      function drawHero(dt) {
        const { hero } = world;
        const { group, cloak, lantern, readyRing } = heroView;
        group.position.set(hero.x, 0, hero.z);
        group.rotation.y = Math.atan2(hero.facingX, hero.facingZ);
        cloak.material.opacity = hero.phaseTimer > 0 || hero.dash ? HERO_LOOK.veilOpacity : 1;
        lantern.intensity = LANTERN.intensity * (1 + Math.sin(world.time * LANTERN.flickerRate) * LANTERN.flicker);
        readyRing.visible = hero.cooldownTimer <= 0;
        cameraFocus.x = math.damp(cameraFocus.x, hero.x, VIEW.followRate, dt);
        cameraFocus.z = math.damp(cameraFocus.z, hero.z, VIEW.followRate, dt);
        ctx.camera.position.set(cameraFocus.x, cameraDistance * Math.cos(VIEW.tilt), cameraFocus.z + cameraDistance * Math.sin(VIEW.tilt));
        ctx.camera.lookAt(cameraFocus.x, 0, cameraFocus.z);
        stage.follow({ x: cameraFocus.x, y: 0, z: cameraFocus.z });
      }

      function drawHud() {
        const need = SIM.absorbNeed(world);
        vitals.setHealth(world.hero.hp / stats.get('maxHp'));
        absorbGauge.set(world.absorb.meter / need);
        absorbGauge.label(`Absorb ${world.absorb.meter}/${need}`);
        timeStat.set(ctx.fmtTime(world.time));
      }

      // Handle for scripted playtests (scratch/souls/play.js): the live models, read-only by convention.
      ctx.soulwake = { world, build, run, ...build };
      chooseWake();

      return {
        update(dt) {
          run.update(dt);
          drawHero(dt);
          syncZombies(world.zombies, placeZombie);
          syncSouls(world.souls, placeSoul);
          syncDrops(world.drops, placeDrop);
          syncShots(world.shots, placeShot);
          syncHazards(world.hazards, placeHazard);
          fireflies.update(world.time);
          drawHud();
        },
      };
    },
  });
})();
