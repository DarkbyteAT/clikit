/**
 * Kit gait gallery: the `gaits` screen (`Kit.play('gaits')`). Four bodies made by the body system - a biped, a
 * winged biped, a quadruped and a fish - each steered along its own course of starting, speeding up, turning
 * and stopping, all moved by ONE controller (`when` the plan has legs, walk; otherwise swim). The camera
 * follows and turns with each body, so a foot that stays on its footprint is a foot that does not slide.
 *
 * Owns:  the screen: its layout, the courses, the camera, and the marks (footprints, a ring under each planted
 *        foot, the centre of mass and where it falls on the ground), with one button to show or hide the marks
 *        and one to look at a single body.
 * Does not own: anything it shows. Bodies are kit/body-samples.js; movement is kit/motion.js, kit/gait.js and
 *        kit/swim.js; drawing is `Kit.body.debug`. It is a debug view, not a renderer.
 *
 * It is registered like a game, so the shell gives it a HUD, a back button and clean-up, and the smoke and
 * play tools reach it like any other. Its `debugState` reports the furthest any planted foot has slid, measured
 * in the page.
 */
(() => {
  if (!Kit.ui || !Kit.ui.html) return;
  const { html, css } = Kit.ui;

  const BACKDROP_COLOR = 0x10172a;
  /** The grid of cells and what fills them. Sizes in CSS pixels unless noted. */
  const LAYOUT = Object.freeze({ columns: 2, rows: 2, groundShare: 0.8, heightShare: 0.6, widthShare: 0.42, headroom: 1.35, labelSize: 10.5, labelGap: 14, labelInset: 8 });
  const COLORS = Object.freeze({ label: '#c9d3ea', dim: '#7f8db0', ground: '#2a3554', tick: '#3c4a72', footprint: '#6d5f33', planted: '#ffd166', center: '#5ad1a0' });
  /** The camera: turned to look at the body from its side and a little ahead, tilted down so the ground plane opens up. Radians. */
  const CAMERA = Object.freeze({ turn: -1.1, tilt: 0.32 });
  /** Ground ticks every this many metres, this many each side of the body. */
  const TICKS = Object.freeze({ every: 0.5, each: 6, length: 5 });
  const MARKS = Object.freeze({ footprints: 10, footprintRadius: 3, plantedRadius: 5, centerSize: 6 });
  /** Courses, by kind of body: `Kit.motion.course` legs (seconds, metres per second, radians per second). */
  const COURSES = Object.freeze({
    walker: [
      { seconds: 4, speed: 1.4 },
      { seconds: 2.5, speed: 1.4, turn: 0.9 },
      { seconds: 3, speed: 3.6 },
      { seconds: 2, speed: 1.2, turn: -0.9 },
      { seconds: 2.5, speed: 0 },
    ],
    trotter: [
      { seconds: 4, speed: 1 },
      { seconds: 2.5, speed: 1, turn: 0.9 },
      { seconds: 3, speed: 3 },
      { seconds: 2, speed: 1, turn: -0.9 },
      { seconds: 2.5, speed: 0 },
    ],
    swimmer: [
      { seconds: 3, speed: 0.9 },
      { seconds: 2.5, speed: 0.9, turn: 1.2 },
      { seconds: 2, speed: 1.8 },
      { seconds: 2, speed: 0.6, turn: -1.2 },
      { seconds: 2, speed: 0 },
    ],
  });
  /** The cast: the title of each cell, the recipe it wears and the course it follows. */
  const CAST = Object.freeze([
    { title: 'human', recipe: { species: 'human', seed: 11 }, course: 'walker' },
    { title: 'seraph: wings trail', recipe: { species: 'seraph', seed: 5 }, course: 'walker' },
    { title: 'hound', recipe: { species: 'hound', seed: 3 }, course: 'trotter' },
    { title: 'carp: no legs, so it swims', recipe: { species: 'carp', seed: 8 }, course: 'swimmer' },
  ]);
  const FOCUS_ALL = -1;
  const FULL_TURN = Math.PI * 2;
  const { VECTOR_STRIDE } = Kit.rig;

  css(`
    .gaits { align-self: stretch; flex: 1 1 0; min-height: 0; position: relative; }
    .gaits canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  `);

  /** Builds one member of the cast: its bake, its motion state, its course and the records the marks are drawn from. */
  const createMember = (bakery, controller, row) => {
    const bake = bakery.bakeRecipe(row.recipe);
    const motion = Kit.motion.state(bake, controller);
    const legCount = Kit.body.fits(bake.plan, Kit.gait.WALK_NEEDS) ? Kit.gait.legs(bake.plan, bake.rest).count : 0;
    // How tall the body stands and how far it reaches from its ground point, so each cell is scaled to what it shows.
    let height = 0;
    let reach = 0;
    for (let bone = 0; bone < bake.plan.boneCount; bone++) {
      const at = bone * VECTOR_STRIDE;
      height = Math.max(height, motion.world.translation[at + 1]);
      reach = Math.max(reach, Math.hypot(motion.world.translation[at], motion.world.translation[at + 2]));
    }
    return {
      title: row.title,
      bake,
      motion,
      route: Kit.motion.course(COURSES[row.course]),
      height,
      reach,
      legCount,
      // A ring of recent footprints (x, z pairs), written in place.
      footprints: new Float32Array(MARKS.footprints * 2),
      footprintCount: 0,
      seenPlants: new Uint32Array(legCount),
      // Where each planted foot's contact point was when it landed, to measure sliding in the page.
      contactStart: new Float32Array(legCount * VECTOR_STRIDE),
      worstSlide: 0,
    };
  };

  Kit.register({
    id: 'gaits',
    kind: 'workbench',
    name: 'Gaits',
    tagline: 'One controller, four bodies',
    hook: 'Walking, trotting and swimming from physics',
    color: '#5ad1a0',
    order: 999,
    theme: { skin: 'glass' },
    create(ctx) {
      ctx.scene.background = ctx.make.color(BACKDROP_COLOR);
      let canvas = null;
      ctx.ui.mount(html`<div class="gaits"><canvas ref=${(element) => (canvas = element)} aria-label="Bodies walking and swimming, drawn as stick figures"></canvas></div>`);
      const bakery = Kit.body.catalog(Kit.body.samples.CATALOG).bakery();
      // The whole point: one composition moves every body. Legs walk; a body without them swims.
      const controller = Kit.motion.when({ atLeast: { legs: 2 } }, Kit.gait.walk(), Kit.swim.swim());
      const cast = CAST.map((row) => createMember(bakery, controller, row));
      const view = { centerX: 0, groundY: 0, scale: 1, turn: CAMERA.turn, tilt: CAMERA.tilt };
      const point = new Float32Array(2);
      const tip = new Float32Array(VECTOR_STRIDE);
      const balance = { planted: 0, centerX: 0, centerY: 0, centerZ: 0, forwardOutside: 0, sideOutside: 0 };
      let showMarks = true;
      let focus = FOCUS_ALL;
      const bar = ctx.ui.actions([
        { id: 'marks', label: 'Marks', sub: 'on', onClick: () => bar.set('marks', { sub: (showMarks = !showMarks) ? 'on' : 'off' }) },
        {
          id: 'focus',
          label: 'Focus',
          sub: 'all',
          onClick: () => bar.set('focus', { sub: (focus = focus + 1 < cast.length ? focus + 1 : FOCUS_ALL) === FOCUS_ALL ? 'all' : cast[focus].title.split(':')[0] }),
        },
      ]);

      /** Moves a member along its course, then records its new footprints and how far its planted feet have slid. */
      const advanceMember = (member, dt) => {
        const { motion, route, bake } = member;
        Kit.motion.drive(route, dt);
        Kit.motion.advance(motion, dt, route.x, 0, route.z, route.heading);
        const feet = Kit.gait.feet(motion);
        if (!feet) return;
        const rig = Kit.gait.legs(bake.plan, bake.rest);
        for (let leg = 0; leg < member.legCount; leg++) {
          if (!feet.planted[leg]) continue;
          Kit.body.tailPosition(bake.plan, motion.world, rig.end[leg], tip);
          const startAt = leg * VECTOR_STRIDE;
          if (feet.plantCount[leg] !== member.seenPlants[leg]) {
            member.seenPlants[leg] = feet.plantCount[leg];
            const slot = (member.footprintCount++ % MARKS.footprints) * 2;
            member.footprints[slot] = feet.footX[leg];
            member.footprints[slot + 1] = feet.footZ[leg];
            member.contactStart.set(tip, startAt);
          } else if (feet.plantCount[leg] > 0) {
            member.worstSlide = Math.max(member.worstSlide, Math.hypot(tip[0] - member.contactStart[startAt], tip[1] - member.contactStart[startAt + 1], tip[2] - member.contactStart[startAt + 2]));
          }
        }
      };

      const ring = (context, x, z, radius, color, pixelRatio) => {
        Kit.body.debug.project(x, 0, z, view, point);
        context.strokeStyle = color;
        context.lineWidth = 1.5 * pixelRatio;
        context.beginPath();
        context.arc(point[0], point[1], radius * pixelRatio, 0, FULL_TURN);
        context.stroke();
      };

      const stroke = (context, fromX, fromY, toX, toY, color, width) => {
        context.strokeStyle = color;
        context.lineWidth = width;
        context.beginPath();
        context.moveTo(fromX, fromY);
        context.lineTo(toX, toY);
        context.stroke();
      };

      /** The marks of one member: old footprints, a ring under each planted foot, the centre of mass and its drop to the ground. */
      const drawMarks = (context, member, pixelRatio) => {
        const { motion } = member;
        const feet = Kit.gait.feet(motion);
        if (!feet) return;
        for (let print = 0; print < Math.min(member.footprintCount, MARKS.footprints); print++)
          ring(context, member.footprints[print * 2], member.footprints[print * 2 + 1], MARKS.footprintRadius, COLORS.footprint, pixelRatio);
        for (let leg = 0; leg < member.legCount; leg++) if (feet.planted[leg]) ring(context, feet.footX[leg], feet.footZ[leg], MARKS.plantedRadius, COLORS.planted, pixelRatio);
        Kit.gait.support(motion, balance);
        Kit.body.debug.project(balance.centerX, balance.centerY, balance.centerZ, view, point);
        const centerX = point[0];
        const centerY = point[1];
        const size = MARKS.centerSize * pixelRatio;
        stroke(context, centerX - size, centerY, centerX + size, centerY, COLORS.center, 2 * pixelRatio);
        stroke(context, centerX, centerY - size, centerX, centerY + size, COLORS.center, 2 * pixelRatio);
        Kit.body.debug.project(balance.centerX, 0, balance.centerZ, view, point);
        stroke(context, centerX, centerY + size, point[0], point[1], COLORS.center, pixelRatio);
        ring(context, balance.centerX, balance.centerZ, MARKS.footprintRadius, COLORS.center, pixelRatio);
      };

      /** One line under the title: what the body is doing, in numbers. */
      const noteOf = (member) => {
        const { motion } = member;
        const clock = motion.memory.gait;
        if (clock) return `${clock.isMoving ? Kit.gait.GAIT_NAMES[clock.gait] : 'standing'}  ${motion.speed.toFixed(1)} m/s  stride ${clock.stride.toFixed(2)} m`;
        const swimming = motion.memory.swim;
        return swimming ? `swimming  ${motion.speed.toFixed(1)} m/s  ${swimming.frequency.toFixed(1)} beats/s` : '';
      };

      const drawCell = (context, member, left, top, cellWidth, cellHeight, pixelRatio) => {
        const { motion } = member;
        view.scale = Math.min((cellHeight * LAYOUT.heightShare) / (member.height * LAYOUT.headroom), (cellWidth * LAYOUT.widthShare) / member.reach);
        // The camera turns with the body, so a stride is always seen from the same side and a turn shows as the footprints curving away.
        view.turn = CAMERA.turn + motion.heading;
        // The camera follows the body: place the view so the body's ground point sits at the cell's ground mark.
        view.centerX = 0;
        view.groundY = 0;
        Kit.body.debug.project(motion.x, 0, motion.z, view, point);
        view.centerX = left + cellWidth / 2 - point[0];
        view.groundY = top + cellHeight * LAYOUT.groundShare - point[1];
        // Ticks along the way the body is going, fixed in the world, so the ground is seen to pass.
        const forwardX = Math.sin(motion.heading);
        const forwardZ = Math.cos(motion.heading);
        const travelled = motion.x * forwardX + motion.z * forwardZ;
        for (let tick = -TICKS.each; tick <= TICKS.each; tick++) {
          const ahead = (Math.round(travelled / TICKS.every) + tick) * TICKS.every - travelled;
          Kit.body.debug.project(motion.x + forwardX * ahead, 0, motion.z + forwardZ * ahead, view, point);
          if (point[0] > left && point[0] < left + cellWidth) stroke(context, point[0], point[1], point[0], point[1] + TICKS.length * pixelRatio, COLORS.tick, pixelRatio);
        }
        if (showMarks) drawMarks(context, member, pixelRatio);
        Kit.body.debug.draw(context, member.bake.plan, motion.world, view, { showSockets: false });
        context.fillStyle = COLORS.label;
        context.fillText(member.title, left + LAYOUT.labelInset * pixelRatio, top + LAYOUT.labelGap * pixelRatio);
        context.fillStyle = COLORS.dim;
        context.fillText(noteOf(member), left + LAYOUT.labelInset * pixelRatio, top + 2 * LAYOUT.labelGap * pixelRatio);
      };

      return {
        update(dt) {
          cast.forEach((member) => advanceMember(member, dt));
          if (!canvas) return;
          const pixelRatio = window.devicePixelRatio || 1;
          const width = Math.round(canvas.clientWidth * pixelRatio);
          const height = Math.round(canvas.clientHeight * pixelRatio);
          if (!width || !height) return;
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          const context = canvas.getContext('2d');
          context.clearRect(0, 0, width, height);
          context.font = `${LAYOUT.labelSize * pixelRatio}px system-ui, sans-serif`;
          context.lineCap = 'round';
          context.save();
          if (focus !== FOCUS_ALL) drawCell(context, cast[focus], 0, 0, width, height, pixelRatio);
          else {
            const cellWidth = width / LAYOUT.columns;
            const cellHeight = height / LAYOUT.rows;
            cast.forEach((member, index) => {
              const left = (index % LAYOUT.columns) * cellWidth;
              const top = Math.floor(index / LAYOUT.columns) * cellHeight;
              // Each cell is clipped, so a long stride or a sword never draws over its neighbour.
              context.save();
              context.beginPath();
              context.rect(left, top, cellWidth, cellHeight);
              context.clip();
              drawCell(context, member, left, top, cellWidth, cellHeight, pixelRatio);
              context.restore();
            });
          }
          context.restore();
        },
        debugState: () => ({
          marks: showMarks,
          focus: focus === FOCUS_ALL ? 'all' : cast[focus].title,
          doing: cast.map((member) => noteOf(member).split('  ')[0]),
          footfalls: cast.map((member) => member.footprintCount),
          worstSlideMillimetres: Math.round(Math.max(...cast.map((member) => member.worstSlide)) * 1000 * 100) / 100,
        }),
      };
    },
  });
})();
