# Decisions

Short records of choices that had real alternatives. One entry per decision: the options, what each costs and buys
(including time and space complexity where it matters), what we chose and what would make us revisit it.
Add an entry whenever you pick a library, data structure, algorithm or architecture over another. Five to ten lines is enough.

## Tool runtime: Bun

- **Options.** Node 22 (already installed; slowest start; no built-in bundler). Bun 1.4 (installed; starts faster; runs
  our Node scripts and Playwright unchanged; built-in test runner, bundler and TypeScript). Deno (not installed; would
  need import rewrites for Playwright).
- **Chosen.** Bun, with Node as an automatic fallback in the Makefile so nothing depends on Bun-only APIs yet.
- **Evidence.** `bun tools/test-kit.js` and `bun tools/smoke.js menu` both pass. Speed has not been measured fairly:
  the only timing was taken while a dozen agents shared four cores.
- **Revisit if.** A Playwright or cannon.js behaviour differs under Bun, or a fair benchmark shows no gain.

## Task entry point: Make

- **Options.** Makefile (on every machine, declarative targets, `make help`). package.json scripts (needs a package
  manager call per job, no dependency graph). A task runner such as just (cleaner syntax, but one more install).
- **Chosen.** A thin Makefile whose targets call small scripts in `tools/`; logic lives in the scripts, not in Make.
- **Revisit if.** Targets start needing real dependency tracking or Windows support.

## Publishing: from a frozen, verified copy

- **Options.** Publish the live tree (simple; but agents edit it constantly, so it is broken at random instants).
  Lock the tree while publishing (stalls a dozen agents). Snapshot, verify the snapshot, publish that (a copy costs
  O(total file size), a few megabytes).
- **Chosen.** Snapshot (`make release`): a game that fails in the copy is left out instead of blocking the rest.

## Multiplayer transport: an interface, with the hosted room and database behind it

- **Options.** WebRTC peer-to-peer (lowest latency; blocked on the hosted page; still needs signalling and relay
  servers). WebSocket server (needs hosting; blocked on the hosted page). The platform's live room plus shared
  database (available now; 4 KiB messages, about 40 a second, may drop).
- **Chosen.** `Kit.net.session(transport)`: per-key last-writer-wins state, O(1) per write and O(keys) memory, with
  the platform transport first and loopback for tests. WebRTC can be added as another transport without touching games.

## Crowd pathing and neighbour queries: one flow field and a spatial hash (`kit/crowd.js`)

- **Pathing options.** A search per walker (`grid.path`, breadth-first: O(cells) each, so O(n x cells) whenever the
  target moves; simple, exact per walker). A* per walker (same worst case, more code). One flow field from the
  target (`Kit.crowd.flow`: O(cells) time and space per target cell change, then O(1) per walker per frame; every
  walker shares it, but all walkers must want the same goal set).
- **Chosen.** The flow field: Soulwake's zombies all want the hero, and it is rebuilt only when the hero changes cell
  (529 cells, a few times a second). Walkers that ignore walls (the wraith) skip it.
- **Neighbour options.** All pairs (O(n squared), no memory, fine under about 30). A uniform spatial hash
  (`Kit.crowd.buckets`: O(n) fill and O(n) expected for a pass of neighbourhood queries, O(n) memory, degrades to
  O(n squared) if everything shares a bucket). A quadtree (handles uneven crowds, more code and pointer chasing).
- **Chosen.** The hash, refilled once per frame, with the bucket twice the largest body radius so touching bodies
  are at most one bucket apart. Not measured against all-pairs: at Soulwake's cap of about 22 zombies both are far
  under a millisecond, so this is cost by construction, not a measured win.
- **Revisit if.** Walkers need different goals (then one field per goal set), or crowds become dense enough to pile
  into one bucket.

## Soulwake's rules live in a pure simulation shared by the game and its pacing bots

- **Options.** Rules inside the game's closure (least code; only testable through a browser at a few frames per
  second). A pure simulation and a pure meta layer the page and node both load (`games/souls-sim.js`,
  `games/souls-meta.js`; costs an events list between simulation and presentation).
