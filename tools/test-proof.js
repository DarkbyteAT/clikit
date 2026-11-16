/**
 * Tests of the coverage suites of kit/body-proof.js: pure functions from a catalogue to the cells of a sheet.
 *
 * Owns:  the cases for `Kit.body.proof.suite`. Run through tools/test-kit.js, which hands over its sandbox.
 * Does not own: the screen that draws a sheet or the tool that photographs it (needs a browser).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = ({ Kit, sandbox, test, assert }) => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'body-proof.js'), 'utf8'), sandbox, { filename: 'body-proof.js' });
  const { proof } = Kit.body;
  const catalogs = Object.keys(proof.CATALOGS).map((name) => ({ name, catalog: Kit.body.catalog(proof.CATALOGS[name]()) }));

  test('proof: a turnaround shows every species of every catalogue from eight directions, back included', () => {
    catalogs.forEach(({ name, catalog }) => {
      const sheet = proof.suite('turn', catalog);
      assert.strictEqual(sheet.cells.length, catalog.speciesIds().length * 8, name);
      assert.ok(
        sheet.cells.some((cell) => cell.yaw === 0.5),
        `${name}: the back is shown`
      );
    });
  });
  test('proof: the options suite shows every choice of every socket, from a front, a side and a back view', () => {
    catalogs.forEach(({ name, catalog }) => {
      const editor = Kit.body.editor(catalog);
      const [species] = catalog.speciesIds();
      const choices = editor.schema({ species, seed: 1 }).sockets.reduce((sum, socket) => sum + socket.choices.length, 0);
      assert.strictEqual(proof.suite('options', catalog, { species: [species] }).cells.length, choices * proof.THREE_VIEWS.length, name);
    });
  });
  test('proof: the extremes suite sets each dial to its least and most; rolls are the same every time', () => {
    const { catalog } = catalogs[0];
    const [species] = catalog.speciesIds();
    const dials = Kit.body.editor(catalog).schema({ species, seed: 1 }).dials;
    assert.strictEqual(proof.suite('extremes', catalog, { species: [species] }).cells.length, dials.length * 2);
    assert.strictEqual(JSON.stringify(proof.suite('rolls', catalog, { count: 5 })), JSON.stringify(proof.suite('rolls', catalog, { count: 5 })));
  });
  test('proof: the acts suite lists only what a body can do, in eight phases; unknown names are refused with the choices', () => {
    const samples = catalogs.find((entry) => entry.name === 'samples').catalog;
    const labels = proof
      .suite('acts', samples)
      .cells.map((cell) => cell.label)
      .join('|');
    assert.match(labels, /carp swim 0\/8/, 'a fish swims');
    assert.doesNotMatch(labels, /carp walk/, 'a fish is not asked to walk');
    assert.match(labels, /hound walk 7\/8/, 'a quadruped walks');
    const dives = proof.suite('acts', samples, { species: ['human'], acts: ['dive'] }).cells;
    assert.deepStrictEqual([...new Set(dives.map((cell) => cell.yaw))].join(), '0,0.125', 'a dive goes sideways: it is shown from the front and nearly so');
    assert.doesNotMatch(labels, /save:/, 'the single shots of the saves suite are not movements of their own');
    assert.throws(() => proof.suite('nope', samples), /no suite "nope". Suites: turn, heads, rolls/);
    assert.throws(() => proof.suite('turn', samples, { species: ['dragon'] }), /no species "dragon" in this catalogue. Species: /);
  });
  test('proof: the saves suite shows a goal of shots at contact from behind and from the front, each named by the form chosen; bodies that cannot save are left out', () => {
    const samples = catalogs.find((entry) => entry.name === 'samples').catalog;
    const sheet = proof.suite('saves', samples);
    const shots = proof.GOAL_GRID.across.length * proof.GOAL_GRID.up.length;
    const able = [...new Set(sheet.cells.map((cell) => cell.label.split(' ')[0]))];
    assert.ok(able.includes('human') && !able.includes('hound') && !able.includes('carp'), able.join());
    assert.strictEqual(sheet.cells.length, able.length * shots * 2);
    const human = sheet.cells.filter((cell) => cell.label.startsWith('human behind')).map((cell) => cell.label.split(' ')[2]);
    assert.strictEqual(human[2], 'catchHigh', 'the middle of the top row is jumped for');
    assert.strictEqual(human[7], 'catch');
    assert.strictEqual(human[12], 'smother');
    assert.strictEqual(human[0], 'diveStep');
    assert.ok(sheet.cells.every((cell) => cell.phase === 1 && (cell.yaw === 0.5 || cell.yaw === 0)));
  });

  test('proof: a cell is framed by what its movement sweeps: a dive needs more room than standing, sideways from the front (control: the rest pose)', () => {
    const samples = catalogs.find((entry) => entry.name === 'samples').catalog;
    const bake = samples.bakery().bakeRecipe({ species: 'human', seed: 1 });
    const rest = proof.sweep(bake, 'rest', 0);
    const dive = proof.sweep(bake, 'dive', 0);
    assert.ok(Math.abs(rest.top - rest.restTop) < 1e-9 && rest.right <= rest.restHalf + 1e-9, 'control: at rest the bounds are the rest pose');
    assert.ok(dive.right - dive.left > 1.5 * (rest.right - rest.left), `a dive sweeps wider (${dive.right - dive.left} against ${rest.right - rest.left})`);
    assert.ok(dive.top >= rest.top, 'and no lower than standing');
    const side = proof.sweep(bake, 'dive', 0.25);
    assert.ok(side.right - side.left < dive.right - dive.left, 'seen from the side the same dive is narrower');
    assert.strictEqual(JSON.stringify(proof.sweep(bake, 'dive', 0)), JSON.stringify(dive), 'the same every time');
  });
};
