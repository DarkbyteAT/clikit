/**
 * Kit ui field: the controls a person sets a value with.
 *
 * Owns:  `Kit.ui.TextField` (a labelled text or search input), `Kit.ui.Toggle` (an on / off switch) and
 *        `Kit.ui.Slider` (a number in a range). All three are native inputs, so the keyboard, the on-screen
 *        keyboard, autofill and assistive technology already know them.
 * Does not own: validation rules (pass `error` to show the message your rule produced).
 *
 * `value` / `checked` may be a signal you own: the control writes to it as the person changes it, and shows it
 * when you change it. Key presses inside a control never reach the game underneath.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, read, isSignal, classes, css, uid, useRef } = Kit.ui;

  /** Writes a control's new value into the caller's signal (when there is one) and tells the caller. */
  const report = (target, value, onChange) => {
    if (isSignal(target)) target.value = value;
    if (onChange) onChange(value);
  };

  /** Typing must not steer the game: its key handlers listen on window (kit/input.js). */
  const keepFromGame = (event) => event.stopPropagation();

  /**
   * A labelled text input.
   * @param {Object} props
   * @param {string} props.label always given; `hideLabel` keeps it for screen readers only
   * @param {string|Object} [props.value] the text, plain or a signal
   * @param {function(string): void} [props.onInput] called with the text on every edit
   * @param {'text'|'search'|'number'} [props.type='text']
   * @param {string} [props.placeholder]
   * @param {string} [props.hint] a line of help under the field
   * @param {string|Object} [props.error] a problem to show instead of the hint (marks the field invalid)
   * @param {number} [props.maxLength]
   * @example html`<${TextField} label="Find a game" type="search" value=${query} placeholder="Search" hideLabel />`
   */
  const TextField = ({ label, value, onInput, type = 'text', placeholder, hint, error, maxLength, hideLabel = false, id, class: className }) => {
    const fieldId = useRef(id || uid('field')).current;
    const problem = read(error);
    const note = problem || hint;
    return html`<div class=${classes('ui-field', className)}>
      <label class=${classes('ui-label', { 'ui-visually-hidden': hideLabel })} for=${fieldId}>${label}</label>
      <input
        id=${fieldId}
        class="ui-input"
        type=${type}
        value=${read(value)}
        placeholder=${placeholder}
        maxlength=${maxLength}
        autocomplete="off"
        enterkeyhint=${type === 'search' ? 'search' : undefined}
        aria-invalid=${problem ? 'true' : undefined}
        aria-describedby=${note ? `${fieldId}-note` : undefined}
        onInput=${(event) => report(value, event.target.value, onInput)}
        onKeyDown=${keepFromGame}
        onKeyUp=${keepFromGame}
      />
      ${note ? html`<small id=${`${fieldId}-note`} class="ui-field-note" data-error=${problem ? '' : undefined}>${note}</small>` : null}
    </div>`;
  };

  /**
   * An on / off switch (a checkbox announced as a switch).
   * @param {{label: string, checked?: boolean|Object, onChange?: function(boolean): void, disabled?: boolean, id?: string, class?: string}} props
   * @example html`<${Toggle} label="Screen shake" checked=${shakeEnabled} />`
   */
  const Toggle = ({ label, checked, onChange, disabled, id, class: className }) =>
    html`<label class=${classes('ui-toggle', className)}>
      <input
        id=${id}
        type="checkbox"
        role="switch"
        checked=${Boolean(read(checked))}
        disabled=${Boolean(read(disabled))}
        onChange=${(event) => {
          Kit.sfx.play('click');
          report(checked, event.target.checked, onChange);
        }}
        onKeyDown=${keepFromGame}
      />
      <i aria-hidden="true"></i>
      <span>${label}</span>
    </label>`;

  /**
   * A number picked from a range. Arrow keys step it; a finger drags it.
   * @param {Object} props
   * @param {string} props.label
   * @param {number|Object} props.value plain or a signal
   * @param {number} [props.min=0]
   * @param {number} [props.max=1]
   * @param {number} [props.step=0.01]
   * @param {function(number): void} [props.onInput] called with the number as it moves
   * @param {function(number): string} [props.format] how the value is written beside the label (default: a percentage of the range)
   * @example html`<${Slider} label="Music" value=${musicVolume} />`
   */
  const Slider = ({ label, value, min = 0, max = 1, step = 0.01, onInput, format, disabled, id, class: className }) => {
    const fieldId = useRef(id || uid('slider')).current;
    const current = Number(read(value));
    const fraction = (current - min) / (max - min || 1);
    const shown = format ? format(current) : `${Math.round(fraction * 100)}%`;
    return html`<div class=${classes('ui-field ui-slider', className)}>
      <label class="ui-label" for=${fieldId}><span>${label}</span><output for=${fieldId}>${shown}</output></label>
      <input
        id=${fieldId}
        type="range"
        min=${min}
        max=${max}
        step=${step}
        value=${current}
        disabled=${Boolean(read(disabled))}
        style=${`--ui-value: ${fraction}`}
        onInput=${(event) => report(value, Number(event.target.value), onInput)}
        onKeyDown=${keepFromGame}
      />
    </div>`;
  };

  css(`
    .ui-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; pointer-events: auto; }
    .ui-input {
      min-height: var(--ui-hit); width: 100%; padding: 8px var(--ui-pad); color: var(--ink); background: var(--panel); border: var(--border) solid var(--line);
      border-radius: var(--radius); font: 400 16px var(--body); -webkit-user-select: text; user-select: text; appearance: none;
    }
    .ui-input::placeholder { color: var(--dim); opacity: .8; }
    .ui-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .ui-input[aria-invalid="true"] { border-color: var(--hot); }
    .ui-field-note { font-size: 12px; color: var(--dim); }
    .ui-field-note[data-error] { color: var(--hot); }
    .ui-toggle { pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; min-height: var(--ui-hit); cursor: pointer; color: var(--ink); position: relative; }
    .ui-toggle input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
    .ui-toggle i { flex: none; width: 46px; height: 26px; border-radius: 13px; background: var(--panel); border: var(--border) solid var(--line); position: relative; transition: background var(--ui-speed); }
    .ui-toggle i::after { content: ""; position: absolute; top: 50%; left: 3px; width: 18px; height: 18px; margin-top: -9px; border-radius: 50%; background: var(--dim); transition: transform var(--ui-speed), background var(--ui-speed); }
    .ui-toggle input:checked + i { background: var(--accent); border-color: var(--accent-edge); }
    .ui-toggle input:checked + i::after { transform: translateX(20px); background: var(--accent-ink); }
    .ui-toggle input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 2px; }
    .ui-toggle input:disabled ~ * { opacity: .5; }
    .ui-slider label { display: flex; justify-content: space-between; gap: var(--ui-gap); }
    .ui-slider output { color: var(--ink); font-variant-numeric: tabular-nums; }
    .ui-slider input { width: 100%; height: var(--ui-hit); margin: 0; background: none; accent-color: var(--accent); touch-action: pan-y; cursor: pointer; }
    .ui-slider input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius); }
    .ui-slider input:disabled { opacity: .5; }
  `);

  Object.assign(Kit.ui, { TextField, Toggle, Slider });
})();
