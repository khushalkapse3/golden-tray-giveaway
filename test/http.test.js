'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/http/app');
const { makeEngine, webhookPayload, freshOrder } = require('./helpers');

const SECRET = 'whsec_test';

async function start({ settings, password = 'pw', token = 'tok' } = {}) {
  const ctx = makeEngine({ settings });
  const config = {
    env: 'test', adminPassword: password, adminToken: token, sessionSecret: 'sess',
    shopify: { domain: 'shop.myshopify.com', webhookSecret: SECRET, adminStoreHandle: 'shop', apiVersion: '2026-10' },
    publicUrl: 'https://gt.example.com',
  };
  const app = createApp({ engine: ctx.engine, config, logger: { info() {}, warn() {}, error() {} }, clock: () => ctx.engine.clock() });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, { body, headers = {}, raw, auth = true } = {}) => {
    const h = { ...headers };
    if (auth && cookie) h.Cookie = cookie;
    if (body !== undefined && !raw) h['Content-Type'] = h['Content-Type'] || 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const login = async (name = 'Khushal') => {
    const res = await call('POST', '/api/login', { body: { name, password } });
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    return res;
  };
  test.after(() => server.close());
  return { ...ctx, call, login, setCookie: (c) => { cookie = c; } };
}

const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');
const webhookHeaders = (body, extra = {}) => ({
  'Content-Type': 'application/json',
  'X-Shopify-Hmac-Sha256': sign(body),
  'X-Shopify-Topic': 'orders/create',
  'X-Shopify-Shop-Domain': 'shop.myshopify.com',
  ...extra,
});

test('health is public; the API needs a login', async () => {
  const { call } = await start();
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/api/status')).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('login: wrong password 401, right password sets an HttpOnly SameSite=Strict cookie', async () => {
  const { call, login } = await start();
  assert.equal((await call('POST', '/api/login', { body: { name: 'K', password: 'nope' } })).status, 401);
  const res = await login('Khushal');
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /gt_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.deepEqual((await call('GET', '/api/me')).json, { name: 'Khushal' });
  assert.equal((await call('GET', '/api/status')).status, 200);
});

test('login needs a name', async () => {
  const { call } = await start();
  assert.equal((await call('POST', '/api/login', { body: { name: ' ', password: 'pw' } })).status, 400);
});

test('login is rate limited: the 6th wrong try in a minute gets 429', async () => {
  const { call } = await start();
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/api/login', { body: { name: 'x', password: 'bad' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { name: 'x', password: 'bad' } })).status, 429);
});

