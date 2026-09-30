import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/messageLog/messageLog.repository.js';
import { createTestDb } from './testDb.js';

function seed(db) {
  const rows = [
    { direction: 'outbound', status: 'sent', content: 'a' },
    { direction: 'outbound', status: 'sent', content: 'b' },
    { direction: 'outbound', status: 'failed', content: 'c', errorMessage: 'no contact' },
    { direction: 'inbound', status: 'received', content: 'd', sender: '+1' },
  ];
  for (const row of rows) repo.insert(db, row);
}

test('stats counts outbound sent/failed and inbound separately', () => {
  const db = createTestDb();
  seed(db);

  const s = repo.stats(db);
  assert.equal(s.sent, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.inbound, 1);
  assert.equal(s.sentToday, 2, 'rows inserted now count toward today');
});

test('stats reports rule and contact totals', () => {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO rules (name, enabled, condition_tree, message_template)
     VALUES ('on', 1, '{"type":"group","operator":"AND","children":[]}', 'x'),
            ('off', 0, '{"type":"group","operator":"AND","children":[]}', 'x')`
  ).run();
  db.prepare("INSERT INTO contacts (name, type, signal_identifier) VALUES ('A', 'individual', '+1')").run();

  const s = repo.stats(db);
  assert.equal(s.rulesTotal, 2);
  assert.equal(s.rulesEnabled, 1);
  assert.equal(s.contacts, 1);
});

test('daily series has one entry per day including quiet days', () => {
  const db = createTestDb();
  seed(db);

  const s = repo.stats(db, { days: 14 });
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily.at(-1).sent, 2, 'last bucket is today');
  assert.equal(s.daily[0].sent, 0, 'quiet days are filled with zeroes, not omitted');
  // Dates ascend and are ISO yyyy-mm-dd.
  assert.match(s.daily[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(s.daily[0].date < s.daily.at(-1).date);
});

test('stats on an empty install returns zeroes rather than throwing', () => {
  const s = repo.stats(createTestDb());
  assert.deepEqual(
    { sent: s.sent, failed: s.failed, inbound: s.inbound, contacts: s.contacts, rulesEnabled: s.rulesEnabled },
    { sent: 0, failed: 0, inbound: 0, contacts: 0, rulesEnabled: 0 }
  );
});
