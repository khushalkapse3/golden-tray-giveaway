'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEngine, webhookPayload, freshOrder } = require('./helpers');
const { ShopifyError } = require('../src/shopify/client');

// Most tests: every roll wins (random → 0) and the order is ready in Shopify.
function setup(options = {}) {
  const ctx = makeEngine(options);
  ctx.receive = async (id, overrides = {}, fresh = {}) => {
    ctx.shopify.orders.set(String(id), freshOrder(id, fresh));
    return ctx.engine.receiveWebhook(webhookPayload(id, overrides));
  };
  ctx.ready = async () => { ctx.advance(61); await ctx.drain(); };
  return ctx;
}

const eventTypes = (store) => store.listEvents({ limit: 200 }).map((e) => e.type);

// --- receiving ------------------------------------------------------------------------------

test('mode off: webhooks are not stored', async () => {
  const { engine, store } = setup({ settings: { mode: 'off' } });
  const result = await engine.receiveWebhook(webhookPayload(1));
  assert.deepEqual(result, { stored: false, reason: 'campaign_off' });
  assert.equal(store.listOrders({}).total, 0);
});

test('a qualifying order is queued to run after the delay; a duplicate webhook is ignored', async () => {
  const { engine, store, receive } = setup();
  assert.deepEqual(await receive(1), { stored: true, status: 'queued', reason: null });
  const row = store.getOrder('1');
  assert.equal(row.process_after, '2026-11-06T09:01:00.000Z');
  assert.equal(row.mode, 'live');
  assert.equal(row.customer_email, 'b***@example.com');
  assert.equal(row.source, 'webhook');
  assert.deepEqual(await engine.receiveWebhook(webhookPayload(1)), { stored: false, status: 'queued', reason: 'duplicate' });
});

test('in-window bundle orders that fail a rule are stored as not_eligible; others are ignored', async () => {
  const { engine, store } = setup();
  assert.deepEqual(await engine.receiveWebhook(webhookPayload(1, { subtotal_price: '20.00' })), { stored: true, status: 'not_eligible', reason: 'subtotal_below_min' });
  assert.equal((await engine.receiveWebhook(webhookPayload(2, { line_items: [{ sku: 'OTHER', quantity: 1 }] }))).stored, false);
  assert.equal((await engine.receiveWebhook(webhookPayload(3, { created_at: '2026-11-05T09:00:00Z' }))).stored, false);
  assert.deepEqual(store.listOrders({}).items.map((o) => o.id), ['1']);
});

test('nothing runs before the delay', async () => {
  const { engine, shopify, receive, advance } = setup();
  await receive(1);
  advance(30);
  assert.equal(await engine.tick(), 0);
  assert.equal(shopify.edits.length, 0);
});

// --- rolling and winning --------------------------------------------------------------------

test('a lost roll: no Shopify calls at all', async () => {
  const { store, shopify, receive, ready, rolls } = setup({ random: () => 7 });
  await receive(1);
  await ready();
  const row = store.getOrder('1');
  assert.equal(row.status, 'lost');
  assert.equal(row.rolled, 1);
  assert.equal(row.roll_n, 20);
  assert.deepEqual(rolls, [20]);
  assert.equal(shopify.getOrderCalls, 0);
});

test('the roll uses the current 1-in-N', async () => {
  const { engine, store, receive, ready, rolls } = setup({ random: () => 1 });
  await receive(1);
  await engine.updateSettings({ oneInN: 7 }, 'test');
  await ready();
  assert.deepEqual(rolls, [7]);
  assert.equal(store.getOrder('1').roll_n, 7);
});

test('a live win adds the tray at £0, tags order and customer, and records the slot', async () => {
  const { store, shopify, receive, ready } = setup();
  await receive(1);
  await ready();
  const row = store.getOrder('1');
  assert.equal(row.status, 'won');
  assert.equal(row.slot, 1);
  assert.equal(row.tray_added_at, '2026-11-06T09:01:01.000Z');
  assert.equal(row.tag_status, 'ok');
  assert.equal(shopify.edits.length, 1);
  const edit = shopify.edits[0];
  assert.equal(edit.orderGid, 'gid://shopify/Order/1');
  assert.equal(edit.variantId, '42');
  assert.equal(edit.traySku, 'GT-TRAY');
  assert.equal(edit.discountDescription, 'Golden tray giveaway');
  assert.match(edit.staffNote, /Golden tray giveaway/);
  assert.match(edit.staffNote, /GT-TRAY/);
  assert.deepEqual(shopify.tags, [
    { resourceGid: 'gid://shopify/Order/1', tags: ['GoldenTrayNov2026'] },
    { resourceGid: 'gid://shopify/Customer/7001', tags: ['GoldenTrayNov2026'] },
  ]);
  assert.ok(eventTypes(store).includes('won'));
});

