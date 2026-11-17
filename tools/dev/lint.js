/**
 * Dev tools lint: checks the mechanical parts of the CODE STANDARD (AGENTS.md) and the kit's hard rules.
 *
 * Owns:  the rule table (what each rule means and its one-line fix), the pure `lintSource` that turns a file's
 *        text into findings, and the two report formats (`file:line rule message` lines and per-file counts).
 * Does not own: reading the source (source.js), choosing which files to lint or exit codes (dev.js / check.js).
 *
 * What it cannot catch (a reviewer still must): abbreviations and vague names, whether a lambda is "tiny",
 * unused variables, copy-pasted blocks, a magic number that appears only once, whether a comment explains the
 * why, whether a JSDoc block is accurate, and functions returned from inside nested blocks.
 */
'use strict';

const { readSource, kitExports, parseJsdoc, valueAt } = require('./source');

/**
 * @typedef {Object} Rule
 * @property {'error'|'warn'} tier `error` rules are exact and fail `check`; `warn` rules are heuristics
 * @property {string} about what the rule asks for
 * @property {string} fix the one-line fix shown with every finding
 * @property {boolean} [browserOnly] only applies to code that runs in the page (kit/ and games/)
 * @property {boolean} [gamesOnly] only applies to games/, where the kit's helpers must be used instead
 */

/** Every rule the lint knows, keyed by the id printed in findings. Adding a rule means adding a row and a checker. */
const RULES = {
  header: { tier: 'error', about: 'Each file opens with a comment saying what it owns and what it does not.', fix: 'Start the file with a /** ... */ block: one line on what it is, then "Owns:" and "Does not own:".' },
  todo: { tier: 'error', about: 'No leftover TODO / FIXME / XXX / HACK notes.', fix: 'Do it now, or delete the note and list it in your report.' },
  'console-log': { tier: 'error', browserOnly: true, about: 'No console.log / debug / info left in page code (Biome\'s noConsole checks the same; this one needs no install).', fix: 'Delete it; expose values through debugState() and read them with `dev.js play`.' },
  'raw-timer': { tier: 'error', gamesOnly: true, about: 'Games never call setTimeout / setInterval / requestAnimationFrame.', fix: 'Use ctx.after / ctx.every / ctx.tween: they pause, slow and dispose with the game.' },
  'raw-listener': { tier: 'error', gamesOnly: true, about: 'Games never add window or document listeners.', fix: 'Use ctx.input (onTap / onSwipe / onDrag / stick) or ctx.on("resize").' },
  jsdoc: { tier: 'warn', about: 'JSDoc on every function assigned to Kit.* or returned from a kit factory.', fix: 'Add a /** ... */ block: purpose, @param, @returns, and an @example when the call shape is not obvious.' },
  complexity: { tier: 'warn', about: 'A kit function that walks a collection states its cost (AGENTS.md: performance is designed in, and measured).', fix: 'Add `@complexity O(n) time, O(1) space` (say what n is) to its JSDoc, or to the factory that returns it.' },
  'depth-plan': { tier: 'warn', gamesOnly: true, about: "A game's header names its depth at seconds, minutes and hours (games/README.md: deep at three timescales).", fix: 'Add "Seconds (mastery): ...", "Minutes (decisions): ..." and "Hours (the long arc): ..." lines to the header.' },
  'jsdoc-params': { tier: 'warn', about: 'A documented function with parameters documents them.', fix: 'Add an @param {type} name line (with units) for each parameter.' },
  'short-name': { tier: 'warn', about: 'No single-letter names outside arrow parameters and loop indices.', fix: 'Name it for what it is (event, enemy, element, index).' },
  'commented-code': { tier: 'warn', about: 'No commented-out code.', fix: 'Delete it; version history keeps the old code.' },
  'magic-number': { tier: 'warn', about: 'A number used more than once has a name.', fix: 'Move it to an UPPER_SNAKE constant or a row of a data table, with its unit.' },
  'raw-color': { tier: 'warn', gamesOnly: true, about: 'A raw THREE.Color skips the sRGB conversion and looks washed out.', fix: 'Use ctx.make.color(hex), or pass the hex number straight to ctx.make.*.' },
};

