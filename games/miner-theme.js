/**
 * Core Miner theme: a HUD made of what a mine has lying around. Exposed as the global CORE_MINER_THEME.
 *
 * Owns: the game's `theme` for kit/theme.js (fonts, tokens, scoped CSS, component builders) and the class names of the
 *       parts those builders add, which games/miner.js keeps up to date.
 * Does not own: any rule or number of the game (games/miner-rules.js), the scene (games/miner.js) or the HUD primitives
 *       it restyles (kit/ui.js, kit/views.js).
 */
(() => {
  /** Class names of the parts the theme's components add and the game keeps up to date (shared by the CSS, the builders and the game). */
  const PLAQUE_NAME_CLASS = 'plaque-name';
  const PLAQUE_WHERE_CLASS = 'plaque-where';
  const PLAQUE_HEAT_CLASS = 'plaque-heat';
  const CARD_EFFECT_CLASS = 'crate-effect';
  const CARD_STRIP_CLASS = 'crate-strip';

  /**
   * The game's theme (kit/theme.js). Starts from the stone skin and replaces most of it: stats are riveted timber signs, the
   * ore's name and HP hang from chains as a plaque, upgrades are crates with an effect line, a coin price and a strip that
   * fills as the player saves up, and the goals are chalked on a slate in the bottom-right, over dark foreground rock.
   * The Camp sheet (forge, shard tree, collapse, ledger) is made of the same timber rows.
   */
  const THEME = {
    skin: 'stone',
    fonts: ['Alfa Slab One', 'Bitter:wght@500;700', 'Caveat Brush'],
    tokens: {
      '--display': '"Alfa Slab One", Rockwell, "Roboto Slab", Georgia, serif',
      '--body': '"Bitter", Georgia, serif',
      '--ink': '#f6e7c8',
      '--dim': '#d0ad7c',
      // Timber: a top-lit plank with faint vertical grain.
      '--panel': 'repeating-linear-gradient(91deg, rgba(0, 0, 0, 0.09) 0 2px, transparent 2px 11px), linear-gradient(180deg, #7d5330 0%, #54341a 100%)',
      '--line': '#23150b',
      '--accent': '#ffc145',
      '--accent-ink': '#2a1a05',
      '--accent-edge': '#9a6a12',
      '--radius': '3px',
      '--radius-lg': '5px',
      '--border': '2px',
      '--shadow': 'inset 0 1px 0 rgba(255, 220, 170, 0.28), inset 0 -3px 0 rgba(0, 0, 0, 0.35), 0 3px 0 #1a0f07, 0 5px 10px rgba(0, 0, 0, 0.45)',
      '--blur': '0px',
      '--stat-size': '19px',
      '--label-spacing': '0.12em',
      '--floater': '#ffd76a',
      // The game's own tokens.
      '--chalk': '"Caveat Brush", "Segoe Print", "Comic Sans MS", cursive',
      '--chalk-ink': '#eef1ee',
      '--slate': '#262b2e',
      '--rivet': 'radial-gradient(circle, #d7dae2 0 1.4px, #4a4c55 1.5px 2.7px, transparent 2.9px)',
      '--coin': 'radial-gradient(circle at 35% 30%, #fff3b8 0 18%, #ffc145 42%, #b9780f 100%)',
    },
    layout: { stats: 'top-right', actions: 'bottom' },
    css: `
      /* Alfa Slab One has one weight; asking for bold would smear it. */
      & .stat b, & .action b, & .chip, & .toast, & .floater, & .hint { font-weight: 400; }
      & .floater { text-shadow: 0 2px 0 #2a1707, 0 4px 8px rgba(0, 0, 0, .5); }
      & .toast { color: #ffd76a; text-shadow: 0 2px 0 #3a2208, 0 6px 12px rgba(0, 0, 0, .6); }
      /* Raised above the slate and the Camp tag, which share the strip over the crates. */
      & .hint { bottom: 22%; border-radius: 4px; font-family: var(--display); letter-spacing: .04em; }

      /* Stats: timber signs held by a rivet at each end, the value carved in. */
      & .sign { position: relative; padding: 4px 15px 5px; align-items: center; }
      & .sign::before, & .sign::after { content: ''; position: absolute; top: 50%; width: 7px; height: 7px; margin-top: -4px; background: var(--rivet); }
      & .sign::before { left: 3px; }
      & .sign::after { right: 3px; }
      & .sign b { text-shadow: 0 -1px 0 rgba(0, 0, 0, .65), 0 1px 0 rgba(255, 225, 180, .22); letter-spacing: .02em; }
      & .sign[data-sign="coins"] b { color: var(--accent); }
      & .sign[data-sign="coins"] b::before { content: ''; display: inline-block; width: 11px; height: 11px; margin-right: 5px; border-radius: 50%; background: var(--coin); box-shadow: inset 0 0 0 1.5px #8a5a0a; }

      /* Ore plaque: hangs on two chains under the top row, name over an HP bar over the numbers. */
      & .plaque { width: min(240px, 66%); height: auto; overflow: visible; margin-top: 12px; padding: 4px 12px 5px; display: flex; flex-direction: column; gap: 3px; border-radius: 4px; box-shadow: var(--shadow); }
      & .plaque::before, & .plaque::after { content: ''; position: absolute; bottom: 100%; width: 4px; height: 22px; background: repeating-linear-gradient(180deg, #a9acb6 0 3px, #3c3d45 3px 5px); border-radius: 1px; }
      & .plaque::before { left: 20px; }
      & .plaque::after { right: 20px; }
      /* In landscape the shaft is short and the ore sits right under the top row: hang the plaque to the left of it instead. */
      @media (orientation: landscape) { & .plaque { align-self: flex-start; width: 220px; } }
      & .${PLAQUE_NAME_CLASS} { font: 400 17px/1.15 var(--display); letter-spacing: .05em; text-align: center; text-shadow: 0 -1px 0 rgba(0, 0, 0, .65), 0 1px 0 rgba(255, 225, 180, .22); }
      & .plaque-track { position: relative; height: 10px; border-radius: 2px; background: #1b110a; box-shadow: inset 0 2px 3px #000, 0 1px 0 rgba(255, 225, 180, .18); overflow: hidden; }
      & .plaque-track i { box-shadow: inset 0 3px 0 rgba(255, 255, 255, .32), inset 0 -3px 0 rgba(0, 0, 0, .28); }
      & .plaque span { position: static; display: block; text-align: center; font: 700 11px var(--body); letter-spacing: .06em; color: var(--dim); text-transform: none; font-variant-numeric: tabular-nums; }

      /* Where the player is digging (shaft and biome), above the ore's name. */
      & .${PLAQUE_WHERE_CLASS} { font: 500 10px var(--body); font-style: normal; letter-spacing: .08em; text-transform: uppercase; text-align: center; color: var(--dim); }
      /* Heat gauge under the HP bar: amber as it builds, red when the next taps will overheat, flashing grey while the pick vents. */
      & .${PLAQUE_HEAT_CLASS} { height: 4px; border-radius: 2px; background: #1b110a; overflow: hidden; }
      & .${PLAQUE_HEAT_CLASS} i { position: static; display: block; width: 0; height: 100%; background: linear-gradient(90deg, #ffc145, #ff8f3a); transition: width .1s linear; box-shadow: none; }
      & .${PLAQUE_HEAT_CLASS}[data-state="danger"] i { background: #ff4f2e; }
      & .${PLAQUE_HEAT_CLASS}[data-state="vent"] i { background: #9fb4c8; animation: miner-vent .3s steps(2) infinite; }
      @keyframes miner-vent { 50% { opacity: .3; } }

      /* Upgrade crates: name, what the next level adds, price with a coin, and a strip that fills as the wallet nears the price. */
      & .crate { position: relative; overflow: hidden; align-items: flex-start; gap: 1px; padding: 6px 7px 11px; text-align: left; }
      & .crate b { font-size: 15px; letter-spacing: .04em; color: var(--crate-color, var(--ink)); text-shadow: 0 -1px 0 rgba(0, 0, 0, .6); white-space: nowrap; }
      & .${CARD_EFFECT_CLASS} { font: 500 11px var(--body); font-style: normal; color: var(--ink); white-space: nowrap; }
      & .crate-price { display: flex; align-items: center; gap: 5px; }
      & .crate-price span { font: 700 14px var(--body); color: var(--accent); }
      & .crate-price i { flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--coin); box-shadow: inset 0 0 0 1.5px #8a5a0a, 0 1px 0 rgba(0, 0, 0, .5); }
      & .${CARD_STRIP_CLASS} { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: rgba(0, 0, 0, .5); }
      & .${CARD_STRIP_CLASS} i { display: block; width: 0; height: 100%; background: linear-gradient(90deg, #a86c0c, #ffc145); transition: width .2s ease-out; }
      /* Cannot afford yet: darker timber, still fully readable (the kit default fades the whole button). */
      & .crate:disabled { opacity: 1; filter: none; background: linear-gradient(180deg, #4b3421 0%, #302015 100%); }
      & .crate:disabled .crate-price span { color: var(--dim); }
      /* Affordable: lit like a lantern and nudging upward, so the eye finds it without reading a number. */
      & .crate:not(:disabled) { border-color: var(--accent); box-shadow: var(--shadow), 0 0 14px rgba(255, 193, 69, .55); animation: miner-crate-ready 1.1s ease-in-out infinite; }
      & .crate:not(:disabled):active { animation: none; transform: translateY(2px); }
      & .crate[data-state="maxed"] .crate-price i, & .crate[data-state="maxed"] .${CARD_STRIP_CLASS} { display: none; }
      @keyframes miner-crate-ready { 50% { transform: translateY(-3px); } }
      @media (prefers-reduced-motion: reduce) { & .crate:not(:disabled) { animation: none; } }

      /* Goals: chalk on a framed slate, bottom-right of the play area where only dark foreground rock is behind it. */
      & .checklist { position: absolute; right: 0; bottom: 12px; align-self: auto; gap: 0; padding: 4px 10px 6px; background: var(--slate); border: 3px solid #6f4a2a; border-radius: 3px; box-shadow: inset 0 0 12px rgba(0, 0, 0, .65), 0 3px 8px rgba(0, 0, 0, .5); font: 400 15px/1.25 var(--chalk); color: var(--chalk-ink); transform: rotate(1.2deg); }
      & .checklist::before { content: 'This shift'; margin-bottom: 2px; border-bottom: 1px dashed rgba(238, 241, 238, .4); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; opacity: .65; }
      & .checklist i { border: 1.5px solid rgba(238, 241, 238, .75); border-radius: 2px; color: #ffd76a; font-size: 11px; }
      & .checklist .done span { color: rgba(238, 241, 238, .5); }

      /* Camp: a timber tag bottom-left that opens the sheet; a lit dot means something there can be bought or forged. */
      & .camp { position: absolute; left: 0; bottom: 12px; pointer-events: auto; padding: 7px 14px 8px; font: 400 15px var(--display); letter-spacing: .05em; color: var(--ink); background: var(--panel); border: 2px solid var(--line); border-radius: 4px; box-shadow: var(--shadow); }
      & .camp[data-alert="true"]::after { content: ''; position: absolute; top: -5px; right: -5px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
      & .sheet h2 { font-weight: 400; letter-spacing: .04em; }
      & .sheet h3 { margin: 10px 0 0; font: 400 17px var(--display); letter-spacing: .05em; color: var(--accent); }
      & .camp-note { margin: 0; font-size: 13px; color: var(--dim); }
      & .camp-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; background: var(--panel); border: 2px solid var(--line); border-radius: 4px; box-shadow: var(--shadow); }
      & .camp-row[data-state="worn"], & .camp-row[data-state="done"] { border-color: var(--accent); }
      & .camp-row div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      & .camp-row b { font: 400 15px var(--display); letter-spacing: .03em; }
      & .camp-row[data-state="done"] b { color: var(--accent); }
      & .camp-row span { font-size: 12px; color: var(--dim); }
      & .camp-row button { flex: none; padding: 7px 12px; border-radius: 4px; background: var(--accent); color: var(--accent-ink); font: 400 14px var(--display); border-bottom: 3px solid var(--accent-edge); }
      & .camp-row button:disabled { background: #4b3421; color: var(--dim); border-bottom-color: #23150b; }
      & .camp-chunks { display: flex; flex-wrap: wrap; gap: 4px 12px; font: 700 12px var(--body); }
      & .camp-chunks i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 2px; transform: rotate(45deg); background: var(--chunk); }
    `,
    components: {
      /** A stat as a riveted sign; `data-sign` lets the CSS give one stat (coins) its own glyph. */
      stat: ({ label, value, h }) => {
        const sign = h('div', 'stat sign');
        sign.dataset.sign = label.toLowerCase();
        sign.append(h('span', null, label), value);
        return sign;
      },
      /**
       * The HP bar as a hanging plaque: where the player is digging and the ore's name (both filled by the game), the fill
       * inside an inset track, a heat gauge the game drives, and the kit's label below.
       */
      progress: ({ fill, label, h }) => {
        const plaque = h('div', 'progress plaque');
        const track = h('div', 'plaque-track');
        track.append(fill);
        const heat = h('div', PLAQUE_HEAT_CLASS);
        heat.append(h('i'));
        plaque.append(h('em', PLAQUE_WHERE_CLASS), h('b', PLAQUE_NAME_CLASS), track, heat, label);
        return plaque;
      },
      /** A shop button as a crate: the kit's label and price plus an effect line and a savings strip the game keeps up to date. */
      action: ({ label, sub, h }) => {
        const crate = h('button', 'action crate');
        const price = h('div', 'crate-price');
        price.append(h('i'), sub);
        const strip = h('div', CARD_STRIP_CLASS);
        strip.append(h('i'));
        crate.append(label, h('em', CARD_EFFECT_CLASS), price, strip);
        return crate;
      },
    },
  };

  window.CORE_MINER_THEME = {
    THEME,
    /** Class names of the themed parts the game fills in; each lookup is guarded, because another skin may be previewed. */
    PARTS: { plaqueName: PLAQUE_NAME_CLASS, plaqueWhere: PLAQUE_WHERE_CLASS, plaqueHeat: PLAQUE_HEAT_CLASS, cardEffect: CARD_EFFECT_CLASS, cardStrip: CARD_STRIP_CLASS },
  };
})();
