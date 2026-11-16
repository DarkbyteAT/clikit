/**
 * Kit body gallery: the `bodies` screen (`Kit.play('bodies')`). Six cells, each a different thing made by the
 * same code: a biped, a winged variant, a quadruped, a fish, a sword on its own, and a stream of individuals
 * rolled from a species table. The biped's right arm reaches for a moving target by inverse kinematics and the
 * quadruped's tail follows a simulated chain, so the kinematics and dynamics rungs can be seen working.
 *
 * Owns:  the screen: its layout, what each cell shows, and the two demonstrations.
 * Does not own: anything it shows. Plans, parts and species are kit/body-samples.js; posing is `Kit.rig`,
 *        `Kit.reach` and `Kit.dynamics`; drawing is `Kit.body.debug`. It is a debug view, not a renderer.
 *
 * It is registered like a game (near the end of the menu), so the shell gives it a HUD, a back button and
 * clean-up, and the smoke and play tools reach it like any other.
 */
(() => {
  if (!Kit.ui || !Kit.ui.html) return;
  const { html, css } = Kit.ui;

  const BACKDROP_COLOR = 0x141a2c;
  /** The grid of cells; a body is scaled to fill `heightShare` of its cell's height or `widthShare` of its width each side of centre, whichever is tighter. */
  const LAYOUT = Object.freeze({ columns: 2, rows: 3, heightShare: 0.56, widthShare: 0.4, groundShare: 0.88, labelSize: 10.5, labelGap: 14, labelInset: 8 });
  const COLORS = Object.freeze({ label: '#c9d3ea', dim: '#7f8db0', ground: '#2a3554', target: '#ffd166', chain: '#5ad1a0' });
  /** Radians per second each body turns, so the 3D skeleton reads as 3D through a 2D projection. */
  const TURN_RATE = 0.5;
  /** The reach target circles in front of the biped's right shoulder: centre and radii in metres, turns per second. */
  const REACH_TARGET = Object.freeze({ x: -0.35, y: 1.25, z: 0.3, radiusX: 0.3, radiusY: 0.35, rate: 0.35 });
  /** The quadruped sways and bobs so its tail has something to follow: radians of yaw, sways per second, metres of bob. */
  const SWAY = Object.freeze({ angle: 0.5, rate: 0.9, bob: 0.08 });
  /** Fixed view angles (radians about +Y) for the two demonstrations, which are easier to read when they do not turn. */
  const DEMO_TURN = Object.freeze({ human: -0.5, hound: 1 });
  const TAIL_CHAIN = Object.freeze({ stiffness: 14, drag: 2.5 });
  /** A new individual is rolled this often, seconds. */
  const ROLL_EVERY = 1.6;
  const TABLE_SEED = 20261116;
  const MARK_RADIUS = 5;
  /** A body is never treated as smaller than this (metres) when a cell is scaled to it. */
  const SMALLEST_SPAN = 0.2;
  const FULL_TURN = Math.PI * 2;
  const { VECTOR_STRIDE } = Kit.rig;

  css(`
    .bodies { align-self: stretch; flex: 1 1 0; min-height: 0; position: relative; }
    .bodies canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  `);

  /** Builds the fixed cast: one bake per cell, each with its own pose and world buffers. */
  const createCast = () => {
    const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
    const bakery = catalog.bakery();
    const actor = (title, bake) => {
      const { plan } = bake;
      const masses = new Float32Array(plan.boneCount);
      const pose = Kit.body.createPose(plan);
      const world = Kit.body.worldTransforms(plan, bake.rest, Kit.body.createPose(plan));
      // How tall and how wide the body is at rest, so each cell can be scaled to what it shows (a fish is not a giant).
      const point = new Float32Array(VECTOR_STRIDE);
      let height = 0;
      let reach = 0;
      for (let bone = 0; bone < plan.boneCount; bone++) {
        Kit.body.tailPosition(plan, world, bone, point);
        height = Math.max(height, point[1], world.translation[bone * VECTOR_STRIDE + 1]);
        reach = Math.max(reach, Math.hypot(point[0], point[2]), Math.hypot(world.translation[bone * VECTOR_STRIDE], world.translation[bone * VECTOR_STRIDE + 2]));
      }
      return {
        title,
        bake,
        pose,
        world,
        height,
        reach,
        note: `${plan.boneCount} bones, ${Kit.body.boneMasses(plan, world, masses).toFixed(1)} kg`,
        abilities: Kit.body.capabilityNames(plan.capabilities).join(' '),
      };
    };
    const swordPlan = catalog.parts.sword.plan;
    const cast = [
      actor('human: arm reaches by IK', bakery.bakeRecipe({ species: 'human', seed: 11, overrides: { 'fill:handRight': 'sword', 'fill:handRight/gem': 'ruby', 'fill:headTop': 'hat' } })),
      actor('seraph: wings are a part', bakery.bakeRecipe({ species: 'seraph', seed: 5 })),
      actor('hound: tail is a chain', bakery.bakeRecipe({ species: 'hound', seed: 3, overrides: { 'fill:mouth': 'sword' } })),
      actor('carp: no limbs at all', bakery.bakeRecipe({ species: 'carp', seed: 8 })),
      actor('sword: a part alone', { plan: swordPlan, rest: Kit.body.createPose(swordPlan) }),
    ];
    return {
      catalog,
      bakery,
      cast,
      table: catalog.table([{ species: 'human', weight: 3 }, { species: 'elf', weight: 2 }, { species: 'seraph' }, { species: 'hound', weight: 2 }, { species: 'carp', weight: 2 }]),
      actor,
    };
  };

  Kit.register({
    id: 'bodies',
    name: 'Bodies',
    tagline: 'One body system, many shapes',
    hook: 'Plans, parts, IK and chains as stick figures',
    color: '#8fa3c8',
    order: 998,
    theme: { skin: 'glass' },
    create(ctx) {
      ctx.scene.background = ctx.make.color(BACKDROP_COLOR);
      let canvas = null;
      ctx.ui.mount(html`<div class="bodies"><canvas ref=${(element) => (canvas = element)} aria-label="Body plans drawn as stick figures"></canvas></div>`);
      const { catalog, bakery, cast, table, actor } = createCast();
      const [human, , hound] = cast;
      const arm = ['upperArmRight', 'forearmRight', 'handRight'].map((name) => human.bake.plan.boneIndex(name));
      const tailBones = Kit.body.chains(hound.bake.plan, Kit.body.roleMask(['tail']))[0];
      const tailBase = tailBones[0] * VECTOR_STRIDE;
      const tail = Kit.dynamics.chain({ count: tailBones.length, lengths: 0.2, ...TAIL_CHAIN });
      const target = new Float32Array(VECTOR_STRIDE);
      const view = { centerX: 0, groundY: 0, scale: 1, turn: 0 };
      const mark = new Float32Array(2);
      let rolled = actor('', bakery.bakeRecipe(table.roll(TABLE_SEED, 0)));
      let rollIndex = 0;
      let isTailPlaced = false;

      /** The biped: rest pose, then the right arm solved towards the circling target. */
      const poseHuman = (time) => {
        const { plan, rest } = human.bake;
        Kit.rig.copy(rest, human.pose);
        Kit.body.worldTransforms(plan, human.pose, human.world);
        const angle = time * REACH_TARGET.rate * FULL_TURN;
        target[0] = REACH_TARGET.x + Math.cos(angle) * REACH_TARGET.radiusX;
        target[1] = REACH_TARGET.y + Math.sin(angle) * REACH_TARGET.radiusY;
        target[2] = REACH_TARGET.z;
        // The elbow bends towards a point behind and below the shoulder.
        Kit.reach.twoBone(plan.parent, human.pose, human.world, arm[0], arm[1], arm[2], target[0], target[1], target[2], target[0], target[1] - 1, target[2] - 1, plan.jointLimits);
        Kit.body.worldTransforms(plan, human.pose, human.world);
      };

      /** The quadruped: it sways, a point chain trails from the base of its tail, and the tail bones follow the chain. */
      const poseHound = (dt, time) => {
        const { plan, rest } = hound.bake;
        Kit.rig.copy(rest, hound.pose);
        const sway = Math.sin(time * SWAY.rate * FULL_TURN) * SWAY.angle;
        const bob = Math.abs(Math.sin(time * SWAY.rate * FULL_TURN)) * SWAY.bob;
        Kit.body.worldTransforms(plan, hound.pose, hound.world, 0, bob, 0, sway);
        const base = hound.world.translation;
        // The chain should leave the body the way the body's back end points: straight behind it, turned with the sway.
        const behindX = -Math.sin(sway);
        const behindZ = -Math.cos(sway);
        if (!isTailPlaced) Kit.dynamics.placeChain(tail, base[tailBase], base[tailBase + 1], base[tailBase + 2], behindX, 0, behindZ);
        isTailPlaced = true;
        Kit.dynamics.stepChain(tail, dt, base[tailBase], base[tailBase + 1], base[tailBase + 2], behindX, 0, behindZ);
        Kit.reach.follow(plan.parent, hound.pose, hound.world, tailBones, tail.positions, plan.jointLimits);
        Kit.body.worldTransforms(plan, hound.pose, hound.world, 0, bob, 0, sway);
      };

      const drawLabel = (context, text, x, y, color) => {
        context.fillStyle = color;
        context.fillText(text, x, y);
      };

      const drawCell = (context, member, column, row, cellWidth, cellHeight, turn, pixelRatio) => {
        view.scale = Math.min((cellHeight * LAYOUT.heightShare) / Math.max(member.height, SMALLEST_SPAN), (cellWidth * LAYOUT.widthShare) / Math.max(member.reach, SMALLEST_SPAN));
        view.centerX = (column + 0.5) * cellWidth;
        view.groundY = (row + LAYOUT.groundShare) * cellHeight;
        view.turn = turn;
        context.strokeStyle = COLORS.ground;
        context.lineWidth = pixelRatio;
        context.beginPath();
        context.moveTo(column * cellWidth + LAYOUT.labelInset * pixelRatio, view.groundY);
        context.lineTo((column + 1) * cellWidth - LAYOUT.labelInset * pixelRatio, view.groundY);
        context.stroke();
        Kit.body.debug.draw(context, member.bake.plan, member.world, view);
        const left = column * cellWidth + LAYOUT.labelInset * pixelRatio;
        const top = row * cellHeight + LAYOUT.labelGap * pixelRatio;
        drawLabel(context, member.title, left, top, COLORS.label);
        drawLabel(context, member.note, left, top + LAYOUT.labelGap * pixelRatio, COLORS.dim);
        drawLabel(context, member.abilities, left, top + 2 * LAYOUT.labelGap * pixelRatio, COLORS.dim);
      };

      /** A small ring at a world point of the cell being drawn. */
      const drawMark = (context, x, y, z, color, pixelRatio) => {
        Kit.body.debug.project(x, y, z, view, mark);
        context.strokeStyle = color;
        context.lineWidth = 2 * pixelRatio;
        context.beginPath();
        context.arc(mark[0], mark[1], MARK_RADIUS * pixelRatio, 0, FULL_TURN);
        context.stroke();
      };

      return {
        update(dt, time) {
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
          const cellWidth = width / LAYOUT.columns;
          const cellHeight = height / LAYOUT.rows;
          const turn = time * TURN_RATE;

          poseHuman(time);
          poseHound(dt, time);
          if (Math.floor(time / ROLL_EVERY) !== rollIndex) {
            rollIndex = Math.floor(time / ROLL_EVERY);
            const recipe = table.roll(TABLE_SEED, rollIndex);
            rolled = actor(`rolled: ${recipe.species} #${rollIndex}`, bakery.bakeRecipe(recipe));
          }
          if (!rolled.title) rolled.title = `rolled: ${rolled.bake.species} #0`;

          [...cast, rolled].forEach((member, index) => {
            const column = index % LAYOUT.columns;
            const row = Math.floor(index / LAYOUT.columns);
            // The two demonstrations are easier to read from a fixed angle; everything else turns.
            const cellTurn = member === human ? DEMO_TURN.human : member === hound ? DEMO_TURN.hound : turn;
            drawCell(context, member, column, row, cellWidth, cellHeight, cellTurn, pixelRatio);
            if (member === human) drawMark(context, target[0], target[1], target[2], COLORS.target, pixelRatio);
            if (member === hound)
              for (let point = 0; point < tail.count; point++)
                drawMark(context, tail.positions[point * VECTOR_STRIDE], tail.positions[point * VECTOR_STRIDE + 1], tail.positions[point * VECTOR_STRIDE + 2], COLORS.chain, pixelRatio / 2);
          });
        },
        debugState: () => ({ cells: cast.length + 1, bakes: bakery.stats().bakes, rolled: rolled.bake.species, species: catalog.speciesIds().length }),
      };
    },
  });
})();
