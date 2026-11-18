/**
 * Natural-language parser for help-desk requests written the way people
 * actually write them in a Signal group.
 *
 * The unit's certificate requests never arrive as "!command arg" -- they look
 * like "молодший сержант Іванов Іван Іванович потрібно довідка ф12, довідка ф5
 * для вихідного контролю." A regex rule can pull one capture group out of a
 * fixed shape; it cannot answer "who, and which forms" for free-form text that
 * puts the name first here and the forms first there, sometimes lists several
 * people under one form, sometimes several forms for one person.
 *
 * So this module turns a message into a structure:
 *
 *   people:   who the request is about (rank + ПІБ, split into parts)
 *   forms:    which certificates were asked for, normalized to a label
 *   requests: people joined to their forms -- what a work package is made from
 *   pairs:    the same thing flattened, one entry per certificate to produce
 *
 * It is pure: no DB, no HTTP, no settings. See test/naturalParser.test.js,
 * which pins every real message shape this was built from.
 *
 * Precision is deliberately favoured over recall: a missed request gets asked
 * about again in the group, while an invented one files a work package against
 * a real person in the unit's tracker. That is why a bare "5" is never read as
 * a form, and why a name needs either a patronymic or a rank in front of it.
 */

import { looksLikePatronymic, toNominative } from './nominativeCase.js';

// ------------------------------------------------------------------ alphabet
// \b is ASCII-only in JavaScript, so it never fires between a space and a
// Cyrillic letter -- every word boundary here has to be a \p{L} lookaround.
const UPPER = 'A-ZА-ЯЁІЇЄҐ';
const LOWER = 'a-zа-яёіїєґ';
const APOS = "'’ʼ";

/**
 * A capitalized word that could be part of a name: Іванов, Дем'янюк-Швець.
 * Also accepts an all-caps surname (РУСАВСЬКИЙ) -- official-style messages
 * routinely write just the surname that way, and the run-detection below only
 * looks at capitalization, not letter case throughout the word.
 */
const NAME_WORD = new RegExp(`^[${UPPER}](?:[${LOWER}${APOS}-]+|[${UPPER}${APOS}-]+)$`, 'u');

/**
 * Capitalized words that start sentences in these messages. Without this a
 * greeting like "Слава Україні" reads as a two-word name.
 */
const NOT_A_NAME = new Set([
  'добрий', 'доброго', 'добридень', 'вітаю', 'привіт', 'бажаю', 'здоровя', "здоров'я",
  'слава', 'україні', 'героям', 'прошу', 'потрібна', 'потрібно', 'потрібні', 'треба',
  'довідка', 'довідки', 'довідку', 'форма', 'форми', 'форму', 'ще', 'дякую', 'будь',
  'ласка', 'день', 'ранку', 'вечора', 'дня',
]);

/**
 * Ranks, so "молодший сержант Іванов Іван Іванович" yields a rank and a clean
 * three-word name instead of a name starting at "Сержант". Matched as whole
 * phrases, longest first, so "молодший сержант" doesn't come back as "сержант".
 */
const RANKS = [
  'головний майстер-сержант', 'старший майстер-сержант', 'майстер-сержант', 'штаб-сержант',
  'молодший сержант', 'старший сержант', 'головний сержант', 'сержант',
  'старший солдат', 'солдат', 'рядовий', 'старший матрос', 'матрос', 'рекрут', 'курсант',
  'старший прапорщик', 'прапорщик', 'головний старшина', 'старшина',
  'старший мічман', 'мічман',
  'молодший лейтенант', 'старший лейтенант', 'лейтенант', 'капітан-лейтенант', 'капітан',
  'майор', 'підполковник', 'полковник',
  'бригадний генерал', 'генерал-майор', 'генерал-лейтенант', 'генерал-полковник', 'генерал',
  'військовослужбовець',
];
const RANK_SET = new Set(RANKS);
const RANK_MAX_WORDS = Math.max(...RANKS.map((rank) => rank.split(' ').length));

/**
 * A rank declines with the name it introduces -- "для солдата Іванова Івана
 * Івановича" -- so ranks are also looked up by stem, and the canonical
 * nominative from RANKS is what gets stored either way.
 */
