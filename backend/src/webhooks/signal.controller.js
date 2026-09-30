import express from 'express';
import { getDb } from '../db/connection.js';
import { handleInboundMessage } from '../signal/inboundMessageHandler.js';
import { envelopesFrom } from '../signal/signalReceiver.js';

export const signalWebhookRouter = express.Router();

// Middleware to verify optional webhook token if configured in signal_settings
function verifyWebhookToken(req, res, next) {
  const db = getDb();
  const settings = db.prepare('SELECT inbound_webhook_token FROM signal_settings WHERE id = 1').get();
  const configuredToken = settings?.inbound_webhook_token;

  if (configuredToken) {
    const providedToken =
      req.params.token ||
      req.query.token ||
      req.get('X-Signal-Token') ||
      req.get('X-Webhook-Token');

    if (!providedToken || providedToken !== configuredToken) {
      return res.status(404).json({ error: 'Not found or invalid token' });
    }
  }

  next();
}

/**
 * Handles incoming webhook payloads from Signal / signal-cli-rest-api.
 * Supports:
 *   - POST /webhooks/signal
 *   - POST /webhooks/signal/:token
 * Payload can be a single envelope object or an array of envelope objects.
 */
async function processSignalWebhook(req, res) {
  const db = getDb();
  const body = req.body;

  if (!body) {
    return res.status(400).json({ error: 'Missing request body' });
  }

  let processedCount = 0;
  for (const envelope of envelopesFrom(body)) {
    try {
      await handleInboundMessage(db, envelope);
      processedCount += 1;
    } catch (err) {
      console.error('Error handling Signal webhook envelope:', err);
    }
  }

  return res.status(200).json({ received: true, processed: processedCount });
}

signalWebhookRouter.post('/', verifyWebhookToken, processSignalWebhook);
signalWebhookRouter.post('/:token', verifyWebhookToken, processSignalWebhook);
