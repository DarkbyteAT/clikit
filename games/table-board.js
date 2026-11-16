// Lampwick Table - board views. Everything drawn in 3D: the map with its fog, the standing pieces, other players'
// cursors, the path and ruler overlays, ink, and the dice.
//
// Owns:  turning plain table data (a board grid, tokens, light levels, polylines, rolled dice) into three.js objects,
//        and animating them. Each view is a factory taking the game context and returning a few verbs.
// Does not own: any rule or shared state (kit/tabletop.js), input, or the HUD (games/table-hud.js). Views never read
//        the network; games/table.js tells them what to show.
(() => {
  const { TAU, damp, clamp } = Kit.math;

  // ---- tunables ----------------------------------------------------------------------------------------------------

  /** Sizes in world units; one board cell is one unit. */
  const SIZE = {
    TILE: 0.95, // floor tile edge: the gap to the next tile is the grid line
    TILE_THICKNESS: 0.08,
    WALL_HEIGHT: 0.85, // low enough that a piece behind a wall still shows at the camera's tilt
    DOOR_THICKNESS: 0.16,
    TOKEN_BASE_RADIUS: 0.38,
    TOKEN_LIFT: 0.4, // how high a held piece hovers
    LABEL_HEIGHT: 1.28,
    OVERLAY_Y: 0.05, // overlays (path, ruler, ink) float just above the tiles to avoid z-fighting
  };
  /** Speeds and rates (per second). */
  const MOTION = {
    WALK_CELLS_PER_SECOND: 7,
    HOP_HEIGHT: 0.12,
    HOLD_FOLLOW_RATE: 22, // how tightly a held piece follows the finger
    SETTLE_RATE: 14, // how quickly a piece drops back to the table
    LIGHT_RATE: 7, // how quickly fog fades in and out
    CURSOR_RATE: 12,
    LIGHT_EPSILON: 0.004, // below this difference a cell's light is considered settled
  };

  /**
   * @typedef {Object} TerrainLook
   * @property {number} tile        floor tile colour under the cell
   * @property {number} [block]     colour of a full-height block filling the cell (walls)
   * @property {string} [prop]      key of PROP_BUILDERS for a free-standing object on the cell
   */
  /** How each terrain id (kit/tabletop.js TERRAIN) is drawn. @type {Object<string, TerrainLook>} */
  const TERRAIN_LOOK = {
    floor: { tile: 0x6f6757 },
    rough: { tile: 0x4c5a3a },
    wall: { tile: 0x2e2923, block: 0x5a5144 },
    door: { tile: 0x574d3f, prop: 'doorShut' },
    'door-open': { tile: 0x574d3f, prop: 'doorOpen' },
    pillar: { tile: 0x6f6757, prop: 'pillar' },
    crate: { tile: 0x6f6757, prop: 'crate' },
    brazier: { tile: 0x6f6757, prop: 'brazier' },
  };
  /** Alternate tiles are this much darker, which makes distances readable without drawing grid lines. */
  const CHECKER_SHADE = 0.9;
  const PROP_COLORS = { pillar: 0x7d7464, crate: 0x8a5a2b, brazier: 0x4a4038, door: 0x7a4f2a, ember: 0xff9a3c };

  /** Hit point ring colour by remaining fraction: the first row whose `above` the fraction exceeds. */
  const HP_RING_COLORS = [
    { above: 0.5, color: 0x6fae5a },
    { above: 0.25, color: 0xd9a531 },
    { above: -1, color: 0xc2452f },
  ];
  const BRASS = 0xc39a4a;
  /** Another player's pointer hovers above the pieces so it is never buried in one. Heights in world units. */
  const CURSOR = { RADIUS: 0.17, LENGTH: 0.42, TIP_HEIGHT: 1.05, LABEL_GAP: 0.3, LABEL_SCALE: 0.75 };
  const LABEL = { WIDTH: 256, HEIGHT: 64, FONT: '600 30px Georgia, serif', MAX_CHARACTERS: 18, WORLD_WIDTH: 1.7 };

  // ---- shared helpers ----------------------------------------------------------------------------------------------

  /**
   * Maps between board coordinates (cells, fractional, origin at the centre of the top-left cell) and world
   * coordinates (the board is centred on the world origin, x right, z towards the camera).
   * @returns {{resize: function(number, number): void, toWorld: function(number, number): {x: number, z: number}, toCells: function(number, number): {x: number, y: number}}}
   */
  function boardSpace() {
    let offsetX = 0, offsetY = 0;
    return {
      resize(width, height) {
        offsetX = (width - 1) / 2;
        offsetY = (height - 1) / 2;
      },
      toWorld: (cellX, cellY) => ({ x: cellX - offsetX, z: cellY - offsetY }),
      toCells: (worldX, worldZ) => ({ x: worldX + offsetX, y: worldZ + offsetY }),
    };
  }

  /** Remove an object from the scene and free the GPU resources it alone owns (marked with userData.isOwned). */
  function discard(object) {
    if (object.parent) object.parent.remove(object);
    object.traverse((child) => {
      if (!child.userData.isOwned) return;
      if (child.geometry) child.geometry.dispose();
      [].concat(child.material || []).forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
  }
  const owned = (object) => {
    object.userData.isOwned = true;
    return object;
  };

  /**
   * A text label that always faces the camera. The text is painted onto a canvas, so text from other players can
   * never be interpreted as markup.
   * @param {Object} ctx
   * @param {string} text
   * @param {{color?: string}} [options]
   * @returns {Object} a THREE.Sprite that owns its texture
   */
  function textSprite(ctx, text, { color = '#f1e6c8' } = {}) {
    const texture = ctx.make.canvasTexture(LABEL.WIDTH, LABEL.HEIGHT, (context, width, height) => {
      context.font = LABEL.FONT;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.lineWidth = 6;
      context.strokeStyle = 'rgba(15, 10, 6, 0.9)';
      context.fillStyle = color;
      const shown = String(text).slice(0, LABEL.MAX_CHARACTERS);
      context.strokeText(shown, width / 2, height / 2);
      context.fillText(shown, width / 2, height / 2);
    });
    const sprite = owned(new ctx.THREE.Sprite(new ctx.THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, toneMapped: false })));
    sprite.scale.set(LABEL.WORLD_WIDTH, (LABEL.WORLD_WIDTH * LABEL.HEIGHT) / LABEL.WIDTH, 1);
    sprite.renderOrder = 5;
    return sprite;
  }

  // ---- the map and its fog -----------------------------------------------------------------------------------------

  /**
   * Builders for free-standing props. Each returns a mesh with its own material (so fog can dim it alone), placed
   * relative to the centre of its cell.
   * @type {Object<string, function(Object, {alongX: boolean}): Object>}
   */
  const PROP_BUILDERS = {
    pillar: ({ make }) => make.cyl(0.3, 0.36, 1.1, make.mat(PROP_COLORS.pillar, { fresh: true, rough: 0.9 }), { at: [0, 0.55, 0], parent: null, seg: 10 }),
    crate: ({ make }) => make.box(0.62, 0.5, 0.62, make.mat(PROP_COLORS.crate, { fresh: true, rough: 0.85 }), { at: [0, 0.25, 0], parent: null }),
    brazier({ make }) {
      const bowl = make.cyl(0.26, 0.14, 0.42, make.mat(PROP_COLORS.brazier, { fresh: true, emissive: PROP_COLORS.ember, emissiveIntensity: 0.55 }), { at: [0, 0.21, 0], parent: null, seg: 8 });
      make.glow(PROP_COLORS.ember, 1.6, { parent: bowl, at: [0, 0.5, 0], opacity: 0.55 });
      return bowl;
    },
    // A shut door spans its passage; an open one is swung flat against the side of it.
    doorShut: ({ make }, { alongX }) => make.box(alongX ? 1 : SIZE.DOOR_THICKNESS, SIZE.WALL_HEIGHT * 0.9, alongX ? SIZE.DOOR_THICKNESS : 1, make.mat(PROP_COLORS.door, { fresh: true, rough: 0.8 }), { at: [0, SIZE.WALL_HEIGHT * 0.45, 0], parent: null }),
    doorOpen({ make }, { alongX }) {
      const swung = make.box(alongX ? SIZE.DOOR_THICKNESS : 0.9, SIZE.WALL_HEIGHT * 0.9, alongX ? 0.9 : SIZE.DOOR_THICKNESS, make.mat(PROP_COLORS.door, { fresh: true, rough: 0.8 }), { parent: null });
      swung.position.set(alongX ? -0.42 : 0, SIZE.WALL_HEIGHT * 0.45, alongX ? 0 : -0.42);
      return swung;
    },
  };

  /**
   * The map: floor tiles, wall blocks and props, each dimmed by a per-cell light level (1 lit, 0 unexplored).
   * @param {Object} ctx    the game context
   * @param {Object} space  from boardSpace()
   * @returns {{rebuild: function(Object): void, setLight: function(Float32Array, boolean=): void, update: function(number): void, clear: function(): void}}
   */
  function boardView(ctx, space) {
    const { THREE, make } = ctx;
    const scratchColor = new THREE.Color();
    // Tiles and walls use a material with no specular highlight: with one, a cell multiplied down to black would
    // still catch a grey sheen from the lamp and unexplored walls would show through the fog.
    const fogMaterial = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
    let root = null, floor = null, walls = null;
    /** @type {Array<{mesh: Object, cell: number, baseColor: Object}>} */
    let props = [];
    let wallCells = [], tileColors = [], wallColor = null;
    let lightNow = new Float32Array(0), lightGoal = new Float32Array(0);
    let isSettling = false;

    function clear() {
      if (root) discard(root);
      root = floor = walls = null;
      props = [];
    }

    /** Does the passage through this door cell run north-south (so the door panel lies along x)? */
    const doorLiesAlongX = (board, x, y) => {
      const isSolid = (cellX, cellY) => !board.inside(cellX, cellY) || (board.get(cellX, cellY).blocksMove && !board.get(cellX, cellY).isDoor);
      return isSolid(x - 1, y) && isSolid(x + 1, y);
    };

    /**
     * Build the map from a board grid (kit/tabletop.js boardOf). Light levels carry over when the size is unchanged,
     * so painting a wall does not flash the whole board.
     * @param {Object} board  a Kit.grid of Terrain
     */
    function rebuild(board) {
      clear();
      const cellCount = board.w * board.h;
      space.resize(board.w, board.h);
      if (lightNow.length !== cellCount) {
        lightNow = new Float32Array(cellCount);
        lightGoal = new Float32Array(cellCount);
      }
      root = make.group();
      const cells = board.find(() => true);
      const lookOf = (cell) => TERRAIN_LOOK[cell.v.id] || TERRAIN_LOOK.wall;

      tileColors = cells.map((cell) => make.color(lookOf(cell).tile).multiplyScalar((cell.x + cell.y) % 2 ? CHECKER_SHADE : 1));
      floor = owned(make.instanced(new THREE.BoxGeometry(SIZE.TILE, SIZE.TILE_THICKNESS, SIZE.TILE), fogMaterial(), cellCount, { parent: root, shadow: true }));
      cells.forEach((cell, index) => {
        const at = space.toWorld(cell.x, cell.y);
        floor.place(index, at.x, -SIZE.TILE_THICKNESS / 2, at.z);
      });
      floor.commit();

      const blocks = cells.filter((cell) => lookOf(cell).block !== undefined);
      wallCells = blocks.map((cell) => cell.y * board.w + cell.x);
      wallColor = make.color(TERRAIN_LOOK.wall.block);
      walls = owned(make.instanced(new THREE.BoxGeometry(1, SIZE.WALL_HEIGHT, 1), fogMaterial(), Math.max(1, blocks.length), { parent: root, shadow: true }));
      blocks.forEach((cell, index) => {
        const at = space.toWorld(cell.x, cell.y);
        walls.place(index, at.x, SIZE.WALL_HEIGHT / 2, at.z);
      });
      walls.commit();

      props = cells.filter((cell) => lookOf(cell).prop).map((cell) => {
        const mesh = owned(PROP_BUILDERS[lookOf(cell).prop](ctx, { alongX: doorLiesAlongX(board, cell.x, cell.y) }));
        const at = space.toWorld(cell.x, cell.y);
        mesh.position.x += at.x;
        mesh.position.z += at.z;
        root.add(mesh);
        return { mesh, cell: cell.y * board.w + cell.x, baseColor: mesh.material.color.clone() };
      });
      paint();
      isSettling = true;
    }

    /** Write the current light levels into the instance colours. Hot path: runs every frame while fog is fading, so index loops. */
    function paint() {
      for (let cell = 0; cell < lightNow.length; cell++) floor.setColorAt(cell, scratchColor.copy(tileColors[cell]).multiplyScalar(lightNow[cell]));
      for (let index = 0; index < wallCells.length; index++) walls.setColorAt(index, scratchColor.copy(wallColor).multiplyScalar(lightNow[wallCells[index]]));
      floor.instanceColor.needsUpdate = true;
      if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
      props.forEach((prop) => {
        prop.mesh.material.color.copy(prop.baseColor).multiplyScalar(lightNow[prop.cell]);
        prop.mesh.visible = lightNow[prop.cell] > 0.03; // an unexplored prop must not show as a black silhouette
      });
    }

    return {
      rebuild,
      clear,
      /**
       * Set the light every cell should fade to.
       * @param {Float32Array} levels      one value per cell, 0 (unexplored, black) to 1 (in view)
       * @param {boolean} [isInstant]      skip the fade (first frame of a table)
       */
      setLight(levels, isInstant = false) {
        lightGoal.set(levels);
        if (isInstant) lightNow.set(levels);
        isSettling = true;
      },
      update(dt) {
        if (!isSettling || !floor) return;
        let largestGap = 0;
        for (let cell = 0; cell < lightNow.length; cell++) {
          lightNow[cell] = damp(lightNow[cell], lightGoal[cell], MOTION.LIGHT_RATE, dt);
          largestGap = Math.max(largestGap, Math.abs(lightGoal[cell] - lightNow[cell]));
        }
        if (largestGap < MOTION.LIGHT_EPSILON) {
          lightNow.set(lightGoal);
          isSettling = false;
        }
        paint();
      },
    };
  }

  // ---- standing pieces ---------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} TokenLook       how one token should appear to this viewer right now
   * @property {boolean} isShown       false hides it entirely (fog, or hidden from players)
   * @property {boolean} isGhost       drawn translucent: a hidden token as its game master sees it
   * @property {boolean} isActing      it is this token's turn
   * @property {boolean} isSelected
   */

  /** Body shapes by token kind, so player characters and the game master's creatures read differently at a glance. */
  const BODY_BUILDERS = {
    pc(make, material, parent) {
      make.cyl(0.11, 0.25, 0.56, material, { at: [0, 0.38, 0], parent, seg: 12 });
      make.sphere(0.17, material, { at: [0, 0.78, 0], parent });
    },
    npc(make, material, parent) {
      make.cone(0.3, 0.62, material, { at: [0, 0.41, 0], parent, seg: 5 });
      make.ico(0.17, 0, material, { at: [0, 0.8, 0], parent });
    },
  };
  const GHOST_OPACITY = 0.45;
  const CONDITION_COLORS = Object.fromEntries(Kit.tabletop.CONDITIONS.map((condition) => [condition.id, condition.color]));

  /**
   * The pieces on the board: a coloured base, a body, a hit point ring, condition beads and a name.
   * @param {Object} ctx
   * @param {Object} space
   * @returns {Object} { sync, remove, clear, ids, hold, release, isHeld, nearest, positionOf, update }
   */
  function tokenViews(ctx, space) {
    const { THREE, make } = ctx;
    const views = new Map();
    const ringGeometry = (fraction) => new THREE.RingGeometry(SIZE.TOKEN_BASE_RADIUS + 0.06, SIZE.TOKEN_BASE_RADIUS + 0.15, 40, 1, 0, TAU * clamp(fraction, 0.001, 1));
    const flat = (mesh) => {
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    };

    /** Everything about a token that changes its body or label; when this text changes the figure is rebuilt. */
    const figureSignature = (token, look) => [token.name, token.color, token.kind, look.isGhost].join('|');

    function buildFigure(view, token, look) {
      if (view.figure) discard(view.figure);
      const figure = (view.figure = new THREE.Group());
      const colorNumber = parseInt(token.color.slice(1), 16);
      const material = make.mat(colorNumber, { fresh: true, rough: 0.55, opacity: look.isGhost ? GHOST_OPACITY : 1 });
      const parts = new THREE.Group();
      make.cyl(SIZE.TOKEN_BASE_RADIUS, SIZE.TOKEN_BASE_RADIUS + 0.03, 0.1, material, { at: [0, 0.05, 0], parent: parts, seg: 24 });
      BODY_BUILDERS[token.kind](make, material, parts);
      parts.children.forEach(owned); // the fresh material and these geometries belong to this figure alone
      const label = textSprite(ctx, token.name || 'Unnamed');
      label.position.y = SIZE.LABEL_HEIGHT;
      figure.add(parts, label);
      view.group.add(figure);
    }

    function buildRing(view, token) {
      if (view.ring) discard(view.ring);
      const fraction = token.hp / token.hpMax;
      const ringColor = HP_RING_COLORS.find((row) => fraction > row.above).color;
      const ring = (view.ring = new THREE.Group());
      ring.add(owned(flat(new THREE.Mesh(ringGeometry(1), make.unlit(0x1a120b, { opacity: 0.55 })))));
      if (token.hp > 0) ring.add(owned(flat(new THREE.Mesh(ringGeometry(fraction), make.unlit(ringColor)))));
      // Start the arc at the top and run clockwise, like a clock face emptying.
      ring.children.forEach((arc) => (arc.rotation.z = Math.PI / 2));
      ring.position.y = SIZE.OVERLAY_Y;
      view.group.add(ring);
    }

    function buildConditions(view, token) {
      if (view.beads) discard(view.beads);
      const beads = (view.beads = new THREE.Group());
      token.conditions.forEach((id, index) => {
        const angle = (index / Math.max(1, token.conditions.length)) * TAU;
        owned(make.sphere(0.07, make.unlit(parseInt(CONDITION_COLORS[id].slice(1), 16)), { at: [Math.cos(angle) * 0.3, 1.02, Math.sin(angle) * 0.3], parent: beads, shadow: false }));
      });
      view.group.add(beads);
    }

    function createView(id) {
      const group = make.group();
      const turnRing = owned(flat(new THREE.Mesh(new THREE.RingGeometry(0.58, 0.68, 40), make.unlit(BRASS, { bright: 1.6 }))));
      const selectRing = owned(flat(new THREE.Mesh(new THREE.RingGeometry(0.56, 0.6, 40), make.unlit(0xf1e6c8))));
      turnRing.position.y = selectRing.position.y = SIZE.OVERLAY_Y;
      group.add(turnRing, selectRing);
      const view = { group, turnRing, selectRing, figure: null, ring: null, beads: null, signature: '', ringSignature: '', beadSignature: '', path: [], goal: null, held: null, lift: 0 };
      views.set(id, view);
      return view;
    }

    /**
     * Show a token as given, creating or updating its piece. A change of cell glides the piece to the new cell.
     * @param {string} id
     * @param {Object} token   a cleaned Token
     * @param {TokenLook} look
     */
    function sync(id, token, look) {
      const view = views.get(id) || createView(id);
      const signature = figureSignature(token, look);
      if (signature !== view.signature) buildFigure(view, token, look), (view.signature = signature);
      const ringSignature = `${token.hp}/${token.hpMax}`;
      if (ringSignature !== view.ringSignature) buildRing(view, token), (view.ringSignature = ringSignature);
      const beadSignature = token.conditions.join();
      if (beadSignature !== view.beadSignature) buildConditions(view, token), (view.beadSignature = beadSignature);
      view.group.visible = look.isShown;
      view.turnRing.visible = look.isActing;
      view.selectRing.visible = look.isSelected && !look.isActing;
      const at = space.toWorld(token.x, token.y);
      if (!view.goal) view.group.position.set(at.x, 0, at.z); // first appearance: no glide from the origin
      else if (view.goal.x !== token.x || view.goal.y !== token.y) view.path = [at];
      view.goal = { x: token.x, y: token.y };
    }

    function remove(id) {
      const view = views.get(id);
      if (!view) return;
      discard(view.group);
      views.delete(id);
    }

    /** Move one piece for a frame: follow the finger while held, otherwise step along its path with a small hop. */
    function advance(view, dt, time) {
      const position = view.group.position;
      if (view.held) {
        position.x = damp(position.x, view.held.x, MOTION.HOLD_FOLLOW_RATE, dt);
        position.z = damp(position.z, view.held.z, MOTION.HOLD_FOLLOW_RATE, dt);
        view.lift = damp(view.lift, SIZE.TOKEN_LIFT, MOTION.HOLD_FOLLOW_RATE, dt);
      } else {
        let travel = MOTION.WALK_CELLS_PER_SECOND * dt;
        while (view.path.length && travel > 0) {
          const next = view.path[0];
          const gap = Math.hypot(next.x - position.x, next.z - position.z);
          if (gap <= travel) (position.x = next.x), (position.z = next.z), view.path.shift();
          else (position.x += ((next.x - position.x) / gap) * travel), (position.z += ((next.z - position.z) / gap) * travel);
          travel -= gap;
        }
        const hop = view.path.length ? Math.abs(Math.sin(time * MOTION.WALK_CELLS_PER_SECOND * Math.PI)) * MOTION.HOP_HEIGHT : 0;
        view.lift = damp(view.lift, hop, MOTION.SETTLE_RATE, dt);
      }
      position.y = view.lift;
      if (view.turnRing.visible) view.turnRing.scale.setScalar(1 + 0.06 * Math.sin(time * 3));
    }

    return {
      sync,
      remove,
      clear: () => [...views.keys()].forEach(remove),
      ids: () => [...views.keys()],
      /** Lift a piece and make it follow a board position (the local finger, or another player's drag). */
      hold(id, cellX, cellY) {
        const view = views.get(id);
        if (view) view.held = space.toWorld(cellX, cellY);
      },
      /** Let go of a held piece. It settles onto its current cell (or the new one, when a move follows). */
      release(id) {
        const view = views.get(id);
        if (!view || !view.held) return;
        view.held = null;
        if (!view.path.length && view.goal) view.path = [space.toWorld(view.goal.x, view.goal.y)];
      },
      isHeld: (id) => !!(views.get(id) && views.get(id).held),
      /**
       * The visible piece nearest a world point.
       * @returns {string|null} token id, or null when none is within `reach` world units
       */
      nearest(worldX, worldZ, reach) {
        const candidates = [...views.entries()].filter(([, view]) => view.group.visible).map(([id, view]) => ({ id, distance: Math.hypot(view.group.position.x - worldX, view.group.position.z - worldZ) }));
        const closest = candidates.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best), { id: null, distance: reach });
        return closest.id;
      },
      positionOf: (id) => (views.has(id) ? views.get(id).group.position : null),
      update(dt, time) {
        views.forEach((view) => advance(view, dt, time));
      },
    };
  }

  // ---- other players' cursors --------------------------------------------------------------------------------------

  /**
   * A small pointer and name for every other player who shares where they are pointing.
   * @param {Object} ctx
   * @param {Object} space
   * @returns {{sync: function(Array<{peer: string, name: string, color: string, cursor: {x: number, y: number}}>): void, update: function(number): void, clear: function(): void}}
   */
  function cursorViews(ctx, space) {
    const { make } = ctx;
    const views = new Map();
    function createView(peer) {
      const group = make.group();
      const colorNumber = parseInt(peer.color.slice(1), 16);
      const pointer = owned(make.cone(CURSOR.RADIUS, CURSOR.LENGTH, make.unlit(colorNumber), { parent: group, at: [0, CURSOR.TIP_HEIGHT + CURSOR.LENGTH / 2, 0], seg: 4, shadow: false }));
      pointer.rotation.x = Math.PI; // the tip points down at the board
      const label = textSprite(ctx, peer.name, { color: peer.color });
      label.position.y = CURSOR.TIP_HEIGHT + CURSOR.LENGTH + CURSOR.LABEL_GAP;
      label.scale.multiplyScalar(CURSOR.LABEL_SCALE);
      group.add(label);
      return { group, name: peer.name, color: peer.color, target: null };
    }
    return {
      /** Show exactly these peers. A peer whose name or colour changed gets a fresh pointer. */
      sync(peers) {
        const wanted = new Map(peers.map((peer) => [peer.peer, peer]));
        [...views.keys()].filter((id) => !wanted.has(id) || views.get(id).name !== wanted.get(id).name || views.get(id).color !== wanted.get(id).color).forEach((id) => {
          discard(views.get(id).group);
          views.delete(id);
        });
        wanted.forEach((peer, id) => {
          const isNew = !views.has(id);
          const view = views.get(id) || views.set(id, createView(peer)).get(id);
          view.target = space.toWorld(peer.cursor.x, peer.cursor.y);
          if (isNew) view.group.position.set(view.target.x, 0, view.target.z);
        });
      },
      update(dt) {
        views.forEach((view) => {
          view.group.position.x = damp(view.group.position.x, view.target.x, MOTION.CURSOR_RATE, dt);
          view.group.position.z = damp(view.group.position.z, view.target.z, MOTION.CURSOR_RATE, dt);
        });
      },
      clear() {
        views.forEach((view) => discard(view.group));
        views.clear();
      },
    };
  }

  // ---- overlays: path preview, rulers, ink -------------------------------------------------------------------------

  const PATH = { MAX_STEPS: 64, DOT_RADIUS: 0.13, COLOR: 0xecdfc2, TOO_FAR_COLOR: 0xd9705c };

  /**
   * Dots along a route and a ring on its last cell, shown while a piece is being dragged.
   * @returns {{show: function(Array<{x: number, y: number}>, boolean): void, hide: function(): void}}
   */
  function pathView(ctx, space) {
    const { THREE, make } = ctx;
    const dots = make.instanced(new THREE.CylinderGeometry(PATH.DOT_RADIUS, PATH.DOT_RADIUS, 0.02, 12), make.unlit(0xffffff, { fresh: true, opacity: 0.85 }), PATH.MAX_STEPS);
    const endRing = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.47, 32), make.unlit(0xffffff, { fresh: true }));
    endRing.rotation.x = -Math.PI / 2;
    ctx.scene.add(endRing);
    const hide = () => (dots.visible = endRing.visible = false);
    hide();
    return {
      hide,
      /** @param {Array<{x: number, y: number}>} cells route including the start @param {boolean} isTooFar tint as "beyond a normal move" */
      show(cells, isTooFar) {
        const tint = make.color(isTooFar ? PATH.TOO_FAR_COLOR : PATH.COLOR);
        dots.material.color.copy(tint);
        endRing.material.color.copy(tint);
        Array.from({ length: PATH.MAX_STEPS }, (unused, index) => index).forEach((index) => {
          const cell = cells[index + 1]; // the start cell itself needs no dot
          const at = cell ? space.toWorld(cell.x, cell.y) : null;
          dots.place(index, at ? at.x : 0, at ? SIZE.OVERLAY_Y : -999, at ? at.z : 0, at ? 1 : 0);
        });
        dots.commit();
        const last = space.toWorld(cells[cells.length - 1].x, cells[cells.length - 1].y);
        endRing.position.set(last.x, SIZE.OVERLAY_Y, last.z);
        dots.visible = endRing.visible = true;
      },
    };
  }

  const RIBBON_WIDTH = { INK: 0.07, RULER: 0.05 };

  /**
   * A flat ribbon along a polyline on the board: one quad per segment.
   * @param {Object} THREE
   * @param {Array<{x: number, z: number}>} worldPoints
   * @param {number} width
   * @returns {Object} THREE.BufferGeometry
   */
  function ribbonGeometry(THREE, worldPoints, width) {
    const segments = worldPoints.slice(1).map((end, index) => ({ start: worldPoints[index], end })).filter(({ start, end }) => start.x !== end.x || start.z !== end.z);
    const positions = segments.flatMap(({ start, end }) => {
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      // The segment's sideways unit vector, scaled to half the ribbon's width.
      const sideX = (-(end.z - start.z) / length) * (width / 2), sideZ = ((end.x - start.x) / length) * (width / 2);
      const corners = [[start.x - sideX, start.z - sideZ], [start.x + sideX, start.z + sideZ], [end.x + sideX, end.z + sideZ], [end.x - sideX, end.z - sideZ]];
      // Two triangles per quad, wound so the face points up.
      return [0, 1, 2, 0, 2, 3].flatMap((corner) => [corners[corner][0], SIZE.OVERLAY_Y, corners[corner][1]]);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /** How much of a cell an area template tints, leaving the grid lines readable, and how see-through the tint is. */
  const AREA_PATCH = { SIZE: 0.9, OPACITY: 0.38 };

  /**
   * Flat squares covering a set of cells: the tint of an area template.
   * @param {Object} THREE
   * @param {Array<{x: number, z: number}>} worldCentres
   * @returns {Object} THREE.BufferGeometry
   * @complexity O(cells) time and space; rebuilt only when the template changes.
   */
  function patchGeometry(THREE, worldCentres) {
    const half = AREA_PATCH.SIZE / 2;
    const corners = [[-half, -half], [-half, half], [half, half], [half, -half]];
    const positions = worldCentres.flatMap((centre) => [0, 1, 2, 0, 2, 3].flatMap((corner) => [centre.x + corners[corner][0], SIZE.OVERLAY_Y, centre.z + corners[corner][1]]));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /**
   * Named flat shapes lying on the board: set one by key, remove it, or clear them all. Lines (ink, rulers) and area
   * tints are the same thing with a different geometry.
   * @param {Object} ctx
   * @param {Object} space
   * @param {function(Object, Array<{x: number, z: number}>): Object} toGeometry  (THREE, world points) -> BufferGeometry
   * @param {number} [opacity=1]
   * @returns {{set: function(string, Array<{x: number, y: number}>, string): void, remove: function(string): void, keys: function(): string[], clear: function(): void}}
   */
  function overlayViews(ctx, space, toGeometry, opacity = 1) {
    const { THREE, make } = ctx;
    const shapes = new Map();
    const remove = (key) => {
      if (!shapes.has(key)) return;
      discard(shapes.get(key));
      shapes.delete(key);
    };
    return {
      remove,
      keys: () => [...shapes.keys()],
      clear: () => [...shapes.keys()].forEach(remove),
      /** @param {string} key @param {Array<{x: number, y: number}>} cellPoints board coordinates @param {string} color "#rrggbb" */
      set(key, cellPoints, color) {
        remove(key);
        const material = make.unlit(parseInt(color.slice(1), 16), { fresh: true, opacity });
        material.side = THREE.DoubleSide;
        material.depthWrite = false; // overlays sit on the tiles and must never hide the pieces standing on them
        const mesh = owned(new THREE.Mesh(toGeometry(THREE, cellPoints.map((point) => space.toWorld(point.x, point.y))), material));
        ctx.scene.add(mesh);
        shapes.set(key, mesh);
      },
    };
  }
  /** Ribbons along polylines (ink strokes, rulers). @param {number} width ribbon width in world units */
  const lineViews = (ctx, space, width) => overlayViews(ctx, space, (THREE, points) => ribbonGeometry(THREE, points, width));
  /** Tints over sets of cells (area templates). */
  const areaViews = (ctx, space) => overlayViews(ctx, space, patchGeometry, AREA_PATCH.OPACITY);

  // ---- dice --------------------------------------------------------------------------------------------------------

  const DICE = {
    MAX_SHOWN: 10, // more dice than this are rolled but not thrown as objects
    DROP_HEIGHT: 2.4,
    SETTLE_SECONDS: 1.05, // when faces are read out
    LINGER_SECONDS: 4.2, // when the dice are cleared away
    HALF_EXTENT: 0.2, // every die tumbles as a small box: cheap and convincing enough
    THROW_SPEED: 2.6,
    SPIN: 14,
    DAMPING: 0.35, // keeps dice near where they were thrown instead of rolling across the map
    BODY_COLOR: 0xefe2c0,
    DROPPED_OPACITY: 0.35,
  };
  /** Die shapes by number of sides; other sizes use the twenty-sider's shape. @type {Object<number, function(Object): Object>} */
  const DIE_GEOMETRIES = {
    4: (THREE) => new THREE.TetrahedronGeometry(0.34),
    6: (THREE) => new THREE.BoxGeometry(0.42, 0.42, 0.42),
    8: (THREE) => new THREE.OctahedronGeometry(0.32),
    10: (THREE) => new THREE.OctahedronGeometry(0.3).scale(0.85, 1.3, 0.85),
    12: (THREE) => new THREE.DodecahedronGeometry(0.3),
    20: (THREE) => new THREE.IcosahedronGeometry(0.32),
  };

  /**
   * Physical dice: thrown with Kit.physics, then each shows its (already decided) face as a number above it.
   * The physics is for feel only; the values come from the seeded roll so every screen shows the same result.
   * @param {Object} ctx
   * @returns {{throwDice: function(Array<Object>, {x: number, z: number}): void, update: function(number): void, clear: function(): void}}
   */
  function diceView(ctx) {
    const { THREE, make, math } = ctx;
    const physics = Kit.physics({ gravity: -30, friction: 0.6, restitution: 0.35 });
    const table = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    table.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // a cannon plane faces +z; lay it flat facing up
    physics.add(null, table);
    let thrown = [], age = 0, areFacesShown = false;

    function clear() {
      thrown.forEach(({ mesh, body, label }) => {
        physics.remove(body);
        discard(mesh);
        if (label) discard(label);
      });
      thrown = [];
    }
    function showFaces() {
      areFacesShown = true;
      thrown.forEach((entry) => {
        const isTopFace = entry.die.value === entry.die.sides;
        entry.label = textSprite(ctx, String(entry.die.value), { color: isTopFace ? '#ffd27a' : '#f1e6c8' });
        entry.label.position.set(entry.mesh.position.x, 0.75, entry.mesh.position.z);
        ctx.scene.add(entry.label);
        if (!entry.die.isKept) entry.mesh.material.opacity = entry.label.material.opacity = DICE.DROPPED_OPACITY;
      });
    }

    return {
      clear,
      /**
       * @param {Array<{value: number, sides: number, isKept: boolean}>} dice  from Kit.dice.roll(...).dice
       * @param {{x: number, z: number}} origin  world point to throw around
       */
      throwDice(dice, origin) {
        clear();
        age = 0;
        areFacesShown = false;
        thrown = dice.slice(0, DICE.MAX_SHOWN).map((die, index) => {
          const geometry = (DIE_GEOMETRIES[die.sides] || DIE_GEOMETRIES[20])(THREE);
          const mesh = owned(make.mesh(geometry, make.mat(DICE.BODY_COLOR, { fresh: true, flat: true, rough: 0.4 })));
          mesh.material.transparent = true;
          mesh.position.set(origin.x + (index - (dice.length - 1) / 2) * 0.55, DICE.DROP_HEIGHT + index * 0.25, origin.z + math.rand(-0.4, 0.4));
          const body = physics.box(mesh, [2 * DICE.HALF_EXTENT, 2 * DICE.HALF_EXTENT, 2 * DICE.HALF_EXTENT], { mass: 1 });
          body.linearDamping = body.angularDamping = DICE.DAMPING;
          body.velocity.set(math.rand(-1, 1) * DICE.THROW_SPEED, 0, math.rand(-1, 1) * DICE.THROW_SPEED);
          body.angularVelocity.set(math.rand(-1, 1) * DICE.SPIN, math.rand(-1, 1) * DICE.SPIN, math.rand(-1, 1) * DICE.SPIN);
          return { die, mesh, body, label: null };
        });
      },
      update(dt) {
        if (!thrown.length) return;
        age += dt;
        physics.step(dt);
        if (!areFacesShown && age >= DICE.SETTLE_SECONDS) showFaces();
        if (areFacesShown) thrown.forEach((entry) => entry.label.position.set(entry.mesh.position.x, 0.75, entry.mesh.position.z));
        if (age >= DICE.LINGER_SECONDS) clear();
      },
    };
  }

  Kit.tableParts = Object.assign(Kit.tableParts || {}, { boardSpace, boardView, tokenViews, cursorViews, pathView, lineViews, areaViews, diceView, RIBBON_WIDTH, DICE });
})();
