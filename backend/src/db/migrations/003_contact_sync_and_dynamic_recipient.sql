-- Links a contact back to the OpenProject user it was synced from, so
-- re-syncing updates the same row instead of duplicating it, and so rules
-- can resolve "the work package's author" to a contact. NULL for contacts
-- entered by hand.
ALTER TABLE contacts ADD COLUMN openproject_user_id INTEGER;
CREATE UNIQUE INDEX idx_contacts_openproject_user
  ON contacts(openproject_user_id) WHERE openproject_user_id IS NOT NULL;

-- Which OpenProject *user* custom field holds the phone number
-- (e.g. 'customField5' for a field named "Телефон"). Used by contact sync.
ALTER TABLE openproject_settings ADD COLUMN phone_custom_field TEXT;

-- Recipient resolution mode for a rule:
--   'contact' -> action_recipient_contact_id (a fixed saved contact)
--   'raw'     -> action_recipient_raw (a literal number/group id)
--   'dynamic' -> look up the contact linked to the work package's
--                author/assignee at send time (action_recipient_dynamic_relation)
-- Existing rules default to 'contact'; ruleProcessor falls back to raw when
-- no contact id is set, preserving pre-migration behavior either way.
ALTER TABLE rules ADD COLUMN action_recipient_mode TEXT NOT NULL DEFAULT 'contact';
ALTER TABLE rules ADD COLUMN action_recipient_dynamic_relation TEXT;
