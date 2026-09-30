-- Migration 011: the natural-language parser.
--
-- `inbound_rules.match_type` gains 'natural' -- a rule with no pattern at all,
-- which matches when the message parses as a certificate request (see
-- signal/naturalParser.js). SQLite cannot alter a CHECK constraint in place,
-- so the table is rebuilt.
--
-- `inbound_rule_actions.fan_out` says how many work packages one parsed
-- message turns into:
--
--   'pair'    one per (person, form) -- "ф5 та ф12 на Іванов" files two, which
--             is how the office works through them and all a single-valued
--             "Тип довідки" field can express. The default.
--   'person'  one per person, listing every form they asked for, for a type
--             whose form field takes several values.
--   'message' one for the whole message, like every other match type.
--
-- It is ignored by the other match types, and by the other action types: a
-- reaction or a reply happens once per message however many certificates that
-- message turned out to hold.
--
-- Both tables are rebuilt, and in this order, because `foreign_keys` is ON in
-- the app connection: `inbound_rule_actions.rule_id` cascades on delete, so
-- dropping `inbound_rules` while that table still pointed at it would take
-- every action row with it. The child is copied and dropped first, leaving
-- nothing referencing the parent by the time the parent is dropped.

CREATE TABLE inbound_rules_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  source_scope TEXT NOT NULL DEFAULT 'any'
    CHECK (source_scope IN ('any', 'group', 'direct')),
  source_group_id TEXT,
  match_type TEXT NOT NULL DEFAULT 'regex'
    CHECK (match_type IN ('regex', 'contains', 'any', 'natural')),
  pattern TEXT,
  pattern_flags TEXT NOT NULL DEFAULT 'i',
  stop_processing INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inbound_rules_new
  (id, name, enabled, priority, source_scope, source_group_id, match_type,
   pattern, pattern_flags, stop_processing, created_at, updated_at)
SELECT id, name, enabled, priority, source_scope, source_group_id, match_type,
       pattern, pattern_flags, stop_processing, created_at, updated_at
FROM inbound_rules;

CREATE TABLE inbound_rule_actions_new (
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
  field_templates TEXT,
  fan_out TEXT NOT NULL DEFAULT 'pair'
    CHECK (fan_out IN ('pair', 'person', 'message')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inbound_rule_actions_new
  (id, rule_id, position, action_type, emoji, project_id, type_id, priority_id,
   subject_template, description_template, message_template, reply_target,
   reply_contact_id, reply_raw, field_templates, created_at)
SELECT id, rule_id, position, action_type, emoji, project_id, type_id, priority_id,
       subject_template, description_template, message_template, reply_target,
       reply_contact_id, reply_raw, field_templates, created_at
FROM inbound_rule_actions;

DROP TABLE inbound_rule_actions;
DROP TABLE inbound_rules;
ALTER TABLE inbound_rules_new RENAME TO inbound_rules;
ALTER TABLE inbound_rule_actions_new RENAME TO inbound_rule_actions;
CREATE INDEX idx_inbound_rule_actions_rule ON inbound_rule_actions(rule_id, position);
