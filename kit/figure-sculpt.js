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
    /**
     * And at least this share of a grid cell: the mesh of the surface below sags between its vertices by about
     * a fifth of a cell across a limb, and where that surface is not meshed under the layer (kit/sculpt.js
     * `surface`, `under`) the layer's wall must reach past the sag or a gap opens at the hem.
     */
    wallShare: 0.3,
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
    /** Cloth too thin for the grid is meshed as a shell of its built shape, with no edge longer than this many cells (kit/drape.js). */
    shellEdgeCells: 3.5,
    /** A drape stands off what is under it by this share of a grid cell, and never less than `Kit.drape.DRAPE.gap`. */
    gapCells: 0.35,
    /** A draped piece shorter than this from its joint to its middle has no way to hang, and is not swung. */
    leastHang: 0.03,
    /** Limbs that hang beside a cloth, not under it: a drape is not laid over them unless its row's `covers` says so. */
    beside: Object.freeze(['arm', 'hand']),
    /** A draped bone's `clings` when its row states none, metres (see `WEARS`). */
    clings: 0.1,
    /** A painted layer lies on a bone's own surface: where a relief mark stands further off it than this (an ear, a nose), the mark shows through. */
    proud: 0.018,
    /** A draped object's vertex is shared between the body solids within this many metres of being its nearest. */
    drapeSpread: 0.16,
    /** Within that, a vertex stays with its nearest solid by this power of nearness (`Kit.sculpt.weights`). */
    drapeSharpness: 5,
    /** Sculpted bakes kept for reuse (`sculptCache`): at most this many, and at most `keptBytes` of arrays between them. */
    kept: 24,
    keptBytes: 12e6,
  });
  /** Numbers per vertex of a surface's `paint`: the ramp slot, the ink group, and 1 where it glints (a shiny piece). */
  const PAINT = 3;
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
   *  - 'solid': sculpted on its own grid and moved by its own bone (a hat, a horn, a bun). A row that states a
   *    `rank` is worn over the drapes of a lower rank: it is set out on them (a pack on a cloak), not left
   *    where it was authored against the bare back;
   *  - 'drape': cloth. It is made where it hangs at rest, laid over whatever is under it there (the body, the
   *    garments on it and the drapes of a lower `rank`), and moved by the body's bones beneath it and by its own
   *    bone (kit/drape.js). Its row may state `hangs` (the roles of the body bones that may carry it, default
   *    any), `rank` (drapes are laid on in rising rank, each over those before it: a cloak over a skirt; default
   *    1), `clings` (metres off the body within which the body carries it; further out it rides its own bone,
   *    which a movement may simulate; default `SCULPT.clings`) and `covers` (the roles of the body bones it is
   *    laid over; default every bone but those of `SCULPT.beside`: an arm hangs beside a skirt, not under it);
   *  - anything else: the rigid piece it always was (a sword, glasses).
   * @type {Readonly<string[]>}
   */
  const WEARS = Object.freeze(['solid', 'drape']);

  /** Per bone: its `wear` when it is one the sculpt takes, else ''. Per bone too: the role mask of `hangs` (0: any), its `rank` and its `clings`. */
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
    // A drape is laid on at rank 1 unless its row says otherwise; a solid has no rank (0) unless its row gives it one.
    const ranks = plan.boneNames.map((name, bone) => (byName.get(name) && Number.isFinite(byName.get(name).rank) ? byName.get(name).rank : wears[bone] === 'drape' ? 1 : 0));
    const clings = plan.boneNames.map((name) => (byName.get(name) && Number.isFinite(byName.get(name).clings) ? byName.get(name).clings : SCULPT.clings));
    const covers = plan.boneNames.map((name) => (byName.get(name) && byName.get(name).covers ? Kit.body.roleMask(byName.get(name).covers) : 0));
    return { wears, hangs, ranks, clings, covers };
  };

  /** Can this piece be a solid at all: shaded normally, of a kind that has a distance? */
  const isSolidPiece = (piece) =>
    !piece.stamps && !piece.shell && !piece.emissive && piece.tone === undefined && piece.inkGroup !== Kit.figure.INK_GROUPS.glow && Boolean(Kit.sculpt.KINDS[piece.shape.kind]);
  /** Is this piece a solid of the body itself: one the body's skin may replace? */
  const isSculpted = (piece) => !piece.isProp && isSolidPiece(piece);
  /** The pieces of worn objects the sculpt takes, by the wear of their bones. */
  const wornPieces = (figureLayout, wears) => figureLayout.pieces.filter((piece) => piece.isProp && wears[piece.bone] && isSolidPiece(piece));

  /**
   * The relief marks among a body's sculpted pieces, by the piece they are modelled out of: a feature's solid
   * (`isFeature`) on a bone that has a surface of its own, painted as that surface or pressed into it (`carve`).
   * A feature of another paint (a moustache on a face) is no mark: it stays a solid of its own.
   * @param {Object[]} pieces the layout pieces that can be sculpted
   * @param {Object} plan the bake's plan
   * @returns {Map<Object, Object[]>} host piece -> its marks, in layout order
   */
  const marksByHost = (pieces, plan) => {
    const hosts = new Map();
    pieces.forEach((piece) => !piece.isFeature && piece.id === plan.boneNames[piece.bone] && hosts.set(piece.bone, piece));
    const marks = new Map();
    pieces.forEach((piece) => {
      const host = piece.isFeature ? hosts.get(piece.bone) : null;
      if (host && (piece.carve || piece.ramp === host.ramp)) marks.set(host, [...(marks.get(host) || []), piece]);
    });
    return marks;
  };

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
   * @property {boolean} [isShiny] it glints (a rigid piece joined as it is: a blade)
   * @property {Uint8Array} [locked] per vertex, 1 where it must be kept when the surface is made lighter (all of a rigid piece)
   * @property {SculptLayer} [on] for paint: the layer it was cut out of, whose vertices on the cut it shares
   * @property {Float32Array} [faceShare] on a body surface: per vertex, how much of it the head's bones move (0..1); a look lights a face and a form differently
   */

  /**
   * @typedef {Object} Sculpted
   * @property {SculptLayer[]} layers shared between equal bakes: never write to their arrays (views of `surface`'s, a layer each, made the first time they are read)
   * @property {SculptSurface} surface every layer as one mesh: what a figure draws
   * @property {number} bytes what the surface's arrays take, bytes
   * @property {Set<string>} replaced ids of the layout pieces the layers stand in for (do not draw them)
   * @property {Set<string>} joined ids of the layout pieces that are drawn in the surface as they are: rigid, each moved
   *   wholly by its own bone, with the triangles it was authored with (a sword, a pack; do not draw them either)
   * @property {Float32Array} matrices the bone matrices the layers were made in (the bind pose), 16 per bone
   * @property {{leads: Int16Array, turns: Float32Array}} clearance see `limbClearance`
   * @property {string} signature what the layers depend on (see `sculptSignature`)
   */

  /** Where a bone's joint is: the move of its matrix (the fourth column of a column-major 4 x 4), as [x, y, z]. */
  const originOf = (matrices, bone) => Array.from(matrices.subarray(bone * MATRIX + ROW_AFFINE, bone * MATRIX + ROW_AFFINE + VECTOR));

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
   * @property {Uint8Array} paint 3 per vertex: its layer's ramp slot (also its line class), its ink group, and 1 where it is shiny
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
    placed.anchor = originOf(matrices, lead);
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
   * @param {number} [mostProud] metres: the cut leaves out points further than this from the bone's own surface
   *   (`Solid.plain`, set by `Kit.sculpt.relief`), so an ear or a nose shows through what is painted round it
   * @returns {function(number, number, number): boolean}
   */
  const cutOf = (garment, field, frames, mostProud = Infinity) => {
    const { solids } = field;
    /** Per solid of the field: the garment's predicates on its bone, or null (most solids: answered at once). */
    const testsOf = solids.map((part) => garment.tests.get(part.owner) || null);
    const along = [0, 0];
    return (x, y, z) => {
      const index = Kit.sculpt.nearestAt(field, x, y, z);
      const tests = index >= 0 ? testsOf[index] : null;
      if (!tests) return false;
      const part = solids[index];
      // Over a relief mark that stands well off the bone (an ear under a hairline), the garment gives way.
      if (part.plain && part.plain(x, y, z) > mostProud) return false;
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

  const HALF = 0.5;
  /** Where a column-major 4 x 4 keeps its translation. */
  const MOVE = 12;
  /** Paint lies on the seen side of a raised garment: on what is within this many cells of its outer surface (its hem's wall, not its underside). */
  const PAINT_DEPTH_CELLS = 1;
  /** Steps of bisection when a pattern's edge is found along a triangle's edge (2^-7 of the edge). */
  const PAINT_STEPS = 7;

  /**
   * A mesh of only the vertices its triangles use, in order of first use, with their normals and skin.
   * @param {{positions: ArrayLike<number>, normals: ArrayLike<number>, owners: ArrayLike<number>, weights: ArrayLike<number>}} source
   * @param {ArrayLike<number>} triangles three vertex numbers of `source` each
   * @returns {?{positions: Float32Array, normals: Float32Array, indices: Uint16Array|Uint32Array, owners: Uint16Array, weights: Float32Array}} null when there are no triangles
   */
  const usedMesh = (source, triangles) => {
    if (!triangles.length) return null;
    const renumbered = new Int32Array(source.positions.length / VECTOR).fill(-1);
    let used = 0;
    for (let corner = 0; corner < triangles.length; corner++) if (renumbered[triangles[corner]] < 0) renumbered[triangles[corner]] = used++;
    const mesh = { positions: new Float32Array(used * VECTOR), normals: new Float32Array(used * VECTOR), owners: new Uint16Array(used * OWNERS), weights: new Float32Array(used * OWNERS) };
    renumbered.forEach((to, vertex) => {
      if (to < 0) return;
      for (let axis = 0; axis < VECTOR; axis++) {
        mesh.normals[to * VECTOR + axis] = source.normals[vertex * VECTOR + axis];
        mesh.positions[to * VECTOR + axis] = source.positions[vertex * VECTOR + axis];
      }
      for (let slot = 0; slot < OWNERS; slot++) {
        mesh.owners[to * OWNERS + slot] = source.owners[vertex * OWNERS + slot];
        mesh.weights[to * OWNERS + slot] = source.weights[vertex * OWNERS + slot];
      }
    });
    const indices = Array.from(triangles, (vertex) => renumbered[vertex]);
    return { ...mesh, indices: used > MOST_SHORT_INDEX ? Uint32Array.from(indices) : Uint16Array.from(indices) };
  };

  /** A covered surface is kept this many triangles in from the edge of what covers it (a hem seen from below still has skin behind it). */
  const COVER_RINGS = 1;

  /**
   * What is left of a layer when a layer above covers part of it: the triangles a viewer can still see, plus
   * a margin of `rings` triangles under the cover's edge. A layer under a garment is never seen, and drawing it
   * costs its triangles for nothing (and lets it poke through the garment in a deep bend).
   * @param {SculptLayer} layer
   * @param {function(number, number, number): boolean} covers is this point of the layer under the cover?
   * @param {function(number): boolean} mayHold can `covers` hold on vertices owned by this bone? (it is not asked elsewhere)
   * @param {number} [rings] triangles kept in from the cover's edge
   * @returns {?Object} the mesh left (see `usedMesh`); the layer itself when nothing is covered; null when all of it is
   * @complexity O(vertices) calls of `covers`, O(rings * triangles) besides
   * @example
   * const seen = Kit.figure.uncovered(skin, (x, y, z) => y < 1, () => true); // skin under a knee-length robe: gone, but for a band under its hem
   */
  const uncovered = (layer, covers, mayHold, rings = COVER_RINGS) => {
    const { positions, indices, owners } = layer;
    const hidden = Uint8Array.from({ length: positions.length / VECTOR }, (_unused, vertex) => (mayHold(owners[vertex * OWNERS]) && covers(positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2]) ? 1 : 0));
    if (!hidden.includes(1)) return layer;
    for (let ring = 0; ring < rings; ring++) {
      const shown = new Uint8Array(hidden.length);
      for (let corner = 0; corner < indices.length; corner += VECTOR) {
        if (hidden[indices[corner]] && hidden[indices[corner + 1]] && hidden[indices[corner + 2]]) continue;
        for (let turn = 0; turn < VECTOR; turn++) shown[indices[corner + turn]] = 1;
      }
      shown.forEach((isShown, vertex) => {
        if (isShown) hidden[vertex] = 0;
      });
    }
    const kept = [];
    for (let corner = 0; corner < indices.length; corner += VECTOR) {
      if (!(hidden[indices[corner]] && hidden[indices[corner + 1]] && hidden[indices[corner + 2]])) kept.push(indices[corner], indices[corner + 1], indices[corner + 2]);
    }
    return kept.length === indices.length ? layer : usedMesh(layer, kept);
  };

  /** Edges are keyed by their two vertex numbers; this many vertices fit in half a key. */
  const EDGE_KEY = 0x4000000;

  /**
   * Paint on a layer: the layer's surface parted where a predicate holds (stripes, a trim, a tattoo) into a
   * painted sheet and the rest, both made of the layer's own triangles. A sheet meshed on its own and laid
   * over the surface is faceted differently from it and crosses it in ragged bands, shades by normals of its
   * own, takes skin weights of its own, and costs its triangles twice; the two parts here share every vertex
   * on the cut, its normal and its skin, so they shade as one surface, never part in a pose, and add only the
   * triangles the cut itself makes.
   *
   * The pattern's edge is found exactly: the predicate is asked at every vertex; an edge whose ends differ is
   * crossed once, at a point placed by bisection; an edge whose ends agree is asked at its middle too, and split
   * there when the middle differs (a stripe narrower than a triangle is still seen, at any level of detail). A
   * crossing or a split is decided per edge, so the two triangles on it agree and neither part has cracks.
   * Each part has its own copy of the vertices on the cut, bit for bit the same: `joinLayers` makes them one
   * again, so a mesh made lighter afterwards moves the cut's vertices in both parts at once.
   * @param {SculptLayer} canvas the layer painted on (a skin, or a raised garment)
   * @param {function(number, number, number): boolean} keep is a point of the canvas painted? (in the canvas's space)
   * @param {function(number): boolean} mayHold can the predicate hold on vertices owned by this bone? (it is not asked elsewhere)
   * @returns {{painted: ?Object, rest: ?Object}} the painted sheet and what is left of the canvas (positions, normals, indices, owners, weights); either is null when empty
   * @complexity O(vertices + triangles of the canvas), with about one predicate call per vertex and edge near the paint and 7 per crossing
   * @example
   * const { painted, rest } = Kit.figure.paintedOn(skin, (x, y, z) => Math.floor(y * 20) % 2 === 0, () => true);
   * // hoops 5 cm wide: painted and rest together cover the skin exactly, and meet along level lines
   */
  const paintedOn = (canvas, keep, mayHold) => {
    // Working vertices: the canvas's own, then the middles and crossings made here.
    const positions = Array.from(canvas.positions);
    const normals = Array.from(canvas.normals);
    const owners = Array.from(canvas.owners);
    const weights = Array.from(canvas.weights);
    /** Per working vertex: 1 painted, 0 not, -1 not asked yet. */
    const flags = new Array(canvas.positions.length / VECTOR).fill(-1);
    const isPainted = (vertex) => {
      if (flags[vertex] < 0) flags[vertex] = keep(positions[vertex * VECTOR], positions[vertex * VECTOR + 1], positions[vertex * VECTOR + 2]) ? 1 : 0;
      return flags[vertex];
    };
    /** A new working vertex `share` of the way from one to another: position, normal and skin blended. */
    const between = (from, to, share, flag) => {
      const vertex = flags.length;
      for (let axis = 0; axis < VECTOR; axis++) positions.push(positions[from * VECTOR + axis] + (positions[to * VECTOR + axis] - positions[from * VECTOR + axis]) * share);
      const normal = [0, 1, 2].map((axis) => normals[from * VECTOR + axis] + (normals[to * VECTOR + axis] - normals[from * VECTOR + axis]) * share);
      const length = Math.hypot(...normal) || 1;
      normals.push(normal[0] / length, normal[1] / length, normal[2] / length);
      // The owners of both ends, each by its end's share; the strongest four, made to sum to one.
      const shares = new Map();
      for (let slot = 0; slot < OWNERS; slot++) {
        shares.set(owners[from * OWNERS + slot], (shares.get(owners[from * OWNERS + slot]) || 0) + weights[from * OWNERS + slot] * (1 - share));
        shares.set(owners[to * OWNERS + slot], (shares.get(owners[to * OWNERS + slot]) || 0) + weights[to * OWNERS + slot] * share);
      }
      const strongest = [...shares].filter(([, held]) => held > 0).sort((first, second) => second[1] - first[1]).slice(0, OWNERS);
      const total = strongest.reduce((sum, [, held]) => sum + held, 0) || 1;
      for (let slot = 0; slot < OWNERS; slot++) {
        owners.push(slot < strongest.length ? strongest[slot][0] : 0);
        weights.push(slot < strongest.length ? strongest[slot][1] / total : 0);
      }
      flags.push(flag);
      return vertex;
    };
    const edgeKey = (first, second) => (first < second ? first * EDGE_KEY + second : second * EDGE_KEY + first);
    /** The middle of each canvas edge the pattern's edge may pass through, by edge; -1 for an edge it does not. */
    const middles = new Map();
    const middleOf = (first, second) => {
      const key = edgeKey(first, second);
      if (middles.has(key)) return middles.get(key);
      // Ends that differ have one crossing between them, found by bisection; ends that agree may still have a
      // stripe (or a gap) pass between them, which only the middle can tell.
      let middle = -1;
      if (isPainted(first) === isPainted(second)) {
        const at = [0, 1, 2].map((axis) => (positions[first * VECTOR + axis] + positions[second * VECTOR + axis]) / 2);
        const flag = keep(at[0], at[1], at[2]) ? 1 : 0;
        if (flag !== flags[first]) middle = between(first, second, HALF, flag);
      }
      middles.set(key, middle);
      return middle;
    };
    /** Where the pattern's edge crosses the edge between a painted and an unpainted working vertex, by edge. */
    const crossings = new Map();
    const crossingOf = (inside, outside) => {
      const key = edgeKey(inside, outside);
      if (crossings.has(key)) return crossings.get(key);
      let [low, high] = [0, 1];
      for (let step = 0; step < PAINT_STEPS; step++) {
        const share = (low + high) / 2;
        const at = [0, 1, 2].map((axis) => positions[inside * VECTOR + axis] + (positions[outside * VECTOR + axis] - positions[inside * VECTOR + axis]) * share);
        if (keep(at[0], at[1], at[2])) low = share;
        else high = share;
      }
      const crossing = between(inside, outside, (low + high) / 2, 1);
      crossings.set(key, crossing);
      return crossing;
    };
    const painted = [];
    const rest = [];
    /** Parts a triangle whose corners know whether they are painted between the two lists; the winding is kept. */
    const part = (first, second, third) => {
      const corners = [first, second, third];
      const inside = corners.filter((vertex) => flags[vertex] === 1).length;
      if (inside === 0 || inside === VECTOR) {
        (inside ? painted : rest).push(first, second, third);
        return;
      }
      // Turned so the odd corner out (the one painted, or the one not) comes first.
      const odd = corners.findIndex((vertex) => (flags[vertex] === 1) === (inside === 1));
      const [lone, next, last] = [corners[odd], corners[(odd + 1) % VECTOR], corners[(odd + 2) % VECTOR]];
      const [toNext, toLast] = inside === 1 ? [crossingOf(lone, next), crossingOf(lone, last)] : [crossingOf(next, lone), crossingOf(last, lone)];
      (inside === 1 ? painted : rest).push(lone, toNext, toLast);
      (inside === 1 ? rest : painted).push(next, last, toLast, next, toLast, toNext);
    };
    const source = canvas.indices;
    for (let corner = 0; corner < source.length; corner += VECTOR) {
      const corners = [source[corner], source[corner + 1], source[corner + 2]];
      if (!corners.some((vertex) => mayHold(canvas.owners[vertex * OWNERS]))) {
        rest.push(...corners);
        continue;
      }
      const split = [middleOf(corners[0], corners[1]), middleOf(corners[1], corners[2]), middleOf(corners[2], corners[0])];
      const splits = split.filter((middle) => middle >= 0).length;
      if (splits === 0) part(...corners);
      else if (splits === VECTOR) {
        part(corners[0], split[0], split[2]);
        part(split[0], corners[1], split[1]);
        part(split[2], split[1], corners[2]);
        part(split[0], split[1], split[2]);
      } else {
        const lead = splits === 1 ? split.findIndex((middle) => middle >= 0) : split.findIndex((middle, index) => middle >= 0 && split[(index + 2) % VECTOR] < 0);
        const [first, second, third] = [corners[lead], corners[(lead + 1) % VECTOR], corners[(lead + 2) % VECTOR]];
        const [firstMiddle, secondMiddle] = [split[lead], split[(lead + 1) % VECTOR]];
        part(first, firstMiddle, third);
        if (splits === 1) part(firstMiddle, second, third);
        else {
          part(firstMiddle, secondMiddle, third);
          part(firstMiddle, second, secondMiddle);
        }
      }
    }
    const working = { positions, normals, owners, weights };
    return { painted: usedMesh(working, painted), rest: usedMesh(working, rest) };
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
    const { wears, hangs, ranks, clings, covers } = wearOf(bake.plan);
    // Every piece that is sculpted, worn or joined as it is: all but stamps and the like, whose looks are not the surface's.
    const pieces = figureLayout.pieces
      .filter((piece) => isSculpted(piece) || (piece.isProp && wears[piece.bone] && isSolidPiece(piece)) || isJoinable(piece))
      .map((piece) =>
        [
          piece.id,
          piece.bone,
          piece.key,
          piece.ramp,
          piece.inkGroup,
          piece.regions ? piece.regions.key : '',
          wears[piece.bone],
          hangs[piece.bone],
          ranks[piece.bone],
          clings[piece.bone],
          covers[piece.bone],
          piece.carve ? 'carve' : '',
          piece.blend === undefined ? '' : piece.blend,
          piece.shiny ? 'shiny' : '',
        ].join('~')
      );
    const rest = bake.rest || Kit.body.createPose(bake.plan);
    // Every array of the pose: a size dial (a height) writes `uniform` alone, and two bodies that differ only
    // there must not share layers (a drape is made in the rest pose, so it is as long as the body it was made for).
    const pose = [rest.translation, rest.rotation, rest.scale, rest.uniform].map((values) => Array.from(values, (value) => value.toFixed(SIGNATURE_DECIMALS)).join(','));
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
   * @type {{clear: function(): void, size: function(): number, bytes: function(): number, has: function(string): boolean}}
   */
  const sculptCache = {
    clear: () => {
      kept.clear();
      keptBytes = 0;
    },
    size: () => kept.size,
    bytes: () => keptBytes,
    /** Is the bake of this signature (`sculptSignature`, a task's `signature`) kept? Does not count as a use. */
    has: (signature) => kept.has(signature),
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
      // Not a copy: `layers` is made when read, and a copy would read it.
      task.result = Object.assign(step.value, { signature });
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
    // A feature's solid painted as its bone (a nose, a brow ridge) or pressed into it (an eye socket) is not a
    // solid beside the bone but a mark modelled out of it (kit/sculpt-relief.js): one surface, one fillet each.
    const marks = marksByHost(candidates, plan);
    const marked = new Set([...marks.values()].flat());
    const meshed = candidates
      .filter((piece) => !marked.has(piece) && !piece.carve)
      .map((piece) => ({ piece, part: fittedSolid(piece, matrices, limbLead, cell) }))
      .filter(({ part }) => part);
    const replaced = new Set(meshed.map(({ piece }) => piece.id));
    meshed.forEach((entry) => {
      const own = marks.get(entry.piece);
      if (!own) return;
      // A mark pressed on is thickened to what the grid can hold, like any solid; one too thin even for that stays a rigid piece.
      const fitted = own.map((piece) => ({ piece, solid: piece.carve ? solidOf(piece, matrices, limbLead) : fittedSolid(piece, matrices, limbLead, cell) })).filter(({ solid }) => solid);
      entry.part = Kit.sculpt.relief(
        entry.part,
        fitted.map(({ piece, solid }) => ({ solid, blend: piece.blend, carve: piece.carve }))
      );
      fitted.forEach(({ piece }) => replaced.add(piece.id));
    });
    // The shells the layout made for raised regions are replaced along with the surfaces they were copies of.
    figureLayout.pieces.filter((piece) => piece.shell && replaced.has(piece.id.split('~')[0])).forEach((piece) => replaced.add(piece.id));
    /** Body solids by ramp: each paint of the body is one blended skin. */
    const groups = new Map();
    meshed.forEach(({ piece, part }) => {
      const group = groups.get(piece.ramp) || { ramp: piece.ramp, inkGroup: piece.inkGroup, solids: [], dressed: [] };
      group.solids.push(part);
      // Garments are worn by a bone's own surface, never by a feature lying on it in another paint (a moustache).
      if (!piece.isFeature) group.dressed.push(part.owner);
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
    /** Per bone: how far the outermost raised garment on it stands off the skin (what a drape over it must clear). */
    const lifts = new Float32Array(plan.boneCount);
    for (const group of groups.values()) {
      const bones = [...new Set(group.dressed)];
      const specs = regions && frames ? stackGarments(garmentsOn(bones, regions), cell * Kit.sculpt.DETAIL[detail].error) : [];
      specs.filter((spec) => !spec.isPaint).forEach((spec) => spec.garment.tests.forEach((_tests, bone) => (lifts[bone] = Math.max(lifts[bone], spec.offset))));
      const field = yield* Kit.sculpt.sampleSteps(group.solids, { cell, margin: Math.max(0, ...specs.map((spec) => spec.offset)) });
      const layerOf = (id, ramp, mesh, offset) => ({
        id,
        ramp,
        inkGroup: group.inkGroup,
        inkClass: ramp,
        ...mesh,
        ...Kit.sculpt.weights(mesh.positions, group.solids, { spread: SCULPT.weightSpread, reach: offset + cell }),
      });
      // The layering rule: what a raised garment covers is not drawn, and so is not meshed (kit/sculpt.js
      // `surface`, `cover` / `under`). The raised garments are made from the outermost in and the skin last, each
      // marking where it lies; what is made after it stops a cell inside its edge, behind its wall.
      const raised = specs.filter((spec) => !spec.isPaint);
      const cover = options.cull !== false && raised.length ? new Uint8Array(field.values.length) : undefined;
      // Over a relief mark that stands proud of the bone (an ear under a hairline) a garment gives way: it is
      // neither painted nor raised there, and so covers nothing there either.
      const ownCut = ({ garment, offset }) => cutOf(garment, field, frames, offset + SCULPT.proud);
      /** The layer each raised garment of this group became, by garment key: what its paint is painted on. */
      const layerOfGarment = new Map();
      for (const spec of [...raised].sort((first, second) => second.offset - first.offset)) {
        const { garment, offset } = spec;
        const near = Uint8Array.from(group.solids, (part) => (garment.tests.has(part.owner) ? 1 : 0));
        const cloth = yield* Kit.sculpt.surfaceSteps(field, { offset, cut: ownCut(spec), near, depth: Math.max(SCULPT.buriedDepth, cell * SCULPT.wallShare), cover, under: cover });
        yield undefined;
        if (cloth.indices.length) layerOfGarment.set(garment.key, layerOf(`region:${garment.key}`, garment.ramp, cloth, offset));
        yield undefined;
      }
      const bare = yield* Kit.sculpt.surfaceSteps(field, { under: cover });
      yield undefined;
      const skin = layerOf(`skin:${group.ramp}`, group.ramp, bare, 0);
      yield undefined;
      // Paint is cut out of the surface it is on (what is left of it: paint under a garment is not there to cut),
      // the last painted first: where two patterns overlap, the later one shows, and no triangle is drawn twice.
      /** The sheet each paint of this group became, by garment key. */
      const sheetOfPaint = new Map();
      for (const spec of specs.filter((candidate) => candidate.isPaint).reverse()) {
        const { garment, offset, host } = spec;
        const canvas = host ? layerOfGarment.get(host.key) : skin;
        if (!canvas || !canvas.indices.length) continue;
        const own = ownCut(spec);
        // On a raised garment, paint is on the seen side: its outer surface and its hem's wall, not its underside.
        const least = offset - SCULPT.paintLift - cell * PAINT_DEPTH_CELLS;
        const keep = host ? (x, y, z) => own(x, y, z) && Kit.sculpt.valueAt(field, x, y, z) >= least : own;
        const { painted, rest } = paintedOn(canvas, keep, (bone) => garment.tests.has(bone));
        if (painted) {
          sheetOfPaint.set(garment.key, { id: `region:${garment.key}`, ramp: garment.ramp, inkGroup: group.inkGroup, inkClass: garment.ramp, on: canvas, ...painted });
          Object.assign(canvas, rest || { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint16Array(0), owners: new Uint16Array(0), weights: new Float32Array(0) });
        }
        yield undefined;
      }
      skin.faceShare = shareOf(skin, isHeadBone);
      // Listed as they are painted: the skin, then each garment and each paint in paint order. One wholly painted over is not listed.
      layers.push(...[skin, ...specs.map(({ garment, isPaint }) => (isPaint ? sheetOfPaint : layerOfGarment).get(garment.key))].filter((layer) => layer && layer.indices.length));
      yield undefined;
    }
    const worn = yield* wornSteps(bake, figureLayout, { cell, matrices, bodyPieces: meshed.map(({ piece }) => piece), limbLead, lifts });
    worn.forEach(({ layer, pieces }) => {
      layers.push(layer);
      pieces.forEach((piece) => replaced.add(piece.id));
    });
    // What is left rigid and plainly shaded rides in the same mesh, so a figure is one draw and its face.
    const rigid = figureLayout.pieces.filter((piece) => !replaced.has(piece.id) && isJoinable(piece));
    const drawn = [...layers, ...rigid.map((piece) => rigidLayer(piece, matrices, figureLayout.level))];
    const whole = joinLayers(drawn);
    yield undefined;
    const level = Kit.sculpt.DETAIL[detail];
    const tolerance = (cell || level.cell) * level.error;
    // A rigid piece is `locked`: it keeps the triangles its shape was built with. The line where paint meets what
    // it is painted on is a line between two `paints`: it keeps its course, and both sides keep sharing its vertices.
    const light = options.simplify === false ? null : yield* Kit.sculpt.simplifySteps(whole, { tolerance, most: level.triangles || 0, skin: whole, locked: whole.locked, paints: whole.paints });
    const surface = surfaceOf(whole, drawn, light);
    // What each layer is, without its dense arrays: the layers are found again in the surface only when someone reads them.
    const kinds = layers.map(({ id, ramp, inkGroup, inkClass, faceShare }) => ({ id, ramp, inkGroup, inkClass, isBody: Boolean(faceShare) }));
    let views = null;
    return {
      get layers() {
        views = views || layerViews(surface, kinds);
        return views;
      },
      surface,
      bytes: bytesOf(surface),
      replaced,
      joined: new Set(rigid.map((piece) => piece.id)),
      matrices,
      clearance,
    };
  }

  /** A built shape's points placed by a bone matrix (column-major 4 x 4 at `at` in `matrices`). */
  const placedPoints = (positions, matrices, at) => {
    const placed = new Float32Array(positions.length);
    for (let offset = 0; offset < positions.length; offset += VECTOR) {
      const [x, y, z] = [positions[offset], positions[offset + 1], positions[offset + 2]];
      for (let axis = 0; axis < VECTOR; axis++) placed[offset + axis] = matrices[at + axis] * x + matrices[at + 4 + axis] * y + matrices[at + 8 + axis] * z + matrices[at + 12 + axis];
    }
    return placed;
  };

  /** Is a bone matrix a mirror (its three axes left-handed)? A shape placed by one has its triangles wound the other way. */
  const isMirror = (matrices, at) => {
    const [xx, xy, xz, , yx, yy, yz, , zx, zy, zz] = matrices.subarray(at, at + ROW_AFFINE);
    return xx * (yy * zz - yz * zy) - yx * (xy * zz - xz * zy) + zx * (xy * yz - xz * yy) < 0;
  };

  /** Several meshes as one: `{ positions, normals, indices }` end to end, with a per-vertex array of `tags` (one tag per mesh). */
  const joinedMesh = (meshes, tags) => {
    const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.positions.length / VECTOR, 0);
    const positions = new Float32Array(vertexCount * VECTOR);
    const normals = new Float32Array(vertexCount * VECTOR);
    const indices = new Uint32Array(meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0));
    const tagOf = new Int32Array(vertexCount);
    let [vertexAt, indexAt] = [0, 0];
    meshes.forEach((mesh, order) => {
      positions.set(mesh.positions, vertexAt * VECTOR);
      normals.set(mesh.normals, vertexAt * VECTOR);
      for (let corner = 0; corner < mesh.indices.length; corner++) indices[indexAt + corner] = mesh.indices[corner] + vertexAt;
      tagOf.fill(tags[order], vertexAt, vertexAt + mesh.positions.length / VECTOR);
      vertexAt += mesh.positions.length / VECTOR;
      indexAt += mesh.indices.length;
    });
    return { positions, normals, indices: vertexCount > MOST_SHORT_INDEX ? indices : Uint16Array.from(indices), tagOf };
  };
  /** The longest edge of a surface net, in cells: a cell's diagonal and a half. */
  const NET_EDGE_CELLS = 2.6;
  /** Balls per edge length that make a laid cloth's vertices one surface for the next cloth (`Kit.drape.cloud`). */
  const CLOUD_SHARE = 0.6;
  /** The vertices of a laid cloth that were moved from where they were authored, as a solid for the cloths laid over it. */
  const movedCloud = (mesh, before, longestEdge) => {
    const points = [];
    for (let at = 0; at < before.length; at += VECTOR)
      if (mesh.positions[at] !== before[at] || mesh.positions[at + 1] !== before[at + 1] || mesh.positions[at + 2] !== before[at + 2]) points.push(mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]);
    return Kit.drape.cloud(points, longestEdge * CLOUD_SHARE);
  };

  /**
   * Can a piece the sculpt leaves rigid be drawn in the surface: shaded from one ramp like a layer, with an
   * outline of its own? Stamps, painted or raised pieces and fixed tones need a material of their own; a carving
   * piece (a shape pressed into a surface) is never drawn at all.
   */
  const isJoinable = (piece) => !piece.carve && !piece.stamps && !piece.regions && !piece.shell && !piece.emissive && piece.tone === undefined && piece.outlined !== false && piece.inkGroup > 0;

  /** Numbers along a side of a 4 x 4 matrix, and so between the rows of an affine map kept as three rows of four. */
  const SIDE = 4;

  /**
   * A rigid piece as a layer: its shape's own mesh placed by its bone in the sculpting pose and owned wholly
   * by that bone, so the skeleton moves it exactly as it moved the piece. Its vertices are `locked`: it keeps
   * the triangles its shape was built with (its edges are meant, not a grid's).
   * @complexity O(vertices of the piece)
   */
  const rigidLayer = (piece, matrices, level) => {
    const built = Kit.figure.buildShape(piece.shape, level);
    const at = piece.bone * MATRIX;
    const inverse = Kit.sculpt.invertAffine(matrices.subarray(at, at + MATRIX));
    const count = built.positions.length / VECTOR;
    const normals = new Float32Array(count * VECTOR);
    for (let offset = 0; offset < normals.length; offset += VECTOR) {
      const [nx, ny, nz] = [built.normals[offset], built.normals[offset + 1], built.normals[offset + 2]];
      // A normal is carried by the inverse's transpose, which keeps it square to the surface under a stretch.
      for (let axis = 0; axis < VECTOR; axis++) normals[offset + axis] = inverse[axis] * nx + inverse[SIDE + axis] * ny + inverse[2 * SIDE + axis] * nz;
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
      for (let axis = 0; axis < VECTOR; axis++) normals[offset + axis] /= length;
    }
    // A bone that mirrors (a left hand made from the right) turns triangles inside out: wind them back.
    const indices = Uint32Array.from(built.indices);
    if (isMirror(matrices, at)) for (let face = 0; face < indices.length; face += VECTOR) [indices[face + 1], indices[face + 2]] = [indices[face + 2], indices[face + 1]];
    const owners = new Uint16Array(count * OWNERS);
    const weights = new Float32Array(count * OWNERS);
    for (let vertex = 0; vertex < count; vertex++) {
      owners[vertex * OWNERS] = piece.bone;
      weights[vertex * OWNERS] = 1;
    }
    return { id: `piece:${piece.id}`, ramp: piece.ramp, inkGroup: piece.inkGroup, inkClass: piece.ramp, isShiny: Boolean(piece.shiny), positions: placedPoints(built.positions, matrices, at), normals, indices, owners, weights, locked: new Uint8Array(count).fill(1) };
  };

  /**
   * Layers as one mesh for `Kit.sculpt.simplify`: their triangles end to end, each numbered with its layer
   * (`paints`). A paint and the layer it was cut out of (`on`) become one surface again: the vertices they
   * have on the cut, the same in both, are one vertex here, so nothing done to the mesh can part them.
   * @param {SculptLayer[]} layers
   * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array, owners: Uint16Array, weights: Float32Array, faceShare: Float32Array, locked: Uint8Array, paints: Uint16Array}}
   * @complexity O(vertices + triangles)
   */
  const joinLayers = (layers) => {
    const canvases = new Set(layers.map((layer) => layer.on).filter(Boolean));
    /** Per canvas: the vertices of it and of its paints so far, by where they are. */
    const placedOn = new Map();
    let vertexCount = 0;
    /** Per layer: the number each of its vertices has in the whole. */
    const numbersOf = layers.map((layer) => {
      const count = layer.positions.length / VECTOR;
      const numbers = new Uint32Array(count);
      const canvas = layer.on || (canvases.has(layer) ? layer : null);
      if (!canvas) {
        for (let vertex = 0; vertex < count; vertex++) numbers[vertex] = vertexCount++;
        return numbers;
      }
      const placed = placedOn.get(canvas) || new Map();
      placedOn.set(canvas, placed);
      // A layer's own vertices are never made one with each other (two may share a place where a surface pinches):
      // they are looked up among those of the layers before it, and added only once the whole layer is numbered.
      const keys = Array.from({ length: count }, (_unused, vertex) => `${layer.positions[vertex * VECTOR]},${layer.positions[vertex * VECTOR + 1]},${layer.positions[vertex * VECTOR + 2]}`);
      keys.forEach((key, vertex) => (numbers[vertex] = placed.has(key) ? placed.get(key) : vertexCount++));
      keys.forEach((key, vertex) => placed.has(key) || placed.set(key, numbers[vertex]));
      return numbers;
    });
    const faceCount = layers.reduce((sum, layer) => sum + layer.indices.length / VECTOR, 0);
    const whole = {
      positions: new Float32Array(vertexCount * VECTOR),
      normals: new Float32Array(vertexCount * VECTOR),
      indices: new Uint32Array(faceCount * VECTOR),
      owners: new Uint16Array(vertexCount * OWNERS),
      weights: new Float32Array(vertexCount * OWNERS),
      faceShare: new Float32Array(vertexCount),
      locked: new Uint8Array(vertexCount),
      paints: new Uint16Array(faceCount),
    };
    let indexStart = 0;
    layers.forEach((layer, order) => {
      const numbers = numbersOf[order];
      // Hot loops over every vertex and corner: index writes only. A vertex two layers share is the same in both.
      for (let vertex = 0; vertex < numbers.length; vertex++) {
        const to = numbers[vertex];
        for (let axis = 0; axis < VECTOR; axis++) {
          whole.positions[to * VECTOR + axis] = layer.positions[vertex * VECTOR + axis];
          whole.normals[to * VECTOR + axis] = layer.normals[vertex * VECTOR + axis];
        }
        for (let slot = 0; slot < OWNERS; slot++) {
          whole.owners[to * OWNERS + slot] = layer.owners[vertex * OWNERS + slot];
          whole.weights[to * OWNERS + slot] = layer.weights[vertex * OWNERS + slot];
        }
        if (layer.faceShare) whole.faceShare[to] = layer.faceShare[vertex];
        if (layer.locked && layer.locked[vertex]) whole.locked[to] = 1;
      }
      for (let corner = 0; corner < layer.indices.length; corner++) whole.indices[indexStart + corner] = numbers[layer.indices[corner]];
      whole.paints.fill(order, indexStart / VECTOR, (indexStart + layer.indices.length) / VECTOR);
      indexStart += layer.indices.length;
    });
    return whole;
  };

  /**
   * What a figure draws: a joined mesh (`joinLayers`), as it is or made lighter, with each layer a run of
   * vertices and of triangles again. A vertex two layers shared while the mesh was worked on is two again, one
   * in each run and the same in both, because a vertex carries its layer's paint.
   * @param {Object} whole from `joinLayers`
   * @param {SculptLayer[]} layers the layers it was joined from, in that order
   * @param {?Object} light `Kit.sculpt.simplify` of `whole`, or null to draw `whole` as it is
   * @returns {SculptSurface}
   * @complexity O(vertices + triangles)
   */
  const surfaceOf = (whole, layers, light) => {
    const joined = light ? light.indices : whole.indices;
    const faceCount = joined.length / VECTOR;
    const paintOf = (face) => whole.paints[light ? light.faces[face] : face];
    /** Per vertex of the joined mesh: the layer it was last numbered for, and its number there. */
    const numberedFor = new Int32Array(light ? light.kept.length : whole.positions.length / VECTOR).fill(-1);
    const numberOf = new Uint32Array(numberedFor.length);
    /** Per vertex drawn: the vertex of `whole` it is. */
    const from = [];
    const corners = new Uint32Array(joined.length);
    let face = 0;
    // Triangles keep their order through `simplify`, so each layer's are still together and in the layers' order.
    const ranges = layers.map((layer, order) => {
      const [vertexStart, indexStart] = [from.length, face * VECTOR];
      for (; face < faceCount && paintOf(face) === order; face++) {
        for (let corner = face * VECTOR; corner < face * VECTOR + VECTOR; corner++) {
          const vertex = joined[corner];
          if (numberedFor[vertex] !== order) {
            numberedFor[vertex] = order;
            numberOf[vertex] = from.length;
            from.push(light ? light.kept[vertex] : vertex);
          }
          corners[corner] = numberOf[vertex];
        }
      }
      return { id: layer.id, vertexStart, vertexCount: from.length - vertexStart, indexStart, indexCount: face * VECTOR - indexStart };
    });
    const faceShare = Kit.sculpt.pick(whole.faceShare, 1, from);
    const paint = new Uint8Array(from.length * PAINT);
    ranges.forEach(({ vertexStart, vertexCount }, order) => {
      const layer = layers[order];
      // Only a body surface is lit as a face where the head moves it; paint and cloth on it are not.
      if (!layer.faceShare) faceShare.fill(0, vertexStart, vertexStart + vertexCount);
      for (let vertex = vertexStart; vertex < vertexStart + vertexCount; vertex++) {
        paint[vertex * PAINT] = layer.ramp;
        paint[vertex * PAINT + 1] = layer.inkGroup;
        paint[vertex * PAINT + 2] = layer.isShiny ? 1 : 0;
      }
    });
    return {
      positions: Kit.sculpt.pick(whole.positions, VECTOR, from),
      normals: Kit.sculpt.pick(whole.normals, VECTOR, from),
      indices: from.length > MOST_SHORT_INDEX ? corners : Uint16Array.from(corners),
      owners: Kit.sculpt.pick(whole.owners, OWNERS, from),
      weights: Kit.sculpt.pick(whole.weights, OWNERS, from),
      faceShare,
      paint,
      ranges,
      error: light ? light.distance : 0,
    };
  };

  /**
   * The layers of a surface as layers again: each a view of its run of the surface's arrays (nothing copied
   * but its triangles, which name its own vertices). A layer nothing is left of is not listed.
   * @param {SculptSurface} surface
   * @param {Array<{id: string, ramp: number, inkGroup: number, inkClass: number, isBody: boolean}>} kinds what each of the
   *   surface's first runs is (the sculpted layers; the rigid pieces joined after them are not layers)
   * @returns {SculptLayer[]}
   */
  const layerViews = (surface, kinds) =>
    surface.ranges
      .slice(0, kinds.length)
      .map((range, index) => {
        const { vertexStart, indexStart } = range;
        const vertexEnd = vertexStart + range.vertexCount;
        const { id, ramp, inkGroup, inkClass, isBody } = kinds[index];
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
        return isBody ? { ...view, faceShare: surface.faceShare.subarray(vertexStart, vertexEnd) } : view;
      })
      .filter((layer) => layer.indices.length > 0);

  /** The bytes of a surface's arrays: what a kept bake holds (its `layers` are views made when read, for tools and tests). */
  const bytesOf = (surface) => [surface.positions, surface.normals, surface.indices, surface.owners, surface.weights, surface.faceShare, surface.paint].reduce((sum, values) => sum + values.byteLength, 0);

  /**
   * Swings the bones of a draped object out to where they rest on what is under them (`Kit.drape.hangAngle`):
   * each bone that hangs to one side of the body bone it is mounted on turns about its own joint, away from
   * that bone, with whatever hangs from it. `hung` (bone matrices, the rest pose) is changed in place.
   */
  const hangBones = (plan, pieces, hung, rest, below, need, edge) => {
    const bones = [...new Set(pieces.map((piece) => piece.bone))].sort((first, second) => first - second);
    /** Per bone that hangs: the joint it hangs from and the unit direction it hangs in, as swung. */
    const hangs = new Map();
    bones.forEach((bone) => {
      // What it is mounted on: the nearest bone up the tree that is the body's own (a part's bones are named '<socket>/<bone>').
      let host = plan.parent[bone];
      while (host > 0 && plan.boneNames[host].includes('/')) host = plan.parent[host];
      if (host < 0) return;
      const joint = originOf(hung, bone);
      const mount = originOf(rest, host);
      const outward = [joint[0] - mount[0], 0, joint[2] - mount[2]];
      // Points all over the piece (a built shape alone has them only at its corners): the shape as a shell.
      const points = pieces
        .filter((piece) => piece.bone === bone)
        .flatMap((piece) => {
          const built = Kit.figure.buildShape(piece.shape, 'low');
          return Array.from(Kit.drape.shell({ positions: placedPoints(built.positions, hung, bone * MATRIX), indices: built.indices }, edge).positions);
        });
      const middle = [0, 1, 2].map((axis) => points.reduce((sum, value, index) => (index % VECTOR === axis ? sum + value : sum), 0) / (points.length / VECTOR) - joint[axis]);
      const length = Math.hypot(...middle);
      if (length < SCULPT.leastHang) return;
      const along = middle.map((value) => value / length);
      hangs.set(bone, { joint, along });
      const axis = Math.hypot(...outward) < Kit.drape.DRAPE.midline ? null : Kit.drape.swingAxis(along, outward);
      if (!axis) return;
      const angle = Kit.drape.hangAngle(points, joint, axis, below, need);
      Kit.drape.turnAbout(hung, bone, plan.subtreeEnd[bone], joint, axis, angle);
      // The way it hangs, swung with it (a direction: turned about the origin).
      const turned = Kit.drape.turnAbout(Float32Array.from({ length: MATRIX }, (_unused, index) => along[index] || 0), 0, 1, [0, 0, 0], axis, angle);
      const swung = [turned[0], turned[1], turned[2]];
      // Away from the body, across the hang: the way the swing itself carries the cloth.
      hangs.set(bone, { joint, along: swung, outward: [axis[1] * swung[2] - axis[2] * swung[1], axis[2] * swung[0] - axis[0] * swung[2], axis[0] * swung[1] - axis[1] * swung[0]] });
    });
    return hangs;
  };

  /**
   * The layers of the worn objects of a bake (bone rows with `wear`): one per object and paint. A solid is made
   * on a grid of its own in the sculpting pose and moved by its own bones. A drape is cloth (kit/drape.js): it
   * is made at rest, where it hangs as authored; swung out and laid over what is under it there (the body with
   * the garments on it, and the drapes of lower rank), so nothing under it shows through and it is hidden in
   * nothing; meshed on the grid where it is thick and as a thin shell where it is thinner than the grid can
   * hold; shared between the body solids beneath it and its own bone; and then carried into the sculpting pose.
   * @returns {Generator<undefined, Array<{layer: SculptLayer, pieces: Object[]}>, unknown>} yields between steps; returns the layers
   */
  function* wornSteps(bake, figureLayout, { cell, matrices, bodyPieces, limbLead, lifts }) {
    const { plan } = bake;
    const { wears, hangs, ranks, clings, covers } = wearOf(plan);
    const besideMask = Kit.body.roleMask([...SCULPT.beside]);
    /** Is a body bone under a drape whose row covers `mask` (0: every bone but the limbs that hang beside)? */
    const isUnder = (bone, mask) => (mask ? (plan.roles[bone] & mask) !== 0 : (plan.roles[bone] & besideMask) === 0);
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
    const allHosts = () => (hosts = hosts || bodyPieces.map((piece) => ({ piece, part: solidOf(piece, rest, limbLead) })));
    const hostsFor = (mask) => {
      const chosen = allHosts().filter(({ piece }) => mask === 0 || (plan.roles[piece.bone] & mask) !== 0);
      return (chosen.length ? chosen : allHosts()).map(({ part }) => part);
    };
    /** What the drapes made so far add to the pile: their solids as they hang, and their thickness on the body under them. */
    const laid = { solids: [], lift: 0 };
    const isDrape = (pieces) => wears[pieces[0].bone] === 'drape';
    // In rising rank (in the layout's order within a rank): solids with no rank first, then each drape over those
    // before it, and a solid with a rank set on the drapes under it.
    const ordered = [...objects].sort(([, first], [, second]) => ranks[first[0].bone] - ranks[second[0].bone]);
    const made = [];
    for (const [key, pieces] of ordered) {
      const draped = isDrape(pieces);
      const [lead] = pieces;
      const ownCell =
        cell ||
        Kit.sculpt.cellFor(
          pieces.map((piece) => solidOf(piece, draped ? rest : matrices, limbLead)),
          figureLayout.level
        );
      /** Half the least thickness the grid can hold. */
      const least = (ownCell * SCULPT.thickenedCells) / 2;
      const meshes = [];
      /** Per mesh: the bone that owns it whole, or -1 when its vertices take their owners from `gridSolids`. */
      const owns = [];
      let gridSolids = [];
      let keptPieces = [];
      let below = null;
      /** How far off the bare body this cloth lies where it rests on it: what is worn under it, its gap and its own thickness. */
      let restsAt = 0;
      let isSeated = false;
      if (draped) {
        // Where it hangs: the rest pose, each of its bones swung out to rest on what is under it.
        const hung = Float32Array.from(rest);
        const beneath = allHosts().filter(({ piece }) => isUnder(piece.bone, covers[lead.bone]));
        below = Kit.drape.under([...beneath.map(({ piece, part }) => ({ ...part, lift: lifts[piece.bone] + laid.lift })), ...laid.solids]);
        const authored = pieces.map((piece) => solidOf(piece, rest, limbLead));
        /** The cloth's own thickness where it is a thin sheet (0 for a solid, which has one side). */
        const thickness = Math.max(0, ...authored.map((part) => (part.thinness < least ? part.thinness * 2 : 0)));
        /** Cloth clears what is under it by a share of a cell: a coarse mesh cuts the corners of a fine curve. */
        const gap = Math.max(Kit.drape.DRAPE.gap, ownCell * SCULPT.gapCells);
        const hangOf = bodyPieces.length ? hangBones(plan, pieces, hung, rest, below, gap + thickness, ownCell * SCULPT.shellEdgeCells) : new Map();
        const thick = [];
        pieces.forEach((piece) => {
          const part = Object.assign(solidOf(piece, hung, limbLead), { group: 0, anchor: undefined, join: undefined });
          if (part.thinness >= least) return thick.push({ piece, part });
          // Thinner than the grid can hold: a shell of the shape as it is built, exactly as thin as authored.
          const built = Kit.figure.buildShape(piece.shape, figureLayout.level);
          const flipped = isMirror(hung, piece.bone * MATRIX) ? Uint32Array.from(built.indices, (_index, corner) => built.indices[corner - (corner % VECTOR) + [0, 2, 1][corner % VECTOR]]) : built.indices;
          const cloth = Kit.drape.shell({ positions: placedPoints(built.positions, hung, piece.bone * MATRIX), indices: flipped }, ownCell * SCULPT.shellEdgeCells);
          if (!cloth.indices.length) return undefined;
          const mesh = { ...cloth, normals: Kit.drape.smoothNormals(cloth.positions, cloth.indices) };
          const before = Float32Array.from(mesh.positions);
          if (bodyPieces.length && Kit.drape.settle(mesh, below, { gap, thickness: part.thinness * 2, hang: hangOf.get(piece.bone) })) laid.solids.push(movedCloud(mesh, before, ownCell * SCULPT.shellEdgeCells));
          meshes.push(mesh);
          owns.push(piece.bone);
          keptPieces.push(piece);
          laid.solids.push(part);
          return undefined;
        });
        if (thick.length) {
          gridSolids = thick.map(({ part }) => part);
          const mesh = yield* Kit.sculpt.surfaceSteps(yield* Kit.sculpt.sampleSteps(gridSolids, { cell: ownCell }));
          if (mesh.indices.length) {
            const before = Float32Array.from(mesh.positions);
            if (bodyPieces.length && Kit.drape.settle(mesh, below, { gap, hang: hangOf.get(lead.bone) })) laid.solids.push(movedCloud(mesh, before, ownCell * NET_EDGE_CELLS));
            // Hung all round the body (no one side to swing to): what it encloses is under whatever is laid over it.
            const hang = hangOf.get(lead.bone);
            if (hang && !hang.outward) laid.solids.push(Kit.drape.round(mesh.positions, hang.joint, hang.along, ownCell * NET_EDGE_CELLS));
            meshes.unshift(mesh);
            owns.unshift(-1);
            keptPieces = [...thick.map(({ piece }) => piece), ...keptPieces];
            laid.solids.push(...gridSolids);
          }
        }
        restsAt = laid.lift + thickness + gap + Math.max(0, ...beneath.map(({ piece }) => lifts[piece.bone]));
        laid.lift += thickness + gap;
      } else {
        // Worn over cloth already laid: made at rest, moved out until it sits on that cloth, and carried into the bind pose.
        isSeated = ranks[lead.bone] > 0 && laid.solids.length > 0;
        let placed = matrices;
        if (isSeated) {
          placed = Float32Array.from(rest);
          const corners = pieces.flatMap((piece) => Array.from(placedPoints(Kit.figure.buildShape(piece.shape, 'low').positions, rest, piece.bone * MATRIX)));
          const middle = [0, 1, 2].map((axis) => corners.reduce((sum, value, at) => (at % VECTOR === axis ? sum + value : sum), 0) / (corners.length / VECTOR));
          const outward = [0, 0, 0];
          Kit.drape.under(allHosts().map(({ part }) => part)).slope(middle[0], middle[1], middle[2], outward);
          // Its outer half is what must show: cloth may pass through the half against the body, as a strap would hold it there.
          const outer = [];
          for (let at = 0; at < corners.length; at += VECTOR) {
            if ((corners[at] - middle[0]) * outward[0] + (corners[at + 1] - middle[1]) * outward[1] + (corners[at + 2] - middle[2]) * outward[2] >= 0) outer.push(corners[at], corners[at + 1], corners[at + 2]);
          }
          const shift = Math.hypot(...outward) > 0 ? Kit.drape.seat(outer, outward, Kit.drape.under(laid.solids)) : 0;
          pieces.forEach((piece) => outward.forEach((part, axis) => (placed[piece.bone * MATRIX + MOVE + axis] += part * shift)));
        }
        const kept = [];
        pieces.forEach((piece) => {
          const part = fittedSolid(piece, placed, limbLead, ownCell);
          // An object is one thing: its solids blend wherever they meet, and it joins nothing else.
          if (part) kept.push({ piece, part: Object.assign(part, { group: 0, anchor: undefined, join: undefined }) });
        });
        if (!kept.length) continue;
        gridSolids = kept.map(({ part }) => part);
        const mesh = yield* Kit.sculpt.surfaceSteps(yield* Kit.sculpt.sampleSteps(gridSolids, { cell: ownCell }));
        if (mesh.indices.length) {
          meshes.push(mesh);
          owns.push(-1);
          keptPieces = kept.map(({ piece }) => piece);
        }
      }
      if (!meshes.length) continue;
      yield undefined;
      const mesh = joinedMesh(meshes, owns);
      // Its own bones: a shell is its bone's whole; a grid's vertices belong to the solids they lie on.
      const own = gridSolids.length ? Kit.sculpt.weights(mesh.positions, gridSolids, { spread: SCULPT.weightSpread, reach: ownCell }) : null;
      let skin = own;
      if (!own || meshes.length > 1) {
        skin = own || { owners: new Uint16Array(mesh.tagOf.length * OWNERS), weights: new Float32Array(mesh.tagOf.length * OWNERS) };
        mesh.tagOf.forEach((bone, vertex) => {
          if (bone < 0) return;
          skin.owners.fill(0, vertex * OWNERS, vertex * OWNERS + OWNERS);
          skin.weights.fill(0, vertex * OWNERS, vertex * OWNERS + OWNERS);
          skin.owners[vertex * OWNERS] = bone;
          skin.weights[vertex * OWNERS] = 1;
        });
      }
      if (draped && bodyPieces.length) {
        // The body beneath carries the cloth where it lies on it; where it hangs free it rides its own bone.
        const carriers = hostsFor(hangs[lead.bone]);
        const ownBone = Uint16Array.from(mesh.tagOf, (_bone, vertex) => skin.owners[vertex * OWNERS]);
        skin = Kit.sculpt.weights(mesh.positions, carriers, { spread: SCULPT.drapeSpread, reach: Infinity, sharpness: SCULPT.drapeSharpness });
        Kit.drape.ride(skin, mesh.positions, ownBone, Kit.drape.under(carriers).distance, { clings: clings[lead.bone], contact: restsAt + Kit.drape.DRAPE.contact });
      }
      // Made at rest: carried into the pose the skeleton is bound in.
      if (draped || isSeated) carry(mesh, skin, rest, matrices);
      const { positions, normals, indices } = mesh;
      made.push({ layer: { id: `worn:${key}`, ramp: lead.ramp, inkGroup: lead.inkGroup, inkClass: lead.ramp, positions, normals, indices, ...skin }, pieces: keptPieces });
      yield undefined;
    }
    return made;
  }

  Kit.figure = Object.assign(Kit.figure || {}, { SCULPT, paintedOn, uncovered, restMatrices, limbsOf, spreadPose, limbClearance, sculptSignature, sculptCache, sculptLayers, sculptTask });
})();
