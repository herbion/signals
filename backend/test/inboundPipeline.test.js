import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { handleInboundMessage } from '../src/signal/inboundMessageHandler.js';
import { resetGroupCache } from '../src/signal/signalGroups.js';
import { resetSchemaCache } from '../src/signal/inboundActionExecutor.js';

// The two ids of the same Signal group. `internal_id` is what arrives on a
// received envelope; `group.<base64>` is what /v2/send accepts as a recipient.
const GROUP_INTERNAL = 'UzgNEJTrxQaG35vhrh8Qrqv83nsGtkL2rprGE+tI4G4=';
const GROUP_SEND_ID = 'group.VXpnTkVKVHJ4UWFHMzV2aHJoOFFycXY4M25zR3RrTDJycHJHRSt0STRHND0=';

function setupDb({ subscribeGroup = true, allowDirect = 1, allGroups = 0 } = {}) {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO openproject_settings (id, base_url, api_key)
     VALUES (1, 'https://openproject.example.com', 'test-token')`
  ).run();
  db.prepare(
    `INSERT INTO signal_settings
       (id, signal_api_base_url, bot_number, default_project_id,
        allow_direct_messages, subscribe_all_groups, auto_reply_enabled, receive_enabled)
     VALUES (1, 'http://signal-api:8080', '+15550000000', '7', @allowDirect, @allGroups, 0, 1)`
  ).run({ allowDirect, allGroups });
  if (subscribeGroup) {
    db.prepare(
      `INSERT INTO signal_group_subscriptions (group_id, internal_id, name, enabled)
       VALUES (?, ?, 'Ops', 1)`
    ).run(GROUP_SEND_ID, GROUP_INTERNAL);
  }
  return db;
}

function addRule(db, rule, actions) {
  const info = db
    .prepare(
      `INSERT INTO inbound_rules (name, enabled, priority, source_scope, source_group_ids,
                                  match_type, pattern, pattern_flags, stop_processing)
       VALUES (@name, 1, @priority, @scope, @groupIds, @matchType, @pattern, @flags, @stop)`
    )
    .run({
      name: rule.name,
      priority: rule.priority ?? 0,
      scope: rule.scope ?? 'any',
      groupIds: rule.groupIds ? JSON.stringify(rule.groupIds) : null,
      matchType: rule.matchType ?? 'regex',
      pattern: rule.pattern ?? null,
      flags: rule.flags ?? 'i',
      stop: rule.stop === undefined ? 1 : rule.stop,
    });
  const ruleId = Number(info.lastInsertRowid);
  actions.forEach((action, index) => {
    db.prepare(
      `INSERT INTO inbound_rule_actions
         (rule_id, position, action_type, emoji, project_id, type_id,
          subject_template, description_template, message_template, reply_target, reply_raw,
          field_templates, fan_out, require_approval, approval_recipient, failure_recipient,
          include_provenance, duration_days)
       VALUES (@ruleId, @position, @type, @emoji, @projectId, @typeId,
               @subject, @description, @message, @replyTarget, @replyRaw, @fieldTemplates,
               @fanOut, @requireApproval, @approvalRecipient, @failureRecipient, @includeProvenance,
               @durationDays)`
    ).run({
      ruleId,
      position: index,
      type: action.type,
      emoji: action.emoji ?? null,
      projectId: action.projectId ?? null,
      typeId: action.typeId ?? null,
      subject: action.subject ?? null,
      description: action.description ?? null,
      message: action.message ?? null,
      replyTarget: action.replyTarget ?? 'source',
      replyRaw: action.replyRaw ?? null,
      fieldTemplates: action.fieldTemplates ? JSON.stringify(action.fieldTemplates) : null,
      fanOut: action.fanOut ?? 'pair',
      requireApproval: action.requireApproval ? 1 : 0,
      approvalRecipient: action.approvalRecipient ?? null,
      failureRecipient: action.failureRecipient ?? null,
      includeProvenance: action.includeProvenance === false ? 0 : 1,
      durationDays: action.durationDays ?? null,
    });
  });
  return ruleId;
}

function groupEnvelope(text, { timestamp = 1700000000000, source = '+15551112222' } = {}) {
  return {
    source,
    sourceNumber: source,
    sourceUuid: 'uuid-sender-1',
    sourceName: 'Ann',
    timestamp,
    dataMessage: { timestamp, message: text, groupInfo: { groupId: GROUP_INTERNAL } },
  };
}

function directEnvelope(text, { timestamp = 1700000000001, source = '+15551112222' } = {}) {
  return {
    source,
    sourceNumber: source,
    sourceUuid: 'uuid-sender-1',
    sourceName: 'Ann',
    timestamp,
    dataMessage: { timestamp, message: text },
  };
}

/**
 * A work package form response shaped like the real one: OpenProject answers
 * `POST /projects/:id/work_packages/form` with the schema for that type.
 */
function formResponse(schema = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      _embedded: {
        schema: {
          subject: { type: 'String', name: 'Subject', required: true, hasDefault: false, writable: true },
          description: { type: 'Formattable', name: 'Description', required: false, writable: true },
          ...schema,
        },
        validationErrors: {},
      },
    }),
  };
}

/** Records every outbound HTTP call so assertions can inspect them. */
function stubFetch(calls, { workPackageId = 101, schema = {} } = {}) {
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({
      url: String(url),
      body: options?.body ? JSON.parse(options.body) : null,
      method: options?.method,
    });
    if (String(url).includes('/work_packages/form')) return formResponse(schema);
    if (String(url).includes('/api/v3/work_packages')) {
      return { ok: true, status: 201, json: async () => ({ id: workPackageId, subject: 'stub' }) };
    }
    if (String(url).includes('/v2/send')) {
      sentAt += 1;
      return { ok: true, status: 201, text: async () => '', json: async () => ({ timestamp: sentAt }) };
    }
    return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
  });
}

// The timestamp signal-cli hands back for each /v2/send, which is a message's
// only identity and what a reaction to it targets.
let sentAt = 1700000900000;
beforeEach(() => {
  sentAt = 1700000900000;
});

function reactionEnvelope(emoji, targetTimestamp, { timestamp = 1700000009000, source = '+15557654321' } = {}) {
  return {
    source,
    sourceNumber: source,
    sourceUuid: 'uuid-reviewer',
    sourceName: 'Chief',
    timestamp,
    dataMessage: {
      timestamp,
      message: null,
      reaction: {
        emoji,
        targetAuthor: '+15550000000',
        targetAuthorNumber: '+15550000000',
        targetSentTimestamp: targetTimestamp,
        isRemove: false,
      },
    },
  };
}

beforeEach(() => {
  mock.restoreAll();
  resetGroupCache();
  resetSchemaCache();
});

test('a message from a subscribed group is logged and fires its rule', async () => {
  const db = setupDb();
  addRule(db, { name: 'Task', pattern: String.raw`^!task\s+(.+)$` }, [
    { type: 'send_message', message: 'Got it: {1}' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task Fix the printer'));

  const inbound = db.prepare("SELECT * FROM message_log WHERE direction = 'inbound'").all();
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].content, '!task Fix the printer');

  const send = calls.find((c) => c.url.includes('/v2/send'));
  assert.equal(send.body.message, 'Got it: Fix the printer');
});

test('a group reply is addressed with the sendable group id, not the envelope id', async () => {
  const db = setupDb();
  addRule(db, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task something'));

  const send = calls.find((c) => c.url.includes('/v2/send'));
  // Sending to GROUP_INTERNAL is the bug this guards: signal-cli rejects it.
  assert.deepEqual(send.body.recipients, [GROUP_SEND_ID]);
});

test('messages from groups that are not subscribed are ignored entirely', async () => {
  const db = setupDb({ subscribeGroup: false });
  addRule(db, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task something'));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log WHERE direction = 'inbound'").get().n, 0);
  assert.equal(calls.length, 0);
});

test('subscribe_all_groups accepts a group with no explicit subscription', async () => {
  const db = setupDb({ subscribeGroup: false, allGroups: 1 });
  addRule(db, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task something'));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log WHERE direction = 'inbound'").get().n, 1);
});

test('direct messages are handled, and can be switched off independently of groups', async () => {
  const on = setupDb();
  addRule(on, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);
  await handleInboundMessage(on, directEnvelope('!task from a DM'));
  assert.equal(on.prepare("SELECT COUNT(*) n FROM message_log WHERE direction = 'inbound'").get().n, 1);
  assert.deepEqual(calls.find((c) => c.url.includes('/v2/send')).body.recipients, ['+15551112222']);

  const off = setupDb({ allowDirect: 0 });
  addRule(off, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  await handleInboundMessage(off, directEnvelope('!task from a DM'));
  assert.equal(off.prepare("SELECT COUNT(*) n FROM message_log WHERE direction = 'inbound'").get().n, 0);
});

test('the same envelope delivered twice is only acted on once', async () => {
  const db = setupDb();
  addRule(db, { name: 'Task', pattern: '!task' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  const envelope = groupEnvelope('!task duplicate me');
  await handleInboundMessage(db, envelope);
  await handleInboundMessage(db, envelope);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log WHERE direction = 'inbound'").get().n, 1);
  assert.equal(calls.filter((c) => c.url.includes('/v2/send')).length, 1);
});

test('the bot own messages never trigger rules', async () => {
  const db = setupDb();
  addRule(db, { name: 'Catch all', matchType: 'any' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  // Echoed back from another linked device...
  await handleInboundMessage(db, {
    source: '+15550000000',
    sourceNumber: '+15550000000',
    timestamp: 1,
    syncMessage: { sentMessage: { timestamp: 1, message: 'ack', groupInfo: { groupId: GROUP_INTERNAL } } },
  });
  // ...and arriving as an ordinary message from our own number.
  await handleInboundMessage(db, groupEnvelope('ack', { source: '+15550000000', timestamp: 2 }));

  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message_log').get().n, 0);
});

test('a react action targets the message by author and sent timestamp', async () => {
  const db = setupDb();
  addRule(db, { name: 'Ack', pattern: '!task' }, [{ type: 'react', emoji: '👀' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task look at me', { timestamp: 1700000009999 }));

  const reaction = calls.find((c) => c.url.includes('/v1/reactions/'));
  assert.equal(reaction.method, 'POST');
  assert.equal(reaction.body.reaction, '👀');
  assert.equal(reaction.body.recipient, GROUP_SEND_ID);
  assert.equal(reaction.body.target_author, '+15551112222');
  assert.equal(reaction.body.timestamp, 1700000009999);
});

test('a create_ticket action renders subject and description from capture groups', async () => {
  const db = setupDb();
  addRule(db, { name: 'Bug', pattern: String.raw`^!bug\s+(?<subject>.+)$` }, [
    {
      type: 'create_ticket',
      subject: '[Signal] {subject}',
      description: 'Reported: {subject}',
      projectId: '3',
    },
  ]);
  const calls = [];
  stubFetch(calls, { workPackageId: 555 });

  await handleInboundMessage(db, groupEnvelope('!bug Printer is on fire'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.equal(create.body.subject, '[Signal] Printer is on fire');
  assert.match(create.body.description.raw, /Reported: Printer is on fire/);
  // Provenance header so the ticket says where it came from.
  assert.match(create.body.description.raw, /Ann \(\+15551112222\)/);
  assert.equal(create.body._links.project.href, '/api/v3/projects/3');

  const logged = db.prepare("SELECT * FROM message_log WHERE direction = 'outbound'").get();
  assert.equal(logged.work_package_id, 555);
});

test('the provenance block is a footer, appended after the rendered body', async () => {
  const db = setupDb();
  addRule(db, { name: 'Bug', pattern: String.raw`^!bug\s+(?<subject>.+)$` }, [
    { type: 'create_ticket', subject: '[Signal] {subject}', description: 'Reported: {subject}', projectId: '3' },
  ]);
  const calls = [];
  stubFetch(calls, { workPackageId: 555 });

  await handleInboundMessage(db, groupEnvelope('!bug Printer is on fire'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  const raw = create.body.description.raw;
  assert.ok(raw.indexOf('Reported: Printer is on fire') < raw.indexOf('Reported by:'));
});

test('include_provenance = false renders the description with nothing appended', async () => {
  const db = setupDb();
  addRule(db, { name: 'Bug', pattern: String.raw`^!bug\s+(?<subject>.+)$` }, [
    {
      type: 'create_ticket',
      subject: '[Signal] {subject}',
      description: '<p>Custom layout: {subject}</p>',
      projectId: '3',
      includeProvenance: false,
    },
  ]);
  const calls = [];
  stubFetch(calls, { workPackageId: 555 });

  await handleInboundMessage(db, groupEnvelope('!bug Printer is on fire'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.equal(create.body.description.raw, '<p>Custom layout: Printer is on fire</p>');
});

test('{base_url} is available to a create_ticket action\'s templates', async () => {
  const db = setupDb();
  addRule(db, { name: 'Bug', pattern: String.raw`^!bug\s+(?<subject>.+)$` }, [
    {
      type: 'create_ticket',
      subject: '[Signal] {subject}',
      description: '<a href="{base_url}/search?q={subject|urlencode}">{subject}</a>',
      projectId: '3',
      includeProvenance: false,
    },
  ]);
  const calls = [];
  stubFetch(calls, { workPackageId: 555 });

  await handleInboundMessage(db, groupEnvelope('!bug Printer is on fire'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.equal(
    create.body.description.raw,
    '<a href="https://openproject.example.com/search?q=Printer+is+on+fire">Printer is on fire</a>'
  );
});

// Mirrors this install's "Довідка" type: OpenProject generates the subject
// from a pattern, and a custom field is mandatory.
const GENERATED_SUBJECT_SCHEMA = {
  subject: {
    type: 'String',
    name: 'Subject',
    required: true,
    hasDefault: true,
    writable: false,
    placeholder: 'Automatically generated through type Довідка',
  },
  customField1: {
    type: '[]CustomOption',
    name: '🌀Тип довідки',
    required: true,
    hasDefault: false,
    writable: true,
    location: '_links',
    _embedded: {
      allowedValues: [
        { id: 1, value: 'Форма 5', _links: { self: { href: '/api/v3/custom_options/1' } } },
        { id: 313, value: 'Інше', _links: { self: { href: '/api/v3/custom_options/313' } } },
      ],
    },
  },
  customField21: { type: 'String', name: '🎯На кого', required: true, hasDefault: false, writable: true },
  // On this install every type reports author as required but NOT writable --
  // OpenProject always sets it to the authenticating API user. Sending it
  // anyway is a 422: "Author was attempted to be written but is not writable."
  author: { type: 'User', name: 'Author', required: true, hasDefault: false, writable: false, location: '_links' },
};

test('a type with mandatory custom fields is created with them, and its generated subject is left alone', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідка', pattern: String.raw`^!dovidka\s+(?<who>.+)$` }, [
    {
      type: 'create_ticket',
      projectId: '3',
      typeId: '8',
      subject: 'ignored by OpenProject',
      fieldTemplates: { customField1: '313', customField21: '{who}' },
    },
  ]);
  const calls = [];
  stubFetch(calls, { workPackageId: 900, schema: GENERATED_SUBJECT_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!dovidka Іванов І.І.'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.ok(create, 'the work package should have been created');
  // Posting a subject to a type that generates its own is a 422.
  assert.equal(create.body.subject, undefined);
  assert.equal(create.body.customField21, 'Іванов І.І.');
  assert.deepEqual(create.body._links.customField1, [{ href: '/api/v3/custom_options/313' }]);
  assert.deepEqual(create.body._links.type, { href: '/api/v3/types/8' });
});

test('author is left out of the payload when the schema reports it as not writable', async () => {
  const db = setupDb();
  // A sender who does map to a synced OpenProject user -- this is exactly the
  // case that used to trigger the "Author was attempted to be written but is
  // not writable" 422, since the app then tried to set it anyway.
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, openproject_user_id)
     VALUES ('Ann', 'individual', '+15551112222', 42)`
  ).run();
  addRule(db, { name: 'Довідка', pattern: '!dovidka' }, [
    {
      type: 'create_ticket',
      projectId: '3',
      typeId: '8',
      fieldTemplates: { customField1: '313', customField21: 'x' },
    },
  ]);
  const calls = [];
  stubFetch(calls, { schema: GENERATED_SUBJECT_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!dovidka something'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.ok(create, 'the work package should have been created');
  assert.equal(create.body._links.author, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log WHERE status = 'failed'").get().n, 0);
});

test('author is sent when the schema says it is writable', async () => {
  const db = setupDb();
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, openproject_user_id)
     VALUES ('Ann', 'individual', '+15551112222', 42)`
  ).run();
  addRule(db, { name: 'Task', pattern: '!task' }, [{ type: 'create_ticket', projectId: '3', typeId: '1' }]);
  const calls = [];
  // A schema where author IS writable, unlike this install's types.
  stubFetch(calls, {
    schema: { author: { type: 'User', name: 'Author', required: false, hasDefault: false, writable: true, location: '_links' } },
  });

  await handleInboundMessage(db, groupEnvelope('!task something'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.deepEqual(create.body._links.author, { href: '/api/v3/users/42' });
});

test('a rule missing a mandatory custom field says which one, by its OpenProject name', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідка', pattern: '!dovidka' }, [
    { type: 'create_ticket', projectId: '3', typeId: '8', fieldTemplates: { customField21: 'Іванов' } },
  ]);
  const calls = [];
  stubFetch(calls, { schema: GENERATED_SUBJECT_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!dovidka something'));

  // No POST to create -- it was stopped before that, with a usable reason.
  assert.equal(calls.some((c) => c.url.endsWith('/api/v3/work_packages')), false);
  const failed = db.prepare("SELECT * FROM message_log WHERE status = 'failed'").get();
  assert.match(failed.error_message, /🌀Тип довідки/);
  assert.match(failed.error_message, /customField1/);
});

test('the form schema is fetched once per project and type, not per message', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідка', pattern: '!dovidka' }, [
    {
      type: 'create_ticket',
      projectId: '3',
      typeId: '8',
      fieldTemplates: { customField1: '1', customField21: 'x' },
    },
  ]);
  const calls = [];
  stubFetch(calls, { schema: GENERATED_SUBJECT_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!dovidka one', { timestamp: 1700000000101 }));
  await handleInboundMessage(db, groupEnvelope('!dovidka two', { timestamp: 1700000000102 }));

  assert.equal(calls.filter((c) => c.url.includes('/work_packages/form')).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/v3/work_packages')).length, 2);
});

const DATED_TYPE_SCHEMA = {
  startDate: { type: 'Date', name: 'Start date', required: false, hasDefault: false, writable: true },
  dueDate: { type: 'Date', name: 'Finish date', required: false, hasDefault: false, writable: true },
};

test('durationDays sets startDate to today and dueDate that many calendar days later', async () => {
  const db = setupDb();
  addRule(db, { name: 'Task', pattern: '!task' }, [
    { type: 'create_ticket', projectId: '3', typeId: '1', durationDays: 10 },
  ]);
  const calls = [];
  stubFetch(calls, { schema: DATED_TYPE_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!task something'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.ok(create, 'the work package should have been created');
  const today = new Date();
  const expectedStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const expectedDue = new Date(expectedStart);
  expectedDue.setUTCDate(expectedDue.getUTCDate() + 10);
  assert.equal(create.body.startDate, expectedStart.toISOString().slice(0, 10));
  assert.equal(create.body.dueDate, expectedDue.toISOString().slice(0, 10));
});

test('a manually mapped startDate wins over durationDays, which still fills dueDate', async () => {
  const db = setupDb();
  addRule(db, { name: 'Task', pattern: '!task' }, [
    {
      type: 'create_ticket',
      projectId: '3',
      typeId: '1',
      durationDays: 10,
      fieldTemplates: { startDate: '2030-01-01' },
    },
  ]);
  const calls = [];
  stubFetch(calls, { schema: DATED_TYPE_SCHEMA });

  await handleInboundMessage(db, groupEnvelope('!task something'));

  const create = calls.find((c) => c.url.endsWith('/api/v3/work_packages'));
  assert.equal(create.body.startDate, '2030-01-01');
  assert.ok(create.body.dueDate, 'dueDate should still be filled in by durationDays');
});

test('an action that cannot even start says so in the message log', async () => {
  const db = setupDb();
  db.prepare('UPDATE signal_settings SET default_project_id = NULL WHERE id = 1').run();
  // A create_ticket action with no project, and no default configured -- the
  // state this install was actually in, which previously failed to console
  // only and looked like the rule silently doing nothing.
  addRule(db, { name: 'Ticket', pattern: '!ticket' }, [{ type: 'create_ticket' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!ticket no project set'));

  const failed = db.prepare("SELECT * FROM message_log WHERE status = 'failed'").get();
  assert.ok(failed, 'the failure should be visible in the dashboard');
  assert.match(failed.content, /create_ticket action could not run/);
  assert.match(failed.error_message, /no OpenProject project/);
});

test('a rule runs all of its actions, in order', async () => {
  const db = setupDb();
  addRule(db, { name: 'Everything', pattern: '!task' }, [
    { type: 'react', emoji: '👀' },
    { type: 'create_ticket', projectId: '3', subject: 'from signal' },
    { type: 'send_message', message: 'done' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task do everything'));

  const kinds = calls
    .filter((c) => !c.url.includes('/work_packages/form'))
    .map((c) => (c.url.includes('/v1/reactions/') ? 'react' : c.url.includes('/work_packages') ? 'ticket' : 'send'));
  assert.deepEqual(kinds, ['react', 'ticket', 'send']);
});

test('higher priority wins and stop_processing halts the pass', async () => {
  const db = setupDb();
  addRule(db, { name: 'Catch all', matchType: 'any', priority: 0 }, [
    { type: 'send_message', message: 'fallback' },
  ]);
  addRule(db, { name: 'Specific', pattern: '!task', priority: 10 }, [
    { type: 'send_message', message: 'specific' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task hello'));

  const sent = calls.filter((c) => c.url.includes('/v2/send')).map((c) => c.body.message);
  assert.deepEqual(sent, ['specific']);
});

test('stop_processing off lets a later rule also run', async () => {
  const db = setupDb();
  addRule(db, { name: 'React first', pattern: '!task', priority: 10, stop: 0 }, [
    { type: 'send_message', message: 'first' },
  ]);
  addRule(db, { name: 'Then reply', pattern: '!task', priority: 5 }, [
    { type: 'send_message', message: 'second' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task hello'));

  const sent = calls.filter((c) => c.url.includes('/v2/send')).map((c) => c.body.message);
  assert.deepEqual(sent, ['first', 'second']);
});

test('a rule whose pattern no longer compiles does not block the rules after it', async () => {
  const db = setupDb();
  // Written directly to the table -- the API rejects this now, but a rule
  // stored before validation existed must not break the whole pipeline.
  addRule(db, { name: 'Broken', pattern: '([unclosed', priority: 10, stop: 0 }, [
    { type: 'send_message', message: 'never' },
  ]);
  addRule(db, { name: 'Fine', pattern: '!task', priority: 5 }, [{ type: 'send_message', message: 'ok' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task hello'));

  const sent = calls.filter((c) => c.url.includes('/v2/send')).map((c) => c.body.message);
  assert.deepEqual(sent, ['ok']);
});

test('a muted contact is not messaged by an inbound rule either', async () => {
  const db = setupDb();
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, muted)
     VALUES ('Ann', 'individual', '+15551112222', 1)`
  ).run();
  addRule(db, { name: 'Reply to sender', pattern: '!task' }, [
    { type: 'send_message', message: 'ack', replyTarget: 'sender' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('!task hush'));

  assert.equal(calls.filter((c) => c.url.includes('/v2/send')).length, 0);
  const logged = db.prepare("SELECT * FROM message_log WHERE direction = 'outbound'").get();
  assert.equal(logged.status, 'muted');
});

test('an action failure is logged and does not stop the remaining actions', async () => {
  const db = setupDb();
  addRule(db, { name: 'Ticket then reply', pattern: '!task' }, [
    { type: 'create_ticket', projectId: '3', subject: 'x' },
    { type: 'send_message', message: 'still sent' },
  ]);
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).includes('/work_packages/form')) return formResponse();
    if (String(url).includes('/api/v3/work_packages')) {
      return { ok: false, status: 422, text: async () => 'validation failed' };
    }
    return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
  });

  await handleInboundMessage(db, groupEnvelope('!task boom'));

  const failed = db.prepare("SELECT * FROM message_log WHERE status = 'failed'").get();
  assert.match(failed.error_message, /422/);
  assert.ok(calls.some((c) => c.url.includes('/v2/send')));
});

