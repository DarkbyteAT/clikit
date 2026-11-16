/**
 * Kit figure sculpt: a body bake as a few smooth, skinned surfaces instead of one rigid solid per bone. The
 * body's own solids are blended into one skin per paint (kit/sculpt.js), so limbs run into the torso and a
 * head into its neck; every painted region (a sleeve, trousers, hair) becomes a layer of its own, the same
 * surface pushed out and cut along the region's edge, so cloth has thickness and a hem instead of being a
 * colour on the skin. Each layer's vertices carry bone weights, so one mesh bends with the rig.
 *
 * Owns:  `Kit.figure.sculptLayers` (a bake and its layout -> the layers as plain arrays, and which layout
 *        pieces they replace), `SCULPT` (its tunables) and `restMatrices` (a bake's rest pose as bone matrices).
 * Does not own: the blending and meshing (kit/sculpt.js), what pieces a bake has (kit/figure-layout.js), the
 *        regions' predicates (kit/region.js, kit/body-surface.js), or THREE (kit/figure.js binds the arrays
 *        to skinned meshes).
 *
 * What is sculpted: the solids of the body itself and of its solid features (a nose, an ear). What stays rigid:
 * attached parts (a sword, a hat: thin and hard-edged, which a grid would blur) and flat stamps (a face).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-sculpt.js.
 */
