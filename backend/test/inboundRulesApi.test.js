import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { validateRule } from '../src/inboundRules/inboundRules.controller.js';
import * as repo from '../src/inboundRules/inboundRules.repository.js';
import { detectTransport, receiveWebsocketUrl, envelopesFrom } from '../src/signal/signalReceiver.js';

const validRule = (overrides = {}) => ({
  name: 'Task',
  enabled: true,
  matchType: 'regex',
  pattern: '^!task',
  patternFlags: 'i',
  actions: [{ actionType: 'send_message', messageTemplate: 'ack' }],
  ...overrides,
});

beforeEach(() => mock.restoreAll());

test('a valid rule passes validation', () => {
  assert.deepEqual(validateRule(validRule()), []);
});

test('an uncompilable regex is rejected at save time, not at message time', () => {
  const errors = validateRule(validRule({ pattern: '([unclosed' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid regular expression/i);
});

test('a rule must have a name, a pattern and at least one action', () => {
  assert.match(validateRule(validRule({ name: '  ' })).join(), /name is required/);
  assert.match(validateRule(validRule({ pattern: '' })).join(), /pattern is required/);
  assert.match(validateRule(validRule({ actions: [] })).join(), /at least one action/);
});

test('match type "any" needs no pattern', () => {
  assert.deepEqual(validateRule(validRule({ matchType: 'any', pattern: '' })), []);
});

test('each action type is validated for the fields it actually needs', () => {
  assert.match(validateRule(validRule({ actions: [{ actionType: 'react' }] })).join(), /emoji is required/);
  assert.match(
    validateRule(validRule({ actions: [{ actionType: 'send_message' }] })).join(),
    /message template is required/
  );
  assert.match(
    validateRule(
      validRule({ actions: [{ actionType: 'send_message', messageTemplate: 'x', replyTarget: 'raw' }] })
    ).join(),
    /number or group id/
  );
  assert.match(validateRule(validRule({ actions: [{ actionType: 'teleport' }] })).join(), /unknown type/);
});

test('a field_match mapping with no field to match on is rejected at save time', () => {
  const errors = validateRule(
    validRule({
      actions: [
        {
          actionType: 'create_ticket',
          fieldTemplates: { assignee: { source: 'field_match', fallback: '56', rules: [] } },
        },
      ],
    })
  );
  assert.match(errors.join(), /"assignee" needs a field to match on/);
});

test('a field_match mapping with no rules and no default would never fire, and is rejected', () => {
  const errors = validateRule(
    validRule({
      actions: [
        {
          actionType: 'create_ticket',
          fieldTemplates: { assignee: { source: 'field_match', matchField: 'customField1', rules: [] } },
        },
      ],
    })
  );
  assert.match(errors.join(), /"assignee" has no rules and no default value/);
});

test('a field_match mapping with only a default (no rules) is valid -- always-the-same-assignee is a legitimate use', () => {
  const errors = validateRule(
    validRule({
      actions: [
        {
          actionType: 'create_ticket',
          fieldTemplates: {
            assignee: { source: 'field_match', matchField: 'customField1', fallback: '56', rules: [] },
          },
        },
      ],
    })
  );
  assert.deepEqual(errors, []);
});

test('a field_match mapping with a complete rule and a matchField is valid', () => {
  const errors = validateRule(
    validRule({
      actions: [
        {
          actionType: 'create_ticket',
          fieldTemplates: {
            assignee: {
              source: 'field_match',
              matchField: 'customField1',
              rules: [{ values: ['Форма 5'], value: '12' }],
            },
          },
        },
      ],
    })
  );
  assert.deepEqual(errors, []);
});

test('a rule can listen to several groups, and a direct-only rule keeps none', () => {
  const db = createTestDb();
  const created = repo.create(
    db,
    validRule({ sourceScope: 'any', sourceGroupIds: ['group.one', 'group.two', 'group.one', ' '] })
  );
  // Handed back parsed, deduplicated, and without the blank the UI submitted.
  assert.deepEqual(created.source_group_ids, ['group.one', 'group.two']);
  assert.deepEqual(repo.getById(db, created.id).source_group_ids, ['group.one', 'group.two']);

  const widened = repo.update(db, created.id, validRule({ sourceScope: 'any', sourceGroupIds: [] }));
  assert.deepEqual(widened.source_group_ids, []);

  // A direct-only rule has no group half to narrow.
  const direct = repo.update(
    db,
    created.id,
    validRule({ sourceScope: 'direct', sourceGroupIds: ['group.one'] })
  );
  assert.deepEqual(direct.source_group_ids, []);
});

test('a group list that is not a list of ids is rejected rather than ignored', () => {
  assert.deepEqual(validateRule(validRule({ sourceGroupIds: ['group.one'] })), []);
  assert.deepEqual(validateRule(validRule({ sourceGroupIds: [] })), []);
  assert.match(validateRule(validRule({ sourceGroupIds: 'group.one' })).join(), /list of group ids/);
  assert.match(validateRule(validRule({ sourceGroupIds: ['group.one', ''] })).join(), /non-empty string/);
});

test('a rule round-trips through the repository with its actions in order', () => {
  const db = createTestDb();
  const created = repo.create(db, {
    ...validRule({ name: 'Everything', priority: 5, sourceScope: 'group' }),
    actions: [
      { actionType: 'react', emoji: '👀' },
      { actionType: 'create_ticket', projectId: '3', subjectTemplate: '{1}' },
      { actionType: 'send_message', messageTemplate: 'done', replyTarget: 'source' },
    ],
  });

  assert.equal(created.name, 'Everything');
  assert.equal(created.source_scope, 'group');
  assert.deepEqual(
    created.actions.map((a) => a.action_type),
    ['react', 'create_ticket', 'send_message']
  );
  assert.equal(created.actions[0].emoji, '👀');
  assert.deepEqual(repo.getById(db, created.id), created);
});

test('updating a rule replaces its actions rather than appending to them', () => {
  const db = createTestDb();
  const created = repo.create(db, validRule());
  const updated = repo.update(db, created.id, {
    ...validRule({ name: 'Renamed' }),
    actions: [{ actionType: 'react', emoji: '✅' }],
  });

  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.actions.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbound_rule_actions').get().n, 1);
});

test('deleting a rule takes its actions with it', () => {
  const db = createTestDb();
  const created = repo.create(db, validRule());
  repo.remove(db, created.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbound_rule_actions').get().n, 0);
  assert.equal(repo.getById(db, created.id), null);
});

test('blank optional fields are stored as NULL so defaults fall through', () => {
  const db = createTestDb();
  // The rule editor submits "" for an untouched "(use default project)" select.
  const created = repo.create(db, {
    ...validRule(),
    actions: [{ actionType: 'create_ticket', projectId: '', typeId: '' }],
  });
  assert.equal(created.actions[0].project_id, null);
  assert.equal(created.actions[0].type_id, null);
});

test('only enabled rules reach the message pipeline, highest priority first', () => {
  const db = createTestDb();
  repo.create(db, validRule({ name: 'Low', priority: 1 }));
  repo.create(db, validRule({ name: 'High', priority: 9 }));
  repo.create(db, validRule({ name: 'Off', priority: 99, enabled: false }));

  assert.deepEqual(
    repo.listEnabledWithActions(db).map((r) => r.name),
    ['High', 'Low']
  );
});

test('transport detection follows the container MODE, since json-rpc has no GET receive', async () => {
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ mode: 'json-rpc' }),
  }));
  assert.equal(await detectTransport('http://signal-api:8080'), 'websocket');

  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ mode: 'native' }) }));
  assert.equal(await detectTransport('http://signal-api:8080'), 'poll');
});

