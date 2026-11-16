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
  /** A flat fin or wing: an outline [[across, along], ...] in the plane of the bone's long axis and `across`. */
  const fin = (outline, across, depth = 0.014) => ({ kind: 'extrude', outline, depth, across });

  /** The three bones of a biped arm (and, below, leg) for one side; `side` is 'Left' or 'Right', `sign` +1 or -1 on X. */
  const bipedArm = (side, sign) => [
    {
      name: `upperArm${side}`,
      parent: 'chest',
      at: [0.2 * sign, 0.16, 0],
      roles: ['arm', 'primary', sideRoles(side)],
      girth: 0.07,
      shape: drawn(0.056),
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
      shape: drawn(0.047),
      joint: 'hinge',
      limits: [
        [-150, 0],
        [0, 0],
        [0, 0],
      ],
      paint: 'skin',
    },
    { name: `hand${side}`, parent: `forearm${side}`, at: [0, -0.26, 0], tail: [0, -0.1, 0], roles: ['arm', 'hand', 'primary', 'tip', sideRoles(side)], girth: 0.05, shape: drawn(0.046, 0.8), paint: 'skin' },
  ];
  const bipedLeg = (side, sign) => [
    {
      name: `thigh${side}`,
      parent: 'pelvis',
      at: [0.1 * sign, -0.05, 0],
      roles: ['leg', 'primary', sideRoles(side)],
      girth: 0.1,
      shape: drawn(0.088),
      limits: [
        [-120, 45],
        [-40, 40],
        [-45, 45],
      ],
      paint: 'cloth',
    },
    // A knee folds the shin backwards: the default hinge, 0 to 150 degrees about X.
    { name: `shin${side}`, parent: `thigh${side}`, at: [0, -0.45, 0], roles: ['leg', 'primary', sideRoles(side)], girth: 0.08, shape: drawn(0.066), joint: 'hinge', paint: 'cloth' },
    {
      name: `foot${side}`,
      parent: `shin${side}`,
      at: [0, -0.42, 0],
      tail: [0, 0, 0.16],
      roles: ['leg', 'foot', 'primary', 'tip', sideRoles(side)],
      girth: 0.06,
      // A rounded shoe: a ball pressed flat and drawn out forwards.
      shape: { kind: 'sphere', radius: 0.075, at: [0, 0.005, 0.06], scale: [0.72, 0.6, 1.6] },
    },
  ];
  /** A quadruped leg; `end` is 'front' or 'hind', `hip` the bone it hangs from. */
  const quadrupedLeg = (end, hip, side, sign) => {
    const prefix = `${end}${side}`;
    const roles = ['leg', end, sideRoles(side), ...(end === 'hind' ? ['primary'] : [])];
    return [
      { name: `${prefix}Upper`, parent: hip, at: [0.12 * sign, -0.06, 0], roles, girth: 0.08, shape: drawn(0.058) },
      { name: `${prefix}Lower`, parent: `${prefix}Upper`, at: [0, -0.27, 0], roles, girth: 0.06, shape: drawn(0.038) },
      { name: `${prefix}Paw`, parent: `${prefix}Lower`, at: [0, -0.25, 0], tail: [0, 0, 0.08], roles: [...roles, 'foot', 'tip'], girth: 0.05, shape: drawn(0.04, 0.85) },
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
        { name: 'pelvis', parent: 'ground', at: [0, 0.92, 0], roles: ['spine'], girth: 0.16, shape: flattened(0.15, { depth: 0.72 }), joint: 'free', paint: 'cloth' },
        {
          name: 'waist',
          parent: 'pelvis',
          at: [0, 0.18, 0],
          roles: ['spine'],
          girth: 0.15,
          shape: flattened(0.135, { depth: 0.72 }),
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
          shape: flattened(0.168, { depth: 0.68 }),
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
          shape: drawn(0.055),
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
          shape: { kind: 'sphere', radius: 0.12, at: [0, 0.11, 0] },
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
        { name: 'hips', parent: 'ground', at: [0, 0.58, -0.35], roles: ['spine'], girth: 0.14, shape: drawn(0.105), joint: 'free', paint: 'skin' },
        { name: 'belly', parent: 'hips', at: [0, 0, 0.35], roles: ['spine'], girth: 0.17, shape: drawn(0.112) },
        { name: 'shoulders', parent: 'belly', at: [0, 0, 0.35], roles: ['spine'], girth: 0.16, shape: drawn(0.125) },
        { name: 'neck', parent: 'shoulders', at: [0, 0.14, 0.14], roles: ['neck'], girth: 0.08, shape: drawn(0.075) },
        { name: 'head', parent: 'neck', at: [0, 0.1, 0.14], tail: [0, 0, 0.24], roles: ['head'], girth: 0.12, shape: drawn(0.085, 0.5) },
        { name: 'jaw', parent: 'head', at: [0, -0.05, 0.06], tail: [0, 0, 0.16], roles: ['jaw'], girth: 0.04, shape: drawn(0.034, 0.7) },
        ...quadrupedLeg('front', 'shoulders', 'Left', 1),
        ...quadrupedLeg('front', 'shoulders', 'Right', -1),
        ...quadrupedLeg('hind', 'hips', 'Left', 1),
        ...quadrupedLeg('hind', 'hips', 'Right', -1),
        // A tail is loose: low stiffness and under-damped, so a spring or chain driving it wags.
        { name: 'tailBase', parent: 'hips', at: [0, 0.06, -0.1], roles: ['tail'], girth: 0.05, shape: drawn(0.032), stiffness: 40, damping: 0.5, paint: 'skin' },
        { name: 'tailMiddle', parent: 'tailBase', at: [0, 0.04, -0.2], roles: ['tail'], girth: 0.04, shape: drawn(0.026), stiffness: 30, damping: 0.4, paint: 'skin' },
        { name: 'tailEnd', parent: 'tailMiddle', at: [0, 0.03, -0.2], tail: [0, 0.02, -0.18], roles: ['tail', 'tip'], girth: 0.03, shape: drawn(0.021, 0.5), stiffness: 20, damping: 0.4, paint: 'skin' },
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
        { name: 'trunk', parent: 'ground', at: [0, 0.5, 0], roles: ['spine'], girth: 0.16, shape: flattened(0.15, { width: 0.6 }), joint: 'free', paint: 'skin' },
        { name: 'head', parent: 'trunk', at: [0, 0, 0.24], tail: [0, 0, 0.2], roles: ['head'], girth: 0.13, shape: flattened(0.13, { width: 0.6, taper: 0.45 }) },
        { name: 'jaw', parent: 'head', at: [0, -0.05, 0.1], tail: [0, 0, 0.1], roles: ['jaw'], girth: 0.03, shape: drawn(0.03, 0.7) },
        { name: 'rear', parent: 'trunk', at: [0, 0, -0.24], roles: ['spine'], girth: 0.12, shape: flattened(0.12, { width: 0.55 }) },
        { name: 'tailRoot', parent: 'rear', at: [0, 0, -0.2], roles: ['tail'], girth: 0.07, shape: flattened(0.095, { width: 0.5 }) },
        { name: 'tailStalk', parent: 'tailRoot', at: [0, 0, -0.16], roles: ['tail'], girth: 0.04, shape: flattened(0.052, { width: 0.5 }) },
        {
          name: 'tailFin',
          parent: 'tailStalk',
          at: [0, 0, -0.12],
          tail: [0, 0, -0.22],
          roles: ['tail', 'tip'],
          girth: 0.2,
          shape: {
            kind: 'extrude',
            outline: [
              [0, 0],
              [0.12, -0.22],
              [0, -0.16],
              [-0.12, -0.22],
            ],
            depth: 0.014,
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

  /** A left wing's arm blade, [up, out] from the shoulder, and its hand blade, [out, up] from the wrist; the right wing mirrors `out`. */
  const WING_ARM = [
    [0.03, 0],
    [0.27, 0.44],
    [0.16, 0.46],
    [-0.16, 0.34],
    [-0.2, 0.06],
  ];
  const WING_HAND = [
    [-0.02, 0.05],
    [0.06, 0.02],
    [0.3, -0.34],
    [0.16, -0.38],
    [-0.1, -0.26],
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
              [0.16, 0.02],
              [0.09, 0.04],
            ],
          },
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
          },
        },
      ],
    },
    wings: {
      fits: ['back'],
      bones: [
        // Each wing is two flat blades: an arm out to the wrist, and a hand that sweeps down from it.
        { name: 'wingLeft', at: [0.06, 0, 0], roles: ['wing', 'left'], girth: 0.04, shape: fin(WING_ARM.map(([up, out]) => [up, out]), 'y') },
        { name: 'wingLeftTip', parent: 'wingLeft', at: [0.42, 0.22, -0.06], tail: [0.3, -0.34, -0.04], roles: ['wing', 'left', 'tip'], girth: 0.03, shape: fin(WING_HAND.map(([out, up]) => [out, up]), 'x') },
        { name: 'wingRight', at: [-0.06, 0, 0], roles: ['wing', 'right'], girth: 0.04, shape: fin(WING_ARM.map(([up, out]) => [up, -out]), 'y') },
        { name: 'wingRightTip', parent: 'wingRight', at: [-0.42, 0.22, -0.06], tail: [-0.3, -0.34, -0.04], roles: ['wing', 'right', 'tip'], girth: 0.03, shape: fin(WING_HAND.map(([out, up]) => [-out, up]), 'x') },
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
        plan: 'biped',
        dials: { ...LIMB_DIALS, armLength: { min: 0.9, max: 1.15, affects: [{ roles: ['arm'], channel: 'length' }] } },
        colors: { cloth: 'dyes', metal: 'metals' },
        fills: { headTop: { hat: 1, none: 3 } },
      },
      limits: { 'dials.height': { min: 0.6, max: 1.4 } },
    },
    human: { parent: 'humanoid', traits: ['armed'], set: { code: 1 } },
    elf: { parent: 'humanoid', traits: ['slender'], set: { code: 2, dials: { height: { min: 1, max: 1.3 }, legLength: { min: 1, max: 1.25 } } } },
    seraph: { parent: 'elf', traits: ['winged'], set: { code: 3 } },
    beast: {
      parent: 'creature',
      set: { plan: 'quadruped', dials: { ...LIMB_DIALS, tailLength: { min: 0.6, max: 1.6, shape: 'uniform', affects: [{ roles: ['tail'], channel: 'length' }] } }, colors: { skin: 'furs' } },
    },
    hound: { parent: 'beast', set: { code: 4, fills: { mouth: { sword: 1, none: 9 } } } },
    swimmer: { parent: 'creature', set: { plan: 'fish', dials: { finSize: { min: 0.7, max: 1.6, affects: [{ roles: ['fin'], channel: 'size' }] } }, colors: { skin: 'scales' } } },
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
