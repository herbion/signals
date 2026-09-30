import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDurationDates } from '../src/signal/inboundActionExecutor.js';

test('computeDurationDates sets startDate to today and dueDate N calendar days later', () => {
  const now = new Date('2026-08-31T21:45:00Z');
  assert.deepEqual(computeDurationDates(10, now), { startDate: '2026-08-31', dueDate: '2026-09-10' });
});

test('computeDurationDates rolls dueDate across a month/year boundary', () => {
  const now = new Date('2026-12-28T05:00:00Z');
  assert.deepEqual(computeDurationDates(5, now), { startDate: '2026-12-28', dueDate: '2027-01-02' });
});

test('computeDurationDates returns null for zero, negative, or non-numeric input', () => {
  const now = new Date('2026-08-31T21:45:00Z');
  assert.equal(computeDurationDates(0, now), null);
  assert.equal(computeDurationDates(-3, now), null);
  assert.equal(computeDurationDates('', now), null);
  assert.equal(computeDurationDates(undefined, now), null);
  assert.equal(computeDurationDates('not a number', now), null);
});

test('computeDurationDates truncates to the calendar day, ignoring time of day', () => {
  const now = new Date('2026-08-31T23:59:00Z');
  assert.deepEqual(computeDurationDates(1, now), { startDate: '2026-08-31', dueDate: '2026-09-01' });
});
