import crypto from 'node:crypto';
import { sendMessage } from './signalSender.js';

let timer = null;
const TICK_MS = 5000;

/**
 * Combines the queued messages for one recipient into a single Signal
 * message. A lone message is sent exactly as its rule rendered it -- no
 * header -- so single notifications look no different than before batching.
 */
export function buildBatchMessage(contents, { textMode } = {}) {
  if (contents.length === 1) return contents[0];
  const heading = `${contents.length} updates`;
  const header = textMode === 'styled' ? `📬 **${heading}**` : `📬 ${heading}`;
  return [header, ...contents].join('\n\n');
}

/**
 * Recipients whose oldest queued message is older than the grouping window,
 * i.e. whose batch is ready to go out.
 *
 * The window runs from the FIRST queued message rather than resetting on each
 * new one: a debounce would let a steady stream of edits postpone delivery
 * indefinitely, whereas this caps the delay at grouping_window_seconds.
 */
export function findDueRecipients(db, windowSeconds, { now = "datetime('now')" } = {}) {
  return db
    .prepare(
      `SELECT recipient, COUNT(*) AS queued
       FROM message_log
       WHERE direction = 'outbound' AND status = 'pending' AND batch_id IS NULL AND recipient IS NOT NULL
       GROUP BY recipient
       HAVING (julianday(${now}) - julianday(MIN(created_at))) * 86400.0 >= @windowSeconds`
    )
    .all({ windowSeconds });
}

/**
 * Flushes every batch whose window has elapsed. Safe to call repeatedly; rows
 * are claimed with a batch_id before the network call so an overlapping pass
 * can't send them twice.
 */
export async function dispatchDueBatches(db) {
  const settings = db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();
  if (!settings) return { batches: 0, messages: 0 };

  // Deliberately not gated on grouping_enabled: if grouping is switched off
  // while rows are still queued, they must still drain.
  const windowSeconds = Math.max(0, settings.grouping_window_seconds ?? 60);
  const due = findDueRecipients(db, windowSeconds);

  let messages = 0;
  for (const { recipient } of due) {
    const batchId = crypto.randomUUID();

    db.prepare(
      `UPDATE message_log SET batch_id = @batchId
       WHERE direction = 'outbound' AND status = 'pending' AND batch_id IS NULL AND recipient = @recipient`
    ).run({ batchId, recipient });

    const rows = db
      .prepare('SELECT id, content FROM message_log WHERE batch_id = ? ORDER BY id ASC').all(batchId);
    if (rows.length === 0) continue;

    const message = buildBatchMessage(rows.map((r) => r.content), { textMode: settings.text_mode });

    try {
      await sendMessage(db, { recipient, message });
      db.prepare("UPDATE message_log SET status = 'sent' WHERE batch_id = ?").run(batchId);
      messages += rows.length;
    } catch (err) {
      // Leave batch_id set so the failed grouping stays visible in the log
      // rather than silently re-queueing into a later, different batch.
      db.prepare("UPDATE message_log SET status = 'failed', error_message = ? WHERE batch_id = ?").run(
        err.message,
        batchId
      );
    }
  }

  return { batches: due.length, messages };
}

export function startOutboundDispatcher(db) {
  stopOutboundDispatcher();
  const tick = async () => {
    try {
      await dispatchDueBatches(db);
    } catch (err) {
      console.error('Outbound dispatch failed', err.message);
    } finally {
      timer = setTimeout(tick, TICK_MS);
    }
  };
  timer = setTimeout(tick, TICK_MS);
}

export function stopOutboundDispatcher() {
  if (timer) clearTimeout(timer);
  timer = null;
}
