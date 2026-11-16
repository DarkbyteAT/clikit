#!/usr/bin/env node
// Unit tests for the pure kit modules (core, model, flow). Run: node tools/test-kit.js
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const store = {};
const sandbox = { setInterval, clearInterval, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => (store[k] = v) }, console, performance };
sandbox.window = sandbox; // in a browser the global object is window
vm.createContext(sandbox);
for (const f of ['core', 'model', 'flow', 'space', 'hash', 'loot', 'net']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
const Kit = sandbox.Kit;
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} != ${b}`);
const mem = () => { const d = {}; return { get: (k, def) => (k in d ? d[k] : def), set: (k, v) => (d[k] = JSON.parse(JSON.stringify(v))), d }; };
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

test('curve.points interpolates and clamps', () => {
  const c = Kit.curve.of([[0, 2], [10, 4], [20, 10]]);
  near(c(-5), 2, 'below'); near(c(5), 3, 'mid'); near(c(15), 7, 'mid2'); near(c(99), 10, 'above');
});
test('curve.of covers every spec form', () => {
  near(Kit.curve.of(7)(3), 7, 'const');
  near(Kit.curve.of({ base: 10, growth: 2 })(3), 80, 'geometric');
  near(Kit.curve.of({ base: 10, step: 5 })(3), 25, 'linear');
  near(Kit.curve.of({ steps: [[0, 1], [3, 1.5], [6, 2]] })(5), 1.5, 'steps');
  assert.throws(() => Kit.curve.of({ nope: 1 }));
});
test('table rejects duplicate and unknown ids', () => {
  assert.throws(() => Kit.table([{ id: 'a' }, { id: 'a' }]));
  const t = Kit.table([{ id: 'a', v: 1 }]);
  assert.strictEqual(t.byId('a').v, 1);
  assert.throws(() => t.byId('zz'));
});
test('stats: adds then muls, sources replace', () => {
  const s = Kit.stats({ dmg: 10 });
  s.mod('a', { dmg: { add: 5 } }); s.mod('b', { dmg: { mul: 2 } });
  near(s.get('dmg'), 30, 'add then mul');
  s.mod('a', { dmg: { add: 0 } }); near(s.get('dmg'), 20, 'replace');
  s.mod('b', null); near(s.get('dmg'), 10, 'remove');
  near(Kit.stats.scale({ x: { mul: 1.1, add: 2 } }, 3).x.mul, 1.1 ** 3, 'scale mul');
});
test('wallet spends only what it has and persists', () => {
  const save = mem(); const w = Kit.wallet({ coins: 10 }, save);
  assert.strictEqual(w.spend(11), false); assert.strictEqual(w.get(), 10);
  assert.strictEqual(w.spend(4), true); assert.strictEqual(w.get(), 6);
  assert.strictEqual(Kit.wallet({ coins: 0 }, save).get(), 6, 'reload');
});
test('upgrades compose table, curve, stats and wallet', () => {
  const save = mem(); const stats = Kit.stats({ dmg: 1, speed: 4 }); const wallet = Kit.wallet({ coins: 100 }, save);
  const hits = [];
  const rows = [
    { id: 'pick', name: 'Pick', max: 2, cost: { base: 10, growth: 2 }, mods: { dmg: { add: 1 } }, onLevel: (lv) => hits.push(lv) },
    { id: 'boots', name: 'Boots', cost: 1000, mods: { speed: { mul: 1.5 } } },
    { id: 'gem', name: 'Gem', requires: 'boots', cost: 1 },
  ];
  const u = Kit.upgrades(rows, { stats, wallet, save });
  assert.strictEqual(u.cost('pick'), 10); assert.ok(u.buy('pick')); assert.strictEqual(u.cost('pick'), 20);
  near(stats.get('dmg'), 2, 'mods applied'); assert.strictEqual(wallet.get(), 90);
  assert.ok(u.buy('pick')); assert.strictEqual(u.maxed('pick'), true); assert.strictEqual(u.buy('pick'), false, 'maxed');
  assert.strictEqual(u.buy('boots'), false, 'unaffordable'); assert.strictEqual(wallet.get(), 70, 'no charge on refusal');
  assert.strictEqual(u.canBuy('gem'), false, 'locked by requires');
  assert.deepStrictEqual(hits, [1, 2]);
  assert.deepStrictEqual(u.offer(3).map((r) => r.id), ['boots'], 'offer skips maxed and locked');
  const stats2 = Kit.stats({ dmg: 1 });
  Kit.upgrades(rows, { stats: stats2, wallet, save }); near(stats2.get('dmg'), 3, 'levels restored from save');
});
test('goals track events with filters and fire onDone once', () => {
  const done = [];
  const g = Kit.goals([{ id: 'three', text: 'Catch 3', event: 'catch', target: 3 }, { id: 'gold', text: 'Gold star', event: 'catch', when: (p) => p.stars === 3 }], { onDone: (r) => done.push(r.id) });
  g.track('catch', 1, { stars: 1 }); g.track('catch', 1, { stars: 3 }); g.track('catch', 1, { stars: 3 }); g.track('catch', 1, { stars: 3 });
  assert.deepStrictEqual(done, ['gold', 'three']); assert.ok(g.allDone()); assert.strictEqual(g.progress('three'), 3);
});
test('fsm runs enter/update/exit in order', () => {
  const log = [];
  const f = Kit.fsm({ a: { enter: () => log.push('a+'), update: (dt, t) => log.push('a' + t), exit: () => log.push('a-') }, b: { enter: (d) => log.push('b+' + d) } }, 'a');
  f.update(0.5); f.go('b', 7);
  assert.deepStrictEqual(log, ['a+', 'a0.5', 'a-', 'b+7']); assert.throws(() => f.go('zz'));
});
test('spawnTable respects from/until windows', () => {
  const t = Kit.spawnTable([{ id: 'grunt' }, { id: 'brute', from: 30 }, { id: 'intro', until: 5 }]);
  assert.deepStrictEqual(t.active(10).map((r) => r.id), ['grunt']);
  assert.deepStrictEqual(t.active(40).map((r) => r.id), ['grunt', 'brute']);
  assert.ok(['grunt', 'intro'].includes(t.pick(1).id));
  const taught = Kit.spawnTable([{ id: 'x' }], { intro: [{ id: 'first' }, { id: 'second' }] });
  assert.strictEqual([taught.next(0).id, taught.next(0).id, taught.next(0).id].join(), 'first,second,x', 'intro rows come first, in order');
});
test('paths stay bounded and compose', () => {
  const { path } = Kit;
  for (const p of [path.lissajous(1, 2), path.zigzag(), path.weave(), path.darts([[0, 0], [1, 1], [-1, 0.5]])]) {
    for (let t = 0; t < 30; t += 0.37) { const v = p(t); assert.ok(Math.abs(v.x) <= 1.0001 && Math.abs(v.y) <= 1.0001, 'bounded'); }
  }
  const p = path.offset(path.scale(path.circle(1), 2, 3), 10, 0)(0);
  near(p.x, 12, 'scale+offset x'); near(p.y, 0, 'y');
  const seq = path.sequence([[path.point(1, 1), 2], [path.point(-1, -1), 1]]);
  near(seq(0.5).x, 1, 'seq first'); near(seq(2.5).x, -1, 'seq second'); near(seq(3.5).x, 1, 'seq loops');
  near(path.blend(path.point(0, 0), path.point(2, 2), 0.25)(0).x, 0.5, 'blend');
});
test('grid: parse, neighbours, ray, flood, path, world mapping', () => {
  const g = Kit.grid.parse(['S.#.', '..#.', '...E'], { '#': { wall: true }, S: 'start', E: 'end' });
  assert.strictEqual(g.w, 4); assert.strictEqual(g.get(0, 0), 'start'); assert.strictEqual(g.get(9, 9), undefined);
  assert.strictEqual(g.neighbors(0, 0).length, 2);
  const open = (v) => !(v && v.wall);
  assert.strictEqual(g.path({ x: 0, y: 0 }, { x: 3, y: 2 }, open).length, 6, 'shortest path routes round the wall');
  assert.strictEqual(g.path({ x: 0, y: 0 }, { x: 3, y: 0 }, (v, x, y) => open(v) && y < 2), null, 'blocked');
  assert.strictEqual(g.flood(0, 0, (v, x, y) => open(v) && y < 2).length, 4);
  const hit = g.ray(0, 0, 1, 0, (v) => open(v)); assert.strictEqual(hit.x, 2, 'ray stops at wall');
  const w = g.toWorld(3, 2); assert.strictEqual(JSON.stringify(g.fromWorld(w.x, w.z)), '{"x":3,"y":2}'); // objects come from another vm realm
  const snap = g.snapshot(); g.set(0, 0, 'x'); g.restore(snap); assert.strictEqual(g.get(0, 0), 'start');
});
test('line: length, at, resample, simplify, nearest, lasso', () => {
  const L = Kit.line, pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  near(L.length(pts), 20, 'length');
  const p = L.at(pts, 15); near(p.x, 10, 'at x'); near(p.y, 5, 'at y'); near(p.ty, 1, 'tangent');
  near(L.at(pts, 25, true).x, 5, 'loop wraps');
  assert.strictEqual(L.resample(pts, 5).length, 5);
  assert.strictEqual(L.simplify([{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }], 0.1).length, 2);
  const q = L.nearest(pts, { x: 12, y: 4 }); near(q.d, 2, 'nearest d'); near(q.along, 14, 'nearest along');
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0.2 }];
  assert.ok(L.closed(sq, 0.5)); assert.ok(L.contains(sq, { x: 2, y: 2 })); assert.ok(!L.contains(sq, { x: 5, y: 2 }));
});
test('history: undo, redo, branch', () => {
  const hst = Kit.history(); hst.push({ n: 0 }); hst.push({ n: 1 }); hst.push({ n: 2 });
  assert.strictEqual(hst.undo().n, 1); assert.strictEqual(hst.undo().n, 0); assert.strictEqual(hst.undo(), null);
  assert.strictEqual(hst.redo().n, 1); hst.push({ n: 9 }); assert.strictEqual(hst.canRedo(), false); assert.strictEqual(hst.undo().n, 1);
});
test('rng is deterministic per seed and forks independently', () => {
  const a = Kit.rng(42), b = Kit.rng(42), c = Kit.rng(43);
  const seq = (r) => [r.next(), r.int(1, 6), r.pick(['x', 'y', 'z'])].join();
  assert.strictEqual(seq(a), seq(b)); assert.notStrictEqual(seq(Kit.rng(42)), seq(c));
  for (let i = 0; i < 200; i++) { const v = a.int(1, 6); assert.ok(v >= 1 && v <= 6); }
  assert.strictEqual(a.weighted([{ id: 'never', weight: 0 }, { id: 'always', weight: 1 }]).id, 'always');
});
test('loot rolls structured, level-gated, reproducible items', () => {
  const def = {
    rarities: [{ id: 'common', name: 'Common', weight: 70, affixes: 0, mult: 1 }, { id: 'rare', name: 'Rare', weight: 25, affixes: 1, mult: 1.5 }, { id: 'epic', name: 'Epic', weight: 5, affixes: 2, mult: 2 }],
    bases: [{ id: 'cleaver', name: 'Cleaver', slot: 'weapon', mods: { damage: { add: 4 } } }, { id: 'charm', name: 'Charm', slot: 'charm', mods: { speed: { mul: 1.1 } } }, { id: 'late', name: 'Late', slot: 'weapon', from: 10, mods: {} }],
    affixes: [{ id: 'vamp', prefix: 'Vampiric', mods: { leech: { add: 1 } }, slots: ['weapon'] }, { id: 'ember', suffix: 'of Embers', mods: { damage: { mul: 1.2 } } }],
  };
  const a = Kit.loot({ ...def, rng: Kit.rng(7) }), b = Kit.loot({ ...def, rng: Kit.rng(7) });
  const strip = (it) => JSON.stringify({ ...it, uid: 0 });
  for (let i = 0; i < 20; i++) assert.strictEqual(strip(a.roll({ level: 3 })), strip(b.roll({ level: 3 })), 'same seed, same loot');
  for (let i = 0; i < 100; i++) assert.notStrictEqual(a.roll({ level: 1 }).base, 'late', 'level gate');
  const epic = a.roll({ level: 1, slot: 'weapon', rarity: 'epic' });
  assert.strictEqual(epic.name, 'Vampiric Cleaver of Embers'); assert.strictEqual(epic.affixes.length, 2);
  near(epic.mods.damage.add, 4 * 1.15 * 2, 'base scaled by level power and rarity'); near(epic.mods.damage.mul, 1 + 0.2 * 1.15 * 2, 'affix mul scaled');
  assert.strictEqual(a.roll({ slot: 'charm', rarity: 'epic' }).affixes.includes('vamp'), false, 'slot-limited affix');
  const lucky = Kit.loot({ ...def, rng: Kit.rng(1) }); let epics = 0, plain = 0;
  for (let i = 0; i < 400; i++) { if (lucky.roll({ luck: 5 }).rarity === 'epic') epics++; if (lucky.roll({ luck: 0 }).rarity === 'epic') plain++; }
  assert.ok(epics > plain * 2, 'luck favours better rarities');
  assert.ok(a.describe(epic, { damage: 'Damage' }).some((l) => /Damage/.test(l)));
});
test('inventory equips into stats, swaps, compares and persists', () => {
  const save = mem(); const stats = Kit.stats({ damage: 10 });
  const inv = Kit.inventory({ slots: ['weapon'], stats, save, size: 2 });
  const sword = { uid: 'a', slot: 'weapon', mods: { damage: { add: 5 } } }, axe = { uid: 'b', slot: 'weapon', mods: { damage: { add: 8 } } };
  inv.add(sword); inv.add(axe); assert.strictEqual(inv.add({ uid: 'c', slot: 'weapon', mods: {} }), false, 'bag full');
  inv.equip('a'); near(stats.get('damage'), 15, 'equipped');
  near(inv.compare(axe, ['damage']).damage, 3, 'compare'); near(stats.get('damage'), 15, 'compare leaves stats alone');
  inv.equip('b'); near(stats.get('damage'), 18, 'swap'); assert.strictEqual(inv.bag.length, 1); assert.strictEqual(inv.bag[0].uid, 'a');
  const stats2 = Kit.stats({ damage: 10 }); Kit.inventory({ slots: ['weapon'], stats: stats2, save }); near(stats2.get('damage'), 18, 'restored');
});
test('math.sampleWeighted draws distinct rows, skips zero weights and follows the weights', () => {
  const rows = [{ id: 'a', weight: 1 }, { id: 'b', weight: 0 }, { id: 'c', weight: 50 }, { id: 'd' }];
  const all = Kit.math.sampleWeighted(rows, 10);
  assert.strictEqual(all.map((r) => r.id).sort().join(), 'a,c,d', 'each row at most once, weight 0 never, missing weight counts');
  assert.strictEqual(rows.length, 4, 'input untouched'); assert.strictEqual(Kit.math.sampleWeighted(rows, 0).length, 0);
  assert.strictEqual(Kit.math.sampleWeighted([], 3).length, 0);
  let heavyFirst = 0;
  for (let i = 0; i < 400; i++) if (Kit.math.sampleWeighted(rows, 1)[0].id === 'c') heavyFirst++;
  assert.ok(heavyFirst > 340, 'weight 50 of 52 wins most single draws: ' + heavyFirst); // expected 385, 340 is 10 sigma below
  assert.strictEqual(Kit.math.sampleWeighted(rows, 1, (r) => (r.id === 'b' ? 1 : 0))[0].id, 'b', 'custom weightOf wins over row.weight');
});
test('math.rateLimiter passes a key once per gap, per key', () => {
  let now = 10; const ready = Kit.math.rateLimiter(() => now);
  assert.strictEqual(ready('hit', 0.5), true, 'first call passes'); assert.strictEqual(ready('hit', 0.5), false, 'same instant blocked');
  assert.strictEqual(ready('coin', 0.5), true, 'other keys are independent');
  now = 10.49; assert.strictEqual(ready('hit', 0.5), false, 'just inside the gap');
  now = 10.5; assert.strictEqual(ready('hit', 0.5), true, 'exactly the gap passes');
  now = 10.9; assert.strictEqual(ready('hit', 0.5), false, 'the gap restarts from the last pass, not the last attempt');
  assert.strictEqual(ready('hit', 0), true, 'no gap always passes');
});
test('upgrades.offer honours row weights and stays uniform without them', () => {
  const u = Kit.upgrades([{ id: 'new', weight: (level) => (level ? 0 : 1000) }, { id: 'plain' }, { id: 'never', weight: 0 }, { id: 'done', max: 1, weight: 9 }]);
  u.grant('done');
  for (let i = 0; i < 20; i++) assert.strictEqual(u.offer(1)[0].id, 'new', 'heavy unowned row comes first');
  assert.strictEqual(u.offer(5).map((r) => r.id).join(), 'new,plain', 'no zero-weight, no maxed, no repeats');
  u.grant('new');
  assert.strictEqual(u.offer(5).map((r) => r.id).join(), 'plain', 'a weight function sees the current level');
  assert.strictEqual(u.offer(5, (r) => r.id !== 'plain').length, 0, 'filter still applies');
  const flat = Kit.upgrades([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.strictEqual(flat.offer(3).map((r) => r.id).sort().join(), 'a,b,c', 'unweighted tables behave as before');
});
test('upgrades: slots, excludes and requiresMax gate what can be bought and offered', () => {
  const rows = [
    { id: 'fan', slot: 'weapon', max: 2 }, { id: 'lance', slot: 'weapon' }, { id: 'blade', slot: 'weapon' },
    { id: 'rate', max: 1 }, { id: 'glass', excludes: 'plate' }, { id: 'plate' },
    { id: 'storm', requiresMax: ['fan', 'rate'] },
  ];
  const u = Kit.upgrades(rows, { slots: { weapon: 2 } });
  const offered = () => u.offer(9).map((r) => r.id).sort().join();
  assert.strictEqual(offered(), 'blade,fan,glass,lance,plate,rate', 'evolution hidden until both parents are maxed');
  assert.ok(u.buy('fan')); assert.ok(u.buy('lance')); assert.strictEqual(u.slotUse('weapon'), 2);
  assert.strictEqual(u.canBuy('blade'), false, 'a full slot refuses a new row'); assert.strictEqual(u.canBuy('fan'), true, 'but an owned row still levels');
  assert.ok(u.buy('glass')); assert.strictEqual(u.canBuy('plate'), false, 'excluded by an owned row'); assert.strictEqual(u.canBuy('glass'), true, 'the owner itself is unaffected');
  const other = Kit.upgrades(rows); other.buy('plate'); assert.strictEqual(other.canBuy('glass'), false, 'exclusion holds from the unlisted side too');
  assert.ok(other.buy('blade') && other.buy('fan') && other.buy('lance'), 'no slots option means no slot limit');
  u.buy('fan'); assert.strictEqual(u.canBuy('storm'), false, 'one maxed parent is not enough');
  u.buy('rate'); assert.strictEqual(u.canBuy('storm'), true, 'both maxed unlocks the evolution');
  assert.strictEqual(offered(), 'glass,lance,storm', 'offer applies every gate (maxed fan and rate, excluded plate, blocked blade are gone)');
});
test('spatialHash: query visits everything in the touched cells, clear empties, bad cell size is refused', () => {
  const hash = Kit.spatialHash(2);
  const points = [['a', 0.5, 0.5], ['b', 1.9, 1.9], ['c', 2.1, 0.5], ['d', -0.1, -0.1], ['e', 9, 9], ['f', -7.5, 3]];
  points.forEach(([id, x, y]) => hash.insert(id, x, y));
  const near = (x, y, radius) => { const found = []; hash.query(x, y, radius, (id) => found.push(id)); return found.sort().join(); };
  assert.strictEqual(hash.size(), 6);
  assert.strictEqual(near(1, 1, 0.5), 'a,b', 'one cell');
  assert.strictEqual(near(1.5, 0.5, 1), 'a,b,c', 'a query crossing a cell edge sees the neighbour cell');
  assert.strictEqual(near(0, 0, 0.2), 'a,b,d', 'negative coordinates land in their own cells');
  assert.strictEqual(near(-7, 3, 0.4), 'f'); assert.strictEqual(near(30, 30, 1), '', 'empty space');
  // Every point truly within the radius must be among the candidates, whatever the cell layout (brute-force comparison).
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * 14 - 4, y = Math.random() * 14 - 4, radius = Math.random() * 4;
    const truly = points.filter(([, px, py]) => Math.hypot(px - x, py - y) <= radius).map(([id]) => id);
    const candidates = near(x, y, radius).split(',');
    assert.ok(truly.every((id) => candidates.includes(id)), `missed a point within ${radius} of ${x},${y}`);
  }
  hash.clear(); assert.strictEqual(hash.size(), 0); assert.strictEqual(near(1, 1, 5), '', 'cleared');
  hash.insert('g', 1, 1); assert.strictEqual(near(1, 1, 0.1), 'g', 'buckets are reusable after clear');
  assert.throws(() => Kit.spatialHash(0), /cellSize must be a positive/); assert.throws(() => Kit.spatialHash(), /cellSize/);
});
test('upgrades: requires may be a list (skill tree rows)', () => {
  const u = Kit.upgrades([{ id: 'a' }, { id: 'b' }, { id: 'c', requires: ['a', 'b'] }]);
  u.grant('a'); assert.strictEqual(u.unlocked('c'), false); u.grant('b'); assert.strictEqual(u.unlocked('c'), true);
});
test('curve.periodic multiplies every n-th whole step only, honours the offset and reads from a spec', () => {
  const everyFifth = Kit.curve.of({ of: { base: 10, growth: 2 }, every: 5, times: 3, offset: 1 });
  near(everyFifth(3), 80, 'the step before is untouched'); near(everyFifth(4), 480, 'fifth step (n = 4) is tripled'); near(everyFifth(5), 320, 'the step after is untouched');
  near(everyFifth(9), 10 * 2 ** 9 * 3, 'tenth step'); near(everyFifth(3.999), 10 * 2 ** 3.999, 'a fractional step is never periodic');
  const noOffset = Kit.curve.periodic((n) => n + 1, 3, 10);
  near(noOffset(0), 10, 'without an offset step 0 counts'); near(noOffset(1), 2, 'step 1 does not'); near(noOffset(3), 40, 'step 3 does');
  near(Kit.curve.of({ of: 7, every: 2, times: 0 })(2), 0, 'wraps any inner spec, here a constant');
  assert.throws(() => Kit.curve.periodic((n) => n, 0, 2), /positive whole number/); assert.throws(() => Kit.curve.of({ of: 1, every: 2.5, times: 2 }), /positive whole number/);
});
test('stats: limits clamp what get returns, and only for the stats that have one', () => {
  const s = Kit.stats({ crit: 0.9, cooldown: 1, damage: 5 }, { limits: { crit: [0, 1], cooldown: [0.2, Infinity] } });
  s.mod('luck', { crit: { add: 0.5 }, cooldown: { mul: 0.1 }, damage: { mul: 100 } });
  near(s.get('crit'), 1, 'upper limit'); near(s.get('cooldown'), 0.2, 'lower limit'); near(s.get('damage'), 500, 'no limit, no clamp');
  s.mod('curse', { crit: { add: -5 } }); near(s.get('crit'), 0, 'lower limit of the same stat');
  s.mod('curse', null); s.mod('luck', { crit: { add: 0.05 } }); near(s.get('crit'), 0.95, 'inside the limits the value is untouched');
});
test('stats.preview answers "what if this source gave that" without changing or notifying anything', () => {
  const s = Kit.stats({ dmg: 10 }, { limits: { dmg: [0, 100] } });
  s.mod('sword', { dmg: { add: 5 } }); s.mod('rage', { dmg: { mul: 2 } });
  let notified = 0; s.on(() => notified++);
  near(s.preview('dmg', 'sword', { dmg: { add: 15 } }), 50, 'replaces the source, keeps the others');
  near(s.preview('dmg', 'sword', null), 20, 'null previews the source removed');
  near(s.preview('dmg', 'ring', { dmg: { add: 1 } }), 32, 'a source that is not there yet is added');
  near(s.preview('dmg', 'rage', { dmg: { mul: 50 } }), 100, 'previews are clamped like get');
  near(s.get('dmg'), 30, 'the real value is unchanged'); assert.strictEqual(notified, 0, 'no change event');
});
test('upgrades.preview gives the stat at the next (or any) level and leaves level, wallet and stats alone', () => {
  const stats = Kit.stats({ dmg: 1, crit: 0.5 }, { limits: { crit: [0, 1] } }); const wallet = Kit.wallet({ coins: 100 });
  const u = Kit.upgrades([
    { id: 'pick', cost: 10, mods: { dmg: { add: 1, mul: 2 } } },
    { id: 'luck', cost: 10, mods: (lv) => ({ crit: { add: 0.2 * lv } }) },
    { id: 'lamp', cost: 10 },
  ], { stats, wallet });
  near(u.preview('pick', 'dmg'), 4, 'level 1 from level 0: (1 + 1) * 2'); near(stats.get('dmg'), 1, 'nothing applied'); assert.strictEqual(u.level('pick'), 0); assert.strictEqual(wallet.get(), 100);
  u.buy('pick'); near(u.preview('pick', 'dmg'), stats.get('dmg') / 4 * 12, 'level 2: (1 + 2) * 4'); near(u.preview('pick', 'dmg', 1), stats.get('dmg'), 'previewing the current level is the current value');
  near(u.preview('pick', 'dmg', 0), 1, 'level 0 previews the row removed');
  near(u.preview('luck', 'crit', 4), 1, 'function mods work and the stat limit applies'); near(u.preview('pick', 'crit'), 0.5, 'a stat the row does not touch is unchanged');
  near(u.preview('lamp', 'dmg'), stats.get('dmg'), 'a row without mods changes nothing');
  assert.throws(() => Kit.upgrades([{ id: 'a', mods: { x: { add: 1 } } }]).preview('a', 'x'), /needs the `stats` option/);
});
const settle = () => new Promise((r) => setTimeout(r, 5));
const drain = (...ss) => { for (let i = 0; i < 400; i++) ss.forEach((x) => x.tick(0.05)); };
// ---- ballistics + envelope (kit/ballistics.js, Kit.envelope in kit/flow.js) ----
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'ballistics.js'), 'utf8'), sandbox, { filename: 'ballistics.js' });
test('ballistics.direction is a unit vector: yaw 0 looks down -z, positive yaw turns to +x, loft raises it', () => {
  const ahead = Kit.ballistics.direction(0, 0);
  near(ahead.x, 0, 'x'); near(ahead.y, 0, 'y'); near(ahead.z, -1, 'z');
  const aim = Kit.ballistics.direction(0.4, 0.7);
  near(Math.hypot(aim.x, aim.y, aim.z), 1, 'unit length');
  assert.ok(aim.x > 0 && aim.y > 0 && aim.z < 0, 'right, up and away');
  near(Kit.ballistics.direction(1, Math.PI / 2).y, 1, 'straight up');
});
test('ballistics.trace matches the semi-implicit integrator in closed form and stops at the first blocked point', () => {
  const step = 1 / 60, gravity = -20, launch = { origin: { x: 1, y: 2, z: 3 }, velocity: { x: 3, y: 8, z: -12 }, acceleration: { x: 0.5, y: gravity, z: 0 }, step };
  const free = Kit.ballistics.trace({ ...launch, maxSteps: 30 });
  assert.strictEqual(free.points.length, 30); assert.strictEqual(free.isBlocked, false); assert.strictEqual(free.end, free.points[29]);
  // After n velocity-first steps: position = origin + v*n*h + a*h*h*n(n+1)/2 (explicit Euler would give n(n-1)/2).
  const n = 30, drop = (step * step * n * (n + 1)) / 2;
  near(free.end.y, 2 + 8 * n * step + gravity * drop, 'height'); near(free.end.x, 1 + 3 * n * step + 0.5 * drop, 'wind drift'); near(free.end.z, 3 - 12 * n * step, 'range');
  const landed = Kit.ballistics.trace({ ...launch, maxSteps: 600, stopWhen: (point) => point.y < 0 });
  assert.ok(landed.isBlocked && landed.end.y < 0, 'ends on the blocked point');
  assert.ok(landed.points.every((point) => point.y >= 0), 'no free point is inside the obstacle');
  assert.ok(landed.points.length < 600, 'stopped early');
  const walled = Kit.ballistics.trace({ ...launch, stopWhen: () => true });
  assert.strictEqual(walled.points.length, 0); assert.ok(walled.isBlocked);
  near(Kit.ballistics.trace({ origin: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, maxSteps: 1, step: 1 }).end.y, -20, 'default gravity is -20');
});
test('ballistics.sphereTouchesBox grows the box by the radius on every side', () => {
  const box = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } }, touches = Kit.ballistics.sphereTouchesBox;
  assert.ok(touches({ x: 0, y: 1, z: 0 }, 0.1, box), 'centre inside');
  assert.ok(touches({ x: 1.4, y: 1, z: 0 }, 0.5, box), 'overlaps a face');
  assert.ok(!touches({ x: 1.6, y: 1, z: 0 }, 0.5, box), 'clear of the face');
  assert.ok(!touches({ x: 0, y: -0.6, z: 0 }, 0.5, box), 'clear below');
  assert.ok(!touches({ x: 0, y: 1, z: 1.5 }, 0.5, box), 'exactly touching is not overlapping');
});
test('ballistics.blastKick pushes away with linear falloff, lifts, and ignores anything out of reach', () => {
  const centre = { x: 1, y: 1, z: 1 }, blast = { radius: 4, kick: 10 };
  assert.strictEqual(Kit.ballistics.blastKick(centre, { x: 5, y: 1, z: 1 }, blast), null, 'at the edge');
  assert.strictEqual(Kit.ballistics.blastKick(centre, { x: 1, y: 9, z: 1 }, blast), null, 'beyond');
  const half = Kit.ballistics.blastKick(centre, { x: 1, y: 1, z: -1 }, blast);
  near(half.z, -5, 'half strength, away from the centre'); near(half.x, 0, 'no sideways'); near(half.y, 0, 'no lift by default');
  const lifted = Kit.ballistics.blastKick(centre, { x: 3, y: 1, z: 1 }, { ...blast, lift: 0.3 });
  near(lifted.x, 5, 'push'); near(lifted.y, 1.5, 'lift is a share of the falloff-scaled kick');
  const dead = Kit.ballistics.blastKick(centre, centre, blast);
  near(dead.y, 10, 'dead centre goes straight up at full kick'); near(dead.x, 0, 'finite');
});
test('envelope rises while held, relaxes afterwards, and snaps with an infinite rise', () => {
  const push = Kit.envelope({ rise: 7, fall: 7 });
  near(push.update(0.1), 0, 'rests at zero until fired');
  push.fire(1, 0.5);
  const early = push.update(0.1), later = push.update(0.3);
  assert.ok(early > 0 && later > early && later < 1, 'approaches the peak during the hold');
  push.update(0.2); // hold runs out during this step
  const peakValue = push.value, released = push.update(0.1);
  assert.ok(released < peakValue && push.update(0.1) < released, 'falls once the hold is over');
  for (let i = 0; i < 100; i++) push.update(0.1);
  assert.ok(push.value >= 0 && push.value < 1e-6, 'settles at zero without overshooting');
  const kick = Kit.envelope({ rise: Infinity, fall: 6 });
  kick.fire(5);
  near(kick.value, 5, 'snaps to the peak on fire');
  near(kick.update(0), 5, 'a zero-length frame changes nothing (and is not NaN)');
  assert.ok(kick.update(0.1) < 5 && kick.value > 0, 'then decays');
});

// ---- span + blend (kit/span.js, kit/blend.js) ----
for (const f of ['span', 'blend']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
test('span.overlap returns the shared part and null when spans only touch or miss', () => {
  const shared = Kit.span.overlap({ center: 0, size: 4 }, { center: 3, size: 4 });
  near(shared.center, 1.5, 'centre'); near(shared.size, 1, 'size');
  near(Kit.span.overlap({ center: 0, size: 10 }, { center: 1, size: 2 }).size, 2, 'a contained span is returned whole');
  assert.strictEqual(Kit.span.overlap({ center: 0, size: 2 }, { center: 2, size: 2 }), null, 'touching ends');
  assert.strictEqual(Kit.span.overlap({ center: 0, size: 2 }, { center: 9, size: 2 }), null, 'apart');
});
test('span.slice cuts the overhang on the side the piece came from', () => {
  const base = { center: 10, size: 4 };
  const high = Kit.span.slice({ center: 11, size: 4 }, base);
  near(high.kept.center, 10.5, 'kept centre'); near(high.kept.size, 3, 'kept size'); near(high.keptFraction, 0.75, 'fraction');
  assert.strictEqual(high.cuts.length, 1); assert.strictEqual(high.cuts[0].side, 1);
  near(high.cuts[0].center, 12.5, 'cut centre'); near(high.cuts[0].size, 1, 'cut size');
  const low = Kit.span.slice({ center: 9.5, size: 4 }, base);
  assert.strictEqual(low.cuts[0].side, -1); near(low.cuts[0].center, 7.75, 'low cut centre'); near(low.kept.size + low.cuts[0].size, 4, 'nothing is lost');
  assert.strictEqual(high.isPerfect || high.isMiss || low.isPerfect || low.isMiss, false);
});
test('span.slice forgives within the tolerance, trims both ends of a wider piece outside it, and reports misses', () => {
  const base = { center: 0, size: 4 };
  const snapped = Kit.span.slice({ center: 0.2, size: 5 }, base, { tolerance: 0.2 });
  assert.strictEqual(snapped.isPerfect, true); near(snapped.kept.center, 0, 'snaps to the base centre'); near(snapped.kept.size, 5, 'keeps its own width');
  assert.strictEqual(snapped.cuts.length, 0);
  const wide = Kit.span.slice({ center: 0.21, size: 5 }, base, { tolerance: 0.2 });
  assert.strictEqual(wide.isPerfect, false); near(wide.kept.size, 4, 'trimmed to the base');
  assert.strictEqual(wide.cuts.map((cut) => cut.side).join(), '-1,1', 'low side first'); near(wide.cuts[0].size, 0.29, 'low overhang'); near(wide.cuts[1].size, 0.71, 'high overhang');
  const miss = Kit.span.slice({ center: -4.5, size: 4 }, base);
  assert.strictEqual(miss.isMiss, true); assert.strictEqual(miss.kept, null); assert.strictEqual(miss.cuts[0].side, -1); near(miss.cuts[0].size, 4, 'the whole piece falls');
  assert.strictEqual(Kit.span.slice({ center: 3.97, size: 4 }, base, { minKeep: 0.05 }).isMiss, true, 'a sliver is a miss');
  assert.strictEqual(Kit.span.slice({ center: 3.9, size: 4 }, base, { minKeep: 0.05 }).isMiss, false, 'just over the sliver size lands');
});
test('span.wrap folds negatives into the period', () => {
  near(Kit.span.wrap(50, 48), 2, 'above'); near(Kit.span.wrap(-2, 48), 46, 'below'); near(Kit.span.wrap(48, 48), 0, 'exact period');
});
test('blend.hex mixes each channel on its own and clamps the amount', () => {
  assert.strictEqual(Kit.blend.hex(0x000000, 0xffffff, 0.5), 0x808080);
  assert.strictEqual(Kit.blend.hex(0xff0000, 0x0000ff, 0.5), 0x800080, 'red does not leak into green');
  assert.strictEqual(Kit.blend.hex(0x123456, 0xabcdef, 0), 0x123456); assert.strictEqual(Kit.blend.hex(0x123456, 0xabcdef, 1), 0xabcdef);
  assert.strictEqual(Kit.blend.hex(0x123456, 0xabcdef, 7), 0xabcdef, 'clamped above'); assert.strictEqual(Kit.blend.hex(0x123456, 0xabcdef, -1), 0x123456, 'clamped below');
});
test('blend.hsl hits the primaries, greys and wraps the hue', () => {
  assert.strictEqual(Kit.blend.hsl(0, 1, 0.5), 0xff0000); assert.strictEqual(Kit.blend.hsl(1 / 3, 1, 0.5), 0x00ff00); assert.strictEqual(Kit.blend.hsl(2 / 3, 1, 0.5), 0x0000ff);
  assert.strictEqual(Kit.blend.hsl(0.4, 0, 0.5), 0x808080, 'no saturation is grey'); assert.strictEqual(Kit.blend.hsl(1, 1, 0.5), 0xff0000, 'a full turn is red again');
  assert.strictEqual(Kit.blend.hsl(-1 / 3, 1, 0.5), 0x0000ff, 'negative hues wrap'); assert.strictEqual(Kit.blend.hsl(0.2, 1, 1), 0xffffff, 'full lightness is white');
});
test('blend.rows interpolates numbers, mixes named colours and keeps the nearer label', () => {
  const dusk = { id: 'dusk', sky: 0x000000, stars: 0, from: 0 }, night = { id: 'night', sky: 0xffffff, stars: 1, from: 10 };
  const early = Kit.blend.rows(dusk, night, 0.25, { colors: ['sky'] });
  assert.strictEqual(early.sky, 0x404040, 'colour field is mixed per channel, not as one number'); near(early.stars, 0.25, 'number'); assert.strictEqual(early.id, 'dusk');
  assert.strictEqual(Kit.blend.rows(dusk, night, 0.75).id, 'night'); near(Kit.blend.rows(dusk, night, 0.5).sky, 0x7fffff + 0.5, 'an unnamed colour is just a number');
});
test('blend.position is flat inside a row and ramps over the span; blend.along composes it with rows', () => {
  const zones = [{ id: 'a', from: 0, light: 1 }, { id: 'b', from: 10, light: 3 }, { id: 'c', from: 20, light: 7 }];
  const at = Kit.blend.position(zones, { span: 4 });
  near(at(-3), 0, 'before the table'); near(at(9.9), 0, 'flat inside the first row'); near(at(12), 0.5, 'half way through the change');
  near(at(14), 1, 'change complete'); near(at(19), 1, 'flat again'); near(at(99), 2, 'clamped to the last row');
  const linear = Kit.blend.along(zones, { span: 4, ease: (amount) => amount });
  near(linear(11).light, 1.5, 'quarter of the way from 1 to 3'); near(linear(99).light, 7, 'last row'); assert.strictEqual(linear(5).id, 'a');
  near(Kit.blend.along(zones, { span: 4 })(11).light, 1 + 2 * Kit.blend.smooth(0.25), 'default ease is smoothstep');
});

const atest = (name, fn) => (pending = pending.then(fn).then(() => { n++; console.log('  ok  ' + name); }));
let pending = Promise.resolve();
atest('net: peers converge, last writer wins, deletes propagate', async () => {
  const hub = Kit.net.loopback(); const a = Kit.net.session(hub.join('a')), b = Kit.net.session(hub.join('b'));
  const heard = []; b.on('token/', (k, v, from) => heard.push(k + '=' + JSON.stringify(v) + '@' + from.peer));
  a.set('token/1', { x: 1 }); b.set('token/1', { x: 2 }); a.set('scene', 'cave'); drain(a, b);
  assert.strictEqual(JSON.stringify(a.get('token/1')), JSON.stringify(b.get('token/1')), 'same value on both');
  assert.strictEqual(b.get('scene'), 'cave'); assert.ok(heard.includes('token/1={"x":1}@a'));
  a.delete('scene'); drain(a, b); assert.strictEqual(b.has('scene'), false); assert.strictEqual(b.keys('token/').length, 1);
});
atest('net: late joiner gets a snapshot without a store', async () => {
  const hub = Kit.net.loopback(); const a = Kit.net.session(hub.join('a'));
  for (let i = 0; i < 30; i++) a.set('k' + i, i); drain(a);
  const c = Kit.net.session(hub.join('c')); await c.ready; drain(a, c);
  assert.strictEqual(c.keys().length, 30); assert.strictEqual(c.get('k29'), 29);
});
atest('net: durable store heals a lossy fast path and survives everyone leaving', async () => {
  let seed = 3; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hub = Kit.net.loopback({ drop: 0.6, store: true, rng });
  const a = Kit.net.session(hub.join('a')), b = Kit.net.session(hub.join('b')); await a.ready; await b.ready;
  for (let i = 0; i < 40; i++) (i % 2 ? a : b).set('k' + (i % 10), i); drain(a, b); await settle();
  for (let i = 0; i < 10; i++) assert.strictEqual(a.get('k' + i), b.get('k' + i), 'k' + i);
  a.close(); b.close();
  const late = Kit.net.session(hub.join('late')); await late.ready; assert.strictEqual(late.get('k9'), 39);
});
atest('net: validate is enforced by every receiver, sender identity comes from the transport', async () => {
  const hub = Kit.net.loopback();
  const rule = (key, value, from) => !key.startsWith('map/') || from.by === 'gm';
  const gm = Kit.net.session(hub.join('p1', { by: 'gm' }), { validate: rule }), player = Kit.net.session(hub.join('p2', { by: 'sam' }), { validate: rule });
  player.set('map/wall', 'gone'); gm.set('map/door', 'open'); drain(gm, player);
  assert.strictEqual(gm.get('map/wall'), undefined, 'GM ignores a player map edit'); assert.strictEqual(player.get('map/door'), 'open');
});
atest('net: events, presence and the size guard', async () => {
  const hub = Kit.net.loopback(); const a = Kit.net.session(hub.join('a')), b = Kit.net.session(hub.join('b'));
  const got = []; b.onEvent('roll', (d, from) => got.push(d.total + from.peer)); a.onEvent('roll', (d, from) => got.push('self' + from.isMe));
  a.emit('roll', { total: 17 }); drain(a, b); assert.strictEqual(got.sort().join(), '17a,selftrue');
  let seen = []; b.onPeers((ps) => (seen = ps)); a.presence({ cursor: [1, 2] });
  assert.strictEqual(JSON.stringify(seen.find((p) => p.peer === 'a').presence.cursor), '[1,2]');
  assert.throws(() => a.set('big', 'x'.repeat(5000)), /too large/);
});
// ---- puzzle: beam tracer, shortest-solution search, level progress (kit/puzzle.js) ----
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'puzzle.js'), 'utf8'), sandbox, { filename: 'puzzle.js' });
{
  // Shared fixtures: one emitter character per heading, both mirror slants, both splitter slants, a filter, a wall and two targets.
  const LEGEND = {
    '/': { kind: 'mirror', slant: 0 }, '\\': { kind: 'mirror', slant: 1 }, '%': { kind: 'splitter', slant: 0 }, '&': { kind: 'splitter', slant: 1 },
    r: { kind: 'filter', color: 'red' }, '#': { kind: 'wall' }, '*': { kind: 'target', needs: null }, R: { kind: 'target', needs: 'red' },
    '>': { kind: 'lamp', dir: 0 }, v: { kind: 'lamp', dir: 1 }, '<': { kind: 'lamp', dir: 2 }, '^': { kind: 'lamp', dir: 3 },
  };
  const OPTICS = { mirror: Kit.beam.optics.mirror, splitter: Kit.beam.optics.splitter, filter: Kit.beam.optics.filter, wall: Kit.beam.optics.block, lamp: Kit.beam.optics.block };
  const lights = (cell, color) => !!cell && cell.kind === 'target' && (cell.needs === null || cell.needs === color);
  const shine = (rows) => {
    const grid = Kit.grid.parse(rows, LEGEND);
    const lamps = grid.find((cell) => !!cell && cell.kind === 'lamp').map(({ x, y, v }) => ({ x, y, dir: v.dir, color: 'white' }));
    return Kit.beam.trace(grid, lamps, { optics: OPTICS, lights });
  };
  const litCells = (result) => result.lit.map((cell) => `${cell.x},${cell.y}`).sort().join(' ');
  // Values built inside the vm sandbox have another realm's prototypes, so compare them by their JSON form.
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const run = (segment) => `${segment.from.x},${segment.from.y}>${segment.to.x},${segment.to.y}`;

  test('beam.reflect: both slants turn all four headings, and reflecting twice restores the heading', () => {
    same([0, 1, 2, 3].map((dir) => Kit.beam.reflect(dir, 0)), [3, 2, 1, 0], '"/": east<->north, south<->west');
    same([0, 1, 2, 3].map((dir) => Kit.beam.reflect(dir, 1)), [1, 0, 3, 2], '"\\": east<->south, west<->north');
    [0, 1].forEach((slant) => [0, 1, 2, 3].forEach((dir) => assert.strictEqual(Kit.beam.reflect(Kit.beam.reflect(dir, slant), slant), dir)));
  });
  test('beam.trace: mirrors bend the beam, targets are transparent, runs report start, length and leaving', () => {
    const result = shine(['>.*\\', '....', '*../']);
    same(result.segments.map(run), ['0,0>3,0', '3,0>3,2', '3,2>0,2'], 'east, down the "\\" mirror, west off the "/" mirror');
    same(result.segments.map((segment) => [segment.start, segment.length, segment.leaves]), [[0, 3, false], [3, 2, false], [5, 3, true]]);
    assert.strictEqual(litCells(result), '0,2 2,0', 'the target in mid-run and the one on the last cell both light');
    same(result.lit.map((cell) => cell.distance).sort(), [2, 8], 'distance counts cells from the lamp');
    assert.strictEqual(shine(['>.*/']).segments[1].length, 0, 'a mirror on the top row sends the beam straight off: a zero-length run');
  });
  test('beam.trace: walls absorb, and nothing behind them lights', () => {
    const result = shine(['>.#*']);
    same(result.segments.map(run), ['0,0>2,0']); assert.strictEqual(result.segments[0].leaves, false); assert.strictEqual(result.lit.length, 0);
  });
  test('beam.trace: a splitter passes the beam on and reflects a copy', () => {
    const result = shine(['..*.', '>.%*', '..*.']);
    same(result.segments.map(run).sort(), ['0,1>2,1', '2,1>2,0', '2,1>3,1'], 'straight on east plus a branch north');
    assert.strictEqual(litCells(result), '2,0 3,1', 'the south target stays dark: a "/" splitter does not send eastbound light south');
    assert.strictEqual(litCells(shine(['..*.', '>.&*', '..*.'])), '2,2 3,1', 'the other slant lights the south one instead');
  });
  test('beam.trace: filters tint what passes; a coloured target needs its colour, a plain one takes any', () => {
    const result = shine(['>R*rR*']);
    assert.strictEqual(litCells(result), '2,0 4,0 5,0', 'the red target before the filter stays dark; the one after it and both plain ones light');
    same(result.segments.map((segment) => segment.color), ['white', 'red']);
    assert.strictEqual(result.lit.find((cell) => cell.x === 2).color, 'white', 'a cell is reported with the first light that lit it');
  });
  test('beam.trace: a closed loop of mirrors terminates and every run is reported once', () => {
    // The splitter feeds a ring of four mirrors; light circling the ring returns to the splitter forever.
    const result = shine(['./.\\', '>&.*', '.\\./']);
    assert.ok(result.segments.length <= 12, `finite: ${result.segments.length} runs`);
    assert.strictEqual(new Set(result.segments.map((segment) => run(segment) + segment.dir)).size, result.segments.length, 'no run is traced twice');
    assert.strictEqual(litCells(result), '3,1');
    const twoLamps = shine(['>.<']);
    same(twoLamps.segments.map(run), ['0,0>2,0', '2,0>0,0'], 'two lamps facing each other absorb each other');
  });
  test('search.shortest: fewest moves, already solved, unreachable and the explored limit', () => {
    const problem = { start: 1, keyOf: String, isGoal: (value) => value === 10, movesOf: (value) => (value > 40 ? [] : [{ move: '+1', state: value + 1 }, { move: 'x2', state: value * 2 }]) };
    same(Kit.search.shortest(problem).moves, ['+1', 'x2', '+1', 'x2'], '1 -> 2 -> 4 -> 5 -> 10');
    same(Kit.search.shortest({ ...problem, start: 10 }).moves, [], 'no moves when the start is the goal');
    assert.strictEqual(Kit.search.shortest({ ...problem, isGoal: (value) => value === -1 }), null, 'unreachable goal');
    assert.strictEqual(Kit.search.shortest({ ...problem, limit: 3 }), null, 'gives up at the limit instead of hanging');
  });
  test('levels: stars against par, unlock order, best score only improves, persistence', () => {
    same([3, 4, 5, 6, 7, 20].map((moves) => Kit.levels.rate(moves, 4)), [3, 3, 2, 2, 1, 1], 'par or better, within two, anything else');
    assert.strictEqual(Kit.levels.rate(5, 4, [0, 1, 3]), 3, 'custom slack gives four tiers');
    assert.strictEqual(Kit.levels.starText(2), '★★☆'); assert.strictEqual(Kit.levels.starText(0, 2), '☆☆');
    const save = mem(); const rows = [{ id: 'a', name: 'A', par: 2 }, { id: 'b', name: 'B', par: 5 }, { id: 'c', name: 'C', par: 1 }];
    const progress = Kit.levels(rows, { save }); let changes = 0; progress.on(() => changes++);
    same(rows.map((row) => progress.isUnlocked(row.id)), [true, false, false], 'only the first level starts open');
    assert.strictEqual(progress.firstOpen(), 'a'); assert.strictEqual(progress.stars('a'), 0); assert.strictEqual(progress.best('a'), null);
    same(progress.complete('a', 4), { stars: 2, isBest: true, newMedals: [] }); assert.strictEqual(progress.isUnlocked('b'), true); assert.strictEqual(progress.isUnlocked('c'), false);
    same(progress.complete('a', 9), { stars: 1, isBest: false, newMedals: [] }, 'a worse replay reports its own stars');
    assert.strictEqual(progress.best('a'), 4, 'but does not overwrite the record'); assert.strictEqual(progress.stars('a'), 2);
    progress.complete('a', 2); assert.strictEqual(progress.stars('a'), 3); assert.strictEqual(changes, 2, 'listeners hear records only');
    const reloaded = Kit.levels(rows, { save }); assert.strictEqual(reloaded.best('a'), 2, 'reload'); assert.strictEqual(reloaded.firstOpen(), 'b');
    reloaded.complete('b', 5); reloaded.complete('c', 1); assert.strictEqual(reloaded.totalStars(), 9); assert.strictEqual(reloaded.firstOpen(), 'c', 'all done: stay on the last');
    assert.throws(() => progress.complete('zz', 1), /no row/);
  });
  test('beam.trace: passes report every colour through a target; one-way glass passes one heading only', () => {
    // Two lamps cross at the target: white along the row, red (through the filter) down the column.
    const crossing = Kit.grid.parse(['.v.', '.r.', '>*.'], LEGEND);
    const result = Kit.beam.trace(crossing, [{ x: 0, y: 2, dir: 0, color: 'white' }, { x: 1, y: 0, dir: 1, color: 'white' }], { optics: OPTICS, lights: (cell) => !!cell && cell.kind === 'target' });
    same([...result.passes].map((pass) => pass.color).sort(), ['red', 'white'], 'both colours are reported for the one cell');
    assert.strictEqual(result.lit.length, 1, 'while lit still lists the cell once');
    const gate = { optics: { glass: Kit.beam.optics.oneWay }, lights: (cell) => cell === 'goal' };
    const row = Kit.grid.parse(['.g.T'], { g: { kind: 'glass', dir: 0 }, T: 'goal' }, {});
    assert.strictEqual(Kit.beam.trace(row, [{ x: 0, y: 0, dir: 0, color: 1 }], { ...gate, kindOf: (cell) => cell && cell.kind }).lit.length, 1, 'eastbound light passes east-facing glass');
    const blocked = Kit.beam.trace(row, [{ x: 2, y: 0, dir: 2, color: 1 }], gate);
    same([...blocked.segments].map(run), ['2,0>1,0'], 'westbound light stops at it');
  });
  test('search.difficulty and search.generate: first accepted candidate, hardest fallback, nothing unsolvable', () => {
    assert.strictEqual(Kit.search.difficulty({ moves: ['a', 'b', 'c'], explored: 64 }), 9);
    // Candidates are target numbers for the +1 / x2 puzzle; attempt n proposes n, and -1 is unreachable.
    const solveFor = (target) => Kit.search.shortest({ start: 1, keyOf: String, isGoal: (value) => value === target, movesOf: (value) => (value > 40 ? [] : [{ move: '+1', state: value + 1 }, { move: 'x2', state: value * 2 }]) });
    const proposed = [];
    const found = Kit.search.generate({ propose: (attempt) => (proposed.push(attempt), attempt === 2 ? null : attempt), solve: solveFor, accept: (solution) => solution.moves.length >= 3 });
    assert.strictEqual(found.puzzle, 5, '5 is the first target needing three moves (1 -> 2 -> 4 -> 5)'); assert.strictEqual(found.isAccepted, true);
    same(proposed, [0, 1, 2, 3, 4, 5], 'stops proposing once one is accepted; a null proposal is skipped');
    const fallback = Kit.search.generate({ propose: (attempt) => attempt + 1, solve: solveFor, accept: () => false, attempts: 7 });
    assert.strictEqual(fallback.isAccepted, false); assert.strictEqual(fallback.puzzle, 7, 'the hardest solvable candidate seen (1 -> 2 -> 3 -> 6 -> 7)');
    assert.strictEqual(Kit.search.generate({ propose: () => -1, solve: solveFor, attempts: 3 }), null, 'never returns an unsolved puzzle');
    assert.strictEqual(Kit.search.generate({ propose: () => 1, solve: solveFor, accept: () => true, attempts: 2 }), null, 'an already-solved candidate is never a puzzle, even as a fallback');
    assert.strictEqual(Kit.search.generate({ propose: () => 2, solve: solveFor }).isAccepted, true, 'by default any candidate that needs a move is accepted');
  });
  test('levels: medals accumulate across attempts and persist; dayNumber is a UTC day count', () => {
    const save = mem(); const progress = Kit.levels([{ id: 'a', name: 'A', par: 2 }], { save });
    same(progress.complete('a', 5, ['tidy']).newMedals, ['tidy']); same(progress.complete('a', 6, ['tidy', 'spare']).newMedals, ['spare'], 'only medals not held before are new');
    same(progress.medals('a'), ['tidy', 'spare']); assert.strictEqual(progress.best('a'), 5, 'a worse score can still earn a medal without touching the record');
    same(Kit.levels([{ id: 'a', name: 'A', par: 2 }], { save }).medals('a'), ['tidy', 'spare'], 'reload');
    same(progress.complete('a', 9).newMedals, [], 'medals are optional');
    assert.strictEqual(Kit.levels.dayNumber(0), 0); assert.strictEqual(Kit.levels.dayNumber(86400000 - 1), 0); assert.strictEqual(Kit.levels.dayNumber(86400000 * 3 + 5), 3);
  });
}
// ---- music, placement, bodies (kit/music.js, kit/place.js, kit/bodies.js; bodies run against the real cannon.js) ----
const loadKitFile = (relativePath) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), sandbox, { filename: path.basename(relativePath) });
['kit/music.js', 'kit/place.js', 'vendor/cannon.min.js', 'kit/physics.js', 'kit/bodies.js'].forEach(loadKitFile);
// ---- loadout (kit/loadout.js) and physics surfaces (kit/physics.js, against the real cannon.js) ----
loadKitFile('kit/loadout.js');
test('loadout: swaps are charged against the budget, a refused swap changes nothing, cycle skips what does not fit', () => {
  const cost = { heavy: 1, splitter: 2, bomb: 3 };
  const loadout = Kit.loadout({ slots: 3, budget: 5, costOf: (id) => cost[id], initial: ['heavy', 'heavy', 'heavy'] });
  assert.strictEqual(loadout.spent(), 3); assert.strictEqual(loadout.left(), 2);
  assert.strictEqual(loadout.place(0, 'bomb'), true, '3 + 1 + 1 fits exactly');
  assert.strictEqual(loadout.place(1, 'splitter'), false, '3 + 2 + 1 is over budget');
  assert.strictEqual(loadout.picks().join(), 'bomb,heavy,heavy', 'a refused swap leaves the slot alone');
  assert.strictEqual(loadout.cycle(1, ['heavy', 'splitter', 'bomb']), 'heavy', 'nothing dearer fits, so the pick stays');
  assert.strictEqual(loadout.place(0, 'splitter'), true, 'a cheaper swap always fits');
  assert.strictEqual(loadout.cycle(1, ['heavy', 'splitter', 'bomb']), 'splitter', 'cycle takes the next id that fits');
  assert.strictEqual(loadout.cycle(1, ['heavy', 'splitter', 'bomb']), 'heavy', 'and wraps past the bomb it cannot afford');
  assert.strictEqual(loadout.place(2, null), true); assert.strictEqual(loadout.filled().join(), 'splitter,heavy', 'empty slots are skipped');
  assert.strictEqual(loadout.place(3, 'heavy'), false, 'no such slot'); assert.strictEqual(loadout.cycle(-1, ['heavy']), null);
});
test('loadout: reports changes and refuses impossible setups with the cause', () => {
  const seen = [];
  const loadout = Kit.loadout({ slots: 2, budget: 2, costOf: () => 1 });
  loadout.on((change) => seen.push(change.slot + ':' + change.id));
  loadout.place(1, 'a'); loadout.place(1, 'a'); loadout.place(5, 'a');
  assert.strictEqual(seen.join(), '1:a,1:a', 'only placements that happened are announced');
  assert.throws(() => Kit.loadout({ slots: 2, budget: 1, costOf: () => 1, initial: ['a', 'a'] }), /cost 2 but the budget is 1/);
  assert.throws(() => Kit.loadout({ slots: 0, budget: 1, costOf: () => 1 }), /positive whole number/);
  assert.throws(() => Kit.loadout({ slots: 1, budget: 1 }), /costOf/);
});
test('physics surfaces: a declared pair bounces, an undeclared pair keeps the world default', () => {
  const reboundHeight = (floorSurface) => {
    const phys = Kit.physics({ gravity: -10, restitution: 0 });
    const floorBody = phys.floor(0), ball = phys.sphere(null, 0.5, { mass: 1, at: [0, 3, 0] });
    phys.surface(ball, 'ball'); phys.surface(floorBody, floorSurface);
    phys.contact('ball', 'bumper', { restitution: 0.8 });
    let hasLanded = false, peak = 0;
    for (let frame = 0; frame < 240; frame++) {
      phys.step(1 / 60);
      if (ball.velocity.y > 0) hasLanded = true;
      if (hasLanded) peak = Math.max(peak, ball.position.y);
    }
    return peak;
  };
  assert.ok(reboundHeight('bumper') > 1.5, 'springs back most of the way from a 2.5 unit drop');
  assert.ok(reboundHeight('plain') < 0.7, 'no declared pair: the ball stays down (resting height is 0.5)');
});

test('music: note names, tuning and labels', () => {
  assert.strictEqual(Kit.music.noteToMidi('A4'), 69); assert.strictEqual(Kit.music.noteToMidi('C4'), 60);
  assert.strictEqual(Kit.music.noteToMidi('C#5'), 73); assert.strictEqual(Kit.music.noteToMidi('Bb3'), 58, 'flat');
  assert.strictEqual(Kit.music.noteToMidi('c-1'), 0, 'lower case and negative octave');
  near(Kit.music.noteToFreq('A4'), 440, 'concert pitch'); near(Kit.music.noteToFreq('A5'), 880, 'octave doubles');
  assert.ok(Math.abs(Kit.music.noteToFreq('C4') - 261.6256) < 1e-3, 'middle C');
  assert.strictEqual(Kit.music.midiToNote(61), 'C#4'); assert.strictEqual(Kit.music.midiToNote(0), 'C-1');
  assert.throws(() => Kit.music.noteToMidi('H2'), /not a note name/); assert.throws(() => Kit.music.noteToMidi('A'), /not a note name/);
});
test('music: scale degrees wrap into higher and lower octaves', () => {
  const chime = Kit.music.scale('C4', 'pentatonic');
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map(chime.noteName), ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5']);
  assert.strictEqual(chime.noteName(-1), 'A3', 'negative degree descends'); assert.strictEqual(chime.midi(-5), 48, 'a full octave down');
  near(chime(5), 2 * chime(0), 'degree one octave up doubles the frequency');
  assert.strictEqual(Kit.music.scale(57, [0, 7]).noteName(3), 'E5', 'custom intervals and a MIDI root');
  assert.throws(() => Kit.music.scale('C4', 'nope'), /unknown scale/);
});
test('placement: a drag resolves to place, move, remove, tap or cancel', () => {
  // A 3x2 board in point space (cells are unit squares from the origin); the tray is the strip y >= 5.
  const board = new Map([['1,0', { kind: 'ramp' }]]);
  const keyOf = (cell) => cell.x + ',' + cell.y;
  const drag = Kit.placement({
    cellAt: (point) => (point.x >= 0 && point.x < 3 && point.y >= 0 && point.y < 2 ? { x: Math.floor(point.x), y: Math.floor(point.y) } : null),
    trayKindAt: (point) => (point.y >= 5 ? 'bell' : null),
    pieceAt: (cell) => board.get(keyOf(cell)),
    canPlace: (kind, cell) => !(kind === 'bell' && cell.y === 1), // bells are barred from the bottom row
    tapSlop: 0.2,
  });
  const gesture = (from, to) => (drag.begin(from), drag.move(to), drag.end(to));
  assert.strictEqual(drag.begin({ x: 9, y: 0.5 }), null, 'press on nothing holds nothing'); assert.strictEqual(drag.end({ x: 0.5, y: 0.5 }), null);
  const placed = gesture({ x: 0.5, y: 5.5 }, { x: 2.5, y: 0.5 });
  assert.strictEqual(placed.type, 'place'); assert.deepStrictEqual(placed.cell, { x: 2, y: 0 }); assert.strictEqual(placed.held.kind, 'bell');
  assert.strictEqual(gesture({ x: 0.5, y: 5.5 }, { x: 1.5, y: 0.5 }).type, 'cancel', 'occupied cell refuses a tray piece');
  assert.strictEqual(gesture({ x: 0.5, y: 5.5 }, { x: 0.5, y: 1.5 }).type, 'cancel', 'canPlace rule refuses');
  assert.strictEqual(gesture({ x: 0.5, y: 5.5 }, { x: 7, y: 3 }).type, 'cancel', 'tray piece dropped off the board');
  const tapped = gesture({ x: 1.5, y: 0.5 }, { x: 1.55, y: 0.5 });
  assert.strictEqual(tapped.type, 'tap'); assert.deepStrictEqual(tapped.cell, { x: 1, y: 0 });
  const moved = gesture({ x: 1.5, y: 0.5 }, { x: 0.5, y: 1.5 });
  assert.strictEqual(moved.type, 'move'); assert.deepStrictEqual(moved.held.from, { x: 1, y: 0 }); assert.deepStrictEqual(moved.cell, { x: 0, y: 1 });
  assert.strictEqual(gesture({ x: 1.5, y: 0.5 }, { x: 1.5, y: -3 }).type, 'remove', 'board piece dragged off the board');
  drag.begin({ x: 1.5, y: 0.5 }); drag.move({ x: 2.5, y: 1.5 });
  assert.strictEqual(drag.end({ x: 1.5, y: 0.5 }).type, 'cancel', 'dragged away and back is not a tap');
  assert.strictEqual(drag.begin({ x: 1.5, y: 0.5 }).source, 'board'); assert.strictEqual(drag.move({ x: 2.4, y: 0.5 }).isValid, true);
  drag.cancel(); assert.strictEqual(drag.held, null); assert.strictEqual(drag.move({ x: 0, y: 0 }), null);
});
test('placement: canLift pins level pieces in place while their cell stays occupied', () => {
  const pinned = { kind: 'wall', fixed: true }, loose = { kind: 'ramp' };
  const cells = new Map([['0,0', pinned], ['1,0', loose]]);
  const drag = Kit.placement({
    cellAt: (point) => (point.y < 1 && point.x >= 0 && point.x < 3 ? { x: Math.floor(point.x), y: 0 } : null),
    trayKindAt: (point) => (point.y >= 5 ? 'bell' : null),
    pieceAt: (cell) => cells.get(cell.x + ',' + cell.y),
    canLift: (piece) => !piece.fixed,
  });
  assert.strictEqual(drag.begin({ x: 0.5, y: 0.5 }), null, 'a pinned piece cannot be picked up'); assert.strictEqual(drag.end({ x: 2.5, y: 0.5 }), null);
  assert.strictEqual(drag.begin({ x: 1.5, y: 0.5 }).piece, loose, 'a loose piece still can');
  assert.strictEqual(drag.end({ x: 0.5, y: 0.5 }).type, 'cancel', 'and cannot be dropped onto the pinned one');
  drag.begin({ x: 0.5, y: 5.5 }); assert.strictEqual(drag.end({ x: 0.5, y: 0.5 }).type, 'cancel', 'nor can a tray piece');
});
const simulate = (phys, seconds) => { for (let step = 0; step < seconds * 60; step++) phys.step(1 / 60); };
test('bodies: a ball rolls down a tilted compound ramp, stays in its plane and never tunnels', () => {
  const phys = Kit.physics({ gravity: -20 });
  // The plank is thinner than the ball's fall per step would be without the speed cap: 30 units of drop reaches ~35 u/s.
  const ramp = Kit.physics.compound(phys, null, [{ box: [6, 0.3, 1] }], { at: [0, 0, 0], angle: -0.3 });
  const ball = phys.sphere(null, 0.25, { at: [-1, 30, 0.4] });
  const rules = Kit.physics.stepRules(phys, [Kit.physics.keepInPlane('z'), Kit.physics.limitSpeed(14)]);
  rules.add(ball); ball.allowSleep = false; ball.velocity.z = 3;
  let fastest = 0, lowestOverRamp = Infinity;
  for (let step = 0; step < 240; step++) {
    phys.step(1 / 60);
    fastest = Math.max(fastest, ball.velocity.norm());
    if (Math.abs(ball.position.x) < 2) lowestOverRamp = Math.min(lowestOverRamp, ball.position.y - Math.tan(-0.3) * ball.position.x);
  }
  assert.strictEqual(ramp.type, sandbox.CANNON.Body.STATIC); near(ball.position.z, 0.4, 'held in its starting plane'); near(ball.velocity.z, 0, 'no drift speed');
  assert.ok(fastest <= 14 + 1e-6, 'speed capped, saw ' + fastest); assert.ok(lowestOverRamp > 0, 'ball stayed above the plank, lowest ' + lowestOverRamp);
  assert.ok(ball.position.x > 1, 'rolled downhill to +x, at ' + ball.position.x);
});
test('bodies: surfaces give each kind of ball its own bounce off the scenery', () => {
  const phys = Kit.physics({ gravity: -20, restitution: 0.3 });
  const surfaces = Kit.physics.surfaces(phys, { rubber: { friction: 0.5, restitution: 0.85 }, steel: { friction: 0.2, restitution: 0.05 } });
  surfaces.scenery(Kit.physics.compound(phys, null, [{ box: [20, 1, 2] }], { at: [0, -0.5, 0] }));
  const drop = (name, x) => { const ball = phys.sphere(null, 0.25, { at: [x, 3, 0] }); ball.allowSleep = false; return name ? surfaces.assign(ball, name) : ball; };
  const rubber = drop('rubber', -3), steel = drop('steel', 0), plain = drop(null, 3);
  const peaks = new Map([[rubber, 0], [steel, 0], [plain, 0]]);
  for (let step = 0; step < 150; step++) {
    phys.step(1 / 60);
    // Rebound height: the highest point reached after the first bounce (all three land on step 31 or 32).
    if (step > 40) peaks.forEach((peak, ball) => peaks.set(ball, Math.max(peak, ball.position.y)));
  }
  assert.ok(peaks.get(rubber) > 1.5, 'rubber rebounds high: ' + peaks.get(rubber)); assert.ok(peaks.get(steel) < 0.35, 'steel barely leaves the floor: ' + peaks.get(steel));
  assert.ok(peaks.get(plain) > peaks.get(steel) && peaks.get(plain) < peaks.get(rubber), 'a body with no surface keeps the world default');
  assert.throws(() => surfaces.assign(plain, 'felt'), /no surface "felt"/);
});
test('bodies: spin makes a kinematic paddle that turns and shoves', () => {
  const phys = Kit.physics({ gravity: 0 });
  const paddle = Kit.physics.compound(phys, null, [{ box: [2, 0.2, 1] }, { box: [0.2, 2, 1] }], { spin: Math.PI });
  const ball = phys.sphere(null, 0.25, { at: [0.8, 0.5, 0] }); ball.allowSleep = false;
  simulate(phys, 0.5);
  assert.strictEqual(paddle.type, sandbox.CANNON.Body.KINEMATIC); near(paddle.position.x, 0, 'turns in place');
  assert.ok(Math.abs(Math.abs(paddle.quaternion.z) - Math.SQRT1_2) < 0.02, 'a quarter turn in half a second, z = ' + paddle.quaternion.z);
  assert.ok(ball.velocity.norm() > 0.5, 'the arm pushed the resting ball');
  assert.throws(() => Kit.physics.compound(phys, null, [{ cone: 1 }]), /needs `box/);
});
atest('bodies: layers filter contacts, sensors report without pushing, retire is safe inside a callback', async () => {
  const layers = Kit.physics.layers(['marble', 'part', 'ghost']);
  assert.strictEqual(layers.bit('part'), 2); assert.strictEqual(layers.mask(['marble', 'ghost']), 5); assert.throws(() => layers.bit('wall'), /no layer/);
  const phys = Kit.physics({ gravity: -20 });
  const shelf = layers.assign(Kit.physics.compound(phys, null, [{ box: [20, 0.4, 1] }], { at: [0, 0, 0] }), 'part', ['marble']);
  const marble = layers.assign(phys.sphere(null, 0.25, { at: [-2, 1, 0] }), 'marble', ['part']);
  const ghost = layers.assign(phys.sphere(null, 0.25, { at: [2, 1, 0] }), 'ghost', []);
  const gate = Kit.physics.sensor(layers.assign(Kit.physics.compound(phys, null, [{ disc: 0.4 }], { at: [-2, 3, 0] }), 'part', ['marble']));
  const faller = layers.assign(phys.sphere(null, 0.25, { at: [-2, 4.2, 0] }), 'marble', ['part']);
  let gateHits = 0, shelfHits = 0;
  phys.onHit(gate, () => gateHits++);
  phys.onHit(shelf, (speed, other) => { shelfHits++; if (other === faller) Kit.physics.retire(phys, faller); });
  [marble, ghost, faller].forEach((body) => (body.allowSleep = false));
  simulate(phys, 2); await Promise.resolve();
  assert.ok(marble.position.y > 0.3, 'marble rests on the shelf'); assert.ok(ghost.position.y < -5, 'unmasked body falls through');
  assert.strictEqual(gateHits, 1, 'sensor saw the faller once'); assert.ok(shelfHits >= 2, 'faller passed through the sensor and reached the shelf');
  assert.strictEqual(faller.world, null, 'retired body left the world'); assert.ok(!phys.world.bodies.includes(faller));
  const rules = Kit.physics.stepRules(phys, [Kit.physics.limitSpeed(1)]); rules.add(faller); rules.add(marble);
  simulate(phys, 0.1); assert.strictEqual(rules.size(), 1, 'rules forget bodies that left the world');
});
// ---- dice, sight, measure, net trust and the hosted-platform transport (kit/dice.js, sight.js, net-trust.js, net-claude.js) ----
Object.assign(sandbox, { setTimeout, clearTimeout }); // the platform transport debounces with timers
for (const file of ['dice', 'sight', 'net-trust', 'net-claude']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', file + '.js'), 'utf8'), sandbox, { filename: file + '.js' });
const { createFakePlatform } = require('./fake-claude.js');
/** A random source that replays fixed fractions, so a test can dictate every die face. */
const scriptedRandom = (fractions) => { let index = 0; return () => fractions[index++ % fractions.length]; };
const TOP_FACE = 0.999, BOTTOM_FACE = 0;
/** Shared by later test blocks too. Deep equality for values made inside the kit's sandbox, whose arrays have a different Array prototype than the test's. */
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);

