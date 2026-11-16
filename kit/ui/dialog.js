/**
 * Kit ui dialog: something that takes over until it is dealt with.
 *
 * Owns:  `Kit.ui.Dialog` (a centred card) and `Kit.ui.Sheet` (the same thing rising from the bottom edge, for
 *        long content on a phone), both on the native <dialog>: the browser traps focus inside, makes the rest
 *        of the page inert, closes on Escape and gives focus back to whatever had it. `Kit.ui.openDialog` shows
 *        one without writing a component and returns a promise of its result.
 * Does not own: pausing the game (ctx.ui.dialog does that for a running game) or the legacy modal (`ui.choose`,
 *        `ui.banner`, `ui.panel` in kit/ui.js, which share the native element but keep their own markup).
 *
 * The body is a ScrollPane, so content taller than the screen scrolls inside the dialog and never behind it.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, isSignal, classes, css, uid, signal, mount, useRef, useEffect, ScrollPane, Button } = Kit.ui;

  /**
   * A modal dialog.
   * @param {Object} props
   * @param {boolean|Object} props.open whether it is showing: a signal you own (it is set false when the dialog closes), or a plain boolean
   * @param {string} props.title
   * @param {function(*=): void} [props.onClose] called with the value passed to `close(value)`, or undefined when dismissed
   * @param {boolean} [props.dismissable=true] may Escape, the backdrop and the corner button close it? Pass false when an answer is required
   * @param {'dialog'|'sheet'} [props.variant='dialog']
   * @param {*|function(function(*=): void): *} [props.children] the body: a template, or a function of `close`
   * @param {*|function(function(*=): void): *} [props.actions] the button row under the body, same shapes
   * @example
   * const isOpen = signal(false);
   * html`<${Dialog} open=${isOpen} title="Sell all fish?" actions=${(close) => html`<${Button} variant="primary" onClick=${() => close('sell')}>Sell<//>`}>You keep the rare ones.<//>`
   */
  const Dialog = ({ open, title, onClose, dismissable = true, variant = 'dialog', class: className, children, actions }) => {
    const element = useRef(null);
    const titleId = useRef(uid('dialog')).current;
    /** The value given to close(); read by the native close event, which also fires for Escape. */
    const result = useRef(undefined);
    const isOpen = Boolean(read(open));
    useEffect(() => {
      const dialog = element.current;
      if (isOpen && !dialog.open) dialog.showModal();
      if (!isOpen && dialog.open) dialog.close();
    }, [isOpen]);
    const close = (value) => {
      result.current = value;
      element.current.close();
    };
    const onNativeClose = () => {
      if (isSignal(open)) open.value = false;
      if (onClose) onClose(result.current);
      result.current = undefined;
    };
    // A press that lands on the <dialog> itself is on the backdrop: the card covers everything inside it.
    const onBackdrop = (event) => event.target === element.current && dismissable && close();
    const part = (content) => (typeof content === 'function' ? content(close) : content);
    const body = [].concat(children || []).map(part);
    return html`<dialog
      class=${classes('ui-dialog', className)}
      data-variant=${variant}
      aria-labelledby=${titleId}
      ref=${element}
      onClose=${onNativeClose}
      onCancel=${(event) => !dismissable && event.preventDefault()}
      onClick=${onBackdrop}
      onKeyDown=${(event) => event.stopPropagation()}
    >
      <div class="ui-dialog-card">
        <header>
          <h2 id=${titleId}>${title}</h2>
          ${dismissable ? html`<${Button} variant="quiet" label="Close" class="ui-dialog-x" onClick=${() => close()}>Close<//>` : null}
        </header>
        <${ScrollPane} class="ui-dialog-body" label=${title}>${body}<//>
        ${actions ? html`<footer>${part(actions)}</footer>` : null}
      </div>
    </dialog>`;
  };

  /**
   * A dialog that rises from the bottom edge and spans the width: the phone-friendly home for long or tall
   * content (an inventory, settings, a shop). Same props as Dialog.
   * @example html`<${Sheet} open=${isBagOpen} title="Backpack">${bagView}<//>`
   */
  const Sheet = (props) => html`<${Dialog} ...${props} variant="sheet" />`;

  /**
   * Shows a dialog right now and resolves when it closes. No component needed.
   * @param {Object} spec
   * @param {string} spec.title
   * @param {*|function(function(*=): void): *} [spec.body] a template or a function of `close`
   * @param {*|function(function(*=): void): *} [spec.actions]
   * @param {'dialog'|'sheet'} [spec.variant='dialog']
   * @param {boolean} [spec.dismissable=true]
   * @returns {Promise<*>} the value passed to `close(value)`; undefined when dismissed
   * @example
   * const answer = await Kit.ui.openDialog({ title: 'Leave the table?', actions: (close) => html`<${Button} onClick=${() => close('leave')}>Leave<//>` });
   */
  const openDialog = ({ title, body, actions, variant, dismissable }) => {
    if (!title) throw new Error('Kit.ui.openDialog: `title` is required (it names the dialog for screen readers), e.g. openDialog({ title: "Backpack", body }).');
    const isOpen = signal(true);
    return new Promise((resolve) => {
      const mounted = mount(
        html`<${Dialog} open=${isOpen} title=${title} variant=${variant} dismissable=${dismissable} actions=${actions} onClose=${(value) => {
          // Unmount after the close event has finished, so focus has already gone back to the opener.
          queueMicrotask(() => mounted.dispose());
          resolve(value);
        }}>${body}<//>`,
        document.body
      );
      openDialog.dismissAll.push(() => (isOpen.value = false));
    });
  };
  /** Closers of dialogs opened through openDialog; the HUD's dispose() runs them when a game ends. */
  openDialog.dismissAll = [];

  css(`
    .ui-dialog {
      padding: 0; border: 0; background: none; color: var(--ink); font-family: var(--body); max-width: none; max-height: none; overflow: visible;
      width: min(420px, calc(100% - 32px)); margin: auto; pointer-events: auto;
    }
    .ui-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
    .ui-dialog[open] { animation: ui-dialog-in .2s cubic-bezier(.2, 1.2, .4, 1); }
    @keyframes ui-dialog-in { from { opacity: 0; transform: translateY(12px) scale(.96); } }
    .ui-dialog-card {
      display: flex; flex-direction: column; gap: var(--ui-gap); padding: var(--ui-pad); max-height: calc(100dvh - 48px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
      background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow); backdrop-filter: blur(var(--blur));
    }
    .ui-dialog-card > header { display: flex; align-items: center; justify-content: space-between; gap: var(--ui-gap); }
    .ui-dialog-card h2 { margin: 0; font: 700 22px var(--display); text-wrap: balance; }
    .ui-dialog-x { flex: none; font-size: 13px; }
    .ui-dialog-body { display: flex; flex-direction: column; gap: var(--ui-gap); color: var(--dim); }
    .ui-dialog-card > footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--ui-gap); }
    /* Sheet: pinned to the bottom edge, full width, and padded past the home indicator. */
    .ui-dialog[data-variant="sheet"] { width: 100%; max-width: 560px; margin: auto auto 0; }
    .ui-dialog[data-variant="sheet"] .ui-dialog-card {
      max-height: calc(86dvh - env(safe-area-inset-top, 0px)); border-bottom: 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      padding-bottom: calc(var(--ui-pad) + env(safe-area-inset-bottom, 0px));
      padding-left: max(var(--ui-pad), env(safe-area-inset-left, 0px)); padding-right: max(var(--ui-pad), env(safe-area-inset-right, 0px));
    }
    .ui-dialog[data-variant="sheet"][open] { animation-name: ui-sheet-in; }
    @keyframes ui-sheet-in { from { transform: translateY(40%); opacity: 0; } }
  `);

  Object.assign(Kit.ui, { Dialog, Sheet, openDialog });
})();
