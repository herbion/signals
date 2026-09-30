-- Migration 018: a rule listens to a *set* of groups, not one.
--
-- `source_group_id` could only ever name a single group, and the editor only
-- offered it for `source_scope = 'group'` -- so "groups and direct messages,
-- but only these two groups" could not be expressed at all. `source_group_ids`
-- is a JSON array of sendable group ids (`group.<base64>`, the same id
-- `signal_group_subscriptions.group_id` stores); empty or NULL means every
-- group the bot is subscribed to, which is what an unrestricted rule always
-- meant.
--
-- The filter now applies only to messages that actually have a group, so a
-- rule scoped to 'any' keeps receiving direct messages while its group half is
-- narrowed. Under the old column that combination silently matched nothing but
-- group messages, so rows carrying it are rewritten as what they effectively
-- were -- a group-only rule -- rather than quietly gaining direct messages
-- they were never firing on.
ALTER TABLE inbound_rules ADD COLUMN source_group_ids TEXT;

UPDATE inbound_rules
   SET source_scope = 'group'
 WHERE source_scope = 'any'
   AND source_group_id IS NOT NULL
   AND TRIM(source_group_id) <> '';

-- Built by concatenation rather than json_array(): a Signal group id is
-- `group.` plus base64, which contains nothing JSON would need escaped, and
-- this does not depend on the JSON extension being compiled in.
UPDATE inbound_rules
   SET source_group_ids = '["' || source_group_id || '"]'
 WHERE source_group_id IS NOT NULL
   AND TRIM(source_group_id) <> '';

ALTER TABLE inbound_rules DROP COLUMN source_group_id;
