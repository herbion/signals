export function insert(db, entry) {
  db.prepare(
    `INSERT INTO message_log
       (direction, rule_id, work_package_id, recipient, sender, content, status, error_message, raw_payload)
     VALUES (@direction, @ruleId, @workPackageId, @recipient, @sender, @content, @status, @errorMessage, @rawPayload)`
  ).run({
    direction: entry.direction,
    ruleId: entry.ruleId ?? null,
    workPackageId: entry.workPackageId ?? null,
    recipient: entry.recipient ?? null,
    sender: entry.sender ?? null,
    content: entry.content,
    status: entry.status,
    errorMessage: entry.errorMessage ?? null,
    rawPayload: entry.rawPayload ? JSON.stringify(entry.rawPayload) : null,
  });
}

/**
 * Summary counters + a daily series for the dashboard tiles. Everything here
 * is derived from real rows -- no placeholder data -- so an empty install
 * legitimately shows zeroes.
 */
export function stats(db, { days = 14 } = {}) {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'sent')    AS sent,
         COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed')  AS failed,
         COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE direction = 'inbound')                         AS inbound
       FROM message_log`
    )
    .get();

  const today = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE direction = 'outbound' AND status = 'sent' AND date(created_at) = date('now')`
    )
    .get().n;

  const rules = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM rules').get();
  const contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;

  const rows = db
    .prepare(
      `SELECT date(created_at) AS day,
              COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM message_log
       WHERE direction = 'outbound' AND date(created_at) >= date('now', @since)
       GROUP BY day`
    )
    .all({ since: `-${days - 1} days` });

  // Fill gaps so the chart has one bar per day rather than collapsing quiet days.
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const daily = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const row = byDay.get(date);
    daily.push({ date, sent: row?.sent ?? 0, failed: row?.failed ?? 0 });
  }

  return {
    sent: counts.sent,
    failed: counts.failed,
    pending: counts.pending,
    inbound: counts.inbound,
    sentToday: today,
    rulesEnabled: rules.enabled,
    rulesTotal: rules.total,
    contacts,
    daily,
  };
}

/**
 * Deletes message_log rows older than `days`. Retention only -- nothing else
 * references message_log (see migration 006), so this is a plain age-based
 * delete with no cascade or status exceptions to worry about.
 */
export function pruneOlderThan(db, { days = 7, now = "datetime('now')" } = {}) {
  const result = db
    .prepare(`DELETE FROM message_log WHERE created_at < datetime(${now}, @cutoff)`)
    .run({ cutoff: `-${days} days` });
  return result.changes;
}

export function list(db, { direction, workPackageId, page = 1, pageSize = 50 } = {}) {
  const conditions = [];
  const params = {};
  if (direction) {
    conditions.push('direction = @direction');
    params.direction = direction;
  }
  if (workPackageId) {
    conditions.push('work_package_id = @workPackageId');
    params.workPackageId = workPackageId;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM message_log ${where}`).get(params).n;
  const rows = db
    .prepare(
      `SELECT ml.*, r.name AS rule_name FROM message_log ml
       LEFT JOIN rules r ON r.id = ml.rule_id
       ${where}
       ORDER BY ml.created_at DESC, ml.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { total, page, pageSize, rows };
}
