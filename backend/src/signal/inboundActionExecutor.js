import {
  createWorkPackage,
  fetchTypeSchema,
  findAllowedValue,
  hasClosedList,
} from '../openproject/openprojectClient.js';
import { sendMessage, sendReaction } from './signalSender.js';
import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import * as contactsRepo from '../contacts/contacts.repository.js';
import { renderTemplate } from './inboundMatcher.js';
import { targetAuthorOf } from './inboundEnvelope.js';

/**
 * Runs one action, and makes sure a failure reaches a human rather than only
 * the dashboard nobody is watching at 23:00.
 *
 * Every failure already writes a `message_log` row; `failure_recipient` adds a
 * Signal message with the reason. A failure here never propagates: the
 * remaining actions of the rule still run, because a reply that could not be
 * sent should not lose the ticket that was already filed.
 *
 * `outcomes` is an optional collector, in the same spirit as `replies`: a
 * caller that has to *report* what happened -- `/process`, which answers the
 * operator who ran it -- passes one and gets a row per action, success or
 * failure. Nobody else needs it, and the swallowed-error behaviour above is
 * exactly why a caller cannot simply read the return value.
 */
export async function runAction(db, { action, rule, context, templateContext, replies, outcomes }) {
  try {
    const created = await executeAction(db, { action, rule, context, templateContext, replies });
    outcomes?.push({
      type: action.action_type,
      ok: true,
      workPackageId: created?.id ?? null,
      subject: created?.subject ?? null,
      url: created?.url ?? null,
    });
    return created;
  } catch (err) {
    outcomes?.push({ type: action.action_type, ok: false, error: err.message });
    console.error(`Inbound rule "${rule.name}" action ${action.action_type} failed:`, err.message);
    // Actions that got far enough to know what they were sending log their own
    // row with that detail. Anything that failed earlier -- a ticket action
    // with no project configured, say -- would otherwise be invisible in the
    // dashboard, which is exactly where someone goes to ask why a rule did
    // nothing.
    if (!err.logged) {
      messageLogRepo.insert(db, {
        direction: 'outbound',
        recipient: context?.groupId ?? context?.senderNumber ?? null,
        content: `Rule "${rule.name}" — ${action.action_type} action could not run`,
        status: 'failed',
        errorMessage: err.message,
      });
    }
    await notifyFailure(db, { action, rule, context, error: err });
    return null;
  }
}

/**
 * Tells `failure_recipient` what broke, with enough of the original message to
 * act on it. Muted contacts are honoured here as everywhere else, and a notice
 * that cannot itself be delivered is logged rather than thrown -- the failure
 * it was reporting is already recorded.
 */
export async function notifyFailure(db, { action, rule, context, error }) {
  const recipient = action?.failure_recipient?.trim();
  if (!recipient) return;

  const where = context?.groupName || context?.groupId || 'a direct message';
  const who = context?.senderName || context?.senderNumber || context?.senderUuid || 'unknown';
  const message = [
    `⚠️ **${rule?.name ?? 'Inbound rule'}** — ${action.action_type} failed`,
    error.message,
    '',
    `From ${who} in ${where}:`,
    context?.messageText ?? '',
  ].join('\n');

  if (contactsRepo.isRecipientMuted(db, recipient)) {
    messageLogRepo.insert(db, { direction: 'outbound', recipient, content: message, status: 'muted' });
    return;
  }

  try {
    await sendMessage(db, { recipient, message });
    messageLogRepo.insert(db, { direction: 'outbound', recipient, content: message, status: 'sent' });
  } catch (err) {
    console.error('Could not deliver a failure notice:', err.message);
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient,
      content: message,
      status: 'failed',
      errorMessage: err.message,
    });
  }
}

/**
 * Runs one action of a matched inbound rule.
 *
 * Every action gets the same `templateContext`, so a rule can react, file a
 * ticket and reply using the same capture groups from its parser.
 */