test('receipts, typing indicators and empty messages are skipped', async () => {
  const db = setupDb();
  addRule(db, { name: 'Catch all', matchType: 'any' }, [{ type: 'send_message', message: 'ack' }]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, { source: '+15551112222', timestamp: 5, receiptMessage: { when: 5 } });
  await handleInboundMessage(db, {
    source: '+15551112222',
    timestamp: 6,
    typingMessage: { action: 'STARTED' },
  });
  await handleInboundMessage(db, groupEnvelope('   ', { timestamp: 7 }));

  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message_log').get().n, 0);
});

// --- natural-language rules ------------------------------------------------

/** The "Тип довідки" custom field, as the form endpoint reports it. */
const FORM_FIELD = {
  customField1: {
    type: 'CustomOption',
    name: '🌀Тип довідки',
    required: true,
    hasDefault: false,
    writable: true,
    location: '_links',
    _embedded: {
      allowedValues: [
        { id: 313, value: 'Форма 5', _links: { self: { href: '/api/v3/custom_options/313' } } },
        { id: 314, value: 'Форма 12', _links: { self: { href: '/api/v3/custom_options/314' } } },
      ],
    },
  },
};

const REQUEST = 'Потрібна ф5 та ф12 на майор Іванов Іван Іванович';

function ticketCalls(calls) {
  return calls.filter((c) => c.url.endsWith('/api/v3/work_packages') && c.method === 'POST');
}

