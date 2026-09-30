import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import * as inboundRulesRepo from '../inboundRules/inboundRules.repository.js';
import { normalizeEnvelope } from './inboundEnvelope.js';
import { evaluateRule, buildTemplateContext, naturalItems } from './inboundMatcher.js';
import { runAction, notifyFailure } from './inboundActionExecutor.js';
import { requestApproval, findPendingByTimestamp, resolve, decisionFor } from './approvals.js';
import { flushReplies } from './messageBatching.js';
import { toSendableGroupId, groupNameFor } from './signalGroups.js';
import { isReplayRequest, handleReplayCommand } from './replayCommand.js';

/**
 * Handles one inbound Signal envelope, from either transport.
 *
 * Order matters: deduplicate, then filter by subscription, then log, then
 * match rules. Logging after the subscription check keeps the message log
 * about conversations the bot was actually asked to watch instead of every
 * group the bot's number happens to be a member of.
 */
export async function handleInboundMessage(db, envelope) {
  const normalized = normalizeEnvelope(envelope);

  if (normalized.isSync) return; // our own message echoed from another device

  const settings = db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();

  // Never act on our own messages, however they reach us -- a rule that
  // replies to a pattern its own reply contains would otherwise loop.
  if (settings?.bot_number && normalized.senderNumber === settings.bot_number) return;

  // A reaction carries no message body, so it has to be answered before the
  // "nothing to read" check below drops it: reacting to a review request is
  // how a held action gets approved.
  if (normalized.reaction) {
    if (isDuplicate(db, normalized)) return;
    return decideApproval(db, settings, normalized);
  }

  if (!normalized.messageText) return; // receipts, typing indicators

  if (isDuplicate(db, normalized)) return;

  // `/process` replays a message the pipeline never saw, so it is answered
  // before the subscription check for the same reason an approval reaction is:
  // the operator's direct message need not be a subscribed conversation, and
  // requiring `allow_direct_messages` to be on would make the recovery path
  // depend on a setting unrelated to it. The approval-recipient allowlist is
  // the authorization, and it gates the branch rather than just the handler --
  // so an ordinary message containing a `/process` line still goes to rules.
  if (isReplayRequest(db, normalized)) {
    return handleReplayCommand(db, settings, normalized, { runRules });
  }

  if (!isSubscribed(db, settings, normalized)) return;

  // Resolve the group once: the envelope carries the internal id, everything
  // downstream (replies, reactions, rule scoping) needs the sendable one.
  const sendableGroupId = normalized.groupId ? await toSendableGroupId(db, normalized.groupId) : null;
  const context = {
    ...normalized,
    groupId: sendableGroupId,
    envelopeGroupId: normalized.groupId,
    groupName: groupNameFor(db, normalized.groupId),
  };

  messageLogRepo.insert(db, {
    direction: 'inbound',
    sender: normalized.senderNumber ?? normalized.senderUuid ?? 'unknown',
    recipient: sendableGroupId ?? settings?.bot_number ?? null,
    content: normalized.messageText,
    status: 'received',
    rawPayload: envelope,
  });

  await runRules(db, context);
}

/**
 * Rules are ordered by priority (highest first). Each matching rule runs all
 * of its actions in order; `stop_processing` (on by default) then ends the
 * pass, so a catch-all rule at priority 0 can act as a fallback without
 * firing for messages a specific rule already handled.
 *
 * Returns a report of what happened -- which rules matched, why the others did
 * not, and how each action ended. The live pipeline ignores it; `/process`
 * sends it back to the operator who asked for the replay, which is the whole
 * difference between "the bot said nothing" and knowing that a rule is scoped
 * to another group or that OpenProject rejected a field.
 */
export async function runRules(db, context) {
  const rules = inboundRulesRepo.listEnabledWithActions(db);
  const isGroup = Boolean(context.groupId);
  const report = { matched: [], skipped: [], actions: [], held: [] };

  for (const rule of rules) {
    let matched;
    try {
      const verdict = evaluateRule(rule, {
        messageText: context.messageText,
        isGroup,
        groupId: context.groupId,
      });
      matched = verdict.result;
      if (!matched) report.skipped.push({ rule: rule.name, reason: verdict.reason });
    } catch (err) {
      // A pattern that no longer compiles (e.g. written before validation
      // existed) must not stop the rules after it from running.
      console.error(`Inbound rule ${rule.id} (${rule.name}) has an invalid pattern:`, err.message);
      report.skipped.push({ rule: rule.name, reason: `has an invalid pattern: ${err.message}` });
      continue;
    }
    if (!matched) continue;
    report.matched.push(rule.name);

    const templateContext = buildTemplateContext(context, matched);
    const held = [];
    // Ticket confirmations from a fanned-out create_ticket action collect
    // here instead of going out one at a time, so filing several certificates
    // from one message reads as one Signal reply rather than a burst of them.
    const replies = [];

    for (const action of rule.actions) {
      // A replay has no original Signal message to react to -- (author, sent
      // timestamp) named a message this bot never received, and reacting to
      // the operator's own `/process` instead would be meaningless. The
      // ticket and the reply, which is the point of replaying, still run.
      if (context.isReplay && action.action_type === 'react') continue;

      // One action can run several times: a natural-language match fans a
      // message out into one work package per certificate requested.
      const contexts = contextsFor(action, matched, templateContext);

      // An action awaiting review runs later, if a human says so. The ones
      // beside it still run now -- acknowledging the message with a reaction
      // needs no approval, and leaving the sender in silence while a reviewer
      // sleeps would be worse than either.
      if (action.require_approval) {
        held.push({ action, contexts });
        continue;
      }

      for (const itemContext of contexts) {
        await runAction(db, { action, rule, context, templateContext: itemContext, replies, outcomes: report.actions });
      }
    }

    await flushReplies(db, replies);
    const asked = await holdForReview(db, { rule, held, context });
    if (asked) {
      report.held.push({
        rule: rule.name,
        recipient: asked.recipient,
        count: held.reduce((total, entry) => total + entry.contexts.length, 0),
      });
    }

    if (rule.stop_processing) break;
  }

  return report;
}