test('hard cap: with cap 2, the third winner gets cap_reached and no edit', async () => {
  const { store, shopify, engine, receive, ready } = setup();
  await engine.updateSettings({ cap: 2 }, 'test');
  for (const id of [1, 2, 3]) await receive(id);
  await ready();
  assert.deepEqual([1, 2, 3].map((id) => store.getOrder(String(id)).status), ['won', 'won', 'cap_reached']);
  assert.equal(shopify.edits.length, 2);
  assert.equal(eventTypes(store).filter((t) => t === 'cap_reached').length, 1);
});

test('hard cap holds with many awards in flight at once (slow Shopify, concurrency 8)', async () => {
  const { store, shopify, engine, receive, ready } = setup({ concurrency: 8 });
  await engine.updateSettings({ cap: 5 }, 'test');
  shopify.addFreeTrayImpl = async () => { await new Promise((r) => setTimeout(r, 5)); return { ok: true, alreadyPresent: false }; };
  for (let id = 1; id <= 40; id += 1) await receive(id);
  await ready();
  assert.equal(store.winnerCount('live'), 5);
  assert.equal(shopify.edits.length, 5);
  assert.deepEqual(store.winners('live').map((w) => w.slot), [1, 2, 3, 4, 5]);
});

test('shadow mode: rolls and counts winners with no Shopify calls, apart from the live cap', async () => {
  const { store, shopify, engine, receive, ready } = setup({ settings: { mode: 'shadow' } });
  await engine.updateSettings({ cap: 1 }, 'test');
  await receive(1);
  await receive(2);
  await ready();
  assert.deepEqual([store.getOrder('1').status, store.getOrder('2').status], ['shadow_won', 'cap_reached']);
  assert.equal(shopify.getOrderCalls, 0);
  assert.equal(shopify.edits.length, 0);
  assert.equal(shopify.tags.length, 0);
  assert.equal(store.winnerCount('live'), 0);
  assert.equal(store.counts().shadow.won, 1);
});

// --- fresh checks ----------------------------------------------------------------------------

test('a fraud tag added by linc-app after the webhook: skipped, slot freed', async () => {
  const { store, shopify, receive, ready } = setup();
  await receive(1, {}, { tags: ['Linc Queue', 'Potential Fraud'] });
  await ready();
  const row = store.getOrder('1');
  assert.deepEqual([row.status, row.reason], ['skipped', 'potential_fraud']);
  assert.equal(shopify.edits.length, 0);
  assert.equal(store.winnerCount('live', { includeAwarding: true }), 0);
});

test('already released to Linc: skipped', async () => {
  const { store, receive, ready } = setup();
  await receive(1, {}, { tags: ['Linc Auto', 'Linc'] });
  await ready();
  assert.equal(store.getOrder('1').reason, 'already_released');
});

test('not routed yet: waits (keeping its winning roll), then wins once linc-app tags it', async () => {
  const { store, shopify, receive, ready, advance, drain, rolls } = setup();
  await receive(1, {}, { tags: [] });
  await ready();
  let row = store.getOrder('1');
  assert.equal(row.status, 'queued');
  assert.equal(row.roll_won, 1);
  assert.equal(row.last_step, 'waiting:not_routed');
  assert.equal(row.wait_started_at, '2026-11-06T09:01:01.000Z');
  assert.equal(row.process_after, '2026-11-06T09:01:16.000Z');
  assert.equal(store.winnerCount('live', { includeAwarding: true }), 0, 'no slot held while waiting');
  shopify.orders.get('1').tags = ['Linc Queue'];
  advance(15);
  await drain();
  row = store.getOrder('1');
  assert.equal(row.status, 'won');
  assert.deepEqual(rolls, [20], 'rolled once only');
});

test('not routed after max wait: goes ahead anyway', async () => {
  const { store, receive, ready, advance, drain, engine } = setup();
  engine.config.rules.maxWaitSeconds = 30;
  await receive(1, {}, { tags: [] });
  await ready();
  advance(31);
  await drain();
  assert.equal(store.getOrder('1').status, 'won');
  assert.ok(eventTypes(store).includes('routing_wait_timeout'));
});

