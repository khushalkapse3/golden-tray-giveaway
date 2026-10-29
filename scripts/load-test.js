#!/usr/bin/env node
'use strict';

// Load test, all local: pushes N qualifying orders through the real engine and store (a temp file
// database), with network delay added to every database call (like a hosted Turso database) and to
// every Shopify call. Reports how fast orders are decided, whether the cap held, and the database work.
//
//   node scripts/load-test.js [--orders 8000] [--rate 25] [--cap 500] [--one-in 16] [--db-ms 40] [--shopify-ms 250] [--concurrency 6]
//
// --rate is orders arriving per second. The real day is ~8000 orders in 12 h (0.2/s); the default 25/s
// is a heavy burst, more than 100x the average, to show the headroom.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { rulesFromEnv } = require('../src/rules');
const { webhookPayload, freshOrder, fakeShopify } = require('../test/helpers');

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback);
const ORDERS = arg('--orders', 8000);
const RATE = arg('--rate', 25);
const CAP = arg('--cap', 500);
const ONE_IN = arg('--one-in', 16);
const DB_MS = arg('--db-ms', 40);
const SHOPIFY_MS = arg('--shopify-ms', 250);
const CONCURRENCY = arg('--concurrency', 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-load-'));
  const store = await Store.open(`file:${path.join(dir, 'load.db')}`, { cacheMs: 8000 });

  // Network delay + counters on every database call.
  const stats = { queries: 0, rowsReturned: 0 };
  for (const method of ['execute', 'batch']) {
    const original = store.client[method].bind(store.client);
    store.client[method] = async (...args) => {
      stats.queries += 1;
      await sleep(DB_MS);
      const result = await original(...args);
      if (result && result.rows) stats.rowsReturned += result.rows.length;
      return result;
    };
  }

  const now = new Date();
  await store.writeSettings({
    ...(await store.getSettings()), mode: 'live', oneInN: ONE_IN, cap: CAP,
    startsAt: new Date(now.getTime() - 3600000).toISOString(), endsAt: new Date(now.getTime() + 12 * 3600000).toISOString(),
    traySku: 'GT-TRAY', trayVariantId: '42',
  });

  const shopify = fakeShopify();
  for (const name of ['getOrder', 'addFreeTray', 'addTags']) {
    const original = shopify[name].bind(shopify);
    shopify[name] = async (...args) => { await sleep(SHOPIFY_MS * (name === 'addFreeTray' ? 4 : 1)); return original(...args); };
  }

  const engine = new Engine({
    store, shopify,
    config: {
      shopify: { domain: 'shop.myshopify.com', adminStoreHandle: 'shop', apiVersion: '2026-10' },
      publicUrl: '', rules: { ...rulesFromEnv({}).rules, delaySeconds: 0 }, worker: { concurrency: CONCURRENCY },
    },
    logger: { info() {}, warn() {}, error(m, d) { console.error('ERROR', m, d); } },
    instanceId: 'load',
  });
  await engine.leadershipTick();
  const timers = [setInterval(() => engine.tick({ wait: false }).catch(() => {}), 2000), setInterval(() => engine.leadershipTick().catch(() => {}), 5000)];

  console.log(`load test: ${ORDERS} orders at ${RATE}/s, 1 in ${ONE_IN}, cap ${CAP}, db +${DB_MS} ms/call, Shopify +${SHOPIFY_MS} ms/call, concurrency ${CONCURRENCY}`);
  const t0 = Date.now();
  const createdAt = new Date(now.getTime() - 1000).toISOString();
  let sent = 0;
  const receiveTimes = [];
  while (sent < ORDERS) {
    const batch = Math.min(RATE, ORDERS - sent);
    await Promise.all(Array.from({ length: batch }, async (_, i) => {
      const id = 100000 + sent + i;
      shopify.orders.set(String(id), freshOrder(id, { createdAt }));
      const started = Date.now();
      await engine.receiveWebhook(webhookPayload(id, { created_at: createdAt }));
      receiveTimes.push(Date.now() - started);
    }));
    sent += batch;
    await sleep(1000);
  }
  const arrivedAt = Date.now();

  for (;;) {
    const c = (await store.counts());
    store.invalidate();
    if (c.live.queued === 0 && c.live.awarding === 0) break;
    await sleep(1000);
  }
  await engine.idle();
  timers.forEach(clearInterval);
  const t1 = Date.now();

  store.invalidate();
  const c = (await store.counts()).live;
  const rows = await store.all('SELECT received_at, decided_at, updated_at, status FROM orders');
  const waits = rows.filter((r) => r.decided_at).map((r) => new Date(r.decided_at) - new Date(r.received_at)).sort((a, b) => a - b);
  const pct = (p) => waits[Math.min(waits.length - 1, Math.floor(p * waits.length))];
  const winners = await store.winners('live');
  const slots = winners.map((w) => w.slot).sort((a, b) => a - b);
  const gapFree = slots.every((s, i) => s === i + 1);
  receiveTimes.sort((a, b) => a - b);

  console.log(`arrivals took ${((arrivedAt - t0) / 1000).toFixed(0)} s; all decided ${((t1 - arrivedAt) / 1000).toFixed(1)} s after the last arrival`);
  console.log(`decided: won ${c.won}, lost ${c.lost}, cap_reached ${c.cap_reached}, skipped ${c.skipped}, failed ${c.failed}, still queued ${c.queued}`);
  console.log(`cap held: ${c.won <= CAP ? 'YES' : 'NO'} (${c.won} of ${CAP}) | slots 1..${slots.length} gap-free and unique: ${gapFree && new Set(slots).size === slots.length ? 'YES' : 'NO'} | Shopify edits: ${shopify.edits.length}`);
  console.log(`time from webhook to decision: median ${(pct(0.5) / 1000).toFixed(1)} s, 95% ${(pct(0.95) / 1000).toFixed(1)} s, worst ${(waits.at(-1) / 1000).toFixed(1)} s (must stay well under Linc's 10 min)`);
  console.log(`webhook handling time: median ${receiveTimes[Math.floor(receiveTimes.length / 2)]} ms, worst ${receiveTimes.at(-1)} ms (Shopify wants < 5000 ms)`);
  console.log(`database: ${stats.queries} calls (${(stats.queries / ORDERS).toFixed(1)} per order), ${stats.rowsReturned} rows returned`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = c.won <= CAP && c.queued === 0 && c.awarding === 0 && c.failed === 0 && gapFree && waits.at(-1) < 300000;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
