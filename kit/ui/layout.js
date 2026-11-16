/**
 * Kit ui layout: arranging things, and saying there is nothing to arrange.
 *
 * Owns:  `Kit.ui.Stack` (a column that can become a row when its own container is wide enough; a container
 *        query, so it responds to the space it is given, not to the screen), `Kit.ui.Cluster` (a row that wraps),
 *        and `Kit.ui.Empty` (the empty state of a list, search or inventory).
 * Does not own: scrolling (scroll.js) or surfaces (collection.js).
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, classes, css } = Kit.ui;

  /**
   * Container widths at which a Stack turns into a row. Container queries cannot read custom properties, so the
   * breakpoints are a small named set.
   * @type {Record<string, string>}
   */
  const ROW_BREAKPOINTS = { narrow: '360px', medium: '520px', wide: '720px' };

  /**
   * A vertical stack with even gaps. With `rowAt` it lays its children in a row once its container is that wide.
   * @param {{rowAt?: 'narrow'|'medium'|'wide', align?: string, gap?: string, class?: string, children?: *}} props
   *   `align` is a CSS align-items value; `gap` is a CSS length (default: the --ui-gap token)
   * @example html`<${Stack} rowAt="medium"><${Stat} label="Depth" value=${depth} /><${Meter} label="Air" value=${air} /><//>`
   */
  const Stack = ({ rowAt, align, gap, class: className, children }) =>
    html`<div class="ui-flow" data-row-at=${rowAt}><div class=${classes('ui-stack', className)} style=${{ alignItems: align, gap }}>${children}</div></div>`;

  /**
   * A row that wraps onto more lines when it runs out of width: tags, filters, a row of buttons.
   * @param {{justify?: string, align?: string, gap?: string, class?: string, children?: *}} props
   * @example html`<${Cluster} justify="space-between"><${Button}>Back<//><${Button} variant="primary">Next<//><//>`
   */
  const Cluster = ({ justify, align = 'center', gap, class: className, children }) =>
    html`<div class=${classes('ui-cluster', className)} style=${{ justifyContent: justify, alignItems: align, gap }}>${children}</div>`;

  /**
   * What a list shows when it has nothing in it: what would be here, and the way to get the first one.
   * @param {{title: string, text?: string, children?: *}} props children are the action(s), usually one Button
   * @example html`<${Empty} title="No fish yet" text="Cast from the pier to catch your first."><${Button} onClick=${goFish}>Go fishing<//><//>`
   */
  const Empty = ({ title, text, children }) =>
    html`<div class="ui-empty" role="status">
      <b>${title}</b>
      ${text ? html`<p>${text}</p>` : null}
      ${children}
    </div>`;

  css(`
    .ui-flow { container-type: inline-size; min-width: 0; }
    .ui-stack { display: flex; flex-direction: column; gap: var(--ui-gap); min-width: 0; }
    .ui-stack > * { min-width: 0; }
    ${Object.entries(ROW_BREAKPOINTS)
      .map(([name, width]) => `@container (min-width: ${width}) { .ui-flow[data-row-at="${name}"] > .ui-stack { flex-direction: row; } .ui-flow[data-row-at="${name}"] > .ui-stack > * { flex: 1 1 0; } }`)
      .join('\n    ')}
    .ui-cluster { display: flex; flex-wrap: wrap; gap: var(--ui-gap); min-width: 0; }
    .ui-empty {
      display: flex; flex-direction: column; align-items: center; gap: var(--ui-gap); padding: 24px var(--ui-pad); text-align: center;
      border: var(--border) dashed var(--line); border-radius: var(--radius-lg); color: var(--dim);
    }
    .ui-empty b { font: 700 17px var(--display); color: var(--ink); }
    .ui-empty p { margin: 0; max-width: 34ch; }
  `);

  Object.assign(Kit.ui, { Stack, Cluster, Empty, ROW_BREAKPOINTS });
})();