test('a natural rule files one work package per certificate requested', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    {
      type: 'create_ticket',
      typeId: '3',
      subject: '{form} — {person}',
      fieldTemplates: { customField1: '{form}' },
    },
  ]);
  const calls = [];
  stubFetch(calls, { schema: FORM_FIELD });

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  const tickets = ticketCalls(calls);
  assert.equal(tickets.length, 2);
  assert.deepEqual(
    tickets.map((call) => call.body.subject),
    ['Форма 5 — Іванов Іван Іванович', 'Форма 12 — Іванов Іван Іванович']
  );
  // The rendered form label is resolved against the type's allowed values, so
  // a rule never has to know the numeric id of an option.
  assert.deepEqual(
    tickets.map((call) => call.body._links.customField1.href),
    ['/api/v3/custom_options/313', '/api/v3/custom_options/314']
  );
});

test('fan-out "person" files one work package listing every form that person asked for', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'create_ticket', typeId: '3', subject: '{person}: {forms}', fanOut: 'person' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  const tickets = ticketCalls(calls);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].body.subject, 'Іванов Іван Іванович: Форма 5, Форма 12');
});

test('ticket confirmations from one fanned-out request are grouped into a single reply', async () => {
  const db = setupDb();
  db.prepare('UPDATE signal_settings SET auto_reply_enabled = 1').run();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(ticketCalls(calls).length, 2);
  // Two tickets, one Signal message -- not one confirmation per ticket.
  const sends = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(sends.length, 1);
  assert.equal((sends[0].body.message.match(/🎫/g) ?? []).length, 2);
});

