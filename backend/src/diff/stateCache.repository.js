export function getByWorkPackageId(db, workPackageId) {
  const row = db
    .prepare('SELECT * FROM work_package_state_cache WHERE work_package_id = ?')
    .get(workPackageId);
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

export function upsert(db, { workPackageId, projectId, snapshot, payloadHash, lastUpdatedAt }) {
  db.prepare(
    `INSERT INTO work_package_state_cache
       (work_package_id, project_id, snapshot, payload_hash, last_updated_at, updated_locally_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(work_package_id) DO UPDATE SET
       project_id = excluded.project_id,
       snapshot = excluded.snapshot,
       payload_hash = excluded.payload_hash,
       last_updated_at = excluded.last_updated_at,
       updated_locally_at = datetime('now')`
  ).run(workPackageId, projectId ?? null, JSON.stringify(snapshot), payloadHash, lastUpdatedAt);
}
