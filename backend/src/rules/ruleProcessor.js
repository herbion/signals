import * as rulesRepo from './rules.repository.js';
import * as contactsRepo from '../contacts/contacts.repository.js';
import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import { evaluateConditionTree, buildEvaluationContext, ruleAlreadyMatched } from './ruleEvaluator.js';
import { buildTemplateContext, renderTemplate } from './templateRenderer.js';
import { sendMessage } from '../signal/signalSender.js';
import { matchContactByName } from '../contacts/contactNameMatch.js';
import { postRuleComment } from './commentBack.js';

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

    let recipient;
    let recipientName = '';
    try {
      ({ identifier: recipient, name: recipientName } = resolveRecipientDetails(db, rule, snapshot));
    } catch (err) {
      const content = renderTemplate(rule.message_template, { ...templateContext, recipient_name: '' });
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

    // {recipient_name} is who the rule resolved to -- the contact a
    // "🎯На кого" name was matched to, say -- for the message and the comment.
    const ruleContext = { ...templateContext, recipient_name: recipientName ?? '' };
    const content = renderTemplate(rule.message_template, ruleContext);

    // A per-rule "only these contacts" limit, for trying a rule out on real
    // work packages without messaging real requesters. Checked after
    // resolution, so ambiguity and missing contacts still surface as errors.
    // Logged as 'muted' -- deliberately suppressed, nothing went wrong.
    const outsideLimit = recipientOutsideLimit(db, rule, recipient);
    if (outsideLimit) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'muted',
        errorMessage: outsideLimit,
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

    const comment = renderComment(rule, ruleContext);

    // With grouping on, the message is only queued here; outboundDispatcher
    // combines everything headed to this recipient inside the window into a
    // single Signal message so a bulk edit doesn't fire off a dozen pings.
    // A rule with its own batch window queues even with grouping off, and
    // carries that window onto the row. Its comment-back rides along too, to
    // be posted when the batch is really sent rather than now.
    const ruleWindow = ruleBatchWindow(rule);
    if (grouping || ruleWindow !== null) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        ruleId: rule.id,
        workPackageId: snapshot.id,
        recipient,
        content,
        status: 'pending',
        batchWindowSeconds: ruleWindow,
        pendingComment: comment,
      });
      continue;
    }

    let sent = false;
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
      sent = true;
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
    if (sent) await postRuleComment(db, { ruleId: rule.id, workPackageId: snapshot.id, comment });
  }
}

/** A reason string when the rule is limited to some contacts and this recipient is not one of them. */
function recipientOutsideLimit(db, rule, recipient) {
  const allowedIds = rule.allowed_contact_ids ?? [];
  if (!allowedIds.length) return null;
  const allowed = allowedIds.map((id) => contactsRepo.getById(db, id)).filter(Boolean);
  if (allowed.some((contact) => contact.signal_identifier === recipient)) return null;
  return (
    `Not sent: ${recipient} is not among this rule's allowed contacts ` +
    `(${allowed.map((c) => c.name).join(', ') || 'none of the listed contacts exist any more'})`
  );
}

function matchesProjectScope(rule, snapshot) {
  if (!rule.project_scope) return true;
  const scope = String(rule.project_scope);
  return scope === String(snapshot.project?.id) || scope === snapshot.project?.name;
}

/** The rule's comment-back, rendered; null when it has none. Posted via commentBack.js once the message is sent. */
function renderComment(rule, context) {
  if (!rule.comment_template || !String(rule.comment_template).trim()) return null;
  return renderTemplate(rule.comment_template, context);
}

