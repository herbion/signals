/**
 * ConditionGroup = { type: 'group', operator: 'AND'|'OR', children: (ConditionGroup|ConditionRule)[] }
 * ConditionRule  = { type: 'condition', field, operator, value?, fromValue? }
 *
 * operator one of: equals | not_equals | any_change | changed_to | changed_from
 *   | changed_from_to (uses fromValue AND value) | is_empty | is_not_empty
 *   | event_type_created (ignores `field`)
 *
 * Empty group semantics: AND([]) = true, OR([]) = false.
 */
export function evaluateConditionTree(node, context) {
  if (!node) return true;
  if (node.type === 'group') {
    if (node.children.length === 0) return node.operator === 'AND';
    return node.operator === 'OR'
      ? node.children.some((child) => evaluateConditionTree(child, context))
      : node.children.every((child) => evaluateConditionTree(child, context));
  }
  if (node.type === 'condition') {
    return evaluateCondition(node, context);
  }
  throw new Error(`Unknown condition node type: ${node.type}`);
}

function evaluateCondition(condition, context) {
  const { operator } = condition;

  if (operator === 'event_type_created') {
    return context.eventType === 'created';
  }

  const entry = context.changeSetByField.get(condition.field) ?? { from: null, to: null, changed: false };

  switch (operator) {
    case 'equals':
      return valuesEqual(entry.to, condition.value);
    case 'not_equals':
      return !valuesEqual(entry.to, condition.value);
    case 'any_change':
      return entry.changed;
    case 'changed_to':
      return entry.changed && valuesEqual(entry.to, condition.value);
    case 'changed_from':
      return entry.changed && valuesEqual(entry.from, condition.value);
    case 'changed_from_to':
      return entry.changed && valuesEqual(entry.from, condition.fromValue) && valuesEqual(entry.to, condition.value);
    case 'is_empty':
      return isEmpty(entry.to);
    case 'is_not_empty':
      return !isEmpty(entry.to);
    default:
      throw new Error(`Unknown condition operator: ${operator}`);
  }
}

/**
 * Relation fields (type/status/project/assignee/priority/relational custom
 * fields) diff to `{ id, name }` objects, while rule values are typically
 * typed by an admin picking a dropdown option (id) or free text (name). Match
 * either so both authoring paths work.
 */
function valuesEqual(actual, expected) {
  if (actual === expected) return true;
  if (actual && typeof actual === 'object') {
    if (expected && typeof expected === 'object') return actual.id === expected.id;
    return String(actual.id) === String(expected) || (actual.name ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
  }
  return String(actual ?? '') === String(expected ?? '');
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'object') return value.id == null && value.name == null;
  return false;
}

/** Builds the O(1)-lookup context ruleEvaluator needs from a diffEngine ChangeSet array. */
export function buildEvaluationContext(changeSet, eventType) {
  return {
    changeSetByField: new Map(changeSet.map((entry) => [entry.field, entry])),
    eventType: eventType ?? null,
  };
}

/**
 * The same context, but describing the work package as it was *before* this
 * webhook: every field's current value is its previous value, and nothing
 * counts as changed.
 *
 * This is what makes rules edge-triggered (see `ruleAlreadyMatched`). State
 * conditions like `equals` are true for as long as the work package sits in
 * that state, so a rule built only from them would re-send on every
 * subsequent webhook -- an attachment upload, a description edit, a
 * reassignment. Evaluating the same tree against the prior state tells us
 * whether the rule was *already* satisfied before this change, which is
 * exactly the case where a notification would be a repeat.
 */
export function buildPreviousEvaluationContext(changeSet) {
  return {
    changeSetByField: new Map(
      changeSet.map((entry) => [entry.field, { field: entry.field, from: null, to: entry.from, changed: false }])
    ),
    // A creation is never true of the prior state -- there wasn't one.
    eventType: null,
  };
}

/**
 * True when this rule was already satisfied before the incoming change, i.e.
 * firing now would repeat a notification the recipient already got.
 *
 * Transition conditions (`changed_to`, `any_change`, `event_type_created`, …)
 * are inherently false against the prior state, but that alone is not enough
 * to protect them: in "type is Запит AND (status is Нова OR assignee
 * changed)" the OR was already true through status, so a reassignment of a
 * ticket sitting in Нова was suppressed and nobody was told. A match that a
 * transition happening *now* takes part in is a new event, never a repeat,
 * so only a match made of state conditions alone is suppressed.
 */
export function ruleAlreadyMatched(conditionTree, changeSet, eventType = null) {
  if (!evaluateConditionTree(conditionTree, buildPreviousEvaluationContext(changeSet))) return false;
  return !matchedThroughTransition(conditionTree, buildEvaluationContext(changeSet, eventType));
}

const TRANSITION_OPERATORS = new Set([
  'any_change',
  'changed_to',
  'changed_from',
  'changed_from_to',
  'event_type_created',
]);

/** Whether some currently-true transition condition is part of what satisfies `node`. */
function matchedThroughTransition(node, context) {
  if (!node) return false;
  if (node.type === 'condition') {
    return TRANSITION_OPERATORS.has(node.operator) && evaluateCondition(node, context);
  }
  if (node.type === 'group') {
    if (node.operator === 'OR') return node.children.some((child) => matchedThroughTransition(child, context));
    return (
      node.children.every((child) => evaluateConditionTree(child, context)) &&
      node.children.some((child) => matchedThroughTransition(child, context))
    );
  }
  return false;
}
