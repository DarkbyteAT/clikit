// Soulwake theme: the HUD as part of the graveyard. Carved slabs, bone-coloured gothic lettering, lantern flames for
// health, a soul gauge for the absorb meter, the skill tree as a constellation and the absorb roll as a reliquary.
//
// Owns: the `theme` handed to Kit.register (kit/theme.js), plus the two HUD pieces only this game has (the flame row
// and the vitals strip that holds it beside the soul gauge). Does not own: what the HUD shows (games/souls.js) or the
// generic views it restyles (kit/views.js; their class names are that file's documented contract).
// Exposed as the global SOULWAKE_THEME.
(() => {
  /** Lantern flames in the health row; each stands for an equal share of max health. */
  const FLAME_COUNT = 5;

  /**
   * Geometry of a constellation star, in CSS pixels. The tree view draws prerequisite lines to a point inside each
   * cell (its `anchor`); these numbers place the star there, and TREE_ANCHOR is derived from them so the two cannot
   * drift apart.
   */
  const STAR = { cellHeight: 112, top: 14, size: 20 };
  /** Kit.views.tree `anchor`: the centre of the star, as fractions of a cell. */
  const TREE_ANCHOR = { x: 0.5, y: (STAR.top + STAR.size / 2) / STAR.cellHeight };

  const TOKENS = {
    '--body': '"Spectral", Georgia, serif',
    '--panel': 'linear-gradient(180deg, rgba(40, 36, 52, 0.95) 0%, rgba(23, 21, 32, 0.97) 100%)',
    '--ink': '#e9e2cf',
    '--dim': '#a39bb0',
    '--line': '#0c0a11',
    '--accent': '#a3e635',
    '--accent-ink': '#12210a',
    '--accent-edge': '#4d7c0f',
    '--scrim': 'rgba(5, 6, 10, 0.8)',
    '--radius': '3px',
    '--radius-lg': '5px',
    '--stat-size': '19px',
    '--label-spacing': '0.14em',
    '--floater': '#d9f99d',
    // Soulwake's own tokens.
    '--soul': '#7ef0c9', // the colour of cleansed souls: the gauge, lit constellation lines
    '--flame': '#ffb347', // a lit lantern flame
    '--flame-core': '#fff3c4',
    '--flame-out': '#3a3446', // a snuffed flame
    '--curse': '#c084fc', // cursed items
    '--gilt': '#d6b34a', // reliquary frame, maxed stars
    '--slab': '#1a1722', // flat stone behind cards
    '--view-good': '#b6f36a',
    '--view-bad': '#f59aa0',
    '--view-node-height': `${STAR.cellHeight}px`,
    '--view-reel-row': '58px',
  };

  const CSS = `
    /* Stats: small headstones (arched top), value over an engraved label. */
    & .stat.sw-headstone { border-radius: 18px 18px 3px 3px; align-items: center; padding: 7px 12px 4px; min-width: 58px; }
    & .stat.sw-headstone span { font-size: 9px; order: 2; }
    & .stat.sw-headstone b { order: 1; text-shadow: 0 0 10px color-mix(in srgb, var(--soul) 45%, transparent); }
    & .chip { border-radius: 18px 18px 3px 3px; font-family: var(--display); }

    /* Vitals strip: lantern flames (health) beside the soul gauge (absorb meter). */
    & .sw-vitals { width: 100%; display: flex; align-items: center; gap: 12px; }
    & .sw-flames { display: flex; align-items: flex-end; gap: 7px; padding: 0 2px 3px; border-bottom: 3px solid var(--line); box-shadow: 0 1px 0 rgba(255, 255, 255, 0.12); }
    & .sw-flames i {
      --lit: 1; width: 13px; height: 13px; margin-top: 6px; border-radius: 0 50% 50% 50%; transform: rotate(45deg) scale(calc(0.55 + 0.45 * var(--lit)));
      background: radial-gradient(circle at 68% 68%, var(--flame-core) 0 18%, var(--flame) 46%, transparent 78%), var(--flame-out);
      background-blend-mode: normal; opacity: calc(0.35 + 0.65 * var(--lit)); filter: saturate(var(--lit));
      box-shadow: 0 0 calc(12px * var(--lit)) color-mix(in srgb, var(--flame) 70%, transparent); transition: transform .25s, opacity .25s;
    }
    & .sw-flames.is-hurt { animation: sw-gutter .3s; }
    @keyframes sw-gutter { 30% { transform: translateX(-3px) scaleY(.8); } 60% { transform: translateX(2px); } }
    & .sw-vitals .progress {
      flex: 1; height: 20px; border-radius: 10px; border: 2px solid var(--line); background: var(--slab);
      box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.7), 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    & .sw-vitals .progress i { background: linear-gradient(90deg, color-mix(in srgb, var(--soul) 55%, var(--slab)), var(--soul) 70%, var(--accent)) !important; box-shadow: 0 0 12px var(--soul); border-radius: 10px; }
    & .sw-vitals .progress span { font-size: 11px; color: var(--ink); text-shadow: 0 1px 2px #000; }

    /* Bottom bar: grave slabs, each with a rune before its name. */
    & .action.sw-slab { gap: 1px; padding: 8px 4px 7px; border-bottom-width: 4px; }
    & .action.sw-slab b::before { content: ''; display: inline-block; width: 9px; height: 9px; margin-right: 8px; transform: rotate(45deg) translateY(-2px); border: 2px solid var(--soul); box-shadow: 0 0 8px var(--soul); }
    & .action.sw-slab b { font-size: 18px; letter-spacing: 0.04em; }
    & .action.sw-slab span { color: var(--accent); font: 600 12px var(--body); }
    & .hint { font-family: var(--display); font-size: 18px; border-radius: 3px; }
    & .toast { font-size: 34px; color: var(--ink); text-shadow: 0 0 18px var(--soul), 0 3px 0 #000; }

    /* Panels and banners: an upright slab with an engraved, centred title. */
    & .modal-card { padding: 16px 14px 14px; background: var(--panel); border: 2px solid var(--line); border-radius: 26px 26px 5px 5px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 14px 40px rgba(0, 0, 0, 0.7); }
    & .modal-card h2 { text-align: center; font-size: 34px; letter-spacing: 0.03em; text-shadow: 0 2px 0 #000, 0 0 16px color-mix(in srgb, var(--soul) 35%, transparent); }
    & .modal-card h2::after { content: ''; display: block; height: 2px; margin: 6px 18% 0; background: linear-gradient(90deg, transparent, var(--dim), transparent); }
    & .modal-card p { text-align: center; }
    & .rows { background: var(--slab); box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.6); }
    & .rows div { border-bottom: 1px dotted color-mix(in srgb, var(--dim) 40%, transparent); padding: 2px 0; }
    & .primary { font-size: 20px; letter-spacing: 0.05em; }

    /* Soul tree: a constellation. Each node is a star with its name beneath; bought stars and their links glow. */
    & .kv-points { text-align: center; color: var(--soul); font-size: 16px; }
    & .kv-tree-heads span { font-size: 17px; color: var(--ink); }
    & .kv-tree-body { border-radius: 5px; background:
      radial-gradient(1px 1px at 12% 18%, var(--dim) 50%, transparent 51%), radial-gradient(1px 1px at 78% 9%, var(--dim) 50%, transparent 51%),
      radial-gradient(1.5px 1.5px at 44% 52%, var(--dim) 50%, transparent 51%), radial-gradient(1px 1px at 88% 71%, var(--dim) 50%, transparent 51%),
      radial-gradient(1px 1px at 23% 86%, var(--dim) 50%, transparent 51%), radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--soul) 10%, transparent), transparent 70%), var(--slab); }
    & .kv-tree-lines line { stroke: color-mix(in srgb, var(--dim) 55%, transparent); stroke-dasharray: 3 5; stroke-width: 1.5; }
    & .kv-tree-lines line[data-active="true"] { stroke: var(--soul); stroke-dasharray: none; stroke-width: 2; filter: drop-shadow(0 0 3px var(--soul)); }
    & .kv-node { margin: 0; padding: ${STAR.top}px 3px 0; justify-content: flex-start; background: none; border: 0; box-shadow: none; border-radius: 0; }
    & .kv-node-mark { display: block; flex: none; width: ${STAR.size}px; height: ${STAR.size}px; margin-bottom: 7px; transform: rotate(45deg); background: var(--slab); border: 2px solid var(--dim); }
    & .kv-node[data-status="available"] .kv-node-mark { border-color: var(--accent); animation: sw-twinkle 1.2s ease-in-out infinite; }
    & .kv-node[data-owned="true"] { background: none; }
    & .kv-node[data-owned="true"] .kv-node-mark { background: var(--soul); border-color: var(--ink); box-shadow: 0 0 14px var(--soul); }
    & .kv-node[data-status="maxed"] .kv-node-mark { background: var(--gilt); box-shadow: 0 0 14px var(--gilt); }
    & .kv-node[data-status="maxed"] em { color: var(--gilt); }
    @keyframes sw-twinkle { 50% { box-shadow: 0 0 12px var(--accent); } }

    /* Inventory: relic cards tinted by rarity; cursed ones wear the curse colour on their tag. */
    & .kv-slot { border-top: 0; border-bottom: 3px solid var(--c); border-radius: 14px 14px 3px 3px; text-align: center; align-items: center; }
    & .kv-item { border-left: 0; border-top: 3px solid var(--c); background: linear-gradient(180deg, color-mix(in srgb, var(--c) 16%, var(--slab)), var(--slab) 60%); }
    & .kv-item-top b { font-size: 19px; text-shadow: 0 0 10px color-mix(in srgb, var(--c) 40%, transparent); }
    & .kv-item[data-cursed="true"] em { color: var(--curse); }
    & .kv-button { font-size: 15px; }

    /* Absorb roll: a reliquary. An arched gilt window; the chosen power rests between two gilt bars. */
    & .kv-reel { border: 3px double var(--gilt); border-radius: 110px 110px 5px 5px; background: radial-gradient(ellipse at 50% 50%, color-mix(in srgb, var(--soul) 16%, var(--slab)), var(--slab) 75%); box-shadow: inset 0 0 26px #000; }
    & .kv-reel::after { border-color: var(--gilt); background: color-mix(in srgb, var(--gilt) 9%, transparent); }
    & .kv-reel-row b { font-size: 24px; text-shadow: 0 0 12px color-mix(in srgb, var(--c) 55%, transparent); }
    & .kv-roll-result { color: var(--ink); font-style: italic; }
    /* Codex: engraved section headings over lists of deeds, synergies and the bestiary. */
    & .sheet-body h3 { margin: 6px 0 0; font: 700 20px var(--display); color: var(--ink); text-align: center; letter-spacing: 0.06em; }
    & .kv-entry { background: var(--slab); border-radius: 3px; }
    & .kv-entry[data-done="true"] { border-color: var(--soul); }
    & .kv-entry[data-done="true"] b { color: var(--soul); }
    & .kv-entry-bar { background: var(--soul); }
    & .choice { border-radius: 14px 14px 3px 3px; border-left-width: 1px; border-top: 3px solid var(--soul); }
    & .kv-roll-take { font-size: 19px; padding: 11px; background: var(--gilt); border-color: var(--line); }
  `;

  /**
   * Stat as a headstone: the live value over its engraved label.
   * @param {{ label: string, value: HTMLElement, h: Function }} parts  see kit/ui.js `stat`
   * @returns {HTMLElement}
   */
  function buildHeadstoneStat({ label, value, h: makeElement }) {
    const stone = makeElement('div', 'stat sw-headstone');
    stone.append(value, makeElement('span', null, label));
    return stone;
  }

  /**
   * Bottom-bar button as a grave slab (the rune before its label is drawn by the theme's CSS).
   * @param {{ label: HTMLElement, sub: HTMLElement, h: Function }} parts  see kit/ui.js `actions`
   * @returns {HTMLButtonElement}
   */
  function buildSlabAction({ label, sub, h: makeElement }) {
    const slab = makeElement('button', 'action sw-slab');
    slab.append(label, sub);
    return slab;
  }

  /**
   * Builds the vitals strip: a row of lantern flames for health, with room beside it for the soul gauge.
   * @param {Object} ui                 the game's ctx.ui
   * @param {HTMLElement} gaugeElement  the element of the ui.progress that shows the absorb meter; it is moved into the strip
   * @returns {{ setHealth: (fraction: number) => void, flinch: () => void }} setHealth: 0..1 of max health;
   *          flinch: make the flames gutter (call when the hero is hit)
   */
  function buildVitals(ui, gaugeElement) {
    const strip = ui.el('div', 'sw-vitals');
    const flames = ui.h('div', 'sw-flames');
    const flameElements = Array.from({ length: FLAME_COUNT }, () => ui.h('i'));
    flames.append(...flameElements);
    strip.append(flames, gaugeElement);
    return {
      setHealth(fraction) {
        // Flame n is fully lit once health passes its share, and burns down smoothly inside it.
        flameElements.forEach((flame, index) => flame.style.setProperty('--lit', Kit.math.clamp(fraction * FLAME_COUNT - index).toFixed(2)));
      },
      flinch() {
        flames.classList.remove('is-hurt');
        void flames.offsetWidth; // restart the CSS animation
        flames.classList.add('is-hurt');
      },
    };
  }

  window.SOULWAKE_THEME = {
    TREE_ANCHOR,
    buildVitals,
    /** The `theme` for Kit.register. */
    theme: {
      skin: 'stone',
      fonts: ['Spectral:wght@400;600'],
      tokens: TOKENS,
      layout: { stats: 'top-right', actions: 'bottom' },
      css: CSS,
      components: { stat: buildHeadstoneStat, action: buildSlabAction },
    },
  };
})();
