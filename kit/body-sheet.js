/**
 * Kit body sheet: the `wardrobe` screen (`Kit.play('wardrobe')`). Characters rolled from the wardrobe catalogue,
 * drawn in 3D by the figure renderer (`Kit.figure.build`) through the toon look, facing the camera, in a grid;
 * the first is the base person at its default dials. Faces come in through the renderer's `featuresOf` extension
 * point (`Kit.body.figureHooks`). Tap to roll more. It exists to judge the catalogue by eye; it is not the
 * character creator.
 *
 * Owns:  the screen: which characters it shows, the grid and the camera.
 * Does not own: the catalogue (kit/body-wardrobe.js), baking (kit/body-recipe.js), the face adapter
 *        (kit/body-surface.js) or drawing (kit/figure*.js, kit/look-*.js).
 *
 * Registered like a game (after the bodies and figures screens), so the shell gives it a HUD, a back button and
 * clean-up, and the smoke and play tools reach it like any other. It draws its own frame (`render`).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.body.wardrobe || !Kit.figure || !Kit.figure.build) return;
  const { html } = Kit.ui;

  const BACKDROP_COLOR = 0x6a7399;
  const GRID = Object.freeze({ columns: 4, rows: 2, cellWidth: 0.95, cellHeight: 1.45, margin: 0.06 });
  const CHARACTERS = GRID.columns * GRID.rows;
  const CAMERA = Object.freeze({ pitchDegrees: 6, distance: 12, near: 0.1, far: 40 });
  /** Atlas rows: one block of `Kit.figure.RAMP_SLOTS` per figure, with room for a re-roll before the old block is freed. */
  const ATLAS_ROWS = 512;
  const TABLE_SEED = 20261116;
  /** The first character: the base species exactly as drawn (every dial at its default), in plain clothes. */
  const BASE_PERSON = { species: 'person', seed: 1, overrides: { 'fill:hat': null, 'fill:outerwear': null, 'fill:glasses': null, 'fill:back': null, 'fill:handLeft': null, 'fill:handRight': null } };

  Kit.register({
    id: 'wardrobe',
    kind: 'workbench',
    name: 'Wardrobe sheet',
    tagline: 'Rolled characters from the creator catalogue',
    hook: 'The wardrobe catalogue drawn by the figure renderer',
    color: '#c99ad6',
    order: 999,
    theme: { skin: 'glass' },
    create(ctx) {
      const { renderer, size } = ctx;
      const view = Kit.look.view({ renderer, preset: 'toon', atlasRows: ATLAS_ROWS });
      const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
      const bakery = catalog.bakery({ capacity: CHARACTERS * 2 });
      const editor = Kit.body.editor(catalog);
      const table = catalog.table(catalog.speciesIds().map((species) => ({ species })));
      const cache = Kit.figure.geometryCache();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA.near, CAMERA.far);
      /** The base person with every dial at its default value. */
      const basePerson = () => editor.schema(BASE_PERSON).dials.reduce((recipe, dial) => editor.setDial(recipe, dial.id, dial.default), BASE_PERSON);
      let page = 0;
      let cast = [];
      const castFor = (pageIndex) =>
        Array.from({ length: CHARACTERS }, (_unused, index) => {
          const recipe = pageIndex === 0 && index === 0 ? basePerson() : table.roll(TABLE_SEED, pageIndex * CHARACTERS + index);
          const bake = bakery.bakeRecipe(recipe);
          const figure = Kit.figure.build(view, bake, { cache, featuresOf: Kit.body.figureHooks(bake).featuresOf });
          const column = index % GRID.columns;
          const row = Math.floor(index / GRID.columns);
          figure.root.position.x = (column - (GRID.columns - 1) / 2) * GRID.cellWidth;
          figure.root.position.y = (GRID.rows - 1 - row) * GRID.cellHeight;
          return { recipe, bake, figure };
        });
      const show = (pageIndex) => {
        cast.forEach((member) => member.figure.dispose());
        cast = castFor(pageIndex);
      };
      show(page);
      ctx.ui.mount(html`<div style="position:absolute;inset:0" onClick=${() => show((page += 1))} aria-label="Rolled characters; tap to roll more"></div>`);

      const fitCamera = () => {
        const halfWidth = (GRID.columns * GRID.cellWidth) / 2 + GRID.margin;
        const halfHeight = (GRID.rows * GRID.cellHeight) / 2 + GRID.margin;
        const aspect = size.w / size.h;
        const [width, height] = halfWidth / halfHeight > aspect ? [halfWidth, halfWidth / aspect] : [halfHeight * aspect, halfHeight];
        Object.assign(camera, { left: -width, right: width, top: height, bottom: -height });
        camera.updateProjectionMatrix();
        const pitch = (CAMERA.pitchDegrees * Math.PI) / 180;
        const centerY = halfHeight - GRID.margin - GRID.cellHeight * 0.05;
        camera.position.set(0, centerY + Math.sin(pitch) * CAMERA.distance, Math.cos(pitch) * CAMERA.distance);
        camera.lookAt(0, centerY, 0);
      };

      return {
        update() {},
        render() {
          fitCamera();
          // Index loop: per-frame posing of every figure, no allocation.
          for (let index = 0; index < cast.length; index++) {
            cast[index].figure.rest();
            cast[index].figure.pose();
          }
          view.render(camera, { clearColor: BACKDROP_COLOR });
        },
        dispose() {
          cast.forEach((member) => member.figure.dispose());
          view.dispose();
          cache.dispose();
        },
        debugState: () => ({ page, characters: cast.map((member) => `${member.recipe.species}#${member.recipe.seed}`), bakes: bakery.stats().bakes, stats: view.stats() }),
      };
    },
  });
})();
