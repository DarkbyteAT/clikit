/**
 * Kit ui menu: the main menu's list of games, built from the component library (its first real consumer).
 *
 * Owns:  what is inside `#menu-body`: a search field, the scroll pane of game cards (`#menu-list`, the element
 *        tools/touch-scroll.js drags), the empty state of a search with no match, and the footer's "Components"
 *        link to the gallery.
 * Does not own: the menu's frame, title and footer (index.html), launching games (kit/shell.js, through
 *        `Kit.play`) or the mute button (kit/shell.js).
 *
 * Loaded after kit/shell.js. The shell has already filled `#cards` with plain buttons; this file replaces them,
 * keeping each card's id (`card-<game id>`), which the smoke and play tools press. If the component library did
 * not load, this file does nothing and the shell's cards stay, inside a plain native scroller.
 */
(() => {
  if (!Kit.ui.html) return;
  const { html, signal, mount, ScrollPane, TextField, Card, Empty, Button } = Kit.ui;
  const { searchRows } = Kit.uiLogic;
  /** Accent of a card whose game gives no colour. */
  const DEFAULT_CARD_COLOR = '#6ea8ff';
  /** The game fields a search looks in. */
  const SEARCH_FIELDS = ['name', 'tagline', 'hook'];
  const HEX_DIGITS = 6;

  /** A game's accent as a CSS colour: definitions give either a CSS string or a 0xRRGGBB number. */
  const cssColorOf = (color) => (typeof color === 'number' ? '#' + color.toString(16).padStart(HEX_DIGITS, '0') : color || DEFAULT_CARD_COLOR);

  /** Games shown on the menu, in menu order (the shell sorted them); `hidden` ones are reached another way. */
  const listedGames = Kit.games.filter((game) => !game.hidden).map((game, index) => ({ ...game, number: index + 1 }));
  const query = signal('');

  const gameCard = (game) =>
    html`<${Card} key=${game.id} id=${'card-' + game.id} mark=${game.number} title=${game.name} text=${game.tagline} tag=${game.hook} color=${cssColorOf(game.color)} onClick=${() => Kit.play(game.id)} />`;

  /** The search field and the list. Reads `query`, so typing re-renders the list and nothing else on the page. */
  const Menu = () => {
    const matches = searchRows(listedGames, query.value, SEARCH_FIELDS);
    return html`
      <${TextField} id="menu-search" type="search" label="Find a game" hideLabel placeholder=${`Search ${listedGames.length} games`} value=${query} />
      <${ScrollPane} fill id="menu-list" label="Games">
        ${matches.length
          ? html`<div id="cards">${matches.map(gameCard)}</div>`
          : html`<${Empty} title="No game matches" text=${`Nothing is called "${query.value}". Try part of a name or a word from a tagline.`}>
              <${Button} onClick=${() => (query.value = '')}>Show all games<//>
            <//>`}
      <//>
    `;
  };

  const body = document.getElementById('menu-body');
  if (!body || !listedGames.length) return;
  body.textContent = '';
  mount(html`<${Menu} />`, body);

  const galleryLink = document.getElementById('open-gallery');
  if (galleryLink) {
    galleryLink.addEventListener('click', () => {
      Kit.sfx.play('click');
      Kit.play('gallery');
    });
  }
})();