test('reactions and replies happen once however many certificates were asked for', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'react', emoji: '👀' },
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}' },
    { type: 'send_message', message: 'Прийнято:\n{summary}' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(ticketCalls(calls).length, 2);
  assert.equal(calls.filter((c) => c.url.includes('/v1/reactions/')).length, 1);

  const sends = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.message, 'Прийнято:\nмайор Іванов Іван Іванович — Форма 5, Форма 12');
});

test('a message that is not a request falls through to the next rule', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null, priority: 10 }, [
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}' },
  ]);
  addRule(db, { name: 'Fallback', matchType: 'any', pattern: null, priority: 0 }, [
    { type: 'send_message', message: 'Не зрозумів запит' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope('Добрий день! Коли буде обід?'));

  assert.equal(ticketCalls(calls).length, 0);
  const sends = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.message, 'Не зрозумів запит');
});

test('one failed ticket does not stop the others in the same message', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}' },
  ]);
  const calls = [];
  let attempt = 0;
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null, method: options?.method });
    if (String(url).includes('/work_packages/form')) return formResponse();
    if (String(url).endsWith('/api/v3/work_packages')) {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 422, text: async () => '{"message":"nope"}' };
      return { ok: true, status: 201, json: async () => ({ id: 202, subject: 'stub' }) };
    }
    return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
  });

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(ticketCalls(calls).length, 2);
  const failed = db.prepare("SELECT * FROM message_log WHERE status = 'failed'").all();
  assert.equal(failed.length, 1);
  assert.match(failed[0].content, /Форма 5/);
});

