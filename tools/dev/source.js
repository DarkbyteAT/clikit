/**
 * Dev tools source reader: a light JavaScript tokenizer and the few structural questions the lint and the API
 * generator ask of a kit or game file (which functions are assigned to Kit.*, what a factory returns, where a
 * name is declared, what a JSDoc block says).
 *
 * Owns:  tokens with line numbers, bracket matching, the comments attached to each token, Kit.* export discovery
 *        and JSDoc parsing. Everything here is pure: text in, plain data out (unit-tested by tools/test-dev.js).
 * Does not own: any rule about what good code looks like (lint.js) or any output format (docs.js).
 *
 * It is not a parser. It recognises the shapes this codebase uses (classic scripts, arrow functions, object
 * literals, `Kit.name = ...` assignments) and deliberately stays ignorant of everything else.
 */
'use strict';

/** Words after which a `/` starts a regular expression rather than a division. */
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await']);
/** Closing punctuation after which a `/` is a division (a value has just ended). */
const VALUE_ENDINGS = new Set([')', ']', '}']);
/** Multi-character operators, longest first so the scanner never splits one. */
const LONG_PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));

const NUMBER_PATTERN = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?n?/y;
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/y;
const WHITESPACE_PATTERN = /\s+/y;

/**
 * @typedef {Object} Token
 * @property {'comment'|'string'|'template'|'regex'|'number'|'ident'|'punct'} type
 * @property {string} value the exact source text
 * @property {number} line 1-based line of the token's first character
 * @property {number} start offset of the first character in the source text
 * @property {number} end offset just past the last character
 * @property {Token[]} [comments] code tokens only: the comments sitting directly before this token
 * @property {number} [mate] brackets only: index (in `code`) of the matching bracket
 * @property {number} [parent] code tokens only: index (in `code`) of the innermost enclosing opening bracket, or -1
 */

/** Offset just past a quoted string that opens at `from` (backslash escapes are skipped). */
const endOfString = (text, from) => {
  const quote = text[from];
  let index = from + 1;
  while (index < text.length && text[index] !== quote && text[index] !== '\n') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
};

/** Offset just past a template literal that opens at `from`, including any `${ ... }` parts and templates nested in them. */
const endOfTemplate = (text, from) => {
  let index = from + 1;
  while (index < text.length && text[index] !== '`') {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '$' && text[index + 1] === '{') index = endOfTemplateExpression(text, index + 2);
    else index += 1;
  }
  return index + 1;
};

/** Offset just past the `}` that closes a template expression whose body starts at `from`. */
const endOfTemplateExpression = (text, from) => {
  let depth = 1;
  let index = from;
  while (index < text.length && depth > 0) {
    const character = text[index];
    if (character === '`') index = endOfTemplate(text, index);
    else if (character === '"' || character === "'") index = endOfString(text, index);
    else {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      index += 1;
    }
  }
  return index;
};

/** Offset just past a regular expression literal (and its flags) that opens at `from`. */
const endOfRegex = (text, from) => {
  let index = from + 1;
  let isInClass = false;
  while (index < text.length && text[index] !== '\n' && (isInClass || text[index] !== '/')) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '[') isInClass = true;
    else if (text[index] === ']') isInClass = false;
    index += 1;
  }
  index += 1;
  while (/[a-z]/.test(text[index] || '')) index += 1;
  return index;
};

/** Could a `/` after this token start a regular expression? (True when no value has just ended.) */
const allowsRegexAfter = (previous) => {
  if (!previous) return true;
  if (previous.type === 'punct') return !VALUE_ENDINGS.has(previous.value);
  return previous.type === 'ident' && KEYWORDS_BEFORE_REGEX.has(previous.value);
};

