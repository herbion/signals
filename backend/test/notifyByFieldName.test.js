import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { matchContactByName, nameWords } from '../src/contacts/contactNameMatch.js';
import { processChangeEvent, resolveRecipient, isDynamicRelation } from '../src/rules/ruleProcessor.js';
import { processWebhookEvent } from '../src/diff/diffEngine.js';
import * as rulesRepo from '../src/rules/rules.repository.js';
import { dispatchDueBatches, findDueRecipients } from '../src/signal/outboundDispatcher.js';
import { normalizeWebhookPayload } from '../src/webhooks/payloadNormalizer.js';
import { buildTemplateContext, renderTemplate } from '../src/rules/templateRenderer.js';
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

test('a text custom field resolves to the contact named in it', async () => {
  const db = setup();
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField21' };
  const snapshot = { id: 1, customFields: { customField21: 'Іванов Іван Іванович' } };
  assert.equal(await resolveRecipient(db, rule, snapshot), '+380501112233');
});

test('a user-typed custom field resolves through the synced OpenProject user', async () => {
  const db = setup();
  addContact(db, { name: 'Somebody Else', number: '+380509998877', openprojectUserId: 42 });
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField30' };
  const snapshot = { id: 1, customFields: { customField30: { id: 42, name: 'Іванов Іван', kind: 'user' } } };
  assert.equal(await resolveRecipient(db, rule, snapshot), '+380509998877');
});

test('an empty custom field says so', async () => {
  const db = setup();
  const rule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField21' };
  await assert.rejects(
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

test('with grouping on, the comment waits until the batch is actually sent', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 1 });
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);

  await processChangeEvent(db, statusChangeEvent(db));
  assert.equal(calls.length, 0, 'queued: nothing sent, nothing commented yet');
  const queued = db.prepare('SELECT status, pending_comment FROM message_log').get();
  assert.equal(queued.status, 'pending');
  assert.equal(queued.pending_comment, 'Повідомлено в Signal: Іван Іванов');

  age(db, 120);
  await dispatchDueBatches(db);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v2\/send$/);
  assert.match(calls[1].url, /\/activities$/);
  const rows = db.prepare('SELECT recipient, status, pending_comment FROM message_log ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent']);
  assert.equal(rows[0].pending_comment, null, 'cleared once posted');
});

test('a failed batch posts no comment', async (t) => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return { ok: false, status: 500, text: async () => 'boom' };
  });
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 1 });
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addDoneRule(db);
  await processChangeEvent(db, statusChangeEvent(db));
  age(db, 120);
  await dispatchDueBatches(db);

  assert.equal(calls.filter((u) => u.includes('/activities')).length, 0);
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'failed');
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

// ------------------------------------------------------ per-rule batch window

/** Pretends every queued row was created `seconds` ago. */
function age(db, seconds, where = '1 = 1') {
  db.prepare(`UPDATE message_log SET created_at = datetime('now', ?) WHERE ${where}`).run(`-${seconds} seconds`);
}

function addWindowedDoneRule(db, windowSeconds) {
  const rule = addDoneRule(db);
  return rulesRepo.update(db, rule.id, { ...ruleBody(rule), batchWindowSeconds: windowSeconds });
}

/** Several Довідки for one requester marked Здано one after another. */
async function markDone(db, ids) {
  for (const id of ids) {
    processWebhookEvent(db, wp({ id }));
    const result = processWebhookEvent(
      db,
      wp({ id, status: { id: 9, name: 'Здано ✅' }, updatedAt: '2026-11-19T09:00:00Z', action: 'work_package:updated' })
    );
    await processChangeEvent(db, result);
  }
}

test('a rule window is stored in seconds, blank or 0 meaning the global window', () => {
  const db = setup();
  assert.equal(addWindowedDoneRule(db, 1800).batch_window_seconds, 1800);
  const rule = addDoneRule(db);
  assert.equal(rulesRepo.update(db, rule.id, { ...ruleBody(rule), batchWindowSeconds: 0 }).batch_window_seconds, null);
  assert.equal(rulesRepo.update(db, rule.id, { ...ruleBody(rule), batchWindowSeconds: '' }).batch_window_seconds, null);
});

