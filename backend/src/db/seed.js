import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

export function seed(db) {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM admin_user').get().n;
  if (userCount === 0) {
    const passwordHash = bcrypt.hashSync(config.adminInitPassword, 10);
    db.prepare('INSERT INTO admin_user (username, password_hash) VALUES (?, ?)').run(
      config.adminInitUsername,
      passwordHash
    );
  }

  const opSettings = db.prepare('SELECT id FROM openproject_settings WHERE id = 1').get();
  if (!opSettings) {
    db.prepare(
      'INSERT INTO openproject_settings (id, webhook_token) VALUES (1, ?)'
    ).run(crypto.randomBytes(24).toString('hex'));
  }

  const signalSettings = db.prepare('SELECT id FROM signal_settings WHERE id = 1').get();
  if (!signalSettings) {
    db.prepare(
      'INSERT INTO signal_settings (id, signal_api_base_url) VALUES (1, ?)'
    ).run(config.signalApiBaseUrl);
  }
}
