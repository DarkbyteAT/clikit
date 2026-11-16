// Kit views: build-crafting screens generated from kit models. Model in, element out; each view re-renders itself when
// its model changes. Put the element anywhere (usually inside ui.panel) and call dispose() when it is closed.
//
//   tree      - skill tree from a Kit.upgrades model whose rows carry `row` / `col` / `requires`   Kit.views.tree(upgrades, { wallet })
//   inventory - bag and equipment from Kit.inventory + Kit.loot, with compare, equip and salvage    Kit.views.inventory(inventory, { loot })
//   roll      - slot-style reel over a weighted table that stops on a winner chosen beforehand      Kit.views.roll({ entries, winner })
//   progressList - any list of titled entries with a counter and a progress bar                     Kit.views.progressList(readEntries, models)
//   deeds     - achievements of a Kit.profile with live progress                                    Kit.views.deeds(profile)
//   synergies - set bonuses of a Kit.synergy with the tags still missing                            Kit.views.synergies(synergy)
//
// Owns: the markup, the default look and the taps of those screens.
// Does not own: the decisions they show (kit/craft.js, unit-tested), the models (kit/model.js, kit/loot.js), or the
//               modal they sit in (ui.panel).
//
// Theming: every colour, font and radius comes from the theme tokens (kit/theme.js) or from the view tokens in
// VIEW_TOKEN_DEFAULTS below, so a game restyles a view from `theme.tokens` and `theme.css` alone. The class names are a
// stable contract for scoped CSS:
//   .kv-tree  .kv-tree-heads  .kv-tree-lines line[data-active]  .kv-node[data-status][data-owned]  .kv-node-mark
//   .kv-inventory  .kv-slot  .kv-item (its rarity colour is the CSS variable --c)  .kv-compare .is-better / .is-worse
//   .kv-roll  .kv-reel  .kv-reel-row (colour --c)  .kv-roll[data-landed]  .kv-roll-result
//   .kv-list  .kv-entry[data-done]  .kv-entry-bar (its fill is the CSS variable --progress, 0..1)
(() => {
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const STYLE_ID = 'kit-views-css';

  /**
   * Tokens only the views read. A game overrides them like any theme token (`theme.tokens`).
   * @type {Record<string, string>}
   */
  const VIEW_TOKEN_DEFAULTS = {
    '--view-good': '#7ddc8a', // a compare line that is an improvement
    '--view-bad': '#ff7a85', // a compare line that is a loss
    '--view-node-height': '104px', // height of one tier of the tree
    '--view-reel-row': '52px', // height of one row of the reel (the window shows three)
    '--view-reel-ease': 'cubic-bezier(0.12, 0.72, 0.12, 1)', // how the reel slows to a stop
  };

  const STYLES = `
    :root { ${Object.entries(VIEW_TOKEN_DEFAULTS).map(([name, value]) => `${name}: ${value};`).join(' ')} }
    .kv-points { font: 700 14px var(--display); color: var(--accent); letter-spacing: var(--label-spacing); text-transform: var(--label-case); }
    .kv-tree { position: relative; }
    .kv-tree-heads, .kv-tree-grid { display: grid; grid-template-columns: repeat(var(--kv-columns), minmax(0, 1fr)); }
    .kv-tree-heads span { text-align: center; font: 700 13px var(--display); color: var(--dim); letter-spacing: var(--label-spacing); text-transform: var(--label-case); padding-bottom: 4px; }
    .kv-tree-body { position: relative; }
    .kv-tree-grid { grid-template-rows: repeat(var(--kv-tiers), var(--view-node-height)); position: relative; }
    .kv-tree-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .kv-tree-lines line { stroke: var(--line); stroke-width: 2; vector-effect: non-scaling-stroke; }
    .kv-tree-lines line[data-active="true"] { stroke: var(--accent); }
    .kv-node {
      margin: 5px; padding: 6px 5px; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      text-align: center; color: var(--ink); background: var(--panel); border: var(--border) solid var(--line);
      border-radius: var(--radius-lg); box-shadow: var(--shadow);
    }
    .kv-node-mark { display: none; }
    .kv-node b { font: 700 13px/1.1 var(--display); }
    .kv-node span { font-size: 11px; line-height: 1.15; color: var(--dim); }
    .kv-node em { font: 700 12px var(--display); font-style: normal; color: var(--accent); font-variant-numeric: tabular-nums; }
    .kv-node[data-status="locked"] { opacity: .4; }
    .kv-node[data-status="short"] em { color: var(--dim); }
    .kv-node[data-status="available"] { border-color: var(--accent); }
    .kv-node[data-owned="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
    .kv-node:active { transform: scale(.97); }

    .kv-inventory { display: flex; flex-direction: column; gap: 8px; }
    .kv-slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 6px; }
    .kv-slot, .kv-item { background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
    .kv-slot { --c: var(--dim); padding: 6px 8px; display: flex; flex-direction: column; gap: 1px; min-width: 0; border-top: 3px solid var(--c); }
    .kv-slot span, .kv-item em { font-size: 10px; font-style: normal; letter-spacing: var(--label-spacing); text-transform: var(--label-case); color: var(--dim); }
    .kv-slot b { font: 700 13px/1.15 var(--display); color: var(--c); }
    .kv-slot small, .kv-lines span { font-size: 11px; color: var(--dim); }
    .kv-item { --c: var(--ink); padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; border-left: 5px solid var(--c); }
    .kv-item-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .kv-item-top b { font: 700 16px var(--display); color: var(--c); }
    .kv-lines, .kv-compare { display: flex; flex-wrap: wrap; gap: 2px 10px; }
    .kv-compare { font-size: 12px; font-weight: 600; }
    .kv-compare i { font-style: normal; color: var(--dim); font-weight: 400; }
    .kv-compare .is-better { color: var(--view-good); }
    .kv-compare .is-worse { color: var(--view-bad); }
    .kv-item-actions { display: flex; gap: 6px; }
    .kv-button { flex: 1; padding: 7px 6px; font: 700 13px var(--display); color: var(--ink); border: var(--border) solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .kv-button.is-main { background: var(--accent); color: var(--accent-ink); border-color: var(--accent-edge); }
    .kv-empty { margin: 0; color: var(--dim); text-align: center; padding: 12px 0; }

    .kv-roll { display: flex; flex-direction: column; gap: 10px; }
    .kv-reel { position: relative; height: calc(var(--view-reel-row) * 3); overflow: hidden; background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
    .kv-reel::after { content: ''; position: absolute; left: 0; right: 0; top: var(--view-reel-row); height: var(--view-reel-row); border-block: 2px solid var(--accent); pointer-events: none; }
    .kv-reel-strip { will-change: transform; }
    .kv-reel-row { --c: var(--ink); height: var(--view-reel-row); display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; }
    .kv-reel-row b { font: 700 19px var(--display); color: var(--c); }
    .kv-reel-row span { font-size: 11px; color: var(--dim); letter-spacing: var(--label-spacing); text-transform: var(--label-case); }
    .kv-roll-result { margin: 0; min-height: 2.4em; color: var(--dim); text-align: center; }
    .kv-roll:not([data-landed]) .kv-roll-take { visibility: hidden; }

    .kv-list { display: flex; flex-direction: column; gap: 6px; }
    .kv-entry { --progress: 0; position: relative; overflow: hidden; padding: 7px 10px 9px; display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
    .kv-entry b { font: 700 14px var(--display); }
    .kv-entry em { font: 700 12px var(--display); font-style: normal; color: var(--accent); font-variant-numeric: tabular-nums; }
    .kv-entry span { grid-column: 1 / -1; font-size: 12px; color: var(--dim); }
    .kv-entry-bar { position: absolute; left: 0; bottom: 0; height: 3px; width: calc(var(--progress) * 100%); background: var(--accent); }
    .kv-entry[data-done="true"] { border-color: var(--accent); }
    .kv-entry[data-done="false"] b { color: var(--dim); }
  `;

  /** Installs the views' stylesheet once per page. */
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /**
   * Makes an element: tag, class and text in one call (the same shape as ui.h).
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Makes a button that plays the kit's click and never lets the tap fall through to the game underneath.
   * @param {string} className
   * @param {(event: Event) => void} onPress
   * @returns {HTMLButtonElement}
   */
  function button(className, onPress) {
    const node = element('button', className);
    node.type = 'button';
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onPress(event);
    });
    return node;
  }

  /**
   * The shared life cycle of a model-driven view: render now, re-render on every model change, stop on dispose.
   * @param {HTMLElement} root            the element handed to the caller
   * @param {() => void} render           fills `root` from the models
   * @param {Object[]} models             anything with on(listener) -> unsubscribe (upgrades, wallet, inventory); falsy entries are skipped
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   */
  function liveView(root, render, models) {
    const unsubscribes = models.filter(Boolean).map((model) => model.on(render));
    render();
    return { element: root, refresh: render, dispose: () => unsubscribes.forEach((unsubscribe) => unsubscribe()) };
  }

  /** Where prerequisite lines attach inside a tree cell, as fractions of the cell (the centre by default). */
  const DEFAULT_TREE_ANCHOR = { x: 0.5, y: 0.5 };

  /**
   * Skill tree generated from a Kit.upgrades model. Rows are placed by their `row` (tier, 0 at the top) and `col`
   * fields, lines join each node to its `requires`, and a tap buys. Every node shows its name, what the next level
   * does and its price; its `data-status` (see Kit.craft.nodeStatus) drives the locked / available / owned looks.
   * @param {Object} upgrades  a Kit.upgrades model (rows need integer `row` and `col`)
   * @param {Object} [options]
   * @param {Object} [options.wallet]        the Kit.wallet the tree spends from; shows the balance and re-renders on change
   * @param {string} [options.currency]      which wallet currency to show (default: the wallet's default)
   * @param {string} [options.pointsLabel]   text before the balance (default 'Points')
   * @param {string[]} [options.heads]       a title per column (branch names)
   * @param {{ x: number, y: number }} [options.anchor]  where lines attach in a cell, 0..1 (default the centre); move it
   *                                         when your CSS draws a node's mark (.kv-node-mark) away from the centre
   * @param {(row: Object, level: number) => void} [options.onBuy]  called after a successful purchase
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   * @example
   * const view = Kit.views.tree(tree, { wallet, currency: 'souls', heads: ['Reaper', 'Warden', 'Occult'] });
   * ui.panel({ title: 'Soul Tree', build: (body) => body.append(view.element) }).then(view.dispose);
   * @complexity render: O(rows + edges) elements, rebuilt on every model change (a tree is a few dozen nodes).
   */
  function tree(upgrades, options = {}) {
    ensureStyles();
    const { wallet, currency, pointsLabel = 'Points', heads, anchor = DEFAULT_TREE_ANCHOR, onBuy } = options;
    const root = element('div', 'kv-tree');

    const buildNode = (node) => {
      const nodeButton = button('kv-node', () => {
        const isBought = upgrades.buy(node.id);
        Kit.sfx.play(isBought ? 'up' : 'click');
        if (isBought && onBuy) onBuy(node.row, upgrades.level(node.id));
      });
      nodeButton.dataset.id = node.id;
      nodeButton.dataset.status = node.status;
      nodeButton.dataset.owned = String(node.level > 0);
      // Still a real, focusable button when it cannot be bought (a tap explains itself with the click sound); assistive
      // technology is told it will not act.
      nodeButton.setAttribute('aria-disabled', String(node.status !== 'available'));
      nodeButton.style.gridColumn = node.column + 1;
      nodeButton.style.gridRow = node.tier + 1;
      const isMaxed = node.status === 'maxed';
      const hasLevels = node.row.max !== undefined && node.row.max > 1;
      const price = isMaxed ? 'MAX' : Kit.fmt(node.cost) + (hasLevels ? ` · ${node.level}/${node.row.max}` : '');
      // Describe the level a tap would buy; once maxed, describe what is owned.
      const description = upgrades.desc(node.id, isMaxed ? node.level : node.level + 1);
      nodeButton.append(element('i', 'kv-node-mark'), element('b', null, node.row.name), element('span', null, description), element('em', null, price));
      return nodeButton;
    };

    const buildLines = (layout) => {
      const lines = document.createElementNS(SVG_NAMESPACE, 'svg');
      lines.setAttribute('class', 'kv-tree-lines');
      // One viewBox unit per cell, stretched over the grid, so a line's ends are (column + anchor.x, tier + anchor.y).
      lines.setAttribute('viewBox', `0 0 ${layout.columns} ${layout.tiers}`);
      lines.setAttribute('preserveAspectRatio', 'none');
      const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
      layout.edges.forEach((edge) => {
        const from = nodesById.get(edge.from), to = nodesById.get(edge.to);
        const line = document.createElementNS(SVG_NAMESPACE, 'line');
        line.setAttribute('x1', from.column + anchor.x);
        line.setAttribute('y1', from.tier + anchor.y);
        line.setAttribute('x2', to.column + anchor.x);
        line.setAttribute('y2', to.tier + anchor.y);
        line.dataset.active = String(edge.isActive);
        lines.appendChild(line);
      });
      return lines;
    };

    const render = () => {
      const layout = Kit.craft.treeLayout(upgrades);
      root.textContent = '';
      root.style.setProperty('--kv-columns', layout.columns);
      root.style.setProperty('--kv-tiers', layout.tiers);
      if (wallet) root.append(element('div', 'kv-points', `${pointsLabel}: ${Kit.fmt(wallet.get(currency))}`));
      if (heads) {
        const headRow = element('div', 'kv-tree-heads');
        headRow.append(...heads.map((head) => element('span', null, head)));
        root.append(headRow);
      }
      const body = element('div', 'kv-tree-body');
      const grid = element('div', 'kv-tree-grid');
      grid.append(...layout.nodes.map(buildNode));
      // Lines first, so nodes paint over them.
      body.append(buildLines(layout), grid);
      root.append(body);
    };
    return liveView(root, render, [upgrades, wallet]);
  }

  /**
   * Inventory generated from a Kit.inventory and the Kit.loot that rolled its items: the worn item per slot, then every
   * bag item as a card in its rarity colour with its describe lines, a compare against what is worn, and Equip /
   * Salvage buttons.
   * @param {Object} inventory  a Kit.inventory
   * @param {Object} options
   * @param {Object} options.loot                      the Kit.loot generator (for describe)
   * @param {Record<string, string>} [options.labels]  stat name -> display name, for describe and compare lines
   * @param {string[]} [options.compareStats]          stats to compare (default: none, which hides the compare line)
   * @param {string[]} [options.percent]               see Kit.craft.compareLines
   * @param {string[]} [options.lowerIsBetter]         see Kit.craft.compareLines
   * @param {Record<string, string>} [options.slotLabels]  slot id -> display name
   * @param {(item: Object) => string} [options.tag]   small text beside an item's name (rarity, level, "Cursed")
   * @param {(card: HTMLElement, item: Object) => void} [options.decorate]  last word on each bag card: add data attributes
   *        or badges your scoped CSS keys on (for example card.dataset.cursed)
   * @param {(item: Object) => void} [options.onEquip] called after an item is equipped
   * @param {{ label: (item: Object) => string, onSalvage: (item: Object) => void }} [options.salvage]
   *        adds a Salvage button; the view removes the item from the bag, then calls onSalvage(item) for the payout
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   * @example
   * const view = Kit.views.inventory(inventory, { loot, labels: STAT_LABELS, compareStats: ['damage', 'maxHp'],
   *   salvage: { label: (item) => `Salvage +${soulsFor(item)}`, onSalvage: (item) => wallet.add(soulsFor(item), 'souls') } });
   * @complexity render: O(items x compareStats), rebuilt on every inventory change (a bag is a few dozen items).
   */
  function inventory(inventoryModel, options) {
    ensureStyles();
    const { loot, labels = {}, compareStats = [], percent, lowerIsBetter, slotLabels = {}, tag, decorate, onEquip, salvage } = options;
    const root = element('div', 'kv-inventory');
    const describeLines = (item) => {
      const lines = element('div', 'kv-lines');
      lines.append(...loot.describe(item, labels).map((line) => element('span', null, line)));
      return lines;
    };

    const buildSlot = (slot) => {
      const worn = inventoryModel.equipped(slot);
      const box = element('div', 'kv-slot');
      if (worn && worn.color) box.style.setProperty('--c', worn.color);
      box.append(element('span', null, slotLabels[slot] || slot), element('b', null, worn ? worn.name : 'Empty'));
      if (worn) box.append(element('small', null, loot.describe(worn, labels).join(', ')));
      return box;
    };

    const buildCompare = (item) => {
      const lines = Kit.craft.compareLines(inventoryModel.compare(item, compareStats), { labels, percent, lowerIsBetter });
      const row = element('div', 'kv-compare');
      row.append(element('i', null, lines.length ? 'If equipped:' : 'Same as equipped'));
      row.append(...lines.map((line) => element('span', line.isBetter ? 'is-better' : 'is-worse', line.text)));
      return row;
    };

    const buildItem = (item) => {
      const card = element('div', 'kv-item');
      card.dataset.uid = item.uid;
      if (item.color) card.style.setProperty('--c', item.color);
      const top = element('div', 'kv-item-top');
      top.append(element('b', null, item.name), element('em', null, tag ? tag(item) : item.slot));
      const equipButton = button('kv-button is-main', () => {
        if (!inventoryModel.equip(item.uid)) return;
        Kit.sfx.play('up');
        if (onEquip) onEquip(item);
      });
      equipButton.textContent = 'Equip';
      const actions = element('div', 'kv-item-actions');
      actions.append(equipButton);
      if (salvage) {
        const salvageButton = button('kv-button', () => {
          if (!inventoryModel.remove(item.uid)) return;
          Kit.sfx.play('coin');
          salvage.onSalvage(item);
        });
        salvageButton.textContent = salvage.label(item);
        actions.append(salvageButton);
      }
      card.append(top, describeLines(item));
      if (compareStats.length) card.append(buildCompare(item));
      card.append(actions);
      if (decorate) decorate(card, item);
      return card;
    };

    const render = () => {
      root.textContent = '';
      const slots = element('div', 'kv-slots');
      slots.append(...inventoryModel.slots.map(buildSlot));
      root.append(slots);
      if (!inventoryModel.bag.length) root.append(element('p', 'kv-empty', 'Nothing in the bag yet.'));
      root.append(...inventoryModel.bag.map(buildItem));
    };
    return liveView(root, render, [inventoryModel]);
  }

  /** How long the reel spins when the caller does not say, in milliseconds. */
  const DEFAULT_SPIN_MS = 1700;
  /** Delay before the spin starts, so the browser paints the strip at rest first and the transition has a start value. */
  const SPIN_START_MS = 40;
  /** Rows above the centre row of the three-row window. */
  const ROWS_ABOVE_CENTRE = 1;

  /**
   * @typedef {Object} RollEntry
   * @property {string} label    what the row shows
   * @property {string} [sub]    small text under the label (the source, the odds)
   * @property {string} [color]  CSS colour of the label
   * @property {number} [weight] how often it appears among the filler rows (default 1)
   */

  /**
   * Slot-style roll: a reel of weighted entries spins and stops on `winner`, then a result line and a "take" button
   * appear. The outcome is decided by the caller before the view is made; the view only reveals it. Declining is the
   * host's job (for example the close button of ui.panel), so the caller can word and price it.
   * @param {Object} options
   * @param {RollEntry[]} options.entries          the weighted table the reel shows
   * @param {RollEntry} options.winner             the entry to stop on (one of `entries`)
   * @param {(entry: RollEntry) => string} [options.describe]   result text once landed
   * @param {(entry: RollEntry) => string} [options.takeLabel]  text of the take button (default 'Take')
   * @param {(entry: RollEntry) => void} [options.onLand]       called when the reel stops
   * @param {(entry: RollEntry) => void} options.onTake         called when the take button is pressed
   * @param {number} [options.spinMs]              spin duration in milliseconds
   * @param {Object} [options.rng]                 a Kit.rng for the filler rows
   * @returns {{ element: HTMLElement, dispose: () => void }} dispose cancels a spin still in progress
   * @example
   * ui.panel({ title: 'Absorb', closeLabel: 'Bank it: +3 souls', build: (body, close) =>
   *   body.append(Kit.views.roll({ entries: pool, winner, onTake: () => close('take') }).element) });
   * @complexity O(strip length) elements once (about 27 rows); the spin itself is one CSS transition.
   */
  function roll(options) {
    ensureStyles();
    const { entries, winner, describe = () => '', takeLabel = () => 'Take', onLand, onTake, spinMs = DEFAULT_SPIN_MS, rng } = options;
    const { strip, landIndex } = Kit.craft.reel(entries, winner, { rng });
    const root = element('div', 'kv-roll');
    const reelWindow = element('div', 'kv-reel');
    const stripElement = element('div', 'kv-reel-strip');
    stripElement.append(
      ...strip.map((entry) => {
        const row = element('div', 'kv-reel-row');
        if (entry.color) row.style.setProperty('--c', entry.color);
        row.append(element('b', null, entry.label));
        if (entry.sub) row.append(element('span', null, entry.sub));
        return row;
      })
    );
    reelWindow.append(stripElement);
    const result = element('p', 'kv-roll-result');
    const takeButton = button('kv-button is-main kv-roll-take', () => {
      Kit.sfx.play('up');
      onTake(winner);
    });
    takeButton.textContent = takeLabel(winner);
    // Disabled, not just hidden, until the reel stops: an unseen button must not be pressable.
    takeButton.disabled = true;
    root.append(reelWindow, result, takeButton);

    const land = () => {
      root.dataset.landed = 'true';
      takeButton.disabled = false;
      result.textContent = describe(winner);
      Kit.sfx.play('perfect');
      if (onLand) onLand(winner);
    };
    const spin = () => {
      // Row height is read from the page, not assumed, so a theme may change --view-reel-row freely.
      const rowHeight = stripElement.firstElementChild.offsetHeight;
      stripElement.style.transition = `transform ${spinMs}ms var(--view-reel-ease)`;
      stripElement.style.transform = `translateY(${-(landIndex - ROWS_ABOVE_CENTRE) * rowHeight}px)`;
      Kit.sfx.play('whoosh');
    };
    // Real-time timers on purpose: the game clock is paused while a modal is open. Landing is timed rather than tied to
    // `transitionend`, which never fires when the page is hidden or reduced motion removes the transition.
    const timers = [setTimeout(spin, SPIN_START_MS), setTimeout(land, SPIN_START_MS + spinMs)];
    return { element: root, dispose: () => timers.forEach(clearTimeout) };
  }

  /**
   * One row of a progress list: a title, a counter, a detail line and a thin bar.
   * @param {{ title: string, counter: string, detail?: string, progress: number, isDone: boolean }} entry  progress is 0..1
   * @returns {HTMLElement}
   */
  function buildEntry(entry) {
    const row = element('div', 'kv-entry');
    row.dataset.done = String(entry.isDone);
    row.style.setProperty('--progress', Kit.math.clamp(entry.progress));
    row.append(element('b', null, entry.title), element('em', null, entry.counter));
    if (entry.detail) row.append(element('span', null, entry.detail));
    row.append(element('i', 'kv-entry-bar'));
    return row;
  }

  /**
   * A list of progress entries (a title, a counter, a detail line and a thin bar each) that re-renders when a model
   * changes. `deeds` and `synergies` are this with a mapping; use it directly for any other list (a bestiary, quests).
   * @param {() => { title: string, counter: string, detail?: string, progress: number, isDone: boolean }[]} readEntries
   *        the entries to show; progress is 0..1
   * @param {Object[]} models             things with on(listener) to re-render on
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   * @complexity render: O(entries), rebuilt on every model change.
   */
  function progressList(readEntries, models) {
    ensureStyles();
    const root = element('div', 'kv-list');
    const render = () => {
      root.textContent = '';
      root.append(...readEntries().map(buildEntry));
    };
    return liveView(root, render, models);
  }

  /**
   * Achievements of a Kit.profile: each with its text, progress toward its target and what it unlocks.
   * @param {Object} profile  a Kit.profile
   * @param {{ describeUnlock?: (unlockId: string) => string }} [options]  describeUnlock: words for a row's `unlocks` id
   *        (default: the id itself)
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   * @example ui.panel({ title: 'Deeds', build: (body) => body.append(Kit.views.deeds(profile).element) });
   * @complexity render: O(achievements).
   */
  function deeds(profile, options = {}) {
    const { describeUnlock = (unlockId) => unlockId } = options;
    return progressList(
      () =>
        profile.achievements().map(({ row, progress, done }) => ({
          title: row.text,
          counter: done ? 'Done' : `${Kit.fmt(Math.floor(progress))}/${Kit.fmt(row.target)}`,
          detail: row.unlocks ? `Unlocks ${describeUnlock(row.unlocks)}` : undefined,
          progress: progress / row.target,
          isDone: done,
        })),
      [profile]
    );
  }

  /**
   * Set bonuses of a Kit.synergy: each with its description and, tag by tag, how much of what it needs the build
   * holds. Call refresh() after synergy.update(...) if the view stays open while the build changes.
   * @param {Object} synergy  a Kit.synergy
   * @param {{ tagLabels?: Record<string, string> }} [options]  tagLabels: tag id -> display name
   * @returns {{ element: HTMLElement, refresh: () => void, dispose: () => void }}
   * @example body.append(Kit.views.synergies(synergies, { tagLabels: { blight: 'Blight' } }).element);
   * @complexity render: O(rows x needs).
   */
  function synergies(synergy, options = {}) {
    const { tagLabels = {} } = options;
    return progressList(
      () =>
        synergy.progress().map(({ row, active, have }) => {
          const tags = Object.keys(row.needs);
          const needed = tags.reduce((total, tag) => total + row.needs[tag], 0);
          const held = tags.reduce((total, tag) => total + have[tag], 0);
          return {
            title: row.name,
            counter: tags.map((tag) => `${tagLabels[tag] || tag} ${have[tag]}/${row.needs[tag]}`).join(' \u00b7 '),
            detail: row.desc,
            progress: held / needed,
            isDone: active,
          };
        }),
      []
    );
  }

  Kit.views = { VIEW_TOKEN_DEFAULTS, tree, inventory, roll, progressList, deeds, synergies };
})();
