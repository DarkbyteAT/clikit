/**
 * Kit creator theme: the character creator's own look, as a theme for `Kit.register`. Calm and tool-like, so the
 * character is the loudest thing on the screen: a graphite panel, one soft mint accent, flat buttons with no
 * lip, sentence-case labels and a geometric display face over a friendly text face.
 *
 * Owns:  `Kit.creator.THEME` (tokens, fonts and scoped CSS in the shape kit/theme.js takes).
 * Does not own: the layout of the creator (the components' own styles), or the 3D backdrop colour (kit/creator.js).
 *
 * Fonts come from Google Fonts only (the one font host the published page allows); every stack falls back to a
 * system face, so the screen is complete without them.
 */
(() => {
  /**
   * @type {Object}
   * @see Kit.theme for the shape: `skin`, `fonts`, `tokens`, `css` (where `&` is this screen's own page).
   */
  const THEME = Object.freeze({
    skin: 'glass',
    fonts: ['Sora:wght@500;600', 'Figtree:wght@400;500;600'],
    tokens: {
      '--display': '"Sora", "Avenir Next", "Trebuchet MS", system-ui, sans-serif',
      '--body': '"Figtree", "Avenir Next", system-ui, -apple-system, "Segoe UI", sans-serif',
      '--ink': '#e9edf2',
      '--dim': '#98a2b0',
      '--panel': '#161a21',
      '--line': 'rgba(255, 255, 255, 0.1)',
      '--accent': '#86d9c3',
      '--accent-ink': '#08201a',
      '--accent-edge': '#86d9c3',
      '--accent-soft': 'rgba(134, 217, 195, 0.12)',
      '--hot': '#ff9d8d',
      '--scrim': 'rgba(8, 10, 14, 0.62)',
      '--radius': '8px',
      '--radius-lg': '12px',
      '--border': '1px',
      '--shadow': 'none',
      '--blur': '0px',
      '--label-case': 'none',
      '--label-spacing': '0.01em',
    },
    css: `
      & .ui-button { border-bottom-width: var(--border); font-weight: 600; }
      & .ui-button:active:not(:disabled), & .ui-button[aria-pressed="true"] { transform: none; margin-bottom: 0; }
      & .ui-button[data-variant="primary"] { border-color: var(--accent); }
      & .ui-button:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.28); }
      & .ui-tablist [role="tab"] { font-family: var(--body); }
      & .ui-tablist [role="tab"][aria-selected="true"] { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); border-radius: var(--radius) var(--radius) 0 0; }
      & .ui-slider input { accent-color: var(--accent); }
      & .ui-label { font-weight: 500; }
      & .ui-dialog-card { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); }
      & #hud-top .chip { background: rgba(22, 26, 33, 0.82); }
      & #game-name { display: none; }
    `,
  });

  Kit.creator = Object.assign(Kit.creator || {}, { THEME });
})();
