export function getOpenProjectSettings(db) {
  const row = db.prepare('SELECT * FROM openproject_settings WHERE id = 1').get();
  return { ...row, metadata_cache: row.metadata_cache ? JSON.parse(row.metadata_cache) : null };
}

export function updateOpenProjectSettings(db, { baseUrl, apiKey, webhookSecret, phoneCustomField }) {
  db.prepare(
    `UPDATE openproject_settings SET
       base_url = @baseUrl,
       api_key = @apiKey,
       webhook_secret = @webhookSecret,
       phone_custom_field = @phoneCustomField,
       updated_at = datetime('now')
     WHERE id = 1`
  ).run({
    baseUrl: baseUrl ?? null,
    apiKey: apiKey ?? null,
    webhookSecret: webhookSecret ?? null,
    phoneCustomField: phoneCustomField ?? null,
  });
  return getOpenProjectSettings(db);
}

export function updateMetadataCache(db, metadata) {
  db.prepare(`UPDATE openproject_settings SET metadata_cache = ?, updated_at = datetime('now') WHERE id = 1`).run(
    JSON.stringify(metadata)
  );
}

const RECEIVE_TRANSPORTS = new Set(['auto', 'websocket', 'poll', 'webhook']);

export function getSignalSettings(db) {
  return db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();
}

export function updateSignalSettings(
  db,
  {
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
  }
) {
  const current = getSignalSettings(db) || {};
  db.prepare(
    `UPDATE signal_settings SET
       signal_api_base_url = @signalApiBaseUrl,
       bot_number = @botNumber,
       receive_transport = @receiveTransport,
       poll_interval_seconds = @pollIntervalSeconds,
       receive_enabled = @receiveEnabled,
       text_mode = @textMode,
       grouping_enabled = @groupingEnabled,
       grouping_window_seconds = @groupingWindowSeconds,
       inbound_webhook_token = @inboundWebhookToken,
       default_project_id = @defaultProjectId,
       default_type_id = @defaultTypeId,
       allow_direct_messages = @allowDirectMessages,
       subscribe_all_groups = @subscribeAllGroups,
       auto_reply_enabled = @autoReplyEnabled,
       default_replay_group_id = @defaultReplayGroupId,
       updated_at = datetime('now')
     WHERE id = 1`
  ).run({
    signalApiBaseUrl: signalApiBaseUrl ?? current.signal_api_base_url ?? 'http://signal-api:8080',
    botNumber: botNumber !== undefined ? (botNumber ?? null) : current.bot_number,
    receiveTransport: RECEIVE_TRANSPORTS.has(receiveTransport)
      ? receiveTransport
      : (current.receive_transport ?? 'auto'),
    pollIntervalSeconds: pollIntervalSeconds ?? current.poll_interval_seconds ?? 10,
    receiveEnabled: receiveEnabled !== undefined ? (receiveEnabled ? 1 : 0) : (current.receive_enabled ?? 0),
    textMode: (textMode ?? current.text_mode) === 'normal' ? 'normal' : 'styled',
    groupingEnabled: groupingEnabled !== undefined ? (groupingEnabled ? 1 : 0) : (current.grouping_enabled ?? 1),
    groupingWindowSeconds: Math.max(0, Number(groupingWindowSeconds ?? current.grouping_window_seconds ?? 60)),
    inboundWebhookToken:
      inboundWebhookToken !== undefined ? (inboundWebhookToken || null) : (current.inbound_webhook_token ?? null),
    defaultProjectId: defaultProjectId !== undefined ? (defaultProjectId || null) : (current.default_project_id ?? null),
    defaultTypeId: defaultTypeId !== undefined ? (defaultTypeId || null) : (current.default_type_id ?? null),
    allowDirectMessages:
      allowDirectMessages !== undefined ? (allowDirectMessages ? 1 : 0) : (current.allow_direct_messages ?? 1),
    subscribeAllGroups:
      subscribeAllGroups !== undefined ? (subscribeAllGroups ? 1 : 0) : (current.subscribe_all_groups ?? 0),
    autoReplyEnabled: autoReplyEnabled !== undefined ? (autoReplyEnabled ? 1 : 0) : (current.auto_reply_enabled ?? 1),
    // A visible value, so an explicit empty string means "clear it" and fall
    // back to the sole enabled subscription -- see replayGroupId().
    defaultReplayGroupId:
      defaultReplayGroupId !== undefined
        ? (defaultReplayGroupId || null)
        : (current.default_replay_group_id ?? null),
  });
  return getSignalSettings(db);
}
