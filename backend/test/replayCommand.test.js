import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import {
  parseReplayCommand,
  isReplayCommand,
  matchByName,
  sameNumber,
  isAuthorized,
  isReplayRequest,
  replayGroupId,
  forwarderAsAuthor,
  resolveAuthor,
  buildReplayContext,
  formatReplayReport,
} from '../src/signal/replayCommand.js';

// --- parsing -----------------------------------------------------------

test('parses the author and the body below the command line', () => {
  const parsed = parseReplayCommand('/process Петренко Олег\nпотрібно довідка ф12 на Іванов Іван Іванович');
  assert.equal(parsed.author, 'Петренко Олег');
  assert.equal(parsed.body, 'потрібно довідка ф12 на Іванов Іван Іванович');
});

test('a forward marker above the command is ignored', () => {
  // This is the shape Signal actually produces when a message is forwarded
  // with a note: the client's own marker lands above what the operator typed.
  const parsed = parseReplayCommand('~Forwarded message\n/process Петренко\nдовідка ф5 на Жепяк Назар Васильович');
  assert.equal(parsed.author, 'Петренко');
  assert.equal(parsed.body, 'довідка ф5 на Жепяк Назар Васильович');
});

test('the author is optional', () => {
  const parsed = parseReplayCommand('/process\nдовідка ф5');
  assert.equal(parsed.author, '');
  assert.equal(parsed.body, 'довідка ф5');
});

test('a multi-line body is kept whole', () => {
  const parsed = parseReplayCommand('/process Петренко\nрядок один\nрядок два');
  assert.equal(parsed.body, 'рядок один\nрядок два');
});

test('/trigger is accepted as an alias', () => {
  assert.ok(isReplayCommand('/trigger Петренко\nдовідка ф5'));
});

test('an ordinary message is not a command', () => {
  assert.equal(parseReplayCommand('потрібно довідка ф12 на Іванов Іван Іванович'), null);
  assert.equal(isReplayCommand('процес виконання'), false);
  // A message that merely mentions the word must not trigger a replay.
  assert.equal(isReplayCommand('треба /processing запустити'), false);
});

// --- name matching -----------------------------------------------------

const contacts = [
  { name: 'Петренко Олег Іванович', id: 1 },
  { name: 'Петренко Марія Степанівна', id: 2 },
  { name: 'Жепяк Назар Васильович', id: 3 },
];

test('an exact name wins outright', () => {
  assert.equal(matchByName(contacts, 'Жепяк Назар Васильович').match.id, 3);
});

test('a surname alone resolves when only one person has it', () => {
  assert.equal(matchByName(contacts, 'Жепяк').match.id, 3);
});

test('name matching is case- and whitespace-insensitive', () => {
  assert.equal(matchByName(contacts, '  жепяк   назар васильович ').match.id, 3);
});

test('an ambiguous surname matches nobody and reports the candidates', () => {
  // Filing a request against the wrong Петренко is exactly the failure this
  // command must not have, so ambiguity is an error rather than a guess.
  const result = matchByName(contacts, 'Петренко');
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 2);
});

test('an unknown name matches nothing', () => {
  assert.equal(matchByName(contacts, 'Коваленко').match, null);
  assert.equal(matchByName(contacts, '').match, null);
});

// --- authorization -----------------------------------------------------

test('numbers compare regardless of how they are written', () => {
  assert.ok(sameNumber('+380 99 607 50 27', '380996075027'));
  assert.ok(sameNumber('+380-99-607-50-27', '+380996075027'));
  assert.equal(sameNumber('+380996075027', '+380991112233'), false);
  assert.equal(sameNumber('', '+380996075027'), false);
});

function seedRule(db, { approvalRecipient }) {
  db.prepare(
    `INSERT INTO inbound_rules (name, match_type, pattern, source_scope, enabled, priority)
     VALUES ('replay test', 'natural', NULL, 'group', 1, 0)`
  ).run();
  const ruleId = db.prepare('SELECT id FROM inbound_rules ORDER BY id DESC LIMIT 1').get().id;
  db.prepare(
    `INSERT INTO inbound_rule_actions (rule_id, action_type, position, approval_recipient)
     VALUES (?, 'create_ticket', 0, ?)`
  ).run(ruleId, approvalRecipient);
  return ruleId;
}

test('only an approval recipient may replay', () => {
  const db = createTestDb();
  seedRule(db, { approvalRecipient: '+380996075027' });

  assert.ok(isAuthorized(db, '+380996075027'));
  assert.ok(isAuthorized(db, '380996075027'), 'the same number written without a +');
  assert.equal(isAuthorized(db, '+380991112233'), false);
  assert.equal(isAuthorized(db, null), false);
});

