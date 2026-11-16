#!/usr/bin/env node
/**
 * Draws wardrobe characters to a PNG without a browser, so catalogue data (proportions, garments, faces) can be
 * judged in seconds:
 *
 *   node tools/figure-preview.js shots/preview.png [--preset toon|pixel] [--rolls 12] [--seed 20261116]
 *        [--framing body|head] [--yaw 20] [--cell 300x420] [--columns 7] [--recipe '{"species":"person","seed":1}']
 *
 * Owns:  a small software rasteriser that follows the look's rules on the CPU: the figure layout's pieces under
 *        the rest pose, tone bands on n.L with the key light, region maps read per fragment (the same pooled
 *        four-texel read as the shader), shells, stamps with their least sizes, and the indexed pipeline's ink
 *        rules (silhouette, depth step between and within ink groups, line classes); and a PNG encoder.
 * Does not own: the look itself (kit/look-*.js: this is an approximation of it, good for shapes, proportions,
 *        colours and where lines fall; hull outlines, soft bands and dither anchoring are not reproduced), the
 *        layout (kit/figure-layout.js) or the catalogue (kit/body-wardrobe.js).
 *
 * A picture from here is a sketch for the author, never evidence that the page looks right: that takes the
 * `portrait` screen in a browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const KIT_FILES = [
  'core',
  'blend',
  'lineage',
  'flags',
  'columns',
  'seeded',
  'pack',
  'palette',
  'surface',
  'region',
  'rig',
  'reach',
  'dynamics',
  'body-plan',
  'body-parts',
  'body-surface',
  'body-recipe',
  'body-edit',
  'body-wardrobe',
  'look-settings',
  'figure-shapes',
  'figure-layout',
];
const DEFAULTS = { preset: 'toon', rolls: 12, seed: 20261116, framing: 'body', yaw: 0, cell: '300x420', columns: 7 };
/** The look's constants this sketch mirrors (kit/look-toon.js, kit/look-ink.js). */
const KEY_LIGHT = [-0.45, 0.75, 0.5];
const RIM = { maxFacing: 0.32, minLight: 0.25 };
const GLINT_EDGE = 0.93;
const INK_DEPTH_STEP = { betweenGroups: 0.035, withinGroup: 0.22 };
const STAMP_MOST_GROWTH = 2.5;
/** Per preset: tones, dither strength, rim, and screen pixels per texel in this sketch. */
const PRESETS = { toon: { toneCount: 3, dither: 0, rim: false, scale: 1, lineReach: 2 }, pixel: { toneCount: 4, dither: 0.12, rim: true, scale: 4, lineReach: 1 } };
const CAMERA_PITCH_DEGREES = 8;
const BACKDROP = [106, 115, 153];
/** A head-and-shoulders window: metres above and below the head bone's joint, as shares of the head's length. */
const HEAD_WINDOW = { below: 0.55, above: 1.45 };
const VECTOR = 3;
const MAP_OWN = 255;
const EMPTY = -1;

