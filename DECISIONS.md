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
  fixed board + short list of loose pieces, grid assembled only for explored positions. **Chosen:** the list. `scratch/prism/bench.js`
  read about 1200 us per explored state before and 650 after, but under a load average of 35 the same run varies
  several-fold, so treat the gain as unproven; the profile's top entries afterwards are
  `Kit.grid.find` and grid construction, which allocate an object per cell.
- **Forged beds.** Options: random board then keep the solvable ones (most random boards are unsolvable or trivial);
  hand-written only (ends after 14 beds); build a solved layout, scramble it, then let the solver find the true minimum
  and rate it. **Chosen:** solution-first forge behind `Kit.search.generate`: every bed has a solution by construction
  and is still proven; a proposal whose scramble is smaller than the tier's minimum is dropped before any search.
- **Sunstones and gates.** Options: general fixed-point (gates that also close can oscillate); "lit sunstones open all
  gates" evaluated in two passes. **Chosen:** two passes. Opening a gate only lets light travel further, so the result
  of the second pass is stable. Revisit if a rule is added where light can remove light.

## UI components: Preact + htm + signals on native HTML (confirmed by spike; implemented in `kit/ui/`)

- **Problem.** The HUD was hand-built DOM with a hyperscript helper: no component library, no proper scroll pane,
  state pushed into elements by hand. The menu was reported not to scroll on a phone and nobody could say why.
- **Options, and what the spike found** (`scratch/ui/spike.js`: a 12-stat HUD, every value set each frame, two of
  them changing; headless Chromium on the loaded shared machine, so compare the ratios, not the absolutes).

  | Option | Cost per frame | Weight (gzip) | Hosted page | Theming and today's calls |
  |---|---|---|---|---|
  | Hand-built DOM (`ui.h`, what we had) | 67 us (reads `textContent` back to compare) | 0 | fine | fine, but every view re-implements updating, focus and scrolling |
  | Preact + htm + signals | 3.4 us (a signal writes one text node) | 9.9 KB in five UMD files | all five are classic scripts on cdnjs / jsDelivr, no eval | plain light DOM: tokens and scoped game CSS reach it |
  | Preact, re-render each frame (no signals) | 185 us | 6.3 KB | same | same |
  | Web Components (light-DOM custom elements) | 17 us (attribute in, text out) | 0 | fine | shadow DOM would block `theme.css`; light DOM works but state plumbing and templating stay manual |
  | Lit | not measured | about 6 KB | **cannot load**: `lit@3` on npm is ES modules with bare imports, no classic-script build on the allowed hosts, and a module script would run after `kit/shell.js` | - |
  | React, Vue; Svelte, Solid | not measured | far larger; or compile-only | need a build step the loose-file page does not have | - |

- **Decision.** Preact 10.24.3 + htm 3.1.1 + @preact/signals 1.3.0 for composition and state; native elements for
  behaviour (overflow scrolling with `overscroll-behavior` and scroll snap, `<dialog>` with `showModal()`, the
  popover API, native inputs, container queries). A component is a function from props to an `html` template; any
  prop may be a signal; `Kit.ui.bind(model, select)` turns a Kit model into one.
- **What it costs.** Five script tags (and vendor copies plus URL swaps in `tools/smoke.js` and
  `tools/dev/browser.js`); the page now depends on a CDN for its menu, so `kit/ui/core.js` degrades: without the
  libraries it warns once and the shell-built menu and the whole legacy HUD still work.
- **JSX later.** htm templates and JSX both compile to the same `h(Component, props, children)` calls, so
  `bun build --jsx-factory=h` can be offered for component files without touching a component that exists.
- **Today's `ctx.ui.*` calls are kept as they are, not re-rendered through Preact.** Their markup is a contract
  (ten game themes style `.stat`, `.action`, `#modal .modal-card`, `.sheet-body`; `theme.components` hands live
  elements to games; tools read `#stats > *`), and mounting each through its own Preact root would have added a
  wrapper element between `#stats` and `.stat`. So `kit/ui.js` is the compatibility layer: same calls and markup,
  with the modal host now a native `<dialog>`, `ui.panel`'s body the kit's scroll pane, `stat.set` comparing against
  a cached string (the spike's 67 us), and `ui.mount` / `ui.dialog` / `ui.html` opening the library to games.
- **Revisit if.** The hosted page blocks one of the five files (then inline them: 23 KB raw), or a game needs
  hundreds of bound values per frame (measure before assuming).

## The menu "would not scroll on a phone": not reproduced; the first reproduction was the instrument

- **What was claimed.** In an emulated iPhone the menu (1175px of content in 664px, `overflow-y: auto`) ignored a
  finger. Two mitigations shipped unverified: the menu scrolled as the document, and phones got two compact columns.
- **What a trusted test shows.** `tools/touch-scroll.js` sends a real touch sequence (CDP `Input.dispatchTouchEvent`)
  and first proves itself on four control pages (`--self-test`: an `overflow: auto` box scrolls 279px; `overflow:
  hidden`, `touch-action: none` and a `preventDefault` on touchmove each move 0px). Run against the layout as it
  was when the failure was reported (`scratch/ui/root-cause.js`, iPhone 13 emulation), the menu **scrolled 225px
  under a 240px drag**, and did so in every variant tried: the host's safe-area shell, with and without the WebGL
  canvas, backdrop filters, `touch-action`, `overscroll-behavior`. The earlier "repro" was its swipe simulation
  (`Input.synthesizeScrollGesture`) failing, not the page.
- **So the cause on the owner's phone is still unknown**, and cannot be found from this machine: it is specific to a
  real device or to the host's frame (the leading suspects are a WebKit quirk with a `position: fixed` flex
  container that is itself the scroller, and the cost of twelve `backdrop-filter` cards over a live WebGL canvas).
