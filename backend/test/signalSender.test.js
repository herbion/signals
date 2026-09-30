import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, sendReaction } from '../src/signal/signalSender.js';
import { createTestDb } from './testDb.js';

function dbWith(overrides = {}) {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO signal_settings (id, signal_api_base_url, bot_number, text_mode)
     VALUES (1, 'http://signal-api:8080', '+15550000000', ?)`
  ).run(overrides.textMode ?? 'styled');
  return db;
}

/** Captures the /v2/send request body instead of hitting the network. */
function captureSend() {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 201, text: async () => '' };
  });
  return calls;
}

test('styled text mode is sent to /v2/send so Signal renders the formatting', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  await sendMessage(dbWith({ textMode: 'styled' }), {
    recipient: '+380996075027',
    message: '**Closed:** ||secret|| ~old~ `code`',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/send$/);
  assert.equal(calls[0].body.text_mode, 'styled');
  assert.equal(calls[0].body.message, '**Closed:** ||secret|| ~old~ `code`');
  assert.deepEqual(calls[0].body.recipients, ['+380996075027']);
});

test('normal text mode sends markup literally', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  await sendMessage(dbWith({ textMode: 'normal' }), { recipient: '+380996075027', message: '**not bold**' });

  assert.equal(calls[0].body.text_mode, 'normal');
});

test('text_mode is always sent explicitly, so the container env default cannot override it', async (t) => {
  const calls = captureSend();
  t.after(() => mock.restoreAll());

  await sendMessage(dbWith({ textMode: 'normal' }), { recipient: '+1', message: 'hi' });
  assert.ok(Object.prototype.hasOwnProperty.call(calls[0].body, 'text_mode'));
});

test('every request carries a deadline, so a wedged signal-cli cannot stall the pipeline', async (t) => {
  const signals = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    signals.push(options.signal);
    return { ok: true, status: 201, text: async () => '' };
  });
  t.after(() => mock.restoreAll());

  await sendMessage(dbWith(), { recipient: '+1', message: 'hi' });
  await sendReaction(dbWith(), {
    recipient: 'group.abc',
    targetAuthor: '3527919e-add8-4987-91d5-d7f25d117409',
    timestamp: 1788687570244,
    emoji: '👀',
  });

  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('a transport failure reports the underlying cause, not a bare "fetch failed"', async (t) => {
  mock.method(globalThis, 'fetch', async () => {
    // What undici actually throws: a useless message with the real reason
    // hidden on `cause`. That cause is what someone reading the failure
    // notice needs.
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED 172.18.0.3:8080'),
    });
  });
  t.after(() => mock.restoreAll());

  await assert.rejects(
    () => sendMessage(dbWith(), { recipient: '+1', message: 'hi' }),
    /ECONNREFUSED/
  );
});

test('a request that never answers fails as a timeout naming signal-cli', async (t) => {
  mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  });
  t.after(() => mock.restoreAll());

  await assert.rejects(
    () => sendMessage(dbWith(), { recipient: '+1', message: 'hi' }),
    /no response in 30s.*is signal-cli alive/s
  );
});