/** Reads the token that starts at `from`, given the previous code token (needed to tell a regex from a division). */
const readToken = (text, from, previousCode) => {
  const character = text[from];
  const next = text[from + 1];
  const sticky = (pattern) => {
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    return match ? from + match[0].length : -1;
  };
  if (character === '/' && next === '/') return { type: 'comment', end: text.indexOf('\n', from) === -1 ? text.length : text.indexOf('\n', from) };
  if (character === '#' && next === '!' && from === 0) return { type: 'comment', end: text.indexOf('\n') === -1 ? text.length : text.indexOf('\n') };
  if (character === '/' && next === '*') return { type: 'comment', end: text.indexOf('*/', from + 2) === -1 ? text.length : text.indexOf('*/', from + 2) + 2 };
  if (character === '"' || character === "'") return { type: 'string', end: endOfString(text, from) };
  if (character === '`') return { type: 'template', end: endOfTemplate(text, from) };
  if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(next || ''))) return { type: 'number', end: sticky(NUMBER_PATTERN) };
  if (/[A-Za-z_$]/.test(character)) return { type: 'ident', end: sticky(IDENTIFIER_PATTERN) };
  if (character === '/' && allowsRegexAfter(previousCode)) return { type: 'regex', end: endOfRegex(text, from) };
  const long = LONG_PUNCTUATORS.find((punctuator) => text.startsWith(punctuator, from));
  return { type: 'punct', end: from + (long ? long.length : 1) };
};

/**
 * Splits JavaScript source into tokens, comments included.
 * @param {string} text
 * @returns {Token[]}
 * @example tokenize('const a = 1; // one').map((token) => token.type) // ['ident', 'ident', 'punct', 'number', 'punct', 'comment']
 */
function tokenize(text) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let previousCode = null;
  while (index < text.length) {
    WHITESPACE_PATTERN.lastIndex = index;
    const space = WHITESPACE_PATTERN.exec(text);
    if (space) {
      line += space[0].split('\n').length - 1;
      index += space[0].length;
      continue;
    }
    const { type, end } = readToken(text, index, previousCode);
    const token = { type, value: text.slice(index, end), line, start: index, end };
    tokens.push(token);
    if (type !== 'comment') previousCode = token;
    line += token.value.split('\n').length - 1;
    index = end;
  }
  return tokens;
}

/**
 * @typedef {Object} Source
 * @property {string} text the file's text
 * @property {Token[]} tokens every token, comments included, in order
 * @property {Token[]} code the tokens that are not comments; each knows its `comments`, `parent` and (brackets) `mate`
 */

/**
 * Reads a source file into tokens and annotates the code tokens with their leading comments and bracket structure.
 * @param {string} text
 * @returns {Source}
 */
function readSource(text) {
  const tokens = tokenize(text);
  const code = [];
  let pendingComments = [];
  const openStack = [];
  tokens.forEach((token) => {
    if (token.type === 'comment') {
      pendingComments.push(token);
      return;
    }
    token.comments = pendingComments;
    pendingComments = [];
    const index = code.length;
    const isPunctuation = token.type === 'punct';
    if (isPunctuation && CLOSERS.has(token.value) && openStack.length) {
      // A closer belongs to the bracket it closes, so its parent is that bracket's parent.
      const openIndex = openStack.pop();
      token.mate = openIndex;
      code[openIndex].mate = index;
      token.parent = code[openIndex].parent;
    } else {
      token.parent = openStack.length ? openStack[openStack.length - 1] : -1;
      if (isPunctuation && OPENERS[token.value]) openStack.push(index);
    }
    code.push(token);
  });
  return { text, tokens, code };
}

/** The value of the code token at `index`, or '' past either end (so callers can compare without bounds checks). */
const valueAt = (code, index) => (code[index] ? code[index].value : '');

/** The JSDoc comment directly before a token, or null. The comment that opens the file is its header, never a function's JSDoc. */
const jsdocBefore = (token) => {
  const last = token && token.comments && token.comments[token.comments.length - 1];
  return last && last.value.startsWith('/**') && last.start > 0 ? last : null;
};

/** The text of the `//` comments directly before a token, joined into one line ('' when there are none). */
const lineCommentBefore = (token) =>
  ((token && token.comments) || [])
    .filter((comment) => comment.value.startsWith('//'))
    .map((comment) => comment.value.replace(/^\/\/\s?/, ''))
    .join(' ')
    .trim();