test('with no approval recipient configured, nobody may replay', () => {
  const db = createTestDb();
  seedRule(db, { approvalRecipient: null });
  assert.equal(isAuthorized(db, '+380996075027'), false);
});

test('an unauthorized sender\'s message is not swallowed as a command', () => {
  const db = createTestDb();
  seedRule(db, { approvalRecipient: '+380996075027' });

  // It reads as a command, but this sender may not run one -- so it must fall
  // through to ordinary rule processing rather than disappear.
  assert.equal(
    isReplayRequest(db, { messageText: '/process Петренко\nдовідка ф5', senderNumber: '+380991112233' }),
    false
  );
  assert.equal(
    isReplayRequest(db, { messageText: '/process Петренко\nдовідка ф5', senderNumber: '+380996075027' }),
    true
  );
  assert.equal(
    isReplayRequest(db, { messageText: 'звичайне повідомлення', senderNumber: '+380996075027' }),
    false
  );
});

// --- group resolution --------------------------------------------------

function seedSubscription(db, { groupId, enabled = 1 }) {
  db.prepare(
    `INSERT INTO signal_group_subscriptions (group_id, internal_id, name, enabled)
     VALUES (?, ?, ?, ?)`
  ).run(groupId, groupId.replace('group.', ''), `name of ${groupId}`, enabled);
}

test('a single enabled subscription is used with no configuration at all', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  assert.equal(replayGroupId(db, { default_replay_group_id: null }), 'group.abc');
});

test('several subscriptions are ambiguous, so nothing is assumed', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  seedSubscription(db, { groupId: 'group.def' });
  assert.equal(replayGroupId(db, { default_replay_group_id: null }), null);
});

test('a disabled subscription does not count towards the single-group case', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  seedSubscription(db, { groupId: 'group.def', enabled: 0 });
  assert.equal(replayGroupId(db, { default_replay_group_id: null }), 'group.abc');
});

test('run in a subscribed group, the command means that conversation', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  seedSubscription(db, { groupId: 'group.def' });
  // The envelope carries the internal id; the sendable one comes back.
  assert.equal(replayGroupId(db, { default_replay_group_id: 'group.zzz' }, 'def'), 'group.def');
  assert.equal(replayGroupId(db, { default_replay_group_id: 'group.zzz' }, 'group.def'), 'group.def');
});

test('a group nobody subscribed to does not replace the configured one', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  assert.equal(replayGroupId(db, { default_replay_group_id: 'group.zzz' }, 'group.other'), 'group.zzz');
});

// --- the report back to the operator -----------------------------------

test('a successful replay names the rule and every ticket it filed', () => {
  const report = {
    matched: ['Запит на довідку'],
    skipped: [],
    actions: [
      { type: 'create_ticket', ok: true, workPackageId: 101, subject: 'Форма 5' },
      { type: 'create_ticket', ok: true, workPackageId: 102, subject: 'Форма 6' },
      { type: 'send_message', ok: true },
    ],
    held: [],
  };
  const text = formatReplayReport(report, { groupId: 'group.abc' });
  assert.match(text, /Matched rule/u);
  assert.match(text, /#101/u);
  assert.match(text, /#102/u);
  assert.match(text, /Reply sent/u);
});

test('a failed action says what broke instead of going quiet', () => {
  const text = formatReplayReport(
    {
      matched: ['rule'],
      actions: [{ type: 'create_ticket', ok: false, error: 'OpenProject type requires "Тип" (customField1)' }],
    },
    { groupId: 'group.abc' }
  );
  assert.match(text, /create_ticket failed/u);
  assert.match(text, /customField1/u);
});

test('actions held for review are reported as held, not as done', () => {
  const text = formatReplayReport(
    { matched: ['rule'], actions: [], held: [{ rule: 'rule', recipient: '+380996075027', count: 3 }] },
    { groupId: 'group.abc' }
  );
  assert.match(text, /3 ticket\(s\) held for review/u);
  assert.match(text, /\+380996075027/u);
});

test('when no rule matched, every rule says why it passed', () => {
  const text = formatReplayReport(
    {
      matched: [],
      skipped: [
        { rule: 'Довідка', reason: 'is scoped to a different group' },
        { rule: 'catch-all', reason: 'has a pattern that does not match the message' },
      ],
      actions: [],
      held: [],
    },
    { groupId: 'group.abc' }
  );
  assert.match(text, /No inbound rule matched/u);
  assert.match(text, /is scoped to a different group/u);
  assert.match(text, /has a pattern that does not match/u);
  // The group was fine, so the group hint must not be offered as the cause.
  assert.doesNotMatch(text, /Group for replayed messages/u);
});

test('a replay with no group says so, since that is usually the reason', () => {
  const text = formatReplayReport(
    { matched: [], skipped: [{ rule: 'r', reason: 'only listens to group messages' }], actions: [], held: [] },
    { groupId: null }
  );
  assert.match(text, /Group for replayed messages/u);
});

test('a report on an install with no enabled rules says that plainly', () => {
  const text = formatReplayReport({ matched: [], skipped: [], actions: [], held: [] }, { groupId: 'group.abc' });
  assert.match(text, /no enabled inbound rules/u);
});

test('the configured group wins over the subscription list', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });
  assert.equal(replayGroupId(db, { default_replay_group_id: 'group.zzz' }), 'group.zzz');
});