test('a rule window batches several Довідки into one message even with global grouping off', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 0 });
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addWindowedDoneRule(db, 1800);

  await markDone(db, [601, 602, 603]);
  assert.equal(calls.length, 0, 'all three queued, not sent');

  age(db, 600);
  assert.deepEqual(findDueRecipients(db, 60), [], 'the global 60s window does not apply to these rows');

  age(db, 1800);
  await dispatchDueBatches(db);

  const sends = calls.filter((c) => c.url.endsWith('/v2/send'));
  assert.equal(sends.length, 1, 'one Signal message for three certificates');
  assert.match(sends[0].body.message, /3 updates/);
  for (const id of [601, 602, 603]) assert.match(sends[0].body.message, new RegExp(`#${id}`));

  const comments = calls.filter((c) => c.url.includes('/activities')).map((c) => c.url);
  assert.deepEqual(comments.sort(), [601, 602, 603].map((id) => `http://op.local/api/v3/work_packages/${id}/activities`));
});

test('a message due sooner for the same person takes the longer-window ones along', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 1 });
  addContact(db, { name: 'Іван Іванов', number: '+380501112233' });
  addWindowedDoneRule(db, 1800);
  await markDone(db, [701]);
  // Something else for the same person on the global 60s window.
  db.prepare(
    `INSERT INTO message_log (direction, recipient, content, status) VALUES ('outbound', '+380501112233', 'other', 'pending')`
  ).run();

  age(db, 90);
  await dispatchDueBatches(db);

  const sends = calls.filter((c) => c.url.endsWith('/v2/send'));
  assert.equal(sends.length, 1);
  assert.match(sends[0].body.message, /2 updates/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_log WHERE status = 'pending'").get().n, 0);
});

// ------------------------------------------- link-type custom fields (Замовник)

/** Trimmed from a real Довідка (GET /api/v3/work_packages/4182). */
const REAL_DOVIDKA = {
  action: 'work_package:updated',
  work_package: {
    id: 4182,
    subject: 'Довідка',
    customField21: 'ЧИЧУК Ярослав Олегович',
    createdAt: '2026-11-01T08:00:00Z',
    updatedAt: '2026-11-19T09:00:00Z',
    _links: {
      self: { href: '/api/v3/work_packages/4182' },
      type: { href: '/api/v3/types/8', title: 'Довідка' },
      status: { href: '/api/v3/statuses/29', title: 'Здано ✅' },
      customFields: { href: '/projects/personnel/settings/custom_fields', type: 'text/html', title: 'Custom fields' },
      customField1: [{ title: 'Форма 6', href: '/api/v3/custom_options/2' }],
      customField19: { title: '1МБ - Бік Андрій', href: '/api/v3/custom_field_items/57' },
      customField30: { title: 'Максим Синявський', href: '/api/v3/users/13' },
      customField31: { href: null },
    },
  },
};

test('link-only custom fields reach the snapshot, typed as option or user', () => {
  const snapshot = normalizeWebhookPayload(REAL_DOVIDKA);
  assert.deepEqual(snapshot.customFields, {
    customField21: 'ЧИЧУК Ярослав Олегович',
    customField1: { id: 2, name: 'Форма 6', kind: 'option' },
    customField19: { id: 57, name: '1МБ - Бік Андрій', kind: 'option' },
    customField30: { id: 13, name: 'Максим Синявський', kind: 'user' },
    customField31: null,
  });
  assert.equal('customFields' in snapshot.customFields, false, 'the settings-page link is not a field');
});

test('a multi-select with several values keeps all of them', () => {
  const payload = structuredClone(REAL_DOVIDKA);
  payload.work_package._links.customField1.push({ title: 'Форма 5', href: '/api/v3/custom_options/3' });
  assert.deepEqual(normalizeWebhookPayload(payload).customFields.customField1, {
    id: '2,3',
    name: 'Форма 6, Форма 5',
    kind: 'option',
  });
});

test('the ready message renders Тип довідки and На кого by name', () => {
  const snapshot = normalizeWebhookPayload(REAL_DOVIDKA);
  const context = buildTemplateContext(snapshot, []);
  assert.equal(
    renderTemplate('✅ Ваша довідка {customField1} для {customField21} - готова', context),
    '✅ Ваша довідка Форма 6 для ЧИЧУК Ярослав Олегович - готова'
  );
});

