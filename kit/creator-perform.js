/**
 * Kit creator perform: what the character on the stage is doing, and the picker that chooses it. The character
 * is never frozen: with nothing chosen it idles (breathes, shifts its weight, looks about, blinks, fidgets);
 * the picker offers walking, running and every performance of `Kit.act.REPERTOIRE` this body can do.
 *
 * Owns:  `Kit.creator.performanceChoices` (pure: a bake -> the rows of the picker, each with why the body cannot
 *        do it, if it cannot), `Kit.creator.stagePlayer` (pure: the motion state behind the stage, made again
 *        when the body changes, advanced each frame towards the chosen row) and `Kit.creator.PerformPicker`
 *        (the rail button and its list; needs the DOM and kit/ui/).
 * Does not own: the performances (kit/act*.js), walking (kit/gait.js), or drawing (kit/creator.js copies the
 *        pose this hands back into the figure).
 *
 * The two pure parts are unit-tested in tools/test-act.js; the picker in the browser (tools/test-creator-ui.js).
 */
(() => {
  if (!Kit.act || !Kit.act.character) return;

  /** The row chosen when nothing is: standing, alive. */
  const IDLE = 'idle';
  /** Gravity, for a speed from a Froude number (kit/gait.js): the same walk and the same run on any size of body. */
  const GRAVITY = 9.81;
  /** Rows that move the body along: the Froude number each is shown at. */
  const TRAVELLING = Object.freeze({ walk: 0.2, run: 1.6 });
  /** Metres per second a body without legs is moved at for `walk` and `run` (it swims). */
  const LEGLESS_SPEED = Object.freeze({ walk: 0.6, run: 1.4 });
  /** The picker's first rows, before the repertoire's. */
  const FIRST_ROWS = Object.freeze([
    { id: IDLE, label: 'Idle', kind: 'loop' },
    { id: 'walk', label: 'Walk', kind: 'loop' },
    { id: 'run', label: 'Run', kind: 'loop' },
  ]);
  /** What the small tag beside a row says, by its kind. */
  const KIND_TAGS = Object.freeze({ loop: 'loops', hold: 'holds', once: 'once' });

  /** A performance's kind: it loops, it holds its last pose, or it plays once and the character idles again. */
  const kindOf = (performance) => (performance.loop ? 'loop' : performance.hold ? 'hold' : 'once');

  /**
   * @typedef {Object} PerformanceChoice
   * @property {string} id 'idle', 'walk', 'run' or an id of `Kit.act.REPERTOIRE`
   * @property {string} label
   * @property {'loop'|'hold'|'once'} kind
   * @property {?string} refusal why this body cannot do it; null when it can
   */

  /**
   * The rows of the picker for a body: idle, walk, run, then the repertoire (the small fidgets idling plays on
   * its own are left out).
   * @param {{plan: Object, rest?: Object}} bake
   * @returns {PerformanceChoice[]}
   * @complexity O(performances * roles)
   * @example Kit.creator.performanceChoices(bake).filter((choice) => !choice.refusal).map((choice) => choice.id)
   */
  const performanceChoices = (bake) => {
    const fidgets = Kit.act.FIDGETS || [];
    const played = Object.values(Kit.act.REPERTOIRE)
      .filter((performance) => !fidgets.includes(performance.id))
      .map((performance) => ({ id: performance.id, label: performance.label, kind: kindOf(performance), refusal: Kit.act.refusal(performance.id, bake.plan, bake.rest) }));
    return /** @type {PerformanceChoice[]} */ (FIRST_ROWS.map((row) => ({ ...row, refusal: null })).concat(played));
  };

  /** Metres per second a row moves a body at: 0 for everything done on the spot. */
  const speedOf = (bake, id) => {
    if (!(id in TRAVELLING)) return 0;
    const problem = Kit.motion.refusal(Kit.gait.walk(), bake.plan, bake.rest);
    return problem ? LEGLESS_SPEED[id] : Math.sqrt(TRAVELLING[id] * GRAVITY * Kit.gait.legs(bake.plan, bake.rest).legLength);
  };

  /**
   * The motion behind a stage that stays on one character: it idles, and is steered towards a chosen row.
   * @returns {{advance: function(number, Object, string): string, motion: function(): ?Object}} `advance(dt, bake,
   *   wanted)` steps the motion for `bake` (made again when the bake changes) and returns the row now showing:
   *   `wanted`, or 'idle' once a one-shot has finished or when the body cannot do it. `motion()` is the state
   *   (its `pose` is what to draw; `Kit.act.keepInPlace` keeps it on the spot).
   * @complexity advance: one `Kit.motion.advance`; a new motion state per new bake
   * @example
   * const player = Kit.creator.stagePlayer();
   * choice.value = player.advance(dt, bake, choice.value);
   * Kit.rig.copy(player.motion().pose, figure.local);
   */
  const stagePlayer = () => {
    let bakeShown = null;
    let motion = null;
    let started = IDLE;
    let travelled = 0;
    let speed = 0;
    const offset = [0, 0];
    const position = [0, 0];

    /** Starts a row on the motion state; false when the body cannot. */
    const start = (id) => {
      if (id === IDLE || id in TRAVELLING) {
        Kit.act.base(motion, null);
        Kit.act.stop(motion);
        return true;
      }
      if (Kit.act.refusal(id, bakeShown.plan, bakeShown.rest)) return false;
      if (Kit.act.REPERTOIRE[id].loop) {
        Kit.act.base(motion, id);
        Kit.act.stop(motion);
        return true;
      }
      Kit.act.base(motion, null);
      return Kit.act.play(motion, id);
    };

    return {
      advance(dt, bake, wanted) {
        let showing = wanted;
        if (bake !== bakeShown) {
          bakeShown = bake;
          motion = Kit.motion.state(bake, Kit.act.character());
          started = IDLE;
          speed = -1;
          position.fill(0);
        }
        if (showing !== started || speed < 0) {
          if (!start(showing)) showing = IDLE;
          started = showing;
          speed = speedOf(bake, showing);
        }
        travelled += speed * dt;
        // Where a kick or a dive left the body is where it now stands, so the next thing starts from there.
        if (Kit.act.takeRootMotion(motion, offset)) {
          position[0] += offset[0];
          position[1] += offset[1];
        }
        Kit.motion.advance(motion, dt, position[0], 0, position[1] + travelled, 0);
        const isOver = showing !== IDLE && !(showing in TRAVELLING) && !Kit.act.REPERTOIRE[showing].loop && Kit.act.playing(motion) !== showing;
        if (isOver) {
          showing = IDLE;
          started = IDLE;
        }
        return showing;
      },
      motion: () => motion,
    };
  };

  Kit.creator = Object.assign(Kit.creator || {}, { performanceChoices, stagePlayer, IDLE_PERFORMANCE: IDLE });

  // ---- the picker (DOM) ------------------------------------------------------------------------------------------------
  if (!Kit.ui || !Kit.ui.html || !Kit.creator.Icon) return;
  const { html, css, useRef, useSignal, List } = Kit.ui;
  const { Icon } = Kit.creator;
  const { placePanel } = Kit.uiLogic;

  css(`
    .cr-perform { display: contents; }
    .cr-perform-panel { position: fixed; inset: auto; margin: 0; width: min(232px, 72vw); max-height: min(60dvh, 420px); overflow-y: auto; overscroll-behavior: contain; padding: 8px; border: var(--border) solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--ink); box-shadow: var(--shadow); }
    .cr-perform-panel h3 { margin: 2px 6px 8px; font: 700 12px var(--body); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .cr-perform-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .cr-perform-row small { color: var(--muted); font-size: 11px; }
    .cr-perform-button[data-active="true"] { border-color: var(--accent); color: var(--accent); }
  `);

  /**
   * The rail button that says what the character is doing and opens the list to change it.
   * @param {{choice: Object, choices: function(): PerformanceChoice[]}} props `choice` a signal of the chosen
   *   row's id (two-way); `choices` reads the rows for the body on stage, called each time the list opens
   * @returns {Object} a vnode
   * @example html`<${PerformPicker} choice=${performance} choices=${() => Kit.creator.performanceChoices(bake)} />`
   */
  const PerformPicker = ({ choice, choices }) => {
    const button = useRef(null);
    const panel = useRef(null);
    const rows = useSignal(choices());
    const onToggle = (event) => {
      if (event.newState !== 'open') return;
      rows.value = choices();
      const spot = placePanel(button.current.getBoundingClientRect(), panel.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      panel.current.style.left = `${spot.left}px`;
      panel.current.style.top = `${spot.top}px`;
    };
    const onSelect = (_selection, row) => {
      choice.value = row.id;
      if (panel.current.hidePopover) panel.current.hidePopover();
    };
    const current = rows.value.find((row) => row.id === choice.value);
    return html`<span class="cr-perform">
      <button
        type="button"
        id="cr-perform"
        class="ui-button cr-tool cr-perform-button"
        data-variant="default"
        data-active=${String(choice.value !== IDLE)}
        aria-label=${`Performance: ${current ? current.label : 'Idle'}. Choose what the character does`}
        aria-haspopup="listbox"
        popovertarget="cr-perform-list"
        ref=${button}
        onClick=${(event) => event.stopPropagation()}
      >
        <span class="ui-button-text"><${Icon} name="walk" /></span>
      </button>
      <div class="cr-perform-panel" id="cr-perform-list" popover="auto" ref=${panel} onToggle=${onToggle}>
        <h3>Performance</h3>
        <${List}
          label="What the character does"
          items=${rows.value}
          selected=${choice}
          isDisabled=${(row) => Boolean(row.refusal)}
          onSelect=${onSelect}
          render=${(row) => html`<span class="cr-perform-row" id=${`cr-perform-${row.id}`} title=${row.refusal || undefined}>${row.label}<small>${row.refusal ? 'not this body' : KIND_TAGS[row.kind]}</small></span>`}
        />
      </div>
    </span>`;
  };

  Kit.creator.PerformPicker = PerformPicker;
})();
