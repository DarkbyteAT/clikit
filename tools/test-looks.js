/**
 * Tests of how characters are lit and rolled: the light model of kit/look-settings.js (key, capped fill, band
 * edges, responses, dither fade) and the roll rules of kit/body-recipe.js (harmony schemes, followers, contrast,
 * rooms, determinism, locks), on the wardrobe catalogue and on small catalogues made for one rule each.
 *
 * Owns:  the cases for `Kit.look.lightOf` / `ditherAt` / `BAND_EDGES`, `Kit.body.rolls`, `catalog.clashes`,
 *        `catalog.reconcile` and the locks of `editor.randomize`. Run through tools/test-kit.js, which hands over
 *        its sandbox (the body and look modules are already loaded there).
 * Does not own: the shaders (they mirror these functions and are judged on proof sheets), or the palette's
 *        tone placement (tools/test-kit.js, with the atlas).
 */
'use strict';

// Values made inside the kit's sandbox have another realm's prototypes, so they are compared as text or field by field.
module.exports = ({ Kit, test, assert }) => {
  const { look, palette } = Kit;
  const { rolls } = Kit.body;
  const wardrobe = Kit.body.catalog(Kit.body.wardrobe.CATALOG);
  const samples = Kit.body.samples.CATALOG;
  /** How many seeds a statistical case rolls: enough that a rule broken one time in a few hundred would show. */
  const MANY = 1500;

  /** Unit normals over the hemisphere a viewer sees, with the share of the disc each stands for (equal). */
  const visibleNormals = (steps = 60) => {
    const normals = [];
    for (let row = 0; row < steps; row++) {
      for (let column = 0; column < steps; column++) {
        const [right, up] = [((column + 0.5) / steps) * 2 - 1, ((row + 0.5) / steps) * 2 - 1];
        if (right * right + up * up < 1) normals.push([right, up, Math.sqrt(1 - right * right - up * up)]);
      }
    }
    return normals;
  };

  // ---- the light ----

  test('look light: a ball keeps two or three clean tones (a crescent of shadow, a small highlight) at every tone count', () => {
    const normals = visibleNormals();
    for (let toneCount = palette.MIN_TONES; toneCount <= palette.MAX_TONES; toneCount++) {
      const edges = look.edgesFor(toneCount);
      const own = Math.max(1, toneCount - 2);
      const tones = normals.map((normal) => look.bandOf(look.lightOf(normal), edges));
      const share = (matches) => tones.filter(matches).length / tones.length;
      assert.ok(share((tone) => tone === own) > 0.5, `${toneCount} tones: most of a ball is its own colour, got ${share((tone) => tone === own)}`);
      assert.ok(share((tone) => tone < own) > 0.1 && share((tone) => tone < own) < 0.35, `${toneCount} tones: shadow is a crescent, got ${share((tone) => tone < own)}`);
      if (toneCount > 2) assert.ok(share((tone) => tone > own) > 0.03 && share((tone) => tone > own) < 0.2, `${toneCount} tones: the highlight is an accent, got ${share((tone) => tone > own)}`);
      // The fill light is capped inside the band of the ramp's own colour, so it can never add a highlight.
      assert.strictEqual(look.bandOf(look.LIGHTING.fillCap, edges), own, `${toneCount} tones: the fill cap is in the own-colour band`);
    }
  });

  test('look light: a face turned to the viewer is never in shadow, whatever the tone count; a form still is', () => {
    const fill = look.LIGHTING.fill.map((component) => component / Math.hypot(...look.LIGHTING.fill));
    const facing = visibleNormals().filter((normal) => normal[0] * fill[0] + normal[1] * fill[1] + normal[2] * fill[2] >= 0.45);
    for (let toneCount = palette.MIN_TONES; toneCount <= palette.MAX_TONES; toneCount++) {
      const edges = look.edgesFor(toneCount);
      const own = Math.max(1, toneCount - 2);
      assert.ok(facing.every((normal) => look.bandOf(look.lightOf(normal, look.RESPONSES.face), edges) >= own), `${toneCount} tones: a face holds its own colour`);
      assert.ok(facing.some((normal) => look.bandOf(look.lightOf(normal, look.RESPONSES.form), edges) < own), `${toneCount} tones: a form facing the viewer can be in shadow`);
    }
    // The fill lifts shadow and nothing else: where the key already lights a face, the face is lit as a form is.
    visibleNormals(20).forEach((normal) => {
      const [asFace, asForm] = [look.lightOf(normal, look.RESPONSES.face), look.lightOf(normal, look.RESPONSES.form)];
      assert.ok(asFace >= asForm && (asFace === asForm || asFace <= look.LIGHTING.fillCap));
    });
    assert.strictEqual(look.RESPONSES.face.dither, 0, 'a face is never dithered');
  });

  test('look: a texel has a size at every depth under a perspective camera, and a face layer is grown or dropped by it', () => {
    const RADIANS = Math.PI / 180;
    // A phone picture of 422 rows through a 50 degree lens: the taker 6 m away, the keeper 19 m away.
    const slope = look.texelSlope(50 * RADIANS, 422);
    assert.ok(Math.abs(look.texelSlope(Math.PI / 2, 400) * 10 - 0.05) < 1e-12, 'at 90 degrees the picture is twice as tall as it is far');
    assert.strictEqual(look.texelWorldAt(0.02, 0, 7), 0.02, 'an orthographic camera has one texel size at every depth');
    assert.strictEqual(look.texelWorldAt(0, slope, -1), 0, 'behind the lens there is no size');
    const [near, far] = [look.texelWorldAt(0, slope, 6), look.texelWorldAt(0, slope, 19)];
    assert.ok(Math.abs(far / near - 19 / 6) < 1e-9 && near > 0, 'a texel grows in proportion to depth');
    // An eye 3 cm across with a least size of 2 texels: left alone close up, grown on the far keeper, capped when tiny.
    assert.strictEqual(look.stampGrowth(0.015, 2, near), 1, `control: at ${(0.03 / near).toFixed(1)} texels the eye is big enough`);
    const grown = look.stampGrowth(0.015, 2, far);
    assert.ok(grown > 1 && Math.abs((0.03 * grown) / far - 2) < 1e-9, `on the far keeper the eye is grown to 2 texels (x${grown.toFixed(2)})`);
    assert.strictEqual(look.stampGrowth(0.015, 2, far * 10), look.STAMP_MOST_GROWTH, 'growth is capped: a face never swallows the head');
    // The fault this replaces: with the texel size unknown (0) nothing was grown and nothing dropped.
    assert.strictEqual(look.stampGrowth(0.015, 2, 0), 1);
    assert.strictEqual(look.stampGrowth(0.015, -3, 0), 1, 'unknown size: a layer that should vanish stays');
    assert.strictEqual(look.stampGrowth(0.015, -3, far), 0, 'the white of an eye under 3 texels is dropped');
    assert.strictEqual(look.stampGrowth(0.015, -3, near), 1);
    assert.strictEqual(look.stampGrowth(0.015, 0, far), 1, 'no rule: paint on a wall is left alone');
  });

  test('look: dither fades as texels grow against the figure; the presets share one hull line weight', () => {
    assert.strictEqual(look.ditherAt(0.08, 0), 0.08, 'an unknown texel size leaves the dither alone');
    assert.strictEqual(look.ditherAt(0.08, look.DITHER_TEXEL_FADE.full), 0.08);
    assert.strictEqual(look.ditherAt(0.08, look.DITHER_TEXEL_FADE.none), 0);
    assert.strictEqual(look.ditherAt(0.08, 1), 0);
    const half = look.ditherAt(0.08, (look.DITHER_TEXEL_FADE.full + look.DITHER_TEXEL_FADE.none) / 2);
    assert.ok(Math.abs(half - 0.04) < 1e-9);
    const hullWidths = Object.values(look.PRESETS)
      .filter((preset) => preset.outline === 'hull')
      .map((preset) => preset.inkWidth);
    assert.ok(hullWidths.length >= 2 && hullWidths.every((width) => width === hullWidths[0]), 'hull presets draw one line weight');
  });

  // ---- the pure pieces of the roll rules ----

  test('rolls: hue gaps wrap, schemes turn round their key, neutrals fit every scheme', () => {
    assert.strictEqual(rolls.hueGap(350, 20), 30);
    assert.strictEqual(rolls.hueGap(20, 350), 30);
    assert.strictEqual(rolls.hueGap(0, 180), 180);
    assert.strictEqual(rolls.schemeHues('complementary', 30).join(), '30,210');
    assert.strictEqual(rolls.schemeHues('triad', 300).join(), '300,60,180');
    assert.strictEqual(rolls.schemeHues('analogous', 10).join(), '10,42,338');
    const limits = { tolerance: 25, neutralChroma: 0.05 };
    const colour = (hue, chroma = 0.12) => ({ lightness: 0.6, chroma, hue });
    assert.ok(rolls.isInScheme(colour(200), rolls.schemeHues('complementary', 30), limits), 'a complement, 10 degrees off');
    assert.ok(!rolls.isInScheme(colour(120), rolls.schemeHues('complementary', 30), limits), 'a hue between the two');
    assert.ok(rolls.isInScheme(colour(120, 0.02), rolls.schemeHues('complementary', 30), limits), 'a grey goes with anything');
    assert.deepStrictEqual(Object.keys(rolls.SCHEMES).sort(), ['analogous', 'complementary', 'neutral', 'split', 'triad']);
  });

  test('rolls: colours stand apart by value or by saturation; a follower takes the nearest ramps to its target', () => {
    const fact = (lightness, chroma, hue = 40) => ({ lightness, chroma, hue, greenRed: chroma * Math.cos((hue * Math.PI) / 180), blueYellow: chroma * Math.sin((hue * Math.PI) / 180) });
    assert.ok(rolls.standsApart(fact(0.7, 0.05), fact(0.5, 0.05), { lightness: 0.12, chroma: 0.06 }), 'a value gap');
    assert.ok(rolls.standsApart(fact(0.7, 0.05), fact(0.7, 0.13), { lightness: 0.12, chroma: 0.06 }), 'a saturation gap');
    assert.ok(!rolls.standsApart(fact(0.7, 0.05), fact(0.65, 0.08), { lightness: 0.12, chroma: 0.06 }), 'neither');
    assert.ok(!rolls.standsApart(fact(0.7, 0.05), fact(0.7, 0.2), { lightness: 0.12 }), 'a rule without chroma asks for value alone');
    assert.ok(rolls.standsApart(fact(0.6, 0.1, 30), fact(0.6, 0.1, 140), { lightness: 0.12, hue: 60 }), 'a hue gap, for a rule that accepts one');
    assert.ok(!rolls.standsApart(fact(0.6, 0.1, 30), fact(0.6, 0.02, 140), { lightness: 0.12, hue: 60 }), 'a grey has no hue to stand apart by');
    const candidates = [fact(0.3, 0.05), fact(0.5, 0.05), fact(0.7, 0.05), fact(0.52, 0.05, 220)];
    assert.strictEqual(rolls.nearestTo(fact(0.5, 0.05), {}, candidates, 1).join(), '1', 'with no offset, itself');
    assert.strictEqual(rolls.nearestTo(fact(0.5, 0.05), { lightness: -0.2 }, candidates, 2).join(), '0,1', 'an offset moves the target');
    assert.strictEqual(rolls.nearestTo(fact(0.5, 0.05), { hue: 180 }, candidates, 1).join(), '3', 'distance is perceptual: the hue counts');
    // The weighted pick: zero weights are never taken, and the unit number walks the rest in order.
    assert.strictEqual(rolls.pickIndex([0, 2, 0, 2], 4, 0), 1);
    assert.strictEqual(rolls.pickIndex([0, 2, 0, 2], 4, 0.49), 1);
    assert.strictEqual(rolls.pickIndex([0, 2, 0, 2], 4, 0.5), 3);
    assert.strictEqual(rolls.pickIndex([0, 2, 0, 2], 4, 0.999999), 3);
    assert.strictEqual(rolls.pickIndex([0, 0], 2, 0.3), -1);
  });

  // ---- small catalogues, one rule each ----

  /** The samples catalogue with one more species, defined by `set` on top of its humanoid. */
  const withSpecies = (set) => Kit.body.catalog({ ...samples, nodes: { ...samples.nodes, tester: { parent: 'humanoid', set: { code: 90, ...set } } } });
  const colorsOf = (catalog, recipe) => catalog.describe(catalog.resolve(recipe)).colors;

  test('rolls: a follower takes its colour from another channel, with an offset, and follows an override unless overridden itself', () => {
    const catalog = withSpecies({
      colors: { hair: 'furs', brow: 'furs', beard: 'furs', trim: 'scales' },
      follow: { brow: { channel: 'hair' }, beard: { channel: 'hair', lightness: -0.25 }, trim: { channel: 'hair', among: 2 } },
    });
    const kind = catalog.species('tester');
    const furs = kind.palettes[kind.colorIds.indexOf('hair')];
    const trims = new Set();
    for (let seed = 0; seed < 200; seed++) {
      const colors = colorsOf(catalog, { species: 'tester', seed });
      assert.strictEqual(colors.brow, colors.hair, 'one palette and no offset: the same ramp');
      const [hair, beard] = [colors.hair, colors.beard].map((id) => rolls.colorFactOf(furs.find((ramp) => ramp.id === id)));
      assert.ok(beard.lightness <= hair.lightness, 'a darker offset never picks a lighter ramp than the hair');
      trims.add(`${colors.hair}>${colors.trim}`);
    }
    assert.ok(trims.size > furs.length, '`among: 2` lets two individuals of one hair colour differ');
    // An override of the followed channel moves the followers; an override of a follower holds it.
    const soot = furs.findIndex((ramp) => ramp.id === 'soot');
    const cream = furs.findIndex((ramp) => ramp.id === 'cream');
    assert.strictEqual(colorsOf(catalog, { species: 'tester', seed: 3, overrides: { 'color:hair': cream } }).brow, 'cream');
    const held = colorsOf(catalog, { species: 'tester', seed: 3, overrides: { 'color:hair': cream, 'color:brow': soot } });
    assert.deepStrictEqual([held.hair, held.brow], ['cream', 'soot']);
    assert.throws(() => withSpecies({ colors: { hair: 'furs', brow: 'furs' }, follow: { brow: { channel: 'fur' } } }), /follow\.brow names the colour channel "fur", which this species does not have\. Channels: /);
    assert.throws(() => withSpecies({ colors: { hair: 'furs', brow: 'furs', lash: 'furs' }, follow: { brow: { channel: 'hair' }, lash: { channel: 'brow' } } }), /follows another channel/);
    assert.throws(() => withSpecies({ colors: { hair: 'furs', brow: 'furs' }, follow: { brow: { channel: 'hair' } }, contrast: [{ between: ['brow', 'skin'], lightness: 0.1 }] }), /state the rule on the channel it follows/);
  });

  test('rolls: weights steer a channel and a ramp weighted 0 is never rolled; a rule that names what is not there is refused at load', () => {
    // The humanoid's own contrast rule is set aside (a list replaces the inherited one), so only the weights decide.
    const catalog = withSpecies({ contrast: [], colorWeights: { cloth: { indigo: 0, madder: 5 } } });
    const seen = {};
    for (let seed = 0; seed < 600; seed++) {
      const { cloth } = colorsOf(catalog, { species: 'tester', seed });
      seen[cloth] = (seen[cloth] || 0) + 1;
    }
    assert.strictEqual(seen.indigo, undefined);
    assert.ok(seen.madder > seen.woad * 2 && seen.woad > 0 && seen.saffron > 0, JSON.stringify(seen));
    assert.throws(() => withSpecies({ colorWeights: { cloth: { purple: 2 } } }), /colorWeights\.cloth names the ramp "purple"/);
    assert.throws(() => withSpecies({ harmony: { schemes: { clashing: 1 }, channels: ['cloth'] } }), /harmony\.schemes names "clashing"\. Schemes: analogous/);
    assert.throws(() => withSpecies({ contrast: [{ between: ['cloth'] }] }), /contrast\[0\] must be \{ between: \[channel, channel\]/);
    assert.throws(() => withSpecies({ occupies: { helmet: ['crown'] } }), /occupies names the part "helmet"/);
  });

  test('rolls: two parts that occupy one room are never rolled together; an override may combine them and `clashes` says so', () => {
    const catalog = withSpecies({ fills: { headTop: { hat: 1, none: 1 }, handRight: { sword: 1, none: 1 } }, occupies: { hat: ['reach'], sword: ['reach'] } });
    const seen = { hat: 0, sword: 0, neither: 0 };
    for (let seed = 0; seed < 400; seed++) {
      const individual = catalog.resolve({ species: 'tester', seed });
      assert.ok(!(individual.fills.headTop && individual.fills.handRight), `seed ${seed} rolled a hat and a sword`);
      assert.strictEqual(catalog.clashes(individual).length, 0);
      seen[individual.fills.headTop ? 'hat' : individual.fills.handRight ? 'sword' : 'neither'] += 1;
    }
    // Sockets roll in path order: the hand comes first, so the hat gives way and is the rarer of the two.
    assert.ok(seen.sword > seen.hat && seen.hat > 0 && seen.neither > 0, JSON.stringify(seen));
    const both = catalog.resolve({ species: 'tester', seed: 1, overrides: { 'fill:headTop': 'hat', 'fill:handRight': 'sword' } });
    assert.strictEqual(catalog.clashes(both).map((clash) => `${clash.code} ${clash.field}`).join(), 'occupied fill:headTop');
    // Without the rule the same fills do meet, so the rule is what keeps them apart.
    const free = withSpecies({ fills: { headTop: { hat: 1, none: 1 }, handRight: { sword: 1, none: 1 } } });
    assert.ok(Array.from({ length: 400 }, (_unused, seed) => free.resolve({ species: 'tester', seed }).fills).some((fills) => fills.headTop && fills.handRight));
  });

  // ---- the wardrobe ----

  test('rolls: a species without rules still rolls each channel from its own field alone (old seeds keep their colours)', () => {
    const catalog = Kit.body.catalog(samples);
    const kind = catalog.species('carp');
    assert.strictEqual(kind.rolls.active, false);
    for (let seed = 0; seed < 50; seed++) {
      const { colors } = catalog.resolve({ species: 'carp', seed });
      kind.colorIds.forEach((_channel, index) => assert.strictEqual(colors[index], Math.floor(kind.colorDraws[index](seed) * kind.palettes[index].length)));
    }
  });

  test('rolls: no wardrobe roll breaks a contrast rule or shares a room, and nearly every outfit is one harmony scheme', () => {
    const table = wardrobe.table(wardrobe.speciesIds().map((species) => ({ species })));
    const tally = { contrast: 0, occupied: 0, harmony: 0 };
    for (let index = 0; index < MANY; index++) wardrobe.clashes(wardrobe.resolve(table.roll(77, index))).forEach((clash) => (tally[clash.code] += 1));
    assert.strictEqual(tally.contrast, 0, 'contrast is a guarantee');
    assert.strictEqual(tally.occupied, 0, 'rooms are a guarantee');
    // Harmony gives way only when no ramp of the scheme stands apart from what is already chosen.
    assert.ok(tally.harmony < MANY * 0.03, `harmony gave way ${tally.harmony} times in ${MANY}`);
  });

  test('rolls: the contrast the rules promise is real OKLCH distance between the colours drawn; outfits are neutrals with an accent or hues of one scheme', () => {
    const kind = wardrobe.species('person');
    const fact = (individual, channel) => rolls.colorFactOf(kind.palettes[kind.colorIds.indexOf(channel)][individual.colors[kind.colorIds.indexOf(channel)]]);
    const { neutralChroma } = rolls.HARMONY_DEFAULTS;
    const outfits = { neutral: 0, coloured: 0 };
    for (let seed = 0; seed < MANY; seed++) {
      const individual = wardrobe.resolve({ species: 'person', seed });
      const [skin, top, bottom] = ['skin', 'top', 'bottom'].map((channel) => fact(individual, channel));
      assert.ok(Math.abs(skin.lightness - top.lightness) >= 0.12 || Math.abs(skin.chroma - top.chroma) >= 0.05, `seed ${seed}: a top the colour of the skin`);
      assert.ok(Math.abs(top.lightness - bottom.lightness) >= 0.12 || Math.abs(top.chroma - bottom.chroma) >= 0.08, `seed ${seed}: a top and bottom of one value`);
      const coloured = ['top', 'bottom', 'outerwear', 'hat'].map((channel) => fact(individual, channel)).filter((garment) => garment.chroma >= neutralChroma);
      outfits[coloured.length <= 1 ? 'neutral' : 'coloured'] += 1;
      // Two coloured garments are never an arbitrary pair of hues: every scheme's hues are 0, 32, 120, 150 or 180 degrees apart.
      if (coloured.length === 2 && wardrobe.clashes(individual).length === 0) {
        const gap = rolls.hueGap(coloured[0].hue, coloured[1].hue);
        assert.ok([0, 32, 64, 120, 150, 180].some((allowed) => Math.abs(gap - allowed) <= 2 * rolls.HARMONY_DEFAULTS.tolerance + 1e-9), `seed ${seed}: hues ${gap} degrees apart`);
      }
    }
    assert.ok(outfits.neutral > MANY * 0.2 && outfits.coloured > MANY * 0.3, JSON.stringify(outfits));
  });

  test('rolls: lips follow the skin, and brows and facial hair are painted with the hair channel itself', () => {
    const kind = wardrobe.species('person');
    const lipsBySkin = new Map();
    for (let seed = 0; seed < MANY; seed++) {
      const { colors } = wardrobe.describe(wardrobe.resolve({ species: 'person', seed }));
      lipsBySkin.set(colors.skin, (lipsBySkin.get(colors.skin) || new Set()).add(colors.lips));
    }
    assert.strictEqual(lipsBySkin.size, kind.palettes[kind.colorIds.indexOf('skin')].length, 'every skin was rolled');
    lipsBySkin.forEach((lips, skin) => assert.ok(lips.size <= 2, `${skin} skin rolled lips ${[...lips]}`));
    const paintsOf = (part) => JSON.stringify(Kit.body.wardrobe.PARTS[part]).match(/"(?:channel|paint)":"[a-z]+"/gi) || [];
    ['browsArched', 'browsHeavy', 'beard', 'stubble', 'moustache', 'chinTuft'].forEach((part) => {
      assert.ok(paintsOf(part).length > 0 && paintsOf(part).every((paint) => /"hair"$/.test(paint)), `${part} is painted with ${paintsOf(part)}`);
    });
  });

  test('rolls: a seed is one individual, six bytes still hold a rolled recipe, and overrides sit on top of the roll unchanged', () => {
    const table = wardrobe.table(wardrobe.speciesIds().map((species) => ({ species })));
    for (let index = 0; index < 100; index++) {
      const recipe = table.roll(5, index);
      const [first, second] = [wardrobe.resolve(recipe), wardrobe.resolve(recipe)];
      assert.strictEqual(JSON.stringify(wardrobe.describe(first)), JSON.stringify(wardrobe.describe(second)));
      assert.strictEqual(wardrobe.hash(first), wardrobe.hash(second));
      assert.strictEqual(wardrobe.encode(recipe).length, 6, 'a rolled recipe is species and seed: the rules add no bytes');
      assert.strictEqual(JSON.stringify(wardrobe.decode(wardrobe.encode(recipe))), JSON.stringify(wardrobe.normalize(recipe)));
    }
    // An override changes its own channel and its followers, and nothing else of the roll.
    const kind = wardrobe.species('person');
    const base = wardrobe.resolve({ species: 'person', seed: 11 });
    const top = kind.colorIds.indexOf('top');
    const other = (base.colors[top] + 1) % kind.palettes[top].length;
    const edited = wardrobe.resolve({ species: 'person', seed: 11, overrides: { 'color:top': other } });
    kind.colorIds.forEach((channel, index) => assert.strictEqual(edited.colors[index], index === top ? other : base.colors[index], channel));
    assert.strictEqual(JSON.stringify(edited.fills), JSON.stringify(base.fills));
  });

  test('rolls: randomize keeps every lock and makes the fresh colours go with the locked ones', () => {
    const editor = Kit.body.editor(wardrobe);
    const kind = wardrobe.species('person');
    const indexOf = (channel, id) => kind.palettes[kind.colorIds.indexOf(channel)].findIndex((ramp) => ramp.id === id);
    const start = { species: 'person', seed: 1, overrides: { 'color:skin': indexOf('skin', 'ebony'), 'color:top': indexOf('top', 'crimson'), 'fill:hat': 'beret', 'dial:height': 1.05 } };
    const locked = Object.keys(start.overrides);
    const kept = wardrobe.resolve(start);
    let moved = 0;
    for (let seed = 100; seed < 400; seed++) {
      const rerolled = editor.randomize(start, seed, { locked });
      const individual = wardrobe.resolve(rerolled);
      const described = wardrobe.describe(individual);
      assert.strictEqual(rerolled.seed, seed);
      assert.deepStrictEqual([described.colors.skin, described.colors.top, described.fills.hat], ['ebony', 'crimson', 'beret']);
      assert.strictEqual(described.dials.height, wardrobe.describe(kept).dials.height);
      assert.strictEqual(wardrobe.clashes(individual).filter((clash) => clash.code === 'contrast').length, 0, `seed ${seed}: ${JSON.stringify(described.colors)}`);
      assert.strictEqual(JSON.stringify(editor.randomize(start, seed, { locked })), JSON.stringify(rerolled), 'the same seed and locks give the same recipe');
      assert.strictEqual(JSON.stringify(wardrobe.decode(wardrobe.encode(rerolled))), JSON.stringify(rerolled));
      moved += Object.keys(rerolled.overrides).length > locked.length ? 1 : 0;
    }
    // The plain roll of some seeds would have set a dark garment against the locked dark skin: those were moved.
    assert.ok(moved > 0, 'some rolls had to change to go with the locks');
    // With nothing locked a re-roll is the bare seed, and a lock on a follower holds it against what it follows.
    assert.strictEqual(JSON.stringify(editor.randomize(start, 9).overrides), '{}');
    const lips = indexOf('lips', 'berry');
    const withLips = wardrobe.resolve(editor.randomize({ species: 'person', seed: 1, overrides: { 'color:lips': lips } }, 9, { locked: ['color:lips'] }));
    assert.strictEqual(withLips.colors[kind.colorIds.indexOf('lips')], lips);
    // `reconcile` alone: nothing to change when nothing is kept, and never a change to a kept channel.
    assert.strictEqual(JSON.stringify(wardrobe.reconcile({ species: 'person', seed: 4 })), '{}');
    assert.ok(!('color:skin' in wardrobe.reconcile(start)) && !('color:top' in wardrobe.reconcile(start)));
  });
};
