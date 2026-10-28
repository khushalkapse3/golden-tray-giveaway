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

const memory = () => new Store(':memory:', { seed: { traySku: 'GT-TRAY', trayVariantId: '42' } });

test('first boot seeds settings from defaults + env seed; later boots keep saved settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
  const file = path.join(dir, 'gt.db');
  const a = new Store(file, { seed: { traySku: 'GT-TRAY', trayVariantId: '42' } });
  assert.equal(a.getSettings().traySku, 'GT-TRAY');
  assert.equal(a.getSettings().mode, 'off');
  a.saveSettings({ ...a.getSettings(), oneInN: 7 }, { actor: 'test', changed: ['oneInN'] });
  a.close();
  const b = new Store(file, { seed: { traySku: 'OTHER', trayVariantId: '1' } });
  assert.equal(b.getSettings().oneInN, 7);
  assert.equal(b.getSettings().traySku, 'GT-TRAY');
  b.close();
});

test('settings added in a later version get their default', () => {
  const store = memory();
  store.db.prepare('DELETE FROM settings WHERE key = ?').run('discountDescription');
  assert.equal(store.getSettings().discountDescription, DEFAULTS.discountDescription);
});

test('saving settings records an audit event with the actor and the changes', () => {
  const store = memory();
  store.saveSettings({ ...store.getSettings(), oneInN: 9 }, { actor: 'Khushal', changed: ['oneInN'], previous: store.getSettings() });
  const [event] = store.listEvents({ limit: 1 });
  assert.equal(event.type, 'settings_changed');
  assert.equal(event.actor, 'Khushal');
  assert.match(event.message, /oneInN: 20 → 9/);
});

test('insertOrder ignores duplicates (same order id twice)', () => {
  const store = memory();
  assert.equal(store.insertOrder(row(1)), true);
  assert.equal(store.insertOrder(row(1, { status: 'not_eligible' })), false);
  assert.equal(store.getOrder('1').status, 'queued');
});

test('dueOrders returns queued rows whose time has come, oldest first, skipping in-flight ids', () => {
  const store = memory();
  store.insertOrder(row(1, { process_after: '2026-11-06T09:00:02.000Z' }));
  store.insertOrder(row(2, { process_after: '2026-11-06T08:59:00.000Z' }));
  store.insertOrder(row(3, { process_after: '2026-11-06T10:00:00.000Z' }));
  store.insertOrder(row(4, { status: 'lost' }));
  const due = store.dueOrders('2026-11-06T09:00:05.000Z', 10, new Set(['1']));
  assert.deepEqual(due.map((r) => r.id), ['2']);
});

test('claim respects the cap, counting awarding and won rows', () => {
  const store = memory();
  for (const id of [1, 2, 3]) store.insertOrder(row(id));
  assert.equal(store.claim('1', 2), true);
  assert.equal(store.getOrder('1').status, 'awarding');
  assert.equal(store.claim('2', 2), true);
  assert.equal(store.claim('3', 2), false);
  store.updateOrder('2', { status: 'queued' }); // slot released
  assert.equal(store.claim('3', 2), true);
});

test('claim never goes over the cap across many attempts', () => {
  const store = memory();
  for (let id = 1; id <= 200; id += 1) store.insertOrder(row(id));
  let claimed = 0;
  for (let id = 1; id <= 200; id += 1) if (store.claim(String(id), 50)) claimed += 1;
  assert.equal(claimed, 50);
  assert.equal(store.winnerCount('live', { includeAwarding: true }), 50);
});

test('markWon gives increasing slots per mode and sets the tray time', () => {
  const store = memory();
  for (const id of [1, 2]) { store.insertOrder(row(id)); store.claim(String(id), 10); }
  store.insertOrder(row(3, { mode: 'shadow' }));
  assert.equal(store.markWon('1', 'live', NOW), 1);
  assert.equal(store.markWon('2', 'live', NOW), 2);
  assert.equal(store.markWon('3', 'shadow', NOW), 1);
  assert.equal(store.getOrder('2').status, 'won');
  assert.equal(store.getOrder('3').status, 'shadow_won');
  assert.equal(store.getOrder('1').tray_added_at, NOW);
  assert.equal(store.getOrder('1').tag_status, 'pending');
  assert.equal(store.getOrder('3').tag_status, null);
});

