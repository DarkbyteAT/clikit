/**
 * Kit ui: the HUD, built from a few primitives.
 *
 * Owns:  HUD widgets (stat, pips, progress, actions, toast, hint, el), modals that pause the game
 *        (choose, banner, panel) and the adapters that draw a Kit model (shop and offer for
 *        Kit.upgrades, checklist for Kit.goals). Everything it adds is removed by `dispose()`,
 *        which the shell calls when the game exits or restarts.
 *        It is also the compatibility layer over the component library in kit/ui/: every call above keeps its
 *        name, its return value and its markup (game themes style `.stat`, `.action`, `#modal .modal-card`,
 *        `.sheet-body` ...), while the modal host is now a native <dialog>, the sheet body is the kit's scroll
 *        pane, and `mount` / `dialog` / `html` open the library to a game. New views should be components.
 * Does not own: how the HUD looks (the base stylesheet in index.html and the game's theme, see
 *        theme.js; a theme may also rebuild a component through `theme.components`), the models
 *        themselves (model.js) or canvas input (input.js).
 *
 * Needs the DOM, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  /** Default lifetime of a toast, milliseconds; matches the `toast` CSS animation in index.html. */
  const DEFAULT_TOAST_MS = 1300;
  const MS_PER_SECOND = 1000;
  /** Tick shown beside a finished goal in a checklist. */
  const CHECK_MARK = '✓';

  /**
   * Makes an element.
   * @param {string} tag
   * @param {?string} [className]
   * @param {string|number} [text] text content (never parsed as HTML)
   * @returns {HTMLElement}
   * @example ui.h('div', 'card-title', 'Backpack')
   */
  const h = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  /** HUD text for a value: numbers go through Kit.fmt ("1.23K"), anything else is shown as given. */
  const formatValue = (value) => (typeof value === 'number' ? Kit.fmt(value) : value);

  /** Restarts a CSS animation that is triggered by a class: remove it, force a reflow so the removal registers, add it back. */
  const restartAnimation = (element, className) => {
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  };

  /** Label slug for a data attribute: "Fire Rate" -> "fire-rate". */
  const slugOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  /** How each field of an `actions().set(id, patch)` patch is applied to a button's parts. */
  const ACTION_PATCHERS = {
    label: (parts, value) => (parts.label.textContent = value),
    sub: (parts, value) => (parts.sub.textContent = value),
    disabled: (parts, value) => (parts.button.disabled = value),
    hidden: (parts, value) => (parts.button.hidden = value),
  };

  /**
   * @typedef {Object} ActionSpec
   * @property {string} id
   * @property {string} label main line of the button
   * @property {string} [sub] small second line (a price, a cooldown)
   * @property {function(string): void} [onClick] called with the id
   */

  /**
   * @typedef {Object} ChoiceOption
   * @property {string} title
   * @property {string} [desc]
   * @property {string} [tag] small badge ("New", "Lv 3")
   * @property {string} [color] CSS colour of the option's accent
   */

  /**
   * Creates the HUD for a game. The shell does this and exposes it as `ctx.ui`.
   * @param {Object} ctx the shell context (uses paused, tween, theme)
   * @returns {Object} `{ stat, pips, progress, actions, choose, banner, panel, toast, hint, el, shop, offer, checklist, h, dispose }`
   * @example
   * const score = ui.stat('Score', 0); score.set(1250); score.pulse();
   * const hint = ui.hint('Drag to move'); input.onDrag(() => hint.hide());
   * ui.banner({ title: 'Run over', stats: [['Score', 1250]] }).then(() => ctx.restart());
   */
  Kit.ui = (ctx) => {
    const statsRow = document.getElementById('stats');
    const hudLayer = document.getElementById('hud-layer');
    const actionBar = document.getElementById('actions');
    const modal = /** @type {HTMLDialogElement} */ (document.getElementById('modal'));
    /** Every element this HUD added, so dispose() can take them all away. */
    const ownedElements = [];

    /**
     * Ask the active theme for a custom build of a component.
     * @param {string} name   'stat' | 'pips' | 'progress' | 'action' (see each call site for the parts passed).
     * @param {Object} parts  The live elements the kit keeps updating, plus `h` to make more.
     * @returns {HTMLElement|null} The theme's element, or null to use the kit's default markup.
     */
    const component = (name, parts) => {
      const build = ctx.theme && ctx.theme.components && ctx.theme.components[name];
      return build ? build({ ...parts, h }) : null;
    };

    /** Remembers an element for dispose() and returns it. */
    const track = (element) => {
      ownedElements.push(element);
      return element;
    };

    /** Wraps a button handler: the click stays out of the game's input, and every button makes the same click sound. */
    const withClickSound = (handler) => (event) => {
      event.stopPropagation();
      Kit.sfx.play('click');
      handler(event);
    };

    /** A `<button type="button">` wired to a handler. */
    const button = (className, text, handler) => {
      const element = /** @type {HTMLButtonElement} */ (h('button', className, text));
      element.type = 'button';
      element.addEventListener('click', withClickSound(handler));
      return element;
    };

    // ---- widgets ----

    /**
     * A labelled value in the top row.
     * @param {string} label keep it short: the row must fit a 390px phone
     * @param {number|string} [value=0] numbers are formatted with Kit.fmt
     * @returns {{el: HTMLElement, set: function((number|string)): void, pulse: function(): void}} `pulse` plays a brief pop
     */
    function stat(label, value = 0) {
      const valueElement = h('b', null, formatValue(value));
      // A theme may rebuild the stat (theme.components.stat) as long as it places `value`, which set() keeps updating.
      const box = track(component('stat', { label, value: valueElement }) || h('div', 'stat'));
      if (!box.contains(valueElement)) box.append(h('span', null, label), valueElement);
      statsRow.appendChild(box);
      // The last text written, kept here: reading it back from the DOM every frame cost about twenty times more
      // than this comparison (see "UI components" in DECISIONS.md).
      let shownText = valueElement.textContent;
      return {
        el: box,
        set(nextValue) {
          const text = String(formatValue(nextValue));
          // Games call set() every frame; only touch the DOM when the text really changed.
          if (text === shownText) return;
          shownText = text;
          valueElement.textContent = text;
        },
        pulse: () => restartAnimation(box, 'pulse'),
      };
    }

    /**
     * A stat drawn as a row of tokens instead of a number: hearts, ammo, shots in a rack, flags left to capture.
     * Markup: div.stat.pips[data-pips="<label slug>"] > span (label) + div.pip-row > i.pip (with .on on the filled ones).
     * The default look is small dots. Restyle `.pip` / `.pip.on` from the game's theme css (key on data-pips to style each
     * row differently), or rebuild the box with theme.components.pips({ label, row, h }): keep `row`, set() fills it.
     * @param {string} label
     * @param {{ total?: number, filled?: number }} [initial]
     * @returns {{ el: HTMLElement, set(filled: number, total?: number): void, pulse(): void }}
     * @example const lives = ui.pips('Lives', { total: 3 }); lives.set(2); lives.pulse();
     */
    function pips(label, { total = 0, filled = total } = {}) {
      const row = h('div', 'pip-row');
      const box = track(component('pips', { label, row }) || h('div', 'stat pips'));
      if (!box.contains(row)) box.append(h('span', null, label), row);
      box.dataset.pips = slugOf(label);
      statsRow.appendChild(box);
      let size = 0;
      const api = {
        el: box,
        set(nextFilled, nextTotal = size) {
          size = nextTotal;
          // Grow or shrink to the new total, then repaint: existing tokens are reused so CSS transitions can run.
          while (row.children.length < size) row.appendChild(h('i', 'pip'));
          while (row.children.length > size) row.lastChild.remove();
          [...row.children].forEach((pip, index) => pip.classList.toggle('on', index < nextFilled));
        },
        pulse: () => restartAnimation(box, 'pulse'),
      };
      api.set(filled, total);
      return api;
    }

    /**
     * A slim bar under the stats row.
     * A theme may rebuild the bar (theme.components.progress({ fill, label })) as long as it places both live elements;
     * `fill` is sized as a percentage of its parent, so wrap it in a track element to inset the bar.
     * @param {string} [label='']
     * @param {string} [color] CSS colour of the fill
     * @returns {{el: HTMLElement, set: function(number): void, label: function(string): void, color: function(string): void}}
     *   `set(fraction)` takes 0..1 (clamped); `color(css)` repaints the fill at any time (a boss bar that takes each
     *   boss's colour, an HP bar that reddens)
     * @example const xp = ui.progress('XP', '#7cf'); xp.set(0.4); xp.label('Level 2');
     */
    function progress(label = '', color) {
      const fill = h('i');
      const labelElement = h('span', null, label);
      const box = track(component('progress', { fill, label: labelElement }) || h('div', 'progress'));
      const paint = (cssColor) => (fill.style.background = cssColor);
      if (color) paint(color);
      if (!box.contains(fill)) box.append(fill, labelElement);
      hudLayer.appendChild(box);
      return {
        el: box,
        set: (fraction) => (fill.style.width = Kit.math.clamp(fraction) * 100 + '%'),
        label: (text) => (labelElement.textContent = text),
        color: paint,
      };
    }

    /**
     * The bottom button bar (shops, abilities).
     * @param {ActionSpec[]} specs
     * @returns {{el: function(string): ?HTMLButtonElement, set: function(string, {label?: string, sub?: string,
     *   disabled?: boolean, hidden?: boolean}): void}} `set` patches one button (unknown ids are ignored); `el(id)` is the
     *   button itself (or null), for a themed button that carries extra parts the game keeps up to date
     * @example
     * const bar = ui.actions([{ id: 'dash', label: 'Dash', sub: 'ready', onClick: () => player.dash() }]);
     * bar.set('dash', { sub: '2s', disabled: true });
     */
    function actions(specs) {
      const partsById = specs.reduce((byId, spec) => {
        const label = h('b', null, spec.label);
        const sub = h('span', null, spec.sub || '');
        // theme.components.action({ id, label, sub }) may return its own <button> containing both elements.
        const element = track(component('action', { id: spec.id, label, sub }) || h('button', 'action'));
        element.type = 'button';
        if (!element.contains(label)) element.append(label, sub);
        element.addEventListener('click', withClickSound(() => spec.onClick && spec.onClick(spec.id)));
        actionBar.appendChild(element);
        byId[spec.id] = { button: element, label, sub };
        return byId;
      }, {});
      return {
        el: (id) => (partsById[id] ? partsById[id].button : null),
        set(id, patch) {
          const parts = partsById[id];
          if (!parts) return;
          Object.keys(ACTION_PATCHERS)
            .filter((field) => patch[field] !== undefined)
            .forEach((field) => ACTION_PATCHERS[field](parts, patch[field]));
        },
      };
    }

    /**
     * A brief centred callout ("Wave 3").
     * @param {string} text
     * @param {number} [ms=1300] how long it stays, milliseconds
     * @param {{gameTime?: boolean}} [options] `gameTime: true` plays it on the game clock (Kit.scrub), so it freezes while
     *   the game is paused or in hitstop and stretches in slow motion; the default is wall-clock time
     */
    function toast(text, ms = DEFAULT_TOAST_MS, { gameTime = false } = {}) {
      const element = track(h('div', 'toast', text));
      hudLayer.appendChild(element);
      if (gameTime) Kit.scrub(ctx.tween, element, ms / MS_PER_SECOND).then(() => element.remove());
      else setTimeout(() => element.remove(), ms);
    }

    /**
     * A persistent instruction near the bottom; hide it after the player's first input.
     * @param {string} text
     * @returns {{el: HTMLElement, hide: function(): void, show: function(): void, set: function(string): void}}
     */
    function hint(text) {
      const element = track(h('div', 'hint', text));
      hudLayer.appendChild(element);
      return {
        el: element,
        hide: () => element.classList.add('gone'),
        show: () => element.classList.remove('gone'),
        set: (nextText) => (element.textContent = nextText),
      };
    }

    /**
     * Escape hatch: adds your own element to the HUD layer (pointer events are off unless you turn them on).
     * @param {string} [tag='div']
     * @param {string} [className]
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    const el = (tag = 'div', className, text) => hudLayer.appendChild(track(h(tag, className, text)));

    // ---- modals: each pauses the game while open and resolves when dismissed ----

    /** Hides the modal host; when it is a native <dialog> this also gives focus back to whatever had it. */
    const hideModal = () => {
      if (modal.open) modal.close();
      modal.hidden = true;
      modal.textContent = '';
    };

    /**
     * Opens the modal with an empty card and hands it to `build(card, close)`. Calling `close(value)`
     * hides the modal, resumes the game and resolves the returned promise with the value.
     *
     * The host is a native <dialog> shown with showModal(): the browser keeps keyboard focus inside it, makes the
     * rest of the page inert and returns focus when it closes. Focus starts on the card, not on a button, so a
     * key the player was already holding for the game cannot press an option the moment the modal appears.
     * @param {(card: HTMLElement, close: (value?: any) => void) => void} build
     * @param {{escapeCloses?: boolean}} [options] `escapeCloses`: Escape dismisses the modal (resolving undefined);
     *   leave it off when the player must answer
     */
    function openModal(build, { escapeCloses = false } = {}) {
      ctx.paused = true;
      modal.textContent = '';
      const card = h('div', 'modal-card');
      card.tabIndex = -1;
      modal.appendChild(card);
      modal.hidden = false;
      if (modal.showModal && !modal.open) modal.showModal();
      card.focus({ preventScroll: true });
      return new Promise((resolve) => {
        const close = (value) => {
          hideModal();
          ctx.paused = false;
          resolve(value);
        };
        // Escape raises `cancel` on a dialog. The browser's own closing is always declined: close() must run so the game resumes.
        modal.oncancel = (event) => {
          event.preventDefault();
          if (escapeCloses) close();
        };
        build(card, close);
      });
    }

    /** One option button of a choose() modal. */
    const choiceButton = (option, onPick) => {
      const element = button('choice', undefined, onPick);
      // The stylesheet reads --c for the option's accent colour.
      if (option.color) element.style.setProperty('--c', option.color);
      const topLine = h('div', 'choice-top');
      topLine.append(h('b', null, option.title));
      if (option.tag) topLine.append(h('em', null, option.tag));
      element.append(topLine, h('span', null, option.desc || ''));
      return element;
    };

    /**
     * "Pick one" modal (level-up choices, route forks).
     * @param {{title?: string, sub?: string, options: ChoiceOption[]}} spec title defaults to 'Choose'
     * @returns {Promise<number>} index of the picked option
     * @example const index = await ui.choose({ title: 'Level up', options: [{ title: 'Haste', desc: '+10% speed', tag: 'New' }] });
     */
    const choose = ({ title = 'Choose', sub, options }) =>
      openModal((card, close) => {
        card.append(h('h2', null, title));
        if (sub) card.append(h('p', null, sub));
        card.append(...options.map((option, index) => choiceButton(option, () => close(index))));
      });

    /** One "label: value" line of a banner's results table. */
    const resultRow = ([label, value]) => {
      const row = h('div');
      row.append(h('span', null, label), h('b', null, formatValue(value)));
      return row;
    };

    /**
     * End-of-run / level-clear modal with one button.
     * @param {{title: string, text?: string, stats?: Array<[string, (number|string)]>, button?: string}} spec
     *   `stats` are [label, value] lines; `button` is the button's label (default 'Play again')
     * @returns {Promise<void>} resolves when the button is pressed
     * @example ui.banner({ title: 'Run over', text: 'The mine caved in', stats: [['Depth', 42]] }).then(() => ctx.restart());
     */
    const banner = ({ title, text, stats: rows, button: buttonLabel = 'Play again' }) =>
      openModal((card, close) => {
        card.append(h('h2', null, title));
        if (text) card.append(h('p', null, text));
        if (rows) {
          const table = h('div', 'rows');
          table.append(...rows.map(resultRow));
          card.append(table);
        }
        card.append(button('primary', buttonLabel, () => close()));
      });

    /**
     * A full-height scrollable sheet for inventories, skill trees and shops.
     * @param {{title: string, build: (body: HTMLElement, close: (value?: any) => void) => void, closeLabel?: string}} spec
     *   `build(body, close)` fills `body` with your own elements; call `close(value)` to dismiss
     * @returns {Promise<*>} the value passed to close (undefined from the Close button)
     * @example ui.panel({ title: 'Backpack', build: (body, close) => inventory.bag.forEach((item) => body.append(ui.h('div', 'item', item.name))) });
     */
    const panel = ({ title, build, closeLabel = 'Close' }) =>
      openModal(
        (card, close) => {
          card.classList.add('sheet');
          const body = h('div', 'sheet-body');
          // The body is the kit's scroll pane (kit/ui/scroll.js): fade edges, contained overscroll, keyboard scrolling.
          const stopWatching = Kit.ui.scrollable ? Kit.ui.scrollable(body, { label: title }) : () => {};
          const closePanel = (value) => {
            stopWatching();
            close(value);
          };
          card.append(h('h2', null, title), body, button('primary', closeLabel, () => closePanel()));
          build(body, closePanel);
        },
        { escapeCloses: true }
      );

    // ---- adapters: views generated from Kit models (model.js). Model in, HUD out; they redraw when the model changes ----

    /** What a shop button shows in place of a price. */
    const priceLabel = (upgrades, id) => {
      if (upgrades.maxed(id)) return 'MAX';
      if (!upgrades.unlocked(id)) return 'Locked';
      return Kit.fmt(upgrades.cost(id));
    };

    /**
     * A bottom bar bound to a Kit.upgrades model: buying, labels, costs and disabling are automatic.
     * @param {ReturnType<typeof Kit.upgrades>} upgrades
     * @param {Object} [options]
     * @param {ReturnType<typeof Kit.wallet>} [options.wallet] redraw when the balance changes
     * @param {string[]} [options.ids] show only these rows, in this order (default: the whole table)
     * @param {function(Object, number): void} [options.onBuy] called with (row, new level) after a purchase
     * @param {boolean} [options.describe=false] show each row's desc(next level) before the price
     * @param {?string} [options.sound='up'] Kit.sfx name played on a purchase, or null when the game plays its own in onBuy
     * @returns {{refresh: function(): void, bar: ReturnType<typeof actions>}}
     * @example ui.shop(upgrades, { wallet, describe: true });
     */
    function shop(upgrades, { wallet, ids, onBuy, describe = false, sound = 'up' } = {}) {
      const rows = ids ? ids.map((id) => upgrades.table.byId(id)) : upgrades.table;
      const buy = (id) => {
        if (!upgrades.buy(id)) return;
        if (sound) Kit.sfx.play(sound);
        if (onBuy) onBuy(upgrades.table.byId(id), upgrades.level(id));
      };
      const bar = actions(rows.map((row) => ({ id: row.id, label: row.name, onClick: buy })));
      const refresh = () => {
        rows.forEach((row) => {
          const level = upgrades.level(row.id);
          const price = priceLabel(upgrades, row.id);
          const nextLevelText = describe ? upgrades.desc(row.id, level + 1) : '';
          bar.set(row.id, {
            label: level ? `${row.name} ${level}` : row.name,
            sub: nextLevelText ? `${nextLevelText} · ${price}` : price,
            disabled: !upgrades.canBuy(row.id),
          });
        });
      };
      upgrades.on(refresh);
      if (wallet) wallet.on(refresh);
      refresh();
      return { refresh, bar };
    }

    /** The badge on an offered upgrade: its own tag, else the level it would reach, else "New". */
    const offerTag = (upgrades, row) => {
      if (row.tag) return row.tag;
      const level = upgrades.level(row.id);
      return level ? 'Lv ' + (level + 1) : 'New';
    };

    /**
     * "Pick 1 of n" from a Kit.upgrades model; the pick is granted.
     * @param {ReturnType<typeof Kit.upgrades>} upgrades
     * @param {Object} [options]
     * @param {number} [options.n=3] how many to offer
     * @param {string} [options.title='Level up']
     * @param {string} [options.sub]
     * @param {function(Object): boolean} [options.filter] passed to upgrades.offer
     * @param {Object[]} [options.rows] a hand you rolled yourself (a guaranteed slot, a reroll, a saved offer) instead of
     *   upgrades.offer(n, filter); rows that are maxed by then are dropped
     * @returns {Promise<?Object>} the picked UpgradeRow, or null when nothing could be offered
     * @example const picked = await ui.offer(upgrades, { n: 3, title: 'Level 4' });
     */
    function offer(upgrades, { n = 3, title = 'Level up', sub, filter, rows: givenRows } = {}) {
      const rows = givenRows ? givenRows.filter((row) => !upgrades.maxed(row.id)) : upgrades.offer(n, filter);
      if (!rows.length) return Promise.resolve(null);
      const options = rows.map((row) => ({
        title: row.name,
        desc: upgrades.desc(row.id, upgrades.level(row.id) + 1),
        tag: offerTag(upgrades, row),
        color: row.color,
      }));
      return choose({ title, sub, options }).then((index) => {
        upgrades.grant(rows[index].id);
        return rows[index];
      });
    }

    /** One line of a checklist; goals with a target above 1 show their count. */
    const goalRow = (goal) => {
      const row = h('div', goal.done ? 'done' : '');
      const text = goal.target > 1 ? `${goal.row.text} ${goal.progress}/${goal.target}` : goal.row.text;
      row.append(h('i', null, goal.done ? CHECK_MARK : ''), h('span', null, text));
      return row;
    };

    /**
     * A compact goal list bound to a Kit.goals model.
     * @param {ReturnType<typeof Kit.goals>} goals
     * @param {{hideWhenDone?: boolean}} [options] `hideWhenDone: true` takes the list out of view once every goal is
     *   done (and brings it back if progress is ever reset)
     * @returns {{el: HTMLElement, refresh: function(): void}}
     */
    function checklist(goals, { hideWhenDone = false } = {}) {
      const box = track(h('div', 'checklist'));
      hudLayer.appendChild(box);
      const refresh = () => {
        box.textContent = '';
        box.append(...goals.list().map(goalRow));
        // Inline display rather than the `hidden` attribute: the .checklist rule sets display and would override it.
        box.style.display = hideWhenDone && goals.allDone() ? 'none' : '';
      };
      goals.on(refresh);
      refresh();
      return { el: box, refresh };
    }

    // ---- the component library (kit/ui/): views built from Kit.ui components, owned by this HUD ----

    /** Disposers of the component views this HUD mounted. */
    const mountedViews = [];
    /** Where `mount` can put a view: the HUD regions of index.html. */
    const SLOTS = { layer: hudLayer, stats: statsRow, actions: actionBar };

    /**
     * Mounts a component view (kit/ui/) into the HUD; it is removed with the rest of the HUD when the game ends.
     * @param {*} view a template built with `ui.html` from Kit.ui components
     * @param {'layer'|'stats'|'actions'} [slot='layer'] the HUD region: the middle layer, the top stats row or the bottom bar
     * @returns {{el: HTMLElement, dispose: function(): void}}
     * @example
     * const { html, signal, Meter } = Kit.ui; const heat = signal(0);
     * ctx.ui.mount(html`<${Meter} label="Heat" value=${heat} />`);   // then just: heat.value = 0.7
     */
    const mount = (view, slot = 'layer') => {
      if (!Kit.ui.mount) throw new Error('ui.mount: the component library did not load (see the console warning from kit/ui/core.js).');
      if (!SLOTS[slot]) throw new Error(`ui.mount: unknown slot "${slot}". Use one of: ${Object.keys(SLOTS).join(', ')}.`);
      const mounted = Kit.ui.mount(view, SLOTS[slot]);
      mountedViews.push(mounted.dispose);
      return mounted;
    };

    /**
     * A component dialog or sheet (Kit.ui.openDialog) that pauses the game while it is open.
     * @param {Object} spec see Kit.ui.openDialog: `{ title, body, actions, variant: 'dialog' | 'sheet', dismissable }`
     * @returns {Promise<*>} the value passed to `close(value)`; undefined when dismissed
     * @example const pick = await ctx.ui.dialog({ title: 'Bait', variant: 'sheet', body: (close) => html`<${List} label="Bait" items=${baits} onSelect=${close} />` });
     */
    const dialog = (spec) => {
      ctx.paused = true;
      return Kit.ui.openDialog(spec).then((value) => {
        ctx.paused = false;
        return value;
      });
    };

    /** Removes everything this HUD added and closes any open modal, dialog or notice. */
    const dispose = () => {
      ownedElements.forEach((element) => element.remove());
      mountedViews.splice(0).forEach((disposeView) => disposeView());
      if (Kit.ui.closeDialogs) Kit.ui.closeDialogs();
      if (Kit.ui.clearNotices) Kit.ui.clearNotices();
      hideModal();
    };

    return { stat, progress, actions, choose, banner, toast, hint, el, pips, panel, shop, offer, checklist, h, mount, dialog, html: Kit.ui.html, dispose };
  };

  /** The element builder is also available without a HUD instance (the shell builds the menu with it). */
  Kit.ui.h = h;
})();
