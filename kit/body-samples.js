/**
 * Kit body samples: three deliberately different body plans (a biped, a quadruped, a fish), four parts (a
 * one-bone sword with grip and gem sockets, a ruby, a hat, a pair of wings) and a small family of species over
 * them, all as data. They are the proof that one abstraction covers different shapes, the fixtures of the unit
 * tests and the bench, and a starting point to copy when writing a real catalogue.
 *
 * Owns:  `Kit.body.samples.PLANS`, `PARTS`, `PALETTES`, `NODES`, `TRAITS` and `CATALOG` (the five together,
 *        ready for `Kit.body.catalog`).
 * Does not own: any behaviour. There is no code here beyond freezing the tables.
 *
 * A bone's `girth` is its mass data (kit/dynamics.js reads it) and is lean; what is drawn is its `shape` row, a
 * stylised solid stated beside it (`drawn`, `flattened`, `fin` below), so every plan is presentable as it stands.
 *
 * Conventions (kit/body-plan.js): metres, +Y up, +Z forward, +X the body's left. Every plan starts with a
 * `ground` bone at the origin, so a `size` dial on the root scales the whole body about the point it stands on.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * The point of a biped's ear: `stub` metres long on the plan (hidden inside the ear), and the range of the dial
   * that multiplies it for the elf and its variants.
   */
  const EAR_POINT = Object.freeze({ stub: 0.007, least: 5, most: 9, usual: 7 });
  /** How thick a fin is drawn, metres: a blade of flesh with a rounded edge, not a card. */
  const FIN_DEPTH = 0.03;
  /** The role that goes with a side suffix: 'Left' -> 'left'. */
  const sideRoles = (side) => (side === 'Left' ? 'left' : 'right');

  /** A drawn limb or trunk segment: a capsule of this radius (metres), narrowing to `taper` of it at a tail's end. */
  const drawn = (radius, taper) => ({ kind: 'capsule', radius, ...(taper === undefined ? {} : { taper }) });
  /**
   * The same, pressed to `depth` of its width front to back (a torso) or `width` of it side to side (a fish).
   * @param {number} radius metres
   * @param {{width?: number, depth?: number, taper?: number}} [press]
   * @returns {Object} a shape row
   */
  const flattened = (radius, { width = 1, depth = 1, taper } = {}) => ({ ...drawn(radius, taper), scale: [width, 1, depth] });
  /** A shape turned about the bone's long axis from a rounded profile [[radius, along], ...] (a head, a muzzle, a hat). */
  const round = (profile) => ({ kind: 'lathe', profile, smooth: true });
  /** A fin or wing with thickness: an outline [[across, along], ...] in the plane of the bone's long axis and `across`. */
  const fin = (outline, across, depth = FIN_DEPTH) => ({ kind: 'extrude', outline, depth, across });
  const { face } = Kit.body;
  /** How much larger than the face vocabulary's reference head each plan's head is. */
  const FACE_SCALE = Object.freeze({ biped: 1.25, quadruped: 1.2, fish: 1.3 });

  /** The three bones of a biped arm (and, below, leg) for one side; `side` is 'Left' or 'Right', `sign` +1 or -1 on X. */
  const bipedArm = (side, sign) => [
    {
      name: `upperArm${side}`,
      parent: 'chest',
      at: [0.2 * sign, 0.16, 0],
      roles: ['arm', 'primary', sideRoles(side)],
      girth: 0.07,
      shape: drawn(0.062, 0.74),
      limits: [
        [-170, 60],
        [-90, 90],
        [-120, 120],
      ],
      paint: 'cloth',
    },
    // An elbow folds the forearm forwards: a hinge about X that only turns the negative way.
    {
      name: `forearm${side}`,
      parent: `upperArm${side}`,
      at: [0, -0.28, 0],
      roles: ['arm', 'primary', sideRoles(side)],
      girth: 0.06,
      shape: drawn(0.05, 0.72),
      joint: 'hinge',
      limits: [
        [-150, 0],
        [0, 0],
        [0, 0],
      ],
      paint: 'skin',
    },
    { name: `hand${side}`, parent: `forearm${side}`, at: [0, -0.26, 0], tail: [0, -0.1, 0], roles: ['arm', 'hand', 'primary', 'tip', sideRoles(side)], girth: 0.05, shape: { kind: 'sphere', radius: 0.066, at: [0, -0.055, 0.004], scale: [0.5, 1.2, 0.9] }, paint: 'skin' },
  ];
  const bipedLeg = (side, sign) => [
    {
      name: `thigh${side}`,
      parent: 'pelvis',
      at: [0.1 * sign, -0.05, 0],
      roles: ['leg', 'primary', sideRoles(side)],
      girth: 0.1,
      shape: drawn(0.098, 0.7),
      limits: [
        [-120, 45],
        [-40, 40],
        [-45, 45],
      ],
      paint: 'cloth',
    },
    // A knee folds the shin backwards: the default hinge, 0 to 150 degrees about X.
    { name: `shin${side}`, parent: `thigh${side}`, at: [0, -0.45, 0], roles: ['leg', 'primary', sideRoles(side)], girth: 0.08, shape: drawn(0.074, 0.62), joint: 'hinge', paint: 'cloth' },
    {
      name: `foot${side}`,
      parent: `shin${side}`,
      at: [0, -0.42, 0],
      tail: [0, 0, 0.16],
      roles: ['leg', 'foot', 'primary', 'tip', sideRoles(side)],
      girth: 0.06,
      // A rounded shoe: a ball pressed flat and drawn out forwards.
      shape: { kind: 'sphere', radius: 0.082, at: [0, 0.008, 0.062], scale: [0.72, 0.62, 1.65] },
    },
  ];
  /** A quadruped leg; `end` is 'front' or 'hind', `hip` the bone it hangs from. */
  const quadrupedLeg = (end, hip, side, sign) => {
    const prefix = `${end}${side}`;
    const roles = ['leg', end, sideRoles(side), ...(end === 'hind' ? ['primary'] : [])];
    return [
      { name: `${prefix}Upper`, parent: hip, at: [0.12 * sign, -0.06, 0], roles, girth: 0.08, shape: drawn(end === 'hind' ? 0.086 : 0.066, 0.58) },
      { name: `${prefix}Lower`, parent: `${prefix}Upper`, at: [0, -0.27, 0], roles, girth: 0.06, shape: drawn(0.04, 0.85) },
      { name: `${prefix}Paw`, parent: `${prefix}Lower`, at: [0, -0.25, 0], tail: [0, 0, 0.08], roles: [...roles, 'foot', 'tip'], girth: 0.05, shape: { kind: 'sphere', radius: 0.054, at: [0, -0.002, 0.036], scale: [0.92, 0.6, 1.35] } },
    ];
  };

  /**
   * Body plans by id, as `BodyPlanSpec` rows without their id (the catalogue adds it).
   * biped: 18 bones, hands that grip. quadruped: 23 bones, four legs, a tail, a mouth that grips. fish: 11 bones,
   * no limbs at all: a spine, fins and a tail.
   * @type {Object<string, {bones: Object[], sockets: Object[]}>}
   */
  const PLANS = {
    biped: {
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free', shape: { kind: 'none' } },
        { name: 'pelvis', parent: 'ground', at: [0, 0.92, 0], roles: ['spine'], girth: 0.16, shape: flattened(0.162, { depth: 0.74 }), joint: 'free', paint: 'cloth' },
        {
          name: 'waist',
          parent: 'pelvis',
          at: [0, 0.18, 0],
          roles: ['spine'],
          girth: 0.15,
          // Drawn in at the waist, between wider hips and a wider chest.
          shape: flattened(0.128, { depth: 0.74 }),
          limits: [
            [-30, 45],
            [-30, 30],
            [-25, 25],
          ],
          paint: 'cloth',
        },
        {
          name: 'chest',
          parent: 'waist',
          at: [0, 0.2, 0],
          roles: ['spine'],
          girth: 0.18,
          // A broad ribcage: the shoulders are its links out to the arms.
          shape: flattened(0.182, { depth: 0.66 }),
          limits: [
            [-20, 30],
            [-30, 30],
            [-20, 20],
          ],
          paint: 'cloth',
        },
        {
          name: 'neck',
          parent: 'chest',
          at: [0, 0.22, 0],
          roles: ['neck'],
          girth: 0.05,
          shape: drawn(0.052),
          limits: [
            [-40, 40],
            [-60, 60],
            [-30, 30],
          ],
          paint: 'skin',
        },
        {
          name: 'head',
          parent: 'neck',
          at: [0, 0.08, 0],
          tail: [0, 0.22, 0],
          roles: ['head'],
          girth: 0.16,
          limits: [
            [-30, 30],
            [-40, 40],
            [-20, 20],
          ],
          paint: 'skin',
          // A skull that narrows to a jaw and sits down over the neck, turned from one rounded profile.
          shape: round([
            [0.062, -0.03],
            [0.094, 0.025],
            [0.116, 0.1],
            [0.122, 0.165],
            [0.104, 0.225],
            [0.058, 0.262],
            [0, 0.27],
          ]),
        },
        ...bipedArm('Left', 1),
        ...bipedArm('Right', -1),
        ...bipedLeg('Left', 1),
        ...bipedLeg('Right', -1),
      ],
      sockets: [
        { name: 'headTop', bone: 'head', type: 'headTop', at: [0, 0.24, 0], label: 'Headwear' },
        { name: 'handLeft', bone: 'handLeft', type: 'grip', at: [0, -0.06, 0] },
        { name: 'handRight', bone: 'handRight', type: 'grip', at: [0, -0.06, 0] },
        { name: 'back', bone: 'chest', type: 'back', at: [0, 0.06, -0.12] },
      ],
    },
    quadruped: {
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free', shape: { kind: 'none' } },
        { name: 'hips', parent: 'ground', at: [0, 0.58, -0.35], roles: ['spine'], girth: 0.14, shape: flattened(0.13, { width: 0.84 }), joint: 'free', paint: 'skin' },
        { name: 'belly', parent: 'hips', at: [0, 0, 0.35], roles: ['spine'], girth: 0.17, shape: flattened(0.118, { width: 0.86 }) },
        { name: 'shoulders', parent: 'belly', at: [0, 0, 0.35], roles: ['spine'], girth: 0.16, shape: flattened(0.158, { width: 0.76 }) },
        { name: 'neck', parent: 'shoulders', at: [0, 0.14, 0.14], roles: ['neck'], girth: 0.08, shape: drawn(0.09, 0.82) },
        { name: 'head', parent: 'neck', at: [0, 0.1, 0.14], tail: [0, 0, 0.24], roles: ['head'],
          girth: 0.12,
          // A skull that steps down to a muzzle, turned about the bone (it points forward).
          shape: round([
            [0.06, -0.055],
            [0.098, 0.005],
            [0.096, 0.07],
            [0.064, 0.118],
            [0.052, 0.19],
            [0.044, 0.24],
            [0, 0.256],
          ]),
        },
        { name: 'jaw', parent: 'head', at: [0, -0.05, 0.06], tail: [0, 0, 0.16], roles: ['jaw'], girth: 0.04, shape: drawn(0.034, 0.7) },
        ...quadrupedLeg('front', 'shoulders', 'Left', 1),
        ...quadrupedLeg('front', 'shoulders', 'Right', -1),
        ...quadrupedLeg('hind', 'hips', 'Left', 1),
        ...quadrupedLeg('hind', 'hips', 'Right', -1),
        // A tail is loose: low stiffness and under-damped, so a spring or chain driving it wags.
        { name: 'tailBase', parent: 'hips', at: [0, 0.06, -0.1], roles: ['tail'], girth: 0.05, shape: drawn(0.036, 1.3), stiffness: 40, damping: 0.5, paint: 'skin' },
        { name: 'tailMiddle', parent: 'tailBase', at: [0, 0.04, -0.2], roles: ['tail'], girth: 0.04, shape: drawn(0.047, 0.9), stiffness: 30, damping: 0.4, paint: 'skin' },
        { name: 'tailEnd', parent: 'tailMiddle', at: [0, 0.03, -0.2], tail: [0, 0.02, -0.18], roles: ['tail', 'tip'], girth: 0.03, shape: drawn(0.042, 0.15), stiffness: 20, damping: 0.4, paint: 'skin' },
      ],
      sockets: [
        { name: 'headTop', bone: 'head', type: 'headTop', at: [0, 0.1, 0.06] },
        { name: 'mouth', bone: 'jaw', type: 'grip', at: [0, 0, 0.12] },
        { name: 'back', bone: 'belly', type: 'back', at: [0, 0.14, 0] },
      ],
    },
    fish: {
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free', shape: { kind: 'none' } },
        { name: 'trunk', parent: 'ground', at: [0, 0.5, 0], roles: ['spine'], girth: 0.16, shape: flattened(0.185, { width: 0.5 }), joint: 'free', paint: 'skin' },
        { name: 'head', parent: 'trunk', at: [0, 0, 0.24], tail: [0, 0, 0.2], roles: ['head'], girth: 0.13, shape: flattened(0.165, { width: 0.5, taper: 0.4 }) },
        { name: 'jaw', parent: 'head', at: [0, -0.05, 0.1], tail: [0, 0, 0.1], roles: ['jaw'], girth: 0.03, shape: drawn(0.034, 0.7) },
        { name: 'rear', parent: 'trunk', at: [0, 0, -0.24], roles: ['spine'], girth: 0.12, shape: flattened(0.155, { width: 0.46 }) },
        { name: 'tailRoot', parent: 'rear', at: [0, 0, -0.2], roles: ['tail'], girth: 0.07, shape: flattened(0.105, { width: 0.44 }) },
        { name: 'tailStalk', parent: 'tailRoot', at: [0, 0, -0.16], roles: ['tail'], girth: 0.04, shape: flattened(0.055, { width: 0.5 }) },
        {
          name: 'tailFin',
          parent: 'tailStalk',
          at: [0, 0, -0.12],
          tail: [0, 0, -0.22],
          roles: ['tail', 'tip'],
          girth: 0.2,
          shape: {
            kind: 'extrude',
            // A forked tail: an arrowhead cut in at the back.
            outline: [
              [0, 0],
              [0.12, -0.22],
              [0, -0.16],
              [-0.12, -0.22],
            ],
            depth: FIN_DEPTH,
          },
        },
        // Fins are flat outlines: the dorsal fin stands in the plane of the body, the side fins lie out from it.
        {
          name: 'dorsalFin',
          parent: 'trunk',
          at: [0, 0.14, -0.02],
          tail: [0, 0.16, -0.1],
          roles: ['fin'],
          girth: 0.02,
          shape: fin(
            [
              [0.14, -0.03],
              [-0.02, 0.16],
              [-0.17, 0.12],
              [-0.14, -0.03],
            ],
            'z'
          ),
        },
        {
          name: 'sideFinLeft',
          parent: 'trunk',
          at: [0.08, -0.04, 0.1],
          tail: [0.16, -0.06, -0.08],
          roles: ['fin', 'left', 'primary'],
          girth: 0.02,
          shape: fin(
            [
              [0.06, 0],
              [0.01, 0.22],
              [-0.14, 0.2],
              [-0.06, 0],
            ],
            'z'
          ),
        },
        {
          name: 'sideFinRight',
          parent: 'trunk',
          at: [-0.08, -0.04, 0.1],
          tail: [-0.16, -0.06, -0.08],
          roles: ['fin', 'right', 'primary'],
          girth: 0.02,
          shape: fin(
            [
              [0.06, 0],
              [0.01, -0.22],
              [-0.14, -0.2],
              [-0.06, 0],
            ],
            'z'
          ),
        },
      ],
      sockets: [{ name: 'back', bone: 'trunk', type: 'back', at: [0, 0.14, 0.06] }],
    },
  };

  /**
   * The faces of the plans, by plan: where each head keeps its features (`anchors`) and what every individual
   * carries there, through the shared face vocabulary (kit/body-face.js). The bare plans above stay bare (they
   * are fixtures); `PLANS.<plan>Faced` extends the same skeleton with its face, and is what the species are built on.
   * @type {Object<string, {anchors: Object, features: Object[]}>}
   */
  const FACES = {
    biped: {
    // A face through the shared vocabulary (kit/body-face.js): where this head keeps its features, then the
    // relief every biped has and the plainest eyes and mouth. The ear's point is a stub hidden in a round ear; the
      // pointed-eared species draw it out with a dial (`EAR_POINT`).
    anchors: face.anchors('head', { eye: { elevation: 3, spacing: 52 }, brow: { elevation: 20, spacing: 54 }, nose: { elevation: -14 }, mouth: { elevation: -33 }, ear: { elevation: -3, spacing: 176 }, cheek: { elevation: -22, spacing: 78 }, chin: { elevation: -53 } }),
    features: [
      ...face.dotEyes(0.019, { scale: FACE_SCALE.biped }),
      ...face.eyeSockets([0.03, 0.03], { scale: FACE_SCALE.biped }),
      ...face.lineMouth([0.036, 0.012], { scale: FACE_SCALE.biped }),
      ...face.lips([0.036, 0.012], { scale: FACE_SCALE.biped }),
      ...face.browRidge({ scale: FACE_SCALE.biped }),
      ...face.cheeks({ scale: FACE_SCALE.biped }),
      ...face.chin({ scale: FACE_SCALE.biped }),
      ...face.nose('straight', { scale: FACE_SCALE.biped }),
      ...face.ears({ height: 0.05, width: 0.03, point: { length: EAR_POINT.stub, back: 0.004, radius: 0.0085 } }, { scale: FACE_SCALE.biped }),
    ],
    },
    quadruped: {
    // The head points forward, so its features sit far round it: eyes on top of the skull, ears behind them,
    // a nose on the end of the muzzle. The same vocabulary, other anchors.
    anchors: face.anchors('head', { eye: { elevation: 52, spacing: 84, azimuth: 0 }, brow: { elevation: 62, spacing: 70 }, nose: { elevation: 0 }, mouth: { elevation: -18 }, ear: { elevation: 62, spacing: 250 }, cheek: { elevation: -10, spacing: 150 }, chin: { elevation: -40 } }),
    features: [
      ...face.dotEyes(0.016, { scale: FACE_SCALE.quadruped }),
      ...face.eyeSockets([0.022, 0.022], { scale: FACE_SCALE.quadruped, depth: 0.002 }),
      ...face.browRidge({ scale: FACE_SCALE.quadruped }),
      // A dark nose pad on the end of the muzzle, over a rounded button.
      ...face.nose('button', { scale: FACE_SCALE.quadruped }),
      ...face.dotEyes(0.02, { scale: FACE_SCALE.quadruped }).map((feature) => ({ ...feature, id: 'nosePad', anchor: 'nose', spacing: undefined, glow: false, elevation: 4, frames: { rest: [feature.frames.open[0]] }, rest: 'rest' })),
      // Pricked ears: a broad plate each, drawn to a point, standing well off the skull.
      ...face.ears({ height: 0.06, width: 0.05, thickness: 0.014, flare: 62, lobe: false, point: { length: 0.07, back: 0.012, radius: 0.016 } }, { scale: FACE_SCALE.quadruped }),
    ],
    },
    fish: {
    // Eyes on the sides of the head and a gill line pressed in behind each: the face vocabulary on a fish.
    anchors: face.anchors('head', { eye: { elevation: 14, spacing: 156 }, cheek: { elevation: -4, spacing: 236 }, nose: { elevation: 0 }, mouth: { elevation: -10 }, ear: { elevation: 0, spacing: 180 }, brow: { elevation: 30, spacing: 150 }, chin: { elevation: -40 } }),
    features: [
      ...face.dotEyes(0.024, { scale: FACE_SCALE.fish }),
      { id: 'gill', anchor: 'cheek', size: [0.03, 0.2], carve: true, blend: 0.008, shape: { kind: 'sphere', radius: 0.1, scale: [0.14, 1, 0.16], at: [0, 0, 0.004] } },
    ],
    },
  };
  Object.keys(FACES).forEach((id) => {
    PLANS[`${id}Faced`] = { extends: id, ...FACES[id] };
  });

  /**
   * A left wing's arm blade, [up, out] from the shoulder, and its hand blade, [out, up] from the wrist; the right
   * wing mirrors `out`. The trailing edge of each is cut into feather tips.
   */
  /** How thick a wing is drawn, metres: a mass of feathers, not a card. */
  const WING_DEPTH = 0.046;
  /** Degrees each wing hangs down from the shoulder at rest, so the wings are folded behind the back until they are spread. */
  const WING_FOLD = 30;
  const WING_ARM = [
    [0.03, 0],
    [0.27, 0.44],
    [0.16, 0.46],
    [0.02, 0.44],
    [-0.07, 0.4],
    [-0.09, 0.31],
    [-0.17, 0.3],
    [-0.15, 0.2],
    [-0.22, 0.18],
    [-0.19, 0.06],
  ];
  const WING_HAND = [
    [-0.02, 0.05],
    [0.06, 0.02],
    [0.3, -0.34],
    [0.2, -0.4],
    [0.17, -0.3],
    [0.08, -0.37],
    [0.06, -0.25],
    [-0.04, -0.31],
    [-0.03, -0.17],
    [-0.1, -0.21],
    [-0.1, -0.06],
  ];

  /**
   * Parts by id, as `PartSpec` rows without their id.
   * sword: one bone; it is held by its `grip` socket and offers a `gem` socket. ruby: goes in a gem socket.
   * hat: goes on a head. wings: go on a back and bring the `wing` role, so their wearer gains the `wings` capability.
   * @type {Object<string, Object>}
   */
  const PARTS = {
    sword: {
      fits: ['grip'],
      anchor: 'grip',
      bones: [
        {
          name: 'blade',
          tail: [0, 0, 0.85],
          roles: ['root'],
          girth: 0.03,
          mass: 1.2,
          joint: 'fixed',
          paint: 'metal',
          shape: {
            kind: 'extrude',
            outline: [
              [-0.025, 0.12],
              [0.025, 0.12],
              [0.02, 0.78],
              [0, 0.85],
              [-0.02, 0.78],
            ],
            depth: 0.008,
          },
        },
      ],
      sockets: [
        { name: 'grip', bone: 'blade', type: 'grip', at: [0, 0, 0.08] },
        { name: 'gem', bone: 'blade', type: 'gem', at: [0, 0, -0.03] },
      ],
    },
    ruby: { fits: ['gem'], bones: [{ name: 'stone', tail: [0, 0, -0.05], roles: ['root'], girth: 0.05, joint: 'fixed', shape: { kind: 'sphere', radius: 0.025 } }] },
    hat: {
      fits: ['headTop'],
      bones: [
        {
          name: 'brim',
          roles: ['root'],
          tail: [0, 0.04, 0],
          girth: 0.3,
          joint: 'fixed',
          paint: 'cloth',
          shape: {
            kind: 'lathe',
            profile: [
              [0.17, 0],
              [0.175, 0.012],
              [0.16, 0.024],
              [0.09, 0.04],
            ],
            smooth: true,
          },
          wear: 'solid',
        },
        {
          name: 'crown',
          parent: 'brim',
          at: [0, 0.04, 0],
          tail: [0, 0.16, 0],
          girth: 0.16,
          joint: 'fixed',
          paint: 'cloth',
          shape: {
            kind: 'lathe',
            profile: [
              [0.09, 0],
              [0.08, 0.13],
              [0.04, 0.16],
              [0, 0.16],
            ],
            smooth: true,
          },
          wear: 'solid',
        },
      ],
    },
    wings: {
      fits: ['back'],
      bones: [
        // Each wing is two flat blades: an arm out to the wrist, and a hand that sweeps down from it.
        { name: 'wingLeft', at: [0.06, 0, 0], turn: [0, 0, -WING_FOLD], roles: ['wing', 'left'], girth: 0.04, shape: fin(WING_ARM.map(([up, out]) => [up, out]), 'y', WING_DEPTH), wear: 'solid' },
        { name: 'wingLeftTip', parent: 'wingLeft', at: [0.42, 0.22, -0.06], tail: [0.3, -0.34, -0.04], roles: ['wing', 'left', 'tip'], girth: 0.03, shape: fin(WING_HAND.map(([out, up]) => [out, up]), 'x', WING_DEPTH), wear: 'solid' },
        { name: 'wingRight', at: [-0.06, 0, 0], turn: [0, 0, WING_FOLD], roles: ['wing', 'right'], girth: 0.04, shape: fin(WING_ARM.map(([up, out]) => [up, -out]), 'y', WING_DEPTH), wear: 'solid' },
        { name: 'wingRightTip', parent: 'wingRight', at: [-0.42, 0.22, -0.06], tail: [-0.3, -0.34, -0.04], roles: ['wing', 'right', 'tip'], girth: 0.03, shape: fin(WING_HAND.map(([out, up]) => [-out, up]), 'x', WING_DEPTH), wear: 'solid' },
      ],
    },
  };

  /**
   * Palettes by name: each a list of ramps (shades dark to light with a hue drift, built by `Kit.palette.ramp`).
   * A species points a colour channel at a palette; an individual stores which ramp it uses.
   * @type {Object<string, Array<{id: string, shades: string[]}>>}
   */
  const PALETTES = {
    skinTones: [
      Kit.palette.ramp('umber', 0.06, { saturation: 0.45 }),
      Kit.palette.ramp('sand', 0.09, { saturation: 0.4, lightest: 0.9 }),
      Kit.palette.ramp('clay', 0.03, { saturation: 0.5, darkest: 0.14 }),
      Kit.palette.ramp('moss', 0.3, { saturation: 0.3 }),
      Kit.palette.ramp('dusk', 0.66, { saturation: 0.3 }),
    ],
    furs: [
      Kit.palette.ramp('chestnut', 0.07),
      Kit.palette.ramp('soot', 0.6, { saturation: 0.06 }),
      Kit.palette.ramp('cream', 0.11, { saturation: 0.3, lightest: 0.92 }),
      Kit.palette.ramp('rust', 0.04, { saturation: 0.65 }),
    ],
    scales: [
      Kit.palette.ramp('ember', 0.06, { saturation: 0.8 }),
      Kit.palette.ramp('lagoon', 0.58, { saturation: 0.7 }),
      Kit.palette.ramp('pearl', 0.62, { saturation: 0.1, lightest: 0.94 }),
      Kit.palette.ramp('kelp', 0.45, { saturation: 0.45 }),
    ],
    dyes: [Kit.palette.ramp('indigo', 0.62), Kit.palette.ramp('madder', 0.97), Kit.palette.ramp('woad', 0.36, { saturation: 0.4 }), Kit.palette.ramp('saffron', 0.13, { saturation: 0.7 })],
    metals: [Kit.palette.ramp('steel', 0.58, { saturation: 0.08, lightest: 0.92 }), Kit.palette.ramp('bronze', 0.09, { saturation: 0.5 })],
  };

  /** Dials written against roles, so the same rows serve every plan that has the role. */
  const SHARED_DIALS = {
    height: { min: 0.85, max: 1.2, affects: [{ roles: ['root'], channel: 'size' }] },
    build: { min: 0.8, max: 1.3, affects: [{ roles: ['spine'], channel: 'girth' }] },
    headSize: { min: 0.9, max: 1.3, affects: [{ roles: ['head'], channel: 'size' }] },
  };
  const LIMB_DIALS = {
    legLength: { min: 0.85, max: 1.2, affects: [{ roles: ['leg'], channel: 'length' }] },
  };

  /**
   * Traits: named mix-ins a node can pull in. `armed` and `duelist` both write the handRight socket, so a node
   * that lists both is refused (the unit tests rely on that).
   * @type {Object<string, {set: Object}>}
   */
  const TRAITS = {
    slender: { set: { dials: { build: { max: 1, default: 0.9 } } } },
    winged: { set: { fills: { back: { wings: 1 } } } },
    armed: { set: { fills: { handRight: { sword: 3, none: 1 }, 'handRight/gem': { ruby: 1, none: 2 } } } },
    duelist: { set: { fills: { handRight: { sword: 1 } } } },
  };

  /**
   * The lineage: creature (archetype) -> humanoid / beast / swimmer (archetypes with a plan) -> species (nodes
   * with a `code`) -> variants (species that inherit from a species). `humanoid` owns the limit on height, which
   * every humanoid species and variant below it is held to.
   * @type {Object<string, {parent?: string, traits?: string[], set?: Object, limits?: Object}>}
   */
  const NODES = {
    creature: { set: { dials: SHARED_DIALS, colors: { skin: 'skinTones' } } },
    humanoid: {
      parent: 'creature',
      set: {
        plan: 'bipedFaced',
        dials: { ...LIMB_DIALS, armLength: { min: 0.9, max: 1.15, affects: [{ roles: ['arm'], channel: 'length' }] } },
        colors: { cloth: 'dyes', metal: 'metals' },
        // A roll rule (kit/body-recipe.js): cloth is rolled to stand apart from the skin it lies against. These
        // dyes are all of one value, so here it is the hue that tells them from a skin.
        contrast: [{ between: ['skin', 'cloth'], lightness: 0.12, hue: 60 }],
        fills: { headTop: { hat: 1, none: 3 } },
      },
      limits: { 'dials.height': { min: 0.6, max: 1.4 } },
    },
    human: { parent: 'humanoid', traits: ['armed'], set: { code: 1 } },
    elf: { parent: 'humanoid', traits: ['slender'], set: { code: 2, dials: { height: { min: 1, max: 1.3 }, legLength: { min: 1, max: 1.25 }, earPoint: { min: EAR_POINT.least, max: EAR_POINT.most, default: EAR_POINT.usual, affects: [{ feature: 'earTip', param: 'size.1' }] } } } },
    seraph: { parent: 'elf', traits: ['winged'], set: { code: 3 } },
    beast: {
      parent: 'creature',
      set: { plan: 'quadrupedFaced', dials: { ...LIMB_DIALS, tailLength: { min: 0.6, max: 1.6, shape: 'uniform', affects: [{ roles: ['tail'], channel: 'length' }] } }, colors: { skin: 'furs' } },
    },
    hound: { parent: 'beast', set: { code: 4, fills: { mouth: { sword: 1, none: 9 } } } },
    swimmer: { parent: 'creature', set: { plan: 'fishFaced', dials: { finSize: { min: 0.7, max: 1.6, affects: [{ roles: ['fin'], channel: 'size' }] } }, colors: { skin: 'scales' } } },
    carp: { parent: 'swimmer', set: { code: 5 } },
  };

  const freezeDeep = (value) => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  };

  Kit.body = Object.assign(Kit.body || {}, {
    samples: freezeDeep({ PLANS, PARTS, PALETTES, NODES, TRAITS, CATALOG: { plans: PLANS, parts: PARTS, palettes: PALETTES, nodes: NODES, traits: TRAITS } }),
  });
})();
