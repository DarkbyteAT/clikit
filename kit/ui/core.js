/**
 * Kit ui core: the foundation every component in kit/ui/ stands on.
 *
 * Owns:  the template tag (`Kit.ui.html`, htm bound to Preact), reactive state (`signal`, `computed`, `effect`,
 *        `batch`, straight from @preact/signals; `useSignal`, `useComputed`, `useRef`, `useEffect` for component
 *        authors), `bind` (a Kit model in, a signal out), `mount` (a view into the
 *        page, with a dispose handle), the one stylesheet the components share (`css`), and small helpers
 *        (`read`, `classes`, `uid`).
 * Does not own: any component (one file per concern beside this one), the theme tokens (kit/theme.js) or the
 *        legacy HUD calls (kit/ui.js, which now leans on these pieces).
 *
 * Why Preact + htm + signals: see "UI components" in DECISIONS.md. In short: templates with no build step, the
 * same component functions work under JSX later, and a signal read in a template updates only the text node or
 * attribute that reads it, so a HUD bound to game state costs O(values that changed) per frame, not a re-render.
 *
 * A component is a plain function from props to a template. Any prop may be a plain value or a signal:
 *
 *   const { html, signal, mount, Meter } = Kit.ui;
 *   const heat = signal(0.2);
 *   mount(html`<${Meter} label="Heat" value=${heat} />`, ctx.ui.el('div'));
 *   heat.value = 0.8;        // the bar moves; nothing else is touched
 *
 * Needs the DOM; exercised by tools/test-ui.js (in a browser) and the component gallery (Kit.play('gallery')).
 */
