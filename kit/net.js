/**
 * Kit net: multiplayer as a shared key -> value state that every player sees, over any transport.
 *
 *   const net = Kit.net.session(transport, { validate });
 *   net.set('token/t1', { x: 3, y: 4 });          // everyone converges on it (last writer wins, per key)
 *   net.on('token/', (key, value, from) => ...);   // hear a key or a whole prefix, your own writes included
 *   net.emit('roll', { total: 17 });               // a moment: delivered live, never stored
 *   net.presence({ cursor: { x, y } });            // high-rate "me right now" state; net.onPeers(listener)
 *
 * Owns:  the session (state convergence, events, presence pass-through, the rate-limited outbox)
 *        and Kit.net.loopback, the in-memory reference transport used by tests and same-page bots.
 * Does not own: any real network. The session only talks to a Transport (typedef below); the hosted
 *        page's room + database transport lives in net-claude.js and trust wrappers in net-trust.js.
 *        Game code does not change when the transport does.
 *
 * Trust: every peer runs `validate(key, value, sender, previousEntry)` on what it hears and ignores
 * what fails, so rules like "only the GM edits the map, players move only their own token" hold on
 * every screen. The sender is stamped by the transport, never read from the message.
 *
 * No DOM: runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  /**
   * @typedef {[number, string]} Version
   * [Lamport counter, peer id] of the write that produced an entry.
   */

  /**
   * @typedef {Object} Entry
   * One key's state as stored and sent. Field names are short because they travel on the wire.
   * @property {*} [v] the value (absent on a delete)
   * @property {Version} ver
   * @property {1} [del] present when the key was deleted (a tombstone, so the delete can win over older sets)
   */

  /**
   * @typedef {Object} Sender
   * @property {string} peer the sending peer's id
   * @property {string} [by] who that peer acts for (a player name, 'gm'), when the transport knows
   * @property {boolean} [isMe] true for this session's own messages
   * @property {boolean} [stored] true when the entry came from the durable store rather than live
   */

  /**
   * @typedef {{t: 'set', k: string, e: Entry} | {t: 'ev', topic: string, data: *} | {t: 'hello'}} Message
   * The wire protocol: a state write, a live event, or a newcomer asking for the current state.
   */

  /**
   * @typedef {Object} DurableStore
   * The optional durable path: late joiners load it and dropped live messages are healed by it.
   * @property {function(): Promise<Array<[string, Entry]>>} load every stored entry
   * @property {function(string, Entry): (Promise<void>|void)} save store an entry (the store keeps the newer version)
   * @property {function(function(string, Entry): void): void} subscribe hear entries as they are stored
   */

  /**
   * @typedef {Object} Transport
   * The fast path: low latency, may drop messages, replays nothing. See Kit.net.loopback for the reference one.
   * @property {string} id this peer's id
   * @property {function(Message): void} send deliver to every peer, this one included
   * @property {function(function(Message, Sender): void): void} onMessage hear messages; the transport stamps the sender
   * @property {number} [maxBytes] largest message it carries
   * @property {function(Object): void} [presence] merge fields into this peer's presence
   * @property {function(function(Array): void): function(): void} [onPeers] hear the roster; returns unsubscribe
   * @property {function(): void} [close]
   * @property {DurableStore} [store]
   */

  /** Default outgoing messages per second, and the size of the burst allowance. */
  const DEFAULT_SEND_RATE = 20;
  /** Default autoTick period in milliseconds. */
  const DEFAULT_TICK_MS = 50;
  const MS_PER_SECOND = 1000;
  /** Safety factor from JSON characters to bytes: generous for mostly-ASCII JSON, so the guard errs on the safe side. */
  const BYTES_PER_CHAR = 1.1;
  /** Message size limit of the loopback transport, chosen to resemble a real one. */
  const LOOPBACK_MAX_BYTES = 4096;

  /**
   * The Lamport version rule that makes every peer converge: an entry replaces what is held when
   * its counter is higher, and when two peers wrote with the same counter (concurrent writes) the
   * higher peer id wins. Both comparisons are the same on every screen, so everyone picks the
   * same winner whatever order the messages arrive in.
   * @param {Version} candidate
   * @param {Version} [current] the held version; anything is newer than nothing
   * @returns {boolean}
   */
  const newer = (candidate, current) => {
    if (!current) return true;
    const [candidateCounter, candidatePeer] = candidate;
    const [currentCounter, currentPeer] = current;
    return candidateCounter > currentCounter || (candidateCounter === currentCounter && candidatePeer > currentPeer);
  };

  const estimateBytes = (message) => JSON.stringify(message).length * BYTES_PER_CHAR;
  const hasVersion = (entry) => Boolean(entry) && Array.isArray(entry.ver);
  const valueOf = (entry) => (entry.del ? undefined : entry.v);
  /** Copy through JSON, as a real transport or database would. */
  const serialise = (data) => JSON.parse(JSON.stringify(data));

  /** Does a changed key match a subscription: everything (''), the exact key, or a prefix ending in '/'? */
  const matchesKey = (keyOrPrefix, key) => keyOrPrefix === '' || key === keyOrPrefix || (keyOrPrefix.endsWith('/') && key.startsWith(keyOrPrefix));

  /**
   * Opens a session over a transport.
   * @param {Transport} transport
   * @param {Object} [options]
   * @param {function(string, *, Sender, Entry=): boolean} [options.validate] run on every entry heard live;
   *   false ignores it. Gets (key, value or undefined for a delete, sender, the entry held before).
   * @param {number} [options.rate=20] outgoing messages per second
   * @returns {Object} `{ id, ready, get(key), has(key), keys(prefix), all(prefix), set(key, value), patch(key, fields),
   *   delete(key), on(keyOrPrefix, listener), emit(topic, data), onEvent(topic, listener), presence(patch),
   *   onPeers(listener), tick(dt), autoTick(ms), close() }`. `ready` resolves once the durable store (if any) has loaded.
   * @throws {Error} from `set` / `patch` when the value is too large for the transport
   * @complexity `get` and `has` are O(1); `set`, `patch`, `delete` and `emit` are O(size of the value) for the size
   *   guard and serialising, plus O(listeners); `keys` and `all` are O(keys held). Memory is O(keys ever written):
   *   deleted keys leave a tombstone so the delete can win over an older set that arrives late.
   * @example
   * const net = Kit.net.session(hub.join('me'), { validate: (key, value, from) => !key.startsWith('map/') || from.by === 'gm' });
   * net.on('token/', (key, value, from) => moveToken(key, value));   // returns unsubscribe
   * net.set('token/me', { x: 3, y: 4 });
   * // every frame: net.tick(dt)   (or once: net.autoTick())
   */
  function session(transport, { validate, rate = DEFAULT_SEND_RATE } = {}) {
    /** @type {Map<string, Entry>} everything this peer knows, tombstones included */
    const entries = new Map();
    const stateBus = Kit.bus();
    const eventBus = Kit.bus();
    const maxBytes = transport.maxBytes || Infinity;
    const me = { peer: transport.id, isMe: true };
    /** Lamport clock: the highest counter seen, so the next local write is newer than everything known. */
    let lamportClock = 0;
    let isClosed = false;
    let tickTimer = null;

    // ---- outbox: outgoing messages are rate limited, because transports such as the hosted room drop bursts ----
    /**
     * Messages waiting to be sent, oldest first. A Map keeps insertion order, so it is a queue
     * whose entries can also be found and removed by key in O(1): a queued set is stored under its
     * state key (so a newer set for the same key replaces it), everything else under a serial number.
     * @type {Map<string, Message>}
     */
    const outbox = new Map();
    let outboxSerial = 0;
    /** State keys are prefixed so that no state key can collide with a serial number. */
    const SET_SLOT_PREFIX = 'set:';
    /** Token bucket: messages that may be sent right now. Refilled by tick, capped at one second's worth. */
    let sendBudget = rate;

    const outboxSlotOf = (message) => {
      if (message.t === 'set') return SET_SLOT_PREFIX + message.k;
      outboxSerial += 1;
      return String(outboxSerial);
    };

    /**
     * Queues a message, or sends it at once when it is urgent and the budget allows.
     * @complexity O(1) time per message (keyed removal and append), O(queued messages) space
     */
    const post = (message, isUrgent) => {
      if (isClosed) return;
      const slot = outboxSlotOf(message);
      // Coalesce: a queued set for the same key is stale now, so only the latest is ever sent.
      // Deleting first also moves the key to the back of the queue, where the new write belongs.
      outbox.delete(slot);
      if (isUrgent && sendBudget >= 1) {
        sendBudget -= 1;
        transport.send(message);
        return;
      }
      outbox.set(slot, message);
    };

    /**
     * Refills the budget for `dt` seconds and sends as much of the outbox as it allows, oldest first.
     * @complexity O(messages sent) time: taking the oldest entry of a Map is O(1), unlike Array.shift
     */
    const tick = (dt) => {
      sendBudget = Math.min(rate, sendBudget + rate * dt);
      while (outbox.size && sendBudget >= 1) {
        const [slot, message] = outbox.entries().next().value;
        outbox.delete(slot);
        sendBudget -= 1;
        transport.send(message);
      }
    };

    // ---- state ----

    /**
     * Takes an entry if it is newer than the one held. Local writes and stored entries skip
     * validation: the first is ours, the second already passed it on the peer that stored it.
     * @returns {boolean} true when the entry was applied
     */
    const accept = (key, entry, from, shouldValidate) => {
      const current = entries.get(key);
      if (!newer(entry.ver, current && current.ver)) return false;
      if (shouldValidate && validate && !validate(key, valueOf(entry), from, current)) return false;
      entries.set(key, entry);
      // Advance our clock past every counter we have seen, so our next write beats this one.
      lamportClock = Math.max(lamportClock, entry.ver[0]);
      stateBus.emit('*', { key, value: valueOf(entry), from });
      return true;
    };

    const acceptStored = (key, entry) => hasVersion(entry) && accept(key, entry, { peer: entry.ver[1], stored: true }, false);

    const nextVersion = () => {
      lamportClock += 1;
      return [lamportClock, transport.id];
    };

    /** Applies a local write, sends it live and, when there is a durable store, saves it. */
    const write = (key, entry) => {
      const message = { t: 'set', k: key, e: entry };
      const size = estimateBytes(message);
      if (size > maxBytes) {
        throw new Error(`Kit.net: value for "${key}" is too large for this transport (${Math.round(size)} > ${maxBytes} bytes); split it across keys`);
      }
      accept(key, entry, me, false);
      post(message, true);
      // A failed save is not fatal: the live message still went out and a later write heals the store.
      if (transport.store) Promise.resolve(transport.store.save(key, entry)).catch(() => {});
    };

    // ---- incoming ----

    /** What to do with each message type heard from another peer. */
    const MESSAGE_HANDLERS = {
      set(message, sender) {
        if (hasVersion(message.e)) accept(message.k, message.e, sender, true);
      },
      ev(message, sender) {
        eventBus.emit(message.topic, { data: message.data, from: sender });
      },
      hello() {
        // With a durable store the newcomer loads that instead. Without one, whoever is already
        // here answers with everything it holds (through the outbox, so rate limited and coalesced).
        if (transport.store) return;
        entries.forEach((entry, key) => post({ t: 'set', k: key, e: entry }));
      },
    };

    transport.onMessage((message, sender) => {
      // Our own messages come back from the transport; they were applied when written.
      if (isClosed || !message || sender.isMe) return;
      const handle = Object.prototype.hasOwnProperty.call(MESSAGE_HANDLERS, message.t) && MESSAGE_HANDLERS[message.t];
      if (handle) handle(message, sender);
    });

    const ready = (async () => {
      if (!transport.store) {
        post({ t: 'hello' }, true);
        return;
      }
      // Subscribe before loading so nothing stored in between is missed.
      transport.store.subscribe(acceptStored);
      (await transport.store.load()).forEach(([key, entry]) => acceptStored(key, entry));
    })();

    const api = {
      id: transport.id,
      ready,
      /** The value of a key, or undefined when it was never set or was deleted. */
      get(key) {
        const entry = entries.get(key);
        return entry && !entry.del ? entry.v : undefined;
      },
      has: (key) => api.get(key) !== undefined,
      /** Live keys that start with a prefix (default: all). O(keys held) time: prefixes are matched by scanning. */
      keys: (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix) && !entries.get(key).del),
      /** Live [key, value] pairs under a prefix: net.all('token/'). O(keys held) time. */
      all: (prefix = '') => api.keys(prefix).map((key) => [key, entries.get(key).v]),
      set: (key, value) => write(key, { v: value, ver: nextVersion() }),
      /** Merges fields into an object value (a whole-value write: the last patch to a key wins). */
      patch: (key, fields) => api.set(key, { ...(api.get(key) || {}), ...fields }),
      delete: (key) => write(key, { del: 1, ver: nextVersion() }),
      /**
       * Hears changes to one key, or to every key under a prefix ending in '/'; '' hears everything.
       * The listener gets (key, value or undefined for a delete, sender). Returns unsubscribe.
       */
      on: (keyOrPrefix, listener) =>
        stateBus.on('*', ({ key, value, from }) => {
          if (matchesKey(keyOrPrefix, key)) listener(key, value, from);
        }),
      /** Sends a moment: heard live by whoever is connected (yourself included), never stored. */
      emit(topic, data) {
        eventBus.emit(topic, { data, from: me });
        post({ t: 'ev', topic, data }, true);
      },
      /** Hears a topic's events as (data, sender). Returns unsubscribe. */
      onEvent: (topic, listener) => eventBus.on(topic, ({ data, from }) => listener(data, from)),
      /** Merges fields into this peer's presence, when the transport supports it. */
      presence: (patch) => transport.presence && transport.presence(patch),
      /** Hears the peer roster, when the transport supports it. Returns unsubscribe. */
      onPeers: (listener) => (transport.onPeers ? transport.onPeers(listener) : () => {}),
      /** Call from the game loop with the frame time in seconds: drains the outbox within the rate budget. */
      tick,
      /** Drains the outbox on a timer instead of from a game loop. Returns the session. */
      autoTick(periodMs = DEFAULT_TICK_MS) {
        if (!tickTimer) tickTimer = setInterval(() => tick(periodMs / MS_PER_SECOND), periodMs);
        return api;
      },
      close() {
        isClosed = true;
        if (tickTimer) clearInterval(tickTimer);
        if (transport.close) transport.close();
      },
    };
    return api;
  }

  /**
   * Creates the reference transport and test bench: a hub of in-memory peers.
   * @param {Object} [options]
   * @param {number} [options.drop=0] chance 0..1 that a live message to ANOTHER peer is lost
   * @param {boolean} [options.store=false] give every peer the same durable store
   * @param {function(): number} [options.rng=Math.random] random source for drops (seed it for repeatable tests)
   * @returns {{saved: Map<string, Entry>, join: function(string, {by?: string}=): Transport}} `join(id, { by })` adds a
   *   peer and returns its transport; `by` (default: the id) is who the peer acts for. `saved` is the store's contents.
   * @example
   * const hub = Kit.net.loopback({ drop: 0.3, store: true });
   * const alice = Kit.net.session(hub.join('alice')), bot = Kit.net.session(hub.join('bot', { by: 'gm' }));
   */
  function loopback({ drop = 0, store = false, rng = Math.random } = {}) {
    /** @type {Map<string, {by: string, handlers: Set<function>}>} */
    const peers = new Map();
    const presenceByPeer = new Map();
    const rosterListeners = new Set();
    const saved = new Map();
    const storeListeners = new Set();

    const presenceOf = (peerId) => presenceByPeer.get(peerId) || {};
    const roster = () => [...peers.keys()].map((peerId) => ({ peer: peerId, by: peers.get(peerId).by, presence: presenceOf(peerId) }));
    const announceRoster = () => rosterListeners.forEach((listener) => listener(roster()));

    /** The hub-wide durable store: keeps the newer version of each key and tells every subscriber. */
    const sharedStore = {
      load: async () => [...saved.entries()],
      save: async (key, entry) => {
        const current = saved.get(key);
        if (current && !newer(entry.ver, current.ver)) return;
        saved.set(key, serialise(entry));
        storeListeners.forEach((listener) => listener(key, saved.get(key)));
      },
      subscribe: (listener) => storeListeners.add(listener),
    };

    return {
      saved,
      join(id, { by = id } = {}) {
        const handlers = new Set();
        peers.set(id, { by, handlers });
        const transport = {
          id,
          maxBytes: LOOPBACK_MAX_BYTES,
          send(message) {
            // Real transports serialise, so do the same: non-JSON values fail here, early.
            const wireMessage = serialise(message);
            peers.forEach((peer, peerId) => {
              const isSelf = peerId === id;
              // Only deliveries to other peers can be lost; a peer always hears itself.
              if (!isSelf && rng() < drop) return;
              peer.handlers.forEach((handler) => handler(wireMessage, { peer: id, by, isMe: isSelf }));
            });
          },
          onMessage: (handler) => handlers.add(handler),
          presence(patch) {
            presenceByPeer.set(id, { ...presenceOf(id), ...patch });
            announceRoster();
          },
          onPeers(listener) {
            rosterListeners.add(listener);
            listener(roster());
            return () => rosterListeners.delete(listener);
          },
          close() {
            peers.delete(id);
            presenceByPeer.delete(id);
            announceRoster();
          },
        };
        // Each peer gets its own store object (same shared data), so a wrapper may decorate one without touching the others.
        if (store) transport.store = { ...sharedStore };
        announceRoster();
        return transport;
      },
    };
  }

  Kit.net = { session, loopback, newer };
})();