- **What was done instead of guessing.** The mitigations are gone (document scrolling broke the one-screen layout
  and used `100vh`, which ignores the host's safe-area padding; the compact cards hid every tagline). The menu list
  is now the kit's `ScrollPane`: a plain block scroller inside a fixed-height column, no blur inside it, nothing
  listening to touch events, `overscroll-behavior: contain`. `bun tools/smoke.js menu` drags it with a finger on
  every run, and the component gallery shows a live "Scrolled Npx" readout so one look on the real phone settles it.
- **Revisit if.** The owner's phone still cannot scroll the menu: open Components from the menu footer and report
  whether the readout moves; that separates "no pane scrolls on this device" from "the menu's frame is at fault".

## Marble Works: wiring parts by placement

- **Options.** Drawn wires between parts (explicit, but a second gesture and a wire editor on a phone). Colour
  channels chosen by tapping (compact, but every emitter and receiver needs another pose axis and the player must
  match colours). Proximity: an emitter drives every receiver within two cells (no UI at all; O(emitters x receivers)
  per layout change, at most 10 x 10).
- **Chosen.** Proximity. Placement is already the one verb of the game, and making it the wiring too means routing
  and logic compete for the same cells, which is where the decisions come from. Wires are drawn so the rule is visible.
- **Revisit if.** Players want two independent circuits side by side closer than two cells apart.

## Marble Works: contacts resolved per physics step, not per frame

- **Options.** Resolve part behaviours once per frame after `phys.step` (simplest; but a frame holds one step at
  60 fps and three at 20 fps, so a bumper kick lands up to two steps late and the marble goes elsewhere: the same
  contraption solved a board in node and failed it in a 9 fps browser). Resolve inside cannon's `postStep` event
  (same result at any frame rate; the hopper beat and spinner phase are counted in whole steps on the same clock).
- **Chosen.** `postStep`. `scratch/marble/prove.js` replays every recorded answer at 60 fps and at 20 fps and fails
  if they disagree. Cost: nothing measurable (the same work, moved).
- **Revisit if.** Kit.physics gains its own per-step hook; the game should then use that instead of reaching for the world.

## Marble Works: rules in their own headless file, proven by replay

- **Options.** One game file with a `lab` handle (what the first version did; tools had to load view code).
  Rules and simulation in `games/marble-rules.js` with no DOM or THREE, the view in `games/marble.js`.
- **Chosen.** The split. Boards and songs are content that can silently become unsolvable when a number changes, so
  each has a recorded answer in `scratch/marble/solutions.json` that `prove.js` replays through the real rules, with
  a control that must fail. Answers were found by seeded random search (`search.js`, about 50 ms a try under load);
  the two logic boards needed a hand-built family because random placement almost never wires two parts together.
- **Revisit if.** A shared simulator lands in tools/: `prove.js` and `curve.js` should move onto it.

## Open, for whoever picks them up (record the outcome here)

- Renderer: three.js 0.147 classic scripts (works on the hosted page today) vs current three.js as ES modules vs
  Babylon.js or PlayCanvas (more built in, heavier).
- Physics: cannon.js 0.6.2 (unmaintained; a mid-step removal bug is worked around in `kit/bodies.js`) vs cannon-es vs Rapier.

## Version control: Git, one worktree per piece of work

- **Need:** a dozen agents editing one directory broke each other's page loads and tests at random
  instants (reported by six agents), and there was no history to bisect or roll back.
- **Options:** (a) keep one shared tree plus frozen-copy releases: zero setup, but only protects
  publishing, not development; (b) a copy of the tree per agent with manual merging: isolation, no
  history, merges by hand; (c) Git with a branch and worktree per piece of work: isolation, history,
  three-way merges, cheap (a worktree shares the object store; this tree is about 5 MB tracked).
- **Chosen:** (c). `make worktree` / `make land` make it the easy path. Cost: conflicts in the few
  append-only shared files, handled by keeping those edits small.
- **Follow-up this enables:** one test file per module and script tags generated from the directory
  listing (`make tags FIX=1`) would remove most of the remaining conflicts.

## Swarm Arena: neighbour queries through `Kit.spatialHash`, although all-pairs is faster at its crowd size

- **Options.** All pairs per frame (separation, shots against enemies, blades, blasts: O(n squared) and O(shots x n),
  no memory, no code). `Kit.spatialHash` (kit/hash.js: O(n) to file, O(cells + k) per query, visitor-based so a
  query allocates nothing). `Kit.crowd.buckets` (kit/crowd.js, written by another agent at the same time: same
  idea, but `near` returns a new array per query and `fill` drops its buckets each frame). A dense grid over the
  bounded arena (typed arrays, no Map lookups; fastest, but fixed bounds and more code).
- **Measured** (`bun scratch/arena/simulate.js bench`, one separation pass, microseconds per frame, machine idle at
  load 1; a run under load 35 gave the same ordering): 110 bodies: all pairs 22, spatialHash 65, crowd.buckets 118.
  400 bodies: 157 / 169 / 375. 1600 bodies: 2768 / 1169 / 2495. So at the game's cap of 120 enemies the hash is
  about 45 microseconds a frame SLOWER than all pairs for separation; it breaks even a little past 400 bodies and
  wins 2.4x at 1600. A whole simulated frame (every system, about 100 enemies) costs about 135 microseconds in Bun.
  Shots against enemies and the other queries were not benchmarked separately.
- **Chosen.** The hash, because the owner asked for it, because seven different queries (separation, nearest
  target, shots, blades, pulse and nova, mines, dash ram) share one structure and one padding rule, and because the
  cost at today's cap is under half a percent of a 16 ms frame while the cap can now rise without a rewrite.
  It is not an optimisation at 120 bodies and must not be reported as one.
- **Revisit if.** The enemy cap stays at 120 and a phone profile shows simulation time matters: all pairs for
  separation alone would win back the 45 microseconds. Or if the cap rises past about 500: then the dense grid is
  the next brick.
- **Open: two spatial hashes in the kit.** `Kit.spatialHash` and `Kit.crowd.buckets` were written in parallel.
  Proposal for the kit steward: keep `Kit.spatialHash` as the primitive and make `Kit.crowd.buckets` a thin wrapper
  (`fill` = clear + insert, `near` = query into an array), so there is one implementation.

## Swarm Arena: build depth from four kit rules, not a bespoke system

- **Options.** A hand-written build system inside the game (slots, exclusions and evolutions as game code). Three
  small gates on `Kit.upgrades` rows (`slot` with `options.slots`, `excludes`, `requiresMax`) plus `Kit.synergy`
  for tag sets and `Kit.profile` for the long arc.
- **Chosen.** The kit gates: each is a few lines, off unless a row uses it, and any game with level-up picks gets
  weapon slots, either-or choices and evolutions by adding fields to rows. `offer`, `canBuy` and the shop adapters
  honour them without change.
- **Revisit if.** A game needs a slot that an upgrade frees again, or exclusions between groups rather than rows.

## Kit.body: one abstraction, split into generic subsystems

- **The abstraction.** A thing is a graph of typed sockets filled by parts, described by a small recipe
  `{ species, seed, overrides }`. Likeness (one recipe, many renderers), species (tables roll recipes) and
  performance (movement by capability) all read the same compiled plan.
- **Options for the shape of the code.** One `Kit.body` module that owns everything. Or small generic pieces
  with `Kit.body` as a thin composition (amendment 22).
- **Chosen.** The split. Generic, body-free: `Kit.lineage` (parent chain + ordered traits + owned limits),
  `Kit.flags` (bitmask requirements with named failures), `Kit.columns` (pooled struct-of-arrays store),
  `Kit.seeded` (counter-based hash), `Kit.pack` (bytes and share codes), `Kit.palette` (colour ramps),
  `Kit.rig` (forward kinematics over a parents array), `Kit.reach` (inverse kinematics), `Kit.dynamics`
  (spring and point chain). Body-specific: `body-plan`, `body-parts`, `body-recipe`, `body-edit`, `body-store`.
  Cost: 16 files and one more name to learn per piece; bought: each piece is testable and reusable alone
  (the store has no body in it, the IK has no plan in it).
- **Duplicates found, not merged.** `Kit.physics.layers` (kit/bodies.js) has its own name -> bit table and could be
  rebuilt on `Kit.flags`. `Kit.physics` has its own fixed-step accumulator (1/60 s, 4 steps) beside
  `Kit.dynamics.stepsDue` (1/120 s, 12 steps). `Kit.seeded.pick` reuses `Kit.math.randomTools`; nothing new there.
- **Revisit if.** A second consumer of `Kit.lineage` wants limits that clamp instead of reject: make it an option.

## Kit.body: parts are plans, and an assembled body is a plan

- **Options.** A separate prop system (attachments tracked beside the skeleton, drawn and posed by their own
  code). Or attaching compiles a NEW plan: host bones, then per filled socket a mount bone and the part's bones.
- **Chosen.** The second. Kinematics, dials, capabilities, the debug renderer and the bake cache need no special
  case for props; wings from a part give the wearer the `wings` capability because capabilities derive from bone
  roles; a dropped sword is `part.plan`. Cost: one extra bone per attached part (the mount, which keeps the host
  bone's stretch out of the part) and a recompile per distinct outfit (cached by the bakery: 7 outfits for 20
  recipes in the bench).
- **Revisit if.** Outfits change every frame (they do not in any game here): then attach by index ranges in place.

## Kit.body: transforms (what scale means)

- **Options.** (a) Translation, rotation and three-axis scale, all inherited: standard, but a rotated child of a
  non-uniformly scaled parent shears, and a pose no longer composes as rigid transforms. (b) A 4x3 matrix per
  bone: exact and general, 12 floats, and the shear is still there to look wrong. (c) Rigid transforms plus two
  scales: a three-axis `scale` that stretches a bone's own content (children's offsets, sockets, tail, girth) and
  is NOT inherited, and a one-number `uniform` that IS inherited.
