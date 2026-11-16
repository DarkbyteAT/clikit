// Plumwick Pond, world: the village diorama and everything that is drawn in it.
//
// Owns: `Cozy.createWorld(ctx)` - ground, pond, dock, plot, paper scenery, the hero and Nan, spot markers, the
//       "biting now" board, Nan's order sign, drifting petals and fireflies, the day tint and the village camera.
// Does not own: rules or state (cozy-data.js, cozy.js), sound, the HUD, or the underwater theatre (cozy-fishing.js).
//       It is told what to show and reports what happened (for example "the hero took a step").
(() => {
  const { ART, DAY, CAMERA, HERO, DOCK, POND, PLOT, STALL, SPOTS, SCENERY, GROUND, PATCHES, BITE_BOARD, PALETTE } = Cozy.data;
  const { keepOnLand, isOnDock } = Cozy.rules;
  const { TAU } = Kit.math;

  /** Village sprites: world units per art pixel, and their backward lean toward the tilted camera (radians). */
  const SPRITE = { unit: 0.085, lean: 0.3 };
  /** Heights (y) of the flat layers, bottom to top, so nothing z-fights. */
  const LAYER = { patch: 0.002, patchStep: 0.002, shore: 0.03, water: 0.06, glint: 0.07, marker: 0.05, soil: 0.07, crop: 0.12 };
  /** Pond surface: texture repeats and scroll speeds (uv per second). */
  const WATER = { repeat: [9, 8], glintRepeat: [8, 7], drift: 0.02, sway: 0.02, glintDrift: [-0.035, 0.01] };
  /** Drifting petals: how many, the box they fall through, and their motion. */
  const PETALS = { count: 12, spanX: 8, spanZ: [-7, 6], height: [2, 3.4], floor: 0.1, speed: [0.4, 0.9], sink: 0.22, sway: 0.4, spin: 2 };
  /** Fireflies: how many, where, and how they bob. They only show at night. */
  const FIREFLIES = { count: 9, span: 5, size: 0.55, color: 0xfff2a0, wander: 0.8, height: 0.8, bob: 0.35 };
  /** Chimney smoke: one soft puff this often (seconds), from the cottage chimney. */
  const SMOKE = { every: 0.9, at: { x: -1.1, y: 2.75, z: -6.7 } };
  /** Spot markers: the ring on the ground and the bobbing tag. */
  const MARKER = { inner: 0.42, outer: 0.54, opacity: 0.75, pulse: 0.08, pulseRate: 3, tagBob: 0.07, tagRate: 2 };
  /** Warm glow in the cottage window at night. */
  const WINDOW_GLOW = { color: 0xffd27a, size: 2.2, at: [-2.3, 1.2, -5.7], opacity: 0.8 };
  /** Hop heights and durations (world units, seconds) for the little reactions. */
  const HOPS = { harvest: [0.9, 0.35], greet: [0.3, 0.3], built: [1.2, 0.5] };
  const WHITE = 0xfffaf0;

  /**
   * Build the village.
   * @param {Object} ctx  The game ctx from the kit shell.
   * @returns {Object} The world: see the returned object at the end for its parts.
   */
  Cozy.createWorld = (ctx) => {
    const { THREE, make, scene, math, fx } = ctx;
    const { rand, damp, lerp } = math;
    const camera = ctx.camera;
    camera.fov = CAMERA.fov;
    camera.updateProjectionMatrix();
    const halfFov = (CAMERA.fov * Math.PI) / 360;

    /** Shared tint of every village sprite and the pond: mutated each frame by the day cycle. */
    const dayTint = new THREE.Color(1, 1, 1);
    const paper = Kit.pixel.use(ctx, { unit: SPRITE.unit, lean: SPRITE.lean, tint: dayTint });
    const firstPhase = DAY.phases[0];
    const stage = make.stage({ sky: [GROUND.grass, GROUND.grass], sun: [-6, 12, 7], sunColor: firstPhase.sun, sunIntensity: firstPhase.sunIntensity, ambient: firstPhase.ambient });
    stage.sun.castShadow = false; // paper sprites carry their own blob shadows

    // ---------- ground, pond, dock ----------
    /** A flat ellipse lying on the ground. */
    const disc = (x, z, radiusX, radiusZ, color, y) => {
      const mesh = make.cyl(1, 1, 0.02, color, { at: [x, y, z], seg: 28, rough: 0.95, shadow: false });
      mesh.scale.set(radiusX, 1, radiusZ);
      return mesh;
    };
    make.ground(90, GROUND.grass);
    PATCHES.forEach(([x, z, radiusX, radiusZ, color], index) => disc(x, z, radiusX, radiusZ, color, LAYER.patch + index * LAYER.patchStep));
    disc(POND.x, POND.z, POND.radiusX + 0.45, POND.radiusZ + 0.45, GROUND.sand, LAYER.shore);

    const waterTexture = Kit.pixel.texture(ART.water).texture, glintTexture = Kit.pixel.texture(ART.glint).texture;
    waterTexture.repeat.set(...WATER.repeat);
    glintTexture.repeat.set(...WATER.glintRepeat);
    const pondLayer = (material, y) => {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), material);
      mesh.scale.set(POND.radiusX, 1, POND.radiusZ);
      mesh.position.set(POND.x, y, POND.z);
      scene.add(mesh);
    };
    pondLayer(paper.flat(waterTexture, { color: dayTint }), LAYER.water);
    pondLayer(paper.flat(glintTexture, { color: dayTint, alphaTest: 0.5 }), LAYER.glint);

    const plankDepth = (DOCK.endZ - DOCK.startZ) / DOCK.planks;
    Array.from({ length: DOCK.planks }, (_, index) =>
      make.box(DOCK.width, 0.1, plankDepth * 0.95, index % 2 ? 0xc9975e : 0xb88650, { at: [DOCK.x, DOCK.height - 0.05, DOCK.startZ + plankDepth * (index + 0.5)], shadow: false })
    );
    [[-1, DOCK.startZ + 0.8], [1, DOCK.startZ + 0.8], [-1, DOCK.endZ - 0.1], [1, DOCK.endZ - 0.1]].forEach(([side, z]) =>
      make.cyl(0.09, 0.09, 0.62, 0x8a5f3c, { at: [DOCK.x + (side * DOCK.width) / 2, 0.2, z], seg: 8, shadow: false })
    );

    // ---------- the plot: one soil tile and one crop sprite per tile ----------
    const plotCentreX = (PLOT.tilesX[0] + PLOT.tilesX[PLOT.tilesX.length - 1]) / 2;
    make.box(4.5, 0.04, 1.4, GROUND.plotBed, { at: [plotCentreX, 0.02, PLOT.z], shadow: false });
    const soilColor = { dry: make.color(GROUND.soilDry), wet: make.color(GROUND.soilWet) };
    const tiles = PLOT.tilesX.map((x) => ({
      soil: make.box(0.86, 0.1, 0.86, make.mat(GROUND.soilDry, { fresh: true, rough: 1 }), { at: [x, LAYER.soil, PLOT.z], shadow: false }),
      crop: paper.sprite(ART.sprout, { at: [x, LAYER.crop, PLOT.z + 0.1], shadow: false }).show(false),
      /** Sprite key on show ('' = bare), so a redraw only happens when the stage changes. */
      shownStage: '',
      /** True while the harvested crop is still hopping away: the tile must not redraw under it. */
      isBusy: false,
    }));
    const plot = {
      /** World position just above a tile, for particles and floaters. @param {number} index */
      positionOf: (index) => ({ x: PLOT.tilesX[index], y: 0.5, z: PLOT.z }),
      /**
       * Show a tile's growth stage.
       * @param {number} index
       * @param {string} stageKey  '' for bare soil, else a key of ART.
       * @param {boolean} isWet
       * @returns {boolean} True when the stage changed to a new sprite (a growth step worth celebrating).
       */
      show(index, stageKey, isWet) {
        const tile = tiles[index];
        if (tile.isBusy || stageKey === tile.shownStage) return false;
        const hadSprite = tile.shownStage !== '';
        tile.shownStage = stageKey;
        tile.soil.material.color.copy(isWet ? soilColor.wet : soilColor.dry);
        tile.crop.show(stageKey !== '');
        if (stageKey === '') return false;
        tile.crop.set(ART[stageKey]).squash(0.3);
        return hadSprite;
      },
      /** A gentle wobble that says "I am ripe". @param {number} index */
      nudge: (index) => tiles[index].crop.squash(0.14),
      /** A firmer wobble for a tap that did nothing. @param {number} index */
      refuse: (index) => tiles[index].crop.squash(0.2),
      /** The harvested crop hops off its tile. @param {number} index */
      popOut(index) {
        const tile = tiles[index];
        tile.isBusy = true;
        tile.crop.hop(...HOPS.harvest, () => (tile.isBusy = false));
      },
    };

    // ---------- paper scenery and characters ----------
    SCENERY.forEach(([name, x, z]) => paper.sprite(ART[name], { at: [x, 0, z] }));
    const nan = paper.sprite(ART.nan, { at: [STALL.x - 0.2, 0, STALL.z - 0.35], shadow: false }).face(-1, true);
    const hero = paper.sprite(ART.hero, { at: [HERO.start[0], 0, HERO.start[1]] });
    const bobber = paper.sprite(ART.bobber, { shadow: false }).show(false);
    const windowGlow = make.glow(WINDOW_GLOW.color, WINDOW_GLOW.size, { at: WINDOW_GLOW.at, opacity: 0, depthTest: false });

    // Nan's order: a "2X" tag beside the stall with today's wanted item floating above it.
    const orderAt = [STALL.x + 1.65, 0, STALL.z + 0.6];
    paper.sprite(Kit.pixel.label('2X', { fill: PALETTE.y }), { at: orderAt });
    const orderIcon = paper.sprite(ART.minnel, { at: [orderAt[0], 0.95, orderAt[2]], shadow: false });
    const orderSign = { show: (id) => orderIcon.set(ART[id]).squash(0.3) };

    // The "biting now" board on the shore: a tag with the fish that bite at this hour floating above it.
    paper.sprite(Kit.pixel.label('BITING'), { at: BITE_BOARD.at, unit: BITE_BOARD.labelUnit });
    const biteIcons = Array.from({ length: BITE_BOARD.slots }, () => paper.sprite(ART.minnel, { unit: BITE_BOARD.iconUnit, shadow: false }).show(false));
    const biteBoard = {
      /** @param {Object[]} fishList  Fish rows to show; only the first BITE_BOARD.slots fit. */
      show(fishList) {
        const shown = fishList.slice(0, BITE_BOARD.slots);
        biteIcons.forEach((icon, slot) => {
          icon.show(slot < shown.length);
          if (slot >= shown.length) return;
          const offset = (slot - (shown.length - 1) / 2) * BITE_BOARD.spacing; // centre the row over the tag
          icon.set(ART[shown[slot].id]).squash(0.3);
          icon.root.position.set(BITE_BOARD.at[0] + offset, BITE_BOARD.iconHeight, BITE_BOARD.at[2]);
        });
      },
    };

    // ---------- spot markers ----------
    const markers = SPOTS.map((spot) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(MARKER.inner, MARKER.outer, 28).rotateX(-Math.PI / 2), make.unlit(WHITE, { opacity: MARKER.opacity }));
      ring.position.set(spot.at[0], (spot.id === 'fish' ? DOCK.height : 0) + LAYER.marker, spot.at[1]);
      scene.add(ring);
      return { spot, ring, tag: paper.sprite(Kit.pixel.label(spot.tag), { at: spot.tagAt, shadow: false }) };
    });
    const farmMarker = markers.find((marker) => marker.spot.id === 'farm');
    const ripeTag = paper.sprite(Kit.pixel.label('RIPE!', { fill: PALETTE.y }), { at: farmMarker.spot.tagAt, shadow: false }).show(false);
    let hasRipeCrop = false;

    // ---------- drifting life ----------
    const petals = Array.from({ length: PETALS.count }, () => ({
      sprite: paper.sprite(ART.petal, { shadow: false, at: [rand(-PETALS.spanX, PETALS.spanX), rand(0.4, PETALS.height[1]), rand(...PETALS.spanZ)] }),
      speed: rand(...PETALS.speed),
      phase: rand(TAU),
    }));
    const fireflies = Array.from({ length: FIREFLIES.count }, () => ({
      glow: make.glow(FIREFLIES.color, FIREFLIES.size, { opacity: 0 }),
      x: rand(-FIREFLIES.span, FIREFLIES.span),
      z: rand(-FIREFLIES.span, FIREFLIES.span),
      phase: rand(TAU),
    }));
    ctx.every(SMOKE.every, () => fx.burst(SMOKE.at, { count: 1, color: WHITE, speed: 0.25, gravity: -0.9, life: 2.2, size: 0.2 }));

    function updatePetals(dt, time) {
      for (const petal of petals) {
        const position = petal.sprite.root.position;
        position.x += petal.speed * dt;
        position.y -= PETALS.sink * dt;
        position.z += Math.sin(time * 1.3 + petal.phase) * PETALS.sway * dt;
        petal.sprite.pivot.rotation.z = time * PETALS.spin + petal.phase;
        const hasLanded = position.y < PETALS.floor, hasBlownAway = position.x > PETALS.spanX;
        // A landed petal restarts anywhere upwind; one that blew off the right edge re-enters from the left.
        if (hasLanded || hasBlownAway) position.set(hasLanded ? rand(-PETALS.spanX, 6) : -PETALS.spanX, rand(...PETALS.height), rand(...PETALS.spanZ));
      }
    }
    function updateFireflies(time, night) {
      for (const firefly of fireflies) {
        firefly.glow.material.opacity = night * (0.55 + 0.45 * Math.sin(time * 3 + firefly.phase));
        firefly.glow.position.set(
          firefly.x + Math.sin(time * 0.6 + firefly.phase) * FIREFLIES.wander,
          FIREFLIES.height + Math.sin(time * 0.9 + firefly.phase * 2) * FIREFLIES.bob,
          firefly.z + Math.cos(time * 0.5 + firefly.phase) * FIREFLIES.wander
        );
      }
    }

    // ---------- day tint ----------
    const phaseColors = new Map(DAY.phases.map((phase) => [phase.id, { tint: make.color(phase.tint), sun: make.color(phase.sun) }]));
    /** Blend lights and the shared sprite tint between two day phases. @param {Object} day  From Cozy.rules.dayAt. */
    function applyDay(day) {
      const from = phaseColors.get(day.phase.id), to = phaseColors.get(day.next.id);
      dayTint.copy(from.tint).lerp(to.tint, day.blend);
      stage.sun.color.copy(from.sun).lerp(to.sun, day.blend);
      stage.sun.intensity = lerp(day.phase.sunIntensity, day.next.sunIntensity, day.blend);
      stage.hemi.intensity = lerp(day.phase.ambient, day.next.ambient, day.blend);
      windowGlow.material.opacity = day.night * WINDOW_GLOW.opacity;
    }

    // ---------- camera ----------
    const rig = { focus: new THREE.Vector3(0, 0, 0.6), goal: new THREE.Vector3(0, 0, 0.6), width: CAMERA.villageWidth, goalWidth: CAMERA.villageWidth };
    /** When set, this function places the camera instead of the village rig (the underwater theatre uses it). */
    let cameraDriver = null;
    function updateCamera(dt) {
      if (cameraDriver) return cameraDriver(camera);
      rig.focus.x = damp(rig.focus.x, rig.goal.x, CAMERA.damping, dt);
      rig.focus.z = damp(rig.focus.z, rig.goal.z, CAMERA.damping, dt);
      rig.width = damp(rig.width, rig.goalWidth, CAMERA.damping, dt);
      // Far enough to fit the width (portrait) and, in landscape, the depth of the scene as well.
      const distance = Math.max(ctx.distanceForWidth(rig.width, CAMERA.fov), (rig.width * CAMERA.depthShare) / Math.tan(halfFov));
      camera.position.set(rig.focus.x, distance * Math.sin(CAMERA.pitch), rig.focus.z + distance * Math.cos(CAMERA.pitch));
      camera.lookAt(rig.focus);
    }
    const projected = new THREE.Vector3();
    /** Screen position (px) of a world point. @param {{ x: number, y: number, z: number }} point @returns {{ x: number, y: number }} */
    const toScreen = (point) => {
      projected.set(point.x, point.y, point.z).project(ctx.camera);
      return { x: (projected.x * 0.5 + 0.5) * ctx.size.w, y: (-projected.y * 0.5 + 0.5) * ctx.size.h };
    };

    // ---------- the hero: a Kit.touch.walker on the ground plane (its y is world z) drawn as a paper sprite ----------
    const walker = Kit.touch.walker({ at: { x: HERO.start[0], y: HERO.start[1] }, speed: HERO.speed, constrain: keepOnLand });
    let untilNextStep = 0;
    /**
     * Walk the hero toward its target and animate it.
     * @param {number} dt
     * @returns {{ isMoving: boolean, didStep: boolean }} didStep is true on frames where a foot lands (for a sound).
     */
    function updateHero(dt) {
      const { isMoving, heading } = walker.step(dt);
      const position = hero.root.position;
      position.x = walker.position.x;
      position.z = walker.position.y;
      position.y = damp(position.y, isOnDock(walker.position) ? DOCK.height : 0, 16, dt); // step up onto the planks
      if (!isMoving) {
        hero.stop(0);
        return { isMoving, didStep: false };
      }
      if (heading) hero.face(heading);
      hero.play('walk', HERO.walkFps);
      untilNextStep -= dt;
      const didStep = untilNextStep <= 0;
      if (didStep) untilNextStep = HERO.stepSeconds;
      return { isMoving, didStep };
    }

    return {
      /** The village sprite factory (Kit.pixel.use) and its shared day tint. */
      paper, dayTint,
      hero, nan, bobber, plot, orderSign, biteBoard,
      toScreen,
      /**
       * Stand a new piece of scenery in the village (a finished town project).
       * @param {string} name  Key of ART. @param {number} x @param {number} z
       * @param {boolean} [isNew=false]  Just built: it drops in with a hop instead of simply being there.
       */
      addProp(name, x, z, isNew = false) {
        const prop = paper.sprite(ART[name], { at: [x, 0, z] });
        if (isNew) prop.hop(...HOPS.built);
      },
      /**
       * A small burst of paper sparkles: the game's one celebration effect.
       * @param {{ x: number, y: number, z: number }} at
       * @param {number} count
       * @param {number[]} colors  0xRRGGBB choices.
       * @param {Object} [options]  fx.burst options to override (speed, life, gravity...).
       */
      sparkle: (at, count, colors, options) => fx.burst(at, { count, colors, speed: 2.2, life: 0.55, size: 0.09, gravity: 2, ...options }),
      /** Send the hero walking to a ground point (clamped to the shore). @param {number} x @param {number} z */
      walkTo: (x, z) => walker.goTo({ x, y: z }),
      /** Stop the hero where it stands. */
      haltHero: () => walker.stop(),
      /** Where the hero is walking to, as world x / z. */
      walkTarget: () => ({ x: walker.target.x, z: walker.target.y }),
      updateHero,
      /** Nan's little hop of acknowledgement. */
      greet: () => nan.hop(...HOPS.greet),
      /** Aim the village camera. @param {number} x @param {number} z @param {number} width  World units across the view. */
      frame(x, z, width) {
        rig.goal.set(x, 0, z);
        rig.goalWidth = width;
      },
      /** Hand the camera to another view (or back with null). @param {((camera: Object) => void) | null} driver */
      setCameraDriver: (driver) => (cameraDriver = driver),
      updateCamera,
      /** Swap the FARM tag for a RIPE! tag while something can be harvested. @param {boolean} isRipe */
      setRipe: (isRipe) => (hasRipeCrop = isRipe),
      /**
       * Per-frame ambience.
       * @param {number} dt
       * @param {number} time  Game time in seconds.
       * @param {{ day: Object, showMarkers: boolean }} view  day: from Cozy.rules.dayAt; showMarkers: roaming or not.
       */
      update(dt, time, { day, showMarkers }) {
        applyDay(day);
        waterTexture.offset.set(time * WATER.drift, Math.sin(time * 0.5) * WATER.sway);
        glintTexture.offset.set(time * WATER.glintDrift[0], time * WATER.glintDrift[1]);
        updatePetals(dt, time);
        updateFireflies(time, day.night);
        markers.forEach(({ spot, ring, tag }, index) => {
          tag.root.position.y = spot.tagAt[1] + Math.sin(time * MARKER.tagRate + index * 2) * MARKER.tagBob;
          ring.scale.setScalar(1 + Math.sin(time * MARKER.pulseRate + index) * MARKER.pulse);
          ring.visible = showMarkers;
        });
        farmMarker.tag.show(!hasRipeCrop);
        ripeTag.show(hasRipeCrop);
        ripeTag.root.position.y = farmMarker.tag.root.position.y;
        paper.update(dt);
      },
    };
  };
})();