test('a Bearer ADMIN_TOKEN works for scripts; a tampered cookie does not', async () => {
  const { call, setCookie, login } = await start();
  assert.equal((await call('GET', '/api/status', { headers: { Authorization: 'Bearer tok' } })).status, 200);
  assert.equal((await call('GET', '/api/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  await login('A');
  const good = (await call('POST', '/api/logout', { body: {} })).status;
  assert.equal(good, 200);
  setCookie('gt_session=eyJuIjoiRXZlIiwiZSI6OTk5OTk5OTk5OTk5OX0.forged');
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('logout ends the session', async () => {
  const { call, login } = await start();
  await login();
  const res = await call('POST', '/api/logout', { body: {} });
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('mutations must be JSON (blocks cross-site form posts)', async () => {
  const { call, login } = await start();
  await login();
  const res = await call('PATCH', '/api/settings', { raw: 'oneInN=5', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
});

test('PATCH /api/settings: 200 with the audit actor, 400 with the field, 409 when locked', async () => {
  const { call, login, store } = await start();
  await login('Khushal');
  const ok = await call('PATCH', '/api/settings', { body: { oneInN: 25 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.oneInN, 25);
  assert.ok(Array.isArray(ok.json.warnings));
  assert.equal(store.listEvents({ limit: 1 })[0].actor, 'Khushal');
  const bad = await call('PATCH', '/api/settings', { body: { oneInN: 0 } });
  assert.deepEqual([bad.status, bad.json.error, bad.json.field], [400, 'invalid', 'oneInN']);
  const locked = await call('PATCH', '/api/settings', { body: { traySku: 'OTHER' } });
  assert.deepEqual([locked.status, locked.json.error, locked.json.field], [409, 'locked_while_live', 'traySku']);
});

test('PATCH mode live with a failing setup: 409 setup_incomplete with problems', async () => {
  const { call, login, shopify } = await start({ settings: { mode: 'off' } });
  await login();
  shopify.scopes = [];
  const res = await call('PATCH', '/api/settings', { body: { mode: 'live' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'setup_incomplete');
  assert.ok(res.json.problems.length > 0);
});

test('webhook: bad HMAC 401; good HMAC stores the order; other shops and topics are refused or ignored', async () => {
  const { call, store, shopify } = await start();
  shopify.orders.set('1', freshOrder(1));
  const body = JSON.stringify(webhookPayload(1));
  assert.equal((await call('POST', '/webhooks/orders/create', { raw: body, headers: { ...webhookHeaders(body), 'X-Shopify-Hmac-Sha256': 'bad' }, auth: false })).status, 401);
  assert.equal(store.getOrder('1'), undefined);
  assert.equal((await call('POST', '/webhooks/orders/create', { raw: body, headers: webhookHeaders(body, { 'X-Shopify-Shop-Domain': 'evil.myshopify.com' }), auth: false })).status, 403);
  assert.equal((await call('POST', '/webhooks/orders/create', { raw: body, headers: webhookHeaders(body, { 'X-Shopify-Topic': 'orders/paid' }), auth: false })).status, 200);
  assert.equal(store.getOrder('1'), undefined);
  const ok = await call('POST', '/webhooks/orders/create', { raw: body, headers: webhookHeaders(body), auth: false });
  assert.equal(ok.status, 200);
  assert.equal(store.getOrder('1').status, 'queued');
});

test('orders, winners, CSV, events and timeline', async () => {
  const { call, login, engine, shopify, advance, drain } = await start();
  await login();
  for (const id of [1, 2]) { shopify.orders.set(String(id), freshOrder(id)); await engine.receiveWebhook(webhookPayload(id)); }
  advance(61);
  await drain();
  const orders = await call('GET', '/api/orders?status=won');
  assert.equal(orders.json.total, 2);
  assert.equal(orders.json.items[0].adminUrl.startsWith('https://admin.shopify.com/store/shop/orders/'), true);
  const winners = await call('GET', '/api/winners?mode=live');
  assert.deepEqual(winners.json.items.map((w) => w.slot), [1, 2]);
  const csv = await call('GET', '/api/winners.csv?mode=live');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="golden-tray-winners-live/);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines[0], 'slot,order,order_id,created_at,won_at,customer_id,customer_email,subtotal,tag_status');
  assert.equal(lines.length, 3);
  const events = await call('GET', '/api/events?limit=5');
  assert.ok(events.json.items.some((e) => e.type === 'won'));
  const timeline = await call('GET', '/api/timeline?bucketMinutes=60');
  assert.equal(timeline.status, 200);
  assert.ok(Array.isArray(timeline.json.buckets));
});

test('CSV cells that look like formulas are neutralised', async () => {
  const { toCsv } = require('../src/http/app');
  assert.equal(toCsv([['=HYPERLINK("x")', 'a,b', 'say "hi"', '+1', 'plain']]), '"\'=HYPERLINK(""x"")","a,b","say ""hi""",\'+1,plain\n');
});

test('retry endpoints map errors to 404 / 409', async () => {
  const { call, login } = await start();
  await login();
  assert.equal((await call('POST', '/api/orders/404/retry', { body: {} })).status, 404);
  assert.equal((await call('POST', '/api/orders/404/retry-tags', { body: {} })).status, 404);
});

test('check an order: 404 when Shopify has no such order, report otherwise', async () => {
  const { call, login, shopify } = await start();
  await login();
  assert.equal((await call('POST', '/api/orders/check', { body: { order: '#9' } })).status, 404);
  shopify.orders.set('5', freshOrder(5));
  const res = await call('POST', '/api/orders/check', { body: { order: '#5' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.eligible, true);
});

test('setup check and webhook registration', async () => {
  const { call, login } = await start();
  await login();
  const setup = await call('GET', '/api/setup');
  assert.equal(setup.status, 200);
  assert.equal(setup.json.ok, true);
  const reg = await call('POST', '/api/setup/webhook', { body: {} });
  assert.deepEqual([reg.status, reg.json.created], [200, true]);
});

test('reset needs RESET and is refused for "all" while live', async () => {
  const { call, login } = await start();
  await login();
  assert.equal((await call('POST', '/api/reset', { body: { scope: 'all', confirm: 'no' } })).status, 400);
  assert.equal((await call('POST', '/api/reset', { body: { scope: 'all', confirm: 'RESET' } })).status, 409);
  assert.equal((await call('POST', '/api/reset', { body: { scope: 'shadow', confirm: 'RESET' } })).status, 200);
});

test('security headers on every response', async () => {
  const { call } = await start();
  const res = await call('GET', '/health');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('unknown API routes are JSON 404s', async () => {
  const { call, login } = await start();
  await login();
  const res = await call('GET', '/api/nope');
  assert.deepEqual([res.status, res.json.error], [404, 'not_found']);
});

test('orders/updated is accepted and ignored (the shared ngrok URL receives both topics), but still HMAC-checked', async () => {
  const { call, store } = await start();
  const body = JSON.stringify(webhookPayload(1));
  assert.equal((await call('POST', '/webhooks/orders/updated', { raw: body, headers: { ...webhookHeaders(body), 'X-Shopify-Topic': 'orders/updated', 'X-Shopify-Hmac-Sha256': 'bad' }, auth: false })).status, 401);
  const ok = await call('POST', '/webhooks/orders/updated', { raw: body, headers: webhookHeaders(body, { 'X-Shopify-Topic': 'orders/updated' }), auth: false });
  assert.equal(ok.status, 200);
  assert.equal(store.getOrder('1'), undefined, 'an update does not create or change anything');
});
