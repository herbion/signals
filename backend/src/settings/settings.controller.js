import express from 'express';
import { getDb } from '../db/connection.js';
import * as repo from './settings.repository.js';
import { testConnection, fetchMetadata, fetchUsers, fetchTypeSchema } from '../openproject/openprojectClient.js';
import { toUserOptions } from '../contacts/contactsSync.js';
import { getGroups } from '../signal/signalGroups.js';
import { signalFetch } from '../signal/signalHttp.js';
import * as subscriptionsRepo from '../signal/subscriptions.repository.js';

export const settingsRouter = express.Router();

settingsRouter.get('/openproject', (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  res.json({
    baseUrl: settings.base_url,
    apiKeySet: Boolean(settings.api_key),
    webhookSecretSet: Boolean(settings.webhook_secret),
    webhookUrl: `${req.protocol}://${req.get('host')}/webhooks/openproject/${settings.webhook_token}`,
    metadataCache: settings.metadata_cache,
    phoneCustomField: settings.phone_custom_field,
  });
});

settingsRouter.put('/openproject', (req, res) => {
  const db = getDb();
  const current = repo.getOpenProjectSettings(db);
  // Blank-means-keep for the secret fields (the UI never echoes them back),
  // but phoneCustomField is a visible value, so an explicit empty string
  // there means "clear it".
  const { baseUrl, apiKey, webhookSecret, phoneCustomField } = req.body ?? {};
  repo.updateOpenProjectSettings(db, {
    baseUrl: baseUrl !== undefined ? baseUrl : current.base_url,
    apiKey: apiKey ? apiKey : current.api_key,
    webhookSecret: webhookSecret ? webhookSecret : current.webhook_secret,
    phoneCustomField: phoneCustomField !== undefined ? phoneCustomField : current.phone_custom_field,
  });
  res.status(204).end();
});

/**
 * Lists the `customFieldNN` keys actually present on OpenProject user
 * records, so the admin can pick which one holds the phone number.
 * `/api/v3/custom_fields` doesn't exist on all OpenProject versions, so
 * detect from a real user payload instead and enrich with names from the
 * metadata cache when they happen to be available.
 */
