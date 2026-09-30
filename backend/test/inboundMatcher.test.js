import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRule,
  evaluateRule,
  matchesSource,
  buildTemplateContext,
  renderTemplate,
  sanitizeFlags,
  compilePattern,
  naturalItems,
} from '../src/signal/inboundMatcher.js';

const regexRule = (overrides = {}) => ({
  match_type: 'regex',
  pattern: String.raw`^!task\s+(.+)$`,
  pattern_flags: 'i',
  source_scope: 'any',
  source_group_ids: null,
  ...overrides,
});

const inGroup = { isGroup: true, groupId: 'group.abc' };

test('regex rule matches and exposes numbered capture groups', () => {
  const result = matchRule(regexRule(), { messageText: '!task Fix the printer', ...inGroup });
  assert.equal(result.match, '!task Fix the printer');
  assert.equal(result.groups['1'], 'Fix the printer');
});

test('named capture groups become template variables', () => {
  const rule = regexRule({ pattern: String.raw`^!bug\s+(?<subject>[^\n]+)\n?(?<body>[\s\S]*)$` });
  const result = matchRule(rule, { messageText: '!bug Printer jams\nHappens every morning', ...inGroup });
  assert.equal(result.groups.subject, 'Printer jams');
  assert.equal(result.groups.body, 'Happens every morning');
});

test('regex flags are honoured and case-insensitivity is the default', () => {
  assert.ok(matchRule(regexRule(), { messageText: '!TASK shout', ...inGroup }));
  assert.equal(matchRule(regexRule({ pattern_flags: '' }), { messageText: '!TASK shout', ...inGroup }), null);
});

test('sanitizeFlags drops flags that would break single-message matching', () => {
  // `g` makes exec() stateful across calls, which would make a rule match
  // every other message.
  assert.equal(sanitizeFlags('gimy'), 'im');
  assert.equal(sanitizeFlags('iiii'), 'i');
});

test('invalid regex throws at compile time so the API can reject it', () => {
  assert.throws(() => compilePattern('([unclosed', 'i'));
});

test('contains matching is case-insensitive and needs no escaping', () => {
  const rule = regexRule({ match_type: 'contains', pattern: 'help me' });
  assert.ok(matchRule(rule, { messageText: 'Please HELP ME with this', ...inGroup }));
  assert.equal(matchRule(rule, { messageText: 'nothing here', ...inGroup }), null);
});

test('"any" matches every message, which is how a catch-all rule is built', () => {
  const rule = regexRule({ match_type: 'any', pattern: null });
  assert.ok(matchRule(rule, { messageText: 'literally anything', ...inGroup }));
});

test('source scope separates group messages from direct messages', () => {
  const groupOnly = { source_scope: 'group', source_group_ids: null };
  const directOnly = { source_scope: 'direct', source_group_ids: null };
  assert.equal(matchesSource(groupOnly, { isGroup: true, groupId: 'group.abc' }), true);
  assert.equal(matchesSource(groupOnly, { isGroup: false, groupId: null }), false);
  assert.equal(matchesSource(directOnly, { isGroup: false, groupId: null }), true);
  assert.equal(matchesSource(directOnly, { isGroup: true, groupId: 'group.abc' }), false);
});

test('a rule can be pinned to specific groups', () => {
  const rule = regexRule({ source_scope: 'group', source_group_ids: ['group.abc', 'group.two'] });
  assert.ok(matchRule(rule, { messageText: '!task one', isGroup: true, groupId: 'group.abc' }));
  assert.ok(matchRule(rule, { messageText: '!task one', isGroup: true, groupId: 'group.two' }));
  assert.equal(matchRule(rule, { messageText: '!task one', isGroup: true, groupId: 'group.other' }), null);
});

test('the group list is read from JSON as stored, and a bad blob narrows nothing', () => {
  const stored = regexRule({ source_scope: 'group', source_group_ids: '["group.abc"]' });
  assert.ok(matchRule(stored, { messageText: '!task one', isGroup: true, groupId: 'group.abc' }));
  assert.equal(matchRule(stored, { messageText: '!task one', isGroup: true, groupId: 'group.other' }), null);

  const broken = regexRule({ source_scope: 'group', source_group_ids: 'not json' });
  assert.ok(matchRule(broken, { messageText: '!task one', isGroup: true, groupId: 'group.other' }));
});

