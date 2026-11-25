require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const Sentry = require('@sentry/node');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (
  isProduction ? '' : 'development-only-secret-change-before-deploy-please'
);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 2;
const roles = new Set(['standard', 'investigator', 'admin']);
const roleLabels = { standard: 'Standard User', investigator: 'Investigator', admin: 'Admin' };
const sentryEnabled = Boolean(process.env.SENTRY_DSN);
let mailer = null;

if (isProduction && jwtSecret.length < 32) {
  throw new Error('Set JWT_SECRET to a random value of at least 32 characters in production.');
}
if (sentryEnabled) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'connect-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'form-action': ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '64kb' }));
app.use((req, _res, next) => {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return next(fail(400, 'Request body must be a JSON object.', 'INVALID_BODY'));
  }
  return next();
});

const nowIso = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const cleanString = (value, maxLength) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const validPassword = (password) =>
  typeof password === 'string' &&
  password.length >= 10 &&
  password.length <= 128 &&
  /[a-z]/.test(password) &&
  /[A-Z]/.test(password) &&
  /\d/.test(password);

if (process.env.VERCEL) {
  const initialization = bootstrapAdmin();
  initialization.catch((error) => {
    console.error('Vercel administrator initialization failed:', error);
    if (sentryEnabled) Sentry.captureException(error);
  });
  app.use((_req, _res, next) => initialization.then(() => next()).catch(next));
}

function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  }
  return mailer;
}

function deviceName(userAgent) {
  const agent = userAgent || 'Unknown browser';
  const browser = /Edg\//i.test(agent) ? 'Edge'
    : /Firefox\//i.test(agent) ? 'Firefox'
      : /Chrome\//i.test(agent) ? 'Chrome'
        : /Safari\//i.test(agent) && !/Chrome\//i.test(agent) ? 'Safari' : 'Browser';
  const platform = /Android/i.test(agent) ? 'Android'
    : /iPhone|iPad/i.test(agent) ? 'iOS'
      : /Windows/i.test(agent) ? 'Windows'
        : /Mac OS/i.test(agent) ? 'macOS'
          : /Linux/i.test(agent) ? 'Linux' : 'device';
  return `${browser} on ${platform}`;
}

function authenticate(req, _res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) return next(fail(401, 'Sign in to continue.', 'AUTH_REQUIRED'));
  try {
    const claims = jwt.verify(match[1], jwtSecret, {
      issuer: 'atlas-research',
      audience: 'atlas-client',
      algorithms: ['HS256']
    });
    if (
      typeof claims.userId !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.role !== 'string' ||
      claims.sub !== claims.userId ||
      !roles.has(claims.role)
    ) {
      return next(fail(401, 'Your session is invalid. Sign in again.', 'INVALID_SESSION'));
    }
    const user = db.prepare('SELECT id, email, display_name, role FROM users WHERE id = ?').get(claims.userId);
    const session = db.prepare(`
      SELECT id FROM sessions
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(claims.sid, claims.userId, nowIso());
    if (!user || !session || user.role !== claims.role) {
      return next(fail(401, 'Your session has expired or was revoked. Sign in again.', 'SESSION_REVOKED'));
    }
    req.auth = { userId: user.id, email: user.email, displayName: user.display_name, role: user.role, sid: claims.sid };
    req.token = match[1];
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') {
      return next(fail(401, 'Your session is invalid or expired. Sign in again.', 'INVALID_SESSION'));
    }
    return next(error);
  }
}

function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(fail(403, 'You do not have permission to perform this action.', 'FORBIDDEN'));
    }
    return next();
  };
}

function issueToken(user, req) {
  const sessionId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionLifetimeMs);
  const userAgent = cleanString(req.get('user-agent'), 512) || 'Unknown device';
  db.prepare(`
    INSERT INTO sessions (id, user_id, device, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, deviceName(userAgent), userAgent, createdAt.toISOString(), expiresAt.toISOString());
  const token = jwt.sign(
    { userId: user.id, role: user.role, sid: sessionId },
    jwtSecret,
    { subject: user.id, issuer: 'atlas-research', audience: 'atlas-client', expiresIn: '12h', algorithm: 'HS256' }
  );
  return { token, sessionId, expiresAt: expiresAt.toISOString() };
}

function getPublicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role, roleLabel: roleLabels[user.role] };
}

