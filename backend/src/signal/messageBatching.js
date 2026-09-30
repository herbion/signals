import { sendMessage } from './signalSender.js';

/**
 * Signal's own compose UI caps a message at 2000 characters; sending more
 * than that through the REST API doesn't error, but at least one Signal
 * client is known to silently truncate what it shows the recipient. Packing
 * stays under this so a grouped reply never loses its tail end.
 */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Greedily packs message bodies into as few sends as possible, none longer
 * than `maxLength`. A single body that alone exceeds the limit is sent on
 * its own rather than split -- cutting a ticket number in half is worse than
 * one oversized message.
 */
export function packMessages(parts, { maxLength = MAX_MESSAGE_LENGTH, separator = '\n\n' } = {}) {
  const batches = [];
  let current = [];
  let currentLength = 0;

  for (const part of parts) {
    const text = String(part ?? '').trim();
    if (!text) continue;

    const joinedLength = currentLength === 0 ? text.length : currentLength + separator.length + text.length;
    if (current.length > 0 && joinedLength > maxLength) {
      batches.push(current.join(separator));
      current = [text];
      currentLength = text.length;
    } else {
      current.push(text);
      currentLength = joinedLength;
    }
  }
  if (current.length > 0) batches.push(current.join(separator));

  return batches;
}

/**
 * Sends a set of `{ recipient, message }` replies, combining whatever shares
 * a recipient into as few Signal messages as `packMessages` allows -- e.g.
 * several ticket confirmations from one approved batch, or one of those plus
 * the "Approved" notice that follows it. A failed group is logged and does
 * not stop the others, matching how each of these sends failed independently
 * before they were grouped.
 */
export async function flushReplies(db, replies) {
  const byRecipient = new Map();
  for (const { recipient, message } of replies) {
    if (!recipient || !message) continue;
    if (!byRecipient.has(recipient)) byRecipient.set(recipient, []);
    byRecipient.get(recipient).push(message);
  }

  for (const [recipient, messages] of byRecipient) {
    for (const message of packMessages(messages)) {
      try {
        await sendMessage(db, { recipient, message });
      } catch (err) {
        console.error('Grouped reply failed:', err.message);
      }
    }
  }
}
