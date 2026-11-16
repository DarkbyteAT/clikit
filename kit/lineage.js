/**
 * Kit lineage: definitions that inherit. A node names a parent and holds only what it changes (archetype ->
 * species -> variant -> individual); traits are named mix-ins a node pulls in; limits are ranges a node imposes on
 * itself and everything below it. `resolve(id)` folds the chain root-first into one frozen definition.
 *
 * Owns:  `Kit.lineage(spec)` - the fold (parent, then the node's traits in declared order, then the node's own
 *        `set`), trait-conflict detection on the paths declared exclusive, limit inheritance and enforcement,
 *        memoisation, and errors that name the node, the path and the fix.
 * Does not own: what the definitions mean. It knows nothing about bodies (kit/body-recipe.js gives the values a
 *        shape), items or enemies; any table of "kinds of thing" with shared ancestry can use it.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /** Separator of the path strings used in `limits`, `exclusive` and error messages ('dials.height.max'). */
  const PATH_SEPARATOR = '.';
  /** A chain longer than this is almost certainly a parent loop the cycle check missed building; refuse it. */
  const DEEPEST_CHAIN = 64;

  /**
   * @typedef {Object} LineageRange
   * @property {number} [min] smallest value allowed (default: no lower bound)
   * @property {number} [max] largest value allowed (default: no upper bound)
   */

  /**
   * @typedef {Object} LineageNode
   * @property {string} [parent] id of the node this one inherits from; omitted for a root (an archetype)
   * @property {string[]} [traits] trait names, merged in this order after the parent and before `set`
   * @property {Object} [set] sparse overrides: plain objects merge key by key; numbers, strings, booleans, null
   *   and arrays replace what was inherited. Keys may not contain '.'.
   * @property {Object<string, LineageRange>} [limits] path -> range, enforced on every number at or under that
   *   path in this node and in every node below it. A descendant may narrow a limit, never widen it.
   */

  /**
   * @typedef {Object} LineageTrait
   * @property {Object} set sparse overrides, same merge rules as `LineageNode.set`
   */

  /**
   * @typedef {Object} LineageSpec
   * @property {Object<string, LineageNode>} nodes every node by id
   * @property {Object<string, LineageTrait>} [traits] every trait by name
   * @property {string[]} [exclusive] paths whose direct children are slots only one trait of a node may write:
   *   with `['fills']`, two traits of one node that both write under `fills.back` are an error at resolve time.
   *   Everywhere else the later trait wins. The node's own `set` always wins and never conflicts.
   */

  /**
   * @typedef {Object} ResolvedDefinition
   * @property {string} id the node resolved
   * @property {string[]} chain ids from the root to this node
   * @property {Object} values the folded definition, deeply frozen (shared with ancestors where unchanged)
   * @property {Object<string, {min: number, max: number, minOwner: string, maxOwner: string}>} limits the
   *   limits in force here: each path's tightest bounds and the node that owns each
   */

  /**
   * @typedef {Object} Lineage
   * @property {function(string): ResolvedDefinition} resolve fold a node's chain; memoised, so the second call
   *   for an id (or for a child of an already resolved parent) does no merging of the shared part
   * @property {function(string): boolean} has is this a known node id?
   * @property {function(): string[]} ids every node id, in declaration order
   * @property {function(string): string[]} childrenOf ids of the nodes whose parent is this id
   * @property {function(): number} resolveCount how many folds have actually run (cache misses); for tests and benches
   */

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  /** Freezes a value and everything inside it; already-frozen subtrees (shared with an ancestor) are skipped. */
  const freezeDeep = (value) => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  };

  /** Copies a list (and anything inside it) so that freezing a resolved definition never freezes the caller's tables. */
  const copyLeaf = (value) => {
    if (Array.isArray(value)) return value.map(copyLeaf);
    return isPlainObject(value) ? Object.fromEntries(Object.keys(value).map((key) => [key, copyLeaf(value[key])])) : value;
  };

  /**
   * Merges sparse overrides over a base without changing either: objects merge, everything else replaces.
   * Untouched subtrees of `base` are reused, not copied, which is safe because resolved values are frozen.
   * @param {*} base
   * @param {*} overrides
   * @param {function(string[]): void} [onLeaf] called with the path of every non-object value written
   * @param {string[]} [path] where `overrides` sits; grows as the merge descends
   * @returns {*} the merged value
   * @complexity O(keys in overrides) time and new objects; the base is not walked
   */
  const mergeSparse = (base, overrides, onLeaf, path = []) => {
    if (!isPlainObject(overrides)) {
      if (onLeaf) onLeaf(path);
      return copyLeaf(overrides);
    }
    const merged = isPlainObject(base) ? { ...base } : {};
    Object.keys(overrides).forEach((key) => {
      if (key.includes(PATH_SEPARATOR))
        throw new Error(
          `Kit.lineage: the key "${key}" (under "${path.join(PATH_SEPARATOR)}") contains "${PATH_SEPARATOR}", which separates path steps. Rename it without one (for example "${key.split(PATH_SEPARATOR).join('_')}").`
        );
      merged[key] = mergeSparse(merged[key], overrides[key], onLeaf, [...path, key]);
    });
    return merged;
  };

  /** Reads the value at a path of keys, or undefined when any step is missing. */
  const valueAt = (values, keys) => keys.reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), values);

  /** Calls `visit(number, path)` for every number at or under a value (arrays are leaves and are not entered). */
  const eachNumberUnder = (value, path, visit) => {
    if (typeof value === 'number') return visit(value, path);
    if (isPlainObject(value)) Object.keys(value).forEach((key) => eachNumberUnder(value[key], `${path}${PATH_SEPARATOR}${key}`, visit));
  };

  /**
   * Builds a lineage over a table of nodes. Nothing is resolved until asked for; a mistake in a node is reported
   * when that node (or one below it) is first resolved, and `ids().forEach(resolve)` checks the whole table.
   * @param {LineageSpec} spec
   * @returns {Lineage}
   * @throws {Error} at build time for a missing `nodes`; at resolve time for an unknown id, parent or trait, a
   *   parent loop, two traits of one node writing the same exclusive slot, or a number outside a limit
   * @complexity `resolve` is O(depth x overrides) the first time for a chain and O(1) after; memory is O(nodes
   *   resolved x overrides) because unchanged subtrees are shared with the parent's definition
   * @example
   * const kinds = Kit.lineage({
   *   nodes: {
   *     creature: { set: { size: 1 } },
   *     elf: { parent: 'creature', traits: ['keenEyed'], set: { size: 0.9 }, limits: { size: { min: 0.7, max: 1.1 } } },
   *     woodElf: { parent: 'elf', set: { size: 0.8 } },
   *   },
   *   traits: { keenEyed: { set: { sight: 12 } } },
   * });
   * kinds.resolve('woodElf').values   // { size: 0.8, sight: 12 }, frozen
   */
  Kit.lineage = ({ nodes, traits = {}, exclusive = [] }) => {
    if (!isPlainObject(nodes)) throw new Error('Kit.lineage: `nodes` must be an object of id -> { parent, traits, set, limits }.');
    const exclusivePaths = exclusive.map((path) => path.split(PATH_SEPARATOR));
    /** @type {Map<string, ResolvedDefinition>} */
    const resolved = new Map();
    /** Ids being folded right now, to turn a parent loop into an error instead of a stack overflow. */
    const inProgress = new Set();
    let foldsRun = 0;

    /** The exclusive slot a written path falls in ('fills.back' for fills.back.part), or null. */
    const exclusiveSlotOf = (path) => {
      const owner = exclusivePaths.find((prefix) => path.length > prefix.length && prefix.every((key, index) => path[index] === key));
      return owner ? path.slice(0, owner.length + 1).join(PATH_SEPARATOR) : null;
    };

    /** Merges a node's traits in declared order, refusing two traits that write the same exclusive slot. */
    const applyTraits = (id, node, values) => {
      /** @type {Map<string, string>} exclusive slot -> the trait that wrote it */
      const writers = new Map();
      return (node.traits || []).reduce((merged, traitName) => {
        const trait = traits[traitName];
        if (!trait) throw new Error(`Kit.lineage: node "${id}" uses the trait "${traitName}", which is not in \`traits\`. Known traits: ${Object.keys(traits).join(', ') || '(none)'}.`);
        return mergeSparse(merged, trait.set || {}, (path) => {
          const slot = exclusiveSlotOf(path);
          if (!slot) return;
          const earlier = writers.get(slot);
          if (earlier && earlier !== traitName)
            throw new Error(
              `Kit.lineage: traits "${earlier}" and "${traitName}" of node "${id}" both write "${slot}". Drop one of them, or state the winner in the node's own \`set\` and remove it from one trait.`
            );
          writers.set(slot, traitName);
        });
      }, values);
    };

    /** The parent's limits narrowed by the node's own; each bound remembers the node that set it. */
    const inheritLimits = (id, node, parentLimits) => {
      const limits = { ...parentLimits };
      Object.keys(node.limits || {}).forEach((path) => {
        const own = node.limits[path];
        const inherited = limits[path] || { min: -Infinity, max: Infinity, minOwner: id, maxOwner: id };
        const narrowsMin = own.min !== undefined && own.min > inherited.min;
        const narrowsMax = own.max !== undefined && own.max < inherited.max;
        limits[path] = {
          min: narrowsMin ? own.min : inherited.min,
          max: narrowsMax ? own.max : inherited.max,
          minOwner: narrowsMin ? id : inherited.minOwner,
          maxOwner: narrowsMax ? id : inherited.maxOwner,
        };
      });
      return limits;
    };

    /** Throws when any number under a limited path is outside the range in force. */
    const enforceLimits = (id, values, limits) =>
      Object.keys(limits).forEach((limitPath) => {
        const { min, max, minOwner, maxOwner } = limits[limitPath];
        eachNumberUnder(valueAt(values, limitPath.split(PATH_SEPARATOR)), limitPath, (value, path) => {
          if (value >= min && value <= max) return;
          const owner = value < min ? minOwner : maxOwner;
          throw new Error(`Kit.lineage: node "${id}" has ${path} = ${value}, outside the limit [${min}, ${max}] owned by "${owner}". Change the value, or widen the limit at "${owner}".`);
        });
      });

    const fold = (id) => {
      const node = nodes[id];
      if (!node) throw new Error(`Kit.lineage: unknown node "${id}". Known nodes: ${Object.keys(nodes).join(', ') || '(none)'}.`);
      if (inProgress.has(id)) throw new Error(`Kit.lineage: the parent chain of "${id}" loops back to itself (${[...inProgress].join(' -> ')} -> ${id}). Break the loop by removing one \`parent\`.`);
      inProgress.add(id);
      try {
        const base = node.parent === undefined ? { chain: [], values: {}, limits: {} } : resolve(node.parent);
        if (base.chain.length >= DEEPEST_CHAIN) throw new Error(`Kit.lineage: "${id}" is more than ${DEEPEST_CHAIN} levels deep. Flatten the chain.`);
        const values = freezeDeep(mergeSparse(applyTraits(id, node, base.values), node.set || {}));
        const limits = inheritLimits(id, node, base.limits);
        enforceLimits(id, values, limits);
        foldsRun += 1;
        return Object.freeze({ id, chain: Object.freeze([...base.chain, id]), values, limits: freezeDeep(limits) });
      } finally {
        inProgress.delete(id);
      }
    };

    const resolve = (id) => {
      const cached = resolved.get(id);
      if (cached) return cached;
      const definition = fold(id);
      resolved.set(id, definition);
      return definition;
    };

    return {
      resolve,
      has: (id) => Object.keys(nodes).includes(id),
      ids: () => Object.keys(nodes),
      childrenOf: (id) => Object.keys(nodes).filter((childId) => nodes[childId].parent === id),
      resolveCount: () => foldsRun,
    };
  };
})();