export async function executeAction(db, { action, rule, context, templateContext, replies }) {
  switch (action.action_type) {
    case 'react':
      return reactToMessage(db, { action, context });
    case 'create_ticket':
      return createTicket(db, { action, rule, context, templateContext, replies });
    case 'send_message':
      return replyWithMessage(db, { action, rule, context, templateContext });
    default:
      throw new Error(`unknown inbound action type: ${action.action_type}`);
  }
}

/**
 * Where a reply/reaction goes. A group message is answered in the group,
 * so everyone who saw the request sees the outcome.
 */
export function resolveReplyRecipient(db, action, context) {
  const conversation = context.groupId ?? context.senderNumber ?? context.senderUuid ?? null;

  switch (action.reply_target) {
    case 'sender':
      return context.senderNumber ?? context.senderUuid ?? null;
    case 'contact': {
      if (!action.reply_contact_id) throw new Error('action targets a contact but none is selected');
      const contact = contactsRepo.getById(db, action.reply_contact_id);
      if (!contact) throw new Error(`contact #${action.reply_contact_id} no longer exists`);
      return contact.signal_identifier;
    }
    case 'raw':
      if (!action.reply_raw) throw new Error('action targets a raw recipient but none is set');
      return action.reply_raw;
    case 'source':
    default:
      return conversation;
  }
}

/**
 * Where a created ticket's confirmation reply goes -- `source` (the group or
 * DM the request came from, the long-standing default) or `reviewer` (the
 * same number `approval_recipient` sends the review request to). There is no
 * separate "reviewer" address to fall back to, so validation at save time
 * (`inboundRules.controller.js`) requires `approval_recipient` to be set
 * before a rule can pick `reviewer` here.
 */
export function resolveConfirmRecipient(action, context) {
  if (action.confirm_target === 'reviewer') {
    return action.approval_recipient || null;
  }
  return context.groupId ?? context.senderNumber ?? context.senderUuid ?? null;
}

async function reactToMessage(db, { action, context }) {
  const emoji = action.emoji?.trim();
  if (!emoji) throw new Error('reaction action has no emoji configured');

  // A reaction always belongs to the conversation the message was in --
  // reacting "to a group message" in a DM is not a thing Signal can express.
  const recipient = context.groupId ?? context.senderNumber ?? context.senderUuid;
  await sendReaction(db, {
    recipient,
    targetAuthor: targetAuthorOf(context),
    timestamp: context.timestamp,
    emoji,
  });
}

async function replyWithMessage(db, { action, rule, context, templateContext }) {
  const message = renderTemplate(action.message_template, templateContext).trim();
  if (!message) return; // template rendered to nothing -- sending an empty message would fail

  const recipient = resolveReplyRecipient(db, action, context);
  if (!recipient) throw new Error('could not determine a recipient for the reply');

  if (contactsRepo.isRecipientMuted(db, recipient)) {
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient,
      content: message,
      status: 'muted',
    });
    return;
  }

  try {
    await sendMessage(db, { recipient, message });
    messageLogRepo.insert(db, { direction: 'outbound', recipient, content: message, status: 'sent' });
  } catch (err) {
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient,
      content: message,
      status: 'failed',
      errorMessage: err.message,
    });
    err.logged = true;
    throw err;
  }
}

/**
 * One entry of `field_templates`, in either form it can be stored in.
 *
 * The original shape was a bare template string; the object form adds where
 * the value comes from and what to use when it does not fit the field's list.
 * `source` is `value` (an id chosen from the dropdown), `template`,
 * `sender_contact` (the answer a human recorded against whoever sent the
 * message), or `field_match` (route by another field's resolved value --
 * "assignee depends on 🌀Тип довідки"). `field_match` carries its own shape
 * (`matchField` + `rules`, `fallback` doubling as "otherwise") rather than
 * `template`, which is why it is normalized separately -- every other source
 * keeps exactly the three keys it always had, so a mapping that never uses
 * routing round-trips through this function unchanged.
 */
