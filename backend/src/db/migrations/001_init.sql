CREATE TABLE admin_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table (id always 1) holding the OpenProject connection.
CREATE TABLE openproject_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT,
  api_key TEXT,
  -- Verifies X-OP-Signature on incoming webhooks. Must match the secret
  -- configured on the OpenProject webhook itself.
  webhook_secret TEXT,
  -- Second secret layer: part of the webhook URL path
  -- (/webhooks/openproject/:webhook_token) so the endpoint isn't guessable
  -- even before the signature is checked.
  webhook_token TEXT,
  -- JSON: { types: [], statuses: [], projects: [], customFields: [], fetchedAt }
  -- Cached dropdown metadata for the rule condition-builder UI.
  metadata_cache TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table (id always 1) holding the Signal transport connection.
CREATE TABLE signal_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signal_api_base_url TEXT NOT NULL DEFAULT 'http://signal-api:8080',
  bot_number TEXT,
  receive_mode TEXT NOT NULL DEFAULT 'poll' CHECK (receive_mode IN ('poll', 'websocket')),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 10,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('individual', 'group')),
  signal_identifier TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Optional OpenProject project id/identifier filter applied before the
  -- condition tree, so "project equals X" doesn't need to be re-encoded in
  -- every rule's conditions.
  project_scope TEXT,
  -- JSON ConditionGroup tree. See rules/ruleEvaluator.js and CLAUDE.md for
  -- the schema and evaluation semantics.
  condition_tree TEXT NOT NULL,
  action_recipient_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  -- Fallback raw Signal number/group id when not using a saved contact.
  action_recipient_raw TEXT,
  message_template TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  work_package_id INTEGER,
  recipient TEXT,
  sender TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending', 'received')),
  error_message TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_message_log_created_at ON message_log(created_at);
CREATE INDEX idx_message_log_direction ON message_log(direction);

-- Last-known state of each OpenProject work package, used to compute a diff
-- on every webhook delivery since OpenProject only sends current state.
CREATE TABLE work_package_state_cache (
  work_package_id INTEGER PRIMARY KEY,
  project_id INTEGER,
  -- JSON flat WorkPackageSnapshot (see webhooks/payloadNormalizer.js).
  snapshot TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  -- OpenProject's own updatedAt timestamp from the payload -- NOT our local
  -- wall clock. This is what makes out-of-order-delivery detection correct;
  -- do not replace with updated_locally_at in diffing logic.
  last_updated_at TEXT NOT NULL,
  updated_locally_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit/dedup log of every webhook delivery received, independent of
-- whether it changed the state cache.
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_package_id INTEGER NOT NULL,
  op_updated_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'duplicate_ignored', 'out_of_order_ignored', 'error'))
);
CREATE UNIQUE INDEX idx_webhook_events_dedup ON webhook_events(work_package_id, payload_hash);
