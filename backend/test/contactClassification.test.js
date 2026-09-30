import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contactsRepo from '../src/contacts/contacts.repository.js';
import { createTestDb } from './testDb.js';

const SENDER = '+380671112233';

test('a contact created from a Signal sender starts on the classification queue', () => {
  const db = createTestDb();
  const contact = contactsRepo.createFromSignal(db, { identifier: SENDER, name: 'Ann' });

  assert.equal(contact.name, 'Ann');
  assert.equal(contact.signal_identifier, SENDER);
  assert.equal(contact.needs_classification, true);
  assert.deepEqual(contact.field_values, {});
  // Hand-entered contacts are not swept into the queue with them.
  assert.deepEqual(
    contactsRepo.listNeedingClassification(db).map((row) => row.id),
    [contact.id]
  );
});

test('a nameless sender is filed under their number rather than an empty row', () => {
  const db = createTestDb();
  assert.equal(contactsRepo.createFromSignal(db, { identifier: SENDER, name: '  ' }).name, SENDER);
});

test('recording a value answers the question and clears the flag', () => {
  const db = createTestDb();
  const contact = contactsRepo.createFromSignal(db, { identifier: SENDER, name: 'Ann' });

  const saved = contactsRepo.setFieldValues(db, contact.id, { customField19: '7' });
  assert.deepEqual(saved.field_values, { customField19: '7' });
  assert.equal(saved.needs_classification, false);
  assert.deepEqual(contactsRepo.listNeedingClassification(db), []);
});

test('saving with nothing filled in keeps the contact on the queue', () => {
  const db = createTestDb();
  const contact = contactsRepo.createFromSignal(db, { identifier: SENDER, name: 'Ann' });

  const saved = contactsRepo.setFieldValues(db, contact.id, { customField19: '  ' });
  assert.deepEqual(saved.field_values, {});
  assert.equal(saved.needs_classification, true);
});

test('a contact whose recorded value a later rule needs is flagged again', () => {
  const db = createTestDb();
  const contact = contactsRepo.createFromSignal(db, { identifier: SENDER, name: 'Ann' });
  contactsRepo.setFieldValues(db, contact.id, { customField19: '7' });

  const flagged = contactsRepo.markNeedsClassification(db, contact.id);
  assert.equal(flagged.needs_classification, true);
  // Flagging asks a new question; it does not throw away the old answer.
  assert.deepEqual(flagged.field_values, { customField19: '7' });
});

test('field values reach callers as an object, whatever the column holds', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, field_values)
     VALUES ('Broken', 'individual', ?, 'not json at all')`
  ).run(SENDER);

  // A malformed blob reads as "nothing recorded" rather than breaking the list.
  assert.deepEqual(contactsRepo.getBySignalIdentifier(db, SENDER).field_values, {});
});
