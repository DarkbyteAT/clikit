/**
 * Kit figure: a body bake plus a pose, drawn in 3D through Kit.look. It is the renderer between the body
 * system (data) and the look pipeline (shading): one mesh per piece of kit/figure-layout.js, its geometry from
 * kit/figure-shapes.js shared through a cache, its material from `view.shading.dress`, its colour from the
 * figure's rows of the view's palette atlas, and its matrix written each frame from the pose's world transforms.
 *
 * Owns:  `Kit.figure.geometryCache` (BufferGeometry per shape key, counted and shared), `Kit.figure.regionTextures`
 *        (one texture per baked region map, counted and shared), `Kit.figure.build`
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
  // 16, not 8: the wardrobe catalogue (kit/body-wardrobe.js) paints with 14 channels (skin, hair, eyes, eye
  // whites, lips, marks, five garments, headwear, gear, accent).
  const RAMP_SLOTS = 16;
  const MATERIALS_PER_DRESS = 2; // the look's toon and hull materials
  /** Floats per vertex position or normal, and per matrix. */
  const VECTOR = 3;
  const MATRIX = 16;
  /** Texels of a bone texture per matrix (a column each), and numbers per column. */
  const MATRIX_TEXELS = 4;
  /** Bones that may move one vertex of a sculpted surface. */
  const SKIN_OWNERS = 4;
  const QUATERNION = 4;
  /** Floats per vertex of a stamp's paint and of its centre (kit/figure-shapes.js `stamps`). */
  const STAMP_PAINT = 4;
  const STAMP_CENTRE = 4;
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
        if (arrays.paint) {
          geometry.setAttribute('stampPaint', new THREE.BufferAttribute(arrays.paint, STAMP_PAINT));
          geometry.setAttribute('stampCentre', new THREE.BufferAttribute(arrays.centres, STAMP_CENTRE));
        }
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

  // ---- region textures ------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} RegionTextureCache
   * @property {function(Object): Object} acquire the `LookRegions` (kit/look-toon.js) of a `RegionMapOnBone`, its texture made on the first request
   * @property {function(string): void} release one user fewer; the texture is disposed when none is left
   * @property {function(): {created: number, alive: number}} stats
   * @property {function(): void} dispose
   */

  /**
   * A cache of region-map textures by map key, so every figure wearing the same garment on the same bone reads
   * one small texture.
   * @returns {RegionTextureCache}
   * @complexity acquire: O(1) on a hit; a miss uploads width x height texels (8192 at the default size)
   * @example const regions = Kit.figure.regionTextures(); view.shading.dress(mesh, { ramp, regions: regions.acquire(piece.regions) });
   */
  const regionTextures = () => {
    /** @type {Map<string, {texture: THREE.Texture, users: number}>} */
    const entries = new Map();
    let created = 0;
    const textureOf = (map) => {
      const texture = new THREE.DataTexture(map.data, map.width, map.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      // Bytes are indices, never colours: no filtering, no mipmaps. The angle wraps round the bone; s does not.
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      created += 1;
      return texture;
    };
    return {
      acquire(map) {
        const entry = entries.get(map.key) || { texture: textureOf(map), users: 0 };
        entry.users += 1;
        entries.set(map.key, entry);
        return { texture: entry.texture, width: map.width, height: map.height, end: map.end, front: map.front, side: map.side };
      },
      release(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entry.users -= 1;
        if (entry.users > 0) return;
        entry.texture.dispose();
        entries.delete(key);
      },
      stats: () => ({ created, alive: entries.size }),
      dispose() {
        entries.forEach((entry) => entry.texture.dispose());
        entries.clear();
      },
    };
  };

  /**
   * What a piece is to the look (a `LookPart` of kit/look-toon.js): its ramp row, its line class (its ramp
   * slot, so two paints of one figure meeting on a surface get a line), and its regions, shell or stamps.
   */
  const lookPartOf = (piece, block, textures) => ({
    ramp: block.rows[piece.ramp],
    inkGroup: piece.inkGroup,
    inkClass: piece.ramp,
    shiny: piece.shiny,
    emissive: piece.emissive,
    response: piece.inkGroup === Kit.figure.INK_GROUPS.head ? 'face' : undefined,
    tone: piece.tone,
    blockRow: block.offset,
    regions: piece.regions ? textures.acquire(piece.regions) : undefined,
    shell: piece.shell,
    stamps: piece.stamps,
    outlined: piece.outlined,
  });

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
   * @property {function(Object<string, number>): void} face shows the face of a state: per set of
   *   `Kit.body.FRAME_SETS` an index into its frames ({ blink: 2 } is eyes closed; zeros are the rest face).
   *   A motion state chooses it: `figure.face(Kit.act.face(motion))`. O(1) when the state has not changed;
   *   the first time a state is shown its stamps are built
   * @property {function(Object, Object=, {settle?: boolean}=): Object} setBake draws another bake with the fewest
   *   changes; returns the plan carried out. A colour change never sculpts. `{ settle: false }` says the edit is
   *   still moving (a dial being dragged): the sculpted surfaces are bent to the new proportions by the skeleton
   *   at once, and sculpted again by `settle()`
   * @property {function(number=): boolean} settle sculpts the surfaces for the bake shown if they were only bent to it (or,
   *   built with `sculpt: 'steps'`, not sculpted yet); true when it did. With a number it works for about that many
   *   milliseconds and returns false until the work, spread over as many calls as it takes, is done
   * @property {function(): boolean} isSettled false while the surfaces wait for `settle()`
   * @property {function(number): Object} frame a `ViewWindow` (kit/figure-layout.js) for a screen area of this aspect
   * @property {function(): {meshes: number, skinned: number, materialsCreated: number, geometriesCreated: number}} counters `meshes`:
   *   draw objects in all, of which `skinned` are sculpted surfaces
   * @property {function(): void} dispose
   */

  /**
   * Builds a figure in a view.
   * @param {Object} view from `Kit.look.view`
   * @param {Object} bake from a bakery (kit/body-recipe.js), or a part alone `{ plan, boneRamp, ramps }`
   * @param {{level?: string, cache?: GeometryCache, rows?: Object, ground?: boolean, center?: boolean, sculpt?: boolean|string, featuresOf?: ?Function, regionMapOf?: ?Function}} [options]
   *   `level` of detail (default 'high'); `cache` shared between figures (default one per module); `rows`: a
   *   block from `loadRows` to share (default: the figure loads its own, and frees it on `dispose`); `ground`:
   *   stand the body's lowest point at rest on y = 0 (default true); `center`: turn about the middle of the
   *   footprint rather than the plan's origin (default true); `sculpt`: draw the body as blended, skinned
   *   surfaces with its garments as layers (kit/figure-sculpt.js; default true), false: one rigid piece per bone
   *   shape, as `crowd` draws; 'steps': sculpted, but never inside `build` or `setBake`: the rigid pieces (or the
   *   last surfaces, bent) are shown until `settle(milliseconds)`, called every frame, has done the work; `featuresOf` and `regionMapOf`: the two extension
   *   points of `Kit.figure.layout` (default: the body system's, so a bake with a face and clothes shows them;
   *   null draws the bare bones)
   * @returns {Figure}
   * @complexity O(pieces) meshes and materials; O(vertices) the first time a shape key is seen
   * @example
   * const figure = Kit.figure.build(view, bakery.bakeRecipe({ species: 'human', seed: 1 }));
   * figure.rest(); figure.pose();   // per frame: write figure.local (a gait, IK), then figure.pose()
   */
  const build = (view, bake, options = {}) => {
    const cache = options.cache || sharedCache();
    const layoutOptions = { level: options.level, featuresOf: options.featuresOf, regionMapOf: options.regionMapOf };
    const textures = sharedRegionTextures();
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
    const shouldSculpt = options.sculpt !== false && Boolean(Kit.figure.sculptLayers);
    /** Sculpting is spread over frames by `settle(milliseconds)`; until it is done the body is its rigid pieces, or the surfaces it had, bent. */
    const isStepped = options.sculpt === 'steps';
    /** The sculpt under way for the bake shown (kit/figure-sculpt.js `sculptTask`), when it is done in steps. */
    let task = null;
    /** The skinned surfaces standing in for the body's rigid pieces (kit/figure-sculpt.js); null when not sculpted. */
    let skin = null;
    /** The surfaces were sculpted for an earlier bake and are being bent to this one by the skeleton (see `setBake`). */
    let isStale = false;

    /** Takes the sculpted surfaces down. */
    const removeSkin = () => {
      if (!skin) return;
      skin.meshes.forEach(({ mesh, dressed, layer }) => {
        root.remove(mesh);
        view.shading.undress(dressed);
        releaseSkinGeometry(layer);
      });
      skin.bones.forEach((bone) => root.remove(bone));
      skin.skeleton.dispose();
      skin = null;
    };
    /** Sculpts the bake shown now and binds each layer to a skeleton whose bone matrices `pose()` writes. */
    const addSkin = (sculpted = Kit.figure.sculptLayers(shown, shownLayout)) => {
      const bones = Array.from({ length: shown.plan.boneCount }, () => {
        const bone = new THREE.Bone();
        bone.matrixAutoUpdate = false;
        root.add(bone);
        return bone;
      });
      const inverses = bones.map((_bone, index) => new THREE.Matrix4().fromArray(sculpted.matrices, index * MATRIX).invert());
      const skeleton = new THREE.Skeleton(bones, inverses);
      const meshes = sculpted.layers.map((layer) => {
        const mesh = new THREE.SkinnedMesh(acquireSkinGeometry(layer));
        mesh.name = layer.id;
        // The bones move the surface anywhere; its rest bounds say nothing about where it is drawn.
        mesh.frustumCulled = false;
        root.add(mesh);
        mesh.bind(skeleton, new THREE.Matrix4());
        // A body surface is a head and a body in one mesh: each vertex says how much of a face's light it takes.
        const faceLight = layer.faceShare ? { response: 'face', responseShare: true } : {};
        const dressed = view.shading.dress(mesh, { ramp: block.rows[layer.ramp], inkGroup: layer.inkGroup, inkClass: layer.inkClass, blockRow: block.offset, anchor, ...faceLight });
        materialsCreated += MATERIALS_PER_DRESS;
        return { mesh, dressed, layer };
      });
      skin = { ...sculpted, bones, skeleton, meshes, scratch: Kit.body.createPose(shown.plan) };
      isStale = false;
    };
    /**
     * Makes the sculpted surfaces match the bake shown now, and the rigid pieces match what the surfaces leave
     * to them (a solid too thin to sculpt at this size is a rigid piece; a dial can move it either way).
     */
    const resculpt = (sculpted) => {
      removeSkin();
      addSkin(sculpted);
      task = null;
      entries.filter((entry) => isReplaced(entry.piece)).forEach(removeEntry);
      entries = entries.filter((entry) => !isReplaced(entry.piece));
      const drawn = new Set(entries.map((entry) => entry.piece));
      shownLayout.pieces.filter((piece) => !drawn.has(piece)).forEach(addPiece);
    };
    /**
     * The pose with every buried limb opened (kit/figure-sculpt.js `limbClearance`): the same turn in front of
     * the lead bone's rotation whatever wrote the pose, so a walk swings the arms about their opened rest.
     */
    const opened = (local) => (skin ? openedInto(skin.clearance, local, skin.scratch) : local);
    const isReplaced = (piece) => Boolean(skin && skin.replaced.has(piece.id));

    const addPiece = (piece) => {
      // A carving piece is a shape taken out of the sculpted surface, never a thing to draw.
      if (isReplaced(piece) || piece.carve) return;
      const mesh = new THREE.Mesh(cache.acquire(piece));
      // The matrix is written from the pose every frame; three.js must not rebuild it from position and rotation.
      mesh.matrixAutoUpdate = false;
      mesh.name = piece.id;
      root.add(mesh);
      const dressed = view.shading.dress(mesh, { ...lookPartOf(piece, block, textures), anchor });
      materialsCreated += MATERIALS_PER_DRESS;
      entries.push({ piece, mesh, dressed });
    };
    /** The face meshes made so far, by entry: one per face state that has been shown (`figure.face`). */
    const faceMeshes = new Map();
    /** The face state shown now ({ blink, talk }: indices into `Kit.body.FRAME_SETS`); all zeros is the rest face. */
    const shownFace = {};
    /** The face meshes visible now, each with the rest mesh whose matrix it copies: what `pose` writes besides the entries. */
    let facesShown = [];
    const dropFaces = (entry) => {
      facesShown = facesShown.filter((shown) => shown.source !== entry.mesh);
      (faceMeshes.get(entry) || []).forEach((made) => {
        root.remove(made.mesh);
        view.shading.undress(made.dressed);
        cache.release(made.piece.key);
      });
      faceMeshes.delete(entry);
      entry.mesh.visible = true;
    };
    const isFace = (state, wanted) => Object.keys(state).every((set) => state[set] === (wanted[set] || 0));
    /** The mesh of an entry's stamps in a face state, made the first time that state is shown. */
    const faceMesh = (entry, face) => {
      const made = faceMeshes.get(entry) || [];
      faceMeshes.set(entry, made);
      const known = made.find((candidate) => candidate.face === face);
      if (known) return known;
      const piece = { ...entry.piece, shape: face.shape, key: Kit.figure.shapeKey(face.shape, shownLayout.level) };
      const mesh = new THREE.Mesh(cache.acquire(piece));
      mesh.matrixAutoUpdate = false;
      mesh.name = `${piece.id}@face`;
      root.add(mesh);
      const fresh = { face, piece, mesh, dressed: view.shading.dress(mesh, { ...lookPartOf(piece, block, textures), anchor }) };
      materialsCreated += MATERIALS_PER_DRESS;
      made.push(fresh);
      return fresh;
    };
    const removeEntry = (entry) => {
      dropFaces(entry);
      root.remove(entry.mesh);
      view.shading.undress(entry.dressed);
      cache.release(entry.piece.key);
      if (entry.piece.regions) textures.release(entry.piece.regions.key);
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
        Kit.body.worldTransforms(shown.plan, opened(figure.local), figure.world, offset.x, offset.y, offset.z);
        // Per-frame hot path: an index loop and a direct write into each matrix, no allocation.
        for (let index = 0; index < entries.length; index++) Kit.figure.writeBoneMatrix(figure.world, entries[index].piece.bone, entries[index].mesh.matrix.elements);
        if (skin) for (let bone = 0; bone < skin.bones.length; bone++) Kit.figure.writeBoneMatrix(figure.world, bone, skin.bones[bone].matrix.elements);
        // A face shown in place of the rest one rides on the same bone.
        for (let index = 0; index < facesShown.length; index++) facesShown[index].mesh.matrix.copy(facesShown[index].source.matrix);
      },
      face(state) {
        const wanted = state || {};
        const sets = Object.keys(wanted);
        if (sets.every((set) => (shownFace[set] || 0) === (wanted[set] || 0))) return;
        sets.forEach((set) => (shownFace[set] = wanted[set] || 0));
        facesShown = [];
        entries.forEach((entry) => {
          if (!entry.piece.faces) return;
          const face = entry.piece.faces.find((candidate) => isFace(candidate.state, shownFace));
          (faceMeshes.get(entry) || []).forEach((made) => (made.mesh.visible = false));
          entry.mesh.visible = !face;
          if (!face) return;
          const made = faceMesh(entry, face);
          made.mesh.visible = true;
          made.mesh.matrix.copy(entry.mesh.matrix);
          facesShown.push({ mesh: made.mesh, source: entry.mesh });
        });
      },
      setBake(next, changes, settleOptions = {}) {
        // Faces are made again on demand for the new bake: its stamps may have moved.
        entries.forEach(dropFaces);
        Object.keys(shownFace).forEach((set) => (shownFace[set] = 0));
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
        if (shouldSculpt) {
          // A colour change leaves the surfaces as they are. A dial in mid-drag (`settle: false`) bends them
          // through the skeleton at once and they are sculpted again when the drag rests; anything else
          // (a garment, a species, a caller that does not say) sculpts now.
          const isSame = skin && skin.signature === Kit.figure.sculptSignature(next, nextLayout);
          const canBend = skin && settleOptions.settle === false && next.plan === previousPlan && changes && !changes.rebuild && !(changes.sockets || []).length;
          task = null;
          if (isSame) isStale = false;
          else if (canBend) isStale = true;
          else if (isStepped && !Kit.figure.sculptTask(next, nextLayout).isDone()) {
            // Other bones or other parts: the old surfaces cannot be bent to them, so the rigid pieces stand in until `settle` is done.
            removeSkin();
            const drawn = new Set(entries.map((entry) => entry.piece));
            nextLayout.pieces.filter((piece) => !drawn.has(piece)).forEach(addPiece);
            isStale = true;
          } else resculpt();
        }
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
        return { kept: update.keep.length, added: update.add.length, removed: update.remove.length, recolored: update.recolor, remeasured: update.remeasure, settled: !isStale };
      },
      settle(milliseconds) {
        if (!isStale) return false;
        if (milliseconds === undefined) resculpt();
        else {
          task = task || Kit.figure.sculptTask(shown, shownLayout);
          if (!task.step(milliseconds)) return false;
          resculpt(task.result);
        }
        isStale = false;
        figure.pose();
        return true;
      },
      isSettled: () => !isStale,
      frame: (aspect, frameOptions) => Kit.figure.fitView(figure.measured, aspect, frameOptions),
      counters: () => ({ meshes: entries.length + (skin ? skin.meshes.length : 0), skinned: skin ? skin.meshes.length : 0, materialsCreated, geometriesCreated: cache.stats().created }),
      dispose() {
        entries.forEach(removeEntry);
        entries = [];
        removeSkin();
        view.remove(root);
        // Rows the figure loaded itself go back to the atlas; shared rows belong to whoever loaded them.
        if (!options.rows && view.atlas.free) view.atlas.free(block);
      },
    };
    if (shouldSculpt && isStepped && !Kit.figure.sculptTask(shown, shownLayout).isDone()) isStale = true;
    else if (shouldSculpt) addSkin();
    shownLayout.pieces.forEach(addPiece);
    remeasure();
    figure.rest();
    figure.pose();
    return figure;
  };

  /**
   * The pose with every buried limb opened, written into `scratch` (or `local` itself when no limb is buried):
   * a quaternion product per opened limb, in place, nothing allocated.
   */
  const openedInto = (clearance, local, scratch) => {
    if (!clearance.leads.length) return local;
    const { leads, turns } = clearance;
    Kit.rig.copy(local, scratch);
    const rotation = scratch.rotation;
    for (let index = 0; index < leads.length; index++) {
      const [at, turn] = [leads[index] * QUATERNION, index * QUATERNION];
      const [ax, ay, az, aw] = [turns[turn], turns[turn + 1], turns[turn + 2], turns[turn + 3]];
      const [bx, by, bz, bw] = [rotation[at], rotation[at + 1], rotation[at + 2], rotation[at + 3]];
      rotation[at] = aw * bx + ax * bw + ay * bz - az * by;
      rotation[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
      rotation[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
      rotation[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
    }
    return scratch;
  };

  /** @type {WeakMap<Object, {geometry: THREE.BufferGeometry, users: number}>} one geometry per sculpted layer, shared by every figure showing it */
  const skinGeometries = new WeakMap();
  /**
   * The geometry of a sculpted layer (kit/figure-sculpt.js `SculptLayer`). Equal bakes share their layers, so
   * figures of one look share one upload.
   */
  const acquireSkinGeometry = (layer) => {
    const known = skinGeometries.get(layer);
    if (known) {
      known.users += 1;
      return known.geometry;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(layer.positions, VECTOR));
    geometry.setAttribute('normal', new THREE.BufferAttribute(layer.normals, VECTOR));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(layer.owners, SKIN_OWNERS));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(layer.weights, SKIN_OWNERS));
    if (layer.faceShare) geometry.setAttribute('responseShare', new THREE.BufferAttribute(layer.faceShare, 1));
    geometry.setIndex(new THREE.BufferAttribute(layer.indices, 1));
    skinGeometries.set(layer, { geometry, users: 1 });
    return geometry;
  };
  const releaseSkinGeometry = (layer) => {
    const entry = skinGeometries.get(layer);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    entry.geometry.dispose();
    skinGeometries.delete(layer);
  };

  let moduleCache = null;
  /** The cache figures share when none is given. */
  const sharedCache = () => {
    if (!moduleCache) moduleCache = geometryCache();
    return moduleCache;
  };

  let moduleRegionTextures = null;
  /** The region textures every figure and crowd shares. */
  const sharedRegionTextures = () => {
    if (!moduleRegionTextures) moduleRegionTextures = regionTextures();
    return moduleRegionTextures;
  };

  // ---- crowds: many figures of one bake --------------------------------------------------------------------------------

  /**
   * @typedef {Object} Crowd
   * @property {THREE.Group} root a direct child of `view.scene`
   * @property {number} count
   * @property {Object[]} locals one pose buffer per member (write it, then `pose`)
   * @property {Float32Array} places 4 per member: x, y, z, heading (radians); written by the caller
   * @property {{triangles: number, meshes: number, isSculpted: boolean}} cost triangles per member, instanced meshes for the whole crowd
   * @property {function(): void} pose forward kinematics, an instance matrix per member per rigid piece and a bone texture row per member; no allocation
   * @property {function(): void} dispose
   */

  /**
   * Many figures that share one bake, drawn with one instanced mesh per piece: the draw calls stay those of
   * one figure whatever the count. Every member is coloured by the same rows (a crowd of one look; distinct
   * looks are distinct bakes, so distinct crowds).
   * @param {Object} view from `Kit.look.view`
   * @param {Object} bake from a bakery
   * @param {number} count members
   * @param {{level?: string, cache?: GeometryCache, rows?: Object, sculpt?: boolean}} [options] `rows`: a block from `loadRows` to share;
   *   `sculpt: false`: the rigid pieces (also what a WebGL1 renderer gets). Sculpted, every member bends the same
   *   surfaces (sculpted once per bake, kept in the sculpt cache) by its own row of a bone texture
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
    const textures = sharedRegionTextures();
    const restWorld = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
    const measured = Kit.figure.measureRest(pieceLayout, restWorld, cache.positions);
    // One sculpted surface per layer for the whole crowd where the renderer can index a bone texture by instance;
    // the rigid pieces are then only what the surfaces leave (eyes, props, what is too thin to sculpt).
    const canSculpt = options.sculpt !== false && Boolean(Kit.figure.sculptLayers) && view.isWebGL2 === true;
    const sculpted = canSculpt ? Kit.figure.sculptLayers(bake, pieceLayout) : null;
    const meshes = pieceLayout.pieces
      .filter((piece) => !piece.carve && (!sculpted || !sculpted.replaced.has(piece.id)))
      .map((piece) => {
        const mesh = new THREE.InstancedMesh(cache.acquire(piece), undefined, count);
        // Members wander over the whole stage; the geometry's own bounds would cull them wrongly.
        mesh.frustumCulled = false;
        root.add(mesh);
        const dressed = view.shading.dress(mesh, lookPartOf(piece, block, textures));
        return { piece, mesh, dressed };
      });
    const boneCount = bake.plan.boneCount;
    /** Per member, per bone: its world matrix times the inverse of the pose the surfaces were made in (a texture row a member). */
    const boneData = sculpted ? new Float32Array(count * boneCount * MATRIX) : null;
    const boneTexture = sculpted ? new THREE.DataTexture(boneData, boneCount * MATRIX_TEXELS, count, THREE.RGBAFormat, THREE.FloatType) : null;
    const inverses = sculpted ? new Float32Array(boneCount * MATRIX) : null;
    if (sculpted) for (let bone = 0; bone < boneCount; bone++) new THREE.Matrix4().fromArray(sculpted.matrices, bone * MATRIX).invert().toArray(inverses, bone * MATRIX);
    const skins = (sculpted ? sculpted.layers : []).map((layer) => {
      const mesh = new THREE.InstancedMesh(acquireSkinGeometry(layer), undefined, count);
      mesh.frustumCulled = false;
      root.add(mesh);
      const faceLight = layer.faceShare ? { response: 'face', responseShare: true } : {};
      const dressed = view.shading.dress(mesh, { ramp: block.rows[layer.ramp], inkGroup: layer.inkGroup, inkClass: layer.inkClass, blockRow: block.offset, crowdBones: boneTexture, ...faceLight });
      return { layer, mesh, dressed };
    });
    const locals = Array.from({ length: count }, () => Kit.rig.copy(bake.rest, Kit.body.createPose(bake.plan)));
    const world = Kit.body.createPose(bake.plan);
    const scratch = Kit.body.createPose(bake.plan);
    const boneMatrix = new Float32Array(MATRIX);
    const places = new Float32Array(count * PLACE);
    return {
      root,
      count,
      locals,
      places,
      /** Triangles drawn per member and draw calls for the whole crowd (ink hulls not counted). */
      cost: {
        triangles: [...meshes, ...skins].reduce((sum, { mesh }) => sum + (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / VECTOR, 0),
        meshes: meshes.length + skins.length,
        isSculpted: Boolean(sculpted),
      },
      pose() {
        // Per-frame hot path over members, pieces and bones: index loops, direct writes into the instance and bone buffers.
        for (let member = 0; member < count; member++) {
          const at = member * PLACE;
          const local = sculpted ? openedInto(sculpted.clearance, locals[member], scratch) : locals[member];
          Kit.body.worldTransforms(bake.plan, local, world, places[at], places[at + 1] - measured.lowestY, places[at + 2], places[at + 3]);
          for (let index = 0; index < meshes.length; index++) Kit.figure.writeBoneMatrix(world, meshes[index].piece.bone, meshes[index].mesh.instanceMatrix.array, member * MATRIX);
          if (!sculpted) continue;
          for (let bone = 0; bone < boneCount; bone++) {
            Kit.figure.writeBoneMatrix(world, bone, boneMatrix);
            const [out, inverse] = [(member * boneCount + bone) * MATRIX, bone * MATRIX];
            // An affine product, column by column: the bone's matrix times the inverse of where the surface was made.
            for (let column = 0; column < MATRIX; column += MATRIX_TEXELS) {
              const [x, y, z, w] = [inverses[inverse + column], inverses[inverse + column + 1], inverses[inverse + column + 2], inverses[inverse + column + 3]];
              for (let row = 0; row < MATRIX_TEXELS; row++) {
                boneData[out + column + row] = boneMatrix[row] * x + boneMatrix[MATRIX_TEXELS + row] * y + boneMatrix[2 * MATRIX_TEXELS + row] * z + boneMatrix[3 * MATRIX_TEXELS + row] * w;
              }
            }
          }
        }
        for (let index = 0; index < meshes.length; index++) meshes[index].mesh.instanceMatrix.needsUpdate = true;
        if (boneTexture) boneTexture.needsUpdate = true;
      },
      dispose() {
        meshes.forEach(({ piece, mesh, dressed }) => {
          root.remove(mesh);
          view.shading.undress(dressed);
          mesh.dispose();
          cache.release(piece.key);
          if (piece.regions) textures.release(piece.regions.key);
        });
        skins.forEach(({ layer, mesh, dressed }) => {
          root.remove(mesh);
          view.shading.undress(dressed);
          mesh.dispose();
          releaseSkinGeometry(layer);
        });
        if (boneTexture) boneTexture.dispose();
        view.remove(root);
        if (!options.rows && view.atlas.free) view.atlas.free(block);
      },
    };
  };

  Kit.figure = Object.assign(Kit.figure || {}, { RAMP_SLOTS, geometryCache, regionTextures, loadRows, build, crowd });
})();