/**
 * @typedef {Object} FunctionShape
 * @property {number} paramsOpen index of the `(` that opens the parameters (or of a lone arrow parameter)
 * @property {number} paramsClose index of the matching `)` (or of the lone arrow parameter)
 * @property {number} bodyOpen index of the body's `{`, or -1 for an arrow function with an expression body
 * @property {number} bodyStart index of the first token of the body
 * @property {boolean} isArrow
 */

/**
 * Describes the function expression or declaration that starts at a code index, if one does.
 * @param {Token[]} code
 * @param {number} index
 * @returns {?FunctionShape}
 */
function functionAt(code, index) {
  let cursor = valueAt(code, index) === 'async' ? index + 1 : index;
  if (valueAt(code, cursor) === 'function') {
    cursor += 1;
    if (valueAt(code, cursor) === '*') cursor += 1;
    if (code[cursor] && code[cursor].type === 'ident') cursor += 1;
    if (valueAt(code, cursor) !== '(') return null;
    const paramsClose = code[cursor].mate;
    return { paramsOpen: cursor, paramsClose, bodyOpen: paramsClose + 1, bodyStart: paramsClose + 1, isArrow: false };
  }
  const isLoneParameter = code[cursor] && code[cursor].type === 'ident' && valueAt(code, cursor + 1) === '=>';
  const paramsClose = isLoneParameter ? cursor : valueAt(code, cursor) === '(' ? code[cursor].mate : -1;
  if (paramsClose === -1 || paramsClose === undefined || valueAt(code, paramsClose + 1) !== '=>') return null;
  const bodyStart = paramsClose + 2;
  return { paramsOpen: cursor, paramsClose, bodyOpen: valueAt(code, bodyStart) === '{' ? bodyStart : -1, bodyStart, isArrow: true };
}

/** Method names and keywords that walk a collection: a function using one has a cost that grows with its input. */
const ITERATION_WORDS = new Set(['map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find', 'findIndex', 'flatMap', 'sort', 'for', 'while']);

/** Index just past the last token of a function's body (a block, or an arrow function's expression). */
const bodyEndIndex = (code, shape) => {
  if (shape.bodyOpen !== -1) return code[shape.bodyOpen].mate + 1;
  const parent = code[shape.bodyStart].parent;
  let index = shape.bodyStart;
  // An expression body runs to the comma or semicolon that ends it, or to the bracket that encloses it.
  while (code[index] && !([',', ';'].includes(code[index].value) && code[index].parent === parent) && index !== (parent === -1 ? -1 : code[parent].mate)) {
    index = code[index].mate > index ? code[index].mate + 1 : index + 1;
  }
  return index;
};

/** Does a function's body walk a collection (a loop, or an array method such as map or reduce)? */
const iteratesCollection = (code, shape) => {
  const end = bodyEndIndex(code, shape);
  for (let index = shape.bodyStart; index < end && code[index]; index++) {
    const token = code[index];
    const isLoop = (token.value === 'for' || token.value === 'while') && valueAt(code, index + 1) === '(' && valueAt(code, index - 1) !== '.';
    const isArrayMethod = valueAt(code, index - 1) === '.' && ITERATION_WORDS.has(token.value) && valueAt(code, index + 1) === '(';
    if (token.type === 'ident' && (isLoop || isArrayMethod)) return true;
  }
  return false;
};

/** The source text of a function's parameter list, without the surrounding parentheses. */
const parameterText = (source, shape) => {
  const { code, text } = source;
  if (shape.paramsOpen === shape.paramsClose) return code[shape.paramsOpen].value;
  return text.slice(code[shape.paramsOpen].end, code[shape.paramsClose].start).replace(/\s+/g, ' ').trim();
};

/**
 * @typedef {Object} Declaration
 * @property {string} name
 * @property {number} keywordIndex index of `const` / `let` / `var` / `function`
 * @property {number} valueIndex index of the first token of the value (the `function` keyword itself for a declaration)
 */

