-- Migration 007: Inbound Signal message processing, group filtering, and OpenProject ticket creation defaults.
ALTER TABLE signal_settings ADD COLUMN inbound_webhook_token TEXT;
ALTER TABLE signal_settings ADD COLUMN default_project_id TEXT;
ALTER TABLE signal_settings ADD COLUMN default_type_id TEXT;
ALTER TABLE signal_settings ADD COLUMN group_filter TEXT;
ALTER TABLE signal_settings ADD COLUMN auto_reply_enabled INTEGER NOT NULL DEFAULT 1;
