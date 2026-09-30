import express from 'express';
import { getDb } from '../db/connection.js';
import * as repo from './contacts.repository.js';
import { runContactSync } from './contactsSync.js';

export const contactsRouter = express.Router();

contactsRouter.post('/sync', async (req, res) => {
  try {
    res.json(await runContactSync(getDb()));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

contactsRouter.get('/', (req, res) => {
  res.json(repo.listAll(getDb()));
});

/**
 * The classification queue: contacts a rule wanted a value from and did not
 * find one for. The rule editor points a field at "the sender's contact"; this
 * is where somebody answers it.
 */
contactsRouter.get('/needs-classification', (req, res) => {
  res.json(repo.listNeedingClassification(getDb()));
});

contactsRouter.put('/:id/field-values', (req, res) => {
  const contact = repo.getById(getDb(), req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(repo.setFieldValues(getDb(), req.params.id, req.body?.fieldValues ?? {}));
});

contactsRouter.patch('/:id/muted', (req, res) => {
  const { muted } = req.body ?? {};
  const contact = repo.getById(getDb(), req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  res.json(repo.setMuted(getDb(), req.params.id, muted));
});

contactsRouter.post('/', (req, res) => {
  const { name, type, signalIdentifier, notes } = req.body ?? {};
  if (!name || !type || !signalIdentifier) {
    return res.status(400).json({ error: 'name, type, and signalIdentifier are required' });
  }
  res.status(201).json(repo.create(getDb(), { name, type, signalIdentifier, notes }));
});

contactsRouter.put('/:id', (req, res) => {
  const { name, type, signalIdentifier, notes } = req.body ?? {};
  if (!name || !type || !signalIdentifier) {
    return res.status(400).json({ error: 'name, type, and signalIdentifier are required' });
  }
  res.json(repo.update(getDb(), req.params.id, { name, type, signalIdentifier, notes }));
});

contactsRouter.delete('/:id', (req, res) => {
  repo.remove(getDb(), req.params.id);
  res.status(204).end();
});