- **Chosen.** (c). "Longer legs" is the first kind, "bigger head, hat included" is the second, nothing shears, the
  forward pass is about 60 multiplications a bone, and mass follows as rest mass x the three scale factors
  (twice the size, eight times the mass: tested). Cost: no inherited squash and stretch of a whole subtree.
- **Revisit if.** A renderer needs skinning matrices: derive them from position, rotation and scale per bone.

## Kit.body: limits reject variants and clamp individuals

- **Options.** Clamp everything out of range. Reject everything out of range. Reject authored data, clamp
  individuals.
- **Chosen.** The third. A variant whose dial range leaves its species' limit is a mistake in a table, caught at
  load with the node, the path and the owner of the limit (`Kit.lineage`). A recipe comes from a player, an old
  save or a slider drag: `resolve` clamps and snaps it, and `validate` still lists it as `out-of-range`.
- **Trait conflicts.** Two traits of one node writing the same socket throw (`exclusive: ['fills']`); everywhere
  else the later trait wins and the node's own `set` always wins. Making every path exclusive was the other
  option; it would forbid the useful case of two traits nudging the same dial.

## Kit.seeded: counter-based derivation, and how fields are named in saved data

- **Options for derivation.** A stream (`Kit.rng`): field n depends on fields 1..n-1, so adding a dial re-rolls
  everything after it. A hash of (seed, field name): each field stands alone.
- **Chosen.** The hash (FNV-1a of the name, MurmurHash3's finaliser to mix). Tested: adding a dial and a colour
  channel leaves every old field of 40 seeds x 4 species unchanged.
- **Options for field ids in the binary form.** Position in the species' field list (smallest; breaks on
  insert). An author-assigned number per field (stable; a chore, and a second source of truth). The 32-bit hash
  of the field's name (stable, free, 4 bytes per override).
- **Chosen.** The name hash for fields and parts (collisions are checked per species at load); an explicit
  `code` for species, because every recipe carries it, a varint keeps it to one byte, and a node without a code
  is how an archetype says it is abstract. A bare recipe is 6 bytes (8 characters as text); an override costs 5
  or 8. A nested socket the species never declared is spelt out by name.
- **Quantising.** A dial has 255 steps, so a value is one byte, `decode(encode(r))` equals `normalize(r)` exactly
  and equal looks hash equally. Cost: a dial resolves to 0.4% of its range.
- **The look hash** is a whole number below 2^53 from two 32-bit lanes: a Map key with no string or BigInt
  allocation. Not a security boundary.

## Kit.reach: chain solver

- **Options.** CCD (turn one joint at a time so the tip swings towards the target): works on rotations, so limits
  clamp naturally at every step, but each step needs the tip's new position, O(joints^2) a pass here, and it
  curls the tip first. FABRIK (drag joint positions to the target and back along the bone lengths): O(joints) a
  pass on positions alone, spreads the bend along the chain, has a closed form when the target is out of reach,
  and needs one extra O(joints) pass to turn positions into rotations. Jacobian methods: smoothest, heaviest.
- **Chosen.** FABRIK, with limits applied as rotations are written back (`Kit.reach.follow`). Measured in the
  tests: a five-link chain reaches 1 mm in under the 12-pass limit. Cost, stated in the docstring: limits are not
  part of the iteration, so a tightly limited chain stops short instead of finding another way round.
- **Two-bone limbs** are solved exactly (law of cosines, a bend hint, no iteration); in the bench, 500 bodies
  with every foot solved cost 1.8 ms a frame in node against 0.4 ms without.
- **Revisit if.** Spines need limits respected exactly: add a CCD pass after FABRIK for limited chains only.

## Kit.dynamics: a fixed clock

- **Options.** Integrate with the frame's dt (frame-rate dependent; another game here was bitten). The closed
  form of a critically damped spring (exact at any dt, but only for one spring with a constant target). A fixed
  step with an accumulator.
- **Chosen.** Fixed 120 Hz steps (semi-implicit Euler for the spring, Verlet with position-based length
  constraints for the chain), at most 12 a call. Tested: the same motion at 60 and 20 frames a second within
  2% (spring) and 8 cm on a 1 m chain. A spring too stiff for the step is refused when it is made.
- **Revisit if.** Hundreds of springs per frame show up in a profile: the closed form is the cheaper brick.

## Colour as palette ramps, shape as data

- **Chosen** (amendment 23). A colour channel names a palette; an individual stores the index of a ramp (shades
  dark to light with a hue drift); a bake exposes `boneRamp` (per bone, which of the individual's ramps paints
  it). No RGB is stored on an individual, so palette-indexed toon and pixel shaders read it directly. A bone's
  `shape` is a primitive or a lathe / extrude profile in bone space, so dials deform it through the bone's scale.
  Rejected: free RGB per channel (cannot be banded by a shader without a lookup) - not supported at all today.

## Benchmarks: a vm sandbox is about ten times slower than a page

- **Measured.** The same code, same machine, load average 0.3: resolving a recipe took 15 499 ns in a
  `vm.createContext` sandbox and 852 ns loaded into the main context; a 500-body frame 1.38 ms against 0.38 ms.
  Every global the kit reads inside a sandbox (Kit, Math, typed-array constructors) goes through an interceptor.
- **Chosen.** `tools/bench-body.js` loads the kit with `vm.runInThisContext`. `tools/bench.js` still uses a
  sandbox; its scores are relative to a calibration loop in the same sandbox, which cancels some of this but not
  all (the calibration reads fewer globals). Proposal for the tooling owner: load the kit the same way there.

## The stylised look (Kit.look): palette-indexed toon and pixel shading

- **Colour space of ramps: OKLCH** (in `Kit.palette.tones`). Options: the linear RGB formula of the earlier
  project (cheap, but equal RGB steps crush the darks and the violet mix greys warm colours), HSL (already in
  `Kit.blend.hsl` and used by `Kit.palette.ramp`; its lightness is not perceptual, so a yellow and a blue ramp
  with the same numbers have different contrast), OKLCH (about 40 lines of matrices; equal lightness steps look
  equal, hue can turn without changing lightness, chroma can be reduced to fit the gamut without moving either).
  Chosen OKLCH; shadows turn up to 26 degrees toward hue 285 and gain 12% chroma, the highlight turns up to 14
  degrees toward hue 95 and loses 30%. The hue-based `Kit.palette.ramp` is kept as it is for the body catalogue;
  its shades load into the same atlas as authored tones.
