-- Inbound message polling was always-on and would spam the logs with
-- "GET /v1/receive failed: 400" before a number is fully linked and
-- receive-capable (this also seems to depend on the signal-cli-rest-api
-- MODE -- not all modes support the plain REST /v1/receive endpoint the
-- same way). Gate it behind an explicit opt-in flag, off by default.
ALTER TABLE signal_settings ADD COLUMN receive_enabled INTEGER NOT NULL DEFAULT 0;
