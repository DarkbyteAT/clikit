/**
 * Spot Kick Showdown theme: the interface as the ground's own scoreboard. One idea throughout: a dark board
 * with hard square edges, amber lamps for what is live, chalk white for text, and every count drawn as a row of
 * lamps (a kick taken is a lamp lit or a lamp dead), in the chunky pixel type a small-town scoreboard would have.
 *
 * Owns:  `SPOT_KICK_THEME`: skin, fonts, tokens and the scoped stylesheet of everything the game shows in HTML
 *        (the scoreboard, the role strip, the power lamp row, callouts, the clubhouse sheet and its cards).
 * Does not own: the markup (games/penalty.js builds it from kit/ui/ components) or anything drawn in the scene.
 */
(() => {
  /** Scoped stylesheet: "&" is this game's HUD root (kit/theme.js). Class names starting `sk-` are built in games/penalty.js. */
  const CSS = `
    & .sk-top { position: absolute; top: calc(52px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; width: min(96%, 420px); }
    & .sk-board { display: grid; grid-template-columns: auto 1fr auto; gap: 3px 8px; align-items: center; padding: 6px 10px; background: var(--panel); border: 2px solid var(--line); box-shadow: 0 4px 0 rgba(0, 0, 0, .45); width: 100%; box-sizing: border-box; }
    & .sk-board b { font: 400 13px var(--display); color: var(--ink); letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
    & .sk-board b[data-side="you"] { color: var(--accent); }
    & .sk-board output { font: 400 18px var(--display); color: var(--accent); min-width: 1ch; text-align: right; }
    & .sk-lamps { display: flex; gap: 5px; justify-content: center; }
    & .sk-lamp { width: 12px; height: 12px; background: #0c1020; border: 2px solid #3a4266; box-sizing: border-box; }
    & .sk-lamp[data-state="goal"] { background: var(--accent); border-color: #fff3c4; box-shadow: 0 0 0 2px rgba(255, 196, 69, .28); }
    & .sk-lamp[data-state="miss"] { background: #6b1f2c; border-color: var(--hot); }
    & .sk-lamp[data-state="next"] { border-color: var(--ink); animation: sk-blink .7s steps(2, jump-none) infinite; }
    @keyframes sk-blink { to { border-color: #3a4266; } }
    & .sk-strip { display: flex; gap: 6px; align-items: stretch; justify-content: center; flex-wrap: wrap; }
    & .sk-chip { padding: 3px 8px 2px; background: var(--panel); border: 2px solid var(--line); font: 400 11px var(--display); color: var(--ink); letter-spacing: .05em; white-space: nowrap; }
    & .sk-chip[data-tone="hot"] { border-color: var(--hot); color: #ffd9d2; }
    & .sk-chip[data-tone="live"] { border-color: var(--accent); color: var(--accent); }
    & .sk-chip[hidden] { display: none; }
    & .sk-bottom { position: absolute; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; width: min(94%, 420px); pointer-events: none; }
    & .sk-scout { padding: 4px 10px; background: rgba(10, 14, 32, .78); border-left: 4px solid var(--accent); font: 500 14px var(--body); color: var(--ink); text-align: left; width: 100%; box-sizing: border-box; }
    & .sk-scout small { display: block; font: 400 9px var(--display); color: var(--dim); letter-spacing: .1em; margin-bottom: 1px; }
    & .sk-scout[hidden] { display: none; }
    & .sk-power { display: flex; gap: 3px; padding: 4px; background: var(--panel); border: 2px solid var(--line); }
    & .sk-power i { width: 9px; height: 14px; background: #0c1020; }
    & .sk-power i[data-on] { background: var(--accent); }
    & .sk-power i[data-zone="sweet"] { box-shadow: inset 0 -3px 0 #7be07b; }
    & .sk-power i[data-zone="over"] { box-shadow: inset 0 -3px 0 var(--hot); }
    & .sk-power i[data-on][data-zone="over"] { background: var(--hot); }
    & .sk-power[hidden] { display: none; }
    & .toast { font: 400 30px var(--display); color: #fff; text-shadow: 3px 3px 0 #0c1020, -1px -1px 0 #0c1020; letter-spacing: .04em; }
    & .hint { font: 500 15px var(--body); background: rgba(10, 14, 32, .85); border: 2px solid var(--line); border-radius: 0; }
    & .modal-card { border-radius: 0; border: 2px solid var(--line); box-shadow: 0 6px 0 rgba(0, 0, 0, .5); }
    & .modal-card h2 { font: 400 24px var(--display); color: var(--accent); }
    /* A phone on its side: the board and the bench's note move to the left edge, clear of the goal. */
    @media (orientation: landscape) and (max-height: 520px) {
      & .sk-top { left: calc(12px + env(safe-area-inset-left, 0px)); transform: none; width: 232px; align-items: flex-start; }
      & .sk-strip { justify-content: flex-start; }
      & .sk-bottom { left: calc(12px + env(safe-area-inset-left, 0px)); transform: none; width: 232px; align-items: flex-start; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
      & .hint { bottom: 8px; }
    }
    /* The clubhouse sheet (a dialog: outside the HUD layer, inside the game's scope). */
    & .sk-club { display: flex; flex-direction: column; gap: 10px; }
    & .sk-club h3 { margin: 6px 0 0; font: 400 13px var(--display); color: var(--accent); letter-spacing: .06em; }
    & .sk-club p { margin: 0; font: 500 14px var(--body); color: var(--dim); }
    & .sk-purse { align-self: flex-end; padding: 3px 10px; border: 2px solid var(--accent); color: var(--accent); font: 400 13px var(--display); }
    & .sk-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    & .sk-club .ui-card { border-radius: 0; border-width: 2px; text-align: left; }
    & .sk-club .ui-card.sk-on { border-color: var(--accent); box-shadow: inset 0 0 0 2px rgba(255, 196, 69, .25); }
    & .sk-club .ui-card.sk-done { opacity: .7; }
    & .sk-club .ui-card.sk-locked { opacity: .45; }
    & .sk-notes { margin: 4px 0 0; padding: 0 0 0 16px; font: 500 13px var(--body); color: var(--ink); }
  `;

  window.SPOT_KICK_THEME = {
    theme: {
      skin: 'pixel',
      fonts: ['Silkscreen:wght@400;700', 'Pixelify Sans:wght@500;700'],
      tokens: {
        '--display': '"Silkscreen", "Courier New", monospace',
        '--body': '"Pixelify Sans", system-ui, sans-serif',
        '--panel': '#141a33',
        '--ink': '#f2f1e4',
        '--dim': '#8f9ac8',
        '--line': '#3a4266',
        '--accent': '#ffc445',
        '--accent-ink': '#141a33',
        '--accent-edge': '#a87412',
        '--hot': '#ff5f4a',
        '--scrim': 'rgba(8, 10, 24, .7)',
        '--radius': '0px',
        '--radius-lg': '0px',
        '--border': '2px',
        '--shadow': '0 4px 0 rgba(0, 0, 0, .45)',
        '--blur': '0px',
        '--floater': '#ffc445',
      },
      css: CSS,
    },
  };
})();