export function normalizeFieldMapping(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const source = entry.source ?? 'template';
    if (source === 'field_match') {
      return {
        template: '',
        source,
        fallback: String(entry.fallback ?? ''),
        matchField: String(entry.matchField ?? ''),
        rules: normalizeMatchRules(entry.rules),
      };
    }
    return {
      template: String(entry.template ?? ''),
      source,
      fallback: String(entry.fallback ?? ''),
    };
  }
  return { template: String(entry), source: 'template', fallback: '' };
}

/** `field_match` rule rows, dropping anything with no usable values/value. */
function normalizeMatchRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => ({
      values: Array.isArray(rule?.values)
        ? rule.values.map((v) => String(v ?? '')).filter((v) => v.trim())
        : [],
      value: String(rule?.value ?? ''),
    }))
    .filter((rule) => rule.values.length > 0 && rule.value.trim() !== '');
}

/** Does this action read any field off the sender's contact record? */
export function usesSenderContact(action) {
  return Object.values(action?.field_templates ?? {}).some(
    (entry) => normalizeFieldMapping(entry)?.source === 'sender_contact'
  );
}

/**
 * Renders every field this action supplies, and reports the ones that had to
 * fall back.
 *
 * Returns `{ fields, unmatched }`. A field whose schema gives a closed list is
 * checked against that list *before* posting: a rule that renders "Форма 5"
 * into a list without that option, or wants a value from a contact nobody has
 * classified yet, uses the mapping's `fallback` option instead of failing with
 * an opaque 422. What was actually asked for comes back in `unmatched`, and
 * the caller writes it into the description -- which is what makes falling
 * back to an option named "Інше (Вкажу в описі)" honest rather than lossy.
 */
export function buildTicketFields(action, templateContext, schema = null, { contactValues = null } = {}) {
  const fields = {};
  const unmatched = [];

  const subject =
    renderTemplate(action.subject_template, templateContext).trim() ||
    templateContext.rest ||
    templateContext.first_line ||
    'New ticket from Signal';
  fields.subject = subject.slice(0, 255);

  const body = action.description_template
    ? renderTemplate(action.description_template, templateContext).trim()
    : templateContext.message;
  fields.description = body;

  const byKey = new Map((schema?.fields ?? []).map((field) => [field.key, field]));

  // `field_match` entries are resolved in a second pass, after every other
  // field has its final value in `fields` -- routing "assignee by 🌀Тип
  // довідки" has to read that field's *resolved* value (an id chosen from a
  // dropdown, or a label rendered from `{form}` and possibly already
  // substituted by its own fallback), not re-derive it. A `field_match`
  // entry that points at another `field_match` entry is not supported: the
  // second pass does not order itself by dependency, only by insertion order.
  const entries = Object.entries(action.field_templates ?? {});
  const directEntries = entries.filter(([, entry]) => normalizeFieldMapping(entry)?.source !== 'field_match');
  const matchEntries = entries.filter(([, entry]) => normalizeFieldMapping(entry)?.source === 'field_match');

  for (const [key, entry] of directEntries) {
    const mapping = normalizeFieldMapping(entry);
    const field = byKey.get(key);

    let value;
    let requested;
    if (mapping.source === 'sender_contact') {
      value = contactValues?.[key] ?? '';
      requested = templateContext.sender || 'unknown sender';
    } else {
      // A link-typed field normally holds an id chosen from a dropdown, which
      // must reach OpenProject untouched -- but a natural-language rule points
      // one at `{form}`, and an allowed value matches by label just as happily
      // as by id. So a link template is rendered only when it contains a
      // variable, leaving the dropdown case exactly as it was.
      const literalLink = field?.location === '_links' && !/\{\w+\}/.test(mapping.template);
      value = literalLink ? mapping.template : renderTemplate(mapping.template, templateContext);
      requested = String(value ?? '').trim();
    }

    value = String(value ?? '').trim();

    if (field && hasClosedList(field) && !findAllowedValue(field, value) && mapping.fallback) {
      unmatched.push({ key, name: field.name, source: mapping.source, requested });
      value = mapping.fallback;
    }

    if (value !== '') fields[key] = value;
  }

  for (const [key, entry] of matchEntries) {
    const mapping = normalizeFieldMapping(entry);
    const field = byKey.get(key);
    const matchFieldDef = byKey.get(mapping.matchField);

    // Both sides compare by the matched field's canonical option id when it
    // has a closed list, so "Тип довідки == Форма 5" matches regardless of
    // whether that field ended up holding the id (chosen from a dropdown) or
    // the label (rendered from `{form}`). With no schema entry for it (or no
    // closed list), the values are compared as trimmed, case-insensitive text.
    const canonicalOf = (raw) => {
      const trimmed = String(raw ?? '').trim();
      if (!trimmed) return '';
      const option = matchFieldDef ? findAllowedValue(matchFieldDef, trimmed) : null;
      return option ? `id:${option.id}` : trimmed.toLowerCase();
    };

    const actualRaw = String(fields[mapping.matchField] ?? '').trim();
    const actualKey = canonicalOf(actualRaw);
    const rule = actualKey ? mapping.rules.find((r) => r.values.some((v) => canonicalOf(v) === actualKey)) : null;

    let value = String((rule ? rule.value : mapping.fallback) ?? '').trim();

    // Same "only note it when a fallback actually caught it" rule as the
    // closed-list check below: a rule with no default configured is meant to
    // leave the field unset, quietly, not narrate every message that landed
    // in no bucket.
    if (!rule && mapping.fallback) {
      unmatched.push({
        key,
        name: field?.name ?? key,
        source: mapping.source,
        requested: actualRaw
          ? `${matchFieldDef?.name ?? mapping.matchField} = "${actualRaw}"`
          : `${matchFieldDef?.name ?? mapping.matchField} not set`,
      });
    }

    if (field && hasClosedList(field) && value && !findAllowedValue(field, value) && mapping.fallback) {
      unmatched.push({ key, name: field.name, source: mapping.source, requested: value });
      value = mapping.fallback;
    }

    if (value !== '') fields[key] = value;
  }

  return { fields, unmatched };
}

