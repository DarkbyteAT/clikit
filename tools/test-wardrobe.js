/**
 * Unit tests for what a rich character creator needs from the body system: the generic surface and region
 * modules, shape and feature dials, sided dials and the symmetry lock, required sockets on rolls, surface
 * features and regions on bakes, control metadata, and the wardrobe catalogue. Loaded by tools/test-body.js
 * (which has already loaded the body files into the sandbox), so these count in the one suite.
 *
 * Owns:  the cases, each with a control that would fail if the logic were wrong.
 * Does not own: the sandbox or the runner (tools/test-kit.js), the core body tests (tools/test-body.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Kit files these tests add to the sandbox, in load order; those that do not exist yet are skipped. */
const FILES = ['surface', 'region'];

module.exports = ({ Kit, sandbox, test, assert }) => {
  FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
  const throwsWith = (action, pattern, message) => assert.throws(action, (error) => pattern.test(error.message) || assert.fail(`${message || 'wrong error'}: ${error.message}`));

  // ---- Kit.surface ----
  test('surface: signed distance per primitive (inside negative, outside positive) and an unknown kind named', () => {
    const frame = { end: [0, 0.4, 0], girth: 0.1 };
    close(Kit.surface.distance({ kind: 'sphere', radius: 0.1, at: [0, 0.2, 0] }, frame, 0, 0.2, 0), -0.1, 1e-9, 'sphere centre');
    close(Kit.surface.distance({ kind: 'box', size: [0.2, 0.2, 0.2] }, frame, 0.3, 0, 0), 0.2, 1e-9, 'box side');
    close(Kit.surface.distance(null, frame, 0.05, 0.2, 0), 0, 1e-9, 'a null shape is a capsule of the girth');
    close(Kit.surface.distance({ kind: 'capsule', taper: 0 }, frame, 0.05, 0.4, 0), 0.05, 1e-9, 'a taper of 0 closes the far end');
    // A cone-ish lathe: radius 0.1 at the bottom, 0 at the top.
    const cone = {
      kind: 'lathe',
      profile: [
        [0.1, 0],
        [0, 0.2],
      ],
    };
    assert.ok(Kit.surface.distance(cone, frame, 0.04, 0.05, 0) < 0, 'inside the cone low down');
    assert.ok(Kit.surface.distance(cone, frame, 0.04, 0.18, 0) > 0, 'control: the same radius near the tip is outside');
    const legFrame = { end: [0, -0.4, 0] };
    assert.ok(Kit.surface.distance(cone, legFrame, 0.04, -0.05, 0) < 0, 'a lathe runs the way its bone runs (down a leg)');
    const blade = {
      kind: 'extrude',
      outline: [
        [-0.02, 0],
        [0.02, 0],
        [0, 0.3],
      ],
      depth: 0.01,
    };
    assert.ok(Kit.surface.distance(blade, frame, 0, 0.1, 0) < 0 && Kit.surface.distance(blade, frame, 0, 0.1, 0.02) > 0, 'extrude: inside the outline, outside past the depth');
    close(Kit.surface.distance({ kind: 'sphere', radius: 0.1, scale: [2, 1, 1] }, frame, 0.19, 0, 0), -0.005, 1e-9, 'scale stretches the solid (distance shrunk by the smallest stretch)');
    throwsWith(() => Kit.surface.distance({ kind: 'torus' }, frame, 0, 0, 0), /unknown shape kind "torus"/);
  });
  test('surface: place finds the surface point and normal at an azimuth and elevation; it follows a reshaped solid', () => {
    const frame = { end: [0, 0.24, 0] };
    const head = { kind: 'sphere', radius: 0.1, at: [0, 0.12, 0] };
    const front = Kit.surface.place(head, frame, 0, 0);
    same(
      front.point.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 0.12, 0.1],
      'straight ahead'
    );
    same(
      front.normal.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 0, 1]
    );
    same(
      front.up.map((value) => Math.round(value * 1e4) / 1e4),
      [0, 1, 0],
      'up is +Y in the tangent plane'
    );
    const left = Kit.surface.place(head, frame, 90, 0);
    close(left.point[0], 0.1, 1e-6, 'azimuth 90 is the left (+X)');
    const above = Kit.surface.place(head, frame, 0, 90);
    close(above.point[1], 0.22, 1e-6, 'elevation 90 is the top');
    same(above.up.map(Math.round), [0, 0, -1], 'on a surface facing up, up falls back to the back');
    // The same eye spot on a head whose front is pushed out: the placement moves with the surface.
    const pushed = Kit.surface.place({ ...head, scale: [1, 1, 1.3] }, frame, 30, 5);
    const plain = Kit.surface.place(head, frame, 30, 5);
    assert.ok(pushed.point[2] > plain.point[2] + 0.012, 'a deeper head puts the eye further forward');
    const lathe = {
      kind: 'lathe',
      profile: [
        [0.06, 0],
        [0.1, 0.1],
        [0.08, 0.2],
        [0, 0.24],
      ],
    };
    const onLathe = Kit.surface.place(lathe, frame, 0, 0);
    close(Kit.surface.distance(lathe, frame, ...onLathe.point), 0, 1e-6, 'the point is on the lathe surface');
    assert.strictEqual(Kit.surface.place({ kind: 'none' }, frame, 0, 0), null, 'nothing to place on');
  });
  test('surface: pairs mirror about their centre; along gives s and the angle around the long axis', () => {
    same(Kit.surface.pair(0, 50), [25, -25]);
    same(Kit.surface.pair(10, 20), [20, 0], 'an off-centre pair');
    const down = { end: [0, -0.4, 0] };
    const sample = Kit.surface.along(down, 0.05, -0.2, 0);
    close(sample[0], 0.5, 1e-9, 'half-way down a leg');
    close(sample[1], Math.PI / 2, 1e-9, 'its left side');
    close(Kit.surface.along(down, 0, -0.1, 0.05)[1], 0, 1e-9, 'its front');
    close(Kit.surface.along({ end: [0, 0, 0.3] }, 0, 0.05, 0.1)[1], 0, 1e-9, 'a bone along z faces up');
    close(Kit.surface.along(down, 0, 0.5, 0)[0], 0, 1e-9, 'clamped above the joint');
    const ring = Kit.surface.ellipse(0, 0, 1, 0.5, 8);
    same([ring.length, ring[0], ring[2].map(Math.round)], [8, [1, 0], [0, 1]]);
    same(Kit.surface.ellipse(0, 0, 1, 1, 4, { from: 180, to: 360 }).length, 5, 'an arc keeps both ends');
  });

  // ---- Kit.region ----
  test('region: bands, stripes, edges and facing tests combine; the topmost layer wins; mistakes are named', () => {
    const FRONT = [0, 0, 1];
    const at = (region, along, angleDegrees = 0, normal = FRONT) => Kit.region.compile(region)(along, (angleDegrees * Math.PI) / 180, ...normal);
    assert.ok(at({ band: { s: [0, 0.6] } }, 0.3) && !at({ band: { s: [0, 0.6] } }, 0.7), 'a sleeve band');
    assert.ok(at({ band: { angle: [150, -150] } }, 0.5, 180) && !at({ band: { angle: [150, -150] } }, 0.5, 0), 'an angle band wraps through the back');
    const stripes = { stripe: { along: 's', count: 4 } };
    assert.ok(at(stripes, 0.1) && !at(stripes, 0.2) && at(stripes, 0.3), 'four stripes, half painted');
    const hairline = { edge: { front: 0.8, back: 0.3, jag: 0.04, count: 6 } };
    assert.ok(!at(hairline, 0.5, 0) && at(hairline, 0.5, 180), 'a hairline sits high at the front, low at the back');
    assert.ok(at({ edge: { front: 0.8, back: 0.3, below: true } }, 0.5, 0), 'below keeps the other side');
    const belly = { facing: { toward: [0, -1, 1], above: 0.5 } };
    assert.ok(at(belly, 0.5, 0, [0, -0.6, 0.8]) && !at(belly, 0.5, 0, [0, 0.6, 0.8]), 'facing forward and down');
    const vest = { mask: { keep: { band: { s: [0, 1] } }, cut: { band: { angle: [-20, 20], s: [0.6, 1] } } } };
    assert.ok(!at(vest, 0.8, 0) && at(vest, 0.8, 90) && at(vest, 0.3, 0), 'a vest is open at the front of the chest only');
    assert.ok(at({ union: [{ band: { s: [0, 0.1] } }, { band: { s: [0.9, 1] } }] }, 0.95) && !at({ intersect: [{ band: { s: [0, 0.5] } }, { band: { s: [0.4, 1] } }] }, 0.3));
    assert.ok(at({ not: { all: true } }, 0.5) === false && at({ checker: { s: 2, angle: 2 } }, 0.1, -170) !== at({ checker: { s: 2, angle: 2 } }, 0.6, -170), 'not, and a checker alternates');
    const layers = [{ test: Kit.region.compile({ all: true }) }, { test: Kit.region.compile({ band: { s: [0, 0.6] } }) }];
    same([Kit.region.at(layers, 0.3, 0, 0, 0, 1), Kit.region.at(layers, 0.8, 0, 0, 0, 1), Kit.region.at([], 0.3, 0, 0, 0, 1)], [1, 0, -1], 'topmost wins; none is -1');
    throwsWith(() => Kit.region.compile({ ring: {} }), /unknown predicate "ring"/);
    throwsWith(() => Kit.region.compile({ band: { s: [0] } }), /"band.s" needs a \[from, to\] pair/);
    throwsWith(() => Kit.region.compile({ band: {}, all: true }), /one \{ predicate: argument \} object/);
    throwsWith(() => Kit.region.compile({ union: [] }), /"union" needs a non-empty list/);
  });
};
