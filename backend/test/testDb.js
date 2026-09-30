import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** In-memory DB with the real schema applied, for tests that need actual persistence. */
export function createTestDb() {
  const db = new DatabaseSync(':memory:');
  const migrationsDir = path.join(import.meta.dirname, '..', 'src', 'db', 'migrations');
  for (const file of fs.readdirSync(migrationsDir).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return db;
}
