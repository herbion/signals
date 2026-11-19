import crypto from 'node:crypto';
import { sendMessage } from './signalSender.js';
import { postRuleComment } from '../rules/commentBack.js';

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
 * Recipients whose batch is ready to go out: some queued message for them has
 * waited out its window -- the row's own `batch_window_seconds` (copied from
 * its rule, migration 020) or else the global grouping window. Once one row
 * is due, everything queued for that person goes with it, so a long-window
 * rule's messages leave early rather than as a second ping later.
 *
 * Each window runs from its row's creation rather than resetting on each new
 * one: a debounce would let a steady stream of edits postpone delivery
 * indefinitely, whereas this caps the delay at the window.
 */
export function findDueRecipients(db, windowSeconds, { now = "datetime('now')" } = {}) {
  return db
    .prepare(
      `SELECT recipient, COUNT(*) AS queued
       FROM message_log
       WHERE direction = 'outbound' AND status = 'pending' AND batch_id IS NULL AND recipient IS NOT NULL
       GROUP BY recipient
       HAVING MAX((julianday(${now}) - julianday(created_at)) * 86400.0
                  - COALESCE(batch_window_seconds, @windowSeconds)) >= 0`
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
      .prepare(
        'SELECT id, content, rule_id, work_package_id, pending_comment FROM message_log WHERE batch_id = ? ORDER BY id ASC'
      )
      .all(batchId);
    if (rows.length === 0) continue;

    const message = buildBatchMessage(rows.map((r) => r.content), { textMode: settings.text_mode });

    try {
      await sendMessage(db, { recipient, message });
      db.prepare("UPDATE message_log SET status = 'sent' WHERE batch_id = ?").run(batchId);
      messages += rows.length;
      await postPendingComments(db, rows);
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

/**
 * The comment-backs that were waiting on this batch (see ruleProcessor):
 * posted only now that the message has really gone, and never for a failed
 * batch. Cleared first, so a crash mid-way cannot post one twice.
 */
async function postPendingComments(db, rows) {
  for (const row of rows) {
    if (!row.pending_comment) continue;
    db.prepare('UPDATE message_log SET pending_comment = NULL WHERE id = ?').run(row.id);
    await postRuleComment(db, { ruleId: row.rule_id, workPackageId: row.work_package_id, comment: row.pending_comment });
  }
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