test('counts per mode, including eligible (rolled) and tag failures', () => {
  const store = memory();
  store.insertOrder(row(1, { status: 'lost', rolled: 1 }));
  store.insertOrder(row(2, { status: 'won', rolled: 1, tag_status: 'failed' }));
  store.insertOrder(row(3, { status: 'not_eligible' }));
  store.insertOrder(row(4, { status: 'queued' }));
  store.insertOrder(row(5, { status: 'shadow_won', mode: 'shadow', rolled: 1 }));
  const counts = store.counts();
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

test('candidateCount counts every row in the window except not_eligible', () => {
  const store = memory();
  store.insertOrder(row(1, { status: 'lost' }));
  store.insertOrder(row(2, { status: 'not_eligible' }));
  store.insertOrder(row(3, { status: 'queued', mode: 'shadow' }));
  store.insertOrder(row(4, { status: 'lost', created_at: '2026-11-05T09:00:00.000Z' }));
  assert.equal(store.candidateCount(DEFAULTS), 2);
});

test('listOrders filters by status, mode and search, newest first, with a total', () => {
  const store = memory();
  store.insertOrder(row(1, { status: 'lost', received_at: '2026-11-06T09:00:01.000Z' }));
  store.insertOrder(row(2, { status: 'won', received_at: '2026-11-06T09:00:02.000Z', customer_email: 'k***@shop.com' }));
  store.insertOrder(row(3, { status: 'won', mode: 'shadow', received_at: '2026-11-06T09:00:03.000Z' }));
  assert.deepEqual(store.listOrders({}).items.map((o) => o.id), ['3', '2', '1']);
  assert.equal(store.listOrders({ status: 'won', mode: 'live' }).total, 1);
  assert.deepEqual(store.listOrders({ q: 'shop.com' }).items.map((o) => o.id), ['2']);
  assert.deepEqual(store.listOrders({ q: '#1' }).items.map((o) => o.id), ['1']);
  const page = store.listOrders({ limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((o) => o.id), ['2']);
});

test('winners are sorted by slot', () => {
  const store = memory();
  for (const id of [5, 6]) { store.insertOrder(row(id)); store.claim(String(id), 10); }
  store.markWon('6', 'live', NOW);
  store.markWon('5', 'live', NOW);
  assert.deepEqual(store.winners('live').map((o) => [o.id, o.slot]), [['6', 1], ['5', 2]]);
});

test('tagRetriesDue picks failed tags whose next try is due and under 5 attempts', () => {
  const store = memory();
  store.insertOrder(row(1, { status: 'won', tag_status: 'failed', tag_attempts: 1, tag_next_at: '2026-11-06T08:00:00.000Z' }));
  store.insertOrder(row(2, { status: 'won', tag_status: 'failed', tag_attempts: 5, tag_next_at: '2026-11-06T08:00:00.000Z' }));
  store.insertOrder(row(3, { status: 'won', tag_status: 'failed', tag_attempts: 1, tag_next_at: '2026-11-06T10:00:00.000Z' }));
  store.insertOrder(row(4, { status: 'won', tag_status: 'pending', tag_next_at: '2026-11-06T08:00:00.000Z' }));
  assert.deepEqual(store.tagRetriesDue(NOW).map((r) => r.id), ['1', '4']);
});

test('recoverAwarding puts rows left mid-award back in the queue', () => {
  const store = memory();
  store.insertOrder(row(1));
  store.claim('1', 5);
  assert.equal(store.recoverAwarding(NOW), 1);
  assert.equal(store.getOrder('1').status, 'queued');
});

test('events: newest first, paged with before=<id>', () => {
  const store = memory();
  for (let i = 1; i <= 5; i += 1) store.addEvent({ type: 'x', message: `m${i}` });
  const first = store.listEvents({ limit: 2 });
  assert.deepEqual(first.map((e) => e.message), ['m5', 'm4']);
  assert.deepEqual(store.listEvents({ limit: 2, before: first[1].id }).map((e) => e.message), ['m3', 'm2']);
});

test('reset shadow deletes only shadow rows; reset all deletes every order', () => {
  const store = memory();
  store.insertOrder(row(1));
  store.insertOrder(row(2, { mode: 'shadow' }));
  assert.equal(store.reset('shadow'), 1);
  assert.equal(store.getOrder('1').id, '1');
  assert.equal(store.reset('all'), 1);
  assert.equal(store.getOrder('1'), undefined);
});

test('kv round-trips JSON', () => {
  const store = memory();
  store.kvSet('setup', { ok: true, n: 1 });
  assert.deepEqual(store.kvGet('setup'), { ok: true, n: 1 });
  assert.equal(store.kvGet('missing'), null);
});
