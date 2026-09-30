import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { seed } from './db/seed.js';
import { webhookRouter } from './webhooks/openproject.controller.js';
import { signalWebhookRouter } from './webhooks/signal.controller.js';
import { apiRouter } from './api/router.js';
import { startSignalReceiver } from './signal/signalReceiver.js';
import { startOutboundDispatcher } from './signal/outboundDispatcher.js';
import { startMessageLogCleanup } from './messageLog/messageLogCleanup.js';

const db = getDb();
seed(db);

const app = express();
app.use(cookieParser());

// OpenProject webhook requires raw body for HMAC verification
app.use('/webhooks', webhookRouter);
// Signal webhook accepts JSON envelopes
app.use('/webhooks/signal', express.json(), signalWebhookRouter);

app.use(express.json());

app.use('/api', apiRouter);

const frontendDist = path.join(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api|\/webhooks).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});

// Connects to signal-cli-rest-api for inbound messages (websocket in
// json-rpc modes, GET polling otherwise -- see signalReceiver.js).
startSignalReceiver(db);
// Flushes queued outbound messages once their grouping window elapses.
// Also drains anything left pending by a restart mid-window.
startOutboundDispatcher(db);
// Keeps only the last week of message_log rows.
startMessageLogCleanup(db);
