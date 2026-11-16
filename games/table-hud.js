// Lampwick Table - HUD components: the initiative ribbon, the dock (tools, game master palette, dice tray, roll log),
// zoom keys, the distance readout and the character sheet.
//
// Owns:  building those elements and re-rendering them from plain view models. Each component is a factory that
//        takes the game's `ui` and a table of handlers, and returns the few verbs the game needs.
// Does not own: what a press means (games/table.js passes handlers), shared state, or styling (games/table-theme.js).
// Text from other players only ever reaches the page through textContent.
(() => {
  const { STATS, CONDITIONS, TERRAIN, LIMITS } = Kit.tabletop;

  // ---- tables ------------------------------------------------------------------------------------------------------

  /** Tools every player has. `hint` is shown in the status line while the tool is selected. */
  const PLAY_TOOLS = [
    { id: 'move', label: 'Move', hint: 'Drag a piece to move it, the table to pan. Tap doors.' },
    { id: 'ruler', label: 'Ruler', hint: 'Drag to measure. Everyone sees your ruler.' },
    { id: 'area', label: 'Area', hint: 'Drag out an area. Press Area again to change its shape.' },
    { id: 'ping', label: 'Ping', hint: 'Tap the table to point something out.' },
    { id: 'ink', label: 'Ink', hint: 'Draw on the table. Press Ink again to erase.' },
  ];
  /** Map brushes of the game master palette: one per terrain row that can be painted. */
  const GM_BRUSHES = Object.entries(TERRAIN).map(([character, terrain]) => ({ id: 'paint:' + character, label: terrain.label, hint: `Drag across cells to lay ${terrain.label.toLowerCase()}.` }));
  /** Game master tools that are not brushes. `isTool` ones stay selected; the rest act once when pressed. */
  const GM_ACTIONS = [
    { id: 'harm', label: 'Harm' },
    { id: 'heal', label: 'Heal' },
    { id: 'scenes', label: 'Scenes' },
    { id: 'foe', label: 'Add foe', isTool: true, hint: 'Tap a cell to place a new creature there.' },
    { id: 'order', label: 'Roll order' },
    { id: 'fog', label: 'Fog' },
    { id: 'undo', label: 'Undo' },
  ];
  /** Dice on the tray, by number of sides. Anything else (d100, pools, modifiers) is typed as notation. */
  const TRAY_DICE = [4, 6, 8, 10, 12, 20].map((sides) => ({ sides, label: String(sides) }));
  /** Hit point steppers on the sheet. */
  const HP_STEPS = [-5, -1, 1, 5];
  /** Ways to roll a check from the sheet. `mode` is what Kit.dice.check takes. */
  const CHECK_MODES = [
    { mode: 'dis', label: 'Hindered' },
    { mode: null, label: 'Plain' },
    { mode: 'adv', label: 'Favoured' },
  ];
  /** Rolls kept on screen. */
  const LOG_LINES = 3;
  const signed = (value) => (value >= 0 ? '+' : '') + value;

  /**
   * A button that plays the kit's click and never lets the press fall through to the board.
   * @param {function(string, string=, string=): HTMLElement} element   ui.h
   * @param {string} className
   * @param {string} label
   * @param {function(): void} onPress
   * @returns {HTMLButtonElement}
   */
  function pressKey(element, className, label, onPress) {
    const button = element('button', className, label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      Kit.sfx.play('click');
      onPress();
    });
    return button;
  }

  // ---- initiative ribbon -------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} RibbonModel
   * @property {number|null} round            null while no turn order has been rolled
   * @property {Array<{id: string, name: string, color: string, score: number, isActing: boolean, isMine: boolean}>} entries
   * @property {boolean} canEndTurn           the viewer may press "End turn"
   * @property {boolean} canRollOrder         the viewer may roll a new order (game masters)
   */
  /**
   * The turn order as one strip across the top: who acts now (on vellum), who is next, and the key that passes the turn.
   * @param {Object} ui
   * @param {{onPick: function(string): void, onEndTurn: function(): void, onRollOrder: function(): void}} handlers
   * @returns {{render: function(RibbonModel): void}}
   */
  function ribbon(ui, handlers) {
    const strip = ui.el('div', 'tt-ribbon');
    const chipFor = (entry) => {
      const chip = pressKey(ui.h, 'tt-chip' + (entry.isActing ? ' is-acting' : '') + (entry.isMine ? ' is-mine' : ''), undefined, () => handlers.onPick(entry.id));
      const dot = ui.h('i');
      dot.style.setProperty('--c', entry.color);
      chip.append(dot, ui.h('span', null, entry.name), ui.h('b', null, String(entry.score)));
      return chip;
    };
    return {
      render(model) {
        strip.textContent = '';
        if (model.round === null) {
          strip.append(ui.h('span', 'tt-round', 'No turn order yet'));
          if (model.canRollOrder) strip.append(pressKey(ui.h, 'tt-key', 'Roll order', handlers.onRollOrder));
          return;
        }
        strip.append(ui.h('span', 'tt-round', 'Round ' + model.round), ...model.entries.map(chipFor));
        const endTurn = pressKey(ui.h, 'tt-key', 'End turn', handlers.onEndTurn);
        endTurn.disabled = !model.canEndTurn;
        strip.append(endTurn);
        const acting = strip.querySelector('.is-acting');
        if (acting) strip.scrollLeft = Math.max(0, acting.offsetLeft - strip.clientWidth / 3); // keep the acting chip in view on narrow screens
      },
    };
  }

  // ---- the dock ----------------------------------------------------------------------------------------------------

  /**
   * One rolled die as a small face: struck through when dropped, tinted on its top or bottom value.
   * @param {Object} ui
   * @param {{value: number, sides: number, isKept: boolean}} die
   */
  function faceFor(ui, die) {
    const tint = !die.isKept ? ' is-dropped' : die.value === die.sides ? ' is-top' : die.value === 1 ? ' is-bottom' : '';
    return ui.h('span', 'tt-face' + tint, String(die.value));
  }

  /**
   * The bottom dock: roll log, status line, game master palette, tool keys and the dice tray.
   * @param {Object} ui
   * @param {Object} handlers
   * @param {function(string): void} handlers.onTool         a tool id from PLAY_TOOLS, GM_BRUSHES or a GM action with isTool
   * @param {function(string): void} handlers.onGmAction     a one-shot GM action id
   * @param {function(): void} handlers.onSheet
   * @param {function(): void} handlers.onGmView             toggle between game master view and player view
   * @param {function(string): boolean} handlers.onRoll      roll this notation; returns false when it does not parse
   * @param {function(): void} handlers.onLog                the roll log was pressed
   * @returns {Object} { setTool, setGm, setStatus, setLastRoll, addRoll, hintFor }
   */
  function dock(ui, handlers) {
    const element = ui.h;
    const root = ui.el('div', 'tt-dock');
    const log = element('div', 'tt-log'), status = element('div', 'tt-status');
    log.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onLog();
    });
    /** Keys whose label carries the latest roll's total, by action id. */
    const amountKeys = new Map();
    const gmRow = element('div', 'tt-row'), toolRow = element('div', 'tt-row'), diceRow = element('div', 'tt-row');
    const toolKeys = new Map();
    const allTools = [...PLAY_TOOLS, ...GM_BRUSHES, ...GM_ACTIONS.filter((action) => action.isTool)];

    const toolKey = (tool, className) => {
      const key = pressKey(element, className, tool.label, () => handlers.onTool(tool.id));
      toolKeys.set(tool.id, key);
      return key;
    };
    const gmViewKey = pressKey(element, 'tt-key', 'GM', handlers.onGmView);
    gmViewKey.title = 'Game master view';
    toolRow.append(...PLAY_TOOLS.map((tool) => toolKey(tool, 'tt-key is-wide')), pressKey(element, 'tt-key', 'Sheet', handlers.onSheet), gmViewKey);
    // Actions come before the brushes: they are used all session long, the brushes mostly while preparing a scene.
    gmRow.append(
      ...GM_ACTIONS.map((action) => {
        if (action.isTool) return toolKey(action, 'tt-key');
        const key = pressKey(element, 'tt-key', action.label, () => handlers.onGmAction(action.id));
        amountKeys.set(action.id, { key, label: action.label });
        return key;
      }),
      ...GM_BRUSHES.map((brush) => toolKey(brush, 'tt-key'))
    );

    const notation = element('input', 'tt-notation');
    notation.type = 'text';
    notation.placeholder = '2d6+3';
    notation.maxLength = Kit.dice.LIMITS.TEXT_LENGTH;
    notation.setAttribute('aria-label', 'Dice notation');
    const rollTyped = () => {
      const isValid = notation.value.trim() !== '' && handlers.onRoll(notation.value);
      notation.classList.toggle('is-wrong', !isValid);
    };
    notation.addEventListener('keydown', (event) => {
      event.stopPropagation(); // typing must not reach the kit's keyboard controls
      if (event.key === 'Enter') rollTyped();
    });
    const dieKey = (die) => {
      const button = pressKey(element, 'tt-die', die.label, () => handlers.onRoll('1d' + die.sides));
      button.dataset.sides = die.sides; // the theme cuts each button to its die's silhouette by this
      button.title = 'd' + die.sides;
      return button;
    };
    diceRow.append(...TRAY_DICE.map(dieKey), notation, pressKey(element, 'tt-key', 'Roll', rollTyped));

    root.append(log, status, gmRow, toolRow, diceRow);
    return {
      /** The hint text of a tool id, or '' for an unknown one. */
      hintFor: (toolId) => (allTools.find((tool) => tool.id === toolId) || { hint: '' }).hint,
      /** Mark one tool key as selected. */
      setTool(toolId) {
        toolKeys.forEach((key, id) => key.classList.toggle('is-on', id === toolId));
      },
      /**
       * @param {{canBeGm: boolean, isGmView: boolean}} gm  whether the GM-view key is offered, and whether the palette shows
       */
      setGm({ canBeGm, isGmView }) {
        gmViewKey.hidden = !canBeGm;
        gmViewKey.classList.toggle('is-on', isGmView);
        gmRow.hidden = !isGmView;
      },
      /**
       * Show the latest roll's total on the keys that apply it ("Harm 11", "Heal 11").
       * @param {number|null} total  null when there is no roll to apply yet
       */
      setLastRoll(total) {
        ['harm', 'heal'].map((id) => amountKeys.get(id)).forEach(({ key, label }) => {
          key.textContent = total === null ? label : `${label} ${total}`;
          key.disabled = total === null;
        });
      },
      /** One calm line of guidance or refusal above the keys. */
      setStatus(text, isAlert = false) {
        status.textContent = text;
        status.hidden = !text;
        status.classList.toggle('is-alert', isAlert);
      },
      /**
       * Add a roll to the log: who, what for, every die, the total.
       * @param {{who: string, label: string, result: Object}} entry  result is a Kit.dice RollResult
       */
      addRoll({ who, label, result }) {
        const line = element('div', 'tt-roll');
        line.append(element('span', null, who), element('em', null, label || result.text), ...result.dice.slice(0, LIMITS.TURN_ORDER_LENGTH).map((die) => faceFor(ui, die)), element('strong', null, String(result.total)));
        log.append(line);
        [...log.children].slice(0, -LOG_LINES).forEach((old) => old.remove());
      },
    };
  }

  /**
   * Zoom keys on the right edge (the kit has no pinch gesture).
   * @param {Object} ui
   * @param {function(number): void} onZoom  called with +1 (closer) or -1 (further)
   */
  function zoomKeys(ui, onZoom) {
    const column = ui.el('div', 'tt-zoom');
    column.append(Object.assign(pressKey(ui.h, 'tt-key', '+', () => onZoom(1)), { title: 'Zoom in' }), Object.assign(pressKey(ui.h, 'tt-key', '−', () => onZoom(-1)), { title: 'Zoom out' }));
  }

  /**
   * A small label that follows the finger with a distance.
   * @param {Object} ui
   * @returns {{show: function(string, number, number, boolean=): void, hide: function(): void}}
   */
  function readout(ui) {
    const label = ui.el('div', 'tt-readout');
    label.hidden = true;
    /** Pixels the label sits above the finger so it is not covered by it. */
    const FINGER_CLEARANCE = 46;
    return {
      hide: () => (label.hidden = true),
      show(text, screenX, screenY, isFar = false) {
        label.textContent = text;
        label.classList.toggle('is-far', isFar);
        label.style.transform = `translate(${screenX}px, ${screenY - FINGER_CLEARANCE}px) translate(-50%, -100%)`;
        label.hidden = false;
      },
    };
  }

  // ---- character sheet ---------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} SheetModel
   * @property {Object} token        cleaned Token
   * @property {Object} sheet        cleaned Sheet
   * @property {string} caption      who the piece is ("Player character - yours")
   * @property {boolean} canEdit     the viewer may change this piece (its owner, or a game master)
   * @property {boolean} isGm        show the game master's controls
   * @property {string} gmNotes      the game master's private notes on this piece (kept on their device only)
   */
  /**
   * @typedef {Object} SheetHandlers
   * @property {function(Object): boolean} onToken      write these token fields; false when refused
   * @property {function(Object): boolean} onSheet      write this whole sheet; false when refused
   * @property {function(string, string): void} onRoll  roll (notation, label)
   * @property {function(): void} onRemove
   * @property {function(string): void} onGmNotes       keep the game master's private notes
   */

  /** A labelled row: a caption above whatever follows. */
  const section = (element, caption, ...content) => {
    const block = element('div');
    block.append(element('div', 'tt-caption', caption), ...content);
    return block;
  };

  /**
   * Open a piece's character sheet. Edits are written through the handlers as they are made; the sheet keeps its
   * own copy so the controls stay in step even when a write is refused.
   * @param {Object} ui
   * @param {SheetModel} model
   * @param {SheetHandlers} handlers
   * @returns {Promise<void>} resolves when the sheet is closed
   */
  function openSheet(ui, model, handlers) {
    const element = ui.h;
    let token = { ...model.token }, sheet = { ...model.sheet, stats: { ...model.sheet.stats }, moves: model.sheet.moves.map((move) => ({ ...move })) };
    let checkMode = null;
    const inkKey = (label, onPress, isEnabled = model.canEdit) => Object.assign(pressKey(element, 'tt-ink-key', label, onPress), { disabled: !isEnabled });
    /** Apply token fields locally only if the table accepted them. */
    const changeToken = (fields) => handlers.onToken(fields) && (token = { ...token, ...fields });
    /** Apply sheet fields locally only if the table accepted the whole sheet with them. */
    const changeSheet = (fields) => handlers.onSheet({ ...sheet, ...fields }) && (sheet = { ...sheet, ...fields });
    /** A text field that never lets typing reach the game's keyboard controls. */
    const textField = (tag, value, maxLength, label, isEnabled = model.canEdit) => {
      const field = Object.assign(element(tag), { value, maxLength, disabled: !isEnabled });
      field.setAttribute('aria-label', label);
      field.addEventListener('keydown', (event) => event.stopPropagation());
      return field;
    };

    return ui.panel({
      title: 'Character sheet',
      closeLabel: 'Put away',
      build(body, close) {
        const page = element('div', 'tt-sheet');

        const name = textField('input', token.name, LIMITS.NAME_LENGTH, 'Name');
        name.addEventListener('change', () => changeToken({ name: name.value.trim() || token.name }) || (name.value = token.name));

        const hpFill = element('i'), hpBar = element('div', 'tt-hp tt-grow'), hpNumber = element('div', 'tt-hp-number');
        hpBar.append(hpFill);
        const showHp = () => {
          hpFill.style.width = (100 * token.hp) / token.hpMax + '%';
          hpNumber.textContent = `${token.hp} / ${token.hpMax}`;
        };
        const hpLine = element('div', 'tt-sheet-line');
        hpLine.append(hpBar, hpNumber, ...HP_STEPS.map((step) => inkKey(signed(step), () => changeToken({ hp: Kit.math.clamp(token.hp + step, 0, token.hpMax) }) && showHp())));
        showHp();

        const modeKeys = CHECK_MODES.map((option) => inkKey(option.label, () => {
          checkMode = option.mode;
          modeKeys.forEach((key, index) => key.classList.toggle('is-on', CHECK_MODES[index].mode === checkMode));
        }, true));
        modeKeys[CHECK_MODES.findIndex((option) => option.mode === null)].classList.add('is-on');
        const modeLine = element('div', 'tt-sheet-line');
        modeLine.append(...modeKeys);

        const statGrid = element('div', 'tt-stats');
        statGrid.append(...STATS.map((stat) => {
          const cell = element('div', 'tt-stat'), value = element('output', null, signed(sheet.stats[stat.id])), steps = element('div', 'tt-steps');
          const step = (amount) => {
            const stats = { ...sheet.stats, [stat.id]: Kit.math.clamp(sheet.stats[stat.id] + amount, LIMITS.STAT_MIN, LIMITS.STAT_MAX) };
            if (changeSheet({ stats })) value.textContent = signed(stats[stat.id]);
          };
          const rollCheck = () => {
            close(); // the dice land on the table, so the sheet gets out of the way
            handlers.onRoll(Kit.dice.check(sheet.stats[stat.id], checkMode), `${token.name}: ${stat.label}`.slice(0, LIMITS.ROLL_LABEL_LENGTH));
          };
          steps.append(inkKey('−', () => step(-1)), inkKey('+', () => step(1)), inkKey('Roll ' + stat.label, rollCheck, true));
          cell.append(element('label', null, stat.label), value, steps);
          return cell;
        }));

        const conditionKeys = element('div', 'tt-chips');
        conditionKeys.append(...CONDITIONS.map((condition) => {
          const key = inkKey(condition.label, () => {
            const conditions = token.conditions.includes(condition.id) ? token.conditions.filter((id) => id !== condition.id) : [...token.conditions, condition.id];
            if (changeToken({ conditions })) key.classList.toggle('is-on', conditions.includes(condition.id));
          });
          key.classList.toggle('is-on', token.conditions.includes(condition.id));
          return key;
        }));

        const notes = textField('textarea', sheet.notes, LIMITS.NOTES_LENGTH, 'Notes');
        notes.addEventListener('change', () => changeSheet({ notes: notes.value }) || (notes.value = sheet.notes));

        // Guard and speed: two numbers with steppers. Speed is what the move preview compares a route against.
        const TRAITS = [{ id: 'guard', label: 'Guard', max: LIMITS.GUARD_MAX }, { id: 'speed', label: 'Speed (cells)', max: LIMITS.SPEED_MAX }];
        const traitLine = element('div', 'tt-sheet-line');
        traitLine.append(...TRAITS.flatMap((trait) => {
          const value = element('output', 'tt-trait', String(sheet[trait.id]));
          const step = (amount) => changeSheet({ [trait.id]: Kit.math.clamp(sheet[trait.id] + amount, 0, trait.max) }) && (value.textContent = String(sheet[trait.id]));
          return [element('label', 'tt-grow', trait.label), value, inkKey('\u2212', () => step(-1)), inkKey('+', () => step(1))];
        }));

        // Moves: named dice rolls (attacks, spells). Rolling one puts its total on the table, ready to apply as harm.
        const moveList = element('div', 'tt-moves');
        const showMoves = () => {
          moveList.textContent = '';
          moveList.append(...sheet.moves.map((move, index) => {
            const line = element('div', 'tt-sheet-line');
            const moveName = textField('input', move.name, LIMITS.MOVE_NAME_LENGTH, 'Move name'), notation = textField('input', move.notation, Kit.dice.LIMITS.TEXT_LENGTH, 'Move dice');
            moveName.className = 'tt-grow tt-small';
            notation.className = 'tt-dice tt-small';
            const rewrite = () => changeSheet({ moves: sheet.moves.map((other, at) => (at === index ? { name: moveName.value.trim(), notation: notation.value.trim() } : other)) }) || showMoves();
            [moveName, notation].forEach((field) => field.addEventListener('change', rewrite));
            const rollMove = () => {
              close();
              handlers.onRoll(sheet.moves[index].notation, `${token.name}: ${sheet.moves[index].name}`.slice(0, LIMITS.ROLL_LABEL_LENGTH));
            };
            line.append(moveName, notation, inkKey('Roll', rollMove, true), inkKey('\u00d7', () => changeSheet({ moves: sheet.moves.filter((other, at) => at !== index) }) && showMoves()));
            return line;
          }));
          if (sheet.moves.length < LIMITS.MOVES) moveList.append(inkKey('Add a move', () => changeSheet({ moves: [...sheet.moves, { name: 'New move', notation: '1d6' }] }) && showMoves()));
        };
        showMoves();

        page.append(section(element, model.caption, name), section(element, 'Hit points', hpLine), section(element, 'Guard and speed', traitLine), section(element, 'Checks: d20 + the stat', modeLine, statGrid), section(element, 'Moves', moveList), section(element, 'Conditions', conditionKeys), section(element, 'Notes', notes));
        if (model.isGm) {
          const gmLine = element('div', 'tt-sheet-line');
          const hideKey = inkKey(token.hidden ? 'Reveal to players' : 'Hide from players', () => changeToken({ hidden: !token.hidden }) && (hideKey.textContent = token.hidden ? 'Reveal to players' : 'Hide from players'));
          const freeKey = inkKey('Free this seat', () => changeToken({ owner: null }) && (freeKey.disabled = true), token.owner !== null);
          const removeKey = inkKey('Remove', () => {
            close();
            handlers.onRemove();
          });
          removeKey.classList.add('is-danger');
          gmLine.append(hideKey, freeKey, removeKey);
          const gmNotes = textField('textarea', model.gmNotes, LIMITS.NOTES_LENGTH, 'Game master notes', true);
          gmNotes.addEventListener('change', () => handlers.onGmNotes(gmNotes.value));
          page.append(section(element, 'Game master', gmLine), section(element, 'Private notes (this device only, never sent)', gmNotes));
        }
        body.append(page);
      },
    });
  }

  // ---- roll log and scenes --------------------------------------------------------------------------------------------

  /**
   * The session's rolls, newest first, on a sheet.
   * @param {Object} ui
   * @param {Array<{who: string, label: string, result: Object}>} entries  oldest first
   * @returns {Promise<void>}
   */
  function openLog(ui, entries) {
    const element = ui.h;
    return ui.panel({
      title: 'Roll log',
      closeLabel: 'Put away',
      build(body) {
        const page = element('div', 'tt-sheet');
        const lineFor = ({ who, label, result }) => {
          const line = element('div', 'tt-log-line');
          line.append(element('span', 'tt-grow', `${who} \u00b7 ${label || result.text}`), ...result.dice.slice(0, LIMITS.TURN_ORDER_LENGTH).map((die) => faceFor(ui, die)), element('strong', null, String(result.total)));
          return line;
        };
        page.append(...(entries.length ? [...entries].reverse().map(lineFor) : [element('div', 'tt-caption', 'Nothing rolled yet')]));
        body.append(page);
      },
    });
  }

  /**
   * @typedef {Object} ScenesModel
   * @property {Array<{id: string, name: string, isActive: boolean, pieces: number}>} scenes
   * @property {string} notes          the game master's private notes on the active scene
   * @property {boolean} canReset      offer "start a new campaign" (tables kept on this device)
   */
  /**
   * The game master's scene list: go to a scene, bring the party along, add a scene, keep private notes.
   * @param {Object} ui
   * @param {ScenesModel} model
   * @param {{onGo: function(string, boolean): void, onAdd: function(string): void, onNotes: function(string): void, onReset: function(): void}} handlers
   *   onGo(sceneId, withParty), onAdd(name)
   * @returns {Promise<void>}
   */
  function openScenes(ui, model, handlers) {
    const element = ui.h;
    return ui.panel({
      title: 'Scenes',
      closeLabel: 'Put away',
      build(body, close) {
        const page = element('div', 'tt-sheet');
        const leaveWith = (action) => () => {
          close();
          action();
        };
        const inkKey = (label, onPress) => pressKey(element, 'tt-ink-key', label, onPress);
        const sceneLine = (scene) => {
          const line = element('div', 'tt-sheet-line');
          line.append(element('span', 'tt-grow', `${scene.name}${scene.isActive ? ' (here)' : ''} \u00b7 ${scene.pieces} pieces`));
          if (!scene.isActive) line.append(inkKey('Look', leaveWith(() => handlers.onGo(scene.id, false))), inkKey('Travel', leaveWith(() => handlers.onGo(scene.id, true))));
          return line;
        };
        const newName = element('input', 'tt-small');
        newName.placeholder = 'Name of a new scene';
        newName.maxLength = LIMITS.SCENE_NAME_LENGTH;
        newName.addEventListener('keydown', (event) => event.stopPropagation());
        const addLine = element('div', 'tt-sheet-line');
        newName.classList.add('tt-grow');
        addLine.append(newName, inkKey('Add', leaveWith(() => handlers.onAdd(newName.value.trim() || 'New scene'))));
        const notes = element('textarea');
        notes.value = model.notes;
        notes.maxLength = LIMITS.NOTES_LENGTH;
        notes.addEventListener('keydown', (event) => event.stopPropagation());
        notes.addEventListener('change', () => handlers.onNotes(notes.value));
        page.append(section(element, '"Travel" brings every player character to the scene\'s entry', ...model.scenes.map(sceneLine)), section(element, 'New scene', addLine), section(element, 'Private notes on this scene (this device only, never sent)', notes));
        if (model.canReset) {
          const reset = inkKey('Start a new campaign', leaveWith(handlers.onReset));
          reset.classList.add('is-danger');
          page.append(section(element, 'This table is kept on this device', reset));
        }
        body.append(page);
      },
    });
  }

  Kit.tableParts = Object.assign(Kit.tableParts || {}, { ribbon, dock, zoomKeys, readout, openSheet, openLog, openScenes, PLAY_TOOLS, GM_BRUSHES, GM_ACTIONS });
})();
