// Kit net-claude: a Kit.net transport for a page published as a claude.ai Artifact. No server of your own, nothing to configure.
//
// The few-lines way (hosted when the platform is there, a working single-player table when it is not):
//   const table = await Kit.net.open({ table: 'friday-game', validate });
//   table.net.set('score/' + table.me.by, 3);
//   table.net.on('score/', (key, value, from) => draw(key, value));
// The transport alone, when a game manages its own sessions:
//   const transport = await Kit.net.claude({ table: 'friday-game' });   // null when the page is not hosted there
//   const net = Kit.net.session(transport || localTransport, { validate, rate: transport ? transport.rate : undefined });
//
// Owns:  mapping the Kit.net transport contract onto the platform's `room`, `db` and `user` capabilities (reached only
//        through `await claude.use(name)`), the exact `capabilities` object the page must be published with
//        (Kit.net.claude.capabilities), and telling the game who the viewer is and what they may do.
// Does not own: game rules (the session's `validate`), conflict resolution (the session), or any UI.
//
// HOW IT IS WIRED
//   Fast path   one named room per table (room.join), two topics. Low latency, lossy, never replayed.
//                 kn.a  admin-only: the platform refuses it to anyone below Editor, so a message heard on it is proof
//                       that its sender is a game master. Senders get { admin: true }.
//                 kn.p  opened to "interact": what Contributors send. Senders get { admin: false }.
//               If named rooms are refused the lobby room is used instead and messages carry the table name.
//   Durable path  one db document per key, holding the entry and its version. Late joiners load it; dropped fast
//               messages are healed by it (onSnapshot). Where a document lives says who wrote it:
//                 kn-gm/<table>/k/<key>       writable by Editors and the owner only  -> sender { admin: true }
//                 kn-own/<userId>/<table>/<key>  writable by that user only ({self})   -> sender { by: userId }
//               Stored entries are delivered through the same path as live messages, so the session's `validate` runs
//               on them with a sender the platform vouches for. kn-own/<userId> itself is a small document listing
//               the tables that user has written to, which is how other players discover whose keys to read.
//   Identity    always from the platform's stamp ({ peer, by, isMe, sameTab, guest }) or from the document's location,
//               never from anything inside a message or a document.
//
// WHO IS WHO (share-menu level -> role here)
//   Owner, Editor   game master: user.canEdit() is true. Sends on kn.a and writes kn-gm, so every screen sees
//                   { admin: true } on what they do. Several Editors are co-GMs.
//   Contributor     player: sends on kn.p and writes only their own kn-own subtree. What a player may change is the
//                   game's `validate` (for example "move only a token you own"); the platform already guarantees which
//                   user a change came from.
//   Viewer, Commenter  spectator: receives everything live and reads the stored table, and may show a cursor (presence
//                   is open to everyone in the room), but every send and every write is refused by the platform. The
//                   transport notices the first refusal, reports role "viewer" and stops trying.
//   Signed out, or arrived by public link without being admitted: cannot join the room; sees the stored table if the
//                   platform lets them read it at all. The page still works as a single-player table.
//
// LIMITS (the platform's, surfaced as Kit.net.claude.LIMITS)
//   A message is at most 4 KiB of JSON. Emits and presence share about 40 messages a second per viewer, so the session
//   is asked to send at most 20 a second and presence is flushed at most 10 times a second. Fast messages may be dropped
//   and are never replayed. Everyone in the room receives everything: fog of war and hidden tokens are a courtesy of
//   honest clients, not secrecy. Up to 60 players' subtrees are followed per table (the 64-listener cap).
(() => {
  /** Room topics. Only OPEN is declared in the capabilities; an undeclared topic stays admin-only, which is the point. */
  const TOPICS = { ADMIN: 'kn.a', OPEN: 'kn.p' };

  /** Document store layout: where game-master entries and each player's own entries live. */
  const PATHS = {
    GM_ROOT: 'kn-gm',
    /** Name of the collection of key documents under kn-gm/<table>. */
    GM_KEYS: 'k',
    OWN_ROOT: 'kn-own',
  };

  /** Platform budgets this transport is built around. */
  const LIMITS = {
    /** Largest JSON text of one room message, in UTF-8 bytes. */
    MESSAGE_BYTES: 4096,
    /** What the session's size estimate is held to; leaves room for the table tag added on the lobby. */
    SESSION_MAX_BYTES: 4000,
    /** Messages a second the session may emit (the platform budget of about 40 is shared with presence). */
    MESSAGES_PER_SECOND: 20,
    /** Presence flushes a second. */
    PRESENCE_PER_SECOND: 10,
    /** Longest document id the store accepts, in bytes. */
    DOCUMENT_ID_BYTES: 200,
    /** Player subtrees followed per table: the store allows 64 listeners per view; two are used for shared data. */
    WATCHED_PLAYERS: 60,
    /** Longest table name: a room name is at most 48 characters and the prefix "kn-" takes three. */
    TABLE_NAME_LENGTH: 40,
  };

  /** Default timings in milliseconds; every one can be overridden through connect() options (tests use short ones). */
  const TIMING = {
    /** Writes to the same document within this window collapse into one. */
    saveDelayMs: 150,
    presenceDelayMs: 1000 / LIMITS.PRESENCE_PER_SECOND,
    /** How long the first load may take before the game starts with whatever has arrived. */
    loadTimeoutMs: 6000,
    /** Wait before re-joining a lost room, multiplied by the attempt number. */
    rejoinDelayMs: 2000,
    /** Wait before retrying a write the store called transiently unavailable. */
    retryWriteDelayMs: 800,
  };
  /** Re-join attempts after a named room is lost before the fast path is given up for this page load. */
  const REJOIN_ATTEMPTS = 3;

  /**
   * The capabilities this page must be published with. Anything looser lets players write game-master data;
   * anything stricter stops players from playing.
   */
  const capabilities = {
    room: { topics: { [TOPICS.OPEN]: 'interact' } },
    db: {
      rules: [
        // Nothing is writable below Editor unless a rule further down says so.
        { path: '', read: 'view', write: 'admin' },
        { path: PATHS.GM_ROOT, read: 'view', write: 'admin' },
        // Everyone reads every player's entries; Editors may tidy them; each player writes only their own subtree.
        { path: PATHS.OWN_ROOT, read: 'view', write: 'admin' },
        { path: `${PATHS.OWN_ROOT}/{self}`, write: 'interact' },
      ],
    },
    // "profile" lets cursors and roll announcements show names resolved by the platform instead of typed ones.
    user: { scopes: ['profile'] },
  };

  /** Roles from most to least able; a role only ever moves down this list during a page load. */
  const ROLE_ORDER = ['gm', 'player', 'viewer'];
  /** Error codes after which a room (or the whole room capability) will never work again on this page load. */
  const TERMINAL_ROOM_CODES = new Set(['revoked', 'not_granted', 'capability_disabled', 'capability_removed', 'transform_error']);

  // ---- pure helpers ------------------------------------------------------------------------------------------------

  /**
   * UTF-8 byte length of a string, without needing TextEncoder.
   * @param {string} text
   * @returns {number}
   */
  function utf8Length(text) {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) (bytes += 4), index++; // a surrogate pair is one 4-byte character
      else bytes += 3;
    }
    return bytes;
  }

  /**
   * Turn a session key into a legal document id. The store allows letters, digits and a few marks in a path segment,
   * so "/" becomes ":" and any other character becomes "~" plus its four-digit hex code. The mapping is one-to-one
   * (":" and "~" in a key are themselves escaped) and the "k" prefix keeps ids from being "." or "..".
   * @param {string} key  for example "token/t1"
   * @returns {string|null} for example "ktoken:t1", or null when the id would be too long for the store
   */
  function documentIdOf(key) {
    const id = 'k' + key.replace(/[^A-Za-z0-9_.-]/g, (character) => (character === '/' ? ':' : '~' + character.charCodeAt(0).toString(16).padStart(4, '0')));
    return id.length <= LIMITS.DOCUMENT_ID_BYTES ? id : null;
  }

  /**
   * Make any text a legal table name (it is used as a room name and as a path segment): lower case letters, digits,
   * "_", "." and "-", starting with a letter or digit. Runs of anything else become one "-".
   * @param {string} table
   * @returns {string}
   * @example Kit.net.claude.tableNameOf('Friday Game!') // "friday-game"
   */
  const tableNameOf = (table) => String(table).toLowerCase().replace(/[^a-z0-9_.]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, LIMITS.TABLE_NAME_LENGTH) || 'main';

  /**
   * The role a viewer starts with, from what the platform says about them.
   * @param {{canEdit: boolean}|null} viewer  from user.me(); null when the user capability is unavailable
   * @param {boolean|null} canWriteData       user.can('data.write'); null means the platform said nothing
   * @returns {'gm'|'player'|'viewer'}
   */
  const startingRole = (viewer, canWriteData) => (viewer && viewer.canEdit ? 'gm' : canWriteData === false ? 'viewer' : 'player');

  /**
   * The sender a session sees for a live room message. `isMe` is narrowed to "this very tab": the same person's other
   * tab is a separate session whose messages must not be skipped as echoes.
   * @param {Object} stamp     the platform's stamp on a delivered message or peer
   * @param {boolean} isAdmin  true when it arrived on the admin-only topic
   */
  const senderOf = (stamp, isAdmin) => ({
    peer: stamp.peer,
    by: stamp.by || null,
    isMe: !!(stamp.isMe && stamp.sameTab),
    isSamePerson: !!stamp.isMe,
    admin: isAdmin,
    guest: !!stamp.guest,
    kind: stamp.kind || 'viewer',
  });

  /** A roster row for session.onPeers, from one platform peer. */
  const peerOf = (platformPeer) => ({ ...senderOf(platformPeer, false), presence: platformPeer.presence || {}, updatedAt: platformPeer.updatedAt });

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const cloneJson = (value) => JSON.parse(JSON.stringify(value));

  /**
   * A set of callbacks: add one (returns its remover) and call them all.
   * @returns {{add: function(Function): function(): void, call: function(...*): void}}
   */
  function listeners() {
    const callbacks = new Set();
    return {
      add(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      call: (...values) => [...callbacks].forEach((callback) => callback(...values)),
    };
  }

  /**
   * Counts tasks that must finish before "the first load is done". `enter()` returns that task's `leave`; `done`
   * resolves when every entered task has left. Tasks entered after that are ignored.
   */
  function loadGate() {
    let openTasks = 0, resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    return {
      done,
      enter() {
        openTasks++;
        let hasLeft = false;
        return () => {
          if (hasLeft) return;
          hasLeft = true;
          if (--openTasks === 0) resolveDone();
        };
      },
    };
  }

  /**
   * Writes "the latest body per id", never two at once for the same id (the store slows down on overlapping writes to
   * one document) and never more often than every `delayMs` per id (a burst of changes becomes one write).
   * @param {Object} options
   * @param {number} options.delayMs
   * @param {function(string, Object): Promise<void>} options.write   performs one write
   * @param {function(*, string, Object): void} options.onError       called with (error, id, body) when a write rejects
   * @returns {{put: function(string, Object): void, cancel: function(): void}}
   */
  function coalescingWriter({ delayMs, write, onError }) {
    const latestBody = new Map(), timers = new Map(), inFlight = new Set();
    function flush(id) {
      timers.delete(id);
      if (inFlight.has(id) || !latestBody.has(id)) return; // the write in flight will pick up the newer body when it lands
      const body = latestBody.get(id);
      latestBody.delete(id);
      inFlight.add(id);
      Promise.resolve()
        .then(() => write(id, body))
        .catch((error) => onError(error, id, body))
        .then(() => {
          inFlight.delete(id);
          if (latestBody.has(id)) flush(id);
        });
    }
    return {
      put(id, body) {
        latestBody.set(id, body);
        if (!timers.has(id)) timers.set(id, setTimeout(() => flush(id), delayMs));
      },
      cancel() {
        timers.forEach(clearTimeout);
        timers.clear();
        latestBody.clear();
      },
    };
  }

  // ---- the viewer's role -------------------------------------------------------------------------------------------

  /**
   * Who the viewer is and what they may currently do. The role starts from what the platform reports and is lowered
   * when the platform refuses something (the platform, not this page, is the authority).
   * @param {Object|null} viewer        user.me() result
   * @param {boolean|null} canWriteData
   * @param {function(): void} onChange called after the role is lowered
   */
  function viewerIdentity(viewer, canWriteData, onChange) {
    let role = startingRole(viewer, canWriteData);
    return {
      by: (viewer && viewer.id) || null,
      name: (viewer && viewer.name) || '',
      color: (viewer && viewer.color) || '',
      isOwner: !!(viewer && viewer.isOwner),
      role: () => role,
      isAdmin: () => role === 'gm',
      /** Lower the role; a request to raise it is ignored. */
      demoteTo(lowerRole) {
        if (ROLE_ORDER.indexOf(lowerRole) <= ROLE_ORDER.indexOf(role)) return;
        role = lowerRole;
        onChange();
      },
    };
  }

  // ---- fast path: the room -----------------------------------------------------------------------------------------

  /**
   * The live channel for one table.
   * @param {Object} options
   * @param {Object} options.lobby            the `room` capability namespace
   * @param {string} options.tableName
   * @param {Object} options.identity         from viewerIdentity()
   * @param {function(Object, Object): void} options.deliver   (message, sender) for every message heard
   * @param {function(): void} options.onChange                called when availability or connection changes
   * @param {Object} options.timing
   */
  function fastPath({ lobby, tableName, identity, deliver, onChange, timing }) {
    const peerListeners = listeners();
    let room = null; // the joined room (or the lobby); null while there is none
    let isOnLobby = false, isConnected = false, isGivenUp = false, isClosed = false;
    let rejoinAttempts = 0, errorCode = null, droppedOversize = 0;
    let roster = [], stopListening = [];
    let pendingPresence = null, presenceTimer = null;

    const belongsHere = (data) => !isOnLobby || data.tb === tableName;
    const hear = (isAdmin) => (message) => {
      const data = message && message.data;
      if (data && typeof data === 'object' && belongsHere(data)) deliver(data, senderOf(message, isAdmin));
    };
    function hearPeers(change) {
      roster = change.peers.filter((peer) => belongsHere(peer.presence || {})).map(peerOf);
      peerListeners.call(roster);
    }

    function detach() {
      stopListening.forEach((stop) => stop());
      stopListening = [];
      room = null;
      isConnected = false;
    }
    /** Every listener of a lost room reports the loss once; only the first report acts. */
    function lose(lostRoom, error) {
      if (room !== lostRoom || isClosed) return;
      detach();
      errorCode = (error && error.code) || 'upstream_error';
      const canRetry = !TERMINAL_ROOM_CODES.has(errorCode) && errorCode !== 'not_permitted' && rejoinAttempts < REJOIN_ATTEMPTS;
      if (canRetry) setTimeout(open, timing.rejoinDelayMs * ++rejoinAttempts);
      else isGivenUp = true;
      onChange();
    }
    function attach(joinedRoom, usesLobby) {
      room = joinedRoom;
      isOnLobby = usesLobby;
      const onError = (error) => lose(joinedRoom, error);
      stopListening = [
        joinedRoom.on(TOPICS.ADMIN, hear(true), onError),
        joinedRoom.on(TOPICS.OPEN, hear(false), onError),
        joinedRoom.onPeers(hearPeers, onError),
        joinedRoom.onConnection((connected) => {
          isConnected = connected;
          if (connected) rejoinAttempts = 0;
          onChange();
        }, onError),
      ];
    }
    /** Join the table's named room; fall back to the shared lobby when named rooms are refused. */
    async function open() {
      if (isClosed || room) return;
      try {
        attach(await lobby.join('kn-' + tableName), false);
      } catch (error) {
        const code = error && error.code;
        if (code === 'not_permitted') attach(lobby, true);
        else if (TERMINAL_ROOM_CODES.has(code) || rejoinAttempts >= REJOIN_ATTEMPTS) (isGivenUp = true), (errorCode = code || 'upstream_error');
        else setTimeout(open, timing.rejoinDelayMs * ++rejoinAttempts);
      }
      onChange();
    }

    /** Emit one session message on the topic the viewer's role allows; lower the role if the platform refuses. */
    function send(message) {
      if (!room || identity.role() === 'viewer') return;
      const data = isOnLobby ? { ...message, tb: tableName } : message;
      if (utf8Length(JSON.stringify(data)) > LIMITS.MESSAGE_BYTES) {
        droppedOversize++; // a "set" this large still reaches everyone through the durable path
        return;
      }
      const wasAdmin = identity.isAdmin();
      room.emit(wasAdmin ? TOPICS.ADMIN : TOPICS.OPEN, data).catch((error) => {
        if (!error || error.code !== 'not_permitted') return; // transient failures are healed by the durable path
        identity.demoteTo(wasAdmin ? 'player' : 'viewer');
        if (wasAdmin) send(message); // not an Editor after all: say it again as a player
      });
    }

    function flushPresence() {
      presenceTimer = null;
      const patch = pendingPresence;
      pendingPresence = null;
      if (room && patch) room.presence(isOnLobby ? { ...patch, tb: tableName } : patch).catch(() => {});
    }
    /** Merge a patch into what will be sent at the next flush, so pointer-rate calls cost one message per flush. */
    function setPresence(patch) {
      pendingPresence = { ...(pendingPresence || {}), ...patch };
      if (!presenceTimer) presenceTimer = setTimeout(flushPresence, timing.presenceDelayMs);
    }

    return {
      open,
      send,
      setPresence,
      onPeers(callback) {
        callback(roster);
        return peerListeners.add(callback);
      },
      status: () => ({ isLive: !!room && !isGivenUp, isConnected, errorCode, droppedOversize }),
      close() {
        isClosed = true;
        clearTimeout(presenceTimer);
        const leaving = room && !isOnLobby ? room : null;
        detach();
        if (leaving) leaving.leave().catch(() => {});
      },
    };
  }

  // ---- durable path: the document store ----------------------------------------------------------------------------

  /**
   * The stored table: one document per key, split by who may write it.
   * @param {Object} options
   * @param {Object} options.db               the `db` capability namespace
   * @param {string} options.tableName
   * @param {Object} options.identity         from viewerIdentity()
   * @param {function(Object, Object): void} options.deliver   (message, sender) for every stored entry seen
   * @param {function(string): void} options.onProblem         called with a store error code worth showing
   * @param {Object} options.timing
   * @returns {{subscribe: function(): void, load: function(): Promise<Array>, save: function(string, Object): void, close: function(): void}}
   */
  function durableStore({ db, tableName, identity, deliver, onProblem, timing }) {
    const gmKeys = db.doc(`${PATHS.GM_ROOT}/${tableName}`).collection(PATHS.GM_KEYS);
    const playerKeys = (userId) => db.doc(`${PATHS.OWN_ROOT}/${userId}`).collection(tableName);
    const rosterCollection = db.collection(PATHS.OWN_ROOT);
    const gate = loadGate();
    const watchedPlayers = new Set();
    const stopWatching = [];
    let isSubscribed = false, rosterPromise = null;

    /** Hand one stored document to the session as if it had just been heard, with a sender derived from where it lives. */
    function deliverStored(body, whoWroteIt) {
      if (!body || typeof body.k !== 'string' || !Kit.net.isSaneEntry(body.e)) return;
      deliver({ t: 'set', k: body.k, e: cloneJson(body.e) }, { peer: body.e.ver[1], isMe: false, stored: true, ...whoWroteIt });
    }
    function watch(collection, whoWroteIt) {
      const leaveGate = gate.enter();
      stopWatching.push(
        collection.onSnapshot(
          (snapshot) => {
            snapshot.docChanges().filter((change) => change.type !== 'removed').forEach((change) => deliverStored(change.doc.data(), whoWroteIt));
            leaveGate();
          },
          (error) => {
            onProblem(error && error.code);
            leaveGate();
          }
        )
      );
    }
    function watchPlayer(userId) {
      if (watchedPlayers.has(userId) || watchedPlayers.size >= LIMITS.WATCHED_PLAYERS) return;
      watchedPlayers.add(userId);
      watch(playerKeys(userId), { by: userId, admin: false });
    }
    /** Follow the roster: every user who has written to this table gets their subtree watched. */
    function watchRoster() {
      const leaveGate = gate.enter();
      stopWatching.push(
        rosterCollection.onSnapshot(
          (snapshot) => {
            snapshot.docs.filter((document) => ((document.data() || {}).tables || {})[tableName]).forEach((document) => watchPlayer(document.id));
            leaveGate(); // after the players' watches have entered the gate, so the load waits for them too
          },
          (error) => {
            onProblem(error && error.code);
            leaveGate();
          }
        )
      );
    }

    /** Make sure this user's roster document lists this table, once per page load, before their first own write. */
    function ensureListedInRoster() {
      if (rosterPromise) return rosterPromise;
      const rosterDocument = rosterCollection.doc(identity.by);
      rosterPromise = rosterDocument.get().then((snapshot) => {
        const body = (snapshot.exists && snapshot.data()) || {};
        const tables = body.tables || {};
        return tables[tableName] ? undefined : rosterDocument.set({ ...body, tables: { ...tables, [tableName]: 1 } });
      });
      // A failed attempt must not poison later writes: forget it so the next write tries again.
      rosterPromise.catch(() => (rosterPromise = null));
      return rosterPromise;
    }
    /** Write one key document where the viewer's role allows: game masters to the shared space, players to their own. */
    function writeDocument(documentId, body) {
      if (identity.isAdmin()) return gmKeys.doc(documentId).set(body);
      if (identity.role() !== 'player' || !identity.by) return Promise.resolve(); // spectators and viewers without an id store nothing
      return ensureListedInRoster().then(() => playerKeys(identity.by).doc(documentId).set(body));
    }
    const writer = coalescingWriter({
      delayMs: timing.saveDelayMs,
      write: writeDocument,
      onError(error, documentId, body) {
        const code = error && error.code;
        if (code === 'invalid_argument') {
          // Refused: the viewer is a level lower than believed. A demoted game master retries as a player.
          const wasAdmin = identity.isAdmin();
          identity.demoteTo(wasAdmin ? 'player' : 'viewer');
          if (wasAdmin) writer.put(documentId, body);
        } else if (code === 'unavailable') setTimeout(() => writer.put(documentId, body), timing.retryWriteDelayMs);
        else onProblem(code);
      },
    });

    return {
      subscribe() {
        if (isSubscribed) return;
        isSubscribed = true;
        watch(gmKeys, { by: null, admin: true });
        if (identity.by) watchPlayer(identity.by);
        watchRoster();
      },
      // Entries arrive through `deliver` as the listeners answer, so there is nothing to hand back: loading means
      // waiting until the first answers are in (or long enough that the game should start regardless).
      load: () => Promise.race([gate.done, wait(timing.loadTimeoutMs)]).then(() => []),
      save(key, entry) {
        const documentId = documentIdOf(key);
        if (documentId && identity.role() !== 'viewer') writer.put(documentId, { k: key, e: entry });
      },
      close() {
        writer.cancel();
        stopWatching.forEach((stop) => stop());
      },
    };
  }

  // ---- the transport -----------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} ConnectionState
   * @property {string} table
   * @property {'gm'|'player'|'viewer'} role
   * @property {boolean} isLive        the room is joined (messages travel in real time)
   * @property {boolean} isConnected   the room reports a live connection right now
   * @property {boolean} isDurable     the document store is in use (the table survives everyone leaving)
   * @property {string|null} errorCode last platform error worth showing, if any
   * @property {number} droppedOversize fast messages skipped for exceeding the size limit
   */

  /**
   * Connect to the hosting platform. Resolves a Kit.net transport, or null when the page is not running there or
   * neither the room nor the store is available to this viewer, in which case the game should run single-player.
   * Never rejects.
   * @param {Object} [options]
   * @param {string} [options.table='main']   which table to sit at; anyone using the same name shares it
   * @param {Object} [options.claude]         the platform object; defaults to window.claude (tests pass a fake)
   * @param {number} [options.saveDelayMs] @param {number} [options.presenceDelayMs] @param {number} [options.loadTimeoutMs]
   * @param {number} [options.rejoinDelayMs] @param {number} [options.retryWriteDelayMs]   see TIMING
   * @returns {Promise<Object|null>} transport: the Kit.net contract (id, send, onMessage, maxBytes, presence, onPeers,
   *   store?, close) plus `rate` (messages a second to give the session), `me` ({ by, name, color, isOwner, role(), isAdmin() }),
   *   `state()` -> ConnectionState, `onState(fn)` -> unsubscribe, and `profiles(ids)` -> Promise of platform profiles by id.
   */
  async function connect({ table = 'main', claude = typeof window !== 'undefined' ? window.claude : undefined, ...timingOverrides } = {}) {
    if (!claude || typeof claude.use !== 'function') return null;
    // use() resolves null for anything unavailable; a throwing or rejecting host is treated the same way.
    const use = (name) => Promise.resolve().then(() => claude.use(name)).catch(() => null);
    const [lobby, db, user] = await Promise.all([use('room'), use('db'), use('user')]);
    if (!lobby && !db) return null;

    const timing = { ...TIMING, ...timingOverrides };
    const tableName = tableNameOf(table);
    const [viewer, canWriteData] = user ? await Promise.all([user.me(), user.can('data.write')]) : [null, null];
    const messageListeners = listeners(), stateListeners = listeners();
    let storeErrorCode = null;

    const state = () => {
      const live = liveChannel ? liveChannel.status() : { isLive: false, isConnected: false, errorCode: null, droppedOversize: 0 };
      return { table: tableName, role: identity.role(), isDurable: !!store, ...live, errorCode: live.errorCode || storeErrorCode };
    };
    const announceState = () => stateListeners.call(state());
    const identity = viewerIdentity(viewer, canWriteData, announceState);
    const deliver = (message, sender) => messageListeners.call(message, sender);
    // Live messages get the same version check as stored ones before the session sees them.
    const deliverLive = (message, sender) => (message.t !== 'set' || (typeof message.k === 'string' && Kit.net.isSaneEntry(message.e))) && deliver(message, sender);

    const liveChannel = lobby ? fastPath({ lobby, tableName, identity, deliver: deliverLive, onChange: announceState, timing }) : null;
    const store = db
      ? durableStore({
          db, tableName, identity, deliver, timing,
          onProblem(code) {
            storeErrorCode = code || 'unavailable';
            announceState();
          },
        })
      : null;
    if (liveChannel) await liveChannel.open();

    // The session only needs an id that is unique per open page: it breaks ties between simultaneous writes.
    const id = 'c' + Math.random().toString(36).slice(2, 12);
    const selfRoster = [{ peer: id, by: identity.by, isMe: true, presence: {} }];
    const transport = {
      id,
      maxBytes: LIMITS.SESSION_MAX_BYTES,
      rate: LIMITS.MESSAGES_PER_SECOND,
      me: identity,
      send: (message) => liveChannel && liveChannel.send(message),
      onMessage: (handler) => messageListeners.add(handler),
      presence: (patch) => liveChannel && liveChannel.setPresence(patch),
      // Without a room the roster is just this viewer, so games can always draw "me".
      onPeers: (callback) => (liveChannel ? liveChannel.onPeers(callback) : (callback(selfRoster), () => {})),
      state,
      onState: (callback) => stateListeners.add(callback),
      profiles: (ids) => (user ? user.profiles(ids) : Promise.resolve({})),
      close() {
        if (liveChannel) liveChannel.close();
        if (store) store.close();
      },
    };
    if (store) transport.store = { subscribe: store.subscribe, load: store.load, save: store.save };
    return transport;
  }

  /** Who the player is on a table that exists only on this device: its owner, with every right. */
  const SOLO = { by: 'you', name: 'You' };
  /** How long after a change a solo table is written to storage, so a burst of changes is one write. */
  const SOLO_SAVE_DELAY_MS = 600;

  /**
   * @typedef {Object} OpenTable
   * @property {Object} net            the Kit.net session: set / get / on / emit / presence, already ticking by itself.
   *                                   set / patch / delete return false (and do nothing) when `validate` refuses them.
   * @property {boolean} isHosted      true on the platform; false for the single-player fallback
   * @property {{by: string|null, name: string, isAdmin: function(): boolean}} me   who this player is
   * @property {function(): ConnectionState} state
   * @property {function(function(ConnectionState): void): function(): void} onState
   * @property {function(): void} close
   */
  /**
   * Join a shared table in one call. On the hosting platform this is the hosted table; anywhere else (a local file,
   * a test page, a viewer the platform cannot connect) it is a single-player table with the same interface, so game
   * code never branches. The session ticks itself and is loaded when the promise resolves. Never rejects.
   * @param {Object} [options]
   * @param {string} [options.table='main']        table name; players using the same name share it
   * @param {function(string, *, Object, Object=): boolean} [options.validate]  the rule every screen applies to every
   *   change it hears: (key, value, sender, previousEntry) -> accept? `sender.admin` and `sender.by` come from the platform.
   * @param {{get: Function, set: Function}} [options.storage]  where the single-player table is kept between visits
   *   (Kit.store(name) or a game's ctx.save); omit to forget it on reload. The hosted table is always durable.
   * @param {Object} [options.claude]              the platform object; defaults to window.claude
   * @returns {Promise<OpenTable>}
   * @complexity O(keys) to load; O(1) per write afterwards (O(keys) once per pause when a solo table is saved).
   * @example
   * const table = await Kit.net.open({ validate: (key, value, from) => from.admin || key === 'hand/' + from.by });
   * table.net.set('hand/' + table.me.by, ['7C', 'QH']);
   */
  async function open({ table = 'main', validate, storage, ...connectOptions } = {}) {
    const transport = await connect({ table, ...connectOptions });
    if (transport) {
      const session = Kit.net.session(transport, { validate, rate: transport.rate }).autoTick();
      await session.ready;
      const net = Kit.net.checked(session, validate, () => ({ peer: transport.id, by: transport.me.by, admin: transport.me.isAdmin() }));
      return { net, isHosted: true, me: { by: transport.me.by, name: transport.me.name, isAdmin: transport.me.isAdmin }, state: transport.state, onState: transport.onState, close: () => net.close() };
    }
    const tableName = tableNameOf(table);
    const hub = Kit.net.loopback({ store: !!storage });
    const memory = storage ? Kit.net.remember(hub, storage, 'net:' + tableName) : null;
    const solo = Kit.net.withSender(Kit.net.guarded(hub.join(SOLO.by)), () => ({ admin: true }));
    const session = Kit.net.session(solo, { validate }).autoTick();
    await session.ready;
    const net = Kit.net.checked(session, validate, () => ({ peer: SOLO.by, by: SOLO.by, admin: true }));
    let saveTimer = null;
    const saveSoon = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        memory.flush();
      }, SOLO_SAVE_DELAY_MS);
    };
    if (memory) net.on('', saveSoon);
    return {
      net,
      isHosted: false,
      me: { by: SOLO.by, name: SOLO.name, isAdmin: () => true },
      state: () => ({ table: tableName, role: 'gm', isLive: false, isConnected: false, isDurable: !!storage, errorCode: null, droppedOversize: 0 }),
      onState: () => () => {},
      close() {
        clearTimeout(saveTimer);
        if (memory) memory.flush();
        net.close();
      },
    };
  }
  Kit.net.open = open;

  Kit.net.claude = Object.assign(connect, { capabilities, LIMITS, TOPICS, PATHS, documentIdOf, tableNameOf, utf8Length, coalescingWriter });
})();
