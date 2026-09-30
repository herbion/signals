/**
 * `/process` -- running a message through the inbound pipeline after the fact.
 *
 * Inbound delivery is live-only. signal-cli-rest-api hands an envelope to
 * whatever websocket client is attached at that instant and keeps nothing for
 * one that reconnects a minute later, and Signal itself has no server-side
 * history to re-fetch and no message id to ask with. So a message that arrives
 * while this app is restarting is simply gone from the pipeline, and the only
 * copy left anywhere is the one in the operator's own Signal client.
 *
 * Hence: forward it to the bot with a `/process` line, and it runs through
 * exactly the pipeline it missed.
 *
 *     ~Forwarded message
 *     /process Петренко Олег
 *     молодший сержант Іванов Іван Іванович потрібно довідка ф12 ...
 *
 * The command names the *original sender*, because that is the one thing a
 * forward destroys: a Signal forward arrives as a fresh message from whoever
 * forwarded it. The sender is not cosmetic here -- it picks the OpenProject
 * author, the 👤Замовник value read off the contact record, and the mute
 * check. So a replay is built as a synthetic envelope with the sender
 * swapped, and every stage downstream behaves as though that person had sent
 * it; nothing in the matcher, the parser or the executor needs to know a
 * replay is happening.
 */
import * as contactsRepo from '../contacts/contacts.repository.js';
import * as subscriptionsRepo from './subscriptions.repository.js';
import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import { fetchUsers } from '../openproject/openprojectClient.js';
import { userDisplayName } from '../contacts/contactsSync.js';
import { groupNameFor } from './signalGroups.js';
import { sendMessage } from './signalSender.js';

/** `/trigger` is accepted too -- it is what this was called while being designed. */
const COMMANDS = ['/process', '/trigger'];

export function isReplayCommand(text) {
  return parseReplayCommand(text) !== null;
}

/**
 * Whether this envelope should be handled as a replay at all.
 *
 * Authorization is part of the *gate*, not just of the handler, and
 * deliberately so: an ordinary message that happens to carry a line starting
 * with `/process` must fall through to normal rule processing rather than be
 * swallowed as a command somebody was not allowed to run.
 */
export function isReplayRequest(db, normalized) {
  if (!isReplayCommand(normalized?.messageText)) return false;
  return isAuthorized(db, normalized.senderNumber ?? normalized.senderUuid ?? null);
}

/**
 * Splits a `/process` message into the author it names and the body to replay.
 *
 * The command is deliberately not required to be the first line. Signal's own
 * "Forwarded message" marker, a quoted header, or whatever else the client
 * pastes above the text all land ahead of it -- so everything before the
 * command line is treated as chrome and everything after it is the message
 * being replayed. Returns null when there is no command line at all.
 * Pure -- see test/replayCommand.test.js.
 */
export function parseReplayCommand(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const index = lines.findIndex(isCommandLine);
  if (index === -1) return null;

  const rest = lines[index].trim().replace(/^\S+\s*/, '');
  return {
    author: rest.trim(),
    body: lines.slice(index + 1).join('\n').trim(),
  };
}

function isCommandLine(line) {
  const [word] = line.trim().split(/\s+/);
  return COMMANDS.includes((word ?? '').toLowerCase());
}

/**
 * Who may replay a message.
 *
 * The approval recipients, rather than a second allowlist of their own:
 * `/process` files work packages in another person's name, which is the same
 * trust an approval reaction already carries, and two half-maintained lists is
 * how one of them ends up wrong.
 */
export function replayers(db) {
  return db
    .prepare(
      `SELECT DISTINCT approval_recipient AS recipient FROM inbound_rule_actions
       WHERE approval_recipient IS NOT NULL AND TRIM(approval_recipient) <> ''`
    )
    .all()
    .map((row) => String(row.recipient).trim());
}

/** Compares numbers however they were written -- `+380 99 ...` vs `38099...`. */
export function sameNumber(a, b) {
  const digits = (value) => String(value ?? '').replace(/[\s()\-.+]/g, '');
  const left = digits(a);
  return Boolean(left) && left === digits(b);
}

export function isAuthorized(db, senderNumber) {
  if (!senderNumber) return false;
  return replayers(db).some((recipient) => sameNumber(recipient, senderNumber));
}