test('not paid after max wait: skipped', async () => {
  const { store, receive, ready, advance, drain, engine } = setup();
  engine.config.rules.maxWaitSeconds = 30;
  await receive(1, {}, { financialStatus: 'pending' });
  await ready();
  advance(31);
  await drain();
  assert.deepEqual([store.getOrder('1').status, store.getOrder('1').reason], ['skipped', 'not_paid']);
});

test('the order is gone from Shopify: skipped', async () => {
  const { store, shopify, receive, ready } = setup();
  await receive(1);
  shopify.orders.delete('1');
  await ready();
  assert.equal(store.getOrder('1').reason, 'order_not_found');
});

// --- failures and retries -------------------------------------------------------------------

test('a retryable failure retries with backoff, then fails after 3 attempts; the slot is freed', async () => {
  const { store, shopify, receive, ready, advance, drain } = setup();
  shopify.addFreeTrayImpl = async () => ({ ok: false, step: 'begin', retryable: true, error: 'network error' });
  await receive(1);
  await ready();
  let row = store.getOrder('1');
  assert.deepEqual([row.status, row.attempts, row.last_error], ['queued', 1, 'begin: network error']);
  assert.equal(row.process_after, '2026-11-06T09:01:31.000Z');
  assert.equal(store.winnerCount('live', { includeAwarding: true }), 0);
  advance(30); await drain();
  assert.equal(store.getOrder('1').attempts, 2);
  advance(90); await drain();
  row = store.getOrder('1');
  assert.deepEqual([row.status, row.attempts, row.reason], ['failed', 3, 'begin']);
  assert.equal(shopify.edits.length, 3);
  assert.ok(eventTypes(store).includes('award_failed'));
});

test('a non-retryable failure (e.g. the variant does not exist) fails at once', async () => {
  const { store, shopify, receive, ready } = setup();
  shopify.addFreeTrayImpl = async () => ({ ok: false, step: 'add_variant', retryable: false, error: 'The variant does not exist in the shop.' });
  await receive(1);
  await ready();
  const row = store.getOrder('1');
  assert.deepEqual([row.status, row.reason, row.attempts], ['failed', 'add_variant', 1]);
  assert.match(row.last_error, /does not exist/);
  assert.equal(store.winnerCount('live', { includeAwarding: true }), 0);
});

test('a Shopify read error before the edit is retried like any other', async () => {
  const { store, shopify, receive, ready } = setup();
  shopify.getOrderImpl = async () => { throw new ShopifyError('GoldenTrayGetOrder: Shopify HTTP 503', { code: 'HTTP_503', retryable: true }); };
  await receive(1);
  await ready();
  const row = store.getOrder('1');
  assert.deepEqual([row.status, row.attempts], ['queued', 1]);
  assert.match(row.last_error, /503/);
});

test('lost commit response: the next attempt finds the tray and counts the win without a second edit', async () => {
  const { store, shopify, receive, ready, advance, drain } = setup();
  shopify.addFreeTrayImpl = async (args) => {
    await args.beforeCommit();
    const order = shopify.orders.get('1');
    order.lineItems = [...order.lineItems, { sku: 'GT-TRAY', quantity: 1 }]; // Shopify applied it
    return { ok: false, step: 'commit', retryable: true, error: 'network error' };
  };
  await receive(1);
  await ready();
  assert.equal(store.getOrder('1').commit_attempted, 1);
  shopify.addFreeTrayImpl = null;
  advance(30);
  await drain();
  const row = store.getOrder('1');
  assert.equal(row.status, 'won');
  assert.equal(shopify.edits.length, 1, 'no second edit');
});

test('Shopify says the tray is already on the calculated order: counts as won', async () => {
  const { store, shopify, receive, ready } = setup();
  shopify.addFreeTrayImpl = async () => ({ ok: true, alreadyPresent: true });
  await receive(1);
  await ready();
  assert.equal(store.getOrder('1').status, 'won');
});

test('tag failures are retried every minute until they work', async () => {
  const { store, shopify, receive, ready, advance, drain } = setup();
  let failures = 1;
  shopify.addTagsImpl = async () => { if (failures-- > 0) throw new Error('tagsAdd: timeout'); };
  await receive(1);
  await ready();
  let row = store.getOrder('1');
  assert.deepEqual([row.status, row.tag_status, row.tag_attempts], ['won', 'failed', 1]);
  advance(61);
  await drain();
  row = store.getOrder('1');
  assert.equal(row.tag_status, 'ok');
});

