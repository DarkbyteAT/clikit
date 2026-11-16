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
      assert.ok(sheet.cells.some((cell) => cell.yaw === 0.5), `${name}: the back is shown`);
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
  test('proof: the worn suite turns every choice of the sockets worn round the body through eight directions, and only those sockets', () => {
    const { catalog } = catalogs.find(({ name }) => name === 'wardrobe');
    const editor = Kit.body.editor(catalog);
    const [species] = catalog.speciesIds();
    const sockets = editor.schema({ species, seed: 1 }).sockets;
    const choicesOf = (paths) => sockets.filter((socket) => paths.includes(socket.path)).reduce((sum, socket) => sum + socket.choices.filter((choice) => choice.id).length, 0);
    const sheet = proof.suite('worn', catalog, { species: [species] });
    assert.ok(choicesOf(proof.WORN_SOCKETS) > 0, 'the wardrobe has such sockets');
    assert.strictEqual(sheet.cells.length, choicesOf(proof.WORN_SOCKETS) * proof.DIRECTIONS.length);
    assert.strictEqual(new Set(sheet.cells.slice(0, proof.DIRECTIONS.length).map((cell) => cell.yaw)).size, proof.DIRECTIONS.length, 'one choice, eight directions, the back among them');
    assert.strictEqual(proof.suite('worn', catalog, { species: [species], sockets: ['outerwear'] }).cells.length, choicesOf(['outerwear']) * proof.DIRECTIONS.length, 'the sockets can be chosen');
    assert.strictEqual(proof.suite('worn', catalog, { species: [species], sockets: ['nothing'] }).cells.length, 0, 'the control: a socket the body lacks adds no cells');
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
    const labels = proof.suite('acts', samples).cells.map((cell) => cell.label).join('|');
    assert.match(labels, /carp swim 0\/8/, 'a fish swims');
    assert.doesNotMatch(labels, /carp walk/, 'a fish is not asked to walk');
    assert.match(labels, /hound walk 7\/8/, 'a quadruped walks');
    assert.throws(() => proof.suite('nope', samples), /no suite "nope". Suites: turn, heads, rolls/);
    assert.throws(() => proof.suite('turn', samples, { species: ['dragon'] }), /no species "dragon" in this catalogue. Species: /);
  });
};
