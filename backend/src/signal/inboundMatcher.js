/**
 * Pure matching + templating for inbound Signal rules. No DB, no HTTP --
 * see test/inboundMatcher.test.js.
 */
import { parseRequests, describeRequests, personLabel } from './naturalParser.js';

/** Only the flags that make sense for a single-message match. */
const ALLOWED_FLAGS = 'imsu';

export function sanitizeFlags(flags) {
  const seen = new Set();
  for (const ch of String(flags ?? '')) {
    if (ALLOWED_FLAGS.includes(ch)) seen.add(ch);
  }
  return [...seen].join('');
}

/**
 * Compiles a rule's pattern. Throws a readable error for a bad regex so the
 * API can reject it at save time rather than letting it fail silently on
 * every message forever.
 */
export function compilePattern(pattern, flags) {
  return new RegExp(pattern, sanitizeFlags(flags));
}

/**
 * The groups a rule is narrowed to, as a list of sendable group ids.
 *
 * Stored as a JSON array and handed out by the repository already parsed, so
 * both shapes are accepted here -- as is the pre-018 single `source_group_id`,
 * for a rule object built by hand. An unreadable blob reads as "no
 * restriction", the same as an empty list: the rule then behaves as it did
 * before anyone tried to narrow it, rather than matching nothing.
 */
export function groupIdsOf(rule) {
  const listed = rule?.source_group_ids ?? rule?.sourceGroupIds;
  if (listed !== undefined && listed !== null && listed !== '') {
    const list = typeof listed === 'string' ? parseJsonList(listed) : listed;
    if (Array.isArray(list)) return list.map((id) => String(id ?? '').trim()).filter(Boolean);
    return [];
  }
  const legacy = String(rule?.source_group_id ?? '').trim();
  return legacy ? [legacy] : [];
}

