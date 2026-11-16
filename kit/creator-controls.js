/**
 * Kit creator controls: the interface generated from the rows of a schema. A row of kind `dial` becomes sliders,
 * `color` a grid of swatches that show the real ramp tones, `socket` a scrolling strip of option cards (None
 * first); a tab per group holds its rows. Nothing here names a body part: a new control in the catalogue is a new
 * row and gets a view from the table `ROW_VIEWS`.
 *
 * Owns:  `Kit.creator.controlHost` (the bridge between a session and the views: one signal per field, one per
 *        lock, the row structure as a signal, and the actions the views call), the row views (`DialControl`,
 *        `ColorControl`, `SocketControl`), `GroupPane` and `ControlTabs`, and their stylesheet.
 * Does not own: what an edit does (kit/creator-session.js), the rows (kit/creator-rows.js), the stage around the
 *        character (kit/creator-stage.js) or the screen (kit/creator.js).
 *
 * Why signals per field: a slider drag changes one value, so exactly one slider and one readout update; the page
 * is not rebuilt. The row structure is a signal too, but it changes only when `structureKey` does (a part with
 * sockets, a pair unlinked, a body type), and then only the open pane redraws.
 *
 * Needs the DOM and kit/ui/, so it is exercised in the browser (tools/test-creator-ui.js).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.creator || !Kit.creator.Icon) return;
  const { html, signal, batch, css, useRef, useEffect, Button, ScrollPane, Tabs, Grid, Slider, Empty } = Kit.ui;
  const { Icon } = Kit.creator;
  const { dialReadout, isAtDefault, swatchGradient, isDoubleTap, valuesOf, structureKey } = Kit.creator.rows;
  const { rovingIndex } = Kit.uiLogic;

  /** A press that moves further than this is a drag, not a tap (CSS pixels). */
  const TAP_SLOP_PX = 8;
  /** The tab that is not a group of the catalogue: body type, name, whole-character actions, saves, sharing and the look. */
  const SETUP_TAB = 'setup';

  /**
   * @typedef {Object} ControlHost
   * @property {Object} groups signal of the `RowGroup[]`; replaced only when the row structure changes
   * @property {function(string): Object} value signal of a field's current value, by field key
   * @property {function(string): Object} lock signal (boolean) of a field's lock
   * @property {function(string, number): void} queueDial remember a slider's newest value; `flush` applies it on the next frame
   * @property {function(): boolean} flush apply queued slider values as one edit each; true when something was applied
   * @property {function(): void} beginGesture a drag starts: its edits are one undo step until `endGesture`
   * @property {function(): void} endGesture apply what is queued and let the next drag start a new undo step
   * @property {function(string, number): void} setColor
   * @property {function(string, ?string): void} setSocket
   * @property {function(Object): void} resetRow put every slider of a dial row at its default
   * @property {function(Object, Object): void} resetSlider put one slider at its default
   * @property {function(Object): void} toggleLock
   * @property {function(Object): void} toggleLink
   * @property {function(): void} sync re-read the session into the signals (call after anything done to the session directly)
   * @property {function(function(): void): void} act run a session change, then sync and notify
   */

  /**
   * Connects a session to the views.
   * @param {{session: Object, onEdit?: function(): void, onInput?: function(): void}} options `onEdit` runs after every change that
   *   reached the session; `onInput` when a slider value is queued (a screen uses it to time input to figure)
   * @returns {ControlHost}
   * @complexity sync is O(controls); the views re-render only for the signals that changed
   * @example const host = Kit.creator.controlHost({ session, onEdit: () => (isDirty = true) });
   */
  const controlHost = ({ session, onEdit = () => {}, onInput = () => {} }) => {
    const values = new Map();
    const locks = new Map();
    const pendingDials = new Map();
    const signalIn = (map, key, initial) => {
      if (!map.has(key)) map.set(key, signal(initial));
      return map.get(key);
    };
    const structureOf = () => structureKey(session.groups(), session.recipe().species);
    const groups = signal(session.groups());
    let shape = structureOf();

    const sync = () =>
      batch(() => {
        const current = valuesOf(session.schema());
        Object.keys(current).forEach((key) => {
          signalIn(values, key, current[key]).value = current[key];
        });
        // Values first, so a row that appears with the new structure finds its signals already there.
        const fresh = structureOf();
        if (fresh !== shape) {
          shape = fresh;
          groups.value = session.groups();
        }
        locks.forEach((state, key) => (state.value = session.isLocked(key)));
      });
    const act = (change) => {
      change();
      sync();
      onEdit();
    };
    sync();

    const self = {
      groups,
      sync,
      act,
      value: (key) => signalIn(values, key, valuesOf(session.schema())[key]),
      lock: (key) => signalIn(locks, key, session.isLocked(key)),
      queueDial(setId, value) {
        pendingDials.set(setId, value);
        onInput();
      },
      beginGesture() {
        self.flush();
        session.beginGesture();
      },
      endGesture() {
        self.flush();
        session.endGesture();
      },
      flush() {
        if (!pendingDials.size) return false;
        const queued = [...pendingDials];
        pendingDials.clear();
        act(() => queued.forEach(([setId, value]) => session.setDial(setId, value)));
        return true;
      },
      setColor: (channel, rampIndex) => act(() => session.setColor(channel, rampIndex)),
      setSocket: (path, partId) => act(() => session.setSocket(path, partId)),
      resetSlider: (_row, slider) => act(() => session.resetDial(slider)),
      resetRow: (row) => act(() => row.sliders.forEach((slider) => session.resetDial(slider))),
      toggleLock: (row) => act(() => session.toggleLock(row.lockKeys)),
      toggleLink: (row) => act(() => session.toggleLink(row.base)),
    };
    return self;
  };

  // ---- the buttons every row shares ----

  /**
   * The small buttons at the end of a row: reset (dials), link (sided dials) and lock. Each is 44 px square.
   * @param {{row: Object, host: ControlHost, canReset?: boolean}} props
   * @returns {Object} a vnode
   */
  const RowTools = ({ row, host, canReset = false }) => {
    const isLocked = row.lockKeys.every((key) => host.lock(key).value);
    return html`<div class="cr-tools">
      ${row.kind === 'dial'
        ? html`<${Button} class="cr-tool" variant="quiet" label=${`Reset ${row.label.toLowerCase()} to default`} disabled=${!canReset} onClick=${() => host.resetRow(row)}><${Icon} name="reset" /><//>`
        : null}
      ${row.isSided
        ? html`<${Button}
            class="cr-tool"
            variant="quiet"
            pressed=${row.isLinked}
            label=${row.isLinked ? `Let left and right ${row.label.toLowerCase()} differ` : `Link left and right ${row.label.toLowerCase()}`}
            onClick=${() => host.toggleLink(row)}
            ><${Icon} name=${row.isLinked ? 'link' : 'unlink'} /><//
          >`
        : null}
      <${Button} class="cr-tool" variant="quiet" pressed=${isLocked} label=${`Keep ${row.label.toLowerCase()} when randomising`} onClick=${() => host.toggleLock(row)}><${Icon} name=${isLocked ? 'lock' : 'unlock'} /><//>
    </div>`;
  };

  // ---- dials ----

  /**
   * One slider of a dial row: label and readout, the track with a tick at the default, and a double tap that resets.
   * @param {{row: Object, slider: Object, host: ControlHost}} props
   * @returns {Object} a vnode
   */
  const DialSlider = ({ row, slider, host }) => {
    const state = host.value(slider.valueKey);
    const lastTap = useRef(null);
    const pressedAt = useRef(null);
    const defaultFraction = (slider.default - slider.min) / (slider.max - slider.min || 1);
    const label = slider.caption ? `${row.label}, ${slider.caption.toLowerCase()}` : row.label;
    const onPointerDown = (event) => {
      host.beginGesture();
      pressedAt.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event) => {
      host.endGesture();
      const start = pressedAt.current;
      pressedAt.current = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
      const tap = { at: event.timeStamp, x: event.clientX, y: event.clientY };
      if (isDoubleTap(lastTap.current, tap)) {
        lastTap.current = null;
        host.resetSlider(row, slider);
      } else lastTap.current = tap;
    };
    return html`<div class="cr-slider" style=${`--cr-default: ${defaultFraction}`} data-changed=${isAtDefault(slider, state.value) ? undefined : ''} title=${row.hint || undefined} onPointerDown=${onPointerDown} onPointerUp=${onPointerUp} onPointerCancel=${() => host.endGesture()}>
      <${Slider}
        id=${`cr-slider-${slider.setId}`}
        label=${label}
        value=${state}
        min=${slider.min}
        max=${slider.max}
        step=${slider.step}
        format=${(value) => dialReadout(slider, value)}
        onInput=${(value) => host.queueDial(slider.setId, value)}
      />
    </div>`;
  };

  /** A dial row: its slider (two while a sided pair is unlinked) and the row's tools beside the first. */
  const DialControl = ({ row, host }) => {
    const canReset = row.sliders.some((slider) => !isAtDefault(slider, host.value(slider.valueKey).value));
    return html`<div class="cr-row cr-dial" data-row=${row.id} data-kind="dial">
      ${row.sliders.map(
        (slider, index) => html`<div class="cr-dial-line" key=${slider.setId}>
          <${DialSlider} row=${row} slider=${slider} host=${host} />
          ${index === 0 ? html`<${RowTools} row=${row} host=${host} canReset=${canReset} />` : null}
        </div>`
      )}
    </div>`;
  };

  // ---- colours ----

  /** A colour row: one swatch per ramp of the channel, each showing every tone the shader will use. */
  const ColorControl = ({ row, host }) => {
    const state = host.value(row.valueKeys[0]);
    const items = row.ramps.map((ramp, index) => ({ id: index, ramp }));
    const current = row.ramps[state.value] || row.ramps[0];
    return html`<div class="cr-row cr-color" data-row=${row.id} data-kind="color">
      <div class="cr-row-head">
        <span class="cr-row-title"><span class="ui-label">${row.label}</span><span class="cr-current">${current.id}</span></span>
        <${RowTools} row=${row} host=${host} />
      </div>
      <${Grid}
        class="cr-swatches"
        label=${row.label}
        items=${items}
        selected=${state}
        minWidth="44px"
        onSelect=${(rampIndex) => host.setColor(row.channel, rampIndex)}
        render=${(item) => html`<span class="cr-swatch" title=${item.ramp.id} style=${`background: ${swatchGradient(item.ramp.shades)}`}></span>`}
      />
    </div>`;
  };

  // ---- sockets ----

  /** Scrolls a strip so its checked card is centred, but only when the card is not fully in view (so a tap never moves the strip). */
  const revealChecked = (strip) => {
    const scroller = strip.closest('.ui-scroll');
    const checked = strip.querySelector('[aria-checked="true"]');
    if (!scroller || !checked) return;
    // Bounding boxes, not offsetLeft: the strip's offset parent is not the scroller, so offsets would not share its origin.
    const card = checked.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const isOutside = card.left < box.left || card.right > box.right;
    if (isOutside) scroller.scrollLeft += card.left - box.left - (box.width - card.width) / 2;
  };

  /**
   * A strip of option cards, one checked: arrow keys move and choose, Tab leaves it.
   * @param {{row: Object, state: Object, fallbackIcon: ?string, onPick: function(?string): void}} props `state` is a signal of the checked id
   * @returns {Object} a vnode
   */
  const ChoiceStrip = ({ row, state, fallbackIcon, onPick }) => {
    const strip = useRef(null);
    const checkedId = state.value === undefined ? null : state.value;
    useEffect(() => {
      if (strip.current) revealChecked(strip.current);
    }, [checkedId]);
    const onKeyDown = (event) => {
      const cards = [...strip.current.children];
      const index = cards.indexOf(event.target);
      const target = index < 0 ? -1 : rovingIndex(event.key, index, cards.length);
      if (target < 0) return;
      event.preventDefault();
      event.stopPropagation();
      onPick(row.choices[target].id);
      cards[target].focus();
    };
    return html`<${ScrollPane} axis="x" label=${row.label} class="cr-strip-scroll">
      <div class="cr-strip" role="radiogroup" aria-label=${row.label} ref=${strip} onKeyDown=${onKeyDown}>
        ${row.choices.map((choice) => {
          const isChecked = choice.id === checkedId;
          return html`<button
            type="button"
            role="radio"
            class="cr-card"
            key=${choice.id === null ? 'none' : choice.id}
            aria-checked=${String(isChecked)}
            tabindex=${isChecked ? 0 : -1}
            title=${choice.hint || undefined}
            onClick=${() => onPick(choice.id)}
          >
            <${Icon} name=${choice.id === null ? 'none' : choice.icon || fallbackIcon} size=${24} />
            <span>${choice.label}</span>
          </button>`;
        })}
      </div>
    <//>`;
  };

  /** A socket row: a strip of what fits (None first when allowed); a nested socket is indented under its parent. */
  const SocketControl = ({ row, host, fallbackIcon }) => {
    const state = host.value(row.valueKeys[0]);
    const current = row.choices.find((choice) => choice.id === state.value);
    const pick = (partId) => {
      state.value = partId;
      host.setSocket(row.path, partId);
    };
    return html`<div class="cr-row cr-socket" data-row=${row.id} data-kind="socket" data-depth=${row.depth} style=${`--cr-depth: ${row.depth}`}>
      <div class="cr-row-head">
        <span class="cr-row-title"><span class="ui-label">${row.label}</span><span class="cr-current">${current ? current.label : ''}</span></span>
        <${RowTools} row=${row} host=${host} />
      </div>
      <${ChoiceStrip} row=${row} state=${state} fallbackIcon=${fallbackIcon} onPick=${pick} />
    </div>`;
  };

  /**
   * Row kind -> its view. A kind the catalogue adds later needs a row here and nothing else.
   * @type {Object<string, function(Object): Object>}
   */
  const ROW_VIEWS = { dial: DialControl, color: ColorControl, socket: SocketControl };

  // ---- a group's pane and the tabs ----

  /**
   * One group: a heading, "randomise this group", and its rows in a scrolling pane.
   * @param {{group: Object, host: ControlHost, onRandomize: function(string): void}} props
   * @returns {Object} a vnode
   */
  const GroupPane = ({ group, host, onRandomize }) => {
    const rows = group.rows.filter((row) => ROW_VIEWS[row.kind]);
    return html`<${ScrollPane} fill id="cr-pane" label=${`${group.label} controls`} class="cr-pane">
      <div class="cr-pane-inner" data-group=${group.id}>
        <div class="cr-pane-head">
          <h2>${group.label}</h2>
          <${Button} id="cr-randomize-group" class="cr-wide" onClick=${() => onRandomize(group.id)}><${Icon} name="dice" /> <span>Randomise ${group.label.toLowerCase()}</span><//>
        </div>
        ${rows.length
          ? rows.map((row) => {
              const View = ROW_VIEWS[row.kind];
              return html`<${View} key=${row.id} row=${row} host=${host} fallbackIcon=${group.icon} />`;
            })
          : html`<${Empty} title="Nothing to change here" text="This area has no controls yet." />`}
      </div>
    <//>`;
  };

  /** A tab's label: its icon above its name. */
  const tabLabel = (icon, text) => html`<${Icon} name=${icon} size=${20} /><span>${text}</span>`;

  /**
   * The tab strip and the open tab's panel: the Setup tab first, then one tab per group of the schema.
   * @param {{host: ControlHost, selected: Object, onSelect: function(string): void, onRandomize: function(string): void, setupView: function(): Object}} props
   *   `selected` is a signal of the open tab's id; `setupView` builds the Setup tab's content
   * @returns {Object} a vnode
   */
  const ControlTabs = ({ host, selected, onSelect, onRandomize, setupView }) => {
    const tabs = [
      { id: SETUP_TAB, label: tabLabel('user', 'Character'), content: setupView },
      ...host.groups.value.map((group) => ({ id: group.id, label: tabLabel(group.icon, group.label), content: () => html`<${GroupPane} group=${group} host=${host} onRandomize=${onRandomize} />` })),
    ];
    return html`<${Tabs} fill class="cr-tabs" label="Parts of the character" tabs=${tabs} selected=${selected} onSelect=${onSelect} />`;
  };

  css(`
    .cr-tabs { flex: 1 1 0; min-height: 0; gap: 0; }
    /* Scroll shadows: a soft edge appears only on a side that has more tabs beyond it (the "local" layers scroll with the tabs, the "scroll" ones stay). */
    .cr-tabs .ui-tablist {
      border-radius: 0; border-width: 0 0 var(--border) 0; padding: 4px 8px; gap: 2px; background-color: var(--panel);
      background-image: linear-gradient(to right, var(--panel), var(--panel)), linear-gradient(to left, var(--panel), var(--panel)), linear-gradient(to right, rgba(134, 217, 195, .3), transparent), linear-gradient(to left, rgba(134, 217, 195, .3), transparent);
      background-position: left, right, left, right; background-repeat: no-repeat; background-size: 20px 100%, 20px 100%, 14px 100%, 14px 100%;
      background-attachment: local, local, scroll, scroll;
    }
    .cr-tabs .ui-tablist [role="tab"] { flex-direction: column; display: flex; align-items: center; justify-content: center; gap: 2px; min-width: 64px; padding: 4px 10px; font: 600 11px/1.1 var(--body); border-radius: var(--radius); }
    .cr-tabs .ui-tablist [role="tab"]:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .cr-tabs .ui-tabpanel { flex: 1 1 0; min-height: 0; }
    .cr-pane { padding: 0 max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px)); }
    .cr-pane-inner { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 calc(24px + env(safe-area-inset-bottom, 0px)); }
    .cr-pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: var(--ui-hit); }
    .cr-pane-head h2 { margin: 0; font: 600 18px var(--display); }
    .cr-wide { flex-direction: row; gap: 8px; padding: 6px 12px; font-size: 14px; }
    .cr-wide .ui-button-text { display: inline-flex; align-items: center; gap: 8px; }
    .cr-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-bottom: 8px; border-bottom: var(--border) solid var(--line); }
    .cr-row:last-child { border-bottom: 0; }
    .cr-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: var(--ui-hit); }
    .cr-row-title { display: flex; flex-direction: column; min-width: 0; }
    .cr-current { color: var(--ink); font: 500 14px var(--body); text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cr-tools { flex: none; display: flex; align-items: center; justify-content: flex-end; }
    .cr-tool { min-width: var(--ui-hit); min-height: var(--ui-hit); padding: 0; text-decoration: none; }
    .cr-tool[aria-pressed="true"] { color: var(--accent); border-color: transparent; transform: none; margin-bottom: 0; }
    .cr-tool:disabled { opacity: .3; }
    .cr-dial { gap: 2px; }
    .cr-dial-line { display: flex; align-items: flex-end; gap: 2px; }
    .cr-dial-line > .cr-slider { flex: 1 1 0; min-width: 0; }
    .cr-dial-line > .cr-tools { height: var(--ui-hit); }
    .cr-slider { position: relative; }
    .cr-slider .ui-slider { gap: 0; }
    .cr-slider .ui-slider label { min-height: 20px; align-items: baseline; }
    /* The tick marks where the default sits on the track (the thumb is about 20px wide, so the track runs 10px in from each end). */
    .cr-slider::after { content: ""; position: absolute; bottom: 14px; width: 2px; height: 16px; border-radius: 1px; background: var(--dim); opacity: .55; left: calc(10px + var(--cr-default) * (100% - 20px) - 1px); pointer-events: none; }
    .cr-slider[data-changed] .ui-slider output { color: var(--accent); }
    .cr-swatches.ui-collection[data-layout="grid"] { grid-template-columns: repeat(auto-fill, 44px); gap: 6px; }
    .cr-swatches .ui-option { padding: 0; width: 44px; height: 44px; min-height: 44px; border-radius: var(--radius); border-width: 2px; }
    .cr-swatches .ui-option[aria-selected="true"] { border-color: var(--ink); box-shadow: 0 0 0 2px var(--accent); }
    .cr-swatches .ui-option[aria-selected="true"]::after { display: none; }
    .cr-swatch { display: block; width: 100%; height: 100%; border-radius: calc(var(--radius) - 2px); }
    .cr-socket[data-depth="1"], .cr-socket[data-depth="2"] { margin-left: 14px; padding-left: 10px; border-left: 2px solid var(--accent); }
    .cr-strip-scroll { margin: 0 -4px; }
    .cr-strip { display: flex; gap: 8px; padding: 4px; width: max-content; }
    .cr-card {
      pointer-events: auto; flex: none; width: 92px; height: 76px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px 6px;
      color: var(--dim); background: var(--panel); border: var(--border) solid var(--line); border-radius: var(--radius-lg); font: 500 12px/1.15 var(--body); text-align: center;
      transition: border-color var(--ui-speed), color var(--ui-speed), background var(--ui-speed);
    }
    .cr-card span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cr-card[aria-checked="true"] { color: var(--ink); border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .cr-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `);

  Kit.creator = Object.assign(Kit.creator || {}, { controlHost, RowTools, DialControl, ColorControl, SocketControl, ChoiceStrip, GroupPane, ControlTabs, ROW_VIEWS, SETUP_TAB });
})();