(() => {
  /** Tunables, metres unless noted. */
  const SCULPT = Object.freeze({
    /** A solid's fillet is this share of its half-thickness, within [leastBlend, mostBlend]. */
    blendShare: 0.85,
    leastBlend: 0.004,
    mostBlend: 0.09,
    /** The widest fillet where a limb (or a head) joins the trunk: a neck and a shoulder stay a neck and a shoulder. */
    mostJoin: 0.025,
    /** The least a painted layer stands off the surface below it, so two layers never share a surface. */
    leastRaise: 0.004,
    layerGap: 0.003,
    /** Paint (a region with no raise: stripes, a trim, a tattoo) lies this far above the surface it is on. */
    paintLift: 0.0012,
    /** Ownership of a vertex fades from one bone to the next over this share of the nearer solid's fillet. */
    weightSpread: 0.03,
    /** A layer keeps what lies within this distance inside the surface it sits on (its cut edges), and drops the rest. */
    buriedDepth: 0.002,
    /** The sculpting pose swings a limb this far (radians) from the trunk when its joint is `fullSpreadAt` or more to the side; less when nearer; not at all within `midline`. */
    spread: 0.75,
    fullSpreadAt: 0.1,
    midline: 0.02,
    /** A limb shorter than this is not swung. */
    leastLimb: 0.02,
    /** At rest a limb's joints stand at least this share of their own half-thickness clear of the trunk; it opens by up to `mostOpen` radians, tried in `clearSteps` steps, to get there. */
    clearShare: 0.9,
    mostOpen: 0.7,
    clearSteps: 14,
    /**
     * Everything is meshed on the body's one cell, so a part costs what its area costs and no more. A solid
     * thinner than the grid can hold (a cloak's panel, a visor, a fin) is
     * thickened to `thickenedCells` cells: cloth and brims then have a rounded edge at any size instead of
     * falling between samples, and a coarser level draws them chunkier, as it does everything. One thinner
     * than `leastThinShare` of that (a wire) stays a rigid piece.
     */
    thickenedCells: 1.9,
    leastThinShare: 0.4,
    /** A draped object's vertex is shared between the body solids within this many metres of being its nearest. */
    drapeSpread: 0.16,
    /** Within that, a vertex stays with its nearest solid by this power of nearness (`Kit.sculpt.weights`). */
    drapeSharpness: 5,
    /** Sculpted bakes kept for reuse (`sculptCache`): at most this many, and at most `keptBytes` of arrays between them. */
    kept: 24,
    keptBytes: 12e6,
  });
  /** Numbers per vertex of a surface's `paint`: the ramp slot and the ink group. */
  const PAINT = 2;
  /** Owners per vertex of a layer. */
  const OWNERS = 4;
  /** The largest vertex index a 16-bit index buffer can hold. */
  const MOST_SHORT_INDEX = 65535;
  const MATRIX = 16;
  /** Numbers of an affine map kept as three rows of four. */
  const ROW_AFFINE = 12;
  const VECTOR = 3;
  const QUATERNION = 4;

  /**
   * A bake's rest pose as one column-major 4 x 4 matrix per bone, in the bake's own space (no grounding).
   * @param {Object} bake from a bakery
   * @param {Object} [pose] local joint transforms to use instead of the bake's rest pose
   * @returns {Float32Array} 16 per bone
   * @complexity O(bones)
   * @example const matrices = Kit.figure.restMatrices(bake); // bone b at matrices.subarray(b * 16, b * 16 + 16)
   */
  const restMatrices = (bake, pose = bake.rest) => {
    const { plan } = bake;
    const world = Kit.body.worldTransforms(plan, pose || Kit.body.createPose(plan), Kit.body.createPose(plan));
    const matrices = new Float32Array(plan.boneCount * MATRIX);
    for (let bone = 0; bone < plan.boneCount; bone++) Kit.figure.writeBoneMatrix(world, bone, matrices, bone * MATRIX);
    return matrices;
  };

  /**
   * The pose a body is sculpted in: its rest pose with every limb swung away from the trunk, as a modeller
   * stands a figure with its arms out before skinning it. At rest an arm hangs against the ribs and a blended
   * surface would weld the two; apart, each limb is sculpted whole and joins the trunk only at its own joint,
   * and the skin weights then bring it back down. A limb is a run of bones with one ink key
   * (`Kit.figure.inkKeyOf`); one on the body's midline (a head, a tail) is left where it is.
   * @param {Object} bake from a bakery
   * @returns {Object} local joint transforms (a `JointTransforms` of kit/rig.js), a copy
   * @complexity O(limbs x bones)
   * @example const matrices = Kit.figure.restMatrices(bake, Kit.figure.spreadPose(bake));
   */
  const spreadPose = (bake) => openedPose(bake, limbsOf(bake), (limb) => SCULPT.spread * Math.min(1, limb.offset / SCULPT.fullSpreadAt)).local;

  /**
   * @typedef {Object} Limb
   * @property {number} lead the limb's first bone (the one whose parent belongs to something else)
   * @property {number[]} bones the bones further along it
   * @property {number[]} direction unit [x, y, z]: where it points at rest, from its joint
   * @property {number[]} outward unit [x, y, z]: away from the trunk
   * @property {number} offset metres its joint is to the side of the root
   * @property {string} key its ink key ('arms-left')
   */

  /**
   * The limbs of a body that sit to one side of it: runs of bones with one ink key whose joint is off the
   * midline (arms, legs, wings; not a head or a tail).
   * @param {Object} bake from a bakery
   * @returns {Limb[]}
   * @complexity O(bones x limb length)
   * @example Kit.figure.limbsOf(bake).map((limb) => limb.key) // ['arms-left', 'arms-right', 'legs-left', 'legs-right']
   */
  const limbsOf = (bake) => {
    const { plan } = bake;
    const world = Kit.body.worldTransforms(plan, bake.rest, Kit.body.createPose(plan));
    const keys = Array.from({ length: plan.boneCount }, (_unused, bone) => Kit.figure.inkKeyOf(plan, bone));
    const at = (bone) => [world.translation[bone * VECTOR], world.translation[bone * VECTOR + 1], world.translation[bone * VECTOR + 2]];
    const limbs = [];
    for (let lead = 1; lead < plan.boneCount; lead++) {
      if (plan.parent[lead] < 0 || keys[plan.parent[lead]] === keys[lead] || keys[lead].startsWith('part:')) continue;
      const bones = [];
      for (let bone = lead + 1; bone < plan.subtreeEnd[lead]; bone++) if (keys[bone] === keys[lead]) bones.push(bone);
      if (!bones.length) continue;
      // Where the limb points: from its joint to the middle of the joints further along it.
      const joint = at(lead);
      const along = [0, 1, 2].map((axis) => bones.reduce((sum, bone) => sum + at(bone)[axis], 0) / bones.length - joint[axis]);
      const length = Math.hypot(...along);
      // Only sideways counts as "away from the trunk": a limb in front of or behind it (a tail, a neck) is on the midline.
      const offset = Math.abs(joint[0] - world.translation[0]);
      if (length < SCULPT.leastLimb || offset < SCULPT.midline) continue;
      limbs.push({ lead, bones, direction: along.map((value) => value / length), outward: [Math.sign(joint[0] - world.translation[0]), 0, 0], offset, key: keys[lead] });
    }
    return limbs;
  };

  /**
   * A bake's rest pose with each limb swung outward by an angle.
   * @param {Object} bake
   * @param {Limb[]} limbs
   * @param {function(Limb): number} angleOf radians
   * @returns {{local: Object, world: Object, turns: Float32Array}} the pose, its world transforms, and per limb
   *   the turn that was applied, as a quaternion in the space of the lead bone's parent (4 per limb)
   */
  const openedPose = (bake, limbs, angleOf) => {
    const { plan } = bake;
    const local = Kit.rig.copy(bake.rest, Kit.body.createPose(plan));
    const world = Kit.body.worldTransforms(plan, local, Kit.body.createPose(plan));
    const turns = new Float32Array(limbs.length * QUATERNION);
    const arc = [0, 0, 0, 1];
    limbs.forEach((limb, index) => {
      const angle = angleOf(limb);
      const { direction, outward, lead } = limb;
      // Swing in the plane of the limb and the outward direction.
      const lean = direction[0] * outward[0];
      const side = [outward[0] - direction[0] * lean, -direction[1] * lean, -direction[2] * lean];
      const sideLength = Math.hypot(...side) || 1;
      const target = direction.map((value, axis) => value * Math.cos(angle) + (side[axis] / sideLength) * Math.sin(angle));
      Kit.rig.shortestArc(direction[0], direction[1], direction[2], target[0], target[1], target[2], arc);
      const before = Array.from(local.rotation.subarray(lead * QUATERNION, lead * QUATERNION + QUATERNION));
      Kit.rig.turnWorld(plan.parent, local, world, lead, arc);
      // turn = new local x inverse(old local): what to put in front of any pose's local rotation to open it the same way.
      const after = local.rotation.subarray(lead * QUATERNION, lead * QUATERNION + QUATERNION);
      multiply(after, [-before[0], -before[1], -before[2], before[3]], turns, index * QUATERNION);
      Kit.body.worldTransforms(plan, local, world);
    });
    return { local, world, turns };
  };

  /** Quaternion product first x second, written into `out` at `outAt`. */
  const multiply = (first, second, out, outAt = 0) => {
    const [ax, ay, az, aw] = [first[0], first[1], first[2], first[3]];
    const [bx, by, bz, bw] = [second[0], second[1], second[2], second[3]];
    out[outAt] = aw * bx + ax * bw + ay * bz - az * by;
    out[outAt + 1] = aw * by - ax * bz + ay * bw + az * bx;
    out[outAt + 2] = aw * bz + ax * by - ay * bx + az * bw;
    out[outAt + 3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  };

  /**
   * How far each arm-like limb must open from the rest pose so that it is not buried in the trunk: the least
   * angle at which the limb's joints stand clear of the trunk's surface by `clearShare` of their own
   * thickness. A wide chest or a thick arm (any dial) then opens the arms by itself, instead of the rest pose
   * being right for one build only. Legs are left alone: their feet are placed on the ground by the gait.
   * @param {Object} bake
   * @param {Limb[]} limbs
   * @param {function(number, number, number): number} trunkDistance signed distance to the trunk, rest space
   * @returns {{leads: Int16Array, turns: Float32Array, angles: number[]}} per opened limb: its lead bone, the
   *   quaternion to put in front of the lead's local rotation in any pose, and the angle it was opened by, radians
   * @complexity O(limbs x steps x bones)
   * @example const { leads, turns } = Kit.figure.limbClearance(bake, Kit.figure.limbsOf(bake), trunkDistance);
   */
  const limbClearance = (bake, limbs, trunkDistance) => {
    const { plan } = bake;
    const free = limbs.filter((limb) => !limb.key.startsWith('legs'));
    const isClear = (limb, angle) => {
      const { world } = openedPose(bake, [limb], () => angle);
      return limb.bones.every(
        (bone) =>
          trunkDistance(world.translation[bone * VECTOR], world.translation[bone * VECTOR + 1], world.translation[bone * VECTOR + 2]) >=
          (plan.girth[bone] / 2) * world.scale[bone * VECTOR] * SCULPT.clearShare
      );
    };
    const angles = free.map((limb) => {
      for (let step = 0; step <= SCULPT.clearSteps; step++) if (isClear(limb, (SCULPT.mostOpen * step) / SCULPT.clearSteps)) return (SCULPT.mostOpen * step) / SCULPT.clearSteps;
      return SCULPT.mostOpen;
    });
    const { turns } = openedPose(bake, free, (limb) => angles[free.indexOf(limb)]);
    return { leads: Int16Array.from(free.map((limb) => limb.lead)), turns, angles };
  };

  /**
   * How a worn part's bone is drawn, from its bone row's `wear` (catalogue data; kit/body-wardrobe.js gives every
   * part a default by what it fits):
   *  - 'solid': sculpted on its own grid and moved by its own bone (a hat, a horn, a bun);
   *  - 'drape': sculpted, and moved by the body's bones it hangs beside, so a knee pushes a skirt (`hangs`: the
   *    roles of the body bones that may carry it, default any);
   *  - anything else: the rigid piece it always was (a sword, glasses).
   * @type {Readonly<string[]>}
   */
  const WEARS = Object.freeze(['solid', 'drape']);

  /** Per bone: its `wear` when it is one the sculpt takes, else ''. Per bone too: the role mask of `hangs` (0: any). */
  const wearOf = (plan) => {
    const rows = (plan.spec && plan.spec.bones) || [];
    const byName = new Map(rows.map((row) => [row.name, row]));
    const wears = plan.boneNames.map((name) => {
      const row = byName.get(name);
      return row && WEARS.includes(row.wear) ? row.wear : '';
    });
    const hangs = plan.boneNames.map((name) => {
      const row = byName.get(name);
      return row && row.hangs ? Kit.body.roleMask(row.hangs) : 0;
    });
    return { wears, hangs };
  };

  /** Can this piece be a solid at all: shaded normally, of a kind that has a distance? */
  const isSolidPiece = (piece) =>
    !piece.stamps && !piece.shell && !piece.emissive && piece.tone === undefined && piece.inkGroup !== Kit.figure.INK_GROUPS.glow && Boolean(Kit.sculpt.KINDS[piece.shape.kind]);
  /** Is this piece a solid of the body itself: one the body's skin may replace? */
  const isSculpted = (piece) => !piece.isProp && isSolidPiece(piece);
  /** The pieces of worn objects the sculpt takes, by the wear of their bones. */
  const wornPieces = (figureLayout, wears) => figureLayout.pieces.filter((piece) => piece.isProp && wears[piece.bone] && isSolidPiece(piece));

  /** Steps of correction when points are carried between poses (`carry`): the error shrinks about fivefold a step. */
  const CARRY_STEPS = 4;

  /** Per bone, `to` x inverse(`from`) as 12 numbers row by row (the move a bone makes between two poses). */
  const movesBetween = (from, to) => {
    const boneCount = from.length / MATRIX;
    const moves = new Float64Array(boneCount * ROW_AFFINE);
    for (let bone = 0; bone < boneCount; bone++) {
      const back = Kit.sculpt.invertAffine(from.subarray(bone * MATRIX, bone * MATRIX + MATRIX));
      const onward = to.subarray(bone * MATRIX, bone * MATRIX + MATRIX);
      for (let row = 0; row < VECTOR; row++) {
        for (let column = 0; column <= VECTOR; column++) {
          let sum = column === VECTOR ? onward[12 + row] : 0;
          for (let inner = 0; inner < VECTOR; inner++) sum += onward[inner * 4 + row] * back[inner * 4 + column];
          moves[bone * ROW_AFFINE + row * 4 + column] = sum;
        }
      }
    }
    return moves;
  };

  /** A point (or, with `isDirection`, a direction) moved by the blend of a vertex's owners' moves; written to `out`. */
  const blended = (moves, skin, vertex, x, y, z, isDirection, out) => {
    let [px, py, pz] = [0, 0, 0];
    const shift = isDirection ? 0 : 1;
    for (let slot = 0; slot < OWNERS; slot++) {
      const share = skin.weights[vertex * OWNERS + slot];
      if (share === 0) continue;
      const move = skin.owners[vertex * OWNERS + slot] * ROW_AFFINE;
      px += share * (moves[move] * x + moves[move + 1] * y + moves[move + 2] * z + moves[move + 3] * shift);
      py += share * (moves[move + 4] * x + moves[move + 5] * y + moves[move + 6] * z + moves[move + 7] * shift);
      pz += share * (moves[move + 8] * x + moves[move + 9] * y + moves[move + 10] * z + moves[move + 11] * shift);
    }
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    return out;
  };

  /**
   * Moves a mesh made in one pose into another through its skin, so that skinning it back by the same weights
   * returns it where it was made. A vertex with one owner is moved by that bone; one shared between bones that
   * moved differently (a hem between two spread legs) would come back short if it were only blended, so it is
   * corrected until it does return.
   */
  const carry = (mesh, skin, from, to) => {
    const onward = movesBetween(from, to);
    const back = movesBetween(to, from);
    const { positions, normals } = mesh;
    const [there, home, fix] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let vertex = 0; vertex < positions.length / VECTOR; vertex++) {
      const at = vertex * VECTOR;
      const [x, y, z] = [positions[at], positions[at + 1], positions[at + 2]];
      blended(onward, skin, vertex, x, y, z, false, there);
      if (skin.weights[vertex * OWNERS] < 1) {
        for (let step = 0; step < CARRY_STEPS; step++) {
          blended(back, skin, vertex, there[0], there[1], there[2], false, home);
          blended(onward, skin, vertex, x - home[0], y - home[1], z - home[2], true, fix);
          there[0] += fix[0];
          there[1] += fix[1];
          there[2] += fix[2];
        }
      }
      positions[at] = there[0];
      positions[at + 1] = there[1];
      positions[at + 2] = there[2];
      blended(onward, skin, vertex, normals[at], normals[at + 1], normals[at + 2], true, fix);
      const length = Math.sqrt(fix[0] * fix[0] + fix[1] * fix[1] + fix[2] * fix[2]) || 1;
      normals[at] = fix[0] / length;
      normals[at + 1] = fix[1] / length;
      normals[at + 2] = fix[2] / length;
    }
  };

  /**
   * @typedef {Object} SculptLayer
   * @property {string} id 'skin:<ramp>' for a body surface, 'region:<part>|<ramp>|<raise>' for a painted layer, 'worn:<socket>|<ramp>|<wear>' for a worn object
   * @property {number} ramp index into the bake's ramps
   * @property {number} inkGroup
   * @property {number} inkClass which line class it draws as (its ramp)
   * @property {Float32Array} positions 3 per vertex, in the bake's sculpting pose (`matrices`)
   * @property {Float32Array} normals
   * @property {Uint16Array|Uint32Array} indices
   * @property {Uint16Array} owners 4 bone indices per vertex
   * @property {Float32Array} weights 4 shares per vertex
   * @property {Float32Array} [faceShare] on a body surface: per vertex, how much of it the head's bones move (0..1); a look lights a face and a form differently
   */

  /**
   * @typedef {Object} Sculpted
   * @property {SculptLayer[]} layers shared between equal bakes: never write to their arrays (views of `surface`'s, a layer each)
   * @property {SculptSurface} surface every layer as one mesh: what a figure draws
   * @property {number} bytes what the arrays take, bytes
   * @property {Set<string>} replaced ids of the layout pieces the layers stand in for (do not draw them)
   * @property {Float32Array} matrices the bone matrices the layers were made in (the bind pose), 16 per bone
   * @property {{leads: Int16Array, turns: Float32Array}} clearance see `limbClearance`
   * @property {string} signature what the layers depend on (see `sculptSignature`)
   */

  /**
   * @typedef {Object} SculptSurface
   * The layers of a bake as one skinned mesh: a figure is one draw however many garments it wears. A layer is a
   * run of vertices and a run of triangles (`ranges`); no vertex is shared between two.
   * @property {Float32Array} positions 3 per vertex, in the bake's sculpting pose
   * @property {Float32Array} normals
   * @property {Uint16Array|Uint32Array} indices
   * @property {Uint16Array} owners 4 bone indices per vertex
   * @property {Float32Array} weights 4 shares per vertex
   * @property {Float32Array} faceShare per vertex, how much of it the head's bones move where its layer is a body surface, else 0
   * @property {Uint8Array} paint 2 per vertex: its layer's ramp slot (also its line class) and ink group
   * @property {Array<{id: string, vertexStart: number, vertexCount: number, indexStart: number, indexCount: number}>} ranges
   * @property {number} error the furthest a vertex was moved off the planes it stood for when the mesh was simplified, metres (`Kit.sculpt.simplify`'s `distance`)
   */

  /** The solid of a layout piece in the sculpting pose, with the fillets its thickness earns. */
  const solidOf = (piece, matrices, limbLead) => {
    const matrix = matrices.subarray(piece.bone * MATRIX, piece.bone * MATRIX + MATRIX);
    const placed = Kit.sculpt.solid(piece.shape, matrix, { owner: piece.bone });
    placed.blend = Math.max(SCULPT.leastBlend, Math.min(SCULPT.mostBlend, placed.thinness * SCULPT.blendShare));
    placed.inverse = Kit.sculpt.invertAffine(matrix);
    // One limb (an ink group of the layout) blends along its length; it joins the trunk at its first bone's joint.
    placed.group = piece.inkGroup;
    placed.join = Math.min(placed.blend, SCULPT.mostJoin);
    const lead = limbLead.get(piece.inkGroup);
    placed.anchor = [matrices[lead * MATRIX + 12], matrices[lead * MATRIX + 13], matrices[lead * MATRIX + 14]];
    return placed;
  };

  /**
   * The solid of a piece made to fit a grid: as it is when the grid can hold it, thickened to `thickenedCells`
   * cells when it is thinner than that, and null when it is too thin even to thicken (it stays a rigid piece).
   */
  const fittedSolid = (piece, matrices, limbLead, cell) => {
    const part = solidOf(piece, matrices, limbLead);
    const least = (cell * SCULPT.thickenedCells) / 2;
    if (part.thinness >= least) return part;
    if (part.thinness < least * SCULPT.leastThinShare) return null;
    const grow = least - part.thinness;
    const thick = solidOf({ ...piece, shape: { ...piece.shape, inflate: (piece.shape.inflate || 0) + grow } }, matrices, limbLead);
    thick.thinness += grow;
    for (let axis = 0; axis < VECTOR; axis++) {
      thick.min[axis] -= grow;
      thick.max[axis] += grow;
    }
    return thick;
  };

  /**
   * @typedef {Object} Garment
   * The regions of one worn part with one paint and one raise (its waist, chest and sleeves are separate
   * regions, one per bone): one layer.
   * @property {string} key '<part>|<ramp>|<raise>'
   * @property {?string} part
   * @property {number} ramp
   * @property {number} raise metres; 0 is paint
   * @property {number} order its place in the paint order (the highest of its regions')
   * @property {Map<number, Function[]>} tests per bone, the predicates of its regions there
   */

  /** The garments painted on a set of bones, in paint order. */
  const garmentsOn = (bones, regions) => {
    /** @type {Map<string, Garment>} */
    const garments = new Map();
    bones.forEach((bone) =>
      regions[bone].forEach((region, index) => {
        if (region.ramp < 0) return;
        const key = `${region.part || ''}|${region.ramp}|${region.raise || 0}`;
        const garment = garments.get(key) || { key, part: region.part || null, ramp: region.ramp, raise: region.raise || 0, order: 0, tests: new Map() };
        garment.order = Math.max(garment.order, index);
        garment.tests.set(bone, [...(garment.tests.get(bone) || []), region.test]);
        garments.set(key, garment);
      })
    );
    return [...garments.values()].sort((first, second) => first.order - second.order);
  };

  /**
   * How far each garment stands off the skin. Raised garments stack: each stands at least a gap above the
   * last. A garment with no raise (stripes, a trim, a tattoo) is paint: it lies a hair above the raised
   * garment of its own part, or above the skin, and is cut out of that garment's area.
   * @param {Garment[]} garments in paint order
   * @param {number} [slack=0] metres a surface of this level of detail may stand off the form it was meshed on
   *   (`Kit.sculpt.DETAIL`'s `error` of a cell): layers stand at least that far apart, so a coarse level's flatter
   *   triangles do not cut through the layer below
   * @returns {Array<{garment: Garment, offset: number, host: ?Garment, isPaint: boolean}>}
   */
  const stackGarments = (garments, slack = 0) => {
    let lastOffset = 0;
    const raised = garments
      .filter((garment) => garment.raise > 0)
      .map((garment) => {
        lastOffset = Math.max(garment.raise, SCULPT.leastRaise, lastOffset + Math.max(SCULPT.layerGap, slack));
        return { garment, offset: lastOffset, host: null, isPaint: false };
      });
    const painted = garments
      .filter((garment) => garment.raise <= 0)
      .map((garment) => {
        const host = raised.find((spec) => spec.garment.part && spec.garment.part === garment.part);
        return { garment, offset: (host ? host.offset : 0) + SCULPT.paintLift, host: host ? host.garment : null, isPaint: true };
      });
    return [...raised, ...painted];
  };

  /**
   * A garment as a cut of a field: is a point inside it? Asked of the bone whose solid is nearest the point,
   * in that bone's surface coordinates (how far along it, the angle round it, the outward direction).
   * @param {Garment} garment
   * @param {Object} field a `Field` of kit/sculpt.js whose solids carry `inverse`
   * @param {Object[]} frames `Kit.body.surfaceLayout(plan).frames`
   * @returns {function(number, number, number): boolean}
   */
  const cutOf = (garment, field, frames) => {
    const { solids } = field;
    /** Per solid of the field: the garment's predicates on its bone, or null (most solids: answered at once). */
    const testsOf = solids.map((part) => garment.tests.get(part.owner) || null);
    const along = [0, 0];
    return (x, y, z) => {
      const index = Kit.sculpt.nearestAt(field, x, y, z);
      const tests = index >= 0 ? testsOf[index] : null;
      if (!tests) return false;
      const part = solids[index];
      const inverse = part.inverse;
      const localX = inverse[0] * x + inverse[1] * y + inverse[2] * z + inverse[3];
      const localY = inverse[4] * x + inverse[5] * y + inverse[6] * z + inverse[7];
      const localZ = inverse[8] * x + inverse[9] * y + inverse[10] * z + inverse[11];
      const frame = frames[part.owner];
      Kit.surface.along(frame, localX, localY, localZ, along);
      // The outward direction: away from the bone's long axis at this height.
      const outX = localX - frame.end[0] * along[0];
      const outY = localY - frame.end[1] * along[0];
      const outZ = localZ - frame.end[2] * along[0];
      const length = Math.sqrt(outX * outX + outY * outY + outZ * outZ) || 1;
      for (let test = 0; test < tests.length; test++) if (tests[test](along[0], along[1], outX / length, outY / length, outZ / length)) return true;
      return false;
    };
  };

  /** Numbers in a signature are rounded to this many decimals (a hundredth of a millimetre). */
  const SIGNATURE_DECIMALS = 5;

  /**
   * What a bake's sculpted layers depend on, as text: the level of detail, every sculpted piece's shape, bone,
   * paint slot and regions, and the rest pose. Colours are not in it, so recolouring a body keeps its layers.
   * @param {Object} bake from a bakery
   * @param {Object} figureLayout `Kit.figure.layout(bake)`
   * @param {string} [detail] default the layout's level
   * @param {{cull?: boolean, simplify?: boolean}} [options] as `sculptLayers`
   * @returns {string}
   * @complexity O(pieces + bones)
   * @example Kit.figure.sculptSignature(bake, layout) === Kit.figure.sculptSignature(recoloured, Kit.figure.layout(recoloured)) // true
   */
  const sculptSignature = (bake, figureLayout, detail = figureLayout.level, options = {}) => {
    const { wears, hangs } = wearOf(bake.plan);
    const pieces = [...figureLayout.pieces.filter(isSculpted), ...wornPieces(figureLayout, wears)].map((piece) =>
      [piece.id, piece.bone, piece.key, piece.ramp, piece.inkGroup, piece.regions ? piece.regions.key : '', wears[piece.bone], hangs[piece.bone]].join('~')
    );
    const rest = bake.rest || Kit.body.createPose(bake.plan);
    const pose = [rest.translation, rest.rotation, rest.scale].map((values) => Array.from(values, (value) => value.toFixed(SIGNATURE_DECIMALS)).join(','));
    const made = `${detail}${options.cull === false ? '~whole' : ''}${options.simplify === false ? '~dense' : ''}`;
    return [made, bake.plan.boneNames.join(','), ...pieces, ...pose].join('|');
  };

  /** @type {Map<string, Sculpted>} sculpted bakes by signature, most recently used last */
  const kept = new Map();
  /** The bytes of every array `kept` holds. */
  let keptBytes = 0;
  /**
   * The sculpted layers kept for reuse: equal bakes (a crowd of one look, a recoloured body, an undo) share one
   * set of arrays. The most recently used are held: at most `SCULPT.kept` of them and `SCULPT.keptBytes` bytes,
   * and always the last one made. What a figure still draws stays alive with the figure, kept here or not.
   * @type {{clear: function(): void, size: function(): number, bytes: function(): number}}
   */
  const sculptCache = {
    clear: () => {
      kept.clear();
      keptBytes = 0;
    },
    size: () => kept.size,
    bytes: () => keptBytes,
  };
  /** Keeps a sculpted bake, and lets the least recently used go while there are too many or they are too large. */
  const keep = (sculpted) => {
    kept.set(sculpted.signature, sculpted);
    keptBytes += sculpted.bytes;
    while (kept.size > 1 && (kept.size > SCULPT.kept || keptBytes > SCULPT.keptBytes)) {
      const [oldest, dropped] = kept.entries().next().value;
      kept.delete(oldest);
      keptBytes -= dropped.bytes;
    }
  };

  /**
   * Sculpts a bake. Equal bakes return the same layers (see `sculptCache`).
   * @param {Object} bake from a bakery
   * @param {Object} figureLayout `Kit.figure.layout(bake)`
   * @param {{detail?: string, cull?: boolean, simplify?: boolean}} [options] `detail`: a key of `Kit.sculpt.DETAIL` (default: the
   *   layout's level); `cull: false` also meshes what a garment hides (every skin is then closed); `simplify: false`
   *   keeps every vertex the grid made. Both are for measuring and testing: a figure draws the default
   * @returns {Sculpted}
   * @complexity O(body surface area / cell^2) distance evaluations and vertices, once per distinct bake; O(pieces) for a bake seen before
   * @example const { layers, replaced } = Kit.figure.sculptLayers(bake, Kit.figure.layout(bake));
   */
  const sculptLayers = (bake, figureLayout, options = {}) => {
    return sculptTask(bake, figureLayout, options).finish();
  };

  /**
   * A sculpt that can be done a little at a time, so a first sculpt never holds a frame: `step(milliseconds)`
   * works for about that long and says whether it is done, `finish()` does the rest at once, and `result` is
   * the `Sculpted` once done (at once for a bake seen before). Its layers go to the same `sculptCache`.
   * @param {Object} bake from a bakery
   * @param {Object} figureLayout `Kit.figure.layout(bake)`
   * @param {{detail?: string, cull?: boolean, simplify?: boolean, now?: function(): number}} [options] as `sculptLayers`; `now`: a clock in milliseconds (default `performance.now`)
   * @returns {{step: function(number): boolean, finish: function(): Sculpted, isDone: function(): boolean, result: ?Sculpted, signature: string}}
   * @complexity as `sculptLayers` in total; one `step` runs pieces of a few milliseconds until its time is used
   * @example const task = Kit.figure.sculptTask(bake, layout); // each frame: if (task.step(6)) show(task.result);
   */
  const sculptTask = (bake, figureLayout, options = {}) => {
    const detail = options.detail || figureLayout.level;
    const now = options.now || (() => performance.now());
    const signature = sculptSignature(bake, figureLayout, detail, options);
    /** @type {{step: function(number): boolean, finish: function(): Object, isDone: function(): boolean, result: ?Object, signature: string}} */
    const task = { signature, result: null, step: () => false, finish: () => null, isDone: () => false };
    let steps = null;
    /** Takes the layers from the cache if they are there (another figure may have finished the same bake meanwhile). */
    const recall = () => {
      const known = kept.get(signature);
      if (!known) return false;
      kept.delete(signature);
      kept.set(signature, known);
      task.result = known;
      return true;
    };
    const advance = () => {
      steps = steps || sculptSteps(bake, figureLayout, detail, options);
      const step = steps.next();
      if (!step.done) return false;
      task.result = { ...step.value, signature };
      keep(task.result);
      return true;
    };
    task.isDone = () => task.result !== null;
    task.step = (milliseconds) => {
      const until = now() + milliseconds;
      while (!task.result && !recall() && !advance() && now() < until);
      return task.result !== null;
    };
    task.finish = () => {
      while (!task.result && !recall() && !advance());
      return task.result;
    };
    recall();
    return task;
  };

  /** Per vertex of a layer: the share of it moved by the bones flagged in `isFlagged` (0..1). */
  const shareOf = (layer, isFlagged) => {
    const shares = new Float32Array(layer.positions.length / VECTOR);
    for (let slot = 0; slot < layer.owners.length; slot++) if (isFlagged[layer.owners[slot]]) shares[Math.floor(slot / OWNERS)] += layer.weights[slot];
    return shares;
  };

  /** Sculpts a bake afresh (see `sculptLayers`), pausing (a `yield`) between pieces of work of a few milliseconds each. */
  function* sculptSteps(bake, figureLayout, detail, options = {}) {
    const { plan } = bake;
    const matrices = restMatrices(bake, spreadPose(bake));
    const frames = bake.surface && Kit.body.surfaceLayout ? Kit.body.surfaceLayout(plan).frames : null;
    const regions = bake.surface ? bake.surface.regions : null;
    const candidates = figureLayout.pieces.filter(isSculpted);
    /** Ink group -> the first (nearest the root) bone of that limb. */
    const limbLead = new Map();
    candidates.forEach((piece) => limbLead.has(piece.inkGroup) || limbLead.set(piece.inkGroup, piece.bone));
    // One grid cell for the whole body; what is far too thin for it (an earring) stays a rigid piece.
    const cell = candidates.length
      ? Kit.sculpt.cellFor(
          candidates.map((piece) => solidOf(piece, matrices, limbLead)),
          detail
        )
      : 0;
    const meshed = candidates.map((piece) => ({ piece, part: fittedSolid(piece, matrices, limbLead, cell) })).filter(({ part }) => part);
    const replaced = new Set(meshed.map(({ piece }) => piece.id));
    // The shells the layout made for raised regions are replaced along with the surfaces they were copies of.
    figureLayout.pieces.filter((piece) => piece.shell && replaced.has(piece.id.split('~')[0])).forEach((piece) => replaced.add(piece.id));
    /** Body solids by ramp: each paint of the body is one blended skin. */
    const groups = new Map();
    meshed.forEach(({ piece, part }) => {
      const group = groups.get(piece.ramp) || { ramp: piece.ramp, inkGroup: piece.inkGroup, solids: [] };
      group.solids.push(part);
      groups.set(piece.ramp, group);
    });

    // The trunk: the solids of the limb the root bone belongs to, whatever their paint.
    const trunkGroup = Kit.figure.inkGroupOf(Kit.figure.inkKeyOf(plan, 0));
    const trunk = meshed.map(({ part }) => part).filter((part) => part.group === trunkGroup);
    const trunkDistance = (x, y, z) => {
      let nearest = Infinity;
      for (let index = 0; index < trunk.length; index++) nearest = Math.min(nearest, trunk[index].distance(x, y, z));
      return nearest;
    };
    const clearance = trunk.length ? limbClearance(bake, limbsOf(bake), trunkDistance) : { leads: new Int16Array(0), turns: new Float32Array(0), angles: [] };

    const headGroup = Kit.figure.INK_GROUPS.head;
    const isHeadBone = Uint8Array.from({ length: plan.boneCount }, (_unused, bone) => (Kit.figure.inkGroupOf(Kit.figure.inkKeyOf(plan, bone)) === headGroup ? 1 : 0));
    const layers = [];
    for (const group of groups.values()) {
      const bones = [...new Set(group.solids.map((part) => part.owner))];
      const specs = regions && frames ? stackGarments(garmentsOn(bones, regions), cell * Kit.sculpt.DETAIL[detail].error) : [];
      const field = yield* Kit.sculpt.sampleSteps(group.solids, { cell, margin: Math.max(0, ...specs.map((spec) => spec.offset)) });
      const layerOf = (id, ramp, mesh, offset) => ({
        id,
        ramp,
        inkGroup: group.inkGroup,
        inkClass: ramp,
        ...mesh,
        ...Kit.sculpt.weights(mesh.positions, group.solids, { spread: SCULPT.weightSpread, reach: offset + cell }),
      });
      // What a layer hides is not meshed (kit/sculpt.js `surface`): the garments are made from the outermost in
      // and the skin last, each marking where it lies. They are listed as before: the skin, then in paint order.
      const cover = options.cull !== false && specs.length ? new Uint8Array(field.values.length) : undefined;
      const outermostFirst = specs.map((_spec, index) => index).sort((first, second) => specs[second].offset - specs[first].offset || second - first);
      const cloths = specs.map(() => null);
      for (const index of outermostFirst) {
        const { garment, offset, host, isPaint } = specs[index];
        const own = cutOf(garment, field, frames);
        const within = host ? cutOf(host, field, frames) : null;
        const cut = within ? (x, y, z) => own(x, y, z) && within(x, y, z) : own;
        // Paint lies a hair above what it is painted on, as an open sheet: flush to the eye, never fighting for depth.
        const near = Uint8Array.from(group.solids, (part) => (garment.tests.has(part.owner) ? 1 : 0));
        const cloth = Kit.sculpt.surface(field, { offset, cut, near, depth: SCULPT.buriedDepth, walls: !isPaint, cover, under: cover });
        if (cloth.indices.length) cloths[index] = layerOf(`region:${garment.key}`, garment.ramp, cloth, offset);
        yield undefined;
      }
      const bare = Kit.sculpt.surface(field, { under: cover });
      yield undefined;
      const skin = layerOf(`skin:${group.ramp}`, group.ramp, bare, 0);
      skin.faceShare = shareOf(skin, isHeadBone);
      layers.push(skin, ...cloths.filter(Boolean));
      yield undefined;
    }
    const worn = yield* wornSteps(bake, figureLayout, { cell, matrices, bodyPieces: meshed.map(({ piece }) => piece), limbLead });
    worn.forEach(({ layer, pieces }) => {
      layers.push(layer);
      pieces.forEach((piece) => replaced.add(piece.id));
    });
    const level = Kit.sculpt.DETAIL[detail];
    const whole = joinLayers(layers);
    yield undefined;
    const tolerance = (cell || level.cell) * level.error;
    const light = options.simplify === false ? null : yield* Kit.sculpt.simplifySteps(whole, { tolerance, most: level.triangles || 0, skin: whole });
    const surface = light ? lightened(whole, light) : { ...whole, error: 0 };
    const views = layerViews(surface, layers);
    return { layers: views, surface, bytes: bytesOf(surface, views), replaced, matrices, clearance };
  }

  /**
   * Layers as one mesh (a `SculptSurface` before it is simplified): their arrays end to end, each triangle
   * naming vertices of the whole, and per vertex the paint of the layer it came from.
   * @complexity O(vertices + triangles)
   */
  const joinLayers = (layers) => {
    const vertexCount = layers.reduce((sum, layer) => sum + layer.positions.length / VECTOR, 0);
    const indexCount = layers.reduce((sum, layer) => sum + layer.indices.length, 0);
    const whole = {
      positions: new Float32Array(vertexCount * VECTOR),
      normals: new Float32Array(vertexCount * VECTOR),
      indices: new Uint32Array(indexCount),
      owners: new Uint16Array(vertexCount * OWNERS),
      weights: new Float32Array(vertexCount * OWNERS),
      faceShare: new Float32Array(vertexCount),
      paint: new Uint8Array(vertexCount * PAINT),
      ranges: [],
    };
    let [vertexStart, indexStart] = [0, 0];
    layers.forEach((layer) => {
      const count = layer.positions.length / VECTOR;
      whole.positions.set(layer.positions, vertexStart * VECTOR);
      whole.normals.set(layer.normals, vertexStart * VECTOR);
      whole.owners.set(layer.owners, vertexStart * OWNERS);
      whole.weights.set(layer.weights, vertexStart * OWNERS);
      if (layer.faceShare) whole.faceShare.set(layer.faceShare, vertexStart);
      for (let vertex = vertexStart; vertex < vertexStart + count; vertex++) {
        whole.paint[vertex * PAINT] = layer.ramp;
        whole.paint[vertex * PAINT + 1] = layer.inkGroup;
      }
      // Hot loop over every corner: an index write each.
      for (let corner = 0; corner < layer.indices.length; corner++) whole.indices[indexStart + corner] = layer.indices[corner] + vertexStart;
      whole.ranges.push({ id: layer.id, vertexStart, vertexCount: count, indexStart, indexCount: layer.indices.length });
      vertexStart += count;
      indexStart += layer.indices.length;
    });
    return whole;
  };

  /** A joined surface after `Kit.sculpt.simplify`: the kept vertices' attributes, and each layer's runs found again. */
  const lightened = (whole, light) => {
    const { kept, indices } = light;
    /** The first kept vertex at or after a vertex of the dense mesh (`kept` rises). */
    const firstFrom = (vertex) => {
      let [low, high] = [0, kept.length];
      while (low < high) {
        const middle = (low + high) >> 1;
        if (kept[middle] < vertex) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    let corner = 0;
    const ranges = whole.ranges.map((range) => {
      const vertexStart = firstFrom(range.vertexStart);
      const vertexEnd = firstFrom(range.vertexStart + range.vertexCount);
      // Triangles keep their order, and a triangle's corners are all of one layer.
      const indexStart = corner;
      while (corner < indices.length && indices[corner] < vertexEnd) corner += VECTOR;
      return { id: range.id, vertexStart, vertexCount: vertexEnd - vertexStart, indexStart, indexCount: corner - indexStart };
    });
    return {
      positions: light.positions,
      normals: light.normals,
      indices,
      owners: Kit.sculpt.pick(whole.owners, OWNERS, kept),
      weights: Kit.sculpt.pick(whole.weights, OWNERS, kept),
      faceShare: Kit.sculpt.pick(whole.faceShare, 1, kept),
      paint: Kit.sculpt.pick(whole.paint, PAINT, kept),
      ranges,
      error: light.distance,
    };
  };

  /**
   * The layers of a surface as layers again: each a view of its run of the surface's arrays (nothing copied
   * but its triangles, which name its own vertices). A layer nothing is left of is not listed.
   */
  const layerViews = (surface, layers) =>
    surface.ranges
      .map((range, index) => {
        const { vertexStart, indexStart } = range;
        const vertexEnd = vertexStart + range.vertexCount;
        const { id, ramp, inkGroup, inkClass, faceShare } = layers[index];
        const indices = new Uint16Array(range.indexCount);
        for (let corner = 0; corner < range.indexCount; corner++) indices[corner] = surface.indices[indexStart + corner] - vertexStart;
        const view = {
          id,
          ramp,
          inkGroup,
          inkClass,
          positions: surface.positions.subarray(vertexStart * VECTOR, vertexEnd * VECTOR),
          normals: surface.normals.subarray(vertexStart * VECTOR, vertexEnd * VECTOR),
          indices: range.vertexCount > MOST_SHORT_INDEX ? Uint32Array.from(indices, (_value, corner) => surface.indices[indexStart + corner] - vertexStart) : indices,
          owners: surface.owners.subarray(vertexStart * OWNERS, vertexEnd * OWNERS),
          weights: surface.weights.subarray(vertexStart * OWNERS, vertexEnd * OWNERS),
        };
        return faceShare ? { ...view, faceShare: surface.faceShare.subarray(vertexStart, vertexEnd) } : view;
      })
      .filter((layer) => layer.indices.length > 0);

  /** The bytes of a surface's arrays and of its layers' own triangles. */
  const bytesOf = (surface, layers) =>
    [surface.positions, surface.normals, surface.indices, surface.owners, surface.weights, surface.faceShare, surface.paint, ...layers.map((layer) => layer.indices)].reduce((sum, values) => sum + values.byteLength, 0);

  /**
   * The layers of the worn objects of a bake (bone rows with `wear`): one per object and paint, each on a grid of
   * its own. A solid is made in the sculpting pose and moved by its own bones. A drape is made at rest, where
   * it hangs as authored, given to the body solids beside it, and then carried into the sculpting pose by them.
   * @returns {Generator<undefined, Array<{layer: SculptLayer, pieces: Object[]}>, unknown>} yields between steps; returns the layers
   */
  function* wornSteps(bake, figureLayout, { cell, matrices, bodyPieces, limbLead }) {
    const { plan } = bake;
    const { wears, hangs } = wearOf(plan);
    const worn = wornPieces(figureLayout, wears);
    if (!worn.length) return [];
    const rest = restMatrices(bake);
    /** Objects by socket (the bone name's first step), paint and wear. */
    const objects = new Map();
    worn.forEach((piece) => {
      const key = `${plan.boneNames[piece.bone].split('/')[0]}|${piece.ramp}|${wears[piece.bone]}`;
      objects.set(key, [...(objects.get(key) || []), piece]);
    });
    /** The body's solids at rest, made once and only when something is draped. */
    let hosts = null;
    const hostsFor = (mask) => {
      hosts = hosts || bodyPieces.map((piece) => ({ piece, part: solidOf(piece, rest, limbLead) }));
      const chosen = hosts.filter(({ piece }) => mask === 0 || (plan.roles[piece.bone] & mask) !== 0);
      return (chosen.length ? chosen : hosts).map(({ part }) => part);
    };
    const made = [];
    for (const [key, pieces] of objects) {
      const isDrape = wears[pieces[0].bone] === 'drape';
      const pose = isDrape ? rest : matrices;
      const ownCell =
        cell ||
        Kit.sculpt.cellFor(
          pieces.map((piece) => solidOf(piece, pose, limbLead)),
          figureLayout.level
        );
      const kept = [];
      pieces.forEach((piece) => {
        const part = fittedSolid(piece, pose, limbLead, ownCell);
        // An object is one thing: its solids blend wherever they meet, and it joins nothing else.
        if (part) kept.push({ piece, part: Object.assign(part, { group: 0, anchor: undefined, join: undefined }) });
      });
      if (!kept.length) continue;
      const solids = kept.map(({ part }) => part);
      const mesh = Kit.sculpt.surface(yield* Kit.sculpt.sampleSteps(solids, { cell: ownCell }));
      if (!mesh.indices.length) continue;
      yield undefined;
      const [first] = kept;
      const drapeHosts = isDrape && bodyPieces.length ? hostsFor(hangs[first.piece.bone]) : null;
      const skin = drapeHosts
        ? Kit.sculpt.weights(mesh.positions, drapeHosts, { spread: SCULPT.drapeSpread, reach: Infinity, sharpness: SCULPT.drapeSharpness })
        : Kit.sculpt.weights(mesh.positions, solids, { spread: SCULPT.weightSpread, reach: ownCell });
      // Made at rest (a drape with something to hang on, or a drape alone): carried into the pose the skeleton is bound in.
      if (isDrape) carry(mesh, skin, rest, matrices);
      made.push({ layer: { id: `worn:${key}`, ramp: first.piece.ramp, inkGroup: first.piece.inkGroup, inkClass: first.piece.ramp, ...mesh, ...skin }, pieces: kept.map(({ piece }) => piece) });
      yield undefined;
    }
    return made;
  }

  Kit.figure = Object.assign(Kit.figure || {}, { SCULPT, restMatrices, limbsOf, spreadPose, limbClearance, sculptSignature, sculptCache, sculptLayers, sculptTask });
})();
