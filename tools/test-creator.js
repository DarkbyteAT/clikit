/**
 * Unit tests for the character creator's pure pieces (kit/creator-rows.js, creator-session.js, creator-slots.js,
 * creator-camera.js) over the wardrobe catalogue. Loaded by tools/test-kit.js after the body tests, which have
 * already put the body system and the wardrobe in the sandbox, so these count in the one suite.
 *
 * Owns:  the cases, each with a control that would fail if the logic were wrong (the same call on a case where the
 *        effect must not happen).
 * Does not own: the sandbox or the runner (tools/test-kit.js), or the interface, which tools/test-creator-ui.js
 *        checks in a browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Kit files these tests add to the sandbox, in load order. */
const FILES = ['creator-rows', 'creator-session', 'creator-slots', 'creator-camera'];

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);

  const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const editor = Kit.body.editor(catalog);
  /** A clock the test moves by hand. */
  const makeClock = () => {
    const clock = { at: 1000, now: () => clock.at, advance: (ms) => (clock.at += ms) };
    return clock;
  };
  /** A source of "random" numbers that walks through fixed values, so a randomise is repeatable. */
  const makeRandom = (values) => {
    let index = 0;
    return () => values[index++ % values.length];
  };
  const makeSession = (options = {}) => {
    const clock = makeClock();
    const session = Kit.creator.session({ catalog, editor, now: clock.now, random: makeRandom([0.11, 0.37, 0.58, 0.83]), ...options });
    return { session, clock };
  };
  /** The wardrobe plus one new dial (on the base person only), one new part and one new colour channel, as a catalogue author would add them. */
  const extendedCatalog = () => {
    const spec = JSON.parse(JSON.stringify(Kit.body.wardrobe.CATALOG));
    spec.nodes.person.set = { ...spec.nodes.person.set, dials: { noggin: { min: 0.7, max: 1.3, affects: [{ roles: ['head'], channel: 'size' }] } } };
    spec.parts.capTwo = JSON.parse(JSON.stringify(spec.parts.cap));
    return Kit.body.catalog(spec);
  };
  /** Field values of the controls in a group, by key: what a "this group only" randomise may change. */
  const valuesInGroup = (session, groupId, isInside) => {
    const schema = session.schema();
    const values = Kit.creator.rows.valuesOf(schema);
    const keys = [...schema.dials, ...schema.colors, ...schema.sockets].filter((control) => (control.group === groupId) === isInside).map((control) => control.key);
    return Object.fromEntries(keys.map((key) => [key, values[key]]));
  };

  // ---- rows: controls generated from the schema ----

  test('creator rows: every group of the schema becomes a tab and every control lands in exactly one row of its group', () => {
    const schema = editor.schema({ species: 'person', seed: 4 });
    const groups = Kit.creator.rows.groupsOf(schema);
    same(
      groups.map((group) => group.id),
      schema.groups.map((group) => group.id),
      'tabs follow schema().groups in order'
    );
    const keys = [...schema.dials, ...schema.colors, ...schema.sockets].map((control) => control.key);
    const covered = groups.flatMap((group) => group.rows.flatMap((row) => row.valueKeys));
    same([...covered].sort(), [...keys].sort(), 'every dial, colour and socket is reachable, none twice');
    groups.forEach((group) => group.rows.forEach((row) => assert.strictEqual(row.group, group.id, `${row.id} sits in its own group`)));
    assert.ok(
      groups.every((group) => group.rows.every((row, index) => index === 0 || row.depth > 0 || group.rows[index - 1].depth > 0 || row.order >= group.rows[index - 1].order)),
      'top-level rows are in `order`'
    );
  });
  test('creator rows: a new dial and a new part in the catalogue appear as controls with no change to the creator', () => {
    const bigger = extendedCatalog();
    const biggerEditor = Kit.body.editor(bigger);
    const recipe = { species: 'person', seed: 4 };
    const find = (anyEditor, anyRecipe) => Kit.creator.rows.groupsOf(anyEditor.schema(anyRecipe)).flatMap((group) => group.rows);
    const noggin = find(biggerEditor, recipe).find((row) => row.id === 'dial:noggin');
    assert.ok(noggin, 'the new dial has a row');
    same([noggin.kind, noggin.group, noggin.label, noggin.sliders.length, noggin.sliders[0].setId, noggin.sliders[0].min, noggin.sliders[0].max], ['dial', 'head', 'Noggin', 1, 'noggin', 0.7, 1.3]);
    const hat = find(biggerEditor, recipe).find((row) => row.id === 'fill:hat');
    assert.ok(hat.choices.some((choice) => choice.id === 'capTwo'), 'the new part is a choice of the socket it fits');
    assert.strictEqual(find(editor, recipe).find((row) => row.id === 'dial:noggin'), undefined, 'control: the unextended catalogue has neither');
    assert.ok(!find(editor, recipe).find((row) => row.id === 'fill:hat').choices.some((choice) => choice.id === 'capTwo'));
    // And the edit works through the row's own slider id, not through anything written for the dial.
    const edited = biggerEditor.setDial(recipe, noggin.sliders[0].setId, 1.2);
    close(Kit.creator.rows.valuesOf(biggerEditor.schema(edited))['dial:noggin'], 1.2, 0.01, 'the slider id edits the dial');
  });
  test('creator rows: a sided pair is one row with one slider while linked and two while unlinked; a plain dial is one slider', () => {
    const schema = editor.schema({ species: 'person', seed: 4 });
    const rows = Kit.creator.rows.groupsOf(schema).flatMap((group) => group.rows);
    const eyes = rows.find((row) => row.id === 'dial:eyeSize');
    same([eyes.isSided, eyes.isLinked, eyes.sliders.map((slider) => slider.setId), eyes.lockKeys], [true, true, ['eyeSize'], ['dial:eyeSize@left', 'dial:eyeSize@right']]);
    const apart = Kit.creator.rows.groupsOf(schema, { unlinked: new Set(['eyeSize']) }).flatMap((group) => group.rows).find((row) => row.id === 'dial:eyeSize');
    same([apart.isLinked, apart.sliders.map((slider) => [slider.setId, slider.caption])], [false, [['eyeSize@left', 'Left'], ['eyeSize@right', 'Right']]]);
    const height = rows.find((row) => row.id === 'dial:height');
    same([height.isSided, height.sliders.length, height.sliders[0].setId], [false, 1, 'height']);
    // A pair whose values differ shows two sliders by itself, without being told.
    const lopsided = editor.setDial({ species: 'person', seed: 4 }, 'eyeSize@left', 1.3);
    const lopsidedRow = Kit.creator.rows.groupsOf(editor.schema(lopsided)).flatMap((group) => group.rows).find((row) => row.id === 'dial:eyeSize');
    same([lopsidedRow.isLinked, lopsidedRow.sliders.length], [false, 2]);
  });
  test('creator rows: a nested socket is listed directly under its parent, and the row set changes only when the structure does', () => {
    const lantern = editor.setSocket({ species: 'person', seed: 4 }, 'handRight', 'lantern');
    const groups = Kit.creator.rows.groupsOf(editor.schema(lantern));
    const ids = groups.find((group) => group.id === 'accessories').rows.map((row) => row.id);
    assert.strictEqual(ids[ids.indexOf('fill:handRight') + 1], 'fill:handRight/flame', 'the flame socket follows the lantern hand');
    assert.strictEqual(groups.find((group) => group.id === 'accessories').rows.find((row) => row.id === 'fill:handRight/flame').depth, 1);
    const plain = Kit.creator.rows.groupsOf(editor.schema({ species: 'person', seed: 4 }));
    const keyOf = (groupsOf) => Kit.creator.rows.structureKey(groupsOf);
    assert.notStrictEqual(keyOf(groups), keyOf(plain), 'a part with sockets changes the structure');
    const moved = editor.setDial(lantern, 'height', 1.05);
    assert.strictEqual(keyOf(Kit.creator.rows.groupsOf(editor.schema(moved))), keyOf(groups), 'control: a dial value does not change the structure');
    const apart = Kit.creator.rows.groupsOf(editor.schema(lantern), { unlinked: new Set(['eyeSize']) });
    assert.notStrictEqual(keyOf(apart), keyOf(groups), 'unlinking a pair does');
  });
  test('creator rows: readouts, default checks and swatches say what a person sees', () => {
    const slider = { min: 0.8, max: 1.2, step: 0.004, default: 1 };
    assert.strictEqual(Kit.creator.rows.dialReadout(slider, 1), '50');
    assert.strictEqual(Kit.creator.rows.dialReadout(slider, 0.8), '0');
    assert.strictEqual(Kit.creator.rows.dialReadout(slider, 1.2), '100');
    assert.ok(Kit.creator.rows.isAtDefault(slider, 1.0015), 'within half a step counts as the default');
    assert.ok(!Kit.creator.rows.isAtDefault(slider, 1.01), 'control: two and a half steps away does not');
    assert.strictEqual(Kit.creator.rows.swatchGradient(['#000', '#fff']), 'linear-gradient(135deg, #000 0% 50%, #fff 50% 100%)');
    const skin = editor.schema({ species: 'person', seed: 4 }).colors[0];
    const gradient = Kit.creator.rows.swatchGradient(skin.ramps[0].shades);
    assert.ok(skin.ramps[0].shades.every((shade) => gradient.includes(shade)), 'every tone of the ramp is in the swatch');
    const tap = (at, x, y) => ({ at, x, y });
    assert.ok(Kit.creator.rows.isDoubleTap(tap(0, 10, 10), tap(200, 12, 11)), 'two quick taps in one place');
    assert.ok(!Kit.creator.rows.isDoubleTap(tap(0, 10, 10), tap(900, 10, 10)), 'control: too slow');
    assert.ok(!Kit.creator.rows.isDoubleTap(tap(0, 10, 10), tap(200, 120, 10)), 'control: too far apart');
    assert.ok(!Kit.creator.rows.isDoubleTap(null, tap(200, 10, 10)), 'control: nothing before it');
  });

  // ---- session: edits, history, locks, randomise ----

  test('creator session: edits to one control within a short time are one undo step; a pause or another control starts a new one', () => {
    const { session, clock } = makeSession();
    const start = session.recipe();
    [1.02, 1.04, 1.06].forEach((value) => {
      session.setDial('height', value);
      clock.advance(50);
    });
    assert.ok(session.undo(), 'one undo');
    same(session.recipe(), start, 'a whole drag undone in one step');
    assert.ok(!session.canUndo(), 'and nothing more to undo');
    session.redo();
    session.setDial('height', 1.08);
    clock.advance(Kit.creator.MERGE_WINDOW_MS + 500);
    session.setDial('height', 1.1);
    session.undo();
    close(Kit.creator.rows.valuesOf(session.schema())['dial:height'], 1.08, 0.01, 'control: after a pause a new step is made, so undo goes back only to the earlier value');
    session.setDial('build', 1.1);
    session.setDial('height', 1.0);
    session.undo();
    close(Kit.creator.rows.valuesOf(session.schema())['dial:build'], 1.1, 0.01, 'control: another control is another step');
  });
  test('creator session: ending a gesture splits steps, an edit after undo drops the redo, and a no-change edit makes no step', () => {
    const { session } = makeSession();
    session.setDial('height', 1.05);
    session.endGesture();
    session.setDial('height', 1.07);
    session.undo();
    close(Kit.creator.rows.valuesOf(session.schema())['dial:height'], 1.05, 0.01, 'endGesture made two steps');
    assert.ok(session.canRedo());
    session.setColor('skin', 1);
    assert.ok(!session.canRedo(), 'a new edit ends the redo branch');
    const before = session.summary().revision;
    session.setColor('skin', 1);
    assert.strictEqual(session.summary().revision, before, 'control: setting the same value changes nothing');
    assert.ok(session.summary().isChanged, 'and the session knows it differs from the start');
  });
  test('creator session: a locked control survives randomise all, an unlocked one does not', () => {
    const { session } = makeSession();
    session.setColor('skin', 2);
    session.setSocket('hat', 'cap');
    const locksOf = (keys) => keys.forEach((key) => assert.ok(session.isLocked(key)));
    session.toggleLock(['color:skin', 'fill:hat']);
    locksOf(['color:skin', 'fill:hat']);
    const unlockedBefore = Kit.creator.rows.valuesOf(session.schema());
    session.randomizeAll();
    session.randomizeAll();
    const after = Kit.creator.rows.valuesOf(session.schema());
    assert.strictEqual(after['color:skin'], 2, 'the locked colour stayed');
    assert.strictEqual(after['fill:hat'], 'cap', 'the locked hat stayed');
    const changed = Object.keys(after).filter((key) => after[key] !== unlockedBefore[key]);
    assert.ok(changed.length > 10, `control: the unlocked controls were re-rolled (${changed.length} changed)`);
    session.toggleLock(['color:skin', 'fill:hat']);
    assert.ok(!session.isLocked('color:skin'), 'toggling again unlocks');
    const outcomes = [0, 1, 2, 3, 4, 5].map(() => {
      session.randomizeAll();
      return Kit.creator.rows.valuesOf(session.schema())['color:skin'];
    });
    assert.ok(
      outcomes.some((skin) => skin !== 2),
      'control: with the lock removed the skin changes'
    );
  });
  test('creator session: randomise this group changes that group and leaves every other control alone', () => {
    const { session } = makeSession();
    session.setDial('height', 1.07);
    session.setColor('hair', 3);
    const outsideBefore = valuesInGroup(session, 'face', false);
    const insideBefore = valuesInGroup(session, 'face', true);
    session.randomizeGroup('face');
    same(valuesInGroup(session, 'face', false), outsideBefore, 'nothing outside the face moved');
    assert.notDeepStrictEqual(JSON.stringify(valuesInGroup(session, 'face', true)), JSON.stringify(insideBefore), 'control: the face itself changed');
    // Locks still hold inside the group.
    const eyes = valuesInGroup(session, 'face', true)['fill:eyes'];
    session.toggleLock(['fill:eyes']);
    session.randomizeGroup('face');
    session.randomizeGroup('face');
    assert.strictEqual(valuesInGroup(session, 'face', true)['fill:eyes'], eyes, 'a lock inside the group is kept');
    const wholeBefore = Kit.creator.rows.valuesOf(session.schema());
    session.randomizeAll();
    const wholeAfter = Kit.creator.rows.valuesOf(session.schema());
    assert.ok(
      Object.keys(wholeAfter).some((key) => key.startsWith('dial:') && wholeAfter[key] !== wholeBefore[key] && !valuesInGroup(session, 'face', true)[key]),
      'control: randomise all does reach other groups'
    );
  });
  test('creator session: a lock on a control the new body type lacks never breaks a randomise', () => {
    const bigger = extendedCatalog();
    const session = Kit.creator.session({ catalog: bigger, editor: Kit.body.editor(bigger), random: makeRandom([0.2, 0.6]) });
    session.toggleLock(['dial:noggin']);
    session.randomizeAll();
    session.setSpecies('stout');
    session.randomizeAll();
    assert.ok(!session.isLocked('dial:noggin'), 'the lock on the missing dial was dropped with the species change');
    assert.strictEqual(session.recipe().species, 'stout');
  });
  test('creator session: mirror copies one side to the other, and linking an unequal pair undoes cleanly', () => {
    const { session } = makeSession();
    session.setDial('eyeSize@left', 1.3);
    const row = () => session.groups().flatMap((group) => group.rows).find((candidate) => candidate.id === 'dial:eyeSize');
    assert.ok(!row().isLinked, 'a lopsided pair shows as unlinked');
    session.mirror('left');
    const values = Kit.creator.rows.valuesOf(session.schema());
    assert.strictEqual(values['dial:eyeSize@right'], values['dial:eyeSize@left'], 'right now equals left');
    session.undo();
    assert.notStrictEqual(Kit.creator.rows.valuesOf(session.schema())['dial:eyeSize@right'], Kit.creator.rows.valuesOf(session.schema())['dial:eyeSize@left'], 'control: undo restores the difference');
    assert.strictEqual(session.toggleLink('eyeSize'), true, 'toggling an unequal pair links it');
    assert.ok(row().isLinked && row().sliders.length === 1);
    assert.strictEqual(session.toggleLink('eyeSize'), false, 'toggling a linked pair lets the sides part');
    assert.ok(!row().isLinked && row().sliders.length === 2, 'two sliders, same values');
    const stepsBefore = session.summary().revision;
    session.setDial('eyeSize@right', 1.1);
    assert.ok(session.summary().revision > stepsBefore);
    const apartValues = Kit.creator.rows.valuesOf(session.schema());
    assert.ok(apartValues['dial:eyeSize@right'] !== apartValues['dial:eyeSize@left'], 'one side moved alone');
  });
  test('creator session: switching body type keeps what still fits, drops what does not and says which', () => {
    const bigger = extendedCatalog();
    const biggerEditor = Kit.body.editor(bigger);
    let recipe = biggerEditor.setDial({ species: 'person', seed: 9 }, 'noggin', 1.2);
    recipe = biggerEditor.setColor(recipe, 'hair', 2);
    recipe = biggerEditor.setSocket(recipe, 'hat', 'cap');
    const result = Kit.creator.switchSpecies(bigger, recipe, 'stout');
    const values = Kit.creator.rows.valuesOf(biggerEditor.schema(result.recipe));
    assert.strictEqual(result.recipe.species, 'stout');
    same([values['color:hair'], values['fill:hat']], [2, 'cap'], 'colour and hat carried over');
    same(result.dropped, ['dial:noggin'], 'the dial only the base person has was dropped and named');
    assert.ok(result.kept >= 2);
    assert.ok(!('dial:noggin' in values), 'control: the stout body has no such control');
    const back = Kit.creator.switchSpecies(bigger, result.recipe, 'person');
    same(back.dropped, [], 'control: nothing is lost going to a species that holds everything');
    assert.throws(() => Kit.creator.switchSpecies(catalog, { species: 'person', seed: 1 }, 'dragon'), /dragon/, 'an unknown species names itself');
  });
  test('creator session: name, load and baseline: loading a character makes it the new "before"', () => {
    const { session } = makeSession({ name: 'Rowan' });
    assert.strictEqual(session.name(), 'Rowan');
    assert.strictEqual(session.setName('  Ivy   Lane  '), 'Ivy Lane', 'spaces are tidied');
    assert.strictEqual(session.setName('x'.repeat(60)).length, Kit.creator.NAME_LIMIT, 'a long name is cut');
    const start = session.baseline();
    session.setColor('skin', 3);
    same(session.baseline(), start, 'edits do not move the baseline');
    assert.ok(session.summary().isChanged);
    const other = catalog.normalize({ species: 'lanky', seed: 77 });
    session.load(other, 'Tall One');
    same([session.recipe(), session.baseline(), session.name()], [other, other, 'Tall One']);
    assert.ok(!session.summary().isChanged);
    session.undo();
    assert.ok(session.summary().isChanged, 'undo of a load is a change from the new baseline');
    assert.strictEqual(Kit.creator.suggestName(0), Kit.creator.suggestName(0), 'names are repeatable');
    assert.notStrictEqual(Kit.creator.suggestName(0), Kit.creator.suggestName(1), 'and vary with the seed');
  });

  // ---- share codes ----

  test('creator share code: a character round-trips through its code, tolerating pasted spaces and quotes', () => {
    const { session } = makeSession();
    session.setDial('height', 1.07);
    session.setColor('skin', 3);
    session.setSocket('hat', 'beanie');
    const code = session.code();
    assert.ok(/^[A-Za-z0-9_-]+$/.test(code), 'a code is plain URL-safe text');
    const parsed = Kit.creator.parseShareCode(catalog, `  "${code.slice(0, 10)}\n${code.slice(10)}"  `);
    assert.ok(parsed.ok, parsed.message);
    same(parsed.recipe, session.recipe(), 'the pasted code rebuilds the same recipe');
    const { session: other } = makeSession();
    assert.ok(other.importCode(code).ok);
    same(other.recipe(), session.recipe());
    assert.ok(other.canUndo(), 'importing is one undo step');
  });
  test('creator share code: every way a code can be wrong is explained in plain words, and a good code is accepted', () => {
    const code = Kit.creator.shareCode(catalog, editor.setSocket({ species: 'lanky', seed: 5 }, 'hat', 'cap'));
    const problem = (text) => {
      const result = Kit.creator.parseShareCode(catalog, text);
      assert.ok(!result.ok, `"${text}" should be refused`);
      assert.ok(!/Kit\.|\[|undefined|byte \d/.test(result.message), `plain words, not library text: ${result.message}`);
      return result.message;
    };
    assert.ok(Kit.creator.parseShareCode(catalog, code).ok, 'control: the whole code is accepted');
    assert.match(problem(''), /Paste a share code/);
    assert.match(problem('   '), /Paste a share code/);
    assert.match(problem(null), /Paste a share code/);
    assert.match(problem(`${code}!`), /character that does not belong, "!", at place \d+/);
    assert.match(problem(code.slice(0, code.length - 6)), /cut off/);
    assert.match(problem('hello'), /different version of the creator/);
    const made = (...bytes) => Kit.pack.toText(Uint8Array.from(bytes));
    assert.match(problem(made(1, 99, 0, 0, 0, 0)), /body type this creator does not have/);
    assert.match(problem(made(1, 10, 5, 0, 0, 0, 1, 2, 3, 4, 7)), /control that has since been renamed or removed/);
    assert.match(problem(made(1)), /cut off/, 'a code that stops after its first byte');
    assert.ok(Kit.creator.parseShareCode(catalog, made(1, 10, 5, 0, 0, 0)).ok, 'control: the same shape with a real species and no extras is a character');
  });

  // ---- saved characters ----

  /** A store that behaves like `ctx.save`: values are copied in and out as JSON. */
  const makeStore = (initial = {}) => {
    const data = { ...initial };
    return { get: (key, fallback) => (key in data ? JSON.parse(JSON.stringify(data[key])) : fallback), set: (key, value) => (data[key] = JSON.parse(JSON.stringify(value))), data };
  };
  test('creator slots: save, list newest first, update, rename, remove, and survive a reload from the same store', () => {
    const clock = makeClock();
    const store = makeStore();
    const slots = Kit.creator.slots(store, { now: clock.now });
    same(slots.list(), [], 'empty to start');
    const first = slots.save('Mara', 'AAA').slot;
    clock.advance(10);
    const second = slots.save('  Orrin  ', 'BBB').slot;
    same(
      slots.list().map((slot) => [slot.name, slot.code]),
      [
        ['Orrin', 'BBB'],
        ['Mara', 'AAA'],
      ],
      'newest first, names tidied'
    );
    assert.notStrictEqual(first.id, second.id);
    clock.advance(10);
    slots.update(first.id, 'CCC');
    assert.strictEqual(slots.list()[0].id, first.id, 'an updated slot becomes the newest');
    assert.strictEqual(slots.find(first.id).code, 'CCC');
    slots.rename(second.id, 'Orrin Vale');
    assert.strictEqual(slots.find(second.id).name, 'Orrin Vale');
    assert.strictEqual(Kit.creator.slots(store).list().length, 2, 'a second reader sees the same characters');
    assert.ok(slots.remove(first.id));
    assert.ok(!slots.remove(first.id), 'control: removing it again finds nothing');
    assert.strictEqual(slots.update('nope', 'X'), null, 'updating a missing slot is a no-op');
    assert.strictEqual(slots.save('', 'DDD').slot.name, 'Unnamed', 'an empty name gets a stand-in');
  });
  test('creator slots: the list is capped, and a damaged store is ignored rather than trusted', () => {
    const slots = Kit.creator.slots(makeStore(), { most: 2 });
    assert.ok(slots.save('a', 'x').ok && slots.save('b', 'y').ok);
    const refused = slots.save('c', 'z');
    assert.ok(!refused.ok && /Delete one/.test(refused.message), 'a full list says what to do');
    assert.ok(slots.isFull());
    slots.remove(slots.list()[0].id);
    assert.ok(slots.save('c', 'z').ok, 'control: room again after a delete');
    const damaged = Kit.creator.slots(makeStore({ slots: [null, 7, { id: 'a' }, { id: 'ok', name: 'Fine', code: 'Q', savedAt: 1 }] }));
    same(
      damaged.list().map((slot) => slot.id),
      ['ok'],
      'only well-formed rows are listed'
    );
    same(Kit.creator.slots(makeStore({ slots: 'garbage' })).list(), []);
  });
  test('creator slots: a character is shown as colour chips taken from its own ramps', () => {
    const recipe = editor.setColor(editor.setColor({ species: 'person', seed: 3 }, 'skin', 1), 'hair', 4);
    const chips = Kit.creator.chipColors(editor, recipe);
    assert.strictEqual(chips.length, 4);
    assert.ok(chips.every((chip) => /^#[0-9a-f]{6}$/i.test(chip)), 'CSS colours');
    const colors = editor.schema(recipe).colors;
    assert.strictEqual(chips[0], colors.find((color) => color.id === 'skin').ramps[1].shades[2], 'the first chip is the chosen skin ramp, middle tone');
    assert.strictEqual(chips[1], colors.find((color) => color.id === 'hair').ramps[4].shades[2]);
    const other = Kit.creator.chipColors(editor, editor.setColor(recipe, 'skin', 2));
    assert.notStrictEqual(other[0], chips[0], 'control: another skin gives another chip');
  });

  // ---- camera ----

  test('creator camera: choosing a group aims at its body area; a group the table does not know shows the whole body', () => {
    const { director, GROUP_FOCUS, FULL } = Kit.creator.camera;
    const camera = director();
    camera.focus('face');
    same([camera.target().anchor, camera.target().span], [GROUP_FOCUS.face.anchor, GROUP_FOCUS.face.span]);
    camera.focus('legs');
    assert.ok(camera.target().anchor < 0.5, 'legs look low');
    camera.focus('face');
    assert.ok(camera.target().anchor > 0.8, 'control: the face looks high');
    camera.focus('a-group-added-next-month');
    same([camera.target().anchor, camera.target().span], [FULL.anchor, FULL.span], 'unknown group: whole body');
  });
  test('creator camera: zoom is clamped, pinch maths points the right way, and the view eases to its target (or jumps)', () => {
    const { director, pinchFactor, yawFromDrag, MIN_SPAN, MAX_SPAN } = Kit.creator.camera;
    const camera = director();
    for (let press = 0; press < 20; press++) camera.zoomBy(0.7);
    assert.strictEqual(camera.target().span, MIN_SPAN, 'zoom in stops at the limit');
    assert.ok(camera.target().anchor > 0.85, 'zoomed far in with no group chosen, the view has found the head');
    for (let press = 0; press < 20; press++) camera.zoomBy(1 / 0.7);
    assert.strictEqual(camera.target().span, MAX_SPAN, 'zoom out stops at the whole body');
    assert.strictEqual(pinchFactor(100, 200), 0.5, 'fingers apart: smaller span, closer');
    assert.strictEqual(pinchFactor(200, 100), 2);
    assert.strictEqual(pinchFactor(0, 100), 1, 'control: no earlier distance means no change');
    assert.ok(yawFromDrag(90) > 0 && yawFromDrag(-90) < 0);
    camera.zoomTo('close');
    camera.step(1 / 60);
    const halfway = camera.state().span;
    assert.ok(halfway < 1 && halfway > camera.target().span, 'one frame moves partway');
    for (let frame = 0; frame < 120; frame++) camera.step(1 / 60);
    close(camera.state().span, camera.target().span, 0.002, 'and it arrives');
    camera.zoomTo('full');
    camera.step(1 / 60, true);
    assert.strictEqual(camera.state().span, 1, 'instant (reduced motion) jumps');
    const dragged = camera.state().yaw;
    camera.turnBy(0.5);
    close(camera.state().yaw - dragged, 0.5, 1e-9, 'a drag turns at once');
  });
  test('creator camera: the window follows the body: centred on the anchor, narrower when zoomed in, wide enough for the reach', () => {
    const { director } = Kit.creator.camera;
    const measured = { lowestY: 0, highestY: 1.8, reach: 0.6 };
    const camera = director();
    const whole = camera.windowFor(measured, 0.8);
    close(whole.centerY, 0.9, 1e-9, 'whole body is centred on its middle');
    assert.ok(whole.halfHeight * 2 > 1.8, 'the whole body fits in height');
    assert.ok(whole.halfWidth > 0.6, 'and in width');
    camera.zoomTo('close');
    camera.step(1, true);
    const close_ = camera.windowFor(measured, 0.8);
    assert.ok(close_.halfHeight < whole.halfHeight / 2, 'close view is much tighter');
    assert.ok(close_.centerY > 1.5, 'and sits at the head');
    assert.ok(Math.abs(close_.halfWidth / close_.halfHeight - 0.8) < 1e-9, 'with the screen area shape');
    const wide = director().windowFor({ lowestY: 0, highestY: 1.8, reach: 2 }, 0.5);
    assert.ok(wide.halfWidth >= 2, 'control: a body with a long reach widens the whole-body view');
  });
  test('creator camera: bounds put the body in the middle of the free area, at a scale that fills it', () => {
    const { director, boundsFor } = Kit.creator.camera;
    const measured = { lowestY: 0, highestY: 1.8, reach: 0.5 };
    const area = { left: 0, top: 52, width: 390, height: 330 };
    const size = { w: 390, h: 780 };
    const window = director().windowFor(measured, area.width / area.height);
    const bounds = boundsFor(window, area, size);
    const screenX = (worldX) => ((worldX - bounds.left) / (bounds.right - bounds.left)) * size.w;
    const screenY = (worldY) => ((bounds.top - worldY) / (bounds.top - bounds.bottom)) * size.h;
    close(screenX(0), area.left + area.width / 2, 1e-6, 'the axis lands in the middle of the area, sideways');
    close(screenY(0), area.top + area.height / 2, 1e-6, 'the window centre lands in the middle of the area, vertically');
    close(screenY(-window.halfHeight) - screenY(window.halfHeight), area.height, 1e-6, 'and the window fills the area top to bottom');
    close(screenX(window.halfWidth) - screenX(-window.halfWidth), area.width, 1e-6, 'and edge to edge');
    const moved = boundsFor(window, { ...area, top: 200 }, size);
    assert.ok(moved.top > bounds.top, 'control: an area lower on the screen moves the bounds');
  });
};
