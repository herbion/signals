-- Per-contact kill switch: a muted contact is never messaged, regardless of
-- which rule targets them or how (fixed contact, resolved author/assignee, or
-- a raw number that happens to match their signal_identifier).
ALTER TABLE contacts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;

-- A suppressed message is neither 'sent' nor 'failed' -- nothing went wrong,
-- so folding it into 'failed' would make the dashboard's failure count (and
-- its "no delivery errors" reading) meaningless. SQLite can't alter a CHECK
-- constraint in place, hence the table rebuild. Dropping message_log is safe
-- even with foreign_keys ON: it is the child of rules, and nothing references
-- message_log itself.
CREATE TABLE message_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  work_package_id INTEGER,
  recipient TEXT,
  sender TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending', 'received', 'muted')),
  error_message TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  batch_id TEXT
);

INSERT INTO message_log_new
  (id, direction, rule_id, work_package_id, recipient, sender, content, status, error_message, raw_payload, created_at, batch_id)
SELECT
  id, direction, rule_id, work_package_id, recipient, sender, content, status, error_message, raw_payload, created_at, batch_id
FROM message_log;

DROP TABLE message_log;
ALTER TABLE message_log_new RENAME TO message_log;

-- Indexes live with the table, so they have to be recreated after the swap.
CREATE INDEX idx_message_log_created_at ON message_log(created_at);
CREATE INDEX idx_message_log_direction ON message_log(direction);
CREATE INDEX idx_message_log_pending ON message_log(direction, status, recipient);