function classify(db, number, fieldValues) {
  db.prepare('UPDATE contacts SET field_values = ? WHERE signal_identifier = ?').run(JSON.stringify(fieldValues), number);
}

const zamovnykRule = { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'customField19' };
const zamovnyk = (id, name = '1МБ - Бік Андрій') => ({
  id: 4182,
  customFields: { customField19: { id, name, kind: 'option' } },
});

test('an option field resolves to the contact classified with that option', async () => {
  const db = setup();
  addContact(db, { name: '1МБ - Бік Андрій', number: '+380501112233' });
  addContact(db, { name: '2МБ - Пишний Василь', number: '+380504445566' });
  classify(db, '+380501112233', { customField19: '57' });
  classify(db, '+380504445566', { customField19: '17' });
  assert.equal(await resolveRecipient(db, zamovnykRule, zamovnyk(57)), '+380501112233');
});

test('an option id is never looked up as an OpenProject user id', async () => {
  const db = setup();
  // User 57 exists as a contact, but option 57 is somebody else's Замовник.
  addContact(db, { name: 'Unrelated user', number: '+380507770000', openprojectUserId: 57 });
  await assert.rejects(() => resolveRecipient(db, zamovnykRule, zamovnyk(57)), /No contact is classified with customField19/);
});

test('an option nobody is classified with explains how to fix it', async () => {
  const db = setup();
  await assert.rejects(
    () => resolveRecipient(db, zamovnykRule, zamovnyk(57, '3МБ - Новий')),
    /customField19 = "3МБ - Новий" \(option 57\)\. Set it on the right contact/
  );
});

test('two different people classified with one option is an error, not a pick', async () => {
  const db = setup();
  addContact(db, { name: 'A', number: '+380501112233' });
  addContact(db, { name: 'B', number: '+380504445566' });
  classify(db, '+380501112233', { customField19: 57 });
  classify(db, '+380504445566', { customField19: '57' });
  await assert.rejects(() => resolveRecipient(db, zamovnykRule, zamovnyk(57)), /more than one contact \("A", "B"\)/);
});

test('the Замовник rule end to end: real payload in, requester notified, comment back', async (t) => {
  const calls = captureFetch();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: '1МБ - Бік Андрій', number: '+380501112233' });
  classify(db, '+380501112233', { customField19: '57' });
  rulesRepo.create(db, {
    name: '✅ Довідка - Здано',
    enabled: true,
    conditionTree: {
      type: 'group',
      operator: 'AND',
      children: [
        { type: 'condition', field: 'type', operator: 'equals', value: 8 },
        { type: 'condition', field: 'status', operator: 'changed_to', value: 29 },
      ],
    },
    actionRecipientMode: 'dynamic',
    actionRecipientDynamicRelation: 'customField19',
    messageTemplate: '✅ Ваша довідка {customField1} для {customField21} - готова',
    commentTemplate: 'Повідомлено в Signal: {recipient_name}',
  });

  const before = structuredClone(REAL_DOVIDKA);
  before.work_package._links.status = { href: '/api/v3/statuses/15', title: 'Нова' };
  before.work_package.updatedAt = '2026-11-19T08:00:00Z';
  processWebhookEvent(db, normalizeWebhookPayload(before));
  const result = processWebhookEvent(db, normalizeWebhookPayload(REAL_DOVIDKA));
  await processChangeEvent(db, result);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.recipients, ['+380501112233']);
  assert.equal(calls[0].body.message, '✅ Ваша довідка Форма 6 для ЧИЧУК Ярослав Олегович - готова');
  assert.deepEqual(calls[1].body, { comment: { raw: 'Повідомлено в Signal: 1МБ - Бік Андрій' } });
});

// ------------------------------------- 👤Замовник = "Запит": the parent's assignee

/** A Довідка ordered as part of a Запит: Замовник is the request, the work package is its child. */
const zapytChild = (parent = { id: 900, name: 'Запит від 3МБ' }) => ({
  id: 4183,
  parent,
  customFields: { customField19: { id: 12, name: 'Запит', kind: 'option' } },
});

