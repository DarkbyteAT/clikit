/**
 * Kit figure: a body bake plus a pose, drawn in 3D through Kit.look. It is the renderer between the body
 * system (data) and the look pipeline (shading): one mesh per piece of kit/figure-layout.js, its geometry from
 * kit/figure-shapes.js shared through a cache, its material from `view.shading.dress`, its colour from the
 * figure's rows of the view's palette atlas, and its matrix written each frame from the pose's world transforms.
 *
 * Owns:  `Kit.figure.geometryCache` (BufferGeometry per shape key, counted and shared), `Kit.figure.build`
 *        (bake -> a figure in a view) and what it returns: `local` (the pose buffer a caller writes), `pose()`
 *        (one forward pass and the matrix writes, no allocation), `setBake` (incremental update from
 *        `editor.changes`), `measured` / `frame` (grounding and camera fitting) and `dispose`.
 * Does not own: what pieces exist (kit/figure-layout.js), surfaces (kit/figure-shapes.js), shading, outlines
 *        and colour (kit/look-*.js, kit/palette.js), kinematics (kit/rig.js, kit/reach.js) or motion over time.
 *
 * Why one mesh per piece (DECISIONS.md, "Kit.figure: one mesh per piece"): measured against one skinned mesh
 * per paint region and against instancing across figures that share a bake; the per-piece mesh is exact
 * (normals under a dial's non-uniform scale, bounds, culling), makes every incremental update a keyed diff,
 * and costs draw calls that matter only past a few dozen figures, where `Kit.figure.crowd` is the answer.
 *
 * Needs THREE, so it is exercised in the browser (`Kit.play('figures')`); its decisions are pure and tested.
 */
