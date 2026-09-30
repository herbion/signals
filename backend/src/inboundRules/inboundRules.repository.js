const RULE_COLUMNS = `id, name, enabled, priority, source_scope, source_group_ids,
                      match_type, pattern, pattern_flags, stop_processing,
                      created_at, updated_at`;

function rowToRule(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    stop_processing: Boolean(row.stop_processing),
    // Handed out parsed, like `field_templates`: every reader wants the list,
    // and a malformed blob should read as "not narrowed to any group" rather
    // than break the rules list.
    source_group_ids: parseGroupIds(row.source_group_ids),
  };
}

/** Stored as a JSON array of sendable group ids; anything else is no filter. */
export function parseGroupIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Blank list -> NULL, so "any group" is one value in the column, not two. */
function serializeGroupIds(value) {
  const list = Array.isArray(value) ? value : parseGroupIds(value);
  const ids = [...new Set(list.map((id) => String(id ?? '').trim()).filter(Boolean))];
  return ids.length ? JSON.stringify(ids) : null;
}

function actionsFor(db, ruleId) {
  return db
    .prepare('SELECT * FROM inbound_rule_actions WHERE rule_id = ? ORDER BY position ASC, id ASC')
    .all(ruleId)
    .map((row) => ({
      ...row,
      field_templates: parseFieldTemplates(row.field_templates),
      require_approval: Boolean(row.require_approval),
      include_provenance: Boolean(row.include_provenance),
    }));
}

/** Stored as JSON; a malformed blob must not break loading every rule. */
export function parseFieldTemplates(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function withActions(db, rule) {
  return rule ? { ...rule, actions: actionsFor(db, rule.id) } : null;
}

export function listAll(db) {
  const rules = db
    .prepare(`SELECT ${RULE_COLUMNS} FROM inbound_rules ORDER BY priority DESC, id ASC`)
    .all()
    .map(rowToRule);
  return rules.map((rule) => withActions(db, rule));
}

/** What the message pipeline consumes: enabled rules, highest priority first. */
export function listEnabledWithActions(db) {
  const rules = db
    .prepare(`SELECT ${RULE_COLUMNS} FROM inbound_rules WHERE enabled = 1 ORDER BY priority DESC, id ASC`)
    .all()
    .map(rowToRule);
  return rules.map((rule) => withActions(db, rule));
}

export function getById(db, id) {
  const rule = rowToRule(db.prepare(`SELECT ${RULE_COLUMNS} FROM inbound_rules WHERE id = ?`).get(Number(id)));
  return withActions(db, rule);
}

function replaceActions(db, ruleId, actions) {
  db.prepare('DELETE FROM inbound_rule_actions WHERE rule_id = ?').run(ruleId);
  const insert = db.prepare(
    `INSERT INTO inbound_rule_actions
       (rule_id, position, action_type, emoji, project_id, type_id, priority_id,
        subject_template, description_template, message_template,
        reply_target, reply_contact_id, reply_raw, field_templates, fan_out,
        require_approval, approval_recipient, failure_recipient, confirm_target,
        include_provenance, duration_days)
     VALUES (@ruleId, @position, @actionType, @emoji, @projectId, @typeId, @priorityId,
             @subjectTemplate, @descriptionTemplate, @messageTemplate,
             @replyTarget, @replyContactId, @replyRaw, @fieldTemplates, @fanOut,
             @requireApproval, @approvalRecipient, @failureRecipient, @confirmTarget,
             @includeProvenance, @durationDays)`
  );
  (actions ?? []).forEach((action, index) => {
    insert.run({
      ruleId,
      position: action.position ?? index,
      actionType: action.actionType ?? action.action_type,
      emoji: blankToNull(action.emoji),
      projectId: blankToNull(action.projectId ?? action.project_id),
      typeId: blankToNull(action.typeId ?? action.type_id),
      priorityId: blankToNull(action.priorityId ?? action.priority_id),
      subjectTemplate: blankToNull(action.subjectTemplate ?? action.subject_template),
      descriptionTemplate: blankToNull(action.descriptionTemplate ?? action.description_template),
      messageTemplate: blankToNull(action.messageTemplate ?? action.message_template),
      replyTarget: action.replyTarget ?? action.reply_target ?? 'source',
      replyContactId: numberOrNull(action.replyContactId ?? action.reply_contact_id),
      replyRaw: blankToNull(action.replyRaw ?? action.reply_raw),
      fieldTemplates: serializeFieldTemplates(action.fieldTemplates ?? action.field_templates),
      // Only a natural-language rule fans out; every other match type stores
      // the default and ignores it.
      fanOut: action.fanOut ?? action.fan_out ?? 'pair',
      requireApproval: (action.requireApproval ?? action.require_approval) ? 1 : 0,
      approvalRecipient: blankToNull(action.approvalRecipient ?? action.approval_recipient),
      failureRecipient: blankToNull(action.failureRecipient ?? action.failure_recipient),
      confirmTarget: (action.confirmTarget ?? action.confirm_target) || 'source',
      includeProvenance:
        (action.includeProvenance ?? action.include_provenance ?? true) ? 1 : 0,
      durationDays: numberOrNull(action.durationDays ?? action.duration_days),
    });
  });
}

/**
 * Drops blank entries so an untouched optional field isn't stored as "".
 *
 * An entry is either a bare template string or the object form
 * `{ source, template, fallback }`; an object saying nothing is as blank as an
 * empty string, and `String(object)` would never have caught it.
 */
function serializeFieldTemplates(value) {
  if (!value) return null;
  const source = typeof value === 'string' ? parseFieldTemplates(value) : value;
  const entries = Object.entries(source).filter(([, entry]) => !isBlankMapping(entry));
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
}

function isBlankMapping(entry) {
  if (entry === undefined || entry === null) return true;
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    // A contact-sourced field carries no template of its own and is still a
    // real mapping.
    if (entry.source === 'sender_contact') return false;
    if (entry.source === 'field_match') {
      const hasRule = Array.isArray(entry.rules) && entry.rules.some(hasUsableMatchRule);
      return !String(entry.matchField ?? '').trim() && !hasRule && !String(entry.fallback ?? '').trim();
    }
    return !String(entry.template ?? '').trim() && !String(entry.fallback ?? '').trim();
  }
  return String(entry).trim() === '';
}