(() => {
  const STYLE_ID = 'kit-ui-css';
  /**
   * Tokens only the component library reads. A game overrides them like any theme token (`theme.tokens`).
   * @type {Record<string, string>}
   */
  const UI_TOKEN_DEFAULTS = {
    '--ui-hit': '44px', // smallest size of anything a finger presses
    '--ui-gap': '8px', // space between siblings in a stack, cluster, list or grid
    '--ui-pad': '12px', // inner padding of surfaces
    '--ui-fade': '28px', // length of the fade at a scroll pane's edge when more content lies beyond it
    '--ui-good': '#7ddc8a', // success and "on" states
    '--ui-fill': '#6ea8ff', // default fill of meters and progress bars
    '--ui-speed': '0.16s', // duration of state transitions; 0s under reduced motion
  };

  const libraries = { preact: window.preact, preactHooks: window.preactHooks, htm: window.htm, preactSignals: window.preactSignals };
  const missing = Object.keys(libraries).filter((name) => !libraries[name]);
  if (missing.length) {
    // The legacy HUD and the shell-built menu keep working without the library; say why the rest is absent.
    console.warn(`Kit.ui components are unavailable: ${missing.join(', ')} did not load. Check the script tags above kit/core.js in index.html (and the vendor swaps in tools/smoke.js).`);
    return;
  }
  const { h, render } = libraries.preact;
  const { signal, computed, effect, batch, useSignal, useComputed } = libraries.preactSignals;
  const { useRef, useEffect } = libraries.preactHooks;

  /**
   * The template tag: HTML-like markup in, Preact nodes out. Values are escaped (text is never parsed as HTML);
   * `<${Component} prop=${value} />` renders a component; a signal in a text or attribute position stays live.
   * @example html`<button class="ui-button" onClick=${save}>Save ${count}</button>`
   */
  const html = libraries.htm.bind(h);

  /** Is this a signal (or computed)? */
  const isSignal = (value) => Boolean(value) && typeof value === 'object' && typeof value.peek === 'function';

  /**
   * The current value of a prop that may be a plain value or a signal. Reading a signal inside a component
   * subscribes that component, so it re-renders when the signal changes.
   * @param {*} value
   * @returns {*}
   */
  const read = (value) => (isSignal(value) ? value.value : value);

  /**
   * A signal that follows a Kit model: it recomputes whenever the model announces a change.
   * @param {{on: function(function(): void): *}} model anything with `on(listener)` (Kit.wallet, Kit.upgrades, Kit.goals, Kit.inventory ...)
   * @param {function(Object): *} select what to read from the model; runs once now and once per change
   * @returns {Object} a read-only signal of `select(model)`
   * @example const coins = Kit.ui.bind(wallet, (wallet) => wallet.get()); html`<${Stat} label="Coins" value=${coins} />`
   */
  const bind = (model, select) => {
    if (!model || typeof model.on !== 'function') throw new Error('Kit.ui.bind: the first argument must be a Kit model with on(listener), e.g. Kit.ui.bind(wallet, (wallet) => wallet.get()).');
    const state = signal(select(model));
    model.on(() => (state.value = select(model)));
    return computed(() => state.value);
  };

  /**
   * Space-separated class names from strings and `{ name: condition }` maps; falsy entries are dropped.
   * @example classes('ui-button', { 'is-busy': busy }, props.class) // 'ui-button is-busy primary'
   */
  const classes = (...parts) =>
    parts
      .flatMap((part) => (part && typeof part === 'object' ? Object.keys(part).filter((name) => part[name]) : part ? [part] : []))
      .join(' ');

  let nextId = 0;
  /** A page-unique element id, for wiring labels, tabs and popovers to what they describe. */
  const uid = (prefix = 'ui') => `${prefix}-${++nextId}`;

  /** The shared <style> element; each component file appends its rules once, when it loads. */
  const styleElement = () => {
    const existing = document.getElementById(STYLE_ID);
    if (existing) return existing;
    const created = document.createElement('style');
    created.id = STYLE_ID;
    const tokens = Object.entries(UI_TOKEN_DEFAULTS).map(([name, value]) => `${name}: ${value};`).join(' ');
    // Reduced motion: state changes still happen, they just do not animate.
    created.textContent = `:root { ${tokens} }\n@media (prefers-reduced-motion: reduce) { :root { --ui-speed: 0s; } [class^="ui-"], [class*=" ui-"] { animation: none !important; scroll-behavior: auto !important; } }\n`;
    document.head.appendChild(created);
    return created;
  };

  /**
   * Adds a component's rules to the library stylesheet. Called once per component file at load.
   * @param {string} rules plain CSS; read colours, type and shape from the theme tokens so every skin restyles it
   */
  const css = (rules) => {
    styleElement().append(rules + '\n');
  };

  /**
   * Renders a view into the page and returns a handle to remove it. The view gets its own host element (laid out
   * as if it were not there), so several mounts can share one parent.
   * @param {*} view a template (`html\`...\``)
   * @param {Element} parent where the host is appended
   * @returns {{el: HTMLElement, dispose: function(): void}} `el` is the host; `dispose` unmounts the view and removes it
   * @example const gauge = Kit.ui.mount(html`<${Meter} value=${heat} />`, document.getElementById('hud-layer')); gauge.dispose();
   */
  const mount = (view, parent) => {
    if (!(parent instanceof Element)) throw new Error('Kit.ui.mount: the second argument must be the element to render into, e.g. Kit.ui.mount(view, ctx.ui.el("div")).');
    const host = document.createElement('div');
    host.className = 'ui-host';
    parent.appendChild(host);
    render(view, host);
    return {
      el: host,
      dispose() {
        render(null, host);
        host.remove();
      },
    };
  };

  css(`
    .ui-host { display: contents; }
    [class^="ui-"], [class*=" ui-"] { box-sizing: border-box; }
    .ui-label { font: 600 11px var(--body); letter-spacing: var(--label-spacing); text-transform: var(--label-case); color: var(--dim); }
    .ui-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `);

  Object.assign(Kit.ui, { html, h, signal, computed, effect, batch, useSignal, useComputed, useRef, useEffect, isSignal, read, bind, classes, uid, css, mount, UI_TOKEN_DEFAULTS });
})();
