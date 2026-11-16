// Kit net trust: small decorators that make a Kit.net transport safer to listen to. Pure: no DOM, no network.
//
// Owns:  checks and wrappers that sit between a transport and Kit.net.session
//          Kit.net.isSaneEntry(entry)        - is this entry's version one an honest peer could have produced right now?
//          Kit.net.guarded(transport)        - a transport that silently drops "set" messages failing that check
//          Kit.net.withSender(transport, fn) - a transport whose senders carry extra, locally decided fields
//          Kit.net.checked(net, validate, self) - a session whose own writes are held to the same rule as everyone's
//          Kit.net.remember(hub, storage)    - keep a loopback hub's durable store in browser storage, so a table
//                                              played on one device survives a reload
// Does not own: the session, the rules of any game (those are the `validate` function a game gives the session), or any real network.
//
// Why versions need a check: a session orders writes by a counter and adopts the highest counter it hears. A peer that
// sends a huge counter would win its keys forever and drag everyone's counter towards the number range's end. Honest
// counters never exceed the current time in milliseconds by much (they start at zero and grow by one per write), so a
// horizon of "now plus a few minutes" rejects the attack without any clock synchronisation.
(() => {
  /** How far past the local clock a version counter may be, in milliseconds. Covers badly set device clocks. */
  const CLOCK_SKEW_MS = 5 * 60 * 1000;

  /**
   * @typedef {Object} Entry          what a session stores per key
   * @property {*} [v]                the value (absent for a deletion)
   * @property {1} [del]              present when the key was deleted
   * @property {[number, string]} ver version: [counter, id of the peer that wrote it]
   */

  /**
   * Could an honest peer have written this entry? The counter must be a whole, non-negative number no later than the
   * horizon, and the writer id must be text (ids are compared to break ties, so a non-string would compare unpredictably).
   * @param {*} entry                 untrusted: whatever arrived
   * @param {number} [now=Date.now()] current time in milliseconds
   * @returns {boolean}
   */
  function isSaneEntry(entry, now = Date.now()) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.ver) || entry.ver.length !== 2) return false;
    const [counter, writerId] = entry.ver;
    return Number.isSafeInteger(counter) && counter >= 0 && counter <= now + CLOCK_SKEW_MS && typeof writerId === 'string';
  }

  /** Is this a well-formed message for the session? "set" messages must name a text key and carry a sane entry. */
  const isAcceptableMessage = (message) => !!message && typeof message === 'object' && (message.t !== 'set' || (typeof message.k === 'string' && isSaneEntry(message.e)));

  /**
   * Wrap a transport so malformed messages and writes with impossible versions never reach the session.
   * @param {Object} transport  any Kit.net transport
   * @returns {Object} a transport with the same members
   * @example const net = Kit.net.session(Kit.net.guarded(hub.join('me')), { validate });
   */
  const guarded = (transport) => ({
    ...transport,
    onMessage: (handler) => transport.onMessage((message, sender) => isAcceptableMessage(message) && handler(message, sender)),
  });

  /**
   * Wrap a transport so every sender it reports carries extra fields decided on this side, never by the sender.
   * Used to mark who the game master is on transports that have no notion of roles (Kit.net.loopback).
   * @param {Object} transport                      any Kit.net transport
   * @param {function(Object): Object} describe     (sender) -> fields to add, for example { admin: sender.by === 'gm' }
   * @returns {Object} a transport with the same members
   */
  const withSender = (transport, describe) => ({
    ...transport,
    onMessage: (handler) => transport.onMessage((message, sender) => handler(message, { ...sender, ...describe(sender) })),
  });

  /**
   * Wrap a session so this participant's own writes are checked against the table's rule before they are made.
   * A bare session applies local writes without asking, so a write everyone else refuses would leave this one
   * screen showing something no one else sees. With this wrapper `set`, `patch` and `delete` return false and change
   * nothing when the rule refuses them.
   * @param {Object} net                                    a Kit.net session
   * @param {function(string, *, Object, Object=): boolean} [validate]  the same rule the session was given; omit to allow all
   * @param {function(): Object} describeSelf               this participant as a sender: { peer, by, admin }
   * @returns {Object} the session's members, with checked `set` / `patch` / `delete` and `mayWrite(key, value)`
   * @example
   * const mine = Kit.net.checked(net, rules, () => ({ peer: net.id, by: 'ana', admin: false }));
   * mine.set('map/0', '....') || showRefusal();
   */
  function checked(net, validate, describeSelf) {
    const mayWrite = (key, value) => !validate || validate(key, value, { ...describeSelf(), isMe: true }, net.has(key) ? { v: net.get(key) } : undefined);
    const writeIfAllowed = (key, value, write) => {
      if (!mayWrite(key, value)) return false;
      write();
      return true;
    };
    const set = (key, value) => writeIfAllowed(key, value, () => net.set(key, value));
    return { ...net, mayWrite, set, patch: (key, fields) => set(key, { ...(net.get(key) || {}), ...fields }), delete: (key) => writeIfAllowed(key, undefined, () => net.delete(key)) };
  }

  /**
   * Keep a loopback hub's durable store in a key-value storage (Kit.store(name), a game's ctx.save). Call it before
   * anyone joins the hub: what was saved earlier is loaded into the hub, so every session that joins reads it.
   * The hub must have been made with `{ store: true }`.
   * @param {Object} hub                          from Kit.net.loopback({ store: true })
   * @param {{get: function(string, *): *, set: function(string, *): *}} storage
   * @param {string} [name='table']               the storage key to keep the entries under
   * @returns {{flush: function(): void, forget: function(): void}} flush() writes the hub's current entries;
   *   forget() empties both the hub's store and the storage
   * @complexity flush is O(keys) time and writes every entry, so call it on a timer or after a pause, not per change.
   * @example
   * const hub = Kit.net.loopback({ store: true });
   * const memory = Kit.net.remember(hub, ctx.save, 'campaign');
   * const net = Kit.net.session(hub.join('me'));
   * ctx.every(2, memory.flush);
   */
  function remember(hub, storage, name = 'table') {
    const stored = storage.get(name, []);
    // Storage can be edited by hand or left over from an older version: keep only well-formed, sane entries.
    (Array.isArray(stored) ? stored : []).filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && isSaneEntry(pair[1])).forEach(([key, entry]) => hub.saved.set(key, entry));
    return {
      flush: () => storage.set(name, [...hub.saved.entries()]),
      forget() {
        hub.saved.clear();
        storage.set(name, []);
      },
    };
  }

  Object.assign(Kit.net, { isSaneEntry, guarded, withSender, checked, remember, CLOCK_SKEW_MS });
})();
