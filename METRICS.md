# Metrics

The project's thesis: tooling and platform co-evolve at every layer, and the proof is that three numbers improve
over time for work of the same standard: **cost** (tokens), **time** (wall clock) and **quality** (defects and
rework). This file is the ledger. Add a row when a piece of work finishes; never edit history.

How to read it: compare like with like. A later row is only evidence of improvement if it met the same bar
(code standard, theme, depth) as the row it is compared with. Wall-clock time is inflated whenever many agents
share the machine; the load column says so.

## Ledger

| # | Work | Kind | Model | Tokens | Minutes | Load | Bar met | Rework rounds after | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Swarm Arena | first draft | sonnet | 120k | 4.5 | 5 agents | none | 2 | smoke only |
| 2 | Neon Run | first draft | sonnet | 127k | 6.7 | 5 agents | none | 2 | |
| 3 | Core Miner | first draft | sonnet | 122k | 7.5 | 5 agents | none | 2 | |
| 4 | Tower Smash | first draft | sonnet | 131k | 7.7 | 5 agents | none | 2 | |
| 5 | Sky Stack | first draft | sonnet | 162k | 17.7 | 5 agents | none | 2 | harness race cost about 3 failed runs |
| 6 | Neon Run | rework | fable | 219k | 32 | 8 agents | kit models | 1 | two mid-task amendments |
| 7 | Swarm Arena | rework | fable | 215k | 35 | 8 agents | kit models | 1 | two mid-task amendments |
| 8 | Core Miner | rework | fable | 260k | 36 | 8 agents | kit models | 1 | |
| 9 | Prism Garden | new game | fable | 267k | 21 | 12 agents | standard, theme | 1 (depth) | 3 kit modules contributed |
| 10 | Marble Works | new game | fable | 281k | 31 | 12 agents | standard, theme | 1 (depth) | 3 kit modules contributed |
| 11 | Swarm Arena | standard + theme | fable | 224k | 19 | 12 agents | standard, theme | 1 (depth) | 9 kit additions |
| 12 | Core Miner | standard + theme | fable | 272k | 27 | 12 agents | standard, theme | 1 (depth) | 10 kit additions |
| 13 | Tower Smash | pick-up + standard + theme | fable | 256k | 36 | 12 agents | standard, theme | 1 (depth) | one unexplained page error |
| 14 | Sky Stack | pick-up + standard + theme + depth | fable | 407k | 76 | 12 agents | standard, theme, depth | 0 so far (4 amendments arrived mid-task and were absorbed) | 2 new pure kit files, 3 kit functions, rules split for a headless pacing sim; one unexplained one-off page error |
| 15 | Kit refactor (14 files: core, model, flow, space, loot, net, input, fx, sfx, make, ui, post, physics, shell) | refactor to standard + hot-path pass | fable (no leaves: this agent had no Agent tool) | not reported to the agent | about 65 | 10 to 14 agents | standard, complexity notes on pure modules | 0 so far | 28 edge-case tests; kit/README.md; pixel.js not reached; 4 mid-task amendments |
| 16 | Lampwick Table (virtual tabletop) + hosted transport | new tool + platform adapter | fable (no leaves: this agent had no Agent tool) | 547k | 74 | 10 to 14 agents | standard, theme, capability depth, complexity notes, decisions | 0 so far (8 amendments arrived mid-task and were absorbed; the depth one reshaped the key scheme) | 5 new kit files (dice, sight, net-trust, net-claude, tabletop), 30 tests incl. a fake platform; 11 browser runs; hosted path verified only against the fake |
| 17 | Neon Run | standard + theme + depth | fable | 418k | 66 | 12+ agents | standard, theme, depth (simulated) | 0 so far | 4 mid-task amendments; 2 kit files and 4 kit options added; depth arc runs out in under an hour for a strong player |
| 18 | Plumwick Pond (cozy) | pick-up + standard + theme + depth | fable | not measured | about 85 | 10 to 14 agents, load 25 to 45 | standard, theme, depth (simulated) | 0 so far | 6 requirement changes arrived mid-task; kit/touch.js contributed; pacing and fairness proven by headless simulation, not by a person |
| 19 | Core Miner | depth (rules module, sim, forge, forks, prestige tree, relics) | fable | not visible to the agent | about 50 | 12+ agents | standard, theme, depth | 0 so far | 1 kit addition (wallet.spendAll); pacing proved by scratch/miner/sim.js; 53 lint findings left in scene layout |
| 20 | Dev tooling: tools/dev.js (scaffold, check, play, sheet, lint, docs, types, sim, bench, metrics), kit/dev.js guard rails and overlay | tooling | fable (lead only: no agent tool in this session, so nothing was dispatched) | ? | ? | 10-12 agents, up to 9 browsers | standard, tests, decisions | 0 | effort high; seven mid-task amendments; 14 tool tests + 3 kit tests; 5 browser runs; 185 tests passed |
| 21 | Soulwake (zombie roguelike) | new game, pick-up of a cancelled agent | fable | 451k | 82 | 10+ agents | standard, theme, depth (simulated) | 0 so far; 6 binding amendments arrived mid-task (theme, AGENTS.md, depth, north star, orchestration, web-native UX) | lead only: no Agent tool in this session, so nothing was dispatched to lower tiers; kit: crowd.js, craft.js, views.js; pacing proven by scratch/souls/career.js |
| 22 | Ferry Lines (new game) + kit/route.js, kit/timer.js | pick-up from a cancelled agent: new game + standard + theme + depth | fable (no leaves: this agent had no Agent tool, so amendment 17 could not be followed) | not measured (the agent cannot read its own usage) | not measured; long, one sitting | 10+ agents | standard (22 lint magic-number notes left in the 3D model dimensions), theme, depth (simulated: 3 h x 3 seeds x 4 bots) | 1 inside the task: the first build was a one-minute slice, rebuilt when depth arrived | 9 amendments arrived mid-task; 8 browser runs, 1 foreign page error (prism); the pacing simulation overturned the first tables twice |
| 23 | Prism Garden | depth (shelf, 3 new rules, forge, daily, garden) + theme + file split | fable | not measured (the agent cannot read its own usage) | about 150 | 12+ agents, load average 35 | standard, theme, depth | 0 so far (amendments 14 to 19 arrived mid-task and were absorbed) | 14 proven beds, endless forged beds; kit/puzzle.js grew search.generate, search.difficulty, beam passes and one-way glass, level medals; `make sim GAME=prism` works |

