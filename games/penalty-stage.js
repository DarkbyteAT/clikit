/**
 * Spot Kick Showdown stage: everything drawn that is not a character's performance. The pitch, the goal and its
 * net, the stands and their crowd, the ball, the aim line and the confetti are all dressed meshes of one
 * `Kit.look.view` in the pixel preset, coloured from one world palette, so the ground and the characters are
 * one low-resolution picture.
 *
 * Owns:  the ground looks (`LOOKS`: a palette per stadium), the camera seats as rules that fit any screen
 *        (`SEATS`), and `build(ctx)`: the scene and the small handles the game drives it with (ball, net, aim,
 *        marker, crowd, bits, flags, figures, camera, picking a point of the keeper's plane), plus two
 *        measurements for playtests: `framing()` (where the goal, the ball and the characters are on screen)
 *        and `budget()` (triangles and draw calls by object).
 * Does not own: rules (games/penalty-sim.js), how characters move (games/penalty-perform.js), the HUD
 *        (games/penalty.js), the look pipeline (kit/look-*.js) or the net's physics (kit/netting.js).
 *
 * Needs THREE; nothing here runs at load time, so the file is harmless in node.
 * Exposed as the global SPOT_KICK_STAGE.
 */
(() => {
  const DATA = window.SPOT_KICK_DATA, SIM = window.SPOT_KICK_SIM;
  const { FIELD } = DATA;
  const { goal } = FIELD;
  const { clamp, lerp, damp } = Kit.math;
  const TURN = Math.PI * 2;
  const RADIANS = Math.PI / 180;
  /** Numbers per vertex position, and vertices per triangle. */
  const STRIDE = 3;

  // =================================================== looks and seats ===================================================

  /** Ramps every ground has, in atlas order. `crowd0..5` and `bit0..3` must stay together: instances index into them. */
  const WORLD_RAMPS = ['grass', 'stripe', 'line', 'frame', 'net', 'stand', 'step', 'board', 'boardAlt', 'shade', 'ballPanel', 'ballPatch', 'aim', 'sky', 'haze', 'flag', 'lamp', 'skin0', 'skin1', 'skin2', 'crowd0', 'crowd1', 'crowd2', 'crowd3', 'crowd4', 'crowd5', 'bit0', 'bit1', 'bit2', 'bit3'];
  const CROWD_COLORS = 6;
  const SKIN_COLORS = 3;

  /** Colours every ground shares: the frame, the ball's defaults, skins, confetti. */
  const SHARED_COLORS = { line: '#f2f1e4', frame: '#f7f6ef', net: '#e3eaf0', ballPanel: '#f4f1e8', ballPatch: '#2b2f3a', aim: '#ffe86b', skin0: '#e9b48c', skin1: '#b9794f', skin2: '#6b4630', bit0: '#ffd84a', bit1: '#ff5f6d', bit2: '#58d0ff', bit3: '#f7f6ef' };

  /**
   * @typedef {Object} GroundLook
   * @property {number} sky the colour behind everything (0xRRGGBB)
   * @property {Object<string, string>} colors ramp name -> base colour, over SHARED_COLORS
   * @property {number} crowd share of the seats that are taken, 0..1
   * @property {boolean} lamps are the floodlights on?
   */

  /** The grounds, by `CupRow.look`. A ground is a palette: the same meshes, recoloured by rewriting atlas rows. */
  const LOOKS = {
    park: {
      sky: 0x8fd0f2, crowd: 0.45, lamps: false,
      colors: { grass: '#57a843', stripe: '#4c9a3c', stand: '#8a7a68', step: '#a39382', board: '#e8e2d0', boardAlt: '#3f8f6a', shade: '#2f6b33', sky: '#8fd0f2', haze: '#c9ecf7', flag: '#ff6b4a', lamp: '#8a7a68', crowd0: '#d9573f', crowd1: '#3f78c4', crowd2: '#e9c84a', crowd3: '#eeeeea', crowd4: '#5aa66a', crowd5: '#8a5fb5' },
    },
    harbour: {
      sky: 0x9fb6c4, crowd: 0.7, lamps: false,
      colors: { grass: '#4a9a66', stripe: '#418c5c', stand: '#51667a', step: '#64798c', board: '#1f4f78', boardAlt: '#e9eef0', shade: '#2a6146', sky: '#9fb6c4', haze: '#d5e2e6', flag: '#ffd23f', lamp: '#51667a', crowd0: '#2f6ea8', crowd1: '#e8eef2', crowd2: '#e2733a', crowd3: '#2b3a52', crowd4: '#7fc2d6', crowd5: '#f0c64a' },
    },
    lights: {
      sky: 0x141a33, crowd: 1, lamps: true,
      colors: { grass: '#3f9f58', stripe: '#36904d', stand: '#2a2f4a', step: '#363c5c', board: '#b3202e', boardAlt: '#f3d24a', shade: '#1d5a35', sky: '#141a33', haze: '#27305a', flag: '#f3d24a', lamp: '#fff6c8', crowd0: '#c9354a', crowd1: '#f3d24a', crowd2: '#e9e9f2', crowd3: '#3b4f9a', crowd4: '#7a3fb0', crowd5: '#e8843a' },
    },
  };

  /**
   * How much of the top of the screen the HUD covers, CSS pixels: the scoreboard and its chips. A seat tilts the
   * camera so that its top subject sits just below this band, whatever the screen's size. The theme
   * (games/penalty-theme.js) lays the HUD out inside these bands; change them together. A playtest checks the
   * pair: no HUD panel's rectangle may meet the goal's (`framing().goal`).
   */
  const HUD_BAND = Object.freeze({ portrait: 204, landscape: 66 });

  /**
   * @typedef {Object} SeatLens
   * @property {number} [fov] vertical field of view, degrees (a seat that fits by distance)
   * @property {number} [height] the camera's height, metres (a seat that fits by distance)
   * @property {number[]} [fovRange] [least, most] vertical field of view, degrees (a seat with a fixed place)
   * @property {number} rows texel rows of the picture: fewer rows are bigger texels
   */

  /**
   * @typedef {Object} SeatRule A camera seat as rules, solved for the screen's shape by `solveSeat`.
   * @property {('goal'|'taker')} faces the end the camera looks at (that end's stand is drawn; the other is behind the camera)
   * @property {{z: number, halfWidth: number}} fit the plane across the pitch that must be seen this wide
   * @property {{y: number, z: number, at?: number}} anchor the point the tilt is set by: it sits just below the HUD band
   *   (the highest thing that matters), or, with `at`, that share of the screen's height down from the top
   * @property {number} [least] least distance from the fit plane, metres (fit by distance)
   * @property {number[]} [at] the camera's fixed place [x, y, z] (fit by opening the lens)
   * @property {number} ballScale how much bigger than life the ball is drawn from here (a far ball must still read)
   * @property {SeatLens} portrait @property {SeatLens} landscape
   */

  /**
   * The camera seats. `aim`: raised behind the ball, the taker standing whole beside it and the goal clear above
   * their head. `flight`: a cut to just past the taker at the strike, so nothing stands between the lens and the
   * ball, the keeper and the goal. `keeper`: above and behind the bar, the player's keeper in front of the lens.
   * @type {Object<string, SeatRule>}
   */
  const SEATS = {
    aim: {
      faces: 'goal', fit: { z: SIM.LINE_Z, halfWidth: 3.1 }, anchor: { y: goal.height + 0.2, z: SIM.LINE_Z }, least: 15, ballScale: 1,
      portrait: { fov: 50, height: 4.0, rows: 300 },
      landscape: { fov: 42, height: 4.0, rows: 200 },
    },
    flight: {
      faces: 'goal', fit: { z: SIM.LINE_Z, halfWidth: 2.9 }, anchor: { y: goal.height + 0.25, z: SIM.LINE_Z }, at: [0.6, 1.5, -0.15], ballScale: 1,
      portrait: { fovRange: [40, 76], rows: 300 },
      landscape: { fovRange: [40, 76], rows: 200 },
    },
    keeper: {
      faces: 'taker', fit: { z: SIM.KEEPER_Z, halfWidth: 2.95 }, anchor: { y: 0, z: SIM.KEEPER_Z, at: 0.76 }, least: 9, ballScale: 1.5,
      portrait: { fov: 56, height: 5.8, rows: 300 },
      landscape: { fov: 40, height: 5.0, rows: 200 },
    },
  };

  /**
   * Solves a seat for a screen: where the camera is, where it looks and its lens.
   * @param {SeatRule} seat
   * @param {{w: number, h: number, aspect: number, portrait: boolean}} size the screen, CSS pixels
   * @returns {{at: number[], look: number[], fov: number, rows: number}}
   * @complexity O(1)
   * @example solveSeat(SEATS.aim, { w: 390, h: 844, aspect: 390 / 844, portrait: true }).at // [0, 3.6, 7]
   */
  const solveSeat = (seat, size) => {
    const lens = seat[size.portrait ? 'portrait' : 'landscape'];
    // The camera looks along -z at the goal end and along +z at the taker's end.
    const forward = seat.faces === 'goal' ? -1 : 1;
    let at, fov;
    if (seat.at) {
      // A fixed place: the lens opens until the fit plane is in from edge to edge.
      at = seat.at;
      const depth = Math.abs(seat.fit.z - at[2]);
      const halfAngle = Math.atan(seat.fit.halfWidth / depth) + Math.atan(Math.abs(at[0]) / depth);
      fov = clamp((2 * Math.atan(Math.tan(halfAngle) / size.aspect)) / RADIANS, lens.fovRange[0], lens.fovRange[1]);
    } else {
      // A fixed lens: the camera backs off until the fit plane is in from edge to edge.
      fov = lens.fov;
      const distance = Math.max(seat.least, seat.fit.halfWidth / (Math.tan((fov / 2) * RADIANS) * size.aspect));
      at = [0, lens.height, seat.fit.z - forward * distance];
    }
    // Tilt: the anchor sits just under the HUD band, or at its own share of the way down the screen.
    const halfFov = (fov / 2) * RADIANS;
    const anchorAngle = Math.atan((at[1] - seat.anchor.y) / Math.abs(seat.anchor.z - at[2]));
    const down = seat.anchor.at === undefined ? HUD_BAND[size.portrait ? 'portrait' : 'landscape'] / size.h : seat.anchor.at;
    const pitch = anchorAngle + Math.atan((1 - 2 * down) * Math.tan(halfFov));
    const lookDepth = Math.abs(seat.fit.z - at[2]);
    return { at, look: [0, at[1] - lookDepth * Math.tan(pitch), seat.fit.z], fov, rows: lens.rows };
  };

  /** The kit's level of detail for characters in a low-resolution picture (kit/figure-shapes.js `LEVELS`). */
  const FIGURE_LEVEL = 'low';
  /** Wardrobe characters stand about 1.1 m; a footballer here stands about 1.75 m. */
  const FIGURE_SCALE = 1.6;
  /**
   * A character on screen, for `framing()`: every bone is a disc of `limb` metres, and the head (big, on these
   * characters) is a disc of `head` metres centred `headLift` above its bone.
   */
  const FIGURE_BOUNDS = Object.freeze({ limb: 0.14, head: 0.4, headLift: 0.3 });
  /** Where the player's taker waits beside the ball: this far behind it, and as far to the side as the picture allows. */
  const TAKER_WAIT = Object.freeze({ z: 1.4, halfWidth: 0.5, side: [0.75, 1.9] });

  /** The surroundings, metres. Stands and boards sit behind each end; each is hidden when the camera is behind it. */
  const SURROUND = Object.freeze({
    pitchHalfWidth: 26,
    pitchDepth: 60,
    turfThickness: 0.2,
    stripes: 8,
    stripeDepth: 2.4,
    boardZ: 3.4, // behind the goal line (and mirrored the same distance behind the taker's end)
    board: { height: 0.8, width: 3.2, depth: 0.12, gap: 0.1, count: 12 },
    standZ: 4.6,
    tiers: 7,
    tier: { rise: 0.55, run: 0.8, halfWidth: 17 },
    wall: { height: 14, depth: 0.5, tone: 0.33 },
    seat: { spacing: 0.72, setBack: 0.45, body: [0.42, 0.5, 0.3], head: 0.26 },
    takerEndZ: 9.5, // how far behind the spot the far boards stand
    lamp: { x: 13, height: 9, size: 1.6, pole: 0.25, headWidth: 2.2, headDepth: 0.3, setForward: 0.6 },
    flag: { beside: 1.6, pole: 0.03, height: 1.5, cloth: [0.5, 0.3, 0.03], sides: 6, slack: -1.35, flutter: 0.12, flutterRate: [4, 13], fullWind: 12, ease: 6 },
  });

  /** Pitch markings: line width, the six-yard box, the spot and the arc, metres. `slab` is how thick a painted line or a mown stripe is. */
  const MARKS = Object.freeze({ width: 0.09, lift: 0.012, slab: 0.004, boxHalfWidth: 4.2, boxDepth: 2.6, spotRadius: 0.11, spotSides: 8, arcRadius: 3.4, arcSteps: 14, arcSpan: 1.5, arcBeyondBox: 3.2 });
  /** Flat tone of the turf (lit evenly, so the mown stripes read as colour, not as shading). */
  const TURF_TONE = 0.66;

  /** The net: knots across and down each sheet, how wide the ball pushes it, and when it counts as still. */
  const NETTING = Object.freeze({ across: 13, down: 6, deep: 4, pushRadius: 0.42, step: 1 / 60, mostSteps: 4, still: 0.0004, near: 0.2 });
  /** Sides of the goal's round posts. */
  const POST_SIDES = 6;

  /** Palette rows: the ground's ramps plus a block of 16 for each of the four characters of a match. */
  const ATLAS_ROWS = 128;
  /** The ball as drawn: patches, how fast it visibly rolls, and its shadow and trail. */
  const BALL = Object.freeze({
    patch: 0.46, patchOut: 0.7, roll: 0.35,
    shadow: { sides: 10, spread: 1.1, perMetre: 0.25, squash: 0.8, tone: 0.5 },
    trail: { dots: 6, every: 0.03, size: 0.05, leastSpeed: 4 },
  });
  /** A character's shadow on the turf, metres across and deep. */
  const FIGURE_SHADOW = Object.freeze({ across: 0.42, deep: 0.3 });
  /** The aim line: dots, their sizes from near to far, and how fast they march. */
  const AIM = Object.freeze({ dots: 18, dot: 0.07, sizes: [1.2, 0.75], march: 14 });
  /** The rings in the keeper's plane: the taker's reticle and the keeper's dive marker (thin: it marks, it does not cover). */
  const RINGS = Object.freeze({ sides: 16, reticle: [0.2, 0.3], marker: [0.2, 0.25], spin: 2, pulse: 0.12, pulseRate: 9, inFront: 0.05 });
  /** The arrow a scouting perk floats over the taker. */
  const TELL = Object.freeze({ radius: 0.16, length: 0.42, sides: 4, height: 2.5 });
  const BITS = Object.freeze({ count: 90, colors: 4, size: 0.07, gravity: 7, drag: 1.2, life: [0.9, 1.7], spin: 9, floor: 0.03, upShare: 0.4 });
  /** A crowd member's jump when the ground erupts, metres, and how fast the wave of it runs. */
  const CHEER = Object.freeze({ jump: 0.22, rate: 9, fall: 0.7 });
  /** The crowd's fixed scatter: constants of the usual sine hash, and the primes that spread shirts and skins. */
  const SCATTER = Object.freeze({ seat: 12.9898, tier: 78.233, end: 5, scale: 43758.5453, shirt: 997, skin: 577 });
  const CAMERA_RANGE = Object.freeze({ near: 0.3, far: 80 });

  // ==================================================== geometry helpers ====================================================

  /**
   * One geometry from many: positions, normals and indices concatenated.
   * @param {THREE.BufferGeometry[]} parts geometries, indexed or not (they are disposed)
   * @returns {THREE.BufferGeometry}
   * @complexity O(total vertices)
   */
  const mergeGeometries = (parts) => {
    const positions = [], normals = [], indices = [];
    parts.forEach((part) => {
      const offset = positions.length / STRIDE;
      positions.push(...part.attributes.position.array);
      normals.push(...part.attributes.normal.array);
      const count = part.attributes.position.count;
      // A geometry without an index draws its vertices in order.
      indices.push(...Array.from(part.index ? part.index.array : { length: count }, (index, order) => (part.index ? index : order) + offset));
      part.dispose();
    });
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, STRIDE));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, STRIDE));
    merged.setIndex(indices);
    return merged;
  };

  /** A box geometry of a size, moved to a place. */
  const boxAt = (width, height, depth, x, y, z) => new THREE.BoxGeometry(width, height, depth).translate(x, y, z);
  /** A flat marking on the turf: a thin slab between two x and two z. */
  const slab = (fromX, toX, fromZ, toZ) => boxAt(Math.abs(toX - fromX), MARKS.slab, Math.abs(toZ - fromZ), (fromX + toX) / 2, MARKS.lift, (fromZ + toZ) / 2);
  /**
   * A seated spectator's part as the pitch sees it: the face towards the pitch and the top, two quads. From the
   * stands' distance a box and this card are the same few texels, at a sixth of the triangles.
   * @param {number} width @param {number} height @param {number} depth metres
   * @param {number} baseY the height of its underside
   * @param {number} facing 1 when the pitch is towards +z, -1 when towards -z
   */
  const cardOf = (width, height, depth, baseY, facing) =>
    mergeGeometries([
      new THREE.PlaneGeometry(width, height).rotateY(facing > 0 ? 0 : Math.PI).translate(0, baseY + height / 2, (facing * depth) / 2),
      new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2).translate(0, baseY + height, 0),
    ]);

  /** The screen rectangle that holds two others, or the one that exists. */
  const unionRect = (first, second) => (!first ? second : !second ? first : { left: Math.min(first.left, second.left), top: Math.min(first.top, second.top), right: Math.max(first.right, second.right), bottom: Math.max(first.bottom, second.bottom) });

  // ======================================================= the stage =======================================================

  /**
   * Builds the stage in a new pixel look view.
   * @param {Object} ctx the game context (uses `renderer`, `camera`, `size`)
   * @returns {Object} the handles described at each property below
   * @complexity build: O(seats + knots); a frame: O(knots + live bits + cheering seats), and one pose per figure
   */
  const build = (ctx) => {
    const { renderer, camera, size } = ctx;
    const view = Kit.look.view({ renderer, preset: 'pixel', atlasRows: ATLAS_ROWS });
    const world = view.atlas.load(Kit.palette.set('ground', Object.fromEntries(WORLD_RAMPS.map((name) => [name, { ...SHARED_COLORS, ...LOOKS.park.colors }[name]]))));
    const rows = world.rows;
    let look = LOOKS.park;
    let seatName = 'aim';

    /** Adds a mesh to the look scene, dressed in a world ramp. `label` names it in `budget()`. */
    const dressed = (label, geometry, ramp, part = {}, parent = view.scene) => {
      const mesh = new THREE.Mesh(geometry);
      mesh.name = label;
      parent.add(mesh);
      view.shading.dress(mesh, { ramp: rows[ramp], ...part });
      return mesh;
    };
    /** Adds an instanced mesh, dressed; every instance may take its own ramp. */
    const dressedInstances = (label, geometry, count, ramp, part, parent = view.scene) => {
      const mesh = new THREE.InstancedMesh(geometry, undefined, count);
      mesh.name = label;
      mesh.frustumCulled = false;
      parent.add(mesh);
      view.shading.dress(mesh, { ramp: rows[ramp], ...part });
      return mesh;
    };

    // ---- stands, boards, lamps: one group per end, hidden when the camera sits behind it ----
    const lineZ = SIM.LINE_Z;
    const ends = { goal: new THREE.Group(), taker: new THREE.Group() };
    Object.values(ends).forEach((group) => view.scene.add(group));
    /** z of a distance behind an end: the goal end runs towards -z, the taker's end towards +z. */
    const behind = { goal: (distance) => lineZ - distance, taker: (distance) => SURROUND.takerEndZ + distance - SURROUND.boardZ };
    const lampZ = behind.goal(SURROUND.standZ - SURROUND.lamp.setForward);
    const seats = [];
    Object.keys(ends).forEach((end) => {
      const group = ends[end];
      const zOf = behind[end];
      const { tier, board, wall, lamp } = SURROUND;
      const isEven = (_unused, index) => index % 2 === 0;
      const isOdd = (_unused, index) => index % 2 === 1;
      const boards = Array.from({ length: board.count }, (_unused, index) => boxAt(board.width - board.gap, board.height, board.depth, (index - (board.count - 1) / 2) * board.width, board.height / 2, zOf(SURROUND.boardZ)));
      dressed('boards', mergeGeometries(boards.filter(isEven)), 'board', {}, group);
      dressed('boards', mergeGeometries(boards.filter(isOdd)), 'boardAlt', {}, group);
      const steps = Array.from({ length: SURROUND.tiers }, (_unused, index) => boxAt(tier.halfWidth * 2, tier.rise * (index + 1), tier.run, 0, (tier.rise * (index + 1)) / 2, zOf(SURROUND.standZ + index * tier.run + tier.run / 2)));
      // The lamp posts stand with the goal end's terraces: one mesh, one ramp.
      const posts = end === 'goal' ? [-1, 1].map((side) => boxAt(lamp.pole, lamp.height, lamp.pole, side * lamp.x, lamp.height / 2, lampZ)) : [];
      dressed('stands', mergeGeometries([...steps.filter(isEven), ...posts]), 'stand', {}, group);
      dressed('stands', mergeGeometries(steps.filter(isOdd)), 'step', {}, group);
      dressed('stands', boxAt(tier.halfWidth * 2, wall.height, wall.depth, 0, wall.height / 2, zOf(SURROUND.standZ + SURROUND.tiers * tier.run + wall.depth / 2)), 'stand', { tone: wall.tone }, group);
      Array.from({ length: SURROUND.tiers }, (_unused, tierIndex) => tierIndex).forEach((tierIndex) => {
        const count = Math.floor((tier.halfWidth * 2) / SURROUND.seat.spacing);
        Array.from({ length: count }, (_unused, seat) => seat).forEach((seat) => {
          // A fixed scatter (no random): the same crowd every visit, and no two neighbours alike.
          const scatter = Math.sin(seat * SCATTER.seat + tierIndex * SCATTER.tier + (end === 'goal' ? 0 : SCATTER.end)) * SCATTER.scale;
          const chance = scatter - Math.floor(scatter);
          seats.push({ end, x: (seat - (count - 1) / 2) * SURROUND.seat.spacing, y: tier.rise * (tierIndex + 1), z: zOf(SURROUND.standZ + tierIndex * tier.run + tier.run * SURROUND.seat.setBack), chance, shirt: Math.floor(chance * SCATTER.shirt) % CROWD_COLORS, skin: Math.floor(chance * SCATTER.skin) % SKIN_COLORS });
        });
      });
    });
    const lampHeads = dressed('stands', mergeGeometries([-1, 1].map((side) => boxAt(SURROUND.lamp.headWidth, SURROUND.lamp.size, SURROUND.lamp.headDepth, side * SURROUND.lamp.x, SURROUND.lamp.height + SURROUND.lamp.size / 2, lampZ))), 'lamp', { emissive: true }, ends.goal);

    // ---- turf and markings ----
    // Mown stripes lie just under the markings, so a line is never fought over by two surfaces.
    const stripes = Array.from({ length: SURROUND.stripes }, (_unused, index) => boxAt(SURROUND.pitchHalfWidth * 2, MARKS.slab, SURROUND.stripeDepth, 0, MARKS.lift / 2, lineZ - SURROUND.stripeDepth + (index * 2 + 0.5) * SURROUND.stripeDepth));
    dressed('turf', boxAt(SURROUND.pitchHalfWidth * 2, SURROUND.turfThickness, SURROUND.pitchDepth, 0, -SURROUND.turfThickness / 2, 0), 'grass', { tone: TURF_TONE, inkGroup: 0 });
    dressed('turf', mergeGeometries(stripes), 'stripe', { tone: TURF_TONE, inkGroup: 0 });
    const half = MARKS.width / 2;
    const arc = Array.from({ length: MARKS.arcSteps }, (_unused, index) => {
      const [from, to] = [index, index + 1].map((step) => (step / MARKS.arcSteps - 0.5) * MARKS.arcSpan);
      const [middle, length] = [(from + to) / 2, MARKS.arcRadius * (to - from) + MARKS.width];
      return new THREE.BoxGeometry(length, MARKS.slab, MARKS.width).rotateY(-middle).translate(Math.sin(middle) * MARKS.arcRadius, MARKS.lift, lineZ + MARKS.boxDepth + MARKS.arcBeyondBox + Math.cos(middle) * MARKS.arcRadius - MARKS.arcRadius);
    });
    dressed(
      'markings',
      mergeGeometries([
        slab(-SURROUND.pitchHalfWidth, SURROUND.pitchHalfWidth, lineZ - half, lineZ + half),
        slab(-MARKS.boxHalfWidth, MARKS.boxHalfWidth, lineZ + MARKS.boxDepth - half, lineZ + MARKS.boxDepth + half),
        slab(-MARKS.boxHalfWidth - half, -MARKS.boxHalfWidth + half, lineZ, lineZ + MARKS.boxDepth),
        slab(MARKS.boxHalfWidth - half, MARKS.boxHalfWidth + half, lineZ, lineZ + MARKS.boxDepth),
        new THREE.CylinderGeometry(MARKS.spotRadius, MARKS.spotRadius, MARKS.slab, MARKS.spotSides).translate(0, MARKS.lift, 0),
        ...arc,
      ]),
      'line',
      { tone: 1, inkGroup: 0 }
    );

    // ---- goal frame (with the flag poles: one mesh, one ramp) and net ----
    const { flag } = SURROUND;
    const post = (x) => new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.height, POST_SIDES).translate(x, goal.height / 2, lineZ);
    const bar = new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.halfWidth * 2 + goal.postRadius * 2, POST_SIDES).rotateZ(Math.PI / 2).translate(0, goal.height, lineZ);
    const flagX = (side) => side * (goal.halfWidth + flag.beside);
    const poles = [-1, 1].map((side) => new THREE.CylinderGeometry(flag.pole, flag.pole, flag.height, flag.sides).translate(flagX(side), flag.height / 2, lineZ));
    dressed('goal frame', mergeGeometries([post(-goal.halfWidth), post(goal.halfWidth), bar, ...poles]), 'frame', { inkGroup: 2 });
    const backZ = lineZ - goal.depth;
    const isPinnedAtFrame = (column, row, columns, lastRow) => column === 0 || column === columns - 1 || row === 0 || row === lastRow;
    const sheetOf = (origin, across, down, columns, knotRows) => Kit.netting.sheet({ origin, across, down, columns, rows: knotRows, isPinned: (column, row) => isPinnedAtFrame(column, row, columns, knotRows - 1) });
    const corner = (x, z) => ({ x, y: goal.height, z });
    const [acrossGoal, intoGoal, downGoal] = [{ x: goal.halfWidth * 2, y: 0, z: 0 }, { x: 0, y: 0, z: -goal.depth }, { x: 0, y: -goal.height, z: 0 }];
    /** The net in two drawn parts: the sides, and the back with the roof (which stand between a camera behind the goal and the keeper). */
    const netPartOf = (label, sheets) => {
      const offsets = [0];
      sheets.forEach((net) => offsets.push(offsets[offsets.length - 1] + net.positions.length / STRIDE));
      const positions = new Float32Array(offsets[sheets.length] * STRIDE);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, STRIDE));
      // Lines have no facing; the look only needs some normal to exist, and the fixed tone ignores it.
      geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(positions, (_zero, index) => (index % STRIDE === 1 ? 1 : 0)), STRIDE));
      geometry.setIndex(sheets.flatMap((net, index) => Array.from(net.links, (knot) => knot + offsets[index])));
      const lines = new THREE.LineSegments(geometry);
      lines.name = label;
      lines.frustumCulled = false;
      view.scene.add(lines);
      view.shading.dress(lines, { ramp: rows.net, tone: 1, inkGroup: 0 });
      const copy = () => {
        sheets.forEach((net, index) => positions.set(net.positions, offsets[index] * STRIDE));
        geometry.attributes.position.needsUpdate = true;
      };
      copy();
      return { sheets, lines, copy };
    };
    const netSides = netPartOf('net', [sheetOf(corner(-goal.halfWidth, lineZ), intoGoal, downGoal, NETTING.deep, NETTING.down), sheetOf(corner(goal.halfWidth, lineZ), intoGoal, downGoal, NETTING.deep, NETTING.down)]);
    const netBack = netPartOf('net', [sheetOf(corner(-goal.halfWidth, backZ), acrossGoal, downGoal, NETTING.across, NETTING.down), sheetOf(corner(-goal.halfWidth, lineZ), acrossGoal, intoGoal, NETTING.across, NETTING.deep)]);
    const nets = [...netSides.sheets, ...netBack.sheets];
    const netClock = { carry: 0, isMoving: false, farthest: 0 };
    /** From behind the goal the back and the roof would be drawn across the keeper: they show only while the ball is in them. */
    const showNet = () => (netBack.lines.visible = SEATS[seatName].faces === 'goal' || netClock.isMoving);

    // ---- the crowd: two instanced meshes per end (bodies, heads), each instance its own shirt or skin row ----
    const crowdOf = (end) => {
      const members = seats.filter((seat) => seat.end === end);
      const [bodyWidth, bodyHeight, bodyDepth] = SURROUND.seat.body;
      const facing = end === 'goal' ? 1 : -1;
      const bodyGeometry = cardOf(bodyWidth, bodyHeight, bodyDepth, 0, facing);
      const headGeometry = cardOf(SURROUND.seat.head, SURROUND.seat.head, SURROUND.seat.head, bodyHeight, facing);
      bodyGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(Float32Array.from(members, (member) => member.shirt), 1));
      headGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(Float32Array.from(members, (member) => member.skin), 1));
      const meshes = [[bodyGeometry, 'crowd0'], [headGeometry, 'skin0']].map(([geometry, ramp]) => dressedInstances('crowd', geometry, members.length, ramp, { instanceRamp: true, inkGroup: 3 }, ends[end]));
      return { members, meshes };
    };
    const crowds = [crowdOf('goal'), crowdOf('taker')];
    const scratchMatrix = new THREE.Matrix4();
    let cheer = 0;
    let isCrowdStill = false;
    /** Writes every seat's place: empty seats are shrunk to nothing, and a cheering crowd jumps in a wave. */
    const placeCrowd = (time) => {
      crowds.forEach(({ members, meshes }) => {
        // Hot path while cheering: an index loop and a direct matrix write per seat.
        for (let index = 0; index < members.length; index++) {
          const member = members[index];
          const shown = member.chance < look.crowd ? 1 : 0;
          const jump = cheer > 0 ? Math.max(0, Math.sin(time * CHEER.rate + member.chance * TURN)) * CHEER.jump * cheer : 0;
          scratchMatrix.makeScale(shown, shown, shown).setPosition(member.x, member.y + jump, member.z);
          meshes[0].setMatrixAt(index, scratchMatrix);
          meshes[1].setMatrixAt(index, scratchMatrix);
        }
        meshes.forEach((mesh) => (mesh.instanceMatrix.needsUpdate = true));
      });
    };
    placeCrowd(0);

    // ---- flags that show the wind: two cloths, instances of one mesh ----
    const [clothWidth, clothHeight, clothDepth] = flag.cloth;
    const cloths = dressedInstances('flags', boxAt(clothWidth, clothHeight, clothDepth, clothWidth / 2, 0, 0), 2, 'flag', {});
    const clothTurn = new THREE.Euler();
    const clothSpin = new THREE.Quaternion();
    const clothPlace = new THREE.Vector3();
    const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
    let wind = 0;
    let clothDroop = flag.slack;

    // ---- ball, its shadow and its trail ----
    const ballGroup = new THREE.Group();
    view.scene.add(ballGroup);
    dressed('ball', new THREE.IcosahedronGeometry(FIELD.ballRadius, 1), 'ballPanel', { inkGroup: 4 }, ballGroup);
    const patchSpots = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const patchOut = FIELD.ballRadius * BALL.patchOut;
    dressed('ball', mergeGeometries(patchSpots.map(([x, y, z]) => new THREE.IcosahedronGeometry(FIELD.ballRadius * BALL.patch, 0).translate(x * patchOut, y * patchOut, z * patchOut))), 'ballPatch', { inkGroup: 4 }, ballGroup);
    // Every shadow on the turf (the ball's and each character's) is an instance of one disc.
    const SHADOWS = Object.freeze({ ball: 0, firstFigure: 1, count: 5 });
    const shadows = dressedInstances('shadows', new THREE.CircleGeometry(1, BALL.shadow.sides).rotateX(-Math.PI / 2), SHADOWS.count, 'shade', { tone: BALL.shadow.tone, inkGroup: 0 });
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    const placeShadow = (index, x, z, across, deep) => {
      shadows.setMatrixAt(index, across > 0 ? scratchMatrix.makeScale(across, 1, deep).setPosition(x, MARKS.lift + MARKS.slab, z) : hiddenMatrix);
      shadows.instanceMatrix.needsUpdate = true;
    };
    Array.from({ length: SHADOWS.count }, (_unused, index) => placeShadow(index, 0, 0, 0, 0));
    const trail = dressedInstances('ball trail', new THREE.OctahedronGeometry(BALL.trail.size, 0), BALL.trail.dots, 'ballPanel', { emissive: true });
    trail.count = 0;
    const trailPoints = [];
    let trailClock = 0;
    const spinAxis = new THREE.Vector3();

    // ---- aim line, reticle and the keeper's dive marker ----
    const aimDots = dressedInstances('aim line', new THREE.OctahedronGeometry(AIM.dot, 0), AIM.dots, 'aim', { emissive: true });
    aimDots.count = 0;
    /** @param {string} label @param {number[]} radii inner and outer radius, metres */
    const ringOf = (label, radii) => {
      const [inner, outer] = radii;
      const ring = dressed(label, new THREE.RingGeometry(inner, outer, RINGS.sides), 'aim', { emissive: true });
      ring.material[0].side = THREE.DoubleSide;
      ring.visible = false;
      return ring;
    };
    const reticle = ringOf('aim line', RINGS.reticle);
    const marker = ringOf('dive marker', RINGS.marker);
    const tellArrow = dressed('tell', new THREE.ConeGeometry(TELL.radius, TELL.length, TELL.sides).rotateZ(-Math.PI / 2), 'aim', { emissive: true });
    tellArrow.visible = false;

    // ---- bits: confetti, turf, chalk ----
    const bitGeometry = new THREE.BoxGeometry(BITS.size, BITS.size, BITS.size);
    const bitRamps = new Float32Array(BITS.count);
    bitGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(bitRamps, 1));
    const bitMesh = dressedInstances('bits', bitGeometry, BITS.count, 'bit0', { instanceRamp: true, emissive: true });
    const bits = Array.from({ length: BITS.count }, () => ({ life: 0, x: 0, y: 0, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0 }));
    let nextBit = 0;
    let liveBits = 0;
    bits.forEach((_bit, index) => bitMesh.setMatrixAt(index, hiddenMatrix));
    bitMesh.visible = false;

    // ---- figures ----
    const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
    const bakery = catalog.bakery({ capacity: 16 });
    const figures = [];

    // ---- camera ----
    const lookAt = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const keeperPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SIM.KEEPER_Z);
    const pointer = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const seatCamera = () => {
      const seat = solveSeat(SEATS[seatName], size);
      camera.position.set(...seat.at);
      camera.fov = seat.fov;
      camera.near = CAMERA_RANGE.near;
      camera.far = CAMERA_RANGE.far;
      camera.updateProjectionMatrix();
      camera.lookAt(lookAt.set(...seat.look));
      camera.updateMatrixWorld();
      view.use('pixel', { pixelRows: seat.rows });
      // An end's stand is scenery for the camera that faces it and a wall for the camera that sits in it.
      ends.goal.visible = SEATS[seatName].faces === 'goal';
      ends.taker.visible = SEATS[seatName].faces === 'taker';
      ballGroup.scale.setScalar(SEATS[seatName].ballScale);
      showNet();
    };
    seatCamera();

    // ---- where things are on screen (for `framing`) ----
    const projected = new THREE.Vector3();
    /** The screen disc of a world point of a radius, as a rectangle in CSS pixels; null when it is behind the camera. */
    const discRect = (x, y, z, radius) => {
      projected.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      const depth = -projected.z;
      if (depth <= camera.near) return null;
      const pixelsPerMetre = size.h / (2 * Math.tan((camera.fov / 2) * RADIANS) * depth);
      const [centreX, centreY] = [size.w / 2 + projected.x * pixelsPerMetre, size.h / 2 - projected.y * pixelsPerMetre];
      return { left: centreX - radius * pixelsPerMetre, top: centreY - radius * pixelsPerMetre, right: centreX + radius * pixelsPerMetre, bottom: centreY + radius * pixelsPerMetre };
    };
    /** A rectangle cut to the screen; null when none of it is on screen. */
    const onScreen = (rect) => {
      if (!rect) return null;
      const cut = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(size.w, rect.right), bottom: Math.min(size.h, rect.bottom) };
      return cut.left < cut.right && cut.top < cut.bottom ? cut : null;
    };
    const bonePoint = new THREE.Vector3();
    /** The screen rectangle of a character: the union of a disc per bone, the head's bigger and higher. */
    const figureRect = (figure) => {
      if (!figure.root.visible) return null;
      // The root may have been moved since the last frame was drawn.
      figure.root.updateMatrixWorld();
      const { translation } = figure.world;
      const headBone = figure.bake.plan.boneIndex('head');
      let rect = null;
      for (let bone = 0; bone < translation.length / STRIDE; bone++) {
        bonePoint.set(translation[bone * STRIDE], translation[bone * STRIDE + 1], translation[bone * STRIDE + 2]).applyMatrix4(figure.root.matrixWorld);
        const isHead = bone === headBone;
        rect = unionRect(rect, onScreen(discRect(bonePoint.x, bonePoint.y + (isHead ? FIGURE_BOUNDS.headLift : 0), bonePoint.z, isHead ? FIGURE_BOUNDS.head : FIGURE_BOUNDS.limb)));
      }
      return rect;
    };

    const stage = {
      view,
      catalog,
      FIGURE_SCALE,
      /**
       * Seats the camera and shows the end it faces.
       * @param {('aim'|'flight'|'keeper')} name a key of `SEATS`
       */
      setSeat(name) {
        seatName = name;
        seatCamera();
      },
      /** The seat in use. */
      seat: () => seatName,
      /**
       * Where the player's taker waits beside the ball: behind it, and as far to the side as the aim seat's
       * picture has room for, so the whole character is in the picture and clear of the ball.
       * @returns {{x: number, z: number}} world metres
       */
      takerWait() {
        const seat = solveSeat(SEATS.aim, size);
        const visibleHalfWidth = (seat.at[2] - TAKER_WAIT.z) * Math.tan((seat.fov / 2) * RADIANS) * size.aspect;
        return { x: -clamp(visibleHalfWidth - TAKER_WAIT.halfWidth, TAKER_WAIT.side[0], TAKER_WAIT.side[1]), z: TAKER_WAIT.z };
      },
      /** Re-seats the camera after the screen turned. */
      resize: seatCamera,
      /**
       * Recolours the ground and re-seats the crowd.
       * @param {string} lookId a key of `LOOKS`
       * @param {number[]} ballColors [panel, patch] of the ball in play
       */
      setLook(lookId, ballColors) {
        look = LOOKS[lookId] || LOOKS.park;
        const colors = { ...SHARED_COLORS, ...look.colors, ballPanel: ballColors[0], ballPatch: ballColors[1] };
        WORLD_RAMPS.forEach((name) => view.atlas.writeRamp(world, name, colors[name]));
        lampHeads.visible = look.lamps;
        placeCrowd(0);
      },
      /**
       * Builds a character from a recipe and stands it in the scene.
       * @param {Object} recipe a `Recipe` of the wardrobe catalogue
       * @returns {Object} a `Figure` (kit/figure.js) with `footing`, the point (x, z) its shadow lies under: the
       *   root's place until whoever animates it says otherwise (a dive carries the body off its root)
       */
      addFigure(recipe) {
        const figure = Kit.figure.build(view, bakery.bakeRecipe(recipe), { level: FIGURE_LEVEL });
        figure.root.scale.setScalar(FIGURE_SCALE);
        figure.footing = figure.root.position;
        figures.push(figure);
        return figure;
      },
      /** Removes every character built with `addFigure`. */
      clearFigures() {
        figures.splice(0).forEach((figure) => figure.dispose());
      },
      ball: {
        /**
         * Puts the ball where the simulation has it and rolls it by its spin and its travel.
         * @param {{x: number, y: number, z: number}} position
         * @param {{x: number, y: number, z: number}} velocity
         * @param {number} dt seconds since the last call
         */
        set(position, velocity, dt) {
          ballGroup.visible = true;
          ballGroup.position.set(position.x, position.y, position.z);
          const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
          // It rolls about the axis across its travel, as a ball on turf does.
          if (speed > 0) ballGroup.rotateOnWorldAxis(spinAxis.set(velocity.z, 0, -velocity.x).normalize(), (speed / FIELD.ballRadius) * dt * BALL.roll);
          const height = Math.max(0, position.y - FIELD.ballRadius);
          const spread = FIELD.ballRadius * ballGroup.scale.x * (BALL.shadow.spread + height * BALL.shadow.perMetre);
          placeShadow(SHADOWS.ball, position.x, position.z, spread, spread * BALL.shadow.squash);
          // A fast ball leaves a short trail of where it has just been, so its line reads at a glance.
          trailClock += dt;
          if (speed < BALL.trail.leastSpeed) trailPoints.length = 0;
          else if (trailClock >= BALL.trail.every) {
            trailClock = 0;
            trailPoints.unshift({ x: position.x, y: position.y, z: position.z });
            trailPoints.length = Math.min(trailPoints.length, BALL.trail.dots);
          }
          trailPoints.forEach((point, index) => {
            const size = ballGroup.scale.x * (1 - index / BALL.trail.dots);
            trail.setMatrixAt(index, scratchMatrix.makeScale(size, size, size).setPosition(point.x, point.y, point.z));
          });
          trail.count = trailPoints.length;
          trail.instanceMatrix.needsUpdate = true;
        },
        hide() {
          ballGroup.visible = false;
          trail.count = trailPoints.length = 0;
          placeShadow(SHADOWS.ball, 0, 0, 0, 0);
        },
        object: ballGroup,
      },
      net: {
        /**
         * Advances the net and lets the ball push it.
         * @param {number} dt seconds
         * @param {?{x: number, y: number, z: number}} ballPosition null when no ball is near
         * @returns {boolean} true when the ball is touching the net
         */
        update(dt, ballPosition) {
          const isNear = Boolean(ballPosition) && ballPosition.z < lineZ + NETTING.near;
          if (!isNear && !netClock.isMoving) return false;
          let touching = 0;
          netClock.carry = Math.min(netClock.carry + dt, NETTING.step * NETTING.mostSteps);
          let farthest = 0;
          while (netClock.carry >= NETTING.step) {
            netClock.carry -= NETTING.step;
            nets.forEach((net) => {
              farthest = Math.max(farthest, Kit.netting.step(net, NETTING.step));
              if (isNear) touching += Kit.netting.push(net, ballPosition.x, ballPosition.y, ballPosition.z, NETTING.pushRadius);
            });
          }
          // Still means no longer changing: a net at rest hangs a little below where it was tied.
          netClock.isMoving = isNear || Math.abs(farthest - netClock.farthest) > NETTING.still;
          netClock.farthest = farthest;
          netSides.copy();
          netBack.copy();
          showNet();
          return touching > 0;
        },
      },
      aim: {
        /**
         * Draws the aim line through some points of a predicted flight, and a reticle where it meets the keeper's plane.
         * @param {Array<{x: number, y: number, z: number}>} points
         * @param {?{x: number, y: number}} target where the line reaches the keeper's plane, if it does
         * @param {number} time seconds, for the march of the dots
         */
        show(points, target, time) {
          const stride = Math.max(1, Math.floor(points.length / AIM.dots));
          const phase = Math.floor(time * AIM.march) % stride;
          let shown = 0;
          for (let index = phase; index < points.length && shown < AIM.dots; index += stride) {
            const size = lerp(AIM.sizes[0], AIM.sizes[1], index / points.length);
            scratchMatrix.makeScale(size, size, size).setPosition(points[index].x, points[index].y, points[index].z);
            aimDots.setMatrixAt(shown++, scratchMatrix);
          }
          aimDots.count = shown;
          aimDots.instanceMatrix.needsUpdate = true;
          reticle.visible = Boolean(target);
          if (target) reticle.position.set(target.x, target.y, SIM.KEEPER_Z);
        },
        hide() {
          aimDots.count = 0;
          reticle.visible = false;
        },
      },
      marker: {
        /** Shows where the keeper was sent, in the keeper's plane. */
        show(point) {
          marker.visible = true;
          marker.position.set(point.x, point.y, SIM.KEEPER_Z - RINGS.inFront);
        },
        hide() {
          marker.visible = false;
        },
      },
      tell: {
        /** Shows an arrow over the taker pointing to a side of the goal (-1 or 1 in world x), or hides it for 0. */
        show(side, x, z) {
          tellArrow.visible = side !== 0;
          tellArrow.position.set(x, TELL.height, z);
          tellArrow.rotation.y = side > 0 ? 0 : Math.PI;
        },
      },
      /**
       * Starts the crowd jumping; it dies down by itself.
       * @param {number} amount 0..1
       */
      cheer(amount) {
        cheer = Math.max(cheer, amount);
        isCrowdStill = false;
      },
      /** Points the flags: metres per second of crosswind, + towards +X. */
      setWind(speed) {
        wind = speed;
      },
      /**
       * Throws a burst of bits.
       * @param {{x: number, y: number, z: number}} from
       * @param {{count?: number, speed?: number, up?: number, colors?: number[]}} [options] `colors`: indices of the bit ramps
       */
      burst(from, { count = 24, speed = 4, up = 3, colors = Array.from({ length: BITS.colors }, (_unused, index) => index) } = {}) {
        for (let index = 0; index < count; index++) {
          const bit = bits[nextBit];
          const angle = Math.random() * TURN;
          const reach = Math.random() * speed;
          Object.assign(bit, { life: lerp(BITS.life[0], BITS.life[1], Math.random()), x: from.x, y: from.y, z: from.z, velocityX: Math.cos(angle) * reach, velocityY: up * (BITS.upShare + Math.random()), velocityZ: Math.sin(angle) * reach });
          bitRamps[nextBit] = colors[index % colors.length];
          nextBit = (nextBit + 1) % BITS.count;
        }
        bitGeometry.attributes.instanceRamp.needsUpdate = true;
        bitMesh.visible = true;
      },
      /**
       * The point of the keeper's plane under a screen position.
       * @param {number} nx normalised device x, -1..1
       * @param {number} ny normalised device y, -1..1 (up is positive)
       * @returns {?{x: number, y: number}} null when the view ray misses the plane
       */
      pickKeeperPlane(nx, ny) {
        raycaster.setFromCamera(pointer.set(nx, ny), camera);
        return raycaster.ray.intersectPlane(keeperPlane, hitPoint) ? { x: hitPoint.x, y: hitPoint.y } : null;
      },
      /**
       * Where things are on screen now, as rectangles in CSS pixels (y down), each cut to the screen and null
       * when off it: what a playtest checks the camera's promises against.
       * @returns {{goal: ?Object, ball: ?Object, figures: Array<?Object>}} `goal`: the frame's mouth, whole
       *   (not cut: a goal that leaves the screen must show as such); `figures`: in the order they were added
       * @complexity O(figures x bones)
       */
      framing() {
        const corners = [[-1, 0], [1, 0], [-1, 1], [1, 1]].map(([side, up]) => discRect(side * goal.halfWidth, up * goal.height, lineZ, goal.postRadius));
        const ballRadius = FIELD.ballRadius * ballGroup.scale.x;
        return {
          goal: corners.every(Boolean) ? corners.reduce(unionRect) : null,
          ball: ballGroup.visible ? onScreen(discRect(ballGroup.position.x, ballGroup.position.y, ballGroup.position.z, ballRadius)) : null,
          figures: figures.map(figureRect),
        };
      },
      /**
       * What the scene costs to draw now, by object: triangles and draw calls of everything visible.
       * @returns {Array<{object: string, triangles: number, calls: number}>} rows, biggest first; each character is one row
       * @complexity O(scene objects)
       */
      budget() {
        const totals = new Map();
        const add = (label, triangles) => {
          const row = totals.get(label) || { object: label, triangles: 0, calls: 0 };
          totals.set(label, { ...row, triangles: row.triangles + triangles, calls: row.calls + 1 });
        };
        const labelOf = (object) => {
          const figureIndex = figures.findIndex((figure) => {
            let isInside = false;
            object.traverseAncestors((ancestor) => (isInside = isInside || ancestor === figure.root));
            return isInside;
          });
          return figureIndex >= 0 ? `character ${figureIndex + 1}` : object.name || 'other';
        };
        view.scene.traverseVisible((object) => {
          if (!object.geometry) return;
          const { geometry } = object;
          const elements = geometry.index ? geometry.index.count : geometry.attributes.position.count;
          const instances = object.isInstancedMesh ? object.count : 1;
          if (instances > 0) add(labelOf(object), object.isLineSegments ? 0 : Math.round((elements / STRIDE) * instances));
        });
        return [...totals.values()].sort((first, second) => second.triangles - first.triangles);
      },
      /**
       * Per frame: the crowd, the flags, the bits and the figures' shadows.
       * @param {number} dt seconds (real time, so a hit-stop does not freeze the confetti)
       * @param {number} time seconds
       */
      update(dt, time) {
        if (cheer > 0 || !isCrowdStill) {
          cheer = Math.max(0, cheer - CHEER.fall * dt);
          placeCrowd(time);
          isCrowdStill = cheer === 0;
        }
        // A slack flag hangs; a full one stands out along the wind and flutters.
        const strength = clamp(Math.abs(wind) / flag.fullWind);
        clothDroop = damp(clothDroop, lerp(flag.slack, 0, strength) + Math.sin(time * lerp(flag.flutterRate[0], flag.flutterRate[1], strength)) * flag.flutter * strength, flag.ease, dt);
        clothSpin.setFromEuler(clothTurn.set(0, wind >= 0 ? 0 : Math.PI, clothDroop));
        [-1, 1].forEach((side, index) => cloths.setMatrixAt(index, scratchMatrix.compose(clothPlace.set(flagX(side), flag.height - clothHeight / 2, lineZ), clothSpin, UNIT_SCALE)));
        cloths.instanceMatrix.needsUpdate = true;
        marker.rotation.z = reticle.rotation.z = time * RINGS.spin;
        reticle.scale.setScalar(1 + Math.sin(time * RINGS.pulseRate) * RINGS.pulse);
        // Hot path: an index loop over the live bits.
        liveBits = 0;
        for (let index = 0; bitMesh.visible && index < bits.length; index++) {
          const bit = bits[index];
          if (bit.life <= 0) continue;
          bit.life -= dt;
          bit.velocityY -= BITS.gravity * dt;
          const kept = Math.max(0, 1 - BITS.drag * dt);
          bit.x += (bit.velocityX *= kept) * dt;
          bit.y = Math.max(BITS.floor, bit.y + bit.velocityY * dt);
          bit.z += (bit.velocityZ *= kept) * dt;
          liveBits += bit.life > 0 ? 1 : 0;
          bitMesh.setMatrixAt(index, bit.life > 0 ? scratchMatrix.makeRotationZ(bit.life * BITS.spin).setPosition(bit.x, bit.y, bit.z) : hiddenMatrix);
          bitMesh.instanceMatrix.needsUpdate = true;
        }
        bitMesh.visible = liveBits > 0;
        figures.forEach((figure, index) => {
          const isShown = figure.root.visible && SHADOWS.firstFigure + index < SHADOWS.count;
          placeShadow(SHADOWS.firstFigure + index, figure.footing.x, figure.footing.z, isShown ? FIGURE_SHADOW.across : 0, FIGURE_SHADOW.deep);
        });
      },
      /** Draws the frame. */
      render() {
        view.render(camera, { clearColor: look.sky });
      },
      dispose() {
        stage.clearFigures();
        view.dispose();
      },
    };
    return stage;
  };

  window.SPOT_KICK_STAGE = { LOOKS, SEATS, HUD_BAND, FIGURE_SCALE, solveSeat, build };
})();