test('dice.parse normalises notation and names what is wrong with bad input', () => {
  assert.strictEqual(Kit.dice.parse('2d6+3').text, '2d6+3');
  assert.strictEqual(Kit.dice.parse(' D20 Advantage + 2 ').text, '2d20kh1+2');
  assert.strictEqual(Kit.dice.parse('d20 disadvantage').text, '2d20kl1', '"disadvantage" must not be read as "dis" + "advantage"');
  assert.strictEqual(Kit.dice.parse('4d6dl1').text, '4d6kh3', 'dropping the lowest is keeping the rest from the top');
  assert.strictEqual(Kit.dice.parse('4d6dh1-d%').text, '4d6kl3-1d100');
  assert.throws(() => Kit.dice.parse('2d6 3'), /cannot read/, 'a term without a sign must not be glued to the one before');
  assert.throws(() => Kit.dice.parse(''), /empty/);
  assert.throws(() => Kit.dice.parse('101d6'), /over the limit/);
  assert.throws(() => Kit.dice.parse('d0'), /at least one side/);
  assert.throws(() => Kit.dice.parse('4d6kh5'), /cannot keep/);
  assert.throws(() => Kit.dice.parse('d20 adv dis'), /only one/);
  assert.throws(() => Kit.dice.parse('2d6 adv'), /single die/);
  assert.throws(() => Kit.dice.parse('x'.repeat(200)), /longer than/);
  assert.throws(() => Kit.dice.parse(42), /must be text/);
});
test('dice.roll lists every die, keeps the right ones and is repeatable from a seed', () => {
  const first = Kit.dice.roll('4d6kh3+2', Kit.rng(11)), second = Kit.dice.roll('4d6kh3+2', Kit.rng(11));
  same(first, JSON.parse(JSON.stringify(second)), 'same seed, same roll');
  const values = first.dice.map((die) => die.value), dropped = first.dice.filter((die) => !die.isKept);
  assert.strictEqual(first.dice.length, 4); assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].value, Math.min(...values), 'the dropped die is the lowest');
  assert.strictEqual(first.total, values.reduce((sum, value) => sum + value, 0) - dropped[0].value + 2);
  const worst = Kit.dice.roll('d20 dis - 2', scriptedRandom([TOP_FACE, BOTTOM_FACE]));
  same(worst.dice.map((die) => [die.value, die.isKept]), [[20, false], [1, true]]);
  assert.strictEqual(worst.total, -1); assert.strictEqual(worst.natural, 1, 'the kept face of a check is reported');
  assert.strictEqual(Kit.dice.roll('2d20', Kit.rng(1)).natural, null, 'two kept d20s are not a check');
  const tie = Kit.dice.roll('2d6kh1', scriptedRandom([0.5, 0.5]));
  same(tie.dice.map((die) => die.isKept), [true, false], 'a tie keeps the earlier die');
});
test('dice: explosions add flagged bonus dice and are capped; fudge dice and ranges', () => {
  const burst = Kit.dice.roll('2d6!', scriptedRandom([TOP_FACE, BOTTOM_FACE, 0.5]));
  same(burst.dice.map((die) => [die.value, die.isBonus]), [[6, false], [1, false], [4, true]]);
  assert.strictEqual(burst.total, 11);
  const endless = Kit.dice.roll('d1!', Kit.rng(3));
  assert.strictEqual(endless.dice.length, 1 + Kit.dice.LIMITS.EXPLOSIONS, 'a die that always explodes stops at the cap');
  assert.strictEqual(Kit.dice.roll('4dF', scriptedRandom([BOTTOM_FACE])).total, -4);
  same({ ...Kit.dice.range('2d6+3') }, { min: 5, max: 15 });
  same({ ...Kit.dice.range('4d6kh3-d4') }, { min: -1, max: 17 }, 'a subtracted die lowers the minimum by its top face');
  same({ ...Kit.dice.range('4dF') }, { min: -4, max: 4 });
  assert.strictEqual(Kit.dice.describe(Kit.dice.roll('2d6kh1-1', scriptedRandom([BOTTOM_FACE, TOP_FACE]))), '2d6kh1-1: [(1), 6] - 1 = 5');
  assert.strictEqual(Kit.dice.check(3, 'adv'), '2d20kh1+3'); assert.strictEqual(Kit.dice.check(-1), '1d20-1'); assert.strictEqual(Kit.dice.check(0, 'dis'), '2d20kl1');
});

