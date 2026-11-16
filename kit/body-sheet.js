/**
 * Kit body sheet: the `wardrobe` screen (`Kit.play('wardrobe')`). Twelve characters rolled from the wardrobe
 * catalogue, front view, each drawn with `Kit.body.debug.drawSurface` (dialled shapes as outlines, painted
 * regions as tinted spans, features as dots) over its stick figure, with a close-up of the head in the corner of
 * its cell. Tap to roll twelve more. It exists so a person can judge the catalogue's variety by eye before any
 * real renderer exists; it is a debug view, not the character creator.
 *
 * Owns:  the screen: its layout, which twelve characters it shows, and the head inset.
 * Does not own: the catalogue (kit/body-wardrobe.js), baking (kit/body-recipe.js) or drawing (kit/body-debug.js).
 *
 * Registered like a game (after the bodies screen), so the shell gives it a HUD, a back button and clean-up, and
 * the smoke and play tools reach it like any other.
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.body.wardrobe) return;
  const { html, css } = Kit.ui;

  const BACKDROP_COLOR = 0x10141f;
  const LAYOUT = Object.freeze({ columns: 4, rows: 3, heightShare: 0.74, groundShare: 0.93, labelSize: 9.5, labelGap: 12, labelInset: 6, insetShare: 0.42, insetZoom: 3.4 });
  const COLORS = Object.freeze({ label: '#c9d3ea', dim: '#7f8db0', ground: '#273050', inset: '#1a2133', insetEdge: '#33405f', body: '#3a4566' });
  const CHARACTERS = LAYOUT.columns * LAYOUT.rows;
  /** Tallest a character can be with every dial at its top, metres: every cell uses one scale so heights compare. */
  const TALLEST = 2.1;
  const TABLE_SEED = 20261116;
  const { VECTOR_STRIDE } = Kit.rig;

  css(`
    .wardrobe-sheet { align-self: stretch; flex: 1 1 0; min-height: 0; position: relative; }
    .wardrobe-sheet canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: manipulation; }
  `);

  /** The short description under a character: species, then what it wears where it shows most. */
  const describe = (individual) => {
    const shown = ['hair', 'top', 'bottom', 'outerwear', 'hat'].map((socket) => individual.fills[socket]).filter(Boolean);
    return [individual.species, shown.join(' ')];
  };

  Kit.register({
    id: 'wardrobe',
    name: 'Wardrobe sheet',
    tagline: 'Twelve rolled characters',
    hook: 'The creator catalogue as outlines, regions and features',
    color: '#c99ad6',
    order: 999,
    theme: { skin: 'glass' },
    create(ctx) {
      ctx.scene.background = ctx.make.color(BACKDROP_COLOR);
      let canvas = null;
      const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
      const bakery = catalog.bakery({ capacity: CHARACTERS * 2 });
      const table = catalog.table(catalog.speciesIds().map((species) => ({ species })));
      let page = 0;
      /** The twelve characters of a page: bake, posed world and the two text lines. */
      const castFor = (pageIndex) =>
        Array.from({ length: CHARACTERS }, (_unused, index) => {
          const bake = bakery.bakeRecipe(table.roll(TABLE_SEED, pageIndex * CHARACTERS + index));
          const world = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
          return { bake, world, lines: describe(bake.individual) };
        });
      let cast = castFor(page);
      const roll = () => {
        page += 1;
        cast = castFor(page);
      };
      ctx.ui.mount(html`<div class="wardrobe-sheet"><canvas ref=${(element) => (canvas = element)} onClick=${roll} aria-label="Twelve rolled characters; tap to roll more"></canvas></div>`);
      const view = { centerX: 0, groundY: 0, scale: 1, turn: 0 };

      const drawCharacter = (context, member, column, row, cellWidth, cellHeight, pixelRatio) => {
        const left = column * cellWidth;
        const top = row * cellHeight;
        view.scale = (cellHeight * LAYOUT.heightShare) / TALLEST;
        view.centerX = left + cellWidth * 0.32;
        view.groundY = top + cellHeight * LAYOUT.groundShare;
        context.strokeStyle = COLORS.ground;
        context.lineWidth = pixelRatio;
        context.beginPath();
        context.moveTo(left + LAYOUT.labelInset * pixelRatio, view.groundY);
        context.lineTo(left + cellWidth - LAYOUT.labelInset * pixelRatio, view.groundY);
        context.stroke();
        Kit.body.debug.draw(context, member.bake.plan, member.world, view, { boneColor: COLORS.body, showSockets: false });
        Kit.body.debug.drawSurface(context, member.bake, member.world, view);
        // The head close-up: the same drawing, zoomed on the head, clipped to a box in the cell's corner.
        const head = member.bake.plan.boneIndex('head') * VECTOR_STRIDE;
        const insetSize = cellWidth * LAYOUT.insetShare;
        const insetLeft = left + cellWidth - insetSize - LAYOUT.labelInset * pixelRatio;
        const insetTop = top + LAYOUT.labelGap * 2.6 * pixelRatio;
        context.save();
        context.fillStyle = COLORS.inset;
        context.strokeStyle = COLORS.insetEdge;
        context.fillRect(insetLeft, insetTop, insetSize, insetSize);
        context.strokeRect(insetLeft, insetTop, insetSize, insetSize);
        context.beginPath();
        context.rect(insetLeft, insetTop, insetSize, insetSize);
        context.clip();
        const zoomed = { ...view, scale: view.scale * LAYOUT.insetZoom };
        zoomed.centerX = insetLeft + insetSize / 2 - member.world.translation[head] * zoomed.scale;
        zoomed.groundY = insetTop + insetSize * 0.62 + (member.world.translation[head + 1] + 0.1) * zoomed.scale;
        Kit.body.debug.draw(context, member.bake.plan, member.world, zoomed, { boneColor: COLORS.body, showSockets: false });
        Kit.body.debug.drawSurface(context, member.bake, member.world, zoomed);
        context.restore();
        context.fillStyle = COLORS.label;
        context.fillText(member.lines[0], left + LAYOUT.labelInset * pixelRatio, top + LAYOUT.labelGap * pixelRatio);
        context.fillStyle = COLORS.dim;
        context.fillText(member.lines[1], left + LAYOUT.labelInset * pixelRatio, top + LAYOUT.labelGap * 2 * pixelRatio);
      };

      return {
        update() {
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
          context.lineJoin = 'round';
          const cellWidth = width / LAYOUT.columns;
          const cellHeight = height / LAYOUT.rows;
          cast.forEach((member, index) => drawCharacter(context, member, index % LAYOUT.columns, Math.floor(index / LAYOUT.columns), cellWidth, cellHeight, pixelRatio));
        },
        debugState: () => ({ page, characters: cast.length, species: cast.map((member) => member.bake.species), bakes: bakery.stats().bakes }),
      };
    },
  });
})();
