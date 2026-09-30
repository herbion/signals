/**
 * `field_values` is stored as JSON and handed out as an object, so neither the
 * dashboard nor the ticket builder has to know it was ever a string. A
 * malformed blob reads as "nothing recorded" rather than breaking the list.
 */
function rowToContact(row) {
  if (!row) return null;
  let fieldValues = {};
  try {
    const parsed = row.field_values ? JSON.parse(row.field_values) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fieldValues = parsed;
  } catch {
    fieldValues = {};
  }
  return { ...row, field_values: fieldValues, needs_classification: Boolean(row.needs_classification) };
}

export function listAll(db) {
  return db.prepare('SELECT * FROM contacts ORDER BY name ASC').all().map(rowToContact);
}

export function getById(db, id) {
  return rowToContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
}

export function getByOpenProjectUserId(db, openprojectUserId) {
  return rowToContact(db.prepare('SELECT * FROM contacts WHERE openproject_user_id = ?').get(openprojectUserId));
}

export function getBySignalIdentifier(db, signalIdentifier) {
  if (!signalIdentifier) return null;
  return rowToContact(db.prepare('SELECT * FROM contacts WHERE signal_identifier = ? LIMIT 1').get(signalIdentifier));
}


/**
 * True when this Signal number/group id belongs to a muted contact.
 *
 * Checked against the resolved identifier rather than the rule's contact id,
 * so muting works no matter how a rule reaches the person -- fixed contact,
 * author/assignee resolution, or a raw number typed into a rule that happens
 * to be the same number. Otherwise "mute this contact" would leave an
 * obvious hole.
 */
export function isRecipientMuted(db, signalIdentifier) {
  if (!signalIdentifier) return false;
  const row = db
    .prepare('SELECT 1 AS muted FROM contacts WHERE signal_identifier = ? AND muted = 1 LIMIT 1')
    .get(signalIdentifier);
  return Boolean(row);
}

/**
 * A contact the bridge added itself, because a rule needed a value recorded
 * against whoever sent a message and this sender had no record at all.
 *
 * It starts flagged: the row exists only so a human can say which list entry
 * this person is, and the contacts screen asks for exactly the flagged ones.
 */
export function createFromSignal(db, { identifier, name }) {
  const info = db
    .prepare(
      `INSERT INTO contacts (name, type, signal_identifier, notes, needs_classification)
       VALUES (?, 'individual', ?, ?, 1)`
    )
    .run(
      String(name ?? '').trim() || identifier,
      identifier,
      'Added automatically from an inbound Signal message.'
    );
  return getById(db, info.lastInsertRowid);
}

/** Contacts a rule has asked a question about and not got an answer for. */
export function listNeedingClassification(db) {
  return db
    .prepare('SELECT * FROM contacts WHERE needs_classification = 1 ORDER BY updated_at DESC, name ASC')
    .all()
    .map(rowToContact);
}

export function markNeedsClassification(db, id) {
  db.prepare(
    "UPDATE contacts SET needs_classification = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
  return getById(db, id);
}

/**
 * Records which list entries this contact stands for, keyed by OpenProject
 * schema key. Answering the question is what clears the flag, so a contact
 * saved with nothing filled in stays on the list.
 */
export function setFieldValues(db, id, fieldValues) {
  const entries = Object.entries(fieldValues ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && String(value).trim() !== ''
  );
  const serialized = entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
  db.prepare(
    `UPDATE contacts SET field_values = ?, needs_classification = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(serialized, entries.length ? 0 : 1, id);
  return getById(db, id);
}

export function create(db, contact) {
  const info = db
    .prepare('INSERT INTO contacts (name, type, signal_identifier, notes, muted) VALUES (?, ?, ?, ?, ?)')
    .run(contact.name, contact.type, contact.signalIdentifier, contact.notes ?? null, contact.muted ? 1 : 0);
  return getById(db, info.lastInsertRowid);
}

export function update(db, id, contact) {
  db.prepare(
    `UPDATE contacts SET name = ?, type = ?, signal_identifier = ?, notes = ?, muted = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(contact.name, contact.type, contact.signalIdentifier, contact.notes ?? null, contact.muted ? 1 : 0, id);
  return getById(db, id);
}

/** Quick toggle from the contacts list, without round-tripping the whole record. */
export function setMuted(db, id, muted) {
  db.prepare("UPDATE contacts SET muted = ?, updated_at = datetime('now') WHERE id = ?").run(muted ? 1 : 0, id);
  return getById(db, id);
}

export function remove(db, id) {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
}
