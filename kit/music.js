// Kit music: pitch maths for the synth. Pure: names and numbers in, frequencies out; no DOM, no WebAudio
// (unit-tested in tools/test-kit.js).
//
//   noteToMidi  - 'A4' / 'C#5' / 'Bb3' -> MIDI note number:           Kit.music.noteToMidi('A4')        // 69
//   midiToFreq  - MIDI note number -> hertz (equal temperament):      Kit.music.midiToFreq(69)          // 440
//   noteToFreq  - note name -> hertz:                                  Kit.music.noteToFreq('C4')        // 261.63
//   midiToNote  - MIDI note number -> name, for labels:                Kit.music.midiToNote(61)          // 'C#4'
//   scale       - (degree) => hertz over a root and a named scale:     Kit.music.scale('C4', 'pentatonic')(5)   // C5
//
// Owns: note names, equal-temperament tuning and scale degrees. Does not own: making sound (pass the frequency to
// Kit.sfx.tone({ freq })), rhythm or sequencing.
(() => {
  /** Semitones above C of each natural note letter. */
  const LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  /** Sharp spellings of the twelve pitch classes, indexed by semitones above C. */
  const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SEMITONES_PER_OCTAVE = 12;
  /** Concert pitch: MIDI note 69 (A4) is 440 Hz; every other note is derived from it. */
  const REFERENCE_MIDI = 69;
  const REFERENCE_HZ = 440;
  /** MIDI numbers octaves so that C4 (middle C) is 60, which puts octave -1 at note 0. */
  const MIDI_OCTAVE_OFFSET = 1;
  const NOTE_PATTERN = /^([A-Ga-g])([#b]?)(-?\d+)$/;

  /**
   * Named scales as semitone offsets from the root within one octave. Add a row to add a scale.
   * @type {Object<string, number[]>}
   */
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };

  /**
   * Convert a note name to its MIDI note number.
   * @param {string} name letter, optional '#' or 'b', then the octave: 'A4', 'C#5', 'Bb3'.
   * @returns {number} MIDI note number (C4 = 60, A4 = 69).
   */
  const noteToMidi = (name) => {
    const match = NOTE_PATTERN.exec(String(name).trim());
    if (!match) throw new Error(`Kit.music: "${name}" is not a note name like "A4", "C#5" or "Bb3"`);
    const [, letter, accidental, octave] = match;
    const accidentalShift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
    return (Number(octave) + MIDI_OCTAVE_OFFSET) * SEMITONES_PER_OCTAVE + LETTER_SEMITONES[letter.toUpperCase()] + accidentalShift;
  };

  /**
   * Frequency of a MIDI note in twelve-tone equal temperament (each semitone multiplies by 2^(1/12)).
   * @param {number} midi MIDI note number; fractions are allowed (microtones, pitch bends).
   * @returns {number} hertz.
   */
  const midiToFreq = (midi) => REFERENCE_HZ * Math.pow(2, (midi - REFERENCE_MIDI) / SEMITONES_PER_OCTAVE);

  /**
   * Frequency of a named note.
   * @param {string} name see noteToMidi.
   * @returns {number} hertz.
   */
  const noteToFreq = (name) => midiToFreq(noteToMidi(name));

  /**
   * Name of a MIDI note, spelled with sharps, for HUD labels.
   * @param {number} midi whole MIDI note number.
   * @returns {string} for example 'C#4'.
   */
  const midiToNote = (midi) => {
    // Double modulo keeps the pitch class in 0..11 for notes below C-1 (negative numbers).
    const pitchClass = ((midi % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
    return PITCH_NAMES[pitchClass] + (Math.floor(midi / SEMITONES_PER_OCTAVE) - MIDI_OCTAVE_OFFSET);
  };

  /**
   * MIDI note of a scale degree. Degrees past the end of the scale climb into higher octaves and negative
   * degrees descend, so any integer is a valid, in-key note.
   * @param {number} rootMidi MIDI note of degree 0.
   * @param {number[]} intervals semitone offsets within one octave (a SCALES row).
   * @param {number} degree whole scale step, 0 = the root.
   * @returns {number} MIDI note number.
   */
  const degreeToMidi = (rootMidi, intervals, degree) => {
    const octave = Math.floor(degree / intervals.length);
    const step = degree - octave * intervals.length;
    return rootMidi + octave * SEMITONES_PER_OCTAVE + intervals[step];
  };

  /**
   * Build a scale: a function from scale degree to frequency, with the notes it uses available for labels.
   * @param {string|number} root note name ('C4') or MIDI number of degree 0.
   * @param {string|number[]} [kind='major'] a SCALES name, or your own semitone offsets.
   * @returns {((degree: number) => number) & { midi: (degree: number) => number, noteName: (degree: number) => string }}
   *   call it for hertz; `.midi(degree)` and `.noteName(degree)` describe the same note.
   * @example
   * const chime = Kit.music.scale('C4', 'pentatonic');
   * Kit.sfx.tone({ freq: chime(3), dur: 0.4 });   // G4
   * chime.noteName(5);                            // 'C5' (one octave above the root)
   */
  const scale = (root, kind = 'major') => {
    const intervals = Array.isArray(kind) ? kind : SCALES[kind];
    if (!intervals || !intervals.length) throw new Error(`Kit.music.scale: unknown scale "${kind}" (known: ${Object.keys(SCALES).join(', ')})`);
    const rootMidi = typeof root === 'number' ? root : noteToMidi(root);
    const midi = (degree) => degreeToMidi(rootMidi, intervals, degree);
    const frequency = (degree) => midiToFreq(midi(degree));
    return Object.assign(frequency, { midi, noteName: (degree) => midiToNote(midi(degree)) });
  };

  Kit.music = { SCALES, noteToMidi, midiToFreq, noteToFreq, midiToNote, scale };
})();