- **Chosen.** The pure split. A 30-run career per bot policy runs headless in seconds to minutes, so pacing and build
  variety are measured on the real rules instead of asserted (`scratch/souls/career.js`).
- **Revisit if.** A shared simulator lands in `tools/`; the bot loop in the scratch script should move onto it.

## Sky Stack: rules in a node-loadable file, tower as a ring buffer, slab kinds on a rhythm

- **Rules.** Options: keep them in the game's closure (one file; only testable through a browser at 5 to 15 fps), or
  split tables and pure rules into `games/stack-rules.js` that the page and node both load. Chosen: the split. The game
  and `scratch/stack/sim.js` call the same `settleDrop`, so five simulated hours for three bots run in under a second
  and the pacing numbers describe the real rules. Cost: one more script tag and a destructuring block.
- **Tower storage.** Options: a mesh per floor (O(floors) draw calls and memory, unbounded), merging old floors into
  one geometry (O(floors) rebuild on every bake), or a fixed `InstancedMesh` used as a ring buffer. Chosen: the ring:
  O(1) per landed floor, O(ring size) memory, one draw call; the pedestal rises under the lowest floor still shown.
  Revisit if a mode ever needs to show more than 160 floors at once.
- **Slab kinds.** Options: a weighted random roll (`Kit.spawnTable`), or a fixed rhythm per kind ("every 6th floor").
  Chosen: the rhythm. It is learnable, lets blueprints change it with one modifier (`glassEvery`, `broadEvery`), and
  keeps scripted playtests and simulations repeatable. Revisit if the rhythm feels mechanical in play.
- **Milestones.** `Kit.goals` was replaced by a pure lookup (`milestoneAt`): a milestone is a fact about a floor
  index, not progress that needs tracking, and the simulation needs it without a stateful model.

## Neon Run: banking the combo is a place on the road, not a button

- **Options.** Tap to bank (one input, always available; but tap is already "jump" for a first-time player, and a
  bank that is always available is never a hard choice). Bank automatically at every gate (no input; no decision at
  all). A bank pad in one lane under each gate (the choice is spatial and arrives on a rhythm; it interacts with the
  patterns, since the pad lane may be the awkward one; an accidental bank is possible).
- **Chosen.** The pad. O(1) per frame (only the nearest pad is checked); lane picked at spawn in O(obstacles) so it
  never sits behind a block.
- **Revisit if.** Players bank by accident often enough to resent it (then make the pad narrower or require a slide).

## Neon Run: pure rules exposed on the registration, not scraped from the source

- **Options.** Append an export line to the game source inside the test (no change to the game; breaks on any edit to
  the file's last line). A `rules` field on the `Kit.register` definition (one line in the game; any headless tool
  reads `Kit.games.find(...).rules`). A separate rules file per game (cleanest boundary; one more script tag).
- **Chosen.** The `rules` field: `scratch/runner/pacing.js` loads the pure kit files plus the game in a vm and drives
  exactly the functions the game runs. Revisit if a shared simulator in `tools/` wants a fixed interface.

## Kit hot paths: where the steward changed the shape of an algorithm

Numbers are from `node scratch/steward/bench.js` (before = the refactored kit just before this pass) on the shared
machine at load 20 to 40, so only the ratios mean anything.

- **`Kit.stats.get`.** Options: walk every modifier source on each read (O(sources) per read, nothing to keep in
  step); cache the final value per stat (O(1), but a game that writes `stats.base.x` directly would read a stale
  value); cache only the summed adds and multiplied muls per stat, dropped on `mod()` / `clear()` (O(1) amortised,
  O(stats) memory, `base` writes still show). Chosen: the last. 1e6 reads with 12 sources: 255 ms -> 54 ms.
  Cost: a spec object edited in place after `mod()` is no longer picked up; call `mod()` again. Revisit if a game
  needs that.
- **`Kit.net` outbox.** Options: array with `findIndex` + `splice` to coalesce and `shift` to drain (O(queued) per
  write and per send); a `Map` keyed by state key, which is also an insertion-ordered queue (O(1) for both).
  Chosen: the Map. 20000 throttled writes over 2000 keys: 205 ms -> 139 ms. Same order on the wire (tested).
