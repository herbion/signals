/**
 * Human review for inbound actions.
 *
 * An action marked `require_approval` does not run when its rule matches.
 * Instead the bot sends the reviewer exactly what it is about to do and holds
 * the work in `pending_approvals` until somebody reacts to that message with
 * ✅ / 👍 (run it) or ❌ / 👎 (drop it). This is the safety valve on a parser
 * that reads free text: a misread message costs a Signal message to a person
 * rather than a wrong work package in the unit's tracker.
 *
 * The held work is stored **already rendered** -- the item contexts the action
 * would have run with -- so approving it files what the reviewer was shown,
 * not whatever the message would parse to now.
 */
import { sendMessage } from './signalSender.js';
import { runAction } from './inboundActionExecutor.js';
import { renderTemplate } from './inboundMatcher.js';
import { flushReplies } from './messageBatching.js';
import * as messageLogRepo from '../messageLog/messageLog.repository.js';

const APPROVE = ['✅', '👍', '☑️', '✔️'];
const REJECT = ['❌', '👎', '🚫', '✖️'];

/** Which decision an emoji stands for, or null if it is just a reaction. */
export function decisionFor(emoji) {
  const mark = String(emoji ?? '').trim();
  if (APPROVE.includes(mark)) return 'approved';
  if (REJECT.includes(mark)) return 'rejected';
  return null;
}

/** One readable line per work package (or message) the action would produce. */
function describeAction(action, contexts) {
  const template =
    action.action_type === 'create_ticket'
      ? action.subject_template || '{person} — {forms}'
      : action.message_template || '';

  return contexts.map((context) => {
    const line = renderTemplate(template, context).trim();
    if (line) return line;
    // Nothing rendered -- a create_ticket action on a type that generates its
    // own subject, say. Fall back to whatever names the item.
    return [context.person, context.forms].filter(Boolean).join(' — ') || action.action_type;
  });
}

/** What the reviewer is shown. The substance comes from the rule's templates. */
export function buildReviewMessage({ rule, held, context }) {
  const who = context.senderName
    ? `${context.senderName} (${context.senderNumber ?? 'unknown'})`
    : context.senderNumber ?? context.senderUuid ?? 'unknown';
  const where = context.groupId ? context.groupName || context.groupId : 'direct message';

  const lines = held.flatMap((entry) => describeAction(entry.action, entry.contexts));
  const count = lines.length;

  return [
    `🔍 **Review needed** — rule "${rule.name}"`,
    `From ${who} in ${where}:`,
    '',
    context.messageText,
    '',
    `Will run ${count} action${count === 1 ? '' : 's'}:`,
    ...lines.map((line) => `• ${line}`),
    '',
    'React ✅ or 👍 to approve, ❌ or 👎 to reject.',
  ].join('\n');
}

/**
 * Holds every gated action of one matched rule behind a single review message.
 *
 * `held` is `[{ action, contexts }]` -- the actions and the variable sets they
 * would each have run with. Returns the stored row, or null when there was
 * nothing to hold.
 */
export async function requestApproval(db, { rule, held, context }) {
  if (!held.length) return null;

  // Any of the gated actions can name the reviewer; they are normally the same
  // person, and asking two people to approve one message would be worse.
  const reviewer = held.map((entry) => entry.action.approval_recipient?.trim()).find(Boolean);
  if (!reviewer) {
    throw new Error(`rule "${rule.name}" requires approval but no reviewer is set on the action`);
  }

  const summary = buildReviewMessage({ rule, held, context });

  const { timestamp } = await sendMessage(db, { recipient: reviewer, message: summary });
  if (!timestamp) {
    throw new Error(
      'signal-cli did not return a timestamp for the review message, so an approval reaction could not be matched to it'
    );
  }

  const payload = JSON.stringify({
    context,
    actions: held.map((entry) => ({ id: entry.action.id, contexts: entry.contexts })),
  });

  const info = db
    .prepare(
      `INSERT INTO pending_approvals
         (rule_id, rule_name, status, reviewer, review_timestamp, summary, payload)
       VALUES (@ruleId, @ruleName, 'pending', @reviewer, @timestamp, @summary, @payload)`
    )
    .run({
      ruleId: rule.id ?? null,
      ruleName: rule.name,
      reviewer,
      timestamp,
      summary,
      payload,
    });

  messageLogRepo.insert(db, {
    direction: 'outbound',
    recipient: reviewer,
    content: summary,
    status: 'sent',
  });

  return getById(db, Number(info.lastInsertRowid));
}

export function getById(db, id) {
  return db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(Number(id)) ?? null;
}

/**
 * The request a reaction is about. Signal identifies the reviewed message by
 * the timestamp it was sent with, which is what the reaction targets.
 */
export function findPendingByTimestamp(db, timestamp) {
  if (!timestamp) return null;
  return (
    db
      .prepare(
        `SELECT * FROM pending_approvals
         WHERE review_timestamp = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1`
      )
      .get(Number(timestamp)) ?? null
  );
}

/**
 * Records a decision and, when it is an approval, runs what was held.
 *
 * The actions are re-read from the database rather than taken from the stored
 * payload: an action edited between the request and the approval should run as
 * it stands now, while *what* it runs on stays exactly what was reviewed. An
 * action deleted in the meantime is skipped rather than fatal.
 */
export async function resolve(db, pending, decision, { decidedBy = null, emoji = null } = {}) {
  db.prepare(
    `UPDATE pending_approvals
     SET status = @status, decided_at = datetime('now'), decided_by = @by, decision_emoji = @emoji
     WHERE id = @id AND status = 'pending'`
  ).run({ id: pending.id, status: decision, by: decidedBy, emoji });

  const rule = { id: pending.rule_id, name: pending.rule_name };

  if (decision !== 'approved') {
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient: pending.reviewer,
      content: `Rejected by ${decidedBy ?? 'reviewer'}: ${pending.summary.split('\n')[0]}`,
      status: 'sent',
    });
    await notifyReviewer(db, pending, '❌ Rejected — nothing was created.');
    return { decision, ran: 0 };
  }

  const payload = JSON.parse(pending.payload);
  let ran = 0;
  // Ticket confirmations from every approved action land here instead of
  // going out one at a time, so approving a batch of certificates reads as
  // one Signal message rather than a burst of them.
  const replies = [];

  for (const entry of payload.actions ?? []) {
    const action = db.prepare('SELECT * FROM inbound_rule_actions WHERE id = ?').get(entry.id);
    if (!action) {
      console.error(`Approved action ${entry.id} no longer exists; skipping.`);
      continue;
    }
    // The gate has been passed; the flag is cleared so nothing downstream
    // reads this as still awaiting review.
    const approvedAction = { ...action, field_templates: parseJson(action.field_templates), require_approval: 0 };
    for (const templateContext of entry.contexts ?? []) {
      await runAction(db, { action: approvedAction, rule, context: payload.context, templateContext, replies });
      ran += 1;
    }
  }

  replies.push({ recipient: pending.reviewer, message: `✅ Approved — ${ran} action${ran === 1 ? '' : 's'} run.` });
  await flushReplies(db, replies);

  return { decision, ran };
}

function parseJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A decision that produced no visible outcome would look like a dropped message. */
async function notifyReviewer(db, pending, text) {
  try {
    await sendMessage(db, { recipient: pending.reviewer, message: text });
  } catch (err) {
    console.error('Could not confirm an approval decision to the reviewer:', err.message);
  }
}
