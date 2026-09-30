/**
 * Group directory for signal-cli-rest-api.
 *
 * A Signal group has two identifiers and they are NOT interchangeable:
 *   - `id`          "group.<base64>"  -- what /v2/send accepts as a recipient
 *   - `internal_id` "<base64>"        -- what arrives on received envelopes
 *
 * Replying to a group with the id off an incoming envelope therefore fails,
 * which is why every inbound group id gets translated through here before it
 * is used as a recipient.
 */

import { signalFetch } from './signalHttp.js';

let cache = { groups: [], fetchedAt: 0, botNumber: null };
const TTL_MS = 5 * 60 * 1000;

export async function fetchGroups(baseUrl, botNumber) {
  // On the inbound path (every group id gets translated here), so it carries
  // the same deadline as the rest -- a wedged signal-cli must not stall a
  // message before it has even been logged. See signalHttp.js.
  const response = await signalFetch(`${baseUrl}/v1/groups/${encodeURIComponent(botNumber)}`);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`signal-cli-rest-api /v1/groups failed: ${response.status} ${body}`);
  }
  const groups = await response.json();
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    id: g.id,
    internalId: g.internal_id,
    name: g.name ?? '',
    membersCount: Array.isArray(g.members) ? g.members.length : null,
  }));
}

/** Cached list; a background lookup on every inbound message would be silly. */
export async function getGroups(db, { force = false } = {}) {
  const settings = db.prepare('SELECT signal_api_base_url, bot_number FROM signal_settings WHERE id = 1').get();
  if (!settings?.bot_number) return [];

  const stale = Date.now() - cache.fetchedAt > TTL_MS || cache.botNumber !== settings.bot_number;
  if (force || stale) {
    const groups = await fetchGroups(settings.signal_api_base_url, settings.bot_number);
    cache = { groups, fetchedAt: Date.now(), botNumber: settings.bot_number };
  }
  return cache.groups;
}

export function resetGroupCache() {
  cache = { groups: [], fetchedAt: 0, botNumber: null };
}

/**
 * Turns whatever group id an envelope carried into the sendable "group.<b64>"
 * form. Falls back to the subscription table when the live lookup is
 * unavailable, and finally returns the input unchanged so a caller that was
 * already handed a send-id keeps working.
 */
export async function toSendableGroupId(db, envelopeGroupId) {
  if (!envelopeGroupId) return null;
  if (String(envelopeGroupId).startsWith('group.')) return envelopeGroupId;

  const subscription = db
    .prepare('SELECT group_id FROM signal_group_subscriptions WHERE internal_id = ?')
    .get(envelopeGroupId);
  if (subscription?.group_id) return subscription.group_id;

  try {
    const groups = await getGroups(db);
    const found = groups.find((g) => g.internalId === envelopeGroupId);
    if (found) return found.id;
  } catch (err) {
    console.error('Group id lookup failed:', err.message);
  }
  return envelopeGroupId;
}

/** Human-readable group name for message templates, best effort. */
export function groupNameFor(db, envelopeGroupId) {
  if (!envelopeGroupId) return '';
  const row = db
    .prepare('SELECT name FROM signal_group_subscriptions WHERE internal_id = ? OR group_id = ?')
    .get(envelopeGroupId, envelopeGroupId);
  if (row?.name) return row.name;
  const cached = cache.groups.find((g) => g.internalId === envelopeGroupId || g.id === envelopeGroupId);
  return cached?.name ?? '';
}
