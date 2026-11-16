/**
 * Kit creator icons: a small set of line icons as data, and the component that draws one. Group, action and
 * part icons in the catalogue are names; this table is what turns a name into a drawing, so a name the table
 * does not know still shows something (a dot) instead of nothing.
 *
 * Owns:  `Kit.creator.ICONS` (name -> SVG path data in a 24 x 24 box) and `Kit.creator.Icon`.
 * Does not own: the names (the catalogue's `icon` fields and the creator's own buttons) or any layout.
 *
 * Every icon is an original, simple stroke drawing. Needs the DOM (kit/ui/), so it is exercised in the browser.
 */
(() => {
  if (!Kit.ui || !Kit.ui.html) return;
  const { html, css } = Kit.ui;

  /** The size of the drawing box the paths are written in. */
  const BOX = 24;
  /** Stroke width in the 24-unit box. */
  const STROKE = 1.8;

  /**
   * Icon name -> path data (several subpaths in one string). Strokes only, drawn with round ends.
   * @type {Object<string, string>}
   */
  const ICONS = {
    // The catalogue's group and control icons.
    head: 'M12 3a6.5 6.5 0 0 0-6.5 6.5V12a6.5 6.5 0 0 0 13 0V9.5A6.5 6.5 0 0 0 12 3z M9.5 21h5',
    face: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9 10h.01 M15 10h.01 M8.5 14.5a4.5 3.5 0 0 0 7 0',
    figure: 'M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M12 8v7 M6 10l6-2 6 2 M12 15l-4 6 M12 15l4 6',
    arm: 'M4 19l6-9 4 3 6-7 M4 19h3',
    leg: 'M10 3v9l-3 9h4 M14 3v9l3 9h-4',
    scissors: 'M6 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M8 9l12 8 M8 15L20 7',
    shirt: 'M8 3L3 7l3 3 2-1v12h8V9l2 1 3-3-5-4a4 4 0 0 1-8 0z',
    gem: 'M6 4h12l3 5-9 12L3 9z M3 9h18 M9 4l-1 5 4 12 4-12-1-5',
    horn: 'M5 20C5 11 8 6 14 3c0 6-2 11-6 14 M16 20c3-5 4-9 3-14',
    palette: 'M12 3a9 9 0 0 0 0 18c1.5 0 2-1 1.5-2.2-.5-1.3.2-2.3 1.5-2.3H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z M7.5 11h.01 M10 7h.01 M14.5 7.5h.01',
    swatch: 'M4 4h7v16H4z M11 9l5-5 4 4-9 12 M7.5 17h.01',
    hat: 'M3 17h18 M6 17c0-6 2-10 6-10s6 4 6 10',
    ruler: 'M3 16L16 3l5 5L8 21z M7 12l2 2 M10 9l2 2 M13 6l2 2',
    // The creator's own buttons.
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
    undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8.5 8.5h.01 M15.5 8.5h.01 M12 12h.01 M8.5 15.5h.01 M15.5 15.5h.01',
    mirror: 'M12 3v18 M8 7L3 17h5z M16 7l5 10h-5z',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    save: 'M5 3h11l3 3v15H5z M8 3v6h7V3 M8 21v-7h8v7',
    share: 'M12 15V3 M8 7l4-4 4 4 M5 12v8h14v-8',
    sliders: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 4v6 M9 14v6',
    lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    unlock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2',
    link: 'M9 12h6 M8 8H7a4 4 0 0 0 0 8h1 M16 8h1a4 4 0 0 1 0 8h-1',
    unlink: 'M8 8H7a4 4 0 0 0 0 8h1 M16 8h1a4 4 0 0 1 0 8h-1 M10 12h.01 M14 12h.01',
    reset: 'M4 12a8 8 0 1 0 2.5-5.8 M4 4v5h5',
    plus: 'M12 5v14 M5 12h14',
    minus: 'M5 12h14',
    walk: 'M13 2.5a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z M12 8l-2 5 3 3-1 6 M12 8l4 3 3 1 M10 13l-4 2',
    close: 'M6 6l12 12 M18 6L6 18',
    copy: 'M8 8h11v13H8z M5 16V3h11',
    none: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M6.5 6.5l11 11',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    dot: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  };

  /**
   * A line icon that takes its colour from the text around it.
   * @param {{name: ?string, size?: number}} props `name` a key of `ICONS` (an unknown or missing name draws a dot); `size` in CSS pixels (default 22)
   * @returns {Object} a vnode
   * @example html`<${Icon} name="dice" />`
   */
  const Icon = ({ name, size = 22 }) =>
    html`<svg class="cr-icon" width=${size} height=${size} viewBox=${`0 0 ${BOX} ${BOX}`} fill="none" stroke="currentColor" stroke-width=${STROKE} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d=${ICONS[name] || ICONS.dot} /></svg>`;

  css('.cr-icon { flex: none; display: block; }');

  Kit.creator = Object.assign(Kit.creator || {}, { ICONS, Icon });
})();