const normalizeName = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Picks the one record a typed name means.
 *
 * These names are typed on a phone, in Ukrainian, often as a surname alone, so
 * an exact match is the exception rather than the rule. Exact wins outright
 * when it is there; failing that a substring match in either direction, so
 * "Петренко" finds "Петренко Олег Іванович" and the full ПІБ finds a contact
 * stored as just the surname. An ambiguous result is an error naming the
 * candidates rather than a guess -- attributing a request to the wrong person
 * is the one failure this command must not have.
 * Pure -- see test/replayCommand.test.js.
 */
export function matchByName(candidates, query) {
  const wanted = normalizeName(query);
  if (!wanted) return { match: null, candidates: [] };

  const exact = candidates.filter((entry) => normalizeName(entry.name) === wanted);
  if (exact.length) return { match: exact.length === 1 ? exact[0] : null, candidates: exact };

  const partial = candidates.filter((entry) => {
    const name = normalizeName(entry.name);
    return Boolean(name) && (name.includes(wanted) || wanted.includes(name));
  });
  return { match: partial.length === 1 ? partial[0] : null, candidates: partial };
}

/**
 * The person a replayed message should be attributed to.
 *
 * Contacts first, since a match there carries both halves of an identity: the
 * Signal number (so mute and any `sender_contact` field values apply) and the
 * `openproject_user_id` the work package needs as its author. Contact sync
 * skips OpenProject users with no phone recorded, though, so the contacts
 * table is only a subset of the people a ticket can be attributed to -- and a
 * replay never needs to *message* the author, only to name them. So an
 * unmatched name falls through to the OpenProject user list before giving up.
 *
 * Throws with a readable reason; the caller sends that back to the operator.
 */
export async function resolveAuthor(db, name) {
  const fromContacts = matchByName(contactsRepo.listAll(db), name);
  if (fromContacts.match) {
    const contact = fromContacts.match;
    return {
      senderNumber: contact.signal_identifier ?? null,
      senderName: contact.name,
      openprojectUserId: contact.openproject_user_id ?? null,
      source: 'contact',
    };
  }
  if (fromContacts.candidates.length > 1) {
    throw new Error(
      `"${name}" matches several contacts: ${fromContacts.candidates.map((c) => c.name).join(', ')}. ` +
        'Write more of the name.'
    );
  }

  const fromOpenProject = await matchOpenProjectUser(db, name);
  if (fromOpenProject.match) {
    const user = fromOpenProject.match;
    return {
      // Known in OpenProject but not as a contact, so there is no Signal
      // identity to carry -- the ticket still gets the right author, and a
      // `sender_contact` field falls back exactly as it does for an
      // unclassified sender.
      senderNumber: null,
      senderName: user.name,
      openprojectUserId: user.id,
      source: 'openproject',
    };
  }
  if (fromOpenProject.candidates.length > 1) {
    throw new Error(
      `"${name}" matches several OpenProject users: ${fromOpenProject.candidates.map((u) => u.name).join(', ')}. ` +
        'Write more of the name.'
    );
  }

  throw new Error(
    `no contact or OpenProject user matches "${name}" — check the spelling, ` +
      'or leave the name out to file it as yourself'
  );
}

/**
 * The OpenProject user list, matched by display name. An install with no
 * OpenProject connection configured, or one that cannot be reached right now,
 * yields no candidates rather than failing the replay -- the contacts table
 * had its chance first and this is the fallback.
 */
async function matchOpenProjectUser(db, name) {
  const settings = db.prepare('SELECT base_url, api_key FROM openproject_settings WHERE id = 1').get();
  if (!settings?.base_url || !settings?.api_key) return { match: null, candidates: [] };

  try {
    const users = await fetchUsers(settings.base_url, settings.api_key);
    return matchByName(
      users.map((user) => ({ id: user.id, name: userDisplayName(user) })),
      name
    );
  } catch (err) {
    console.error('Could not read OpenProject users while resolving a replay author:', err.message);
    return { match: null, candidates: [] };
  }
}

/**
 * The operator themselves, for a `/process` with no author written.
 *
 * Omitting the name is a deliberate "this one is mine / it does not matter",
 * unlike a name that does not resolve -- which is almost always a typo and is
 * reported instead of quietly landing here.
 */