test('switching off: queued orders are skipped as campaign_off', async () => {
  const { store, engine, receive, ready } = setup();
  await receive(1);
  await engine.updateSettings({ mode: 'off' }, 'test');
  await ready();
  assert.deepEqual([store.getOrder('1').status, store.getOrder('1').reason], ['skipped', 'campaign_off']);
});

test('manual retry of a failed order re-queues it, keeping its winning roll', async () => {
  const { store, shopify, engine, receive, ready, drain, rolls } = setup();
  shopify.addFreeTrayImpl = async () => ({ ok: false, step: 'add_variant', retryable: false, error: 'bad variant' });
  await receive(1);
  await ready();
  shopify.addFreeTrayImpl = null;
  await engine.retryOrder('1', 'Khushal');
  await drain();
  assert.equal(store.getOrder('1').status, 'won');
  assert.deepEqual(rolls, [20]);
  assert.ok(store.listEvents({ limit: 5 }).some((e) => e.type === 'manual_retry' && e.actor === 'Khushal'));
});

test('manual retry is refused for orders that are not failed or skipped', async () => {
  const { engine, receive, ready } = setup();
  await receive(1);
  await ready();
  await assert.rejects(engine.retryOrder('1', 'x'), (e) => e.status === 409);
  await assert.rejects(engine.retryOrder('404', 'x'), (e) => e.status === 404);
});

test('startup recovery: awards cut off by a crash go back to the queue', async () => {
  const { store, engine, receive } = setup();
  await receive(1);
  store.claim('1', 10);
  assert.equal(engine.recover(), 1);
  assert.equal(store.getOrder('1').status, 'queued');
});

// --- settings, setup, backfill ---------------------------------------------------

test('switching to live is refused when the setup check fails', async () => {
  const { engine, shopify, store } = setup({ settings: { mode: 'off' } });
  shopify.variant = { ...shopify.variant, productStatus: 'DRAFT' };
  await assert.rejects(engine.updateSettings({ mode: 'live' }, 'Khushal'), (e) => e.status === 409 && e.code === 'setup_incomplete' && e.problems.some((p) => /DRAFT/.test(p)));
  assert.equal(store.getSettings().mode, 'off');
  shopify.variant = { ...shopify.variant, productStatus: 'ACTIVE' };
  const { settings } = await engine.updateSettings({ mode: 'live' }, 'Khushal');
  assert.equal(settings.mode, 'live');
});

test('setup check: scopes, tray variant, shop, webhook', async () => {
  const { engine, shopify } = setup();
  let setup1 = await engine.setupCheck();
  assert.equal(setup1.ok, true);
  assert.equal(setup1.webhook.registered, false);
  assert.ok(setup1.checks.find((c) => c.name === 'webhook' && !c.ok && !c.blocking));

  shopify.scopes = ['read_orders'];
  shopify.variant = { ...shopify.variant, sku: 'OTHER' };
  setup1 = await engine.setupCheck();
  assert.equal(setup1.ok, false);
  assert.ok(setup1.problems.some((p) => /write_order_edits/.test(p)));
  assert.ok(setup1.problems.some((p) => /SKU/.test(p)));

  await engine.registerWebhook('Khushal');
  shopify.scopes = ['write_orders', 'write_order_edits', 'read_products', 'write_customers'];
  shopify.variant = { ...shopify.variant, sku: 'gt-tray' };
  const setup2 = await engine.setupCheck();
  assert.equal(setup2.ok, true);
  assert.equal(setup2.webhook.registered, true);
  assert.equal(setup2.webhook.uri, 'https://gt.example.com/webhooks/orders/create');
});

test('registerWebhook does not create a second subscription', async () => {
  const { engine, shopify } = setup();
  assert.equal((await engine.registerWebhook('a')).created, true);
  assert.equal((await engine.registerWebhook('a')).created, false);
  assert.equal(shopify.webhooks.length, 1);
});

