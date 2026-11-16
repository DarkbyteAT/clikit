/**
 * Kit ui tabs: one of several views at a time.
 *
 * Owns:  `Kit.ui.Tabs`: a tab list (arrow keys, Home and End move between tabs; only the selected tab is in the
 *        Tab order) and the panel of the selected tab.
 * Does not own: what the panels hold. A panel that should scroll wraps its content in a ScrollPane.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, isSignal, classes, css, uid, useSignal, useRef } = Kit.ui;
  const { rovingIndex } = Kit.uiLogic;

  /**
   * @typedef {Object} TabSpec
   * @property {string} id
   * @property {string} label
   * @property {*|function(): *} content the panel: a template, or a function returning one (built only while selected)
   * @property {boolean} [disabled]
   */

  /**
   * Tabs with their panel.
   * @param {Object} props
   * @param {TabSpec[]} props.tabs
   * @param {string|Object} [props.selected] the selected tab's id: a signal you own (two-way), or an initial value
   * @param {function(string): void} [props.onSelect] called with the id when the selection changes
   * @param {string} [props.label] accessible name of the tab list
   * @param {boolean} [props.fill] let the panel take the remaining height of a flex column
   * @param {string} [props.class] extra CSS classes
   * @example html`<${Tabs} label="Backpack" tabs=${[{ id: 'bag', label: 'Bag', content: bagView }, { id: 'gear', label: 'Gear', content: gearView }]} />`
   */
  const Tabs = ({ tabs, selected, onSelect, label, fill = false, class: className }) => {
    const own = useSignal(isSignal(selected) ? undefined : selected);
    const state = isSignal(selected) ? selected : own;
    const groupId = useRef(uid('tabs')).current;
    const list = useRef(null);
    const fallback = tabs.find((tab) => !tab.disabled);
    const current = tabs.find((tab) => tab.id === read(state) && !tab.disabled) || fallback;
    const select = (tab) => {
      state.value = tab.id;
      if (onSelect) onSelect(tab.id);
    };
    const onKeyDown = (event) => {
      const target = rovingIndex(event.key, tabs.indexOf(current), tabs.length, (index) => Boolean(tabs[index].disabled));
      if (target < 0) return;
      event.preventDefault();
      // Arrow keys belong to the tab list here, not to the game underneath.
      event.stopPropagation();
      select(tabs[target]);
      list.current.children[target].focus();
    };
    const panel = current ? (typeof current.content === 'function' ? current.content() : current.content) : null;
    return html`<div class=${classes('ui-tabs', { 'ui-fill': fill }, className)}>
      <div class="ui-tablist" role="tablist" aria-label=${label} ref=${list} onKeyDown=${onKeyDown}>
        ${tabs.map(
          (tab) => html`<button
            type="button"
            role="tab"
            key=${tab.id}
            id=${`${groupId}-tab-${tab.id}`}
            aria-selected=${String(tab === current)}
            aria-controls=${`${groupId}-panel`}
            tabindex=${tab === current ? 0 : -1}
            disabled=${Boolean(tab.disabled)}
            onClick=${(event) => {
              event.stopPropagation();
              Kit.sfx.play('click');
              select(tab);
            }}
          >
            ${tab.label}
          </button>`
        )}
      </div>
      <div class="ui-tabpanel" role="tabpanel" id=${`${groupId}-panel`} aria-labelledby=${current ? `${groupId}-tab-${current.id}` : undefined}>${panel}</div>
    </div>`;
  };

  css(`
    .ui-tabs { display: flex; flex-direction: column; gap: var(--ui-gap); min-width: 0; min-height: 0; pointer-events: auto; }
    .ui-tabs.ui-fill { flex: 1 1 0; }
    .ui-tablist { display: flex; gap: 4px; padding: 3px; background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); overflow-x: auto; scrollbar-width: none; }
    .ui-tablist [role="tab"] {
      flex: 1 0 auto; min-height: var(--ui-hit); padding: 4px 12px; border-radius: calc(var(--radius-lg) - 3px); color: var(--dim);
      font: 700 14px var(--display); transition: background var(--ui-speed), color var(--ui-speed);
    }
    .ui-tablist [role="tab"][aria-selected="true"] { background: var(--accent); color: var(--accent-ink); }
    .ui-tablist [role="tab"]:disabled { opacity: .4; cursor: not-allowed; }
    .ui-tabpanel { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
    .ui-tabs.ui-fill > .ui-tabpanel { flex: 1 1 0; }
  `);

  Kit.ui.Tabs = Tabs;
})();