/** Loads the pure kit files into one sandbox, as tools/test-kit.js does, and returns its `Kit`. */
function loadKit() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('var Kit = {};', sandbox);
  KIT_FILES.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` }));
  return sandbox.Kit;
}

// ---- PNG -------------------------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const frame = Buffer.alloc(8 + body.length);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), 4 + body.length);
  return frame;
};

/**
 * Encodes RGB bytes as a PNG.
 * @param {Uint8Array} rgb 3 bytes per pixel, top row first
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgb, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) Buffer.from(rgb.buffer, rgb.byteOffset + row * width * 3, width * 3).copy(rows, row * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- the rasteriser --------------------------------------------------------------------------------------------------

/** One byte of a region map texel, with the around axis wrapping and the along axis clamped (the shader's regionTap). */
const tapOf = (map, column, row) => (((Math.min(map.height - 1, Math.max(0, row)) * map.width + (((column % map.width) + map.width) % map.width)) * 4) | 0);

/**
 * The texel of a region map that holds the most bilinear weight round a point, texels of equal kind pooling
 * theirs: the shader's `regionAt` (kit/look-toon.js).
 * @returns {number} the byte offset of that texel in `map.data`
 */
function regionAt(map, u, v) {
  const [texelX, texelY] = [u * map.width - 0.5, v * map.height - 0.5];
  const [cellX, cellY] = [Math.floor(texelX), Math.floor(texelY)];
  const [shareX, shareY] = [texelX - cellX, texelY - cellY];
  const taps = [tapOf(map, cellX, cellY), tapOf(map, cellX + 1, cellY), tapOf(map, cellX, cellY + 1), tapOf(map, cellX + 1, cellY + 1)];
  const weights = [(1 - shareX) * (1 - shareY), shareX * (1 - shareY), (1 - shareX) * shareY, shareX * shareY];
  const isSame = (first, second) => [0, 1, 2].every((channel) => map.data[first + channel] === map.data[second + channel]);
  let [best, most] = [taps[0], -1];
  taps.forEach((tap) => {
    const pooled = taps.reduce((sum, other, index) => sum + (isSame(tap, other) ? weights[index] : 0), 0);
    if (pooled > most) [best, most] = [tap, pooled];
  });
  return best;
}

/**
 * Draws one figure into a cell's index buffers.
 * @param {Object} Kit
 * @param {Object} cell `{ width, height, depth, row, tone, group, inkClass }` buffers of width x height texels
 * @param {Object} bake
 * @param {{framing: string, yaw: number, preset: Object, figureIndex: number}} options
 */
function drawFigure(Kit, cell, bake, { framing, yaw, preset, figureIndex }) {
  const layout = Kit.figure.layout(bake);
  const world = Kit.body.worldTransforms(bake.plan, bake.rest, Kit.body.createPose(bake.plan));
  const arraysOf = (piece) => Kit.figure.buildShape(piece.shape, layout.level);
  const measured = Kit.figure.measureRest(layout, world, (piece) => arraysOf(piece).positions);
  const pitch = (CAMERA_PITCH_DEGREES * Math.PI) / 180;
  const [cosYaw, sinYaw, cosPitch, sinPitch] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  /** World -> view: turn the figure about its middle, then tip the camera down. x right, y up, z toward the viewer. */
  const toView = (x, y, z, isDirection) => {
    const [centredX, centredZ] = isDirection ? [x, z] : [x - measured.centerX, z - measured.centerZ];
    const [turnedX, turnedZ] = [centredX * cosYaw + centredZ * sinYaw, -centredX * sinYaw + centredZ * cosYaw];
    return [turnedX, y * cosPitch - turnedZ * sinPitch, turnedZ * cosPitch + y * sinPitch];
  };
  const head = bake.plan.boneNames.indexOf('head');
  const headY = head >= 0 ? world.translation[head * VECTOR + 1] : measured.highestY;
  const headLength = measured.highestY - headY;
  const window =
    framing === 'head'
      ? { bottom: (headY - headLength * HEAD_WINDOW.below) * cosPitch, top: (headY + headLength * HEAD_WINDOW.above) * cosPitch }
      : { bottom: (measured.lowestY - 0.06) * cosPitch, top: (measured.lowestY + Math.max(measured.highestY - measured.lowestY, 1.25) * 1.12) * cosPitch };
  const texelWorld = (window.top - window.bottom) / cell.height;
  const light = KEY_LIGHT.map((value) => value / Math.hypot(...KEY_LIGHT));
  const halfway = [light[0], light[1], light[2] + 1].map((value, _index, vector) => value / Math.hypot(...vector));
  const edges = Kit.look.BAND_EDGES[preset.toneCount];
  const lightest = preset.toneCount - 1;
  const matrix = new Float32Array(16);

  layout.pieces.forEach((piece) => {
    const arrays = arraysOf(piece);
    Kit.figure.writeBoneMatrix(world, piece.bone, matrix);
    const count = arrays.positions.length / VECTOR;
    const view = new Float32Array(count * VECTOR);
    const viewNormal = new Float32Array(count * VECTOR);
    // Normals go through the inverse transpose: the bone matrix with each column divided by its squared length.
    const columnScale = [0, 1, 2].map((column) => 1 / (matrix[column * 4] ** 2 + matrix[column * 4 + 1] ** 2 + matrix[column * 4 + 2] ** 2));
    for (let vertex = 0; vertex < count; vertex++) {
      let [x, y, z] = [arrays.positions[vertex * 3], arrays.positions[vertex * 3 + 1], arrays.positions[vertex * 3 + 2]];
      if (arrays.paint) {
        // A stamp layer smaller than its least size in texels is grown about its centre (the shader's stampGrowth).
        const growth = Math.min(STAMP_MOST_GROWTH, Math.max(1, (arrays.paint[vertex * 3 + 2] * texelWorld) / Math.max(2 * arrays.centres[vertex * 4 + 3], 1e-5)));
        const centre = [arrays.centres[vertex * 4], arrays.centres[vertex * 4 + 1], arrays.centres[vertex * 4 + 2]];
        [x, y, z] = [centre[0] + (x - centre[0]) * growth, centre[1] + (y - centre[1]) * growth, centre[2] + (z - centre[2]) * growth];
      }
      const worldPoint = [0, 1, 2].map((axis) => matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis]);
      view.set(toView(worldPoint[0], worldPoint[1], worldPoint[2], false), vertex * 3);
      const [nx, ny, nz] = [arrays.normals[vertex * 3] * columnScale[0], arrays.normals[vertex * 3 + 1] * columnScale[1], arrays.normals[vertex * 3 + 2] * columnScale[2]];
      const worldNormal = [0, 1, 2].map((axis) => matrix[axis] * nx + matrix[4 + axis] * ny + matrix[8 + axis] * nz);
      viewNormal.set(toView(worldNormal[0], worldNormal[1], worldNormal[2], true), vertex * 3);
    }
    const map = piece.regions;
    const end = map ? map.end : null;
    const endSquared = end ? end[0] ** 2 + end[1] ** 2 + end[2] ** 2 || 1 : 1;
    const fixedTone = piece.tone === undefined ? -1 : Math.floor(piece.tone * lightest + 0.5);
    const toColumn = (viewX) => viewX / texelWorld + cell.width / 2;
    const toRow = (viewY) => (window.top - viewY) / texelWorld;

    for (let corner = 0; corner < arrays.indices.length; corner += 3) {
      const [a, b, c] = [arrays.indices[corner], arrays.indices[corner + 1], arrays.indices[corner + 2]];
      const [ax, ay, bx, by, cx, cy] = [toColumn(view[a * 3]), toRow(view[a * 3 + 1]), toColumn(view[b * 3]), toRow(view[b * 3 + 1]), toColumn(view[c * 3]), toRow(view[c * 3 + 1])];
      // Screen y grows downward, so a triangle facing the viewer (counter-clockwise in view space) has a negative area here.
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (area >= 0) continue;
      const [minColumn, maxColumn] = [Math.max(0, Math.floor(Math.min(ax, bx, cx))), Math.min(cell.width - 1, Math.ceil(Math.max(ax, bx, cx)))];
      const [minRow, maxRow] = [Math.max(0, Math.floor(Math.min(ay, by, cy))), Math.min(cell.height - 1, Math.ceil(Math.max(ay, by, cy)))];
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const [px, py] = [column + 0.5, row + 0.5];
          const weightA = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
          const weightB = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
          const weightC = 1 - weightA - weightB;
          if (weightA < 0 || weightB < 0 || weightC < 0) continue;
          const mix = (values, stride, axis) => values[a * stride + axis] * weightA + values[b * stride + axis] * weightB + values[c * stride + axis] * weightC;
          const depth = mix(view, 3, 2);
          const at = row * cell.width + column;
          if (cell.row[at] !== EMPTY && depth <= cell.depth[at]) continue;
          let slot = piece.ramp;
          let inkClass = piece.ramp;
          if (map) {
            const local = [0, 1, 2].map((axis) => mix(arrays.positions, 3, axis));
            const along = Math.min(1, Math.max(0, (local[0] * end[0] + local[1] * end[1] + local[2] * end[2]) / endSquared));
            const texel = regionAt(map, Math.atan2(local[map.side], local[map.front]) / (Math.PI * 2) + 0.5, along);
            if (piece.stamps) {
              if (map.data[texel + 3] & 1) continue;
            } else {
              if (piece.shell && map.data[texel + 2] !== piece.shell) continue;
              if (map.data[texel] !== MAP_OWN) slot = map.data[texel];
              if (map.data[texel + 1] !== MAP_OWN) inkClass = map.data[texel + 1];
            }
          }
          const normal = [mix(viewNormal, 3, 0), mix(viewNormal, 3, 1), mix(viewNormal, 3, 2)];
          const size = Math.hypot(...normal) || 1;
          const facing = normal[2] / size;
          let lit = (normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]) / size + (Kit.look.bayerAt(column, cell.height - row) - 0.46875) * preset.dither;
          let tone = Kit.look.bandOf(lit, edges);
          if (preset.rim && facing < RIM.maxFacing && lit > RIM.minLight) tone = Math.min(tone + 1, lightest);
          if (piece.shiny && (normal[0] * halfway[0] + normal[1] * halfway[1] + normal[2] * halfway[2]) / size > GLINT_EDGE) tone = lightest;
          if (piece.emissive) tone = lightest;
          if (fixedTone >= 0) tone = fixedTone;
          if (piece.stamps) {
            slot = mix(arrays.paint, 3, 0) | 0;
            tone = Math.floor(mix(arrays.paint, 3, 1) * lightest + 0.5);
          }
          cell.depth[at] = depth;
          cell.row[at] = figureIndex * 16 + slot;
          cell.tone[at] = tone;
          cell.group[at] = piece.inkGroup;
          cell.inkClass[at] = inkClass;
        }
      }
    }
  });
}

/**
 * Resolves a cell's index buffers to colour with the indexed pipeline's ink rules (kit/look-ink.js).
 * @returns {Uint8Array} RGB, 3 bytes per texel
 */
function resolveCell(cell, colours, preset) {
  const rgb = new Uint8Array(cell.width * cell.height * 3);
  const offsets = [];
  for (let reach = 1; reach <= preset.lineReach; reach++) offsets.push([reach, 0], [-reach, 0], [0, reach], [0, -reach]);
  for (let row = 0; row < cell.height; row++) {
    for (let column = 0; column < cell.width; column++) {
      const at = row * cell.width + column;
      const isEmpty = cell.row[at] === EMPTY;
      let [inkRow, inkDepth] = [EMPTY, -Infinity];
      offsets.forEach(([dx, dy]) => {
        const [otherColumn, otherRow] = [column + dx, row + dy];
        if (otherColumn < 0 || otherRow < 0 || otherColumn >= cell.width || otherRow >= cell.height) return;
        const other = otherRow * cell.width + otherColumn;
        if (cell.row[other] === EMPTY || cell.group[other] === 0) return;
        // Depth here grows toward the viewer, so the neighbour leads when its depth is larger.
        const lead = cell.depth[other] - cell.depth[at];
        const isSameGroup = cell.group[other] === cell.group[at];
        const isOverSurface = !isEmpty && cell.group[at] > 0 && lead > (isSameGroup ? INK_DEPTH_STEP.withinGroup : INK_DEPTH_STEP.betweenGroups);
        const isOverClass = !isEmpty && cell.group[at] > 0 && cell.inkClass[other] > cell.inkClass[at] && Math.abs(lead) <= INK_DEPTH_STEP.betweenGroups;
        if ((isEmpty || isOverSurface || isOverClass) && cell.depth[other] > inkDepth) [inkRow, inkDepth] = [cell.row[other], cell.depth[other]];
      });
      const colour = inkRow !== EMPTY ? colours[inkRow].ink : isEmpty ? BACKDROP : colours[cell.row[at]].tones[cell.tone[at]];
      rgb.set(colour, at * 3);
    }
  }
  return rgb;
}

/**
 * Draws characters into one image, a cell each.
 * @param {Object} Kit
 * @param {Object[]} bakes
 * @param {{preset: string, framing: string, yaw: number, cellWidth: number, cellHeight: number, columns: number}} options
 * @returns {{rgb: Uint8Array, width: number, height: number}}
 */
function drawSheet(Kit, bakes, { preset: presetId, framing, yaw, cellWidth, cellHeight, columns }) {
  const preset = PRESETS[presetId];
  const rows = Math.ceil(bakes.length / columns);
  const [width, height] = [cellWidth * columns, cellHeight * rows];
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) rgb.set(BACKDROP, pixel * 3);
  const [texelsWide, texelsHigh] = [Math.floor(cellWidth / preset.scale), Math.floor(cellHeight / preset.scale)];
  bakes.forEach((bake, index) => {
    const cell = {
      width: texelsWide,
      height: texelsHigh,
      depth: new Float32Array(texelsWide * texelsHigh),
      row: new Int16Array(texelsWide * texelsHigh).fill(EMPTY),
      tone: new Uint8Array(texelsWide * texelsHigh),
      group: new Uint8Array(texelsWide * texelsHigh),
      inkClass: new Uint8Array(texelsWide * texelsHigh),
    };
    drawFigure(Kit, cell, bake, { framing, yaw, preset, figureIndex: 0 });
    const colours = bake.ramps.map((ramp) => Kit.palette.tones(ramp, preset.toneCount));
    const resolved = resolveCell(cell, colours, preset);
    const [left, top] = [(index % columns) * cellWidth, Math.floor(index / columns) * cellHeight];
    // Whole-number upscale, as the look's last pass does.
    for (let y = 0; y < texelsHigh * preset.scale; y++) {
      for (let x = 0; x < texelsWide * preset.scale; x++) {
        const from = (Math.floor(y / preset.scale) * texelsWide + Math.floor(x / preset.scale)) * 3;
        rgb.set(resolved.subarray(from, from + 3), ((top + y) * width + left + x) * 3);
      }
    }
  });
  return { rgb, width, height };
}

/** The recipes the `portrait` screen shows: the default person (every dial at its default, plain clothes), then seeded rolls. */
function castRecipes(Kit, catalog, rolls, seed) {
  const editor = Kit.body.editor(catalog);
  const base = Kit.body.wardrobe.DEFAULT_PERSON || { species: 'person', seed: 1, overrides: {} };
  const person = editor.schema(base).dials.reduce((recipe, dial) => editor.setDial(recipe, dial.id, dial.default), base);
  const table = catalog.table(catalog.speciesIds().map((species) => ({ species })));
  return [person, ...Array.from({ length: rolls }, (_unused, index) => table.roll(seed, index))];
}

function main(args) {
  const [out, ...rest] = args;
  if (!out) throw new Error('where to? Usage: node tools/figure-preview.js <out.png> [--preset toon|pixel] [--rolls 12] [--seed n] [--framing body|head] [--yaw degrees] [--cell WxH] [--columns n] [--recipe json]');
  const flags = { ...DEFAULTS };
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, '')] = rest[index + 1];
  if (!PRESETS[flags.preset]) throw new Error(`no preset "${flags.preset}". Presets: ${Object.keys(PRESETS).join(', ')}.`);
  const Kit = loadKit();
  const catalog = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const bakery = catalog.bakery();
  const recipes = flags.recipe ? [].concat(JSON.parse(flags.recipe)) : castRecipes(Kit, catalog, Number(flags.rolls), Number(flags.seed));
  const [cellWidth, cellHeight] = String(flags.cell).split('x').map(Number);
  const startedAt = Date.now();
  const sheet = drawSheet(Kit, recipes.map((recipe) => bakery.bakeRecipe(recipe)), {
    preset: flags.preset,
    framing: flags.framing,
    yaw: (Number(flags.yaw) * Math.PI) / 180,
    cellWidth,
    cellHeight,
    columns: Math.min(Number(flags.columns), recipes.length),
  });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodePng(sheet.rgb, sheet.width, sheet.height));
  console.log(`figure-preview: ${recipes.length} characters, ${flags.preset}, ${flags.framing}, ${sheet.width}x${sheet.height} in ${Date.now() - startedAt} ms -> ${out}`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { loadKit, encodePng, regionAt, drawSheet, castRecipes };
