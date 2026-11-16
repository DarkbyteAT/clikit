/**
 * Kit pack: small records as bytes, and bytes as text. A writer appends bytes, variable-length whole numbers,
 * 32-bit numbers and short text; a reader takes them back in the same order and names what went wrong when the
 * data is damaged; `toText` / `fromText` turn bytes into a URL-safe code a person can paste.
 *
 * Owns:  `Kit.pack.writer()`, `Kit.pack.reader(bytes, label)`, `Kit.pack.toText(bytes)`, `Kit.pack.fromText(text)`.
 * Does not own: what a record contains or its version byte (kit/body-recipe.js packs body recipes with it;
 *        share codes for levels, loadouts or replays fit the same shape), compression, or checksums.
 *
 * Pure (no DOM, no THREE): runs in node and is unit-tested by tools/test-kit.js.
 */
(() => {
  const BYTE_RANGE = 256;
  const BYTE_MASK = BYTE_RANGE - 1;
  const UINT32_BYTES = 4;
  /** A varint keeps 7 bits of the number in each byte; the top bit says another byte follows. */
  const VARINT_PAYLOAD_RANGE = 128;
  const VARINT_PAYLOAD_MASK = VARINT_PAYLOAD_RANGE - 1;
  const VARINT_CONTINUE = 0x80;
  /** Five 7-bit groups hold any 32-bit number; a longer varint is damage. */
  const MOST_VARINT_BYTES = 5;
  /** The URL-safe base64 alphabet (RFC 4648 section 5): no padding, nothing a URL or a chat message mangles. */
  const TEXT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const BITS_PER_CHARACTER = 6;
  const BITS_PER_BYTE = 8;

  /**
   * @typedef {Object} PackWriter
   * @property {function(number): PackWriter} byte append a whole number from 0 to 255
   * @property {function(number): PackWriter} varint append a whole number from 0 to 2^32 - 1 in 1 to 5 bytes (small numbers are short)
   * @property {function(number): PackWriter} uint32 append an unsigned 32-bit number, low byte first
   * @property {function(string): PackWriter} text append a varint length and one byte per character (characters above 255 are refused)
   * @property {function(): Uint8Array} bytes everything appended so far
   */

  /**
   * Starts a packed record.
   * @returns {PackWriter} each method returns the writer, so calls chain
   * @throws {Error} from a method given a number outside its range
   * @complexity each append is O(1) amortised (`text` is O(characters)); `bytes` is O(length)
   * @example const bytes = Kit.pack.writer().byte(1).varint(300).uint32(seed).text('gem').bytes();
   */
  const writer = () => {
    const bytes = [];
    const requireWhole = (what, value, limit) => {
      if (!Number.isInteger(value) || value < 0 || value >= limit) throw new Error(`Kit.pack.writer.${what}: needs a whole number from 0 to ${limit - 1}, got ${value}.`);
    };
    const self = {
      byte(value) {
        requireWhole('byte', value, BYTE_RANGE);
        bytes.push(value);
        return self;
      },
      varint(value) {
        requireWhole('varint', value, BYTE_RANGE ** UINT32_BYTES);
        let rest = value;
        while (rest >= VARINT_PAYLOAD_RANGE) {
          bytes.push((rest % VARINT_PAYLOAD_RANGE) | VARINT_CONTINUE);
          rest = Math.floor(rest / VARINT_PAYLOAD_RANGE);
        }
        bytes.push(rest);
        return self;
      },
      uint32(value) {
        requireWhole('uint32', value, BYTE_RANGE ** UINT32_BYTES);
        for (let index = 0; index < UINT32_BYTES; index++) bytes.push((value >>> (index * BITS_PER_BYTE)) & BYTE_MASK);
        return self;
      },
      text(value) {
        self.varint(value.length);
        for (let index = 0; index < value.length; index++) self.byte(value.charCodeAt(index));
        return self;
      },
      bytes: () => Uint8Array.from(bytes),
    };
    return self;
  };

  /**
   * @typedef {Object} PackReader
   * @property {function(): number} byte the next byte
   * @property {function(): number} varint the next variable-length whole number
   * @property {function(): number} uint32 the next unsigned 32-bit number
   * @property {function(): string} text the next length-prefixed text
   * @property {function(): boolean} isDone has everything been read?
   */

  /**
   * Reads a packed record back, in the order it was written.
   * @param {ArrayLike<number>} bytes what a writer produced
   * @param {string} [label='Kit.pack.reader'] who is reading, for error messages
   * @returns {PackReader}
   * @throws {Error} from a method when the bytes end early or a varint is too long (the data was cut or damaged)
   * @complexity each read is O(1) (`text` is O(characters)), no allocation except the text
   * @example const reader = Kit.pack.reader(bytes); const version = reader.byte(), count = reader.varint();
   */
  const reader = (bytes, label = 'Kit.pack.reader') => {
    let at = 0;
    const byte = () => {
      if (at >= bytes.length) throw new Error(`${label}: the data ends at byte ${at} of ${bytes.length}, in the middle of a value. It was cut short.`);
      return bytes[at++];
    };
    const varint = () => {
      let value = 0;
      for (let group = 0; group < MOST_VARINT_BYTES; group++) {
        const next = byte();
        value += (next & VARINT_PAYLOAD_MASK) * VARINT_PAYLOAD_RANGE ** group;
        if (!(next & VARINT_CONTINUE)) return value;
      }
      throw new Error(`${label}: a number runs past ${MOST_VARINT_BYTES} bytes near byte ${at}. The data is damaged.`);
    };
    const uint32 = () => (byte() | (byte() << BITS_PER_BYTE) | (byte() << (2 * BITS_PER_BYTE)) | (byte() << (3 * BITS_PER_BYTE))) >>> 0;
    const text = () => String.fromCharCode(...Array.from({ length: varint() }, byte));
    return { byte, varint, uint32, text, isDone: () => at >= bytes.length };
  };

  /**
   * Bytes as a short URL-safe code (base64url without padding): 4 characters for every 3 bytes.
   * @param {ArrayLike<number>} bytes
   * @returns {string} letters, digits, '-' and '_' only
   * @complexity O(bytes) time and space
   * @example Kit.pack.toText(Uint8Array.of(1, 2, 3)) // 'AQID'
   */
  const toText = (bytes) => {
    let text = '';
    let buffer = 0;
    let bitCount = 0;
    for (let index = 0; index < bytes.length; index++) {
      buffer = (buffer << BITS_PER_BYTE) | bytes[index];
      bitCount += BITS_PER_BYTE;
      while (bitCount >= BITS_PER_CHARACTER) {
        bitCount -= BITS_PER_CHARACTER;
        text += TEXT_ALPHABET[(buffer >>> bitCount) & (TEXT_ALPHABET.length - 1)];
      }
      // Only the bits not yet written are kept, so the buffer never outgrows 32 bits.
      buffer &= (1 << bitCount) - 1;
    }
    return bitCount ? text + TEXT_ALPHABET[(buffer << (BITS_PER_CHARACTER - bitCount)) & (TEXT_ALPHABET.length - 1)] : text;
  };

  /**
   * A code made by `toText` back into bytes.
   * @param {string} text
   * @returns {Uint8Array}
   * @throws {Error} naming the first character that is not part of a code (a mistyped or truncated paste)
   * @complexity O(characters) time and space
   * @example Kit.pack.fromText('AQID') // Uint8Array [1, 2, 3]
   */
  const fromText = (text) => {
    const bytes = [];
    let buffer = 0;
    let bitCount = 0;
    for (let index = 0; index < text.length; index++) {
      const value = TEXT_ALPHABET.indexOf(text[index]);
      if (value < 0) throw new Error(`Kit.pack.fromText: "${text[index]}" at position ${index} is not part of a code (letters, digits, '-' and '_'). Check the code was copied whole.`);
      buffer = (buffer << BITS_PER_CHARACTER) | value;
      bitCount += BITS_PER_CHARACTER;
      if (bitCount >= BITS_PER_BYTE) {
        bitCount -= BITS_PER_BYTE;
        bytes.push((buffer >>> bitCount) & BYTE_MASK);
        buffer &= (1 << bitCount) - 1;
      }
    }
    return Uint8Array.from(bytes);
  };

  Kit.pack = { writer, reader, toText, fromText };
})();
