/**
 * Spot Kick Showdown stage: everything drawn that is not a character's performance. The pitch, the goal and its
 * net, the stands and their crowd, the ball, the aim line and the confetti are all dressed meshes of one
 * `Kit.look.view` in the pixel preset, coloured from one world palette, so the ground and the characters are
 * one low-resolution picture.
 *
 * Owns:  the ground looks (`LOOKS`: a palette per stadium), the camera seats per role and orientation (`SEATS`),
 *        and `build(ctx)`: the scene and the small handles the game drives it with (ball, net, aim, marker,
 *        crowd, bits, flags, figures, camera, picking a point of the keeper's plane).
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

  // =================================================== looks and seats ===================================================

  /** Ramps every ground has, in atlas order. `crowd0..5` and `bit0..3` must stay together: instances index into them. */
  const WORLD_RAMPS = ['grass', 'stripe', 'line', 'frame', 'net', 'stand', 'step', 'board', 'boardAlt', 'shade', 'ballPanel', 'ballPatch', 'aim', 'sky', 'haze', 'flag', 'lamp', 'skin0', 'skin1', 'skin2', 'crowd0', 'crowd1', 'crowd2', 'crowd3', 'crowd4', 'crowd5', 'bit0', 'bit1', 'bit2', 'bit3'];
  const CROWD_COLORS = 6;
  const SKIN_COLORS = 3;
  const BIT_COLORS = 4;

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
   * Camera seats: where the camera sits and looks for each role, upright and on its side, and how many texel
   * rows the picture has there (fewer rows = bigger texels; a phone held upright shows less width, so it gets
   * more rows to keep the far goal readable).
   */
  const SEATS = {
    taker: {
      portrait: { at: [0, 2.7, 5.6], look: [0, 1.25, -3.2], fov: 48, rows: 300, wait: { x: -1.0, z: 1.0 } },
      landscape: { at: [0, 2.1, 4.2], look: [0, 0.7, -8], fov: 44, rows: 200, wait: { x: -1.75, z: 0.7 } },
    },
    keeper: {
      portrait: { at: [0, 5.0, -18.5], look: [0, 2.0, -5.5], fov: 58, rows: 300 },
      landscape: { at: [0, 4.2, -14.5], look: [0, 1.4, -5], fov: 44, rows: 200 },
    },
  };

  /** Wardrobe characters stand about 1.1 m; a footballer here stands about 1.75 m. */
  const FIGURE_SCALE = 1.6;

  /** The surroundings, metres. Stands and boards sit behind each end; each is hidden when the camera is behind it. */
  const SURROUND = Object.freeze({
    pitchHalfWidth: 26,
    stripeDepth: 2.4,
    boardZ: 3.4, // behind the goal line (and mirrored the same distance behind the taker's end)
    board: { height: 0.8, width: 3.2, depth: 0.12 },
    standZ: 4.6,
    tiers: 7,
    tier: { rise: 0.55, run: 0.8, halfWidth: 17 },
    seat: { spacing: 0.72, body: [0.42, 0.5, 0.3], head: 0.26 },
    takerEndZ: 9.5, // how far behind the spot the far boards stand
    lamp: { x: 13, height: 9, size: 1.6 },
  });

  /** Pitch markings: line width, the six-yard box, the spot and the arc, metres. */
  const MARKS = Object.freeze({ width: 0.09, lift: 0.012, boxHalfWidth: 4.2, boxDepth: 2.6, spotRadius: 0.11, arcRadius: 3.4, arcSteps: 14 });

  /** The net: knots across and down each sheet. */
  const NETTING = Object.freeze({ across: 13, down: 6, deep: 4, pushRadius: 0.42, step: 1 / 60 });

  /** Palette rows: the ground's ramps plus a block of 16 for each of the four characters of a match. */
  const ATLAS_ROWS = 128;
  const AIM_DOTS = 18;
  const BITS = Object.freeze({ count: 90, size: 0.07, gravity: 7, drag: 1.2, life: [0.9, 1.7] });
  /** A crowd member's jump when the ground erupts, metres, and how fast the wave of it runs. */
  const CHEER = Object.freeze({ jump: 0.22, rate: 9, fall: 0.7 });

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
      const offset = positions.length / 3;
      positions.push(...part.attributes.position.array);
      normals.push(...part.attributes.normal.array);
      const count = part.attributes.position.count;
      // A geometry without an index draws its vertices in order.
      indices.push(...Array.from(part.index ? part.index.array : { length: count }, (index, order) => (part.index ? index : order) + offset));
      part.dispose();
    });
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setIndex(indices);
    return merged;
  };

  /** A box geometry of a size, moved to a place. */
  const boxAt = (width, height, depth, x, y, z) => new THREE.BoxGeometry(width, height, depth).translate(x, y, z);
  /** A flat marking on the turf: a thin slab between two x and two z. */
  const slab = (fromX, toX, fromZ, toZ) => boxAt(Math.abs(toX - fromX), 0.004, Math.abs(toZ - fromZ), (fromX + toX) / 2, MARKS.lift, (fromZ + toZ) / 2);

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
    let role = 'taker';

    /** Adds a mesh to the look scene, dressed in a world ramp. */
    const dressed = (geometry, ramp, part = {}, parent = view.scene) => {
      const mesh = new THREE.Mesh(geometry);
      parent.add(mesh);
      view.shading.dress(mesh, { ramp: rows[ramp], ...part });
      return mesh;
    };

    // ---- turf and markings ----
    const lineZ = SIM.LINE_Z;
    const stripes = Array.from({ length: 16 }, (_unused, index) => index).filter((index) => index % 2 === 0)
      // Mown stripes lie just under the markings, so a line is never fought over by two surfaces.
      .map((index) => boxAt(SURROUND.pitchHalfWidth * 2, 0.004, SURROUND.stripeDepth, 0, MARKS.lift / 2, lineZ - 2 + (index + 0.5) * SURROUND.stripeDepth));
    dressed(boxAt(SURROUND.pitchHalfWidth * 2, 0.2, 60, 0, -0.1, 0), 'grass', { tone: 0.66, inkGroup: 0 });
    dressed(mergeGeometries(stripes), 'stripe', { tone: 0.66, inkGroup: 0 });
    const half = MARKS.width / 2;
    const arc = Array.from({ length: MARKS.arcSteps }, (_unused, index) => {
      const [from, to] = [index, index + 1].map((step) => (-0.5 + step / MARKS.arcSteps) * 1.5);
      const [middle, length] = [(from + to) / 2, MARKS.arcRadius * (to - from) + MARKS.width];
      return new THREE.BoxGeometry(length, 0.004, MARKS.width).rotateY(-middle).translate(Math.sin(middle) * MARKS.arcRadius, MARKS.lift, lineZ + MARKS.boxDepth + 3.2 + Math.cos(middle) * MARKS.arcRadius - MARKS.arcRadius);
    });
    dressed(
      mergeGeometries([
        slab(-SURROUND.pitchHalfWidth, SURROUND.pitchHalfWidth, lineZ - half, lineZ + half),
        slab(-MARKS.boxHalfWidth, MARKS.boxHalfWidth, lineZ + MARKS.boxDepth - half, lineZ + MARKS.boxDepth + half),
        slab(-MARKS.boxHalfWidth - half, -MARKS.boxHalfWidth + half, lineZ, lineZ + MARKS.boxDepth),
        slab(MARKS.boxHalfWidth - half, MARKS.boxHalfWidth + half, lineZ, lineZ + MARKS.boxDepth),
        new THREE.CylinderGeometry(MARKS.spotRadius, MARKS.spotRadius, 0.004, 8).translate(0, MARKS.lift, 0),
        ...arc,
      ]),
      'line',
      { tone: 1, inkGroup: 0 }
    );

    // ---- goal frame and net ----
    const post = (x) => new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.height, 8).translate(x, goal.height / 2, lineZ);
    const bar = new THREE.CylinderGeometry(goal.postRadius, goal.postRadius, goal.halfWidth * 2 + goal.postRadius * 2, 8).rotateZ(Math.PI / 2).translate(0, goal.height, lineZ);
    dressed(mergeGeometries([post(-goal.halfWidth), post(goal.halfWidth), bar]), 'frame', { inkGroup: 2 });
    const backZ = lineZ - goal.depth;
    const isFramePinned = (pinTop, pinBottom) => (column, row, columns, lastRow) => column === 0 || column === columns - 1 || (pinTop && row === 0) || (pinBottom && row === lastRow);
    const sheetOf = (origin, across, down, columns, knotRows, pin) => Kit.netting.sheet({ origin, across, down, columns, rows: knotRows, isPinned: (column, row) => pin(column, row, columns, knotRows - 1) });
    const nets = [
      sheetOf({ x: -goal.halfWidth, y: goal.height, z: backZ }, { x: goal.halfWidth * 2, y: 0, z: 0 }, { x: 0, y: -goal.height, z: 0 }, NETTING.across, NETTING.down, isFramePinned(true, true)),
      sheetOf({ x: -goal.halfWidth, y: goal.height, z: lineZ }, { x: 0, y: 0, z: -goal.depth }, { x: 0, y: -goal.height, z: 0 }, NETTING.deep, NETTING.down, isFramePinned(true, true)),
      sheetOf({ x: goal.halfWidth, y: goal.height, z: lineZ }, { x: 0, y: 0, z: -goal.depth }, { x: 0, y: -goal.height, z: 0 }, NETTING.deep, NETTING.down, isFramePinned(true, true)),
      sheetOf({ x: -goal.halfWidth, y: goal.height, z: lineZ }, { x: goal.halfWidth * 2, y: 0, z: 0 }, { x: 0, y: 0, z: -goal.depth }, NETTING.across, NETTING.deep, isFramePinned(true, true)),
    ];
    const knotOffsets = nets.reduce((offsets, net) => [...offsets, offsets[offsets.length - 1] + net.positions.length / 3], [0]);
    const netPositions = new Float32Array(knotOffsets[nets.length] * 3);
    const netGeometry = new THREE.BufferGeometry();
    netGeometry.setAttribute('position', new THREE.BufferAttribute(netPositions, 3));
    // Lines have no facing; the look only needs some normal to exist, and the fixed tone ignores it.
    netGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(netPositions.length).fill(0).map((_zero, index) => (index % 3 === 1 ? 1 : 0)), 3));
    netGeometry.setIndex(nets.flatMap((net, index) => Array.from(net.links, (knot) => knot + knotOffsets[index])));
    const copyNets = () => {
      nets.forEach((net, index) => netPositions.set(net.positions, knotOffsets[index] * 3));
      netGeometry.attributes.position.needsUpdate = true;
    };
    copyNets();
    const netLines = new THREE.LineSegments(netGeometry);
    netLines.frustumCulled = false;
    view.scene.add(netLines);
    view.shading.dress(netLines, { ramp: rows.net, tone: 1, inkGroup: 0 });
    const netClock = { carry: 0, isMoving: false };

    // ---- stands, boards, lamps: one group per end, hidden when the camera sits behind it ----
    const ends = { goal: new THREE.Group(), taker: new THREE.Group() };
    Object.values(ends).forEach((group) => view.scene.add(group));
    /** z of a distance behind an end: the goal end runs towards -z, the taker's end towards +z. */
    const behind = { goal: (distance) => lineZ - distance, taker: (distance) => SURROUND.takerEndZ + distance - SURROUND.boardZ };
    const seats = [];
    Object.keys(ends).forEach((end) => {
      const group = ends[end];
      const zOf = behind[end];
      const { tier, board } = SURROUND;
      const boards = Array.from({ length: 12 }, (_unused, index) => boxAt(board.width - 0.1, board.height, board.depth, (index - 5.5) * board.width, board.height / 2, zOf(SURROUND.boardZ)));
      dressed(mergeGeometries(boards.filter((_unused, index) => index % 2 === 0)), 'board', {}, group);
      dressed(mergeGeometries(boards.filter((_unused, index) => index % 2 === 1)), 'boardAlt', {}, group);
      const steps = Array.from({ length: SURROUND.tiers }, (_unused, index) => boxAt(tier.halfWidth * 2, tier.rise * (index + 1), tier.run, 0, (tier.rise * (index + 1)) / 2, zOf(SURROUND.standZ + index * tier.run + tier.run / 2)));
      dressed(mergeGeometries(steps.filter((_unused, index) => index % 2 === 0)), 'stand', {}, group);
      dressed(mergeGeometries(steps.filter((_unused, index) => index % 2 === 1)), 'step', {}, group);
      dressed(boxAt(tier.halfWidth * 2, 14, 0.5, 0, 7, zOf(SURROUND.standZ + SURROUND.tiers * tier.run + 0.25)), 'stand', { tone: 0.33 }, group);
      Array.from({ length: SURROUND.tiers }, (_unused, tierIndex) => tierIndex).forEach((tierIndex) => {
        const count = Math.floor((tier.halfWidth * 2) / SURROUND.seat.spacing);
        Array.from({ length: count }, (_unused, seat) => seat).forEach((seat) => {
          // A fixed scatter (no random): the same crowd every visit, and no two neighbours alike.
          const scatter = Math.sin(seat * 12.9898 + tierIndex * 78.233 + (end === 'goal' ? 0 : 5)) * 43758.5453;
          const chance = scatter - Math.floor(scatter);
          seats.push({ end, x: (seat - (count - 1) / 2) * SURROUND.seat.spacing, y: tier.rise * (tierIndex + 1), z: zOf(SURROUND.standZ + tierIndex * tier.run + tier.run * 0.45), chance, shirt: Math.floor(chance * 997) % CROWD_COLORS, skin: Math.floor(chance * 577) % SKIN_COLORS });
        });
      });
    });
    const lampGeometry = mergeGeometries([-1, 1].flatMap((side) => [boxAt(0.25, SURROUND.lamp.height, 0.25, side * SURROUND.lamp.x, SURROUND.lamp.height / 2, behind.goal(SURROUND.standZ - 0.6))]));
    dressed(lampGeometry, 'stand', {}, ends.goal);
    const lampHeads = dressed(mergeGeometries([-1, 1].map((side) => boxAt(SURROUND.lamp.size * 1.4, SURROUND.lamp.size, 0.3, side * SURROUND.lamp.x, SURROUND.lamp.height + SURROUND.lamp.size / 2, behind.goal(SURROUND.standZ - 0.6)))), 'lamp', { emissive: true }, ends.goal);

    // ---- the crowd: two instanced meshes per end (bodies, heads), each instance its own shirt or skin row ----
    const crowdOf = (end) => {
      const members = seats.filter((seat) => seat.end === end);
      const [bodyWidth, bodyHeight, bodyDepth] = SURROUND.seat.body;
      const bodyGeometry = new THREE.BoxGeometry(bodyWidth, bodyHeight, bodyDepth).translate(0, bodyHeight / 2, 0);
      const headGeometry = new THREE.BoxGeometry(SURROUND.seat.head, SURROUND.seat.head, SURROUND.seat.head).translate(0, bodyHeight + SURROUND.seat.head / 2, 0);
      bodyGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(Float32Array.from(members, (member) => member.shirt), 1));
      headGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(Float32Array.from(members, (member) => member.skin), 1));
      const meshes = [[bodyGeometry, rows.crowd0], [headGeometry, rows.skin0]].map(([geometry, ramp]) => {
        const mesh = new THREE.InstancedMesh(geometry, undefined, members.length);
        mesh.frustumCulled = false;
        ends[end].add(mesh);
        view.shading.dress(mesh, { ramp, instanceRamp: true, inkGroup: 3 });
        return mesh;
      });
      return { members, meshes };
    };
    const crowds = [crowdOf('goal'), crowdOf('taker')];
    const seatMatrix = new THREE.Matrix4();
    let cheer = 0;
    let isCrowdStill = false;
    /** Writes every seat's place: empty seats are shrunk to nothing, and a cheering crowd jumps in a wave. */
    const placeCrowd = (time) => {
      crowds.forEach(({ members, meshes }) => {
        // Hot path while cheering: an index loop and a direct matrix write per seat.
        for (let index = 0; index < members.length; index++) {
          const member = members[index];
          const isTaken = member.chance < look.crowd;
          const jump = cheer > 0 ? Math.max(0, Math.sin(time * CHEER.rate + member.chance * TURN)) * CHEER.jump * cheer : 0;
          seatMatrix.makeScale(isTaken ? 1 : 0, isTaken ? 1 : 0, isTaken ? 1 : 0).setPosition(member.x, member.y + jump, member.z);
          meshes[0].setMatrixAt(index, seatMatrix);
          meshes[1].setMatrixAt(index, seatMatrix);
        }
        meshes.forEach((mesh) => (mesh.instanceMatrix.needsUpdate = true));
      });
    };
    placeCrowd(0);

    // ---- flags that show the wind ----
    const flags = [-1, 1].map((side) => {
      const pole = new THREE.Group();
      pole.position.set(side * (goal.halfWidth + 1.6), 0, lineZ);
      view.scene.add(pole);
      dressed(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6).translate(0, 0.75, 0), 'frame', {}, pole);
      const cloth = dressed(boxAt(0.5, 0.3, 0.03, 0.25, 0, 0), 'flag', {}, pole);
      cloth.position.y = 1.33;
      return cloth;
    });
    let wind = 0;

    // ---- ball, shadows ----
    const ballGroup = new THREE.Group();
    view.scene.add(ballGroup);
    dressed(new THREE.IcosahedronGeometry(FIELD.ballRadius, 1), 'ballPanel', { inkGroup: 4 }, ballGroup);
    const patchSpots = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    dressed(mergeGeometries(patchSpots.map(([x, y, z]) => new THREE.IcosahedronGeometry(FIELD.ballRadius * 0.46, 0).translate(x * FIELD.ballRadius * 0.7, y * FIELD.ballRadius * 0.7, z * FIELD.ballRadius * 0.7))), 'ballPatch', { inkGroup: 4 }, ballGroup);
    const shadowGeometry = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
    const shadowOf = () => dressed(shadowGeometry, 'shade', { tone: 0.5, inkGroup: 0 });
    const ballShadow = shadowOf();
    const spinAxis = new THREE.Vector3();

    // ---- aim line, reticle and the keeper's dive marker ----
    const aimDots = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.07, 0), undefined, AIM_DOTS);
    aimDots.frustumCulled = false;
    view.scene.add(aimDots);
    view.shading.dress(aimDots, { ramp: rows.aim, emissive: true });
    aimDots.count = 0;
    const ringOf = (inner, outer, ramp) => {
      const ring = dressed(new THREE.RingGeometry(inner, outer, 16), ramp, { emissive: true });
      ring.material[0].side = THREE.DoubleSide;
      ring.visible = false;
      return ring;
    };
    const reticle = ringOf(0.2, 0.3, 'aim');
    const marker = ringOf(0.28, 0.4, 'aim');
    const tellArrow = dressed(new THREE.ConeGeometry(0.16, 0.42, 4).rotateZ(-Math.PI / 2), 'aim', { emissive: true });
    tellArrow.visible = false;

    // ---- bits: confetti, turf, chalk ----
    const bitGeometry = new THREE.BoxGeometry(BITS.size, BITS.size, BITS.size);
    const bitRamps = new Float32Array(BITS.count);
    bitGeometry.setAttribute('instanceRamp', new THREE.InstancedBufferAttribute(bitRamps, 1));
    const bitMesh = new THREE.InstancedMesh(bitGeometry, undefined, BITS.count);
    bitMesh.frustumCulled = false;
    view.scene.add(bitMesh);
    view.shading.dress(bitMesh, { ramp: rows.bit0, instanceRamp: true, emissive: true });
    const bits = Array.from({ length: BITS.count }, () => ({ life: 0, x: 0, y: 0, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0 }));
    let nextBit = 0;
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    bits.forEach((_bit, index) => bitMesh.setMatrixAt(index, hiddenMatrix));

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
    const seatNow = () => SEATS[role][size.portrait ? 'portrait' : 'landscape'];
    const seatCamera = () => {
      const seat = seatNow();
      camera.position.set(...seat.at);
      camera.fov = seat.fov;
      camera.near = 0.3;
      camera.far = 80;
      camera.updateProjectionMatrix();
      camera.lookAt(lookAt.set(...seat.look));
      view.use('pixel', { pixelRows: seat.rows });
      // An end's stand is scenery for the camera that faces it and a wall for the camera that sits in it.
      ends.goal.visible = role === 'taker';
      ends.taker.visible = role === 'keeper';
    };
    seatCamera();

    const stage = {
      view,
      catalog,
      FIGURE_SCALE,
      /**
       * Seats the camera for a role and shows the end it faces.
       * @param {('taker'|'keeper')} nextRole the player's role
       */
      setRole(nextRole) {
        role = nextRole;
        seatCamera();
      },
      /** Where the player's taker waits beside the ball in the seat in use (clear of the goal as this seat sees it), world metres. */
      takerWait: () => SEATS.taker[size.portrait ? 'portrait' : 'landscape'].wait,
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
       * @returns {Object} a `Figure` (kit/figure.js) with `shadow`, a mesh on the turf under `footing` (a point with x and z: the root's place by default)
       */
      addFigure(recipe) {
        const figure = Kit.figure.build(view, bakery.bakeRecipe(recipe));
        figure.root.scale.setScalar(FIGURE_SCALE);
        figure.shadow = shadowOf();
        // Where the body is over the turf: the root, until whoever animates it says otherwise (a dive carries the body off its root).
        figure.footing = figure.root.position;
        figure.shadow.scale.set(0.42, 1, 0.3);
        figures.push(figure);
        return figure;
      },
      /** Removes every character built with `addFigure`. */
      clearFigures() {
        figures.splice(0).forEach((figure) => {
          view.scene.remove(figure.shadow);
          figure.dispose();
        });
      },
      ball: {
        /**
         * Puts the ball where the simulation has it and rolls it by its spin and its travel.
         * @param {{x: number, y: number, z: number}} position
         * @param {{x: number, y: number, z: number}} velocity
         * @param {number} dt seconds since the last call
         */
        set(position, velocity, dt) {
          ballGroup.visible = ballShadow.visible = true;
          ballGroup.position.set(position.x, position.y, position.z);
          const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
          // It rolls about the axis across its travel, as a ball on turf does.
          if (speed > 0.01) ballGroup.rotateOnWorldAxis(spinAxis.set(velocity.z, 0, -velocity.x).normalize(), (speed / FIELD.ballRadius) * dt * 0.35);
          const height = Math.max(0, position.y - FIELD.ballRadius);
          const spread = FIELD.ballRadius * (1.1 + height * 0.25);
          ballShadow.position.set(position.x, MARKS.lift + 0.004, position.z);
          ballShadow.scale.set(spread, 1, spread * 0.8);
        },
        hide() {
          ballGroup.visible = ballShadow.visible = false;
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
          const isNear = Boolean(ballPosition) && ballPosition.z < lineZ + 0.2;
          if (!isNear && !netClock.isMoving) return false;
          let touching = 0;
          netClock.carry = Math.min(netClock.carry + dt, NETTING.step * 4);
          let farthest = 0;
          while (netClock.carry >= NETTING.step) {
            netClock.carry -= NETTING.step;
            nets.forEach((net) => {
              farthest = Math.max(farthest, Kit.netting.step(net, NETTING.step));
              if (isNear) touching += Kit.netting.push(net, ballPosition.x, ballPosition.y, ballPosition.z, NETTING.pushRadius);
            });
          }
          netClock.isMoving = isNear || farthest > 0.004;
          copyNets();
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
          const stride = Math.max(1, Math.floor(points.length / AIM_DOTS));
          const phase = Math.floor(time * 14) % stride;
          let shown = 0;
          for (let index = phase; index < points.length && shown < AIM_DOTS; index += stride) {
            const size = lerp(1.2, 0.75, index / points.length);
            seatMatrix.makeScale(size, size, size).setPosition(points[index].x, points[index].y, points[index].z);
            aimDots.setMatrixAt(shown++, seatMatrix);
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
          marker.position.set(point.x, point.y, SIM.KEEPER_Z - 0.05);
        },
        hide() {
          marker.visible = false;
        },
      },
      tell: {
        /** Shows an arrow over the taker pointing to a side of the goal (-1 or 1 in world x), or hides it for 0. */
        show(side, x, z) {
          tellArrow.visible = side !== 0;
          tellArrow.position.set(x, 2.5, z);
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
       * @param {{count?: number, speed?: number, up?: number, colors?: number[]}} [options] `colors`: indices 0..3 of the bit ramps
       */
      burst(from, { count = 24, speed = 4, up = 3, colors = [0, 1, 2, 3] } = {}) {
        for (let index = 0; index < count; index++) {
          const bit = bits[nextBit];
          const angle = Math.random() * TURN;
          const reach = Math.random() * speed;
          Object.assign(bit, { life: lerp(BITS.life[0], BITS.life[1], Math.random()), x: from.x, y: from.y, z: from.z, velocityX: Math.cos(angle) * reach, velocityY: up * (0.4 + Math.random()), velocityZ: Math.sin(angle) * reach });
          bitRamps[nextBit] = colors[index % colors.length];
          nextBit = (nextBit + 1) % BITS.count;
        }
        bitGeometry.attributes.instanceRamp.needsUpdate = true;
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
        flags.forEach((cloth) => {
          const strength = clamp(Math.abs(wind) / 12);
          // A slack flag hangs; a full one stands out along the wind and flutters.
          cloth.rotation.y = wind >= 0 ? 0 : Math.PI;
          cloth.rotation.z = damp(cloth.rotation.z, lerp(-1.35, 0, strength) + Math.sin(time * (4 + strength * 9)) * 0.12 * strength, 6, dt);
        });
        marker.rotation.z = reticle.rotation.z = time * 2;
        const pulse = 1 + Math.sin(time * 9) * 0.12;
        reticle.scale.setScalar(pulse);
        // Hot path: an index loop over the live bits.
        for (let index = 0; index < bits.length; index++) {
          const bit = bits[index];
          if (bit.life <= 0) continue;
          bit.life -= dt;
          bit.velocityY -= BITS.gravity * dt;
          const kept = Math.max(0, 1 - BITS.drag * dt);
          bit.x += (bit.velocityX *= kept) * dt;
          bit.y = Math.max(0.03, bit.y + bit.velocityY * dt);
          bit.z += (bit.velocityZ *= kept) * dt;
          bitMesh.setMatrixAt(index, bit.life > 0 ? seatMatrix.makeRotationZ(bit.life * 9).setPosition(bit.x, bit.y, bit.z) : hiddenMatrix);
          bitMesh.instanceMatrix.needsUpdate = true;
        }
        figures.forEach((figure) => figure.shadow.position.set(figure.footing.x, MARKS.lift + 0.002, figure.footing.z));
      },
      /** Draws the frame. */
      render() {
        view.render(camera, { clearColor: look.sky });
      },
      /** Draw calls and triangles of the last frame, for the performance note in the report. */
      dispose() {
        stage.clearFigures();
        view.dispose();
      },
    };
    return stage;
  };

  window.SPOT_KICK_STAGE = { LOOKS, SEATS, FIGURE_SCALE, build };
})();