(() => {
  if (typeof THREE === 'undefined') return;
  /** Rows a figure reserves in the atlas: enough for any species of a catalogue, so a species change rewrites rows in place. */
  const RAMP_SLOTS = 8;
  const MATERIALS_PER_DRESS = 2; // the look's toon and hull materials
  /** Floats per vertex position or normal, and per matrix. */
  const VECTOR = 3;
  const MATRIX = 16;
  /** A crowd member's place: x, y, z, heading. */
  const PLACE = 4;

  const fail = (where, message) => {
    throw new Error(`Kit.figure.${where}: ${message}`);
  };

  // ---- geometry cache -------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} GeometryCache
   * @property {function(Object): THREE.BufferGeometry} acquire the geometry of a piece (`{ shape, key }`), built on the first request
   * @property {function(string): void} release one user fewer; the geometry is disposed when none is left
   * @property {function(Object): Float32Array} positions a piece's bone-space positions (builds and caches them without a geometry)
   * @property {function(): {created: number, alive: number}} stats geometries ever created, and alive now
   * @property {function(): void} dispose free every geometry
   */

  /**
   * A cache of piece geometries by shape key, so figures that share a shape share one geometry (one upload,
   * one welded-normal pass by the look).
   * @returns {GeometryCache}
   * @complexity acquire: O(1) on a hit, O(vertices) on a miss
   * @example const cache = Kit.figure.geometryCache(); const geometry = cache.acquire(piece);
   */
  const geometryCache = () => {
    /** @type {Map<string, {geometry: THREE.BufferGeometry, users: number}>} */
    const entries = new Map();
    /** @type {Map<string, Float32Array>} */
    const arraysByKey = new Map();
    let created = 0;
    const arraysOf = (piece, level) => {
      const known = arraysByKey.get(piece.key);
      if (known) return known;
      const arrays = Kit.figure.buildShape(piece.shape, level);
      arraysByKey.set(piece.key, arrays);
      return arrays;
    };
    const levelOf = (key) => key.split('|')[1];
    return {
      acquire(piece) {
        const known = entries.get(piece.key);
        if (known) {
          known.users += 1;
          return known.geometry;
        }
        const arrays = arraysOf(piece, levelOf(piece.key));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, VECTOR));
        geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, VECTOR));
        geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        created += 1;
        entries.set(piece.key, { geometry, users: 1 });
        return geometry;
      },
      release(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entry.users -= 1;
        if (entry.users > 0) return;
        entry.geometry.dispose();
        entries.delete(key);
      },
      positions: (piece) => arraysOf(piece, levelOf(piece.key)).positions,
      stats: () => ({ created, alive: entries.size }),
      dispose() {
        entries.forEach((entry) => entry.geometry.dispose());
        entries.clear();
        arraysByKey.clear();
      },
    };
  };

  // ---- the figure -----------------------------------------------------------------------------------------------------

  /** The bake's ramps padded to `RAMP_SLOTS` rows, so every bake loads into the same block shape. */
  const paddedRamps = (ramps) => {
    if (!ramps || !ramps.length) fail('build', 'the bake has no `ramps`; give a part alone one ramp: { plan, boneRamp, ramps: [ramp] }.');
    if (ramps.length > RAMP_SLOTS) fail('build', `the bake has ${ramps.length} ramps; a figure reserves ${RAMP_SLOTS} rows. Raise RAMP_SLOTS in kit/figure.js.`);
    return Array.from({ length: RAMP_SLOTS }, (_unused, index) => ramps[Math.min(index, ramps.length - 1)]);
  };

  /**
   * Loads a bake's colours into a view's atlas as a block of `RAMP_SLOTS` rows. A figure loads its own block;
   * figures that should always wear the same colours (a crowd of one look) can share one by passing it as
   * `options.rows`, and then a colour change of one recolours them all.
   * @param {Object} view from `Kit.look.view`
   * @param {{ramps: ReadonlyArray<Object>}} bake
   * @returns {Object} a `PaletteBlock` of kit/palette.js
   * @throws {Error} for a bake without ramps or with more than `RAMP_SLOTS`
   * @complexity O(RAMP_SLOTS)
   * @example const rows = Kit.figure.loadRows(view, bake); const guards = bakes.map((guard) => Kit.figure.build(view, guard, { rows }));
   */
  const loadRows = (view, bake) => view.atlas.load(paddedRamps(bake.ramps));

  /**
   * @typedef {Object} Figure
   * @property {THREE.Group} root a direct child of `view.scene`; move and turn it to place the figure
   * @property {Object} bake the bake drawn now
   * @property {Object} layout the `FigureLayout` drawn now
   * @property {Object} local the pose buffer (a `JointTransforms` of kit/rig.js, in `bake.plan` bone order): write
   *   it, then call `pose()`. Reset to the rest pose with `rest()`. Replaced by `setBake` when the plan changes.
   * @property {Object} world the world transforms of the last `pose()`, in figure space
   * @property {Object} measured the `RestMeasure` of the body (kit/figure-layout.js), in figure space after grounding
   * @property {function(): void} rest copies the bake's rest pose into `local`
   * @property {function(): void} pose forward kinematics over `local` and a matrix write per mesh; no allocation
   * @property {function(Object, Object=): Object} setBake draws another bake with the fewest changes; returns the plan carried out
   * @property {function(number): Object} frame a `ViewWindow` (kit/figure-layout.js) for a screen area of this aspect
   * @property {function(): {meshes: number, materialsCreated: number, geometriesCreated: number}} counters
   * @property {function(): void} dispose
   */

  /**
   * Builds a figure in a view.
   * @param {Object} view from `Kit.look.view`
   * @param {Object} bake from a bakery (kit/body-recipe.js), or a part alone `{ plan, boneRamp, ramps }`
   * @param {{level?: string, cache?: GeometryCache, rows?: Object, ground?: boolean, center?: boolean, featuresOf?: Function}} [options]
   *   `level` of detail (default 'high'); `cache` shared between figures (default one per module); `rows`: a
   *   block from `loadRows` to share (default: the figure loads its own); `ground`:
   *   stand the body's lowest point at rest on y = 0 (default true); `center`: turn about the middle of the
   *   footprint rather than the plan's origin (default true); `featuresOf`: the features extension point
   * @returns {Figure}
   * @complexity O(pieces) meshes and materials; O(vertices) the first time a shape key is seen
   * @example
   * const figure = Kit.figure.build(view, bakery.bakeRecipe({ species: 'human', seed: 1 }));
   * figure.rest(); figure.pose();   // per frame: write figure.local (a gait, IK), then figure.pose()
   */
  const build = (view, bake, options = {}) => {
    const cache = options.cache || sharedCache();
    const layoutOptions = { level: options.level, featuresOf: options.featuresOf };
    const shouldGround = options.ground !== false;
    const shouldCenter = options.center !== false;
    const root = new THREE.Group();
    root.name = `figure:${bake.species || bake.plan.id}`;
    const anchor = view.add(root);
    const block = options.rows || loadRows(view, bake);
    /** @type {Array<{piece: Object, mesh: THREE.Mesh, dressed: Object}>} in no particular order; `piece.bone` drives the matrix */
    let entries = [];
    let materialsCreated = 0;
    let shown = bake;
    let shownLayout = Kit.figure.layout(bake, layoutOptions);
    const offset = { x: 0, y: 0, z: 0 };

    const addPiece = (piece) => {
      const mesh = new THREE.Mesh(cache.acquire(piece));
      // The matrix is written from the pose every frame; three.js must not rebuild it from position and rotation.
      mesh.matrixAutoUpdate = false;
      mesh.name = piece.id;
      root.add(mesh);
      const dressed = view.shading.dress(mesh, {
        ramp: block.rows[piece.ramp],
        inkGroup: piece.inkGroup,
        shiny: piece.shiny,
        emissive: piece.emissive,
        tone: piece.tone,
        anchor,
      });
      materialsCreated += MATERIALS_PER_DRESS;
      entries.push({ piece, mesh, dressed });
    };
    const removeEntry = (entry) => {
      root.remove(entry.mesh);
      view.shading.undress(entry.dressed);
      cache.release(entry.piece.key);
    };

    /** Grounding and centring, from the bake's rest pose (props left out). */
    const remeasure = () => {
      const restWorld = Kit.body.worldTransforms(shown.plan, shown.rest || Kit.body.createPose(shown.plan), Kit.body.createPose(shown.plan));
      const measured = Kit.figure.measureRest(shownLayout, restWorld, cache.positions);
      offset.x = shouldCenter ? -measured.centerX : 0;
      offset.z = shouldCenter ? -measured.centerZ : 0;
      offset.y = shouldGround ? -measured.lowestY : 0;
      figure.measured = { ...measured, lowestY: measured.lowestY + offset.y, highestY: measured.highestY + offset.y, lowestPropY: measured.lowestPropY + offset.y, centerX: 0, centerZ: 0 };
    };

    const figure = {
      root,
      anchor,
      bake,
      layout: shownLayout,
      local: Kit.body.createPose(bake.plan),
      world: Kit.body.createPose(bake.plan),
      measured: null,
      rest() {
        if (shown.rest) Kit.rig.copy(shown.rest, figure.local);
        else Kit.body.copyRest(shown.plan, figure.local);
      },
      pose() {
        Kit.body.worldTransforms(shown.plan, figure.local, figure.world, offset.x, offset.y, offset.z);
        // Per-frame hot path: an index loop and a direct write into each matrix, no allocation.
        for (let index = 0; index < entries.length; index++) Kit.figure.writeBoneMatrix(figure.world, entries[index].piece.bone, entries[index].mesh.matrix.elements);
      },
      setBake(next, changes) {
        const previousPlan = shown.plan;
        const nextLayout = Kit.figure.layout(next, layoutOptions);
        const update = Kit.figure.planUpdate(shownLayout, nextLayout, changes);
        const leaving = new Set(update.remove);
        entries.filter((entry) => leaving.has(entry.piece)).forEach(removeEntry);
        const moved = new Map(update.keep.map(({ from, to }) => [from, to]));
        entries = entries.filter((entry) => !leaving.has(entry.piece)).map((entry) => ({ ...entry, piece: moved.get(entry.piece) || entry.piece }));
        shown = next;
        shownLayout = nextLayout;
        figure.bake = next;
        figure.layout = nextLayout;
        update.add.forEach(addPiece);
        if (update.recolor) view.atlas.write(block, paddedRamps(next.ramps));
        if (next.plan !== previousPlan) {
          // Another plan (an outfit or a species): bones sit at other indices, so the pose buffers are made
          // again in its bone order. Whoever writes `local` (a gait, IK) must pick up the new buffer.
          figure.local = Kit.body.createPose(next.plan);
          figure.world = Kit.body.createPose(next.plan);
        }
        if (update.remeasure) remeasure();
        figure.rest();
        figure.pose();
        return { kept: update.keep.length, added: update.add.length, removed: update.remove.length, recolored: update.recolor, remeasured: update.remeasure };
      },
      frame: (aspect, frameOptions) => Kit.figure.fitView(figure.measured, aspect, frameOptions),
      counters: () => ({ meshes: entries.length, materialsCreated, geometriesCreated: cache.stats().created }),
      dispose() {
        entries.forEach(removeEntry);
        entries = [];
        view.remove(root);
      },
    };
    shownLayout.pieces.forEach(addPiece);
    remeasure();
    figure.rest();
    figure.pose();
    return figure;
  };

  let moduleCache = null;
  /** The cache figures share when none is given. */
  const sharedCache = () => {
    if (!moduleCache) moduleCache = geometryCache();
    return moduleCache;
  };

  // ---- crowds: many figures of one bake --------------------------------------------------------------------------------

  /**
   * @typedef {Object} Crowd
   * @property {THREE.Group} root a direct child of `view.scene`
   * @property {number} count
   * @property {Object[]} locals one pose buffer per member (write it, then `pose`)
   * @property {Float32Array} places 4 per member: x, y, z, heading (radians); written by the caller
   * @property {function(): void} pose forward kinematics and an instance matrix per member per piece; no allocation
   * @property {function(): void} dispose
   */

  /**
   * Many figures that share one bake, drawn with one instanced mesh per piece: the draw calls stay those of
   * one figure whatever the count. Every member is coloured by the same rows (a crowd of one look; distinct
   * looks are distinct bakes, so distinct crowds).
   * @param {Object} view from `Kit.look.view`
   * @param {Object} bake from a bakery
   * @param {number} count members
   * @param {{level?: string, cache?: GeometryCache, rows?: Object}} [options] `rows`: a block from `loadRows` to share
   * @returns {Crowd}
   * @complexity pose: O(count x (bones + pieces)) per frame, no allocation; draw calls O(pieces)
   * @example const crowd = Kit.figure.crowd(view, bake, 200); crowd.places.set([x, 0, z, heading], 4 * index);
   */
  const crowd = (view, bake, count, options = {}) => {
    const cache = options.cache || sharedCache();
    const pieceLayout = Kit.figure.layout(bake, { level: options.level || 'medium' });
    const root = new THREE.Group();
    root.name = `crowd:${bake.species || bake.plan.id}`;
    view.scene.add(root);
    const block = options.rows || loadRows(view, bake);
    const restWorld = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
    const measured = Kit.figure.measureRest(pieceLayout, restWorld, cache.positions);
    const meshes = pieceLayout.pieces.map((piece) => {
      const mesh = new THREE.InstancedMesh(cache.acquire(piece), undefined, count);
      // Members wander over the whole stage; the geometry's own bounds would cull them wrongly.
      mesh.frustumCulled = false;
      root.add(mesh);
      const dressed = view.shading.dress(mesh, { ramp: block.rows[piece.ramp], inkGroup: piece.inkGroup, shiny: piece.shiny });
      return { piece, mesh, dressed };
    });
    const locals = Array.from({ length: count }, () => Kit.rig.copy(bake.rest, Kit.body.createPose(bake.plan)));
    const world = Kit.body.createPose(bake.plan);
    const places = new Float32Array(count * PLACE);
    return {
      root,
      count,
      locals,
      places,
      pose() {
        // Per-frame hot path over members and pieces: index loops, direct writes into the instance buffers.
        for (let member = 0; member < count; member++) {
          const at = member * PLACE;
          Kit.body.worldTransforms(bake.plan, locals[member], world, places[at], places[at + 1] - measured.lowestY, places[at + 2], places[at + 3]);
          for (let index = 0; index < meshes.length; index++) Kit.figure.writeBoneMatrix(world, meshes[index].piece.bone, meshes[index].mesh.instanceMatrix.array, member * MATRIX);
        }
        for (let index = 0; index < meshes.length; index++) meshes[index].mesh.instanceMatrix.needsUpdate = true;
      },
      dispose() {
        meshes.forEach(({ piece, mesh, dressed }) => {
          root.remove(mesh);
          view.shading.undress(dressed);
          mesh.dispose();
          cache.release(piece.key);
        });
        view.remove(root);
      },
    };
  };

  Kit.figure = Object.assign(Kit.figure || {}, { RAMP_SLOTS, geometryCache, loadRows, build, crowd });
})();