- **One palette model.** The look's colour code was folded into `kit/palette.js` after the body system landed
  with its own `Kit.palette`; a second module would have been a second source of truth for the same fact.
- **Palette as an 8 x N texture** (tone columns 0..5, a spare, ink in column 7; one row per ramp). A material
  stores a row and nothing else. Recolouring a character rewrites its rows (O(ramps), no material touched).
  Rejected: a texture per character (a low-resolution resolve pass could not know which one a texel needs).
- **Toon material: ShaderMaterial over three.js's skinning and instancing chunks**, not `onBeforeCompile` on
  MeshToonMaterial. The palette contract needs the fragment's last word (an index or a table colour, never lit,
  never tone mapped); patching the standard chunks back out is fragile across three.js releases. Cost: no scene
  lights, shadows or fog (one view-space key light), no morph targets.
- **Outlines: inverted hull for the native-resolution looks, screen-space ink for the pixel look.** Measured on
  the showcase (two figures, 54 meshes, 390 x 780, software GL): hull 95 draw calls and 48 088 triangles, 42 ms;
  screen-space ink at native resolution 56 calls, 26 224 triangles, two 390 x 780 targets, 25 ms; ink at
  98 x 195 texels 56 calls, 12 ms; hull at 98 x 195 97 calls, 18 ms. The hull is geometry, so the canvas's MSAA
  smooths it and it needs no target; it doubles draw calls and cannot draw a one-pixel line. Ink is exactly one
  texel and knows ink groups (no seam between two pieces of one garment, none on eyes), but indices cannot be
  anti-aliased, so at native resolution its edges are stair-stepped. Hence hull for toon and soft toon, ink for
  pixel. The software timings also include MSAA on the direct path, so they do not rank the two on a phone GPU.
- **Index target: one RGBA8 texture (ramp, tone, ink group, 8-bit view depth), no MRT, no depth texture, no
  normal target.** WebGL1-safe (the shell creates WebGL2 when it can; verified `isWebGL2` true in the test
  browser, and nothing here needs it). Eight bits of depth are enough because the range is fitted round the
  figures each frame. Given up: crease lines from normals.
- **Own frame, outside the post chain.** `kit/shell.js` now lets a game return `render(renderer, ctx)`. Bloom and
  ACES would change palette colours; a readback of a flat swatch matches the palette hex exactly (gap 0 of 255)
  on all three presets.
- **Pixel shimmer: what helped.** Texel snapping plus dither anchored to the figure: 0% of texels differ from a
  whole-texel shift of the first frame while a figure moves 0.23 texel per frame; snapping with screen-fixed
  dither 4.7%; no snapping 15-16%. It only worked once the low-resolution camera covered whole texels (texels
  were 0.5% wider than tall). Under rotation the dither space barely matters at strength 0.12 (0.2% of texels
  flicker per half degree with none, screen-fixed or figure-fixed dither; surface-fixed dither is worst at
  0.5%); rounding the turn to 24 facings is what removes crawl between facings.

## Kit.figure: one mesh per piece, instancing for crowds (the skinned merge measured and rejected)

- **Options.** (a) One Mesh per piece (a bone's surface), its matrix written from the pose's world transforms
  each frame. (b) One SkinnedMesh per paint region (pieces with the same ramp and ink group merged, every vertex
  bound to its bone with weight 1). (c) Instancing across figures that share a bake: one InstancedMesh per piece,
  an instance matrix per figure.
- **Measured** (`Kit.currentGame.measure()` on `Kit.play('figures')`: a human with hat and sword, level `medium`,
  390 x 780, software GL in headless Chrome; draw calls / triangles / ms per frame including posing and a GPU flush):

  | Look | Figures | (a) meshes | (b) skinned regions | (c) instanced |
  |---|---|---|---|---|
  | toon (hull) | 1 | 48 / 5k / 9.1 | 20 / 5k / 10.3 | 48 / 5k / 9.3 |
  | toon (hull) | 20 | 960 / 94k / 92.9 | 400 / 94k / 98.4 | 48 / 94k / 84.5 |
  | toon (hull) | 200 | 9600 / 940k / 850 | 4000 / 940k / 887 | 48 / 940k / 706 |
  | pixel (ink, 98 x 195) | 1 | 26 / 2k / 11.2 | 12 / 2k / 7.6 | 26 / 2k / 8.2 |
  | pixel (ink, 98 x 195) | 20 | 482 / 47k / 24.0 | 202 / 47k / 25.5 | 26 / 47k / 19.7 |
  | pixel (ink, 98 x 195) | 200 | 4802 / 470k / 136 | 2002 / 470k / 160 | 26 / 470k / 116 |

  Software GL caveat: SwiftShader's time follows triangles, not draw calls, so these rows rank (a) and (b) as
  equal and (c) only slightly ahead. On a phone GPU the per-call CPU cost of three.js (state changes, uniform
  uploads) is what 9 600 calls would pay for; that is where (c) wins and (b) would win by 2.4x over (a).
- **Chosen.** (a) for individuals (`Kit.figure.build`): exact normals under a dial's non-uniform scale (three.js
  skins normals with the bone matrix, not its inverse transpose), correct bounds and culling for free, and every
  incremental update is a keyed diff of meshes (a hat adds two meshes; nothing is re-merged). (c) for many of
  one look (`Kit.figure.crowd`): 48 calls whatever the count. (b) rejected: it halves calls but saved no time
  here, needs hand-set bounds (its geometry sits in bone space at the origin) and a re-merge of the whole region
  for any change to one of its pieces.
- **Revisit if.** A phone profile shows draw calls dominating with 10-50 distinct figures on screen: then merge
  per region inside `build` (the probe's `buildSkinned` is the starting point) or batch by shape key across figures.

## Kit.figure: shapes in bone space, links for hub bones, ramps and ink groups inherited

- **Shapes live in bone space and the bone's world matrix carries the dial's scale**, so a dial drag rebuilds no
  geometry and two individuals of one species share every geometry (keys cached by shape parameters, rounded to
  0.1 mm; measured: five sample figures plus a hat need 53 geometries). Cost: a girth dial squashes a capsule's
  round ends into ellipses.
- **A bone without a tail draws a capsule to every continuing child**, not only the first. Found on the first
  browser run: the carp had a bare stretch between trunk and rear and the human's arms floated beside its chest.
  Inside a region a link narrows to the child's girth; across regions the first link keeps the bone's width (a
  chest into its neck) and side links narrow to at least 60% of it (shoulders, hips). Rejected: tapering every
  link to the child (the chest became a cone to the neck), and filling hubs with a sphere (still left the gaps).
- **Bones that name no paint take their nearest painted ancestor's ramp** (and paint channel, so a ruby on a sword is
  shiny metal). Rejected: a fixed "unpainted" ramp (the hound's legs would differ from its body) and changing the
  body system's `boneRamp` (its -1 is a true statement about the data).
- **Ink groups**: one per limb (editor group plus end and side), one per part from a hash of its key (64..253), so
  a hat keeps its group when a sword is picked up; 0 for features flagged `glow`. Verified in the ink look: no
  line between upper arm and forearm (cloth and skin, one group), a line where an arm crosses the chest.
- **A figure reserves 8 palette rows** (its ramps padded), so a species change rewrites rows in place instead of
  leaking a block (the atlas has no free). `loadRows` lets a crowd of one look share one block.
- **Grounding and framing measure the body's surfaces at rest, props left out**: the foot box reaches 3 to 7 cm
  below the ankle joint, so `Kit.body.lowestY` (joints and tails) would sink the feet; a sword or a hat neither
  lifts the body nor rescales the view (tested). The figure turns about the middle of its footprint, not the
  plan's origin (a hound's hips are 35 cm behind it).