test('a group list narrows the group half only, leaving direct messages alone', () => {
  const rule = regexRule({ source_scope: 'any', source_group_ids: ['group.abc'] });
  assert.ok(matchRule(rule, { messageText: '!task one', isGroup: false, groupId: null }));
  assert.ok(matchRule(rule, { messageText: '!task one', isGroup: true, groupId: 'group.abc' }));
  assert.equal(matchRule(rule, { messageText: '!task one', isGroup: true, groupId: 'group.other' }), null);
});

test('{rest} is the message minus the matched pattern', () => {
  const rule = regexRule({ pattern: String.raw`^!task\s*` });
  const matched = matchRule(rule, { messageText: '!task Order more paper', ...inGroup });
  const context = buildTemplateContext({ messageText: '!task Order more paper', timestamp: 0 }, matched);
  assert.equal(context.rest, 'Order more paper');
});

test('renderTemplate substitutes built-ins and captures, and blanks unknowns', () => {
  const matched = matchRule(regexRule(), { messageText: '!task Fix the printer', ...inGroup });
  const context = buildTemplateContext(
    {
      messageText: '!task Fix the printer',
      senderName: 'Ann',
      senderNumber: '+15550001111',
      groupName: 'Ops',
      timestamp: 0,
    },
    matched
  );
  assert.equal(renderTemplate('[{group_name}] {1} — {sender}', context), '[Ops] Fix the printer — Ann');
  assert.equal(renderTemplate('x{nope}y', context), 'xy');
});

test('a |urlencode filter percent-encodes a variable for safe use in a URL', () => {
  const context = { person: 'Іванов Іван Іванович', plain: 'no-encoding-needed', base_url: 'http://host' };
  assert.equal(
    renderTemplate('{base_url}/search?q={person|urlencode}', context),
    'http://host/search?q=%D0%86%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2+%D0%86%D0%B2%D0%B0%D0%BD+%D0%86%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2%D0%B8%D1%87'
  );
  assert.equal(renderTemplate('{plain|urlencode}', context), 'no-encoding-needed');
  // An unknown filter name is not silently swallowed into blanking the value.
  assert.equal(renderTemplate('{plain|nope}', context), 'no-encoding-needed');
});

test('a capture group may deliberately shadow a built-in variable', () => {
  const rule = regexRule({ pattern: String.raw`^!as (?<sender>\w+): (?<message>.+)$` });
  const matched = matchRule(rule, { messageText: '!as bob: hello', ...inGroup });
  const context = buildTemplateContext({ messageText: '!as bob: hello', senderName: 'Ann', timestamp: 0 }, matched);
  assert.equal(renderTemplate('{sender}/{message}', context), 'bob/hello');
});

// --- natural-language rules ------------------------------------------------

const naturalRule = (overrides = {}) => ({
  match_type: 'natural',
  pattern: null,
  pattern_flags: 'i',
  source_scope: 'any',
  source_group_ids: null,
  ...overrides,
});

test('a natural rule matches a message that parses as a certificate request', () => {
  const result = matchRule(naturalRule(), {
    messageText: 'Потрібна ф5 та ф12 на майор Іванов Іван Іванович',
    ...inGroup,
  });
  assert.equal(result.groups.people, 'Іванов Іван Іванович');
  assert.equal(result.groups.forms, 'Форма 5, Форма 12');
  assert.equal(result.groups.tickets_count, '2');
  assert.equal(result.groups.summary, 'майор Іванов Іван Іванович — Форма 5, Форма 12');
});

test('a natural rule does not match ordinary chatter, so a fallback rule can', () => {
  assert.equal(matchRule(naturalRule(), { messageText: 'Добрий день, коли обід?', ...inGroup }), null);
  // A name with no form is a message about somebody, not a request.
  assert.equal(matchRule(naturalRule(), { messageText: 'Іванов Іван Іванович', ...inGroup }), null);
});