// --- human review before anything is created --------------------------------

const REVIEWER = '+15557654321';

function reviewRule(db, overrides = {}) {
  return addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    {
      type: 'create_ticket',
      typeId: '3',
      subject: '{form} — {person}',
      requireApproval: true,
      approvalRecipient: REVIEWER,
      ...overrides,
    },
  ]);
}

test('an action marked for review creates nothing and asks the reviewer once', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(ticketCalls(calls).length, 0);

  // Two certificates, one review request -- not one per work package.
  const asked = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(asked.length, 1);
  assert.match(asked[0].body.message, /Форма 5 — Іванов Іван Іванович/);
  assert.match(asked[0].body.message, /Форма 12 — Іванов Іван Іванович/);

  const pending = db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending'").all();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reviewer, REVIEWER);
});

test('reacting to the review request files exactly what was reviewed', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));
  const held = db.prepare('SELECT * FROM pending_approvals').get();

  await handleInboundMessage(db, reactionEnvelope('✅', held.review_timestamp));

  const tickets = ticketCalls(calls);
  assert.equal(tickets.length, 2);
  assert.deepEqual(
    tickets.map((call) => call.body.subject),
    ['Форма 5 — Іванов Іван Іванович', 'Форма 12 — Іванов Іван Іванович']
  );

  const decided = db.prepare('SELECT * FROM pending_approvals').get();
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decided_by, REVIEWER);
});

