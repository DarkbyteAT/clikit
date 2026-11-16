# The kit

One global, `Kit`, built from small pieces that each do one thing, are useful alone and only look
down the layers. Classic scripts, no build step, loaded in the order at the end of this page.
The principles and the code standard are in `../AGENTS.md`; this page is the map.

## Layers

```
games/*.js                    data tables + the code unique to one game
adapters                      model in, view out; redraw themselves on change
compositions                  models built from other models
models        presentation    plain data and maths  |  DOM, WebGL, WebAudio
primitives                    math, bus, pool, slot ring, clock, store, registry
```

"Pure" below means no DOM, THREE or cannon: the file runs in node and is unit-tested by
`tools/test-kit.js`. Everything else is exercised by `tools/smoke.js`.

### Primitives

| File | Owns |
|---|---|
| `core.js` | pure. `Kit.math` (clamp, wrap, lerp, damp, easing, random helpers, `randomTools`, `sampleWeighted`, `rateLimiter`), `Kit.fmt` / `fmtTime`, `Kit.bus`, `Kit.pool`, `Kit.slotRing`, `Kit.clock` (game-time timers and tweens), `Kit.store`, `Kit.register` / `checkGame`, `Kit.warn` / `expectType` |

### Models (pure)

| File | Owns |
|---|---|
| `model.js` | `Kit.curve` (numbers from data), `Kit.table` (rows by id), `Kit.stats` (base + keyed modifiers, cached), `Kit.wallet`, `Kit.persist` (load / save / notify plumbing); also the compositions `Kit.upgrades` and `Kit.goals` |
| `flow.js` | `Kit.fsm`, `Kit.spawnTable`, `Kit.path` (composable `(t, out?) => { x, y }` motion), `Kit.envelope` |
| `space.js` | `Kit.grid` (cells, neighbours, ray, flood, shortest path, text levels), `Kit.line` (polyline length / at / measured / resample / simplify / nearest / lasso), `Kit.history` (undo / redo) |
| `span.js` | `Kit.span`: one-dimensional extents (edges, overlap, slice, wrap) |
| `blend.js` | `Kit.blend`: in-between colours and table rows |
| `hash.js` | `Kit.spatialHash`: "what is near this point" without all-pairs |
| `timer.js` | `Kit.timer`: countdowns and repeating timers as plain data |
| `lanes.js` | `Kit.lanes`: can a player get through rows of lanes |
| `music.js` | `Kit.music`: note names, MIDI numbers, scales to frequencies |
| `ballistics.js` | `Kit.ballistics`: aim vectors, trajectory traces, blast falloff |
| `dice.js` | `Kit.dice`: dice notation to a structured, reproducible roll |
| `sight.js` | `Kit.sight` (field of view, line of sight), `Kit.measure` (grid distances, cheapest routes) |
| `net.js` | `Kit.net.session` (shared key -> value state over any transport, events, presence, rate-limited outbox), `Kit.net.loopback` |
| `net-trust.js` | `Kit.net.guarded` (drop malformed and impossible-version messages), `Kit.net.withSender` (stamp senders locally), `Kit.net.checked` (hold your own writes to the table's rule), `Kit.net.remember` (keep a loopback table in storage), `Kit.net.isSaneEntry` |
| `net-claude.js` | `Kit.net.open` (join a shared table in one call: hosted when the platform is there, single-player otherwise), `Kit.net.claude` (the hosted transport: room + database + user), `Kit.net.claude.capabilities` (what to publish with) |
| `dice.js` | `Kit.dice` (parse / roll / range / describe / check: notation such as `4d6kh3`, `d20 adv`, `3d6!`; seeded, every die listed) |
| `sight.js` | `Kit.sight` (field of view by symmetric shadowcasting, line of sight), `Kit.measure` (distance rules, routes through terrain, area templates, labels) |
| `tabletop.js` | `Kit.tabletop` (a shared tabletop as plain data over `Kit.net` keys: key scheme, value cleaning, who-may-change-what rules, `seat`, boards and fog, turn order, ink packing, scenes and travel, harm) |
| `net-trust.js` | decorators that make a transport safer to listen to (`guarded`, `withSender`, `checked`, `remember`) |
| `net-claude.js` | the hosted page's transport for `Kit.net` (room + shared database); owned by the multiplayer agent |
| `scrub.js` | `Kit.scrub`: drive a CSS animation from the game clock |

### Generic subsystems behind `Kit.body` (pure; none knows about bodies)

| File | Owns |
|---|---|
| `lineage.js` | `Kit.lineage`: definitions that inherit (parent chain, traits merged in order, limits enforced on everything below) |
| `flags.js` | `Kit.flags`: up to 32 named flags in one number; requirements with counts; a failure names what is missing |
| `columns.js` | `Kit.columns`: records as typed-array columns with a free list and generations |
| `seeded.js` | `Kit.seeded`: values from (seed, field name), not a stream, so adding a field never re-rolls old ones; a 53-bit content hash |
| `pack.js` | `Kit.pack`: records as bytes (varint, uint32, text) and bytes as a URL-safe code |
| `palette.js` | `Kit.palette`: colour ramps (shades dark to light with a hue drift) as data; `tones` (2-6 perceptually even tones plus ink, OKLCH), named `SETS`, and `atlas`, the packed tone x ramp table the look shaders read |
| `surface.js` | `Kit.surface`: signed distance to a primitive (capsule, sphere, box, lathe, extrude); azimuth / elevation -> surface point, normal and up; along / around coordinates |
| `region.js` | `Kit.region`: areas of a surface as predicate trees (band, stripe, checker, edge, facing; union, intersect, mask, not) and the topmost layer at a point |
| `look-settings.js` | `Kit.look`: tone bands, ordered-dither table, texel-grid helpers, welded outline normals, and the look presets and knobs as data |
| `rig.js` | `Kit.rig`: a joint hierarchy as flat arrays and the one forward pass that places it in the world |
| `reach.js` | `Kit.reach`: inverse kinematics over a rig (exact two-bone, FABRIK chain, aim, joint limits) |
| `dynamics.js` | `Kit.dynamics`: a damped spring and a point chain on a fixed clock (the same at 20 and 60 fps) |

### Movement (pure): stages that compose, over the body system

| File | Owns |
|---|---|
| `motion.js` | `Kit.motion`: a stage is `step` (fixed 120 Hz clock) + `pose` (once a frame), both `(motion, plan, dt)`; combinators `sequence`, `blend`, `layer`, `when`, `byDetail`; `refusal` (what a plan lacks); the per-instance motion `state` that owns the pose buffers; `advance` / `advanceStore`; shared stages `lean` and `trail`; `course` / `drive` |
| `gait.js` | `Kit.gait`: walking, trotting and running for any leg count: stride from the Froude number, the `GAITS` table, feet planted in the world and solved by `Kit.reach`, `plant` (full), `swing` (detail 1), `arms`, the ready `walk`; `feet` / `support` to read the result |
| `swim.js` | `Kit.swim`: a travelling wave down a spine-and-tail chain, beat and swing from speed (`STYLES`: carangiform, serpentine), `fins`, the ready `swim` |
| `gait-gallery.js` | the `gaits` screen: four bodies on courses moved by one controller, with footprint and centre-of-mass marks |

### `Kit.body` (pure): a thing is a graph of typed sockets filled by parts, described by a small recipe

| File | Owns |
|---|---|
| `body-plan.js` | `Kit.body.plan`: bones, sockets, roles, capabilities, joint limits, mass, shapes, paint channels; `dials` / `applyDials`; `requireFit` |
| `body-parts.js` | `Kit.body.part` / `assemble`: parts plug into typed sockets and may expose their own; the result is an ordinary plan |
| `body-surface.js` | `Kit.body.surfaceLayout` / `surfaceOf`: features placed on bones by azimuth and elevation, painted regions, `regionAt` |
| `body-recipe.js` | `Kit.body.catalog`: species over `Kit.lineage`; `resolve`, `validate`, `normalize`, `encode` / `decode`, `hash`, `table`, `bakery` |
| `body-edit.js` | `Kit.body.editor`: a schema of every dial, colour and socket; pure edits; what changed between two bakes |
| `body-store.js` | `Kit.body.store`: instances as columns (position, heading, phase, detail, recipe index) |
| `sculpt-relief.js` | `Kit.sculpt.relief`: a base solid with marks pressed on (a nose) or in (an eye socket), as one solid; `smoothMax` |
| `body-face.js` | `Kit.body.face`: a face as relief, as data: `anchors`, style tables `NOSES` and `EARS`, builders for a nose, ears, brow ridge, cheeks, chin, lips, eye sockets, plain eyes, mouth and nose pad |
| `body-hair.js` | `Kit.body.hair.on(head)`: hair primitives as bone rows (mass, lock, fringe, parting, bun, tail, braid, sideburns, fall), placed by azimuth and rise on a head |
| `body-samples.js` | `Kit.body.samples`: a biped, a quadruped, a fish, four parts and a family of species, as data |
| `body-wardrobe.js` | `Kit.body.wardrobe`: an original humanoid catalogue for a character creator (46 dials, 14 colour channels, 21 sockets, 4 species), as data |
| `body-debug.js` | `Kit.body.debug`: a stick figure with socket markers on any 2D context (runs in node with a recorder) |
| `body-sheet.js` | needs a browser. The `wardrobe` screen (`Kit.play('wardrobe')`): rolled wardrobe characters (the first is the base person at default dials) drawn in 3D by `Kit.figure`, faces through `Kit.body.figureHooks`; tap to roll more |
| `body-gallery.js` | needs a browser. The `bodies` screen (`Kit.play('bodies')`) |

```js
const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);          // plans + parts + palettes + species
const recipe = catalog.table([{ species: 'human' }]).roll(worldSeed, 12);   // { species, seed, overrides }
const bake = catalog.bakery().bakeRecipe(recipe);                     // assembled plan + proportioned rest pose, cached by look
const pose = Kit.rig.copy(bake.rest, Kit.body.createPose(bake.plan)), world = Kit.body.createPose(bake.plan);
Kit.body.worldTransforms(bake.plan, pose, world, x, 0, z, heading);   // one pass, no allocation
Kit.pack.toText(catalog.encode(recipe));                              // an 8-character share code
```

### Compositions (pure)

| File | Owns |
|---|---|
| `loot.js` | `Kit.rng` (seedable), `Kit.stats.power` / `merge`, `Kit.loot` (base x rarity x affixes -> item), `Kit.inventory` (bag + slots feeding `Kit.stats`) |
| `meta.js` | `Kit.profile` (progression across runs: lifetime stats, unlocks, achievements, account level), `Kit.synergy` (set bonuses) |
| `craft.js` | skill-tree layout, slot reels, pity rolls, comparison lines, `Kit.loot.augment` |
| `loadout.js` | `Kit.loadout`: slots filled from a collection under a point budget |
| `crowd.js` | flow fields, grid sliding, buckets and pooled views for many walkers on a `Kit.grid` |
| `route.js` | `Kit.route` (a stroke becomes a clean route between anchors), `Kit.follow` (travel along it) |
| `puzzle.js` | `Kit.beam` (light over a grid), `Kit.search` (fewest-moves solver, generate-and-verify), `Kit.levels` |
| `place.js` | `Kit.placement`: drag-from-tray-to-grid as a pure state machine (plus one THREE helper) |
| `touch.js` | finger-skill models: trace, stroke, lasso, zone, sweep, walker |
| `tabletop.js` | the rules of a shared tabletop as data over `Kit.net` keys |

### Presentation (needs a browser)

| File | Owns |
|---|---|
| `input.js` | `Kit.input(ctx)`: tap / swipe / drag, the virtual stick, pointer-to-world picking |
| `fx.js` | `Kit.fx(ctx)`: particles, rings, frames, pops, shake, flash, floaters, hitstop, slow motion |
| `sfx.js` | `Kit.sfx`: WebAudio synth, preset table, mute, haptic buzz |
| `make.js` | `Kit.make(ctx)`: linear-colour materials, shapes, instancing, batches, canvas textures, stage (sky, fog, lights), glow, frame, dots |
| `theme.js` | `Kit.theme`: design tokens, skins, fonts and scoped CSS so each game's HUD is its own |
| `ui.js` | `Kit.ui(ctx)`: stat, pips, progress, actions, toast, hint, modals (choose, banner, panel); adapters `shop`, `offer`, `checklist` |
| `post.js` | `Kit.post(renderer)`: HDR bloom, vignette, exposure, ACES tone mapping, with a plain fallback |
| `physics.js` | `Kit.physics(options)`: cannon.js world, fixed timestep, mesh syncing, hits, blasts |
| `bodies.js` | compound bodies, per-step rules, collision layers, sensors and surfaces for `Kit.physics` |
| `pixel.js` | `Kit.pixel`: pixel art as data, baked to paper cut-out sprites |
| `look-toon.js` | `Kit.look.shading`: palette texture, toon material (bands, dither, rim, glint, emissive) and inverted-hull outline for any mesh, skinned or instanced |
| `look-ink.js` | `Kit.look.inkPass`: low-resolution index target, one-texel screen-space ink, whole-number upscale |
| `look-view.js` | `Kit.look.view`: composes the above per preset (toon, pixel, soft toon); texel snapping, dither anchoring, slow-device fallback |
| `look-panel.js` | `Kit.look.panel`: the look's controls as shared components (preset, knobs, palette rows, the panel sheet) and `lookControls(view)` |
| `look-show.js` | the `look` screen (`Kit.play('look')`): two stand-in figures, every knob, and on-request measurements |
| `figure-shapes.js` | pure. `Kit.figure` shape builders (capsule, sphere, box, lathe, extrude) to plain arrays per level of detail, `shapeKey`, `writeBoneMatrix` |
| `figure-layout.js` | pure. `Kit.figure.layout` (bake -> pieces with ramps and ink groups), `planUpdate` (what an edit changes), `measureRest` / `fitView` (grounding, framing) |
| `figure.js` | `Kit.figure.build` (a bake drawn through `Kit.look`, posed in one pass, updated incrementally), `geometryCache`, `crowd` (instanced, one bake) |
| `figure-show.js` | the `figures` screen (`Kit.play('figures')`): the body samples in 3D, live edits, a debug pose and the binding probe |

### Component library (`kit/ui/`, needs a browser)

Preact + htm + signals over native elements (see "UI components" in `../DECISIONS.md`). A component is a function
from props to an `html` template; any prop may be a plain value or a signal. Build new interface from these, never
from hand-rolled scroll areas or click-only divs. See them all in every state under every skin: `Kit.play('gallery')`.

```js
const { html, signal, bind, ScrollPane, Card, Meter } = Kit.ui;
const heat = signal(0);                                   // or: bind(wallet, (wallet) => wallet.get())
ctx.ui.mount(html`<${Meter} label="Heat" value=${heat} />`);   // removed with the HUD when the game ends
heat.value = 0.7;                                         // writes one style property; no re-render
const pick = await ctx.ui.dialog({ title: 'Bait', variant: 'sheet', body: (close) => html`...` });   // pauses the game
```

| File | Owns |
|---|---|
| `ui/logic.js` | pure. `Kit.uiLogic`: notice queue, roving focus, selection, row search, popover placement |
| `ui/core.js` | `Kit.ui.html`, `signal` / `computed` / `effect` / `batch`, `bind` (Kit model in, signal out), `mount`, `css`, the `--ui-*` tokens |
| `ui/scroll.js` | `ScrollPane`, `scrollable(element)`: native scrolling, contained overscroll, snap, fade edges, keyboard, safe area |
| `ui/button.js` | `Button`: variants; pressed, disabled and busy states |
| `ui/layout.js` | `Stack` (container-query row), `Cluster`, `Empty` |
| `ui/meter.js` | `Meter`, `Progress`, `Stat`, `Pips` |
| `ui/tabs.js` | `Tabs` |
| `ui/collection.js` | `Card`, `List`, `Grid` (single and multiple selection) |
| `ui/field.js` | `TextField`, `Toggle`, `Slider` |
| `ui/dialog.js` | `Dialog`, `Sheet`, `openDialog` (native `<dialog>`: focus trap, Escape, backdrop, focus returned) |
| `ui/notice.js` | `notify` (toast queue), `announce` (banner queue) |
| `ui/popover.js` | `Popover`, `Tooltip` |
| `ui/gallery.js` | the component gallery screen |
| `ui/menu.js` | loaded after the shell: the main menu's search field and scrolling list of cards |

Checks: `bun tools/test-ui.js` (behaviour in a real browser: finger drags, focus, keys, 44px targets) and
`bun tools/touch-scroll.js <selector>` ("this element scrolls under a real touch drag"; `--self-test` proves the check).

### Character creator (`Kit.creator`, the `creator` screen: "Character Maker")

A character editor generated from `Kit.body.editor(catalog).schema(recipe)`: nothing in it names a body part. Pure
pieces first (unit-tested by `tools/test-creator.js`), then components (`tools/test-creator-ui.js` drives them in a browser).

| File | Owns |
|---|---|
| `creator-rows.js` | pure. `Kit.creator.rows`: schema -> tab groups of rows (a sided pair is one row), values by key, `structureKey`, readouts, swatch gradients, double-tap rule |
| `creator-session.js` | pure. `Kit.creator.session`: recipe, undo history (a drag is one step), locks, linked pairs, randomise all / one group, mirror, body-type switch that keeps what fits, share codes with plain-words errors (`parseShareCode`) |
| `creator-slots.js` | pure. `Kit.creator.slots(store)`: named saved characters as share codes; `chipColors` |
| `creator-camera.js` | pure. `Kit.creator.camera`: the director (focus a group, zoom, turn, ease), `boundsFor` (stand the body in a screen area), pinch and drag maths |
| `creator-icons.js` | `Kit.creator.ICONS` / `Icon`: line icons as data |
| `creator-controls.js` | `controlHost` (a signal per field, queued slider values), `DialControl`, `ColorControl`, `SocketControl`, `GroupPane`, `ControlTabs` |
| `creator-stage.js` | `StageGestures` (drag, pinch, wheel, keys), `StageRails`, `StageTitle`, `LookChips`, `HoldButton` |
| `creator-panels.js` | the Setup tab, the saved-characters sheet and the share dialog |
| `creator-theme.js` | `Kit.creator.THEME`: the screen's own tokens, fonts and scoped CSS |
| `creator.js` | the screen: composes the above, draws the figure with the fewest changes, keeps a draft |

### Adapters and shell

| File | Owns |
|---|---|
| `views.js` | `Kit.views`: skill tree, inventory, reel, achievement and synergy screens generated from models |
| `dev.js` | `Kit.debug`, development checks and the developer overlay |
| `shell.js` | loaded last: renderer, frame loop, the `ctx` each game gets, launch / restart / exit, quality governor, menu |

## Script load order

A file may only use what is loaded before it. The order in `index.html` is:

```
preact  hooks  htm  signals-core  signals   (CDN; the component library's runtime)
core  model  meta  flow  lanes  scrub  span  blend  space  hash  music  place  puzzle  route  timer
loot  crowd  craft  net  net-trust  net-claude  dice  sight  tabletop
input  fx  sfx  make  theme  ui  ui/logic  ui/core  ui/scroll  ui/button  ui/layout  ui/meter  ui/tabs  ui/collection  ui/field
ui/dialog  ui/notice  ui/popover  views  post  ballistics  loadout  physics  bodies  touch  pixel  dev
lineage  flags  columns  seeded  pack  palette  surface  region  rig  reach  dynamics
body-plan  body-parts  body-surface  body-recipe  body-edit  body-store  body-face  body-hair  body-samples  body-wardrobe  body-debug  body-gallery
look-settings  look-toon  look-ink  look-view  look-panel  look-show  figure-shapes  figure-layout  figure  figure-show  body-sheet
creator-rows  creator-session  creator-slots  creator-camera  creator-icons  creator-controls  creator-stage  creator-panels  creator-theme  creator
games/*.js  ui/gallery
shell
ui/menu
```

(`index.html` is the source of truth; if the two disagree, fix this page.)

## What a game gets

`Kit.register({ id, name, tagline, hook, color, order, theme, create(ctx) })`, where `create`
returns `{ update(dt, t), dispose?(), render?(renderer, ctx) }` (a game that returns `render` draws its own
frame and bypasses the post chain; `Kit.look.view` needs that to put exact palette colours on screen). `ctx` carries `scene`, `camera`, `size`, `input`, `fx`,
`sfx`, `ui`, `make`, `post`, `save`, `theme`, `math`, `fmt`, game-time `after` / `every` / `tween`,
`ortho()`, `distanceForWidth()`, `restart()` and `exit()`. `tools/example-game.js` uses all of it.

## Adding a module

1. Decide the layer. A new file knows nothing about the layers above it.
2. Create `kit/<name>.js` as an IIFE that adds to `Kit`. Open it with a header that says what it
   owns and what it does not. Tunables are named constants at the top.
3. Every shared function gets JSDoc: purpose, `@param` / `@returns` with types and units,
   `@example` where the call shape is not obvious, `@complexity` when the cost grows with
   entities, cells, rows or messages, and a `@typedef` for each row or option shape.
4. Validate at the entry: throw an `Error` that names the function, the cause and the fix.
5. Add one `<script src="kit/<name>.js">` to `index.html`, after everything the file uses.
6. Pure module: load it in `tools/test-kit.js`
   (`vm.runInContext(fs.readFileSync(...), sandbox, { filename })`) and add `test('name', () => { ... })`
   cases for the edges (empty input, zero length, limits), not only the happy path. Objects from
   the sandbox are from another realm: compare with `JSON.stringify` or field by field.
7. Run `make test` (or `node tools/test-kit.js`), then `node tools/smoke.js menu` and the smoke
   of any game the change could touch.
8. Add a line to this page, and to `../DECISIONS.md` if you chose between real alternatives.

## Changing an existing module

Other agents edit these files at the same time. Re-read the region just before you edit, add
rather than rewrite, keep every public name, signature and default, and never reformat lines you
did not write.

Helpers worth knowing before you write your own: `Kit.math.wrap`, `Kit.math.randomTools(random)`,
`Kit.persist.load` / `tracker` (saved state plus a change event), `Kit.stats.normalize` /
`mapSpec`, `Kit.slotRing` (a per-frame pass over only the slots in use), `Kit.line.measured`
(O(log n) lookups along a fixed line) and `Kit.ui.h` (make an element).