/**
 * Finds every `const name = ...`, `let name = ...` and `function name(...)` in a file.
 * @param {Token[]} code
 * @returns {Map<string, Declaration[]>} declarations by name, in source order
 */
function declarationsOf(code) {
  const byName = new Map();
  const add = (declaration) => byName.set(declaration.name, [...(byName.get(declaration.name) || []), declaration]);
  code.forEach((token, index) => {
    const named = code[index + 1];
    if (!named || named.type !== 'ident' || token.type !== 'ident') return;
    const isVariable = ['const', 'let', 'var'].includes(token.value) && valueAt(code, index + 2) === '=';
    const isFunction = token.value === 'function' && valueAt(code, index + 2) === '(';
    if (isVariable) add({ name: named.value, keywordIndex: index, valueIndex: index + 3 });
    if (isFunction) add({ name: named.value, keywordIndex: index, valueIndex: index });
  });
  return byName;
}

/** The declaration of `name` that a use at `useIndex` most plausibly refers to: the nearest one above it, else the first. */
const resolveDeclaration = (declarations, name, useIndex) => {
  const candidates = declarations.get(name) || [];
  const above = candidates.filter((declaration) => declaration.keywordIndex < useIndex);
  return above[above.length - 1] || candidates[0] || null;
};

/**
 * @typedef {Object} Member
 * @property {string} name
 * @property {number} keyIndex index of the first token of the member (where its comments hang)
 * @property {'method'|'property'|'shorthand'|'accessor'} kind
 * @property {number} valueIndex method: index of its `(`; property: index of the value's first token; else -1
 */

/**
 * Lists the top-level members of the object literal whose `{` is at `openIndex`.
 * @param {Token[]} code
 * @param {number} openIndex
 * @returns {Member[]} spreads and computed keys are skipped
 */
function objectMembers(code, openIndex) {
  const closeIndex = code[openIndex].mate;
  const members = [];
  let index = openIndex + 1;
  while (index < closeIndex) {
    const keyIndex = index;
    let cursor = index;
    const startsModifier = ['get', 'set', 'async'].includes(valueAt(code, cursor)) && code[cursor + 1] && ['ident', 'string'].includes(code[cursor + 1].type);
    const isAccessor = startsModifier && valueAt(code, cursor) !== 'async';
    if (startsModifier) cursor += 1;
    const key = code[cursor];
    const after = valueAt(code, cursor + 1);
    if (['ident', 'string', 'number'].includes(key.type)) {
      const name = key.type === 'string' ? key.value.slice(1, -1) : key.value;
      if (isAccessor) members.push({ name, keyIndex, kind: 'accessor', valueIndex: -1 });
      else if (after === '(') members.push({ name, keyIndex, kind: 'method', valueIndex: cursor + 1 });
      else if (after === ':') members.push({ name, keyIndex, kind: 'property', valueIndex: cursor + 2 });
      else members.push({ name, keyIndex, kind: 'shorthand', valueIndex: -1 });
    }
    // Skip to the comma that ends this member: brackets are jumped over whole, so only top-level commas count.
    while (index < closeIndex && valueAt(code, index) !== ',') index = code[index].mate > index ? code[index].mate + 1 : index + 1;
    index += 1;
  }
  return members;
}

/**
 * The object literal a function returns, if its last top-level `return` gives one (directly, or through a local
 * `const api = { ... }`), or if it is an arrow function whose body is `({ ... })`.
 * @param {Token[]} code
 * @param {FunctionShape} shape
 * @param {Map<string, Declaration[]>} declarations
 * @returns {number} index of the object's `{`, or -1. Returns inside nested blocks are not followed.
 */
