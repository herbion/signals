import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { matchContactByName, nameWords } from '../src/contacts/contactNameMatch.js';
import { processChangeEvent, resolveRecipient, isDynamicRelation } from '../src/rules/ruleProcessor.js';
import { processWebhookEvent } from '../src/diff/diffEngine.js';
import * as rulesRepo from '../src/rules/rules.repository.js';
import { createTestDb } from './testDb.js';

// ------------------------------------------------------------ name matching

const person = (id, name, signal_identifier = `+38050000000${id}`, type = 'individual') => ({
  id,
  name,
  type,
  signal_identifier,
});

test('a contact matches a ПІБ in any word order, patronymic not required', () => {
  const contacts = [person(1, 'Іван Іванов'), person(2, 'Петро Петренко')];
  assert.equal(matchContactByName(contacts, 'Іванов Іван Іванович').contact.id, 1);
});

test('ranks are ignored on both sides', () => {
  const contacts = [person(1, 'сержант Іванов Іван')];
  assert.equal(matchContactByName(contacts, 'Іванов Іван Іванович').contact.id, 1);
  assert.equal(matchContactByName([person(2, 'Іванов Іван')], 'молодший сержант Іванов Іван').contact.id, 2);
});

test('case and apostrophe variants do not matter', () => {
  const contacts = [person(1, "Дем'янчук Ольга")];
  assert.equal(matchContactByName(contacts, 'ДЕМʼЯНЧУК ОЛЬГА ПЕТРІВНА').contact.id, 1);
  assert.deepEqual(nameWords('Дем’янчук  Ольга'), ["дем'янчук", 'ольга']);
});

test('a one-word contact name never matches -- "Іван" names half the unit', () => {
  const result = matchContactByName([person(1, 'Іван')], 'Іванов Іван Іванович');
  assert.equal(result.contact, undefined);
  assert.match(result.error, /no contact's name matches/);
});

test('a contact whose words are not all in the field does not match', () => {
  const result = matchContactByName([person(1, 'Іван Петренко')], 'Іванов Іван Іванович');
  assert.equal(result.contact, undefined);
});

test('two different people matching is an error naming both, not a guess', () => {
  const contacts = [person(1, 'Іванов Іван'), person(2, 'Іван Іванович')];
  const result = matchContactByName(contacts, 'Іванов Іван Іванович');
  assert.equal(result.contact, undefined);
  assert.match(result.error, /more than one contact/);
  assert.match(result.error, /Іванов Іван/);
  assert.match(result.error, /Іван Іванович/);
});

test('a full-name match wins over a contact whose name is only contained in it', () => {
  const contacts = [person(1, 'Іванов Іван'), person(2, 'Іванов Іван Іванович')];
  assert.equal(matchContactByName(contacts, 'Іванов Іван Іванович').contact.id, 2);
});

test('duplicate contacts sharing one number are one person', () => {
  const contacts = [person(1, 'Іванов Іван', '+380501112233'), person(2, 'Іван Іванов', '+380501112233')];
  assert.equal(matchContactByName(contacts, 'Іванов Іван Іванович').contact.signal_identifier, '+380501112233');
});

test('group contacts are never a person', () => {
  const result = matchContactByName([person(1, 'Іванов Іван', 'group.abc', 'group')], 'Іванов Іван Іванович');
  assert.equal(result.contact, undefined);
});

// ------------------------------------------------------- recipient resolution

function setup({ groupingEnabled = 0, apiKey = 'secret' } = {}) {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO signal_settings (id, signal_api_base_url, bot_number, grouping_enabled)
     VALUES (1, 'http://signal-api:8080', '+15550000000', ?)`
  ).run(groupingEnabled);
  db.prepare('INSERT INTO openproject_settings (id, base_url, api_key) VALUES (1, ?, ?)').run('http://op.local/', apiKey);
  return db;
}

function addContact(db, { name, number, muted = 0, openprojectUserId = null }) {
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, muted, openproject_user_id)
     VALUES (?, 'individual', ?, ?, ?)`
  ).run(name, number, muted, openprojectUserId);
}

