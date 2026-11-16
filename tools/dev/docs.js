/**
 * Dev tools docs: generates the kit's API reference (kit/API.md) from the JSDoc in kit/*.js.
 *
 * Owns:  turning one kit file's text into a module description, and rendering modules as Markdown.
 * Does not own: finding or parsing the JSDoc (source.js), or reading and writing files (dev.js).
 *
 * The reference is generated, never edited, so it cannot drift: a function without JSDoc is listed as
 * undocumented rather than left out, which keeps the gaps visible.
 */
'use strict';

const { readSource, kitExports, parseJsdoc } = require('./source');

/** Characters of a module's opening sentence shown in the module index. */
const INDEX_SUMMARY_LENGTH = 140;

/**
 * @typedef {Object} ModuleDoc
 * @property {string} file file name inside kit/, e.g. 'core.js'
 * @property {string} header the file's opening comment as plain text
 * @property {import('./source').KitExport[]} entries what the file adds to Kit
 * @property {import('./source').ParsedJsdoc[]} types the file's @typedef blocks
 */

/** Plain text of a comment token: markers and the leading ` * ` or `//` of each line removed. */
const commentText = (comment) =>
  comment
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\*|\/\/) ?/, '').replace(/\s+$/, ''))
    .join('\n')
    .trim();

/**
 * Describes one kit file for the reference.
 * @param {string} file file name inside kit/
 * @param {string} text the file's contents
 * @returns {ModuleDoc}
 */
function describeModule(file, text) {
  const source = readSource(text);
  const firstCodeIndex = source.tokens.findIndex((token) => token.type !== 'comment');
  const headerComments = source.tokens.slice(0, firstCodeIndex === -1 ? source.tokens.length : firstCodeIndex);
  // The header is the opening run of comments, minus any JSDoc that documents the first statement itself.
  const header = headerComments.length ? commentText(headerComments[0].value.startsWith('//') ? headerComments.map((comment) => comment.value).join('\n') : headerComments[0].value) : '';
  const types = source.tokens
    .filter((token) => token.type === 'comment' && token.value.startsWith('/**'))
    .map((token) => parseJsdoc(token.value))
    .filter((parsed) => parsed.typedef);
  return { file, header, entries: kitExports(source), types };
}

/** The first sentence of some prose, on one line. */
const firstSentence = (prose) => {
  const flat = prose.replace(/\s+/g, ' ').trim();
  const end = flat.search(/\.(\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
};

/** One Markdown bullet for a documented parameter or property. */
const fieldBullet = ({ name, type, description }) => `- \`${name}\`${type ? ` *${escapeType(type)}*` : ''}${description ? ` - ${description}` : ''}`;

/** Types contain `*`, `|` and `<`, which Markdown would otherwise read as emphasis, a table or a tag. */
const escapeType = (type) => type.replace(/([*_|<>])/g, '\\$1');

/** The Markdown for one exported function or value. `owner` is the factory call that returns it, for members. */
function renderEntry(entry, owner = '') {
  const parsed = entry.jsdoc ? parseJsdoc(entry.jsdoc) : null;
  const signature = entry.kind === 'function' ? `${owner}${entry.name}(${entry.params})` : `${owner}${entry.name}`;
  const summary = parsed ? parsed.summary : entry.lineComment;
  const lines = [`${owner ? '####' : '###'} \`${signature}\``, '', summary || '_Undocumented: add a JSDoc block in the source._', ''];
  if (parsed && parsed.params.length) lines.push(...parsed.params.map(fieldBullet), '');
  if (parsed && parsed.returns) lines.push(`**Returns** ${parsed.returns.type ? `*${escapeType(parsed.returns.type)}* ` : ''}${parsed.returns.description}`.trim(), '');
  if (parsed && parsed.complexity) lines.push(`**Complexity** ${parsed.complexity}`, '');
  if (parsed) parsed.examples.forEach((example) => lines.push('```js', example, '```', ''));
  const members = entry.members.flatMap((member) => renderEntry(member, `${entry.name}()`));
  return [...lines, ...members];
}

/** The Markdown for one @typedef: its name, what it is, and its properties. */
const renderType = (parsed) => [`- **${parsed.typedef.name}**${parsed.summary ? ` - ${firstSentence(parsed.summary)}` : ''}`, ...parsed.properties.map((property) => `  ${fieldBullet(property)}`)];

/** GitHub-style heading anchor for a module's file name. */
const anchorOf = (file) => file.toLowerCase().replace(/[^a-z0-9-]/g, '');

/**
 * Renders the whole reference.
 * @param {ModuleDoc[]} modules in the order they should appear
 * @returns {string} Markdown, ending in a newline
 * @example fs.writeFileSync('kit/API.md', renderApi(files.map((file) => describeModule(file, read(file)))));
 */
function renderApi(modules) {
  const index = modules.map((module) => {
    const summary = firstSentence(module.header).slice(0, INDEX_SUMMARY_LENGTH);
    return `- [${module.file}](#${anchorOf(module.file)}) (${module.entries.length}) - ${summary}`;
  });
  const sections = modules.flatMap((module) => [
    `## ${module.file}`,
    '',
    ...module.header.split('\n').map((line) => `> ${line}`.trimEnd()),
    '',
    ...module.entries.flatMap((entry) => renderEntry(entry)),
    ...(module.types.length ? ['### Types', '', ...module.types.flatMap(renderType), ''] : []),
  ]);
  return [
    '# Kit API reference',
    '',
    'Generated by `node tools/dev.js docs` from the JSDoc in `kit/*.js`. Do not edit: change the JSDoc and regenerate.',
    'Each module lists what it assigns to `Kit`, then what its factories return, then its row and option types.',
    '',
    '## Modules',
    '',
    ...index,
    '',
    ...sections,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

module.exports = { describeModule, renderApi, firstSentence };