function returnedObjectIndex(code, shape, declarations) {
  if (shape.bodyOpen === -1) return valueAt(code, shape.bodyStart) === '(' && valueAt(code, shape.bodyStart + 1) === '{' ? shape.bodyStart + 1 : -1;
  const bodyClose = code[shape.bodyOpen].mate;
  let found = -1;
  for (let index = shape.bodyOpen + 1; index < bodyClose; index++) {
    if (code[index].value !== 'return' || code[index].parent !== shape.bodyOpen) continue;
    if (valueAt(code, index + 1) === '{') found = index + 1;
    const named = code[index + 1];
    const declaration = named && named.type === 'ident' && valueAt(code, index + 2) === ';' ? resolveDeclaration(declarations, named.value, index) : null;
    if (declaration && valueAt(code, declaration.valueIndex) === '{') found = declaration.valueIndex;
  }
  return found;
}

/**
 * @typedef {Object} KitExport
 * @property {string} name full call path, e.g. 'Kit.math.clamp'; a factory's members start with a dot, e.g. '.set'
 * @property {'function'|'value'} kind
 * @property {number} line
 * @property {?string} jsdoc text of the JSDoc block in front of it, or null
 * @property {string} lineComment text of the `//` comments in front of it ('' when none)
 * @property {string} params source of the parameter list ('' for values)
 * @property {boolean} iterates functions only: does the body loop over a collection (so its cost grows with input)?
 * @property {KitExport[]} members what a factory returns (functions only; empty otherwise)
 */

/**
 * Finds what a file adds to the kit: every `Kit.path = ...` assignment, the members of object literals assigned
 * that way, and one level of what each exported factory returns.
 * @param {Source} source
 * @returns {KitExport[]}
 * @example kitExports(readSource('Kit.fmt = (value) => String(value);'))[0].name // 'Kit.fmt'
 */
function kitExports(source) {
  const { code } = source;
  const declarations = declarationsOf(code);

  const describe = (name, docToken, shape, depth) => {
    const docComment = jsdocBefore(docToken);
    const base = { name, line: docToken.line, jsdoc: docComment ? docComment.value : null, lineComment: lineCommentBefore(docToken), params: '', iterates: false, members: [] };
    if (!shape) return { ...base, kind: 'value' };
    const objectIndex = depth > 0 ? returnedObjectIndex(code, shape, declarations) : -1;
    const members = objectIndex === -1 ? [] : membersOf(objectIndex, '', depth - 1).filter((member) => member.kind === 'function');
    return { ...base, kind: 'function', params: parameterText(source, shape), iterates: iteratesCollection(code, shape), members };
  };

  /** A method's shape: its parameter list is followed directly by its body. */
  const methodShape = (paramsOpen) => {
    const paramsClose = code[paramsOpen].mate;
    return { paramsOpen, paramsClose, bodyOpen: paramsClose + 1, bodyStart: paramsClose + 1, isArrow: false };
  };

  const describeMember = (member, prefix, depth) => {
    const name = `${prefix}.${member.name}`;
    const keyToken = code[member.keyIndex];
    if (member.kind === 'method') return describe(name, keyToken, methodShape(member.valueIndex), depth);
    if (member.kind === 'property') return describe(name, keyToken, functionAt(code, member.valueIndex), depth);
    if (member.kind !== 'shorthand') return null;
    const declaration = resolveDeclaration(declarations, member.name, member.keyIndex);
    return declaration ? describe(name, code[declaration.keywordIndex], functionAt(code, declaration.valueIndex), depth) : null;
  };

  const membersOf = (openIndex, prefix, depth) =>
    objectMembers(code, openIndex)
      .map((member) => describeMember(member, prefix, depth))
      // An undocumented plain value (a number, a re-exported table) is not part of the reference.
      .filter((entry) => entry && (entry.kind === 'function' || entry.jsdoc));

  const exportsAt = (index) => {
    if (code[index].value !== 'Kit' || code[index].type !== 'ident' || valueAt(code, index - 1) === '.') return [];
    let cursor = index + 1;
    const path = ['Kit'];
    while (valueAt(code, cursor) === '.' && code[cursor + 1] && code[cursor + 1].type === 'ident') {
      path.push(code[cursor + 1].value);
      cursor += 2;
    }
    if (path.length < 2 || valueAt(code, cursor) !== '=') return [];
    const name = path.join('.');
    const valueIndex = cursor + 1;
    const own = describe(name, code[index], functionAt(code, valueIndex), 1);
    const isNamespace = valueAt(code, valueIndex) === '{';
    const kept = own.kind === 'function' || own.jsdoc ? [own] : [];
    return isNamespace ? [...kept, ...membersOf(valueIndex, name, 1)] : kept;
  };

  return code.flatMap((_token, index) => exportsAt(index));
}

