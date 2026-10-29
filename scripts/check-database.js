#!/usr/bin/env node
'use strict';

// Checks the database in DATABASE_URL / DATABASE_AUTH_TOKEN (e.g. your Turso database) before a deploy:
// connects, creates the tables if they are missing, writes and deletes one test value, and measures the
// round-trip time. It does not touch orders, settings or events.
//
//   DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... node scripts/check-database.js
//   (or put both in .env and run: node --env-file=.env scripts/check-database.js)

const { Store } = require('../src/store');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL (and DATABASE_AUTH_TOKEN for Turso).'); process.exit(2); }
  const shown = url.split('?')[0];
  const t0 = Date.now();
  const store = await Store.open(url, { authToken: process.env.DATABASE_AUTH_TOKEN });
  console.log(`connected to ${shown} and checked the tables in ${Date.now() - t0} ms`);

  const key = `__dbcheck__${Date.now()}`;
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const t = Date.now();
    await store.kvSet(key, { i });
    const back = await store.kvGet(key);
    if (!back || back.i !== i) throw new Error('read back a different value');
    times.push(Date.now() - t);
  }
  await store.client.execute({ sql: 'DELETE FROM kv WHERE key = ?', args: [key] });
  const settings = await store.getSettings();
  const counts = await store.counts();
  console.log(`write + read round trip: ${Math.min(...times)}-${Math.max(...times)} ms`);
  console.log(`current data: mode ${settings.mode}, live winners ${counts.live.won}, orders received ${counts.live.received + counts.shadow.received}`);
  await store.close();
  console.log('DATABASE OK');
})().catch((error) => { console.error(`DATABASE CHECK FAILED: ${error.message}`); process.exit(1); });