const WALL = '#';
const isWall = (cell) => cell === WALL;
const gridOf = (rows) => Kit.grid.parse(rows, { '#': WALL, '.': '.', '~': '~' });
const litCount = (mask) => mask.reduce((sum, lit) => sum + lit, 0);
test('sight.fov lights a disc in the open, stops at walls and shows the wall itself', () => {
  const open = gridOf(Array(9).fill('.........'));
  assert.strictEqual(litCount(Kit.sight.fov(open, 4, 4, { radius: 2, blocks: isWall })), 21, 'cells whose centre is within 2.5 of the eye');
  const room = gridOf(['.....', '..#..', '.....']);
  const mask = Kit.sight.fov(room, 2, 2, { radius: 9, blocks: isWall });
  assert.strictEqual(mask[1 * 5 + 2], 1, 'the wall is seen'); assert.strictEqual(mask[0 * 5 + 2], 0, 'the cell behind it is not');
  assert.strictEqual(mask[0 * 5 + 0], 1, 'cells off to the side are');
  assert.strictEqual(litCount(Kit.sight.fov(room, 9, 9, { radius: 3, blocks: isWall })), 0, 'an eye off the board sees nothing');
  const shared = Kit.sight.fov(open, 0, 0, { radius: 1, blocks: isWall });
  Kit.sight.fov(open, 8, 8, { radius: 1, blocks: isWall, into: shared });
  assert.ok(shared[0] && shared[8 * 9 + 8] && !shared[4 * 9 + 4], '`into` unions several eyes in one mask');
});
test('sight.fov is symmetric between floor cells on a random cave; sight.los agrees about walls between', () => {
  const rng = Kit.rng(5), size = 14;
  const cave = Kit.grid(size, size, { fill: () => (rng.chance(0.22) ? WALL : '.') });
  const floors = cave.find((cell) => cell !== WALL);
  const masks = new Map(floors.map((cell) => [cell.y * size + cell.x, Kit.sight.fov(cave, cell.x, cell.y, { radius: 6, blocks: isWall })]));
  const sees = (from, to) => masks.get(from.y * size + from.x)[to.y * size + to.x] === 1;
  floors.forEach((from) => floors.forEach((to) => assert.strictEqual(sees(from, to), sees(to, from), `(${from.x},${from.y}) <-> (${to.x},${to.y})`)));
  const corridor = gridOf(['..#..']);
  assert.strictEqual(Kit.sight.los(corridor, { x: 0, y: 0 }, { x: 4, y: 0 }, isWall), false);
  assert.strictEqual(Kit.sight.los(corridor, { x: 0, y: 0 }, { x: 2, y: 0 }, isWall), true, 'the end cells never block');
});
test('measure: every distance rule, 5-10-5 carried along a path, terrain cost and labels', () => {
  const from = { x: 0, y: 0 }, to = { x: 3, y: 4 };
  assert.strictEqual(Kit.measure.between(from, to, 'alternating'), 5); assert.strictEqual(Kit.measure.between(from, to, 'equal'), 4);
  assert.strictEqual(Kit.measure.between(from, to, 'manhattan'), 7); near(Kit.measure.between(from, to, 'euclidean'), 5, 'euclid');
  assert.throws(() => Kit.measure.between(from, to, 'hexes'), /unknown distance rule/);
  const dogleg = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 2 }];
  assert.strictEqual(Kit.measure.along(dogleg), 4, 'the second diagonal costs two even after a straight step');
  assert.strictEqual(Kit.measure.along(dogleg, 'alternating', (x) => (x === 2 ? 2 : 1)), 5, 'entering rough ground doubles that step');
  assert.strictEqual(Kit.measure.along([{ x: 0, y: 0 }]), 0);
  assert.strictEqual(Kit.measure.label(7), '35 ft'); assert.strictEqual(Kit.measure.label(2, { unitsPerCell: 1.5, unitName: 'm' }), '3 m');
});
test('measure.route walks around walls, never cuts corners, weighs terrain and gives up when sealed in', () => {
  const passable = (cell) => cell !== WALL, costOf = (cell) => (cell === '~' ? 2 : 1);
  const bend = gridOf(['.#.', '...']);
  const path = Kit.measure.route(bend, { x: 0, y: 0 }, { x: 2, y: 0 }, { passable });
  same(path.map((cell) => `${cell.x},${cell.y}`), ['0,0', '0,1', '1,1', '2,1', '2,0'], 'diagonals past the wall corner are refused');
  const marsh = gridOf(['.~.', '...']);
  assert.strictEqual(Kit.measure.route(marsh, { x: 0, y: 0 }, { x: 2, y: 0 }, { passable, costOf }).length, 3, 'two rough-ground cells... straight through is one costly step');
  const wideMarsh = gridOf(['.~~~.', '.....']);
  assert.ok(Kit.measure.route(wideMarsh, { x: 0, y: 0 }, { x: 4, y: 0 }, { passable, costOf }).every((cell) => wideMarsh.get(cell.x, cell.y) !== '~'), 'a long marsh is walked around');
  assert.strictEqual(Kit.measure.route(gridOf(['.#.']), { x: 0, y: 0 }, { x: 2, y: 0 }, { passable }), null);
  assert.strictEqual(Kit.measure.route(bend, { x: 0, y: 0 }, { x: 1, y: 0 }, { passable }), null, 'a wall is never a destination');
  assert.strictEqual(Kit.measure.route(bend, { x: 0, y: 0 }, { x: 2, y: 0 }, { passable, maxCost: 2 }), null, 'maxCost bounds the search');
  assert.strictEqual(Kit.measure.route(bend, { x: 0, y: 0 }, { x: 0, y: 0 }, { passable }).length, 1);
});
test('net trust: impossible versions are refused, guarded() drops them, withSender() stamps locally', () => {
  const now = 1_000_000;
  assert.strictEqual(Kit.net.isSaneEntry({ v: 1, ver: [5, 'a'] }, now), true);
  assert.strictEqual(Kit.net.isSaneEntry({ v: 1, ver: [now + Kit.net.CLOCK_SKEW_MS + 1, 'a'] }, now), false, 'a counter from the future');
  [{ ver: [1e308, 'a'] }, { ver: [1.5, 'a'] }, { ver: [-1, 'a'] }, { ver: [1, 7] }, { ver: [1] }, { ver: 'x' }, null, 'text'].forEach((entry) => assert.strictEqual(Kit.net.isSaneEntry(entry, now), false, JSON.stringify(entry)));
  const hub = Kit.net.loopback();
  const attacker = hub.join('attacker', { by: 'sam' });
  const victim = Kit.net.session(Kit.net.withSender(Kit.net.guarded(hub.join('victim')), (sender) => ({ admin: sender.by === 'gm' })), { validate: (key, value, from) => from.admin === false });
  attacker.send({ t: 'set', k: 'hp', e: { v: 999, ver: [Number.MAX_SAFE_INTEGER, 'attacker'] } });
  attacker.send({ t: 'set', k: 7, e: { v: 1, ver: [1, 'attacker'] } });
  assert.strictEqual(victim.keys().length, 0, 'neither the far-future write nor the non-text key got in');
  attacker.send({ t: 'set', k: 'hp', e: { v: 3, ver: [1, 'attacker'] } });
  assert.strictEqual(victim.get('hp'), 3, 'an honest version passes, and validate saw the locally stamped sender');
});

/** Short timers so the transport's debounces settle within a test. */
const FAST_TIMING = { saveDelayMs: 1, presenceDelayMs: 1, loadTimeoutMs: 300, rejoinDelayMs: 1, retryWriteDelayMs: 1 };
const soon = (milliseconds = 25) => new Promise((resolve) => setTimeout(resolve, milliseconds));
/** Only game masters (senders the platform vouches for as admin) may write under map/; token/<id> belongs to user <id>. */
const tableRules = (key, value, from) => (key.startsWith('map/') ? from.admin === true : key.startsWith('token/') ? from.admin === true || key === 'token/' + from.by : true);
/** Open a page on the fake platform and run a session on the transport it gets. */
async function seat(platform, viewOptions, connectOptions = {}) {
  const page = platform.view(viewOptions);
  const transport = await Kit.net.claude({ claude: page.claude, table: 'Friday Game', ...FAST_TIMING, ...connectOptions });
  const session = Kit.net.session(transport, { validate: tableRules, rate: transport.rate });
  await session.ready;
  return { page, transport, session };
}
const flush = async (...seats) => { drain(...seats.map((each) => each.session)); await soon(); };

atest('net-claude: resolves null off the platform or with neither capability; helpers are exact', async () => {
  assert.strictEqual(await Kit.net.claude({}), null, 'no window.claude');
  assert.strictEqual(await Kit.net.claude({ claude: { use: () => { throw new Error('host is broken'); } } }), null, 'a throwing host is absence, not a crash');
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  assert.strictEqual(await Kit.net.claude({ claude: platform.view({ id: 'u1', level: 'admin', serves: ['user'] }).claude }), null);
  const ids = ['token/t1', 'token:t1', 'a b', 'a~0020b', 'é/…'].map(Kit.net.claude.documentIdOf);
  assert.strictEqual(new Set(ids).size, ids.length, 'different keys never share a document');
  ids.forEach((id) => assert.ok(/^[A-Za-z0-9_\-.~:@+]+$/.test(id), id));
  assert.strictEqual(Kit.net.claude.documentIdOf('token/t1'), 'ktoken:t1'); assert.strictEqual(Kit.net.claude.documentIdOf('k'.repeat(300)), null);
  assert.strictEqual(Kit.net.claude.tableNameOf('  Friday Game! '), 'friday-game'); assert.strictEqual(Kit.net.claude.tableNameOf('///'), 'main');
  ['plain', 'né', '€uro', 'a😀b'].forEach((text) => assert.strictEqual(Kit.net.claude.utf8Length(text), Buffer.byteLength(text, 'utf8'), text));
});
atest('net-claude: GM and players converge live; identity and authority come from the platform, never the message', async () => {
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  const gm = await seat(platform, { id: 'u_gm', level: 'admin' }), ana = await seat(platform, { id: 'u_ana', level: 'interact' }), ben = await seat(platform, { id: 'u_ben', level: 'interact' });
  assert.strictEqual(gm.transport.state().role, 'gm'); assert.strictEqual(ana.transport.state().role, 'player');
  const heardByAna = []; ana.session.on('', (key, value, from) => heardByAna.push({ key, by: from.by, admin: from.admin, stored: !!from.stored }));
  gm.session.set('map/0', '#..#'); ana.session.set('token/u_ana', { x: 2 });
  ana.session.set('map/1', 'forged'); ana.session.set('token/u_ben', { x: 9 }); // both outside what a player may write
  await flush(gm, ana, ben);
  assert.strictEqual(ben.session.get('map/0'), '#..#'); assert.strictEqual(gm.session.get('token/u_ana').x, 2);
  assert.strictEqual(gm.session.get('map/1'), undefined, 'the GM ignores a player writing the map');
  assert.strictEqual(ben.session.get('token/u_ben'), undefined, "a player cannot move someone else's token");
  assert.ok(heardByAna.some((heard) => heard.key === 'map/0' && heard.by === 'u_gm' && heard.admin === true), 'GM writes arrive stamped admin');
  assert.ok(gm.page.emits.every((emit) => emit.topic === 'kn.a') && ana.page.emits.every((emit) => emit.topic === 'kn.p'), 'each role sends on its own topic');
  assert.ok(gm.page.writes.every((written) => written.startsWith('kn-gm/friday-game/')) && ana.page.writes.every((written) => written.startsWith('kn-own/u_ana')), 'and stores in its own space');
});
atest('net-claude: the store alone carries the table, vouches for authors, and serves late joiners', async () => {
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  platform.dropRate = 1; // every live message is lost
  const gm = await seat(platform, { id: 'u_gm', level: 'admin' }), ana = await seat(platform, { id: 'u_ana', level: 'interact' });
  gm.session.set('map/0', '#..#'); ana.session.set('token/u_ana', { x: 4 }); ana.session.set('map/9', 'forged');
  await flush(gm, ana); await soon();
  assert.strictEqual(ana.session.get('map/0'), '#..#', 'healed by the store'); assert.strictEqual(gm.session.get('token/u_ana').x, 4);
  assert.strictEqual(gm.session.get('map/9'), undefined, 'a forged map row stored in a player subtree is still judged as that player');
  // A cheat bypassing the page: writes straight into the store with a perfectly sane version.
  const cheat = platform.view({ id: 'u_ana', level: 'interact' });
  const cheatDb = await cheat.claude.use('db');
  await assert.rejects(cheatDb.doc('kn-gm/friday-game/k/kmap:0').set({ k: 'map/0', e: { v: 'open', ver: [Date.now(), 'x'] } }), 'the platform refuses a player in the GM space');
  await cheatDb.doc('kn-own/u_ana/friday-game/kmap:0').set({ k: 'map/0', e: { v: 'open', ver: [Date.now(), 'x'] } });
  await soon();
  assert.strictEqual(gm.session.get('map/0'), '#..#', 'and what they store in their own space fails validation everywhere');
  gm.session.close(); ana.session.close();
  const late = await seat(platform, { id: 'u_late', level: 'interact' });
  assert.strictEqual(late.session.get('map/0'), '#..#'); assert.strictEqual(late.session.get('token/u_ana').x, 4, 'a late joiner reads every player subtree listed in the roster');
  assert.strictEqual(late.session.get('map/9'), undefined);
});
atest('net-claude: a Viewer watches but cannot change anything; a mistaken GM is demoted and still plays', async () => {
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  const gm = await seat(platform, { id: 'u_gm', level: 'admin' }), watcher = await seat(platform, { id: 'u_v', level: 'view' });
  assert.strictEqual(watcher.transport.state().role, 'viewer');
  gm.session.set('map/0', 'row'); watcher.session.set('token/u_v', { x: 1 });
  await flush(gm, watcher);
  assert.strictEqual(watcher.session.get('map/0'), 'row', 'viewers receive'); assert.strictEqual(gm.session.get('token/u_v'), undefined, 'and cannot send');
  assert.strictEqual(watcher.page.emits.length + watcher.page.writes.length, 0, 'the transport does not even try');
  // A page told "canEdit" by a host that then refuses: the first refusal lowers the role and the message is re-sent as a player.
  const page = platform.view({ id: 'u_x', level: 'interact' });
  const realUser = await page.claude.use('user');
  const lyingClaude = { use: async (name) => (name === 'user' ? { ...realUser, me: async () => ({ ...(await realUser.me()), canEdit: true }) } : page.claude.use(name)) };
  const transport = await Kit.net.claude({ claude: lyingClaude, table: 'friday game', ...FAST_TIMING });
  const mistaken = Kit.net.session(transport, { validate: tableRules }); await mistaken.ready;
  assert.strictEqual(transport.state().role, 'gm');
  mistaken.set('token/u_x', { x: 7 }); drain(mistaken, gm.session); await soon(); drain(mistaken, gm.session); await soon(60);
  assert.strictEqual(transport.state().role, 'player'); assert.strictEqual(gm.session.get('token/u_x').x, 7, 'the write still arrived, as a player');
  assert.ok(page.writes.some((written) => written.startsWith('kn-own/u_x/friday-game/')), 'and was stored in their own space after the refusal');
});
atest('net-claude: works with only a room, only a store, or only the lobby, and tables on the lobby stay apart', async () => {
  const roomOnly = createFakePlatform(Kit.net.claude.capabilities);
  const first = await seat(roomOnly, { id: 'u_gm', level: 'admin', serves: ['room', 'user'] });
  assert.strictEqual(first.transport.store, undefined); assert.strictEqual(first.transport.state().isDurable, false);
  first.session.set('map/0', 'row'); await flush(first);
  const second = await seat(roomOnly, { id: 'u_b', level: 'interact', serves: ['room', 'user'] });
  await flush(first, second); await flush(first, second);
  assert.strictEqual(second.session.get('map/0'), 'row', 'without a store, whoever is present answers the newcomer');

  const storeOnly = createFakePlatform(Kit.net.claude.capabilities);
  const quietGm = await seat(storeOnly, { id: 'u_gm', level: 'admin', serves: ['db', 'user'] }), quietPlayer = await seat(storeOnly, { id: 'u_p', level: 'interact', serves: ['db', 'user'] });
  assert.strictEqual(quietGm.transport.state().isLive, false);
  quietGm.session.set('map/0', 'row'); await flush(quietGm, quietPlayer);
  assert.strictEqual(quietPlayer.session.get('map/0'), 'row', 'snapshots alone keep everyone in step');
  let roster = []; quietPlayer.session.onPeers((peers) => (roster = peers));
  assert.ok(roster.length === 1 && roster[0].isMe, 'with no room the roster is just you');

  const lobbyOnly = createFakePlatform(Kit.net.claude.capabilities);
  const noRooms = { level: 'admin', serves: ['room', 'user'], allowsNamedRooms: false };
  const red = await seat(lobbyOnly, { id: 'u_r', ...noRooms }, { table: 'red' }), redToo = await seat(lobbyOnly, { id: 'u_r2', ...noRooms }, { table: 'red' }), blue = await seat(lobbyOnly, { id: 'u_b', ...noRooms }, { table: 'blue' });
  red.session.set('map/0', 'red row'); await flush(red, redToo, blue);
  assert.strictEqual(redToo.session.get('map/0'), 'red row'); assert.strictEqual(blue.session.get('map/0'), undefined, 'another table on the same lobby hears nothing');
});
atest('net-claude: presence is coalesced, oversize messages skip the room but not the store, lost rooms are re-joined', async () => {
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  const gm = await seat(platform, { id: 'u_gm', level: 'admin' }), ana = await seat(platform, { id: 'u_ana', level: 'interact' });
  let roster = []; gm.session.onPeers((peers) => (roster = peers));
  Array.from({ length: 30 }, (unused, step) => ana.session.presence({ cursor: [step, step], name: 'Ana' }));
  await soon();
  assert.strictEqual(ana.page.presenceCalls(), 1, 'thirty pointer moves, one platform call');
  const anaRow = roster.find((peer) => peer.by === 'u_ana');
  same([...anaRow.presence.cursor], [29, 29]); assert.strictEqual(anaRow.isMe, false); assert.strictEqual(roster.find((peer) => peer.by === 'u_gm').isMe, true);
  // 1400 three-byte characters: under the session's character-based estimate, over the platform's 4096-byte limit.
  const emitsBefore = gm.page.emits.length;
  gm.session.set('map/wide', '€'.repeat(1400)); await flush(gm, ana); await soon();
  assert.strictEqual(gm.page.emits.length, emitsBefore, 'not emitted'); assert.strictEqual(gm.transport.state().droppedOversize, 1);
  assert.strictEqual(ana.session.get('map/wide').length, 1400, 'but delivered through the store');
  const states = []; ana.transport.onState((state) => states.push(state.isLive));
  ana.page.failRoom('upstream_error'); assert.strictEqual(ana.transport.state().isLive, false);
  await soon(40);
  assert.strictEqual(ana.transport.state().isLive, true, 're-joined after a transient loss'); assert.ok(states.includes(false) && states.includes(true), 'and said so');
  gm.session.set('map/after', 'ok'); await flush(gm, ana); assert.strictEqual(ana.session.get('map/after'), 'ok');
  ana.page.failRoom('revoked'); await soon(40);
  assert.strictEqual(ana.transport.state().isLive, false, 'a terminal loss is not retried'); assert.strictEqual(ana.transport.state().errorCode, 'revoked');
});
atest('net-claude: the writer sends the latest body once per burst and never overlaps writes to one document', async () => {
  const written = []; let inFlight = 0, worstOverlap = 0;
  const writer = Kit.net.claude.coalescingWriter({
    delayMs: 2, onError: (error) => written.push('error:' + error.message),
    write: async (id, body) => { worstOverlap = Math.max(worstOverlap, ++inFlight); await soon(10); written.push(id + '=' + body.value); inFlight--; if (body.value === 'bad') throw new Error('refused'); },
  });
  ['a1', 'a2', 'a3'].forEach((value) => writer.put('a', { value })); writer.put('b', { value: 'b1' });
  await soon(6); writer.put('a', { value: 'a4' }); writer.put('a', { value: 'bad' }); // arrives while a3 is being written
  await soon(60);
  same(written.filter((line) => line.startsWith('a')), ['a=a3', 'a=bad'], 'intermediate bodies are skipped, the last one always lands');
  assert.ok(written.includes('b=b1') && written.includes('error:refused')); assert.strictEqual(worstOverlap, 2, 'at most one write per document (a and b overlap, a and a never)');
});
atest('net.open: one call gives a working table anywhere; a solo table is kept in storage; hosted tables converge', async () => {
  const solo = await Kit.net.open({ validate: (key, value, from) => from.admin === true });
  assert.strictEqual(solo.isHosted, false); assert.strictEqual(solo.me.isAdmin(), true); assert.strictEqual(solo.state().role, 'gm');
  solo.net.set('score', 3); assert.strictEqual(solo.net.get('score'), 3); solo.close();
  const storage = mem();
  const first = await Kit.net.open({ table: 'Camp', storage }); first.net.set('scene', 'cave'); first.net.set('gone', 1); first.net.delete('gone'); first.close();
  const second = await Kit.net.open({ table: 'Camp', storage });
  assert.strictEqual(second.net.get('scene'), 'cave', 'reloaded from storage'); assert.strictEqual(second.net.has('gone'), false, 'a deletion is remembered too');
  const other = await Kit.net.open({ table: 'Other', storage });
  assert.strictEqual(other.net.get('scene'), undefined, 'tables are kept apart by name'); second.close(); other.close();
  storage.set('net:camp', [['ok', { v: 1, ver: [5, 'you'] }], ['bad', { v: 1, ver: [1e308, 'x'] }], 'junk', ['worse']]);
  const repaired = await Kit.net.open({ table: 'Camp', storage });
  assert.deepStrictEqual([repaired.net.get('ok'), repaired.net.get('bad')], [1, undefined], 'damaged or impossible stored entries are skipped, the rest load'); repaired.close();
  const platform = createFakePlatform(Kit.net.claude.capabilities);
  const rule = (key, value, from) => from.admin === true || key === 'hand/' + from.by;
  const gm = await Kit.net.open({ claude: platform.view({ id: 'u_gm', level: 'admin' }).claude, validate: rule, ...FAST_TIMING });
  const ana = await Kit.net.open({ claude: platform.view({ id: 'u_ana', level: 'interact' }).claude, validate: rule, ...FAST_TIMING });
  assert.ok(gm.isHosted && gm.me.isAdmin() && !ana.me.isAdmin() && ana.me.by === 'u_ana');
  gm.net.set('deck', 52); ana.net.set('hand/u_ana', ['7C']);
  assert.strictEqual(ana.net.set('deck', 0), false, 'a write the rule refuses is not even made locally'); assert.strictEqual(ana.net.patch('hand/u_ana', { 1: 'QH' }), true);
  await soon(120); // both sessions tick themselves
  assert.strictEqual(ana.net.get('deck'), 52); assert.strictEqual(gm.net.get('hand/u_ana')[0], '7C'); assert.strictEqual(gm.net.get('deck'), 52, 'the rule holds on the hosted table');
  gm.close(); ana.close();
});
// ---- tabletop rules (kit/tabletop.js): shared value shapes, who may change what, fog, turn order, ink ----
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'tabletop.js'), 'utf8'), sandbox, { filename: 'tabletop.js' });
/** A table on a loopback hub: a game master and players, each a session running the tabletop rules, already seeded. */
function tableWith(playerIds, owners = {}) {
  const hub = Kit.net.loopback();
  const sit = (id) => {
    let rules = () => false;
    const session = Kit.net.session(Kit.net.withSender(hub.join(id), (sender) => ({ admin: sender.by === 'gm' })), { validate: (...change) => rules(...change) });
    rules = Kit.tabletop.rulesFor(session);
    return session;
  };
  const gm = sit('gm'), players = playerIds.map(sit), all = [gm, ...players];
  Kit.tabletop.starterEntries(owners).forEach(([key, value]) => gm.set(key, value));
  drain(...all);
  return { gm, players, sync: () => drain(...all) };
}
const tokenAt = (session, id) => session.get(Kit.tabletop.KEYS.token(id));

