'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { DEFAULTS } = require('../src/settings');

const NOW = '2026-11-06T09:00:00.000Z';

function row(id, overrides = {}) {
  return {
    id: String(id), gid: `gid://shopify/Order/${id}`, name: `#${id}`, number: Number(id),
    created_at: NOW, received_at: NOW, source: 'webhook', subtotal: 54, currency: 'GBP',
    customer_id: '7', customer_gid: 'gid://shopify/Customer/7', customer_email: 'j***@example.com', country: 'GB',
    status: 'queued', reason: null, mode: 'live', process_after: NOW,
    ...overrides,
  };
}

const memory = (options = {}) => Store.open(':memory:', { seed: { traySku: 'GT-TRAY', trayVariantId: '42' }, ...options });

test('first boot seeds settings from defaults + env seed; later boots keep saved settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
  const url = `file:${path.join(dir, 'gt.db')}`;
  const a = await Store.open(url, { seed: { traySku: 'GT-TRAY', trayVariantId: '42' } });
  assert.equal((await a.getSettings()).traySku, 'GT-TRAY');
  assert.equal((await a.getSettings()).mode, 'off');
  await a.saveSettings({ ...(await a.getSettings()), oneInN: 7 }, { actor: 'test', changed: ['oneInN'] });
  await a.close();
  const b = await Store.open(url, { seed: { traySku: 'OTHER', trayVariantId: '1' } });
  assert.equal((await b.getSettings()).oneInN, 7);
  assert.equal((await b.getSettings()).traySku, 'GT-TRAY');
  await b.close();
});

test('settings added in a later version get their default', async () => {
  const store = await memory();
  await store.client.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: ['discountDescription'] });
  store.invalidate();
  assert.equal((await store.getSettings()).discountDescription, DEFAULTS.discountDescription);
});

test('saving settings records an audit event with the actor and the changes', async () => {
  const store = await memory();
  const current = await store.getSettings();
  await store.saveSettings({ ...current, oneInN: 9 }, { actor: 'Khushal', changed: ['oneInN'], previous: current });
  const [event] = (await store.listEvents({ limit: 1 }));
  assert.equal(event.type, 'settings_changed');
  assert.equal(event.actor, 'Khushal');
  assert.match(event.message, /oneInN: 20 → 9/);
});

test('insertOrder ignores duplicates (same order id twice)', async () => {
  const store = await memory();
  assert.equal((await store.insertOrder(row(1))), true);
  assert.equal((await store.insertOrder(row(1, { status: 'not_eligible' }))), false);
  assert.equal((await store.getOrder('1')).status, 'queued');
});

test('dueOrders returns queued rows whose time has come, oldest first, skipping in-flight ids', async () => {
  const store = await memory();
  (await store.insertOrder(row(1, { process_after: '2026-11-06T09:00:02.000Z' })));
  (await store.insertOrder(row(2, { process_after: '2026-11-06T08:59:00.000Z' })));
  (await store.insertOrder(row(3, { process_after: '2026-11-06T10:00:00.000Z' })));
  (await store.insertOrder(row(4, { status: 'lost' })));
  const due = (await store.dueOrders('2026-11-06T09:00:05.000Z', 10, new Set(['1'])));
  assert.deepEqual(due.map((r) => r.id), ['2']);
});

test('claim respects the cap, counting awarding and won rows', async () => {
  const store = await memory();
  for (const id of [1, 2, 3]) (await store.insertOrder(row(id)));
  assert.equal((await store.claim('1', 2)), true);
  assert.equal((await store.getOrder('1')).status, 'awarding');
  assert.equal((await store.claim('2', 2)), true);
  assert.equal((await store.claim('3', 2)), false);
  (await store.updateOrder('2', { status: 'queued' })); // slot released
  assert.equal((await store.claim('3', 2)), true);
});

test('claim never goes over the cap across many attempts', async () => {
  const store = await memory();
  for (let id = 1; id <= 200; id += 1) (await store.insertOrder(row(id)));
  let claimed = 0;
  for (let id = 1; id <= 200; id += 1) if ((await store.claim(String(id), 50))) claimed += 1;
  assert.equal(claimed, 50);
  assert.equal((await store.winnerCount('live', { includeAwarding: true })), 50);
});

test('markWon gives increasing slots per mode and sets the tray time', async () => {
  const store = await memory();
  for (const id of [1, 2]) { (await store.insertOrder(row(id))); (await store.claim(String(id), 10)); }
  (await store.insertOrder(row(3, { mode: 'shadow' })));
  assert.equal((await store.markWon('1', 'live', NOW)), 1);
  assert.equal((await store.markWon('2', 'live', NOW)), 2);
  assert.equal((await store.markWon('3', 'shadow', NOW)), 1);
  assert.equal((await store.getOrder('2')).status, 'won');
  assert.equal((await store.getOrder('3')).status, 'shadow_won');
  assert.equal((await store.getOrder('1')).tray_added_at, NOW);
  assert.equal((await store.getOrder('1')).tag_status, 'pending');
  assert.equal((await store.getOrder('3')).tag_status, null);
});

