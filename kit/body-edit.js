/**
 * Kit body edit: everything a character editor needs from a catalogue, with no editor in it. A schema that
 * lists every dial, colour channel and socket of a recipe as data (so the editor's controls are generated, not
 * written), edits as pure functions from a recipe to a new recipe, and a report of what changed between two
 * bakes (so a renderer updates only that).
 *
 * Owns:  `Kit.body.editor(catalog)` and what it returns: `schema`, `setDial`, `setSocket`, `setColor`,
 *        `randomize`, `mirror` and `changes`.
 * Does not own: any interface (a creator screen builds its sliders and lists from `schema` with kit/ui/),
 *        validation rules, derivation or baking (kit/body-recipe.js: every edit goes through `normalize`, so an
 *        edit can only produce a recipe the catalogue accepts), or undo (`Kit.history` in kit/space.js holds
 *        recipes as they are plain data).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** The two sides `mirror` knows, and which role each one swaps with. */
  const OPPOSITE_SIDE = Object.freeze({ left: 'right', right: 'left' });
  const DIAL_KEY = 'dial:';
  /** The editor group of a colour channel that no `controls` row places. */
  const DEFAULT_COLOR_GROUP = 'colors';
  const COLOR_KEY = 'color:';
  const FILL_KEY = 'fill:';
  /** Problems that mean "this locked or mirrored field cannot be kept after the change"; such fields are dropped. */
  const DROPPABLE_PROBLEMS = ['no-such-socket', 'part-does-not-fit', 'unknown-field'];

  const fail = (where, message) => {
    throw new Error(`Kit.body.editor.${where}: ${message}`);
  };

  /**
   * The fields a control metadata row may set, field -> a check of its value. A species states rows in its
   * definition, `controls: { 'dial:height': { label: 'Height', group: 'body', order: 1, hint: '...', step: 0.01,
   * icon: 'ruler' } }`, and `groups: { body: { label: 'Body', order: 1, icon: 'figure' } }`; both inherit through
   * the lineage like any other value, so a variant can relabel or regroup a control.
   */
  const META_FIELDS = Object.freeze({
    label: (value) => typeof value === 'string',
    group: (value) => typeof value === 'string',
    order: Number.isFinite,
    hint: (value) => typeof value === 'string',
    step: (value) => Number.isFinite(value) && value > 0,
    icon: (value) => typeof value === 'string',
  });
  const GROUP_FIELDS = Object.freeze(['label', 'order', 'icon', 'hint']);
  /** Where a control or group with no `order` sorts: after every ordered one, in the order it was listed. */
  const UNORDERED = 1e6;

  /** 'legLength' -> 'Leg length'; 'handRight/gem' -> 'Hand right / gem'. */
  const labelOf = (name) => {
    const words = name
      .replace(/\//g, ' / ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };

  /**
   * @typedef {Object} DialControl
   * @property {string} key the override key, 'dial:<id>'
   * @property {string} id
   * @property {string} label
   * @property {string} group 'head', 'arms', 'legs', 'wings', 'tail', 'fins' or 'body' (or the dial's own `group`)
   * @property {number} min
   * @property {number} max
   * @property {number} step the smallest change that makes a difference
   * @property {number} default
   * @property {number} value the individual's current value
   * @property {Array<{channel: string, bones: string[], param?: string, feature?: string}>} affects what it changes:
   *   per bone channel, per shape path (`channel: 'shape'`, `param`) or per feature parameter (`channel: 'feature'`,
   *   `feature`, `param`), with the bones of the bare plan it touches
   * @property {?string} mirror the key of the dial that does the same on the other side, when there is one
   * @property {?string} side 'left' or 'right' for a sided dial, else null
   * @property {?string} base for a dial made by `sided: true`, the id both sides share ('eyeSize'); `setDial`
   *   with it moves both
   * @property {?boolean} linked for such a dial: do both sides hold the same value (show one slider)?
   * @property {number} order where it sorts within its group (from the species' `controls` rows, else list order)
   * @property {?string} hint a sentence for a tooltip, from `controls`
   * @property {?string} icon an icon name, from `controls`
   */

  /**
   * @typedef {Object} ColorControl
   * @property {string} key the override key, 'color:<channel>'
   * @property {string} id the channel
   * @property {string} label
   * @property {string} palette the catalogue palette the channel draws from
   * @property {Object[]} ramps the choices: `Ramp` rows { id, shades: [dark ... light] }
   * @property {number} value the index of the ramp the individual uses
   * @property {string} group from `controls`, else 'colors'
   * @property {number} order
   * @property {?string} hint
   * @property {?string} icon
   */

  /**
   * @typedef {Object} SocketControl
   * @property {string} key the override key, 'fill:<path>'
   * @property {string} path
   * @property {string} label
   * @property {string} group from the roles of the bone the socket (or its outermost parent socket) rides on
   * @property {string} type the socket type
   * @property {?string} part what is in it now
   * @property {string[]} options ids of every catalogue part that fits
   * @property {boolean} allowsEmpty false for a required socket
   * @property {?string} mirror the key of the same socket on the other side, when there is one
   * @property {?string} side 'left' or 'right' for a sided socket (its own bone's side, or its parent socket's)
   * @property {Array<{id: ?string, label: string, icon: ?string, hint: ?string}>} choices what the socket can
   *   hold, as a list a picker shows: 'none' (id null) first when it may be empty, then every option with the
   *   part's own `label`, `icon` and `hint`
   * @property {number} order
   * @property {?string} hint
   * @property {?string} icon
   */

  /**
   * Makes the editing interface of a catalogue.
   * @param {Object} catalog from `Kit.body.catalog`
   * @returns {Object} `schema`, `setDial`, `setSocket`, `setColor`, `randomize`, `mirror`, `changes`; each is
   *   documented on its own function below
   * @complexity O(1) to make; per-species dial tables are compiled on first use and kept
   * @example
   * const editor = Kit.body.editor(catalog);
   * let recipe = { species: 'human', seed: 7 };
   * editor.schema(recipe).dials.forEach((dial) => addSlider(dial.label, dial.min, dial.max, dial.step, dial.value,
   *   (value) => { recipe = editor.setDial(recipe, dial.id, value); }));
   */
  const editor = (catalog) => {
    /** @type {Map<string, {affects: Array<Array<{channel: string, bones: string[]}>>, groups: string[], sides: Array<?string>, mirrors: Array<?string>}>} */
    const dialFacts = new Map();
    const channelNames = Object.keys(Kit.body.CHANNELS);

    /** Checks every species' control rows once, when the editor is made: a misspelt key is named at load. */
    catalog.speciesIds().forEach((speciesId) => {
      const kind = catalog.species(speciesId);
      const where = `editor: species "${speciesId}"`;
      const controls = kind.definition.controls || {};
      const knownKeys = new Set([
        ...kind.dialRows.flatMap((row) => [`${DIAL_KEY}${row.id}`, ...(row.base ? [`${DIAL_KEY}${row.base}`] : [])]),
        ...kind.colorIds.map((channel) => `${COLOR_KEY}${channel}`),
      ]);
      Object.keys(controls).forEach((key) => {
        // A fill key may name a nested socket that exists only under some parts, so any path is accepted.
        if (!key.startsWith(FILL_KEY) && !knownKeys.has(key))
          fail(where, `controls has a row for "${key}", which is not a dial or colour of this species. Keys look like 'dial:height', 'color:skin' or 'fill:hat'.`);
        Object.keys(controls[key]).forEach((field) => {
          if (!META_FIELDS[field]) fail(where, `controls."${key}" sets "${field}"; a control row sets ${Object.keys(META_FIELDS).join(', ')}.`);
          if (!META_FIELDS[field](controls[key][field])) fail(where, `controls."${key}".${field} = ${JSON.stringify(controls[key][field])} is not a valid ${field}.`);
        });
      });
      Object.keys(kind.definition.groups || {}).forEach((group) =>
        Object.keys(kind.definition.groups[group]).forEach((field) => {
          if (!GROUP_FIELDS.includes(field)) fail(where, `groups.${group} sets "${field}"; a group row sets ${GROUP_FIELDS.join(', ')}.`);
        })
      );
    });

    /** A control's metadata row: its own key first, then (for one side of a sided dial) its base key. */
    const metaOf = (kind, key, baseKey) => ({ ...((kind.definition.controls || {})[baseKey] || {}), ...((kind.definition.controls || {})[key] || {}) });
    /** The fields every control gets from its metadata row, with the defaults a creator can rely on. */
    const metaFields = (meta, listOrder) => ({ order: meta.order === undefined ? UNORDERED + listOrder : meta.order, hint: meta.hint || null, icon: meta.icon || null });
    /** What a socket can hold, as picker rows. */
    const choicesOf = (options, allowsEmpty) => [
      ...(allowsEmpty ? [{ id: null, label: 'None', icon: null, hint: null }] : []),
      ...options.map((partId) => {
        const partSpec = catalog.parts[partId].spec;
        return { id: partId, label: partSpec.label || labelOf(partId), icon: partSpec.icon || null, hint: partSpec.hint || null };
      }),
    ];
    /** Every group the controls use, as rows in display order. */
    const groupsOf = (kind, controls) => {
      const rows = kind.definition.groups || {};
      const used = [...new Set(controls.map((control) => control.group))];
      return used
        .map((group, listOrder) => ({
          id: group,
          label: (rows[group] || {}).label || labelOf(group),
          order: (rows[group] || {}).order === undefined ? UNORDERED + listOrder : rows[group].order,
          icon: (rows[group] || {}).icon || null,
          hint: (rows[group] || {}).hint || null,
        }))
        .sort((first, second) => first.order - second.order);
    };

    /** What each dial of a species touches on the bare plan, its group, its side and its opposite: worked out once. */
    const dialFactsOf = (kind) => {
      const known = dialFacts.get(kind.id);
      if (known) return known;
      const dialSet = Kit.body.dials(kind.plan, kind.dialRows);
      const affects = kind.dialIds.map(() => []);
      const firstBone = kind.dialIds.map(() => -1);
      /** One affects row per channel (or per shape path, or per feature parameter), listing the bones it touches. */
      const addAffect = (dial, channel, bone, detail = {}) => {
        const entry =
          affects[dial].find((row) => row.channel === channel && row.param === detail.param && row.feature === detail.feature) ||
          affects[dial][affects[dial].push({ channel, ...detail, bones: [] }) - 1];
        if (bone < 0) return;
        entry.bones.push(kind.plan.boneNames[bone]);
        if (firstBone[dial] < 0) firstBone[dial] = bone;
      };
      dialSet.opDial.forEach((dial, operation) => addAffect(dial, channelNames[dialSet.opChannel[operation]], dialSet.opBone[operation]));
      dialSet.shapeOps.forEach((operation) => addAffect(operation.dial, 'shape', operation.bone, { param: operation.path.join('.') }));
      dialSet.featureOps.forEach((operation) => addAffect(operation.dial, 'feature', -1, { feature: operation.feature, param: operation.path.join('.') }));
      // A dial is sided when every effect names a side role; its mirror is the dial with the same effects on the other side.
      const signature = (row, swap) => JSON.stringify((row.affects || []).map((effect) => ({ ...effect, roles: (effect.roles || []).map((role) => (swap && OPPOSITE_SIDE[role]) || role).sort() })));
      // A sided row says its side; an older pair of rows is sided when every effect names a side role.
      const sides = kind.dialRows.map(
        (row) => row.side || Object.keys(OPPOSITE_SIDE).find((side) => (row.affects || []).length > 0 && row.affects.every((effect) => (effect.roles || []).includes(side))) || null
      );
      const facts = {
        affects,
        groups: kind.dialRows.map((row, dial) => row.group || (firstBone[dial] < 0 ? Kit.body.groupOf(0) : Kit.body.groupOf(kind.plan.roles[firstBone[dial]]))),
        sides,
        mirrors: kind.dialRows.map((row, dial) => {
          if (row.twin) return `${DIAL_KEY}${row.twin}`;
          const other = sides[dial] ? kind.dialRows.find((candidate) => candidate !== row && signature(candidate, false) === signature(row, true)) : null;
          return other ? `${DIAL_KEY}${other.id}` : null;
        }),
      };
      dialFacts.set(kind.id, facts);
      return facts;
    };

    /** The side role ('left' / 'right') and editor group of a top-level socket, from its bone's roles. */
    const socketPlacement = (kind, socketName) => {
      const roles = kind.plan.roles[kind.plan.socketBone[kind.plan.socketIndex(socketName)]];
      return { roles, side: Object.keys(OPPOSITE_SIDE).find((side) => roles & Kit.body.roleMask([side])) || null, group: Kit.body.groupOf(roles) };
    };

    const sideOfRoles = (roles) => Object.keys(OPPOSITE_SIDE).find((side) => roles & Kit.body.roleMask([side])) || null;
    /** The roles with their side swapped: what the bone of the mirrored socket carries. */
    const swappedRoles = (roles, side) => (roles ^ Kit.body.roleMask([side, OPPOSITE_SIDE[side]])) >>> 0;

    /**
     * The side of a socket and the path of its mirror, or nulls. A top-level socket is sided by its bone; a
     * nested one inherits its parent socket's side (the gem of the left hand's sword), or, under a part that sits
     * in the middle (a pair of wings on the back), is sided by the part's own bone and mirrors to the sibling
     * socket of the same type whose bone carries the other side.
     */
    const mirrorOf = (kind, fills, path) => {
      const cut = path.lastIndexOf(Kit.body.SOCKET_PATH_SEPARATOR);
      if (cut < 0) {
        const { roles, side } = socketPlacement(kind, path);
        if (!side) return { side: null, path: null };
        const type = kind.plan.socketType[kind.plan.socketIndex(path)];
        const other = kind.plan.socketNames.find((_name, index) => kind.plan.socketType[index] === type && kind.plan.roles[kind.plan.socketBone[index]] === swappedRoles(roles, side));
        return { side, path: other || null };
      }
      const parentPath = path.slice(0, cut);
      const name = path.slice(cut + 1);
      const parent = mirrorOf(kind, fills, parentPath);
      if (parent.side) return { side: parent.side, path: parent.path && `${parent.path}${Kit.body.SOCKET_PATH_SEPARATOR}${name}` };
      const part = catalog.parts[fills[parentPath]];
      const sockets = (part && part.spec.sockets) || [];
      const boneRoles = (socketName) => {
        const socket = sockets.find((candidate) => candidate.name === socketName);
        const bone = socket && part.spec.bones.find((candidate) => candidate.name === socket.bone);
        return bone ? Kit.body.roleMask(bone.roles || []) : 0;
      };
      const roles = boneRoles(name);
      const side = sideOfRoles(roles);
      if (!side) return { side: null, path: null };
      const type = sockets.find((candidate) => candidate.name === name).type;
      const sibling = sockets.find((candidate) => candidate.type === type && boneRoles(candidate.name) === swappedRoles(roles, side));
      return { side, path: sibling ? `${parentPath}${Kit.body.SOCKET_PATH_SEPARATOR}${sibling.name}` : null };
    };

    /**
     * Everything editable about a recipe, as data, in a stable order: dials in species order, colour channels in
     * species order, sockets parents-first. Generate the editor's controls from this; nothing about a species
     * needs to be written into the editor.
     * @param {Object} recipe a `Recipe`; nested sockets are listed for what it currently wears
     * @returns {{species: string, dials: DialControl[], colors: ColorControl[], sockets: SocketControl[], groups: Array<{id: string, label: string, order: number, icon: ?string, hint: ?string}>}}
     *   `groups` lists every group the controls use, sorted by the species' `groups` rows (then first use)
     * @throws {Error} as `catalog.resolve`
     * @complexity O(dials + channels + sockets x parts) time and space; cheap enough to rebuild after every edit
     * @example editor.schema({ species: 'human', seed: 7 }).sockets.map((socket) => socket.label) // ['Back', 'Hand left', ...]
     */
    const schema = (recipe) => {
      const individual = catalog.resolve(recipe);
      const kind = catalog.species(individual.species);
      const facts = dialFactsOf(kind);
      const controls = {
        species: kind.id,
        dials: kind.dialRows.map((row, dial) => {
          const meta = metaOf(kind, `${DIAL_KEY}${row.id}`, row.base ? `${DIAL_KEY}${row.base}` : null);
          return {
            key: `${DIAL_KEY}${row.id}`,
            id: row.id,
            label: meta.label || row.label || labelOf(row.base || row.id),
            group: meta.group || facts.groups[dial],
            ...metaFields(meta, dial),
            min: row.min,
            max: row.max,
            // A slider step: the species' own, never finer than one stored step.
            step: Math.max(meta.step || 0, (row.max - row.min) / Kit.body.DIAL_STEPS),
            default: row.default === undefined ? 1 : row.default,
            value: individual.dials[dial],
            affects: facts.affects[dial],
            mirror: facts.mirrors[dial],
            side: facts.sides[dial],
            base: row.base || null,
            // A sided pair is linked while both sides hold the same value: one slider moves both.
            linked: row.twin ? individual.dials[dial] === individual.dials[kind.dialIds.indexOf(row.twin)] : null,
          };
        }),
        colors: kind.colorIds.map((channel, index) => {
          const meta = metaOf(kind, `${COLOR_KEY}${channel}`, null);
          return {
            key: `${COLOR_KEY}${channel}`,
            id: channel,
            label: meta.label || labelOf(channel),
            group: meta.group || DEFAULT_COLOR_GROUP,
            ...metaFields(meta, index),
            palette: kind.paletteNames[index],
            ramps: kind.palettes[index],
            value: individual.colors[index],
          };
        }),
        sockets: catalog.socketsOf(individual).map((socket, index) => {
          const { side, path: mirrorPath } = mirrorOf(kind, individual.fills, socket.path);
          const meta = metaOf(kind, `${FILL_KEY}${socket.path}`, null);
          return {
            key: `${FILL_KEY}${socket.path}`,
            path: socket.path,
            label: meta.label || socket.label || labelOf(socket.path),
            group: meta.group || socketPlacement(kind, socket.path.split(Kit.body.SOCKET_PATH_SEPARATOR)[0]).group,
            ...metaFields(meta, index),
            choices: choicesOf(socket.fits, !socket.required),
            type: socket.type,
            part: socket.part,
            options: socket.fits,
            allowsEmpty: !socket.required,
            mirror: mirrorPath ? `${FILL_KEY}${mirrorPath}` : null,
            side,
          };
        }),
      };
      return { ...controls, groups: groupsOf(kind, [...controls.dials, ...controls.colors, ...controls.sockets]) };
    };

    /** A recipe with some overrides replaced; `drop` removes keys first. Normalised, so it is valid or it throws. */
    const withOverrides = (recipe, changes, drop = /** @type {function(string): boolean} */ (() => false)) => {
      const kept = Object.fromEntries(
        Object.keys(recipe.overrides || {})
          .filter((key) => !drop(key))
          .map((key) => [key, recipe.overrides[key]])
      );
      return catalog.normalize({ species: recipe.species, seed: recipe.seed, overrides: { ...kept, ...changes } });
    };

    /**
     * Sets a dial. The value is clamped to the dial's range and snapped to its steps, so it is safe to call
     * with a raw slider value on every drag event. For a sided dial, the base id ('eyeSize') sets both sides
     * (linked) and a side's own id ('eyeSize@left') sets that side alone (unlinked).
     * @param {Object} recipe
     * @param {string} dialId
     * @param {number} value
     * @returns {Object} a new, normalised recipe; the input is not changed
     * @throws {Error} '[unknown-field] ...' for a dial the species lacks, '[bad-value] ...' for a non-number
     * @complexity O(fields of the species + overrides log overrides): a few microseconds
     * @example recipe = editor.setDial(recipe, 'legLength', 1.15);
     */
    const setDial = (recipe, dialId, value) => {
      const kind = catalog.species(recipe.species);
      // The base id of a sided pair is the linked slider: it moves both sides.
      if (!kind.dialIds.includes(dialId) && kind.dialIds.includes(`${dialId}${Kit.body.SIDE_SEPARATOR}left`))
        return withOverrides(recipe, Object.fromEntries(['left', 'right'].map((side) => [`${DIAL_KEY}${dialId}${Kit.body.SIDE_SEPARATOR}${side}`, value])));
      return withOverrides(recipe, { [`${DIAL_KEY}${dialId}`]: value });
    };

    /**
     * Links a sided pair again: the other side takes this side's value, so the two move together from now on.
     * (Unlinking needs no call: set one side by its own id, 'eyeSize@left'.)
     * @param {Object} recipe
     * @param {string} baseId the pair's id without a side ('eyeSize')
     * @param {('left'|'right')} [from='left'] the side whose value both keep
     * @returns {Object} a new, normalised recipe
     * @throws {Error} '[unknown-field] ...' when the species has no such sided dial
     * @complexity as `setDial`
     * @example recipe = editor.link(recipe, 'eyeSize', 'right');
     */
    const link = (recipe, baseId, from = 'left') => {
      if (!OPPOSITE_SIDE[from]) fail('link', `the side to copy from is 'left' or 'right', got ${JSON.stringify(from)}.`);
      const individual = catalog.resolve(recipe);
      const kind = catalog.species(individual.species);
      const source = kind.dialIds.indexOf(`${baseId}${Kit.body.SIDE_SEPARATOR}${from}`);
      if (source < 0)
        fail(
          'link',
          `[unknown-field] "${kind.id}" has no sided dial "${baseId}". Sided dials: ${
            kind.dialRows
              .filter((row) => row.side === 'left')
              .map((row) => row.base)
              .join(', ') || '(none)'
          }.`
        );
      return setDial(recipe, baseId, individual.dials[source]);
    };

    /**
     * Sets a colour channel to a ramp of its palette.
     * @param {Object} recipe
     * @param {string} channel
     * @param {number} rampIndex index into the channel's `ramps` (see `schema`)
     * @returns {Object} a new, normalised recipe
     * @throws {Error} '[unknown-field] ...' or '[bad-color] ...'
     * @complexity as `setDial`
     * @example recipe = editor.setColor(recipe, 'skin', 2);
     */
    const setColor = (recipe, channel, rampIndex) => withOverrides(recipe, { [`${COLOR_KEY}${channel}`]: rampIndex });

    /**
     * Puts a part in a socket, or empties it. What was attached to the old part's own sockets goes with it.
     * @param {Object} recipe
     * @param {string} path a socket path from `schema` ('handRight', 'handRight/gem')
     * @param {?string} partId a part id from the socket's `options`, or null to empty it
     * @returns {Object} a new, normalised recipe
     * @throws {Error} '[no-such-socket] ...', '[unknown-part] ...', '[part-does-not-fit] ...' or '[socket-required] ...'
     * @complexity as `setDial`
     * @example recipe = editor.setSocket(recipe, 'handRight', 'sword');
     */
    const setSocket = (recipe, path, partId) => withOverrides(recipe, { [`${FILL_KEY}${path}`]: partId }, (key) => key.startsWith(`${FILL_KEY}${path}${Kit.body.SOCKET_PATH_SEPARATOR}`));

    /** The current value of a field key in an individual: a dial value, a ramp index, or a part id / null. */
    const currentValueOf = (kind, individual, key) => {
      if (key.startsWith(DIAL_KEY)) return individual.dials[kind.dialIds.indexOf(key.slice(DIAL_KEY.length))];
      if (key.startsWith(COLOR_KEY)) return individual.colors[kind.colorIds.indexOf(key.slice(COLOR_KEY.length))];
      return individual.fills[key.slice(FILL_KEY.length)] || null;
    };

    /** Normalises a recipe after dropping the overrides the catalogue says can no longer apply. */
    const keepWhatFits = (recipe) => {
      const unusable = catalog
        .validate(recipe)
        .filter((problem) => DROPPABLE_PROBLEMS.includes(problem.code))
        .map((problem) => problem.field);
      return withOverrides(recipe, {}, (key) => unusable.includes(key));
    };

    /**
     * Re-rolls a recipe from a new seed, keeping the fields that are locked exactly as they are now. Where the
     * species has colour rules, the colours rolled afresh are made to go with the locked ones (`catalog.reconcile`):
     * a locked skin is contrasted against and a locked shirt sets the outfit's scheme, as if they had been rolled.
     * @param {Object} recipe
     * @param {number} seed the new seed (unsigned 32-bit)
     * @param {{locked?: string[]}} [options] field keys to keep ('dial:height', 'color:skin', 'fill:handRight');
     *   a locked nested socket is only kept while its parent socket still holds a part that has it
     * @returns {Object} a new, normalised recipe: the new seed plus one override per locked field, and one per
     *   colour channel that had to change to go with a locked colour
     * @throws {Error} '[bad-seed] ...', or '[unknown-field] ...' for a locked key the species lacks
     * @complexity O(fields + locked log locked)
     * @example recipe = editor.randomize(recipe, Date.now() >>> 0, { locked: ['color:skin', 'fill:headTop'] });
     */
    const randomize = (recipe, seed, { locked = [] } = {}) => {
      const individual = catalog.resolve(recipe);
      const kind = catalog.species(individual.species);
      const kept = Object.fromEntries(
        locked.map((key) => {
          const value = currentValueOf(kind, individual, key);
          if (value === undefined) fail('randomize', `[unknown-field] "${key}" is not a field of "${kind.id}"; lock keys from \`schema\` ('dial:...', 'color:...', 'fill:...').`);
          return [key, value];
        })
      );
      const rerolled = keepWhatFits({ species: recipe.species, seed, overrides: kept });
      const settled = catalog.reconcile(rerolled, locked);
      return Object.keys(settled).length ? catalog.normalize({ ...rerolled, overrides: { ...rerolled.overrides, ...settled } }) : rerolled;
    };

    /**
     * Copies one side of the body onto the other: every sided dial and every sided socket (with what hangs from
     * it) that has a counterpart, as listed by the `mirror` fields of `schema`, including sided sockets inside a
     * part that sits in the middle (a charm on each wing). Afterwards the target side holds exactly the mirror of
     * the source side: anything filled there without a counterpart is emptied.
     * @param {Object} recipe
     * @param {('left'|'right')} [from='left'] the side to copy from
     * @returns {Object} a new, normalised recipe; unchanged in meaning when the species has nothing sided
     * @throws {Error} for a side that is neither 'left' nor 'right'
     * @complexity O(dials + sockets x parts)
     * @example recipe = editor.mirror(recipe, 'right');   // the left hand now holds what the right hand holds
     */
    const mirror = (recipe, from = 'left') => {
      if (!OPPOSITE_SIDE[from]) fail('mirror', `the side to copy from is 'left' or 'right', got ${JSON.stringify(from)}.`);
      const controls = schema(recipe);
      const copies = {};
      controls.dials.forEach((dial) => {
        if (dial.mirror && dial.side === from) copies[dial.mirror] = dial.value;
      });
      controls.sockets.forEach((socket) => {
        if (socket.mirror && socket.side === from) copies[socket.mirror] = socket.part;
      });
      // Clear what the target side holds that the source side does not: a filled socket on the other side whose
      // counterpart is not being copied (its source socket is empty or does not exist) is emptied.
      controls.sockets.forEach((socket) => {
        if (socket.side === OPPOSITE_SIDE[from] && socket.part && !(socket.key in copies)) copies[socket.key] = null;
      });
      const mirrored = keepWhatFits({ species: recipe.species, seed: recipe.seed, overrides: { ...(recipe.overrides || {}), ...copies } });
      // An emptied socket under a part that was swapped away no longer exists; its null override says nothing.
      const existing = new Set(catalog.socketsOf(catalog.resolve(mirrored)).map((socket) => `${FILL_KEY}${socket.path}`));
      return withOverrides(mirrored, {}, (key) => key.startsWith(FILL_KEY) && mirrored.overrides[key] === null && !existing.has(key));
    };

    /** Ids of the features that differ between two placements lists (matched by id and side; a missing copy counts). */
    const changedFeatures = (before, after) => {
      const keyOf = (feature) => `${feature.id}|${feature.side}`;
      const textOf = (feature) => JSON.stringify([feature.bone, feature.point, feature.size, feature.rotation, feature.frames, feature.ramp]);
      const earlier = new Map(before.map((feature) => [keyOf(feature), textOf(feature)]));
      const later = new Map(after.map((feature) => [keyOf(feature), textOf(feature)]));
      const keys = [...new Set([...earlier.keys(), ...later.keys()])].filter((key) => earlier.get(key) !== later.get(key));
      return [...new Set(keys.map((key) => key.split('|')[0]))];
    };

    /**
     * What differs between two bakes, so a renderer can update in place instead of rebuilding: recolour for
     * `colors`, re-pose for `bones`, rebuild the skeleton and meshes only when `rebuild` is true.
     * @param {Object} previous a `Bake`
     * @param {Object} next a `Bake`
     * @returns {{rebuild: boolean, species: boolean, dials: string[], colors: string[], sockets: string[], bones: number[], shapes: number[], features: string[]}}
     *   `rebuild`: the assembled plan differs (another species or outfit), so bone indices do not carry over;
     *   `dials` / `colors`: ids whose value differs; `sockets`: paths whose part differs; `bones`: indices in
     *   `next.plan` whose rest transform differs (every bone when `rebuild` is true); `shapes`: indices whose
     *   shape row differs, so their mesh is rebuilt but the skeleton is not; `features`: ids of surface features
     *   whose placement, size or paint differs (re-stamp those)
     * @complexity O(bones + fields) time; allocates the report
     * @example const { rebuild, bones } = editor.changes(shown, bakery.bakeRecipe(recipe));
     */
    const changes = (previous, next) => {
      const rebuild = previous.plan !== next.plan;
      const isSameSpecies = previous.species === next.species;
      const kind = catalog.species(next.species);
      const paths = [...new Set([...Object.keys(previous.individual.fills), ...Object.keys(next.individual.fills)])].sort(Kit.body.compareSocketPaths);
      const bones = [];
      for (let bone = 0; bone < next.plan.boneCount; bone++) {
        const vector = bone * Kit.rig.VECTOR_STRIDE;
        const isMoved =
          rebuild ||
          previous.rest.uniform[bone] !== next.rest.uniform[bone] ||
          [0, 1, 2].some((axis) => previous.rest.scale[vector + axis] !== next.rest.scale[vector + axis] || previous.rest.translation[vector + axis] !== next.rest.translation[vector + axis]);
        if (isMoved) bones.push(bone);
      }
      // Shape rows are shared until a dial copies them: the identity compare is free and the text compare runs
      // only on dialled bones, whose copies differ in identity even when a value is unchanged.
      const shapes = rebuild
        ? bones
        : [...next.plan.boneNames.keys()].filter((bone) => previous.shapes[bone] !== next.shapes[bone] && JSON.stringify(previous.shapes[bone]) !== JSON.stringify(next.shapes[bone]));
      return {
        rebuild,
        species: !isSameSpecies,
        dials: kind.dialIds.filter((_id, dial) => !isSameSpecies || previous.individual.dials[dial] !== next.individual.dials[dial]),
        colors: kind.colorIds.filter((_channel, index) => !isSameSpecies || previous.individual.colors[index] !== next.individual.colors[index]),
        sockets: paths.filter((path) => previous.individual.fills[path] !== next.individual.fills[path]),
        bones,
        shapes,
        features: changedFeatures(previous.surface.features, next.surface.features),
      };
    };

    return { schema, setDial, setColor, setSocket, randomize, mirror, link, changes };
  };

  Kit.body = Object.assign(Kit.body || {}, { editor });
})();