- **`Kit.line` lookups.** Options: `line.at` re-measures the line each call (O(n)); cache the length in a WeakMap
  keyed by the points array (invisible, but silently wrong when a drawn line is still growing or its points move);
  an explicit `Kit.line.measured(points)` with running lengths and a binary search (O(n) once, O(log n) per lookup,
  and the caller decides when to re-measure). Chosen: explicit. `resample` uses it: 2000 points, 5143 ms -> 62 ms.
  `line.at` itself is unchanged in cost.
- **`Kit.grid.path` / `flood`.** The search no longer builds neighbour lists (three arrays and up to eight objects
  per cell in the refactor); it walks direction offsets as numbers and reverses the route once instead of
  unshifting. Predecessors stay in a `Map` rather than a typed array of w * h, so a small flood on a large board
  does not pay for the whole board. 200 paths across 40 x 40: 978 ms -> 473 ms.
- **`fx` particles.** Options: scan all 900 slots every frame; keep a list of live indices (allocation and removal
  cost); `Kit.slotRing`, which hands slots out in a circle and tracks the window from the oldest live slot to the
  newest (O(window), no allocation). Chosen: the ring, as a tested primitive in core.js. Not benchmarked in a
  browser; the saving is the slots not visited (all 900 when nothing is in flight).
- **`Kit.path` out parameter.** Paths take an optional point to write into, so a per-frame sampler allocates
  nothing. It did not make sampling faster in the benchmark (trigonometry dominates; 3.0 s vs 2.2 to 2.8 s per 1e6
  samples, within noise); the gain is less garbage, which was not measured. Kept because it is optional and free.

## Touch-skill models: pure reducers in a new kit file (`kit/touch.js`)

- **Options.** (a) Keep the trace meter, lasso and gauges inside the cozy game (least work; nothing reusable, nothing
  testable without a browser). (b) Add them to `kit/space.js` beside `Kit.line` (one file fewer; but that file was
  being refactored by the steward and holds geometry, not rules). (c) A new pure file `kit/touch.js`.
- **Chosen.** (c). `trace` is a reducer over plain state (`step(state, dt, pointer) -> state`, O(1) per step, one small
  object allocated per frame) rather than a stateful object, so a fight can be simulated headlessly: the cozy fairness
  and pacing scripts play thousands of fights through the same code the game runs. `stroke` and `walker` hold state
  because they wrap a growing list and a position that views read every frame.
- **Revisit if.** A game needs many simultaneous traces per frame (then reuse one state object instead of allocating).

## Cozy town projects: rows of the same `Kit.upgrades` model as the shop

- **Options.** A separate table plus `Kit.profile.unlock` ids checked by hand at every gate, or project rows inside the
  shop's `Kit.upgrades` model (granted on delivery, never bought) so tackle and seed rows gate on them with `requires`.
- **Chosen.** The second: one source of truth for "what is open", `ui.shop` shows Locked without extra code, and a
  project's `mods` reach `Kit.stats` for free. `Kit.profile` keeps what is truly lifetime: the achievements.
- **Revisit if.** Projects need costs in several currencies (then `wallet.spendAll`) or stop being a straight line.

## Tabletop visibility: symmetric shadowcasting on wall cells

- **Options.** Ray casting to every cell in range (simple; O(r^3) cell visits per eye; asymmetric, so A can see B
  while B cannot see A). Recursive shadowcasting (O(r^2); fast; also asymmetric and shows artefacts beside pillars).
  Symmetric shadowcasting (O(r^2) per eye, independent of board size; if A sees B then B sees A, which players can
  reason about). Visibility polygons over wall segments (smooth edges; needs edge walls, polygon clipping and a
  mask renderer; overkill for a cell grid).
- **Chosen.** Symmetric shadowcasting in `Kit.sight.fov` (kit/sight.js), walls as whole cells, a union mask per
  viewer. About 200 cell visits for sight 8; recomputed only when a token, door or map key of the scene changes.
  Tested for symmetry on a random cave.
- **Revisit if.** Maps need thin walls between cells or per-piece light sources with colour and falloff.

## Tabletop sync: per-key last-writer-wins, authority proven by where a message travels

