import crypto from 'node:crypto';
import * as stateCache from './stateCache.repository.js';

const RELATION_FIELDS = ['type', 'status', 'project', 'assignee', 'author', 'priority'];

/**
 * Deterministic hash of a normalized snapshot, used to detect exact-duplicate
 * webhook redeliveries independent of field order.
 */
export function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A work package's first-ever webhook is treated as a "created" event when
 * createdAt and updatedAt are within a few seconds of each other. Exposed to
 * rules as the synthetic `event_type_created` condition, since there is no
 * prior state to diff a "created" transition out of.
 */
export function isCreationEvent(snapshot) {
  // OpenProject states this outright in the webhook envelope, so prefer it.
  // The timestamp fallback below only covers payloads that omit `action`;
  // on its own it misses real creations whose updatedAt drifts past the
  // window (a work package created with attachments, or created via API
  // with an immediate follow-up write).
  if (snapshot.action) return snapshot.action === 'work_package:created';

  if (!snapshot.createdAt || !snapshot.updatedAt) return false;
  const delta = Math.abs(new Date(snapshot.updatedAt) - new Date(snapshot.createdAt));
  return delta < 5000;
}

/**
 * Compares a new snapshot to the previously cached one (or `null` if this
 * work package has never been seen before) and returns a ChangeSet: one
 * entry per tracked field with { field, from, to, changed }.
 *
 * When `oldSnapshot` is null, every field comes back with changed: false --
 * there is nothing to diff against, so transition-based conditions
 * (any_change / changed_to / changed_from) must never match on first sight.
 * Only state-only conditions (equals / is_empty) can match a first-sight event.
 */
export function computeChangeSet(newSnapshot, oldSnapshot) {
  const entries = [];

  const scalarFields = ['subject'];
  for (const field of scalarFields) {
    entries.push(diffEntry(field, newSnapshot[field], oldSnapshot?.[field] ?? null, Boolean(oldSnapshot)));
  }

  for (const field of RELATION_FIELDS) {
    entries.push(
      diffEntry(field, newSnapshot[field], oldSnapshot?.[field] ?? null, Boolean(oldSnapshot), relationsEqual)
    );
  }

  const customFieldKeys = new Set([
    ...Object.keys(newSnapshot.customFields ?? {}),
    ...Object.keys(oldSnapshot?.customFields ?? {}),
  ]);
  for (const key of customFieldKeys) {
    const newValue = newSnapshot.customFields?.[key] ?? null;
    const oldValue = oldSnapshot?.customFields?.[key] ?? null;
    entries.push(diffEntry(`customField:${key}`, newValue, oldValue, Boolean(oldSnapshot), relationsEqual));
  }

  return entries;
}

function diffEntry(field, to, from, hasPriorState, equalsFn = defaultEquals) {
  return {
    field,
    from: hasPriorState ? from : null,
    to,
    changed: hasPriorState ? !equalsFn(from, to) : false,
  };
}

function defaultEquals(a, b) {
  return a === b;
}

function relationsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a === 'object' && typeof b === 'object') return a.id === b.id;
  return a === b;
}

/**
 * Runs the full diff/idempotency algorithm for one incoming webhook and
 * persists the outcome. See CLAUDE.md "Diffing & Idempotency Algorithm" for
 * the numbered description this implements.
 */
export function processWebhookEvent(db, snapshot) {
  const workPackageId = snapshot.id;
  const payloadHash = hashSnapshot(snapshot);

  const exactDuplicate = db
    .prepare('SELECT 1 FROM webhook_events WHERE work_package_id = ? AND payload_hash = ?')
    .get(workPackageId, payloadHash);
  if (exactDuplicate) {
    return { status: 'duplicate_ignored', workPackageId, changeSet: [], eventType: null, snapshot };
  }

  const cached = stateCache.getByWorkPackageId(db, workPackageId);

  if (cached && snapshot.updatedAt <= cached.last_updated_at) {
    const outcome = snapshot.updatedAt < cached.last_updated_at ? 'out_of_order_ignored' : 'duplicate_ignored';
    recordWebhookEvent(db, workPackageId, snapshot.updatedAt, payloadHash, outcome);
    return { status: outcome, workPackageId, changeSet: [], eventType: null, snapshot };
  }

  const changeSet = computeChangeSet(snapshot, cached?.snapshot ?? null);
  const eventType = !cached && isCreationEvent(snapshot) ? 'created' : null;

  stateCache.upsert(db, {
    workPackageId,
    projectId: snapshot.project?.id ?? null,
    snapshot,
    payloadHash,
    lastUpdatedAt: snapshot.updatedAt,
  });
  recordWebhookEvent(db, workPackageId, snapshot.updatedAt, payloadHash, 'processed');

  return { status: 'processed', workPackageId, changeSet, eventType, snapshot };
}

function recordWebhookEvent(db, workPackageId, opUpdatedAt, payloadHash, outcome) {
  db.prepare(
    `INSERT INTO webhook_events (work_package_id, op_updated_at, payload_hash, outcome)
     VALUES (?, ?, ?, ?)`
  ).run(workPackageId, opUpdatedAt, payloadHash, outcome);
}