## Orchestrated work (from amendment 17)

One row per piece a lead dispatched or kept. This is what tests whether tiered, low-effort leaves cut cost.

| Lead (game or area) | Piece | Tier | Effort | Tokens | Passed review first time? | Notes |
|---|---|---|---|---|---|---|
| Sky Stack | all pieces (rules split, depth tables, pacing simulation, theme, views, QA) | fable | medium | not measured | n/a | no Agent tool in this session, so nothing could be dispatched; the pieces that would have gone to leaves: achievement / blueprint tables with stated targets (sonnet/low), the bot simulation script (sonnet/medium), JSDoc pass (haiku/low) |
| Prism Garden | all pieces (rule design, model, forge, 6 new beds and 8 reworked, view, theme, pacing sim, QA) | fable | medium | not measured | n/a | no Agent tool in this session, so nothing could be dispatched; pieces that would have gone to leaves: hand-designing beds against solve.js (sonnet/low to medium), the playtest script (sonnet/low), JSDoc and bed text (haiku/low), the rating heuristic (opus/medium) |
| Neon Run | whole pass (refactor, theme, kit additions, depth rules, pacing simulation, QA) | fable | medium | not measured | n/a | kept by the lead: this session has no Agent tool, so nothing could be dispatched |
| cozy | Whole pick-up (recon, kit/touch.js, pixel clean-up, split into five files, theme, depth rules, pacing sim, QA) | fable | high | not measured | n/a | Kept by the lead: this session had no Agent tool, so nothing could be dispatched. Pieces that were well-specified enough for a cheaper tier: the species / project / achievement tables, the theme CSS from the written design, the pacing script, docstrings |
| Core Miner | Economy structure, rules module, model wiring (games/miner-rules.js) | fable | medium | not metered | n/a | no Agent tool in this session: done by the lead; the structure stays with the lead, the tables inside it would not |
| Core Miner | Content tables to stated targets and tags (shafts, gear, sets, tree, relics, achievements) | would be sonnet | low | not metered | n/a | done by the lead; separable once the stat names exist |
| Core Miner | Headless many-hour simulation with bots (scratch/miner/sim.js) | would be sonnet | medium | not metered | n/a | done by the lead; needs only the model's interface |
| Core Miner | Curve tuning from simulation output (3 rounds) | would be opus | medium | not metered | n/a | done by the lead; each round is one table edit and one 60 s run |
| Core Miner | Rules tests in tools/test-kit.js | would be sonnet | low | not metered | n/a | done by the lead |
| Core Miner | Tap feel, weak point, heat gauge, forks, Camp sheet, theme, QA | fable | medium | not metered | n/a | kept by the lead by rule (feel, layout, QA) |

## What the ledger says so far