- **Options.** One host owns the state and relays (simple rules; needs a host online; the platform has no private
  channel to one peer). Operation log with CRDT merges (handles concurrent edits of one value; far more code and
  bytes than 4 KiB messages allow). Per-key last-writer-wins with every screen validating every change (O(1) per
  write, O(keys) memory; concurrent edits of the same key lose one; needs keys cut small).
- **Chosen.** Per-key LWW on `Kit.net.session`, keys cut so that concurrent writers rarely share one (a token, a
  sheet, one map row, one ink chunk). Authority is not claimed in messages: game masters send on an admin-only room
  topic and write an admin-only database path, players write only their own `{self}` subtree, so every screen can
  check "who may change what" (`Kit.tabletop.rulesFor`) against a sender the platform vouches for, live or stored.
  Version counters above "now plus five minutes" are refused, which bounds the one known LWW attack.
- **Costs accepted.** Everything is delivered to everyone, so fog and hidden tokens are client-side courtesy, not
  secrecy. A game master and a player writing the same key leave two stored copies (the newer wins).
- **Revisit if.** The platform offers per-recipient delivery (true secrets) or server-side checks.

## Tabletop dice: seeded rolls announced as notation plus seed; physics for feel only

- **Options.** Send the result (smallest code; a total can be forged independently of the dice shown). Physical dice
  whose resting face is the result (feels best; physics is not deterministic across devices, so screens would
  disagree). Commit-reveal between peers (stops a roller choosing a seed; needs a second round trip and an online
  counterparty). Notation plus seed, re-rolled by every screen with `Kit.dice` and `Kit.rng` (one small message;
  dice and total always agree on every screen; the roller still picks the seed).
- **Chosen.** Notation plus seed; dice are thrown with `Kit.physics` purely as animation and then labelled with the
  seeded faces. O(dice) per roll, capped by `Kit.dice.LIMITS`.
- **Revisit if.** Tables want protection against a player hunting for a lucky seed: add commit-reveal with the GM.

## Prism Garden: proving and forging beds (kit/puzzle.js, games/prism-model.js)

- **Solver.** Options: breadth-first search over every legal move (simple, exact; a shelf bed has ~40 moves per
  position and explodes); A* or IDA* with a heuristic (fewer states, but an admissible heuristic for light routing is
  not obvious and a wrong one silently breaks "par is the minimum"); breadth-first over a pruned move list (exact as
  long as the pruning is sound). **Chosen:** `Kit.search.shortest` (BFS, O(states x moves)) with the game supplying only
  moves that touch lit cells. The pruning is argued in the code and cross-checked against the unpruned list by
  `scratch/prism/solve.js` on every campaign bed (night-garden: 108 states instead of 908). Revisit if a bed needs a
  piece set down in the dark on purpose.
- **Search state.** Options: one grid per position (uniform, but building a Kit.grid per child cost most of the time);
  fixed board + short list of loose pieces, grid assembled only for explored positions. **Chosen:** the list. Measured
  with `scratch/prism/bench.js` under heavy machine load: about 1200 us to 650 us per explored state; the rest is
  `Kit.grid.find` and grid construction, which allocate an object per cell.
- **Forged beds.** Options: random board then keep the solvable ones (most random boards are unsolvable or trivial);
  hand-written only (ends after 14 beds); build a solved layout, scramble it, then let the solver find the true minimum
  and rate it. **Chosen:** solution-first forge behind `Kit.search.generate`: every bed has a solution by construction
  and is still proven; a proposal whose scramble is smaller than the tier's minimum is dropped before any search.
- **Sunstones and gates.** Options: general fixed-point (gates that also close can oscillate); "lit sunstones open all
  gates" evaluated in two passes. **Chosen:** two passes. Opening a gate only lets light travel further, so the result
  of the second pass is stable. Revisit if a rule is added where light can remove light.

## UI components: Preact + htm + signals on native HTML (proposed; the UI lead confirms or overturns by spike)

- **Problem.** The HUD is hand-built DOM with a hyperscript helper. There is no component library, no proper scroll
  pane, and state is pushed into elements by hand. The menu failed to scroll on a phone and nobody could say why.
