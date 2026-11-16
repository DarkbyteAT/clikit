#!/usr/bin/env node
/**
 * Motion strip: draws a moving body as a strip of stick-figure frames into a PNG, in node, with no browser. It
 * exists so movement can be judged by looking at it many times an hour: a browser run on the shared machine
 * takes minutes, this takes a second.
 *
 *   node tools/motion-strip.js --species human --speed 1.4 --out shots/walk.png
 *   node tools/motion-strip.js --species hound --course --frames 12 --every 0.25 --view front
 *
 * Options: --species <id> (a species of the sample catalogue; default human), --seed <n>, --speed <m/s> (a
 * straight line at that speed, after speeding up), --course (instead: start, walk, turn, stop), --from <s>
 * (game seconds before the first frame; default 4), --every <s> (game seconds between frames; default a tenth
 * of a stride), --frames <n> (default 10), --fps <n> (frame rate the motion is advanced at; default 60),
 * --view side|front|quarter|top (default side), --detail <n> (level of detail; default 0), --out <file>.
 *
 * Owns:  a tiny software canvas (thick lines and discs, the methods `Kit.body.debug.draw` uses), a PNG encoder,
 *        and the strip layout: one cell per frame, the camera following the body, ground ticks every quarter
 *        metre fixed in the world, a mark under each planted foot, a cross at the centre of mass.
 * Does not own: the movement (kit/motion.js, kit/gait.js, kit/swim.js) or the stick figure (kit/body-debug.js).
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
  'rig',
  'reach',
  'dynamics',
  'body-plan',
  'body-parts',
  'body-recipe',
  'body-edit',
  'body-store',
  'body-samples',
  'body-debug',
  'motion',
  'gait',
  'swim',
];
/** Layout of the strip, in pixels unless noted. */
const LAYOUT = { cellWidth: 300, cellHeight: 380, groundShare: 0.86, metresTall: 2.1, tickEvery: 0.25, tickLength: 7, plantSize: 7, centerSize: 6 };
const COLORS = { backdrop: '#141a2c', ground: '#3a476c', tick: '#56648f', planted: '#ffd166', swinging: '#5d6b8f', center: '#5ad1a0', divider: '#222a44' };
/** View name -> camera turn about +Y and tilt down, radians. */
const VIEWS = { side: { turn: -Math.PI / 2, tilt: 0 }, front: { turn: 0, tilt: 0 }, quarter: { turn: -1.05, tilt: 0.3 }, top: { turn: -Math.PI / 2, tilt: 1.35 } };
/** The course drawn by --course: start, walk, turn left, walk, stop, stand. */
const COURSE = [
  { seconds: 2.5, speed: 1.4 },
  { seconds: 2, speed: 1.4, turn: 0.8 },
  { seconds: 1.5, speed: 1.4 },
  { seconds: 2, speed: 0 },
];
const DEFAULTS = { species: 'human', seed: 11, speed: 1.4, from: 4, frames: 10, fps: 60, view: 'side', detail: 0, out: path.join('shots', 'motion-strip.png') };
/** Metres per second squared the straight-line body speeds up at. */
const SPEED_UP = 2.5;

/** Loads the kit into this context (not a vm sandbox, which is about ten times slower: DECISIONS.md). */
const loadKit = () => {
  global.window = global;
  KIT_FILES.forEach((name) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'kit', `${name}.js`), 'utf8'), { filename: `${name}.js` }));
  return global.Kit;
};

/**
 * A software canvas with the handful of 2D-context methods the stick figure needs. Lines are drawn as discs
 * stamped along their length: slow and plain, which is all a debug strip needs.
 * @param {number} width pixels
 * @param {number} height pixels
 * @returns {Object} the context, plus `pixels` (RGB, 3 bytes a pixel)
 */