/** Single-letter names that are words in their own right here: the three axes, and `t` from the `update(dt, t)` contract. */
const ALLOWED_SHORT_NAMES = new Set(['x', 'y', 'z', 't', '_']);
/** Numbers too ordinary to need a name. */
const ORDINARY_NUMBERS = new Set([0, 1, 2, 0.5, 100]);
/** Words that open a block or call but never define a function, so `word (...) {` is not a method. */
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'with', 'function', 'return', 'typeof', 'await', 'new', 'do', 'else']);
const NOTE_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/;
const CONSTANT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** Shapes of a `//` comment that is really a line of code. English prose almost never ends in `;` or opens with `const x =`. */
const CODE_COMMENT_PATTERNS = [
  /^(if|for|while|switch)\s*\(.*\)\s*\{?$/,
  /^(const|let|var)\s+[\w${[][^=]*=.+/,
  /^return\b.*;$/,
  /^[\w.$[\]]+\s*(=|\+=|-=)\s*[^=].*;$/,
  /^[\w.$]+\(.*\);$/,
  /^[}\])]+;?$/,
];
const MOST_LINES_LISTED = 4;

/**
 * @typedef {Object} Finding
 * @property {string} file path as given to lintSource
 * @property {number} line
 * @property {string} rule a key of RULES
 * @property {string} message what is wrong, naming the thing
 */

/** Does this rule apply to a file at this path? */
const appliesTo = (rule, file) => {
  const isGame = /(^|\/)games\//.test(file);
  const isPageCode = isGame || /(^|\/)kit\//.test(file);
  if (rule.gamesOnly) return isGame;
  return !rule.browserOnly || isPageCode;
};

// ---- checkers: each takes a Source and returns [{ line, message }] ---------------------------------------------------

const checkHeader = ({ tokens }) => {
  const first = tokens.find((token) => !token.value.startsWith('#!'));
  const hasHeader = first && first.type === 'comment' && first.value.split(/\s+/).length > 4;
  return hasHeader ? [] : [{ line: 1, message: 'the file does not open with a header comment' }];
};

const checkNotes = ({ tokens }) =>
  tokens
    .filter((token) => token.type === 'comment' && NOTE_PATTERN.test(token.value))
    .map((token) => ({ line: token.line, message: `leftover ${NOTE_PATTERN.exec(token.value)[1]} note` }));

const checkConsoleLog = ({ code }) =>
  code
    .filter((token, index) => token.value === 'console' && valueAt(code, index + 1) === '.' && ['log', 'debug', 'info'].includes(valueAt(code, index + 2)))
    .map((token) => ({ line: token.line, message: 'console output left in page code' }));

const checkRawTimers = ({ code }) =>
  code
    .filter((token, index) => ['setTimeout', 'setInterval', 'requestAnimationFrame'].includes(token.value) && valueAt(code, index + 1) === '(')
    .map((token) => ({ line: token.line, message: `${token.value} runs on wall-clock time and survives the game` }));

const checkRawListeners = ({ code }) =>
  code
    .filter((token, index) => ['window', 'document'].includes(token.value) && valueAt(code, index + 1) === '.' && valueAt(code, index + 2) === 'addEventListener')
    .map((token) => ({ line: token.line, message: `${token.value}.addEventListener outlives the game` }));

const checkRawColors = ({ code }) =>
  code
    .filter((token, index) => {
      const isColorCall = token.value === 'new' && valueAt(code, index + 1) === 'THREE' && valueAt(code, index + 3) === 'Color' && valueAt(code, index + 4) === '(';
      if (!isColorCall) return false;
      const closeIndex = code[index + 4].mate;
      // An empty `new THREE.Color()` is a scratch object, and one converted on the spot is already correct.
      return closeIndex !== index + 5 && valueAt(code, closeIndex + 2) !== 'convertSRGBToLinear';
    })
    .map((token) => ({ line: token.line, message: 'new THREE.Color(hex) is not converted from sRGB' }));

