-- Migration 019: an outbound rule can also write a comment back on the work
-- package it fired for ("Повідомлено в Signal: ..."), so the people working
-- the ticket in OpenProject can see the requester was told without opening
-- this dashboard.
--
-- NULL / blank means no comment, which is every rule that existed before.
-- The comment is posted only once the Signal message was sent or queued --
-- a comment claiming someone was notified when they were not would be worse
-- than none. See ruleProcessor.processChangeEvent.
--
-- No column is needed for the other half of that feature (notifying the
-- person named in a text custom field such as "🎯На кого"): it reuses
-- `action_recipient_dynamic_relation`, which now also accepts a
-- `customFieldNN` key next to 'author' / 'assignee'.
ALTER TABLE rules ADD COLUMN comment_template TEXT;

-- An optional per-rule limit on who may receive it: a JSON array of contact
-- ids, NULL / [] meaning anyone. Exists for trying a rule out on real
-- traffic while only a few test contacts can actually be messaged. The
-- recipient is still resolved against *all* contacts first (so a name that
-- matches two people stays an error), and only then checked against this
-- list; a recipient outside it is logged as suppressed, not sent -- and gets
-- no comment either.
ALTER TABLE rules ADD COLUMN allowed_contact_ids TEXT;