## Kit.motion: a stage is a fixed-clock step plus a per-frame pose

- **Options.** (a) One function `(state, plan, dt)` run on every fixed 120 Hz step, doing everything. Simplest
  to compose, but inverse kinematics would run twice a frame at 60 fps and six times at 20. (b) One function per
  rendered frame: cheapest, but where a foot lands then depends on the frame rate. (c) A stage as a pair of
  functions of that same shape: `step` on the fixed clock for what must be simulated (phase, lift, swing,
  plant: a few scalars per leg) and `pose` once a frame for what is a pure function of that state (the pelvis,
  the solves, the tails).
- **Chosen.** (c). Combinators (`sequence`, `blend`, `layer`, `when`, `byDetail`) compose both halves, and a
  plain function is accepted anywhere as a pose-only stage. Measured: the same course at 60 and 20 frames a
  second plants a biped's feet within 0.6 mm and a quadruped's within 11 mm. Cost: a stage author has to know
  which half a line belongs in; springs and chains keep their own fixed clock inside `Kit.dynamics`, so they
  are called from `pose` with the frame's dt.
- **Who moves the body.** The caller does (a game, a path, a physics body); `advance` is told where the body is
  now and replays the move in fixed steps. Rejected: the gait integrating its own position (root motion), which
  would make every game hand its steering to the gait. Cost: speed and turn rate are measured, so they are
  smoothed (14, 6 and 10 per second), and a lean or a gait change trails the input by about a tenth of a second.
- **The state owns the pose.** A bake is shared; a pose cannot be. `Kit.motion.state` holds the instance's pose
  and world buffers (88 bytes a bone) and each stage's record under `motion.memory`, made on first use. The
  store stays columns only; `advanceStore` joins the two by slot.
- **Revisit if.** A crowd needs thousands at detail 1: those poses are a function of phase alone and could
  share one buffer per bake.

## Kit.gait: stride from the Froude number, gaits from a table plus a rule

- **Stride.** Options: a stride length per species (a table to maintain, and dials would not change the walk);
  a fixed cadence; dynamic similarity. Chosen: stride = 2.3 x leg length x Froude^0.3 (Alexander), gait by
  Froude number (walk to 0.5, trot to 2.5, run beyond, with 12% hysteresis). Leg length is measured from the
  proportioned rest pose, so the leg-length dial changes stride, cadence and gait with no code. Tested: legs
  1.41 times longer stride 1.29 times longer at the same speed.
- **Which leg when.** Written rows for two and four legs in matched pairs (a gallop cannot be made by a rule);
  any other body uses a rule over legs ordered left hind-to-front then right: `sequence` (evenly spaced, a
  wave) for the walk, `alternate` (by row and side, a tripod for six legs) for the faster gaits. Tested on a
  three-legged and a six-legged plan built in the test.
- **Duty factor.** From the table, but capped so the body never travels more than 0.95 leg lengths over a
  planted foot. Without the cap a trotting quadruped's hips were pulled 16 cm down to keep its feet reachable.
- **Planting.** Options: foot curves locked to the phase (cheap, but feet slide whenever speed or heading
  changes within a stride); per-leg lift, swing and plant with the plant fixed in the world. Chosen the
  second: a leg lifts when its turn comes, swings to where its hip will be 0.4 of a stance after touchdown,
  and stays where it lands. Standing, the clock runs only while some foot is more than 6% of a leg length from
  home, so stopping ends with the feet stepping back under the body. Measured slide during stance: under a
  micrometre (float rounding), in node and in the page.
- **The pelvis.** Options: a spring alone (floats: nothing ties it to the legs); a full centre-of-mass solver
  (heavy, and a walker is not statically balanced anyway). Chosen: a nominal height just under a straight
  stand, lowered every frame by exactly what the most stretched leg needs (swinging legs included, so
  touchdown is continuous), released at a limited rate, plus a spring that each landing kicks and a sideways
  shift of 35% towards the middle of the planted feet. The foot rolls onto its toe at the end of a stance,
  which is what lets the rear leg reach without pulling the body down. Cost: the body is lowest at touchdown
  at every speed, which is right for a walk and wrong for a run (a runner is lowest in mid-stance).
- **Knees.** The bend hint comes from `Kit.body.bendDirection` (the joint's own limits), so a knee cannot be
  hinted backwards. Limits are NOT passed to `twoBone`: its clamp splits a rotation into turns about x, y, z
  and a hinge allows only x, so a leg stepping sideways would be clamped off its target and the foot would
  slide. Cost: a knee may carry a degree or so of twist the plan's limits do not allow.
- **Level of detail.** 0: all of the above. 1: the same clock, hips and knees turned through the stride, one
  forward pass, no plants (feet slide by centimetres). 2 and beyond: nothing is posed and the world transforms
  are not refreshed. In node, 500 instances: 3.2 to 3.6 ms, 0.9 to 1.3 ms and 0.55 ms a frame (load 0.8 to 3).

## Kit.swim: a wave of bending, sized by two measured relations

- **Options.** Wag the tail root with a sine and let a `Kit.dynamics` chain follow (looks like a dog, not a
  fish: the wave does not travel). Prescribe sideways displacement along the body (needs solving back to
  joint angles). Prescribe joint angles as a travelling wave of bending, which is how the muscles fire.
- **Chosen.** The third: each joint of the spine-and-tail chain turns by its share of a wave that travels back
  along the body. Beat frequency follows speed by Bainbridge's line, the tail's swing by a Strouhal number of
  0.3, both in body lengths so one row serves any size. The same stage with another row (`serpentine`) moves
  a limbless body on the ground. Cost: the amplitude scale assumes all joints peak together, so the real tail
  swing is somewhat under the Strouhal value; there is no water, so thrust and drift are not simulated.

## Kit.motion: allocation

- **By construction** nothing on the per-frame path makes an object, an array or a closure: per-instance
  records are made on an instance's first frames and reused.
- **Measured** in node, the heap still grows by about 60 to 180 bytes per instance per frame and is scavenged
  (1285 minor collections in 3000 frames of 500 instances at detail 0, 339 at detail 2). The collections remain
  with a bare `Kit.rig.worldTransforms` call in a loop (186 in the same count), and vanish for a loop that only
  writes object fields: V8 boxes a floating-point number each time one crosses a call that is not inlined
  (origin, heading, targets and hints are all passed as numbers). The core has the same property.
- **Not done.** Passing placements and targets through typed arrays instead of arguments would remove it, at
  the price of every signature in `Kit.rig` and `Kit.reach`. Revisit if a profile on a phone shows the
  scavenges: at 500 full-detail bodies they are inside the 3.2 ms measured.

## tools/motion-strip.js: looking at motion without a browser

- **Options.** Judge motion from numbers alone (how the knee-snap and the stilt-walk were missed in theory);
  a browser run per look (minutes each on the shared machine, and limited); a software canvas in node.
- **Chosen.** A 60-line software canvas with the seven context methods `Kit.body.debug.draw` uses and a PNG
  encoder over `zlib`: a strip of a stride in about a second. Twelve looks went into the tuning of the walk.

## Kit.body for a character creator: surface features, regions, sided dials (wardrobe branch)

- **Faces and clothes: geometry, textures, or data over bones.** Options: model every face and garment as
  parts with bones (a mesh per eye); bake textures per individual; or keep them as data placed on bone shapes
  (azimuth / elevation features; predicate regions over the bone's along / around coordinates, after the
  owner's spriteforge). **Chosen:** data. Two generic modules carry the maths (`Kit.surface`: signed distance,
  placement by bisection, along / around; `Kit.region`: compiled predicate trees), `kit/body-surface.js`
  composes them per bake. Cost: a renderer must turn stamps and regions into something it can draw (the
  adapter `Kit.body.figureHooks` does it for Kit.figure). Bought: one recipe drives every renderer, a face
  follows a reshaped head, and a new outfit is a data row.
- **Where face options live.** A new recipe field kind ('style:eyes') or parts. **Chosen:** parts, allowed to
  have no bones when they bring only features or regions. Selection, weights, required sockets, mirror, locks,
  encoding and the editor's choices all came free; the recipe format did not change (version 1, old blobs
  decode unchanged). Cost: a face part per option is one socket per facial feature (7 head sockets).