export function forwarderAsAuthor(db, normalized) {
  const identifier = normalized.senderNumber ?? normalized.senderUuid ?? null;
  const contact = identifier ? contactsRepo.getBySignalIdentifier(db, identifier) : null;
  return {
    senderNumber: normalized.senderNumber ?? null,
    senderName: contact?.name ?? normalized.senderName ?? null,
    openprojectUserId: contact?.openproject_user_id ?? null,
    source: 'forwarder',
  };
}

/**
 * Which conversation a replayed message should look like it came from.
 *
 * `/process` is usually a direct message, so it carries no group of its own --
 * and inbound rules are routinely scoped to one (`source_scope` /
 * `source_group_id`), meaning a replay with no group would match nothing and
 * look like the command had been ignored. In order: the subscribed group the
 * command was sent in, the configured group, then -- with neither -- a single
 * enabled subscription, which is unambiguous and covers the ordinary
 * one-help-desk-group install with no setup at all.
 */
export function replayGroupId(db, settings, commandGroupId = null) {
  const enabled = subscriptionsRepo.listSubscriptions(db).filter((subscription) => subscription.enabled);

  // Run in a subscribed group, the command means *this* conversation -- the
  // operator is standing in it. The envelope carries the internal id, so match
  // on either and hand back the sendable one. An unsubscribed group is ignored
  // rather than used: it would silently replace a perfectly good configured
  // group with one no rule is scoped to.
  const here = commandGroupId
    ? enabled.find((sub) => sub.group_id === commandGroupId || sub.internal_id === commandGroupId)
    : null;
  if (here) return here.group_id;

  const configured = settings?.default_replay_group_id?.trim();
  if (configured) return configured;

  return enabled.length === 1 ? enabled[0].group_id : null;
}

/**
 * Builds the envelope the pipeline will see. Everything the rest of the
 * inbound path reads comes from here, which is why no stage downstream needs a
 * replay-specific branch.
 */
export function buildReplayContext(db, settings, normalized, { author, body }) {
  const groupId = replayGroupId(db, settings, normalized.groupId ?? null);
  return {
    ...normalized,
    // The one flag downstream honours: there is no original Signal message to
    // react to, so a `react` action is skipped rather than failed.
    isReplay: true,
    messageText: body,
    senderNumber: author.senderNumber,
    senderUuid: null,
    senderName: author.senderName,
    // Carried explicitly because an author resolved from OpenProject alone has
    // no contact row for `senderContact` to find.
    authorUserId: author.openprojectUserId ?? null,
    groupId,
    envelopeGroupId: null,
    groupName: groupId ? groupNameFor(db, groupId) : '',
    // The original send time is unknowable -- it was never delivered here --
    // so the replay is stamped with when the text actually entered the
    // pipeline, which is the honest answer and keeps `{date}` sane.
    timestamp: normalized.timestamp,
    replayedBy: normalized.senderNumber ?? normalized.senderUuid ?? null,
  };
}

/** An answer to the operator, so the command never looks swallowed. */
async function reply(db, recipient, message) {
  if (!recipient) return;
  try {
    await sendMessage(db, { recipient, message });
    messageLogRepo.insert(db, { direction: 'outbound', recipient, content: message, status: 'sent' });
  } catch (err) {
    console.error('Could not answer a /process command:', err.message);
  }
}

function describeAuthor(author) {
  const who = author.senderName || author.senderNumber || 'unknown';
  if (author.source === 'forwarder') return `${who} (you)`;
  if (author.source === 'openproject') return `${who} (OpenProject user, no Signal contact)`;
  return who;
}

/** How the operator is told to write the command, in one place. */
export const USAGE = [
  'Send it like this:',
  '',
  '/process Петренко Олег',
  'сержант Іванов Іван Іванович потрібно ф5',
  '',
  'The name on the command line is whoever *sent* the original message — leave it out to file it as yourself.',
  'Everything on the lines below is the message to replay. `/trigger` works too.',
].join('\n');

/** Enough of an error to act on, without a wall of text in a Signal message. */
function short(text, limit = 220) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * What the replay actually did, written for the person who ran it.
 *
 * This is the half that was missing, and the reason `/process` felt broken:
 * the command acknowledged itself and then went quiet whatever happened next,
 * so a rule scoped to another group, a message the parser did not recognise
 * and a work package OpenProject rejected all looked identical from the
 * outside -- and every one of them is a different thing to go and fix. Failures
 * were reported only to a rule's `failure_recipient`, which is nobody by
 * default. Pure -- see test/replayCommand.test.js.
 */
