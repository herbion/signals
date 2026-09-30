import express from 'express';
import { getDb } from '../db/connection.js';
import * as repo from './inboundRules.repository.js';
import {
  compilePattern,
  matchRule,
  buildTemplateContext,
  renderTemplate,
  naturalItems,
} from '../signal/inboundMatcher.js';
import { personLabel } from '../signal/naturalParser.js';

export const inboundRulesRouter = express.Router();

const MATCH_TYPES = new Set(['regex', 'contains', 'any', 'natural']);
const SOURCE_SCOPES = new Set(['any', 'group', 'direct']);
const ACTION_TYPES = new Set(['react', 'create_ticket', 'send_message']);
const FAN_OUT_MODES = new Set(['pair', 'person', 'message']);
const CONFIRM_TARGETS = new Set(['source', 'reviewer']);
// Match types that carry no pattern: 'any' takes every message, 'natural'
// decides by parsing it.
const PATTERNLESS = new Set(['any', 'natural']);

/**
 * Validates a rule before it can be stored. A regex that doesn't compile used
 * to be accepted happily and then throw on every single inbound message, with
 * nothing in the UI to say why the rule never fired -- so it is rejected here
 * instead.
 */
export function validateRule(rule) {
  const errors = [];
  if (!rule?.name?.trim()) errors.push('name is required');

  const matchType = rule?.matchType ?? rule?.match_type ?? 'regex';
  if (!MATCH_TYPES.has(matchType)) errors.push(`match type must be one of: ${[...MATCH_TYPES].join(', ')}`);

  const scope = rule?.sourceScope ?? rule?.source_scope ?? 'any';
  if (!SOURCE_SCOPES.has(scope)) errors.push(`source scope must be one of: ${[...SOURCE_SCOPES].join(', ')}`);

  // Group ids arrive as a list of strings; anything else is a client bug worth
  // reporting rather than silently dropping, since the result would be a rule
  // listening to every group instead of the two it was given.
  const groupIds = rule?.sourceGroupIds ?? rule?.source_group_ids;
  if (groupIds !== undefined && groupIds !== null) {
    if (!Array.isArray(groupIds)) errors.push('groups must be a list of group ids');
    else if (groupIds.some((id) => typeof id !== 'string' || !id.trim())) {
      errors.push('every group id must be a non-empty string');
    }
  }

  if (!PATTERNLESS.has(matchType) && !String(rule?.pattern ?? '').trim()) {
    errors.push('a pattern is required unless the match type is "any message" or "certificate request"');
  }
  if (matchType === 'regex' && String(rule?.pattern ?? '').trim()) {
    try {
      compilePattern(rule.pattern, rule.patternFlags ?? rule.pattern_flags ?? 'i');
    } catch (err) {
      errors.push(`invalid regular expression: ${err.message}`);
    }
  }

  const actions = rule?.actions ?? [];
  if (actions.length === 0) errors.push('a rule needs at least one action');
  actions.forEach((action, index) => {
    const type = action.actionType ?? action.action_type;
    const label = `action ${index + 1}`;
    if (!ACTION_TYPES.has(type)) {
      errors.push(`${label}: unknown type "${type}"`);
      return;
    }
    if (type === 'react' && !String(action.emoji ?? '').trim()) {
      errors.push(`${label}: an emoji is required`);
    }
    if (type === 'send_message' && !String(action.messageTemplate ?? action.message_template ?? '').trim()) {
      errors.push(`${label}: a message template is required`);
    }
    const fanOut = action.fanOut ?? action.fan_out ?? 'pair';
    if (!FAN_OUT_MODES.has(fanOut)) {
      errors.push(`${label}: fan-out must be one of: ${[...FAN_OUT_MODES].join(', ')}`);
    }
    // An action held for review with nowhere to send the review request would
    // never run and never say why, so it is rejected at save time.
    const requireApproval = action.requireApproval ?? action.require_approval;
    const approvalRecipient = action.approvalRecipient ?? action.approval_recipient;
    if (requireApproval && !String(approvalRecipient ?? '').trim()) {
      errors.push(`${label}: enter a number to send the review request to`);
    }

    // 'reviewer' has nowhere to go except the same number the review request
    // itself is sent to -- there is no separate reviewer field to fall back to.
    const confirmTarget = action.confirmTarget ?? action.confirm_target ?? 'source';
    if (!CONFIRM_TARGETS.has(confirmTarget)) {
      errors.push(`${label}: confirm target must be one of: ${[...CONFIRM_TARGETS].join(', ')}`);
    } else if (confirmTarget === 'reviewer' && !String(approvalRecipient ?? '').trim()) {
      errors.push(`${label}: confirming to the reviewer needs a review recipient set below`);
    }

    if (type === 'create_ticket') {
      const durationDays = action.durationDays ?? action.duration_days;
      if (durationDays !== undefined && durationDays !== null && durationDays !== '') {
        const n = Number(durationDays);
        if (!Number.isInteger(n) || n <= 0) {
          errors.push(`${label}: days to complete must be a positive whole number`);
        }
      }

      // A "choose by another field's value" mapping with nothing to route on
      // is silently a no-op at ticket time -- catch that at save time instead,
      // the same way an unreachable "hold for review" action already is above.
      const fieldTemplates = action.fieldTemplates ?? action.field_templates ?? {};
      for (const [key, mapping] of Object.entries(fieldTemplates)) {
        if (!mapping || typeof mapping !== 'object' || mapping.source !== 'field_match') continue;
        if (!String(mapping.matchField ?? '').trim()) {
          errors.push(`${label}: "${key}" needs a field to match on`);
        }
        const rules = Array.isArray(mapping.rules) ? mapping.rules : [];
        const hasUsableRule = rules.some(
          (r) => Array.isArray(r?.values) && r.values.some((v) => String(v ?? '').trim()) && String(r?.value ?? '').trim()
        );
        if (!hasUsableRule && !String(mapping.fallback ?? '').trim()) {
          errors.push(`${label}: "${key}" has no rules and no default value, so it would never be set`);
        }
      }
    }

    const target = action.replyTarget ?? action.reply_target ?? 'source';
    if (type === 'send_message') {
      if (target === 'contact' && !(action.replyContactId ?? action.reply_contact_id)) {
        errors.push(`${label}: pick a contact to send to`);
      }
      if (target === 'raw' && !String(action.replyRaw ?? action.reply_raw ?? '').trim()) {
        errors.push(`${label}: enter a number or group id to send to`);
      }
    }
  });

  return errors;
}

