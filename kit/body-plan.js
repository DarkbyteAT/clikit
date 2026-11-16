/**
 * Kit body plan: the skeleton of any kind of thing (a biped, a fish, a sword) compiled from data into flat typed
 * arrays: a joint hierarchy, typed sockets on its bones, role tags, a capability mask that consumers match
 * against, the physical facts of each bone, a shape and a paint channel for renderers, and proportion dials
 * that reshape it. This is the lowest body-specific rung; it is a composition of generic pieces.
 *
 * Owns:  `Kit.body.plan` (compile a plan), the `ROLES` / `CAPABILITIES` / `JOINTS` / `SHAPES` / `CHANNELS`
 *        tables, `requirement` / `fits` / `missing` / `requireFit` (can this plan do what a consumer needs?),
 *        `bonesWithRoles` / `chains` / `groupOf` (find and group bones by role), `createPose` / `copyRest` /
 *        `worldTransforms` / `socketPosition` / `tailPosition` / `lowestY` (a plan's view of `Kit.rig`),
 *        `bendDirection` / `bendAgrees` (which way a knee or an elbow folds, from its limits),
 *        `boneLength` / `boneMasses` / `centerOfMass` (physical quantities that follow the proportions),
 *        `dials` / `applyDials` (proportions) and `socketType` (type ids).
 * Does not own: the transform pass itself (kit/rig.js: `plan.parent` and a pose are all it needs), inverse
 *        kinematics (kit/reach.js, with `plan.jointLimits`), springs and chains (kit/dynamics.js), bitmask
 *        matching (kit/flags.js), attaching parts (kit/body-parts.js), recipes and species (kit/body-recipe.js),
 *        instances (kit/body-store.js), or anything that moves or draws a body.
 *
 * Conventions: units are metres and kilograms, +Y is up, +Z is the way the body faces, +X is the body's left.
 * A pose is a `JointTransforms` of kit/rig.js; see that file for the transform model (a per-bone three-axis
 * scale that is not inherited, plus an inherited one-number size).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  // ---- tables ---------------------------------------------------------------------------------------------------------

  /**
   * Role tags a bone may carry, in bit order. Poses and dials are written against roles, never bone names, so
   * one walk cycle or one "leg length" dial serves every plan that has legs. A bone usually carries several: a
   * left hind foot is leg + foot + left + hind + tip. Adding a role means adding a name (32 at most).
   */
  const ROLE_NAMES = [
    'root', // the bone the rest hangs from, at the point the body stands on
    'spine',
    'neck',
    'head',
    'jaw',
    'arm',
    'hand',
    'leg',
    'foot',
    'wing',
    'tail',
    'fin',
    'left',
    'right',
    'front',
    'hind',
    'primary', // the limb pair that carries the body or does the work; a pose may ignore the others
    'tip', // the last bone of a chain, where the limb ends or touches the ground
    'prop', // belongs to an attached part, not to the body itself
  ];
  const ROLES = Kit.flags(ROLE_NAMES, 'role');

  /**
   * What a plan can offer a consumer, name -> row, in bit order. A row with a `role` is derived: the plan has
   * it when any bone carries that role, and its count is the number of chains (`count: 'chains'`: two legs) or
   * of bones (`count: 'bones'`: five tail segments). A row without a role is declared by the plan's own
   * `capabilities` list. Adding a capability means adding a row (32 at most).
   */
  const CAPABILITY_ROWS = Object.freeze({
    legs: { role: 'leg', count: 'chains' },
    arms: { role: 'arm', count: 'chains' },
    wings: { role: 'wing', count: 'chains' },
    fins: { role: 'fin', count: 'chains' },
    tail: { role: 'tail', count: 'bones' },
    spine: { role: 'spine', count: 'bones' },
    head: { role: 'head', count: 'chains' },
    jaw: { role: 'jaw', count: 'chains' },
    hands: { role: 'hand', count: 'chains' },
    hover: {}, // stays up without wings or legs; declared, never derived
  });
  const CAPABILITIES = Kit.flags(Object.keys(CAPABILITY_ROWS), 'capability');

  /**
   * The part of the body a role belongs to, for grouping dials and sockets in an editor: the first row whose
   * role a bone carries wins, so a hand is 'arms' and a head is 'head'. Anything else is 'body'.
   */
  const ROLE_GROUPS = Object.freeze([
    ['head', 'head'],
    ['jaw', 'head'],
    ['neck', 'head'],
    ['arm', 'arms'],
    ['hand', 'arms'],
    ['leg', 'legs'],
    ['foot', 'legs'],
    ['wing', 'wings'],
    ['tail', 'tail'],
    ['fin', 'fins'],
  ]);
  const DEFAULT_GROUP = 'body';

  /**
   * What a bone looks like, for renderers, kind -> the fields a shape of that kind must give. Shapes live in the
   * bone's own space, so the bone's scale (the dials) deforms them for free. A bone that states no shape is a
   * capsule along its long axis, `girth` thick. Numbers are metres.
   *   capsule: nothing more (length and girth come from the bone)
   *   sphere:  radius
   *   box:     size [x, y, z]
   *   lathe:   profile [[radius, along], ...] spun about the long axis (a hat, a bottle, a torso)
   *   extrude: outline [[across, along], ...] in the plane of the long axis, and depth, its thickness (a blade, a fin)
   *   none:    nothing is drawn (a mount, a ground point)
   * Any shape may add `at` [x, y, z], an offset in the bone's space, and `scale` [x, y, z], a stretch about `at`
   * (an egg-shaped head is a sphere with a scale). A capsule may add `radius` (default girth / 2) and `taper`
   * (the far end's radius over the near end's, default 1). A lathe's `along` and an extrude's run along the bone's
   * positive long axis (a skirt that hangs down states negative heights); an extrude's `across` is
   * `Kit.figure.ACROSS_AXIS` of the long axis (x for a bone along y, y otherwise) unless the shape states `across`,
   * and its depth is the remaining axis. These are the conventions of the figure renderer (kit/figure-shapes.js). Dials may change any number in a shape (`shapesWithDials`).
   */
  const SHAPES = Object.freeze({ capsule: [], sphere: ['radius'], box: ['size'], lathe: ['profile'], extrude: ['outline', 'depth'], none: [] });

  /**
   * Joint types, name -> row: how a bone may turn relative to its rest rotation. `limits` are the default range
   * of each of the bone's own axes in degrees, [x, y, z] as [min, max] pairs; a bone may narrow or replace them
   * with its own `limits`. Inverse kinematics clamps to them and a ragdoll builds its constraints from them.
   * X is pitch (forward and back), Y is twist about an upright bone, Z is roll (sideways).
   */
  const JOINTS = Object.freeze({
    ball: {
      id: 0,
      limits: [
        [-120, 120],
        [-90, 90],
        [-90, 90],
      ],
    }, // a shoulder, a hip, a spine or tail segment
    hinge: {
      id: 1,
      limits: [
        [0, 150],
        [0, 0],
        [0, 0],
      ],
    }, // a knee: bends one way about X; an elbow states [-150, 0]
    fixed: {
      id: 2,
      limits: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    }, // welded to its parent (a brim on a hat)
    free: {
      id: 3,
      limits: [
        [-180, 180],
        [-180, 180],
        [-180, 180],
      ],
    }, // no limit (a root, a prop's mount)
  });
  const DEFAULT_JOINT = 'ball';
  /**
   * Physical defaults. Density is that of water, which flesh is close to; a bone's rest mass is the mass of a
   * cylinder of its length and girth unless the bone states a `mass`. Stiffness is the squared natural
   * frequency (1/s^2) a spring driving the joint towards its target should use, damping is the damping ratio
   * (1 = critical: fastest settle without overshoot).
   */
  const PHYSICAL_DEFAULTS = Object.freeze({ density: 1000, stiffness: 120, damping: 1 });
  /**
   * Kinds of soft bone, name -> the spring hints (and, for a hanging panel, the joint limits) a bone that says
   * `soft: '<kind>'` gets unless it states its own. A soft bone's stiffness is under the loose threshold of
   * `Kit.motion.loose`, so it is simulated: it trails, swings and settles without anyone tuning it. Limits are
   * degrees about the bone's own axes, as `PlanBone.limits`.
   */
  const SOFT_KINDS = Object.freeze({
    hair: Object.freeze({ stiffness: 30, damping: 0.5 }), // a lock or a fringe
    plait: Object.freeze({ stiffness: 25, damping: 0.45 }), // a ponytail, a braid: longer, heavier, slower
    tail: Object.freeze({ stiffness: 25, damping: 0.45 }),
    ear: Object.freeze({ stiffness: 60, damping: 0.6, limits: [[-25, 25], [-10, 10], [-25, 25]] }), // floppy, but it stays an ear
    scarf: Object.freeze({ stiffness: 22, damping: 0.45 }),
    cloak: Object.freeze({ stiffness: 3, damping: 0.5, limits: [[-8, 115], [0, 0], [-60, 60]] }), // a panel hung from the shoulders: nearly limp, so it falls whichever way is down and lies where it lands; never round to the front
    hem: Object.freeze({ stiffness: 70, damping: 0.7, limits: [[-10, 10], [0, 0], [-10, 10]] }), // a skirt or a robe's hem: it sways as one piece, a little
  });
  const CYLINDER_AREA_FACTOR = Math.PI / 4;

  /** Dial channels: what one dial does to a bone it affects. `pitch` turns the bone about its x axis by
   * (value - default) x amount degrees (a posture dial); the others multiply. */
  const CHANNELS = Object.freeze({ length: 0, girth: 1, size: 2, pitch: 3 });
  /**
   * How a shape or feature dial changes the number it drives: `scale` multiplies it by 1 + (value - 1) x amount,
   * as the bone channels do; `offset` adds (value - default) x amount (a tilt in degrees, a shift in metres).
   */
  const PARAM_MODES = Object.freeze({
    scale: (current, value, _preset, amount) => current * (1 + (value - 1) * amount),
    offset: (current, value, preset, amount) => current + (value - preset) * amount,
  });
  const DEFAULT_PARAM_MODE = 'scale';
  /** Joins a sided dial's id and its side: 'eyeSize@left'. */
  const SIDE_SEPARATOR = '@';
  const SIDES = Object.freeze(['left', 'right']);
  /** Separates the steps of a shape or feature parameter path: 'profile.2.0' is point 2's radius. */
  const PARAM_PATH_SEPARATOR = '.';
  const { AXES, VECTOR_STRIDE, QUATERNION_STRIDE } = Kit.rig;
  /** The largest bone count a plan may have: parents are stored as Int16, with -1 for "no parent". */
  const MOST_BONES = 32767;
  const NO_PARENT = -1;
  /** Rest thickness of a bone, metres, when the plan does not give one. Renderers and the girth dial read it. */
  const DEFAULT_GIRTH = 0.06;
  const DEGREES_TO_RADIANS = Math.PI / 180;
  const BITS_IN_MASK = 32;
  /** The `bonePaint` value of a bone that names no paint channel. */
  const UNPAINTED = 0;

  const NAME = 'Kit.body';
  const fail = (where, message) => {
    throw new Error(`${NAME}.${where}: ${message}`);
  };

  // ---- masks: thin names over the two flag sets ----------------------------------------------------------------------

  /**
   * Turns role names into a bitmask.
   * @param {string[]} names role names from `Kit.body.ROLES.names`
   * @returns {number} unsigned 32-bit mask
   * @throws {Error} naming the unknown role and the known ones
   * @complexity O(names)
   * @example Kit.body.roleMask(['leg', 'left']) // matches the bones of the left legs
   */
  const roleMask = (names) => ROLES.mask(names);

  /**
   * The names set in a capability mask, in table order.
   * @param {number} mask
   * @returns {string[]}
   * @complexity O(capabilities)
   * @example Kit.body.capabilityNames(plan.capabilities) // ['legs', 'arms', 'spine', 'head', 'hands']
   */
  const capabilityNames = (mask) => CAPABILITIES.namesOf(mask);

  /**
   * The editor group of a role mask: which part of the body a bone, and so a socket or a dial on it, belongs to.
   * @param {number} mask a bone's roles
   * @returns {string} 'head', 'arms', 'legs', 'wings', 'tail', 'fins' or 'body'
   * @complexity O(groups)
   * @example Kit.body.groupOf(plan.roles[plan.boneIndex('handLeft')]) // 'arms'
   */
  const groupOf = (mask) => {
    const row = ROLE_GROUPS.find(([role]) => mask & (1 << ROLES.bit(role)));
    return row ? row[1] : DEFAULT_GROUP;
  };

  // ---- socket types ---------------------------------------------------------------------------------------------------

  /** Socket type names seen so far; a type's id is its index here plus one (0 is never a type). */
  const socketTypeNames = [];

  /**
   * The numeric id of a socket type, so "does this part fit this socket" is one integer compare. Ids are handed
   * out in order of first use and are only meaningful inside this page load: never save one, save the name.
   * @param {string} name a socket type, e.g. 'grip', 'headTop', 'gem'
   * @returns {number} a positive whole number, the same for the same name
   * @complexity O(types seen) time on first use of a name, O(types) after (a short list search)
   * @example Kit.body.socketType('grip') === Kit.body.socketType('grip') // true
   */
  const socketType = (name) => {
    if (typeof name !== 'string' || !name) fail('socketType', `a socket type is a non-empty string such as 'grip', got ${JSON.stringify(name)}.`);
    const known = socketTypeNames.indexOf(name);
    return (known >= 0 ? known : socketTypeNames.push(name) - 1) + 1;
  };

  /**
   * The name of a socket type id, for error messages and debug views.
   * @param {number} typeId an id from `Kit.body.socketType`
   * @returns {string} the name, or '(unknown)' for an id never handed out
   * @example Kit.body.socketTypeName(plan.socketType[0]) // 'grip'
   */
  const socketTypeName = (typeId) => socketTypeNames[typeId - 1] || '(unknown)';

  // ---- compiling a plan -----------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} BoneSpec
   * @property {string} name unique within the plan; may not contain '.' (and should not contain '/', which
   *   `Kit.body.assemble` uses to prefix the bones of attached parts)
   * @property {string} [parent] name of the parent bone; omitted for a root
   * @property {number[]} [at] [x, y, z] of the joint in the parent bone's space, metres (default [0, 0, 0])
   * @property {number[]} [turn] rest rotation as [x, y, z] degrees, applied X then Y then Z (default none)
   * @property {number[]} [tail] [x, y, z] where the bone ends, in its own space; gives a leaf bone (a head, a
   *   blade) an extent to draw and a long axis (default: no extent)
   * @property {string[]} [roles] role names from `Kit.body.ROLES`
   * @property {('x'|'y'|'z')} [axis] the bone's long axis, which the `length` dial stretches (default: the
   *   largest component of `tail`, else of its first child's `at`, else 'y')
   * @property {number} [girth] rest thickness in metres (default 0.06)
   * @property {number} [mass] rest mass in kilograms (default: plan density x the cylinder of its length and girth)
   * @property {('ball'|'hinge'|'fixed'|'free')} [joint] how the bone may turn, a `JOINTS` name (default 'ball')
   * @property {number[][]} [limits] [[minX, maxX], [minY, maxY], [minZ, maxZ]] in degrees from the rest rotation,
   *   about the bone's own axes (default: the joint type's)
   * @property {string} [soft] a `Kit.body.SOFT_KINDS` name ('hair', 'plait', 'tail', 'ear', 'scarf', 'cloak', 'hem'):
   *   the bone is loose, with that kind's stiffness, damping and limits wherever it states none of its own
   * @property {number} [stiffness] spring hint: squared natural frequency, 1/s^2 (default 120)
   * @property {number} [damping] spring hint: damping ratio, 1 = critical (default 1)
   * @property {Object} [shape] what a renderer draws for the bone: { kind, ...fields } per `Kit.body.SHAPES`
   *   (default: a capsule of the bone's length and girth)
   * @property {string} [paint] the colour channel the bone is painted with ('skin', 'cloth'); a renderer looks
   *   the channel up in the individual's colours
   */

  /**
   * @typedef {Object} SocketSpec
   * @property {string} name unique within the plan; may not contain '.' (nor '/', which separates the steps of
   *   a nested socket path such as 'handRight/gem')
   * @property {string} bone name of the bone the socket rides on
   * @property {string} type what fits here ('grip', 'headTop'); a part lists the types it fits
   * @property {number[]} [at] [x, y, z] offset in the bone's space, metres (default [0, 0, 0])
   * @property {string} [label] what an editor calls it (default: worked out from the name)
   * @property {boolean} [required] true when the socket may not be left empty
   */

  /**
   * @typedef {Object} BodyPlanSpec
   * @property {string} id name of the plan, for error messages
   * @property {BoneSpec[]} bones in any order; `Kit.body.plan` puts parents before children
   * @property {SocketSpec[]} [sockets]
   * @property {string[]} [capabilities] declared capabilities (rows of `CAPABILITIES` without a role, such as
   *   'hover'); the role-derived ones are worked out and must not be listed
   * @property {number} [density] kilograms per cubic metre, for bones that state no `mass` (default 1000)
   * @property {Object<string, string>} [filled] socket name -> part id, written by `Kit.body.assemble`
   * @property {Object[]} [features] surface features (eyes, a nose, a scar) placed on bones by azimuth and
   *   elevation: `FeatureSpec` rows of kit/body-surface.js, kept as data on `spec` and laid out by that file
   * @property {Object[]} [regions] painted areas of bones (a sleeve, a hairline, stripes): `RegionSpec` rows of
   *   kit/body-surface.js, kept as data on `spec`
   */

  /**
   * @typedef {Object} BodyPlan
   * @property {string} id
   * @property {BodyPlanSpec} spec the data it was compiled from, so a plan can be extended and recompiled
   * @property {number} boneCount
   * @property {string[]} boneNames bone index -> name; parents always come before their children
   * @property {Int16Array} parent bone index -> parent bone index, -1 for a root
   * @property {Float32Array} restTranslation 3 per bone: joint position in the parent's space
   * @property {Float32Array} restRotation 4 per bone: x, y, z, w
   * @property {Float32Array} restScale 3 per bone: all ones (dials write a pose, never the plan)
   * @property {Float32Array} restUniform 1 per bone: all ones
   * @property {Float32Array} tail 3 per bone: the bone's end in its own space (zeros when it has no extent)
   * @property {Float32Array} girth 1 per bone: rest thickness, metres
   * @property {Uint8Array} axis 1 per bone: long axis, 0 = x, 1 = y, 2 = z
   * @property {Int16Array} subtreeEnd 1 per bone: one past the last bone of its subtree (a subtree is one run of indices)
   * @property {Float32Array} length 1 per bone: rest length in metres (its tail, else the offset of its first child, else 0)
   * @property {Float32Array} mass 1 per bone: rest mass in kilograms
   * @property {Uint8Array} joint 1 per bone: a `JOINTS` id
   * @property {Float32Array} limitMin 3 per bone: lowest turn about x, y, z from rest, radians
   * @property {Float32Array} limitMax 3 per bone: highest turn about x, y, z from rest, radians
   * @property {Float32Array} stiffness 1 per bone: spring hint, 1/s^2
   * @property {Float32Array} damping 1 per bone: spring hint, damping ratio
   * @property {{min: Float32Array, max: Float32Array, base: Float32Array}} jointLimits the limits in the shape
   *   `Kit.reach` takes: `limitMin`, `limitMax` and the rest rotations they are measured from
   * @property {Array<?Object>} shapes 1 per bone: the bone's `shape` row, or null for the default capsule
   * @property {string[]} paintChannels the colour channels the bones name, in first-use order
   * @property {Uint8Array} bonePaint 1 per bone: 1 + index into `paintChannels`, or 0 for unpainted
   * @property {Uint32Array} roles 1 per bone: role bitmask
   * @property {number} capabilities capability bitmask (derived from roles, plus the declared ones)
   * @property {Uint8Array} counts capability bit -> how many (legs, tail segments...), 0 when absent
   * @property {number} socketCount
   * @property {string[]} socketNames socket index -> name
   * @property {Int16Array} socketBone socket index -> bone index
   * @property {Float32Array} socketOffset 3 per socket: offset in the bone's space
   * @property {Uint16Array} socketType socket index -> type id (`Kit.body.socketType`)
   * @property {Object<string, string>} filled socket name -> id of the part attached there (empty for a bare plan)
   * @property {function(string): number} boneIndex name -> index; throws naming the known bones
   * @property {function(string): number} socketIndex name -> index; throws naming the known sockets
   * @property {function(string): number} countOf capability name -> count (0 when the plan lacks it)
   */

  /** Throws unless `value` is a list of exactly three finite numbers. */
  const requireVector = (where, what, value) => {
    if (!Array.isArray(value) || value.length !== VECTOR_STRIDE || !value.every(Number.isFinite)) fail(where, `${what} must be [x, y, z] numbers, got ${JSON.stringify(value)}.`);
    return value;
  };

  /** Throws unless a bone or socket name is usable as a key of a lineage definition (kit/lineage.js paths use '.'). */
  const requireName = (where, what, name) => {
    if (typeof name !== 'string' || !name) fail(where, `${what} needs a non-empty string \`name\`, got ${JSON.stringify(name)}.`);
    if (name.includes('.')) fail(where, `the name "${name}" contains '.', which species definitions use to separate path steps. Use "${name.split('.').join('_')}" or camelCase.`);
    return name;
  };

  /** Quaternion [x, y, z, w] for rotations of x, then y, then z degrees about the bone's own axes. */
  const quaternionFromTurn = (turn) => {
    const [halfX, halfY, halfZ] = turn.map((degrees) => (degrees * DEGREES_TO_RADIANS) / 2);
    const [sinX, cosX, sinY, cosY, sinZ, cosZ] = [Math.sin(halfX), Math.cos(halfX), Math.sin(halfY), Math.cos(halfY), Math.sin(halfZ), Math.cos(halfZ)];
    // The product qx * qy * qz written out, so the rest pose costs no temporary quaternions.
    return [sinX * cosY * cosZ + cosX * sinY * sinZ, cosX * sinY * cosZ - sinX * cosY * sinZ, cosX * cosY * sinZ + sinX * sinY * cosZ, cosX * cosY * cosZ - sinX * sinY * sinZ];
  };

  /** Index of the largest component of a vector by size, or -1 when it is all zeros. */
  const dominantAxis = (vector) => {
    const sizes = vector.map(Math.abs);
    const largest = Math.max(...sizes);
    return largest > 0 ? sizes.indexOf(largest) : -1;
  };

  /**
   * Orders bones so every parent comes before its children, each subtree in one run, authored order otherwise.
   * @param {string} planId
   * @param {BoneSpec[]} bones
   * @returns {BoneSpec[]}
   * @complexity O(bones) time and space
   */
  const orderParentsFirst = (planId, bones) => {
    const where = `plan("${planId}")`;
    /** @type {Map<string|undefined, BoneSpec[]>} */
    const childrenOf = new Map();
    const names = new Set();
    bones.forEach((bone) => {
      requireName(where, 'every bone', bone.name);
      if (names.has(bone.name)) fail(where, `two bones are named "${bone.name}". Bone names must be unique.`);
      names.add(bone.name);
      childrenOf.set(bone.parent, [...(childrenOf.get(bone.parent) || []), bone]);
    });
    bones.forEach((bone) => {
      if (bone.parent !== undefined && !names.has(bone.parent)) fail(where, `bone "${bone.name}" has the parent "${bone.parent}", which is not a bone of this plan. Bones: ${[...names].join(', ')}.`);
    });
    const ordered = [];
    // Depth-first from the roots with an explicit stack; children are pushed reversed so they pop in authored order.
    const stack = [...(childrenOf.get(undefined) || [])].reverse();
    while (stack.length) {
      const bone = stack.pop();
      ordered.push(bone);
      stack.push(...[...(childrenOf.get(bone.name) || [])].reverse());
    }
    // A bone never reached from a root sits on a parent loop.
    if (ordered.length !== bones.length) {
      const stranded = bones.filter((bone) => !ordered.includes(bone)).map((bone) => bone.name);
      fail(where, `the bones ${stranded.join(', ')} form a parent loop (none of them leads to a root). Remove one \`parent\`.`);
    }
    return ordered;
  };

  /** Counts, per capability bit, the chains or bones that carry the capability's role. */
  const countCapabilities = (plan) => {
    CAPABILITIES.names.forEach((name, bit) => {
      const { role, count } = CAPABILITY_ROWS[name];
      if (!role) return;
      const mask = 1 << ROLES.bit(role);
      let found = 0;
      for (let bone = 0; bone < plan.boneCount; bone++) {
        if (!(plan.roles[bone] & mask)) continue;
        const parentBone = plan.parent[bone];
        // A chain is counted once, at the bone whose parent does not carry the role.
        const startsChain = parentBone === NO_PARENT || !(plan.roles[parentBone] & mask);
        if (count === 'bones' || startsChain) found += 1;
      }
      plan.counts[bit] = Math.min(found, 255);
      if (found) plan.capabilities = (plan.capabilities | (1 << bit)) >>> 0;
    });
  };

  /**
   * Compiles a body plan from data into flat typed arrays in parent-first order. The result is what every other
   * `Kit.body` function takes; treat its arrays as read-only (a pose is where things change).
   * @param {BodyPlanSpec} spec
   * @returns {BodyPlan}
   * @throws {Error} naming the plan and the cause: no bones, a duplicate or missing name, an unknown parent,
   *   role, socket bone or capability, a parent loop, a derived capability listed by hand, or too many bones
   * @complexity O(bones + sockets) time and space, once per plan
   * @example
   * const sword = Kit.body.plan({
   *   id: 'sword',
   *   bones: [{ name: 'blade', tail: [0, 0.9, 0], roles: ['root', 'prop'] }],
   *   sockets: [{ name: 'gem', bone: 'blade', type: 'gem', at: [0, -0.05, 0] }],
   * });
   * sword.boneCount // 1
   */
  const plan = (spec) => {
    if (!spec || typeof spec.id !== 'string' || !spec.id) fail('plan', 'a plan needs a string `id`.');
    const where = `plan("${spec.id}")`;
    if (!Array.isArray(spec.bones) || !spec.bones.length) fail(where, 'a plan needs at least one bone in `bones`.');
    if (spec.bones.length > MOST_BONES) fail(where, `${spec.bones.length} bones is more than the ${MOST_BONES} a plan can hold.`);
    const bones = orderParentsFirst(spec.id, spec.bones);
    const sockets = spec.sockets || [];
    const boneCount = bones.length;
    const boneNames = bones.map((bone) => bone.name);
    const indexByBone = new Map(boneNames.map((name, index) => [name, index]));
    const indexBySocket = new Map();

    /** @type {BodyPlan} */
    const compiled = {
      id: spec.id,
      spec,
      boneCount,
      boneNames,
      parent: new Int16Array(boneCount),
      restTranslation: new Float32Array(boneCount * VECTOR_STRIDE),
      restRotation: new Float32Array(boneCount * QUATERNION_STRIDE),
      restScale: new Float32Array(boneCount * VECTOR_STRIDE).fill(1),
      restUniform: new Float32Array(boneCount).fill(1),
      tail: new Float32Array(boneCount * VECTOR_STRIDE),
      girth: new Float32Array(boneCount),
      axis: new Uint8Array(boneCount),
      subtreeEnd: new Int16Array(boneCount),
      length: new Float32Array(boneCount),
      mass: new Float32Array(boneCount),
      joint: new Uint8Array(boneCount),
      limitMin: new Float32Array(boneCount * VECTOR_STRIDE),
      limitMax: new Float32Array(boneCount * VECTOR_STRIDE),
      stiffness: new Float32Array(boneCount),
      damping: new Float32Array(boneCount),
      jointLimits: null,
      shapes: bones.map((bone) => bone.shape || null),
      paintChannels: [...new Set(bones.map((bone) => bone.paint).filter(Boolean))],
      bonePaint: new Uint8Array(boneCount),
      roles: new Uint32Array(boneCount),
      capabilities: 0,
      counts: new Uint8Array(BITS_IN_MASK),
      socketCount: sockets.length,
      socketNames: sockets.map((socket) => socket.name),
      socketBone: new Int16Array(sockets.length),
      socketOffset: new Float32Array(sockets.length * VECTOR_STRIDE),
      socketType: new Uint16Array(sockets.length),
      filled: Object.freeze({ ...(spec.filled || {}) }),
      boneIndex(name) {
        const index = indexByBone.get(name);
        if (index === undefined) fail(`plan("${spec.id}").boneIndex`, `no bone named "${name}". Bones: ${boneNames.join(', ')}.`);
        return index;
      },
      socketIndex(name) {
        const index = indexBySocket.get(name);
        if (index === undefined) fail(`plan("${spec.id}").socketIndex`, `no socket named "${name}". Sockets: ${compiled.socketNames.join(', ') || '(none)'}.`);
        return index;
      },
      countOf(capabilityName) {
        return compiled.counts[CAPABILITIES.bit(capabilityName)];
      },
    };

    bones.forEach((bone, index) => {
      const tail = bone.tail ? requireVector(where, `bone "${bone.name}" tail`, bone.tail) : [0, 0, 0];
      compiled.parent[index] = bone.parent === undefined ? NO_PARENT : indexByBone.get(bone.parent);
      compiled.restTranslation.set(bone.at ? requireVector(where, `bone "${bone.name}" at`, bone.at) : [0, 0, 0], index * VECTOR_STRIDE);
      compiled.restRotation.set(bone.turn ? quaternionFromTurn(requireVector(where, `bone "${bone.name}" turn`, bone.turn)) : [0, 0, 0, 1], index * QUATERNION_STRIDE);
      compiled.tail.set(tail, index * VECTOR_STRIDE);
      compiled.girth[index] = bone.girth === undefined ? DEFAULT_GIRTH : bone.girth;
      compiled.roles[index] = roleMask(bone.roles || []);
      if (bone.axis !== undefined && !(bone.axis in AXES)) fail(where, `bone "${bone.name}" has axis ${JSON.stringify(bone.axis)}; use 'x', 'y' or 'z'.`);
      // The long axis: stated, else along the tail, else towards the first child (filled in below), else Y.
      const tailAxis = dominantAxis(tail);
      compiled.axis[index] = bone.axis !== undefined ? AXES[bone.axis] : tailAxis >= 0 ? tailAxis : AXES.y;
      compiled.length[index] = Math.hypot(...tail);
      const jointName = bone.joint === undefined ? DEFAULT_JOINT : bone.joint;
      if (!(jointName in JOINTS)) fail(where, `bone "${bone.name}" has the joint ${JSON.stringify(bone.joint)}; use one of ${Object.keys(JOINTS).join(', ')}.`);
      if (bone.soft !== undefined && !(bone.soft in SOFT_KINDS)) fail(where, `bone "${bone.name}" is soft: ${JSON.stringify(bone.soft)}; use one of ${Object.keys(SOFT_KINDS).join(', ')}.`);
      const soft = bone.soft ? SOFT_KINDS[bone.soft] : PHYSICAL_DEFAULTS;
      const limits = bone.limits || soft.limits || JOINTS[jointName].limits;
      if (!Array.isArray(limits) || limits.length !== VECTOR_STRIDE || !limits.every((range) => Array.isArray(range) && range.length === 2 && range[0] <= range[1]))
        fail(where, `bone "${bone.name}" limits must be [[minX, maxX], [minY, maxY], [minZ, maxZ]] in degrees with min <= max, got ${JSON.stringify(bone.limits)}.`);
      compiled.joint[index] = JOINTS[jointName].id;
      limits.forEach((range, axis) => {
        compiled.limitMin[index * VECTOR_STRIDE + axis] = range[0] * DEGREES_TO_RADIANS;
        compiled.limitMax[index * VECTOR_STRIDE + axis] = range[1] * DEGREES_TO_RADIANS;
      });
      compiled.stiffness[index] = bone.stiffness === undefined ? soft.stiffness : bone.stiffness;
      compiled.damping[index] = bone.damping === undefined ? soft.damping : bone.damping;
      compiled.bonePaint[index] = bone.paint ? compiled.paintChannels.indexOf(bone.paint) + 1 : UNPAINTED;
      if (bone.shape) {
        const needed = SHAPES[bone.shape.kind];
        if (!needed) fail(where, `bone "${bone.name}" has a shape of kind ${JSON.stringify(bone.shape.kind)}; use one of ${Object.keys(SHAPES).join(', ')}.`);
        const absent = needed.filter((field) => bone.shape[field] === undefined);
        if (absent.length) fail(where, `the ${bone.shape.kind} shape of bone "${bone.name}" needs ${absent.join(' and ')}.`);
      }
    });
    compiled.jointLimits = Object.freeze({ min: compiled.limitMin, max: compiled.limitMax, base: compiled.restRotation });
    // Second pass for bones with neither `axis` nor `tail`: point along the first child's offset.
    const hasFirstChild = new Uint8Array(boneCount);
    bones.forEach((bone, index) => {
      const parentBone = compiled.parent[index];
      if (parentBone === NO_PARENT || hasFirstChild[parentBone]) return;
      hasFirstChild[parentBone] = 1;
      const parentSpec = bones[parentBone];
      const towardsChild = dominantAxis(bone.at || [0, 0, 0]);
      if (parentSpec.axis === undefined && !parentSpec.tail && towardsChild >= 0) compiled.axis[parentBone] = towardsChild;
      // A bone without a tail is as long as the reach to its first child.
      if (!parentSpec.tail) compiled.length[parentBone] = Math.hypot(...(bone.at || [0, 0, 0]));
    });
    // Subtrees are single runs because bones are in depth-first order: walking backwards, each bone extends its parent's run.
    for (let bone = boneCount - 1; bone >= 0; bone--) {
      compiled.subtreeEnd[bone] = Math.max(compiled.subtreeEnd[bone], bone + 1);
      const parentBone = compiled.parent[bone];
      if (parentBone !== NO_PARENT) compiled.subtreeEnd[parentBone] = Math.max(compiled.subtreeEnd[parentBone], compiled.subtreeEnd[bone]);
    }
    const density = spec.density === undefined ? PHYSICAL_DEFAULTS.density : spec.density;
    bones.forEach((bone, index) => {
      compiled.mass[index] = bone.mass === undefined ? density * compiled.length[index] * compiled.girth[index] ** 2 * CYLINDER_AREA_FACTOR : bone.mass;
    });

    sockets.forEach((socket, index) => {
      requireName(where, 'every socket', socket.name);
      if (indexBySocket.has(socket.name)) fail(where, `two sockets are named "${socket.name}". Socket names must be unique.`);
      if (!indexByBone.has(socket.bone)) fail(where, `socket "${socket.name}" sits on the bone "${socket.bone}", which is not a bone of this plan. Bones: ${boneNames.join(', ')}.`);
      indexBySocket.set(socket.name, index);
      compiled.socketBone[index] = indexByBone.get(socket.bone);
      compiled.socketOffset.set(socket.at ? requireVector(where, `socket "${socket.name}" at`, socket.at) : [0, 0, 0], index * VECTOR_STRIDE);
      compiled.socketType[index] = socketType(socket.type);
    });

    (spec.capabilities || []).forEach((name) => {
      const bit = CAPABILITIES.bit(name);
      if (CAPABILITY_ROWS[name].role) fail(where, `"${name}" is worked out from the "${CAPABILITY_ROWS[name].role}" role of the bones; give a bone that role instead of listing the capability.`);
      compiled.capabilities = (compiled.capabilities | (1 << bit)) >>> 0;
      compiled.counts[bit] = 1;
    });
    countCapabilities(compiled);
    return Object.freeze(compiled);
  };

  // ---- capabilities: can this plan do what a consumer needs? ----------------------------------------------------------

  /**
   * Compiles what a consumer (a gait, a pose set, a renderer) needs from a plan. Build it once, at load.
   * @param {{needs?: string[], atLeast?: Object<string, number>}} spec capabilities the plan must have, and the
   *   smallest count that will do for some of them ({ legs: 4 })
   * @returns {Object} a `FlagRequirement` of kit/flags.js
   * @throws {Error} for an unknown capability
   * @complexity O(names)
   * @example const WALK_NEEDS = Kit.body.requirement({ needs: ['legs'], atLeast: { legs: 2 } });
   */
  const requirement = (spec) => CAPABILITIES.requirement(spec);

  /**
   * Does the plan meet the requirement? One AND and compare, then one compare per counted capability.
   * @param {BodyPlan} bodyPlan
   * @param {Object} needed from `Kit.body.requirement`
   * @returns {boolean}
   * @complexity O(1) for the mask, O(counted capabilities) for the counts (usually none or one); no allocation
   * @example if (Kit.body.fits(plan, WALK_NEEDS)) startWalking();
   */
  const fits = (bodyPlan, needed) => CAPABILITIES.fits(bodyPlan.capabilities, bodyPlan.counts, needed);

  /**
   * Says what a plan lacks for a requirement, in words fit for an error message.
   * @param {BodyPlan} bodyPlan
   * @param {Object} needed from `Kit.body.requirement`
   * @returns {string[]} empty when the plan fits; otherwise entries such as 'legs' or 'legs (has 2, needs 4)'
   * @complexity O(capabilities)
   * @example Kit.body.missing(fishPlan, WALK_NEEDS) // ['legs']
   */
  const missing = (bodyPlan, needed) => CAPABILITIES.missing(bodyPlan.capabilities, bodyPlan.counts, needed);

  /**
   * Throws unless the plan meets the requirement; the error names the consumer, the plan and what is missing.
   * @param {BodyPlan} bodyPlan
   * @param {Object} needed from `Kit.body.requirement`
   * @param {string} consumer who is asking, e.g. 'the walk gait'
   * @returns {BodyPlan} the plan, so the call can wrap an argument
   * @throws {Error} e.g. 'Kit.body.requireFit: the walk gait cannot use the plan "fish": it lacks legs.'
   * @complexity O(1) when it fits, O(capabilities) to build the message when it does not
   * @example Kit.body.requireFit(plan, WALK_NEEDS, 'the walk gait');
   */
  const requireFit = (bodyPlan, needed, consumer) => {
    if (fits(bodyPlan, needed)) return bodyPlan;
    return fail(
      'requireFit',
      `${consumer} cannot use the plan "${bodyPlan.id}": it lacks ${missing(bodyPlan, needed).join(', ')}. This plan has: ${capabilityNames(bodyPlan.capabilities).join(', ') || '(nothing)'}.`
    );
  };

  // ---- finding bones by role ------------------------------------------------------------------------------------------

  /**
   * The bones that carry every role in a mask, in plan order.
   * @param {BodyPlan} bodyPlan
   * @param {number} mask from `Kit.body.roleMask`
   * @returns {number[]} bone indices
   * @complexity O(bones) time; allocates the list, so call it at setup, not per frame
   * @example const feet = Kit.body.bonesWithRoles(plan, Kit.body.roleMask(['foot']));
   */
  const bonesWithRoles = (bodyPlan, mask) => {
    const found = [];
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) if ((bodyPlan.roles[bone] & mask) >>> 0 === mask) found.push(bone);
    return found;
  };

  /**
   * The limbs that carry every role in a mask, each as its bones from the body outwards. A chain starts at a
   * matching bone whose parent does not match and follows, at each step, the first matching child.
   * @param {BodyPlan} bodyPlan
   * @param {number} mask from `Kit.body.roleMask`
   * @returns {number[][]} one list of bone indices per chain, in plan order
   * @complexity O(bones) time and space; call it at setup, not per frame
   * @example
   * const legs = Kit.body.chains(plan, Kit.body.roleMask(['leg']));   // biped: [[hip, knee, foot], [hip, knee, foot]]
   */
  const chains = (bodyPlan, mask) => {
    const matches = (bone) => (bodyPlan.roles[bone] & mask) >>> 0 === mask;
    /** First matching child of each bone, or -1. Bones are parent-first, so one backwards pass finds the first. */
    const firstMatchingChild = new Int16Array(bodyPlan.boneCount).fill(NO_PARENT);
    for (let bone = bodyPlan.boneCount - 1; bone >= 0; bone--) {
      if (matches(bone) && bodyPlan.parent[bone] !== NO_PARENT) firstMatchingChild[bodyPlan.parent[bone]] = bone;
    }
    const found = [];
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) {
      const parentBone = bodyPlan.parent[bone];
      if (!matches(bone) || (parentBone !== NO_PARENT && matches(parentBone))) continue;
      const chain = [];
      for (let link = bone; link !== NO_PARENT; link = firstMatchingChild[link]) chain.push(link);
      found.push(chain);
    }
    return found;
  };

  // ---- poses: a plan's view of Kit.rig -------------------------------------------------------------------------------

  /**
   * Resets a pose to the plan's rest pose, without allocating.
   * @param {BodyPlan} bodyPlan
   * @param {Object} out a `JointTransforms` of kit/rig.js
   * @returns {Object} `out`
   * @complexity O(bones) time, no allocation
   * @example Kit.body.copyRest(plan, pose);
   */
  const copyRest = (bodyPlan, out) => {
    out.translation.set(bodyPlan.restTranslation);
    out.rotation.set(bodyPlan.restRotation);
    out.scale.set(bodyPlan.restScale);
    out.uniform.set(bodyPlan.restUniform);
    return out;
  };

  /**
   * Allocates a pose (a `JointTransforms` of kit/rig.js) for a plan, filled with its rest pose. Use one as the
   * local pose a gait writes, another as the world result; allocate both at setup and reuse them every frame.
   * @param {BodyPlan} bodyPlan
   * @returns {Object} a `JointTransforms`
   * @complexity O(bones) time and space
   * @example const pose = Kit.body.createPose(plan), world = Kit.body.createPose(plan);
   */
  const createPose = (bodyPlan) => copyRest(bodyPlan, Kit.rig.create(bodyPlan.boneCount));

  /**
   * Forward kinematics for a plan: `Kit.rig.worldTransforms` over `plan.parent`. One pass, no recursion, no allocation.
   * @param {BodyPlan} bodyPlan
   * @param {Object} pose the local pose (from `createPose`, a baked rest pose, or a gait)
   * @param {Object} out receives the world transforms; must not be `pose`
   * @param {number} [originX=0] where the body stands, world metres
   * @param {number} [originY=0]
   * @param {number} [originZ=0]
   * @param {number} [heading=0] radians about +Y; 0 faces +Z
   * @param {number} [firstBone=0] refresh only the bones from this index...
   * @param {number} [endBone=plan.boneCount] ...up to but not including this one: `(bone, plan.subtreeEnd[bone])`
   *   refreshes exactly what moved when one bone changed
   * @returns {Object} `out`
   * @complexity O(bones in the range) time, no allocation
   * @example
   * Kit.body.worldTransforms(plan, pose, world, x, 0, z, heading);
   * world.translation[3 * plan.boneIndex('head') + 1]   // the head's height
   */
  const worldTransforms = (bodyPlan, pose, out, originX = 0, originY = 0, originZ = 0, heading = 0, firstBone = 0, endBone = bodyPlan.boneCount) =>
    Kit.rig.worldTransforms(bodyPlan.parent, pose, out, originX, originY, originZ, heading, firstBone, endBone);

  /** One reusable point for helpers that need a temporary; never handed out. */
  const scratchPoint = new Float32Array(VECTOR_STRIDE);

  /**
   * The world position of a socket, from world transforms already computed.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms`
   * @param {number} socket socket index (`plan.socketIndex(name)`)
   * @param {Float32Array|number[]} out receives x, y, z
   * @param {number} [outAt=0] index in `out` to write at
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.body.socketPosition(plan, world, plan.socketIndex('handRight'), point);
   */
  const socketPosition = (bodyPlan, world, socket, out, outAt = 0) => Kit.rig.carryPoint(world, bodyPlan.socketBone[socket], bodyPlan.socketOffset, socket * VECTOR_STRIDE, out, outAt);

  /**
   * The world position of a bone's far end (its `tail`), from world transforms already computed. A bone without
   * a tail returns its joint position.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms`
   * @param {number} bone bone index
   * @param {Float32Array|number[]} out receives x, y, z
   * @param {number} [outAt=0] index in `out` to write at
   * @returns {Float32Array|number[]} `out`
   * @complexity O(1), no allocation
   * @example Kit.body.tailPosition(plan, world, plan.boneIndex('head'), point);
   */
  const tailPosition = (bodyPlan, world, bone, out, outAt = 0) => Kit.rig.carryPoint(world, bone, bodyPlan.tail, bone * VECTOR_STRIDE, out, outAt);

  /**
   * The height of the lowest point of a posed body (joints and bone ends), so a consumer can stand it on the
   * ground: dials change leg length, and a pose that bends the knees changes it again.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms`
   * @returns {number} the smallest world Y, metres
   * @complexity O(bones) time, no allocation
   * @example const lift = -Kit.body.lowestY(plan, world);   // add to the instance's Y and run worldTransforms again
   */
  const lowestY = (bodyPlan, world) => {
    let lowest = Infinity;
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) {
      lowest = Math.min(lowest, world.translation[bone * VECTOR_STRIDE + 1], tailPosition(bodyPlan, world, bone, scratchPoint)[1]);
    }
    return lowest;
  };

  /** A joint whose limits sit less than this (radians) off centre has no preferred way to bend. */
  const LEAST_BEND_BIAS = 1e-3;
  const scratchQuaternion = new Float32Array(QUATERNION_STRIDE);

  /**
   * Which way a limb's middle joint (a knee, an elbow) pokes out when it bends inside its limits: the direction a
   * two-bone solve should be hinted towards. Hinge sign conventions are per plan (a knee here turns 0 to 150
   * degrees about X, an elbow -150 to 0), so nothing but this knows that one folds forwards and the other back.
   * It is worked out by turning the joint to the middle of its limits and seeing where its child goes: the
   * joint itself pokes out the opposite way.
   * @param {BodyPlan} bodyPlan
   * @param {number} middle index of the middle bone (the shin, the forearm); its first child is the limb's end
   * @param {Float32Array|number[]} out receives a unit direction x, y, z in the plan's own space at rest (+Z is
   *   the way the body faces), or zeros when the joint has no child or its limits are centred (a ball joint
   *   that may bend either way)
   * @returns {Float32Array|number[]} `out`
   * @complexity O(bones) time (one forward pass over the rest pose) and space; call it at setup, not per frame
   * @example Kit.body.bendDirection(biped, biped.boneIndex('shinLeft'), direction) // [0, 0, 1]: knees point forward
   */
  const bendDirection = (bodyPlan, middle, out) => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const end = middle + 1 < bodyPlan.subtreeEnd[middle] ? middle + 1 : NO_PARENT;
    if (end === NO_PARENT) return out;
    const limitAt = middle * VECTOR_STRIDE;
    const middleTurn = [0, 1, 2].map((axis) => (bodyPlan.limitMin[limitAt + axis] + bodyPlan.limitMax[limitAt + axis]) / 2);
    if (Math.hypot(...middleTurn) < LEAST_BEND_BIAS) return out;
    const rest = createPose(bodyPlan);
    const world = worldTransforms(bodyPlan, rest, Kit.rig.create(bodyPlan.boneCount));
    const endAt = end * VECTOR_STRIDE;
    const middleAt = middle * VECTOR_STRIDE;
    const straight = [0, 1, 2].map((axis) => world.translation[endAt + axis] - world.translation[middleAt + axis]);
    // The same child with the joint turned to the middle of its limits.
    scratchQuaternion.set(quaternionFromTurn(middleTurn.map((radians) => radians / DEGREES_TO_RADIANS)));
    const bent = Kit.rig.create(bodyPlan.boneCount);
    Kit.rig.copy(rest, bent);
    const at = middle * QUATERNION_STRIDE;
    const [baseX, baseY, baseZ, baseW] = [rest.rotation[at], rest.rotation[at + 1], rest.rotation[at + 2], rest.rotation[at + 3]];
    const [turnX, turnY, turnZ, turnW] = scratchQuaternion;
    // local = rest * turn: the limits are measured in the bone's own frame, after its rest rotation.
    bent.rotation[at] = baseW * turnX + baseX * turnW + baseY * turnZ - baseZ * turnY;
    bent.rotation[at + 1] = baseW * turnY - baseX * turnZ + baseY * turnW + baseZ * turnX;
    bent.rotation[at + 2] = baseW * turnZ + baseX * turnY - baseY * turnX + baseZ * turnW;
    bent.rotation[at + 3] = baseW * turnW - baseX * turnX - baseY * turnY - baseZ * turnZ;
    worldTransforms(bodyPlan, bent, world);
    const moved = [0, 1, 2].map((axis) => world.translation[endAt + axis] - world.translation[middleAt + axis] - straight[axis]);
    // Only the part across the limb counts; the joint goes the opposite way to its child's end.
    const straightLength = Math.hypot(...straight) || 1;
    const along = moved.reduce((sum, value, axis) => sum + (value * straight[axis]) / straightLength, 0);
    const across = moved.map((value, axis) => value - (along * straight[axis]) / straightLength);
    const acrossLength = Math.hypot(...across);
    if (acrossLength < LEAST_BEND_BIAS * straightLength) return out;
    across.forEach((value, axis) => {
      out[axis] = -value / acrossLength;
    });
    return out;
  };

  /**
   * Does a bend hint agree with the way a middle joint's limits let it bend? A solve hinted the wrong way asks
   * a knee to fold backwards, which the limits then refuse, leaving the foot short of its target.
   * @param {BodyPlan} bodyPlan
   * @param {number} middle index of the middle bone
   * @param {number} hintX the direction the solve will be hinted towards, in the plan's own space at rest
   * @param {number} hintY
   * @param {number} hintZ
   * @returns {boolean} true when the hint is on the joint's bending side, or the joint has no preferred side
   * @complexity O(bones); call it at setup, not per frame
   * @example
   * if (!Kit.body.bendAgrees(plan, shin, 0, 0, -1)) throw new Error('this knee cannot bend backwards');
   */
  const bendAgrees = (bodyPlan, middle, hintX, hintY, hintZ) => {
    const direction = bendDirection(bodyPlan, middle, [0, 0, 0]);
    return direction[0] * hintX + direction[1] * hintY + direction[2] * hintZ >= 0;
  };

  // ---- physical quantities that follow the proportions --------------------------------------------------------------

  /**
   * A bone's length in a posed body: its rest length stretched by the scale along its long axis.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms`
   * @param {number} bone bone index
   * @returns {number} metres
   * @complexity O(1)
   * @example const thigh = Kit.body.boneLength(plan, world, plan.boneIndex('thighLeft'));
   */
  const boneLength = (bodyPlan, world, bone) => bodyPlan.length[bone] * world.scale[bone * VECTOR_STRIDE + bodyPlan.axis[bone]];

  /**
   * The mass of every bone of a proportioned body. Mass follows volume: a bone's rest mass times its scale on
   * all three axes, so a body twice the size weighs eight times as much and a longer leg weighs proportionally more.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms` (its `scale` already includes inherited size)
   * @param {Float32Array|number[]} out receives one mass per bone, kilograms
   * @returns {number} the total mass, kilograms
   * @complexity O(bones) time, no allocation
   * @example const total = Kit.body.boneMasses(bake.plan, world, masses);   // once per bake: masses do not change with the pose
   */
  const boneMasses = (bodyPlan, world, out) => {
    let total = 0;
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) {
      const vector = bone * VECTOR_STRIDE;
      out[bone] = bodyPlan.mass[bone] * world.scale[vector] * world.scale[vector + 1] * world.scale[vector + 2];
      total += out[bone];
    }
    return total;
  };

  /**
   * The centre of mass of a posed body: each bone's mass placed at the middle of the bone. Locomotion keeps it
   * over the feet; a ragdoll uses it to place impulses.
   * @param {BodyPlan} bodyPlan
   * @param {Object} world the `out` of `worldTransforms`
   * @param {ArrayLike<number>} masses one per bone, from `boneMasses`
   * @param {Float32Array|number[]} out receives x, y, z in world metres (the root's position when the body has no mass)
   * @returns {Float32Array|number[]} `out`
   * @complexity O(bones) time, no allocation
   * @example Kit.body.centerOfMass(plan, world, masses, point);
   */
  const centerOfMass = (bodyPlan, world, masses, out) => {
    let total = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let bone = 0; bone < bodyPlan.boneCount; bone++) {
      const vector = bone * VECTOR_STRIDE;
      tailPosition(bodyPlan, world, bone, scratchPoint);
      // The middle of the bone: half-way from its joint to its end (a bone without a tail counts at its joint).
      const hasTail = bodyPlan.tail[vector] !== 0 || bodyPlan.tail[vector + 1] !== 0 || bodyPlan.tail[vector + 2] !== 0;
      const toMiddle = hasTail ? 0.5 : 0;
      sumX += masses[bone] * (world.translation[vector] + (scratchPoint[0] - world.translation[vector]) * toMiddle);
      sumY += masses[bone] * (world.translation[vector + 1] + (scratchPoint[1] - world.translation[vector + 1]) * toMiddle);
      sumZ += masses[bone] * (world.translation[vector + 2] + (scratchPoint[2] - world.translation[vector + 2]) * toMiddle);
      total += masses[bone];
    }
    out[0] = total > 0 ? sumX / total : world.translation[0];
    out[1] = total > 0 ? sumY / total : world.translation[1];
    out[2] = total > 0 ? sumZ / total : world.translation[2];
    return out;
  };

  // ---- proportion dials -----------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} DialEffect
   * An effect does one of three things: a bone `channel`, a number in the bones' `shape`, or a number of a
   * surface `feature` (kit/body-surface.js). The last two never change a bone's transform.
   * @property {string[]} [roles] affect every bone carrying ALL of these roles (['leg', 'hind'])
   * @property {string[]} [bones] affect these bones by name; names the plan lacks are skipped, so one dial table
   *   can serve several plans
   * @property {string} [part] with `bones`: the bones of that part wherever it is attached ('hatWide' + ['brim']
   *   is 'headTop/brim' when the hat sits in headTop); alone: every bone of the part
   * @property {('length'|'girth'|'size'|'pitch')} [channel] `length` stretches the bone along its long axis
   *   (moving what hangs off it), `girth` thickens it across, `size` scales the bone and everything below it,
   *   `pitch` leans it forwards
   * @property {string} [shape] a path to a number in each matched bone's shape: 'radius', 'scale.2',
   *   'profile.2.0' (the radius of profile point 2), 'at.1'
   * @property {string} [feature] the id of a surface feature, with `param`
   * @property {string} [param] a path to a number of that feature: 'azimuth', 'elevation', 'spacing', 'size.0'
   * @property {('left'|'right')} [side] for a feature effect: only the copy of a pair on that side
   * @property {('scale'|'offset')} [mode='scale'] for `shape` and `feature`: see `PARAM_MODES`
   * @property {number} [amount=1] how strongly the dial acts: a bone is multiplied by 1 + (value - 1) x amount
   */

  /**
   * @typedef {Object} DialRow
   * @property {string} id name of the dial ('height', 'legLength')
   * @property {number} min smallest value; a dial is a multiplier, so 1 means "as the plan was drawn"
   * @property {number} max largest value
   * @property {number} [default=1] the value when nothing chooses one
   * @property {DialEffect[]} affects what the dial does
   * @property {string} [label] what an editor calls it (default: worked out from the id)
   * @property {string} [group] the editor group it is listed under (default: from the roles it affects)
   * @property {boolean} [sided] true for a dial that may differ left and right (an eye, an ear): `sidedDials`
   *   turns it into one dial per side, '<id>@left' and '<id>@right'
   * @property {string} [base] set by `sidedDials`: the id both sides share (they are drawn from it, so a rolled
   *   body is symmetric until someone unlinks it)
   * @property {('left'|'right')} [side] set by `sidedDials`
   * @property {string} [twin] set by `sidedDials`: the id of the other side
   */

  /**
   * @typedef {Object} DialSet
   * @property {string[]} ids dial index -> id
   * @property {number} count
   * @property {Float32Array} min per dial
   * @property {Float32Array} max per dial
   * @property {Float32Array} defaults per dial
   * @property {Int16Array} opDial per operation: which dial
   * @property {Int16Array} opBone per operation: which bone
   * @property {Uint8Array} opChannel per operation: a `CHANNELS` value
   * @property {Float32Array} opAmount per operation
   * @property {Array<{dial: number, bone: number, path: Array<string|number>, amount: number, mode: string}>} shapeOps
   *   per shape operation: which dial changes which number of which bone's shape
   * @property {Array<{dial: number, feature: string, path: Array<string|number>, amount: number, mode: string, side: ?string}>} featureOps
   *   per feature operation: resolved against the features of an assembled body by kit/body-surface.js
   * @property {string[]} unused ids of dials that touch no bone of this plan (often a misspelt role)
   * @property {function(string): number} indexOf id -> dial index; throws naming the known dials
   */

  /**
   * Compiles a dial table against a plan: every "these roles, this channel" becomes a flat list of (dial, bone,
   * channel, amount) operations, so applying dials is one pass with no lookups.
   * @param {BodyPlan} bodyPlan
   * @param {DialRow[]} rows
   * @returns {DialSet}
   * @throws {Error} for a duplicate id, a range that is empty or does not contain the default, an unknown role
   *   or channel, or an effect that names neither roles nor bones
   * @complexity O(dials x effects x bones) time once; O(operations) space
   * @example
   * const dials = Kit.body.dials(plan, [
   *   { id: 'legLength', min: 0.8, max: 1.3, affects: [{ roles: ['leg'], channel: 'length' }] },
   *   { id: 'headSize', min: 0.9, max: 1.4, affects: [{ roles: ['head'], channel: 'size' }] },
   * ]);
   */
  const dials = (bodyPlan, rows) => {
    const where = `dials("${bodyPlan.id}")`;
    const ids = rows.map((row) => row.id);
    const operations = [];
    const shapeOps = [];
    const featureOps = [];
    const unused = [];
    rows.forEach((row, dial) => {
      const preset = row.default === undefined ? 1 : row.default;
      if (typeof row.id !== 'string' || !row.id) fail(where, 'every dial needs a string `id`.');
      if (ids.indexOf(row.id) !== dial) fail(where, `two dials are named "${row.id}".`);
      if (!(row.min <= preset && preset <= row.max)) fail(where, `dial "${row.id}" needs min <= default <= max, got min ${row.min}, default ${preset}, max ${row.max}.`);
      const before = operations.length + shapeOps.length;
      let drivesFeature = false;
      (row.affects || []).forEach((effect) => {
        const amount = effect.amount === undefined ? 1 : effect.amount;
        const mode = effect.mode === undefined ? DEFAULT_PARAM_MODE : effect.mode;
        if ((effect.shape !== undefined || effect.feature !== undefined) && !(mode in PARAM_MODES))
          fail(where, `dial "${row.id}" has the mode ${JSON.stringify(effect.mode)}; use one of ${Object.keys(PARAM_MODES).join(', ')}.`);
        if (effect.feature !== undefined) {
          if (typeof effect.param !== 'string' || !effect.param) fail(where, `the feature effect of dial "${row.id}" on "${effect.feature}" needs a \`param\` such as 'spacing'.`);
          drivesFeature = true;
          featureOps.push({ dial, feature: effect.feature, path: parseParamPath(effect.param), amount, mode, side: effect.side || null });
          return;
        }
        if (effect.shape === undefined && !(effect.channel in CHANNELS))
          fail(where, `dial "${row.id}" has the channel ${JSON.stringify(effect.channel)}; use one of ${Object.keys(CHANNELS).join(', ')}, or give \`shape\` or \`feature\`.`);
        if (!effect.roles && !effect.bones && !effect.part) fail(where, `an effect of dial "${row.id}" names neither \`roles\`, \`bones\` nor \`part\`, so it would touch nothing.`);
        const matched = bonesOfEffect(bodyPlan, effect);
        if (effect.shape === undefined) {
          matched.forEach((bone) => operations.push({ dial, bone, channel: CHANNELS[effect.channel], amount }));
          return;
        }
        const path = parseParamPath(effect.shape);
        matched.forEach((bone) => {
          if (!Number.isFinite(numberAtPath(bodyPlan.shapes[bone], path)))
            fail(
              where,
              `dial "${row.id}" drives shape.${effect.shape} of bone "${bodyPlan.boneNames[bone]}", whose shape ${bodyPlan.shapes[bone] ? `(${bodyPlan.shapes[bone].kind}) has no number there` : 'is the default capsule; give the bone a `shape`'}.`
            );
          shapeOps.push({ dial, bone, path, amount, mode });
        });
      });
      if (operations.length + shapeOps.length === before && !drivesFeature) unused.push(row.id);
    });
    return Object.freeze({
      ids,
      count: rows.length,
      min: Float32Array.from(rows, (row) => row.min),
      max: Float32Array.from(rows, (row) => row.max),
      defaults: Float32Array.from(rows, (row) => (row.default === undefined ? 1 : row.default)),
      opDial: Int16Array.from(operations, (operation) => operation.dial),
      opBone: Int16Array.from(operations, (operation) => operation.bone),
      opChannel: Uint8Array.from(operations, (operation) => operation.channel),
      opAmount: Float32Array.from(operations, (operation) => operation.amount),
      shapeOps,
      featureOps,
      unused,
      indexOf(id) {
        const index = ids.indexOf(id);
        if (index < 0) fail(`${where}.indexOf`, `no dial named "${id}". Dials: ${ids.join(', ') || '(none)'}.`);
        return index;
      },
    });
  };

  /**
   * Writes the plan's rest pose, reshaped by dial values, into a pose. Do this once per distinct individual (a
   * bake), keep the result, and start every frame's pose from it with `Kit.rig.copy`.
   * @param {BodyPlan} bodyPlan the plan the dial set was compiled against
   * @param {DialSet} dialSet
   * @param {ArrayLike<number>} values one value per dial, in dial order; values outside a dial's range are clamped
   * @param {Object} out a `JointTransforms`; receives the proportioned rest pose
   * @returns {Object} `out`
   * @complexity O(bones + operations) time, no allocation
   * @example
   * const rest = Kit.body.applyDials(plan, dials, [1.2, 1], Kit.body.createPose(plan));   // long legs
   */
  const applyDials = (bodyPlan, dialSet, values, out) => {
    copyRest(bodyPlan, out);
    for (let operation = 0; operation < dialSet.opDial.length; operation++) {
      const dial = dialSet.opDial[operation];
      const bone = dialSet.opBone[operation];
      const value = Math.min(dialSet.max[dial], Math.max(dialSet.min[dial], values[dial]));
      const factor = 1 + (value - 1) * dialSet.opAmount[operation];
      const channel = dialSet.opChannel[operation];
      if (channel === CHANNELS.pitch) {
        // Turning a rotation by itself is safe: Kit.rig.turn reads the base before it writes.
        Kit.rig.turn(out.rotation, out.rotation, bone, AXES.x, (value - dialSet.defaults[dial]) * dialSet.opAmount[operation] * DEGREES_TO_RADIANS);
        continue;
      }
      if (channel === CHANNELS.size) {
        out.uniform[bone] *= factor;
        continue;
      }
      const longAxis = bodyPlan.axis[bone];
      // Length stretches the long axis; girth stretches the two axes across it.
      for (let axis = 0; axis < VECTOR_STRIDE; axis++) {
        if ((axis === longAxis) === (channel === CHANNELS.length)) out.scale[bone * VECTOR_STRIDE + axis] *= factor;
      }
    }
    return out;
  };

  /**
   * Splits every `sided` dial row into a left and a right row, '<id>@left' and '<id>@right': role effects gain the
   * side's role, feature effects gain `side`. Other rows pass through unchanged. Compile the result with `dials`.
   * @param {Object[]} rows `DialRow`s
   * @returns {Object[]} `DialRow`s; sided rows carry `base`, `side` and `twin`
   * @throws {Error} for an id containing '@', or a sided effect that selects bones by name or by part (a side
   *   cannot be added to a name; use roles)
   * @complexity O(rows x effects)
   * @example Kit.body.sidedDials([{ id: 'earSize', sided: true, min: 0.8, max: 1.3, affects: [{ feature: 'ear', param: 'size' }] }]).map((row) => row.id) // ['earSize@left', 'earSize@right']
   */
  const sidedDials = (rows) =>
    rows.flatMap((row) => {
      if (String(row.id).includes(SIDE_SEPARATOR)) fail('sidedDials', `the dial id "${row.id}" contains '${SIDE_SEPARATOR}', which joins a sided dial and its side. Rename it.`);
      if (!row.sided) return [row];
      return SIDES.map((side, index) => ({
        ...row,
        id: `${row.id}${SIDE_SEPARATOR}${side}`,
        base: row.id,
        side,
        twin: `${row.id}${SIDE_SEPARATOR}${SIDES[1 - index]}`,
        affects: (row.affects || []).map((effect) => {
          if (effect.feature !== undefined) return { ...effect, side };
          if (effect.bones || effect.part || !effect.roles)
            fail('sidedDials', `the sided dial "${row.id}" has an effect that picks bones by name or part; a sided effect picks them by \`roles\` (the side role is added) or drives a \`feature\`.`);
          return { ...effect, roles: [...effect.roles, side] };
        }),
      }));
    });

  /** 'profile.2.0' -> ['profile', 2, 0]: array steps become numbers so a copy can tell lists from objects. */
  const parseParamPath = (text) =>
    String(text)
      .split(PARAM_PATH_SEPARATOR)
      .map((key) => (/^\d+$/.test(key) ? Number(key) : key));
  /** The value at a parsed path, or undefined when a step is missing. */
  const numberAtPath = (value, path) => path.reduce((inner, key) => (inner === null || inner === undefined ? undefined : inner[key]), value);

  /** The bones a dial effect names: by roles, by name, and by name inside a part wherever that part is attached. */
  const bonesOfEffect = (bodyPlan, effect) => {
    const byRole = effect.roles ? bonesWithRoles(bodyPlan, roleMask(effect.roles)) : [];
    // A part's bones are named '<socket path>/<bone>' once attached (kit/body-parts.js).
    const prefixes = effect.part
      ? Object.keys(bodyPlan.filled)
          .filter((path) => bodyPlan.filled[path] === effect.part)
          .map((path) => `${path}/`)
      : [''];
    const wanted = effect.part && !effect.bones ? null : effect.bones || [];
    const byName = bodyPlan.boneNames
      .map((name, bone) => ({ name, bone }))
      .filter(({ name }) => prefixes.some((prefix) => name.startsWith(prefix) && (wanted === null ? !name.slice(prefix.length).startsWith('@') : wanted.includes(name.slice(prefix.length)))))
      .map(({ bone }) => bone);
    return [...new Set([...byRole, ...(effect.part || effect.bones ? byName : [])])];
  };

  /** A copy of a shape row deep enough to write numbers into: objects and lists are copied, numbers kept. */
  const copyShape = (value) =>
    Array.isArray(value) ? value.map(copyShape) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).map((key) => [key, copyShape(value[key])])) : value;

  /**
   * Every bone's shape with the shape dials applied: what a renderer draws for an individual. Bones no dial
   * touches share the plan's own shape row; touched ones get a fresh copy, so the plan is never written.
   * @param {BodyPlan} bodyPlan the plan the dial set was compiled against
   * @param {DialSet} dialSet
   * @param {ArrayLike<number>} values one per dial, clamped to each dial's range
   * @returns {ReadonlyArray<?Object>} one per bone: a shape row, or null for the default capsule
   * @complexity O(bones) when a shape op exists (plus the copies of touched shapes), O(1) and no allocation when none does
   * @example
   * const shapes = Kit.body.shapesWithDials(plan, dialSet, values);
   * shapes[plan.boneIndex('head')].profile[2][0]   // the jaw radius this individual has
   */
  const shapesWithDials = (bodyPlan, dialSet, values) => {
    if (!dialSet.shapeOps.length) return bodyPlan.shapes;
    const shapes = [...bodyPlan.shapes];
    const copied = new Set();
    dialSet.shapeOps.forEach(({ dial, bone, path, amount, mode }) => {
      if (!copied.has(bone)) {
        shapes[bone] = copyShape(shapes[bone]);
        copied.add(bone);
      }
      const value = Math.min(dialSet.max[dial], Math.max(dialSet.min[dial], values[dial]));
      const holder = numberAtPath(shapes[bone], path.slice(0, -1));
      const key = path[path.length - 1];
      holder[key] = PARAM_MODES[mode](holder[key], value, dialSet.defaults[dial], amount);
    });
    return Object.freeze(shapes);
  };

  Kit.body = Object.assign(Kit.body || {}, {
    ROLES,
    CAPABILITIES,
    CAPABILITY_ROWS,
    ROLE_GROUPS,
    CHANNELS,
    JOINTS,
    SHAPES,
    PHYSICAL_DEFAULTS,
    SOFT_KINDS,
    roleMask,
    capabilityNames,
    groupOf,
    socketType,
    socketTypeName,
    plan,
    requirement,
    fits,
    missing,
    requireFit,
    bonesWithRoles,
    chains,
    createPose,
    copyRest,
    worldTransforms,
    socketPosition,
    tailPosition,
    lowestY,
    bendDirection,
    bendAgrees,
    boneLength,
    boneMasses,
    centerOfMass,
    dials,
    applyDials,
    shapesWithDials,
    sidedDials,
    SIDE_SEPARATOR,
    PARAM_MODES,
    parseParamPath,
    numberAtPath,
  });
})();
