CREATE TABLE inbound_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_pattern TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('create_ticket', 'reply')),
  action_target_project_id TEXT,
  action_target_type_id TEXT,
  action_reply_template TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
