# clikit

A framework of small, well-scoped pieces that click together into web games and tools.

Each piece does one thing, is useful alone, and only depends on the pieces below it. Layers stack: plain
data models and maths at the bottom, then compositions of them, then views that draw a model and keep
themselves in sync. You take the layers you need and leave the rest.

## What is in it

| Area | Examples |
|---|---|
| Primitives | maths and easing, event bus, pools, game clock, storage |
| Models | curves, tables, stats, wallets, grids and paths, dice, line of sight and distance, state machines |
| Multiplayer | shared key-value state over any transport, trust wrappers, an in-memory transport for tests |
| Compositions | upgrades, loot and inventory, loadouts, crowds, puzzles, shared-tabletop rules |
| Bodies and motion | body plans, rigs, inverse kinematics, gaits, performances, sculpted and toon-shaded figures |
| Interface | a component library on native HTML (scroll panes, dialogs, tabs, lists, fields), themes, HUD |
| Presentation | input, effects, sound, materials, post-processing, physics |

`kit/README.md` is the map of every module. `kit/API.md` is the generated reference.

## Using it

The kit is plain JavaScript with no runtime dependencies and no build step. Every file adds to one global,
`Kit`, and may use only what was loaded before it.

- **In a page:** load `kit/core.js`, then the modules you want, in the order given in `kit/README.md`.
- **Without a browser:** modules marked pure in `kit/README.md` need no DOM. Evaluate them in order with
  `Kit` in scope, as `tools/test-kit.js` does, and call them from a server, a test or a simulation.

```js
const net = Kit.net.session(transport, { validate });   // shared state over a transport of your choice
net.set('token/t1', { x: 3, y: 4 });
const roll = Kit.dice.roll(Kit.dice.parse('4d6kh3'), Kit.rng(seed));
```

The kit assumes no host. Networking goes through a transport interface; write one for your own server, or
use the ones provided.

## The demo games

`games/` and `index.html` are demos that prove and exercise the kit. They are not the product. Their guide
is `games/README.md`.

## Working on clikit

```
make setup    # install the dev tools (Biome, TypeScript)
make test     # unit tests for the pure modules
make check    # everything that must be green, as one table
make help     # every routine job, with an example
```

`AGENTS.md` holds the principles and the code standard. `DECISIONS.md` records why things are the way they
are; `METRICS.md` records what each piece of work cost.
