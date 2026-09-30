-- Bulk edits in OpenProject (or several rules matching at once) produced one
-- Signal message per work package, which reads as spam on the receiving end.
-- Outbound messages are now queued as 'pending' and flushed by
-- signal/outboundDispatcher.js, combining everything headed to the same
-- recipient within the window into a single Signal message.
ALTER TABLE signal_settings ADD COLUMN grouping_enabled INTEGER NOT NULL DEFAULT 1;

-- Counted from the FIRST queued message for a recipient (not a debounce), so
-- delivery latency is bounded at this many seconds even during a long burst.
ALTER TABLE signal_settings ADD COLUMN grouping_window_seconds INTEGER NOT NULL DEFAULT 60;

-- Set when rows are claimed for delivery; rows sharing a batch_id went out in
-- one Signal message. Also acts as the claim marker that stops a second
-- dispatcher pass from picking up rows already in flight.
ALTER TABLE message_log ADD COLUMN batch_id TEXT;

CREATE INDEX idx_message_log_pending
  ON message_log(direction, status, recipient);
