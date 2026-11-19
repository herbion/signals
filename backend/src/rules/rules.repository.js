const VALID_OPERATORS = new Set([
  'equals',
  'not_equals',
  'any_change',
  'changed_to',
  'changed_from',
  'changed_from_to',
  'is_empty',
  'is_not_empty',
  'event_type_created',
]);

/** Throws with a descriptive message if the tree doesn't match the ConditionGroup/ConditionRule shape. */
export function validateConditionTree(node, path = 'root') {
  if (!node || typeof node !== 'object') throw new Error(`${path}: condition node must be an object`);

  if (node.type === 'group') {
    if (node.operator !== 'AND' && node.operator !== 'OR') {
      throw new Error(`${path}: group operator must be AND or OR`);
    }
    if (!Array.isArray(node.children)) throw new Error(`${path}: group children must be an array`);
    node.children.forEach((child, i) => validateConditionTree(child, `${path}.children[${i}]`));
    return;
  }

  if (node.type === 'condition') {
    if (!VALID_OPERATORS.has(node.operator)) throw new Error(`${path}: unknown operator "${node.operator}"`);
    if (node.operator !== 'event_type_created' && !node.field) {
      throw new Error(`${path}: condition requires a field`);
    }
    if (node.operator === 'changed_from_to' && node.fromValue === undefined) {
      throw new Error(`${path}: changed_from_to requires fromValue`);
    }
    return;
  }

  throw new Error(`${path}: type must be "group" or "condition"`);
}

function rowToRule(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    conditionTree: JSON.parse(row.condition_tree),
    allowed_contact_ids: parseContactIds(row.allowed_contact_ids),
  };
}

export function listAll(db) {
  return db.prepare('SELECT * FROM rules ORDER BY priority DESC, id ASC').all().map(rowToRule);
}

export function listEnabled(db) {
  return db.prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority DESC, id ASC').all().map(rowToRule);
}

export function getById(db, id) {
  return rowToRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
}

export function create(db, rule) {
  validateConditionTree(rule.conditionTree);
  const info = db
    .prepare(
      `INSERT INTO rules
         (name, enabled, project_scope, condition_tree, action_recipient_mode,
          action_recipient_contact_id, action_recipient_raw, action_recipient_dynamic_relation,
          message_template, comment_template, allowed_contact_ids, batch_window_seconds, priority)
       VALUES (@name, @enabled, @projectScope, @conditionTree, @recipientMode,
               @contactId, @recipientRaw, @dynamicRelation, @messageTemplate, @commentTemplate, @allowedContactIds, @batchWindowSeconds, @priority)`
    )
    .run({
      name: rule.name,
      enabled: rule.enabled ? 1 : 0,
      projectScope: rule.projectScope ?? null,
      conditionTree: JSON.stringify(rule.conditionTree),
      recipientMode: rule.actionRecipientMode ?? 'contact',
      contactId: rule.actionRecipientContactId ?? null,
      recipientRaw: rule.actionRecipientRaw ?? null,
      dynamicRelation: rule.actionRecipientDynamicRelation ?? null,
      messageTemplate: rule.messageTemplate,
      commentTemplate: blankToNull(rule.commentTemplate),
      allowedContactIds: serializeContactIds(rule.allowedContactIds),
      batchWindowSeconds: normalizeWindow(rule.batchWindowSeconds),
      priority: rule.priority ?? 0,
    });
  return getById(db, info.lastInsertRowid);
}

export function update(db, id, rule) {
  validateConditionTree(rule.conditionTree);
  db.prepare(
    `UPDATE rules SET
       name = @name,
       enabled = @enabled,
       project_scope = @projectScope,
       condition_tree = @conditionTree,
       action_recipient_mode = @recipientMode,
       action_recipient_contact_id = @contactId,
       action_recipient_raw = @recipientRaw,
       action_recipient_dynamic_relation = @dynamicRelation,
       message_template = @messageTemplate,
       comment_template = @commentTemplate,
       allowed_contact_ids = @allowedContactIds,
       batch_window_seconds = @batchWindowSeconds,
       priority = @priority,
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    name: rule.name,
    enabled: rule.enabled ? 1 : 0,
    projectScope: rule.projectScope ?? null,
    conditionTree: JSON.stringify(rule.conditionTree),
    recipientMode: rule.actionRecipientMode ?? 'contact',
    contactId: rule.actionRecipientContactId ?? null,
    recipientRaw: rule.actionRecipientRaw ?? null,
    dynamicRelation: rule.actionRecipientDynamicRelation ?? null,
    messageTemplate: rule.messageTemplate,
    commentTemplate: blankToNull(rule.commentTemplate),
      allowedContactIds: serializeContactIds(rule.allowedContactIds),
      batchWindowSeconds: normalizeWindow(rule.batchWindowSeconds),
    priority: rule.priority ?? 0,
  });
  return getById(db, id);
}

/**
 * `allowed_contact_ids` is a JSON array of contact ids; NULL or [] means the
 * rule may message anyone. A malformed blob reads as "no limit" -- it can only
 * have been written by hand, and failing every send of the rule over it would
 * be harder to notice than the limit being off.
 */
export function parseContactIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeContactIds(parsed) : [];
  } catch {
    return [];
  }
}

function serializeContactIds(ids) {
  const normalized = normalizeContactIds(ids ?? []);
  return normalized.length ? JSON.stringify(normalized) : null;
}

function normalizeContactIds(ids) {
  return [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

/** Seconds, or null for "use the global grouping window". 0 / blank / junk all mean null. */
function normalizeWindow(value) {
  const seconds = Number(value);
  return value != null && value !== '' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

function blankToNull(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value);
}

export function remove(db, id) {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
}
