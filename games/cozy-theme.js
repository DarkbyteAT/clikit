// Plumwick Pond, theme: the HUD as part of the pixel-paper village (see kit/theme.js for the theme layer).
//
// Owns: `Cozy.theme` - tokens, scoped CSS and component builders. Stats hang as wooden signboards, coins sit in a
//       leather pouch, the goals are a pinned paper note, buttons are wooden plaques, the tackle picker is a tackle
//       box, and the fishing meters, timing gauge, catch card and paper sheets (tackle box, town plans,
//       almanac) are cut from the same paper and wood.
// Does not own: which HUD elements exist or what they say (cozy.js builds them and uses the cozy-* classes below).
(() => {
  const { ART } = Cozy.data;

  /** The few colours the whole HUD is cut from. */
  const INK = '#2b2233', PAPER = '#fbf3df', WOOD = '#b9824f', WOOD_DARK = '#5a3a22', WOOD_LIGHT = '#ffe9bd', LEATHER = '#9c6c47';
  /** Hard pixel drop shadow shared by every raised surface. */
  const DROP = '0 3px 0 rgba(43, 34, 51, 0.45)';
  /** Wood grain: thin darker lines across a plank. */
  const GRAIN = `repeating-linear-gradient(180deg, ${WOOD} 0 7px, #ab7544 7px 8px)`;
  /** Ruled lines of a notebook page. */
  const RULED = 'repeating-linear-gradient(180deg, transparent 0 15px, rgba(95, 176, 230, 0.28) 15px 16px)';
  /** Screen pixels per art pixel for HUD icons. */
  const ICON_SCALE = 2;

  const CSS = `
    /* Back / restart: small wooden pegs. */
    & .chip { background: ${GRAIN}; color: ${PAPER}; border: 3px solid ${WOOD_DARK}; border-radius: 4px; box-shadow: ${DROP}; text-shadow: 0 2px 0 ${WOOD_DARK}; }

    /* Stats: signboards hanging from two cords. */
    & #stats { gap: 8px; padding-top: 6px; }
    & .stat { position: relative; align-items: center; min-width: 58px; padding: 3px 9px 4px; background: ${GRAIN}; border: 3px solid ${WOOD_DARK}; border-radius: 3px; box-shadow: ${DROP}; }
    & .stat::before, & .stat::after { content: ''; position: absolute; top: -10px; width: 3px; height: 8px; background: ${WOOD_DARK}; }
    & .stat::before { left: 9px; }
    & .stat::after { right: 9px; }
    & .stat span { color: ${WOOD_LIGHT}; font-size: 10px; }
    & .stat b { color: #fffaf0; text-shadow: 0 2px 0 ${WOOD_DARK}; }
    & .stat.pulse { animation: cozy-swing .4s ease-out; }
    @keyframes cozy-swing { 30% { transform: rotate(-5deg) translateY(2px); } 65% { transform: rotate(3deg); } }

    /* Coins: a leather pouch, not a sign (no cords). */
    & .stat.cozy-pouch { flex-direction: row; gap: 4px; min-width: 0; padding: 2px 12px 2px 4px; background: ${LEATHER}; border-color: #6b4630; border-radius: 12px 12px 18px 18px; }
    & .stat.cozy-pouch::before, & .stat.cozy-pouch::after { display: none; }
    & .stat.cozy-pouch canvas { display: block; image-rendering: pixelated; }
    & .stat.cozy-pouch b { color: #f9d45c; text-shadow: 0 2px 0 #6b4630; }

    /* Goals: a note pinned to the scene. */
    & .checklist { position: relative; gap: 0; padding: 14px 12px 6px 10px; background: ${RULED}, ${PAPER}; color: ${INK}; border: 0; border-radius: 2px; box-shadow: 2px 3px 0 rgba(43, 34, 51, 0.3); transform: rotate(-1.5deg); transform-origin: top left; font-size: 12px; line-height: 16px; }
    & .checklist::before { content: ''; position: absolute; top: -5px; left: 50%; width: 10px; height: 10px; margin-left: -5px; background: #e0564f; border: 2px solid ${INK}; border-radius: 50%; }
    & .checklist i { width: 10px; height: 10px; border: 2px solid ${INK}; border-radius: 0; color: #e0564f; font-weight: 700; }
    /* The note only has room for what is next: finished goals drop off it and at most three open ones show. */
    & .checklist .done { display: none; }
    & .checklist div:not(.done) ~ div:not(.done) ~ div:not(.done) ~ div:not(.done) { display: none; }

    /* Fishing meters: paper strips in wooden frames. */
    & .progress { height: 20px; background: ${PAPER}; border: 3px solid ${WOOD_DARK}; border-radius: 3px; box-shadow: ${DROP}; }
    & .progress i { background-image: repeating-linear-gradient(90deg, transparent 0 6px, rgba(255, 255, 255, 0.28) 6px 8px); transition: width .1s linear; }
    & .progress span { color: ${INK}; font-size: 12px; letter-spacing: .12em; }

    /* Buttons: wooden plaques. */
    & .action { background: ${GRAIN}; color: #fffaf0; border: 3px solid ${WOOD_DARK}; border-bottom-width: 6px; border-radius: 4px; box-shadow: ${DROP}; }
    & .action:not(:disabled) { border-color: ${WOOD_DARK}; }
    & .action b { text-shadow: 0 2px 0 ${WOOD_DARK}; }
    & .action span { color: #ffe08a; }

    /* The tackle picker: a lidded box with a brass clasp. */
    & .action.cozy-tacklebox { position: relative; flex: 0 0 auto; min-width: 160px; margin-left: auto; flex-direction: row; justify-content: center; gap: 8px; padding-top: 18px; background: linear-gradient(180deg, #58b3a4 0 13px, ${INK} 13px 16px, #48a596 16px); border-color: ${INK}; }
    & .action.cozy-tacklebox::after { content: ''; position: absolute; top: 8px; left: 50%; width: 8px; height: 8px; margin-left: -6px; background: #f9d45c; border: 2px solid ${INK}; }
    & .action.cozy-tacklebox canvas { image-rendering: pixelated; }
    & .action.cozy-tacklebox div { display: flex; flex-direction: column; align-items: flex-start; }
    & .action.cozy-tacklebox b { text-shadow: 0 2px 0 ${INK}; }

    /* Hints and callouts: paper slips and inked lettering. */
    & .hint { max-width: 86%; text-align: center; background: ${PAPER}; color: ${INK}; border: 3px solid ${INK}; border-radius: 3px; box-shadow: 3px 3px 0 rgba(43, 34, 51, 0.4); }
    & .toast { font-size: 24px; color: #fffaf0; text-shadow: 0 3px 0 ${INK}, 2px 0 0 ${INK}, -2px 0 0 ${INK}, 0 -2px 0 ${INK}; }
    & .floater { text-shadow: 0 2px 0 ${INK}, 2px 0 0 ${INK}, -2px 0 0 ${INK}, 0 -2px 0 ${INK}; }

    /* Timing gauge (watering, haggling): a paper ruler with painted zones. */
    & .cozy-gauge { position: absolute; bottom: 27%; width: min(260px, 70vw); height: 30px; overflow: hidden; background: ${PAPER}; border: 3px solid ${INK}; border-radius: 4px; box-shadow: 0 4px 0 rgba(43, 34, 51, 0.45); }
    & .cozy-gauge div { position: absolute; top: 0; bottom: 0; }
    & .cozy-gauge .good { background: #f9d45c; }
    & .cozy-gauge .best { background: #84c552; }
    & .cozy-gauge .fill { left: 0; background: rgba(95, 176, 230, 0.55); }
    & .cozy-gauge .needle { width: 5px; background: ${INK}; }

    & .cozy-card-wrap[hidden], & .cozy-gauge[hidden], & .action[hidden], & .progress[hidden], & .checklist[hidden] { display: none; }

    /* Catch card: a paper card, set down slightly askew. */
    & .cozy-card-wrap { position: absolute; inset: 0; display: grid; place-items: center; }
    & .cozy-card { width: min(250px, 72vw); padding: 14px 14px 10px; text-align: center; background: ${PAPER}; color: ${INK}; border: 3px solid ${INK}; border-radius: 4px; box-shadow: 0 6px 0 rgba(43, 34, 51, 0.45); transform: rotate(-2deg); font-family: var(--display); animation: pop .22s cubic-bezier(.2, 1.4, .4, 1); }
    & .cozy-card canvas { image-rendering: pixelated; }
    & .cozy-card .picture { display: block; margin: 2px auto 6px; }
    & .cozy-card .kicker { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: ${LEATHER}; }
    & .cozy-card .title { font-size: 24px; font-weight: 700; line-height: 1.15; }
    & .cozy-card .stars { display: flex; justify-content: center; gap: 4px; margin: 6px 0; }
    & .cozy-card .line { font-size: 14px; font-weight: 500; }
    & .cozy-card .foot { margin-top: 8px; font-size: 11px; opacity: .6; }

    /* Modals (the open tackle box, banners, choices): a paper sheet with wooden buttons. */
    & .modal-card { padding: 16px; background: ${RULED}, ${PAPER}; color: ${INK}; border: 3px solid ${INK}; border-radius: 4px; box-shadow: 0 6px 0 rgba(43, 34, 51, 0.45); }
    & .modal-card h2 { font-size: 26px; }
    & .modal-card p { color: ${LEATHER}; }
    & .primary { background: ${GRAIN}; color: #fffaf0; border: 3px solid ${WOOD_DARK}; border-bottom-width: 6px; border-radius: 4px; text-shadow: 0 2px 0 ${WOOD_DARK}; }
    & .choice, & .rows { background: #fffaf0; border: 2px dashed ${LEATHER}; border-radius: 3px; box-shadow: none; }
    & .cozy-section { margin: 6px 0 0; font: 700 12px var(--display); letter-spacing: .08em; text-transform: uppercase; color: ${LEATHER}; }
    & .cozy-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 7px 10px; text-align: left; background: #fffaf0; color: ${INK}; border: 3px solid ${INK}; border-radius: 4px; box-shadow: ${DROP}; }
    & div.cozy-row { border: 2px dashed ${LEATHER}; box-shadow: none; }
    & .cozy-row canvas { flex: none; width: 44px; height: auto; image-rendering: pixelated; }
    & .cozy-row div { display: flex; flex-direction: column; min-width: 0; }
    & .cozy-row b { font: 700 16px var(--display); }
    & .cozy-row span { font-size: 13px; color: ${LEATHER}; }
    & .cozy-row.chosen { background: #e3f3c8; border-color: #45954c; border-style: solid; }
    & .cozy-row.unknown canvas { filter: brightness(0); opacity: .28; }
    & .cozy-row:disabled { opacity: .6; border-style: dashed; box-shadow: none; }

    /* The species signboard is the almanac's cover: it can be tapped. */
    & .stat.cozy-book { pointer-events: auto; cursor: pointer; }
  `;

  /**
   * Stat builder: coins get the leather pouch with a pixel pouch icon; every other stat keeps the kit's markup
   * (styled as a signboard by the CSS above).
   * @param {{ label: string, value: HTMLElement, h: Function }} parts  `value` is the live element the kit updates.
   * @returns {HTMLElement | null} null keeps the kit's default element.
   */
  function buildStat({ label, value, h }) {
    if (label !== 'Coins') return null;
    const pouch = h('div', 'stat cozy-pouch');
    pouch.append(Kit.pixel.canvas(ART.pouch, { scale: ICON_SCALE }), value);
    return pouch;
  }

  /**
   * Action builder: the tackle picker becomes a tackle box showing the chosen implement's icon; every other button
   * keeps the kit's markup (a wooden plaque). The icon is swapped by cozy.js through the `.icon` holder.
   * @param {{ id: string, label: HTMLElement, sub: HTMLElement, h: Function }} parts
   * @returns {HTMLElement | null}
   */
  function buildAction({ id, label, sub, h }) {
    if (id !== 'tackle') return null;
    const box = h('button', 'action cozy-tacklebox');
    const text = h('div');
    text.append(label, sub);
    const icon = h('i', 'icon');
    Cozy.hudParts.tackleIcon = icon;
    box.append(icon, text);
    return box;
  }

  /** Elements built by the component builders that cozy.js needs to reach: tackleIcon holds the chosen implement's icon. */
  Cozy.hudParts = { tackleIcon: null };

  /** @type {Object} Theme (see kit/theme.js). */
  Cozy.theme = {
    skin: 'pixel',
    tokens: {
      '--ink': '#fffaf0', '--dim': WOOD_LIGHT, '--panel': WOOD, '--line': WOOD_DARK, '--accent': '#f9d45c', '--accent-ink': INK, '--accent-edge': WOOD_DARK,
      '--scrim': 'rgba(43, 34, 51, 0.5)', '--radius': '3px', '--radius-lg': '4px', '--border': '3px', '--shadow': DROP, '--stat-size': '17px', '--floater': '#fff3a0',
    },
    layout: { stats: 'top-right', actions: 'bottom' },
    css: CSS,
    components: { stat: buildStat, action: buildAction },
  };
  /** Screen pixels per art pixel for icons cozy.js adds to the HUD itself. */
  Cozy.HUD_ICON_SCALE = ICON_SCALE;
})();
