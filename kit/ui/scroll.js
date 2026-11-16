/**
 * Kit ui scroll: the scrollable pane.
 *
 * Owns:  `Kit.ui.ScrollPane` (the component) and `Kit.ui.scrollable` (the same behaviour for an element you
 *        already have): native scrolling with momentum, overscroll kept inside the pane, optional scroll snap,
 *        fade edges that show there is more, keyboard scrolling, and safe-area padding at the screen's edge.
 * Does not own: what is inside the pane, or its height (give it one: `fill` inside a flex column, or a max-height).
 *
 * Why native: the browser's scroller is the only one that gets momentum, rubber-banding, accessibility and
 * 120 Hz for free. Nothing here listens to touch events; the one listener is a passive `scroll` that keeps the
 * fade edges honest. tools/touch-scroll.js proves a pane moves under a real finger drag.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, classes, css, useRef, useEffect } = Kit.ui;
  /** Scroll offsets within this many pixels of an end count as "at the end" (sub-pixel layouts never land on 0). */
  const EDGE_TOLERANCE_PX = 2;

  /**
   * @typedef {Object} ScrollOptions
   * @property {'y'|'x'} [axis='y'] the direction that scrolls
   * @property {false|'start'|'center'} [snap=false] snap children to the pane's start or centre when a scroll ends
   * @property {boolean} [fade=true] fade the edge(s) beyond which more content lies
   * @property {boolean} [safe=false] pad the far end by the phone's safe-area inset (for a pane that reaches the screen edge)
   * @property {string} [label] accessible name; a pane that has one is announced as a region
   */

  /** Measures a pane and records which ends have more content beyond them (CSS turns that into fades). */
  const markEdges = (element, axis) => {
    const [offset, extent, viewport] = axis === 'x' ? [element.scrollLeft, element.scrollWidth, element.clientWidth] : [element.scrollTop, element.scrollHeight, element.clientHeight];
    const canScroll = extent - viewport > EDGE_TOLERANCE_PX;
    element.toggleAttribute('data-more-before', canScroll && offset > EDGE_TOLERANCE_PX);
    element.toggleAttribute('data-more-after', canScroll && offset < extent - viewport - EDGE_TOLERANCE_PX);
    // Only a pane that actually overflows takes keyboard focus: arrows, Page Up / Down, Home, End and Space then scroll it.
    if (canScroll) element.tabIndex = 0;
    else element.removeAttribute('tabindex');
  };

  /**
   * Turns an element into a scroll pane: adds the class and attributes, keeps the fade edges current while it
   * scrolls, resizes or its content changes.
   * @param {HTMLElement} element
   * @param {ScrollOptions} [options]
   * @returns {function(): void} dispose: stops watching (the element keeps scrolling natively)
   * @complexity O(1) per scroll frame: one measurement, coalesced to at most one per animation frame
   * @example const stop = Kit.ui.scrollable(listElement, { snap: 'start', label: 'Recipes' });
   */
  const scrollable = (element, { axis = 'y', snap = false, fade = true, safe = false, label } = {}) => {
    element.classList.add('ui-scroll');
    element.dataset.axis = axis;
    if (snap) element.dataset.snap = snap;
    if (fade) element.dataset.fade = '';
    if (safe) element.dataset.safe = '';
    if (label) {
      element.setAttribute('role', 'region');
      element.setAttribute('aria-label', label);
    }
    let isQueued = false;
    const measure = () => {
      isQueued = false;
      markEdges(element, axis);
    };
    const queueMeasure = () => {
      if (isQueued) return;
      isQueued = true;
      requestAnimationFrame(measure);
    };
    element.addEventListener('scroll', queueMeasure, { passive: true });
    // Size changes of the pane, and children coming and going, both move the ends.
    const resizeWatcher = new ResizeObserver(queueMeasure);
    resizeWatcher.observe(element);
    const contentWatcher = new MutationObserver(queueMeasure);
    contentWatcher.observe(element, { childList: true, subtree: true });
    measure();
    return () => {
      element.removeEventListener('scroll', queueMeasure);
      resizeWatcher.disconnect();
      contentWatcher.disconnect();
    };
  };

  /**
   * A scrollable pane. Give it a height to scroll within: `fill` makes it take the rest of a flex column; otherwise
   * set a height or max-height from your own class.
   * @param {ScrollOptions & {fill?: boolean, id?: string, class?: string, children?: *}} props
   * @example
   * html`<${ScrollPane} fill label="Backpack">${items.map((item) => html`<${Card} title=${item.name} />`)}<//>`
   * html`<${ScrollPane} axis="x" snap="center">${pages}<//>`   // a swipeable row that settles on a page
   */
  const ScrollPane = ({ axis, snap, fade, safe, label, fill = false, id, class: className, children }) => {
    const pane = useRef(null);
    // Re-attach only when an option changes; the cleanup stops the watchers when the pane leaves the page.
    useEffect(() => scrollable(pane.current, { axis, snap, fade, safe, label }), [axis, snap, fade, safe, label]);
    return html`<div id=${id} class=${classes({ 'ui-fill': fill }, className)} ref=${pane}>${children}</div>`;
  };

  css(`
    .ui-scroll {
      overflow: hidden auto; min-height: 0; min-width: 0; pointer-events: auto;
      overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y;
      scrollbar-width: thin; scrollbar-color: var(--line) transparent; scroll-padding: var(--ui-gap);
      --ui-fade-before: 0px; --ui-fade-after: 0px;
    }
    .ui-scroll[data-axis="x"] { overflow: auto hidden; }
    .ui-scroll.ui-fill { flex: 1 1 0; }
    .ui-scroll[data-safe] { padding-bottom: env(safe-area-inset-bottom, 0px); }
    .ui-scroll[data-snap] { scroll-snap-type: y proximity; }
    .ui-scroll[data-snap][data-axis="x"] { scroll-snap-type: x mandatory; }
    .ui-scroll[data-snap="start"] > * { scroll-snap-align: start; }
    .ui-scroll[data-snap="center"] > * { scroll-snap-align: center; }
    .ui-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    /* Fade edges: the pane is masked so content dissolves toward an end that has more beyond it. */
    .ui-scroll[data-fade][data-more-before] { --ui-fade-before: var(--ui-fade); }
    .ui-scroll[data-fade][data-more-after] { --ui-fade-after: var(--ui-fade); }
    .ui-scroll[data-fade] {
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ui-fade-before), #000 calc(100% - var(--ui-fade-after)), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ui-fade-before), #000 calc(100% - var(--ui-fade-after)), transparent 100%);
    }
    .ui-scroll[data-fade][data-axis="x"] {
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--ui-fade-before), #000 calc(100% - var(--ui-fade-after)), transparent 100%);
      mask-image: linear-gradient(to right, transparent 0, #000 var(--ui-fade-before), #000 calc(100% - var(--ui-fade-after)), transparent 100%);
    }
  `);

  Object.assign(Kit.ui, { ScrollPane, scrollable });
})();
