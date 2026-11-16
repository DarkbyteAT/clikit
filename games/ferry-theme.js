/**
 * Ferry Lines - the harbour master's desk: the game's Kit.register `theme`.
 *
 * Owns: fonts, tokens, scoped CSS and the custom stat markup that make the HUD read as chart paper, navy ink and signal
 *       red - a ledger line for coins, lifebuoys for hearts, a timber notice board for the shipyard, log-book modals,
 *       paper order tags ringed by their patience, lettered island names.
 * Does not own: which elements exist (games/ferry.js builds them through ctx.ui) or the theme mechanism (kit/theme.js).
 *
 * Class names used by the view: .ferry-chart .ferry-label .ferry-legend .ferry-order(.festival|.rush) .ferry-tools
 * .ferry-log-rank .ferry-log-head .ferry-log-row(.done), plus the kit's .stat .pips .action .chip .toast .hint .modal-card.
 */
(() => {
  const INK = '#17324d', PAPER = '#f3e9cf', SIGNAL_RED = '#c8372d', CREAM = '#fff6e0';

  /** Stat label -> custom markup. Each builder must place `value`, which the kit keeps updating. */
  const STAT_BUILDERS = {
    // Coins as the bottom line of a ledger: label, dotted leader, figure.
    Takings: ({ label, value, h }) => {
      const line = h('div', 'stat ferry-ledger');
      line.append(h('span', null, label), h('i', 'ferry-leader'), value);
      return line;
    },
  };

  /** The Kit.register `theme` of Ferry Lines (see kit/theme.js for the shape). */
  const THEME = {
    skin: 'paper',
    fonts: ['Zilla Slab:wght@500;700', 'Courier Prime:wght@400;700'],
    tokens: {
      '--display': '"Zilla Slab", Rockwell, Georgia, serif',
      '--body': '"Courier Prime", "Courier New", monospace',
      '--panel': PAPER,
      '--ink': INK,
      '--dim': '#5b6b7a',
      '--line': INK,
      '--accent': SIGNAL_RED,
      '--accent-ink': CREAM,
      '--accent-edge': '#8f241c',
      '--scrim': 'rgba(10, 30, 50, 0.62)',
      '--radius': '3px',
      '--radius-lg': '3px',
      '--border': '1.5px',
      '--shadow': '0 2px 0 rgba(10, 30, 50, 0.45)',
      '--label-case': 'uppercase',
      '--label-spacing': '0.12em',
      '--floater': CREAM,
    },
    layout: { stats: 'top-right', actions: 'bottom' },
    components: { stat: (parts) => (STAT_BUILDERS[parts.label] ? STAT_BUILDERS[parts.label](parts) : null) },
    css: `
      /* Ledger line: coins written at the end of a dotted leader on ruled paper. */
      & .ferry-ledger { flex-direction: row; align-items: baseline; gap: 5px; min-width: 132px; padding: 7px 9px 5px; border-radius: 2px;
        background: linear-gradient(${PAPER} 0 0) padding-box, ${PAPER}; border: 0; border-bottom: 2px solid ${SIGNAL_RED}; }
      & .ferry-ledger span { font: 700 10px var(--display); color: ${INK}; }
      & .ferry-leader { flex: 1; border-bottom: 2px dotted ${INK}; opacity: .55; transform: translateY(-3px); }
      & .ferry-ledger b { font: 700 19px var(--body); color: ${INK}; }
      /* Lifebuoy rack (ui.pips): red and white quartered rings with no box or label; a lost one fades and shrinks. */
      & .pips[data-pips="buoys"] { min-width: 0; padding: 6px 7px; background: none; border: 0; box-shadow: none; }
      & .pips[data-pips="buoys"] span { display: none; }
      & .pips[data-pips="buoys"] .pip { width: 21px; height: 21px; border: 0; filter: drop-shadow(0 2px 0 rgba(10, 30, 50, .5)); transition: opacity .3s, transform .3s;
        background: conic-gradient(${SIGNAL_RED} 0 12.5%, ${CREAM} 0 37.5%, ${SIGNAL_RED} 0 62.5%, ${CREAM} 0 87.5%, ${SIGNAL_RED} 0);
        -webkit-mask: radial-gradient(circle, transparent 36%, #000 39%); mask: radial-gradient(circle, transparent 36%, #000 39%); }
      & .pips[data-pips="buoys"] .pip:not(.on) { opacity: .22; transform: scale(.8); }
      /* Shipyard board: a timber notice board with price cards nailed to it. */
      & #actions { gap: 6px; padding: 8px 7px 7px; border-radius: 4px; border: 2px solid #33210f;
        background: repeating-linear-gradient(90deg, #6e4a2c 0 46px, #62411f 46px 48px); box-shadow: inset 0 2px 0 rgba(255, 255, 255, .12), 0 3px 0 #1f1408; }
      & .action { position: relative; padding: 11px 3px 6px; gap: 1px; border-radius: 2px; background: ${PAPER}; border: 1px solid #33210f; border-bottom-width: 1px;
        box-shadow: 1px 2px 0 rgba(0, 0, 0, .4); backdrop-filter: none; }
      & .action:nth-child(odd) { transform: rotate(-1.2deg); }
      & .action:nth-child(even) { transform: rotate(.9deg); }
      & .action::before { content: ''; position: absolute; top: 3px; left: 50%; width: 5px; height: 5px; margin-left: -2.5px; border-radius: 50%; background: #9aa1ab; box-shadow: inset 0 -1.5px 0 #4d535c; }
      & .action b { font: 700 13px var(--display); letter-spacing: .08em; text-transform: uppercase; }
      & .action span { font: 700 13px var(--body); color: ${SIGNAL_RED}; }
      & .action:disabled { opacity: 1; filter: saturate(.3) brightness(.78); }
      /* Chips become stencilled brass-edged tags. */
      & .chip { background: ${PAPER}; color: ${INK}; border: 1.5px solid ${INK}; border-radius: 2px; backdrop-filter: none; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
      & .ferry-tools { position: absolute; right: 0; top: 2px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 100%; }
      & .ferry-tools .chip { height: 30px; }
      & .ferry-tools .chip.hot { background: ${SIGNAL_RED}; color: ${CREAM}; border-color: #8f241c; }
      /* Callouts read like stamped chart annotations. */
      & .toast { font: 700 23px var(--display); letter-spacing: .14em; text-transform: uppercase; color: ${CREAM}; text-shadow: 0 2px 0 ${INK}, 0 0 14px rgba(10, 30, 50, .9); }
      & .hint { background: ${PAPER}; color: ${INK}; border: 1.5px dashed ${INK}; border-radius: 2px; font: 700 13px var(--body); top: 44px; bottom: auto; }
      /* Modals are a page of the log book: ruled lines, double-ruled heading, dotted ledger rows, a signal-red button. */
      & .modal-card { padding: 24px 20px 18px; border: 1.5px solid ${INK}; border-radius: 2px; color: ${INK}; transform: rotate(-1deg);
        background: linear-gradient(90deg, transparent 0 30px, rgba(200, 55, 45, .45) 30px 31px, transparent 31px), repeating-linear-gradient(#f7efda 0 27px, #c9d5df 27px 28px);
        box-shadow: 7px 7px 0 rgba(10, 30, 50, .55); }
      & .modal-card h2 { font: 700 30px var(--display); letter-spacing: .02em; padding: 0 0 6px 18px; border-bottom: 3px double ${INK}; }
      & .modal-card p { padding-left: 18px; color: #4a5d70; font: 400 14px var(--body); }
      & .rows { padding: 0 0 0 18px; background: none; border: 0; box-shadow: none; gap: 0; }
      & .rows div { padding: 4px 0; border-bottom: 1.5px dotted ${INK}; }
      & .rows span { color: ${INK}; font: 500 14px var(--display); letter-spacing: .08em; text-transform: uppercase; }
      & .rows b { font: 700 16px var(--body); }
      & .primary { margin-left: 18px; border-radius: 2px; letter-spacing: .1em; text-transform: uppercase; }
      /* Chart layer: island names lettered on the water, orders as paper tags ringed by their patience. */
      & .ferry-chart { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
      & .ferry-label { position: absolute; transform: translate(-50%, 0); font: italic 500 12px var(--display); letter-spacing: .14em; text-transform: uppercase; white-space: nowrap;
        color: ${CREAM}; text-shadow: 0 1px 0 ${INK}, 0 0 6px rgba(10, 30, 50, .9); }
      & .ferry-order { position: absolute; transform: translate(-50%, -100%); padding: 3.5px; border-radius: 999px; animation: ferry-pop .28s cubic-bezier(.2, 1.6, .4, 1);
        background: conic-gradient(var(--ring) calc(var(--left) * 1%), rgba(10, 30, 50, .55) 0); box-shadow: 0 2px 0 rgba(10, 30, 50, .5); }
      & .ferry-order::after { content: ''; position: absolute; left: 50%; bottom: -6px; margin-left: -5px; border: 5px solid transparent; border-bottom: 0; border-top-color: ${INK}; }
      & .ferry-order > div { display: flex; gap: 4px; align-items: center; justify-content: center; min-width: 27px; height: 27px; padding: 0 6px; box-sizing: border-box;
        border-radius: 999px; background: ${PAPER}; border: 1.5px solid ${INK}; }
      & .ferry-order.festival > div { background: #ffd866; border-color: ${SIGNAL_RED}; }
      & .ferry-order.festival > div::before { content: 'FETE'; font: 700 9px var(--display); letter-spacing: .1em; color: ${SIGNAL_RED}; }
      & .ferry-order i { width: 13px; height: 13px; background: var(--good); outline-offset: 0; transition: opacity .2s; }
      & .ferry-order i.done { opacity: .2; }
      & .ferry-order i.log { width: 16px; height: 9px; border-radius: 3px; }
      & .ferry-order i.ball { border-radius: 50%; }
      & .ferry-order i.cone { clip-path: polygon(50% 0, 100% 100%, 0 100%); background: linear-gradient(var(--good), #b9c4d2); }
      & .ferry-order i.gem { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
      & .ferry-order i.slab { width: 16px; height: 7px; }
      & .ferry-order i.bar { width: 16px; height: 9px; clip-path: polygon(18% 0, 82% 0, 100% 100%, 0 100%); }
      /* A rush order is a telegram: red edge, stamped RUSH. It costs no lifebuoy, so its ring is always red. */
      & .ferry-order.rush > div { border: 1.5px dashed ${SIGNAL_RED}; }
      & .ferry-order.rush > div::before { content: 'RUSH'; font: 700 9px var(--display); letter-spacing: .1em; color: ${SIGNAL_RED}; }
      /* Chart legend under an island's name: what it makes, and for a mill what it must be fed. */
      & .ferry-label .ferry-legend { display: flex; justify-content: center; align-items: center; gap: 4px; margin-top: 2px; font: 700 11px var(--body); letter-spacing: 0; text-shadow: none; }
      & .ferry-label .ferry-order { position: static; transform: none; animation: none; padding: 0; background: none; box-shadow: none; }
      & .ferry-label .ferry-order::after { display: none; }
      & .ferry-label .ferry-order > div { min-width: 0; height: 18px; padding: 0 5px; }
      /* The harbour log (ui.panel): rank line, then commissions as ledger entries ticked off in red. */
      & .ferry-log-rank { font: 700 17px var(--display); letter-spacing: .06em; padding: 0 0 4px 18px; }
      & .ferry-log-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 0 5px 18px; border-bottom: 1.5px dotted ${INK}; font: 400 13px var(--body); }
      & .ferry-log-row b { margin-left: auto; white-space: nowrap; font: 700 13px var(--body); }
      & .ferry-log-row.done { color: #7c8a96; text-decoration: line-through; text-decoration-color: ${SIGNAL_RED}; }
      & .ferry-log-row em { font: 700 10px var(--display); font-style: normal; letter-spacing: .08em; text-transform: uppercase; color: ${SIGNAL_RED}; }
      & .ferry-log-head { margin: 10px 0 0 18px; font: 700 12px var(--display); letter-spacing: .14em; text-transform: uppercase; }
      /* Chart picker (ui.choose): each chart is a folded sheet with a red index tab. */
      & .choice { margin-left: 18px; border-radius: 2px; background: ${PAPER}; border: 1.5px solid ${INK}; border-left: 6px solid ${SIGNAL_RED}; color: ${INK}; }
      & .choice b { font: 700 18px var(--display); }
      & .choice span { color: #4a5d70; font: 400 13px var(--body); }
      & .choice em { color: ${SIGNAL_RED}; }
      @keyframes ferry-pop { from { transform: translate(-50%, -100%) scale(.3); } }
    `,
  };

  window.FERRY_THEME = THEME;
})();
