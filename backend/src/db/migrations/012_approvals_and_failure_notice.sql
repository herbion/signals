-- Migration 012: hold an action for human review, and tell a human when one
-- fails.
--
-- Filing work packages straight off a parsed Signal message is a lot of trust
-- to place in a parser. `require_approval` makes an action wait: the bot sends
-- what it is about to do to `approval_recipient` and does nothing further until
-- somebody reacts to that message with ✅ / 👍 (or ❌ / 👎 to drop it).
--
-- `failure_recipient` is the other half of the same problem. A failed action
-- already writes a message_log row, but nobody is watching the dashboard at
-- 23:00 -- so the reason goes to a person as a Signal message too.
--
-- Both are per-action: acknowledging a message with a reaction needs no
-- review, while the ticket it produces might.
ALTER TABLE inbound_rule_actions ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbound_rule_actions ADD COLUMN approval_recipient TEXT;
ALTER TABLE inbound_rule_actions ADD COLUMN failure_recipient TEXT;

-- One row per held request, not per action: a rule whose ticket action fans
-- out into four work packages asks the reviewer once, and `payload` carries
-- everything needed to run them later.
--
-- `review_timestamp` is the timestamp /v2/send returned for the review message.
-- Signal has no message id, so (bot number, that timestamp) *is* the id the
-- reviewer's reaction will name as its target.
--
-- `rule_name` is denormalized on purpose: there is no foreign key to
-- inbound_rules, so deleting a rule leaves its decided approvals readable as
-- the audit trail they are.
CREATE TABLE pending_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER,
  rule_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer TEXT NOT NULL,
  review_timestamp INTEGER,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,
  decision_emoji TEXT
);
CREATE INDEX idx_pending_approvals_review ON pending_approvals(review_timestamp, status);
