/**
 * Kit creator panels: the parts of the creator that are not generated from the schema. The Setup tab (body
 * type, name, whole-character actions, the way into saves and sharing, the full look controls) and the two
 * dialogs: saved characters (a sheet) and the share code (a dialog with copy and paste).
 *
 * Owns:  `Kit.creator.SetupView`, `SavesBody`, `ShareBody`, `SPECIES_NOTES` (a sentence per body type, shown as
 *        a tooltip) and the panels' stylesheet.
 * Does not own: saving (kit/creator-slots.js), codes (kit/creator-session.js), the dialog component
 *        (`Kit.ui.openDialog`) or the screen that opens them (kit/creator.js).
 *
 * Every piece of text a person might paste or type (a name, a code) is shown as text, never as markup. Needs the
 * DOM and kit/ui/, so it is exercised in the browser (tools/test-creator-ui.js).
 */
(() => {
  if (!Kit.ui || !Kit.ui.html || !Kit.creator || !Kit.creator.ChoiceStrip) return;
  const { html, useSignal, css, Button, Cluster, Empty, TextField } = Kit.ui;
  const { Icon, ChoiceStrip } = Kit.creator;

  /** A line about each body type of the wardrobe, for its tooltip. A body type the table lacks simply has none. */
  const SPECIES_NOTES = Object.freeze({
    person: 'Balanced proportions: the starting point.',
    stout: 'Shorter and broader, with heavier limbs.',
    lanky: 'Tall and narrow, with long limbs and neck.',
    hornkin: 'Horns, a tail, pointed ears and fantasy skin tones.',
  });
  /** The longest a name field accepts (kept in step with the session's limit). */
  const NAME_FIELD_LIMIT = Kit.creator.NAME_LIMIT;

  /** 'hornkin' -> 'Hornkin'. */
  const titleCase = (id) => id.charAt(0).toUpperCase() + id.slice(1);

  /** The body types of a catalogue as picker choices. */
  const speciesChoices = (catalog) => catalog.speciesIds().map((id) => ({ id, label: titleCase(id), icon: 'figure', hint: SPECIES_NOTES[id] || null }));

  /**
   * The Setup tab.
   * @param {{app: Object}} props `app` carries `session`, `catalog`, `speciesSignal`, `nameSignal`, `look` (from
   *   `lookControls`) and `actions` (`setSpecies`, `setName`, `randomizeAll`, `mirror`, `openSaves`, `openShare`)
   * @returns {Object} a vnode
   */
  const SetupView = ({ app }) => {
    const { speciesSignal, nameSignal, look, actions, catalog } = app;
    const row = { label: 'Body type', choices: speciesChoices(catalog) };
    return html`<${Kit.ui.ScrollPane} fill label="Character" class="cr-pane" id="cr-pane">
      <div class="cr-pane-inner" data-group="setup">
        <div class="cr-pane-head"><h2>Character</h2></div>
        <div class="cr-row">
          <div class="cr-row-head"><span class="ui-label">Body type</span></div>
          <${ChoiceStrip} row=${row} state=${speciesSignal} fallbackIcon="figure" onPick=${actions.setSpecies} />
        </div>
        <${TextField} id="cr-name" label="Name" value=${nameSignal} maxLength=${NAME_FIELD_LIMIT} onInput=${actions.setName} />
        <div class="cr-row">
          <div class="cr-row-head"><span class="ui-label">Whole character</span></div>
          <${Cluster}>
            <${Button} id="cr-randomize-all" variant="primary" class="cr-wide" onClick=${actions.randomizeAll}><${Icon} name="dice" /> <span>Randomise all</span><//>
            <${Button} id="cr-mirror-left" class="cr-wide" onClick=${() => actions.mirror('left')}><${Icon} name="mirror" /> <span>Left to right</span><//>
            <${Button} id="cr-mirror-right" class="cr-wide" onClick=${() => actions.mirror('right')}><${Icon} name="mirror" /> <span>Right to left</span><//>
          <//>
          <p class="cr-note">Lock a control with the padlock beside it and a randomise keeps it.</p>
        </div>
        <div class="cr-row">
          <div class="cr-row-head"><span class="ui-label">Keep and share</span></div>
          <${Cluster}>
            <${Button} id="cr-open-saves" class="cr-wide" onClick=${actions.openSaves}><${Icon} name="save" /> <span>Saved characters</span><//>
            <${Button} id="cr-open-share" class="cr-wide" onClick=${actions.openShare}><${Icon} name="share" /> <span>Share code</span><//>
          <//>
        </div>
        <details class="cr-look" id="cr-look-details">
          <summary>Look settings</summary>
          <div class="cr-look-body"><${Kit.look.panel.LookControls} controls=${look} /></div>
        </details>
      </div>
    <//>`;
  };

  // ---- saved characters ----

  /** A slot's saved date as a short local date. */
  const dateOf = (slot) => new Date(slot.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  /**
   * The saved characters, in a dialog.
   * @param {{slots: Object, describe: function(Object): {chips: string[], speciesLabel: string, problem: ?string}, current: function(): {name: string, code: string}, onOpen: function(Object): void, close: function(): void}} props
   *   `slots` from `Kit.creator.slots`; `describe` turns a slot into chips and a body type (or the problem that stops it opening)
   * @returns {Object} a vnode
   */
  const SavesBody = ({ slots, describe, current, onOpen, close }) => {
    const list = useSignal(slots.list());
    const newName = useSignal(current().name);
    const message = useSignal('');
    const confirmingDelete = useSignal(null);
    const refresh = () => (list.value = slots.list());
    const saveNew = () => {
      const result = slots.save(newName.value, current().code);
      message.value = result.ok ? `Saved ${result.slot.name}.` : result.message;
      refresh();
    };
    const update = (slot) => {
      slots.update(slot.id, current().code);
      message.value = `Replaced ${slot.name} with the current character.`;
      refresh();
    };
    const remove = (slot) => {
      if (confirmingDelete.value !== slot.id) {
        confirmingDelete.value = slot.id;
        return;
      }
      slots.remove(slot.id);
      confirmingDelete.value = null;
      message.value = `Deleted ${slot.name}.`;
      refresh();
    };
    const open = (slot) => {
      onOpen(slot);
      close();
    };
    return html`<div class="cr-saves">
      <div class="cr-save-new">
        <${TextField} id="cr-save-name" label="Save the current character as" value=${newName} maxLength=${NAME_FIELD_LIMIT} />
        <${Button} id="cr-save-new" variant="primary" disabled=${list.value.length >= slots.most} onClick=${saveNew}>Save<//>
      </div>
      <p class="cr-note" role="status" id="cr-save-message">${message.value || `${list.value.length} of ${slots.most} saved.`}</p>
      ${list.value.length
        ? html`<ul class="cr-slot-list" aria-label="Saved characters">
            ${list.value.map((slot) => {
              const info = describe(slot);
              return html`<li class="cr-slot" key=${slot.id} data-slot=${slot.id}>
                <span class="cr-chips" aria-hidden="true">${info.chips.map((chip, index) => html`<i key=${index} style=${`background: ${chip}`}></i>`)}</span>
                <span class="cr-slot-text">
                  <b>${slot.name}</b>
                  <small>${info.problem || `${info.speciesLabel}, ${dateOf(slot)}`}</small>
                </span>
                <span class="cr-slot-buttons">
                  <${Button} class="cr-slot-open" disabled=${Boolean(info.problem)} onClick=${() => open(slot)}>Open<//>
                  <${Button} variant="quiet" label=${`Replace ${slot.name} with the current character`} onClick=${() => update(slot)}>Replace<//>
                  <${Button} variant=${confirmingDelete.value === slot.id ? 'danger' : 'quiet'} label=${`Delete ${slot.name}`} onClick=${() => remove(slot)}>${confirmingDelete.value === slot.id ? 'Sure?' : 'Delete'}<//>
                </span>
              </li>`;
            })}
          </ul>`
        : html`<${Empty} title="No saved characters yet" text="Name the current character above and press Save to keep it here." />`}
    </div>`;
  };

  // ---- the share code ----

  /** Puts text on the clipboard; falls back to selecting it for a manual copy. Resolves to whether it was copied. */
  const copyText = async (text, field) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      field.select();
      return Boolean(document.execCommand && document.execCommand('copy'));
    }
  };

  /**
   * The share dialog: the current character's code with a copy button, and a field to paste a code into.
   * @param {{code: function(): string, onImport: function(string): {ok: boolean, message?: string}, close: function(): void}} props
   * @returns {Object} a vnode
   */
  const ShareBody = ({ code, onImport, close }) => {
    const pasted = useSignal('');
    const problem = useSignal('');
    const copied = useSignal('');
    const yours = code();
    const load = () => {
      const result = onImport(pasted.value);
      problem.value = result.ok ? '' : result.message;
      if (result.ok) close();
    };
    const copy = async (event) => {
      const field = event.currentTarget.parentElement.querySelector('input');
      copied.value = (await copyText(yours, field)) ? 'Copied.' : 'Select the code and copy it by hand.';
    };
    return html`<div class="cr-share">
      <div class="ui-field">
        <label class="ui-label" for="cr-code-out">Your code</label>
        <div class="cr-code-row">
          <input id="cr-code-out" class="ui-input cr-code" readonly value=${yours} onFocus=${(event) => event.target.select()} onKeyDown=${(event) => event.stopPropagation()} />
          <${Button} id="cr-copy" class="cr-wide" onClick=${copy}><${Icon} name="copy" /> <span>Copy</span><//>
        </div>
        <small class="ui-field-note" role="status" id="cr-copy-note">${copied.value || 'Anyone with this code can open this character.'}</small>
      </div>
      <div class="cr-code-row cr-paste">
        <${TextField} id="cr-code-in" label="Open a code" value=${pasted} placeholder="Paste a code here" error=${problem} onInput=${() => (problem.value = '')} />
        <${Button} id="cr-code-load" variant="primary" onClick=${load}>Open<//>
      </div>
    </div>`;
  };

  css(`
    .cr-note { margin: 0; font: 400 12px/1.4 var(--body); color: var(--dim); }
    .cr-look { border: var(--border) solid var(--line); border-radius: var(--radius-lg); padding: 0 12px; }
    .cr-look summary { min-height: var(--ui-hit); display: flex; align-items: center; cursor: pointer; font: 600 14px var(--display); }
    .cr-look summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .cr-look-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 14px; }
    .cr-saves, .cr-share { display: flex; flex-direction: column; gap: 12px; color: var(--ink); }
    .cr-save-new, .cr-code-row { display: flex; align-items: flex-end; gap: 8px; }
    .cr-save-new > .ui-field, .cr-code-row > .ui-field { flex: 1 1 0; }
    .cr-code-row .ui-input { flex: 1 1 0; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
    .cr-slot-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .cr-slot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 10px; border: var(--border) solid var(--line); border-radius: var(--radius-lg); }
    .cr-chips { display: flex; flex: none; border-radius: 6px; overflow: hidden; }
    .cr-chips i { width: 14px; height: 36px; display: block; }
    .cr-slot-text { display: flex; flex-direction: column; flex: 1 1 120px; min-width: 0; }
    .cr-slot-text b { font: 600 15px var(--display); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cr-slot-text small { color: var(--dim); font-size: 12px; }
    .cr-slot-buttons { display: flex; gap: 4px; margin-left: auto; }
    .cr-slot-buttons .ui-button { padding: 4px 10px; font-size: 13px; }
  `);

  Kit.creator = Object.assign(Kit.creator || {}, { SetupView, SavesBody, ShareBody, SPECIES_NOTES, speciesChoices });
})();