- **Options.**
  - Keep hand-built DOM (`ui.h`): no dependency; every view re-implements updating, focus and scrolling. What we have.
  - Web Components (custom elements, optionally Lit, about 6 KB): native, encapsulated, framework-free to consume;
    shadow DOM complicates per-game theming beyond tokens, and state plumbing is still manual without Lit.
  - Preact + htm + @preact/signals (about 5 KB together, UMD builds on the allowed CDNs): declarative components,
    no build step (tagged templates), JSX later via `bun build` with no rewrite; signals update only the node that
    reads them, so a HUD bound to a model costs O(changed values) per update rather than a re-render.
  - React or Vue: far larger, need a build step, more than a HUD needs.
  - Svelte or Solid: excellent output, but compile-only, which the loose-file page cannot use today.
- **Proposed.** Preact + htm + signals for composition and state; native elements for behaviour (`overflow` scrolling
  with `overscroll-behavior` and scroll snap, `<dialog>`, popover, `<details>`, `<meter>` / `<progress>`, container
  queries, view transitions); theme tokens unchanged; existing `ctx.ui.*` calls kept as wrappers.
- **Revisit if.** The spike shows a CSP or load problem on the hosted page, signals fight the game loop, or the
  wrappers cannot keep the current calls working.

## Ferry Lines: how a drawn stroke becomes a route (`Kit.route.capture`)

- **Options.** Clean the whole stroke at once, then look for docks near the result (simplest; but corner smoothing
  pulls the line off any dock drawn through at a bend, so hub lines silently lost stops: the pacing bots failed 768
  of their hub strokes this way). Skip smoothing (stops stay exact; routes look jagged and boats turn sharply). Pin
  the stroke to every anchor it passes, clean each section between two anchors on its own, join the sections.
- **Chosen.** Pin and clean per section: O(points x anchors) time, O(points) space, stops lie exactly on the joints
  by construction. Covered by a test with a control case showing the whole-stroke clean drifting off the dock.
- **Revisit if.** Strokes get long enough (thousands of points) or anchors numerous enough for the product to matter.

## Ferry Lines: right of way and berths without a spatial index

- **Options.** All-pairs check each step, O(boats squared). Spatial hash, O(boats) per step but more code and state.
- **Chosen.** All-pairs: a fleet is at most five boats (25 distance checks a step), far below where a hash pays.
- **Revisit if.** Several boats per route or fleets beyond a few dozen are added.

## Ferry Lines: proving pacing

- **Options.** Assert the pacing from the tables (cheap, and wrong: the first tables unlocked everything in ten
  minutes and killed every bot at two minutes whatever it did). Scripted browser bots (real input path; minutes per
  watch on the shared machine). Headless bots on the pure simulation (`scratch/ferry/pacing.js`: three hours of play
  for two careers of four bots in about 25 seconds).
- **Chosen.** Headless bots, with the game's rules, shipyard and record shared between page and script
  (`games/ferry-sim.js`) so the proof runs the shipped code. A shared simulator in `tools/` is the next step once a
  second game needs one.

## Core Miner: where the economy lives and how its pacing is proved

- **Options.** Rules inside the game's `create(ctx)` closure (what it was: untestable, unsimulable). Closed-form
  expected-value maths for the curve (fast; cannot see heat, overheating, forks or stalls, which are the game).
  A pure rules module driven tap by tap by bots (`games/miner-rules.js` + `scratch/miner/sim.js`).
- **Chosen.** The pure module: `createModel` wires the kit models once, the page and the script both call it, and the
  script plays every tap. Cost: O(hours x 36,000) ticks, each O(upgrades); 8 hours for 4 bots runs in about a
  minute. It paid for itself on the first run: the first tables reached depth 50 in 8 minutes and finished the tree
  inside an hour.
- **Revisit if.** `make sim` lands: the bots and report should move onto it and only the policies stay here.

## Core Miner: gear as Kit.inventory items, kept through a collapse