const checkCommentedCode = ({ tokens }) =>
  tokens
    // The file header and indented lines inside a comment block are usage examples, not dead code.
    .filter((token, index) => token.type === 'comment' && /^\/\/ ?\S/.test(token.value) && tokens.slice(0, index).some((earlier) => earlier.type !== 'comment'))
    .filter((token) => CODE_COMMENT_PATTERNS.some((pattern) => pattern.test(token.value.slice(2).trim())))
    .map((token) => ({ line: token.line, message: `this comment looks like code: ${token.value.slice(0, 50)}` }));

/** Names of simple (not destructured) parameters in a parameter list's source text. */
const simpleParameterNames = (params) =>
  params
    .split(',')
    .map((part) => /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part))
    .filter(Boolean)
    .map((match) => match[1]);

const checkJsdoc = (source) => {
  const exported = kitExports(source);
  // A factory may document what it returns in one place: a @typedef's @property lines, or its own @returns text.
  const propertyNames = new Set(
    source.tokens
      .filter((token) => token.type === 'comment' && token.value.startsWith('/**'))
      .flatMap((token) => parseJsdoc(token.value).properties.map((property) => property.name.replace(/[[\]]/g, '').split('=')[0]))
  );
  const isCoveredByFactory = (factory, member) => propertyNames.has(member.name.slice(1)) || new RegExp(`\\b${member.name.slice(1)}\\b`).test(factory.jsdoc || '');
  const missing = (entry, what) => ({ line: entry.line, message: `${what} has no JSDoc` });
  return exported
    .filter((entry) => entry.kind === 'function')
    .flatMap((entry) => [
      ...(entry.jsdoc ? [] : [missing(entry, `${entry.name}(${entry.params})`)]),
      ...entry.members.filter((member) => !member.jsdoc && !isCoveredByFactory(entry, member)).map((member) => missing(member, `${entry.name}()${member.name}(${member.params}), returned by a kit factory,`)),
    ]);
};

const checkJsdocParams = (source) =>
  kitExports(source)
    .flatMap((entry) => [entry, ...entry.members])
    .filter((entry) => entry.kind === 'function' && entry.jsdoc && simpleParameterNames(entry.params).length)
    .filter((entry) => !parseJsdoc(entry.jsdoc).tagNames.some((tag) => ['param', 'type', 'callback'].includes(tag)))
    .map((entry) => ({ line: entry.line, message: `${entry.name}(${entry.params}) documents none of its parameters` }));

