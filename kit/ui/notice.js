/**
 * Kit ui notice: telling the player something without stopping them.
 *
 * Owns:  the toast queue (`Kit.ui.notify`: short messages that stack, a few at a time, and leave by themselves)
 *        and the banner queue (`Kit.ui.announce`: one message at a time across the top that stays until it is
 *        dismissed or acted on, the next one following it). Both are live regions, so screen readers speak them.
 * Does not own: the legacy centred callout `ui.toast` (kit/ui.js, an animation themed per game) or modal
 *        results (`ui.banner`). The queue's rules are pure (kit/ui/logic.js) and unit-tested.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, css, signal, mount, Button } = Kit.ui;
  const { createQueue, enqueue, dismiss } = Kit.uiLogic;
  /** Toasts on screen at once; more than this wait their turn, so a burst never covers the play area. */
  const MAX_TOASTS = 3;
  const DEFAULT_TOAST_MS = 2600;

  const toasts = signal(createQueue(MAX_TOASTS));
  const banners = signal(createQueue(1));
  let nextNoticeId = 0;
  let mounted = null;

  const dismissToast = (id) => (toasts.value = dismiss(toasts.value, id));
  const dismissBanner = (id) => (banners.value = dismiss(banners.value, id));

  /** One toast; its timer starts when it reaches the screen, not when it was queued. */
  const Toast = ({ notice }) => {
    Kit.ui.useEffect(() => {
      const timer = setTimeout(() => dismissToast(notice.id), notice.ms);
      return () => clearTimeout(timer);
    }, [notice.id]);
    return html`<div class="ui-toast" data-tone=${notice.tone}>${notice.text}</div>`;
  };

  const BannerView = ({ notice }) =>
    html`<div class="ui-banner" data-tone=${notice.tone}>
      <div class="ui-banner-text"><b>${notice.title}</b>${notice.text ? html`<span>${notice.text}</span>` : null}</div>
      ${notice.action
        ? html`<${Button} variant="primary" onClick=${() => {
            dismissBanner(notice.id);
            notice.action.onClick();
          }}>${notice.action.label}<//>`
        : null}
      <${Button} variant="quiet" onClick=${() => dismissBanner(notice.id)}>Dismiss<//>
    </div>`;

  /** The two regions; mounted once, on first use, at the end of <body>. */
  const Notices = () =>
    html`<div class="ui-notices">
      <div class="ui-banners" role="status" aria-live="polite">${banners.value.showing.map((notice) => html`<${BannerView} key=${notice.id} notice=${notice} />`)}</div>
      <div class="ui-toasts" role="status" aria-live="polite">${toasts.value.showing.map((notice) => html`<${Toast} key=${notice.id} notice=${notice} />`)}</div>
    </div>`;

  const ensureMounted = () => {
    if (!mounted) mounted = mount(html`<${Notices} />`, document.body);
  };

  /**
   * Shows a toast: a short message that leaves by itself. Bursts queue (three on screen at a time).
   * @param {string} text
   * @param {{tone?: 'good'|'warn'|'bad', ms?: number}} [options] `ms`: how long it stays once shown, milliseconds
   * @returns {function(): void} dismiss it early (also works while it is still waiting)
   * @example Kit.ui.notify('Saved'); Kit.ui.notify('Out of bait', { tone: 'warn' });
   */
  const notify = (text, { tone, ms = DEFAULT_TOAST_MS } = {}) => {
    ensureMounted();
    const id = ++nextNoticeId;
    toasts.value = enqueue(toasts.value, { id, text: String(text), tone, ms });
    return () => dismissToast(id);
  };

  /**
   * Shows a banner across the top that stays until dismissed. One at a time; later ones follow in order.
   * @param {{title: string, text?: string, tone?: 'good'|'warn'|'bad', action?: {label: string, onClick: function(): void}}} spec
   * @returns {function(): void} dismiss it
   * @example Kit.ui.announce({ title: 'Table closed', text: 'The host left.', action: { label: 'Rejoin', onClick: rejoin } });
   */
  const announce = ({ title, text, tone, action }) => {
    ensureMounted();
    const id = ++nextNoticeId;
    banners.value = enqueue(banners.value, { id, title, text, tone, action });
    return () => dismissBanner(id);
  };

  /** Drops every toast and banner, shown or waiting (the HUD's dispose() calls this when a game ends). */
  const clearNotices = () => {
    toasts.value = createQueue(MAX_TOASTS);
    banners.value = createQueue(1);
  };

  css(`
    .ui-notices { position: fixed; inset: 0; z-index: 4; pointer-events: none; display: flex; flex-direction: column; justify-content: space-between; align-items: center;
      padding-block: calc(env(safe-area-inset-top, 0px) + 56px) calc(env(safe-area-inset-bottom, 0px) + 96px);
      padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
    .ui-banners, .ui-toasts { display: flex; flex-direction: column; align-items: center; gap: 6px; width: min(460px, 100%); }
    .ui-toast, .ui-banner { color: var(--ink); background: var(--panel); border: var(--border) solid var(--line); box-shadow: var(--shadow); backdrop-filter: blur(var(--blur)); animation: ui-notice-in .18s ease-out; }
    .ui-toast { padding: 8px 14px; border-radius: 999px; font: 600 14px var(--body); max-width: 100%; }
    .ui-banner { pointer-events: auto; width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: var(--ui-gap); padding: 8px var(--ui-pad); border-radius: var(--radius-lg); }
    .ui-banner-text { flex: 1 1 160px; display: flex; flex-direction: column; min-width: 0; }
    .ui-banner-text b { font: 700 15px var(--display); }
    .ui-banner-text span { font-size: 13px; color: var(--dim); }
    [data-tone="good"].ui-toast, [data-tone="good"].ui-banner { border-color: var(--ui-good); }
    [data-tone="warn"].ui-toast, [data-tone="warn"].ui-banner { border-color: var(--accent); }
    [data-tone="bad"].ui-toast, [data-tone="bad"].ui-banner { border-color: var(--hot); }
    @keyframes ui-notice-in { from { opacity: 0; transform: translateY(8px); } }
  `);

  Object.assign(Kit.ui, { notify, announce, clearNotices });
})();