const createAuthRateLimit = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'atlas-research' }));

app.get('/api/topics', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, title, subtitle, region, era, category, theme, summary, body, accent
    FROM topics ORDER BY title COLLATE NOCASE
  `).all();
  res.json({ topics: rows });
});

app.get('/api/topics/:topicId', (req, res, next) => {
  const topic = db.prepare(`
    SELECT id, title, subtitle, region, era, category, theme, summary, body, accent
    FROM topics WHERE id = ?
  `).get(req.params.topicId);
  if (!topic) return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  return res.json({ topic });
});

app.post('/api/topics', authenticate, requireRole('investigator', 'admin'), (req, res, next) => {
  const title = cleanString(req.body.title, 120);
  const subtitle = cleanString(req.body.subtitle, 160);
  const region = cleanString(req.body.region, 120);
  const era = cleanString(req.body.era, 120);
  const category = cleanString(req.body.category, 60);
  const theme = cleanString(req.body.theme, 80);
  const summary = cleanString(req.body.summary, 500);
  const body = cleanString(req.body.body, 5000);
  const themeProfile = db.prepare('SELECT accent FROM topics WHERE theme = ? LIMIT 1').get(theme);
  if (
    title.length < 2 ||
    region.length < 2 ||
    era.length < 2 ||
    category.length < 2 ||
    summary.length < 20 ||
    body.length < 30 ||
    !themeProfile
  ) {
    return next(fail(400, 'Add a title, region, period, category, summary, research notes, and choose a catalog theme.', 'INVALID_TOPIC'));
  }
  const id = title.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  if (!id) return next(fail(400, 'The topic title must include letters or numbers.', 'INVALID_TOPIC'));
  const timestamp = nowIso();
  try {
    db.prepare(`
      INSERT INTO topics
        (id, title, subtitle, region, era, category, theme, summary, body, accent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, subtitle || title, region, era, category, theme, summary, body, themeProfile.accent, timestamp, timestamp);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return next(fail(409, 'A topic with a similar title already exists.', 'TOPIC_EXISTS'));
    }
    return next(error);
  }
  const topic = db.prepare(`
    SELECT id, title, subtitle, region, era, category, theme, summary, body, accent
    FROM topics WHERE id = ?
  `).get(id);
  return res.status(201).json({ topic });
});