const createCanvas = (width, height) => {
  const pixels = Buffer.alloc(width * height * 3);
  const colorOf = (text) => [1, 3, 5].map((at) => Number.parseInt(text.slice(at, at + 2), 16));
  const disc = (centerX, centerY, radius, color) => {
    for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(height - 1, Math.ceil(centerY + radius)); y++) {
      for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(width - 1, Math.ceil(centerX + radius)); x++) {
        if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius * radius) continue;
        pixels.set(color, (y * width + x) * 3);
      }
    }
  };
  let points = [];
  let circle = null;
  const context = {
    pixels,
    strokeStyle: '#ffffff',
    fillStyle: '#ffffff',
    lineWidth: 1,
    beginPath() {
      points = [];
      circle = null;
    },
    moveTo(x, y) {
      points.push([x, y, false]);
    },
    lineTo(x, y) {
      points.push([x, y, true]);
    },
    closePath() {
      if (points.length) points.push([points[0][0], points[0][1], true]);
    },
    arc(x, y, radius) {
      circle = [x, y, radius];
    },
    stroke() {
      const color = colorOf(context.strokeStyle);
      const radius = Math.max(0.6, context.lineWidth / 2);
      points.forEach(([x, y, isLine], index) => {
        if (!isLine) return;
        const [fromX, fromY] = points[index - 1];
        const length = Math.max(1, Math.ceil(Math.hypot(x - fromX, y - fromY)));
        for (let step = 0; step <= length; step++) disc(fromX + ((x - fromX) * step) / length, fromY + ((y - fromY) * step) / length, radius, color);
      });
      if (circle) for (let angle = 0; angle < 64; angle++) disc(circle[0] + Math.cos(angle / 10.2) * circle[2], circle[1] + Math.sin(angle / 10.2) * circle[2], radius, color);
    },
    fill() {
      if (circle) disc(circle[0], circle[1], circle[2], colorOf(context.fillStyle));
    },
  };
  return context;
};

/** Encodes RGB pixels as a PNG file. */
const encodePng = (width, height, pixels) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