test('an unreachable /v1/about assumes websocket, matching the compose default', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('connection refused');
  });
  assert.equal(await detectTransport('http://signal-api:8080'), 'websocket');
});

test('the receive websocket url keeps the path and swaps the scheme', () => {
  assert.equal(
    receiveWebsocketUrl('http://signal-api:8080', '+15550000000'),
    'ws://signal-api:8080/v1/receive/%2B15550000000'
  );
  assert.equal(
    receiveWebsocketUrl('https://signal.example.com/', '+15550000000'),
    'wss://signal.example.com/v1/receive/%2B15550000000'
  );
});

test('envelopes are unwrapped from every shape the three inbound paths produce', () => {
  const envelope = { source: '+1', dataMessage: { message: 'hi' } };
  assert.deepEqual(envelopesFrom({ envelope }), [envelope]); // websocket frame
  assert.deepEqual(envelopesFrom([{ envelope }, { envelope }]), [envelope, envelope]); // GET /v1/receive
  assert.deepEqual(envelopesFrom(envelope), [envelope]); // bare, as some webhooks post
  assert.deepEqual(envelopesFrom({ unrelated: true }), []);
});

test('match type "natural" needs no pattern either', () => {
  assert.deepEqual(validateRule(validRule({ matchType: 'natural', pattern: '' })), []);
});

