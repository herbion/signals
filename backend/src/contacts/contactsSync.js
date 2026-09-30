import { fetchUsers } from '../openproject/openprojectClient.js';

/**
 * Normalizes an OpenProject phone value into the E.164 form Signal expects.
 *
 * Two real-world quirks this exists for:
 *  - A numeric OpenProject custom field arrives as a JSON *number*
 *    (`380996075027`), not a string. (Phone numbers max out at 15 digits,
 *    comfortably inside Number.MAX_SAFE_INTEGER, so no precision is lost.)
 *  - Those values have no leading `+`, which signal-cli requires.
 *
 * Note: a number in national format with a single leading trunk zero
 * (e.g. `0996075027`) can't be repaired here -- the country code simply
 * isn't in the data. It passes through as `+0996...` and fails visibly at
 * send time rather than being silently dropped.
 */
export function normalizePhone(value) {
  if (value === null || value === undefined) return null;

  const compact = String(value).trim().replace(/[\s()\-.]/g, '');
  if (!compact) return null;

  if (compact.startsWith('+')) return /^\+\d+$/.test(compact) ? compact : null;

  // Leading 00 is the international dialing prefix; the rest is already E.164.
  const digits = compact.startsWith('00') ? compact.slice(2) : compact;
  if (!/^\d+$/.test(digits)) return null;

  return `+${digits}`;
}

/**
 * Extracts a phone number from one OpenProject user resource. The field is
 * whichever `customFieldNN` the admin configured as the phone field (e.g.
 * a field named "Телефон"). Values arrive as strings, numbers, or (for
 * formatted custom field types) a `{ raw }` object.
 */
export function extractPhone(user, phoneCustomField) {
  const value = user?.[phoneCustomField];
  if (value && typeof value === 'object') return normalizePhone(value.raw);
  return normalizePhone(value);
}

export function userDisplayName(user) {
  // `??` alone wouldn't fall through here: an empty name and an empty
  // first/last join are both '' (defined), not null.
  const joined = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return user.name || joined || user.login || `User ${user.id}`;
}

/**
 * Active OpenProject users as `{id, name}` pairs, for a picker that needs a
 * real person rather than a schema field's own allowed-values list (which,
 * for a `User`-typed field like assignee, is frequently absent -- the form
 * endpoint only returns it when the install exposes an assignable-users
 * href). A locked or invited user would fail if a rule tried to assign to
 * them, so only active ones are offered.
 */
export function toUserOptions(users) {
  return (users ?? [])
    .filter((u) => (u.status ?? 'active') === 'active')
    .map((u) => ({ id: u.id, name: userDisplayName(u) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pulls OpenProject users into the contacts table, keyed by
 * `openproject_user_id` so re-running updates existing rows rather than
 * duplicating them. Users with no phone value are skipped (counted as
 * `skipped`) -- they'd produce a contact we could never send to.
 *
 * Manually-created contacts (openproject_user_id IS NULL) are never touched.
 */
export function syncContactsFromOpenProject(db, users, phoneCustomField) {
  const result = { created: 0, updated: 0, skipped: 0 };

  for (const user of users) {
    const phone = extractPhone(user, phoneCustomField);
    if (!phone) {
      result.skipped += 1;
      continue;
    }

    const name = userDisplayName(user);
    const existing = db.prepare('SELECT id FROM contacts WHERE openproject_user_id = ?').get(user.id);

    if (existing) {
      db.prepare(
        `UPDATE contacts SET name = ?, signal_identifier = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(name, phone, existing.id);
      result.updated += 1;
    } else {
      db.prepare(
        `INSERT INTO contacts (name, type, signal_identifier, notes, openproject_user_id)
         VALUES (?, 'individual', ?, 'Synced from OpenProject', ?)`
      ).run(name, phone, user.id);
      result.created += 1;
    }
  }

  return result;
}

/** Fetches from OpenProject and syncs in one step; throws with a clear message if not configured. */
export async function runContactSync(db) {
  const settings = db.prepare('SELECT * FROM openproject_settings WHERE id = 1').get();
  if (!settings?.base_url || !settings?.api_key) {
    throw new Error('OpenProject base URL and API key must be configured first (Settings → OpenProject)');
  }
  if (!settings.phone_custom_field) {
    throw new Error('No phone custom field configured (Settings → OpenProject → phone custom field)');
  }

  const users = await fetchUsers(settings.base_url, settings.api_key);
  return syncContactsFromOpenProject(db, users, settings.phone_custom_field);
}
