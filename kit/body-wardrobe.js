/**
 * Kit body wardrobe: an original, generic humanoid catalogue for a character creator, as data. One body plan (a
 * person with clavicles and hip bones so shoulder and hip width are real dials, and a lathe head whose profile
 * dials reshape), face features as surface-only parts (eyes with blink frames, brows, noses, mouths with talk
 * frames, ears, marks), hair as parts that bring a painted hairline and, for most styles, a silhouette, clothing
 * by slot as painted regions with a few silhouette bones (skirts, coats, cloaks, hoods), accessories and held
 * items on sockets, and three variants of the base species: stout, lanky and the horned, tailed hornkin.
 *
 * Owns:  `Kit.body.wardrobe.CATALOG` (ready for `Kit.body.catalog`) and its parts: `PLANS`, `PARTS`, `PALETTES`,
 *        `NODES`, `TRAITS`, and `SLOTS` (socket -> the group and label a creator lists it under).
 * Does not own: any behaviour (kit/body-*.js), any screen (a creator builds its controls from `editor.schema`),
 *        or any rendering (renderers read the bake: shapes, features, regions, ramps).
 *
 * Conventions (kit/body-plan.js): metres, +Y up, +Z forward, +X the body's left. Region `s` runs along a bone
 * from its joint (0) to its end (1): down an arm or leg, up the spine and the head (chin 0, crown 1). Feature
 * azimuth turns from the front towards the body's left; elevation rises from the middle of the head.
 *
 * Nothing here copies an existing product: names, shapes and outfits are generic descriptions.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { ellipse } = Kit.surface;
  const { ramp } = Kit.palette;

  // ---- small builders, so the tables below read as content ------------------------------------------------------------

  const SIDES = Object.freeze([
    { suffix: 'Left', sign: 1, role: 'left' },
    { suffix: 'Right', sign: -1, role: 'right' },
  ]);
  /** A paint: a colour channel and a shade of its ramp (0 darkest, 4 lightest). */
  const paint = (channel, shade) => ({ channel, shade });
  /** One stamp layer. */
  const layer = (outline, channel, shade) => ({ outline, paint: paint(channel, shade) });
  /** A polygon squashed vertically about v = 0 and shifted: how an eye looks half shut. */
  const squash = (points, factor, shift = 0) => points.map(([across, up]) => [across, up * factor + shift]);
  /** A polygon with its outer end (positive u) raised or lowered: up-turned and down-turned eyes. */
  const slant = (points, amount) => points.map(([across, up]) => [across, up + Math.max(0, across) * amount]);
  /** Two arcs joined at their corners: an almond, a lens, a lip. */
  const lens = (topHeight, bottomHeight, points = 8) => [...ellipse(0, 0, 1, topHeight, points, { from: 0, to: 180 }), ...ellipse(0, 0, 1, bottomHeight, points, { from: 180, to: 360 }).slice(1, -1)];
  /** A curved band: an arched brow, a smile. Outer arc then inner arc back, as one outline. */
  const arcBand = (centreV, radiusV, thickness, from = 0, to = 180) => [
    ...ellipse(0, centreV, 1, radiusV, 8, { from, to }),
    ...ellipse(0, centreV, 1 - thickness, radiusV - thickness, 8, { from, to }).reverse(),
  ];
  const rectangle = (halfWidth, halfHeight, centreV = 0) => [
    [-halfWidth, centreV - halfHeight],
    [halfWidth, centreV - halfHeight],
    [halfWidth, centreV + halfHeight],
    [-halfWidth, centreV + halfHeight],
  ];
  /** A lathe solid squashed front to back by `depth` (a torso is wider than it is deep). */
  const lathe = (profile, depth = 1, extra = {}) => ({ kind: 'lathe', profile, scale: [1, 1, depth], ...extra });
  /** A hairline: hair above a line that is `front` high at the brow and `back` high at the nape (head s, 0 chin, 1 crown). */
  const hairline = (front, back, jag = 0, count = 0) => ({ edge: { front, back, jag, count } });

  // ---- the body plan ---------------------------------------------------------------------------------------------------

  /** The head's profile, chin to crown: [radius, height] in metres. Dials reshape points 0 (chin) to 6 (crown edge). */
  const HEAD_PROFILE = Object.freeze([
    [0.028, 0], // chin
    [0.066, 0.028], // jaw
    [0.086, 0.07], // jaw angle
    [0.096, 0.118], // cheekbones
    [0.094, 0.162], // temples
    [0.074, 0.205], // upper cranium
    [0.034, 0.226], // crown edge
    [0, 0.23],
  ]);
  /** The head is a little narrower than it is deep. */
  const HEAD_SCALE = Object.freeze([0.88, 1, 1]);

  const arm = ({ suffix, sign, role }) => [
    // A clavicle: its length along X is the shoulder width.
    { name: `clavicle${suffix}`, parent: 'chest', at: [0.02 * sign, 0.2, 0], roles: [role], girth: 0.06, shape: { kind: 'none' } },
    {
      name: `upperArm${suffix}`,
      parent: `clavicle${suffix}`,
      at: [0.15 * sign, 0, 0],
      turn: [0, 0, 7 * sign],
      roles: ['arm', 'primary', role],
      girth: 0.09,
      limits: [
        [-170, 60],
        [-90, 90],
        [-120, 120],
      ],
      shape: { kind: 'capsule', radius: 0.045, taper: 0.85 },
      paint: 'skin',
    },
    {
      name: `forearm${suffix}`,
      parent: `upperArm${suffix}`,
      at: [0, -0.28, 0],
      roles: ['arm', 'primary', role],
      girth: 0.075,
      joint: 'hinge',
      limits: [
        [-150, 0],
        [0, 0],
        [0, 0],
      ],
      shape: { kind: 'capsule', radius: 0.037, taper: 0.8 },
      paint: 'skin',
    },
    {
      name: `hand${suffix}`,
      parent: `forearm${suffix}`,
      at: [0, -0.25, 0],
      tail: [0, -0.09, 0],
      roles: ['arm', 'hand', 'primary', 'tip', role],
      girth: 0.06,
      shape: { kind: 'box', size: [0.05, 0.1, 0.028], at: [0, -0.045, 0] },
      paint: 'skin',
    },
  ];
  const leg = ({ suffix, sign, role }) => [
    // A hip bone: its length along X is the hip width.
    { name: `hip${suffix}`, parent: 'pelvis', at: [0, 0.01, 0], roles: [role], girth: 0.08, shape: { kind: 'none' } },
    {
      name: `thigh${suffix}`,
      parent: `hip${suffix}`,
      at: [0.09 * sign, 0, 0],
      roles: ['leg', 'primary', role],
      girth: 0.13,
      limits: [
        [-120, 45],
        [-40, 40],
        [-45, 45],
      ],
      shape: { kind: 'capsule', radius: 0.068, taper: 0.72 },
      paint: 'skin',
    },
    {
      name: `shin${suffix}`,
      parent: `thigh${suffix}`,
      at: [0, -0.44, 0],
      roles: ['leg', 'primary', role],
      girth: 0.1,
      joint: 'hinge',
      shape: { kind: 'capsule', radius: 0.05, taper: 0.66 },
      paint: 'skin',
    },
    {
      name: `foot${suffix}`,
      parent: `shin${suffix}`,
      at: [0, -0.43, 0],
      tail: [0, 0, 0.16],
      roles: ['leg', 'foot', 'primary', 'tip', role],
      girth: 0.07,
      shape: { kind: 'box', size: [0.085, 0.065, 0.24], at: [0, -0.03, 0.05] },
      paint: 'skin',
    },
  ];

  /** Sockets on the head that hold only surface features: they need no position of their own. */
  const FACE_SOCKETS = ['eyes', 'brows', 'nose', 'mouth', 'ears', 'marks', 'earrings'];
  const REQUIRED_FACE = ['eyes', 'nose', 'mouth', 'ears'];

  /**
   * Body plans by id. `person`: 23 bones, skin-painted throughout (clothes are regions over it), a lathe torso
   * and head, and the sockets a creator fills.
   */
  const PLANS = {
    person: {
      bones: [
        { name: 'ground', roles: ['root'], joint: 'free', shape: { kind: 'none' } },
        {
          name: 'pelvis',
          parent: 'ground',
          at: [0, 0.93, 0],
          tail: [0, 0.15, 0],
          roles: ['spine'],
          girth: 0.3,
          joint: 'free',
          shape: lathe(
            [
              [0.1, -0.07],
              [0.15, 0],
              [0.152, 0.08],
              [0.13, 0.15],
            ],
            0.7
          ),
          paint: 'skin',
        },
        {
          name: 'waist',
          parent: 'pelvis',
          at: [0, 0.15, 0],
          tail: [0, 0.15, 0],
          roles: ['spine'],
          girth: 0.26,
          limits: [
            [-30, 45],
            [-30, 30],
            [-25, 25],
          ],
          shape: lathe(
            [
              [0.13, 0],
              [0.12, 0.08],
              [0.132, 0.15],
            ],
            0.68
          ),
          paint: 'skin',
        },
        {
          name: 'chest',
          parent: 'waist',
          at: [0, 0.15, 0],
          tail: [0, 0.24, 0],
          roles: ['spine'],
          girth: 0.3,
          limits: [
            [-20, 30],
            [-30, 30],
            [-20, 20],
          ],
          shape: lathe(
            [
              [0.132, 0],
              [0.152, 0.08],
              [0.158, 0.16],
              [0.13, 0.22],
              [0.06, 0.25],
            ],
            0.7
          ),
          paint: 'skin',
        },
        {
          name: 'neck',
          parent: 'chest',
          at: [0, 0.23, 0],
          tail: [0, 0.08, 0],
          roles: ['neck'],
          girth: 0.09,
          limits: [
            [-40, 40],
            [-60, 60],
            [-30, 30],
          ],
          shape: { kind: 'capsule', radius: 0.042 },
          paint: 'skin',
        },
        {
          name: 'head',
          parent: 'neck',
          at: [0, 0.07, 0.005],
          tail: [0, 0.23, 0],
          roles: ['head'],
          girth: 0.18,
          limits: [
            [-30, 30],
            [-40, 40],
            [-20, 20],
          ],
          shape: lathe(
            HEAD_PROFILE.map((point) => [...point]),
            1,
            { scale: [...HEAD_SCALE] }
          ),
          paint: 'skin',
        },
        ...SIDES.flatMap(arm),
        ...SIDES.flatMap(leg),
      ],
      sockets: [
        ...FACE_SOCKETS.map((name) => ({ name, bone: 'head', type: name, at: [0, 0.115, 0], required: REQUIRED_FACE.includes(name) })),
        { name: 'hair', bone: 'head', type: 'hair', at: [0, 0.115, 0] },
        { name: 'facialHair', bone: 'head', type: 'facialHair', at: [0, 0.035, 0.055] },
        { name: 'hat', bone: 'head', type: 'hat', at: [0, 0.222, 0] },
        { name: 'glasses', bone: 'head', type: 'glasses', at: [0, 0.122, 0.092] },
        { name: 'horns', bone: 'head', type: 'horns', at: [0, 0.19, 0.02] },
        { name: 'top', bone: 'chest', type: 'top', at: [0, 0.1, 0] },
        { name: 'outerwear', bone: 'chest', type: 'outerwear', at: [0, 0.2, 0] },
        { name: 'gloves', bone: 'chest', type: 'gloves' },
        { name: 'back', bone: 'chest', type: 'back', at: [0, 0.12, -0.11] },
        { name: 'bottom', bone: 'pelvis', type: 'bottom', at: [0, 0.15, 0] },
        { name: 'footwear', bone: 'pelvis', type: 'footwear' },
        { name: 'tail', bone: 'pelvis', type: 'tail', at: [0, 0.03, -0.1] },
        { name: 'handLeft', bone: 'handLeft', type: 'grip', at: [0, -0.06, 0.01] },
        { name: 'handRight', bone: 'handRight', type: 'grip', at: [0, -0.06, 0.01] },
      ],
    },
  };

  // ---- face features: surface-only parts --------------------------------------------------------------------------------

  /**
   * Eyes: the white, the iris (its size is the option's), pupil, glint and lash line, with half-shut and shut
   * frames for blinking. `white` is the open outline; the frames are derived from it so every style blinks.
   */
  const eyeFrames = (white, irisRadius, lashShade = 0) => {
    const iris = ellipse(0, -0.05, irisRadius, irisRadius * 1.08, 12);
    const pupil = ellipse(0, -0.05, irisRadius * 0.45, irisRadius * 0.5, 10);
    const glint = ellipse(irisRadius * 0.35, irisRadius * 0.4, irisRadius * 0.22, irisRadius * 0.22, 6);
    const lash = arcBand(0, Math.max(...white.map(([, up]) => up)) + 0.08, 0.14);
    return {
      open: [layer(white, 'sclera', 4), layer(iris, 'eyes', 2), layer(pupil, 'eyes', 0), layer(glint, 'sclera', 4), layer(lash, 'hair', lashShade)],
      half: [layer(squash(white, 0.45, -0.15), 'sclera', 4), layer(squash(iris, 0.45, -0.15), 'eyes', 2), layer(squash(lash, 0.5, -0.12), 'hair', lashShade)],
      closed: [layer(arcBand(-0.1, 0.25, 0.12, 180, 360), 'hair', lashShade)],
    };
  };
  const eyesPart = (label, white, irisRadius, size, extra = {}) => ({
    fits: ['eyes'],
    label,
    bones: [],
    features: [{ id: 'eye', azimuth: 0, elevation: 2, spacing: 52, size, frames: eyeFrames(white, irisRadius), rest: 'open', ...extra }],
  });
  const ALMOND = lens(0.62, 0.45);

  /** Brows: one 'rest' frame each, painted a shade of the hair. */
  const browsPart = (label, outline, size, extra = {}) => ({
    fits: ['brows'],
    label,
    bones: [],
    features: [{ id: 'brow', azimuth: 0, elevation: 15, spacing: 54, size, rotation: 0, frames: { rest: [layer(outline, 'hair', 1)] }, ...extra }],
  });

  /** Noses: a solid each (feature frame: +Y up the face, +Z out), with a shadow stamp under the tip. */
  const nosePart = (label, shape, size = [0.03, 0.036]) => ({
    fits: ['nose'],
    label,
    bones: [],
    features: [{ id: 'nose', azimuth: 0, elevation: -8, size, lift: 0.002, shape, paint: 'skin', frames: { rest: [layer(ellipse(0, -0.85, 0.5, 0.12, 8), 'skin', 0)] } }],
  });

  /** Mouths: rest, smile and open frames for talking, painted with the lips channel. */
  const mouthFrames = (restLips, smileLift = 0.35) => ({
    rest: restLips,
    smile: [layer(arcBand(smileLift, 0.75, 0.32, 180, 360), 'lips', 2), layer(arcBand(smileLift, 0.6, 0.1, 190, 350), 'lips', 0)],
    open: [layer(ellipse(0, -0.1, 0.8, 0.62, 12), 'lips', 2), layer(ellipse(0, -0.1, 0.6, 0.42, 12), 'lips', 0)],
  });
  const mouthPart = (label, restLips, size, extra = {}) => ({
    fits: ['mouth'],
    label,
    bones: [],
    features: [{ id: 'mouth', azimuth: 0, elevation: -27, size, frames: mouthFrames(restLips), rest: 'rest', ...extra }],
  });

  /** Ears: a mirrored pair of solids at the sides of the head. */
  const earsPart = (label, shape, size, extra = {}) => ({
    fits: ['ears'],
    label,
    bones: [],
    features: [{ id: 'ear', azimuth: 0, elevation: -2, spacing: 174, size, lift: 0.004, shape, paint: 'skin', ...extra }],
  });

  /** Marks on the skin: freckles, blush, a scar, a mole, painted stripes, star-spots. */
  const FRECKLE_DOTS = [
    [-0.8, 0.1],
    [-0.55, -0.25],
    [-0.35, 0.3],
    [-0.15, -0.05],
    [0.15, 0.2],
    [0.35, -0.2],
    [0.55, 0.25],
    [0.8, -0.05],
    [-0.65, 0.45],
    [0.65, -0.45],
  ].map(([across, up]) => layer(ellipse(across, up, 0.06, 0.12, 6), 'marks', 1));
  const markPart = (label, feature) => ({ fits: ['marks'], label, bones: [], features: [{ frames: { rest: [] }, ...feature }] });

  // ---- hair, facial hair -------------------------------------------------------------------------------------------------

  /** A hair part: a painted cap over the head (layer 5) and the bones of its silhouette, hanging from the head's middle. */
  const hairPart = (label, cap, bones = []) => ({ fits: ['hair'], label, bones, regions: [{ id: 'hair', bones: ['@host'], where: cap, paint: 'hair', layer: 5 }] });
  const strand = (name, parent, at, tail, girth, extra = {}) => ({ name, parent, at, tail, girth, roles: parent ? [] : ['root'], stiffness: 30, damping: 0.5, paint: 'hair', ...extra });
  /** A plait or tail of three loose capsules, for one side or the back. */
  const chain = (prefix, start, steps, girths, roles = []) =>
    steps.map((step, index) => ({
      name: `${prefix}${index + 1}`,
      ...(index ? { parent: `${prefix}${index}` } : {}),
      at: index ? steps[index - 1] : start,
      ...(index === steps.length - 1 ? { tail: step } : {}),
      roles: [...(index ? [] : ['root']), ...roles],
      girth: girths[index],
      shape: { kind: 'capsule', radius: girths[index] / 2, taper: 0.85 },
      stiffness: 25,
      damping: 0.45,
      paint: 'hair',
    }));

  /** Stubble and beard areas: the lower face, front and sides (head s from the chin). */
  const LOWER_FACE = { intersect: [{ band: { s: [0, 0.36] } }, { band: { angle: [-115, 115] } }] };
  const STIPPLE = { checker: { s: 46, angle: 70 } };

  // ---- clothing: regions over the body, a few silhouette bones -----------------------------------------------------------

  /** A region row; `layer` stacks clothes: bottoms 2, tops 3, footwear and gloves 3, outerwear 4, hair 5, headwear 6. */
  const region = (id, selection, where, channel, regionLayer) => ({ id, ...selection, where, paint: channel, layer: regionLayer });
  const ALL = { all: true };
  /** Bone selections. Upper arm and forearm share the 'arm' role, so anything that stops part-way down a limb names bones. */
  const ARMS = { roles: ['arm'], except: ['hand'] };
  const UPPER_ARMS = { bones: ['upperArmLeft', 'upperArmRight'] };
  const FOREARMS = { bones: ['forearmLeft', 'forearmRight'] };
  const THIGHS = { bones: ['thighLeft', 'thighRight'] };
  const SHINS = { bones: ['shinLeft', 'shinRight'] };
  const LEGS = { roles: ['leg'], except: ['foot'] };
  const TORSO = { bones: ['waist', 'chest'] };
  const OPEN_FRONT = { mask: { keep: ALL, cut: { band: { angle: [-16, 16] } } } };

  const topPart = (label, regions, bones = []) => ({ fits: ['top'], label, bones, regions });
  const bottomPart = (label, regions, bones = []) => ({ fits: ['bottom'], label, bones, regions });
  const outerPart = (label, regions, bones = []) => ({ fits: ['outerwear'], label, bones, regions });
  /** A hanging skirt or coat tail: a lathe that flares as it falls from the waist. */
  const skirtBone = (name, length, flare, channel) => ({
    name,
    roles: ['root'],
    tail: [0, -length, 0],
    girth: 0.3,
    shape: lathe(
      [
        [0.145, 0],
        [0.15 + flare * 0.4, length * 0.45],
        [0.15 + flare, length],
      ],
      0.78
    ),
    paint: channel,
  });

  // ---- accessories and held things ---------------------------------------------------------------------------------------

  const hatPart = (label, bones, regions = []) => ({ fits: ['hat'], label, bones, regions });
  const lensBone = (name, at, outline) => ({ name, roles: ['root'], at, tail: [0, 0.01, 0], girth: 0.04, shape: { kind: 'extrude', outline, depth: 0.004 }, paint: 'accent' });
  const heldPart = (label, bones, extra = {}) => ({ fits: ['grip'], label, bones, ...extra });
  const earringPart = (label, shape, lift, size = [0.01, 0.01]) => ({
    fits: ['earrings'],
    label,
    bones: [],
    features: [{ id: 'earring', azimuth: 0, elevation: -16, spacing: 170, size, lift, shape, paint: 'accent' }],
  });

  /**
   * Parts by id. Every option is meant to read differently in silhouette or in what it paints; the comment on
   * each group says how.
   */
  const PARTS = {
    // Eyes (5): the white's outline and the iris size differ; each has open, half and closed frames.
    eyesRound: eyesPart('Round', ellipse(0, 0, 1, 0.82, 14), 0.5, [0.03, 0.026]),
    eyesAlmond: eyesPart('Almond', ALMOND, 0.46, [0.034, 0.022]),
    eyesNarrow: eyesPart('Narrow', lens(0.38, 0.3), 0.36, [0.036, 0.016]),
    eyesDowncast: eyesPart('Downcast', slant(ALMOND, -0.32), 0.44, [0.034, 0.022]),
    eyesUpturned: eyesPart('Upturned', slant(ALMOND, 0.36), 0.44, [0.034, 0.022]),
    // Brows (5): straight, arched, heavy, rising, fine.
    browsStraight: browsPart('Straight', rectangle(1, 0.22), [0.04, 0.009]),
    browsArched: browsPart('Arched', arcBand(-0.7, 1.4, 0.45), [0.04, 0.012]),
    browsHeavy: browsPart(
      'Heavy',
      [
        [-1, -0.4],
        [1, -0.15],
        [1, 0.3],
        [-1, 0.5],
      ],
      [0.044, 0.015]
    ),
    browsRising: browsPart(
      'Rising',
      [
        [-1, -0.35],
        [1, 0.25],
        [1, 0.65],
        [-1, 0.05],
      ],
      [0.04, 0.014]
    ),
    browsFine: browsPart('Fine', arcBand(-0.6, 1.2, 0.22), [0.038, 0.009]),
    // Noses (5): different solids: a ball, a ridge, a cone, a wide ball, a hooked ridge.
    noseButton: nosePart('Button', { kind: 'sphere', radius: 0.011, scale: [1.15, 0.9, 0.85] }),
    noseStraight: nosePart('Straight', { kind: 'capsule', end: [0, -0.034, 0.012], radius: 0.006, taper: 1.6 }),
    nosePointed: nosePart('Pointed', {
      kind: 'lathe',
      end: [0, -0.036, 0],
      profile: [
        [0.005, 0],
        [0.01, 0.024],
        [0.011, 0.03],
        [0, 0.036],
      ],
      scale: [1, 1, 0.9],
      at: [0, 0.004, 0.004],
    }),
    noseBroad: nosePart('Broad', { kind: 'sphere', radius: 0.012, scale: [1.75, 0.95, 0.85] }, [0.036, 0.03]),
    noseHooked: nosePart('Hooked', { kind: 'capsule', end: [0, -0.036, 0.004], radius: 0.006, taper: 1.9, at: [0, 0.004, 0.008] }),
    // Mouths (5): lip outlines differ at rest; each has smile and open frames for talking.
    mouthNeutral: mouthPart('Neutral', [layer(lens(0.22, 0.2), 'lips', 2), layer(rectangle(0.9, 0.04), 'lips', 0)], [0.044, 0.016]),
    mouthWide: mouthPart('Wide', [layer(lens(0.18, 0.22), 'lips', 2), layer(rectangle(0.95, 0.035), 'lips', 0)], [0.058, 0.016]),
    mouthFull: mouthPart('Full', [layer(lens(0.38, 0.5), 'lips', 2), layer(arcBand(0.05, 0.12, 0.06, 180, 360), 'lips', 0)], [0.046, 0.022]),
    mouthSmall: mouthPart('Small', [layer(lens(0.3, 0.32), 'lips', 2), layer(rectangle(0.8, 0.05), 'lips', 0)], [0.03, 0.014]),
    mouthSmirk: mouthPart('Smirk', [layer(slant(lens(0.2, 0.22), 0.35), 'lips', 2), layer(slant(rectangle(0.9, 0.04), 0.3), 'lips', 0)], [0.046, 0.017]),
    // Ears (5): round, small, large, pointed, long and swept back.
    earsRound: earsPart('Round', { kind: 'sphere', radius: 0.024, scale: [0.72, 1.2, 0.4] }, [0.03, 0.05]),
    earsSmall: earsPart('Small', { kind: 'sphere', radius: 0.018, scale: [0.7, 1.1, 0.4] }, [0.024, 0.04]),
    earsLarge: earsPart('Large', { kind: 'sphere', radius: 0.031, scale: [0.8, 1.25, 0.45] }, [0.04, 0.066]),
    earsPointed: earsPart(
      'Pointed',
      {
        kind: 'lathe',
        end: [0, 0.06, -0.012],
        profile: [
          [0.019, 0],
          [0.014, 0.032],
          [0, 0.06],
        ],
        scale: [1, 1, 0.4],
        at: [0, -0.02, 0],
      },
      [0.032, 0.06]
    ),
    earsLong: earsPart(
      'Long',
      {
        kind: 'lathe',
        end: [0, 0.09, -0.03],
        profile: [
          [0.017, 0],
          [0.012, 0.055],
          [0, 0.095],
        ],
        scale: [1, 1, 0.35],
        at: [0, -0.02, 0],
      },
      [0.03, 0.09],
      { rotation: 25 }
    ),
    // Marks (5): where they sit and what they paint differ.
    freckles: markPart('Freckles', { id: 'freckles', azimuth: 0, elevation: -6, size: [0.075, 0.028], frames: { rest: FRECKLE_DOTS } }),
    blush: markPart('Blush', { id: 'blush', azimuth: 0, elevation: -13, spacing: 72, size: [0.036, 0.02], frames: { rest: [layer(ellipse(0, 0, 1, 1, 12), 'lips', 3)] } }),
    scar: markPart('Scar', {
      id: 'scar',
      azimuth: 26,
      elevation: 6,
      size: [0.05, 0.012],
      rotation: 62,
      frames: {
        rest: [
          layer(lens(0.35, 0.35), 'skin', 0),
          ...[-0.5, 0, 0.5].map((across) =>
            layer(
              rectangle(0.05, 0.9).map(([u, v]) => [u + across, v]),
              'skin',
              1
            )
          ),
        ],
      },
    }),
    mole: markPart('Mole', { id: 'mole', azimuth: -22, elevation: -21, size: [0.006, 0.006], frames: { rest: [layer(ellipse(0, 0, 1, 1, 8), 'marks', 0)] } }),
    stripes: markPart('Painted stripes', {
      id: 'stripes',
      azimuth: 0,
      elevation: -9,
      spacing: 84,
      size: [0.04, 0.03],
      rotation: -12,
      frames: { rest: [-0.55, 0, 0.55].map((up) => layer(rectangle(1, 0.14, up), 'marks', 2)) },
    }),

    // Hair (10): a hairline and, for most, a silhouette. Bald is the empty socket.
    hairCrop: hairPart('Crop', hairline(0.8, 0.42, 0.015, 9)),
    hairBuzz: hairPart('Buzz', { intersect: [hairline(0.84, 0.46), STIPPLE] }),
    hairSwept: hairPart('Swept', hairline(0.74, 0.36), [
      { name: 'fringe', roles: ['root'], at: [0.02, 0.085, 0.07], turn: [12, 0, 16], tail: [0, 0.03, 0], girth: 0.04, shape: { kind: 'box', size: [0.15, 0.034, 0.04] }, paint: 'hair' },
    ]),
    hairBob: hairPart('Bob', hairline(0.78, 0.22), [strand('volume', undefined, [0, 0.015, -0.032], undefined, 0.2, { shape: { kind: 'sphere', radius: 0.106, scale: [1.0, 0.92, 0.96] } })]),
    hairLong: hairPart('Long', hairline(0.78, 0.26), [
      strand('crown', undefined, [0, 0.02, -0.02], undefined, 0.2, { shape: { kind: 'sphere', radius: 0.1, scale: [1.02, 0.95, 1] } }),
      strand('fall', 'crown', [0, 0.02, -0.06], [0, -0.34, 0], 0.2, {
        shape: {
          kind: 'extrude',
          outline: [
            [-0.1, 0],
            [0.1, 0],
            [0.12, 0.3],
            [0, 0.34],
            [-0.12, 0.3],
          ],
          depth: 0.035,
        },
      }),
    ]),
    hairPonytail: hairPart(
      'Ponytail',
      hairline(0.8, 0.36),
      chain(
        'tie',
        [0, 0.05, -0.095],
        [
          [0, -0.08, -0.05],
          [0, -0.1, -0.02],
          [0, -0.09, 0.01],
        ],
        [0.055, 0.045, 0.03]
      )
    ),
    hairBun: hairPart('Bun', hairline(0.82, 0.32), [strand('bun', undefined, [0, 0.08, -0.085], undefined, 0.09, { shape: { kind: 'sphere', radius: 0.045 } })]),
    hairCrest: hairPart('Crest', { intersect: [hairline(0.7, 0.3), { union: [{ band: { angle: [-15, 15] } }, { band: { angle: [165, -165] } }] }] }, [
      {
        name: 'crest',
        roles: ['root'],
        at: [0, 0.09, -0.01],
        turn: [0, 90, 0],
        tail: [0, 0.06, 0],
        girth: 0.02,
        shape: {
          kind: 'extrude',
          outline: [
            [-0.1, 0],
            [0.09, 0],
            [0.06, 0.055],
            [-0.08, 0.065],
          ],
          depth: 0.018,
        },
        paint: 'hair',
      },
    ]),
    hairCurls: hairPart('Curls', hairline(0.76, 0.28), [strand('volume', undefined, [0, 0.055, -0.03], undefined, 0.25, { shape: { kind: 'sphere', radius: 0.125, scale: [1.06, 0.95, 1] } })]),
    hairBraids: hairPart('Braids', hairline(0.8, 0.4), [
      ...SIDES.flatMap(({ suffix, sign, role }) =>
        chain(
          `braid${suffix}`,
          [0.07 * sign, -0.01, -0.05],
          [
            [0.01 * sign, -0.1, 0.02],
            [0, -0.1, 0.01],
            [0, -0.09, 0],
          ],
          [0.03, 0.026, 0.02],
          [role]
        )
      ),
    ]),
    // Facial hair (4): stippled stubble, a stamped moustache, a full beard with volume, a chin tuft.
    stubble: { fits: ['facialHair'], label: 'Stubble', bones: [], regions: [{ id: 'stubble', bones: ['@host'], where: { intersect: [LOWER_FACE, STIPPLE] }, paint: 'hair', layer: 5 }] },
    moustache: {
      fits: ['facialHair'],
      label: 'Moustache',
      bones: [],
      features: [
        {
          id: 'moustache',
          azimuth: 0,
          elevation: -19,
          size: [0.05, 0.014],
          frames: {
            rest: [
              layer(
                [
                  [-1, -0.6],
                  [-0.5, 0.3],
                  [0, 0.5],
                  [0.5, 0.3],
                  [1, -0.6],
                  [0.4, -0.1],
                  [0, 0],
                  [-0.4, -0.1],
                ],
                'hair',
                1
              ),
            ],
          },
        },
      ],
    },
    beard: {
      fits: ['facialHair'],
      label: 'Full beard',
      bones: [{ name: 'beard', roles: ['root'], at: [0, -0.015, -0.01], girth: 0.12, shape: { kind: 'sphere', radius: 0.058, scale: [1.25, 1.1, 0.85] }, paint: 'hair' }],
      regions: [{ id: 'beard', bones: ['@host'], where: LOWER_FACE, paint: 'hair', layer: 5 }],
    },
    chinTuft: {
      fits: ['facialHair'],
      label: 'Chin tuft',
      bones: [{ name: 'tuft', roles: ['root'], at: [0, -0.01, 0.004], tail: [0, -0.045, 0.012], girth: 0.03, shape: { kind: 'capsule', radius: 0.014, taper: 0.4 }, paint: 'hair' }],
      regions: [{ id: 'tuft', bones: ['@host'], where: { intersect: [{ band: { s: [0, 0.2] } }, { band: { angle: [-30, 30] } }] }, paint: 'hair', layer: 5 }],
    },

    // Tops (6): what they cover differs (sleeve length, hem, open shoulders) and two add a pattern.
    tee: topPart('Tee', [region('body', TORSO, ALL, 'top', 3), region('sleeve', UPPER_ARMS, { band: { s: [0, 0.4] } }, 'top', 3)]),
    longSleeve: topPart('Long sleeve', [region('body', TORSO, ALL, 'top', 3), region('sleeve', ARMS, ALL, 'top', 3)]),
    tank: topPart('Tank', [
      region('body', TORSO, { mask: { keep: ALL, cut: { intersect: [{ band: { s: [0.78, 1] } }, { union: [{ band: { angle: [40, 140] } }, { band: { angle: [-140, -40] } }] }] } } }, 'top', 3),
    ]),
    stripedKnit: topPart('Striped knit', [
      region('body', TORSO, ALL, 'top', 3),
      region('sleeve', ARMS, ALL, 'top', 3),
      region('stripes', { bones: ['waist', 'chest', 'upperArmLeft', 'upperArmRight', 'forearmLeft', 'forearmRight'] }, { stripe: { along: 's', count: 5, duty: 0.35 } }, 'accent', 3),
    ]),
    cropTop: topPart('Crop top', [region('body', { bones: ['chest'] }, { band: { s: [0.3, 1] } }, 'top', 3), region('cap', UPPER_ARMS, { band: { s: [0, 0.15] } }, 'top', 3)]),
    tunic: topPart('Belted tunic', [
      region('body', { bones: ['waist', 'chest', 'pelvis'] }, ALL, 'top', 3),
      region('hem', THIGHS, { band: { s: [0, 0.3] } }, 'top', 3),
      region('sleeve', UPPER_ARMS, { band: { s: [0, 0.75] } }, 'top', 3),
      region('belt', { bones: ['waist'] }, { band: { s: [0.05, 0.2] } }, 'gear', 3),
    ]),
    // Bottoms (5): trousers to the ankle, shorts, a flared skirt and a long one (lathe silhouettes), striped leggings.
    trousers: bottomPart('Trousers', [region('seat', { bones: ['pelvis'] }, ALL, 'bottom', 2), region('legs', LEGS, ALL, 'bottom', 2)]),
    shorts: bottomPart('Shorts', [region('seat', { bones: ['pelvis'] }, ALL, 'bottom', 2), region('legs', THIGHS, { band: { s: [0, 0.5] } }, 'bottom', 2)]),
    skirt: bottomPart('Skirt', [region('seat', { bones: ['pelvis'] }, ALL, 'bottom', 2)], [skirtBone('skirt', 0.42, 0.09, 'bottom')]),
    longSkirt: bottomPart('Long skirt', [region('seat', { bones: ['pelvis'] }, ALL, 'bottom', 2)], [skirtBone('skirt', 0.86, 0.14, 'bottom')]),
    leggings: bottomPart('Striped leggings', [
      region('seat', { bones: ['pelvis'] }, ALL, 'bottom', 2),
      region('legs', LEGS, ALL, 'bottom', 2),
      region('stripe', LEGS, { union: [{ band: { angle: [78, 102] } }, { band: { angle: [-102, -78] } }] }, 'accent', 2),
    ]),
    // Footwear (4): what of the foot and shin is covered differs.
    shoes: { fits: ['footwear'], label: 'Shoes', bones: [], regions: [region('shoe', { roles: ['foot'] }, ALL, 'footwear', 3)] },
    boots: { fits: ['footwear'], label: 'Boots', bones: [], regions: [region('boot', { roles: ['foot'] }, ALL, 'footwear', 3), region('shaft', SHINS, { band: { s: [0.5, 1] } }, 'footwear', 3)] },
    tallBoots: {
      fits: ['footwear'],
      label: 'Tall boots',
      bones: [],
      regions: [
        region('boot', { roles: ['foot'] }, ALL, 'footwear', 3),
        region('shaft', SHINS, { band: { s: [0.02, 1] } }, 'footwear', 3),
        region('cuff', SHINS, { band: { s: [0, 0.08] } }, 'gear', 3),
      ],
    },
    sandals: { fits: ['footwear'], label: 'Sandals', bones: [], regions: [region('straps', { roles: ['foot'] }, { stripe: { along: 's', count: 3, duty: 0.3, phase: 0.1 } }, 'footwear', 3)] },
    // Outerwear (6): open jacket, vest, cloak (a panel), long coat (a flared tail), hoodie (a hood), scarf (a wrap).
    jacket: outerPart(
      'Open jacket',
      [region('body', TORSO, OPEN_FRONT, 'outerwear', 4), region('sleeve', ARMS, { band: { s: [0, 0.97] } }, 'outerwear', 4)],
      [
        {
          name: 'collar',
          roles: ['root'],
          at: [0, 0.03, 0],
          tail: [0, 0.05, 0],
          girth: 0.2,
          shape: lathe(
            [
              [0.075, 0],
              [0.09, 0.05],
            ],
            0.9
          ),
          paint: 'outerwear',
        },
      ]
    ),
    vest: outerPart('Vest', [region('body', TORSO, OPEN_FRONT, 'outerwear', 4)]),
    cloak: outerPart(
      'Cloak',
      [region('mantle', { bones: ['chest'] }, { band: { s: [0.75, 1] } }, 'outerwear', 4)],
      [
        {
          name: 'cloak',
          roles: ['root'],
          at: [0, 0.01, -0.1],
          turn: [-6, 0, 0],
          tail: [0, -1.05, 0],
          girth: 0.4,
          shape: {
            kind: 'extrude',
            outline: [
              [-0.17, 0],
              [0.17, 0],
              [0.3, 1.05],
              [-0.3, 1.05],
            ],
            depth: 0.02,
          },
          paint: 'outerwear',
        },
      ]
    ),
    longCoat: outerPart(
      'Long coat',
      [region('body', TORSO, OPEN_FRONT, 'outerwear', 4), region('sleeve', ARMS, ALL, 'outerwear', 4), region('seat', { bones: ['pelvis'] }, OPEN_FRONT, 'outerwear', 4)],
      [{ ...skirtBone('tails', 0.6, 0.12, 'outerwear'), at: [0, -0.36, 0] }]
    ),
    hoodie: outerPart(
      'Hoodie',
      [
        region('body', TORSO, ALL, 'outerwear', 4),
        region('sleeve', ARMS, ALL, 'outerwear', 4),
        region('pocket', { bones: ['waist'] }, { intersect: [{ band: { s: [0.05, 0.6] } }, { band: { angle: [-40, 40] } }] }, 'accent', 4),
      ],
      [{ name: 'hood', roles: ['root'], at: [0, 0.02, -0.06], girth: 0.2, shape: { kind: 'sphere', radius: 0.1, scale: [1.05, 0.55, 0.8] }, paint: 'outerwear' }]
    ),
    scarf: outerPart(
      'Scarf',
      [],
      [
        {
          name: 'wrap',
          roles: ['root'],
          at: [0, 0.035, 0],
          tail: [0, 0.07, 0],
          girth: 0.2,
          shape: lathe(
            [
              [0.075, 0],
              [0.08, 0.035],
              [0.07, 0.07],
            ],
            0.95
          ),
          paint: 'outerwear',
        },
        {
          name: 'end',
          parent: 'wrap',
          at: [0.05, 0.02, 0.06],
          turn: [0, 0, 10],
          tail: [0, -0.3, 0],
          girth: 0.08,
          shape: {
            kind: 'extrude',
            outline: [
              [-0.04, 0],
              [0.04, 0],
              [0.045, 0.3],
              [-0.045, 0.3],
            ],
            depth: 0.012,
          },
          paint: 'outerwear',
        },
      ]
    ),
    // Gloves (4): the whole hand, the palm only, a gauntlet up the forearm, a bracer on the forearm only.
    gloves: { fits: ['gloves'], label: 'Gloves', bones: [], regions: [region('glove', { roles: ['hand'] }, ALL, 'gloves', 3)] },
    fingerless: { fits: ['gloves'], label: 'Fingerless', bones: [], regions: [region('glove', { roles: ['hand'] }, { band: { s: [0, 0.55] } }, 'gloves', 3)] },
    gauntlets: {
      fits: ['gloves'],
      label: 'Gauntlets',
      bones: [],
      regions: [region('glove', { roles: ['hand'] }, ALL, 'gloves', 3), region('cuff', FOREARMS, { band: { s: [0.55, 1] } }, 'gloves', 3)],
    },
    bracers: { fits: ['gloves'], label: 'Bracers', bones: [], regions: [region('bracer', FOREARMS, { band: { s: [0.45, 0.85] } }, 'gear', 3)] },

    // Headwear (6): a peaked cap, a knit beanie, a wide brim, a slouched beret, a painted headband, a circlet.
    cap: hatPart('Peaked cap', [
      {
        name: 'crown',
        roles: ['root'],
        at: [0, -0.072, 0],
        tail: [0, 0.1, 0],
        girth: 0.2,
        shape: lathe(
          [
            [0.1, 0],
            [0.096, 0.05],
            [0.06, 0.088],
            [0, 0.098],
          ],
          1,
          { scale: [0.9, 1, 1] }
        ),
        paint: 'hat',
      },
      { name: 'peak', parent: 'crown', at: [0, 0.005, 0.085], turn: [-8, 0, 0], tail: [0, 0, 0.07], girth: 0.1, shape: { kind: 'box', size: [0.15, 0.01, 0.08], at: [0, 0, 0.03] }, paint: 'hat' },
    ]),
    beanie: hatPart('Beanie', [
      {
        name: 'knit',
        roles: ['root'],
        at: [0, -0.085, 0],
        tail: [0, 0.13, 0],
        girth: 0.2,
        shape: lathe(
          [
            [0.103, 0],
            [0.104, 0.03],
            [0.09, 0.085],
            [0.05, 0.118],
            [0, 0.124],
          ],
          1,
          { scale: [0.9, 1, 1] }
        ),
        paint: 'hat',
      },
      { name: 'pom', parent: 'knit', at: [0, 0.13, 0], girth: 0.04, shape: { kind: 'sphere', radius: 0.022 }, paint: 'accent' },
    ]),
    wideBrim: hatPart('Wide brim', [
      {
        name: 'brim',
        roles: ['root'],
        at: [0, -0.05, 0],
        tail: [0, 0.02, 0],
        girth: 0.4,
        shape: lathe([
          [0.21, 0],
          [0.2, 0.012],
          [0.1, 0.02],
        ]),
        paint: 'hat',
      },
      {
        name: 'crown',
        parent: 'brim',
        at: [0, 0.01, 0],
        tail: [0, 0.11, 0],
        girth: 0.2,
        shape: lathe(
          [
            [0.095, 0],
            [0.088, 0.085],
            [0.06, 0.108],
            [0, 0.112],
          ],
          1,
          { scale: [0.92, 1, 1] }
        ),
        paint: 'hat',
      },
    ]),
    beret: hatPart('Beret', [
      { name: 'beret', roles: ['root'], at: [0.018, -0.01, -0.01], turn: [0, 0, -10], girth: 0.22, shape: { kind: 'sphere', radius: 0.11, scale: [1.06, 0.36, 1] }, paint: 'hat' },
    ]),
    headband: hatPart('Headband', [], [{ id: 'band', bones: ['@host'], where: { band: { s: [0.66, 0.75] } }, paint: 'hat', layer: 6 }]),
    circlet: hatPart('Circlet', [
      {
        name: 'band',
        roles: ['root'],
        at: [0, -0.07, 0.004],
        tail: [0, 0.02, 0],
        girth: 0.2,
        shape: lathe(
          [
            [0.084, 0],
            [0.087, 0.01],
            [0.084, 0.02],
          ],
          1,
          { scale: [1, 1, 1.14] }
        ),
        paint: 'accent',
      },
      { name: 'gem', parent: 'band', at: [0, 0.01, 0.097], girth: 0.02, shape: { kind: 'sphere', radius: 0.008 }, paint: 'gear' },
    ]),
    // Glasses (4): two round lenses, two square ones, one band, one lens.
    roundGlasses: {
      fits: ['glasses'],
      label: 'Round',
      bones: [lensBone('lensLeft', [0.031, 0, 0], ellipse(0, 0, 0.017, 0.017, 12)), lensBone('lensRight', [-0.031, 0, 0], ellipse(0, 0, 0.017, 0.017, 12))],
    },
    squareGlasses: { fits: ['glasses'], label: 'Square', bones: [lensBone('lensLeft', [0.032, 0, 0], rectangle(0.02, 0.014)), lensBone('lensRight', [-0.032, 0, 0], rectangle(0.02, 0.014))] },
    visor: {
      fits: ['glasses'],
      label: 'Visor',
      bones: [
        lensBone(
          'band',
          [0, 0, 0.004],
          [
            [-0.075, -0.014],
            [0.075, -0.014],
            [0.07, 0.016],
            [-0.07, 0.016],
          ]
        ),
      ],
    },
    monocle: { fits: ['glasses'], label: 'Monocle', bones: [lensBone('lens', [-0.031, 0, 0], ellipse(0, 0, 0.018, 0.018, 12))] },
    // Earrings (3): studs, drops that hang lower, long dangles.
    studs: earringPart('Studs', { kind: 'sphere', radius: 0.004 }, 0.006),
    drops: earringPart('Drops', { kind: 'sphere', radius: 0.007, scale: [1, 1.3, 1] }, 0.01, [0.012, 0.016]),
    dangles: earringPart('Dangles', { kind: 'capsule', end: [0, -0.035, 0], radius: 0.003, taper: 2 }, 0.009, [0.01, 0.04]),
    // On the back (4): a pack, a satchel, a quiver, a bedroll.
    backpack: { fits: ['back'], label: 'Backpack', bones: [{ name: 'pack', roles: ['root'], at: [0, -0.06, -0.06], girth: 0.25, shape: { kind: 'box', size: [0.25, 0.32, 0.12] }, paint: 'gear' }] },
    satchel: {
      fits: ['back'],
      label: 'Satchel',
      bones: [{ name: 'bag', roles: ['root'], at: [0.15, -0.36, 0.0], turn: [0, -30, 0], girth: 0.2, shape: { kind: 'box', size: [0.2, 0.15, 0.07] }, paint: 'gear' }],
    },
    quiver: {
      fits: ['back'],
      label: 'Quiver',
      bones: [{ name: 'quiver', roles: ['root'], at: [0.08, -0.22, -0.02], turn: [0, 0, 22], tail: [0, 0.5, 0], girth: 0.09, shape: { kind: 'capsule', radius: 0.042 }, paint: 'gear' }],
    },
    bedroll: {
      fits: ['back'],
      label: 'Bedroll',
      bones: [{ name: 'roll', roles: ['root'], at: [-0.17, 0.12, -0.04], tail: [0.34, 0, 0], girth: 0.12, shape: { kind: 'capsule', radius: 0.06 }, paint: 'gear' }],
    },
    // Held (6): a staff, a lantern (its flame socket is required), a book, a short blade, an umbrella, a mug.
    staff: heldPart('Staff', [
      { name: 'pole', roles: ['root'], at: [0, 0.7, 0], tail: [0, -1.5, 0], girth: 0.03, shape: { kind: 'capsule', radius: 0.015 }, paint: 'gear' },
      { name: 'knob', parent: 'pole', at: [0, 0.03, 0], girth: 0.06, shape: { kind: 'sphere', radius: 0.03 }, paint: 'accent' },
    ]),
    lantern: heldPart(
      'Lantern',
      [
        { name: 'handle', roles: ['root'], at: [0, 0, 0], tail: [0, -0.08, 0], girth: 0.01, shape: { kind: 'capsule', radius: 0.004 }, paint: 'accent' },
        { name: 'cage', parent: 'handle', at: [0, -0.08, 0], tail: [0, -0.14, 0], girth: 0.1, shape: { kind: 'box', size: [0.09, 0.14, 0.09], at: [0, -0.07, 0] }, paint: 'accent' },
      ],
      { sockets: [{ name: 'flame', bone: 'cage', type: 'flame', at: [0, -0.07, 0], required: true }] }
    ),
    candle: { fits: ['flame'], label: 'Candle', bones: [{ name: 'wick', roles: ['root'], tail: [0, 0.03, 0], girth: 0.02, shape: { kind: 'capsule', radius: 0.008, taper: 0.2 }, paint: 'accent' }] },
    glowstone: { fits: ['flame'], label: 'Glowstone', bones: [{ name: 'stone', roles: ['root'], girth: 0.04, shape: { kind: 'sphere', radius: 0.022 }, paint: 'accent' }] },
    book: heldPart('Book', [{ name: 'book', roles: ['root'], at: [0, -0.04, 0.06], girth: 0.15, shape: { kind: 'box', size: [0.035, 0.21, 0.15] }, paint: 'gear' }]),
    shortBlade: heldPart('Short blade', [
      {
        name: 'blade',
        roles: ['root'],
        at: [0, 0, 0.02],
        tail: [0, 0, 0.42],
        girth: 0.04,
        shape: {
          kind: 'extrude',
          outline: [
            [-0.022, 0],
            [0.022, 0],
            [0.018, 0.36],
            [0, 0.42],
            [-0.018, 0.36],
          ],
          depth: 0.006,
        },
        paint: 'accent',
      },
    ]),
    umbrella: heldPart('Umbrella', [
      { name: 'shaft', roles: ['root'], at: [0, -0.1, 0], tail: [0, 0.95, 0], girth: 0.02, shape: { kind: 'capsule', radius: 0.008 }, paint: 'gear' },
      {
        name: 'canopy',
        parent: 'shaft',
        at: [0, 0.95, 0],
        tail: [0, -0.22, 0],
        girth: 0.8,
        shape: lathe([
          [0, 0],
          [0.3, 0.12],
          [0.44, 0.22],
        ]),
        paint: 'accent',
      },
    ]),
    mug: heldPart('Mug', [
      {
        name: 'mug',
        roles: ['root'],
        at: [0, -0.05, 0.05],
        tail: [0, 0.09, 0],
        girth: 0.08,
        shape: lathe([
          [0.035, 0],
          [0.04, 0.09],
          [0, 0.09],
        ]),
        paint: 'gear',
      },
    ]),

    // Traits of the variants: tails (3), horns (3), wings (1).
    tail: {
      fits: ['tail'],
      label: 'Tail',
      bones: chain(
        'tail',
        [0, 0, 0],
        [
          [0, -0.12, -0.14],
          [0, -0.06, -0.18],
          [0, 0.02, -0.18],
          [0, 0.06, -0.14],
        ],
        [0.07, 0.055, 0.04, 0.025],
        ['tail']
      ),
    },
    tuftTail: {
      fits: ['tail'],
      label: 'Tufted tail',
      bones: [
        ...chain(
          'tail',
          [0, 0, 0],
          [
            [0, -0.14, -0.12],
            [0, -0.1, -0.2],
            [0, -0.02, -0.2],
          ],
          [0.05, 0.04, 0.03],
          ['tail']
        ),
        { name: 'tuft', parent: 'tail3', at: [0, -0.02, -0.2], girth: 0.12, roles: ['tail'], shape: { kind: 'sphere', radius: 0.06, scale: [0.8, 0.8, 1.3] }, paint: 'hair' },
      ],
    },
    spadeTail: {
      fits: ['tail'],
      label: 'Spade tail',
      bones: [
        ...chain(
          'tail',
          [0, 0, 0],
          [
            [0, -0.1, -0.16],
            [0, -0.04, -0.2],
            [0, 0.04, -0.18],
          ],
          [0.05, 0.04, 0.03],
          ['tail']
        ),
        {
          name: 'spade',
          parent: 'tail3',
          at: [0, 0.04, -0.18],
          turn: [0, 90, 0],
          tail: [0, 0.1, 0],
          roles: ['tail', 'tip'],
          girth: 0.1,
          shape: {
            kind: 'extrude',
            outline: [
              [0, 0],
              [0.07, 0.04],
              [0, 0.12],
              [-0.07, 0.04],
            ],
            depth: 0.012,
          },
          paint: 'skin',
        },
      ],
    },
    hornNubs: {
      fits: ['horns'],
      label: 'Nubs',
      bones: SIDES.map(({ suffix, sign, role }) => ({
        name: `horn${suffix}`,
        roles: ['root', role],
        at: [0.045 * sign, 0, 0.01],
        tail: [0, 0.045, 0],
        girth: 0.04,
        shape: lathe([
          [0.018, 0],
          [0, 0.045],
        ]),
        paint: 'accent',
      })),
    },
    hornsSwept: {
      fits: ['horns'],
      label: 'Swept',
      bones: SIDES.flatMap(({ suffix, sign, role }) => [
        {
          name: `horn${suffix}`,
          roles: ['root', role],
          at: [0.05 * sign, 0, 0.0],
          turn: [-35, 0, -18 * sign],
          tail: [0, 0.07, 0],
          girth: 0.05,
          shape: lathe([
            [0.02, 0],
            [0.014, 0.07],
          ]),
          paint: 'accent',
        },
        {
          name: `horn${suffix}Tip`,
          parent: `horn${suffix}`,
          roles: [role, 'tip'],
          at: [0, 0.07, 0],
          turn: [-40, 0, 0],
          tail: [0, 0.09, 0],
          girth: 0.03,
          shape: lathe([
            [0.014, 0],
            [0, 0.09],
          ]),
          paint: 'accent',
        },
      ]),
    },
    hornsRam: {
      fits: ['horns'],
      label: 'Curled',
      bones: SIDES.flatMap(({ suffix, sign, role }) => [
        {
          name: `horn${suffix}`,
          roles: ['root', role],
          at: [0.065 * sign, -0.02, -0.01],
          turn: [-70, 0, -60 * sign],
          tail: [0, 0.06, 0],
          girth: 0.05,
          shape: lathe([
            [0.022, 0],
            [0.019, 0.06],
          ]),
          paint: 'accent',
        },
        {
          name: `horn${suffix}Mid`,
          parent: `horn${suffix}`,
          roles: [role],
          at: [0, 0.06, 0],
          turn: [-75, 0, 0],
          tail: [0, 0.06, 0],
          girth: 0.04,
          shape: lathe([
            [0.019, 0],
            [0.014, 0.06],
          ]),
          paint: 'accent',
        },
        {
          name: `horn${suffix}Tip`,
          parent: `horn${suffix}Mid`,
          roles: [role, 'tip'],
          at: [0, 0.06, 0],
          turn: [-75, 0, 0],
          tail: [0, 0.05, 0],
          girth: 0.03,
          shape: lathe([
            [0.014, 0],
            [0, 0.05],
          ]),
          paint: 'accent',
        },
      ]),
    },
    featherWings: {
      fits: ['back'],
      label: 'Feathered wings',
      bones: SIDES.flatMap(({ suffix, sign, role }) => [
        {
          name: `wing${suffix}`,
          roles: ['root', 'wing', role],
          at: [0.06 * sign, 0.08, -0.03],
          turn: [0, -20 * sign, -55 * sign],
          tail: [0, 0.5, 0],
          girth: 0.05,
          shape: {
            kind: 'extrude',
            outline: [
              [-0.04, 0],
              [0.04, 0],
              [0.16, 0.42],
              [0, 0.5],
              [-0.08, 0.3],
            ],
            depth: 0.015,
          },
          paint: 'hair',
        },
      ]),
    },
  };

  // ---- palettes: curated ramps per channel -------------------------------------------------------------------------------

  /** A skin ramp: low saturation that lifts in the mid tones, a warm hue drift. */
  const skinTone = (id, hue, darkest, lightest, saturation = 0.42) => ramp(id, hue, { saturation, darkest, lightest, hueShift: 0.03 });

  /**
   * Palettes by name. Ten natural skins from pale to deep, eight fantasy skins, ten hair colours (six natural,
   * two greys, two dyes), eight irises, four eye whites, six lip tones, twelve dyes for cloth, six leathers,
   * six metals and stones, four inks.
   */
  const PALETTES = {
    skins: [
      skinTone('porcelain', 0.07, 0.42, 0.93, 0.35),
      skinTone('rosy', 0.03, 0.4, 0.9, 0.42),
      skinTone('peach', 0.06, 0.38, 0.88),
      skinTone('sand', 0.09, 0.36, 0.85, 0.38),
      skinTone('honey', 0.08, 0.3, 0.78, 0.5),
      skinTone('olive', 0.11, 0.28, 0.72, 0.32),
      skinTone('tawny', 0.065, 0.24, 0.68, 0.5),
      skinTone('umber', 0.06, 0.16, 0.56, 0.45),
      skinTone('mahogany', 0.03, 0.12, 0.46, 0.45),
      skinTone('ebony', 0.05, 0.07, 0.36, 0.35),
    ],
    fantasySkins: [
      skinTone('ash', 0.6, 0.2, 0.75, 0.08),
      skinTone('slate', 0.6, 0.18, 0.66, 0.3),
      skinTone('moss', 0.28, 0.18, 0.66, 0.3),
      skinTone('ember', 0.01, 0.18, 0.62, 0.55),
      skinTone('dusk', 0.76, 0.16, 0.62, 0.32),
      skinTone('sea', 0.47, 0.2, 0.7, 0.35),
      skinTone('peach', 0.06, 0.38, 0.88),
      skinTone('umber', 0.06, 0.16, 0.56, 0.45),
    ],
    hairs: [
      ramp('ink', 0.62, { saturation: 0.15, darkest: 0.05, lightest: 0.3 }),
      ramp('espresso', 0.06, { saturation: 0.35, darkest: 0.08, lightest: 0.38 }),
      ramp('chestnut', 0.05, { saturation: 0.5, darkest: 0.14, lightest: 0.52 }),
      ramp('auburn', 0.02, { saturation: 0.6, darkest: 0.16, lightest: 0.55 }),
      ramp('copper', 0.06, { saturation: 0.75, darkest: 0.24, lightest: 0.66 }),
      ramp('wheat', 0.12, { saturation: 0.55, darkest: 0.36, lightest: 0.86 }),
      ramp('silver', 0.6, { saturation: 0.06, darkest: 0.38, lightest: 0.92 }),
      ramp('ash', 0.1, { saturation: 0.1, darkest: 0.24, lightest: 0.7 }),
      ramp('teal', 0.5, { saturation: 0.55, darkest: 0.14, lightest: 0.6 }),
      ramp('rose', 0.93, { saturation: 0.5, darkest: 0.3, lightest: 0.8 }),
    ],
    irises: [
      ramp('brown', 0.07, { saturation: 0.5, darkest: 0.08, lightest: 0.5 }),
      ramp('hazel', 0.11, { saturation: 0.45, darkest: 0.12, lightest: 0.58 }),
      ramp('amber', 0.1, { saturation: 0.8, darkest: 0.16, lightest: 0.66 }),
      ramp('green', 0.33, { saturation: 0.45, darkest: 0.1, lightest: 0.6 }),
      ramp('grey', 0.58, { saturation: 0.1, darkest: 0.14, lightest: 0.7 }),
      ramp('blue', 0.58, { saturation: 0.55, darkest: 0.12, lightest: 0.7 }),
      ramp('violet', 0.75, { saturation: 0.45, darkest: 0.12, lightest: 0.66 }),
      ramp('gold', 0.13, { saturation: 0.9, darkest: 0.22, lightest: 0.78 }),
    ],
    whites: [
      ramp('ivory', 0.11, { saturation: 0.15, darkest: 0.7, lightest: 0.96 }),
      ramp('cool', 0.58, { saturation: 0.15, darkest: 0.7, lightest: 0.97 }),
      ramp('void', 0.7, { saturation: 0.2, darkest: 0.04, lightest: 0.2 }),
      ramp('ember', 0.08, { saturation: 0.8, darkest: 0.4, lightest: 0.8 }),
    ],
    lipTones: [
      ramp('nude', 0.04, { saturation: 0.35, darkest: 0.18, lightest: 0.7 }),
      ramp('rose', 0.98, { saturation: 0.45, darkest: 0.2, lightest: 0.72 }),
      ramp('berry', 0.93, { saturation: 0.5, darkest: 0.12, lightest: 0.55 }),
      ramp('coral', 0.03, { saturation: 0.6, darkest: 0.24, lightest: 0.75 }),
      ramp('mauve', 0.85, { saturation: 0.25, darkest: 0.16, lightest: 0.62 }),
      ramp('umber', 0.06, { saturation: 0.4, darkest: 0.1, lightest: 0.48 }),
    ],
    dyes: [
      ramp('navy', 0.62, { saturation: 0.5, darkest: 0.1, lightest: 0.5 }),
      ramp('crimson', 0.98, { saturation: 0.65 }),
      ramp('forest', 0.37, { saturation: 0.45, darkest: 0.1, lightest: 0.6 }),
      ramp('mustard', 0.13, { saturation: 0.7 }),
      ramp('plum', 0.83, { saturation: 0.4, darkest: 0.12, lightest: 0.62 }),
      ramp('teal', 0.5, { saturation: 0.55 }),
      ramp('rust', 0.04, { saturation: 0.6 }),
      ramp('charcoal', 0.62, { saturation: 0.08, darkest: 0.1, lightest: 0.48 }),
      ramp('cream', 0.12, { saturation: 0.3, darkest: 0.45, lightest: 0.94 }),
      ramp('sky', 0.56, { saturation: 0.5, darkest: 0.3, lightest: 0.86 }),
      ramp('olive', 0.2, { saturation: 0.4 }),
      ramp('coral', 0.02, { saturation: 0.7, darkest: 0.3, lightest: 0.85 }),
    ],
    leathers: [
      ramp('tan', 0.08, { saturation: 0.45, darkest: 0.2, lightest: 0.7 }),
      ramp('brown', 0.06, { saturation: 0.4, darkest: 0.1, lightest: 0.48 }),
      ramp('black', 0.62, { saturation: 0.08, darkest: 0.05, lightest: 0.32 }),
      ramp('oxblood', 0.99, { saturation: 0.5, darkest: 0.1, lightest: 0.45 }),
      ramp('suede', 0.1, { saturation: 0.15, darkest: 0.25, lightest: 0.7 }),
      ramp('canvas', 0.12, { saturation: 0.12, darkest: 0.5, lightest: 0.95 }),
    ],
    metals: [
      ramp('gold', 0.12, { saturation: 0.75, darkest: 0.2, lightest: 0.85 }),
      ramp('silver', 0.6, { saturation: 0.06, darkest: 0.3, lightest: 0.95 }),
      ramp('copper', 0.05, { saturation: 0.65, darkest: 0.18, lightest: 0.75 }),
      ramp('bronze', 0.09, { saturation: 0.5, darkest: 0.15, lightest: 0.68 }),
      ramp('jade', 0.4, { saturation: 0.45, darkest: 0.15, lightest: 0.72 }),
      ramp('garnet', 0.97, { saturation: 0.65, darkest: 0.1, lightest: 0.6 }),
    ],
    inks: [
      ramp('soot', 0.62, { saturation: 0.1, darkest: 0.08, lightest: 0.4 }),
      ramp('ochre', 0.08, { saturation: 0.55, darkest: 0.2, lightest: 0.6 }),
      ramp('woad', 0.6, { saturation: 0.5, darkest: 0.15, lightest: 0.6 }),
      ramp('cinnabar', 0.01, { saturation: 0.65, darkest: 0.2, lightest: 0.6 }),
    ],
  };

  // ---- dials --------------------------------------------------------------------------------------------------------------

  /** Shorthand for dial rows: a range and what it drives (default value 1, a multiplier). */
  const dial = (min, max, affects, extra = {}) => ({ min, max, affects, ...extra });
  /** An offset dial (default 0): degrees or metres added. */
  const offset = (min, max, affects, extra = {}) => ({ min, max, default: 0, affects: affects.map((effect) => ({ mode: 'offset', ...effect })), ...extra });
  const LIMB_GIRTH = (names) => [{ bones: names, channel: 'girth' }];
  const bothSides = (stem) => SIDES.map(({ suffix }) => `${stem}${suffix}`);

  /**
   * Body-shape dials, grouped head / face / body / arms / legs. 'sided' ones may differ left and right.
   * Ranges are the base species'; variants narrow them, and the `humanoid` node's limits hold every variant.
   */
  const DIALS = {
    // body
    height: dial(0.88, 1.12, [{ roles: ['root'], channel: 'size' }]),
    build: dial(0.85, 1.25, [{ roles: ['spine'], channel: 'girth' }]),
    belly: dial(0.88, 1.35, [{ bones: ['waist'], channel: 'girth' }]),
    chest: dial(0.88, 1.25, [
      { bones: ['chest'], shape: 'scale.2' },
      { bones: ['chest'], shape: 'profile.2.0', amount: 0.5 },
    ]),
    shoulders: dial(0.8, 1.25, [
      { bones: bothSides('clavicle'), channel: 'length' },
      { bones: ['chest'], shape: 'profile.3.0', amount: 0.5 },
    ]),
    hips: dial(0.8, 1.3, [
      { bones: bothSides('hip'), channel: 'length' },
      { bones: ['pelvis'], shape: 'profile.1.0', amount: 0.6 },
      { bones: ['pelvis'], shape: 'profile.2.0', amount: 0.6 },
    ]),
    torso: dial(0.88, 1.15, [{ bones: ['waist', 'chest'], channel: 'length' }]),
    posture: offset(-1, 1, [{ bones: ['waist', 'chest', 'neck'], channel: 'pitch', amount: 7 }]),
    muscle: dial(0.85, 1.3, [
      { roles: ['arm'], channel: 'girth', amount: 0.8 },
      { roles: ['leg'], channel: 'girth', amount: 0.6 },
    ]),
    // head
    headSize: dial(0.9, 1.15, [{ roles: ['head'], channel: 'size' }]),
    headLength: dial(0.92, 1.1, [{ roles: ['head'], channel: 'length' }]),
    headWidth: dial(0.88, 1.12, [{ roles: ['head'], shape: 'scale.0' }]),
    headDepth: dial(0.9, 1.12, [{ roles: ['head'], shape: 'scale.2' }]),
    neckLength: dial(0.7, 1.4, [{ roles: ['neck'], channel: 'length' }]),
    neckWidth: dial(0.8, 1.35, [{ roles: ['neck'], channel: 'girth' }]),
    // face: the head's profile, then the features
    jaw: dial(0.8, 1.25, [
      { roles: ['head'], shape: 'profile.1.0' },
      { roles: ['head'], shape: 'profile.2.0', amount: 0.6 },
    ]),
    chin: dial(0.55, 1.5, [{ roles: ['head'], shape: 'profile.0.0' }]),
    cheeks: dial(0.9, 1.12, [{ roles: ['head'], shape: 'profile.3.0' }]),
    cranium: dial(0.85, 1.15, [
      { roles: ['head'], shape: 'profile.4.0', amount: 0.5 },
      { roles: ['head'], shape: 'profile.5.0' },
      { roles: ['head'], shape: 'profile.6.0' },
    ]),
    eyeSize: dial(0.75, 1.35, [{ feature: 'eye', param: 'size' }], { sided: true }),
    eyeSpacing: dial(0.8, 1.25, [
      { feature: 'eye', param: 'spacing' },
      { feature: 'brow', param: 'spacing', amount: 0.7 },
    ]),
    eyeHeight: offset(-6, 6, [
      { feature: 'eye', param: 'elevation' },
      { feature: 'brow', param: 'elevation', amount: 0.8 },
    ]),
    eyeTilt: offset(-15, 15, [{ feature: 'eye', param: 'rotation' }]),
    browHeight: offset(-4, 6, [{ feature: 'brow', param: 'elevation' }], { sided: true }),
    browTilt: offset(-20, 20, [{ feature: 'brow', param: 'rotation' }]),
    noseSize: dial(0.7, 1.5, [{ feature: 'nose', param: 'size' }]),
    noseLength: offset(-0.003, 0.01, [{ feature: 'nose', param: 'lift' }]),
    noseHeight: offset(-5, 5, [{ feature: 'nose', param: 'elevation' }]),
    mouthWidth: dial(0.75, 1.35, [{ feature: 'mouth', param: 'size.0' }]),
    lips: dial(0.7, 1.5, [{ feature: 'mouth', param: 'size.1' }]),
    mouthHeight: offset(-5, 4, [{ feature: 'mouth', param: 'elevation' }]),
    earSize: dial(0.75, 1.4, [{ feature: 'ear', param: 'size' }], { sided: true }),
    earHeight: offset(-8, 8, [
      { feature: 'ear', param: 'elevation' },
      { feature: 'earring', param: 'elevation' },
    ]),
    earAngle: offset(-25, 25, [{ feature: 'ear', param: 'rotation' }]),
    // arms
    armLength: dial(0.9, 1.12, [{ roles: ['arm'], channel: 'length' }]),
    upperArms: dial(0.8, 1.4, LIMB_GIRTH(bothSides('upperArm'))),
    forearms: dial(0.8, 1.35, LIMB_GIRTH(bothSides('forearm'))),
    handSize: dial(0.85, 1.2, [{ roles: ['hand'], channel: 'size' }], { sided: true }),
    // legs
    legLength: dial(0.9, 1.12, [{ roles: ['leg'], channel: 'length' }]),
    thighs: dial(0.8, 1.4, LIMB_GIRTH(bothSides('thigh'))),
    calves: dial(0.8, 1.35, LIMB_GIRTH(bothSides('shin'))),
    footSize: dial(0.85, 1.2, [{ roles: ['foot'], channel: 'size' }]),
  };

  // ---- creator metadata: groups, labels, hints, icons, order ------------------------------------------------------------

  /** Editor groups in display order: group -> [label, icon]. */
  const GROUPS = {
    head: ['Head', 'head'],
    face: ['Face', 'face'],
    body: ['Body', 'figure'],
    arms: ['Arms', 'arm'],
    legs: ['Legs', 'leg'],
    hair: ['Hair', 'scissors'],
    outfit: ['Outfit', 'shirt'],
    accessories: ['Accessories', 'gem'],
    traits: ['Traits', 'horn'],
    colors: ['Colours', 'palette'],
  };
  /** Which group each dial is listed under (the rest of its metadata is generated from the id unless stated below). */
  const DIAL_GROUPS = {
    body: ['height', 'build', 'belly', 'chest', 'shoulders', 'hips', 'torso', 'posture', 'muscle'],
    head: ['headSize', 'headLength', 'headWidth', 'headDepth', 'neckLength', 'neckWidth'],
    face: [
      'jaw',
      'chin',
      'cheeks',
      'cranium',
      'eyeSize',
      'eyeSpacing',
      'eyeHeight',
      'eyeTilt',
      'browHeight',
      'browTilt',
      'noseSize',
      'noseLength',
      'noseHeight',
      'mouthWidth',
      'lips',
      'mouthHeight',
      'earSize',
      'earHeight',
      'earAngle',
    ],
    arms: ['armLength', 'upperArms', 'forearms', 'handSize'],
    legs: ['legLength', 'thighs', 'calves', 'footSize'],
  };
  /** Hints for dials whose name alone does not say what they do. */
  const DIAL_HINTS = {
    build: 'Width and depth of the whole torso.',
    belly: 'Fullness at the waist.',
    chest: 'Depth of the chest and ribcage.',
    torso: 'Length from hips to shoulders.',
    posture: 'Upright to stooped.',
    cranium: 'Fullness of the back and top of the skull.',
    noseLength: 'How far the nose stands out.',
    lips: 'Fullness of the lips.',
    earAngle: 'Tilts the ears back or forward.',
  };
  /** Sockets as creator controls: socket -> [group, label, order within the group]. */
  const SLOTS = {
    eyes: ['face', 'Eyes', 10],
    brows: ['face', 'Brows', 11],
    nose: ['face', 'Nose', 12],
    mouth: ['face', 'Mouth', 13],
    ears: ['face', 'Ears', 14],
    marks: ['face', 'Marks', 15],
    hair: ['hair', 'Hairstyle', 1],
    facialHair: ['hair', 'Facial hair', 2],
    top: ['outfit', 'Top', 1],
    bottom: ['outfit', 'Bottom', 2],
    footwear: ['outfit', 'Footwear', 3],
    outerwear: ['outfit', 'Outerwear', 4],
    gloves: ['outfit', 'Gloves', 5],
    hat: ['accessories', 'Headwear', 1],
    glasses: ['accessories', 'Glasses', 2],
    earrings: ['accessories', 'Earrings', 3],
    back: ['accessories', 'On the back', 4],
    handLeft: ['accessories', 'Left hand', 5],
    handRight: ['accessories', 'Right hand', 6],
    'handLeft/flame': ['accessories', 'Left lantern flame', 7],
    'handRight/flame': ['accessories', 'Right lantern flame', 8],
    horns: ['traits', 'Horns', 1],
    tail: ['traits', 'Tail', 2],
  };
  /** Colour channels as creator controls: channel -> [label, order]. */
  const CHANNEL_LABELS = {
    skin: ['Skin', 1],
    hair: ['Hair', 2],
    eyes: ['Eyes', 3],
    sclera: ['Eye whites', 4],
    lips: ['Lips', 5],
    marks: ['Marks', 6],
    top: ['Top', 7],
    bottom: ['Bottom', 8],
    footwear: ['Footwear', 9],
    outerwear: ['Outerwear', 10],
    gloves: ['Gloves', 11],
    hat: ['Headwear', 12],
    gear: ['Leather and gear', 13],
    accent: ['Accent', 14],
  };

  const CONTROLS = {
    ...Object.fromEntries(
      Object.keys(DIAL_GROUPS).flatMap((group) => DIAL_GROUPS[group].map((id, index) => [`dial:${id}`, { group, order: index + 1, ...(DIAL_HINTS[id] ? { hint: DIAL_HINTS[id] } : {}) }]))
    ),
    ...Object.fromEntries(Object.keys(SLOTS).map((socket) => [`fill:${socket}`, { group: SLOTS[socket][0], label: SLOTS[socket][1], order: SLOTS[socket][2] }])),
    ...Object.fromEntries(
      Object.keys(CHANNEL_LABELS).map((channel) => [`color:${channel}`, { group: 'colors', label: CHANNEL_LABELS[channel][0], order: CHANNEL_LABELS[channel][1], icon: 'swatch' }])
    ),
  };

  // ---- species ------------------------------------------------------------------------------------------------------------

  /** Socket fills of the base species: weights per option ('none' leaves it empty). */
  const FILLS = {
    eyes: { eyesRound: 1, eyesAlmond: 1, eyesNarrow: 1, eyesDowncast: 1, eyesUpturned: 1 },
    brows: { browsStraight: 3, browsArched: 3, browsHeavy: 2, browsRising: 2, browsFine: 2, none: 1 },
    nose: { noseButton: 1, noseStraight: 1, nosePointed: 1, noseBroad: 1, noseHooked: 1 },
    mouth: { mouthNeutral: 2, mouthWide: 1, mouthFull: 1, mouthSmall: 1, mouthSmirk: 1 },
    ears: { earsRound: 3, earsSmall: 2, earsLarge: 2, earsPointed: 1 },
    marks: { none: 6, freckles: 2, blush: 2, scar: 1, mole: 1, stripes: 1 },
    hair: { hairCrop: 2, hairBuzz: 1, hairSwept: 2, hairBob: 2, hairLong: 2, hairPonytail: 2, hairBun: 1, hairCrest: 1, hairCurls: 2, hairBraids: 1, none: 1 },
    facialHair: { none: 8, stubble: 2, moustache: 1, beard: 2, chinTuft: 1 },
    top: { tee: 3, longSleeve: 3, tank: 2, stripedKnit: 2, cropTop: 1, tunic: 2 },
    bottom: { trousers: 4, shorts: 2, skirt: 2, longSkirt: 1, leggings: 2 },
    footwear: { shoes: 3, boots: 3, tallBoots: 1, sandals: 1, none: 1 },
    outerwear: { none: 5, jacket: 2, vest: 1, cloak: 1, longCoat: 1, hoodie: 2, scarf: 1 },
    gloves: { none: 8, gloves: 1, fingerless: 1, gauntlets: 1, bracers: 1 },
    hat: { none: 6, cap: 1, beanie: 1, wideBrim: 1, beret: 1, headband: 1, circlet: 1 },
    glasses: { none: 8, roundGlasses: 1, squareGlasses: 1, visor: 1, monocle: 1 },
    earrings: { none: 6, studs: 1, drops: 1, dangles: 1 },
    back: { none: 6, backpack: 1, satchel: 1, quiver: 1, bedroll: 1 },
    handLeft: { none: 8, staff: 1, lantern: 1, book: 1, mug: 1 },
    handRight: { none: 7, shortBlade: 1, umbrella: 1, book: 1, staff: 1, lantern: 1 },
  };

  /** The channels of the base species and the palette each draws from. */
  const COLORS = {
    skin: 'skins',
    hair: 'hairs',
    eyes: 'irises',
    sclera: 'whites',
    lips: 'lipTones',
    marks: 'inks',
    top: 'dyes',
    bottom: 'dyes',
    footwear: 'leathers',
    outerwear: 'dyes',
    gloves: 'leathers',
    hat: 'dyes',
    gear: 'leathers',
    accent: 'metals',
  };

  /** Traits: the non-human pieces, pulled in by a variant. */
  const TRAITS = {
    horned: { set: { fills: { horns: { hornNubs: 1, hornsSwept: 2, hornsRam: 2 } } } },
    tailed: { set: { fills: { tail: { tail: 2, tuftTail: 1, spadeTail: 1 } } } },
    winged: { set: { fills: { back: { featherWings: 1 } } } },
  };

  /**
   * The lineage: `humanoid` (abstract: the plan, every dial, channel, fill and control, and the limits every
   * variant is held to) -> `person` (the base species) -> `stout`, `lanky` and `hornkin` (variants).
   */
  const NODES = {
    humanoid: {
      set: {
        plan: 'person',
        dials: DIALS,
        colors: COLORS,
        fills: FILLS,
        controls: CONTROLS,
        groups: Object.fromEntries(Object.keys(GROUPS).map((group, index) => [group, { label: GROUPS[group][0], icon: GROUPS[group][1], order: index + 1 }])),
      },
      // Every variant stays a recognisable person: these bounds hold all of them (Kit.lineage enforces it).
      limits: { 'dials.height': { min: 0.8, max: 1.25 }, 'dials.headSize': { min: 0.85, max: 1.25 }, 'dials.armLength': { min: 0.85, max: 1.2 }, 'dials.legLength': { min: 0.85, max: 1.2 } },
    },
    person: { parent: 'humanoid', set: { code: 10 } },
    // Stocky: shorter, broader, thicker-limbed, with narrower ranges so every roll reads as stout.
    stout: {
      parent: 'humanoid',
      set: {
        code: 11,
        dials: {
          height: { min: 0.82, max: 0.95, default: 0.88 },
          build: { min: 1.1, max: 1.3, default: 1.15 },
          shoulders: { min: 1.05, max: 1.3, default: 1.1 },
          muscle: { min: 1.05, max: 1.35, default: 1.15 },
          legLength: { min: 0.86, max: 0.98, default: 0.92 },
          neckLength: { min: 0.7, max: 1, default: 0.85 },
          neckWidth: { min: 1.05, max: 1.4, default: 1.2 },
          jaw: { min: 1, max: 1.3, default: 1.1 },
        },
        fills: { facialHair: { none: 3, stubble: 2, moustache: 1, beard: 4, chinTuft: 1 } },
      },
    },
    // Tall and lanky: long limbs and neck, a narrow build.
    lanky: {
      parent: 'humanoid',
      set: {
        code: 12,
        dials: {
          height: { min: 1.05, max: 1.2, default: 1.1 },
          build: { min: 0.8, max: 0.98, default: 0.9 },
          muscle: { min: 0.8, max: 1, default: 0.9 },
          belly: { min: 0.85, max: 1.05 },
          armLength: { min: 1.02, max: 1.16, default: 1.08 },
          legLength: { min: 1.04, max: 1.18, default: 1.1 },
          neckLength: { min: 1.05, max: 1.45, default: 1.2 },
          headWidth: { min: 0.86, max: 1 },
        },
      },
    },
    // The horned, tailed folk: fantasy skins, long or pointed ears, eye whites that may be dark, horns and a tail.
    hornkin: {
      parent: 'humanoid',
      traits: ['horned', 'tailed'],
      set: {
        code: 13,
        colors: { skin: 'fantasySkins' },
        // Fill tables merge key by key down the lineage, so an option is removed by weighting it 0.
        fills: {
          ears: { earsRound: 0, earsSmall: 0, earsLarge: 0, earsPointed: 2, earsLong: 3 },
          glasses: { roundGlasses: 0, squareGlasses: 0, visor: 0, monocle: 0 },
          hat: { cap: 0, beanie: 0, wideBrim: 0, beret: 0, none: 5, headband: 1, circlet: 2 },
        },
        controls: { 'dial:earAngle': { hint: 'Swept back or pricked forward.' } },
      },
    },
  };

  const freezeDeep = (value) => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  };

  Kit.body = Object.assign(Kit.body || {}, {
    wardrobe: freezeDeep({ PLANS, PARTS, PALETTES, NODES, TRAITS, SLOTS, CATALOG: { plans: PLANS, parts: PARTS, palettes: PALETTES, nodes: NODES, traits: TRAITS } }),
  });
})();