test('approving a batch sends the ticket confirmations and the approval notice as one message', async () => {
  const db = setupDb();
  db.prepare('UPDATE signal_settings SET auto_reply_enabled = 1').run();
  reviewRule(db);
  // Route confirmations to the reviewer -- same conversation the "Approved"
  // notice goes to, so the two are groupable in the first place.
  db.prepare("UPDATE inbound_rule_actions SET confirm_target = 'reviewer'").run();
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));
  const held = db.prepare('SELECT * FROM pending_approvals').get();

  await handleInboundMessage(db, reactionEnvelope('✅', held.review_timestamp));

  assert.equal(ticketCalls(calls).length, 2);

  // One send for the review request, then one grouped send carrying both
  // ticket confirmations plus the "Approved" notice -- not three messages.
  const sends = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(sends.length, 2);
  const confirmation = sends[1].body.message;
  assert.equal((confirmation.match(/🎫/g) ?? []).length, 2);
  assert.match(confirmation, /✅ Approved — 2 actions run\.$/);
});

test('rejecting the review request creates nothing', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));
  const held = db.prepare('SELECT * FROM pending_approvals').get();

  await handleInboundMessage(db, reactionEnvelope('❌', held.review_timestamp));

  assert.equal(ticketCalls(calls).length, 0);
  assert.equal(db.prepare('SELECT status FROM pending_approvals').get().status, 'rejected');
});

test('an approval only counts once, however many times it is reacted to', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));
  const held = db.prepare('SELECT * FROM pending_approvals').get();

  await handleInboundMessage(db, reactionEnvelope('✅', held.review_timestamp));
  await handleInboundMessage(db, reactionEnvelope('👍', held.review_timestamp, { timestamp: 1700000009999 }));

  assert.equal(ticketCalls(calls).length, 2);
});

test('reactions to ordinary messages are not decisions', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  // Right emoji, but it targets some other message entirely.
  await handleInboundMessage(db, reactionEnvelope('✅', 1699999999999));
  assert.equal(ticketCalls(calls).length, 0);

  // The review request, but an emoji that means nothing here.
  const held = db.prepare('SELECT * FROM pending_approvals').get();
  await handleInboundMessage(db, reactionEnvelope('🎉', held.review_timestamp, { timestamp: 1700000009001 }));
  assert.equal(ticketCalls(calls).length, 0);
  assert.equal(db.prepare('SELECT status FROM pending_approvals').get().status, 'pending');
});

test('actions that need no review still run while the reviewer is asked', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'react', emoji: '👀' },
    {
      type: 'create_ticket',
      typeId: '3',
      subject: '{form} — {person}',
      requireApproval: true,
      approvalRecipient: REVIEWER,
    },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  // The sender is not left in silence while a reviewer sleeps.
  assert.equal(calls.filter((c) => c.url.includes('/v1/reactions/')).length, 1);
  assert.equal(ticketCalls(calls).length, 0);
});

test('a review request that cannot be sent is a logged failure, not a silent drop', async () => {
  const db = setupDb();
  reviewRule(db);
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null, method: options?.method });
    if (String(url).includes('/work_packages/form')) return formResponse();
    if (String(url).includes('/v2/send')) return { ok: false, status: 500, text: async () => 'signal down' };
    return { ok: true, status: 201, text: async () => '', json: async () => ({ timestamp: 1 }) };
  });

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(ticketCalls(calls).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_approvals').get().c, 0);
  const failed = db.prepare("SELECT * FROM message_log WHERE status = 'failed'").all();
  assert.ok(failed.some((row) => /could not ask for approval/.test(row.content)));
});

// --- telling a human when something breaks ----------------------------------

const OPERATOR = '+15550009999';

/** Every work package POST fails, so the failure path is what gets exercised. */
function stubFailingTickets(calls, status = 500, body = 'boom') {
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null, method: options?.method });
    if (String(url).includes('/work_packages/form')) return formResponse();
    if (String(url).endsWith('/api/v3/work_packages')) return { ok: false, status, text: async () => body };
    return { ok: true, status: 201, text: async () => '', json: async () => ({ timestamp: 1 }) };
  });
}

function ticketRule(db, action = {}) {
  return addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}', ...action },
  ]);
}

test('a failed action sends the reason to the failure recipient', async () => {
  const db = setupDb();
  ticketRule(db, { failureRecipient: OPERATOR });
  const calls = [];
  stubFailingTickets(calls, 422, JSON.stringify({ message: 'Тип довідки can не бути порожнім' }));

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  const notices = calls.filter((c) => c.url.includes('/v2/send') && c.body.recipients?.[0] === OPERATOR);
  // One per failed work package, each naming what actually went wrong and
  // quoting the message it came from.
  assert.equal(notices.length, 2);
  assert.match(notices[0].body.message, /create_ticket failed/);
  assert.match(notices[0].body.message, /Тип довідки/);
  assert.match(notices[0].body.message, /Потрібна ф5 та ф12/);
});

