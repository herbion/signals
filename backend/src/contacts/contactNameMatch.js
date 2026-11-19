import { RANKS } from '../signal/naturalParser.js';

/**
 * Finds the contact a free-text person name refers to -- "🎯На кого" on a
 * Довідка holds a ПІБ ("Іванов Іван Іванович"), not an OpenProject user, so
 * the only way from it to a Signal number is the contact's own name.
 *
 * This is a guess about a real person, and a wrong guess sends someone else's
 * certificate news to them, so it is deliberately strict:
 *
 * - Every word of the contact's name has to appear in the field, in any order
 *   ("Іван Іванов" matches "Іванов Іван Іванович"; word order differs between
 *   an OpenProject display name and a ПІБ). A one-word contact name never
 *   matches -- "Іван" alone names half the unit.
 * - Rank words are ignored on both sides, so neither "сержант Іванов Іван" as a
 *   contact name nor a rank left in the field gets in the way.
 * - Contacts whose name equals the field (same set of words) win over those
 *   whose name is only contained in it.
 * - More than one person left after that is an error naming the candidates,
 *   never a pick. Several contacts sharing one Signal number are one person.
 *
 * Returns `{ contact }` or `{ error }` rather than throwing, so a caller can
 * word its own failure.
 */
export function matchContactByName(contacts, rawName) {
  const fieldWords = nameWords(rawName);
  if (fieldWords.length === 0) return { error: 'the name is empty' };
  const fieldSet = new Set(fieldWords);

  const exact = [];
  const contained = [];
  for (const contact of contacts ?? []) {
    if (contact.type && contact.type !== 'individual') continue;
    if (!contact.signal_identifier) continue;
    const words = [...new Set(nameWords(contact.name))];
    if (words.length < 2) continue;
    if (!words.every((word) => fieldSet.has(word))) continue;
    (words.length === fieldSet.size ? exact : contained).push(contact);
  }

  const candidates = exact.length ? exact : contained;
  const people = new Map();
  for (const contact of candidates) {
    if (!people.has(contact.signal_identifier)) people.set(contact.signal_identifier, contact);
  }

  if (people.size === 0) return { error: `no contact's name matches "${String(rawName).trim()}"` };
  if (people.size > 1) {
    const names = [...people.values()].map((c) => `"${c.name}"`).join(', ');
    return { error: `"${String(rawName).trim()}" matches more than one contact (${names}) — not guessing` };
  }
  return { contact: [...people.values()][0] };
}

const RANK_WORDS = new Set(RANKS.flatMap((rank) => rank.split(' ')));

/**
 * Lower-cased name words with apostrophe variants unified and punctuation
 * dropped. Hyphens stay inside a word (double surnames, "майстер-сержант").
 */
export function nameWords(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’ʼ`′]/g, "'")
    .split(/[^\p{L}'-]+/u)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter((word) => word && !RANK_WORDS.has(word));
}