export function formatReplayReport(report, { groupId } = {}) {
  const lines = [];

  for (const name of report.matched ?? []) lines.push(`✅ Matched rule "${name}"`);

  for (const outcome of report.actions ?? []) {
    if (!outcome.ok) {
      lines.push(`⚠️ ${outcome.type} failed: ${short(outcome.error)}`);
    } else if (outcome.type === 'create_ticket' && outcome.workPackageId) {
      lines.push(`🎫 #${outcome.workPackageId} ${short(outcome.subject ?? '', 80)}`.trim());
    } else if (outcome.type === 'send_message') {
      lines.push('💬 Reply sent');
    }
  }

  for (const hold of report.held ?? []) {
    const who = hold.recipient ? ` — waiting for ${hold.recipient}` : '';
    lines.push(`⏳ ${hold.count} ticket(s) held for review${who}`);
  }

  if (!(report.matched ?? []).length) {
    lines.push('🤷 No inbound rule matched this message, so nothing was filed.');
    // Why each rule passed on it: this is the actionable part. Capped, because
    // an install with twenty rules would otherwise bury the answer.
    for (const skipped of (report.skipped ?? []).slice(0, 6)) {
      lines.push(`• "${skipped.rule}" ${short(skipped.reason, 160)}`);
    }
    const more = (report.skipped ?? []).length - 6;
    if (more > 0) lines.push(`• …and ${more} more rule(s)`);
    if (!(report.skipped ?? []).length) lines.push('• There are no enabled inbound rules.');
    if (!groupId) {
      lines.push(
        'ℹ️ This replay ran with no group. Set Settings → Inbound Messages → "Group for replayed messages", ' +
          'or run /process in the group itself, so group-scoped rules can match.'
      );
    }
  }

  return lines.join('\n');
}

/**
 * Runs one `/process` command.
 *
 * `runRules` is injected rather than imported so this module does not have to
 * import the handler that imports it.
 */
export async function handleReplayCommand(db, settings, normalized, { runRules }) {
  const operator = normalized.senderNumber ?? normalized.senderUuid ?? null;

  // `isReplayRequest` is the real gate; this is defence in depth, so a future
  // caller cannot reach the pipeline-with-a-forged-author path by accident.
  if (!isAuthorized(db, operator)) {
    console.warn(`Ignoring /process from a sender who is not an approval recipient: ${operator}`);
    return;
  }

  const { author: authorName, body } = parseReplayCommand(normalized.messageText);

  if (!body) {
    await reply(db, operator, `⚠️ Nothing to process — no message under the /process line.\n\n${USAGE}`);
    return;
  }

  let author;
  try {
    author = authorName ? await resolveAuthor(db, authorName) : forwarderAsAuthor(db, normalized);
  } catch (err) {
    await reply(db, operator, `⚠️ ${err.message}`);
    return;
  }

  const context = buildReplayContext(db, settings, normalized, { author, body });

  // Logged as inbound, like any other message the rules ran on, so the replay
  // shows up in the dashboard where someone will look for it.
  messageLogRepo.insert(db, {
    direction: 'inbound',
    sender: author.senderNumber ?? author.senderName ?? 'unknown',
    recipient: context.groupId ?? settings?.bot_number ?? null,
    content: body,
    status: 'received',
    rawPayload: { replayedBy: operator, author, originalEnvelope: normalized.rawEnvelope },
  });

  // Sent before the work starts, not instead of the outcome below: filing a
  // request in someone else's name is worth confirming *before* it happens,
  // while a ticket action can take seconds of OpenProject round trips.
  await reply(
    db,
    operator,
    [
      `♻️ Replaying as **${describeAuthor(author)}**`,
      context.groupId ? `in ${context.groupName || context.groupId}…` : 'with no group…',
    ].join(' ')
  );

  let report;
  try {
    report = await runRules(db, context);
  } catch (err) {
    // runRules absorbs per-action failures itself, so reaching here means
    // something structural broke -- which the operator still has to hear about.
    console.error('A /process replay failed:', err);
    await reply(db, operator, `⚠️ The replay itself failed: ${short(err.message)}`);
    return;
  }

  await reply(db, operator, formatReplayReport(report ?? {}, { groupId: context.groupId }));
}
