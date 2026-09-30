import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditionTree, buildEvaluationContext } from '../src/rules/ruleEvaluator.js';

function ctx(changeSet, eventType = null) {
  return buildEvaluationContext(changeSet, eventType);
}

test('changed_to matches only when the field changed to the given value', () => {
  const tree = { type: 'condition', field: 'status', operator: 'changed_to', value: 'Closed' };
  const matched = ctx([{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true }]);
  const unmatched = ctx([{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 3, name: 'Open' }, changed: true }]);
  const unchanged = ctx([{ field: 'status', from: { id: 2, name: 'Closed' }, to: { id: 2, name: 'Closed' }, changed: false }]);
  assert.equal(evaluateConditionTree(tree, matched), true);
  assert.equal(evaluateConditionTree(tree, unmatched), false);
  assert.equal(evaluateConditionTree(tree, unchanged), false);
});

test('changed_from_to requires both endpoints to match', () => {
  const tree = { type: 'condition', field: 'status', operator: 'changed_from_to', fromValue: 'New', value: 'Closed' };
  const matches = ctx([{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true }]);
  const wrongFrom = ctx([{ field: 'status', from: { id: 5, name: 'Open' }, to: { id: 2, name: 'Closed' }, changed: true }]);
  assert.equal(evaluateConditionTree(tree, matches), true);
  assert.equal(evaluateConditionTree(tree, wrongFrom), false);
});

test('AND group requires every child to match', () => {
  const tree = {
    type: 'group',
    operator: 'AND',
    children: [
      { type: 'condition', field: 'type', operator: 'equals', value: 'Bug' },
      { type: 'condition', field: 'status', operator: 'changed_to', value: 'Closed' },
    ],
  };
  const bothMatch = ctx([
    { field: 'type', from: null, to: { id: 1, name: 'Bug' }, changed: false },
    { field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true },
  ]);
  const onlyOneMatches = ctx([
    { field: 'type', from: null, to: { id: 2, name: 'Feature' }, changed: false },
    { field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true },
  ]);
  assert.equal(evaluateConditionTree(tree, bothMatch), true);
  assert.equal(evaluateConditionTree(tree, onlyOneMatches), false);
});

test('OR group requires at least one child to match', () => {
  const tree = {
    type: 'group',
    operator: 'OR',
    children: [
      { type: 'condition', field: 'status', operator: 'changed_to', value: 'Closed' },
      { type: 'condition', field: 'status', operator: 'changed_to', value: 'Rejected' },
    ],
  };
  const matchesSecond = ctx([{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 4, name: 'Rejected' }, changed: true }]);
  const matchesNeither = ctx([{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 9, name: 'On hold' }, changed: true }]);
  assert.equal(evaluateConditionTree(tree, matchesSecond), true);
  assert.equal(evaluateConditionTree(tree, matchesNeither), false);
});

test('empty group: AND is vacuously true, OR is vacuously false', () => {
  assert.equal(evaluateConditionTree({ type: 'group', operator: 'AND', children: [] }, ctx([])), true);
  assert.equal(evaluateConditionTree({ type: 'group', operator: 'OR', children: [] }, ctx([])), false);
});

test('event_type_created ignores field and matches on the synthetic event type', () => {
  const tree = { type: 'condition', operator: 'event_type_created' };
  assert.equal(evaluateConditionTree(tree, ctx([], 'created')), true);
  assert.equal(evaluateConditionTree(tree, ctx([], null)), false);
});

test('nested groups evaluate recursively', () => {
  const tree = {
    type: 'group',
    operator: 'OR',
    children: [
      { type: 'condition', operator: 'event_type_created' },
      {
        type: 'group',
        operator: 'AND',
        children: [
          { type: 'condition', field: 'type', operator: 'equals', value: 'Bug' },
          { type: 'condition', field: 'status', operator: 'any_change' },
        ],
      },
    ],
  };
  const bugStatusChanged = ctx([
    { field: 'type', from: null, to: { id: 1, name: 'Bug' }, changed: false },
    { field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true },
  ]);
  assert.equal(evaluateConditionTree(tree, bugStatusChanged), true);
});

test('is_empty / is_not_empty handle null and relation-shaped values', () => {
  const emptyTree = { type: 'condition', field: 'assignee', operator: 'is_empty' };
  assert.equal(evaluateConditionTree(emptyTree, ctx([{ field: 'assignee', from: null, to: null, changed: false }])), true);
  assert.equal(
    evaluateConditionTree(emptyTree, ctx([{ field: 'assignee', from: null, to: { id: 1, name: 'Jo' }, changed: false }])),
    false
  );
});
