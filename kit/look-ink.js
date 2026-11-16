/**
 * Kit look ink: the indexed pipeline. A scene of dressed meshes is drawn as (ramp, tone, ink group, depth)
 * into a small target, a second pass turns that into colour and adds one-texel ink lines, and a last pass
 * copies the result to the screen with whole-number scaling.
 *
 * Owns:  `Kit.look.inkPass`: the two render targets and their sizes, the resolve shader (palette lookup plus
 *        silhouette and inner ink) and the upscale shader.
 * Does not own: what writes the index target (the materials in look-toon.js, with LOOK_INDEX_OUTPUT), the
 *        settings (look-palette.js), or the frame around it: clearing, cameras, snapping (look-view.js).
 *
 * Why one RGBA8 target and no depth texture or MRT: ramp, tone and ink group are a byte each, and the view
 * depth fits the fourth byte because its range is fitted round the figures. So the pipeline needs nothing
 * beyond WebGL1, one colour attachment and five texture reads per texel. What it gives up: normal-based
 * crease lines (there is no normal target), and anti-aliasing (indices cannot be averaged).
 * Needs THREE and WebGL, so it is exercised in the browser (Kit.play('look')) rather than by unit tests.
 */
(() => {
  // ---- tunables --------------------------------------------------------------------------------------------------------

  /** Ink is drawn on the farther of two surfaces when the nearer one is in front by more than this, world units. */
  const INK_DEPTH_STEP = { betweenGroups: 0.035, withinGroup: 0.22 };
  /** A valid size for the targets before the first resize, texels. */
  const PLACEHOLDER_SIZE = 4;
  const { TONE_SLOTS, INK_COLUMN } = Kit.look;

  const QUAD_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  /**
   * Index texel to colour, with ink. A texel of the index target is (ramp, tone, ink group, depth byte); a
   * depth byte of 0 is empty space. For each of the four neighbours:
   *  - an empty texel beside an inked surface becomes ink: the silhouette line, one texel, outside the shape;
   *  - a surface texel becomes ink when the neighbour is nearer by more than the depth step for its case (a
   *    small step between different ink groups, a large one inside a group, where only a real overlap such as
   *    an arm across the chest should draw a line). The line lands on the farther surface, so the nearer
   *    shape keeps its full outline.
   * Group 0 never gives or takes ink. When several neighbours qualify the nearest one wins, and the line takes
   * that neighbour's ramp: ink colour comes from the ink column of the shape the line belongs to.
   */
  const RESOLVE_FRAGMENT = `
    uniform sampler2D uIndex;
    uniform sampler2D uPalette;
    uniform float uPaletteRows;
    uniform vec2 uTexel;        // one texel of the index target, in uv
    uniform vec2 uDepthSteps;   // x: between groups, y: within a group; in depth-byte units (0..1)
    uniform float uInk;         // 1 when screen-space ink is on
    varying vec2 vUv;
    vec3 paletteColor(float column, float row) {
      return texture2D(uPalette, vec2((column + 0.5) / ${TONE_SLOTS}.0, (row + 0.5) / uPaletteRows)).rgb;
    }
    // x: the neighbour's ramp byte when it inks this texel, else -1; y: its depth, for choosing the nearest.
    vec2 inkFrom(vec4 own, vec2 offset) {
      vec4 other = texture2D(uIndex, vUv + offset * uTexel);
      bool otherInks = other.a > 0.0 && other.b > 0.0;
      bool sameGroup = abs(other.b - own.b) < 0.002;
      float lead = own.a - other.a;
      bool overEmpty = own.a == 0.0;
      bool overSurface = own.a > 0.0 && own.b > 0.0 && lead > (sameGroup ? uDepthSteps.y : uDepthSteps.x);
      return otherInks && (overEmpty || overSurface) ? vec2(other.r, other.a) : vec2(-1.0, 2.0);
    }
    void main() {
      vec4 own = texture2D(uIndex, vUv);
      vec2 ink = vec2(-1.0, 2.0);
      if (uInk > 0.5) {
        vec2 candidate = inkFrom(own, vec2(1.0, 0.0));
        if (candidate.y < ink.y) ink = candidate;
        candidate = inkFrom(own, vec2(-1.0, 0.0));
        if (candidate.y < ink.y) ink = candidate;
        candidate = inkFrom(own, vec2(0.0, 1.0));
        if (candidate.y < ink.y) ink = candidate;
        candidate = inkFrom(own, vec2(0.0, -1.0));
        if (candidate.y < ink.y) ink = candidate;
      }
      if (ink.x >= 0.0) gl_FragColor = vec4(paletteColor(${INK_COLUMN}.0, floor(ink.x * 255.0 + 0.5)), 1.0);
      else if (own.a == 0.0) gl_FragColor = vec4(0.0);
      else gl_FragColor = vec4(paletteColor(floor(own.g * 255.0 + 0.5), floor(own.r * 255.0 + 0.5)), 1.0);
    }`;

  /**
   * Nearest-neighbour upscale by a whole number: screen pixel -> texel is an integer division, so every texel
   * covers exactly uScale x uScale pixels. Empty texels are discarded and whatever is behind shows through.
   */
  const UPSCALE_FRAGMENT = `
    uniform sampler2D uColor;
    uniform vec2 uTexel;
    uniform float uScale;
    void main() {
      vec4 color = texture2D(uColor, (floor(gl_FragCoord.xy / uScale) + 0.5) * uTexel);
      if (color.a < 0.5) discard;
      gl_FragColor = vec4(color.rgb, 1.0);
    }`;

  const nearestTarget = (hasDepth) =>
    new THREE.WebGLRenderTarget(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: hasDepth,
      stencilBuffer: false,
      generateMipmaps: false,
    });

  /**
   * @typedef {Object} InkPass
   * @property {function(number, number, number): void} resize (bufferWidth, bufferHeight, scale): size the targets for a
   *   screen buffer in device pixels drawn at `scale` pixels per texel
   * @property {function(THREE.WebGLRenderer, THREE.Scene, THREE.Camera, Object): void} draw index pass, resolve pass, then
   *   the upscale onto whatever target is current. Leaves the renderer's clear colour at transparent black
   * @property {function(): {width: number, height: number, scale: number}} size the targets' size in texels and the scale
   * @property {function(THREE.WebGLRenderer): Uint8Array} readTexels the resolved colour target as RGBA bytes, bottom row first
   * @property {function(): void} dispose
   */

  /**
   * Creates the indexed pipeline for one look.
   * @param {{uniforms: Object}} shading from `Kit.look.shading`: the pass reads its palette and depth range
   * @returns {InkPass}
   * @complexity draw: three render calls; the resolve costs five texture reads per texel of the small target,
   *   the upscale one read per screen pixel. Memory: two RGBA8 targets of (buffer / scale) texels, one with a depth buffer
   * @example
   * const ink = Kit.look.inkPass(shading);
   * ink.resize(780, 1560, 8);                       // a 98 x 195 texel sprite canvas on a 2x phone
   * ink.draw(renderer, lookScene, camera, settings);
   */
  const inkPass = (shading) => {
    const indexTarget = nearestTarget(true);
    const colorTarget = nearestTarget(false);
    const resolve = new THREE.ShaderMaterial({
      uniforms: {
        uIndex: { value: indexTarget.texture },
        uPalette: shading.uniforms.uPalette,
        uPaletteRows: shading.uniforms.uPaletteRows,
        uTexel: { value: new THREE.Vector2(1, 1) },
        uDepthSteps: { value: new THREE.Vector2(0, 0) },
        uInk: { value: 1 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const upscale = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: colorTarget.texture }, uTexel: resolve.uniforms.uTexel, uScale: { value: 1 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: UPSCALE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), resolve);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCamera = new THREE.Camera();
    const size = { width: PLACEHOLDER_SIZE, height: PLACEHOLDER_SIZE, scale: 1 };

    const drawQuad = (renderer, material, target) => {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCamera);
    };

    return {
      resize(bufferWidth, bufferHeight, scale) {
        // Rounded up, so the last column and row of texels may overhang the screen edge rather than leave a gap.
        const width = Math.ceil(bufferWidth / scale);
        const height = Math.ceil(bufferHeight / scale);
        if (width === size.width && height === size.height && scale === size.scale) return;
        Object.assign(size, { width, height, scale });
        indexTarget.setSize(width, height);
        colorTarget.setSize(width, height);
        resolve.uniforms.uTexel.value.set(1 / width, 1 / height);
        upscale.uniforms.uScale.value = scale;
      },
      draw(renderer, scene, camera, settings) {
        const screenTarget = renderer.getRenderTarget();
        const hadAutoClear = renderer.autoClear;
        const [near, far] = shading.uniforms.uDepthRange.value.toArray();
        resolve.uniforms.uDepthSteps.value.set(INK_DEPTH_STEP.betweenGroups / (far - near), INK_DEPTH_STEP.withinGroup / (far - near));
        resolve.uniforms.uInk.value = settings.outline === 'ink' ? 1 : 0;
        // Alpha 0 is the "nothing here" depth byte, so both small targets are cleared to transparent black.
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(indexTarget);
        renderer.render(scene, camera);
        drawQuad(renderer, resolve, colorTarget);
        renderer.autoClear = false;
        drawQuad(renderer, upscale, screenTarget);
        renderer.autoClear = hadAutoClear;
      },
      size: () => ({ ...size }),
      readTexels(renderer) {
        const texels = new Uint8Array(size.width * size.height * 4);
        renderer.readRenderTargetPixels(colorTarget, 0, 0, size.width, size.height, texels);
        return texels;
      },
      dispose() {
        [indexTarget, colorTarget, resolve, upscale, quad.geometry].forEach((resource) => resource.dispose());
      },
    };
  };

  Object.assign(Kit.look, { inkPass, INK_DEPTH_STEP });
})();