/** Splits a `{type} rest` JSDoc tag body into its type (braces balanced) and the remaining text. */
const takeBracedType = (body) => {
  if (!body.startsWith('{')) return { type: '', rest: body };
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '{') depth += 1;
    if (body[index] === '}') depth -= 1;
    if (depth === 0) return { type: body.slice(1, index).replace(/\s+/g, ' '), rest: body.slice(index + 1).trim() };
  }
  return { type: body.slice(1), rest: '' };
};

/** Splits `name description` (or `[name=default] description`) into its two parts. */
const takeName = (text) => {
  const match = /^(\[[^\]]*\]|\S+)\s*([\s\S]*)$/.exec(text) || [null, '', text];
  return { name: match[1], description: match[2].replace(/\s+/g, ' ').trim() };
};

/**
 * @typedef {Object} ParsedJsdoc
 * @property {string} summary the prose before the first tag
 * @property {Array<{type: string, name: string, description: string}>} params
 * @property {Array<{type: string, name: string, description: string}>} properties
 * @property {?{type: string, description: string}} returns
 * @property {string[]} examples
 * @property {string} complexity the `@complexity` line ('' when the block states none)
 * @property {?{type: string, name: string}} typedef
 * @property {string[]} tagNames every tag that appears, in order
 */

/**
 * Parses one JSDoc block.
 * @param {string} comment the block including its opening and closing markers
 * @returns {ParsedJsdoc}
 * @example parseJsdoc('/** Adds. @param {number} a first *\/').params[0].name // 'a'
 */
function parseJsdoc(comment) {
  const lines = comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').replace(/\s+$/, ''));
  // Tags may also follow prose on the same line in a one-line block: give each tag its own line first.
  const expanded = lines.flatMap((line) => line.split(/\s(?=@(?:param|returns?|example|typedef|property|throws|template|type|complexity)\b)/));
  const sections = [{ tag: '', body: [] }];
  expanded.forEach((line) => {
    const tagMatch = /^\s*@(\w+)\s?(.*)$/.exec(line);
    if (tagMatch) sections.push({ tag: tagMatch[1], body: [tagMatch[2]] });
    else sections[sections.length - 1].body.push(line);
  });
  const parsed = { summary: sections[0].body.join('\n').trim(), params: [], properties: [], returns: null, examples: [], complexity: '', typedef: null, tagNames: [] };
  sections.slice(1).forEach(({ tag, body }) => {
    parsed.tagNames.push(tag);
    const flat = body.join(' ').trim();
    const { type, rest } = takeBracedType(flat);
    if (tag === 'param') parsed.params.push({ type, ...takeName(rest) });
    if (tag === 'property') parsed.properties.push({ type, ...takeName(rest) });
    if (tag === 'returns' || tag === 'return') parsed.returns = { type, description: rest.replace(/\s+/g, ' ') };
    if (tag === 'typedef') parsed.typedef = { type, name: takeName(rest).name };
    // A typedef may describe itself on its tag line (`@typedef {Object} Bag a bag of things`).
    if (tag === 'typedef' && !parsed.summary) parsed.summary = takeName(rest).description;
    if (tag === 'example') parsed.examples.push(body.join('\n').trim());
    if (tag === 'complexity') parsed.complexity = flat.replace(/\s+/g, ' ');
  });
  return parsed;
}

module.exports = {
  tokenize,
  readSource,
  functionAt,
  parameterText,
  declarationsOf,
  resolveDeclaration,
  objectMembers,
  returnedObjectIndex,
  kitExports,
  parseJsdoc,
  jsdocBefore,
  lineCommentBefore,
  valueAt,
};
