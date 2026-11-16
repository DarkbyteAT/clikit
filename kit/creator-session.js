/**
 * Kit creator session: the state and every editing action of a character creator, with no interface in it.
 * One session holds the recipe being edited, its undo history, the controls the person has locked, the sided
 * dials they moved one side at a time, the character's name and the recipe the session started from (what a
 * "compare" shows).
 *
 * Owns:  `Kit.creator.session(options)` and what it returns; `Kit.creator.parseShareCode` / `shareCode` (a
 *        recipe as a short code and back, with every failure explained in plain words); `Kit.creator.switchSpecies`
 *        (change body type keeping what still fits); `Kit.creator.suggestName`.
 * Does not own: what an edit means (kit/body-edit.js: every change goes through the editor, so a recipe is always
 *        one the catalogue accepts), how a recipe is stored or shared on the wire (kit/body-recipe.js,
 *        kit/pack.js), history itself (`Kit.history` in kit/space.js) or any element (kit/creator-controls.js).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-creator.js. Time and randomness are
 * passed in, so a test controls both.
 */
(() => {
  /** Edits to one control within this long of each other are one step of the undo history (a drag, a held arrow key). */
  const MERGE_WINDOW_MS = 700;
  /** The most undo steps kept. */
  const HISTORY_LIMIT = 100;
  /** The longest name a character may have. */
  const NAME_LIMIT = 24;
  /** Seeds are unsigned 32-bit whole numbers. */
  const SEED_RANGE = 2 ** 32;

  /** Name parts for `suggestName`: a given name and a family word, so a new character starts with a name to change. */
  const NAME_PARTS = Object.freeze({
    given: ['Ansel', 'Brea', 'Corin', 'Dessa', 'Edric', 'Fenna', 'Galen', 'Hesper', 'Ivo', 'Jessa', 'Kestrel', 'Lio', 'Marra', 'Nell', 'Orrin', 'Perrin'],
    family: ['Ashgrove', 'Brightwater', 'Cobbler', 'Dunmere', 'Eastlake', 'Fairweather', 'Greenhollow', 'Hightower', 'Inkwell', 'Juniper', 'Kettleby', 'Larkspur', 'Millbrook', 'Northcott', 'Oakenshaw', 'Pennywhistle'],
  });

  /**
   * What each way a share code can fail looks like in the library's error text, and what to tell a person.
   * Checked in order; the first pattern that matches wins.
   * @type {Array<{pattern: RegExp, say: function(RegExpMatchArray): string}>}
   */
  const CODE_PROBLEMS = [
    { pattern: /"(.)" at position (\d+)/, say: ([, character, position]) => `The code has a character that does not belong, "${character}", at place ${Number(position) + 1}. Codes use only letters, numbers, - and _, so check it was copied whole.` },
    { pattern: /cut short/, say: () => 'The code looks cut off. Copy it again from its first character to its last.' },
    { pattern: /this is recipe format/, say: () => 'This code was made by a different version of the creator, so it cannot be read here.' },
    { pattern: /no species has the code/, say: () => 'This code is for a body type this creator does not have.' },
    { pattern: /has no field with the id/, say: () => 'This code uses a control that has since been renamed or removed, so the character cannot be rebuilt exactly.' },
    { pattern: /not in the catalogue/, say: () => 'This code uses a part that has since been renamed or removed, so the character cannot be rebuilt exactly.' },
    { pattern: /damaged/, say: () => 'The code looks damaged. Copy it again.' },
  ];
  const UNKNOWN_CODE_PROBLEM = 'That does not look like a character code from this creator. Copy the whole code and paste it again.';
  const EMPTY_CODE_PROBLEM = 'Paste a share code first.';

  /**
   * A recipe as a short text a person can copy.
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {Object} recipe a recipe the catalogue accepts
   * @returns {string} letters, digits, '-' and '_'
   * @complexity O(fields)
   * @example Kit.creator.shareCode(catalog, { species: 'person', seed: 7 }) // 'AQoHAAAA'
   */
  const shareCode = (catalog, recipe) => Kit.pack.toText(catalog.encode(recipe));

  /**
   * Reads a pasted share code. Never throws: every failure comes back as a sentence a person can act on.
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {string} text what was pasted (spaces, line breaks and quotes around it are ignored)
   * @returns {{ok: true, recipe: Object}|{ok: false, message: string}}
   * @complexity O(characters)
   * @example Kit.creator.parseShareCode(catalog, 'not a code!').message // 'The code has a character that does not belong, ...'
   */
  const parseShareCode = (catalog, text) => {
    const cleaned = String(text === undefined || text === null ? '' : text).replace(/[\s"'`]/g, '');
    if (!cleaned) return { ok: false, message: EMPTY_CODE_PROBLEM };
    try {
      return { ok: true, recipe: catalog.decode(Kit.pack.fromText(cleaned)) };
    } catch (error) {
      const known = CODE_PROBLEMS.map((problem) => ({ problem, found: error.message.match(problem.pattern) })).find((entry) => entry.found);
      return { ok: false, message: known ? known.problem.say(known.found) : UNKNOWN_CODE_PROBLEM };
    }
  };

  /**
   * A given name and a family word, chosen by a seed (the same seed always gives the same name).
   * @param {number} seed a whole number
   * @returns {string}
   * @example Kit.creator.suggestName(0) // 'Ansel Ashgrove'
   */
  const suggestName = (seed) => {
    const { given, family } = NAME_PARTS;
    return `${given[seed % given.length]} ${family[Math.floor(seed / given.length) % family.length]}`;
  };

  /** A name cut to the limit and trimmed; empty text stays empty. */
  const cleanName = (text) => String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);

  /**
   * Changes a recipe's body type and keeps what still fits: every override the new species can hold stays (a
   * dial outside the new range is clamped by the catalogue), every one it cannot is dropped and reported.
   * @param {Object} catalog from `Kit.body.catalog`
   * @param {Object} recipe
   * @param {string} speciesId one of `catalog.speciesIds()`
   * @returns {{recipe: Object, kept: number, dropped: string[]}} `dropped` lists the field keys that did not carry over
   * @throws {Error} naming the species when it does not exist
   * @complexity O(fields + overrides log overrides)
   * @example Kit.creator.switchSpecies(catalog, recipe, 'lanky').recipe.species // 'lanky'
   */
  const switchSpecies = (catalog, recipe, speciesId) => {
    const overrides = recipe.overrides || {};
    const candidate = { species: speciesId, seed: recipe.seed, overrides };
    const unusable = new Set(catalog.validate(candidate).filter((problem) => problem.code !== 'out-of-range').map((problem) => problem.field));
    const keptKeys = Object.keys(overrides).filter((key) => !unusable.has(key));
    const kept = Object.fromEntries(keptKeys.map((key) => [key, overrides[key]]));
    return { recipe: catalog.normalize({ species: speciesId, seed: recipe.seed, overrides: kept }), kept: keptKeys.length, dropped: [...unusable] };
  };

  /**
   * @typedef {Object} CreatorSession
   * @property {function(): Object} recipe the recipe being edited
   * @property {function(): Object} baseline the recipe the session started from, or the last one loaded
   * @property {function(): Object} schema `editor.schema` of the recipe (kept until the recipe changes)
   * @property {function(): Object[]} groups `Kit.creator.rows.groupsOf` of the schema, honouring unlinked pairs
   * @property {function(string, number): void} setDial set a dial by its set id (a sided pair's base moves both sides)
   * @property {function(string, number): void} setColor set a colour channel to a ramp index
   * @property {function(string, ?string): void} setSocket put a part in a socket, or null to empty it
   * @property {function(Object): void} resetDial put one slider (`DialSlider`) back to its default
   * @property {function(string[]): void} toggleLock lock the keys if any is open, else open them all
   * @property {function(string): boolean} isLocked
   * @property {function(string[]): boolean} areLocked
   * @property {function(string): boolean} toggleLink link a sided pair, or let its sides move apart; returns whether it is linked now
   * @property {function(): void} randomizeAll
   * @property {function(string): void} randomizeGroup
   * @property {function(string=): void} mirror
   * @property {function(string): {kept: number, dropped: string[]}} setSpecies
   * @property {function(): boolean} undo
   * @property {function(): boolean} redo
   * @property {function(): boolean} canUndo
   * @property {function(): boolean} canRedo
   * @property {function(): void} endGesture the next edit to the same control starts a new undo step
   * @property {function(): string} name
   * @property {function(string): string} setName
   * @property {function(): string} code the share code of the recipe
   * @property {function(string): {ok: boolean, message?: string}} importCode load a pasted code (one undo step)
   * @property {function(Object, string=): void} load replace the recipe (one undo step) and make it the new baseline
   * @property {function(): Object} summary `{ revision, canUndo, canRedo, isChanged }`
   */

  /**
   * Makes a session.
   * @param {{catalog: Object, editor: Object, recipe?: Object, name?: string, now?: function(): number, random?: function(): number}} options
   *   `recipe` the starting character (default: the first species, seed 1); `now` a clock in milliseconds and
   *   `random` a source in [0, 1), both injectable for tests
   * @returns {CreatorSession}
   * @complexity every action is O(controls) (a schema is rebuilt after an edit); memory O(history x overrides)
   * @example
   * const session = Kit.creator.session({ catalog, editor });
   * session.setDial('height', 1.1); session.randomizeGroup('face'); session.undo();
   */
  const session = ({ catalog, editor, recipe: startingRecipe, name: startingName, now = Date.now, random = Math.random }) => {
    let current = catalog.normalize(startingRecipe || { species: catalog.speciesIds()[0], seed: 1 });
    let baseline = current;
    let characterName = cleanName(startingName) || suggestName(current.seed);
    const locked = new Set();
    const unlinked = new Set();
    const history = Kit.history({ max: HISTORY_LIMIT });
    history.push(current);
    let revision = 0;
    let lastMergeKey = null;
    let lastEditAt = 0;
    let cachedFor = null;
    let cachedSchema = null;
    let cachedGroups = null;

    const schema = () => {
      if (cachedFor !== current) {
        cachedSchema = editor.schema(current);
        cachedGroups = null;
        cachedFor = current;
      }
      return cachedSchema;
    };
    const groups = () => {
      const fresh = schema();
      if (!cachedGroups) cachedGroups = Kit.creator.rows.groupsOf(fresh, { unlinked });
      return cachedGroups;
    };
    /** Drops the cached rows (not the schema) after something that changes how rows look but not the recipe. */
    const forgetRows = () => {
      cachedGroups = null;
      revision += 1;
    };
    const everyKey = () => {
      const fresh = schema();
      return new Set([...fresh.dials, ...fresh.colors, ...fresh.sockets].map((control) => control.key));
    };

    /**
     * Makes a recipe current as one undo step, or merges it into the step before when it continues the same gesture.
     * @param {Object} next
     * @param {?string} mergeKey identifies the control being dragged; null never merges
     */
    const commit = (next, mergeKey = null) => {
      const isSame = JSON.stringify(next) === JSON.stringify(current);
      if (isSame) return;
      const canMerge = mergeKey !== null && mergeKey === lastMergeKey && now() - lastEditAt <= MERGE_WINDOW_MS && history.canUndo();
      if (canMerge) history.undo();
      history.push(next);
      current = next;
      lastMergeKey = mergeKey;
      lastEditAt = now();
      revision += 1;
    };
    const newSeed = () => Math.floor(random() * SEED_RANGE) >>> 0;

    /** Field keys of every control outside a group: what a "randomise this group" keeps. */
    const keysOutside = (groupId) => {
      const fresh = schema();
      return [...fresh.dials, ...fresh.colors, ...fresh.sockets].filter((control) => control.group !== groupId).map((control) => control.key);
    };
    /** The locked keys the current body type still has (a lock on a control that is gone would make `randomize` throw). */
    const lockedKeys = () => {
      const present = everyKey();
      return [...locked].filter((key) => present.has(key));
    };

    const self = {
      recipe: () => current,
      baseline: () => baseline,
      schema,
      groups,
      setDial: (setId, value) => commit(editor.setDial(current, setId, value), `dial:${setId}`),
      setColor: (channel, rampIndex) => commit(editor.setColor(current, channel, rampIndex), `color:${channel}`),
      setSocket: (path, partId) => commit(editor.setSocket(current, path, partId)),
      resetDial: (slider) => commit(editor.setDial(current, slider.setId, slider.default)),
      toggleLock(keys) {
        const shouldLock = keys.some((key) => !locked.has(key));
        keys.forEach((key) => (shouldLock ? locked.add(key) : locked.delete(key)));
        revision += 1;
      },
      isLocked: (key) => locked.has(key),
      areLocked: (keys) => keys.length > 0 && keys.every((key) => locked.has(key)),
      toggleLink(base) {
        const pair = groups()
          .flatMap((group) => group.rows)
          .find((row) => row.base === base);
        if (pair && pair.isLinked) {
          // Unlinking changes no value: the two sliders simply appear, so no undo step is made.
          unlinked.add(base);
          forgetRows();
          return false;
        }
        // Linking gives both sides the left side's value, as one undo step.
        unlinked.delete(base);
        commit(editor.link(current, base, 'left'));
        forgetRows();
        return true;
      },
      randomizeAll: () => commit(editor.randomize(current, newSeed(), { locked: lockedKeys() })),
      randomizeGroup: (groupId) => commit(editor.randomize(current, newSeed(), { locked: [...new Set([...lockedKeys(), ...keysOutside(groupId)])] })),
      mirror: (from = 'left') => commit(editor.mirror(current, from)),
      setSpecies(speciesId) {
        if (speciesId === current.species) return { kept: 0, dropped: [] };
        const { recipe: next, kept, dropped } = switchSpecies(catalog, current, speciesId);
        commit(next);
        // Locks and unlinked pairs of controls the new body type lacks no longer mean anything.
        const keys = everyKey();
        [...locked].filter((key) => !keys.has(key)).forEach((key) => locked.delete(key));
        unlinked.clear();
        forgetRows();
        return { kept, dropped };
      },
      undo() {
        const previous = history.undo();
        if (!previous) return false;
        current = previous;
        lastMergeKey = null;
        revision += 1;
        return true;
      },
      redo() {
        const next = history.redo();
        if (!next) return false;
        current = next;
        lastMergeKey = null;
        revision += 1;
        return true;
      },
      canUndo: () => history.canUndo(),
      canRedo: () => history.canRedo(),
      endGesture() {
        lastMergeKey = null;
      },
      name: () => characterName,
      setName(text) {
        characterName = cleanName(text);
        revision += 1;
        return characterName;
      },
      code: () => shareCode(catalog, current),
      importCode(text) {
        const parsed = parseShareCode(catalog, text);
        if (!parsed.ok) return parsed;
        self.load(parsed.recipe);
        return { ok: true };
      },
      load(recipe, nextName) {
        commit(catalog.normalize(recipe));
        baseline = current;
        if (nextName !== undefined) characterName = cleanName(nextName) || characterName;
        unlinked.clear();
        forgetRows();
      },
      summary: () => ({ revision, canUndo: history.canUndo(), canRedo: history.canRedo(), isChanged: current !== baseline && JSON.stringify(current) !== JSON.stringify(baseline) }),
    };
    return self;
  };

  Kit.creator = Object.assign(Kit.creator || {}, { session, shareCode, parseShareCode, switchSpecies, suggestName, cleanName, MERGE_WINDOW_MS, NAME_LIMIT });
})();