- **Sided dials.** A recipe-level link flag, or two dials drawn from one seeded field. **Chosen:** two dials
  ('eyeSize@left', '@right') sharing the base field, so rolls are symmetric and "linked" is simply "equal";
  the editor's base id moves both. Cost: an unlinked pair costs two overrides (10 bytes).
- **Shape dials** write numbers inside a bone's shape (`shapesWithDials`), never its transform, so a jaw dial
  cannot move a hat. **A dial's default step decodes to the default exactly** (255 steps rarely land on 1).
- **Conventions follow the renderer.** Lathe and extrude run up the positive long axis and extrude `across`
  follows `Kit.figure.ACROSS_AXIS`; the renderer landed first and is shared, so `Kit.surface` changed, not it.
- **Renderer edits made here, kept minimal:** layout draws the bake's dialled shapes; a shape may carry
  `scale`; `RAMP_SLOTS` 8 -> 16 (the wardrobe paints with 14 channels). **Not made, needed:** `regionOf`
  (clothing and hairlines do not render in 3D yet), `featuresOf` receiving the bake (features depend on
  dials, not on the plan; the adapter is built per bake today).
- **Stylised proportions** (about 3.4 heads): head-worn parts authored for a small head are fitted by one data
  transform (`scaledPart`) rather than retyped, so the next proportion change is one number.
- **Revisit if** a slider drag of a face dial shows in a profile: a bake places every feature copy again
  (0.66 ms per step for the wardrobe person); cache placements by (shape, numbers).

## Character creator (kit/creator-*.js, the `creator` screen)

- **Controls generated or written.** Options: a component per body part; one component per control kind fed by
  `editor.schema`. **Chosen:** rows from the schema (`Kit.creator.rows.groupsOf`: dial, colour, socket) and a
  kind -> view table (`ROW_VIEWS`). Cost: a control that is neither (a future field kind) needs a view row.
  Bought: a dial or part added to a catalogue appears with no creator change (a test extends the wardrobe with a
  dial and a part and finds both). A sided pair is one row (one slider while linked, two while not).
- **Re-render or signals.** Options: rebuild the pane from the schema on every edit; one signal per field.
  **Chosen:** signals (`controlHost`: a signal per field key and per lock) plus a `structureKey` signal for the
  row set. A drag updates one slider and one readout; the pane redraws only when the structure changes (a part
  with sockets, a pair unlinked, a body type).
- **When a slider reaches the figure.** Options: on each input event; queued and applied once per frame in
  `render()`. **Chosen:** queued, so a 120 Hz touch stream makes one edit and one bake per frame and the figure
  update is in the same frame as the edit. Cost: up to one frame of wait (the reported latency includes it).
- **Undo.** Options: a history step per input event; a step per pointer release; `Kit.history` with a merge key
  and a 700 ms window. **Chosen:** the last, plus `endGesture` on pointer release. A drag and a held arrow key
  are each one step; a pause or another control starts a new one. A lock or an unlink is not an undo step (no
  value changed).
- **Randomise this group.** Options: add `randomizeGroup` to the editor; use `randomize(seed, { locked })` with
  every control outside the group locked. **Chosen:** the second, in the session: no change to a shared file, and
  user locks inside the group still hold.
- **Switching body type.** Options: re-roll from the seed; carry every override and let the catalogue clamp;
  carry what `catalog.validate` accepts and report the rest. **Chosen:** the third. Dials outside the new range
  are clamped by the catalogue (kept, not dropped); an override the species cannot hold is dropped and named in
  a notice.
- **Share code.** Reused `catalog.encode` + `Kit.pack.toText` unchanged (no checksum: a typo that keeps the code
  decodable gives another character, which the person sees at once; a checksum would have made codes differ from
  every other use of the format). Failures are mapped from the library's messages to sentences by a table, tested
  so no sentence leaks library text.
- **Saved characters.** Slots hold share codes, not recipes, so a saved character survives catalogue changes the
  way a shared one does (it opens, or says why not). **Thumbnails:** colour chips from the character's own
  ramps, not a live render: a render per slot needs a palette block each and the atlas cannot free one (see the
  figure friction row), so it is not cheap yet.