// --- author resolution -------------------------------------------------

function seedContact(db, { name, phone, openprojectUserId = null }) {
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, openproject_user_id)
     VALUES (?, 'individual', ?, ?)`
  ).run(name, phone, openprojectUserId);
}

test('a resolved contact carries both its Signal number and its OpenProject id', async () => {
  const db = createTestDb();
  seedContact(db, { name: 'Жепяк Назар Васильович', phone: '+380991112233', openprojectUserId: 42 });

  const author = await resolveAuthor(db, 'Жепяк');
  assert.equal(author.senderNumber, '+380991112233');
  assert.equal(author.openprojectUserId, 42);
  assert.equal(author.source, 'contact');
});

test('an ambiguous author is rejected rather than guessed', async () => {
  const db = createTestDb();
  seedContact(db, { name: 'Петренко Олег', phone: '+380991112233' });
  seedContact(db, { name: 'Петренко Марія', phone: '+380994445566' });

  await assert.rejects(() => resolveAuthor(db, 'Петренко'), /matches several contacts/);
});

test('an unknown author is an error, not a silent fallback to the forwarder', async () => {
  const db = createTestDb();
  seedContact(db, { name: 'Жепяк Назар', phone: '+380991112233' });
  // OpenProject is unconfigured here, so the user-list fallback yields nothing.
  await assert.rejects(() => resolveAuthor(db, 'Коваленко'), /no contact or OpenProject user matches/);
});

test('omitting the author attributes the replay to the forwarder', () => {
  const db = createTestDb();
  seedContact(db, { name: 'Петренко Олег', phone: '+380996075027', openprojectUserId: 7 });

  const author = forwarderAsAuthor(db, { senderNumber: '+380996075027', senderName: 'Oleh' });
  assert.equal(author.source, 'forwarder');
  assert.equal(author.senderNumber, '+380996075027');
  assert.equal(author.openprojectUserId, 7, 'the forwarder is still attributed properly in OpenProject');
  assert.equal(author.senderName, 'Петренко Олег', 'the contact name beats the Signal profile name');
});

// --- the synthetic envelope --------------------------------------------

test('the replay context presents the named author as the sender', () => {
  const db = createTestDb();
  seedSubscription(db, { groupId: 'group.abc' });

  const context = buildReplayContext(
    db,
    { default_replay_group_id: null },
    {
      senderNumber: '+380996075027',
      senderUuid: 'uuid-of-operator',
      senderName: 'Operator',
      messageText: '/process Жепяк\nдовідка ф5',
      timestamp: 1700000000000,
      groupId: null,
    },
    {
      author: {
        senderNumber: '+380991112233',
        senderName: 'Жепяк Назар Васильович',
        openprojectUserId: 42,
        source: 'contact',
      },
      body: 'довідка ф5',
    }
  );

  // The whole point: everything downstream reads these, so the pipeline
  // behaves as though the original person had sent the message.
  assert.equal(context.senderNumber, '+380991112233');
  assert.equal(context.senderName, 'Жепяк Назар Васильович');
  assert.equal(context.authorUserId, 42);
  assert.equal(context.messageText, 'довідка ф5', 'the command line is stripped');
  assert.equal(context.groupId, 'group.abc', 'a DM replay still looks like it came from the group');
  assert.equal(context.groupName, 'name of group.abc');
  assert.equal(context.isReplay, true);
  assert.equal(context.replayedBy, '+380996075027', 'who actually ran the command is kept for the audit trail');
  assert.equal(context.senderUuid, null, 'the operator uuid must not leak through as the author');
});