test('no failure recipient means the failure is logged and nothing is sent', async () => {
  const db = setupDb();
  ticketRule(db);
  const calls = [];
  stubFailingTickets(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(calls.filter((c) => c.url.includes('/v2/send')).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM message_log WHERE status = 'failed'").get().c, 2);
});

test('a muted failure recipient is honoured, and the notice logged as muted', async () => {
  const db = setupDb();
  db.prepare(
    "INSERT INTO contacts (name, type, signal_identifier, muted) VALUES ('Chief', 'individual', ?, 1)"
  ).run(OPERATOR);
  ticketRule(db, { failureRecipient: OPERATOR });
  const calls = [];
  stubFailingTickets(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(calls.filter((c) => c.url.includes('/v2/send')).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM message_log WHERE status = 'muted'").get().c, 2);
});

test('an approved action that then fails still reaches the failure recipient', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    {
      type: 'create_ticket',
      typeId: '3',
      subject: '{form} — {person}',
      requireApproval: true,
      approvalRecipient: REVIEWER,
      failureRecipient: OPERATOR,
    },
  ]);
  const calls = [];
  stubFetch(calls);
  await handleInboundMessage(db, groupEnvelope(REQUEST));
  const held = db.prepare('SELECT * FROM pending_approvals').get();

  // The work packages only fail once the reviewer has approved them.
  stubFailingTickets(calls);
  await handleInboundMessage(db, reactionEnvelope('👍', held.review_timestamp));

  const notices = calls.filter((c) => c.url.includes('/v2/send') && c.body.recipients?.[0] === OPERATOR);
  assert.equal(notices.length, 2);
});

// --- values that come from the sender rather than the message ---------------

/** "👤Замовник" as the form endpoint reports it: a closed list, required. */
const CUSTOMER_FIELD = {
  customField19: {
    type: 'CustomOption',
    name: '👤Замовник',
    required: true,
    hasDefault: false,
    writable: true,
    location: '_links',
    _embedded: {
      allowedValues: [
        { id: 7, value: 'Відділ кадрів', _links: { self: { href: '/api/v3/custom_options/7' } } },
        { id: 99, value: 'Інше, вкажу в описі', _links: { self: { href: '/api/v3/custom_options/99' } } },
      ],
    },
  },
};

function customerRule(db) {
  return addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    {
      type: 'create_ticket',
      typeId: '3',
      subject: '{form} — {person}',
      fieldTemplates: { customField19: { source: 'sender_contact', fallback: '99' } },
      fanOut: 'person',
    },
  ]);
}

test('a sender nobody has classified gets a contact to classify, and the ticket still files', async () => {
  const db = setupDb();
  customerRule(db);
  const calls = [];
  stubFetch(calls, { schema: CUSTOMER_FIELD });

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  // Filed against the fallback option rather than failing with a 422.
  const tickets = ticketCalls(calls);
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].body._links.customField19, { href: '/api/v3/custom_options/99' });
  // ...and the description says what the fallback stands in for.
  assert.match(tickets[0].body.description.raw, /Not matched to a list value/);
  assert.match(tickets[0].body.description.raw, /👤Замовник: Ann/);

  const contact = db.prepare('SELECT * FROM contacts WHERE signal_identifier = ?').get('+15551112222');
  assert.equal(contact.name, 'Ann');
  assert.equal(contact.needs_classification, 1);
});