test('tabletop: the starter scene is well formed and every value in it passes its own cleaning', () => {
  const { STARTER, TERRAIN, cleanScene, cleanToken, cleanSheet, starterEntries, KEYS, boardOf, isWalkable } = Kit.tabletop;
  const entries = new Map(starterEntries({ wren: 'you' })), read = (key) => entries.get(key);
  assert.strictEqual(Kit.tabletop.activeSceneId(read), STARTER.stage, 'the table opens on a scene that exists');
  STARTER.scenes.forEach((row) => {
    assert.ok(row.map.every((line) => line.length === row.map[0].length), `${row.id}: every map row has the same width`);
    assert.ok(row.map.every((line) => [...line].every((character) => TERRAIN[character])), `${row.id}: every map character is known terrain`);
    const scene = cleanScene(read(KEYS.scene(row.id))), board = boardOf(read, row.id);
    assert.ok(scene && isWalkable(board.get(scene.entry.x, scene.entry.y)), `${row.id}: the party can stand on the entry`);
    const joinsTwoOpenCells = (door) => [[1, 0], [0, 1]].some(([stepX, stepY]) => isWalkable(board.get(door.x + stepX, door.y + stepY)) && isWalkable(board.get(door.x - stepX, door.y - stepY)));
    assert.ok(board.find((terrain) => terrain.isDoor).every(joinsTwoOpenCells), `${row.id}: no door opens onto a wall`);
  });
  STARTER.tokens.forEach((row) => {
    const token = cleanToken(read(KEYS.token(row.id)));
    assert.ok(token && cleanSheet(read(KEYS.sheet(row.id))), row.id);
    assert.ok(isWalkable(boardOf(read, token.scene).get(token.x, token.y)), `${row.id} starts on open ground`);
  });
  assert.strictEqual(read(KEYS.token('wren')).owner, 'you'); assert.strictEqual(read(KEYS.token('ash')).owner, null);
  assert.strictEqual(boardOf(read, 'nowhere'), null); assert.strictEqual(boardOf(read, null), null, 'no scene, no board');
});
test('tabletop: cleaning rejects out-of-range, mistyped and oversized values instead of repairing them', () => {
  const { cleanToken, cleanSheet, cleanScene, cleanTurn, cleanInk, cleanRoll, cleanPing, blankSheet } = Kit.tabletop;
  const good = { scene: 'cellars', name: 'Wren', color: '#d9902f', x: 1, y: 2, hp: 5, hpMax: 9, conditions: ['down'], owner: null, kind: 'pc', hidden: false, sight: 8 };
  assert.ok(cleanToken(good)); assert.strictEqual(Object.keys(cleanToken({ ...good, junk: 'x'.repeat(999) })).includes('junk'), false, 'unknown fields are not carried');
  [{ hp: 10 }, { hp: -1 }, { x: 1.5 }, { x: 40 }, { color: 'red' }, { color: '#12345' }, { name: 'n'.repeat(25) }, { name: 7 }, { conditions: ['down', 'down'] }, { conditions: ['cursed'] }, { owner: '' }, { kind: 'boss' }, { hidden: 0 }, { sight: 31 }, { scene: 'Bad Id' }, { scene: undefined }]
    .forEach((flaw) => assert.strictEqual(cleanToken({ ...good, ...flaw }), null, JSON.stringify(flaw)));
  [null, 'token', [good]].forEach((notAToken) => assert.strictEqual(cleanToken(notAToken), null));
  assert.ok(cleanSheet(blankSheet())); assert.strictEqual(cleanSheet({ ...blankSheet(), stats: { might: 0, agility: 0, wits: 0 } }), null, 'a missing stat');
  assert.strictEqual(cleanSheet({ ...blankSheet(), notes: 'n'.repeat(601) }), null); assert.strictEqual(cleanSheet({ ...blankSheet(), stats: { ...blankSheet().stats, might: 11 } }), null);
  assert.ok(cleanSheet({ ...blankSheet(), moves: [{ name: 'Blade', notation: '1d8+3' }] }));
  [[{ name: 'Blade', notation: 'lots' }], [{ name: '', notation: 'd6' }], [{ name: 'Blade', notation: 'd6', extra: 1 }], Array(5).fill({ name: 'Blade', notation: 'd6' })].forEach((moves) => assert.strictEqual(cleanSheet({ ...blankSheet(), moves }), null, JSON.stringify(moves).slice(0, 60)));
  assert.strictEqual(cleanSheet({ ...blankSheet(), guard: 41 }), null); assert.strictEqual(cleanSheet({ ...blankSheet(), speed: -1 }), null);
  const scene = { name: 'S', width: 10, height: 10, fog: true, rule: 'alternating', unitsPerCell: 5, unitName: 'ft', entry: { x: 1, y: 1 } };
  assert.ok(cleanScene(scene)); assert.strictEqual(cleanScene({ ...scene, rule: 'toString' }), null, 'an inherited property name is not a rule'); assert.strictEqual(cleanScene({ ...scene, width: 400 }), null);
  assert.strictEqual(cleanScene({ ...scene, entry: { x: 10, y: 1 } }), null, 'an entry off the board');
  assert.ok(Kit.tabletop.cleanStage({ scene: 'yard' })); assert.strictEqual(Kit.tabletop.cleanStage({ scene: '../x' }), null);
  assert.ok(cleanTurn({ order: ['a', 'b'], scores: { a: 3, b: 1 }, index: 1, round: 2 }));
  assert.strictEqual(cleanTurn({ order: ['a', 'a'], scores: { a: 3 }, index: 0, round: 1 }), null, 'a token cannot be in the order twice');
  assert.strictEqual(cleanTurn({ order: ['a'], scores: { a: 3 }, index: 1, round: 1 }), null, 'index past the end');
  assert.ok(cleanInk({ color: '#000000', points: [0, 0, 20, 20] })); assert.strictEqual(cleanInk({ color: '#000000', points: [0, 0, 20] }), null, 'odd coordinate count');
  assert.strictEqual(cleanInk({ color: '#000000', points: Array(2 * Kit.tabletop.LIMITS.INK_POINTS_PER_CHUNK + 2).fill(0) }), null, 'too many points for one message');
  assert.strictEqual(cleanRoll({ notation: '2d6+1', seed: 7, label: 'Might' }).plan.text, '2d6+1');
  [{ notation: '999d6', seed: 7, label: '' }, { notation: 'd20', seed: -1, label: '' }, { notation: 'd20', seed: 7, label: 'l'.repeat(41) }, { notation: '<b>', seed: 7, label: '' }, null].forEach((bad) => assert.strictEqual(cleanRoll(bad), null, JSON.stringify(bad)));
  assert.ok(cleanPing({ x: 3.5, y: 2 })); assert.strictEqual(cleanPing({ x: Infinity, y: 0 }), null); assert.strictEqual(cleanPing({ x: 'a', y: 0 }), null);
});
test('tabletop rules: a player moves and edits only their own token, never through walls, and may claim a free seat', () => {
  const { gm, players: [ana, ben], sync } = tableWith(['ana', 'ben'], { wren: 'ana' });
  const move = (session, id, fields) => { session.set(Kit.tabletop.KEYS.token(id), { ...tokenAt(session, id), ...fields }); sync(); };
  move(ana, 'wren', { x: 3, y: 16, hp: 10, conditions: ['shaken'] });
  same([tokenAt(gm, 'wren').x, tokenAt(ben, 'wren').hp, tokenAt(gm, 'wren').conditions[0]], [3, 10, 'shaken'], 'own token: accepted everywhere');
  move(ben, 'wren', { x: 5 }); assert.strictEqual(tokenAt(gm, 'wren').x, 3, "someone else's token: ignored");
  move(ana, 'wren', { x: 0, y: 16 }); assert.strictEqual(tokenAt(gm, 'wren').x, 3, 'into a wall: ignored');
  move(ana, 'wren', { x: 3, y: 15 }); assert.strictEqual(tokenAt(gm, 'wren').y, 16, 'onto a crate: ignored');
  move(ana, 'wren', { hpMax: 99, hp: 99 }); assert.strictEqual(tokenAt(gm, 'wren').hpMax, 22, 'raising your own maximum: ignored');
  move(ana, 'wren', { hidden: true }); assert.strictEqual(tokenAt(ben, 'wren').hidden, false, 'hiding yourself: ignored');
  move(ana, 'wren', { junk: 1 }); assert.strictEqual(tokenAt(gm, 'wren').junk, undefined, 'extra fields: ignored');
  move(ben, 'ash', { owner: 'ben' }); assert.strictEqual(tokenAt(gm, 'ash').owner, 'ben', 'a free player character can be claimed');
  move(ana, 'ash', { owner: 'ana' }); assert.strictEqual(tokenAt(gm, 'ash').owner, 'ben', 'but not taken from its owner');
  move(ben, 'shade1', { owner: 'ben' }); assert.strictEqual(tokenAt(gm, 'shade1').owner, null, 'and the GM\'s creatures cannot be claimed');
  move(ben, 'ivy', { owner: 'ben', x: 1 }); assert.strictEqual(tokenAt(gm, 'ivy').owner, null, 'claiming may not change anything else');
  ana.delete(Kit.tabletop.KEYS.token('wren')); ana.set(Kit.tabletop.KEYS.token('extra'), tokenAt(gm, 'ash')); sync();
  assert.ok(tokenAt(gm, 'wren') && !tokenAt(gm, 'extra'), 'players neither remove nor add tokens');
  gm.delete(Kit.tabletop.KEYS.token('tam')); sync(); assert.strictEqual(tokenAt(ana, 'tam'), undefined, 'the GM may do all of that');
});
test('tabletop rules: sheets, doors, ink and the map follow ownership, adjacency and authorship', () => {
  const { KEYS, blankSheet, boardOf, isWalkable } = Kit.tabletop;
  const { gm, players: [ana, ben], sync } = tableWith(['ana', 'ben'], { wren: 'ana', ash: 'ben' });
  const sheet = { ...blankSheet(), notes: 'Carries the lamp.' };
  ana.set(KEYS.sheet('wren'), sheet); ben.set(KEYS.sheet('wren'), { ...sheet, notes: 'defaced' }); sync();
  assert.strictEqual(gm.get(KEYS.sheet('wren')).notes, 'Carries the lamp.');
  ana.set(KEYS.mapRow('cellars', 1), '................'); ana.set(KEYS.stage, { scene: 'yard' }); sync();
  assert.strictEqual(gm.get(KEYS.mapRow('cellars', 1))[0], '#', 'players never edit the map'); assert.strictEqual(gm.get(KEYS.stage).scene, 'cellars', 'or change the scene');
  ana.set(KEYS.token('wren'), { ...tokenAt(ana, 'wren'), scene: 'yard' }); sync(); assert.strictEqual(tokenAt(gm, 'wren').scene, 'cellars', 'or walk their piece into another scene');
  // Wren stands at (2,16); the nearest door is at (3,12), four cells away.
  ana.set(KEYS.door('cellars', 3, 12), 1); sync(); assert.strictEqual(gm.get(KEYS.door('cellars', 3, 12)), undefined, 'a door out of reach stays shut');
  gm.set(KEYS.token('wren'), { ...tokenAt(gm, 'wren'), x: 3, y: 13 }); sync();
  ana.set(KEYS.door('cellars', 3, 12), 1); ben.set(KEYS.door('cellars', 3, 5), 1); ana.set(KEYS.door('cellars', 2, 13), 1); sync();
  assert.strictEqual(gm.get(KEYS.door('cellars', 3, 12)), 1, 'beside it, it opens'); assert.strictEqual(gm.get(KEYS.door('cellars', 3, 5)), undefined); assert.strictEqual(gm.get(KEYS.door('cellars', 2, 13)), undefined, 'a floor cell is not a door');
  assert.ok(isWalkable(boardOf((key) => ben.get(key), 'cellars').get(3, 12)), 'and the board everyone computes now lets tokens through');
  ana.set(KEYS.door('cellars', 3, 12), 2); sync(); assert.strictEqual(gm.get(KEYS.door('cellars', 3, 12)), 1, 'only "open" or absent are door states');
  const stroke = { color: '#8c1c13', points: [0, 0, 40, 40] };
  ana.set(KEYS.ink('ana', 'cellars', 's1', 0), stroke); ben.set(KEYS.ink('ana', 'cellars', 's2', 0), stroke); ben.set(KEYS.ink('ben', 'cellars', 's1', 0), { ...stroke, points: [1] }); sync();
  assert.strictEqual(gm.keys('ink/').join(), 'ink/ana/cellars/s1.0', "ink is accepted only under its author's id and only when well formed");
  ben.delete(KEYS.ink('ana', 'cellars', 's1', 0)); sync(); assert.ok(gm.has(KEYS.ink('ana', 'cellars', 's1', 0)), "you cannot erase another player's ink");
  ana.delete(KEYS.ink('ana', 'cellars', 's1', 0)); sync(); assert.strictEqual(gm.keys('ink/').length, 0, 'but you can erase your own');
  const nobody = Kit.tabletop.rulesFor(gm);
  assert.strictEqual(nobody(KEYS.token('wren'), tokenAt(gm, 'wren'), { peer: 'x', by: null }, { v: tokenAt(gm, 'wren') }), false, 'a sender without an identity changes nothing');
});
test('tabletop: turn order sorts by roll, skips tokens that left, and only the acting player may end a turn', () => {
  const { KEYS, rollTurnOrder, nextTurn, blankSheet, tokensOf } = Kit.tabletop;
  const { gm, players: [ana, ben], sync } = tableWith(['ana', 'ben'], { wren: 'ana', ash: 'ben' });
  const sheetOf = (id) => gm.get(KEYS.sheet(id)) || blankSheet();
  const turn = rollTurnOrder(tokensOf(gm), sheetOf, Kit.rng(4));
  assert.strictEqual(turn.order.length, Kit.tabletop.STARTER.tokens.length); assert.ok(turn.order.every((id, index) => index === 0 || turn.scores[turn.order[index - 1]] >= turn.scores[id]), 'highest first');
  same(rollTurnOrder(tokensOf(gm), sheetOf, Kit.rng(4)), JSON.parse(JSON.stringify(turn)), 'same seed, same order');
  assert.strictEqual(rollTurnOrder([], sheetOf, Kit.rng(1)), null);
  const three = { order: ['a', 'b', 'c'], scores: { a: 9, b: 5, c: 1 }, index: 2, round: 1 };
  same([nextTurn(three).index, nextTurn(three).round], [0, 2], 'passing the end starts a round');
  same([nextTurn({ ...three, index: 0 }, (id) => id !== 'b').index, nextTurn({ ...three, index: 1 }, (id) => id === 'b').round], [2, 2], 'absent tokens are skipped, even all the way round');
  assert.strictEqual(nextTurn(three, () => false).index, 0, 'with nobody left the turn still advances');
  gm.set(KEYS.turn, { order: ['wren', 'ash'], scores: { wren: 15, ash: 9 }, index: 0, round: 1 }); sync();
  ben.set(KEYS.turn, nextTurn(ben.get(KEYS.turn))); sync(); assert.strictEqual(gm.get(KEYS.turn).index, 0, "ending someone else's turn: ignored");
  ana.set(KEYS.turn, { ...ana.get(KEYS.turn), index: 0, round: 5 }); sync(); assert.strictEqual(gm.get(KEYS.turn).round, 1, 'rewriting the round: ignored');
  ana.set(KEYS.turn, nextTurn(ana.get(KEYS.turn))); sync(); assert.strictEqual(ben.get(KEYS.turn).index, 1, 'ending your own turn: accepted');
});
test('tabletop: fog shows a player what their tokens see, spectators the party view, and hides what is unlit or hidden', () => {
  const { boardOf, tokensOf, eyesOf, visibleCells, isTokenShown, KEYS } = Kit.tabletop;
  const { gm, sync } = tableWith([], { wren: 'ana' });
  const board = boardOf((key) => gm.get(key), 'cellars'), tokens = tokensOf(gm, 'cellars'), byId = new Map(tokens);
  assert.strictEqual(tokensOf(gm).length - tokens.length, 2, 'tokens of other scenes are left out when a scene is named');
  const ana = { by: 'ana', isGm: false }, spectator = { by: 'zed', isGm: false }, master = { by: 'gm', isGm: true };
  same(eyesOf(tokens, ana).map((token) => token.name), ['Wren']);
  assert.strictEqual(eyesOf(tokens, spectator).length, 4, 'no token of your own: every player character');
  const lit = visibleCells(board, eyesOf(tokens, ana));
  const isLit = (x, y) => lit[y * board.w + x] === 1;
  assert.ok(isLit(2, 16) && isLit(0, 16) && isLit(7, 15), 'own cell, the wall beside it and the closed door are seen');
  assert.ok(!isLit(9, 15) && !isLit(3, 8), 'nothing beyond the closed door or in another room');
  assert.strictEqual(isTokenShown(byId.get('shade1'), ana, lit, board.w), false); assert.strictEqual(isTokenShown(byId.get('ash'), ana, lit, board.w), true);
  assert.strictEqual(isTokenShown(byId.get('warden'), master, lit, board.w), true, 'the GM sees hidden tokens');
  gm.set(KEYS.door('cellars', 7, 15), 1); sync();
  const litAfter = visibleCells(boardOf((key) => gm.get(key), 'cellars'), eyesOf(tokens, ana));
  assert.strictEqual(litAfter[15 * board.w + 9], 1, 'opening the door lets sight through');
  const everywhere = new Uint8Array(board.w * board.h).fill(1);
  assert.strictEqual(isTokenShown(byId.get('warden'), ana, everywhere, board.w), false, 'a hidden token stays hidden even on a lit cell');
  assert.strictEqual(isTokenShown({ ...byId.get('wren'), hidden: true }, ana, new Uint8Array(board.w * board.h), board.w), true, 'you always see your own');
});
test('tabletop: ink strokes are simplified, chunked under the message limit and survive the round trip', () => {
  const { packStroke, unpackInk, cleanInk, LIMITS, INK_STEPS_PER_CELL } = Kit.tabletop;
  assert.strictEqual(packStroke([{ x: 1, y: 1 }], '#000000').length, 0, 'a dot is not a stroke');
  const straight = packStroke(Array.from({ length: 50 }, (unused, step) => ({ x: step / 10, y: 2 })), '#000000');
  same(straight.map((chunk) => [...chunk.points]), [[0, 40, 98, 40]], 'a straight drag collapses to its two ends');
  const rng = Kit.rng(9);
  const scribble = Array.from({ length: 700 }, (unused, step) => ({ x: 8 + rng.range(-8, 8), y: 9 + rng.range(-9, 9) }));
  const chunks = packStroke(scribble, '#8c1c13');
  assert.ok(chunks.length > 1 && chunks.every((chunk) => cleanInk(chunk)), 'a long scribble needs several chunks, all valid');
  assert.ok(chunks.every((chunk) => Buffer.byteLength(JSON.stringify({ t: 'set', k: 'ink/' + 'u'.repeat(80) + '/' + 's'.repeat(24) + '/123456.99', e: { v: chunk, ver: [Date.now(), 'c0123456789'] } })) < 4096), 'each fits one 4 KiB message with the longest key');
  chunks.slice(1).forEach((chunk, index) => same(chunk.points.slice(0, 2), chunks[index].points.slice(-2), 'chunks share their joining point'));
  const unpacked = chunks.flatMap((chunk, index) => unpackInk(chunk).slice(index ? 1 : 0));
  assert.strictEqual(unpacked.length, 700, 'no point lost'); near(unpacked[699].x, Math.round(scribble[699].x * INK_STEPS_PER_CELL) / INK_STEPS_PER_CELL, 'snapped to the ink grid');
  assert.strictEqual(chunks[0].points.length, 2 * LIMITS.INK_POINTS_PER_CHUNK);
});
test('tabletop: the event gate lets a burst through and then holds the flood, per peer, until the window passes', () => {
  const allow = Kit.tabletop.eventGate(), { EVENTS_PER_WINDOW, EVENT_WINDOW_SECONDS } = Kit.tabletop.LIMITS;
  const accepted = Array.from({ length: EVENTS_PER_WINDOW + 5 }, () => allow('spammer', 10)).filter(Boolean).length;
  assert.strictEqual(accepted, EVENTS_PER_WINDOW); assert.strictEqual(allow('someone-else', 10), true, 'another peer is unaffected');
  assert.strictEqual(allow('spammer', 10 + EVENT_WINDOW_SECONDS + 0.01), true, 'and the gate reopens');
});
test('tabletop.seat refuses a participant\'s own forbidden writes before they are sent; presence is cleaned field by field', () => {
  const { KEYS, seat, starterEntries, cleanPresence } = Kit.tabletop;
  const hub = Kit.net.loopback();
  const stamped = (id) => Kit.net.withSender(hub.join(id), (sender) => ({ admin: sender.by === 'gm' }));
  const gm = seat(stamped('gm'), { by: 'gm', isGm: () => true }), ana = seat(stamped('ana'), { by: 'ana', isGm: () => false }), ghost = seat(stamped('ghost'), { by: null, isGm: () => false });
  starterEntries({ wren: 'ana' }).forEach(([key, value]) => assert.strictEqual(gm.put(key, value), true)); drain(gm.net, ana.net, ghost.net);
  const wren = ana.read(KEYS.token('wren'));
  assert.strictEqual(ana.put(KEYS.token('wren'), { ...wren, x: 3 }), true); assert.strictEqual(ana.read(KEYS.token('wren')).x, 3);
  assert.strictEqual(ana.put(KEYS.mapRow('cellars', 0), '....'), false, 'refused'); assert.strictEqual(ana.read(KEYS.mapRow('cellars', 0))[0], '#', 'and not applied locally either');
  assert.strictEqual(ana.mayPut(KEYS.token('ash'), { ...ana.read(KEYS.token('ash')), owner: 'ana' }), true, 'mayPut asks without writing'); assert.strictEqual(ana.read(KEYS.token('ash')).owner, null);
  assert.strictEqual(ana.put(KEYS.token('wren'), undefined), false, 'undefined means delete, and players do not delete tokens');
  assert.strictEqual(ghost.put(KEYS.token('ash'), { ...ghost.read(KEYS.token('ash')), owner: 'ghost' }), false, 'no identity, no writes');
  assert.strictEqual(gm.put(KEYS.token('tam'), undefined), true); assert.strictEqual(gm.read(KEYS.token('tam')), undefined);
  same(cleanPresence({ name: 'Ana', color: '#AABBCC', scene: 'yard', cursor: [1.5, 2], drag: ['wren', 3, 4], ruler: [0, 0, 5, 5], area: ['circle', 4, 4, 3] }), { name: 'Ana', color: '#AABBCC', scene: 'yard', cursor: { x: 1.5, y: 2 }, drag: { id: 'wren', x: 3, y: 4 }, ruler: [{ x: 0, y: 0 }, { x: 5, y: 5 }], area: { shape: 'circle', x: 4, y: 4, radius: 3 } });
  const nothing = { name: '', color: null, scene: null, cursor: null, drag: null, ruler: null, area: null };
  same(cleanPresence({ name: '<img onerror=x>'.repeat(3), color: 'javascript:1', scene: 'a/b', cursor: [1, NaN], drag: [7, 1, 1], ruler: [0, 0, 1e9, 0], area: ['constructor', 1, 1, 2] }), nothing, 'each bad field is dropped on its own');
  same(cleanPresence({ area: ['circle', 1, 1, 99] }), nothing, 'an area larger than the limit'); same(cleanPresence(undefined), nothing);
});
test('tabletop: light levels for players and game masters; a scripted stroll stays on open, free, reachable ground', () => {
  const { lightLevels, strollRoute, boardOf, tokensOf, isWalkable, starterEntries, seat } = Kit.tabletop;
  const levels = { inView: 1, remembered: 0.3, unseen: 0, gmUnseen: 0.5 };
  const visible = Uint8Array.from([1, 0, 0]), explored = Uint8Array.from([1, 1, 0]);
  same(Array.from(lightLevels(visible, explored, false, levels)).map((level) => Math.round(level * 10)), [10, 3, 0], 'player: in view, remembered, never seen');
  same(Array.from(lightLevels(visible, explored, true, levels)).map((level) => Math.round(level * 10)), [10, 5, 5], 'game master: nothing is black');
  const table = seat(Kit.net.loopback().join('gm'), { by: 'gm', isGm: () => true });
  starterEntries().forEach(([key, value]) => table.net.set(key, value));
  const board = boardOf(table.read, 'cellars'), tokens = tokensOf(table.net, 'cellars'), wren = new Map(tokens).get('wren');
  Array.from({ length: 25 }, (unused, seed) => strollRoute(board, tokens, wren, Kit.rng(seed), 4)).forEach((route) => {
    const end = route[route.length - 1];
    assert.ok(route.length > 1 && route[0].x === wren.x && route[0].y === wren.y, 'starts at the token and goes somewhere');
    assert.ok(route.every((cell) => isWalkable(board.get(cell.x, cell.y))), 'never through a wall or a crate');
    assert.ok(!tokens.some(([, other]) => other.x === end.x && other.y === end.y) && Math.abs(end.x - wren.x) <= 4 && Math.abs(end.y - wren.y) <= 4, 'ends on a free cell within reach');
  });
  const boxedIn = Kit.grid.parse(['###', '#.#', '###'], { '#': Kit.tabletop.TERRAIN['#'], '.': Kit.tabletop.TERRAIN['.'] });
  assert.strictEqual(strollRoute(boxedIn, [], { x: 1, y: 1 }, Kit.rng(1), 4), null, 'nowhere to go');
});
test('measure.area: bursts follow the distance rule, blocks are square, sizes are exact', () => {
  const centre = { x: 5, y: 5 }, cellsOf = (shape, radius, rule) => Kit.measure.area(shape, centre, radius, rule);
  assert.strictEqual(cellsOf('circle', 2, 'alternating').length, 21, '5-10-5: the corners two diagonals away cost three and are left out');
  assert.strictEqual(cellsOf('circle', 2, 'equal').length, 25, 'when diagonals cost one a burst is a square');
  assert.strictEqual(cellsOf('circle', 2, 'manhattan').length, 13, 'a diamond'); assert.strictEqual(cellsOf('square', 1).length, 9);
  assert.strictEqual(cellsOf('circle', 0).length, 1, 'radius zero is the centre cell'); same(cellsOf('circle', 0)[0], { x: 5, y: 5 });
  assert.ok(cellsOf('circle', 3).every((cell) => Kit.measure.between(centre, cell) <= 3) && cellsOf('circle', 3).some((cell) => cell.x === 8 && cell.y === 5));
  assert.throws(() => cellsOf('cone', 2), /unknown area shape/);
});
test('tabletop automations: harm clamps and marks "down", areas pick who is caught, the party travels to free cells by the entry', () => {
  const { harmed, tokensOn, partyTravel, arrivalCells, boardOf, tokensOf, cleanScene, cleanToken, starterEntries, blankSceneEntries, seat, KEYS, isWalkable } = Kit.tabletop;
  const table = seat(Kit.net.loopback().join('gm'), { by: 'gm', isGm: () => true });
  starterEntries().forEach(([key, value]) => table.net.set(key, value));
  const wren = cleanToken(table.read(KEYS.token('wren')));
  same([harmed(wren, 5).hp, harmed(wren, 500).hp, harmed(wren, -500).hp, harmed(wren, 2.6).hp], [13, 0, 22, 15], 'clamped to 0..max, rounded');
  assert.ok(harmed(wren, 500).conditions.includes('down') && cleanToken(harmed(wren, 500)), 'dropping to zero marks the token down, and it is still a valid token');
  same(harmed({ ...harmed(wren, 500), conditions: ['down', 'shaken'] }, -1).conditions, ['shaken'], 'healing above zero stands it up and keeps other conditions');
  same(harmed(harmed(wren, 500), 3).conditions, ['down'], 'harm on a downed token does not mark it twice');
  const inCellars = tokensOf(table.net, 'cellars');
  same(tokensOn(inCellars, Kit.measure.area('circle', { x: 3, y: 15 }, 1)).sort(), ['ash', 'ivy', 'wren'], 'a 5 ft burst centred between them catches three of the party');
  same(tokensOn(inCellars, []), []);
  const yard = boardOf(table.read, 'yard'), yardScene = cleanScene(table.read(KEYS.scene('yard')));
  const moves = partyTravel(tokensOf(table.net), yard, yardScene, 'yard');
  same(moves.map(([id]) => id).sort(), ['ash', 'ivy', 'tam', 'wren'], 'only player characters travel');
  assert.ok(moves.every(([, token]) => token.scene === 'yard' && isWalkable(yard.get(token.x, token.y)) && cleanToken(token)), 'onto open ground of the new scene');
  assert.strictEqual(new Set(moves.map(([, token]) => `${token.x},${token.y}`)).size, 4, 'each on a cell of their own');
  same([moves[0][1].x, moves[0][1].y], [yardScene.entry.x, yardScene.entry.y], 'the first arrives on the entry itself');
  moves.forEach(([id, token]) => table.put(KEYS.token(id), token));
  assert.strictEqual(partyTravel(tokensOf(table.net), yard, yardScene, 'yard').length, 0, 'travelling twice moves nobody');
  const crowded = arrivalCells(yard, yardScene.entry, tokensOf(table.net, 'yard'), 3);
  assert.ok(crowded.every((cell) => !moves.some(([, token]) => token.x === cell.x && token.y === cell.y)), 'occupied cells are not offered again');
  const blank = new Map(blankSceneEntries('vault', 'The Vault')), blankBoard = boardOf((key) => blank.get(key), 'vault');
  assert.ok(cleanScene(blank.get(KEYS.scene('vault'))) && isWalkable(blankBoard.get(1, 1)) && !isWalkable(blankBoard.get(0, 0)), 'a new scene is open floor inside a wall');
  const tiny = Kit.grid.parse(['#.#'], { '#': Kit.tabletop.TERRAIN['#'], '.': Kit.tabletop.TERRAIN['.'] });
  assert.strictEqual(partyTravel(tokensOf(table.net).map(([id, token]) => [id, { ...token, scene: 'cellars' }]), tiny, { entry: { x: 1, y: 0 } }, 'tiny').length, 1, 'a scene with one free cell takes one traveller; the rest stay put');
});
// ---- end of tabletop kit tests ----
// ---- crowd + craft (kit/crowd.js, kit/craft.js): crowd pathing, grid collision, view sync, build-crafting decisions ----
for (const f of ['crowd', 'craft']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
test('crowd.flow: distances route around walls, cut-off cells are unreachable, goals are open', () => {
  const grid = Kit.grid.parse(['.....', '.###.', '..G#.', '.###.', '....#'], { '#': 'wall' });
  const isOpen = (cell) => cell !== 'wall';
  const field = Kit.crowd.flow(grid, [{ x: 2, y: 2 }, { x: 99, y: 99 }], isOpen, { diagonal: false });
  assert.strictEqual(field.distanceAt(2, 2), 0, 'goal');
  assert.strictEqual(field.distanceAt(1, 2), 1, 'beside goal');
  assert.strictEqual(field.distanceAt(4, 2), 10, 'the far side of the wall is a long walk, not 2 steps');
  assert.strictEqual(field.distanceAt(2, 1), Infinity, 'walls are never entered');
  assert.strictEqual(field.distanceAt(-1, 0), Infinity, 'outside the grid');
  assert.strictEqual(field.next(2, 2), null, 'no step at the goal');
  same({ ...field.next(0, 2) }, { x: 1, y: 2 }, 'steps toward the goal');
  let cell = { x: 4, y: 2 }, steps = 0;
  while (field.next(cell.x, cell.y)) { cell = field.next(cell.x, cell.y); assert.ok(isOpen(grid.get(cell.x, cell.y)), 'never steps into a wall'); steps++; }
  assert.strictEqual(steps, 10, 'following next() reaches the goal in distanceAt steps');
  const sealed = Kit.grid.parse(['G#.'], { '#': 'wall' });
  const sealedField = Kit.crowd.flow(sealed, [{ x: 0, y: 0 }], isOpen);
  assert.strictEqual(sealedField.distanceAt(2, 0), Infinity); assert.strictEqual(sealedField.next(2, 0), null, 'cut off');
  const onWall = Kit.crowd.flow(sealed, [{ x: 1, y: 0 }], isOpen);
  assert.strictEqual(onWall.distanceAt(2, 0), 1, 'a goal standing on a blocked cell still attracts its neighbours');
});
test('crowd.flow: diagonal steps never cut a wall corner', () => {
  const grid = Kit.grid.parse(['G#', '..'], { '#': 'wall' });
  const field = Kit.crowd.flow(grid, [{ x: 0, y: 0 }], (cell) => cell !== 'wall');
  assert.strictEqual(field.distanceAt(1, 1), 2, 'around the corner, not through it');
  same({ ...field.next(1, 1) }, { x: 0, y: 1 });
  const open = Kit.grid(2, 2);
  assert.strictEqual(Kit.crowd.flow(open, [{ x: 0, y: 0 }], () => true).distanceAt(1, 1), 1, 'an open diagonal is one step');
});
test('crowd.slide: stops at walls, slides along them, treats the outside as blocked', () => {
  const grid = Kit.grid.parse(['...', '.#.', '...'], { '#': 'wall' }, { cell: 2 }); // wall cell spans x,z in [-1, 1]
  const isBlocked = (cell) => cell === 'wall';
  const start = { x: -2, z: 0 };
  near(Kit.crowd.slide(grid, isBlocked, start, { x: 0.3, z: 0 }, 0.4).x, -1.7, 'free move');
  const blocked = Kit.crowd.slide(grid, isBlocked, { x: -1.5, z: 0 }, { x: 0.3, z: 0.2 }, 0.4);
  near(blocked.x, -1.5, 'x refused: the circle edge would enter the wall'); near(blocked.z, 0.2, 'z still moves: sliding');
  near(Kit.crowd.slide(grid, isBlocked, { x: -2.5, z: 0 }, { x: -0.3, z: 0 }, 0.4).x, -2.5, 'cannot leave the grid');
  same(start, { x: -2, z: 0 }, 'input position untouched');
  assert.strictEqual(Kit.crowd.isCircleBlocked(grid, isBlocked, 1.3, 0, 0.4), true, 'overlap by radius alone counts');
  assert.strictEqual(Kit.crowd.isCircleBlocked(grid, isBlocked, 1.5, 0, 0.4), false);
});
test('crowd.buckets: finds every neighbour in range, skips far ones, handles negatives and bucket edges', () => {
  const hash = Kit.crowd.buckets(2);
  const points = [{ id: 'origin', x: 0, z: 0 }, { id: 'close', x: 1.9, z: 0 }, { id: 'acrossEdge', x: 2.1, z: 0 }, { id: 'negative', x: -0.1, z: -0.1 }, { id: 'far', x: 30, z: 30 }];
  hash.fill(points);
  const idsNear = (x, z, radius) => hash.near(x, z, radius).map((point) => point.id).sort().join();
  assert.strictEqual(idsNear(0, 0, 0.5), 'close,negative,origin', 'a query on a bucket corner reads the buckets on both sides');
  assert.strictEqual(idsNear(2, 0, 0.2), 'acrossEdge,close,origin', 'neighbours across a bucket edge are found');
  assert.strictEqual(idsNear(30, 30, 1), 'far');
  assert.strictEqual(idsNear(-20, -20, 1), '', 'empty space');
  const exact = (centre, radius) => points.filter((point) => Math.hypot(point.x - centre.x, point.z - centre.z) <= radius).map((point) => point.id).sort().join();
  const filtered = (centre, radius) => hash.near(centre.x, centre.z, radius).filter((point) => Math.hypot(point.x - centre.x, point.z - centre.z) <= radius).map((point) => point.id).sort().join();
  [[{ x: 0, z: 0 }, 2.05], [{ x: 1, z: 1 }, 3], [{ x: -3, z: -3 }, 5], [{ x: 29, z: 31 }, 2]].forEach(([centre, radius]) => assert.strictEqual(filtered(centre, radius), exact(centre, radius), 'never misses a point inside the circle'));
  hash.fill([points[4]]);
  assert.strictEqual(idsNear(0, 0, 3), '', 'fill forgets what was filed before');
  assert.throws(() => Kit.crowd.buckets(0), /bucketSize must be a positive number/);
});
test('crowd.views: acquires once per entity, releases the gone, places the living', () => {
  const log = [];
  const sync = Kit.crowd.views((entity) => (log.push('get ' + entity.id), { for: entity.id }), (view) => log.push('release ' + view.for));
  const placed = [];
  sync([{ id: 1 }, { id: 2 }], (view, entity) => placed.push(view.for === entity.id));
  sync([{ id: 2 }, { id: 3 }], (view, entity) => placed.push(view.for === entity.id));
  same(log, ['get 1', 'get 2', 'release 1', 'get 3']);
  same(placed, [true, true, true, true]);
  sync([], () => assert.fail('nothing to place')); same(log.slice(4), ['release 2', 'release 3']);
});
test('craft.nodeStatus / treeLayout: statuses follow prerequisites, wallet and caps; edges light up', () => {
  const rows = [
    { id: 'edge', row: 0, col: 0, max: 2, cost: 2 }, { id: 'reap', row: 1, col: 0, max: 1, cost: 5, requires: ['edge'] },
    { id: 'vigor', row: 0, col: 2, max: 1, cost: 50 }, { id: 'both', row: 2, col: 1, cost: 1, requires: ['edge', 'vigor'] },
  ];
  const wallet = Kit.wallet({ souls: 4 }); // rows name no currency, so they spend the wallet's default one
  const tree = Kit.upgrades(rows.map((row) => ({ ...row, currency: 'souls' })), { wallet });
  const statuses = () => Kit.craft.treeLayout(tree).nodes.map((node) => node.status);
  same(statuses(), ['available', 'locked', 'short', 'locked']);
  tree.buy('edge'); // 2 left, next level costs 2
  same(statuses(), ['available', 'short', 'short', 'locked'], 'reap unlocked but 5 > 2');
  tree.buy('edge'); // 0 left
  assert.strictEqual(Kit.craft.nodeStatus(tree, 'edge'), 'maxed');
  wallet.add(5, 'souls'); tree.buy('reap'); wallet.add(1, 'souls');
  assert.strictEqual(Kit.craft.nodeStatus(tree, 'reap'), 'maxed');
  assert.strictEqual(Kit.craft.nodeStatus(tree, 'both'), 'locked', 'needs every prerequisite, not just one');
  const layout = Kit.craft.treeLayout(tree);
  assert.strictEqual(layout.columns, 3); assert.strictEqual(layout.tiers, 3);
  same(layout.edges.map((edge) => `${edge.from}>${edge.to}:${edge.isActive}`), ['edge>reap:true', 'edge>both:true', 'vigor>both:false']);
  assert.strictEqual(layout.nodes[0].level, 2); assert.strictEqual(layout.nodes[2].cost, 50);
  assert.throws(() => Kit.craft.treeLayout(Kit.upgrades([{ id: 'lost', col: 0 }])), /"lost" needs integer row and col/);
});
test('craft.reel lands on the winner and fills only from weighted entries', () => {
  const entries = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'never', weight: 0 }];
  const { strip, landIndex } = Kit.craft.reel(entries, entries[0], { length: 30, rng: Kit.rng(5) });
  assert.strictEqual(strip[landIndex], entries[0]); assert.strictEqual(landIndex, 30);
  assert.ok(strip.length > landIndex + 1, 'rows follow the winner so the window is never empty below it');
  assert.ok(!strip.some((entry) => entry.id === 'never'), 'zero-weight rows never flash by');
  assert.ok(strip.filter((entry) => entry.id === 'b').length > strip.filter((entry) => entry.id === 'a').length, 'filler follows the weights');
  const seededIds = () => Kit.craft.reel(entries, entries[1], { length: 6, rng: Kit.rng(9) }).strip.map((entry) => entry.id).join();
  assert.strictEqual(seededIds(), seededIds(), 'the same seed gives the same strip');
  assert.throws(() => Kit.craft.reel(entries, { id: 'stranger' }), /winner must be one of the entries/);
});
test('craft.pity caps a losing streak and resets on a hit', () => {
  const pity = Kit.craft.pity(3), rng = Kit.rng(1);
  const rolls = Array.from({ length: 8 }, () => pity.roll(0, rng));
  same(rolls, [false, false, false, true, false, false, false, true], 'the 4th roll after 3 misses always hits');
  assert.strictEqual(Kit.craft.pity(3).roll(1, rng), true); assert.strictEqual(Kit.craft.pity(0).roll(0, rng), true, 'limit 0: always');
  const streak = Kit.craft.pity(5); streak.roll(0, rng); streak.roll(0, rng); assert.strictEqual(streak.misses(), 2);
  streak.roll(1, rng); assert.strictEqual(streak.misses(), 0, 'a hit resets the streak');
});
test('craft.compareLines: sign, percent, direction and noise', () => {
  const lines = Kit.craft.compareLines({ damage: 2.54, cooldown: -0.4, speed: -1, luck: 0.12, noise: 0.001 },
    { labels: { damage: 'Damage' }, percent: ['luck'], lowerIsBetter: ['cooldown'] });
  same(lines.map((line) => line.text), ['+2.5 Damage', '-0.4 cooldown', '-1 speed', '+12% luck']);
  same(lines.map((line) => line.isBetter), [true, true, false, true]);
  same(Kit.craft.compareLines({}), []);
});
test('loot.augment: merges a curse into a rolled item without touching the original', () => {
  const loot = Kit.loot({ rng: Kit.rng(3), rarities: [{ id: 'worn', name: 'Worn', weight: 1, affixes: 0, mult: 1 }],
    bases: [{ id: 'knife', name: 'Knife', slot: 'weapon', mods: { damage: { add: 2 } } }] });
  const item = loot.roll({ level: 0 });
  const curse = { id: 'hollow', prefix: 'Hollow', flags: { isCursed: true }, mods: { damage: { mul: 1.5 }, maxHp: { add: -30 } } };
  const cursed = Kit.loot.augment(item, curse, 2);
  assert.strictEqual(cursed.name, 'Hollow Knife'); assert.strictEqual(cursed.isCursed, true); assert.strictEqual(cursed.uid, item.uid);
  same([...cursed.affixes], ['hollow']);
  near(cursed.mods.damage.add, item.mods.damage.add, 'base add kept'); near(cursed.mods.damage.mul, 2, 'mul bonus doubled by strength');
  near(cursed.mods.maxHp.add, -60, 'drawback scales too');
  assert.strictEqual(item.name, 'Knife'); assert.strictEqual(item.mods.maxHp, undefined, 'original untouched');
  const stats = Kit.stats({ damage: 10, maxHp: 100 }); stats.mod('eq', cursed.mods);
  near(stats.get('damage'), (10 + item.mods.damage.add) * 2, 'plugs into Kit.stats'); near(stats.get('maxHp'), 40, 'drawback applies');
});
// ---- lanes + scrub (kit/lanes.js, kit/scrub.js) ----
for (const f of ['lanes', 'scrub']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
atest('lanes: open lists unblocked lanes; reachable needs one continuous route, not just compatible neighbours', async () => {
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  same(Kit.lanes.open(['block', null, 'barrier'], (cell) => cell === 'block'), [1, 2], 'only blocks close a lane');
  same(Kit.lanes.open(['a', 'b', 'c'], (cell, lane) => lane !== 1), [1], 'the predicate also receives the lane index');
  same(Kit.lanes.reachable([[1], [0, 1, 2], [0, 2]]), [0, 2], 'one lane per row reaches both sides');
  same(Kit.lanes.reachable([[0], [2]]), [], 'two lanes away is out of reach by default');
  // Every neighbouring pair shares a compatible lane (0 then 0, 2 then 2) but no single route exists: 0 -> 0 -> 2 is a two-lane jump.
  assert.strictEqual(Kit.lanes.isPassable([[0], [0, 2], [2]]), false, 'pairwise-compatible rows without a route are blocked');
  assert.strictEqual(Kit.lanes.isPassable([[0], [0, 2], [2]], { reach: 2 }), true, 'a longer reach opens the same rows');
  assert.strictEqual(Kit.lanes.isPassable([[0, 1], [], [0, 1, 2]]), false, 'a full wall blocks');
  assert.strictEqual(Kit.lanes.isPassable([]), true, 'no rows is trivially passable');
  same(Kit.lanes.reachable([]), [], 'no rows and no start reaches nothing');
  assert.throws(() => Kit.lanes.isPassable([{ lanes: [0] }]), /row 0 must be an array/, 'raw rows are refused with the fix named');
  assert.strictEqual(Kit.lanes.isPassable([[2]], { from: [0] }), false, 'a starting lane constrains the first row');
  assert.strictEqual(Kit.lanes.isPassable([[1]], { from: [0] }), true, 'the first row is within reach of the start');
  // reach as a function of the row being entered: only the hop into row 2 is allowed to be wide.
  const wideIntoRow = (wideRow) => ({ reach: (rowIndex) => (rowIndex === wideRow ? 2 : 1) });
  assert.strictEqual(Kit.lanes.isPassable([[0], [0], [2]], wideIntoRow(2)), true, 'wide hop where it is needed');
  assert.strictEqual(Kit.lanes.isPassable([[0], [0], [2]], wideIntoRow(1)), false, 'wide hop in the wrong place does not help');
});
atest('scrub: a CSS animation follows the game clock, holds while it is not advanced and resolves at the end', async () => {
  const clock = Kit.clock(), element = { style: {} };
  let finished = false;
  Kit.scrub(clock.tween, element, 2).then(() => (finished = true));
  assert.strictEqual(element.style.animationPlayState, 'paused'); assert.strictEqual(element.style.animationDuration, '2s');
  near(parseFloat(element.style.animationDelay), 0, 'starts at the first frame');
  clock.update(0.5); near(parseFloat(element.style.animationDelay), -0.5, 'playhead after half a game second');
  // A paused game simply stops calling update: the playhead must stay where it is however much real time passes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  near(parseFloat(element.style.animationDelay), -0.5, 'holds while the clock is not advanced');
  clock.update(0.25); near(parseFloat(element.style.animationDelay), -0.75, 'slow motion is just smaller steps');
  await Promise.resolve(); assert.strictEqual(finished, false, 'not finished early');
  clock.update(5); await Promise.resolve();
  near(parseFloat(element.style.animationDelay), -2, 'clamped to the last frame'); assert.strictEqual(finished, true, 'resolves once the end is reached');
  assert.throws(() => Kit.scrub(clock.tween, element, 0), /positive number of game seconds/); assert.throws(() => Kit.scrub(null, element, 1), /game-time tween/);
});
// ---- routes, followers, timers (kit/route.js, kit/timer.js) and the Ferry Lines simulation (games/ferry-sim.js) ----
{
  const load = (relativePath) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), sandbox, { filename: path.basename(relativePath) });
  ['kit/route.js', 'kit/timer.js', 'kit/meta.js', 'games/ferry-sim.js'].forEach(load);
  const { route, follow, timer, line } = Kit;
  // Values built inside the vm sandbox have another realm's prototypes, so compare them by their JSON.
  const same = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  const anchors = [{ id: 'west', x: 0, y: 0 }, { id: 'mid', x: 5, y: 0.3 }, { id: 'east', x: 10, y: 0 }];

  test('route.snap picks the nearest anchor within reach only', () => {
    assert.strictEqual(route.snap({ x: 4.2, y: 0 }, anchors, 1).id, 'mid');
    assert.strictEqual(route.snap({ x: 2.5, y: 0 }, anchors, 1), null, 'out of reach');
    assert.strictEqual(route.snap({ x: 2.4, y: 0 }, anchors, 9).id, 'west', 'nearest wins when several are in reach');
  });
  test('route.smooth keeps the ends and rounds the corner', () => {
    const corner = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }];
    const rounded = route.smooth(corner, 2);
    near(rounded[0].x, 0, 'start x'); near(rounded[rounded.length - 1].y, 4, 'end y');
    assert.ok(rounded.every((point) => line.dist(point, corner[1]) > 0.2), 'no point left on the sharp corner');
    assert.ok(line.length(rounded) < line.length(corner), 'cutting a corner shortens the line');
    assert.strictEqual(route.smooth(corner, 0).length, 3, 'zero passes is a copy');
  });
  test('route.capture snaps both ends, cleans the middle and lists stops in order', () => {
    const shaky = Array.from({ length: 41 }, (_, index) => ({ x: 0.3 + index * 0.235, y: 0.4 + Math.sin(index * 1.7) * 0.08 }));
    const captured = route.capture(shaky, { anchors, snapRadius: 1, stopRadius: 0.6, minLength: 1, tolerance: 0.25, step: 0.5 });
    assert.strictEqual(captured.ok, true); assert.strictEqual(captured.isLoop, false);
    near(captured.points[0].x, 0, 'starts on the west anchor'); near(captured.points[captured.points.length - 1].x, 10, 'ends on the east anchor');
    same(captured.stops.map((stop) => stop.id), ['west', 'mid', 'east'], 'passes the middle dock');
    near(captured.stops[0].along, 0, 'first stop at the start'); assert.ok(Math.abs(captured.stops[2].along - captured.length) < 1e-6, 'last stop at the end');
    assert.ok(captured.length < 10.5, 'jitter removed: ' + captured.length);
  });
  test('route.capture refuses with the reason', () => {
    const straight = [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 0 }];
    const options = { anchors, snapRadius: 1, minLength: 1 };
    assert.strictEqual(route.capture([{ x: 3, y: 3 }, { x: 10, y: 0 }], options).reason, 'no-start');
    assert.strictEqual(route.capture([{ x: 0, y: 0 }, { x: 7, y: 4 }], options).reason, 'no-end');
    assert.strictEqual(route.capture([{ x: 0, y: 0 }], options).reason, 'too-short');
    assert.strictEqual(route.capture([{ x: 0.2, y: 0 }, { x: 0.3, y: 0.1 }, { x: 0, y: 0.2 }], { ...options, minLoopLength: 4 }).reason, 'too-short', 'a wiggle on one dock is not a circuit');
    assert.strictEqual(route.capture(straight, { ...options, isBlocked: (point) => line.dist(point, { x: 5, y: 2 }) < 1 }).reason, 'blocked');
    assert.strictEqual(route.capture(straight, { ...options, isBlocked: (point) => line.dist(point, { x: 5, y: 6 }) < 1 }).ok, true, 'an obstacle off the route does not block');
  });
  test('route.capture keeps a closed stroke as a loop', () => {
    const circuit = Array.from({ length: 33 }, (_, index) => ({ x: 3 - 3 * Math.cos((index / 32) * Math.PI * 2), y: 3 * Math.sin((index / 32) * Math.PI * 2) }));
    const captured = route.capture(circuit, { anchors, snapRadius: 1, stopRadius: 0.5, minLoopLength: 4, tolerance: 0.1 });
    assert.strictEqual(captured.ok, true); assert.strictEqual(captured.isLoop, true);
    assert.ok(captured.length > 15 && captured.length < 19.5, 'the loop survives simplification: ' + captured.length);
    assert.strictEqual(captured.stops[0].id, 'west'); near(captured.stops[0].along, 0, 'home stop is at the start');
  });
  test('route.capture pins the route to a dock drawn through, even on a sharp corner that smoothing would round off', () => {
    const corner = [{ x: 0, y: 0 }, { x: 0.2, y: 3 }, { x: 0.1, y: 6 }, { x: 3, y: 6.2 }, { x: 6, y: 6 }];
    const docks = [{ id: 'start', x: 0, y: 0 }, { id: 'corner', x: 0, y: 6 }, { id: 'end', x: 6, y: 6 }];
    const captured = route.capture(corner, { anchors: docks, snapRadius: 1, stopRadius: 0.6, step: 0.5 });
    same(captured.stops.map((stop) => stop.id), ['start', 'corner', 'end']);
    const atCorner = line.at(captured.points, captured.stops[1].along);
    near(atCorner.x, 0, 'the route passes exactly through the corner dock (x)'); near(atCorner.y, 6, 'and (y)');
    near(captured.stops[2].along, captured.length, 'the last stop is the end of the route');
    assert.ok(line.nearest(route.clean(corner, { step: 0.5 }), docks[1]).d > 0.3, 'control: cleaning the whole stroke at once does drift off the dock');
  });
  test('route.ribbon offsets both edges half the width', () => {
    const edges = route.ribbon([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }], 1);
    assert.strictEqual(edges.length, 3);
    edges.forEach(({ left, right }) => { near(line.dist(left, right), 1, 'width'); near(left.x, right.x, 'edges are square to the line'); });
    assert.ok(edges[1].left.y > 0 && edges[1].right.y < 0, 'left and right are on opposite sides');
  });
  test('follow.advance: pingpong turns round, stops on marks and never re-hits the mark it rests on', () => {
    const track = { length: 10, mode: 'pingpong', marks: [0, 6, 10] };
    const leaving = follow.advance(follow.start(), 4, track);
    near(leaving.along, 4, 'moves'); assert.strictEqual(leaving.hit, -1, 'the mark under it at the start is not hit');
    const arriving = follow.advance(leaving, 5, track);
    near(arriving.along, 6, 'stops on the mark'); assert.strictEqual(arriving.hit, 1); near(arriving.left, 3, 'unused distance reported');
    const atEnd = follow.advance(arriving, 99, track);
    near(atEnd.along, 10, 'end mark'); assert.strictEqual(atEnd.hit, 2); assert.strictEqual(atEnd.direction, 1);
    const back = follow.advance(atEnd, 3, track);
    near(back.along, 7, 'turned round'); assert.strictEqual(back.direction, -1); assert.strictEqual(back.hit, -1);
    const bounced = follow.advance({ along: 8, direction: 1 }, 5, { length: 10 });
    near(bounced.along, 7, 'reflects off the end'); assert.strictEqual(bounced.direction, -1);
    const laps = follow.advance({ along: 2, direction: 1 }, 20 * 1000 + 3, { length: 10 });
    near(laps.along, 5, 'whole laps cancel'); assert.strictEqual(laps.direction, 1);
    assert.strictEqual(follow.advance(follow.start(), 5, { length: 0 }).along, 0, 'a zero-length track goes nowhere');
  });
  test('follow.advance: loop wraps and meets its home mark once per lap', () => {
    const track = { length: 10, mode: 'loop', marks: [0, 4] };
    const first = follow.advance(follow.start(), 6, track);
    near(first.along, 4, 'first mark'); assert.strictEqual(first.hit, 1);
    const home = follow.advance(first, 7, track);
    assert.strictEqual(home.hit, 0, 'wraps to the home mark'); near(home.left, 1, 'left over');
    const again = follow.advance(home, 3, track);
    near(again.along, 3, 'keeps going the same way'); assert.strictEqual(again.direction, 1);
    near(follow.advance({ along: 9, direction: 1 }, 2.5, { length: 10, mode: 'loop' }).along, 1.5, 'plain wrap');
  });
  test('follow.pose reverses the heading on the way back', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    near(follow.pose(points, { along: 3, direction: 1 }).tx, 1, 'out'); near(follow.pose(points, { along: 3, direction: -1 }).tx, -1, 'back');
    near(follow.pose(points, { along: 3, direction: -1 }).x, 3, 'same place either way');
  });
  test('timer: tick, fraction, expiry and tickAll', () => {
    const fresh = timer.start(10);
    near(timer.fraction(fresh), 1, 'fresh'); near(timer.fraction(timer.tick(fresh, 4)), 0.6, 'ticked'); near(fresh.left, 10, 'input untouched');
    assert.strictEqual(timer.isExpired(timer.tick(fresh, 10)), true, 'exactly zero is expired'); near(timer.tick(fresh, 99).left, 0, 'never negative');
    near(timer.fraction(timer.start(0)), 0, 'zero duration');
    const { running, expired } = timer.tickAll([{ id: 'a', timer: timer.start(1) }, { id: 'b', timer: timer.start(5) }], 2);
    same(expired.map((item) => item.id), ['a']); same(running.map((item) => item.id), ['b']); near(running[0].timer.left, 3, 'ticked copy');
  });
  test('timer.cycle fires once per period and carries the remainder', () => {
    const half = timer.cycle(timer.start(2), 1.5);
    assert.strictEqual(half.fired, 0); near(half.timer.left, 0.5, 'counting down');
    const once = timer.cycle(half.timer, 1);
    assert.strictEqual(once.fired, 1); near(once.timer.left, 1.5, 'overshoot carried');
    const many = timer.cycle(timer.start(2), 7);
    assert.strictEqual(many.fired, 3, '2, 4 and 6 seconds'); near(many.timer.left, 1, 'next at 8');
    assert.strictEqual(timer.cycle(timer.start(2), 2).fired, 1, 'exactly on the period');
    assert.strictEqual(timer.cycle(timer.start(0), 5).fired, 0, 'a zero period never fires');
  });

  const sim = sandbox.FERRY_SIM;
  const context = (dt, overrides = {}) => ({ dt, speed: 2, holdBonus: 0, dwellScale: 1, random: () => 0, pickKind: () => sim.ORDER_KINDS.byId('single'), ...overrides });
  const straightRoute = (world, islandIds, classId) => {
    const chart = sim.chartOf(world), points = islandIds.map((islandId) => ({ x: chart.docks.byId(islandId).x, y: chart.docks.byId(islandId).y }));
    const alongs = points.map((_, index) => line.length(points.slice(0, index + 1)));
    return sim.addRoute(world, { points, length: line.length(points), isLoop: false, stops: islandIds.map((id, index) => ({ id, along: alongs[index] })) }, context(0), classId);
  };
  const run = (world, seconds, overrides) => {
    const events = [];
    for (let elapsed = 0; elapsed < seconds; elapsed += 0.05) { const stepped = sim.step(world, context(0.05, overrides)); world = stepped.world; events.push(...stepped.events); }
    return { world, events };
  };
  const order = (id, islandId, goods, left = 20, kindId = 'single') => ({ id, islandId, kindId, goods, needs: goods, timer: { duration: 40, left } });
  const island = (chartId, islandId) => sim.CHARTS.byId(chartId).islands.byId(islandId);

  test('ferry: the first order is placed at once and the opening islands are out of the fog', () => {
    const { world, events } = run(sim.createWorld(), 1);
    assert.strictEqual(world.docks.pinewick.isRevealed, true); assert.strictEqual(world.docks.saffron.isRevealed, false);
    assert.strictEqual(world.orders.length, 1); same(world.orders[0].goods, ['timber'], 'only timber is being made');
    assert.strictEqual(world.orders[0].islandId, 'harrow'); assert.ok(events.some((event) => event.type === 'ordered'));
  });
  test('ferry: a new boat loads at its first stop, sails, delivers and is paid with a speed bonus', () => {
    const launched = straightRoute(run(sim.createWorld(), 1).world, ['pinewick', 'harrow']);
    same(launched.world.boats[0].cargo, ['timber', 'timber'], 'a Packet loads two crates on launch');
    assert.strictEqual(launched.world.docks.pinewick.stock, 0); assert.ok(launched.events.some((event) => event.type === 'loaded'));
    const { world, events } = run(launched.world, 3);
    const delivered = events.find((event) => event.type === 'delivered');
    assert.ok(delivered, 'the order is filled'); assert.ok(delivered.coins > sim.GOODS.byId('timber').price, 'speed bonus on top of the price: ' + delivered.coins);
    assert.ok(events.some((event) => event.type === 'sold' && event.coins === sim.RULES.marketPrice), 'the spare crate goes to market');
    assert.strictEqual(world.orders.filter((open) => open.id === delivered.order.id).length, 0); assert.strictEqual(world.hearts, 3);
  });
  test('ferry: unloadCargo fills orders oldest first, sells accepted spares and keeps the rest aboard', () => {
    const orders = [order(1, 'harrow', ['timber'], 10), order(2, 'harrow', ['timber'], 30), order(3, 'gullrock', ['timber'])];
    const result = sim.unloadCargo(['timber', 'citrus'], orders, island('sound', 'harrow'));
    same(result.delivered.map((entry) => entry.order.id), [1], 'the older order wins the only timber');
    assert.strictEqual(result.sold, 1, 'citrus nobody ordered is sold'); same(result.cargo, []);
    same(result.orders.map((open) => open.id), [2, 3], 'other orders untouched');
    same(sim.unloadCargo(['timber'], orders, island('sound', 'pinewick')).cargo, ['timber'], 'a producer buys nothing');
  });
  test('ferry: festival orders fill crate by crate and pay their multiplier; a lapsed rush costs no lifebuoy', () => {
    const half = sim.unloadCargo(['timber'], [order(7, 'harrow', ['timber', 'citrus'], 0, 'festival')], island('sound', 'harrow'));
    assert.strictEqual(half.delivered.length, 0); same(half.orders[0].needs, ['citrus'], 'half filled and still open');
    const full = sim.unloadCargo(['citrus'], half.orders, island('sound', 'harrow'));
    assert.strictEqual(full.delivered[0].coins, (6 + 8) * 3, 'no patience left: triple the summed prices, no bonus');
    assert.strictEqual(sim.orderReward(order(8, 'harrow', ['timber'], 40)), 9, 'full patience: price x 1.5');
    const lapsed = run({ ...sim.createWorld(), orders: [order(1, 'harrow', ['timber'], 0.2, 'rush'), order(2, 'harrow', ['timber'], 0.2)] }, 0.5);
    assert.strictEqual(lapsed.events.filter((event) => event.type === 'expired').length, 2, 'both lapse');
    assert.strictEqual(lapsed.world.hearts, 2, 'only the ordinary order costs a lifebuoy');
  });
  test('ferry: loadCargo respects capacity, stock and what the route can sell or supply', () => {
    const sound = sim.CHARTS.byId('sound'), narrows = sim.CHARTS.byId('narrows');
    const toTown = { stops: [{ id: 'pinewick' }, { id: 'harrow' }] }, toProducer = { stops: [{ id: 'pinewick' }, { id: 'saffron' }] };
    same(sim.loadCargo(sound, ['citrus'], 4, island('sound', 'pinewick'), toTown, 3), { cargo: ['citrus', 'timber', 'timber'], stock: 2, loaded: 2 });
    assert.strictEqual(sim.loadCargo(sound, [], 1, island('sound', 'pinewick'), toTown, 3).loaded, 1, 'limited by stock');
    assert.strictEqual(sim.loadCargo(sound, ['a', 'b', 'c'], 4, island('sound', 'pinewick'), toTown, 3).loaded, 0, 'a full hold loads nothing');
    assert.strictEqual(sim.loadCargo(sound, [], 4, island('sound', 'pinewick'), toProducer, 3).loaded, 0, 'nobody on the route takes timber');
    assert.strictEqual(sim.loadCargo(narrows, [], 4, island('narrows', 'alderholm'), { stops: [{ id: 'alderholm' }, { id: 'kettle' }] }, 3).loaded, 3, 'a mill on the route takes timber');
    assert.strictEqual(sim.loadCargo(narrows, [], 4, island('narrows', 'alderholm'), { stops: [{ id: 'alderholm' }, { id: 'marrow' }] }, 3).loaded, 0, 'Narrows towns do not buy logs');
  });
  test('ferry: a mill makes planks only from timber delivered to it, and holds a limited pile', () => {
    const idle = run(sim.createWorld('narrows'), 12);
    assert.strictEqual(idle.world.docks.kettle.stock, 0, 'a starved mill makes nothing');
    assert.ok(idle.world.orders.length > 0 && idle.world.orders.every((open) => open.goods[0] === 'planks'), 'only planks can be shipped: ' + JSON.stringify(idle.world.orders.map((open) => open.goods)));
    const supplied = sim.unloadCargo(['timber', 'timber', 'timber'], [], island('narrows', 'kettle'), sim.RULES.inputCap - 2);
    assert.strictEqual(supplied.supplied, 2, 'the pile is capped'); same(supplied.cargo, ['timber'], 'the crate that did not fit stays aboard');
    const fed = run(straightRoute(sim.createWorld('narrows'), ['alderholm', 'kettle']).world, 14, { pickKind: () => null });
    assert.ok(fed.world.docks.kettle.stock >= 2, 'planks appear once timber arrives: ' + fed.world.docks.kettle.stock);
    assert.ok(fed.events.some((event) => event.type === 'sold' && event.islandId === 'kettle'), 'supplying the mill pays the supply price');
    const chain = run(straightRoute(fed.world, ['kettle', 'marrow']).world, 12);
    assert.ok(chain.events.some((event) => event.type === 'delivered' && event.order.goods[0] === 'planks'), 'the second leg delivers the planks');
  });
  test('ferry: currents push with the flow, drag against it, ignore crossings, and tides turn on schedule', () => {
    const narrows = sim.CHARTS.byId('narrows'), race = narrows.currents[0];
    const heading = (tx, ty, x = 0) => ({ x, y: 0, tx, ty });
    near(sim.currentFactor(narrows, heading(0, -1), 0), 1 + race.strength, 'with the flow');
    near(sim.currentFactor(narrows, heading(0, 1), 0), 1 - race.strength, 'against it');
    near(sim.currentFactor(narrows, heading(1, 0), 0), 1, 'across it');
    near(sim.currentFactor(narrows, heading(0, -1, 4), 0), 1, 'outside the race');
    near(sim.currentFactor(narrows, heading(0, -1), race.period + 1), 1 - race.strength, 'after the tide has turned the same heading is slow');
    assert.strictEqual(sim.tideSign(sim.CHARTS.byId('reach').currents[0], 1e6), 1, 'a gyre never turns');
    assert.ok(sim.currentFactor({ currents: [{ ...race, strength: 5 }] }, heading(0, 1), 0) >= sim.RULES.currentFloor, 'a boat always makes headway');
    assert.strictEqual(run(sim.createWorld('narrows'), race.period + 1).events.filter((event) => event.type === 'tide').length, 1, 'one turn announced');
    assert.strictEqual(run(sim.createWorld('sound'), 30).events.filter((event) => event.type === 'tide').length, 0, 'still water has no tide');
  });
  test('ferry: one berth per dock - a second boat queues, then trades when the first leaves', () => {
    const first = straightRoute(sim.createWorld(), ['pinewick', 'harrow']).world;
    const second = straightRoute(first, ['pinewick', 'harrow']).world;
    assert.strictEqual(second.boats[0].mooredAt, 'pinewick'); assert.strictEqual(second.boats[1].queuedAt, 'pinewick', 'the berth is taken');
    same(second.boats[1].cargo, [], 'a queued boat has not traded');
    assert.strictEqual(sim.isBerthFree(second, 'pinewick', second.boats[1].id), false); assert.strictEqual(sim.isBerthFree(second, 'harrow', second.boats[1].id), true);
    const later = run(second, sim.RULES.dwellSeconds + 0.2, { pickKind: () => null }).world;
    assert.strictEqual(later.boats[1].queuedAt, null, 'it took the berth'); assert.strictEqual(later.boats[1].mooredAt, 'pinewick');
  });
  test('ferry: boat classes trade speed against hold, and refitting changes the boat on a route', () => {
    const fresh = sim.createWorld();
    const world = { ...fresh, docks: { ...fresh.docks, pinewick: { ...fresh.docks.pinewick, stock: 4 } } };
    const cutter = straightRoute(world, ['pinewick', 'harrow'], 'cutter').world, barge = straightRoute(world, ['pinewick', 'harrow'], 'barge').world;
    assert.strictEqual(cutter.boats[0].cargo.length, 1); assert.strictEqual(barge.boats[0].cargo.length, 4, 'a Barge takes the whole pier');
    assert.ok(cutter.boats[0].dwell < barge.boats[0].dwell, 'a Cutter is quicker at the berth');
    const alongAfter = (start) => run(start, 1.6, { pickKind: () => null }).world.boats[0].follower.along;
    assert.ok(alongAfter(cutter) > alongAfter(barge) + 1, 'and much quicker under way');
    assert.strictEqual(sim.refitBoat(cutter, cutter.routes[0].id, 'barge').boats[0].classId, 'barge');
    const unlocked = new Set(['barge']);
    assert.strictEqual(sim.nextClass('packet', (id) => unlocked.has(id)).id, 'barge', 'skips the locked Cutter');
    assert.strictEqual(sim.nextClass('barge', (id) => unlocked.has(id)).id, 'packet', 'wraps round');
    assert.strictEqual(sim.nextClass('packet', () => false).id, 'packet', 'nothing else to refit to');
  });
  test('ferry: an unmet order costs a lifebuoy, production stops at the cap, queues grow with the watch', () => {
    const { world, events } = run({ ...sim.createWorld(), orders: [order(1, 'harrow', ['timber'], 0.5)] }, 1);
    assert.strictEqual(world.hearts, 2); assert.strictEqual(events.filter((event) => event.type === 'expired').length, 1);
    const later = run(sim.createWorld(), 30).world;
    assert.strictEqual(later.docks.pinewick.stock, sim.RULES.stockCap); assert.strictEqual(later.docks.ironholt.stock, sim.RULES.startingStock, 'fog-bound islands do not produce');
    assert.strictEqual(sim.createWorld('reach').hearts, 2, 'Storm Reach has two lifebuoys');
    const full = { ...later, time: 10, orders: [order(1, 'harrow', ['timber']), order(2, 'harrow', ['timber'])] };
    assert.strictEqual(sim.planOrder(full, context(0)), null, 'early on a town queues two orders');
    assert.strictEqual(sim.planOrder({ ...full, time: 200 }, context(0)).islandId, 'harrow', 'later it queues a third');
  });
  test('ferry: islands appear on schedule or by chart, and festivals wait for two shippable goods', () => {
    const { world, events } = run(sim.createWorld(), 17);
    assert.strictEqual(world.docks.saffron.isRevealed, true); assert.strictEqual(events.filter((event) => event.type === 'revealed').length, 1, 'revealed once');
    assert.strictEqual(sim.nextUnchartedIsland(world).id, 'ironholt'); assert.strictEqual(sim.nextUnchartedIsland(sim.revealIsland(world, 'ironholt')), undefined);
    const wantFestival = context(0, { pickKind: () => sim.ORDER_KINDS.byId('festival') });
    assert.strictEqual(sim.planOrder(sim.createWorld(), wantFestival).kindId, 'single', 'one good in production: no festival yet');
    const festival = sim.planOrder({ ...world, orders: [] }, wantFestival);
    assert.strictEqual(festival.kindId, 'festival'); assert.strictEqual(new Set(festival.goods).size, 2, 'two different goods');
  });
  test('ferry: right of way, launch limit, land and route removal', () => {
    const pose = { x: 0, y: 0, tx: 1, ty: 0 };
    const traffic = (id, x, isUnderWay = true) => [{ id, isUnderWay, pose: { x, y: 0, tx: -1, ty: 0 } }];
    assert.strictEqual(sim.giveWayFactor({ id: 5 }, pose, traffic(2, 0.8)), sim.RULES.giveWaySlowdown, 'older boat ahead: slow');
    assert.strictEqual(sim.giveWayFactor({ id: 5 }, pose, traffic(9, 0.8)), 1, 'younger boat yields instead');
    assert.strictEqual(sim.giveWayFactor({ id: 5 }, pose, traffic(2, -0.8)), 1, 'behind the stern');
    assert.strictEqual(sim.giveWayFactor({ id: 5 }, pose, traffic(2, 3)), 1, 'far away');
    assert.strictEqual(sim.giveWayFactor({ id: 5 }, pose, traffic(2, 0.8, false)), 1, 'boats at a berth do not block');
    const launched = straightRoute(sim.createWorld(), ['pinewick', 'harrow']).world;
    assert.strictEqual(sim.canLaunch(launched, 1), false); assert.strictEqual(sim.canLaunch(launched, 2), true);
    const cleared = sim.removeRoute(launched, launched.routes[0].id);
    assert.strictEqual(cleared.routes.length + cleared.boats.length, 0);
    const sound = sim.CHARTS.byId('sound');
    assert.strictEqual(sim.isLand(sound, { x: -3.2, y: 5.2 }), true); assert.strictEqual(sim.isLand(sound, sound.docks.byId('pinewick')), false, 'docks are in open water');
    assert.strictEqual(sim.isLand(sound, { x: -2.9, y: -7 }), true, 'fog-bound islands are still shoals');
    same(sim.captureOptions(launched).anchors.map((anchor) => anchor.id), ['pinewick', 'harrow'], 'only charted docks can be drawn to');
    sim.CHARTS.forEach((chart) => chart.islands.forEach((row) => assert.strictEqual(sim.isLand(chart, chart.docks.byId(row.id)), false, `${chart.id}/${row.id}: dock must be in open water`)));
  });
  test('ferry: the long arc - events write the record, commissions unlock classes, cards and charts', () => {
    const unlocked = [], profile = sim.createProfile({ onUnlock: (id) => unlocked.push(id) });
    same(sim.availableCharts(profile.isUnlocked).map((chart) => chart.id), ['sound']); same(sim.availableClasses(profile.isUnlocked).map((row) => row.id), ['packet']);
    assert.strictEqual(sim.createYard('narrows', profile.isUnlocked).shipyard.table.has('crane'), false, 'the Crane card is locked');
    sim.recordEvents(profile, 'sound', [{ type: 'delivered', coins: 30, order: order(1, 'harrow', ['timber', 'citrus'], 5, 'festival') }, { type: 'sold', coins: 2 }, { type: 'loaded' }]);
    assert.strictEqual(profile.stat('takings'), 32); assert.strictEqual(profile.stat('deliveries:sound'), 1); assert.strictEqual(profile.stat('crates:citrus'), 1);
    same(unlocked, ['cutter'], 'the first festival unlocks the Cutter');
    for (let filled = 0; filled < 60; filled++) sim.recordEvents(profile, 'sound', [{ type: 'delivered', coins: 1, order: order(2, 'harrow', ['timber']) }]);
    assert.ok(unlocked.includes('narrows'), 'sixty deliveries on the Sound open The Narrows'); assert.strictEqual(profile.isUnlocked('reach'), false);
    for (let filled = 0; filled < 60; filled++) sim.recordEvents(profile, 'narrows', [{ type: 'delivered', coins: 1, order: order(3, 'marrow', ['planks']) }]);
    assert.strictEqual(sim.createYard('narrows', profile.isUnlocked).shipyard.table.has('crane'), true, 'sixty crates of planks unlock the Crane card');
    const finished = sim.finishWatch(profile, { chartId: 'sound', deliveries: 12, earned: 600, time: 150 });
    assert.strictEqual(finished.best, 12); assert.strictEqual(finished.ranksGained, 1); assert.strictEqual(sim.rankOf(profile.level), 'Boatswain');
    assert.strictEqual(sim.finishWatch(profile, { chartId: 'sound', deliveries: 5, earned: 0, time: 60 }).best, 12, 'a worse watch does not lower the best');
    assert.strictEqual(sim.rankOf(99), 'Harbour Master', 'rank is capped at the last title');
    assert.strictEqual(sim.createYard('sound', () => false).shipyard.table.byId('chart').max, 1, 'one fog-bound island to chart on the Sound');
    const yard = sim.createYard('sound', () => true); yard.wallet.add(1000); yard.shipyard.buy('crane'); yard.shipyard.buy('hold');
    const yardContext = sim.contextOf(yard.stats, { dt: 0.1 });
    near(yardContext.dwellScale, 0.65, 'crane'); assert.strictEqual(yardContext.holdBonus, 1);
  });
}
// ---- Kit.touch (kit/touch.js) and the pure half of Kit.pixel (kit/pixel.js) ---------------------------------------------
for (const file of ['touch', 'pixel']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', file + '.js'), 'utf8'), sandbox, { filename: file + '.js' });
test('touch.trace: fills on target, drains and strains off it, loose strain when not touching', () => {
  const trace = Kit.touch.trace({ target: Kit.path.point(0, 0), tolerance: 0.5, fillSeconds: 2, drainRate: 0.5, strainRate: 0.4, looseRate: 0.6, recoverRate: 0.2 });
  const on = trace.step(trace.start(), 1, { x: 0.5, y: 0 });
  assert.ok(on.isOnTarget, 'a pointer exactly at the tolerance counts'); near(on.progress, 0.5, 'half filled after half the fill time');
  near(trace.accuracy(on), 1, 'accuracy'); near(on.streak, 1, 'streak');
  const off = trace.step(on, 1, { x: 0.51, y: 0 });
  assert.ok(!off.isOnTarget); near(off.progress, 0.25, 'drains at drainRate x fill rate'); near(off.tension, 0.4, 'strain'); near(off.streak, 0, 'streak resets');
  near(trace.accuracy(off), 0.5, 'half the scored time was on target');
  near(trace.step(off, 1, null).tension, 1, 'not touching strains at looseRate'); near(trace.step(off, 0.5, { x: 0, y: 0 }).tension, 0.3, 'recovers on target');
  near(trace.step(trace.start(), 5, null).progress, 0, 'the meter never goes below empty');
  near(trace.accuracy(trace.start()), 0, 'no accuracy before anything is scored');
});
test('touch.trace: outcomes are final, a win beats a snap, drift scores nothing, boost and pace and smoothing apply', () => {
  const trace = Kit.touch.trace({ target: Kit.path.point(0, 0), tolerance: 1, fillSeconds: 1, strainRate: 1 });
  const won = trace.step(trace.start(), 1, { x: 0, y: 0 });
  assert.strictEqual(won.outcome, 'won'); assert.strictEqual(trace.step(won, 9, null), won, 'a finished fight is returned unchanged');
  assert.strictEqual(trace.step(trace.start(), 1, { x: 5, y: 0 }).outcome, 'lost');
  assert.strictEqual(trace.step({ ...trace.start(), progress: 0.99, tension: 0.99 }, 1, { x: 0, y: 0 }).outcome, 'won', 'filling the meter wins even at the brink');
  const moving = Kit.touch.trace({ target: (time) => ({ x: time, y: 0 }), tolerance: 0.1, fillSeconds: 4, pace: () => 2, boost: (streak) => (streak >= 1 ? 3 : 1) });
  const drifted = moving.drift(moving.start(), 1.5);
  near(drifted.target.x, 3, 'pace warps path time'); near(drifted.elapsed, 0, 'drift scores nothing'); near(drifted.progress, 0, 'drift fills nothing');
  const first = moving.step(moving.start(), 0.5, { x: 1, y: 0 }), second = moving.step(first, 0.5, { x: 2, y: 0 });
  near(first.progress, 0.125, 'boost 1 before the streak threshold'); near(second.progress, 0.125 + 0.375, 'boost 3 once the streak reaches it');
  const lagging = Kit.touch.trace({ target: (time) => ({ x: time < 1 ? 0 : 10, y: 0 }), tolerance: 1, fillSeconds: 1, smoothing: 2 });
  const chased = lagging.drift(lagging.start(), 1);
  assert.ok(chased.target.x > 5 && chased.target.x < 10, 'a smoothed target chases a jump instead of teleporting: ' + chased.target.x);
});
test('touch.stroke: minimum step, length budget, remaining share, reset', () => {
  const rope = Kit.touch.stroke({ minStep: 1, maxLength: 5 });
  assert.ok(rope.add({ x: 0, y: 0 })); assert.ok(!rope.add({ x: 0.5, y: 0 }), 'too close to the last point'); assert.ok(rope.add({ x: 3, y: 0 }));
  near(rope.length, 3, 'length'); near(rope.remaining(), 0.4, 'remaining'); assert.ok(!rope.isSpent());
  assert.ok(rope.add({ x: 3, y: 4 }), 'the point that crosses the budget is kept'); assert.ok(rope.isSpent()); near(rope.remaining(), 0, 'clamped');
  assert.ok(!rope.add({ x: 9, y: 9 }), 'a spent rope takes no more points'); assert.strictEqual(rope.points.length, 3);
  rope.reset(); assert.strictEqual(rope.points.length, 0); near(rope.length, 0, 'reset'); near(Kit.touch.stroke().remaining(), 1, 'no budget = always full');
});
test('touch.lasso: encloses by joining the ends, refuses a gap wider than the tolerance, reads positions through `at`', () => {
  const loop = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 1 }];
  const fish = [{ name: 'in', at: { x: 2, y: 2 } }, { name: 'out', at: { x: 6, y: 2 } }];
  const haul = Kit.touch.lasso(loop, fish, { at: (target) => target.at });
  assert.ok(haul.isClosed); assert.strictEqual(haul.inside.map((target) => target.name).join(), 'in'); near(haul.centre.x, 1.6, 'centre x');
  assert.strictEqual(Kit.touch.lasso(loop, fish, { closeTolerance: 1, at: (target) => target.at }).inside.length, 1, 'gap of exactly the tolerance closes');
  const open = Kit.touch.lasso(loop, fish, { closeTolerance: 0.5, at: (target) => target.at });
  assert.ok(!open.isClosed); assert.strictEqual(open.inside.length, 0, 'an open line catches nothing');
  assert.strictEqual(Kit.touch.lasso(loop, [{ x: 1, y: 1 }]).inside.length, 1, 'targets are their own position by default');
  assert.strictEqual(Kit.touch.lasso([{ x: 0, y: 0 }, { x: 4, y: 0 }], [{ x: 2, y: 0 }]).inside.length, 0, 'a stroke of two points is not a loop');
});
test('touch.zone grades bands best-first; touch.sweep swings 0..1', () => {
  const sweet = Kit.touch.zone(0.6, [0.05, 0.2]);
  assert.strictEqual(sweet.grade(0.6), 3); assert.strictEqual(sweet.grade(0.65), 3, 'band edges are inclusive'); assert.strictEqual(sweet.grade(0.7), 2);
  assert.strictEqual(sweet.grade(0.41), 2); assert.strictEqual(sweet.grade(0.39), 1); assert.strictEqual(sweet.grade(1), 1);
  near(sweet.bands[1].from, 0.4, 'outer band start'); assert.strictEqual(Kit.touch.zone(0.5, [0.1]).grade(0.5), 2, 'one band = two grades');
  const needle = Kit.touch.sweep(0.5);
  near(needle(0), 0.5, 'starts mid-gauge'); near(needle(0.5), 1, 'top at a quarter cycle'); near(needle(1.5), 0, 'bottom at three quarters'); near(needle(2), 0.5, 'one full cycle');
  near(Kit.touch.sweep(1, 0.25)(0), 1, 'phase is in cycles');
  for (let seconds = 0; seconds < 5; seconds += 0.13) assert.ok(needle(seconds) >= 0 && needle(seconds) <= 1, 'stays on the gauge');
});
test('touch.walker: walks at its speed, arrives once, faces its heading, gives up against a wall', () => {
  const walker = Kit.touch.walker({ at: { x: 0, y: 0 }, speed: 2 });
  assert.strictEqual(walker.step(1).isMoving, false, 'idle until told to go');
  walker.goTo({ x: -3, y: 0 });
  const first = walker.step(1);
  assert.ok(first.isMoving && !first.hasArrived); assert.strictEqual(first.heading, -1); near(walker.position.x, -2, 'one second at speed 2');
  assert.ok(walker.step(1).hasArrived, 'arrives without overshooting'); near(walker.position.x, -3, 'at the target');
  assert.strictEqual(walker.step(1).isMoving, false, 'and stays there');
  const fenced = Kit.touch.walker({ at: { x: 0, y: 0 }, speed: 1, stuckSeconds: 0.3, constrain: (point) => ({ x: Math.min(point.x, 1), y: point.y }) });
  fenced.goTo({ x: 5, y: 0 }); near(fenced.target.x, 1, 'the target itself is constrained');
  const walled = Kit.touch.walker({ at: { x: 0, y: 0 }, speed: 1, stuckSeconds: 0.3, constrain: (point) => ({ x: Math.min(point.x, 1), y: point.y }) });
  walled.target.x = 5; // a target behind the wall (as when the wall is curved and the straight line to the target crosses it)
  let arrived = false;
  for (let i = 0; i < 40; i++) arrived = walled.step(0.1).hasArrived || arrived;
  near(walled.position.x, 1, 'stopped at the wall'); assert.ok(!arrived, 'giving up is not arriving'); assert.strictEqual(walled.step(0.1).isMoving, false, 'it stopped trying');
});
test('pixel: cells add a paper border with a darker edge under the art; sheet, recolor, tile, label stay data', () => {
  const P = Kit.pixel, dot = { rows: ['r'], pal: { r: 0xff0000 } };
  const cells = P.cells(dot);
  assert.strictEqual(cells.length, 9, 'one pixel of art + eight of paper');
  assert.strictEqual(cells.find((cell) => cell.x === 0 && cell.y === 0).color, 0xff0000);
  assert.strictEqual(cells.find((cell) => cell.x === 0 && cell.y === 1).color, 0xd9c8a5, 'the pixel below the art is the cut edge');
  assert.strictEqual(cells.find((cell) => cell.x === 0 && cell.y === -1).color, P.PAPER);
  assert.strictEqual(P.cells({ ...dot, wrap: true }).length, 1, 'wrap tiles have no border');
  assert.strictEqual(P.cells({ ...dot, border: 2 }).length, 25, 'border width is per definition');
  assert.strictEqual(P.cells({ rows: ['r.', '.. '], pal: dot.pal }).filter((cell) => cell.color === 0xff0000).length, 1, 'dots and spaces are transparent');
  assert.strictEqual(P.cells({ rows: ['ab'], pal: { a: 1, b: 2 }, mirror: true, border: 0 }).map((cell) => cell.color).join(''), '1221', 'mirror appends the reversed row');
  const tall = { frames: [['a', 'a'], ['a']], pal: { a: 1 }, border: 0 };
  assert.strictEqual(P.cells(tall, 1)[0].y, 1, 'a shorter frame stands on the same baseline');
  const sheet = P.sheet({ g: 5 }, { leaf: ['g'], bird: { frames: [['g'], ['g']] } });
  assert.strictEqual(sheet.leaf.name, 'leaf'); assert.strictEqual(sheet.leaf.rows[0], 'g'); assert.strictEqual(sheet.bird.frames.length, 2); assert.strictEqual(sheet.bird.pal.g, 5);
  const pink = P.recolor(sheet.leaf, { g: 9 });
  assert.strictEqual(pink.pal.g, 9); assert.strictEqual(sheet.leaf.pal.g, 5, 'recolor does not touch the original');
  assert.strictEqual(P.tile({ rows: ['ab'], pal: {}, mirror: true }, 2).rows[0], 'abbaabba', 'tile repeats the mirrored row and drops the mirror flag');
  const tag = P.label('Hi!');
  assert.strictEqual(tag.rows.length, 7, 'five glyph rows plus a blank row above and below');
  assert.ok(tag.rows.every((row) => row.length === tag.rows[0].length), 'label rows are all the same width');
  assert.strictEqual(tag.rows[1].slice(2, 5), '#_#', 'top row of H');
  assert.strictEqual(P.label('~').rows[3].includes('#'), false, 'unknown characters become spaces');
});
// ---- kit/meta.js: cross-run profile and synergies --------------------------------------------------------------
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'meta.js'), 'utf8'), sandbox, { filename: 'meta.js' });
test('profile: counters and bests feed achievements, which unlock content exactly once', () => {
  const unlocked = [], earned = [];
  const profile = Kit.profile({
    achievements: [{ id: 'hunter', text: 'Defeat 3', stat: 'kills', target: 3, unlocks: 'crossbow' }, { id: 'far', text: 'Reach 100m', stat: 'distance', target: 100 }],
    onUnlock: (id) => unlocked.push(id), onAchievement: (row) => earned.push(row.id),
  });
  profile.count('kills'); profile.count('kills');
  assert.strictEqual(profile.isUnlocked('crossbow'), false, 'not before the target');
  profile.count('kills', 5); profile.count('kills');
  assert.strictEqual(earned.join(), 'hunter', 'fires once even when the counter keeps rising');
  assert.strictEqual(unlocked.join(), 'crossbow');
  assert.strictEqual(profile.best('distance', 60), 60); assert.strictEqual(profile.best('distance', 40), 60, 'a worse result never lowers a best');
  profile.best('distance', 140); assert.strictEqual(earned.join(), 'hunter,far');
  const far = profile.achievements().find((entry) => entry.row.id === 'far');
  assert.strictEqual(far.progress, 100, 'progress is capped at the target'); assert.strictEqual(far.done, true);
  assert.strictEqual(profile.stat('never-recorded'), 0);
});
test('profile: experience can cross several levels at once and everything persists', () => {
  const save = mem(); const levels = [];
  const profile = Kit.profile({ save, levelCurve: { base: 10, step: 10 }, onLevel: (level) => levels.push(level) });
  assert.strictEqual(profile.gainExperience(5), 0); near(profile.levelProgress(), 0.5, 'half way through level 1');
  assert.strictEqual(profile.gainExperience(40), 2, 'needs 10 then 20: 45 total leaves 15 into level 3');
  assert.strictEqual(levels.join(), '2,3'); near(profile.levelProgress(), 0.5, '15 of 30');
  for (let run = 0; run < 25; run++) profile.endRun({ score: run });
  assert.strictEqual(profile.runCount, 25); assert.strictEqual(profile.runs().length, 20, 'history is capped'); assert.strictEqual(profile.runs()[0].score, 24, 'newest first');
  const reloaded = Kit.profile({ save, levelCurve: { base: 10, step: 10 } });
  assert.strictEqual(reloaded.level, 3); assert.strictEqual(reloaded.runCount, 25);
});
test('synergy: switches on at the threshold, off when the build loses a tag, and drives stats', () => {
  const stats = Kit.stats({ damage: 10 }); const flips = [];
  const synergies = Kit.synergy(
    [{ id: 'pyro', name: 'Pyromancer', needs: { fire: 2 }, mods: { damage: { mul: 2 } } }, { id: 'duelist', name: 'Duelist', needs: { fire: 1, blade: 1 } }],
    { stats, onChange: (row, active) => flips.push(row.id + (active ? '+' : '-')) }
  );
  assert.strictEqual(synergies.update([]).length, 0, 'an empty build activates nothing');
  synergies.update([{ tags: ['fire'] }]); near(stats.get('damage'), 10, 'one fire item is not enough');
  assert.strictEqual(synergies.progress().find((entry) => entry.row.id === 'pyro').have.fire, 1, 'reports how close the build is');
  synergies.update([{ tags: ['fire'] }, { tags: ['fire', 'blade'] }]); near(stats.get('damage'), 20, 'set bonus applied');
  assert.strictEqual(synergies.active().length, 2);
  synergies.update([{ tags: ['blade'] }]); near(stats.get('damage'), 10, 'bonus removed when the set breaks');
  assert.strictEqual(flips.join(), 'pyro+,duelist+,pyro-,duelist-', 'callbacks fire only on a change of state');
  assert.strictEqual(synergies.update([{ id: 'no-tags' }]).length, 0, 'items without tags are fine');
});
// ---- kit steward: edge cases for core, model, flow, space, loot and net (empty inputs, limits, caches, hot-path rewrites) ----
{
  /** Compares through JSON, because kit objects come from the vm sandbox's realm and fail deepStrictEqual on prototype. */
  const sameJson = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  /** Runs a body with Math.random replaced by a fixed sequence (inside the sandbox, where the kit reads it). */
  const withRandom = (values, body) => {
    const sandboxMath = vm.runInContext('Math', sandbox);
    const realRandom = sandboxMath.random;
    let index = 0;
    sandboxMath.random = () => values[index++ % values.length];
    try {
      return body();
    } finally {
      sandboxMath.random = realRandom;
    }
  };
  /** A transport that records what is sent and delivers nothing back. */
  const recordingTransport = (id = 'me') => {
    const sent = [];
    return { id, sent, send: (message) => sent.push(message), onMessage: () => {} };
  };
  const describeSent = (message) => (message.t === 'set' ? `${message.k}=${message.e.v}` : message.t === 'ev' ? `ev:${message.data}` : message.t);

  test('steward core: formatting edges', () => {
    assert.strictEqual(Kit.fmt(0), '0'); assert.strictEqual(Kit.fmt(12.5), '12.5'); assert.strictEqual(Kit.fmt(999), '999');
    assert.strictEqual(Kit.fmt(1234), '1.23K'); assert.strictEqual(Kit.fmt(-1500), '-1.5K'); assert.strictEqual(Kit.fmt(2e6), '2M');
    assert.strictEqual(Kit.fmt(Infinity), '∞'); assert.strictEqual(Kit.fmt(NaN), '∞', 'non-finite values never print as "NaN"');
    assert.strictEqual(Kit.fmtTime(75), '1:15'); assert.strictEqual(Kit.fmtTime(5), '0:05'); assert.strictEqual(Kit.fmtTime(0), '0:00');
  });
  test('steward core: math edges (wrap, remap, easing end points)', () => {
    const { wrap, remap, clamp, ease, damp } = Kit.math;
    assert.strictEqual(wrap(-1, 4), 3); assert.strictEqual(wrap(4, 4), 0); assert.strictEqual(wrap(9, 4), 1);
    assert.strictEqual(remap(-5, 0, 10, 100, 200), 100, 'clamped below'); assert.strictEqual(remap(50, 0, 10, 100, 200), 200, 'clamped above');
    assert.strictEqual(clamp(5), 1); assert.strictEqual(clamp(-5), 0);
    Object.keys(ease).forEach((name) => { near(ease[name](0), 0, name + ' starts at 0'); near(ease[name](1), 1, name + ' ends at 1'); });
    near(ease.outBounce(0.5), 0.765625, 'second bounce arc'); assert.ok(Number.isNaN(ease.outBounce(NaN)), 'NaN passes through instead of throwing');
    near(damp(0, 10, 5, 0), 0, 'no time, no movement'); assert.ok(damp(0, 10, 5, 100) > 9.999, 'a long step lands on the target');
  });
  test('steward core: random helpers on empty, single and zero-weight inputs', () => {
    const { pick, pickWeighted, shuffle, randomTools } = Kit.math;
    assert.strictEqual(pick([]), undefined); assert.strictEqual(pickWeighted([]), undefined); sameJson(shuffle([]), []);
    assert.strictEqual(pickWeighted([{ id: 'only' }]).id, 'only');
    const rows = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
    assert.strictEqual(withRandom([0.2], () => pickWeighted(rows)).id, 'a', 'roll 0.8 of 4 lands in the first row');
    assert.strictEqual(withRandom([0.3], () => pickWeighted(rows)).id, 'b', 'roll 1.2 of 4 lands in the second row');
    assert.strictEqual(withRandom([0.999999], () => pickWeighted(rows)).id, 'b', 'the top of the range is the last row');
    const input = [1, 2, 3, 4, 5]; const shuffled = shuffle(input);
    sameJson(input, [1, 2, 3, 4, 5], 'input untouched'); sameJson(shuffled.slice().sort(), [1, 2, 3, 4, 5], 'same items');
    const fixed = randomTools(() => 0); sameJson(fixed.shuffle([1, 2, 3]), [2, 3, 1], 'driven only by the given source'); assert.strictEqual(fixed.pick([7, 8]), 7);
  });
  test('steward core: bus and pool survive changes during delivery and double release', () => {
    const bus = Kit.bus(); const heard = [];
    const offFirst = bus.on('hit', () => { heard.push('first'); offFirst(); bus.on('hit', () => heard.push('late')); });
    bus.on('hit', () => heard.push('second'));
    bus.emit('hit'); assert.strictEqual(heard.join(), 'first,second', 'a listener added during delivery waits for the next emit');
    bus.emit('hit'); assert.strictEqual(heard.join(), 'first,second,second,late'); bus.emit('nobody-listens');
    bus.clear(); bus.emit('hit'); assert.strictEqual(heard.length, 4);
    let made = 0; const released = [];
    const pool = Kit.pool(() => ({ id: ++made }), null, (item) => released.push(item.id));
    const first = pool.get(); pool.release(first); pool.release(first); pool.release({ id: 'stranger' });
    assert.strictEqual(released.join(), '1', 'released once'); assert.strictEqual(pool.get(), first, 'reused'); assert.strictEqual(made, 1);
    pool.get(); pool.each((item) => pool.release(item)); assert.strictEqual(pool.live.size, 0, 'releasing inside each is safe');
  });
  test('steward core: clock timers keep their rate, cancel, and tweens land exactly', () => {
    const clock = Kit.clock(); const log = [];
    clock.after(1, () => log.push('once')); const stop = clock.every(0.5, () => log.push('tick')); const cancelled = clock.after(0.1, () => log.push('never'));
    cancelled(); clock.update(0.6); assert.strictEqual(log.join(), 'tick');
    clock.update(0.5); assert.strictEqual(log.join(), 'tick,once,tick', 'the 0.1s overshoot is carried, so the second tick is on time');
    stop(); clock.update(5); assert.strictEqual(log.length, 3);
    clock.after(0.1, () => clock.after(0, () => log.push('chained'))); clock.update(0.1); assert.strictEqual(log[3], 'chained', 'a job scheduled by a callback runs in the same pass');
    const target = { x: 0, y: 5 };
    clock.tween(target, { x: 10 }, 1, 'linear'); clock.tween(target, { y: 0 }, 1, 'no-such-easing');
    clock.update(0.5); near(target.x, 5, 'half way'); clock.update(2); assert.strictEqual(target.x, 10); assert.strictEqual(target.y, 0, 'unknown easing falls back');
    clock.after(1, () => log.push('cleared')); clock.clear(); clock.update(2); assert.ok(!log.includes('cleared'));
  });
  atest('steward core: a tween resolves its promise when it finishes, not before', async () => {
    const clock = Kit.clock(); let resolved = false;
    clock.tween({ x: 0 }, { x: 1 }, 1).then(() => (resolved = true));
    clock.update(0.9); await settle(); assert.strictEqual(resolved, false, 'still running');
    clock.update(0.2); await settle(); assert.strictEqual(resolved, true);
  });
  test('steward core: store defaults, round trip and namespaces', () => {
    const save = Kit.store('steward-test');
    assert.strictEqual(save.get('missing', 7), 7); assert.strictEqual(save.set('best', 0), 0); assert.strictEqual(save.get('best', 99), 0, 'a saved 0 is not replaced by the default');
    assert.strictEqual(Kit.store('other-game').get('best', 'none'), 'none', 'namespaces are separate');
    assert.strictEqual(JSON.parse(store['five-loop-lab'])['steward-test'].best, 0, 'written through to storage');
  });
  test('steward core: slotRing visits only the live window and recycles the oldest slot', () => {
    assert.throws(() => Kit.slotRing(0), /positive whole number/); assert.throws(() => Kit.slotRing(2.5), /positive whole number/);
    const ring = Kit.slotRing(4); const visited = () => { const slots = []; ring.forEach((slot) => slots.push(slot)); return slots.join(); };
    assert.strictEqual(visited(), '', 'empty ring visits nothing'); assert.strictEqual(ring.span, 0);
    assert.strictEqual([ring.claim(), ring.claim(), ring.claim()].join(), '0,1,2'); assert.strictEqual(visited(), '0,1,2', 'oldest first');
    const dead = new Set([0, 2]); ring.trim((slot) => dead.has(slot));
    assert.strictEqual(visited(), '1,2', 'only the oldest end shrinks: dead slot 2 sits behind live slot 1');
    dead.add(1); ring.trim((slot) => dead.has(slot)); assert.strictEqual(ring.span, 0, 'everything finished');
    for (let claims = 0; claims < 6; claims++) ring.claim();
    assert.strictEqual(ring.span, 4, 'never more than the capacity'); assert.strictEqual(visited(), '1,2,3,0', 'wrapped: the window ends at the newest slot');
    const single = Kit.slotRing(1); assert.strictEqual(single.claim(), 0); assert.strictEqual(single.claim(), 0); assert.strictEqual(single.span, 1);
  });

  test('steward model: curves and tables on empty, single and unsorted data', () => {
    assert.throws(() => Kit.curve.points([]), /at least one/); assert.throws(() => Kit.curve.of({ steps: [] }), /at least one/);
    const flat = Kit.curve.points([[3, 9]]); near(flat(-100), 9, 'single point below'); near(flat(100), 9, 'single point above');
    const unsorted = Kit.curve.points([[10, 4], [0, 2]]); near(unsorted(5), 3, 'points are sorted first'); near(unsorted(0), 2, 'exactly on a point'); near(unsorted(10), 4, 'exactly on the last point');
    const stairs = Kit.curve.steps([[2, 5], [4, 8]]); near(stairs(0), 5, 'before the first step'); near(stairs(4), 8, 'a step starts on its x'); near(stairs(3.99), 5, 'not before');
    near(Kit.curve.of((n) => n * 2)(4), 8, 'functions pass through'); assert.throws(() => Kit.curve.of(null), /unrecognised spec/);
    const empty = Kit.table([]); assert.strictEqual(empty.length, 0); assert.strictEqual(empty.has('x'), false); assert.throws(() => empty.byId('x'), /no row "x"/);
    assert.throws(() => Kit.table([{ name: 'no id' }]), /row without id/);
    const rows = [{ id: 'a' }]; const table = Kit.table(rows); rows.push({ id: 'b' }); assert.strictEqual(table.length, 1, 'the table is a copy');
  });
  test('steward model: stats cache is O(1) per read and is dropped on every change', () => {
    let specReads = 0;
    const countedSpec = {}; Object.defineProperty(countedSpec, 'damage', { enumerable: true, get() { specReads++; return { add: 5 }; } });
    const base = { damage: 10 }; const stats = Kit.stats(base, { limits: { armour: [0, 3] } });
    stats.mod('sword', countedSpec); near(stats.get('damage'), 15, 'first read');
    const readsAfterFirst = specReads; for (let read = 0; read < 50; read++) stats.get('damage');
    assert.strictEqual(specReads, readsAfterFirst, 'repeated reads do not walk the modifiers again');
    base.damage = 20; near(stats.get('damage'), 25, 'a direct write to base still shows: only modifier totals are cached');
    stats.mod('ring', { damage: { mul: 2 } }); near(stats.get('damage'), 50, 'mod() invalidates');
    stats.mod('ring', null); near(stats.get('damage'), 25, 'removal invalidates');
    stats.clear(); near(stats.get('damage'), 20, 'clear() invalidates'); near(stats.get('never-set'), 0, 'unknown stat is 0');
    stats.mod('plate', { armour: { add: 9 } }); near(stats.get('armour'), 3, 'limits still clamp cached totals');
    near(stats.preview('armour', 'plate', null), 0, 'preview is unaffected by the cache'); near(stats.get('armour'), 3);
    let notified = 0; stats.on(() => notified++); stats.mod('x', {}); stats.clear(); assert.strictEqual(notified, 2);
    sameJson(Kit.stats.scale({}, 3), {}); near(Kit.stats.scale({ speed: { mul: 2 } }, 0).speed.mul, 1, 'level 0 is neutral');
  });
  test('steward model: wallet and upgrades at their limits', () => {
    const wallet = Kit.wallet(); assert.strictEqual(wallet.get(), 0); assert.strictEqual(wallet.get('gems'), 0, 'unknown currency');
    assert.strictEqual(wallet.spend(0), true, 'spending nothing always works'); wallet.add(5); assert.strictEqual(wallet.spend(5), true, 'exact balance'); assert.strictEqual(wallet.spend(1), false);
    assert.strictEqual(wallet.can(1, 'gems'), false); assert.strictEqual(wallet.add(2, 'gems'), 2);
    const hits = []; const stats = Kit.stats({ power: 1 });
    const upgrades = Kit.upgrades([
      { id: 'sealed', max: 0, cost: 1 },
      { id: 'free', max: 1, mods: { power: { add: 1 } }, onLevel: (level) => hits.push(level), desc: (level) => `level ${level}` },
      { id: 'plain', desc: 'static text' },
    ], { stats, wallet });
    assert.strictEqual(upgrades.maxed('sealed'), true, 'max 0 starts maxed'); assert.strictEqual(upgrades.buy('sealed'), false); assert.strictEqual(upgrades.grant('sealed'), false);
    assert.strictEqual(upgrades.cost('free'), 0, 'no cost means free'); assert.strictEqual(upgrades.buy('free'), true); assert.strictEqual(wallet.get(), 0, 'nothing charged');
    assert.strictEqual(upgrades.buy('free'), false, 'max level reached'); assert.strictEqual(upgrades.grant('free'), false); near(stats.get('power'), 2, 'one level applied');
    assert.strictEqual(upgrades.desc('free'), 'level 1'); assert.strictEqual(upgrades.desc('plain'), 'static text'); assert.strictEqual(upgrades.desc('sealed'), '');
    sameJson(upgrades.offer(5).map((row) => row.id), ['plain'], 'maxed rows are never offered'); sameJson(upgrades.offer(0), []);
    sameJson(upgrades.owned().map((row) => row.id), ['free']); assert.throws(() => upgrades.level && upgrades.cost('nope'), /no row "nope"/);
    upgrades.restore(); assert.strictEqual(hits.join(), '1,1', 'restore re-fires onLevel for owned rows only');
    upgrades.reset(); near(stats.get('power'), 1, 'reset removes the mods'); assert.strictEqual(hits.length, 2, 'reset is silent'); assert.strictEqual(upgrades.owned().length, 0);
    assert.strictEqual(Kit.upgrades([]).offer(3).length, 0, 'an empty table offers nothing');
  });
  test('steward model: goals cap progress, persist and ignore finished rows', () => {
    const save = mem(); const done = [];
    const rows = [{ id: 'one', text: 'Do it', event: 'act' }, { id: 'ten', text: 'Do ten', event: 'act', target: 10 }];
    const goals = Kit.goals(rows, { save, onDone: (row) => done.push(row.id) });
    goals.track('other'); assert.strictEqual(goals.progress('one'), 0, 'unrelated events do nothing');
    goals.track('act', 25); assert.strictEqual(goals.progress('ten'), 10, 'overshoot is capped at the target'); assert.strictEqual(goals.progress('one'), 1);
    goals.track('act', 5); assert.strictEqual(done.join(), 'one,ten', 'onDone fires once per goal'); assert.ok(goals.allDone());
    sameJson(goals.list().map((entry) => [entry.progress, entry.target, entry.done]), [[1, 1, true], [10, 10, true]]);
    assert.ok(Kit.goals(rows, { save }).done('ten'), 'progress is restored from the save'); assert.ok(Kit.goals([]).allDone(), 'no goals: nothing left to do');
  });

  test('steward flow: fsm without an initial state, and re-entering a state', () => {
    const log = [];
    const flow = Kit.fsm({ idle: { enter: (data, previous) => log.push(`enter:${previous}`), exit: (next) => log.push(`exit:${next}`) }, bare: {} });
    assert.strictEqual(flow.state, null); flow.update(1); assert.strictEqual(flow.is('idle'), false);
    flow.go('idle'); flow.update(0.5); flow.go('idle'); assert.strictEqual(log.join(), 'enter:null,exit:idle,enter:idle', 're-entering runs exit then enter');
    assert.strictEqual(flow.time, 0, 'the timer restarts'); flow.go('bare'); flow.update(2); assert.strictEqual(flow.time, 2, 'states without hooks are fine');
    const changes = []; flow.on((change) => changes.push(`${change.prev}>${change.state}`)); flow.go('idle'); assert.strictEqual(changes.join(), 'bare>idle');
  });
  test('steward flow: spawn tables with no rows, zero weights and window edges', () => {
    assert.strictEqual(Kit.spawnTable([]).pick(0), null); assert.strictEqual(Kit.spawnTable([]).next(0), null);
    const table = Kit.spawnTable([{ id: 'never', weight: 0 }, { id: 'always' }, { id: 'window', from: 5, until: 10, weight: 0 }]);
    for (let roll = 0; roll < 50; roll++) assert.strictEqual(table.pick(7).id, 'always', 'weight 0 never spawns');
    const edges = Kit.spawnTable([{ id: 'w', from: 5, until: 10 }]);
    assert.strictEqual(edges.active(4.99).length, 0); assert.strictEqual(edges.active(5).length, 1, 'from is inclusive'); assert.strictEqual(edges.active(10).length, 0, 'until is exclusive');
    const taught = Kit.spawnTable([], { intro: [{ id: 'lesson' }] }); assert.strictEqual(taught.next(0).id, 'lesson'); assert.strictEqual(taught.served, 1); assert.strictEqual(taught.next(0), null);
  });
  test('steward flow: darts loops through negative time (was a crash), sequence needs parts', () => {
    const { path } = Kit; const darts = path.darts([[0, 0], [1, 0], [1, 1]], 0.8, 0.2);
    const period = 3 * (0.8 + 0.2);
    [-0.1, -1.05, -2.5, -7.3].forEach((t) => { const now = darts(t), later = darts(t + 2 * period); near(now.x, later.x, `x periodic at ${t}`); near(now.y, later.y, `y periodic at ${t}`); });
    sameJson(darts(0.5), { x: 0, y: 0 }, 'holding at the first waypoint'); near(darts(0.9).x, 0.875, 'half way through the dash, eased out');
    sameJson(path.darts([[2, 3]])(4.2), { x: 2, y: 3 }, 'a single waypoint stays put');
    assert.throws(() => path.sequence([]), /at least one/);
    sameJson(path.sequence([[path.point(4, 2), 0]])(1), { x: 4, y: 2 }, 'a zero-length loop falls back to its first part');
    sameJson(path.add()(1), { x: 0, y: 0 }, 'adding nothing is the origin');
  });
  test('steward flow: paths write into an out point without changing their values', () => {
    const { path } = Kit;
    const handWritten = (t) => ({ x: t, y: -t }); // a valid path that ignores the out argument
    const inner = path.add(path.lissajous(1, 2, 0.3), path.wobble(0.2, 5), handWritten);
    const paths = {
      point: path.point(1, 2), circle: path.circle(2, 3), lissajous: path.lissajous(), weave: path.weave(), zigzag: path.zigzag(),
      darts: path.darts([[0, 0], [1, 1]]), wobble: path.wobble(), add: inner, nestedAdd: path.add(inner, inner),
      scale: path.scale(inner, 2, 3), offset: path.offset(inner, 5, -5), warp: path.warp(inner, (t) => t * 2),
      sequence: path.sequence([[inner, 1], [path.circle(), 2]]), blend: path.blend(inner, path.circle(), (t) => t / 4),
      scaledHandWritten: path.scale(handWritten, 2),
    };
    Object.keys(paths).forEach((name) => {
      const out = { x: 99, y: 99 };
      [0, 0.37, 1.9, 3.3].forEach((t) => {
        const fresh = paths[name](t); const reused = paths[name](t, out);
        assert.strictEqual(reused, out, `${name} returns the out point`);
        near(reused.x, fresh.x, `${name} x at ${t}`); near(reused.y, fresh.y, `${name} y at ${t}`);
      });
      assert.notStrictEqual(paths[name](1), paths[name](1), `${name} without out still returns a fresh point`);
    });
  });

  test('steward space: single-cell and empty grids', () => {
    const cell = Kit.grid(1, 1, { fill: 'only' });
    sameJson(cell.neighbors(0, 0, true), []); sameJson(cell.path({ x: 0, y: 0 }, { x: 0, y: 0 }, () => true), [{ x: 0, y: 0 }], 'a path to itself is one cell');
    sameJson(cell.flood(0, 0, () => false), [{ x: 0, y: 0 }], 'the start is included even when nothing is passable');
    sameJson(cell.ray(0, 0, 1, 0, () => true), { x: 1, y: 0, steps: 1 }, 'a ray leaves at once'); sameJson(cell.toWorld(0, 0), { x: 0, z: 0 });
    assert.strictEqual(cell.fromWorld(5, 5), null); assert.strictEqual(cell.get(-1, 0), undefined); assert.strictEqual(cell.set(9, 9, 'x'), cell, 'off-board set is ignored');
    sameJson(cell.find((value) => value === 'only'), [{ x: 0, y: 0, v: 'only' }]);
    const none = Kit.grid(0, 0); let visits = 0; none.each(() => visits++); assert.strictEqual(visits, 0); sameJson(none.snapshot(), []);
    assert.throws(() => Kit.grid.parse([]), /at least one row/);
    const ragged = Kit.grid.parse(['ab', 'a'], { a: 1 }); assert.strictEqual(ragged.w, 2); assert.strictEqual(ragged.get(1, 0), null, 'not in the legend'); assert.strictEqual(ragged.get(1, 1), null, 'short row padded');
    const shared = { tag: 1 }; const copies = Kit.grid.parse(['xx'], { x: shared }); assert.notStrictEqual(copies.get(0, 0), copies.get(1, 0), 'legend objects are copied per cell');
  });
  test('steward space: shortest paths are contiguous, minimal and fill-order stable', () => {
    const open = () => true; const board = Kit.grid(5, 4);
    const route = board.path({ x: 0, y: 0 }, { x: 4, y: 3 }, open);
    assert.strictEqual(route.length, 8, '7 orthogonal steps'); sameJson(route[0], { x: 0, y: 0 }); sameJson(route[7], { x: 4, y: 3 });
    route.slice(1).forEach((step, index) => assert.strictEqual(Math.abs(step.x - route[index].x) + Math.abs(step.y - route[index].y), 1, 'each step moves one cell'));
    assert.strictEqual(board.path({ x: 0, y: 0 }, { x: 4, y: 3 }, open, true).length, 5, 'diagonals shorten it to 4 steps');
    assert.strictEqual(board.path({ x: 0, y: 0 }, { x: 4, y: 3 }, (value, x) => x < 4), null, 'goal not passable');
    sameJson(board.flood(0, 0, (value, x, y) => x + y < 2), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], 'nearest first, east before south');
    assert.strictEqual(board.flood(2, 2, open).length, 20, 'an open board floods completely'); sameJson(board.neighbors(0, 0).map((n) => [n.x, n.y]), [[1, 0], [0, 1]]);
    assert.strictEqual(board.neighbors(2, 2, true).length, 8);
  });
  test('steward space: zero-length, single-point and empty lines', () => {
    const L = Kit.line; const dot = [{ x: 3, y: 4 }]; const stacked = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
    assert.strictEqual(L.length([]), 0); assert.strictEqual(L.length(dot), 0); assert.strictEqual(L.length(stacked), 0);
    sameJson(L.at(dot, 5), { x: 3, y: 4, tx: 1, ty: 0 }, 'a single point has the default tangent'); sameJson(L.at(stacked, 2, true), { x: 1, y: 1, tx: 1, ty: 0 }, 'zero length never divides by zero');
    sameJson(L.resample(stacked, 0.5), [{ x: 1, y: 1 }, { x: 1, y: 1 }], 'both ends, even with no length'); sameJson(L.simplify(dot, 1), dot);
    sameJson(L.nearest(dot, { x: 0, y: 0 }), { x: 3, y: 4, d: 5, along: 0 }); near(L.nearest(stacked, { x: 1, y: 3 }).d, 2, 'zero-length segments');
    assert.throws(() => L.at([], 0), /at least one point/); assert.throws(() => L.nearest([], { x: 0, y: 0 }), /at least one point/); assert.throws(() => L.measured([]), /at least one point/);
    assert.strictEqual(L.closed([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }], 1), false, 'three points are not a loop'); assert.strictEqual(L.contains([], { x: 0, y: 0 }), false);
    const withRepeat = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }]; sameJson(L.at(withRepeat, 1), { x: 1, y: 0, tx: 1, ty: 0 }, 'a repeated point is skipped over');
    sameJson(L.simplify([{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 0 }], 1).map((p) => p.y), [0, 5, 0], 'a far point is kept');
  });
  test('steward space: a measured line answers exactly like line.at', () => {
    const L = Kit.line; const zigzag = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }, { x: 10, y: 4 }, { x: 10, y: -2 }, { x: 0, y: 0 }];
    const rail = L.measured(zigzag); near(rail.total, L.length(zigzag), 'total'); assert.strictEqual(rail.points, zigzag);
    for (let along = -5; along <= rail.total + 5; along += 0.37) {
      [false, true].forEach((loop) => {
        const expected = L.at(zigzag, along, loop), actual = rail.at(along, loop);
        ['x', 'y', 'tx', 'ty'].forEach((field) => near(actual[field], expected[field], `${field} at ${along.toFixed(2)} loop=${loop}`));
      });
    }
    sameJson(rail.at(5), { x: 3, y: 4, tx: 0.6, ty: 0.8 }, 'exactly on a corner belongs to the segment that ends there');
    sameJson(L.measured([{ x: 2, y: 2 }]).at(9), { x: 2, y: 2, tx: 1, ty: 0 });
  });
  test('steward space: history caps its length and resets', () => {
    const history = Kit.history({ max: 3 }); assert.strictEqual(history.undo(), null); assert.strictEqual(history.redo(), null); assert.strictEqual(history.canUndo(), false);
    [1, 2, 3, 4, 5].forEach((value) => history.push({ value }));
    assert.strictEqual(history.undo().value, 4); assert.strictEqual(history.undo().value, 3); assert.strictEqual(history.undo(), null, 'only the newest three states are kept');
    const state = { deep: { value: 1 } }; history.reset(state); state.deep.value = 2; history.push(state);
    assert.strictEqual(history.undo().deep.value, 1, 'snapshots are copies'); history.reset(); assert.strictEqual(history.canRedo(), false); assert.strictEqual(history.length, -1);
  });

  test('steward loot: rng and spec algebra edges', () => {
    const rng = Kit.rng(5); assert.strictEqual(rng.seed, 5); assert.strictEqual(rng.int(3, 3), 3); assert.strictEqual(rng.pick([]), undefined); assert.strictEqual(rng.weighted([]), undefined);
    assert.strictEqual(rng.chance(0), false); assert.strictEqual(rng.chance(1), true); sameJson(Kit.rng(9).shuffle([1, 2, 3, 4, 5, 6]), Kit.rng(9).shuffle([1, 2, 3, 4, 5, 6]), 'same seed, same shuffle');
    for (let draw = 0; draw < 200; draw++) { const value = rng.range(2, 3); assert.ok(value >= 2 && value < 3); }
    assert.notStrictEqual(Kit.rng(1).fork().next(), Kit.rng(1).next(), 'a fork is its own stream'); assert.strictEqual(Kit.rng(1).fork().next(), Kit.rng(1).fork().next(), 'but a reproducible one');
    sameJson(Kit.stats.merge([]), {}); sameJson(Kit.stats.merge([{ a: { add: 1 } }, {}, { a: { mul: 3 }, b: { add: 2 } }]), { a: { add: 1, mul: 3 }, b: { add: 2, mul: 1 } });
    sameJson(Kit.stats.power({ a: { add: 4, mul: 1.5 } }, 0), { a: { add: 0, mul: 1 } }, 'strength 0 is neutral'); near(Kit.stats.power({ a: { mul: 0.5 } }, 2).a.mul, 0, 'penalties scale too');
  });
  test('steward loot: rolls with no affixes to give, no base to roll, and descriptions', () => {
    const rarities = [{ id: 'epic', weight: 1, affixes: 3, mult: 2 }]; const bases = [{ id: 'cap', name: 'Cap', slot: 'head' }];
    const plain = Kit.loot({ rarities, bases, rng: Kit.rng(1) }).roll();
    assert.strictEqual(plain.affixes.length, 0, 'an empty affix table gives none'); assert.strictEqual(plain.name, 'Cap'); sameJson(plain.mods, {}, 'a base without mods'); assert.strictEqual(plain.value, Math.round(10 * 1.15 * 2 * 2));
    const one = Kit.loot({ rarities, bases, affixes: [{ id: 'swift', prefix: 'Swift', mods: { speed: { mul: 1.1 } } }], rng: Kit.rng(1) }).roll();
    sameJson(one.affixes, ['swift'], 'affixes never repeat, so three wanted and one available is one'); assert.strictEqual(one.name, 'Swift Cap');
    const loot = Kit.loot({ rarities, bases, rng: Kit.rng(1) });
    assert.throws(() => loot.roll({ slot: 'feet' }), /no base item for slot "feet"/); assert.throws(() => loot.roll({ rarity: 'mythic' }), /no row "mythic"/);
    assert.throws(() => Kit.loot({ rarities, bases: [{ id: 'late', name: 'Late', slot: 'head', from: 50 }] }).roll({ level: 1 }), /no base item/);
    sameJson(loot.describe({ mods: { hp: { add: -2.26, mul: 1 }, speed: { add: 0, mul: 0.9 }, luck: { add: 0, mul: 1 } } }, { hp: 'Health' }), ['-2.3 Health', '-10% speed'], 'signs, rounding and neutral mods');
    sameJson(loot.describe({ mods: {} }), []);
  });
  test('steward loot: inventory when full, empty or misused', () => {
    assert.throws(() => Kit.inventory(), /slots/);
    const stats = Kit.stats({ power: 1 }); const none = Kit.inventory({ slots: ['hand'], size: 0 });
    assert.strictEqual(none.full(), true); assert.strictEqual(none.add({ uid: 'a', slot: 'hand', mods: {} }), false, 'a bag of size 0 takes nothing'); sameJson(none.compare({ slot: 'hand', mods: {} }, ['power']), {}, 'no stats, nothing to compare');
    const inventory = Kit.inventory({ slots: ['hand'], stats, size: 1 }); let changes = 0; inventory.on(() => changes++);
    const sword = { uid: 's', slot: 'hand', mods: { power: { add: 2 } } }, club = { uid: 'c', slot: 'hand', mods: { power: { add: 1 } } };
    assert.strictEqual(inventory.remove('ghost'), null); assert.strictEqual(inventory.equip('ghost'), false); assert.strictEqual(inventory.unequip('hand'), false, 'nothing worn'); assert.strictEqual(changes, 0, 'failed actions notify nobody');
    inventory.add(sword); inventory.equip('s'); inventory.add(club); assert.strictEqual(inventory.full(), true);
    assert.strictEqual(inventory.unequip('hand'), false, 'no room in the bag'); near(stats.get('power'), 3, 'still equipped');
    assert.strictEqual(inventory.equip('c'), true, 'a swap works with a full bag'); assert.strictEqual(inventory.bag[0].uid, 's'); near(stats.get('power'), 2);
    sameJson(inventory.compare(club, ['power']), {}, 'comparing with the worn item changes nothing'); assert.strictEqual(inventory.remove('s'), sword);
    inventory.clear(); assert.strictEqual(inventory.equipped('hand'), null); near(stats.get('power'), 1, 'clear removes the mods'); assert.strictEqual(inventory.bag.length, 0);
  });

  test('steward net: the version rule orders by counter, then by peer id', () => {
    const { newer } = Kit.net;
    assert.strictEqual(newer([1, 'a'], undefined), true, 'anything beats nothing'); assert.strictEqual(newer([2, 'a'], [1, 'z']), true, 'higher counter wins whatever the peer');
    assert.strictEqual(newer([1, 'z'], [2, 'a']), false); assert.strictEqual(newer([3, 'b'], [3, 'a']), true, 'equal counters: higher peer id wins');
    assert.strictEqual(newer([3, 'a'], [3, 'b']), false); assert.strictEqual(newer([3, 'a'], [3, 'a']), false, 'the same version is not newer (no echo loops)');
  });
  test('steward net: the outbox coalesces sets by key in O(1), keeps events, and sends oldest first', () => {
    const transport = recordingTransport(); const net = Kit.net.session(transport, { rate: 1 });
    // The hello sent on opening used the whole budget of 1, so everything below queues until tick() refills it.
    net.set('a', 1); net.set('b', 1); net.emit('roll', 'x'); net.set('a', 2); net.emit('roll', 'y'); net.set('a', 3);
    for (let ticks = 0; ticks < 10; ticks++) net.tick(1);
    assert.strictEqual(transport.sent.map(describeSent).join(), 'hello,b=1,ev:x,ev:y,a=3', 'stale sets of "a" are dropped and the newest takes the back of the queue');
    assert.strictEqual(net.get('a'), 3, 'local state was never behind');
    for (let write = 0; write < 500; write++) net.set('k' + (write % 5), write);
    for (let ticks = 0; ticks < 10; ticks++) net.tick(1);
    assert.strictEqual(describeSent(transport.sent[5]), 'k0=0', 'the idle ticks refilled the budget, so the first write went straight out');
    assert.strictEqual(transport.sent.length, 11, 'the other 499 writes to 5 keys cost 5 sends'); assert.strictEqual(describeSent(transport.sent[10]), 'k4=499');
    net.tick(1); net.set('now', 1); assert.strictEqual(describeSent(transport.sent[11]), 'now=1', 'with budget in hand an urgent message goes straight out');
    net.close(); net.set('late', 1); net.tick(5); assert.strictEqual(transport.sent.length, 12, 'a closed session sends nothing');
  });
  test('steward net: deletes leave a tombstone that beats an older set', () => {
    const hub = Kit.net.loopback(); const a = Kit.net.session(hub.join('a')), b = Kit.net.session(hub.join('b'));
    const heard = []; b.on('', (key, value) => heard.push(`${key}:${value}`));
    a.set('door', 'open'); drain(a, b); a.delete('door'); drain(a, b);
    assert.strictEqual(b.get('door'), undefined); assert.strictEqual(b.has('door'), false); sameJson(b.keys(), []); sameJson(b.all(), []); assert.strictEqual(heard.join(), 'door:open,door:undefined');
    b.patch('stats', { hp: 3 }); b.patch('stats', { mp: 1 }); drain(a, b); sameJson(a.get('stats'), { hp: 3, mp: 1 }, 'patch merges into the current value');
    assert.strictEqual(a.get('never'), undefined); assert.strictEqual(typeof a.onPeers(() => {}), 'function', 'onPeers always returns an unsubscribe');
  });
}
// ---- core: registration checks, development warnings, headless handles (kit/core.js) ----
test('register: checkGame names the cause and the fix; register throws on errors and warns on a missing theme', () => {
  const create = () => ({ update() {} });
  const known = { games: [{ id: 'taken', name: 'Taken' }], skins: ['glass', 'neon'] };
  // Compared as JSON: the result's arrays come from the sandbox's realm, which deepStrictEqual treats as a different type.
  assert.strictEqual(JSON.stringify(Kit.checkGame({ id: 'fresh', name: 'Fresh', theme: { skin: 'neon' }, create }, known)), '{"errors":[],"warnings":[]}', 'control: a good definition is clean');
  const problemsOf = (definition) => Kit.checkGame(definition, known).errors.join(' ');
  assert.match(problemsOf({ name: 'No id', theme: {}, create }), /`id` is missing/);
  assert.match(problemsOf({ id: 'Sky Stack', theme: {}, create }), /id "Sky Stack" must be lowercase/);
  assert.match(problemsOf({ id: 'taken', theme: {}, create }), /id "taken" is already registered by "Taken"/);
  assert.match(problemsOf({ id: 'fresh', theme: {}, create: 5 }), /`create` must be a function .* but got number/);
  assert.match(problemsOf({ id: 'fresh', theme: { skin: 'chrome' }, create }), /theme.skin "chrome" is not a skin. Use one of: glass, neon/);
  assert.match(problemsOf(null), /expected a definition object .* but got null/);
  assert.strictEqual(Kit.checkGame({ id: 'fresh', name: 'Fresh', theme: { skin: 'chrome' }, create }, { games: [], skins: null }).errors.length, 0, 'without kit/theme.js the skin is not checked');
  assert.match(Kit.checkGame({ id: 'fresh', name: 'Fresh', create }, known).warnings.join(' '), /game "fresh" has no `theme`/);
  const countBefore = Kit.games.length;
  assert.throws(() => Kit.register({ id: 'no-create' }), /Kit.register: `create` must be a function/);
  assert.strictEqual(Kit.games.length, countBefore, 'a rejected game is not added');
  assert.strictEqual(Kit.register({ id: 'checked-game', name: 'Checked', theme: {}, create }), countBefore + 1);
  assert.throws(() => Kit.register({ id: 'checked-game', name: 'Again', theme: {}, create }), /already registered by "Checked"/);
});
test('development aids: warnings only in development, once each; expectType names the call and an example', () => {
  const printed = [];
  const realConsole = sandbox.console;
  sandbox.console = { warn: (line) => printed.push(line) };
  try {
    sandbox.KIT_DEV = false;
    assert.strictEqual(Kit.isDevelopment(), false);
    assert.strictEqual(Kit.warn('quiet in the published page'), false);
    assert.strictEqual(printed.length, 0, 'nothing is printed for players');
    sandbox.KIT_DEV = true;
    assert.strictEqual(Kit.warn('said once'), true);
    assert.strictEqual(Kit.warn('said once'), false, 'a repeat is dropped');
    assert.deepStrictEqual(printed, ['[kit] said once']);
    assert.strictEqual(Kit.expectType('ui.stat(label)', 'Coins', 'string', "ui.stat('Coins', 0)"), true);
    assert.strictEqual(Kit.expectType('ui.progress(label)', undefined, 'string|undefined', "ui.progress('XP')"), true, 'optional arguments may be undefined');
    assert.strictEqual(Kit.expectType('ui.stat(label)', 5, 'string', "ui.stat('Coins', 0)"), false);
    assert.strictEqual(printed[1], "[kit] ui.stat(label) expects string but got number (5). Example: ui.stat('Coins', 0)");
    Kit.expectType('ui.actions(list)', null, 'array', 'ui.actions([])'); Kit.expectType('ctx.after(seconds)', NaN, 'number', 'ctx.after(2, run)');
    assert.match(printed[2], /expects array but got null/); assert.match(printed[3], /expects number but got NaN/);
    delete sandbox.KIT_DEV;
    assert.strictEqual(Kit.isDevelopment(), false, 'with no location (node) and no override, it is not development');
    sandbox.location = { hostname: '127.0.0.1' };
    assert.strictEqual(Kit.isDevelopment(), true, 'the local test server counts as development');
    sandbox.location = { hostname: 'published.example' };
    assert.strictEqual(Kit.isDevelopment(), false);
  } finally {
    sandbox.console = realConsole;
    delete sandbox.location; delete sandbox.KIT_DEV;
    Kit.warnings.length = 0;
  }
});
test('headlessOf: `headless` is the standard name; the older `model` and `lab` still work', () => {
  const rules = { createRound: () => ({}) };
  assert.strictEqual(Kit.headlessOf({ id: 'a', headless: rules }), rules);
  assert.strictEqual(Kit.headlessOf({ id: 'b', model: rules }), rules);
  assert.strictEqual(Kit.headlessOf({ id: 'c', lab: rules }), rules);
  assert.strictEqual(Kit.headlessOf({ id: 'd', headless: rules, model: { other: true } }), rules, 'headless wins when both are present');
  assert.strictEqual(Kit.headlessOf({ id: 'e' }), null);
  assert.strictEqual(Kit.headlessOf('no-such-game'), null);
});
// ---- Kit.wallet multi-currency prices and the Core Miner rules (games/miner-rules.js) ------------------------------------
test('wallet.spendAll pays a multi-currency price all or nothing', () => {
  const wallet = Kit.wallet({ copper: 6, silver: 1 });
  assert.strictEqual(wallet.canAll({ copper: 6, silver: 2 }), false); assert.strictEqual(wallet.spendAll({ copper: 6, silver: 2 }), false, 'one part short refuses the whole price');
  assert.strictEqual(wallet.get('copper'), 6, 'nothing was taken on refusal'); assert.strictEqual(wallet.spendAll({ gold: 1 }), false, 'a currency never held counts as 0');
  assert.strictEqual(wallet.spendAll({ copper: 6, silver: 1 }), true, 'exact balances are enough'); assert.strictEqual(wallet.get('copper') + wallet.get('silver'), 0);
  assert.strictEqual(wallet.spendAll({}), true, 'an empty price is free');
});
{
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'games', 'miner-rules.js'), 'utf8'), sandbox, { filename: 'miner-rules.js' });
  const RULES = sandbox.CORE_MINER_RULES;
  const shaft = (id) => RULES.SHAFTS.byId(id);
  test('miner: ore tiers rotate through what has been found; cores and debut depths are the newest tier', () => {
    assert.deepStrictEqual([1, 2, 3].map((depth) => RULES.tierAt(depth).id), ['copper', 'copper', 'copper']);
    assert.strictEqual(RULES.tierAt(4).id, 'silver', 'debut depth'); assert.strictEqual(RULES.tierAt(5).id, 'silver', 'core is the newest tier');
    assert.strictEqual(RULES.tierAt(7).id, 'gold', 'debut wins over the rotation'); assert.strictEqual(RULES.tierAt(8).id, 'silver', 'rotation: (8 - 1) % 3 = 1');
    const deep = Array.from({ length: 30 }, (unused, index) => RULES.tierAt(40 + index).id);
    RULES.ORE_TIERS.forEach((tier) => assert.ok(deep.includes(tier.id), tier.id + ' still turns up at depth 40-69, so the forge never runs dry'));
    assert.strictEqual(RULES.oreSpecAt(1).isNewTier, false, 'the first ore is not announced'); assert.strictEqual(RULES.oreSpecAt(4).isNewTier, true); assert.strictEqual(RULES.oreSpecAt(8).isNewTier, false);
  });
  test('miner: ore HP and value follow depth, cores, the shaft and the core-HP stat', () => {
    const plain = RULES.oreSpecAt(4), core = RULES.oreSpecAt(5);
    assert.strictEqual(RULES.oreSpecAt(1).hp, 10); assert.strictEqual(plain.hp, Math.ceil(10 * 1.6 ** 3)); assert.strictEqual(core.hp, Math.ceil(10 * 1.6 ** 4 * RULES.CORE.hpTimes)); assert.strictEqual(core.isCore, true);
    assert.strictEqual(RULES.oreSpecAt(4, { shaft: shaft('rich') }).hp, Math.ceil(plain.hp * 1.6 - 1e-9), 'shaft HP multiplier');
    assert.strictEqual(RULES.oreSpecAt(4, { coreHp: 0.5 }).hp, plain.hp, 'core HP stat leaves ordinary ores alone'); assert.strictEqual(RULES.oreSpecAt(5, { coreHp: 0.5 }).hp, Math.ceil(10 * 1.6 ** 4 * RULES.CORE.hpTimes * 0.5));
    const paid = RULES.payoutFor(core, shaft('ironstone'), { value: 2, chunks: 1 });
    assert.strictEqual(paid.coins, core.value * 2); assert.strictEqual(paid.chunks, RULES.CORE.chunks * 2, 'ironstone doubles chunks');
    assert.strictEqual(RULES.crackPayout(95), 10, 'a crack pays a tenth, rounded up');
  });
  test('miner: crack stages open at quarters, never close and never on the killing blow', () => {
    assert.deepStrictEqual([1, 0.76, 0.75, 0.5, 0.26, 0.25, 0.01].map(RULES.crackStageAt), [0, 0, 1, 2, 2, 3, 3]);
    let ore = RULES.newOre(RULES.oreSpecAt(6));
    ore = RULES.damageOre(ore, ore.maxHp * 0.6); assert.strictEqual(ore.crackStage, 2);
    ore = RULES.regrowOre(ore, 1000, RULES.biomeAt(25)); assert.strictEqual(ore.hp, ore.maxHp, 'regrowth stops at full'); assert.strictEqual(ore.crackStage, 2, 'regrowth does not close a fissure');
    assert.strictEqual(RULES.regrowOre(ore, 5, RULES.biomeAt(1)), ore, 'no regrowth in the first biome');
    assert.strictEqual(RULES.damageOre(ore, ore.maxHp * 2).crackStage, 2, 'the killing blow opens no stage');
  });
  test('miner: heat builds on quick taps, overheats at the top, vents, and obeys the shaft and biome', () => {
    const rule = RULES.heatRuleFor(shaft('main'), RULES.biomeAt(1));
    let streak = RULES.restingStreak(rule);
    streak = RULES.extendStreak(streak, 99, rule, 2); assert.strictEqual(streak.heat, 0, 'a late tap adds no heat'); assert.strictEqual(streak.combo, 0);
    streak = RULES.extendStreak(streak, 0.1, rule, 2); near(streak.heat, RULES.HEAT.perTap, 'a quick tap adds heat'); assert.strictEqual(streak.combo, 1);
    const hot = RULES.extendStreak({ combo: 9, heat: 1 - RULES.HEAT.perTap / 2, ventLeft: 0 }, 0.1, rule, 2);
    assert.strictEqual(hot.didOverheat, true); assert.strictEqual(hot.heat, 0); assert.strictEqual(hot.ventLeft, 2); assert.strictEqual(hot.combo, 0);
    const cooled = RULES.coolStreak(hot, 0.5, rule); near(cooled.ventLeft, 1.5, 'vent runs down'); assert.strictEqual(RULES.coolStreak(hot, 9, rule).ventLeft, 0);
    const magma = RULES.heatRuleFor(shaft('main'), RULES.biomeAt(45)); assert.strictEqual(RULES.coolStreak({ combo: 0, heat: 0.9, ventLeft: 0 }, 99, magma).heat, magma.floor, 'magma never cools below its floor'); assert.ok(magma.floor > 0);
    assert.strictEqual(RULES.heatRuleFor(shaft('gas'), RULES.biomeAt(1)).perTap, rule.perTap * 2, 'gas pocket doubles heat');
    const flooded = RULES.heatRuleFor(shaft('flooded'), RULES.biomeAt(45)); assert.strictEqual(flooded.perTap, 0); assert.strictEqual(flooded.floor, 0, 'a flooded drift drowns even magma warmth');
  });
  test('miner: strike damage multiplies heat, crit, weak point and shaft; a venting pick ignores heat', () => {
    const power = { damage: 10, critMult: 4, weakMult: 2.5, heatBonus: 0.6 };
    const strike = (patch) => ({ heat: 0, isVenting: false, isCrit: false, isWeak: false, ...patch });
    near(RULES.strikeDamage(power, strike({}), shaft('main')), 10, 'plain'); near(RULES.strikeDamage(power, strike({ heat: 1 }), shaft('main')), 16, 'full heat');
    near(RULES.strikeDamage(power, strike({ isCrit: true, isWeak: true }), shaft('main')), 100, 'crit x weak'); near(RULES.strikeDamage(power, strike({ isWeak: true }), shaft('gallery')), 50, 'gallery doubles weak hits');
    near(RULES.strikeDamage(power, strike({ heat: 1, isVenting: true }), shaft('main')), 10 * RULES.HEAT.ventDamage, 'venting: feeble and no heat bonus'); near(RULES.strikeDamage(power, strike({}), shaft('ironstone')), 6, 'ironstone blunts taps');
    near(RULES.drillDps(10, shaft('ironstone'), RULES.biomeAt(45)), 10 * 1.5 * 0.75, 'drills: shaft x biome');
  });
  test('miner: shards, head-start coins, biomes and shaft offers', () => {
    assert.strictEqual(RULES.shardsFor(RULES.PRESTIGE.minDepth - 1, 1), 0); assert.strictEqual(RULES.shardsFor(RULES.PRESTIGE.minDepth, 1), 1); assert.strictEqual(RULES.shardsFor(24, 1), 5); assert.strictEqual(RULES.shardsFor(24, 2), 10);
    assert.strictEqual(RULES.headStartCoins(1), 0); assert.strictEqual(RULES.headStartCoins(3), Math.floor(0.6 * (12 + 12 * 1.42)));
    assert.deepStrictEqual([1, 20, 21, 40, 41, 99].map((depth) => RULES.biomeAt(depth).id), ['timber', 'timber', 'hollows', 'hollows', 'magma', 'magma']);
    const offers = RULES.offerShafts(3, Kit.rng(5).next); assert.strictEqual(offers.length, 3); assert.strictEqual(new Set(offers.map((row) => row.id)).size, 3, 'offers are distinct');
  });
  test('miner model: a core forks the shaft, gear forms sets, a collapse resets the run and keeps the long arc', () => {
    const save = mem(); const model = RULES.createModel({ save, random: Kit.rng(3).next });
    for (let depth = 1; depth < 5; depth++) assert.strictEqual(model.breakOre(model.spec()).fork, null, 'no fork after an ordinary ore');
    const core = model.spec(); const result = model.breakOre(core);
    assert.strictEqual(result.fork.length, 2); assert.strictEqual(model.run.depth, 6); assert.throws(() => model.chooseShaft('nope'), /not on offer/);
    model.chooseShaft(result.fork[0].id); assert.strictEqual(model.shaft().id, result.fork[0].id); assert.throws(() => model.chooseShaft(result.fork[0].id), /no fork/);
    assert.ok(model.wallet.get('copper') >= 3 && model.wallet.get('silver') >= 3, 'ores dropped chunks of their tier');
    model.wallet.add(20, 'copper'); model.wallet.add(20, 'silver');
    assert.strictEqual(model.gear.craft('bronze-head'), true); assert.strictEqual(model.gear.craft('bronze-head'), false, 'a piece is forged once'); near(model.stats.get('damage'), 1.4, 'worn gear feeds stats');
    assert.strictEqual(model.gear.craft('rivet'), true); assert.strictEqual(model.synergies.active().map((row) => row.id).join(), 'sparks', 'two spark tags form the set'); near(model.stats.get('critMult'), 6, 'set bonus');
    assert.strictEqual(model.collapse(), 0, 'too shallow to collapse'); assert.strictEqual(model.run.depth, 6);
    model.upgrades.grant('pick'); model.wallet.add(500);
    while (model.run.depth < 14) { const outcome = model.breakOre(model.spec()); if (outcome.fork) model.chooseShaft(outcome.fork[0].id); }
    const shards = model.shardsOnCollapse(); assert.strictEqual(shards, 1); assert.strictEqual(model.collapse(), shards);
    assert.strictEqual(model.run.depth, 1); assert.strictEqual(model.shaft().id, 'main'); assert.strictEqual(model.wallet.get(), 0, 'coins reset'); assert.strictEqual(model.upgrades.level('pick'), 0, 'coin upgrades reset');
    assert.strictEqual(model.wallet.get('shards'), 1); assert.ok(model.gear.isOwned('bronze-head'), 'gear is kept'); near(model.stats.get('critMult'), 6, 'the set is still worn');
    assert.ok(model.relics().some((relic) => relic.id === 'map'), 'the first collapse unlocks its relic'); assert.strictEqual(Math.round(model.stats.get('shaftOffers')), 3, 'and the relic changes a rule');
    const reloaded = RULES.createModel({ save }); assert.strictEqual(reloaded.run.depth, 1); assert.ok(reloaded.gear.isOwned('rivet')); near(reloaded.stats.get('critMult'), 6, 'sets and relics are restored from the save'); assert.strictEqual(Math.round(reloaded.stats.get('shaftOffers')), 3);
  });
}
// ---- Tower Smash rules and simulation (games/sling-data.js, games/sling-sim.js; the simulation runs on the real cannon.js) ----
if (!Kit.profile) loadKitFile('kit/meta.js');
['games/sling-data.js', 'games/sling-sim.js'].forEach(loadKitFile);
test('sling: levels are repeatable, playable with the cheapest loadout, and stay on the platform', () => {
  const data = sandbox.TOWER_SMASH_DATA;
  const campaign = data.WORLDS.filter((world) => !world.isEndless).flatMap((world) => Array.from({ length: world.levels }, (_, index) => data.levelAt(world.id, index)));
  assert.strictEqual(campaign.length, 18);
  campaign.concat([data.levelAt('skyline', 0), data.levelAt('skyline', 40), data.dailyChallenge(20000).level]).forEach((level) => {
    if (level.worldId !== 'daily') assert.strictEqual(JSON.stringify(data.levelAt(level.worldId, level.index).blocks), JSON.stringify(level.blocks), level.key + ' regenerates identically');
    assert.ok(level.blocks.some((block) => data.MATERIALS.byId(block.materialId).isTarget), level.key + ' has a target');
    assert.ok(level.shots >= 2 && level.shots <= 5 && level.budget >= level.shots, level.key + ' affords one heavy ball per shot');
    assert.ok(level.blocks.every((block) => Math.abs(block.x) + block.size[0] / 2 <= data.WORLD.platform.halfWidth + 1e-9), level.key + ' fits the platform');
  });
  assert.strictEqual(JSON.stringify(data.dailyChallenge(20000)), JSON.stringify(data.dailyChallenge(20000)), 'the daily tower is the same for everyone');
  assert.notStrictEqual(JSON.stringify(data.dailyChallenge(20000).level.blocks), JSON.stringify(data.dailyChallenge(20001).level.blocks), 'and changes with the day');
});
test('sling: rating rises with height, crystal, stone and wind, falls with kegs, and never drops below one', () => {
  const { rateLevel } = sandbox.TOWER_SMASH_DATA;
  const block = (materialId, y = 0.4) => ({ x: 0, y, z: 0, size: [0.8, 0.8, 0.8], materialId });
  const base = rateLevel({ blocks: [block('gem')] });
  assert.ok(rateLevel({ blocks: [block('gem', 4)] }) > base, 'higher target');
  assert.ok(rateLevel({ blocks: [block('crystal')] }) > base, 'crystal');
  assert.ok(rateLevel({ blocks: [block('gem'), block('stone')] }) > base, 'stone');
  assert.ok(rateLevel({ blocks: [block('gem')], windX: -5 }) > base, 'wind in either direction');
  assert.ok(rateLevel({ blocks: [block('gem', 4), block('keg')] }) < rateLevel({ blocks: [block('gem', 4)] }), 'a keg is help');
  near(rateLevel({ blocks: [block('gem'), block('keg'), block('keg'), block('keg')] }), 1, 'floor of one');
});
test('sling: stars need a clear; the spare-shot and chain stars sit exactly on their thresholds', () => {
  const { rateResult } = sandbox.TOWER_SMASH_DATA, level = { chainPar: 3 };
  assert.strictEqual(rateResult({ cleared: false, shotsLeft: 2, bestChain: 9, score: 0 }, level).stars, 0, 'no clear, no stars');
  assert.strictEqual(rateResult({ cleared: true, shotsLeft: 0, bestChain: 2, score: 0 }, level).stars, 1);
  assert.strictEqual(rateResult({ cleared: true, shotsLeft: 1, bestChain: 2, score: 0 }, level).stars, 2);
  assert.strictEqual(rateResult({ cleared: true, shotsLeft: 0, bestChain: 3, score: 0 }, level).stars, 2, 'chain star without the spare star');
  assert.strictEqual(rateResult({ cleared: true, shotsLeft: 1, bestChain: 3, score: 0 }, level).rules.map((rule) => rule.isMet).join(), 'true,true,true');
});
test('sling: progress keeps best stars, unlocks on thresholds, ignores the daily tower and always has a next level', () => {
  const data = sandbox.TOWER_SMASH_DATA, progress = data.createProgress({ save: mem() });
  const win = (stars) => ({ cleared: true, shotsLeft: stars >= 2 ? 1 : 0, bestChain: stars >= 3 ? 99 : 0, score: 1000 });
  assert.strictEqual(progress.ownedBalls().map((ball) => ball.id).join(), 'heavy');
  assert.strictEqual(progress.isLevelOpen('toybox', 1), false, 'level 2 is closed until level 1 is cleared');
  const first = progress.recordResult(data.levelAt('toybox', 0), win(2));
  assert.strictEqual(first.newStars, 2); assert.strictEqual(first.shards, 10 + 2 * 6); assert.ok(first.unlocked.includes('New ball: Splitter'));
  assert.strictEqual(progress.recordResult(data.levelAt('toybox', 0), win(1)).newStars, 0); assert.strictEqual(progress.totalStars(), 2, 'a worse replay keeps the best');
  assert.strictEqual(progress.recordResult(data.levelAt('toybox', 0), { cleared: false, shotsLeft: 0, bestChain: 0, score: 0 }).shards, 0, 'a failure pays nothing');
  assert.strictEqual(JSON.stringify(progress.nextLevel()), JSON.stringify({ worldId: 'toybox', index: 1 }));
  progress.recordResult(data.dailyChallenge(1).level, win(3));
  assert.strictEqual(progress.totalStars(), 2, 'daily stars do not count');
  for (let index = 1; index < 6; index++) progress.recordResult(data.levelAt('toybox', index), win(1));
  assert.strictEqual(progress.totalStars(), 7); assert.strictEqual(progress.isWorldOpen(data.WORLDS.byId('quarry')), false, 'needs 9');
  assert.strictEqual(JSON.stringify(progress.nextLevel()), JSON.stringify({ worldId: 'toybox', index: 1 }), 'stuck behind a gate: replay the weakest level');
  progress.recordResult(data.levelAt('toybox', 1), win(3));
  assert.strictEqual(progress.isWorldOpen(data.WORLDS.byId('quarry')), true); assert.strictEqual(progress.nextLevel().worldId, 'quarry');
  assert.strictEqual(progress.budgetFor({ budget: 5 }), 5); progress.wallet.add(500, 'shards'); progress.upgrades.buy('pouch');
  assert.strictEqual(progress.budgetFor({ budget: 5 }), 6, 'the pouch upgrade adds a loadout point');
});
test('sling sim: same seed and aim give the same rubble; the preview ends where the ball first hits, wind included', () => {
  const data = sandbox.TOWER_SMASH_DATA, sim = sandbox.TOWER_SMASH_SIM, heavy = data.BALLS.byId('heavy');
  const run = (level, aim) => {
    const world = sim.createSim({ level, rng: Kit.rng(5) });
    let firstImpact = null;
    world.on('firstImpact', ({ point }) => (firstImpact = firstImpact || point));
    const predicted = world.predict(heavy, aim).end;
    world.launch(heavy, aim);
    for (let frame = 0; frame < 600 && (world.isShotLive() || !world.isCalm()); frame++) world.step(1 / 60);
    return { rubble: JSON.stringify(world.snapshot()), firstImpact, predicted, targets: world.targetsLeft() };
  };
  const wall = data.levelAt('toybox', 0), aim = data.aimFromPull(0.62, -0.25);
  assert.strictEqual(run(wall, aim).rubble, run(wall, aim).rubble, 'repeatable');
  [[wall, aim], [data.levelAt('ridge', 0), data.aimFromPull(0.7, -0.3)], [{ ...wall, windX: -6 }, data.aimFromPull(0.55, 0.2)]].forEach(([level, shot]) => {
    const { firstImpact, predicted } = run(level, shot);
    assert.ok(firstImpact, 'the shot hit something');
    const miss = Math.hypot(firstImpact.x - predicted.x, firstImpact.y - predicted.y, firstImpact.z - predicted.z);
    assert.ok(miss < 0.2, `preview within a fifth of a metre of the first contact (wind ${level.windX}): ${miss.toFixed(3)}`);
  });
});
test('sling sim: blasts chain through kegs, stone feels a third of the push, crystal cannot be blasted, taps need their upgrade', () => {
  const data = sandbox.TOWER_SMASH_DATA, sim = sandbox.TOWER_SMASH_SIM;
  const cube = (x, y, materialId) => ({ x, y, z: 0, size: [0.8, 0.8, 0.8], materialId });
  const level = { ...data.levelAt('toybox', 0), windX: 0, blocks: [cube(0, 1.2, 'gem'), cube(0, 0.4, 'brick'), cube(-1.3, 0.4, 'brick'), cube(1.3, 0.4, 'stone'), cube(-1.3, 1.201, 'crystal'), cube(1.3, 1.201, 'keg')] };
  const world = sim.createSim({ level, rng: Kit.rng(3) });
  const speeds = {}, broken = [];
  world.on('blast', () => world.state.blocks.forEach((block) => (speeds[block.index] = speeds[block.index] === undefined ? block.body.velocity.length() : speeds[block.index])));
  world.on('break', ({ block, chain }) => broken.push(block.material.id + chain));
  const bomb = data.BALLS.byId('bomb');
  // Find an aim whose preview ends on the gem, the way a player would.
  const aim = Array.from({ length: 80 }, (_, step) => data.aimFromPull(0.2 + step * 0.01, 0)).find((candidate) => Math.abs(world.predict(bomb, candidate).end.y - 2.0) < 0.25);
  assert.ok(aim, 'an aim reaches the gem');
  world.launch(bomb, aim);
  for (let frame = 0; frame < 240; frame++) world.step(1 / 60);
  assert.strictEqual(broken.slice(0, 2).join(), 'gem1,keg2', 'the gem breaks at once, the keg a fuse later, each extending the chain');
  assert.ok(!broken.some((entry) => entry.startsWith('crystal1')) && !broken.slice(0, 2).some((entry) => entry.startsWith('crystal')), 'the blast itself never breaks crystal');
  assert.ok(speeds[2] > 0 && speeds[3] > 0 && speeds[3] < speeds[2] * 0.5, `stone (${speeds[3].toFixed(2)}) is pushed far less than brick (${speeds[2].toFixed(2)}) at the same distance`);
  const tapWith = (stats) => {
    const flight = sim.createSim({ level, stat: (name) => ({ ...data.STATS_BASE, ...stats })[name] });
    flight.launch(data.BALLS.byId('heavy'), data.aimFromPull(0.9, 0));
    for (let frame = 0; frame < 10; frame++) flight.step(1 / 60);
    return { didTap: flight.tap(), speedY: flight.state.balls[0].body.velocity.y, tappedTwice: flight.tap() };
  };
  assert.strictEqual(tapWith({}).didTap, false, 'no slam without the upgrade');
  const slammed = tapWith({ slam: 1 });
  assert.strictEqual(slammed.didTap, true); near(slammed.speedY, -data.BALLS.byId('heavy').slam.speed, 'dives straight down'); assert.strictEqual(slammed.tappedTwice, false, 'once per shot');
  const splitter = sim.createSim({ level: data.levelAt('toybox', 0), stat: (name) => ({ ...data.STATS_BASE, splitCount: 5 })[name] });
  splitter.launch(data.BALLS.byId('splitter'), data.aimFromPull(0.8, 0));
  for (let frame = 0; frame < 8; frame++) splitter.step(1 / 60);
  assert.strictEqual(splitter.tap(), true); assert.strictEqual(splitter.state.balls.length, 5, 'the cluster upgrade fans into five');
});