app.post('/api/auth/register', createAuthRateLimit(), async (req, res, next) => {
  try {
    const email = cleanString(req.body.email, 254).toLowerCase();
    const displayName = cleanString(req.body.displayName, 80);
    const password = req.body.password;
    if (!validEmail(email)) return next(fail(400, 'Enter a valid email address.', 'INVALID_EMAIL'));
    if (displayName.length < 2) return next(fail(400, 'Your name must be at least 2 characters.', 'INVALID_NAME'));
    if (!validPassword(password)) {
      return next(fail(400, 'Use 10–128 characters with at least one lowercase letter, uppercase letter, and number.', 'WEAK_PASSWORD'));
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: crypto.randomUUID(),
      email,
      display_name: displayName,
      password_hash: passwordHash,
      role: 'standard',
      created_at: nowIso()
    };
    try {
      db.prepare(`
        INSERT INTO users (id, email, display_name, password_hash, role, created_at)
        VALUES (@id, @email, @display_name, @password_hash, @role, @created_at)
      `).run(user);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return next(fail(409, 'An account with that email already exists.', 'EMAIL_IN_USE'));
      }
      throw error;
    }
    const session = issueToken(user, req);
    return res.status(201).json({ token: session.token, expiresAt: session.expiresAt, user: getPublicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', createAuthRateLimit(), async (req, res, next) => {
  try {
    const email = cleanString(req.body.email, 254).toLowerCase();
    const password = req.body.password;
    const user = db.prepare(`
      SELECT id, email, display_name, password_hash, role FROM users WHERE email = ?
    `).get(email);
    if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
      return next(fail(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS'));
    }
    const activeCount = db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(user.id, nowIso()).count;
    if (activeCount >= MAX_SESSIONS) {
      return next(fail(409, 'This account already has 2 active devices. Sign out a device from an existing session first.', 'DEVICE_LIMIT'));
    }
    const session = issueToken(user, req);
    return res.json({ token: session.token, expiresAt: session.expiresAt, user: getPublicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.auth }));

app.post('/api/auth/logout', authenticate, (req, res) => {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?')
    .run(nowIso(), req.auth.sid, req.auth.userId);
  res.json({ ok: true });
});

app.post('/api/auth/password', authenticate, async (req, res, next) => {
  try {
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth.userId);
    if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return next(fail(400, 'Your current password is incorrect.', 'CURRENT_PASSWORD_INVALID'));
    }
    if (!validPassword(newPassword)) {
      return next(fail(400, 'Use 10–128 characters with at least one lowercase letter, uppercase letter, and number.', 'WEAK_PASSWORD'));
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const timestamp = nowIso();
    const update = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.auth.userId);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(timestamp, req.auth.userId);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
        .run(timestamp, req.auth.userId);
    });
    update();
    return res.json({ ok: true, message: 'Password updated. Sign in again on your devices.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/recovery', createAuthRateLimit(), async (req, res, next) => {
  try {
    const configuredMailer = getMailer();
    if (isProduction && (!configuredMailer || !process.env.PUBLIC_URL)) {
      console.error('Password recovery is unavailable: set SMTP_HOST and PUBLIC_URL.');
      return next(fail(503, 'Password recovery is temporarily unavailable. Please try again later.', 'RECOVERY_UNAVAILABLE'));
    }
    const email = cleanString(req.body.email, 254).toLowerCase();
    const user = validEmail(email)
      ? db.prepare('SELECT id, email FROM users WHERE email = ?').get(email)
      : null;
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const createdAt = new Date();
      db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
        .run(createdAt.toISOString(), user.id);
      db.prepare(`
        INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        user.id,
        tokenHash,
        new Date(createdAt.getTime() + 20 * 60 * 1000).toISOString(),
        createdAt.toISOString()
      );
      const resetUrl = `${publicUrl}/#/reset-password/${rawToken}`;
      if (configuredMailer) {
        try {
          await configuredMailer.sendMail({
            from: process.env.SMTP_FROM || 'Atlas Research <no-reply@example.com>',
            to: user.email,
            subject: 'Reset your Atlas Research password',
            text: `Use this one-time link within 20 minutes to reset your password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`
          });
        } catch (error) {
          console.error('Password reset email delivery failed:', error.message);
          if (sentryEnabled) Sentry.captureException(error);
        }
      } else {
        console.info(`Development password reset link for ${user.email}: ${resetUrl}`);
      }
    }
    return res.json({ message: 'If an account exists for that email, password reset instructions will be sent.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/recovery/complete', createAuthRateLimit(), async (req, res, next) => {
  try {
    const token = cleanString(req.body.token, 128);
    const password = req.body.password;
    if (!/^[a-f0-9]{64}$/i.test(token)) return next(fail(400, 'This reset link is invalid or expired.', 'RESET_INVALID'));
    if (!validPassword(password)) {
      return next(fail(400, 'Use 10–128 characters with at least one lowercase letter, uppercase letter, and number.', 'WEAK_PASSWORD'));
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = db.prepare(`
      SELECT id, user_id FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash, nowIso());
    if (!reset) return next(fail(400, 'This reset link is invalid or expired.', 'RESET_INVALID'));
    const passwordHash = await bcrypt.hash(password, 12);
    const timestamp = nowIso();
    const completeReset = db.transaction(() => {
      const claimed = db.prepare(`
        UPDATE password_resets SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(timestamp, reset.id, timestamp);
      if (!claimed.changes) return false;
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, reset.user_id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(timestamp, reset.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
        .run(timestamp, reset.user_id);
      return true;
    });
    if (!completeReset()) return next(fail(400, 'This reset link is invalid or expired.', 'RESET_INVALID'));
    return res.json({ message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/sessions', authenticate, (req, res) => {
  const sessions = db.prepare(`
    SELECT id, device, user_agent AS userAgent, created_at AS createdAt, expires_at AS expiresAt
    FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
  `).all(req.auth.userId, nowIso()).map((session) => ({ ...session, current: session.id === req.auth.sid }));
  res.json({ sessions, limit: MAX_SESSIONS });
});

app.delete('/api/sessions/:sessionId', authenticate, (req, res, next) => {
  const result = db.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(nowIso(), req.params.sessionId, req.auth.userId);
  if (!result.changes) return next(fail(404, 'Active session not found.', 'NOT_FOUND'));
  res.json({ ok: true, current: req.params.sessionId === req.auth.sid });
});

app.get('/api/favorites', authenticate, (req, res) => {
  const favorites = db.prepare(`
    SELECT t.id, t.title, t.subtitle, t.region, t.era, t.category, t.theme, t.summary, f.created_at AS savedAt
    FROM favorites f JOIN topics t ON t.id = f.topic_id
    WHERE f.user_id = ? ORDER BY f.created_at DESC
  `).all(req.auth.userId);
  res.json({ favorites });
});

app.put('/api/favorites/:topicId', authenticate, (req, res, next) => {
  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(req.params.topicId);
  if (!topic) return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, topic_id, created_at) VALUES (?, ?, ?)')
    .run(req.auth.userId, topic.id, nowIso());
  res.json({ ok: true, saved: true });
});

app.delete('/api/favorites/:topicId', authenticate, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND topic_id = ?')
    .run(req.auth.userId, req.params.topicId);
  res.json({ ok: true, saved: false });
});

app.get('/api/bookmarks', authenticate, (req, res) => {
  const bookmarks = db.prepare(`
    SELECT b.id, b.topic_id AS topicId, b.label, b.note, b.created_at AS createdAt,
      t.title AS topicTitle, t.theme
    FROM bookmarks b JOIN topics t ON t.id = b.topic_id
    WHERE b.user_id = ? ORDER BY b.created_at DESC
  `).all(req.auth.userId);
  res.json({ bookmarks });
});

app.post('/api/bookmarks', authenticate, (req, res, next) => {
  const topicId = cleanString(req.body.topicId, 80);
  const label = cleanString(req.body.label, 120);
  const note = cleanString(req.body.note, 500);
  if (!db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) {
    return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  }
  if (label.length < 2) return next(fail(400, 'Add a short bookmark title.', 'INVALID_BOOKMARK'));
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO bookmarks (id, user_id, topic_id, label, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.auth.userId, topicId, label, note, nowIso());
  res.status(201).json({ bookmark: { id, topicId, label, note } });
});

app.delete('/api/bookmarks/:bookmarkId', authenticate, (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?')
    .run(req.params.bookmarkId, req.auth.userId);
  res.json({ ok: true });
});

app.get('/api/topics/:topicId/discussions', authenticate, (req, res, next) => {
  if (!db.prepare('SELECT id FROM topics WHERE id = ?').get(req.params.topicId)) {
    return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  }
  const discussions = db.prepare(`
    SELECT d.id, d.title, d.body, d.created_at AS createdAt, u.display_name AS author,
      (SELECT COUNT(*) FROM comments c WHERE c.discussion_id = d.id) AS commentCount
    FROM discussions d JOIN users u ON u.id = d.user_id
    WHERE d.topic_id = ? ORDER BY d.created_at DESC
  `).all(req.params.topicId);
  return res.json({ discussions });
});

app.post('/api/topics/:topicId/discussions', authenticate, (req, res, next) => {
  const topicId = req.params.topicId;
  if (!db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) {
    return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  }
  const title = cleanString(req.body.title, 140);
  const body = cleanString(req.body.body, 3000);
  if (title.length < 4 || body.length < 10) {
    return next(fail(400, 'A discussion needs a title and at least 10 characters of context.', 'INVALID_DISCUSSION'));
  }
  const discussion = { id: crypto.randomUUID(), topicId, userId: req.auth.userId, title, body, createdAt: nowIso() };
  db.prepare(`
    INSERT INTO discussions (id, topic_id, user_id, title, body, created_at)
    VALUES (@id, @topicId, @userId, @title, @body, @createdAt)
  `).run(discussion);
  res.status(201).json({ discussion });
});

app.get('/api/discussions/:discussionId/comments', authenticate, (req, res, next) => {
  const discussion = db.prepare('SELECT id FROM discussions WHERE id = ?').get(req.params.discussionId);
  if (!discussion) return next(fail(404, 'Discussion not found.', 'NOT_FOUND'));
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at AS createdAt, u.display_name AS author
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.discussion_id = ? ORDER BY c.created_at ASC
  `).all(discussion.id);
  return res.json({ comments });
});

app.post('/api/discussions/:discussionId/comments', authenticate, (req, res, next) => {
  const discussion = db.prepare('SELECT id FROM discussions WHERE id = ?').get(req.params.discussionId);
  if (!discussion) return next(fail(404, 'Discussion not found.', 'NOT_FOUND'));
  const body = cleanString(req.body.body, 2000);
  if (body.length < 2) return next(fail(400, 'Write a comment before posting.', 'INVALID_COMMENT'));
  const comment = { id: crypto.randomUUID(), discussionId: discussion.id, userId: req.auth.userId, body, createdAt: nowIso() };
  db.prepare(`
    INSERT INTO comments (id, discussion_id, user_id, body, created_at)
    VALUES (@id, @discussionId, @userId, @body, @createdAt)
  `).run(comment);
  res.status(201).json({ comment });
});

app.get('/api/media/:topicId/cover', authenticate, (req, res, next) => {
  const topic = db.prepare('SELECT title, subtitle, theme, accent FROM topics WHERE id = ?').get(req.params.topicId);
  if (!topic) return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  const escapeXml = (value) => value.replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  }[char]));
  const title = escapeXml(topic.title);
  const subtitle = escapeXml(topic.subtitle);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 620" role="img" aria-label="${title} research cover"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${topic.accent}"/><stop offset="1" stop-color="#172a27"/></linearGradient><pattern id="p" width="56" height="56" patternUnits="userSpaceOnUse"><path d="M0 56 56 0M-14 14 14-14M42 70 70 42" stroke="#fff" stroke-opacity=".09" stroke-width="1"/></pattern></defs><rect width="1200" height="620" fill="url(#g)"/><rect width="1200" height="620" fill="url(#p)"/><circle cx="850" cy="270" r="205" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2"/><circle cx="850" cy="270" r="160" fill="none" stroke="#fff" stroke-opacity=".24" stroke-width="1"/><path d="M705 355 850 130l145 225z" fill="#fff" fill-opacity=".09" stroke="#fff" stroke-opacity=".45" stroke-width="2"/><text x="80" y="405" fill="#fff" font-family="Georgia,serif" font-size="54">${title}</text><text x="82" y="458" fill="#fff" fill-opacity=".8" font-family="Arial,sans-serif" font-size="22">${subtitle}</text><text x="82" y="530" fill="#fff" fill-opacity=".55" font-family="Arial,sans-serif" font-size="14" letter-spacing="5">ATLAS FIELD NOTES</text></svg>`;
  res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store' });
  return res.send(svg);
});

app.put('/api/topics/:topicId', authenticate, requireRole('investigator', 'admin'), (req, res, next) => {
  const existing = db.prepare('SELECT id FROM topics WHERE id = ?').get(req.params.topicId);
  if (!existing) return next(fail(404, 'Research topic not found.', 'NOT_FOUND'));
  const title = cleanString(req.body.title, 120);
  const subtitle = cleanString(req.body.subtitle, 160);
  const summary = cleanString(req.body.summary, 500);
  const body = cleanString(req.body.body, 5000);
  if (title.length < 2 || summary.length < 20 || body.length < 30) {
    return next(fail(400, 'Provide a title, a summary of at least 20 characters, and research notes of at least 30 characters.', 'INVALID_TOPIC'));
  }
  db.prepare(`
    UPDATE topics SET title = ?, subtitle = ?, summary = ?, body = ?, updated_at = ?
    WHERE id = ?
  `).run(title, subtitle || title, summary, body, nowIso(), req.params.topicId);
  const topic = db.prepare(`
    SELECT id, title, subtitle, region, era, category, theme, summary, body, accent
    FROM topics WHERE id = ?
  `).get(req.params.topicId);
  return res.json({ topic });
});

app.get('/api/admin/users', authenticate, requireRole('admin'), (_req, res) => {
  const users = db.prepare(`
    SELECT id, email, display_name AS displayName, role, created_at AS createdAt
    FROM users ORDER BY created_at DESC LIMIT 200
  `).all();
  res.json({ users });
});

app.patch('/api/admin/users/:userId/role', authenticate, requireRole('admin'), (req, res, next) => {
  const role = cleanString(req.body.role, 24);
  if (!roles.has(role)) return next(fail(400, 'Choose a valid user role.', 'INVALID_ROLE'));
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.userId);
  if (!result.changes) return next(fail(404, 'User not found.', 'NOT_FOUND'));
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), req.params.userId);
  const user = db.prepare(`
    SELECT id, email, display_name AS displayName, role FROM users WHERE id = ?
  `).get(req.params.userId);
  res.json({ user });
});

app.get('/api/admin/users/:userId/sessions', authenticate, requireRole('admin'), (req, res, next) => {
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId)) {
    return next(fail(404, 'User not found.', 'NOT_FOUND'));
  }
  const sessions = db.prepare(`
    SELECT id, device, created_at AS createdAt, expires_at AS expiresAt
    FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
  `).all(req.params.userId, nowIso());
  return res.json({ sessions });
});

app.delete('/api/admin/users/:userId/sessions/:sessionId', authenticate, requireRole('admin'), (req, res, next) => {
  const result = db.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(nowIso(), req.params.sessionId, req.params.userId);
  if (!result.changes) return next(fail(404, 'Active session not found.', 'NOT_FOUND'));
  return res.json({ ok: true });
});

app.get('/api/admin/settings', authenticate, requireRole('admin'), (_req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  res.json({ settings });
});

app.put('/api/admin/settings', authenticate, requireRole('admin'), (req, res, next) => {
  const siteTitle = cleanString(req.body.siteTitle, 80);
  if (siteTitle.length < 3) return next(fail(400, 'The platform name must be at least 3 characters.', 'INVALID_SETTING'));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('siteTitle', siteTitle);
  return res.json({ settings: [{ key: 'siteTitle', value: siteTitle }] });
});

app.post('/api/telemetry', (req, res) => {
  const message = cleanString(req.body.message, 500);
  if (sentryEnabled && message) {
    Sentry.captureMessage(`Browser error: ${message}`, {
      level: 'error',
      extra: { stack: cleanString(req.body.stack, 3000) }
    });
  }
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  etag: true,
  maxAge: isProduction ? '1h' : 0
}));

app.use((req, _res, next) => next(fail(404, 'The requested page was not found.', 'NOT_FOUND')));

app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error(error);
    if (sentryEnabled) Sentry.captureException(error);
  }
  if (res.headersSent) return;
  return res.status(status).json({
    error: status >= 500 ? 'An unexpected server error occurred.' : error.message,
    code: error.code || 'REQUEST_FAILED'
  });
});

async function bootstrapAdmin() {
  const email = cleanString(process.env.BOOTSTRAP_ADMIN_EMAIL, 254).toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!validEmail(email) || !validPassword(password)) {
    throw new Error('Set both BOOTSTRAP_ADMIN_EMAIL and a strong BOOTSTRAP_ADMIN_PASSWORD (10+ characters, upper/lowercase and number).');
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare(`
    INSERT INTO users (id, email, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?)
  `).run(crypto.randomUUID(), email, 'Platform Admin', passwordHash, nowIso());
  console.info(`Bootstrapped administrator account: ${email}`);
}

if (require.main === module) {
  bootstrapAdmin()
    .then(() => app.listen(PORT, () => console.info(`Atlas Research listening on port ${PORT}`)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { app, db, bootstrapAdmin };
