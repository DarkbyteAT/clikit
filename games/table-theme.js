// Lampwick Table - theme. The look of the tabletop's HUD: a game master's desk at night.
//
// Owns:  the `theme` object handed to Kit.register (fonts, tokens, layout, scoped CSS for every tt-* component).
// Does not own: building the components (games/table-hud.js) or anything on the 3D board (games/table-board.js).
//
// Why it differs from the arcade games: this is a tool people sit with for hours. So: small calm type, hairlines
// instead of slabs, no bobbing or pulsing, dark walnut rails that recede behind the board, and warm vellum only where
// something is meant to be read or written (the acting turn, dice faces, the character sheet). Every control lives
// in one dock at the bottom edge so the whole table can be run with a thumb.
(() => {
  /** Colours of the desk. Declared once here and exposed to the CSS as custom properties. */
  const PALETTE = {
    walnut: 'rgba(27, 19, 13, 0.9)',
    brass: '#c39a4a',
    brassDeep: '#7d5d22',
    candle: '#ecdfc2',
    dust: '#a8936c',
    hairline: 'rgba(195, 154, 74, 0.34)',
    vellum: '#efe2c0',
    vellumShade: '#e0cf9f',
    vellumInk: '#2c2013',
    vellumDim: '#6f5a3a',
    oxblood: '#8c1c13',
  };

  /**
   * Outline of each die button, as a CSS polygon over the button's box: the silhouette of that die seen face-on.
   * @type {Object<string, string>} die sides -> clip-path polygon
   */
  const DIE_SILHOUETTES = {
    4: 'polygon(50% 4%, 97% 92%, 3% 92%)',
    6: 'polygon(8% 8%, 92% 8%, 92% 92%, 8% 92%)',
    8: 'polygon(50% 2%, 96% 50%, 50% 98%, 4% 50%)',
    10: 'polygon(50% 2%, 94% 38%, 50% 98%, 6% 38%)',
    12: 'polygon(50% 2%, 96% 36%, 79% 94%, 21% 94%, 4% 36%)',
    20: 'polygon(50% 2%, 93% 26%, 93% 74%, 50% 98%, 7% 74%, 7% 26%)',
  };
  const dieSilhouetteCss = Object.entries(DIE_SILHOUETTES).map(([sides, polygon]) => `& .tt-die[data-sides="${sides}"] { clip-path: ${polygon}; }`).join('\n');

  const css = `
    /* --- kit components, quietened --- */
    & #hud-layer [hidden] { display: none !important; }
    & #hud-layer { padding-top: 6px; gap: 5px; }
    & .chip { height: 32px; min-width: 32px; font-size: 13px; }
    & .stat { padding: 3px 8px; min-width: 0; }
    & .stat span { font-size: 9px; }
    & .toast { font-size: 20px; top: 16%; letter-spacing: .06em; }
    & .hint { animation: none; }
    & #modal { backdrop-filter: none; }
    & .modal-card h2 { font-size: 24px; color: var(--ink); }
    & .choice { border-left-width: 3px; padding: 9px 12px; }
    & .choice b { font-size: 16px; }

    /* --- shared control shape: a brass-edged key --- */
    & .tt-key {
      pointer-events: auto; flex: none; height: 34px; min-width: 40px; padding: 0 8px; border-radius: var(--radius);
      background: var(--panel); border: 1px solid var(--line); color: var(--ink); font: 600 12px/1 var(--display); letter-spacing: .05em;
      white-space: nowrap; transition: background .12s, color .12s;
    }
    & .tt-key:active { background: rgba(195, 154, 74, 0.28); }
    & .tt-key.is-on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
    & .tt-key:disabled { opacity: .4; }
    & .tt-key.is-quiet { border-color: transparent; color: var(--dim); }

    /* --- initiative ribbon: one hairline strip, the acting piece on vellum --- */
    & .tt-ribbon {
      pointer-events: auto; align-self: stretch; display: flex; align-items: center; gap: 3px; padding: 3px; overflow-x: auto;
      background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); scrollbar-width: none;
    }
    & .tt-ribbon::-webkit-scrollbar, & .tt-row::-webkit-scrollbar { display: none; }
    & .tt-round { flex: none; padding: 0 7px; font: 600 11px var(--display); letter-spacing: .08em; color: var(--dim); white-space: nowrap; }
    & .tt-chip {
      flex: none; display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px 0 6px; border-radius: 13px;
      border: 1px solid transparent; font: 600 12px var(--body); color: var(--ink); white-space: nowrap;
    }
    & .tt-chip i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 1px rgba(0, 0, 0, .4); }
    & .tt-chip b { font-weight: 400; color: var(--dim); font-variant-numeric: tabular-nums; }
    & .tt-chip.is-mine span { text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 3px; }
    & .tt-chip.is-acting { background: var(--vellum); color: var(--vellum-ink); border-color: var(--accent); }
    & .tt-chip.is-acting b { color: var(--vellum-dim); }
    /* The turn key stays pinned at the right end while the order scrolls under it. */
    & .tt-ribbon .tt-key { height: 26px; margin-left: auto; position: sticky; right: 0; background: #2a1e14; }

    /* --- the dock: everything a thumb needs, at the bottom edge --- */
    & .tt-dock { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; gap: 4px; pointer-events: none; }
    & .tt-row { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; pointer-events: auto; }
    & .tt-row .tt-key.is-wide { flex: 1 0 auto; }
    & .tt-status { align-self: flex-start; max-width: 100%; padding: 2px 8px; border-radius: var(--radius); background: rgba(12, 8, 5, .55); font: 12px var(--body); color: var(--dim); }
    & .tt-status.is-alert { color: #f0c9a0; }
    & .tt-zoom { position: absolute; right: 0; top: 34%; display: flex; flex-direction: column; gap: 4px; }
    & .tt-zoom .tt-key { min-width: 34px; padding: 0; font-size: 18px; }

    /* --- dice tray --- */
    & .tt-die {
      pointer-events: auto; flex: none; width: 34px; height: 36px; display: grid; place-items: center; padding-top: 2px;
      background: linear-gradient(160deg, var(--vellum) 0%, var(--vellum-shade) 100%); color: var(--vellum-ink);
      font: 700 12px var(--display); transition: transform .12s;
    }
    & .tt-die:active { transform: rotate(-14deg) scale(.92); }
    & .tt-die[data-sides="4"] { padding-top: 12px; }
    ${dieSilhouetteCss}
    & .tt-notation {
      pointer-events: auto; flex: 1 1 60px; min-width: 60px; width: 60px; height: 36px; padding: 0 8px; border-radius: var(--radius);
      background: rgba(12, 8, 5, .6); border: 1px solid var(--line); color: var(--ink); font: 14px var(--body);
      -webkit-user-select: text; user-select: text;
    }
    & .tt-notation::placeholder { color: var(--dim); }
    & .tt-notation.is-wrong { border-color: var(--oxblood); }

    /* --- roll log: who rolled, every die, the total --- */
    & .tt-log { display: flex; flex-direction: column; gap: 3px; align-self: flex-start; max-width: 86%; }
    & .tt-roll { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 8px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); font: 12px var(--body); }
    & .tt-roll:not(:last-child) { opacity: .6; }
    & .tt-roll em { font-style: normal; color: var(--dim); }
    & .tt-roll strong { margin-left: 2px; font: 700 17px var(--display); color: var(--accent); font-variant-numeric: tabular-nums; }
    & .tt-face { min-width: 18px; padding: 0 3px; border-radius: 3px; background: var(--vellum); color: var(--vellum-ink); font: 700 12px/18px var(--display); text-align: center; }
    & .tt-face.is-dropped { opacity: .45; text-decoration: line-through; }
    & .tt-face.is-top { background: var(--accent); }
    & .tt-face.is-bottom { background: #d9a79b; }

    /* --- distance readout that follows the finger --- */
    & .tt-readout { position: fixed; left: 0; top: 0; padding: 2px 8px; border-radius: 10px; background: var(--vellum); color: var(--vellum-ink); font: 700 13px var(--display); white-space: nowrap; pointer-events: none; }
    & .tt-readout.is-far { background: #e7b8a8; }

    /* --- character sheet: a real sheet of vellum, ruled, written in ink --- */
    & .modal-card.sheet {
      width: min(420px, 100%); gap: 8px; padding: 14px 14px 12px; border-radius: 2px; color: var(--vellum-ink);
      background: linear-gradient(180deg, var(--vellum) 0%, var(--vellum-shade) 100%); border: 1px solid #a98a4f; box-shadow: 0 10px 30px rgba(0, 0, 0, .6);
    }
    & .modal-card.sheet h2 { font-size: 13px; letter-spacing: .14em; color: var(--vellum-dim); border-bottom: 1px solid #a98a4f; padding-bottom: 4px; }
    & .modal-card.sheet .primary { padding: 9px; font-size: 14px; border-bottom-width: 2px; border-radius: 3px; }
    & .tt-sheet { display: flex; flex-direction: column; gap: 10px; font: 14px var(--body); }
    & .tt-sheet label, & .tt-sheet .tt-caption { font: 600 10px var(--display); letter-spacing: .12em; color: var(--vellum-dim); }
    & .tt-sheet input, & .tt-sheet textarea {
      width: 100%; background: transparent; border: 0; border-bottom: 1px solid #a98a4f; color: var(--vellum-ink); font: 600 20px var(--body);
      padding: 2px 0; border-radius: 0; -webkit-user-select: text; user-select: text;
    }
    & .tt-sheet textarea { font: 14px/22px var(--body); min-height: 68px; resize: none; background: repeating-linear-gradient(180deg, transparent 0 21px, rgba(120, 90, 40, .35) 21px 22px); border-bottom: 0; }
    & .tt-sheet input:disabled, & .tt-sheet textarea:disabled { opacity: 1; -webkit-text-fill-color: var(--vellum-ink); }
    & .tt-sheet-line { display: flex; align-items: center; gap: 6px; }
    & .tt-sheet-line > .tt-grow { flex: 1; min-width: 0; }
    & .tt-ink-key { pointer-events: auto; min-width: 30px; height: 30px; padding: 0 7px; border: 1px solid #8f744a; border-radius: 3px; color: var(--vellum-ink); font: 700 12px var(--display); background: rgba(255, 255, 255, .25); }
    & .tt-ink-key:active, & .tt-ink-key.is-on { background: var(--vellum-ink); color: var(--vellum); }
    & .tt-ink-key:disabled { opacity: .35; }
    & .tt-ink-key.is-danger { border-color: var(--oxblood); color: var(--oxblood); }
    & .tt-hp { position: relative; height: 12px; border: 1px solid #8f744a; border-radius: 2px; overflow: hidden; }
    & .tt-hp i { position: absolute; inset: 0 auto 0 0; background: var(--oxblood); transition: width .2s; }
    & .tt-hp-number { min-width: 62px; text-align: right; font: 700 16px var(--display); font-variant-numeric: tabular-nums; }
    & .tt-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    & .tt-stat { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; align-items: center; padding: 6px 8px; border: 1px solid #a98a4f; border-radius: 2px; }
    & .tt-stat output { font: 700 22px var(--display); font-variant-numeric: tabular-nums; }
    & .tt-stat .tt-steps { grid-column: 1 / -1; display: flex; gap: 4px; }
    & .tt-stat .tt-steps .tt-ink-key:last-child { flex: 1; }
    & .tt-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    & .tt-sheet .tt-small { font: 600 14px var(--body); }
    & .tt-sheet .tt-dice { width: 84px; flex: none; }
    & .tt-sheet .tt-trait { min-width: 26px; text-align: right; font: 700 18px var(--display); font-variant-numeric: tabular-nums; }
    & .tt-sheet-line > label.tt-grow { flex: 1 1 0; }
    & .tt-moves { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
    & .tt-moves .tt-sheet-line { align-self: stretch; }
    & .tt-log-line { display: flex; align-items: center; gap: 4px; padding: 3px 0; border-bottom: 1px solid rgba(120, 90, 40, .35); font: 13px var(--body); }
    & .tt-log-line strong { min-width: 28px; text-align: right; font: 700 16px var(--display); }
    & .tt-log { pointer-events: auto; cursor: pointer; }

    /* Landscape phones have little height: the dock keeps to the left so the board shows beside it. */
    @media (orientation: landscape) and (max-height: 520px) {
      & .tt-dock { right: auto; width: min(400px, 56%); }
      & .tt-ribbon { align-self: flex-start; max-width: 62%; }
      & .tt-log { max-width: 100%; }
      & .tt-roll:not(:last-child) { display: none; }
    }
  `;

  /** @type {Object} the Kit theme for this game (see kit/theme.js) */
  const theme = {
    skin: 'parchment',
    fonts: ['Cormorant SC:wght@600;700', 'Spectral:wght@400;600'],
    tokens: {
      '--display': '"Cormorant SC", "IM Fell English SC", Georgia, serif',
      '--body': '"Spectral", "Alegreya", Georgia, serif',
      '--panel': PALETTE.walnut,
      '--ink': PALETTE.candle,
      '--dim': PALETTE.dust,
      '--line': PALETTE.hairline,
      '--accent': PALETTE.brass,
      '--accent-ink': '#1d140a',
      '--accent-edge': PALETTE.brassDeep,
      '--scrim': 'rgba(10, 7, 4, 0.72)',
      '--radius': '4px',
      '--radius-lg': '4px',
      '--border': '1px',
      '--shadow': 'none',
      '--label-case': 'uppercase',
      '--label-spacing': '0.12em',
      '--stat-size': '14px',
      '--floater': PALETTE.candle,
      // Tokens of this game's own: the writing surface and its inks.
      '--vellum': PALETTE.vellum,
      '--vellum-shade': PALETTE.vellumShade,
      '--vellum-ink': PALETTE.vellumInk,
      '--vellum-dim': PALETTE.vellumDim,
      '--oxblood': PALETTE.oxblood,
    },
    layout: { stats: 'top-right', actions: 'bottom' },
    css,
  };

  Kit.tableParts = Object.assign(Kit.tableParts || {}, { theme, PALETTE });
})();
