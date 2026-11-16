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
  const { FIELD, DYE } = DATA;
  const { goal } = FIELD;
  const { clamp, lerp, damp } = Kit.math;
  const TURN = Math.PI * 2;
  const RADIANS = Math.PI / 180;
  /** Numbers per vertex position, and vertices per triangle. */
  const STRIDE = 3;

  // =================================================== looks and seats ===================================================

  /**
   * Ramps every ground has, in atlas order: the stadium's (kit/stadium.js `RAMPS`, its crowd runs kept together)
   * and the game's own. `ballPanel, ballPatch` and `bit0..3` must also stay together: one mesh reaches each run
   * by an offset from its first.
   */
  const CROWD_RAMPS = Kit.stadium.RAMPS.crowd.flatMap((run) => Array.from({ length: Kit.stadium.CROWD.colors[run] }, (_unused, index) => run + index));
  const WORLD_RAMPS = [...Kit.stadium.RAMPS.surface, ...Kit.stadium.RAMPS.end, ...CROWD_RAMPS, 'frame', 'net', 'shade', 'ballPanel', 'ballPatch', 'aim', 'bit0', 'bit1', 'bit2', 'bit3'];

  /** Colours every ground shares: the frame, the ball's defaults, skins, hair, confetti. */
  const SHARED_COLORS = {
    line: '#f2f1e4', frame: '#f7f6ef', net: '#e3eaf0', ballPanel: '#f4f1e8', ballPatch: '#2b2f3a', aim: '#ffe86b',
    skin0: '#e9b48c', skin1: '#b9794f', skin2: '#6b4630', hair0: '#2a2018', hair1: '#6b4424', hair2: '#d9b65c',
    bit0: '#ffd84a', bit1: '#ff5f6d', bit2: '#58d0ff', bit3: '#f7f6ef',
  };

  /**
   * @typedef {Object} GroundLook
   * @property {number} sky the colour behind everything (0xRRGGBB)
   * @property {Object<string, string>} colors ramp name -> base colour, over SHARED_COLORS. `glow` is the halo
   *   round a floodlight: the sky's own colour where the lamps are off, so the halo is not there
   * @property {number} crowd share of the seats that are taken, 0..1
   * @property {number[]} shirts the dye (`SPOT_KICK_DATA.DYE`) of each look of sculpted supporter's top, in the
   *   order of the crowd's shirt ramps (`crowd0`...), so the front rows wear the colours of the terrace behind
   */

  /** The grounds, by `CupRow.look`. A ground is a palette: the same meshes, recoloured by rewriting atlas rows. */
  const LOOKS = {
    park: {
      sky: 0x8fd0f2, crowd: 0.6, shirts: [DYE.coral, DYE.sky, DYE.mustard, DYE.cream, DYE.forest, DYE.plum],
      colors: {
        grass: '#57a843', stripe: '#4c9a3c', worn: '#8f9648', stand: '#8a7a68', step: '#a39382', rail: '#e4dfd0', roof: '#5f6f7a', board: '#e8e2d0', boardAlt: '#3f8f6a', shade: '#2f6b33',
        sky: '#8fd0f2', haze: '#c9ecf7', cloud: '#ffffff', glow: '#8fd0f2', flag: '#ff6b4a', lamp: '#7f8c96',
        crowd0: '#d9573f', crowd1: '#3f78c4', crowd2: '#e9c84a', crowd3: '#eeeeea', crowd4: '#5aa66a', crowd5: '#8a5fb5', scarf0: '#3f8f6a', scarf1: '#f2f1e4',
      },
    },
    harbour: {
      sky: 0x9fb6c4, crowd: 0.7, shirts: [DYE.navy, DYE.cream, DYE.rust, DYE.charcoal, DYE.teal, DYE.mustard],
      colors: {
        grass: '#4a9a66', stripe: '#418c5c', worn: '#7f9460', stand: '#51667a', step: '#64798c', rail: '#c9d3da', roof: '#34465a', board: '#1f4f78', boardAlt: '#e9eef0', shade: '#2a6146',
        sky: '#9fb6c4', haze: '#d5e2e6', cloud: '#eef2f3', glow: '#9fb6c4', flag: '#ffd23f', lamp: '#6f8090',
        crowd0: '#2f6ea8', crowd1: '#e8eef2', crowd2: '#e2733a', crowd3: '#2b3a52', crowd4: '#7fc2d6', crowd5: '#f0c64a', scarf0: '#1f4f78', scarf1: '#ffd23f',
      },
    },
    lights: {
      sky: 0x141a33, crowd: 1, shirts: [DYE.crimson, DYE.mustard, DYE.cream, DYE.navy, DYE.plum, DYE.coral],
      colors: {
        grass: '#3f9f58', stripe: '#36904d', worn: '#74904a', stand: '#2a2f4a', step: '#363c5c', rail: '#8088b0', roof: '#1c2038', board: '#b3202e', boardAlt: '#f3d24a', shade: '#1d5a35',
        sky: '#141a33', haze: '#27305a', cloud: '#232b52', glow: '#4a5aa0', flag: '#f3d24a', lamp: '#fff6c8',
        crowd0: '#c9354a', crowd1: '#f3d24a', crowd2: '#e9e9f2', crowd3: '#3b4f9a', crowd4: '#7a3fb0', crowd5: '#e8843a', scarf0: '#b3202e', scarf1: '#f3d24a',
      },
    },
  };

  /** The settings of the picture a game is built with. `grain`: how fine the pixel grid is, a key of `Kit.pixelGrid.GRAINS`. */
  const LOOK = { grain: 'standard' };

  /**
   * How much of the top of the screen the HUD covers, CSS pixels: the scoreboard and its chips. A seat tilts the
   * camera so that its top subject sits just below this band, whatever the screen's size. The theme
   * (games/penalty-theme.js) lays the HUD out inside these bands; change them together. A playtest checks the
   * pair: no HUD panel's rectangle may meet the goal's (`framing().goal`).
   */
  const HUD_BAND = Object.freeze({ portrait: 204, landscape: 66 });

  /**
   * @typedef {Object} StageSeat A `SeatRule` of kit/seat.js, plus what the stage shows from it.
   * @property {('goal'|'taker')} faces the end the camera looks at (that end's stand is drawn; the other is behind the camera)
   * @property {number} ballScale how much bigger than life the ball is drawn from here (a far ball must still read)
   */

  /**
   * The camera seats. `aim`: raised behind the ball, the taker standing whole beside it and the goal clear above
   * their head. `flight`: a cut to just past the taker at the strike, so nothing stands between the lens and the
   * ball, the keeper and the goal. `keeper`: above and behind the bar, the player's keeper in front of the lens.
   * @type {Object<string, Object>} each a `SeatRule` of kit/seat.js and a `StageSeat`
   */
  const SEATS = {
    aim: {
      faces: 'goal', toward: -1, fit: { z: SIM.LINE_Z, halfWidth: 3.1 }, anchor: { y: goal.height + 0.2, z: SIM.LINE_Z }, least: 15, ballScale: 1,
      portrait: { fov: 50, height: 4.0 },
      landscape: { fov: 42, height: 4.0 },
    },
    flight: {
      faces: 'goal', toward: -1, fit: { z: SIM.LINE_Z, halfWidth: 2.9 }, anchor: { y: goal.height + 0.25, z: SIM.LINE_Z }, at: [0.6, 1.5, -0.15], ballScale: 1,
      portrait: { fovRange: [40, 76] },
      landscape: { fovRange: [40, 76] },
    },
    keeper: {
      faces: 'taker', toward: 1, fit: { z: SIM.KEEPER_Z, halfWidth: 2.95 }, anchor: { y: 0, z: SIM.KEEPER_Z, at: 0.76 }, least: 9, ballScale: 1.5,
      portrait: { fov: 56, height: 5.8 },
      landscape: { fov: 40, height: 5.0 },
    },
  };

  /** Solves a seat for a screen, its tilt set to keep the HUD's band clear (`Kit.seat.solve`). */
  const solveSeat = (seat, size) => Kit.seat.solve(seat, size, HUD_BAND[size.portrait ? 'portrait' : 'landscape']);

  /** A standing character's height, metres (the wardrobe's people at `FIGURE_SCALE`). */
  const FIGURE_HEIGHT = 1.75;

  /**
   * The pixel grid of a screen at a grain, fitted to the character who waits beside the ball in the aim seat:
   * they get as near the grain's rows as whole device pixels allow, on a tall phone, a small one or a phone on
   * its side alike, and every seat of that screen then shares the one texel size.
   * @param {string} grain a key of `Kit.pixelGrid.GRAINS`
   * @param {{w: number, h: number, aspect: number, portrait: boolean}} size the screen, CSS pixels
   * @param {number} bufferHeight the drawing buffer's height, device pixels
   * @returns {Object} a `PixelGrid` of kit/pixel-grid.js
   * @example gridOf('standard', { w: 390, h: 844, aspect: 390 / 844, portrait: true }, 1688).texelPixels // 4
   */
  const gridOf = (grain, size, bufferHeight) =>
    Kit.pixelGrid.fit(grain, { subjectPixels: Kit.seat.span(solveSeat(SEATS.aim, size), { z: TAKER_WAIT.z, to: FIGURE_HEIGHT }, bufferHeight), subjectHeight: FIGURE_HEIGHT, bufferHeight });

  /** Wardrobe characters stand about 1.1 m; a footballer here stands about 1.75 m. */
  const FIGURE_SCALE = 1.6;
  /**
   * A character on screen, for `framing()`: every bone is a disc of `limb` metres, and the head (big, on these
   * characters) is a disc of `head` metres centred `headLift` above its bone.
   */
  const FIGURE_BOUNDS = Object.freeze({ limb: 0.14, head: 0.4, headLift: 0.3 });
  /** Where the player's taker waits beside the ball: this far behind it, and as far to the side as the picture allows. */
  const TAKER_WAIT = Object.freeze({ z: 1.4, halfWidth: 0.5, side: [0.75, 1.9] });

  /** The taker's end stands this far behind the spot, and the flags beside the goal. */
  const SURROUND = Object.freeze({
    takerEndZ: 6.1,
    flag: { beside: 1.6, pole: 0.03, height: 1.5, cloth: [0.5, 0.3, 0.03], sides: 6, slack: -1.35, flutter: 0.12, flutterRate: [4, 13], fullWind: 12, ease: 6 },
  });
  /** Pitch markings: the six-yard box, the spot and the arc, metres. */
  const MARKS = Object.freeze({ boxHalfWidth: 4.2, boxDepth: 2.6, spot: 0.11, arcRadius: 3.4, arcSteps: 14, arcSpan: 1.5, arcBeyondBox: 3.2 });
  /** How far the turf runs behind the goal line and beyond the spot, metres. */
  const PITCH = Object.freeze({ behindLine: 4.8, beyondSpot: 44 });
  /** Patches worn to earth where boots stand: by the spot, and along the keeper's line. `z` is from the spot or, with `fromLine`, from the goal line. */
  const WORN = Object.freeze([
    { x: 0.05, z: 0.3, across: 0.55, deep: 0.34 },
    { x: 0, fromLine: 0.5, across: 1.25, deep: 0.36 },
    { x: -2.5, fromLine: 0.35, across: 0.5, deep: 0.2 },
    { x: 2.7, fromLine: 0.4, across: 0.42, deep: 0.2 },
  ]);
  /** The shadows lie one layer above the lines (kit/stadium.js `SURFACE.layer`). */
  const SHADOW_LAYER = 0.024;

  /** The net: knots across and down each sheet, how wide the ball pushes it, and when it counts as still. */
  const NETTING = Object.freeze({ across: 17, down: 8, deep: 5, pushRadius: 0.42, step: 1 / 60, mostSteps: 4, still: 0.0004, near: 0.2 });
  /** The goal frame: sides of its round posts, and the thinner bars that hold the net out behind it. */
  const FRAME = Object.freeze({ sides: 6, stay: 0.035, staySides: 4 });

  /** Palette rows: the ground's ramps, a block of 16 for each of the four characters of a match and one for each look of supporter. */
  const ATLAS_ROWS = 256;
  /**
   * Milliseconds of a frame given to building what is not ready yet (a character's surface, a supporter's): the
   * match starts on the first frame and the bodies arrive over the next few, with no frame held.
   */
  const BUILD_SLICE_MS = 5;
  /** The coarsest level a character of the cast is drawn at: the keeper seen from the spot is small, and still someone with a face and hair. */
  const CAST_LEAST_LEVEL = 'low';
  /**
   * The supporters near enough to be seen as people: the front `tiers` of each end are sculpted figures (one
   * instanced surface per look, kit/figure.js `crowd`), one look for each shirt colour of the ground, rolled
   * from the wardrobe by `seed`. Behind them the terrace is the stadium's cards. `height`: how tall one stands,
   * metres; `level`: their level of detail (a face is a few texels at this distance).
   */
  const SUPPORTERS = Object.freeze({ tiers: 2, seed: 4711, height: 1.25, level: 'far' });
  /** A kit crowd is scaled as a whole: a wardrobe person at `FIGURE_SCALE` stands `FIGURE_HEIGHT`. */
  const SUPPORTER_SCALE = (SUPPORTERS.height * FIGURE_SCALE) / FIGURE_HEIGHT;
  /**
   * The ball as drawn: an icosphere whose faces near the twelve corners of an icosahedron are the dark patches
   * (`patchWithin`: the cosine of how far from a corner a face may point), how fast it visibly rolls, its
   * two-tone shadow and its trail.
   */
  const BALL = Object.freeze({
    detail: 2, patchWithin: 0.93, roll: 0.35,
    shadow: { sides: 12, core: 0.62, spread: 1.1, perMetre: 0.25, squash: 0.8 },
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
  /** How fast a cheer dies down, per second. */
  const CHEER_FALL = 0.7;
  /** The near plane is as far out as the nearest thing drawn allows, which is what the far turf's layers need of the depth buffer. */
  const CAMERA_RANGE = Object.freeze({ near: 0.8, far: 120 });

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

  // ======================================================= the stage =======================================================

  /**
   * Builds the stage in a new pixel look view.
   * @param {Object} ctx the game context (uses `renderer`, `camera`, `size`)
   * @returns {Object} the handles described at each property below
   * @complexity build: O(seats + knots + painted quads); a frame: O(knots + live bits + lively or cheering seats), and one pose per figure
   */
  const build = (ctx) => {
    const { renderer, camera, size } = ctx;
    const view = Kit.look.view({ renderer, preset: 'pixel', atlasRows: ATLAS_ROWS });
    const world = view.atlas.load(Kit.palette.set('ground', Object.fromEntries(WORLD_RAMPS.map((name) => [name, { ...SHARED_COLORS, ...LOOKS.park.colors }[name]]))));
    const rows = world.rows;
    const slotOf = (ramp) => rows[ramp] - rows[WORLD_RAMPS[0]];
    let look = LOOKS.park;
    let seatName = 'aim';
    let grain = LOOK.grain;
    let grid = gridOf(grain, size, size.h);
    /** Work spread over frames: the characters' surfaces first (the player is looking at them), then the supporters'. */
    const building = { cast: Kit.slices(), crowd: Kit.slices() };

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
    /** Adds a book of painted quads (kit/paint.js) as one mesh: seen from both sides, never outlined. */
    const painted = (label, book, parent = view.scene) => {
      const mesh = dressed(label, Kit.paint.geometry(book), WORLD_RAMPS[0], { stamps: true, blockRow: rows[WORLD_RAMPS[0]], inkGroup: 0 }, parent);
      mesh.material[0].side = THREE.DoubleSide;
      mesh.frustumCulled = false;
      return mesh;
    };

    // ---- the two ends (kit/stadium.js): terraces, rails, roof, boards, floodlights and sky, one painted mesh each ----
    const lineZ = SIM.LINE_Z;
    const ends = { goal: new THREE.Group(), taker: new THREE.Group() };
    Object.values(ends).forEach((group) => view.scene.add(group));
    /** Where each end stands: the edge it is behind, and which way the pitch lies from it. */
    const PLACES = { goal: { edge: lineZ, toward: 1, turn: 0 }, taker: { edge: SURROUND.takerEndZ, toward: -1, turn: 1 } };
    const seats = Object.keys(ends).flatMap((end) => {
      const book = Kit.paint.book(slotOf);
      const made = Kit.stadium.end(book, PLACES[end]).map((seat) => ({ ...seat, end }));
      painted('stand', book, ends[end]);
      return made;
    });

    // ---- the pitch (kit/stadium.js): mown stripes, texture, worn patches and markings, one painted mesh ----
    const half = Kit.stadium.SURFACE.lineWidth / 2;
    const boxZ = lineZ + MARKS.boxDepth;
    painted(
      'pitch',
      Kit.stadium.surface(Kit.paint.book(slotOf), {
        ...Kit.stadium.SURFACE,
        from: lineZ - PITCH.behindLine,
        to: PITCH.beyondSpot,
        worn: WORN.map((patch) => ({ ...patch, z: patch.fromLine === undefined ? patch.z : lineZ + patch.fromLine })),
        lines: [
          { rect: [-Kit.stadium.SURFACE.halfWidth, Kit.stadium.SURFACE.halfWidth, lineZ - half, lineZ + half] },
          { rect: [-MARKS.boxHalfWidth, MARKS.boxHalfWidth, boxZ - half, boxZ + half] },
          { rect: [-MARKS.boxHalfWidth - half, -MARKS.boxHalfWidth + half, lineZ, boxZ] },
          { rect: [MARKS.boxHalfWidth - half, MARKS.boxHalfWidth + half, lineZ, boxZ] },
          { rect: [-MARKS.spot, MARKS.spot, -MARKS.spot, MARKS.spot] },
          { arc: { x: 0, z: boxZ + MARKS.arcBeyondBox - MARKS.arcRadius, radius: MARKS.arcRadius, from: -MARKS.arcSpan / 2, to: MARKS.arcSpan / 2, steps: MARKS.arcSteps } },
        ],
      })
    );

    // ---- goal frame (with the stays that hold the net out, and the flag poles: one mesh, one ramp, lit so a post has a shaded side) and net ----
    const { flag } = SURROUND;
    const backZ = lineZ - goal.depth;
    const post = (x) => new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.height, FRAME.sides).translate(x, goal.height / 2, lineZ);
    const bar = new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.halfWidth * 2 + goal.postRadius * 2, FRAME.sides).rotateZ(Math.PI / 2).translate(0, goal.height, lineZ);
    const stays = [-1, 1].flatMap((side) => [
      new THREE.CylinderGeometry(FRAME.stay, FRAME.stay, goal.height, FRAME.staySides).translate(side * goal.halfWidth, goal.height / 2, backZ),
      new THREE.CylinderGeometry(FRAME.stay, FRAME.stay, goal.depth, FRAME.staySides).rotateX(Math.PI / 2).translate(side * goal.halfWidth, goal.height, lineZ - goal.depth / 2),
    ]);
    const flagX = (side) => side * (goal.halfWidth + flag.beside);
    const poles = [-1, 1].map((side) => new THREE.CylinderGeometry(flag.pole, flag.pole, flag.height, flag.sides).translate(flagX(side), flag.height / 2, lineZ));
    dressed('goal frame', mergeGeometries([post(-goal.halfWidth), post(goal.halfWidth), bar, ...stays, ...poles]), 'frame', { inkGroup: 2 });
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

    // ---- the crowd: one instanced quad per end; each card of each spectator (kit/stadium.js) is an instance with its own ramp ----
    const scratchMatrix = new THREE.Matrix4();
    const { mostCards } = Kit.stadium.CROWD;
    const crowdOf = (end) => {
      const members = seats.filter((seat) => seat.end === end);
      const geometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
      const ramps = new Float32Array(members.length * mostCards);
      geometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(ramps, 1));
      const mesh = dressedInstances('crowd', geometry, members.length * mostCards, 'crowd0', { instanceRamp: true, inkGroup: 3, tone: Kit.paint.TONE.base }, ends[end]);
      mesh.material[0].side = THREE.DoubleSide;
      return { end, members, mesh, ramps, shown: [], cardboard: [], lively: [], supporters: [], wasCheering: false, toward: PLACES[end].toward };
    };
    const crowds = [crowdOf('goal'), crowdOf('taker')];
    let cheer = 0;
    /** Writes the cards of one spectator at a lift above their seat. */
    const placeMember = ({ mesh, toward }, member, lift) => {
      member.cards.forEach(([width, height, up, proud], card) => {
        scratchMatrix.makeScale(width * member.size, height * member.size, 1).setPosition(member.x, member.y + up * member.size + lift, member.z + toward * proud);
        mesh.setMatrixAt(member.first + card, scratchMatrix);
      });
    };
    /** Is a spectator in the front tiers, where people are sculpted? */
    const isUpFront = (member) => member.y < Kit.stadium.END.stand.rise * (SUPPORTERS.tiers + 0.5);
    /** Is a spectator drawn as a sculpted figure now (their look's surface is ready)? Until then they are cards like the rest. */
    const isSculpted = (member) => isUpFront(member) && supporterLooks[member.shirt].isReady;
    /** Seats the cards of the crowd a ground draws: who is there, the cards each is made of, and each card's ramp. */
    const seatCards = () => {
      crowds.forEach((crowd) => {
        let next = 0;
        crowd.shown = crowd.members.filter((member) => member.chance < look.crowd);
        crowd.cardboard = crowd.shown.filter((member) => !isSculpted(member));
        crowd.cardboard.forEach((member) => {
          const cards = Kit.stadium.cards(member);
          member.first = next;
          member.cards = cards.map(({ card }) => card);
          cards.forEach(({ run, index }) => (crowd.ramps[next++] = rows[run + index] - rows.crowd0));
          placeMember(crowd, member, 0);
        });
        crowd.lively = crowd.cardboard.filter((member) => member.isLively);
        crowd.mesh.count = next;
        crowd.mesh.geometry.attributes.instanceRamp.needsUpdate = true;
        crowd.mesh.instanceMatrix.needsUpdate = true;
      });
    };
    /** Moves the crowd of the end in view: the lively ones bob in steps; when the ground erupts everyone jumps in a wave. */
    const moveCrowd = (time) => {
      crowds.forEach((crowd) => {
        if (!ends[crowd.end].visible) return;
        const isLoud = cheer > 0 || crowd.wasCheering;
        const movers = isLoud ? crowd.cardboard : crowd.lively;
        // Hot path: an index loop over the spectators that move.
        for (let index = 0; index < movers.length; index++) placeMember(crowd, movers[index], Kit.stadium.lift(movers[index], time, cheer));
        crowd.wasCheering = cheer > 0;
        crowd.mesh.instanceMatrix.needsUpdate = true;
        crowd.supporters.forEach((group) => liftSupporters(group, time, isLoud));
      });
    };

    // ---- the supporters up front: sculpted figures, one instanced crowd per look and end ----
    const catalog = Kit.body.catalog(DATA.CATALOG);
    const bakery = catalog.bakery({ capacity: 16 });
    const PLACE = 4; // numbers per member of a kit crowd's `places`: x, y, z, heading
    /**
     * The looks of supporter of the ground in use, one per shirt colour of its crowd: a wardrobe person in a
     * top of the ground's dye, their rows in the atlas and, once sculpted, `isReady`. Sculpting is queued behind
     * the cast; a look of an earlier ground is sculpted already (a dye changes no surface).
     * @type {Array<{bake: Object, block: Object, isReady: boolean, job: ?Function}>}
     */
    let supporterLooks = [];
    const dressSupporters = () => {
      crowds.forEach(clearSupporters);
      supporterLooks.forEach((made) => {
        if (made.job) building.crowd.drop(made.job);
        view.atlas.free(made.block);
      });
      supporterLooks = look.shirts.map((dye, index) => {
        const bake = bakery.bakeRecipe(DATA.supporterRecipe(catalog, SUPPORTERS.seed, index, dye));
        const task = Kit.figure.sculptTask(bake, Kit.figure.layout(bake, { level: SUPPORTERS.level }));
        const made = { bake, block: Kit.figure.loadRows(view, bake), isReady: task.isDone(), job: null };
        if (made.isReady) return made;
        made.job = building.crowd.add((milliseconds) => {
          made.isReady = task.step(milliseconds);
          // Their cards come down and the figures go up in the same frame.
          if (made.isReady) seatCrowd();
          return made.isReady;
        });
        return made;
      });
    };
    /** Stands the sculpted supporters of one look at one end: a kit crowd of exactly those who are there. */
    const supportersOf = (crowd, lookIndex) => {
      const made = supporterLooks[lookIndex];
      const members = crowd.shown.filter((member) => member.shirt === lookIndex && isSculpted(member));
      if (!members.length) return null;
      const figures = Kit.figure.crowd(view, made.bake, members.length, { level: SUPPORTERS.level, rows: made.block });
      // A kit crowd places its members in its own space: the group is scaled to a supporter's height, so places are divided by it.
      const scale = SUPPORTER_SCALE;
      figures.root.scale.setScalar(scale);
      figures.root.traverse((object) => (object.name = 'supporters'));
      ends[crowd.end].add(figures.root);
      members.forEach((member, index) => figures.places.set([member.x / scale, member.y / scale, member.z / scale, crowd.toward > 0 ? 0 : Math.PI], index * PLACE));
      figures.pose();
      const everyone = members.map((_member, index) => index);
      return { figures, members, scale, everyone, lively: everyone.filter((index) => members[index].isLively) };
    };
    /** Lifts the supporters who move: the lively ones bob, and everyone jumps while the ground is loud. */
    const liftSupporters = (group, time, isLoud) => {
      const movers = isLoud ? group.everyone : group.lively;
      if (!movers.length) return;
      // Hot path: an index loop over the supporters that move.
      for (let index = 0; index < movers.length; index++) {
        const member = group.members[movers[index]];
        group.figures.places[movers[index] * PLACE + 1] = (member.y + Kit.stadium.lift(member, time, cheer)) / group.scale;
      }
      group.figures.pose();
    };
    const clearSupporters = (crowd) => {
      crowd.supporters.forEach((group) => {
        ends[crowd.end].remove(group.figures.root);
        group.figures.dispose();
      });
      crowd.supporters = [];
    };
    /** Seats the whole crowd of a ground: the cards, then the sculpted supporters whose looks are ready. */
    const seatCrowd = () => {
      seatCards();
      crowds.forEach((crowd) => {
        clearSupporters(crowd);
        crowd.supporters = supporterLooks.map((_made, index) => supportersOf(crowd, index)).filter(Boolean);
      });
    };
    dressSupporters();
    seatCrowd();

    // ---- flags that show the wind: two cloths, instances of one mesh ----
    const [clothWidth, clothHeight, clothDepth] = flag.cloth;
    const cloths = dressedInstances('flags', new THREE.BoxGeometry(clothWidth, clothHeight, clothDepth).translate(clothWidth / 2, 0, 0), 2, 'flag', {});
    const clothTurn = new THREE.Euler();
    const clothSpin = new THREE.Quaternion();
    const clothPlace = new THREE.Vector3();
    const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
    let wind = 0;
    let clothDroop = flag.slack;

    // ---- ball (one lit mesh: each face takes the panel's ramp or the patch's), its shadow and its trail ----
    const ballGroup = new THREE.Group();
    view.scene.add(ballGroup);
    const ballGeometry = new THREE.IcosahedronGeometry(FIELD.ballRadius, BALL.detail);
    const patchCentres = Array.from(new THREE.IcosahedronGeometry(1, 0).attributes.position.array);
    const faceCentre = new THREE.Vector3();
    const ballPoints = ballGeometry.attributes.position;
    /** 1 when the face a vertex belongs to points near a corner of the icosahedron (a dark patch), else 0. */
    const patchOf = (vertex) => {
      const first = vertex - (vertex % STRIDE);
      faceCentre.set(0, 0, 0);
      for (let cornerIndex = first; cornerIndex < first + STRIDE; cornerIndex++) {
        faceCentre.x += ballPoints.getX(cornerIndex);
        faceCentre.y += ballPoints.getY(cornerIndex);
        faceCentre.z += ballPoints.getZ(cornerIndex);
      }
      faceCentre.normalize();
      let nearest = -1;
      for (let centre = 0; centre < patchCentres.length; centre += STRIDE) nearest = Math.max(nearest, faceCentre.x * patchCentres[centre] + faceCentre.y * patchCentres[centre + 1] + faceCentre.z * patchCentres[centre + 2]);
      return nearest > BALL.patchWithin ? 1 : 0;
    };
    // The attribute the look reads a row offset from is per instance on an instanced mesh; on a plain mesh it is per vertex.
    ballGeometry.setAttribute('instanceRamp', new THREE.Float32BufferAttribute(Float32Array.from({ length: ballPoints.count }, (_zero, vertex) => patchOf(vertex) * (rows.ballPatch - rows.ballPanel)), 1));
    dressed('ball', ballGeometry, 'ballPanel', { instanceRamp: true, inkGroup: 4 }, ballGroup);
    // Every shadow on the turf (the ball's and each character's) is an instance of one disc: a dark core in a softer rim.
    const SHADOWS = Object.freeze({ ball: 0, firstFigure: 1, count: 5 });
    const shadowBook = Kit.paint.book(slotOf).disc({ rings: [[BALL.shadow.core, 'shade', Kit.paint.TONE.dark], [1, 'shade', Kit.paint.TONE.base]], sides: BALL.shadow.sides });
    const shadows = new THREE.InstancedMesh(Kit.paint.geometry(shadowBook), undefined, SHADOWS.count);
    shadows.name = 'shadows';
    shadows.frustumCulled = false;
    view.scene.add(shadows);
    view.shading.dress(shadows, { ramp: rows.shade, stamps: true, blockRow: rows[WORLD_RAMPS[0]], inkGroup: 0 });
    shadows.material[0].side = THREE.DoubleSide;
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    const placeShadow = (index, x, z, across, deep) => {
      shadows.setMatrixAt(index, across > 0 ? scratchMatrix.makeScale(across, 1, deep).setPosition(x, SHADOW_LAYER, z) : hiddenMatrix);
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
    const figures = [];

    // ---- camera ----
    const lookAt = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const keeperPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SIM.KEEPER_Z);
    const pointer = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const bufferSize = new THREE.Vector2();
    const seatCamera = () => {
      const seat = solveSeat(SEATS[seatName], size);
      camera.position.set(...seat.at);
      camera.fov = seat.fov;
      camera.near = CAMERA_RANGE.near;
      camera.far = CAMERA_RANGE.far;
      camera.updateProjectionMatrix();
      camera.lookAt(lookAt.set(...seat.look));
      camera.updateMatrixWorld();
      // The grid is the same in every seat of a screen, so a cut changes the picture and never the size of its texels.
      grid = gridOf(grain, size, renderer.getDrawingBufferSize(bufferSize).y);
      view.use('pixel', Kit.pixelGrid.settings(grid));
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
    const discRect = (x, y, z, radius) => Kit.seat.disc(projected.set(x, y, z).applyMatrix4(camera.matrixWorldInverse), radius, camera, size);
    const onScreen = (rect) => Kit.seat.rect.cut(rect, size);
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
        rect = Kit.seat.rect.union(rect, onScreen(discRect(bonePoint.x, bonePoint.y + (isHead ? FIGURE_BOUNDS.headLift : 0), bonePoint.z, isHead ? FIGURE_BOUNDS.head : FIGURE_BOUNDS.limb)));
      }
      return rect;
    };

    // ---- the texel grid under a moving thing ----
    const gridRight = new THREE.Vector3();
    const gridUp = new THREE.Vector3();
    const gridPoint = new THREE.Vector3();
    /**
     * Moves an object to the nearest texel of the picture at its own depth, along the camera's right and up
     * (a perspective picture has no one texel size: it grows with depth). Returns the undo.
     * @param {THREE.Object3D} object a child of the scene
     * @returns {function(): void}
     */
    const snapToGrid = (object) => {
      const [across, along] = Kit.pixelGrid.snapShift(gridPoint.copy(object.position).applyMatrix4(camera.matrixWorldInverse), camera.fov, grid.rows);
      gridRight.setFromMatrixColumn(camera.matrixWorld, 0);
      gridUp.setFromMatrixColumn(camera.matrixWorld, 1);
      object.position.addScaledVector(gridRight, across).addScaledVector(gridUp, along);
      return () => object.position.addScaledVector(gridRight, -across).addScaledVector(gridUp, -along);
    };

    const stage = {
      view,
      catalog,
      FIGURE_SCALE,
      /**
       * Sets how fine the pixel grid is. Characters built from now on take the grain's level of detail; those
       * already standing keep theirs until the next match.
       * @param {string} name a key of `Kit.pixelGrid.GRAINS`
       */
      setGrain(name) {
        grain = name;
        seatCamera();
      },
      /** The grid in use on this screen (`gridOf`): its grain, texel size and rows. */
      grain: () => ({ ...grid }),
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
        const previous = look;
        look = LOOKS[lookId] || LOOKS.park;
        const colors = { ...SHARED_COLORS, ...look.colors, ballPanel: ballColors[0], ballPatch: ballColors[1] };
        WORLD_RAMPS.forEach((name) => view.atlas.writeRamp(world, name, colors[name]));
        // The same ground again (the next rival of a cup): the crowd is already in its seats.
        if (look === previous) return;
        dressSupporters();
        seatCrowd();
      },
      /**
       * Builds a character from a recipe and stands it in the scene. Its surface is sculpted over the next
       * frames (a slice of each, the characters asked for first), at the level of detail its size on screen
       * asks for, which the look then keeps right as the camera cuts closer or further.
       * @param {Object} recipe a `Recipe` of the wardrobe catalogue
       * @param {{seat: string, z: number}} standing where it will first be seen: from which seat (a key of
       *   `SEATS`) and how far up the pitch, world metres; so it is sculpted once, at the level it will be drawn
       * @returns {Object} a `Figure` (kit/figure.js) with `footing`, the point (x, z) its shadow lies under: the
       *   root's place until whoever animates it says otherwise (a dive carries the body off its root)
       */
      addFigure(recipe, standing) {
        const texels = Kit.seat.span(solveSeat(SEATS[standing.seat], size), { z: standing.z, to: FIGURE_HEIGHT }, grid.rows);
        const figure = Kit.figure.build(view, bakery.bakeRecipe(recipe), { level: 'auto', least: CAST_LEAST_LEVEL, pixels: texels, sculpt: 'steps' });
        figure.root.scale.setScalar(FIGURE_SCALE);
        figure.footing = figure.root.position;
        figures.push(figure);
        figure.building = building.cast.add((milliseconds) => figure.isSettled() || figure.settle(milliseconds));
        return figure;
      },
      /** Removes every character built with `addFigure`. */
      clearFigures() {
        figures.splice(0).forEach((figure) => {
          building.cast.drop(figure.building);
          figure.dispose();
        });
      },
      /** Is anything still being built (a character's surface, a supporter's)? For a playtest that waits for the finished picture. */
      isBuilding: () => building.cast.size() + building.crowd.size() > 0,
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
          goal: corners.every(Boolean) ? corners.reduce(Kit.seat.rect.union) : null,
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
        const startedAt = performance.now();
        if (building.cast.run(BUILD_SLICE_MS)) building.crowd.run(BUILD_SLICE_MS - (performance.now() - startedAt));
        cheer = Math.max(0, cheer - CHEER_FALL * dt);
        moveCrowd(time);
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
      /**
       * Draws the frame. The characters and the ball are stood on the texel grid for the frame, so a body that
       * walks keeps one outline instead of a different one at every part of a texel.
       */
      render() {
        // A character whose surface is still being sculpted is not drawn: it arrives whole a few frames later.
        const unready = figures.filter((figure) => figure.root.visible && !figure.isSettled());
        unready.forEach((figure) => (figure.root.visible = false));
        const restore = [...figures.filter((figure) => figure.root.visible).map((figure) => snapToGrid(figure.root)), ...(ballGroup.visible ? [snapToGrid(ballGroup)] : [])];
        view.render(camera, { clearColor: look.sky });
        restore.forEach((undo) => undo());
        unready.forEach((figure) => (figure.root.visible = true));
      },
      dispose() {
        stage.clearFigures();
        crowds.forEach(clearSupporters);
        view.dispose();
      },
    };
    return stage;
  };

  window.SPOT_KICK_STAGE = { LOOKS, LOOK, WORLD_RAMPS, SEATS, HUD_BAND, FIGURE_SCALE, solveSeat, gridOf, build };
})();