function rankStem(word) {
  return word.replace(/(ові|еві|ого|ому|ими|ий|ій|им|ом|ем|ів|а|у|ю|и|і|е|я)$/iu, '');
}
const RANK_BY_STEM = new Map(
  RANKS.map((rank) => [rank.split(' ').map(rankStem).join(' '), rank])
);

/** "мол. сержант" / "ст. лейтенант" are written both ways. */
const RANK_ABBREVIATIONS = new Map([
  ['мол', 'молодший'],
  ['мол.', 'молодший'],
  ['ст', 'старший'],
  ['ст.', 'старший'],
  ['гол', 'головний'],
  ['гол.', 'головний'],
]);

/**
 * Certificates that have a name rather than a number. Extend this list to
 * teach the parser a new one; `label` is what a rule hands to OpenProject, so
 * it should read exactly like the option in the "Тип довідки" field --
 * `resolveLinkHref` matches an allowed value by label, case-insensitively.
 */
export const DEFAULT_FORM_ALIASES = [
  {
    code: 'vk',
    // The group asks for this one as "замість ВК", but that is not a value
    // in OpenProject -- the option there is "Довідка щодо військовослужбовця".
    label: 'Довідка щодо військовослужбовця',
    // "Довідка в/с (замість ВК)", "довідка замість ВК", bare "замість ВК", and
    // the official name. "щодо" is required in front of "військовослужбовц..."
    // because that word is also a rank: "довідка на військовослужбовця Іванова"
    // introduces a person, not this certificate.
    pattern: /(?:довідк\S*\s+щодо\s+(?:військовослужбовц\S*|в\s*\/\s*с)|(?:довідк\S*\s+)?(?:в\s*\/\s*с\s*)?\(?\s*замість\s+в\s*[./]?\s*к\.?\s*\)?)/giu,
  },
];

/**
 * Numbered forms. Both spellings carry an optional "довідка" prefix so that
 * word is consumed with the form rather than left behind, where its capital
 * letter would look like the start of a name.
 *
 * Only a prefixed number counts. "форми 5, 6 та 12" therefore yields just
 * Форма 5 -- reading the bare numbers too would also read a "2" out of
 * "ф5 і 2 людини", and inventing a certificate is the worse failure.
 */
const NUMBERED_PATTERNS = [
  /(?:довідк\S*\s+)?(?<!\p{L})форм\S*\s*[№#]?\s*(\d{1,3})(?!\p{L}|\d)/giu,
  /(?:довідк\S*\s+)?(?<!\p{L})ф\s*[.\-–—№#]?\s*(\d{1,3})(?!\p{L}|\d)/giu,
];

/**
 * "для вихідного контролю", "для суду" -- why the certificate is needed. Read
 * from text with the names already masked out, so "для суду на солдат Іванов
 * Іван Іванович" gives "суду" and not the rest of the sentence.
 */
const PURPOSE = /(?<!\p{L})для\s+([^\n,.;()]{2,60})/giu;

/** A personal number written next to a name, e.g. "..., 123124". */
const PERSONAL_NUMBER = /(?<![\p{L}\d])(\d{4,})(?![\p{L}\d])/gu;

// --------------------------------------------------------------------- text

/**
 * Same-length normalization (apart from CRLF), so every index below still
 * points into the string the caller can slice for context.
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t   ]/g, ' ')
    .replace(/[’ʼ]/g, "'");
}

/** Turns a list of span starts into a lookup from character offset to span. */
function indexerFor(starts) {
  return (index) => {
    let span = 0;
    while (span + 1 < starts.length && starts[span + 1] <= index) span += 1;
    return span;
  };
}

/** Line index for a character offset: a form list can be a header for a line. */
function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return indexerFor(starts);
}

/**
 * "і"/"та" ("and"), as a standalone word -- never inside one, since both
 * letter sequences occur mid-word constantly ("прізвище", "зустріч"). Reuses
 * the \p{L} lookaround convention the rest of this file uses for boundaries
 * ASCII \b can't see next to Cyrillic.
 */
const CONJUNCTION = /(?<!\p{L})(?:і|та)(?!\p{L})/giu;

/**
 * Where one request stops and the next begins, at two strengths.
 *
 * Two requests are routinely written on one line -- "довідка ф12 на Костиря
 * Сергій Олександрович; і ф6 для пенсійного на Жепяк Назар Васильович" -- and
 * joining by line alone hands both people both forms. The same thing happens
 * with no punctuation at all when "і"/"та" is the only thing joining them --
 * "ф6 на Борсук Андрія Андрійовича і ф5 на Колесника Віталія Васильовича".
 *
 * A **clause** ends at a line break, a semicolon or a sentence end: those never
 * separate a person from their own forms. A **segment** also ends at a comma
 * or a standalone "і"/"та" -- which usually separates two requests ("ф12 на
 * Костиря, ф6 на Жепяк") but sometimes just joins two forms of one ("ф5 і
 * ф12 на Іванов"). Telling the two apart is what the merge step below does,
 * and it is only allowed to look inside one clause -- which is what stops a
 * comma- or conjunction-separated form from being carried across a semicolon
 * to the wrong person.
 */
function boundaryIndexer(text, { commas, conjunctions }) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const sentenceEnd = '.!?'.includes(char) && (i + 1 >= text.length || /\s/u.test(text[i + 1]));
    if (char === '\n' || char === ';' || sentenceEnd || (commas && char === ',')) starts.push(i + 1);
  }
  if (conjunctions) {
    for (const match of text.matchAll(CONJUNCTION)) starts.push(match.index + match[0].length);
  }
  starts.sort((a, b) => a - b);
  return indexerFor(starts);
}

