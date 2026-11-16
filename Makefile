# Routine jobs, one target each. `make help` lists them.
# Runtime: Bun when present (faster start, built-in test runner and bundler), otherwise Node. See DECISIONS.md.
RUN  := $(shell command -v bun >/dev/null 2>&1 && echo bun || echo node)
GAME ?= menu
SECS ?= 8

.PHONY: help test smoke check lint docs sheet bench release clean new-game new-module remove-game play skins gallery sim types tags format metrics setup worktree land worktrees

help: ## List every target
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-11s %s\n", $$1, $$2}'

setup: ## Install the dev tools the checks use (Biome, TypeScript); the page itself needs nothing
	@npm install --no-audit --no-fund

test: ## Unit tests for the pure kit modules and for the dev tools
	@$(RUN) tools/test-kit.js && $(RUN) tools/test-dev.js

smoke: ## Play one game headlessly: make smoke GAME=miner SECS=10
	@$(RUN) tools/smoke.js $(GAME) --secs $(SECS)

check: ## Everything that must be green, as one table: make check [ONLY="miner runner"] [FAST=1]
	@$(RUN) tools/dev.js check $(ONLY) $(if $(FAST),--fast)

lint: ## Code-standard lint: make lint [FILES="games/miner.js"] [SUMMARY=1]
	@$(RUN) tools/dev.js lint $(FILES) $(if $(SUMMARY),--summary)

types: ## tsc --checkJs over the JSDoc, held to a per-file baseline: make types [FILES=games/miner.js]
	@$(RUN) tools/dev.js types $(FILES)

tags: ## Compare index.html script tags with kit/ and games/: make tags [FIX=1]
	@$(RUN) tools/dev.js tags $(if $(FIX),--fix)

format: ## Format the files you own with Biome: make format FILES="games/miner.js"
	@$(RUN) tools/dev.js format $(FILES)

new-game: ## Scaffold a game that meets the standard: make new-game ID=sky-garden [SKIN=paper]
	@$(RUN) tools/dev.js new game $(ID) $(if $(SKIN),--skin $(SKIN))

new-module: ## Scaffold a pure kit module with its test and tag: make new-module NAME=waves
	@$(RUN) tools/dev.js new module $(NAME)

remove-game: ## Undo a scaffolded game that was never made real: make remove-game ID=sky-garden
	@$(RUN) tools/dev.js remove game $(ID)

play: ## Scripted playtest: make play GAME=miner [SCRIPT=scratch/miner/play.json] [LANDSCAPE=1] [SKIN=neon]
	@$(RUN) tools/dev.js play $(GAME) --script $(or $(SCRIPT),scratch/$(GAME)/play.json) $(if $(LANDSCAPE),--landscape) $(if $(SKIN),--skin $(SKIN))

skins: ## One game under every kit skin into shots/skins-<id>.png: make skins GAME=miner
	@$(RUN) tools/dev.js skins $(GAME)

gallery: ## Photograph the component gallery screen under every skin (once kit/ui/ registers it)
	@$(RUN) tools/dev.js gallery

sim: ## Simulate a game's long arc from its headless model: make sim GAME=miner [HOURS=2] [POLICY=greedy,saver]
	@$(RUN) tools/sim.js $(GAME) --hours $(or $(HOURS),2) $(if $(POLICY),--policy $(POLICY))

metrics: ## Token totals per tier from METRICS.md; add a row with: make metrics ARGS='--work "..." --model sonnet --tokens 40k'
	@$(RUN) tools/dev.js metrics $(ARGS)

docs: ## Regenerate kit/API.md from the docstrings (tools/dev.js)
	@$(RUN) tools/dev.js docs

sheet: ## Contact sheet of every game into shots/ (tools/dev.js)
	@$(RUN) tools/dev.js sheet

bench: ## Micro-benchmarks for kit hot paths (tools/bench.js)
	@$(RUN) tools/bench.js

release: ## Freeze the tree, verify the frozen copy, stage what passes in ../release
	@$(RUN) tools/release.js

clean: ## Remove generated screenshots and the staged release
	@rm -rf shots/*.png ../release

# --- Version control: one branch and one worktree per piece of work -------------------------------
WORKTREES := $(abspath ../worktrees)

worktree: ## Start a piece of work in its own checkout: make worktree NAME=miner-depth
	@test -n "$(NAME)" || { echo "usage: make worktree NAME=<branch>"; exit 2; }
	@git worktree add -q "$(WORKTREES)/$(NAME)" -b "$(NAME)" main
	@ln -sfn "$(CURDIR)/node_modules" "$(WORKTREES)/$(NAME)/node_modules"
	@echo "$(WORKTREES)/$(NAME)  (branch $(NAME), from main)"

worktrees: ## List the checkouts and their branches
	@git worktree list

land: ## Merge a finished branch into main after its checks pass there: make land NAME=miner-depth
	@test -n "$(NAME)" || { echo "usage: make land NAME=<branch>"; exit 2; }
	@$(MAKE) -C "$(WORKTREES)/$(NAME)" test
	@git merge --no-ff --no-edit "$(NAME)"
	@git worktree remove "$(WORKTREES)/$(NAME)" && git branch -d "$(NAME)"
