import express from 'express';
import { getDb } from '../db/connection.js';
import * as repo from './rules.repository.js';
import { evaluateConditionTree, buildEvaluationContext } from './ruleEvaluator.js';
import { isDynamicRelation } from './ruleProcessor.js';

export const rulesRouter = express.Router();

rulesRouter.get('/', (req, res) => {
  res.json(repo.listAll(getDb()));
});

rulesRouter.get('/:id', (req, res) => {
  const rule = repo.getById(getDb(), req.params.id);
  if (!rule) return res.status(404).json({ error: 'not found' });
  res.json(rule);
});

rulesRouter.post('/', (req, res) => {
  try {
    res.status(201).json(repo.create(getDb(), fromBody(req.body)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

rulesRouter.put('/:id', (req, res) => {
  try {
    res.json(repo.update(getDb(), req.params.id, fromBody(req.body)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

rulesRouter.delete('/:id', (req, res) => {
  repo.remove(getDb(), req.params.id);
  res.status(204).end();
});

/** Dry-run a rule's condition tree against a hand-supplied ChangeSet, useful for testing a rule from the editor UI. */
rulesRouter.post('/:id/test', (req, res) => {
  const rule = repo.getById(getDb(), req.params.id);
  if (!rule) return res.status(404).json({ error: 'not found' });

  const { changeSet = [], eventType = null } = req.body ?? {};
  const context = buildEvaluationContext(changeSet, eventType);
  res.json({ matches: evaluateConditionTree(rule.conditionTree, context) });
});

function fromBody(body) {
  const {
    name,
    enabled,
    projectScope,
    conditionTree,
    actionRecipientMode,
    actionRecipientContactId,
    actionRecipientRaw,
    actionRecipientDynamicRelation,
    messageTemplate,
    commentTemplate,
    allowedContactIds,
    batchWindowSeconds,
    priority,
  } = body ?? {};
  if (!name || !conditionTree || !messageTemplate) {
    throw new Error('name, conditionTree, and messageTemplate are required');
  }
  if (actionRecipientMode === 'dynamic' && !isDynamicRelation(actionRecipientDynamicRelation)) {
    throw new Error(
      'dynamic recipient requires actionRecipientDynamicRelation of "author", "assignee" or a custom field key like "customField21"'
    );
  }
  if (allowedContactIds != null && !Array.isArray(allowedContactIds)) {
    throw new Error('allowedContactIds must be an array of contact ids');
  }
  return {
    name,
    enabled: enabled ?? true,
    projectScope,
    conditionTree,
    actionRecipientMode: actionRecipientMode ?? 'contact',
    actionRecipientContactId,
    actionRecipientRaw,
    actionRecipientDynamicRelation,
    messageTemplate,
    commentTemplate,
    allowedContactIds,
    batchWindowSeconds,
    priority,
  };
}