test('an unknown fan-out mode is rejected', () => {
  const errors = validateRule(
    validRule({ matchType: 'natural', pattern: '', actions: [{ actionType: 'create_ticket', fanOut: 'each' }] })
  );
  assert.match(errors.join(), /fan-out must be one of/);
});

test('confirming a ticket to the reviewer needs a review recipient', () => {
  const errors = validateRule(
    validRule({ actions: [{ actionType: 'create_ticket', confirmTarget: 'reviewer' }] })
  );
  assert.match(errors.join(), /confirming to the reviewer needs a review recipient/);

  assert.deepEqual(
    validateRule(
      validRule({
        actions: [{ actionType: 'create_ticket', confirmTarget: 'reviewer', approvalRecipient: '+1' }],
      })
    ),
    []
  );
});

test('an unknown confirm target is rejected', () => {
  const errors = validateRule(
    validRule({ actions: [{ actionType: 'create_ticket', confirmTarget: 'everyone' }] })
  );
  assert.match(errors.join(), /confirm target must be one of/);
});

test('a create_ticket action round-trips its confirm target, defaulting to source', () => {
  const db = createTestDb();
  const created = repo.create(db, {
    ...validRule(),
    actions: [
      { actionType: 'create_ticket', confirmTarget: 'reviewer', approvalRecipient: '+1' },
      { actionType: 'react', emoji: '👀' },
    ],
  });
  assert.equal(created.actions[0].confirm_target, 'reviewer');
  assert.equal(created.actions[1].confirm_target, 'source');
});

test('durationDays must be a positive whole number when set', () => {
  assert.match(
    validateRule(validRule({ actions: [{ actionType: 'create_ticket', durationDays: 0 }] })).join(),
    /days to complete must be a positive whole number/
  );
  assert.match(
    validateRule(validRule({ actions: [{ actionType: 'create_ticket', durationDays: -5 }] })).join(),
    /days to complete must be a positive whole number/
  );
  assert.match(
    validateRule(validRule({ actions: [{ actionType: 'create_ticket', durationDays: 2.5 }] })).join(),
    /days to complete must be a positive whole number/
  );
  assert.deepEqual(
    validateRule(validRule({ actions: [{ actionType: 'create_ticket', durationDays: 10 }] })),
    []
  );
  // Blank is fine — it just means neither date is set this way.
  assert.deepEqual(
    validateRule(validRule({ actions: [{ actionType: 'create_ticket', durationDays: '' }] })),
    []
  );
});

test('a create_ticket action round-trips its duration, stored as NULL when blank', () => {
  const db = createTestDb();
  const created = repo.create(db, {
    ...validRule(),
    actions: [
      { actionType: 'create_ticket', durationDays: 10 },
      { actionType: 'react', emoji: '👀' },
    ],
  });
  assert.equal(created.actions[0].duration_days, 10);
  assert.equal(created.actions[1].duration_days, null);
});

test('a natural rule round-trips with its fan-out mode', () => {
  const db = createTestDb();
  const created = repo.create(
    db,
    validRule({
      matchType: 'natural',
      pattern: '',
      actions: [
        { actionType: 'create_ticket', fanOut: 'person', subjectTemplate: '{person}: {forms}' },
        { actionType: 'react', emoji: '👀' },
      ],
    })
  );
  assert.equal(created.match_type, 'natural');
  assert.equal(created.pattern, null);
  assert.equal(created.actions[0].fan_out, 'person');
  // Untouched by the other action types, but stored with a usable default.
  assert.equal(created.actions[1].fan_out, 'pair');
});
