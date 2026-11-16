// Kit pixel: pixel-paper sprites. Pixel art is written as data (rows of characters + a palette, optionally several frames),
// baked into a crisp nearest-filtered texture with an off-white paper border, and stood up in the scene as a paper cut-out.
//
//   const ART = Kit.pixel.sheet(PALETTE, { hero: { frames: [[...rows], [...rows]], anims: { walk: [1, 0] } }, tree: [...rows] });
//   const paper = Kit.pixel.use(ctx, { unit: 1 / 16, lean: 0.3, shadow: true, tint });      // per-game defaults
//   const hero = paper.sprite(ART.hero, { at: [x, y, z] });
//   hero.play('walk', 9);  hero.face(-1);  hero.hop(0.3);  hero.squash();   // frames, paper flip, springy feedback
//   paper.update(dt);                                                       // once per frame, drives every sprite
//
// Owns: sprite definitions as data (sheet / recolor / tile / label / cells), baking them to textures, the paper sprite
// with its frame, flip, hop and squash animation, and true-colour unlit materials (paper.flat) for backdrops and water.
// Does not own: movement, game rules or the art itself.
//
// Colour: sprites are unlit and sRGB-correct. While the kit's post pass is on they pre-invert its ACES curve, so palette
// colours reach the screen as written; paper whites then sit near 2.3 in HDR, so use ctx.post.bloom(0), or a bloom
// threshold of 2.5 or more, to keep them matte.
(() => {
  /** Paper colour of the border around every cut-out, and the darker tone used directly under the art (a cut edge). */
  const PAPER = 0xfbf3df, PAPER_EDGE = 0xd9c8a5;
  /** World units per art pixel unless a game says otherwise: a 16-pixel sprite is one unit tall. */
  const DEFAULT_UNIT = 1 / 16;
  /** Characters that mean "no pixel here" in sprite rows. */
  const TRANSPARENT = '. ';
  /** Seconds a paper flip takes when a sprite turns to face the other way. */
  const FLIP_SECONDS = 0.16;
  /** Blob shadow: texture size (px), opacity, height above the ground, and footprint relative to the art width. */
  const SHADOW = { texturePx: 32, opacity: 0.3, lift: 0.02, widthShare: 1.05, depthShare: 0.42, minDepth: 0.3 };
  /** Squash spring: wobble frequency (rad/s), decay rate (1/s), seconds until it is cut off, and how much of the
   *  vertical squash is given back as horizontal stretch. */
  const SQUASH = { frequency: 20, decay: 8, seconds: 0.7, stretchShare: 0.7 };
  /** Largest squash a landing hop adds, and how much of the hop height turns into squash. */
  const LANDING = { maxSquash: 0.3, perHeight: 0.5 };
  /** 3x5 pixel font for label(): each glyph is five rows, each row a hex digit whose three low bits are the pixels. */
  const FONT = {
    A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553', H: '55755', I: '72227', J: '11152', K: '55655', L: '44447', M: '57755',
    N: '65555', O: '25552', P: '65644', Q: '25563', R: '65655', S: '34216', T: '72222', U: '55557', V: '55552', W: '55775', X: '55255', Y: '55222', Z: '71247',
    0: '75557', 1: '26227', 2: '61247', 3: '61216', 4: '55711', 5: '74616', 6: '34757', 7: '71222', 8: '75757', 9: '75716',
    '!': '22202', '?': '61202', '+': '02720', '-': '00700', '.': '00002', ' ': '00000',
  };
  const GLYPH_ROWS = 5, GLYPH_BITS = [4, 2, 1];
  const LABEL_INK = 0x2b2233;

  /**
   * @typedef {Object} SpriteDef  One sprite as data.
   * @property {string} [name]          For warnings.
   * @property {string[]} [rows]        One frame: strings of palette characters ('.' and ' ' are transparent).
   * @property {string[][]} [frames]    Several frames (instead of rows); shorter frames are bottom-aligned.
   * @property {Object<string, number>} pal  Palette: character -> 0xRRGGBB.
   * @property {Object<string, number[]>} [anims]  Named frame sequences for sprite.play(name).
   * @property {boolean} [mirror]       Rows give the left half; the right half is its mirror image.
   * @property {number} [border=1]      Paper border width in pixels.
   * @property {boolean} [wrap]         Seamless repeating tile for surfaces: no border, no margin.
   *
   * @typedef {{ x: number, y: number, color: number }} Cell  One painted pixel of a frame, relative to the art's top-left.
   *
   * @typedef {Object} Baked  A sprite definition turned into a texture.
   * @property {HTMLCanvasElement} canvas  All frames side by side.
   * @property {Object} texture       THREE.CanvasTexture over the canvas (nearest-filtered, sRGB).
   * @property {number} frameCount
   * @property {number} artWidth      Width of the art alone, in pixels.
   * @property {number} artHeight
   * @property {number} frameWidth    Width of one frame including border and margin, in pixels.
   * @property {number} frameHeight
   * @property {number} padding       Border plus a one-pixel margin on every side (0 for wrap tiles).
   */

  const toCss = (hex) => '#' + hex.toString(16).padStart(6, '0');
  const mirrorRow = (row) => row + [...row].reverse().join('');
  const countFrames = (def) => (def.frames ? def.frames.length : 1);

  /**
   * The rows of one frame, with the mirror applied.
   * @param {SpriteDef} def
   * @param {number} [frame=0]
   * @returns {string[]}
   */
  const rowsOf = (def, frame = 0) => {
    const rows = def.frames ? def.frames[frame] : def.rows;
    return def.mirror ? rows.map(mirrorRow) : rows;
  };

  /**
   * Width and height of the art in pixels, over all frames.
   * @param {SpriteDef} def
   * @returns {{ width: number, height: number }}
   */
  const measure = (def) => {
    const frames = Array.from({ length: countFrames(def) }, (_, frame) => rowsOf(def, frame));
    return { width: Math.max(...frames.flatMap((rows) => rows.map((row) => row.length))), height: Math.max(...frames.map((rows) => rows.length)) };
  };

  /** Border width a definition is baked with: wrap tiles never have one. */
  const borderOf = (def) => (def.wrap ? 0 : def.border === undefined ? 1 : def.border);

  /**
   * Every pixel to paint for one frame: the art, plus a paper border around its silhouette.
   * @param {SpriteDef} def
   * @param {number} [frame=0]
   * @param {number} [border]  Border width in pixels (default: the definition's own).
   * @returns {Cell[]} Cells may have negative coordinates: the border sits outside the art's box.
   * @complexity O(w x h x b^2) time for a w x h frame with border b (each empty pixel looks at its (2b+1)^2 neighbours), O(w x h) space. Runs once per definition at bake time, never per frame.
   * @example
   *   Kit.pixel.cells({ rows: ['r'], pal: { r: 0xff0000 } });   // 1 red cell + 8 paper cells around it
   */
  function cells(def, frame = 0, border = borderOf(def)) {
    const rows = rowsOf(def, frame);
    const { width, height } = measure(def);
    const top = height - rows.length; // shorter frames stand on the same baseline as the tallest
    /** Palette colour of the art at (x, y), or null where the art is transparent or outside its box. */
    const inkAt = (x, y) => {
      const row = rows[y - top];
      const char = row && row[x];
      if (char === undefined || TRANSPARENT.includes(char)) return null;
      if (def.pal[char] === undefined) {
        console.warn('[pixel] unknown colour', char, 'in', def.name || def);
        return null;
      }
      return def.pal[char];
    };
    const reach = Array.from({ length: border * 2 + 1 }, (_, index) => index - border);
    const hasInkNearby = (x, y) => reach.some((dy) => reach.some((dx) => inkAt(x + dx, y + dy) !== null));
    /** Paper for an empty pixel next to the art; the darker edge tone when it sits right below a painted pixel. */
    const paperAt = (x, y) => (!hasInkNearby(x, y) ? null : inkAt(x, y - 1) !== null ? PAPER_EDGE : PAPER);
    const spanY = Array.from({ length: height + border * 2 }, (_, index) => index - border);
    const spanX = Array.from({ length: width + border * 2 }, (_, index) => index - border);
    return spanY.flatMap((y) =>
      spanX.flatMap((x) => {
        const ink = inkAt(x, y);
        const color = ink !== null ? ink : border ? paperAt(x, y) : null;
        return color === null ? [] : [{ x, y, color }];
      })
    );
  }

  /**
   * Paint every frame of a definition side by side on one canvas.
   * @param {SpriteDef} def
   * @returns {Omit<Baked, 'texture'>}
   */
  function bake(def) {
    const border = borderOf(def), frameCount = countFrames(def);
    const { width, height } = measure(def);
    const padding = def.wrap ? 0 : border + 1; // the extra pixel keeps neighbouring frames from bleeding into each other
    const frameWidth = width + padding * 2, frameHeight = height + padding * 2;
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth * frameCount;
    canvas.height = frameHeight;
    const pen = canvas.getContext('2d');
    for (let frame = 0; frame < frameCount; frame++) {
      for (const cell of cells(def, frame, border)) {
        pen.fillStyle = toCss(cell.color);
        pen.fillRect(frame * frameWidth + padding + cell.x, padding + cell.y, 1, 1);
      }
    }
    return { canvas, frameCount, artWidth: width, artHeight: height, frameWidth, frameHeight, padding };
  }

  /** Baked textures by definition object, so every sprite of one definition shares a texture. */
  const bakedByDef = new WeakMap();

  /**
   * The baked texture of a definition (cached per definition object).
   * @param {SpriteDef} def
   * @returns {Baked}
   */
  function texture(def) {
    if (bakedByDef.has(def)) return bakedByDef.get(def);
    const baked = bake(def);
    baked.texture = new THREE.CanvasTexture(baked.canvas);
    baked.texture.magFilter = baked.texture.minFilter = THREE.NearestFilter; // crisp pixels at any size
    baked.texture.generateMipmaps = false;
    baked.texture.encoding = THREE.sRGBEncoding;
    if (def.wrap) baked.texture.wrapS = baked.texture.wrapT = THREE.RepeatWrapping;
    bakedByDef.set(def, baked);
    return baked;
  }

  /**
   * One frame as a plain canvas scaled by whole pixels, for HUD cards and shop icons.
   * @param {SpriteDef} def
   * @param {{ frame?: number, scale?: number }} [options] scale: screen pixels per art pixel (default 4).
   * @returns {HTMLCanvasElement}
   */
  function canvas(def, { frame = 0, scale = 4 } = {}) {
    const baked = texture(def);
    const out = document.createElement('canvas');
    out.width = baked.frameWidth * scale;
    out.height = baked.frameHeight * scale;
    const pen = out.getContext('2d');
    pen.imageSmoothingEnabled = false;
    pen.drawImage(baked.canvas, frame * baked.frameWidth, 0, baked.frameWidth, baked.frameHeight, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * Turn a table of art into named definitions that share one palette.
   * @param {Object<string, number>} pal
   * @param {Object<string, string[] | Partial<SpriteDef>>} table  name -> rows, or a partial definition.
   * @returns {Object<string, SpriteDef>}
   * @complexity O(n) for n entries; the rows themselves are shared, not copied.
   */
  const sheet = (pal, table) =>
    Object.fromEntries(Object.entries(table).map(([name, art]) => [name, { name, pal, ...(Array.isArray(art) ? { rows: art } : art) }]));

  /**
   * A copy of a definition with some palette colours swapped (blossom tree from a green tree).
   * @param {SpriteDef} def
   * @param {Object<string, number>} swaps  character -> new 0xRRGGBB.
   * @returns {SpriteDef}
   */
  const recolor = (def, swaps) => ({ ...def, pal: { ...def.pal, ...swaps } });

  /**
   * A single-frame definition made of `count` copies of a sprite's first frame side by side (fence runs, wave strips).
   * @param {SpriteDef} def
   * @param {number} count
   * @returns {SpriteDef}
   * @complexity O(rows x count) characters.
   */
  const tile = (def, count) => ({ ...def, rows: rowsOf(def, 0).map((row) => row.repeat(count)), frames: undefined, mirror: false });

  /**
   * A paper tag with text in the 3x5 pixel font (capitals, digits and ! ? + - . only; anything else is a space).
   * @param {string} text
   * @param {{ ink?: number, fill?: number }} [colors]  Text and background colours, 0xRRGGBB.
   * @returns {SpriteDef}
   * @complexity O(characters).
   */
  function label(text, { ink = LABEL_INK, fill = PAPER } = {}) {
    const glyphs = [...String(text).toUpperCase()].map((char) => FONT[char] || FONT[' ']);
    const glyphRow = (glyph, row) => GLYPH_BITS.map((bit) => (parseInt(glyph[row], 16) & bit ? '#' : '_')).join('') + '_';
    const textRows = Array.from({ length: GLYPH_ROWS }, (_, row) => '__' + glyphs.map((glyph) => glyphRow(glyph, row)).join('') + '_');
    const blank = '_'.repeat(textRows[0].length);
    return { name: 'label:' + text, rows: [blank, ...textRows, blank], pal: { '#': ink, _: fill } };
  }

  // ---- true colour ---------------------------------------------------------------------------------------------------
  // Unlit materials skip the renderer's tone mapping, but the kit's post pass tone maps the whole frame. While it is
  // on, sprite shaders run the inverse of its ACES curve first, so the two cancel and palette colours come out as written.
  const postIsOn = { value: 0 }; // shared shader uniform: 1 while the post pass is active
  const INVERSE_ACES = `if (uPaperTone > 0.5) {
          // ACES fit: y = x(2.51x + 0.03) / (x(2.43x + 0.59) + 0.14). Solving for x is a quadratic in x; 0.56 = 4 * 0.14.
          // The curve cannot output much above 0.93, so brighter colours are clamped there and scaled back up linearly.
          vec3 written = gl_FragColor.rgb, y = min(written, vec3(0.93)), a = 2.51 - 2.43 * y, b = 0.03 - 0.59 * y;
          gl_FragColor.rgb = (-b + sqrt(b * b + 0.56 * a * y)) / (2.0 * a) * max(vec3(1.0), written / 0.93);
        }
        #include <tonemapping_fragment>`;
  /** Make a material show its colours exactly as written, whether or not the post pass is running. */
  function keepTrueColor(material) {
    material.toneMapped = false;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPaperTone = postIsOn;
      shader.fragmentShader = 'uniform float uPaperTone;\n' + shader.fragmentShader.replace('#include <tonemapping_fragment>', INVERSE_ACES);
    };
    return material;
  }

  // ---- sprite animation: each part is a tiny object with update(dt) that writes to the sprite's pivot -----------------

  /** Plays a list of frame indices at a rate; start(null) stops it. */
  function framePlayer(showFrame) {
    let sequence = null, clock = 0, framesPerSecond = 8;
    return {
      start(next, rate) {
        if (next !== sequence) clock = 0; // restarting the same animation must not make it stutter
        sequence = next;
        framesPerSecond = rate;
      },
      update(dt) {
        if (!sequence) return;
        clock += dt * framesPerSecond;
        showFrame(sequence[Math.floor(clock) % sequence.length]);
      },
    };
  }

  /** The paper flip: turns the pivot about the vertical axis toward the side the sprite faces. */
  function flipper(pivot) {
    let angle = 0, goal = 0;
    return {
      turnTo(facing, isInstant) {
        goal = facing < 0 ? Math.PI : 0;
        if (isInstant) pivot.rotation.y = angle = goal;
      },
      update(dt) {
        if (angle === goal) return;
        const step = (Math.PI / FLIP_SECONDS) * dt;
        angle = Math.abs(goal - angle) <= step ? goal : angle + Math.sign(goal - angle) * step;
        pivot.rotation.y = angle;
      },
    };
  }

  /** A hop: the pivot follows a parabola, then calls onLand once. */
  function hopper(pivot) {
    let clock = -1, height = 0, seconds = 1, onLand = null;
    return {
      start(hopHeight, hopSeconds, callback) {
        clock = 0;
        height = hopHeight;
        seconds = hopSeconds;
        onLand = callback || null;
      },
      update(dt) {
        if (clock < 0) return;
        clock += dt;
        const progress = Math.min(1, clock / seconds);
        pivot.position.y = height * 4 * progress * (1 - progress); // parabola: 0 at both ends, `height` in the middle
        if (progress < 1) return;
        clock = -1;
        const landed = onLand;
        onLand = null; // cleared first: the callback may start another hop
        if (landed) landed();
      },
    };
  }

  /** A squash: a decaying wobble of the pivot's scale. */
  function squasher(pivot) {
    let clock = -1, amount = 0;
    return {
      start(squashAmount) {
        clock = 0;
        amount = squashAmount;
      },
      update(dt) {
        if (clock < 0) return;
        clock += dt;
        const isDone = clock > SQUASH.seconds;
        const wobble = isDone ? 0 : amount * Math.cos(clock * SQUASH.frequency) * Math.exp(-clock * SQUASH.decay);
        pivot.scale.set(1 + wobble * SQUASH.stretchShare, 1 - wobble, 1);
        if (isDone) clock = -1;
      },
    };
  }

  /**
   * @typedef {Object} SpriteOptions
   * @property {number[]} [at]       [x, y, z] of the sprite's foot (or centre, with anchor 'center').
   * @property {number} [unit]       World units per art pixel.
   * @property {number} [lean]       Backward tilt in radians, so upright paper faces a tilted camera.
   * @property {boolean} [shadow]    Soft blob shadow on the ground under it.
   * @property {Object} [tint]       THREE.Color multiplied into the art; a shared instance recolours every user at once.
   * @property {number} [bright=1]   Extra brightness multiplier.
   * @property {'bottom' | 'center'} [anchor='bottom']
   * @property {Object} [parent]     THREE.Object3D to add it to (default: the scene).
   *
   * @typedef {Object} PaperSprite
   * @property {Object} root     THREE.Group: move this.
   * @property {Object} pivot    THREE.Group inside root: rotate or scale this for your own effects.
   * @property {Object} mesh     The textured plane.
   * @property {Object | null} shadow
   * @property {SpriteDef} def   What it is showing now.
   * @property {number} width    World width of the art.
   * @property {number} height
   * @property {number} facing   +1 (as drawn) or -1 (flipped).
   * @property {(def: SpriteDef) => PaperSprite} set      Show another definition.
   * @property {(index: number) => PaperSprite} frame     Show one frame (wraps).
   * @property {(name: string | number[], framesPerSecond?: number) => PaperSprite} play  Loop a named anim or a frame list.
   * @property {(index?: number) => PaperSprite} stop     Stop animating and show a frame.
   * @property {(isVisible: boolean) => PaperSprite} show
   * @property {(direction: number, isInstant?: boolean) => PaperSprite} face  Paper flip toward the sign of `direction`.
   * @property {(height?: number, seconds?: number, onLand?: () => void) => PaperSprite} hop
   * @property {(amount?: number) => PaperSprite} squash
   * @property {(dt: number) => void} update  Called by paper.update.
   */

  /**
   * Per-game sprite factory: shares materials, the blob shadow and one update loop between its sprites.
   * @param {Object} ctx  The game ctx (scene, post).
   * @param {SpriteOptions} [defaults]  Defaults for every sprite: { unit: 1 / 16, lean: 0, shadow: true, tint: white }.
   * @returns {{ sprite: (def: SpriteDef, options?: SpriteOptions) => PaperSprite,
   *             flat: (map?: Object | null, options?: Object) => Object, tint: Object, update: (dt: number) => void }}
   * @complexity update: O(s) per frame for s visible sprites, with no allocation. Sprites of one definition share a
   *             texture and a material, so draw state changes scale with definitions, not sprites.
   */
  function use(ctx, defaults = {}) {
    const settings = { unit: DEFAULT_UNIT, lean: 0, shadow: true, tint: new THREE.Color(1, 1, 1), ...defaults };
    const sprites = [];
    const paperMaterials = new Map();
    const syncPostState = () => (postIsOn.value = ctx.post && ctx.post.active ? 1 : 0);
    let shadowParts = null;

    /**
     * An unlit, double-sided material with the same true-colour handling as the sprites (backdrops, water, rings).
     * @param {Object | null} [map]  THREE.Texture or null for a plain colour.
     * @param {{ color?: number | Object, opacity?: number, additive?: boolean, alphaTest?: number }} [options]
     *        color: 0xRRGGBB, or a THREE.Color instance that stays shared (mutate it to recolour every user).
     * @returns {Object} THREE.MeshBasicMaterial
     */
    function flat(map = null, { color = 0xffffff, opacity = 1, additive = false, alphaTest = 0 } = {}) {
      const isSeeThrough = additive || opacity < 1;
      const material = keepTrueColor(new THREE.MeshBasicMaterial({
        map, side: THREE.DoubleSide, fog: false, alphaTest, opacity, transparent: isSeeThrough, depthWrite: !isSeeThrough,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      // Assigned after construction: the constructor would copy a passed colour, and a shared tint must stay shared.
      material.color = color.isColor ? color : new THREE.Color(color).convertSRGBToLinear();
      return material;
    }

    /** One paper material per (texture, tint, brightness), shared by every sprite that uses that combination. */
    function paperMaterial(baked, tint, bright) {
      const key = [baked.texture.uuid, tint.uuid, bright].join('|');
      if (!paperMaterials.has(key)) {
        paperMaterials.set(key, flat(baked.texture, { color: bright === 1 ? tint : tint.clone().multiplyScalar(bright), alphaTest: 0.5 }));
      }
      return paperMaterials.get(key);
    }

    /** A soft dark disc lying on the ground; geometry and material are made once and shared. */
    function blobShadow() {
      if (!shadowParts) {
        const size = SHADOW.texturePx, half = size / 2;
        const blob = document.createElement('canvas');
        blob.width = blob.height = size;
        const pen = blob.getContext('2d');
        const fade = pen.createRadialGradient(half, half, 2, half, half, half);
        fade.addColorStop(0, 'rgba(0,0,0,1)');
        fade.addColorStop(0.6, 'rgba(0,0,0,.7)');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
        pen.fillStyle = fade;
        pen.fillRect(0, 0, size, size);
        shadowParts = {
          geometry: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
          material: new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blob), color: 0x000000, transparent: true, opacity: SHADOW.opacity, depthWrite: false, toneMapped: false, fog: false }),
        };
      }
      const shadow = new THREE.Mesh(shadowParts.geometry, shadowParts.material);
      shadow.position.y = SHADOW.lift;
      shadow.renderOrder = -1; // under the sprites that stand on it
      return shadow;
    }

    /**
     * Stand a paper cut-out up in the scene.
     * @param {SpriteDef} def
     * @param {SpriteOptions} [options]
     * @returns {PaperSprite}
     */
    function sprite(def, options = {}) {
      const { unit, lean, tint, shadow: wantsShadow } = { ...settings, ...options };
      const { bright = 1, anchor = 'bottom', parent = ctx.scene, at } = options;
      const root = new THREE.Group(), pivot = new THREE.Group(), mesh = new THREE.Mesh();
      mesh.onBeforeRender = syncPostState;
      pivot.add(mesh);
      root.add(pivot);
      pivot.rotation.x = -lean; // Euler order XYZ: roll (z) and flip (y) happen in the sprite's own frame, the lean last
      const shadow = wantsShadow ? blobShadow() : null;
      if (shadow) root.add(shadow);
      if (at) root.position.set(at[0], at[1], at[2]);
      parent.add(root);

      const self = { root, pivot, mesh, shadow, def: null, width: 0, height: 0, facing: 1 };
      let baked = null, shownFrame = -1;
      const frames = framePlayer((index) => self.frame(index));
      const flip = flipper(pivot), hop = hopper(pivot), squash = squasher(pivot);

      self.set = (next) => {
        if (next === self.def) return self;
        self.def = next;
        baked = texture(next);
        mesh.material = paperMaterial(baked, tint, bright);
        mesh.geometry.dispose();
        const planeWidth = baked.frameWidth * unit, planeHeight = baked.frameHeight * unit;
        // Bottom anchor: the lowest art pixel (not the padding under it) sits exactly on the root's origin.
        mesh.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight).translate(0, anchor === 'center' ? 0 : planeHeight / 2 - baked.padding * unit, 0);
        self.width = baked.artWidth * unit;
        self.height = baked.artHeight * unit;
        if (shadow) shadow.scale.set(self.width * SHADOW.widthShare, 1, Math.max(SHADOW.minDepth, self.width * SHADOW.depthShare));
        frames.start(null);
        shownFrame = -1;
        return self.frame(0);
      };
      self.frame = (index) => {
        const wrapped = ((index % baked.frameCount) + baked.frameCount) % baked.frameCount;
        if (wrapped === shownFrame) return self;
        shownFrame = wrapped;
        // A plane's four corners are (left, top), (right, top), (left, bottom), (right, bottom): slide them over the strip.
        const uv = mesh.geometry.attributes.uv, left = wrapped / baked.frameCount, right = (wrapped + 1) / baked.frameCount;
        [[left, 1], [right, 1], [left, 0], [right, 0]].forEach(([u, v], corner) => uv.setXY(corner, u, v));
        uv.needsUpdate = true;
        return self;
      };
      self.play = (name, framesPerSecond = 8) => {
        frames.start(Array.isArray(name) ? name : (self.def.anims && self.def.anims[name]) || [0], framesPerSecond);
        return self;
      };
      self.stop = (index = 0) => {
        frames.start(null);
        return self.frame(index);
      };
      self.show = (isVisible) => {
        root.visible = !!isVisible;
        return self;
      };
      self.face = (direction, isInstant = false) => {
        self.facing = direction < 0 ? -1 : 1;
        flip.turnTo(self.facing, isInstant);
        return self;
      };
      self.hop = (height = 0.3, seconds = 0.25, onLand) => {
        hop.start(height, seconds, () => {
          self.squash(Math.min(LANDING.maxSquash, height * LANDING.perHeight));
          if (onLand) onLand();
        });
        return self;
      };
      self.squash = (amount = 0.25) => {
        squash.start(amount);
        return self;
      };
      const animators = [frames, flip, hop, squash];
      self.update = (dt) => animators.forEach((animator) => animator.update(dt));
      sprites.push(self);
      return self.set(def);
    }

    return {
      sprite,
      flat,
      tint: settings.tint,
      update(dt) {
        syncPostState();
        for (const each of sprites) if (each.root.visible) each.update(dt);
      },
    };
  }

  Kit.pixel = { use, sheet, texture, canvas, cells, label, recolor, tile, PAPER };
})();
