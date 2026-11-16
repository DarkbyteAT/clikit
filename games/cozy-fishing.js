// Plumwick Pond, fishing: the dock, the underwater paper theatre and one minigame per kind of tackle.
//
// Owns: `Cozy.createFishing(game)` - the fishing activity (cast -> wait -> bite -> play -> catch card), the theatre it
//       plays in, and the three tackle modes: trace (rod), net and lantern. Each mode is a small object with
//       start / update / stop (+ drag, probe) picked from MODES by the tackle row's `mode`.
// Does not own: the rules of touch (Kit.touch: trace meter, stroke, lasso), fish and tackle numbers (cozy-data.js),
//       the HUD widgets (cozy.js) or the village (cozy-world.js).
(() => {
  const { ART, FISH, WATERS, TRACE, NET, LANTERN, DOCK_TIMING, DOCK, NOTES, CAMERA } = Cozy.data;
  const { traceOptions, itemValue, schoolSize } = Cozy.rules;
  const { TAU, lerp } = Kit.math;

  /** The theatre is built far below the village so the two never show in the same view. */
  const THEATRE = {
    originY: -60,
    unit: 0.1, // world units per art pixel of theatre sprites
    hudTopPx: 128, hudBottomPx: { portrait: 84, landscape: 66 }, // screen kept clear for the meters and the buttons
    minHalfSpan: 3.2, // the panel always shows at least this many units from its centre, both ways
    swimMargin: 0.75, // fish stay this far from the surface and the bed
    widthShare: 0.85, maxAspect: 1.7, // swim area: this share of the half width, and never wider than maxAspect x its height
    overscan: 1.3, // backdrops extend past the view so resizes never show an edge
    dayShare: 0.5, // how much of the village's day tint reaches underwater
    bubbleEvery: 0.6,
    decor: [[-0.8, 'weed'], [-0.55, 'rock'], [-0.3, 'weed'], [0.25, 'weed'], [0.6, 'rock'], [0.85, 'weed']], // [x share, sprite]
  };
  /** Depths (z) of the theatre's layers, back to front. */
  const DEPTH = { backdrop: -0.6, line: 0.02, fish: 0.05, wave: 0.1, lamp: 0.2, tether: 0.24, ring: 0.25, rope: 0.3, plants: 0.45, bed: 0.5, sand: 0.55 };
  const COLOR = { white: 0xfffaf0, onTarget: 0xb6f07a, steady: 0xf9d45c, offTarget: 0xff9a8a, bubble: [0xdff6fb, 0xaee6f0], gold: [0xfff3a0, 0xfffaf0], glow: 0xffe27a, lampGlow: 0xffd98a };
  /** Tick sounds while tracing: seconds between ticks on and off the fish, and the tension above which the line creaks. */
  const TICKS = { on: 0.2, off: 0.34, creakAbove: 0.45 };
  /** Size (world units) of the foresight bubbles nearest to and furthest ahead of the fish. */
  const FORESIGHT_DOT = { near: 0.24, far: 0.12 };
  /** Net rope is drawn with at most this many dots. */
  const MAX_ROPE_DOTS = 260;
  /** Spare sprites kept for schools and fry (the most any hour or tackle level asks for). */
  const MAX_SCHOOL = NET.maxSchool;

  /**
   * Build the underwater paper theatre: a flat panel the camera looks straight at.
   * @param {Object} game  The shared game object (see cozy.js).
   * @returns {Object} group, extents, sprite / bar / dot builders, toPanel, pointer, effects and update.
   */
  function createTheatre(game) {
    const { ctx, world } = game;
    const { THREE, make, fx, math } = ctx;
    const halfFov = (CAMERA.fov * Math.PI) / 360;
    const group = make.group();
    group.visible = false;
    /** Tint of every theatre sprite: follows the day softly, or a mood a mode sets (the lantern's night dive). */
    const tint = new THREE.Color(1, 1, 1);
    const paper = Kit.pixel.use(ctx, { unit: THEATRE.unit, shadow: false, tint });
    let mood = null;

    const sprite = (def, options) => paper.sprite(def, { parent: group, anchor: 'center', ...options });
    /** A unit plane in a flat colour; stretch() turns it into a line between two points. */
    const bar = (color, opacity = 1) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), paper.flat(null, { color, opacity }));
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    };
    const backdrop = (def, depth) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), paper.flat(Kit.pixel.texture(def).texture, { color: tint }));
      mesh.position.z = depth;
      group.add(mesh);
      return mesh;
    };
    const water = backdrop(ART.depths, DEPTH.backdrop), sky = backdrop(ART.air, DEPTH.backdrop), bed = backdrop(ART.seabed, DEPTH.bed);
    const waveBack = sprite(ART.waves), waveFront = sprite(ART.waves), sands = sprite(ART.sands);
    const decor = THEATRE.decor.map(([share, name]) => ({ share, isWeed: name === 'weed', sprite: sprite(ART[name], { anchor: 'bottom' }) }));

    /**
     * The panel's measurements in world units, refreshed on resize.
     * halfWidth / halfHeight: half the visible panel; surfaceY / floorY: top and bottom of the water the fish may use;
     * centreY, rangeX, rangeY: centre and half-extents of the swim area that path space (-1..1) maps onto;
     * distance: camera distance; lift: TRACE.liftPx in world units.
     */
    const extents = { halfWidth: 0, halfHeight: 0, surfaceY: 0, floorY: 0, centreY: 0, rangeX: 0, rangeY: 0, distance: 0, lift: 0 };
    function layout() {
      const { h: screenHeight, aspect, portrait } = ctx.size;
      const topPx = THEATRE.hudTopPx, bottomPx = portrait ? THEATRE.hudBottomPx.portrait : THEATRE.hudBottomPx.landscape;
      // Tall enough that both the width and the HUD-free height show at least minHalfSpan units each way.
      extents.halfHeight = Math.max(THEATRE.minHalfSpan / aspect, THEATRE.minHalfSpan / (1 - (topPx + bottomPx) / screenHeight));
      extents.halfWidth = extents.halfHeight * aspect;
      extents.distance = extents.halfHeight / Math.tan(halfFov);
      const unitsPerPx = (2 * extents.halfHeight) / screenHeight;
      extents.surfaceY = THEATRE.originY + extents.halfHeight - topPx * unitsPerPx;
      extents.floorY = THEATRE.originY - extents.halfHeight + bottomPx * unitsPerPx;
      extents.centreY = (extents.surfaceY + extents.floorY) / 2;
      extents.rangeY = (extents.surfaceY - extents.floorY) / 2 - THEATRE.swimMargin;
      extents.rangeX = Math.min(extents.halfWidth * THEATRE.widthShare, extents.rangeY * THEATRE.maxAspect);
      extents.lift = TRACE.liftPx * unitsPerPx;

      const width = extents.halfWidth * 2 * THEATRE.overscan;
      const top = THEATRE.originY + extents.halfHeight * THEATRE.overscan, bottom = THEATRE.originY - extents.halfHeight * THEATRE.overscan;
      const waterline = extents.surfaceY + 0.25;
      const span = (mesh, from, to) => {
        mesh.scale.set(width, to - from, 1);
        mesh.position.y = (from + to) / 2;
      };
      span(water, bottom, waterline);
      span(sky, waterline, top);
      span(bed, bottom, extents.floorY);
      waveBack.root.position.set(0, extents.surfaceY - 0.1, DEPTH.wave);
      waveFront.root.position.set(0, extents.surfaceY + 0.12, DEPTH.wave + 0.2);
      sands.root.position.set(0, extents.floorY + 0.1, DEPTH.sand);
      decor.forEach((piece) => piece.sprite.root.position.set(piece.share * extents.halfWidth, extents.floorY + 0.15, DEPTH.plants));
    }
    layout();
    ctx.on('resize', layout);
    ctx.every(THEATRE.bubbleEvery, () => group.visible && bubbles({ x: math.rand(-extents.halfWidth, extents.halfWidth), y: extents.floorY + 0.4 }, 1, 0.3));

    /** Rising bubbles. @param {{ x: number, y: number }} at @param {number} [count] @param {number} [speed] */
    function bubbles(at, count = 1, speed = 0.6) {
      fx.burst({ x: at.x, y: at.y, z: 0.2 }, { count, colors: COLOR.bubble, speed, gravity: -3, life: 1.1, size: 0.1 });
    }
    /** world.sparkle on the panel, just in front of the fish. @param {{ x: number, y: number }} at @param {number} count @param {number[]} colors @param {Object} [options] fx.burst options. */
    const sparkle = (at, count, colors, options) => world.sparkle({ x: at.x, y: at.y, z: 0.2 }, count, colors, options);

    return {
      group, extents, sprite, bar, bubbles, sparkle, flat: paper.flat,
      /** Path space (-1..1, y up) to panel world units. @param {{ x: number, y: number }} point */
      toPanel: (point) => ({ x: point.x * extents.rangeX, y: extents.centreY + point.y * extents.rangeY }),
      /** Where the finger is on the panel, in world units. */
      pointer: () => ({ x: ctx.input.pointer.nx * extents.halfWidth, y: THEATRE.originY + ctx.input.pointer.ny * extents.halfHeight }),
      /** Stretch a bar() between two panel points. */
      stretch(mesh, from, to, thickness, depth) {
        mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, depth);
        mesh.scale.set(thickness, Math.hypot(to.x - from.x, to.y - from.y) || 0.001, 1); // never zero: a zero scale is not invertible
        mesh.rotation.z = Math.atan2(to.y - from.y, to.x - from.x) - Math.PI / 2;
      },
      /** Override the tint (RGB multipliers), or null to follow the day again. @param {number[] | null} rgb */
      setMood: (rgb) => (mood = rgb),
      /** Show or hide the theatre and point the camera at it. @param {boolean} isOpen */
      open(isOpen) {
        group.visible = isOpen;
        world.setCameraDriver(isOpen ? (camera) => {
          camera.position.set(0, THEATRE.originY, extents.distance);
          camera.lookAt(0, THEATRE.originY, 0);
        } : null);
      },
      update(dt, time) {
        if (!group.visible) return;
        if (mood) tint.setRGB(...mood);
        else tint.setRGB(1, 1, 1).lerp(world.dayTint, THEATRE.dayShare);
        waveBack.root.position.x = 0.8 - Math.sin(time * 0.5) * 0.6;
        waveFront.root.position.x = Math.sin(time * 0.7) * 0.5;
        decor.filter((piece) => piece.isWeed).forEach((piece, index) => (piece.sprite.pivot.rotation.z = Math.sin(time * 1.3 + index) * 0.12));
        paper.update(dt);
      },
    };
  }

  /**
   * @typedef {Object} TackleMode  One way of fishing, played in the theatre.
   * @property {() => void} start        Begin a new round.
   * @property {(dt: number) => void} update
   * @property {() => void} stop         Hide everything the mode drew.
   * @property {(event: Object) => void} [drag]  Kit.input drag events, for modes that draw.
   * @property {() => Object} probe      What a scripted playtest needs to see (screen positions, counts).
   *
   * @typedef {Object} ModeParts
   * @property {Object} game     The shared game object.
   * @property {Object} theatre  From createTheatre.
   * @property {{ land: (catchResult: { fish: Object, count: number, stars: number }) => void, lose: (text: string) => void }} outcome
   */

  /**
   * Rod: trace one fish. Keep the ring on it to fill the catch meter before the line frays.
   * The rules live in Kit.touch.trace; this draws the fight and gives the fish its temper (tiring, startling).
   * @param {ModeParts} parts
   * @returns {TackleMode}
   */
  function createTraceMode({ game, theatre, outcome }) {
    const { ctx, hud, sound, stats } = game;
    const { THREE, fx, math } = ctx;
    const fishSprite = theatre.sprite(ART.minnel).show(false);
    const line = theatre.bar(COLOR.white), tether = theatre.bar(COLOR.white, 0.5);
    const ringLook = { on: theatre.flat(null, { color: COLOR.onTarget }), steady: theatre.flat(null, { color: COLOR.steady }), off: theatre.flat(null, { color: COLOR.offTarget }) };
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 40), ringLook.on);
    ring.visible = false;
    theatre.group.add(ring);
    const foresightDots = Array.from({ length: TRACE.foresightDots }, () => theatre.bar(COLOR.white, 0.55));
    /** Everything about the fight in progress; replaced by start(). */
    let fight = null;

    /** How fast the fish swims its path right now (tier pace, tiring, panic): the pace of the fight's trace options. */
    const paceOf = (state) => fight.options.pace(state);

    function startle() {
      fight.panicLeft = TRACE.panic.seconds;
      theatre.bubbles(fight.state.target, 12, 2.4);
      fishSprite.squash(0.35);
      sound.note(520, { to: 780, dur: 0.14, type: 'triangle', vol: 0.12 });
      fx.floater('!', { ...fight.state.target, z: 0 }, { color: '#fffaf0', size: 30 });
    }

    /** Compare two consecutive fight states and react to what changed: startles, the steady callout, tick sounds. */
    function react(before, after, dt) {
      const goal = theatre.toPanel(fight.fish.swim(after.pathTime));
      const hasJumped = fight.lastGoal && Kit.line.dist(goal, fight.lastGoal) > TRACE.patternJump; // a sequence switched pattern
      fight.lastGoal = goal;
      const nextStartle = TRACE.startleAt[fight.startles];
      if (nextStartle !== undefined && after.progress >= nextStartle) fight.startles++;
      if (hasJumped || fight.startles > fight.startlesShown) startle();
      fight.startlesShown = fight.startles;
      if (before.streak < TRACE.steadySeconds && after.streak >= TRACE.steadySeconds) {
        sound.chime([4, 6], { vol: 0.08 });
        fx.floater('Steady', { ...after.target, z: 0 }, { color: '#f9d45c', size: 18 });
      }
      fight.untilTick -= dt;
      if (!fight.hasTouched || fight.untilTick > 0) return;
      fight.untilTick = after.isOnTarget ? TICKS.on : TICKS.off;
      if (after.isOnTarget) {
        sound.note(392 + 500 * after.progress, { dur: 0.07, vol: 0.06 }); // the pitch climbs with the catch meter
        theatre.sparkle(after.target, 2, COLOR.gold, { gravity: -2 });
      } else if (after.tension > TICKS.creakAbove) sound.note(150 - after.tension * 40, { dur: 0.1, type: 'triangle', vol: 0.12 });
    }

    function drawFish(before, after, dt) {
      const moved = after.target.x - before.target.x;
      if (Math.abs(moved) > 0.6 * dt) fishSprite.face(moved);
      fishSprite.root.position.set(after.target.x, after.target.y, DEPTH.fish);
      const isPanicking = fight.panicLeft > 0;
      // Tail wiggle: quick and wide when panicking, otherwise in step with how fast it is swimming.
      fishSprite.pivot.rotation.z = Math.sin(fight.clock * (isPanicking ? 30 : 12 * paceOf(after))) * (isPanicking ? 0.22 : 0.09);
      fight.untilBubble -= dt;
      if (fight.untilBubble > 0) return;
      fight.untilBubble = isPanicking ? 0.08 : 0.5;
      theatre.bubbles({ x: after.target.x - fishSprite.facing * 0.5, y: after.target.y });
    }

    /** The ring floats above the fingertip on a short tether, so the thumb never hides the fish. */
    function drawRing(ringAt, state) {
      ring.visible = tether.visible = !!ringAt;
      if (!ringAt) return;
      const isSteady = state.isOnTarget && state.streak >= TRACE.steadySeconds;
      ring.material = isSteady ? ringLook.steady : state.isOnTarget ? ringLook.on : ringLook.off;
      ring.position.set(ringAt.x, ringAt.y, DEPTH.ring);
      ring.scale.setScalar(fight.tolerance * (state.isOnTarget ? 1 + Math.sin(fight.clock * 14) * 0.03 : 1));
      theatre.stretch(tether, { x: ringAt.x, y: ringAt.y - fight.tolerance }, { x: ringAt.x, y: ringAt.y - theatre.extents.lift }, 0.03, DEPTH.tether);
    }

    function drawLine(state) {
      const shake = Math.sin(fight.clock * 40) * 0.05 * Math.max(0, state.tension - 0.5); // a strained line trembles
      theatre.stretch(line, { x: state.target.x * 0.3 + shake, y: theatre.extents.surfaceY + 0.2 }, state.target, 0.035, DEPTH.line);
      line.material.color.setRGB(1, 1 - state.tension * 0.65, 0.9 - state.tension * 0.7); // white -> red as it frays
    }

    /** Bubbles along the next moments of the fish's path: a better rod shows further ahead. */
    function drawForesight(state) {
      const seconds = stats.get('foresight') * paceOf(state);
      foresightDots.forEach((dot, index) => {
        const ahead = (index + 1) / foresightDots.length;
        const at = theatre.toPanel(fight.fish.swim(state.pathTime + ahead * seconds));
        dot.position.set(at.x, at.y, DEPTH.line);
        dot.scale.setScalar(lerp(FORESIGHT_DOT.near, FORESIGHT_DOT.far, ahead)); // smaller further into the future
      });
    }

    function land(state) {
      fight.isOver = true;
      fishSprite.hop(0.7, 0.45).face(-fishSprite.facing);
      theatre.sparkle(state.target, 26, [...COLOR.gold, COLOR.bubble[1]], { speed: 4, life: 0.8 });
      sound.chime([0, 2, 4]);
      game.later(0.7, () => outcome.land({ fish: fight.fish, count: 1, stars: TRACE.stars(fight.model.accuracy(state)) }));
    }

    function snap() {
      fight.isOver = true;
      setDrawn(false);
      fishSprite.show(true);
      ctx.tween(fishSprite.root.position, { x: fishSprite.facing * (theatre.extents.halfWidth + 3) }, 0.5, 'inCubic'); // it darts off screen
      outcome.lose('The line snapped');
    }

    /** Show or hide everything this mode draws. */
    function setDrawn(isDrawn) {
      fishSprite.show(isDrawn);
      line.visible = isDrawn;
      foresightDots.forEach((dot) => (dot.visible = isDrawn));
      if (!isDrawn) ring.visible = tether.visible = false;
    }

    return {
      start() {
        const fish = game.hookFish(); // rolled from the hour, water, rod and bait; uses up the bait
        const options = traceOptions(fish, stats.get, theatre.toPanel, () => fight.panicLeft > 0, WATERS.byId(game.state.water));
        const model = Kit.touch.trace(options);
        // The fish starts where it was hooked, just under the surface, and swims down into its pattern.
        const hooked = { ...model.start(math.rand(0, 20)), target: { x: 0, y: theatre.extents.surfaceY - 0.4 } };
        fight = { fish, model, options, tolerance: options.tolerance, state: hooked, hasTouched: false, graceLeft: TRACE.graceSeconds, panicLeft: 0, startles: 0, startlesShown: 0, lastGoal: null, untilTick: 0, untilBubble: 0, clock: 0, isOver: false };
        fishSprite.set(ART[fish.id]).face(1, true);
        fishSprite.pivot.scale.setScalar(1);
        setDrawn(true);
        hud.meters.catch.label('Catch');
        hud.meters.line.label('Line');
        hud.tip(`Hold below the ${fish.name}: keep the ring on it`);
      },
      stop: () => setDrawn(false),
      probe: () => fight && { fish: fight.fish.id, meter: fight.state.progress, tension: fight.state.tension, at: game.world.toScreen({ ...fight.state.target, z: 0 }), liftPx: TRACE.liftPx },
      update(dt) {
        if (fight.isOver) return;
        fight.clock += dt;
        fight.panicLeft = Math.max(0, fight.panicLeft - dt);
        const finger = ctx.input.pointer.down ? theatre.pointer() : null;
        const ringAt = finger && { x: finger.x, y: finger.y + theatre.extents.lift };
        if (finger && !fight.hasTouched) hud.tip('');
        fight.graceLeft -= dt;
        fight.hasTouched = fight.hasTouched || !!finger || fight.graceLeft <= 0; // the fight starts on the first touch, or by itself
        const before = fight.state;
        const after = (fight.state = fight.hasTouched ? fight.model.step(before, dt, ringAt) : fight.model.drift(before, dt));
        react(before, after, dt);
        drawFish(before, after, dt);
        drawRing(ringAt, after);
        drawLine(after);
        drawForesight(after);
        hud.meters.catch.set(after.progress);
        hud.meters.line.set(1 - after.tension);
        if (after.outcome === 'won') land(after);
        else if (after.outcome === 'lost') snap();
      },
    };
  }

  /**
   * Loop Net: draw a loop with limited rope around a school that bunches up and spreads out; every sprat inside is
   * yours. The rope is a Kit.touch.stroke and the loop is scored by Kit.touch.lasso.
   * @param {ModeParts} parts
   * @returns {TackleMode}
   */
  function createNetMode({ game, theatre, outcome }) {
    const { ctx, hud, sound, stats } = game;
    const { THREE, fx, math } = ctx;
    const sprats = Array.from({ length: MAX_SCHOOL }, () => ({ sprite: theatre.sprite(ART.sprat).show(false), angle: 0, orbit: 0, spin: 0, isFree: false }));
    const ropeDots = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.12, 0.12), theatre.flat(null, { color: COLOR.white }), MAX_ROPE_DOTS);
    ropeDots.frustumCulled = false; // instances move every frame; the default bounds would cull them wrongly
    ropeDots.count = 0;
    theatre.group.add(ropeDots);
    const placer = new THREE.Object3D();
    /** The cast in progress; replaced by start(). */
    let cast = null;

    function drawRope(points) {
      points.slice(0, MAX_ROPE_DOTS).forEach((point, index) => {
        placer.position.set(point.x, point.y, DEPTH.rope);
        placer.updateMatrix();
        ropeDots.setMatrixAt(index, placer.matrix);
      });
      ropeDots.count = Math.min(MAX_ROPE_DOTS, points.length);
      ropeDots.instanceMatrix.needsUpdate = true;
    }
    const clearRope = () => {
      cast.rope.reset();
      drawRope([]);
    };
    const freeSprats = () => sprats.filter((sprat) => sprat.isFree);

    function finish() {
      cast.isOver = true;
      if (!cast.caught) return outcome.lose('The net came up empty');
      outcome.land({ fish: FISH.byId('sprat'), count: cast.caught, stars: NET.stars(cast.caught / cast.schoolSize) });
    }

    /** Haul in whatever the finished loop encloses. */
    function pullShut() {
      cast.isDrawing = false;
      const points = cast.rope.points;
      if (points.length < NET.minPoints) return clearRope(); // a tap or a scribble: no throw spent
      const loop = Kit.touch.lasso(points, freeSprats(), { closeTolerance: NET.closeTolerance, at: (sprat) => sprat.sprite.root.position });
      if (!loop.isClosed) {
        hud.tip('Bring the rope round to where it started');
        sound.note(196, { dur: 0.15, type: 'triangle' });
        return clearRope();
      }
      // Show the net pulling shut: fill the gap between the rope's ends with dots.
      drawRope(points.concat(Kit.line.resample([points[points.length - 1], points[0]], NET.minStep)));
      loop.inside.forEach((sprat) => {
        sprat.isFree = false;
        sprat.sprite.hop(0.6, 0.4, () => sprat.sprite.show(false)).face(-sprat.sprite.facing);
        theatre.sparkle(sprat.sprite.root.position, 6, [COLOR.white, COLOR.bubble[1]]);
      });
      const haul = loop.inside.length;
      cast.caught += haul;
      cast.throwsLeft--;
      cast.scatter = 1; // the splash spooks the rest apart for a moment
      cast.isHauling = true; // no new rope until this haul has been shown
      fx.floater(haul ? '+' + haul : 'Slipped out', { ...loop.centre, z: DEPTH.rope }, { color: haul ? '#f9d45c' : '#fffaf0' });
      if (haul) sound.chime([1, 3, 5].slice(0, Math.min(3, haul)));
      else sound.note(196, { dur: 0.2, type: 'triangle' });
      game.later(0.8, () => {
        cast.isHauling = false;
        clearRope();
        if (cast.throwsLeft <= 0 || cast.caught >= cast.schoolSize) finish();
        else hud.tip('One more throw. Wait for them to bunch up');
      });
    }

    function swimSchool(dt) {
      const centre = theatre.toPanel(NET.herd(cast.clock));
      // The school breathes: tight, then loose. Tight is the moment to throw.
      const spread = NET.spread.tight + NET.spread.swing * (0.5 + 0.5 * Math.sin(cast.clock * NET.spread.breathing)) + cast.scatter * NET.scatter.boost;
      freeSprats().forEach((sprat, index) => {
        const angle = sprat.angle + cast.clock * sprat.spin, position = sprat.sprite.root.position;
        const x = centre.x + Math.cos(angle) * sprat.orbit * spread, y = centre.y + Math.sin(angle) * sprat.orbit * spread * 0.8;
        if (Math.abs(x - position.x) > 0.5 * dt) sprat.sprite.face(x - position.x);
        position.set(x, y, DEPTH.fish + index * 0.01); // a tiny stagger in depth stops overlapping sprats from flickering
      });
    }

    return {
      start() {
        const size = schoolSize(game.hour(), stats.get('school')), throws = stats.get('throws');
        cast = { schoolSize: size, throws, throwsLeft: throws, caught: 0, clock: math.rand(0, 5), secondsLeft: NET.seconds, scatter: 0, isDrawing: false, isHauling: false, isOver: false, rope: Kit.touch.stroke({ minStep: NET.minStep, maxLength: stats.get('rope') }) };
        sprats.forEach((sprat, index) => {
          sprat.isFree = index < size;
          sprat.angle = (index / size) * TAU + math.rand(0, 0.5);
          sprat.orbit = math.rand(0.45, 1);
          sprat.spin = math.rand(0.7, 1.4) * (index % 2 ? 1 : -1); // neighbours circle opposite ways
          sprat.sprite.show(sprat.isFree);
        });
        drawRope([]);
        hud.tip('Draw a loop around the sprats when they bunch up');
      },
      stop() {
        sprats.forEach((sprat) => sprat.sprite.show(false));
        ropeDots.count = 0;
      },
      probe: () => cast && { fish: freeSprats().map((sprat) => game.world.toScreen(sprat.sprite.root.position)), left: cast.throwsLeft, caught: cast.caught },
      drag(event) {
        if (cast.isOver || cast.isHauling || cast.throwsLeft <= 0) return;
        if (event.phase === 'start') {
          cast.rope.reset();
          cast.isDrawing = true;
          hud.tip('');
        }
        if (!cast.isDrawing) return;
        if (event.phase === 'end') return pullShut();
        if (!cast.rope.add(theatre.pointer())) return;
        const count = cast.rope.points.length;
        if (count % 3 === 0) sound.note(330 + 30 * (count % 12), { dur: 0.04, vol: 0.05, type: 'triangle' }); // a soft ratchet as rope pays out
        drawRope(cast.rope.points);
        if (cast.rope.isSpent()) pullShut();
      },
      update(dt) {
        if (cast.isOver) return;
        cast.clock += dt;
        cast.secondsLeft -= dt;
        cast.scatter = Math.max(0, cast.scatter - dt * NET.scatter.decay);
        swimSchool(dt);
        hud.meters.catch.label(`Net ${cast.caught}/${cast.schoolSize}`);
        hud.meters.catch.set(cast.caught / cast.schoolSize);
        hud.meters.line.label(cast.isDrawing ? 'Rope' : 'Throws ' + cast.throwsLeft);
        hud.meters.line.set(cast.isDrawing ? cast.rope.remaining() : cast.throwsLeft / cast.throws);
        if (cast.secondsLeft <= 0 && !cast.isDrawing) finish();
      },
    };
  }

  /**
   * Glow Lantern: steer a light through dark water. Glowfry that see it follow in a chain; the prowling snapper
   * scatters the chain from wherever it bites. Lead as many home as the air lasts.
   * @param {ModeParts} parts
   * @returns {TackleMode}
   */
  function createLanternMode({ game, theatre, outcome }) {
    const { ctx, hud, sound, stats } = game;
    const { THREE, make, fx, math } = ctx;
    const trueWhite = new THREE.Color(1, 1, 1); // glowing things ignore the night tint
    const fry = Array.from({ length: MAX_SCHOOL }, () => {
      const sprite = theatre.sprite(ART.glowfry, { tint: trueWhite }).show(false);
      make.glow(COLOR.glow, 1.1, { parent: sprite.root, depthTest: false, opacity: 0.6 });
      return { sprite, home: { x: 0, y: 0 }, phase: math.rand(TAU), scaredFor: 0 };
    });
    const lamp = theatre.sprite(ART.lantern, { tint: trueWhite }).show(false);
    const halo = make.glow(COLOR.lampGlow, 4.4, { parent: lamp.root, depthTest: false, opacity: 0.5 });
    const snapper = theatre.sprite(ART.snapper).show(false);
    /** The dive in progress; replaced by start(). */
    let dive = null;

    const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const sendHome = (one) => Object.assign(one.home, theatre.toPanel({ x: math.rand(-1, 1), y: math.rand(-1, 0.6) }));

    function steerLamp(dt) {
      const position = lamp.root.position;
      if (ctx.input.pointer.down) {
        hud.tip('');
        const finger = theatre.pointer();
        const goal = { x: finger.x, y: finger.y + theatre.extents.lift * LANTERN.liftShare }; // float above the thumb
        const gap = distanceBetween(goal, position);
        const stride = Math.min(gap, LANTERN.lampSpeed * dt);
        if (gap > 0.02) position.set(position.x + ((goal.x - position.x) / gap) * stride, position.y + ((goal.y - position.y) / gap) * stride, DEPTH.lamp);
      }
      lamp.pivot.rotation.z = Math.sin(dive.clock * 3) * 0.08;
      halo.scale.setScalar(4.4 + Math.sin(dive.clock * 5) * 0.25);
    }

    function prowl(dt) {
      const at = theatre.toPanel(LANTERN.prowl(dive.clock * LANTERN.prowlPace + 2)), position = snapper.root.position;
      if (Math.abs(at.x - position.x) > 0.5 * dt) snapper.face(at.x - position.x);
      position.set(at.x, at.y, DEPTH.fish + 0.1);
    }

    /** Loose fry drift around their homes; one that sees the lamp joins the end of the chain. */
    function driftLoose(dt) {
      const lampAt = lamp.root.position;
      dive.school.filter((one) => !dive.chain.includes(one)).forEach((one) => {
        const position = one.sprite.root.position;
        one.scaredFor -= dt;
        const pull = 1 - Math.exp(-(one.scaredFor > 0 ? 5 : 2.5) * dt); // scared fry hurry home
        position.x += (one.home.x + Math.sin(dive.clock * 1.3 + one.phase) * 0.45 - position.x) * pull;
        position.y += (one.home.y + Math.cos(dive.clock * 1.7 + one.phase) * 0.3 - position.y) * pull;
        if (one.scaredFor > 0 || distanceBetween(position, lampAt) >= LANTERN.lureRadius) return;
        dive.chain.push(one);
        sound.note(NOTES[Math.min(NOTES.length - 1, dive.chain.length - 1)], { dur: 0.3, vol: 0.12 }); // each new follower sings a step higher
        theatre.sparkle(position, 6, [COLOR.glow, COLOR.white], { gravity: 0 });
      });
    }

    /** Each fry in the chain trails the one ahead of it (the first trails the lamp) at one link's length. */
    function pullChain(dt) {
      dive.chain.reduce((leader, one) => {
        const position = one.sprite.root.position, gap = distanceBetween(leader, position);
        if (gap > LANTERN.linkLength) {
          const pull = (1 - LANTERN.linkLength / gap) * Math.min(1, 14 * dt);
          if (Math.abs(leader.x - position.x) > 0.05) one.sprite.face(leader.x - position.x);
          position.x += (leader.x - position.x) * pull;
          position.y += (leader.y - position.y) * pull;
        }
        return position;
      }, lamp.root.position);
    }

    /** The snapper bites the lamp (the whole chain scatters) or a link (everything behind it scatters). */
    function snapAtChain(dt) {
      dive.snapperRest -= dt;
      if (dive.snapperRest > 0 || !dive.chain.length) return;
      const jaws = snapper.root.position;
      const bitten = distanceBetween(jaws, lamp.root.position) < LANTERN.bite.lamp ? 0 : dive.chain.findIndex((one) => distanceBetween(jaws, one.sprite.root.position) < LANTERN.bite.chain);
      if (bitten < 0) return;
      dive.chain.splice(bitten).forEach((one) => {
        one.scaredFor = LANTERN.scareSeconds;
        sendHome(one);
      });
      dive.snapperRest = LANTERN.bite.cooldown;
      sound.note(160, { to: 90, dur: 0.25, type: 'triangle', vol: 0.18 });
      fx.floater('Scattered', jaws, { color: '#ff9a8a' });
      snapper.squash(0.3);
    }

    function surface() {
      dive.isOver = true;
      const led = dive.chain.length;
      if (!led) return outcome.lose('The glowfry drifted off');
      outcome.land({ fish: FISH.byId('glowfry'), count: led, stars: LANTERN.stars(led / dive.school.length) });
    }

    return {
      start() {
        const air = stats.get('air');
        dive = { school: fry.slice(0, Math.min(MAX_SCHOOL, stats.get('fry'))), chain: [], air, airLeft: air, clock: math.rand(0, 9), snapperRest: LANTERN.bite.firstSafeSeconds, isOver: false };
        theatre.setMood(LANTERN.nightTint);
        dive.school.forEach((one) => {
          one.scaredFor = 0;
          sendHome(one);
          one.sprite.root.position.set(one.home.x, one.home.y, DEPTH.fish);
          one.sprite.show(true);
        });
        lamp.show(true).root.position.set(0, theatre.extents.centreY + theatre.extents.rangeY * 0.85, DEPTH.lamp);
        snapper.show(true);
        hud.meters.line.label('Air');
        hud.tip('Drag to steer the lantern. Lead the glowfry, dodge the snapper');
      },
      stop() {
        fry.forEach((one) => one.sprite.show(false));
        lamp.show(false);
        snapper.show(false);
        theatre.setMood(null);
      },
      probe: () => dive && {
        fish: dive.school.filter((one) => !dive.chain.includes(one)).map((one) => game.world.toScreen(one.sprite.root.position)),
        lamp: game.world.toScreen(lamp.root.position),
        count: dive.chain.length,
      },
      update(dt) {
        if (dive.isOver) return;
        dive.clock += dt;
        dive.airLeft -= dt;
        steerLamp(dt);
        prowl(dt);
        driftLoose(dt);
        pullChain(dt);
        snapAtChain(dt);
        hud.meters.catch.label(`Glowfry ${dive.chain.length}/${dive.school.length}`);
        hud.meters.catch.set(dive.chain.length / dive.school.length);
        hud.meters.line.set(dive.airLeft / dive.air);
        if (dive.airLeft <= 0 || dive.chain.length >= dive.school.length) surface();
      },
    };
  }

  /** Strategy table: tackle `mode` -> the factory of the minigame it plays. Add a mode by adding a row. */
  const MODES = { trace: createTraceMode, net: createNetMode, lantern: createLanternMode };

  /**
   * The fishing activity: a state of the game's flow with enter / update / exit (+ tap, drag, probe).
   * Inside, the dock runs its own Kit.fsm: cast -> wait -> bite -> play (in the theatre) -> card, or -> gone.
   * @param {Object} game  The shared game object (see cozy.js).
   * @returns {{ enter: Function, update: Function, exit: Function, tap: Function, drag: Function, probe: Function }}
   */
  Cozy.createFishing = (game) => {
    const { ctx, world, hud, sound, state, wallet, goals } = game;
    const { fx, math } = ctx;
    const theatre = createTheatre(game);
    const spot = Cozy.data.SPOTS.find((each) => each.id === 'fish');
    const outcome = { land: (catchResult) => dock.go('card', catchResult), lose: (text) => dock.go('gone', text) };
    const modes = Object.fromEntries(Object.entries(MODES).map(([name, create]) => [name, create({ game, theatre, outcome })]));
    const modeName = () => game.gearRow().mode;
    const usesRod = () => modeName() === 'trace';
    /** The cast: where the bobber flies from and to, how far along it is (0..1) and how deep a nibble pulls it. */
    const bobber = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, flight: 0, dip: 0 };
    let activeMode = null, biteAt = 0, untilNibble = 0;
    const ripple = (size) => fx.ring(bobber.to, { size, color: COLOR.white, life: 0.5 });

    /** Put a catch in the basket, pay any clean-catch bonus, and show its card. */
    function showCatch({ fish, count, stars }) {
      const { isNew, isBest } = game.recordCatch(fish, count, stars);
      const bonus = (stars - 1) * TRACE.cleanBonus * fish.tier;
      const item = { kind: 'fish', id: fish.id, stars };
      state.basket.push(...Array.from({ length: count }, () => ({ ...item })));
      if (bonus) wallet.add(bonus);
      hud.card.show({
        art: ART[fish.id],
        kicker: isNew ? 'New species' : isBest ? 'Your best yet' : `Tier ${fish.tier}${fish.style ? ' - ' + fish.style : ''}`,
        title: fish.name + (count > 1 ? ' x' + count : ''),
        stars,
        lines: [`Worth ${count * itemValue(item, state.order)} at the stall`, bonus ? `Clean catch bonus +${bonus}` : ''].filter(Boolean),
      });
      sound.chime(isNew ? [2, 4, 5, 7] : [2, 4, 5]);
      hud.tip('');
      game.save(hud.basket);
      goals.track('catch', 1, { fish, stars, isNew });
    }

    const dock = Kit.fsm({
      off: {},
      cast: {
        enter() {
          bobber.flight = 0;
          world.hero.stop(0).hop(0.25, 0.3);
          const hand = world.hero.root.position;
          Object.assign(bobber.from, { x: hand.x, y: hand.y + 1, z: hand.z });
          Object.assign(bobber.to, { x: DOCK.x + math.rand(-0.7, 0.7), y: 0.1, z: DOCK.endZ + math.rand(1.2, 1.9) });
          world.bobber.show(true);
          ctx.sfx.noise({ dur: 0.25, vol: 0.06, freq: 1400, type: 'bandpass' }); // the swish of the cast
          hud.bar([{ label: 'Reel in', run: game.toVillage }]);
        },
        update(dt, seconds) {
          const hadLanded = bobber.flight >= 1;
          bobber.flight = Math.min(1, seconds / DOCK_TIMING.castSeconds);
          if (!hadLanded && bobber.flight >= 1) {
            sound.plop();
            ripple(1.2);
          }
          if (seconds > (usesRod() ? DOCK_TIMING.castSeconds : DOCK_TIMING.schoolDelay)) dock.go(usesRod() ? 'wait' : 'play');
        },
      },
      wait: {
        /** @param {string} [missedText]  Set when a bite just got away: say so, and make the next one come sooner. */
        enter(missedText) {
          biteAt = math.rand(...(missedText ? DOCK_TIMING.nextBite : DOCK_TIMING.firstBite));
          untilNibble = math.rand(...DOCK_TIMING.nibbleEvery);
          hud.tip(missedText || 'Wait for a bite...');
        },
        update(dt, seconds) {
          untilNibble -= dt;
          if (untilNibble <= 0 && biteAt - seconds > 0.4) { // no teasing nibble right before the real bite
            untilNibble = math.rand(...DOCK_TIMING.nibbleEvery);
            bobber.dip = 0.1;
            ripple(0.7);
            sound.note(700, { dur: 0.05, vol: 0.06 });
          }
          if (seconds >= biteAt) dock.go('bite');
        },
      },
      bite: {
        enter() {
          bobber.dip = 0.35;
          ripple(1.8);
          sound.plop(1.3);
          sound.chime([4, 7], { dur: 0.16 });
          fx.floater('!', { x: bobber.to.x, y: 1, z: bobber.to.z }, { size: 46, color: '#fffaf0' });
          hud.tip('A bite! Tap now');
        },
        update(dt, seconds) {
          world.bobber.root.position.x += Math.sin(seconds * 50) * 0.03; // the bobber shivers
          if (seconds > DOCK_TIMING.hookWindow) dock.go('wait', 'It slipped off. Wait for the next...');
        },
      },
      play: {
        enter() {
          theatre.open(true);
          fx.flash('#cfefff', 280, 0.7); // the plunge under the surface
          sound.plop(1.2);
          hud.meters.show(true);
          hud.bar([]);
          activeMode = modes[modeName()];
          activeMode.start();
        },
        update: (dt) => activeMode.update(dt),
        exit: () => activeMode.stop(),
      },
      card: { enter: showCatch, exit: () => hud.card.hide() },
      gone: {
        enter(text) {
          hud.tip(text);
          sound.note(330, { to: 196, dur: 0.4, type: 'triangle' });
        },
        update(dt, seconds) {
          if (seconds > DOCK_TIMING.missedSeconds) game.toVillage();
        },
      },
    }, 'off');

    /** Fly the bobber along an arc to the water, then let it bob and dip. */
    function placeBobber(dt, seconds) {
      bobber.dip = math.damp(bobber.dip, 0, 6, dt);
      const hasLanded = bobber.flight >= 1;
      const arc = Math.sin(bobber.flight * Math.PI) * 1.6, bob = hasLanded ? Math.sin(seconds * 3) * 0.03 - bobber.dip : 0;
      world.bobber.root.position.set(
        lerp(bobber.from.x, bobber.to.x, bobber.flight),
        lerp(bobber.from.y, bobber.to.y, bobber.flight) + arc + bob,
        lerp(bobber.from.z, bobber.to.z, bobber.flight)
      );
    }

    return {
      probe: () => ({ phase: dock.state, ...(dock.is('play') ? activeMode.probe() : {}) }),
      enter() {
        world.frame(...spot.view.focus, spot.view.width);
        const problem = game.castProblem(); // for example the lantern by day, or a rod too light for the water
        dock.go(problem ? 'gone' : 'cast', problem || undefined);
      },
      update(dt, seconds) {
        placeBobber(dt, seconds);
        dock.update(dt);
        theatre.update(dt, ctx.time);
      },
      tap() {
        if (dock.is('bite')) return dock.go('play');
        if (dock.is('card') && dock.time > DOCK_TIMING.cardGuard) return game.toVillage();
        if (!dock.is('wait')) return;
        ripple(0.5);
        hud.tip('Not yet... wait for the plunge');
      },
      drag(event) {
        if (dock.is('play') && activeMode.drag) activeMode.drag(event);
      },
      exit() {
        dock.go('off');
        theatre.open(false);
        world.bobber.show(false);
        hud.meters.show(false);
      },
    };
  };
})();