/** Reads `--name value` pairs (a bare `--name` is true) over the defaults. */
const parseOptions = (words) => {
  const options = { ...DEFAULTS };
  words.forEach((word, index) => {
    if (!word.startsWith('--')) return;
    const next = words[index + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    options[word.slice(2)] = typeof DEFAULTS[word.slice(2)] === 'number' ? Number(value) : value;
  });
  return options;
};

/** A straight line at one speed, as a course-shaped object so both kinds of path are driven the same way. */
const straightLine = (speed) => ({ x: 0, z: 0, heading: 0, speed: 0, target: speed });

const main = () => {
  const options = parseOptions(process.argv.slice(2));
  const Kit = loadKit();
  const catalog = Kit.body.catalog(Kit.body.samples.CATALOG);
  const bake = catalog.bakery().bakeRecipe({ species: options.species, seed: options.seed });
  const controller = Kit.motion.when({ atLeast: { legs: 2 } }, Kit.gait.walk(), Kit.swim ? Kit.swim.swim() : undefined);
  const motion = Kit.motion.state(bake, controller, { detail: options.detail });
  const route = options.course ? Kit.motion.course(COURSE) : straightLine(options.speed);
  const dt = 1 / options.fps;
  const moveOn = () => {
    if (options.course) Kit.motion.drive(route, dt);
    else {
      route.speed = Math.min(route.target, route.speed + SPEED_UP * dt);
      route.z += route.speed * dt;
    }
    Kit.motion.advance(motion, dt, route.x, 0, route.z, route.heading);
  };
  for (let frame = 0; frame < Math.round(options.from * options.fps); frame++) moveOn();
  const clock = motion.memory.gait;
  const every = options.every ? Number(options.every) : clock && clock.cadence > 0 ? 1 / clock.cadence / options.frames : 0.1;
  const width = LAYOUT.cellWidth * options.frames;
  const context = createCanvas(width, LAYOUT.cellHeight);
  for (let pixel = 0; pixel < width * LAYOUT.cellHeight; pixel++) context.pixels.set([20, 26, 44], pixel * 3);
  const camera = VIEWS[options.view] || VIEWS.side;
  const view = { centerX: 0, groundY: LAYOUT.cellHeight * LAYOUT.groundShare, scale: (LAYOUT.cellHeight * LAYOUT.groundShare * 0.9) / LAYOUT.metresTall, turn: camera.turn, tilt: camera.tilt };
  const point = [0, 0];
  const balance = { planted: 0, centerX: 0, centerY: 0, centerZ: 0, forwardOutside: 0, sideOutside: 0 };
  const line = (fromX, fromY, toX, toY, color, lineWidth = 1) => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  };
  for (let cell = 0; cell < options.frames; cell++) {
    const left = cell * LAYOUT.cellWidth;
    // The camera follows the body: the cell's centre is where the body's ground point projects to.
    view.centerX = 0;
    Kit.body.debug.project(motion.x, 0, motion.z, view, point);
    view.centerX = left + LAYOUT.cellWidth / 2 - point[0];
    const groundShift = view.groundY - point[1];
    view.groundY += groundShift;
    line(left, LAYOUT.cellHeight * LAYOUT.groundShare, left + LAYOUT.cellWidth - 2, LAYOUT.cellHeight * LAYOUT.groundShare, COLORS.ground, 1);
    line(left + LAYOUT.cellWidth - 1, 0, left + LAYOUT.cellWidth - 1, LAYOUT.cellHeight, COLORS.divider, 1);
    // Ground ticks fixed in the world along the way the body is going: a planted foot must stay on its tick.
    const forwardX = Math.sin(motion.heading);
    const forwardZ = Math.cos(motion.heading);
    const travelled = motion.x * forwardX + motion.z * forwardZ;
    for (let tick = -8; tick <= 8; tick++) {
      const ahead = (Math.round(travelled / LAYOUT.tickEvery) + tick) * LAYOUT.tickEvery - travelled;
      Kit.body.debug.project(motion.x + forwardX * ahead, 0, motion.z + forwardZ * ahead, view, point);
      if (point[0] > left + 2 && point[0] < left + LAYOUT.cellWidth - 3) line(point[0], point[1], point[0], point[1] + LAYOUT.tickLength, COLORS.tick, 1);
    }
    Kit.body.debug.draw(context, motion.plan, motion.world, view, { showSockets: false });
    const feet = Kit.gait ? Kit.gait.feet(motion) : null;
    if (feet) {
      for (let leg = 0; leg < feet.planted.length; leg++) {
        Kit.body.debug.project(feet.footX[leg], 0, feet.footZ[leg], view, point);
        if (point[0] < left + 4 || point[0] > left + LAYOUT.cellWidth - 5) continue;
        const color = feet.planted[leg] ? COLORS.planted : COLORS.swinging;
        line(point[0] - LAYOUT.plantSize, point[1] + LAYOUT.plantSize + 3, point[0], point[1] + 3, color, 2);
        line(point[0] + LAYOUT.plantSize, point[1] + LAYOUT.plantSize + 3, point[0], point[1] + 3, color, 2);
      }
      Kit.gait.support(motion, balance);
      Kit.body.debug.project(balance.centerX, balance.centerY, balance.centerZ, view, point);
      line(point[0] - LAYOUT.centerSize, point[1], point[0] + LAYOUT.centerSize, point[1], COLORS.center, 2);
      line(point[0], point[1] - LAYOUT.centerSize, point[0], point[1] + LAYOUT.centerSize, COLORS.center, 2);
      const centerX = point[0];
      Kit.body.debug.project(balance.centerX, 0, balance.centerZ, view, point);
      line(centerX, point[1] - 2, centerX, point[1] + LAYOUT.tickLength + 6, COLORS.center, 1);
    }
    view.groundY -= groundShift;
    for (let frame = 0; frame < Math.max(1, Math.round(every * options.fps)); frame++) moveOn();
  }
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, encodePng(width, LAYOUT.cellHeight, context.pixels));
  const gaitNote = clock ? `${Kit.gait.GAIT_NAMES[clock.gait]}, stride ${clock.stride.toFixed(2)} m, ${clock.cadence.toFixed(2)} strides/s` : 'no legs';
  console.log(`motion-strip: ${options.species} (${gaitNote}), ${options.frames} frames ${every.toFixed(3)} s apart at ${options.fps} fps -> ${path.resolve(options.out)}`);
};

if (require.main === module) main();
