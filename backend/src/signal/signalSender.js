import { signalFetch } from './signalHttp.js';

function getSignalSettings(db) {
  return db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();
}

/**
 * Sends a Signal message via bbernhard/signal-cli-rest-api's `/v2/send`.
 * `recipient` is a phone number (individual) or group id, as stored on a
 * contact or entered raw on a rule.
 */
export async function sendMessage(db, { recipient, message }) {
  const settings = getSignalSettings(db);
  if (!settings?.bot_number) {
    throw new Error('Signal bot number is not configured (Settings -> Signal)');
  }

  const response = await signalFetch(`${settings.signal_api_base_url}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      number: settings.bot_number,
      recipients: [recipient],
      // "styled" makes signal-cli parse **bold** / *italic* / ~strike~ /
      // ||spoiler|| / `mono` in the message body. Omitting the field would
      // let signal-cli-rest-api's own DEFAULT_SIGNAL_TEXT_MODE env var
      // decide, so send it explicitly and keep this app's setting
      // authoritative.
      text_mode: settings.text_mode === 'styled' ? 'styled' : 'normal',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`signal-cli-rest-api /v2/send failed: ${response.status} ${body}`);
  }

  // /v2/send answers with the timestamp it sent under -- Signal's only handle
  // on a message, and what a reaction to it will name as its target. An
  // approval reaction is matched back to its review request by exactly this.
  // A send that worked must not fail here, so anything unreadable -- a body
  // that is not JSON, a version that answers with nothing -- is just no
  // timestamp. Only approval requests need one, and they check.
  const body =
    typeof response.json === 'function' ? await response.json().catch(() => null) : null;
  const timestamp = Number(body?.timestamp);
  return { timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null };
}

/**
 * Reacts to a message with an emoji via `POST /v1/reactions/{number}`.
 *
 * `recipient` is where the reaction is delivered (the group for a group
 * message, the sender for a DM), while `targetAuthor` + `timestamp` identify
 * which message inside that conversation is being reacted to -- Signal has no
 * message id, the author/sent-timestamp pair *is* the id.
 */
export async function sendReaction(db, { recipient, targetAuthor, timestamp, emoji, remove = false }) {
  const settings = getSignalSettings(db);
  if (!settings?.bot_number) {
    throw new Error('Signal bot number is not configured (Settings -> Signal)');
  }
  if (!emoji) throw new Error('reaction emoji is required');
  if (!targetAuthor) throw new Error('reaction target author is unknown for this message');
  if (!timestamp) throw new Error('reaction target timestamp is unknown for this message');

  const response = await signalFetch(`${settings.signal_api_base_url}/v1/reactions/${encodeURIComponent(settings.bot_number)}`, {
    method: remove ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reaction: emoji,
      recipient,
      target_author: targetAuthor,
      timestamp: Number(timestamp),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`signal-cli-rest-api /v1/reactions failed: ${response.status} ${body}`);
  }
}
