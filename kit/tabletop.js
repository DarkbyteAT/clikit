// Kit tabletop: the rules of a shared tabletop, as plain data over Kit.net keys. Pure: no DOM, no THREE, no network of its own.
//
// Owns:  the key scheme below, the shape of every shared value (and cleaning untrusted ones), who may change what
//        (the `validate` function for Kit.net.session), the board grid built from map rows, what a viewer can see
//        (fog of war), turn order, ink stroke packing, roll and ping announcements, and a starter scene.
// Does not own: drawing, input, sound, or which transport carries the keys (games/table.js and Kit.net do that).
//
// KEY SCHEME (every value is small JSON; "GM" = a sender the transport vouches for as admin)
//   stage                    { scene: <sceneId> }: the scene everyone is looking at            GM
//   scene/<sceneId>          Scene                                                              GM
//   map/<sceneId>/<row>      string, one terrain character per cell of that row (see TERRAIN)   GM
//   door/<sceneId>/<x>.<y>   1 while the door at that cell stands open (absent = closed)        GM, or a player with a token beside it
//   token/<id>               Token (it names the scene it stands in)   GM adds, removes and moves between scenes; its owner
//                            moves it and edits name, hp and conditions; any player may claim an unowned player character
//   sheet/<id>               Sheet for token <id>                      GM, or the token's owner
//   turn                     Turn                       GM; the owner of the token whose turn it is may end that turn
//   ink/<by>/<sceneId>/<stroke>.<part>   InkChunk       the player whose id is <by> (add or erase), or the GM
//   gm/<by>          1                          GM only: lets every screen label who the game masters are
// EVENTS (live moments, never stored; always cleaned before use)
//   roll   { notation, seed, label, tokenId }   everyone re-rolls the notation from the seed, so totals cannot disagree with dice
//   ping   { x, y }                             a pulse on the board, in cells
// PRESENCE (display only, never authority)
//   { name, color, scene: <sceneId they are looking at>, cursor: [x, y], drag: [tokenId, x, y] | null,
//     ruler: [x0, y0, x1, y1] | null, area: [shapeId, x, y, radius] | null }       board coordinates in cells
// A campaign is simply the set of keys: any durable transport store (the hosted database, or a loopback hub kept in
// browser storage with Kit.net.remember) persists and reloads it whole.
(() => {
  // ---- tables ------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Terrain
   * @property {string} id
   * @property {string} label          shown on the game master's palette
   * @property {boolean} blocksSight
   * @property {boolean} blocksMove
   * @property {number} moveCost       multiplier for stepping into the cell
   * @property {boolean} [isDoor]
   */
  /**
   * What each map character means. One row per kind of cell; add a row to add terrain.
   * @type {Object<string, Terrain>}
   */
  const TERRAIN = {
    '.': { id: 'floor', label: 'Floor', blocksSight: false, blocksMove: false, moveCost: 1 },
    '#': { id: 'wall', label: 'Wall', blocksSight: true, blocksMove: true, moveCost: 1 },
    '~': { id: 'rough', label: 'Rough', blocksSight: false, blocksMove: false, moveCost: 2 },
    '+': { id: 'door', label: 'Door', blocksSight: true, blocksMove: true, moveCost: 1, isDoor: true },
    o: { id: 'pillar', label: 'Pillar', blocksSight: true, blocksMove: true, moveCost: 1 },
    c: { id: 'crate', label: 'Crate', blocksSight: false, blocksMove: true, moveCost: 1 },
    '*': { id: 'brazier', label: 'Brazier', blocksSight: false, blocksMove: true, moveCost: 1 },
  };
  /** A door standing open: never stored in a map row, produced by overlaying door/<x>.<y> keys. */
  const OPEN_DOOR = { id: 'door-open', label: 'Open door', blocksSight: false, blocksMove: false, moveCost: 1, isDoor: true };
  /** What a character missing from TERRAIN (or a cell beyond a short row) is treated as. */
  const UNKNOWN_TERRAIN = TERRAIN['#'];
  const FLOOR_CHARACTER = '.';
  const DOOR_CHARACTER = '+';

  /** The generic abilities on a character sheet. @type {Array<{id: string, label: string}>} */
  const STATS = [
    { id: 'might', label: 'Might' },
    { id: 'agility', label: 'Agility' },
    { id: 'wits', label: 'Wits' },
    { id: 'spirit', label: 'Spirit' },
  ];
  /** The stat added to a d20 when turn order is rolled. */
  const INITIATIVE_STAT = 'agility';

  /** Markers a token can carry. @type {Array<{id: string, label: string, color: string}>} */
  const CONDITIONS = [
    { id: 'down', label: 'Down', color: '#b3261e' },
    { id: 'slowed', label: 'Slowed', color: '#3f7cac' },
    { id: 'shaken', label: 'Shaken', color: '#c98a1b' },
    { id: 'warded', label: 'Warded', color: '#4f8f5b' },
    { id: 'burning', label: 'Burning', color: '#d9601a' },
    { id: 'unseen', label: 'Unseen', color: '#6b5b95' },
  ];

  /** Bounds on every shared value. Values outside them are rejected, so one bad client cannot bloat or break a table. */
  const LIMITS = {
    BOARD_MIN: 4,
    BOARD_MAX: 40,
    NAME_LENGTH: 24,
    SCENE_NAME_LENGTH: 40,
    UNIT_NAME_LENGTH: 6,
    HIT_POINTS_MAX: 999,
    SIGHT_MAX: 30,
    STAT_MIN: -5,
    STAT_MAX: 10,
    NOTES_LENGTH: 600,
    OWNER_ID_LENGTH: 80,
    GUARD_MAX: 40,
    SPEED_MAX: 20,
    MOVES: 4, // named attacks or abilities per sheet
    MOVE_NAME_LENGTH: 20,
    AREA_RADIUS_MAX: 12,
    TURN_ORDER_LENGTH: 40,
    ROLL_LABEL_LENGTH: 40,
    /** Points per ink chunk: 160 points are at most about 2.2 KiB of JSON, well inside a 4 KiB message. */
    INK_POINTS_PER_CHUNK: 160,
    /** Events accepted from one peer per window before the rest are ignored (stops ping and roll floods). */
    EVENTS_PER_WINDOW: 8,
    EVENT_WINDOW_SECONDS: 2,
  };
  /** Ink points are stored as whole numbers of this fraction of a cell, which keeps strokes compact on the wire. */
  const INK_STEPS_PER_CELL = 20;
  /** Points closer than this to the line through their neighbours are dropped when a stroke is finished, in cells. */
  const INK_SIMPLIFY_TOLERANCE = 0.04;
  const DEFAULT_SIGHT = 8;
  const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
  /** Scene ids are part of keys, so they are kept short and to characters every transport's store accepts. */
  const SCENE_ID_PATTERN = /^[a-z0-9-]{1,24}$/;
  const isSceneId = (value) => typeof value === 'string' && SCENE_ID_PATTERN.test(value);
  /** Defaults of a new sheet: a guard an unmodified d20 beats about half the time, and a 30 ft move on a 5 ft grid. */
  const SHEET_DEFAULTS = { guard: 10, speed: 6 };

  // ---- cleaning untrusted values -----------------------------------------------------------------------------------

  const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const isWholeBetween = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  const isShortText = (value, maxLength) => typeof value === 'string' && value.length <= maxLength;
  const isSameJson = (first, second) => JSON.stringify(first) === JSON.stringify(second);
  /** True when an untrusted object carries no fields beyond those its cleaned copy kept (cleaning has checked those). */
  const hasNoExtraFields = (untrusted, cleaned) => Object.keys(untrusted).length === Object.keys(cleaned).length;

  /**
   * @typedef {Object} Scene
   * @property {string} name
   * @property {number} width          cells
   * @property {number} height         cells
   * @property {boolean} fog           false lights the whole board for everyone
   * @property {string} rule           a key of Kit.measure.RULES
   * @property {number} unitsPerCell   for example 5
   * @property {string} unitName       for example "ft"
   * @property {{x: number, y: number}} entry  the cell a travelling party arrives at
   */
  /**
   * @param {*} value untrusted
   * @returns {Scene|null} a copy holding only the known fields, or null when any is missing or out of bounds
   */
  function cleanScene(value) {
    if (!isPlainObject(value)) return null;
    const { name, width, height, fog, rule, unitsPerCell, unitName, entry } = value;
    const isValid =
      isShortText(name, LIMITS.SCENE_NAME_LENGTH) && isWholeBetween(width, LIMITS.BOARD_MIN, LIMITS.BOARD_MAX) && isWholeBetween(height, LIMITS.BOARD_MIN, LIMITS.BOARD_MAX) &&
      typeof fog === 'boolean' && Object.prototype.hasOwnProperty.call(Kit.measure.RULES, rule) && Number.isFinite(unitsPerCell) && unitsPerCell > 0 && isShortText(unitName, LIMITS.UNIT_NAME_LENGTH) &&
      isPlainObject(entry) && isWholeBetween(entry.x, 0, width - 1) && isWholeBetween(entry.y, 0, height - 1);
    return isValid ? { name, width, height, fog, rule, unitsPerCell, unitName, entry: { x: entry.x, y: entry.y } } : null;
  }

  /**
   * @param {*} value untrusted
   * @returns {{scene: string}|null} which scene the table is on
   */
  const cleanStage = (value) => (isPlainObject(value) && isSceneId(value.scene) ? { scene: value.scene } : null);

  /**
   * @typedef {Object} Token
   * @property {string} scene          id of the scene it stands in
   * @property {string} name
   * @property {string} color          "#rrggbb"
   * @property {number} x              column
   * @property {number} y              row
   * @property {number} hp             current hit points
   * @property {number} hpMax
   * @property {string[]} conditions   ids from CONDITIONS, each at most once
   * @property {string|null} owner     user id of the player who controls it; null = nobody (the GM, or a free seat)
   * @property {'pc'|'npc'} kind       player character or anything the GM runs
   * @property {boolean} hidden        true: only the GM sees it
   * @property {number} sight          how far it sees, in cells
   */
  const CONDITION_IDS = CONDITIONS.map((condition) => condition.id);
  const isConditionList = (value) => Array.isArray(value) && value.length <= CONDITION_IDS.length && value.every((id) => CONDITION_IDS.includes(id)) && new Set(value).size === value.length;
  /**
   * @param {*} value untrusted
   * @returns {Token|null}
   */
  function cleanToken(value) {
    if (!isPlainObject(value)) return null;
    const { scene, name, color, x, y, hp, hpMax, conditions, owner, kind, hidden, sight } = value;
    const isValid =
      isSceneId(scene) && isShortText(name, LIMITS.NAME_LENGTH) && typeof color === 'string' && COLOR_PATTERN.test(color) &&
      isWholeBetween(x, 0, LIMITS.BOARD_MAX - 1) && isWholeBetween(y, 0, LIMITS.BOARD_MAX - 1) &&
      isWholeBetween(hpMax, 1, LIMITS.HIT_POINTS_MAX) && isWholeBetween(hp, 0, hpMax) && isConditionList(conditions) &&
      (owner === null || (isShortText(owner, LIMITS.OWNER_ID_LENGTH) && owner.length > 0)) && (kind === 'pc' || kind === 'npc') &&
      typeof hidden === 'boolean' && isWholeBetween(sight, 0, LIMITS.SIGHT_MAX);
    return isValid ? { scene, name, color, x, y, hp, hpMax, conditions: [...conditions], owner, kind, hidden, sight } : null;
  }

  /**
   * @typedef {Object} Move        a named attack or ability on a sheet
   * @property {string} name
   * @property {string} notation   dice notation rolled for its effect, for example "1d8+3"
   */
  /**
   * @typedef {Object} Sheet
   * @property {Object<string, number>} stats  one whole-number modifier per STATS id
   * @property {number} guard      what an attacker's check must reach to hit
   * @property {number} speed      cells it normally moves in a turn (longer drags are flagged, not forbidden)
   * @property {Move[]} moves
   * @property {string} notes
   */
  const isParsableNotation = (text) => {
    try {
      return !!Kit.dice.parse(text);
    } catch (parseError) {
      return false;
    }
  };
  const isMove = (value) => isPlainObject(value) && Object.keys(value).length === 2 && isShortText(value.name, LIMITS.MOVE_NAME_LENGTH) && value.name.length > 0 && isParsableNotation(value.notation);
  /**
   * @param {*} value untrusted
   * @returns {Sheet|null}
   * @complexity O(stats + moves) time and space; both are capped by LIMITS.
   */
  function cleanSheet(value) {
    if (!isPlainObject(value) || !isPlainObject(value.stats) || !isShortText(value.notes, LIMITS.NOTES_LENGTH)) return null;
    const { stats, guard, speed, moves, notes } = value;
    const isValid =
      STATS.every((stat) => isWholeBetween(stats[stat.id], LIMITS.STAT_MIN, LIMITS.STAT_MAX)) && isWholeBetween(guard, 0, LIMITS.GUARD_MAX) &&
      isWholeBetween(speed, 0, LIMITS.SPEED_MAX) && Array.isArray(moves) && moves.length <= LIMITS.MOVES && moves.every(isMove);
    return isValid ? { stats: Object.fromEntries(STATS.map((stat) => [stat.id, stats[stat.id]])), guard, speed, moves: moves.map((move) => ({ name: move.name, notation: move.notation })), notes } : null;
  }
  /** A sheet with every stat at zero and no moves, for tokens that have none yet. @returns {Sheet} */
  const blankSheet = () => ({ stats: Object.fromEntries(STATS.map((stat) => [stat.id, 0])), ...SHEET_DEFAULTS, moves: [], notes: '' });

  /**
   * @typedef {Object} Turn
   * @property {string[]} order                token ids, first to act first
   * @property {Object<string, number>} scores what each rolled
   * @property {number} index                  position in `order` of the token acting now
   * @property {number} round                  starts at 1
   */
  /**
   * @param {*} value untrusted
   * @returns {Turn|null}
   * @complexity O(order length) time and space, at most LIMITS.TURN_ORDER_LENGTH.
   */
  function cleanTurn(value) {
    if (!isPlainObject(value) || !Array.isArray(value.order) || !isPlainObject(value.scores)) return null;
    const { order, scores, index, round } = value;
    const isValid =
      order.length >= 1 && order.length <= LIMITS.TURN_ORDER_LENGTH && order.every((id) => isShortText(id, LIMITS.OWNER_ID_LENGTH)) && new Set(order).size === order.length &&
      order.every((id) => Number.isFinite(scores[id])) && isWholeBetween(index, 0, order.length - 1) && isWholeBetween(round, 1, Number.MAX_SAFE_INTEGER);
    return isValid ? { order: [...order], scores: Object.fromEntries(order.map((id) => [id, scores[id]])), index, round } : null;
  }

  /**
   * @typedef {Object} InkChunk
   * @property {string} color      "#rrggbb"
   * @property {number[]} points   x0, y0, x1, y1, ... in whole INK_STEPS_PER_CELL-ths of a cell
   */
  /**
   * @param {*} value untrusted
   * @returns {InkChunk|null}
   * @complexity O(points) time and space, at most LIMITS.INK_POINTS_PER_CHUNK.
   */
  function cleanInk(value) {
    if (!isPlainObject(value) || typeof value.color !== 'string' || !COLOR_PATTERN.test(value.color) || !Array.isArray(value.points)) return null;
    const { points } = value;
    const inkLimit = LIMITS.BOARD_MAX * INK_STEPS_PER_CELL;
    const isValid = points.length >= 4 && points.length % 2 === 0 && points.length <= 2 * LIMITS.INK_POINTS_PER_CHUNK && points.every((step) => isWholeBetween(step, -inkLimit, inkLimit));
    return isValid ? { color: value.color, points: [...points] } : null;
  }

  /**
   * A roll announcement another player sent, checked and parsed.
   * @param {*} data untrusted event data
   * @returns {{plan: Object, seed: number, label: string, tokenId: string|null}|null}
   */
  function cleanRoll(data) {
    if (!isPlainObject(data) || !isWholeBetween(data.seed, 0, 2 ** 32 - 1) || !isShortText(data.label, LIMITS.ROLL_LABEL_LENGTH)) return null;
    try {
      return { plan: Kit.dice.parse(data.notation), seed: data.seed, label: data.label, tokenId: isShortText(data.tokenId, LIMITS.OWNER_ID_LENGTH) ? data.tokenId : null };
    } catch (parseError) {
      return null; // notation another player sent that does not parse is simply not a roll
    }
  }
  /**
   * @param {*} data untrusted event data
   * @returns {{x: number, y: number}|null} board position in cells
   */
  const cleanPing = (data) => (isPlainObject(data) && Number.isFinite(data.x) && Number.isFinite(data.y) && Math.abs(data.x) <= LIMITS.BOARD_MAX && Math.abs(data.y) <= LIMITS.BOARD_MAX ? { x: data.x, y: data.y } : null);

  /**
   * @typedef {Object} Presence   what another player says about themselves right now; display only
   * @property {string} name                                   '' when they gave none
   * @property {string|null} color                             "#rrggbb", or null when they gave none
   * @property {string|null} scene                             id of the scene their pointer, drag, ruler and area refer to
   * @property {{x: number, y: number}|null} cursor            where they point, in cells
   * @property {{id: string, x: number, y: number}|null} drag  the token they are holding and where
   * @property {Array<{x: number, y: number}>|null} ruler      the two ends of their ruler
   * @property {{shape: string, x: number, y: number, radius: number}|null} area   the area template they are laying
   */
  const isAreaList = (value) =>
    Array.isArray(value) && value.length === 4 && Object.prototype.hasOwnProperty.call(Kit.measure.AREAS, value[0]) && isNumberList(value.slice(1, 3), 2) && Number.isFinite(value[3]) && value[3] >= 0 && value[3] <= LIMITS.AREA_RADIUS_MAX;
  const isBoardNumber = (value) => Number.isFinite(value) && Math.abs(value) <= LIMITS.BOARD_MAX;
  const isNumberList = (value, length) => Array.isArray(value) && value.length === length && value.every(isBoardNumber);
  /**
   * Another player's presence object, cleaned field by field: a malformed field becomes null (or '') rather than
   * spoiling the rest, because presence is typed by other pages and arrives many times a second.
   * @param {*} presence untrusted
   * @returns {Presence}
   */
  function cleanPresence(presence) {
    const given = isPlainObject(presence) ? presence : {};
    const { cursor, drag, ruler, area } = given;
    return {
      name: isShortText(given.name, LIMITS.NAME_LENGTH) ? given.name : '',
      color: typeof given.color === 'string' && COLOR_PATTERN.test(given.color) ? given.color : null,
      scene: isSceneId(given.scene) ? given.scene : null,
      cursor: isNumberList(cursor, 2) ? { x: cursor[0], y: cursor[1] } : null,
      drag: Array.isArray(drag) && drag.length === 3 && isShortText(drag[0], LIMITS.OWNER_ID_LENGTH) && isNumberList(drag.slice(1), 2) ? { id: drag[0], x: drag[1], y: drag[2] } : null,
      ruler: isNumberList(ruler, 4) ? [{ x: ruler[0], y: ruler[1] }, { x: ruler[2], y: ruler[3] }] : null,
      area: isAreaList(area) ? { shape: area[0], x: area[1], y: area[2], radius: area[3] } : null,
    };
  }

  /**
   * A per-peer flood gate for events: each peer may have LIMITS.EVENTS_PER_WINDOW accepted per window.
   * @returns {function(string, number): boolean} (peerId, nowSeconds) -> accept this event?
   * @complexity O(LIMITS.EVENTS_PER_WINDOW) time per event; O(peers) space.
   */
  function eventGate() {
    const recentByPeer = new Map();
    return (peerId, nowSeconds) => {
      const recent = (recentByPeer.get(peerId) || []).filter((time) => nowSeconds - time < LIMITS.EVENT_WINDOW_SECONDS);
      const isAllowed = recent.length < LIMITS.EVENTS_PER_WINDOW;
      recentByPeer.set(peerId, isAllowed ? [...recent, nowSeconds] : recent);
      return isAllowed;
    };
  }

  // ---- keys --------------------------------------------------------------------------------------------------------

  /** Builders for every key in the scheme, so no other code spells a key by hand. */
  const KEYS = {
    stage: 'stage',
    turn: 'turn',
    scene: (sceneId) => `scene/${sceneId}`,
    mapRow: (sceneId, row) => `map/${sceneId}/${row}`,
    door: (sceneId, x, y) => `door/${sceneId}/${x}.${y}`,
    token: (id) => `token/${id}`,
    sheet: (id) => `sheet/${id}`,
    ink: (by, sceneId, strokeId, part) => `ink/${by}/${sceneId}/${strokeId}.${part}`,
    gm: (by) => `gm/${by}`,
  };
  /** Split "kind/rest" at the first slash. @param {string} key @returns {{kind: string, rest: string}} */
  const splitKey = (key) => {
    const slash = key.indexOf('/');
    return slash < 0 ? { kind: key, rest: '' } : { kind: key.slice(0, slash), rest: key.slice(slash + 1) };
  };

  // ---- the board ---------------------------------------------------------------------------------------------------

  /**
   * @callback Read   reads the current shared value of a key (net.get)
   * @param {string} key
   * @returns {*}
   */

  /** The id of the scene the table is on, or null before a game master has set one. @param {Read} read */
  const activeSceneId = (read) => (cleanStage(read(KEYS.stage)) || { scene: null }).scene;

  /**
   * The board of one scene as a Kit.grid of Terrain rows, built from the scene, its map rows and its open doors.
   * @param {Read} read
   * @param {string|null} sceneId
   * @returns {Object|null} a Kit.grid whose cells are Terrain objects, or null while that scene does not exist
   * @complexity O(width x height) time and space; rebuilt only when a map, door or scene key changes.
   */
  function boardOf(read, sceneId) {
    const scene = sceneId ? cleanScene(read(KEYS.scene(sceneId))) : null;
    if (!scene) return null;
    const rowText = (row) => (typeof read(KEYS.mapRow(sceneId, row)) === 'string' ? read(KEYS.mapRow(sceneId, row)) : '');
    const rows = Array.from({ length: scene.height }, (unused, row) => rowText(row));
    // A character the table does not know, or a cell past the end of a short row, is solid: never a hole to walk through.
    const terrainAt = (x, y) => {
      const terrain = TERRAIN[rows[y][x]] || UNKNOWN_TERRAIN;
      return terrain.isDoor && read(KEYS.door(sceneId, x, y)) === 1 ? OPEN_DOOR : terrain;
    };
    return Kit.grid(scene.width, scene.height, { fill: terrainAt });
  }
  /** Does this terrain stop a line of sight? @param {Terrain} terrain @returns {boolean} */
  const blocksSight = (terrain) => terrain.blocksSight;
  /** Can a piece stand on this terrain? @param {Terrain} terrain @returns {boolean} */
  const isWalkable = (terrain) => !terrain.blocksMove;
  /** Multiplier for stepping onto this terrain (2 for rough ground). @param {Terrain} terrain @returns {number} */
  const moveCostOf = (terrain) => terrain.moveCost;

  /**
   * The tokens on the table, cleaned: [[id, Token], ...]. Tokens that fail cleaning are left out.
   * @param {Object} net          the session
   * @param {string} [sceneId]    only tokens standing in this scene; omit for every scene
   * @complexity O(tokens) time per call.
   */
  const tokensOf = (net, sceneId) =>
    net.all('token/').map(([key, value]) => [splitKey(key).rest, cleanToken(value)]).filter(([, token]) => token && (sceneId === undefined || token.scene === sceneId));

  // ---- who may change what -----------------------------------------------------------------------------------------

  /** Fields of a token its owner may change; everything else (owner, kind, hidden, hpMax, sight, color) is the GM's. */
  const OWNER_EDITABLE_TOKEN_FIELDS = ['x', 'y', 'hp', 'conditions', 'name'];
  const without = (object, fields) => Object.fromEntries(Object.entries(object).filter(([field]) => !fields.includes(field)));
  const isChangedOnlyIn = (before, after, fields) => isSameJson(without(before, fields), without(after, fields));
  const isBeside = (first, second) => Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) <= 1;

  /**
   * @typedef {Object} PlayerChange   one write by a player, as its rule sees it
   * @property {string} rest          the key after its kind ("t1" for "token/t1")
   * @property {*} value              the new value; undefined for a deletion
   * @property {*} previous           the value before; undefined when the key did not exist
   * @property {string} by            the player's user id, vouched for by the transport
   * @property {Read} read
   */
  /**
   * What a player (not a GM) may write, by key kind. A kind with no row here is GM-only.
   * @type {Object<string, function(PlayerChange): boolean>}
   */
  const PLAYER_RULES = {
    token({ value, previous, by, read }) {
      const before = cleanToken(previous), after = cleanToken(value);
      // Players never add or remove tokens, and may not attach fields the table does not know.
      if (!before || !after || !hasNoExtraFields(value, after)) return false;
      const isClaimingFreeSeat = before.kind === 'pc' && before.owner === null && after.owner === by && isChangedOnlyIn(before, after, ['owner']);
      if (isClaimingFreeSeat) return true;
      if (before.owner !== by || !isChangedOnlyIn(before, after, OWNER_EDITABLE_TOKEN_FIELDS)) return false;
      const board = boardOf(read, after.scene);
      const hasMoved = before.x !== after.x || before.y !== after.y;
      return !hasMoved || (!!board && board.inside(after.x, after.y) && isWalkable(board.get(after.x, after.y)));
    },
    sheet({ rest, value, by, read }) {
      const token = cleanToken(read(KEYS.token(rest))), sheet = cleanSheet(value);
      return !!token && token.owner === by && !!sheet && hasNoExtraFields(value, sheet) && hasNoExtraFields(value.stats, sheet.stats);
    },
    door({ rest, value, by, read }) {
      const { kind: sceneId, rest: cellText } = splitKey(rest);
      const [x, y] = cellText.split('.').map(Number);
      const board = boardOf(read, sceneId);
      const isDoorCell = !!board && board.inside(x, y) && !!board.get(x, y).isDoor;
      const isOpeningOrClosing = value === 1 || value === undefined;
      const standsBeside = (token) => token.owner === by && token.scene === sceneId && isBeside(token, { x, y });
      return isDoorCell && isOpeningOrClosing && read.tokens().some(([, token]) => standsBeside(token));
    },
    turn({ value, previous, by, read }) {
      const before = cleanTurn(previous);
      if (!before) return false;
      const actingToken = cleanToken(read(KEYS.token(before.order[before.index])));
      const isPresent = (id) => !!cleanToken(read(KEYS.token(id)));
      return !!actingToken && actingToken.owner === by && isSameJson(cleanTurn(value), nextTurn(before, isPresent));
    },
    ink({ rest, value, by }) {
      const isOwnStroke = rest.startsWith(by + '/');
      return isOwnStroke && (value === undefined || (!!cleanInk(value) && hasNoExtraFields(value, cleanInk(value))));
    },
  };

  /**
   * The `validate` function for Kit.net.session: game masters may write anything; a player only what PLAYER_RULES
   * allow; a sender with no identity nothing. Every screen runs it on everything it hears, live or stored.
   * @param {Object} net  the session the rules read current state from
   * @returns {function(string, *, Object, Object=): boolean} (key, value, sender, previousEntry) -> accept?
   * @example
   * let rules = () => false;                       // the session needs validate before the rules can read the session
   * const net = Kit.net.session(transport, { validate: (...change) => rules(...change) });
   * rules = Kit.tabletop.rulesFor(net);
   */
  function rulesFor(net) {
    const read = Object.assign((key) => net.get(key), { tokens: () => tokensOf(net) });
    return (key, value, sender, previousEntry) => {
      if (sender.admin === true) return true;
      if (typeof sender.by !== 'string' || !sender.by) return false;
      const { kind, rest } = splitKey(key);
      const rule = PLAYER_RULES[kind];
      const previous = previousEntry && !previousEntry.del ? previousEntry.v : undefined;
      return !!rule && rule({ rest, value, previous, by: sender.by, read });
    };
  }

  /**
   * @typedef {Object} Seat    one participant's handle on the table
   * @property {Object} net                              the Kit.net session
   * @property {function(string): *} read                current value of a key
   * @property {function(string, *): boolean} mayPut     would this write be accepted from this participant?
   * @property {function(string, *=): boolean} put       write (or delete, with undefined) if allowed; false when refused
   */
  /**
   * Sit at a table: run a session with the tabletop rules on a transport, and check this participant's own writes
   * against the same rules before sending them. (A session applies local writes without asking, so an unchecked
   * write that everyone else refuses would leave this screen showing something no one else sees.)
   * @param {Object} transport   any Kit.net transport whose senders carry `by` and `admin`
   * @param {{by: string|null, isGm: function(): boolean}} identity   who this participant is, as the transport vouches
   * @returns {Seat}
   * @example
   * const seat = Kit.tabletop.seat(hub.join('ana'), { by: 'ana', isGm: () => false });
   * seat.put(Kit.tabletop.KEYS.door(3, 5), 1) || showRefusal();
   */
  function seat(transport, identity) {
    let rules = () => false; // the session needs `validate` before the rules can read the session
    const net = Kit.net.session(transport, { validate: (...change) => rules(...change), rate: transport.rate });
    rules = rulesFor(net);
    const own = Kit.net.checked(net, rules, () => ({ peer: transport.id, by: identity.by, admin: identity.isGm() }));
    return { net, read: (key) => net.get(key), mayPut: own.mayWrite, put: (key, value) => (value === undefined ? own.delete(key) : own.set(key, value)) };
  }

  // ---- what a viewer sees ------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} Viewer
   * @property {string|null} by    the viewer's user id
   * @property {boolean} isGm      true shows everything
   */
  /**
   * The tokens a viewer sees through: their own, or, for someone with no token (a spectator, or a GM previewing the
   * players' view), every player character, so the board is never simply black.
   * @param {Array<[string, Token]>} tokens
   * @param {Viewer} viewer
   * @returns {Token[]}
   * @complexity O(tokens) time and space.
   */
  function eyesOf(tokens, viewer) {
    const all = tokens.map(([, token]) => token);
    const own = all.filter((token) => viewer.by !== null && token.owner === viewer.by);
    return own.length ? own : all.filter((token) => token.kind === 'pc');
  }
  /**
   * Cells lit for a set of eyes: the union of each eye's field of view.
   * @param {Object} board   from boardOf()
   * @param {Token[]} eyes
   * @returns {Uint8Array} 1 = visible, index = y * board.w + x
   * @complexity O(eyes x sight^2) time, O(board cells) space: four characters seeing 8 cells is under a thousand
   *   cell visits, recomputed only when a token, door or map key of the scene changes.
   */
  const visibleCells = (board, eyes) => eyes.reduce((mask, eye) => Kit.sight.fov(board, eye.x, eye.y, { radius: eye.sight, blocks: blocksSight, into: mask }), new Uint8Array(board.w * board.h));
  /**
   * Should this viewer be shown this token? GMs see all; players see their own, and others only when not hidden and
   * standing on a lit cell.
   * @param {Token} token
   * @param {Viewer} viewer
   * @param {Uint8Array} visible  from visibleCells()
   * @param {number} boardWidth
   * @returns {boolean}
   */
  const isTokenShown = (token, viewer, visible, boardWidth) => viewer.isGm || (viewer.by !== null && token.owner === viewer.by) || (!token.hidden && visible[token.y * boardWidth + token.x] === 1);

  /**
   * @typedef {Object} LightLevels   brightness per kind of cell, 0 (black) to 1 (fully lit)
   * @property {number} inView       seen right now
   * @property {number} remembered   seen earlier, not now (players)
   * @property {number} unseen       never seen (players)
   * @property {number} gmUnseen     not seen by the players, as shown to a game master, who sees everything
   */
  /**
   * How brightly to draw each cell for a viewer: players get fog of war with memory; a game master sees the whole
   * board with the part the players cannot see dimmed, so they always know what is in view.
   * @param {Uint8Array} visible    from visibleCells()
   * @param {Uint8Array} explored   cells ever seen; same length
   * @param {boolean} isGm
   * @param {LightLevels} levels
   * @returns {Float32Array} one brightness per cell
   */
  const lightLevels = (visible, explored, isGm, levels) =>
    Float32Array.from(visible, (isVisible, cell) => (isVisible ? levels.inView : isGm ? levels.gmUnseen : explored[cell] ? levels.remembered : levels.unseen));

  /**
   * A short walk for a scripted player: a route from a token to a random free cell nearby that it can reach.
   * @param {Object} board                     from boardOf()
   * @param {Array<[string, Token]>} tokens    everyone on the table (their cells are not walked onto)
   * @param {Token} token                      the one that walks
   * @param {Object} rng                       a Kit.rng
   * @param {number} reach                     furthest destination, in cells along each axis
   * @returns {Array<{x: number, y: number}>|null} route cells including the start, or null when there is nowhere to go
   * @complexity O(candidates x route search) worst case; candidates lie within `reach`, so about (2 x reach + 1)^2 short searches, run once per bot action, never per frame.
   */
  function strollRoute(board, tokens, token, rng, reach) {
    const isTaken = (x, y) => tokens.some(([, other]) => other.x === x && other.y === y);
    const candidates = board.find((terrain, x, y) => isWalkable(terrain) && !isTaken(x, y) && Math.abs(x - token.x) <= reach && Math.abs(y - token.y) <= reach);
    const routes = rng.shuffle(candidates).map((cell) => Kit.measure.route(board, token, cell, { passable: isWalkable, costOf: moveCostOf, maxCost: 2 * reach }));
    return routes.find((route) => route && route.length > 1) || null;
  }

  // ---- turn order --------------------------------------------------------------------------------------------------

  /**
   * Roll turn order: each token rolls d20 plus its initiative stat; highest acts first, ties go to the higher
   * modifier and then to token id so every screen agrees.
   * @param {Array<[string, Token]>} tokens
   * @param {function(string): Sheet} sheetOf   token id -> its sheet
   * @param {Object} rng                        a Kit.rng
   * @returns {Turn|null} null when there are no tokens
   * @complexity O(n log n) time, O(n) space, n = tokens (at most LIMITS.TURN_ORDER_LENGTH).
   */
  function rollTurnOrder(tokens, sheetOf, rng) {
    const rolled = tokens.slice(0, LIMITS.TURN_ORDER_LENGTH).map(([id]) => {
      const modifier = sheetOf(id).stats[INITIATIVE_STAT];
      return { id, modifier, score: Kit.dice.roll(Kit.dice.check(modifier), rng).total };
    });
    if (!rolled.length) return null;
    const byScore = [...rolled].sort((first, second) => second.score - first.score || second.modifier - first.modifier || (first.id < second.id ? -1 : 1));
    return { order: byScore.map((entry) => entry.id), scores: Object.fromEntries(byScore.map((entry) => [entry.id, entry.score])), index: 0, round: 1 };
  }
  /**
   * The turn after this one: the next token in order that is still on the table; passing the end starts a new round.
   * @param {Turn} turn
   * @param {function(string): boolean} [isPresent]  token id -> still on the table; default: all are
   * @returns {Turn}
   * @complexity O(order length) time, O(1) extra space.
   */
  function nextTurn(turn, isPresent = () => true) {
    const steps = Array.from({ length: turn.order.length }, (unused, offset) => offset + 1);
    // If nobody in the order is left, fall through to a plain single step so the turn still advances.
    const step = steps.find((offset) => isPresent(turn.order[(turn.index + offset) % turn.order.length])) || 1;
    const position = turn.index + step;
    return { ...turn, index: position % turn.order.length, round: turn.round + Math.floor(position / turn.order.length) };
  }

  // ---- ink ---------------------------------------------------------------------------------------------------------

  /**
   * Pack a drawn stroke for sharing: simplify it, snap it to the ink grid, and cut it into chunks small enough for one
   * message each. Consecutive chunks share their joining point so the line has no gaps.
   * @param {Array<{x: number, y: number}>} points   board coordinates in cells
   * @param {string} color                           "#rrggbb"
   * @returns {InkChunk[]} empty when the stroke is a single point
   * @complexity O(points^2) worst case in the simplification (typically O(points log points)), O(points) space; runs once when a stroke ends.
   */
  function packStroke(points, color) {
    const simplified = Kit.line.simplify(points, INK_SIMPLIFY_TOLERANCE);
    if (simplified.length < 2) return [];
    const stride = LIMITS.INK_POINTS_PER_CHUNK - 1; // each chunk repeats the last point of the one before
    const chunkCount = Math.ceil((simplified.length - 1) / stride);
    return Array.from({ length: chunkCount }, (unused, chunk) => ({
      color,
      points: simplified.slice(chunk * stride, chunk * stride + LIMITS.INK_POINTS_PER_CHUNK).flatMap((point) => [Math.round(point.x * INK_STEPS_PER_CELL), Math.round(point.y * INK_STEPS_PER_CELL)]),
    }));
  }
  /**
   * The polyline of one ink chunk, back in cells.
   * @param {InkChunk} chunk  already cleaned
   * @returns {Array<{x: number, y: number}>}
   */
  const unpackInk = (chunk) => Array.from({ length: chunk.points.length / 2 }, (unused, index) => ({ x: chunk.points[2 * index] / INK_STEPS_PER_CELL, y: chunk.points[2 * index + 1] / INK_STEPS_PER_CELL }));

  // ---- the starter scene -------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} StarterToken
   * @property {string} id
   * @property {string} scene      id of the scene it starts in
   * @property {Object} token      Token fields that differ from TOKEN_DEFAULTS
   * @property {number[]} stats    modifiers in the order of STATS
   * @property {number} guard
   * @property {number} speed
   * @property {Move[]} moves
   */
  /** The campaign a brand-new table opens on: two scenes, a party of four and things waiting in the dark. */
  const STARTER = {
    stage: 'cellars',
    scenes: [
      {
        id: 'cellars',
        scene: { name: 'The Lamplit Cellars', fog: true, rule: 'alternating', unitsPerCell: 5, unitName: 'ft', entry: { x: 2, y: 15 } },
        map: [
          '################',
          '#.....#........#',
          '#.c...#...o....#',
          '#.....+........#',
          '#.*...#...o..c.#',
          '###+###........#',
          '#.....####+#####',
          '#.~~..#........#',
          '#.~~~.#..o..o..#',
          '#..~..+........#',
          '#.....#..o..o..#',
          '#.....#....*...#',
          '###+########+###',
          '#......#.....c.#',
          '#......#.......#',
          '#..c...+...~~..#',
          '#......#..~~~..#',
          '#......#.......#',
          '################',
        ],
      },
      {
        id: 'yard',
        scene: { name: 'The Overgrown Yard', fog: false, rule: 'alternating', unitsPerCell: 5, unitName: 'ft', entry: { x: 2, y: 9 } },
        map: [
          '##############',
          '#....~~......#',
          '#.c..~~~..o..#',
          '#....~~......#',
          '#.........c..#',
          '#..o.........#',
          '#......*.....#',
          '#.~~.........#',
          '#.~~~....o...#',
          '#............#',
          '#............#',
          '##############',
        ],
      },
    ],
    /** @type {StarterToken[]} */
    tokens: [
      { id: 'wren', scene: 'cellars', token: { name: 'Wren', color: '#d9902f', x: 2, y: 16, hp: 18, hpMax: 22, kind: 'pc' }, stats: [1, 3, 2, 0], guard: 13, speed: 6, moves: [{ name: 'Shortbow', notation: '1d6+3' }, { name: 'Knife', notation: '1d4+3' }] },
      { id: 'ash', scene: 'cellars', token: { name: 'Ash', color: '#3f8f8a', x: 4, y: 15, hp: 26, hpMax: 26, kind: 'pc' }, stats: [3, 0, 0, 2], guard: 16, speed: 5, moves: [{ name: 'Longblade', notation: '1d10+3' }] },
      { id: 'ivy', scene: 'cellars', token: { name: 'Ivy', color: '#7a5aa6', x: 3, y: 14, hp: 9, hpMax: 14, kind: 'pc' }, stats: [-1, 2, 3, 1], guard: 11, speed: 6, moves: [{ name: 'Spark', notation: '2d6' }, { name: 'Mend', notation: '1d8+3' }] },
      { id: 'tam', scene: 'cellars', token: { name: 'Tam', color: '#4c7a3d', x: 5, y: 16, hp: 20, hpMax: 20, kind: 'pc' }, stats: [2, 1, 0, 1], guard: 14, speed: 6, moves: [{ name: 'Staff', notation: '1d6+2' }] },
      { id: 'shade1', scene: 'cellars', token: { name: 'Cellar Shade', color: '#8c2f39', x: 11, y: 14, hp: 11, hpMax: 11, kind: 'npc' }, stats: [1, 2, -1, 0], guard: 12, speed: 6, moves: [{ name: 'Claw', notation: '1d6+1' }] },
      { id: 'shade2', scene: 'cellars', token: { name: 'Cellar Shade', color: '#8c2f39', x: 3, y: 8, hp: 11, hpMax: 11, kind: 'npc' }, stats: [1, 2, -1, 0], guard: 12, speed: 6, moves: [{ name: 'Claw', notation: '1d6+1' }] },
      { id: 'warden', scene: 'cellars', token: { name: 'The Warden', color: '#5b3a8c', x: 11, y: 3, hp: 40, hpMax: 40, kind: 'npc', hidden: true }, stats: [4, 0, 1, 3], guard: 15, speed: 5, moves: [{ name: 'Great chain', notation: '2d8+4' }, { name: 'Dread howl', notation: '3d6' }] },
      { id: 'thorn1', scene: 'yard', token: { name: 'Thornling', color: '#6a7a2f', x: 9, y: 3, hp: 7, hpMax: 7, kind: 'npc' }, stats: [0, 1, -2, 0], guard: 11, speed: 4, moves: [{ name: 'Lash', notation: '1d6' }] },
      { id: 'thorn2', scene: 'yard', token: { name: 'Thornling', color: '#6a7a2f', x: 10, y: 7, hp: 7, hpMax: 7, kind: 'npc' }, stats: [0, 1, -2, 0], guard: 11, speed: 4, moves: [{ name: 'Lash', notation: '1d6' }] },
    ],
  };
  /** Fields every token gets unless its row says otherwise. */
  const TOKEN_DEFAULTS = { conditions: [], owner: null, hidden: false, sight: DEFAULT_SIGHT };
  /** Size and settings of a scene a game master adds from nothing. */
  const BLANK_SCENE = { WIDTH: 16, HEIGHT: 16, settings: { fog: true, rule: 'alternating', unitsPerCell: 5, unitName: 'ft' } };

  /** The [key, value] entries of one scene: its settings and one map row per line of `map`. */
  const sceneEntries = (sceneId, settings, map) => [[KEYS.scene(sceneId), { ...settings, width: map[0].length, height: map.length }], ...map.map((row, index) => [KEYS.mapRow(sceneId, index), row])];

  /**
   * Every [key, value] of the starter campaign, ready to be written by a game master onto an empty table.
   * @param {Object<string, string>} [owners]  token id -> user id, to seat players from the start
   * @returns {Array<[string, *]>}
   * @complexity O(cells + tokens of the starter) time and space.
   */
  function starterEntries(owners = {}) {
    const scenes = STARTER.scenes.flatMap((row) => sceneEntries(row.id, row.scene, row.map));
    const tokens = STARTER.tokens.map((row) => [KEYS.token(row.id), { ...TOKEN_DEFAULTS, ...row.token, scene: row.scene, owner: owners[row.id] || null }]);
    const sheets = STARTER.tokens.map((row) => [KEYS.sheet(row.id), { stats: Object.fromEntries(STATS.map((stat, index) => [stat.id, row.stats[index]])), guard: row.guard, speed: row.speed, moves: row.moves, notes: '' }]);
    return [...scenes, ...tokens, ...sheets, [KEYS.stage, { scene: STARTER.stage }]];
  }

  /**
   * The entries of a new, empty scene: open floor inside a wall, entered near its top-left corner.
   * @param {string} sceneId  must match the scene id pattern (lower case letters, digits, "-")
   * @param {string} name
   * @returns {Array<[string, *]>}
   */
  function blankSceneEntries(sceneId, name) {
    const wall = '#'.repeat(BLANK_SCENE.WIDTH), open = '#' + FLOOR_CHARACTER.repeat(BLANK_SCENE.WIDTH - 2) + '#';
    const map = Array.from({ length: BLANK_SCENE.HEIGHT }, (unused, row) => (row === 0 || row === BLANK_SCENE.HEIGHT - 1 ? wall : open));
    return sceneEntries(sceneId, { ...BLANK_SCENE.settings, name, entry: { x: 1, y: 1 } }, map);
  }

  // ---- automations: travelling, areas, harm ------------------------------------------------------------------------

  /**
   * Where a group arriving at a cell can stand: the nearest free open cells, the entry first.
   * @param {Object} board                      from boardOf()
   * @param {{x: number, y: number}} entry
   * @param {Array<[string, Token]>} occupants  tokens already in that scene
   * @param {number} count                      cells wanted
   * @returns {Array<{x: number, y: number}>} up to `count` cells, nearest first
   * @complexity O(board cells) time and space (one flood fill outwards from the entry).
   */
  function arrivalCells(board, entry, occupants, count) {
    const isFree = (cell) => isWalkable(board.get(cell.x, cell.y)) && !occupants.some(([, token]) => token.x === cell.x && token.y === cell.y);
    return board.flood(entry.x, entry.y, isWalkable, true).filter(isFree).slice(0, count);
  }

  /**
   * Bring the party to a scene: every player character not already there is placed around that scene's entry.
   * @param {Array<[string, Token]>} tokens   every token on the table, all scenes
   * @param {Object} board                    the destination scene's board
   * @param {Scene} scene                     the destination scene
   * @param {string} sceneId
   * @returns {Array<[string, Token]>} the tokens to write, each with its new scene and cell
   * @complexity O(board cells + tokens) time and space (one flood fill for the arrival cells).
   */
  function partyTravel(tokens, board, scene, sceneId) {
    const travellers = tokens.filter(([, token]) => token.kind === 'pc' && token.scene !== sceneId);
    const cells = arrivalCells(board, scene.entry, tokens.filter(([, token]) => token.scene === sceneId), travellers.length);
    // If the scene has fewer free cells than travellers, those without a cell stay where they are.
    return cells.map((cell, index) => [travellers[index][0], { ...travellers[index][1], scene: sceneId, x: cell.x, y: cell.y }]);
  }

  /**
   * The ids of the tokens standing on any of the given cells.
   * @param {Array<[string, Token]>} tokens
   * @param {Array<{x: number, y: number}>} cells
   * @returns {string[]}
   * @complexity O(tokens + cells) time: the cells are indexed once, then each token is one lookup.
   */
  function tokensOn(tokens, cells) {
    const covered = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    return tokens.filter(([, token]) => covered.has(`${token.x},${token.y}`)).map(([id]) => id);
  }

  const DOWN_CONDITION = 'down';
  /**
   * A token after taking harm (or healing, with a negative amount): hit points stay within 0 and the maximum, and
   * the "down" condition follows them, so nobody has to remember to mark it.
   * @param {Token} token
   * @param {number} amount  hit points lost; negative heals
   * @returns {Token}
   */
  function harmed(token, amount) {
    const hp = Math.min(token.hpMax, Math.max(0, token.hp - Math.round(amount)));
    const others = token.conditions.filter((id) => id !== DOWN_CONDITION);
    return { ...token, hp, conditions: hp === 0 ? [...others, DOWN_CONDITION] : others };
  }

  Kit.tabletop = {
    TERRAIN, OPEN_DOOR, FLOOR_CHARACTER, DOOR_CHARACTER, STATS, INITIATIVE_STAT, CONDITIONS, LIMITS, KEYS, STARTER, TOKEN_DEFAULTS, SHEET_DEFAULTS, INK_STEPS_PER_CELL,
    cleanScene, cleanStage, cleanToken, cleanSheet, cleanTurn, cleanInk, cleanRoll, cleanPing, cleanPresence, blankSheet, eventGate, splitKey,
    activeSceneId, boardOf, tokensOf, blocksSight, isWalkable, moveCostOf, rulesFor, seat, eyesOf, visibleCells, isTokenShown, lightLevels, strollRoute,
    rollTurnOrder, nextTurn, packStroke, unpackInk, starterEntries, blankSceneEntries, arrivalCells, partyTravel, tokensOn, harmed,
  };
})();
