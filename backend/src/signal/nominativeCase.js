/**
 * Puts a Ukrainian ПІБ back into the nominative (називний відмінок), which is
 * how a name belongs in an OpenProject work package.
 *
 * Requests are written in whatever case the sentence needed -- "довідка для
 * Іванова Івана Івановича", "на Петренка Петра Петровича" -- and filing that
 * verbatim gives a tracker full of names that cannot be searched against the
 * personnel list.
 *
 * **The patronymic decides.** It is the only part of a Ukrainian full name
 * whose ending states the case unambiguously (and the gender with it), so it
 * is read first and the other two parts are converted to match. When the
 * patronymic is already nominative -- which is how most of these messages are
 * written -- nothing is touched at all. That is the safety property this
 * module is built around: a wrong guess writes a real person's name wrongly
 * into the unit's tracker, so anything it cannot convert confidently is left
 * exactly as it was written.
 *
 * Pure -- see test/nominativeCase.test.js.
 */

const VOWELS = 'аеєиіїоуюя';

/** Endings a male patronymic takes, and the case each one means. */
const MALE_PATRONYMIC = /^(.*(?:ович|евич|євич|ич))(ові|еві|ем|а|у|ю)?$/iu;
const MALE_ENDING_CASE = { '': 'nom', а: 'gen', у: 'dat', ю: 'dat', ові: 'dat', еві: 'dat', ем: 'ins' };

/** The same for a female patronymic, whose stem ends in -івн / -ївн / -івн. */
const FEMALE_PATRONYMIC = /^(.*(?:івн|ївн|овн|евн|ічн))(ою|а|и|і|у)$/iu;
const FEMALE_ENDING_CASE = { а: 'nom', и: 'gen', і: 'dat', у: 'acc', ою: 'ins' };

/**
 * Does this word look like a patronymic in any case? The parser uses it to
 * anchor a name, so it has to recognise "Івановича" as readily as "Іванович".
 */
export function looksLikePatronymic(word) {
  return detectCase(word) !== null;
}

/**
 * The case and gender a patronymic is written in, or null if it is not one.
 * Male accusative and genitive are identical for people, so `gen` covers both.
 */
export function detectCase(word) {
  const text = String(word ?? '');

  const male = MALE_PATRONYMIC.exec(text);
  if (male) {
    const grammaticalCase = MALE_ENDING_CASE[(male[2] ?? '').toLowerCase()];
    if (grammaticalCase) return { gender: 'm', case: grammaticalCase, nominative: male[1] };
  }

  const female = FEMALE_PATRONYMIC.exec(text);
  if (female) {
    const grammaticalCase = FEMALE_ENDING_CASE[(female[2] ?? '').toLowerCase()];
    if (grammaticalCase) return { gender: 'f', case: grammaticalCase, nominative: `${female[1]}а` };
  }

  return null;
}

/**
 * A soft consonant keeps its soft sign in the nominative -- Василя -> Василь --
 * but р does not: Ігоря -> Ігор.
 */
function softened(consonant) {
  return consonant.toLowerCase() === 'р' ? consonant : `${consonant}ь`;
}

/**
 * Male given names whose nominative ends in -о. Their genitive ("Петра") is
 * indistinguishable from a consonant-stem name's ("Івана"), so the о has to
 * come from a list rather than a rule.
 */
const O_STEM_GIVEN = new Set([
  'петр', 'павл', 'дмитр', 'михайл', 'данил', 'кирил', 'гаврил', 'марк', 'левк', 'юрк', 'дмитрик',
]);

function restoreOStem(stem) {
  return O_STEM_GIVEN.has(stem.toLowerCase()) ? `${stem}о` : stem;
}

/**
 * A handful of male given names (Микола, Ілля, ...) decline like a noun of
 * the opposite gender. Every other name in this file has the same ending for
 * genitive and accusative ("Олега" covers both), but these don't: genitive
 * "Миколи" and accusative "Миколу" are different shapes, so both have to be
 * whitelisted to get back to "Микола" -- a generic "-у$" rule would also fire
 * on an unrelated dative like "Олегу" and strip a letter that belongs there.
 */
const A_STEM_GIVEN = ['микол', 'кузьм', 'сав', 'хом', 'лук', 'микит', 'йон'];
const YA_STEM_GIVEN = ['ілл'];
const A_STEM_PATTERN = new RegExp(`^(${A_STEM_GIVEN.join('|')})(?:у|и)$`, 'iu');
const YA_STEM_PATTERN = new RegExp(`^(${YA_STEM_GIVEN.join('|')})(?:ю|і)$`, 'iu');

