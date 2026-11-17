# Plan: __NAME__ (`__ID__`)

The plan for this game. Write every piece down before starting; prefer more,
smaller pieces. A piece that cannot be described in a few lines is split again or kept by the lead.

## Depth plan (copied into the header of games/__ID__.js)

- Seconds (mastery):
- Minutes (decisions):
- Hours (the long arc):

## Pieces

| # | Piece (one output) | Inputs | Writable paths | Tier | Effort | Why this tier | Acceptance check | Tokens | Rework |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Rules: pure round simulation and its tables | this plan's depth plan | games/__ID__.js (RULES section) | sonnet | medium | well-specified pure functions | unit test added to tools/test-kit.js fails if a rule is wrong | | |
| 2 | Headless model `headless.progression` | piece 1 | games/__ID__.js (HEADLESS section) | opus | medium | balance tuning by simulation | `node tools/sim.js __ID__ --hours 3` prints no warning | | |
| 3 | Theme CSS and HUD components | written design below | games/__ID__.js (THEME) | sonnet | low | theme from a written design | `node tools/dev.js skins __ID__` reviewed by the lead | | |
| 4 | Scene and feel | pieces 1 and 3 | games/__ID__.js (GAME section) | fable | medium | visual design and layout | lead plays `node tools/dev.js play __ID__ --script scratch/__ID__/play.json` and reads the shots | | |
| 5 | Docstrings and lint fixes | the finished file | games/__ID__.js | haiku | low | mechanical | `node tools/dev.js lint games/__ID__.js` prints 0 findings | | |

## Review log

One line per return: accepted, or what was wrong and where it went next (same tier with an amended brief;
up one tier on the same miss twice).

## Done

- [ ] `node tools/dev.js check __ID__` prints CHECK OK
- [ ] every piece's tier, effort and tokens recorded: `node tools/dev.js metrics --work "__NAME__: <piece>" --model <tier> --tokens <n> ...`
