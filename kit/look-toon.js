/**
 * Kit look toon: the materials of the stylised look. A toon material turns n.L into a tone band and looks the
 * colour up in the palette texture; a hull material draws the mesh's outline in its ramp's ink colour.
 *
 * Owns:  the palette texture over a `Kit.palette.atlas`; the GLSL chunks (bands, ordered dither, accents, palette
 *        lookup, hull extrusion, region maps and their boundary lines, stamps) as named strings; `Kit.look.shading`: the uniforms every material of one look
 *        shares, `dress(mesh, part)` to put a mesh in the look, and `apply(settings, frame)` to change the look
 *        of every dressed mesh at once.
 * Does not own: colours (kit/palette.js), screen-space ink and low-resolution targets (look-ink.js), or
 *        when anything is drawn (look-view.js).
 *
 * Why a ShaderMaterial and not a patched MeshToonMaterial: the palette contract needs the fragment's last
 * word (a tone index or a table colour, never lit RGB, never tone mapped), and the standard material's
 * lighting, fog and tone-mapping chunks would all have to be cut back out through string patches that break
 * with the next three.js release. The cost: no scene lights, shadows or fog; the look has one key light of its own.
 *
 * GLSL here is WebGL1-safe (constant loop bounds, no integer bit operations, no MRT); three.js converts it for
 * WebGL2. Skinned and instanced meshes are supported through three.js's own vertex chunks; morph targets are not.
 * Needs THREE, so it is exercised in the browser (Kit.play('look')) rather than by unit tests.
 */
