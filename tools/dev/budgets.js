/**
 * Dev tools frame budgets: the one table of what a game may cost per frame, and the check against it.
 *
 * Owns:  the budget table and `checkBudgets` (pure).
 * Does not own: measuring (Kit.debug.probe in kit/dev.js, printed by tools/smoke.js as a PROBE line) or
 *        failing the build (check.js).
 *
 * What is and is not checked: draw calls, triangles and live meshes are properties of the scene and are the
 * same on every machine, so they are budgeted. Frame time is reported but NOT budgeted: the headless tests
 * render with software GL on a shared machine, where 30-100 ms a frame says nothing about a phone.
 */
'use strict';

/**
 * Per-frame budgets for a phone. `meshes` is the brief's "keep live meshes under ~200"; the other two are
 * the usual mobile WebGL ceilings for a steady 60 fps with one shadow-casting light (the shadow pass draws
 * shadow casters a second time, so a scene of 150 meshes is already about 300 calls).
 */
const BUDGETS = {
  calls: { limit: 300, unit: 'draw calls', fix: 'merge static meshes, or draw repeats with make.instanced / make.batch' },
  triangles: { limit: 300000, unit: 'triangles', fix: 'lower segment counts, or use flat or instanced geometry for crowds' },
  meshes: { limit: 200, unit: 'live meshes', fix: 'pool what spawns repeatedly (ctx.pool) and hide or remove what left the screen' },
};

/**
 * Compares one game's frame probe with the budgets.
 * @param {{calls: number, triangles: number, meshes: number}} probe from Kit.debug.probe()
 * @returns {string[]} one message per breached budget (empty when within budget), each with the fix
 * @example checkBudgets({ calls: 420, triangles: 1000, meshes: 80 }) // ['420 draw calls (budget 300): merge static meshes, ...']
 */
const checkBudgets = (probe) =>
  Object.keys(BUDGETS)
    .filter((key) => probe[key] > BUDGETS[key].limit)
    .map((key) => `${probe[key]} ${BUDGETS[key].unit} (budget ${BUDGETS[key].limit}): ${BUDGETS[key].fix}`);

module.exports = { BUDGETS, checkBudgets };