const clauseIndexer = (text) => boundaryIndexer(text, { commas: false, conjunctions: false });
const segmentIndexer = (text) => boundaryIndexer(text, { commas: true, conjunctions: true });

/** Blanks out a span while keeping every other character at its own offset. */
function mask(text, start, end) {
  const blanked = text.slice(start, end).replace(/[^\n]/g, ' ');
  return text.slice(0, start) + blanked + text.slice(end);
}

// -------------------------------------------------------------------- forms

/**
 * Every certificate mentioned, in the order it appears. Overlapping matches
 * are resolved in favour of the earlier one (and, for equal starts, the
 * longer), so "довідка форми 5" is one form rather than a form plus a stray.
 */
export function findForms(text, aliases = DEFAULT_FORM_ALIASES) {
  const lineOf = lineIndexer(text);
  const candidates = [];

  for (const alias of aliases) {
    for (const match of text.matchAll(alias.pattern)) {
      candidates.push({
        code: alias.code,
        label: alias.label,
        number: null,
        raw: match[0].trim(),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  for (const pattern of NUMBERED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const number = String(Number(match[1])); // "05" and "5" are the same form
      candidates.push({
        code: `f${number}`,
        label: `Форма ${number}`,
        number,
        raw: match[0].trim(),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((form) => candidate.start < form.end && form.start < candidate.end)) continue;
    accepted.push(candidate);
  }

  return accepted.map((form) => ({
    code: form.code,
    label: form.label,
    number: form.number,
    raw: form.raw,
    index: form.start,
    line: lineOf(form.start),
  }));
}

// ------------------------------------------------------------------- people

function coreOf(word) {
  return word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

/** Words with their offsets; punctuation is kept so a run can be ended by it. */
function tokenize(text) {
  return [...text.matchAll(/\S+/gu)].map((match) => ({
    raw: match[0],
    core: coreOf(match[0]),
    index: match.index,
    end: match.index + match[0].length,
  }));
}

function isNameWord(token) {
  return NAME_WORD.test(token.core) && !NOT_A_NAME.has(token.core.toLowerCase());
}

/**
 * An all-caps name part (РУСАВСЬКИЙ) still belongs in the ticket as normal
 * title case; a hyphenated surname gets a capital on each half. Anything not
 * fully upper case -- which is how names are written the rest of the time --
 * is left untouched.
 */
function titleCase(word) {
  if (!word || word !== word.toUpperCase() || word === word.toLowerCase()) return word;
  return word
    .split('-')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join('-');
}

/**
 * Consecutive capitalized words, uninterrupted by punctuation or a line break.
 * A comma ends a run, which is what separates two names written on one line.
 */
function nameRuns(tokens, text) {
  const runs = [];
  let current = [];
  for (const token of tokens) {
    if (!isNameWord(token)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const previous = current[current.length - 1];
    const broken =
      previous &&
      (/[^\p{L}\p{N}]$/u.test(previous.raw) || text.slice(previous.end, token.index).includes('\n'));
    if (broken) {
      runs.push(current);
      current = [];
    }
    current.push(token);
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * The rank written immediately before a name on the same line, as
 * `{ text, index }` so the caller can treat "солдат Іванов Іван Іванович" as
 * one span. Returns null when the words before the name are not a rank.
 */
export function rankBefore(tokens, runStart, text) {
  const before = [];
  for (let i = runStart - 1; i >= 0 && before.length < RANK_MAX_WORDS; i -= 1) {
    const token = tokens[i];
    const next = tokens[i + 1] ?? { index: text.length };
    if (text.slice(token.end, next.index).includes('\n')) break;
    const word = token.core.toLowerCase();
    if (!word) break;
    before.unshift({ word: RANK_ABBREVIATIONS.get(word) ?? word, index: token.index });
  }
  for (let size = Math.min(RANK_MAX_WORDS, before.length); size >= 1; size -= 1) {
    const words = before.slice(before.length - size);
    const phrase = words.map((entry) => entry.word).join(' ');
    const canonical = RANK_SET.has(phrase)
      ? phrase
      : RANK_BY_STEM.get(words.map((entry) => rankStem(entry.word)).join(' '));
    if (canonical) return { text: canonical, index: words[0].index };
  }
  return null;
}

/**
 * Splits one run of capitalized words into names.
 *
 * A patronymic anchors the split: it is the last of the three parts in the
 * usual "Іванов Іван Іванович" order and the middle one in "Іван Іванович
 * Іванов", and a run long enough to hold two names is split on each patronymic
 * it contains. With no patronymic at all the run is only accepted when a rank
 * introduces it -- otherwise any two capitalized words in a row become a
 * person, and a message that opens with two of them files a ticket for nobody.
 */
function namesFromRun(run, rank) {
  const patronymics = run.map((token, i) => (looksLikePatronymic(token.core) ? i : -1)).filter((i) => i >= 0);
  const names = [];
  const used = new Set();

  for (const i of patronymics) {
    if (used.has(i)) continue;
    let parts = null;
    if (i >= 2 && !used.has(i - 1) && !used.has(i - 2)) {
      parts = { surname: run[i - 2], given: run[i - 1], patronymic: run[i] };
    } else if (i >= 1 && !used.has(i - 1) && i + 1 < run.length && !used.has(i + 1)) {
      parts = { given: run[i - 1], patronymic: run[i], surname: run[i + 1] };
    } else if (i >= 1 && !used.has(i - 1)) {
      parts = { given: run[i - 1], patronymic: run[i], surname: null };
    }
    if (!parts) continue;
    for (const token of Object.values(parts)) if (token) used.add(run.indexOf(token));
    names.push(parts);
  }

  if (!names.length && rank && run.length >= 2 && run.length <= 3) {
    names.push({ surname: run[0], given: run[1], patronymic: run[2] ?? null });
  }

  return names;
}

/** Everyone the message names, in the order they appear. */
export function findPeople(text) {
  const lineOf = lineIndexer(text);
  const tokens = tokenize(text);
  const people = [];

  for (const run of nameRuns(tokens, text)) {
    const rank = rankBefore(tokens, tokens.indexOf(run[0]), text);
    let first = true;
    for (const parts of namesFromRun(run, rank)) {
      const ordered = [parts.surname, parts.given, parts.patronymic].filter(Boolean);
      const index = Math.min(...ordered.map((token) => token.index));
      // A ticket wants the nominative; the message may well have declined the
      // name to fit its sentence ("довідка для Іванова Івана Івановича").
      const nominative = toNominative({
        surname: parts.surname?.core ?? null,
        given: parts.given?.core ?? null,
        patronymic: parts.patronymic?.core ?? null,
      });
      const surname = titleCase(nominative.surname);
      const given = titleCase(nominative.given);
      const patronymic = titleCase(nominative.patronymic);
      people.push({
        full: [surname, given, patronymic].filter(Boolean).join(' '),
        // The same name as the message spelled it, in the order it spelled it.
        writtenAs: [...ordered].sort((a, b) => a.index - b.index).map((token) => token.core).join(' '),
        grammaticalCase: nominative.case,
        endIndex: Math.max(...ordered.map((token) => token.end)),
        surname,
        given,
        patronymic,
        // Only the first name of a run gets the rank standing in front of it.
        rank: first && rank ? rank.text : null,
        // Where "рекрут Іванов Іван Іванович" starts, rank included.
        spanStart: first && rank ? rank.index : index,
        note: null,
        personalNumber: null,
        purpose: null,
        index,
        line: lineOf(index),
      });
      first = false;
    }
  }

  return people;
}

// ------------------------------------------------------------------ parsing

/**
 * Tidies a captured purpose: masked-out names leave runs of spaces behind, and
 * a dangling preposition ("для суду на") is what is left when the name that
 * followed it was masked.
 */
function cleanPurpose(text) {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\s+(на|для|у|в)$/iu, '')
    .trim();
}

function uniqueForms(forms) {
  const seen = new Set();
  return forms.filter((form) => (seen.has(form.code) ? false : seen.add(form.code)));
}

/**
 * Parses one message into people, forms, and the requests joining them.
 *
 * Forms and people are joined by narrowing scope until something is found:
 *
 *   1. the person's own clause -- two requests on one line, split by a
 *      semicolon, a comma or a sentence end, keep to themselves;
 *   2. failing that, their line, so a clause boundary in the wrong place
 *      cannot lose a form;
 *   3. failing that, forms written on a line that names nobody, which is a
 *      header for everyone listed under it ("потрібні ф6 на:" then one name
 *      per line);
 *   4. failing that, every form in the message.
 *
 * A message naming exactly one person skips all of it and gives them every
 * form mentioned, however the message was laid out.
 */
export function parseRequests(input, options = {}) {
  const aliases = options.aliases ?? DEFAULT_FORM_ALIASES;
  const text = normalizeText(input);
  const lineOf = lineIndexer(text);
  const segmentOf = segmentIndexer(text);
  const clauseOf = clauseIndexer(text);

  const forms = findForms(text, aliases);
  for (const form of forms) {
    form.segment = segmentOf(form.index);
    form.clause = clauseOf(form.index);
  }

  // Take the forms out of the way before looking for names: "Довідка" and
  // "Форма" are capitalized words that would otherwise start a name run.
  let residue = text;
  for (const form of forms) residue = mask(residue, form.index, form.index + form.raw.length);

  // A parenthetical is a note about the person on that line ("(для
  // пенсійного)"), never part of their name.
  const notes = [...residue.matchAll(/\(([^)\n]{1,120})\)/gu)].map((match) => ({
    text: match[1].trim(),
    line: lineOf(match.index),
    segment: segmentOf(match.index),
  }));
  for (const match of [...residue.matchAll(/\([^)\n]{1,120}\)/gu)].reverse()) {
    residue = mask(residue, match.index, match.index + match[0].length);
  }

  const people = findPeople(residue);
  for (const person of people) {
    person.segment = segmentOf(person.index);
    person.clause = clauseOf(person.index);
  }

  // A comma-separated run with no name in it belongs to whoever is named in
  // the same clause: "потрібні ф5, ф12 на Костиря" splits at the comma, but the
  // ф5 is Костиря's just the same. Searching forward first matches how these
  // are written ("<forms> на <person>"), and staying inside the clause is what
  // stops "Костиря потрібно ф12, ф5; Жепяк потрібно ф6" from handing Костиря's
  // ф5 to Жепяк.
  for (const form of forms) {
    if (people.some((person) => person.segment === form.segment)) continue;
    const named = people.filter((person) => person.clause === form.clause);
    const owner = named.find((person) => person.index > form.index) ?? named[named.length - 1];
    if (owner) form.segment = owner.segment;
  }

  // The purpose is read with the names masked too, so "для суду на солдат
  // Іванов Іван Іванович" stops at "суду" instead of swallowing the person.
  let bare = residue;
  for (const person of people) bare = mask(bare, person.spanStart, person.endIndex);
  const purposes = [...bare.matchAll(PURPOSE)]
    .map((match) => ({
      text: cleanPurpose(match[1]),
      line: lineOf(match.index),
      segment: segmentOf(match.index),
    }))
    .filter((purpose) => purpose.text);
  const numbers = [...residue.matchAll(PERSONAL_NUMBER)].map((match) => ({
    text: match[1],
    line: lineOf(match.index),
    segment: segmentOf(match.index),
  }));

  // What was written about this person: their own clause first. The rest of
  // the line only counts when they are the only person on it -- otherwise one
  // person's note would be attributed to their neighbour as well.
  const attribute = (entries, person) => {
    const alone = people.filter((other) => other.line === person.line).length === 1;
    return (
      entries.find((entry) => entry.segment === person.segment)?.text ??
      (alone ? entries.find((entry) => entry.line === person.line)?.text ?? null : null)
    );
  };

  for (const person of people) {
    person.note = attribute(notes, person);
    person.purpose = attribute(purposes, person);
    person.personalNumber = attribute(numbers, person);
  }

  // When no clause said why, a single "для ..." anywhere in the message speaks
  // for everyone in it; when one clause did say, it speaks only for that one.
  if (purposes.length && !people.some((person) => person.purpose)) {
    for (const person of people) person.purpose = purposes[0].text;
  }

  // Forms on a line nobody is named on are a header -- but for the people
  // listed *under* that header, not for the whole message. A message can carry
  // several ("Ф5:" then a name, "Ф6:" then two more), and giving everybody
  // every header form files one ticket per person per form, which is what this
  // used to do. Consecutive header lines with nobody between them are one
  // header, so a list broken across two lines still speaks for the names below
  // it. A person with no header above them takes the first one below, which is
  // the only reading of a message that puts its forms last.
  const shared = forms.filter((form) => !people.some((person) => person.line === form.line));
  const headers = [];
  for (const form of shared) {
    const previous = headers[headers.length - 1];
    const interrupted =
      previous && people.some((person) => person.line > previous.line && person.line < form.line);
    if (!previous || interrupted) {
      headers.push({ line: form.line, forms: [form] });
    } else {
      previous.forms.push(form);
      previous.line = form.line;
    }
  }
  const headerFor = (person) => {
    const above = headers.filter((header) => header.line < person.line);
    return (above.length ? above[above.length - 1] : headers[0])?.forms ?? [];
  };

  const requests = people
    .map((person) => {
      const inSegment = forms.filter((form) => form.segment === person.segment);
      const onLine = forms.filter((form) => form.line === person.line);
      const header = headerFor(person);
      const chosen =
        people.length === 1
          ? forms
          : inSegment.length
            ? inSegment
            : onLine.length
              ? onLine
              : header.length
                ? header
                : forms;
      return { person, forms: uniqueForms(chosen) };
    })
    .filter((request) => request.forms.length > 0);

  const warnings = [];
  if (!forms.length) warnings.push('no certificate form recognised in the message');
  if (!people.length) warnings.push('no person recognised in the message');
  for (const person of people) {
    if (!requests.some((request) => request.person === person)) {
      warnings.push(`no form found for ${person.full}`);
    }
  }

  return {
    ok: requests.length > 0,
    text,
    people,
    forms,
    requests,
    pairs: requests.flatMap((request) => request.forms.map((form) => ({ person: request.person, form }))),
    purpose: purposes[0]?.text ?? null,
    warnings,
  };
}

/** Full name with the rank in front, the way the request was written. */
export function personLabel(person) {
  return [person?.rank, person?.full].filter(Boolean).join(' ');
}

/**
 * One line per person, for a reply or a ticket description. Whatever the
 * message said about that person -- why they need it, or the note written
 * beside their name -- is worth reading back to them in the acknowledgement.
 */
export function describeRequests(parsed) {
  return (parsed?.requests ?? [])
    .map((request) => {
      const forms = request.forms.map((form) => form.label).join(', ');
      const aside = request.person.purpose ?? request.person.note;
      return `${personLabel(request.person)} — ${forms}${aside ? ` (${aside})` : ''}`;
    })
    .join('\n');
}
