import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchMessage,
  findDueRecipients,
  dispatchDueBatches,
} from '../src/signal/outboundDispatcher.js';
import * as messageLogRepo from '../src/messageLog/messageLog.repository.js';
import { createTestDb } from './testDb.js';

function dbWith({ windowSeconds = 60, textMode = 'styled' } = {}) {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO signal_settings (id, signal_api_base_url, bot_number, text_mode, grouping_enabled, grouping_window_seconds)
     VALUES (1, 'http://signal-api:8080', '+15550000000', ?, 1, ?)`
  ).run(textMode, windowSeconds);
  return db;
}

/** Queues a pending message, optionally backdated so its window has elapsed. */
function queue(db, recipient, content, { secondsAgo = 0 } = {}) {
  messageLogRepo.insert(db, { direction: 'outbound', recipient, content, status: 'pending' });
  if (secondsAgo) {
    db.prepare(
      `UPDATE message_log SET created_at = datetime('now', @offset) WHERE id = (SELECT MAX(id) FROM message_log)`
    ).run({ offset: `-${secondsAgo} seconds` });
  }
}

function captureSend() {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 201, text: async () => '' };
  });
  return calls;
}

test('a single queued message is sent verbatim, with no batch header', () => {
  assert.equal(buildBatchMessage(['only one'], { textMode: 'styled' }), 'only one');
});

test('several messages are combined under one header', () => {
  const out = buildBatchMessage(['first', 'second', 'third'], { textMode: 'styled' });
  assert.match(out, /^📬 \*\*3 updates\*\*/);
  assert.ok(out.includes('first') && out.includes('second') && out.includes('third'));
  assert.equal(out.split('\n\n').length, 4, 'header plus each message');
});

test('the batch header respects plain text mode', () => {
  const out = buildBatchMessage(['a', 'b'], { textMode: 'normal' });
  assert.ok(out.startsWith('📬 2 updates'), 'no markdown asterisks in plain mode');
});

test('a batch is not due until the window has elapsed', () => {
  const db = dbWith({ windowSeconds: 60 });
  queue(db, '+380996075027', 'fresh');
  assert.deepEqual(findDueRecipients(db, 60), [], 'still inside the window');

  queue(db, '+380930259044', 'old', { secondsAgo: 120 });
  const due = findDueRecipients(db, 60);
  assert.equal(due.length, 1);
  assert.equal(due[0].recipient, '+380930259044');
});

test('the window runs from the first queued message, so a burst cannot postpone delivery', () => {
  const db = dbWith({ windowSeconds: 60 });
  queue(db, '+380996075027', 'first', { secondsAgo: 90 });
  queue(db, '+380996075027', 'second'); // arrives now — must not reset the clock

  const due = findDueRecipients(db, 60);
  assert.equal(due.length, 1);
  assert.equal(due[0].queued, 2, 'both messages go out together');
});

test('one Signal message is sent per recipient, covering all their queued messages', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = dbWith({ windowSeconds: 60 });
  queue(db, '+380996075027', 'WP #1 closed', { secondsAgo: 90 });
  queue(db, '+380996075027', 'WP #2 closed', { secondsAgo: 80 });
  queue(db, '+380996075027', 'WP #3 closed', { secondsAgo: 70 });
  queue(db, '+380930259044', 'WP #4 closed', { secondsAgo: 90 });

  const result = await dispatchDueBatches(db);

  assert.equal(result.batches, 2, 'one batch per recipient');
  assert.equal(calls.length, 2, 'two Signal API calls, not four');

  const first = calls.find((c) => c.recipients[0] === '+380996075027');
  assert.match(first.message, /3 updates/);
  assert.ok(['#1', '#2', '#3'].every((n) => first.message.includes(n)));

  const second = calls.find((c) => c.recipients[0] === '+380930259044');
  assert.equal(second.message, 'WP #4 closed', 'a lone message keeps its own text');

  const pending = db.prepare("SELECT COUNT(*) n FROM message_log WHERE status = 'pending'").get().n;
  assert.equal(pending, 0, 'everything dispatched is marked sent');
});

test('rows delivered together share a batch id', async (t) => {
  captureSend();
  t.after(() => mock.restoreAll());

  const db = dbWith({ windowSeconds: 0 });
  queue(db, '+380996075027', 'a');
  queue(db, '+380996075027', 'b');
  await dispatchDueBatches(db);

  const ids = db.prepare('SELECT DISTINCT batch_id FROM message_log WHERE batch_id IS NOT NULL').all();
  assert.equal(ids.length, 1, 'both rows carry the same batch id');
  const sent = db.prepare("SELECT COUNT(*) n FROM message_log WHERE status = 'sent'").get().n;
  assert.equal(sent, 2);
});

test('a failed batch marks every message in it failed, with the reason', async (t) => {
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 400, text: async () => 'bad number' }));
  t.after(() => mock.restoreAll());

  const db = dbWith({ windowSeconds: 0 });
  queue(db, '+380996075027', 'a');
  queue(db, '+380996075027', 'b');
  await dispatchDueBatches(db);

  const rows = db.prepare('SELECT status, error_message FROM message_log').all();
  assert.ok(rows.every((r) => r.status === 'failed'));
  assert.ok(rows.every((r) => /400/.test(r.error_message)));
});

test('dispatching twice does not send the same messages again', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = dbWith({ windowSeconds: 0 });
  queue(db, '+380996075027', 'a');

  await dispatchDueBatches(db);
  await dispatchDueBatches(db);

  assert.equal(calls.length, 1, 'already-claimed rows are not re-sent');
});

test('queued messages still drain after grouping is switched off', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  const db = dbWith({ windowSeconds: 0 });
  queue(db, '+380996075027', 'queued earlier');
  db.prepare('UPDATE signal_settings SET grouping_enabled = 0 WHERE id = 1').run();

  await dispatchDueBatches(db);
  assert.equal(calls.length, 1, 'pending rows are not stranded by the setting change');
});
