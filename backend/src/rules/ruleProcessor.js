import * as rulesRepo from './rules.repository.js';
import * as contactsRepo from '../contacts/contacts.repository.js';
import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import { evaluateConditionTree, buildEvaluationContext, ruleAlreadyMatched } from './ruleEvaluator.js';
import { buildTemplateContext, renderTemplate } from './templateRenderer.js';
import { sendMessage } from '../signal/signalSender.js';

/**
 * Runs every enabled rule against one processed webhook change event,
 * sending and logging a Signal message for each match. Send failures are
 * caught per-rule and recorded in message_log; they never propagate back to
 * the webhook HTTP response (already sent by the time this runs).
 */
export async function processChangeEvent(db, { snapshot, changeSet, eventType }) {
  const rules = rulesRepo.listEnabled(db);
  const context = buildEvaluationContext(changeSet, eventType);

  // Needed so {url} renders as an absolute link to the OpenProject page
  // rather than the payload's relative API href.
  const baseUrl = db.prepare('SELECT base_url FROM openproject_settings WHERE id = 1').get()?.base_url;
  const templateContext = buildTemplateContext(snapshot, changeSet, { baseUrl });

  const grouping = Boolean(db.prepare('SELECT grouping_enabled FROM signal_settings WHERE id = 1').get()?.grouping_enabled);

  for (const rule of rules) {
    if (!matchesProjectScope(rule, snapshot)) continue;
    if (!evaluateConditionTree(rule.conditionTree, context)) continue;

    // Rules are edge-triggered: notify when the work package *enters* the
    // matching state, not for every webhook it receives while sitting in it.
    // Without this, a rule like "type is X AND status is Y" re-sends on
    // every later attachment/description/assignee edit.
    if (ruleAlreadyMatched(rule.conditionTree, changeSet, eventType)) continue;

    const content = renderTemplate(rule.message_template, templateContext);

    let recipient;
    try {
      recipient = resolveRecipient(db, rule, snapshot);
    } catch (err) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient: null,
        content,
        status: 'failed',
        errorMessage: err.message,
      });
      continue;
    }

    // A muted contact is dropped here rather than at send time, so it never
    // enters the outbound queue. Logged (not silently discarded) so the
    // dashboard can answer "why didn't this person get notified?".
    if (contactsRepo.isRecipientMuted(db, recipient)) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'muted',
      });
      continue;
    }

    // With grouping on, the message is only queued here; outboundDispatcher
    // combines everything headed to this recipient inside the window into a
    // single Signal message so a bulk edit doesn't fire off a dozen pings.
    if (grouping) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'pending',
      });
      continue;
    }

    try {
      await sendMessage(db, { recipient, message: content });
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'sent',
      });
    } catch (err) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'failed',
        errorMessage: err.message,
      });
    }
  }
}

function matchesProjectScope(rule, snapshot) {
  if (!rule.project_scope) return true;
  const scope = String(rule.project_scope);
  return scope === String(snapshot.project?.id) || scope === snapshot.project?.name;
}

/**
 * Resolves a rule's recipient to a Signal number/group id, throwing a
 * message-log-friendly error when it can't. Three modes:
 *   'dynamic' -- the work package's author (or assignee) at send time,
 *                mapped to a contact via contacts.openproject_user_id
 *                (populated by the OpenProject contact sync).
 *   'contact' -- a fixed saved contact.
 *   'raw'     -- a literal number typed into the rule.
 * Modes other than 'dynamic' fall through contact -> raw, which is also what
 * rules created before the mode column existed rely on.
 */
export function resolveRecipient(db, rule, snapshot) {
  if (rule.action_recipient_mode === 'dynamic') {
    const relation = rule.action_recipient_dynamic_relation || 'author';
    const person = snapshot?.[relation];
    if (!person?.id) {
      throw new Error(`Work package has no ${relation} to notify`);
    }

    const contact = contactsRepo.getByOpenProjectUserId(db, person.id);
    if (!contact) {
      throw new Error(
        `No contact linked to OpenProject user ${person.name ?? person.id} (${relation}). ` +
          'Run Contacts → Sync from OpenProject, and check that user has a phone number set.'
      );
    }
    return contact.signal_identifier;
  }

  if (rule.action_recipient_contact_id) {
    const contact = contactsRepo.getById(db, rule.action_recipient_contact_id);
    if (contact) return contact.signal_identifier;
  }
  if (rule.action_recipient_raw) return rule.action_recipient_raw;

  throw new Error('Rule has no recipient configured (no contact and no raw recipient)');
}