(() => {
  // ---- tunables --------------------------------------------------------------------------------------------------------

  /** The key light, in view space (x right, y up, z toward the viewer): from the upper left, in front. */
  const KEY_LIGHT = [-0.45, 0.75, 0.5];
  /** Rim: a lit pixel whose normal leans this little toward the viewer (view-space z) is lifted one tone. */
  const RIM = { maxFacing: 0.32, minLight: 0.25 };
  /** Shiny: n.h (h is halfway between the light and the viewer) above this takes the lightest tone. */
  const GLINT_EDGE = 0.93;
  /** Surface-fixed dither: pattern cells per world unit of a mesh's own space. */
  const DITHER_CELLS_PER_UNIT = 48;
  /** Gamma used when a look is drawn into the kit's linear HDR chain; it mirrors the 1 / 2.2 in kit/post.js. */
  const DISPLAY_GAMMA = 2.2;
  /** A stamp layer smaller than its least size is grown towards it, by at most this factor (a glint may double, a face may not balloon). */
  const STAMP_MOST_GROWTH = 2.5;
  /**
   * How far each later layer of a stamp is pulled toward the camera, in normalised device depth (the whole depth
   * range is 2). Layers lie on a curved surface as flat polygons a fraction of a millimetre apart, so a large
   * one sags under a small one's corners; the pull settles their order. Sixteen layers stay within a centimetre
   * under the kit's orthographic cameras (40 m deep).
   */
  const STAMP_DEPTH_STEP = 0.00002;
  /** A region line never reaches further than this share of the map from its fragment (near a pole the angle's gradient is unbounded). */
  const REGION_LINE_MOST_REACH = 0.06;
  /** Line classes pack into the tone byte of the index target above the tone: tone + CLASS_STEP x class. */
  const CLASS_STEP = 8;
  const { TONE_SLOTS, INK_COLUMN } = Kit.palette;
  const { MAX_EDGES } = Kit.look;

  // ---- GLSL chunks -----------------------------------------------------------------------------------------------------

  /**
   * Vertex stage shared by the toon and hull shaders: three.js's skinning and instancing chunks, in the order
   * its own materials use them. Leaves `transformedNormal` (view space), `mvPosition` and `gl_Position` set.
   */
  const GLSL_TRANSFORM = `
    #include <beginnormal_vertex>
    #ifdef LOOK_INK_NORMAL
      objectNormal = inkNormal;
    #endif
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #ifdef LOOK_STAMP
      transformed = stampCentre.xyz + (transformed - stampCentre.xyz) * stampGrowth();
    #endif
    #include <skinning_vertex>
    #include <project_vertex>
    #ifdef LOOK_STAMP
      gl_Position.z -= stampPaint.w * ${STAMP_DEPTH_STEP.toFixed(6)} * gl_Position.w;
    #endif`;

  /**
   * 4 x 4 ordered dither without a texture or bit operations. bayer2 is the 2 x 2 matrix [[0, 2], [3, 1]] / 4
   * written as a closed form; the 4 x 4 matrix is the 2 x 2 one of the half-resolution cell (worth a quarter)
   * plus the 2 x 2 one of the cell itself. Kit.look.bayerAt (look-settings.js) is the same table in JavaScript.
   */
  const GLSL_BAYER = `
    float bayer2(vec2 cell) { cell = floor(cell); return fract(cell.x / 2.0 + cell.y * cell.y * 0.75); }
    float bayer4(vec2 cell) { return bayer2(0.5 * cell) * 0.25 + bayer2(cell); }`;

  /**
   * Which pattern cell a fragment is in. Screen-fixed cells are target pixels measured from uAnchor (the
   * figure's snapped screen position, or zero); surface-fixed cells are small cubes of the mesh's own space,
   * with z folded into both axes so a cell does not become a column along z.
   */
  const GLSL_DITHER_CELL = `
    vec2 ditherCell() {
      #ifdef LOOK_DITHER_OBJECT
        vec3 cube = floor(vLocalPosition * uDitherCells);
        return mod(cube.xy + cube.z * vec2(1.0, 2.0), 4.0);
      #else
        return mod(floor(gl_FragCoord.xy - uAnchor), 4.0);
      #endif
    }`;

  /**
   * Light to tone. bandOf counts the band edges at or below the light value (unused edges are set out of
   * reach), so the result is a whole tone index. softBandOf replaces each step with a narrow smoothstep and
   * returns a fractional tone, which the fragment turns into a blend of two neighbouring table colours.
   */
  const GLSL_BANDS = `
    float bandOf(float light) {
      float tone = 0.0;
      for (int edge = 0; edge < ${MAX_EDGES}; edge++) tone += step(uEdges[edge], light);
      return tone;
    }
    float softBandOf(float light) {
      float tone = 0.0;
      for (int edge = 0; edge < ${MAX_EDGES}; edge++) tone += smoothstep(uEdges[edge] - uSoftness, uEdges[edge] + uSoftness, light);
      return tone;
    }`;

  /** The only place colour comes from: the centre of texel (tone column, ramp row) of the palette texture. */
  const GLSL_PALETTE = `
    vec3 paletteColor(float column, float row) {
      return texture2D(uPalette, vec2((column + 0.5) / ${TONE_SLOTS}.0, (row + 0.5) / uPaletteRows)).rgb;
    }
    vec3 toOutput(vec3 color) {
      #ifdef LOOK_LINEAR_OUTPUT
        return pow(color, vec3(${DISPLAY_GAMMA}));
      #else
        return color;
      #endif
    }`;

  /**
   * View depth packed into the alpha byte of the index target: 0 means "no surface here", 1..255 run from the
   * near to the far end of uDepthRange. Eight bits are enough because the range is fitted round the figures.
   */
  const GLSL_DEPTH_BYTE = `
    float depthByte(float viewDepth) {
      return (1.0 + 254.0 * clamp((viewDepth - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0)) / 255.0;
    }`;

  /**
   * Regions: which painted layer covers a fragment, read from the bone's baked map (kit/region.js `bake`). The
   * map's u is the angle around the bone's long axis (atan of the point's side and front components, a full
   * turn mapped to 0..1, wrapping), its v is s, the point's share of the way along the bone (its projection on
   * the bone's end, clamped). A texel holds bytes: [ramp slot | 255, line-class slot | 255, shell index, flags].
   *
   * regionAt smooths the map's staircase: it reads the four texels round the point and returns the one whose
   * kind holds the most bilinear weight (texels of equal kind pool theirs). Along a boundary that is the
   * contour "bilinear weight of one side = 1/2", a smooth curve, where a nearest read would give texel steps.
   */
  const GLSL_REGIONS = `
    #ifdef LOOK_REGIONS
      uniform sampler2D uRegionMap;
      uniform vec2 uRegionSize;    // texels: around, along
      uniform vec3 uRegionAlong;   // the bone's end over its squared length: s = dot(point, this)
      uniform vec3 uRegionFront;   // unit axis the angle is measured from
      uniform vec3 uRegionSide;    // unit axis it grows towards
      uniform float uBlockRow;     // the atlas row of the figure's ramp slot 0
      uniform float uShell;        // 0: the bone's own surface; k: the shell that shows only texels raised to shell k
      vec2 regionUv(vec3 point) {
        return vec2(atan(dot(point, uRegionSide), dot(point, uRegionFront)) / 6.2831853 + 0.5, clamp(dot(point, uRegionAlong), 0.0, 1.0));
      }
      vec4 regionTap(vec2 cell) {
        vec2 uv = vec2(fract((cell.x + 0.5) / uRegionSize.x), (clamp(cell.y, 0.0, uRegionSize.y - 1.0) + 0.5) / uRegionSize.y);
        return floor(texture2D(uRegionMap, uv) * 255.0 + 0.5);
      }
      float sameKind(vec4 first, vec4 second) {
        return step(abs(first.r - second.r) + abs(first.g - second.g) + abs(first.b - second.b), 0.5);
      }
      vec4 regionAt(vec2 uv) {
        vec2 texel = uv * uRegionSize - 0.5;
        vec2 cell = floor(texel);
        vec2 share = texel - cell;
        vec4 lowNear = regionTap(cell);
        vec4 lowFar = regionTap(cell + vec2(1.0, 0.0));
        vec4 highNear = regionTap(cell + vec2(0.0, 1.0));
        vec4 highFar = regionTap(cell + vec2(1.0, 1.0));
        vec4 weight = vec4((1.0 - share.x) * (1.0 - share.y), share.x * (1.0 - share.y), (1.0 - share.x) * share.y, share.x * share.y);
        float most = dot(weight, vec4(1.0, sameKind(lowNear, lowFar), sameKind(lowNear, highNear), sameKind(lowNear, highFar)));
        vec4 best = lowNear;
        float pooled = dot(weight, vec4(sameKind(lowFar, lowNear), 1.0, sameKind(lowFar, highNear), sameKind(lowFar, highFar)));
        if (pooled > most) { most = pooled; best = lowFar; }
        pooled = dot(weight, vec4(sameKind(highNear, lowNear), sameKind(highNear, lowFar), 1.0, sameKind(highNear, highFar)));
        if (pooled > most) { most = pooled; best = highNear; }
        pooled = dot(weight, vec4(sameKind(highFar, lowNear), sameKind(highFar, lowFar), sameKind(highFar, highNear), 1.0));
        if (pooled > most) { best = highFar; }
        return best;
      }
    #endif`;

  /**
   * A line along region boundaries on the direct path (the indexed path draws it in look-ink.js). The fragment
   * looks one line width away in four screen directions; where a neighbour's line class is higher than its own
   * it becomes ink, in that neighbour's ramp, so the line lies on the lower class (skin beside a sleeve) and
   * the garment keeps its size. The offsets are the screen-space gradient of the map coordinates, built from s
   * and the two components the angle is made of (d angle = (front d side - side d front) / (front^2 + side^2))
   * rather than from the angle itself, which jumps a full turn at the back seam.
   * Returns the ramp row of the line, or -1 when the fragment is not on one.
   */
  const GLSL_REGION_LINE = `
    #if defined(LOOK_REGIONS) && defined(LOOK_REGION_INK) && !defined(LOOK_STAMP)
      float regionLineFrom(vec2 uv, float ownClass) {
        vec4 other = regionAt(uv);
        float otherClass = other.g < 254.5 ? other.g : uInkClass;
        if (otherClass < ownClass + 0.5) return -1.0;
        return other.r < 254.5 ? uBlockRow + other.r : uRamp;
      }
      float regionLine(vec2 uv, float ownClass) {
        float front = dot(vLocalPosition, uRegionFront);
        float side = dot(vLocalPosition, uRegionSide);
        float along = dot(vLocalPosition, uRegionAlong);
        float turn = max(front * front + side * side, 1e-8) * 6.2831853;
        vec2 across = vec2((front * dFdx(side) - side * dFdx(front)) / turn, dFdx(along)) * uInkWidth;
        vec2 up = vec2((front * dFdy(side) - side * dFdy(front)) / turn, dFdy(along)) * uInkWidth;
        across *= min(1.0, ${REGION_LINE_MOST_REACH} / max(length(across), 1e-6));
        up *= min(1.0, ${REGION_LINE_MOST_REACH} / max(length(up), 1e-6));
        float row = regionLineFrom(uv + across, ownClass);
        row = max(row, regionLineFrom(uv - across, ownClass));
        row = max(row, regionLineFrom(uv + up, ownClass));
        return max(row, regionLineFrom(uv - up, ownClass));
      }
    #endif`;

  const TOON_VERTEX = `
    #include <skinning_pars_vertex>
    #ifdef LOOK_INSTANCE_RAMP
      attribute float instanceRamp;
    #endif
    #ifdef LOOK_STAMP
      // A stamp vertex carries its layer's paint (ramp slot, tone 0..1, size rule in texels, order) and its
      // layer's centre with the layer's smaller half extent. A positive size rule is a least size: a layer whose
      // smaller side would cover fewer target texels is grown about its centre until it does (a glint survives a
      // 100-texel-tall sprite). A negative one drops the layer below that size (it collapses to its centre):
      // the white of an eye three texels wide is noise, and the iris alone reads better.
      attribute vec4 stampPaint;
      attribute vec4 stampCentre;
      uniform float uTexelWorld;   // world size of one target texel; 0 when unknown (a perspective camera)
      varying vec3 vStampPaint;
      float stampGrowth() {
        float texels = 2.0 * stampCentre.w / max(uTexelWorld, 1e-9);   // the smaller side, in target texels
        if (stampPaint.z < 0.0) return uTexelWorld > 0.0 && texels < -stampPaint.z ? 0.0 : 1.0;
        return clamp(stampPaint.z / max(texels, 1e-5), 1.0, ${STAMP_MOST_GROWTH.toFixed(1)});
      }
    #endif
    varying vec3 vViewNormal;
    varying vec3 vLocalPosition;
    varying float vViewDepth;
    varying float vRampOffset;
    void main() {
      ${GLSL_TRANSFORM}
      vViewNormal = normalize(transformedNormal);
      vLocalPosition = position;
      vViewDepth = -mvPosition.z;
      vRampOffset = 0.0;
      #ifdef LOOK_INSTANCE_RAMP
        vRampOffset = instanceRamp;
      #endif
      #ifdef LOOK_STAMP
        vStampPaint = stampPaint.xyz;
      #endif
    }`;

  const TOON_FRAGMENT = `
    uniform sampler2D uPalette;
    uniform float uPaletteRows;
    uniform float uEdges[${MAX_EDGES}];
    uniform float uToneCount;
    uniform float uDither;
    uniform float uDitherCells;
    uniform float uSoftness;
    uniform vec3 uLight;
    uniform vec3 uRim;       // x: largest view-space normal z that still counts as an edge, y: least light, z: 1 when on
    uniform float uGlintEdge;
    uniform vec2 uDepthRange;
    uniform vec2 uAnchor;
    uniform float uRamp;
    uniform float uInkGroup;
    uniform vec3 uPart;      // x: 1 when shiny, y: 1 when emissive, z: fixed tone 0..1 of the ramp, or -1 when shaded
    uniform float uInkClass; // the part's line class: ink is drawn where a higher class meets a lower one on one surface
    uniform float uInkWidth;
    #ifdef LOOK_STAMP
      varying vec3 vStampPaint;
    #endif
    varying vec3 vViewNormal;
    varying vec3 vLocalPosition;
    varying float vViewDepth;
    varying float vRampOffset;
    ${GLSL_BAYER}
    ${GLSL_DITHER_CELL}
    ${GLSL_BANDS}
    ${GLSL_PALETTE}
    ${GLSL_DEPTH_BYTE}
    ${GLSL_REGIONS}
    ${GLSL_REGION_LINE}
    void main() {
      float row = uRamp + vRampOffset;
      float inkClass = uInkClass;
      float lineRow = -1.0;
      #ifdef LOOK_REGIONS
        vec2 regionPoint = regionUv(vLocalPosition);
        vec4 region = regionAt(regionPoint);
        #ifdef LOOK_STAMP
          // A stamp shows only on bare surface: where hair or a band is painted over the skin, it is hidden.
          if (mod(region.a, 2.0) > 0.5) discard;
        #else
          if (uShell > 0.5 && abs(region.b - uShell) > 0.5) discard;
          if (region.r < 254.5) row = uBlockRow + region.r;
          if (region.g < 254.5) inkClass = region.g;
          #ifdef LOOK_REGION_INK
            lineRow = regionLine(regionPoint, inkClass);
          #endif
        #endif
      #endif
      vec3 normal = normalize(vViewNormal);
      float lightest = uToneCount - 1.0;
      // Dither moves the light value, never the colour: thresholds 0..15/16 are centred on zero (their mean is 15/32).
      float light = dot(normal, uLight) + (bayer4(ditherCell()) - 0.46875) * uDither;
      #ifdef LOOK_SOFT
        float tone = softBandOf(light);
      #else
        float tone = bandOf(light);
      #endif
      // Rim: a lit surface seen edge-on steps up one tone, which draws a light line along the lit silhouette.
      if (uRim.z > 0.5 && normal.z < uRim.x && light > uRim.y) tone = min(tone + 1.0, lightest);
      // Glint: where the normal bisects the light and the viewer (the viewer is +z in view space), a shiny part takes the lightest tone.
      if (uPart.x > 0.5 && dot(normal, normalize(uLight + vec3(0.0, 0.0, 1.0))) > uGlintEdge) tone = lightest;
      if (uPart.y > 0.5) tone = lightest;
      if (uPart.z >= 0.0) tone = floor(uPart.z * lightest + 0.5);
      #ifdef LOOK_STAMP
        row = uBlockRow + vStampPaint.x;
        tone = floor(vStampPaint.y * lightest + 0.5);
      #endif
      if (lineRow >= 0.0) {
        row = lineRow;
        tone = ${INK_COLUMN}.0;
      }
      #ifdef LOOK_INDEX_OUTPUT
        // (ramp, tone + line class, ink group, depth) as four bytes; colour is resolved later, by look-ink.js.
        gl_FragColor = vec4(row / 255.0, (floor(tone + 0.5) + ${CLASS_STEP}.0 * inkClass) / 255.0, uInkGroup / 255.0, depthByte(vViewDepth));
      #else
        #ifdef LOOK_SOFT
          vec3 color = mix(paletteColor(floor(tone), row), paletteColor(min(floor(tone) + 1.0, lightest), row), fract(tone));
        #else
          vec3 color = paletteColor(tone, row);
        #endif
        gl_FragColor = vec4(toOutput(color), 1.0);
      #endif
    }`;

  /**
   * Inverted hull: the mesh's back faces, pushed outward so they show as a rim round the front faces. The push
   * is made in clip space, along the projected normal, by a fixed number of pixels: scaling by uViewport turns
   * the direction into pixel units (so the line is as wide vertically as horizontally) and multiplying by w
   * cancels the perspective divide (so the line is as wide far away as near).
   */
  const HULL_VERTEX = `
    #include <skinning_pars_vertex>
    #ifdef LOOK_INK_NORMAL
      attribute vec3 inkNormal;
    #endif
    uniform vec2 uViewport;
    uniform float uInkWidth;
    varying float vViewDepth;
    varying vec3 vLocalPosition;
    void main() {
      vLocalPosition = position;
      ${GLSL_TRANSFORM}
      // three.js flips the normal of a back-side material; the push must follow the surface's true outward normal.
      #ifdef FLIP_SIDED
        transformedNormal = -transformedNormal;
      #endif
      vec2 direction = (projectionMatrix * vec4(transformedNormal, 0.0)).xy * uViewport;
      direction /= max(length(direction), 0.0001);
      gl_Position.xy += direction * (2.0 * uInkWidth / uViewport) * gl_Position.w;
      vViewDepth = -mvPosition.z;
    }`;

  const HULL_FRAGMENT = `
    uniform sampler2D uPalette;
    uniform float uPaletteRows;
    uniform vec2 uDepthRange;
    uniform float uRamp;
    uniform float uInkGroup;
    uniform float uInkClass;
    varying float vViewDepth;
    varying vec3 vLocalPosition;
    ${GLSL_PALETTE}
    ${GLSL_DEPTH_BYTE}
    ${GLSL_REGIONS}
    void main() {
      float row = uRamp;
      float inkClass = uInkClass;
      #ifdef LOOK_REGIONS
        // The outline takes the ink of whatever is painted there, and a shell is outlined only where it shows.
        vec4 region = regionAt(regionUv(vLocalPosition));
        if (uShell > 0.5 && abs(region.b - uShell) > 0.5) discard;
        if (region.r < 254.5) row = uBlockRow + region.r;
        if (region.g < 254.5) inkClass = region.g;
      #endif
      #ifdef LOOK_INDEX_OUTPUT
        gl_FragColor = vec4(row / 255.0, (${INK_COLUMN}.0 + ${CLASS_STEP}.0 * inkClass) / 255.0, uInkGroup / 255.0, depthByte(vViewDepth));
      #else
        gl_FragColor = vec4(toOutput(paletteColor(${INK_COLUMN}.0, row)), 1.0);
      #endif
    }`;

  // ---- palette texture -------------------------------------------------------------------------------------------------

  /**
   * Wraps a palette atlas in a texture. Nearest filtering and no colour conversion, so a lookup returns the
   * authored bytes; `sync` uploads again only when the atlas has been written since the last upload.
   * @param {ReturnType<typeof Kit.palette.atlas>} atlas
   * @returns {{texture: THREE.Texture, sync: function(): void}}
   * @complexity sync: O(1) when nothing changed, otherwise one upload of the whole table (8 x rows texels)
   */
  const paletteTexture = (atlas) => {
    const texture = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    let uploadedVersion = -1;
    const sync = () => {
      if (uploadedVersion === atlas.version) return;
      uploadedVersion = atlas.version;
      texture.needsUpdate = true;
    };
    sync();
    return { texture, sync };
  };

  // ---- shading ---------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} LookPart
   * What a mesh is, to the look. Nothing here is a colour.
   * @property {number} ramp row of the palette atlas (`block.rows.skin`)
   * @property {number} [inkGroup=1] 1..255. Screen-space ink draws a line where two groups meet; 0 means the
   *   part is never outlined and never drawn over by ink (eyes, glows)
   * @property {boolean} [shiny] takes the lightest tone where it mirrors the light (hair, metal, gems)
   * @property {boolean} [emissive] always the lightest tone; its ink group defaults to 0
   * @property {number} [tone] a fixed tone, 0 (darkest) .. 1 (lightest) of the ramp, instead of shading
   * @property {{value: THREE.Vector2}} [anchor] from `shading.follow(root)`: the figure this part's dither moves with
   * @property {boolean} [instanceRamp] an InstancedMesh whose geometry has a float `instanceRamp` attribute: a row offset per instance
   * @property {number} [inkClass=0] 0..15. Where two classes meet on one surface (a sleeve and the skin below
   *   it), a line is drawn on the lower one, even inside one ink group. Parts that all keep the default never get one
   * @property {LookRegions} [regions] the mesh is painted from a baked region map instead of one ramp
   * @property {number} [blockRow] with `regions` or `stamps`: the atlas row of the figure's ramp slot 0 (slots are rows from there)
   * @property {number} [shell] with `regions`: 0 (default) draws the whole mesh; k draws only the texels raised to shell k
   * @property {boolean} [stamps] the geometry has `stampPaint` and `stampCentre` attributes (kit/figure-shapes.js
   *   `stamps`): each vertex names its slot and tone, and it is never outlined
   * @property {boolean} [outlined=true] false: no hull outline of its own, though it keeps its ink group
   */

  /**
   * @typedef {Object} LookRegions
   * @property {THREE.Texture} texture a `RegionMap` (kit/region.js) as RGBA bytes, nearest-filtered, wrapping around
   * @property {number} width texels around
   * @property {number} height texels along
   * @property {number[]} end [x, y, z] the far end of the mesh's long axis in its own space (s is 1 there)
   * @property {number} front the axis (0 = x, 1 = y, 2 = z) the around-angle is measured from
   * @property {number} side the axis it grows towards
   */

  /**
   * @typedef {Object} DressedMesh
   * @property {THREE.Mesh} mesh
   * @property {THREE.Material} toon
   * @property {THREE.Material} hull
   * @property {function(number): void} setRamp point both materials at another atlas row (O(1))
   */

  /**
   * @typedef {Object} LookFrame
   * What `apply` must know about the target being drawn into.
   * @property {number} width target width, device pixels (or texels)
   * @property {number} height target height
   * @property {number} lineWidth hull line width in pixels of that target
   * @property {number[]} [depthRange] [near, far] view depths packed into the index target's alpha
   */

  /**
   * Creates the shared state of one look: the palette texture and the uniforms every dressed material reads.
   * Changing a knob writes a uniform once, whatever the number of meshes; only a change of output kind (index
   * or colour, soft or hard, dither space) recompiles, and all materials of a kind share one program.
   * @param {{atlas: ReturnType<typeof Kit.palette.atlas>, output?: 'display'|'linear'}} options `output: 'linear'`
   *   is for meshes drawn inside the kit's HDR chain (kit/post.js), where colours are tone mapped afterwards
   *   and so only approximate the palette; 'display' (default) writes the palette's own bytes
   * @returns {Object} `{ uniforms, palette, dress, undress, follow, anchors, apply, setLight, dressed, dispose }`
   * @example
   * const shading = Kit.look.shading({ atlas });
   * shading.dress(headMesh, { ramp: hero.rows.skin });
   * shading.dress(eyeMesh, { ramp: hero.rows.eye, tone: 0, inkGroup: 0 });
   * shading.apply(Kit.look.settings('toon'), { width: 780, height: 1560, lineWidth: 5 });
   */
  const shading = ({ atlas, output = 'display' }) => {
    const palette = paletteTexture(atlas);
    const uniforms = {
      uPalette: { value: palette.texture },
      uPaletteRows: { value: atlas.height },
      uEdges: { value: Kit.look.edgesFor(atlas.toneCount) },
      uToneCount: { value: atlas.toneCount },
      uDither: { value: 0 },
      uDitherCells: { value: DITHER_CELLS_PER_UNIT },
      uSoftness: { value: 0 },
      uLight: { value: new THREE.Vector3(...KEY_LIGHT).normalize() },
      uRim: { value: new THREE.Vector3(RIM.maxFacing, RIM.minLight, 0) },
      uGlintEdge: { value: GLINT_EDGE },
      uDepthRange: { value: new THREE.Vector2(0, 1) },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uInkWidth: { value: 1 },
      uTexelWorld: { value: 0 },
    };
    const noAnchor = { value: new THREE.Vector2(0, 0) };
    /** @type {DressedMesh[]} */
    const dressed = [];
    const anchors = [];
    let defineKey = '';

    const baseDefines = () => (output === 'linear' ? { LOOK_LINEAR_OUTPUT: '' } : {});
    const partUniforms = (part) => ({
      ...uniforms,
      uAnchor: part.anchor || noAnchor,
      uRamp: { value: part.ramp },
      uInkGroup: { value: part.inkGroup === undefined ? (part.emissive ? 0 : 1) : part.inkGroup },
      uPart: { value: new THREE.Vector3(part.shiny ? 1 : 0, part.emissive ? 1 : 0, part.tone === undefined ? -1 : part.tone) },
      uInkClass: { value: part.inkClass || 0 },
      ...(part.regions || part.stamps ? { uBlockRow: { value: part.blockRow || 0 } } : {}),
      ...(part.regions ? regionUniforms(part.regions, part.shell || 0) : {}),
    });
    const axisVector = (axis) => new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const regionUniforms = (regions, shell) => {
      const end = new THREE.Vector3(...regions.end);
      return {
        uRegionMap: { value: regions.texture },
        uRegionSize: { value: new THREE.Vector2(regions.width, regions.height) },
        // A bone with no length has s = 0 everywhere, as Kit.surface.along has it.
        uRegionAlong: { value: end.lengthSq() > 0 ? end.clone().divideScalar(end.lengthSq()) : end },
        uRegionFront: { value: axisVector(regions.front) },
        uRegionSide: { value: axisVector(regions.side) },
        uShell: { value: shell },
      };
    };
    const partDefines = (part) => ({ ...(part.regions ? { LOOK_REGIONS: '' } : {}), ...(part.stamps ? { LOOK_STAMP: '' } : {}) });

    /** Makes the geometry draw twice, once per material slot (toon, hull), and gives it welded normals for the hull. */
    const prepareGeometry = (mesh) => {
      const { geometry } = mesh;
      if (geometry.userData.lookReady) return;
      if (Array.isArray(mesh.material))
        throw new Error('Kit.look.shading.dress: the mesh has several materials. Dress single-material meshes; split a multi-material mesh into one mesh per material first.');
      // Boxes and cylinders come with a group per face; under one material those mean nothing, so they give way.
      geometry.clearGroups();
      geometry.addGroup(0, Infinity, 0);
      geometry.addGroup(0, Infinity, 1);
      const { position, normal } = geometry.attributes;
      if (!normal) throw new Error('Kit.look.shading.dress: the geometry has no normals; call geometry.computeVertexNormals() first.');
      geometry.setAttribute('inkNormal', new THREE.BufferAttribute(Kit.look.weldNormals(position.array, normal.array), 3));
      geometry.userData.lookReady = true;
    };

    const look = {
      uniforms,
      palette,
      dressed,
      /**
       * Puts a mesh in the look: replaces its material with a toon material and a hull material that both
       * point at the part's ramp. Works on Mesh, SkinnedMesh and InstancedMesh.
       * @param {THREE.Mesh} mesh
       * @param {LookPart} part
       * @returns {DressedMesh}
       * @complexity O(vertices) the first time a geometry is dressed (welded normals), O(1) after
       */
      dress(mesh, part) {
        if (!part || !Number.isFinite(part.ramp)) throw new Error('Kit.look.shading.dress: part.ramp must be a row of the palette atlas, e.g. { ramp: block.rows.skin }.');
        prepareGeometry(mesh);
        const partValues = partUniforms(part);
        const toon = new THREE.ShaderMaterial({
          uniforms: partValues,
          vertexShader: TOON_VERTEX,
          fragmentShader: TOON_FRAGMENT,
          defines: { ...baseDefines(), ...partDefines(part), ...(part.instanceRamp ? { LOOK_INSTANCE_RAMP: '' } : {}) },
        });
        // The region line measures the map's gradient on screen; WebGL1 needs the derivatives extension for that.
        if (part.regions) toon.extensions = { derivatives: true };
        const hull = new THREE.ShaderMaterial({
          uniforms: partValues,
          vertexShader: HULL_VERTEX,
          fragmentShader: HULL_FRAGMENT,
          side: THREE.BackSide,
          defines: { ...baseDefines(), ...(part.regions && !part.stamps ? { LOOK_REGIONS: '' } : {}), LOOK_INK_NORMAL: '' },
        });
        // An unoutlined part (group 0, stamps, or one that asked for none) keeps its hull material but never shows it.
        hull.userData.isInked = partValues.uInkGroup.value > 0 && !part.stamps && part.outlined !== false;
        hull.visible = false;
        mesh.material = [toon, hull];
        const entry = { mesh, toon, hull, setRamp: (row) => (partValues.uRamp.value = row) };
        dressed.push(entry);
        defineKey = '';
        return entry;
      },
      /**
       * Takes a mesh out of the look and frees its two materials (the mesh keeps its geometry).
       * @param {DressedMesh} entry what `dress` returned
       * @complexity O(dressed meshes)
       */
      undress(entry) {
        dressed.splice(dressed.indexOf(entry), 1);
        [entry.toon, entry.hull].forEach((material) => material.dispose());
      },
      /**
       * Makes a dither anchor that follows a figure: pass it as `part.anchor` to each of the figure's parts.
       * The view moves it to the figure's snapped screen position each frame, so with `ditherSpace: 'anchored'`
       * the pattern travels with the figure instead of sliding over it.
       * @param {THREE.Object3D} root the figure's root
       * @returns {{value: THREE.Vector2, root: THREE.Object3D}}
       */
      follow(root) {
        const anchor = { value: new THREE.Vector2(0, 0), root };
        anchors.push(anchor);
        return anchor;
      },
      anchors,
      /**
       * Applies settings to every dressed mesh.
       * @param {ReturnType<typeof Kit.look.settings>} settings
       * @param {LookFrame} frame
       * @complexity O(1) for knob changes; O(dressed meshes) when the output kind or the hull visibility changes
       */
      apply(settings, frame) {
        palette.sync();
        uniforms.uEdges.value = Kit.look.edgesFor(settings.toneCount);
        uniforms.uToneCount.value = settings.toneCount;
        uniforms.uDither.value = settings.dither;
        uniforms.uSoftness.value = settings.softness;
        uniforms.uRim.value.z = settings.rim ? 1 : 0;
        uniforms.uViewport.value.set(frame.width, frame.height);
        uniforms.uInkWidth.value = frame.lineWidth;
        if (frame.depthRange) uniforms.uDepthRange.value.set(frame.depthRange[0], frame.depthRange[1]);
        const isSoft = settings.softness > 0 && !settings.isIndexed;
        const key = [settings.isIndexed, isSoft, settings.ditherSpace === 'object', settings.outline].join();
        if (key === defineKey) return;
        defineKey = key;
        const switches = {
          LOOK_INDEX_OUTPUT: settings.isIndexed,
          LOOK_SOFT: isSoft,
          LOOK_DITHER_OBJECT: settings.ditherSpace === 'object',
          // On the direct path a region-painted mesh draws its own boundary lines; the indexed path's resolve pass does.
          LOOK_REGION_INK: !settings.isIndexed && settings.outline !== 'none',
        };
        dressed.forEach(({ toon, hull }) => {
          [toon, hull].forEach((material) => {
            Object.keys(switches).forEach((name) => (switches[name] ? (material.defines[name] = '') : delete material.defines[name]));
            material.needsUpdate = true;
          });
          hull.visible = settings.outline === 'hull' && hull.userData.isInked;
        });
      },
      /**
       * Points the key light. The direction is in view space, so the light keeps its place on screen as the
       * camera or the figure turns (the pixel-art convention: lit from the upper left).
       * @param {number} x right
       * @param {number} y up
       * @param {number} z toward the viewer
       */
      setLight: (x, y, z) => void uniforms.uLight.value.set(x, y, z).normalize(),
      /** Frees the palette texture and every material this look made. Geometries belong to their meshes. */
      dispose() {
        palette.texture.dispose();
        dressed.forEach(({ toon, hull }) => [toon, hull].forEach((material) => material.dispose()));
        dressed.length = 0;
      },
    };
    return look;
  };

  Object.assign(Kit.look, { shading, paletteTexture, CLASS_STEP, GLSL: { GLSL_TRANSFORM, GLSL_BAYER, GLSL_DITHER_CELL, GLSL_BANDS, GLSL_PALETTE, GLSL_DEPTH_BYTE, GLSL_REGIONS, GLSL_REGION_LINE } });
})();
