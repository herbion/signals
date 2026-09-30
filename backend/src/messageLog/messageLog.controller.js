import express from 'express';
import { getDb } from '../db/connection.js';
import * as repo from './messageLog.repository.js';

export const messageLogRouter = express.Router();

// Declared before '/' so it isn't shadowed by the list route's matching.
messageLogRouter.get('/stats', (req, res) => {
  res.json(repo.stats(getDb()));
});

messageLogRouter.get('/', (req, res) => {
  const { direction, workPackageId, page, pageSize } = req.query;
  res.json(
    repo.list(getDb(), {
      direction: direction || undefined,
      workPackageId: workPackageId ? Number(workPackageId) : undefined,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Math.min(Number(pageSize), 200) : 50,
    })
  );
});
