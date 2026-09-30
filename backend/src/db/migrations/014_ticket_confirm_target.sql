-- Migration 014: choose where a created ticket's confirmation reply goes.
--
-- `signal_settings.auto_reply_enabled` is still the master on/off switch, but
-- every ticket action confirmed back to wherever the request came from, with
-- no way to route it to the reviewer instead on a rule whose ticket needs
-- approval first -- the group that asked isn't necessarily who should see the
-- ticket number once it exists. `confirm_target` is per-action, the same way
-- `reply_target` already is for `send_message`, and reuses `approval_recipient`
-- as the reviewer's address rather than adding a second number field.
ALTER TABLE inbound_rule_actions ADD COLUMN confirm_target TEXT NOT NULL DEFAULT 'source'
  CHECK (confirm_target IN ('source', 'reviewer'));