function hasUsableMatchRule(rule) {
  return (
    Array.isArray(rule?.values) &&
    rule.values.some((v) => String(v ?? '').trim()) &&
    String(rule?.value ?? '').trim() !== ''
  );
}

// The UI submits "" for untouched optional selects; storing that instead of
// NULL would make `action.project_id || default` fall through inconsistently.
function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}

function ruleParams(rule) {
  const scope = rule.sourceScope ?? rule.source_scope ?? 'any';
  return {
    name: rule.name,
    enabled: rule.enabled ? 1 : 0,
    priority: Number(rule.priority ?? 0),
    sourceScope: scope,
    // A direct-only rule has no group half to narrow, so it never keeps a
    // list -- otherwise switching the scope back and forth silently restores
    // a filter the editor stopped showing.
    sourceGroupIds: scope === 'direct' ? null : serializeGroupIds(rule.sourceGroupIds ?? rule.source_group_ids),
    matchType: rule.matchType ?? rule.match_type ?? 'regex',
    pattern: blankToNull(rule.pattern),
    patternFlags: rule.patternFlags ?? rule.pattern_flags ?? 'i',
    stopProcessing: (rule.stopProcessing ?? rule.stop_processing ?? true) ? 1 : 0,
  };
}

export function create(db, rule) {
  const info = db
    .prepare(
      `INSERT INTO inbound_rules
         (name, enabled, priority, source_scope, source_group_ids, match_type,
          pattern, pattern_flags, stop_processing)
       VALUES (@name, @enabled, @priority, @sourceScope, @sourceGroupIds, @matchType,
               @pattern, @patternFlags, @stopProcessing)`
    )
    .run(ruleParams(rule));
  const id = Number(info.lastInsertRowid);
  replaceActions(db, id, rule.actions);
  return getById(db, id);
}

export function update(db, id, rule) {
  const ruleId = Number(id);
  if (!getById(db, ruleId)) return null;
  db.prepare(
    `UPDATE inbound_rules SET
       name = @name,
       enabled = @enabled,
       priority = @priority,
       source_scope = @sourceScope,
       source_group_ids = @sourceGroupIds,
       match_type = @matchType,
       pattern = @pattern,
       pattern_flags = @patternFlags,
       stop_processing = @stopProcessing,
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({ id: ruleId, ...ruleParams(rule) });
  replaceActions(db, ruleId, rule.actions);
  return getById(db, ruleId);
}

export function remove(db, id) {
  db.prepare('DELETE FROM inbound_rule_actions WHERE rule_id = ?').run(Number(id));
  db.prepare('DELETE FROM inbound_rules WHERE id = ?').run(Number(id));
}
