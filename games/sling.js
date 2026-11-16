// Tower Smash: pull back, launch, topple. Break every glowing target before the loadout runs out.
//
// DEPTH PLAN (AGENTS.md principle 5)
//   Seconds - mastery. One drag sets power, loft and turn; the dotted arc is exact up to the first obstacle and no
//     further, so reading what happens after the hit is the skill: knock out a glass post or a base block and the
//     tower does the work, light a keg and it chains, bank off a green bumper to reach a gem behind stone, lean into
//     the wind. Every break in one shot extends that shot's chain and a gem pays its points times the chain, so the
//     same clear scores 300 or 2000. Three stars: clear it, clear it with a shot to spare, land a chain of par.
//   Minutes - decisions. Before a level the player fills its shot slots from their collection under a point budget
//     (heavy 1, splitter 2, bouncer 2, bomb 3) and the order is the order they fire. Materials counter balls: stone
//     only moves for the heavy ball and feels a third of a blast; crystal cannot be blasted and light splitter
//     fragments glance off it; glass and kegs reward spread and chains. So "bomb first to open it" and "three cheap
//     balls and keep a spare for the second star" are both right somewhere, and wind changes which.
//   Hours - the long arc. Stars open worlds with new rules (Quarry: stone and bank shots; Gale Ridge: crosswind and
//     crystal; Skyline: endless generated towers that keep getting harder), new balls, and the daily tower (one
//     seeded puzzle with a dealt loadout). Shards from scores buy workshop upgrades, the best of which add a tap
//     ability (the heavy ball's slam, the bomb's trigger) and so change how a ball is played. Levels beyond the
//     hand-made ones come from a generator with a difficulty rating that sets shots, budget and chain par.
//   Proof: scratch/sling/solve.js plays every campaign level headless with an aim search and simulates the unlock curve.
//
// This file owns: everything seen, heard and touched (scene, launcher, preview, camera, HUD, theme, menus) and the
// level flow. It does not own: tunables, content and progression rules (games/sling-data.js), the physics and rules
// of a shot (games/sling-sim.js), or generic pieces (Kit.physics, Kit.ballistics, Kit.loadout, Kit.envelope, ctx.ui).
(() => {
  const DATA = window.TOWER_SMASH_DATA, SIM = window.TOWER_SMASH_SIM;
  const { WORLD, AIM, SETTLE, COLORS: MATERIAL_COLORS, BALLS, WORLDS, SHOT_BONUS } = DATA;
  const { clamp, lerp, damp, rand } = Kit.math;
  const { direction } = Kit.ballistics;

  // =========================================== presentation tables ===========================================

  /** @typedef {{ x: number, y: number, z: number }} Vector World-space point or velocity (metres, seconds). */

  /** How aiming feels in the hand (the aim geometry itself is DATA.AIM). */
  const AIM_FEEL = {
    ratchetTicks: 12, // clicks (and haptic ticks) across the full pull
    drawBack: 1.5, // metres the ball is pulled back at full power
    trembleAbove: 0.92, // the ball shivers once the pull passes this
    trembleSize: 0.03,
    idleBob: { rate: 3, height: 0.03 },
    buzz: { tick: 4, fullDraw: 12, release: 18 }, // milliseconds
  };

  /** The dotted flight preview: every `dotSpacing`-th physics step gets a dot, and the dots march along the path. */
  const PREVIEW_LOOK = { dotSpacing: 3, dotCount: 36, marchRate: 24, dotScale: [1.25, 0.75], reticlePulse: { rate: 10, size: 0.12 } };

  /** Impact feel. The first hard hit of a shot is the one big moment: brief slow motion, a camera push and a bass thud. */
  const FEEL = {
    slowMotion: [0.3, 0.14, 0.3], // fx.slowmo(scale, hold seconds, recover seconds): short, so it never drags
    thud: { minSpeed: 2.5, dustSpeed: 5, fullVolumeSpeed: 14, minGapMs: 55 }, // gap stops a collapse from machine-gunning sounds
    impactFullSpeed: 24, // contact speed at which debris and shake max out
    trailSpeed: 5,
    chainPitchStep: 0.15,
    maxChainPitch: 2.2,
    popIn: { stagger: 0.014, seconds: 0.3 }, // the tower builds itself block by block
    windStreak: { everySeconds: 0.12, speedPerWind: 1.6 },
  };

  /** Camera seat per orientation, how it leans with the aim, tracks the ball and pushes in on the first impact. */
  const CAMERA = {
    seat: { portrait: { height: 4.4, distance: 10.5 }, landscape: { height: 3.9, distance: 8.6 } },
    lookHeight: 2.3,
    aimLean: { side: 1.2, drop: 0.5, back: 0.9, lookSide: 3, lookUp: 0.8 }, // scaled by power
    follow: { lookSide: 0.35, lookUp: 0.25, side: 0.2 }, // share of the lead ball's offset the camera follows
    push: { hold: 0.7, rate: 7, moveShare: 0.08, lookShare: 0.5, fovDrop: 2 },
    recoil: { fov: 5, fall: 6 }, // field-of-view kick on release, scaled by power
    positionRate: 6,
    lookRate: 7,
    fov: { base: 55, perPower: 3, rate: 12, epsilon: 0.01 },
  };

  const COLORS = { white: 0xffffff, ember: 0xffc145, smoke: 0x6b6480, glowCold: 0x6a35e0, glowHot: 0xff4a1c, marker: 0xff2f8f };

  /** Hazard stripes for the powder keg, painted once into a small canvas texture. */
  const paintHazardStripes = (context, width, height) => {
    context.fillStyle = '#2b2440';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#ff8a1f';
    context.lineWidth = width / 6;
    // Diagonals half a tile apart, starting off-canvas so the pattern covers both corners.
    [-1, 0, 1, 2].forEach((offset) => {
      context.beginPath();
      context.moveTo((offset * width) / 2, height);
      context.lineTo((offset * width) / 2 + width / 2, 0);
      context.stroke();
    });
    context.lineWidth = width / 10;
    context.strokeRect(0, 0, width, height);
  };

  /**
   * How each block material is drawn, keyed by BlockMaterial.id: `surface` is passed to ctx.make.mat, `glow` makes the
   * block emit its own colour at that intensity, `pulse` makes that glow breathe (targets), `paint` is a texture painter.
   */
  const MATERIAL_LOOKS = {
    brick: { surface: { rough: 0.55 } },
    glass: { surface: { opacity: 0.45, rough: 0.08 } },
    keg: { surface: { rough: 0.6, fresh: true }, paint: paintHazardStripes },
    gem: { surface: { rough: 0.3, fresh: true }, glow: 0.5, pulse: 0.25 },
    crystal: { surface: { rough: 0.08, metal: 0.3, fresh: true }, glow: 0.4, pulse: 0.2 },
    stone: { surface: { rough: 0.95, flat: true } },
    bumper: { surface: { rough: 0.4 }, glow: 0.35 },
  };

  /** How a target announces itself: a pulsing halo and a spinning marker floating above it. */
  const TARGET_DECOR = { glowSize: 2.6, glowOpacity: 0.6, glowPulse: 0.3, pulseRate: 5, markerRadius: 0.16, markerGap: 0.45, markerBob: { rate: 4, height: 0.08 }, markerSpin: 3 };

  const BALL_SURFACE = { rough: 0.28, metal: 0.35 };
  const BOMB_PULSE = { rate: 40, size: 0.08 };

  /** Particle recipes (options for fx.burst), keyed by the event that fires them. */
  const BURSTS = {
    target: { count: 30, speed: 7, life: 0.8, size: 0.2, gravity: 8 },
    glass: { count: 16, colors: [MATERIAL_COLORS.glass, COLORS.white], speed: 5, life: 0.6, size: 0.16, gravity: 14, floor: 0.03 },
    dust: { count: 4, color: COLORS.white, speed: 2, life: 0.6, size: 0.2, gravity: 1.5, up: 0.4 },
    fireball: { count: 46, colors: [0xff6a4d, COLORS.ember, COLORS.white], speed: 10, life: 0.75, size: 0.24, gravity: 5 },
    smoke: { count: 12, color: COLORS.smoke, speed: 3, life: 1.1, size: 0.5, gravity: -1.5 },
    split: { count: 18, speed: 5, life: 0.4, gravity: 2 },
    puff: { count: 8, speed: 2.5, life: 0.35, gravity: 0 },
    trail: { count: 1, speed: 0.4, life: 0.4, gravity: 0 },
    confetti: { count: 26, colors: [...DATA.PALETTE, MATERIAL_COLORS.gem], speed: 9, life: 1.3, size: 0.18, gravity: 7, up: 0.8 },
    windStreak: { count: 1, color: COLORS.white, life: 0.9, size: 0.07, gravity: 0, up: 0, spread: 0.05 },
  };

  /**
   * HUD theme: the HUD is built from the same toy blocks as the stage. Panels are lavender slabs with the platform's pale
   * lip, shots sit in a rack as the actual balls of the loadout (each pip carries its ball's colour in --ball), targets
   * left are a row of pink diamonds that go hollow as they break, and the map, loadout and workshop are built from the
   * same slabs.
   */
  const THEME = {
    skin: 'toy',
    fonts: ['Lilita One', 'Nunito:wght@700;900'],
    tokens: {
      '--display': '"Lilita One", "Baloo 2", "Trebuchet MS", sans-serif',
      '--body': '"Nunito", system-ui, sans-serif',
      '--panel': '#f3ecff',
      '--ink': '#3b2a73',
      '--dim': '#8672d6',
      '--line': '#ffffff',
      '--accent': '#ff4fa3',
      '--accent-ink': '#ffffff',
      '--accent-edge': '#c22b78',
      '--scrim': 'rgba(59, 42, 115, 0.42)',
      '--radius': '14px',
      '--radius-lg': '18px',
      '--border': '2px',
      '--shadow': '0 4px 0 #8672d6',
      '--stat-size': '20px',
      '--floater': '#ffffff',
      '--slab-dark': '#5a4a94', // the launcher's base colour: lips under dark pieces
      '--star': '#ffc145',
    },
    layout: { stats: 'top-right' },
    css: `
      & .stat { padding: 4px 10px 6px; }
      & .stat span { font: 900 10px var(--body); }
      & .stat:not(.pips) { align-items: center; min-width: 48px; background: var(--dim); box-shadow: 0 4px 0 var(--slab-dark); }
      & .stat:not(.pips) span, & .stat:not(.pips) b { color: #fff; }
      & .pip-row { gap: 5px; min-height: 22px; }
      & [data-pips="shots"] .pip { width: 16px; height: 16px; border: 0; background: rgba(90, 74, 148, 0.16); box-shadow: inset 0 2px 2px rgba(59, 42, 115, 0.4); }
      & [data-pips="shots"] .pip.on { background: radial-gradient(circle at 34% 28%, #fff 0 10%, var(--ball, #5d6480) 46%); box-shadow: 0 2px 0 rgba(59, 42, 115, 0.45); }
      & [data-pips="shots"] .pip:not(.on) { transform: scale(0.8); }
      & [data-pips="gems"] .pip-row { gap: 9px; padding: 0 3px; }
      & [data-pips="gems"] .pip { width: 11px; height: 11px; border-radius: 2px; border: 2px solid var(--accent); transform: rotate(45deg); opacity: 0.35; }
      & [data-pips="gems"] .pip.on { background: var(--accent); opacity: 1; box-shadow: 0 0 8px var(--accent); }
      & .toast { max-width: 92%; font-size: 25px; color: #fff; text-shadow: 0 3px 0 var(--slab-dark); }
      & .hint { background: var(--ink); color: #fff; border-color: transparent; box-shadow: 0 4px 0 rgba(59, 42, 115, 0.3); font: 700 15px var(--body); }
      & .modal-card h2 { font-size: 38px; text-align: center; color: #fff; text-shadow: 0 4px 0 var(--slab-dark); transform: rotate(-2deg); }
      & .modal-card p { text-align: center; font: 900 20px var(--body); letter-spacing: 0.06em; color: #ffe08a; text-shadow: 0 2px 0 rgba(59, 42, 115, 0.6); }
      & .primary { border-radius: 999px; }
      & .ts-wind { align-self: flex-end; padding: 3px 12px; border-radius: 999px; background: var(--ink); color: #fff; font: 900 13px var(--body); letter-spacing: 0.04em; box-shadow: 0 3px 0 rgba(59, 42, 115, 0.3); }
      & .ts-slab { background: var(--panel); border: 2px solid #fff; border-radius: var(--radius-lg); box-shadow: var(--shadow); padding: 10px 12px; margin-bottom: 12px; color: var(--ink); text-align: left; }
      & .ts-slab h3 { margin: 0; font: 400 20px var(--display); }
      & .ts-slab small { display: block; font: 700 13px var(--body); color: var(--dim); }
      & .ts-slab[data-locked] { opacity: 0.6; }
      & .ts-summary { display: flex; justify-content: center; gap: 18px; margin-bottom: 12px; font: 400 20px var(--display); color: #fff; text-shadow: 0 2px 0 var(--slab-dark); }
      & .ts-summary b { color: var(--star); font-weight: 400; }
      & .ts-levels { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      & .ts-level { min-width: 46px; padding: 5px 6px 3px; border-radius: 12px; background: var(--dim); color: #fff; font: 400 17px var(--display); border-bottom: 4px solid var(--slab-dark); line-height: 1.05; }
      & .ts-level i { display: block; font: 900 10px var(--body); font-style: normal; color: var(--star); letter-spacing: 1px; }
      & .ts-level[data-next] { background: var(--accent); border-bottom-color: var(--accent-edge); }
      & .ts-level:disabled { background: rgba(134, 114, 214, 0.25); border-bottom-color: transparent; color: rgba(59, 42, 115, 0.4); }
      & .ts-buttons { display: flex; gap: 8px; margin-bottom: 12px; }
      & .ts-button { flex: 1; padding: 9px 6px; border-radius: 14px; background: var(--ink); color: #fff; font: 400 16px var(--display); border-bottom: 4px solid #241a4d; }
      & .ts-button:disabled { opacity: 0.45; }
      & .ts-slots { display: flex; gap: 8px; justify-content: center; margin: 10px 0 4px; }
      & .ts-slot { flex: 1; max-width: 86px; padding: 8px 4px 6px; border-radius: 14px; background: #fff; border-bottom: 4px solid var(--dim); color: var(--ink); font: 900 11px var(--body); }
      & .ts-ball { display: block; width: 34px; height: 34px; margin: 0 auto 4px; border-radius: 50%; background: radial-gradient(circle at 34% 28%, #fff 0 9%, var(--ball) 46%); box-shadow: 0 3px 0 rgba(59, 42, 115, 0.35); }
      & .ts-row { display: flex; align-items: center; gap: 10px; }
      & .ts-row .ts-ball { margin: 0; flex: none; }
      & .ts-row div { flex: 1; min-width: 0; }
      & .ts-cost { flex: none; min-width: 44px; padding: 6px 8px; border-radius: 12px; background: var(--accent); color: #fff; font: 400 15px var(--display); border-bottom: 3px solid var(--accent-edge); text-align: center; }
      & .ts-cost:disabled { background: rgba(134, 114, 214, 0.3); border-bottom-color: transparent; }
      & .ts-rule { display: flex; justify-content: space-between; font: 800 14px var(--body); color: var(--dim); }
      & .ts-rule[data-met] { color: var(--ink); }
      & .ts-rule b { color: var(--star); font-size: 16px; }
    `,
  };

  /** Star row for banners and the map: filled stars then hollow ones. */
  const starRow = (stars, outOf = DATA.STAR_RULES.length) => '★'.repeat(stars) + '☆'.repeat(outOf - stars);
  const cssColor = (hex) => '#' + hex.toString(16).padStart(6, '0');
  /** Level label for the HUD, e.g. "2-3" (world number, level number). */
  const levelLabel = (level) => (level.worldId === 'daily' ? 'Daily' : `${WORLDS.findIndex((world) => world.id === level.worldId) + 1}-${level.index + 1}`);
  /** Wind chip text: arrows point where the wind pushes, one per `WIND_ARROW_STEP` of strength. */
  const WIND_ARROW_STEP = 2.5;
  const windLabel = (windX) => `Wind ${(windX > 0 ? '→' : '←').repeat(clamp(Math.ceil(Math.abs(windX) / WIND_ARROW_STEP), 1, 3))}`;

  // ================================================ scene builders ================================================

  /** Daylight pastel toy box: soft sky, a distant skyline for depth, and the platform. Weight comes from physics and sound. */
  function buildBackdrop(make) {
    const { platform } = WORLD;
    const stage = make.stage({ sky: [0x86b6ff, 0xfde6f1], fog: [45, 130], shadow: 12, sun: [6, 14, 8], ambient: 0.85 });
    stage.follow({ x: 0, y: 0, z: -3 });
    make.ground(200, 0xc9bdf2, { grid: 0xffffff, gridOpacity: 0.35 });
    const SKYLINE = { count: 9, width: 3.2, spacing: 7.5, z: -42 };
    Array.from({ length: SKYLINE.count }, (_, index) => {
      // Deterministic pseudo-variety (no random): heights and depths cycle with coprime periods so no two neighbours match.
      const height = 5 + ((index * 7) % 5) * 2.4;
      const x = (index - (SKYLINE.count - 1) / 2) * SKYLINE.spacing + (index % 2) * 2;
      return make.box(SKYLINE.width, height, SKYLINE.width, 0xb7a6ec, { at: [x, height / 2, SKYLINE.z - (index % 3) * 7], shadow: false });
    });
    make.box(platform.halfWidth * 2, platform.top, platform.halfDepth * 2, 0x8672d6, { at: [0, platform.top / 2, platform.z], rough: 0.8 });
    // A pale lip around the top edge so the platform's footprint reads from the low camera.
    make.box(platform.halfWidth * 2 + 0.16, 0.1, platform.halfDepth * 2 + 0.16, 0xf3ecff, { at: [0, platform.top - 0.06, platform.z], shadow: false });
  }

  /**
   * The slingshot: base, fork with glowing tips, an elastic band that stretches to the ball, and the ball waiting in it.
   * @returns {{ glowMaterial: object, load(ballType: object, surface: object): void, hold(position: Vector): void,
   *   hideBall(): void, fire(): void, update(power: number): void }}
   */
  function buildLauncher(ctx, launchPoint, ballGeometry) {
    const { THREE, make } = ctx;
    const FORK = { halfWidth: 0.78, tipHeight: 1.76, color: 0x6b5ab0, bandThickness: [0.09, 0.035], recoilScale: [1.12, 0.8, 1.12], snapSeconds: 0.45, recoilSeconds: 0.5, loadSeconds: 0.25 };
    const group = make.group({ at: [0, 0, launchPoint.z] });
    make.cyl(0.85, 1.05, 0.45, 0x5a4a94, { parent: group, at: [0, 0.225, 0] });
    make.cyl(0.16, 0.22, 0.6, FORK.color, { parent: group, at: [0, 0.7, 0] });
    make.box(1.72, 0.16, 0.18, FORK.color, { parent: group, at: [0, 0.98, 0] });
    // Tips, band and flight preview share one material, so a single colour change heats them all up with power.
    const glowMaterial = make.unlit(COLORS.glowCold, { fresh: true });
    const coldColor = make.color(COLORS.glowCold), hotColor = make.color(COLORS.glowHot);
    const tips = [-1, 1].map((side) => {
      make.box(0.16, 0.7, 0.16, FORK.color, { parent: group, at: [side * FORK.halfWidth, 1.36, 0] });
      make.sphere(0.13, glowMaterial, { parent: group, at: [side * FORK.halfWidth, FORK.tipHeight, 0], shadow: false });
      return new THREE.Vector3(side * FORK.halfWidth, FORK.tipHeight, launchPoint.z);
    });
    const bands = tips.map(() => make.mesh(new THREE.BoxGeometry(1, 1, 1), glowMaterial, { shadow: false }));
    const pouch = launchPoint.clone(); // where the two band halves meet: the ball while aiming, then it snaps back
    const readyBall = make.mesh(ballGeometry, glowMaterial);
    readyBall.visible = false;
    return {
      glowMaterial,
      load(ballType, surface) {
        readyBall.visible = true;
        readyBall.material = surface;
        readyBall.position.copy(launchPoint);
        pouch.copy(launchPoint);
        readyBall.scale.setScalar(0.01);
        ctx.tween(readyBall.scale, { x: ballType.radius, y: ballType.radius, z: ballType.radius }, FORK.loadSeconds, 'outBack');
      },
      hold(position) {
        readyBall.position.copy(position);
        pouch.copy(position);
      },
      hideBall() {
        readyBall.visible = false;
      },
      fire() {
        // Snap: the band whips forward from wherever the ball was released and the fork recoils.
        ctx.tween(pouch, { x: launchPoint.x, y: launchPoint.y, z: launchPoint.z }, FORK.snapSeconds, 'outElastic');
        group.scale.set(...FORK.recoilScale);
        ctx.tween(group.scale, { x: 1, y: 1, z: 1 }, FORK.recoilSeconds, 'outElastic');
      },
      update(power) {
        glowMaterial.color.copy(coldColor).lerp(hotColor, power);
        const thickness = FORK.bandThickness[0] - power * FORK.bandThickness[1]; // the band thins as it stretches
        bands.forEach((band, index) => {
          band.position.copy(tips[index]).add(pouch).multiplyScalar(0.5);
          band.lookAt(pouch);
          band.scale.set(thickness, thickness, tips[index].distanceTo(pouch));
        });
      },
    };
  }

  /**
   * Dotted flight preview plus a reticle at the predicted contact point.
   * @returns {{ show(flight: { points: Vector[], end: Vector }, time: number): void, hide(): void }}
   */
  function buildPreview(ctx, material) {
    const { THREE, make } = ctx;
    const dotGeometry = new THREE.SphereGeometry(0.085, 8, 6);
    const dots = Array.from({ length: PREVIEW_LOOK.dotCount }, () => make.mesh(dotGeometry, material, { shadow: false }));
    const reticle = make.mesh(new THREE.RingGeometry(0.26, 0.38, 28), material, { shadow: false });
    const hide = () => [...dots, reticle].forEach((mesh) => (mesh.visible = false));
    hide();
    return {
      hide,
      show(flight, time) {
        // The phase shifts which steps get a dot, so the dots crawl toward the target and the arc reads as motion.
        const phase = Math.floor(time * PREVIEW_LOOK.marchRate) % PREVIEW_LOOK.dotSpacing;
        const marks = flight.points.map((point, step) => ({ point, step })).filter(({ step }) => (step + 1 + phase) % PREVIEW_LOOK.dotSpacing === 0);
        dots.forEach((dot, index) => {
          const mark = marks[index];
          dot.visible = !!mark;
          if (!mark) return;
          dot.position.copy(mark.point);
          dot.scale.setScalar(lerp(PREVIEW_LOOK.dotScale[0], PREVIEW_LOOK.dotScale[1], mark.step / DATA.PREVIEW.maxSteps)); // far dots shrink
        });
        reticle.visible = true;
        reticle.position.copy(flight.end);
        reticle.scale.setScalar(1 + Math.sin(time * PREVIEW_LOOK.reticlePulse.rate) * PREVIEW_LOOK.reticlePulse.size);
        reticle.quaternion.copy(ctx.camera.quaternion); // billboard
      },
    };
  }

  /**
   * Camera rig: frames launcher and tower, leans with the aim, tracks the lead ball and pushes in on a shot's first impact.
   * It runs on real seconds, so slow motion slows the world but not the camera.
   * @returns {{ pushIn(point: Vector): void, kick(power: number): void,
   *   update(realSeconds: number, view: { power: number, aimSide: number, leadBall: Vector | null }): void }}
   */
  function buildCameraRig(ctx) {
    const { THREE, camera } = ctx;
    const platformZ = WORLD.platform.z;
    const push = Kit.envelope({ rise: CAMERA.push.rate, fall: CAMERA.push.rate });
    const recoil = Kit.envelope({ rise: Infinity, fall: CAMERA.recoil.fall });
    const focus = new THREE.Vector3(0, 3, platformZ); // last impact point
    const lookAt = new THREE.Vector3(0, CAMERA.lookHeight, platformZ);
    const wantedPosition = new THREE.Vector3(), wantedLookAt = new THREE.Vector3();
    let fieldOfView = camera.fov;
    const dampToward = (current, wanted, rate, seconds) =>
      current.set(damp(current.x, wanted.x, rate, seconds), damp(current.y, wanted.y, rate, seconds), damp(current.z, wanted.z, rate, seconds));
    camera.position.set(0, CAMERA.seat.portrait.height, CAMERA.seat.portrait.distance);
    return {
      pushIn(point) {
        focus.copy(point);
        push.fire(1, CAMERA.push.hold);
      },
      kick: (power) => recoil.fire(CAMERA.recoil.fov * power),
      update(realSeconds, { power, aimSide, leadBall }) {
        const seat = ctx.size.portrait ? CAMERA.seat.portrait : CAMERA.seat.landscape;
        const { aimLean, follow } = CAMERA;
        const pushAmount = push.update(realSeconds), recoilAmount = recoil.update(realSeconds);
        // Lean opposite the aim and sink back with power, so the arc stays in view while the thumb covers the launcher.
        wantedPosition.set(-aimSide * power * aimLean.side, seat.height - power * aimLean.drop, seat.distance + power * aimLean.back);
        wantedLookAt.set(aimSide * power * aimLean.lookSide, CAMERA.lookHeight + power * aimLean.lookUp, platformZ);
        if (leadBall) {
          wantedLookAt.x += leadBall.x * follow.lookSide;
          wantedLookAt.y += (leadBall.y - CAMERA.lookHeight) * follow.lookUp;
          wantedPosition.x += leadBall.x * follow.side;
        }
        wantedPosition.lerp(focus, CAMERA.push.moveShare * pushAmount);
        wantedLookAt.lerp(focus, CAMERA.push.lookShare * pushAmount);
        dampToward(camera.position, wantedPosition, CAMERA.positionRate, realSeconds);
        dampToward(lookAt, wantedLookAt, CAMERA.lookRate, realSeconds);
        camera.lookAt(lookAt);
        const wantedFov = CAMERA.fov.base + power * CAMERA.fov.perPower + recoilAmount - pushAmount * CAMERA.push.fovDrop;
        fieldOfView = damp(fieldOfView, wantedFov, CAMERA.fov.rate, realSeconds);
        if (Math.abs(fieldOfView - camera.fov) < CAMERA.fov.epsilon) return; // skip the matrix rebuild when nothing moved
        camera.fov = fieldOfView;
        camera.updateProjectionMatrix();
      },
    };
  }

  /**
   * Shared render materials: one per block material and colour (memoised) and one per ball type.
   * @returns {{ forBlock(material: object, color: number): object, forBall(ballType: object): object, pulsing(): { surface: object, look: object }[] }}
   */
  function buildSurfaces(make) {
    const TEXTURE_SIZE = 64;
    const blockSurfaces = new Map();
    const createBlockSurface = (material, color) => {
      const look = MATERIAL_LOOKS[material.id];
      const glow = look.glow ? { emissive: color, emissiveIntensity: look.glow } : {};
      // A painted material carries its colour in the texture, so the base colour must stay white.
      const surface = make.mat(look.paint ? COLORS.white : color, { ...look.surface, ...glow });
      if (look.paint) surface.map = make.canvasTexture(TEXTURE_SIZE, TEXTURE_SIZE, look.paint);
      return { surface, look };
    };
    const ballSurfaces = Object.fromEntries(BALLS.map((ballType) => [ballType.id, make.mat(ballType.color, { emissive: ballType.emissive, ...BALL_SURFACE })]));
    return {
      forBlock(material, color) {
        const key = `${material.id}:${color}`;
        if (!blockSurfaces.has(key)) blockSurfaces.set(key, createBlockSurface(material, color));
        return blockSurfaces.get(key).surface;
      },
      forBall: (ballType) => ballSurfaces[ballType.id],
      /** The surfaces whose glow breathes (targets), for the per-frame pulse. */
      pulsing: () => [...blockSurfaces.values()].filter((entry) => entry.look.pulse),
    };
  }

  // ==================================================== menus ====================================================

  /**
   * The three sheets between levels (map, loadout, workshop), built from ctx.ui.panel and plain elements styled by
   * THEME.css. Each returns a promise for what the player chose; none of them changes game state itself.
   * @param {object} ctx @param {object} progress From DATA.createProgress.
   */
  function buildMenus(ctx, progress) {
    const { ui } = ctx;
    const ballDot = (ballType) => {
      const dot = ui.h('span', 'ts-ball');
      dot.style.setProperty('--ball', cssColor(ballType.color));
      return dot;
    };
    /** A button that closes the sheet with `value` (or runs `onPress`); pointer events are on for menu buttons only. */
    const pressable = (className, text, onPress) => {
      const element = ui.h('button', className, text);
      element.style.pointerEvents = 'auto';
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.sfx.play('click');
        onPress(event);
      });
      return element;
    };
    const slab = (title, note) => {
      const element = ui.h('div', 'ts-slab');
      element.append(ui.h('h3', null, title), ui.h('small', null, note));
      return element;
    };

    /** One world on the map: its levels as buttons with the stars earned, or what it takes to open. */
    const worldSlab = (world, next, close) => {
      const isOpen = progress.isWorldOpen(world);
      const element = slab(world.name, isOpen ? world.blurb : `Opens at ${world.unlockStars} stars`);
      if (!isOpen) {
        element.dataset.locked = 'true';
        return element;
      }
      // An endless world shows only its next floor; the others show every level.
      const indexes = world.isEndless ? [Math.max(0, progress.firstUnclearedIn(world))] : Array.from({ length: world.levels }, (_, index) => index);
      const levels = ui.h('div', 'ts-levels');
      levels.append(...indexes.map((index) => {
        const button = pressable('ts-level', world.isEndless ? `Floor ${index + 1}` : String(index + 1), () => close({ worldId: world.id, index }));
        button.append(ui.h('i', null, starRow(progress.recordOf(`${world.id}:${index}`).stars)));
        button.disabled = !progress.isLevelOpen(world.id, index);
        if (next.worldId === world.id && next.index === index) button.dataset.next = 'true';
        return button;
      }));
      element.append(levels);
      return element;
    };

    return {
      /**
       * The map: worlds, levels and stars, plus the workshop and the daily tower.
       * @returns {Promise<{ worldId: string, index: number } | 'workshop' | 'daily' | undefined>} undefined = "play next".
       */
      openMap() {
        const next = progress.nextLevel();
        return ui.panel({
          title: 'Tower Smash',
          closeLabel: 'Play next',
          build(body, close) {
            const summary = ui.h('div', 'ts-summary');
            summary.append(ui.h('span', null, `${progress.totalStars()} `), ui.h('span', null, `${progress.wallet.get('shards')} shards`));
            summary.firstChild.append(ui.h('b', null, '★'));
            const buttons = ui.h('div', 'ts-buttons');
            const daily = pressable('ts-button', progress.isDailyOpen() ? 'Daily tower' : `Daily: ${DATA.DAILY_UNLOCK_STARS} stars`, () => close('daily'));
            daily.disabled = !progress.isDailyOpen();
            buttons.append(pressable('ts-button', 'Workshop', () => close('workshop')), daily);
            body.append(summary, buttons, ...WORLDS.map((world) => worldSlab(world, next, close)));
          },
        });
      },

      /**
       * The loadout: tap a slot to step it through the balls you own that still fit the budget.
       * @param {object} level @param {string[]} remembered The last loadout used, tried first if it still fits.
       * @returns {Promise<string[] | 'map'>} Ball ids in firing order, or 'map' to go back.
       */
      openLoadout(level, remembered) {
        const owned = progress.ownedBalls().map((ballType) => ballType.id);
        const budget = progress.budgetFor(level), costOf = (id) => BALLS.byId(id).cost;
        const fallback = Array.from({ length: level.shots }, () => BALLS[0].id);
        const isUsable = remembered.length === level.shots && remembered.every((id) => owned.includes(id)) && remembered.reduce((total, id) => total + costOf(id), 0) <= budget;
        const loadout = Kit.loadout({ slots: level.shots, budget, costOf, initial: isUsable ? remembered : fallback });
        return ui.panel({
          title: level.name,
          closeLabel: 'Launch',
          build(body, close) {
            const brief = slab(level.ask, [`Third star: chain of ${level.chainPar}`, level.windX ? windLabel(level.windX) : 'Still air'].join('  |  '));
            const slots = ui.h('div', 'ts-slots'), points = ui.h('small');
            const drawSlots = () => {
              slots.textContent = '';
              slots.append(...loadout.picks().map((id, slot) => {
                const ballType = BALLS.byId(id);
                const button = pressable('ts-slot', undefined, () => loadout.cycle(slot, owned));
                button.append(ballDot(ballType), ui.h('span', null, ballType.name));
                return button;
              }));
              points.textContent = `${loadout.left()} of ${budget} points left. Tap a slot to swap its ball.`;
            };
            loadout.on(drawSlots);
            drawSlots();
            brief.append(slots, points);
            const cards = progress.ownedBalls().map((ballType) => {
              const card = slab(`${ballType.name}  (${ballType.cost})`, `${ballType.description} ${ballType.versus}`);
              const line = ui.h('div', 'ts-row'), text = ui.h('div');
              text.append(...card.childNodes);
              line.append(ballDot(ballType), text);
              card.append(line);
              return card;
            });
            body.append(brief, ...cards, pressable('ts-button', 'Back to the map', () => close('map')));
          },
        }).then((choice) => choice || loadout.filled());
      },

      /** The workshop: upgrades for the balls you own, paid in shards. Resolves when closed. */
      openWorkshop() {
        const { upgrades, wallet } = progress;
        const isOffered = (row) => !row.ball || progress.isBallOwned(BALLS.byId(row.ball));
        const priceText = (row) => {
          if (upgrades.maxed(row.id)) return 'MAX';
          return upgrades.unlocked(row.id) ? String(upgrades.cost(row.id)) : 'Locked';
        };
        return ui.panel({
          title: 'Workshop',
          closeLabel: 'Back',
          build(body) {
            const draw = () => {
              body.textContent = '';
              const summary = ui.h('div', 'ts-summary');
              summary.append(ui.h('span', null, `${wallet.get('shards')} shards`));
              const rows = upgrades.table.filter(isOffered).map((row) => {
                const card = ui.h('div', 'ts-slab'), line = ui.h('div', 'ts-row'), text = ui.h('div');
                text.append(ui.h('h3', null, `${row.name}  ${upgrades.level(row.id)}/${row.max}`), ui.h('small', null, row.desc));
                const buy = pressable('ts-cost', priceText(row), () => {
                  if (upgrades.buy(row.id)) ctx.sfx.play('up');
                  draw();
                });
                buy.disabled = !upgrades.canBuy(row.id);
                line.append(text, buy);
                card.append(line);
                return card;
              });
              body.append(summary, ...rows);
            };
            draw();
          },
        });
      },
    };
  }

  // ==================================================== the game ====================================================

  /**
   * Builds one session of Tower Smash.
   * @param {object} ctx The kit's game context.
   * @returns {{ update(dt: number, time: number): void }}
   */
  function createTowerSmash(ctx) {
    const { THREE, make, input, fx, sfx, ui, save } = ctx;
    const { platform } = WORLD;
    const launchPoint = new THREE.Vector3(WORLD.launchPoint.x, WORLD.launchPoint.y, WORLD.launchPoint.z);

    buildBackdrop(make);
    const surfaces = buildSurfaces(make);
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1), ballGeometry = new THREE.SphereGeometry(1, 28, 18);
    const launcher = buildLauncher(ctx, launchPoint, ballGeometry);
    const preview = buildPreview(ctx, launcher.glowMaterial);
    const cameraRig = buildCameraRig(ctx);
    const blockPool = ctx.pool(() => make.mesh(boxGeometry, surfaces.forBall(BALLS[0])));
    const ballPool = ctx.pool(() => make.mesh(ballGeometry, surfaces.forBall(BALLS[0])));
    const glowPool = ctx.pool(() => make.glow(COLORS.white, TARGET_DECOR.glowSize, { opacity: TARGET_DECOR.glowOpacity }));
    const markerPool = ctx.pool(() => make.ico(TARGET_DECOR.markerRadius, 0, make.unlit(COLORS.marker), { shadow: false }));

    const progress = DATA.createProgress({ save });
    const menus = buildMenus(ctx, progress);

    // ---- state: the level being played (null between levels) and the aim in progress ----
    /** @type {{ level: object, queue: string[], sim: object, popInCount: number, targetTotal: number, firstImpact: number[] | null } | null} */
    let play = null;
    let lastLoadout = save.get('loadout', []);
    let lastThudAt = 0;
    const aim = { isDragging: false, ratchetStep: 0, pull: 0, yaw: 0, loft: 0, speed: 0, direction: new THREE.Vector3(0, 0, -1) };
    /** Halo and marker of each live target, keyed by its block. */
    const targetDecor = new Map();

    const shotsLeft = () => play.queue.length - play.sim.state.shotsFired;
    const currentBall = () => BALLS.byId(play.queue[play.sim.state.shotsFired]);

    // Shots and targets are drawn as rows of tokens (styled by THEME.css): the loadout's balls in a rack, gems that go hollow.
    const levelStat = ui.stat('Tower', ''), shotRack = ui.pips('Shots'), gemRow = ui.pips('Gems');
    const windChip = ui.el('div', 'ts-wind', '');
    const hint = ui.hint('Drag back to aim, release to fire');
    function refreshHud() {
      const { level, queue, sim } = play;
      levelStat.set(levelLabel(level));
      shotRack.set(shotsLeft(), queue.length);
      // The rack is used from the right, so reversed slots keep the next ball as the last lit pip.
      [...shotRack.el.querySelectorAll('.pip')].forEach((pip, index) => pip.style.setProperty('--ball', cssColor(BALLS.byId(queue[queue.length - 1 - index]).color)));
      gemRow.set(sim.targetsLeft(), play.targetTotal);
      windChip.hidden = !level.windX;
      windChip.textContent = level.windX ? windLabel(level.windX) : '';
    }

    // ------------------------------------------- views of sim entities -------------------------------------------

    /** Mesh for a new block: pooled, dressed for its material, and popped in on a stagger so the tower builds itself. */
    function makeBlockMesh(spec, material, color) {
      const [width, height, depth] = spec.size, mesh = blockPool.get();
      mesh.material = surfaces.forBlock(material, color);
      mesh.scale.setScalar(0.001);
      ctx.after(play.popInCount++ * FEEL.popIn.stagger, () => ctx.tween(mesh.scale, { x: width, y: height, z: depth }, FEEL.popIn.seconds, 'outBack'));
      return mesh;
    }

    function makeBallMesh(ballType, radius) {
      const mesh = ballPool.get();
      mesh.material = surfaces.forBall(ballType);
      mesh.scale.setScalar(radius);
      return mesh;
    }

    function addTargetDecor(block) {
      const glow = glowPool.get();
      glow.material.color.copy(make.color(block.color));
      targetDecor.set(block, { glow, marker: markerPool.get(), markerHeight: block.spec.size[1] / 2 + TARGET_DECOR.markerGap });
    }

    function removeTargetDecor(block) {
      const decor = targetDecor.get(block);
      if (!decor) return;
      glowPool.release(decor.glow);
      markerPool.release(decor.marker);
      targetDecor.delete(block);
    }

    // ------------------------------------------------- feedback -------------------------------------------------

    /** Impact sound scaled by speed, rate-limited in real time so a collapsing tower rumbles instead of buzzing. */
    function playThud(speed, pitch) {
      const now = performance.now();
      if (speed < FEEL.thud.minSpeed || now - lastThudAt < FEEL.thud.minGapMs) return;
      lastThudAt = now;
      sfx.play('thud', { vol: clamp(speed / FEEL.thud.fullVolumeSpeed, 0.15, 1), pitch: pitch + rand(-0.12, 0.12) });
    }

    /** What breaking looks and sounds like, keyed by BlockMaterial.onBreak ('blast' is voiced by the blast event). */
    const BREAK_FEEDBACK = {
      score({ block, position, chain, points }) {
        fx.burst(position, { ...BURSTS.target, colors: [block.color, COLORS.white, COLORS.ember] });
        fx.floater((chain > 1 ? `x${chain}  ` : '') + `+${points}`, position, { color: '#ffd1e8', size: 24 + Math.min(chain, 6) * 4 });
        sfx.play('coin', { pitch: Math.min(FEEL.maxChainPitch, 1 + (chain - 1) * FEEL.chainPitchStep) });
        sfx.buzz(15);
        gemRow.set(play.sim.targetsLeft());
        gemRow.pulse();
      },
      shatter({ position }) {
        fx.burst(position, BURSTS.glass);
        sfx.play('perfect', { pitch: 2.1, vol: 0.5 });
        sfx.play('click', { pitch: 2.4, vol: 0.7 });
      },
      blast() {},
    };

    const canStillClear = () => flow.is('aiming') || flow.is('flying') || flow.is('settling');

    /** What the presenter does for each simulation event. */
    const SIM_FEEDBACK = {
      blockRemoved({ block }) {
        removeTargetDecor(block);
        blockPool.release(block.mesh);
      },
      ballRemoved({ ball, withPuff }) {
        if (withPuff) fx.burst(ball.mesh.position, { ...BURSTS.puff, color: ball.ballType.trail });
        ballPool.release(ball.mesh);
      },
      blockHit({ block, speed }) {
        playThud(speed, 1.15);
        if (speed > FEEL.thud.dustSpeed) fx.burst(block.body.position, BURSTS.dust);
      },
      ballHit({ speed, struck, isHard, point }) {
        if (!isHard) return playThud(speed, 0.8);
        const force = clamp(speed / FEEL.impactFullSpeed, 0.3, 1);
        playThud(speed, 0.7);
        fx.burst(point, { count: Math.round(8 + 16 * force), colors: [struck.color, struck.color, COLORS.white], speed: 4 + 6 * force, life: 0.75, size: 0.2, gravity: 14, floor: 0.03 });
        fx.shake(0.25 + 0.4 * force);
      },
      // The first hit of a shot is the one big moment: slow motion, camera push and a bass thud. Later hits stay quiet.
      firstImpact({ point }) {
        play.firstImpact = [point.x, point.y, point.z];
        cameraRig.pushIn(point);
        fx.slowmo(...FEEL.slowMotion);
        sfx.play('boom', { vol: 0.6, pitch: 1.25 });
        sfx.tone({ freq: 72, to: 28, dur: 0.5, type: 'sine', vol: 0.7 });
        sfx.buzz(30);
      },
      blast({ centre, radius }) {
        fx.burst(centre, BURSTS.fireball);
        fx.burst(centre, BURSTS.smoke);
        fx.ring(centre, { color: COLORS.ember, size: radius * 2, life: 0.45 });
        fx.flash('#ffb066', 180, 0.25);
        fx.shake(0.9);
        sfx.play('boom');
        sfx.buzz(45);
      },
      break(event) {
        BREAK_FEEDBACK[event.block.material.onBreak](event);
        if (play.sim.targetsLeft() === 0 && canStillClear()) flow.go('cleared');
      },
      split({ position, ballType, fragments }) {
        fragments.forEach((fragment) => {
          fragment.mesh.scale.setScalar(0.1);
          ctx.tween(fragment.mesh.scale, { x: fragment.radius, y: fragment.radius, z: fragment.radius }, 0.18, 'outBack');
        });
        sfx.play('perfect', { pitch: 1.3 });
        sfx.play('whoosh', { pitch: 1.6 });
        sfx.buzz(10);
        fx.ring(position, { color: ballType.trail, size: 2.4 });
        fx.burst(position, { ...BURSTS.split, color: ballType.trail });
      },
      slam({ position, ball }) {
        sfx.play('whoosh', { pitch: 0.5 });
        sfx.buzz(12);
        fx.ring(position, { color: ball.ballType.trail, size: 1.8 });
      },
    };

    // ------------------------------------------------- level flow -------------------------------------------------

    /** Tear down the level in play and build `level` with `queue` as the balls to fire, in order. */
    function beginLevel(level, queue) {
      if (play) play.sim.dispose();
      play = { level, queue, popInCount: 0, sim: null, targetTotal: 0, firstImpact: null };
      const sim = SIM.createSim({ level, stat: (name) => progress.stats.get(name), rng: Kit.rng(), views: { block: makeBlockMesh, ball: makeBallMesh } });
      play.sim = sim;
      // Blocks were announced while the sim was being built, before anyone could listen: dress the targets now.
      sim.state.blocks.filter((block) => block.material.isTarget).forEach(addTargetDecor);
      Object.keys(SIM_FEEDBACK).forEach((eventName) => sim.on(eventName, SIM_FEEDBACK[eventName]));
      play.targetTotal = sim.targetsLeft();
      refreshHud();
      flow.go('aiming');
      ui.toast(`${level.name}: ${level.ask}`, 1700);
      sfx.play('tap', { pitch: 0.7 });
    }

    /** Ask for a loadout if there is a choice to make, then start the level. */
    function chooseLoadoutFor(level) {
      const allHeavy = Array.from({ length: level.shots }, () => BALLS[0].id);
      if (progress.ownedBalls().length < 2) return beginLevel(level, allHeavy);
      flow.go('menu');
      return menus.openLoadout(level, lastLoadout).then((choice) => {
        if (choice === 'map') return showMap();
        lastLoadout = save.set('loadout', choice);
        return beginLevel(level, choice);
      });
    }

    const startDaily = () => {
      const { level, loadout } = DATA.dailyChallenge(progress.today());
      beginLevel(level, loadout);
    };

    /** The map decides what happens next: a level, the workshop (then back to the map) or the daily tower. */
    function showMap() {
      flow.go('menu');
      return menus.openMap().then((choice) => {
        if (choice === 'workshop') return menus.openWorkshop().then(showMap);
        if (choice === 'daily') return startDaily();
        const { worldId, index } = choice || progress.nextLevel();
        return chooseLoadoutFor(DATA.levelAt(worldId, index));
      });
    }

    function showCleared() {
      if (!flow.is('cleared')) return; // the level was restarted during the celebration beat
      const { level, sim } = play;
      const bonus = shotsLeft() * SHOT_BONUS;
      const result = { cleared: true, shotsLeft: shotsLeft(), bestChain: sim.state.bestChain, score: sim.state.score + bonus };
      const outcome = progress.recordResult(level, result);
      sfx.play('win');
      // A dash for an unmet rule, not a hollow star: the two read alike at this size.
      const ruleRows = outcome.rules.map((rule) => [rule.text, rule.isMet ? '★' : '–']);
      // Unlock texts read "New ball: Splitter": the part before the colon labels the row.
      const unlockRows = outcome.unlocked.map((text) => text.split(': '));
      ui.banner({ title: 'Tower down', text: starRow(outcome.stars), stats: [...ruleRows, ['Score', result.score], ['Shards', `+${outcome.shards}`], ...unlockRows], button: 'Continue' }).then(showMap);
    }

    function showFailed() {
      if (!flow.is('failed')) return;
      const { level } = play, standing = play.sim.targetsLeft();
      progress.recordResult(level, { cleared: false, shotsLeft: 0, bestChain: play.sim.state.bestChain, score: play.sim.state.score });
      sfx.play('lose');
      ui.banner({ title: 'Out of shots', text: `${standing} target${standing === 1 ? '' : 's'} still standing`, stats: [['Tower', levelLabel(level)], ['Best chain', play.sim.state.bestChain], ['Stars', progress.totalStars()]], button: 'Try again' })
        .then(() => (level.worldId === 'daily' ? startDaily() : chooseLoadoutFor(level)));
    }

    // --------------------------------------------------- aiming ---------------------------------------------------

    /** Ratchet clicks and haptic ticks as the pull crosses each step, with a brighter tap at full draw. */
    function playRatchet(pull) {
      const step = Math.floor(pull * AIM_FEEL.ratchetTicks);
      if (step === aim.ratchetStep) return;
      aim.ratchetStep = step;
      const isFullDraw = step === AIM_FEEL.ratchetTicks;
      sfx.play('click', { pitch: 0.8 + pull * 1.3, vol: 0.55 });
      sfx.buzz(isFullDraw ? AIM_FEEL.buzz.fullDraw : AIM_FEEL.buzz.tick);
      if (isFullDraw) sfx.play('tap', { pitch: 1.5, vol: 0.6 });
    }

    function updateAim() {
      const { pointer } = input;
      Object.assign(aim, DATA.aimFromDrag(pointer.x - pointer.sx, pointer.y - pointer.sy));
      aim.direction.copy(direction(aim.yaw, aim.loft));
      playRatchet(aim.pull);
    }

    function beginDrag() {
      aim.isDragging = true;
      aim.ratchetStep = 0;
    }

    function launch() {
      const ballType = currentBall(), { sim } = play;
      sim.launch(ballType, aim);
      flow.go('flying');
      launcher.fire();
      cameraRig.kick(aim.pull);
      sfx.play('whoosh', { pitch: 0.8 + aim.pull * 0.6 });
      sfx.tone({ freq: 240 + aim.pull * 160, to: 80, dur: 0.2, type: 'triangle', vol: 0.35 });
      sfx.buzz(AIM_FEEL.buzz.release);
      fx.shake(0.15 + aim.pull * 0.2);
      refreshHud();
      shotRack.pulse();
      if (sim.hasAbility(ballType)) ui.toast(ballType.ability.prompt, 900);
    }

    /** A press uses the flying ball's tap ability if it has one; otherwise it starts a drag while aiming. */
    function onPress() {
      hint.hide();
      if (flow.is('flying') && play.sim.tap()) return;
      if (flow.is('aiming')) beginDrag();
    }

    function onRelease() {
      aim.isDragging = false;
      if (!flow.is('aiming')) return;
      updateAim();
      if (aim.pull >= AIM.minPull) launch();
      else sfx.play('click', { pitch: 0.6 }); // too short a pull: cancelled, the shot is not spent
    }

    input.onDrag((event) => {
      if (ctx.paused || !play) return;
      if (event.phase === 'start') onPress();
      else if (event.phase === 'end' && aim.isDragging) onRelease();
    });

    function updateAiming() {
      if (!aim.isDragging && input.pointer.down && !ctx.paused) beginDrag(); // finger was already down when the ball reloaded
      const ballPosition = launchPoint.clone();
      if (aim.isDragging) {
        updateAim();
        const tremble = aim.pull > AIM_FEEL.trembleAbove ? AIM_FEEL.trembleSize : 0;
        ballPosition.addScaledVector(aim.direction, -aim.pull * AIM_FEEL.drawBack);
        ballPosition.x += rand(-tremble, tremble);
        ballPosition.y += rand(-tremble, tremble);
      } else ballPosition.y += Math.sin(ctx.time * AIM_FEEL.idleBob.rate) * AIM_FEEL.idleBob.height;
      launcher.hold(ballPosition);
      if (aim.isDragging && aim.pull >= AIM.minPull) preview.show(play.sim.predict(currentBall(), aim), ctx.time);
      else preview.hide();
    }

    const CELEBRATION = { burstXs: [-2.5, 0, 2.5], height: 3, bannerDelay: 0.5, failDelay: 0.15 };
    const flow = Kit.fsm({
      // A sheet is open (map, loadout, workshop): nothing to aim at.
      menu: {},
      aiming: {
        enter() {
          launcher.load(currentBall(), surfaces.forBall(currentBall()));
          sfx.play('click', { pitch: 1.4, vol: 0.6 });
        },
        update: updateAiming,
        exit() {
          aim.isDragging = false;
          launcher.hideBall();
          preview.hide();
        },
      },
      // The simulation decides when the shot is over; the next ball is ready at once, without waiting on rubble.
      flying: {
        update() {
          if (!play.sim.isShotLive()) flow.go(shotsLeft() > 0 ? 'aiming' : 'settling');
        },
      },
      // Last shot spent: give the rubble a moment to finish falling (a late gem can still clear the level).
      settling: {
        update(dt, secondsInState) {
          const hasSettled = play.sim.isCalm() && secondsInState > SETTLE.minSeconds;
          if (hasSettled || secondsInState > SETTLE.maxSeconds) flow.go('failed');
        },
      },
      cleared: {
        enter() {
          sfx.play('perfect');
          CELEBRATION.burstXs.forEach((x) => fx.burst({ x, y: platform.top + CELEBRATION.height, z: platform.z }, BURSTS.confetti));
          ctx.after(CELEBRATION.bannerDelay, showCleared);
        },
      },
      failed: { enter: () => ctx.after(CELEBRATION.failDelay, showFailed) },
    }, 'menu');

    // ------------------------------------------------- frame steps -------------------------------------------------

    /** Presentation only: target halos and markers, ball trails and the bomb's nervous pulse. */
    function animateEntities(time) {
      const pulse = Math.sin(time * TARGET_DECOR.pulseRate);
      surfaces.pulsing().forEach(({ surface, look }) => (surface.emissiveIntensity = look.glow + pulse * look.pulse));
      targetDecor.forEach((decor, block) => {
        const { position } = block.mesh;
        decor.glow.position.copy(position);
        decor.glow.scale.setScalar(TARGET_DECOR.glowSize + pulse * TARGET_DECOR.glowPulse);
        // Offsetting the bob by x keeps a row of markers from moving in lockstep.
        decor.marker.position.set(position.x, position.y + decor.markerHeight + Math.sin(time * TARGET_DECOR.markerBob.rate + position.x) * TARGET_DECOR.markerBob.height, position.z);
        decor.marker.rotation.y = time * TARGET_DECOR.markerSpin;
      });
      play.sim.state.balls.forEach((ball) => {
        if (ball.body.velocity.length() > FEEL.trailSpeed) fx.burst(ball.body.position, { ...BURSTS.trail, color: ball.ballType.trail, size: ball.radius * 0.4 });
        if (ball.ballType.blast) ball.mesh.scale.setScalar(ball.radius * (1 + Math.sin(time * BOMB_PULSE.rate) * BOMB_PULSE.size));
      });
    }

    // Wind made visible: thin streaks drift across the stage the way the wind pushes, faster when it is stronger.
    ctx.every(FEEL.windStreak.everySeconds, () => {
      const windX = play ? play.level.windX : 0;
      if (!windX) return;
      const start = { x: -Math.sign(windX) * rand(2, 6), y: rand(1, 7), z: rand(platform.z - 1, launchPoint.z) };
      fx.burst(start, { ...BURSTS.windStreak, speed: Math.abs(windX) * FEEL.windStreak.speedPerWind, dir: [Math.sign(windX), 0, 0] });
    });

    // Hook for scripted playtests (scratch/sling): a read-only snapshot, a jump to any level and direct access to progress.
    ctx.debug = {
      progress,
      snapshot: () => ({
        time: ctx.time, state: flow.state, level: play && play.level.key, shotsLeft: play ? shotsLeft() : 0, score: play ? play.sim.state.score : 0,
        chain: play ? play.sim.shot.chain : 0, bestChain: play ? play.sim.state.bestChain : 0, stars: progress.totalStars(), shards: progress.wallet.get('shards'),
        firstImpact: play && play.firstImpact,
        predictedEnd: play && aim.isDragging ? Object.values(play.sim.predict(currentBall(), aim).end) : null,
        balls: play ? play.sim.state.balls.map((ball) => ball.body.position.toArray()) : [],
        blocks: play ? play.sim.state.blocks.map((block) => ({ material: block.material.id, position: block.body.position.toArray() })) : [],
      }),
      play: (worldId, index, ballIds) => beginLevel(DATA.levelAt(worldId, index), ballIds || Array.from({ length: DATA.levelAt(worldId, index).shots }, () => BALLS[0].id)),
      showMap,
    };

    // A first-time player goes straight into the opening tower; a returning one starts at the map.
    if (progress.totalStars() === 0) beginLevel(DATA.levelAt(WORLDS[0].id, 0), Array.from({ length: DATA.levelAt(WORLDS[0].id, 0).shots }, () => BALLS[0].id));
    else showMap();

    const MIN_TIME_SCALE = 0.05; // guards the real-time conversion against a zero time scale
    return {
      debugState: () => ctx.debug.snapshot(),
      update(dt, time) {
        const realSeconds = dt / Math.max(ctx.timeScale, MIN_TIME_SCALE);
        if (play) {
          play.sim.step(dt);
          flow.update(dt);
          animateEntities(time);
        }
        const power = flow.is('aiming') && aim.isDragging ? aim.pull : 0;
        const balls = play ? play.sim.state.balls : [];
        launcher.update(power);
        cameraRig.update(realSeconds, { power, aimSide: aim.direction.x, leadBall: flow.is('flying') && balls.length ? balls[0].body.position : null });
      },
    };
  }

  Kit.register({
    id: 'sling', name: 'Tower Smash', tagline: 'Pull back, launch, topple', hook: 'Fill your loadout, find the weak point, start a chain', color: '#c084fc', order: 4,
    theme: THEME,
    headless: { progression: DATA.progression },
    create: createTowerSmash,
  });
})();
