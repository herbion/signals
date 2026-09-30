import express from 'express';
import { getDb } from '../db/connection.js';
import { verifySignature } from './signatureVerifier.js';
import { normalizeWebhookPayload } from './payloadNormalizer.js';
import { processWebhookEvent } from '../diff/diffEngine.js';
import { processChangeEvent } from '../rules/ruleProcessor.js';

export const webhookRouter = express.Router();

// Raw body is needed for HMAC verification, so this route parses the body
// itself instead of relying on a global express.json() middleware.
webhookRouter.post(
  '/openproject/:token',
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res) => {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM openproject_settings WHERE id = 1').get();

    // The path token is a second secret layer so the endpoint isn't
    // guessable even before the signature is checked. 404 (not 401/403) so
    // scanners can't distinguish "wrong token" from "route doesn't exist".
    if (!settings?.webhook_token || req.params.token !== settings.webhook_token) {
      return res.status(404).end();
    }

    const rawBody = req.body; // Buffer, thanks to express.raw()
    if (settings.webhook_secret) {
      const signatureHeader = req.get('X-OP-Signature');
      if (!verifySignature(rawBody, signatureHeader, settings.webhook_secret)) {
        return res.status(401).json({ error: 'invalid signature' });
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }

    let normalized;
    try {
      normalized = normalizeWebhookPayload(payload);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Diff/cache persistence happens synchronously so a failure here
    // surfaces as a 500 and OpenProject retries the delivery. Rule
    // evaluation + Signal sending happen after we respond, and their
    // failures must never turn into a 500 (that would make OpenProject
    // retry the whole webhook and re-run rules that already fired).
    let result;
    try {
      result = processWebhookEvent(db, normalized);
    } catch (err) {
      console.error('Webhook diff processing failed', err);
      return res.status(500).json({ error: 'processing failed' });
    }

    res.status(200).json({ received: true, outcome: result.status });

    if (result.status === 'processed') {
      Promise.resolve(processChangeEvent(db, result)).catch((err) => {
        console.error('Rule processing failed', err);
      });
    }
  }
);
