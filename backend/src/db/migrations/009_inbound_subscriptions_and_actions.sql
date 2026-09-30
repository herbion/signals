-- Migration 009: real inbound message handling.
--
-- Three things change here:
--   1. Explicit subscriptions -- which Signal groups (and whether direct
--      messages) the bot listens to -- replacing the free-text `group_filter`
--      blob, which could only ever filter groups and silently let every DM
--      through.
--   2. Inbound rules gain a source scope and a pluggable matcher (`match_type`
--      + `pattern` + `pattern_flags`) instead of a bare always-regex string.
--   3. A rule can now run *several* actions (react / create ticket / send
--      message), so `inbound_rules.action_*` moves out into its own table.
--
-- `receive_mode` ('poll'|'websocket') becomes `receive_transport`
-- ('auto'|'websocket'|'poll'|'webhook'): signal-cli-rest-api only serves
-- GET /v1/receive in normal/native MODE -- in json-rpc modes the same path is
-- a websocket and the GET returns 400 forever. 'auto' asks /v1/about which
-- one applies rather than making the admin know.

-- ---------------------------------------------------------------- settings
CREATE TABLE signal_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signal_api_base_url TEXT NOT NULL DEFAULT 'http://signal-api:8080',
  bot_number TEXT,
  receive_transport TEXT NOT NULL DEFAULT 'auto'
    CHECK (receive_transport IN ('auto', 'websocket', 'poll', 'webhook')),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 10,
  receive_enabled INTEGER NOT NULL DEFAULT 0,
  text_mode TEXT NOT NULL DEFAULT 'styled' CHECK (text_mode IN ('normal', 'styled')),
  grouping_enabled INTEGER NOT NULL DEFAULT 1,
  grouping_window_seconds INTEGER NOT NULL DEFAULT 60,
  inbound_webhook_token TEXT,
  default_project_id TEXT,
  default_type_id TEXT,
  allow_direct_messages INTEGER NOT NULL DEFAULT 1,
  subscribe_all_groups INTEGER NOT NULL DEFAULT 0,
  auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO signal_settings_new
  (id, signal_api_base_url, bot_number, receive_transport, poll_interval_seconds,
   receive_enabled, text_mode, grouping_enabled, grouping_window_seconds,
   inbound_webhook_token, default_project_id, default_type_id,
   allow_direct_messages, subscribe_all_groups, auto_reply_enabled, updated_at)
SELECT
  id, signal_api_base_url, bot_number,
  CASE receive_mode WHEN 'websocket' THEN 'websocket' ELSE 'auto' END,
  poll_interval_seconds, receive_enabled, text_mode, grouping_enabled,
  grouping_window_seconds, inbound_webhook_token, default_project_id,
  default_type_id, 1, 0, auto_reply_enabled, updated_at
FROM signal_settings;

DROP TABLE signal_settings;
ALTER TABLE signal_settings_new RENAME TO signal_settings;

-- ----------------------------------------------------------- subscriptions
-- `group_id` is the id you SEND to ("group.<base64>"); `internal_id` is the
-- base64 id that comes back on received envelopes. They are different strings
-- for the same group, and conflating them means replies silently fail.
CREATE TABLE signal_group_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL UNIQUE,
  internal_id TEXT,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_group_subscriptions_internal ON signal_group_subscriptions(internal_id);

-- ------------------------------------------------------------------- rules
CREATE TABLE inbound_rules_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  source_scope TEXT NOT NULL DEFAULT 'any'
    CHECK (source_scope IN ('any', 'group', 'direct')),
  source_group_id TEXT,
  match_type TEXT NOT NULL DEFAULT 'regex'
    CHECK (match_type IN ('regex', 'contains', 'any')),
  pattern TEXT,
  pattern_flags TEXT NOT NULL DEFAULT 'i',
  stop_processing INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inbound_rules_new
  (id, name, enabled, priority, source_scope, match_type, pattern, pattern_flags,
   created_at, updated_at)
SELECT id, name, enabled, priority, 'any', 'regex', trigger_pattern, 'i',
       created_at, updated_at
FROM inbound_rules;

CREATE TABLE inbound_rule_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES inbound_rules_new(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL
    CHECK (action_type IN ('react', 'create_ticket', 'send_message')),
  emoji TEXT,
  project_id TEXT,
  type_id TEXT,
  priority_id TEXT,
  subject_template TEXT,
  description_template TEXT,
  message_template TEXT,
  reply_target TEXT NOT NULL DEFAULT 'source'
    CHECK (reply_target IN ('source', 'sender', 'contact', 'raw')),
  reply_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  reply_raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbound_rule_actions_rule ON inbound_rule_actions(rule_id, position);

-- Carry each old single-action rule over as that rule's first action.
INSERT INTO inbound_rule_actions
  (rule_id, position, action_type, project_id, type_id, message_template, reply_target)
SELECT id, 0,
       CASE action_type WHEN 'create_ticket' THEN 'create_ticket' ELSE 'send_message' END,
       NULLIF(action_target_project_id, ''),
       NULLIF(action_target_type_id, ''),
       CASE action_type WHEN 'create_ticket' THEN NULL ELSE action_reply_template END,
       'source'
FROM inbound_rules;

DROP TABLE inbound_rules;
ALTER TABLE inbound_rules_new RENAME TO inbound_rules;

-- --------------------------------------------------------------- idempotency
-- (sender, sent-timestamp) is Signal's own identity for a message, so a
-- websocket reconnect or a webhook redelivery replaying the same envelope
-- can't fire the same rule twice.
CREATE TABLE inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  signal_timestamp INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_key, signal_timestamp)
);
