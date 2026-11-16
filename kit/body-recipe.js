/**
 * Kit body recipe: an individual as three small things, `{ species, seed, overrides }`, and everything needed to
 * turn that into a body and back: a catalogue of species (a `Kit.lineage` whose definitions name a plan, dials,
 * colour channels and weighted socket fills), seed derivation, validation, a compact binary form, a canonical
 * hash, species tables that roll recipes, and a bake cache.
 *
 * Owns:  `Kit.body.catalog(spec)` and what it returns: `resolve` (recipe -> individual), `describe`, `validate`,
 *        `normalize`, `encode` / `decode`, `hash`, `table` (weighted species -> recipes) and `bakery` (individual
 *        -> assembled plan + proportioned rest pose, cached by hash).
 * Does not own: the inheritance fold (kit/lineage.js), the seed derivation and content hash (kit/seeded.js),
 *        the byte format's primitives (kit/pack.js), plans, dials and kinematics (kit/body-plan.js), attaching
 *        (kit/body-parts.js), instances (kit/body-store.js) or anything that moves or draws a body. This file
 *        is the composition of those: it gives their generic pieces the shape of a body.
 *
 * Every field's value is `Kit.seeded` hash(seed, field name), not the next number of a stream, so a field never
 * depends on how many fields were read before it: add a dial to a species next month and every existing seed
 * keeps its old values for every old field.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  // ---- tunables -------------------------------------------------------------------------------------------------------

  /** First byte of every encoded recipe; raise it when the layout below changes so old blobs are refused by name. */
  const FORMAT_VERSION = 1;
  /** A dial has this many steps between min and max, so its value fits one byte. 255 steps is finer than the eye. */
  const DIAL_STEPS = 255;
  /** A colour channel's ramp index fits one byte. */
  const MOST_PALETTE_COLORS = 256;
  /** The fill option, and override value, that means "leave the socket empty". */
  const NO_PART = 'none';
  /** Field keys are '<kind>:<name>': 'dial:legLength', 'color:skin', 'fill:handRight/gem'. */
  const KEY_SEPARATOR = ':';
  const KINDS = Object.freeze({ dial: 'dial', color: 'color', fill: 'fill' });
  /** In the binary form a field hash of 0 announces a field spelt out by name (a nested socket the species never declared). */
  const SPELT_OUT_FIELD = 0;
  /** Bakes kept by a bakery before the oldest is dropped. */
  const DEFAULT_BAKE_CAPACITY = 512;

  const { UINT32_RANGE, hashText: fieldHash, unit: seedUnit, bits: seedBits } = Kit.seeded;
  /** How a dial's value is spread over its range when the species does not say: mid-range bodies common, extremes rare. */
  const DEFAULT_SHAPE = 'bell';

  const SOCKET_PATH_SEPARATOR = Kit.body.SOCKET_PATH_SEPARATOR;
  const fail = (where, message) => {
    throw new Error(`Kit.body.${where}: ${message}`);
  };
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  // ---- types ----------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Recipe
   * @property {string} species id of a species of the catalogue (a node with a `code`)
   * @property {number} seed unsigned 32-bit whole number; every field not overridden is derived from it
   * @property {Object<string, (number|string|null)>} [overrides] field key -> value. 'dial:<id>' takes a number
   *   in the dial's range (clamped and snapped to its steps); 'color:<channel>' the index of a ramp in the channel's palette; 'fill:<socket
   *   path>' a part id, or null / 'none' for empty.
   */

  /**
   * @typedef {Object} Individual
   * A recipe with every field worked out: what renderers, bakes and editors read.
   * @property {string} species
   * @property {number} seed
   * @property {Float32Array} dials one value per dial of the species, in `kind.dialIds` order
   * @property {Uint8Array} colors one ramp index per colour channel, in `kind.colorIds` order: an index into the
   *   channel's palette, never a colour, because the shaders downstream are palette-indexed
   * @property {Object<string, string>} fills socket path -> part id, filled sockets only, parents before children
   */

  /**
   * @typedef {Object} SpeciesDefinition
   * The shape a catalogue expects of a lineage node's folded values (every key optional except on a species).
   * @property {number} [code] stable whole number that names the species in the binary form. A node with a code
   *   is a species and can be instantiated; a node without one is abstract (an archetype). Never reuse a code.
   * @property {string} [plan] id of a body plan of the catalogue
   * @property {Object<string, {min: number, max: number, default?: number, shape?: string, affects: Object[]}>} [dials]
   *   dial id -> a `DialRow` of kit/body-plan.js without its id, plus `shape` (a `Kit.seeded.SHAPES` name, default 'bell')
   * @property {Object<string, string>} [colors] colour channel -> the name of a palette of the catalogue
   *   ({ skin: 'skinTones' }); an individual stores which ramp of that palette it uses
   * @property {Object<string, Object<string, number>>} [fills] socket path -> { part id or 'none': weight }
   */

  /**
   * @typedef {Object} SpeciesKind
   * A species compiled for fast derivation. Read-only.
   * @property {string} id
   * @property {number} code
   * @property {Object} definition the folded `SpeciesDefinition` (frozen)
   * @property {Object} plan the bare `BodyPlan`
   * @property {string[]} dialIds
   * @property {Object[]} dialRows `DialRow`s, for compiling against an assembled plan
   * @property {number[]} dialMin
   * @property {number[]} dialMax
   * @property {number[]} dialDefaults
   * @property {number[]} dialDefaultSteps per dial: the step that decodes to the default exactly
   * @property {string[]} unusedDials dials that touch no bone of the bare plan
   * @property {string[]} colorIds
   * @property {string[]} paletteNames per colour channel: the catalogue palette it draws from
   * @property {Object[][]} palettes per colour channel: that palette's ramps (`Ramp` rows of kit/palette.js)
   * @property {string[]} fillPaths declared socket paths, parents before children
   * @property {Array<{path: string, hash: number, options: Array<{part: ?string, weight: number}>}>} fillFields the
   *   declared fills compiled: the socket path, its field id and its weighted options
   * @property {Array<function(number): number>} dialDraws per dial: seed -> a number in [0, 1) (`Kit.seeded.field`)
   * @property {Array<function(number): number>} colorDraws per colour channel: seed -> a number in [0, 1)
   * @property {Map<number, string>} keyByHash field id -> override key, for decoding
   */

  /**
   * @typedef {Object} RecipeProblem
   * @property {string} code one of 'unknown-species', 'abstract-species', 'bad-seed', 'bad-overrides',
   *   'unknown-field', 'bad-value', 'out-of-range', 'bad-color', 'unknown-part', 'no-such-socket',
   *   'part-does-not-fit', 'socket-required'
   * @property {string} [field] the override key at fault
   * @property {string} message what is wrong and how to fix it
   */

  /**
   * @typedef {Object} Bake
   * Everything a renderer needs for one distinct look, built once and shared by every instance that has it.
   * @property {number} hash the canonical hash of the individual (the cache key)
   * @property {string} species
   * @property {Object} plan the assembled `BodyPlan`: bare plan plus the parts worn
   * @property {Object} rest the proportioned rest pose (a `JointTransforms`); copy it, never write it
   * @property {ReadonlyArray<?Object>} shapes 1 per bone of `plan`: its shape row with the shape dials applied
   *   (null for the default capsule), from `Kit.body.shapesWithDials`
   * @property {Object} surface the individual's surface features (placed) and painted regions, with
   *   `regionAt(bone, along, angle, normalX, normalY, normalZ)` -> index in `ramps` or -1 (kit/body-surface.js)
   * @property {Readonly<Object<string, Object>>} colors channel -> the `Ramp` the individual uses for it
   * @property {Int16Array} boneRamp 1 per bone of `plan`: the index in `ramps` of the ramp the bone is painted
   *   with, or -1 when the bone names no paint channel or the species has no such channel
   * @property {ReadonlyArray<Object>} ramps the individual's ramps, one per colour channel of the species
   * @property {Individual} individual
   */

  /**
   * @typedef {Object} CatalogSpec
   * @property {Object<string, Object>} plans plan id -> `BodyPlanSpec` without its id
   * @property {Object<string, Object>} [parts] part id -> `PartSpec` without its id
   * @property {Object<string, Object>} nodes lineage nodes (kit/lineage.js) whose `set` follows `SpeciesDefinition`
   * @property {Object<string, Object>} [traits] lineage traits; two traits of one node may not fill the same socket
   * @property {Object<string, Object[]>} [palettes] palette name -> its ramps, each { id, shades: [dark ... light] }
   *   (`Kit.palette.ramp` builds one from a hue)
   */

  // ---- the catalogue --------------------------------------------------------------------------------------------------

  /**
   * Builds a catalogue: compiles every plan and part, folds every node, and compiles each species, so a mistake
   * anywhere in the tables is reported at load with the node, the field and the fix.
   * @param {CatalogSpec} spec
   * @returns {Object} the catalogue: `resolve`, `describe`, `validate`, `normalize`, `encode`, `decode`, `hash`,
   *   `table`, `bakery`, `socketsOf`, `species(id)` (a `SpeciesKind`), `speciesIds()`, `plans`, `parts`, `palettes` and `lineage`; each
   *   is documented on its own function below
   * @throws {Error} for anything `Kit.lineage`, `Kit.body.plan`, `Kit.body.part` or `Kit.body.dials` rejects, an
   *   unknown plan, a duplicate code, an empty palette, or a fill that names an unknown socket or a part that
   *   does not fit it
   * @complexity O(nodes x overrides + plans + parts + species x fields) time and space, once
   * @example
   * const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
   * const individual = catalog.resolve({ species: 'elf', seed: 7 });
   * const bytes = catalog.encode({ species: 'elf', seed: 7, overrides: { 'dial:height': 1.2 } });   // 11 bytes
   */
  const catalog = ({ plans, parts = {}, nodes, traits = {}, palettes: paletteTable = {} }) => {
    if (!isPlainObject(plans)) fail('catalog', '`plans` must be an object of plan id -> { bones, sockets }.');
    const lineage = Kit.lineage({ nodes, traits, exclusive: ['fills'] });
    const compiledPlans = Object.fromEntries(Object.keys(plans).map((id) => [id, Kit.body.plan({ ...plans[id], id })]));
    const compiledParts = Object.fromEntries(Object.keys(parts).map((id) => [id, Kit.body.part({ ...parts[id], id })]));
    // Features and regions are data too: check them now, not at the first bake that wears them.
    [...Object.values(compiledPlans), ...Object.values(compiledParts)].forEach((compiled) => Kit.body.checkSurface(compiled.spec, `catalog: ${compiled.spec.fits ? 'part' : 'plan'} "${compiled.id}"`));
    const partHashes = Object.fromEntries(Object.keys(parts).map((id) => [id, fieldHash(`part${KEY_SEPARATOR}${id}`)]));
    /** @type {Map<number, string>} */
    const partByHash = new Map();
    Object.keys(partHashes).forEach((id) => {
      if (partByHash.has(partHashes[id])) fail('catalog', `the parts "${partByHash.get(partHashes[id])}" and "${id}" hash to the same id; rename one of them.`);
      partByHash.set(partHashes[id], id);
    });

    /** The socket specs a part offers to further parts (its anchor is used up by attaching). */
    const offeredSockets = (partId) => (compiledParts[partId].spec.sockets || []).filter((socket) => socket.name !== compiledParts[partId].spec.anchor);
    /** Ids of every part that fits a socket type, sorted so a seeded pick among them is stable. */
    const partsFitting = (type) =>
      Object.keys(compiledParts)
        .filter((partId) => compiledParts[partId].fits.includes(type))
        .sort();
    /** Part id -> the names of the sockets it offers that may not be left empty. */
    const requiredSocketsOfPart = Object.fromEntries(Object.keys(compiledParts).map((partId) => [partId, offeredSockets(partId).filter((socket) => socket.required)]));
    // A part whose required socket nothing can fill could never be worn: say so at load.
    Object.keys(requiredSocketsOfPart).forEach((partId) =>
      requiredSocketsOfPart[partId].forEach((socket) => {
        if (!partsFitting(socket.type).length)
          fail('catalog', `the part "${partId}" has the required socket "${socket.name}" (type ${socket.type}), but no part in \`parts\` fits a ${socket.type} socket.`);
      })
    );
    const anyPartRequires = Object.values(requiredSocketsOfPart).some((sockets) => sockets.length > 0);

    /**
     * The spec of the socket at a path, given what is already attached; null when there is no such socket.
     * A top-level path is a socket of the bare plan; 'a/b' is socket b of the part sitting in socket a.
     */
    const socketSpecAt = (kind, fills, path) => {
      const cut = path.lastIndexOf(SOCKET_PATH_SEPARATOR);
      if (cut < 0) return (kind.plan.spec.sockets || []).find((candidate) => candidate.name === path) || null;
      const parentPart = fills[path.slice(0, cut)];
      return (parentPart && offeredSockets(parentPart).find((candidate) => candidate.name === path.slice(cut + 1))) || null;
    };
    const socketTypeAt = (kind, fills, path) => {
      const socket = socketSpecAt(kind, fills, path);
      return socket ? socket.type : null;
    };

    // ---- dial steps ----

    /**
     * The value of a dial step. The step nearest the default decodes to the default itself, so "as drawn" (a
     * multiplier of exactly 1, a tilt of exactly 0) is reachable although 255 even steps rarely land on it.
     */
    const dialValueOfStep = (kind, dial, step) =>
      step === kind.dialDefaultSteps[dial] ? kind.dialDefaults[dial] : kind.dialMin[dial] + (step * (kind.dialMax[dial] - kind.dialMin[dial])) / DIAL_STEPS;
    /** The nearest step to a value, after clamping the value into the dial's range. */
    const dialStepOf = (kind, dial, value) => {
      const span = kind.dialMax[dial] - kind.dialMin[dial];
      return span > 0 ? Math.round(Kit.math.clamp((value - kind.dialMin[dial]) / span, 0, 1) * DIAL_STEPS) : 0;
    };

    // ---- compiling a species ----

    const compileFills = (where, declared) =>
      Object.keys(declared)
        .sort(Kit.body.compareSocketPaths)
        .map((path) => {
          if (!isPlainObject(declared[path])) fail(where, `fills.${path} must be an object of part id (or '${NO_PART}') -> weight.`);
          const options = Object.keys(declared[path])
            .filter((partId) => declared[path][partId] > 0)
            .map((partId) => ({ part: partId === NO_PART ? null : partId, weight: declared[path][partId] }));
          options.forEach((option) => {
            if (option.part && !compiledParts[option.part])
              fail(where, `fills.${path} offers the part "${option.part}", which is not in \`parts\`. Parts: ${Object.keys(compiledParts).join(', ') || '(none)'}.`);
          });
          return { path, hash: fieldHash(`${KINDS.fill}${KEY_SEPARATOR}${path}`), options };
        });

    /** Every declared fill must name a socket that can exist and offer only parts that fit it. */
    const checkFills = (where, kind) =>
      kind.fillFields.forEach(({ path, options }) => {
        const cut = path.lastIndexOf(SOCKET_PATH_SEPARATOR);
        // A nested socket exists under each part its parent socket may hold; check the fit under every one of them.
        const parentField = cut < 0 ? null : kind.fillFields.find((field) => field.path === path.slice(0, cut));
        if (cut >= 0 && !parentField) fail(where, `fills.${path} is a nested socket, but fills.${path.slice(0, cut)} is not declared, so nothing could ever hold it.`);
        const settings = cut < 0 ? [{}] : parentField.options.filter((option) => option.part).map((option) => ({ [parentField.path]: option.part }));
        const types = settings.map((fills) => socketTypeAt(kind, fills, path)).filter(Boolean);
        if (!types.length)
          fail(
            where,
            `fills.${path} names a socket that ${cut < 0 ? `the plan "${kind.plan.id}" does not have (sockets: ${kind.plan.socketNames.join(', ') || 'none'})` : `no part offered for "${parentField.path}" has`}.`
          );
        options.forEach((option) => {
          const misfit = option.part && types.find((type) => !compiledParts[option.part].fits.includes(type));
          if (misfit) fail(where, `fills.${path} offers "${option.part}", which fits ${compiledParts[option.part].fits.join(', ')} sockets, but "${path}" is a ${misfit} socket.`);
        });
      });

    const compileKind = (id) => {
      const where = `catalog: species "${id}"`;
      const definition = lineage.resolve(id).values;
      const plan = compiledPlans[definition.plan];
      if (!plan) fail(where, `names the plan ${JSON.stringify(definition.plan)}, which is not in \`plans\`. Plans: ${Object.keys(compiledPlans).join(', ')}.`);
      // A sided dial becomes two, '<id>@left' and '<id>@right', drawn from one field so a roll is symmetric.
      const dialRows = Kit.body.sidedDials(Object.keys(definition.dials || {}).map((dialId) => ({ ...definition.dials[dialId], id: dialId })));
      const dialIds = dialRows.map((row) => row.id);
      const dialSet = Kit.body.dials(plan, dialRows);
      const colorIds = Object.keys(definition.colors || {});
      const paletteNames = colorIds.map((channel) => definition.colors[channel]);
      const palettes = paletteNames.map((paletteName, index) => {
        const ramps = paletteTable[paletteName];
        if (!Array.isArray(ramps) || !ramps.length || ramps.length > MOST_PALETTE_COLORS)
          fail(
            where,
            `colors.${colorIds[index]} names the palette ${JSON.stringify(paletteName)}, which must be a list of 1 to ${MOST_PALETTE_COLORS} ramps in \`palettes\`. Palettes: ${Object.keys(paletteTable).join(', ') || '(none)'}.`
          );
        ramps.forEach((ramp) => {
          if (!ramp || typeof ramp.id !== 'string' || !Array.isArray(ramp.shades) || !ramp.shades.length)
            fail(where, `every ramp of the palette "${paletteName}" needs an \`id\` and a list of \`shades\`, dark to light.`);
        });
        return ramps;
      });
      const kind = {
        id,
        code: definition.code,
        definition,
        plan,
        dialIds,
        dialRows,
        dialMin: dialRows.map((row) => row.min),
        dialMax: dialRows.map((row) => row.max),
        dialDefaults: dialRows.map((row) => (row.default === undefined ? 1 : row.default)),
        /** @type {number[]} per dial: the step its default falls on, which decodes to the default exactly */
        dialDefaultSteps: [],
        // One seeded field per dial and per colour channel: seed in, a number in [0, 1) out.
        dialDraws: dialRows.map((row) => Kit.seeded.field(`${KINDS.dial}${KEY_SEPARATOR}${row.base || row.id}`, row.shape === undefined ? DEFAULT_SHAPE : row.shape)),
        unusedDials: dialSet.unused,
        colorIds,
        paletteNames,
        palettes,
        colorDraws: colorIds.map((channel) => Kit.seeded.field(`${KINDS.color}${KEY_SEPARATOR}${channel}`)),
        fillFields: [],
        fillPaths: [],
        /** @type {string[]} the bare plan's required sockets */
        requiredTop: [],
        /** @type {Map<number, string>} field hash -> key, for decoding: dials, colours, declared fills and every bare socket */
        keyByHash: new Map(),
      };
      kind.dialDefaultSteps = kind.dialDefaults.map((preset, dial) => dialStepOf(kind, dial, preset));
      kind.fillFields = compileFills(where, definition.fills || {});
      kind.fillPaths = kind.fillFields.map((field) => field.path);
      checkFills(where, kind);
      // A socket the plan marks required must be given something by every roll.
      (plan.spec.sockets || [])
        .filter((socket) => socket.required)
        .forEach((socket) => {
          const field = kind.fillFields.find((candidate) => candidate.path === socket.name);
          if (!field || !field.options.length || field.options.some((option) => !option.part))
            fail(where, `the socket "${socket.name}" is required, so fills.${socket.name} must offer at least one part and no '${NO_PART}'.`);
        });
      // A declared nested fill for a part's required socket may not offer 'none' either.
      kind.fillFields.forEach(({ path, options }) => {
        const cut = path.lastIndexOf(SOCKET_PATH_SEPARATOR);
        if (cut < 0 || !options.some((option) => !option.part)) return;
        const parentField = kind.fillFields.find((field) => field.path === path.slice(0, cut));
        const requiredBy = parentField.options.find((option) => option.part && requiredSocketsOfPart[option.part].some((socket) => socket.name === path.slice(cut + 1)));
        if (requiredBy) fail(where, `fills.${path} offers '${NO_PART}', but the part "${requiredBy.part}" marks that socket required.`);
      });
      kind.requiredTop = (plan.spec.sockets || []).filter((socket) => socket.required).map((socket) => socket.name);
      const keys = [
        ...dialIds.map((dialId) => `${KINDS.dial}${KEY_SEPARATOR}${dialId}`),
        ...colorIds.map((channel) => `${KINDS.color}${KEY_SEPARATOR}${channel}`),
        ...new Set([...plan.socketNames, ...kind.fillPaths].map((path) => `${KINDS.fill}${KEY_SEPARATOR}${path}`)),
      ];
      keys.forEach((key) => {
        const hash = fieldHash(key);
        if (kind.keyByHash.has(hash)) fail(where, `the fields "${kind.keyByHash.get(hash)}" and "${key}" hash to the same id; rename one of them.`);
        kind.keyByHash.set(hash, key);
      });
      return Object.freeze(kind);
    };

    /** @type {Map<string, SpeciesKind>} */
    const kinds = new Map();
    /** @type {Map<number, string>} */
    const idByCode = new Map();
    lineage.ids().forEach((id) => {
      const { code } = lineage.resolve(id).values;
      if (code === undefined) return;
      if (!Number.isInteger(code) || code < 0) fail('catalog', `species "${id}" has the code ${JSON.stringify(code)}; a code is a whole number, 0 or more, never reused.`);
      // A code inherited from a parent species would make two species share it: every species states its own.
      if (idByCode.has(code))
        fail(
          'catalog',
          `species "${idByCode.get(code)}" and "${id}" both have the code ${code}${(nodes[id].set || {}).code === undefined ? ` ("${id}" inherits it: give it its own \`code\`)` : ''}. Codes name species in saved recipes and must be unique.`
        );
      idByCode.set(code, id);
      kinds.set(id, compileKind(id));
    });

    /**
     * The compiled species for an id.
     * @param {string} id
     * @returns {SpeciesKind}
     * @throws {Error} for an unknown node, or an abstract one (no `code`)
     * @complexity O(1)
     * @example catalog.species('elf').dialIds // ['height', 'legLength', ...]
     */
    const species = (id) => {
      const kind = kinds.get(id);
      if (kind) return kind;
      if (lineage.has(id)) return fail('species', `"${id}" is abstract (it has no \`code\`), so nothing can be made from it. Species: ${[...kinds.keys()].join(', ')}.`);
      return fail('species', `unknown species ${JSON.stringify(id)}. Species: ${[...kinds.keys()].join(', ')}.`);
    };

    // ---- recipe -> individual ----

    /** Drops fills whose socket no longer exists or no longer fits (after a parent was swapped) and orders the rest. */
    const canonicalFills = (kind, fills) => {
      const kept = {};
      Object.keys(fills)
        .sort(Kit.body.compareSocketPaths)
        .forEach((path) => {
          const type = socketTypeAt(kind, kept, path);
          if (type && compiledParts[fills[path]].fits.includes(type)) kept[path] = fills[path];
        });
      return kept;
    };

    /** Splits 'fill:handRight/gem' into its kind and name; the name may itself contain separators. */
    const splitKey = (key) => {
      const cut = key.indexOf(KEY_SEPARATOR);
      return cut < 0 ? { fieldKind: '', name: key } : { fieldKind: key.slice(0, cut), name: key.slice(cut + 1) };
    };
    const kindOrder = [KINDS.dial, KINDS.color, KINDS.fill];
    /** One canonical order for override keys: dials, colours, then fills with parents before children. */
    const compareKeys = (first, second) => {
      const [left, right] = [splitKey(first), splitKey(second)];
      if (left.fieldKind !== right.fieldKind) return kindOrder.indexOf(left.fieldKind) - kindOrder.indexOf(right.fieldKind);
      return left.fieldKind === KINDS.fill ? Kit.body.compareSocketPaths(left.name, right.name) : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    };

    /**
     * The override handlers, one per field kind: check the value, report what is wrong, write what is usable
     * into the individual, and return the normalised value (or undefined when the override is unusable).
     */
    const OVERRIDE_HANDLERS = {
      [KINDS.dial](kind, individual, name, value, report) {
        const dial = kind.dialIds.indexOf(name);
        if (dial < 0) return report('unknown-field', `species "${kind.id}" has no dial "${name}". Dials: ${kind.dialIds.join(', ') || '(none)'}.`);
        if (!Number.isFinite(value)) return report('bad-value', `dial "${name}" takes a number, got ${JSON.stringify(value)}.`);
        // An individual outside its species' range is clamped, not refused: recipes come from players and old saves.
        if (value < kind.dialMin[dial] || value > kind.dialMax[dial])
          report('out-of-range', `dial "${name}" = ${value} is outside [${kind.dialMin[dial]}, ${kind.dialMax[dial]}] for "${kind.id}"; it is clamped.`, true);
        const snapped = dialValueOfStep(kind, dial, dialStepOf(kind, dial, value));
        individual.dials[dial] = snapped;
        return snapped;
      },
      [KINDS.color](kind, individual, name, value, report) {
        const channel = kind.colorIds.indexOf(name);
        if (channel < 0) return report('unknown-field', `species "${kind.id}" has no colour channel "${name}". Channels: ${kind.colorIds.join(', ') || '(none)'}.`);
        if (!Number.isInteger(value) || value < 0 || value >= kind.palettes[channel].length)
          return report(
            'bad-color',
            `colour "${name}" takes the index of a ramp of the palette "${kind.paletteNames[channel]}", 0 to ${kind.palettes[channel].length - 1}, got ${JSON.stringify(value)}.`
          );
        individual.colors[channel] = value;
        return value;
      },
      [KINDS.fill](kind, individual, path, value, report) {
        if (value === null || value === NO_PART) {
          const socket = socketSpecAt(kind, individual.fills, path);
          if (socket && socket.required) return report('socket-required', `the socket "${path}" may not be left empty; give it a part.`);
          delete individual.fills[path];
          return null;
        }
        if (!compiledParts[value])
          return report('unknown-part', `socket "${path}" asks for the part ${JSON.stringify(value)}, which is not in the catalogue. Parts: ${Object.keys(compiledParts).join(', ') || '(none)'}.`);
        const type = socketTypeAt(kind, individual.fills, path);
        if (!type)
          return report(
            'no-such-socket',
            `"${kind.id}" has no socket "${path}"${path.includes(SOCKET_PATH_SEPARATOR) ? ' with what it currently holds (fill the parent socket first)' : ` (sockets: ${kind.plan.socketNames.join(', ') || 'none'})`}.`
          );
        if (!compiledParts[value].fits.includes(type))
          return report('part-does-not-fit', `the part "${value}" fits ${compiledParts[value].fits.join(', ')} sockets, but "${path}" is a ${type} socket.`);
        individual.fills[path] = value;
        return value;
      },
    };

    /** Applies overrides in canonical order; returns them normalised. Unusable ones are reported and left out. */
    const applyOverrides = (kind, overrides, individual, report) => {
      const normalised = {};
      Object.keys(overrides)
        .sort(compareKeys)
        .forEach((key) => {
          const { fieldKind, name } = splitKey(key);
          const handler = OVERRIDE_HANDLERS[fieldKind];
          // Returns nothing, so a handler can `return reportField(...)` to mean "this override is unusable".
          const reportField = (code, message, isUsable) => {
            report({ code, field: key, message }, isUsable);
          };
          if (!handler)
            return reportField(
              'unknown-field',
              `"${key}" is not a field key; keys look like '${KINDS.dial}${KEY_SEPARATOR}height', '${KINDS.color}${KEY_SEPARATOR}skin' or '${KINDS.fill}${KEY_SEPARATOR}handRight'.`
            );
          const value = handler(kind, individual, name, overrides[key], reportField);
          if (value !== undefined) normalised[key] = value;
        });
      individual.fills = canonicalFills(kind, individual.fills);
      return normalised;
    };

    /** Every field of a species derived from a seed alone. */
    const derive = (kind, seed) => {
      const individual = { species: kind.id, seed, dials: new Float32Array(kind.dialIds.length), colors: new Uint8Array(kind.colorIds.length), fills: {} };
      // Hot path for generated crowds: index loops, one hash per field, no intermediate arrays.
      for (let dial = 0; dial < kind.dialIds.length; dial++) individual.dials[dial] = dialValueOfStep(kind, dial, Math.round(kind.dialDraws[dial](seed) * DIAL_STEPS));
      for (let channel = 0; channel < kind.colorIds.length; channel++) individual.colors[channel] = Math.floor(kind.colorDraws[channel](seed) * kind.palettes[channel].length);
      for (let field = 0; field < kind.fillFields.length; field++) {
        const { path, hash, options } = kind.fillFields[field];
        // A nested socket is only rolled when the part that carries it was rolled into its parent socket.
        if (path.includes(SOCKET_PATH_SEPARATOR) && !socketTypeAt(kind, individual.fills, path)) continue;
        const option = Kit.seeded.pick(options, seedUnit(seed, hash));
        if (option && option.part) individual.fills[path] = option.part;
      }
      return individual;
    };

    /**
     * Fills every required socket left empty, at any depth: a roll or an override may put a part with a required
     * socket somewhere no fill was declared for (a lantern needs its flame). The part is the seeded pick among
     * the declared options for that path, else among every catalogue part that fits, so the result depends only
     * on the seed and the overrides.
     * @complexity O(filled sockets x required sockets of their parts); nothing at all when no part requires anything
     */
    const fillRequiredSockets = (kind, individual) => {
      if (!anyPartRequires && !kind.requiredTop.length) return;
      let added = false;
      const ensure = (path, type) => {
        if (!individual.fills[path]) {
          const declared = kind.fillFields.find((field) => field.path === path);
          const options = declared ? declared.options.filter((option) => option.part) : partsFitting(type).map((part) => ({ part, weight: 1 }));
          const chosen = Kit.seeded.pick(options, seedUnit(individual.seed, fieldHash(`${KINDS.fill}${KEY_SEPARATOR}${path}`)));
          if (!chosen) return;
          individual.fills[path] = chosen.part;
          added = true;
        }
        requiredSocketsOfPart[individual.fills[path]].forEach((socket) => ensure(`${path}${SOCKET_PATH_SEPARATOR}${socket.name}`, socket.type));
      };
      kind.requiredTop.forEach((name) => ensure(name, socketTypeAt(kind, {}, name)));
      Object.keys(individual.fills).forEach((path) => requiredSocketsOfPart[individual.fills[path]].forEach((socket) => ensure(`${path}${SOCKET_PATH_SEPARATOR}${socket.name}`, socket.type)));
      // Keep fills in canonical order (the hash walks them in order).
      if (added) individual.fills = canonicalFills(kind, individual.fills);
    };

    /** Shared by resolve, validate and normalize: checks the envelope, derives, applies overrides. */
    const build = (recipe, report) => {
      const blocked = (problem) => {
        report(problem, false);
        return null;
      };
      if (!isPlainObject(recipe)) return blocked({ code: 'bad-overrides', message: 'a recipe is an object { species, seed, overrides }.' });
      if (!kinds.has(recipe.species)) {
        const isAbstract = typeof recipe.species === 'string' && lineage.has(recipe.species);
        return blocked({
          code: isAbstract ? 'abstract-species' : 'unknown-species',
          message: isAbstract
            ? `"${recipe.species}" is abstract (it has no \`code\`); pick one of: ${[...kinds.keys()].join(', ')}.`
            : `unknown species ${JSON.stringify(recipe.species)}. Species: ${[...kinds.keys()].join(', ')}.`,
        });
      }
      if (!Number.isInteger(recipe.seed) || recipe.seed < 0 || recipe.seed >= UINT32_RANGE)
        return blocked({
          code: 'bad-seed',
          message: `seed must be a whole number from 0 to ${UINT32_RANGE - 1}, got ${JSON.stringify(recipe.seed)}. Use \`value >>> 0\` to fold any number into range.`,
        });
      if (recipe.overrides !== undefined && !isPlainObject(recipe.overrides)) return blocked({ code: 'bad-overrides', message: '`overrides` must be an object of field key -> value.' });
      const kind = kinds.get(recipe.species);
      const individual = derive(kind, recipe.seed);
      const overrides = recipe.overrides && Object.keys(recipe.overrides).length ? applyOverrides(kind, recipe.overrides, individual, report) : {};
      fillRequiredSockets(kind, individual);
      return { kind, individual, overrides };
    };

    /** The reporter of `resolve` and friends: a problem that leaves nothing usable throws; a clamp passes. */
    const throwingReporter = (where) => (problem, isUsable) => {
      if (!isUsable) fail(where, `[${problem.code}] ${problem.message}`);
    };

    /**
     * Works out every field of a recipe: seed-derived values first, then the overrides on top. Dial overrides
     * outside the species' range are clamped (see DECISIONS.md, "Kit.body: limits"); anything else that is wrong throws.
     * @param {Recipe} recipe
     * @returns {Individual} a fresh individual; the same recipe always gives the same one
     * @throws {Error} '[code] message' with a `RecipeProblem` code, e.g. '[part-does-not-fit] ...'
     * @complexity O(fields of the species + overrides log overrides) time; allocates the individual (two small
     *   typed arrays and the fills object)
     * @example catalog.resolve({ species: 'elf', seed: 7, overrides: { 'fill:handRight': 'sword' } }).fills // { handRight: 'sword' }
     */
    const resolve = (recipe) => build(recipe, throwingReporter('resolve')).individual;

    /**
     * Lists everything wrong with a recipe without throwing: the editor's and the save-loader's check.
     * @param {Recipe} recipe
     * @returns {RecipeProblem[]} empty when the recipe is fine; an 'out-of-range' dial is listed although `resolve` would clamp it
     * @complexity O(fields + overrides log overrides)
     * @example catalog.validate({ species: 'carp', seed: 1, overrides: { 'fill:handRight': 'sword' } })[0].code // 'no-such-socket'
     */
    const validate = (recipe) => {
      const problems = [];
      build(recipe, (problem) => {
        problems.push(problem);
      });
      return problems;
    };

    /**
     * The canonical form of a recipe: overrides in one fixed order, dial values clamped and snapped to their
     * steps, empty fills as null. Two recipes that mean the same thing normalise to the same JSON, and
     * `decode(encode(recipe))` equals `normalize(recipe)`.
     * @param {Recipe} recipe
     * @returns {Recipe} a new recipe; `overrides` is always present
     * @throws {Error} as `resolve`
     * @complexity O(fields + overrides log overrides)
     * @example catalog.normalize({ species: 'elf', seed: 7 }) // { species: 'elf', seed: 7, overrides: {} }
     */
    const normalize = (recipe) => ({ species: recipe.species, seed: recipe.seed, overrides: build(recipe, throwingReporter('normalize')).overrides });

    /**
     * An individual in plain words, for editors, debug views and saves a person might read.
     * @param {Individual} individual
     * @returns {{species: string, seed: number, dials: Object<string, number>, colors: Object<string, string>, fills: Object<string, string>}}
     *   `colors` gives each channel's ramp id
     * @complexity O(fields)
     * @example catalog.describe(individual).colors.skin // 'umber'
     */
    const describe = (individual) => {
      const kind = species(individual.species);
      return {
        species: individual.species,
        seed: individual.seed,
        dials: Object.fromEntries(kind.dialIds.map((dialId, dial) => [dialId, individual.dials[dial]])),
        colors: Object.fromEntries(kind.colorIds.map((channel, index) => [channel, kind.palettes[index][individual.colors[index]].id])),
        fills: { ...individual.fills },
      };
    };

    /**
     * Every socket an individual has right now, bare and nested, with what sits in it: what an editor lists and
     * what "can I put this here?" is checked against.
     * @param {Individual} individual
     * @returns {Array<{path: string, type: string, part: ?string, required: boolean, label: ?string, bone: string, fits: string[]}>}
     *   in canonical order (parents before children); `bone` is the socket's bone in its own plan or part,
     *   `fits` the ids of every catalogue part that fits the socket's type
     * @complexity O(sockets x parts) time and space
     * @example catalog.socketsOf(individual).filter((socket) => !socket.part).map((socket) => socket.path) // the empty ones
     */
    const socketsOf = (individual) => {
      const kind = species(individual.species);
      const rowsUnder = (sockets, prefix) =>
        sockets.flatMap((socket) => {
          const path = `${prefix}${socket.name}`;
          const part = individual.fills[path] || null;
          const row = {
            path,
            type: socket.type,
            part,
            required: Boolean(socket.required),
            label: socket.label || null,
            bone: socket.bone,
            fits: Object.keys(compiledParts).filter((partId) => compiledParts[partId].fits.includes(socket.type)),
          };
          return [row, ...(part ? rowsUnder(offeredSockets(part), `${path}${SOCKET_PATH_SEPARATOR}`) : [])];
        });
      return rowsUnder(kind.plan.spec.sockets || [], '').sort((first, second) => Kit.body.compareSocketPaths(first.path, second.path));
    };

    /**
     * A canonical hash of what an individual looks like: its species, dial steps, colours and fills, not its
     * seed. Two recipes that resolve to the same look hash the same, so it keys the bake cache.
     * @param {Individual} individual
     * @returns {number} a whole number below 2^53 (a `Kit.seeded.hasher` value): fine for a cache, not a security boundary
     * @complexity O(fields) time, no allocation beyond the fill keys
     * @example const key = catalog.hash(catalog.resolve(recipe));
     */
    const hash = (individual) => {
      const kind = species(individual.species);
      lookHasher.reset();
      lookHasher.absorb(kind.code);
      for (let dial = 0; dial < individual.dials.length; dial++) lookHasher.absorb(dialStepOf(kind, dial, individual.dials[dial]));
      for (let channel = 0; channel < individual.colors.length; channel++) lookHasher.absorb(individual.colors[channel]);
      // Fills are kept in canonical order, so the same outfit always absorbs in the same sequence.
      for (const path in individual.fills) {
        lookHasher.absorb(fieldHash(path));
        lookHasher.absorb(partHashes[individual.fills[path]]);
      }
      return lookHasher.value();
    };
    const lookHasher = Kit.seeded.hasher();

    // ---- binary form ----
    // byte 0: FORMAT_VERSION | varint species code | uint32 seed (little-endian) | then, to the end of the buffer,
    // one entry per override: uint32 field hash, then 1 byte (a dial step or a palette index) or a uint32 part
    // hash (0 = empty). A field hash of 0 spells the field out instead: varint length, the key's characters.

    /**
     * Packs a recipe into bytes: 6 for a bare { species, seed } with a code below 128, plus 5 per dial or colour
     * override and 8 per fill override.
     * @param {Recipe} recipe
     * @returns {Uint8Array}
     * @throws {Error} as `resolve` (a recipe is normalised before it is packed)
     * @complexity O(fields + overrides log overrides) time, O(overrides) space
     * @example catalog.encode({ species: 'human', seed: 12345 }).length // 6
     */
    const encode = (recipe) => {
      const { kind, overrides } = build(recipe, throwingReporter('encode'));
      const packed = Kit.pack.writer().byte(FORMAT_VERSION).varint(kind.code).uint32(recipe.seed);
      Object.keys(overrides).forEach((key) => {
        const { fieldKind, name } = splitKey(key);
        const hashOfField = fieldHash(key);
        // A field the species knows travels as its 4-byte id; only a nested socket it never declared is spelt out.
        if (kind.keyByHash.get(hashOfField) === key) packed.uint32(hashOfField);
        else packed.uint32(SPELT_OUT_FIELD).text(key);
        if (fieldKind === KINDS.dial) packed.byte(dialStepOf(kind, kind.dialIds.indexOf(name), overrides[key]));
        else if (fieldKind === KINDS.color) packed.byte(overrides[key]);
        else packed.uint32(overrides[key] === null ? 0 : partHashes[overrides[key]]);
      });
      return packed.bytes();
    };

    /**
     * Unpacks bytes made by `encode` into a normalised recipe.
     * @param {Uint8Array} bytes
     * @returns {Recipe} equal to `normalize` of the recipe that was encoded
     * @throws {Error} naming the cause: a format version this code does not read, a species code, field or part
     *   the catalogue does not know (it was removed or renamed), or a buffer cut short
     * @complexity O(bytes) time, O(overrides) space
     * @example catalog.decode(catalog.encode(recipe)) // deep-equals catalog.normalize(recipe)
     */
    const decode = (bytes) => {
      const packed = Kit.pack.reader(bytes, 'Kit.body.decode');
      const version = packed.byte();
      if (version !== FORMAT_VERSION) fail('decode', `this is recipe format ${version}; this code reads format ${FORMAT_VERSION}.`);
      const code = packed.varint();
      const kind = kinds.get(idByCode.get(code));
      if (!kind) fail('decode', `no species has the code ${code}. Codes: ${[...idByCode.keys()].join(', ')}.`);
      const recipe = { species: kind.id, seed: packed.uint32(), overrides: {} };
      while (!packed.isDone()) {
        const hashOfField = packed.uint32();
        const key = hashOfField === SPELT_OUT_FIELD ? packed.text() : kind.keyByHash.get(hashOfField);
        if (!key) fail('decode', `species "${kind.id}" has no field with the id ${hashOfField}; the field was renamed or removed since this recipe was saved.`);
        const { fieldKind, name } = splitKey(key);
        if (fieldKind === KINDS.dial) recipe.overrides[key] = dialValueOfStep(kind, kind.dialIds.indexOf(name), packed.byte());
        else if (fieldKind === KINDS.color) recipe.overrides[key] = packed.byte();
        else {
          const hashOfPart = packed.uint32();
          if (hashOfPart && !partByHash.has(hashOfPart)) fail('decode', `socket "${name}" holds a part with the id ${hashOfPart}, which is not in the catalogue; the part was renamed or removed.`);
          recipe.overrides[key] = hashOfPart ? partByHash.get(hashOfPart) : null;
        }
      }
      return normalize(recipe);
    };

    // ---- species tables ----

    const TABLE_SPECIES_FIELD = fieldHash('table:species');
    const TABLE_SEED_FIELD = fieldHash('table:seed');

    /**
     * A weighted table of species that rolls recipes: the generator for crowds, herds and shoals. Rolls are
     * counter-based too: recipe number `index` of a table seed never depends on the others, so they can be made
     * in any order, lazily, or on another machine.
     * @param {Array<{species: string, weight?: number}>} rows weight defaults to 1
     * @returns {{roll: function(number, number=): Recipe}} `roll(seed, index = 0)` gives the recipe at that index
     * @throws {Error} for an empty table, or a row that names an unknown or abstract species
     * @complexity `roll` is O(rows) time and allocates one small recipe; O(rows) space
     * @example
     * const villagers = catalog.table([{ species: 'human', weight: 5 }, { species: 'elf', weight: 1 }]);
     * const crowd = Array.from({ length: 200 }, (_unused, index) => villagers.roll(worldSeed, index));
     */
    const table = (rows) => {
      if (!Array.isArray(rows) || !rows.length) fail('table', 'a species table needs at least one row of { species, weight }.');
      const weighted = rows.map((row) => ({ species: species(row.species).id, weight: row.weight === undefined ? 1 : row.weight }));
      return {
        roll: (seed, index = 0) => ({ species: Kit.seeded.pick(weighted, seedUnit(seed, TABLE_SPECIES_FIELD, index)).species, seed: seedBits(seed, TABLE_SEED_FIELD, index), overrides: {} }),
      };
    };

    // ---- bakes ----

    /**
     * A cache of bakes. A bake is the expensive, shareable half of an instance: the assembled plan (bare plan
     * plus worn parts), the dial set compiled against it and the proportioned rest pose. Five hundred instances
     * of twenty looks bake twenty times.
     * @param {{capacity?: number}} [options] bakes kept before the oldest is dropped (default 512)
     * @returns {{bake: function(Individual): Bake, bakeRecipe: function(Recipe): Bake, stats: function(): {bakes: number, hits: number, size: number, outfits: number}, skeletons: function(): number, clear: function(): void}}
     *   `bake` returns the cached bake for the individual's hash or builds it; `bakeRecipe` resolves first;
     *   `stats` counts bakes built, cache hits, bakes held and distinct outfits (assembled plans) held
     * @complexity a hit is O(fields) (the hash); a miss is O(bones + dial operations), plus O(bones x dials) the
     *   first time an outfit is seen. Space O(capacity x bones).
     * @example
     * const bakery = catalog.bakery();
     * const bake = bakery.bakeRecipe(recipe);
     * Kit.rig.copy(bake.rest, pose);   // then pose it and call Kit.body.worldTransforms(bake.plan, pose, world)
     */
    const bakery = ({ capacity = DEFAULT_BAKE_CAPACITY } = {}) => {
      /** @type {Map<number, Bake>} */
      const bakes = new Map();
      /** @type {Map<string, {plan: Object, dialSet: Object}>} species + outfit -> what every individual wearing it shares */
      const outfits = new Map();
      let built = 0;
      let hits = 0;
      /** @type {Map<string, Object>} species + the fills that bring bones -> the skeleton every face and print on it shares */
      const skeletons = new Map();
      const keyOf = (kind, fills, paths) => `${kind.id}|${paths.map((path) => `${path}=${fills[path]}`).join(',')}`;
      const pick = (fills, paths) => Object.fromEntries(paths.map((path) => [path, fills[path]]));
      /**
       * The skeleton key is the outfit key without the parts that are only surface (eyes, a mouth, a printed
       * shirt): trying on a face part compiles no bones, it lays new features and regions on the skeleton it shares.
       */
      const skeletonOf = (kind, fills, paths) => {
        const key = keyOf(kind, fills, paths);
        const known = skeletons.get(key);
        if (known) return known;
        const plan = Kit.body.assemble(kind.plan, pick(fills, paths), compiledParts);
        skeletons.set(key, plan);
        return plan;
      };
      const outfitOf = (kind, fills) => {
        const paths = Object.keys(fills);
        const key = keyOf(kind, fills, paths);
        const known = outfits.get(key);
        if (known) return known;
        const isSurface = (path) => fills[path] !== null && fills[path] !== undefined && compiledParts[fills[path]] && !compiledParts[fills[path]].spec.bones.length;
        const skeleton = skeletonOf(kind, fills, paths.filter((path) => !isSurface(path)));
        const plan = Kit.body.assemble(skeleton, pick(fills, paths.filter(isSurface)), compiledParts);
        const outfit = { plan, dialSet: Kit.body.dials(plan, kind.dialRows) };
        outfits.set(key, outfit);
        return outfit;
      };
      const bake = (individual) => {
        const key = hash(individual);
        const cached = bakes.get(key);
        if (cached) {
          hits += 1;
          return cached;
        }
        const kind = species(individual.species);
        const { plan, dialSet } = outfitOf(kind, individual.fills);
        const shapes = Kit.body.shapesWithDials(plan, dialSet, individual.dials);
        const ramps = Object.freeze(kind.colorIds.map((_channel, index) => kind.palettes[index][individual.colors[index]]));
        const fresh = Object.freeze({
          hash: key,
          species: kind.id,
          plan,
          rest: Kit.body.applyDials(plan, dialSet, individual.dials, Kit.body.createPose(plan)),
          shapes,
          surface: Kit.body.surfaceOf(plan, shapes, dialSet, individual.dials, kind.colorIds, ramps),
          colors: Object.freeze(Object.fromEntries(kind.colorIds.map((channel, index) => [channel, kind.palettes[index][individual.colors[index]]]))),
          ramps,
          // Per bone: which of the individual's ramps paints it. Indices, not colours: the shaders are palette-indexed.
          boneRamp: Int16Array.from(plan.bonePaint, (paint) => (paint ? kind.colorIds.indexOf(plan.paintChannels[paint - 1]) : -1)),
          individual,
        });
        built += 1;
        bakes.set(key, fresh);
        // A Map remembers insertion order, so its first key is the oldest bake.
        if (bakes.size > capacity) bakes.delete(bakes.keys().next().value);
        return fresh;
      };
      return {
        bake,
        bakeRecipe: (recipe) => bake(resolve(recipe)),
        stats: () => ({ bakes: built, hits, size: bakes.size, outfits: outfits.size }),
        /** How many distinct skeletons the outfits held share: outfits that differ only in surface parts (a face, a print) count once. */
        skeletons: () => skeletons.size,
        clear() {
          bakes.clear();
          outfits.clear();
          skeletons.clear();
        },
      };
    };

    return {
      lineage,
      plans: compiledPlans,
      parts: compiledParts,
      palettes: paletteTable,
      species,
      speciesIds: () => [...kinds.keys()],
      resolve,
      describe,
      socketsOf,
      validate,
      normalize,
      encode,
      decode,
      hash,
      table,
      bakery,
    };
  };

  Kit.body = Object.assign(Kit.body || {}, { catalog, DIAL_STEPS, RECIPE_FORMAT_VERSION: FORMAT_VERSION });
})();
