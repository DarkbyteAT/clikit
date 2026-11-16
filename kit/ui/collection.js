/**
 * Kit ui collection: things in a row, a column or a grid, and the surface each one sits on.
 *
 * Owns:  `Kit.ui.Card` (a surface with a title, text, a mark and a tag; a real <button> when it can be pressed),
 *        `Kit.ui.List` and `Kit.ui.Grid` (items with single or multiple selection, a listbox to assistive
 *        technology: arrows move, Home and End jump, Enter or Space selects).
 * Does not own: scrolling (wrap a long list in a ScrollPane) or where the items come from.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, isSignal, classes, css, useSignal, useRef } = Kit.ui;
  const { rovingIndex, toggleSelection, isSelected } = Kit.uiLogic;
  const SELECT_KEYS = ['Enter', ' '];

  /**
   * A surface for one thing: a game, an item, an upgrade. With `onClick` it is a button; without, an article.
   * @param {Object} props
   * @param {string} props.title
   * @param {string} [props.text] one or two lines under the title
   * @param {string} [props.tag] a small accent line (a hook, a rarity, a price)
   * @param {string|number} [props.mark] a short leading badge (a number, an initial)
   * @param {string} [props.color] CSS colour of the mark and the tag (default: the accent token)
   * @param {function(MouseEvent): void} [props.onClick]
   * @param {boolean} [props.disabled]
   * @param {?string} [props.sound='tap'] Kit.sfx name played on a press
   * @example html`<${Card} mark="3" title="Deep Vein" text="Break ore, pick a shaft" tag="Relics change the rules" onClick=${play} />`
   */
  const Card = ({ title, text, tag, mark, color, onClick, disabled, sound = 'tap', id, class: className, children }) => {
    const body = html`${mark !== undefined ? html`<i class="ui-card-mark">${mark}</i>` : null}
      <span class="ui-card-body">
        <b>${title}</b>
        ${text ? html`<span>${text}</span>` : null}
        ${tag ? html`<em>${tag}</em>` : null}
        ${children}
      </span>`;
    const style = color ? `--ui-card-color: ${color}` : undefined;
    if (!onClick) return html`<article id=${id} class=${classes('ui-card', className)} style=${style}>${body}</article>`;
    const press = (event) => {
      event.stopPropagation();
      if (sound) Kit.sfx.play(sound);
      onClick(event);
    };
    return html`<button type="button" id=${id} class=${classes('ui-card', className)} style=${style} disabled=${Boolean(read(disabled))} onClick=${press}>${body}</button>`;
  };

  /**
   * @typedef {Object} CollectionProps
   * @property {Object[]} items rows; each needs a unique `id` (or pass `idOf`)
   * @property {function(Object, boolean): *} [render] draws one item given (item, isSelected); default: its `label` or `name`
   * @property {*|Array|Object} [selected] the selection: an id (single) or array of ids (multiple), plain or a signal you own
   * @property {boolean} [multiple=false] toggle items in and out of the selection instead of replacing it
   * @property {function(*|Array, Object): void} [onSelect] called with (new selection, the item that was picked)
   * @property {function(Object): *} [idOf] how to read an item's id (default: `item.id`)
   * @property {function(Object): boolean} [isDisabled] items that cannot be picked
   * @property {string} label accessible name of the collection
   */

  /** The shared listbox behind List and Grid; `layout` picks the arrangement. */
  const Collection = ({ layout, items, render = (item) => item.label || item.name, selected, multiple = false, onSelect, idOf = (item) => item.id, isDisabled = () => false, label, minWidth, class: className }) => {
    const own = useSignal(isSignal(selected) ? undefined : selected);
    const state = isSignal(selected) ? selected : own;
    const focusIndex = useSignal(0);
    const box = useRef(null);
    const selection = read(state);
    const pick = (item) => {
      if (isDisabled(item)) return;
      Kit.sfx.play('click');
      state.value = toggleSelection(state.peek(), idOf(item), multiple);
      if (onSelect) onSelect(state.peek(), item);
    };
    const onKeyDown = (event) => {
      const index = [...box.current.children].indexOf(event.target);
      if (index < 0) return;
      if (SELECT_KEYS.includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return pick(items[index]);
      }
      const target = rovingIndex(event.key, index, items.length, (candidate) => isDisabled(items[candidate]));
      if (target < 0) return;
      event.preventDefault();
      event.stopPropagation();
      focusIndex.value = target;
      box.current.children[target].focus();
    };
    // Exactly one item is in the Tab order (the last one focused), so Tab leaves the list instead of walking it.
    const tabStop = Math.min(read(focusIndex), items.length - 1);
    return html`<div
      class=${classes('ui-collection', className)}
      data-layout=${layout}
      role="listbox"
      aria-label=${label}
      aria-multiselectable=${multiple ? 'true' : undefined}
      style=${minWidth ? `--ui-cell: ${minWidth}` : undefined}
      ref=${box}
      onKeyDown=${onKeyDown}
    >
      ${items.map((item, index) => {
        const isOn = isSelected(selection, idOf(item));
        return html`<div
          class="ui-option"
          role="option"
          key=${idOf(item)}
          aria-selected=${String(isOn)}
          aria-disabled=${isDisabled(item) ? 'true' : undefined}
          tabindex=${index === tabStop ? 0 : -1}
          onClick=${(event) => {
            event.stopPropagation();
            focusIndex.value = index;
            pick(item);
          }}
        >
          ${render(item, isOn)}
        </div>`;
      })}
    </div>`;
  };

  /**
   * A vertical list with selection.
   * @param {CollectionProps} props
   * @complexity O(items) elements; a selection change re-renders the list once
   * @example html`<${List} label="Bait" items=${baits} selected=${chosenBait} render=${(bait) => html`${bait.name} <small>${bait.count}</small>`} />`
   */
  const List = (props) => html`<${Collection} ...${props} layout="list" />`;

  /**
   * A grid with selection; columns are as many as fit at `minWidth` each.
   * @param {CollectionProps & {minWidth?: string}} props `minWidth` is a CSS length (default 96px)
   * @complexity O(items) elements; a selection change re-renders the grid once
   * @example html`<${Grid} label="Seeds" multiple items=${seeds} selected=${picked} minWidth="72px" />`
   */
  const Grid = (props) => html`<${Collection} ...${props} layout="grid" />`;

  css(`
    .ui-card {
      --ui-card-color: var(--accent); pointer-events: auto; display: flex; align-items: center; gap: 12px; min-height: var(--ui-hit); min-width: 0; padding: 10px var(--ui-pad);
      text-align: left; color: var(--ink); background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow);
      transition: transform var(--ui-speed), border-color var(--ui-speed);
    }
    button.ui-card:active:not(:disabled) { transform: scale(.98); border-color: var(--ui-card-color); }
    button.ui-card:disabled { opacity: .5; }
    .ui-card-mark { flex: none; width: 40px; height: 40px; display: grid; place-items: center; border-radius: var(--radius); background: var(--ui-card-color); color: #0a0d1c; font: 700 20px var(--display); font-style: normal; }
    .ui-card-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .ui-card-body b { font: 700 17px/1.2 var(--display); }
    .ui-card-body span { color: var(--dim); font-size: 13px; line-height: 1.3; }
    .ui-card-body em { font-style: normal; font-size: 11px; letter-spacing: .04em; color: var(--ui-card-color); }
    .ui-collection { display: flex; flex-direction: column; gap: 4px; min-width: 0; pointer-events: auto; }
    .ui-collection[data-layout="grid"] { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(var(--ui-cell, 96px), 100%), 1fr)); gap: var(--ui-gap); }
    .ui-option {
      min-height: var(--ui-hit); padding: 8px var(--ui-pad); display: flex; align-items: center; gap: var(--ui-gap); cursor: pointer; color: var(--ink);
      background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius); transition: border-color var(--ui-speed), background var(--ui-speed);
    }
    .ui-collection[data-layout="grid"] .ui-option { flex-direction: column; justify-content: center; text-align: center; }
    .ui-option[aria-selected="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .ui-option[aria-selected="true"]::after { content: ""; flex: none; margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .ui-collection[data-layout="grid"] .ui-option[aria-selected="true"]::after { margin: 0; }
    .ui-option[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
    .ui-option:focus-visible, .ui-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `);

  Object.assign(Kit.ui, { Card, List, Grid });
})();