/** OpenProject answering GET /work_packages/:id with that work package's assignee. */
function serveWorkPackage(t, { id = 900, assignee = { href: '/api/v3/users/42', title: 'Грінько Оксана' }, status = 200 } = {}) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: status < 300,
      status,
      json: async () => ({ id, subject: 'Запит від 3МБ', _links: { assignee: assignee ?? { href: null } } }),
      text: async () => '',
    };
  });
  t.after(() => mock.restoreAll());
  return calls;
}

test('"Запит" as Замовник is recognised however the label is decorated', async () => {
  const { isRequestOption } = await import('../src/rules/ruleProcessor.js');
  assert.equal(isRequestOption({ name: 'Запит' }), true);
  assert.equal(isRequestOption({ name: ' 📩 ЗАПИТ ' }), true);
  assert.equal(isRequestOption({ name: 'Запити' }), false);
  assert.equal(isRequestOption({ name: '1МБ - Бік Андрій' }), false);
  assert.equal(isRequestOption(null), false);
});

test('Замовник "Запит" notifies the assignee of the parent work package, read live', async (t) => {
  const calls = serveWorkPackage(t);
  const db = setup();
  addContact(db, { name: 'Грінько Оксана', number: '+380501230000', openprojectUserId: 42 });

  assert.equal(await resolveRecipient(db, zamovnykRule, zapytChild()), '+380501230000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://op.local/api/v3/work_packages/900');
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
});

test('"Запит" is never looked up in the classification, even if a contact carries that option', async (t) => {
  serveWorkPackage(t);
  const db = setup();
  addContact(db, { name: 'Грінько Оксана', number: '+380501230000', openprojectUserId: 42 });
  addContact(db, { name: 'Someone classified as Запит', number: '+380509990000' });
  classify(db, '+380509990000', { customField19: '12' });
  assert.equal(await resolveRecipient(db, zamovnykRule, zapytChild()), '+380501230000');
});

test('"Запит" with no parent says so instead of guessing', async () => {
  const db = setup();
  await assert.rejects(
    () => resolveRecipient(db, zamovnykRule, zapytChild(null)),
    /customField19 is "Запит", which is not a person, and work package #4183 has no parent/
  );
});

test('a parent with no assignee is reported', async (t) => {
  serveWorkPackage(t, { assignee: null });
  const db = setup();
  await assert.rejects(
    () => resolveRecipient(db, zamovnykRule, zapytChild()),
    /parent work package #900 has no assignee to notify/
  );
});

test('a parent assignee with no synced contact points at contact sync', async (t) => {
  serveWorkPackage(t);
  const db = setup();
  await assert.rejects(
    () => resolveRecipient(db, zamovnykRule, zapytChild()),
    /No contact linked to OpenProject user Грінько Оксана \(assignee of parent #900\)/
  );
});

test('when OpenProject cannot be read, the cached parent is used; with neither, the API error is reported', async (t) => {
  serveWorkPackage(t, { status: 503 });
  const db = setup();
  addContact(db, { name: 'Грінько Оксана', number: '+380501230000', openprojectUserId: 42 });

  await assert.rejects(
    () => resolveRecipient(db, zamovnykRule, zapytChild()),
    /Cannot read parent work package #900: .*failed: 503/
  );

  db.prepare(
    `INSERT INTO work_package_state_cache (work_package_id, project_id, snapshot, payload_hash, last_updated_at)
     VALUES (900, 5, ?, 'h', '2026-11-19T08:00:00Z')`
  ).run(JSON.stringify({ id: 900, assignee: { id: 42, name: 'Грінько Оксана' } }));
  assert.equal(await resolveRecipient(db, zamovnykRule, zapytChild()), '+380501230000');
});

test('the webhook snapshot carries the parent link', () => {
  const payload = structuredClone(REAL_DOVIDKA);
  payload.work_package._links.parent = { href: '/api/v3/work_packages/900', title: 'Запит від 3МБ' };
  assert.deepEqual(normalizeWebhookPayload(payload).parent, { id: 900, name: 'Запит від 3МБ' });

  payload.work_package._links.parent = { href: null };
  assert.equal(normalizeWebhookPayload(payload).parent, null);
});
