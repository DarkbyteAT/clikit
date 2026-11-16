/**
 * Kit creator stage: the part of the screen the character stands in, as components. A gesture layer (drag to
 * turn, pinch or wheel to zoom, arrow keys and + / - for the keyboard), a left rail (undo, redo), a right rail
 * (zoom, hold-to-compare, the performance picker), the character's name, and the quick look presets.
 *
 * Owns:  `Kit.creator.StageGestures`, `StageRails`, `StageTitle`, `LookChips`, `HoldButton` and the stage
 *        stylesheet. Each is a component over plain props, so a screen composes them and a test can mount one.
 * Does not own: the camera maths (kit/creator-camera.js), the 3D view (kit/creator.js) or the controls panel
 *        (kit/creator-controls.js).
 *
 * Needs the DOM and kit/ui/, so it is exercised in the browser (tools/test-creator-ui.js).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.creator || !Kit.creator.Icon) return;
  const { html, css, useRef, Button } = Kit.ui;
  const { Icon } = Kit.creator;
  const { pinchFactor, yawFromDrag, ZOOM_STEP, TURN_STEP } = Kit.creator.camera;

  /** Keys the stage answers to when it has focus, by `event.key`: what each does to the camera. */
  const STAGE_KEYS = {
    ArrowLeft: (director) => director.turnTo(director.target().yaw - TURN_STEP),
    ArrowRight: (director) => director.turnTo(director.target().yaw + TURN_STEP),
    '+': (director) => director.zoomBy(ZOOM_STEP),
    '=': (director) => director.zoomBy(ZOOM_STEP),
    '-': (director) => director.zoomBy(1 / ZOOM_STEP),
    Home: (director) => {
      director.zoomTo('full');
      director.turnTo(0);
    },
  };
  /** Asks the browser to send every later event of this pointer to the element; a pointer that is already gone is ignored. */
  const capturePointer = (event) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer ended before the handler ran: there is nothing to capture, and nothing to do about it.
    }
  };
  /** One mouse wheel notch zooms by this much (wheel up zooms in). */
  const WHEEL_ZOOM = 0.9;

  /**
   * The layer that turns drags and pinches into camera moves. It fills the stage and sits under the rails.
   * @param {{director: Object, label: string}} props `director` from `Kit.creator.camera.director`
   * @returns {Object} a vnode
   * @example html`<${StageGestures} director=${director} label="Character preview" />`
   */
  const StageGestures = ({ director, label }) => {
    const pointers = useRef(new Map());
    const distanceOf = () => {
      const [first, second] = [...pointers.current.values()];
      return Math.hypot(first.x - second.x, first.y - second.y);
    };
    const onPointerDown = (event) => {
      capturePointer(event);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };
    const onPointerMove = (event) => {
      const known = pointers.current.get(event.pointerId);
      if (!known) return;
      const before = pointers.current.size === 2 ? distanceOf() : 0;
      const dx = event.clientX - known.x;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) director.turnBy(yawFromDrag(dx));
      else if (pointers.current.size === 2) director.zoomBy(pinchFactor(before, distanceOf()));
    };
    const onPointerEnd = (event) => pointers.current.delete(event.pointerId);
    const onWheel = (event) => {
      event.preventDefault();
      director.zoomBy(event.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM);
    };
    const onKeyDown = (event) => {
      const action = STAGE_KEYS[event.key];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action(director);
    };
    return html`<div
      id="cr-view"
      class="cr-view"
      tabindex="0"
      role="group"
      aria-label=${label}
      aria-description="Drag to turn. Pinch or press plus and minus to zoom. Left and right arrow keys turn."
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerEnd}
      onPointerCancel=${onPointerEnd}
      onWheel=${onWheel}
      onKeyDown=${onKeyDown}
    ></div>`;
  };

  /**
   * A button that is "on" only while it is held (pointer or Space / Enter), for looking at the character before
   * this session's edits. It lets go when the pointer leaves, is cancelled, or the button loses focus.
   * @param {{held: Object, label: string, icon: string, id?: string, children?: *}} props `held` a boolean signal this writes
   * @returns {Object} a vnode
   */
  const HoldButton = ({ held, label, icon, id, children }) => {
    const press = () => (held.value = true);
    const release = () => (held.value = false);
    const onKeyDown = (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      press();
    };
    const onKeyUp = (event) => {
      if (event.key === ' ' || event.key === 'Enter') release();
    };
    return html`<button
      type="button"
      id=${id}
      class="ui-button cr-tool cr-hold"
      data-variant="quiet"
      aria-pressed=${String(held.value)}
      aria-label=${label}
      onPointerDown=${(event) => {
        capturePointer(event);
        press();
      }}
      onPointerUp=${release}
      onPointerCancel=${release}
      onLostPointerCapture=${release}
      onKeyDown=${onKeyDown}
      onKeyUp=${onKeyUp}
      onBlur=${release}
      onContextMenu=${(event) => event.preventDefault()}
    >
      <span class="ui-button-text"><${Icon} name=${icon} />${children}</span>
    </button>`;
  };

  /**
   * The rails of tools beside the character.
   * @param {{director: Object, status: Object, held: Object, performance: ?Object, choices: function(): Object[], onUndo: function(): void, onRedo: function(): void}} props
   *   `status` a signal of `{ canUndo, canRedo }`; `held` the compare signal; `performance` a signal of the chosen
   *   performance's id with `choices` reading its rows (kit/creator-perform.js), or null when the preview cannot move
   * @returns {Object} a vnode
   */
  const StageRails = ({ director, status, held, performance, choices, onUndo, onRedo }) => {
    const { canUndo, canRedo } = status.value;
    return html`
      <div class="cr-rail cr-rail-left">
        <${Button} id="cr-undo" class="cr-tool" label="Undo" disabled=${!canUndo} onClick=${onUndo}><${Icon} name="undo" /><//>
        <${Button} id="cr-redo" class="cr-tool" label="Redo" disabled=${!canRedo} onClick=${onRedo}><${Icon} name="redo" /><//>
      </div>
      <div class="cr-rail cr-rail-right">
        <${Button} id="cr-zoom-in" class="cr-tool" label="Zoom in" onClick=${() => director.zoomBy(ZOOM_STEP)}><${Icon} name="plus" /><//>
        <${Button} id="cr-zoom-out" class="cr-tool" label="Zoom out" onClick=${() => director.zoomBy(1 / ZOOM_STEP)}><${Icon} name="minus" /><//>
        <${HoldButton} id="cr-compare" held=${held} label="Hold to see the character as this session began" icon="eye" />
        ${performance ? html`<${Kit.creator.PerformPicker} choice=${performance} choices=${choices} />` : null}
      </div>`;
  };

  /**
   * The character's name and body type at the top of the stage, and a "before" tag while comparing.
   * @param {{status: Object, held: Object}} props `status` a signal of `{ name, speciesLabel, isChanged }`
   * @returns {Object} a vnode
   */
  const StageTitle = ({ status, held }) => {
    const { name, speciesLabel, isChanged } = status.value;
    return html`<div class="cr-title" aria-live="polite">
      <b id="cr-name-shown">${name}</b>
      <span>${held.value ? 'Before this session' : `${speciesLabel}${isChanged ? ', edited' : ''}`}</span>
    </div>`;
  };

  /**
   * The quick look presets under the character: three buttons that reuse `Kit.look.panel`'s controls state.
   * @param {{controls: Object}} props `controls` from `Kit.look.panel.lookControls(view)`
   * @returns {Object} a vnode
   */
  const LookChips = ({ controls }) =>
    html`<div class="cr-looks" role="group" aria-label="Look">
      ${Object.keys(Kit.look.PRESETS).map(
        (id) => html`<${Button} key=${id} id=${`cr-look-${id}`} class="cr-chip" pressed=${controls.preset.value === id} onClick=${() => controls.choosePreset(id)}>${Kit.look.PRESETS[id].label}<//>`
      )}
    </div>`;

  css(`
    .cr-stage { position: relative; min-width: 0; min-height: 0; pointer-events: none; }
    .cr-view { position: absolute; inset: 0; pointer-events: auto; touch-action: none; cursor: grab; outline-offset: -3px; -webkit-user-select: none; user-select: none; }
    .cr-view:active { cursor: grabbing; }
    .cr-view:focus-visible { outline: 2px solid var(--accent); }
    .cr-rail { position: absolute; top: 56px; display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
    .cr-rail-left { left: max(10px, env(safe-area-inset-left, 0px)); }
    .cr-rail-right { right: max(10px, env(safe-area-inset-right, 0px)); }
    .cr-rail .cr-tool, .cr-rail .cr-hold { border-radius: var(--radius-lg); background: var(--panel); border: var(--border) solid var(--line); box-shadow: none; }
    .cr-rail .cr-tool:disabled { opacity: .35; }
    .cr-hold { display: inline-flex; align-items: center; justify-content: center; min-width: var(--ui-hit); min-height: var(--ui-hit); padding: 0; color: var(--ink); touch-action: none; -webkit-user-select: none; user-select: none; text-decoration: none; }
    .cr-hold[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); transform: none; margin-bottom: 0; }
    .cr-hold .ui-button-text { display: inline-flex; }
    .cr-title { position: absolute; top: 10px; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; pointer-events: none; text-align: center; padding: 0 96px; }
    .cr-title b { font: 600 17px/1.2 var(--display); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0, 0, 0, .55); }
    .cr-title span { font: 500 12px var(--body); color: var(--dim); text-shadow: 0 1px 6px rgba(0, 0, 0, .55); }
    .cr-looks { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
    .cr-chip { min-height: var(--ui-hit); padding: 4px 14px; font: 600 13px var(--body); border-radius: 999px; box-shadow: none; white-space: nowrap; }
    .cr-chip .ui-button-text { white-space: nowrap; }
  `);

  Kit.creator = Object.assign(Kit.creator || {}, { StageGestures, HoldButton, StageRails, StageTitle, LookChips });
})();
