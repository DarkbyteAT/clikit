/**
 * Kit post: the post-processing chain. HDR render -> bloom -> one final pass that applies
 * exposure, vignette, ACES tone mapping and sRGB output.
 *
 * Owns:  building that chain, its per-scene tuning (`ctx.post.bloom`, `ctx.post.vignette`,
 *        `ctx.post.exposure`) and switching it off and on.
 * Does not own: when to render or resize (shell.js calls `render` and `setSize`), deciding that
 *        the device is too slow for it (the shell's quality governor calls `disable`), or what
 *        glows (anything emissive or built with `bright` above 1 in make.js / fx.js).
 *
 * Where HDR render targets or the three.js post-processing addons are missing, every method is a
 * no-op and `render` draws the scene directly, so callers never need to check.
 * Needs WebGL, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  /**
   * Per-scene defaults. Deliberately restrained: with threshold 1.0 bloom only touches true HDR
   * highlights. A game opts in to more (or to none: bloom(0)).
   * strength: bloom intensity; radius: bloom spread 0..1; threshold: linear brightness above which
   * a pixel blooms; vignette: edge darkening 0..1; exposure: brightness multiplier before tone mapping.
   */
  const DEFAULTS = { strength: 0.18, radius: 0.5, threshold: 1.0, vignette: 0.18, exposure: 1 };

  /** The composer is resized by the shell straight away; this is only a valid starting size, in pixels. */
  const PLACEHOLDER_SIZE = 4;
  /** Multisampling of the HDR target, so edges stay anti-aliased even though the canvas is not drawn to directly. */
  const MSAA_SAMPLES = 4;

  /**
   * The last pass: turns the linear HDR image into what the screen shows.
   *  - exposure scales the light;
   *  - the vignette darkens toward the corners (smoothstep over squared distance from the centre);
   *  - aces() is the Narkowicz fit of the ACES filmic curve, which rolls bright values off toward
   *    white instead of clipping them (its constants are the published fit, not tunables);
   *  - pow(1 / 2.2) encodes linear light as sRGB for display.
   */
  const FINAL_SHADER = {
    uniforms: { tDiffuse: { value: null }, exposure: { value: DEFAULTS.exposure }, vignette: { value: DEFAULTS.vignette } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float exposure; uniform float vignette; varying vec2 vUv;
      vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;
        vec2 d = vUv - 0.5;
        c *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.0);
        gl_FragColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
      }`,
  };

  /**
   * @typedef {Object} Post
   * @property {boolean} active is the chain in use? (false on the fallback and after disable())
   * @property {function(number=, number=, number=): void} bloom bloom(strength, radius, threshold): emissive and
   *   tone-map-exempt colours brighter than `threshold` glow; strength 0 turns bloom off for the scene
   * @property {function(number=): number} vignette edge darkening 0..1 (default 0.18)
   * @property {function(number=): number} exposure brightness multiplier (default 1)
   * @property {function(): void} reset back to the defaults; the shell calls this between games
   * @property {function(number, number, number): void} setSize (width, height, pixelRatio) in CSS pixels
   * @property {function(THREE.Scene, THREE.Camera): void} render draw one frame
   * @property {function(): void} disable render directly from now on (the quality governor's first step)
   * @property {function(): void} enable use the chain again
   */

  /** Can this renderer draw into floating-point (HDR) targets, and are the post-processing addons loaded? */
  const supportsHdrPipeline = (renderer) =>
    Boolean(THREE.EffectComposer && THREE.UnrealBloomPass) && renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');

  /** The fallback: same interface, no effects, plain rendering. */
  const createPassthrough = (renderer) => {
    const doNothing = () => {};
    return {
      active: false,
      bloom: doNothing,
      vignette: doNothing,
      exposure: doNothing,
      reset: doNothing,
      setSize: doNothing,
      render: (scene, camera) => renderer.render(scene, camera),
      disable: doNothing,
      enable: doNothing,
    };
  };

  /** Builds the composer and its three passes. Throws where the GPU refuses the HDR target. */
  const buildChain = (renderer) => {
    const target = new THREE.WebGLRenderTarget(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES });
    const composer = new THREE.EffectComposer(renderer, target);
    // Scene and camera are filled in on every render, because games swap cameras (ctx.ortho).
    const renderPass = new THREE.RenderPass(null, null);
    const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE), DEFAULTS.strength, DEFAULTS.radius, DEFAULTS.threshold);
    const finalPass = new THREE.ShaderPass(FINAL_SHADER);
    [renderPass, bloomPass, finalPass].forEach((pass) => composer.addPass(pass));
    return { composer, renderPass, bloomPass, finalPass };
  };

  /**
   * Creates the post-processing chain for a renderer. The shell does this once and exposes it as `ctx.post`.
   * @param {THREE.WebGLRenderer} renderer
   * @returns {Post}
   * @example
   * ctx.post.bloom(0.6, 0.4, 0.9); // a neon game opts in to visible glow
   * ctx.post.vignette(0.3);
   */
  Kit.post = (renderer) => {
    if (!supportsHdrPipeline(renderer)) return createPassthrough(renderer);
    let chain;
    try {
      chain = buildChain(renderer);
    } catch (error) {
      console.warn('post-processing unavailable', error);
      return createPassthrough(renderer);
    }
    const { composer, renderPass, bloomPass, finalPass } = chain;
    const rendererToneMapping = renderer.toneMapping;

    const post = {
      active: true,
      bloom(strength = DEFAULTS.strength, radius = DEFAULTS.radius, threshold = DEFAULTS.threshold) {
        Object.assign(bloomPass, { strength, radius, threshold });
        // Skipping the pass entirely at strength 0 saves its blur passes, not just their visible effect.
        bloomPass.enabled = strength > 0;
      },
      vignette: (amount = DEFAULTS.vignette) => (finalPass.uniforms.vignette.value = amount),
      exposure: (amount = DEFAULTS.exposure) => (finalPass.uniforms.exposure.value = amount),
      reset() {
        post.bloom();
        post.vignette();
        post.exposure();
      },
      setSize(width, height, pixelRatio) {
        composer.setPixelRatio(pixelRatio);
        composer.setSize(width, height);
      },
      render(scene, camera) {
        if (!post.active) {
          renderer.render(scene, camera);
          return;
        }
        renderPass.scene = scene;
        renderPass.camera = camera;
        // The scene must reach the bloom pass in linear HDR; the final pass tone maps once, after
        // bloom. The renderer's own setting is put back for the direct-render path.
        renderer.toneMapping = THREE.NoToneMapping;
        composer.render();
        renderer.toneMapping = rendererToneMapping;
      },
      disable() {
        post.active = false;
      },
      enable() {
        post.active = true;
      },
    };
    return post;
  };
})();
