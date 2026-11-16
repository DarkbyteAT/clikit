// Prism Garden theme: the HUD as a greenhouse at night. Brass plaque for the numbers, cream plant-label stakes for the
// tools, crystal buds for goals, punched plant labels for the bed list.
//
// Owns: the theme object passed to Kit.register (fonts, tokens, scoped CSS, the tool-button component) and budRow, the
//       one element builder the game and its sheets share.
// Does not own: what the HUD says or when (games/prism.js), or the theme layer itself (kit/theme.js).
// Exposed as the global PRISM_THEME.
(() => {
  // Everything in THEME_CSS is scoped to this game by the "&" prefix (kit/theme.js).

  /** Line icons for the tool row, drawn on a 24-unit square. Static markup from this table only. */
  const TOOL_ICONS = {
    undo: '<path d="M9 5 4 10l5 5"/><path d="M4 10h9a6 6 0 0 1 6 6v4"/>',
    redo: '<path d="m15 5 5 5-5 5"/><path d="M20 10h-9a6 6 0 0 0-6 6v4"/>',
    reset: '<path d="M12 3v11"/><path d="M5 14h14"/><path d="M5 14v6M9.7 14v6M14.3 14v6M19 14v6"/>', // a rake: smooth the bed over
    hint: '<path d="M10 7a2 2 0 0 1 4 0"/><path d="M9 7h6l1.5 10h-9z"/><path d="M12 10.5v3.5"/><path d="M8 20h8"/>', // a lantern
    beds: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>', // seed plots
  };
  const svgIcon = (paths) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  /**
   * A row of crystal buds, one per goal of a bed.
   * @param {(tag: string, cls?: string, text?: string) => HTMLElement} h - ctx.ui.h
   * @param {('lit'|'kept'|'bare')[]} buds - lit: met right now; kept: earned on an earlier visit; bare: not yet
   * @returns {HTMLElement}
   */
  const budRow = (h, buds) => {
    const row = h('span', 'buds');
    row.setAttribute('aria-label', `${buds.filter((bud) => bud !== 'bare').length} of ${buds.length} buds`);
    row.append(...buds.map((bud) => h('i', `bud ${bud}`)));
    return row;
  };

  const BRASS = 'linear-gradient(180deg, #d9bd78 0%, #b8944a 55%, #a07d38 100%)';
  const THEME_CSS = `
    /* Brass plaque: the three stats share one engraved plate held by two screws. */
    & #stats { gap: 0; padding: 3px 14px; background: ${BRASS}; border-radius: 3px; position: relative;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -2px 0 rgba(60,40,5,.35), 0 3px 8px rgba(0,0,0,.55); }
    & #stats::before, & #stats::after { content: ""; position: absolute; top: 50%; width: 5px; height: 5px; margin-top: -3px; border-radius: 50%;
      background: #6f5520; box-shadow: inset 0 1px 0 rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.4); }
    & #stats::before { left: 5px; } & #stats::after { right: 5px; }
    & .stat { background: none; border: 0; box-shadow: none; align-items: center; min-width: 46px; padding: 2px 10px; backdrop-filter: none; }
    & .stat + .stat { border-left: 1px solid rgba(70,50,10,.4); box-shadow: inset 1px 0 0 rgba(255,255,255,.3); }
    & .stat span { color: #5b4514; font: 400 10px var(--display); text-shadow: 0 1px 0 rgba(255,255,255,.35); }
    & .stat b { color: #33260a; text-shadow: 0 1px 0 rgba(255,255,255,.45); }
    & .chip { background: ${BRASS}; color: #33260a; border: 0; border-radius: 50%; width: 38px; padding: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -2px 0 rgba(60,40,5,.35), 0 3px 8px rgba(0,0,0,.55); }
    /* Crystal buds: stars as faceted buds, lit ones glow like the flowers. */
    & .buds { display: inline-flex; gap: 9px; align-items: center; padding: 3px 4px; }
    & .bud { width: 11px; height: 11px; transform: rotate(45deg); border-radius: 2px 7px; border: 1.5px solid rgba(190,235,245,.55); transition: all .3s; }
    & .bud.lit { border-color: #e8fbff; background: radial-gradient(circle at 35% 35%, #ffffff, #7dd3fc 70%); box-shadow: 0 0 10px 2px rgba(125,211,252,.75); }
    & .bud.ahead { border-color: #e8fbff; background: rgba(232,251,255,.22); } /* on course, bed not yet solved */
    & .bud.kept { border-color: #7dd3fc; background: rgba(125,211,252,.28); } /* earned on an earlier visit, not met right now */
    & .bud-row { display: flex; flex-direction: column; align-items: center; gap: 1px; }
    & .bud-row { text-shadow: 0 1px 4px #0a1414, 0 0 10px #0a1414; } /* the garden grows behind this row */
    & .bud-row small { font: 400 10px var(--display); letter-spacing: .12em; color: rgba(220,240,225,.7); }
    & .bud-row em { font: italic 500 12px var(--body); color: rgba(220,240,225,.85); }
    /* Tool row: cream plant-label stakes with a pointed foot, as if pushed into the soil at the screen edge. */
    & #actions { gap: 6px; filter: drop-shadow(0 2px 0 rgba(0,0,0,.45)); }
    & .action { border: 0; border-radius: 0; box-shadow: none; padding: 7px 2px 15px; gap: 0; color: #2f3a22;
      clip-path: polygon(0 0, 100% 0, 100% 76%, 50% 100%, 0 76%); }
    & .action b { font: 400 12px var(--display); letter-spacing: .04em; }
    & .action span { font: 600 10px var(--body); color: #8a5a1c; } & .action span:empty { display: none; }
    & .action:disabled { opacity: .5; filter: none; }
    & .tool-icon { display: grid; height: 24px; font-style: normal; color: #4c6a3a; }
    & .hint { border-radius: 2px; font: 600 14px var(--body); color: #2f3a22; padding: 7px 14px; }
    /* Sideways the bed is short, so the tip moves beside it instead of lying across it. */
    @media (orientation: landscape) { & .hint { left: 0; bottom: 6px; max-width: 30%; } }
    & .toast { color: #f5efd8; font-weight: 400; font-size: 24px; }
    /* Modals: titles are painted on the dark glass; rows are plant labels with a punched hole; results sit on brass. */
    & #modal h2 { color: #f5efd8; font-weight: 400; letter-spacing: .03em; text-align: center; }
    & #modal .modal-card > p { color: #b9c9ad; text-align: center; font-style: italic; }
    & .choice { border-left: 0; padding: 10px 14px 10px 30px; position: relative; clip-path: polygon(14px 0, 100% 0, 100% 100%, 14px 100%, 0 50%); }
    & .choice::before { content: ""; position: absolute; left: 14px; top: 50%; width: 7px; height: 7px; margin-top: -4px; border-radius: 50%; background: #0c1a17; }
    & .choice b { font-weight: 400; font-size: 17px; } & .choice span { font-size: 13px; font-style: italic; }
    & .choice em { color: #4c6a3a; font: 400 11px var(--display); }
    & .choice .bud { border-color: #8a9a7a; } & .choice .bud.lit { border-color: #2f8fb5; box-shadow: 0 0 6px 1px rgba(47,143,181,.6); }
    /* Bed list: chapters are painted headings; the daily and wild beds are brass tags above the campaign. */
    & .chapter { margin: 8px 0 0; font: 400 13px var(--display); letter-spacing: .14em; color: #b9c9ad; }
    & .choice.mode { background: ${BRASS}; color: #33260a; } & .choice.mode span { color: #5b4514; } & .choice.mode em { color: #33260a; }
    & .garden-note { margin: 0; text-align: center; font: italic 500 13px var(--body); color: #b9c9ad; }
    /* Result card: one line per goal, its bud beside it. */
    & .goal-list { align-self: stretch; display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; background: var(--panel); border-radius: 3px; }
    & .goal-list div { display: flex; align-items: center; gap: 12px; font: 500 14px var(--body); }
    & .goal-list .missed { color: var(--dim); } & .goal-list b { margin-left: auto; font: 400 11px var(--display); color: #2f8fb5; }
    & .goal-list .bud { flex: none; border-color: #8a9a7a; } & .goal-list .bud.lit { border-color: #2f8fb5; }
    & .news { margin: 0; text-align: center; font: 400 15px var(--display); color: #ffe9a8; }
    & .sheet-body { filter: drop-shadow(0 2px 0 rgba(0,0,0,.4)); gap: 7px; }
    & .rows { background: ${BRASS}; border: 0; color: #33260a; box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -2px 0 rgba(60,40,5,.35); }
    & .rows span { color: #5b4514; font-family: var(--display); } & .rows b { text-shadow: 0 1px 0 rgba(255,255,255,.45); }
    & .result { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    & .result .rows { align-self: stretch; }
    & .primary { font-weight: 400; letter-spacing: .06em; border-radius: 3px; text-shadow: 0 1px 0 rgba(255,255,255,.4); }
  `;

  /** The HUD look (see kit/theme.js): starts from the parchment skin's ink-on-cream surfaces, then swaps type, metal and shapes. */
  const THEME = {
    skin: 'parchment',
    fonts: ['Marcellus SC', 'Lora:ital,wght@0,500;0,600;1,500'],
    tokens: {
      '--display': '"Marcellus SC", Georgia, serif',
      '--body': '"Lora", Georgia, serif',
      '--panel': 'linear-gradient(180deg, #f6efd6 0%, #e6dab4 100%)', // cream plant label
      '--ink': '#2f3a22', // greenhouse-marker ink
      '--dim': '#6f7859',
      '--line': 'rgba(60, 70, 40, 0.35)',
      '--accent': '#c9a652', // brass
      '--accent-ink': '#33260a',
      '--accent-edge': '#7d6223',
      '--scrim': 'rgba(5, 16, 14, 0.78)',
      '--radius': '3px',
      '--radius-lg': '3px',
      '--border': '0px',
      '--shadow': 'none',
      '--stat-size': '19px',
      '--label-spacing': '0.08em',
      '--floater': '#bff3ff',
    },
    layout: { stats: 'top-center', actions: 'bottom' },
    css: THEME_CSS,
    components: {
      /** A tool: line icon over an inked name. `label` and `sub` are the live elements the kit keeps updating. */
      action: ({ id, label, sub, h }) => {
        const button = h('button', 'action');
        const icon = h('i', 'tool-icon');
        icon.innerHTML = svgIcon(TOOL_ICONS[id]);
        button.append(icon, label, sub);
        return button;
      },
    },
  };

  window.PRISM_THEME = { THEME, budRow };
})();