test('counts per mode, including eligible (rolled) and tag failures', async () => {
  const store = await memory();
  (await store.insertOrder(row(1, { status: 'lost', rolled: 1 })));
  (await store.insertOrder(row(2, { status: 'won', rolled: 1, tag_status: 'failed' })));
  (await store.insertOrder(row(3, { status: 'not_eligible' })));
  (await store.insertOrder(row(4, { status: 'queued' })));
  (await store.insertOrder(row(5, { status: 'shadow_won', mode: 'shadow', rolled: 1 })));
  const counts = (await store.counts());
  assert.equal(counts.live.received, 4);
  assert.equal(counts.live.eligible, 2);
  assert.equal(counts.live.lost, 1);
  assert.equal(counts.live.won, 1);
  assert.equal(counts.live.queued, 1);
  assert.equal(counts.live.not_eligible, 1);
  assert.equal(counts.live.tag_failed, 1);
  assert.equal(counts.live.failed, 0);
  assert.equal(counts.shadow.won, 1);
  assert.equal(counts.shadow.received, 1);
});

test('candidateCount counts every row in the window except not_eligible', async () => {
  const store = await memory();
  (await store.insertOrder(row(1, { status: 'lost' })));
  (await store.insertOrder(row(2, { status: 'not_eligible' })));
  (await store.insertOrder(row(3, { status: 'queued', mode: 'shadow' })));
  (await store.insertOrder(row(4, { status: 'lost', created_at: '2026-11-05T09:00:00.000Z' })));
  assert.equal((await store.candidateCount(DEFAULTS)), 2);
});

test('listOrders filters by status, mode and search, newest first, with a total', async () => {
  const store = await memory();
  (await store.insertOrder(row(1, { status: 'lost', received_at: '2026-11-06T09:00:01.000Z' })));
  (await store.insertOrder(row(2, { status: 'won', received_at: '2026-11-06T09:00:02.000Z', customer_email: 'k***@shop.com' })));
  (await store.insertOrder(row(3, { status: 'won', mode: 'shadow', received_at: '2026-11-06T09:00:03.000Z' })));
  assert.deepEqual((await store.listOrders({})).items.map((o) => o.id), ['3', '2', '1']);
  assert.equal((await store.listOrders({ status: 'won', mode: 'live' })).total, 1);
  assert.deepEqual((await store.listOrders({ q: 'shop.com' })).items.map((o) => o.id), ['2']);
  assert.deepEqual((await store.listOrders({ q: '#1' })).items.map((o) => o.id), ['1']);
  const page = (await store.listOrders({ limit: 1, offset: 1 }));
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((o) => o.id), ['2']);
});

test('winners are sorted by slot', async () => {
  const store = await memory();
  for (const id of [5, 6]) { (await store.insertOrder(row(id))); (await store.claim(String(id), 10)); }
  (await store.markWon('6', 'live', NOW));
  (await store.markWon('5', 'live', NOW));
  assert.deepEqual((await store.winners('live')).map((o) => [o.id, o.slot]), [['6', 1], ['5', 2]]);
});

test('tagRetriesDue picks failed tags whose next try is due and under 5 attempts', async () => {
  const store = await memory();
  (await store.insertOrder(row(1, { status: 'won', tag_status: 'failed', tag_attempts: 1, tag_next_at: '2026-11-06T08:00:00.000Z' })));
  (await store.insertOrder(row(2, { status: 'won', tag_status: 'failed', tag_attempts: 5, tag_next_at: '2026-11-06T08:00:00.000Z' })));
  (await store.insertOrder(row(3, { status: 'won', tag_status: 'failed', tag_attempts: 1, tag_next_at: '2026-11-06T10:00:00.000Z' })));
  (await store.insertOrder(row(4, { status: 'won', tag_status: 'pending', tag_next_at: '2026-11-06T08:00:00.000Z' })));
  assert.deepEqual((await store.tagRetriesDue(NOW)).map((r) => r.id), ['1', '4']);
});

test('recoverAwarding puts rows left mid-award back in the queue', async () => {
  const store = await memory();
  (await store.insertOrder(row(1)));
  (await store.claim('1', 5));
  assert.equal((await store.recoverAwarding(NOW)), 1);
  assert.equal((await store.getOrder('1')).status, 'queued');
});

