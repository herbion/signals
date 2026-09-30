export function listSubscriptions(db) {
  return db
    .prepare('SELECT * FROM signal_group_subscriptions ORDER BY name COLLATE NOCASE ASC')
    .all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

/**
 * Replaces the subscription set with exactly the groups given.
 *
 * Both ids are stored deliberately: `group_id` is what /v2/send needs as a
 * recipient, `internal_id` is what arrives on received envelopes, and the
 * inbound path has to look up one from the other. Storing them here means a
 * reply still resolves when signal-cli-rest-api is unreachable.
 */
export function replaceSubscriptions(db, groups) {
  db.prepare('DELETE FROM signal_group_subscriptions').run();
  const insert = db.prepare(
    `INSERT INTO signal_group_subscriptions (group_id, internal_id, name, enabled)
     VALUES (@groupId, @internalId, @name, 1)`
  );
  for (const group of groups ?? []) {
    if (!group?.id) continue;
    insert.run({
      groupId: group.id,
      internalId: group.internalId ?? group.internal_id ?? null,
      name: group.name ?? null,
    });
  }
  return listSubscriptions(db);
}