test('isDynamicRelation accepts author, assignee and customFieldNN keys only', () => {
  assert.equal(isDynamicRelation('author'), true);
  assert.equal(isDynamicRelation('assignee'), true);
  assert.equal(isDynamicRelation('customField21'), true);
  assert.equal(isDynamicRelation('customField'), false);
  assert.equal(isDynamicRelation('customField21; DROP'), false);
  assert.equal(isDynamicRelation(null), false);
});

test('a text custom field resolves to the contact named in it', () => {
  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField21' };
  const snapshot = { id: 1, customFields: { customField21: 'Іванов Іван Іванович' } };
  assert.equal(resolveRecipient(db, rule, snapshot), '+380501112233');
});

test('a user-typed custom field resolves through the synced OpenProject user', () => {
  const db = setup();
  addContact(db, { name: 'Somebody Else', number: '+380509998877', openprojectUserId: 42 });
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField30' };
  const snapshot = { id: 1, customFields: { customField30: { id: 42, name: 'Іванов Іван' } } };
  assert.equal(resolveRecipient(db, rule, snapshot), '+380509998877');
});

test('an empty custom field says so', () => {
  const db = setup();
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField21' };
  assert.throws(
    () => resolveRecipient(db, rule, { id: 1, customFields: { customField21: '' } }),
    /no value in customField21/
  );
});

// ------------------------------------------------- the Довідка → Здано rule

const DONE_RULE = {
  type: 'group',
  operator: 'AND',
  children: [
    { type: 'condition', field: 'type', operator: 'equals', value: 'Довідка' },
    { type: 'condition', field: 'status', operator: 'changed_to', value: 'Здано ✅' },
  ],
};

function addDoneRule(db, { commentTemplate = 'Повідомлено в Signal: {recipient_name}' } = {}) {
  return rulesRepo.create(db, {
    name: 'Довідка здана',
    enabled: true,
    conditionTree: DONE_RULE,
    actionRecipientMode: 'dynamic',
    actionRecipientDynamicRelation: 'customField21',
    messageTemplate: 'Довідка #{id} для {customField21} готова ✅',
    commentTemplate,
  });
}

function wp(overrides = {}) {
  return {
    id: 501,
    subject: 'Довідка',
    type: { id: 8, name: 'Довідка' },
    status: { id: 1, name: 'Нова' },
    project: { id: 3, name: 'Канцелярія' },
    customFields: { customField21: 'Іванов Іван Іванович' },
    createdAt: '2026-11-19T08:00:00Z',
    updatedAt: '2026-11-19T08:00:00Z',
    action: 'work_package:created',
    ...overrides,
  };
}

/** Feeds the creation and then the status change through the real diff engine. */
function statusChangeEvent(db) {
  processWebhookEvent(db, wp());
  const result = processWebhookEvent(
    db,
    wp({ status: { id: 9, name: 'Здано ✅' }, updatedAt: '2026-11-19T09:00:00Z', action: 'work_package:updated' })
  );
  return { snapshot: result.snapshot, changeSet: result.changeSet, eventType: result.eventType };
}

function captureFetch({ commentStatus = 201 } = {}) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    if (String(url).includes('/activities')) {
      return {
        ok: commentStatus < 300,
        status: commentStatus,
        text: async () => JSON.stringify({ message: 'You are not authorized to access this resource.' }),
        json: async () => ({ id: 1 }),
      };
    }
    return { ok: true, status: 201, text: async () => '' };
  });
  return calls;
}

test('status → Здано ✅ notifies the person in 🎯На кого and comments on the work package', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 2);
  const [send, comment] = calls;
  assert.match(send.url, /\/v2\/send$/);
  assert.deepEqual(send.body.recipients, ['+380501112233']);
  assert.equal(send.body.message, 'Довідка #501 для Іванов Іван Іванович готова ✅');

  assert.equal(comment.url, 'http://op.local/api/v3/work_packages/501/activities');
  assert.deepEqual(comment.body, { comment: { raw: 'Повідомлено в Signal: Іван Іванов' } });
  assert.match(comment.headers.Authorization, /^Basic /);

  const log = db.prepare('SELECT recipient, status FROM message_log ORDER BY id').all();
  assert.deepEqual(
    log.map((r) => ({ ...r })),
    [
      { recipient: '+380501112233', status: 'sent' },
      { recipient: 'OpenProject #501', status: 'sent' },
    ]
  );
});

