/**
 * Kit ui gallery: every component of kit/ui/ in every state, on one screen, under any skin.
 *
 * Owns:  the `gallery` screen (`Kit.play('gallery')`, or "Components" in the menu footer): a skin switcher and
 *        one section per component file, with live values so bindings can be watched and a readout that shows a
 *        pane really moved under a finger (useful on a real phone, where the automated touch test cannot go).
 * Does not own: the components (the files beside this one). A new component is added here in the same change.
 *
 * It is registered as a hidden game, so the shell gives it a HUD, a back button and clean-up, and
 * `bun tools/smoke.js gallery` plays it like any other.
 */
(() => {
  if (!Kit.ui.html) return;
  const ui = Kit.ui;
  const { html, signal, computed, css } = ui;
  const { ScrollPane, Button, Stack, Cluster, Empty, Meter, Progress, Stat, Pips, Tabs, Card, List, Grid, TextField, Toggle, Slider, Dialog, Sheet, Popover, Tooltip } = ui;

  const BACKDROP_COLOR = 0x1b2440;
  const DEMO_ROW_COUNT = 14;
  const DEMO_PAGE_COUNT = 5;
  /** How fast the demo values swing, radians per game second. */
  const SWING_RATE = 1.3;
  const DEMO_LIVES = 5;
  const BUSY_DEMO_MS = 1500;

  const ORES = [
    { id: 'copper', name: 'Copper', note: 'Soft, common' },
    { id: 'silver', name: 'Silver', note: 'Conducts sparks' },
    { id: 'obsidian', name: 'Obsidian', note: 'Needs a steel pick', locked: true },
    { id: 'starglass', name: 'Starglass', note: 'Falls at night' },
  ];
  const SEEDS = ['Fern', 'Moss', 'Reed', 'Lily', 'Sage', 'Thyme'].map((name) => ({ id: name.toLowerCase(), name }));

  /** One titled block of the gallery. */
  const Section = ({ title, note, children }) =>
    html`<section class="gallery-section">
      <h3>${title}</h3>
      ${note ? html`<p class="gallery-note">${note}</p>` : null}
      ${children}
    </section>`;

  /** A captioned example inside a section. */
  const Demo = ({ caption, children }) => html`<div class="gallery-demo"><span class="ui-label">${caption}</span>${children}</div>`;

  /**
   * Builds the gallery view and the signals behind it.
   * @param {Object} ctx the shell context
   * @returns {{view: *, level: Object, lives: Object, isAnimated: Object}} the template plus the live values the frame loop drives
   */
  const createGallery = (ctx) => {
    const skin = signal('glass');
    const level = signal(0.4);
    const lives = signal(3);
    const coins = signal(1250);
    const isAnimated = signal(true);
    const isMuted = signal(false);
    const isBusy = signal(false);
    const isDialogOpen = signal(false);
    const isSheetOpen = signal(false);
    const isRequiredOpen = signal(false);
    const lastAnswer = signal('nothing yet');
    const playerName = signal('Wren');
    const nameError = computed(() => (playerName.value.trim() ? '' : 'A name is needed to join a table.'));
    const volume = signal(0.6);
    const chosenOre = signal('copper');
    const chosenSeeds = signal(['fern', 'reed']);
    const scrolledBy = signal(0);
    let toastCount = 0;

    const wear = (name) => {
      skin.value = name;
      Kit.theme.apply('gallery', { skin: name });
    };
    const demoBusy = () => {
      isBusy.value = true;
      setTimeout(() => (isBusy.value = false), BUSY_DEMO_MS);
    };
    const answerButtons = (close) => html`<${Button} onClick=${() => close('later')}>Later<//><${Button} variant="primary" onClick=${() => close('sell')}>Sell<//>`;
    const rows = Array.from({ length: DEMO_ROW_COUNT }, (_, index) => html`<${Card} key=${index} mark=${index + 1} title=${`Row ${index + 1}`} text="Drag, wheel, or focus the pane and use the arrow keys" />`);
    const pages = Array.from({ length: DEMO_PAGE_COUNT }, (_, index) => html`<${Card} key=${index} class="gallery-page" title=${`Page ${index + 1} of ${DEMO_PAGE_COUNT}`} text="Swipe sideways; it settles on a page" />`);

    const view = html`<div class="gallery">
      <${ScrollPane} fill id="gallery-scroll" label="Component gallery" safe>
        <div class="gallery-inner">
          <header class="gallery-head">
            <h2>clikit components</h2>
            <p>Every component of kit/ui in every state. Pick a skin to see the same markup under each theme.</p>
            <${Cluster} class="gallery-skins">
              ${Object.keys(Kit.theme.SKINS).map((name) => html`<${Button} key=${name} id=${'skin-' + name} pressed=${computed(() => skin.value === name)} onClick=${() => wear(name)}>${name}<//>`)}
            <//>
          </header>

          <${Section} title="Scroll pane" note="Native scrolling: momentum, overscroll kept inside, fade edges where more lies beyond, arrow keys when focused.">
            <${Demo} caption=${computed(() => `Vertical with snap. Scrolled ${scrolledBy.value}px`)}>
              <div onScrollCapture=${(event) => (scrolledBy.value = Math.round(event.target.scrollTop))}>
                <${ScrollPane} id="gallery-pane" class="gallery-pane" snap="start" label="Demo rows"><${Stack}>${rows}<//><//>
              </div>
            <//>
            <${Demo} caption="Horizontal, snapping to the centre">
              <${ScrollPane} id="gallery-pages" axis="x" snap="center" label="Demo pages"><div class="gallery-pages">${pages}</div><//>
            <//>
          <//>

          <${Section} title="Buttons" note="Variants, and the states a button can be in.">
            <${Cluster}>
              <${Button}>Default<//>
              <${Button} variant="primary">Primary<//>
              <${Button} variant="quiet">Quiet<//>
              <${Button} variant="danger">Danger<//>
              <${Button} sub="120 coins">With a sub line<//>
            <//>
            <${Cluster}>
              <${Button} id="gallery-toggle" pressed=${isMuted} onClick=${() => (isMuted.value = !isMuted.value)}>${computed(() => (isMuted.value ? 'Pressed' : 'Not pressed'))}<//>
              <${Button} disabled>Disabled<//>
              <${Button} variant="primary" disabled>Disabled primary<//>
              <${Button} id="gallery-busy" variant="primary" busy=${isBusy} onClick=${demoBusy}>Press to be busy<//>
              <${Button} busy>Busy<//>
            <//>
          <//>

          <${Section} title="Meter, progress, stat, pips" note="Bound to signals: each frame writes only the value that changed.">
            <${Toggle} id="gallery-animate" label="Animate the values" checked=${isAnimated} />
            <${Stack} rowAt="medium">
              <${Meter} label="Heat" value=${level} tone="warn" />
              <${Meter} label="Hull" value=${computed(() => 1 - level.value)} tone="bad" />
              <${Meter} label="Charge" value=${0.85} tone="good" />
            <//>
            <${Stack} rowAt="medium">
              <${Progress} label="Level 2" value=${level} />
              <${Progress} label="Joining table" />
            <//>
            <${Cluster}>
              <${Stat} label="Coins" value=${coins} />
              <${Stat} label="Depth" value="42 m" />
              <${Pips} label="Lives" filled=${lives} total=${DEMO_LIVES} />
            <//>
          <//>

          <${Section} title="Dialog and sheet" note="Native dialog: focus stays inside, Escape closes, focus returns to the button that opened it.">
            <${Cluster}>
              <${Button} id="open-dialog" onClick=${() => (isDialogOpen.value = true)}>Open dialog<//>
              <${Button} id="open-sheet" onClick=${() => (isSheetOpen.value = true)}>Open sheet<//>
              <${Button} id="open-required" onClick=${() => (isRequiredOpen.value = true)}>Dialog that needs an answer<//>
            <//>
            <p class="gallery-note" id="gallery-answer">Last answer: ${lastAnswer}</p>
            <${Dialog} open=${isDialogOpen} title="Sell all fish?" onClose=${(value) => (lastAnswer.value = value || 'dismissed')} actions=${answerButtons}>
              <p>You keep the rare ones. This frees 12 slots in the cooler.</p>
            <//>
            <${Sheet} open=${isSheetOpen} title="Backpack" onClose=${() => (lastAnswer.value = 'sheet closed')}>
              <${TextField} label="Label this bag" value=${playerName} />
              <${Stack}>${rows}<//>
            <//>
            <${Dialog} open=${isRequiredOpen} title="Pick a shaft" dismissable=${false} onClose=${(value) => (lastAnswer.value = value)} actions=${(close) => html`<${Button} onClick=${() => close('left')}>Left<//><${Button} onClick=${() => close('right')}>Right<//>`}>
              <p>Escape and the backdrop do nothing here: the run cannot go on without a choice.</p>
            <//>
          <//>

          <${Section} title="Tabs" note="Arrow keys move between tabs; a disabled tab is skipped.">
            <${Tabs}
              label="Demo tabs"
              tabs=${[
                { id: 'bag', label: 'Bag', content: html`<${Empty} title="The bag is empty" text="Break ore to fill it."><${Button}>Go mining<//><//>` },
                { id: 'gear', label: 'Gear', content: html`<${Cluster}><${Stat} label="Pick" value="Bronze" /><${Stat} label="Lamp" value="Tallow" /><//>` },
                { id: 'relics', label: 'Relics', content: html`<p class="gallery-note">Relics change a rule for the rest of the run.</p>` },
                { id: 'locked', label: 'Locked', disabled: true, content: null },
              ]}
            />
          <//>

          <${Section} title="List, grid and cards" note="Selection with touch, mouse or keyboard (arrows, then Enter or Space).">
            <${Stack} rowAt="medium">
              <${Demo} caption=${computed(() => `List, one choice: ${chosenOre.value}`)}>
                <${List} label="Ore" items=${ORES} selected=${chosenOre} isDisabled=${(ore) => Boolean(ore.locked)} render=${(ore) => html`<span><b>${ore.name}</b><br /><small>${ore.note}</small></span>`} />
              <//>
              <${Demo} caption=${computed(() => `Grid, several: ${chosenSeeds.value.join(', ') || 'none'}`)}>
                <${Grid} label="Seeds" multiple items=${SEEDS} selected=${chosenSeeds} minWidth="84px" />
              <//>
            <//>
            <${Stack} rowAt="medium">
              <${Card} mark="7" title="Pressable card" text="A real button: it has a pressed state and a focus ring" tag="Tag line" onClick=${() => ui.notify('Card pressed')} />
              <${Card} title="Plain card" text="An article: nothing to press" color="#4de2c5" tag="With its own colour" />
              <${Card} mark="x" title="Disabled card" text="Cannot be pressed" disabled onClick=${() => {}} />
            <//>
          <//>

          <${Section} title="Toasts and banners" note="Toasts queue three at a time and leave by themselves; banners show one at a time until dismissed.">
            <${Cluster}>
              <${Button} id="gallery-toast" onClick=${() => ui.notify(`Saved slot ${++toastCount}`)}>Toast<//>
              <${Button} onClick=${() => ['good', 'warn', 'bad', undefined, 'good'].forEach((tone, index) => ui.notify(`Burst ${index + 1} of 5`, { tone }))}>Burst of five<//>
              <${Button} id="gallery-banner" onClick=${() => ui.announce({ title: 'Table closed', text: 'The host left the table.', tone: 'warn', action: { label: 'Rejoin', onClick: () => ui.notify('Rejoining', { tone: 'good' }) } })}>Banner<//>
            <//>
          <//>

          <${Section} title="Popover and tooltip">
            <${Cluster}>
              <${Popover} label="Drop rates"><p>Common 70%, rare 25%, epic 5%. Luck shifts five points toward rare.</p><//>
              <${Tooltip} text="Doubles ore for 10 seconds"><${Button}>Hover or focus me<//><//>
              <${Tooltip} text="Plain text can carry a tip too" focusable><span class="gallery-note">What is luck?</span><//>
            <//>
          <//>

          <${Section} title="Text field, toggle, slider">
            <${Stack} rowAt="medium">
              <${TextField} id="gallery-name" label="Player name" value=${playerName} error=${nameError} hint="Shown to the table" maxLength=${16} />
              <${TextField} label="Search" type="search" placeholder="Search recipes" />
            <//>
            <${Cluster}>
              <${Toggle} label="Screen shake" checked=${true} />
              <${Toggle} label="Off" />
              <${Toggle} label="Disabled" disabled />
            <//>
            <${Stack} rowAt="medium">
              <${Slider} id="gallery-volume" label="Music" value=${volume} />
              <${Slider} label="Bet" value=${3} min=${1} max=${10} step=${1} format=${(amount) => `${amount} coins`} />
              <${Slider} label="Disabled" value=${0.3} disabled />
            <//>
          <//>

          <${Section} title="Layout and empty state" note="A stack becomes a row when its own container is wide enough (a container query); a cluster wraps.">
            <${Stack} rowAt="narrow"><${Stat} label="rowAt narrow" value="360px" /><${Stat} label="rowAt narrow" value="360px" /><//>
            <${Stack} rowAt="wide"><${Stat} label="rowAt wide" value="720px" /><${Stat} label="rowAt wide" value="720px" /><//>
            <${Empty} title="No fish yet" text="Cast from the pier to catch your first."><${Button} variant="primary">Go fishing<//><//>
          <//>
        </div>
      <//>
    </div>`;
    return { view, level, lives, isAnimated };
  };

  css(`
    .gallery { align-self: stretch; flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; pointer-events: auto; color: var(--ink); font-family: var(--body); }
    .gallery-inner { display: flex; flex-direction: column; gap: 14px; max-width: 880px; margin: 0 auto; padding-block: 4px 24px; }
    .gallery-head h2 { margin: 0; font: 700 26px var(--display); }
    .gallery-head p, .gallery-note { margin: 0; color: var(--dim); font-size: 13px; }
    .gallery-head { display: flex; flex-direction: column; gap: 8px; }
    .gallery-skins .ui-button { text-transform: capitalize; font-size: 13px; }
    .gallery-section { display: flex; flex-direction: column; gap: 10px; padding: var(--ui-pad); border-radius: var(--radius-lg); background: var(--panel); border: var(--border) solid var(--line); box-shadow: var(--shadow); }
    .gallery-section h3 { margin: 0; font: 700 18px var(--display); }
    .gallery-demo { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .gallery-pane { max-height: 220px; }
    .gallery-pages { display: flex; gap: var(--ui-gap); padding-inline: 12%; }
    .gallery-page { flex: 0 0 76%; }
  `);

  Kit.register({
    id: 'gallery',
    name: 'Components',
    tagline: 'Every clikit component in every state',
    hidden: true,
    order: 999,
    theme: { skin: 'glass' },
    create(ctx) {
      ctx.scene.background = ctx.make.color(BACKDROP_COLOR);
      const gallery = createGallery(ctx);
      ctx.ui.mount(gallery.view);
      return {
        update(dt, time) {
          if (!gallery.isAnimated.value) return;
          // A slow swing, so the meters, the progress bar and the pips all visibly track one changing value.
          const swing = 0.5 + 0.5 * Math.sin(time * SWING_RATE);
          gallery.level.value = swing;
          gallery.lives.value = Math.round(swing * DEMO_LIVES);
        },
      };
    },
  });
})();
