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
  const COLOR_KEY = 'color:';
  const FILL_KEY = 'fill:';
  /** Problems that mean "this locked or mirrored field cannot be kept after the change"; such fields are dropped. */
  const DROPPABLE_PROBLEMS = ['no-such-socket', 'part-does-not-fit', 'unknown-field'];

  const fail = (where, message) => {
    throw new Error(`Kit.body.editor.${where}: ${message}`);
  };

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
   * @property {Array<{channel: string, bones: string[]}>} affects what it scales: per channel, the bones of the bare plan
   * @property {?string} mirror the key of the dial that does the same on the other side, when there is one
   */

  /**
   * @typedef {Object} ColorControl
   * @property {string} key the override key, 'color:<channel>'
   * @property {string} id the channel
   * @property {string} label
   * @property {string} palette the catalogue palette the channel draws from
   * @property {Object[]} ramps the choices: `Ramp` rows { id, shades: [dark ... light] }
   * @property {number} value the index of the ramp the individual uses
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

    /** What each dial of a species touches on the bare plan, its group, its side and its opposite: worked out once. */
    const dialFactsOf = (kind) => {
      const known = dialFacts.get(kind.id);
      if (known) return known;
      const dialSet = Kit.body.dials(kind.plan, kind.dialRows);
      const affects = kind.dialIds.map(() => []);
      const firstBone = kind.dialIds.map(() => -1);
      dialSet.opDial.forEach((dial, operation) => {
        const channel = channelNames[dialSet.opChannel[operation]];
        const entry = affects[dial].find((row) => row.channel === channel) || affects[dial][affects[dial].push({ channel, bones: [] }) - 1];
        entry.bones.push(kind.plan.boneNames[dialSet.opBone[operation]]);
        if (firstBone[dial] < 0) firstBone[dial] = dialSet.opBone[operation];
      });
      // A dial is sided when every effect names a side role; its mirror is the dial with the same effects on the other side.
      const signature = (row, swap) => JSON.stringify((row.affects || []).map((effect) => ({ ...effect, roles: (effect.roles || []).map((role) => (swap && OPPOSITE_SIDE[role]) || role).sort() })));
      const sides = kind.dialRows.map((row) => Object.keys(OPPOSITE_SIDE).find((side) => (row.affects || []).length > 0 && row.affects.every((effect) => (effect.roles || []).includes(side))) || null);
      const facts = {
        affects,
        groups: kind.dialRows.map((row, dial) => row.group || (firstBone[dial] < 0 ? Kit.body.groupOf(0) : Kit.body.groupOf(kind.plan.roles[firstBone[dial]]))),
        sides,
        mirrors: kind.dialRows.map((row, dial) => {
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

    /** The path of the same socket on the other side of the body, or null: same type, same roles but for the side. */
    const mirrorPathOf = (kind, path) => {
      const [top, ...nested] = path.split(Kit.body.SOCKET_PATH_SEPARATOR);
      const { roles, side } = socketPlacement(kind, top);
      if (!side) return null;
      const wanted = (roles ^ Kit.body.roleMask([side, OPPOSITE_SIDE[side]])) >>> 0;
      const type = kind.plan.socketType[kind.plan.socketIndex(top)];
      const other = kind.plan.socketNames.find((_name, index) => kind.plan.socketType[index] === type && kind.plan.roles[kind.plan.socketBone[index]] === wanted);
      return other ? [other, ...nested].join(Kit.body.SOCKET_PATH_SEPARATOR) : null;
    };

    /**
     * Everything editable about a recipe, as data, in a stable order: dials in species order, colour channels in
     * species order, sockets parents-first. Generate the editor's controls from this; nothing about a species
     * needs to be written into the editor.
     * @param {Object} recipe a `Recipe`; nested sockets are listed for what it currently wears
     * @returns {{species: string, dials: DialControl[], colors: ColorControl[], sockets: SocketControl[]}}
     * @throws {Error} as `catalog.resolve`
     * @complexity O(dials + channels + sockets x parts) time and space; cheap enough to rebuild after every edit
     * @example editor.schema({ species: 'human', seed: 7 }).sockets.map((socket) => socket.label) // ['Back', 'Hand left', ...]
     */
    const schema = (recipe) => {
      const individual = catalog.resolve(recipe);
      const kind = catalog.species(individual.species);
      const facts = dialFactsOf(kind);
      return {
        species: kind.id,
        dials: kind.dialRows.map((row, dial) => ({
          key: `${DIAL_KEY}${row.id}`,
          id: row.id,
          label: row.label || labelOf(row.id),
          group: facts.groups[dial],
          min: row.min,
          max: row.max,
          step: (row.max - row.min) / Kit.body.DIAL_STEPS,
          default: row.default === undefined ? 1 : row.default,
          value: individual.dials[dial],
          affects: facts.affects[dial],
          mirror: facts.mirrors[dial],
        })),
        colors: kind.colorIds.map((channel, index) => ({
          key: `${COLOR_KEY}${channel}`,
          id: channel,
          label: labelOf(channel),
          palette: kind.paletteNames[index],
          ramps: kind.palettes[index],
          value: individual.colors[index],
        })),
        sockets: catalog.socketsOf(individual).map((socket) => {
          const mirrorPath = mirrorPathOf(kind, socket.path);
          return {
            key: `${FILL_KEY}${socket.path}`,
            path: socket.path,
            label: socket.label || labelOf(socket.path),
            group: socketPlacement(kind, socket.path.split(Kit.body.SOCKET_PATH_SEPARATOR)[0]).group,
            type: socket.type,
            part: socket.part,
            options: socket.fits,
            allowsEmpty: !socket.required,
            mirror: mirrorPath ? `${FILL_KEY}${mirrorPath}` : null,
          };
        }),
      };
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
     * with a raw slider value on every drag event.
     * @param {Object} recipe
     * @param {string} dialId
     * @param {number} value
     * @returns {Object} a new, normalised recipe; the input is not changed
     * @throws {Error} '[unknown-field] ...' for a dial the species lacks, '[bad-value] ...' for a non-number
     * @complexity O(fields of the species + overrides log overrides): a few microseconds
     * @example recipe = editor.setDial(recipe, 'legLength', 1.15);
     */
    const setDial = (recipe, dialId, value) => withOverrides(recipe, { [`${DIAL_KEY}${dialId}`]: value });

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
     * Re-rolls a recipe from a new seed, keeping the fields that are locked exactly as they are now.
     * @param {Object} recipe
     * @param {number} seed the new seed (unsigned 32-bit)
     * @param {{locked?: string[]}} [options] field keys to keep ('dial:height', 'color:skin', 'fill:handRight');
     *   a locked nested socket is only kept while its parent socket still holds a part that has it
     * @returns {Object} a new, normalised recipe: the new seed plus one override per locked field
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
      return keepWhatFits({ species: recipe.species, seed, overrides: kept });
    };

    /**
     * Copies one side of the body onto the other: every sided dial and every sided socket (with what hangs from
     * it) that has a counterpart, as listed by the `mirror` fields of `schema`.
     * @param {Object} recipe
     * @param {('left'|'right')} [from='left'] the side to copy from
     * @returns {Object} a new, normalised recipe; unchanged in meaning when the species has nothing sided
     * @throws {Error} for a side that is neither 'left' nor 'right'
     * @complexity O(dials + sockets x parts)
     * @example recipe = editor.mirror(recipe, 'right');   // the left hand now holds what the right hand holds
     */
    const mirror = (recipe, from = 'left') => {
      if (!OPPOSITE_SIDE[from]) fail('mirror', `the side to copy from is 'left' or 'right', got ${JSON.stringify(from)}.`);
      const individual = catalog.resolve(recipe);
      const kind = catalog.species(individual.species);
      const { sides } = dialFactsOf(kind);
      const controls = schema(recipe);
      const copies = {};
      controls.dials.forEach((dial, index) => {
        if (dial.mirror && sides[index] === from) copies[dial.mirror] = dial.value;
      });
      controls.sockets.forEach((socket) => {
        const top = socket.path.split(Kit.body.SOCKET_PATH_SEPARATOR)[0];
        if (socket.mirror && socketPlacement(kind, top).side === from) copies[socket.mirror] = socket.part;
      });
      return keepWhatFits({ species: recipe.species, seed: recipe.seed, overrides: { ...(recipe.overrides || {}), ...copies } });
    };

    /**
     * What differs between two bakes, so a renderer can update in place instead of rebuilding: recolour for
     * `colors`, re-pose for `bones`, rebuild the skeleton and meshes only when `rebuild` is true.
     * @param {Object} previous a `Bake`
     * @param {Object} next a `Bake`
     * @returns {{rebuild: boolean, species: boolean, dials: string[], colors: string[], sockets: string[], bones: number[]}}
     *   `rebuild`: the assembled plan differs (another species or outfit), so bone indices do not carry over;
     *   `dials` / `colors`: ids whose value differs; `sockets`: paths whose part differs; `bones`: indices in
     *   `next.plan` whose rest transform differs (every bone when `rebuild` is true)
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
      return {
        rebuild,
        species: !isSameSpecies,
        dials: kind.dialIds.filter((_id, dial) => !isSameSpecies || previous.individual.dials[dial] !== next.individual.dials[dial]),
        colors: kind.colorIds.filter((_channel, index) => !isSameSpecies || previous.individual.colors[index] !== next.individual.colors[index]),
        sockets: paths.filter((path) => previous.individual.fills[path] !== next.individual.fills[path]),
        bones,
      };
    };

    return { schema, setDial, setColor, setSocket, randomize, mirror, changes };
  };

  Kit.body = Object.assign(Kit.body || {}, { editor });
})();
