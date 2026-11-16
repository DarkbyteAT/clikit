/**
 * Kit paint: flat scenery painted by hand in the tones of a palette, as data. A book collects quads, each with
 * its own ramp and tone, and becomes one mesh of the look's stamp path (kit/look-toon.js `LookPart.stamps`):
 * a backdrop, a stand, a shop front or a pitch is then one draw call however many colours it uses, and a
 * recolour is a palette write. With it comes a small pixel face for lettering signs.
 *
 * Owns:  `Kit.paint.TONE` (the tones a painter picks from), `Kit.paint.book` (quads, floors, walls, discs,
 *        lettering -> flat arrays), `Kit.paint.GLYPHS` and `Kit.paint.runs` (a word as runs of lit dots),
 *        and `Kit.paint.geometry` (the arrays as a THREE.BufferGeometry ready to dress with `{ stamps: true }`).
 * Does not own: colour (kit/palette.js: a ramp is a row of an atlas, named here only by its slot), the look
 *        (kit/look-*.js), lit or outlined forms (dress an ordinary mesh for those), or what is painted
 *        (kit/stadium.js lays out a sports ground with it; a game lays out its own scenery).
 *
 * Conventions: metres, +Y up. A quad is seen from both sides when its mesh's material is double sided.
 *
 * Pure but for `geometry`, which needs THREE when called: the rest runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const POSITION = 3;
  /** Numbers per vertex of a stamp's paint (ramp slot, tone, size rule, order) and of its centre (x, y, z, half extent). */
  const PAINT = 4;
  /** Corners of a quad as two triangles. */
  const QUAD_CORNERS = [0, 1, 2, 0, 2, 3];
  const TURN = Math.PI * 2;

  /**
   * Where a painted surface sits along its ramp, 0 (its darkest tone) .. 1 (lightest). Paint is never lit: these
   * are the tones a pixel artist picks by hand. `base` is the ramp's own colour at every tone count.
   */
  const TONE = Object.freeze({ darkest: 0, dark: 0.18, shade: 0.34, base: 0.5, light: 0.8 });

  /**
   * A 3 x 5 pixel face, capitals and digits: five rows of three, row by row from the top, '1' is paint.
   * Enough for a sign, a scoreboard or a shirt number; not for prose.
   */
  const GLYPHS = Object.freeze({
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '111101101101111', P: '110101110100100',
    Q: '010101101011001', R: '110101110101101', S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001', 5: '111100110001110',
    6: '011100110101010', 7: '111001010010010', 8: '010101010101010', 9: '010101011001110', ' ': '000000000000000',
  });
  /** The face's cell: dots across and down a glyph, and the dots from one glyph's left edge to the next. */
  const FACE = Object.freeze({ columns: 3, rows: 5, advance: 4 });

  const fail = (where, message) => {
    throw new Error(`Kit.paint.${where}: ${message}`);
  };

  /**
   * The lit runs of a word in the pixel face: each run is a row and the first and last column of a stretch of
   * paint, so a word costs a quad per run, not per dot.
   * @param {string} word characters of `GLYPHS`
   * @returns {{runs: Array<{row: number, from: number, to: number}>, columns: number, rows: number}} `columns`: the word's width in dots
   * @throws {Error} naming a character the face does not have
   * @complexity O(characters)
   * @example Kit.paint.runs('TEA').columns // 11
   */
  const runs = (word) => {
    const letters = [...String(word)];
    const missing = letters.find((letter) => !GLYPHS[letter]);
    if (missing !== undefined) fail('runs', `the pixel face has no "${missing}" (in "${word}"). It has: ${Object.keys(GLYPHS).join('')}`);
    const columns = Math.max(0, letters.length * FACE.advance - 1);
    const isLit = (row, column) => column % FACE.advance < FACE.columns && GLYPHS[letters[Math.floor(column / FACE.advance)]][row * FACE.columns + (column % FACE.advance)] === '1';
    const found = [];
    for (let row = 0; row < FACE.rows; row++) {
      for (let column = 0; column < columns; column++) {
        if (!isLit(row, column)) continue;
        const from = column;
        while (column + 1 < columns && isLit(row, column + 1)) column++;
        found.push({ row, from, to: column });
      }
    }
    return { runs: found, columns, rows: FACE.rows };
  };

  /**
   * @typedef {Object} PaintBook
   * @property {function(number[][], string, number): PaintBook} quad four corners [x, y, z] in order round it, a ramp, a tone
   * @property {function(number, number, number, number, number, string, number): PaintBook} floor a level
   *   rectangle: fromX, toX, fromZ, toZ, y, ramp, tone
   * @property {function(number, number, number, number, number, string, number): PaintBook} wall an upright
   *   rectangle across x: fromX, toX, fromY, toY, z, ramp, tone
   * @property {function(Object): PaintBook} disc a level disc of rings: `{ x, y, z, rings: [[radius, ramp, tone]...], sides, squash? }`
   * @property {function(Object): PaintBook} word lettering on a wall: `{ text, x, y, z, dot, ramp, tone, reads? }`,
   *   centred on (x, y); `reads` is 1 when a viewer looking along -z reads it (the default) and -1 when the viewer looks along +z
   * @property {function(): number} quads how many quads the book holds
   * @property {function(): {positions: number[], paints: number[]}} arrays 3 numbers per vertex, and 4 (slot, tone, 0, 0)
   */

  /**
   * Opens a book of painted quads.
   * @param {function(string): number} slotOf a ramp's name -> its row past the block's first row (`LookPart.blockRow`)
   * @returns {PaintBook}
   * @complexity O(1) per quad; a word is O(runs), a disc O(rings x sides)
   * @example
   * const book = Kit.paint.book((ramp) => rows[ramp] - rows.grass);
   * book.floor(-5, 5, -5, 5, 0, 'grass', Kit.paint.TONE.base).word({ text: 'TEA', x: 0, y: 1, z: -5, dot: 0.1, ramp: 'sign', tone: Kit.paint.TONE.light });
   * const mesh = new THREE.Mesh(Kit.paint.geometry(book));
   * view.shading.dress(mesh, { ramp: rows.grass, stamps: true, blockRow: rows.grass, inkGroup: 0 });
   */
  const book = (slotOf) => {
    const positions = [], paints = [];
    const self = {
      quad(corners, ramp, tone) {
        const slot = slotOf(ramp);
        if (!Number.isFinite(slot)) fail('book.quad', `no slot for the ramp "${ramp}".`);
        QUAD_CORNERS.forEach((corner) => {
          positions.push(corners[corner][0], corners[corner][1], corners[corner][2]);
          paints.push(slot, tone, 0, 0);
        });
        return self;
      },
      floor: (fromX, toX, fromZ, toZ, y, ramp, tone) => self.quad([[fromX, y, toZ], [toX, y, toZ], [toX, y, fromZ], [fromX, y, fromZ]], ramp, tone),
      wall: (fromX, toX, fromY, toY, z, ramp, tone) => self.quad([[fromX, fromY, z], [toX, fromY, z], [toX, toY, z], [fromX, toY, z]], ramp, tone),
      disc({ x = 0, y = 0, z = 0, rings, sides, squash = 1 }) {
        const at = (angle, radius) => [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius * squash];
        rings.forEach(([radius, ramp, tone], ring) => {
          const inner = ring === 0 ? 0 : rings[ring - 1][0];
          for (let side = 0; side < sides; side++) {
            const [from, to] = [side, side + 1].map((step) => (step / sides) * TURN);
            self.quad([at(from, inner), at(to, inner), at(to, radius), at(from, radius)], ramp, tone);
          }
        });
        return self;
      },
      word({ text, x, y, z, dot, ramp, tone, reads = 1 }) {
        const lettering = runs(text);
        const [width, top] = [lettering.columns * dot, y + (lettering.rows / 2) * dot];
        lettering.runs.forEach(({ row, from, to }) => {
          const [fromX, toX] = [from, to + 1].map((column) => x + reads * (column * dot - width / 2));
          self.wall(fromX, toX, top - (row + 1) * dot, top - row * dot, z, ramp, tone);
        });
        return self;
      },
      quads: () => positions.length / (POSITION * QUAD_CORNERS.length),
      arrays: () => ({ positions, paints }),
    };
    return self;
  };

  /**
   * A book as a geometry for the look's stamp path: positions, a normal (paint is never lit, but the look wants
   * one), `stampPaint` and `stampCentre`.
   * @param {PaintBook} painted
   * @returns {THREE.BufferGeometry} dress its mesh with `{ stamps: true, blockRow, inkGroup: 0 }`
   * @complexity O(vertices)
   */
  const geometry = (painted) => {
    const { positions, paints } = painted.arrays();
    const count = positions.length / POSITION;
    const made = new THREE.BufferGeometry();
    made.setAttribute('position', new THREE.Float32BufferAttribute(positions, POSITION));
    made.setAttribute('normal', new THREE.Float32BufferAttribute(Float32Array.from({ length: count * POSITION }, (_zero, index) => (index % POSITION === 1 ? 1 : 0)), POSITION));
    made.setAttribute('stampPaint', new THREE.Float32BufferAttribute(paints, PAINT));
    // A stamp may be grown about its centre; paint never is, so each vertex is its own centre.
    made.setAttribute('stampCentre', new THREE.Float32BufferAttribute(Float32Array.from({ length: count * PAINT }, (_zero, index) => (index % PAINT === POSITION ? 1 : positions[Math.floor(index / PAINT) * POSITION + (index % PAINT)])), PAINT));
    return made;
  };

  Kit.paint = { TONE, GLYPHS, FACE, runs, book, geometry };
})();
