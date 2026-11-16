// A fake of the hosting platform for tests: just the `claude.use('room' | 'db' | 'user')` calls that kit/net-claude.js
// makes, with the access rules the platform documents (room.d.ts, db.d.ts, user.d.ts) enforced the way this project
// reads them. It is a reading of the contract, not the platform: passing against it proves the adapter's logic, not
// that the real service behaves the same.
//
//   const platform = createFakePlatform(Kit.net.claude.capabilities);
//   const gm = platform.view({ id: 'u_gm', level: 'admin' });      // one open page
//   const transport = await Kit.net.claude({ claude: gm.claude });
//
// Owns: an in-memory room (lobby + named rooms, topics, presence, connection) and document store (paths, rules,
//       collection listeners). Does not own: anything about Kit.net.

/** Sharing levels from lowest to highest; a rule names the minimum level for an action. */
const LEVELS = ['view', 'interact', 'admin', 'owner'];
/** What the root allows when no rule says otherwise (db.d.ts: "the root defaults to read: view, write: interact"). */
const ROOT_DEFAULTS = { read: 'view', write: 'interact' };
/** Characters a document path segment may use (db.d.ts PATH GRAMMAR). */
const SEGMENT_PATTERN = /^[A-Za-z0-9_\-.~:@+]+$/;
const MESSAGE_BYTE_LIMIT = 4096;
const TOPIC_PATTERN = /^[a-z][a-z0-9_.-]{0,47}$/;
const ROOM_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const reject = (code, message = code) => Promise.reject({ code, message });
/** Deliver on a later microtask, like the platform: never synchronously inside the caller's own call. */
const later = (callback) => Promise.resolve().then(callback);

/**
 * Split and check a path. Documents have an even number of segments, collections an odd number.
 * @param {string} path
 * @param {'document'|'collection'} kind
 * @returns {string[]} segments
 */
