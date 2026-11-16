/**
 * Kit stadium: a sports ground dressed from data. One row of numbers describes an end (terraces with aisles
 * and rails, a back wall, a roof on pillars, advertising boards with lettering, floodlights, a banded sky with
 * clouds) and another the playing surface (mown stripes, texture, worn patches, painted lines); each is
 * painted into a `Kit.paint` book, so an end is one draw call and a ground is a palette. Who sits where, and
 * the flat cards each spectator is made of, come as plain data for an instanced mesh.
 *
 * Owns:  `Kit.stadium.RAMPS` (the ramp names a ground's palette must have), `Kit.stadium.END`,
 *        `Kit.stadium.SURFACE` and `Kit.stadium.CROWD` (the default rows), `Kit.stadium.end` (paint an end,
 *        return its seats), `Kit.stadium.surface` (paint a pitch, court or track), `Kit.stadium.cards` (a
 *        spectator as cards) and `Kit.stadium.lift` (how a spectator bobs and jumps).
 * Does not own: paint itself (kit/paint.js), colour (a game's palette, under the names of `RAMPS`), the meshes
 *        (the caller makes one from each book with `Kit.paint.geometry`, and an instanced quad for the crowd),
 *        lit things that stand on the ground (goals, balls, people), or the rules of any sport.
 *
 * Conventions: metres, +Y up. An end stands behind an edge of the playing surface that runs along x; `place`
 * says where that edge is (`edge`, a z) and which way the surface lies from it (`toward`, 1 for +z or -1).
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const { TONE } = Kit.paint;
  const { lerp } = Kit.math;
  const TURN = Math.PI * 2;
  /** Slack when counting how many whole stripes fit a length. */
  const EPSILON = 1e-6;

  /**
   * The ramps a ground's palette must name. `skin0..`, `hair0..`, `crowd0..` and `scarf0..` are runs (their
   * counts are in `CROWD.colors`) and each run's rows must be consecutive, because a spectator's card reaches
   * its ramp by an index from the run's first.
   */
  const RAMPS = Object.freeze({
    surface: ['grass', 'stripe', 'worn', 'line'],
    end: ['stand', 'step', 'rail', 'roof', 'board', 'boardAlt', 'flag', 'sky', 'haze', 'cloud', 'glow', 'lamp'],
    crowd: ['skin', 'hair', 'crowd', 'scarf'],
  });

  /**
   * An end of a ground. Distances `behind` are from the edge of the playing surface, away from it.
   * `glow` is the halo round a floodlight: give it the sky's own colour where the lamps are off and the halo
   * is not there (the lamps stand in the sky band painted in the sky ramp's own colour for exactly that).
   */
  const END = Object.freeze({
    boards: { behind: 3.4, height: 0.8, width: 3.2, gap: 0.1, count: 12, trim: 0.08, dot: 0.11, mark: 0.22, words: ['PIES', 'TAXI', 'TEA', 'BIKES', 'FISH', 'CAFE', 'PAINT', 'BREAD', 'RADIO', 'HATS', 'KEYS', 'CAKE'] },
    stand: { behind: 4.6, tiers: 8, rise: 0.55, run: 0.8, halfWidth: 17 },
    aisle: { every: 6.8, width: 0.55 },
    rail: { height: 0.4, bar: 0.09, post: 0.1, every: 3.4, midTier: 4 },
    backWall: { height: 1.6, band: 0.35 },
    roof: { lift: 3.1, reach: 4.2, fascia: 0.7, trim: 0.14, pillar: 0.22, pillarEvery: 8.5 },
    seat: { spacing: 0.72, setBack: 0.45, jitter: 0.07 },
    lamp: { x: 13.5, height: 15, pole: 0.3, head: [2.6, 1.7], bulbs: [4, 2], bulb: 0.34, halo: 1.1, behind: 1.2 },
    sky: {
      behind: 34, halfWidth: 80, floor: -4,
      bands: [[7, 'haze', TONE.base], [12, 'sky', TONE.light], [22, 'sky', TONE.base], [70, 'sky', TONE.shade]], // [top, ramp, tone], from the horizon up
      dither: { block: 1.2, height: 0.4, upTo: 2 }, // every other block of a band dips into the one below; only the lowest `upTo` joins
      clouds: [[-22, 17, 9], [-3, 20.5, 6], [15, 16, 11], [31, 21, 7], [-41, 21, 8]], // [x, underside, width]
      cloud: { height: 1.5, bump: 0.55 },
    },
    proud: 0.02, // how far a thing painted on a wall stands off it, so the two never fight for a texel
  });

  /** A playing surface: stripes mown across it, short dashes of texture, patches worn to earth, and lines. Heights are layers above the turf. */
  const SURFACE = Object.freeze({
    halfWidth: 26,
    from: -16, // z of its far edges
    to: 44,
    stripeDepth: 2.4,
    dashes: { count: 300, size: [0.26, 0.08], halfWidth: 9, from: -12, to: 7, lightEvery: 9 },
    worn: [], // { x, z, across, deep }: half extents of a stepped oval
    wornSteps: [[1, 0.34], [0.82, 0.67], [0.5, 1]], // [share of the width, share of the depth] from the widest strip out
    wornCore: 0.5,
    lines: [], // { rect: [fromX, toX, fromZ, toZ] } or { arc: { x, z, radius, from, to, steps } } (angles in radians, 0 towards +z)
    lineWidth: 0.09,
    layer: { turf: 0, texture: 0.006, worn: 0.012, line: 0.018 },
  });

  /**
   * A spectator is a few flat cards: `[width, height, lift above the seat, how far towards the pitch]`. People
   * differ in size (`vary`), a share wear a scarf, a share have no hair card, and a share are `lively`: they
   * bob in two-frame steps of `bob` metres (about a texel at a stand's distance), the way a sprite crowd moves.
   */
  const CROWD = Object.freeze({
    cards: { body: [0.46, 0.5, 0, 0], head: [0.27, 0.27, 0.5, 0.01], hair: [0.31, 0.12, 0.69, 0.02], scarf: [0.4, 0.11, 0.42, 0.02] },
    mostCards: 4,
    colors: { skin: 3, hair: 3, crowd: 6, scarf: 2 },
    vary: 0.16,
    scarfShare: 0.3,
    bareShare: 0.12,
    lively: 0.22,
    bob: 0.07,
    bobRate: 2.4,
    bobBeats: 4,
    jump: 0.22,
    jumpRate: 9,
  });

  /** The fixed scatter: constants of the usual sine hash, and the primes that spread its uses apart. No random: the same ground every visit. */
  const SCATTER = Object.freeze({ first: 12.9898, second: 78.233, scale: 43758.5453, shirt: 997, skin: 577, hair: 211, scarf: 131, size: 71, lively: 53, along: 37 });
  const fraction = (value) => value - Math.floor(value);
  const scatterOf = (first, second) => fraction(Math.sin(first * SCATTER.first + second * SCATTER.second) * SCATTER.scale);

  /**
   * @typedef {Object} Spectator
   * @property {number} x @property {number} y @property {number} z the seat, metres
   * @property {number} chance 0..1, fixed: seats with a chance under a ground's attendance are taken
   * @property {number} size how big this person is against the cards' sizes
   * @property {number} shirt @property {number} skin @property {number} hair @property {number} scarf index into each run of ramps
   * @property {boolean} hasHair @property {boolean} hasScarf @property {boolean} isLively
   */

  /**
   * Paints an end into a book, farthest things first, and says who could sit in it.
   * @param {Object} book a `Kit.paint.book`
   * @param {{edge: number, toward: number, turn?: number}} place `edge`: z of the surface's edge; `toward`: 1 when
   *   the surface lies towards +z from it, -1 for -z; `turn`: which end this is (0, 1, ...), so two ends differ
   * @param {Object} [spec=END] a row shaped like `END`
   * @returns {Spectator[]} every seat of the terrace
   * @complexity O(tiers x seats + boards x letters + sky blocks) time; about 500 quads for `END`
   * @example
   * const book = Kit.paint.book(slotOf);
   * const seats = Kit.stadium.end(book, { edge: -11, toward: 1 });
   * const stand = new THREE.Mesh(Kit.paint.geometry(book)); // dress with { stamps: true, blockRow, inkGroup: 0 }
   */
  const end = (book, place, spec = END) => {
    const { boards, stand, aisle, rail, backWall, roof, lamp, sky, proud } = spec;
    const { toward, turn = 0 } = place;
    const zOf = (behind) => place.edge - toward * behind;
    const standTop = stand.rise * stand.tiers;
    const backZ = zOf(stand.behind + stand.tiers * stand.run);
    const roofY = standTop + roof.lift;

    // Sky: bands, a dithered row where two meet, and flat-bottomed clouds.
    const skyZ = zOf(sky.behind);
    sky.bands.forEach(([top, ramp, tone], index) => {
      const from = index === 0 ? sky.floor : sky.bands[index - 1][0];
      book.wall(-sky.halfWidth, sky.halfWidth, from, top, skyZ, ramp, tone);
      if (index === 0 || index > sky.dither.upTo) return;
      for (let x = -sky.halfWidth; x < sky.halfWidth; x += sky.dither.block * 2) book.wall(x, x + sky.dither.block, from - sky.dither.height, from, skyZ + toward * proud, ramp, tone);
    });
    const cloudZ = skyZ + toward * proud * 2;
    sky.clouds.forEach(([x, underside, width]) => {
      const centre = x * toward;
      const { height, bump } = sky.cloud;
      book.wall(centre - width / 2, centre + width / 2, underside, underside + height * 0.5, cloudZ, 'cloud', TONE.base);
      book.wall(centre - width * 0.42, centre + width * 0.4, underside + height * 0.5, underside + height, cloudZ, 'cloud', TONE.light);
      book.wall(centre - width * 0.3, centre - width * 0.02, underside + height, underside + height * (1 + bump), cloudZ, 'cloud', TONE.light);
      book.wall(centre + width * 0.08, centre + width * 0.28, underside + height, underside + height * (1 + bump * 0.6), cloudZ, 'cloud', TONE.light);
    });

    // Floodlights behind the stand: a halo that is only there by palette, a mast, a dark head and a grid of bulbs.
    const lampZ = zOf(stand.behind + stand.tiers * stand.run + lamp.behind);
    [-1, 1].forEach((side) => {
      const x = side * lamp.x;
      const [headWidth, headHeight] = lamp.head;
      const [across, down] = lamp.bulbs;
      book.wall(x - headWidth / 2 - lamp.halo, x + headWidth / 2 + lamp.halo, lamp.height - lamp.halo, lamp.height + headHeight + lamp.halo, lampZ - toward * proud, 'glow', TONE.base);
      book.wall(x - lamp.pole / 2, x + lamp.pole / 2, 0, lamp.height, lampZ, 'roof', TONE.shade);
      book.wall(x - headWidth / 2, x + headWidth / 2, lamp.height, lamp.height + headHeight, lampZ, 'roof', TONE.dark);
      for (let bulb = 0; bulb < across * down; bulb++) {
        const [bulbX, bulbY] = [x + (((bulb % across) + 0.5) / across - 0.5) * headWidth, lamp.height + ((Math.floor(bulb / across) + 0.5) / down) * headHeight];
        book.wall(bulbX - lamp.bulb / 2, bulbX + lamp.bulb / 2, bulbY - lamp.bulb / 2, bulbY + lamp.bulb / 2, lampZ + toward * proud, 'lamp', TONE.light);
      }
    });

    // The back wall with a lighter band, the roof's underside, its fascia with trim lines, and the pillars that carry it.
    book.wall(-stand.halfWidth, stand.halfWidth, standTop, roofY, backZ, 'stand', TONE.dark);
    book.wall(-stand.halfWidth, stand.halfWidth, standTop + backWall.height, standTop + backWall.height + backWall.band, backZ + toward * proud, 'stand', TONE.shade);
    const roofEdgeZ = backZ + toward * roof.reach;
    book.floor(-stand.halfWidth, stand.halfWidth, backZ, roofEdgeZ, roofY, 'roof', TONE.dark);
    book.wall(-stand.halfWidth, stand.halfWidth, roofY, roofY + roof.fascia, roofEdgeZ, 'roof', TONE.base);
    book.wall(-stand.halfWidth, stand.halfWidth, roofY, roofY + roof.trim, roofEdgeZ + toward * proud, 'rail', TONE.base);
    book.wall(-stand.halfWidth, stand.halfWidth, roofY + roof.fascia - roof.trim, roofY + roof.fascia, roofEdgeZ + toward * proud, 'roof', TONE.light);
    const pillarTier = Math.round((stand.tiers * stand.run - roof.reach) / stand.run);
    // Pillars stand either side of the middle, never on it: the middle is where a game's subject is.
    for (let x = roof.pillarEvery / 2; x <= stand.halfWidth; x += roof.pillarEvery) {
      [-x, x].forEach((pillarX) => book.wall(pillarX - roof.pillar / 2, pillarX + roof.pillar / 2, stand.rise * (pillarTier + 1), roofY, roofEdgeZ, 'roof', TONE.shade));
    }

    // Terraces: a tread and a riser per tier, a lighter stair down each aisle, a rail along the front and one part way up.
    const aisles = [];
    for (let x = -stand.halfWidth + aisle.every / 2; x < stand.halfWidth; x += aisle.every) aisles.push(x);
    for (let tier = 0; tier < stand.tiers; tier++) {
      const [frontZ, rearZ] = [zOf(stand.behind + tier * stand.run), zOf(stand.behind + (tier + 1) * stand.run)];
      const [low, high] = [stand.rise * tier, stand.rise * (tier + 1)];
      book.wall(-stand.halfWidth, stand.halfWidth, low, high, frontZ, 'stand', tier === 0 ? TONE.dark : TONE.shade);
      book.floor(-stand.halfWidth, stand.halfWidth, frontZ, rearZ, high, 'step', tier % 2 ? TONE.base : TONE.shade);
      aisles.forEach((x) => {
        book.wall(x - aisle.width / 2, x + aisle.width / 2, low, high, frontZ + toward * proud, 'step', TONE.light);
        book.floor(x - aisle.width / 2, x + aisle.width / 2, frontZ, rearZ, high + proud, 'stand', TONE.base);
      });
      if (tier !== 0 && tier !== rail.midTier) continue;
      const railZ = frontZ + toward * proud;
      book.wall(-stand.halfWidth, stand.halfWidth, high + rail.height - rail.bar, high + rail.height, railZ, 'rail', TONE.base);
      for (let x = -stand.halfWidth; x <= stand.halfWidth; x += rail.every) book.wall(x - rail.post / 2, x + rail.post / 2, high, high + rail.height - rail.bar, railZ, 'rail', TONE.shade);
    }

    // Advertising boards: two liveries in turn, trim lines, a word and a block mark at each end.
    const boardZ = zOf(boards.behind);
    for (let index = 0; index < boards.count; index++) {
      const centre = (index - (boards.count - 1) / 2) * boards.width;
      const [ground, ink] = index % 2 ? ['boardAlt', 'board'] : ['board', 'boardAlt'];
      const halfWidth = (boards.width - boards.gap) / 2;
      const faceZ = boardZ + toward * proud;
      book.wall(centre - halfWidth, centre + halfWidth, 0, boards.height, boardZ, ground, TONE.base);
      book.wall(centre - halfWidth, centre + halfWidth, boards.height - boards.trim, boards.height, faceZ, ground, TONE.light);
      book.wall(centre - halfWidth, centre + halfWidth, 0, boards.trim, faceZ, ground, TONE.shade);
      // A different word leads at each end; the lettering reads from the surface's side.
      book.word({ text: boards.words[(index + turn * Kit.paint.FACE.advance) % boards.words.length], x: centre, y: boards.height / 2, z: faceZ, dot: boards.dot, ramp: ink, tone: TONE.base, reads: toward });
      [-1, 1].forEach((side) => {
        const markX = centre + side * (halfWidth - boards.mark);
        book.wall(markX - boards.mark / 2, markX + boards.mark / 2, boards.height / 2 - boards.mark / 2, boards.height / 2 + boards.mark / 2, faceZ, 'flag', TONE.base);
      });
    }

    // Who sits where: no seats in the aisles, and no two neighbours alike.
    const seats = [];
    const isInAisle = (x) => aisles.some((aisleX) => Math.abs(x - aisleX) < aisle.width / 2 + spec.seat.spacing / 2);
    const perTier = Math.floor((stand.halfWidth * 2) / spec.seat.spacing);
    for (let tier = 0; tier < stand.tiers; tier++) {
      for (let seat = 0; seat < perTier; seat++) {
        const x = (seat - (perTier - 1) / 2) * spec.seat.spacing;
        if (isInAisle(x)) continue;
        const chance = scatterOf(seat, tier + turn * stand.tiers);
        const pick = (prime, among) => Math.floor(chance * prime) % among;
        seats.push({
          chance,
          x: x + (fraction(chance * SCATTER.along) - 0.5) * 2 * spec.seat.jitter,
          y: stand.rise * (tier + 1),
          z: zOf(stand.behind + tier * stand.run + stand.run * spec.seat.setBack),
          size: 1 + (fraction(chance * SCATTER.size) - 0.5) * 2 * CROWD.vary,
          shirt: pick(SCATTER.shirt, CROWD.colors.crowd), skin: pick(SCATTER.skin, CROWD.colors.skin), hair: pick(SCATTER.hair, CROWD.colors.hair), scarf: pick(SCATTER.scarf, CROWD.colors.scarf),
          hasHair: fraction(chance * SCATTER.hair) > CROWD.bareShare,
          hasScarf: fraction(chance * SCATTER.scarf) < CROWD.scarfShare,
          isLively: fraction(chance * SCATTER.lively) < CROWD.lively,
        });
      }
    }
    return seats;
  };

  /**
   * Paints a playing surface into a book.
   * @param {Object} book a `Kit.paint.book`
   * @param {Object} [spec=SURFACE] a row shaped like `SURFACE` (spread `SURFACE` and state what differs)
   * @returns {Object} the book
   * @complexity O(stripes + dashes + worn patches + line steps); about 350 quads for `SURFACE`
   * @example
   * Kit.stadium.surface(book, { ...Kit.stadium.SURFACE, worn: [{ x: 0, z: 0.2, across: 0.5, deep: 0.3 }], lines: [{ rect: [-26, 26, -11.05, -10.95] }] });
   */
  const surface = (book, spec = SURFACE) => {
    const { layer, dashes } = spec;
    /** The mow colour under a z: stripes alternate from the far edge. */
    const mowAt = (z) => (Math.floor((z - spec.from) / spec.stripeDepth) % 2 ? 'stripe' : 'grass');
    const stripes = Math.ceil((spec.to - spec.from) / spec.stripeDepth - EPSILON);
    for (let stripe = 0; stripe < stripes; stripe++) {
      const fromZ = spec.from + stripe * spec.stripeDepth;
      book.floor(-spec.halfWidth, spec.halfWidth, fromZ, fromZ + spec.stripeDepth, layer.turf, stripe % 2 ? 'stripe' : 'grass', TONE.base);
    }
    const [dashAcross, dashDeep] = dashes.size;
    for (let index = 0; index < dashes.count; index++) {
      const x = (scatterOf(index, 1) - 0.5) * 2 * dashes.halfWidth;
      const z = lerp(dashes.from, dashes.to, scatterOf(index, 2));
      const isLight = index % dashes.lightEvery === 0;
      // A dash of the other mow colour mottles a stripe without a third green; every few, a lighter blade.
      book.floor(x, x + dashAcross, z, z + dashDeep, layer.texture, isLight ? mowAt(z) : mowAt(z + spec.stripeDepth), isLight ? TONE.light : TONE.base);
    }
    spec.worn.forEach(({ x, z, across, deep }) => {
      // A stepped oval: strips that narrow as they go out from the middle, then a paler core.
      let inner = 0;
      spec.wornSteps.forEach(([widthShare, depthShare]) => {
        const outer = deep * depthShare;
        [-1, 1].forEach((side) => book.floor(x - across * widthShare, x + across * widthShare, z + side * inner, z + side * outer, layer.worn, 'worn', TONE.shade));
        inner = outer;
      });
      book.floor(x - across * spec.wornCore, x + across * spec.wornCore, z - deep * spec.wornCore * 0.5, z + deep * spec.wornCore * 0.5, layer.worn + layer.texture, 'worn', TONE.base);
    });
    const half = spec.lineWidth / 2;
    spec.lines.forEach((line) => {
      if (line.rect) return book.floor(line.rect[0], line.rect[1], line.rect[2], line.rect[3], layer.line, 'line', TONE.light);
      const { x, z, radius, from, to, steps } = line.arc;
      const cornerAt = (angle, reach) => [x + Math.sin(angle) * reach, layer.line, z + Math.cos(angle) * reach];
      for (let step = 0; step < steps; step++) {
        const [start, stop] = [step, step + 1].map((at) => lerp(from, to, at / steps));
        book.quad([cornerAt(start, radius - half), cornerAt(stop, radius - half), cornerAt(stop, radius + half), cornerAt(start, radius + half)], 'line', TONE.light);
      }
      return book;
    });
    return book;
  };

  /**
   * The cards a spectator is made of.
   * @param {Spectator} member
   * @returns {Array<{card: number[], run: string, index: number}>} each card's `[width, height, lift, proud]`, and
   *   its ramp as a run of `RAMPS.crowd` and an index into it (the ramp is `run + index`, e.g. 'crowd3')
   * @complexity O(1)
   */
  const cards = (member) => [
    { card: CROWD.cards.body, run: 'crowd', index: member.shirt },
    { card: CROWD.cards.head, run: 'skin', index: member.skin },
    ...(member.hasHair ? [{ card: CROWD.cards.hair, run: 'hair', index: member.hair }] : []),
    ...(member.hasScarf ? [{ card: CROWD.cards.scarf, run: 'scarf', index: member.scarf }] : []),
  ];

  /**
   * How far above their seat a spectator is now: the lively ones bob in steps, and when the ground erupts
   * everyone jumps in a wave.
   * @param {Spectator} member
   * @param {number} time seconds
   * @param {number} [cheer=0] 0..1 how loud the ground is
   * @returns {number} metres
   */
  const lift = (member, time, cheer = 0) => {
    const bob = member.isLively && Math.floor(time * CROWD.bobRate + member.chance * CROWD.bobBeats) % CROWD.bobBeats === 0 ? CROWD.bob : 0;
    const jump = cheer > 0 ? Math.max(0, Math.sin(time * CROWD.jumpRate + member.chance * TURN)) * CROWD.jump * cheer : 0;
    return Math.max(bob, jump);
  };

  Kit.stadium = { RAMPS, END, SURFACE, CROWD, end, surface, cards, lift };
})();
