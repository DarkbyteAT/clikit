/**
 * Kit look panel: the controls of the stylised look as reusable pieces, so every screen that draws through a
 * `Kit.look.view` offers the same preset, knob and palette controls in the same panel: the `look` showcase,
 * the `figures` screen and the character creator.
 *
 * Owns:  `Kit.look.panel`: `lookControls(view)` (signals for the preset and every knob, bound to the view),
 *        the components `Choice` (a labelled row of exclusive buttons), `KnobControl` (one knob of
 *        `Kit.look.KNOBS`), `LookControls` (preset, its note and every knob) and `Panel` (the scrollable sheet
 *        at the bottom in portrait and the side in landscape, with hide and show buttons), its stylesheet, and
 *        `freeArea` (the part of the screen the panel leaves for the scene).
 * Does not own: the look (kit/look-*.js), what a screen draws, or its extra rows (palettes, edits), which a
 *        screen passes in as children.
 *
 * Needs the DOM and kit/ui, so it is exercised in the browser (`Kit.play('look')`, `Kit.play('figures')`).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html) return;
  const { html, signal, computed, effect, css, ScrollPane, Button, Cluster, Toggle, Slider } = Kit.ui;

  /** Share of the screen the panel takes: the bottom in portrait, the right side in landscape. */
  const PANEL_SHARE = 0.46;
  /** Height of the shell's top bar the scene must stay clear of, CSS pixels. */
  const TOP_BAR_PIXELS = 52;
  /** Slider readouts are rounded to this many steps per unit. */
  const READOUT_STEPS = 1000;

  css(`
    .look-panel { position: fixed; left: 0; right: 0; bottom: 0; height: ${PANEL_SHARE * 100}%; display: flex; flex-direction: column; pointer-events: auto;
      background: var(--panel); border-top: var(--border) solid var(--line); backdrop-filter: blur(var(--blur)); color: var(--ink); font-family: var(--body); }
    .look-panel-inner { display: flex; flex-direction: column; gap: 12px; padding: 12px max(14px, env(safe-area-inset-right, 0px)) calc(env(safe-area-inset-bottom, 0px) + 16px) max(14px, env(safe-area-inset-left, 0px)); }
    .look-row { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .look-chip { min-height: 40px; padding: 4px 11px; font-size: 13px; }
    .look-note { margin: 0; font-size: 12px; color: var(--dim); }
    .look-hidden { display: none; }
    .look-show-button { position: fixed; pointer-events: auto; right: max(12px, env(safe-area-inset-right, 0px)); bottom: calc(env(safe-area-inset-bottom, 0px) + 12px); }
    @media (orientation: landscape) {
      .look-panel { left: auto; top: 0; width: ${PANEL_SHARE * 100}%; height: auto; border-top: 0; border-left: var(--border) solid var(--line); }
      .look-panel-inner { padding-top: ${TOP_BAR_PIXELS}px; }
    }
  `);

  /**
   * A labelled row of exclusive buttons. `idPrefix` makes each button addressable by tools ('<prefix>-<value>').
   * @param {{label: string, options: Array<{value: *, label: string}>, value: Object, onPick: function(*): void, idPrefix: string}} props `value` is a signal
   * @returns {Object} a vnode
   */
  const Choice = ({ label, options, value, onPick, idPrefix }) =>
    html`<div class="look-row">
      <span class="ui-label">${label}</span>
      <${Cluster} gap="6px">
        ${options.map((option) => html`<${Button} key=${option.value} id=${`${idPrefix}-${option.value}`} class="look-chip" pressed=${computed(() => value.value === option.value)} onClick=${() => onPick(option.value)}>${option.label}<//>`)}
      <//>
    </div>`;

  /**
   * One editor control for a knob row of `Kit.look.KNOBS`, bound to that knob's signal.
   * @param {{knob: Object, value: Object, onChange: function(*): void}} props
   * @returns {Object} a vnode
   */
  const KnobControl = ({ knob, value, onChange }) => {
    if (knob.type === 'choice') return html`<${Choice} label=${knob.label} options=${knob.options} value=${value} onPick=${onChange} idPrefix=${`look-${knob.id}`} />`;
    if (knob.type === 'toggle') return html`<${Toggle} id=${`look-${knob.id}`} label=${knob.label} checked=${value} onChange=${onChange} />`;
    return html`<${Slider} id=${`look-${knob.id}`} label=${knob.label} value=${value} min=${knob.min} max=${knob.max} step=${knob.step} format=${(amount) => String(Math.round(amount * READOUT_STEPS) / READOUT_STEPS)} onInput=${onChange} />`;
  };

  /**
   * @typedef {Object} LookControlState
   * @property {Object} preset signal of the preset id
   * @property {Object<string, Object>} knobs knob id -> signal of its value
   * @property {function(string): void} choosePreset switch preset and reset every knob to its value
   * @property {function(): Object} knobValues knob id -> current value
   * @property {function(): void} stop unbinds the view (call from the screen's dispose)
   */

  /**
   * Signals for the preset and every knob, bound to a view: any change is applied to the view at once.
   * @param {Object} view from `Kit.look.view`
   * @param {string} [presetId='toon']
   * @returns {LookControlState}
   * @complexity O(knobs) to make, and per preset change or knob read
   * @example const controls = Kit.look.panel.lookControls(view); // later: controls.stop()
   */
  const lookControls = (view, presetId = 'toon') => {
    const preset = signal(presetId);
    const knobs = Object.fromEntries(Kit.look.KNOBS.map((knob) => [knob.id, signal(Kit.look.PRESETS[presetId][knob.id])]));
    const knobValues = () => Object.fromEntries(Kit.look.KNOBS.map((knob) => [knob.id, knobs[knob.id].value]));
    const choosePreset = (id) => {
      preset.value = id;
      Kit.look.KNOBS.forEach((knob) => (knobs[knob.id].value = Kit.look.PRESETS[id][knob.id]));
    };
    const stop = effect(() => void view.use(preset.value, knobValues()));
    return { preset, knobs, choosePreset, knobValues, stop };
  };

  /**
   * The preset choice, its description (plus an optional readout signal) and every knob.
   * @param {{controls: LookControlState, readout?: Object, children?: *}} props `children` go between the preset and the knobs (palettes)
   * @returns {Object} a vnode
   * @complexity O(presets + knobs)
   */
  const LookControls = ({ controls, readout, children }) => {
    const presetOptions = Object.keys(Kit.look.PRESETS).map((id) => ({ value: id, label: Kit.look.PRESETS[id].label }));
    return html`
      <${Choice} label="Preset" options=${presetOptions} value=${controls.preset} onPick=${controls.choosePreset} idPrefix="look-preset" />
      <p class="look-note">${computed(() => Kit.look.PRESETS[controls.preset.value].about)} ${readout || ''}</p>
      ${children}
      ${Kit.look.KNOBS.map((knob) => html`<${KnobControl} key=${knob.id} knob=${knob} value=${controls.knobs[knob.id]} onChange=${(value) => (controls.knobs[knob.id].value = value)} />`)}
    `;
  };

  /**
   * The panel: a scrollable sheet (bottom in portrait, right in landscape) with a hide button, and a show
   * button while it is hidden.
   * @param {{isShown: Object, label: string, children: *}} props `isShown` is a boolean signal
   * @returns {Object} a vnode
   */
  const Panel = ({ isShown, label, children }) =>
    html`<div class=${computed(() => (isShown.value ? 'look-panel' : 'look-panel look-hidden'))}>
        <${ScrollPane} fill id="look-scroll" label=${label}>
          <div class="look-panel-inner">
            ${children}
            <${Button} id="look-hide" onClick=${() => (isShown.value = false)}>Hide controls<//>
          </div>
        <//>
      </div>
      <div class=${computed(() => (isShown.value ? 'look-hidden' : 'look-show-button'))}><${Button} id="look-show" onClick=${() => (isShown.value = true)}>Controls<//></div>`;

  /**
   * The part of the screen the panel and the top bar leave for the scene, CSS pixels.
   * @param {{w: number, h: number, portrait: boolean}} size the shell's `ctx.size`
   * @param {boolean} isPanelShown
   * @returns {{width: number, height: number, centerX: number, centerY: number}} its size, and its centre measured from the top left of the screen
   * @complexity O(1)
   * @example const free = Kit.look.panel.freeArea(ctx.size, true);
   */
  const freeArea = (size, isPanelShown) => {
    const panelWidth = isPanelShown && !size.portrait ? size.w * PANEL_SHARE : 0;
    const panelHeight = isPanelShown && size.portrait ? size.h * PANEL_SHARE : 0;
    const width = size.w - panelWidth;
    const height = size.h - panelHeight - TOP_BAR_PIXELS;
    return { width, height, centerX: width / 2, centerY: TOP_BAR_PIXELS + height / 2 };
  };

  Kit.look.panel = { PANEL_SHARE, TOP_BAR_PIXELS, Choice, KnobControl, LookControls, Panel, lookControls, freeArea };
})();