function parsePath(path, kind) {
  const segments = path.split('/');
  const isEven = segments.length % 2 === 0;
  if (isEven !== (kind === 'document')) throw new TypeError(`fake db: "${path}" is not a ${kind} path (${segments.length} segments)`);
  const bad = segments.find((segment) => !SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..');
  if (bad !== undefined) throw new TypeError(`fake db: illegal path segment "${bad}" in "${path}"`);
  return segments;
}

/**
 * The minimum level a viewer needs for an action at a path: the deepest matching rule that sets that action wins,
 * and `{self}` in a rule matches only the viewer's own id.
 * @param {Array<{path: string, read?: string, write?: string}>} rules
 * @param {string[]} segments   the document path
 * @param {'read'|'write'} action
 * @param {string|null} viewerId
 * @returns {string} a level name
 */
function requiredLevel(rules, segments, action, viewerId) {
  const matches = (rule) => {
    const ruleSegments = rule.path === '' ? [] : rule.path.split('/');
    return ruleSegments.length <= segments.length && ruleSegments.every((segment, index) => (segment === '{self}' ? segments[index] === viewerId : segment === segments[index]));
  };
  const depth = (rule) => (rule.path === '' ? 0 : rule.path.split('/').length);
  const deepestFirst = rules.filter((rule) => rule[action] && matches(rule)).sort((first, second) => depth(second) - depth(first));
  return deepestFirst.length ? deepestFirst[0][action] : ROOT_DEFAULTS[action];
}

/**
 * @param {{room?: {topics?: Object<string, string>}, db?: {rules?: Array}}} capabilities  what the page was "published" with
 * @returns {{view: Function, documents: Map<string, Object>, dropRate: number}}
 */
function createFakePlatform(capabilities) {
  const rules = (capabilities.db && capabilities.db.rules) || [];
  const openTopics = (capabilities.room && capabilities.room.topics) || {};
  const documents = new Map(); // document path -> body
  const collectionWatchers = new Set(); // { collectionPath, view, callback, seen: Map<id, json text> }
  const rooms = new Map(); // room name ('' = lobby) -> Set of members
  let nextPeerNumber = 1;
  const platform = { documents, dropRate: 0, view };

  const holds = (viewLevel, level) => LEVELS.indexOf(viewLevel) >= LEVELS.indexOf(level);
  const canDo = (viewState, segments, action) => holds(viewState.level, requiredLevel(rules, segments, action, viewState.id));

  // ---- store ---------------------------------------------------------------------------------------------------------
  const snapshotOf = (id, body) => ({ id, exists: body !== undefined, data: () => cloneJson(body), metadata: { fromCache: false, hasPendingWrites: false } });
  /** Documents directly inside a collection that this view may read, as [id, body] pairs sorted by id. */
  function visibleDocuments(collectionPath, viewState) {
    const prefix = collectionPath + '/';
    return [...documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && canDo(viewState, path.split('/'), 'read'))
      .map(([path, body]) => [path.slice(prefix.length), body])
      .sort(([first], [second]) => (first < second ? -1 : 1));
  }
  /** Tell one watcher what changed since it last heard; always answers the first time, even when empty. */
  function notifyWatcher(watcher) {
    const current = visibleDocuments(watcher.collectionPath, watcher.view);
    const changes = current
      .filter(([id, body]) => watcher.seen.get(id) !== JSON.stringify(body))
      .map(([id, body]) => ({ type: watcher.seen.has(id) ? 'modified' : 'added', doc: snapshotOf(id, body) }));
    const currentIds = new Set(current.map(([id]) => id));
    const removed = [...watcher.seen.keys()].filter((id) => !currentIds.has(id)).map((id) => ({ type: 'removed', doc: snapshotOf(id, JSON.parse(watcher.seen.get(id))) }));
    if (watcher.hasAnswered && !changes.length && !removed.length) return;
    watcher.hasAnswered = true;
    watcher.seen = new Map(current.map(([id, body]) => [id, JSON.stringify(body)]));
    const docs = current.map(([id, body]) => snapshotOf(id, body));
    watcher.callback({ docs, size: docs.length, empty: !docs.length, docChanges: () => [...changes, ...removed], metadata: { fromCache: false, hasPendingWrites: false } });
  }
  const notifyAll = () => later(() => [...collectionWatchers].forEach(notifyWatcher));

  function databaseFor(viewState) {
    const documentRef = (path) => {
      const segments = parsePath(path, 'document');
      return {
        id: segments[segments.length - 1],
        path,
        get: () => later(() => snapshotOf(segments[segments.length - 1], canDo(viewState, segments, 'read') ? documents.get(path) : undefined)),
        set(body) {
          if (!body || typeof body !== 'object' || Array.isArray(body)) return reject('invalid_argument', 'body must be an object');
          if (!canDo(viewState, segments, 'write')) return reject('invalid_argument', `fake db: ${viewState.level} may not write ${path}`);
          viewState.writes.push(path);
          documents.set(path, cloneJson(body));
          notifyAll();
          return later(() => undefined);
        },
        delete() {
          if (!canDo(viewState, segments, 'write')) return reject('invalid_argument');
          documents.delete(path);
          notifyAll();
          return later(() => undefined);
        },
        collection: (name) => collectionRef(`${path}/${name}`),
      };
    };
    const collectionRef = (path) => {
      parsePath(path, 'collection');
      return {
        path,
        doc: (id) => documentRef(`${path}/${id}`),
        onSnapshot(callback) {
          const watcher = { collectionPath: path, view: viewState, callback, seen: new Map(), hasAnswered: false };
          collectionWatchers.add(watcher);
          later(() => collectionWatchers.has(watcher) && notifyWatcher(watcher));
          return () => collectionWatchers.delete(watcher);
        },
      };
    };
    return { doc: documentRef, collection: collectionRef };
  }

  // ---- room ----------------------------------------------------------------------------------------------------------
  const membersOf = (roomName) => rooms.get(roomName) || rooms.set(roomName, new Set()).get(roomName);
  const stampFor = (sender, receiver) => ({ peer: sender.peer, by: sender.id, isMe: sender.id === receiver.id, sameTab: sender === receiver, kind: 'viewer', guest: false });
  const peersFor = (roomName, receiver) => [...membersOf(roomName)].map((member) => ({ ...stampFor(member.viewState, receiver), presence: member.presence, updatedAt: 0 }));
  const announcePeers = (roomName) =>
    later(() => membersOf(roomName).forEach((member) => member.peerHandlers.forEach((handler) => handler({ peers: peersFor(roomName, member.viewState), joined: [], left: [], updated: [] }))));

  /** The calls a room offers one member; the lobby and named rooms share them. */
  function roomFor(viewState, roomName) {
    const member = { viewState, presence: {}, topicHandlers: new Map(), peerHandlers: new Set(), connectionHandlers: new Set(), errorHandlers: new Set() };
    membersOf(roomName).add(member);
    viewState.memberships.push({ roomName, member });
    const listen = (set, handler, onError) => {
      set.add(handler);
      if (onError) member.errorHandlers.add(onError);
      return () => set.delete(handler);
    };
    const api = {
      name: roomName,
      emit(topic, data) {
        if (!TOPIC_PATTERN.test(topic)) return reject('invalid_argument', 'bad topic');
        if (Buffer.byteLength(JSON.stringify(data === undefined ? null : data), 'utf8') > MESSAGE_BYTE_LIMIT) return reject('invalid_argument', 'data is over 4 KiB');
        const needed = openTopics[topic] || 'admin';
        if (!holds(viewState.level, needed)) return reject('not_permitted', `fake room: ${viewState.level} may not send on ${topic}`);
        viewState.emits.push({ topic, data: cloneJson(data) });
        if (!viewState.isConnected) return later(() => undefined); // resolves, and the moment is dropped
        membersOf(roomName).forEach((receiver) => {
          const isLost = receiver !== member && Math.random() < platform.dropRate;
          if (isLost || !receiver.viewState.isConnected) return;
          later(() => (receiver.topicHandlers.get(topic) || []).forEach((handler) => handler({ topic, data: cloneJson(data), ...stampFor(viewState, receiver.viewState) })));
        });
        return later(() => undefined);
      },
      on(topic, handler, onError) {
        if (!member.topicHandlers.has(topic)) member.topicHandlers.set(topic, new Set());
        return listen(member.topicHandlers.get(topic), handler, onError);
      },
      presence(patch) {
        member.presence = Object.freeze({ ...member.presence, ...patch });
        viewState.presenceCalls++;
        announcePeers(roomName);
        return later(() => undefined);
      },
      peers: () => peersFor(roomName, viewState),
      onPeers(handler, onError) {
        const stop = listen(member.peerHandlers, handler, onError);
        announcePeers(roomName);
        return stop;
      },
      connected: () => viewState.isConnected,
      onConnection(handler, onError) {
        const stop = listen(member.connectionHandlers, handler, onError);
        later(() => handler(viewState.isConnected));
        return stop;
      },
      leave() {
        membersOf(roomName).delete(member);
        announcePeers(roomName);
        return later(() => undefined);
      },
    };
    return api;
  }

  /**
   * Open one page of the artifact.
   * @param {Object} options
   * @param {string|null} options.id          the viewer's user id (null: no identity)
   * @param {'view'|'interact'|'admin'|'owner'} options.level
   * @param {string[]} [options.serves]       capabilities this view can run; default all three
   * @param {boolean} [options.allowsNamedRooms=true]
   * @returns {{claude: {use: Function}, emits: Array, writes: string[], setConnected: Function, failRoom: Function, presenceCalls: function(): number}}
   */
  function view({ id, level, serves = ['room', 'db', 'user'], allowsNamedRooms = true }) {
    const viewState = { id, level, peer: 'peer' + nextPeerNumber++, isConnected: true, emits: [], writes: [], memberships: [], presenceCalls: 0 };
    const lobby = roomFor(viewState, '');
    const namespaces = {
      room: {
        ...lobby,
        join(name) {
          if (!ROOM_NAME_PATTERN.test(name)) return reject('invalid_argument', 'bad room name');
          return allowsNamedRooms ? later(() => roomFor(viewState, name)) : reject('not_permitted', 'named rooms are not offered');
        },
      },
      db: databaseFor(viewState),
      user: {
        me: () => later(() => ({ id, name: '', avatarUrl: '', color: '#888888', email: null, isOwner: level === 'owner', canEdit: holds(level, 'admin') })),
        can: (capability) => later(() => (capability === 'data.write' ? holds(level, 'interact') : false)),
        profiles: (ids) => later(() => Object.fromEntries([].concat(ids).map((userId) => [userId, { id: userId, name: 'Name of ' + userId, color: '#888888' }]))),
      },
    };
    return {
      claude: { use: (name) => later(() => (serves.includes(name) ? namespaces[name] : null)) },
      emits: viewState.emits,
      writes: viewState.writes,
      presenceCalls: () => viewState.presenceCalls,
      /** Flip the connection of every room this view is in, and tell its connection listeners. */
      setConnected(isConnected) {
        viewState.isConnected = isConnected;
        viewState.memberships.forEach(({ member }) => member.connectionHandlers.forEach((handler) => handler(isConnected)));
      },
      /** End every named room of this view with an error code, the way a failed re-join does. */
      failRoom(code) {
        viewState.memberships.filter(({ roomName }) => roomName !== '').forEach(({ roomName, member }) => {
          membersOf(roomName).delete(member);
          [...member.errorHandlers].forEach((onError) => onError({ code, message: code }));
        });
      },
    };
  }

  return platform;
}

module.exports = { createFakePlatform, requiredLevel };
