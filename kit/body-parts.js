/**
 * Kit body parts: things that plug into sockets. A part is a small body plan of its own (a hat, a sword, a pair
 * of wings, a gem) that says which socket types it fits and may expose sockets for further parts, so a gem sits
 * on a sword that sits in a hand. Props are parts; there is no second mechanism for them.
 *
 * Owns:  `Kit.body.part` (compile a part), `Kit.body.assemble` (plan + fills -> a new plan with the parts' bones,
 *        sockets, surface features and regions appended, type-checked), `Kit.body.canAttach` and
 *        `Kit.body.openSockets`.
 * Does not own: the plan format, kinematics or capabilities (kit/body-plan.js: an assembled body IS a plan, so
 *        all of that works on it unchanged), nor which parts an individual wears (kit/body-recipe.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Separates the steps of a nested socket path and prefixes the bones of an attached part: 'handRight/gem'. */
  const PATH_SEPARATOR = '/';
  /** Name (after the socket path) of the bone inserted at a filled socket; a part's own bones hang from it. */
  const MOUNT_BONE = '@mount';
  const PROP_ROLE = 'prop';
  /** In a part's features and regions, the bone of the socket the part sits in: eyes go on whatever head holds them. */
  const HOST_BONE = '@host';
  /** The stand-in bone of a part that is only features or regions, so `part.plan` is still a plan. */
  const SURFACE_ONLY_BONES = Object.freeze([Object.freeze({ name: 'surface', roles: ['root'], shape: Object.freeze({ kind: 'none' }) })]);

  const fail = (where, message) => {
    throw new Error(`Kit.body.${where}: ${message}`);
  };

  /**
   * @typedef {Object} PartSpec
   * @property {string} id name of the part ('sword')
   * @property {string[]} fits socket types this part plugs into (['grip'])
   * @property {string} [anchor] name of one of the part's own sockets: the point of the part that sits on the
   *   host socket (a sword's grip). It is used up by attaching, so it is not a socket of the assembled body.
   *   Default: the part's origin.
   * @property {Object[]} bones the part's bones, as `BoneSpec` rows of kit/body-plan.js; may be empty for a part
   *   that is only `features` and / or `regions` (a pair of eyes, a printed shirt)
   * @property {Object[]} [sockets] the part's own sockets, as `SocketSpec` rows; other parts attach here
   * @property {Object[]} [features] surface features (kit/body-surface.js `FeatureSpec`); `bone` names one of
   *   the part's bones, a bone of the wearer (any name the part does not have), or is omitted (or '@host') for
   *   the bone of the socket the part sits in
   * @property {Object[]} [regions] painted regions (kit/body-surface.js `RegionSpec`); `roles` select bones of
   *   the whole wearer, `bones` names bones as a feature's `bone` does
   * @property {string} [label] what an editor calls the part (default: worked out from the id)
   * @property {string} [icon] the name of an icon an editor shows for it
   * @property {string[]} [capabilities] declared capabilities the part grants its wearer (such as 'hover')
   */

  /**
   * @typedef {Object} Part
   * @property {string} id
   * @property {PartSpec} spec the data it was compiled from
   * @property {ReadonlyArray<string>} fits socket type names it plugs into
   * @property {Uint16Array} fitTypes the same as type ids (`Kit.body.socketType`)
   * @property {ReadonlyArray<number>} anchorPosition [x, y, z] of the anchor in the part's own space at rest
   * @property {Object} plan the part alone as a `BodyPlan` (a sword lying on the ground poses and draws like a body)
   */

  /**
   * Compiles a part. The part alone is a valid body plan (`part.plan`), which is what makes props free: anything
   * that can pose or draw a plan can pose or draw a dropped sword.
   * @param {PartSpec} spec
   * @returns {Part}
   * @throws {Error} naming the part and the cause: no `fits`, an anchor that is not one of its sockets, or
   *   anything `Kit.body.plan` rejects
   * @complexity O(bones + sockets) time and space, once per part
   * @example
   * const sword = Kit.body.part({
   *   id: 'sword', fits: ['grip'], anchor: 'grip',
   *   bones: [{ name: 'blade', tail: [0, 0.9, 0], roles: ['root'] }],
   *   sockets: [{ name: 'grip', bone: 'blade', type: 'grip', at: [0, 0.1, 0] }, { name: 'gem', bone: 'blade', type: 'gem' }],
   * });
   */
  const part = (spec) => {
    if (!spec || typeof spec.id !== 'string' || !spec.id) fail('part', 'a part needs a string `id`.');
    const where = `part("${spec.id}")`;
    if (!Array.isArray(spec.fits) || !spec.fits.length) fail(where, "a part needs `fits`: the socket types it plugs into, e.g. ['grip'].");
    const isSurfaceOnly = Array.isArray(spec.bones) && !spec.bones.length;
    if (isSurfaceOnly && !(spec.features || []).length && !(spec.regions || []).length) fail(where, 'a part with no bones must bring `features` or `regions`; otherwise it adds nothing.');
    if (isSurfaceOnly && (spec.sockets || []).length) fail(where, 'a part with no bones cannot offer sockets (a socket rides on a bone).');
    // A surface-only part still compiles to a plan (one bone that draws nothing), so it can be shown on its own.
    const plan = Kit.body.plan({
      id: spec.id,
      bones: isSurfaceOnly ? SURFACE_ONLY_BONES : spec.bones,
      sockets: spec.sockets,
      capabilities: spec.capabilities,
      features: spec.features,
      regions: spec.regions,
    });
    const anchorPosition = [0, 0, 0];
    if (spec.anchor !== undefined) {
      if (!plan.socketNames.includes(spec.anchor)) fail(where, `the anchor "${spec.anchor}" is not one of the part's sockets (${plan.socketNames.join(', ') || 'it has none'}).`);
      // Where the anchor sits at rest, whatever bone it rides on: one forward pass over the part's own plan.
      const restWorld = Kit.body.worldTransforms(plan, Kit.body.createPose(plan), Kit.body.createPose(plan));
      Kit.body.socketPosition(plan, restWorld, plan.socketIndex(spec.anchor), anchorPosition);
    }
    return Object.freeze({ id: spec.id, spec, fits: Object.freeze([...spec.fits]), fitTypes: Uint16Array.from(spec.fits, Kit.body.socketType), anchorPosition: Object.freeze(anchorPosition), plan });
  };

  /**
   * Can this part go in this socket of this plan? The type check alone: one integer compare per type the part fits.
   * @param {Object} bodyPlan a `BodyPlan`
   * @param {string} socketName a socket of the plan (a nested one is 'handRight/gem')
   * @param {Part} candidate
   * @returns {boolean} false too when the socket is already filled
   * @throws {Error} when the plan has no such socket
   * @complexity O(types the part fits)
   * @example Kit.body.canAttach(bipedPlan, 'handRight', hat) // false: a hat fits 'headTop', the hand is a 'grip'
   */
  const canAttach = (bodyPlan, socketName, candidate) => !bodyPlan.filled[socketName] && candidate.fitTypes.includes(bodyPlan.socketType[bodyPlan.socketIndex(socketName)]);

  /**
   * The sockets of a plan that nothing is attached to.
   * @param {Object} bodyPlan a `BodyPlan`
   * @returns {string[]} socket names, in plan order
   * @complexity O(sockets)
   * @example Kit.body.openSockets(armedBiped) // ['headTop', 'handLeft', 'back', 'handRight/gem']
   */
  const openSockets = (bodyPlan) => bodyPlan.socketNames.filter((name) => !bodyPlan.filled[name]);

  const depthOf = (path) => path.split(PATH_SEPARATOR).length;
  /**
   * Orders socket paths canonically: shallow first (a sword must be in the hand before its gem socket exists),
   * then by name. Everything that walks fills uses this order, so hashes and encodings agree.
   * @param {string} first a socket path
   * @param {string} second a socket path
   * @returns {number} negative, zero or positive, as `Array.prototype.sort` expects
   * @complexity O(path length)
   * @example ['handRight/gem', 'back', 'handRight'].sort(Kit.body.compareSocketPaths) // ['back', 'handRight', 'handRight/gem']
   */
  const byDepthThenName = (first, second) => depthOf(first) - depthOf(second) || (first < second ? -1 : first > second ? 1 : 0);

  /** The bones, sockets, features and regions one attached part adds to a plan spec, renamed under the socket's path. */
  const graft = (attached, socket) => {
    const prefix = `${socket.name}${PATH_SEPARATOR}`;
    const mountName = `${prefix}${MOUNT_BONE}`;
    // A part's own bone names gain the prefix; '@host' (or no bone at all) is the bone of the socket it sits in;
    // any other name is a bone of the wearer (a pair of trousers paints 'pelvis' and the legs).
    const ownBones = new Set(attached.spec.bones.map((bone) => bone.name));
    const boneOf = (name) => (name === undefined || name === HOST_BONE ? socket.bone : ownBones.has(name) ? `${prefix}${name}` : name);
    const source = { part: attached.id, socket: socket.name };
    const features = (attached.spec.features || []).map((feature) => ({ ...feature, bone: boneOf(feature.bone), ...source }));
    const regions = (attached.spec.regions || []).map((region) => ({ ...region, ...(region.bones ? { bones: region.bones.map(boneOf) } : {}), ...source }));
    if (!attached.spec.bones.length) return { bones: [], sockets: [], features, regions };
    // The mount bone carries the socket's offset and keeps the host bone's stretch out of the part: a part's
    // bones hang from it, so "longer forearm" moves the sword without lengthening it. It draws nothing.
    const mount = { name: mountName, parent: socket.bone, at: socket.at || [0, 0, 0], roles: [PROP_ROLE], shape: { kind: 'none' } };
    const bones = attached.spec.bones.map((bone) => ({
      ...bone,
      name: `${prefix}${bone.name}`,
      parent: bone.parent === undefined ? mountName : `${prefix}${bone.parent}`,
      // A root bone of the part is shifted so the part's anchor lands exactly on the socket.
      at: bone.parent === undefined ? (bone.at || [0, 0, 0]).map((value, axis) => value - attached.anchorPosition[axis]) : bone.at,
      roles: [...new Set([...(bone.roles || []), PROP_ROLE])],
    }));
    const sockets = (attached.spec.sockets || []).filter((own) => own.name !== attached.spec.anchor).map((own) => ({ ...own, name: `${prefix}${own.name}`, bone: `${prefix}${own.bone}` }));
    return { bones: [mount, ...bones], sockets, features, regions };
  };

  /**
   * Attaches parts to sockets and returns the result as a new body plan: the host's bones, then for each filled
   * socket a mount bone and the part's bones (named '<socket>/<bone>'), plus the part's own sockets (named
   * '<socket>/<name>') ready for further parts. Because the result is an ordinary plan, kinematics, dials,
   * capabilities and renderers need no special case for props: wings from a part give the plan `wings`.
   * @param {Object} bodyPlan the host `BodyPlan` (itself possibly assembled: attaching is incremental)
   * @param {Object<string, ?string>} fills socket name -> part id; null or undefined leaves a socket empty. A
   *   nested socket is addressed by its path, and its parent must be filled in the same call or before.
   * @param {Object<string, Part>} parts compiled parts by id
   * @returns {Object} a new `BodyPlan` whose `filled` records what sits where; the host itself when `fills` fills nothing
   * @throws {Error} naming the socket, the part and the fix: an unknown part or socket, a socket already filled,
   *   or a part that does not fit the socket's type
   * @complexity O(host bones + part bones + sockets) time and space; do it once per distinct outfit and keep the plan
   * @example
   * const armed = Kit.body.assemble(bipedPlan, { handRight: 'sword', 'handRight/gem': 'ruby' }, parts);
   * armed.boneIndex('handRight/blade');   // the sword's bone, posed and drawn like any other
   */
  const assemble = (bodyPlan, fills, parts) => {
    const paths = Object.keys(fills)
      .filter((path) => fills[path] !== null && fills[path] !== undefined)
      .sort(byDepthThenName);
    if (!paths.length) return bodyPlan;
    const where = `assemble("${bodyPlan.id}")`;
    const bones = [...bodyPlan.spec.bones];
    const sockets = [...(bodyPlan.spec.sockets || [])];
    const features = [...(bodyPlan.spec.features || [])];
    const regions = [...(bodyPlan.spec.regions || [])];
    const filled = { ...bodyPlan.filled };
    const declared = new Set(bodyPlan.spec.capabilities || []);
    paths.forEach((path) => {
      const partId = fills[path];
      const attached = parts[partId];
      if (!attached) fail(where, `socket "${path}" asks for the part "${partId}", which is not in \`parts\`. Parts: ${Object.keys(parts).join(', ') || '(none)'}.`);
      const socket = sockets.find((candidate) => candidate.name === path);
      if (!socket)
        fail(
          where,
          `there is no socket "${path}"${path.includes(PATH_SEPARATOR) ? ' (a nested socket exists only once its parent socket holds a part that has it)' : ''}. Sockets: ${sockets.map((candidate) => candidate.name).join(', ') || '(none)'}.`
        );
      if (filled[path]) fail(where, `socket "${path}" already holds "${filled[path]}". Assemble from the bare plan to change it.`);
      if (!attached.fits.includes(socket.type))
        fail(
          where,
          `the part "${partId}" fits ${attached.fits.join(', ')} sockets, but "${path}" is a ${socket.type} socket. Put it in a ${attached.fits.join(' or ')} socket, or add '${socket.type}' to the part's \`fits\`.`
        );
      const grafted = graft(attached, socket);
      bones.push(...grafted.bones);
      sockets.push(...grafted.sockets);
      features.push(...grafted.features);
      regions.push(...grafted.regions);
      (attached.spec.capabilities || []).forEach((name) => declared.add(name));
      filled[path] = partId;
    });
    const outfit = Object.keys(filled)
      .sort(byDepthThenName)
      .map((path) => `${path}=${filled[path]}`)
      .join(',');
    const id = `${bodyPlan.id.split('[')[0]}[${outfit}]`;
    // Parts that are only surface (eyes, a printed shirt) add no bone, socket or capability, and nothing a
    // compiled plan holds is derived from features or regions: the host's compiled arrays are shared and only
    // the spec, the id and `filled` are new. Swapping a face part then costs no skeleton compile.
    const isSurfaceOnly = paths.every((path) => !parts[fills[path]].spec.bones.length && !(parts[fills[path]].spec.capabilities || []).length);
    if (isSurfaceOnly) {
      // In the order a single assemble from the bare plan would record them.
      const inOrder = Object.freeze(Object.fromEntries(Object.keys(filled).sort(byDepthThenName).map((path) => [path, filled[path]])));
      return Object.freeze({ ...bodyPlan, id, filled: inOrder, spec: Object.freeze({ ...bodyPlan.spec, id, filled: inOrder, features, regions }) });
    }
    return Kit.body.plan({ id, bones, sockets, capabilities: [...declared], filled, features, regions });
  };

  Kit.body = Object.assign(Kit.body || {}, { part, canAttach, openSockets, assemble, SOCKET_PATH_SEPARATOR: PATH_SEPARATOR, MOUNT_BONE, HOST_BONE, compareSocketPaths: byDepthThenName });
})();
