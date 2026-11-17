/**
 * Dev tools frame budgets: the one table of what a game may cost per frame, and the check against it.
 *
 * Owns:  the budget table and `checkBudgets` (pure); tighter budgets for single screens (`SCREEN_BUDGETS`); what one
 *        sculpted figure may cost at each level of detail (`SCULPT_BUDGETS`, `checkSculptBudgets`).
 * Does not own: measuring (Kit.debug.probe in kit/dev.js, printed by tools/smoke.js as a PROBE line) or
 *        failing the build (check.js).
 *
 * What is and is not checked: draw calls, triangles and live meshes are properties of the scene and are the
 * same on every machine, so they are budgeted. Frame time is reported but NOT budgeted: the headless tests
 * render with software GL on a shared machine, where 30-100 ms a frame says nothing about a phone.
 */
'use strict';

/**
 * Per-frame budgets for a phone. `meshes` keeps live meshes under about 200; the other two are
 * the usual mobile WebGL ceilings for a steady 60 fps with one shadow-casting light (the shadow pass draws
 * shadow casters a second time, so a scene of 150 meshes is already about 300 calls).
 */
const BUDGETS = {
  calls: { limit: 300, unit: 'draw calls', fix: 'merge static meshes, or draw repeats with make.instanced / make.batch' },
  triangles: { limit: 300000, unit: 'triangles', fix: 'lower segment counts, or use flat or instanced geometry for crowds' },
  meshes: { limit: 200, unit: 'live meshes', fix: 'pool what spawns repeatedly (ctx.pool) and hide or remove what left the screen' },
};

/**
 * Tighter limits for screens whose whole frame is known, by smoke id. `creator` is one character close up: the
 * sculpted surface, its outline hull and the face (3 calls, about 40 k triangles drawn with the hull; it was 19
 * and 148 k before the layers were one culled, simplified mesh), with room for a prop that needs its own material.
 * @type {Object<string, Object<string, number>>}
 */
const SCREEN_BUDGETS = {
  creator: { calls: 8, triangles: 60000 },
};

/**
 * Compares one game's frame probe with the budgets.
 * @param {{calls: number, triangles: number, meshes: number}} probe from Kit.debug.probe()
 * @param {string} [id] the smoked screen: its own limits in `SCREEN_BUDGETS`, where it has them, replace the general ones
 * @returns {string[]} one message per breached budget (empty when within budget), each with the fix
 * @example checkBudgets({ calls: 420, triangles: 1000, meshes: 80 }) // ['420 draw calls (budget 300): merge static meshes, ...']
 */
const checkBudgets = (probe, id) => {
  const own = SCREEN_BUDGETS[id] || {};
  const limitOf = (key) => (own[key] === undefined ? BUDGETS[key].limit : own[key]);
  return Object.keys(BUDGETS)
    .filter((key) => probe[key] > limitOf(key))
    .map((key) => `${probe[key]} ${BUDGETS[key].unit} (budget ${limitOf(key)}): ${BUDGETS[key].fix}`);
};

/**
 * What one dressed, sculpted figure may cost at each level of detail (kit/sculpt.js `DETAIL`), whatever it
 * wears: triangles and skinned meshes are what a phone draws (the outline hull draws the triangles a second
 * time), bytes are what its arrays keep in memory. All three are properties of the mesh, the same on every
 * machine, so tools/test-sculpt.js holds the wardrobe person to them in `check`. Sculpting time is reported by
 * `make bench` and not budgeted here, for the reason frame time is not.
 * @type {Object<string, {triangles: number, meshes: number, bytes: number}>}
 */
const SCULPT_BUDGETS = {
  high: { triangles: 25000, meshes: 1, bytes: 1100e3 },
  medium: { triangles: 8000, meshes: 1, bytes: 450e3 },
  low: { triangles: 2500, meshes: 1, bytes: 160e3 },
  far: { triangles: 1000, meshes: 1, bytes: 60e3 },
};
const SCULPT_UNITS = { triangles: 'triangles', meshes: 'skinned meshes', bytes: 'bytes of arrays' };

/**
 * Compares one sculpted figure with the budget of its level.
 * @param {string} level a key of `SCULPT_BUDGETS`
 * @param {{triangles: number, meshes: number, bytes: number}} cost of the figure's sculpted surface
 * @returns {string[]} one message per breached budget, empty when within budget
 * @example checkSculptBudgets('low', { triangles: 9710, meshes: 8, bytes: 337570 }) // three messages: the figure before it was one simplified surface
 */
const checkSculptBudgets = (level, cost) =>
  Object.keys(SCULPT_BUDGETS[level])
    .filter((key) => cost[key] > SCULPT_BUDGETS[level][key])
    .map((key) => `${level}: ${cost[key]} ${SCULPT_UNITS[key]} (budget ${SCULPT_BUDGETS[level][key]}): see kit/sculpt.js DETAIL and kit/figure-sculpt.js`);

module.exports = { BUDGETS, SCREEN_BUDGETS, SCULPT_BUDGETS, checkBudgets, checkSculptBudgets };
