#!/usr/bin/env node
'use strict';

// End-to-end smoke test, all local: starts a fake Shopify and the REAL app (as a child process,
// temp database), then drives it like Shopify and an admin would. Prints PASS/FAIL per check.
//
//   node scripts/e2e-smoke.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFakeShopify } = require('./fake-shopify');

const SECRET = 'e2e-webhook-secret';
const PASSWORD = 'e2e-password';
const APP_PORT = 3199;
const SHOP_PORT = 4299;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fake = createFakeShopify({ traySku: 'GT-TRAY', trayVariantId: '42' });
  await new Promise((r) => fake.server.listen(SHOP_PORT, r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-'));
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(APP_PORT), DATA_DIR: dataDir,
      SHOPIFY_DOMAIN: fake.domain, SHOPIFY_BASE_URL: `http://127.0.0.1:${SHOP_PORT}`,
      SHOPIFY_CLIENT_ID: 'e2e', SHOPIFY_CLIENT_SECRET: SECRET, ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 's',
      PUBLIC_URL: 'https://golden-tray.example.com', GOLDEN_TRAY_SKU: 'GT-TRAY', GOLDEN_TRAY_VARIANT_ID: '42', WORKER_TICK_MS: '200', DELAY_SECONDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d; });
  app.stderr.on('data', (d) => { appLog += d; });
  const base = `http://127.0.0.1:${APP_PORT}`;
  let cookie = '';
  const api = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text), headers: res.headers }; } catch { return { status: res.status, text, headers: res.headers }; }
  };
  const webhook = async (id, { secret = SECRET } = {}) => {
    const body = JSON.stringify(fake.webhookBody(id));
    const res = await fetch(`${base}/webhooks/orders/create`, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Shop-Domain': fake.domain, 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(body).digest('base64') },
    });
    return res.status;
  };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };

  try {
    check('app starts and /health answers', await waitFor(async () => (await fetch(`${base}/health`).catch(() => ({ ok: false }))).ok));
    check('API refuses without login', (await api('GET', '/api/status')).status === 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E', password: PASSWORD }) });
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('login works', login.status === 200 && cookie.startsWith('gt_session='));

    const now = Date.now();
    const window = { startsAt: new Date(now - 3600000).toISOString(), endsAt: new Date(now + 3600000).toISOString() };
    const set1 = await api('PATCH', '/api/settings', { ...window, oneInN: 1, cap: 3 });
    check('settings saved', set1.status === 200, JSON.stringify(set1.json?.warnings || set1.json));

    const setup = await api('GET', '/api/setup');
    check('setup check passes against (fake) Shopify', setup.json?.ok === true, (setup.json?.problems || []).join('; '));
    const reg = await api('POST', '/api/setup/webhook', {});
    check('webhook registered through the API', reg.json?.created === true && fake.state.webhooks[0]?.uri === 'https://golden-tray.example.com/webhooks/orders/create');

    const live = await api('PATCH', '/api/settings', { mode: 'live' });
    check('switch to live', live.status === 200 && live.json.settings.mode === 'live');

    const createdAt = new Date(now - 60000).toISOString();
    for (let id = 1001; id <= 1004; id += 1) fake.addOrder({ id, createdAt });
    fake.addOrder({ id: 1005, createdAt, subtotal: '20.00' });
    check('bad HMAC webhook is refused', (await webhook(1001, { secret: 'wrong' })) === 401);
    const statuses = [];
    for (let id = 1001; id <= 1005; id += 1) statuses.push(await webhook(id));
    statuses.push(await webhook(1001)); // duplicate delivery
    check('webhooks accepted (incl. a duplicate)', statuses.every((s) => s === 200), statuses.join(','));

    const done = await waitFor(async () => {
      const s = (await api('GET', '/api/status')).json;
      return s && s.counts.live.won === 3 && s.counts.live.cap_reached === 1 && s.counts.live.queued === 0 && s.counts.live.awarding === 0;
    });
    const status = (await api('GET', '/api/status')).json;
    check('cap 3: exactly 3 winners, 1 cap_reached', done, JSON.stringify(status.counts.live));
    check('£20 order stored as not_eligible', status.counts.live.not_eligible === 1);
    check('Shopify got exactly 3 commits', fake.state.commits.length === 3);
    check('every commit: notifyCustomer false, one tray, 100% discount',
      fake.state.commits.every((c) => c.notifyCustomer === false && c.added.length === 1 && c.added[0].discount?.percentValue === 100));
    check('staff note says what happened', fake.state.commits.every((c) => /Golden tray giveaway/.test(c.staffNote)));
    const tagged = fake.state.tags.filter((t) => t.tags.includes('GoldenTrayNov2026'));
    check('order + customer tagged for each winner (6 tagsAdd)', tagged.length === 6, String(tagged.length));
    check('duplicate webhook did not add a second tray', fake.state.orders.get('1001').lineItems.nodes.filter((l) => l.sku === 'GT-TRAY').length <= 1);

    const winners = (await api('GET', '/api/winners?mode=live')).json.items;
    check('winners list has slots 1-3 with admin links', winners.map((w) => w.slot).join(',') === '1,2,3' && winners.every((w) => w.adminUrl.includes('/orders/')));
    const csv = await fetch(`${base}/api/winners.csv?mode=live`, { headers: { Cookie: cookie } });
    const csvText = await csv.text();
    check('CSV export', csv.status === 200 && csvText.trim().split('\n').length === 4);

    const lockedChange = await api('PATCH', '/api/settings', { traySku: 'OTHER' });
    check('tray SKU locked while live (409)', lockedChange.status === 409);

    // Shadow: no writes.
    await api('PATCH', '/api/settings', { mode: 'shadow', cap: 10 });
    const commitsBefore = fake.state.commits.length;
    const tagsBefore = fake.state.tags.length;
    fake.addOrder({ id: 2001, createdAt });
    await webhook(2001);
    await waitFor(async () => (await api('GET', '/api/status')).json.counts.shadow.won === 1);
    check('shadow win recorded with no Shopify writes', fake.state.commits.length === commitsBefore && fake.state.tags.length === tagsBefore);

    // Backfill: an order whose webhook never arrived.
    await api('PATCH', '/api/settings', { mode: 'live' });
    fake.addOrder({ id: 3001, createdAt });
    const report = await api('POST', '/api/orders/check', { order: '#3001' });
    check('check-an-order reports eligible', report.json?.eligible === true, report.json?.reason || '');

    // Off: nothing stored.
    await api('PATCH', '/api/settings', { mode: 'off' });
    fake.addOrder({ id: 4001, createdAt });
    await webhook(4001);
    await sleep(500);
    check('mode off: order not stored', (await api('GET', '/api/orders?q=4001')).json.total === 0);

    const events = (await api('GET', '/api/events?limit=100')).json.items;
    check('audit log has the settings changes by E2E', events.some((e) => e.type === 'settings_changed' && e.actor === 'E2E'));
    check('dashboard page is served', (await fetch(`${base}/`)).status === 200);
  } finally {
    app.kill('SIGTERM');
    await new Promise((r) => app.on('exit', r));
    fake.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    check('app shut down cleanly', /"stopped"/.test(appLog));
  }
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${results.length} checks passed`);
  if (failed) console.log('\n--- app log (tail) ---\n' + appLog.split('\n').slice(-40).join('\n'));
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
