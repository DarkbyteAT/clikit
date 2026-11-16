/**
 * Ferry Lines: draw boat routes between islands, then watch the plan carry itself out.
 *
 * Owns: the view - the archipelago in 3D, boats, route ribbons, current arrows, order tags and chart lettering - and the
 *       controls: drags become routes, taps select a route (scrap it, refit its boat), chips open the log and the charts.
 * Does not own: the rules, the data tables or the depth plan (games/ferry-sim.js, pure and tested), the look of the HUD
 *       (games/ferry-theme.js), stroke clean-up (Kit.route), view bookkeeping (Kit.crowd.views) or the HUD parts (ctx.ui).
 *
 * The three timescales of depth are written out at the top of games/ferry-sim.js. What this file adds to them is
 * legibility: every rule the simulation applies is something the player can see (arrows for currents, a boat waiting off
 * a busy dock, a smaller wake when it gives way, a legend under each island saying what it makes and needs).
 */
(() => {
  const SIM = window.FERRY_SIM;
  const { GOODS, BOAT_CLASSES, ORDER_KINDS, RULES } = SIM;

  /** Camera, layout and effect tunables. Lengths are world units unless they say px. */
  const VIEW = {
    tilt: 1.01, // radians above the horizon the camera looks down from (about 58 degrees: islands read as 3D, docks stay unhidden)
    cameraDistance: 40,
    // Portrait shows the map upright; landscape turns the camera a quarter turn so the long axis of the map runs across the screen.
    // screenDown is the world direction that points down the screen in that view (lettering hangs below its island).
    portrait: { yaw: 0, widthSpan: () => 10.4, focus: { x: 0, z: -0.1 }, screenDown: { x: 0, z: 1 } },
    landscape: { yaw: Math.PI / 2, widthSpan: (size) => 16 * size.aspect, focus: { x: 0.5, z: -0.4 }, screenDown: { x: 1, z: 0 } }, // 16 = world units of screen height that fit the map between the HUD rows
    waterSize: 70,
    waterRepeat: 12,
    waterDrift: 0.012, // texture offset per second
    waterGlints: 26, // glint strokes painted on one water tile
    routeHeight: 0.05, // ribbons float just above the water so they never z-fight it
    routeWidth: 0.2,
    selectedRouteWidth: 0.36,
    previewWidth: 0.26,
    stopMarkerRadius: 0.2,
    pierWidth: 0.42,
    crateSpacing: 0.27,
    boatTurnRate: 9, // how quickly a boat swings to a new heading (per second, exponential)
    queueGap: 0.75, // how far off the dock a boat waits for a busy berth
    wakeInterval: 0.11, // seconds between wake puffs
    bobHeight: 0.035,
    arrowsPerCurrent: 12,
    arrowSpeed: 1.3, // how fast current arrows drift, world units per second
    arrowHeight: 0.03,
    tagHeight: 1.7, // world height above an island centre where its order tags hang
    tagSpacingPx: 44,
    labelDropPx: 8,
    hintLoopSeconds: 1.8, // one pass of the ghost finger from dock to dock
    ghostTrailOpacity: 0.4,
    vignette: 0.16,
    focusVignette: 0.5, // the edges darken while time is slowed or stopped for drawing
    fogBob: 0.08,
    sampleSpacing: 0.15, // minimum finger travel between recorded stroke points
    tapRadius: 0.7, // a tap this close to a route selects it
    drawTimeScale: 0.15, // the harbour slows to this while a route is being drawn
  };

  /** Scene colours (sRGB hex). */
  const PALETTE = {
    water: '#2187b8', waterGlint: 'rgba(255, 255, 255, 0.17)', sand: 0xf2d9a0, grass: 0x6fbf5a, foam: 0xffffff, plank: 0xd2bd96, post: 0x6b4a2c,
    hull: 0xfbf4e4, sail: 0xfffaf0, pennant: 0xffc93c, pine: 0x2f7d4f, trunk: 0x7a5230, leaf: 0x4fae4a, wall: 0xfbefd5, roof: 0xd9523f, pan: 0xeef3f8, rock: 0x4b4f66,
    crystal: 0x9b7bff, shed: 0x9b6a4a, shedRoof: 0x5b6470, fog: 0xe9f0f4, preview: 0xffffff, refused: 0xff5a4f, stop: 0xfff6e0, ghost: 0xffffff, arrow: 0xdff4ff,
  };

  /** One colour per simultaneous route (ribbon and boat trim); SIM.MAX_FLEET rows are needed. */
  const ROUTE_COLORS = [0xe8473f, 0xf2b632, 0x2fae7b, 0xb86bd6, 0xf07f3c];

  /** Why a stroke was refused -> what the player is told (null = say nothing, it was not a real attempt). */
  const REFUSALS = { 'too-short': null, 'no-start': null, 'no-end': 'End on a dock', blocked: 'Keep to open water', fleet: 'No spare boat' };

  /** Patience ring colour by share of patience left, first matching row wins. */
  const PATIENCE_RING = [{ from: 0.55, color: '#3fae6b' }, { from: 0.28, color: '#f2b632' }, { from: 0, color: '#c8372d' }];

  /** Crate geometry per GoodRow.shape, each about 0.25 across so four fit on a pier. */
  const GOOD_SHAPES = {
    log: (THREE) => new THREE.CylinderGeometry(0.085, 0.085, 0.26, 8).rotateX(Math.PI / 2),
    ball: (THREE) => new THREE.IcosahedronGeometry(0.125, 1),
    cone: (THREE) => new THREE.ConeGeometry(0.13, 0.25, 6),
    gem: (THREE) => new THREE.OctahedronGeometry(0.14),
    slab: (THREE) => new THREE.BoxGeometry(0.2, 0.09, 0.26),
    bar: (THREE) => new THREE.CylinderGeometry(0.07, 0.11, 0.26, 4).rotateX(Math.PI / 2),
  };

  /**
   * How each boat class is drawn: the hull stretched along its length and beam, and whether it carries a sail.
   * A class should be recognisable from its silhouette before its speed gives it away.
   */
  const BOAT_LOOKS = {
    packet: { length: 1, beam: 1, hasSail: false },
    cutter: { length: 1.05, beam: 0.68, hasSail: true },
    barge: { length: 1.3, beam: 1.3, hasSail: false },
  };

  /** Where landmark pieces stand on an island, as fractions of its radius from the centre. */
  const SCATTER = [[-0.05, -0.28], [-0.38, 0.1], [0.32, 0.02], [0.02, 0.34]];

  /** What stands on an island, by IslandRow.landmark: (make, parent, spots, THREE) => void, spots are [x, z] in world units. */
  const LANDMARKS = {
    pines: (make, parent, spots) =>
      spots.forEach(([x, z], index) => {
        make.cyl(0.05, 0.06, 0.2, PALETTE.trunk, { parent, at: [x, 0.68, z], seg: 5 });
        make.cone(0.26 - index * 0.02, 0.75, PALETTE.pine, { parent, at: [x, 1.1, z], seg: 6, flat: true });
      }),
    grove: (make, parent, spots) =>
      spots.slice(0, 3).forEach(([x, z]) => {
        make.cyl(0.04, 0.05, 0.25, PALETTE.trunk, { parent, at: [x, 0.7, z], seg: 5 });
        make.ico(0.3, 0, PALETTE.leaf, { parent, at: [x, 1.0, z] });
        make.ico(0.09, 0, GOODS.byId('citrus').color, { parent, at: [x + 0.2, 1.05, z + 0.16] });
      }),
    town: (make, parent, spots) =>
      spots.slice(0, 3).forEach(([x, z], index) => {
        const height = 0.34 + index * 0.12;
        make.box(0.38, height, 0.38, PALETTE.wall, { parent, at: [x, 0.58 + height / 2, z] });
        make.cone(0.36, 0.26, PALETTE.roof, { parent, at: [x, 0.71 + height, z], seg: 4, flat: true }).rotation.y = Math.PI / 4;
      }),
    pans: (make, parent, spots) =>
      spots.forEach(([x, z], index) => {
        make.prism(6, 0.3, 0.04, PALETTE.pan, { parent, at: [x, 0.6, z] });
        if (index % 2 === 0) make.cone(0.16, 0.26, PALETTE.pan, { parent, at: [x, 0.74, z], seg: 6, flat: true });
      }),
    crag: (make, parent, spots, THREE) =>
      spots.forEach(([x, z], index) => {
        make.ico(0.34 - index * 0.04, 0, PALETTE.rock, { parent, at: [x, 0.74, z] });
        if (index % 2 === 1) make.mesh(GOOD_SHAPES.gem(THREE), make.mat(PALETTE.crystal, { flat: true, emissive: PALETTE.crystal, emissiveIntensity: 0.35 }), { parent, at: [x + 0.1, 1.08, z] });
      }),
    // A works: one long shed with a saw-tooth roof and a chimney, so mills and foundries read as "something is made here".
    mill: (make, parent, spots) => {
      const [x, z] = spots[0];
      make.box(0.95, 0.42, 0.6, PALETTE.shed, { parent, at: [x, 0.8, z + 0.25] });
      [-0.3, 0, 0.3].forEach((offset) => (make.prism(3, 0.22, 0.6, PALETTE.shedRoof, { parent, at: [x + offset, 1.08, z + 0.25] }).rotation.x = Math.PI / 2));
      make.cyl(0.07, 0.09, 0.7, PALETTE.rock, { parent, at: [x + 0.36, 1.2, z + 0.1], seg: 6 });
    },
  };

  const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
  const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
  const cssColor = (hex) => '#' + hex.toString(16).padStart(6, '0');

  /** Paint one tile of stylised water: a flat tone with short curved glints. */
  const paintWater = (context, width, height) => {
    context.fillStyle = PALETTE.water;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = PALETTE.waterGlint;
    context.lineWidth = 3;
    context.lineCap = 'round';
    Array.from({ length: VIEW.waterGlints }, () => ({ x: Math.random() * width, y: Math.random() * height, reach: 14 + Math.random() * 22 })).forEach(({ x, y, reach }) => {
      context.beginPath();
      context.moveTo(x, y);
      context.quadraticCurveTo(x + reach / 2, y - 5, x + reach, y);
      context.stroke();
    });
  };

  /**
   * A flat strip mesh geometry following a polyline on the water.
   * @param {Object} THREE
   * @param {{x: number, y: number}[]} points
   * @param {number} width  world units
   * @complexity O(points) time and vertices
   */
  const buildRibbonGeometry = (THREE, points, width) => {
    const edges = Kit.route.ribbon(points, width);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(edges.flatMap(({ left, right }) => [left.x, VIEW.routeHeight, left.y, right.x, VIEW.routeHeight, right.y]), 3));
    // Two triangles per segment between consecutive left / right pairs.
    geometry.setIndex(edges.slice(0, -1).flatMap((_, index) => [index * 2, index * 2 + 1, index * 2 + 2, index * 2 + 1, index * 2 + 3, index * 2 + 2]));
    return geometry;
  };

  function create(ctx) {
    const { THREE, make, input, fx, sfx, ui, math } = ctx;

    // ---- the long arc: permanent record, and which chart this watch is on -----------------------------------------------
    const profile = SIM.createProfile({ save: ctx.save, onUnlock: (id) => ui.toast('Unlocked: ' + SIM.UNLOCK_NAMES[id], 2200) });
    const charts = SIM.availableCharts(profile.isUnlocked);
    const chart = charts.find((candidate) => candidate.id === ctx.save.get('chart')) || charts[0];
    const { stats, wallet, shipyard } = SIM.createYard(chart.id, profile.isUnlocked);
    const orderKinds = Kit.spawnTable(ORDER_KINDS);

    // ---- camera and stage ---------------------------------------------------------------------------------------------
    const viewFor = (size) => (size.portrait ? VIEW.portrait : VIEW.landscape);
    const camera = ctx.ortho((size) => viewFor(size).widthSpan(size), 'width');
    const placeCamera = (size) => {
      const { yaw, focus } = viewFor(size);
      const reach = Math.cos(VIEW.tilt) * VIEW.cameraDistance;
      camera.position.set(focus.x + Math.sin(yaw) * reach, Math.sin(VIEW.tilt) * VIEW.cameraDistance, focus.z + Math.cos(yaw) * reach);
      camera.lookAt(focus.x, 0, focus.z);
      camera.updateMatrixWorld(true); // screen projections below are read before the next render
    };
    placeCamera(ctx.size);
    make.stage({ sky: [0x2187b8, 0x2187b8], ambient: 0.95, sun: [7, 13, 5], sunIntensity: 1.15, shadow: 13 });
    ctx.post.bloom(0); // a sunlit chart, nothing glows

    const projected = new THREE.Vector3();
    /** Screen pixel position of a world point. */
    const toScreen = (x, height, z) => {
      projected.set(x, height, z).project(camera);
      return { x: (projected.x * 0.5 + 0.5) * ctx.size.w, y: (-projected.y * 0.5 + 0.5) * ctx.size.h };
    };

    // ---- water and currents ---------------------------------------------------------------------------------------------
    const waterTexture = make.canvasTexture(256, 256, paintWater, { repeat: [VIEW.waterRepeat, VIEW.waterRepeat] });
    const waterMaterial = make.mat(0xffffff, { rough: 0.5, fresh: true });
    waterMaterial.map = waterTexture;
    const water = make.mesh(new THREE.PlaneGeometry(VIEW.waterSize, VIEW.waterSize), waterMaterial, { shadow: false });
    water.rotation.x = -Math.PI / 2;
    water.receiveShadow = true;

    // Each current is one instanced batch of flat arrowheads that drift the way the water runs (one draw call per current).
    const arrowGeometry = new THREE.ConeGeometry(0.16, 0.42, 3).rotateX(Math.PI / 2).scale(1, 0.05, 1);
    const arrowMaterial = make.unlit(PALETTE.arrow, { opacity: 0.5 });
    const currentViews = chart.currents.map((current) => ({ current, arrows: make.instanced(arrowGeometry, arrowMaterial, VIEW.arrowsPerCurrent) }));
    const drawCurrent = ({ current, arrows }, time) => {
      const sign = SIM.tideSign(current, time), span = current.halfLength * 2;
      Array.from({ length: VIEW.arrowsPerCurrent }, (_, index) => index).forEach((index) => {
        // Arrows sit in two columns and wrap along the current's length; the modulo keeps them inside its rectangle.
        const travelled = (((index / VIEW.arrowsPerCurrent) * span + time * VIEW.arrowSpeed * sign) % span + span) % span;
        const across = (index % 2 ? 0.45 : -0.45) * current.halfWidth;
        arrows.place(index, current.x + current.flowX * (travelled - current.halfLength) + current.flowZ * across, VIEW.arrowHeight,
          current.z + current.flowZ * (travelled - current.halfLength) + current.flowX * across, 1, Math.atan2(current.flowX * sign, current.flowZ * sign));
      });
      arrows.commit();
    };

    // ---- crates (shared geometry and material per good) -----------------------------------------------------------------
    const crateParts = Object.fromEntries(GOODS.map((good) => [good.id, { geometry: GOOD_SHAPES[good.shape](THREE), material: make.mat(good.color, { flat: true, rough: 0.5 }) }]));
    /** Crate geometries are shared by every crate mesh, so tearing down a boat must not dispose them. */
    const sharedGeometries = new Set(Object.values(crateParts).map((part) => part.geometry));
    const buildCrate = (parent, at, goodId = GOODS[0].id) => make.mesh(crateParts[goodId].geometry, crateParts[goodId].material, { parent, at });
    const showCrate = (crate, goodId) => {
      crate.visible = Boolean(goodId);
      if (goodId) Object.assign(crate, crateParts[goodId]);
    };

    // ---- islands --------------------------------------------------------------------------------------------------------
    const foamMaterial = make.unlit(PALETTE.foam, { opacity: 0.4 });
    const fogMaterial = make.mat(PALETTE.fog, { opacity: 0.9, flat: true });

    /** @returns {{ group, fog, crates, foam }} the meshes of one island; hidden under fog until revealed */
    const buildIsland = (island) => {
      const group = make.group({ at: [island.x, 0, island.z] });
      make.cyl(island.radius * 0.94, island.radius * 1.04, 0.42, PALETTE.sand, { parent: group, at: [0, 0.2, 0], seg: 9, flat: true });
      make.cyl(island.radius * 0.66, island.radius * 0.8, 0.28, PALETTE.grass, { parent: group, at: [0, 0.48, 0], seg: 8, flat: true }).rotation.y = island.x;
      const foam = make.cyl(island.radius * 1.17, island.radius * 1.17, 0.02, foamMaterial, { parent: group, at: [0, 0.02, 0], seg: 9, shadow: false });
      LANDMARKS[island.landmark](make, group, SCATTER.map(([x, z]) => [x * island.radius, z * island.radius]), THREE);
      // The pier's local +x points out to sea, so its parts are laid out along one axis.
      const pier = make.group({ parent: group });
      pier.rotation.y = -island.dockAngle;
      const pierLength = RULES.dockReach - 0.25, pierStart = island.radius * 0.9;
      make.box(pierLength, 0.1, VIEW.pierWidth, PALETTE.plank, { parent: pier, at: [pierStart + pierLength / 2, 0.2, 0] });
      [-1, 1].forEach((side) => make.cyl(0.05, 0.05, 0.4, PALETTE.post, { parent: pier, at: [pierStart + pierLength, 0.15, (side * VIEW.pierWidth) / 2], seg: 6 }));
      const crates = Array.from({ length: RULES.stockCap }, (_, index) => buildCrate(pier, [pierStart + 0.2 + index * VIEW.crateSpacing, 0.38, 0], island.produces));
      const fog = make.group({ at: [island.x, 0.7, island.z] });
      SCATTER.concat([[0, 0]]).forEach(([x, z], index) => make.ico(island.radius * (0.62 - index * 0.05), 1, fogMaterial, { parent: fog, at: [x * island.radius * 1.6, index * 0.12, z * island.radius * 1.6], shadow: false }));
      return { group, fog, crates, foam };
    };
    const islandViews = Object.fromEntries(chart.islands.map((island) => [island.id, buildIsland(island)]));

    // ---- HUD ------------------------------------------------------------------------------------------------------------
    const coinStat = ui.stat('Takings', 0);
    const buoyStat = ui.pips('Buoys', { total: chart.hearts });
    ui.shop(shipyard, { wallet });
    const hint = ui.hint('Drag from dock to dock to launch a ferry');
    const chartLayer = ui.el('div', 'ferry-chart');

    /** A good drawn as its order-tag icon. */
    const goodIcon = (goodId) => {
      const icon = ui.h('i', GOODS.byId(goodId).shape);
      icon.style.setProperty('--good', cssColor(GOODS.byId(goodId).color));
      return icon;
    };
    /** Island lettering: its name and, for a maker, a legend of what it is fed and what it makes. */
    const buildLabel = (island) => {
      const label = chartLayer.appendChild(ui.h('div', 'ferry-label', island.name));
      if (!island.produces) return label;
      const tag = label.appendChild(ui.h('div', 'ferry-legend')).appendChild(ui.h('div', 'ferry-order')).appendChild(ui.h('div'));
      tag.append(...(island.needs ? [goodIcon(island.needs), '›'] : []), goodIcon(island.produces));
      return label;
    };
    const labels = Object.fromEntries(chart.islands.map((island) => [island.id, buildLabel(island)]));

    const tools = ui.el('div', 'ferry-tools');
    const addTool = (text, onPress) => {
      const chip = tools.appendChild(ui.h('button', 'chip', text));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        sfx.play('click');
        onPress();
      });
      return chip;
    };

    // ---- watch state: the simulation's world plus what only the view knows ---------------------------------------------
    let world = SIM.createWorld(chart.id);
    let stroke = null; // { points } while a route is being drawn
    let selectedRouteId = null;
    let isPaused = false;
    let isOver = false;
    const tally = { deliveries: 0, earned: 0 };

    const stepContext = (dt) => SIM.contextOf(stats, { dt, random: Math.random, pickKind: (time) => orderKinds.pick(time) });
    const isRevealed = (island) => world.docks[island.id].isRevealed;
    const dockPoint = (islandId) => chart.docks.byId(islandId);
    const dockWorld = (islandId) => ({ x: dockPoint(islandId).x, y: 0.3, z: dockPoint(islandId).y });
    const routeById = (routeId) => world.routes.find((route) => route.id === routeId);
    const boatOnRoute = (routeId) => world.boats.find((boat) => boat.routeId === routeId);

    // ---- chips: scrap or refit the selected route, pause, the log, the charts -------------------------------------------
    const scrapChip = addTool('Scrap route', () => {
      world = SIM.removeRoute(world, selectedRouteId);
      selectedRouteId = null;
      sfx.play('thud');
    });
    scrapChip.classList.add('hot');
    /** The class the selected route's boat would become, or null when there is nothing to choose. */
    const refitTarget = () => {
      const boat = selectedRouteId !== null && boatOnRoute(selectedRouteId);
      const target = boat && SIM.nextClass(boat.classId, profile.isUnlocked);
      return target && target.id !== boat.classId ? target : null;
    };
    const refitChip = addTool('Refit', () => {
      const target = refitTarget();
      if (!target || !wallet.spend(target.refitCost)) return sfx.play('thud');
      world = SIM.refitBoat(world, selectedRouteId, target.id);
      coinStat.set(wallet.get());
      ui.toast(target.name);
      sfx.play('up');
    });
    const pauseChip = addTool('Pause', () => {
      isPaused = !isPaused;
      pauseChip.textContent = isPaused ? 'Sail on' : 'Pause';
    });
    addTool('Log', () =>
      ui.panel({
        title: 'Harbour log',
        closeLabel: 'Back to the watch',
        build(body) {
          body.append(ui.h('div', 'ferry-log-rank', `${SIM.rankOf(profile.level)} · ${ctx.fmt(profile.stat('takings'))} taken · ${profile.runCount} watches`));
          body.append(ui.h('div', 'ferry-log-head', 'Commissions'));
          profile.achievements().forEach(({ row, progress, done }) => {
            const entry = body.appendChild(ui.h('div', 'ferry-log-row' + (done ? ' done' : '')));
            entry.append(ui.h('span', null, row.text), ...(row.unlocks ? [ui.h('em', null, SIM.UNLOCK_NAMES[row.unlocks])] : []), ui.h('b', null, `${ctx.fmt(progress)}/${ctx.fmt(row.target)}`));
          });
          body.append(ui.h('div', 'ferry-log-head', 'Boat classes'));
          SIM.availableClasses(profile.isUnlocked).forEach((boatClass) => body.appendChild(ui.h('div', 'ferry-log-row')).append(ui.h('span', null, `${boatClass.name}: ${boatClass.blurb}`)));
        },
      })
    );
    if (charts.length > 1) {
      addTool('Charts', () =>
        ui.choose({
          title: 'Choose a chart',
          sub: 'Changing chart starts a new watch.',
          options: charts.map((candidate) => ({ title: candidate.name, desc: candidate.blurb, tag: 'best ' + profile.stat('best:' + candidate.id) })),
        }).then((index) => {
          ctx.save.set('chart', charts[index].id);
          ctx.restart();
        })
      );
    }

    /** Place the chart lettering; island positions on screen only change with the viewport. */
    const layoutLabels = () =>
      chart.islands.forEach((island) => {
        const { screenDown } = viewFor(ctx.size);
        const below = toScreen(island.x + screenDown.x * island.radius, 0, island.z + screenDown.z * island.radius);
        Object.assign(labels[island.id].style, { left: below.x + 'px', top: below.y + VIEW.labelDropPx + 'px' });
      });
    layoutLabels();
    ctx.on('resize', (size) => {
      placeCamera(size);
      layoutLabels();
    });

    const payOut = (coins, islandId) => {
      wallet.add(coins);
      tally.earned += coins;
      coinStat.set(wallet.get());
      fx.floater('+' + coins, dockWorld(islandId));
    };

    /** Bring an island out of the fog (instantly for the ones the watch starts with). */
    const showIsland = (island, isAnimated) => {
      const view = islandViews[island.id];
      view.group.visible = true;
      labels[island.id].hidden = false;
      if (!isAnimated) return void (view.fog.visible = false);
      view.group.scale.setScalar(0.01);
      ctx.tween(view.group.scale, { x: 1, y: 1, z: 1 }, 0.6, 'outBack');
      ctx.tween(view.fog.scale, { x: 0.01, y: 0.01, z: 0.01 }, 0.5).then(() => (view.fog.visible = false));
      fx.burst({ x: island.x, y: 0.8, z: island.z }, { count: 16, color: PALETTE.fog, speed: 3, life: 0.7, size: 0.2, gravity: 2 });
      ui.toast(island.name + ' charted');
      sfx.play('whoosh');
    };
    chart.islands.forEach((island) => {
      islandViews[island.id].group.visible = false;
      labels[island.id].hidden = true;
      if (isRevealed(island)) showIsland(island, false);
    });

    /** What the view does about each simulation event, by event type. */
    const EVENT_HANDLERS = {
      revealed: ({ islandId }) => showIsland(chart.islands.byId(islandId), true),
      ordered: () => sfx.play('tap', { pitch: 1.25, vol: 0.5 }),
      loaded: ({ islandId }) => fx.ring(dockWorld(islandId), { color: PALETTE.stop, size: 0.8, life: 0.3 }),
      sold: ({ islandId, coins }) => payOut(coins, islandId),
      tide: () => {
        ui.toast('The tide turns');
        sfx.play('whoosh', { pitch: 0.7 });
      },
      delivered: ({ order, coins }) => {
        tally.deliveries += 1;
        payOut(coins, order.islandId);
        coinStat.pulse();
        fx.burst(dockWorld(order.islandId), { count: order.goods.length * 9, colors: order.goods.map((goodId) => GOODS.byId(goodId).color), speed: 3, life: 0.6 });
        sfx.play(order.goods.length > 1 ? 'win' : 'coin');
      },
      expired: ({ order }) => {
        const island = chart.islands.byId(order.islandId);
        fx.ring({ x: island.x, y: 0.6, z: island.z }, { color: PALETTE.refused, size: island.radius * 1.6, life: 0.5 });
        // A rush that lapses is a missed chance, not a failure: no shake, no flash, no lifebuoy.
        if (!ORDER_KINDS.byId(order.kindId).costsHeart) return sfx.play('thud', { vol: 0.5 });
        fx.shake(0.35);
        fx.flash('#c8372d', 260, 0.28);
        sfx.play('lose');
        buoyStat.pulse();
      },
    };
    const handleEvents = (events) => {
      SIM.recordEvents(profile, chart.id, events);
      events.forEach((event) => EVENT_HANDLERS[event.type](event));
    };

    shipyard.on(({ row }) => {
      const uncharted = row.reveals && SIM.nextUnchartedIsland(world);
      if (!uncharted) return;
      world = SIM.revealIsland(world, uncharted.id);
      handleEvents([{ type: 'revealed', islandId: uncharted.id }]);
    });

    // ---- drawing routes -------------------------------------------------------------------------------------------------
    const previewMaterial = make.unlit(PALETTE.preview, { opacity: 0.85, fresh: true });
    previewMaterial.side = THREE.DoubleSide;
    const preview = make.mesh(new THREE.BufferGeometry(), previewMaterial, { shadow: false });
    const showPreview = (points) => {
      preview.geometry.dispose();
      preview.geometry = points.length > 1 ? buildRibbonGeometry(THREE, points, VIEW.previewWidth) : new THREE.BufferGeometry();
    };

    /** The finger's position on the water, as a simulation point (or null off the plane). */
    const fingerPoint = () => {
      const hit = input.ground(0);
      return hit ? { x: hit.x, y: hit.z } : null;
    };
    /** The dock a finger means: the dock of the island it is on, else the nearest dock within the snap radius. */
    const dockUnder = (point) => {
      const revealed = chart.islands.filter(isRevealed);
      const ashore = revealed.find((island) => distance(point, { x: island.x, y: island.z }) < island.radius + RULES.shoreMargin);
      return ashore ? dockPoint(ashore.id) : Kit.route.snap(point, revealed.map((island) => dockPoint(island.id)), RULES.snapRadius);
    };
    const refuse = (reason) => {
      if (!REFUSALS[reason]) return;
      ui.toast(REFUSALS[reason]);
      sfx.play('thud');
    };
    const launch = (captured) => {
      const launched = SIM.addRoute(world, captured, stepContext(0));
      world = launched.world;
      handleEvents(launched.events);
      hint.hide();
      sfx.play('whoosh');
      captured.stops.forEach((stop) => fx.ring(dockWorld(stop.id), { color: ROUTE_COLORS[world.routes[world.routes.length - 1].colorIndex], size: 1.1 }));
    };

    /** What each phase of a drag does while drawing. */
    const DRAG_PHASES = {
      start() {
        const point = fingerPoint();
        const dock = point && !isOver && dockUnder(point);
        if (!dock) return;
        if (!SIM.canLaunch(world, stats.get('fleet'))) return refuse('fleet');
        stroke = { points: [{ x: dock.x, y: dock.y }] };
        fx.ring(dockWorld(dock.id), { color: PALETTE.preview, size: 1 });
        sfx.play('tap');
      },
      move() {
        const point = stroke && fingerPoint();
        // Points on land are skipped, so a finger may rest on the destination island without spoiling the stroke.
        if (!point || SIM.isLand(chart, point) || distance(stroke.points[stroke.points.length - 1], point) < VIEW.sampleSpacing) return;
        stroke.points.push(point);
        showPreview(stroke.points);
      },
      end() {
        if (!stroke) return;
        const point = fingerPoint();
        const dock = point && dockUnder(point);
        const drawn = dock ? stroke.points.concat({ x: dock.x, y: dock.y }) : stroke.points;
        stroke = null;
        showPreview([]);
        const captured = Kit.route.capture(drawn, SIM.captureOptions(world));
        if (captured.ok) launch(captured);
        else refuse(captured.reason);
      },
    };
    input.onDrag(({ phase }) => DRAG_PHASES[phase]());

    input.onTap(() => {
      const point = fingerPoint();
      const tapped = point && world.routes.find((route) => Kit.line.nearest(route.points, point).d < VIEW.tapRadius);
      selectedRouteId = tapped && tapped.id !== selectedRouteId ? tapped.id : null;
      if (tapped) sfx.play('tap');
    });

    // ---- route and boat views -----------------------------------------------------------------------------------------
    const routeMaterial = (colorIndex) => {
      const material = make.unlit(ROUTE_COLORS[colorIndex], { opacity: 0.9 });
      material.side = THREE.DoubleSide; // the strip's winding depends on the stroke's direction
      return material;
    };
    const stopMaterial = make.unlit(PALETTE.stop);
    const buildRouteView = (route, isSelected) => {
      const group = make.group();
      make.mesh(buildRibbonGeometry(THREE, route.points, isSelected ? VIEW.selectedRouteWidth : VIEW.routeWidth), routeMaterial(route.colorIndex), { parent: group, shadow: false });
      route.stops.forEach((stop) => {
        const at = Kit.line.at(route.points, stop.along);
        make.cyl(VIEW.stopMarkerRadius, VIEW.stopMarkerRadius, 0.02, stopMaterial, { parent: group, at: [at.x, VIEW.routeHeight + 0.02, at.y], seg: 12, shadow: false });
      });
      return group;
    };
    const destroyGroup = (group) => {
      group.traverse((part) => part.geometry && !sharedGeometries.has(part.geometry) && part.geometry.dispose());
      ctx.scene.remove(group);
    };
    // Route views are keyed by id plus selection, so selecting a route rebuilds just that ribbon at its wider width.
    const syncRouteViews = Kit.crowd.views(({ route, isSelected }) => buildRouteView(route, isSelected), destroyGroup);
    const routeViewEntities = () => world.routes.map((route) => ({ id: route.id + (route.id === selectedRouteId ? ':selected' : ''), route, isSelected: route.id === selectedRouteId }));

    const maxCapacity = Math.max(...BOAT_CLASSES.map((boatClass) => boatClass.hold)) + shipyard.table.byId('hold').max;
    /** @returns {{ group, crates, heading, wakeClock }} a ferry of its class, trimmed in its route's colour, bow along local +x */
    const buildBoatView = ({ boat }) => {
      const trim = ROUTE_COLORS[routeById(boat.routeId).colorIndex], look = BOAT_LOOKS[boat.classId];
      const group = make.group();
      const hull = make.group({ parent: group });
      hull.scale.set(look.length, 1, look.beam);
      make.box(0.92, 0.2, 0.5, PALETTE.hull, { parent: hull, at: [-0.05, 0.1, 0] });
      make.prism(3, 0.29, 0.2, PALETTE.hull, { parent: hull, at: [0.55, 0.1, 0] }).rotation.y = Math.PI / 2;
      make.box(0.94, 0.05, 0.52, trim, { parent: hull, at: [-0.05, 0.2, 0] });
      make.box(0.2, 0.26, 0.34, trim, { parent: hull, at: [-0.4, 0.34, 0] });
      make.box(0.24, 0.05, 0.38, PALETTE.hull, { parent: hull, at: [-0.4, 0.49, 0] });
      if (look.hasSail) make.prism(3, 0.34, 0.03, PALETTE.sail, { parent: group, at: [0.12, 0.72, 0] }).rotation.set(Math.PI / 2, 0, Math.PI / 2);
      if (profile.isUnlocked('pennant')) make.box(0.2, 0.1, 0.02, PALETTE.pennant, { parent: group, at: [-0.5, 0.72, 0] });
      const crates = Array.from({ length: maxCapacity }, (_, index) => buildCrate(group, [(-0.12 + Math.floor(index / 2) * 0.25) * look.length, 0.34, (index % 2 ? 0.12 : -0.12) * look.beam]));
      return { group, crates, heading: null, wakeClock: Kit.timer.start(VIEW.wakeInterval) };
    };
    // Boat views are keyed by id plus class, so a refit rebuilds the model.
    const syncBoatViews = Kit.crowd.views(buildBoatView, (view) => destroyGroup(view.group));
    const drawBoat = (view, { boat }, dt, time) => {
      const pose = SIM.poseOf(boat, routeById(boat.routeId));
      // A boat waiting for a busy berth holds off the dock, astern of where it would moor.
      const holdOff = boat.queuedAt ? VIEW.queueGap : 0;
      const targetHeading = -Math.atan2(pose.ty, pose.tx);
      // Swing to the new heading by the shorter way round, so a boat turning back at a dock pivots instead of flipping.
      view.heading = view.heading === null ? targetHeading : view.heading + math.damp(0, wrapAngle(targetHeading - view.heading), VIEW.boatTurnRate, dt);
      view.group.position.set(pose.x - pose.tx * holdOff, Math.sin(time * 3 + boat.id) * VIEW.bobHeight, pose.y - pose.ty * holdOff);
      view.group.rotation.set(Math.sin(time * 2.3 + boat.id) * 0.05, view.heading, 0);
      view.crates.forEach((crate, index) => showCrate(crate, boat.cargo[index]));
      if (boat.dwell > 0 || boat.queuedAt) return;
      const wake = Kit.timer.cycle(view.wakeClock, dt);
      view.wakeClock = wake.timer;
      if (wake.fired) fx.burst({ x: pose.x - pose.tx * 0.5, y: 0.06, z: pose.y - pose.ty * 0.5 }, { count: boat.isYielding ? 1 : 2, flat: true, speed: 0.5, life: 0.8, size: 0.1, color: PALETTE.foam });
    };

    // ---- order tags -----------------------------------------------------------------------------------------------------
    const buildOrderTag = (order) => {
      const tag = chartLayer.appendChild(ui.h('div', 'ferry-order ' + order.kindId));
      tag.appendChild(ui.h('div')).append(...order.goods.map(goodIcon));
      return tag;
    };
    const syncOrderTags = Kit.crowd.views(buildOrderTag, (tag) => tag.remove());
    const drawOrderTag = (tag, order) => {
      const island = chart.islands.byId(order.islandId);
      const queue = world.orders.filter((other) => other.islandId === order.islandId);
      const anchor = toScreen(island.x, VIEW.tagHeight, island.z);
      const share = Kit.timer.fraction(order.timer);
      tag.style.left = anchor.x + (queue.findIndex((other) => other.id === order.id) - (queue.length - 1) / 2) * VIEW.tagSpacingPx + 'px';
      tag.style.top = anchor.y + 'px';
      tag.style.setProperty('--left', Math.ceil(share * 100));
      tag.style.setProperty('--ring', ORDER_KINDS.byId(order.kindId).costsHeart ? PATIENCE_RING.find((row) => share >= row.from).color : PATIENCE_RING[PATIENCE_RING.length - 1].color);
      [...tag.firstChild.querySelectorAll('i')].forEach((icon, index) => icon.classList.toggle('done', !order.needs.includes(order.goods[index])));
    };

    // ---- first-play hint: a ghost finger traces the chart's opening line -------------------------------------------------
    const firstOrigin = dockPoint(chart.islands[0].id), firstTarget = dockPoint(chart.islands[1].id);
    const ghost = make.glow(PALETTE.ghost, 1.1, { depthTest: false });
    const ghostTrail = make.mesh(buildRibbonGeometry(THREE, [firstOrigin, firstTarget], VIEW.routeWidth), make.unlit(PALETTE.ghost, { opacity: VIEW.ghostTrailOpacity }), { shadow: false });
    const drawGhost = (time) => {
      // Travel for the first 70% of each loop, then rest on the target so the gesture reads as "drag, release".
      const progress = math.clamp(((time % VIEW.hintLoopSeconds) / VIEW.hintLoopSeconds) / 0.7);
      ghost.visible = ghostTrail.visible = world.routes.length === 0 && tally.deliveries === 0 && !stroke;
      ghost.position.set(math.lerp(firstOrigin.x, firstTarget.x, progress), 0.6, math.lerp(firstOrigin.y, firstTarget.y, progress));
    };

    const endWatch = () => {
      isOver = true;
      const { best } = SIM.finishWatch(profile, { chartId: chart.id, deliveries: tally.deliveries, earned: tally.earned, time: world.time });
      ui.banner({
        title: 'Harbour closed',
        text: `${chart.name}: too many towns went without. The log for this watch:`,
        stats: [['Deliveries', tally.deliveries], ['Takings', tally.earned], ['Watch', ctx.fmtTime(world.time)], ['Best here', best], ['Rank', SIM.rankOf(profile.level)]],
        button: 'New watch',
      }).then(() => ctx.restart());
    };

    /** State and screen positions for scripted playtests. */
    ctx.debug = {
      world: () => world,
      tally: () => ({ ...tally }),
      profile,
      wallet,
      dockScreen: (islandId) => toScreen(dockPoint(islandId).x, 0, dockPoint(islandId).y),
      waterScreen: (x, y) => toScreen(x, 0, y),
    };

    return {
      update(dt, time) {
        // Harbour time: stopped by the Pause chip, slowed while a route is being drawn, so planning is never a reflex test.
        const rate = isPaused ? 0 : stroke ? VIEW.drawTimeScale : 1;
        ctx.post.vignette(rate < 1 ? VIEW.focusVignette : VIEW.vignette);
        if (!isOver && rate > 0) {
          const stepped = SIM.step(world, stepContext(dt * rate));
          world = stepped.world;
          handleEvents(stepped.events);
          if (world.hearts <= 0) endWatch();
        }
        if (selectedRouteId !== null && !routeById(selectedRouteId)) selectedRouteId = null;
        const target = refitTarget();
        scrapChip.hidden = selectedRouteId === null;
        refitChip.hidden = !target;
        if (target) refitChip.textContent = `Refit: ${target.name} ${target.refitCost}`;
        buoyStat.set(world.hearts);

        syncRouteViews(routeViewEntities(), () => {});
        syncBoatViews(world.boats.map((boat) => ({ id: boat.id + ':' + boat.classId, boat })), (view, entity) => drawBoat(view, entity, dt * rate, time));
        syncOrderTags(world.orders, drawOrderTag);
        currentViews.forEach((view) => drawCurrent(view, world.time));

        chart.islands.forEach((island, index) => {
          const view = islandViews[island.id];
          view.crates.forEach((crate, slot) => showCrate(crate, slot < world.docks[island.id].stock ? island.produces : null));
          view.foam.scale.setScalar(1 + Math.sin(time * 1.4 + index) * 0.035);
          view.fog.position.y = 0.7 + Math.sin(time * 0.9 + index * 2) * VIEW.fogBob;
        });
        waterTexture.offset.set(time * VIEW.waterDrift, time * VIEW.waterDrift * 0.6);
        drawGhost(time);
      },
    };
  }

  Kit.register({
    id: 'ferry',
    name: 'Ferry Lines',
    tagline: 'Draw routes, then watch the plan sail',
    hook: 'Three charts, three boat classes, tides and mills',
    color: '#38bdf8',
    order: 9,
    theme: window.FERRY_THEME,
    create,
  });
})();