test('the rule does not fire again when the comment comes back as a webhook', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);
  await processChangeEvent(db, statusChangeEvent(db));
  const before = calls.length;

  const echo = processWebhookEvent(
    db,
    wp({ status: { id: 9, name: 'Здано ✅' }, updatedAt: '2026-11-19T09:00:05Z', action: 'work_package:updated' })
  );
  await processChangeEvent(db, echo);
  assert.equal(calls.length, before);
});

test('no matching contact: nothing sent, no comment, the reason is logged', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Петро Петренко', number: '+380501112233' });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 0);
  const row = db.prepare('SELECT status, error_message FROM message_log').get();
  assert.equal(row.status, 'failed');
  assert.match(row.error_message, /customField21/);
  assert.match(row.error_message, /Іванов Іван Іванович/);
});

test('a refused comment is logged as failed without un-sending the notification', async (t) => {
  captureFetch({ commentStatus: 403 });
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));

  const log = db.prepare('SELECT recipient, status, error_message FROM message_log ORDER BY id').all();
  assert.equal(log[0].status, 'sent');
  assert.equal(log[1].recipient, 'OpenProject #501');
  assert.equal(log[1].status, 'failed');
  assert.match(log[1].error_message, /not authorized/);
});

test('a muted recipient gets no message and the work package gets no comment', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233', muted: 1 });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'muted');
});

test('with grouping on, the message is queued and the comment posted', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 1 });
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/activities$/);
  const statuses = db.prepare('SELECT status FROM message_log ORDER BY id').all().map((r) => r.status);
  assert.deepEqual(statuses, ['pending', 'sent']);
});

test('a rule without a comment template posts no comment', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  const rule = addDoneRule(db, { commentTemplate: '   ' });
  assert.equal(rule.comment_template, null, 'blank is stored as no comment');

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/send$/);
});

// ------------------------------------------------ "only these contacts" limit

function contactId(db, number) {
  return db.prepare('SELECT id FROM contacts WHERE signal_identifier = ?').get(number).id;
}

test('a rule limited to other contacts suppresses the send and the comment, saying why', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addContact(db, { name: 'Тест Тестовий', number: '+380507778899' });
  const rule = addDoneRule(db);
  rulesRepo.update(db, rule.id, {
    ...ruleBody(rule),
    allowedContactIds: [contactId(db, '+380507778899')],
  });

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 0);
  const row = db.prepare('SELECT recipient, status, error_message FROM message_log').get();
  assert.equal(row.recipient, '+380501112233');
  assert.equal(row.status, 'muted');
  assert.match(row.error_message, /not among this rule's allowed contacts \(Тест Тестовий\)/);
});

test('a rule limited to the resolved contact sends normally', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  const rule = addDoneRule(db);
  const updated = rulesRepo.update(db, rule.id, {
    ...ruleBody(rule),
    allowedContactIds: [String(contactId(db, '+380501112233')), 'junk', -1],
  });
  assert.deepEqual(updated.allowed_contact_ids, [contactId(db, '+380501112233')], 'ids normalized');

  await processChangeEvent(db, statusChangeEvent(db));

  assert.equal(calls.length, 2, 'message and comment');
});

test('an empty limit means anyone, and is stored as NULL', () => {
  const db = setup();
  const rule = addDoneRule(db);
  const updated = rulesRepo.update(db, rule.id, { ...ruleBody(rule), allowedContactIds: [] });
  assert.deepEqual(updated.allowed_contact_ids, []);
  assert.equal(db.prepare('SELECT allowed_contact_ids FROM rules').get().allowed_contact_ids, null);
});

function ruleBody(rule) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    conditionTree: rule.conditionTree,
    actionRecipientMode: rule.action_recipient_mode,
    actionRecipientDynamicRelation: rule.action_recipient_dynamic_relation,
    messageTemplate: rule.message_template,
    commentTemplate: rule.comment_template,
  };
}
