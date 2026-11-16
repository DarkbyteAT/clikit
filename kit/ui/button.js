/**
 * Kit ui button: the one pressable control.
 *
 * Owns:  `Kit.ui.Button`: a native <button> with variants (default, primary, quiet, danger) and the states a
 *        button can be in: pressed (a toggle), disabled, busy.
 * Does not own: what a press does. Menus of buttons are a `Cluster` (layout.js); a row of exclusive choices is `Tabs`.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, classes, css } = Kit.ui;

  /**
   * A button. Any prop may be a signal.
   * @param {Object} props
   * @param {'default'|'primary'|'quiet'|'danger'} [props.variant='default']
   * @param {boolean} [props.pressed] makes it a toggle and shows it held down (aria-pressed)
   * @param {boolean} [props.disabled]
   * @param {boolean} [props.busy] work is under way: shows a spinner and ignores presses
   * @param {string} [props.sub] a small second line (a price, a shortcut)
   * @param {function(MouseEvent): void} [props.onClick]
   * @param {?string} [props.sound='click'] Kit.sfx name played on a press; null for silence
   * @param {string} [props.label] accessible name, for a button whose content is not text
   * @param {string} [props.id]
   * @param {string} [props.class] extra CSS classes
   * @param {*} [props.children] the button's content
   * @example
   * html`<${Button} variant="primary" onClick=${save} busy=${isSaving}>Save<//>`
   * html`<${Button} pressed=${isMuted} onClick=${toggleMute}>Mute<//>`
   */
  const Button = ({ variant = 'default', pressed, disabled, busy, sub, onClick, sound = 'click', label, id, class: className, children }) => {
    const isBusy = Boolean(read(busy));
    const isPressed = read(pressed);
    const press = (event) => {
      // Presses stay out of the game's canvas input.
      event.stopPropagation();
      if (isBusy) return;
      if (sound) Kit.sfx.play(sound);
      if (onClick) onClick(event);
    };
    return html`<button
      type="button"
      id=${id}
      class=${classes('ui-button', className)}
      data-variant=${variant}
      aria-pressed=${isPressed === undefined ? undefined : String(Boolean(isPressed))}
      aria-busy=${isBusy ? 'true' : undefined}
      aria-label=${label}
      disabled=${Boolean(read(disabled))}
      onClick=${press}
    >
      <span class="ui-button-text">${children}</span>
      ${read(sub) ? html`<small>${read(sub)}</small>` : null}
    </button>`;
  };

  css(`
    .ui-button {
      pointer-events: auto; min-height: var(--ui-hit); min-width: var(--ui-hit); padding: 6px 14px; display: inline-flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 1px; position: relative; color: var(--ink); background: var(--panel);
      border: var(--border) solid var(--line); border-bottom-width: calc(var(--border) + 2px); border-radius: var(--radius-lg);
      box-shadow: var(--shadow); font: 700 15px var(--display); transition: transform var(--ui-speed), opacity var(--ui-speed), background var(--ui-speed);
    }
    .ui-button small { font: 600 11px var(--body); color: var(--accent); font-variant-numeric: tabular-nums; }
    .ui-button:active:not(:disabled), .ui-button[aria-pressed="true"] { transform: translateY(2px); border-bottom-width: var(--border); margin-bottom: 2px; }
    .ui-button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    .ui-button[data-variant="primary"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent-edge); }
    .ui-button[data-variant="primary"] small { color: inherit; }
    .ui-button[data-variant="quiet"] { background: transparent; border-color: transparent; box-shadow: none; text-decoration: underline; text-underline-offset: 3px; }
    .ui-button[data-variant="danger"] { border-color: var(--hot); color: var(--hot); }
    .ui-button:disabled { opacity: .5; filter: saturate(.4); cursor: not-allowed; }
    .ui-button[aria-busy="true"] { cursor: progress; }
    .ui-button[aria-busy="true"] .ui-button-text { opacity: .35; }
    .ui-button[aria-busy="true"]::after {
      content: ""; position: absolute; width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
      animation: ui-spin .7s linear infinite;
    }
    @keyframes ui-spin { to { transform: rotate(1turn); } }
  `);

  Kit.ui.Button = Button;
})();