settingsRouter.get('/openproject/user-fields', async (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  if (!settings.base_url || !settings.api_key) {
    return res.status(400).json({ error: 'base URL and API key must be configured first' });
  }

  try {
    const users = await fetchUsers(settings.base_url, settings.api_key);
    const keys = new Set();
    for (const user of users) {
      for (const key of Object.keys(user)) {
        if (/^customField\d+$/.test(key)) keys.add(key);
      }
    }
    const namesById = new Map((settings.metadata_cache?.customFields ?? []).map((cf) => [`customField${cf.id}`, cf.name]));
    res.json([...keys].map((key) => ({ key, name: namesById.get(key) ?? null })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Active OpenProject users, id + display name, for pickers that need a real
 * person rather than a schema field's own (often absent) allowed-values list
 * -- the assignee-routing rules in the inbound rule editor, e.g. Reuses the
 * same `fetchUsers` contact sync already calls, so no second pagination path
 * to keep correct.
 */
settingsRouter.get('/openproject/users', async (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  if (!settings.base_url || !settings.api_key) {
    return res.status(400).json({ error: 'base URL and API key must be configured first' });
  }
  try {
    const users = await fetchUsers(settings.base_url, settings.api_key);
    res.json(toUserOptions(users));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

settingsRouter.post('/openproject/test-connection', async (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  if (!settings.base_url || !settings.api_key) {
    return res.status(400).json({ error: 'base URL and API key must be configured first' });
  }
  try {
    const user = await testConnection(settings.base_url, settings.api_key);
    res.json({ ok: true, user: user.name ?? user.login });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

settingsRouter.post('/openproject/refresh-metadata', async (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  if (!settings.base_url || !settings.api_key) {
    return res.status(400).json({ error: 'base URL and API key must be configured first' });
  }
  try {
    const metadata = await fetchMetadata(settings.base_url, settings.api_key);
    repo.updateMetadataCache(db, metadata);
    res.json(metadata);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * The writable fields of one (project, type) pair, so the rule editor can
 * show what a work package of that type actually needs. OpenProject types can
 * make custom fields mandatory and can generate the subject themselves, so
 * this cannot be hard-coded.
 */
settingsRouter.get('/openproject/schema', async (req, res) => {
  const db = getDb();
  const settings = repo.getOpenProjectSettings(db);
  if (!settings.base_url || !settings.api_key) {
    return res.status(400).json({ error: 'base URL and API key must be configured first' });
  }
  const { projectId, typeId } = req.query;
  if (!projectId || !typeId) {
    return res.status(400).json({ error: 'projectId and typeId are required' });
  }
  try {
    res.json(await fetchTypeSchema(settings.base_url, settings.api_key, projectId, typeId));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

settingsRouter.get('/signal', (req, res) => {
  res.json(repo.getSignalSettings(getDb()));
});

settingsRouter.put('/signal', (req, res) => {
  const {
    signalApiBaseUrl,
    botNumber,
    receiveTransport,
    pollIntervalSeconds,
    receiveEnabled,
    textMode,
    groupingEnabled,
    groupingWindowSeconds,
    inboundWebhookToken,
    defaultProjectId,
    defaultTypeId,
    allowDirectMessages,
    subscribeAllGroups,
    autoReplyEnabled,
    defaultReplayGroupId,
  } = req.body ?? {};
  if (!signalApiBaseUrl) return res.status(400).json({ error: 'signalApiBaseUrl is required' });
  res.json(
    repo.updateSignalSettings(getDb(), {
      signalApiBaseUrl,
      botNumber,
      receiveTransport,
      pollIntervalSeconds,
      receiveEnabled,
      textMode,
      groupingEnabled,
      groupingWindowSeconds,
      inboundWebhookToken,
      defaultProjectId,
      defaultTypeId,
      allowDirectMessages,
      subscribeAllGroups,
      autoReplyEnabled,
      defaultReplayGroupId,
    })
  );
});

/**
 * The bot's Signal groups, each flagged with whether it is subscribed.
 * This is how an admin discovers group ids at all -- they are opaque base64
 * and there is nowhere in the Signal app to read them off.
 */
settingsRouter.get('/signal/groups', async (req, res) => {
  const db = getDb();
  const subscribed = new Set(subscriptionsRepo.listSubscriptions(db).map((s) => s.group_id));
  try {
    const groups = await getGroups(db, { force: req.query.refresh === 'true' });
    res.json(groups.map((group) => ({ ...group, subscribed: subscribed.has(group.id) })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

settingsRouter.get('/signal/subscriptions', (req, res) => {
  res.json(subscriptionsRepo.listSubscriptions(getDb()));
});

settingsRouter.put('/signal/subscriptions', async (req, res) => {
  const db = getDb();
  const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
  try {
    // Re-read the live group list so the stored name and internal id belong to
    // the same group as the id being subscribed, rather than trusting the
    // browser to send a matching triple.
    const groups = await getGroups(db);
    const chosen = groups.filter((group) => groupIds.includes(group.id));
    const unknown = groupIds.filter((id) => !groups.some((group) => group.id === id));
    if (unknown.length) {
      return res.status(400).json({ error: `not a group this bot belongs to: ${unknown.join(', ')}` });
    }
    res.json(subscriptionsRepo.replaceSubscriptions(db, chosen));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

settingsRouter.get('/signal/link-status', async (req, res) => {
  const db = getDb();
  const settings = repo.getSignalSettings(db);
  if (!settings.bot_number) return res.json({ linked: false, reason: 'no bot number configured' });

  try {
    const response = await signalFetch(`${settings.signal_api_base_url}/v1/accounts`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const accounts = await response.json();
    const linked = Array.isArray(accounts) && accounts.includes(settings.bot_number);
    res.json({ linked });
  } catch (err) {
    res.status(502).json({ linked: false, error: err.message });
  }
});
