'use strict';

// Express app: public /health and the Shopify webhook, the logged-in /api, and the dashboard.

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createAuth } = require('./auth');
const { SettingsError } = require('../settings');
const { HttpError } = require('../engine');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

/** CSV with formula-injection protection (cells starting with = + - @ get a leading quote). */
function toCsv(rows) {
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

function verifyHmac(rawBody, header, secret) {
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(header, 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function createApp({ engine, config, logger, clock = () => new Date() }) {
  const app = express();
  const auth = createAuth({ password: config.adminPassword, token: config.adminToken, secret: config.sessionSecret, clock });
  const store = engine.store;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // --- Shopify webhook (HMAC over the raw body) --------------------------------------------
  app.post('/webhooks/orders/create', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyHmac(body, req.get('x-shopify-hmac-sha256'), config.shopify.webhookSecret)) {
      logger.warn('webhook rejected: bad HMAC', { shop: req.get('x-shopify-shop-domain') });
      return res.status(401).json({ error: 'invalid_hmac' });
    }
    const shop = String(req.get('x-shopify-shop-domain') || '').toLowerCase();
    if (shop !== config.shopify.domain) return res.status(403).json({ error: 'wrong_shop' });
    if (req.get('x-shopify-topic') !== 'orders/create') return res.json({ ok: true, ignored: 'topic' });
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }
    try {
      const result = engine.receiveWebhook(payload);
      return res.json({ ok: true, ...result });
    } catch (error) {
      // 500 makes Shopify retry the delivery later.
      logger.error('webhook processing failed', { error: error.message, orderId: payload?.id });
      return res.status(500).json({ error: 'internal' });
    }
  });

  // The store's existing webhook URL may also receive orders/updated; nothing to do with it.
  app.post('/webhooks/orders/updated', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyHmac(body, req.get('x-shopify-hmac-sha256'), config.shopify.webhookSecret)) return res.status(401).json({ error: 'invalid_hmac' });
    return res.json({ ok: true, ignored: 'orders/updated' });
  });

  // --- API -----------------------------------------------------------------------------------
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // JSON only: a cross-site HTML form can not send application/json.
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    return next();
  });
  api.use(express.json({ limit: '100kb' }));

  api.post('/login', (req, res) => {
    const ip = req.ip;
    if (auth.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const name = String(req.body?.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!auth.checkPassword(String(req.body?.password || ''))) {
      auth.recordFailure(ip);
      return res.status(401).json({ error: 'bad_password' });
    }
    store.addEvent({ type: 'login', actor: name, message: `${name} logged in` });
    res.set('Set-Cookie', auth.cookie(auth.issue(name), { secure: req.secure }));
    return res.json({ ok: true, name });
  });

  api.post('/logout', (req, res) => {
    res.set('Set-Cookie', auth.cookie('', { secure: req.secure, clear: true }));
    res.json({ ok: true });
  });

  api.use(auth.requireAuth);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  api.get('/me', (req, res) => res.json({ name: req.user }));
  api.get('/status', (req, res) => res.json(engine.status()));
  api.patch('/settings', wrap(async (req, res) => {
    const { settings, warnings } = await engine.updateSettings(req.body, req.user);
    res.json({ settings, warnings });
  }));
  api.get('/orders', (req, res) => {
    const { total, items } = store.listOrders(req.query);
    res.json({ total, items: items.map((r) => engine.toApiOrder(r)) });
  });
  api.get('/winners', (req, res) => {
    res.json({ items: store.winners(req.query.mode === 'shadow' ? 'shadow' : 'live').map((r) => engine.toApiOrder(r)) });
  });
  api.get('/winners.csv', (req, res) => {
    const mode = req.query.mode === 'shadow' ? 'shadow' : 'live';
    const rows = store.winners(mode).map((r) => [r.slot, r.name, r.id, r.created_at, r.tray_added_at, r.customer_id, r.customer_email, r.subtotal, r.tag_status]);
    const stamp = clock().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="golden-tray-winners-${mode}-${stamp}.csv"`);
    res.send(toCsv([['slot', 'order', 'order_id', 'created_at', 'won_at', 'customer_id', 'customer_email', 'subtotal', 'tag_status'], ...rows]));
  });
  api.get('/timeline', (req, res) => res.json(engine.timeline(req.query.bucketMinutes)));
  api.get('/events', (req, res) => {
    const items = store.listEvents({ limit: req.query.limit, before: req.query.before }).map((e) => ({
      id: e.id, at: e.at, level: e.level, type: e.type, orderId: e.order_id, orderName: e.order_name, actor: e.actor, message: e.message,
    }));
    res.json({ items });
  });
  api.post('/orders/check', wrap(async (req, res) => res.json(await engine.checkOrder(req.body?.order))));
  api.post('/orders/:id/retry', wrap(async (req, res) => res.json(await engine.retryOrder(req.params.id, req.user))));
  api.post('/orders/:id/retry-tags', wrap(async (req, res) => res.json(await engine.retryOrderTags(req.params.id, req.user))));
  api.get('/setup', wrap(async (req, res) => res.json(await engine.setupCheck())));
  api.post('/setup/webhook', wrap(async (req, res) => res.json(await engine.registerWebhook(req.user))));
  api.post('/reset', wrap(async (req, res) => res.json(await engine.reset(req.body?.scope, req.body?.confirm, req.user))));

  api.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  api.use((error, req, res, next) => {
    if (error instanceof SettingsError) {
      return res.status(error.status).json({ error: error.code, field: error.field, message: error.message, ...(error.problems ? { problems: error.problems } : {}) });
    }
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.code, message: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    logger.error('api error', { path: req.path, error: error.message });
    return res.status(500).json({ error: 'internal', message: error.message });
  });
  app.use('/api', api);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  return app;
}

module.exports = { createApp, toCsv, verifyHmac };
