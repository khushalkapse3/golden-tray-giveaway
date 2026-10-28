'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShopifyOps } = require('../src/shopify/operations');
const { ShopifyError } = require('../src/shopify/client');
const DOCS = require('../src/shopify/documents');

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async request(query, variables, opts) {
      calls.push({ operation: opts.operation, variables, mutation: Boolean(opts.mutation), query });
      const handler = handlers[opts.operation];
      if (!handler) throw new Error(`unexpected operation ${opts.operation}`);
      return handler(variables, calls.length);
    },
  };
}

const ok = (payload) => ({ ...payload, userErrors: [] });
const editHandlers = (overrides = {}) => ({
  GoldenTrayEditBegin: () => ({ orderEditBegin: ok({ calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1', lineItems: { nodes: [{ id: 'cli1', sku: 'FG1527d_V1', quantity: 2 }] } } }) }),
  GoldenTrayEditAddVariant: () => ({ orderEditAddVariant: ok({ calculatedLineItem: { id: 'gid://shopify/CalculatedLineItem/9' } }) }),
  GoldenTrayEditAddDiscount: () => ({ orderEditAddLineItemDiscount: ok({ calculatedLineItem: { id: 'gid://shopify/CalculatedLineItem/9' } }) }),
  GoldenTrayEditCommit: () => ({ orderEditCommit: ok({ order: { id: 'gid://shopify/Order/5', name: '#5' } }) }),
  ...overrides,
});
const trayArgs = (extra = {}) => ({
  orderGid: 'gid://shopify/Order/5', variantId: '42', traySku: 'GT-TRAY',
  discountDescription: 'Golden tray giveaway', staffNote: 'note', ...extra,
});

test('every document names itself with the operation name used by the client', () => {
  for (const [name, text] of Object.entries(DOCS)) {
    assert.match(text, new RegExp(`(query|mutation) ${name}\\b`), name);
  }
});

test('addFreeTray: begin → add variant → 100% discount → commit without customer email', async () => {
  const client = fakeClient(editHandlers());
  let beforeCommitCalls = 0;
  const result = await new ShopifyOps(client).addFreeTray(trayArgs({ beforeCommit: () => { beforeCommitCalls += 1; } }));
  assert.deepEqual(result, { ok: true, alreadyPresent: false, orderName: '#5' });
  assert.deepEqual(client.calls.map((c) => c.operation), ['GoldenTrayEditBegin', 'GoldenTrayEditAddVariant', 'GoldenTrayEditAddDiscount', 'GoldenTrayEditCommit']);
  assert.ok(client.calls.every((c) => c.mutation));
  assert.deepEqual(client.calls[1].variables, { id: 'gid://shopify/CalculatedOrder/1', variantId: 'gid://shopify/ProductVariant/42', quantity: 1 });
  assert.deepEqual(client.calls[2].variables.discount, { percentValue: 100, description: 'Golden tray giveaway' });
  assert.equal(client.calls[2].variables.lineItemId, 'gid://shopify/CalculatedLineItem/9');
  assert.deepEqual(client.calls[3].variables, { id: 'gid://shopify/CalculatedOrder/1', notifyCustomer: false, staffNote: 'note' });
  assert.equal(beforeCommitCalls, 1);
});

test('addFreeTray: tray already on the calculated order → alreadyPresent, nothing committed', async () => {
  const client = fakeClient(editHandlers({
    GoldenTrayEditBegin: () => ({ orderEditBegin: ok({ calculatedOrder: { id: 'co', lineItems: { nodes: [{ id: 'a', sku: 'gt-tray', quantity: 1 }] } } }) }),
  }));
  const result = await new ShopifyOps(client).addFreeTray(trayArgs());
  assert.deepEqual(result, { ok: true, alreadyPresent: true });
  assert.deepEqual(client.calls.map((c) => c.operation), ['GoldenTrayEditBegin']);
});

test('addFreeTray: a removed tray line (quantity 0) does not count as present', async () => {
  const client = fakeClient(editHandlers({
    GoldenTrayEditBegin: () => ({ orderEditBegin: ok({ calculatedOrder: { id: 'co', lineItems: { nodes: [{ id: 'a', sku: 'GT-TRAY', quantity: 0 }] } } }) }),
  }));
  assert.equal((await new ShopifyOps(client).addFreeTray(trayArgs())).alreadyPresent, false);
});

for (const [step, operation, root] of [
  ['begin', 'GoldenTrayEditBegin', 'orderEditBegin'],
  ['add_variant', 'GoldenTrayEditAddVariant', 'orderEditAddVariant'],
  ['discount', 'GoldenTrayEditAddDiscount', 'orderEditAddLineItemDiscount'],
  ['commit', 'GoldenTrayEditCommit', 'orderEditCommit'],
]) {
  test(`addFreeTray: user error at ${step} stops there and is not retryable`, async () => {
    const client = fakeClient(editHandlers({ [operation]: () => ({ [root]: { userErrors: [{ field: ['x'], message: 'The variant does not exist in the shop.' }] } }) }));
    const result = await new ShopifyOps(client).addFreeTray(trayArgs());
    assert.equal(result.ok, false);
    assert.equal(result.step, step);
    assert.equal(result.retryable, false);
    assert.match(result.error, /does not exist/);
    const ops = client.calls.map((c) => c.operation);
    assert.equal(ops.at(-1), operation);
    if (step !== 'commit') assert.ok(!ops.includes('GoldenTrayEditCommit'), 'never commits after a failed step');
  });
}

test('addFreeTray: a network error is reported as retryable with its step', async () => {
  const client = fakeClient(editHandlers({ GoldenTrayEditCommit: () => { throw new ShopifyError('X: network error', { code: 'NETWORK', retryable: true }); } }));
  const result = await new ShopifyOps(client).addFreeTray(trayArgs());
  assert.deepEqual([result.ok, result.step, result.retryable], [false, 'commit', true]);
});

test('getOrder normalises the order, or returns null', async () => {
  const client = fakeClient({
    GoldenTrayGetOrder: (v) => (v.id.endsWith('/5')
      ? { order: { id: 'gid://shopify/Order/5', legacyResourceId: '5', name: '#5', createdAt: '2026-11-06T09:00:00Z', tags: ['Linc Queue'], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', lineItems: { nodes: [] } } }
      : { order: null }),
  });
  const ops = new ShopifyOps(client);
  const order = await ops.getOrder('5');
  assert.equal(order.id, '5');
  assert.equal(order.financialStatus, 'paid');
  assert.equal(client.calls[0].mutation, false);
  assert.equal(await ops.getOrder('6'), null);
});

test('findOrder: long numbers are ids, short ones and #names are searched by name', async () => {
  const client = fakeClient({
    GoldenTrayGetOrder: () => ({ order: { id: 'gid://shopify/Order/13527749558651', legacyResourceId: '13527749558651', name: '#38014', lineItems: { nodes: [] } } }),
    GoldenTrayFindOrder: (v) => ({ orders: { nodes: v.query === 'name:#38014' ? [{ id: 'gid://shopify/Order/1', legacyResourceId: '1', name: '#38014', lineItems: { nodes: [] } }] : [] } }),
  });
  const ops = new ShopifyOps(client);
  assert.equal((await ops.findOrder('13527749558651')).name, '#38014');
  assert.equal((await ops.findOrder('#38014')).id, '1');
  assert.equal((await ops.findOrder('38014')).id, '1');
  assert.equal(await ops.findOrder('#99'), null);
  assert.equal(await ops.findOrder('  '), null);
});

test('addTags uses tagsAdd and throws on user errors', async () => {
  const client = fakeClient({ GoldenTrayTagsAdd: (v) => ({ tagsAdd: v.id.includes('Customer') ? { userErrors: [{ field: ['id'], message: 'not found' }] } : { node: { id: v.id }, userErrors: [] } }) });
  const ops = new ShopifyOps(client);
  await ops.addTags('gid://shopify/Order/5', ['GoldenTrayNov2026']);
  assert.deepEqual(client.calls[0].variables, { id: 'gid://shopify/Order/5', tags: ['GoldenTrayNov2026'] });
  assert.equal(client.calls[0].mutation, true);
  await assert.rejects(ops.addTags('gid://shopify/Customer/7', ['x']), (e) => e instanceof ShopifyError && /not found/.test(e.message));
});

test('recentOrders pages through orders created in a time range', async () => {
  const node = (id) => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), name: `#${id}`, lineItems: { nodes: [] } });
  const client = fakeClient({
    GoldenTrayRecentOrders: (v) => (v.after
      ? { orders: { nodes: [node(3)], pageInfo: { hasNextPage: true, endCursor: 'c2' } } }
      : { orders: { nodes: [node(1), node(2)], pageInfo: { hasNextPage: true, endCursor: 'c1' } } }),
  });
  const orders = await new ShopifyOps(client).recentOrders({ since: '2026-11-06T07:00:00.000Z', until: '2026-11-06T08:00:00.000Z', maxPages: 2 });
  assert.deepEqual(orders.map((o) => o.id), ['1', '2', '3']);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].variables.query, "created_at:>='2026-11-06T07:00:00.000Z' AND created_at:<='2026-11-06T08:00:00.000Z'");
  assert.equal(client.calls[1].variables.after, 'c1');
});

test('getVariant returns sku, price and product status, or null', async () => {
  const client = fakeClient({
    GoldenTrayVariant: (v) => ({ productVariant: v.id.endsWith('/42') ? { id: v.id, sku: 'GT-TRAY', price: '5.00', product: { title: 'Golden Tray', status: 'ACTIVE' } } : null }),
  });
  const ops = new ShopifyOps(client);
  assert.deepEqual(await ops.getVariant('42'), { id: 'gid://shopify/ProductVariant/42', sku: 'GT-TRAY', price: '5.00', productTitle: 'Golden Tray', productStatus: 'ACTIVE' });
  assert.equal(await ops.getVariant('43'), null);
});

test('access scopes, shop and webhooks', async () => {
  const client = fakeClient({
    GoldenTrayScopes: () => ({ currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_order_edits' }] } }),
    GoldenTrayShop: () => ({ shop: { name: 'S', myshopifyDomain: 's.myshopify.com' } }),
    GoldenTrayWebhooks: () => ({ webhookSubscriptions: { nodes: [{ id: 'w1', topic: 'ORDERS_CREATE', uri: 'https://x/webhooks/orders/create' }] } }),
    GoldenTrayWebhookCreate: (v) => ({ webhookSubscriptionCreate: { webhookSubscription: { id: 'w2', uri: v.webhookSubscription.uri }, userErrors: [] } }),
  });
  const ops = new ShopifyOps(client);
  assert.deepEqual(await ops.getAccessScopes(), ['read_orders', 'write_order_edits']);
  assert.equal((await ops.getShop()).myshopifyDomain, 's.myshopify.com');
  assert.deepEqual(await ops.listWebhooks(), [{ id: 'w1', topic: 'ORDERS_CREATE', uri: 'https://x/webhooks/orders/create' }]);
  assert.deepEqual(await ops.createWebhook('https://y/webhooks/orders/create'), { id: 'w2', uri: 'https://y/webhooks/orders/create' });
  const create = client.calls.at(-1);
  assert.deepEqual(create.variables, { topic: 'ORDERS_CREATE', webhookSubscription: { uri: 'https://y/webhooks/orders/create', format: 'JSON' } });
});
