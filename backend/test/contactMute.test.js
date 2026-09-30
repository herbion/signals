import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as contactsRepo from '../src/contacts/contacts.repository.js';
import { syncContactsFromOpenProject } from '../src/contacts/contactsSync.js';
import { processChangeEvent } from '../src/rules/ruleProcessor.js';
import { createTestDb } from './testDb.js';

const MUTED_NUMBER = '+380996075027';
const OPEN_NUMBER = '+380930259044';

function setup({ groupingEnabled = 0 } = {}) {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO signal_settings (id, signal_api_base_url, bot_number, grouping_enabled)
     VALUES (1, 'http://signal-api:8080', '+15550000000', ?)`
  ).run(groupingEnabled);
  db.prepare('INSERT INTO openproject_settings (id, base_url) VALUES (1, ?)').run('http://op.local');
  return db;
}

function addContact(db, { name, number, muted = 0, openprojectUserId = null }) {
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, muted, openproject_user_id)
     VALUES (?, 'individual', ?, ?, ?)`
  ).run(name, number, muted, openprojectUserId);
  return db.prepare('SELECT * FROM contacts WHERE signal_identifier = ?').get(number);
}

function addRule(db, { mode = 'contact', contactId = null, raw = null, relation = null }) {
  db.prepare(
    `INSERT INTO rules (name, enabled, condition_tree, action_recipient_mode,
                        action_recipient_contact_id, action_recipient_raw,
                        action_recipient_dynamic_relation, message_template)
     VALUES ('r', 1, '{"type":"group","operator":"AND","children":[{"type":"condition","operator":"event_type_created"}]}',
             ?, ?, ?, ?, 'WP #{id} created')`
  ).run(mode, contactId, raw, relation);
}

const EVENT = {
  snapshot: { id: 900, subject: 'Test', customFields: {}, author: { id: 13, name: 'Максим' } },
  changeSet: [],
  eventType: 'created',
};

function captureSend() {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 201, text: async () => '' };
  });
  return calls;
}

test('isRecipientMuted matches on the resolved signal identifier', () => {
  const db = setup();
  addContact(db, { name: 'Quiet', number: MUTED_NUMBER, muted: 1 });
  addContact(db, { name: 'Loud', number: OPEN_NUMBER });

  assert.equal(contactsRepo.isRecipientMuted(db, MUTED_NUMBER), true);
  assert.equal(contactsRepo.isRecipientMuted(db, OPEN_NUMBER), false);
  assert.equal(contactsRepo.isRecipientMuted(db, '+15559999999'), false, 'unknown number is not muted');
  assert.equal(contactsRepo.isRecipientMuted(db, null), false);
});

test('a rule targeting a muted contact sends nothing and logs why', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = setup();
  const contact = addContact(db, { name: 'Quiet', number: MUTED_NUMBER, muted: 1 });
  addRule(db, { mode: 'contact', contactId: contact.id });

  await processChangeEvent(db, EVENT);

  assert.equal(calls.length, 0, 'no Signal API call');
  const row = db.prepare('SELECT status, recipient FROM message_log').get();
  assert.equal(row.status, 'muted');
  assert.equal(row.recipient, MUTED_NUMBER, 'still recorded against the intended recipient');
});

test('muting suppresses a dynamically resolved author too', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Максим', number: MUTED_NUMBER, muted: 1, openprojectUserId: 13 });
  addRule(db, { mode: 'dynamic', relation: 'author' });

  await processChangeEvent(db, EVENT);

  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'muted');
});

test('a raw-number rule cannot bypass a mute on the same number', async (t) => {
  // Without checking the resolved identifier, muting a contact would leave
  // this hole open: the rule never references the contact row at all.
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = setup();
  addContact(db, { name: 'Quiet', number: MUTED_NUMBER, muted: 1 });
  addRule(db, { mode: 'raw', raw: MUTED_NUMBER });

  await processChangeEvent(db, EVENT);

  assert.equal(calls.length, 0, 'raw sends respect the mute');
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'muted');
});

test('unmuted contacts are unaffected', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = setup();
  const contact = addContact(db, { name: 'Loud', number: OPEN_NUMBER });
  addRule(db, { mode: 'contact', contactId: contact.id });

  await processChangeEvent(db, EVENT);

  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'sent');
});

test('muted messages never enter the outbound queue when grouping is on', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = setup({ groupingEnabled: 1 });
  const contact = addContact(db, { name: 'Quiet', number: MUTED_NUMBER, muted: 1 });
  addRule(db, { mode: 'contact', contactId: contact.id });

  await processChangeEvent(db, EVENT);

  assert.equal(calls.length, 0);
  const pending = db.prepare("SELECT COUNT(*) n FROM message_log WHERE status = 'pending'").get().n;
  assert.equal(pending, 0, 'nothing queued for a later flush');
  assert.equal(db.prepare('SELECT status FROM message_log').get().status, 'muted');
});

test('contact sync preserves the mute flag', () => {
  const db = setup();
  addContact(db, { name: 'Максим', number: MUTED_NUMBER, muted: 1, openprojectUserId: 13 });

  const users = [{ id: 13, name: 'Максим Синявський', customField17: 380996075027 }];
  assert.deepEqual(syncContactsFromOpenProject(db, users, 'customField17'), { created: 0, updated: 1, skipped: 0 });

  const contact = db.prepare('SELECT name, muted FROM contacts WHERE openproject_user_id = 13').get();
  assert.equal(contact.muted, 1, 're-syncing must not silently unmute someone');
  assert.equal(contact.name, 'Максим Синявський', 'other fields still update');
});

test('setMuted toggles both directions', () => {
  const db = setup();
  const contact = addContact(db, { name: 'Loud', number: OPEN_NUMBER });

  assert.equal(contactsRepo.setMuted(db, contact.id, true).muted, 1);
  assert.equal(contactsRepo.isRecipientMuted(db, OPEN_NUMBER), true);
  assert.equal(contactsRepo.setMuted(db, contact.id, false).muted, 0);
  assert.equal(contactsRepo.isRecipientMuted(db, OPEN_NUMBER), false);
});
