import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCreationEvent, processWebhookEvent } from '../src/diff/diffEngine.js';
import { evaluateConditionTree, buildEvaluationContext } from '../src/rules/ruleEvaluator.js';
import { createTestDb } from './testDb.js';

const CREATED_RULE = { type: 'group', operator: 'AND', children: [{ type: 'condition', operator: 'event_type_created' }] };

function snapshot(overrides = {}) {
  return {
    id: 500,
    subject: 'New ticket',
    type: { id: 1, name: 'Телеграма' },
    status: { id: 1, name: 'New' },
    project: { id: 1, name: 'Demo' },
    author: { id: 42, name: 'Ivan' },
    customFields: {},
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
    action: 'work_package:created',
    ...overrides,
  };
}

test("OpenProject's explicit created action is authoritative", () => {
  assert.equal(isCreationEvent(snapshot()), true);
  // Timestamps drifted well past the old 5s window, but the action still says created.
  assert.equal(isCreationEvent(snapshot({ updatedAt: '2026-08-01T10:05:00Z' })), true);
  assert.equal(isCreationEvent(snapshot({ action: 'work_package:updated' })), false);
});

test('an updated action is not a creation even when timestamps look identical', () => {
  // Without the action check this would false-positive on the timestamp heuristic.
  assert.equal(isCreationEvent(snapshot({ action: 'work_package:updated' })), false);
});

test('timestamp heuristic still applies when the payload omits action', () => {
  assert.equal(isCreationEvent(snapshot({ action: null })), true);
  assert.equal(isCreationEvent(snapshot({ action: null, updatedAt: '2026-08-01T10:05:00Z' })), false);
});

test('a created webhook fires an event_type_created rule exactly once', () => {
  const db = createTestDb();
  const context = (r) => buildEvaluationContext(r.changeSet, r.eventType);

  const creation = processWebhookEvent(db, snapshot());
  assert.equal(creation.eventType, 'created');
  assert.equal(evaluateConditionTree(CREATED_RULE, context(creation)), true);

  // Any later edit to the same work package must NOT re-fire the rule.
  const laterEdit = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 2, name: 'Closed' }, updatedAt: '2026-08-02T10:00:00Z' })
  );
  assert.equal(laterEdit.status, 'processed');
  assert.equal(laterEdit.eventType, null);
  assert.equal(evaluateConditionTree(CREATED_RULE, context(laterEdit)), false);
});

test('pre-existing work packages seen for the first time do not fire a created rule', () => {
  // The scenario that matters when pointing this app at an OpenProject
  // instance with existing history: first webhook for an old work package
  // is an update, and must not be mistaken for a creation.
  const db = createTestDb();
  const result = processWebhookEvent(
    db,
    snapshot({ id: 501, action: 'work_package:updated', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2026-08-01T10:00:00Z' })
  );
  assert.equal(result.eventType, null);
  assert.equal(evaluateConditionTree(CREATED_RULE, buildEvaluationContext(result.changeSet, result.eventType)), false);
});