test('a natural rule ignores its source scope no differently from any other', () => {
  const rule = naturalRule({ source_scope: 'direct' });
  assert.equal(matchRule(rule, { messageText: 'ф5 на Іванов Іван Іванович', ...inGroup }), null);
});

test('fan-out "pair" gives one variable set per certificate', () => {
  const matched = matchRule(naturalRule(), {
    messageText: 'ф5 та ф12 на:\nІванов Іван Іванович\nПетренко Петро Петрович',
    ...inGroup,
  });
  const items = naturalItems(matched.parsed, 'pair');
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((item) => `${item.person}/${item.form}`),
    [
      'Іванов Іван Іванович/Форма 5',
      'Іванов Іван Іванович/Форма 12',
      'Петренко Петро Петрович/Форма 5',
      'Петренко Петро Петрович/Форма 12',
    ]
  );
  assert.equal(items[0].total, '4');
});

test('fan-out "person" gives one variable set per person, listing their forms', () => {
  const matched = matchRule(naturalRule(), {
    messageText: 'ф5 та ф12 на:\nІванов Іван Іванович\nПетренко Петро Петрович',
    ...inGroup,
  });
  const items = naturalItems(matched.parsed, 'person');
  assert.equal(items.length, 2);
  assert.equal(items[0].forms, 'Форма 5, Форма 12');
  assert.equal(items[0].surname, 'Іванов');
});

test('fan-out "message" does not fan out at all', () => {
  const matched = matchRule(naturalRule(), { messageText: 'ф5 на Іванов Іван Іванович', ...inGroup });
  assert.deepEqual(naturalItems(matched.parsed, 'message'), []);
});

test('item variables render into an action template', () => {
  const matched = matchRule(naturalRule(), {
    messageText: 'молодший сержант Іванов Іван Іванович потрібно ф12 для суду',
    ...inGroup,
  });
  const base = buildTemplateContext({ messageText: 'x', senderName: 'Ann', timestamp: 0 }, matched);
  const [item] = naturalItems(matched.parsed, 'pair');
  assert.equal(
    renderTemplate('{form} — {person_rank} ({purpose})', { ...base, ...item }),
    'Форма 12 — молодший сержант Іванов Іван Іванович (суду)'
  );
});

// --- why a rule did not match ------------------------------------------
// Only /process reads these, and only to tell the operator what to go and fix.

test('a rule scoped to another group says so', () => {
  const rule = { ...regexRule(), source_scope: 'group', source_group_ids: ['group.other'] };
  const verdict = evaluateRule(rule, { messageText: '!task x', isGroup: true, groupId: 'group.here' });
  assert.equal(verdict.result, null);
  assert.match(verdict.reason, /scoped to a different group/u);
});

test('a rule scoped to several other groups says so in the plural', () => {
  const rule = { ...regexRule(), source_scope: 'any', source_group_ids: ['group.a', 'group.b'] };
  const verdict = evaluateRule(rule, { messageText: '!task x', isGroup: true, groupId: 'group.here' });
  assert.equal(verdict.result, null);
  assert.match(verdict.reason, /scoped to other groups/u);
});

test('a pattern that simply did not match says so', () => {
  const verdict = evaluateRule(regexRule(), { messageText: 'привіт', isGroup: false, groupId: null });
  assert.match(verdict.reason, /pattern that does not match/u);
});

test('a contains rule quotes the text it was looking for', () => {
  const rule = { match_type: 'contains', pattern: 'довідка', source_scope: 'any' };
  const verdict = evaluateRule(rule, { messageText: 'привіт', isGroup: false, groupId: null });
  assert.match(verdict.reason, /"довідка"/u);
});

test('a natural rule reports what the parser could not find', () => {
  const rule = { match_type: 'natural', pattern: null, source_scope: 'any' };
  const verdict = evaluateRule(rule, { messageText: 'привіт усім', isGroup: false, groupId: null });
  assert.match(verdict.reason, /no certificate form recognised/u);
});

test('a match carries no reason, and matchRule still returns just the result', () => {
  const input = { messageText: '!task буд', isGroup: false, groupId: null };
  const verdict = evaluateRule(regexRule(), input);
  assert.equal(verdict.reason, null);
  assert.deepEqual(matchRule(regexRule(), input), verdict.result);
});