/**
 * A surname ending in -ка is either a -ко surname (Петренка -> Петренко) or a
 * consonant-stem one (Мельника -> Мельник). What separates them is the letter
 * before the к: a consonant means -ко, a vowel means the к is the stem's own
 * last letter.
 */
function restoreKoStem(stem) {
  const match = /(.)к$/iu.exec(stem);
  if (match && !VOWELS.includes(match[1].toLowerCase())) return `${stem}о`;
  return stem;
}

/** Ordered [pattern, replacement] rules; the first that matches wins. */
const GIVEN_RULES = {
  m: {
    gen: [
      [/ія$/iu, 'ій'],
      [/([^аеєиіїоуюя])я$/iu, (_, c) => softened(c)],
      [/(.*)а$/iu, (_, s) => restoreOStem(s)],
      [A_STEM_PATTERN, '$1а'],
      [YA_STEM_PATTERN, '$1я'],
    ],
    dat: [
      [/(.*)(?:ові|еві)$/iu, (_, stem) => restoreOStem(stem)],
      [/ію$/iu, 'ій'],
      [/([^аеєиіїоуюя])ю$/iu, (_, c) => softened(c)],
      [/(.*)у$/iu, (_, s) => restoreOStem(s)],
    ],
    ins: [[/ієм$/iu, 'ій'], [/([^аеєиіїоуюя])ем$/iu, (_, c) => softened(c)], [/(.*)ом$/iu, (_, s) => restoreOStem(s)]],
  },
  f: {
    gen: [[/ії$/iu, 'ія'], [/зі$/iu, 'га'], [/ці$/iu, 'ка'], [/сі$/iu, 'ха'], [/и$/iu, 'а'], [/і$/iu, 'а']],
    dat: [[/ії$/iu, 'ія'], [/зі$/iu, 'га'], [/ці$/iu, 'ка'], [/сі$/iu, 'ха'], [/і$/iu, 'а']],
    acc: [[/ію$/iu, 'ія'], [/у$/iu, 'а']],
    ins: [[/ією$/iu, 'ія'], [/ею$/iu, 'я'], [/ою$/iu, 'а']],
  },
};

const SURNAME_RULES = {
  m: {
    gen: [
      [/ого$/iu, 'ий'],
      [/и$/iu, 'а'],
      [/і$/iu, 'я'],
      [/(.*)а$/iu, (_, s) => restoreKoStem(s)],
    ],
    dat: [
      [/ому$/iu, 'ий'],
      [/(.*)(?:ові|еві)$/iu, (_, s) => restoreKoStem(s)],
      [/(.*)у$/iu, (_, s) => restoreKoStem(s)],
      [/(.*)ю$/iu, (_, s) => restoreKoStem(s)],
    ],
    ins: [
      // -им is two different surnames: possessive (Івановим -> Іванов) keeps
      // its stem, adjectival (Ковальським -> Ковальський) takes -ий back.
      [/((?:ов|ев|єв|ів|ин|ін))им$/iu, '$1'],
      [/им$/iu, 'ий'],
      [/(.*)ом$/iu, (_, stem) => restoreKoStem(stem)],
      [/(.*)ем$/iu, (_, stem) => restoreKoStem(stem)],
    ],
  },
  f: {
    gen: [[/ої$/iu, 'а'], [/и$/iu, 'а'], [/і$/iu, 'я']],
    dat: [[/ій$/iu, 'а'], [/і$/iu, 'а']],
    acc: [[/у$/iu, 'а'], [/ю$/iu, 'я']],
    ins: [[/ою$/iu, 'а'], [/ею$/iu, 'я']],
  },
};

/** Applies the first matching rule, or returns the word untouched. */
function convert(word, rules) {
  if (!word) return word;
  for (const [pattern, replacement] of rules ?? []) {
    if (pattern.test(word)) return word.replace(pattern, replacement);
  }
  return word;
}

/**
 * Converts a parsed `{ surname, given, patronymic }` to the nominative.
 *
 * Returns the parts plus `case` (what the name was written in) and
 * `converted` (whether anything changed). A name with no patronymic carries no
 * case signal, so it comes back untouched -- guessing from a surname alone
 * turns "Кучма" into three different people.
 */
export function toNominative({ surname = null, given = null, patronymic = null } = {}) {
  const detected = patronymic ? detectCase(patronymic) : null;

  if (!detected || detected.case === 'nom') {
    return { surname, given, patronymic, case: detected?.case ?? null, converted: false };
  }

  const { gender, case: grammaticalCase } = detected;
  return {
    surname: convert(surname, SURNAME_RULES[gender][grammaticalCase]),
    given: convert(given, GIVEN_RULES[gender][grammaticalCase]),
    patronymic: detected.nominative,
    case: grammaticalCase,
    converted: true,
  };
}
