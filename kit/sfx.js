/**
 * Kit sfx: a tiny WebAudio synth. No audio assets.
 *
 * Owns:  the shared AudioContext (created lazily, unlocked on the first touch or key press, as
 *        browsers require), two voices (`tone`, `noise`), the table of named sound presets,
 *        the persisted mute switch and the haptic `buzz`.
 * Does not own: music (music.js) or deciding when a sound plays (games call `Kit.sfx.play`).
 *
 * A singleton rather than a per-game factory: `Kit.sfx` is the same object as `ctx.sfx`.
 * Needs WebAudio, so it is exercised by tools/smoke.js rather than unit tests.
 */
(() => {
  // ---- tunables ------------------------------------------------------------------------------------------------------

  /** localStorage key of the mute switch ('1' = muted). */
  const MUTE_STORAGE_KEY = 'five-loop-lab-mute';
  /** Master gain when not muted: headroom so several overlapping sounds do not clip. */
  const MASTER_VOLUME = 0.5;
  /** Exponential ramps cannot reach 0, so fades end at this inaudible level instead. */
  const SILENT_GAIN = 0.001;
  /** Lowest frequency a pitch sweep may end on, Hz (the bottom of hearing; ramps to 0 are invalid). */
  const MIN_SWEEP_HZ = 20;
  /** A voice is stopped this long after its fade ends, seconds, so the tail is never cut. */
  const RELEASE_TAIL_SECONDS = 0.02;
  /** Length of the shared white-noise buffer, seconds. */
  const NOISE_BUFFER_SECONDS = 1;
  /** Each noise burst starts at a random offset within this much of the buffer, so repeats do not sound identical. */
  const NOISE_MAX_OFFSET_SECONDS = 0.5;

  // ---- audio context -------------------------------------------------------------------------------------------------

  let audioContext = null;
  let masterGain = null;
  let noiseBuffer = null;

  const readMuted = () => {
    try {
      return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
    } catch (error) {
      // Storage is blocked: start unmuted.
      return false;
    }
  };
  let isMuted = readMuted();

  const masterVolume = () => (isMuted ? 0 : MASTER_VOLUME);

  /** Creates the AudioContext on first need. Returns null where WebAudio does not exist. */
  function ensureAudioContext() {
    if (audioContext) return audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = masterVolume();
    masterGain.connect(audioContext.destination);
    return audioContext;
  }

  /** Browsers keep a context suspended until a user gesture; resume it on the first one we see. */
  const unlockAudio = () => {
    if (ensureAudioContext() && audioContext.state === 'suspended') audioContext.resume();
  };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio);

  const isAudioRunning = () => Boolean(audioContext) && audioContext.state === 'running';

  /** A gain node that starts at `volume` at `startTime` and fades out over `duration` seconds. */
  const createFadingGain = (volume, startTime, duration) => {
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, startTime + duration);
    return gain;
  };

  /** One second of white noise, generated once and shared by every noise burst. */
  const getNoiseBuffer = () => {
    if (!noiseBuffer) {
      noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * NOISE_BUFFER_SECONDS, audioContext.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      // Index loop: filling a Float32Array of tens of thousands of samples in place.
      for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  };

  // ---- voices --------------------------------------------------------------------------------------------------------

  /**
   * @typedef {Object} ToneOptions
   * @property {number} [freq=440] starting frequency, Hz
   * @property {number} [to] frequency to sweep to over the duration, Hz (omit for a steady pitch)
   * @property {number} [dur=0.1] seconds
   * @property {'sine'|'square'|'sawtooth'|'triangle'} [type='triangle'] oscillator shape
   * @property {number} [vol=0.3] starting gain, 0..1
   * @property {number} [delay=0] seconds from now until it starts
   */

  /**
   * Plays one oscillator note that fades out. Silent until the audio context has been unlocked.
   * @param {ToneOptions} [options]
   * @example Kit.sfx.tone({ freq: 660, to: 990, dur: 0.08, type: 'square', vol: 0.15 });
   */
  function tone({ freq = 440, to, dur = 0.1, type = 'triangle', vol = 0.3, delay = 0 } = {}) {
    if (!isAudioRunning()) return;
    const startTime = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, startTime);
    if (to) oscillator.frequency.exponentialRampToValueAtTime(Math.max(MIN_SWEEP_HZ, to), startTime + dur);
    oscillator.connect(createFadingGain(vol, startTime, dur)).connect(masterGain);
    oscillator.start(startTime);
    oscillator.stop(startTime + dur + RELEASE_TAIL_SECONDS);
  }

  /**
   * @typedef {Object} NoiseOptions
   * @property {number} [dur=0.15] seconds
   * @property {number} [vol=0.3] starting gain, 0..1
   * @property {number} [freq=1200] filter frequency, Hz (low = thump, high = hiss)
   * @property {number} [q=0.7] filter resonance
   * @property {'lowpass'|'highpass'|'bandpass'} [type='lowpass'] filter type
   * @property {number} [delay=0] seconds from now until it starts
   */

  /**
   * Plays a burst of filtered white noise that fades out. Silent until the audio context has been unlocked.
   * @param {NoiseOptions} [options]
   * @example Kit.sfx.noise({ dur: 0.2, freq: 900, q: 1.5, type: 'bandpass' });
   */
  function noise({ dur = 0.15, vol = 0.3, freq = 1200, q = 0.7, type = 'lowpass', delay = 0 } = {}) {
    if (!isAudioRunning()) return;
    const startTime = audioContext.currentTime + delay;
    const source = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    source.buffer = getNoiseBuffer();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    source.connect(filter).connect(createFadingGain(vol, startTime, dur)).connect(masterGain);
    source.start(startTime, Math.random() * NOISE_MAX_OFFSET_SECONDS, dur + RELEASE_TAIL_SECONDS);
  }

  // ---- presets: every named sound is a list of voices, played together -----------------------------------------------

  /**
   * @typedef {Object} Voice
   * One layer of a preset: ToneOptions or NoiseOptions plus how to play it.
   * @property {function(Object): void} play the voice function (`tone` or `noise`)
   * @property {string[]} pitched which frequency fields are multiplied by play()'s `pitch`
   */

  /** A tone layer. Its pitch follows play()'s `pitch` (pass `pitched` to pin part of it, e.g. a fixed sweep target). */
  const toneVoice = (options, pitched = ['freq', 'to']) => ({ ...options, play: tone, pitched });
  /** A noise layer. Noise is unpitched unless `pitched` names its filter frequency. */
  const noiseVoice = (options, pitched = []) => ({ ...options, play: noise, pitched });
  /** A run of equal notes, each starting `step` seconds after the one before. */
  const arpeggio = (frequencies, step, options) => frequencies.map((freq, index) => toneVoice({ ...options, freq, delay: index * step }));

  /** @type {Object<string, Voice[]>} */
  const PRESETS = {
    click: [toneVoice({ freq: 320, dur: 0.035, type: 'square', vol: 0.12 })],
    tap: [toneVoice({ freq: 520, to: 780, dur: 0.06, vol: 0.25 })],
    hit: [noiseVoice({ dur: 0.07, vol: 0.3, freq: 2200 }), toneVoice({ freq: 190, to: 80, dur: 0.09, type: 'square', vol: 0.16 })],
    thud: [noiseVoice({ dur: 0.1, vol: 0.3, freq: 500 }), toneVoice({ freq: 110, to: 50, dur: 0.14, type: 'sine', vol: 0.4 })],
    coin: [toneVoice({ freq: 988, dur: 0.07, type: 'square', vol: 0.12 }), toneVoice({ freq: 1319, dur: 0.12, type: 'square', vol: 0.12, delay: 0.06 })],
    // The boom always bottoms out at the same sub-bass note, whatever the pitch, so only its start is pitched.
    boom: [noiseVoice({ dur: 0.4, vol: 0.5, freq: 420 }), toneVoice({ freq: 95, to: 32, dur: 0.35, type: 'sine', vol: 0.5 }, ['freq'])],
    shoot: [toneVoice({ freq: 880, to: 220, dur: 0.08, type: 'sawtooth', vol: 0.1 })],
    whoosh: [noiseVoice({ dur: 0.2, vol: 0.22, freq: 900, q: 1.5, type: 'bandpass' }, ['freq'])],
    up: arpeggio([523, 659, 784, 1047], 0.07, { dur: 0.12, vol: 0.2 }),
    perfect: arpeggio([784, 1175], 0.05, { dur: 0.16, type: 'sine', vol: 0.3 }),
    lose: [toneVoice({ freq: 392, to: 110, dur: 0.55, type: 'sawtooth', vol: 0.2 })],
    win: arpeggio([523, 659, 784, 1047, 1319], 0.09, { dur: 0.18, vol: 0.22 }),
  };

  /** Plays one voice of a preset with the caller's pitch and volume applied. */
  const playVoice = (voice, pitch, volume) => {
    const pitchedFields = voice.pitched
      .filter((field) => voice[field] !== undefined)
      .reduce((fields, field) => ({ ...fields, [field]: voice[field] * pitch }), {});
    voice.play({ ...voice, ...pitchedFields, vol: voice.vol * volume });
  };

  const MILLISECONDS_PER_SECOND = 1000;
  /** Per-preset rate limit behind play()'s `gap` option. Wall-clock time, because the ear does not slow down with the game. */
  const isClearOfLastPlay = Kit.math.rateLimiter(() => performance.now() / MILLISECONDS_PER_SECOND);

  Kit.sfx = {
    tone,
    noise,
    /** Names accepted by play(). */
    names: Object.keys(PRESETS),
    /**
     * Plays a named preset.
     * @param {string} name one of `Kit.sfx.names`; unknown names are ignored
     * @param {Object} [options]
     * @param {number} [options.pitch=1] frequency multiplier (1.06 is about a semitone up)
     * @param {number} [options.vol=1] volume multiplier
     * @param {number} [options.gap=0] seconds; skip this call if the same preset played less than `gap` ago, so a
     *   crowd of hits in one frame is one clean sound instead of a wall of noise (0 = no limit)
     * @returns {boolean} true when the sound was played
     * @example Kit.sfx.play('coin', { pitch: 1 + combo * 0.05, gap: 0.04 });
     */
    play(name, { pitch = 1, vol = 1, gap = 0 } = {}) {
      const voices = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : null;
      if (!voices || (gap > 0 && !isClearOfLastPlay(name, gap))) return false;
      voices.forEach((voice) => playVoice(voice, pitch, vol));
      return true;
    },
    /** @returns {boolean} is sound switched off? */
    get muted() {
      return isMuted;
    },
    /**
     * Switches all sound off or on, and remembers the choice.
     * @param {boolean} shouldMute
     */
    setMuted(shouldMute) {
      isMuted = shouldMute;
      if (masterGain) masterGain.gain.value = masterVolume();
      try {
        localStorage.setItem(MUTE_STORAGE_KEY, shouldMute ? '1' : '0');
      } catch (error) {
        // Storage is blocked: the choice still holds for this session.
      }
    },
  };

  /**
   * Haptic tick on devices that support it (most Android phones; a silent no-op elsewhere, including iOS Safari).
   * @param {number} milliseconds Length of the buzz; keep ticks under ~20ms and big hits under ~50ms.
   */
  Kit.sfx.buzz = (milliseconds) => {
    try {
      if (navigator.vibrate) navigator.vibrate(milliseconds);
    } catch (error) {
      // Vibration can be blocked by browser policy; feedback is optional, so carry on silently.
    }
  };
})();
