// Kit dice: dice notation in, a structured roll out. Pure: no DOM, no THREE, no hidden randomness (the caller passes the rng).
//
// Owns:  parsing notation into a plan, rolling a plan with a Kit.rng, the bounds of a plan, and a one-line text form of a result.
// Does not own: drawing dice, announcing rolls to other players (send the notation and the rng seed; every screen re-rolls it and
//               gets the same dice, so a total can never disagree with the dice shown), or any game system's meaning of a result.
//
// Notation (case is ignored; spaces are allowed around signs and around adv / dis):
//   2d6+3      two six-sided dice plus three          d20        one die (the count defaults to 1)
//   4d6kh3     keep the highest three                 2d20kl1    keep the lowest one
//   4d6dl1     drop the lowest one                    4d6dh1     drop the highest one
//   3d6!       exploding: a die showing its top face adds another die
//   d20 adv    advantage: roll two, keep the highest  d20 dis    disadvantage: roll two, keep the lowest
//   d%         a hundred-sided die                    4dF        fudge dice showing -1, 0 or +1
(() => {
  /**
   * Upper bounds on what a notation may ask for. Notation arrives from other players, so every size is capped:
   * a roll must stay cheap to compute and small enough to show.
   */
  const LIMITS = {
    /** Longest notation accepted, in characters. */
    TEXT_LENGTH: 80,
    /** Most terms (dice groups and flat numbers) in one notation. */
    TERMS: 12,
    /** Most dice in one group. */
    DICE_PER_TERM: 100,
    /** Most faces on one die. */
    SIDES: 1000,
    /** Largest flat modifier. */
    MODIFIER: 100000,
    /** Most extra dice one exploding group may add, so a d1! cannot run forever. */
    EXPLOSIONS: 50,
  };

  /** Faces of a fudge die. */
  const FUDGE_FACES = [-1, 0, 1];
  /** Sides and count that the words "adv" and "dis" turn a single die into. */
  const ADVANTAGE_DICE = 2;

  /**
   * How each keep/drop suffix turns into "keep the highest or lowest N of the group".
   * Dropping is keeping the rest from the other end, so every suffix reduces to one shape.
   * @type {Object<string, function(number, number): Keep>}
   */
  const KEEP_RULES = {
    kh: (amount) => ({ highest: true, count: amount }),
    k: (amount) => ({ highest: true, count: amount }),
    kl: (amount) => ({ highest: false, count: amount }),
    dl: (amount, diceCount) => ({ highest: true, count: diceCount - amount }),
    d: (amount, diceCount) => ({ highest: true, count: diceCount - amount }),
    dh: (amount, diceCount) => ({ highest: false, count: diceCount - amount }),
  };

  /**
   * @typedef {Object} Keep
   * @property {boolean} highest  true keeps the highest dice, false the lowest
   * @property {number} count     how many dice are kept
   */
  /**
   * @typedef {Object} DiceTerm    one group of identical dice in a plan
   * @property {1|-1} sign         whether the group adds to or subtracts from the total
   * @property {number} count      dice rolled before any explosion
   * @property {number} sides      faces per die (FUDGE_FACES.length for fudge dice)
   * @property {boolean} isFudge   faces are -1, 0, +1 instead of 1..sides
   * @property {boolean} explodes  a die on its top face adds another die
   * @property {Keep|null} keep    which dice count toward the total; null keeps all
   */
  /**
   * @typedef {Object} NumberTerm  a flat modifier in a plan
   * @property {1|-1} sign
   * @property {number} value
   */
  /**
   * @typedef {Object} RollPlan    a parsed notation
   * @property {string} text                          canonical notation ("2d20kh1+3")
   * @property {Array<DiceTerm|NumberTerm>} terms
   */
  /**
   * @typedef {Object} Die         one rolled die, for display
   * @property {number} value      the face showing
   * @property {number} sides
   * @property {boolean} isKept    false when a keep/drop rule discarded it
   * @property {boolean} isBonus   true when it was added by an explosion
   */
  /**
   * @typedef {Object} RolledTerm
   * @property {1|-1} sign
   * @property {string} text       the term's own notation ("4d6kh3" or "3")
   * @property {Die[]} dice        every die rolled, in roll order (empty for a flat number)
   * @property {number} subtotal   signed contribution to the total
   */
  /**
   * @typedef {Object} RollResult
   * @property {string} text         canonical notation
   * @property {number} total
   * @property {RolledTerm[]} terms
   * @property {Die[]} dice          every die of every term, flattened for display
   * @property {number|null} natural the kept face of the first d20 group when exactly one of its dice is kept (a check), else null
   */

  const isDiceTerm = (term) => term.sides !== undefined;

  /** One term: an optional sign, then either dice (count, d, sides, optional "!" and keep/drop suffix) or a plain number. */
  const TERM_PATTERN = /([+-]?)(?:(\d*)d(\d+|%|f)(!?)(?:(kh|kl|dh|dl|k|d)(\d+))?|(\d+))/y;
  const ADVANTAGE_WORDS = /adv|dis/g;

  /** @param {string} message @returns {never} */
  const fail = (message) => {
    throw new Error(`Kit.dice: ${message}`);
  };
  const requireAtMost = (value, limit, what) => (value > limit ? fail(`${what} ${value} is over the limit of ${limit}`) : value);

  /**
   * Build one dice term from the pieces the pattern captured.
   * @returns {DiceTerm}
   */
  function buildDiceTerm(sign, countText, sidesText, explodeMark, keepSuffix, keepAmountText) {
    const isFudge = sidesText === 'f';
    const sides = isFudge ? FUDGE_FACES.length : sidesText === '%' ? 100 : Number(sidesText);
    const count = countText === '' ? 1 : Number(countText);
    if (count < 1) fail('a dice group needs at least one die');
    if (sides < 1) fail('a die needs at least one side');
    requireAtMost(count, LIMITS.DICE_PER_TERM, 'dice count');
    requireAtMost(sides, LIMITS.SIDES, 'die size');
    const keep = keepSuffix ? KEEP_RULES[keepSuffix](Number(keepAmountText), count) : null;
    if (keep && (keep.count < 0 || keep.count > count)) fail(`cannot keep or drop ${keepAmountText} of ${count} dice`);
    return { sign, count, sides, isFudge, explodes: explodeMark === '!', keep };
  }

  /**
   * Apply "adv" or "dis" to the first group that is a single die with no keep rule: it becomes two dice keeping one.
   * @param {Array<DiceTerm|NumberTerm>} terms
   * @param {string} word  "adv" or "dis"
   */
  function applyAdvantage(terms, word) {
    const target = terms.find((term) => isDiceTerm(term) && term.count === 1 && !term.keep);
    if (!target) fail(`"${word}" needs a single die to apply to, such as d20`);
    target.count = ADVANTAGE_DICE;
    target.keep = { highest: word === 'adv', count: 1 };
  }

  const diceTermText = (term) => {
    const sides = term.isFudge ? 'F' : term.sides;
    const keep = term.keep ? `${term.keep.highest ? 'kh' : 'kl'}${term.keep.count}` : '';
    return `${term.count}d${sides}${term.explodes ? '!' : ''}${keep}`;
  };
  const termText = (term) => (isDiceTerm(term) ? diceTermText(term) : String(term.value));
  /** Canonical notation of a list of terms: signs between terms, no leading plus. */
  const planText = (terms) => terms.map((term, index) => (term.sign < 0 ? '-' : index ? '+' : '') + termText(term)).join('');

  /**
   * Parse dice notation into a plan. Throws an Error naming the problem when the text is not valid notation or asks for too much.
   * @param {string} notation  for example "2d6+3", "4d6kh3", "d20 adv + 2"
   * @returns {RollPlan}
   * @example Kit.dice.parse('d20 adv+2').text // "2d20kh1+2"
   * @complexity O(length of the notation) time; O(terms) space, at most LIMITS.TERMS.
   */
  function parse(notation) {
    if (typeof notation !== 'string') fail('notation must be text');
    if (notation.length > LIMITS.TEXT_LENGTH) fail(`notation is longer than ${LIMITS.TEXT_LENGTH} characters`);
    // "disadvantage" contains "advantage", so the longer word is shortened first.
    const lowered = notation.toLowerCase().trim().replace(/disadvantage/g, 'dis').replace(/advantage/g, 'adv');
    const advantageWords = lowered.match(ADVANTAGE_WORDS) || [];
    if (advantageWords.length > 1) fail('only one "adv" or "dis" is allowed');
    // Spaces are dropped only around signs and the advantage word. A space left inside ("2d6 3") then fails to parse,
    // instead of silently gluing two numbers into one ("2d63").
    const source = lowered.replace(ADVANTAGE_WORDS, ' ').replace(/\s*([+-])\s*/g, '$1').trim();
    if (!source) fail('notation is empty');

    const terms = [];
    let position = 0;
    while (position < source.length) {
      TERM_PATTERN.lastIndex = position;
      const match = TERM_PATTERN.exec(source);
      // Every term after the first needs an explicit sign: "2d6d8" is not two groups.
      if (!match || (terms.length && !match[1])) fail(`cannot read "${source.slice(position)}" in "${notation}"`);
      const [whole, signText, countText, sidesText, explodeMark, keepSuffix, keepAmountText, numberText] = match;
      const sign = signText === '-' ? -1 : 1;
      terms.push(
        numberText === undefined
          ? buildDiceTerm(sign, countText, sidesText, explodeMark, keepSuffix, keepAmountText)
          : { sign, value: requireAtMost(Number(numberText), LIMITS.MODIFIER, 'modifier') }
      );
      requireAtMost(terms.length, LIMITS.TERMS, 'number of terms');
      position += whole.length;
    }
    if (advantageWords.length) applyAdvantage(terms, advantageWords[0]);
    return { text: planText(terms), terms };
  }

  /**
   * Turn any random source into "whole number from low to high inclusive".
   * @param {{int: function(number, number): number}|function(): number} rng  a Kit.rng, or a function returning [0, 1)
   * @returns {function(number, number): number}
   */
  const integerSource = (rng) => (typeof rng === 'function' ? (low, high) => low + Math.floor(rng() * (high - low + 1)) : rng.int);

  /**
   * Roll the dice of one group, explosions included, without deciding which are kept.
   * @param {DiceTerm} term
   * @param {function(number, number): number} rollInteger
   * @returns {Die[]}
   */
  function rollGroup(term, rollInteger) {
    const rollOne = (isBonus) => ({
      value: term.isFudge ? FUDGE_FACES[rollInteger(0, FUDGE_FACES.length - 1)] : rollInteger(1, term.sides),
      sides: term.sides,
      isKept: true,
      isBonus,
    });
    const dice = Array.from({ length: term.count }, () => rollOne(false));
    if (!term.explodes || term.isFudge) return dice;
    // Each top face (original or bonus) earns one more die; `index` walks the growing list so bonus dice can explode too.
    for (let index = 0, bonusCount = 0; index < dice.length && bonusCount < LIMITS.EXPLOSIONS; index++) {
      if (dice[index].value !== term.sides) continue;
      dice.push(rollOne(true));
      bonusCount++;
    }
    return dice;
  }

  /**
   * Mark which dice of a group count, per its keep rule. Ties keep the earlier die, so the result is deterministic.
   * @param {Die[]} dice
   * @param {Keep|null} keep
   * @returns {Die[]} the same dice, in roll order, with isKept set
   */
  function markKept(dice, keep) {
    if (!keep) return dice;
    const ranked = dice.map((die, index) => ({ die, index })).sort((first, second) => (keep.highest ? second.die.value - first.die.value : first.die.value - second.die.value) || first.index - second.index);
    const keptIndexes = new Set(ranked.slice(0, keep.count).map((entry) => entry.index));
    return dice.map((die, index) => ({ ...die, isKept: keptIndexes.has(index) }));
  }

  const sumKept = (dice) => dice.reduce((sum, die) => sum + (die.isKept ? die.value : 0), 0);

  /** @returns {RolledTerm} */
  function rollTerm(term, rollInteger) {
    if (!isDiceTerm(term)) return { sign: term.sign, text: termText(term), dice: [], subtotal: term.sign * term.value };
    const dice = markKept(rollGroup(term, rollInteger), term.keep);
    return { sign: term.sign, text: termText(term), dice, subtotal: term.sign * sumKept(dice) };
  }

  /**
   * The face of a d20 check, when the plan has one: the first d20 group that keeps exactly one die.
   * @returns {number|null}
   */
  function naturalOf(plan, rolledTerms) {
    const index = plan.terms.findIndex((term) => isDiceTerm(term) && term.sides === 20 && !term.isFudge);
    if (index < 0) return null;
    const kept = rolledTerms[index].dice.filter((die) => die.isKept);
    return kept.length === 1 ? kept[0].value : null;
  }

  /**
   * Roll a notation or a parsed plan. The same plan and the same rng seed always give the same result.
   * @param {string|RollPlan} notationOrPlan
   * @param {{int: function(number, number): number}|function(): number} [rng]  defaults to a fresh, randomly seeded Kit.rng
   * @returns {RollResult}
   * @example
   * const roll = Kit.dice.roll('4d6kh3', Kit.rng(7));
   * roll.total; roll.dice.map((die) => die.value);
   * @complexity O(dice rolled) time and space, at most LIMITS.TERMS x (LIMITS.DICE_PER_TERM + LIMITS.EXPLOSIONS); a keep rule sorts one group, O(d log d).
   */
  function roll(notationOrPlan, rng = Kit.rng()) {
    const plan = typeof notationOrPlan === 'string' ? parse(notationOrPlan) : notationOrPlan;
    const rollInteger = integerSource(rng);
    const terms = plan.terms.map((term) => rollTerm(term, rollInteger));
    return {
      text: plan.text,
      total: terms.reduce((sum, term) => sum + term.subtotal, 0),
      terms,
      dice: terms.flatMap((term) => term.dice),
      natural: naturalOf(plan, terms),
    };
  }

  /** Lowest and highest sum the kept dice of one group can show (explosions ignored: they have no upper bound). */
  function groupBounds(term) {
    const keptCount = term.keep ? term.keep.count : term.count;
    const [lowFace, highFace] = term.isFudge ? [FUDGE_FACES[0], FUDGE_FACES[FUDGE_FACES.length - 1]] : [1, term.sides];
    return [keptCount * lowFace, keptCount * highFace];
  }

  /**
   * The smallest and largest total a plan can produce, ignoring explosions.
   * @param {string|RollPlan} notationOrPlan
   * @returns {{min: number, max: number}}
   * @complexity O(terms) time, O(1) space.
   */
  function range(notationOrPlan) {
    const plan = typeof notationOrPlan === 'string' ? parse(notationOrPlan) : notationOrPlan;
    return plan.terms.reduce(
      (bounds, term) => {
        const [low, high] = isDiceTerm(term) ? groupBounds(term) : [term.value, term.value];
        // A subtracted term contributes its high end to the minimum and its low end to the maximum.
        return term.sign > 0 ? { min: bounds.min + low, max: bounds.max + high } : { min: bounds.min - high, max: bounds.max - low };
      },
      { min: 0, max: 0 }
    );
  }

  /**
   * One line of text for a result: every die in brackets, dropped dice in parentheses, then the total.
   * @param {RollResult} result
   * @returns {string}
   * @example Kit.dice.describe(Kit.dice.roll('4d6kh3+2', Kit.rng(1))) // "4d6kh3+2: [6, 4, 3, (1)] + 2 = 15"
   * @complexity O(dice rolled) time and space.
   */
  function describe(result) {
    const termParts = result.terms.map((term, index) => {
      const body = term.dice.length ? `[${term.dice.map((die) => (die.isKept ? die.value : `(${die.value})`)).join(', ')}]` : term.text;
      return (term.sign < 0 ? '- ' : index ? '+ ' : '') + body;
    });
    return `${result.text}: ${termParts.join(' ')} = ${result.total}`;
  }

  /**
   * Notation for a d20 check with a modifier.
   * @param {number} modifier                     added to the die (negative subtracts)
   * @param {'adv'|'dis'|null} [advantage=null]   roll two and keep the best or worst
   * @returns {string}
   * @example Kit.dice.check(3, 'adv') // "2d20kh1+3"
   */
  function check(modifier = 0, advantage = null) {
    const die = advantage === 'adv' ? '2d20kh1' : advantage === 'dis' ? '2d20kl1' : '1d20';
    const whole = Math.trunc(modifier);
    return whole ? `${die}${whole < 0 ? '-' : '+'}${Math.abs(whole)}` : die;
  }

  Kit.dice = { parse, roll, range, describe, check, LIMITS };
})();
