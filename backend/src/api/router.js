import express from 'express';
import { authRouter } from '../auth/auth.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { rulesRouter } from '../rules/rules.controller.js';
import { contactsRouter } from '../contacts/contacts.controller.js';
import { messageLogRouter } from '../messageLog/messageLog.controller.js';
import { settingsRouter } from '../settings/settings.controller.js';
import { inboundRulesRouter } from '../inboundRules/inboundRules.controller.js';

export const apiRouter = express.Router();

apiRouter.use('/auth', authRouter);

// Everything below requires a logged-in admin session.
apiRouter.use(requireAuth);
apiRouter.use('/rules', rulesRouter);
apiRouter.use('/inbound-rules', inboundRulesRouter);
apiRouter.use('/contacts', contactsRouter);
apiRouter.use('/message-log', messageLogRouter);
apiRouter.use('/settings', settingsRouter);