- **Camera.** A table group id -> (anchor, span) as shares of the body's height, eased with a frame-rate
  independent exponential; an unknown group shows the whole body. Rejected: framing from the bones a group edits
  (right in principle, but needs the plan's roles per group and breaks when proportions change). Orthographic
  bounds are offset so the body stands in the stage element's box while the canvas fills the page.
- **Layout.** One CSS grid (stage above panel; beside it in landscape) and the camera fitted to the stage
  element's measured box. `Kit.look.panel.Panel` was not used (fixed 46% share, one scroller, no tabs); its
  `LookControls` and `lookControls` were.
- **Faces and the renderer.** `Kit.figure.build` binds `featuresOf` to the first bake, so the screen passes a
  wrapper over the hooks of the bake being drawn. If the figure takes the hooks per `setBake`, the wrapper goes.
- **Walking preview.** The motion state's pose is body-relative, so copying it into `figure.local` each frame
  walks the figure on the spot (a treadmill) with no change to the figure or the gait. The state is made again
  when the bake changes.
- **Revisit if** the panel's node count (591 at most, the Face tab) shows in a profile on a phone (swatch
  grids and option strips are the bulk: virtualise the strips); a part gets an icon in the catalogue (cards fall
  back to the group's icon until then); the character art lands and the camera table needs retuning.

## Character art: regions, faces and proportions in 3D (portrait branch)

- **Regions are read per fragment from a small map per bone.** A bone's regions bake once per outfit to a
  128 x 64 RGBA map over (angle around, share along): ramp slot, line class, shell index, flags. The toon and
  index shaders read it with a four-texel majority, so an edge is crisp at any mesh density and a garment edge
  needs no vertices. Maps depend on the outfit, not on dials: a slider drag uploads nothing.
  Rejected: **splitting the index buffer per ramp** (edges only as fine as the triangles, a draw call per
  ramp per bone, geometry rebuilt on every outfit change); **a ramp attribute per vertex** (same edge limit,
  and hull outlines would need the same attribute welded); **compiling regions to GLSL** (a program per
  outfit: compile hitches while trying on clothes). Cost measured in software GL at 1400 x 800 with 13
  characters: toon 1062 draw calls, 549k triangles, 694 ms per frame; pixel 546 calls, 276k triangles, 88 ms
  (the `look` stand-ins alone were not re-measured in this pass). 16 programs toon, 21 with the indexed path.
- **Thickness is a shell, not a second skeleton.** A region with `raise` draws the same bone shape inflated,
  showing only that region's texels: hair caps, sleeves, boots and coats stand proud of the skin and follow
  every dial for free. Rejected: separate garment bones (each needs its own dials and fights the body's).
- **Lines between regions come from line classes.** A region's line class is its ramp slot; a pattern
  (`ink: false`) keeps the class beneath, so stripes get no lines and a shirt edge does. Direct path: a
  screen-space test on the map coordinates; indexed path: the tone byte carries the class and the resolve
  pass inks where a neighbour's class is higher at the same depth. Rejected: an ink group per region (the
  group byte is per mesh, and garments span bones).
- **A face is one stamps piece per bone.** Every layer of every feature is a flat polygon settled onto the
  surface, with per-vertex paint (slot, tone, size rule, order). The size rule is the readable-at-any-size
  mechanism: `least` grows a layer about its centre to a number of target texels (pupil, glint), `drop`
  leaves a layer out below one (the white, iris, lid), measured across the layer's narrowest width. The order
  is a small depth pull per layer, because flat polygons on a curve sag under one another (blush fought the
  eyes in the first browser frame). Stamps hide where the map says hair occludes. Rejected: a texture atlas
  of faces (invents texels outside the palette and blurs under the pixel preset); one mesh per layer (the
  first version: 20 draw calls a face, no order, no occlusion).
- **Proportions are catalogue data.** About two and a third heads tall, head growth 1.4, chunky limbs, closed
  rounded lathes for the trunk (the banding of the first sheet was hull outlines on flat lathe ends). Dial
  ranges for jaw and chin were narrowed to what keeps the head a head. No special cases in code.
- **Edit cost.** Placed features are kept per plan under a signature of the head's shapes and face dials, so
  a body dial reuses them; outfits that differ only in surface parts share compiled bones;
  `polygonDistance` reads by index. `tools/bench-body.js`, node 22, 4 cores, load about 0.9: face dial
  (jaw) edit + bake 671 -> 202 us; body dial (height) 698 -> 68 to 86 us; first try-on of an eye style
  about 1.18 -> 0.81 ms (noisy, one machine). In the creator (software GL) a slider's `setBake` is 3 ms median.
- **tools/figure-preview.js** draws the same layout with a CPU rasteriser in two seconds. It was what made
  data iteration possible on eight browser runs, and it was wrong twice (no layer order, a sandbox ten times
  slower than a page): it is a sketch, and the `portrait` screen is the evidence.
- **Revisit if** a phone shows the fragment cost of the map read (drop the four-tap majority to one tap under
  `degrade`); faces at under about 25 texels across must carry expression (they do not: author a small-face
  frame set); thumbnails of parts are wanted (render a figure to a small target with a shared view and
  `atlas.free`).

## Kit.act: performances as data, life as stages (act branch)

- **A performance is keys in channel space, not bone tracks.** Fourteen channels (`shift`, `turn`, `spine`,
  `head`, an arm and a foot per side, `tail`, `wings`, `jaw`, `carry`, plus stepped face frames) address the
  body by role and in its own units (leg lengths, arm lengths, radians), so one row plays on a chibi, a lanky
  human and a winged elf, and a body without the role is refused in words (`Kit.act.refusal`). Cross-fades
  happen in channel space with a weight per group, which is what lets a wave take one arm of a walk. Rejected:
  baked bone rotations per species (one species at a time, no retargeting); a tiny scripting language (the
  repertoire is 20 rows of plain data and needs no control flow).
- **Feet and hands are solved, never keyed.** A foot channel is a place relative to where the foot stands
  (solved with `Kit.gait.reachLeg`, extracted from the gait and shared); a hand is a place relative to the
  shoulder (solved with `Kit.reach.twoBone` in the frame of the arm's parent). A `reach` pulls either to a
  world point given at call time, so `kick` and `dive` take a target and choose their side from it. A foot the
  body has been carried out of reach of hangs from the hip, which is what makes a jump and a dive leave the ground.
- **Root motion is an offset the game collects.** A `travel` carries the hips toward the point (capped in
  statures); when the one-shot ends the offset stays on the body until `takeRootMotion` hands it to the game.
  Rejected: moving `motion.x/z` from inside a stage (the caller owns position; a stage that moved it would
  fight `Kit.motion.advance`).
- **Default points are in hand-reach heights (`ActRig.high`), caps in statures.** The first version used
  statures for both: a chibi is 1.1 m tall with 0.22 m arms, so a default catch at 0.8 statures was above
  anything its hands could touch. Measured: default catch 0.25 m short before, 0.02 after.
- **Marks.** A performance names moments on its own timeline (`contact`, `land`); `play(..., { reach: { mark,
  in } })` warps only the lead-in so the mark falls on the asked moment and the rest runs as authored. Asked
  for by the football game: a single `rate` played the landing and getting up at three times speed.
- **Face frames are lazy sibling meshes.** The stamps piece carries `faces` (one shape per blink / talk state
  of `Kit.body.FRAME_SETS`); `figure.face(state)` builds a state's mesh the first time it is shown and swaps
  visibility after. Rejected: rebuilding the face geometry per blink (a bake per blink); morph targets (the
  frames differ in polygon count).
- **Loose chains are found by their stiffness hint.** `Kit.motion.loose()` simulates every bone whose hint is
  under 100 and that no gait or performance owns (hair, ears, cloaks), as `Kit.dynamics` chains on the fixed
  step, clamped to the joint's limits (the first cloak swung through the body). A catalogue opts a part in by
  data; no bone names in code.
- **Locomotion.** Torso counter-rotation, arm swing sized to the stride, toes-up only during the swing (a
  planted foot is never rotated: the first heel-strike slid the toe 7 cm and the existing plant test caught
  it), a flight parabola when no foot is planted, lean and elbow bend from the Froude number. All in tables at
  the top of kit/gait.js.
- **The Character Maker always plays `Kit.act.character()`.** One motion state per bake; the picker steers it
  (`kit/creator-perform.js`), the stage keeps the body centred with `Kit.act.keepInPlace`. Cost under software
  GL: a frame went from about 150 to about 215 ms because the figure is now re-posed every frame; the pure
  part of that is 0.4 ms.
- **Revisit if** a game needs two performances on different groups at once (today one plays over the base);
  a performance should drive a prop; faces need more than blink and talk.

### Round 2 (after the lead's review)

- **A family is several performances for one job, chosen by the point against the body's own reach.**
  `Kit.act.defineFamily({ id: 'save', forms: [{ play, aside: [from, to), up: [from, to) }] })`: spans are in
  arm spans aside and hand-reach heights up, so a short-armed body dives where a long one still catches.
  `play` takes a family wherever it takes a performance, `playing` names the form, `choose` asks beforehand.
  Every form has a `contact` mark, so one call with `reach: { mark: 'contact', in }` serves all of them.
  Rejected: branching inside the dive's keys (a performance stays one timeline); a callback per family (the
  choice stays data, checked at definition).
- **Hands lead the head, as a rule of every reach.** The dive read as a head-first torpedo because the hips
  stopped 0.8 of a reach short along the line, which leaves a bent arm beside the head, and because a chibi's
  arm (0.22 m) is shorter than its head is wide (0.40 m). Now: the dive stops 0.95 of a reach short (arms
  long); while a hand is pulled to a point, the trunk tips up and back off the line about the middle of the
  shoulders only until the head is behind the hand or clear of the line (`leadHands`, at most 1.2 rad;
  tipping further laid a chibi on its back in a high catch), the body backs off until the point is outside
  the head (`clearHead`, 1.25 head radii), and the body then closes whatever the arm still cannot reach
  (`closeHands`, at most 1.0 arm lengths; 0.6 left a short arm 0.045 m off the ball). A long-armed body
  is not touched by any of the three. Rejected: scaling the dive's keyed tilt per species (a special case per body); longer
  arms (not this module's to change).
- **A hanging leg is drawn up by its foot's keyed lift** (`hangTuck`): the same `up` that lifts a planted
  foot bends a knee in the air, so "upper leg bent, lower leg trailing" is two numbers in the dive's keys.
- **An arm moved far goes round in front** (over 1.1 rad of raise between two keys: the hand is routed
  towards straight ahead with the elbow bent); **a keyed hand stays outside the head** (moved out to the
  head's radius at its own height). Both exist because chibi arms are shorter than the head they pass.
- **A travel longer than its `stride` is run in steps**, the foot that plants taking the last; a kick's
  default ball is in leg lengths (`defaultsIn: 'legs'`).
- **A one-shot's last key is its end.** `sample` wrapped to key 0 at progress 1, so a held `sit` stood up on
  its last frame. Found on the sheet, fixed in the sampler.
- **Standing knees.** A standing body was compressed 2.5 % of its leg length (the walk's crouch), which on a
  long leg put the knee 0.14 m forward. Standing now uses `STANCE.standCrouch` (0.4 %) and blends to the
  walk's crouch with speed: 0.056 m on the elf and seraph.
- **Soft parts are a kind on the part's bones** (`Kit.body.SOFT_KINDS`: hair, plait, tail, ear, scarf, cloak,
  hem; `bone.soft`), which gives stiffness, damping and limits by default; the catalogue still may override.
  **Loose chains collide** with the ground and with the body's own solids at bone level (balls strung along
  each bone the chain is not worn round, written once a frame without allocation); a link is also pushed out
  at its middle, which is what stops a long cloak panel from cutting a corner through the trunk. Stays at
  bone level on purpose: the sculpt branch replaces rigid pieces with skinned surfaces. Rejected: clamping
  feedback into the simulation (it drove a cloak's tip underground).
- **A drag is one undo step by gesture**, pointer-down to pointer-up (`session.beginGesture` /
  `endGesture`); the 700 ms window is kept only for keyboard nudges and reads the session's injected clock,
  which the screen drives from frames (capped at 100 ms a frame).
- **A proof cell of a movement is framed by what the movement sweeps** (`Kit.body.proof.sweep`: joints over
  the whole act from that direction, plus what the rest pose's surface adds), each figure at its own scale
  standing on its cell's floor, so a diver does not spill and a hound is not a speck beside a seraph. Travel
  is a dashed line on the ground back to a cross where the body began, with the metres in the label; a ball
  is a ring. Each act names the two directions it is judged from (`ProofAct.views`). The `saves` suite shows
  the contact frame of a 5 by 3 goal of shots from behind and from the front. Rejected: letting the body run
  across a wide cell (eight phases of a 3.5 m step-and-dive make every figure a fifth of its cell).
- **Revisit if** a body needs a fin channel (the carp plays only what its head, spine and tail can do); the
  far hand of a short-armed body should also arrive (today the near hand leads and the far one follows as
  far as its arm goes); skinned cloth lands (the bone-level solids then need a surface).
## Looks and rolls: lighting, ink, pixel and roll rules that hold for any roll (looks branch)

- **Light is a key, a capped fill and a back light, in view space** (`Kit.look.LIGHTING`, mirrored in script by
  `Kit.look.lightOf`). A part's `LookPart.response` ('form' or 'face') says how much of the fill it takes: a
  face never falls wholly into the shadow band, a body keeps its form shadow. Rejected: a brighter ambient
  (flattens bodies) and blending normals towards a sphere (needs a per-vertex head centre the figure does not
  pass). Band edges are set from measured sphere shares (about 18 % shadow, 12 % highlight at three tones).
- **A ramp is sampled at `Kit.palette.TONE_POSITIONS`**, with a part's own colour in the middle at every tone
  count, and a seventh "deep" column for inner lines. Rejected: evenly spaced tones (pastel highlights, a
  black shadow on dark skins). Authored `{tones}` ramps are still resampled as before. One test changed with
  it: a five-shade ramp at five tones is no longer its five shades byte for byte.
- **Indexed rows are nine bits.** The pixel path drew every row past 255 in another ramp's colours; the row's
  high bit now rides in the tone byte and `apply` throws on a row past 511. Rejected: a second target.
- **Inner lines are a contact shadow in the part's own ramp** (deep column), silhouettes stay in ink; depth
  steps are counted in texels so line weight holds across figure sizes; class lines are drawn only when a
  texel is small enough to carry them. One `LINE_WIDTH` of 2 px serves toon and soft; the hull sits 0.012
  units back so it never draws over a near neighbour.
- **Dither fades with texel size and with curvature** (`Kit.look.ditherAt`, screen derivatives): it stays on
  broad slow gradients and leaves faces and small sprites in clean clusters.
- **Roll rules are data on the species** (`colorWeights`, `follow`, `harmony`, `contrast`, `occupies`) and one
  mechanism in kit/body-recipe.js. Colours derive from the seed alone, so a recipe is still six bytes; a
  species without rules rolls exactly as before. Followers re-follow an override. `catalog.clashes` names
  what breaks a rule, `catalog.reconcile` re-picks rolled channels against kept ones (the creator's locks).
  Rejected: storing rolled colours in the recipe (longer recipes), rejection sampling of whole individuals
  (unbounded, and locks cannot steer it). Cost: O(channels x palette x rules) per roll, a few hundred steps.
- **Revisit if** one skinned mesh carries head and body (then `response` must be per vertex or per region, not
  per mesh); a catalogue passes 511 palette rows; a contrast rule proves unsatisfiable for a palette (the roll
  falls back a tier and `clashes` reports it: 48 of 5000 wardrobe rolls miss harmony, none miss contrast).