/**
 * `startDate`/`dueDate` for a `duration_days` action, in the plain
 * 'YYYY-MM-DD' shape OpenProject's Date fields want. `dueDate` is
 * `durationDays` *calendar* days after `startDate` -- OpenProject's own
 * working-days calendar is not consulted, since that would need a second API
 * round trip per ticket; a rule that needs that can still template `dueDate`
 * by hand instead of setting a duration. Pure -- see
 * test/inboundActionExecutor.test.js.
 */
export function computeDurationDates(durationDays, now = new Date()) {
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days <= 0) return null;

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const due = new Date(start);
  due.setUTCDate(due.getUTCDate() + days);

  const toIsoDate = (date) => date.toISOString().slice(0, 10);
  return { startDate: toIsoDate(start), dueDate: toIsoDate(due) };
}

/** What the fallback option promised would be in the description. */
export function describeUnmatched(unmatched) {
  if (!unmatched.length) return '';
  return [
    '**Not matched to a list value:**',
    ...unmatched.map((entry) => `- ${entry.name}: ${entry.requested || 'not determined'}`),
  ].join('\n');
}

/**
 * The contact behind the message, looked up by Signal number.
 *
 * Only created when the action actually reads a field off it: a bridge that
 * added a contact for everyone who ever spoke in the group would bury the
 * people someone has to classify among hundreds who need nothing.
 */
export function senderContact(db, action, context) {
  const identifier = context?.senderNumber ?? context?.senderUuid ?? null;
  if (!identifier) return null;

  const existing = contactsRepo.getBySignalIdentifier(db, identifier);
  if (existing || !usesSenderContact(action)) return existing ?? null;

  return contactsRepo.createFromSignal(db, { identifier, name: context.senderName });
}