- Cost and time per game rose as the bar rose. There is no like-for-like pair yet, so the thesis is untested.
- The largest avoidable cost was rework: every game has been revisited at least once because a requirement
  (kit models, code standard, theme, depth) arrived after it was built. Requirements known up front are the
  cheapest optimisation available.
- The second was the shared machine: the same smoke run took 15 seconds idle and several minutes under load.

## The test that would settle it

Build one new game from `make new-game` with the whole bar known from the start, alone on the machine, and
compare its tokens and minutes with rows 9 and 10. Then build a second. If the kit and tooling are doing their
job, both should be clearly cheaper and need no rework round.

## Friction log

Each agent's report ends with what slowed it down and what tool or kit piece would have saved the time. Recurring
entries become the next tooling work.

| Friction | Reported by | Status |
|---|---|---|
| Hand-written browser playtest scripts | every game agent | closed: `node tools/dev.js play <id> --script ...` (step language, debugState predicates, shots, fail.png) |
| Smoke harness races a modal or a slow click | stack, runner, miner, arena | fixed twice in tools/smoke.js |
| Live tree broken at random instants by other agents | arena, marble, sling, prism | `make release` publishes from a frozen copy |
| Script tags edited by hand, sometimes duplicated | prism, marble | closed: `new game` / `new module` insert the tag once; `check` and `tags [--fix]` validate; a duplicate id now throws in Kit.register |
| No map of the kit | prism, marble, sling | kit steward: kit/README.md |
| Headless browser at 4 fps: a one-minute scripted playtest took 5 to 6 minutes of wall clock | souls | open: a `play` runner that fast-forwards a game's pure simulation between screenshots (souls does it by hand through `run.update`) |
| No shared headless simulator for pacing: each game writes its own bot loop and report | souls | open: lift the career loop of scratch/souls/career.js into tools/ (policies in, curve and build table out) |
| tools/test-kit.js is one shared file: other agents' failing tests hid whether mine passed, and a global rewrite changed my assertions | souls | open: one test file per kit module, run by a collector |
| Kit.loot cannot force a base or add an affix after the roll | souls | added Kit.loot.augment; forcing a base is still open |
| Scripted browser playtest takes 8 to 11 minutes for 45 floors under load (about 12 s per floor), and it had to be run three times | stack | open: a `play` runner with a fixed-step, render-free mode would cut it to seconds; the pure rules now run headless in `scratch/stack/sim.js` |
| Four binding amendments (theme, AGENTS.md, depth, orchestration) arrived mid-task; the game file was rebuilt twice | stack | requirements up front; nothing a tool fixes |
| `make lint` fails: tools/dev.js does not exist yet | stack | open (tooling agent) |
| `assert.deepStrictEqual` fails across the vm realm in tools/test-kit.js (arrays made inside the sandbox) | stack | worked around with a string compare; a `same(a, b)` helper in the test file would save the next person |
| One smoke run printed `Cannot read properties of undefined (reading 'scale')` once and never again (kit files were being edited at that minute) | stack | `make release` frozen copy is the fix; smoke could print the stack trace |
| Kit files changed under the steward between read and write (about 12 times) | kit steward | worked around with scratch/steward/install.sh (snapshot, compare, atomic replace) and merge-tail.py; worth promoting to tools/ for anyone rewriting a shared file |
| tools/test-kit.js went red about 6 times from other agents' half-written tests, each costing a re-run to tell it apart from a real failure | kit steward | open: one test file per module, or `bun test` with a filter |
| Benchmarks under load 20 to 40 are noise; one false lead (Math.hypot) cost about 5 minutes | kit steward | open: `make bench` should refuse or warn above a load threshold and report ratios only |
| Shared test file mid-edit by others: a full `test-kit.js` run failed on someone else's block for a while | table | worked around with a private runner for one block; a test file per module (or `bun test` with filtering) would remove it |
| No way to exercise platform capabilities locally | table | wrote `tools/fake-claude.js` (room, db rules, user); worth promoting to a shared fixture and a `?fake-platform` dev page with two panes |
| Requirements arriving after the data model was built (scenes, depth) | table | key scheme rewritten once; a tool brief should state "session-capable" scope up front |
| Playtest helper needed game internals (cell to screen position) | table | a `Kit.dev.project(worldPoint)` helper in the play runner |
| A browser playtest takes 5 to 10 minutes at 3 fps and outlives the 2 minute command limit | runner | open: a headless `rules` simulation (scratch/runner/pacing.js) answered most questions in seconds; a shared `tools/` simulator would make that the default |
| Menu cards scrolled off-screen, so `page.click('#card-<id>')` timed out | runner | worked round with `Kit.play(id)`; tools/smoke.js still clicks the card |
| Requirements arriving mid-task (theme, depth, orchestration, UX) each forced a re-plan of a 2,000-line game | cozy | open: a single up-front bar per game |
| Headless game time runs 5 to 10 times slower than real time under load, so a full scripted playtest took 6 to 8 minutes per part | cozy | partly: scratch/cozy/play.js runs in parts; a kit-level `ctx.debug` clock speed-up for tests would remove it |
| No way to judge thumb difficulty without a person | cozy | fixed for tracing: pure Kit.touch.trace lets scratch/cozy/fairness.js play fights with a simulated thumb |
| Pixelify Sans ligatures turned "fish" into "Ash" in every pixel-skin HUD | cozy | fixed in kit/theme.js (pixel skin css) |
| A save can only be seeded through `Kit.store(id).set` after load (localStorage is read once); found by a wasted browser run | miner | open: a `seed` step in the play runner (`node tools/dev.js play miner --save file.json`) |
| No shared many-hour simulator: bots, clock and report were written again (about 250 lines, as ferry and runner also did) | miner | open: `make sim`; scratch/miner/sim.js splits cleanly into engine (clock, firsts, hourly table) and per-game policies |
| Fixed real-time waits in a walkthrough failed twice because game time ran at a fifth of real time | miner | worked around with waitForSelector / waitForFunction; the play runner's `until` step is the fix |
| Six binding amendments arrived mid-task; the game file was restructured twice (standard + theme, then depth) | miner | requirements up front |
| tools/test-kit.js red from another agent's random-order test once, and cross-realm deepStrictEqual once more | miner | open: a `same` helper at the top of the test file; a test file per module |
| A private pacing simulator per game, each a different shape | arena, souls, sling, miner, ferry | closed for new work: `headless.progression` + `make sim GAME=<id>`; existing games still need to expose it |
| Smoke's game list hard-coded; a new game silently untested | tooling | closed: `smoke.js all` reads Kit.games |
| Silent misuse of the kit (fourth stat, raw colour, wrong argument, unknown skin) | several | closed in development: Kit.register errors and kit/dev.js warnings, printed by smoke, play and check |
| No API reference; docstrings drift from code | prism, marble, sling | partly closed: generated kit/API.md; `types` ratchet stops new drift, 300 old errors remain |
| Whole-file rewrites of shared files race with other agents' appends | steward | tool exists: `snapshot` / `replace` (promoted from scratch/steward); `new module` itself still rewrites tools/test-kit.js in one step |
| Touch taps lost in headless runs under load (frame-aligned delivery, 1.2 s between down and up) | tooling | open: proposal to time taps from event.timeStamp in kit/input.js |
| Micro-benchmark noise of +/-100% on the shared machine | tooling | open: needs a quiet machine or a dedicated core |
| The file-edit guard refuses to overwrite a file changed by a script since it was last read, after the whole new file had been sent (about 700 lines re-sent once) | ferry | habit: write a new file beside it and move it; a `tools/dev.js replace-file` would make that one step |
| Appending tests to the shared tools/test-kit.js: a block inserted "before the last line" was no longer last an hour later, a scripted replace of it failed half-way and the suite was red for about a minute | ferry | open: one test file per kit module or game (`tests/<name>.test.js`) that the runner globs, so nobody edits a shared file |
| Whole-stroke smoothing in the first Kit.route.capture pulled routes off docks drawn through at a corner; found only when the hub bot failed 768 strokes | ferry | fixed in kit/route.js (pin and clean per section) with a control test; lesson: a bot that uses the same capture call as the player is the cheapest test of input geometry |
| Pacing asserted from tables was wrong twice (everything unlocked in 10 minutes; every bot dead at 2 minutes whatever it did) | ferry | scratch/ferry/pacing.js (25 s for 3 h of play); a shared `tools/simulate.js` taking { createWorld, step, policies, record } would save the next game about 170 lines |
| No Agent tool in this session, so the lead could not dispatch leaves (amendment 17) | ferry | open: the dispatcher has to start game leads with that tool |
| Timing anything on the shared machine (load average 35): the same solver benchmark read 600 to 1600 us per state from run to run, so no before/after timing could be trusted | prism | open: `make bench` should report work units (states, calls) next to milliseconds |
| `Kit.grid.find` and grid construction allocate an object per cell; they were the top of the solver's profile | prism | worked around in games/prism-model.js (facts cached per bed, loose-piece state); a non-allocating `grid.find` would fix it for everyone |
| Values built in the test sandbox fail `assert.deepStrictEqual` (another realm's prototypes) | prism | worked around with a JSON compare in the puzzle tests; test-kit could export one `same()` helper |
| Reaching late-game states in a playtest meant hand-building a save object | prism | open: `make play` could take a save seed |