function parseJsonList(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/**
 * Does this rule apply to where the message came from?
 *
 * `source_group_ids` narrows *the group half* of a rule -- it is checked only
 * against messages that have a group, so "groups and direct messages" scoped
 * to two groups still receives direct messages. An empty list is no
 * restriction.
 */
export function matchesSource(rule, { isGroup, groupId }) {
  if (rule.source_scope === 'direct' && isGroup) return false;
  if (rule.source_scope === 'group' && !isGroup) return false;
  const groups = groupIdsOf(rule);
  if (isGroup && groups.length && !groups.includes(groupId)) return false;
  return true;
}

/**
 * Runs a rule's parser against the message text.
 *
 * Returns `null` for no match, or `{ match, groups }` where `groups` maps
 * both numbered (`1`, `2`, ...) and named (`(?<subject>...)`) capture groups
 * to their captured text. Those become `{1}` / `{subject}` template
 * variables in the rule's actions -- that is the whole point of letting the
 * admin write a regex rather than a keyword.
 */
export function matchRule(rule, input) {
  return evaluateRule(rule, input).result;
}

/**
 * The same decision, with a reason when the answer is no.
 *
 * Nothing in the live pipeline needs the reason -- a rule that does not match
 * simply does not run. `/process` does: replaying a message and being told
 * nothing at all is what made that command feel broken, and "did not parse as
 * a request" versus "is scoped to another group" are two completely different
 * things for the operator to go and fix. Returns `{ result, reason }`, where
 * `result` is what `matchRule` hands back and `reason` is a phrase that reads
 * as the tail of "rule X <reason>". Pure -- see test/inboundMatcher.test.js.
 */
export function evaluateRule(rule, { messageText, isGroup, groupId }) {
  const no = (reason) => ({ result: null, reason });

  if (rule.source_scope === 'direct' && isGroup) return no('only listens to direct messages');
  if (rule.source_scope === 'group' && !isGroup) return no('only listens to group messages');
  const allowedGroups = groupIdsOf(rule);
  if (isGroup && allowedGroups.length && !allowedGroups.includes(groupId)) {
    return no(allowedGroups.length === 1 ? 'is scoped to a different group' : 'is scoped to other groups');
  }

  const text = messageText ?? '';

  if (rule.match_type === 'any') {
    return { result: { match: text, groups: {} }, reason: null };
  }

  // The natural-language parser: no pattern at all, the rule matches when the
  // message turns out to *be* a certificate request. `parsed` rides along so
  // the handler can fan one message out into a work package per certificate.
  if (rule.match_type === 'natural') {
    const parsed = parseRequests(text);
    if (!parsed.ok) {
      const why = parsed.warnings.join('; ');
      return no(`did not read the message as a request${why ? ` (${why})` : ''}`);
    }
    return { result: { match: text, groups: naturalGroups(parsed), parsed }, reason: null };
  }

  if (rule.match_type === 'contains') {
    const needle = (rule.pattern ?? '').trim();
    if (!needle) return no('has no text to look for configured');
    const found = text.toLowerCase().includes(needle.toLowerCase());
    return found
      ? { result: { match: needle, groups: {} }, reason: null }
      : no(`is looking for "${needle}", which the message does not contain`);
  }

  // regex
  if (!rule.pattern) return no('has no pattern configured');
  const result = compilePattern(rule.pattern, rule.pattern_flags).exec(text);
  if (!result) return no('has a pattern that does not match the message');

  const groups = {};
  result.forEach((value, index) => {
    if (index > 0) groups[String(index)] = value ?? '';
  });
  for (const [name, value] of Object.entries(result.groups ?? {})) {
    groups[name] = value ?? '';
  }
  return { result: { match: result[0], groups }, reason: null };
}

/**
 * Message-wide variables from a parsed natural request. These describe the
 * whole message, so a reply or a reaction -- which happen once however many
 * certificates were asked for -- can talk about all of it.
 */
export function naturalGroups(parsed) {
  const forms = [...new Set(parsed.forms.map((form) => form.label))];
  return {
    people: parsed.requests.map((request) => request.person.full).join(', '),
    people_count: String(parsed.requests.length),
    forms: forms.join(', '),
    forms_count: String(forms.length),
    tickets_count: String(parsed.pairs.length),
    summary: describeRequests(parsed),
    purpose: parsed.purpose ?? '',
  };
}

/**
 * One variable map per work package a natural match should produce.
 *
 * `pair` (the default) files one certificate per ticket, which is how the
 * office actually works through them -- "ф5 та ф12 на Іванов" is two documents
 * to produce, and OpenProject's "Тип довідки" holds one value. `person` files
 * one ticket listing everything that person asked for, for a type whose form
 * field takes several values. `message` keeps the whole message as one ticket.
 *
 * Returns `[]` when there is nothing to fan out, meaning "run the action once
 * with the message-wide context".
 */
export function naturalItems(parsed, mode = 'pair') {
  if (!parsed || mode === 'message') return [];

  if (mode === 'person') {
    return parsed.requests.map((request, index) => ({
      ...personVariables(request.person, parsed),
      form: request.forms[0]?.label ?? '',
      form_code: request.forms[0]?.code ?? '',
      form_number: request.forms[0]?.number ?? '',
      forms: request.forms.map((form) => form.label).join(', '),
      forms_count: String(request.forms.length),
      index: String(index + 1),
      total: String(parsed.requests.length),
    }));
  }

  return parsed.pairs.map((pair, index) => ({
    ...personVariables(pair.person, parsed),
    form: pair.form.label,
    form_code: pair.form.code,
    form_number: pair.form.number ?? '',
    form_raw: pair.form.raw,
    forms: pair.form.label,
    forms_count: '1',
    index: String(index + 1),
    total: String(parsed.pairs.length),
  }));
}

/** The message-wide purpose applies to everyone it doesn't name explicitly. */
function personVariables(person, parsed) {
  return {
    person: person.full,
    person_rank: personLabel(person),
    // The name as the message spelled it, for a reply that should echo the
    // sender's own words rather than the tidied-up nominative.
    person_as_written: person.writtenAs ?? person.full,
    rank: person.rank ?? '',
    surname: person.surname ?? '',
    given: person.given ?? '',
    patronymic: person.patronymic ?? '',
    note: person.note ?? '',
    purpose: person.purpose ?? parsed.purpose ?? '',
    personal_number: person.personalNumber ?? '',
  };
}

/**
 * Variables available to every action template on a matched rule.
 * Capture groups are merged in last so a rule author can name a group
 * `sender` and deliberately shadow the built-in.
 */
export function buildTemplateContext(normalized, matchResult) {
  const text = normalized.messageText ?? '';
  const [firstLine, ...restLines] = text.split(/\r?\n/);
  return {
    message: text,
    match: matchResult?.match ?? '',
    // The message minus whatever the pattern matched -- the usual "everything
    // after the !command prefix" payload, without every rule needing a
    // capture group for it.
    rest: matchResult?.match ? text.replace(matchResult.match, '').trim() : text,
    first_line: (firstLine ?? '').trim(),
    body: restLines.join('\n').trim(),
    sender: normalized.senderName || normalized.senderNumber || 'unknown',
    sender_name: normalized.senderName ?? '',
    sender_number: normalized.senderNumber ?? '',
    group: normalized.groupName || normalized.groupId || '',
    group_name: normalized.groupName ?? '',
    date: new Date(normalized.timestamp ?? Date.now()).toISOString(),
    ...(matchResult?.groups ?? {}),
  };
}

/**
 * `{var}` substitution, plus an optional `{var|filter}` to transform the
 * value before it's inserted. An unknown variable renders empty rather than
 * leaving the literal `{var}` in a message sent to a real person.
 *
 * `urlencode` exists because a description/message template routinely builds
 * a link out of a variable (a name, a subject) for a lookup tool hosted
 * alongside OpenProject -- e.g. `{base_url}/search?q={person|urlencode}` --
 * and a ПІБ containing spaces or Cyrillic breaks that link unless it's
 * percent-encoded first. `+` for space matches how a browser encodes a query
 * string (`encodeURIComponent` alone would leave literal spaces as `%20`).
 */
export function renderTemplate(template, context) {
  if (!template) return '';
  return template.replace(/\{(\w+)(?:\|(\w+))?\}/g, (_, key, filter) => {
    const value = context[key] === undefined || context[key] === null ? '' : String(context[key]);
    return applyTemplateFilter(value, filter);
  });
}

function applyTemplateFilter(value, filter) {
  switch (filter) {
    case 'urlencode':
      return encodeURIComponent(value).replace(/%20/g, '+');
    default:
      return value;
  }
}