/**
 * `contacts.field_values` reaches us as an object from the repository, but a
 * row read straight from SQLite is still the JSON string it was stored as.
 * Either way a malformed blob must not lose the ticket.
 */
function parseFieldValues(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Kept for the message-log line and the confirmation reply. */
function describeSubject(fields, created) {
  return created?.subject || fields.subject || 'work package';
}

/** What the requester (or reviewer) is told once the ticket exists. */
function buildTicketConfirmation(fields, created) {
  return `🎫 **#${created.id}** ${describeSubject(fields, created)}\n${created.url}`;
}

/**
 * Required, writable, no default, and nothing supplied. `hasDefault` matters:
 * status and priority are required but OpenProject fills them in, so demanding
 * them from every rule would be wrong.
 */
export function missingRequiredFields(schema, fields) {
  return (schema?.fields ?? []).filter(
    (field) =>
      field.required &&
      field.writable &&
      !field.hasDefault &&
      String(fields[field.key] ?? '').trim() === ''
  );
}

// A busy group would otherwise refetch the form schema on every message.
const schemaCache = new Map();
const SCHEMA_TTL_MS = 5 * 60 * 1000;

async function getSchema(db, opSettings, projectId, typeId) {
  const key = `${opSettings.base_url}|${projectId}|${typeId}`;
  const hit = schemaCache.get(key);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.schema;

  const schema = await fetchTypeSchema(opSettings.base_url, opSettings.api_key, projectId, typeId);
  schemaCache.set(key, { schema, at: Date.now() });
  return schema;
}

export function resetSchemaCache() {
  schemaCache.clear();
}

/**
 * Provenance footer so the ticket says where it came from -- appended after
 * the rendered body (not prepended above it) so a description_template that
 * is its own rich HTML layout, with its own header row, renders exactly as
 * written, with this as a trailer rather than something glued on top of it.
 */
export function buildDescription(body, context) {
  const who = context.senderName
    ? `${context.senderName} (${context.senderNumber ?? context.senderUuid ?? 'unknown'})`
    : context.senderNumber ?? context.senderUuid ?? 'unknown';
  const where = context.groupId
    ? `Signal group ${context.groupName ? `"${context.groupName}"` : `\`${context.groupId}\``}`
    : 'Direct Signal message';
  const when = new Date(context.timestamp ?? Date.now()).toISOString();

  const lines = [`**Reported by:** ${who}`, `**Source:** ${where}`, `**Received:** ${when}`];
  // A replayed message was attributed to its author by hand, and the ticket
  // should say so -- "reported by" is otherwise a claim about a Signal message
  // this bot never actually received.
  if (context.isReplay) {
    lines.push(`**Replayed by:** ${context.replayedBy ?? 'unknown'} (message forwarded with /process)`);
  }

  return `${body}\n\n---\n\n${lines.join('\n')}`;
}

async function createTicket(db, { action, rule, context, templateContext, replies }) {
  const opSettings = db.prepare('SELECT * FROM openproject_settings WHERE id = 1').get();
  const sigSettings = db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();

  if (!opSettings?.base_url || !opSettings?.api_key) {
    throw new Error('OpenProject connection is not configured (Settings -> OpenProject)');
  }

  const projectId = action.project_id || sigSettings?.default_project_id;
  if (!projectId) {
    throw new Error(
      'no OpenProject project set for this action and no default project configured (Settings -> Signal)'
    );
  }
  const typeId = action.type_id || sigSettings?.default_type_id || undefined;

  // The schema drives which fields are sent and how they are encoded, so it
  // is fetched before the templates are rendered. It is cached per
  // (project, type) because a busy group would otherwise re-fetch it per
  // message.
  const schema = typeId
    ? await getSchema(db, opSettings, projectId, typeId)
    : { fields: [] };

  // Fields the rule reads off the sender rather than the message. The contact
  // is created on the spot when this sender has never been seen, so the person
  // who has to classify them has a row to classify.
  const contact = senderContact(db, action, context);

  // `{base_url}` lets a description_template build its own links back into
  // this OpenProject install (an admin/edit link, a search tool hosted next
  // to it, ...) without hard-coding the instance's address into every rule.
  const opContext = {
    ...templateContext,
    base_url: String(opSettings.base_url ?? '').trim().replace(/\/+$/, ''),
  };

  const { fields, unmatched } = buildTicketFields(action, opContext, schema, {
    contactValues: parseFieldValues(contact?.field_values),
  });

  // Falling back to an option named "Інше (Вкажу в описі)" is only honest if
  // the description then says what was actually asked for.
  const note = describeUnmatched(unmatched);
  const body = [fields.description, note].filter(Boolean).join('\n\n');
  // A rule whose template is its own rich HTML layout (its own header row,
  // its own "who/where" cells) usually doesn't want the plain-text provenance
  // block glued onto it too.
  fields.description = action.include_provenance ? buildDescription(body, context) : body;
  if (action.priority_id) fields.priority = action.priority_id;

  // A duration only fills a date field_templates left empty -- a rule that
  // still wants to template startDate or dueDate by hand is not overridden.
  if (action.duration_days) {
    const dates = computeDurationDates(action.duration_days);
    if (dates) {
      if (!fields.startDate) fields.startDate = dates.startDate;
      if (!fields.dueDate) fields.dueDate = dates.dueDate;
    }
  }

  // A value nobody has recorded for this contact is a question for a human,
  // and the contacts screen is where it gets asked.
  if (contact && unmatched.some((entry) => entry.source === 'sender_contact')) {
    contactsRepo.markNeedsClassification(db, contact.id);
  }

  // File the ticket as the sender when we know who they are in OpenProject,
  // so it isn't attributed to the bot's API user. `context.authorUserId` is
  // set only by a `/process` replay, where the author was named by hand and
  // may be an OpenProject user with no contact row for `senderContact` to
  // find -- see signal/replayCommand.js.
  const authorId = context.authorUserId ?? contact?.openproject_user_id ?? undefined;

  try {
    // Named up front rather than as an opaque 422 from the POST -- the whole
    // point is that the dashboard says which field the rule is missing.
    const missing = missingRequiredFields(schema, fields);
    if (missing.length) {
      throw new Error(
        `OpenProject type requires ${missing.map((f) => `"${f.name}" (${f.key})`).join(', ')}` +
          ' — set them on this rule\'s Create ticket action'
      );
    }

    const created = await createWorkPackage(opSettings.base_url, opSettings.api_key, {
      projectId,
      typeId,
      fields,
      schema,
      authorId,
    });

    messageLogRepo.insert(db, {
      direction: 'outbound',
      workPackageId: created.id,
      recipient: context.groupId ?? context.senderNumber ?? null,
      content: `Created work package #${created.id}: "${describeSubject(fields, created)}"`,
      status: 'sent',
    });

    if (sigSettings?.auto_reply_enabled) {
      const recipient = resolveConfirmRecipient(action, context);
      if (recipient) {
        const message = buildTicketConfirmation(fields, created);
        // A collector means the caller is grouping several of these (a
        // fanned-out batch, or a set of just-approved tickets) into as few
        // Signal messages as fit -- see messageBatching.js. Without one,
        // e.g. a direct call outside that flow, send it on its own.
        if (replies) {
          replies.push({ recipient, message });
        } else {
          await sendMessage(db, { recipient, message }).catch((err) =>
            console.error('Ticket confirmation reply failed:', err.message)
          );
        }
      }
    }
    return created;
  } catch (err) {
    messageLogRepo.insert(db, {
      direction: 'outbound',
      recipient: context.groupId ?? context.senderNumber ?? null,
      content: `Work package creation failed for: "${describeSubject(fields, null)}"`,
      status: 'failed',
      errorMessage: err.message,
    });
    err.logged = true;
    throw err;
  }
}