test('once a human has classified the sender, their value is what gets filed', async () => {
  const db = setupDb();
  customerRule(db);
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, field_values, needs_classification)
     VALUES ('Ann', 'individual', '+15551112222', '{"customField19":"7"}', 0)`
  ).run();
  const calls = [];
  stubFetch(calls, { schema: CUSTOMER_FIELD });

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  const tickets = ticketCalls(calls);
  assert.deepEqual(tickets[0].body._links.customField19, { href: '/api/v3/custom_options/7' });
  assert.doesNotMatch(tickets[0].body.description.raw, /Not matched/);
  assert.equal(
    db.prepare('SELECT needs_classification FROM contacts WHERE signal_identifier = ?').get('+15551112222')
      .needs_classification,
    0
  );
});

test('a rule that reads nothing off the sender does not create contacts for them', async () => {
  const db = setupDb();
  addRule(db, { name: 'Довідки', matchType: 'natural', pattern: null }, [
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}' },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, groupEnvelope(REQUEST));

  assert.equal(db.prepare('SELECT COUNT(*) c FROM contacts').get().c, 0);
});

// --- /process: replaying a message the pipeline never saw ---------------

// `/process` is authorized off the approval-recipient list, so REVIEWER (declared
// with the approval tests above) is also the number allowed to run it.
//
// A writable `author`, which is what lets a replay attribute the work package
// to the person it names. On a personal API token OpenProject reports this
// false and sets the author itself -- see createWorkPackage.
const WRITABLE_AUTHOR = {
  author: { type: 'User', name: 'Author', required: false, hasDefault: false, writable: true, location: '_links' },
};

/** A group-scoped rule, so a replay only reaches it if it inherits the group. */
function replayRule(db, actions) {
  return addRule(
    db,
    { name: 'Довідки', matchType: 'natural', pattern: null, scope: 'group', groupIds: [GROUP_SEND_ID] },
    actions ?? [
      {
        type: 'create_ticket',
        typeId: '3',
        subject: '{form} — {person}',
        approvalRecipient: REVIEWER,
      },
    ]
  );
}

function seedReplayContact(db, { name, phone, userId }) {
  db.prepare(
    `INSERT INTO contacts (name, type, signal_identifier, openproject_user_id)
     VALUES (?, 'individual', ?, ?)`
  ).run(name, phone, userId);
}

test('a forwarded message is replayed into the group-scoped rule it missed', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  const calls = [];
  stubFetch(calls);

  // Sent as a DM, with the forward marker Signal's own client puts on top.
  await handleInboundMessage(
    db,
    directEnvelope(`~Forwarded message\n/process Петренко Олег\n${REQUEST}`, { source: REVIEWER })
  );

  // The rule is scoped to the group; a DM only reaches it because the replay
  // inherits the single subscribed group.
  const tickets = ticketCalls(calls);
  assert.equal(tickets.length, 2, 'both certificates in the forwarded message were filed');
  assert.match(tickets[0].body.subject, /Іванов Іван Іванович/);
});

test('the named author is filed as the work package author, not the operator', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  seedReplayContact(db, { name: 'Reviewer', phone: REVIEWER, userId: 99 });
  const calls = [];
  stubFetch(calls, { schema: WRITABLE_AUTHOR });

  await handleInboundMessage(db, directEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  const tickets = ticketCalls(calls);
  assert.deepEqual(tickets[0].body._links.author, { href: '/api/v3/users/12' }, 'the named author, not the reviewer');
  // The ticket says it was replayed, so "reported by" is not a claim about a
  // Signal message this bot never actually received.
  assert.match(tickets[0].body.description.raw, /Replayed by:\*\* \+15557654321/);
});

test('omitting the author attributes the replay to the operator', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Reviewer', phone: REVIEWER, userId: 99 });
  const calls = [];
  stubFetch(calls, { schema: WRITABLE_AUTHOR });

  await handleInboundMessage(db, directEnvelope(`/process\n${REQUEST}`, { source: REVIEWER }));

  assert.deepEqual(ticketCalls(calls)[0].body._links.author, { href: '/api/v3/users/99' });
});

test('an author nobody matches is refused, and nothing is filed', async () => {
  const db = setupDb();
  replayRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, directEnvelope(`/process Коваленко\n${REQUEST}`, { source: REVIEWER }));

  assert.equal(ticketCalls(calls).length, 0, 'a typo must not quietly file against the wrong person');
  const sent = calls.filter((c) => c.url.includes('/v2/send'));
  assert.equal(sent.length, 1, 'the operator is told why, rather than the command looking swallowed');
  assert.match(sent[0].body.message, /no contact or OpenProject user matches "Коваленко"/);
});

test('a react action is skipped on a replay, since there is no message to react to', async () => {
  const db = setupDb();
  replayRule(db, [
    { type: 'react', emoji: '✅', approvalRecipient: REVIEWER },
    { type: 'create_ticket', typeId: '3', subject: '{form} — {person}', approvalRecipient: REVIEWER },
  ]);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, directEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  assert.equal(calls.filter((c) => c.url.includes('/v1/reactions')).length, 0);
  assert.equal(ticketCalls(calls).length, 2, 'the tickets, which are the point, still file');
});

test('an unauthorized sender\'s /process is processed as an ordinary message', async () => {
  const db = setupDb();
  replayRule(db);
  const calls = [];
  stubFetch(calls);

  // Not the reviewer, so this is not a command -- it is just a group message
  // that happens to start with a word beginning in a slash, and it must not
  // vanish.
  await handleInboundMessage(db, groupEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: '+15551112222' }));

  assert.equal(ticketCalls(calls).length, 2, 'the message still went through the rules normally');
  const logged = db.prepare("SELECT sender FROM message_log WHERE direction = 'inbound'").all();
  assert.equal(logged[0].sender, '+15551112222', 'logged as its real sender, with no author substitution');
});

test('a replay is logged as inbound so it appears in the dashboard', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  stubFetch([]);

  await handleInboundMessage(db, directEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  const logged = db.prepare("SELECT * FROM message_log WHERE direction = 'inbound'").get();
  assert.equal(logged.content, REQUEST, 'the command line is not part of the replayed message');
  assert.equal(logged.sender, '+15551119999', 'attributed to the author it was replayed as');
});

// The report back: a replay that says nothing is indistinguishable from one
// that silently did nothing, which is what made this command feel broken.
function replayReport(calls) {
  const sent = calls.filter((call) => call.url.includes('/v2/send')).map((call) => call.body.message);
  return sent[sent.length - 1] ?? '';
}

test('a replay reports the tickets it filed back to the operator', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, directEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  const report = replayReport(calls);
  assert.match(report, /Matched rule "Довідки"/u);
  assert.match(report, /#101/u, 'the work package it created is named');
});

test('a replay that matches nothing says why each rule passed on it', async () => {
  const db = setupDb();
  // Scoped to a group that is not the one the replay inherits.
  addRule(
    db,
    { name: 'Інша група', matchType: 'natural', pattern: null, scope: 'group', groupIds: ['group.somewhere-else'] },
    [{ type: 'create_ticket', typeId: '3', approvalRecipient: REVIEWER }]
  );
  addRule(db, { name: 'Команда', matchType: 'regex', pattern: '^!ticket' }, [
    { type: 'create_ticket', typeId: '3', approvalRecipient: REVIEWER },
  ]);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, directEnvelope(`/process\n${REQUEST}`, { source: REVIEWER }));

  assert.equal(ticketCalls(calls).length, 0);
  const report = replayReport(calls);
  assert.match(report, /No inbound rule matched/u);
  assert.match(report, /"Інша група" is scoped to a different group/u);
  assert.match(report, /"Команда" has a pattern that does not match/u);
});

test('a replay whose ticket action fails tells the operator what OpenProject refused', async () => {
  const db = setupDb();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  const calls = [];
  // A type whose schema demands a custom field the rule does not fill.
  stubFetch(calls, {
    schema: {
      customField1: {
        type: 'CustomOption',
        name: '🌀Тип довідки',
        required: true,
        hasDefault: false,
        writable: true,
        location: '_links',
      },
    },
  });

  await handleInboundMessage(db, directEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  assert.equal(ticketCalls(calls).length, 0, 'nothing was posted');
  const report = replayReport(calls);
  assert.match(report, /create_ticket failed/u);
  assert.match(report, /customField1/u);
});

test('a replay run inside a subscribed group is replayed into that group', async () => {
  const db = setupDb();
  db.prepare("UPDATE signal_settings SET default_replay_group_id = 'group.somewhere-else' WHERE id = 1").run();
  replayRule(db);
  seedReplayContact(db, { name: 'Петренко Олег', phone: '+15551119999', userId: 12 });
  const calls = [];
  stubFetch(calls);

  // Run in the help-desk group itself: that conversation is what the operator
  // meant, whatever the configured default says.
  await handleInboundMessage(db, groupEnvelope(`/process Петренко Олег\n${REQUEST}`, { source: REVIEWER }));

  assert.equal(ticketCalls(calls).length, 2, 'the group-scoped rule matched');
});

test('/process with nothing under it answers with how to write the command', async () => {
  const db = setupDb();
  replayRule(db);
  const calls = [];
  stubFetch(calls);

  await handleInboundMessage(db, directEnvelope('/process Петренко Олег', { source: REVIEWER }));

  assert.match(replayReport(calls), /Send it like this/u);
});
