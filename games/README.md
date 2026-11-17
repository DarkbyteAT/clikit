# The demo games

The games here, and the page that lists them (`../index.html`), exist to prove the kit and to exercise it.
This guide is for building them. None of it binds a project that imports the kit.

## What a demo game is for

A game is proof that the kit works. Its file should be mostly data tables plus the code that is unique to that
game; anything another game could use belongs in the kit. Only what was asked for is offered to players: a
development view of a module (a gallery, a test sheet) registers with `kind: 'workbench'`, so tools open it by
id and the menu never lists it (`?workbench` on the address shows them).

## What a demo game must be

- **Phone-first and immediately playable.** It opens on something you can play at once, with one thumb, and
  still works in landscape, with a mouse and with a keyboard.
- **Fun, judged by the experience.** Not by a checklist of effects, a passing smoke run or a good screenshot.
  2D and 2.5D are welcome where they suit the game. Familiar genres are fine when made better or combined in
  new ways.
- **Its own thing.** Mechanics, tempo, feedback and interface come from the game's own fiction. Every game sets
  a `theme` and goes beyond picking a skin; effects are used where they suit the game and left out where they
  do not.
- **Deep at three timescales**, stated in the file header and real in play:
  - *Seconds (mastery):* the basic action can be done well or badly, and skill shows.
  - *Minutes (decisions):* choices with trade-offs and systems that interact, so two runs and two players end
    up with different builds.
  - *Hours (the long arc):* progression that changes how you play, not only bigger numbers.
  Check pacing by simulating the game's pure rules over hours of play, not by asserting it. Add a rule that
  interacts before you add a row that does not.
- **Broad inside a reasoned scope.** Rich content through data rows is welcome. Systems nobody asked for are not.

## Headless model

A game exposes its pure rules and data as `headless` on its `Kit.register` call (read with
`Kit.headlessOf(id)`). Nothing in it may need THREE or the DOM at load time. To be simulated it adds
`headless.progression`, four functions over its own state: `createState()`, `actions(state)` (rows of
`{ id, kind: 'play' | 'buy' | 'unlock', cost?, affordable? }`), `apply(state, action, random)` (returns
`{ seconds, state?, unlocked? }`) and `summary(state)` (`{ currency, owned, remaining }`).
`make sim GAME=<id>` then plays it with bot policies and reports time to each purchase and unlock, when the
player runs out of new things, dead stretches and runaway growth. `node tools/dev.js new game <id>` scaffolds
one.

## A game is done when

- `node tools/dev.js check <id>` prints CHECK OK.
- You looked at screenshots of the states you changed, including one landscape view
  (`node tools/dev.js play <id> --script <file> [--landscape]`).
- Appearance changes are judged on coverage, not on one view of one character: every option of what you
  touched, every look, dial extremes, several random rolls, at rest and in motion.
- It has its own `theme` and does not look like its neighbours.
- Its header states its depth at seconds, minutes and hours, and `make sim GAME=<id>` shows the long arc
  without dead-stretch or runaway warnings (or you say why not).
- Generic pieces are in the kit, not in the game.

## Measures that have been mistaken for the goal

| The measure | What it was standing in for |
|---|---|
| The smoke test prints OK | The game is fun and fair for a person at 60 fps |
| A screenshot looks good | It feels good in motion, with sound, under a thumb |
| A scripted bot finished the level | A human finds the difficulty right |
| Bloom, shake and particles on every action | The game has its own feel |
| "At least N" rows in a table | Content that is varied and well tuned |
| Every game uses every kit model | The right tool was chosen for the job |
| An upgrade table and a best score | Depth: decisions, interacting systems and a long arc |
| One fun minute | A game worth returning to |

## Where the demo page is served

The demo page is currently published as a claude.ai Artifact. There, scripts load only from an allowed CDN
list, fonts only from Google Fonts, and other network access, WebRTC and WebSockets are blocked. So the demo's
multiplayer runs over that platform's live room and shared database (`kit/net-claude.js`), which is one
transport among several possible. A release is built from a frozen, verified copy (`make release`).
