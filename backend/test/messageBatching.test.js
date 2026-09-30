import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packMessages, MAX_MESSAGE_LENGTH } from '../src/signal/messageBatching.js';

test('a few short parts are combined into one message', () => {
  const batches = packMessages(['🎫 #1787 ...', '🎫 #1788 ...', '✅ Approved — 2 actions run.']);
  assert.deepEqual(batches, ['🎫 #1787 ...\n\n🎫 #1788 ...\n\n✅ Approved — 2 actions run.']);
});

test('empty and blank parts are dropped rather than leaving stray separators', () => {
  const batches = packMessages(['first', '', '   ', null, undefined, 'second']);
  assert.deepEqual(batches, ['first\n\nsecond']);
});

test('a single part is returned as-is, without a trailing separator', () => {
  assert.deepEqual(packMessages(['only one']), ['only one']);
});

test('no parts produces no messages', () => {
  assert.deepEqual(packMessages([]), []);
});

test('packing never exceeds maxLength, splitting into a new message instead', () => {
  const part = 'x'.repeat(900);
  // Three of these plus separators would be ~2704 chars -- over the default
  // cap -- so the third must start a second message.
  const batches = packMessages([part, part, part]);
  assert.equal(batches.length, 2);
  for (const batch of batches) assert.ok(batch.length <= MAX_MESSAGE_LENGTH);
  assert.equal(batches[0], `${part}\n\n${part}`);
  assert.equal(batches[1], part);
});

test('a single part longer than maxLength is sent on its own rather than cut in half', () => {
  const huge = 'y'.repeat(MAX_MESSAGE_LENGTH + 500);
  const batches = packMessages(['short', huge]);
  assert.deepEqual(batches, ['short', huge]);
});

test('a custom maxLength is honoured', () => {
  const batches = packMessages(['aaa', 'bbb', 'ccc'], { maxLength: 8 });
  assert.deepEqual(batches, ['aaa\n\nbbb', 'ccc']);
});