const checkComplexity = (source) => {
  if (!/(^|\/)kit\//.test(source.file)) return [];
  const statesCost = (jsdoc) => /@complexity\b/.test(jsdoc || '');
  return kitExports(source)
    .filter((entry) => entry.kind === 'function')
    .flatMap((entry) => [
      ...(entry.iterates && entry.jsdoc && !statesCost(entry.jsdoc) ? [{ line: entry.line, message: `${entry.name}() walks a collection but states no @complexity` }] : []),
      // A factory may state the cost of everything it returns in its own block.
      ...entry.members.filter((member) => member.iterates && !statesCost(member.jsdoc) && !statesCost(entry.jsdoc)).map((member) => ({ line: member.line, message: `${entry.name}()${member.name}() walks a collection but states no @complexity` })),
    ]);
};

/** The three timescales a game's header must name, and the word that names each. */
const DEPTH_SCALES = ['seconds', 'minutes', 'hours'];

const checkDepthPlan = ({ tokens, code }) => {
  const registers = code.some((token, index) => token.value === 'Kit' && valueAt(code, index + 2) === 'register' && valueAt(code, index + 3) === '(');
  if (!registers) return [];
  const firstCodeIndex = tokens.findIndex((token) => token.type !== 'comment');
  const header = tokens.slice(0, firstCodeIndex === -1 ? tokens.length : firstCodeIndex).map((token) => token.value).join('\n');
  const missing = DEPTH_SCALES.filter((scale) => !new RegExp(`\\b${scale}\\b`, 'i').test(header));
  return missing.length ? [{ line: 1, message: `the header does not say what the game offers at: ${missing.join(', ')}` }] : [];
};

/** Indices of the binding names introduced by the declaration or parameter pattern that spans (from, to), ends excluded. */
const bindingIndices = (code, from, to) => {
  const indices = [];
  for (let index = from + 1; index < to; index++) {
    const token = code[index];
    const before = valueAt(code, index - 1);
    const after = valueAt(code, index + 1);
    // A binding follows an opener, a comma, a rest marker or a `key:`; what follows `=` is a default value, not a name.
    const followsBindingPosition = ['(', '{', '[', ',', '...', ':'].includes(before);
    if (token.type === 'ident' && followsBindingPosition && after !== ':' && after !== '(' && after !== '.') indices.push(index);
    if (after === '=' && token.type === 'ident') index = endOfDefault(code, index + 2, to) - 1;
  }
  return indices;
};

/** Index of the comma or closer that ends a default value starting at `from` (brackets are jumped whole). */
const endOfDefault = (code, from, limit) => {
  let index = from;
  while (index < limit && ![',', ')', '}', ']'].includes(valueAt(code, index))) index = code[index].mate > index ? code[index].mate + 1 : index + 1;
  return index;
};

/** Indices of the names declared by the `const` / `let` / `var` at `keywordIndex` (every declarator, patterns included). */
const declaredIndices = (code, keywordIndex) => {
  const indices = [];
  let index = keywordIndex + 1;
  const parent = code[keywordIndex].parent;
  while (code[index]) {
    const token = code[index];
    if (token.type === 'ident') indices.push(index);
    else if (token.value === '{' || token.value === '[') indices.push(...bindingIndices(code, index, token.mate));
    else break;
    // Move past this declarator's initialiser to the comma that starts the next declarator, if there is one.
    index = token.mate > index ? token.mate + 1 : index + 1;
    while (code[index] && code[index].parent === parent && ![',', ';', 'of', 'in'].includes(code[index].value)) index = code[index].mate > index ? code[index].mate + 1 : index + 1;
    if (valueAt(code, index) !== ',' || code[index].parent !== parent) break;
    index += 1;
  }
  return indices;
};

/** Is the declaration at `keywordIndex` the counter of a classic `for (let i = 0; ...)` loop? */
const isLoopCounter = (code, keywordIndex) => valueAt(code, keywordIndex - 1) === '(' && valueAt(code, keywordIndex - 2) === 'for' && valueAt(code, keywordIndex + 2) === '=';

const checkShortNames = ({ code }) => {
  const flagged = new Map();
  const flag = (index, role) => {
    const { value, line } = code[index];
    if (value.length === 1 && !ALLOWED_SHORT_NAMES.has(value)) flagged.set(index, { line, message: `${role} "${value}" is a single letter` });
  };
  code.forEach((token, index) => {
    if (token.type !== 'ident') return;
    if (['const', 'let', 'var'].includes(token.value) && !isLoopCounter(code, index)) declaredIndices(code, index).forEach((nameIndex) => flag(nameIndex, 'variable'));
    // `name(...) {` defines a method or function; `function (...)` and `catch (e)` bind names the same way.
    const opensParameters = valueAt(code, index + 1) === '(' && valueAt(code, code[index + 1].mate + 1) === '{' && valueAt(code, index - 1) !== '.';
    const isDefinition = opensParameters && (!CONTROL_WORDS.has(token.value) || token.value === 'function');
    if (isDefinition) bindingIndices(code, index + 1, code[index + 1].mate).forEach((nameIndex) => flag(nameIndex, 'parameter'));
  });
  return [...flagged.values()];
};

/** Marks every token inside the initialiser of an UPPER_SNAKE constant: numbers there are already in a named table. */
const tableTokenFlags = (code) => {
  const isInTable = new Array(code.length).fill(false);
  code.forEach((token, index) => {
    const named = code[index + 1];
    if (token.value !== 'const' || !named || !CONSTANT_NAME_PATTERN.test(named.value) || valueAt(code, index + 2) !== '=') return;
    for (let cursor = index + 3; code[cursor] && !(code[cursor].value === ';' && code[cursor].parent === token.parent); cursor++) isInTable[cursor] = true;
  });
  return isInTable;
};

const checkMagicNumbers = ({ code }) => {
  const isInTable = tableTokenFlags(code);
  const linesByNumber = new Map();
  code.forEach((token, index) => {
    if (token.type !== 'number' || isInTable[index]) return;
    const amount = Number(token.value.replace(/_/g, ''));
    // `name = 5;` and `key: 5,` already name the number where it stands.
    const isNamedInPlace = ['=', ':'].includes(valueAt(code, index - 1)) && [',', ';', '}', ')'].includes(valueAt(code, index + 1));
    if (ORDINARY_NUMBERS.has(amount) || isNamedInPlace) return;
    linesByNumber.set(token.value, [...(linesByNumber.get(token.value) || []), token.line]);
  });
  return [...linesByNumber.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([number, lines]) => {
      const listed = lines.slice(0, MOST_LINES_LISTED).join(', ') + (lines.length > MOST_LINES_LISTED ? ', ...' : '');
      return { line: lines[0], message: `${number} appears ${lines.length} times unnamed (lines ${listed})` };
    });
};

/** The checker for each rule id. */
const CHECKERS = {
  header: checkHeader,
  todo: checkNotes,
  'console-log': checkConsoleLog,
  'raw-timer': checkRawTimers,
  'raw-listener': checkRawListeners,
  jsdoc: checkJsdoc,
  complexity: checkComplexity,
  'depth-plan': checkDepthPlan,
  'jsdoc-params': checkJsdocParams,
  'short-name': checkShortNames,
  'commented-code': checkCommentedCode,
  'magic-number': checkMagicNumbers,
  'raw-color': checkRawColors,
};

/**
 * Lints one file.
 * @param {string} file path relative to the project root (decides which rules apply: kit/ and games/ are page code)
 * @param {string} text the file's contents
 * @returns {Finding[]} sorted by line
 * @example lintSource('games/demo.js', 'console.log(1);').map((finding) => finding.rule) // ['header', 'console-log']
 */
function lintSource(file, text) {
  const source = { ...readSource(text), file };
  return Object.keys(RULES)
    .filter((rule) => appliesTo(RULES[rule], file))
    .flatMap((rule) => CHECKERS[rule](source).map((found) => ({ file, rule, ...found })))
    .sort((first, second) => first.line - second.line);
}

/**
 * Formats findings as one line each: `file:line  rule  message. Fix: ...`.
 * @param {Finding[]} findings
 * @returns {string[]}
 */
const formatFindings = (findings) => findings.map((finding) => `${finding.file}:${finding.line}  ${finding.rule}  ${finding.message}. Fix: ${RULES[finding.rule].fix}`);

/**
 * Counts findings per file and rule, for `lint --summary`.
 * @param {Finding[]} findings
 * @param {string[]} files every file that was linted, so clean files are listed too
 * @returns {Array<{file: string, total: number, errors: number, byRule: Object<string, number>}>}
 */
const summarize = (findings, files) =>
  files.map((file) => {
    const own = findings.filter((finding) => finding.file === file);
    const byRule = {};
    own.forEach((finding) => (byRule[finding.rule] = (byRule[finding.rule] || 0) + 1));
    return { file, total: own.length, errors: own.filter((finding) => RULES[finding.rule].tier === 'error').length, byRule };
  });

module.exports = { RULES, lintSource, formatFindings, summarize };