test('backfill queues qualifying orders the webhook missed, once', async () => {
  const { engine, store, shopify } = setup();
  shopify.recent = [freshOrder(1), freshOrder(2, { lineItems: [{ sku: 'OTHER', quantity: 1 }] }), freshOrder(3, { createdAt: '2026-11-06T08:50:00.000Z' })];
  await engine.receiveWebhook(webhookPayload(1));
  const result = await engine.backfillTick();
  assert.deepEqual(result, { ran: true, found: 1 });
  const row = store.getOrder('3');
  assert.equal(row.source, 'backfill');
  assert.equal(row.process_after, '2026-11-06T09:00:00.000Z', 'already past its delay: runs now');
  assert.equal(store.getOrder('2'), undefined);
  assert.equal((await engine.backfillTick()).found, 0);
});

test('backfill only runs while the window is open (plus 30 min) and not when the giveaway is off', async () => {
  const { engine } = setup();
  await engine.updateSettings({ startsAt: '2026-11-07T07:00:00Z', endsAt: '2026-11-07T19:00:00Z' }, 'test');
  assert.equal((await engine.backfillTick()).ran, false, 'window has not opened');
  await engine.updateSettings({ startsAt: '2026-11-06T07:00:00Z', mode: 'off' }, 'test');
  assert.equal((await engine.backfillTick()).ran, false, 'off');
});

test('rules the dashboard can not change: PATCH refuses them, and status shows them read-only', async () => {
  const { engine } = setup();
  for (const field of ['delaySeconds', 'maxWaitSeconds', 'routedTags', 'releasedTags', 'backfill', 'autoPace']) {
    await assert.rejects(engine.updateSettings({ [field]: 5 }, 'x'), (e) => e.status === 400 && e.field === field);
  }
  const status = engine.status();
  assert.deepEqual(Object.keys(status.rules).sort(), ['delaySeconds', 'maxWaitSeconds', 'releasedTags', 'routedTags']);
  assert.equal(status.rules.delaySeconds, 60);
  for (const field of ['delaySeconds', 'maxWaitSeconds', 'routedTags', 'releasedTags']) assert.equal(field in status.settings, false);
  assert.equal('autoPace' in status.pacing, false);
});

test('setup check: without PUBLIC_URL the webhook line is informational, not a failure', async () => {
  const { engine } = makeEngine({ publicUrl: '' });
  const result = await engine.setupCheck();
  const line = result.checks.find((c) => c.name === 'webhook');
  assert.equal(line.ok, true);
  assert.equal(line.blocking, false);
  assert.match(line.detail, /Shopify admin/);
  assert.match(line.detail, /backfill/i);
  assert.equal(result.ok, true);
});

test('checkOrder runs every check without rolling or writing', async () => {
  const { engine, shopify, rolls } = setup();
  shopify.orders.set('1', freshOrder(1, { currentSubtotal: 20, subtotal: 20 }));
  const report = await engine.checkOrder('#1');
  assert.equal(report.eligible, false);
  assert.ok(report.checks.some((c) => c.name === 'min_subtotal' && !c.ok));
  assert.equal(report.stored, null);
  assert.deepEqual(rolls, []);
  assert.equal(shopify.edits.length, 0);
  await assert.rejects(engine.checkOrder('#999'), (e) => e.status === 404);
});

test('status: counts, window, pacing, traysLeft for the active mode', async () => {
  const { engine, receive, ready } = setup();
  await receive(1);
  await ready();
  const status = engine.status();
  assert.equal(status.activeMode, 'live');
  assert.equal(status.counts.live.won, 1);
  assert.equal(status.traysLeft, 499);
  assert.equal(status.window.state, 'open');
  assert.equal(status.pacing.oneInN, 20);
  assert.equal(status.shopify.adminOrdersUrl, 'https://admin.shopify.com/store/shop/orders/');
  assert.deepEqual(status.lockedWhileLive.includes('traySku'), true);
});

test('reset: shadow any time; all only when not live', async () => {
  const { engine, receive, store } = setup({ settings: { mode: 'shadow' } });
  await receive(1);
  assert.equal((await engine.reset('shadow', 'RESET', 'x')).deleted, 1);
  await assert.rejects(engine.reset('all', 'nope', 'x'), (e) => e.status === 400);
  await engine.updateSettings({ mode: 'live' }, 'x');
  await assert.rejects(engine.reset('all', 'RESET', 'x'), (e) => e.status === 409);
  await engine.updateSettings({ mode: 'off' }, 'x');
  assert.equal((await engine.reset('all', 'RESET', 'x')).ok, true);
  assert.ok(store.listEvents({ limit: 1 })[0].type === 'reset');
});
