// Plumwick Pond: a cozy paper-and-pixel village. Trace fish at the dock, tend a tiny plot by touch, haggle at Nan's
// stall, and help her build the village up, one project at a time.
//
// DEPTH PLAN
//   Seconds (mastery): tracing is done well or badly. Accuracy sets the stars (value, clean-catch bonus, gold-star
//     records in the almanac), an unbroken streak fills the meter faster, and every species has a pattern to learn
//     (the bubbles ahead of the fish show it; a better rod shows more). The net rewards waiting for the school to
//     bunch, the lantern rewards a route past the snapper, watering and haggling reward timing.
//   Minutes (decisions, all in Cozy.rules.bitingAt): who bites depends on the hour, the water, the rod's reach and
//     the bait. Crops are bait, so every crop is a choice between coins now and the fish it draws; better watering
//     makes better bait. Nan pays double for one item that changes after each sale, so what to chase, when, with
//     which implement, and whether to sell or hold or give to a project all pull against each other. Sprats school
//     in the morning, glowfry only rise from dusk, the Deep holds rarer fish and pulls harder.
//   Hours (the long arc, PROJECTS + ACHIEVEMENTS): six town projects, each fed with specific fish, crops and coins,
//     each opening a new way to play in turn: bait, a second crop, the lantern, the Deep, the third crop, and the
//     festival after Old Mossjaw (who needs the Deep, the Heron Rod and melon bait at once). The almanac tracks all
//     eleven species and a gold-star catch of each. Pacing is simulated in scratch/cozy/pacing.js.
//
// Owns: the Kit.register call, the models (wallet, tackle + seed shop over stats, goals, saved state), soft sounds, the
//       HUD widgets, and the flow: one Kit.fsm whose states are the activities. Roaming, farming and the market live
//       here; each is a factory returning { enter, update, exit, tap?, drag?, probe? }.
// Does not own: tables and rules (cozy-data.js), the HUD's look (cozy-theme.js), the diorama (cozy-world.js) or the
//       fishing activity (cozy-fishing.js). Adding an activity is adding a factory and a row in ACTIVITIES.
(() => {
  const { ART, DAY, FISH, WATERS, BAIT, PROJECTS, ACHIEVEMENTS, TACKLE, TACKLE_BASE, CROPS, CROP_TABLE, FARM, STARS, MARKET, GOALS, CAMERA, PLOT, STALL, SPOTS, SPOT_REACH, NOTES, PALETTE } = Cozy.data;
  const { itemValue, orderName, dayAt, bitingAt, rollBite, isLanternHour, projectStatus, deliver, splitBasket, openProject, saleTotal, isRipe, cropStage, nextChore, spotInZone, spotNear } = Cozy.rules;
  const { clamp } = Kit.math;

  /**
   * @typedef {Object} SavedState  Everything about a village that is not in the wallet, shop or goals models.
   * @property {Object[]} basket   Unsold items: { kind: 'fish' | 'crop', id, stars }.
   * @property {Object<string, number>} caught  Fish id -> how many were ever caught (its keys are the collection).
   * @property {Object<string, number>} best    Fish id -> best star rating landed.
   * @property {string | null} bait  Crop id on the hook (used up by the next bite), or null.
   * @property {string} water      WATERS id the rod is cast into.
   * @property {string} gear       Tackle id in hand.
   * @property {Object<string, number>} seeds  Crop id -> seeds owned.
   * @property {string} seed       Crop id that will be planted next.
   * @property {string} order      Item id Nan pays double for.
   * @property {(Object | null)[]} plot  One entry per plot tile: { crop, stars, age, isWet } or null.
   */
  /** A new village: two beets already well grown, so the plot has something to harvest within the first minute. */
  const NEW_VILLAGE = {
    basket: [], caught: {}, best: {}, bait: null, water: 'shallows', gear: 'rod', seeds: { beet: 2 }, seed: 'beet', order: 'dapple',
    plot: [{ crop: 'beet', stars: 2, age: 38, isWet: true }, { crop: 'beet', stars: 2, age: 34, isWet: true }, null, null],
  };
  const SAVE_KEY = 'village';
  /** Village camera: how far it leans after the hero (share of the hero's offset), around a resting focus z. */
  const FOLLOW = { x: 0.25, z: 0.12, restZ: 0.6 };
  /** A drag must travel this far (px) before it steers the hero, so a shaky tap stays a tap. */
  const DRAG_STEER_PX = 18;
  /** Ripe crops wiggle this often (seconds) to ask for a harvest. */
  const RIPE_NUDGE_SECONDS = 1.2;
  /** Fill colours of the two fishing meters. */
  const METER_COLOR = { catch: '#6fd08c', line: '#ff9a6b' };
  /** Screen pixels per art pixel on the catch card: as big as fits, up to a cap. */
  const CARD_ART = { maxWidthPx: 170, maxScale: 8, starScale: 3 };
  const WHITE = '#fffaf0';
  /** A brand-new player's first bite ignores bait, water and rod: it is always a gentle morning fish. */
  const FIRST_CAST = { hour: 0, reach: 1 };
  /** Screen pixels per art pixel for icons on the paper sheets (tackle box, town plans, almanac). */
  const SHEET_ICON_SCALE = 4;

  /**
   * Soft, cozy sounds on top of the kit's synth: sines and triangles only, short and quiet.
   * @param {Object} sfx  ctx.sfx.
   * @returns {{ note: Function, chime: Function, plop: Function, step: Function }}
   */
  function createSound(sfx) {
    /** One soft note. @param {number} freq  Hz. @param {Object} [options]  Kit.sfx.tone options. */
    const note = (freq, options) => sfx.tone({ freq, dur: 0.22, type: 'sine', vol: 0.13, ...options });
    return {
      note,
      /** A little run of notes. @param {number[]} noteIndices  Indices into NOTES. @param {Object} [options] */
      chime: (noteIndices, options) => noteIndices.forEach((noteIndex, order) => note(NOTES[noteIndex], { delay: order * 0.09, ...options })),
      /** Something dropping into water. @param {number} [volume=1] */
      plop(volume = 1) {
        note(300, { to: 130, dur: 0.16, vol: 0.2 * volume });
        sfx.noise({ dur: 0.2, vol: 0.07 * volume, freq: 900, type: 'bandpass' });
      },
      /** A footstep or a soft pat. @param {number} [pitch=1] */
      step: (pitch = 1) => note(220 * pitch, { dur: 0.06, type: 'triangle', vol: 0.09 }),
    };
  }

  /**
   * Build the HUD widgets. Their look comes from cozy-theme.js; this decides what exists and what it says.
   * @param {Object} game  The shared game object (see create below); uses ctx, wallet, goals, shop, state.
   * @returns {Object} coins / basket / species stats, meters, tip, bar, shelves, gauge, card, openTackleBox, refresh.
   */
  function createHud(game) {
    const { ctx, wallet, goals, shop, state } = game;
    const { ui } = ctx;
    const coins = ui.stat('Coins', wallet.get()), basket = ui.stat('Basket', 0), species = ui.stat('Species', '');
    wallet.on(() => {
      coins.set(wallet.get());
      coins.pulse();
    });
    const checklist = ui.checklist(goals);
    // The species signboard doubles as the almanac's cover: tap it to open the book.
    species.el.classList.add('cozy-book');
    species.el.setAttribute('role', 'button');
    species.el.setAttribute('aria-label', 'Open the almanac');
    species.el.tabIndex = 0; // reachable by keyboard like any button
    species.el.addEventListener('click', () => openAlmanac());
    species.el.addEventListener('keydown', (event) => ['Enter', ' '].includes(event.key) && openAlmanac());

    // ---- fishing meters ----
    const meters = { catch: ui.progress('Catch', METER_COLOR.catch), line: ui.progress('Line', METER_COLOR.line) };
    /** Show the two meters (and tuck the goal note away, which would sit on top of the water). @param {boolean} isShown */
    meters.show = (isShown) => {
      meters.catch.el.hidden = meters.line.el.hidden = !isShown;
      checklist.el.hidden = isShown;
    };
    meters.show(false);

    // ---- one-line instruction ----
    const hint = ui.hint('');
    hint.hide();
    /** Show an instruction, or hide it with ''. @param {string} text */
    const tip = (text) => {
      if (!text) return hint.hide();
      hint.set(text);
      hint.show();
    };

    // ---- context buttons: up to SLOT_IDS.length plaques whose meaning each activity sets, plus the tackle box ----
    const SLOT_IDS = ['slot0', 'slot1', 'slot2', 'slot3', 'slot4'];
    const slotRuns = {};
    const buttons = ui.actions([...SLOT_IDS.map((id) => ({ id, label: '', onClick: () => slotRuns[id] && slotRuns[id]() })), { id: 'tackle', label: 'Tackle', onClick: () => openTackleBox() }]);
    let shownBar = null;
    /**
     * Set the context buttons.
     * @param {{ label: string, sub?: string, run: () => void }[]} list  At most as many as SLOT_IDS.
     * @param {{ showTackle?: boolean }} [options]  Also show the tackle box (while roaming).
     */
    function bar(list, { showTackle = false } = {}) {
      SLOT_IDS.forEach((id, index) => (slotRuns[id] = list[index] && list[index].run));
      const gear = game.gearRow();
      const bait = state.bait && CROP_TABLE.byId(state.bait).name;
      const key = JSON.stringify([list.map(({ label, sub }) => [label, sub]), showTackle && [gear.id, shop.level(gear.id), bait]]);
      if (key === shownBar) return; // called every frame while roaming: only touch the DOM when something changed
      shownBar = key;
      SLOT_IDS.forEach((id, index) => buttons.set(id, list[index] ? { hidden: false, label: list[index].label, sub: list[index].sub || '' } : { hidden: true }));
      buttons.set('tackle', { hidden: !showTackle, sub: game.gearTitle(gear.id) + (bait ? ` + ${bait}` : '') });
      if (showTackle) Cozy.hudParts.tackleIcon.replaceChildren(Kit.pixel.canvas(ART[gear.id], { scale: Cozy.HUD_ICON_SCALE }));
    }

    // ---- the stall's two shelves: ui.shop bars over the same upgrades model, one visible at a time ----
    const shelfRows = { tackle: TACKLE, seeds: CROPS };
    const shelfBars = Object.fromEntries(Object.entries(shelfRows).map(([name, rows]) => [name, ui.shop(shop, { wallet, ids: rows.map((row) => row.id), onBuy: game.onBuy })]));
    /** Show one shelf, or none with null. @param {'tackle' | 'seeds' | null} shown */
    const shelves = (shown) => Object.entries(shelfRows).forEach(([name, rows]) => rows.forEach((row) => shelfBars[name].bar.set(row.id, { hidden: name !== shown })));
    shelves(null);

    // ---- timing gauge shared by watering (fills up) and haggling (a needle sweeps) ----
    const gaugeBox = ui.el('div', 'cozy-gauge');
    const [goodBand, bestBand, fill, needle] = ['good', 'best', 'fill', 'needle'].map((name) => gaugeBox.appendChild(ui.h('div', name)));
    const percent = (share) => clamp(share) * 100 + '%';
    const paintBand = (element, band) => {
      element.style.left = percent(band.from);
      element.style.width = `calc(${percent(band.to)} - ${percent(band.from)})`;
    };
    const gauge = {
      /**
       * @param {Object} sweetSpot  A Kit.touch.zone with two bands: [best, good].
       * @param {{ fills?: boolean }} [options]  fills: show the level as a rising fill (watering) as well as the needle.
       */
      show(sweetSpot, { fills = false } = {}) {
        gaugeBox.hidden = false;
        paintBand(bestBand, sweetSpot.bands[0]);
        paintBand(goodBand, sweetSpot.bands[1]);
        fill.hidden = !fills;
        gauge.set(0);
      },
      /** @param {number} level  0..1 */
      set(level) {
        needle.style.left = `calc(${percent(level)} - 2px)`;
        fill.style.width = percent(level);
      },
      hide: () => (gaugeBox.hidden = true),
    };
    gauge.hide();

    // ---- paper catch card ----
    const cardWrap = ui.el('div', 'cozy-card-wrap');
    const cardBox = cardWrap.appendChild(ui.h('div', 'cozy-card'));
    const card = {
      /** @param {{ art: Object, kicker: string, title: string, stars: number, lines: string[] }} content  art: a sprite def. */
      show({ art, kicker, title, stars, lines }) {
        const picture = Kit.pixel.canvas(art, { scale: Math.min(CARD_ART.maxScale, Math.floor(CARD_ART.maxWidthPx / Kit.pixel.texture(art).frameWidth)) });
        picture.className = 'picture';
        const starRow = ui.h('div', 'stars');
        starRow.append(...[1, 2, 3].map((rank) => Kit.pixel.canvas(rank <= stars ? ART.star : ART.starDim, { scale: CARD_ART.starScale })));
        cardBox.replaceChildren(picture, ui.h('div', 'kicker', kicker), ui.h('div', 'title', title), starRow, ...lines.map((line) => ui.h('div', 'line', line)), ui.h('div', 'foot', 'Tap to continue'));
        cardWrap.hidden = false;
      },
      hide: () => (cardWrap.hidden = true),
    };
    card.hide();

    // ---- paper sheets: the tackle box, Nan's town plans and the almanac share one kind of row ----
    const heading = (text) => ui.h('h3', 'cozy-section', text);
    /**
     * One row of a sheet: an icon, a title and a line of text; a button when it can be picked.
     * @param {{ art?: Object, isUnknown?: boolean, title: string, text: string, isChosen?: boolean, isDisabled?: boolean, onPick?: () => void }} row
     *        art: a sprite def for the icon; isUnknown: draw the icon as a silhouette.
     * @returns {HTMLElement}
     */
    function sheetRow({ art, isUnknown = false, title, text, isChosen = false, isDisabled = false, onPick }) {
      const row = ui.h(onPick ? 'button' : 'div', 'cozy-row' + (isChosen ? ' chosen' : '') + (isUnknown ? ' unknown' : ''));
      if (onPick) {
        row.type = 'button';
        row.disabled = isDisabled;
        row.addEventListener('click', onPick);
      }
      const words = ui.h('div');
      words.append(ui.h('b', null, title), ui.h('span', null, text));
      row.append(...(art ? [Kit.pixel.canvas(art, { scale: SHEET_ICON_SCALE })] : []), words);
      return row;
    }
    /** Open a sheet whose rows are rebuilt after every pick, so it always shows the current choice. */
    const openSheet = (title, listRows) => ui.panel({
      title,
      build(body) {
        const render = () => body.replaceChildren(...listRows(render));
        render();
      },
    });
    const cropsInBasket = () => CROPS.map((crop) => ({ crop, count: state.basket.filter((item) => item.id === crop.id).length })).filter(({ count }) => count > 0);
    /** What a bait draws, naming only the fish the player has already met. */
    function baitHint(crop) {
      const fans = FISH.filter((fish) => fish.likes === crop.id), known = fans.filter((fish) => state.caught[fish.id]);
      if (!known.length) return 'Something out there loves it';
      return `Draws ${known.map((fish) => fish.name).join(', ')}${known.length < fans.length ? ' and others' : ''}`;
    }

    /** The tackle box: which implement, which bait, which water. Each is a decision about the next cast. */
    function openTackleBox() {
      openSheet('Tackle box', (render) => {
        const pick = (choose) => () => {
          choose();
          render();
        };
        const implementRows = TACKLE.map((row) => sheetRow({
          art: ART[row.id], title: game.gearTitle(row.id), isChosen: row.id === state.gear, isDisabled: !game.ownsTackle(row.id),
          text: game.ownsTackle(row.id) ? row.how : shop.unlocked(row.id) ? `Nan sells it at the stall for ${shop.cost(row.id)}` : 'Nan cannot stock it yet',
          onPick: pick(() => game.chooseTackle(row.id)),
        }));
        const baitRows = !game.isBuilt(BAIT.requires) ? [] : [
          heading('Bait: a crop from your basket, used up by the next bite'),
          sheetRow({ title: 'No bait', text: 'Whatever is about', isChosen: !state.bait, onPick: pick(() => game.chooseBait(null)) }),
          ...cropsInBasket().map(({ crop, count }) => sheetRow({ art: ART[crop.id], title: `${crop.full} x${count}`, text: baitHint(crop), isChosen: state.bait === crop.id, onPick: pick(() => game.chooseBait(crop.id)) })),
        ];
        const openWaters = WATERS.filter((water) => !water.requires || game.isBuilt(water.requires));
        const waterRows = openWaters.length < 2 ? [] : [
          heading('Water'),
          ...openWaters.map((water) => sheetRow({ title: water.name, text: water.blurb, isChosen: state.water === water.id, onPick: pick(() => game.chooseWater(water.id)) })),
        ];
        return [heading('Implement'), ...implementRows, ...baitRows, ...waterRows];
      });
    }

    /** Nan's town plans: what the next project needs, and what each one opened. @returns {Promise} Resolves when the sheet is closed. */
    function openTown() {
      return openSheet('Town plans', (render) => PROJECTS.map((project) => {
        if (game.isBuilt(project.id)) return sheetRow({ art: ART[project.prop[0]], title: `${project.name} (built)`, text: project.opens, isChosen: true });
        if (!shop.unlocked(project.id)) return sheetRow({ title: '???', text: `After the ${shop.table.byId(project.requires).name}` });
        const status = projectStatus(project, state.basket, wallet.get());
        const needs = [...status.lines.map((line) => `${orderName(line.id)} ${line.have}/${line.need}`), ...(project.coins ? [`${project.coins} coins`] : [])];
        return sheetRow({
          art: ART[project.prop[0]], title: project.name, text: `Needs ${needs.join(', ')}. ${project.opens}`, isDisabled: !status.isReady,
          onPick() {
            game.buildProject(project);
            render();
          },
        });
      }));
    }

    /** The almanac: every species, where and when it bites, what it likes once met, and the lifetime achievements. */
    function openAlmanac() {
      const phaseNames = ([from, until]) => (until - from >= DAY.phases.length ? 'All day' : DAY.phases.slice(from, until).map((phase) => phase.name).join(', '));
      const haunt = (fish) => (fish.via ? `With the ${shop.table.byId(fish.via).title(1)}` : `${phaseNames(fish.hours)} in ${WATERS.byId(fish.water).name}`);
      const taste = (fish) => (fish.likes ? `. Likes ${CROP_TABLE.byId(fish.likes).full}` : '');
      openSheet('Almanac', () => [
        heading(`Species ${game.speciesCount()}/${FISH.length}`),
        ...FISH.map((fish) => {
          const isCaught = !!state.caught[fish.id];
          return sheetRow({
            art: ART[fish.id], isUnknown: !isCaught, title: isCaught ? `${fish.name} - ${STARS.name[state.best[fish.id] || 1]}` : '???',
            text: isCaught ? `${haunt(fish)}${taste(fish)}. Caught ${state.caught[fish.id]}` : haunt(fish),
          });
        }),
        heading('Achievements'),
        ...game.profile.achievements().map(({ row, progress, done }) => sheetRow({ title: row.text, text: done ? `Done: +${row.reward} coins` : `${progress}/${row.target}`, isChosen: done })),
      ]);
    }

    return {
      coins, basket, species, meters, tip, bar, shelves, gauge, card, openTown,
      /** Bring the stats in line with the state. */
      refresh() {
        basket.set(state.basket.length);
        species.set(`${game.speciesCount()}/${FISH.length}`);
      },
    };
  }

  /**
   * Roaming the village: tap or drag to walk; tapping an activity's zone walks to its spot and starts it.
   * @param {Object} game
   */
  function createRoam(game) {
    const { ctx, world, hud, sound } = game;
    /** The spot the hero is walking to because the player tapped its zone. */
    let destination = null;
    const heroSpot = (reach) => spotNear(world.hero.root.position.x, world.hero.root.position.z, reach);
    return {
      enter() {
        destination = null;
        world.haltHero();
        if (!game.speciesCount()) hud.tip('Tap the dock to go fishing');
      },
      tap(event) {
        const ground = ctx.input.ground(0, event.nx, event.ny);
        if (!ground) return;
        hud.tip('');
        destination = spotInZone(ground.x, ground.z) || null;
        if (destination) world.walkTo(...destination.at);
        else world.walkTo(ground.x, ground.z);
        const target = world.walkTarget();
        ctx.fx.ring({ x: target.x, y: 0.05, z: target.z }, { size: 0.7, color: 0xfffaf0, life: 0.4 });
        sound.step(1.6);
        if (destination && heroSpot(SPOT_REACH.arrive) === destination) game.go(destination.id); // already standing there
      },
      drag(event) {
        if (event.phase !== 'move' || ctx.input.pointer.moved < DRAG_STEER_PX) return;
        const ground = ctx.input.ground(0, event.nx, event.ny);
        if (!ground) return;
        destination = null;
        world.walkTo(ground.x, ground.z);
        hud.tip('');
      },
      update(dt) {
        const { isMoving, didStep } = world.updateHero(dt);
        if (didStep) sound.step(ctx.math.rand(0.9, 1.1));
        const hero = world.hero.root.position;
        world.frame(hero.x * FOLLOW.x, FOLLOW.restZ + hero.z * FOLLOW.z, CAMERA.villageWidth);
        const nearby = heroSpot(SPOT_REACH.button);
        hud.bar(nearby ? [{ label: nearby.verb, run: () => game.go(nearby.id) }] : [], { showTackle: true });
        if (!destination || isMoving) return;
        const arrivedAt = destination;
        destination = null;
        if (heroSpot(SPOT_REACH.arrive) === arrivedAt) game.go(arrivedAt.id);
      },
    };
  }

  /**
   * Farming: each chore is a small touch. Harvest by tapping the ripe ones, plant by swiping seeds along the row,
   * water by holding and letting go in the sweet spot (which sets the crop's star quality).
   * @param {Object} game
   */
  function createFarm(game) {
    const { ctx, world, hud, sound, state, goals } = game;
    const { fx, math } = ctx;
    const spot = SPOTS.find((each) => each.id === 'farm');
    const pourLevel = Kit.curve.of([[0, 0], [FARM.pourSeconds, 1]]);
    /** The watering in progress: its sweet spot and how long the player has held. */
    let pour = { sweetSpot: null, heldSeconds: 0, isPouring: false };
    let plantedThisSwipe = 0, harvestCombo = 0, pauseSeconds = 0;

    /** Index of the tile under a ground point, or -1. `reach` is how far from the row (in z) still counts. */
    const tileAt = (ground, reach) => (ground && Math.abs(ground.z - PLOT.z) < reach ? PLOT.tilesX.findIndex((x) => Math.abs(ground.x - x) < FARM.tileHalfWidth) : -1);
    const ownedSeeds = () => CROPS.filter((crop) => state.seeds[crop.id] > 0);
    /** Make sure the seed in hand is one the player has; false when the pouch is empty. */
    const hasSeedInHand = () => {
      if (!state.seeds[state.seed] && ownedSeeds().length) state.seed = ownedSeeds()[0].id;
      return state.seeds[state.seed] > 0;
    };
    const showBar = () => hud.bar([{ label: 'Leave', run: game.toVillage }, { label: 'Seed', sub: `${CROP_TABLE.byId(state.seed).full} x${state.seeds[state.seed] || 0}`, run: pickNextSeed }]);
    function pickNextSeed() {
      const owned = ownedSeeds();
      if (owned.length) state.seed = owned[(owned.findIndex((crop) => crop.id === state.seed) + 1) % owned.length].id;
      sound.step(1.4);
      showBar();
    }
    const decide = () => chores.go(nextChore(state.plot, hasSeedInHand()));
    const rest = (seconds) => chores.go('pause', seconds);

    function harvest(index) {
      const tile = state.plot[index], crop = CROP_TABLE.byId(tile.crop);
      state.basket.push({ kind: 'crop', id: tile.crop, stars: tile.stars });
      state.plot[index] = null;
      world.plot.popOut(index);
      world.sparkle(world.plot.positionOf(index), 12, [PALETTE.g, PALETTE.y, PALETTE.p], { speed: 3 });
      fx.floater(`${STARS.name[tile.stars]} ${crop.full}`, world.plot.positionOf(index), { color: STARS.ink[tile.stars], size: 16 });
      sound.note(NOTES[Math.min(NOTES.length - 1, 2 + harvestCombo++)], { dur: 0.25 }); // each pop in a row rings a step higher
      game.save(hud.basket);
      goals.track('harvest', 1, { crop, stars: tile.stars });
      if (!state.plot.some(isRipe)) rest(0.7);
    }

    function plant(index) {
      state.plot[index] = { crop: state.seed, stars: 1, age: 0, isWet: false };
      state.seeds[state.seed]--;
      plantedThisSwipe++;
      fx.burst({ ...world.plot.positionOf(index), y: 0.7 }, { count: 7, colors: [PALETTE.m, PALETTE.l, PALETTE.y], speed: 1.5, life: 0.5, size: 0.07, floor: 0.13 });
      sound.note(NOTES[Math.min(NOTES.length - 1, plantedThisSwipe + 1)], { dur: 0.12, type: 'triangle' });
      showBar();
    }

    /** Let go of the watering can: the level against the sweet spot sets the star quality of every dry tile. */
    function releasePour() {
      const level = pourLevel(pour.heldSeconds), isFlooded = level >= 1;
      const stars = isFlooded ? 1 : pour.sweetSpot.grade(level);
      state.plot.forEach((tile, index) => {
        if (!tile || tile.isWet) return;
        Object.assign(tile, { isWet: true, stars });
        fx.ring({ ...world.plot.positionOf(index), y: 0.14 }, { size: 0.9, color: 0xaee6f0, life: 0.5 });
      });
      fx.floater(isFlooded ? FARM.floodedText : FARM.pourGrades[stars], world.plot.positionOf(1), { color: STARS.ink[stars] });
      sound.chime(FARM.pourChimes[stars]);
      game.save();
      rest(1);
    }

    function drip() {
      if (!chores.is('water') || !pour.isPouring) return;
      const dryTiles = PLOT.tilesX.map((_, index) => index).filter((index) => state.plot[index] && !state.plot[index].isWet);
      if (!dryTiles.length) return;
      const index = math.pick(dryTiles);
      fx.burst({ x: PLOT.tilesX[index] + math.rand(-0.3, 0.3), y: 1.3, z: PLOT.z }, { count: 2, colors: [PALETTE.a, PALETTE.b], speed: 0.6, up: 0, gravity: 9, life: 0.5, size: 0.08, floor: 0.13 });
      sound.note(300 + 500 * pourLevel(pour.heldSeconds), { dur: 0.06, vol: 0.05 }); // the pitch rises as the can empties
    }
    ctx.every(0.07, drip);

    const chores = Kit.fsm({
      off: { enter: () => hud.gauge.hide() },
      harvest: { enter: () => hud.tip('Tap the ripe crops to pop them') },
      plant: {
        enter() {
          plantedThisSwipe = 0;
          hud.tip('Swipe along the row to scatter seeds');
        },
      },
      water: {
        enter() {
          const { range, bands } = FARM.sweetSpot;
          pour = { sweetSpot: Kit.touch.zone(math.rand(...range), bands), heldSeconds: 0, isPouring: false };
          hud.gauge.show(pour.sweetSpot, { fills: true });
          hud.tip('Hold to pour. Let go in the green');
        },
        update(dt) {
          if (!pour.isPouring) return;
          pour.heldSeconds += dt;
          hud.gauge.set(pourLevel(pour.heldSeconds));
          if (pourLevel(pour.heldSeconds) >= 1) releasePour(); // the can ran dry: the plot is flooded
        },
        exit: () => game.later(0.6, hud.gauge.hide), // leave the result on the gauge for a moment
      },
      pause: {
        enter: (seconds) => (pauseSeconds = seconds),
        update(dt, seconds) {
          if (seconds > pauseSeconds) decide();
        },
      },
      idle: {
        enter: () => hud.tip(state.plot.some(Boolean) ? 'Growing nicely. Back soon' : 'Out of seeds. Nan sells them'),
        update(dt, seconds) {
          if (seconds > 1.8) game.toVillage();
        },
      },
    }, 'off');

    return {
      probe: () => ({
        step: chores.state, level: pourLevel(pour.heldSeconds), zone: pour.sweetSpot ? pour.sweetSpot.centre : 0,
        tiles: PLOT.tilesX.map((x, index) => ({ ...world.toScreen({ x, y: 0.3, z: PLOT.z }), ripe: isRipe(state.plot[index]) })),
      }),
      enter() {
        world.frame(...spot.view.focus, spot.view.width);
        world.hero.face(-1);
        harvestCombo = 0;
        decide();
        showBar();
      },
      tap(event) {
        if (!chores.is('harvest')) return;
        const index = tileAt(ctx.input.ground(0.3, event.nx, event.ny), FARM.tapReach.harvest);
        if (index < 0 || !state.plot[index]) return;
        if (isRipe(state.plot[index])) return harvest(index);
        world.plot.refuse(index);
        sound.step(0.8);
        fx.floater('Not ripe', world.plot.positionOf(index), { color: WHITE, size: 14 });
      },
      drag(event) {
        if (chores.is('water')) {
          if (event.phase === 'start') {
            pour.isPouring = true;
            hud.tip('');
          } else if (event.phase === 'end' && pour.isPouring) releasePour();
          return;
        }
        if (!chores.is('plant')) return;
        if (event.phase === 'end') {
          if (plantedThisSwipe > 1) fx.floater('Neat row', world.plot.positionOf(1), { color: WHITE });
          if (plantedThisSwipe) decide();
          return;
        }
        const index = tileAt(ctx.input.ground(0.1, event.nx, event.ny), FARM.tapReach.plant);
        if (index >= 0 && !state.plot[index] && hasSeedInHand()) plant(index);
      },
      update: (dt) => chores.update(dt),
      exit: () => chores.go('off'),
    };
  }

  /**
   * The market: selling is a haggle (stop the sweeping needle in the green for the best price); the same stall
   * sells tackle and seeds from two ui.shop shelves.
   * @param {Object} game
   */
  function createMarket(game) {
    const { ctx, world, hud, sound, state, wallet, goals } = game;
    const { fx, math } = ctx;
    const spot = SPOTS.find((each) => each.id === 'market');
    const { stats } = game;
    /** What would be sold now and what is held back for the open town project or as bait. */
    const counter = () => splitBasket(state.basket, openProject(game.isBuilt), state.bait);
    const worthOf = (items) => items.reduce((sum, item) => sum + itemValue(item, state.order), 0);
    /** The haggle in progress: the needle's motion, where it is now, and the sweet spot. */
    let haggle = { needleAt: () => 0, needle: 0, sweetSpot: null };
    let lastSale = 0;

    function showCounter(text) {
      hud.shelves(null);
      hud.tip(text);
      const { toSell, kept } = counter();
      const sell = { label: 'Sell', sub: `${toSell.length} for ~${worthOf(toSell)}${kept.length ? `, ${kept.length} kept` : ''}`, run: () => stall.go('haggle') };
      hud.bar([...(toSell.length ? [sell] : []), { label: 'Tackle', run: () => browse('tackle', 'New tackle changes how you fish') }, { label: 'Seeds', run: () => browse('seeds', `Seed packets: ${FARM.seedsPerPacket} seeds each`) }, { label: 'Town', run: () => hud.openTown().then(() => showCounter('')) }, { label: 'Leave', run: game.toVillage }]);
    }
    function browse(shelf, text) {
      hud.shelves(shelf);
      hud.tip(text);
      hud.bar([{ label: 'Back', run: () => showCounter('') }]);
    }

    /** Close the deal at wherever the needle stopped. */
    function sell() {
      const grade = haggle.sweetSpot.grade(haggle.needle), deal = MARKET.haggle[grade];
      const { toSell, kept } = counter();
      const total = saleTotal(toSell, state.order, grade, stats.get('sale'));
      const sale = { total, hadGoldCrop: toSell.some((item) => item.kind === 'crop' && item.stars === 3), hadOrder: toSell.some((item) => item.id === state.order) };
      state.basket = kept; // what the town plan needs and the chosen bait stay in the basket
      state.order = math.pick(MARKET.orders.filter((id) => id !== state.order)); // Nan wants something else next time
      world.orderSign.show(state.order);
      world.greet();
      const coinAt = { x: STALL.x, y: 1.1, z: STALL.z + 0.4 };
      [0, 1, 2, 3, 4].forEach((order) => game.later(order * 0.09, () => {
        sound.note(NOTES[3 + order], { dur: 0.14, vol: 0.1 });
        world.sparkle(coinAt, 5, [PALETTE.y, PALETTE.Y], { speed: 3 });
      }));
      fx.floater('+' + total, { x: STALL.x, y: 1.6, z: STALL.z }, { size: 30 });
      hud.tip(deal.text);
      wallet.add(total);
      lastSale = total;
      game.save(hud.basket);
      goals.track('sell', 1, sale);
    }

    const stall = Kit.fsm({
      off: {
        enter() {
          hud.gauge.hide();
          hud.shelves(null);
        },
      },
      counter: { enter: (text) => showCounter(text === undefined ? `Nan pays double for ${orderName(state.order)} today` : text) },
      haggle: {
        enter() {
          const { range, bands } = MARKET.sweetSpot;
          haggle = { needleAt: Kit.touch.sweep(MARKET.needleCyclesPerSecond, math.rand()), needle: 0, sweetSpot: Kit.touch.zone(math.rand(...range), bands) };
          hud.gauge.show(haggle.sweetSpot);
          hud.tip('Tap to stop the needle in the green');
          hud.bar([]);
        },
        update(dt, seconds) {
          haggle.needle = haggle.needleAt(seconds);
          hud.gauge.set(haggle.needle);
        },
      },
      sold: {
        enter: sell,
        update(dt, seconds) {
          if (seconds <= MARKET.soldSeconds) return;
          hud.gauge.hide();
          stall.go('counter', `Sold for ${lastSale} coins`);
        },
      },
    }, 'off');

    return {
      probe: () => ({ step: stall.state, needle: haggle.needle, zone: haggle.sweetSpot ? haggle.sweetSpot.centre : 0 }),
      enter() {
        world.frame(...spot.view.focus, spot.view.width);
        world.hero.face(1);
        world.greet();
        sound.chime([4, 5], { vol: 0.08 });
        stall.go('counter');
      },
      tap() {
        if (stall.is('haggle')) stall.go('sold');
      },
      update: (dt) => stall.update(dt),
      exit: () => stall.go('off'),
    };
  }

  /** The activities of the game's flow, by state name. Each factory gets the shared game object. */
  const ACTIVITIES = { roam: createRoam, fish: (game) => Cozy.createFishing(game), farm: createFarm, market: createMarket };

  Kit.register({
    id: 'cozy', name: 'Plumwick Pond', tagline: 'Trace fish, tend crops, haggle', hook: 'New tackle changes how you fish', color: '#8fd14f', order: 6,
    theme: Cozy.theme,
    create(ctx) {
      const { ui } = ctx;
      ctx.post.bloom(0); // matte paper: nothing should glow
      ctx.post.vignette(0.12);

      // ---------- models ----------
      const wallet = Kit.wallet({ coins: 5 }, ctx.save);
      const stats = Kit.stats(TACKLE_BASE);
      const shop = Kit.upgrades([...TACKLE, ...CROPS, ...PROJECTS], { stats, wallet, save: ctx.save }); // projects gate shop rows through `requires`
      const sound = createSound(ctx.sfx);
      const goals = Kit.goals(GOALS, {
        save: ctx.save,
        onDone(goal) {
          wallet.add(goal.reward);
          ui.toast(`Goal done  +${goal.reward}`);
          sound.chime([2, 4, 5, 7]);
        },
      });
      const profile = Kit.profile({
        save: ctx.save,
        achievements: ACHIEVEMENTS,
        onAchievement(row) {
          wallet.add(row.reward);
          ui.toast(`${row.text}  +${row.reward}`);
          sound.chime([2, 4, 5, 7]);
        },
      });
      /** @type {SavedState} */
      const state = { ...JSON.parse(JSON.stringify(NEW_VILLAGE)), ...ctx.save.get(SAVE_KEY, {}) };

      const world = Cozy.createWorld(ctx);
      world.orderSign.show(state.order);
      PROJECTS.filter((project) => shop.level(project.id) > 0).forEach((project) => world.addProp(...project.prop));

      // ---------- the shared game object: what every activity factory receives ----------
      let flow = null, flowEpoch = 0;
      const game = {
        ctx, world, sound, wallet, stats, shop, goals, profile, state,
        /** Test and tuning switches: forceFish (a fish id) makes every rod bite that species; forceHour (0..4) pins the hour fish go by. */
        debug: { forceFish: null, forceHour: null },
        speciesCount: () => Object.keys(state.caught).length,
        /** The hour of the village day, 0..4 (see Cozy.rules.dayAt). */
        hour: () => (game.debug.forceHour === null ? dayAt(ctx.time).hour : game.debug.forceHour),
        gearRow: () => shop.table.byId(state.gear),
        gearTitle: (id) => shop.table.byId(id).title(shop.level(id)),
        ownsTackle: (id) => id === 'rod' || shop.level(id) > 0,
        /** Has a town project been finished? @param {string} id  A PROJECTS id. */
        isBuilt: (id) => shop.level(id) > 0,
        /** The crop on the hook: the best-starred copy of the chosen bait in the basket, or null. */
        baitItem: () => state.basket.filter((item) => item.kind === 'crop' && item.id === state.bait).sort((a, b) => b.stars - a.stars)[0] || null,
        /** The decisions behind the next rod cast (see Cozy.rules.bitingAt). */
        cast: () => ({ hour: game.hour(), reach: stats.get('reach'), water: state.water, bait: game.baitItem() }),
        /** Why fishing cannot start right now, as a line for the player, or null when it can. */
        castProblem() {
          const { mode } = game.gearRow();
          if (mode === 'lantern' && !isLanternHour(game.hour())) return 'The glowfry only rise from dusk. Come back later';
          const isRodWithNoBites = mode === 'trace' && game.speciesCount() > 0 && !bitingAt(game.cast()).length;
          return isRodWithNoBites ? `Nothing in ${WATERS.byId(state.water).name} will take a ${game.gearTitle('rod')} right now` : null;
        },
        /** Roll the fish that just bit, and use up the bait that drew it. @returns {Object} A FISH row. */
        hookFish() {
          if (game.debug.forceFish) return FISH.byId(game.debug.forceFish);
          const cast = game.speciesCount() ? game.cast() : FIRST_CAST;
          if (cast.bait) {
            state.basket.splice(state.basket.indexOf(cast.bait), 1);
            if (!game.baitItem()) state.bait = null; // that was the last one
            game.save(hud.basket);
          }
          // The hour may have turned between the cast and the bite; if nothing fits any more, a first-cast fish bites.
          return rollBite(cast) || rollBite(FIRST_CAST);
        },
        /**
         * Enter a catch in the records (collection, best stars, lifetime achievements).
         * @returns {{ isNew: boolean, isBest: boolean }} First of its species; or a new personal best for a known one.
         */
        recordCatch(fish, count, stars) {
          const isNew = !state.caught[fish.id], previousBest = state.best[fish.id] || 0;
          state.caught[fish.id] = (state.caught[fish.id] || 0) + count;
          state.best[fish.id] = Math.max(previousBest, stars);
          if (isNew) profile.count('species');
          if (stars === 3 && previousBest < 3) profile.count('goldSpecies');
          return { isNew, isBest: !isNew && stars > previousBest };
        },
        chooseBait(cropId) {
          state.bait = cropId;
          sound.step(1.4);
          game.afterTackleChange();
        },
        chooseWater(waterId) {
          state.water = waterId;
          sound.plop(0.6);
          game.afterTackleChange();
        },
        /** A choice in the tackle box changed what can bite: persist it and update the board on the shore. */
        afterTackleChange() {
          refreshBiteBoard();
          game.save();
        },
        /** Hand Nan what a project needs: it is built, and whatever it opens is open from now on. */
        buildProject(project) {
          state.basket = deliver(project, state.basket);
          wallet.spend(project.coins);
          shop.grant(project.id);
          profile.count('projects');
          goals.track('project', 1, project);
          world.addProp(...project.prop, true);
          world.greet();
          ui.toast(`${project.name} built`);
          sound.chime([0, 2, 4, 7]);
          game.afterTackleChange();
        },
        /** Take an owned implement in hand. */

        chooseTackle(id) {
          state.gear = id;
          sound.chime([3]);
          hud.tip(`${game.gearTitle(id)}: ${shop.table.byId(id).how}`);
          game.afterTackleChange();
        },
        /** Switch activity. @param {string} name  A key of ACTIVITIES. */
        go(name) {
          flowEpoch++;
          hud.tip('');
          hud.bar([]);
          flow.go(name);
        },
        toVillage: () => game.go('roam'),
        /** Run something after a delay unless the player has moved on to another activity by then. */
        later(seconds, run) {
          const startedIn = flowEpoch;
          ctx.after(seconds, () => startedIn === flowEpoch && run());
        },
        /** Persist the state and refresh the stats. @param {Object} [changedStat]  A ui.stat to pulse. */
        save(changedStat) {
          hud.refresh();
          if (changedStat) changedStat.pulse();
          ctx.save.set(SAVE_KEY, state);
        },
        /** After the stall sells something: tackle goes straight in hand, seed packets into the pouch. */
        onBuy(row) {
          sound.chime([2, 4, 5, 7]);
          world.greet();
          world.sparkle({ x: STALL.x, y: 1.2, z: STALL.z + 0.3 }, 14, [PALETTE.y, PALETTE.w], { speed: 3 });
          goals.track('buy', 1, { id: row.id });
          if (CROP_TABLE.has(row.id)) {
            state.seeds[row.id] = (state.seeds[row.id] || 0) + FARM.seedsPerPacket;
            state.seed = row.id;
            hud.tip(`${FARM.seedsPerPacket} ${row.full} seeds. Plant them at the plot`);
          } else {
            state.gear = row.id;
            hud.tip(`${game.gearTitle(row.id)}: ${row.how}`);
          }
          refreshBiteBoard(); // a better rod reaches deeper fish
          game.save();
        },
      };
      const hud = (game.hud = createHud(game));

      // ---------- the day: which fish bite follows the hour ----------
      let shownPhase = null;
      function refreshBiteBoard() {
        world.biteBoard.show(bitingAt(game.cast()).map((bite) => bite.fish));
      }
      function followDay(day) {
        if (day.phase === shownPhase) return;
        const isFirstLook = shownPhase === null;
        shownPhase = day.phase;
        refreshBiteBoard();
        if (!isFirstLook && flow.is('roam')) ui.toast(day.phase.name);
      }

      // ---------- crops grow whatever the player is doing ----------
      function growPlot(dt) {
        state.plot.forEach((tile, index) => {
          if (tile && tile.isWet) tile.age += dt;
          const grew = world.plot.show(index, cropStage(tile), !!tile && tile.isWet);
          if (!grew || !isRipe(tile)) return;
          sound.chime([5, 7], { vol: 0.08 });
          world.sparkle(world.plot.positionOf(index), 8, [PALETTE.y, PALETTE.w]);
        });
        world.setRipe(state.plot.some(isRipe));
      }
      ctx.every(RIPE_NUDGE_SECONDS, () => state.plot.forEach((tile, index) => isRipe(tile) && world.plot.nudge(index)));

      // ---------- flow ----------
      const activities = Object.fromEntries(Object.entries(ACTIVITIES).map(([name, create]) => [name, create(game)]));
      flow = Kit.fsm(activities);
      const routeToActivity = (handler) => (event) => activities[flow.state][handler] && activities[flow.state][handler](event);
      ctx.input.onTap(routeToActivity('tap'));
      ctx.input.onDrag(routeToActivity('drag'));
      /** Hook for scripted playtests (scratch/cozy/play.js): drive and inspect the live game. */
      ctx.cozy = { state, go: game.go, wallet, shop, goals, profile, buildProject: game.buildProject, debug: game.debug, probe: () => ({ scene: flow.state, hero: world.toScreen(world.hero.root.position), ...(activities[flow.state].probe ? activities[flow.state].probe() : {}) }) };
      game.save();
      game.go('roam');
      world.updateCamera(1); // settle the camera before the first frame

      return {
        update(dt, time) {
          const day = dayAt(time);
          followDay(day);
          growPlot(dt);
          flow.update(dt);
          world.update(dt, time, { day, showMarkers: flow.is('roam') });
          world.updateCamera(dt);
        },
      };
    },
  });
})();
