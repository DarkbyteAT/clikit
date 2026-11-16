/**
 * Kit make: scene-building helpers.
 *
 * Owns:  colour conversion, cached materials, shape meshes, instanced crowds, canvas textures,
 *        groups, the ground plane, the sky / fog / lights "stage", glow sprites, outline frames,
 *        scrolling dot fields and per-frame batches.
 * Does not own: animation (ctx.tween, fx.js), game rules, post-processing (post.js), pixel-art
 *        sprites (pixel.js) or disposal (the shell disposes the whole scene on exit / restart).
 *
 * Every mesh helper adds what it builds to the scene (or to `options.parent`) and returns it.
 * Colours: the renderer outputs sRGB, so every hex colour is converted to linear space here.
 * Build materials through this module, or convert with `make.color(hex)`; a raw
 * `new THREE.Color(hex)` looks washed out.
 *
 * Needs the DOM and THREE, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  // ---- tunables ------------------------------------------------------------------------------------------------------

  const DEFAULT_ROUGHNESS = 0.6;
  /** Radial / height segments of a sphere, and radial segments of cylinders and cones: round enough at phone size. */
  const SPHERE_SEGMENTS = [24, 16];
  const CYLINDER_SEGMENTS = 20;
  const CONE_SEGMENTS = 16;
  /** Unused instances are parked far below the world at zero scale until they are placed. */
  const PARKED_INSTANCE_Y = -9999;

  const DEFAULT_GROUND_SIZE = 60;
  const DEFAULT_GROUND_COLOR = 0x2a3350;
  /** The ground is matt so the sun does not draw a glossy highlight across it. */
  const GROUND_ROUGHNESS = 0.95;
  /** Grid lines sit just above the ground so the two do not z-fight. */
  const GRID_LIFT = 0.01;
  const DEFAULT_GRID_OPACITY = 0.25;

  /** The sky is a vertical gradient; a 2 x 256 canvas is enough because it only varies with height. */
  const SKY_CANVAS_WIDTH = 2;
  const SKY_CANVAS_HEIGHT = 256;
  const DEFAULT_SKY = [0x23305e, 0x0d1226];
  const DEFAULT_SKY_LIGHT = 0xbfd4ff;
  const DEFAULT_GROUND_LIGHT = 0x50465e;
  const DEFAULT_AMBIENT_INTENSITY = 0.7;
  const DEFAULT_SUN_COLOR = 0xfff1dd;
  const DEFAULT_SUN_INTENSITY = 1.25;
  const DEFAULT_SUN_OFFSET = [6, 12, 5];
  /** Half-width, in world units, of the square area round the focus that receives sun shadows. */
  const DEFAULT_SHADOW_HALF_EXTENT = 16;
  const SHADOW_NEAR = 0.5;
  const SHADOW_FAR = 80;
  const SHADOW_MAP_SIZE = 1024;
  // Biases that stop lit surfaces shadowing themselves in stripes ("shadow acne") without detaching shadows from their casters.
  const SHADOW_BIAS = -0.0005;
  const SHADOW_NORMAL_BIAS = 0.03;

  const GLOW_TEXTURE_SIZE = 64;
  /** The glow sprite's falloff from centre to edge, as [position 0..1, CSS colour]: a hot core, then a long soft skirt. */
  const GLOW_STOPS = [
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,.45)'],
    [1, 'rgba(255,255,255,0)'],
  ];
  const DEFAULT_GLOW_OPACITY = 0.9;

  // ---- pure helpers --------------------------------------------------------------------------------------------------

  /** The option's value, or a default when the option was left out (unlike `||`, a deliberate 0 is kept). */
  const optionOr = (value, fallback) => (value === undefined ? fallback : value);

  /** Is the opacity option asking for see-through? */
  const isTranslucent = (opacity) => opacity !== undefined && opacity < 1;

  /** A new canvas and its 2D context. */
  const createCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, context: canvas.getContext('2d') };
  };

  /**
   * Fills a canvas area with a gradient.
   * @param {CanvasRenderingContext2D} context
   * @param {CanvasGradient} gradient from createLinearGradient / createRadialGradient
   * @param {Array<[number, string]>} stops [position 0..1, CSS colour]
   * @param {number} width pixels
   * @param {number} height pixels
   */
  const fillGradient = (context, gradient, stops, width, height) => {
    stops.forEach(([position, cssColor]) => gradient.addColorStop(position, cssColor));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  };

  /** Moves an object to `[x, y, z]` when a position was given. */
  const placeAt = (object, at) => {
    if (at) object.position.set(at[0], at[1], at[2]);
  };

  /**
   * @typedef {Object} MaterialOptions
   * @property {number} [rough=0.6] roughness 0 (mirror) .. 1 (matt)
   * @property {number} [metal=0] metalness 0..1
   * @property {number} [emissive=0x000000] self-lit colour, 0xRRGGBB
   * @property {number} [emissiveIntensity=1] above 1 the emissive colour blooms
   * @property {number} [opacity=1] below 1 the material becomes transparent
   * @property {boolean} [flat=false] faceted (flat-shaded) look
   * @property {boolean} [fresh=false] make an uncached copy, for a material you will change per object
   */

  /**
   * @typedef {Object} UnlitOptions
   * @property {number} [opacity=1]
   * @property {boolean} [additive=false] add to what is behind (light beams, neon)
   * @property {number} [bright=1] above 1 pushes the colour past the bloom threshold so it glows
   * @property {boolean} [fresh=false] make an uncached copy
   */

  /**
   * @typedef {MaterialOptions & {at?: number[], parent?: (THREE.Object3D|null), shadow?: boolean, seg?: number}} MeshOptions
   * Options every shape helper takes: the material options (used when the colour argument is a hex),
   * `at: [x, y, z]`, `parent` (default: the scene; null = do not add anywhere), `shadow: false` to
   * neither cast nor receive, and `seg` for the radial segments of cyl / cone.
   */

  /**
   * @typedef {Object} StageOptions
   * @property {[number, number]} [sky] [top, bottom] gradient colours, 0xRRGGBB
   * @property {[number, number]} [fog] [near, far] distances in world units; omitted = no fog
   * @property {number} [fogColor] defaults to the sky's bottom colour, so the horizon blends
   * @property {[number, number, number]} [sun] sun position relative to the focus point
   * @property {number} [sunColor]
   * @property {number} [sunIntensity=1.25]
   * @property {number} [skyLight] hemisphere light colour from above
   * @property {number} [groundLight] hemisphere light colour from below
   * @property {number} [ambient=0.7] hemisphere light intensity
   * @property {number} [shadow=16] half-width of the shadowed area round the focus, world units
   */

  /**
   * Creates the scene-building helpers for a game. The shell does this and exposes them as `ctx.make`.
   * @param {Object} ctx the shell context (uses scene)
   * @returns {Object} `{ color, mat, unlit, mesh, box, sphere, cyl, cone, ico, prism, instanced, batch, canvasTexture,
   *   group, ground, stage, glow, frame, dots }`
   * @example
   * make.stage({ sky: [0x23305e, 0x0d1226], fog: [20, 60] });
   * make.ground(60, 0x2a3350, { grid: 0x4a5a8a });
   * const crate = make.box(1, 1, 1, 0xffc145, { at: [0, 0.5, 0] });
   */
  Kit.make = (ctx) => {
    const { scene } = ctx;
    /** Shared materials by option key, so a hundred boxes of one colour cost one material. */
    const materialCache = new Map();

    /**
     * Converts an sRGB hex colour to the linear space the renderer works in. Use this for any
     * THREE.Color you make yourself.
     * @param {number} hex 0xRRGGBB
     * @returns {THREE.Color}
     */
    const color = (hex) => new THREE.Color(hex).convertSRGBToLinear();

    /** Returns the cached material for a key, building (and caching) it on first use. `fresh` bypasses the cache both ways. */
    const cachedMaterial = (key, isFresh, build) => {
      if (isFresh) return build();
      if (!materialCache.has(key)) materialCache.set(key, build());
      return materialCache.get(key);
    };

    /**
     * A lit (standard) material, shared between calls with the same arguments.
     * @param {number} [hex=0xffffff] 0xRRGGBB
     * @param {MaterialOptions} [options]
     * @returns {THREE.MeshStandardMaterial}
     * @example make.mat(0x66ccff, { emissive: 0x66ccff, emissiveIntensity: 2 })
     */
    function mat(hex = 0xffffff, options = {}) {
      const key = [hex, options.emissive, options.emissiveIntensity, options.rough, options.metal, options.opacity, options.flat].join('|');
      return cachedMaterial(
        key,
        options.fresh,
        () =>
          new THREE.MeshStandardMaterial({
            color: color(hex),
            roughness: optionOr(options.rough, DEFAULT_ROUGHNESS),
            metalness: options.metal || 0,
            emissive: color(optionOr(options.emissive, 0x000000)),
            emissiveIntensity: optionOr(options.emissiveIntensity, 1),
            flatShading: Boolean(options.flat),
            transparent: isTranslucent(options.opacity),
            opacity: optionOr(options.opacity, 1),
          })
      );
    }

    /**
     * A cheap unlit material for backdrops, parallax layers and neon shapes: no lighting cost.
     * @param {number} [hex=0xffffff] 0xRRGGBB
     * @param {UnlitOptions} [options]
     * @returns {THREE.MeshBasicMaterial}
     */
    function unlit(hex = 0xffffff, options = {}) {
      // The 'u' prefix keeps unlit keys apart from lit ones in the shared cache.
      const key = ['u', hex, options.opacity, options.additive, options.bright].join('|');
      return cachedMaterial(
        key,
        options.fresh,
        () =>
          new THREE.MeshBasicMaterial({
            color: color(hex).multiplyScalar(options.bright || 1),
            transparent: Boolean(options.additive) || isTranslucent(options.opacity),
            opacity: optionOr(options.opacity, 1),
            blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
            // Additive layers must not block what is drawn behind them later.
            depthWrite: !options.additive,
            toneMapped: false,
          })
      );
    }

    /** A shape helper's colour argument is a hex colour OR a ready material (make.mat / make.unlit). */
    const toMaterial = (hexOrMaterial, options) => (hexOrMaterial && hexOrMaterial.isMaterial ? hexOrMaterial : mat(hexOrMaterial, options));

    /** Adds an object to `parent`, or to the scene when no parent was given. */
    const addToParent = (object, parent) => (parent || scene).add(object);

    /**
     * Builds a mesh from any geometry; the base of every shape helper.
     * @param {THREE.BufferGeometry} geometry
     * @param {number | THREE.Material} hexOrMaterial
     * @param {MeshOptions} [options]
     * @returns {THREE.Mesh} casting and receiving shadows unless `shadow: false`
     */
    function mesh(geometry, hexOrMaterial, options = {}) {
      const built = new THREE.Mesh(geometry, toMaterial(hexOrMaterial, options));
      if (options.shadow !== false) built.castShadow = built.receiveShadow = true;
      placeAt(built, options.at);
      // `parent: null` means "build it but do not add it" (for geometry donors and manual parenting).
      if (options.parent !== null) addToParent(built, options.parent);
      return built;
    }

    /** Box of width x height x depth (world units). @returns {THREE.Mesh} */
    const box = (width, height, depth, hexOrMaterial, options) => mesh(new THREE.BoxGeometry(width, height, depth), hexOrMaterial, options);
    /** Sphere of a radius. @returns {THREE.Mesh} */
    const sphere = (radius, hexOrMaterial, options) => mesh(new THREE.SphereGeometry(radius, ...SPHERE_SEGMENTS), hexOrMaterial, options);
    /** Cylinder (or cone frustum) with top and bottom radii; `options.seg` sets the radial segments. @returns {THREE.Mesh} */
    const cyl = (radiusTop, radiusBottom, height, hexOrMaterial, options = {}) =>
      mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, options.seg || CYLINDER_SEGMENTS), hexOrMaterial, options);
    /** Cone; `options.seg` sets the radial segments. @returns {THREE.Mesh} */
    const cone = (radius, height, hexOrMaterial, options = {}) => mesh(new THREE.ConeGeometry(radius, height, options.seg || CONE_SEGMENTS), hexOrMaterial, options);
    /** Low-poly rock / gem: an icosahedron (detail 0 = 20 faces), flat-shaded unless overridden. @returns {THREE.Mesh} */
    const ico = (radius, detail, hexOrMaterial, options = {}) => mesh(new THREE.IcosahedronGeometry(radius, detail || 0), hexOrMaterial, { flat: true, ...options });
    /** Flat n-sided shape lying in the ground plane (triangle, diamond, hexagon ...) for top-down 2D looks. @returns {THREE.Mesh} */
    const prism = (sides, radius, height, hexOrMaterial, options = {}) =>
      mesh(new THREE.CylinderGeometry(radius, radius, height, sides), hexOrMaterial, { flat: true, ...options });

    /**
     * Many copies of one shape in a single draw call, addressed by slot index. Crowds, coins,
     * scenery, speed lines. (For things that come and go every frame, see make.batch.)
     * @param {THREE.BufferGeometry} geometry
     * @param {number | THREE.Material} hexOrMaterial
     * @param {number} count slots; all start hidden
     * @param {MaterialOptions & {shadow?: boolean, parent?: THREE.Object3D}} [options] shadows are OFF unless `shadow: true`
     * @returns {THREE.InstancedMesh} with `place(index, x, y, z, scale = 1, rotationY = 0)`,
     *   `placeBox(index, x, y, z, scaleX, scaleY, scaleZ, rotationY = 0)` (stretched per axis, so one unit box can be
     *   every tower, plank or speed streak) and `commit()`, which must follow a batch of place calls
     * @example
     * const coins = make.instanced(coinGeometry, 0xffc145, 200);
     * COIN_SPOTS.forEach((spot, index) => coins.place(index, spot.x, 0.5, spot.z));
     * coins.commit();
     */
    function instanced(geometry, hexOrMaterial, count, options = {}) {
      const instances = new THREE.InstancedMesh(geometry, toMaterial(hexOrMaterial, options), count);
      const placement = new THREE.Object3D();
      // Instances are spread across the world, so the mesh's own bounding sphere says nothing useful.
      instances.frustumCulled = false;
      if (options.shadow) instances.castShadow = instances.receiveShadow = true;
      /** Writes one instance's matrix from a position, a per-axis scale and a turn about y. */
      const writeInstance = (index, x, y, z, scaleX, scaleY, scaleZ, rotationY) => {
        placement.position.set(x, y, z);
        placement.rotation.set(0, rotationY, 0);
        placement.scale.set(scaleX, scaleY, scaleZ);
        placement.updateMatrix();
        instances.setMatrixAt(index, placement.matrix);
      };
      instances.place = (index, x, y, z, scale = 1, rotationY = 0) => writeInstance(index, x, y, z, scale, scale, scale, rotationY);
      instances.placeBox = (index, x, y, z, scaleX, scaleY, scaleZ, rotationY = 0) => writeInstance(index, x, y, z, scaleX, scaleY, scaleZ, rotationY);
      instances.commit = () => (instances.instanceMatrix.needsUpdate = true);
      Array.from({ length: count }, (_, index) => instances.place(index, 0, PARKED_INSTANCE_Y, 0, 0));
      addToParent(instances, options.parent);
      return instances;
    }

    /**
     * A texture you paint with canvas 2D.
     * @param {number} width pixels
     * @param {number} height pixels
     * @param {function(CanvasRenderingContext2D, number, number): void} draw called once with (context, width, height)
     * @param {Object} [options]
     * @param {[number, number]} [options.repeat] tile it [across, down]
     * @param {boolean} [options.pixel] nearest-neighbour filtering, for crisp pixel art
     * @param {number} [options.anisotropy] e.g. 8 keeps a ground texture sharp at a grazing angle (roads, floors running to the horizon)
     * @returns {THREE.CanvasTexture}
     * @example make.canvasTexture(256, 256, (context, width, height) => { context.fillRect(0, 0, width / 2, height / 2); }, { repeat: [4, 4], pixel: true })
     */
    function canvasTexture(width, height, draw, options = {}) {
      const { canvas, context } = createCanvas(width, height);
      draw(context, width, height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.encoding = THREE.sRGBEncoding;
      if (options.repeat) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(options.repeat[0], options.repeat[1]);
      }
      if (options.pixel) texture.magFilter = texture.minFilter = THREE.NearestFilter;
      if (options.anisotropy) texture.anisotropy = options.anisotropy;
      return texture;
    }

    /**
     * An empty group, for moving several meshes as one.
     * @param {{at?: number[], parent?: THREE.Object3D}} [options]
     * @returns {THREE.Group}
     */
    const group = (options = {}) => {
      const built = new THREE.Group();
      placeAt(built, options.at);
      addToParent(built, options.parent);
      return built;
    };

    /**
     * A flat ground plane at y = 0 that receives shadows.
     * @param {number} [size=60] side length, world units
     * @param {number | THREE.Material} [hexOrMaterial=0x2a3350]
     * @param {MeshOptions & {grid?: number, cells?: number, gridOpacity?: number}} [options] `grid`: overlay a subtle grid
     *   of this colour; `cells`: grid divisions (default one per 2 units); `gridOpacity` (default 0.25)
     * @returns {THREE.Mesh}
     */
    function ground(size = DEFAULT_GROUND_SIZE, hexOrMaterial = DEFAULT_GROUND_COLOR, options = {}) {
      const plane = mesh(new THREE.PlaneGeometry(size, size), hexOrMaterial, { rough: GROUND_ROUGHNESS, ...options });
      // PlaneGeometry stands upright; lay it down.
      plane.rotation.x = -Math.PI / 2;
      plane.castShadow = false;
      if (options.grid !== undefined) {
        const grid = new THREE.GridHelper(size, options.cells || size / 2, color(options.grid), color(options.grid));
        grid.position.y = GRID_LIFT;
        grid.material.transparent = true;
        grid.material.opacity = options.gridOpacity || DEFAULT_GRID_OPACITY;
        scene.add(grid);
      }
      return plane;
    }

    /** '#rrggbb' for a hex number, as canvas 2D wants it. */
    const toCssColor = (hex) => '#' + new THREE.Color(hex).getHexString();

    /**
     * One call for the sky gradient, fog, a hemisphere light and a shadow-casting sun.
     * @param {StageOptions} [options]
     * @returns {{sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, follow: function({x: number, y: number, z: number}): void,
     *   setSky: function(number, number, number=): void}} `follow(point)` keeps shadows centred on a moving focus
     *   (call it each frame or when the focus moves); `setSky(top, bottom, fogColor = bottom)` repaints the sky at
     *   any time, e.g. when blending between altitude zones
     * @example
     * const stage = make.stage({ sky: [0x86c5ff, 0xe8f4ff], fog: [30, 90], sun: [-6, 12, 7] });
     * stage.follow(player.position);
     */
    function stage(options = {}) {
      const { canvas, context } = createCanvas(SKY_CANVAS_WIDTH, SKY_CANVAS_HEIGHT);
      const skyTexture = new THREE.CanvasTexture(canvas);
      skyTexture.encoding = THREE.sRGBEncoding;
      scene.background = skyTexture;

      const setSky = (top, bottom, fogColor = bottom) => {
        const gradient = context.createLinearGradient(0, 0, 0, SKY_CANVAS_HEIGHT);
        fillGradient(context, gradient, [[0, toCssColor(top)], [1, toCssColor(bottom)]], SKY_CANVAS_WIDTH, SKY_CANVAS_HEIGHT);
        skyTexture.needsUpdate = true;
        if (scene.fog) scene.fog.color.copy(color(fogColor));
      };

      const [skyTop, skyBottom] = options.sky || DEFAULT_SKY;
      // The fog is created before the first setSky call, which gives it its real colour.
      if (options.fog) scene.fog = new THREE.Fog(0x000000, options.fog[0], options.fog[1]);
      setSky(skyTop, skyBottom, optionOr(options.fogColor, skyBottom));

      const hemi = new THREE.HemisphereLight(
        color(options.skyLight || DEFAULT_SKY_LIGHT),
        color(options.groundLight || DEFAULT_GROUND_LIGHT),
        optionOr(options.ambient, DEFAULT_AMBIENT_INTENSITY)
      );
      scene.add(hemi);

      const sun = new THREE.DirectionalLight(color(options.sunColor || DEFAULT_SUN_COLOR), optionOr(options.sunIntensity, DEFAULT_SUN_INTENSITY));
      const sunOffset = new THREE.Vector3(...(options.sun || DEFAULT_SUN_OFFSET));
      sun.position.copy(sunOffset);
      sun.castShadow = true;
      const halfExtent = options.shadow || DEFAULT_SHADOW_HALF_EXTENT;
      Object.assign(sun.shadow.camera, { left: -halfExtent, right: halfExtent, top: halfExtent, bottom: -halfExtent, near: SHADOW_NEAR, far: SHADOW_FAR });
      sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      sun.shadow.bias = SHADOW_BIAS;
      sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
      // The target must be in the scene too, or moving it has no effect on the light's direction.
      scene.add(sun, sun.target);

      // The shadow map only covers a small square, so the sun and its target move together with the focus.
      const follow = (focus) => {
        sun.target.position.set(focus.x, focus.y, focus.z);
        sun.position.set(focus.x + sunOffset.x, focus.y + sunOffset.y, focus.z + sunOffset.z);
      };
      return { sun, hemi, follow, setSky };
    }

    /** The radial-falloff texture behind every glow sprite; painted on first use. */
    let glowTexture = null;
    const getGlowTexture = () => {
      if (!glowTexture) {
        const { canvas, context } = createCanvas(GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE);
        const centre = GLOW_TEXTURE_SIZE / 2;
        fillGradient(context, context.createRadialGradient(centre, centre, 0, centre, centre, centre), GLOW_STOPS, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE);
        glowTexture = new THREE.CanvasTexture(canvas);
      }
      return glowTexture;
    };

    /**
     * An additive soft glow sprite: a cheap halo for pickups, projectiles and lamps. It is
     * depth-tested by default, so one at floor level is cut by the floor: lift it or pass `depthTest: false`.
     * @param {number} [hex=0xffffff] 0xRRGGBB
     * @param {number} [size=1] diameter, world units
     * @param {{opacity?: number, depthTest?: boolean, at?: number[], parent?: (THREE.Object3D|null)}} [options] opacity default 0.9
     * @returns {THREE.Sprite}
     */
    function glow(hex = 0xffffff, size = 1, options = {}) {
      const material = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: color(hex),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: options.depthTest !== false,
        fog: false,
        transparent: true,
        opacity: optionOr(options.opacity, DEFAULT_GLOW_OPACITY),
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(size);
      placeAt(sprite, options.at);
      if (options.parent !== null) addToParent(sprite, options.parent);
      return sprite;
    }

    /** Outline geometries by border thickness, so every frame of one thickness shares a buffer. */
    const frameGeometries = new Map();
    /**
     * A flat square outline lying in the ground plane, 1 x 1 on the outside: scale x / z to fit any footprint.
     * Landing markers, selection boxes, tile highlights; fx.frame animates one as a pulse.
     * @param {number} [hex] 0xRRGGBB
     * @param {{ thickness?: number, bright?: number, opacity?: number, at?: number[], parent?: THREE.Object3D | null }} [options]
     *   thickness: border width as a fraction of the side (default 0.06); bright > 1 blooms; opacity 0..1; at / parent as for mesh()
     * @returns {THREE.Mesh} unlit and double-sided with its own material, so it is safe to recolour or fade
     * @example
     * const marker = make.frame(0xffd27a, { bright: 1.6, at: [0, 0.02, 0] });
     * marker.scale.set(4, 1, 4);
     */
    function frame(hex = 0xffffff, options = {}) {
      const thickness = options.thickness === undefined ? 0.06 : options.thickness;
      if (!frameGeometries.has(thickness)) {
        const outer = 0.5, inner = 0.5 - thickness;
        // Four outer corners then four inner corners, clockwise; each side is a quad (two triangles) between the two squares.
        const corners = [outer, inner].flatMap((half) => [[-half, -half], [half, -half], [half, half], [-half, half]]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, z]) => [x, 0, z]), 3));
        geometry.setIndex([0, 1, 2, 3].flatMap((side) => {
          const next = (side + 1) % 4;
          return [side, next, next + 4, side, next + 4, side + 4];
        }));
        frameGeometries.set(thickness, geometry);
      }
      const material = unlit(hex, { fresh: true, bright: options.bright, opacity: options.opacity });
      // An outline is an overlay: it must fade, show from below and never hide what is behind it.
      Object.assign(material, { transparent: true, side: THREE.DoubleSide, depthWrite: false });
      return mesh(frameGeometries.get(thickness), material, { shadow: false, at: options.at, parent: options.parent });
    }

    /**
     * A field of screen-sized points that can scroll along y for ever: two copies stacked one `height` apart, wrapped with Kit.span.wrap.
     * Stars, snow, dust motes, speed streaks. Keep the visible window no taller than `height`.
     * @param {number} count points per copy
     * @param {{ width?: number, height?: number, depth?: number[], color?: number, size?: number, bright?: number, parent?: THREE.Object3D }} [options]
     *   width / height: extent of one copy in the parent's units; depth: [near, far] distance behind the parent's origin (-z);
     *   color: 0xRRGGBB; size: point size in pixels; bright > 1 blooms
     * @returns {{ group: THREE.Group, material: THREE.PointsMaterial, scroll(offset: number): void, fade(weight: number): void }}
     *   scroll: shift the field up by `offset` units (any value, it wraps); fade: 0..1 opacity, hidden near 0
     * @example
     * const stars = make.dots(170, { depth: [46, 70], size: 2.2, bright: 1.8, parent: skyGroup });
     * stars.scroll(-altitude * 0.25); stars.fade(look.stars);
     */
    function dots(count, options = {}) {
      const { width = 26, height = 48, depth = [0, 0], color: hex = 0xffffff, size = 2, bright = 1, parent } = options;
      const { rand } = Kit.math;
      const positions = new Float32Array(Array.from({ length: count }).flatMap(() => [rand(-width / 2, width / 2), rand(0, height), -rand(depth[0], depth[1])]));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: color(hex).multiplyScalar(bright), size, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, toneMapped: false, blending: THREE.AdditiveBlending });
      const holder = group({ parent });
      const copies = [0, 1].map(() => {
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false; // the copies move every frame; culling against a stale bounding sphere would pop
        holder.add(points);
        return points;
      });
      return {
        group: holder,
        material,
        scroll(offset) {
          // Copy 0 spans [base, base + height) and copy 1 the stretch just below it, so together they always cover -height/2 .. height/2.
          const base = Kit.span.wrap(offset, height) - height / 2;
          copies.forEach((points, index) => (points.position.y = base - index * height));
        },
        fade(weight) {
          holder.visible = weight > 0.02;
          material.opacity = Math.min(1, weight);
        },
      };
    }

    /**
     * @typedef {Object} Batch
     * @property {THREE.InstancedMesh} mesh  the one mesh (and draw call) behind every instance
     * @property {function(): void} begin    start a frame: forget last frame's instances
     * @property {function(number, number, number, number, number, THREE.Color, number=): void} put
     *   put(x, z, rotationY, scaleX, scaleZ, color, bright = 1): add one instance on the batch's plane; `color` is a linear
     *   THREE.Color (make.color) and is not kept; bright > 1 blooms. Calls past the capacity are dropped.
     * @property {function(): void} end      finish the frame: show exactly what was put since begin()
     */

    /**
     * A flat crowd redrawn from plain data every frame: one instanced mesh whose instances are re-listed each frame with their
     * own position, turn, stretch and HDR colour. Use it when the things are plain objects in an array (enemies, shots,
     * pickups) that come and go; use make.instanced for a fixed set of slots you move by index.
     * @param {THREE.BufferGeometry} geometry shared shape, e.g. `make.prism(6, 1, 0.1, null, { parent: null }).geometry`
     * @param {number} capacity most instances drawn in one frame
     * @param {{ y?: number, material?: THREE.Material, parent?: THREE.Object3D }} [options]
     *   y: height of the plane the instances lie on (default 0); material: defaults to white unlit, so `color` is the colour seen
     * @returns {Batch}
     * @example
     * const shots = make.batch(make.box(1, 0.1, 1, null, { parent: null }).geometry, 160, { y: 0.3 });
     * shots.begin(); bullets.forEach((bullet) => shots.put(bullet.x, bullet.z, bullet.angle, 0.2, 1, SHOT_COLOR, 2.5)); shots.end();
     */
    function batch(geometry, capacity, options = {}) {
      const instances = new THREE.InstancedMesh(geometry, options.material || unlit(0xffffff), capacity);
      const placement = new THREE.Object3D();
      const tint = new THREE.Color();
      let used = 0;
      instances.frustumCulled = false; // instances roam far from the mesh's own origin
      instances.position.y = options.y || 0;
      instances.setColorAt(0, tint.setRGB(1, 1, 1)); // creates the per-instance colour buffer before the first frame
      instances.count = 0;
      (options.parent || scene).add(instances);
      return {
        mesh: instances,
        begin() {
          used = 0;
        },
        put(x, z, rotationY, scaleX, scaleZ, instanceColor, bright = 1) {
          if (used >= capacity) return;
          placement.position.set(x, 0, z);
          placement.rotation.y = rotationY;
          placement.scale.set(scaleX, 1, scaleZ);
          placement.updateMatrix();
          instances.setMatrixAt(used, placement.matrix);
          instances.setColorAt(used, tint.copy(instanceColor).multiplyScalar(bright));
          used++;
        },
        end() {
          instances.count = used;
          instances.instanceMatrix.needsUpdate = instances.instanceColor.needsUpdate = true;
        },
      };
    }

    return { color, mat, unlit, instanced, batch, canvasTexture, mesh, box, sphere, cyl, cone, ico, prism, group, ground, stage, glow, frame, dots };
  };
})();