/**
 * Sends one review request covering every gated action of a rule -- a rule
 * whose ticket action fans out into four work packages asks once, not four
 * times.
 *
 * A request that cannot be sent must not fail silently: nothing was created
 * and nobody was asked, so it is logged and pushed to the failure recipient
 * like any other breakage.
 */
async function holdForReview(db, { rule, held, context }) {
  if (!held.length) return null;
  try {
    await requestApproval(db, { rule, held, context });
    return { recipient: held[0].action.approval_recipient ?? null };
  } catch (err) {
    console.error(`Inbound rule "${rule.name}" could not request approval:`, err.message);
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient: context.groupId ?? context.senderNumber ?? null,
      content: `Rule "${rule.name}" — could not ask for approval, so nothing ran`,
      status: 'failed',
      errorMessage: err.message,
    });
    await notifyFailure(db, { action: held[0].action, rule, context, error: err });
    return null;
  }
}

/**
 * Turns a reviewer's reaction into a decision on the request it targets.
 *
 * Signal has no message id, so the reaction names the reviewed message by its
 * author and sent timestamp -- and a stored `review_timestamp` matching that
 * pair *is* the authorization: the bot only holds work against a reviewer it
 * was configured to ask.
 */
export async function decideApproval(db, settings, normalized) {
  const { reaction } = normalized;
  if (reaction.isRemove) return; // taking a reaction back is not a decision

  const decision = decisionFor(reaction.emoji);
  if (!decision) return;

  // The reviewed message is one the bot sent, so anything else is a reaction
  // to ordinary chat that happens to use the same emoji.
  if (reaction.targetAuthor && settings?.bot_number && reaction.targetAuthor !== settings.bot_number) return;

  const pending = findPendingByTimestamp(db, reaction.targetTimestamp);
  if (!pending) return;

  await resolve(db, pending, decision, {
    decidedBy: normalized.senderNumber ?? normalized.senderUuid ?? null,
    emoji: reaction.emoji,
  });
}

/**
 * How many times one action runs for one matched message.
 *
 * A natural-language match can hold several certificates for several people,
 * and each of those is its own work package -- so `create_ticket` runs once per
 * parsed item, with that item's variables. Nothing else fans out: reacting or
 * replying four times to one message is noise, so those run once against the
 * message-wide context, where `{summary}` describes the whole request.
 */
export function contextsFor(action, matched, templateContext) {
  if (action.action_type !== 'create_ticket' || !matched.parsed) return [templateContext];
  const items = naturalItems(matched.parsed, action.fan_out ?? 'pair');
  return items.length ? items.map((item) => ({ ...templateContext, ...item })) : [templateContext];
}

/**
 * (author, sent timestamp) is Signal's own message identity, so it is what
 * a websocket reconnect or a redelivered webhook would repeat.
 * Returns true when this envelope has been seen before.
 */
export function isDuplicate(db, normalized) {
  const sourceKey = normalized.senderUuid ?? normalized.senderNumber ?? 'unknown';
  try {
    db.prepare('INSERT INTO inbound_events (source_key, signal_timestamp) VALUES (?, ?)').run(
      sourceKey,
      Number(normalized.timestamp)
    );
    return false;
  } catch {
    return true; // UNIQUE(source_key, signal_timestamp) violated
  }
}

/**
 * A message is processed only if it comes from somewhere the admin
 * subscribed to: an enabled group subscription, or a direct message while
 * direct messages are allowed.
 */
export function isSubscribed(db, settings, normalized) {
  if (normalized.groupId) {
    if (settings?.subscribe_all_groups) return true;
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM signal_group_subscriptions
         WHERE (internal_id = @id OR group_id = @id) AND enabled = 1 LIMIT 1`
      )
      .get({ id: normalized.groupId });
    return Boolean(row);
  }
  return Boolean(settings?.allow_direct_messages);
}
