/**
 * Kit ui meter: numbers a player reads at a glance.
 *
 * Owns:  `Kit.ui.Meter` (a level: health, heat, fuel), `Kit.ui.Progress` (work toward an end, or "working" when
 *        the end is unknown), `Kit.ui.Stat` (a labelled value) and `Kit.ui.Pips` (a count drawn as tokens).
 * Does not own: the legacy HUD's `ui.stat` / `ui.progress` / `ui.pips` (kit/ui.js keeps those calls and their
 *        markup, which game themes style); these are the same ideas as components for new views.
 *
 * Each takes a plain value or a signal. With a signal only the text node or the one style property that shows
 * the value is written when it changes: O(1) per changed value, no re-render.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, classes, css, useComputed } = Kit.ui;
  const { clampFraction } = Kit.uiLogic;
  const PERCENT = 100;

  /** The bar both Meter and Progress draw: a track, a fill sized by --ui-value (0..1), and an optional label. */
  const Bar = ({ role, value, label, color, tone, className }) => {
    const fraction = useComputed(() => clampFraction(read(value)));
    const style = useComputed(() => `--ui-value: ${fraction.value};${color ? ` --ui-fill: ${read(color)};` : ''}`);
    const percent = useComputed(() => Math.round(fraction.value * PERCENT));
    return html`<div class=${classes('ui-bar', className)} role=${role} data-tone=${tone} aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent} style=${style}>
      <i></i>
      ${label ? html`<span>${label}</span>` : null}
    </div>`;
  };

  /**
   * A level between empty and full.
   * @param {{value: number|Object, label?: string, color?: string|Object, tone?: 'good'|'warn'|'bad', class?: string}} props
   *   `value` is a fraction 0..1 (clamped); `color` is a CSS colour for the fill; `tone` picks a semantic colour instead
   * @example html`<${Meter} label="Heat" value=${heat} tone="warn" />`
   */
  const Meter = ({ value, label, color, tone, class: className }) => html`<${Bar} role="meter" value=${value} label=${label} color=${color} tone=${tone} className=${className} />`;

  /**
   * Progress toward an end. Leave `value` out while the end is unknown and it shows a moving "working" stripe.
   * @param {{value?: number|Object, label?: string, color?: string|Object, class?: string}} props `value` is a fraction 0..1
   * @example html`<${Progress} label="Level 2" value=${xpFraction} />`   html`<${Progress} label="Joining table" />`
   */
  const Progress = ({ value, label, color, class: className }) =>
    value === undefined || value === null
      ? html`<div class=${classes('ui-bar', className)} role="progressbar" aria-label=${label} data-indeterminate><i></i>${label ? html`<span>${label}</span>` : null}</div>`
      : html`<${Bar} role="progressbar" value=${value} label=${label} color=${color} className=${className} />`;

  /**
   * A labelled value. Numbers are shortened with Kit.fmt ("1.23K") unless you pass `format`.
   * @param {{label: string, value: *, format?: function(*): string, class?: string}} props
   * @example html`<${Stat} label="Coins" value=${Kit.ui.bind(wallet, (wallet) => wallet.get())} />`
   */
  const Stat = ({ label, value, format = (raw) => (typeof raw === 'number' ? Kit.fmt(raw) : raw), class: className }) => {
    const text = useComputed(() => String(format(read(value))));
    return html`<div class=${classes('ui-stat', className)}><span class="ui-label">${label}</span><b>${text}</b></div>`;
  };

  /**
   * A count drawn as a row of tokens: lives, ammo, charges.
   * @param {{label: string, filled: number|Object, total: number|Object, class?: string}} props
   * @complexity O(total) elements; a change re-renders this row only
   * @example html`<${Pips} label="Lives" filled=${lives} total=${3} />`
   */
  const Pips = ({ label, filled, total, class: className }) => {
    const filledCount = read(filled);
    const totalCount = read(total);
    return html`<div class=${classes('ui-stat ui-pips', className)} role="img" aria-label=${`${label}: ${filledCount} of ${totalCount}`}>
      <span class="ui-label">${label}</span>
      <div class="ui-pip-row">${Array.from({ length: totalCount }, (_, index) => html`<i class="ui-pip" data-on=${index < filledCount ? '' : undefined}></i>`)}</div>
    </div>`;
  };

  css(`
    .ui-bar {
      position: relative; width: 100%; min-width: 60px; height: 16px; overflow: hidden; background: var(--panel);
      border: var(--border) solid var(--line); border-radius: min(8px, var(--radius));
    }
    .ui-bar i { position: absolute; inset: 0; background: var(--ui-fill); transform-origin: left; transform: scaleX(var(--ui-value, 0)); transition: transform var(--ui-speed) ease-out; }
    .ui-bar span { position: absolute; inset: 0; display: grid; place-items: center; font: 700 10px var(--display); letter-spacing: var(--label-spacing); text-transform: var(--label-case); color: var(--ink); }
    .ui-bar[data-tone="good"] { --ui-fill: var(--ui-good); }
    .ui-bar[data-tone="warn"] { --ui-fill: var(--accent); }
    .ui-bar[data-tone="bad"] { --ui-fill: var(--hot); }
    .ui-bar[data-indeterminate] i { inset: 0 auto 0 0; width: 40%; transform: none; animation: ui-working 1.1s ease-in-out infinite alternate; }
    @keyframes ui-working { from { left: 0; } to { left: 60%; } }
    .ui-stat { display: inline-flex; flex-direction: column; gap: 1px; line-height: 1.1; min-width: 52px; padding: 4px 9px; background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); color: var(--ink); }
    .ui-stat b { font: 700 var(--stat-size) var(--display); font-variant-numeric: tabular-nums; }
    .ui-pip-row { display: flex; align-items: center; gap: 4px; min-height: calc(var(--stat-size) * 1.1); }
    .ui-pip { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--dim); transition: background var(--ui-speed); }
    .ui-pip[data-on] { background: var(--ink); border-color: var(--ink); }
  `);

  Object.assign(Kit.ui, { Meter, Progress, Stat, Pips });
})();
