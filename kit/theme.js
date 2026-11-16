/**
 * Kit theme: the customisation layer that lets each game's HUD look native to that game.
 *
 * Owns: design tokens (CSS custom properties), skins (named starting points), font loading, per-game scoped CSS,
 *       and applying / clearing all of that when a game starts or exits.
 * Does not own: the HUD components themselves (kit/ui.js builds them and consults `theme.components` for overrides)
 *       or the base stylesheet (index.html, which reads every token listed in TOKEN_DEFAULTS).
 *
 * A game opts in from its registration:
 *
 *   Kit.register({
 *     id: 'cozy',
 *     theme: {
 *       skin: 'paper',                                   // start from a skin (see SKINS)...
 *       fonts: ['Pixelify Sans:wght@500;700'],           // ...load Google Fonts families...
 *       tokens: { '--display': '"Pixelify Sans", monospace', '--accent': '#e2725b' },   // ...override tokens...
 *       layout: { stats: 'top-center', actions: 'bottom' },                            // ...place the HUD regions...
 *       css: '& .stat { transform: rotate(-1.5deg); }',  // ...add CSS scoped to this game ("&" is the game's root)...
 *       components: { stat: ({ label, value, h }) => customElement },                  // ...or rebuild a component.
 *     },
 *     create(ctx) { ... },
 *   });
 *
 * Everything is optional: a game with no `theme` gets the default "glass" skin.
 */