inboundRulesRouter.get('/', (req, res) => {
  res.json(repo.listAll(getDb()));
});

/**
 * Dry-runs a pattern against sample text so the rule editor can show what
 * matched and what each capture group would put into the action templates,
 * without needing a real Signal message to experiment with.
 */
inboundRulesRouter.post('/test', (req, res) => {
  const { pattern, patternFlags, matchType, sampleText, sourceScope, isGroup, templates, fanOut } =
    req.body ?? {};
  const rule = {
    match_type: matchType ?? 'regex',
    pattern,
    pattern_flags: patternFlags ?? 'i',
    source_scope: sourceScope ?? 'any',
    // The dry-run is about the parser, so the sample message is treated as
    // coming from whichever group the rule listens to -- narrowing it here
    // would only ever report "wrong group" for text the admin just typed.
    source_group_ids: null,
  };

  let matched;
  try {
    matched = matchRule(rule, {
      messageText: sampleText ?? '',
      isGroup: Boolean(isGroup),
      groupId: isGroup ? 'group.sample' : null,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!matched) return res.json({ matched: false });

  const context = buildTemplateContext(
    {
      messageText: sampleText ?? '',
      senderName: 'Sample Sender',
      senderNumber: '+10000000000',
      groupName: isGroup ? 'Sample Group' : '',
      groupId: isGroup ? 'group.sample' : null,
      timestamp: Date.now(),
    },
    matched
  );

  const render = (variables) =>
    Object.fromEntries(
      Object.entries(templates ?? {}).map(([key, template]) => [key, renderTemplate(template, variables)])
    );

  res.json({
    matched: true,
    match: matched.match,
    groups: matched.groups,
    variables: context,
    rendered: render(context),
    // A natural-language match is worth showing as the structure it found, not
    // as one capture group: who, which certificates, and how many work packages
    // that adds up to under the chosen fan-out.
    parsed: matched.parsed ? summarizeParsed(matched.parsed) : null,
    items: matched.parsed
      ? naturalItems(matched.parsed, fanOut ?? 'pair').map((item) => ({
          variables: item,
          rendered: render({ ...context, ...item }),
        }))
      : null,
  });
});

/** The parse result trimmed to what the rule editor shows. */
function summarizeParsed(parsed) {
  return {
    requests: parsed.requests.map((request) => ({
      person: request.person.full,
      label: personLabel(request.person),
      rank: request.person.rank,
      note: request.person.note,
      purpose: request.person.purpose ?? parsed.purpose,
      personalNumber: request.person.personalNumber,
      forms: request.forms.map((form) => form.label),
    })),
    forms: [...new Set(parsed.forms.map((form) => form.label))],
    people: parsed.people.map((person) => person.full),
    purpose: parsed.purpose,
    warnings: parsed.warnings,
  };
}

inboundRulesRouter.get('/:id', (req, res) => {
  const rule = repo.getById(getDb(), req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  res.json(rule);
});

inboundRulesRouter.post('/', (req, res) => {
  const errors = validateRule(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    res.status(201).json(repo.create(getDb(), req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

inboundRulesRouter.put('/:id', (req, res) => {
  const errors = validateRule(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const rule = repo.update(getDb(), req.params.id, req.body);
    if (!rule) return res.status(404).json({ error: 'Not found' });
    res.json(rule);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

inboundRulesRouter.delete('/:id', (req, res) => {
  repo.remove(getDb(), req.params.id);
  res.status(204).end();
});