/** The rule's own batching window in seconds, or null to follow the global grouping setting. */
function ruleBatchWindow(rule) {
  const seconds = Number(rule.batch_window_seconds);
  return rule.batch_window_seconds != null && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

const BUILT_IN_RELATIONS = new Set(['author', 'assignee']);
const CUSTOM_FIELD_KEY = /^customField\d+$/;

/** What `action_recipient_dynamic_relation` may hold. */
export function isDynamicRelation(value) {
  return BUILT_IN_RELATIONS.has(value) || CUSTOM_FIELD_KEY.test(String(value ?? ''));
}

/**
 * Resolves a rule's recipient to a Signal number/group id, throwing a
 * message-log-friendly error when it can't. Three modes:
 *   'dynamic' -- a person read off the work package at send time:
 *                - 'author' / 'assignee', or a User-typed custom field: an
 *                  OpenProject user, mapped to a contact via
 *                  contacts.openproject_user_id (contact sync fills it);
 *                - a text custom field ("🎯На кого" holds a ПІБ, not a user):
 *                  matched against contact names, strictly -- see
 *                  contacts/contactNameMatch.js.
 *   'contact' -- a fixed saved contact.
 *   'raw'     -- a literal number typed into the rule.
 * Modes other than 'dynamic' fall through contact -> raw, which is also what
 * rules created before the mode column existed rely on.
 */
export function resolveRecipient(db, rule, snapshot) {
  return resolveRecipientDetails(db, rule, snapshot).identifier;
}

/** `resolveRecipient`, plus the contact's name for the `{recipient_name}` variable. */
export function resolveRecipientDetails(db, rule, snapshot) {
  if (rule.action_recipient_mode === 'dynamic') {
    const relation = rule.action_recipient_dynamic_relation || 'author';
    const contact = CUSTOM_FIELD_KEY.test(relation)
      ? contactFromCustomField(db, relation, snapshot)
      : contactFromUser(db, relation, snapshot?.[relation]);
    return { identifier: contact.signal_identifier, name: contact.name };
  }

  if (rule.action_recipient_contact_id) {
    const contact = contactsRepo.getById(db, rule.action_recipient_contact_id);
    if (contact) return { identifier: contact.signal_identifier, name: contact.name };
  }
  if (rule.action_recipient_raw) return { identifier: rule.action_recipient_raw, name: rule.action_recipient_raw };

  throw new Error('Rule has no recipient configured (no contact and no raw recipient)');
}

function contactFromUser(db, label, person) {
  if (!person?.id) {
    throw new Error(`Work package has no ${label} to notify`);
  }
  const contact = contactsRepo.getByOpenProjectUserId(db, person.id);
  if (!contact) {
    throw new Error(
      `No contact linked to OpenProject user ${person.name ?? person.id} (${label}). ` +
        'Run Contacts → Sync from OpenProject, and check that user has a phone number set.'
    );
  }
  return contact;
}

function contactFromCustomField(db, key, snapshot) {
  const value = snapshot?.customFields?.[key];

  // `kind` comes from the link's href (payloadNormalizer). User ids and
  // option ids are separate, overlapping number spaces, so an option id must
  // never be looked up as a user: option 57 would find whoever is user 57.
  if (value && typeof value === 'object') {
    if (value.kind === 'user') return contactFromUser(db, key, value);
    return contactByClassification(db, key, value);
  }
  return contactByName(db, key, value);
}

/**
 * A list/hierarchy option ("👤Замовник" = "1МБ - Бік Андрій") reaches a
 * person through the contact classification: the contact whose
 * `field_values[key]` holds that option id (Contacts screen, the same values
 * inbound tickets read with `sender_contact`). Several different people
 * classified with one option is an error naming them, not a pick.
 */
function contactByClassification(db, key, value) {
  const label = value.name ? `"${value.name}"` : `option ${value.id}`;
  if (value.id == null || String(value.id).includes(',')) {
    throw new Error(`Cannot notify by ${key}: ${label} is not a single option`);
  }
  const people = new Map();
  for (const contact of contactsRepo.listAll(db)) {
    if (contact.type === 'group' || !contact.signal_identifier) continue;
    if (String(contact.field_values?.[key] ?? '') !== String(value.id)) continue;
    if (!people.has(contact.signal_identifier)) people.set(contact.signal_identifier, contact);
  }
  if (people.size === 1) return [...people.values()][0];
  if (people.size === 0) {
    throw new Error(
      `No contact is classified with ${key} = ${label} (option ${value.id}). ` +
        'Set it on the right contact in Contacts.'
    );
  }
  const names = [...people.values()].map((c) => `"${c.name}"`).join(', ');
  throw new Error(`${key} = ${label} is set on more than one contact (${names}) — not guessing`);
}

function contactByName(db, key, name) {
  if (name === null || name === undefined || String(name).trim() === '') {
    throw new Error(`Work package has no value in ${key} to find a recipient by`);
  }
  const { contact, error } = matchContactByName(contactsRepo.listAll(db), name);
  if (!contact) {
    throw new Error(
      `Cannot notify the person in ${key}: ${error}. ` +
        'Add or rename a contact so its name matches (e.g. "Іванов Іван").'
    );
  }
  return contact;
}
