// Lampwick Table - a shared virtual tabletop. This file wires the pieces together: it opens a seat at a table,
// turns changes to the shared state into view updates, and turns gestures and key presses into writes.
//
// Owns:  the session lifecycle (a local table with scripted players at once; the hosted table when the platform
//        answers), the refresh pipeline, the camera, gesture handling per tool, and the scripted players.
// Does not own: rules and shared value shapes (kit/tabletop.js - the key scheme is documented at the top of that
//        file, and every shared value goes through Kit.net keys), transports (kit/net*.js), 3D views
//        (games/table-board.js), HUD components (games/table-hud.js) or the look (games/table-theme.js).
//
// Depth, for a tool, is depth of capability: a game master can run a real session with it, not a demo.
//   seconds - a piece is dragged along a previewed route whose length is checked against that character's speed;
//             rolls, checks and moves are one tap from the sheet; an area is dragged out and shows who it catches.
//   minutes - an encounter: turn order, conditions, hit points; roll a move, then "Harm" applies the total to everyone
//             in the laid area (or the selected piece) and marks who drops; fog and doors decide what each player knows.
//   hours   - a campaign: several scenes, "Travel" moves the party between them, new scenes are painted in place,
//             everything is kept between visits (the hosted database, or this device's storage for a solo table),
//             each viewer remembers what they have explored, and the game master keeps private notes per scene and piece.
// Left out on purpose (said in the report): cone and line templates, per-piece light sources, importing map images,
// macros beyond harm and heal, and sharing private notes between co-GMs.
//
// Where this departs from the usual tabletop tools, on purpose:
//   - Nothing to set up: the page opens on a lit, populated scene you can play at once; on a hosted page a new
//     player is offered a free seat in one tap, and whoever may edit the page is the game master.
//   - One thumb: every control sits in one dock at the bottom edge; pan by dragging the table, zoom with two keys.
//   - Pieces feel held: a dragged piece lifts and follows the finger while the route, its length under the scene's
//     distance rule (difficult ground included) and the destination are previewed, and everyone else sees it move.
//   - Rolls cannot disagree with their dice: a roll travels as notation plus seed and every screen re-rolls it.
(() => {
  const parts = Kit.tableParts, tabletop = Kit.tabletop;
  const { KEYS } = tabletop;

  // ---- tunables ----------------------------------------------------------------------------------------------------

  /** The camera looks down at the table at a fixed tilt; only its focus point and distance change. */
  const CAMERA = {
    FIELD_OF_VIEW: 40, // degrees; narrow, so the board reads almost like a map
    TILT_DEGREES: 58, // above the horizon: steep enough to read the grid, shallow enough for pieces to stand
    START_CELLS_ACROSS: 8, // board cells visible across a portrait screen when a table opens (scaled up by the aspect when wide)
    LANDSCAPE_SHIFT: 0.2, // on a wide screen the dock covers the left; the view is shifted by this share of its width
    MIN_DISTANCE: 6,
    MAX_DISTANCE: 38,
    ZOOM_STEP: 1.3, // each zoom key press multiplies or divides the distance by this
    ZOOM_RATE: 8, // per second, smoothing of zoom
    FOLLOW_RATE: 5, // per second, smoothing when the camera recentres on a piece
  };
  /** Brightness of cells by what the viewer knows of them (see Kit.tabletop.lightLevels). */
  const LIGHT = { inView: 1, remembered: 0.3, unseen: 0, gmUnseen: 0.5 };
  /** Feel of play. */
  const PLAY = {
    GRAB_REACH: 0.75, // world units from a piece's centre within which a touch picks it up
    ROUTE_SEARCH_COST: 60, // how far the path preview searches before saying there is no way
    RULER_LINGER_SECONDS: 2,
    PRESENCE_SECONDS: 0.08, // how often this player's cursor is shared
    INK_MIN_STEP: 0.06, // cells the finger must travel before another ink point is taken
    PING_RINGS: [1.2, 2, 2.8], // sizes of the rings of one ping, in cells
    PING_RING_GAP_SECONDS: 0.16,
    FOE: { name: 'Foe', color: '#8c2f39', hp: 10, hpMax: 10, kind: 'npc' },
    AREA_SHAPES: Object.keys(Kit.measure.AREAS), // pressing Area again steps through these
    SAVE_SECONDS: 2, // how often a changed solo campaign and the explored map are written to this device
    ROLL_LOG_LENGTH: 60, // rolls kept for the log sheet
  };
  /** The local table: you are its game master and play Wren; two scripted players sit beside you. */
  const LOCAL = {
    YOU: { by: 'you', name: 'You', color: '#d9902f', tokenId: 'wren' },
    BOTS: [
      { by: 'bot-ash', name: 'Ash (bot)', color: '#3f8f8a', tokenId: 'ash' },
      { by: 'bot-ivy', name: 'Ivy (bot)', color: '#7a5aa6', tokenId: 'ivy' },
    ],
  };
  /** How the scripted players behave. */
  const BOT = {
    IDLE_SECONDS: [2.5, 5.5], // pause between actions, picked at random in this range
    WAIT_FOR_TURN_SECONDS: 1, // how often a bot checks whether its turn has come
    REACH_SECONDS: 0.6, // time its cursor takes to travel to its piece
    DRAG_CELLS_PER_SECOND: 3.2,
    STROLL_CELLS: 4,
    ROLL_CHANCE: 0.35,
    PING_CHANCE: 0.15,
  };
  const DEFAULT_PLAYER_COLOR = '#c39a4a';
  const HOSTED_TABLE = 'main';
  /** Names under which this game keeps things in its own storage (ctx.save). */
  const SAVED = { CAMPAIGN: 'campaign', EXPLORED: 'explored', GM_NOTES: 'gm-notes' };

  /** Which parts of the screen each kind of shared key affects. A key kind missing here changes nothing on screen. */
  const DIRTY_BY_KEY_KIND = {
    stage: ['board', 'light', 'tokens', 'ribbon', 'ink', 'hud'],
    scene: ['board', 'light', 'tokens', 'hud'],
    map: ['board', 'light', 'tokens'],
    door: ['board', 'light', 'tokens'],
    token: ['light', 'tokens', 'ribbon', 'hud'],
    turn: ['tokens', 'ribbon'],
    ink: ['ink'],
  };
  /** Order in which dirty parts are refreshed: later parts read what earlier ones computed. */
  const REFRESH_ORDER = ['board', 'light', 'tokens', 'ribbon', 'ink', 'hud'];

  const randomSeed = () => Math.floor(Math.random() * 2 ** 32);
  const roundCell = (point) => ({ x: Math.round(point.x), y: Math.round(point.y) });
  const isSameCell = (first, second) => first.x === second.x && first.y === second.y;

  /**
   * A transport on the local hub whose senders are marked as game master when they are the local player.
   * @param {Object} hub  a Kit.net.loopback hub
   * @param {string} by   the participant's id
   */
  const localTransport = (hub, by) => Kit.net.withSender(Kit.net.guarded(hub.join(by)), (sender) => ({ admin: sender.by === LOCAL.YOU.by }));

  // ---- scripted players --------------------------------------------------------------------------------------------

  /**
   * A scripted player on the local table: a real seat on the hub with a player's rights, which now and then reaches
   * for its piece, drags it along a route (sharing cursor and drag as presence), drops it, and sometimes rolls or
   * pings. With a turn order it acts only on its own turn and then ends it.
   * @param {Object} hub      the local Kit.net.loopback hub
   * @param {{by: string, name: string, color: string, tokenId: string}} profile
   * @returns {{update: function(number): void, close: function(): void}}
   */
  function scriptedPlayer(hub, profile) {
    const seat = tabletop.seat(localTransport(hub, profile.by), { by: profile.by, isGm: () => false });
    const rng = Kit.rng();
    const tokenKey = KEYS.token(profile.tokenId);
    const myToken = () => tabletop.cleanToken(seat.read(tokenKey));
    const pause = () => rng.range(BOT.IDLE_SECONDS[0], BOT.IDLE_SECONDS[1]);
    let phase = 'idle', timer = pause(), cursor = null, reachFrom = null, route = null, travelled = 0;
    seat.net.presence({ name: profile.name, color: profile.color });

    const isMyTurn = () => {
      const turn = tabletop.cleanTurn(seat.read(KEYS.turn));
      return !turn || turn.order[turn.index] === profile.tokenId;
    };
    // The cursor is a position in the scene the bot's piece stands in; screens showing another scene do not draw it.
    const share = (drag) => seat.net.presence({ scene: (myToken() || { scene: null }).scene, cursor: [cursor.x, cursor.y], drag });

    /** Decide what to do after a pause: start reaching for the piece when there is somewhere to walk. */
    function plan() {
      const token = myToken();
      // The bot walks only while its piece stands in the scene on stage; elsewhere it waits to be brought along.
      const isOnStage = !!token && token.scene === tabletop.activeSceneId(seat.read);
      const board = isOnStage ? tabletop.boardOf(seat.read, token.scene) : null;
      const canAct = !!board && !!token && isMyTurn();
      route = canAct ? tabletop.strollRoute(board, tabletop.tokensOf(seat.net, token.scene), token, rng, BOT.STROLL_CELLS) : null;
      if (!route) {
        timer = canAct ? pause() : BOT.WAIT_FOR_TURN_SECONDS;
        return;
      }
      reachFrom = cursor || { x: token.x + 2, y: token.y + 2 };
      travelled = 0;
      phase = 'reach';
    }
    /** After dropping the piece: sometimes roll, sometimes ping, and pass the turn if there is one. */
    function afterMove(token) {
      if (rng.chance(BOT.ROLL_CHANCE)) seat.net.emit('roll', { notation: Kit.dice.check(rng.int(0, 3)), seed: randomSeed(), label: token.name + ': Agility', tokenId: profile.tokenId });
      else if (rng.chance(BOT.PING_CHANCE)) seat.net.emit('ping', { x: token.x, y: token.y });
      const turn = tabletop.cleanTurn(seat.read(KEYS.turn));
      if (turn) seat.put(KEYS.turn, tabletop.nextTurn(turn, (id) => !!seat.read(KEYS.token(id))));
    }

    /** One step of each phase; a phase returns nothing and moves the bot on by setting `phase`. */
    const PHASES = {
      idle(dt) {
        timer -= dt;
        if (timer <= 0) plan();
      },
      reach(dt) {
        travelled += dt / BOT.REACH_SECONDS;
        const blend = Kit.math.ease.inOutQuad(Math.min(1, travelled));
        cursor = { x: Kit.math.lerp(reachFrom.x, route[0].x, blend), y: Kit.math.lerp(reachFrom.y, route[0].y, blend) };
        share(null);
        if (travelled >= 1) (phase = 'drag'), (travelled = 0);
      },
      drag(dt) {
        travelled += BOT.DRAG_CELLS_PER_SECOND * dt;
        const at = Kit.line.at(route, travelled);
        cursor = { x: at.x, y: at.y };
        const isDone = travelled >= Kit.line.length(route);
        share(isDone ? null : [profile.tokenId, cursor.x, cursor.y]);
        if (!isDone) return;
        const token = myToken(), destination = route[route.length - 1];
        if (token && seat.put(tokenKey, { ...token, x: destination.x, y: destination.y })) afterMove(token);
        phase = 'idle';
        timer = pause();
      },
    };

    return {
      update(dt) {
        PHASES[phase](dt);
        seat.net.tick(dt);
      },
      close: () => seat.net.close(),
    };
  }

  // ---- the game ----------------------------------------------------------------------------------------------------

  /**
   * Build the tabletop for one play session.
   * @param {Object} ctx  the game context from the kit shell
   * @returns {{update: function(number, number): void, dispose: function(): void}}
   */
  function create(ctx) {
    const { ui, input, fx, sfx, make, math } = ctx;

    // -- stage, camera, views, HUD --
    make.stage({ sky: [0x120d09, 0x050302], sun: [5, 12, 6], sunColor: 0xffe2b8, sunIntensity: 1.25, ambient: 0.75, shadow: 24 });
    ctx.post.vignette(0.34); // a pool of lamplight over the table
    ctx.camera.fov = CAMERA.FIELD_OF_VIEW;
    ctx.camera.updateProjectionMatrix();
    const space = parts.boardSpace();
    const boardView = parts.boardView(ctx, space), pieces = parts.tokenViews(ctx, space), cursors = parts.cursorViews(ctx, space);
    const pathPreview = parts.pathView(ctx, space), dice = parts.diceView(ctx);
    const inkLines = parts.lineViews(ctx, space, parts.RIBBON_WIDTH.INK), rulerLines = parts.lineViews(ctx, space, parts.RIBBON_WIDTH.RULER);
    const areaTints = parts.areaViews(ctx, space);
    const seatStat = ui.stat('Seat', '-'), tableStat = ui.stat('Table', '-');

    /** Everything that changes while the table is open. */
    const state = {
      /** @type {Object|null} */ seat: null, // Kit.tabletop seat of the table in use
      /** @type {Object|null} */ identity: null, // { by, isGm(), name, color }
      /** @type {Object|null} */ hosted: null, // the platform transport, when the table is the hosted one
      stopListening: [], // unsubscribe functions of the current seat
      bots: [],
      tableEpoch: 0, // bumped when the table is switched, so delayed callbacks from the old one can tell
      tool: 'move',
      isGmView: false,
      selectedId: null,
      /** @type {string|null} */ sceneId: null, // the scene on stage, as last drawn
      /** @type {Object|null} */ board: null,
      visible: new Uint8Array(0),
      explored: new Uint8Array(0),
      exploredByScene: new Map(), // scene id -> cells this viewer has ever seen there
      /** @type {{shape: string, x: number, y: number, radius: number}|null} */ area: null, // the area template lying on the table
      areaShape: PLAY.AREA_SHAPES[0],
      /** @type {number|null} */ lastRollTotal: null,
      rollLog: [],
      /** @type {Object|null} */ memory: null, // Kit.net.remember handle of a solo campaign
      hasUnsavedChanges: false,
      saveTimer: PLAY.SAVE_SECONDS,
      isFirstLight: true,
      dirty: new Set(REFRESH_ORDER),
      peers: [], // cleaned rows of everyone else at the table
      profileNames: new Map(), // user id -> name the platform resolved
      heldByPeers: new Set(), // token ids other players are dragging
      inkSeen: new Map(), // ink key -> JSON of the chunk drawn for it
      myStrokes: [], // ids of this player's own strokes, oldest first
      history: Kit.history(),
      /** @type {Object|null} */ gesture: null,
      hasOfferedSeat: false,
      focus: { x: 0, z: 0 },
      /** @type {{x: number, z: number}|null} */ followTarget: null,
      distance: 0,
      distanceGoal: 0,
      presencePatch: {},
      presenceTimer: 0,
      shouldFrame: false, // set when a new scene comes on stage: the camera is pointed at it on the next frame
      lastCursor: null,
      rulerEpoch: 0,
    };
    const allowEvent = tabletop.eventGate();

    // -- reading the table --
    const read = (key) => state.seat.read(key);
    const viewer = () => ({ by: state.identity.by, isGm: state.identity.isGm() && state.isGmView });
    const scene = () => tabletop.cleanScene(read(KEYS.scene(state.sceneId)));
    /** Tokens standing in the scene on stage. */
    const tokens = () => tabletop.tokensOf(state.seat.net, state.sceneId);
    const tokenOf = (id) => (id ? tabletop.cleanToken(read(KEYS.token(id))) : null);
    const sheetOf = (id) => tabletop.cleanSheet(read(KEYS.sheet(id))) || tabletop.blankSheet();
    const turn = () => tabletop.cleanTurn(read(KEYS.turn));
    const myTokenIds = () => tokens().filter(([, token]) => state.identity.by !== null && token.owner === state.identity.by).map(([id]) => id);
    const canControl = (token) => viewer().isGm || (state.identity.by !== null && token.owner === state.identity.by);
    const markDirty = (...dirtyParts) => dirtyParts.forEach((part) => state.dirty.add(part));
    const isCellInView = (cell) => !!state.board && state.board.inside(cell.x, cell.y) && state.visible[cell.y * state.board.w + cell.x] === 1;

    // -- HUD --
    const ribbon = parts.ribbon(ui, { onPick: selectAndShow, onEndTurn: endTurn, onRollOrder: rollOrder });
    const dock = parts.dock(ui, { onTool: chooseTool, onGmAction: (actionId) => GM_ACTION_HANDLERS[actionId](), onSheet: openSheet, onGmView: toggleGmView, onRoll: (notation) => rollDice(notation, '', null), onLog: () => parts.openLog(ui, state.rollLog) });
    dock.setLastRoll(null);
    parts.zoomKeys(ui, (direction) => (state.distanceGoal = math.clamp(state.distanceGoal * (direction > 0 ? 1 / CAMERA.ZOOM_STEP : CAMERA.ZOOM_STEP), CAMERA.MIN_DISTANCE, CAMERA.MAX_DISTANCE)));
    const readout = parts.readout(ui);
    /** Say why something did not happen, in the status line, and return false so callers can pass the refusal on. */
    const refuse = (reason) => {
      dock.setStatus(reason, true);
      return false;
    };
    /** Write a shared value from this seat; a refusal by the rules is explained instead of silently dropped. */
    const put = (key, value, reason = 'Only the game master can change that.') => state.seat.put(key, value) || refuse(reason);

    // ---- refresh pipeline: shared state -> views ----

    const REFRESHERS = {
      board() {
        const sceneId = tabletop.activeSceneId(read), hasChangedScene = sceneId !== state.sceneId;
        if (hasChangedScene) leaveScene();
        state.sceneId = sceneId;
        const board = (state.board = tabletop.boardOf(read, sceneId));
        if (!board) return boardView.clear();
        const remembered = state.exploredByScene.get(sceneId);
        // What was explored is kept per scene; a scene whose size changed starts again from nothing.
        state.explored = remembered && remembered.length === board.w * board.h ? remembered : new Uint8Array(board.w * board.h);
        state.exploredByScene.set(sceneId, state.explored);
        boardView.rebuild(board);
        if (!hasChangedScene) return;
        state.shouldFrame = true;
        if (state.identity.isGm()) state.history.reset(snapshotTable()); // undo starts afresh in each scene
      },
      light() {
        const { board } = state;
        if (!board) return;
        const isFogOn = scene().fog;
        // A game master's lit area is what the players' characters see, so the dimmed remainder shows what is secret.
        const eyes = tabletop.eyesOf(tokens(), viewer().isGm ? { by: null, isGm: true } : viewer());
        state.visible = isFogOn ? tabletop.visibleCells(board, eyes) : new Uint8Array(board.w * board.h).fill(1);
        state.visible.forEach((isVisible, cell) => isVisible && (state.explored[cell] = 1)); // in place: the per-scene memory holds this array
        boardView.setLight(tabletop.lightLevels(state.visible, state.explored, viewer().isGm, LIGHT), state.isFirstLight);
        state.isFirstLight = false;
      },
      tokens() {
        const { board } = state;
        if (!board) return pieces.clear();
        const current = new Map(tokens()), acting = turn();
        pieces.ids().filter((id) => !current.has(id)).forEach(pieces.remove);
        current.forEach((token, id) =>
          pieces.sync(id, token, {
            isShown: tabletop.isTokenShown(token, viewer(), state.visible, board.w),
            isGhost: token.hidden && viewer().isGm,
            isActing: !!acting && acting.order[acting.index] === id,
            isSelected: id === state.selectedId,
          })
        );
      },
      ribbon() {
        const current = turn(), mine = myTokenIds();
        if (!current) return ribbon.render({ round: null, entries: [], canEndTurn: false, canRollOrder: viewer().isGm });
        const entryFor = (id) => {
          const token = tokenOf(id);
          const isKnown = !!token && !!state.board && tabletop.isTokenShown(token, viewer(), state.visible, state.board.w);
          // A piece the viewer cannot see keeps its place in the order but not its name.
          return { id, name: isKnown ? token.name : 'Unseen', color: isKnown ? token.color : '#5b5247', score: current.scores[id], isActing: current.order[current.index] === id, isMine: mine.includes(id) };
        };
        const present = current.order.filter((id) => tokenOf(id));
        ribbon.render({ round: current.round, entries: present.map(entryFor), canEndTurn: viewer().isGm || mine.includes(current.order[current.index]), canRollOrder: viewer().isGm });
      },
      ink() {
        const isOnStage = (key) => key.split('/')[2] === state.sceneId; // ink/<by>/<sceneId>/<stroke>.<part>
        const chunks = new Map(state.seat.net.all('ink/').filter(([key]) => isOnStage(key)).map(([key, value]) => [key, tabletop.cleanInk(value)]).filter(([, chunk]) => chunk));
        inkLines.keys().filter((key) => key !== 'preview' && !chunks.has(key)).forEach((key) => {
          inkLines.remove(key);
          state.inkSeen.delete(key);
        });
        chunks.forEach((chunk, key) => {
          const signature = JSON.stringify(chunk);
          if (state.inkSeen.get(key) === signature) return;
          state.inkSeen.set(key, signature);
          inkLines.set(key, tabletop.unpackInk(chunk), chunk.color);
        });
      },
      hud() {
        const mine = myTokenIds();
        seatStat.set(viewer().isGm ? 'GM' : mine.length ? tokenOf(mine[0]).name : 'Watching');
        tableStat.set(tableLabel());
        dock.setGm({ canBeGm: state.identity.isGm(), isGmView: state.isGmView });
        offerSeatIfNeeded();
      },
    };
    /** Who is at the table and how it is connected, in a few characters for the stats row. */
    function tableLabel() {
      const here = state.peers.length + 1;
      if (!state.hosted) return `Local ${here}`;
      const connection = state.hosted.state();
      return connection.isConnected ? `Live ${here}` : connection.isDurable ? 'Saved' : 'Offline';
    }
    const refresh = () => {
      REFRESH_ORDER.filter((part) => state.dirty.has(part)).forEach((part) => REFRESHERS[part]());
      state.dirty.clear();
    };

    // ---- other players: cursors, held pieces, rulers ----

    /** Take a roster from the session and redraw everything that shows other players. */
    function showPeers(roster) {
      const others = roster.filter((peer) => !peer.isMe && peer.peer !== state.seat.net.id);
      const everyone = others.map((peer) => ({ peer: peer.peer, by: peer.by || null, ...tabletop.cleanPresence(peer.presence) }));
      // Pointers, drags, rulers and areas are positions in a scene: those of peers looking at another scene are not drawn.
      const onStage = (peer) => (peer.scene === state.sceneId ? peer : { ...peer, cursor: null, drag: null, ruler: null, area: null });
      state.peers = everyone.map(onStage);
      const nameOfPeer = (peer) => state.profileNames.get(peer.by) || peer.name || 'Player';
      // A player is not shown pointers over cells they cannot see: a hovering cursor would give away where others are.
      const isOnBoard = (cell) => !!state.board && state.board.inside(cell.x, cell.y);
      const isCursorShown = (peer) => !!peer.cursor && isOnBoard(roundCell(peer.cursor)) && (viewer().isGm || isCellInView(roundCell(peer.cursor)));
      cursors.sync(state.peers.filter(isCursorShown).map((peer) => ({ peer: peer.peer, name: nameOfPeer(peer), color: peer.color || DEFAULT_PLAYER_COLOR, cursor: peer.cursor })));

      // A peer may visibly hold a piece only if they could move it: their own, or (unknown to us) a game master's.
      const drags = state.peers.filter((peer) => peer.drag).filter((peer) => {
        const token = tokenOf(peer.drag.id);
        return !!token && (token.owner === peer.by || token.owner === null);
      });
      const heldNow = new Set(drags.map((peer) => peer.drag.id));
      [...state.heldByPeers].filter((id) => !heldNow.has(id)).forEach(pieces.release);
      drags.forEach((peer) => pieces.hold(peer.drag.id, peer.drag.x, peer.drag.y));
      state.heldByPeers = heldNow;

      showPeerOverlays(rulerLines, state.peers.filter((peer) => peer.ruler), (peer) => peer.ruler);
      showPeerOverlays(areaTints, state.peers.filter((peer) => peer.area), (peer) => areaCells(peer.area));
      resolveNames(others.map((peer) => peer.by).filter(Boolean));
      markDirty('hud');
    }
    /**
     * Draw one overlay per peer (their ruler, their area) and drop the overlays of peers who no longer have one.
     * This player's own overlay lives under the key "me" and is left alone.
     */
    function showPeerOverlays(views, peers, pointsOf) {
      const keyOf = (peer) => 'peer:' + peer.peer;
      views.keys().filter((key) => key !== 'me' && !peers.some((peer) => keyOf(peer) === key)).forEach(views.remove);
      peers.forEach((peer) => views.set(keyOf(peer), pointsOf(peer), peer.color || DEFAULT_PLAYER_COLOR));
    }
    /** Ask the platform for display names of user ids not resolved yet (hosted tables only). */
    function resolveNames(userIds) {
      const unknown = userIds.filter((id) => !state.profileNames.has(id));
      if (!state.hosted || !unknown.length) return;
      unknown.forEach((id) => state.profileNames.set(id, '')); // mark as asked so each id is requested once
      state.hosted.profiles(unknown).then((profiles) => Object.entries(profiles || {}).forEach(([id, profile]) => state.profileNames.set(id, (profile && profile.name) || '')));
    }
    /** The display name for whoever sent an event. Names come from the platform or from presence, never from the event. */
    function nameOfSender(sender) {
      if (sender.isMe) return state.identity.name;
      const peer = state.peers.find((row) => row.peer === sender.peer);
      return state.profileNames.get(sender.by) || (peer && peer.name) || 'Someone';
    }

    // ---- events: rolls and pings ----

    /**
     * Roll dice and announce the roll to the table.
     * @param {string} notation  dice notation
     * @param {string} label     what the roll is for ('' shows the notation)
     * @param {string|null} tokenId
     * @returns {boolean} false when the notation does not parse
     */
    function rollDice(notation, label, tokenId) {
      try {
        state.seat.net.emit('roll', { notation: Kit.dice.parse(notation).text, seed: randomSeed(), label, tokenId: tokenId || '' });
        return true;
      } catch (parseError) {
        return refuse(parseError.message.replace('Kit.dice: ', 'Dice: '));
      }
    }
    function showRoll(data, sender) {
      const roll = tabletop.cleanRoll(data);
      if (!roll || !allowEvent(sender.peer, ctx.time)) return;
      const result = Kit.dice.roll(roll.plan, Kit.rng(roll.seed));
      const epoch = state.tableEpoch;
      dice.throwDice(result.dice, state.focus);
      sfx.play('whoosh');
      ctx.after(parts.DICE.SETTLE_SECONDS, () => {
        if (epoch !== state.tableEpoch) return; // the table was switched while the dice were in the air
        const entry = { who: nameOfSender(sender), label: roll.label, result };
        dock.addRoll(entry);
        state.rollLog = [...state.rollLog, entry].slice(-PLAY.ROLL_LOG_LENGTH);
        // The latest roll is what Harm and Heal apply, whoever rolled it: the GM applies a player's damage roll too.
        state.lastRollTotal = Math.abs(result.total);
        dock.setLastRoll(state.lastRollTotal);
        sfx.play(result.natural === 20 ? 'perfect' : 'coin');
      });
    }
    function showPing(data, sender) {
      const ping = tabletop.cleanPing(data);
      if (!ping || !allowEvent(sender.peer, ctx.time)) return;
      const peer = state.peers.find((row) => row.peer === sender.peer);
      const color = parseInt(((peer && peer.color) || (sender.isMe ? state.identity.color : DEFAULT_PLAYER_COLOR)).slice(1), 16);
      const at = space.toWorld(ping.x, ping.y);
      PLAY.PING_RINGS.forEach((size, index) => ctx.after(index * PLAY.PING_RING_GAP_SECONDS, () => fx.ring({ x: at.x, y: 0.05, z: at.z }, { color, size, life: 0.7 })));
      sfx.play('tap');
    }

    // ---- turn order ----

    function rollOrder() {
      const order = tabletop.rollTurnOrder(tokens(), sheetOf, Kit.rng());
      if (order) put(KEYS.turn, order);
    }
    function endTurn() {
      const current = turn();
      if (current) put(KEYS.turn, tabletop.nextTurn(current, (id) => !!tokenOf(id)), 'It is not your turn.');
    }
    /** Select a piece and bring the camera to it. */
    function selectAndShow(id) {
      state.selectedId = id;
      const position = pieces.positionOf(id);
      if (position) state.followTarget = { x: position.x, z: position.z };
      markDirty('tokens');
    }

    // ---- game master edits and undo ----

    /** What undo restores: the map rows and which tokens exist (not where players have since moved them). */
    const snapshotTable = () => ({ rows: Array.from({ length: scene().height }, (unused, row) => read(KEYS.mapRow(state.sceneId, row)) || ''), tokens: Object.fromEntries(state.seat.net.all('token/')) });
    const rememberEdit = () => state.history.push(snapshotTable());
    function undoLastEdit() {
      const earlier = state.history.undo();
      if (!earlier) return refuse('Nothing to undo.');
      earlier.rows.forEach((row, index) => row !== read(KEYS.mapRow(state.sceneId, index)) && put(KEYS.mapRow(state.sceneId, index), row));
      const nowKeys = state.seat.net.keys('token/');
      nowKeys.filter((key) => !(key in earlier.tokens)).forEach((key) => put(key, undefined));
      Object.entries(earlier.tokens).filter(([key]) => !nowKeys.includes(key)).forEach(([key, token]) => put(key, token));
      dock.setStatus('Undone.');
    }
    function toggleFog() {
      const current = scene();
      put(KEYS.scene(state.sceneId), { ...current, fog: !current.fog });
      dock.setStatus(current.fog ? 'Fog lifted for everyone.' : 'Fog is back.');
    }
    // ---- automations: applying a roll, travelling between scenes ----

    /** The board cells an area template covers. */
    const areaCells = (area) => Kit.measure.area(area.shape, area, area.radius, scene().rule).filter((cell) => state.board.inside(cell.x, cell.y));
    /** Who a harm or heal lands on: everyone in the laid area, else the selected piece. */
    const targetIds = () => (state.area ? tabletop.tokensOn(tokens(), areaCells(state.area)) : state.selectedId ? [state.selectedId] : []);
    /**
     * Apply the latest roll's total to the targets: harm (direction +1) or healing (-1). One press replaces opening
     * every sheet in turn, and the "down" condition follows the hit points by itself.
     */
    function applyLastRoll(direction) {
      const ids = targetIds();
      if (state.lastRollTotal === null) return refuse('Roll something first.');
      if (!ids.length) return refuse('Lay an area or select a piece first.');
      const changed = ids.filter((id) => put(KEYS.token(id), tabletop.harmed(tokenOf(id), direction * state.lastRollTotal)));
      clearArea();
      dock.setStatus(`${direction > 0 ? 'Harm' : 'Healing'} ${state.lastRollTotal} applied to ${changed.length} ${changed.length === 1 ? 'piece' : 'pieces'}.`);
      sfx.play(direction > 0 ? 'hit' : 'up');
    }
    function clearArea() {
      state.area = null;
      areaTints.remove('me');
      sharePresence({ area: null });
    }
    /** Put another scene on stage; with the party, every player character is moved to its entry first. */
    function goToScene(sceneId, withParty) {
      const destination = tabletop.cleanScene(read(KEYS.scene(sceneId)));
      if (!destination) return refuse('That scene no longer exists.');
      if (withParty) tabletop.partyTravel(tabletop.tokensOf(state.seat.net), tabletop.boardOf(read, sceneId), destination, sceneId).forEach(([id, token]) => put(KEYS.token(id), token));
      if (put(KEYS.stage, { scene: sceneId })) put(KEYS.turn, undefined); // a turn order belongs to the scene it was rolled in
    }
    function addScene(name) {
      const sceneId = 'scene-' + randomSeed().toString(36);
      tabletop.blankSceneEntries(sceneId, name.slice(0, tabletop.LIMITS.SCENE_NAME_LENGTH)).forEach(([key, value]) => put(key, value));
      goToScene(sceneId, false);
      dock.setStatus('A blank scene. Paint it with the palette, then Travel to bring the party.');
    }
    /** The game master's private notes: kept in this device's storage and never written to the table. */
    const gmNotes = {
      of: (subject) => ctx.save.get(SAVED.GM_NOTES, {})[subject] || '',
      keep: (subject, text) => ctx.save.set(SAVED.GM_NOTES, { ...ctx.save.get(SAVED.GM_NOTES, {}), [subject]: text }),
    };
    function openScenes() {
      const everyToken = tabletop.tokensOf(state.seat.net);
      const scenes = state.seat.net.keys('scene/').map((key) => tabletop.splitKey(key).rest).map((id) => ({ id, scene: tabletop.cleanScene(read(KEYS.scene(id))) })).filter((row) => row.scene)
        .map((row) => ({ id: row.id, name: row.scene.name, isActive: row.id === state.sceneId, pieces: everyToken.filter(([, token]) => token.scene === row.id).length }));
      parts.openScenes(ui, { scenes, notes: gmNotes.of('scene:' + state.sceneId), canReset: !state.hosted }, {
        onGo: goToScene,
        onAdd: addScene,
        onNotes: (text) => gmNotes.keep('scene:' + state.sceneId, text),
        onReset() {
          state.memory.forget();
          ctx.save.set(SAVED.EXPLORED, {});
          state.memory = null; // nothing more is written for the old campaign
          ctx.restart();
        },
      });
    }
    /** What changes when another scene comes on stage: the selection and overlays belong to the old one. */
    function leaveScene() {
      state.selectedId = null;
      state.isFirstLight = true;
      state.area = null;
      [areaTints, rulerLines].forEach((views) => views.clear());
    }

    /** One-shot actions of the game master palette, by id (games/table-hud.js GM_ACTIONS). */
    const GM_ACTION_HANDLERS = { order: rollOrder, fog: toggleFog, undo: undoLastEdit, scenes: openScenes, harm: () => applyLastRoll(1), heal: () => applyLastRoll(-1) };

    // ---- tools ----

    function chooseTool(toolId) {
      // Pressing Ink while it is already selected erases this player's latest stroke.
      if (toolId === 'ink' && state.tool === 'ink') return eraseLastStroke();
      // Pressing Area while it is already selected clears the laid area and steps to the next shape.
      if (toolId === 'area' && state.tool === 'area') return nextAreaShape();
      state.tool = toolId;
      dock.setTool(toolId);
      dock.setStatus(dock.hintFor(toolId));
    }
    function toggleGmView() {
      state.isGmView = !state.isGmView;
      if (!state.isGmView && state.tool !== 'move' && !parts.PLAY_TOOLS.some((tool) => tool.id === state.tool)) chooseTool('move');
      dock.setStatus(state.isGmView ? 'GM view: dimmed cells are out of the players\' sight.' : 'Player view: you see what your own piece sees.');
      markDirty('light', 'tokens', 'ribbon', 'hud');
    }
    function eraseLastStroke() {
      const strokeId = state.myStrokes.pop();
      if (!strokeId) return refuse('You have no ink to erase.');
      state.seat.net.keys(KEYS.ink(state.identity.by, state.sceneId, strokeId, '')).forEach((key) => put(key, undefined));
    }
    function nextAreaShape() {
      const shapes = PLAY.AREA_SHAPES;
      state.areaShape = shapes[(shapes.indexOf(state.areaShape) + 1) % shapes.length];
      clearArea();
      dock.setStatus(`Area shape: ${Kit.measure.AREAS[state.areaShape].label.toLowerCase()}.`);
    }

    /** Where the pointer is on the board, in fractional cells; null when it misses the table plane. */
    function pointerCells() {
      const ground = input.ground(0);
      return ground ? space.toCells(ground.x, ground.z) : null;
    }
    /** Put the camera where the focus and distance say, at once (pan needs this before the next ground lookup). */
    function placeCamera() {
      const tilt = (CAMERA.TILT_DEGREES * Math.PI) / 180;
      ctx.camera.position.set(state.focus.x, Math.sin(tilt) * state.distance, state.focus.z + Math.cos(tilt) * state.distance);
      ctx.camera.lookAt(state.focus.x, 0, state.focus.z);
      ctx.camera.updateMatrixWorld();
    }

    /** Dragging the table itself: the grabbed point stays under the finger. Every tool falls back to this. */
    const PAN = {
      start() {
        const ground = input.ground(0);
        state.gesture = ground ? { kind: 'pan', grab: { x: ground.x, z: ground.z } } : null;
      },
      move() {
        const ground = input.ground(0);
        if (!ground || !state.gesture || !state.board) return;
        const halfWidth = state.board.w / 2, halfHeight = state.board.h / 2;
        state.focus.x = math.clamp(state.focus.x + state.gesture.grab.x - ground.x, -halfWidth, halfWidth);
        state.focus.z = math.clamp(state.focus.z + state.gesture.grab.z - ground.z, -halfHeight, halfHeight);
        state.followTarget = null;
        placeCamera();
      },
      end() {
        state.gesture = null;
      },
    };

    /**
     * The route a dragged piece would take to a cell. Game masters place pieces freely (a straight line, through
     * anything); players walk: around walls, never onto blocked cells.
     * @returns {Array<{x: number, y: number}>|null}
     */
    function routeFor(from, to) {
      if (viewer().isGm) return Kit.sight.cellsBetween(from, to);
      return Kit.measure.route(state.board, from, to, { passable: tabletop.isWalkable, costOf: tabletop.moveCostOf, maxCost: PLAY.ROUTE_SEARCH_COST });
    }
    /** Preview the held piece's route to the cell under the finger, with its length under the scene's distance rule. */
    function previewMove(gesture, hover) {
      gesture.hover = hover;
      gesture.route = state.board.inside(hover.x, hover.y) ? routeFor(gesture.from, hover) : null;
      const { pointer } = input;
      if (!gesture.route) {
        pathPreview.hide();
        return readout.show('No way through', pointer.x, pointer.y, true);
      }
      const current = scene();
      const cells = Kit.measure.along(gesture.route, current.rule, (x, y) => tabletop.moveCostOf(state.board.get(x, y)));
      const isFar = cells > sheetOf(gesture.id).speed; // further than this character moves in a turn: allowed, but flagged
      pathPreview.show(gesture.route, isFar);
      readout.show(Kit.measure.label(cells, current), pointer.x, pointer.y, isFar);
    }

    const MOVE_TOOL = {
      start() {
        const ground = input.ground(0);
        const id = ground && pieces.nearest(ground.x, ground.z, PLAY.GRAB_REACH);
        const token = tokenOf(id);
        if (!token || !canControl(token)) return PAN.start();
        state.gesture = { kind: 'piece', id, from: { x: token.x, y: token.y }, hover: { x: token.x, y: token.y }, route: null };
        state.selectedId = id;
        markDirty('tokens');
        sfx.play('tap');
      },
      move() {
        const gesture = state.gesture, at = pointerCells();
        if (!gesture || gesture.kind !== 'piece') return PAN.move();
        if (!at) return;
        pieces.hold(gesture.id, at.x, at.y);
        sharePresence({ drag: [gesture.id, at.x, at.y] });
        if (!isSameCell(roundCell(at), gesture.hover)) previewMove(gesture, roundCell(at));
      },
      end() {
        const gesture = state.gesture;
        if (!gesture || gesture.kind !== 'piece') return PAN.end();
        const token = tokenOf(gesture.id), destination = gesture.route && gesture.route[gesture.route.length - 1];
        if (token && destination && !isSameCell(destination, gesture.from) && put(KEYS.token(gesture.id), { ...token, x: destination.x, y: destination.y }, 'That piece cannot go there.')) {
          sfx.play('thud');
          const at = space.toWorld(destination.x, destination.y);
          fx.burst({ x: at.x, y: 0.05, z: at.z }, { count: 8, color: 0xb9ad94, speed: 1.6, life: 0.35, size: 0.07, flat: true });
        }
        pieces.release(gesture.id);
        pathPreview.hide();
        readout.hide();
        sharePresence({ drag: null });
        state.gesture = null;
      },
      tap() {
        const ground = input.ground(0);
        if (!ground || !state.board) return;
        const id = pieces.nearest(ground.x, ground.z, PLAY.GRAB_REACH);
        if (id) return selectAndShow(id);
        state.selectedId = null; // a tap on open table lets go of the selection
        markDirty('tokens');
        const cell = roundCell(space.toCells(ground.x, ground.z));
        const terrain = state.board.get(cell.x, cell.y);
        if (!terrain || !terrain.isDoor) return;
        const doorKey = KEYS.door(state.sceneId, cell.x, cell.y);
        if (put(doorKey, read(doorKey) === 1 ? undefined : 1, 'Stand beside a door to open or close it.')) sfx.play('click');
      },
    };

    const RULER_TOOL = {
      start() {
        const at = pointerCells();
        state.gesture = at ? { kind: 'ruler', from: roundCell(at) } : null;
      },
      move() {
        const gesture = state.gesture, at = pointerCells();
        if (!gesture || !at) return;
        const to = roundCell(at), current = scene();
        rulerLines.set('me', [gesture.from, to], state.identity.color);
        readout.show(Kit.measure.label(Kit.measure.between(gesture.from, to, current.rule), current), input.pointer.x, input.pointer.y);
        sharePresence({ ruler: [gesture.from.x, gesture.from.y, to.x, to.y] });
      },
      end() {
        state.gesture = null;
        const epoch = ++state.rulerEpoch;
        // The ruler lingers so the distance can be read, unless a newer one has been started meanwhile.
        ctx.after(PLAY.RULER_LINGER_SECONDS, () => {
          if (epoch !== state.rulerEpoch) return;
          rulerLines.remove('me');
          readout.hide();
          sharePresence({ ruler: null });
        });
      },
    };

    /** Lay an area template: drag from its centre outwards; it stays on the table until applied, replaced or cleared. */
    const AREA_TOOL = {
      start() {
        const at = pointerCells();
        state.gesture = at ? { kind: 'area', centre: roundCell(at) } : null;
      },
      move() {
        const gesture = state.gesture, at = pointerCells();
        if (!gesture || !at) return;
        const current = scene();
        const radius = Math.min(tabletop.LIMITS.AREA_RADIUS_MAX, Math.round(Kit.measure.between(gesture.centre, roundCell(at), current.rule)));
        state.area = { shape: state.areaShape, x: gesture.centre.x, y: gesture.centre.y, radius };
        const cells = areaCells(state.area);
        areaTints.set('me', cells, state.identity.color);
        const caught = tabletop.tokensOn(tokens(), cells).filter((id) => tabletop.isTokenShown(tokenOf(id), viewer(), state.visible, state.board.w)).length;
        readout.show(`${Kit.measure.label(radius, current)} ${Kit.measure.AREAS[state.areaShape].label.toLowerCase()} \u00b7 ${caught} caught`, input.pointer.x, input.pointer.y);
        sharePresence({ area: [state.area.shape, state.area.x, state.area.y, radius] });
      },
      end() {
        state.gesture = null;
        readout.hide();
        if (state.area && viewer().isGm) dock.setStatus('Roll, then Harm or Heal applies it to the area.');
      },
    };

    const PING_TOOL = {
      tap() {
        const at = pointerCells();
        if (at) state.seat.net.emit('ping', { x: at.x, y: at.y });
      },
    };

    const INK_TOOL = {
      start() {
        const at = pointerCells();
        state.gesture = at ? { kind: 'ink', points: [at] } : null;
      },
      move() {
        const gesture = state.gesture, at = pointerCells();
        if (!gesture || !at || Kit.line.dist(at, gesture.points[gesture.points.length - 1]) < PLAY.INK_MIN_STEP) return;
        gesture.points.push(at);
        inkLines.set('preview', gesture.points, state.identity.color);
      },
      end() {
        const gesture = state.gesture;
        state.gesture = null;
        inkLines.remove('preview');
        if (!gesture) return;
        if (state.identity.by === null) return refuse('Sign in to draw on the table.');
        const strokeId = Date.now().toString(36);
        const chunks = tabletop.packStroke(gesture.points, state.identity.color);
        const wasAccepted = chunks.map((chunk, part) => put(KEYS.ink(state.identity.by, state.sceneId, strokeId, part), chunk, 'Spectators cannot draw.')).every(Boolean);
        if (chunks.length && wasAccepted) state.myStrokes.push(strokeId);
      },
    };

    /** Painting terrain: the brush character is the part of the tool id after "paint:". */
    function paintUnderPointer() {
      const at = pointerCells();
      if (!at || !state.board) return;
      const cell = roundCell(at), brush = state.tool.split(':')[1];
      const row = read(KEYS.mapRow(state.sceneId, cell.y));
      if (!state.board.inside(cell.x, cell.y) || typeof row !== 'string' || row[cell.x] === brush) return;
      state.gesture = { kind: 'paint' };
      put(KEYS.mapRow(state.sceneId, cell.y), row.slice(0, cell.x) + brush + row.slice(cell.x + 1));
    }
    const PAINT_TOOL = {
      start: paintUnderPointer,
      move: paintUnderPointer,
      end() {
        if (state.gesture) rememberEdit();
        state.gesture = null;
      },
    };

    const FOE_TOOL = {
      tap() {
        const at = pointerCells();
        if (!at || !state.board) return;
        const cell = roundCell(at);
        if (!state.board.inside(cell.x, cell.y) || !tabletop.isWalkable(state.board.get(cell.x, cell.y))) return refuse('Place creatures on open ground.');
        const id = 'foe-' + randomSeed().toString(36);
        if (put(KEYS.token(id), { ...tabletop.TOKEN_DEFAULTS, ...PLAY.FOE, scene: state.sceneId, x: cell.x, y: cell.y }) && put(KEYS.sheet(id), tabletop.blankSheet())) rememberEdit();
      },
    };

    /** What each tool does with a gesture; anything a tool leaves out pans the table (or does nothing, for taps). */
    const TOOL_BEHAVIOURS = { move: MOVE_TOOL, ruler: RULER_TOOL, area: AREA_TOOL, ping: PING_TOOL, ink: INK_TOOL, paint: PAINT_TOOL, foe: FOE_TOOL };
    const behaviourOf = (toolId) => ({ ...PAN, tap() {}, ...TOOL_BEHAVIOURS[toolId.split(':')[0]] });
    input.onDrag((drag) => state.seat && behaviourOf(state.tool)[drag.phase]());
    input.onTap(() => state.seat && behaviourOf(state.tool).tap());

    // ---- character sheet ----

    function openSheet() {
      const id = state.selectedId || myTokenIds()[0];
      const token = tokenOf(id);
      if (!token) return refuse('Tap a piece first to open its sheet.');
      const isShown = state.board && tabletop.isTokenShown(token, viewer(), state.visible, state.board.w);
      if (!isShown) return refuse('You cannot see that piece.');
      const isMine = state.identity.by !== null && token.owner === state.identity.by;
      const kindLabel = token.kind === 'pc' ? 'Player character' : 'Creature';
      const ownerLabel = isMine ? 'yours' : token.owner ? "another player's" : token.kind === 'pc' ? 'free seat' : 'run by the game master';
      parts.openSheet(ui, { token, sheet: sheetOf(id), caption: `${kindLabel} · ${ownerLabel}`, canEdit: canControl(token), isGm: viewer().isGm, gmNotes: gmNotes.of('piece:' + id) }, {
        onGmNotes: (text) => gmNotes.keep('piece:' + id, text),
        onToken: (fields) => put(KEYS.token(id), { ...tokenOf(id), ...fields }),
        onSheet: (sheet) => put(KEYS.sheet(id), sheet),
        onRoll: (notation, label) => rollDice(notation, label, id),
        onRemove() {
          if (put(KEYS.token(id), undefined)) rememberEdit();
        },
      });
    }

    /** On a hosted table, a player with no piece is offered the free player characters once. */
    function offerSeatIfNeeded() {
      const free = tabletop.tokensOf(state.seat.net).filter(([, token]) => token.kind === 'pc' && token.owner === null);
      const isPlayerWithoutPiece = !!state.hosted && !state.identity.isGm() && state.identity.by !== null && !myTokenIds().length;
      if (state.hasOfferedSeat || !isPlayerWithoutPiece || !free.length) return;
      state.hasOfferedSeat = true;
      const options = [...free.map(([, token]) => ({ title: token.name, desc: `${token.hp} of ${token.hpMax} hit points`, color: token.color })), { title: 'Just watch', desc: 'Follow the table without a piece.' }];
      ui.choose({ title: 'Take a seat', sub: 'Pick a character to play.', options }).then((choice) => {
        const picked = free[choice];
        if (!picked) return;
        // Claim the seat as it is now: someone else may have taken it while the list was open.
        const [id] = picked, latest = tokenOf(id);
        if (latest && put(KEYS.token(id), { ...latest, owner: state.identity.by }, 'That seat was just taken.')) selectAndShow(id);
      });
    }

    // ---- presence ----

    /** Queue fields of this player's presence; they are sent together at most every PLAY.PRESENCE_SECONDS. */
    const sharePresence = (patch) => Object.assign(state.presencePatch, patch);
    function flushPresence(dt) {
      state.presenceTimer -= dt;
      if (state.presenceTimer > 0) return;
      state.presenceTimer = PLAY.PRESENCE_SECONDS;
      const at = pointerCells();
      if (at && (!state.lastCursor || Kit.line.dist(at, state.lastCursor) > 0.02)) {
        state.lastCursor = at;
        sharePresence({ cursor: [at.x, at.y] });
      }
      if (!Object.keys(state.presencePatch).length) return;
      state.seat.net.presence({ ...state.presencePatch, scene: state.sceneId });
      state.presencePatch = {};
    }

    // ---- sitting down at a table ----

    function leaveTable() {
      state.stopListening.forEach((stop) => stop());
      state.bots.forEach((bot) => bot.close());
      if (state.seat) state.seat.net.close();
      saveToDevice();
      [pieces, cursors, inkLines, rulerLines, areaTints, dice, boardView].forEach((view) => view.clear());
      pathPreview.hide();
      Object.assign(state, { seat: null, hosted: null, stopListening: [], bots: [], peers: [], heldByPeers: new Set(), inkSeen: new Map(), myStrokes: [], selectedId: null, gesture: null, board: null, sceneId: null, area: null, isFirstLight: true, explored: new Uint8Array(0), exploredByScene: new Map(), memory: null });
      state.tableEpoch++;
    }
    /**
     * Start using a seat: listen to it and redraw everything from it.
     * @param {Object} seat      from Kit.tabletop.seat()
     * @param {Object} identity  { by, isGm(), name, color }
     */
    function sitDown(seat, identity) {
      state.seat = seat;
      state.identity = identity;
      const { net } = seat;
      state.stopListening = [
        net.on('', (key) => {
          state.hasUnsavedChanges = true;
          markDirty(...(DIRTY_BY_KEY_KIND[tabletop.splitKey(key).kind] || []));
        }),
        net.onEvent('roll', showRoll),
        net.onEvent('ping', showPing),
        net.onPeers(showPeers),
      ];
      net.presence({ name: identity.name, color: identity.color });
      markDirty(...REFRESH_ORDER);
      chooseTool('move');
    }
    /** Lay out the starter campaign (game masters, on an empty table). */
    function layStarterScene(owners) {
      tabletop.starterEntries(owners).forEach(([key, value]) => put(key, value));
    }
    /** Cells across the screen at the opening zoom: a wide screen shows proportionally more, so pieces keep their size. */
    const openingCellsAcross = () => CAMERA.START_CELLS_ACROSS * Math.max(1, ctx.size.aspect);
    const openingDistance = () => math.clamp(ctx.distanceForWidth(openingCellsAcross()), CAMERA.MIN_DISTANCE, CAMERA.MAX_DISTANCE);
    /** Point the camera at the middle of what this viewer can see (or at their party, or the board) at the opening distance. */
    function frameTable() {
      refresh(); // the board and its light must exist before cells can be mapped to the world
      // Under fog the lit area is the natural frame; with the whole board lit, the party is.
      const isFogOn = !!state.board && scene().fog;
      const party = state.board ? tabletop.eyesOf(tokens(), { by: state.identity.by, isGm: false }) : [];
      const lit = !state.board ? [] : isFogOn || !party.length ? state.board.find((terrain, x, y) => isCellInView({ x, y })) : party;
      const middleOf = (values) => (Math.min(...values) + Math.max(...values)) / 2;
      const at = lit.length ? space.toWorld(middleOf(lit.map((cell) => cell.x)), middleOf(lit.map((cell) => cell.y))) : { x: 0, z: 0 };
      state.focus = { x: at.x - (ctx.size.portrait ? 0 : openingCellsAcross() * CAMERA.LANDSCAPE_SHIFT), z: at.z };
      state.distance = state.distanceGoal = openingDistance();
      state.shouldFrame = false;
      placeCamera();
    }

    /** Text of an explored mask for storage ("0110..."), and back. */
    const EXPLORED_TEXT = { pack: (mask) => Array.from(mask).join(''), unpack: (text) => Uint8Array.from(String(text), (character) => (character === '1' ? 1 : 0)) };
    /** Write what should survive a reload to this device: the solo campaign, and what this viewer has explored. */
    function saveToDevice() {
      if (!state.hasUnsavedChanges || !state.seat) return;
      state.hasUnsavedChanges = false;
      if (state.memory) state.memory.flush();
      ctx.save.set(SAVED.EXPLORED, Object.fromEntries([...state.exploredByScene].map(([sceneId, mask]) => [sceneId, EXPLORED_TEXT.pack(mask)])));
    }
    const loadExplored = () => new Map(Object.entries(ctx.save.get(SAVED.EXPLORED, {})).map(([sceneId, text]) => [sceneId, EXPLORED_TEXT.unpack(text)]));

    /** Open the table kept on this device (laying out the starter campaign the first time) with two scripted players. */
    function openLocalTable() {
      const hub = Kit.net.loopback({ store: true });
      const memory = Kit.net.remember(hub, ctx.save, SAVED.CAMPAIGN);
      const identity = { by: LOCAL.YOU.by, isGm: () => true, name: LOCAL.YOU.name, color: LOCAL.YOU.color };
      const seat = tabletop.seat(localTransport(hub, identity.by), identity);
      const epoch = state.tableEpoch;
      // The session reads the remembered campaign asynchronously; nothing is drawn or seeded before it has.
      seat.net.ready.then(() => {
        if (epoch !== state.tableEpoch) return seat.net.close();
        state.isGmView = false; // open in the player's view so the fog is seen first; the GM view is one key away
        sitDown(seat, identity);
        state.memory = memory;
        state.exploredByScene = loadExplored();
        // A remembered campaign is drawn as it was left; the first visit lays out the starter.
        if (!tabletop.activeSceneId(read)) layStarterScene(Object.fromEntries([LOCAL.YOU, ...LOCAL.BOTS].map((player) => [player.tokenId, player.by])));
        state.bots = LOCAL.BOTS.map((profile) => scriptedPlayer(hub, profile));
        frameTable();
      });
    }
    /** Move from the local table to the hosted one. */
    async function openHostedTable(transport) {
      const epoch = state.tableEpoch;
      const me = transport.me;
      const identity = { by: me.by, isGm: me.isAdmin, name: me.name || 'You', color: /^#[0-9a-f]{6}$/i.test(me.color) ? me.color : DEFAULT_PLAYER_COLOR };
      const seat = tabletop.seat(transport, identity);
      await seat.net.ready;
      if (epoch !== state.tableEpoch) return seat.net.close(); // the game was closed while the table loaded
      leaveTable();
      state.hosted = transport;
      state.exploredByScene = loadExplored();
      state.isGmView = identity.isGm();
      seat.net.autoTick(); // keeps messages flowing while a sheet is open and the game loop is paused
      sitDown(seat, identity);
      state.stopListening.push(transport.onState(() => markDirty('hud')));
      if (identity.isGm()) {
        if (!tabletop.activeSceneId(read)) layStarterScene({});
        if (identity.by) put(KEYS.gm(identity.by), 1);
      }
      frameTable();
      ui.toast(identity.isGm() ? 'Table is live' : 'Joined the table');
    }

    openLocalTable();
    ctx.on('resize', () => (state.distanceGoal = openingDistance())); // turning the phone keeps pieces the same size
    Kit.net.claude({ table: HOSTED_TABLE }).then((transport) => transport && openHostedTable(transport));

    return {
      update(dt, time) {
        if (!state.seat) return;
        state.bots.forEach((bot) => bot.update(dt));
        state.seat.net.tick(dt);
        refresh();
        if (state.shouldFrame) frameTable();
        state.saveTimer -= dt;
        if (state.saveTimer <= 0) (state.saveTimer = PLAY.SAVE_SECONDS), saveToDevice();
        if (state.followTarget) {
          state.focus.x = math.damp(state.focus.x, state.followTarget.x, CAMERA.FOLLOW_RATE, dt);
          state.focus.z = math.damp(state.focus.z, state.followTarget.z, CAMERA.FOLLOW_RATE, dt);
        }
        state.distance = math.damp(state.distance, state.distanceGoal, CAMERA.ZOOM_RATE, dt);
        placeCamera();
        boardView.update(dt);
        pieces.update(dt, time);
        cursors.update(dt);
        dice.update(dt);
        flushPresence(dt);
      },
      dispose: leaveTable,
    };
  }

  Kit.register({
    id: 'table',
    name: 'Lampwick Table',
    tagline: 'A shared tabletop: move, roll, reveal',
    hook: 'Scenes, fog, dice and turns: run a session, alone or together',
    color: '#f472b6',
    order: 11,
    theme: parts.theme,
    create,
  });
})();
