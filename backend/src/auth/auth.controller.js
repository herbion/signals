import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { requireAuth } from './auth.middleware.js';

export const authRouter = express.Router();

// secure is derived per-request from req.secure rather than hardcoded from
// NODE_ENV: this stack has no TLS termination (plain HTTP on the LAN), so a
// hardcoded `secure: true` in production made every Set-Cookie get silently
// dropped by the browser -- except on the host machine via localhost, which
// Chrome/Firefox special-case as a trustworthy origin even over http. That
// made login "succeed" (200, Set-Cookie) but every subsequent request 401
// from any other machine on the network. req.secure will correctly flip to
// true if this is ever put behind a TLS-terminating proxy (with
// app.set('trust proxy', ...) configured).
function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 24 * 60 * 60 * 1000,
  };
}

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM admin_user WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, { expiresIn: '24h' });
  res.cookie('token', token, cookieOptions(req));
  res.json({ username: user.username });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('token', cookieOptions(req));
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

authRouter.put('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(req.user.sub);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  res.status(204).end();
});
