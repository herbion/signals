import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipient } from '../src/rules/ruleProcessor.js';
import {
  syncContactsFromOpenProject,
  extractPhone,
  normalizePhone,
  userDisplayName,
  toUserOptions,
} from '../src/contacts/contactsSync.js';
import { createTestDb } from './testDb.js';

function insertContact(db, { name, phone, openprojectUserId = null }) {
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, openproject_user_id) VALUES (?, 'individual', ?, ?)`
  ).run(name, phone, openprojectUserId);
  return db.prepare('SELECT * FROM contacts WHERE name = ?').get(name);
}

const snapshotWithAuthor = { id: 7, author: { id: 42, name: 'Ivan' }, assignee: { id: 43, name: 'Olga' } };

test('dynamic recipient resolves the author to their synced contact', () => {
  const db = createTestDb();
  insertContact(db, { name: 'Ivan', phone: '+15551110000', openprojectUserId: 42 });

  const recipient = resolveRecipient(
    db,
    { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'author' },
    snapshotWithAuthor
  );
  assert.equal(recipient, '+15551110000');
});

test('dynamic recipient can target the assignee instead', () => {
  const db = createTestDb();
  insertContact(db, { name: 'Olga', phone: '+15552220000', openprojectUserId: 43 });

  const recipient = resolveRecipient(
    db,
    { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'assignee' },
    snapshotWithAuthor
  );
  assert.equal(recipient, '+15552220000');
});

test('dynamic recipient explains itself when the user has no linked contact', () => {
  const db = createTestDb();
  assert.throws(
    () =>
      resolveRecipient(
        db,
        { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'author' },
        snapshotWithAuthor
      ),
    /No contact linked to OpenProject user Ivan/
  );
});

test('dynamic recipient explains itself when the work package has no such person', () => {
  const db = createTestDb();
  assert.throws(
    () =>
      resolveRecipient(
        db,
        { action_recipient_mode: 'dynamic', action_recipient_dynamic_relation: 'assignee' },
        { id: 7, author: { id: 42, name: 'Ivan' }, assignee: null }
      ),
    /no assignee to notify/
  );
});

test('contact mode still resolves a fixed contact, and falls back to raw', () => {
  const db = createTestDb();
  const contact = insertContact(db, { name: 'Fixed', phone: '+15553330000' });

  assert.equal(
    resolveRecipient(db, { action_recipient_mode: 'contact', action_recipient_contact_id: contact.id }, snapshotWithAuthor),
    '+15553330000'
  );
  assert.equal(
    resolveRecipient(db, { action_recipient_mode: 'raw', action_recipient_raw: '+15554440000' }, snapshotWithAuthor),
    '+15554440000'
  );
});

test('a rule with no recipient at all throws rather than silently sending nowhere', () => {
  const db = createTestDb();
  assert.throws(() => resolveRecipient(db, { action_recipient_mode: 'contact' }, snapshotWithAuthor), /no recipient configured/);
});

test('extractPhone reads plain and formatted custom field values, ignoring blanks', () => {
  assert.equal(extractPhone({ customField5: ' +15551234567 ' }, 'customField5'), '+15551234567');
  assert.equal(extractPhone({ customField5: { raw: '+15559999999' } }, 'customField5'), '+15559999999');
  assert.equal(extractPhone({ customField5: '' }, 'customField5'), null);
  assert.equal(extractPhone({}, 'customField5'), null);
});

test('extractPhone handles a numeric OpenProject custom field (real payload shape)', () => {
  // OpenProject returns a numeric custom field as a JSON number with no
  // leading '+'; treating it as a string-only field skipped every user.
  const user = { id: 13, name: 'Максим Синявський', customField17: 380996075027 };
  assert.equal(extractPhone(user, 'customField17'), '+380996075027');
});

test('normalizePhone adds the missing + and strips formatting', () => {
  assert.equal(normalizePhone(380996075027), '+380996075027');
  assert.equal(normalizePhone('380996075027'), '+380996075027');
  assert.equal(normalizePhone('+380996075027'), '+380996075027');
  assert.equal(normalizePhone('00380996075027'), '+380996075027'); // international prefix
  assert.equal(normalizePhone(' 380 99 607 50 27 '), '+380996075027');
  assert.equal(normalizePhone('380-99-607-50-27'), '+380996075027');
});

test('normalizePhone rejects empty and non-numeric values', () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('not a phone'), null);
});

test('userDisplayName falls through blank names instead of returning empty string', () => {
  assert.equal(userDisplayName({ id: 13, name: 'Максим Синявський' }), 'Максим Синявський');
  assert.equal(userDisplayName({ id: 13, name: '', firstName: 'Максим', lastName: 'Синявський' }), 'Максим Синявський');
  assert.equal(userDisplayName({ id: 13, name: '', login: 'Maksym' }), 'Maksym');
  assert.equal(userDisplayName({ id: 13 }), 'User 13');
});

test('toUserOptions drops locked/invited users and sorts by display name', () => {
  const options = toUserOptions([
    { id: 3, name: 'Zoya' },
    { id: 1, name: 'Andriy' },
    { id: 2, name: 'Locked Larry', status: 'locked' },
    { id: 4, name: 'Invited Ivan', status: 'invited' },
    { id: 5, name: 'Active Anna', status: 'active' },
  ]);
  assert.deepEqual(options, [
    { id: 5, name: 'Active Anna' },
    { id: 1, name: 'Andriy' },
    { id: 3, name: 'Zoya' },
  ]);
});

test('toUserOptions treats a missing status as active, and no users as an empty list', () => {
  assert.deepEqual(toUserOptions([{ id: 1, name: 'No Status Field' }]), [{ id: 1, name: 'No Status Field' }]);
  assert.deepEqual(toUserOptions(undefined), []);
  assert.deepEqual(toUserOptions([]), []);
});

test('sync creates a contact from a realistic OpenProject user payload', () => {
  const db = createTestDb();
  const users = [
    {
      _type: 'User',
      id: 13,
      name: 'Максим Синявський',
      login: 'Maksym',
      firstName: 'Максим',
      lastName: 'Синявський',
      email: 'armerin20@gmail.com',
      status: 'active',
      customField17: 380996075027,
    },
  ];

  assert.deepEqual(syncContactsFromOpenProject(db, users, 'customField17'), { created: 1, updated: 0, skipped: 0 });

  const contact = db.prepare('SELECT * FROM contacts WHERE openproject_user_id = 13').get();
  assert.equal(contact.name, 'Максим Синявський');
  assert.equal(contact.signal_identifier, '+380996075027');
});

test('contact sync creates, then updates on re-run, and skips users with no phone', () => {
  const db = createTestDb();
  const users = [
    { id: 42, name: 'Ivan', customField5: '+15551110000' },
    { id: 44, name: 'No Phone', customField5: '' },
  ];

  const first = syncContactsFromOpenProject(db, users, 'customField5');
  assert.deepEqual(first, { created: 1, updated: 0, skipped: 1 });

  users[0].customField5 = '+15558887777';
  users[0].name = 'Ivan Renamed';
  const second = syncContactsFromOpenProject(db, users, 'customField5');
  assert.deepEqual(second, { created: 0, updated: 1, skipped: 1 });

  const contacts = db.prepare('SELECT * FROM contacts').all();
  assert.equal(contacts.length, 1); // updated in place, not duplicated
  assert.equal(contacts[0].signal_identifier, '+15558887777');
  assert.equal(contacts[0].name, 'Ivan Renamed');
});

test('contact sync leaves manually-created contacts alone', () => {
  const db = createTestDb();
  insertContact(db, { name: 'Manual', phone: '+15550000000' });

  syncContactsFromOpenProject(db, [{ id: 42, name: 'Ivan', customField5: '+15551110000' }], 'customField5');

  const manual = db.prepare('SELECT * FROM contacts WHERE name = ?').get('Manual');
  assert.equal(manual.signal_identifier, '+15550000000');
  assert.equal(manual.openproject_user_id, null);
});