test('events: newest first, paged with before=<id>', async () => {
  const store = await memory();
  for (let i = 1; i <= 5; i += 1) (await store.addEvent({ type: 'x', message: `m${i}` }));
  const first = (await store.listEvents({ limit: 2 }));
  assert.deepEqual(first.map((e) => e.message), ['m5', 'm4']);
  assert.deepEqual((await store.listEvents({ limit: 2, before: first[1].id })).map((e) => e.message), ['m3', 'm2']);
});

test('reset shadow deletes only shadow rows; reset all deletes every order', async () => {
  const store = await memory();
  (await store.insertOrder(row(1)));
  (await store.insertOrder(row(2, { mode: 'shadow' })));
  assert.equal((await store.reset('shadow')), 1);
  assert.equal((await store.getOrder('1')).id, '1');
  assert.equal((await store.reset('all')), 1);
  assert.equal((await store.getOrder('1')), undefined);
});

test('kv round-trips JSON', async () => {
  const store = await memory();
  (await store.kvSet('setup', { ok: true, n: 1 }));
  assert.deepEqual((await store.kvGet('setup')), { ok: true, n: 1 });
  assert.equal((await store.kvGet('missing')), null);
});

// --- new with the hosted database ----------------------------------------------------------------

test('open accepts file: and :memory: URLs and refuses a missing or unsupported one clearly', async () => {
  await assert.rejects(Store.open(''), /DATABASE_URL/);
  await assert.rejects(Store.open('postgres://x/y'), /file:|libsql:/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
  const store = await Store.open(`file:${path.join(dir, 'a', 'b', 'x.db')}`);
  assert.equal(await store.insertOrder(row(1)), true, 'creates the folder when it does not exist');
  await store.close();
});

test('claim is exact under many simultaneous calls: never more than the cap, no matter how they interleave', async () => {
  const store = await memory();
  for (let id = 1; id <= 300; id += 1) await store.insertOrder(row(id));
  const results = await Promise.all(Array.from({ length: 300 }, (_, i) => store.claim(String(i + 1), 40)));
  assert.equal(results.filter(Boolean).length, 40);
  assert.equal(await store.winnerCount('live', { includeAwarding: true }), 40);
});

test('markWon hands out distinct, gap-free slots when called at the same time', async () => {
  const store = await memory();
  for (let id = 1; id <= 25; id += 1) { await store.insertOrder(row(id)); await store.claim(String(id), 100); }
  const slots = await Promise.all(Array.from({ length: 25 }, (_, i) => store.markWon(String(i + 1), 'live', NOW)));
  assert.deepEqual([...slots].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('claim of an order that is not queued (already claimed or decided) fails and takes no slot', async () => {
  const store = await memory();
  await store.insertOrder(row(1));
  assert.equal(await store.claim('1', 5), true);
  assert.equal(await store.claim('1', 5), false, 'second claim of the same order');
  await store.insertOrder(row(2, { status: 'lost' }));
  assert.equal(await store.claim('2', 5), false);
  assert.equal(await store.winnerCount('live', { includeAwarding: true }), 1);
});

test('settings are cached in memory and the cache is dropped on save', async () => {
  const store = await memory();
  const first = await store.getSettings();
  await store.client.execute({ sql: 'UPDATE settings SET value = ? WHERE key = ?', args: [JSON.stringify(99), 'oneInN'] });
  assert.equal((await store.getSettings()).oneInN, first.oneInN, 'a second read does not go to the database');
  await store.saveSettings({ ...first, oneInN: 7 }, { actor: 't', changed: ['oneInN'] });
  assert.equal((await store.getSettings()).oneInN, 7);
});

test('a returned settings object can be changed without corrupting the cache', async () => {
  const store = await memory();
  const a = await store.getSettings();
  a.qualifyingSkus.push('HACK');
  a.oneInN = 1;
  const b = await store.getSettings();
  assert.deepEqual(b.qualifyingSkus, DEFAULTS.qualifyingSkus);
  assert.equal(b.oneInN, DEFAULTS.oneInN);
});

test('heavy read queries are cached for cacheMs (so the dashboard does not re-read every row), and dropped by reset', async () => {
  const store = await memory({ cacheMs: 60000 });
  await store.insertOrder(row(1, { status: 'lost', rolled: 1 }));
  assert.equal((await store.counts()).live.lost, 1);
  assert.equal(await store.candidateCount(DEFAULTS), 1);
  await store.insertOrder(row(2, { status: 'lost', rolled: 1 }));
  assert.equal((await store.counts()).live.lost, 1, 'still the cached answer');
  assert.equal(await store.candidateCount(DEFAULTS), 1, 'candidateCount cached too');
  await store.reset('all');
  assert.equal((await store.counts()).live.lost, 0, 'reset drops the cache');
});

test('with cacheMs 0 (default) every read is fresh', async () => {
  const store = await memory();
  await store.insertOrder(row(1, { status: 'lost', rolled: 1 }));
  assert.equal((await store.counts()).live.lost, 1);
  await store.insertOrder(row(2, { status: 'lost', rolled: 1 }));
  assert.equal((await store.counts()).live.lost, 2);
});

test('a stale cache never hides a win: winnerCount, claim and dueOrders are never cached', async () => {
  const store = await memory({ cacheMs: 60000 });
  await store.insertOrder(row(1));
  assert.equal(await store.winnerCount('live', { includeAwarding: true }), 0);
  await store.claim('1', 5);
  assert.equal(await store.winnerCount('live', { includeAwarding: true }), 1);
  await store.insertOrder(row(2, { process_after: '2026-11-06T08:00:00.000Z' }));
  assert.deepEqual((await store.dueOrders('2026-11-06T09:00:00.000Z', 10)).map((r) => r.id), ['2']);
});

test('events and orders survive close and reopen of a file database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
  const url = `file:${path.join(dir, 'gt.db')}`;
  const a = await Store.open(url);
  await a.insertOrder(row(1, { status: 'won', rolled: 1 }));
  await a.addEvent({ type: 'x', message: 'hello' });
  await a.close();
  const b = await Store.open(url);
  assert.equal((await b.getOrder('1')).status, 'won');
  assert.equal((await b.listEvents({ limit: 1 }))[0].message, 'hello');
  await b.close();
});

// --- leader lease: only one running copy of the app processes orders (zero-downtime deploys overlap two) ---

test('lease: first holder gets it, can renew it, others are refused while it is valid', async () => {
  const store = await memory();
  assert.equal(await store.acquireLease('worker', 'A', 20000, 1000), true);
  assert.equal(await store.acquireLease('worker', 'A', 20000, 5000), true, 'renew');
  assert.equal(await store.acquireLease('worker', 'B', 20000, 6000), false, 'B is refused while A holds it');
  assert.equal(await store.acquireLease('worker', 'A', 20000, 7000), true);
});

test('lease: expires when not renewed, then another holder takes over (and the old one is refused)', async () => {
  const store = await memory();
  await store.acquireLease('worker', 'A', 20000, 1000); // valid until 21000
  assert.equal(await store.acquireLease('worker', 'B', 20000, 21000), false, 'exactly at expiry is still A');
  assert.equal(await store.acquireLease('worker', 'B', 20000, 21001), true);
  assert.equal(await store.acquireLease('worker', 'A', 20000, 22000), false);
});

test('lease: release hands it over at once, and only the holder can release', async () => {
  const store = await memory();
  await store.acquireLease('worker', 'A', 20000, 1000);
  assert.equal(await store.releaseLease('worker', 'B'), false, 'not the holder: nothing happens');
  assert.equal(await store.acquireLease('worker', 'B', 20000, 2000), false);
  assert.equal(await store.releaseLease('worker', 'A'), true);
  assert.equal(await store.acquireLease('worker', 'B', 20000, 2000), true, 'no waiting for expiry after a clean release');
});

test('lease: two copies racing for it at the same moment: exactly one wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
  const url = `file:${path.join(dir, 'lease.db')}`;
  const a = await Store.open(url);
  const b = await Store.open(url);
  const results = await Promise.all([a.acquireLease('worker', 'A', 20000, 1000), b.acquireLease('worker', 'B', 20000, 1000)]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  await a.close();
  await b.close();
});

test('lease names are independent', async () => {
  const store = await memory();
  assert.equal(await store.acquireLease('x', 'A', 20000, 1000), true);
  assert.equal(await store.acquireLease('y', 'B', 20000, 1000), true);
});

test('winShadow: takes the next shadow slot only while under the cap, atomically, for a queued order', async () => {
  const store = await memory();
  for (let id = 1; id <= 60; id += 1) await store.insertOrder(row(id, { mode: 'shadow' }));
  const slots = await Promise.all(Array.from({ length: 60 }, (_, i) => store.winShadow(String(i + 1), 25, NOW)));
  const won = slots.filter((s) => s !== null).sort((a, b) => a - b);
  assert.deepEqual(won, Array.from({ length: 25 }, (_, i) => i + 1), 'exactly 25, slots 1..25 with no gaps or repeats');
  assert.equal(await store.winnerCount('shadow'), 25);
  assert.equal((await store.getOrder('1')).tag_status, null, 'shadow winners are never tagged');
});

test('winShadow refuses an order that is not queued', async () => {
  const store = await memory();
  await store.insertOrder(row(1, { mode: 'shadow', status: 'lost' }));
  assert.equal(await store.winShadow('1', 5, NOW), null);
});