- **Options.** Gear as `Kit.upgrades` rows with max 1 (one currency per row, so no two-ore alloys; no slots). A
  private owned / worn map (a fork of what the kit has). `Kit.inventory` with recipe rows as items, paid for with the
  new `wallet.spendAll` (slots, stat feeding, saving and compare come free; `Kit.synergy` reads the worn items' tags).
- **Chosen.** `Kit.inventory`. Gear and chunks survive a collapse: the simulation showed that with a reset the forge
  was never used (a run lasts minutes, a recipe takes dozens of ores), and kept gear makes the loadout a decision at
  every fork.
- **Revisit if.** Gear should come in rolled rarities (then `Kit.loot` generates the items instead of a table).

## Lint: Biome for generic rules, a small custom lint for project rules; format not enforced yet

- **Options.** Biome 2.6.8 (one binary, lint + format). ESLint 10 + Prettier (largest rule set; two tools, slower
  start, more config; not measured here because Biome already covered the generic rules). The regex-and-tokenizer
  lint alone (no install; cannot see scopes, so no unused or undeclared names).
- **Measured.** Biome lints all 74 files in 0.55-0.63 s. With the recommended set it found real defects the custom
  lint cannot: an undeclared variable in `kit/model.js` (someone's edit in flight), four uses before declaration in
  `kit/puzzle.js`, a shadowed `valueOf`, 13 accumulating spreads (accidental O(n^2)). Its `noMagicNumbers` raised
  2,491 warnings (it flags every literal, table rows included) against about 215 from the custom "used more than
  once and unnamed" rule; it has no rule for file headers, JSDoc on `Kit.*` exports, `@complexity`, single-letter
  names, leftover notes, commented-out code, the depth plan, or the kit's own bans (raw timers, raw `THREE.Color`).
- **Chosen.** Both, split by what each can express: Biome (`biome.json`) for scope-aware generic rules, with the
  rules that fight this codebase's idioms or its ES2019 target switched off (optional chaining, template-only
  strings, assignment in arrows, `forEach` callbacks that return); `tools/dev/lint.js` (about 300 lines, O(tokens)
  per file, unit-tested) only for the project rules above. `check` fails on Biome errors and on the custom lint's
  exact rules; heuristic rules warn.
- **Format.** Biome's formatter would rewrite 58 of 75 files at line width 200 (74 at 120). With a dozen agents
  editing the same files that is a merge hazard and breaks "never reformat a shared file", so it is offered per file
  (`make format FILES=...`) and not enforced. **Revisit** when the tree is quiet: one formatting commit, then enforce.

## Types: `tsc --checkJs` 5.9 as a per-file ratchet; not TypeScript 7 yet, not a TypeScript migration

- **Options.** `tsc --checkJs` over the JSDoc we already write (no syntax change, no build step). Migrating to
  TypeScript (stronger; needs a build step for a page that today has none). None.
- **Measured.** TypeScript 7.0.2 (native) checks the tree in 0.47 s but rejects the Closure-style JSDoc types the kit
  uses throughout (`function(number): number`, `*`): it stops at three syntax errors and checks nothing else.
  TypeScript 5.9.3 parses them: 3.3 s, 245-307 errors across about 40 files depending on the minute, with `Kit`,
  `THREE` and `CANNON` declared loosely (`tools/dev/types/globals.d.ts`). Many are real docstring drift.
- **Chosen.** 5.9.3 with a baseline (`tools/dev/types-baseline.json`): `check` fails when a file has more type errors
  than its recorded count, and a new file is allowed none, so docstrings are load-bearing for new code without
  turning the whole tree red mid-flight. `node tools/dev.js types <file>` lists a file's errors; `--update` lowers
  the baseline. Cost: 3 s per check, 23 MB of dev-only install.
- **Revisit.** Move to TypeScript 7 (7x faster) once JSDoc function types are rewritten in TS syntax
  (`(value: number) => number`), which is mechanical work for a low tier; type `Kit` itself only if the loose
  global starts hiding real mistakes.

## Unit tests: keep `tools/test-kit.js`; do not migrate to `bun test` now

- **Options.** `bun test` (watch, filter, coverage). The hand-rolled runner (one file, one shared sandbox that
  loads kit files in order, about 180 tests, appended to by every agent).
- **Measured.** The whole suite takes 3.7 s under Bun and 5.1 s under Node on the loaded machine, so speed is not a
  reason. A migration means rewriting every test's harness (`import { test } from 'bun:test'`, per-file sandboxes)
  in a file a dozen agents are appending to, and `node tools/test-kit.js` would stop working for them.
- **Chosen.** Keep it. New tool tests follow the same shape (`tools/test-dev.js`). **Revisit** when the suite is
  slow enough to want filtering, or when the tree is quiet enough to split the file per module.

## Shipping: loose files while building; minified bundle proposed for release, not implemented

- **Measured.** The page loads 73 local scripts: 1.91 MB, 588 KB gzipped. Concatenated in tag order and run through
  `bun build --minify` (0.4 s): 0.71 MB, 263 KB gzipped (63% and 55% smaller) and it parses.
- **Not verified.** That the bundle runs: files share globals as classic scripts, and a bundler's module scope can
  break a top-level `const` shared between a game's files. It needs a smoke run of the bundled page.
- **Chosen for now.** Loose files (debuggable; each agent's edit is one file). **Next step,** for whoever owns
  `tools/release.js`: bundle inside the frozen copy and smoke that copy before staging it.

## Progression simulator: a four-function interface over the game's own state

- **Options.** (a) Each game writes its own simulator script (what existed: one per game, different shapes, not
  comparable). (b) A generic simulator that drives the page headlessly (uses the real game, but minutes of browser
  time per simulated hour, and it measures the bot's reflexes rather than the economy). (c) A declarative economy
  description (tables of costs and incomes) that a tool interprets (uniform, but cannot express a game's real
  rules, so it would drift from them). (d) A small interface the game implements over its own pure rules.
- **Chosen.** (d): `headless.progression = { createState, actions, apply, summary }` (AGENTS.md "Headless model").
  The game reuses its real models (`Kit.upgrades`, `Kit.wallet`, `Kit.profile`), so the simulation cannot drift
  from the game; policies are plain functions `(actions, random) => action`, so greedy, random and saver work on
  every game and a custom one is a ten-line file. Cost: O(steps x actions on offer) time, O(purchases + samples)
  memory; two simulated hours of the scaffold run in well under a second.
- **Limits.** The curve is only as honest as the game's stand-in player (its skill is a number the game chooses).
  Warnings are thresholds (10 minutes without anything new, 20x the dearest price in hand), not judgements of fun.

## Benchmarks and frame budgets: what is trusted and what is not

- **Micro-benchmarks** (`make bench`): scores are relative to a calibration loop timed in alternating rounds, with
  the fastest sample of each kept, and each runtime has its own baseline (Bun and Node differ 2-3x in relative
  terms). **Measured noise** on this machine with about ten browsers running: identical runs differ by up to
  +/-100% under Bun and about +/-35% under Node. So a "SLOWER" flag (more than 50% below baseline) is advisory and
  only a change of algorithmic size is trusted; `--strict` exists for a quiet machine.
- **Frame budgets** (`tools/dev/budgets.js`, checked by `check`): draw calls (300), triangles (300k) and live meshes
  (200, from the brief) are properties of the scene and the same on every machine, so they fail the check. Frame
  time is printed but never budgeted: under software GL it was 130-570 ms a frame, which says nothing about a phone.

## Play runner input: mouse by default, real touch on request

- **Measured.** Chrome DevTools touch events reach the page as a real finger (touchstart, pointer events with
  pointerType "touch"), but Chromium delivers them aligned to rendered frames: on the loaded machine a tap's
  pointerdown and pointerup arrived 1.2 s apart, outside the 280 ms `Kit.input` allows a tap, so the tap was lost.
  Mouse events are not frame-aligned and worked every time.
- **Chosen.** Mouse by default; `--touch` (or `"touch": true` in a script) for scroll panes and touch-only code.
- **Proposed to the kit steward** (not done; `kit/input.js` is theirs): time a tap from `event.timeStamp` rather
  than `performance.now()` in the handler. That fixes the headless case and, more to the point, a real phone that
  drops a few frames during a tap.

## Open, for whoever picks them up (record the outcome here)

- Renderer: three.js 0.147 classic scripts (works on the hosted page today) vs current three.js as ES modules vs
  Babylon.js or PlayCanvas (more built in, heavier).
- Physics: cannon.js 0.6.2 (unmaintained; a mid-step removal bug is worked around in `kit/bodies.js`) vs cannon-es vs Rapier.
