/**
 * Swarm Arena, theme: the HUD as an arcade vector instrument panel.
 *
 * Owns: `Arena.theme` - tokens, fonts, layout and the scoped stylesheet for everything the game shows in HTML: the
 *       instrument strip, the hull cells, the XP trace, the dash key, synergy chips, the warden bar, the level-up
 *       cards, the score readout and the hangar.
 * Does not own: the markup (kit/ui.js builds the components; games/arena.js builds the hangar inside ui.panel) or
 *       anything drawn in the scene.
 *
 * The look starts from the 'neon' skin but swaps its magenta-and-cyan glow boxes for the ship's own phosphor mint on
 * black with coral alerts, Oxanium for display and Share Tech Mono for every readout, so it reads as the arena's
 * cockpit rather than a synthwave poster. One idea throughout: square hairline frames that glow in their own colour,
 * uppercase monospace labels, and nothing filled except what is live (lit cells, the XP trace, a charged dash).
 */
(() => {
  /** Scoped stylesheet: "&" is this game's HUD root (kit/theme.js). Class names not from kit/ui.js are built in games/arena.js. */
  const CSS = `
    /* Top strip: the readouts share one frame, divided by hairlines, like a single instrument. */
    & #stats { gap: 0; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow); }
    & .stat { background: none; border: 0; border-left: 1px solid var(--line-soft); border-radius: 0; box-shadow: none; padding: 5px 10px 4px; min-width: 50px; backdrop-filter: none; }
    & .stat:first-child { border-left: 0; }
    & .stat span { font: 10px var(--body); color: var(--dim); }
    & .stat b { font: 400 17px var(--body); text-shadow: 0 0 8px currentColor; }
    & .stat.pulse b { color: var(--amber); }
    /* Hull: ten skewed cells, lit from the left. Low hull turns the lit cells coral and makes them blink. */
    & .pip-row { display: flex; gap: 2px; margin-top: 5px; }
    & .pip { width: 7px; height: 11px; border: 1px solid var(--line-soft); border-radius: 0; background: none; transform: skewX(-14deg); }
    & .pip.on { background: var(--ink); border-color: var(--ink); box-shadow: 0 0 6px var(--ink); }
    & .pips.low .pip.on { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 8px var(--accent); animation: arena-blink .5s steps(2, jump-none) infinite; }
    @keyframes arena-blink { to { opacity: .45; } }
    & .chip { background: var(--panel); border-radius: 0; color: var(--ink); box-shadow: var(--shadow); backdrop-filter: none; }
    /* XP: a ruled trace rather than a bar, with the level printed under its left end and the wave under its right. */
    & .progress { height: 9px; overflow: visible; border-radius: 0; background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), var(--line-soft) calc(10% - 1px) 10%); border: 1px solid var(--line); }
    & .progress i { background: var(--ink); box-shadow: 0 0 10px var(--ink); }
    & .progress span { inset: 100% auto auto 0; display: block; margin-top: 4px; font: 10px var(--body); letter-spacing: .18em; color: var(--dim); }
    & .wave-tag { position: absolute; right: 0; top: 23px; font: 10px var(--body); letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
    /* Synergies: one small framed chip per active set bonus, in its own colour. */
    & .synergy-row { position: absolute; left: 0; top: 42px; display: flex; flex-wrap: wrap; gap: 4px; max-width: 70%; }
    & .synergy-chip { padding: 1px 6px; border: 1px solid var(--c); color: var(--c); font: 10px var(--body); letter-spacing: .14em; text-transform: uppercase; text-shadow: 0 0 8px var(--c); background: var(--panel); }
    /* The warden's hull: a coral trace across the bottom of the play field, shown only while one is alive. */
    & .boss-bar { position: absolute; left: 0; right: 0; bottom: 6px; height: 8px; border: 1px solid var(--accent); background: var(--panel); box-shadow: 0 0 14px -4px var(--accent); }
    & .boss-bar[hidden] { display: none; }
    & .boss-bar i { position: absolute; inset: 0 auto 0 0; background: var(--accent); box-shadow: 0 0 10px var(--accent); transition: width .15s linear; }
    & .boss-bar span { position: absolute; left: 0; bottom: 100%; margin-bottom: 3px; font: 10px var(--body); letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
    /* Dash: a single square key at the bottom right. It fills with light when charged and empties as it recharges. */
    & .action { position: relative; overflow: hidden; min-width: 104px; padding: 10px 14px; border-radius: 0; border: 1px solid var(--line); border-bottom-width: 1px; background: var(--panel); box-shadow: var(--shadow); backdrop-filter: none; }
    & .action b { font: 800 14px var(--display); letter-spacing: .22em; text-transform: uppercase; }
    & .action span { font: 10px var(--body); letter-spacing: .14em; color: var(--dim); text-transform: uppercase; }
    & .action::before { content: ""; position: absolute; inset: 0 auto 0 0; width: calc(var(--charge, 1) * 100%); background: rgba(77, 226, 197, .16); }
    & .action.ready { border-color: var(--ink); box-shadow: 0 0 14px -3px var(--ink); }
    & .action.ready span { color: var(--ink); }
    & .toast { font: 800 22px var(--display); letter-spacing: .32em; text-transform: uppercase; color: var(--accent); text-shadow: 0 0 14px var(--accent); }
    & .toast::before { content: "// "; opacity: .5; }
    & .toast::after { content: " //"; opacity: .5; }
    & .hint { border-radius: 0; font: 12px var(--body); letter-spacing: .08em; text-transform: uppercase; text-align: center; }
    & .hint::before { content: "> "; color: var(--accent); }
    & .floater { font-family: var(--display); text-shadow: 0 0 10px currentColor; letter-spacing: .08em; text-transform: uppercase; }
    /* Level-up: numbered vector cards, each outlined and lit in its upgrade's own colour. */
    & .modal-card { counter-reset: arena-option; gap: 12px; }
    & .modal-card h2 { font: 800 30px var(--display); letter-spacing: .14em; text-transform: uppercase; text-shadow: 0 0 14px currentColor; }
    & .modal-card p { font: 12px var(--body); letter-spacing: .14em; text-transform: uppercase; }
    & .modal-card p::before { content: "> "; color: var(--accent); }
    & .choice { counter-increment: arena-option; position: relative; padding: 13px 14px 12px 50px; border: 1.5px solid var(--c); border-radius: 0; background: rgba(2, 10, 12, .86); box-shadow: 0 0 16px -3px var(--c), inset 0 0 22px -10px var(--c); }
    & .choice::before { content: counter(arena-option, decimal-leading-zero); position: absolute; inset: 0 auto 0 0; width: 38px; display: grid; place-items: center; border-right: 1px solid var(--c); font: 800 16px var(--display); color: var(--c); text-shadow: 0 0 10px var(--c); }
    & .choice b { font: 800 17px var(--display); letter-spacing: .08em; text-transform: uppercase; color: var(--c); text-shadow: 0 0 10px var(--c); }
    & .choice em { padding: 1px 6px; border: 1px solid var(--c); font: 10px var(--body); white-space: nowrap; }
    & .choice span { font: 13px/1.35 var(--body); color: var(--readout); }
    /* Game over: a score readout. The first row is the big number; the rest are ruled lines under it. */
    & .rows { padding: 4px 0 0; gap: 0; background: none; border: 0; border-top: 1px solid var(--line); border-radius: 0; box-shadow: none; }
    & .rows div { padding: 6px 2px; border-bottom: 1px dashed var(--line-soft); align-items: baseline; }
    & .rows span { font: 11px var(--body); letter-spacing: .16em; text-transform: uppercase; }
    & .rows b { font: 400 17px var(--body); text-shadow: 0 0 8px currentColor; }
    & .rows div:first-child { flex-direction: column; align-items: center; gap: 2px; padding: 12px 0 14px; border-bottom: 1px solid var(--line); }
    & .rows div:first-child b { font: 800 60px/1 var(--display); letter-spacing: .04em; text-shadow: 0 0 22px currentColor; }
    & .primary { background: rgba(255, 93, 115, .08); color: var(--accent); border: 1.5px solid var(--accent); border-radius: 0; font: 800 16px var(--display); letter-spacing: .22em; text-transform: uppercase; box-shadow: 0 0 16px -3px var(--accent), inset 0 0 18px -8px var(--accent); text-shadow: 0 0 10px var(--accent); }
    /* Hangar: three racks of square keys (ship, arena, threat) and the trophy log, inside the kit's scrolling sheet. */
    & .hangar-rack { display: flex; flex-direction: column; gap: 6px; }
    & .hangar-rack h3 { margin: 6px 0 0; font: 11px var(--body); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
    & .hangar-rack h3::before { content: "> "; color: var(--accent); }
    & .hangar-key { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 9px 12px; border: 1px solid var(--line-soft); background: rgba(2, 10, 12, .8); color: var(--readout); }
    & .hangar-key b { font: 800 15px var(--display); letter-spacing: .1em; text-transform: uppercase; color: var(--ink); }
    & .hangar-key span { font: 12px/1.35 var(--body); }
    & .hangar-key em { font: normal 11px var(--body); color: var(--amber); }
    & .hangar-key[aria-pressed="true"] { border-color: var(--ink); box-shadow: 0 0 14px -3px var(--ink), inset 0 0 18px -10px var(--ink); }
    & .hangar-key[aria-pressed="true"] b { text-shadow: 0 0 10px var(--ink); }
    & .hangar-key:disabled { opacity: .55; border-style: dashed; }
    & .hangar-key:disabled b { color: var(--dim); }
    & .trophy { display: flex; justify-content: space-between; gap: 10px; padding: 5px 2px; border-bottom: 1px dashed var(--line-soft); font: 12px var(--body); color: var(--readout); }
    & .trophy b { font-weight: 400; color: var(--dim); white-space: nowrap; }
    & .trophy.done { color: var(--ink); }
    & .trophy.done b { color: var(--amber); }
  `;

  window.Arena.theme = {
    skin: 'neon',
    fonts: ['Oxanium:wght@500;800', 'Share Tech Mono'],
    tokens: {
      '--display': '"Oxanium", "Trebuchet MS", sans-serif',
      '--body': '"Share Tech Mono", ui-monospace, "Courier New", monospace',
      '--ink': '#9ff5e2',
      '--dim': '#4f9d8f',
      '--readout': '#b7d6cf', // running text on cards: the ink, greyed so the coloured titles lead
      '--amber': '#ffd866', // the shot colour, for a readout that just ticked and for rewards
      '--panel': 'rgba(2, 12, 14, 0.62)',
      '--line': 'rgba(77, 226, 197, 0.6)',
      '--line-soft': 'rgba(77, 226, 197, 0.24)',
      '--accent': '#ff5d73',
      '--accent-ink': '#1a0308',
      '--accent-edge': '#8f2334',
      '--scrim': 'rgba(1, 5, 8, 0.8)',
      '--radius': '0px',
      '--radius-lg': '0px',
      '--border': '1px',
      '--shadow': '0 0 14px -5px rgba(77, 226, 197, 0.9)',
      '--label-spacing': '0.16em',
      '--floater': '#ffd866',
    },
    layout: { stats: 'top-right', actions: 'bottom-right' },
    css: CSS,
  };
})();
