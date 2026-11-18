import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditionTree, buildEvaluationContext, ruleAlreadyMatched } from '../src/rules/ruleEvaluator.js';
import { processWebhookEvent } from '../src/diff/diffEngine.js';
import { createTestDb } from './testDb.js';

// The exact shape of the live "🔜 Телеграма - Нова" rule: two state checks,
// no transition condition. This is the rule that was re-sending.
const STATE_ONLY_RULE = {
  type: 'group',
  operator: 'AND',
  children: [
    { type: 'condition', field: 'status', operator: 'equals', value: 'Нова' },
    { type: 'condition', field: 'type', operator: 'equals', value: 'Телеграма' },
  ],
};

function snapshot(overrides = {}) {
  return {
    id: 1105,
    subject: 'Тестова задача',
    type: { id: 1, name: 'Телеграма' },
    status: { id: 1, name: 'Нова' },
    project: { id: 1, name: 'Demo' },
    author: { id: 13, name: 'Максим' },
    customFields: {},
    createdAt: '2026-08-13T08:35:35.951Z',
    updatedAt: '2026-08-13T08:35:35.951Z',
    action: 'work_package:created',
    ...overrides,
  };
}

/** Would this rule actually send for this processed webhook? */
function wouldSend(rule, result) {
  const matchesNow = evaluateConditionTree(rule, buildEvaluationContext(result.changeSet, result.eventType));
  return matchesNow && !ruleAlreadyMatched(rule, result.changeSet, result.eventType);
}

test('a state-only rule fires once on creation, not again on later edits', () => {
  const db = createTestDb();

  // 1. Created.
  const created = processWebhookEvent(db, snapshot());
  assert.equal(wouldSend(STATE_ONLY_RULE, created), true, 'should notify when the ticket appears');

  // 2. Attachment added -- new updatedAt, status still Нова. This is the
  //    delivery that used to produce a duplicate message.
  const attachment = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', updatedAt: '2026-08-13T08:35:47.314Z' })
  );
  assert.equal(attachment.status, 'processed');
  assert.equal(wouldSend(STATE_ONLY_RULE, attachment), false, 'attachment must not re-notify');

  // 3. Description edited, still Нова.
  const edited = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', subject: 'Оновлена назва', updatedAt: '2026-08-13T08:36:31.228Z' })
  );
  assert.equal(wouldSend(STATE_ONLY_RULE, edited), false, 'unrelated edit must not re-notify');
});

test('a state-only rule fires again if the work package leaves and re-enters the state', () => {
  const db = createTestDb();
  processWebhookEvent(db, snapshot());

  const movedAway = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 5, name: 'В роботі' }, updatedAt: '2026-08-13T09:00:00Z' })
  );
  assert.equal(wouldSend(STATE_ONLY_RULE, movedAway), false);

  const cameBack = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 1, name: 'Нова' }, updatedAt: '2026-08-13T10:00:00Z' })
  );
  assert.equal(wouldSend(STATE_ONLY_RULE, cameBack), true, 're-entering the state is a real new event');
});

test('the "Відправлено" rule notifies on the transition, then stays quiet', () => {
  // Mirrors the live "✅ Телеграма - Відправлено" rule.
  const rule = {
    type: 'group',
    operator: 'AND',
    children: [
      { type: 'condition', field: 'type', operator: 'equals', value: 'Телеграма' },
      { type: 'condition', field: 'status', operator: 'equals', value: 'Відправлено ✨' },
    ],
  };
  const db = createTestDb();

  processWebhookEvent(db, snapshot());
  const sent = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 9, name: 'Відправлено ✨' }, updatedAt: '2026-08-13T11:00:00Z' })
  );
  assert.equal(wouldSend(rule, sent), true, 'fires when it becomes Відправлено');

  const afterAttachment = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 9, name: 'Відправлено ✨' }, updatedAt: '2026-08-13T11:05:00Z' })
  );
  assert.equal(wouldSend(rule, afterAttachment), false, 'no repeat while it stays Відправлено');
});

test('edge-triggering does not suppress explicit transition conditions', () => {
  const db = createTestDb();
  processWebhookEvent(db, snapshot());

  const changedTo = {
    type: 'condition',
    field: 'status',
    operator: 'changed_to',
    value: 'Відправлено ✨',
  };
  const transition = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', status: { id: 9, name: 'Відправлено ✨' }, updatedAt: '2026-08-13T12:00:00Z' })
  );
  assert.equal(wouldSend(changedTo, transition), true);
  assert.equal(ruleAlreadyMatched(changedTo, transition.changeSet), false, 'a transition is never true of the past');
});

test('a created-event rule still fires exactly once', () => {
  const rule = { type: 'condition', operator: 'event_type_created' };
  const db = createTestDb();

  const created = processWebhookEvent(db, snapshot());
  assert.equal(wouldSend(rule, created), true);

  const later = processWebhookEvent(
    db,
    snapshot({ action: 'work_package:updated', updatedAt: '2026-08-13T13:00:00Z' })
  );
  assert.equal(wouldSend(rule, later), false);
});

// The live "🔍 Notify assignee" rule: a state branch and a transition branch
// under one OR. Reassigning a ticket that was already Нова used to be
// suppressed -- the OR was "already true" through status alone, so the
// assignee change never reached anyone.
const NOTIFY_ASSIGNEE_RULE = {
  type: 'group',
  operator: 'AND',
  children: [
    { type: 'condition', field: 'type', operator: 'equals', value: '9' },
    {
      type: 'group',
      operator: 'OR',
      children: [
        { type: 'condition', field: 'status', operator: 'equals', value: '15' },
        { type: 'condition', field: 'assignee', operator: 'any_change', value: '' },
      ],
    },
  ],
};

function request(overrides = {}) {
  return snapshot({ type: { id: 9, name: 'Запит' }, status: { id: 15, name: 'Нова' }, ...overrides });
}

test('a transition condition fires even when a sibling OR branch was already true', () => {
  const db = createTestDb();

  const created = processWebhookEvent(db, request({ assignee: { id: 7, name: 'Андрій' } }));
  assert.equal(wouldSend(NOTIFY_ASSIGNEE_RULE, created), true, 'assignee set at creation is notified');

  const reassigned = processWebhookEvent(
    db,
    request({ action: 'work_package:updated', assignee: { id: 8, name: 'Ярослав' }, updatedAt: '2026-08-13T09:00:00Z' })
  );
  assert.equal(wouldSend(NOTIFY_ASSIGNEE_RULE, reassigned), true, 'reassignment while still Нова is notified');

  const edited = processWebhookEvent(
    db,
    request({ action: 'work_package:updated', assignee: { id: 8, name: 'Ярослав' }, subject: 'x', updatedAt: '2026-08-13T10:00:00Z' })
  );
  assert.equal(wouldSend(NOTIFY_ASSIGNEE_RULE, edited), false, 'an unrelated edit still does not re-notify');
});

test('a created-event OR branch is not suppressed by a state branch true of the empty prior state', () => {
  // `is_empty` is true of "nothing" -- the prior state of a brand-new ticket.
  const rule = {
    type: 'group',
    operator: 'OR',
    children: [
      { type: 'condition', operator: 'event_type_created' },
      { type: 'condition', field: 'assignee', operator: 'is_empty' },
    ],
  };
  const db = createTestDb();
  const created = processWebhookEvent(db, snapshot());
  assert.equal(wouldSend(rule, created), true);
});
