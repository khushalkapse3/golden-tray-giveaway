'use strict';

// Dashboard login: one shared password plus the person's name (for the audit log).
// The session is a signed cookie: base64url({n: name, e: expiry}).hmac. No server-side state.

const crypto = require('node:crypto');

const COOKIE = 'gt_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sameSecret = (a, b) => Boolean(a) && Boolean(b) && crypto.timingSafeEqual(sha256(a), sha256(b));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ password, token, secret, clock = () => new Date() }) {
  const key = secret || crypto.randomBytes(32).toString('hex');
  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const failures = new Map(); // ip -> [timestamps]

  function issue(name) {
    const data = Buffer.from(JSON.stringify({ n: name, e: clock().getTime() + SESSION_TTL_MS })).toString('base64url');
    return `${data}.${sign(data)}`;
  }

  function verify(value) {
    if (!value || !value.includes('.')) return null;
    const [data, signature] = value.split('.');
    const expected = sign(data);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const session = JSON.parse(Buffer.from(data, 'base64url').toString());
      return session.e > clock().getTime() && typeof session.n === 'string' ? session.n : null;
    } catch {
      return null;
    }
  }

  function blocked(ip) {
    const now = clock().getTime();
    const recent = (failures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failures.set(ip, recent);
    return recent.length >= LOGIN_MAX_FAILURES;
  }

  function recordFailure(ip) {
    failures.set(ip, [...(failures.get(ip) || []), clock().getTime()]);
  }

  function cookie(value, { secure, clear = false } = {}) {
    const parts = [`${COOKIE}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Express middleware: sets req.user or answers 401. */
  function requireAuth(req, res, next) {
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (bearer && token && sameSecret(bearer[1], token)) {
      req.user = 'api-token';
      return next();
    }
    const name = verify(parseCookies(req.get('cookie'))[COOKIE]);
    if (name) {
      req.user = name;
      return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  return {
    issue, verify, blocked, recordFailure, cookie, requireAuth,
    checkPassword: (candidate) => sameSecret(candidate, password),
  };
}

module.exports = { createAuth, parseCookies, COOKIE };
