import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChangeSet, processWebhookEvent } from '../src/diff/diffEngine.js';
import { createTestDb } from './testDb.js';

function snapshot(overrides = {}) {
  return {
    id: 1,
    subject: 'Fix the bug',
    type: { id: 1, name: 'Bug' },
    status: { id: 1, name: 'New' },
    project: { id: 1, name: 'Demo' },
    assignee: null,
    priority: { id: 8, name: 'Normal' },
    customFields: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: '/api/v3/work_packages/1',
    ...overrides,
  };
}

test('computeChangeSet: first-sight snapshot never reports changed fields', () => {
  const changeSet = computeChangeSet(snapshot(), null);
  assert.ok(changeSet.every((entry) => entry.changed === false));
  const status = changeSet.find((e) => e.field === 'status');
  assert.equal(status.from, null);
  assert.deepEqual(status.to, { id: 1, name: 'New' });
});

test('computeChangeSet: detects a status transition', () => {
  const oldSnap = snapshot();
  const newSnap = snapshot({ status: { id: 2, name: 'Closed' }, updatedAt: '2026-01-02T00:00:00Z' });
  const changeSet = computeChangeSet(newSnap, oldSnap);
  const status = changeSet.find((e) => e.field === 'status');
  assert.equal(status.changed, true);
  assert.equal(status.from.name, 'New');
  assert.equal(status.to.name, 'Closed');
  const subject = changeSet.find((e) => e.field === 'subject');
  assert.equal(subject.changed, false);
});

test('computeChangeSet: diffs custom fields by identifier', () => {
  const oldSnap = snapshot({ customFields: { customField1: 'a' } });
  const newSnap = snapshot({ customFields: { customField1: 'b' }, updatedAt: '2026-01-02T00:00:00Z' });
  const changeSet = computeChangeSet(newSnap, oldSnap);
  const cf = changeSet.find((e) => e.field === 'customField:customField1');
  assert.equal(cf.changed, true);
  assert.equal(cf.from, 'a');
  assert.equal(cf.to, 'b');
});

test('processWebhookEvent: first delivery is processed and cached', () => {
  const db = createTestDb();
  const result = processWebhookEvent(db, snapshot());
  assert.equal(result.status, 'processed');
  assert.equal(result.eventType, 'created'); // createdAt === updatedAt
  const cached = db.prepare('SELECT * FROM work_package_state_cache WHERE work_package_id = 1').get();
  assert.ok(cached);
});

test('processWebhookEvent: exact duplicate redelivery is ignored', () => {
  const db = createTestDb();
  processWebhookEvent(db, snapshot());
  const result = processWebhookEvent(db, snapshot());
  assert.equal(result.status, 'duplicate_ignored');
  const events = db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n;
  assert.equal(events, 1); // second delivery did not insert a new row
});

test('processWebhookEvent: out-of-order delivery does not overwrite newer cached state', () => {
  const db = createTestDb();
  processWebhookEvent(db, snapshot({ updatedAt: '2026-01-01T00:00:00Z' }));
  processWebhookEvent(
    db,
    snapshot({ status: { id: 2, name: 'Closed' }, updatedAt: '2026-01-03T00:00:00Z' })
  );

  const staleResult = processWebhookEvent(
    db,
    snapshot({ status: { id: 3, name: 'In progress' }, updatedAt: '2026-01-02T00:00:00Z' })
  );
  assert.equal(staleResult.status, 'out_of_order_ignored');

  const cached = db.prepare('SELECT * FROM work_package_state_cache WHERE work_package_id = 1').get();
  const cachedSnapshot = JSON.parse(cached.snapshot);
  assert.equal(cachedSnapshot.status.name, 'Closed'); // still the newer state, not the stale one
});

test('processWebhookEvent: a real change after caching produces a non-null eventType only on first sight', () => {
  const db = createTestDb();
  processWebhookEvent(db, snapshot());
  const result = processWebhookEvent(
    db,
    snapshot({ status: { id: 2, name: 'Closed' }, updatedAt: '2026-01-02T00:00:00Z' })
  );
  assert.equal(result.status, 'processed');
  assert.equal(result.eventType, null);
  assert.equal(result.changeSet.find((e) => e.field === 'status').changed, true);
});