(() => {
  /**
   * Every token the base stylesheet reads, with the value used when neither the skin nor the game sets it.
   * Colours are any CSS colour; sizes are CSS lengths.
   * @type {Record<string, string>}
   */
  const TOKEN_DEFAULTS = {
    '--display': '"Chakra Petch", "Trebuchet MS", system-ui, sans-serif', // headings, numbers, buttons
    '--body': '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif', // running text
    '--ink': '#eef2ff', // primary text
    '--dim': '#9aa6cf', // secondary text and labels
    '--panel': 'rgba(13, 18, 40, 0.78)', // surface behind stats, buttons, cards
    '--line': 'rgba(160, 180, 255, 0.22)', // borders
    '--accent': '#ffc145', // primary button, highlights, prices
    '--accent-ink': '#1a1205', // text on top of --accent
    '--accent-edge': '#b27d10', // the darker lip under the primary button
    '--scrim': 'rgba(4, 6, 16, 0.62)', // dimmer behind modals
    '--radius': '10px', // small surfaces: stats, chips
    '--radius-lg': '14px', // large surfaces: cards, buttons
    '--border': '1px', // border thickness
    '--shadow': 'none', // box-shadow on surfaces
    '--blur': '6px', // backdrop blur behind surfaces
    '--label-case': 'uppercase', // text-transform of small labels
    '--label-spacing': '0.1em', // letter-spacing of small labels
    '--stat-size': '18px', // size of stat values
    '--floater': '#ffc145', // floating score text
  };

  /**
   * @typedef {Object} Theme
   * @property {string} [skin]      Name of a skin in SKINS to start from. Default 'glass'.
   * @property {string[]} [fonts]   Google Fonts families in css2 form, e.g. 'Pixelify Sans:wght@500;700'.
   * @property {Record<string, string>} [tokens]  Token overrides; keys are the names in TOKEN_DEFAULTS (or your own).
   * @property {{ stats?: 'top-right'|'top-center'|'top-left', actions?: 'bottom'|'bottom-right' }} [layout]
   * @property {string} [css]       Extra CSS. "&" is replaced by a selector matching only this game's HUD.
   * @property {Record<string, Function>} [components]  Component builders that replace the kit's (see kit/ui.js).
   */

  /**
   * Skins: complete looks a game can start from. Each is just a Theme, so a game's own theme merges over it.
   * Add a skin by adding a row; nothing else needs to change.
   * @type {Record<string, Theme>}
   */
  const SKINS = {
    // Frosted dark panels. The default, and the look of the menu.
    glass: {},

    // Hollow glowing outlines for vector / synthwave games.
    neon: {
      fonts: ['Orbitron:wght@500;800'],
      tokens: {
        '--display': '"Orbitron", "Trebuchet MS", sans-serif',
        '--panel': 'rgba(4, 6, 20, 0.35)',
        '--line': 'currentColor',
        '--ink': '#7df9ff',
        '--dim': '#c58cff',
        '--accent': '#ff4fd8',
        '--accent-ink': '#12001a',
        '--accent-edge': '#a8128a',
        '--radius': '2px',
        '--radius-lg': '2px',
        '--border': '1.5px',
        '--shadow': '0 0 10px currentColor, inset 0 0 8px rgba(125, 249, 255, 0.25)',
        '--blur': '0px',
        '--floater': '#7df9ff',
      },
    },

    // Chunky hard-edged boxes with a stepped drop shadow, for pixel-art games.
    pixel: {
      fonts: ['Pixelify Sans:wght@500;700'],
      tokens: {
        '--display': '"Pixelify Sans", "Courier New", monospace',
        '--body': '"Pixelify Sans", "Courier New", monospace',
        '--panel': '#fff8e7',
        '--ink': '#3b2a1a',
        '--dim': '#8a6f52',
        '--line': '#3b2a1a',
        '--accent': '#f2a541',
        '--accent-ink': '#3b2a1a',
        '--accent-edge': '#3b2a1a',
        '--scrim': 'rgba(59, 42, 26, 0.45)',
        '--radius': '0px',
        '--radius-lg': '0px',
        '--border': '3px',
        '--shadow': '4px 4px 0 rgba(59, 42, 26, 0.85)',
        '--blur': '0px',
        '--label-spacing': '0.04em',
        '--floater': '#fff8e7',
      },
      // Pixelify Sans joins "fi" into one glyph that reads as "A" at HUD sizes ("fish" looks like "Ash"): keep letters apart.
      css: '& #hud, & #modal, & #floaters { font-variant-ligatures: none; }',
    },

    // Cut paper: warm off-white cards, soft shadow, ink text. For cozy and storybook games.
    paper: {
      fonts: ['Fredoka:wght@500;700'],
      tokens: {
        '--display': '"Fredoka", "Trebuchet MS", sans-serif',
        '--body': '"Fredoka", system-ui, sans-serif',
        '--panel': '#fdf6e3',
        '--ink': '#4a3b2a',
        '--dim': '#9a8468',
        '--line': 'rgba(74, 59, 42, 0.18)',
        '--accent': '#e2725b',
        '--accent-ink': '#fff8ee',
        '--accent-edge': '#b34f3c',
        '--scrim': 'rgba(74, 59, 42, 0.4)',
        '--radius': '14px',
        '--radius-lg': '18px',
        '--shadow': '0 3px 0 rgba(74, 59, 42, 0.25)',
        '--blur': '0px',
        '--label-case': 'none',
        '--label-spacing': '0.02em',
        '--floater': '#fff8ee',
      },
    },

    // Carved slabs with a bevel, for mines, dungeons and ruins.
    stone: {
      fonts: ['Grenze Gotisch:wght@500;800'],
      tokens: {
        '--display': '"Grenze Gotisch", Georgia, serif',
        '--panel': 'linear-gradient(180deg, #4b4354 0%, #332d3b 100%)',
        '--ink': '#f3e9d2',
        '--dim': '#b9a98c',
        '--line': '#1d1922',
        '--accent': '#f0b429',
        '--accent-ink': '#2a1c05',
        '--accent-edge': '#8a5f0a',
        '--radius': '4px',
        '--radius-lg': '6px',
        '--border': '2px',
        '--shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -3px 0 rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.5)',
        '--blur': '0px',
        '--stat-size': '20px',
      },
    },

    // Glossy rounded plastic for bright physics toys.
    toy: {
      fonts: ['Baloo 2:wght@600;800'],
      tokens: {
        '--display': '"Baloo 2", "Trebuchet MS", sans-serif',
        '--body': '"Baloo 2", system-ui, sans-serif',
        '--panel': '#ffffff',
        '--ink': '#3d2f6b',
        '--dim': '#8c7fb8',
        '--line': 'rgba(61, 47, 107, 0.12)',
        '--accent': '#8b5cf6',
        '--accent-ink': '#ffffff',
        '--accent-edge': '#5b34c4',
        '--scrim': 'rgba(61, 47, 107, 0.35)',
        '--radius': '999px',
        '--radius-lg': '22px',
        '--border': '0px',
        '--shadow': '0 4px 0 rgba(61, 47, 107, 0.18), 0 8px 18px rgba(61, 47, 107, 0.16)',
        '--blur': '0px',
        '--label-case': 'none',
        '--label-spacing': '0',
        '--floater': '#ffffff',
      },
    },

    // Hairline minimal: almost no chrome, for calm precise games where the HUD should disappear.
    air: {
      fonts: ['Manrope:wght@400;800'],
      tokens: {
        '--display': '"Manrope", system-ui, sans-serif',
        '--body': '"Manrope", system-ui, sans-serif',
        '--panel': 'transparent',
        '--line': 'transparent',
        '--radius': '0px',
        '--border': '0px',
        '--blur': '0px',
        '--stat-size': '26px',
        '--label-spacing': '0.22em',
      },
    },

    // Aged parchment and ink for tabletop, maps and fantasy tools.
    parchment: {
      fonts: ['IM Fell English SC', 'Alegreya:wght@400;700'],
      tokens: {
        '--display': '"IM Fell English SC", Georgia, serif',
        '--body': '"Alegreya", Georgia, serif',
        '--panel': 'linear-gradient(180deg, #f1e3c0 0%, #e2cf9f 100%)',
        '--ink': '#3a2a17',
        '--dim': '#7a6240',
        '--line': '#7a5a2e',
        '--accent': '#8c1c13',
        '--accent-ink': '#f6ead0',
        '--accent-edge': '#5a0f0a',
        '--scrim': 'rgba(30, 20, 8, 0.55)',
        '--radius': '3px',
        '--radius-lg': '4px',
        '--border': '1.5px',
        '--shadow': '0 2px 8px rgba(30, 20, 8, 0.45)',
        '--blur': '0px',
        '--label-case': 'none',
        '--label-spacing': '0.04em',
        '--floater': '#f6ead0',
      },
    },
  };

  const DEFAULT_SKIN = 'glass';
  const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2';
  const SCOPED_STYLE_ID = 'kit-theme-css';
  /** Font families already requested, so each stylesheet is added to the page once. */
  const requestedFonts = new Set();

  /**
   * Merge a game's theme over its skin. Tokens and components merge key by key; fonts concatenate; css concatenates.
   * @param {Theme} [gameTheme]
   * @returns {Required<Theme>} A complete theme with every field present.
   */
  function resolve(gameTheme = {}) {
    const skinName = gameTheme.skin || DEFAULT_SKIN;
    const skin = SKINS[skinName];
    if (!skin) throw new Error(`Kit.theme: unknown skin "${skinName}" (known: ${Object.keys(SKINS).join(', ')})`);
    return {
      skin: skinName,
      fonts: [...(skin.fonts || []), ...(gameTheme.fonts || [])],
      tokens: { ...TOKEN_DEFAULTS, ...skin.tokens, ...gameTheme.tokens },
      layout: { stats: 'top-right', actions: 'bottom', ...skin.layout, ...gameTheme.layout },
      css: [skin.css, gameTheme.css].filter(Boolean).join('\n'),
      components: { ...skin.components, ...gameTheme.components },
    };
  }

  /**
   * Ask the browser to load Google Fonts families that have not been requested yet.
   * Google Fonts is the only font host the published page's security policy allows.
   * @param {string[]} families css2-form family specs, e.g. 'Fredoka:wght@500;700'.
   */
  function loadFonts(families) {
    const fresh = families.filter((family) => !requestedFonts.has(family));
    if (!fresh.length) return;
    fresh.forEach((family) => requestedFonts.add(family));
    const query = fresh.map((family) => 'family=' + family.trim().replace(/ /g, '+')).join('&');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${GOOGLE_FONTS_URL}?${query}&display=swap`;
    document.head.appendChild(link);
  }

  /**
   * Apply a game's theme to the page: tokens on <body>, skin / game / layout as data attributes for CSS to key on,
   * fonts requested, scoped CSS installed. Returns the resolved theme so kit/ui.js can read `components`.
   * @param {string} gameId  The game's registered id; scoped CSS only matches while this game is active.
   * @param {Theme} [gameTheme]
   * @returns {Required<Theme>}
   */
  function apply(gameId, gameTheme) {
    clear();
    const theme = resolve(gameTheme);
    const body = document.body;
    Object.entries(theme.tokens).forEach(([name, value]) => body.style.setProperty(name, value));
    body.dataset.game = gameId;
    body.dataset.skin = theme.skin;
    body.dataset.stats = theme.layout.stats;
    body.dataset.actions = theme.layout.actions;
    loadFonts(theme.fonts);
    if (theme.css) {
      const style = document.createElement('style');
      style.id = SCOPED_STYLE_ID;
      // "&" stands for "this game's HUD", so one game's CSS can never leak into another's.
      style.textContent = theme.css.replace(/&/g, `body[data-game="${gameId}"]`);
      document.head.appendChild(style);
    }
    return theme;
  }

  /** Remove every trace of the active theme (called when a game exits to the menu or restarts). */
  function clear() {
    const body = document.body;
    Object.keys(TOKEN_DEFAULTS).forEach((name) => body.style.removeProperty(name));
    // Tokens a game invented itself were also set inline; drop any remaining custom properties.
    [...body.style].filter((name) => name.startsWith('--')).forEach((name) => body.style.removeProperty(name));
    ['game', 'skin', 'stats', 'actions'].forEach((key) => delete body.dataset[key]);
    const scoped = document.getElementById(SCOPED_STYLE_ID);
    if (scoped) scoped.remove();
  }

  Kit.theme = { SKINS, TOKEN_DEFAULTS, resolve, apply, clear, loadFonts };
})();
