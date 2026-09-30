import path from 'node:path';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'app.db'),
  jwtSecret: required('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-not-for-production'),
  adminInitUsername: process.env.ADMIN_INIT_USERNAME ?? 'admin',
  adminInitPassword: process.env.ADMIN_INIT_PASSWORD ?? 'admin',
  signalApiBaseUrl: process.env.SIGNAL_API_BASE_URL ?? 'http://localhost:8080',
  signalReceivePollIntervalMs: Number(process.env.SIGNAL_RECEIVE_POLL_INTERVAL_MS ?? 10000),
};
