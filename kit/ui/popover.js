/**
 * Kit ui popover: a little more, on request, next to the thing it is about.
 *
 * Owns:  `Kit.ui.Popover` (a button that opens a floating panel: tap or Enter opens it, a tap elsewhere or
 *        Escape closes it; the native popover API, so it sits above everything, dialogs included) and
 *        `Kit.ui.Tooltip` (a short description shown on hover, on keyboard focus and on a touch press).
 * Does not own: menus of commands (use a Sheet with a List on a phone) or modal questions (dialog.js).
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, classes, css, uid, useRef } = Kit.ui;
  const { placePanel } = Kit.uiLogic;

  /**
   * A button with a floating panel.
   * @param {{label: string, children?: *, variant?: string, class?: string}} props `label` is the button's text;
   *   children are the panel's content
   * @example html`<${Popover} label="Drop rates"><p>Common 70%, rare 25%, epic 5%</p><//>`
   */
  const Popover = ({ label, children, class: className }) => {
    const panelId = useRef(uid('popover')).current;
    const button = useRef(null);
    const panel = useRef(null);
    // The panel is laid out when it opens: only then does it have a size to place.
    const onToggle = (event) => {
      if (event.newState !== 'open') return;
      const spot = placePanel(button.current.getBoundingClientRect(), panel.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      panel.current.style.left = `${spot.left}px`;
      panel.current.style.top = `${spot.top}px`;
    };
    return html`<span class=${classes('ui-popover-anchor', className)}>
      <button type="button" class="ui-button" data-variant="default" popovertarget=${panelId} ref=${button} onClick=${(event) => event.stopPropagation()}><span class="ui-button-text">${label}</span></button>
      <div class="ui-popover" id=${panelId} popover="auto" ref=${panel} onToggle=${onToggle}>${children}</div>
    </span>`;
  };

  /**
   * A short description attached to something. Shown on hover and on keyboard focus; on touch, press the target.
   * Wrap something focusable (a Button, a Card with onClick), or pass `focusable` to give plain content a tab stop.
   * @param {{text: string, focusable?: boolean, children?: *}} props
   * @example html`<${Tooltip} text="Doubles ore for 10 s"><${Button}>Surge<//><//>`
   */
  const Tooltip = ({ text, focusable = false, children }) => {
    const tipId = useRef(uid('tip')).current;
    return html`<span class="ui-tooltip" aria-describedby=${tipId} tabindex=${focusable ? 0 : undefined}>
      ${children}
      <span class="ui-tip" role="tooltip" id=${tipId}>${text}</span>
    </span>`;
  };

  css(`
    .ui-popover-anchor { display: inline-flex; pointer-events: auto; }
    .ui-popover {
      position: fixed; inset: auto; margin: 0; max-width: min(300px, calc(100vw - 16px)); padding: var(--ui-pad); color: var(--ink); font: 400 14px var(--body);
      background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow), 0 8px 24px rgba(0, 0, 0, .35); backdrop-filter: blur(var(--blur));
    }
    .ui-popover p { margin: 0; }
    .ui-tooltip { position: relative; display: inline-flex; pointer-events: auto; border-radius: var(--radius); }
    .ui-tooltip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .ui-tip {
      position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); width: max-content; max-width: 220px; padding: 5px 9px; z-index: 3;
      color: var(--ink); background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
      font: 400 12px var(--body); text-align: center; pointer-events: none; opacity: 0; visibility: hidden; transition: opacity var(--ui-speed);
    }
    .ui-tooltip:hover .ui-tip, .ui-tooltip:focus-within .ui-tip, .ui-tooltip:active .ui-tip { opacity: 1; visibility: visible; }
  `);

  Object.assign(Kit.ui, { Popover, Tooltip });
})();
