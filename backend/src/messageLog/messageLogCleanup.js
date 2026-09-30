import { pruneOlderThan } from './messageLog.repository.js';

let timer = null;
const TICK_MS = 6 * 60 * 60 * 1000; // once every 6 hours is plenty for a retention sweep
const RETENTION_DAYS = 7;

export function startMessageLogCleanup(db) {
  stopMessageLogCleanup();
  const tick = () => {
    try {
      const deleted = pruneOlderThan(db, { days: RETENTION_DAYS });
      if (deleted > 0) console.log(`Pruned ${deleted} message_log row(s) older than ${RETENTION_DAYS} days`);
    } catch (err) {
      console.error('Message log cleanup failed', err.message);
    } finally {
      timer = setTimeout(tick, TICK_MS);
    }
  };
  // Runs immediately on boot (not just after the first tick) so rows that
  // accumulated before this existed are cleared without waiting 6 hours.
  timer = setTimeout(tick, 0);
}

export function stopMessageLogCleanup() {
  if (timer) clearTimeout(timer);
  timer = null;
}
