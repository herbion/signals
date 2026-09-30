import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/messageLog/messageLog.repository.js';
import { createTestDb } from './testDb.js';

test('pruneOlderThan deletes only rows older than the given cutoff', () => {
  const db = createTestDb();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);

  repo.insert(db, { direction: 'outbound', status: 'sent', content: 'old' });
  db.prepare("UPDATE message_log SET created_at = @createdAt WHERE content = 'old'").run({ createdAt: daysAgo(10) });

  repo.insert(db, { direction: 'outbound', status: 'sent', content: 'borderline' });
  db.prepare("UPDATE message_log SET created_at = @createdAt WHERE content = 'borderline'").run({ createdAt: daysAgo(8) });

  repo.insert(db, { direction: 'outbound', status: 'sent', content: 'recent' });
  db.prepare("UPDATE message_log SET created_at = @createdAt WHERE content = 'recent'").run({ createdAt: daysAgo(3) });

  repo.insert(db, { direction: 'outbound', status: 'sent', content: 'fresh' });

  const deleted = repo.pruneOlderThan(db, { days: 7 });
  assert.equal(deleted, 2, 'both the 10-day and 8-day rows are past a 7-day retention window');

  const remaining = db.prepare('SELECT content FROM message_log ORDER BY content').all().map((r) => r.content);
  assert.deepEqual(remaining, ['fresh', 'recent']);
});

test('pruneOlderThan on an empty table deletes nothing', () => {
  const db = createTestDb();
  assert.equal(repo.pruneOlderThan(db, { days: 7 }), 0);
});