// ---- games/arena-*.js: Swarm Arena's pure rules (data, simulation, profile, bots) ---------------------------------
for (const file of ['games/arena-data.js', 'games/arena-sim.js', 'games/arena-bots.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
{
  const { data: arenaData, sim: arenaSim, meta: arenaMeta, bots: arenaBots } = sandbox.Arena;
  const still = { x: 0, y: 0, dash: false };
  const FRAME = 1 / 60;
  /** A run with the opening swarm removed, so a test places exactly the enemies it is about. */
  const emptyRun = (options) => { const run = arenaSim.createRun(options); run.world.enemies.length = 0; return run; };
  const enemyAt = (run, typeId, x, z, options) => arenaSim.spawnEnemy(run, arenaData.ENEMIES.byId(typeId), x, z, options);
  test('arena: experience crosses several levels at each level\'s own price', () => {
    const price = arenaData.XP_TO_NEXT_LEVEL;
    const result = arenaSim.addExperience(1, 0, price(1) + price(2) + 1);
    assert.strictEqual(result.level, 3); assert.strictEqual(result.levelsGained, 2); near(result.xp, 1, 'remainder is banked');
    assert.strictEqual(arenaSim.addExperience(4, 0, price(4) - 0.01).levelsGained, 0, 'just short of the price is no level');
  });
  test('arena: the first hand holds a weapon, slots close doors, an evolution needs both parents maxed', () => {
    for (let i = 0; i < 30; i++) assert.ok(arenaSim.rollHand(arenaSim.createRun()).some((row) => row.kind === 'weapon'), 'first hand always has a weapon');
    const run = emptyRun();
    ['multi', 'pierce', 'blade'].forEach((id) => arenaSim.takeUpgrade(run, id));
    assert.strictEqual(run.upgrades.slotUse('weapon'), 3);
    const anvil = emptyRun({ shipId: 'anvil', unlocked: ['anvil', 'pulse'] });
    arenaSim.takeUpgrade(anvil, 'multi');
    for (let i = 0; i < 40; i++) assert.ok(!arenaSim.rollHand(anvil).some((row) => row.kind === 'weapon' && anvil.upgrades.level(row.id) === 0), 'a ship with two weapon slots is never offered a third weapon');
    const offersStorm = () => { for (let i = 0; i < 40; i++) if (arenaSim.rollHand(run).some((row) => row.id === 'storm')) return true; return false; };
    arenaSim.takeUpgrade(run, 'multi'); arenaSim.takeUpgrade(run, 'multi');
    ['rate', 'rate'].forEach((id) => arenaSim.takeUpgrade(run, id));
    assert.strictEqual(offersStorm(), false, 'one parent short of max: no evolution');
    arenaSim.takeUpgrade(run, 'rate');
    assert.strictEqual(offersStorm(), true, 'both parents maxed: the evolution is offered');
    arenaSim.takeUpgrade(run, 'storm'); assert.strictEqual(run.world.build.rearFan, 1); assert.strictEqual(run.world.evolutions, 1);
  });
  test('arena: synergies switch on at their tag counts and feed the build; excluded rows are never offered', () => {
    const run = emptyRun({ unlocked: ['reactor', 'mines'] });
    const baseRate = run.world.build.fireRate;
    arenaSim.takeUpgrade(run, 'multi'); arenaSim.takeUpgrade(run, 'mines');
    assert.strictEqual(run.synergies.active().length, 0, 'two kinetic rows are not three');
    const { gained } = arenaSim.takeUpgrade(run, 'dmg');
    assert.strictEqual(gained.map((synergy) => synergy.id).join(), 'battery');
    near(run.world.build.fireRate, baseRate * 0.92 * 1.2, 'battery multiplies the fire rate that Heavy Rounds lowered');
    arenaSim.takeUpgrade(run, 'plating');
    for (let i = 0; i < 40; i++) assert.ok(!arenaSim.rollHand(run).some((row) => row.id === 'reactor'), 'Glass Reactor is excluded by Plating');
  });
  test('arena: frontal armour blunts plain shots but not piercing ones; an armour cap limits one hit', () => {
    const shootOnce = (pierce) => {
      const run = emptyRun();
      if (pierce) arenaSim.takeUpgrade(run, 'pierce');
      const bulwark = enemyAt(run, 'bulwark', 0, 4);
      const before = bulwark.hp;
      for (let i = 0; i < 40 && bulwark.hp === before; i++) arenaSim.step(run, FRAME, still);
      return { lost: before - bulwark.hp, damage: run.world.build.damage };
    };
    const plain = shootOnce(false), lance = shootOnce(true);
    near(plain.lost, plain.damage * arenaData.ENEMIES.byId('bulwark').frontArmor, 'a plain shot does a quarter');
    near(lance.lost, lance.damage, 'a piercing shot does full damage');
    const run = emptyRun();
    const armored = enemyAt(run, 'brute', 9, 9, { isElite: true, affixes: [arenaData.AFFIXES.byId('armored')] });
    const before = armored.hp;
    arenaSim.damageEnemy(run, armored, 50, 0, 0, {});
    near(before - armored.hp, arenaData.AFFIXES.byId('armored').armorCap, 'a 50 damage hit is capped');
  });
  test('arena: a dash is invulnerable, goes on cooldown, and a graze refunds it only when nothing hit', () => {
    const run = emptyRun();
    const { world } = run;
    enemyAt(run, 'grunt', 0, 0.5).age = 1; // on top of the hero and past its spawn grace
    arenaSim.step(run, FRAME, { x: 1, y: 0, dash: true });
    assert.strictEqual(world.hp, world.build.maxHp, 'no damage while dashing through');
    assert.ok(world.hero.dashCooldown > 2, 'cooldown started'); assert.ok(world.hero.x > 0.3, 'moved at dash speed');
    arenaSim.step(run, FRAME, { x: 1, y: 0, dash: true });
    assert.strictEqual(world.hero.dashId, 1, 'a second dash during the cooldown is refused');
    // Graze: an enemy held just outside touching range, then taken away, with the hero vulnerable throughout.
    const grazeRun = emptyRun();
    const passer = enemyAt(grazeRun, 'brute', 0, 0); passer.age = 1; passer.speed = 0;
    const reach = passer.size * arenaData.ENEMY.touchReachScale + arenaData.ENEMY.touchReachPadding;
    grazeRun.world.hero.dashCooldown = 2;
    passer.z = reach + 0.3; arenaSim.step(grazeRun, FRAME, still);
    passer.z = reach + 5; arenaSim.step(grazeRun, FRAME, still);
    assert.strictEqual(grazeRun.world.grazes, 1); assert.ok(grazeRun.world.hero.dashCooldown < 2 - 0.4, 'Dart refunds half a second');
    assert.strictEqual(grazeRun.world.hp, grazeRun.world.build.maxHp, 'a graze is not a hit');
    passer.z = reach + 5.1; arenaSim.step(grazeRun, FRAME, still);
    assert.strictEqual(grazeRun.world.grazes, 1, 'an enemy that stays away does not graze again');
  });
  test('arena: a blast hurts only inside its circle after its fuse; splitters split; killing every warden clears the run', () => {
    const run = emptyRun({ tierId: 'tier2' });
    const { world } = run;
    const volatile = enemyAt(run, 'grunt', 12, 0, { isElite: true, affixes: [arenaData.AFFIXES.byId('volatile')] });
    arenaSim.damageEnemy(run, volatile, 9999, 0, 0, {});
    assert.strictEqual(world.blasts.length, 1); assert.strictEqual(world.elites, 1); assert.strictEqual(world.rerolls, 1, 'an elite drops a reroll');
    world.blasts[0].x = 0; world.blasts[0].z = 30; // far from the hero
    for (let i = 0; i < 60; i++) arenaSim.step(run, FRAME, still);
    assert.strictEqual(world.blasts.length, 0, 'burst after its fuse'); assert.strictEqual(world.hp, world.build.maxHp, 'outside the circle: unhurt');
    world.enemies.length = 0;
    const splitter = enemyAt(run, 'splitter', 12, 12);
    arenaSim.damageEnemy(run, splitter, 9999, 0, 0, {});
    assert.strictEqual(world.enemies.filter((enemy) => enemy.type.id === 'mote').length, 2);
    const warden = enemyAt(run, 'warden', 14, 0); world.bossesAlive = 1;
    assert.strictEqual(warden.hp, arenaData.ENEMIES.byId('warden').hp * arenaData.TIERS.byId('tier2').hpScale, 'bosses scale with the tier, not with time');
    arenaSim.damageEnemy(run, warden, 99999, 0, 0, {});
    assert.strictEqual(world.outcome, 'cleared'); assert.strictEqual(arenaSim.summarize(run).isCleared, true);
  });
  test('arena: the profile unlocks mechanics from what runs did, gates tiers, and repairs a stale loadout', () => {
    const profile = arenaMeta.createProfile();
    assert.strictEqual(arenaMeta.validLoadout(profile, { shipId: 'anvil', arenaId: 'nowhere', tierId: 'tier3' }).shipId, 'dart', 'locked ship falls back');
    assert.strictEqual(arenaMeta.validLoadout(profile, { tierId: 'tier2' }).tierId, 'tier1', 'tier II is closed until tier I is cleared');
    const summary = { seconds: 80, kills: 99, elites: 0, bosses: 0, gems: 50, grazes: 0, evolutions: 0, level: 6, isCleared: false, tierRank: 1 };
    assert.strictEqual(arenaMeta.recordRun(profile, summary).unlocked.length, 0, '99 kills: nothing yet');
    assert.strictEqual(arenaMeta.recordRun(profile, { ...summary, kills: 1 }).unlocked.join(), 'pulse', 'the hundredth kill unlocks the Pulse Coil');
    const cleared = arenaMeta.recordRun(profile, { ...summary, bosses: 1, isCleared: true });
    assert.strictEqual(cleared.unlocked.join(), 'prism'); assert.strictEqual(arenaMeta.isTierOpen(profile, arenaData.TIERS.byId('tier2')), true);
    assert.strictEqual(arenaMeta.isTierOpen(profile, arenaData.TIERS.byId('tier3')), false);
    const run = arenaMeta.createRunFor(profile, { shipId: 'prism', tierId: 'tier2' });
    assert.strictEqual(run.ship.id, 'prism'); assert.strictEqual(run.upgrades.level('pierce'), 1, 'the Prism starts with Lance Rounds');
    assert.ok(run.upgrades.table.has('pulse') && !run.upgrades.table.has('mines'), 'the pool holds what is unlocked and only that');
    assert.strictEqual(run.upgrades.table.has('nova'), true, 'an evolution whose parents are both in the pool is in it too');
    assert.strictEqual(run.upgrades.table.has('cluster'), false, 'an evolution with a locked parent stays out of the pool');
  });
  test('arena: a bot run ends, and standing still does worse than evading', () => {
    const sandboxMath = vm.runInContext('Math', sandbox); // the kit reads the sandbox's own Math.random at call time
    const realRandom = sandboxMath.random;
    let seed = 7; sandboxMath.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const seconds = (mover) => arenaBots.playRun(arenaSim.createRun(), { mover: arenaBots.MOVERS[mover], mostSeconds: 70 }).seconds;
    const idle = (seconds('idle') + seconds('idle')) / 2, evade = (seconds('evade') + seconds('evade')) / 2;
    sandboxMath.random = realRandom;
    assert.ok(evade >= idle, `evading pilot (${evade}s) should outlast the idle one (${idle}s)`);
  });
}
// ---- kit/ui/logic.js: the pure decisions behind the component library ----
{
  loadKitFile('kit/ui/logic.js');
  const { createQueue, enqueue, dismiss, rovingIndex, toggleSelection, isSelected, searchRows, clampFraction, placePanel } = Kit.uiLogic;
  const idsOf = (notices) => notices.map((notice) => notice.id).join();
  test('uiLogic notice queue: shows up to the limit, holds the rest, promotes in arrival order', () => {
    const full = [1, 2, 3, 4, 5].reduce((queue, id) => enqueue(queue, { id }), createQueue(3));
    assert.strictEqual(idsOf(full.showing), '1,2,3'); assert.strictEqual(idsOf(full.waiting), '4,5');
    const afterOne = dismiss(full, 2);
    assert.strictEqual(idsOf(afterOne.showing), '1,3,4', 'the longest-waiting notice takes the freed slot'); assert.strictEqual(idsOf(afterOne.waiting), '5');
    assert.strictEqual(idsOf(dismiss(full, 5).waiting), '4', 'a waiting notice can be withdrawn'); assert.strictEqual(idsOf(dismiss(full, 5).showing), '1,2,3');
    assert.strictEqual(idsOf(dismiss(full, 99).showing), '1,2,3', 'an unknown id changes nothing'); assert.strictEqual(idsOf(full.showing), '1,2,3', 'the input queue is not mutated');
    const one = enqueue(enqueue(createQueue(), { id: 'a' }), { id: 'b' });
    assert.strictEqual(idsOf(one.showing), 'a', 'the default limit is one'); assert.strictEqual(idsOf(dismiss(one, 'a').showing), 'b');
  });
  test('uiLogic rovingIndex: arrows step and wrap, Home and End jump, disabled items are skipped', () => {
    assert.strictEqual(rovingIndex('ArrowRight', 0, 3), 1); assert.strictEqual(rovingIndex('ArrowDown', 2, 3), 0, 'wraps forward');
    assert.strictEqual(rovingIndex('ArrowLeft', 0, 3), 2, 'wraps backward'); assert.strictEqual(rovingIndex('ArrowUp', 2, 3), 1);
    assert.strictEqual(rovingIndex('Home', 2, 4), 0); assert.strictEqual(rovingIndex('End', 0, 4), 3);
    const secondDisabled = (index) => index === 1;
    assert.strictEqual(rovingIndex('ArrowRight', 0, 3, secondDisabled), 2, 'steps over a disabled item');
    assert.strictEqual(rovingIndex('Home', 2, 3, (index) => index === 0), 1, 'Home lands on the first enabled item');
    assert.strictEqual(rovingIndex('End', 0, 3, (index) => index === 2), 1, 'End lands on the last enabled item');
    assert.strictEqual(rovingIndex('ArrowRight', 0, 3, (index) => index !== 0), -1, 'nowhere to go when every other item is disabled');
    assert.strictEqual(rovingIndex('a', 0, 3), -1, 'other keys are not focus keys'); assert.strictEqual(rovingIndex('ArrowRight', 0, 0), -1);
  });
  test('uiLogic selection: single replaces, multiple toggles', () => {
    assert.strictEqual(toggleSelection('a', 'b'), 'b'); same(toggleSelection(['a'], 'b', true), ['a', 'b']); same(toggleSelection(['a', 'b'], 'a', true), ['b']);
    same(toggleSelection(undefined, 'a', true), ['a'], 'no selection yet');
    assert.strictEqual(isSelected('a', 'a'), true); assert.strictEqual(isSelected(['a', 'b'], 'b'), true); assert.strictEqual(isSelected(['a'], 'b'), false); assert.strictEqual(isSelected(null, 'a'), false);
  });
  test('uiLogic searchRows: every word must appear in some field, any case; empty keeps all', () => {
    const rows = [{ id: 1, name: 'Neon Run', tagline: 'Swipe to dodge' }, { id: 2, name: 'Core Miner', tagline: 'Tap the ore' }, { id: 3, name: 'Run Aground' }];
    const found = (query) => searchRows(rows, query, ['name', 'tagline']).map((row) => row.id).join();
    assert.strictEqual(found('run'), '1,3'); assert.strictEqual(found('RUN swipe'), '1', 'words may match different fields'); assert.strictEqual(found('ore'), '2', 'matches inside a word');
    assert.strictEqual(found('run ore'), '', 'all words are required'); assert.strictEqual(found('   '), '1,2,3'); assert.strictEqual(found(undefined), '1,2,3');
  });
  test('uiLogic clampFraction and placePanel', () => {
    assert.strictEqual(clampFraction(1.4), 1); assert.strictEqual(clampFraction(-2), 0); assert.strictEqual(clampFraction(0.25), 0.25); assert.strictEqual(clampFraction(NaN), 0); assert.strictEqual(clampFraction('x'), 0);
    const viewport = { width: 390, height: 780 }, panel = { width: 200, height: 100 };
    same(placePanel({ left: 150, top: 100, bottom: 144, width: 90 }, panel, viewport), { left: 95, top: 152 }, 'centred under its anchor');
    assert.strictEqual(placePanel({ left: 0, top: 100, bottom: 144, width: 50 }, panel, viewport).left, 8, 'kept on screen at the left edge');
    assert.strictEqual(placePanel({ left: 340, top: 100, bottom: 144, width: 50 }, panel, viewport).left, 182, 'kept on screen at the right edge');
    assert.strictEqual(placePanel({ left: 150, top: 700, bottom: 744, width: 90 }, panel, viewport).top, 592, 'flips above when there is no room below');
  });
}
// ---- Kit.body and the generic subsystems it is composed of ----
require('./test-body.js')({ Kit, sandbox, test, assert });
// ---- the look: Kit.palette's tones and atlas (kit/palette.js, loaded by test-body.js above) and kit/look-settings.js ----
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', 'look-settings.js'), 'utf8'), sandbox, { filename: 'look-settings.js' });
{
  const look = Kit.look;
  const palette = Kit.palette;
  const lightnessOf = (rgb) => palette.toOklch(Array.from(rgb)).lightness;
  const isRising = (values, isStrict) => values.every((value, index) => index === 0 || (isStrict ? value > values[index - 1] : value >= values[index - 1]));
  const rowBytes = (atlas, row) => Array.from(atlas.data.subarray(row * atlas.width * 4, (row + 1) * atlas.width * 4)).join();

  test('palette: OKLCH round-trips sRGB bytes and pulls an unshowable colour into gamut without changing its lightness', () => {
    for (const hex of ['#000000', '#ffffff', '#c8453a', '#2f8f9d', '#e9b48c', '#7ff5e1', '#0000ff']) {
      const rgb = palette.rgbOf(hex);
      const back = palette.fromOklch(palette.toOklch(rgb));
      rgb.forEach((channel, index) => assert.ok(Math.abs(channel - back[index]) <= 1, `${hex} channel ${index}: ${channel} -> ${back[index]}`));
    }
    assert.strictEqual(palette.hexOf(palette.rgbOf(0xff8000)), '#ff8000');
    const vivid = palette.fromOklch({ lightness: 0.6, chroma: 0.5, hue: 150 }); // far outside sRGB
    assert.ok(Math.abs(lightnessOf(vivid) - 0.6) < 0.02, `lightness kept: ${lightnessOf(vivid)}`);
    assert.ok(palette.toOklch(vivid).chroma < 0.5, 'chroma was given up');
    assert.throws(() => palette.rgbOf('not a colour'), /not a colour/);
  });

  test('palette.tones: every generated ramp rises in lightness at every tone count, and keeps its base byte-exact', () => {
    for (const paletteSet of Object.values(palette.SETS)) {
      for (const id of paletteSet.rampIds) {
        const isAuthored = typeof paletteSet.ramps[id] === 'object';
        for (let toneCount = 2; toneCount <= 6; toneCount++) {
          const ramp = palette.tones(paletteSet.ramps[id], toneCount);
          assert.strictEqual(ramp.tones.length, toneCount);
          assert.ok(isRising(ramp.tones.map(lightnessOf), !isAuthored), `${paletteSet.name}.${id} at ${toneCount} tones: ${ramp.tones.map((tone) => lightnessOf(tone).toFixed(3))}`);
          assert.ok(lightnessOf(ramp.ink) <= lightnessOf(ramp.tones[0]), `${paletteSet.name}.${id}: ink is no lighter than the darkest tone`);
          if (!isAuthored) assert.strictEqual(palette.hexOf(ramp.tones[Math.max(1, toneCount - 2)]), paletteSet.ramps[id], 'the base sits second from the top');
        }
      }
    }
    // Control: the rising check does fail for a ramp authored the wrong way round.
    assert.strictEqual(isRising(palette.tones({ tones: ['#ffffff', '#000000'] }, 4).tones.map(lightnessOf), false), false);
    assert.throws(() => palette.tones('#c8453a', 7), /toneCount/);
    assert.throws(() => palette.tones({}, 4), /base colour/);
  });

  test('palette.tones: shadows turn toward the cool hue and highlights pale, unlike a plain darkening', () => {
    const { tones } = palette.tones('#c8453a', 5); // a red: hue about 28 degrees
    const [darkest, base, highlight] = [tones[0], tones[3], tones[4]].map((tone) => palette.toOklch(tone));
    const awayFromShadowHue = (hue) => Math.abs(((hue - palette.TONE_SHAPE.shadowHue + 540) % 360) - 180);
    assert.ok(awayFromShadowHue(darkest.hue) < awayFromShadowHue(base.hue) - 10, `shadow hue ${darkest.hue.toFixed(1)} vs base ${base.hue.toFixed(1)}`);
    assert.ok(highlight.chroma < base.chroma, 'the highlight is paler');
    // A grey has no hue of its own, yet its shadow still leans cool: blue above red.
    const greyShadow = palette.tones('#808080', 4).tones[0];
    assert.ok(greyShadow[2] > greyShadow[0], `grey shadow ${greyShadow}`);
    // Authored tones are used as given and resampled by nearest index.
    assert.deepStrictEqual(Array.from(palette.tones({ tones: ['#000000', '#808080', '#ffffff'] }, 5).tones, palette.hexOf), ['#000000', '#808080', '#808080', '#ffffff', '#ffffff']);
  });

  test('palette.atlas: a palette swap rewrites only the rows of its own block', () => {
    const atlas = palette.atlas({ rows: 32, toneCount: 4 });
    const hero = atlas.load(palette.SETS.ember);
    const rival = atlas.load(palette.SETS.tide);
    assert.strictEqual(rival.offset, hero.rampIds.length, 'blocks do not overlap');
    assert.strictEqual(hero.rows.cloth, 2);
    assert.strictEqual(palette.hexOf(atlas.colorAt(hero.rows.cloth, 2)), '#c8453a', 'the base colour is in the second-lightest column');
    const before = Array.from({ length: atlas.height }, (_, row) => rowBytes(atlas, row));
    const versionBefore = atlas.version;
    atlas.write(hero, palette.SETS.moss);
    const changed = before.map((bytes, row) => bytes !== rowBytes(atlas, row));
    // "ground" is the same colour in both palettes, so that one row legitimately stays as it was.
    hero.rampIds.forEach((id) => assert.strictEqual(changed[hero.rows[id]], id !== 'ground', `hero row ${id}`));
    assert.ok(changed.slice(hero.rampIds.length).every((isChanged) => !isChanged), 'no row outside the block changed');
    assert.ok(atlas.version > versionBefore, 'the texture is told to upload');

    const beforeRamp = Array.from({ length: atlas.height }, (_, row) => rowBytes(atlas, row));
    atlas.writeRamp(rival, 'hair', '#ff00ff');
    const changedRows = beforeRamp.map((bytes, row) => bytes !== rowBytes(atlas, row)).flatMap((isChanged, row) => (isChanged ? [row] : []));
    assert.deepStrictEqual(changedRows, [rival.rows.hair], 'writeRamp touches one row');
    assert.strictEqual(palette.SETS.tide.ramps.hair, '#2f3e63', 'the shared named palette was not edited');

    assert.throws(() => atlas.write(hero, palette.set('odd', { skin: '#ffffff' })), /same ramps/);
    assert.throws(() => atlas.writeRamp(hero, 'tail', '#ffffff'), /no ramp "tail"/);
    assert.throws(() => palette.atlas({ rows: 8 }).load(palette.SETS.ember), /no room/);
    assert.throws(() => palette.set('empty', {}), /at least one ramp/);
  });

  test('palette.atlas.retone rebuilds every block at the new tone count and keeps ink in the last column', () => {
    const atlas = palette.atlas({ toneCount: 3 });
    const hero = atlas.load(palette.SETS.ember);
    const inkBefore = atlas.colorAt(hero.rows.skin, palette.INK_COLUMN).join();
    const shadowAtThree = lightnessOf(atlas.colorAt(hero.rows.skin, 0));
    assert.strictEqual(palette.hexOf(atlas.colorAt(hero.rows.skin, 1)), '#e9b48c', 'three tones: base in column 1');
    atlas.retone(6);
    assert.strictEqual(atlas.toneCount, 6);
    assert.ok(lightnessOf(atlas.colorAt(hero.rows.skin, 0)) < shadowAtThree - 0.05, 'more shadow tones reach deeper than one gentle step');
    assert.strictEqual(palette.hexOf(atlas.colorAt(hero.rows.skin, 4)), '#e9b48c', 'six tones: base in column 4');
    assert.ok(lightnessOf(atlas.colorAt(hero.rows.skin, palette.INK_COLUMN)) < lightnessOf(atlas.colorAt(hero.rows.skin, 0)), 'ink is darker than the darkest tone');
    assert.strictEqual(atlas.colorAt(hero.rows.skin, palette.INK_COLUMN).join(), inkBefore, 'the outline colour does not change with the band count');
  });

  test('look.bandOf: a light value on an edge belongs to the lighter band; edgesFor pads with unreachable edges', () => {
    const edges = look.BAND_EDGES[4];
    assert.ok(edges[0] < edges[1] && edges[1] < edges[2], 'the edges under test rise');
    assert.strictEqual(look.bandOf(-1, edges), 0);
    assert.strictEqual(look.bandOf(edges[0] - 1e-9, edges), 0, 'just below the first edge');
    assert.strictEqual(look.bandOf(edges[0], edges), 1, 'exactly on the first edge');
    assert.strictEqual(look.bandOf(edges[2], edges), 3, 'exactly on the last edge');
    assert.strictEqual(look.bandOf(1, edges), 3);
    for (let toneCount = 2; toneCount <= 6; toneCount++) {
      const padded = look.edgesFor(toneCount);
      assert.strictEqual(padded.length, look.MAX_EDGES);
      assert.ok(isRising(Array.from(padded), false), `edges for ${toneCount} tones never fall`);
      // However bright the light (dither can push it past 1), padding never adds a tone.
      assert.strictEqual(look.bandOf(1.5, padded), toneCount - 1, `${toneCount} tones top out at tone ${toneCount - 1}`);
    }
    assert.throws(() => look.edgesFor(7), /no band edges/);
  });

  test('look.bayerAt: sixteen distinct thresholds, periodic, and equal to the closed form the shader uses', () => {
    const fract = (value) => value - Math.floor(value);
    const bayer2 = (column, row) => fract(Math.floor(column) / 2 + Math.floor(row) * Math.floor(row) * 0.75);
    const shaderBayer = (column, row) => bayer2(column / 2, row / 2) * 0.25 + bayer2(column, row);
    const seen = new Set();
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        seen.add(look.bayerAt(column, row));
        near(look.bayerAt(column, row), shaderBayer(column, row), `cell ${column},${row}`);
        assert.strictEqual(look.bayerAt(column + 4, row - 8), look.bayerAt(column, row), 'repeats every 4, also for negative cells');
      }
    }
    assert.strictEqual(seen.size, 16);
    near(Array.from(seen).reduce((sum, value) => sum + value, 0) / 16, 0.46875, 'the mean the shader subtracts');
  });

  test('look grid helpers: texel snapping, yaw steps and whole-number scale', () => {
    near(look.snapToTexel(1.26, 0.5), 1.5, 'nearest texel');
    near(look.snapToTexel(-0.26, 0.5), -0.5, 'negative side');
    near(look.snapToTexel(1.26, 0), 1.26, 'no grid, no snap');
    near(look.stepYaw(0.3, 0), 0.3, 'continuous');
    near(look.stepYaw(0.3, 8), 0, 'below half a step rounds down');
    near(look.stepYaw(0.5, 8), Math.PI / 4, 'above half a step rounds up');
    assert.strictEqual(look.texelScale(780, 195), 4);
    assert.strictEqual(look.texelScale(1560, 195), 8, 'a 2x screen keeps the same texel count');
    assert.strictEqual(look.texelScale(780, 0), 1, 'native');
    assert.strictEqual(look.texelScale(100, 900), 1, 'never below one pixel per texel');
  });

  test('look.weldNormals: coincident vertices share one averaged normal; lone and cancelling ones keep their own', () => {
    // Three copies of a cube corner (one per face), one vertex elsewhere, and a back-to-back pair.
    const positions = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 5, 5, 5, 5, 5, 5];
    const normals = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, -1];
    const welded = Array.from(look.weldNormals(positions, normals));
    const third = 1 / Math.sqrt(3);
    for (let index = 0; index < 9; index++) assert.ok(Math.abs(welded[index] - third) < 1e-6, `corner component ${index}: ${welded[index]}`);
    assert.deepStrictEqual(welded.slice(9, 12), [0, 1, 0], 'a lone vertex is unchanged');
    assert.deepStrictEqual(welded.slice(12), [0, 0, 1, 0, 0, -1], 'opposite normals do not collapse to zero');
  });

  test('look.settings: presets resolve, overrides apply, and the indexed path is chosen only when needed', () => {
    assert.strictEqual(look.settings('toon').isIndexed, false);
    assert.strictEqual(look.settings('soft').isIndexed, false);
    assert.strictEqual(look.settings('pixel').isIndexed, true);
    assert.strictEqual(look.settings('toon', { outline: 'ink' }).isIndexed, true, 'screen-space ink needs the index target');
    assert.strictEqual(look.settings('pixel', { outline: 'hull' }).isIndexed, true, 'low resolution needs it too');
    assert.strictEqual(look.settings('pixel', { outline: 'hull', pixelRows: 0 }).isIndexed, false);
    assert.strictEqual(look.settings('toon', { toneCount: 5 }).toneCount, 5);
    assert.strictEqual(look.settings('toon').label, undefined, 'editor text is not a setting');
    assert.throws(() => look.settings('sepia'), /no preset "sepia"/);
    assert.throws(() => look.settings('toon', { toneCount: 9 }), /toneCount/);
    // Every knob edits a field every preset defines, and a choice knob offers each preset's value.
    for (const knob of look.KNOBS) {
      for (const [id, preset] of Object.entries(look.PRESETS)) {
        assert.ok(knob.id in preset, `preset ${id} lacks ${knob.id}`);
        if (knob.type === 'choice') assert.ok(knob.options.some((option) => option.value === preset[knob.id]), `${knob.id} cannot show ${id}'s value ${preset[knob.id]}`);
        if (knob.type === 'range') assert.ok(preset[knob.id] >= knob.min && preset[knob.id] <= knob.max, `${knob.id} range excludes ${id}'s value`);
      }
    }
  });
  test('palette.atlas takes what a body bake holds: its ramps by index, a row per bone through boneRamp', () => {
    const bake = Kit.body.catalog(Kit.body.samples.CATALOG).bakery().bakeRecipe({ species: 'human', seed: 1, overrides: { 'fill:handRight': 'sword' } });
    const atlas = palette.atlas({ toneCount: 5 });
    atlas.load(palette.SETS.ember);
    const worn = atlas.load(bake.ramps);
    const blade = bake.boneRamp[bake.plan.boneIndex('handRight/blade')];
    assert.strictEqual(worn.rows[blade], worn.offset + blade, 'a ramp index is a row offset inside the block');
    // The five shades the body system authored are the five tone columns, byte for byte.
    assert.deepStrictEqual(Array.from({ length: 5 }, (_unused, column) => palette.hexOf(atlas.colorAt(worn.rows[blade], column))), Array.from(bake.ramps[blade].shades));
    assert.strictEqual(palette.hexOf(palette.tones(Kit.palette.ramp('moss', 0.3), 5).tones[2]), Kit.palette.ramp('moss', 0.3).shades[2], 'tones() reads a Ramp as authored tones');
    assert.strictEqual(Kit.palette.shade(Kit.palette.ramp('moss', 0.3), 0), Kit.palette.ramp('moss', 0.3).shades[0], 'the existing shade() still works');
  });
}
// ---- Kit.figure: shapes, layout, update planning, grounding and framing (pure half) ----
require('./test-figure.js')({ Kit, sandbox, test, assert });
require('./test-gait.js')({ Kit, sandbox, test, assert });
// ---- the character creator's pure pieces (rows, session, slots, camera) over the wardrobe catalogue ----
require('./test-creator.js')({ Kit, sandbox, test, assert });
pending.then(() => console.log(`${n} tests passed`)).catch((e) => { console.error(e); process.exit(1); });
